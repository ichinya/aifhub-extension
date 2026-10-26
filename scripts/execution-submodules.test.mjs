import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { link, mkdir, mkdtemp, readFile, rename, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { executionProject } from './fixtures/execution-project.mjs';
import { snapshot, validateRun } from './execution-records.mjs';
import { storeFor, worktree } from './workflow-state-store.mjs';

const exec = promisify(execFile);
const git = (cwd, ...args) => exec('git', args, { cwd, windowsHide: true });
const commit = cwd => git(cwd, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-qm', 'fixture');
const fails = (promise, code) => assert.rejects(promise, e => e.code === code);
async function cliFails(p, code) {
  try {
    await new Promise((resolve, reject) => {
      const child = execFile(process.execPath, [fileURLToPath(new URL('./execution-state.mjs', import.meta.url)), 'start', '--json'], {
        cwd: p.root, windowsHide: true,
      }, (error, stdout, stderr) => error ? reject(Object.assign(error, { stdout, stderr })) : resolve());
      child.stdin.on('error', () => {});
      child.stdin.end(JSON.stringify(p.start()));
    });
    assert.fail('negative CLI unexpectedly succeeded');
  } catch (error) {
    assert.equal(error.code, 2);
    assert.equal(error.stderr, '');
    assert.deepEqual(JSON.parse(error.stdout), { ok: false, code });
  }
}
async function replaceGitfile(p, name, text) {
  // Git marks gitfiles read-only on Windows. Replace only this disposable fixture's marker.
  await rm(path.join(p.root, name)); await p.put(name, text);
}
async function project(t) {
  const p = await executionProject(), seeds = await mkdtemp(path.join(os.tmpdir(), 'aifhub-module-seeds-'));
  t.after(async () => { await p.cleanup(); await rm(seeds, { recursive: true, force: true, maxRetries: 3 }); });
  const seed = async (name, files) => {
    const dir = path.join(seeds, name); await mkdir(dir);
    for (const [file, text] of Object.entries(files)) await writeFile(path.join(dir, file), text);
    await git(dir, 'init', '-q'); await git(dir, 'add', '.'); await commit(dir); return dir;
  };
  const spec = await seed('spec', { 'schema.yaml': 'initial spec\n', 'other.yaml': 'preserve spec\n' });
  const api = await seed('api', { 'main.txt': 'initial module\n', '.gitignore': 'ignored/\n' });
  await git(api, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', spec, 'openapi'); await commit(api);
  for (const name of ['api', 'mcp']) await p.git('-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', api, name);
  await p.git('-c', 'protocol.file.allow=always', 'submodule', 'update', '--init', '--recursive'); await commit(p.root);
  p.moduleGit = (name, ...args) => git(path.join(p.root, name), ...args);
  p.resume = () => p.call('resume', { change_id: p.id, run_id: 'run-1' });
  p.run = () => storeFor(p.root).then(s => s.load('.ai-factory/state/work/execution/runs/run-1.json'));
  p.specSeed = spec;
  return p;
}

describe('recursive module execution', { concurrency: 3 }, () => {
// Defect: mode 160000 directories are read as ordinary bytes, preventing admission;
// skipping them instead would silently admit out-of-scope nested edits. Expectations
// below are literal paths/outcomes from the recursive scope and freshness contract.
test('recursive tracked and untracked leaf identities are persisted, with all module metadata', async t => {
  const p = await project(t); await p.put('api/openapi/new.yaml', 'untracked spec\n');
  await p.call('start', p.start({ scope: ['api/openapi/schema.yaml'] }));
  const run = await p.run(), tree = run.initial_worktree;
  assert.deepEqual(Object.keys(tree.submodules).sort(), ['api', 'api/openapi', 'mcp', 'mcp/openapi']);
  for (const name of ['api/main.txt', 'api/openapi/schema.yaml', 'api/openapi/new.yaml', 'mcp/openapi/other.yaml']) assert.match(tree.files[name], /^[a-f0-9]{64}$/);
  assert.equal(Object.hasOwn(tree.files, 'api'), false);
  assert.equal(Object.keys(tree.files).some(n => n.split('/').includes('.git')), false);
  for (const module of Object.values(tree.submodules)) {
    assert.match(module.head, /^[a-f0-9]{40}$/); assert.match(module.gitlink, /^[a-f0-9]{40}$/);
    assert.match(module.index, /^[a-f0-9]{64}$/); assert.match(module.repository, /^[a-f0-9]{64}$/); assert.equal(typeof module.branch, 'string');
  }
  assert.equal((await p.resume()).resumable, true);
});

test('nested single-file scope reports exact leaves, preserves unrelated dirty baseline and closes a disposable run', async t => {
  const p = await project(t); await p.put('outside.txt', 'user dirty baseline\n'); await p.put('mcp/main.txt', 'module dirty baseline\n');
  const beforeTasks = await p.get('openspec/changes/work/tasks.md');
  await p.call('start', p.start({ scope: ['api/openapi/schema.yaml'] }));
  await p.put('api/openapi/schema.yaml', 'changed spec\n'); await fails(p.resume(), 'stale-checkpoint');
  await p.call('checkpoint', { ...p.actor(), progress: { completed_steps: ['Updated schema'], next_step: 'Review evidence' } });
  assert.equal((await p.resume()).resumable, true);
  const evidence = '.ai-factory/state/work/implementation/check.md'; await p.put(evidence, 'Fixture check passed.\n');
  const result = await p.call('result', { ...p.actor(2), result: { result_id: 'spec-result', status: 'completed', changed_files: ['api/openapi/schema.yaml'], checks: [{ name: 'fixture', exit_code: 0 }], evidence: [evidence] } });
  await p.call('accept', { ...p.actor(3, { actor: 'parent' }), result_digest: result.result.digest });
  assert.equal((await p.resume()).resumable, false);
  assert.equal(await p.get('outside.txt'), 'user dirty baseline\n'); assert.equal(await p.get('mcp/main.txt'), 'module dirty baseline\n');
  assert.equal(await p.get('openspec/changes/work/tasks.md'), beforeTasks);
});

test('whole-module scope includes nested and ignored leaves without treating .git as writable', async t => {
  const p = await project(t); await p.put('api/ignored/input.txt', 'one\n');
  await p.call('start', p.start({ scope: ['api'] })); await p.put('api/ignored/input.txt', 'two\n'); await p.put('api/openapi/schema.yaml', 'two\n');
  await p.call('checkpoint', { ...p.actor(), progress: { completed_steps: [], next_step: 'Check' } });
  assert.equal((await p.resume()).resumable, true);
  const tree = (await p.run()).checkpoint.worktree; assert.match(tree.files['api/ignored/input.txt'], /^[a-f0-9]{64}$/);
  assert.equal(Object.keys(tree.files).some(n => n.split('/').includes('.git')), false);
});

test('module drift recovery preserves pinned snapshots and historical interruption/stop receipts', async t => {
  const p = await project(t); await p.call('start', p.start({ scope: ['api'] }));
  await p.call('checkpoint', { ...p.actor(), progress: { completed_steps: [], next_step: 'Review' } });
  const before = await p.run();
  await p.moduleGit('api/openapi', 'checkout', '-qb', 'recovery-drift');
  const interrupted = p.actor(2, { actor: 'parent', recovery_id: 'recovery-1', reason: 'timed_out', execution_state: 'unknown' });
  await p.call('interrupt', interrupted);
  const run = await p.run();
  assert.deepEqual(run.initial_worktree, before.initial_worktree);
  assert.deepEqual(run.checkpoint, before.checkpoint);
  assert.ok(run.recovery.drift.includes('revision'));
  assert.equal((await p.call('interrupt', interrupted)).historical, true);
  const trace = '.ai-factory/state/work/implementation/stop.md'; await p.put(trace, 'Observed fixture worker stop.\n');
  const confirmation = p.actor(3, { actor: 'parent', recovery_id: 'recovery-1', confirmation_id: 'stop-1', evidence: [trace] });
  await p.call('stop-confirm', confirmation); await p.put(trace, 'Later evidence bytes.\n');
  assert.equal((await p.call('stop-confirm', confirmation)).historical, true);
  const final = await p.run();
  assert.deepEqual(final.initial_worktree.submodules, before.initial_worktree.submodules);
  assert.deepEqual(final.checkpoint.worktree.submodules, before.checkpoint.worktree.submodules);
});

test('mixed old-form module .git directories and nested gitfiles flatten through ancestor admin roots', async t => {
  const p = await project(t), marker = path.join(p.root, 'api/.git');
  const old = path.resolve(path.dirname(marker), (await readFile(marker, 'utf8')).trim().slice('gitdir: '.length));
  await p.moduleGit('api', 'config', '--local', '--unset', 'core.worktree');
  await rm(marker); await rename(old, marker);
  const nestedAdmin = path.join(marker, 'modules/openapi');
  await git(p.root, '--git-dir', nestedAdmin, '--work-tree', path.join(p.root, 'api/openapi'), 'config', '--local', 'core.worktree', path.join(p.root, 'api/openapi'));
  await replaceGitfile(p, 'api/openapi/.git', 'gitdir: ../.git/modules/openapi\n');
  await p.call('start', p.start({ scope: ['api'] }));
  assert.equal((await p.resume()).resumable, true); assert.match((await p.run()).initial_worktree.files['api/openapi/schema.yaml'], /^[a-f0-9]{64}$/);
});

test('pre-existing clean divergent module HEAD and parent gitlink are admitted and pinned independently', async t => {
  const p = await project(t); await commit(path.join(p.root, 'api/openapi'));
  await p.call('start', p.start({ scope: ['api'] }));
  const module = (await p.run()).initial_worktree.submodules['api/openapi']; assert.notEqual(module.head, module.gitlink);
  assert.equal((await p.resume()).resumable, true);
  await commit(path.join(p.root, 'api/openapi')); await fails(p.resume(), 'stale-revision');
});

for (const name of ['api/openapi/other.yaml', 'mcp/openapi/new.yaml']) test(`outside-scope module leaf ${name} rejects checkpoint`, async t => {
  const p = await project(t); await p.call('start', p.start({ scope: ['api/openapi/schema.yaml'] })); await p.put(name, 'unauthorized\n');
  await fails(p.call('checkpoint', { ...p.actor(), progress: { completed_steps: [], next_step: 'Check' } }), 'outside-scope');
});

for (const drift of ['head', 'branch', 'index', 'nested-pin-index', 'repository']) test(`module ${drift} drift rejects resume and checkpoint even with unchanged leaf bytes`, async t => {
  const p = await project(t); await p.call('start', p.start({ scope: ['api'] }));
  if (drift === 'head') await commit(path.join(p.root, 'api/openapi'));
  if (drift === 'branch') await p.moduleGit('api/openapi', 'checkout', '-qb', 'changed-branch');
  if (drift === 'index') await p.moduleGit('api/openapi', 'update-index', '--chmod=+x', 'schema.yaml');
  if (drift === 'nested-pin-index') { const head = (await p.moduleGit('api', 'rev-parse', 'HEAD')).stdout.trim(); await p.moduleGit('api', 'update-index', '--cacheinfo', `160000,${head},openapi`); }
  if (drift === 'repository') {
    const marker = path.join(p.root, 'api/openapi/.git'), text = await readFile(marker, 'utf8');
    const old = path.resolve(path.dirname(marker), text.trim().slice('gitdir: '.length)), moved = old+'-moved';
    await rename(old, moved); await replaceGitfile(p, 'api/openapi/.git', `gitdir: ${path.relative(path.dirname(marker), moved).replaceAll('\\', '/')}\n`);
  }
  await fails(p.resume(), 'stale-revision');
  await fails(p.call('checkpoint', { ...p.actor(), progress: { completed_steps: [], next_step: 'Check' } }), 'stale-revision');
});

test('uninitialized nested modules cannot inherit the enclosing Git repository', async t => {
  const p = await project(t); await rm(path.join(p.root, 'api/openapi/.git'));
  await fails(p.call('start', p.start()), 'uninitialized-submodule');
  assert.equal(await p.run(), null);
});
test('missing nested module directories fail closed before admission', async t => {
  const p = await project(t); await rm(path.join(p.root, 'api/openapi'), { recursive: true, force: true });
  await fails(p.call('start', p.start()), 'uninitialized-submodule'); assert.equal(await p.run(), null);
});
test('missing top-level modules fail closed with a bounded CLI envelope', async t => {
  const p = await project(t); await rm(path.join(p.root, 'mcp'), { recursive: true, force: true });
  await fails(p.call('start', p.start()), 'uninitialized-submodule');
  assert.equal(await p.run(), null);
  await cliFails(p, 'uninitialized-submodule');
});
test('unresolved gitlink merge stages fail closed before reading module bytes', async t => {
  const p = await project(t), head = (await p.moduleGit('api', 'rev-parse', 'HEAD')).stdout.trim();
  await p.git('update-index', '--force-remove', 'api');
  const child = execFile('git', ['update-index', '--index-info'], { cwd: p.root, windowsHide: true });
  const done = new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error('update-index failed'))); });
  child.stdin.end(`160000 ${head} 1\tapi\n`); await done;
  await fails(p.call('start', p.start()), 'unmerged-submodule');
  assert.equal(await p.run(), null);
  await cliFails(p, 'unmerged-submodule');
});
test('external module gitdir pointers fail closed', async t => {
  const p = await project(t); await replaceGitfile(p, 'api/openapi/.git', `gitdir: ${p.specSeed.replaceAll('\\', '/')}/.git\n`);
  await fails(p.call('start', p.start()), 'unsafe-submodule');
});
test('hardlinked Git markers and module leaves fail closed', async t => {
  const p = await project(t); const marker = path.join(p.root, 'api/openapi/.git');
  await link(marker, path.join(p.root, 'marker-copy')); await fails(p.call('start', p.start()), 'unsafe-filesystem-entry');
  await rm(path.join(p.root, 'marker-copy')); await link(path.join(p.root, 'api/openapi/schema.yaml'), path.join(p.root, 'leaf-copy'));
  await fails(p.call('start', p.start()), 'unsafe-filesystem-entry');
});
test('junction or symbolic module directory fails closed', async t => {
  const p = await project(t); await rm(path.join(p.root, 'api/openapi'), { recursive: true, force: true });
  await symlink(p.specSeed, path.join(p.root, 'api/openapi'), process.platform === 'win32' ? 'junction' : 'dir');
  await fails(p.call('start', p.start()), 'unsafe-filesystem-entry');
});
test('junction or symbolic Git admin directory fails closed', async t => {
  const p = await project(t), marker = path.join(p.root, 'api/openapi/.git');
  const admin = path.resolve(path.dirname(marker), (await readFile(marker, 'utf8')).trim().slice('gitdir: '.length));
  await rename(admin, admin+'-real'); await symlink(admin+'-real', admin, process.platform === 'win32' ? 'junction' : 'dir');
  await fails(p.call('start', p.start()), 'unsafe-submodule');
});
test('nested Git metadata cannot be a worker scope', async t => {
  const p = await project(t); await fails(p.call('start', p.start({ scope: ['api/.git'] })), 'protected-scope');
});
test('recursive leaves retain the 16 MiB file bound', async t => {
  const p = await project(t); await p.put('api/openapi/large.bin', ''); await truncate(path.join(p.root, 'api/openapi/large.bin'), 16 * 1024 * 1024 + 1);
  await fails(p.call('start', p.start()), 'unsupported-file');
});
test('scoped file budget is aggregate across scopes, not per inventory call', async t => {
  const p = await project(t);
  const bulk = async (dir, from, to) => {
    await mkdir(path.join(p.root, dir), { recursive: true });
    for (let i = from; i < to; i++) await writeFile(path.join(p.root, dir, `f${String(i).padStart(5, '0')}.txt`), `${i}\n`);
  };
  await bulk('bulk-a', 0, 10000);
  const store = await storeFor(p.root);
  await worktree(store, ['bulk-a']);
  await bulk('bulk-b', 10000, 10001);
  await fails(worktree(store, ['bulk-a', 'bulk-b']), 'too-many-files');
});
test('tracked names with Unicode line-separator characters survive index parsing', async t => {
  const p = await project(t), name = 'api/a\u2028b.txt';
  await p.put(name, 'separator name\n');
  await p.moduleGit('api', 'add', 'a\u2028b.txt'); await commit(path.join(p.root, 'api'));
  await p.call('start', p.start({ scope: [name] }));
  const run = await p.run();
  assert.ok(Object.hasOwn(run.initial_worktree.files, name));
});
test('snapshot validation accepts old records and rejects malformed module metadata and checkpoint erasure', async t => {
  const p = await project(t); await p.call('start', p.start()); const run = await p.run();
  const plain = { head: run.initial_worktree.head, branch: run.initial_worktree.branch, index: run.initial_worktree.index, files: {} };
  assert.doesNotThrow(() => snapshot(plain));
  for (const mutate of [s => { s.submodules.api.repository = 'bad'; }, s => { delete s.submodules.api.index; }, s => { s.submodules.api.extra = true; }, s => { s.submodules['../escape'] = s.submodules.api; }]) {
    const bad = structuredClone(run.initial_worktree); mutate(bad); assert.throws(() => snapshot(bad));
  }
  const bad = structuredClone(run); delete bad.checkpoint.worktree.submodules; assert.throws(() => validateRun(bad));
  const tree = await worktree(await storeFor(p.root)); assert.deepEqual(Object.keys(tree.submodules).sort(), ['api', 'api/openapi', 'mcp', 'mcp/openapi']);
});

});
