import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { digest, WorkflowError } from './workflow-state-store.mjs';
import { createGateResult, renderGateResultBlock } from './aif-gate-result.mjs';
import { prepareQaManifest, publishQaManifest, evaluateQaBinding, recordQaResult } from './qa-manifest.mjs';
import { qaStore, QA_LIMITS } from './qa-manifest-store.mjs';
import { allDeclaredRoots } from './qa-manifest-inputs.mjs';
import { ingestObservedRun, observationRegistry, OBSERVED_RUN_SCHEMA } from './qa-observed-check.mjs';
import { createFakeObservedHost, createVerifierExec, composeObservedRun } from './fixtures/host-observed.mjs';

const roots = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
const bytes = value => Buffer.from(value);
const gateBody = (gate = 'verify', status = 'pass') => `${renderGateResultBlock(createGateResult({ gate, status,
  blockers: status === 'fail' ? [{ id: 'fixture', severity: 'error', summary: 'fixture finding' }] : [],
  affectedFiles: [], suggestedNext: status === 'fail' ? { command: '/aif-fix', reason: 'correct fixture finding' } : null }))}\n`;

// Offline fixture: in-memory SnapshotProvider (model from qa-manifest.test.mjs),
// the real fixture verifier copied into the project, a real child process per
// verifier launch through the injectable execFile, and no Git/network anywhere.
async function observedFixture({ mode = 'pass', requiresObserved = true, ignoredRaw = [], runId = 'run-1',
  gate = 'verify', gates = null, flow = 'openspec', execFailpoint = null, execThrow = false, capabilities = {},
  omitTimeout = false } = {}) {
  const rootDir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'qa227-')));
  roots.push(rootDir);
  const verifierRel = 'tools/observed-verifier.mjs';
  const qa = flow === 'classic' ? '.ai-factory/plans/sample' : '.ai-factory/qa/sample';
  const reportRel = `${qa}/artifacts/observations/reports/${runId}.json`;
  await mkdir(path.join(rootDir, 'tools'), { recursive: true });
  const verifierBytes = await readFile(new URL('./fixtures/observed-verifier.mjs', import.meta.url));
  await writeFile(path.join(rootDir, verifierRel), verifierBytes);
  // The verifier exists in the project from the start, so definition-byte drift
  // is a plain file mutation (the AC2 attribution channel).
  const model = { files: { 'src/a.mjs': bytes('a'), 'src/b.mjs': bytes('b'), '.ai-factory/config.yaml': bytes('rules:\n  base: base.md\n'),
    [verifierRel]: verifierBytes },
    ignored_names: [], modules: { helper: digest('helper') }, worktree_identity: digest(rootDir), actual_diff: digest('same HEAD/diff') };
  const toolchain = [{ name: 'fake-node', sha256: digest('runtime') }];
  const gateList = gates ?? [gate];
  const checks = gateList.map((gateName, index) => ({ id: `check-${gateName}`, gate: gateName,
    profile: 'declared.v1', dependencies_complete: true,
    inputs: index ? ['src/b.mjs'] : ['src/a.mjs'], requires_observed: requiresObserved,
    command: { argv: [process.execPath, verifierRel, '--mode', mode, '--report', reportRel, '--check', `check-${gateName}`],
      cwd: '.', definition: verifierRel }, toolchain, env_inputs: [] }));
  const options = { rootDir, flow, changeId: 'sample', scope: ['src', 'tools'], checks,
    // Library contract semantics: no environment option means process.env, and a
    // cold node.exe spawn must survive a loaded CI, hence the per-mode deadline.
    ...(omitTimeout ? {} : { timeoutMs: mode === 'hang' ? 2000 : 15000 }),
    providers: { requirements: async () => ({ gates: [...gateList], independent_roles: [], evidence: [] }), toolchain: async () => toolchain },
    SnapshotProvider: async ({ payload }) => {
      const files = { ...model.files };
      for (const root of allDeclaredRoots(payload)) if (!Object.keys(files).some(p => p === root || p.startsWith(`${root}/`))) files[root] = null;
      // Model the filesystem adapter's qaInternal exclusion: observation bytes
      // under `${qa}/artifacts/` never enter ignored_names.
      return { ...model, complete: true, files, ignored_names: ignoredRaw.filter(p => !p.startsWith(`${qa}/artifacts/`)) };
    } };
  const host = createFakeObservedHost({ capabilities });
  // A plain Error on purpose: the adapter must normalize a synchronous launch
  // failure into observation-exec-failed (a ready-made WorkflowError would mask it).
  options.execFile = execThrow ? () => { throw new Error('boom'); }
    : createVerifierExec(host.state, { failpoint: execFailpoint });
  async function prepare(extra = {}) { return prepareQaManifest({ ...options, ...extra }); }
  async function compose(extra = {}, run = runId) { return composeObservedRun({ ...options, ...extra }, { runId: run, mode }); }
  async function issue(envelope) { return host.issueEnvelope({ envelope, run_id: envelope.run_id, check_id: envelope.check_id }); }
  async function ingest(envelope, extra = {}) { return ingestObservedRun(envelope, { ...options, ...extra }); }
  async function publish(extra = {}) { return publishQaManifest({ ...options, expectedPublication: null, ...extra }); }
  async function inspect(extra = {}) { return evaluateQaBinding({ ...options, ...extra }); }
  async function records() { return (await qaStore(options)).results(); }
  const registry = observationRegistry(rootDir, 'sample', { flow });
  return { rootDir, qa, model, checks, toolchain, options, host, ignoredRaw, runId, mode, reportRel, verifierRel,
    prepare, compose, issue, ingest, publish, inspect, records, registry };
}

const realReport = (f, run = f.runId) => path.join(f.rootDir, f.qa, 'artifacts/observations/reports', `${run}.json`);
const recordPath = (f, run = f.runId) => `${f.qa}/artifacts/observations/${run}.json`;
const receiptPath = (f, run = f.runId) => `${f.qa}/artifacts/observations/receipts/${run}.json`;

async function recordedResult(f, resultId) {
  const record = (await f.records()).find(r => r.id === resultId);
  assert.ok(record, 'result record must exist');
  return record;
}

describe('observed-run envelope validation (task 2.1)', () => {
  it('rejects unknown fields, malformed digests and NUL argv with typed codes and zero writes', async () => {
    const f = await observedFixture();
    await f.prepare();
    for (const [mutate, code] of [
      [envelope => ({ ...envelope, extra_field: 1 }), 'observation-envelope-invalid'],
      [envelope => ({ ...envelope, snapshot_digest: 'not-a-digest' }), 'observation-envelope-invalid'],
      [envelope => ({ ...envelope, command: { ...envelope.command, argv: ['a' + String.fromCharCode(0) + 'b'] } }), 'observation-envelope-invalid'],
    ]) {
      const result = await f.ingest(mutate(await f.compose()));
      assert.equal(result.ok, false, code);
      assert.equal(result.code, code);
    }
    assert.equal(existsSync(path.join(f.rootDir, f.qa, 'artifacts/observations')), false);
    assert.equal(f.host.state.counters.verifier_launches, 0);
  });
  it('rejects a multi-check declaration without receipt or registry record', async () => {
    const f = await observedFixture();
    await f.prepare();
    const envelope = await f.compose();
    const result = await f.ingest({ ...envelope, covered_checks: [envelope.check_id, 'check-other'] });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'observation-multi-check');
    assert.equal(existsSync(path.join(f.rootDir, f.qa, 'artifacts/observations')), false);
    assert.equal((await f.records()).length, 0);
  });
  it('rejects an inconsistent declared report catalog before any write', async () => {
    const f = await observedFixture();
    await f.prepare();
    const envelope = await f.compose();
    const result = await f.ingest({ ...envelope, artifacts: {} });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'observation-declared-mismatch');
    assert.equal((await f.records()).length, 0);
  });
  it('treats an unsupported capability declaration as an adapter-level blocker without fabricating evidence', async () => {
    const f = await observedFixture({ capabilities: { observed_runs: false } });
    await f.prepare();
    const minimal = await f.issue({}); // host refuses the run before it starts
    assert.equal(minimal.outcome, 'unsupported');
    const result = await f.ingest(minimal);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'hook-capability-unsupported');
    assert.equal(existsSync(path.join(f.rootDir, f.qa, 'artifacts/observations')), false);
    assert.equal((await f.records()).length, 0);
    assert.equal(f.host.state.counters.verifier_launches, 0);
  });
});

describe('AC1: hook observed run binds the exact change revision', () => {
  for (const ignoredRaw of [[], [`${'.ai-factory/qa/sample'}/artifacts/observations/receipts/run-1.json`,
    `${'.ai-factory/qa/sample'}/artifacts/observations/reports/run-1.json`, 'other/cache']]) {
    it(`publishes a real verifier run through the injected registry (ignored_names: ${ignoredRaw.length})`, async () => {
      const f = await observedFixture({ ignoredRaw });
      const prepared = await f.prepare();
      assert.equal(prepared.ok, true, JSON.stringify(prepared));
      const ingested = await f.ingest(await f.issue(await f.compose()));
      assert.equal(ingested.ok, true, JSON.stringify(ingested));
      assert.equal(ingested.accepted, false);
      assert.equal(ingested.status, 'pass');
      assert.equal(f.host.state.counters.verifier_launches, 1);
      const record = await recordedResult(f, ingested.result_id);
      assert.equal(record.execution.kind, 'host-observed');
      const store = await qaStore(f.options);
      const receiptBytes = await store.bytes(record.execution.receipt.path);
      const receipt = JSON.parse(receiptBytes.toString('utf8'));
      assert.equal(receipt.schema, 'aifhub.observed-check.v1');
      assert.equal(receipt.input_fingerprints_digest, digest(record.input_fingerprints));
      assert.equal(receipt.command_digest, record.command_digest);
      const trusted = await f.registry.lookup('run-1');
      assert.equal(trusted.receipt_sha256, digest(receiptBytes));
      assert.equal(trusted.receipt_path, record.execution.receipt.original_path);
      assert.equal(trusted.worktree_identity, record.worktree_identity);
      assert.equal(trusted.exit_code, record.execution.exit_code);
      assert.equal(trusted.outcome, record.execution.outcome);
      assert.equal(trusted.result_id, ingested.result_id);
      const published = await f.publish({ HostObservationRegistry: f.registry });
      assert.equal(published.ok, true, JSON.stringify(published));
      assert.equal(published.accepted, true);
      assert.equal(published.gates.verify.status, 'pass');
      assert.equal((await f.inspect({ HostObservationRegistry: f.registry })).state, 'valid');
    });
  }
  it('keeps the ignored-membership channel alive while qa-internal observations stay exempt', async () => {
    const f = await observedFixture({ ignoredRaw: ['other/cache'] });
    await f.prepare();
    assert.equal((await f.ingest(await f.issue(await f.compose()))).ok, true);
    assert.equal((await f.inspect({ HostObservationRegistry: f.registry, requirePublication: false })).state, 'valid');
    f.ignoredRaw.push('extra/cache2');
    assert.equal((await f.inspect({ HostObservationRegistry: f.registry, requirePublication: false })).code,
      'ignored-membership-drift');
  });
});

describe('AC2: drift after a recorded PASS is attributed precisely', () => {
  it('attributes source, policy, command-definition and effective-cwd drift to the observed check', async () => {
    for (const kind of ['source', 'policy', 'definition', 'cwd']) {
      const f = await observedFixture();
      await f.prepare();
      assert.equal((await f.ingest(await f.issue(await f.compose()))).ok, true, kind);
      if (kind === 'source') f.model.files['src/a.mjs'] = bytes('dirty bytes');
      if (kind === 'policy') f.model.files['.ai-factory/config.yaml'] = bytes('rules:\n  base: other.md\n');
      if (kind === 'definition') f.model.files[f.verifierRel] = bytes('changed verifier bytes');
      if (kind === 'cwd') f.options.providers.checkDefinition = async c => c.id === 'check-verify'
        ? { ...c, command: { ...c.command, cwd: 'tools' } } : c;
      assert.deepEqual((await f.inspect({ HostObservationRegistry: f.registry, requirePublication: false })).affected_checks,
        ['check-verify'], kind);
    }
  });
  it('refuses a fresh ingestion composed against the pre-drift snapshot with typed stale codes', async () => {
    // Snapshot-level drift (source, policy, and the command definition root) is
    // attributed as stale-source; provider-level command drift that leaves the
    // snapshot untouched is attributed as stale-gates.
    for (const [kind, expected] of [['source', 'observation-stale-source'], ['definition', 'observation-stale-source'],
      ['policy', 'observation-stale-source'], ['cwd', 'observation-stale-gates']]) {
      const f = await observedFixture();
      await f.prepare();
      const envelope = await f.compose({}, 'run-2'); // composed against the prepare-time snapshot
      if (kind === 'source') f.model.files['src/a.mjs'] = bytes('drifted before ingest');
      if (kind === 'definition') f.model.files[f.verifierRel] = bytes('drifted verifier');
      if (kind === 'policy') f.model.files['.ai-factory/config.yaml'] = bytes('rules:\n  base: drifted.md\n');
      if (kind === 'cwd') f.options.providers.checkDefinition = async c => c.id === 'check-verify'
        ? { ...c, command: { ...c.command, cwd: 'tools' } } : c;
      const result = await f.ingest(await f.issue(envelope));
      assert.equal(result.ok, false, kind);
      assert.equal(result.code, expected, kind);
      assert.equal((await f.records()).length, 0, kind);
    }
  });
});

describe('AC3: forged evidence and imported objects never confirm a check', () => {
  async function recordedPass(f) {
    await f.prepare();
    const ingested = await f.ingest(await f.issue(await f.compose()));
    assert.equal(ingested.ok, true, JSON.stringify(ingested));
    return ingested;
  }
  it('blocks a receipt whose registry record is missing', async () => {
    const f = await observedFixture();
    const ingested = await recordedPass(f);
    await rm(path.join(f.rootDir, recordPath(f)));
    const published = await f.publish({ HostObservationRegistry: f.registry });
    assert.equal(published.ok, false);
    assert.equal(published.code, 'forged-receipt');
    assert.ok((await f.records()).some(r => r.id === ingested.result_id));
  });
  it('blocks when no trusted registry is provided at all', async () => {
    const f = await observedFixture();
    await recordedPass(f);
    const published = await f.publish();
    assert.equal(published.ok, false);
    assert.equal(published.code, 'execution-unproven');
  });
  it('blocks a registry record bound to a foreign worktree even though a record exists', async () => {
    const f = await observedFixture();
    await recordedPass(f);
    const raw = JSON.parse(await readFile(path.join(f.rootDir, recordPath(f)), 'utf8'));
    raw.record.worktree_identity = digest('foreign-worktree');
    await writeFile(path.join(f.rootDir, recordPath(f)), `${JSON.stringify({ checksum: digest(raw.record), record: raw.record }, null, 2)}\n`);
    const published = await f.publish({ HostObservationRegistry: f.registry });
    assert.equal(published.ok, false);
    assert.equal(published.code, 'forged-receipt');
  });
  it('blocks a registry record whose receipt digest diverges from the recorded receipt', async () => {
    const f = await observedFixture();
    await recordedPass(f);
    const raw = JSON.parse(await readFile(path.join(f.rootDir, recordPath(f)), 'utf8'));
    raw.record.receipt_sha256 = digest('other-bytes');
    await writeFile(path.join(f.rootDir, recordPath(f)), `${JSON.stringify({ checksum: digest(raw.record), record: raw.record }, null, 2)}\n`);
    const published = await f.publish({ HostObservationRegistry: f.registry });
    assert.equal(published.ok, false);
    assert.equal(published.code, 'forged-receipt');
  });
  it('imported evidence never creates a registry record and cannot satisfy requires_observed', async () => {
    const f = await observedFixture();
    await f.prepare();
    const receiptFile = `${f.qa}/artifacts/observations/receipts/imported-run.json`;
    await mkdir(path.join(f.rootDir, f.qa, 'artifacts/observations/receipts'), { recursive: true });
    await writeFile(path.join(f.rootDir, receiptFile), JSON.stringify({ schema: 'aifhub.observed-check.v1', forged: true }));
    const recorded = await recordQaResult({ ...f.options, gate: 'verify', resultId: 'imported-1',
      markdown: gateBody(), execution: { kind: 'imported', exit_code: 0 }, receiptPath: receiptFile });
    assert.equal(recorded.ok, true, JSON.stringify(recorded));
    assert.equal(await f.registry.lookup('imported-run'), null);
    assert.equal(await f.registry.lookup('run-1'), null);
    const published = await f.publish({ HostObservationRegistry: f.registry });
    assert.equal(published.ok, false);
    assert.equal(published.code, 'execution-unproven');
  });
});

describe('AC4: idempotent ingestion, conflicts and deterministic replay key', () => {
  it('replays an identical envelope without relaunching the verifier or refreshing freshness', async () => {
    const f = await observedFixture();
    await f.prepare();
    const envelope = await f.issue(await f.compose());
    const first = await f.ingest(envelope);
    assert.equal(first.ok, true);
    const before = await readFile(path.join(f.rootDir, f.qa, 'results', `${first.result_id}.json`));
    assert.equal(first.result_id, `observed-${digest('run-1').slice(0, 16)}`);
    const replay = await f.ingest(envelope);
    assert.equal(replay.ok, true);
    assert.equal(replay.replayed, true);
    assert.equal(replay.recorded, false);
    assert.equal(replay.result_id, first.result_id);
    assert.equal(f.host.state.counters.verifier_launches, 1);
    assert.deepEqual(await readFile(path.join(f.rootDir, f.qa, 'results', `${first.result_id}.json`)), before);
    const record = await recordedResult(f, first.result_id);
    assert.equal(record.supersedes, null);
    assert.equal((await f.publish({ HostObservationRegistry: f.registry })).ok, true);
  });
  it('rejects a conflicting payload under the same run_id and keeps the first record byte-identical', async () => {
    const f = await observedFixture();
    await f.prepare();
    const envelope = await f.issue(await f.compose());
    assert.equal((await f.ingest(envelope)).ok, true);
    const recordBefore = await readFile(path.join(f.rootDir, recordPath(f)));
    const receiptBefore = await readFile(path.join(f.rootDir, receiptPath(f)));
    const resultBefore = await readFile(path.join(f.rootDir, f.qa, 'results',
      `observed-${digest('run-1').slice(0, 16)}.json`));
    const conflicting = await f.ingest({ ...envelope, manifest_digest: digest('other-manifest') });
    assert.equal(conflicting.ok, false);
    assert.equal(conflicting.code, 'observation-conflict');
    assert.equal(f.host.state.counters.verifier_launches, 1);
    assert.deepEqual(await readFile(path.join(f.rootDir, recordPath(f))), recordBefore);
    assert.deepEqual(await readFile(path.join(f.rootDir, receiptPath(f))), receiptBefore);
    assert.deepEqual(await readFile(path.join(f.rootDir, f.qa, 'results',
      `observed-${digest('run-1').slice(0, 16)}.json`)), resultBefore);
  });
  it('surfaces immutable-conflict when the deterministic result id meets different content', async () => {
    const f = await observedFixture();
    await f.prepare();
    const first = await f.ingest(await f.issue(await f.compose()));
    assert.equal(first.ok, true);
    const result = await recordQaResult({ ...f.options, gate: 'verify', resultId: first.result_id, markdown: gateBody('verify', 'fail') });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'immutable-conflict');
  });
  it('accepts a corrective replay only with an explicit supersedes reference', async () => {
    const f = await observedFixture();
    await f.prepare();
    const first = await f.ingest(await f.issue(await f.compose()));
    const corrective = await recordQaResult({ ...f.options, gate: 'verify', resultId: 'manual-2',
      markdown: gateBody(), supersedes: first.result_id });
    assert.equal(corrective.ok, true, JSON.stringify(corrective));
    const record = await recordedResult(f, 'manual-2');
    assert.equal(record.supersedes, first.result_id);
  });
});

describe('AC5: negative outcomes stay distinct blockers, never warn-PASS', () => {
  for (const [mode, outcome] of [['fail', 'failed'], ['hang', 'timeout'], ['noreport', 'missing-report']]) {
    it(`${mode} is recorded verbatim as ${outcome} and never becomes acceptance`, async () => {
      const f = await observedFixture({ mode });
      await f.prepare();
      const ingested = await f.ingest(await f.issue(await f.compose()));
      assert.equal(ingested.ok, true, JSON.stringify(ingested));
      assert.equal(ingested.outcome, outcome);
      assert.equal(ingested.status, 'fail');
      const record = await recordedResult(f, ingested.result_id);
      assert.equal(record.execution.outcome, outcome);
      assert.equal(record.gate_block.status, 'fail');
      const published = await f.publish({ HostObservationRegistry: f.registry });
      assert.equal(published.ok, true, JSON.stringify(published));
      assert.equal(published.accepted, false);
      assert.equal(published.gates.verify.status, 'fail');
    });
  }
  it('an externally cancelled run records the explicit cancelled cause via the abort signal', async () => {
    const f = await observedFixture({ mode: 'cancel' });
    await f.prepare();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 250);
    try {
      const ingested = await f.ingest(await f.issue(await f.compose()), { signal: controller.signal });
      assert.equal(ingested.ok, true, JSON.stringify(ingested));
      assert.equal(ingested.outcome, 'cancelled');
      assert.equal(ingested.status, 'fail');
      assert.equal((await recordedResult(f, ingested.result_id)).execution.outcome, 'cancelled');
      const published = await f.publish({ HostObservationRegistry: f.registry });
      assert.equal(published.accepted, false);
      assert.equal(published.gates.verify.status, 'fail');
    } finally { clearTimeout(timer); controller.abort(); }
  });
  it('required timeout and cancelled checks never reach accepted:true through a warn status', async () => {
    for (const mode of ['hang', 'cancel']) {
      const f = await observedFixture({ mode });
      await f.prepare();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 250);
      try {
        const ingested = mode === 'cancel'
          ? await f.ingest(await f.issue(await f.compose()), { signal: controller.signal })
          : await f.ingest(await f.issue(await f.compose()));
        assert.equal(ingested.ok, true);
        const record = await recordedResult(f, ingested.result_id);
        assert.equal(record.gate_block.status, 'fail');
        assert.notEqual(record.gate_block.status, 'warn');
        const published = await f.publish({ HostObservationRegistry: f.registry });
        assert.equal(published.accepted, false, mode);
      } finally { clearTimeout(timer); controller.abort(); }
    }
  });
  it('substituted report bytes between run and custody read block the recording', async () => {
    const f = await observedFixture({ execFailpoint: async name => {
      if (name === 'after-verifier') await writeFile(realReport(f), 'substituted-bytes');
    } });
    await f.prepare();
    const result = await f.ingest(await f.issue(await f.compose()));
    assert.equal(result.ok, false);
    assert.equal(result.code, 'observation-declared-mismatch');
    assert.equal((await f.records()).length, 0);
    assert.equal(await f.registry.lookup('run-1'), null);
  });
  it('a declared outcome that contradicts the observed process is rejected without writing', async () => {
    const f = await observedFixture({ mode: 'pass' });
    await f.prepare();
    const envelope = await f.issue(await f.compose());
    const result = await f.ingest({ ...envelope, outcome: 'failed', exit_code: 2 });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'observation-declared-mismatch');
    assert.equal((await f.records()).length, 0);
    assert.equal(await f.registry.lookup('run-1'), null);
  });
  it('a hook-substituted invocation is never launched: the manifest command binds the spawn', async () => {
    const f = await observedFixture({ mode: 'pass' });
    await f.prepare();
    const envelope = await f.issue(await f.compose());
    const result = await f.ingest({ ...envelope,
      command: { ...envelope.command, argv: [process.execPath, '-e', 'process.exit(0)'] } });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'observation-declared-mismatch');
    assert.equal(f.host.state.counters.verifier_launches, 0);
    assert.equal((await f.records()).length, 0);
    assert.equal(await f.registry.lookup('run-1'), null);
    assert.equal(existsSync(path.join(f.rootDir, realReport(f))), false);
  });
  it('a substituted effective cwd cannot redirect relative argv resolution', async () => {
    const f = await observedFixture({ mode: 'pass' });
    await f.prepare();
    const envelope = await f.issue(await f.compose());
    const result = await f.ingest({ ...envelope, effective_cwd: 'src' });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'observation-declared-mismatch');
    assert.equal(f.host.state.counters.verifier_launches, 0);
    assert.equal((await f.records()).length, 0);
  });
  it('report bytes tampered after a successful ingest fail the binding catalog', async () => {
    const f = await observedFixture();
    await f.prepare();
    assert.equal((await f.ingest(await f.issue(await f.compose()))).ok, true);
    await writeFile(realReport(f), 'tampered-after-record');
    const published = await f.publish({ HostObservationRegistry: f.registry });
    assert.equal(published.ok, false);
    assert.equal(published.code, 'evidence-tampered');
  });
});

describe('crash and concurrency windows', () => {
  it('a crash before the launch leaves a pending intent; the resume completes the flow', async () => {
    const f = await observedFixture({ execThrow: true });
    await f.prepare();
    const envelope = await f.issue(await f.compose());
    const crashed = await f.ingest(envelope);
    assert.equal(crashed.ok, false);
    assert.equal(crashed.code, 'observation-exec-failed');
    assert.equal(f.host.state.counters.verifier_launches, 0);
    assert.equal(await f.registry.lookup('run-1'), null);
    f.options.execFile = createVerifierExec(f.host.state);
    const resumed = await f.ingest(envelope);
    assert.equal(resumed.ok, true, JSON.stringify(resumed));
    assert.equal(f.host.state.counters.verifier_launches, 1);
    assert.equal((await f.publish({ HostObservationRegistry: f.registry })).ok, true);
  });
  it('an orphan receipt with canonical bytes is adopted; different bytes fail closed', async () => {
    const f = await observedFixture();
    await f.prepare();
    const first = await f.ingest(await f.issue(await f.compose()));
    assert.equal(first.ok, true);
    const receiptBefore = await readFile(path.join(f.rootDir, receiptPath(f)));
    // Simulate a crash between the receipt write and the registry-complete write.
    await rm(path.join(f.rootDir, recordPath(f)));
    await rm(path.join(f.rootDir, f.qa, 'results', `${first.result_id}.json`));
    const resumed = await f.ingest(await f.issue(await f.compose()));
    assert.equal(resumed.ok, true, JSON.stringify(resumed));
    assert.deepEqual(await readFile(path.join(f.rootDir, receiptPath(f))), receiptBefore);
    assert.equal(f.host.state.counters.verifier_launches, 2);
    const hostile = await observedFixture();
    await hostile.prepare();
    const hostileFirst = await hostile.ingest(await hostile.issue(await hostile.compose()));
    await rm(path.join(hostile.rootDir, recordPath(hostile)));
    await rm(path.join(hostile.rootDir, hostile.qa, 'results', `${hostileFirst.result_id}.json`));
    await writeFile(path.join(hostile.rootDir, receiptPath(hostile)), '{"schema":"substituted"}');
    const blocked = await hostile.ingest(await hostile.issue(await hostile.compose()));
    assert.equal(blocked.ok, false);
    assert.equal(blocked.code, 'observation-incomplete');
  });
  it('a crash after the registry-complete write re-runs only the record stage with the same id', async () => {
    const f = await observedFixture();
    await f.prepare();
    const first = await f.ingest(await f.issue(await f.compose()));
    const before = await readFile(path.join(f.rootDir, f.qa, 'results', `${first.result_id}.json`));
    await rm(path.join(f.rootDir, f.qa, 'results', `${first.result_id}.json`));
    const resumed = await f.ingest(await f.issue(await f.compose()));
    assert.equal(resumed.ok, true, JSON.stringify(resumed));
    assert.equal(resumed.replayed, true);
    assert.equal(resumed.recorded, true);
    assert.equal(resumed.result_id, first.result_id);
    assert.equal(f.host.state.counters.verifier_launches, 1);
    assert.deepEqual(await readFile(path.join(f.rootDir, f.qa, 'results', `${first.result_id}.json`)), before);
  });
  it('parallel ingestions of the same run serialize through the registry lock', async () => {
    const f = await observedFixture({ mode: 'hang' });
    await f.prepare();
    const envelope = await f.issue(await f.compose());
    const results = await Promise.all([f.ingest(envelope), f.ingest(envelope)]);
    const okOnes = results.filter(r => r.ok === true);
    const locked = results.filter(r => r.code === 'state-locked');
    assert.equal(okOnes.length, 1);
    assert.equal(locked.length, 1);
    assert.equal((await f.records()).length, 1);
    const names = await readdir(path.join(f.rootDir, f.qa, 'artifacts/observations/receipts'));
    assert.deepEqual(names, ['run-1.json']);
    assert.equal((await f.records())[0].execution.outcome, 'timeout');
  });
});

describe('review custody contracts (round 2)', () => {
  for (const mode of ['fail', 'pass']) {
    it(`an observed run on the rules gate (${mode}) is rejected before any registry write`, async () => {
      const f = await observedFixture({ gate: 'rules', mode });
      await f.prepare();
      const result = await f.ingest(await f.issue(await f.compose()));
      assert.equal(result.ok, false);
      assert.equal(result.code, 'observation-gate-unsupported');
      // The registry lock creates (and removes) its own directory; no record,
      // receipt or result may exist after a pre-write rejection.
      assert.equal(existsSync(path.join(f.rootDir, f.qa, 'artifacts/observations/receipts')), false);
      assert.equal(await f.registry.lookup('run-1'), null);
      assert.equal((await f.records()).length, 0);
      assert.equal(f.host.state.counters.verifier_launches, 0);
    });
  }
  it('required evidence outside the host-attested catalog is rejected before the launch', async () => {
    const f = await observedFixture();
    f.checks[0].required_evidence = [`${f.qa}/report.json`];
    await f.prepare();
    const result = await f.ingest(await f.issue(await f.compose()));
    assert.equal(result.ok, false);
    assert.equal(result.code, 'observation-required-evidence-unattested');
    assert.equal(f.host.state.counters.verifier_launches, 0);
    assert.equal((await f.records()).length, 0);
  });
  it('recorder-only caller options are rejected and never leak into the bound record', async () => {
    const f = await observedFixture();
    await f.prepare();
    const envelope = await f.issue(await f.compose());
    for (const key of ['artifacts', 'supersedes', 'force', 'markdown', 'gate', 'checkId', 'resultId', 'receiptPath', 'execution']) {
      const result = await f.ingest(envelope, { [key]: key === 'force' ? true : 'smuggled' });
      assert.equal(result.ok, false, key);
      assert.equal(result.code, 'observation-options-conflict', key);
    }
    assert.equal((await f.records()).length, 0);
    assert.equal(f.host.state.counters.verifier_launches, 0);
  });
  it('the fingerprinted environment is the environment the verifier is spawned with', async () => {
    const f = await observedFixture();
    f.checks[0].env_inputs = ['CI'];
    f.options.environment = { ...process.env, CI: 'fixture-value' };
    await f.prepare();
    const baseExec = f.options.execFile;
    let spawnedEnv = null;
    f.options.execFile = (file, argv, opts, cb) => {
      if (file !== 'git') spawnedEnv = opts.env;
      return baseExec(file, argv, opts, cb);
    };
    const ingested = await f.ingest(await f.issue(await f.compose()));
    assert.equal(ingested.ok, true, JSON.stringify(ingested));
    assert.equal(spawnedEnv.CI, 'fixture-value');
    assert.equal((await f.publish({ HostObservationRegistry: f.registry })).accepted, true);
  });
  it('a declared-absent environment variable stays absent (no parent-env leak into the run)', async () => {
    const f = await observedFixture();
    f.checks[0].env_inputs = ['CI'];
    const withoutCI = { ...process.env };
    delete withoutCI.CI;
    f.options.environment = withoutCI;
    await f.prepare();
    const ingested = await f.ingest(await f.issue(await f.compose()));
    // With the parent-env merge bug this exact flow failed observation-stale-gates
    // before the launch: the fingerprinted CI-absent state was masked by process.env.
    assert.equal(ingested.ok, true, JSON.stringify(ingested));
  });
  it('a fresh envelope with a manifest digest from another wave is stale before intent or launch', async () => {
    const f = await observedFixture();
    await f.prepare();
    const envelope = await f.issue(await f.compose());
    const result = await f.ingest({ ...envelope, manifest_digest: digest('other-wave') });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'observation-stale-gates');
    assert.equal(f.host.state.counters.verifier_launches, 0);
    assert.equal(await f.registry.lookup('run-1'), null);
    assert.equal((await f.records()).length, 0);
  });
  it('owner requirements are a subset of the frozen manifest union, not its equal', async () => {
    const f = await observedFixture();
    await f.prepare({ evidenceRefs: [`${f.qa}/extra.json`],
      independentRoles: [{ check_id: 'check-verify', role: 'verify' }] });
    const ingested = await f.ingest(await f.issue(await f.compose()));
    // The manifest legitimately stores more than the live owner returns
    // (explicit additions and previous waves); the old equality rejected this.
    assert.equal(ingested.ok, true, JSON.stringify(ingested));
  });
  for (const mode of ['hang', 'noreport']) {
    it(`a required-evidence check records the ${mode} outcome verbatim and never reaches PASS`, async () => {
      const f = await observedFixture({ mode });
      f.checks[0].required_evidence = [`${f.qa}/report.json`];
      await f.prepare();
      const ingested = await f.ingest(await f.issue(await f.compose()));
      assert.equal(ingested.ok, true, JSON.stringify(ingested));
      assert.equal(ingested.status, 'fail');
      assert.equal(ingested.outcome, mode === 'hang' ? 'timeout' : 'missing-report');
      const record = await recordedResult(f, ingested.result_id);
      assert.equal(record.execution.outcome, ingested.outcome);
      const published = await f.publish({ HostObservationRegistry: f.registry });
      assert.equal(published.ok, false);
      assert.equal(published.code, 'evidence-catalog-incomplete');
    });
  }
  it('a synchronously-invoked transport callback cannot skip the deadline lifecycle', async () => {
    const f = await observedFixture({ mode: 'noreport' });
    await f.prepare();
    const { execFile: realExecFile } = await import('node:child_process');
    f.options.execFile = (file, argv, opts, cb) => {
      if (file === 'git') return realExecFile(file, argv, opts, cb);
      cb(null, '', ''); // synchronous callback: the deadline is not armed yet
      return { kill() {} };
    };
    const ingested = await f.ingest(await f.issue(await f.compose()));
    assert.equal(ingested.ok, true, JSON.stringify(ingested));
    assert.equal(ingested.outcome, 'missing-report');
  });
  it('attested artifacts outside the qa namespace are inadmissible before the launch', async () => {
    const f = await observedFixture();
    f.model.files['outside/attested.txt'] = bytes('attested bytes');
    await f.prepare();
    const envelope = await f.issue(await f.compose());
    const declared = { ...envelope,
      artifacts: { ...envelope.artifacts, 'outside/attested.txt': digest('attested bytes') } };
    const result = await f.ingest(declared);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'observation-artifact-inadmissible');
    assert.equal(f.host.state.counters.verifier_launches, 0);
    assert.equal((await f.records()).length, 0);
  });
  it('an oversized attested artifact fails before the receipt and registry are written', async () => {
    const f = await observedFixture();
    await f.prepare();
    const bigRel = `${f.qa}/observations-extra.bin`;
    const big = Buffer.alloc(QA_LIMITS.blob + 1);
    await writeFile(path.join(f.rootDir, bigRel), big);
    const envelope = await f.issue(await f.compose());
    const declared = { ...envelope, artifacts: { ...envelope.artifacts, [bigRel]: digest(big) } };
    const result = await f.ingest(declared);
    // The store's leaf reader rejects oversized bytes before any custody write.
    assert.equal(result.ok, false);
    assert.equal(result.code, 'unsupported-file');
    assert.equal(await f.registry.lookup('run-1'), null);
    assert.equal(existsSync(path.join(f.rootDir, receiptPath(f))), false);
  });
  it('record-only resume revalidates the attested snapshot before re-recording', async () => {
    const f = await observedFixture();
    await f.prepare();
    const ingested = await f.ingest(await f.issue(await f.compose()));
    assert.equal(ingested.ok, true);
    const resultFile = path.join(f.rootDir, f.qa, 'results', `${ingested.result_id}.json`);
    await rm(resultFile);
    f.model.files['src/a.mjs'] = bytes('drifted after the run');
    const resumed = await f.ingest(await f.issue(await f.compose()));
    assert.equal(resumed.ok, false);
    assert.equal(resumed.code, 'observation-stale-source');
    assert.equal(existsSync(resultFile), false);
  });
  it('a caller-owned environment mutated in flight cannot change the spawned environment', async () => {
    const f = await observedFixture();
    f.checks[0].env_inputs = ['CI'];
    const callerEnv = { CI: 'declared' };
    f.options.environment = callerEnv;
    await f.prepare();
    const original = f.options.execFile;
    let spawnedCI = null;
    f.options.execFile = (file, argv, opts, cb) => {
      if (file === 'git') return original(file, argv, opts, cb);
      callerEnv.CI = 'mutated-in-flight'; // between pre-fingerprint and spawn...
      spawnedCI = opts.env.CI;            // ...the spawn must still see the defensive copy
      return original(file, argv, opts, (error, stdout, stderr) => {
        callerEnv.CI = 'declared';        // ...and restored before the post reads
        cb(error, stdout, stderr);
      });
    };
    const ingested = await f.ingest(await f.issue(await f.compose()));
    assert.equal(ingested.ok, true, JSON.stringify(ingested));
    assert.equal(spawnedCI, 'declared');
    assert.equal((await f.publish({ HostObservationRegistry: f.registry })).accepted, true);
  });
  it('an in-place provider roles mutation cannot pass the pre/post owner comparison', async () => {
    const f = await observedFixture({ gates: ['verify', 'review'] });
    const roles = [{ check_id: 'check-verify', role: 'verify' }, { check_id: 'check-review', role: 'review' }];
    f.options.providers.requirements = async () => ({ gates: ['verify', 'review'], independent_roles: roles, evidence: [] });
    await f.prepare({ independentRoles: roles });
    const original = f.options.execFile;
    f.options.execFile = (file, argv, opts, cb) => {
      if (file !== 'git') roles.reverse(); // in-place mutation while the run is in flight
      return original(file, argv, opts, cb);
    };
    const result = await f.ingest(await f.issue(await f.compose()));
    // Both subset checks still pass after the reorder; only the copied pre/post
    // owner snapshots catch the drift.
    assert.equal(result.ok, false);
    assert.equal(result.code, 'observation-custody-race');
    assert.equal((await f.records()).length, 0);
  });
  it('a transport without a stop mechanism refuses typed instead of hanging the lock', async () => {
    const f = await observedFixture({ mode: 'hang' });
    f.options.timeoutMs = 200;
    await f.prepare();
    const result = await f.ingest(await f.issue(await f.compose()), {
      execFile: () => ({ /* no kill, no callback ever */ }) });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'observation-stop-unsupported');
    assert.equal(await f.registry.lookup('run-1'), null);
  });
  it('a failing stop is normalized and a killed transport gets a bounded grace window', async () => {
    const f = await observedFixture({ mode: 'hang' });
    f.options.timeoutMs = 200;
    await f.prepare();
    const failing = await f.ingest(await f.issue(await f.compose()), {
      execFile: () => ({ kill() { throw new Error('no'); } }) });
    assert.equal(failing.ok, false);
    assert.equal(failing.code, 'observation-exec-failed');
    const grace = await f.ingest(await f.issue(await f.compose()), {
      execFile: () => ({ kill() { /* stop ok, but no callback ever fires */ } }) });
    assert.equal(grace.ok, false);
    assert.equal(grace.code, 'observation-exec-failed');
    assert.equal(await f.registry.lookup('run-1'), null);
  });
  it('a reference budget overflow refuses before any custody write', async () => {
    const f = await observedFixture();
    const extra = {};
    await mkdir(path.join(f.rootDir, f.qa, 'attest'), { recursive: true });
    for (let i = 0; i < QA_LIMITS.refs - 1; i++) {
      const rel = `${f.qa}/attest/file-${i}.txt`;
      f.model.files[rel] = bytes(`attested-${i}`);
      await writeFile(path.join(f.rootDir, rel), `attested-${i}`);
      extra[rel] = digest(`attested-${i}`);
    }
    await f.prepare();
    const envelope = await f.issue(await f.compose());
    const declared = { ...envelope, artifacts: { ...envelope.artifacts, ...extra } };
    const result = await f.ingest(declared);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'qa-refs-limit');
    assert.equal(await f.registry.lookup('run-1'), null);
    assert.equal(existsSync(path.join(f.rootDir, receiptPath(f))), false);
  });
  it('record-only resume refuses a run attested against a replaced manifest wave', async () => {
    const f = await observedFixture();
    await f.prepare();
    const envelope = await f.issue(await f.compose());
    const ingested = await f.ingest(envelope);
    assert.equal(ingested.ok, true);
    const resultFile = path.join(f.rootDir, f.qa, 'results', `${ingested.result_id}.json`);
    await rm(resultFile); // crash window: registry-complete exists, the record does not
    await f.prepare(); // a new wave replaces the manifest pointer
    const resumed = await f.ingest(envelope); // exact replay of the original envelope
    assert.equal(resumed.ok, false);
    assert.equal(resumed.code, 'observation-stale-gates');
    assert.equal(existsSync(resultFile), false);
  });
  it('a slow verifier completes under the bounded default deadline', async () => {
    const f = await observedFixture({ mode: 'slow', omitTimeout: true });
    await f.prepare();
    const ingested = await f.ingest(await f.issue(await f.compose()));
    // With the old 2s default this run was killed as timeout; the bounded
    // 10-minute default lets real verification runs complete.
    assert.equal(ingested.ok, true, JSON.stringify(ingested));
    assert.equal(ingested.outcome, 'completed');
    assert.equal(ingested.status, 'pass');
    assert.equal((await f.publish({ HostObservationRegistry: f.registry })).accepted, true);
  });
  it('a verbose verifier keeps its recorded evidence beyond the 1 MiB stdio buffer', async () => {
    const f = await observedFixture({ mode: 'verbose', omitTimeout: true });
    await f.prepare();
    const ingested = await f.ingest(await f.issue(await f.compose()));
    assert.equal(ingested.ok, true, JSON.stringify(ingested));
    assert.equal(ingested.outcome, 'completed');
    assert.equal((await f.publish({ HostObservationRegistry: f.registry })).accepted, true);
  });
  it('orphan report bytes from an earlier attempt cannot complete a run that wrote no report', async () => {
    const f = await observedFixture({ mode: 'noreport' });
    await f.prepare();
    const stale = bytes('stale report from a previous attempt');
    await mkdir(path.join(f.rootDir, f.qa, 'artifacts/observations/reports'), { recursive: true });
    await writeFile(realReport(f), stale);
    const envelope = await f.issue(await f.compose());
    const declared = { ...envelope, outcome: 'completed', exit_code: 0,
      report_sha256: digest(stale), artifacts: { [envelope.report_path]: digest(stale) } };
    const result = await f.ingest(declared);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'observation-declared-mismatch');
    assert.equal((await f.records()).length, 0);
    assert.equal(await f.registry.lookup('run-1'), null);
    assert.equal(f.host.state.counters.verifier_launches, 1);
  });
  it('owner requirements changed after prepare stale the ingestion before the launch', async () => {
    const f = await observedFixture();
    await f.prepare();
    f.options.providers.requirements = async () => ({ gates: ['verify', 'review'], independent_roles: [], evidence: [] });
    const result = await f.ingest(await f.issue(await f.compose()));
    assert.equal(result.ok, false);
    assert.equal(result.code, 'observation-stale-gates');
    assert.equal((await f.records()).length, 0);
  });
  it('requirements drift between the pre- and post-run reads blocks the custody window', async () => {
    const f = await observedFixture({ execFailpoint: async () => {
      f.options.providers.requirements = async () => ({ gates: ['verify'], independent_roles: [], evidence: ['drift'] });
    } });
    await f.prepare();
    const result = await f.ingest(await f.issue(await f.compose()));
    assert.equal(result.ok, false);
    assert.equal(result.code, 'observation-custody-race');
    assert.equal((await f.records()).length, 0);
    assert.equal(await f.registry.lookup('run-1'), null);
  });
  it('a conflicting payload under an existing pending intent is rejected without touching it', async () => {
    const f = await observedFixture({ execThrow: true });
    await f.prepare();
    const envelope = await f.issue(await f.compose());
    assert.equal((await f.ingest(envelope)).code, 'observation-exec-failed');
    const before = await readFile(path.join(f.rootDir, recordPath(f)));
    const conflicting = await f.ingest({ ...envelope, manifest_digest: digest('other-manifest') });
    assert.equal(conflicting.ok, false);
    assert.equal(conflicting.code, 'observation-conflict');
    assert.deepEqual(await readFile(path.join(f.rootDir, recordPath(f))), before);
  });
  it('a corrupted registry record fails closed and preserves the bytes', async () => {
    const f = await observedFixture({ execThrow: true });
    await f.prepare();
    const envelope = await f.issue(await f.compose());
    assert.equal((await f.ingest(envelope)).code, 'observation-exec-failed');
    const recordFile = path.join(f.rootDir, recordPath(f));
    await writeFile(recordFile, '{"corrupted":');
    const before = await readFile(recordFile);
    const result = await f.ingest(envelope);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'observation-registry-tampered');
    assert.deepEqual(await readFile(recordFile), before);
  });
  it('a stored result that does not belong to the run fails the replay instead of confirming it', async () => {
    const f = await observedFixture();
    await f.prepare();
    const ingested = await f.ingest(await f.issue(await f.compose()));
    assert.equal(ingested.ok, true);
    const resultFile = path.join(f.rootDir, f.qa, 'results', `${ingested.result_id}.json`);
    await writeFile(resultFile, '{"checksum":"fabricated","record":{}}');
    const replay = await f.ingest(await f.issue(await f.compose()));
    assert.equal(replay.ok, false);
    assert.equal(replay.code, 'observation-incomplete');
  });
  it('the fake host refuses re-issuing a run under a different payload', async () => {
    const f = await observedFixture();
    await f.prepare();
    await f.issue(await f.compose());
    const reissued = { ...(await f.compose()), snapshot_digest: digest('other-snapshot') };
    await assert.rejects(() => f.issue(reissued), /conflicting-payload/);
  });
  it('classic flow stores observations under the plan folder namespace', async () => {
    const f = await observedFixture({ flow: 'classic' });
    const prepared = await f.prepare();
    assert.equal(prepared.ok, true, JSON.stringify(prepared));
    const ingested = await f.ingest(await f.issue(await f.compose()));
    assert.equal(ingested.ok, true, JSON.stringify(ingested));
    assert.ok(ingested.receipt_path.startsWith('.ai-factory/plans/sample/artifacts/observations/'),
      ingested.receipt_path);
    assert.ok(existsSync(path.join(f.rootDir, '.ai-factory/plans/sample/artifacts/observations/receipts/run-1.json')));
    assert.equal((await f.inspect({ HostObservationRegistry: f.registry, requirePublication: false })).state, 'valid');
  });
  it('one callback-style execFile multiplexes git snapshot calls and the verifier without a SnapshotProvider', async () => {
    const rootDir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'qa227fs-')));
    roots.push(rootDir);
    const verifierRel = 'tools/observed-verifier.mjs';
    const qa = '.ai-factory/qa/sample';
    await mkdir(path.join(rootDir, 'tools'), { recursive: true });
    await mkdir(path.join(rootDir, 'src'), { recursive: true });
    await writeFile(path.join(rootDir, verifierRel), await readFile(new URL('./fixtures/observed-verifier.mjs', import.meta.url)));
    await writeFile(path.join(rootDir, 'src/a.mjs'), 'real bytes');
    const toolchain = [{ name: 'fake-node', sha256: digest('runtime') }];
    const check = { id: 'check-verify', gate: 'verify', profile: 'declared.v1', dependencies_complete: true,
      inputs: ['src/a.mjs'], requires_observed: true,
      command: { argv: [process.execPath, verifierRel, '--mode', 'pass', '--report',
        `${qa}/artifacts/observations/reports/run-1.json`, '--check', 'check-verify'], cwd: '.', definition: verifierRel },
      toolchain, env_inputs: [] };
    const options = { rootDir, flow: 'openspec', changeId: 'sample', scope: ['src', 'tools'], checks: [check],
      environment: {},
      providers: { requirements: async () => ({ gates: ['verify'], independent_roles: [], evidence: [] }),
        toolchain: async () => toolchain } };
    const { execFile: realExecFile } = await import('node:child_process');
    const trace = [];
    let launches = 0;
    const callbackExec = (file, argv, opts, cb) => {
      trace.push([file, ...argv]);
      if (file === 'git') {
        const stdout = argv.includes('--cached') ? `src/a.mjs${String.fromCharCode(0)}` : '';
        return cb(null, stdout, '');
      }
      launches += 1;
      return realExecFile(file, argv, opts, cb);
    };
    // Snapshot consumers take the promisified shape; the adapter wraps its own transport.
    const wrapped = (file, args, opts) => new Promise((resolve, reject) => {
      callbackExec(file, args, opts, (error, stdout, stderr) => {
        if (error) { error.stdout = stdout; error.stderr = stderr; reject(error); return; }
        resolve({ stdout, stderr });
      });
    });
    const prepared = await prepareQaManifest({ ...options, execFile: wrapped });
    assert.equal(prepared.ok, true, JSON.stringify(prepared));
    const envelope = await composeObservedRun({ ...options, execFile: wrapped }, { runId: 'run-1' });
    const ingested = await ingestObservedRun(envelope, { ...options, execFile: callbackExec });
    assert.equal(ingested.ok, true, JSON.stringify(ingested));
    assert.equal(launches, 1);
    assert.ok(trace.some(entry => entry[0] === 'git'), 'git snapshot calls must be multiplexed');
    const registry = observationRegistry(rootDir, 'sample');
    const trusted = await registry.lookup('run-1');
    assert.equal(trusted.receipt_path, `${qa}/artifacts/observations/receipts/run-1.json`);
    const store = await qaStore(options);
    const record = (await store.results()).find(r => r.id === ingested.result_id);
    const receiptBytes = await store.bytes(record.execution.receipt.path);
    const receipt = JSON.parse(receiptBytes.toString('utf8'));
    assert.equal(receipt.input_fingerprints_digest, digest(record.input_fingerprints));
    assert.equal(trusted.receipt_sha256, digest(receiptBytes));
  });
});

describe('AC6: inert without hook configuration and stable extension surfaces', () => {
  it('absent hook configuration leaves the ordinary QA path untouched', async () => {
    const f = await observedFixture();
    assert.equal((await f.inspect()).code, 'manifest-absent');
    assert.equal(await f.registry.lookup('run-1'), null);
    assert.equal(existsSync(path.join(f.rootDir, f.qa, 'artifacts/observations')), false);
    assert.equal(f.host.state.counters.verifier_launches, 0);
    await f.prepare();
    assert.equal((await f.publish({ HostObservationRegistry: f.registry })).ok, false);
    assert.equal(f.host.state.counters.verifier_launches, 0);
  });
  it('extension.json and tool-config.mjs bytes are unchanged by adapter usage', async () => {
    const extensionBefore = await readFile(new URL('../extension.json', import.meta.url));
    const toolConfigBefore = await readFile(new URL('./tool-config.mjs', import.meta.url));
    const f = await observedFixture();
    await f.prepare();
    assert.equal((await f.ingest(await f.issue(await f.compose()))).ok, true);
    assert.equal((await f.publish({ HostObservationRegistry: f.registry })).ok, true);
    assert.deepEqual(await readFile(new URL('../extension.json', import.meta.url)), extensionBefore);
    assert.deepEqual(await readFile(new URL('./tool-config.mjs', import.meta.url)), toolConfigBefore);
  });
  it('recording, ingestion, publication and final verification keep separate authorities', async () => {
    const f = await observedFixture();
    await f.prepare();
    const ingested = await f.ingest(await f.issue(await f.compose()));
    assert.equal(ingested.accepted, false);
    assert.deepEqual(ingested.authorizes, []);
    assert.equal(existsSync(path.join(f.rootDir, f.qa, 'publications')), false);
    const published = await f.publish({ HostObservationRegistry: f.registry });
    assert.deepEqual(published.authorizes, []);
    const binding = await f.inspect({ HostObservationRegistry: f.registry });
    assert.deepEqual(binding.authorizes, []);
    assert.equal(binding.state, 'valid');
  });
});
