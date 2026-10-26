import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { BASELINE_171, HELPER_MODULES, helperDiagnostics, sha256 } from './execution-provenance.mjs';
import { generateProvenance } from './generate-provenance.mjs';

async function installation(t, version = '1.8.0') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aifhub-provenance-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3 }));
  await mkdir(path.join(root, 'scripts'));
  await writeFile(path.join(root, 'extension.json'), JSON.stringify({ version }));
  for (const p of HELPER_MODULES) await writeFile(path.join(root, p), p.endsWith('workflow-state-store.mjs') ? 'export const sameRevision = () => true;\n' : '// fixture\n');
  await copyFile(new URL('./execution-provenance.mjs', import.meta.url), path.join(root, 'scripts/execution-provenance.mjs'));
  return root;
}
const cli = (filename, input, action = 'diagnostics') => new Promise((resolve, reject) => {
  const child = execFile(process.execPath, [filename, action, '--json'], { windowsHide: true }, (error, stdout, stderr) => {
    if (error && typeof error.code !== 'number') reject(error);
    else resolve({ code: error?.code ?? 0, stdout, stderr });
  });
  child.stdin.on('error', () => {}); child.stdin.end(JSON.stringify(input));
});

test('exact release diagnostics reports actual hashes, declared version and probed capability without writes', async t => {
  const root = await installation(t), manifest = await generateProvenance({ rootDir: root });
  const before = await readdir(root, { recursive: true });
  const result = await helperDiagnostics({ rootDir: root });
  assert.equal(result.schema, 'aifhub.execution_helper_provenance.v1');
  assert.equal(result.declared_version, '1.8.0'); assert.equal(result.implementation, 'release-exact');
  assert.equal(result.local_modifications, false); assert.deepEqual(result.mismatches, []);
  assert.equal(result.modules.length, 6); assert.equal(result.capabilities[0].support, 'yes');
  for (const file of manifest.files) assert.equal(result.modules.find(m => m.path === file.path).sha256, file.sha256);
  assert.equal(result.modules[5].sha256, sha256(await readFile(path.join(root, result.modules[5].path))));
  assert.deepEqual(await readdir(root, { recursive: true }), before);
});
test('local modification is distinguished from the declared version and a missing module is diagnosed', async t => {
  const root = await installation(t); await generateProvenance({ rootDir: root });
  await writeFile(path.join(root, HELPER_MODULES[1]), '// installed helper repair\n');
  await rm(path.join(root, HELPER_MODULES[2]));
  const result = await helperDiagnostics({ rootDir: root });
  assert.equal(result.implementation, 'locally-modified'); assert.equal(result.local_modifications, true);
  assert.deepEqual(result.mismatches.map(m => m.path), HELPER_MODULES.slice(1, 3));
  assert.equal(result.modules[2].sha256, null);
});
test('unknown baseline reports unknown rather than false local modifications', async t => {
  const root = await installation(t, '9.9.9');
  const result = await helperDiagnostics({ rootDir: root });
  assert.equal(result.implementation, 'unknown'); assert.equal(result.local_modifications, null);
  assert.equal(result.capabilities[0].support, 'unknown');
  await writeFile(path.join(root, 'provenance.json'), '{invalid');
  assert.equal((await helperDiagnostics({ rootDir: root })).implementation, 'unknown');
});
test('known 1.7.1 baseline is available without a manifest', async t => {
  const root = await installation(t, '1.7.1'), result = await helperDiagnostics({ rootDir: root });
  assert.equal(result.baseline, 'baseline-1.7.1'); assert.equal(result.implementation, 'locally-modified');
  assert.equal(result.capabilities[0].support, 'unknown');
  assert.equal(result.mismatches[0].expected_sha256, BASELINE_171[HELPER_MODULES[0]]);
});
test('invalid manifest version, duplicate or malformed entries cannot supply a capability baseline', async t => {
  const root = await installation(t);
  const good = await generateProvenance({ rootDir: root });
  for (const mutate of [m => { m.version = '0.0.0'; }, m => { m.files[1] = m.files[0]; }, m => { m.files[0].sha256 = 'bad'; }]) {
    const manifest = structuredClone(good); mutate(manifest);
    await writeFile(path.join(root, 'provenance.json'), JSON.stringify(manifest));
    assert.equal((await helperDiagnostics({ rootDir: root })).implementation, 'unknown');
  }
});
test('capability follows the exact manifest without executing the audited runtime', async t => {
  // The manifest is the only capability source: even files a probe could not import stay
  // 'yes' when their bytes match the shipped release, and nothing is evaluated during a scan.
  for (const source of ['export const oldStore = true;\n', 'export const = syntax error\n']) {
    const root = await installation(t); await writeFile(path.join(root, HELPER_MODULES[0]), source);
    await generateProvenance({ rootDir: root });
    assert.equal((await helperDiagnostics({ rootDir: root })).capabilities[0].support, 'yes');
  }
});
test('independent CLI diagnoses partially replaced runtime with JSON and empty stderr', async t => {
  const root = await installation(t); await generateProvenance({ rootDir: root });
  for (const p of HELPER_MODULES) await writeFile(path.join(root, p), 'invalid runtime syntax !!!\n');
  const filename = path.join(root, 'scripts/execution-provenance.mjs');
  const result = await cli(filename, {});
  assert.equal(result.code, 0); assert.equal(result.stderr, '');
  assert.equal(JSON.parse(result.stdout).implementation, 'locally-modified');
  assert.equal(JSON.parse(result.stdout).ok, true);
  const invalid = await cli(filename, { change_id: 'unexpected' });
  assert.equal(invalid.code, 2); assert.equal(invalid.stderr, '');
  assert.deepEqual(JSON.parse(invalid.stdout), { ok: false, code: 'invalid-input' });
});
test('execution dispatch diagnostics does not load missing runtime dependencies', async t => {
  const root = await installation(t);
  await copyFile(new URL('./execution-state.mjs', import.meta.url), path.join(root, HELPER_MODULES[1]));
  const module = await import(pathToFileURL(path.join(root, HELPER_MODULES[1])).href);
  assert.equal((await module.executionCommand('diagnostics', {}, { rootDir: '/not-the-installation' })).declared_version, '1.8.0');
  await assert.rejects(module.executionCommand('diagnostics', []), e => e.code === 'invalid-input');
});
test('generator check detects changed execution bytes and version without rewriting the manifest', async t => {
  const root = await installation(t); await generateProvenance({ rootDir: root });
  await generateProvenance({ rootDir: root, check: true });
  const before = await readFile(path.join(root, 'provenance.json'), 'utf8');
  await writeFile(path.join(root, HELPER_MODULES[4]), '// changed\n');
  await assert.rejects(generateProvenance({ rootDir: root, check: true }), /stale-provenance/);
  assert.equal(await readFile(path.join(root, 'provenance.json'), 'utf8'), before);
});
