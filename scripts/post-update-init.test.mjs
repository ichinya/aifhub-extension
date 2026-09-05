import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, it } from 'node:test';
import { registerPostUpdateInit } from '../commands/post-update-init.mjs';

const roots = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('aifhub-post-update-'));
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

async function fixture(options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aifhub-post-update-'));
  roots.push(root);
  const installed = path.join(root, '.ai-factory/extensions/aifhub-extension');
  await mkdir(path.join(installed, 'scripts'), { recursive: true });
  const script = path.join(installed, 'scripts/aif-mode.mjs');
  await writeFile(script, '// Previous implementation\n');
  await writeFile(path.join(root, '.ai-factory.json'), JSON.stringify({ extensions: [{ name: 'aifhub-extension' }] }));
  const hooks = { preAction: [], postAction: [] };
  const program = { hook(name, callback) { hooks[name].push(callback); return this; } };
  const stdout = [], stderr = [], calls = [];
  const processLike = {
    cwd: () => root, execPath: process.execPath, env: process.env, exitCode: undefined,
    stdout: { write: (text) => stdout.push(text) }, stderr: { write: (text) => stderr.push(text) }
  };
  const moduleUrl = pathToFileURL(path.join(installed, 'commands/aifhub-mode.mjs')).href;
  const run = options.realChild ? {} : { runInstalledScript: async (...args) => { calls.push(args); return options.exitCode ?? 0; } };
  registerPostUpdateInit(program, moduleUrl, { processLike, ...run });
  return {
    root, script, program, processLike, calls, stdout, stderr, moduleUrl, hooks,
    action: (kind, target) => ({
      name: () => kind === 'other-command' ? 'status' : 'update',
      parent: kind === 'global' ? program : { name: () => 'extension', parent: program },
      processedArgs: target === undefined ? [] : [target]
    }),
    pre: async (action) => { for (const hook of hooks.preAction) await hook(program, action); },
    post: async (action) => { for (const hook of hooks.postAction) await hook(program, action); },
    refresh: () => writeFile(script, '// Updated implementation with a different revision\n')
  };
}

it('runs init exactly once after targeted, all-extension and global refreshes', async () => {
  for (const [kind, target] of [['extension', 'aifhub-extension'], ['extension', undefined], ['global', undefined]]) {
    const f = await fixture();
    const action = f.action(kind, target);
    await f.pre(action);
    assert.equal(f.calls.length, 0);
    await f.refresh();
    await f.post(action);
    await f.post(action);
    assert.equal(f.calls.length, 1);
    assert.deepEqual(f.calls[0].slice(0, 3), ['../scripts/aif-mode.mjs', ['init', '--json'], f.moduleUrl]);
    assert.equal(f.calls[0][3].processLike.cwd(), f.root);
    assert.equal(f.stderr.length, 0);
  }
});

it('executes the newly installed script in the consumer cwd instead of cached pre-update code', async () => {
  const f = await fixture({ realChild: true });
  const action = f.action('extension', 'aifhub-extension');
  await f.pre(action);
  await writeFile(f.script, [
    "import { writeFile } from 'node:fs/promises';",
    "await writeFile('post-update-result.json', JSON.stringify({ revision: 'new', cwd: process.cwd(), args: process.argv.slice(2) }));"
  ].join('\n'));
  await f.post(action);
  const result = JSON.parse(await readFile(path.join(f.root, 'post-update-result.json'), 'utf8'));
  assert.deepEqual(result, { revision: 'new', cwd: f.root, args: ['init', '--json'] });
});

it('does not initialize for other extensions, read-only commands, or unchanged/skipped refreshes', async () => {
  for (const [kind, target, changed] of [['extension', 'another-extension', true], ['other-command', undefined, true], ['global', undefined, false]]) {
    const f = await fixture();
    const action = f.action(kind, target);
    await f.pre(action);
    if (changed) await f.refresh();
    await f.post(action);
    assert.equal(f.calls.length, 0);
    assert.equal(f.stdout.length, 0);
    assert.equal(f.stderr.length, 0);
  }
});

it('preserves updater failures and does not start initialization after a nonzero exit', async () => {
  const f = await fixture();
  const action = f.action('global');
  await f.pre(action);
  await f.refresh();
  f.processLike.exitCode = 7;
  await f.post(action);
  assert.equal(f.calls.length, 0);
  assert.equal(f.processLike.exitCode, 7);
});

it('propagates initialization failure without claiming the successful update was rolled back', async () => {
  const f = await fixture({ exitCode: 3 });
  const action = f.action('global');
  await f.pre(action);
  await f.refresh();
  await f.post(action);
  assert.equal(f.processLike.exitCode, 3);
  assert.match(f.stderr.join(''), /post-update initialization failed/);
  assert.ok((await readFile(f.script, 'utf8')).includes('Updated implementation'));
  assert.equal(f.stderr.join('').includes(f.root), false);
});

it('reports an unavailable new initializer and registers lifecycle hooks only once', async () => {
  const f = await fixture();
  registerPostUpdateInit(f.program, f.moduleUrl, { processLike: f.processLike });
  assert.equal(f.hooks.preAction.length, 1);
  assert.equal(f.hooks.postAction.length, 1);
  const action = f.action('global');
  await f.pre(action);
  await rm(f.script);
  await f.post(action);
  assert.equal(f.calls.length, 0);
  assert.equal(f.processLike.exitCode, 1);
  assert.match(f.stderr.join(''), /post-update initialization failed/);
});
