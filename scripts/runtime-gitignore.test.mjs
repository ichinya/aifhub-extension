import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, link, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, it } from 'node:test';
import { ensureRuntimeGitignore, ensureRuntimeGitignores, RUNTIME_GITIGNORE } from './runtime-gitignore.mjs';
import { initializeEnabledTools } from './aif-artifact-sync.mjs';
import { ensureRuntimeLayout, writeCurrentChangePointer } from './active-change-resolver.mjs';
import { writeGateEvidence } from './write-gate-evidence.mjs';
import { createGateResult, renderGateResultBlock } from './aif-gate-result.mjs';
import { createLedger, saveLedger } from './context-dedup.mjs';

const roots = [];
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aifhub-runtime-ignore-'));
  roots.push(root);
  return root;
}
async function put(root, file, content) {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await writeFile(path.join(root, file), content);
}
async function absent(root, file) {
  await assert.rejects(lstat(path.join(root, file)), { code: 'ENOENT' });
}
afterEach(async () => {
  for (const root of roots.splice(0)) {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('aifhub-runtime-ignore-'));
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

it('installed-project bootstrap ignores runtime contents with default and custom paths, preserving durable sources', async () => {
  const root = await fixture();
  const excludes = path.join(await fixture(), 'empty-excludes');
  await writeFile(excludes, '');
  const git = (...args) => execFileSync('git', ['-c', `core.excludesFile=${excludes}`, ...args], { cwd: root, encoding: 'utf8', windowsHide: true });
  git('init', '--quiet');
  const rootIgnore = '# Project rules\nnode_modules/\n';
  await put(root, '.gitignore', rootIgnore);
  await put(root, '.ai-factory/config.yaml', 'aifhub:\n  tools:\n    openspec: true\n    hlv: false\n    lekalo: false\npaths:\n  state: runtime/state\n  qa: runtime/qa\n  generated_rules: runtime/generated\n');
  const result = await initializeEnabledTools({ rootDir: root, stateDir: path.join(root, 'runtime/state') });
  assert.equal(result.ok, true, JSON.stringify(result));
  const directories = ['.ai-factory/state', '.ai-factory/qa', '.ai-factory/rules/generated', 'runtime/state', 'runtime/qa', 'runtime/generated'];
  for (const dir of directories) {
    assert.equal(await readFile(path.join(root, dir, '.gitignore'), 'utf8'), RUNTIME_GITIGNORE);
    await put(root, `${dir}/raw/temporary.json`, '{}');
  }
  for (const file of ['.ai-factory/plans/plan.md', '.ai-factory/specs/spec.md', 'docs/qa/scenarios.md']) await put(root, file, '# Durable source\n');
  const preview = git('add', '--dry-run', '.');
  assert.doesNotMatch(preview, /temporary\.json/);
  for (const dir of directories) assert.ok(preview.includes(`${dir}/.gitignore`), preview);
  for (const file of ['.ai-factory/plans/plan.md', '.ai-factory/specs/spec.md', 'docs/qa/scenarios.md']) assert.ok(preview.includes(file), preview);
  assert.equal(await readFile(path.join(root, '.gitignore'), 'utf8'), rootIgnore);
  assert.equal(git('ls-files'), '');
});

it('bootstraps runtime ignores without OpenSpec and repairs existing empty directories', async () => {
  const root = await fixture();
  await put(root, '.ai-factory/config.yaml', 'aifhub:\n  tools:\n    openspec: false\n    hlv: false\n    lekalo: false\n');
  await mkdir(path.join(root, '.ai-factory/state'));
  assert.equal((await initializeEnabledTools({ rootDir: root })).ok, true);
  assert.equal(await readFile(path.join(root, '.ai-factory/state/.gitignore'), 'utf8'), RUNTIME_GITIGNORE);
  assert.equal(await readFile(path.join(root, '.ai-factory/qa/.gitignore'), 'utf8'), RUNTIME_GITIGNORE);
  await absent(root, 'openspec');
});

it('preserves existing rules and file timestamps on repeated and concurrent creation', async () => {
  const root = await fixture();
  await Promise.all(Array.from({ length: 8 }, () => ensureRuntimeGitignore(root, 'state')));
  const file = path.join(root, 'state/.gitignore');
  const first = await lstat(file);
  assert.equal((await ensureRuntimeGitignore(root, 'state')).action, 'preserve');
  assert.equal((await lstat(file)).mtimeMs, first.mtimeMs);
  const manual = '# Team-owned policy\r\n*.log\r\n!keep.md\r\n';
  await writeFile(file, manual);
  const before = await lstat(file);
  await ensureRuntimeGitignore(root, 'state');
  assert.equal(await readFile(file, 'utf8'), manual);
  assert.equal((await lstat(file)).mtimeMs, before.mtimeMs);
});

it('dry-run does not create runtime directories or ignore files', async () => {
  const root = await fixture();
  const result = await ensureRuntimeGitignores(root, ['state', 'qa'], { dryRun: true });
  assert.ok(result.every((item) => item.action === 'would-create'));
  assert.deepEqual(await readdir(root), []);
  assert.equal((await initializeEnabledTools({ rootDir: root, dryRun: true })).ok, true);
  assert.deepEqual(await readdir(root), []);
});

it('rejects project/canonical roots and escaping paths before any directory creation', async () => {
  const root = await fixture();
  for (const dir of ['.', '..', '../outside', '.git', '.ai-factory', '.ai-factory/rules', 'openspec/specs', '.ai-factory/plans', '.ai-factory/specs']) {
    await assert.rejects(ensureRuntimeGitignores(root, ['safe-state', dir]));
    assert.deepEqual(await readdir(root), []);
  }
});

it('rejects linked directories, linked ignore files, and directory/file collisions without overwriting targets', async () => {
  const root = await fixture();
  const outside = await fixture();
  await symlink(outside, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(ensureRuntimeGitignores(root, ['safe-state', 'linked']));
  await absent(root, 'safe-state');
  assert.deepEqual(await readdir(outside), []);
  await put(root, 'hardlinked/source', 'manual');
  await link(path.join(root, 'hardlinked/source'), path.join(root, 'hardlinked/.gitignore'));
  await assert.rejects(ensureRuntimeGitignore(root, 'hardlinked'));
  assert.equal(await readFile(path.join(root, 'hardlinked/source'), 'utf8'), 'manual');
  await mkdir(path.join(root, 'collision/.gitignore'), { recursive: true });
  await assert.rejects(ensureRuntimeGitignore(root, 'collision'));
  await put(root, 'file', 'original');
  await assert.rejects(ensureRuntimeGitignore(root, 'file'));
  assert.equal(await readFile(path.join(root, 'file'), 'utf8'), 'original');
});

it('standalone runtime writers create ignore rules without a preceding bootstrap', async () => {
  const pointerRoot = await fixture();
  await writeCurrentChangePointer('example', { rootDir: pointerRoot, stateDir: 'custom/state' });
  assert.equal(await readFile(path.join(pointerRoot, 'custom/state/.gitignore'), 'utf8'), RUNTIME_GITIGNORE);
  const layoutRoot = await fixture();
  await ensureRuntimeLayout('example', { rootDir: layoutRoot, stateDir: 'custom/state', qaDir: 'custom/qa' });
  for (const dir of ['custom/state', 'custom/qa']) assert.equal(await readFile(path.join(layoutRoot, dir, '.gitignore'), 'utf8'), RUNTIME_GITIGNORE);
  const qaRoot = await fixture();
  const input = path.join(await fixture(), 'gate.md');
  await writeFile(input, renderGateResultBlock(createGateResult({ gate: 'rules', status: 'pass', blockers: [], affectedFiles: [], suggestedNext: null })));
  assert.equal((await writeGateEvidence({ rootDir: qaRoot, changeId: 'example', gate: 'rules', from: input })).ok, true);
  assert.equal(await readFile(path.join(qaRoot, '.ai-factory/qa/.gitignore'), 'utf8'), RUNTIME_GITIGNORE);
  const ledgerRoot = await fixture();
  await saveLedger(createLedger('session'), { rootDir: ledgerRoot });
  assert.equal(await readFile(path.join(ledgerRoot, '.ai-factory/state/.gitignore'), 'utf8'), RUNTIME_GITIGNORE);
});
