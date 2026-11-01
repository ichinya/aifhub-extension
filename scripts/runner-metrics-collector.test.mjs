import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { deliveryProject } from './fixtures/delivery-project.mjs';
import { createFakeHost } from './fixtures/host-delivery.mjs';
import { createGateResult, renderGateResultBlock } from './aif-gate-result.mjs';
import { canonical, digest } from './workflow-state-store.mjs';
import { deliveryPaths, deliveryStore } from './host-delivery-store.mjs';
import { history } from './execution-transactions.mjs';
import { collectRunnerMetrics, projectChecks, runCollectorCommand } from './runner-metrics-collector.mjs';
import { validateJsonAgainstSchema } from './json-schema-subset.mjs';
import { exportEvaluation } from './workflow-exchange.mjs';
import { qaStore } from './qa-manifest-store.mjs';
import { allDeclaredRoots, checkFingerprints, observeQaSnapshot } from './qa-manifest-inputs.mjs';
import { prepareQaManifest, recordQaResult } from './qa-manifest.mjs';
import { writeLegacyExecution } from './fixtures/execution-v1.mjs';
import { executionProject } from './fixtures/execution-project.mjs';

const exec = promisify(execFile);
const HEX = /^[a-f0-9]{64}$/;
const gateBody = (gate = 'security', status = 'pass') => Buffer.from('\uFEFFРусский English 😀 &|<>^%! " ` $()\r\n' + renderGateResultBlock(createGateResult({ gate, status,
  blockers: status === 'fail' ? [{ id: 'fixture', severity: 'error', summary: 'finding' }] : [], affectedFiles: [],
  suggestedNext: status === 'fail' ? { command: '/aif-fix', reason: 'fix' } : null })) + '\r\n');
const resend = (result) => ({ recovery_action: { type: 'resend-same-request', request_uuid: result.request_uuid,
  preconditions: result.resend_preconditions } });

// One change with a started run and one delivered request: the common base for
// aggregation, dedup and non-interference scenarios.
async function fixture(t, { mode = 'normal', uuid = randomUUID(), host: suppliedHost } = {}) {
  const f = await deliveryProject(t); t.after(f.cleanup);
  const body = gateBody();
  const report = '.ai-factory/evidence/work/security.md';
  await f.put(report, body);
  const host = suppliedHost ?? createFakeHost({ mode });
  await f.call('start', f.start());
  const input = { change_id: f.id, run_id: 'run-1', request_uuid: uuid };
  await f.call('delivery-reserve', { ...input, target: { kind: 'completion', locator: 'worker-1' } });
  await f.call('result', f.actor(1, { result: { result_id: 'result-1', status: 'completed', changed_files: [], checks: [{ name: 'offline-fixture', exit_code: 0 }], evidence: [report] } }));
  await f.call('delivery-prepare', { ...input, gate: 'security', body });
  const send = (extra = {}, opts = {}) => f.call('delivery-send', { ...input, ...extra }, { HostClient: host, ...opts });
  const recover = (extra = {}, opts = {}) => f.call('delivery-recover', { ...input, ...extra }, { HostClient: host, ...opts });
  const s = await deliveryStore({ rootDir: f.root });
  return { ...f, uuid, input, body, host, send, recover, s, paths: deliveryPaths(f.id, uuid), record: () => s.loadRequest(f.id, uuid),
    collect: (argv = [], options = {}) => collectRunnerMetrics({ rootDir: f.root, argv: ['--change', f.id, ...argv], ...options }) };
}

// A second delivered request in the same change and run.
async function addRequest(f, { uuid = randomUUID(), kind = 'completion', host = f.host } = {}) {
  const input = { change_id: f.id, run_id: 'run-1', request_uuid: uuid };
  await f.call('delivery-reserve', { ...input, target: { kind, locator: 'worker-1' } });
  await f.call('delivery-prepare', { ...input, gate: 'security', body: f.body });
  await f.call('delivery-send', input, { HostClient: host });
  return { input, paths: deliveryPaths(f.id, uuid) };
}

const withoutOutput = (files) => Object.fromEntries(Object.entries(files).filter(([name]) => !name.endsWith('/runner-metrics.json') && !name.endsWith('/runner-metrics.custom.json')));

async function inventory(root, relative) {
  const files = {};
  async function walk(dir) {
    const entries = await readdir(path.join(root, dir), { withFileTypes: true }).catch((e) => {
      if (e.code === 'ENOENT') return [];
      throw e;
    });
    for (const entry of entries) {
      const name = `${dir}/${entry.name}`;
      if (entry.isDirectory()) await walk(name);
      else files[name] = digest(await readFile(path.join(root, name)));
    }
  }
  await walk(relative);
  return files;
}

test('aggregates a verified sample: attribution, spans, transport sums, provenance', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.send()).delivery_verified, true);
  const before = await f.record();
  const result = await f.collect();
  assert.equal(result.outcome, 'collected');
  assert.equal(result.ok, true);
  const m = result.metrics;
  assert.equal(m.schema, 'aifhub.runner_metrics.v1');
  assert.equal(m.run_id, 'run-1');
  assert.equal(m.coverage, 'delivery_registry');
  assert.deepEqual(m.attribution, { coordinator: 'parent', worker: 'worker', role: 'implement', run_kind: 'single', runs: 1, tasks: 1 });
  assert.deepEqual(m.requests, { total: 1, verified: 1, retried: 0, recovered: 0, incomplete: 0, duplicate_responses: 0, by_kind: { message: 0, completion: 1 } });
  assert.equal(m.transport.create_calls, 1);
  assert.equal(m.transport.read_calls, before.transport.read_calls);
  assert.equal(m.transport.incomplete_intervals, 0);
  assert.equal(m.checks, null);
  assert.equal(m.phases.setup_ms, null);
  assert.equal(m.phases.run_elapsed_ms, null);
  assert.equal(typeof m.phases.run_record_span_ms, 'number');
  assert.ok(m.phases.run_record_span_ms >= 0);
  assert.equal(m.phases.workers_span_sum_ms, m.phases.run_record_span_ms);
  assert.equal(m.phases.pending_observed_ms, 0);
  assert.equal(m.unknowns.includes('tokens'), true);
  assert.equal(m.unknowns.includes('checks'), true);
  assert.equal(m.unknowns.includes('setup_ms'), true);
  assert.match(m.provenance.registry_digest, HEX);
  assert.deepEqual([m.provenance.requests_scanned, m.provenance.journals_scanned, m.provenance.runs_scanned], [1, 1, 1]);
  assert.equal(m.provenance.members_skipped, 0);
  assert.equal(m.provenance.collector.id, 'aifhub-extension');
  assert.ok(m.provenance.collector.version.length > 0);
  // No token source: null plus the unknown marker, never a zero.
  assert.equal(m.tokens, null);
  assert.deepEqual(result.errors, []);
  const exit = await runCollectorCommand(['--change', f.id], { rootDir: f.root, stdout: { write: () => {} } });
  assert.equal(exit, 0);
});

test('multi-run sample without --run keeps attribution null; --run narrows without auto-selection', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.send()).delivery_verified, true);
  const run = await f.s.load(`${f.paths.folder}/runs/run-1.json`);
  await f.call('accept', { ...f.actor(2), actor: 'parent', result_digest: run.result.digest });
  await f.call('start', f.start({ run_id: 'run-2', task_id: '1.2', scope: ['src/b.js'] }));
  await f.call('delivery-reserve', { change_id: f.id, run_id: 'run-2', request_uuid: randomUUID(), target: { kind: 'message', locator: 'worker-2' } });
  const result = await f.collect();
  assert.equal(result.outcome, 'collected');
  const m = result.metrics;
  assert.equal(m.run_id, null);
  assert.equal(m.attribution.runs, 2);
  assert.equal(m.attribution.coordinator, null);
  assert.equal(m.attribution.worker, null);
  assert.equal(m.attribution.role, null);
  assert.equal(m.attribution.run_kind, null);
  assert.equal(m.attribution.tasks, 2);
  assert.equal(m.requests.total, 2);
  assert.equal(m.requests.by_kind.completion + m.requests.by_kind.message, 2);
  assert.ok(m.phases.run_record_span_ms >= 0);
  const narrowed = await f.collect(['--run', 'run-2']);
  assert.equal(narrowed.metrics.run_id, 'run-2');
  assert.equal(narrowed.metrics.requests.total, 1);
  assert.equal(narrowed.metrics.requests.verified, 0);
  assert.equal(narrowed.metrics.attribution.runs, 1);
  const empty = await f.collect(['--run', 'missing']);
  assert.equal(empty.outcome, 'collected');
  assert.ok(empty.notes.some((note) => note.code === 'run_filter_empty'));
  assert.equal(empty.metrics.requests.total, 0);
  assert.equal(empty.metrics.run_id, null);
  const exit = await runCollectorCommand(['--change', f.id, '--run', 'missing'], { rootDir: f.root, stdout: { write: () => {} } });
  assert.equal(exit, 0);
});

test('republication of one image never sums revisions or counter maxima', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.send()).delivery_verified, true);
  const before = await f.record();
  assert.equal((await f.recover()).delivery_verified, true);
  const after = await f.record();
  assert.ok(after.revision > before.revision);
  assert.ok(after.transport.read_calls > before.transport.read_calls);
  const result = await f.collect();
  assert.equal(result.metrics.transport.read_calls, after.transport.read_calls);
  assert.ok(result.metrics.transport.read_calls < before.transport.read_calls + after.transport.read_calls);
  assert.equal(result.metrics.requests.total, 1);
});

test('journal-ahead and journal-only members join the union without materialization', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.send()).delivery_verified, true);
  const record = await f.record();
  const ahead = structuredClone(record);
  ahead.transport.read_calls += 1;
  ahead.revision += 1;
  ahead.updated_at = '2026-11-01T00:00:00.000Z';
  ahead.history.push({ revision: ahead.revision, phase: ahead.phase, at: ahead.updated_at });
  await f.s.save(f.paths.journal, { schema: 'aifhub.delivery-journal.v1', request_uuid: f.uuid, record_digest: digest(ahead), record: ahead });
  const second = await addRequest(f, { host: createFakeHost({ mode: 'shared-completion' }) });
  const secondJournal = await f.s.load(second.paths.journal);
  await f.s.remove(second.paths.request);
  assert.equal(await f.s.bytes(second.paths.request), null);
  const result = await f.collect();
  assert.equal(result.outcome, 'collected');
  assert.equal(result.metrics.requests.total, 2);
  // The journal-ahead image wins for the first member; the journal-only
  // member contributes its own journal image. No revision is summed twice.
  assert.equal(result.metrics.transport.read_calls, ahead.transport.read_calls + secondJournal.record.transport.read_calls);
  assert.equal(result.metrics.provenance.journals_scanned, 2);
  assert.equal(await f.s.bytes(second.paths.request), null);
});

test('same uuid and revision with different bytes is a conflict: skip + degraded, total intact', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.send()).delivery_verified, true);
  const record = await f.record();
  const conflicting = structuredClone(record);
  conflicting.release = { released_at: '2026-11-01T00:00:00.000Z', host_release_state: 'released' };
  await f.s.save(f.paths.journal, { schema: 'aifhub.delivery-journal.v1', request_uuid: f.uuid, record_digest: digest(conflicting), record: conflicting });
  const result = await f.collect();
  assert.equal(result.outcome, 'degraded');
  assert.equal(result.ok, false);
  assert.ok(result.notes.some((note) => note.code === 'member_skipped'));
  assert.equal(result.metrics.provenance.members_skipped, 1);
  assert.equal(result.metrics.requests.total, 1);
  assert.equal(result.metrics.requests.verified, 0);
  assert.equal(result.metrics.transport.create_calls, 0);
  assert.equal(result.metrics.provenance.registry_digest, digest(canonical([{ request_uuid: f.uuid, record_digest: null }])));
  const exit = await runCollectorCommand(['--change', f.id], { rootDir: f.root, stdout: { write: () => {} } });
  assert.equal(exit, 1);
});

test('shared completion id deduplicates responses without touching transport', async (t) => {
  const f = await fixture(t, { host: createFakeHost({ mode: 'shared-completion' }) });
  assert.equal((await f.send()).delivery_verified, true);
  await addRequest(f);
  const result = await f.collect();
  assert.equal(result.outcome, 'collected');
  assert.equal(result.metrics.requests.duplicate_responses, 1);
  assert.equal(result.metrics.transport.create_calls, 2);
  assert.equal(result.metrics.transport.fetch_calls, 2);
  assert.equal(result.metrics.requests.verified, 2);
  assert.equal(result.metrics.requests.total, 2);
});

test('same host id in different namespaces is not deduplicated', async (t) => {
  const otherNamespace = { idempotency: { scope_digest: digest('other-namespace'), continuity_token: 'epoch-1', retention_until: 'durable', conflicting_payload: 'reject' } };
  const f = await fixture(t, { host: createFakeHost({ mode: 'shared-completion' }) });
  assert.equal((await f.send()).delivery_verified, true);
  await addRequest(f, { host: createFakeHost({ mode: 'shared-completion', capabilities: otherNamespace }) });
  const result = await f.collect();
  assert.equal(result.outcome, 'collected');
  assert.equal(result.metrics.requests.duplicate_responses, 0);
  assert.equal(result.metrics.requests.total, 2);
});

test('retries and recoveries publish separate non-additive counters', async (t) => {
  const f = await fixture(t, { mode: 'before-commit' });
  const uncertain = await f.send();
  assert.equal(uncertain.delivery_verified, false);
  assert.equal(uncertain.retry_create_allowed, true);
  f.host.mode = 'normal';
  const done = await f.recover(resend(uncertain));
  assert.equal(done.delivery_verified, true);
  const result = await f.collect();
  assert.equal(result.metrics.transport.create_calls, 2);
  assert.equal(result.metrics.transport.retry_creates, 1);
  assert.ok(result.metrics.transport.recovery_attempts >= 1);
  assert.equal(result.metrics.transport.verified_recoveries, 1);
  assert.equal(result.metrics.requests.retried, 1);
  assert.equal(result.metrics.requests.recovered, 1);
  assert.equal(result.metrics.requests.verified, 1);
  // transport_ms and recovery_ms stay separate; no summed breakdown field exists.
  assert.equal(Object.keys(result.metrics.phases).some((key) => key.includes('breakdown')), false);
});

test('pending, blocked and open intervals stay incomplete without state mutation', async (t) => {
  const pending = await fixture(t, { mode: 'pending' });
  assert.equal((await pending.send()).query_state, 'pending');
  const pendingResult = await pending.collect();
  assert.equal(pendingResult.metrics.requests.verified, 0);
  assert.equal(pendingResult.metrics.requests.incomplete, 1);
  assert.equal(pendingResult.metrics.transport.uncertain_returns, 1);
  assert.equal(pendingResult.metrics.phases.pending_observed_ms, 0);

  const blocked = await fixture(t);
  const conflict = await blocked.send({ body: Buffer.from('other body') });
  assert.equal(conflict.state, 'blocked');
  const blockedResult = await blocked.collect();
  assert.equal(blockedResult.metrics.requests.incomplete, 1);
  assert.equal(blockedResult.metrics.transport.identity_conflicts, 1);

  const interrupted = await fixture(t);
  assert.equal((await interrupted.send()).delivery_verified, true);
  const record = await interrupted.record();
  record.interval = { kind: 'read', started_at: '2001-01-01T00:00:00.000Z' };
  await interrupted.s.saveRequest(record);
  const after = await interrupted.record();
  const stateBefore = await inventory(interrupted.root, '.ai-factory/state');
  const result = await interrupted.collect();
  // The open interval adds one on top of the recorded counter without
  // mutating the state bytes.
  assert.equal(result.metrics.transport.incomplete_intervals, after.transport.incomplete_intervals + 1);
  assert.equal(result.metrics.requests.incomplete, 1);
  assert.deepEqual(withoutOutput(await inventory(interrupted.root, '.ai-factory/state')), withoutOutput(stateBefore));
});

test('pending dwell derives only from recorded history boundaries', async (t) => {
  const f = await fixture(t, { mode: 'pending' });
  assert.equal((await f.send()).query_state, 'pending');
  const record = await f.record();
  // A later still-pending history boundary records a measurable dwell; the
  // final pending tail stays zero by the producer invariant.
  const dwellMs = 5000;
  const dwellRecord = structuredClone(record);
  dwellRecord.revision += 1;
  dwellRecord.updated_at = new Date(Date.parse(record.updated_at) + dwellMs).toISOString();
  dwellRecord.history.push({ revision: dwellRecord.revision, phase: 'pending', at: dwellRecord.updated_at });
  // Persist the new revision in journal and registry alike so loadRequest
  // sees one consistent image instead of a journal/request race.
  await f.s.save(f.paths.journal, { schema: 'aifhub.delivery-journal.v1', request_uuid: f.uuid, record_digest: digest(dwellRecord), record: dwellRecord });
  await f.s.save(f.paths.request, dwellRecord);
  const result = await f.collect();
  assert.ok(result.metrics.phases.pending_observed_ms >= dwellMs,
    `pending dwell ${result.metrics.phases.pending_observed_ms} should include the recorded ${dwellMs}ms span`);
});

test('prepared transaction journal is read without failing the scan', async (t) => {
  const f = await fixture(t);
  const failpoint = (name) => { if (name === 'after-journal') throw new Error('crash:after-journal'); };
  const input = f.start({ run_id: 'run-2', task_id: '1.2', scope: ['src/b.js'] });
  await assert.rejects(f.call('start', input, { failpoint }), /crash:after-journal/);
  let result = await f.collect();
  assert.equal(result.outcome, 'collected');
  assert.equal(result.metrics.provenance.runs_scanned, 1);
  const published = await f.call('start', input);
  assert.equal(published.run_id, 'run-2');
  result = await f.collect();
  assert.equal(result.metrics.provenance.runs_scanned, 2);
  assert.equal(result.metrics.attribution.runs, 2);
});

test('empty registry is an honest collected zero with full unknowns', async (t) => {
  const f = await deliveryProject(t); t.after(f.cleanup);
  const result = await collectRunnerMetrics({ rootDir: f.root, argv: ['--change', f.id] });
  assert.equal(result.outcome, 'collected');
  const m = result.metrics;
  assert.equal(m.requests.total, 0);
  assert.equal(m.transport.create_calls, 0);
  assert.equal(m.coverage, 'delivery_registry');
  assert.ok(m.unknowns.length >= 12);
  assert.equal(m.unknowns.includes('model_requests'), true);
  assert.equal(m.unknowns.includes('coordinator_accounting'), true);
  assert.equal(m.unknowns.includes('billing'), true);
  assert.equal(m.provenance.registry_digest, digest(canonical([])));
  assert.match(m.provenance.registry_digest, HEX);
});

function qaOptions(f, { provider } = {}) {
  const model = { files: { 'src/a.js': Buffer.from('source') }, ignored_names: [], modules: { helper: digest('helper') }, worktree_identity: digest('worktree'), actual_diff: digest('diff') };
  const toolchain = [{ name: 'fixture-node', sha256: digest('node') }];
  const check = { id: 'check-verify', gate: 'verify', profile: 'declared.v1', dependencies_complete: true, inputs: ['src/a.js'],
    command: { argv: ['fake'], cwd: '.' }, toolchain, env_inputs: [], requires_observed: true };
  return { rootDir: f.root, changeId: f.id, scope: ['src'], checks: [check], environment: {},
    providers: { requirements: async () => ({ gates: ['verify'], independent_roles: [], evidence: [] }), toolchain: async () => toolchain },
    SnapshotProvider: provider ?? (async ({ payload }) => {
      const files = { ...model.files };
      for (const root of allDeclaredRoots(payload)) {
        if (!Object.keys(files).some((p) => p === root || p.startsWith(root + '/'))) files[root] = null;
      }
      return { ...model, complete: true, files };
    }) };
}

test('include-qa counts corrective supersession chains and closed reason codes', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.send()).delivery_verified, true);
  const options = qaOptions(f);
  assert.equal((await prepareQaManifest(options)).ok, true);
  for (const resultId of ['qa-1', 'qa-2']) {
    const recorded = await recordQaResult({ ...options, gate: 'verify', resultId, markdown: gateBody('verify').toString('utf8') });
    assert.equal(recorded.ok, true, JSON.stringify(recorded));
  }
  // A third record whose observation fails publishes an open binding code.
  const failing = qaOptions(f, { provider: async () => { throw Object.assign(new Error('boom'), { code: 'snapshot-incomplete' }); } });
  const third = await recordQaResult({ ...failing, gate: 'verify', resultId: 'qa-3', markdown: gateBody('verify').toString('utf8') });
  assert.equal(third.ok, true, JSON.stringify(third));
  const result = await f.collect(['--include-qa']);
  assert.equal(result.outcome, 'collected');
  const checks = result.metrics.checks;
  assert.equal(checks.results, 3);
  assert.equal(checks.repeated, 2);
  assert.deepEqual(checks.reasons, [{ code: 'unknown', count: 1 }]);
  assert.equal(checks.dependencies.length, 1);
  assert.deepEqual(Object.keys(checks.dependencies[0]).sort(), ['check_id', 'input_fingerprint', 'manifest_digest', 'wave_id']);
  assert.equal(result.metrics.coverage, 'delivery_registry+qa');
  assert.equal(result.metrics.unknowns.includes('checks'), false);
  assert.equal(result.metrics.provenance.qa_results_scanned, 3);
});

test('delivery recovery types and interrupted runs feed closed reason codes', async (t) => {
  const f = await fixture(t, { mode: 'pending' });
  await f.send(); // wait-request recovery action recorded on the member
  await f.call('interrupt', { ...f.actor(2), actor: 'parent', recovery_id: 'recovery-1', reason: 'timed_out', execution_state: 'unknown' });
  const result = await f.collect(['--include-qa', '--run', 'run-1']);
  const codes = Object.fromEntries(result.metrics.checks.reasons.map((entry) => [entry.code, entry.count]));
  assert.equal(codes['wait-request'], 1);
  assert.equal(codes['timed_out'], 1);
  assert.equal(result.metrics.attribution.run_kind, 'single');
  assert.ok(result.metrics.phases.run_record_span_ms >= 0);
});

test('legacy-marker runs are excluded from span fields and carry no run kind', async (t) => {
  const f = await executionProject(); t.after(f.cleanup);
  await writeLegacyExecution(f, { status: 'cancelled' });
  // Interrupting the v1 record is the producer of a v2 run with the legacy
  // marker; the collector must keep it out of run-kind attribution and spans.
  await f.call('interrupt', { change_id: f.id, run_id: 'legacy', actor: 'parent', version: 2,
    recovery_id: 'recovery-1', reason: 'timed_out', execution_state: 'unknown' });
  const result = await collectRunnerMetrics({ rootDir: f.root, argv: ['--change', f.id] });
  assert.equal(result.outcome, 'collected');
  assert.equal(result.metrics.provenance.runs_scanned, 1);
  assert.equal(result.metrics.attribution.runs, 1);
  assert.equal(result.metrics.attribution.coordinator, 'parent');
  assert.equal(result.metrics.attribution.role, 'fix');
  assert.equal(result.metrics.attribution.run_kind, null);
  assert.equal(result.metrics.phases.run_record_span_ms, null);
  assert.equal(result.metrics.phases.workers_span_sum_ms, null);
});

test('unreadable qa store degrades the checks block instead of guessing', async (t) => {
  const f = await fixture(t);
  const options = qaOptions(f);
  assert.equal((await prepareQaManifest(options)).ok, true);
  await recordQaResult({ ...options, gate: 'verify', resultId: 'qa-1', markdown: gateBody('verify').toString('utf8') });
  await f.put('.ai-factory/qa/work/results/broken.json', '{not json');
  const result = await f.collect(['--include-qa']);
  assert.equal(result.outcome, 'degraded');
  assert.ok(result.notes.some((note) => note.code === 'qa_results_unreadable'));
  assert.equal(result.metrics.checks, null);
  assert.equal(result.metrics.unknowns.includes('checks'), true);
  assert.equal(result.metrics.provenance.qa_results_scanned, null);
  // Without the opt-in the checks block is null by design, not by failure.
  const off = await f.collect();
  assert.equal(off.outcome, 'collected');
  assert.equal(off.metrics.checks, null);
});

test('absent qa store with opt-in is a measured zero, not unknown', async (t) => {
  const f = await fixture(t);
  const result = await f.collect(['--include-qa']);
  assert.equal(result.outcome, 'collected');
  assert.equal(result.metrics.checks.results, 0);
  assert.equal(result.metrics.unknowns.includes('checks'), false);
});

test('more than 64 dependency checks truncate deterministically with a note', () => {
  const records = [];
  for (let index = 0; index < 70; index += 1) {
    const checkId = `check-${String(index).padStart(2, '0')}`;
    records.push({ schema: 'aifhub.qa-result.v1', id: `r${index}`, check_id: checkId, gate: 'verify',
      manifest_digest: digest(`manifest-${index}`), wave_id: 'wave-1', supersedes: null, binding_code: null,
      input_fingerprints: { [checkId]: digest(`fingerprint-${index}`) } });
  }
  const notes = new Set();
  const checks = projectChecks(records, {}, notes);
  assert.equal(checks.results, 70);
  assert.equal(checks.dependencies.length, 64);
  assert.ok(notes.has('dependencies_truncated'));
  assert.equal(checks.dependencies[0].check_id, 'check-00');
  assert.equal(checks.dependencies[63].check_id, 'check-63');
});

test('parity: collector output passes schema, runtime validator, projection and export schema', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.send()).delivery_verified, true);
  const options = qaOptions(f);
  assert.equal((await prepareQaManifest(options)).ok, true);
  await recordQaResult({ ...options, gate: 'verify', resultId: 'qa-1', markdown: gateBody('verify').toString('utf8') });
  await recordQaResult({ ...options, gate: 'verify', resultId: 'qa-2', markdown: gateBody('verify').toString('utf8') });
  const { metrics } = await f.collect(['--include-qa']);
  const runnerSchema = JSON.parse(await readFile(new URL('../schemas/runner-metrics.schema.json', import.meta.url), 'utf8'));
  const evalSchema = JSON.parse(await readFile(new URL('../schemas/evaluation-export.schema.json', import.meta.url), 'utf8'));
  assert.deepEqual(validateJsonAgainstSchema(metrics, runnerSchema), []);
  const result = await exportEvaluation({
    rootDir: f.root, changeId: f.id, evidenceClass: 'maintainer_controlled', runnerMetrics: metrics,
    now: '2026-11-01T00:00:00.000Z'
  });
  assert.equal(result.outcome === 'exported' || result.outcome === 'degraded', true, JSON.stringify(result.errors));
  const record = result.evaluation;
  assert.deepEqual(validateJsonAgainstSchema(record, evalSchema), []);
  assert.equal(record.metrics.requests_total, 1);
  assert.equal(record.metrics.checks_repeated, 1);
  assert.deepEqual(record.metrics.checks_reasons, []);
  assert.equal(record.metrics.run_record_span_ms, metrics.phases.run_record_span_ms);
  assert.equal(record.metrics.coverage, 'delivery_registry+qa');
  assert.deepEqual(record.metrics.unknowns, metrics.unknowns);
  assert.equal(record.runtime.coordinator, 'parent');
  assert.equal(record.runtime.run_kind, 'single');
  const serialized = JSON.stringify(record);
  // Project-internal fields and paths never reach the public record.
  assert.equal(serialized.includes('check-verify'), false);
  assert.equal(serialized.includes(metrics.provenance.registry_digest), false);
  assert.equal(serialized.includes('openspec/'), false);
  assert.equal(serialized.includes('.ai-factory/'), false);
  assert.equal(serialized.includes('src/a.js'), false);
  // Privacy canaries against the collector's own file: locators and paths are
  // never projected into runner metrics either.
  const metricsSerialized = JSON.stringify(metrics);
  assert.equal(metricsSerialized.includes('worker-1'), false);
  assert.equal(metricsSerialized.includes('src/a.js'), false);
});

test('parity: old minimal snapshot stays valid, unknown keys rejected by both gates', async (t) => {
  const f = await fixture(t);
  const oldMinimal = { schema: 'aifhub.runner_metrics.v1', run_id: 'run-1', transport: { create_calls: 1, transport_ms: null } };
  const runnerSchema = JSON.parse(await readFile(new URL('../schemas/runner-metrics.schema.json', import.meta.url), 'utf8'));
  assert.deepEqual(validateJsonAgainstSchema(oldMinimal, runnerSchema), []);
  const exported = await exportEvaluation({ rootDir: f.root, changeId: f.id, evidenceClass: 'synthetic_fixture', runnerMetrics: oldMinimal, now: '2026-11-01T00:00:00.000Z' });
  assert.notEqual(exported.outcome, 'failed');
  const unknownKey = { ...oldMinimal, future_field: 1 };
  assert.ok(validateJsonAgainstSchema(unknownKey, runnerSchema).length > 0);
  const rejected = await exportEvaluation({ rootDir: f.root, changeId: f.id, evidenceClass: 'synthetic_fixture', runnerMetrics: unknownKey, now: '2026-11-01T00:00:00.000Z' });
  assert.equal(rejected.outcome, 'failed');
  assert.equal(rejected.errors[0].code, 'invalid_runner_metrics');
  // Divergence probes: schema and validator must agree on every probe so a
  // schema-only field cannot silently pass the export boundary.
  const probes = [
    { schema: 'aifhub.runner_metrics.v1', tokens: { input: 'lots' } },
    { ...oldMinimal, checks: { results: 1, reasons: [{ code: 'made-up-code', count: 1 }] } },
    { ...oldMinimal, unknowns: ['not_in_enum'] },
    { ...oldMinimal, coverage: 'everything' },
    { ...oldMinimal, checks: { results: 1, dependencies: [{ check_id: 'c', manifest_digest: 'nothex', wave_id: 'w', input_fingerprint: 'nothex' }] } }
  ];
  for (const probe of probes) {
    assert.ok(validateJsonAgainstSchema(probe, runnerSchema).length > 0, `schema must reject ${JSON.stringify(probe)}`);
    const outcome = await exportEvaluation({ rootDir: f.root, changeId: f.id, evidenceClass: 'synthetic_fixture', runnerMetrics: probe, now: '2026-11-01T00:00:00.000Z' });
    assert.equal(outcome.outcome, 'failed', `validator must reject ${JSON.stringify(probe)}`);
    assert.equal(outcome.errors[0].code, 'invalid_runner_metrics');
  }
});

test('non-interference: byte identity, no lock files, static dependency graph', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.send()).delivery_verified, true);
  const options = qaOptions(f);
  assert.equal((await prepareQaManifest(options)).ok, true);
  await recordQaResult({ ...options, gate: 'verify', resultId: 'qa-1', markdown: gateBody('verify').toString('utf8') });
  const state = await inventory(f.root, '.ai-factory/state');
  const qa = await inventory(f.root, '.ai-factory/qa');
  const canonicalFiles = await inventory(f.root, 'openspec');
  const result = await f.collect(['--include-qa']);
  assert.equal(result.outcome, 'collected');
  assert.deepEqual(withoutOutput(await inventory(f.root, '.ai-factory/state')), withoutOutput(state));
  assert.deepEqual(await inventory(f.root, '.ai-factory/qa'), qa);
  assert.deepEqual(await inventory(f.root, 'openspec'), canonicalFiles);
  for (const name of [...Object.keys(state), ...Object.keys(qa)]) {
    assert.equal(name.endsWith('.lock'), false, `unexpected lock file ${name}`);
  }
  // The collector must not import or call semantic mutators, hosts or writes
  // beyond the single guarded output file.
  const source = await readFile(new URL('./runner-metrics-collector.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /evaluateQaBinding|auditor|dispatchAudit|qa-bound-evidence/);
  assert.doesNotMatch(source, /HostClient|delivery-inspect|reserveDeliverySlot|prepareDelivery|deliverPreparedRequest|recoverDelivery/);
  assert.doesNotMatch(source, /\.lock\(|ensureRuntimeGitignore|\bstore\.(write|save|remove)\(|\bdelivery\.(write|save|remove|project)\(/);
});

test('output guard rejects control namespaces, unignored areas, backslashes and tracked paths', async (t) => {
  const f = await fixture(t);
  const stateBefore = await inventory(f.root, '.ai-factory/state');
  const rejects = [
    ['--output', `.ai-factory/state/${f.id}/execution/runs/metrics.json`],
    ['--output', `.ai-factory/state/${f.id}/delivery/metrics.json`],
    ['--output', `.ai-factory/state/${f.id}/status.json`],
    ['--output', 'metrics/runner-metrics.json'],
    ['--output', 'a\\b.json'],
    ['--output', '/absolute/path.json']
  ];
  for (const argv of rejects) {
    const result = await f.collect(argv);
    assert.equal(result.outcome, 'failed', JSON.stringify(argv));
    assert.equal(result.errors[0].code, 'runner_metrics_output_rejected', JSON.stringify(argv));
    assert.equal(result.written, null);
  }
  const tracked = await f.collect([], { trackedCheck: async () => true });
  assert.equal(tracked.outcome, 'failed');
  assert.equal(tracked.errors[0].code, 'runner_metrics_output_rejected');
  assert.deepEqual(await inventory(f.root, '.ai-factory/state'), stateBefore);
  const custom = await f.collect(['--output', `.ai-factory/state/${f.id}/runner-metrics.custom.json`]);
  assert.equal(custom.outcome, 'collected');
  assert.equal(custom.written, `.ai-factory/state/${f.id}/runner-metrics.custom.json`);
});

test('existing output never changes a qa snapshot digest; reruns are idempotent', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'runner-metrics-git-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3 }));
  const git = async (args) => exec('git', args, { cwd: root });
  await mkdir(path.join(root, 'src'), { recursive: true });
  await mkdir(path.join(root, 'openspec', 'changes', 'work'), { recursive: true });
  await mkdir(path.join(root, '.ai-factory'), { recursive: true });
  await writeFile(path.join(root, '.gitignore'), '.ai-factory/\n');
  await writeFile(path.join(root, 'src', 'a.js'), 'source\n');
  await writeFile(path.join(root, 'openspec', 'changes', 'work', 'proposal.md'), '# Proposal\n');
  await writeFile(path.join(root, 'openspec', 'changes', 'work', 'tasks.md'), '- [ ] 1.1 Task\n');
  await writeFile(path.join(root, '.ai-factory', 'config.yaml'), 'aifhub:\n  tools:\n    openspec: true\n');
  await git(['init', '--initial-branch=main']);
  await git(['config', 'user.email', 'fixture@example.com']);
  await git(['config', 'user.name', 'fixture']);
  await git(['add', '.']);
  await git(['commit', '-m', 'init']);
  const toolchain = [{ name: 'fixture-node', sha256: digest('node') }];
  const check = { id: 'check-verify', gate: 'verify', profile: 'declared.v1', dependencies_complete: true, inputs: ['src'],
    command: { argv: ['fake'], cwd: '.' }, toolchain, env_inputs: [], requires_observed: false };
  const options = { rootDir: root, changeId: 'work', scope: ['src'], checks: [check], environment: {},
    providers: { requirements: async () => ({ gates: ['verify'], independent_roles: [], evidence: [] }), toolchain: async () => toolchain } };
  assert.equal((await prepareQaManifest(options)).ok, true, 'qa enrollment needs a real git worktree');
  const store = await qaStore(options);
  const manifest = await store.manifest();
  const first = await collectRunnerMetrics({ rootDir: root, argv: ['--change', 'work'] });
  assert.equal(first.outcome, 'collected');
  const outputPath = path.join(root, '.ai-factory', 'state', 'work', 'runner-metrics.json');
  const firstBytes = await readFile(outputPath);
  // With the output file in place, repeated snapshots are stable and binding
  // fingerprints (the material inputs) are byte-identical to the enrollment.
  const snapshotA = await observeQaSnapshot(store, manifest.payload);
  const fingerprints = await checkFingerprints(manifest.payload, snapshotA, options);
  assert.deepEqual(fingerprints, manifest.payload.fingerprints);
  const second = await collectRunnerMetrics({ rootDir: root, argv: ['--change', 'work'] });
  assert.equal(second.outcome, 'collected');
  assert.deepEqual(await readFile(outputPath), firstBytes);
  const snapshotB = await observeQaSnapshot(store, manifest.payload);
  assert.equal(snapshotB.digest, snapshotA.digest);
  const stateNow = await inventory(root, '.ai-factory/state');
  const third = await collectRunnerMetrics({ rootDir: root, argv: ['--change', 'work', '--include-qa'] });
  assert.equal(third.outcome, 'collected');
  assert.deepEqual(withoutOutput(await inventory(root, '.ai-factory/state')), withoutOutput(stateNow));
});

test('invalid argv fails closed with exit 2 and no output file', async (t) => {
  const f = await deliveryProject(t); t.after(f.cleanup);
  for (const argv of [['--bogus'], ['--change'], [], ['--change', f.id, '--change', f.id], ['--change', '../escape'], ['--change', f.id, '--run', 'bad run']]) {
    const exit = await runCollectorCommand(argv, { rootDir: f.root, stdout: { write: () => {} } });
    assert.equal(exit, 2, JSON.stringify(argv));
  }
  const exit = await runCollectorCommand(['--include-qa'], { rootDir: f.root, stdout: { write: () => {} } });
  assert.equal(exit, 2);
  const state = await inventory(f.root, '.ai-factory/state');
  assert.equal(Object.keys(state).some((name) => name.includes('runner-metrics')), false);
});
