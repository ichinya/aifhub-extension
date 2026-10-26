import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { digest, storeFor } from './workflow-state-store.mjs';
import { fakeRepository, helperWithGit } from './fixtures/snapshot-test.mjs';

test('names-only inventory has no content opens and default inventory preserves hashes', async t => {
  const p = await fakeRepository(t), store = await storeFor(p.root), original = fs.open; let opens = 0;
  fs.open = async (...args) => { opens++; return original(...args); }; syncBuiltinESMExports();
  try {
    assert.deepEqual({ ...await store.inventory('data', { namesOnly: true }) }, { 'data/a.txt': null });
    assert.equal(opens, 0);
    assert.deepEqual({ ...await store.inventory('data') }, { 'data/a.txt': digest('initial\n') }); assert.equal(opens, 1);
  } finally { fs.open = original; syncBuiltinESMExports(); }
});
test('overlapping scopes read once, preserve reference/projection digest and missing tracked null', async t => {
  const p = await fakeRepository(t, ['data/a.txt', 'data/deleted.txt']); await fs.unlink(path.join(p.root, 'data/deleted.txt'));
  const api = await helperWithGit('workflow-state-store.mjs', p.git), store = await api.storeFor(p.root);
  const original = store.readLeaf, counts = {};
  store.readLeaf = async name => { counts[name] = (counts[name] ?? 0) + 1; return original(name); };
  const tree = await api.worktree(store, ['data', 'data/a.txt']);
  assert.deepEqual(counts, { 'data/a.txt': 1, 'data/deleted.txt': 1 });
  assert.equal(tree.files['data/deleted.txt'], null);
  const mode = (await fs.stat(path.join(p.root, 'data/a.txt'))).mode & 0o111;
  assert.deepEqual(JSON.parse(JSON.stringify(tree)), { head: p.head, branch: 'main', index: digest(`100644 ${'b'.repeat(40)} 0\tdata/a.txt\0`+`100644 ${'b'.repeat(40)} 0\tdata/deleted.txt\0`),
    files: { 'data/a.txt': digest({ content: digest('initial\n'), executable: mode }), 'data/deleted.txt': null } });
  const projection = digest('projected canonical value');
  const projected = await api.worktree(store, ['data'], { 'data/a.txt': projection });
  assert.equal(projected.files['data/a.txt'], digest({ content: projection, executable: mode }));
});
test('ignored in-scope leaf drift remains visible and protected git scope remains rejected', async t => {
  const p = await fakeRepository(t), api = await helperWithGit('workflow-state-store.mjs', p.git), store = await api.storeFor(p.root);
  await fs.mkdir(path.join(p.root, 'ignored')); await fs.writeFile(path.join(p.root, 'ignored/input'), 'one');
  const first = await api.worktree(store, ['ignored']); await fs.writeFile(path.join(p.root, 'ignored/input'), 'two');
  const second = await api.worktree(store, ['ignored']);
  assert.notEqual(first.files['ignored/input'], second.files['ignored/input']);
  await assert.rejects(api.worktree(store, ['.git/HEAD']), { code: 'protected-scope' });
});

for (const variant of ['same-length', 'growth', 'shrink', 'mode', 'mode-fstat', 'ancestor-identity', 'pathname', 'directory', 'hardlink', 'symlink', 'unknown-identity', 'read-error'])
test(`authoritative read rejects ${variant} at a deterministic boundary and closes fd`, async t => {
  if (variant === 'mode' && process.platform === 'win32') return t.skip('POSIX executable mode unavailable on Windows');
  if (variant === 'directory' && process.platform === 'win32') return t.skip('Windows denies renaming a directory containing an open fd; execute POSIX race on Linux');
  const p = await fakeRepository(t), store = await storeFor(p.root), filename = path.join(p.root, 'data/a.txt');
  const originalOpen = fs.open, originalLstat = fs.lstat; let closed = false, hit = false, capabilityUnavailable = false;
  if (variant === 'ancestor-identity') fs.lstat = async (...args) => {
    const info = await originalLstat(...args);
    if (hit && args[1]?.bigint && path.resolve(String(args[0])) === path.dirname(filename)) info.ino += 1n;
    return info;
  };
  fs.open = async (...args) => {
    const fd = await originalOpen(...args);
    if (path.resolve(String(args[0])) !== filename) return fd;
    const read = fd.read.bind(fd), stat = fd.stat.bind(fd), close = fd.close.bind(fd); let stats = 0;
    fd.close = async () => { closed = true; return close(); };
    fd.stat = async (...options) => {
      const result = await stat(...options); stats++;
      if (variant === 'unknown-identity') { hit = true; result.ino = 0n; }
      if (stats === 2 && variant === 'mode-fstat') { hit = true; result.mode ^= 0o111n; }
      if (stats === 2 && variant === 'mode') { hit = true; await fs.chmod(filename, 0o755); return stat(...options); }
      return result;
    };
    fd.read = async (...params) => {
      const result = await read(...params);
      if (hit || !result.bytesRead) return result;
      hit = true;
      if (variant === 'same-length') await fs.writeFile(filename, 'changed\n');
      if (variant === 'growth') await fs.appendFile(filename, 'growth');
      if (variant === 'shrink') await fs.truncate(filename, 1);
      if (variant === 'pathname') { await fs.rename(filename, filename+'.old'); await fs.writeFile(filename, 'initial\n'); }
      if (variant === 'directory') { await fs.rename(path.dirname(filename), path.dirname(filename)+'-old'); await fs.mkdir(path.dirname(filename)); await fs.writeFile(filename, 'initial\n'); }
      if (variant === 'hardlink') await fs.link(filename, filename+'.link');
      if (variant === 'symlink') { await fs.rename(filename, filename+'.old'); await fs.symlink(filename+'.old', filename); }
      if (variant === 'read-error') throw new Error('injected-read');
      return result;
    };
    return fd;
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(store.readLeaf('data/a.txt'), e => {
      if (variant === 'symlink' && e.code === 'EPERM') { capabilityUnavailable = true; return true; }
      return variant === 'read-error' ? e.message === 'injected-read' : ['file-changed', 'unsafe-filesystem-entry', 'unsupported-file-identity'].includes(e.code);
    });
    assert.equal(hit, true); assert.equal(closed, true);
    if (capabilityUnavailable) t.skip('NOTRUN-platform: symlink creation privilege unavailable');
  } finally { fs.open = originalOpen; fs.lstat = originalLstat; syncBuiltinESMExports(); }
});
test('replacement immediately after open is bound before content acquisition', async t => {
  const p = await fakeRepository(t), store = await storeFor(p.root), original = fs.open; let closed = false;
  fs.open = async (...args) => {
    const fd = await original(...args), close = fd.close.bind(fd); fd.close = async () => { closed = true; return close(); };
    await fs.rename(args[0], `${args[0]}.old`); await fs.writeFile(args[0], 'initial\n'); return fd;
  }; syncBuiltinESMExports();
  try { await assert.rejects(store.readLeaf('data/a.txt'), { code: 'file-changed' }); assert.equal(closed, true); }
  finally { fs.open = original; syncBuiltinESMExports(); }
});
test('16 MiB accepted, limit+1 rejected before payload allocation', async t => {
  const p = await fakeRepository(t), store = await storeFor(p.root), file = path.join(p.root, 'data/a.txt');
  await fs.truncate(file, 16 * 1024 * 1024); assert.equal((await store.readLeaf('data/a.txt')).data.length, 16 * 1024 * 1024);
  await fs.truncate(file, 16 * 1024 * 1024 + 1); await assert.rejects(store.readLeaf('data/a.txt'), { code: 'unsupported-file' });
});
test('per-directory, aggregate scoped and total name bounds are retained before leaf reads', async t => {
  const p = await fakeRepository(t), api = await helperWithGit('workflow-state-store.mjs', p.git), store = await api.storeFor(p.root);
  const original = fs.readdir;
  fs.readdir = async () => Array.from({ length: 10001 }, (_, n) => ({ name: `file-${n}` })); syncBuiltinESMExports();
  try { await assert.rejects(store.inventory('data', { namesOnly: true }), { code: 'too-many-files' }); }
  finally { fs.readdir = original; syncBuiltinESMExports(); }
  store.inventory = async scope => Object.fromEntries(Array.from({ length: 5001 }, (_, n) => [`${scope}/file-${n}`, null]));
  let reads = 0; store.readLeaf = async () => { reads++; throw new Error('unexpected-read'); };
  await assert.rejects(api.worktree(store, ['one', 'two']), { code: 'too-many-files' }); assert.equal(reads, 0);
  const many = await helperWithGit('workflow-state-store.mjs', async (command, args) => args.includes('--cached')
    ? { stdout: Buffer.from(Array.from({ length: 20001 }, (_, n) => `data/file-${n}`).join('\0')+'\0') }
    : args.includes('--stage') ? { stdout: Buffer.alloc(0) } : p.git(command, args));
  await assert.rejects(many.worktree(await many.storeFor(p.root)), { code: 'too-many-files' });
});
