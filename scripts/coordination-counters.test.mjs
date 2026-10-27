// Offline lifecycle observations, not model/service-call or OS-spawn measurements.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fakeRepository, helperWithGit } from './fixtures/snapshot-test.mjs';
import { observeFilesystem, traceCounts } from '../benchmarks/snapshot/run-arm.mjs';
import { capture, restore, put } from '../benchmarks/snapshot/fixture.mjs';

const ids = [1, 2, 3, 4, 5];
const leaf = i => `data/${i}.txt`;
const evidence = i => `.ai-factory/state/work/implementation/check-${i}.md`;
const tasksPath = 'openspec/changes/work/tasks.md';
const checklist = ids.map(i => `- [ ] 1.${i} Item ${i}\n`).join('');
const manifest = ids.map(i => ({ task_id: `1.${i}`, files: [leaf(i)], expected_change: `Edit item ${i}`, check: 'synthetic', dependencies: [] }));
const payload = i => ({ result_id: `result-${i}`, status: 'completed', changed_files: [leaf(i)],
  checks: [{ name: 'synthetic', exit_code: 0 }], evidence: [evidence(i)] });
const base = run => ({ change_id: 'work', run_id: run });
const actor = (run, version, owner = false) => ({ ...base(run), actor: owner ? 'parent' : 'worker', version });

async function fixture(t) {
  const p = await fakeRepository(t, [...ids.map(leaf), 'outside.txt', 'openspec/changes/work/proposal.md', tasksPath]);
  await put(p.root, '.ai-factory/config.yaml', 'aifhub:\n  tools:\n    openspec: true\n');
  await put(p.root, tasksPath, checklist);
  await put(p.root, evidence('preflight'), 'Independent low-risk same-shape leaves.');
  const prepared = await capture(p.root);
  const store = await helperWithGit('workflow-state-store.mjs', p.git);
  const counts = { calls: 0, snapshots: 0, evidence: 0 };
  const injected = { ...store,
    worktree: async (...args) => { counts.snapshots++; return store.worktree(...args); },
    storeFor: async (...args) => {
      const s = await store.storeFor(...args), refs = s.references;
      s.references = async paths => { counts.evidence += paths.filter(p => ids.some(i => evidence(i) === p)).length; return refs(paths); };
      return s;
    }
  };
  const key = `coordination-counts-${randomUUID()}`; globalThis[key] = injected;
  const execution = await helperWithGit('execution-state.mjs', null, false, source => source.replace(
    /import\('[^']+\/workflow-state-store\.mjs'\)/, `Promise.resolve(globalThis[${JSON.stringify(key)}])`));
  t.after(() => delete globalThis[key]);
  return { ...p, store, counts,
    call: (action, input) => { counts.calls++; return execution.executionCommand(action, input, { rootDir: p.root }); },
    reset: async () => { await restore(p.root, prepared); p.calls.length = 0; for (const key of Object.keys(counts)) counts[key] = 0; }
  };
}

async function batch(f, order = ids, replay = false) {
  const run = 'batch';
  await f.call('batch-start', { ...base(run), owner: 'parent', worker: 'worker', role: 'implement', manifest, preflight_paths: [evidence('preflight')] });
  await f.call('resume', base(run));
  for (const i of ids) { await put(f.root, leaf(i), `edited ${i}\n`); await put(f.root, evidence(i), `Observed item ${i}.\n`); }
  await f.call('checkpoint', { ...actor(run, 1), progress: { completed_steps: ['Edited all items'], next_step: 'Seal' } });
  const sealInput = { ...actor(run, 2), evidence: Object.fromEntries(ids.map(i => [`1.${i}`, [evidence(i)]])) };
  const seal = await f.call('batch-seal', sealInput); let version = seal.version;
  const results = [], accepts = [];
  for (const i of ids) {
    const input = { ...actor(run, version), task_id: `1.${i}`, seal_digest: seal.seal_digest, result: payload(i) };
    const result = await f.call('batch-result', input); version = result.version; results.push({ input, result });
  }
  for (const i of order) {
    const input = { ...actor(run, version, true), task_id: `1.${i}`, seal_digest: seal.seal_digest, result_digest: results[i - 1].result.result_digest };
    version = (await f.call('batch-accept', input)).version; accepts.push(input);
  }
  const closeInput = { ...actor(run, version, true), seal_digest: seal.seal_digest };
  const closed = await f.call('batch-close', closeInput);
  await f.call('resume', base(run));
  const store = await f.store.storeFor(f.root), saved = await store.load('.ai-factory/state/work/execution/runs/batch.json');
  assert.equal(await fs.readFile(path.join(f.root, tasksPath), 'utf8'), checklist);
  if (replay) {
    const before = [saved.version, Object.keys(saved.receipts).length];
    for (const [action, input] of [['batch-seal', sealInput], ['batch-result', results[0].input], ['batch-accept', accepts[0]], ['batch-close', closeInput]]) {
      assert.equal((await f.call(action, input)).replay, true);
    }
    await assert.rejects(f.call('batch-result', { ...results[0].input, result: { ...payload(1), summary: 'conflict' } }), e => e.code === 'conflicting-result');
    await assert.rejects(f.call('batch-accept', { ...accepts[0], result_digest: '0'.repeat(64) }), e => e.code === 'conflicting-replay');
    const after = await store.load('.ai-factory/state/work/execution/runs/batch.json');
    assert.deepEqual([after.version, Object.keys(after.receipts).length], before);
  }
  return { accepted: closed.accepted, unfinished: closed.unfinished, versions: [saved.version], receipts: Object.keys(saved.receipts).length };
}

async function serial(f) {
  const accepted = [], versions = []; let receipts = 0;
  for (const i of ids) {
    const run = `single-${i}`;
    await f.call('start', { ...base(run), task_id: `1.${i}`, owner: 'parent', worker: 'worker', role: 'implement', scope: [leaf(i)] });
    await f.call('resume', base(run));
    await put(f.root, leaf(i), `edited ${i}\n`); await put(f.root, evidence(i), `Observed item ${i}.\n`);
    await f.call('checkpoint', { ...actor(run, 1), progress: { completed_steps: ['Edited item'], next_step: 'Review' } });
    const r = await f.call('result', { ...actor(run, 2), result: payload(i) });
    await f.call('accept', { ...actor(run, 3, true), result_digest: r.result.digest });
    await f.call('resume', base(run));
    const s = await (await f.store.storeFor(f.root)).load(`.ai-factory/state/work/execution/runs/${run}.json`);
    accepted.push(`1.${i}`); versions.push(s.version); receipts += Object.keys(s.receipts).length;
  }
  assert.equal(await fs.readFile(path.join(f.root, tasksPath), 'utf8'), checklist);
  return { accepted, unfinished: [], versions, receipts };
}
async function arm(f, kind, observed, order = ids) {
  await f.reset();
  const observer = observed ? observeFilesystem() : null;
  let result;
  try { result = await (kind === 'batch' ? batch(f, order) : serial(f)); }
  finally { observer?.stop(); }
  const git = traceCounts(f.calls.map((argv, i) => JSON.stringify({ event: 'start', sid: String(i), argv: ['git', ...argv] })).join('\n'));
  return { result, counters: { ...f.counts }, git, fs: observer?.counters ?? null,
    bytes: await Promise.all(ids.map(i => fs.readFile(path.join(f.root, leaf(i)), 'utf8'))),
    outside: await fs.readFile(path.join(f.root, 'outside.txt'), 'utf8') };
}

for (const order of [ids, [...ids].reverse()]) test(`K5 vs five serial on one prepared fixture, acceptance ${order}`, async t => {
  const f = await fixture(t);
  const b = await arm(f, 'batch', true, order), s = await arm(f, 'serial', true);
  assert.deepEqual(b.counters, { calls: 16, snapshots: 16, evidence: 65 });
  assert.deepEqual(s.counters, { calls: 30, snapshots: 30, evidence: 15 });
  assert.equal(b.result.receipts, 12); assert.deepEqual(b.result.versions, [14]);
  assert.equal(s.result.receipts, 10); assert.deepEqual(s.result.versions, [4, 4, 4, 4, 4]);
  assert.deepEqual(b.result.accepted, ids.map(i => `1.${i}`));
  assert.deepEqual(b.result.accepted, s.result.accepted); assert.deepEqual(b.bytes, s.bytes); assert.equal(b.outside, s.outside);
  assert.deepEqual(b.git, { 'rev-parse': 32, 'stage-list': 32, 'names-list': 16, other: 0 });
  assert.equal(Object.values(s.git).reduce((a, b) => a + b, 0), 150);
  assert.ok(b.fs.reads > 0 && b.fs.bytes > 0 && b.fs.peak_fds > 0);
  const unobserved = await arm(f, 'batch', false, order);
  assert.deepEqual(unobserved.result, b.result); assert.deepEqual(unobserved.bytes, b.bytes);
  const serialUnobserved = await arm(f, 'serial', false);
  assert.deepEqual(serialUnobserved.result, s.result); assert.deepEqual(serialUnobserved.bytes, s.bytes);
  t.diagnostic(JSON.stringify({ scope: 'offline-injected-Git-not-OS-spawns', batch: b.counters, serial: s.counters, batch_git: b.git, serial_git: s.git, batch_fs: b.fs, serial_fs: s.fs }));
});

test('K5 all results submitted, four accepted leave fifth unfinished', async t => {
  const f = await fixture(t), result = await batch(f, [1, 2, 3, 4]);
  assert.deepEqual(result.accepted, ['1.1', '1.2', '1.3', '1.4']); assert.deepEqual(result.unfinished, ['1.5']);
});
test('K5 exact replay never advances version/receipts, conflicting replay rejects', async t => {
  const f = await fixture(t); await batch(f, ids, true);
});
test('dispatch_reason remains forbidden in top-level and per-item runtime manifests', async t => {
  const f = await fixture(t);
  const input = { ...base('bad'), owner: 'parent', worker: 'worker', role: 'implement', manifest, preflight_paths: [evidence('preflight')] };
  for (const bad of [{ ...input, dispatch_reason: 'batch' }, { ...input, manifest: [{ ...manifest[0], dispatch_reason: 'batch' }, ...manifest.slice(1)] }]) {
    await assert.rejects(f.call('batch-start', bad));
  }
  assert.equal(await fs.readFile(path.join(f.root, tasksPath), 'utf8'), checklist);
});
