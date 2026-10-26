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
  async function target(relative, makeParents = false, identities = null) {
    const parts = portablePath(relative).split('/');
    let current = root;
    for (let i = 0; i < parts.length; i++) {
      current = path.join(current, parts[i]);
      let info;
      try { info = await lstat(current, identities ? { bigint: true } : undefined); } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        if (makeParents && i < parts.length - 1) {
          try { await mkdir(current); } catch (e) { if (e.code !== 'EEXIST') throw e; }
          info = await lstat(current);
        } else continue;
      }
      requireValue(!info.isSymbolicLink(), 'unsafe-filesystem-entry');
      requireValue(i === parts.length - 1 ? (info.isDirectory() || (info.isFile() && info.nlink === (identities ? 1n : 1))) : info.isDirectory(), 'unsafe-filesystem-entry');
      if (identities && i < parts.length - 1) identities.push([info.dev, info.ino]);
    }
    return current;
  }
  // Bind content and mode to one open file, then revalidate its pathname.
  async function readLeaf(relative) {
    const ancestors = [], filename = await target(relative, false, ancestors);
    async function revalidate() {
      const current = [], checked = await target(relative, false, current);
      requireValue(current.length === ancestors.length && current.every((entry, i) => entry[0] === ancestors[i][0] && entry[1] === ancestors[i][1]), 'file-changed', true);
      return checked;
    }
    let file;
    try { file = await open(filename, 'r'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
    try {
      const before = await file.stat({ bigint: true });
      requireValue(before.isFile() && before.nlink === 1n && before.size <= BigInt(LIMIT), 'unsupported-file');
      const matches = info => info.isFile() && !info.isSymbolicLink() && info.nlink === 1n
        && info.dev === before.dev && info.ino === before.ino;
      requireValue(typeof before.dev === 'bigint' && typeof before.ino === 'bigint' && before.ino > 0n, 'unsupported-file-identity');
      const opened = await lstat(filename, { bigint: true }).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
      requireValue(opened && matches(opened), 'file-changed', true);
      const buffer = Buffer.alloc(Number(before.size) + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      const data = buffer.subarray(0, length);
      const after = await file.stat({ bigint: true });
      requireValue(after.isFile() && after.nlink === 1n && before.dev === after.dev && before.ino === after.ino
        && BigInt(length) === before.size && before.size === after.size && before.mtimeNs === after.mtimeNs
        && before.ctimeNs === after.ctimeNs && before.mode === after.mode, 'file-changed', true);
      const named = await lstat(await revalidate(), { bigint: true }).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
      requireValue(named && matches(named) && named.size === after.size && named.mode === after.mode
        && named.mtimeNs === after.mtimeNs && named.ctimeNs === after.ctimeNs, 'file-changed', true);
      return { data, mode: Number(before.mode & 0o111n), permissions: Number(before.mode & 0o777n) };
    } finally { await file.close(); }
  }
  async function bytes(relative) { return (await readLeaf(relative))?.data ?? null; }
  async function textFile(relative) {
    const data = await bytes(relative);
    if (data === null) return null;
    try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data); } catch { throw new WorkflowError('invalid-utf8'); }
  }
  async function write(relative, data, mode = null) {
    requireValue(mode === null || (Number.isInteger(mode) && mode >= 0 && mode <= 0o777), 'invalid-file-mode');
    requireValue(Buffer.byteLength(data) <= LIMIT, 'state-too-large');
    const filename = await target(relative, true);
    const temporary = `${relative}.${randomUUID()}.tmp`;
    const tempPath = await target(temporary);
    const handle = await open(tempPath, 'wx', 0o600);
    try { await handle.writeFile(data, 'utf8'); if (mode !== null) await handle.chmod(mode); await handle.sync(); } finally { await handle.close(); }
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
  async function inventory(relative, { excludeGit = false, namesOnly = false } = {}) {
    const filename = await target(relative);
    let info;
    try { info = await lstat(filename); } catch (e) { if (e.code === 'ENOENT') return {}; throw e; }
    if (info.isFile()) return { [relative]: namesOnly ? null : digest(await bytes(relative)) };
    const entries = await readdir(filename, { withFileTypes: true });
    requireValue(entries.length <= 10000, 'too-many-files');
    const result = Object.create(null);
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (excludeGit && entry.name.toLowerCase() === '.git') continue;
      Object.assign(result, await inventory(`${relative}/${entry.name}`, { excludeGit, namesOnly }));
      requireValue(Object.keys(result).length <= 10000, 'too-many-files');
    }
    return result;
  }
  return { root, target, bytes, readLeaf, textFile, write, save, load, lock, inventory,
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
  async function git(cwd, args) {
    try { return (await exec('git', args, { cwd, encoding: 'buffer', maxBuffer: LIMIT, windowsHide: true })).stdout; }
    catch { throw new WorkflowError('git-unavailable'); }
  }
  const inside = (base, filename) => { const rel = path.relative(base, filename); return !path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..'+path.sep); };
  async function safeDirectory(filename) {
    let current = path.parse(filename).root;
    for (const part of filename.slice(current.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      const info = await lstat(current);
      requireValue(info.isDirectory() && !info.isSymbolicLink(), 'unsafe-submodule');
    }
    const info = await lstat(filename);
    return { path: await realpath(filename), device: info.dev, inode: info.ino };
  }
  async function safeAdminFile(filename, required = false) {
    await safeDirectory(path.dirname(filename));
    const info = await lstat(filename).catch(e => { if (e.code === 'ENOENT' && !required) return null; throw e; });
    requireValue(!info || (info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && info.size <= LIMIT), 'unsafe-submodule');
  }
  async function inspect(prefix, trustedAdmins, includeFiles = true) {
    const cwd = prefix ? await store.target(prefix) : store.root;
    let marker = null, ownAdmin = null;
    if (prefix) {
      const markerPath = await store.target(`${prefix}/.git`);
      const info = await lstat(markerPath).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
      requireValue(info, 'uninitialized-submodule');
      requireValue((await lstat(cwd)).isDirectory(), 'unsafe-submodule');
      if (info.isDirectory()) ownAdmin = await safeDirectory(markerPath);
      else {
        const data = await store.bytes(`${prefix}/.git`);
        const match = /^gitdir: ([^\r\n]+)\r?\n?$/.exec(data.toString('utf8'));
        requireValue(match, 'unsafe-submodule');
        const admin = path.resolve(cwd, match[1]);
        requireValue(trustedAdmins.some(base => inside(base, admin)), 'unsafe-submodule');
        await safeDirectory(admin);
        marker = digest(data);
      }
    }
    const identity = (await git(cwd, ['rev-parse', '--show-toplevel', '--absolute-git-dir', '--git-common-dir', 'HEAD', '--abbrev-ref', 'HEAD'])).toString('utf8').replace(/\r?\n$/, '').split(/\r?\n/);
    requireValue(identity.length === 5 && identity.every(line => line.length > 0 && !/[\r\0]/.test(line))
      && path.isAbsolute(identity[0]) && path.isAbsolute(identity[1]) && /^[a-f0-9]{40,64}$/.test(identity[3])
      // Git ref names permit Unicode letters such as U+00A0; forbid only what git itself rejects.
      && !/[\x00-\x20\x7f~^:?*[\\]/.test(identity[4]), 'invalid-git-identity');
    const [top, gitDirPath, commonDirPath, head, branch] = identity;
    requireValue(await realpath(top) === cwd, prefix ? 'unsafe-submodule' : 'project-root-required');
    const gitDir = path.resolve(cwd, gitDirPath), commonDir = path.resolve(cwd, commonDirPath);
    for (const dir of [gitDir, commonDir]) requireValue(!prefix || trustedAdmins.some(base => inside(base, dir)) || (ownAdmin && inside(ownAdmin.path, dir)), 'unsafe-submodule');
    const admin = await safeDirectory(gitDir), common = await safeDirectory(commonDir), checkout = await safeDirectory(cwd);
    await safeAdminFile(path.join(gitDir, 'HEAD'), true);
    for (const filename of [path.join(gitDir, 'index'), path.join(gitDir, 'commondir'), path.join(commonDir, 'config'), path.join(commonDir, 'packed-refs')]) await safeAdminFile(filename);
    const [stages, namesBytes] = await Promise.all([
      git(cwd, ['ls-files', '--stage', '-z']), includeFiles ? git(cwd, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']) : Buffer.alloc(0),
    ]);
    const entries = stages.toString('utf8').split('\0').filter(Boolean).map(row => {
      // The `s` flag keeps Unicode line-separator names (accepted by portablePath) parseable.
    const match = /^(\d{6}) ([a-f0-9]{40,64}) ([0-3])\t(.+)$/s.exec(row);
      requireValue(match, 'invalid-git-index');
      return { mode: match[1], oid: match[2], stage: match[3], name: portablePath(match[4]) };
    });
    requireValue(entries.length <= 20000, 'too-many-files');
    const links = entries.filter(e => e.mode === '160000');
    requireValue(links.every(e => e.stage === '0'), 'unmerged-submodule');
    return { head, branch, index: digest(stages), repository: digest({ checkout, admin, common, marker }), adminPaths: [admin.path, common.path], links,
      names: namesBytes.toString('utf8').split('\0').filter(Boolean) };
  }
  const modules = Object.create(null), repositories = [], names = new Set(), adminIdentities = new Set();
  async function collect(prefix = '', gitlink = null, depth = 0, trustedAdmins = []) {
    requireValue(depth <= 20 && repositories.length <= 100, 'too-many-submodules');
    const info = await inspect(prefix, trustedAdmins); repositories.push({ prefix, info, trustedAdmins });
    requireValue(!adminIdentities.has(info.repository), 'unsafe-submodule'); adminIdentities.add(info.repository);
    if (prefix) modules[prefix] = { head: info.head, branch: info.branch, index: info.index, repository: info.repository, gitlink };
    const links = new Set(info.links.map(e => e.name));
    for (const name of info.names) {
      if (links.has(name)) continue;
      names.add(portablePath(prefix ? `${prefix}/${name}` : name));
      requireValue(names.size <= 20000, 'too-many-files');
    }
    for (const link of info.links) await collect(prefix ? `${prefix}/${link.name}` : link.name, link.oid, depth + 1, [...new Set([...trustedAdmins, ...info.adminPaths])]);
  }
  await collect();
  const scopedFiles = Object.create(null);
  for (const scope of scopes) {
    requireValue(!portablePath(scope).split('/').some(p => p.toLowerCase() === '.git'), 'protected-scope');
    Object.assign(scopedFiles, await store.inventory(scope, { excludeGit: true, namesOnly: true }));
  }
  // The per-inventory bound is not a combined budget: scoped entries share one aggregate limit.
  requireValue(Object.keys(scopedFiles).length <= 10000, 'too-many-files');
  for (const name of Object.keys(scopedFiles)) names.add(name);
  requireValue(names.size <= 20000, 'too-many-files');
  const files = Object.create(null);
  for (const name of [...names].sort()) {
    // Runtime state and evidence have separate identities. Canonical OpenSpec stays in the snapshot.
    if (name.toLowerCase().startsWith('.ai-factory/')) continue;
    const leaf = await store.readLeaf(name);
    files[name] = leaf === null ? null : digest({ content: Object.hasOwn(projections, name) ? projections[name] : digest(leaf.data), executable: leaf.mode });
  }
  // Do not publish a mixture if Git metadata changes while leaf files are read.
  for (const { prefix, info, trustedAdmins } of repositories) {
    const after = await inspect(prefix, trustedAdmins, false);
    requireValue(sameRevision(info, after) && info.repository === after.repository, 'stale-revision', true);
  }
  const { head, branch, index } = repositories[0].info;
  return { head, branch, index, files, ...(Object.keys(modules).length ? { submodules: modules } : {}) };
}
export const sameRevision = (before, after) => before.head === after.head && before.branch === after.branch && before.index === after.index
  && canonical(before.submodules ?? {}) === canonical(after.submodules ?? {});
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
