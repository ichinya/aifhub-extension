// decision-corrections.test.mjs - project-scoped DecisionCorrectionFixture store (#285).
// Every scenario runs inside disposable temp projects (mkdtemp + realpath);
// the checkout is never written to. No network, no SDK, no keys, no paid
// calls. The QA-namespace section below (step 3 of the change plan) only
// exercises scripts/qa-manifest-inputs.mjs with case files written directly;
// engine-backed scenarios join the same file as the engine lands.
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { digest } from './workflow-state-store.mjs';
import { prepareQaManifest } from './qa-manifest.mjs';
import { qaStore } from './qa-manifest-store.mjs';
import { observeQaSnapshot } from './qa-manifest-inputs.mjs';
import { ensureRuntimeGitignore } from './runtime-gitignore.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DECISION_CORRECTIONS_NAMESPACE = 'decision-corrections';
const roots = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function makeTemp(prefix) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
  roots.push(root);
  return root;
}

async function gitIn(root, args) {
  const child = spawn('git', args, { cwd: root, windowsHide: true });
  let stdout = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  return new Promise((resolve, reject) => { child.on('error', reject); child.on('close', () => resolve(stdout)); });
}

async function seedGitProject(root) {
  await mkdir(path.join(root, 'docs'), { recursive: true });
  await mkdir(path.join(root, '.ai-factory'), { recursive: true });
  await mkdir(path.join(root, 'openspec', 'changes', 'work'), { recursive: true });
  await writeFile(path.join(root, '.gitignore'), '.ai-factory/\n');
  await writeFile(path.join(root, 'docs', 'spec.md'), '# Spec\n\nQA isolation fixture.\n');
  await writeFile(path.join(root, 'openspec', 'changes', 'work', 'proposal.md'), '# Proposal\n\n## Why\n\nQA isolation fixture.\n');
  await writeFile(path.join(root, 'openspec', 'changes', 'work', 'tasks.md'), '- [ ] 1.1 Task\n');
  await gitIn(root, ['init', '--initial-branch=main']);
  await gitIn(root, ['config', 'user.email', 'fixture@example.com']);
  await gitIn(root, ['config', 'user.name', 'fixture']);
  await gitIn(root, ['add', '.']);
  await gitIn(root, ['commit', '-m', 'init']);
  await ensureRuntimeGitignore(root, '.ai-factory/state');
  const toolchain = [{ name: 'fixture-node', sha256: digest('node') }];
  const check = {
    id: 'check-verify', gate: 'verify', profile: 'declared.v1', dependencies_complete: true,
    inputs: ['docs'], command: { argv: ['fake'], cwd: '.' }, toolchain, env_inputs: [], requires_observed: false,
  };
  const options = {
    rootDir: root, changeId: 'work', scope: ['docs'], checks: [check], environment: {},
    providers: {
      requirements: async () => ({ gates: ['verify'], independent_roles: [], evidence: [] }),
      toolchain: async () => toolchain,
    },
  };
  assert.equal((await prepareQaManifest(options)).ok, true, 'qa enrollment needs a real git worktree');
  return options;
}

async function observe(options) {
  const store = await qaStore(options);
  const { payload } = await store.manifest();
  const snapshot = await observeQaSnapshot(store, payload);
  return {
    files: Object.keys(snapshot.files).sort(),
    ignored_names: snapshot.ignored_names,
    changed_paths: snapshot.changed_paths,
    digest: snapshot.digest,
  };
}

function casePath(root, scope, filename) {
  return path.join(root, '.ai-factory', 'state', DECISION_CORRECTIONS_NAMESPACE, scope, 'cases', filename);
}

// ---------------------------------------------------------------------------
// QA namespace isolation (#285): the constant store namespace must never
// change required QA surfaces, whatever the snapshot provider in front of it.
// ---------------------------------------------------------------------------

describe('decision-corrections QA namespace isolation', () => {
  it('keeps the QA fingerprint identical across write, overwrite, and deletion of a case', async () => {
    const root = await makeTemp('aif-dc-qa1-');
    const options = await seedGitProject(root);
    const before = await observe(options);
    await mkdir(path.dirname(casePath(root, 'work', 'case-1.json')), { recursive: true });
    const caseBytes = JSON.stringify({ envelope: 'fixture bytes for the namespace probe' });
    await writeFile(casePath(root, 'work', 'case-1.json'), caseBytes);
    const afterWrite = await observe(options);
    assert.deepEqual(afterWrite, before, 'writing a case must not shift the QA fingerprint');
    await writeFile(casePath(root, 'work', 'case-1.json'), `${caseBytes}\n`);
    const afterOverwrite = await observe(options);
    assert.deepEqual(afterOverwrite, before, 'overwriting a case must not shift the QA fingerprint');
    await rm(casePath(root, 'work', 'case-1.json'));
    const afterDelete = await observe(options);
    assert.deepEqual(afterDelete, before, 'deleting a case must not shift the QA fingerprint');
    assert.ok(!before.files.some((p) => p.includes(DECISION_CORRECTIONS_NAMESPACE)), 'namespace never enters the projected file catalog');
    assert.ok(!before.ignored_names.some((p) => p.includes(DECISION_CORRECTIONS_NAMESPACE)), 'namespace never enters ignored_names');
    assert.ok(!before.changed_paths.some((p) => p.includes(DECISION_CORRECTIONS_NAMESPACE)), 'namespace never enters changed_paths');
  });

  it('filters the namespace at the projection layer even in front of an injected SnapshotProvider', async () => {
    const root = await makeTemp('aif-dc-qa2-');
    const options = await seedGitProject(root);
    const store = await qaStore(options);
    const { payload } = await store.manifest();
    const injected = {
      observe: async () => ({
        complete: true,
        worktree_identity: 'a'.repeat(64),
        modules: { 'scripts/qa-manifest.mjs': digest('x') },
        actual_diff: null,
        files: {
          'docs/spec.md': Buffer.from('# Spec\n'),
          [`.ai-factory/state/${DECISION_CORRECTIONS_NAMESPACE}/work/cases/case-1.json`]: Buffer.from('{}'),
          [`.ai-factory/state/${DECISION_CORRECTIONS_NAMESPACE}/.gitignore`]: Buffer.from('*\n'),
        },
        directory_names: [`.ai-factory/state/${DECISION_CORRECTIONS_NAMESPACE}/work`],
        ignored_names: [`.ai-factory/state/${DECISION_CORRECTIONS_NAMESPACE}/work/cases/case-1.json`],
        changed_paths: [`.ai-factory/state/${DECISION_CORRECTIONS_NAMESPACE}/work/cases/case-1.json`],
      }),
    };
    const snapshot = await observeQaSnapshot(store, payload, { SnapshotProvider: injected });
    const leak = (p) => p.includes(DECISION_CORRECTIONS_NAMESPACE);
    assert.ok(!Object.keys(snapshot.files).some(leak), 'injected-provider files must not leak the namespace');
    assert.ok(!snapshot.ignored_names.some(leak), 'injected-provider ignored_names must not leak the namespace');
    assert.ok(!snapshot.changed_paths.some(leak), 'injected-provider changed_paths must not leak the namespace');
    assert.ok(snapshot.files['docs/spec.md'], 'presented scope stays projected');
  });

  it('refuses a declared root inside the namespace fail-closed (self-referential-input)', async () => {
    const root = await makeTemp('aif-dc-qa3-');
    const options = await seedGitProject(root);
    const store = await qaStore(options);
    const { payload } = await store.manifest();
    // The constant namespace is not owned by one QA target: a scope that
    // declares the store itself as a dependency must fail closed instead of
    // silently projecting (or silently hiding) its own evidence store.
    const poisoned = JSON.parse(JSON.stringify(payload));
    poisoned.checks[0].inputs = [`.ai-factory/state/${DECISION_CORRECTIONS_NAMESPACE}`];
    await assert.rejects(
      () => observeQaSnapshot(store, poisoned),
      (error) => error?.code === 'self-referential-input',
    );
  });

  it('closes the namespace regardless of the QA target id (constant store namespace)', async () => {
    const root = await makeTemp('aif-dc-qa4-');
    const options = await seedGitProject(root);
    const store = await qaStore(options);
    const { payload } = await store.manifest();
    // The store is shared by the whole command, so the closure must not be
    // tied to payload.target.id: a different target id still excludes it.
    const injected = {
      observe: async () => ({
        complete: true,
        worktree_identity: 'b'.repeat(64),
        modules: { 'scripts/qa-manifest.mjs': digest('y') },
        actual_diff: null,
        files: {
          [`.ai-factory/state/${DECISION_CORRECTIONS_NAMESPACE}/other-scope/cases/case-9.json`]: Buffer.from('{}'),
        },
        directory_names: [],
        ignored_names: [],
        changed_paths: [],
      }),
    };
    const snapshot = await observeQaSnapshot(store, payload, { SnapshotProvider: injected });
    assert.ok(!Object.keys(snapshot.files).some((p) => p.includes(DECISION_CORRECTIONS_NAMESPACE)),
      'the constant namespace stays closed for every target id');
  });
});
