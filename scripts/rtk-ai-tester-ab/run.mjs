import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cases, systemPrompt } from './scenarios.mjs';
import { tokens } from './guard.mjs';
import { answerObject } from './answer.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const argv = process.argv.slice(2);
const option = (name, fallback) => argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback;
const inputs = JSON.parse(fs.readFileSync(option('--config'), 'utf8'));
const root = path.resolve(inputs.root);
const repeats = Number(option('--repeats', '3'));
if (!Number.isInteger(repeats) || repeats < 1 || repeats > 10) throw Error('invalid repeats');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const hashFile = name => sha(fs.readFileSync(name));
const writeJSON = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n'); };
const readJSON = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const mkdir = relative => { const dir = path.join(root, relative); fs.mkdirSync(dir, { recursive: true }); return dir; };
for (const source of Object.values(inputs.projects)) {
  const a = path.resolve(source.path).toLowerCase(), b = root.toLowerCase();
  if (a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep)) throw Error('overlapping source and temporary roots');
}
if (root.toLowerCase().startsWith(repo.toLowerCase() + path.sep)) throw Error('temporary root inside repository');
mkdir('');
const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: 'NUL',
  GIT_TERMINAL_PROMPT: '0', RTK_TEE: '0', RTK_TELEMETRY_DISABLED: '1',
  CLAUDE_CONFIG_DIR: path.join(root, 'absent-claude'),
  RTK_DB_PATH: path.join(root, 'preflight-rtk.db'), RTK_TEE_DIR: mkdir('tee'),
  TMP: mkdir('sandboxes'), TEMP: path.join(root, 'sandboxes'),
  PI_TELEMETRY: '0', PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1' };
const inheritedPath = process.env.PATH;
for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key];
env.PATH = [path.dirname(inputs.rtk), path.dirname(inputs.git), path.dirname(inputs.go), path.dirname(inputs.php), inheritedPath].join(path.delimiter);
const run = (exe, args, cwd = root, customEnv = env, timeout = 120000) => {
  const result = spawnSync(exe, args, { cwd, env: customEnv, encoding: 'utf8', windowsHide: true, timeout, maxBuffer: 16 * 1024 * 1024 });
  if (result.error) throw Error(`process error: ${result.error.code}`);
  return result;
};
const checked = (exe, args, cwd, customEnv) => {
  const result = run(exe, args, cwd, customEnv);
  if (result.status !== 0) throw Error(`preflight command failed (${path.basename(exe)} ${args[0]}): ${result.stderr.slice(0, 300)}`);
  return result.stdout.trim();
};
const git = (args, cwd, customEnv) => checked(inputs.git, args, cwd, customEnv);
const globalRtk = [path.join(process.env.APPDATA, 'rtk/config.toml'), path.join(process.env.LOCALAPPDATA, 'rtk')];
if (globalRtk.some(x => fs.existsSync(x))) throw Error('Existing Windows RTK global state: use a separate OS account or Linux XDG isolation');
if (fs.existsSync(env.CLAUDE_CONFIG_DIR)) throw Error('Claude isolation sentinel must not exist');

const custody = {};
for (const [name, source] of Object.entries(inputs.projects)) {
  const head = git(['rev-parse', 'HEAD'], source.path);
  if (head !== source.commit || git(['status', '--porcelain'], source.path)) throw Error(`source custody failed: ${name}`);
  const tracked = git(['ls-files'], source.path).split('\n');
  if (tracked.some(x => /(^|\/)(\.env|id_rsa|id_ed25519|auth\.json|credentials(?:\.json)?)$/i.test(x))) throw Error(`potential credentials in tracked source: ${name}`);
  custody[name] = { commit: head, cleanBefore: true };
}

const provider = inputs.provider || 'omniroute';
const model = inputs.model || 'la/ornith-1.5-35b-a3b';
const originalModels = readJSON(path.join(inputs.piConfig, 'models.json'));
const originalAuth = readJSON(path.join(inputs.piConfig, 'auth.json'));
const originalProvider = originalModels.providers[provider];
const selectedModel = originalProvider.models.find(x => x.id === model);
if (!selectedModel || originalAuth[provider]?.type !== 'api_key' || !originalAuth[provider]?.key) throw Error('selected model API-key configuration missing');
env.AB_MODEL_API_KEY = originalAuth[provider].key;
const piConfig = mkdir('pi-config');
writeJSON(path.join(piConfig, 'models.json'), { providers: { [provider]: { ...originalProvider, apiKey: '$AB_MODEL_API_KEY', models: [selectedModel] } } });
writeJSON(path.join(piConfig, 'settings.json'), { defaultProvider: provider, defaultModel: model, defaultThinkingLevel: 'low', compaction: { enabled: false }, retry: { enabled: false } });
env.PI_CODING_AGENT_DIR = piConfig;

const commandEnv = {};
for (const key of ['SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'PATH', 'TMP', 'TEMP', 'GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_GLOBAL', 'GIT_TERMINAL_PROMPT', 'RTK_TEE', 'RTK_TELEMETRY_DISABLED', 'CLAUDE_CONFIG_DIR', 'RTK_TEE_DIR']) {
  const actual = Object.keys(env).find(x => x.toLowerCase() === key.toLowerCase());
  if (actual) commandEnv[key] = env[actual];
}
commandEnv.GOCACHE = mkdir('go-cache');
commandEnv.GOMODCACHE = mkdir('go-mod-cache');
commandEnv.GOPATH = mkdir('go-path');
commandEnv.GOTOOLCHAIN = 'local';
if (inputs.goModuleProxy) {
  commandEnv.GOPROXY = inputs.goModuleProxy;
  commandEnv.GOSUMDB = 'off'; // go.sum in the pinned project still verifies module bytes.
}
commandEnv.RTK_DB_PATH = path.join(root, 'preflight-rtk.db');
const failures = Array.from({ length: 12 }, (_, i) => ({ name: `phase_${String(i + 1).padStart(2, '0')}`, got: 700 + i * 17, want: 900 + i * 13 }));
commandEnv.RTK_AB_DIAGNOSTICS = JSON.stringify(failures);
const history = Array.from({ length: 5 }, (_, i) => ({ subject: `fixture step ${i + 1}: preserve the complete request routing audit subject including trailing identifier ROUTE-${71 + i}`,
  author: `Fixture Maintainer ${i + 1}`, email: `fixture${i + 1}@example.invalid`, date: `2026-08-${21 + i}`, gate: `review-${i + 1}-full-evidence-required` })).reverse();

function prepare() {
  for (const [name, source] of Object.entries(inputs.projects)) {
    const snapshot = path.join(root, 'snapshots', name);
    if (fs.existsSync(snapshot)) continue;
    fs.mkdirSync(snapshot, { recursive: true });
    const archive = path.join(root, `${name}.tar`);
    git(['archive', '--format=tar', `--output=${archive}`, source.commit], source.path);
    checked('tar.exe', ['-xf', archive, '-C', snapshot]);
  }
  for (const c of cases) {
    const target = path.join(root, 'fixtures', c.id);
    if (fs.existsSync(target)) continue;
    fs.cpSync(path.join(root, 'snapshots', c.project), target, { recursive: true });
    git(['init', '-q'], target);
    git(['config', 'user.name', 'RTK fixture'], target);
    git(['config', 'user.email', 'rtk-fixture@example.invalid'], target);
    git(['config', 'commit.gpgsign', 'false'], target);
    git(['config', 'core.autocrlf', 'false'], target);
    if (c.id === 'security-diff') {
      fs.writeFileSync(path.join(target, 'A_BENCH_NOTES.txt'), Array.from({ length: 160 }, (_, i) => `documentation context ${i}: unchanged baseline explanation`).join('\n') + '\n');
    }
    if (c.id === 'failure-diagnostics') {
      fs.writeFileSync(path.join(target, 'go/rtk_diagnostics_test.go'), `package main\nimport("encoding/json";"os";"testing")\nfunc TestRTKDiagnostics(t *testing.T) {\nvar cases []struct{Name string; Got int; Want int}\nif err:=json.Unmarshal([]byte(os.Getenv("RTK_AB_DIAGNOSTICS")), &cases);err!=nil {t.Fatal(err)}\nif len(cases)!=12 {t.Fatal("fixture missing")}\nfor _,c:=range cases {t.Run(c.Name,func(t *testing.T){t.Errorf("observed mismatch: got=%d want=%d",c.Got,c.Want)})}\n}\n`);
    }
    if (c.id === 'price-fix') {
      fs.writeFileSync(path.join(target, 'visible-price-check.php'), `<?php\nrequire __DIR__.'/src/Support/Traits/Makeable.php';\nrequire __DIR__.'/src/Support/ValueObjects/Price.php';\n$cases=[[1,100,'0,01'],[9007199254740993,100,'90 071 992 547 409,93'],[12345,1000,'12,345']];\n$failed=0; foreach($cases as [$n,$p,$want]) {$v=Support\\ValueObjects\\Price::make($n,'RUB',$p);$got=(string)$v;$want.=' '.$v->symbol();if($got!==$want){echo "FAIL n=$n precision=$p got=$got want=$want\\n";$failed++;}else{echo "PASS n=$n precision=$p\\n";}}\nexit($failed?1:0);\n`);
    }
    git(['add', '-A'], target);
    git(['commit', '-qm', 'Pinned source snapshot'], target, { ...env, GIT_AUTHOR_DATE: '2026-08-20T12:00:00Z', GIT_COMMITTER_DATE: '2026-08-20T12:00:00Z' });
    if (c.id === 'security-diff') {
      const file = path.join(target, 'go/encrypt.go');
      const before = fs.readFileSync(file, 'utf8');
      const after = before.replace('plaintext, err := gcm.Open(nil, nonce, ciphertextData, nil)\n\t\tif err != nil {\n\t\t\treturn "", err\n\t\t}', 'plaintext, _ := gcm.Open(nil, nonce, ciphertextData, nil)');
      if (after === before) throw Error('security mutation did not apply');
      fs.writeFileSync(file, after);
      const notes = path.join(target, 'A_BENCH_NOTES.txt');
      fs.writeFileSync(notes, fs.readFileSync(notes, 'utf8').replaceAll('unchanged baseline explanation', 'updated baseline explanation'));
    }
    if (c.id === 'git-history') for (const commit of [...history].reverse()) {
      fs.writeFileSync(path.join(target, 'BENCH_HISTORY.txt'), commit.subject + '\n');
      git(['add', 'BENCH_HISTORY.txt'], target);
      git(['commit', '-qm', `${commit.subject}\n\nControlled fixture history.\n\nGate: ${commit.gate}`], target,
        { ...env, GIT_AUTHOR_NAME: commit.author, GIT_AUTHOR_EMAIL: commit.email, GIT_AUTHOR_DATE: `${commit.date}T12:00:00Z`, GIT_COMMITTER_DATE: `${commit.date}T12:00:00Z` });
    }
  }
  // Dependencies are downloaded once into the experiment's own module cache.
  checked(inputs.go, ['mod', 'download'], path.join(root, 'fixtures/failure-diagnostics/go'), commandEnv);
  const d = run(inputs.go, ['test', '-v', '-run', 'TestRTKDiagnostics', './...'], path.join(root, 'fixtures/failure-diagnostics/go'), commandEnv);
  if (d.status !== 1 || !failures.every(x => d.stdout.includes(`got=${x.got} want=${x.want}`))) throw Error('diagnostics preflight failed');
  const p = run(inputs.php, ['visible-price-check.php'], path.join(root, 'fixtures/price-fix'), commandEnv);
  if (p.status !== 1) throw Error('price fixture must initially fail');
  const directGo = checked(inputs.go, ['version'], root, commandEnv);
  if (checked(inputs.rtk, ['go', 'version'], root, commandEnv) !== directGo) throw Error('RTK and baseline resolve different Go versions');
  console.log(JSON.stringify({ phase: 'preflight', fixtures: cases.length, diagnosticsFailures: failures.length, priceInitiallyFails: true }));
}

function finalObject(text) {
  return answerObject(text);
}

function grade(c, stats) {
  const answer = finalObject(stats.finalText || '');
  const checks = { validJson: !!answer, actualCommand: stats.commandCalls > 0, noDeniedCalls: stats.denied === 0, withinBudget: !stats.limitReached };
  if (c.id === 'security-diff') {
    checks.bug = answer?.verdict === 'unsafe' && answer?.file === 'go/encrypt.go' && answer?.function === 'Decrypt' && /Open|GCM|auth/i.test(answer?.operation || '') && answer?.ignoredError === true;
    checks.impact = answer?.wrongKeyAccepted === true && answer?.tamperedTagAccepted === true;
    checks.repair = /err|error/i.test(answer?.repair || '');
    checks.initialDiff = stats.commands?.[0]?.command === 'git diff';
  } else if (c.id === 'git-history') {
    checks.complete = answer?.complete === true && answer?.commits?.length === 5;
    for (const key of ['subject', 'author', 'email', 'date', 'gate']) checks[key] = history.every((x, i) => answer?.commits?.[i]?.[key] === x[key]);
    checks.initialLog = stats.commands?.[0]?.command === 'git log -5';
  } else if (c.id === 'failure-diagnostics') {
    checks.allFailures = answer?.count === 12 && answer?.exitNonzero === true && answer?.failures?.length === 12 && failures.every((x, i) => ['name', 'got', 'want'].every(k => answer.failures[i][k] === x[k]));
    checks.executedFailingTests = stats.commands?.some(x => x.command.startsWith('go test') && x.code !== 0) || false;
  } else if (c.id === 'price-fix') {
    const hidden = run(inputs.php, [path.join(repo, 'scripts/fixtures/ponytail-pi-ab/cutcode-price-format.php'), stats.sandbox], root, commandEnv);
    checks.hiddenTests = hidden.status === 0;
    checks.claim = answer?.fixed === true && answer?.testsPassed === true;
    checks.beforeAndAfter = stats.commands?.filter(x => x.command === 'php visible-price-check.php').length >= 2 && stats.commands?.some(x => x.command === 'php visible-price-check.php' && x.code === 0);
    checks.diff = stats.commands?.some(x => x.command === 'git diff') || false;
    const modified = git(['diff', '--name-only'], stats.sandbox).split('\n').filter(Boolean);
    checks.scope = modified.length === 1 && modified[0] === 'src/Support/ValueObjects/Price.php';
  }
  return { pass: Object.values(checks).every(Boolean), checks };
}

function runCase(c, arm, repetition, smoke = false) {
  const name = `${smoke ? 'smoke' : argv.includes('--pilot') ? 'pilot' : argv.includes('--retry-pairs') ? 'retry' : 'matrix'}-${c.id}-${repetition}-${arm}`;
  const work = mkdir(`jobs/${name}`);
  if (fs.existsSync(path.join(work, 'result.json'))) throw Error(`run already exists: ${name}`);
  const metrics = path.join(work, 'private-metrics.json');
  const dispatch = {};
  const commands = c.commands;
  for (const command of commands) {
    const parts = tokens(command), executable = parts.shift();
    const cwd = executable === 'go' ? 'go' : '.';
    const normal = { exe: inputs[executable], args: parts, cwd, original: command, rtk: false, raw: false };
    if (!normal.exe) throw Error('unknown fixture executable');
    dispatch[command] = normal;
    dispatch[`raw ${command}`] = { ...normal, raw: true };
    const rewrite = run(inputs.rtk, ['rewrite', command]);
    if ([0, 3].includes(rewrite.status) && rewrite.stdout.trim()) {
      const changed = rewrite.stdout.trim();
      const args = tokens(changed);
      if (args.shift() !== 'rtk') throw Error('unexpected RTK rewrite');
      dispatch[changed] = { exe: inputs.rtk, args, cwd, original: command, rtk: true, raw: false };
    }
  }
  const caseConfig = { commands, dispatch, readPaths: c.readPaths, writePaths: c.writePaths, metrics,
    commandEnv: { ...commandEnv, RTK_DB_PATH: path.join(work, 'rtk.db') } };
  writeJSON(path.join(work, 'case.json'), caseConfig);
  const wrapper = path.join(work, 'pi.cmd');
  const flags = ['--provider', provider, '--model', model, '--thinking', 'low', '--no-session', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files', '--no-approve', '--no-builtin-tools', '-e', path.join(here, 'extension.ts')];
  if (arm === 'rtk') flags.push('-e', inputs.rtkExtension);
  const quote = x => { if (/["%\r\n]/.test(x)) throw Error('unsafe wrapper argument'); return `"${x}"`; };
  fs.writeFileSync(wrapper, `@echo off\r\n${[process.execPath, path.join(inputs.piPackage, 'dist/bundle/cli.js'), ...flags].map(quote).join(' ')} %*\r\n`);
  writeJSON(path.join(work, '.ai-tester.yaml'), { skills_dir: './skills', runs_dir: './runs', defaults: { runtime: 'acp', agent: 'pi', model: `${provider}/${model}`, reasoning: 'low', acp_turn_timeout_seconds: 300 }, acp_agents: { pi: { command: process.execPath, args: [inputs.piAcp], env: { PI_ACP_PI_COMMAND: wrapper, AB_CASE_FILE: path.join(work, 'case.json'), RTK_DB_PATH: path.join(work, 'rtk.db') } } } });
  const scenario = { scenario: name, system_prompt: systemPrompt, user_prompt: smoke ? 'Respond with the JSON object {"ready":true}. Do not call any tools.' : c.prompt,
    runner: { runtime: 'acp', agent: 'pi', model: `${provider}/${model}`, reasoning: 'low', permission_mode: 'bypassPermissions', acp_turn_timeout_seconds: 300 },
    fixtures: { git_init: false, copy_trees: [{ from: path.join(root, 'fixtures', c.id), to: '.' }] },
    assertions: [{ id: 'json-answer', type: 'output_contains', pattern: smoke ? 'ready' : c.id === 'security-diff' ? 'verdict' : c.id === 'git-history' ? 'commits' : c.id === 'failure-diagnostics' ? 'failures' : 'fixed' }, { id: 'bounded', type: 'no_path_escape' }] };
  writeJSON(path.join(work, 'scenario.yaml'), scenario);
  const started = Date.now();
  const result = run(inputs.aiTester, ['run', '--file', path.join(work, 'scenario.yaml'), '--format', 'json', '--keep-sandbox', '--quiet'], work, env, 360000);
  // Raw output stays in temporary storage, never in the published result.
  fs.writeFileSync(path.join(work, 'private-run-output.txt'), result.stdout + '\n' + result.stderr);
  const stats = fs.existsSync(metrics) ? readJSON(metrics) : {};
  let trace;
  try { trace = JSON.parse(result.stdout).runs?.[0]; } catch { /* Recorded as an invalid run below. */ }
  const graded = smoke ? { pass: finalObject(stats.finalText || '')?.ready === true, checks: {} } : stats.sandbox ? grade(c, stats) : { pass: false, checks: { runtimeStarted: false } };
  const { finalText, sandbox, commands: commandRecords, ...counts } = stats;
  const row = { scenario: c.id, arm, repetition, processExit: result.status, elapsedMs: Date.now() - started,
    promptHash: sha(systemPrompt + '\n' + scenario.user_prompt), ...counts, ...graded,
    aiTesterPass: trace?.scoring?.overallPass === true, aiTesterErrors: trace?.errors?.length ?? null,
    jsonOnly: (() => { try { JSON.parse(stats.finalText); return true; } catch { return false; } })() };
  row.pass = row.pass && result.status === 0 && row.aiTesterPass && row.aiTesterErrors === 0;
  writeJSON(path.join(work, 'result.json'), row);
  console.log(JSON.stringify({ phase: smoke ? 'smoke' : 'run', scenario: c.id, arm, repetition, pass: row.pass, processExit: row.processExit, input: row.input, output: row.output, rtkCalls: row.rtkCalls, rawCalls: row.rawCalls, elapsedMs: row.elapsedMs }));
  return row;
}

prepare();
if (argv.includes('--prepare-only')) process.exit(0);
if (argv.includes('--smoke')) {
  const rows = ['baseline', 'rtk'].map(arm => runCase(cases[0], arm, Number(option('--attempt', '1')), true));
  process.exit(rows.every(x => x.pass && x.messages > 0) ? 0 : 1);
}
if (argv.includes('--pilot')) {
  for (const c of [cases[0], cases[2]]) for (const arm of ['baseline', 'rtk']) runCase(c, arm, Number(option('--attempt', '1')));
  process.exit(0);
}
if (argv.includes('--retry-pairs')) {
  // Supplementary whole-pair repeats. Preserve every original row and reason
  // for repeating; never overwrite unsuccessful attempts or select by quality.
  const rows = [];
  for (const c of cases.filter(c => option('--retry-pairs').split(',').includes(c.id)))
    for (const arm of ['baseline', 'rtk']) rows.push(runCase(c, arm, Number(option('--attempt', '3'))));
  writeJSON(path.join(root, 'retry-aggregate.json'), { reason: 'whole pairs repeated after incomplete responses / ACP startup failures',
    controllerSha256: hashFile(path.join(here, 'run.mjs')), rows });
  process.exit(0);
}
const rows = [];
for (let repetition = 1; repetition <= repeats; repetition++) for (const [index, c] of cases.entries()) {
  const order = (repetition + index) % 2 ? ['baseline', 'rtk'] : ['rtk', 'baseline'];
  for (const arm of order) rows.push(runCase(c, arm, repetition));
  writeJSON(path.join(root, 'aggregate.partial.json'), { rows });
}
for (const [name, source] of Object.entries(inputs.projects)) {
  custody[name].cleanAfter = git(['status', '--porcelain'], source.path) === '';
  custody[name].sameCommitAfter = git(['rev-parse', 'HEAD'], source.path) === source.commit;
  if (!custody[name].cleanAfter || !custody[name].sameCommitAfter) throw Error('original source changed during experiment');
}
const result = { schema: 1, kind: 'bounded_ai_tester_pi_rtk_ab', createdAt: new Date().toISOString(),
  repetitions: repeats, model: { provider, id: model, requestedAlias: 'omni/la/ornith-1.5-35b-a3b', thinking: 'low' },
  provenance: { aiTester: { version: '1.2.0', commit: 'e97faf515103c03f0fffcdb3311fd7ad235a4982', binarySha256: hashFile(inputs.aiTester) },
    rtk: { version: '0.48.0', commit: 'fde0a8f185945556f51718de0f4c430bb62b3df6', binarySha256: hashFile(inputs.rtk), extensionSha256: hashFile(inputs.rtkExtension) },
    pi: { version: readJSON(path.join(inputs.piPackage, 'package.json')).version, cliSha256: hashFile(path.join(inputs.piPackage, 'dist/bundle/cli.js')) },
    piAcp: { version: '0.0.33', bundleSha256: hashFile(inputs.piAcp) }, node: process.version,
    go: checked(inputs.go, ['version'], root, commandEnv), php: checked(inputs.php, ['-r', 'echo PHP_VERSION;'], root, commandEnv),
    harness: Object.fromEntries(['run.mjs', 'guard.mjs', 'extension.ts', 'scenarios.mjs', 'answer.mjs'].map(x => [x, hashFile(path.join(here, x))])) },
  sourceCustody: custody, globalRtkStateAbsentAfter: globalRtk.every(x => !fs.existsSync(x)), rows };
writeJSON(path.join(root, 'aggregate.json'), result);
console.log(JSON.stringify({ phase: 'complete', runs: rows.length, passed: rows.filter(x => x.pass).length, sourceCustodyPreserved: true }));
