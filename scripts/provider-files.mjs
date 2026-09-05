import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readdir, realpath, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { runProviderProcess } from './provider-process.mjs';

export const digest = (value) => createHash('sha256').update(value).digest('hex');
export const safeId = (value) => typeof value === 'string'
  && /^[a-z0-9][a-z0-9-]{0,99}$/.test(value);

export async function safeProviderPath(rootDir, relative) {
  if (typeof relative !== 'string' || !relative || relative.includes('\\') || relative.includes(':')
    || relative.split('/').some((part) => !part || part === '.' || part === '..')
    || /[\x00-\x1f]/.test(relative)) throw new Error('unsafe_path');
  const root = await realpath(rootDir);
  let current = root;
  const parts = relative.split('/');
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]);
    let stat;
    try { stat = await lstat(current); } catch (error) {
      if (error.code === 'ENOENT') return { path: path.join(root, ...parts), exists: false };
      throw new Error('path_unreadable');
    }
    if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink !== 1)
      || (!stat.isFile() && !stat.isDirectory())
      || (index < parts.length - 1 && !stat.isDirectory())
      || path.resolve(await realpath(current)) !== path.resolve(current)) throw new Error('unsafe_path');
  }
  return { path: current, exists: true };
}

export async function readProviderFile(rootDir, relative, limit = 1024 * 1024) {
  const target = await safeProviderPath(rootDir, relative);
  if (!target.exists) return null;
  const handle = await open(target.path, 'r');
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size > limit) throw new Error('unsafe_file');
    const bytes = Buffer.alloc(limit + 1);
    let count = 0;
    while (count <= limit) {
      const result = await handle.read(bytes, count, bytes.length - count, null);
      if (!result.bytesRead) break;
      count += result.bytesRead;
      if (count > limit) throw new Error('file_limit');
    }
    const after = await handle.stat();
    const checked = await safeProviderPath(rootDir, relative);
    const live = await lstat(checked.path);
    if (before.ino !== live.ino || before.dev !== live.dev || before.mtimeMs !== after.mtimeMs
      || before.size !== after.size) throw new Error('file_changed');
    return bytes.subarray(0, count);
  } finally { await handle.close(); }
}

export async function writeProviderFile(rootDir, relative, evidence) {
  const serialized = `${JSON.stringify(evidence, null, 2)}\n`;
  const previous = await readProviderFile(rootDir, relative, 4 * 1024 * 1024);
  if (previous !== null) {
    try {
      const old = JSON.parse(previous.toString('utf8'));
      const comparable = { ...old, timestamp: evidence.timestamp };
      if (JSON.stringify(comparable) === JSON.stringify(evidence)) return old;
    } catch { /* Replace malformed derived evidence after path preflight. */ }
  }
  const target = await safeProviderPath(rootDir, relative);
  await mkdir(path.dirname(target.path), { recursive: true });
  await safeProviderPath(rootDir, relative);
  const temporary = `${relative}.${randomUUID()}.tmp`;
  const temporaryPath = await safeProviderPath(rootDir, temporary);
  const handle = await open(temporaryPath.path, 'wx', 0o600);
  try { await handle.writeFile(serialized, 'utf8'); } finally { await handle.close(); }
  try {
    await safeProviderPath(rootDir, relative);
    await safeProviderPath(rootDir, temporary);
    await rename(temporaryPath.path, target.path);
  } finally {
    try { await unlink(temporaryPath.path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return evidence;
}

// Include ignored canonical artifacts explicitly; QA/state are excluded from the binding.
export async function providerRevision(rootDir, options = {}) {
  const run = options.runProcess ?? runProviderProcess;
  const head = await run('git', ['rev-parse', '--verify', 'HEAD'], { cwd: rootDir, timeoutMs: 10000 });
  const inventory = await run('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { cwd: rootDir, timeoutMs: 10000, maxOutputBytes: 4 * 1024 * 1024 });
  if (head.outcome !== 'completed' || head.exitCode !== 0 || !/^[a-f0-9]{40,64}$/.test(head.stdout.trim())
    || inventory.outcome !== 'completed' || inventory.exitCode !== 0) throw new Error('revision_unavailable');
  const files = new Set(inventory.stdout.split('\0').filter(Boolean));
  const excluded = (value) => /^(?:\.git|\.ai-factory\/(?:qa|state|rules\/generated))(?:\/|$)/.test(value);
  let count = 0;
  const visit = async (relative) => {
    if (++count > 20000) throw new Error('inventory_limit');
    const target = await safeProviderPath(rootDir, relative);
    if (!target.exists) return;
    const stat = await lstat(target.path);
    if (stat.isFile()) { files.add(relative); return; }
    for (const entry of await readdir(target.path)) await visit(`${relative}/${entry}`);
  };
  for (const relative of ['openspec', '.hlv', 'lekalo', 'project.yaml', '.ai-factory/config.yaml']) await visit(relative);
  const hash = createHash('sha256');
  let total = 0;
  for (const relative of [...files].filter((value) => !excluded(value)).sort()) {
    const bytes = await readProviderFile(rootDir, relative, 16 * 1024 * 1024);
    total += bytes?.length ?? 0;
    if (total > 256 * 1024 * 1024) throw new Error('inventory_limit');
    const mode = bytes === null ? null : (await lstat((await safeProviderPath(rootDir, relative)).path)).mode & 0o777;
    hash.update(JSON.stringify([relative, mode, bytes === null ? 'missing' : digest(bytes)]));
  }
  return { commit: head.stdout.trim(), worktree: hash.digest('hex') };
}
