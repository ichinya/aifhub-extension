import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, link, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runProviderProcess } from './provider-process.mjs';
import { providerRevision, readProviderFile } from './provider-files.mjs';
import { normalizeProviderPolicies, parseProviderConfig, providerGate } from './provider-policy.mjs';
import { normalizeHlvResult, runHlvOperation } from './hlv-provider.mjs';
import { negotiateProviderCapabilities, runProviderCommand, runProviders, validateNeutralTrace } from './aifhub-providers.mjs';
import { normalizeSemanticEvidence } from './semantic-provider-contract.mjs';
import { renderConfigForMode } from './aif-artifact-sync.mjs';

const fixtures = fileURLToPath(new URL('../test/fixtures/validation-providers/', import.meta.url));
const roots = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function project(kind = 'openspec-native') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aifhub-providers-'));
  roots.push(root);
  await cp(path.join(fixtures, kind), root, { recursive: true });
  for (const args of [['init', '-q'], ['add', '.'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']]) {
    const result = await runProviderProcess('git', args, { cwd: root, timeoutMs: 10000 });
    assert.equal(result.exitCode, 0, result.stderr);
  }
  return root;
}
function fixtureRunner(env = {}, calls = []) {
  return async (executable, args, options) => {
    calls.push([...args]);
    if (executable !== 'hlv') return runProviderProcess(executable, args, options);
    return runProviderProcess(process.execPath, [path.join(fixtures, 'fake-hlv.mjs'), ...args],
      { ...options, env: { ...process.env, ...env } });
  };
}

test('provider policy composes with both artifact modes and preserves config on switch', async () => {
  const raw = await readFile(path.join(fixtures, 'openspec-native/.ai-factory/config.yaml'), 'utf8');
  const expected = normalizeProviderPolicies(parseProviderConfig(raw));
  assert.equal(expected.hlv.enable, true);
  assert.equal(expected.lekalo.enable, false);
  assert.equal(expected.hlv.policy, 'required');
  for (const mode of ['openspec', 'ai-factory']) {
    assert.deepEqual(normalizeProviderPolicies(parseProviderConfig(renderConfigForMode(raw, mode))), expected);
  }
  for (const enable of [true, false]) {
    for (const policy of ['optional', 'required']) {
      const parsed = parseProviderConfig(`aifhub:\n  providers:\n    hlv:\n      enable: ${enable} # opt-in\n      policy: ${policy}\n      phases: ["verify", "done"]\n`);
      assert.equal(normalizeProviderPolicies(parsed).hlv.enable, enable);
      assert.equal(normalizeProviderPolicies(parsed).hlv.policy, policy);
    }
  }
});

test('malformed or ambiguous config cannot silently turn required providers off', () => {
  for (const raw of [
    'aifhub:\n  providers:\n    hlv:\n      enable: true\n      policy: required\n      policy: optional\n',
    'aifhub:\n  providers:\n    hlv:\n      enable: true\n      enable: false\n',
    'aifhub:\n  providers:\n    hlv:\n      enable: true\naifhub:\n',
    'aifhub: {providers: {hlv: {enable: true}}}',
    'aifhub:\n  providers: &alias\n',
    'aifhub:\n  providers: {}\n    hlv:\n      enable: true\n',
    'aifhub:\n  providers: {}\n"aifhub":\n  providers:\n    hlv:\n      enable: true\n',
    'aifhub:\n  providers:\n    hlv:\n      enable: true\n      policy: typo\n',
    'aifhub:\n  providers:\n    hlv:\n      enable: true\n      policy: off\n',
    'aifhub:\n  providers:\n    hlv:\n      enable: true\n      phases: []\n',
    'aifhub:\n  providers:\n    unknown:\n      enable: true\n'
  ]) assert.throws(() => normalizeProviderPolicies(parseProviderConfig(raw)), raw);
  for (const enable of ['"true"', '"false"', "'false'", 'yes', 'no', '1', '0', 'null', '[]', '']) {
    const raw = `aifhub:\n  providers:\n    hlv:\n      enable: ${enable}\n`;
    assert.throws(() => normalizeProviderPolicies(parseProviderConfig(raw)), raw);
  }
  for (const config of [null, { enable: null }, { enable: 'false' }, { enable: 0 }, { enable: true, policy: null }]) {
    assert.throws(() => normalizeProviderPolicies({ hlv: config }));
  }
});

test('disabled and absent providers skip every phase without discovery, revision checks or QA writes', async () => {
  const rootDir = await project();
  const calls = [];
  const mustNotRun = () => { calls.push('unexpected'); throw new Error('must not execute'); };
  for (const raw of ['aifhub:\n  artifactProtocol: openspec\n',
    'aifhub:\n  providers:\n    hlv:\n      enable: false\n      policy: required\n    lekalo:\n      enable: false\n']) {
    await writeFile(path.join(rootDir, '.ai-factory/config.yaml'), raw);
    for (const phase of ['status', 'doctor', 'implement', 'verify', 'done']) {
      const result = await runProviders({ rootDir, phase, changeId: 'provider-composition',
        write: ['implement', 'verify', 'done'].includes(phase), runProcess: mustNotRun, revision: mustNotRun });
      assert.equal(result.status, 'pass', JSON.stringify(result));
      assert.equal(result.blocking, false);
      assert.deepEqual(result.providers, []);
    }
  }
  assert.deepEqual(calls, []);
  await assert.rejects(stat(path.join(rootDir, '.ai-factory/qa')));
});

test('enable true alone makes an unavailable provider blocking; optional only changes the gate', async () => {
  const rootDir = await project();
  for (const policy of [undefined, 'optional']) {
    await writeFile(path.join(rootDir, '.ai-factory/config.yaml'),
      `aifhub:\n  providers:\n    hlv:\n      enable: true\n${policy ? `      policy: ${policy}\n` : ''}`);
    const calls = [];
    const runProcess = async (...args) => { calls.push(args); return { outcome: 'unavailable', exitCode: null, stdout: '', stderr: '' }; };
    const result = await runProviders({ rootDir, phase: 'doctor', runProcess });
    assert.ok(calls.length > 0);
    assert.equal(result.providers[0].status, 'unavailable');
    assert.equal(result.providers[0].policy, policy ?? 'required');
    assert.equal(result.blocking, policy !== 'optional');
  }
});

for (const kind of ['openspec-native', 'adopt']) test(`${kind}: real process verify evidence enables read-only done readiness`, async () => {
  const rootDir = await project(kind);
  const calls = [];
  const options = { rootDir, changeId: 'provider-composition', runProcess: fixtureRunner({}, calls) };
  const before = await providerRevision(rootDir);
  const missing = await runProviders({ ...options, phase: 'done', readOnly: true });
  assert.equal(missing.blocking, true);
  assert.equal(calls.some((args) => args.includes('check')), false);
  const verified = await runProviders({ ...options, phase: 'verify', write: true });
  assert.equal(verified.status, 'pass', JSON.stringify(verified));
  const evidencePath = path.join(rootDir, '.ai-factory/qa/provider-composition/providers/hlv-verify.json');
  const bytes = await readFile(evidencePath, 'utf8');
  assert.equal(bytes.includes('fixture-secret'), false);
  assert.equal(bytes.includes('private'), false);
  assert.equal(bytes.includes(rootDir), false);
  assert.equal(JSON.parse(bytes).toolVersion, '1.0.0');
  const timestamp = (await stat(evidencePath)).mtimeMs;
  await runProviders({ ...options, phase: 'verify', write: true });
  assert.equal(await readFile(evidencePath, 'utf8'), bytes);
  assert.equal((await stat(evidencePath)).mtimeMs, timestamp);
  calls.length = 0;
  const ready = await runProviders({ ...options, phase: 'done', readOnly: true });
  assert.equal(ready.blocking, false, JSON.stringify(ready));
  assert.equal(calls.some((args) => args.includes('check')), false);
  assert.deepEqual(await providerRevision(rootDir), before);
  const malformed = JSON.parse(bytes);
  delete malformed.operations[0].summary.warnings;
  await writeFile(evidencePath, JSON.stringify(malformed));
  assert.equal((await runProviders({ ...options, phase: 'done', readOnly: true })).blocking, true);
  await writeFile(evidencePath, bytes);
  await writeFile(path.join(rootDir, 'changed.txt'), 'changed');
  assert.equal((await runProviders({ ...options, phase: 'done', readOnly: true })).blocking, true);
});

test('required unavailable/unsupported providers block; optional results degrade without losing other evidence', async () => {
  const rootDir = await project();
  const runProcess = fixtureRunner({ AIF_TEST_HLV_VERSION: '0.3.0' });
  for (const policy of ['optional', 'required']) {
    const result = await runProviders({ rootDir, phase: 'verify', changeId: 'provider-composition', write: true,
      policies: { hlv: { enable: true, policy }, lekalo: { enable: true, policy } }, runProcess });
    assert.equal(result.providers.length, 2);
    assert.equal(result.blocking, policy === 'required');
    assert.equal(result.providers[0].status, 'unsupported');
    assert.equal(result.providers[0].toolVersion, '0.3.0');
    assert.equal(result.providers[1].reason, 'protocol_unpublished');
    assert.ok(await readProviderFile(rootDir, '.ai-factory/qa/provider-composition/providers/lekalo-verify.json'));
  }
  assert.equal(providerGate('unavailable', 'optional').status, 'warn');
  assert.equal(providerGate('unavailable', 'required').blocking, true);
  assert.equal(providerGate('warn', 'required').blocking, false);
});

test('diagnostic codes survive while nested provider text and both raw streams remain ephemeral', async () => {
  const rootDir = await project();
  const result = await runProviders({ rootDir, phase: 'verify', changeId: 'provider-composition', write: true,
    runProcess: fixtureRunner({ AIF_TEST_HLV_FAIL: '1' }) });
  assert.equal(result.blocking, true);
  assert.deepEqual(result.providers[0].operations[0].diagnostics, [{ code: 'CTR-020', severity: 'error' }]);
  assert.equal(result.providers[0].operations[0].streams.stderr, 'present');
  assert.equal(JSON.stringify(result).includes('fixture-secret'), false);
  const malformed = await runProviders({ rootDir, phase: 'verify', runProcess: fixtureRunner({ AIF_TEST_HLV_SHAPE: 'invalid' }) });
  assert.equal(malformed.providers[0].status, 'unsupported');
});

test('doctor never executes check, fix, init, sync or writes evidence', async () => {
  const rootDir = await project();
  const calls = [];
  const before = await providerRevision(rootDir);
  const result = await runProviders({ rootDir, phase: 'doctor', runProcess: fixtureRunner({}, calls) });
  assert.equal(result.status, 'pass');
  assert.equal(calls.some((args) => args.some((arg) => ['check', '--fix', 'init', 'sync', 'update'].includes(arg))), false);
  await assert.rejects(stat(path.join(rootDir, '.ai-factory/qa')));
  assert.deepEqual(await providerRevision(rootDir), before);
});

test('a later failed validation supersedes old PASS evidence at the same revision', async () => {
  const rootDir = await project();
  const options = { rootDir, changeId: 'provider-composition', write: true };
  assert.equal((await runProviders({ ...options, phase: 'done', runProcess: fixtureRunner() })).blocking, false);
  assert.equal((await runProviders({ ...options, phase: 'verify', runProcess: fixtureRunner({ AIF_TEST_HLV_FAIL: '1' }) })).blocking, true);
  const result = await runProviders({ ...options, phase: 'done', write: false, readOnly: true, runProcess: fixtureRunner() });
  assert.equal(result.blocking, true);
  assert.equal(result.providers[0].operations[0].reason, 'validation_evidence_missing_or_stale');
});

test('source mutation during provider execution invalidates every result', async () => {
  const rootDir = await project();
  const run = fixtureRunner();
  const runProcess = async (executable, args, options) => {
    const result = await run(executable, args, options);
    if (args.includes('check')) await writeFile(path.join(rootDir, 'changed-by-gate.txt'), 'changed');
    return result;
  };
  const result = await runProviders({ rootDir, phase: 'verify', changeId: 'provider-composition', runProcess });
  assert.equal(result.blocking, true);
  assert.equal(result.providers[0].reason, 'revision_changed_during_provider_run');
});

test('ambiguous layout, hard links, traversal and linked QA cannot become writes', async () => {
  const rootDir = await project();
  await mkdir(path.join(rootDir, '.hlv'));
  await writeFile(path.join(rootDir, '.hlv/project.yaml'), 'schema_version: 1');
  const ambiguous = await runProviders({ rootDir, phase: 'doctor', runProcess: fixtureRunner() });
  assert.equal(ambiguous.providers[0].status, 'configuration_error');
  await assert.rejects(readProviderFile(rootDir, '../outside'));
  await link(path.join(rootDir, 'project.yaml'), path.join(rootDir, 'linked.yaml'));
  await assert.rejects(readProviderFile(rootDir, 'linked.yaml'));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'aifhub-provider-outside-'));
  roots.push(outside);
  await symlink(outside, path.join(rootDir, '.ai-factory/qa'), 'junction');
  const unsafe = await runProviders({ rootDir, phase: 'verify', changeId: 'provider-composition', write: true,
    revision: async () => ({ commit: 'a'.repeat(40), worktree: 'b'.repeat(64) }), runProcess: fixtureRunner() });
  assert.equal(unsafe.blocking, true);
  assert.equal(unsafe.providers[0].reason, 'evidence_write_failed');
  await assert.rejects(stat(path.join(outside, 'provider-composition')));
});

test('result schema mismatch and contradictory exit code are unsupported, never PASS', () => {
  const valid = { diagnostics: [], errors: 0, warnings: 0, infos: 0, strictness: 'standard', exit_code: 0 };
  assert.equal(normalizeHlvResult('validate', valid, 0).status, 'pass');
  for (const payload of [{}, { ...valid, errors: 1 }, { ...valid, exit_code: 1 },
    { ...valid, diagnostics: [{ code: 'C:\\private\\secret', severity: 'error' }] }]) {
    assert.throws(() => normalizeHlvResult('validate', payload, 0));
  }
});

test('process runner classifies spawn errors, output limit, timeout and cancellation without shell interpolation', async () => {
  const missing = await runProviderProcess(path.join(os.tmpdir(), 'aifhub-missing-executable-136'), []);
  assert.equal(missing.outcome, 'unavailable');
  const literal = '$(secret); echo private & whoami';
  const echoed = await runProviderProcess(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', literal]);
  assert.equal(echoed.stdout, literal);
  const flooded = await runProviderProcess(process.execPath, ['-e', 'process.stdout.write("x".repeat(100000))'], { maxOutputBytes: 1024 });
  assert.equal(flooded.outcome, 'output_limit');
  assert.ok(flooded.stdout.length <= 1024);
  const timed = await runProviderProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeoutMs: 500 });
  assert.equal(timed.outcome, 'timeout');
  const controller = new AbortController();
  const pending = runProviderProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { signal: controller.signal });
  setTimeout(() => controller.abort(), 500);
  assert.equal((await pending).outcome, 'cancelled');
  assert.equal((await runProviderProcess(process.execPath, [], { signal: controller.signal })).outcome, 'cancelled');
});

test('timeout kills ordinary descendant processes before they can write later', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aifhub-providers-tree-'));
  roots.push(root);
  const target = path.join(root, 'descendant-survived.txt');
  const trigger = path.join(root, 'runner-returned.txt');
  // Arm the write only after the process boundary returns. A fixed five-second
  // write deadline races Windows taskkill startup under load (the runner allows
  // up to six seconds to reap), without proving that a descendant survived.
  const descendant = `const fs = require('node:fs'); setInterval(() => { if (fs.existsSync(${JSON.stringify(trigger)})) { fs.writeFileSync(${JSON.stringify(target)}, 'bad'); process.exit(0); } }, 100); setTimeout(() => process.exit(0), 30000);`;
  const parent = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], {windowsHide:true,stdio:'inherit'}); console.log('descendant-started'); setInterval(()=>{},1000);`;
  const result = await runProviderProcess(process.execPath, ['-e', parent], { cwd: root, timeoutMs: 2000 });
  assert.equal(result.outcome, 'timeout');
  assert.match(result.stdout, /descendant-started/);
  await writeFile(trigger, 'ready');
  await new Promise((resolve) => setTimeout(resolve, 4000));
  await assert.rejects(stat(target));
});

test('fake semantic provider negotiates a separate contract and preserves only neutral evidence', async () => {
  const manifest = JSON.parse(await readFile(path.join(fixtures, 'fake-lekalo-capabilities.json'), 'utf8'));
  assert.equal(negotiateProviderCapabilities(manifest, ['impact', 'context']).status, 'pass');
  assert.equal(negotiateProviderCapabilities({ ...manifest, contract: { id: 'aifhub.provider', version: '2.0.0' } }).status, 'unsupported');
  assert.equal(negotiateProviderCapabilities(manifest, ['sync']).status, 'unsupported');
  const ref = `sha256:${'a'.repeat(64)}`;
  const trace = { schemaVersion: '1.0.0', links: [{ requirement: ref, semanticSymbol: ref, binding: ref, scenarioTest: ref, gate: ref }] };
  assert.equal(validateNeutralTrace(trace), true);
  const normalized = normalizeSemanticEvidence(manifest, { status: 'warn', diagnostics: [{ code: 'LEK-SEM-001',
    severity: 'warning', symbol: ref, message: 'fixture-secret' }], impact: [ref], context: { digest: ref, tokens: 100, raw: 'fixture-secret' }, trace });
  assert.equal(normalized.status, 'warn');
  assert.equal(JSON.stringify(normalized).includes('fixture-secret'), false);
  assert.equal(validateNeutralTrace({ ...trace, raw: 'fixture-secret' }), false);
});

test('CLI rejects unsafe identifiers without echoing them and sync stays unsupported', async () => {
  assert.deepEqual(await runProviderCommand(['verify', '--change', '../fixture-secret', '--write', '--json']),
    { exitCode: 2, stdout: '', stderr: 'Invalid provider command arguments.\n' });
  assert.equal((await runHlvOperation('sync', '.', {}, {})).status, 'unsupported');
});
