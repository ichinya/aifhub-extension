import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { link, mkdir, mkdtemp, readFile, realpath, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { detectLekalo, detectLekaloVersion, LEKALO_COMMAND_CONTRACT, normalizeLekaloResult, runLekaloOperation } from './lekalo-provider.mjs';
import { runProviders } from './aifhub-providers.mjs';
import { providerRevision } from './provider-files.mjs';
import { initializeEnabledTools } from './aif-artifact-sync.mjs';
import { fakeLekalo, projectYaml } from '../test/fixtures/validation-providers/fake-lekalo.mjs';
const roots = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function project(marker = true) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'aifhub-lekalo-')));
  roots.push(root);
  await mkdir(path.join(root, '.ai-factory'));
  await writeFile(path.join(root, '.ai-factory/config.yaml'), 'aifhub:\n  tools:\n    openspec: false\n    hlv: false\n    lekalo: true\n');
  if (marker) { await mkdir(path.join(root, 'lekalo')); await writeFile(path.join(root, 'lekalo/project.yaml'), projectYaml); }
  return root;
}
function runner(env = {}, calls = []) {
  return async (exe, args, opts) => {
    assert.equal(exe, 'lekalo'); calls.push({ args, cwd: opts.cwd });
    return fakeLekalo(args, env, opts.cwd);
  };
}
const revision = async () => ({ commit: 'a'.repeat(40), worktree: 'b'.repeat(64) });
test('Lekalo exact product and full manifest negotiation never conflates productVersion', async () => {
  const root = await project(), calls = [];
  assert.equal((await detectLekalo(root, {}, { runProcess: runner({}, calls) })).status, 'pass');
  assert.ok(calls.every(call => call.cwd !== root));
  assert.deepEqual(calls.map(call => call.args), [['--version'], ['provider', 'describe', '--json']]);
  for (const value of ['identity', 'field', 'operation', 'pin']) {
    assert.equal((await detectLekalo(root, {}, { runProcess: runner({ AIF_TEST_LEKALO_MANIFEST: value }) })).reason, 'capability_contract');
  }
  assert.equal((await detectLekalo(root, {}, { runProcess: runner({ AIF_TEST_LEKALO_VERSION: '1.0.0' }) })).reason, 'tool_version');
  assert.equal((await detectLekalo(root, {}, { runProcess: runner({ AIF_TEST_LEKALO_VERSION_SHAPE: '1.1.0' }) })).reason, 'version_shape');
  assert.equal((await detectLekalo(await project(false), {}, { runProcess: () => assert.fail('spawn') })).reason, 'layout_missing');
  assert.equal((await detectLekaloVersion(root, { executable: 'wrapper.cmd' }, { runProcess: () => assert.fail('spawn') })).status, 'configuration_error');
  const source = JSON.parse(await readFile(new URL('../aifhub-extension.json', import.meta.url), 'utf8')).sources.lekalo;
  assert.equal(LEKALO_COMMAND_CONTRACT.source, source.url); assert.equal(LEKALO_COMMAND_CONTRACT.toolVersion, source.version);
});
for (const operation of ['status', 'doctor', 'readiness']) test('Lekalo '+operation+' normalizes ready/degraded/blocked at exit zero', async () => {
  const root = await project();
  for (const [verdict, status] of [['ready', 'pass'], ['degraded', 'warn'], ['blocked', 'fail']]) {
    const result = await runLekaloOperation(operation, root, {}, { runProcess: runner({ AIF_TEST_LEKALO_VERDICT: verdict }) });
    assert.equal(result.status, status, JSON.stringify(result)); assert.equal(result.streams.exitCode, 0);
    const additive = await runLekaloOperation(operation, root, {}, { runProcess: runner({ AIF_TEST_LEKALO_VERDICT: verdict, AIF_TEST_LEKALO_ADDITIVE: '1' }) });
    assert.deepEqual(result, additive);
  }
});
test('Lekalo validates three receipt forms, preserving severity and ignoring additive private text', async () => {
  const root = await project();
  for (const severity of [undefined, 'warning', 'info', 'error']) {
    const calls = [], env = { AIF_TEST_LEKALO_RECEIPT: severity };
    const clean = await runLekaloOperation('validate', root, {}, { runProcess: runner(env, calls) });
    const additive = await runLekaloOperation('validate', root, {}, { runProcess: runner({ ...env, AIF_TEST_LEKALO_ADDITIVE: '1' }) });
    assert.deepEqual(clean, additive); assert.equal(clean.status, severity ? 'warn' : 'pass');
    assert.deepEqual(calls[0].args, ['validate', '--no-cache', '--project', root]);
    if (severity) assert.deepEqual(clean.diagnostics, [{ code: 'LEK-SEM-001', severity, id: 'semantic.fixture', category: 'semantic' }]);
    assert.doesNotMatch(JSON.stringify(clean), /fixture-secret|private|token=/);
  }
});
test('Lekalo classifies streams, exits, malformed JSON and explicit overflow', async () => {
  const root = await project();
  for (const [exit, status] of [[1, 'fail'], [3, 'fail'], [4, 'unavailable'], [5, 'unsupported'], [2, 'infrastructure_error']]) {
    const result = await runLekaloOperation('validate', root, {}, { runProcess: runner({ AIF_TEST_LEKALO_EXIT: String(exit) }) });
    assert.equal(result.status, status, JSON.stringify(result)); assert.equal(result.streams.exitCode, exit);
    assert.doesNotMatch(JSON.stringify(result), /fixture-secret|private/);
  }
  assert.equal((await runLekaloOperation('validate', root, {}, { runProcess: runner({ AIF_TEST_LEKALO_SHAPE: 'invalid' }) })).status, 'infrastructure_error');
  assert.equal((await runLekaloOperation('validate', root, { maxOutputBytes: 1024 }, { runProcess: runner({ AIF_TEST_LEKALO_OVERFLOW: '1' }) })).reason, 'output_overflow');
  for (const operation of ['generate', 'sync', 'drift', 'install prompt', 'trace collect', 'verify', 'native']) {
    assert.equal((await runLekaloOperation(operation, root, {}, { runProcess: () => assert.fail('spawn') })).reason, 'operation_unavailable');
  }
});
test('Lekalo semantic impact/context keep sha256 refs and explicit incomplete budget data', async () => {
  const root = await project();
  for (const operation of ['impact', 'context']) {
    const calls = [];
    const result = await runLekaloOperation(operation, root, {}, { runProcess: runner({ AIF_TEST_LEKALO_PARTIAL: '1' }, calls) });
    assert.equal(result.status, 'warn', JSON.stringify(result)); assert.equal(result.semantic.complete, false);
    assert.ok(result.semantic.impact.every(id => /^sha256:[a-f0-9]{64}$/.test(id)));
    assert.doesNotMatch(JSON.stringify(result), /fixture-secret|fixture.account|private/);
    if (operation === 'context') {
      assert.equal(result.semantic.context.complete, false);
      assert.equal(result.semantic.context.fits, false); assert.equal(result.semantic.context.excluded, 1);
      assert.deepEqual(calls.at(-1).args, ['context', '--changed', 'operation:fixture.changed', '--budget', '5000', '--project', root]);
    }
  }
});
test('Lekalo trace enforces AI Factory custody, missing and export overflow', async () => {
  const root = await project();
  assert.equal((await runLekaloOperation('trace', root, {}, { runProcess: () => assert.fail('spawn') })).reason, 'trace_missing');
  assert.equal((await runLekaloOperation('trace', root, {}, { tracePath: 'lekalo/project.yaml', runProcess: () => assert.fail('spawn') })).status, 'unsupported');
  const dir = path.join(root, '.ai-factory/traces/fixture'); await mkdir(dir, { recursive: true });
  const file = path.join(dir, 'lekalo-trace-manifest.json'); await writeFile(file, '{}');
  const options = { changeId: 'fixture', runProcess: runner() };
  const result = await runLekaloOperation('trace', root, {}, options);
  assert.equal(result.status, 'warn'); assert.equal(result.summary.format, 'lekalo-trace-manifest-v0.2.16');
  await truncate(file, 33554433); assert.equal((await runLekaloOperation('trace', root, {}, options)).reason, 'export_overflow');
});
test('Lekalo exit-zero blocked report blocks aggregation with private-text free durable evidence', async () => {
  const rootDir = await project();
  for (const phase of ['status', 'doctor', 'verify', 'done', 'implement']) {
    const result = await runProviders({ rootDir, phase, changeId: 'fixture', revision,
      write: ['verify', 'done', 'implement'].includes(phase), runProcess: runner({ AIF_TEST_LEKALO_VERDICT: 'blocked' }) });
    assert.equal(result.blocking, phase !== 'implement', JSON.stringify(result));
    assert.equal(result.providers[0].commandContract.id, 'aifhub.lekalo-cli');
    assert.doesNotMatch(JSON.stringify(result), /fixture-secret|private/);
  }
});
test('Lekalo init adopt supports dry-run, idempotence and conflict refusal before spawn', async () => {
  const rootDir = await project(false), calls = [], options = { rootDir, runProcess: runner({}, calls) };
  assert.equal((await initializeEnabledTools({ ...options, dryRun: true })).lekalo.state, 'would-create'); assert.deepEqual(calls, []);
  await writeFile(path.join(rootDir, 'AGENTS.md'), 'original instructions');
  const first = await initializeEnabledTools(options); assert.equal(first.ok, true, JSON.stringify(first)); assert.equal(first.lekalo.state, 'created');
  assert.equal((await initializeEnabledTools(options)).lekalo.state, 'preserved'); assert.equal(calls.filter(call => call.args[0] === 'init').length, 1);
  assert.equal(await readFile(path.join(rootDir, 'AGENTS.md'), 'utf8'), 'original instructions');
  const conflict = await project(false); await mkdir(path.join(conflict, 'lekalo')); await writeFile(path.join(conflict, 'lekalo/retained.yaml'), 'original');
  assert.equal((await initializeEnabledTools({ rootDir: conflict, runProcess: () => assert.fail('spawn') })).ok, false);
  const refusal = await initializeEnabledTools({ rootDir: await project(false), runProcess: runner({ AIF_TEST_LEKALO_INIT: 'refuse' }) });
  assert.equal(refusal.ok, false); assert.doesNotMatch(JSON.stringify(refusal), /fixture-secret|private/);
});
test('Lekalo rejects malformed known report and receipt fields before PASS', async () => {
  const report = JSON.parse((await fakeLekalo(['status'])).stdout);
  assert.throws(() => normalizeLekaloResult('status', { ...report, checks: [{ id: 'unknown', state: 'ok', required: true }] }, 0));
  assert.throws(() => normalizeLekaloResult('status', { ...report, checks: [{ id: 'project.root', state: 'blocked', required: true }] }, 0));
  const receipt = JSON.parse((await fakeLekalo(['validate', '--no-cache'], { AIF_TEST_LEKALO_RECEIPT: 'error' })).stdout);
  assert.throws(() => normalizeLekaloResult('validate', { ...receipt, validation: { ...receipt.validation, profile: 'strict' } }, 0));
  assert.throws(() => normalizeLekaloResult('validate', { ...receipt, reasonCodes: [] }, 0));
});

test('Lekalo consumes actual report, impact and context goldens from the reviewed upstream tag', async () => {
  const root = await project();
  const golden = async kind => JSON.parse(await readFile(new URL('../test/fixtures/validation-providers/lekalo-'+kind+'-v1.1.0.json', import.meta.url), 'utf8'));
  assert.equal(normalizeLekaloResult('doctor', await golden('doctor'), 0).status, 'warn');
  const impact = await golden('impact'), context = await golden('context');
  const runProcess = async (_, args) => ({ outcome: 'completed', exitCode: 0, stderr: '',
    stdout: JSON.stringify(args[0] === 'impact' ? { status: 'valid', impact } : context) });
  const result = await runLekaloOperation('context', root, {}, { runProcess });
  assert.ok(['pass', 'warn'].includes(result.status), JSON.stringify(result));
  assert.ok(result.semantic.impact.length > 1);
  assert.doesNotMatch(JSON.stringify(result), /planner|Focusing a task|Bulk focus/);
});

test('Lekalo trace rejects linked custody and retains full length LEK subsystem codes', async () => {
  const root = await project(), external = await project();
  await mkdir(path.join(root, '.ai-factory/traces'));
  const options = { runProcess: () => assert.fail('spawn'), tracePath: '.ai-factory/traces/linked/lekalo-trace-manifest.json' };
  await symlink(external, path.join(root, '.ai-factory/traces/linked'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await runLekaloOperation('trace', root, {}, options)).status, 'unsupported');
  await link(path.join(external, 'lekalo/project.yaml'), path.join(root, '.ai-factory/traces/hardlinked.json'));
  assert.equal((await runLekaloOperation('trace', root, {}, { ...options, tracePath: '.ai-factory/traces/hardlinked.json' })).status, 'unsupported');
  const diagnostic = { code: 'LEK-ABCDEFGHIJKL-123', severity: 'error' };
  assert.equal(normalizeLekaloResult('validate', { status: 'invalid', diagnostics: [diagnostic] }, 1).diagnostics[0].code, diagnostic.code);
  assert.throws(() => normalizeLekaloResult('validate', { status: 'invalid', diagnostics: [{ ...diagnostic, code: 'LEK-ABCDEFGHIJKLM-123' }] }, 1));
});

test('Lekalo revision binds ignored lock and trace inputs as well as the canonical model', async () => {
  const root = await project();
  const options = { runProcess: async (_, args) => ({ outcome: 'completed', exitCode: 0, stderr: '',
    stdout: args[0] === 'rev-parse' ? 'a'.repeat(40) : '' }) };
  const before = await providerRevision(root, options);
  await writeFile(path.join(root, 'lekalo.lock'), 'lock');
  const locked = await providerRevision(root, options);
  assert.notEqual(locked.worktree, before.worktree);
  await mkdir(path.join(root, '.ai-factory/traces/fixture'), { recursive: true });
  const trace = path.join(root, '.ai-factory/traces/fixture/lekalo-trace-manifest.json');
  await writeFile(trace, '{}');
  const exported = await providerRevision(root, options);
  assert.notEqual(exported.worktree, locked.worktree);
  await writeFile(trace, '{"changed":true}');
  assert.notEqual((await providerRevision(root, options)).worktree, exported.worktree);
});

test('clean worktree context is a complete empty pass; foreign traces and big valid traces behave', async t => {
  const root = await project();
  // Empty impact roots (clean worktree): context is a complete pass, not unavailable.
  const emptyRunner = { AIF_TEST_LEKALO_IMPACT: 'empty' };
  const context = await runLekaloOperation('context', root, {}, { runProcess: runner(emptyRunner) });
  assert.equal(context.status, 'pass', JSON.stringify(context));
  assert.equal(context.reason, 'semantic_result');
  assert.equal(context.semantic.complete, true);
  const partial = await runLekaloOperation('context', root, {}, { runProcess: runner({ ...emptyRunner, AIF_TEST_LEKALO_PARTIAL: '1' }) });
  assert.equal(partial.status, 'warn', JSON.stringify(partial));
  assert.equal(partial.diagnostics[0].code, 'LEK-SEM-002');
  // A valid trace larger than the default 1 MiB output cap is not an overflow.
  const big = await project();
  const trace = path.join(big, '.ai-factory/traces', 'fixture', 'lekalo-trace-manifest.json');
  await mkdir(path.dirname(trace), { recursive: true });
  await writeFile(trace, JSON.stringify({ padding: 'x'.repeat(2 * 1024 * 1024) }));
  const exported = await runLekaloOperation('trace', big, {}, {
    tracePath: '.ai-factory/traces/fixture/lekalo-trace-manifest.json',
    runProcess: runner({ AIF_TEST_LEKALO_TRACE_BIG: '1' }) });
  assert.notEqual(exported.reason, 'output_overflow');
  assert.notEqual(exported.status, 'infrastructure_error');
  // An explicit tracePath outside this change's custody is refused (outer
  // catch maps trace_custody to unsupported/unsafe_path_or_result_schema).
  const foreign = await runLekaloOperation('trace', root, {}, {
    tracePath: '.ai-factory/traces/other-change/lekalo-trace-manifest.json', changeId: 'fixture',
    runProcess: () => assert.fail('spawn') });
  assert.equal(foreign.status, 'unsupported');
  assert.equal(foreign.reason, 'unsafe_path_or_result_schema');
});
