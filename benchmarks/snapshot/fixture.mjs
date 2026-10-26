// Disposable synthetic repositories only. Never points at a consumer checkout.
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

const exec = promisify(execFile);
export const sha256 = data => createHash('sha256').update(data).digest('hex');
export const FIXED_DATE = '2026-01-01T00:00:00Z';
export const REVISION = 'snapshot-fixture-1';
export function isolatedEnvironment(home) {
  const env = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP', 'TMPDIR'])
    if (process.env[key] !== undefined) env[key] = process.env[key];
  return { ...env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: home,
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(home, 'empty.gitconfig'),
    GIT_TERMINAL_PROMPT: '0', GIT_AUTHOR_NAME: 'Snapshot fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Snapshot fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    GIT_AUTHOR_DATE: FIXED_DATE, GIT_COMMITTER_DATE: FIXED_DATE, LC_ALL: 'C', TZ: 'UTC' };
}
export async function git(cwd, env, ...args) {
  return (await exec('git', ['-c', 'safe.directory=*', '-c', 'core.autocrlf=false', '-c', 'commit.gpgsign=false', ...args],
    { cwd, env, windowsHide: true, timeout: 120000, maxBuffer: 32 * 1024 * 1024 })).stdout.trim();
}
export function topology(count) {
  if (![0, 2, 4, 8, 16].includes(count)) throw new Error('invalid-topology');
  const paths = ['api', 'api/openapi', 'api/models', 'api/models/common', 'mcp', 'mcp/openapi', 'mcp/models', 'mcp/models/common',
    'web', 'web/openapi', 'web/models', 'web/models/common', 'cli', 'cli/openapi', 'cli/models', 'cli/models/common'];
  return count === 4 ? ['api', 'api/openapi', 'mcp', 'mcp/openapi'] : paths.slice(0, count);
}
export async function put(root, name, data) {
  const filename = path.join(root, name);
  await fs.mkdir(path.dirname(filename), { recursive: true });
  await fs.writeFile(filename, data);
}
async function image(root, includeAdmin = true) {
  const entries = [];
  async function walk(relative = '') {
    for (const entry of (await fs.readdir(path.join(root, relative), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!includeAdmin && ['.git', '.ai-factory'].includes(entry.name)) continue;
      const name = relative ? `${relative}/${entry.name}` : entry.name, full = path.join(root, name);
      const stat = await fs.lstat(full);
      if (stat.isSymbolicLink()) throw new Error('fixture-link');
      if (stat.isDirectory()) { entries.push({ name, directory: true }); await walk(name); }
      else entries.push({ name, data: await fs.readFile(full), mode: stat.mode & 0o777 });
    }
  }
  await walk(); return entries;
}
async function checkedRoot(root) {
  const info = await fs.lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink() || await fs.realpath(root) !== path.resolve(root)) throw new Error('unsafe-fixture-root');
}
export async function capture(root) { await checkedRoot(root); return image(root); }
export async function restore(root, entries) {
  await checkedRoot(root);
  // root is a verified, owned mkdtemp descendant; do not delete its admin directories.
  const keep = new Set(entries.map(e => e.name));
  async function prune(relative = '') {
    for (const item of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
      const name = relative ? `${relative}/${item.name}` : item.name, full = path.join(root, name);
      if (!keep.has(name) || item.isSymbolicLink()) await fs.rm(full, { recursive: true, force: true });
      else if (item.isDirectory()) await prune(name);
    }
  }
  await prune();
  for (const item of entries) {
    const full = path.join(root, item.name);
    if (item.directory) await fs.mkdir(full, { recursive: true });
    else {
      const current = await fs.readFile(full).catch(() => null);
      if (!current?.equals(item.data)) { await fs.chmod(full, 0o600).catch(() => {}); await fs.writeFile(full, item.data); }
      if (process.platform !== 'win32') await fs.chmod(full, item.mode);
    }
  }
}
export async function manifest(root, env, modules) {
  const leaves = (await image(root, false)).filter(e => !e.directory).map(e => ({ path: e.name, bytes: e.data.length, sha256: sha256(e.data), executable: e.mode & 0o111 }));
  const repositories = [];
  for (const prefix of ['', ...modules]) {
    const cwd = path.join(root, prefix);
    repositories.push({ prefix, head: await git(cwd, env, 'rev-parse', 'HEAD'), branch: await git(cwd, env, 'rev-parse', '--abbrev-ref', 'HEAD'),
      stage: sha256(await git(cwd, env, 'ls-files', '--stage')), config: sha256(await git(cwd, env, 'config', '--local', '--list')) });
  }
  return { leaves, repositories, digest: sha256(JSON.stringify({ leaves, repositories })) };
}
export async function createFixture(scenario) {
  const container = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'aifhub-snapshot-')));
  const root = path.join(container, 'project with spaces'), home = path.join(container, 'home');
  const token = randomUUID(); await fs.writeFile(path.join(container, '.snapshot-owned'), token);
  await fs.mkdir(root); await fs.mkdir(home); await fs.writeFile(path.join(home, 'empty.gitconfig'), '');
  const env = isolatedEnvironment(home), modules = topology(scenario.modules);
  const cleanup = async () => {
    if (!container.startsWith(path.resolve(os.tmpdir()) + path.sep) && !container.startsWith(await fs.realpath(os.tmpdir()) + path.sep)) throw new Error('unsafe-cleanup');
    await fs.rm(container, { recursive: true, force: true, maxRetries: 3 });
  };
  try {
    for (const prefix of ['', ...modules]) {
      const cwd = path.join(root, prefix); await fs.mkdir(cwd, { recursive: true });
      if (prefix && scenario.variant !== 'old-form') await fs.mkdir(path.join(root, '.git', 'modules', prefix), { recursive: true });
      const args = prefix && scenario.variant !== 'old-form'
        ? ['init', '-q', '--initial-branch=main', '--separate-git-dir', path.join(root, '.git', 'modules', prefix)]
        : ['init', '-q', '--initial-branch=main'];
      await git(cwd, env, ...args); await git(cwd, env, 'config', 'core.autocrlf', 'false');
      await git(cwd, env, 'config', 'core.filemode', process.platform === 'win32' ? 'false' : 'true');
    }
    await put(root, '.gitignore', '.ai-factory/\nignored/\n');
    await put(root, '.gitattributes', '* text=auto eol=lf\n*.bin -text\n');
    if (scenario.variant === 'eol') await put(root, '.gitattributes', '* text=auto eol=lf\n*.bin -text\ndata/* text eol=crlf\n');
    if (scenario.variant === 'filter') {
      await put(root, '.gitattributes', '* text=auto eol=lf\n*.bin -text\ndata/* filter=snapshot -text\n');
      const script = '.ai-factory/filters/transform.mjs';
      await put(root, script, "const chunks=[]; for await(const c of process.stdin) chunks.push(c); const text=Buffer.concat(chunks).toString(); process.stdout.write(text.replaceAll(process.argv[2]==='clean'?'A':'Z',process.argv[2]==='clean'?'Z':'A'));\n");
      const quote = value => `'${value.replaceAll('\\', '/').replaceAll("'", "'\\''")}'`;
      for (const kind of ['clean', 'smudge']) await git(root, env, 'config', `filter.snapshot.${kind}`, `${quote(process.execPath)} ${quote(path.join(root, script))} ${kind}`);
      await git(root, env, 'config', 'filter.snapshot.required', 'true');
    }
    await put(root, '.ai-factory/config.yaml', 'aifhub:\n  tools:\n    openspec: true\n');
    await put(root, 'openspec/changes/work/proposal.md', '# Synthetic proposal\n');
    await put(root, 'openspec/changes/work/tasks.md', [1, 2, 3].map(n => `- [ ] 1.${n} Task ${n}\n`).join(''));
    if (scenario.family === 'H') for (let i = 0; i < scenario.changes; i++) {
      await put(root, `openspec/changes/history-${i}/proposal.md`, '# History\n');
      await put(root, `openspec/changes/history-${i}/tasks.md`, '- [ ] 1.1 History task\n');
    }
    const directChildren = prefix => modules.filter(p => path.posix.dirname(p) === (prefix || '.') );
    for (const prefix of ['', ...modules]) {
      const children = directChildren(prefix);
      if (children.length) await put(root, `${prefix ? prefix + '/' : ''}.gitmodules`, children.map(p => {
        const relative = prefix ? p.slice(prefix.length + 1) : p;
        return `[submodule "${relative}"]\n\tpath = ${relative}\n\turl = https://fixture.invalid/${relative}\n`;
      }).join(''));
    }
    let count = (await image(root, false)).filter(e => !e.directory).length;
    const dirs = ['', ...modules];
    for (let i = count; i < scenario.leaves; i++) {
      const prefix = dirs[(i - count) % dirs.length], n = i - count;
      const size = scenario.content === 'io-heavy' && n % 10 === 0 ? 256 * 1024 : 128;
      await put(root, `${prefix ? prefix + '/' : ''}data/leaf-${String(n).padStart(5, '0')}${n % 5 === 0 ? '.bin' : '.txt'}`, Buffer.alloc(size, 65 + n % 26));
    }
    // A stable writable target for lifecycle and negative scenarios; included in L.
    const first = (await image(root, false)).find(e => !e.directory && e.name.startsWith('data/'));
    if (!first) throw new Error('fixture-too-small');
    if (scenario.variant === 'eol') await put(root, first.name, 'worktree CRLF\r\n');
    if (scenario.variant === 'ignored-in-scope') await fs.appendFile(path.join(root, '.gitignore'), first.name + '\n');
    for (const prefix of [...modules].reverse().concat('')) {
      const cwd = path.join(root, prefix);
      await git(cwd, env, 'add', '.');
      for (const child of directChildren(prefix)) {
        const head = await git(path.join(root, child), env, 'rev-parse', 'HEAD');
        await git(cwd, env, 'update-index', '--add', '--cacheinfo', `160000,${head},${prefix ? child.slice(prefix.length + 1) : child}`);
      }
      await git(cwd, env, 'commit', '-qm', 'synthetic fixture');
    }
    if (scenario.variant === 'detached') await git(root, env, 'checkout', '--detach', '-q');
    if (scenario.variant === 'tracked-dirty') await put(root, first.name, 'dirty worktree bytes\n');
    if (scenario.variant === 'untracked') await git(root, env, 'rm', '--cached', '-q', '--', first.name);
    if (scenario.variant === 'divergent') await git(path.join(root, modules.at(-1)), env, 'commit', '--allow-empty', '-qm', 'divergent');
    let activeRoot = root;
    const workers = [];
    if (scenario.variant === 'linked') {
      activeRoot = path.join(container, 'linked root');
      await git(root, env, 'worktree', 'add', '-qb', 'linked', activeRoot);
      await put(activeRoot, '.ai-factory/config.yaml', await fs.readFile(path.join(root, '.ai-factory/config.yaml')));
    }
    if (scenario.family === 'I') for (let i = 0; i < 2; i++) {
      const worker = path.join(container, `worker-${i}`);
      await git(root, env, 'worktree', 'add', '-qb', `worker-${i}`, worker);
      await put(worker, '.ai-factory/config.yaml', await fs.readFile(path.join(root, '.ai-factory/config.yaml')));
      workers.push(worker);
    }
    const before = await manifest(activeRoot, env, modules);
    if (before.leaves.length !== scenario.leaves) throw new Error('fixture-leaf-count');
    const roots = [...new Set([root, activeRoot, ...workers])], images = await Promise.all(roots.map(capture));
    return { container, token, root: activeRoot, env, modules, workers, target: scenario.variant === 'creation' ? 'data/created.txt' : first.name, manifest: before,
      reset: async () => { for (let i = 0; i < roots.length; i++) await restore(roots[i], images[i]); }, cleanup };
  } catch (error) { await cleanup(); throw error; }
}
