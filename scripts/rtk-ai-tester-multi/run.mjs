import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { labels, paths, cases, systemPrompt, testCommand } from './scenarios.mjs';
import { tokens } from '../rtk-ai-tester-ab/guard.mjs';
import { answerObject } from '../rtk-ai-tester-ab/answer.mjs';
import { gradeFields } from './grade.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const option = (key, fallback) => args.includes(key) ? args[args.indexOf(key) + 1] : fallback;
const read = f => JSON.parse(fs.readFileSync(f, 'utf8'));
const cfg = read(option('--config'));
const root = path.resolve(cfg.root);
const stage = option('--stage', 'matrix');
if (!/^[a-z0-9-]+$/.test(stage)) throw Error('Invalid stage label');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const fileHash = file => hash(fs.readFileSync(file));
const mkdir = relative => { const dir = path.join(root, relative); fs.mkdirSync(dir, { recursive: true }); return dir; };
const write = (file, object) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(object, null, 2) + '\n'); };
const env = { ...process.env, TMP: mkdir('sandboxes'), TEMP: path.join(root, 'sandboxes'),
  PI_CODING_AGENT_DIR: mkdir('pi-config'), PI_TELEMETRY: '0', PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1',
  RTK_TEE: '0', RTK_TELEMETRY_DISABLED: '1', RTK_DB_PATH: path.join(root, 'preflight.db'),
  RTK_TEE_DIR: mkdir('tee'), CLAUDE_CONFIG_DIR: path.join(root, 'absent-claude'),
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: 'NUL', GIT_TERMINAL_PROMPT: '0' };
for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key];
env.PATH = [path.dirname(cfg.python), path.dirname(cfg.rtk), path.dirname(cfg.git), path.dirname(cfg.php), path.dirname(process.execPath), process.env.PATH].join(path.delimiter);
const commandEnv = {};
for (const key of ['SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'PATH', 'TMP', 'TEMP', 'RTK_TEE', 'RTK_TELEMETRY_DISABLED', 'RTK_DB_PATH', 'RTK_TEE_DIR', 'CLAUDE_CONFIG_DIR', 'GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_GLOBAL', 'GIT_TERMINAL_PROMPT']) {
  const actual = Object.keys(env).find(x => x.toLowerCase() === key.toLowerCase());
  if (actual) commandEnv[key] = env[actual];
}
Object.assign(commandEnv, { BENCH_NODE: process.execPath, BENCH_PHP: cfg.php, PYTEST_DISABLE_PLUGIN_AUTOLOAD: '1', PYTHONUTF8: '1', PYTHONDONTWRITEBYTECODE: '1' });
const run = (exe, argv, cwd = root, childEnv = commandEnv, timeout = 90000) => {
  const result = spawnSync(exe, argv, { cwd, env: childEnv, encoding: 'utf8', windowsHide: true, maxBuffer: 24 * 1024 * 1024, timeout });
  if (result.error) throw Error(`Process failed: ${result.error.code}`);
  return result;
};
const checked = (exe, argv, cwd = root, childEnv = commandEnv) => {
  const result = run(exe, argv, cwd, childEnv);
  assert.equal(result.status, 0, `Preflight failed: ${path.basename(exe)} ${argv[0]}`);
  return result.stdout.trim();
};
const git = (argv, cwd, e = commandEnv) => checked(cfg.git, argv, cwd, e);
for (const label of labels) {
  const source = cfg.projects[label];
  const sourceRoot = path.resolve(source.path);
  assert(root !== sourceRoot && !root.startsWith(sourceRoot + path.sep) && !sourceRoot.startsWith(root + path.sep), 'Overlapping roots');
  assert.equal(git(['rev-parse', 'HEAD'], sourceRoot), source.commit, `Source pin changed: ${label}`);
  assert.equal(git(['status', '--porcelain'], sourceRoot), '', `Dirty source: ${label}`);
}
const globalRtk = [path.join(process.env.APPDATA, 'rtk/config.toml'), path.join(process.env.LOCALAPPDATA, 'rtk')];
assert(globalRtk.every(x => !fs.existsSync(x)), 'Global Windows RTK state requires separate isolation');
assert(!fs.existsSync(env.CLAUDE_CONFIG_DIR));
const provider = 'omniroute', model = 'la/ornith-1.5-35b-a3b';
const providerConfig = read(path.join(cfg.piConfig, 'models.json')).providers[provider];
const selected = providerConfig.models.find(x => x.id === model);
const auth = read(path.join(cfg.piConfig, 'auth.json'))[provider];
assert(selected && auth?.type === 'api_key' && auth.key);
env.AB_MODEL_API_KEY = auth.key;
write(path.join(env.PI_CODING_AGENT_DIR, 'models.json'), { providers: { [provider]: { ...providerConfig, apiKey: '$AB_MODEL_API_KEY', models: [selected] } } });
write(path.join(env.PI_CODING_AGENT_DIR, 'settings.json'), { defaultProvider: provider, defaultModel: model, defaultThinkingLevel: 'low', compaction: { enabled: false }, retry: { enabled: false } });

function mutate(dir, relative, before, after) {
  const file = path.join(dir, relative), original = fs.readFileSync(file, 'utf8').replaceAll('\r\n', '\n');
  assert(original.includes(before), 'Seed did not match pinned source');
  fs.writeFileSync(file, original.replace(before, after));
}
function seedProxy(dir) {
  mutate(dir, paths.proxy, 'if resp.status_code >= 500:', 'if False and resp.status_code >= 500:');
  mutate(dir, paths.proxy, 'if resp.status_code in SAFE_CLIENT_ERROR_MESSAGES:', 'if False and resp.status_code in SAFE_CLIENT_ERROR_MESSAGES:');
}
function prepare() {
  for (const label of labels) {
    const source = cfg.projects[label], target = path.join(root, 'snapshots', label);
    if (fs.existsSync(target)) continue;
    fs.mkdirSync(target, { recursive: true });
    const archive = spawnSync(cfg.git, ['archive', '--format=tar', source.commit], { cwd: source.path, env: commandEnv, windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
    assert.equal(archive.status, 0);
    // Credential-bearing names never reach the filesystem snapshot. No original
    // .git metadata, remote URL or working-tree environment file is copied.
    const extracted = spawnSync('tar.exe', ['-xf', '-', '-C', target, '--exclude=.env', '--exclude=.env.*', '--exclude=.gitmodules', '--exclude=auth.json', '--exclude=credentials.json', '--exclude=id_rsa', '--exclude=id_ed25519'], { input: archive.stdout, windowsHide: true });
    assert.equal(extracted.status, 0);
    git(['init', '-q'], target);
    git(['config', 'user.name', 'Fixture'], target);
    git(['config', 'user.email', 'fixture@example.invalid'], target);
    git(['config', 'commit.gpgsign', 'false'], target);
    git(['config', 'core.autocrlf', 'false'], target);
    fs.writeFileSync(path.join(target, 'BENCH_NOTES.md'), Array.from({ length: 64 }, (_, i) => `Migration note ${i}: reviewed baseline behavior.`).join('\n') + '\n');
    git(['add', '-A'], target);
    git(['commit', '-qm', 'Labelled source snapshot'], target, { ...commandEnv, GIT_AUTHOR_DATE: '2026-09-01T12:00:00Z', GIT_COMMITTER_DATE: '2026-09-01T12:00:00Z' });
  }
  for (const c of [{ id: 'gold' }, ...cases]) {
    const dir = path.join(root, 'fixtures', c.id);
    if (fs.existsSync(dir)) continue;
    fs.mkdirSync(dir, { recursive: true });
    for (const label of labels) fs.cpSync(path.join(root, 'snapshots', label), path.join(dir, label), { recursive: true });
    const tests = path.join(dir, 'checks'); fs.mkdirSync(tests);
    fs.copyFileSync(path.join(here, 'checks.py'), path.join(tests, '_support.py'));
    fs.writeFileSync(path.join(tests, 'conftest.py'), `import sys\nfrom pathlib import Path\nimport pytest\nsys.path.insert(0,str(Path(__file__).parent))\nfrom _support import observe\n@pytest.fixture(scope='session')\ndef observations():\n    return observe(Path(__file__).resolve().parents[1])[0]\n`);
    for (const label of labels) {
      fs.mkdirSync(path.join(tests, label));
      fs.writeFileSync(path.join(tests, label, 'test_contract.py'), `import pytest\n@pytest.mark.parametrize('case',['01','02','03','04'])\ndef test_contract(case,observations):\n    row=next(x for x in observations if x['repo']=='${label}' and x['case']==case)\n    assert row['actual']==row['expected'], f"owner=${label} case={case} actual={row['actual']} expected={row['expected']}"\n`);
    }
    if (c.id === 'contract-review' || c.id === 'security-review') {
      for (const label of labels) {
        const file = path.join(dir, label, 'BENCH_NOTES.md');
        fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replaceAll('reviewed baseline', 'reviewed current'));
      }
    }
    if (c.id === 'contract-review') mutate(dir, paths.api, "'status' => $this->status,", "'state' => $this->status,");
    if (c.id === 'security-review') {
      mutate(dir, paths.api, 'return [\n', "return [\n            'log' => $this->log,\n");
      seedProxy(dir);
    }
    if (['multi-diagnostics', 'coordinated-fix'].includes(c.id)) {
      mutate(dir, paths.client, 'export function deploymentStatusVariant(status: string): BadgeVariant {', "export function deploymentStatusVariant(status: string): BadgeVariant {\n  return 'default';");
      for (const value of ['pending', 'running', 'success', 'failed']) mutate(dir, paths.status, `'${value}'`, `'${value}-invalid'`);
      seedProxy(dir);
      if (c.id === 'coordinated-fix') for (const label of labels) {
        git(['add', '-A'], path.join(dir, label));
        git(['commit', '-qm', 'Seeded regression fixture'], path.join(dir, label), { ...commandEnv, GIT_AUTHOR_DATE: '2026-09-02T12:00:00Z', GIT_COMMITTER_DATE: '2026-09-02T12:00:00Z' });
      }
    }
  }
  const golden = run(cfg.python, [path.join(here, 'checks.py'), path.join(root, 'fixtures/gold'), '--observations']);
  assert.equal(golden.status, 0, 'Original-source positive control failed');
  const failing = run(cfg.python, [path.join(here, 'checks.py'), path.join(root, 'fixtures/multi-diagnostics'), '--observations']);
  const observation = JSON.parse(failing.stdout);
  assert.equal(failing.status, 1);
  assert.equal(observation.observations.filter(x => x.actual !== x.expected).length, 12);
  write(path.join(root, 'private-oracle.json'), observation.observations);
  const pytest = run(cfg.python, ['-m', 'pytest', '-q', '--tb=long', '--import-mode=importlib', 'checks'], path.join(root, 'fixtures/multi-diagnostics'));
  assert.equal(pytest.status, 1);
  assert(pytest.stdout.includes('12 failed'), 'Pytest fixture is not fully exercised');
  const pythonVersion = checked(cfg.python, ['--version']);
  const proxyVersion = checked(cfg.rtk, ['proxy', 'python', '--version']);
  assert.equal(pythonVersion, proxyVersion, 'RTK resolves a different Python');
  for (const label of labels) {
    const normal = run(cfg.git, ['-C', label, 'diff'], path.join(root, 'fixtures/contract-review'));
    const wrapped = run(cfg.rtk, ['git', '-C', label, 'diff'], path.join(root, 'fixtures/contract-review'));
    assert.equal(normal.status, 0); assert.equal(wrapped.status, 0);
    assert(wrapped.stdout.length > 0, 'RTK multi-root command produced no output');
  }
  console.log(JSON.stringify({ phase: 'preflight', repositories: labels, positiveControl: true, seededFailures: 12, gitCVerified: true }));
}

function grade(c, stats) {
  const answer = answerObject(stats.finalText || '');
  const visited = new Set(stats.commands.filter(x => x.command.includes(' diff')).map(x => x.owner));
  const checks = { structuredAnswer: !!answer, boundedTools: stats.denied === 0, withinBudget: !stats.limitReached,
    labelOnlyAnswer: !(cfg.forbiddenNames || []).some(x => (stats.finalText || '').toLowerCase().includes(x.toLowerCase())) };
  Object.assign(checks, gradeFields(c.id, answer, c.id === 'multi-diagnostics' ? read(path.join(root, 'private-oracle.json')) : []));
  if (['contract-review', 'security-review'].includes(c.id)) checks.allRepositoriesInspected = labels.every(x => visited.has(x));
  if (c.id === 'multi-diagnostics') {
    checks.executedTests = stats.commands.some(x => x.command === testCommand && x.code === 1);
  }
  if (c.id === 'coordinated-fix') {
    const testCalls = stats.commands.filter(x => x.command === testCommand);
    const hidden = run(cfg.python, [path.join(here, 'checks.py'), stats.sandbox]);
    let hiddenReport; try { hiddenReport = JSON.parse(hidden.stdout); } catch { /* compile/import errors fail below */ }
    const hiddenChecks = hiddenReport?.checks || {};
    Object.assign(checks, { allRepositoriesInspected: labels.every(x => visited.has(x)), beforeAndAfter: testCalls.length >= 2 && testCalls[0].code === 1 && testCalls.at(-1).code === 0,
      hiddenPass: hidden.status === 0 && hiddenReport?.pass === true && Object.keys(hiddenChecks).length === 7, ...hiddenChecks });
  }
  return { pass: Object.values(checks).every(Boolean), checks };
}

function runCase(c, arm, round, smoke) {
  const job = mkdir(`jobs/${stage}-${c.id}-${round}-${arm}`), resultFile = path.join(job, 'result.json');
  assert(!fs.existsSync(resultFile), 'Attempt already exists; choose a new stage');
  const dispatch = {};
  for (const command of c.commands) {
    const parts = tokens(command), exe = parts.shift();
    const entry = { exe: cfg[exe], args: parts, cwd: '.', owner: command.match(/repo-\d+/)?.[0] || 'all', original: command, rtk: false, raw: false };
    dispatch[command] = entry; dispatch[`raw ${command}`] = { ...entry, raw: true };
    const rewritten = run(cfg.rtk, ['rewrite', command]);
    if ([0, 3].includes(rewritten.status) && rewritten.stdout.trim()) {
      const changed = rewritten.stdout.trim(), argv = tokens(changed); assert.equal(argv.shift(), 'rtk');
      dispatch[changed] = { ...entry, exe: cfg.rtk, args: argv, rtk: true };
    }
  }
  const metrics = path.join(job, 'private-metrics.json');
  write(path.join(job, 'case.json'), { commands: c.commands, dispatch, metrics, readPaths: c.readPaths, writePaths: c.writePaths, commandEnv: { ...commandEnv, RTK_DB_PATH: path.join(job, 'rtk.db') } });
  const flags = ['--provider', provider, '--model', model, '--thinking', 'low', '--no-session', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files', '--no-approve', '--no-builtin-tools', '-e', path.join(here, 'extension.ts')];
  if (arm === 'rtk') flags.push('-e', cfg.rtkExtension);
  const quote = value => { assert(!/["%\r\n]/.test(value)); return `"${value}"`; };
  const wrapper = path.join(job, 'pi.cmd');
  fs.writeFileSync(wrapper, '@echo off\r\n' + [process.execPath, path.join(cfg.piPackage, 'dist/bundle/cli.js'), ...flags].map(quote).join(' ') + ' %*\r\n');
  write(path.join(job, '.ai-tester.yaml'), { skills_dir: './skills', runs_dir: './runs', defaults: { runtime: 'acp', agent: 'pi', model: `${provider}/${model}`, reasoning: 'low', acp_turn_timeout_seconds: 300 },
    acp_agents: { pi: { command: process.execPath, args: [cfg.piAcp], env: { PI_ACP_PI_COMMAND: wrapper, AB_CASE_FILE: path.join(job, 'case.json'), RTK_DB_PATH: path.join(job, 'rtk.db') } } } });
  const prompt = smoke ? 'Return {"ready":true}. Do not call tools.' : c.prompt;
  const scenario = { scenario: `${stage}-${c.id}-${round}-${arm}`, system_prompt: systemPrompt, user_prompt: prompt,
    runner: { runtime: 'acp', agent: 'pi', model: `${provider}/${model}`, reasoning: 'low', permission_mode: 'bypassPermissions', acp_turn_timeout_seconds: 300 },
    fixtures: { git_init: false, copy_trees: [{ from: path.join(root, 'fixtures', c.id), to: '.' }] },
    assertions: [{ id: 'answer', type: 'output_contains', pattern: smoke ? 'ready' : c.id === 'contract-review' ? 'compatible' : c.id === 'security-review' ? 'findings' : c.id === 'multi-diagnostics' ? 'failures' : 'fixedRepos' }, { id: 'bounds', type: 'no_path_escape' }] };
  write(path.join(job, 'scenario.yaml'), scenario);
  const started = Date.now();
  const result = run(cfg.aiTester, ['run', '--file', path.join(job, 'scenario.yaml'), '--format', 'json', '--keep-sandbox', '--quiet'], job, env, 360000);
  fs.writeFileSync(path.join(job, 'private-trace.txt'), result.stdout + '\n' + result.stderr);
  const stats = fs.existsSync(metrics) ? read(metrics) : { messages: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, commands: [], rtkCalls: 0, rawCalls: 0, modelErrors: 0 };
  let trace; try { trace = JSON.parse(result.stdout).runs?.[0]; } catch { /* retain failed attempt */ }
  const graded = smoke ? { pass: answerObject(stats.finalText || '')?.ready === true, checks: {} } : stats.sandbox ? grade(c, stats) : { pass: false, checks: { started: false } };
  const { finalText, sandbox, commands, ...counts } = stats;
  const row = { scenario: c.id, arm, repetition: round, stage, processExit: result.status, elapsedMs: Date.now() - started, promptHash: hash(systemPrompt + '\n' + prompt), ...counts, ...graded,
    aiTesterPass: trace?.scoring?.overallPass === true, aiTesterErrors: trace?.errors?.length ?? null };
  row.pass = row.pass && row.aiTesterPass && row.aiTesterErrors === 0 && result.status === 0;
  write(resultFile, row);
  console.log(JSON.stringify({ phase: stage, scenario: c.id, arm, repetition: round, pass: row.pass, tokens: row.totalTokens, rtkCalls: row.rtkCalls, rawCalls: row.rawCalls, elapsedMs: row.elapsedMs, exit: row.processExit }));
  return row;
}

prepare();
if (args.includes('--prepare-only')) process.exit(0);
const chosen = cases.filter(c => !option('--scenarios') || option('--scenarios').split(',').includes(c.id));
const repeats = Number(option('--repeats', '3')), firstRound = Number(option('--round', '1'));
assert(Number.isInteger(repeats) && repeats >= 1 && repeats <= 5);
const rows = [];
for (let round = firstRound; round < firstRound + repeats; round++) for (const [index, c] of chosen.entries()) {
  for (const arm of (round + index) % 2 ? ['baseline', 'rtk'] : ['rtk', 'baseline']) rows.push(runCase(c, arm, round, args.includes('--smoke')));
  write(path.join(root, `${stage}.partial.json`), { rows });
}
const custody = {};
for (const label of labels) {
  const source = cfg.projects[label];
  assert.equal(git(['rev-parse', 'HEAD'], source.path), source.commit);
  assert.equal(git(['status', '--porcelain'], source.path), '');
  custody[label] = { commit: source.commit, originalCleanBeforeAndAfter: true, copiedGitHead: git(['rev-parse', 'HEAD'], path.join(root, 'snapshots', label)) };
}
write(path.join(root, `${stage}.json`), { schema: 1, kind: 'rtk_multirepository_ai_tester_ab', stage, repetitions: repeats, createdAt: new Date().toISOString(), model: { provider, id: model, thinking: 'low' }, sourceCustody: custody,
  provenance: { node: process.version, python: checked(cfg.python, ['--version']), php: checked(cfg.php, ['-r', 'echo PHP_VERSION;']),
    rtk: { version: '0.48.0', binarySha256: fileHash(cfg.rtk), extensionSha256: fileHash(cfg.rtkExtension) },
    aiTester: { version: '1.2.0', binarySha256: fileHash(cfg.aiTester) }, pi: { version: read(path.join(cfg.piPackage, 'package.json')).version, cliSha256: fileHash(path.join(cfg.piPackage, 'dist/bundle/cli.js')) }, piAcp: { version: '0.0.33', bundleSha256: fileHash(cfg.piAcp) },
    harness: Object.fromEntries(['run.mjs', 'extension.ts', 'scenarios.mjs', 'checks.py', 'grade.mjs'].map(f => [f, fileHash(path.join(here, f))])) },
  globalRtkStateAbsentAfter: globalRtk.every(x => !fs.existsSync(x)), rows });
console.log(JSON.stringify({ phase: 'complete', stage, attempts: rows.length, passed: rows.filter(x => x.pass).length, originalsUnchanged: true }));
