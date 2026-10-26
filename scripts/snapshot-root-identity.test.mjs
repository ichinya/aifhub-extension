import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fakeRepository, helperWithGit } from './fixtures/snapshot-test.mjs';
for (const variant of ['normal', 'relative-common', 'linked', 'detached']) test(`root first inspect supplies common dir: ${variant}`, async t => {
  const p = await fakeRepository(t); let count = 0;
  const common = variant === 'linked' ? path.join(p.root, 'common admin') : path.join(p.root, '.git');
  await fs.mkdir(common, { recursive: true });
  const api = await helperWithGit('workflow-state-store.mjs', async (cmd, args) => {
    count++;
    if (args[0] !== 'rev-parse') return p.git(cmd, args);
    return { stdout: Buffer.from(`${p.root}\n${path.join(p.root, '.git')}\n${variant === 'relative-common' ? '.git' : common}\n${p.head}\n${variant === 'detached' ? 'HEAD' : 'main'}\n`) };
  });
  const tree = await api.worktree(await api.storeFor(p.root));
  assert.equal(count, 5); assert.equal(tree.branch, variant === 'detached' ? 'HEAD' : 'main');
});
for (const shape of ['missing', 'extra', 'blank', 'trailing-blank', 'invalid-head']) test(`root combined rejects ${shape}`, async t => {
  const p = await fakeRepository(t); let lines = [p.root, path.join(p.root, '.git'), '.git', p.head, 'main'];
  if (shape === 'missing') lines.pop(); if (shape === 'extra') lines.push('extra'); if (shape === 'blank') lines[2] = '';
  if (shape === 'invalid-head') lines[3] = 'invalid';
  const api = await helperWithGit('workflow-state-store.mjs', async () => ({ stdout: Buffer.from(lines.join('\n') + (shape === 'trailing-blank' ? '\n\n' : '\n')) }));
  await assert.rejects(api.worktree(await api.storeFor(p.root)), { code: 'invalid-git-identity' });
});
test('branch names with git-permitted Unicode whitespace are accepted', async t => {
  const p = await fakeRepository(t);
  const api = await helperWithGit('workflow-state-store.mjs', async (cmd, args) => {
    if (args[0] !== 'rev-parse') return p.git(cmd, args);
    return { stdout: Buffer.from(`${p.root}\n${path.join(p.root, '.git')}\n.git\n${p.head}\nfeature/a\u00A0b\n`) };
  });
  const tree = await api.worktree(await api.storeFor(p.root));
  assert.equal(tree.branch, 'feature/a\u00A0b');
});
test('branch names with git-forbidden characters are rejected', async t => {
  for (const branch of ['feature/a b', 'feature/a~b', 'feature/a:b']) {
    const p = await fakeRepository(t);
    const api = await helperWithGit('workflow-state-store.mjs', async () => ({ stdout: Buffer.from(`${p.root}\n${path.join(p.root, '.git')}\n.git\n${p.head}\n${branch}\n`) }));
    await assert.rejects(api.worktree(await api.storeFor(p.root)), { code: 'invalid-git-identity' });
  }
});
test('root identity mismatch remains blocked', async t => {
  const p = await fakeRepository(t), api = await helperWithGit('workflow-state-store.mjs', async () => ({ stdout: Buffer.from(`${path.dirname(p.root)}\n${path.join(p.root, '.git')}\n.git\n${p.head}\nmain\n`) }));
  await assert.rejects(api.worktree(await api.storeFor(p.root)), { code: 'project-root-required' });
});
