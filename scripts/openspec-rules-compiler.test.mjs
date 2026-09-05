// openspec-rules-compiler.test.mjs - tests for OpenSpec generated rules compiler
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  access,
  lstat as fsLstat,
  mkdtemp,
  mkdir,
  open as fsOpen,
  readFile,
  readdir,
  rename as fsRename,
  rm,
  symlink,
  unlink as fsUnlink,
  writeFile
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const tempRoots = [];

async function loadCompiler() {
  return import('./openspec-rules-compiler.mjs');
}

async function createTempRoot() {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'aifhub-openspec-rules-'));
  tempRoots.push(rootDir);
  return rootDir;
}

async function writeFixture(rootDir, relativePath, content) {
  const targetPath = path.join(rootDir, ...relativePath.split('/'));
  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeFile(targetPath, content, 'utf8');
  return targetPath;
}

async function createChange(rootDir, changeId, specs = {}) {
  await writeFixture(rootDir, `openspec/changes/${changeId}/proposal.md`, `# ${changeId}\n`);

  for (const [specPath, content] of Object.entries(specs)) {
    await writeFixture(rootDir, `openspec/changes/${changeId}/specs/${specPath}`, content);
  }
}

async function pathExists(targetPath) {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function readGenerated(rootDir, fileName) {
  return readFile(path.join(rootDir, '.ai-factory', 'rules', 'generated', fileName), 'utf8');
}

async function readGeneratedJson(rootDir, fileName) {
  return JSON.parse(await readGenerated(rootDir, fileName));
}

async function snapshotGeneratedTree(rootDir) {
  const generatedDir = path.join(rootDir, '.ai-factory', 'rules', 'generated');

  if (!await pathExists(generatedDir)) {
    return [];
  }

  const names = (await readdir(generatedDir)).sort((left, right) => left.localeCompare(right));
  return Promise.all(names.map(async (name) => [name, await readFile(path.join(generatedDir, name), 'utf8')]));
}

function fingerprint(content) {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

function missingCliDetection() {
  return {
    available: false,
    canValidate: false,
    canArchive: false,
    version: null,
    supportedRange: '>=1.3.1 <2.0.0',
    versionSupported: false,
    requiresNode: '>=20.19.0',
    nodeVersion: '20.19.0',
    nodeSupported: true,
    command: 'openspec',
    commandSource: 'path',
    reason: 'missing-cli',
    errors: [
      {
        code: 'missing-cli',
        message: "Selected OpenSpec CLI 'openspec' (path) is unavailable."
      }
    ]
  };
}

function compilerOptions(rootDir, overrides = {}) {
  return {
    rootDir,
    detectOpenSpec: async () => missingCliDetection(),
    getCurrentBranch: async () => 'feat/add-generated-rules',
    ...overrides
  };
}

const baseBillingSpec = `# Billing

## Requirements

### Requirement: Track Usage

The system MUST track customer usage.

#### Scenario: usage is captured

- GIVEN a billable account
- WHEN usage is reported
- THEN the usage entry is stored
`;

const deltaAuthSpec = `# Auth Delta

## ADDED Requirements

### Requirement: Require MFA

The system MUST require MFA for administrators.

#### Scenario: administrator signs in

- GIVEN an administrator account
- WHEN the administrator signs in
- THEN an MFA challenge is required
`;

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((rootDir) => rm(rootDir, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 20
  })));
});

describe('OpenSpec rules compiler API', () => {
  it('exports the required public functions', async () => {
    const {
      collectOpenSpecRuleSources,
      compileOpenSpecRules,
      compileOpenSpecBaseRules,
      extractRequirementsFromShowJson,
      inspectOpenSpecGeneratedRules,
      parseSpecMarkdownFallback,
      reconcileOpenSpecGeneratedRules,
      renderGeneratedRules,
      writeGeneratedRules
    } = await loadCompiler();

    assert.equal(typeof compileOpenSpecRules, 'function');
    assert.equal(typeof compileOpenSpecBaseRules, 'function');
    assert.equal(typeof collectOpenSpecRuleSources, 'function');
    assert.equal(typeof renderGeneratedRules, 'function');
    assert.equal(typeof writeGeneratedRules, 'function');
    assert.equal(typeof parseSpecMarkdownFallback, 'function');
    assert.equal(typeof extractRequirementsFromShowJson, 'function');
    assert.equal(typeof inspectOpenSpecGeneratedRules, 'function');
    assert.equal(typeof reconcileOpenSpecGeneratedRules, 'function');
  });
});

describe('generated-rules batch reconciliation', () => {
  it('prepares every selected change before mutation and keeps a late failure byte-identical', async () => {
    const { reconcileOpenSpecGeneratedRules } = await loadCompiler();
    const rootDir = await createTempRoot();
    await writeFixture(rootDir, 'openspec/specs/billing/spec.md', baseBillingSpec);
    await createChange(rootDir, 'change-a', { 'auth/spec.md': deltaAuthSpec });
    await createChange(rootDir, 'change-b', { 'auth/spec.md': deltaAuthSpec });
    await writeFixture(rootDir, '.ai-factory/rules/generated/index.json', '{"sentinel":true}\n');
    await writeFixture(rootDir, '.ai-factory/rules/generated/openspec-base.md', 'sentinel base\n');
    const before = await snapshotGeneratedTree(rootDir);

    const result = await reconcileOpenSpecGeneratedRules(compilerOptions(rootDir, {
      activeChangeIds: ['change-a', 'change-b'],
      selectedChangeIds: ['change-a', 'change-b'],
      selectionSource: 'all',
      collectChangeSources: async (changeId, options) => {
        if (changeId === 'change-b') {
          throw new Error('injected late preparation failure');
        }
        const compiler = await loadCompiler();
        return compiler.collectOpenSpecChangeRuleSources(changeId, options);
      }
    }));

    assert.equal(result.ok, false, 'all/change-b late preparation must fail closed');
    assert.equal(result.errors[0].code, 'generated-rules-prepare-failed');
    assert.deepEqual(await snapshotGeneratedTree(rootDir), before, 'all/change-b late preparation must not mutate generated files');
  });

  it('prunes recognized archived outputs, preserves unknown files, and is byte-stable with a later clock', async () => {
    const { reconcileOpenSpecGeneratedRules } = await loadCompiler();
    const rootDir = await createTempRoot();
    await writeFixture(rootDir, 'openspec/specs/billing/spec.md', baseBillingSpec);
    await createChange(rootDir, 'change-a', { 'auth/spec.md': deltaAuthSpec });
    await writeFixture(rootDir, '.ai-factory/rules/generated/openspec-change-archived.md', 'orphan\n');
    await writeFixture(rootDir, '.ai-factory/rules/generated/openspec-merged-archived.md', 'orphan\n');
    await writeFixture(rootDir, '.ai-factory/rules/generated/openspec-rules-trace-archived.json', '{}\n');
    await writeFixture(rootDir, '.ai-factory/rules/generated/notes.txt', 'owned by user\n');

    const first = await reconcileOpenSpecGeneratedRules(compilerOptions(rootDir, {
      activeChangeIds: ['change-a'],
      selectedChangeIds: ['change-a'],
      selectionSource: 'all',
      now: new Date('2026-08-22T00:00:00.000Z')
    }));
    const firstSnapshot = await snapshotGeneratedTree(rootDir);
    const second = await reconcileOpenSpecGeneratedRules(compilerOptions(rootDir, {
      activeChangeIds: ['change-a'],
      selectedChangeIds: ['change-a'],
      selectionSource: 'all',
      now: new Date('2026-08-22T01:00:00.000Z')
    }));

    assert.equal(first.ok, true, 'all/change-a reconciliation should succeed');
    assert.deepEqual(first.operations.filter((item) => item.action === 'remove').map((item) => item.target), [
      '.ai-factory/rules/generated/openspec-change-archived.md',
      '.ai-factory/rules/generated/openspec-merged-archived.md',
      '.ai-factory/rules/generated/openspec-rules-trace-archived.json'
    ]);
    assert.equal(await readGenerated(rootDir, 'notes.txt'), 'owned by user\n', 'unknown generated child must be preserved');
    assert.equal(second.ok, true, 'all/change-a second reconciliation should succeed');
    assert.equal(second.operationCount, 0, 'all/change-a second reconciliation must be a semantic no-op');
    assert.deepEqual(await snapshotGeneratedTree(rootDir), firstSnapshot, 'all/change-a later clock must not change bytes');
  });

  it('collects base once and finalizes one index for a multi-change all batch', async () => {
    const compiler = await loadCompiler();
    const rootDir = await createTempRoot();
    await writeFixture(rootDir, 'openspec/specs/billing/spec.md', baseBillingSpec);
    await createChange(rootDir, 'change-a', { 'auth/spec.md': deltaAuthSpec });
    await createChange(rootDir, 'change-b', { 'auth/spec.md': deltaAuthSpec });
    let baseCollections = 0;
    let indexRenames = 0;
    let basePublishes = 0;

    const result = await compiler.reconcileOpenSpecGeneratedRules(compilerOptions(rootDir, {
      activeChangeIds: ['change-a', 'change-b'],
      selectedChangeIds: ['change-a', 'change-b'],
      selectionSource: 'all',
      collectBaseSources: async (options) => {
        baseCollections += 1;
        return compiler.collectOpenSpecBaseRuleSources(options);
      },
      fileOps: {
        rename: async (sourcePath, targetPath) => {
          if (path.basename(targetPath) === 'openspec-base.md') {
            basePublishes += 1;
          }
          if (path.basename(targetPath) === 'index.json') {
            indexRenames += 1;
          }
          return fsRename(sourcePath, targetPath);
        }
      },
      now: new Date('2026-08-22T02:00:00.000Z')
    }));

    assert.equal(result.ok, true, 'all/two-change batch should reconcile');
    assert.equal(baseCollections, 1, 'all/two-change batch must collect base once');
    assert.equal(basePublishes, 1, 'all/two-change batch must publish base once');
    assert.equal(indexRenames, 1, 'all/two-change batch must atomically finalize index once');
    assert.deepEqual((await readGeneratedJson(rootDir, 'index.json')).changes.map((entry) => entry.change_id), ['change-a', 'change-b']);
  });

  it('fails closed on inventory reads, canonical-root mismatch, and root or managed collisions', async () => {
    const { reconcileOpenSpecGeneratedRules } = await loadCompiler();
    const inventoryRoot = await createTempRoot();
    await createChange(inventoryRoot, 'change-a', { 'auth/spec.md': deltaAuthSpec });
    const unreadable = await reconcileOpenSpecGeneratedRules(compilerOptions(inventoryRoot, {
      activeChangeIds: ['change-a'],
      selectedChangeIds: ['change-a'],
      selectionSource: 'all',
      fileOps: {
        readdir: async (targetPath, options) => {
          if (targetPath === path.join(inventoryRoot, 'openspec', 'changes')) {
            throw Object.assign(new Error('injected inventory denial'), { code: 'EACCES' });
          }
          return readdir(targetPath, options);
        }
      }
    }));
    assert.equal(unreadable.ok, false, 'all/change-a unreadable inventory must fail closed');
    assert.equal(unreadable.errors[0].code, 'active-inventory-read-failed');
    assert.equal(await pathExists(path.join(inventoryRoot, '.ai-factory', 'rules', 'generated')), false);

    const mismatch = await reconcileOpenSpecGeneratedRules(compilerOptions(inventoryRoot, {
      generatedRulesPath: '.ai-factory/custom-generated',
      activeChangeIds: ['change-a'],
      selectedChangeIds: ['change-a'],
      selectionSource: 'all'
    }));
    assert.equal(mismatch.ok, false, 'noncanonical generated root must fail closed');
    assert.equal(mismatch.errors[0].code, 'generated-rules-root-mismatch');

    const rootCollision = await createTempRoot();
    await createChange(rootCollision, 'change-a', { 'auth/spec.md': deltaAuthSpec });
    await writeFixture(rootCollision, '.ai-factory/rules/generated/notes.txt', 'unknown\n');
    const unsafeRoot = await reconcileOpenSpecGeneratedRules(compilerOptions(rootCollision, {
      activeChangeIds: ['change-a'],
      selectedChangeIds: ['change-a'],
      selectionSource: 'all',
      fileOps: {
        lstat: async (targetPath) => targetPath === path.join(rootCollision, '.ai-factory', 'rules', 'generated')
          ? {
            isSymbolicLink: () => true,
            isDirectory: () => false,
            isFile: () => false
          }
          : fsLstat(targetPath)
      }
    }));
    assert.equal(unsafeRoot.ok, false, 'generated root reparse collision must fail closed');
    assert.equal(unsafeRoot.errors[0].code, 'generated-rules-root-unsafe');

    const managedCollision = await createTempRoot();
    await createChange(managedCollision, 'change-a', { 'auth/spec.md': deltaAuthSpec });
    await mkdir(path.join(managedCollision, '.ai-factory', 'rules', 'generated', 'openspec-change-archived.md'), { recursive: true });
    const unsafeManaged = await reconcileOpenSpecGeneratedRules(compilerOptions(managedCollision, {
      activeChangeIds: ['change-a'],
      selectedChangeIds: ['change-a'],
      selectionSource: 'all'
    }));
    assert.equal(unsafeManaged.ok, false, 'managed-name directory collision must fail closed');
    assert.equal(unsafeManaged.errors[0].code, 'invalid-managed-entry');
  });

  it('rejects a linked active inventory root before collecting external specs', async () => {
    const compiler = await loadCompiler();
    const rootDir = await createTempRoot();
    const externalRoot = await createTempRoot();
    await createChange(externalRoot, 'outside-change', { 'auth/spec.md': deltaAuthSpec });
    await mkdir(path.join(rootDir, 'openspec'), { recursive: true });
    await symlink(
      path.join(externalRoot, 'openspec', 'changes'),
      path.join(rootDir, 'openspec', 'changes'),
      process.platform === 'win32' ? 'junction' : 'dir'
    );
    let changeCollections = 0;

    const result = await compiler.reconcileOpenSpecGeneratedRules(compilerOptions(rootDir, {
      activeChangeIds: ['outside-change'],
      selectedChangeIds: ['outside-change'],
      selectionSource: 'all',
      collectChangeSources: async (changeId, options) => {
        changeCollections += 1;
        return compiler.collectOpenSpecChangeRuleSources(changeId, options);
      }
    }));

    assert.equal(result.ok, false, 'all/outside-change linked active inventory root must fail closed');
    assert.equal(result.partial, false, 'linked active inventory root must fail before mutation');
    assert.equal(result.errors[0].code, 'active-inventory-root-unsafe');
    assert.equal(changeCollections, 0, 'linked active inventory root must not become source authority');
    assert.equal(
      await pathExists(path.join(rootDir, '.ai-factory', 'rules', 'generated')),
      false,
      'linked active inventory root must not create generated outputs'
    );
  });

  it('rejects linked base and change spec roots as canonical source authority', async () => {
    const compiler = await loadCompiler();
    const baseRoot = await createTempRoot();
    const externalBaseRoot = await createTempRoot();
    await writeFixture(externalBaseRoot, 'billing/spec.md', baseBillingSpec);
    await mkdir(path.join(baseRoot, 'openspec'), { recursive: true });
    await symlink(
      externalBaseRoot,
      path.join(baseRoot, 'openspec', 'specs'),
      process.platform === 'win32' ? 'junction' : 'dir'
    );

    const baseResult = await compiler.collectOpenSpecBaseRuleSources(compilerOptions(baseRoot));
    assert.equal(baseResult.ok, false, 'linked base spec root must fail closed');
    assert.equal(baseResult.errors[0].code, 'openspec-source-root-unsafe');
    assert.deepEqual(baseResult.sources, [], 'linked base spec root must not yield external sources');

    const changeRoot = await createTempRoot();
    const externalChangeRoot = await createTempRoot();
    await createChange(changeRoot, 'change-a');
    await writeFixture(externalChangeRoot, 'auth/spec.md', deltaAuthSpec);
    await symlink(
      externalChangeRoot,
      path.join(changeRoot, 'openspec', 'changes', 'change-a', 'specs'),
      process.platform === 'win32' ? 'junction' : 'dir'
    );

    const changeResult = await compiler.collectOpenSpecChangeRuleSources(
      'change-a',
      compilerOptions(changeRoot)
    );
    assert.equal(changeResult.ok, false, 'linked change spec root must fail closed');
    assert.equal(changeResult.errors[0].code, 'openspec-source-root-unsafe');
    assert.deepEqual(changeResult.sources, [], 'linked change spec root must not yield external sources');
  });

  it('conflicts when canonical source bytes change after preparation', async () => {
    const { reconcileOpenSpecGeneratedRules } = await loadCompiler();
    const rootDir = await createTempRoot();
    await writeFixture(rootDir, 'openspec/specs/billing/spec.md', baseBillingSpec);
    const deltaPath = await writeFixture(
      rootDir,
      'openspec/changes/change-a/specs/auth/spec.md',
      deltaAuthSpec
    );
    await writeFixture(rootDir, 'openspec/changes/change-a/proposal.md', '# change-a\n');
    const before = await snapshotGeneratedTree(rootDir);
    const changedDelta = deltaAuthSpec.replace('require MFA', 'require phishing-resistant MFA');

    const result = await reconcileOpenSpecGeneratedRules(compilerOptions(rootDir, {
      activeChangeIds: ['change-a'],
      selectedChangeIds: ['change-a'],
      selectionSource: 'all',
      beforeCommit: async () => {
        await writeFile(deltaPath, changedDelta, 'utf8');
      }
    }));

    assert.equal(result.ok, false, 'all/change-a canonical source drift must conflict');
    assert.equal(result.partial, false, 'canonical source drift must fail before mutation');
    assert.equal(result.errors[0].code, 'generated-rules-source-conflict');
    assert.deepEqual(
      await snapshotGeneratedTree(rootDir),
      before,
      'canonical source drift must not publish outputs prepared from stale bytes'
    );
    assert.equal(await readFile(deltaPath, 'utf8'), changedDelta, 'reconciliation must not roll back canonical source edits');
  });

  it('rejects generated root replacement before publishing outputs', async () => {
    const { reconcileOpenSpecGeneratedRules } = await loadCompiler();
    const rootDir = await createTempRoot();
    const externalRoot = await createTempRoot();
    const basePath = await writeFixture(rootDir, 'openspec/specs/billing/spec.md', baseBillingSpec);
    await createChange(rootDir, 'change-a', { 'auth/spec.md': deltaAuthSpec });
    const initial = await reconcileOpenSpecGeneratedRules(compilerOptions(rootDir, {
      activeChangeIds: ['change-a'],
      selectedChangeIds: ['change-a'],
      selectionSource: 'all'
    }));
    assert.equal(initial.ok, true, 'all/change-a race fixture must start from valid generated outputs');

    await writeFile(basePath, baseBillingSpec.replace('track customer usage', 'track billable customer usage'), 'utf8');
    const generatedDir = path.join(rootDir, '.ai-factory', 'rules', 'generated');
    const displacedDir = path.join(rootDir, '.ai-factory', 'rules', 'generated-before-race');
    const priorBase = await readGenerated(rootDir, 'openspec-base.md');
    let swapped = false;
    const replaceGeneratedRoot = async () => {
      if (swapped) {
        return;
      }
      swapped = true;
      await fsRename(generatedDir, displacedDir);
      await symlink(externalRoot, generatedDir, process.platform === 'win32' ? 'junction' : 'dir');
    };

    const result = await reconcileOpenSpecGeneratedRules(compilerOptions(rootDir, {
      activeChangeIds: ['change-a'],
      selectedChangeIds: ['change-a'],
      selectionSource: 'all',
      beforeWrite: replaceGeneratedRoot,
      fileOps: {
        writeFile: async (targetPath, ...args) => {
          await replaceGeneratedRoot();
          return writeFile(targetPath, ...args);
        }
      }
    }));

    assert.equal(result.ok, false, 'all/change-a replaced generated root must fail closed');
    assert.equal(result.partial, false, 'generated root replacement before first publish must report no compiler mutation');
    assert.equal(result.errors[0].code, 'generated-rules-root-conflict');
    assert.deepEqual(await readdir(externalRoot), [], 'reconciliation must not publish through an external root link');
    assert.equal(
      await readFile(path.join(displacedDir, 'openspec-base.md'), 'utf8'),
      priorBase,
      'the checked generated tree must remain unchanged when its root identity is lost'
    );
  });

  it('removes an owned temp when the generated root changes during exclusive open', async () => {
    const { reconcileOpenSpecGeneratedRules } = await loadCompiler();
    const rootDir = await createTempRoot();
    const externalRoot = await createTempRoot();
    const basePath = await writeFixture(rootDir, 'openspec/specs/billing/spec.md', baseBillingSpec);
    await createChange(rootDir, 'change-a', { 'auth/spec.md': deltaAuthSpec });
    const initial = await reconcileOpenSpecGeneratedRules(compilerOptions(rootDir, {
      activeChangeIds: ['change-a'],
      selectedChangeIds: ['change-a'],
      selectionSource: 'all'
    }));
    assert.equal(initial.ok, true, 'all/change-a exclusive-open race fixture must start valid');

    await writeFile(basePath, baseBillingSpec.replace('track customer usage', 'track metered customer usage'), 'utf8');
    const generatedDir = path.join(rootDir, '.ai-factory', 'rules', 'generated');
    const displacedDir = path.join(rootDir, '.ai-factory', 'rules', 'generated-before-open-race');
    const priorBase = await readGenerated(rootDir, 'openspec-base.md');
    let swapped = false;

    const result = await reconcileOpenSpecGeneratedRules(compilerOptions(rootDir, {
      activeChangeIds: ['change-a'],
      selectedChangeIds: ['change-a'],
      selectionSource: 'all',
      fileOps: {
        open: async (targetPath, ...args) => {
          if (!swapped && path.dirname(targetPath) === generatedDir) {
            swapped = true;
            await fsRename(generatedDir, displacedDir);
            await symlink(externalRoot, generatedDir, process.platform === 'win32' ? 'junction' : 'dir');
          }
          return fsOpen(targetPath, ...args);
        }
      }
    }));

    assert.equal(result.ok, false, 'all/change-a root swap during exclusive open must fail closed');
    assert.equal(result.partial, false, 'exclusive-open root swap must precede managed output publication');
    assert.equal(result.errors[0].code, 'generated-rules-root-conflict');
    assert.deepEqual(await readdir(externalRoot), [], 'owned external temp must be removed without publishing content');
    assert.equal(
      await readFile(path.join(displacedDir, 'openspec-base.md'), 'utf8'),
      priorBase,
      'exclusive-open root swap must preserve the checked generated tree'
    );
  });

  it('fails closed on case-insensitive generated target aliases before mutation', async () => {
    const { inspectOpenSpecGeneratedRules, reconcileOpenSpecGeneratedRules } = await loadCompiler();
    const rootDir = await createTempRoot();
    await writeFixture(rootDir, 'openspec/specs/billing/spec.md', baseBillingSpec);
    await createChange(rootDir, 'foo', { 'auth/spec.md': deltaAuthSpec });
    await writeFixture(rootDir, '.ai-factory/rules/generated/openspec-change-Foo.md', 'case-variant sentinel\n');
    const before = await snapshotGeneratedTree(rootDir);

    const inspection = await inspectOpenSpecGeneratedRules({
      rootDir,
      activeChangeIds: ['foo']
    });

    const result = await reconcileOpenSpecGeneratedRules(compilerOptions(rootDir, {
      activeChangeIds: ['foo'],
      selectedChangeIds: ['foo'],
      selectionSource: 'all'
    }));

    assert.equal(inspection.ok, false, 'all/foo case alias must invalidate generated-rules inspection');
    assert.equal(inspection.state, 'invalid');
    assert.equal(inspection.errors[0].code, 'generated-rules-case-alias');
    assert.equal(result.ok, false, 'all/foo case-variant managed target must fail closed');
    assert.equal(result.partial, false, 'all/foo case alias must fail before mutation');
    assert.equal(result.errors[0].code, 'generated-rules-case-alias');
    assert.equal(result.operationCount, 0, 'all/foo case alias must not publish planned operations');
    assert.deepEqual(await snapshotGeneratedTree(rootDir), before, 'all/foo case alias must preserve generated bytes');
  });

  it('preserves a pre-existing atomic index temp and still cleans up an owned temp', async () => {
    const { reconcileOpenSpecGeneratedRules } = await loadCompiler();
    const rootDir = await createTempRoot();
    await writeFixture(rootDir, 'openspec/specs/billing/spec.md', baseBillingSpec);
    await createChange(rootDir, 'change-a', { 'auth/spec.md': deltaAuthSpec });
    const initial = await reconcileOpenSpecGeneratedRules(compilerOptions(rootDir, {
      activeChangeIds: ['change-a'],
      selectedChangeIds: ['change-a'],
      selectionSource: 'all'
    }));
    assert.equal(initial.ok, true);

    const generatedDir = path.join(rootDir, '.ai-factory', 'rules', 'generated');
    const index = await readGeneratedJson(rootDir, 'index.json');
    index.changes = [];
    const alteredIndex = `${JSON.stringify(index, null, 2)}\n`;
    await writeFixture(rootDir, '.ai-factory/rules/generated/index.json', alteredIndex);
    const occupiedTempName = '.index.json.occupied.tmp';
    const occupiedTempPath = path.join(generatedDir, occupiedTempName);
    await writeFixture(rootDir, `.ai-factory/rules/generated/${occupiedTempName}`, 'user-owned temp sentinel\n');

    const occupied = await reconcileOpenSpecGeneratedRules(compilerOptions(rootDir, {
      activeChangeIds: ['change-a'],
      selectedChangeIds: ['change-a'],
      selectionSource: 'all',
      tempToken: 'occupied'
    }));

    assert.equal(occupied.ok, false, 'occupied atomic index temp must fail without replacement');
    assert.equal(occupied.partial, false, 'occupied atomic index temp must fail before mutation');
    assert.equal(occupied.errors[0].code, 'generated-rules-commit-failed');
    assert.equal(await pathExists(occupiedTempPath), true, 'pre-existing atomic index temp must be preserved');
    assert.equal(await readFile(occupiedTempPath, 'utf8'), 'user-owned temp sentinel\n');
    assert.equal(await readGenerated(rootDir, 'index.json'), alteredIndex, 'occupied temp failure must preserve prior index bytes');

    const ownedTempPath = path.join(generatedDir, '.index.json.owned.tmp');
    const renameFailure = await reconcileOpenSpecGeneratedRules(compilerOptions(rootDir, {
      activeChangeIds: ['change-a'],
      selectedChangeIds: ['change-a'],
      selectionSource: 'all',
      tempToken: 'owned',
      fileOps: {
        rename: async (sourcePath, targetPath) => {
          if (sourcePath === ownedTempPath) {
            throw Object.assign(new Error('injected index rename failure'), { code: 'EACCES' });
          }
          return fsRename(sourcePath, targetPath);
        }
      }
    }));

    assert.equal(renameFailure.ok, false, 'owned atomic index temp rename failure must be reported');
    assert.equal(renameFailure.partial, false, 'owned atomic index temp rename failure must precede index mutation');
    assert.equal(renameFailure.errors[0].code, 'generated-rules-commit-failed');
    assert.equal(await pathExists(ownedTempPath), false, 'owned atomic index temp must be cleaned after rename failure');
    assert.equal(await readGenerated(rootDir, 'index.json'), alteredIndex, 'rename failure must preserve prior index bytes');
  });

  it('rebuilds malformed index only with complete coverage and always refuses unsafe path metadata', async () => {
    const { reconcileOpenSpecGeneratedRules } = await loadCompiler();
    const rootDir = await createTempRoot();
    await createChange(rootDir, 'change-a', { 'auth/spec.md': deltaAuthSpec });
    await createChange(rootDir, 'change-b', { 'auth/spec.md': deltaAuthSpec });
    await writeFixture(rootDir, '.ai-factory/rules/generated/index.json', '{malformed\n');
    await writeFixture(rootDir, '.ai-factory/rules/generated/notes.txt', 'unknown\n');
    const before = await snapshotGeneratedTree(rootDir);

    const targeted = await reconcileOpenSpecGeneratedRules(compilerOptions(rootDir, {
      activeChangeIds: ['change-a', 'change-b'],
      selectedChangeIds: ['change-a'],
      selectionSource: 'explicit'
    }));
    assert.equal(targeted.ok, false, 'explicit/change-a malformed index with sibling must fail closed');
    assert.equal(targeted.errors[0].code, 'generated-index-rebuild-incomplete');
    assert.deepEqual(await snapshotGeneratedTree(rootDir), before, 'incomplete malformed rebuild must not mutate bytes');

    const complete = await reconcileOpenSpecGeneratedRules(compilerOptions(rootDir, {
      activeChangeIds: ['change-a', 'change-b'],
      selectedChangeIds: ['change-a', 'change-b'],
      selectionSource: 'all',
      now: new Date('2026-08-22T03:00:00.000Z')
    }));
    assert.equal(complete.ok, true, 'all complete coverage may rebuild malformed index');
    const rebuilt = await readGeneratedJson(rootDir, 'index.json');
    assert.deepEqual(rebuilt.changes.map((entry) => entry.change_id), ['change-a', 'change-b']);

    rebuilt.changes[0].trace = '../outside.json';
    await writeFixture(rootDir, '.ai-factory/rules/generated/index.json', `${JSON.stringify(rebuilt, null, 2)}\n`);
    const unsafeBefore = await snapshotGeneratedTree(rootDir);
    const unsafe = await reconcileOpenSpecGeneratedRules(compilerOptions(rootDir, {
      activeChangeIds: ['change-a', 'change-b'],
      selectedChangeIds: ['change-a', 'change-b'],
      selectionSource: 'all'
    }));
    assert.equal(unsafe.ok, false, 'all complete coverage must not bypass unsafe index path metadata');
    assert.equal(unsafe.errors[0].code, 'unsafe-generated-index-path');
    assert.deepEqual(await snapshotGeneratedTree(rootDir), unsafeBefore, 'unsafe index refusal must not mutate generated bytes');

    const invalidIdUnsafe = JSON.parse(JSON.stringify(rebuilt));
    invalidIdUnsafe.changes[0].change_id = 'invalid/change';
    invalidIdUnsafe.changes[0].trace = 'C:\\outside.json';
    await writeFixture(rootDir, '.ai-factory/rules/generated/index.json', `${JSON.stringify(invalidIdUnsafe, null, 2)}\n`);
    const invalidIdBefore = await snapshotGeneratedTree(rootDir);
    const invalidId = await reconcileOpenSpecGeneratedRules(compilerOptions(rootDir, {
      activeChangeIds: ['change-a', 'change-b'],
      selectedChangeIds: ['change-a', 'change-b'],
      selectionSource: 'all'
    }));
    assert.equal(invalidId.ok, false, 'malformed change id must not hide an absolute index path');
    assert.equal(invalidId.errors[0].code, 'unsafe-generated-index-path');
    assert.deepEqual(await snapshotGeneratedTree(rootDir), invalidIdBefore, 'invalid-id unsafe metadata refusal must not mutate generated bytes');

    const duplicateUnsafe = JSON.parse(JSON.stringify(rebuilt));
    duplicateUnsafe.changes[0].trace = '.ai-factory/rules/generated/openspec-trace-change-a.json';
    duplicateUnsafe.changes.push({
      ...duplicateUnsafe.changes[0],
      markdown: { ...duplicateUnsafe.changes[0].markdown },
      trace: '.ai-factory/rules/generated/openspec-trace-change-b.json'
    });
    await writeFixture(rootDir, '.ai-factory/rules/generated/index.json', `${JSON.stringify(duplicateUnsafe, null, 2)}\n`);
    const duplicateBefore = await snapshotGeneratedTree(rootDir);
    const duplicate = await reconcileOpenSpecGeneratedRules(compilerOptions(rootDir, {
      activeChangeIds: ['change-a', 'change-b'],
      selectedChangeIds: ['change-a', 'change-b'],
      selectionSource: 'all'
    }));
    assert.equal(duplicate.ok, false, 'duplicate change entry must not hide mismatched canonical metadata');
    assert.equal(duplicate.errors[0].code, 'unsafe-generated-index-path');
    assert.deepEqual(await snapshotGeneratedTree(rootDir), duplicateBefore, 'duplicate unsafe metadata refusal must not mutate generated bytes');
  });

  it('rejects unsafe base input paths and invalidates malformed base input metadata', async () => {
    const { inspectOpenSpecGeneratedRules, reconcileOpenSpecGeneratedRules } = await loadCompiler();
    const rootDir = await createTempRoot();
    await writeFixture(rootDir, 'openspec/specs/billing/spec.md', baseBillingSpec);
    await createChange(rootDir, 'change-a', { 'auth/spec.md': deltaAuthSpec });
    const initial = await reconcileOpenSpecGeneratedRules(compilerOptions(rootDir, {
      activeChangeIds: ['change-a'],
      selectedChangeIds: ['change-a'],
      selectionSource: 'all'
    }));
    assert.equal(initial.ok, true);
    const validIndex = await readGeneratedJson(rootDir, 'index.json');
    assert.equal(validIndex.base.inputs.length > 0, true, 'fixture must include canonical base input metadata');

    for (const unsafePath of ['../outside.md', 'C:\\outside.md']) {
      const unsafeIndex = JSON.parse(JSON.stringify(validIndex));
      unsafeIndex.base.inputs[0].path = unsafePath;
      await writeFixture(rootDir, '.ai-factory/rules/generated/index.json', `${JSON.stringify(unsafeIndex, null, 2)}\n`);
      const before = await snapshotGeneratedTree(rootDir);

      const inspection = await inspectOpenSpecGeneratedRules({
        rootDir,
        activeChangeIds: ['change-a']
      });
      const reconciliation = await reconcileOpenSpecGeneratedRules(compilerOptions(rootDir, {
        activeChangeIds: ['change-a'],
        selectedChangeIds: ['change-a'],
        selectionSource: 'all'
      }));

      assert.equal(inspection.ok, false, `base input '${unsafePath}' must invalidate generated-rules inspection`);
      assert.equal(inspection.state, 'invalid');
      assert.equal(
        inspection.errors.some((item) => item.code === 'unsafe-generated-index-path'),
        true,
        `base input '${unsafePath}' must report unsafe-generated-index-path`
      );
      assert.equal(reconciliation.ok, false, `base input '${unsafePath}' must block reconciliation`);
      assert.equal(reconciliation.partial, false, `base input '${unsafePath}' must fail before mutation`);
      assert.equal(reconciliation.operationCount, 0, `base input '${unsafePath}' must not publish operations`);
      assert.equal(
        reconciliation.errors.some((item) => item.code === 'unsafe-generated-index-path'),
        true,
        `base input '${unsafePath}' must preserve the fail-closed error`
      );
      assert.deepEqual(
        await snapshotGeneratedTree(rootDir),
        before,
        `base input '${unsafePath}' refusal must not mutate generated bytes`
      );
    }

    const malformedIndex = JSON.parse(JSON.stringify(validIndex));
    delete malformedIndex.base.inputs[0].kind;
    await writeFixture(rootDir, '.ai-factory/rules/generated/index.json', `${JSON.stringify(malformedIndex, null, 2)}\n`);
    const malformedInspection = await inspectOpenSpecGeneratedRules({
      rootDir,
      activeChangeIds: ['change-a']
    });

    assert.equal(malformedInspection.ok, false, 'malformed base input metadata must invalidate inspection');
    assert.equal(malformedInspection.state, 'invalid');
    assert.equal(malformedInspection.indexState, 'malformed');
    assert.equal(
      malformedInspection.errors.some((item) => item.code === 'generated-index-malformed'),
      true,
      'malformed base input metadata must report generated-index-malformed'
    );
  });

  it('keeps missing-root dry-run non-mutating and detects precommit inventory drift', async () => {
    const { reconcileOpenSpecGeneratedRules } = await loadCompiler();
    const rootDir = await createTempRoot();
    await createChange(rootDir, 'change-a', { 'auth/spec.md': deltaAuthSpec });

    const dryRun = await reconcileOpenSpecGeneratedRules(compilerOptions(rootDir, {
      activeChangeIds: ['change-a'],
      selectedChangeIds: ['change-a'],
      selectionSource: 'all',
      dryRun: true
    }));
    assert.equal(dryRun.ok, true, 'all/change-a missing generated root dry-run should succeed');
    assert.equal(dryRun.operations.every((item) => item.action === 'would-write'), true);
    assert.equal(await pathExists(path.join(rootDir, '.ai-factory', 'rules', 'generated')), false, 'dry-run must not create generated root');

    const conflict = await reconcileOpenSpecGeneratedRules(compilerOptions(rootDir, {
      activeChangeIds: ['change-a'],
      selectedChangeIds: ['change-a'],
      selectionSource: 'all',
      beforeCommit: async () => {
        await createChange(rootDir, 'change-b');
      }
    }));
    assert.equal(conflict.ok, false, 'all/change-a concurrent active inventory change must conflict');
    assert.equal(conflict.partial, false);
    assert.equal(conflict.errors[0].code, 'generated-rules-inventory-conflict');
    assert.equal(await pathExists(path.join(rootDir, '.ai-factory', 'rules', 'generated')), false, 'precommit conflict must not mutate generated root');

    const failingRoot = await createTempRoot();
    await createChange(failingRoot, 'change-a', { 'auth/spec.md': deltaAuthSpec });
    const rootCreated = await reconcileOpenSpecGeneratedRules(compilerOptions(failingRoot, {
      activeChangeIds: ['change-a'],
      selectedChangeIds: ['change-a'],
      selectionSource: 'all',
      fileOps: {
        open: async () => {
          throw Object.assign(new Error('injected first-write failure'), { code: 'EACCES' });
        }
      }
    }));
    assert.equal(rootCreated.ok, false, 'first write failure after root creation must not report success');
    assert.equal(rootCreated.partial, true, 'created generated root is already a partial mutation');
    assert.equal(rootCreated.errors[0].code, 'generated-rules-partial-failure');
    assert.equal(await pathExists(path.join(failingRoot, '.ai-factory', 'rules', 'generated')), true, 'failed first write leaves the newly created generated root visible');
  });

  it('reports partial unlink failure truthfully after atomic index finalization', async () => {
    const { reconcileOpenSpecGeneratedRules } = await loadCompiler();
    const rootDir = await createTempRoot();
    await createChange(rootDir, 'change-a', { 'auth/spec.md': deltaAuthSpec });
    await createChange(rootDir, 'archived-change', { 'auth/spec.md': deltaAuthSpec });
    const initial = await reconcileOpenSpecGeneratedRules(compilerOptions(rootDir, {
      activeChangeIds: ['archived-change', 'change-a'],
      selectedChangeIds: ['archived-change', 'change-a'],
      selectionSource: 'all'
    }));
    assert.equal(initial.ok, true);
    await rm(path.join(rootDir, 'openspec', 'changes', 'archived-change'), { recursive: true, force: true });

    const partial = await reconcileOpenSpecGeneratedRules(compilerOptions(rootDir, {
      activeChangeIds: ['change-a'],
      selectedChangeIds: ['change-a'],
      selectionSource: 'explicit',
      fileOps: {
        unlink: async (targetPath) => {
          if (path.basename(targetPath) === 'openspec-change-archived-change.md') {
            throw Object.assign(new Error('injected unlink failure'), { code: 'EACCES' });
          }
          return fsUnlink(targetPath);
        }
      }
    }));

    assert.equal(partial.ok, false, 'explicit/change-a unlink failure must not report success');
    assert.equal(partial.partial, true, 'index mutation before unlink failure must be reported partial');
    assert.equal(partial.errors[0].code, 'generated-rules-partial-failure');
    assert.deepEqual((await readGeneratedJson(rootDir, 'index.json')).changes.map((entry) => entry.change_id), ['change-a']);
    assert.equal(await pathExists(path.join(rootDir, '.ai-factory', 'rules', 'generated', 'openspec-change-archived-change.md')), true, 'failed cleanup target must remain visible');
  });

  it('caps public operation detail without limiting the cleanup authority', async () => {
    const { reconcileOpenSpecGeneratedRules } = await loadCompiler();
    const rootDir = await createTempRoot();
    await mkdir(path.join(rootDir, 'openspec', 'changes'), { recursive: true });
    for (let index = 0; index < 205; index += 1) {
      const changeId = `archived-${String(index).padStart(3, '0')}`;
      await writeFixture(rootDir, `.ai-factory/rules/generated/openspec-change-${changeId}.md`, 'orphan\n');
    }

    const dryRun = await reconcileOpenSpecGeneratedRules(compilerOptions(rootDir, {
      activeChangeIds: [],
      selectedChangeIds: [],
      selectionSource: 'none',
      dryRun: true
    }));
    assert.equal(dryRun.ok, true, 'no-active dry-run with 205 orphans should succeed');
    assert.equal(dryRun.operationCount, 208, 'full internal plan should include ignore/base/index writes and 205 removals');
    assert.equal(dryRun.operations.length, 200, 'public operation detail should be capped at 200');
    assert.equal(dryRun.operationsTruncated, true);

    const applied = await reconcileOpenSpecGeneratedRules(compilerOptions(rootDir, {
      activeChangeIds: [],
      selectedChangeIds: [],
      selectionSource: 'none'
    }));
    assert.equal(applied.ok, true, 'no-active real cleanup with 205 orphans should succeed');
    assert.equal(applied.operationCount, 208, 'real cleanup should retain full internal authority');
    const remaining = await readdir(path.join(rootDir, '.ai-factory', 'rules', 'generated'));
    assert.deepEqual(remaining.sort(), ['.gitignore', 'index.json', 'openspec-base.md'], 'all recognized orphan outputs must be removed beyond public cap');
  });
});

describe('compileOpenSpecRules filesystem fallback', () => {
  it('compiles base specs only and leaves canonical OpenSpec files untouched', async () => {
    const { compileOpenSpecRules } = await loadCompiler();
    const rootDir = await createTempRoot();
    await createChange(rootDir, 'add-generated-rules');
    const specPath = await writeFixture(rootDir, 'openspec/specs/billing/spec.md', baseBillingSpec);

    const result = await compileOpenSpecRules('add-generated-rules', compilerOptions(rootDir, {
      now: new Date('2026-05-09T00:00:00.000Z')
    }));

    assert.equal(result.ok, true);
    assert.equal(result.changeId, 'add-generated-rules');
    assert.equal(result.mode, 'filesystem-fallback');
    assert.equal(result.openspecCli.command, 'openspec');
    assert.equal(result.openspecCli.commandSource, 'path');
    assert.deepEqual(result.errors, []);
    assert.equal(result.files.length, 5);
    assert.deepEqual(result.files.map((file) => file.kind), ['base', 'change', 'merged', 'trace', 'index']);
    assert.equal(result.files.every((file) => path.isAbsolute(file.path) && file.written), true);
    assert.equal(result.sources.some((source) => source.kind === 'base' && source.relativePath === 'openspec/specs/billing/spec.md'), true);
    assert.equal(result.warnings.some((warning) => warning.code === 'missing-cli'), true);

    const baseRules = await readGenerated(rootDir, 'openspec-base.md');
    const changeRules = await readGenerated(rootDir, 'openspec-change-add-generated-rules.md');
    const mergedRules = await readGenerated(rootDir, 'openspec-merged-add-generated-rules.md');
    const trace = await readGeneratedJson(rootDir, 'openspec-rules-trace-add-generated-rules.json');
    const index = await readGeneratedJson(rootDir, 'index.json');

    assert.match(baseRules, /^# Generated OpenSpec Rules/m);
    assert.match(baseRules, /openspec\/specs\/billing\/spec\.md/);
    assert.match(baseRules, /Requirement: Track Usage/);
    assert.match(baseRules, /Scenario: usage is captured/);
    assert.match(baseRules, /GIVEN a billable account/);
    assert.match(baseRules, /sha256:/);
    assert.doesNotMatch(baseRules, /\d{4}-\d{2}-\d{2}T/);
    assert.match(changeRules, /No OpenSpec change requirements found/);
    assert.match(mergedRules, /Requirement: Track Usage/);
    assert.equal(trace.schema_version, 1);
    assert.equal(trace.validator, 'aifhub-generated-rules-trace');
    assert.equal(trace.change_id, 'add-generated-rules');
    assert.equal(trace.generated_at, '2026-05-09T00:00:00.000Z');
    assert.deepEqual(trace.inputs, [
      {
        path: 'openspec/specs/billing/spec.md',
        sha256: result.sources[0].fingerprint,
        kind: 'base-spec'
      }
    ]);
    assert.deepEqual(trace.outputs.map((output) => output.kind), ['base-rules', 'change-rules', 'merged-rules']);
    assert.equal(trace.outputs.find((output) => output.kind === 'base-rules').sha256, fingerprint(baseRules));
    assert.equal(trace.outputs.find((output) => output.kind === 'change-rules').sha256, fingerprint(changeRules));
    assert.equal(trace.outputs.find((output) => output.kind === 'merged-rules').sha256, fingerprint(mergedRules));
    assert.equal(trace.rules.length, 1);
    assert.match(trace.rules[0].id, /^base-billing-track-usage-[a-f0-9]{8}$/);
    assert.equal(trace.rules[0].severity, 'must');
    assert.deepEqual(trace.rules[0].source, {
      path: 'openspec/specs/billing/spec.md',
      requirement: 'Track Usage'
    });
    assert.match(trace.rules[0].rule_text, /MUST track customer usage/);
    assert.equal(index.schema_version, 1);
    assert.equal(index.generated_at, '2026-05-09T00:00:00.000Z');
    assert.deepEqual(index.base.inputs, trace.inputs);
    assert.deepEqual(index.changes.map((entry) => entry.change_id), ['add-generated-rules']);
    assert.equal(index.changes[0].trace, '.ai-factory/rules/generated/openspec-rules-trace-add-generated-rules.json');
    assert.equal(index.changes[0].markdown.merged, '.ai-factory/rules/generated/openspec-merged-add-generated-rules.md');
    assert.equal(await readFile(specPath, 'utf8'), baseBillingSpec);
    assert.equal(await pathExists(path.join(rootDir, 'openspec', 'changes', 'add-generated-rules', '.ai-factory')), false);
  });

  it('refreshes base-only generated rules and index without requiring a change trace', async () => {
    const { compileOpenSpecBaseRules } = await loadCompiler();
    const rootDir = await createTempRoot();
    await writeFixture(rootDir, 'openspec/specs/billing/spec.md', baseBillingSpec);

    const result = await compileOpenSpecBaseRules(compilerOptions(rootDir, {
      now: new Date('2026-05-09T01:00:00.000Z')
    }));

    assert.equal(result.ok, true);
    assert.equal(result.changeId, null);
    assert.deepEqual(result.files.map((file) => file.kind), ['base', 'index']);
    assert.match(await readGenerated(rootDir, 'openspec-base.md'), /Requirement: Track Usage/);

    const index = await readGeneratedJson(rootDir, 'index.json');
    assert.equal(index.generated_at, '2026-05-09T01:00:00.000Z');
    assert.equal(index.base.markdown, '.ai-factory/rules/generated/openspec-base.md');
    assert.deepEqual(index.changes, []);
    assert.equal(await pathExists(path.join(rootDir, '.ai-factory', 'rules', 'generated', 'openspec-rules-trace-add-generated-rules.json')), false);
  });

  it('preserves change trace index entries during direct base-only refresh by default', async () => {
    const { compileOpenSpecBaseRules } = await loadCompiler();
    const rootDir = await createTempRoot();
    await writeFixture(rootDir, 'openspec/specs/billing/spec.md', baseBillingSpec);
    await writeFixture(rootDir, '.ai-factory/rules/generated/index.json', `${JSON.stringify({
      schema_version: 1,
      generated_at: '2026-05-09T00:00:00.000Z',
      base: null,
      changes: [
        {
          change_id: 'add-existing',
          generated_at: '2026-05-09T00:00:00.000Z',
          trace: '.ai-factory/rules/generated/openspec-rules-trace-add-existing.json',
          markdown: {
            base: '.ai-factory/rules/generated/openspec-base.md',
            change: '.ai-factory/rules/generated/openspec-change-add-existing.md',
            merged: '.ai-factory/rules/generated/openspec-merged-add-existing.md'
          }
        }
      ]
    }, null, 2)}\n`);

    const result = await compileOpenSpecBaseRules(compilerOptions(rootDir, {
      now: new Date('2026-05-09T02:00:00.000Z')
    }));

    assert.equal(result.ok, true);
    const index = await readGeneratedJson(rootDir, 'index.json');
    assert.equal(index.generated_at, '2026-05-09T02:00:00.000Z');
    assert.equal(index.base.markdown, '.ai-factory/rules/generated/openspec-base.md');
    assert.deepEqual(index.changes.map((entry) => entry.change_id), ['add-existing']);
  });

  it('compiles delta specs only and includes change metadata in change and merged output', async () => {
    const { compileOpenSpecRules } = await loadCompiler();
    const rootDir = await createTempRoot();
    await createChange(rootDir, 'add-mfa', {
      'auth/spec.md': deltaAuthSpec
    });

    const result = await compileOpenSpecRules('add-mfa', compilerOptions(rootDir));

    assert.equal(result.ok, true);
    assert.equal(result.sources.some((source) => source.kind === 'change' && source.changeId === 'add-mfa'), true);

    const baseRules = await readGenerated(rootDir, 'openspec-base.md');
    const changeRules = await readGenerated(rootDir, 'openspec-change-add-mfa.md');
    const mergedRules = await readGenerated(rootDir, 'openspec-merged-add-mfa.md');

    assert.match(baseRules, /No base OpenSpec requirements found/);
    assert.match(changeRules, /Change: add-mfa/);
    assert.match(changeRules, /ADDED Requirements/);
    assert.match(changeRules, /Requirement: Require MFA/);
    assert.match(changeRules, /openspec\/changes\/add-mfa\/specs\/auth\/spec\.md/);
    assert.match(mergedRules, /Change: add-mfa/);
    assert.match(mergedRules, /Requirement: Require MFA/);
  });

  it('writes stable merged output with base requirements before delta requirements', async () => {
    const { compileOpenSpecRules } = await loadCompiler();
    const rootDir = await createTempRoot();
    await writeFixture(rootDir, 'openspec/specs/zeta/spec.md', `# Zeta

## Requirements

### Requirement: Base Zeta

The system MUST keep zeta behavior.
`);
    await writeFixture(rootDir, 'openspec/specs/alpha/spec.md', `# Alpha

## Requirements

### Requirement: Base Alpha

The system MUST keep alpha behavior.
`);
    await createChange(rootDir, 'sort-generated-rules', {
      'beta/spec.md': `# Beta

## ADDED Requirements

### Requirement: Delta Beta

The system MUST add beta behavior.
`
    });

    await compileOpenSpecRules('sort-generated-rules', compilerOptions(rootDir));
    const firstBase = await readGenerated(rootDir, 'openspec-base.md');
    const firstChange = await readGenerated(rootDir, 'openspec-change-sort-generated-rules.md');
    const firstMerged = await readGenerated(rootDir, 'openspec-merged-sort-generated-rules.md');

    await compileOpenSpecRules('sort-generated-rules', compilerOptions(rootDir));
    const secondBase = await readGenerated(rootDir, 'openspec-base.md');
    const secondChange = await readGenerated(rootDir, 'openspec-change-sort-generated-rules.md');
    const secondMerged = await readGenerated(rootDir, 'openspec-merged-sort-generated-rules.md');

    assert.equal(secondBase, firstBase);
    assert.equal(secondChange, firstChange);
    assert.equal(secondMerged, firstMerged);
    assert.ok(secondBase.indexOf('Requirement: Base Alpha') < secondBase.indexOf('Requirement: Base Zeta'));
    assert.ok(secondMerged.indexOf('Requirement: Base Alpha') < secondMerged.indexOf('Requirement: Delta Beta'));
  });

  it('fails clearly for an explicit missing change and writes no generated files', async () => {
    const { compileOpenSpecRules } = await loadCompiler();
    const rootDir = await createTempRoot();
    await createChange(rootDir, 'available-change');

    const result = await compileOpenSpecRules('missing-change', compilerOptions(rootDir));

    assert.equal(result.ok, false);
    assert.equal(result.changeId, null);
    assert.equal(result.files.length, 0);
    assert.equal(result.errors[0].code, 'explicit-change-not-found');
    assert.equal(await pathExists(path.join(rootDir, '.ai-factory', 'rules', 'generated')), false);
  });

  it('rejects unsafe change ids before writing generated files', async () => {
    const { compileOpenSpecRules } = await loadCompiler();
    const rootDir = await createTempRoot();

    const result = await compileOpenSpecRules('../escape', compilerOptions(rootDir));

    assert.equal(result.ok, false);
    assert.equal(result.changeId, null);
    assert.equal(result.files.length, 0);
    assert.equal(result.errors[0].code, 'invalid-change-id');
    assert.equal(await pathExists(path.join(rootDir, '.ai-factory', 'rules', 'generated')), false);
  });

  it('rejects duplicate generated output filenames before writing files', async () => {
    const { writeGeneratedRules } = await loadCompiler();
    const rootDir = await createTempRoot();

    const result = await writeGeneratedRules('duplicate-files', {
      files: [
        {
          kind: 'base',
          fileName: 'openspec-base.md',
          content: 'base one\n'
        },
        {
          kind: 'base',
          fileName: 'openspec-base.md',
          content: 'base two\n'
        },
        {
          kind: 'change',
          fileName: 'openspec-change-duplicate-files.md',
          content: 'change\n'
        }
      ]
    }, { rootDir });

    assert.equal(result.ok, false);
    assert.equal(result.files.length, 0);
    assert.equal(result.errors[0].code, 'invalid-rendered-files');
    assert.equal(await pathExists(path.join(rootDir, '.ai-factory', 'rules', 'generated')), false);
  });

  it('resolves the active change when no change id is provided', async () => {
    const { compileOpenSpecRules } = await loadCompiler();
    const rootDir = await createTempRoot();
    await createChange(rootDir, 'branch-rules', {
      'auth/spec.md': deltaAuthSpec
    });

    const result = await compileOpenSpecRules(undefined, compilerOptions(rootDir, {
      getCurrentBranch: async () => 'feat/branch-rules'
    }));

    assert.equal(result.ok, true);
    assert.equal(result.changeId, 'branch-rules');
    assert.equal(result.files.some((file) => file.relativePath === '.ai-factory/rules/generated/openspec-merged-branch-rules.md'), true);
  });
});

describe('compileOpenSpecRules CLI JSON preference', () => {
  it('prefers compatible OpenSpec CLI JSON requirements when available', async () => {
    const { compileOpenSpecRules } = await loadCompiler();
    const rootDir = await createTempRoot();
    await writeFixture(rootDir, 'openspec/specs/billing/spec.md', `# Billing

## Requirements

### Requirement: Fallback Base

The fallback parser SHOULD NOT be used when CLI JSON is complete.
`);
    await createChange(rootDir, 'cli-rules', {
      'auth/spec.md': `# Auth

## ADDED Requirements

### Requirement: Fallback Delta

The fallback parser SHOULD NOT be used when CLI JSON is complete.
`
    });
    const calls = [];
    const detectionCalls = [];
    const explicitCommand = 'custom-openspec';

    const result = await compileOpenSpecRules('cli-rules', compilerOptions(rootDir, {
      command: explicitCommand,
      detectOpenSpec: async (options) => {
        detectionCalls.push(options);
        return {
        available: true,
        canValidate: true,
        canArchive: true,
        version: '1.3.1',
        supportedRange: '>=1.3.1 <2.0.0',
        versionSupported: true,
        requiresNode: '>=20.19.0',
        nodeVersion: '20.19.0',
        nodeSupported: true,
        command: explicitCommand,
        commandSource: 'explicit',
        reason: null,
        errors: []
        };
      },
      showOpenSpecItem: async (itemName, options) => {
        calls.push({ itemName, options });
        return {
          ok: true,
          json: {
            requirements: [
              {
                title: `CLI ${itemName}`,
                description: `Requirement from CLI for ${itemName}.`,
                scenarios: [
                  {
                    title: 'cli scenario',
                    steps: ['GIVEN CLI JSON', 'WHEN compiled', 'THEN generated rules use it']
                  }
                ]
              }
            ]
          },
          error: null
        };
      }
    }));

    assert.equal(result.ok, true);
    assert.equal(result.mode, 'cli-json');
    assert.equal(detectionCalls.length, 1);
    assert.equal(detectionCalls[0].command, explicitCommand);
    assert.equal(result.openspecCli.command, explicitCommand);
    assert.equal(result.openspecCli.commandSource, 'explicit');
    assert.deepEqual(calls.map((call) => [call.itemName, call.options.deltasOnly]), [
      ['billing', false],
      ['auth', true]
    ]);
    assert.equal(calls.every((call) => call.options.command === explicitCommand), true);

    const mergedRules = await readGenerated(rootDir, 'openspec-merged-cli-rules.md');
    assert.match(mergedRules, /Requirement: CLI billing/);
    assert.match(mergedRules, /Requirement: CLI auth/);
    assert.doesNotMatch(mergedRules, /Fallback Base/);
    assert.doesNotMatch(mergedRules, /Fallback Delta/);
  });
});

describe('OpenSpec requirements extraction helpers', () => {
  it('parses documented markdown fallback sections, requirements, and scenarios', async () => {
    const { parseSpecMarkdownFallback } = await loadCompiler();

    const parsed = parseSpecMarkdownFallback(`# Capability

## Requirements

### Requirement: Base Behavior

The system MUST keep base behavior.

#### Scenario: base scenario

- GIVEN base state
- WHEN base action runs
- THEN base outcome occurs

## MODIFIED Requirements

### Requirement: Modified Behavior

The system MUST update behavior.

## REMOVED Requirements

### Requirement: Removed Behavior

The system MUST remove old behavior.
`);

    assert.deepEqual(parsed.requirements.map((requirement) => [requirement.section, requirement.title]), [
      ['Requirements', 'Base Behavior'],
      ['MODIFIED Requirements', 'Modified Behavior'],
      ['REMOVED Requirements', 'Removed Behavior']
    ]);
    assert.deepEqual(parsed.requirements[0].scenarios[0], {
      title: 'base scenario',
      steps: ['GIVEN base state', 'WHEN base action runs', 'THEN base outcome occurs']
    });
  });

  it('extracts requirements from nested OpenSpec show JSON shapes', async () => {
    const { extractRequirementsFromShowJson } = await loadCompiler();

    const extracted = extractRequirementsFromShowJson({
      spec: {
        requirements: {
          'Base JSON': {
            description: 'The system MUST read base JSON.',
            scenarios: [
              {
                name: 'base json scenario',
                steps: ['GIVEN JSON', 'WHEN extracted', 'THEN it becomes a requirement']
              }
            ]
          }
        }
      },
      deltas: {
        added: {
          requirements: [
            {
              title: 'Added JSON',
              description: 'The system MUST read delta JSON.'
            }
          ]
        }
      }
    });

    assert.deepEqual(extracted.requirements.map((requirement) => [requirement.section, requirement.title]), [
      ['Requirements', 'Base JSON'],
      ['ADDED Requirements', 'Added JSON']
    ]);
    assert.deepEqual(extracted.requirements[0].scenarios[0].steps, [
      'GIVEN JSON',
      'WHEN extracted',
      'THEN it becomes a requirement'
    ]);
  });

  it('preserves structured given when then scenario fields from CLI JSON', async () => {
    const { extractRequirementsFromShowJson } = await loadCompiler();

    const extracted = extractRequirementsFromShowJson({
      requirements: [
        {
          title: 'Structured Scenario',
          description: 'The system MUST preserve structured scenario steps.',
          scenarios: [
            {
              title: 'structured flow',
              given: 'GIVEN an OpenSpec CLI scenario',
              when: 'WHEN generated rules are compiled',
              then: 'THEN every structured step is preserved'
            }
          ]
        }
      ]
    });

    assert.deepEqual(extracted.requirements[0].scenarios[0].steps, [
      'GIVEN an OpenSpec CLI scenario',
      'WHEN generated rules are compiled',
      'THEN every structured step is preserved'
    ]);
  });
});
