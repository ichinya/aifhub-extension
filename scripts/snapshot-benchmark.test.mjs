import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { balancedOrder, conforms, privacyCheck, runMatrix, validateCatalog, validateResults } from '../benchmarks/snapshot/run-matrix.mjs';
import { distribution, aggregateStatus, summarize } from '../benchmarks/snapshot/summarize.mjs';
import { ENTRYPOINTS, moduleHashes, observeFilesystem, operation, prepare, traceCounts, validateIdentity, verifyIdentity } from '../benchmarks/snapshot/run-arm.mjs';
import { capture, createFixture, isolatedEnvironment, manifest, restore, sha256, topology } from '../benchmarks/snapshot/fixture.mjs';
import { fakeRepository, helperWithGit } from './fixtures/snapshot-test.mjs';
const catalog = JSON.parse(await fs.readFile(new URL('../benchmarks/snapshot/scenarios.json', import.meta.url), 'utf8'));
const identity = { commit: 'a'.repeat(40), source: 'committed', modules: Object.fromEntries(ENTRYPOINTS.map(p => [p, 'b'.repeat(64)])) };
test('full W/S/B/I/H/F/N catalog, closed schema and topology reject invalid inputs', () => {
  assert.deepEqual(validateCatalog(catalog), []);
  assert.deepEqual([...new Set(catalog.scenarios.map(s => s.family))].sort(), ['B', 'F', 'H', 'I', 'N', 'S', 'W']);
  assert.equal(catalog.scenarios.filter(s => /^W-m/.test(s.id)).length, 24);
  assert.deepEqual(topology(8), ['api', 'api/openapi', 'api/models', 'api/models/common', 'mcp', 'mcp/openapi', 'mcp/models', 'mcp/models/common']);
  for (const change of [c => c.no_promote = false, c => c.scenarios[0].modules = 3, c => c.extra = true, c => c.scenarios[0].leaves = 20001,
    c => c.scenarios.push(c.scenarios[0]), c => c.repeats = 0, c => c.scenarios[0].family = 'G']) {
    const c = structuredClone(catalog); change(c); assert.notDeepEqual(validateCatalog(c), []);
  }
});
test('arm identities require full commit and executable import closure hashes', async () => {
  assert.equal(validateIdentity(identity), true);
  for (const change of [i => i.commit = '81ccd86', i => delete i.modules[ENTRYPOINTS[0]], i => i.modules[ENTRYPOINTS[1]] = 'bad', i => i.modules['../escape.mjs'] = 'a'.repeat(64)]) {
    const value = structuredClone(identity); change(value); assert.equal(validateIdentity(value), false);
  }
  const modules = await moduleHashes(path.resolve('.'));
  assert.ok(Object.hasOwn(modules, 'scripts/execution-transactions.mjs'));
  assert.ok(Object.hasOwn(modules, 'scripts/execution-task-source.mjs'));
  await assert.rejects(verifyIdentity('.', { ...identity, commit: 'short' }, {}), /invalid-arm-identity/);
});
test('schema subset checks closed nested objects and nullable metrics', () => {
  assert.equal(conforms({ value: null }, { type: 'object', required: ['value'], additionalProperties: false, properties: { value: { type: ['number', 'null'] } } }), true);
  assert.equal(conforms({ value: null, raw_path: 'secret' }, { type: 'object', additionalProperties: false, properties: { value: { type: ['number', 'null'] } } }), false);
});
test('seed balances A/B ordering reproducibly', () => {
  const orders = Array.from({ length: 10 }, (_, n) => balancedOrder(237, n).join(','));
  assert.equal(orders.filter(o => o.startsWith('A0,')).length, 5);
  assert.deepEqual(orders, Array.from({ length: 10 }, (_, n) => balancedOrder(237, n).join(',')));
});
test('failure/NOTRUN cannot become zero latency or a speedup claim; missing arm vetoes', () => {
  const base = { scenario: 'W', profile: 'process-cold', repeat: 0, status: 'PASS', expected: true, unchanged: true, fixture_digest: 'f', semantic_digest: 's', wall_ms: 12 };
  const rows = [{ ...base, arm: 'A0' }, { ...base, arm: 'A-first', wall_ms: 6 }];
  assert.equal(summarize(rows, ['A0', 'A-first'])[0].paired_speedup.median, 2);
  for (const status of ['FAIL', 'NOTRUN']) {
    const summary = summarize([rows[0], { ...rows[1], status, wall_ms: null }], ['A0', 'A-first'])[0];
    assert.equal(summary.paired_speedup.median, null); assert.equal(summary.status, status);
  }
  assert.equal(summarize([rows[0]], ['A0', 'A-first'])[0].status, 'FAIL');
  assert.equal(summarize([rows[0], { ...rows[1], fixture_digest: 'different' }], ['A0', 'A-first'])[0].status, 'FAIL');
  assert.equal(aggregateStatus([]), 'NOTRUN'); assert.equal(aggregateStatus([{ status: 'FAIL' }, { status: 'NOTRUN' }]), 'FAIL');
  assert.deepEqual(distribution([]), { median: null, iqr: null, samples: [] });
  assert.deepEqual(distribution([1, 2, 3, 4]), { median: 2.5, iqr: 1.5, samples: [1, 2, 3, 4] });
});
test('Trace2 counts one start per SID with normalized kinds', () => {
  const events = [{ event: 'start', sid: 'one', argv: ['git', 'rev-parse', 'HEAD'] }, { event: 'cmd_name', sid: 'one', name: 'rev-parse' },
    { event: 'start', sid: 'one', argv: ['git', 'rev-parse'] }, { event: 'start', sid: 'two', argv: ['git', 'ls-files', '--stage', '-z'] },
    { event: 'start', sid: 'three', argv: ['git', 'ls-files', '--cached'] }];
  assert.deepEqual(traceCounts(events.map(JSON.stringify).join('\n')), { 'rev-parse': 1, 'stage-list': 1, 'names-list': 1, other: 0 });
});
test('canaries veto exports and Git environment does not inherit secrets/index/trace', () => {
  for (const canary of catalog.privacy_canaries) assert.equal(privacyCheck({ value: canary }, catalog.privacy_canaries), false);
  const env = isolatedEnvironment(path.resolve('.'));
  for (const key of ['GIT_INDEX_FILE', 'GIT_TRACE2_EVENT', 'OPENAI_API_KEY', 'AWS_SECRET_ACCESS_KEY']) assert.equal(Object.hasOwn(env, key), false);
  assert.equal(env.GIT_CONFIG_NOSYSTEM, '1'); assert.equal(env.GIT_AUTHOR_DATE, env.GIT_COMMITTER_DATE);
});
test('filesystem observer is observational and restore uses identical owned bytes/modes', async t => {
  const p = await fakeRepository(t), api = await helperWithGit('workflow-state-store.mjs', p.git), store = await api.storeFor(p.root);
  const before = await api.worktree(store, ['data']), saved = await capture(p.root);
  const observer = observeFilesystem(); let observed;
  try { observed = await api.worktree(store, ['data']); }
  finally { observer.stop(); }
  assert.deepEqual(observed, before); assert.ok(observer.counters.opens >= 1); assert.ok(observer.counters.bytes >= 8);
  assert.ok(observer.counters.reads >= 1); assert.equal(observer.counters.peak_fds, 1);
  await fs.writeFile(path.join(p.root, 'data/a.txt'), 'changed'); await fs.writeFile(path.join(p.root, 'extra'), 'remove me');
  await restore(p.root, saved); assert.equal(await fs.readFile(path.join(p.root, 'data/a.txt'), 'utf8'), 'initial\n');
  await assert.rejects(fs.stat(path.join(p.root, 'extra')), { code: 'ENOENT' });
  assert.deepEqual(await api.worktree(store, ['data']), before);
});
async function apiFixture(t) {
  const p = await fakeRepository(t, ['data/a.txt', 'data/b.txt', 'data/c.txt', 'openspec/changes/work/proposal.md', 'openspec/changes/work/tasks.md']);
  await fs.mkdir(path.join(p.root, '.ai-factory')); await fs.writeFile(path.join(p.root, '.ai-factory/config.yaml'), 'aifhub:\n  tools:\n    openspec: true\n');
  await fs.writeFile(path.join(p.root, 'openspec/changes/work/tasks.md'), [1, 2, 3].map(i => `- [ ] 1.${i} Task ${i}\n`).join(''));
  const store = await helperWithGit('workflow-state-store.mjs', p.git), key = `benchmark-test-${randomUUID()}`;
  globalThis[key] = store;
  const execution = await helperWithGit('execution-state.mjs', null, false, source => source.replace(/import\('[^']+\/workflow-state-store\.mjs'\)/, `Promise.resolve(globalThis[${JSON.stringify(key)}])`));
  t.after(() => delete globalThis[key]);
  return { api: { store, execution }, fixture: { root: p.root, target: 'data/a.txt', manifest: { leaves: ['data/a.txt', 'data/b.txt', 'data/c.txt'].map(path => ({ path })) } } };
}
for (const id of ['S-m0-l100-lifecycle', 'S-m0-l100-result-replay', 'S-m0-l100-accept-replay', 'B-k3-123', 'B-k3-321', 'B-k3-replay', 'H-c1-small', 'H-c1-large', 'H-c1-active', 'N-interrupted'])
test(`real execution APIs drive harness operation ${id} without Git subprocesses`, async t => {
  const { api, fixture } = await apiFixture(t), scenario = catalog.scenarios.find(s => s.id === id);
  await prepare(api, fixture, scenario);
  const result = await operation(api, fixture, scenario);
  assert.ok(result); if (scenario.family === 'S' || scenario.family === 'B') assert.ok(result.version >= 3);
});
test('matrix retains NOTRUN-sandbox rows when fixture Git is unavailable', async t => {
  const arms = ['A0', 'A-first'].map(name => ({ name, root: path.resolve('.'), identity }));
  // A fixture probe is allowed only in owned temporary space. A working host exercises the full fixture below instead.
  try { const fixture = await createFixture(catalog.scenarios[0]); await fixture.cleanup(); return t.skip('Git available; sandbox-only branch not applicable'); }
  catch (e) { if (e.code !== 'EPERM' && e.code !== 'ENOENT') throw e; }
  const result = await runMatrix({ arms, catalog, selected: [catalog.scenarios[0].id] });
  assert.equal(result.status, 'NOTRUN'); assert.equal(result.rows.length, 42);
  assert.ok(result.rows.every(r => r.wall_ms === null && r.code === 'NOTRUN-sandbox'));
  assert.deepEqual(validateResults(result), []);
  const bad = structuredClone(result); bad.rows[0].wall_ms = 0; assert.notDeepEqual(validateResults(bad), []);
  const forged = structuredClone(result); forged.status = 'PASS';
  for (const group of forged.summaries) { group.status = 'PASS'; group.safety = 'PASS'; group.equivalence = true; }
  assert.notDeepEqual(validateResults(forged), [], 'supplied summaries cannot upgrade missing measurements');
  const duplicate = structuredClone(result); duplicate.rows[1].repeat = duplicate.rows[0].repeat;
  assert.notDeepEqual(validateResults(duplicate), [], 'duplicate repeats are not independent samples');
});
for (const id of ['N-bytes', 'N-ignored', 'N-scope', 'N-hardlink', 'N-identity-replacement'])
test(`negative operation ${id} records blocking outcome or documented A0 gap`, async t => {
  const { api, fixture } = await apiFixture(t), scenario = catalog.scenarios.find(s => s.id === id);
  await prepare(api, fixture, scenario);
  if (scenario.baseline_gap && !(await api.store.storeFor(fixture.root)).readLeaf) {
    // Harness commit is independently runnable on A0. This success is a known
    // safety FAIL in runArm, never an allowlisted PASS in exported results.
    assert.ok((await operation(api, fixture, scenario)).files); return;
  }
  await assert.rejects(operation(api, fixture, scenario), e => scenario.expected_codes.includes(e.code));
});
test('real deterministic fixture verifies exact L and module manifests when Git is available', async t => {
  let fixture;
  try { fixture = await createFixture(catalog.scenarios.find(s => s.id === 'W-m2-l100-directory')); }
  catch (e) { if (e.code === 'EPERM') return t.skip('NOTRUN-sandbox: Git child process unavailable'); throw e; }
  try {
    assert.equal(fixture.manifest.leaves.length, 100); assert.equal(fixture.manifest.repositories.length, 3);
    const before = fixture.manifest.digest; await fs.writeFile(path.join(fixture.root, fixture.target), 'modified'); await fixture.reset();
    assert.equal((await manifest(fixture.root, fixture.env, fixture.modules)).digest, before);
    assert.equal(sha256('x').length, 64);
  } finally { await fixture.cleanup(); }
});
