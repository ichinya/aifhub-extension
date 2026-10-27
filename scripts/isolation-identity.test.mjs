import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fakeRepository, helperWithGit } from './fixtures/snapshot-test.mjs';
for (const shape of ['valid', 'relative-common', 'missing', 'extra', 'blank', 'trailing-blank', 'root-mismatch']) test(`isolation combined identity: ${shape}`, async t => {
  const p = await fakeRepository(t); let calls = 0;
  let lines = [shape === 'root-mismatch' ? path.dirname(p.root) : p.root, path.join(p.root, '.git'), shape === 'relative-common' ? '.git' : path.join(p.root, '.git')];
  if (shape === 'missing') lines.pop(); if (shape === 'extra') lines.push('extra'); if (shape === 'blank') lines[1] = '';
  const api = await helperWithGit('isolated-execution.mjs', async (_cmd, args) => {
    calls++; assert.deepEqual(args, ['rev-parse', '--show-toplevel', '--absolute-git-dir', '--git-common-dir']);
    return { stdout: lines.join('\r\n') + (shape === 'trailing-blank' ? '\r\n\r\n' : '\r\n') };
  }, true);
  if (['valid', 'relative-common'].includes(shape)) {
    assert.deepEqual(await api.testIdentity({ root: p.root }), { root: p.root, git_dir: path.join(p.root, '.git'), common: path.join(p.root, '.git') });
    await api.testIdentity({ root: p.root }); assert.equal(calls, 2, 'separate freshness calls are not memoized');
  } else await assert.rejects(api.testIdentity({ root: p.root }), { code: shape === 'root-mismatch' ? 'project-root-required' : 'invalid-git-identity' });
});
