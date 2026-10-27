import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fakeRepository, helperWithGit } from './fixtures/snapshot-test.mjs';
import * as sourceApi from './execution-task-source.mjs';

async function project(t, mutate = async () => {}) {
  const p = await fakeRepository(t, ['data/a.txt', 'openspec/changes/work/proposal.md', 'openspec/changes/work/tasks.md']);
  await fs.mkdir(path.join(p.root, '.ai-factory')); await fs.writeFile(path.join(p.root, '.ai-factory/config.yaml'), 'aifhub:\n  tools:\n    openspec: true\n');
  await fs.writeFile(path.join(p.root, 'openspec/changes/work/tasks.md'), '- [ ] 1.1 Task\n');
  const api = await helperWithGit('workflow-state-store.mjs', p.git), key = `admission-test-${randomUUID()}`;
  let hit = false, resolutions = 0;
  globalThis[key] = { ...api, storeFor: async root => {
    const store = await api.storeFor(root), read = store.readLeaf;
    store.readLeaf = async name => { const leaf = await read(name); if (name === 'data/a.txt' && !hit) { hit = true; await mutate(p); } return leaf; };
    return store;
  } };
  globalThis[key+'-source'] = { ...sourceApi, resolveExecutionSource: async (...args) => { resolutions++; return sourceApi.resolveExecutionSource(...args); } };
  const execute = await helperWithGit('execution-state.mjs', null, false, source => source
    .replace(/import\('[^']+\/workflow-state-store\.mjs'\)/, `Promise.resolve(globalThis[${JSON.stringify(key)}])`)
    .replace(/import\('[^']+\/execution-task-source\.mjs'\)/, `Promise.resolve(globalThis[${JSON.stringify(key+'-source')}])`));
  t.after(() => { delete globalThis[key]; delete globalThis[key+'-source']; });
  const input = { change_id: 'work', run_id: 'run-1', task_id: '1.1', owner: 'parent', worker: 'worker', role: 'implement', scope: ['data/a.txt'] };
  const call = (options = {}) => execute.executionCommand('start', input, { rootDir: p.root, ...options });
  return { ...p, input, call, resolutions: () => resolutions, hit: () => hit };
}
test('normal start acquires source twice and publishes validated admission', async t => {
  const p = await project(t); const result = await p.call();
  assert.equal(result.version, 1); assert.equal(p.resolutions(), 2); assert.equal(p.hit(), true);
});
for (const variant of ['proposal', 'tasks', 'config', 'new-context', 'final-source-failure']) test(`snapshot interval ${variant} drift leaves no run/source/ledger/journal`, async t => {
  const p = await project(t, async fixture => {
    if (variant === 'proposal') await fs.appendFile(path.join(fixture.root, 'openspec/changes/work/proposal.md'), '\nChanged policy\n');
    if (variant === 'tasks') await fs.writeFile(path.join(fixture.root, 'openspec/changes/work/tasks.md'), '- [x] 1.1 Task\n');
    if (variant === 'config') await fs.appendFile(path.join(fixture.root, '.ai-factory/config.yaml'), '\npaths:\n  description: policy/new.md\n');
    if (variant === 'new-context') { await fs.mkdir(path.join(fixture.root, 'openspec/specs'), { recursive: true }); await fs.writeFile(path.join(fixture.root, 'openspec/specs/new.md'), 'New context\n'); }
    if (variant === 'final-source-failure') await fs.unlink(path.join(fixture.root, 'openspec/changes/work/tasks.md'));
  });
  await assert.rejects(p.call(), e => ['stale-admission', 'missing-tasks'].includes(e.code));
  assert.equal(p.hit(), true); assert.equal(p.resolutions(), 2);
  const files = await fs.readdir(path.join(p.root, '.ai-factory/state'), { recursive: true, withFileTypes: true });
  assert.equal(files.filter(e => e.isFile()).length, 0);
});
test('beforeLock source race still fails final comparison before publication', async t => {
  const p = await project(t);
  await assert.rejects(p.call({ beforeLock: () => fs.appendFile(path.join(p.root, 'openspec/changes/work/tasks.md'), '- [ ] 1.2 Added task\n') }), { code: 'stale-admission' });
  assert.equal(p.resolutions(), 2);
});
test('prepared admission recovery skips the fresh admission source path', async t => {
  const p = await project(t);
  await assert.rejects(p.call({ failpoint: point => { if (point === 'after-journal') throw new Error('interrupted'); } }), /interrupted/);
  const before = p.resolutions(); await fs.writeFile(path.join(p.root, '.ai-factory/config.yaml'), 'invalid: [yaml');
  assert.equal((await p.call()).version, 1); assert.equal(p.resolutions(), before);
});
