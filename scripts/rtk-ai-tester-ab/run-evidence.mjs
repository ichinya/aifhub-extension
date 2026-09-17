// Cross-project ai-tester runner for the evidence & privacy matrix
// (scenarios-evidence.mjs, issue #138). Runs every scenario in every labelled
// project copy, both arms (baseline / rtk), through the same ai-tester + ACP +
// Pi runtime as run.mjs. The label->path map lives only in the private config;
// reports use labels plus role/commit metadata.
//
// Required config fields: root, aiTester, piAcp, piPackage, piConfig, git,
// php, cat, pytest, rtk, rtkExtension, projects{label:{path,commit,role?}}.
// Optional: provider (default omniroute), model (default la/ornith-1.5-35b-a3b).
//
// Usage:
//   node scripts/rtk-ai-tester-ab/run-evidence.mjs --config <inputs.json> --prepare-only
//   node ... --stage smoke
//   node ... --stage pilot
//   node ... --stage matrix [--repeats 1] [--projects cross-01,cross-02] [--scenarios gate-artifact-fidelity]
// Existing runs are never overwritten; repeated invocations skip them and keep
// aggregate.partial.json complete.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cases, systemPrompt, buildFixture, gradeEvidence, privacyPostCheck, SENSITIVE, PYTEST_FAILURES,
  EXPLORE_CANDIDATES, selectExploreTerms, buildExploreCase, normalizeRgPath } from './scenarios-evidence.mjs';
import { tokens } from './guard.mjs';
import { answerObject } from './answer.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const argv = process.argv.slice(2);
const option = (name, fallback) => argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback;
const has = name => argv.includes(name);
const stage = has('--prepare-only') ? 'prepare' : option('--stage', 'matrix');
const turnTimeout = Number(option('--turn-timeout', 300));
if (!Number.isInteger(turnTimeout) || turnTimeout < 60 || turnTimeout > 1800) throw Error('invalid turn timeout');
const inputs = JSON.parse(fs.readFileSync(option('--config'), 'utf8'));
const root = path.resolve(inputs.root);
const repeats = Number(option('--repeats', '1'));
if (!Number.isInteger(repeats) || repeats < 1 || repeats > 5) throw Error('invalid repeats');
const selectedProjects = option('--projects', '').split(',').filter(Boolean);
const selectedScenarios = option('--scenarios', '').split(',').filter(Boolean);
const provider = inputs.provider || 'omniroute';
const model = inputs.model || 'la/ornith-1.5-35b-a3b';
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const writeJSON = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n'); };
const readJSON = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const mkdir = relative => { const dir = path.join(root, relative); fs.mkdirSync(dir, { recursive: true }); return dir; };
const projects = Object.entries(inputs.projects)
  .filter(([label]) => selectedProjects.length === 0 || selectedProjects.includes(label))
  .map(([label, meta]) => ({ label, ...meta }));
const scenarios = cases.filter(c => selectedScenarios.length === 0 || selectedScenarios.includes(c.id))
  .map(c => c); // explore is materialized per project below
if (projects.length === 0 || scenarios.length === 0) throw Error('project/scenario selection is empty');
for (const p of projects) if (!p.commit || !/^[0-9a-f]{40}$/.test(p.commit)) throw Error(`missing pinned commit for ${p.label}`);
{
  const a = path.resolve(root).toLowerCase(), b = repo.toLowerCase();
  if (a.startsWith(b + path.sep) || b.startsWith(a + path.sep)) throw Error('temporary root inside repository');
}
for (const source of projects) {
  const a = path.resolve(source.path).toLowerCase(), b = root.toLowerCase();
  if (a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep)) throw Error('overlapping source and temporary roots');
}
mkdir('');
const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: 'NUL',
  GIT_TERMINAL_PROMPT: '0', RTK_TEE: '0', RTK_TELEMETRY_DISABLED: '1',
  CLAUDE_CONFIG_DIR: path.join(root, 'absent-claude'),
  RTK_DB_PATH: path.join(root, 'preflight-rtk.db'), RTK_TEE_DIR: mkdir('tee'),
  TMP: mkdir('sandboxes'), TEMP: path.join(root, 'sandboxes'),
  PI_TELEMETRY: '0', PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1' };
const inheritedPath = process.env.PATH;
for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key];
env.PATH = [path.dirname(inputs.rtk), path.dirname(inputs.git), path.dirname(inputs.php),
  path.dirname(inputs.cat), path.dirname(inputs.pytest), path.dirname(inputs.rg), inheritedPath].join(path.delimiter);
const run = (exe, args, cwd = root, customEnv = env, timeout = 180000) => {
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
if (run(inputs.rtk, ['--version']).status !== 0) throw Error('rtk executable not runnable');

// Model configuration: copy the selected provider/model from the user's Pi
// config; the API key moves through the environment, never into files on disk
// beyond the generated per-run config (which references the variable).
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

// Command environment for fixture processes (no model credentials inside).
const commandEnv = {};
for (const key of ['SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'PATH', 'TMP', 'TEMP', 'GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_GLOBAL', 'GIT_TERMINAL_PROMPT', 'RTK_TEE', 'RTK_TELEMETRY_DISABLED', 'CLAUDE_CONFIG_DIR', 'RTK_TEE_DIR']) {
  const actual = Object.keys(env).find(x => x.toLowerCase() === key.toLowerCase());
  if (actual) commandEnv[key] = env[actual];
}
commandEnv.RTK_DB_PATH = path.join(root, 'preflight-rtk.db');
commandEnv.RTK_AB_PYTEST = JSON.stringify(PYTEST_FAILURES);

// Explore ground truth: computed from the pinned fixture copy by the same rg
// binary the scenario uses. Stored under <root>/expected/, never in the sandbox.
const rgCount = (args, target) => {
  const r = run(inputs.rg, args, target, commandEnv, 120000);
  if (r.status !== 0 && r.status !== 1) throw Error(`rg ground-truth probe failed (${args.join(' ')}): ${r.stderr.slice(0, 200)}`);
  return r;
};
function computeExploreExpected(target) {
  const counts = {};
  for (const term of EXPLORE_CANDIDATES) {
    const probe = rgCount(['-c', term, '.'], target);
    if (probe.status !== 0) continue;
    counts[term] = probe.stdout.trim().split('\n')
      .reduce((s, l) => s + Number(l.split(':').pop() || 0), 0);
  }
  const sel = selectExploreTerms(counts);
  const perFile = rgCount(['-c', sel.common, '.'], target).stdout.trim().split('\n').filter(Boolean).map(l => {
    const i = l.lastIndexOf(':'); return { file: normalizeRgPath(l.slice(0, i)), count: Number(l.slice(i + 1)) };
  }).sort((a, b) => b.count - a.count || a.file.localeCompare(b.file));
  const matches = rgCount(['-n', sel.rare, '.'], target).stdout.trim().split('\n').filter(Boolean).map(l => {
    const norm = normalizeRgPath(l);
    const a = norm.indexOf(':'), b = norm.indexOf(':', a + 1);
    return { file: norm.slice(0, a), line: Number(norm.slice(a + 1, b)) };
  }).sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  return { ...sel, topFiles: perFile.slice(0, 3), rareMatches: matches };
}

// Source custody: pin exact commits, allow dirty working trees (recorded, never
// touched), exclude credential-named tracked files from copies, verify nothing changes.
const CREDENTIAL_NAME = /(^|\/)(\.env|id_rsa|id_ed25519|auth\.json|credentials(?:\.json)?)$/i;
const custody = {};
for (const source of projects) {
  const head = git(['rev-parse', 'HEAD'], source.path);
  if (head !== source.commit) throw Error(`HEAD moved for ${source.label}: expected ${source.commit}, got ${head}`);
  const porcelain = git(['status', '--porcelain'], source.path);
  const tracked = git(['ls-files'], source.path).split('\n');
  // Tracked credential-named files are recorded here and excluded from every
  // copy in buildProjectFixtures (multirepo-harness protocol), not silently
  // shipped to the model.
  const credentialNamed = tracked.filter(x => CREDENTIAL_NAME.test(x));
  custody[source.label] = { commit: head, dirtyFilesBefore: porcelain ? porcelain.split('\n').filter(Boolean).length : 0,
    porcelainDigestBefore: sha(porcelain), trackedCredentialNamedFiles: credentialNamed };
}

function buildProjectFixtures(source) {
  const snapshot = path.join(root, 'snapshots', source.label);
  if (!fs.existsSync(snapshot)) {
    fs.mkdirSync(snapshot, { recursive: true });
    const archive = path.join(root, `${source.label}.tar`);
    git(['archive', '--format=tar', `--output=${archive}`, source.commit], source.path);
    // Windows bsdtar by absolute path: Git's GNU tar (shadowing it on PATH via
    // dirname(cat)) treats 'D:' as a remote host.
    checked(path.join(process.env.WINDIR || 'C:/Windows', 'System32/tar.exe'), ['-xf', archive, '-C', snapshot]);
    // Protocol (mirrors the multirepo harness): tracked credential-named files
    // are excluded from copies, whatever their contents.
    const tracked = git(['ls-files'], source.path).split('\n').filter(Boolean);
    custody[source.label].excludedCredentialNamedFiles = tracked.filter(x => CREDENTIAL_NAME.test(x));
    if (JSON.stringify(custody[source.label].excludedCredentialNamedFiles) !== JSON.stringify(custody[source.label].trackedCredentialNamedFiles)) throw Error(`credential-name scan mismatch for ${source.label}`);
    for (const rel of custody[source.label].excludedCredentialNamedFiles) {
      const file = path.join(snapshot, rel);
      if (fs.existsSync(file)) fs.rmSync(file);
    }
  }
  for (const c of scenarios) {
    const target = path.join(root, 'fixtures', source.label, c.id);
    const complete = path.join(root, 'fixtures', source.label, `.${c.id}.complete`);
    if (fs.existsSync(complete)) continue;
    fs.rmSync(target, { recursive: true, force: true });
    fs.cpSync(snapshot, target, { recursive: true });
    git(['init', '-q'], target);
    git(['config', 'user.name', 'RTK fixture'], target);
    git(['config', 'user.email', 'rtk-fixture@example.invalid'], target);
    git(['config', 'commit.gpgsign', 'false'], target);
    git(['config', 'core.autocrlf', 'false'], target);
    git(['add', '-A'], target);
    git(['commit', '-qm', 'Pinned source snapshot'], target, { ...env, GIT_AUTHOR_DATE: '2026-09-10T12:00:00Z', GIT_COMMITTER_DATE: '2026-09-10T12:00:00Z' });
    buildFixture(c, target, { write: (abs, content) => { fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, content); }, git: (args, cwd, customEnv) => git(args, cwd, { ...env, ...customEnv }) });
    if (c.id === 'code-explore-fidelity') {
      // Ground truth from the pinned copy itself; stored outside the sandbox.
      const expected = computeExploreExpected(target);
      writeJSON(path.join(root, 'expected', `explore-${source.label}.json`), expected);
      exploreCases[source.label] = { ...buildExploreCase(expected.common, expected.rare), expected };
      const probe = run(inputs.rg, ['-c', expected.common, '.'], target, commandEnv, 120000);
      if (probe.status !== 0 || !probe.stdout.includes(':')) throw Error(`explore fixture preflight failed for ${source.label}`);
    }
    // Deterministic preflight per fixture (marker marks the fixture complete,
    // so interrupted preparations are rebuilt instead of skipped).
    if (c.id === 'gate-artifact-fidelity') {
      const gate = run(inputs.cat, ['.ai-factory/aif-gate-result.json'], target, commandEnv);
      if (gate.status !== 0 || !gate.stdout.includes('"verdict": "BLOCKED"')) throw Error(`gate fixture preflight failed for ${source.label}`);
    }
    if (c.id === 'pytest-traceback-fidelity') {
      const result = run(inputs.pytest, ['-q', 'tests/test_audit_operands.py'], target, commandEnv, 240000);
      if (result.status !== 1 || !PYTEST_FAILURES.every(x => result.stdout.includes(`got=${x.got} want=${x.want}`))) throw Error(`pytest fixture preflight failed for ${source.label}`);
    }
    if (c.id === 'raw-escape-archaeology') {
      if (git(['rev-list', '--count', 'HEAD'], target) !== '4') throw Error(`escape fixture history preflight failed for ${source.label}`);
      if (!git(['status', '--porcelain'], target)) throw Error(`escape fixture must start dirty for ${source.label}`);
    }
    if (c.id === 'sensitive-command-bypass') {
      const ok = run(inputs.php, ['tool/status.php', `--token=${SENSITIVE.token}`], target, commandEnv);
      if (ok.status !== 0 || !ok.stdout.includes('"service":"auth"')) throw Error(`status fixture preflight failed for ${source.label}`);
      const fail = run(inputs.php, ['tool/status.php', `--token=${SENSITIVE.token}`, '--fail-stdout'], target, commandEnv);
      if (fail.status !== SENSITIVE.failingExit) throw Error(`failing status fixture preflight failed for ${source.label}`);
    }
    fs.writeFileSync(complete, 'ok\n');
  }
}

function gradeCase(c, label, stats, work) {
  const answer = answerObject(stats.finalText || '');
  const privacy = c.id === 'sensitive-command-bypass' && stats.sandbox
    ? (() => {
        const gain = run(inputs.rtk, ['gain'], stats.sandbox, { ...commandEnv, RTK_DB_PATH: path.join(work, 'rtk.db'), RTK_TEE_DIR: path.join(work, 'tee') });
        return privacyPostCheck({ dbPath: path.join(work, 'rtk.db'), teeDir: path.join(work, 'tee'),
          gainOutput: `${gain.stdout}\n${gain.stderr}`, markers: [SENSITIVE.token] });
      })()
    : null;
  const graded = gradeEvidence(c, stats, { answer, privacy, expected: c.expected ?? null });
  return { ...graded, answerObserved: answer ?? null, privacy };
}

function runCase(c, source, arm, repetition, smoke = false) {
  const name = `${smoke ? 'smoke' : stage === 'pilot' ? 'pilot' : 'matrix'}-${source.label}-${c.id}-${repetition}-${arm}`;
  const work = mkdir(`jobs/${name}`);
  const resultFile = path.join(work, 'result.json');
  if (fs.existsSync(resultFile)) {
    const existing = readJSON(resultFile);
    const row = { stage: smoke ? 'smoke' : stage === 'pilot' ? 'pilot' : 'matrix', ...existing };
    console.log(JSON.stringify({ phase: 'skip', scenario: c.id, project: source.label, arm, repetition, pass: row.pass }));
    return row;
  }
  const metrics = path.join(work, 'private-metrics.json');
  const dispatch = {};
  for (const command of c.commands) {
    const parts = tokens(command), executable = parts.shift();
    const exeMap = { git: inputs.git, php: inputs.php, cat: inputs.cat, pytest: inputs.pytest, rtk: inputs.rtk, rg: inputs.rg };
    const normal = { exe: exeMap[executable], args: parts, cwd: '.', original: command, rtk: false, raw: false };
    if (!normal.exe) throw Error(`unknown fixture executable: ${executable}`);
    dispatch[command] = normal;
    dispatch[`raw ${command}`] = { ...normal, raw: true };
    const rewrite = run(inputs.rtk, ['rewrite', command]);
    if ([0, 3].includes(rewrite.status) && rewrite.stdout.trim()) {
      const changed = rewrite.stdout.trim();
      const args = tokens(changed);
      if (args.shift() !== 'rtk') throw Error('unexpected RTK rewrite');
      dispatch[changed] = { exe: inputs.rtk, args, cwd: '.', original: command, rtk: true, raw: false };
    }
  }
  const workTee = mkdir(`jobs/${name}/tee`);
  const caseConfig = { commands: c.commands, dispatch, readPaths: c.readPaths, writePaths: c.writePaths, metrics,
    commandEnv: { ...commandEnv, RTK_DB_PATH: path.join(work, 'rtk.db'), RTK_TEE_DIR: workTee } };
  writeJSON(path.join(work, 'case.json'), caseConfig);
  const wrapper = path.join(work, 'pi.cmd');
  const flags = ['--provider', provider, '--model', model, '--thinking', 'low', '--no-session', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files', '--no-approve', '--no-builtin-tools', '-e', path.join(here, 'extension.ts')];
  if (arm === 'rtk') flags.push('-e', inputs.rtkExtension);
  const quote = x => { if (/["%\r\n]/.test(x)) throw Error('unsafe wrapper argument'); return `"${x}"`; };
  fs.writeFileSync(wrapper, `@echo off\r\n${[process.execPath, path.join(inputs.piPackage, 'dist/bundle/cli.js'), ...flags].map(quote).join(' ')} %*\r\n`);
  writeJSON(path.join(work, '.ai-tester.yaml'), { skills_dir: './skills', runs_dir: './runs', defaults: { runtime: 'acp', agent: 'pi', model: `${provider}/${model}`, reasoning: 'low', acp_turn_timeout_seconds: turnTimeout }, acp_agents: { pi: { command: process.execPath, args: [inputs.piAcp], env: { PI_ACP_PI_COMMAND: wrapper, AB_CASE_FILE: path.join(work, 'case.json'), RTK_DB_PATH: path.join(work, 'rtk.db'), RTK_TEE_DIR: workTee } } } });
  const answerKey = { 'gate-artifact-fidelity': 'verdict', 'pytest-traceback-fidelity': 'failures',
    'raw-escape-archaeology': 'deletedLine', 'sensitive-command-bypass': 'status', 'code-explore-fidelity': 'commonTerm' }[c.id];
  const scenario = { scenario: name, system_prompt: systemPrompt, user_prompt: smoke ? 'Respond with the JSON object {"ready":true}. Do not call any tools.' : c.prompt,
    runner: { runtime: 'acp', agent: 'pi', model: `${provider}/${model}`, reasoning: 'low', permission_mode: 'bypassPermissions', acp_turn_timeout_seconds: turnTimeout },
    fixtures: { git_init: false, copy_trees: [{ from: path.join(root, 'fixtures', source.label, c.id), to: '.' }] },
    assertions: [{ id: 'json-answer', type: 'output_contains', pattern: smoke ? 'ready' : answerKey }, { id: 'bounded', type: 'no_path_escape' }] };
  writeJSON(path.join(work, 'scenario.yaml'), scenario);
  const started = Date.now();
  const result = run(inputs.aiTester, ['run', '--file', path.join(work, 'scenario.yaml'), '--format', 'json', '--keep-sandbox', '--quiet'], work, env, Math.max(600000, (turnTimeout + 300) * 1000));
  // Raw output stays in temporary storage, never in the published result.
  fs.writeFileSync(path.join(work, 'private-run-output.txt'), result.stdout + '\n' + result.stderr);
  const stats = fs.existsSync(metrics) ? readJSON(metrics) : {};
  let trace;
  try { trace = JSON.parse(result.stdout).runs?.[0]; } catch { /* Recorded as an invalid run below. */ }
  const graded = smoke
    ? { pass: answerObject(stats.finalText || '')?.ready === true, checks: {}, observation: {} }
    : stats.sandbox ? gradeCase(c, source.label, stats, work) : { pass: false, checks: { runtimeStarted: false }, observation: {} };
  const { finalText, sandbox, commands: commandRecords, ...counts } = stats;
  const row = { scenario: c.id, project: source.label, arm, repetition, stage: smoke ? 'smoke' : stage === 'pilot' ? 'pilot' : 'matrix',
    processExit: result.status, elapsedMs: Date.now() - started,
    promptHash: sha(systemPrompt + '\n' + scenario.user_prompt), ...counts, ...graded,
    aiTesterPass: trace?.scoring?.overallPass === true, aiTesterErrors: trace?.errors?.length ?? null,
    jsonOnly: (() => { try { JSON.parse(stats.finalText); return true; } catch { return false; } })() };
  row.pass = row.pass === true && result.status === 0 && row.aiTesterPass === true && row.aiTesterErrors === 0;
  writeJSON(resultFile, row);
  console.log(JSON.stringify({ phase: smoke ? 'smoke' : stage, scenario: c.id, project: source.label, arm, repetition, pass: row.pass,
    processExit: row.processExit, input: row.input, output: row.output, rtkCalls: row.rtkCalls, rawCalls: row.rawCalls, elapsedMs: row.elapsedMs }));
  return row;
}

// --- stages -----------------------------------------------------------------
// Fixtures first: the explore ground truth (and therefore its scenario object)
// is derived from the pinned copy of each project.
const exploreCases = {};
for (const source of projects) buildProjectFixtures(source);
// Loads explore ground truth for fixtures that were already complete.
for (const source of projects) {
  if (exploreCases[source.label] || !scenarios.some(c => c.id === 'code-explore-fidelity')) continue;
  const expectedFile = path.join(root, 'expected', `explore-${source.label}.json`);
  if (!fs.existsSync(expectedFile)) throw Error(`explore expected missing for ${source.label} — rerun prepare`);
  const expected = readJSON(expectedFile);
  exploreCases[source.label] = { ...buildExploreCase(expected.common, expected.rare), expected };
}
const scenarioFor = (label, c) => (c.id === 'code-explore-fidelity' ? exploreCases[label] : c);
if (stage === 'prepare') {
  console.log(JSON.stringify({ phase: 'prepared', projects: projects.length, scenarios: scenarios.length,
    explore: Object.fromEntries(projects.map(p => [p.label, exploreCases[p.label]
      ? { common: exploreCases[p.label].expected.common, commonTotal: exploreCases[p.label].expected.commonTotal,
          rare: exploreCases[p.label].expected.rare, rareTotal: exploreCases[p.label].expected.rareTotal } : null])) }));
  process.exit(0);
}

const collectExisting = () => {
  const rows = [];
  const jobs = path.join(root, 'jobs');
  if (!fs.existsSync(jobs)) return rows;
  for (const dir of fs.readdirSync(jobs)) {
    const file = path.join(jobs, dir, 'result.json');
    if (fs.existsSync(file)) rows.push({ stage: dir.startsWith('matrix-') ? 'matrix' : dir.startsWith('pilot-') ? 'pilot' : 'smoke', ...readJSON(file) });
  }
  return rows;
};

if (stage === 'smoke') {
  const rows = ['baseline', 'rtk'].map(arm => runCase(scenarios[0], projects[0], arm, Number(option('--attempt', '1')), true));
  process.exit(rows.every(x => x.pass && x.messages > 0) ? 0 : 1);
}
if (stage === 'pilot') {
  for (const c of [scenarios[0], scenarios[scenarios.length - 1]]) for (const arm of ['baseline', 'rtk']) runCase(scenarioFor(projects[0].label, c), projects[0], arm, Number(option('--attempt', '1')));
  process.exit(0);
}
const rows = collectExisting();
for (let repetition = 1; repetition <= repeats; repetition++) for (const [pi, source] of projects.entries()) for (const [ci, c] of scenarios.entries()) {
  const order = (repetition + pi + ci) % 2 ? ['baseline', 'rtk'] : ['rtk', 'baseline'];
  for (const arm of order) {
    const row = runCase(scenarioFor(source.label, c), source, arm, repetition);
    const index = rows.findIndex(x => x.scenario === row.scenario && x.project === row.project && x.arm === row.arm && x.repetition === row.repetition);
    if (index >= 0) rows[index] = row; else rows.push(row);
  }
  writeJSON(path.join(root, 'aggregate.partial.json'), { rows });
}
for (const source of projects) {
  const head = git(['rev-parse', 'HEAD'], source.path);
  const porcelain = git(['status', '--porcelain'], source.path);
  const entry = custody[source.label];
  entry.sameCommitAfter = head === source.commit;
  entry.porcelainDigestAfter = sha(porcelain);
  entry.untouched = entry.sameCommitAfter && entry.porcelainDigestAfter === entry.porcelainDigestBefore;
  if (!entry.untouched) throw Error(`original source changed during experiment: ${source.label}`);
}
const byArm = {};
for (const arm of ['baseline', 'rtk']) {
  const armRows = rows.filter(x => x.arm === arm && x.stage === 'matrix');
  byArm[arm] = { runs: armRows.length, passed: armRows.filter(x => x.pass).length,
    input: armRows.reduce((s, x) => s + (x.input || 0), 0), output: armRows.reduce((s, x) => s + (x.output || 0), 0),
    totalTokens: armRows.reduce((s, x) => s + (x.totalTokens || 0), 0), elapsedMs: armRows.reduce((s, x) => s + (x.elapsedMs || 0), 0) };
}
const result = { schema: 1, kind: 'cross_project_ai_tester_rtk_evidence_ab', createdAt: new Date().toISOString(),
  repeats: repeats, model: { provider, id: model, thinking: 'low' },
  labels: Object.fromEntries(projects.map(p => [p.label, { role: p.role || '', commit: p.commit }])),
  provenance: { aiTester: { binarySha256: sha(fs.readFileSync(inputs.aiTester)) },
    rtk: { binarySha256: sha(fs.readFileSync(inputs.rtk)), extensionSha256: sha(fs.readFileSync(inputs.rtkExtension)) },
    pi: { version: readJSON(path.join(inputs.piPackage, 'package.json')).version, cliSha256: sha(fs.readFileSync(path.join(inputs.piPackage, 'dist/bundle/cli.js'))) },
    piAcp: { bundleSha256: sha(fs.readFileSync(inputs.piAcp)) }, node: process.version,
    harness: Object.fromEntries(['run-evidence.mjs', 'guard.mjs', 'extension.ts', 'scenarios-evidence.mjs', 'answer.mjs'].map(x => [x, sha(fs.readFileSync(path.join(here, x)))])) },
  sourceCustody: custody, globalRtkStateAbsentAfter: globalRtk.every(x => !fs.existsSync(x)), byArm,
  rows: rows.filter(x => x.stage === 'matrix') };
writeJSON(path.join(root, 'aggregate.json'), result);
console.log(JSON.stringify({ phase: 'complete', runs: rows.length, passed: rows.filter(x => x.pass).length,
  byArm: Object.fromEntries(Object.entries(byArm).map(([k, v]) => [k, { runs: v.runs, passed: v.passed, totalTokens: v.totalTokens }])),
  sourceCustodyPreserved: true }));
