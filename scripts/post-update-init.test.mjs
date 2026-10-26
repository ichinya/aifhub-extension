import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, it } from 'node:test';
import { registerPostUpdateInit } from '../commands/post-update-init.mjs';
import { HELPER_MODULES, sha256 } from './execution-provenance.mjs';
import { generateProvenance } from './generate-provenance.mjs';

const roots = [];
async function helperInstallation(f) {
  const installed = path.join(f.root, '.ai-factory/extensions/aifhub-extension');
  await writeFile(path.join(installed, 'extension.json'), JSON.stringify({ version: '1.8.0' }));
  for (const p of HELPER_MODULES) await writeFile(path.join(installed, p), `// release ${p}\n`);
  await generateProvenance({ rootDir: installed });
  return installed;
}
async function preservedManifest(f) {
  const parent = path.join(f.root, '.ai-factory/state/extension-updates');
  const entries = await readdir(parent);
  assert.equal(entries.length, 1);
  const directory = path.join(parent, entries[0]);
  return { directory, manifest: JSON.parse(await readFile(path.join(directory, 'diff-manifest.json'), 'utf8')) };
}
afterEach(async () => {
  for (const root of roots.splice(0)) {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('aifhub-post-update-'));
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

it('preserves a modified installed helper before replacement and emits a reviewable migration handoff', async () => {
  const f = await fixture(), installed = await helperInstallation(f), relative = HELPER_MODULES[0];
  const patch = '// installed helper repair\n', incoming = '// incoming release\n';
  await writeFile(path.join(installed, relative), patch);
  const action = f.action('global'); await f.pre(action);
  const before = await preservedManifest(f);
  assert.equal(await readFile(path.join(before.directory, 'preserve', relative), 'utf8'), patch);
  assert.equal(before.manifest.files[0].incoming_sha256, null);
  await writeFile(path.join(installed, relative), incoming); await f.refresh(); await f.post(action);
  const after = await preservedManifest(f);
  assert.deepEqual(after.manifest.files, [{ path: relative, installed_sha256: sha256(patch), incoming_sha256: sha256(incoming), disposition: 'preserved-review-required' }]);
  assert.equal(await readFile(path.join(after.directory, 'preserve', relative), 'utf8'), patch);
  assert.match(f.stderr.join(''), /diff-manifest.json/); assert.match(f.stderr.join(''), /migrate the local patch explicitly/);
  assert.match(f.stderr.join(''), /aifhub-execution diagnostics/); assert.equal(f.calls.length, 1);
  assert.equal(f.processLike.exitCode, undefined);
});

it('clean helper installation creates no preserve state or modification handoff', async () => {
  const f = await fixture(); await helperInstallation(f);
  const action = f.action('extension', 'aifhub-extension'); await f.pre(action); await f.refresh(); await f.post(action);
  await assert.rejects(readdir(path.join(f.root, '.ai-factory/state/extension-updates')), { code: 'ENOENT' });
  assert.equal(f.stderr.length, 0); assert.equal(f.calls.length, 1);
});

it('update failure after preservation still hands off preserved copies on process exit', async () => {
  const f = await fixture(), installed = await helperInstallation(f), relative = HELPER_MODULES[0];
  const patch = '// installed helper repair\n';
  await writeFile(path.join(installed, relative), patch);
  const action = f.action('global'); await f.pre(action);
  const before = await preservedManifest(f);
  f.exit(); // Commander skips postAction when the update action itself throws.
  assert.match(f.stderr.join(''), /update failed after helper preservation/);
  assert.equal(await readFile(path.join(before.directory, 'preserve', relative), 'utf8'), patch);
  assert.equal(f.calls.length, 0);
});

it('unknown baseline conservatively preserves every existing helper module', async () => {
  const f = await fixture(), installed = await helperInstallation(f);
  await writeFile(path.join(installed, 'extension.json'), JSON.stringify({ version: '9.9.9' }));
  const action = f.action('global'); await f.pre(action); await f.post(action);
  const { manifest } = await preservedManifest(f);
  assert.equal(manifest.baseline, 'unknown'); assert.equal(manifest.files.length, 5);
  assert.equal(f.calls.length, 0); assert.match(f.stderr.join(''), /preserved modified\/unknown/);
});

it('preserves local helper bytes even if the pre-update initializer is missing', async () => {
  const f = await fixture(), installed = await helperInstallation(f);
  await rm(f.script); await writeFile(path.join(installed, HELPER_MODULES[0]), '// local\n');
  const action = f.action('global'); await f.pre(action); await f.refresh(); await f.post(action);
  assert.equal((await preservedManifest(f)).manifest.files.length, 1);
  assert.match(f.stderr.join(''), /diff-manifest/); assert.equal(f.calls.length, 1);
});

it('strict handoff reports nonzero after successful update and still initializes', async () => {
  const f = await fixture(), installed = await helperInstallation(f);
  f.processLike.env.AIFHUB_UPDATE_STRICT = '1';
  await writeFile(path.join(installed, HELPER_MODULES[1]), '// local\n');
  const action = f.action('global'); await f.pre(action); await f.refresh(); await f.post(action);
  assert.equal(f.calls.length, 1); assert.equal(f.processLike.exitCode, 1);
  assert.match(f.stderr.join(''), /diff-manifest/);
});

it('preservation handoff survives updater failure and retains its exit code', async () => {
  const f = await fixture(), installed = await helperInstallation(f);
  await writeFile(path.join(installed, HELPER_MODULES[2]), '// local\n');
  const action = f.action('global'); await f.pre(action); f.processLike.exitCode = 7; await f.post(action);
  assert.equal(f.calls.length, 0); assert.equal(f.processLike.exitCode, 7);
  assert.match(f.stderr.join(''), /diff-manifest/);
  assert.equal((await preservedManifest(f)).manifest.files[0].incoming_sha256, sha256('// local\n'));
});

it('unsafe preservation destination blocks update before replacement', async () => {
  const f = await fixture(), installed = await helperInstallation(f);
  await writeFile(path.join(installed, HELPER_MODULES[3]), '// local\n');
  await mkdir(path.join(f.root, '.ai-factory/state'), { recursive: true });
  await writeFile(path.join(f.root, '.ai-factory/state/extension-updates'), 'blocked');
  await assert.rejects(f.pre(f.action('global')), /update stopped before replacement/);
  assert.equal(f.processLike.exitCode, 1); assert.equal(await readFile(path.join(installed, HELPER_MODULES[3]), 'utf8'), '// local\n');
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
  const stdout = [], stderr = [], calls = [], exitHandlers = [];
  const processLike = {
    cwd: () => root, execPath: process.execPath, env: { ...process.env, AIFHUB_UPDATE_STRICT: '' }, exitCode: undefined,
    stdout: { write: (text) => stdout.push(text) }, stderr: { write: (text) => stderr.push(text) },
    once(type, handler) { if (type === 'exit') exitHandlers.push(handler); return this; }
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
    refresh: () => writeFile(script, '// Updated implementation with a different revision\n'),
    exit: () => { for (const handler of exitHandlers.splice(0)) handler(); }
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
