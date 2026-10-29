import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, rm } from 'node:fs/promises';
import { deliveryProject } from './fixtures/delivery-project.mjs';
import { createFakeHost } from './fixtures/host-delivery.mjs';
import { createGateResult, renderGateResultBlock } from './aif-gate-result.mjs';
import { digest } from './workflow-state-store.mjs';
import { deliveryPaths, deliveryStore, validateDeliveryRequest, DELIVERY_LIMITS } from './host-delivery-store.mjs';
import { deliveryTransportInput } from './host-delivery.mjs';
import { prepareQaManifest, recordQaResult, publishQaManifest } from './qa-manifest.mjs';
import { qaStore } from './qa-manifest-store.mjs';
import { allDeclaredRoots } from './qa-manifest-inputs.mjs';

const uuid = 'cb737dd1-3484-4e53-93dd-3cd0d1c13da9';
const gateBody = (gate = 'security', status = 'pass') => Buffer.from('\uFEFFРусский English 😀 e\u0301 &|<>^%! " ` $()\r\n' + renderGateResultBlock(createGateResult({ gate, status,
  blockers: status === 'fail' ? [{ id: 'fixture', severity: 'error', summary: 'finding' }] : [], affectedFiles: [],
  suggestedNext: status === 'fail' ? { command: '/aif-fix', reason: 'fix' } : null })) + '\r\n');
async function fixture(t, { mode, body = gateBody(), status = 'completed', host: suppliedHost } = {}) {
  const f = await deliveryProject(t); t.after(f.cleanup);
  const input = { change_id: f.id, run_id: 'run-1', request_uuid: uuid };
  const target = { kind: 'completion', locator: 'worker-1' };
  const host = suppliedHost ?? createFakeHost({ mode });
  const report = '.ai-factory/evidence/work/security.md';
  await f.put(report, body);
  await f.call('start', f.start());
  await f.call('delivery-reserve', { ...input, target });
  await f.call('result', f.actor(1, { result: { result_id: 'result-1', status, changed_files: [], checks: [{ name: 'offline-fixture', exit_code: 0 }], evidence: [report] } }));
  const options = { HostClient: host };
  const prepare = (extra = {}, opts = {}) => f.call('delivery-prepare', { ...input, gate: 'security', body, ...extra }, opts);
  const send = (extra = {}, opts = {}) => f.call('delivery-send', { ...input, ...extra }, { ...options, ...opts });
  const recover = (extra = {}, opts = {}) => f.call('delivery-recover', { ...input, ...extra }, { ...options, ...opts });
  const s = await deliveryStore({ rootDir: f.root });
  return { ...f, input, target, body, host, report, prepare, send, recover, s, paths: deliveryPaths(f.id, uuid), record: () => s.loadRequest(f.id, uuid) };
}
const resend = result => ({ recovery_action: { type: 'resend-same-request', request_uuid: uuid, preconditions: result.resend_preconditions } });

test('AC1/2/4/6: lost commit response is fetched; repeated helpers never re-audit or duplicate', async t => {
  const f = await fixture(t, { mode: 'after-commit' }); await f.prepare();
  const before = await f.get(`${f.paths.folder}/runs/run-1.json`);
  let audits = 0;
  const spy = () => { audits++; throw new Error('auditor forbidden'); };
  const result = await f.send({}, { auditor: spy, evaluateQaBinding: spy });
  assert.equal(result.delivery_verified, true); assert.deepEqual(result.authorizes, []);
  const repeated = await f.recover({}, { auditor: spy, evaluateQaBinding: spy });
  assert.equal(repeated.delivery_verified, true); assert.equal(audits, 0);
  assert.equal(f.host.state.completions.length, 1); assert.equal(f.host.state.counters.create_calls, 1);
  assert.equal(await f.get(`${f.paths.folder}/runs/run-1.json`), before);
  assert.deepEqual(f.host.state.responses.get(uuid), f.body);
  assert.deepEqual(f.host.state.trace.map(x => x[0]), ['read', 'create', 'read', 'fetch', 'read', 'fetch']);
  const p = JSON.parse(await f.get(f.paths.projection)); assert.equal(p.schema, 'aifhub.delivery.v1'); assert.equal(p.checksum, undefined);
});
test('AC1: before-commit not_found is uncertain until explicit proven resend of original bytes', async t => {
  const f = await fixture(t, { mode: 'before-commit' }); await f.prepare();
  const result = await f.send();
  assert.equal(result.delivery_verified, false); assert.equal(result.recovery_action.type, 'reconcile-host-state');
  assert.equal(result.retry_create_allowed, true); assert.equal(f.host.state.completions.length, 0);
  f.host.mode = 'normal';
  assert.equal((await f.recover()).delivery_verified, false); // recovery alone cannot authorize a retry
  const done = await f.recover(resend(result)); assert.equal(done.delivery_verified, true);
  assert.equal(f.host.state.counters.create_calls, 2); assert.equal(f.host.state.completions.length, 1);
  assert.equal(done.runner_metrics.transport.retry_creates, 1);
});
test('AC1: pending is read once per recovery; no polling/create while waiting', async t => {
  const f = await fixture(t, { mode: 'pending' }); await f.prepare();
  const first = await f.send(); assert.equal(first.query_state, 'pending'); assert.equal(first.recovery_action.type, 'wait-request');
  await f.recover(); assert.equal(f.host.state.counters.create_calls, 1);
  f.host.complete(uuid); assert.equal((await f.recover()).delivery_verified, true);
});
for (const mode of ['temporary-body', 'missing-body']) test(`AC1/5: completed body unavailable (${mode}) does not mean received`, async t => {
  const f = await fixture(t, { mode }); await f.prepare();
  const r = await f.send(); assert.equal(r.host_state, 'completed'); assert.equal(r.query_state, 'unknown');
  assert.equal(r.recovery_action.type, 'fetch-response'); assert.equal(r.reservation_retained, true);
  assert.equal((await f.recover()).delivery_verified, mode === 'temporary-body');
  assert.equal(f.host.state.counters.create_calls, 1);
});
for (const mode of ['lost-index', 'lost-all']) test(`AC2: ${mode} distinguishes index loss and deduplication loss`, async t => {
  const f = await fixture(t, { mode }); await f.prepare();
  const r = await f.send(); assert.equal(r.delivery_verified, false);
  if (mode === 'lost-index') {
    assert.equal(r.retry_create_allowed, true); f.host.mode = 'normal';
    assert.equal((await f.recover(resend(r))).delivery_verified, true);
    assert.equal(f.host.state.counters.create_calls, 2);
  } else {
    assert.equal(r.retry_create_allowed, false); assert.equal((await f.recover()).recovery_action.type, 'reconcile-host-state');
    assert.equal(f.host.state.counters.create_calls, 1);
  }
  assert.equal(f.host.state.completions.length, 1);
});
for (const missing of ['idempotent_create', 'read_by_request_id', 'fetch_response']) test(`AC5: missing ${missing} prevents all creates and retains scope`, async t => {
  const host = createFakeHost({ capabilities: { [missing]: false } });
  const f = await fixture(t, { host }); await f.prepare();
  const r = await f.send(); assert.equal(r.recovery_action.type, 'provide-capabilities'); assert.equal(r.reservation_retained, true);
  assert.equal(host.state.counters.create_calls, 0);
  await assert.rejects(f.call('start', f.start({ run_id: 'overlap' })), { code: 'scope-reserved' });
});
test('AC2: changed body/target/binding blocks before mutation, permanently', async t => {
  for (const extra of [{ body: 'other body' }, { target: { kind: 'message', locator: 'worker-1' } }, { binding: {} }]) {
    const f = await fixture(t); await f.prepare();
    const r = await f.send(extra); assert.equal(r.code, 'delivery-identity-conflict'); assert.equal(r.state, 'blocked');
    assert.equal((await f.recover()).state, 'blocked'); assert.equal(f.host.state.counters.create_calls, 0);
  }
});
for (const mode of ['conflicting-payload', 'wrong-target', 'wrong-namespace', 'changed-body']) test(`host ${mode} blocks verification`, async t => {
  const f = await fixture(t, { mode }); await f.prepare();
  const r = await f.send(); assert.equal(r.state, 'blocked'); assert.equal(r.delivery_verified, false);
  assert.equal(f.host.state.completions.length, 1);
});
test('trusted host ID remapping after verification blocks further use', async t => {
  const f = await fixture(t); await f.prepare(); assert.equal((await f.send()).delivery_verified, true);
  f.host.mode = 'wrong-mapping'; assert.equal((await f.recover()).state, 'blocked');
});
test('forged delivery received/ack cannot verify an unobserved request', async t => {
  const f = await fixture(t); await f.prepare();
  const projection = JSON.parse(await f.get(f.paths.projection)); projection.query_state = 'received'; projection.ack = true;
  await f.put(f.paths.projection, JSON.stringify(projection));
  const inspected = await f.call('delivery-inspect', f.input, { HostClient: f.host });
  assert.equal(inspected.delivery_verified, false); assert.equal(inspected.query_state, 'unknown');
  assert.equal(f.host.state.counters.create_calls, 0);
});
for (const status of ['fail', 'warn']) test(`delivery of gate ${status} never creates semantic authority`, async t => {
  const f = await fixture(t, { body: gateBody('security', status), status: 'failed' }); await f.prepare();
  const r = await f.send(); assert.equal(r.delivery_verified, true); assert.deepEqual(r.authorizes, []);
  assert.equal(r.runner_metrics.verified_success, undefined);
});
test('strict final gate rejects invalid/wrong/unclosed suffix, no old PASS fallback', async t => {
  for (const suffix of ['```aif-gate-result\n{}', '```aif-gate-result\n{bad}\n```', gateBody('rules').toString('utf8')]) {
    const f = await fixture(t, { body: Buffer.concat([gateBody(), Buffer.from(suffix)]) });
    await assert.rejects(f.prepare(), { code: 'invalid-gate-evidence' }); assert.equal(f.host.state.counters.create_calls, 0);
  }
});
test('checksummed forged nested state and changed projection identity are rejected', async t => {
  const f = await fixture(t); await f.prepare(); const r = await f.record();
  r.identity.body_sha256 = digest('forged');
  await f.s.save(f.paths.request, r); await f.s.save(f.paths.journal, { schema: 'aifhub.delivery-journal.v1', request_uuid: uuid, record_digest: digest(r), record: r });
  await assert.rejects(f.send(), { code: 'invalid-delivery-state' });
  assert.throws(() => validateDeliveryRequest({ ...r, phase: 'invented' }));
});
test('freshness owners still reject changed evidence/source; recovery does not accept', async t => {
  const f = await fixture(t); await f.prepare(); await f.send();
  await f.put(f.report, 'changed'); await assert.rejects(f.recover(), { code: 'stale-evidence' });
  await f.put(f.report, f.body); await f.put('openspec/changes/work/proposal.md', '# changed source\n');
  await assert.rejects(f.recover(), { code: 'stale-context' });
});
for (const terminal of ['interrupted', 'closed']) test(`${terminal}: only historical inspect, no new completion/closure`, async t => {
  const f = await fixture(t); await f.prepare();
  const run = await f.s.load(`${f.paths.folder}/runs/run-1.json`);
  if (terminal === 'closed') await f.call('accept', { ...f.actor(2), actor: 'parent', result_digest: run.result.digest });
  else await f.call('interrupt', { ...f.actor(2), actor: 'parent', recovery_id: 'recovery-1', reason: 'timed_out', execution_state: 'unknown' });
  const before = await f.get(`${f.paths.folder}/runs/run-1.json`);
  const result = await f.recover(); assert.equal(result.historical, true); assert.equal(result.code, 'delivery-historical-only');
  const inspected = await f.call('delivery-inspect', f.input, { HostClient: f.host });
  assert.equal(inspected.historical, true); assert.deepEqual(inspected.authorizes, []);
  assert.equal(f.host.state.completions.length, 0); assert.equal(await f.get(`${f.paths.folder}/runs/run-1.json`), before);
});
test('concurrent helpers cannot lose revision/counters; locked loser can retry', async t => {
  const f = await fixture(t); await f.prepare();
  const results = await Promise.allSettled([f.send(), f.recover()]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.find(r => r.status === 'rejected').reason.code, 'state-locked');
  const before = await f.record(); await f.recover(); const after = await f.record();
  assert.ok(after.revision > before.revision); assert.equal(after.transport.read_calls, before.transport.read_calls + 1);
  assert.equal(after.transport.create_calls, 1); assert.equal(f.host.state.completions.length, 1);
});

const failpoints = ['before-body-write', 'after-body-write', 'before-prepare-journal', 'after-prepare-journal', 'after-registry-write',
  'before-send-intent', 'after-send-intent', 'before-host-create', 'after-host-commit', 'after-host-response', 'after-host-read',
  'after-response-fetch', 'before-verified-write', 'after-verified-write', 'before-delivery-projection', 'after-delivery-projection'];
for (const point of failpoints) test(`restart after ${point} preserves frozen evidence and at most one commit`, async t => {
  let armed = false, hits = 0;
  const failpoint = name => { if (armed && name === point && hits++ === 0) throw new Error(`crash:${point}`); };
  const host = createFakeHost({ failpoint });
  const f = await fixture(t, { host });
  const runBefore = await f.get(`${f.paths.folder}/runs/run-1.json`);
  armed = true;
  const prep = ['before-body-write', 'after-body-write', 'before-prepare-journal', 'after-prepare-journal', 'after-registry-write'].includes(point);
  try { await f.prepare({}, prep ? { failpoint } : {}); if (!prep) await f.send({}, { failpoint }); } catch (e) { assert.match(e.message, /crash:/); }
  armed = false;
  await f.prepare();
  let result = await f.recover();
  if (!result.delivery_verified && result.retry_create_allowed) result = await f.recover(resend(result));
  assert.equal(result.delivery_verified, true, JSON.stringify(result)); assert.ok(hits > 0);
  assert.equal(host.state.completions.length, 1); assert.equal(await f.get(`${f.paths.folder}/runs/run-1.json`), runBefore);
});
test('AC3: large file descriptor preserves original bytes and invalid UTF-8/size fail closed', async t => {
  const body = Buffer.concat([Buffer.alloc(1100000, 65), gateBody()]);
  const f = await fixture(t, { body });
  const file = { path: f.report, sha256: digest(body), byte_length: body.length, encoding: 'utf-8' };
  await f.prepare({ body: undefined, body_file: file }); assert.equal((await f.send()).delivery_verified, true);
  assert.deepEqual(f.host.state.responses.get(uuid), body);
  await assert.rejects(f.prepare({ body: Buffer.from([0xff]) }), { code: 'invalid-utf8' });
  assert.throws(() => deliveryTransportInput({ body: Buffer.alloc(DELIVERY_LIMITS.body + 1) }, {}), { code: 'delivery-body-too-large' });
  await assert.rejects(f.s.write('too-big', Buffer.alloc(DELIVERY_LIMITS.body + 1)), { code: 'state-too-large' });
  await assert.rejects(f.prepare({ body: undefined, body_file: { ...file, sha256: digest('wrong') } }), { code: 'delivery-body-mismatch' });
});
test('delivery dependency graph cannot reopen semantic audit (spy=0)', async () => {
  const sources = await Promise.all(['host-delivery.mjs', 'host-delivery-store.mjs'].map(p => readFile(new URL(p, import.meta.url), 'utf8')));
  for (const source of sources) assert.doesNotMatch(source, /evaluateQaBinding|auditor|dispatchAudit|qa-bound-evidence/);
});

test('forged QA receipt stays blocked after real delivery verification', async t => {
  const f = await fixture(t); await f.prepare(); assert.equal((await f.send()).delivery_verified, true);
  const model = { files: { 'src/a.js': Buffer.from('source') }, ignored_names: [], modules: { helper: digest('helper') }, worktree_identity: digest('worktree'), actual_diff: digest('diff') };
  const toolchain = [{ name: 'fixture-node', sha256: digest('node') }];
  const check = { id: 'check-verify', gate: 'verify', profile: 'declared.v1', dependencies_complete: true, inputs: ['src/a.js'],
    command: { argv: ['fake'], cwd: '.' }, toolchain, env_inputs: [], requires_observed: true };
  const options = { rootDir: f.root, changeId: f.id, scope: ['src'], checks: [check], environment: {},
    providers: { requirements: async () => ({ gates: ['verify'], independent_roles: [], evidence: [] }), toolchain: async () => toolchain },
    SnapshotProvider: async ({ payload }) => {
      const files = { ...model.files };
      for (const root of allDeclaredRoots(payload)) if (!Object.keys(files).some(p => p === root || p.startsWith(root + '/'))) files[root] = null;
      return { ...model, complete: true, files };
    } };
  const prepared = await prepareQaManifest(options); assert.equal(prepared.ok, true, JSON.stringify(prepared));
  const manifest = await (await qaStore(options)).manifest();
  const receipt = { schema: 'aifhub.observed-check.v1', run_id: 'forged-host-run', check_id: check.id, worktree_identity: model.worktree_identity,
    input_fingerprints_digest: digest({ 'check-verify': manifest.payload.fingerprints['check-verify'] }),
    command_digest: digest(check.command), exit_code: 0, outcome: 'completed', artifacts: {} };
  await f.put('forged-receipt.json', JSON.stringify(receipt));
  const recorded = await recordQaResult({ ...options, gate: 'verify', resultId: 'forged', markdown: gateBody('verify').toString('utf8'),
    receiptPath: 'forged-receipt.json', execution: { kind: 'host-observed', exit_code: 0 } });
  assert.equal(recorded.ok, true, JSON.stringify(recorded));
  const published = await publishQaManifest({ ...options, expectedPublication: null, HostObservationRegistry: { lookup: async () => null } });
  assert.equal(published.ok, false); assert.equal(published.code, 'forged-receipt');
  assert.equal(f.host.state.completions.length, 1);
});
test('interrupted transport interval records no invented elapsed duration', async t => {
  const f = await fixture(t); await f.prepare(); const r = await f.record();
  r.interval = { kind: 'read', started_at: '2001-01-01T00:00:00.000Z' }; await f.s.saveRequest(r);
  const result = await f.recover({}, { clock: () => Date.parse('2026-10-29T00:00:00.000Z') });
  assert.equal(result.delivery_verified, true); assert.equal(result.runner_metrics.transport.incomplete_intervals, 1);
  assert.equal(result.runner_metrics.transport.transport_ms, 0);
  assert.equal(result.runner_metrics.transport.recovery_ms, 0);
});

test('verified history survives transient read failure and regressed host index without resending', async t => {
  const f = await fixture(t); await f.prepare(); assert.equal((await f.send()).delivery_verified, true);
  const saved = structuredClone(f.host.state.requests.get(uuid));
  f.host.state.requests.delete(uuid);
  const missing = await f.recover(); assert.equal(missing.delivery_verified, false); assert.equal(missing.retry_create_allowed, false);
  assert.equal((await f.record()).phase, 'verified');
  f.host.state.requests.set(uuid, { ...saved, state: 'pending' });
  const pending = await f.recover(); assert.equal(pending.code, 'delivery-host-state-regressed'); assert.equal((await f.record()).phase, 'verified');
  f.host.state.requests.set(uuid, saved);
  assert.equal((await f.recover()).delivery_verified, true); assert.equal(f.host.state.counters.create_calls, 1);
});
test('caller cannot rebind prepare/run/task or manufacture host acknowledgement fields', async t => {
  const f = await fixture(t); await f.prepare();
  assert.equal((await f.send({ run_id: 'other-run' })).code, 'delivery-identity-conflict');
  const g = await fixture(t); await g.prepare();
  assert.equal((await g.prepare({ body: 'conflicting-body' })).state, 'blocked');
  await assert.rejects(g.send({ ack: true }), { code: 'invalid-input' });
  assert.equal(g.host.state.counters.create_calls, 0);
});

test('reserve replay materializes the registry when the journal survived without it', async t => {
  const f = await fixture(t, { mode: 'after-commit' }); await f.prepare();
  const requestPath = `.ai-factory/state/${f.id}/execution/requests/${uuid}.json`;
  await rm(f.root + '/' + requestPath);
  const replay = await f.call('delivery-reserve', { change_id: f.id, run_id: 'run-1', task_id: '1.1', request_uuid: uuid, target: { kind: 'completion', locator: 'worker-1' } });
  assert.equal(replay.ok, true, JSON.stringify(replay));

  const saved = JSON.parse(await f.get(requestPath));
  assert.equal(saved.record.phase, 'prepared');
  const replayed = await f.call('delivery-reserve', { change_id: f.id, run_id: 'run-1', task_id: '1.1', request_uuid: uuid, target: { kind: 'completion', locator: 'worker-1' } });
  assert.equal(replayed.ok, true);
});
