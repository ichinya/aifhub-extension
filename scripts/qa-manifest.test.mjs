import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir, realpath, link, utimes } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createGateResult, renderGateResultBlock } from './aif-gate-result.mjs';
import { digest, canonical } from './workflow-state-store.mjs';
import { prepareQaManifest, recordQaResult, publishQaManifest, evaluateQaBinding, parseQaManifestArgs, runQaManifestCommand } from './qa-manifest.mjs';
import { observeQaSnapshot, allDeclaredRoots } from './qa-manifest-inputs.mjs';
import { qaStore, QA_LIMITS } from './qa-manifest-store.mjs';
import { writeGateEvidence } from './write-gate-evidence.mjs';
import { writeVerificationEvidence, readLatestVerificationEvidence } from './openspec-verification-context.mjs';
import { readOpenSpecRulesGateEvidence } from './openspec-policy.mjs';
import { buildHandoffGateSummary } from './handoff-gate-summary.mjs';
import { doctorAifMode } from './aif-artifact-sync.mjs';

const roots = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
const bytes = value => Buffer.from(value);
const gateBody = (gate = 'verify', status = 'pass') => `${renderGateResultBlock(createGateResult({ gate, status,
  blockers: status === 'fail' ? [{ id: 'fixture', severity: 'error', summary: 'fixture finding' }] : [],
  affectedFiles: [], suggestedNext: status === 'fail' ? { command: '/aif-fix', reason: 'correct fixture finding' } : null }))}\n`;

async function fixture(flow = 'openspec', gates = ['verify']) {
  const rootDir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'qa234-')));
  roots.push(rootDir);
  const model = { files: { 'src/a.mjs': bytes('a'), 'src/b.mjs': bytes('b'), 'test/a.mjs': bytes('test'),
    'command.mjs': bytes('run'), 'outside.txt': bytes('outside') },
  ignored_names: [], modules: { helper: digest('helper') }, worktree_identity: digest(rootDir), actual_diff: digest('same HEAD/diff') };
  const toolchain = [{ name: 'fake-node', sha256: digest('runtime') }];
  const checks = gates.map((gate, i) => ({ id: `check-${gate}`, gate, profile: 'declared.v1', dependencies_complete: true,
    inputs: i ? ['src/b.mjs'] : ['src/a.mjs', 'test/a.mjs'], command: { argv: ['fake', gate], cwd: '.', definition: 'command.mjs' },
    toolchain, env_inputs: ['CI'] }));
  const options = { rootDir, flow, changeId: 'sample', scope: ['src', 'test', 'command.mjs'], checks, environment: {},
    providers: { requirements: async () => ({ gates, independent_roles: [], evidence: [] }), toolchain: async () => toolchain },
    SnapshotProvider: async ({ payload }) => {
      const files = { ...model.files };
      for (const root of allDeclaredRoots(payload)) if (!Object.keys(files).some(p => p === root || p.startsWith(`${root}/`))) files[root] = null;
      return { ...model, complete: true, files };
    } };
  const qa = flow === 'classic' ? '.ai-factory/plans/sample' : '.ai-factory/qa/sample';
  async function prepare(extra = {}) { return prepareQaManifest({ ...options, ...extra }); }
  async function record(gate = 'verify', extra = {}) { return recordQaResult({ ...options, gate, resultId: `${gate}-1`, markdown: gateBody(gate), ...extra }); }
  async function publish(extra = {}) { return publishQaManifest({ ...options, expectedPublication: null, ...extra }); }
  async function inspect(extra = {}) { return evaluateQaBinding({ ...options, ...extra }); }
  async function ready() {
    assert.equal((await prepare()).ok, true);
    for (const gate of gates) assert.equal((await record(gate)).ok, true);
    const published = await publish(); assert.equal(published.ok, true, JSON.stringify(published)); return published;
  }
  return { options, model, checks, toolchain, qa, prepare, record, publish, inspect, ready, rootDir };
}

describe('QA canonicalization and bounds (AC2, AC7)', () => {
  it('canonicalizes sorted object keys without changing array order or raw bytes', async () => {
    assert.equal(canonical({ b: 1, a: 2 }), canonical({ a: 2, b: 1 }));
    assert.notEqual(digest(['a', 'b']), digest(['b', 'a']));
    const f = await fixture(); await f.ready();
    f.model.files = Object.fromEntries(Object.entries(f.model.files).reverse());
    assert.equal((await f.inspect()).state, 'valid');
    for (const value of ['a\r\n', '\uFEFFa', 'a\n']) {
      f.model.files['src/a.mjs'] = bytes(value);
      assert.deepEqual((await f.inspect()).affected_checks, ['check-verify']);
    }
  });
  it('rejects case collisions, unsafe paths and missing catalog entries', async () => {
    const f = await fixture();
    f.model.files['SRC/A.mjs'] = bytes('collision');
    assert.equal((await f.prepare()).code, 'path-case-collision');
    delete f.model.files['SRC/A.mjs']; f.model.files['../escape'] = bytes('x');
    assert.equal((await f.prepare()).code, 'unsafe-path');
  });
  it('distinguishes absent, empty, missing, and undeclared paths', async () => {
    const f = await fixture(); f.checks[0].inputs.push('missing'); await f.ready();
    f.model.files.missing = bytes('');
    assert.equal((await f.inspect()).state, 'stale');
    delete f.model.files.missing;
    assert.equal((await f.inspect()).state, 'valid');
    f.options.environment.CI = '';
    assert.equal((await f.inspect()).state, 'stale');
    f.model.files.undeclared = bytes('');
    assert.equal((await f.inspect()).code, 'out-of-scope-edit');
  });
  it('blocks blob, aggregate read, file and check limits without truncation', async () => {
    const f = await fixture();
    f.model.files.big = Buffer.alloc(QA_LIMITS.blob + 1);
    assert.equal((await f.prepare()).code, 'qa-blob-limit');
    const block = Buffer.alloc(QA_LIMITS.blob);
    f.model.files = Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`f${i}`, block]));
    assert.equal((await f.prepare()).code, 'qa-read-budget');
    f.model.files = Object.fromEntries(Array.from({ length: 20001 }, (_, i) => [`f${i}`, null]));
    assert.equal((await f.prepare()).code, 'qa-files-limit');
    assert.equal((await f.prepare({ checks: Array.from({ length: 65 }, () => f.checks[0]) })).code, 'qa-checks-limit');
  });
  it('uses raw filesystem bytes with injected execFile, no Git/child processes', async () => {
    const f = await fixture();
    await mkdir(path.join(f.rootDir, 'src'), { recursive: true });
    await writeFile(path.join(f.rootDir, 'src/a.mjs'), 'before');
    const execFile = async (_bin, argv) => ({ stdout: argv.includes('--cached') ? 'src/a.mjs\0' : '' });
    const options = { ...f.options, SnapshotProvider: undefined, execFile,
      checks: [{ ...f.checks[0], inputs: ['src'], command: { argv: ['fake'], cwd: '.' } }] };
    const prepared = await prepareQaManifest(options);
    assert.equal(prepared.ok, true, JSON.stringify(prepared));
    assert.equal((await recordQaResult({ ...options, gate: 'verify', markdown: gateBody(), resultId: 'real-bytes' })).ok, true);
    assert.equal((await publishQaManifest({ ...options, expectedPublication: null })).ok, true);
    await utimes(path.join(f.rootDir, 'src/a.mjs'), new Date(1000), new Date(1000));
    assert.equal((await evaluateQaBinding(options)).state, 'valid');
    await writeFile(path.join(f.rootDir, 'src/a.mjs'), 'after!');
    await utimes(path.join(f.rootDir, 'src/a.mjs'), new Date(1000), new Date(1000));
    assert.equal((await evaluateQaBinding(options)).state, 'stale');
  });
  it('rejects hardlinked inputs through the production safe reader', async () => {
    const f = await fixture();
    await writeFile(path.join(f.rootDir, 'original'), 'bytes');
    await link(path.join(f.rootDir, 'original'), path.join(f.rootDir, 'aliased'));
    const result = await f.prepare({ SnapshotProvider: undefined,
      execFile: async (_bin, args) => ({ stdout: args.includes('--cached') ? 'aliased\0' : '' }) });
    assert.equal(result.state, 'blocked');
    assert.equal(result.code, 'unsafe-filesystem-entry');
  });
  it('distinguishes an empty directory from a missing declared root', async () => {
    const f = await fixture();
    await mkdir(path.join(f.rootDir, 'empty'));
    const options = { ...f.options, SnapshotProvider: undefined,
      checks: [{ ...f.checks[0], inputs: ['empty'], command: { argv: ['fake'], cwd: '.' } }],
      scope: ['empty'], execFile: async () => ({ stdout: '' }) };
    assert.equal((await prepareQaManifest(options)).ok, true);
    await recordQaResult({ ...options, gate: 'verify', markdown: gateBody(), resultId: 'empty' });
    assert.equal((await publishQaManifest({ ...options, expectedPublication: null })).ok, true);
    await rm(path.join(f.rootDir, 'empty'), { recursive: true });
    assert.equal((await evaluateQaBinding(options)).state, 'stale');
  });
});

describe('QA dependency-aware reuse (AC1, AC2)', () => {
  for (const flow of ['classic', 'openspec']) {
    it(`${flow}: permits only registered metadata delta, with zero new execution`, async () => {
      const f = await fixture(flow);
      const delivery = '.ai-factory/state/sample/delivery/retry.json';
      const status = '.ai-factory/state/sample/status.json';
      f.model.files[delivery] = bytes(JSON.stringify({ schema: 'aifhub.delivery.v1', body: 'bound', retry_count: 0, ack: false }));
      f.model.files[status] = bytes(JSON.stringify({ schema: 'aifhub.operational-status.v1', source: 'bound', status: 'idle' }));
      await f.ready();
      f.model.files[delivery] = bytes(JSON.stringify({ schema: 'aifhub.delivery.v1', body: 'bound', retry_count: 1, ack: true }));
      f.model.files[status] = bytes(JSON.stringify({ schema: 'aifhub.operational-status.v1', source: 'bound', status: 'complete' }));
      const result = await f.inspect();
      assert.equal(result.state, 'valid'); assert.equal(result.reused, true); assert.deepEqual(result.affected_checks, []);
      assert.equal((await readdir(path.join(f.rootDir, f.qa, 'results'))).length, 1);
      f.model.files[delivery] = bytes(JSON.stringify({ schema: 'aifhub.delivery.v1', body: 'changed', retry_count: 1 }));
      assert.equal((await f.inspect()).code, 'out-of-scope-edit');
    });
  }
  it('input wins over metadata projection', async () => {
    const f = await fixture();
    const p = '.ai-factory/state/sample/status.json'; f.checks[0].inputs.push(p);
    f.model.files[p] = bytes('{"schema":"aifhub.operational-status.v1","status":"idle"}');
    await f.ready();
    f.model.files[p] = bytes('{"schema":"aifhub.operational-status.v1","status":"running"}');
    assert.deepEqual((await f.inspect()).affected_checks, ['check-verify']);
  });
  it('attributes source/test/command/environment/toolchain drift precisely', async () => {
    for (const kind of ['source', 'test', 'command', 'environment', 'toolchain', 'argv']) {
      const f = await fixture('openspec', ['verify', 'review']);
      // Keep command and environment private to verify for exact attribution.
      f.checks[1].command = { argv: ['review'], cwd: '.' }; f.checks[1].env_inputs = [];
      const original = f.options.providers.toolchain;
      f.options.providers.toolchain = async c => c.id === 'check-verify' ? original(c) : [{ name: 'review', sha256: digest('review') }];
      await f.ready();
      if (kind === 'source') f.model.files['src/a.mjs'] = bytes('dirty bytes, same HEAD');
      if (kind === 'test') f.model.files['test/a.mjs'] = bytes('different');
      if (kind === 'command') f.model.files['command.mjs'] = bytes('changed definition');
      if (kind === 'environment') f.options.environment.CI = 'changed';
      if (kind === 'toolchain') f.toolchain[0] = { name: 'fake-node', sha256: digest('different bytes') };
      if (kind === 'argv') f.options.providers.checkDefinition = async c => c.id === 'check-verify'
        ? { ...c, command: { ...c.command, argv: ['new'] } } : c;
      assert.deepEqual((await f.inspect()).affected_checks, ['check-verify'], kind);
    }
  });
  it('generated rules and canonical task checkboxes are material policy', async () => {
    const f = await fixture();
    for (const p of ['.ai-factory/rules/generated/rules.md', 'openspec/changes/sample/tasks.md']) {
      f.model.files[p] = bytes('- [ ] task');
    }
    await f.ready();
    f.model.files['openspec/changes/sample/tasks.md'] = bytes('- [x] task');
    assert.equal((await f.inspect()).state, 'stale');
    f.model.files['.ai-factory/rules/generated/rules.md'] = bytes('new policy');
    assert.equal((await f.inspect()).state, 'stale');
  });
  it('tracks declared ignored bytes and input-root membership; undeclared ignored name drift blocks', async () => {
    const f = await fixture(); f.checks[0].ignored_inputs = ['ignored']; await f.ready();
    f.model.files['ignored/new-config'] = bytes('new');
    assert.equal((await f.inspect()).state, 'stale');
    f.model.ignored_names.push('unknown/cache');
    assert.equal((await f.inspect()).code, 'ignored-membership-drift');
  });
  it('blocks unknown runtime dependencies and unproven toolchain identity', async () => {
    const f = await fixture(); await f.ready();
    f.options.providers.dependencies = async () => ({ profile: 'declared.v1', dependencies_complete: false });
    assert.equal((await f.inspect()).code, 'dependency-unproven');
    delete f.options.providers.dependencies;
    f.options.providers.toolchain = async () => [{ name: 'node', version: 'v20' }];
    assert.equal((await f.inspect()).code, 'toolchain-unproven');
  });
  it('reuses an old immutable result in a new metadata wave with an explicit custody witness', async () => {
    const f = await fixture(); const pub = await f.ready();
    const original = await readFile(path.join(f.rootDir, f.qa, 'results/verify-1.json'));
    const prepared = await f.prepare({ waveId: 'next-wave' });
    assert.equal(prepared.ok, true, JSON.stringify(prepared));
    const result = await f.publish({ expectedPublication: pub.publication_id });
    assert.equal(result.ok, true);
    assert.equal(result.reuse_witnesses.length, 1);
    assert.equal(result.reuse_witnesses[0].result_id, 'verify-1');
    assert.deepEqual(await readFile(path.join(f.rootDir, f.qa, 'results/verify-1.json')), original);
  });
});

describe('QA custody, publications, receipts and history (AC3–AC7)', () => {
  it('saves failure and timeout, then an immutable corrective result with supersedes', async () => {
    const f = await fixture(); await f.prepare();
    const failed = { resultId: 'failed', markdown: gateBody('verify', 'fail'), execution: { kind: 'imported', exit_code: null, outcome: 'timeout' } };
    assert.equal((await f.record('verify', failed)).ok, true);
    const original = await readFile(path.join(f.rootDir, f.qa, 'results/failed.json'));
    assert.equal((await f.record('verify', failed)).ok, true);
    assert.equal((await f.record('verify', { resultId: 'failed' })).code, 'immutable-conflict');
    assert.equal((await f.record('verify', { force: true })).code, 'bound-force-forbidden');
    assert.equal((await f.record('verify', { resultId: 'fixed', supersedes: 'failed' })).ok, true);
    assert.deepEqual(await readFile(path.join(f.rootDir, f.qa, 'results/failed.json')), original);
    const fixed = JSON.parse(await readFile(path.join(f.rootDir, f.qa, 'results/fixed.json'), 'utf8'));
    assert.equal(fixed.record.supersedes, 'failed');
    assert.equal((await f.publish()).accepted, true);
  });
  it('current FAIL remains valid evidence without becoming acceptance', async () => {
    const f = await fixture(); await f.prepare(); await f.record('verify', { markdown: gateBody('verify', 'fail'), execution: { kind: 'imported', exit_code: 1, outcome: 'completed' } });
    const result = await f.publish();
    assert.equal(result.state, 'valid'); assert.equal(result.accepted, false);
    assert.equal((await f.inspect()).gates.verify.status, 'fail');
  });
  for (const kind of ['outside', 'modules', 'worktree', 'evidence']) {
    it(`blocks ${kind} custody drift before publication`, async () => {
      const f = await fixture(); await f.prepare(); await f.record();
      if (kind === 'outside') f.model.files['outside.txt'] = bytes('changed');
      if (kind === 'modules') f.model.modules.helper = digest('changed');
      if (kind === 'worktree') f.model.worktree_identity = digest('other checkout');
      if (kind === 'evidence') await writeFile(path.join(f.rootDir, f.qa, 'bodies/verify-1.md'), 'tampered');
      const result = await f.publish(); assert.equal(result.state, 'blocked');
      await assert.rejects(readFile(path.join(f.rootDir, f.qa, 'publication.json')), { code: 'ENOENT' });
    });
  }
  it('detects races between snapshot reads, including after materialization', async () => {
    const f = await fixture(); await f.prepare(); await f.record();
    const original = f.options.SnapshotProvider; let calls = 0;
    f.options.SnapshotProvider = async q => {
      if (++calls === 3) f.model.files['src/a.mjs'] = bytes('edit during publication');
      return original(q);
    };
    assert.equal((await f.publish()).code, 'custody-race');
    await assert.rejects(readFile(path.join(f.rootDir, f.qa, 'publication.json')), { code: 'ENOENT' });
  });
  it('enforces CAS, committed catalog, sealed waves and enrollment without manifest', async () => {
    const f = await fixture(); const pub = await f.ready();
    assert.equal((await f.publish()).code, 'publication-cas-conflict');
    assert.equal((await f.record('verify', { resultId: 'after-seal', supersedes: 'verify-1' })).code, 'wave-sealed');
    const committed = path.join(f.rootDir, f.qa, `publications/${pub.publication_id}.json`);
    const value = JSON.parse(await readFile(committed, 'utf8')); value.committed = false;
    await writeFile(committed, JSON.stringify(value));
    assert.equal((await f.inspect()).code, 'publication-incomplete');
    await rm(path.join(f.rootDir, f.qa, 'manifest.json'));
    assert.equal((await f.inspect()).code, 'manifest-missing');
  });
  it('detects deleted historical findings and refuses a different wave id', async () => {
    const f = await fixture(); await f.prepare();
    await f.record('verify', { resultId: 'failed', markdown: gateBody('verify', 'fail') });
    await f.record('verify', { resultId: 'fixed', supersedes: 'failed' });
    await f.publish();
    assert.equal((await f.inspect({ waveId: 'foreign-wave' })).code, 'wave-id-mismatch');
    await rm(path.join(f.rootDir, f.qa, 'results/failed.json'));
    assert.equal((await f.inspect()).code, 'result-history-incomplete');
  });
  it('two concurrent publishers cannot both accept the same expected publication', async () => {
    const f = await fixture(); await f.prepare(); await f.record();
    const results = await Promise.all([f.publish(), f.publish()]);
    assert.equal(results.filter(r => r.ok).length, 1);
    assert.ok(results.some(r => ['state-locked', 'publication-cas-conflict'].includes(r.code)));
  });
  it('requires complete results, evidence and independent roles without reducing mandatory gates', async () => {
    const f = await fixture('openspec', ['verify', 'review', 'rules', 'security']);
    await f.prepare(); await f.record(); assert.equal((await f.publish()).code, 'result-missing');
    for (const g of ['review', 'rules', 'security']) await f.record(g);
    f.options.providers.requirements = async () => ({ gates: ['verify', 'review', 'rules', 'security'], independent_roles: [{ check_id: 'check-review', role: 'review' }], evidence: [] });
    assert.equal((await f.publish()).code, 'owner-requirements-drift');
    assert.equal((await f.prepare({ requiredGates: [] })).ok, true);
    assert.equal((await f.publish()).code, 'independence-unproven');
  });
  it('preserves explicit mandatory roles across prepare and requires distinct proven actors', async () => {
    const f = await fixture('openspec', ['verify', 'review', 'security']);
    const roles = [{ check_id: 'check-review', role: 'review' }, { check_id: 'check-security', role: 'security' }];
    await f.prepare({ independentRoles: roles });
    for (const gate of ['verify', 'review', 'security']) await f.record(gate);
    await f.prepare();
    const manifest = await (await qaStore(f.options)).manifest();
    assert.deepEqual(manifest.payload.requirements.independent_roles, roles);
    const records = await (await qaStore(f.options)).results();
    const proof = (id, role, actor) => ({ actor, role, independent: true,
      result_sha256: digest(records.find(r => r.id === id)), worktree_identity: f.model.worktree_identity });
    f.options.HostObservationRegistry = { role: async (id, role) => proof(id, role, 'same-actor') };
    assert.equal((await f.publish()).code, 'independence-unproven');
    f.options.HostObservationRegistry.role = async (id, role) => proof(id, role, role);
    assert.equal((await f.publish()).ok, true);
  });
  it('does not bind results executed on drifted inputs to the old frozen wave', async () => {
    const f = await fixture(); await f.prepare();
    f.model.files['src/a.mjs'] = bytes('changed before recording');
    await f.record();
    assert.equal((await f.publish()).state, 'stale');
    f.model.files['src/a.mjs'] = bytes('a');
    assert.equal((await f.publish()).state, 'stale');
  });
  it('blocks result and evidence-reference bounds before overwriting any history', async () => {
    const f = await fixture(); await f.prepare();
    const artifacts = Object.fromEntries(Array.from({ length: 257 }, (_, i) => [`${f.qa}/artifact-${i}`, 'bytes']));
    assert.equal((await f.record('verify', { artifacts })).code, 'qa-refs-limit');
    await mkdir(path.join(f.rootDir, f.qa, 'results'), { recursive: true });
    for (let i = 0; i < 257; i++) await writeFile(path.join(f.rootDir, f.qa, `results/${i}.json`), '{}');
    assert.equal((await f.record()).code, 'qa-results-limit');
  });
  it('rejects missing required artifacts and invalid final blocks without old PASS fallback', async () => {
    const f = await fixture(); f.checks[0].required_evidence = [`${f.qa}/report.json`];
    await f.prepare();
    for (const markdown of [gateBody() + '```aif-gate-result\n{}', gateBody() + gateBody('rules'), gateBody() + '```aif-gate-result\n{bad}\n```']) {
      assert.equal((await f.record('verify', { markdown })).code, 'invalid-gate-evidence');
    }
    await f.record(); assert.equal((await f.publish()).code, 'evidence-catalog-incomplete');
  });
  it('requires a trusted registry; rejects forged/foreign/nonzero/timeout receipts but preserves them', async () => {
    for (const mode of ['valid', 'self-report', 'foreign', 'nonzero', 'timeout', 'wrong-path', 'wrong-run']) {
      const f = await fixture(); f.checks[0].requires_observed = true; await f.prepare();
      const store = await qaStore(f.options); const manifest = await store.manifest();
      const exit = mode === 'nonzero' ? 2 : mode === 'timeout' ? null : 0;
      const receipt = { schema: 'aifhub.observed-check.v1', run_id: 'host-run', check_id: 'check-verify',
        worktree_identity: mode === 'foreign' ? digest('foreign') : f.model.worktree_identity,
        input_fingerprints_digest: digest({ 'check-verify': manifest.payload.fingerprints['check-verify'] }),
        command_digest: digest(f.checks[0].command), exit_code: exit, outcome: mode === 'timeout' ? 'timeout' : 'completed', artifacts: {} };
      const receiptPath = 'receipt.json'; const raw = Buffer.from(JSON.stringify(receipt));
      await writeFile(path.join(f.rootDir, receiptPath), raw);
      f.options.HostObservationRegistry = { lookup: async () => mode === 'self-report' ? null : ({
        run_id: mode === 'wrong-run' ? 'other-run' : receipt.run_id,
        worktree_identity: f.model.worktree_identity, receipt_path: mode === 'wrong-path' ? 'other.json' : receiptPath,
        receipt_sha256: digest(raw), exit_code: exit, outcome: receipt.outcome }) };
      assert.equal((await f.record('verify', { receiptPath, execution: { kind: 'host-observed', exit_code: exit } })).ok, true);
      const result = await f.publish(); assert.equal(result.ok, mode === 'valid', mode);
      assert.equal((await readdir(path.join(f.rootDir, f.qa, 'results'))).length, 1);
    }
  });
});

describe('QA consumers and existing producers (AC6, AC7)', () => {
  it('writer routes enrolled evidence and legacy absence remains nonblocking', async () => {
    const f = await fixture(); assert.equal((await f.inspect()).code, 'manifest-absent');
    await f.prepare();
    assert.equal((await writeGateEvidence({ ...f.options, gate: 'verify', resultId: 'writer', markdown: gateBody() })).recorded, true);
    assert.equal((await f.publish()).ok, true);
  });
  it('direct verification writer preserves raw/validation/coverage in immutable artifacts', async () => {
    const f = await fixture(); await f.prepare();
    const result = await writeVerificationEvidence('sample', { validation: { ok: false, command: 'fake', args: [], exitCode: 1, stdout: 'findings', stderr: 'failed' },
      coverage: { schema_version: 1, change_id: 'sample', status: 'fail', requirements: [], summary: {}, sources: [], diagnostics: [], errors: [], warnings: [] },
      errors: [{ code: 'fixture', message: 'failed' }] }, { ...f.options, resultId: 'verification' });
    assert.equal(result.ok, true, JSON.stringify(result));
    const saved = JSON.parse(await readFile(path.join(f.rootDir, f.qa, 'results/verification.json'), 'utf8')).record;
    assert.ok(saved.artifacts[`${f.qa}/raw/openspec-validate.stdout`]);
    assert.ok(saved.artifacts[`${f.qa}/openspec-validation.json`]);
    assert.ok(saved.artifacts[`${f.qa}/coverage.json`]);
    assert.equal(saved.gate_block.status, 'fail');
  });
  it('rules reader closes stale PASS bypass and summary preserves semantic status with binding diagnostics', async () => {
    const f = await fixture('openspec', ['verify', 'rules']); await f.ready();
    assert.equal((await readOpenSpecRulesGateEvidence('sample', f.options)).ok, true);
    f.model.files['src/b.mjs'] = bytes('changed rules input');
    assert.equal((await readOpenSpecRulesGateEvidence('sample', f.options)).ok, false);
    const options = { ...f.options, stage: 'review',
      resolveActiveChange: async () => ({ ok: true, changeId: 'sample', qaPath: path.join(f.rootDir, f.qa), warnings: [] }),
      collectGeneratedRules: async () => ({ generatedRules: [], warnings: [], errors: [] }),
      readOpenSpecCoverageMatrix: async () => ({ exists: true, ok: true, stale: false, coverage: { status: 'pass' }, diagnostics: [] }) };
    const summary = await buildHandoffGateSummary(options);
    assert.equal(summary.gates.rules, 'pass'); assert.equal(summary.blocking, true);
    assert.ok(summary.diagnostics.some(d => d.state === 'stale' && d.affected_checks.includes('check-rules')));
    const before = await readFile(path.join(f.rootDir, f.qa, 'publication.json'));
    await buildHandoffGateSummary(options);
    assert.deepEqual(await readFile(path.join(f.rootDir, f.qa, 'publication.json')), before);
  });
  it('artifact sync and the verification reader reject a previously published stale PASS', async () => {
    const f = await fixture();
    async function write(relative, content) {
      await mkdir(path.dirname(path.join(f.rootDir, relative)), { recursive: true });
      await writeFile(path.join(f.rootDir, relative), content);
    }
    await write('.ai-factory/config.yaml', 'aifhub:\n  artifactProtocol: openspec\n');
    await write('openspec/config.yaml', 'project: fixture\n');
    await write('openspec/changes/sample/proposal.md', '# Proposal\n');
    await write('openspec/changes/sample/tasks.md', '- [x] 1.1 task\n');
    await f.ready();
    const options = { ...f.options, getCurrentBranch: async () => 'fixture',
      detectOpenSpec: async () => ({ available: false, canValidate: false, reason: 'fixture', errors: [] }),
      validateOpenSpecArtifactContract: async () => ({ status: 'pass', blocking: false, checks: [], diagnostics: [] }) };
    const current = await doctorAifMode(options);
    assert.ok(current.diagnostics.some(d => d.code === 'verify-gate-passed'));
    f.model.files['src/a.mjs'] = bytes('edited');
    const stale = await doctorAifMode(options);
    assert.ok(stale.diagnostics.some(d => d.code === 'verify-gate-binding-invalid'));
    assert.equal(stale.diagnostics.some(d => d.code === 'verify-gate-passed'), false);
    const verification = await readLatestVerificationEvidence('sample', f.options);
    assert.equal(verification.binding.state, 'stale');
    assert.equal(verification.gateResult.ok, false);
  });
  it('all CLI actions support --json and deterministic argument validation', async () => {
    for (const action of ['prepare', 'record', 'publish', 'inspect']) assert.equal(parseQaManifestArgs([action, '--change', 'sample', '--json']).json, true);
    assert.equal(parseQaManifestArgs(['inspect', '--change', 'sample', '--json', '--json']), null);
    const f = await fixture(); const chunks = [];
    assert.equal(await runQaManifestCommand(['inspect', '--change', 'sample', '--json'], { ...f.options, stdout: { write: s => chunks.push(s) } }), 0);
    assert.equal(JSON.parse(chunks.join('')).code, 'manifest-absent');
  });
});

describe('QA review hardening: case aliases, module identity, policy roots, verdict binding', () => {
  it('rejects Windows case-alias artifact paths into protected result history (F1)', async () => {
    const f = await fixture();
    await f.ready();
    const before = await f.inspect();
    assert.equal(before.state, 'valid');
    const attacked = await f.record('verify', { resultId: 'verify-2',
      artifacts: { [`${f.qa}/Results/failed.json`]: bytes('overwritten history') } });
    assert.equal(attacked.ok, false, JSON.stringify(attacked));
    assert.equal(attacked.code, 'artifact-control-path');
    const store = await qaStore(f.options);
    const history = await store.bytes(`${f.qa}/results/verify-1.json`);
    assert.notEqual(history.toString('utf8'), 'overwritten history');
    assert.equal((await f.inspect()).state, 'valid');
  });

  it('blocks results whose recorded module identity was restored before publication (F2)', async () => {
    const f = await fixture();
    await f.prepare();
    f.model.modules = { helper: digest('tampered-helper') };
    assert.equal((await f.record('verify')).ok, true);
    f.model.modules = { helper: digest('helper') };
    const verdict = await f.inspect({ requirePublication: false });
    assert.equal(verdict.state, 'blocked', JSON.stringify(verdict));
    assert.equal(verdict.code, 'module-identity-drift');
  });

  it('reuses a published wave only while the recorded module identity is current (F2 reuse)', async () => {
    const f = await fixture();
    await f.ready();
    f.model.modules = { helper: digest('drifted-helper') };
    const after = await f.inspect();
    assert.equal(after.state, 'blocked');
    assert.equal(after.code, 'module-identity-drift');
  });

  it('adds configured rules.base/skills to policy inputs from the project config (F3)', async () => {
    const f = await fixture();
    await mkdir(path.join(f.rootDir, '.ai-factory'), { recursive: true });
    await writeFile(path.join(f.rootDir, '.ai-factory', 'config.yaml'),
      '# comment\nother: 1\nrules:\n  base: .ai-factory/rules/base.md\n  skills: .ai-factory/rules/skills.md\n', 'utf8');
    await f.prepare();
    const store = await qaStore(f.options);
    const manifest = await store.manifest();
    assert.ok(manifest.payload.policy_inputs.includes('.ai-factory/rules/base.md'));
    assert.ok(manifest.payload.policy_inputs.includes('.ai-factory/rules/skills.md'));
  });

  it('rules reader derives the verdict from bound bytes and rejects a mismatched parse (F4)', async () => {
    const f = await fixture('openspec', ['verify', 'rules']);
    const published = await f.ready();
    const store = await qaStore(f.options);
    const records = await store.results();
    const rulesTip = records.filter(r => r.check_id === 'check-rules').at(-1);
    const content = (await store.bytes(rulesTip.evidence.path)).toString('utf8');
    const forged = JSON.parse(content.match(/```aif-gate-result\n([\s\S]*?)\n```/)[1]);
    forged.status = rulesTip.gate_block.status === 'pass' ? 'warn' : 'pass';
    const mismatch = await readOpenSpecRulesGateEvidence('sample', { ...f.options,
      rulesGateEvidence: { content }, rulesGateResult: forged });
    assert.equal(mismatch.ok, false);
    assert.equal(mismatch.errors.at(-1).code, 'gate-block-mismatch');
    const honest = await readOpenSpecRulesGateEvidence('sample', { ...f.options,
      rulesGateEvidence: { content }, rulesGateResult: rulesTip.gate_block });
    assert.equal(honest.ok, true, JSON.stringify({ honest, published: published?.code ?? null }));
    assert.equal(honest.gateResult.status, rulesTip.gate_block.status);
  });

  it('pins installed extension metadata, including aifhub-extension.json, in the module catalog (F5)', async () => {
    const f = await fixture();
    await f.prepare();
    const store = await qaStore(f.options);
    const manifest = await store.manifest();
    for (const name of ['extension.json', 'provenance.json', 'aifhub-extension.json']) {
      assert.ok(Object.hasOwn(manifest.payload.snapshot.modules, name), name);
      assert.notEqual(manifest.payload.snapshot.modules[name], digest('missing'));
    }
  });

  it('pins installed extension metadata, including aifhub-extension.json, in the real-FS module catalog (F5)', async () => {
    const f = await fixture();
    await mkdir(path.join(f.rootDir, 'src'), { recursive: true });
    await writeFile(path.join(f.rootDir, 'src/a.mjs'), 'before');
    const execFile = async (_bin, argv) => ({ stdout: argv.includes('--cached') ? 'src/a.mjs ' : '' });
    const options = { ...f.options, SnapshotProvider: undefined, execFile,
      checks: [{ ...f.checks[0], inputs: ['src'], command: { argv: ['fake'], cwd: '.' } }] };
    assert.equal((await prepareQaManifest(options)).ok, true);
    const store = await qaStore(options);
    const manifest = await store.manifest();
    for (const name of ['extension.json', 'provenance.json', 'aifhub-extension.json']) {
      assert.ok(Object.hasOwn(manifest.payload.snapshot.modules, name), name);
      assert.notEqual(manifest.payload.snapshot.modules[name], digest('missing'));
    }
  });

  it('chains corrective results automatically while preserving both records', async () => {
    const f = await fixture();
    await f.prepare();
    assert.equal((await f.record('verify', { resultId: 'verify-1', markdown: gateBody('verify', 'fail') })).ok, true);
    assert.equal((await f.record('verify', { resultId: 'verify-2' })).ok, true);
    const store = await qaStore(f.options);
    const records = await store.results();
    assert.equal(records.length, 2);
    assert.equal(records.find(r => r.id === 'verify-2').supersedes, 'verify-1');
    assert.equal(records.find(r => r.id === 'verify-1').gate_block.status, 'fail');
  });

  it('refuses publication when freshly read owner requirements exceed the prepared wave', async () => {
    const f = await fixture();
    await f.ready();
    const store = await qaStore(f.options);
    const pointer = await store.json(`${f.qa}/publication.json`);
    const drifted = await f.publish({ expectedPublication: pointer.id,
      providers: { requirements: async () => ({ gates: ['verify', 'rules'],
      independent_roles: [], evidence: [] }) } });
    assert.equal(drifted.ok, false, JSON.stringify(drifted));
    assert.equal(drifted.code, 'owner-requirements-drift');
  });
});
