// Local workflow bookkeeping, not a security boundary against another OS process.
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, realpath, mkdir, open, rename, unlink, readdir } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const exec = promisify(execFile);
const LIMIT = 16 * 1024 * 1024;
export class WorkflowError extends Error {
  constructor(code, blocked = false) { super(code); this.code = code; this.blocked = blocked; }
}
export function requireValue(condition, code = 'invalid-input', blocked = false) {
  if (!condition) throw new WorkflowError(code, blocked);
}
export const digest = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : canonical(value)).digest('hex');
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
export function boundedText(value, max = 2000) {
  requireValue(typeof value === 'string' && value.trim().length > 0 && value.length <= max && !value.includes('\0'));
  return value;
}
export function identifier(value) {
  requireValue(typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(value));
  portablePath(value);
  return value;
}
export function portablePath(value) {
  requireValue(typeof value === 'string' && value.length > 0 && value.length <= 500 && !/[\\:\x00-\x1f<>"|?*]/.test(value), 'unsafe-path');
  const parts = value.split('/');
  requireValue(parts.every(p => p && p !== '.' && p !== '..' && !/[. ]$/.test(p) && !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(p)), 'unsafe-path');
  return value;
}
export function fields(input, required, optional = []) {
  requireValue(input && typeof input === 'object' && !Array.isArray(input));
  requireValue(required.every(k => Object.hasOwn(input, k)) && Object.keys(input).every(k => [...required, ...optional].includes(k)));
}
export function stringList(value, max = 100) {
  requireValue(Array.isArray(value) && value.length <= max && value.every(x => typeof x === 'string') && new Set(value).size === value.length);
  return value;
}

export async function storeFor(rootDir = process.cwd()) {
  const root = await realpath(path.resolve(rootDir));
  async function target(relative, makeParents = false) {
    const parts = portablePath(relative).split('/');
    let current = root;
    for (let i = 0; i < parts.length; i++) {
      current = path.join(current, parts[i]);
      let info;
      try { info = await lstat(current); } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        if (makeParents && i < parts.length - 1) {
          try { await mkdir(current); } catch (e) { if (e.code !== 'EEXIST') throw e; }
          info = await lstat(current);
        } else continue;
      }
      requireValue(!info.isSymbolicLink(), 'unsafe-filesystem-entry');
      requireValue(i === parts.length - 1 ? (info.isDirectory() || (info.isFile() && info.nlink === 1)) : info.isDirectory(), 'unsafe-filesystem-entry');
    }
    return current;
  }
  async function bytes(relative) {
    const filename = await target(relative);
    let file;
    try { file = await open(filename, 'r'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
    try {
      const before = await file.stat();
      requireValue(before.isFile() && before.nlink === 1 && before.size <= LIMIT, 'unsupported-file');
      const buffer = Buffer.alloc(before.size + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      const data = buffer.subarray(0, length);
      const after = await file.stat();
      requireValue(length === before.size && before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs, 'file-changed', true);
      await target(relative);
      return data;
    } finally { await file.close(); }
  }
  async function textFile(relative) {
    const data = await bytes(relative);
    if (data === null) return null;
    try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data); } catch { throw new WorkflowError('invalid-utf8'); }
  }
  async function write(relative, data) {
    requireValue(Buffer.byteLength(data) <= LIMIT, 'state-too-large');
    const filename = await target(relative, true);
    const temporary = `${relative}.${randomUUID()}.tmp`;
    const tempPath = await target(temporary);
    const handle = await open(tempPath, 'wx', 0o600);
    try { await handle.writeFile(data, 'utf8'); await handle.sync(); } finally { await handle.close(); }
    try { await target(relative); await rename(tempPath, filename); }
    finally { await unlink(tempPath).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
  }
  async function save(relative, record) {
    await write(relative, JSON.stringify({ checksum: digest(record), record }, null, 2) + '\n');
  }
  async function load(relative) {
    const value = await textFile(relative);
    if (value === null) return null;
    let envelope;
    try { envelope = JSON.parse(value); } catch { throw new WorkflowError('invalid-state'); }
    requireValue(envelope?.record && envelope.checksum === digest(envelope.record), 'invalid-state');
    return envelope.record;
  }
  async function lock(relative, action) {
    const filename = await target(relative, true);
    let handle;
    try { handle = await open(filename, 'wx', 0o600); }
    catch (e) { if (e.code === 'EEXIST') throw new WorkflowError('state-locked', true); throw e; }
    try { await handle.writeFile(JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() })); return await action(); }
    finally { await handle.close(); await unlink(filename); }
  }
  async function inventory(relative) {
    const filename = await target(relative);
    let info;
    try { info = await lstat(filename); } catch (e) { if (e.code === 'ENOENT') return {}; throw e; }
    if (info.isFile()) return { [relative]: digest(await bytes(relative)) };
    const entries = await readdir(filename, { withFileTypes: true });
    requireValue(entries.length <= 10000, 'too-many-files');
    const result = Object.create(null);
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      Object.assign(result, await inventory(`${relative}/${entry.name}`));
      requireValue(Object.keys(result).length <= 10000, 'too-many-files');
    }
    return result;
  }
  return { root, target, bytes, textFile, write, save, load, lock, inventory,
    async remove(relative) { await unlink(await target(relative)); },
    async references(paths) {
      const refs = Object.create(null);
      for (const ref of stringList(paths)) {
        const data = await bytes(portablePath(ref));
        requireValue(data !== null, 'missing-evidence', true);
        refs[ref] = digest(data);
      }
      return refs;
    },
  };
}

export async function worktree(store, scopes = [], projections = {}) {
  async function git(args) {
    try { return (await exec('git', args, { cwd: store.root, encoding: 'buffer', maxBuffer: LIMIT, windowsHide: true })).stdout; }
    catch { throw new WorkflowError('git-unavailable'); }
  }
  const root = (await git(['rev-parse', '--show-toplevel'])).toString('utf8').trim();
  requireValue(await realpath(root) === store.root, 'project-root-required');
  const head = (await git(['rev-parse', '--verify', 'HEAD'])).toString('utf8').trim();
  const branch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'])).toString('utf8').trim();
  const index = digest(await git(['ls-files', '--stage', '-z']));
  const scopedFiles = Object.create(null);
  for (const scope of scopes) Object.assign(scopedFiles, await store.inventory(scope));
  const names = [...new Set([...(await git(['ls-files', '--cached', '--others', '--exclude-standard', '-z'])).toString('utf8').split('\0').filter(Boolean), ...Object.keys(scopedFiles)])].sort();
  requireValue(names.length <= 20000, 'too-many-files');
  const files = Object.create(null);
  for (const name of names) {
    // Runtime state and evidence have separate identities. Canonical OpenSpec stays in the snapshot.
    if (name.toLowerCase().startsWith('.ai-factory/')) continue;
    const data = await store.bytes(name);
    const mode = data === null ? null : (await lstat(await store.target(name))).mode & 0o111;
    files[name] = data === null ? null : digest({ content: Object.hasOwn(projections, name) ? projections[name] : digest(data), executable: mode });
  }
  return { head, branch, index, files };
}
export const changedFiles = (before, after) => [...new Set([...Object.keys(before.files), ...Object.keys(after.files)])]
  .filter(p => (before.files[p] ?? null) !== (after.files[p] ?? null)).sort();

// Both installed helpers accept bounded JSON on stdin; no shell interpolation of model text.
export async function cliMain(moduleUrl, execute) {
  if (!process.argv[1] || pathToFileURL(path.resolve(process.argv[1])).href !== moduleUrl) return;
  try {
    const [action, ...args] = process.argv.slice(2);
    requireValue(typeof action === 'string' && args.every(x => x === '--json') && args.length <= 1, 'invalid-arguments');
    const chunks = []; let length = 0;
    for await (const chunk of process.stdin) { length += chunk.length; requireValue(length <= 1024 * 1024, 'input-too-large'); chunks.push(chunk); }
    let input;
    try { input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
    catch { throw new WorkflowError('invalid-json'); }
    const result = await execute(action, input);
    process.stdout.write(JSON.stringify({ ok: true, ...result }) + '\n');
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, code: error instanceof WorkflowError ? error.code : 'workflow-error' }) + '\n');
    process.exitCode = error instanceof WorkflowError && error.blocked ? 1 : 2;
  }
}
