#!/usr/bin/env node
// A five-case, instruction-only pilot. It never launches workers or installs tools.
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const BASELINE = 'bc93bda969e6dd30d54db5b9cc36953f5ca15982';
export const SCHEMA = 'aifhub.skill_workflow_eval.v1';
export const CASES = ['explore', 'plan', 'implement', 'fix', 'review'];
const ARMS = ['baseline', 'current'];
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = path.join(ROOT, 'test/fixtures/skill-workflow-eval');
const SCRIPT = fileURLToPath(import.meta.url);
const LIMIT = 4 * 1024 * 1024;
const INJECTIONS = Object.fromEntries(CASES.map(id => [id,
  `injections/core/aif-${id}-${id === 'review' ? 'context-providers' : 'plan-folder'}.md`]));
const HASH = /^[a-f0-9]{64}$/;
const REQUIRED_METRICS = ['missingRequirements', 'unnecessaryChanges', 'unsupportedChecks', 'userInterventions'];
const IDENTITIES = ['runId', 'executionId', 'pairId', 'caseId', 'arm', 'repetition',
  'inputHash', 'instructionHash', 'runtimeSourceHash', 'runtimeHash', 'harnessHash', 'graderHash'];

export function hash(value) {
  return createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value)
    ? value : canonical(value)).digest('hex');
}
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort()
    .map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
function requireThat(value, message) { if (!value) throw new Error(message); }
function safeId(value) {
  requireThat(typeof value === 'string' && /^[a-z0-9][a-z0-9_-]{0,79}$/.test(value), 'unsafe id');
  return value;
}
function safePath(value) {
  requireThat(typeof value === 'string' && value.length < 240 && value.split('/').every(part =>
    /^[\w.-]+$/.test(part) && !['.', '..'].includes(part) && !/[. ]$/.test(part)
    && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)), `unsafe relative path: ${value}`);
  return value;
}
function inside(root, target) {
  const relative = path.relative(root, target);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}
async function regular(file) {
  const info = await lstat(file);
  requireThat(info.isFile() && !info.isSymbolicLink() && info.size <= LIMIT, `not a bounded regular file: ${file}`);
  return readFile(file);
}
async function tree(root, prefix = '', output = {}) {
  const info = await lstat(root);
  requireThat(info.isDirectory() && !info.isSymbolicLink(), 'directory symlink rejected');
  const entries = await readdir(root, { withFileTypes: true });
  requireThat(entries.length <= 500 && prefix.split('/').length <= 20, 'directory exceeds pilot bound');
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = safePath(prefix + entry.name);
    requireThat(!entry.isSymbolicLink(), `symlink rejected: ${relative}`);
    if (entry.isDirectory()) await tree(path.join(root, entry.name), `${relative}/`, output);
    else output[relative] = hash(await regular(path.join(root, entry.name)));
    requireThat(Object.keys(output).length <= 500, 'file count exceeds pilot bound');
  }
  return output;
}
async function json(file) { return JSON.parse((await regular(file)).toString('utf8')); }
async function write(root, relative, content) {
  const target = path.join(root, safePath(relative));
  let directory = root;
  for (const segment of relative.split('/').slice(0, -1)) {
    directory = path.join(directory, segment);
    try { await mkdir(directory); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const info = await lstat(directory);
    requireThat(info.isDirectory() && !info.isSymbolicLink(), 'write directory symlink rejected');
  }
  await writeFile(target, typeof content === 'string' || Buffer.isBuffer(content)
    ? content : `${JSON.stringify(content, null, 2)}\n`, { flag: 'wx' });
}
function git(repo, args) {
  return execFileSync('git', ['-c', `safe.directory=${repo}`, ...args],
    { cwd: repo, maxBuffer: LIMIT, windowsHide: true, timeout: 15_000 });
}

// An explicit non-secret descriptor of the actual worker environment, verified by the parent.
export function validateRuntime(runtime) {
  const fields = ['host', 'hostVersion', 'model', 'effort', 'tools', 'settingsHash'];
  requireThat(runtime && Object.keys(runtime).sort().join() === fields.sort().join(),
    'runtime requires only host, hostVersion, model, effort, tools, settingsHash');
  for (const key of ['host', 'hostVersion', 'model', 'effort']) {
    requireThat(typeof runtime[key] === 'string' && runtime[key].trim().length > 0
      && runtime[key].length <= 160, `runtime.${key} must identify the real runtime`);
  }
  requireThat(Array.isArray(runtime.tools) && runtime.tools.length > 0
    && runtime.tools.every(t => typeof t === 'string' && /^[\w.-]+$/.test(t)), 'runtime.tools invalid');
  requireThat(HASH.test(runtime.settingsHash), 'runtime.settingsHash must be SHA-256 of non-secret settings');
  return runtime;
}

export async function loadCases() {
  const cases = [];
  for (const id of CASES) {
    const input = await json(path.join(FIXTURES, id, 'input.json'));
    const grader = await json(path.join(FIXTURES, id, 'grader.json'));
    requireThat(typeof input.task === 'string' && input.task.length > 0, 'empty task');
    const names = Object.keys(input.files);
    names.forEach(safePath);
    requireThat(new Set(names.map(n => n.toLowerCase())).size === names.length, 'duplicate fixture path');
    requireThat(Object.values(input.files).every(v => typeof v === 'string'), 'fixture bodies must be text');
    grader.allowedChanges.forEach(safePath);
    requireThat(grader.requirements.length > 0 && new Set(grader.requirements.map(r => r.id)).size
      === grader.requirements.length, 'invalid requirement ids');
    cases.push({ id, input, grader });
  }
  return cases;
}

async function snapshot(repo, arm, id) {
  const files = {};
  const pending = [INJECTIONS[id]];
  while (pending.length) {
    const relative = safePath(pending.shift());
    if (Object.hasOwn(files, relative)) continue;
    const content = arm === 'baseline' ? git(repo, ['show', `${BASELINE}:${relative}`])
      : await regular(path.join(repo, relative));
    files[relative] = content.toString('utf8');
    // Follow shared Markdown references only; runtime helpers are fingerprinted, not installed.
    for (const match of files[relative].matchAll(/skills\/shared\/[\w./-]+\.md/g)) pending.push(match[0]);
    for (const match of files[relative].matchAll(/\]\(([^)\s]+\.md)\)/g)) {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(relative), match[1]));
      if (target.startsWith('skills/shared/')) pending.push(target);
    }
    requireThat(Object.keys(files).length <= 100, 'instruction closure exceeds pilot bound');
  }
  return files;
}
async function runtimeSource(repo, arm) {
  const files = {};
  const paths = arm === 'baseline'
    ? git(repo, ['ls-tree', '-r', '--name-only', BASELINE, '--', 'scripts', 'commands']).toString().trim().split('\n')
    : [...Object.keys(await tree(path.join(repo, 'scripts'))).map(p => `scripts/${p}`),
      ...Object.keys(await tree(path.join(repo, 'commands'))).map(p => `commands/${p}`)];
  for (const relative of paths.filter(p => p.endsWith('.mjs') && !p.endsWith('.test.mjs')
    && !p.startsWith('scripts/skill-workflow-eval'))) {
    files[relative] = hash(arm === 'baseline' ? git(repo, ['show', `${BASELINE}:${relative}`])
      : await regular(path.join(repo, relative)));
  }
  return { hash: hash(files), files };
}
function identity(row) { return Object.fromEntries(IDENTITIES.map(key => [key, row[key]])); }

export async function prepare({ materialize = false, taskId, runtime, repetitions = 1, repo = ROOT } = {}) {
  const cases = await loadCases();
  if (!materialize) return { schema: SCHEMA, status: 'NOT_RUN(scenarios_ready_execution_pending)',
    cases: cases.map(c => c.id), baseline: BASELINE, writes: false };
  safeId(taskId);
  validateRuntime(runtime);
  requireThat(Number.isInteger(repetitions) && repetitions >= 1 && repetitions <= 5, 'repetitions must be 1..5');
  repo = await realpath(repo);
  requireThat(git(repo, ['rev-parse', `${BASELINE}^{commit}`]).toString().trim() === BASELINE, 'baseline unavailable');
  const harnessHash = hash(await regular(SCRIPT));
  const hiddenCheck = await regular(path.join(FIXTURES, 'check-output.mjs'));
  const hiddenCheckHash = hash(hiddenCheck);
  const arms = {};
  // Freeze both arms before creating contexts; later worktree edits cannot contaminate a repetition.
  for (const arm of ARMS) {
    const instructions = {};
    for (const item of cases) instructions[item.id] = await snapshot(repo, arm, item.id);
    arms[arm] = { instructions, runtimeSource: await runtimeSource(repo, arm) };
  }
  const temp = await realpath(os.tmpdir());
  requireThat(!inside(repo, temp) && repo !== temp, 'OS temp must be outside the source checkout');
  const runRoot = await mkdtemp(path.join(temp, `aifhub-skill-eval-${taskId}-`));
  const runId = randomUUID();
  const rows = [];
  for (const item of cases) {
    for (let repetition = 1; repetition <= repetitions; repetition++) {
      // Counterbalance launch order across cases and repetitions.
      const order = (CASES.indexOf(item.id) + repetition) % 2 ? ARMS : [...ARMS].reverse();
      for (const arm of order) {
        const executionId = randomUUID();
        const context = `workers/${executionId}`;
        const instructions = arms[arm].instructions[item.id];
        const workerTask = `Read the selected instruction entrypoint at instructions/${INJECTIONS[item.id]} and its provided references. Resolve installed extension references inside instructions/. This is a bounded instruction-only assignment; no extension runtime, upstream skill installation or model client is supplied. Follow the scenario's authorized scope. Do not read outside this context, launch/delegate workers, install tools, access networks or credentials, use the source checkout, or read other runs. Work only in workspace/. Do not edit instructions/, TASK.md or identity.json. Return your final response and an honest list of executed checks with their observed outcomes to the parent; the parent records your report.\n\n${item.input.task}\n`;
        const inputFiles = Object.fromEntries(Object.entries(item.input.files).map(([p, body]) => [p, hash(body)]));
        const row = { runId, executionId, pairId: `${runId}:${item.id}:${repetition}`, caseId: item.id,
          arm, repetition, context, inputHash: hash({ task: workerTask, files: inputFiles }),
          instructionHash: hash(instructions), runtimeSourceHash: arms[arm].runtimeSource.hash,
          runtimeHash: hash(runtime), harnessHash, graderHash: hash({ rubric: item.grader, hiddenCheckHash }), inputFiles,
          instructionFiles: Object.fromEntries(Object.entries(instructions).map(([p, body]) => [p, hash(body)])) };
        await write(runRoot, `${context}/TASK.md`, workerTask);
        // Opaque worker identity intentionally omits arm names, source refs and withheld hashes.
        await write(runRoot, `${context}/identity.json`, { executionId });
        for (const [p, body] of Object.entries(item.input.files)) await write(runRoot, `${context}/workspace/${p}`, body);
        for (const [p, body] of Object.entries(instructions)) await write(runRoot, `${context}/instructions/${p}`, body);
        rows.push(row);
      }
    }
  }
  const manifest = { schema: SCHEMA, runId, taskId, repetitions, baseline: BASELINE, runtime,
    preparedAt: new Date().toISOString(), harnessHash, hiddenCheckHash, node: process.version,
    platform: process.platform, arch: process.arch, rows,
    runtimeSources: Object.fromEntries(ARMS.map(a => [a, arms[a].runtimeSource])),
    graders: Object.fromEntries(cases.map(c => [c.id, c.grader])) };
  await write(runRoot, 'coordinator/manifest.json', manifest);
  await write(runRoot, 'coordinator/check-output.mjs', hiddenCheck);
  await write(runRoot, 'coordinator/OWNER.json', { schema: SCHEMA, runId, taskId, repetitions, matrixHash: hash(rows) });
  return { schema: SCHEMA, status: 'NOT_RUN(scenarios_ready_execution_pending)', runRoot,
    manifest: path.join(runRoot, 'coordinator/manifest.json'), rows: rows.map(r => ({ ...identity(r),
      context: path.join(runRoot, r.context), task: path.join(runRoot, r.context, 'TASK.md') })) };
}

async function openRun(runRoot) {
  const lexical = path.resolve(runRoot);
  const canonicalRoot = await realpath(lexical);
  const temp = await realpath(os.tmpdir());
  requireThat(inside(temp, canonicalRoot) && path.dirname(canonicalRoot) === temp
    && path.basename(canonicalRoot).startsWith('aifhub-skill-eval-'), 'not a task-owned temp root');
  requireThat(!(await lstat(lexical)).isSymbolicLink(), 'run symlink rejected');
  requireThat(!(await lstat(path.join(canonicalRoot, 'coordinator'))).isSymbolicLink(), 'coordinator symlink rejected');
  const owner = await json(path.join(canonicalRoot, 'coordinator/OWNER.json'));
  const manifest = await json(path.join(canonicalRoot, 'coordinator/manifest.json'));
  requireThat(manifest.schema === SCHEMA && owner.runId === manifest.runId
    && owner.taskId === manifest.taskId, 'run ownership mismatch');
  requireThat(owner.repetitions === manifest.repetitions && owner.matrixHash === hash(manifest.rows), 'prepared matrix changed');
  requireThat(matrixErrors(manifest).length === 0, 'incomplete scenario matrix');
  requireThat(manifest.harnessHash === hash(await regular(SCRIPT)), 'harness changed; prepare a fresh run');
  requireThat(manifest.node === process.version && manifest.platform === process.platform && manifest.arch === process.arch,
    'Node/platform changed; prepare a fresh run');
  requireThat(manifest.hiddenCheckHash === hash(await regular(path.join(canonicalRoot, 'coordinator/check-output.mjs'))),
    'hidden checker changed');
  return { runRoot: canonicalRoot, manifest };
}

async function workerContext(runRoot, row) {
  const contextRoot = path.join(runRoot, safePath(row.context));
  requireThat(row.context === `workers/${row.executionId}` && inside(runRoot, contextRoot), 'context identity mismatch');
  for (const directory of [path.join(runRoot, 'workers'), contextRoot]) {
    const info = await lstat(directory);
    requireThat(info.isDirectory() && !info.isSymbolicLink(), 'context directory symlink rejected');
  }
  return contextRoot;
}

function observedMetric(value, name) {
  if (value == null) return null;
  requireThat(Number.isFinite(value.value) && value.value >= 0
    && typeof value.evidence === 'string' && value.evidence.trim(), `${name} requires value and evidence`);
  return value.value;
}
export function score({ row, grader, report, observation = {}, changedFiles }) {
  requireThat(report.executionId === row.executionId, 'report execution identity mismatch');
  requireThat(['completed', 'failed', 'incomplete'].includes(report.status), 'invalid worker status');
  requireThat(typeof report.summary === 'string' && report.summary.trim(), 'report summary required');
  requireThat(report.checks === null || Array.isArray(report.checks), 'checks must be an array or null');
  for (const check of report.checks ?? []) requireThat(typeof check.command === 'string'
    && check.command.trim() && ['passed', 'failed'].includes(check.outcome), 'invalid claimed check');
  const evidence = observation.requirements ?? {};
  requireThat(Object.keys(evidence).every(id => grader.requirements.some(r => r.id === id)), 'unknown requirement');
  const requirements = grader.requirements.map(requirement => {
    const finding = evidence[requirement.id];
    if (!finding || finding.met === null) return { id: requirement.id, met: null, evidence: null };
    requireThat(typeof finding.met === 'boolean' && typeof finding.evidence === 'string'
      && finding.evidence.trim(), 'requirement judgments require cited observable evidence');
    return { id: requirement.id, met: finding.met, evidence: finding.evidence };
  });
  const unsupported = observedMetric(observation.unsupportedChecks, 'unsupportedChecks');
  const interventions = observedMetric(observation.userInterventions, 'userInterventions');
  for (const count of [unsupported, interventions]) requireThat(count === null || Number.isInteger(count), 'counts must be integers');
  const unnecessary = changedFiles.filter(p => !grader.allowedChanges.includes(p));
  const missing = requirements.every(r => r.met !== null) ? requirements.filter(r => !r.met).length : null;
  const pass = missing === null || unsupported === null || interventions === null ? null
    : report.status === 'completed' && missing === 0 && unnecessary.length === 0 && unsupported === 0;
  return { requirements, unnecessaryChanges: unnecessary, metrics: { missingRequirements: missing,
    unnecessaryChanges: unnecessary.length, unsupportedChecks: unsupported, userInterventions: interventions,
    unnecessaryActions: observedMetric(observation.unnecessaryActions, 'unnecessaryActions'),
    elapsedMs: observedMetric(observation.elapsedMs, 'elapsedMs'),
    inputTokens: observedMetric(observation.inputTokens, 'inputTokens'),
    outputTokens: observedMetric(observation.outputTokens, 'outputTokens') }, pass };
}

// The parent supplies the report verbatim and observes behavior independently. No worker self-score.
export async function collect({ runRoot, executionId, report, observation } = {}) {
  const opened = await openRun(runRoot);
  const { manifest } = opened;
  runRoot = opened.runRoot;
  const row = manifest.rows.find(r => r.executionId === executionId);
  requireThat(row, 'unknown execution identity');
  requireThat(observation && observation.observerRole === 'coordinator', 'coordinator observation required');
  for (const key of IDENTITIES) requireThat(observation.identity?.[key] === row[key], `observation ${key} mismatch`);
  requireThat(typeof observation.provenance === 'string' && observation.provenance.trim(), 'Orca dispatch provenance required');
  requireThat(typeof observation.runtimeVerified === 'boolean', 'runtimeVerified required');
  requireThat(typeof observation.inputsVerified === 'boolean', 'inputsVerified required');
  requireThat(hash(validateRuntime(observation.runtime)) === row.runtimeHash, 'observed runtime mismatch');
  const contextRoot = await workerContext(runRoot, row);
  const instructionFiles = await tree(path.join(contextRoot, 'instructions'));
  const actualFiles = await tree(path.join(contextRoot, 'workspace'));
  const changedFiles = [...new Set([...Object.keys(row.inputFiles), ...Object.keys(actualFiles)])]
    .filter(p => row.inputFiles[p] !== actualFiles[p]).sort();
  const grader = manifest.graders[row.caseId];
  requireThat(hash({ rubric: grader, hiddenCheckHash: manifest.hiddenCheckHash }) === row.graderHash, 'grader mismatch');
  const integrity = hash(instructionFiles) === hash(row.instructionFiles)
    && hash({ task: (await regular(path.join(contextRoot, 'TASK.md'))).toString('utf8'), files: row.inputFiles }) === row.inputHash
    && (await json(path.join(contextRoot, 'identity.json'))).executionId === executionId;
  const result = { schema: SCHEMA, ...identity(row), status: report.status,
    valid: integrity && observation.runtimeVerified && observation.inputsVerified,
    integrity, collectedAt: new Date().toISOString(), reportHash: hash(report), observationHash: hash(observation),
    changedFiles, outputHash: hash(actualFiles), ...score({ row, grader, report, observation, changedFiles }) };
  await write(runRoot, `coordinator/results/${executionId}.json`, { result, report, observation });
  return result;
}

function matrixErrors(manifest) {
  const errors = [];
  if (!Number.isInteger(manifest.repetitions) || manifest.repetitions < 1 || manifest.repetitions > 5) return ['invalid prepared repetitions'];
  if (manifest.rows.length !== CASES.length * ARMS.length * manifest.repetitions) errors.push('incomplete scenario matrix');
  for (const caseId of CASES) for (let repetition = 1; repetition <= manifest.repetitions; repetition++) for (const arm of ARMS) {
    const rows = manifest.rows.filter(r => r.caseId === caseId && r.repetition === repetition && r.arm === arm);
    if (rows.length !== 1 || rows[0].runId !== manifest.runId || rows[0].pairId !== `${manifest.runId}:${caseId}:${repetition}`) errors.push('missing or invalid scenario slot');
  }
  return errors;
}

export function compareResults(manifest, results) {
  const errors = matrixErrors(manifest);
  const byId = new Map();
  for (const result of results) {
    const expected = manifest.rows.find(r => r.executionId === result.executionId);
    if (!expected || IDENTITIES.some(k => result[k] !== expected[k])) errors.push('result identity mismatch');
    if (byId.has(result.executionId)) errors.push('duplicate execution result');
    byId.set(result.executionId, result);
  }
  for (const caseId of CASES) for (const arm of ARMS) {
    const sameArm = manifest.rows.filter(r => r.caseId === caseId && r.arm === arm);
    for (const key of ['instructionHash', 'runtimeSourceHash', 'inputHash', 'runtimeHash', 'harnessHash', 'graderHash']) {
      if (new Set(sameArm.map(r => r[key])).size > 1) errors.push(`mixed ${key} across repetitions`);
    }
  }
  if (new Set(manifest.rows.map(r => r.executionId)).size !== manifest.rows.length) errors.push('duplicate manifest identity');
  const pairs = [];
  for (const pairId of new Set(manifest.rows.map(r => r.pairId))) {
    const expected = manifest.rows.filter(r => r.pairId === pairId);
    const baseline = expected.find(r => r.arm === 'baseline');
    const current = expected.find(r => r.arm === 'current');
    const left = byId.get(baseline?.executionId);
    const right = byId.get(current?.executionId);
    const same = baseline && current && ['inputHash', 'runtimeHash', 'harnessHash', 'graderHash', 'repetition', 'caseId']
      .every(k => baseline[k] === current[k]);
    const eligible = expected.length === 2 && same && [left, right].every(r => r?.valid === true
      && r.status === 'completed' && typeof r.pass === 'boolean'
      && REQUIRED_METRICS.every(k => Number.isInteger(r.metrics?.[k]) && r.metrics[k] >= 0));
    pairs.push({ pairId, caseId: baseline?.caseId, repetition: baseline?.repetition,
      status: eligible ? 'comparable' : 'incomplete_or_mismatched',
      delta: eligible ? Object.fromEntries(Object.keys(left.metrics).map(k => [k,
        left.metrics[k] == null || right.metrics[k] == null ? null : right.metrics[k] - left.metrics[k]])) : null,
      baselinePass: eligible ? left.pass : null, currentPass: eligible ? right.pass : null });
  }
  const complete = errors.length === 0 && pairs.length > 0 && pairs.every(p => p.status === 'comparable');
  const measured = pairs.filter(p => p.status === 'comparable');
  return { schema: SCHEMA, status: results.length === 0 ? 'NOT_RUN(scenarios_ready_execution_pending)'
    : complete ? 'MEASURED_PAIRED_PILOT' : 'INCOMPLETE_NO_IMPROVEMENT_CLAIM', errors, pairs,
    completePairs: measured.length, expectedPairs: pairs.length,
    improvement: complete ? { passRateDelta: measured.reduce((n, p) => n + Number(p.currentPass)
      - Number(p.baselinePass), 0) / measured.length,
      meanDelta: Object.fromEntries(Object.keys(measured[0].delta).map(k => [k,
        measured.some(p => p.delta[k] === null) ? null : measured.reduce((n, p) => n + p.delta[k], 0) / measured.length])) } : null };
}

export async function compare({ runRoot } = {}) {
  const opened = await openRun(runRoot);
  const results = [];
  for (const row of opened.manifest.rows) {
    try {
      const receipt = await json(path.join(opened.runRoot, 'coordinator/results', `${row.executionId}.json`));
      requireThat(receipt.result.reportHash === hash(receipt.report)
        && receipt.result.observationHash === hash(receipt.observation), 'receipt evidence changed');
      const contextRoot = await workerContext(opened.runRoot, row);
      const actual = await tree(path.join(contextRoot, 'workspace'));
      requireThat(hash(actual) === receipt.result.outputHash, 'workspace changed after collection');
      requireThat(hash(await tree(path.join(contextRoot, 'instructions'))) === hash(row.instructionFiles),
        'instructions changed after collection');
      requireThat(hash({ task: (await regular(path.join(contextRoot, 'TASK.md'))).toString('utf8'), files: row.inputFiles })
        === row.inputHash, 'task changed after collection');
      requireThat((await json(path.join(contextRoot, 'identity.json'))).executionId === row.executionId,
        'worker identity changed after collection');
      const changedFiles = [...new Set([...Object.keys(row.inputFiles), ...Object.keys(actual)])]
        .filter(p => row.inputFiles[p] !== actual[p]).sort();
      requireThat(hash(changedFiles) === hash(receipt.result.changedFiles), 'stored file diff changed');
      const recomputed = score({ row, grader: opened.manifest.graders[row.caseId], report: receipt.report,
        observation: receipt.observation, changedFiles });
      requireThat(hash(recomputed.metrics) === hash(receipt.result.metrics)
        && recomputed.pass === receipt.result.pass, 'stored score changed');
      results.push(receipt.result);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return compareResults(opened.manifest, results);
}

export async function main(args = process.argv.slice(2)) {
  const [command = 'prepare', ...flags] = args;
  const options = {};
  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i];
    requireThat(['--materialize', '--task-id', '--runtime', '--repetitions', '--run', '--execution', '--report', '--observation'].includes(flag), `unknown flag ${flag}`);
    requireThat(!Object.hasOwn(options, flag), `duplicate flag ${flag}`);
    options[flag] = flag === '--materialize' ? true : flags[++i];
    requireThat(options[flag] !== undefined, `missing value for ${flag}`);
  }
  if (command === 'prepare') return prepare({ materialize: options['--materialize'], taskId: options['--task-id'],
    runtime: options['--runtime'] ? await json(options['--runtime']) : undefined,
    repetitions: options['--repetitions'] ? Number(options['--repetitions']) : 1 });
  if (command === 'collect') return collect({ runRoot: options['--run'], executionId: options['--execution'],
    report: await json(options['--report']), observation: await json(options['--observation']) });
  if (command === 'compare') return compare({ runRoot: options['--run'] });
  throw new Error('usage: node scripts/skill-workflow-eval.mjs prepare|collect|compare (see docs/skill-workflow-evaluation.md)');
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then(result => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
