import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deliveryProject } from './fixtures/delivery-project.mjs';
import { executionProject } from './fixtures/execution-project.mjs';
import { createFakeHost } from './fixtures/host-delivery.mjs';
import { createGateResult, renderGateResultBlock } from './aif-gate-result.mjs';
import { storeFor, digest } from './workflow-state-store.mjs';
import { deliveryStore, deliveryPaths, validateDeliveryRequest, RECOVERY_ACTION_TYPES, DELIVERY_LIMITS } from './host-delivery-store.mjs';
import { NEXT_ACTION_TYPES, validateNextAction } from './host-lifecycle.mjs';
import { parseExecutionTasks } from './execution-task-source.mjs';
import { lifecyclePaths } from './host-lifecycle-store.mjs';

const uuid = n => `cb737dd1-3484-4e53-93dd-${String(n).padStart(12, '0')}`;
const runInput = { change_id: 'work', run_id: 'run-1', actor: 'parent' };
const decision = (outcome = 'settled') => ({ actor: 'parent', outcome, decided_at: '2026-10-31T00:00:00.000Z' });
const body = Buffer.from('\uFEFFРусский 😀 &|<>^%! ` $()\r\n' + renderGateResultBlock(createGateResult({ gate: 'security', status: 'pass', blockers: [], affectedFiles: [], suggestedNext: null })) + '\r\n');
async function fixture(t, options) {
  const f = await deliveryProject(t, options); t.after(f.cleanup); return f;
}
async function single(t, { mode = 'openspec', pending = false, count = 1, plans } = {}) {
  const f = await fixture(t, { mode, plans }), host = createFakeHost({ mode: pending ? 'pending' : 'normal', capabilities: { release_after_verify: true } });
  const report = '.ai-factory/evidence/work/security.md'; await f.put(report, body);
  await f.call('start', f.start());
  for (let i = 1; i <= count; i++) await f.call('delivery-reserve', { change_id: 'work', run_id: 'run-1', request_uuid: uuid(i), target: { kind: 'completion', locator: `worker-${i}` } });
  const result = await f.call('result', f.actor(1, { result: { result_id: 'result-1', status: 'completed', changed_files: [], checks: [{ name: 'fixture', exit_code: 0 }], evidence: [report] } }));
  for (let i = 1; i <= count; i++) {
    await f.call('delivery-prepare', { change_id: 'work', run_id: 'run-1', request_uuid: uuid(i), gate: 'security', body });
    await f.call('delivery-send', { change_id: 'work', run_id: 'run-1', request_uuid: uuid(i) }, { HostClient: host });
  }
  const close = () => f.call('accept', { ...runInput, version: result.version, result_digest: result.result_digest });
  return { ...f, host, result, close, report, record: () => deliveryStore({ rootDir: f.root }).then(s => s.loadRequest('work', uuid(1))) };
}
async function batch(t, { mode = 'openspec', n = 2, accept = n } = {}) {
  const f = await fixture(t, { mode }), checklist = Array.from({ length: n }, (_, i) => `- [ ] 1.${i + 1} Task ${i + 1}\n`).join('');
  if (mode === 'classic') {
    await f.put(`${f.plans}/work.md`, '# Plan\n\n' + checklist); await f.put(`${f.plans}/work/task.md`, checklist);
  } else await f.put('openspec/changes/work/tasks.md', checklist);
  const preflight = '.ai-factory/evidence/preflight.md'; await f.put(preflight, 'Independent same-shape files.');
  const manifest = Array.from({ length: n }, (_, i) => ({ task_id: `1.${i + 1}`, files: [`src/${String.fromCharCode(97 + i)}.js`], expected_change: 'Mechanical item', check: 'fixture', dependencies: [] }));
  const start = { change_id: 'work', run_id: 'run-1', owner: 'parent', worker: 'worker', role: 'implement', manifest, preflight_paths: [preflight] };
  await f.call('batch-start', start);
  const evidence = Object.fromEntries(manifest.map(i => [i.task_id, [preflight]]));
  const seal = await f.call('batch-seal', f.actor(1, { evidence })); let version = seal.version;
  for (let i = 0; i < n; i++) {
    const result = await f.call('batch-result', f.actor(version, { task_id: manifest[i].task_id, seal_digest: seal.seal_digest,
      result: { result_id: `result-${i}`, status: 'completed', changed_files: [], checks: [{ name: 'fixture', exit_code: 0 }], evidence: [preflight] } }));
    version = result.version;
    if (i < accept) version = (await f.call('batch-accept', { ...runInput, version, task_id: manifest[i].task_id, seal_digest: seal.seal_digest, result_digest: result.result_digest })).version;
  }
  const closed = await f.call('batch-close', { ...runInput, version, seal_digest: seal.seal_digest });
  return { ...f, closed, manifest };
}
const assertSafe = result => { assert.deepEqual(result.authorizes, []); assert.equal(typeof result.manual_path.wait, 'string'); assert.equal(typeof result.manual_path.release, 'string'); assert.ok(Array.isArray(result.capability_limitations)); validateNextAction(result.next_action); };

test('AC1/6: single collect uses one history/transaction scan, no implicit transitions or host reads', async t => {
  const f = await single(t, { pending: true });
  const runBefore = await f.get('.ai-factory/state/work/execution/runs/run-1.json'), counters = {};
  const local = await f.call('lifecycle-collect', { change_id: 'work', include_all: true }, { counters });
  assertSafe(local); assert.equal(local.state, 'waiting'); assert.equal(local.members.length, 2);
  assert.equal(counters.history_scans, 1); assert.equal(counters.transaction_scans, 1); assert.equal(counters.host_reads, 0);
  assert.equal(await f.get('.ai-factory/state/work/execution/runs/run-1.json'), runBefore);
  const host = await f.call('lifecycle-collect', { change_id: 'work', members: [{ request_uuid: uuid(1) }], read_host: true }, { HostClient: f.host });
  assert.equal(host.state, 'waiting'); assert.equal(host.next_action.recovery_type, 'wait-request'); assert.equal(host.service_calls.host_reads, 1); assertSafe(host);
  f.host.complete(uuid(1));
  const completed = await f.call('lifecycle-collect', { change_id: 'work', members: [{ request_uuid: uuid(1) }], read_host: true }, { HostClient: f.host });
  assert.equal(completed.members[0].host_state, 'completed'); assert.equal(completed.next_action.recovery_type, 'fetch-response');
  assert.notEqual((await f.record()).phase, 'verified'); // observation is not byte verification
});

test('AC1/2: settlement preserves exact decision/bindings and receipts, replay is historical, conflicting decision blocks', async t => {
  const f = await single(t); await f.close();
  const before = await f.get('.ai-factory/state/work/execution/runs/run-1.json');
  const input = { ...runInput, decision: decision(), deliveries: { '1.1': uuid(1) } };
  let audits = 0;
  const result = await f.call('lifecycle-settle', input, { auditor: () => { audits++; } }); assertSafe(result);
  assert.equal(result.ok, true); assert.deepEqual(result.settlement.decision, input.decision);
  assert.deepEqual(result.settlement.binding.accepted, ['1.1']); assert.equal(result.settlement.deliveries['1.1'].request_uuid, uuid(1));
  assert.equal(audits, 0); assert.equal(await f.get('.ai-factory/state/work/execution/runs/run-1.json'), before);
  assert.equal((await f.call('lifecycle-settle', input)).historical, true);
  assert.equal((await f.call('lifecycle-settle', { ...input, decision: decision('rejected') })).code, 'conflicting-settlement');
  assert.equal((await f.call('lifecycle-settle', { ...input, actor: 'other' })).code, 'actor-mismatch');
});

test('AC2: green checks cannot settle active run; stale evidence/context/checkpoint blocks settlement', async t => {
  const f = await single(t), input = { ...runInput, decision: decision() };
  assert.equal((await f.call('lifecycle-settle', input)).code, 'lifecycle-closed-run-required');
  await f.close();
  for (const [name, value, code] of [[f.report, 'changed evidence', 'stale-evidence'], ['src/a.js', 'changed worktree', 'stale-checkpoint'], ['openspec/changes/work/proposal.md', '# Changed', 'stale-context']]) {
    const before = await f.get(name); await f.put(name, value);
    assert.equal((await f.call('lifecycle-settle', input)).code, code); await f.put(name, before);
  }
});

test('AC2/5: concurrent parent settlement uses owner gate and journal CAS', async t => {
  const f = await single(t); await f.close(); const input = { ...runInput, decision: decision() };
  let unblock, entered; const ready = new Promise(r => { entered = r; }), held = new Promise(r => { unblock = r; });
  const first = f.call('lifecycle-settle', input, { failpoint: async name => { if (name === 'lifecycle-after-journal') { entered(); await held; } } });
  await ready;
  const competing = await f.call('lifecycle-settle', { ...input, decision: decision('partial') }); assert.equal(competing.code, 'state-locked');
  unblock(); assert.equal((await first).ok, true);
  assert.equal((await f.call('lifecycle-settle', { ...input, decision: decision('partial') })).code, 'conflicting-settlement');
  assert.equal((await f.call('lifecycle-settle', { ...input, actor: 'other' })).code, 'actor-mismatch');
});

test('AC3: release requires verified custody, fresh completed identity and optional capabilities', async t => {
  const f = await single(t, { pending: true }), input = { ...runInput, request_uuid: uuid(1) };
  assert.equal((await f.call('lifecycle-release', input, { HostClient: f.host })).code, 'lifecycle-verified-delivery-required');
  f.host.complete(uuid(1)); await f.call('delivery-recover', { change_id: 'work', run_id: 'run-1', request_uuid: uuid(1) }, { HostClient: f.host });
  const noAdapter = await f.call('lifecycle-release', input); assert.equal(noAdapter.code, 'lifecycle-capabilities-required'); assertSafe(noAdapter);
  f.host.capabilitiesOverride.release_after_verify = false;
  assert.equal((await f.call('lifecycle-release', input, { HostClient: f.host })).code, 'lifecycle-capabilities-required');
  f.host.capabilitiesOverride.release_after_verify = true;
  const found = f.host.state.requests.get(uuid(1)); found.state = 'pending';
  assert.equal((await f.call('lifecycle-release', input, { HostClient: f.host })).code, 'delivery-host-state-regressed');
  found.state = 'completed';
  const before = await f.get('.ai-factory/state/work/execution/runs/run-1.json');
  const released = await f.call('lifecycle-release', input, { HostClient: f.host }); assert.equal(released.state, 'released'); assertSafe(released);
  assert.equal(released.reservation_retained, true); assert.equal(await f.get('.ai-factory/state/work/execution/runs/run-1.json'), before);
  const calls = f.host.state.trace.length;
  assert.equal((await f.call('lifecycle-release', input)).replay, true); assert.equal(f.host.state.trace.length, calls);
  assert.equal((await f.record()).release.host_release_state, 'released');
});

for (const mode of ['wrong-target', 'wrong-namespace', 'wrong-mapping', 'conflicting-payload']) test(`AC3: release rejects ${mode} without host mutation`, async t => {
  const f = await single(t); f.host.mode = mode;
  const result = await f.call('lifecycle-release', { ...runInput, request_uuid: uuid(1) }, { HostClient: f.host });
  assert.equal(result.ok, false); assert.equal(f.host.state.counters.release_calls ?? 0, 0); assert.equal(result.reservation_retained, true);
});

test('AC3: interrupted unknown worker retains reservation; release never performs stop-confirm', async t => {
  const f = await single(t, { pending: true });
  await f.call('interrupt', { ...runInput, version: 2, recovery_id: 'recover-1', reason: 'abandoned', execution_state: 'unknown' });
  const result = await f.call('lifecycle-collect', { change_id: 'work', members: [{ run_id: 'run-1' }] });
  assert.equal(result.state, 'uncertain'); assert.equal(result.reservation_retained, true); assert.equal(result.next_action.type, 'manual');
  assert.equal((await f.call('lifecycle-release', { ...runInput, request_uuid: uuid(1) }, { HostClient: f.host })).ok, false);
});

test('AC4: partial batch progress changes exactly accepted tasks; caller cannot supply a task set', async t => {
  const f = await batch(t, { n: 5, accept: 4 });
  assert.equal((await f.call('lifecycle-collect', { change_id: 'work', members: [{ run_id: 'run-1' }] })).state, 'partial');
  const runBefore = await f.get('.ai-factory/state/work/execution/runs/run-1.json');
  const bad = await f.call('lifecycle-progress', { ...runInput, accepted: ['1.5'] }); assert.equal(bad.ok, false);
  const result = await f.call('lifecycle-progress', runInput); assertSafe(result); assert.equal(result.ok, true);
  const tasks = parseExecutionTasks(await f.get('openspec/changes/work/tasks.md'));
  assert.deepEqual(tasks.map(t => t.checked), [true, true, true, true, false]);
  assert.equal(await f.get('.ai-factory/state/work/execution/runs/run-1.json'), runBefore);
  assert.equal((await f.call('lifecycle-progress', runInput)).historical, true);
});

for (const mode of ['openspec', 'classic']) test(`AC4: ${mode} progress uses canonical parser, preserves CRLF, examples, frontmatter and unrelated bytes`, async t => {
  const f = await fixture(t, { mode });
  const text = '---\r\nexample: "- [ ] 9 fake"\r\n---\r\n# Tasks\r\n<!-- - [ ] 8 fake -->\r\n```md\r\n- [ ] 7 fake\r\n```\r\n<!-- - [ ] 6 fake -->- [ ] 1.1 First `task`\r\n- [ ] 1.2 Second task\r\n';
  const paths = mode === 'classic' ? [`${f.plans}/work.md`, `${f.plans}/work/task.md`] : ['openspec/changes/work/tasks.md'];
  for (const p of paths) await f.put(p, text);
  await f.call('start', f.start());
  await f.put('.ai-factory/evidence/check.md', 'Observed result.');
  const r = await f.call('result', f.actor(1, { result: { result_id: 'result-1', status: 'completed', changed_files: [], checks: [{ name: 'fixture', exit_code: 0 }], evidence: ['.ai-factory/evidence/check.md'] } }));
  await f.call('accept', { ...runInput, version: r.version, result_digest: r.result_digest });
  assert.equal((await f.call('lifecycle-progress', runInput)).ok, true);
  for (const p of paths) assert.equal(await f.get(p), text.replace('- [ ] 1.1', '- [x] 1.1'));
});

test('AC4: drift after close blocks progress before journal and checklist writes', async t => {
  const f = await single(t); await f.close(); await f.put('src/a.js', 'later');
  assert.equal((await f.call('lifecycle-progress', runInput)).code, 'stale-checkpoint');
  assert.match(await f.get('openspec/changes/work/tasks.md'), /- \[ \] 1.1/);
  await assert.rejects(f.get(lifecyclePaths('work', 'progress', 'run-1').journal), { code: 'ENOENT' });
});

for (const point of ['lifecycle-after-journal', 'lifecycle-after-write-0', 'lifecycle-before-applied', 'lifecycle-after-applied']) test(`AC5: classic progress recovers at ${point}`, async t => {
  const f = await single(t, { mode: 'classic' }); await f.close(); let hit = false;
  await assert.rejects(f.call('lifecycle-progress', runInput, { failpoint: name => { if (name === point && !hit) { hit = true; throw new Error('crash'); } } }), /crash/);
  const recovered = await f.call('lifecycle-progress', runInput); assert.equal(recovered.ok, true); assert.equal(recovered.historical, true);
  assert.deepEqual(parseExecutionTasks(await f.get(`${f.plans}/work.md`)), parseExecutionTasks(await f.get(`${f.plans}/work/task.md`)));
  assert.equal(parseExecutionTasks(await f.get(`${f.plans}/work.md`))[0].checked, true);
});

test('AC5: third file image and conflicting journal replay block without applying remaining files', async t => {
  const f = await single(t, { mode: 'classic' }); await f.close();
  await assert.rejects(f.call('lifecycle-progress', runInput, { failpoint: name => { if (name === 'lifecycle-after-write-0') throw new Error('crash'); } }));
  const second = await f.get(`${f.plans}/work/task.md`); await f.put(`${f.plans}/work.md`, 'Third image');
  assert.equal((await f.call('lifecycle-progress', runInput)).code, 'lifecycle-file-conflict');
  assert.equal(await f.get(`${f.plans}/work/task.md`), second);
});

test('AC4/5: prepared progress replay rechecks quiescence against a newer run on an unchecked task', async t => {
  const f = await single(t); await f.close();
  await assert.rejects(f.call('lifecycle-progress', runInput, { failpoint: name => { if (name === 'lifecycle-after-journal') throw new Error('crash'); } }));
  const journal = lifecyclePaths('work', 'progress', 'run-1').journal;
  assert.equal(JSON.parse(await f.get(journal)).record.state, 'prepared');
  const checklist = 'openspec/changes/work/tasks.md', before = await f.get(checklist);
  const late = await f.call('start', f.start({ run_id: 'late-worker', task_id: '1.2', scope: ['src/b.js'] }));
  assert.equal(late.lifecycle, 'active'); // admission barrier cannot see lifecycle journals (#268)
  assert.equal((await f.call('lifecycle-progress', runInput)).code, 'lifecycle-not-quiescent');
  assert.equal(await f.get(checklist), before); // checklist byte-identical
  assert.equal(JSON.parse(await f.get(journal)).record.state, 'prepared'); // retained for recovery
  await f.put('.ai-factory/evidence/late.md', 'Observed late result.');
  const result = await f.call('result', f.actor(1, { run_id: 'late-worker',
    result: { result_id: 'result-late', status: 'completed', changed_files: [], checks: [{ name: 'fixture', exit_code: 0 }], evidence: ['.ai-factory/evidence/late.md'] } }));
  await f.call('accept', { change_id: 'work', run_id: 'late-worker', actor: 'parent', version: result.version, result_digest: result.result_digest });
  const recovered = await f.call('lifecycle-progress', runInput);
  assert.equal(recovered.ok, true); assert.equal(recovered.recovered, true); assert.equal(recovered.historical, true);
  assert.deepEqual(parseExecutionTasks(await f.get(checklist)).map(task => task.checked), [true, false]);
  assert.equal((await f.call('lifecycle-progress', runInput)).historical, true); // applied replay stays historical
});

test('AC4/5: fresh progress refuses a reserving sibling run before the checklist write', async t => {
  const f = await single(t); await f.close();
  const late = await f.call('start', f.start({ run_id: 'late-worker', task_id: '1.2', scope: ['src/b.js'] }));
  assert.equal(late.lifecycle, 'active'); // admission admits a run on the still-unchecked task
  const checklist = 'openspec/changes/work/tasks.md', before = await f.get(checklist);
  assert.equal((await f.call('lifecycle-progress', runInput)).code, 'lifecycle-not-quiescent');
  assert.equal(await f.get(checklist), before); // checklist byte-identical
  await assert.rejects(f.get(lifecyclePaths('work', 'progress', 'run-1').journal), { code: 'ENOENT' }); // no journal either
});

test('AC3: release refuses a full delivery history before the host mutation', async t => {
  const f = await single(t), input = { ...runInput, request_uuid: uuid(1) };
  const store = await deliveryStore({ rootDir: f.root });
  const r = await store.loadRequest('work', uuid(1));
  while (r.history.length < DELIVERY_LIMITS.history) { r.revision++; r.history.push({ revision: r.revision, phase: r.phase, at: r.updated_at }); }
  const p = deliveryPaths('work', uuid(1));
  await store.save(p.journal, { schema: 'aifhub.delivery-journal.v1', request_uuid: uuid(1), record_digest: digest(r), record: r });
  await store.save(p.request, r);
  const result = await f.call('lifecycle-release', input, { HostClient: f.host });
  assert.equal(result.code, 'delivery-history-full');
  assert.equal(f.host.state.counters.release_calls ?? 0, 0); // no host effect before the headroom refusal
  await assert.rejects(f.get(lifecyclePaths('work', 'release', uuid(1)).journal), { code: 'ENOENT' });
});

test('AC1: collect classifies absent and malformed host observations as unavailable, not identity conflicts', async t => {
  const f = await single(t, { pending: true });
  for (const [found, code] of [
    [null, 'delivery-observation-unavailable'],
    [{}, 'delivery-observation-unavailable'],
    [{ state: 'completed', identity: { wrong: true }, binding: {}, target: {}, namespace_digest: 'x', continuity_token: 'y' }, 'delivery-identity-conflict'],
  ]) {
    const host = { ...f.host, readRequest: async () => found };
    const result = await f.call('lifecycle-collect', { change_id: 'work', members: [{ request_uuid: uuid(1) }], read_host: true }, { HostClient: host });
    assert.equal(result.members[0].code, code);
    assert.equal(result.members[0].recovery_action.type, code === 'delivery-identity-conflict' ? 'resolve-identity-conflict' : 'read-request');
  }
});

test('AC1: include_all degrades per member over a corrupt request registry', async t => {
  const f = await single(t);
  await f.put('.ai-factory/state/work/execution/requests/not-a-uuid.json', 'corrupt\n');
  const result = await f.call('lifecycle-collect', { change_id: 'work', include_all: true });
  assert.equal(result.state, 'uncertain'); assert.equal(result.ok, false);
  assert.equal(result.members.filter(m => m.kind === 'delivery').length, 1); // valid member still listed
  assert.equal(result.next_action.type, 'manual');
});

test('AC1: collect reports a locally blocked delivery phase as blocked, not waiting', async t => {
  const f = await single(t);
  f.host.mode = 'wrong-target';
  const recovered = await f.call('delivery-recover', { change_id: 'work', run_id: 'run-1', request_uuid: uuid(1) }, { HostClient: f.host });
  assert.equal(recovered.ok, false);
  const result = await f.call('lifecycle-collect', { change_id: 'work', members: [{ request_uuid: uuid(1) }] });
  assert.equal(result.state, 'blocked'); assert.equal(result.ok, false);
  assert.equal(result.next_action.type, 'manual');
});

test('AC3: a checksum-valid malformed release journal conflicts instead of invalid-input', async t => {
  const f = await single(t), input = { ...runInput, request_uuid: uuid(1) };
  const path = lifecyclePaths('work', 'release', uuid(1)).journal;
  await f.put(path, JSON.stringify({ checksum: digest({ schema: 'bogus' }), record: { schema: 'bogus' } }, null, 2) + '\n');
  assert.equal((await f.call('lifecycle-release', input, { HostClient: f.host })).code, 'conflicting-lifecycle-replay');
});

test('AC6: CLI exit codes classify lifecycle results (blocked 1, invalid 2, success 0)', async t => {
  const p = await executionProject(); t.after(p.cleanup);
  await p.call('start', p.start());
  const spawn = (action, input) => new Promise(resolve => {
    const child = execFile(process.execPath, [fileURLToPath(new URL('./execution-state.mjs', import.meta.url)), action, '--json'],
      { cwd: p.root, windowsHide: true }, (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr }));
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(input));
  });
  const ok = await spawn('lifecycle-collect', { change_id: 'work', members: [{ run_id: 'run-1' }] });
  assert.equal(ok.code, 0); assert.equal(ok.stderr, ''); assert.equal(JSON.parse(ok.stdout).ok, true);
  const blocked = await spawn('lifecycle-progress', { change_id: 'work', run_id: 'missing', actor: 'parent' });
  assert.equal(blocked.code, 1); assert.equal(JSON.parse(blocked.stdout).ok, false);
  assert.equal(JSON.parse(blocked.stdout).blocked, true);
  assert.equal(JSON.parse(blocked.stdout).code, 'missing-or-invalid-run');
  const invalid = await spawn('lifecycle-progress', { change_id: '../escape', run_id: 'run-1', actor: 'parent' });
  assert.equal(invalid.code, 2); assert.equal(JSON.parse(invalid.stdout).code, 'invalid-change-id');
  assert.equal(JSON.parse(invalid.stdout).blocked, false);
});

test('AC5: settlement journal is durable before record; exact retry completes publication', async t => {
  const f = await single(t); await f.close(); const input = { ...runInput, decision: decision() };
  await assert.rejects(f.call('lifecycle-settle', input, { failpoint: name => { if (name === 'lifecycle-after-journal') throw new Error('crash'); } }));
  assert.equal((await f.call('lifecycle-settle', { ...input, decision: decision('rejected') })).code, 'conflicting-settlement');
  const recovered = await f.call('lifecycle-settle', input); assert.equal(recovered.recovered, true); assert.equal(recovered.historical, true);
});

for (const point of ['lifecycle-after-release-intent', 'lifecycle-after-host-release', 'lifecycle-after-release-result', 'after-registry-write']) test(`AC3/5: release retry deduplicates and recovers ${point}`, async t => {
  const f = await single(t), input = { ...runInput, request_uuid: uuid(1) }; let hit = false;
  await assert.rejects(f.call('lifecycle-release', input, { HostClient: f.host, failpoint: name => { if (name === point && !hit) { hit = true; throw new Error('crash'); } } }), /crash/);
  const recovered = await f.call('lifecycle-release', input, { HostClient: f.host }); assert.equal(recovered.ok, true);
  assert.equal(f.host.state.released.size, 1); const calls = f.host.state.trace.length;
  await f.call('lifecycle-release', input); assert.equal(f.host.state.trace.length, calls);
});

test('AC6: concurrent interrupt fails fast with state-locked while a bounded release call holds custody', async t => {
  const f = await single(t), input = { ...runInput, request_uuid: uuid(1) };
  let signalEntry, unblock; const entered = new Promise(r => { signalEntry = r; }), held = new Promise(r => { unblock = r; });
  // A short hostTimeoutMs makes the in-flight call fail fast instead of hanging the suite.
  const wrapped = { ...f.host, releaseRequest: async query => { signalEntry(); await held; return f.host.releaseRequest(query); } };
  const release = f.call('lifecycle-release', input, { HostClient: wrapped, hostTimeoutMs: 250 });
  await entered;
  await assert.rejects(f.call('interrupt', { ...runInput, version: 2, recovery_id: 'recover-1', reason: 'abandoned', execution_state: 'unknown' }),
    e => e.code === 'state-locked'); // parallel sessions never steal or wait out the lock
  const result = await release; // the short bounded timeout fires while the call is still held
  assert.equal(result.ok, false); assert.equal(result.code, 'lifecycle-release-unproven'); // bounded, typed, no hang
  assertSafe(result);
  unblock(); await new Promise(r => setImmediate(r)); // settle the wrapped host call
});

test('AC1/6: classic finalizer blocks gates, applies archive/index/status and delegates OpenSpec', async t => {
  const f = await batch(t, { mode: 'classic' }), input = { change_id: 'work', actor: 'parent', spec: '# Проверенный результат\n' };
  assert.equal((await f.call('lifecycle-finalize', input)).code, 'lifecycle-progress-required');
  await f.call('lifecycle-progress', runInput);
  assert.equal((await f.call('lifecycle-finalize', input)).code, 'lifecycle-verification-required');
  await f.put(`${f.plans}/work/status.yaml`, '\uFEFFstatus: verified\nplan_id: work\nverification:\n  verdict: pass-with-notes\n');
  await f.put('.ai-factory/specs/index.yaml', '# Preserve\nspecs:\n  - id: old\n    title: Old\nstats:\n  total: 1\n');
  const result = await f.call('lifecycle-finalize', input); assertSafe(result); assert.equal(result.ok, true);
  assert.equal(await f.get('.ai-factory/specs/work/spec.md'), input.spec);
  assert.equal(await f.get('.ai-factory/specs/work/plan.md'), await f.get(`${f.plans}/work.md`));
  await assert.rejects(f.get('.ai-factory/specs/work/status.yaml'), { code: 'ENOENT' });
  assert.match(await f.get(`${f.plans}/work/status.yaml`), /^\uFEFFstatus: done$/m);
  const index = await f.get('.ai-factory/specs/index.yaml'); assert.match(index, /id: old/); assert.match(index, /verification: pass-with-notes/);
  assert.ok(index.indexOf('id: "work"') < index.indexOf('stats:')); assert.match(index, /total: 2/);
  assert.equal((await f.call('lifecycle-finalize', input)).historical, true);
  assert.equal((await f.call('lifecycle-finalize', { ...input, spec: '# Other' })).code, 'conflicting-lifecycle-replay');
  const open = await fixture(t); const delegated = await open.call('lifecycle-finalize', input);
  assert.equal(delegated.delegated, true); assert.match(delegated.handoff, /aifhub-done-finalizer/);
});

test('AC5/6: classic finalization recovery and configured paths preserve verification and source binding', async t => {
  const f = await single(t, { mode: 'classic', plans: 'plans' }); await f.close(); await f.call('lifecycle-progress', runInput);
  await f.put('plans/work.md', (await f.get('plans/work.md')).replace('- [ ] 1.2', '- [x] 1.2'));
  await f.put('plans/work/task.md', (await f.get('plans/work/task.md')).replace('- [ ] 1.2', '- [x] 1.2'));
  await f.put('plans/work/status.yaml', 'status: verified\nplan_id: work\nverification:\n  verdict: pass\n');
  await f.put('.ai-factory/config.yaml', (await f.get('.ai-factory/config.yaml')) + '  specs: published\n');
  const input = { change_id: 'work', actor: 'parent', spec: '# Caller reviewed spec\n' };
  await assert.rejects(f.call('lifecycle-finalize', input, { failpoint: name => { if (name === 'lifecycle-after-write-0') throw new Error('crash'); } }));
  const recovered = await f.call('lifecycle-finalize', input); assert.equal(recovered.recovered, true);
  assert.equal(await f.get('published/work/spec.md'), input.spec); assert.match(await f.get('plans/work/status.yaml'), /verdict: pass/);
});

test('AC6: finalizer destination guards reject case aliases and canonical/evidence roots', async t => {
  const f = await single(t, { mode: 'classic', plans: 'plans' }); await f.close(); await f.call('lifecycle-progress', runInput);
  await f.put('plans/work.md', (await f.get('plans/work.md')).replace('- [ ] 1.2', '- [x] 1.2'));
  await f.put('plans/work/task.md', (await f.get('plans/work/task.md')).replace('- [ ] 1.2', '- [x] 1.2'));
  await f.put('plans/work/status.yaml', 'status: verified\nplan_id: work\nverification:\n  verdict: pass\n');
  const config = await f.get('.ai-factory/config.yaml'), input = { change_id: 'work', actor: 'parent', spec: '# Spec\n' };
  for (const [suffix, forbidden] of [
    ['  specs: PLANS/Work\n', 'PLANS/work/spec.md'],
    ['  specs: .ai-factory/qa\n', '.ai-factory/qa/work/spec.md'],
    ['  specs: .ai-factory/rules\n', '.ai-factory/rules/work/spec.md'],
    ['  specs: .ai-factory/rules/generated\n', '.ai-factory/rules/generated/work/spec.md'],
    ['  specs: .ai-factory/evidence\n', '.ai-factory/evidence/work/spec.md'],
    ['  qa: governance/qa\n  specs: governance/qa\n', 'governance/qa/work/spec.md'],
    ['  specs: published\n  description: published/work/plan.md\n', 'published/work/spec.md'],
    ['  specs: published\n  rules_file: published/index.yaml\n', 'published/index.yaml'],
  ]) {
    await f.put('.ai-factory/config.yaml', config + suffix);
    assert.equal((await f.call('lifecycle-finalize', input)).code, 'unsafe-path', suffix);
    await assert.rejects(f.get(forbidden), { code: 'ENOENT' }); // nothing written through the alias
  }
  await f.put('.ai-factory/config.yaml', config + '  specs: archive-out\n');
  const result = await f.call('lifecycle-finalize', input); assertSafe(result);
  assert.equal(result.ok, true); assert.equal(result.archive, 'archive-out/work');
  assert.equal(await f.get('archive-out/work/spec.md'), input.spec); // safe custom output keeps working
});

test('AC6: finalizer refuses unsupported index shapes and plan-folder name collisions before writes', async t => {
  const f = await single(t, { mode: 'classic', plans: 'plans' }); await f.close(); await f.call('lifecycle-progress', runInput);
  await f.put('plans/work.md', (await f.get('plans/work.md')).replace('- [ ] 1.2', '- [x] 1.2'));
  await f.put('plans/work/task.md', (await f.get('plans/work/task.md')).replace('- [ ] 1.2', '- [x] 1.2'));
  await f.put('plans/work/status.yaml', 'status: verified\nplan_id: work\nverification:\n  verdict: pass\n');
  const input = { change_id: 'work', actor: 'parent', spec: '# Spec\n' };
  for (const index of [
    // A deeper-indented continuation under the replaced entry would orphan after removal.
    'specs:\n  - id: work\n    title: work\n    verification:\n      verdict: pass\nstats:\n  total: 1\n',
    // A flow/nested verification value on any listed entry defeats the flat by_verdict recount.
    'specs:\n  - id: old\n    title: Old\n    verification: {verdict: pass}\n',
    'specs:\n  - id: work\n    title: work\n\n    verdict: pass\n', // blank line inside the entry span
  ]) {
    await f.put('.ai-factory/specs/index.yaml', index);
    assert.equal((await f.call('lifecycle-finalize', input)).code, 'unsupported-spec-index');
    await assert.rejects(f.get('.ai-factory/specs/work/spec.md'), { code: 'ENOENT' });
    assert.equal(await f.get('.ai-factory/specs/index.yaml'), index); // byte-identical refusal
  }
  await f.put('plans/work/plan.md', '# Caller document that must not be replaced\n');
  assert.equal((await f.call('lifecycle-finalize', input)).code, 'conflicting-archive-entry');
  await assert.rejects(f.get('.ai-factory/specs/work/spec.md'), { code: 'ENOENT' });
  await rm(path.join(f.root, 'plans/work/plan.md'));
  await f.put('.ai-factory/specs/index.yaml', '# Keep\nother:\n  - id: work\n    title: Foreign\nspecs:\n  - id: old\n    title: Old\nstats:\n  total: 1\n');
  const finalized = await f.call('lifecycle-finalize', input); assertSafe(finalized);
  assert.equal(finalized.ok, true); // same-id entries outside the specs list never match
  const index = await f.get('.ai-factory/specs/index.yaml');
  assert.match(index, /other:/); assert.match(index, /Foreign/); assert.match(index, /id: "work"/);
  assert.match(index, /total: 2/); assert.ok(index.indexOf('id: "work"') < index.indexOf('stats:'));
});

test('AC6: finalizer keeps CRLF status bytes and never duplicates keyed lines', async t => {
  const f = await single(t, { mode: 'classic', plans: 'plans' }); await f.close(); await f.call('lifecycle-progress', runInput);
  await f.put('plans/work.md', (await f.get('plans/work.md')).replace('- [ ] 1.2', '- [x] 1.2'));
  await f.put('plans/work/task.md', (await f.get('plans/work/task.md')).replace('- [ ] 1.2', '- [x] 1.2'));
  await f.put('plans/work/status.yaml', 'status : verified\r\nplan_id: work\r\nverification:\r\n  verdict: pass\r\n');
  const result = await f.call('lifecycle-finalize', { change_id: 'work', actor: 'parent', spec: '# Spec\n' });
  assert.equal(result.ok, true);
  const text = await f.get('plans/work/status.yaml');
  assert.equal((text.match(/^status\s*:/gm) ?? []).length, 1); // no duplicated status key
  assert.equal((text.match(/^finalized_at\s*:/gm) ?? []).length, 1);
  assert.match(text, /^status: done\r$/m); // CRLF byte preserved by the keyed rewrite
});

test('AC6: non-scalar configured paths fail with a typed code', async t => {
  const f = await batch(t, { mode: 'classic' }); await f.call('lifecycle-progress', runInput);
  await f.put(`${f.plans}/work/status.yaml`, 'status: verified\nplan_id: work\nverification:\n  verdict: pass\n');
  await f.put('.ai-factory/config.yaml', (await f.get('.ai-factory/config.yaml')) + '  specs: {a: b}\n');
  const result = await f.call('lifecycle-finalize', { change_id: 'work', actor: 'parent', spec: '# Spec\n' });
  assert.equal(result.code, 'tool-configuration-error');
});

test('AC5: publication refuses an oversized plan inventory before building all images', async t => {
  const f = await batch(t, { mode: 'classic' }); await f.call('lifecycle-progress', runInput);
  await f.put(`${f.plans}/work/status.yaml`, 'status: verified\nplan_id: work\nverification:\n  verdict: pass\n');
  await f.put(`${f.plans}/work/big.md`, 'x'.repeat(5 * 1024 * 1024));
  const result = await f.call('lifecycle-finalize', { change_id: 'work', actor: 'parent', spec: '# Spec\n' });
  assert.equal(result.code, 'invalid-lifecycle-journal');
  await assert.rejects(f.get('.ai-factory/specs/work/spec.md'), { code: 'ENOENT' });
});

test('AC6: failing verification verdict blocks finalization before any archive write', async t => {
  const f = await batch(t, { mode: 'classic' }); await f.call('lifecycle-progress', runInput);
  await f.put(`${f.plans}/work/status.yaml`, 'status: verified\nplan_id: work\nverification:\n  verdict: fail\n');
  await f.put('.ai-factory/specs/index.yaml', '# Preserve\nspecs:\n');
  const input = { change_id: 'work', actor: 'parent', spec: '# Spec\n' };
  assert.equal((await f.call('lifecycle-finalize', input)).code, 'lifecycle-verification-required');
  await assert.rejects(f.get('.ai-factory/specs/work/spec.md'), { code: 'ENOENT' });
  await assert.rejects(f.get('.ai-factory/specs/work/plan.md'), { code: 'ENOENT' });
  assert.equal(await f.get('.ai-factory/specs/index.yaml'), '# Preserve\nspecs:\n');
  assert.match(await f.get(`${f.plans}/work/status.yaml`), /^status: verified$/m); // not rewritten to done
});

test('AC4: BOM checklist line 0 replacement stays byte-exact through progress', async t => {
  const f = await fixture(t, { mode: 'classic' });
  const text = '\uFEFF- [ ] 1.1 First task\n- [ ] 1.2 Second task\n';
  for (const p of [`${f.plans}/work.md`, `${f.plans}/work/task.md`]) await f.put(p, text);
  await f.call('start', f.start());
  await f.put('.ai-factory/evidence/check.md', 'Observed result.');
  const r = await f.call('result', f.actor(1, { result: { result_id: 'result-1', status: 'completed', changed_files: [], checks: [{ name: 'fixture', exit_code: 0 }], evidence: ['.ai-factory/evidence/check.md'] } }));
  await f.call('accept', { ...runInput, version: r.version, result_digest: r.result_digest });
  const progress = await f.call('lifecycle-progress', runInput); assert.equal(progress.ok, true);
  for (const p of [`${f.plans}/work.md`, `${f.plans}/work/task.md`]) {
    const stored = await f.get(p);
    assert.equal(stored, '\uFEFF- [x] 1.1 First task\n- [ ] 1.2 Second task\n'); // BOM kept, line-0 checkbox replaced
    assert.equal(parseExecutionTasks(stored)[0].checked, true);
  }
  assert.equal((await f.call('lifecycle-progress', runInput)).historical, true);
});

test('AC5: corrupt progress journals fail closed; missing journal is the deterministic fresh path', async t => {
  const f = await single(t); await f.close();
  const fresh = await f.call('lifecycle-progress', runInput);
  assert.equal(fresh.ok, true); assert.equal(fresh.state, 'progress-applied'); assert.equal(fresh.historical, undefined);
  const journal = lifecyclePaths('work', 'progress', 'run-1').journal, checklist = 'openspec/changes/work/tasks.md', before = await f.get(checklist);
  await f.put(journal, 'not-json');
  const corrupt = await f.call('lifecycle-progress', runInput);
  assert.equal(corrupt.ok, false); assert.equal(corrupt.code, 'invalid-state');
  await f.put(journal, JSON.stringify({ checksum: '0'.repeat(64), record: { schema: 'aifhub.progress-journal.v1', journal_id: 'run-1' } }));
  const mismatch = await f.call('lifecycle-progress', runInput);
  assert.equal(mismatch.code, 'invalid-state');
  assert.equal(await f.get(checklist), before); // fail-closed without recovery instructions
});

test('AC1: collect after applied progress returns the documented stale blocker; settle precedes progress', async t => {
  const f = await single(t); await f.close();
  assert.equal((await f.call('lifecycle-progress', runInput)).ok, true);
  const after = await f.call('lifecycle-collect', { change_id: 'work', members: [{ run_id: 'run-1' }] });
  assert.equal(after.ok, false); assert.equal(after.code, 'stale-context'); // intentional run drift, not a defect
  assertSafe(after);
});

test('AC6: finalizer cannot run while an unknown worker reserves scope', async t => {
  const f = await single(t, { mode: 'classic', pending: true });
  await f.call('interrupt', { ...runInput, version: 2, recovery_id: 'unknown', reason: 'abandoned', execution_state: 'unknown' });
  const result = await f.call('lifecycle-finalize', { change_id: 'work', actor: 'parent', spec: '# Spec' });
  assert.equal(result.code, 'lifecycle-not-quiescent');
});

test('AC5/6: prepared finalizer rechecks quiescence before recovery', async t => {
  const f = await batch(t, { mode: 'classic' }); await f.call('lifecycle-progress', runInput);
  await f.put(`${f.plans}/work/status.yaml`, 'status: verified\nplan_id: work\nverification:\n  verdict: pass\n');
  const input = { change_id: 'work', actor: 'parent', spec: '# Spec' };
  await assert.rejects(f.call('lifecycle-finalize', input, { failpoint: name => { if (name === 'lifecycle-after-journal') throw new Error('crash'); } }));
  await f.call('start', f.start({ run_id: 'late-worker', role: 'fix', context_paths: ['.ai-factory/evidence/preflight.md'] }));
  assert.equal((await f.call('lifecycle-finalize', input)).code, 'lifecycle-not-quiescent');
  assert.match(await f.get(`${f.plans}/work/status.yaml`), /^status: verified$/m);
});

test('AC5: prepared finalizer rejects changed source before archive publication', async t => {
  const f = await batch(t, { mode: 'classic' }); await f.call('lifecycle-progress', runInput);
  await f.put(`${f.plans}/work/status.yaml`, 'status: verified\nplan_id: work\nverification:\n  verdict: pass\n');
  const input = { change_id: 'work', actor: 'parent', spec: '# Spec' };
  await assert.rejects(f.call('lifecycle-finalize', input, { failpoint: name => { if (name === 'lifecycle-after-journal') throw new Error('crash'); } }));
  await f.put(`${f.plans}/work/context.md`, '# Changed source');
  assert.equal((await f.call('lifecycle-finalize', input)).code, 'lifecycle-source-conflict');
  await assert.rejects(f.get('.ai-factory/specs/work/spec.md'), { code: 'ENOENT' });
});

test('AC3: host transport failures retain manual fallback and a recoverable release intent', async t => {
  const f = await single(t), input = { ...runInput, request_uuid: uuid(1) };
  for (const [key, code] of [['capabilities', 'lifecycle-capabilities-required'], ['readRequest', 'delivery-observation-unavailable'], ['releaseRequest', 'lifecycle-release-unproven']]) {
    const result = await f.call('lifecycle-release', input, { HostClient: { ...f.host, [key]: async () => { throw new Error('private provider details'); } } });
    assert.equal(result.code, code); assertSafe(result); assert.doesNotMatch(JSON.stringify(result), /private provider/);
  }
  assert.equal((await f.call('lifecycle-release', input, { HostClient: f.host })).ok, true);
});

test('AC1/6: collect bounds, closed next_action enum, capability fallback and timeouts', async t => {
  const f = await single(t, { pending: true }); const input = { change_id: 'work', members: [{ request_uuid: uuid(1) }], read_host: true };
  const before = f.host.state.trace.length;
  const absent = await f.call('lifecycle-collect', input); assert.equal(absent.code, 'lifecycle-capabilities-required'); assertSafe(absent);
  assert.equal(f.host.state.trace.length, before);
  for (const members of [[], Array.from({ length: 25 }, (_, i) => ({ request_uuid: uuid(i + 1) })), [{ run_id: 'run-1' }, { run_id: 'run-1' }], [{ run_id: 'run-1', request_uuid: uuid(1) }]]) assert.equal((await f.call('lifecycle-collect', { change_id: 'work', members })).ok, false);
  assert.throws(() => validateNextAction({ type: 'shell', reason: 'arbitrary command' })); assert.ok(NEXT_ACTION_TYPES.includes('lifecycle-settle'));
  const timed = await f.call('lifecycle-collect', input, { HostClient: { ...f.host, readRequest: () => new Promise(() => {}) }, hostTimeoutMs: 1 });
  assert.equal(timed.state, 'uncertain'); assert.equal(timed.service_calls.host_reads, 1);
  assert.ok(RECOVERY_ACTION_TYPES.includes(timed.members[0].recovery_action.type));
});

test('AC7: paired executed manual/grouped polling measures ≥2x service-call reduction, same host trace', async t => {
  const measurements = [];
  for (const k of [2, 5]) {
    const baseline = await single(t, { pending: true, count: k }), candidate = await single(t, { pending: true, count: k });
    baseline.host.state.trace.length = 0; candidate.host.state.trace.length = 0;
    let manualCalls = 0; const counters = {};
    const manualCall = async (action, input, options) => { manualCalls++; return baseline.call(action, input, options); };
    for (let round = 0; round < 3; round++) {
      for (let i = 1; i <= k; i++) {
        await manualCall('inspect', { change_id: 'work', run_id: 'run-1' });
        await manualCall('delivery-inspect', { change_id: 'work', run_id: 'run-1', request_uuid: uuid(i) }, { HostClient: baseline.host });
      }
      const grouped = await candidate.call('lifecycle-collect', { change_id: 'work', members: Array.from({ length: k }, (_, i) => ({ request_uuid: uuid(i + 1) })), read_host: true }, { HostClient: candidate.host, counters });
      assert.equal(grouped.service_calls.host_reads, k * (round + 1));
    }
    assert.deepEqual(candidate.host.state.trace, baseline.host.state.trace);
    assert.equal(manualCalls / counters.service_calls, 2 * k);
    measurements.push({ scenario: `${k} pending x 3 rounds`, manual: manualCalls, grouped: counters.service_calls, ratio: manualCalls / counters.service_calls });
  }
  t.diagnostic(JSON.stringify({ offline: measurements, live: 'NOTRUN', unit: 'executed helper call, not measured live model calls' }));
});

test('AC7: bounded driver waits outside locks and returns before producer/parent decisions', async t => {
  const f = await single(t, { pending: true }), counters = {}; let waits = 0;
  const result = await f.drive({ change_id: 'work', members: [{ request_uuid: uuid(1) }], read_host: true }, { HostClient: f.host, maxSteps: 3, counters,
    wait: async () => { waits++; const s = await storeFor(f.root); await s.lock('.ai-factory/state/execution-write.lock', async () => {}); if (waits === 2) f.host.complete(uuid(1)); } });
  assert.equal(waits, 2); assert.equal(counters.service_calls, 3); assert.equal(result.next_action.type, 'delivery-recover');
  assert.equal(result.members[0].phase === 'verified', false);
  assert.equal(result.budget_exhausted, false);
});

test('AC1/6: a single producer result returns the driver to the parent without polling acceptance', async t => {
  const f = await single(t); let waits = 0;
  const result = await f.drive({ change_id: 'work', members: [{ run_id: 'run-1' }] }, { maxSteps: 3, wait: async () => { waits++; } });
  assert.equal(result.next_action.type, 'manual'); assert.match(result.next_action.reason, /Parent/);
  assert.equal(result.service_calls.service_calls, 1); assert.equal(waits, 0); assert.equal(result.budget_exhausted, false);
});

test('AC7: executed paired single wait/settle, batch 2–5 through finalization and interrupt/re-dispatch', async t => {
  const measurements = [];
  const measure = async (name, setup, manualSteps, groupedSteps) => {
    const baseline = await setup(), candidate = await setup(); let manualCalls = 0, groupedCalls = 0;
    const call = (f, count) => async (action, input, options) => { count(); return f.call(action, input, options); };
    await manualSteps(baseline, call(baseline, () => { manualCalls++; }));
    await groupedSteps(candidate, call(candidate, () => { groupedCalls++; }));
    assert.ok(manualCalls / groupedCalls >= 2, `${name}: ${manualCalls}/${groupedCalls}`);
    measurements.push({ scenario: name, manual: manualCalls, grouped: groupedCalls, ratio: manualCalls / groupedCalls });
  };
  await measure('single wait + settle', async () => { const f = await single(t); await f.close(); return f; },
    async (f, call) => {
      await call('inspect', { change_id: 'work', run_id: 'run-1' });
      await call('delivery-inspect', { change_id: 'work', run_id: 'run-1', request_uuid: uuid(1) }, { HostClient: f.host });
      await call('resume', { change_id: 'work', run_id: 'run-1' });
      assert.equal((await call('lifecycle-settle', { ...runInput, decision: decision() })).ok, true);
    }, async (f, call) => {
      assert.equal((await call('lifecycle-collect', { change_id: 'work', include_all: true })).state, 'ready');
      assert.equal((await call('lifecycle-settle', { ...runInput, decision: decision() })).ok, true);
    });
  for (const n of [2, 5]) await measure(`batch ${n}: seal/results/accepts/close → progress/finalize`, async () => {
    const f = await batch(t, { mode: 'classic', n });
    await f.put(`${f.plans}/work/status.yaml`, 'status: verified\nplan_id: work\nverification:\n  verdict: pass\n'); return f;
  }, async (f, call) => {
    for (const item of f.manifest) {
      const inspected = await call('inspect', { change_id: 'work', run_id: 'run-1' }); assert.equal(inspected.lifecycle, 'closed');
      const resumed = await call('resume', { change_id: 'work', run_id: 'run-1' }); assert.equal(resumed.items[item.task_id].accepted, true);
    }
    assert.equal((await call('lifecycle-progress', runInput)).ok, true);
    assert.equal((await call('lifecycle-finalize', { change_id: 'work', actor: 'parent', spec: '# Spec\n' })).ok, true);
  }, async (f, call) => {
    assert.equal((await call('lifecycle-collect', { change_id: 'work', members: [{ run_id: 'run-1' }] })).state, 'ready');
    assert.equal((await call('lifecycle-progress', runInput)).ok, true);
    assert.equal((await call('lifecycle-finalize', { change_id: 'work', actor: 'parent', spec: '# Spec\n' })).ok, true);
  });
  const interruptSetup = async () => {
    const f = await single(t, { pending: true });
    await f.call('interrupt', { ...runInput, version: 2, recovery_id: 'lost', reason: 'abandoned', execution_state: 'unknown' });
    await f.put('.ai-factory/evidence/stop.md', 'Observed stopped worker.'); return f;
  };
  const redispatch = async (f, call) => {
    await call('stop-confirm', { ...runInput, version: 3, recovery_id: 'lost', confirmation_id: 'stopped', evidence: ['.ai-factory/evidence/stop.md'] });
    const started = await call('start', f.start({ run_id: 'run-2' })); assert.equal(started.lifecycle, 'active');
  };
  await measure('interrupt → stop-confirm → re-dispatch', interruptSetup, async (f, call) => {
    await call('inspect', { change_id: 'work', run_id: 'run-1' });
    await call('delivery-inspect', { change_id: 'work', run_id: 'run-1', request_uuid: uuid(1) }, { HostClient: f.host });
    await call('inspect', { change_id: 'work', run_id: 'run-1' }); await call('inspect', { change_id: 'work' });
    await redispatch(f, call);
  }, async (f, call) => {
    assert.equal((await call('lifecycle-collect', { change_id: 'work', include_all: true, read_host: true }, { HostClient: f.host })).reservation_retained, true);
    await redispatch(f, call);
  });
  t.diagnostic(JSON.stringify({ offline: measurements, live: 'NOTRUN', baseline: 'Scripted manual per-member observations; shared journal publishers and owner transitions are counted equally.' }));
});

test('AC6: release validation is additive; new modules do not import semantic or process mutation APIs', async t => {
  const f = await single(t), r = await f.record(); validateDeliveryRequest(r);
  validateDeliveryRequest({ ...r, release: { released_at: '2026-10-31T00:00:00Z', host_release_state: 'released' } });
  assert.throws(() => validateDeliveryRequest({ ...r, phase: 'pending', release: { released_at: '2026-10-31T00:00:00Z', host_release_state: 'released' } }));
  for (const name of ['host-lifecycle.mjs', 'host-lifecycle-store.mjs']) {
    const source = await readFile(new URL(name, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /from ['"]node:child_process|execFile\(|spawn\(|auditor\(|evaluateQaBinding\(/);
    assert.doesNotMatch(source, /from ['"]\.\/execution-state\.mjs|from ['"]\.\/host-delivery\.mjs/); // CLI TLA cycle
  }
  const provenance = await readFile(new URL('execution-provenance.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(provenance, /'host-lifecycle(?:-store)?\.mjs'/);
  assert.ok((await readdir(new URL('.', import.meta.url))).includes('host-lifecycle.test.mjs'));
});
