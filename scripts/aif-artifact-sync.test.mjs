// aif-artifact-sync.test.mjs - tests for AIFHub mode switching and artifact sync
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  doctorAifMode,
  exportOpenSpecCompatibility,
  getModeStatus,
  renderConfigForMode,
  switchToAiFactoryMode,
  switchToOpenSpecMode,
  syncOpenSpecArtifacts
} from './aif-artifact-sync.mjs';
import {
  createGateResult,
  renderGateResultBlock
} from './aif-gate-result.mjs';

const tempRoots = [];

async function createTempRoot() {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'aifhub-mode-'));
  tempRoots.push(rootDir);
  return rootDir;
}

async function writeFixture(rootDir, relativePath, content) {
  const targetPath = path.join(rootDir, ...relativePath.split('/'));
  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeFile(targetPath, content, 'utf8');
}

async function readFixture(rootDir, relativePath) {
  return readFile(path.join(rootDir, ...relativePath.split('/')), 'utf8');
}

async function readJsonFixture(rootDir, relativePath) {
  return JSON.parse(await readFixture(rootDir, relativePath));
}

async function pathExists(rootDir, relativePath) {
  try {
    await access(path.join(rootDir, ...relativePath.split('/')));
    return true;
  } catch {
    return false;
  }
}

async function snapshotSelectedPaths(rootDir, relativePaths) {
  return Promise.all(relativePaths.map(async (relativePath) => {
    if (!await pathExists(rootDir, relativePath)) {
      return [relativePath, null];
    }
    return [relativePath, await readFixture(rootDir, relativePath)];
  }));
}

function missingCliDetection() {
  return {
    available: false,
    canValidate: false,
    canArchive: false,
    version: null,
    latestReviewedVersion: '1.12.0',
    versionOutdated: null,
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

function availableCliDetection(overrides = {}) {
  const version = overrides.version ?? '1.3.1';
  return {
    available: true,
    canValidate: true,
    canArchive: true,
    version,
    latestReviewedVersion: '1.12.0',
    versionOutdated: overrides.versionOutdated ?? version.localeCompare('1.12.0', 'en', { numeric: true }) < 0,
    command: overrides.command ?? 'openspec',
    commandSource: overrides.commandSource ?? 'path',
    nodeVersion: overrides.nodeVersion ?? '20.19.0',
    nodeSupported: overrides.nodeSupported ?? true,
    versionSupported: overrides.versionSupported ?? true,
    reason: overrides.reason ?? null,
    errors: overrides.errors ?? []
  };
}

function generatedIndexEntry(changeId, generatedAt = '2026-08-22T00:00:00.000Z') {
  return {
    change_id: changeId,
    generated_at: generatedAt,
    trace: `.ai-factory/rules/generated/openspec-rules-trace-${changeId}.json`,
    markdown: {
      base: '.ai-factory/rules/generated/openspec-base.md',
      change: `.ai-factory/rules/generated/openspec-change-${changeId}.md`,
      merged: `.ai-factory/rules/generated/openspec-merged-${changeId}.md`
    }
  };
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((rootDir) => rm(rootDir, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 20
  })));
});

describe('mode status', () => {
  it('surfaces reviewed-version freshness for a supported old CLI', async () => {
    const rootDir = await createTempRoot();
    await writeFixture(rootDir, '.ai-factory/config.yaml', [
      'aifhub:',
      '  artifactProtocol: openspec',
      ''
    ].join('\n'));

    const status = await getModeStatus({
      rootDir,
      detectOpenSpec: async () => availableCliDetection({
        version: '1.4.0',
        versionOutdated: true
      })
    });

    assert.equal(status.openspecCli.state, 'available');
    assert.equal(status.openspecCli.version, '1.4.0');
    assert.equal(status.openspecCli.latestReviewedVersion, '1.12.0');
    assert.equal(status.openspecCli.versionOutdated, true);
    assert.equal(status.openspecCli.canValidate, true);
    assert.equal(status.openspecCli.canArchive, true);
  });

  it('preserves fresh, newer-supported and unknown reviewed-version classifications', async () => {
    const rootDir = await createTempRoot();
    await writeFixture(rootDir, '.ai-factory/config.yaml', [
      'aifhub:',
      '  artifactProtocol: openspec',
      ''
    ].join('\n'));

    for (const expectation of [
      { version: '1.12.0', versionOutdated: false },
      { version: '1.12.1', versionOutdated: false }
    ]) {
      const status = await getModeStatus({
        rootDir,
        detectOpenSpec: async () => availableCliDetection(expectation)
      });

      assert.equal(status.openspecCli.version, expectation.version);
      assert.equal(status.openspecCli.latestReviewedVersion, '1.12.0');
      assert.equal(status.openspecCli.versionOutdated, false);
      assert.equal(status.openspecCli.commandSource, 'path');
    }

    const missing = await getModeStatus({
      rootDir,
      detectOpenSpec: async () => missingCliDetection()
    });
    assert.equal(missing.openspecCli.version, null);
    assert.equal(missing.openspecCli.latestReviewedVersion, '1.12.0');
    assert.equal(missing.openspecCli.versionOutdated, null);
  });

  it('reports OpenSpec mode and drift fields', async () => {
    const rootDir = await createTempRoot();
    await writeFixture(rootDir, '.ai-factory/config.yaml', [
      'aifhub:',
      '  artifactProtocol: openspec',
      'paths:',
      '  plans: openspec/changes',
      '  specs: openspec/specs',
      '  state: .ai-factory/state',
      '  qa: .ai-factory/qa',
      '  generated_rules: .ai-factory/rules/generated',
      ''
    ].join('\n'));
    await writeFixture(rootDir, 'openspec/changes/add-oauth/proposal.md', '# Proposal\n');

    const status = await getModeStatus({
      rootDir,
      detectOpenSpec: async () => missingCliDetection(),
      getCurrentBranch: async () => 'feat/add-oauth'
    });

    assert.equal(status.mode, 'openspec');
    assert.equal(status.configMarker, 'openspec');
    assert.equal(status.openspecCli.state, 'degraded');
    assert.equal(status.openSpecChanges.length, 1);
    assert.equal(status.activeChange.changeId, 'add-oauth');
    assert.equal(status.generatedRules.state, 'missing');
    assert.equal(status.effectivePolicy.requirements.cli.done, true);
    assert.equal(status.effectivePolicy.requirements.specCoverage.verify, false);
  });

  it('fails status and doctor closed when the authoritative active inventory is unreadable', async () => {
    const rootDir = await createTempRoot();
    await writeFixture(rootDir, '.ai-factory/config.yaml', [
      'aifhub:',
      '  artifactProtocol: openspec',
      'paths:',
      '  plans: openspec/changes',
      '  specs: openspec/specs',
      '  state: .ai-factory/state',
      '  qa: .ai-factory/qa',
      '  generated_rules: .ai-factory/rules/generated',
      ''
    ].join('\n'));
    await writeFixture(rootDir, 'openspec/changes/change-a/proposal.md', '# change-a\n');
    await writeFixture(rootDir, '.ai-factory/rules/generated/openspec-base.md', '# Base rules\n');
    await writeFixture(rootDir, '.ai-factory/rules/generated/index.json', `${JSON.stringify({
      schema_version: 1,
      generated_at: '2026-08-22T00:00:00.000Z',
      base: {
        markdown: '.ai-factory/rules/generated/openspec-base.md',
        inputs: []
      },
      changes: []
    }, null, 2)}\n`);
    const denyActiveInventory = async (targetPath, options) => {
      if (targetPath === path.join(rootDir, 'openspec', 'changes')) {
        throw Object.assign(new Error('injected private inventory failure'), { code: 'EACCES' });
      }
      return readdir(targetPath, options);
    };
    const options = {
      rootDir,
      detectOpenSpec: async () => missingCliDetection(),
      getCurrentBranch: async () => 'feat/change-a',
      fileOps: { readdir: denyActiveInventory }
    };

    const status = await getModeStatus(options);
    const doctor = await doctorAifMode(options);

    assert.equal(status.ok, false, 'unreadable authoritative inventory must fail status execution');
    assert.equal(status.generatedRules.ok, false, 'generated-rules membership authority must be unavailable');
    assert.equal(status.generatedRules.state, 'invalid');
    assert.equal(status.errors.some((item) => item.code === 'active-inventory-read-failed'), true);
    assert.equal(doctor.diagnostics.some((item) => item.code === 'active-inventory-read-failed' && item.level === 'fail'), true);
    assert.equal(doctor.diagnostics.some((item) => item.code === 'generated-rules' && item.level === 'pass'), false);
  });

  it('reports AI Factory mode', async () => {
    const rootDir = await createTempRoot();
    await writeFixture(rootDir, '.ai-factory/config.yaml', [
      'aifhub:',
      '  artifactProtocol: ai-factory',
      'paths:',
      '  plans: .ai-factory/plans',
      '  specs: .ai-factory/specs',
      '  rules: .ai-factory/rules',
      ''
    ].join('\n'));

    const status = await getModeStatus({
      rootDir,
      detectOpenSpec: async () => missingCliDetection()
    });

    assert.equal(status.mode, 'ai-factory');
    assert.equal(status.configMarker, 'ai-factory');
  });

  it('surfaces missing generated rules trace in status diagnostics', async () => {
    const rootDir = await createTempRoot();
    await writeFixture(rootDir, '.ai-factory/config.yaml', [
      'aifhub:',
      '  artifactProtocol: openspec',
      'paths:',
      '  plans: openspec/changes',
      '  specs: openspec/specs',
      '  state: .ai-factory/state',
      '  qa: .ai-factory/qa',
      '  generated_rules: .ai-factory/rules/generated',
      ''
    ].join('\n'));
    await writeFixture(rootDir, 'openspec/changes/add-oauth/proposal.md', '# Proposal\n');
    await writeFixture(rootDir, 'openspec/changes/add-oauth/design.md', '# Design\n');
    await writeFixture(rootDir, 'openspec/changes/add-oauth/tasks.md', '# Tasks\n');
    await writeFixture(rootDir, 'openspec/changes/add-oauth/specs/auth/spec.md', '# Auth\n');
    await writeFixture(rootDir, '.ai-factory/rules/generated/openspec-base.md', '# Generated\n\n## Source Fingerprints\n');
    await writeFixture(rootDir, '.ai-factory/rules/generated/openspec-change-add-oauth.md', '# Generated\n\n## Source Fingerprints\n');
    await writeFixture(rootDir, '.ai-factory/rules/generated/openspec-merged-add-oauth.md', '# Generated\n\n## Source Fingerprints\n');
    await writeFixture(rootDir, '.ai-factory/rules/generated/index.json', `${JSON.stringify({
      schema_version: 1,
      generated_at: '2026-04-29T00:00:00.000Z',
      base: {
        markdown: '.ai-factory/rules/generated/openspec-base.md',
        inputs: []
      },
      changes: [{
        change_id: 'add-oauth',
        generated_at: '2026-04-29T00:00:00.000Z',
        trace: '.ai-factory/rules/generated/openspec-rules-trace-add-oauth.json',
        markdown: {
          base: '.ai-factory/rules/generated/openspec-base.md',
          change: '.ai-factory/rules/generated/openspec-change-add-oauth.md',
          merged: '.ai-factory/rules/generated/openspec-merged-add-oauth.md'
        }
      }]
    }, null, 2)}\n`);

    const status = await getModeStatus({
      rootDir,
      detectOpenSpec: async () => missingCliDetection(),
      getCurrentBranch: async () => 'feat/add-oauth'
    });

    assert.equal(status.generatedRules.state, 'missing');
    assert.ok(status.generatedRules.missing.includes('openspec-rules-trace-add-oauth.json'));
    assert.ok(status.generatedRules.warnings.some((warning) => warning.code === 'missing-generated-rules-trace'));
  });

  it('reports generated rules stale when traced markdown output is edited', async () => {
    const rootDir = await createTempRoot();
    await writeFixture(rootDir, '.ai-factory/config.yaml', [
      'aifhub:',
      '  artifactProtocol: openspec',
      'paths:',
      '  plans: openspec/changes',
      '  specs: openspec/specs',
      '  state: .ai-factory/state',
      '  qa: .ai-factory/qa',
      '  generated_rules: .ai-factory/rules/generated',
      ''
    ].join('\n'));
    await writeFixture(rootDir, 'openspec/config.yaml', 'project: test\n');
    await writeFixture(rootDir, 'openspec/specs/auth/spec.md', [
      '# Auth',
      '',
      '## Requirements',
      '',
      '### Requirement: Existing Auth',
      '',
      'The system MUST preserve existing authentication.',
      ''
    ].join('\n'));
    await writeFixture(rootDir, 'openspec/changes/add-oauth/proposal.md', '# Proposal\n');
    await writeFixture(rootDir, 'openspec/changes/add-oauth/design.md', '# Design\n');
    await writeFixture(rootDir, 'openspec/changes/add-oauth/tasks.md', '# Tasks\n');
    await writeFixture(rootDir, 'openspec/changes/add-oauth/specs/auth/spec.md', [
      '# Auth Delta',
      '',
      '## ADDED Requirements',
      '',
      '### Requirement: OAuth Login',
      '',
      'The system MUST support OAuth login.',
      ''
    ].join('\n'));
    const sync = await syncOpenSpecArtifacts({
      rootDir,
      changeId: 'add-oauth',
      detectOpenSpec: async () => missingCliDetection(),
      getCurrentBranch: async () => 'feat/add-oauth',
      timestamp: '2026-04-29T01-00-00-000Z'
    });
    assert.equal(sync.ok, true);
    const mergedPath = '.ai-factory/rules/generated/openspec-merged-add-oauth.md';
    const merged = await readFixture(rootDir, mergedPath);
    await writeFixture(rootDir, mergedPath, `${merged}\nManual edit.\n`);

    const status = await getModeStatus({
      rootDir,
      changeId: 'add-oauth',
      detectOpenSpec: async () => missingCliDetection(),
      getCurrentBranch: async () => 'feat/add-oauth'
    });

    assert.equal(status.generatedRules.state, 'stale');
    assert.deepEqual(status.generatedRules.stale, ['openspec-merged-add-oauth.md']);
    assert.ok(status.generatedRules.warnings.some((warning) => warning.code === 'stale-generated-rules'));
  });

  it('limits expensive hash inspection to an explicit change while auditing full active membership', async () => {
    const rootDir = await createTempRoot();
    await writeFixture(rootDir, '.ai-factory/config.yaml', [
      'aifhub:',
      '  artifactProtocol: openspec',
      'paths:',
      '  plans: openspec/changes',
      '  specs: openspec/specs',
      '  state: .ai-factory/state',
      '  qa: .ai-factory/qa',
      '  generated_rules: .ai-factory/rules/generated',
      ''
    ].join('\n'));
    await writeFixture(rootDir, 'openspec/config.yaml', 'project: test\n');
    await writeFixture(rootDir, 'openspec/changes/add-oauth/proposal.md', '# Proposal\n');
    await writeFixture(rootDir, 'openspec/changes/add-oauth/specs/auth/spec.md', [
      '# Auth',
      '',
      '## ADDED Requirements',
      '',
      '### Requirement: OAuth',
      '',
      'The system MUST support OAuth.',
      ''
    ].join('\n'));
    await writeFixture(rootDir, 'openspec/changes/add-passkeys/proposal.md', '# Proposal\n');

    await syncOpenSpecArtifacts({
      rootDir,
      changeId: 'add-oauth',
      detectOpenSpec: async () => missingCliDetection(),
      timestamp: '2026-04-29T03-00-00-000Z'
    });

    const explicit = await getModeStatus({
      rootDir,
      changeId: 'add-oauth',
      detectOpenSpec: async () => missingCliDetection(),
      getCurrentBranch: async () => 'feat/add-oauth'
    });

    assert.equal(explicit.activeChange.changeId, 'add-oauth');
    assert.equal(explicit.generatedRules.state, 'missing');
    assert.deepEqual(explicit.generatedRules.missingActiveIndexEntries, ['add-passkeys']);
    assert.equal(explicit.generatedRules.missing.includes('openspec-change-add-passkeys.md'), true);
  });

  it('audits active index membership beyond the 50-change hash inspection cap', async () => {
    const rootDir = await createTempRoot();
    await writeFixture(rootDir, '.ai-factory/config.yaml', [
      'aifhub:',
      '  artifactProtocol: openspec',
      'paths:',
      '  plans: openspec/changes',
      '  specs: openspec/specs',
      '  state: .ai-factory/state',
      '  qa: .ai-factory/qa',
      '  generated_rules: .ai-factory/rules/generated',
      ''
    ].join('\n'));
    const changeIds = Array.from({ length: 51 }, (_, index) => `change-${String(index).padStart(3, '0')}`);
    for (const changeId of changeIds) {
      await writeFixture(rootDir, `openspec/changes/${changeId}/proposal.md`, `# ${changeId}\n`);
    }
    await writeFixture(rootDir, '.ai-factory/rules/generated/openspec-base.md', '# Generated\n');
    await writeFixture(rootDir, '.ai-factory/rules/generated/index.json', `${JSON.stringify({
      schema_version: 1,
      generated_at: '2026-08-22T00:00:00.000Z',
      base: {
        markdown: '.ai-factory/rules/generated/openspec-base.md',
        inputs: []
      },
      changes: changeIds.slice(0, 50).map((changeId) => generatedIndexEntry(changeId))
    }, null, 2)}\n`);

    const status = await getModeStatus({
      rootDir,
      detectOpenSpec: async () => missingCliDetection(),
      getCurrentBranch: async () => 'main'
    });

    assert.equal(status.openSpecChanges.length, 51);
    assert.equal(status.generatedRules.state, 'missing');
    assert.deepEqual(status.generatedRules.missingActiveIndexEntries, ['change-050'], 'full membership audit must include the 51st active change');
    assert.equal(status.generatedRules.expected.includes('openspec-change-change-050.md'), true);
  });

  it('ignores benign unknown generated children but fails doctor on managed-name collisions', async () => {
    const rootDir = await createTempRoot();
    await writeFixture(rootDir, '.ai-factory/config.yaml', [
      'aifhub:',
      '  artifactProtocol: openspec',
      '  openspec:',
      '    validateOnSync: false',
      'paths:',
      '  plans: openspec/changes',
      '  specs: openspec/specs',
      '  state: .ai-factory/state',
      '  qa: .ai-factory/qa',
      '  generated_rules: .ai-factory/rules/generated',
      ''
    ].join('\n'));
    await writeFixture(rootDir, 'openspec/changes/change-a/proposal.md', '# change-a\n');
    const synced = await syncOpenSpecArtifacts({
      rootDir,
      changeId: 'change-a',
      writeReport: false,
      detectOpenSpec: async () => missingCliDetection()
    });
    assert.equal(synced.ok, true);
    await writeFixture(rootDir, '.ai-factory/rules/generated/notes.txt', 'user-owned\n');

    const benign = await getModeStatus({
      rootDir,
      changeId: 'change-a',
      detectOpenSpec: async () => missingCliDetection(),
      getCurrentBranch: async () => 'feat/change-a'
    });
    assert.equal(benign.generatedRules.state, 'ok', 'unknown regular child must not create drift');
    assert.equal(benign.generatedRules.warnings.some((item) => item.code === 'orphaned-generated-managed-file'), false);

    await mkdir(path.join(rootDir, '.ai-factory', 'rules', 'generated', 'openspec-change-archived.md'));
    const invalid = await getModeStatus({
      rootDir,
      changeId: 'change-a',
      detectOpenSpec: async () => missingCliDetection(),
      getCurrentBranch: async () => 'feat/change-a'
    });
    const doctor = await doctorAifMode({
      rootDir,
      changeId: 'change-a',
      detectOpenSpec: async () => missingCliDetection(),
      getCurrentBranch: async () => 'feat/change-a'
    });

    assert.equal(invalid.generatedRules.state, 'invalid');
    assert.deepEqual(invalid.generatedRules.invalidManagedEntries, ['.ai-factory/rules/generated/openspec-change-archived.md']);
    assert.equal(invalid.generatedRules.errors.some((item) => item.code === 'invalid-managed-entry'), true);
    assert.equal(doctor.diagnostics.some((item) => item.code === 'generated-rules-invalid' && item.level === 'fail'), true);
  });

  it('does not inspect generated content through an unsafe generated-rules root', async () => {
    const rootDir = await createTempRoot();
    const externalRoot = await createTempRoot();
    await writeFixture(rootDir, '.ai-factory/config.yaml', [
      'aifhub:',
      '  artifactProtocol: openspec',
      'paths:',
      '  plans: openspec/changes',
      '  specs: openspec/specs',
      '  state: .ai-factory/state',
      '  qa: .ai-factory/qa',
      '  generated_rules: .ai-factory/rules/generated',
      ''
    ].join('\n'));
    await writeFixture(rootDir, 'openspec/changes/change-a/proposal.md', '# change-a\n');
    await writeFixture(externalRoot, 'openspec-base.md', '# External base\n');
    await writeFixture(externalRoot, 'openspec-change-change-a.md', '# External change\n');
    await writeFixture(externalRoot, 'openspec-merged-change-a.md', '# External merged\n');
    await writeFixture(externalRoot, 'openspec-rules-trace-change-a.json', '{malformed external trace\n');
    const generatedDir = path.join(rootDir, '.ai-factory', 'rules', 'generated');
    await mkdir(path.dirname(generatedDir), { recursive: true });
    await symlink(externalRoot, generatedDir, process.platform === 'win32' ? 'junction' : 'dir');

    const status = await getModeStatus({
      rootDir,
      changeId: 'change-a',
      detectOpenSpec: async () => missingCliDetection(),
      getCurrentBranch: async () => 'feat/change-a'
    });

    assert.equal(status.generatedRules.ok, false, 'unsafe generated root must invalidate membership inspection');
    assert.equal(status.generatedRules.state, 'invalid');
    assert.equal(
      status.generatedRules.errors.some((item) => item.code === 'generated-rules-root-unsafe'),
      true,
      'unsafe generated root must retain its primary diagnostic'
    );
    assert.equal(
      status.generatedRules.warnings.some((item) => item.code === 'invalid-generated-rules-trace'),
      false,
      'unsafe generated root must not expose diagnostics derived from the external trace'
    );
  });
});

describe('mode switching', () => {
  it('renders fresh 2.19 warmup, glossary, and review-policy settings without creating optional context files', async () => {
    const rootDir = await createTempRoot();

    const openSpecResult = await switchToOpenSpecMode({
      rootDir,
      detectOpenSpec: async () => missingCliDetection(),
      timestamp: '2026-07-21T00-00-00-000Z'
    });

    assert.equal(openSpecResult.ok, true);
    const openSpecConfig = await readFixture(rootDir, '.ai-factory/config.yaml');
    assert.match(
      openSpecConfig,
      /  description: \.ai-factory\/DESCRIPTION\.md\n  architecture: \.ai-factory\/ARCHITECTURE\.md\n  context: CONTEXT\.md\n  roadmap: \.ai-factory\/ROADMAP\.md\n  research: \.ai-factory\/RESEARCH\.md/,
      'OpenSpec profile should render paths.context in stable project-context order'
    );
    assert.equal(
      await pathExists(rootDir, 'CONTEXT.md'),
      false,
      'OpenSpec profile should not create the optional glossary file'
    );
    assert.match(openSpecConfig, /^reviews:\n  policy_file: REVIEW\.md$/m);
    assert.equal(
      await pathExists(rootDir, 'REVIEW.md'),
      false,
      'OpenSpec mode switch should not create the review policy file'
    );
    assert.match(
      openSpecConfig,
      /^warmup:\n  paths: \[\]$/m,
      'A fresh OpenSpec profile should include the upstream 2.19 warmup default'
    );

    const doctor = await doctorAifMode({
      rootDir,
      detectOpenSpec: async () => missingCliDetection()
    });
    assert.equal(
      doctor.diagnostics.some((diagnostic) => /CONTEXT\.md|paths\.context|REVIEW\.md|reviews\.policy_file/.test(diagnostic.message)),
      false,
      'Mode doctor should not inspect the optional glossary or review policy file'
    );

    const legacyResult = await switchToAiFactoryMode({
      rootDir,
      timestamp: '2026-07-21T00-00-01-000Z'
    });

    assert.equal(legacyResult.ok, true);
    const legacyConfig = await readFixture(rootDir, '.ai-factory/config.yaml');
    assert.match(
      legacyConfig,
      /  description: \.ai-factory\/DESCRIPTION\.md\n  architecture: \.ai-factory\/ARCHITECTURE\.md\n  context: CONTEXT\.md\n  roadmap: \.ai-factory\/ROADMAP\.md\n  research: \.ai-factory\/RESEARCH\.md/,
      'Legacy profile should render paths.context in stable project-context order'
    );
    assert.equal(
      await pathExists(rootDir, 'CONTEXT.md'),
      false,
      'Legacy profile should not create the optional glossary file'
    );
    assert.match(legacyConfig, /^reviews:\n  policy_file: REVIEW\.md$/m);
    assert.equal(
      await pathExists(rootDir, 'REVIEW.md'),
      false,
      'Legacy mode switch should not create the review policy file'
    );
    assert.match(
      legacyConfig,
      /^warmup:\n  paths: \[\]$/m,
      'The fresh-config warmup default should survive a later mode switch'
    );
  });

  it('preserves user-owned warmup paths and never backfills an existing config', async () => {
    const rootDir = await createTempRoot();
    const warmupBlock = [
      'warmup:',
      '  # user-owned startup context',
      '  paths:',
      '    - docs/domain/',
      '    - infrastructure/decisions.md'
    ].join('\n');
    await writeFixture(rootDir, '.ai-factory/config.yaml', [
      'aifhub:',
      '  artifactProtocol: ai-factory',
      'paths:',
      '  plans: .ai-factory/plans',
      '  specs: .ai-factory/specs',
      '  rules: .ai-factory/rules',
      warmupBlock,
      ''
    ].join('\n'));

    await switchToOpenSpecMode({
      rootDir,
      detectOpenSpec: async () => missingCliDetection(),
      timestamp: '2026-09-01T00-00-00-000Z'
    });
    const openSpecConfig = await readFixture(rootDir, '.ai-factory/config.yaml');
    assert.ok(openSpecConfig.includes(warmupBlock), 'OpenSpec mode should preserve user-owned warmup paths and comment text');

    await switchToAiFactoryMode({
      rootDir,
      timestamp: '2026-09-01T00-00-01-000Z'
    });
    const legacyConfig = await readFixture(rootDir, '.ai-factory/config.yaml');
    assert.ok(legacyConfig.includes(warmupBlock), 'Legacy mode should preserve user-owned warmup paths and comment text');

    const existingWithoutWarmup = renderConfigForMode([
      'aifhub:',
      '  artifactProtocol: ai-factory',
      'paths:',
      '  plans: .ai-factory/plans',
      ''
    ].join('\n'), 'openspec');
    assert.doesNotMatch(
      existingWithoutWarmup,
      /^warmup:/m,
      'An existing config without warmup must not receive a backfilled user-owned section'
    );
  });

  it('preserves a custom project-relative glossary path across both mode profiles', async () => {
    const rootDir = await createTempRoot();
    await writeFixture(rootDir, '.ai-factory/config.yaml', [
      'aifhub:',
      '  artifactProtocol: ai-factory',
      'paths:',
      '  context: docs/project-glossary.md',
      '  plans: .ai-factory/plans',
      '  specs: .ai-factory/specs',
      '  rules: .ai-factory/rules',
      'reviews:',
      '  policy_file: docs/review-guidelines.md',
      ''
    ].join('\n'));

    await switchToOpenSpecMode({
      rootDir,
      detectOpenSpec: async () => missingCliDetection(),
      timestamp: '2026-07-21T00-00-02-000Z'
    });
    assert.match(
      await readFixture(rootDir, '.ai-factory/config.yaml'),
      /^  context: docs\/project-glossary\.md$/m,
      'OpenSpec profile should preserve custom paths.context'
    );
    assert.match(
      await readFixture(rootDir, '.ai-factory/config.yaml'),
      /^  policy_file: docs\/review-guidelines\.md$/m,
      'OpenSpec profile should preserve custom reviews.policy_file'
    );

    await switchToAiFactoryMode({
      rootDir,
      timestamp: '2026-07-21T00-00-03-000Z'
    });
    assert.match(
      await readFixture(rootDir, '.ai-factory/config.yaml'),
      /^  context: docs\/project-glossary\.md$/m,
      'Legacy profile should preserve custom paths.context'
    );
    assert.equal(
      await pathExists(rootDir, 'docs/project-glossary.md'),
      false,
      'Mode switching should not create a custom optional glossary file'
    );
    assert.match(
      await readFixture(rootDir, '.ai-factory/config.yaml'),
      /^  policy_file: docs\/review-guidelines\.md$/m,
      'Legacy profile should preserve custom reviews.policy_file'
    );
    assert.equal(
      await pathExists(rootDir, 'docs/review-guidelines.md'),
      false,
      'Mode switching should not create a custom review policy file'
    );
  });

  it('patch-preserves core and unknown config fields while reporting key paths only', async () => {
    const rootDir = await createTempRoot();
    await writeFixture(rootDir, '.ai-factory/config.yaml', [
      'config_version: 1',
      'language:',
      '  ui: ru',
      '  artifacts: ru',
      'aifhub:',
      '  artifactProtocol: ai-factory',
      '  contextDedup:',
      '    mode: off',
      '  openspec:',
      '    validateOnPlan: false',
      '    allowWarnOnDone:',
      '      rules: true',
      '      customGate: keep',
      '    customPolicy:',
      '      owner: user',
      '  customProfile:',
      '    toggle: keep',
      'paths:',
      '  research: docs/research/current.md',
      '  plans: .ai-factory/plans',
      '  specs: .ai-factory/specs',
      '  rules: .ai-factory/rules',
      '  custom_cache: cache/data',
      'workflow:',
      '  custom_step: keep',
      'rules:',
      '  custom_rule: rules/custom.md',
      'agent_profile: precise',
      'upstream_core:',
      '  feature_flag: keep',
      'custom_user:',
      '  sentinel: PRIVATE-CONFIG-VALUE',
      ''
    ].join('\n'));

    const openspec = await switchToOpenSpecMode({
      rootDir,
      detectOpenSpec: async () => missingCliDetection(),
      timestamp: '2026-08-14T00-00-00-000Z'
    });
    assert.equal(openspec.ok, true);
    const openspecConfig = await readFixture(rootDir, '.ai-factory/config.yaml');
    for (const expected of [
      'config_version: 1',
      '  ui: ru',
      '  artifacts: ru',
      '    mode: off',
      '    customPolicy:',
      '      owner: user',
      '      customGate: keep',
      '  customProfile:',
      '    toggle: keep',
      '  research: docs/research/current.md',
      '  custom_cache: cache/data',
      '  custom_step: keep',
      '  custom_rule: rules/custom.md',
      'agent_profile: precise',
      '  feature_flag: keep',
      '  sentinel: PRIVATE-CONFIG-VALUE'
    ]) {
      assert.match(openspecConfig, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
    assert.match(openspecConfig, /^  artifactProtocol: openspec$/m);
    assert.match(openspecConfig, /^    validateOnPlan: true$/m);
    assert.doesNotMatch(openspecConfig, /research_bundles_dir:/);

    for (const keyPath of [
      'aifhub.contextDedup.mode',
      'aifhub.customProfile.toggle',
      'aifhub.openspec.allowWarnOnDone.customGate',
      'aifhub.openspec.customPolicy.owner',
      'custom_user.sentinel',
      'language.ui',
      'paths.research',
      'upstream_core.feature_flag',
      'workflow.custom_step'
    ]) {
      assert.ok(openspec.config.configKeys.preservedKeyPaths.includes(keyPath), `preserved key path: ${keyPath}`);
    }
    assert.ok(openspec.config.configKeys.changedKeyPaths.includes('aifhub.artifactProtocol'));
    assert.ok(openspec.config.configKeys.changedKeyPaths.includes('aifhub.openspec.validateOnPlan'));
    assert.doesNotMatch(JSON.stringify(openspec.config.configKeys), /PRIVATE-CONFIG-VALUE|cache\/data|docs\/research/);

    const legacy = await switchToAiFactoryMode({
      rootDir,
      timestamp: '2026-08-14T00-00-01-000Z'
    });
    assert.equal(legacy.ok, true);
    const legacyConfig = await readFixture(rootDir, '.ai-factory/config.yaml');
    assert.match(legacyConfig, /^  artifactProtocol: ai-factory$/m);
    assert.match(legacyConfig, /^  openspec:$/m);
    assert.match(legacyConfig, /^    customPolicy:$/m);
    assert.match(legacyConfig, /^      owner: user$/m);
    assert.match(legacyConfig, /^    allowWarnOnDone:$/m);
    assert.match(legacyConfig, /^      customGate: keep$/m);
    assert.doesNotMatch(legacyConfig, /^    validateOnPlan:/m);
    assert.doesNotMatch(legacyConfig, /^      rules:/m);
    assert.match(legacyConfig, /^  customProfile:$/m);
    assert.match(legacyConfig, /^    toggle: keep$/m);
    assert.match(legacyConfig, /^  custom_cache: cache\/data$/m);
    for (const openSpecOnlyPath of ['state', 'qa', 'generated_rules']) {
      assert.doesNotMatch(
        legacyConfig,
        new RegExp(`^  ${openSpecOnlyPath}:`, 'm'),
        `Legacy profile should omit OpenSpec-only paths.${openSpecOnlyPath}`
      );
    }
    assert.doesNotMatch(legacyConfig, /research_bundles_dir:/);
  });

  it('drops the dormant OpenSpec block when it contains only AIFHub-owned settings', () => {
    const legacyConfig = renderConfigForMode([
      'aifhub:',
      '  artifactProtocol: openspec',
      '  openspec:',
      '    validateOnPlan: true',
      '    allowWarnOnDone:',
      '      rules: false',
      ''
    ].join('\n'), 'ai-factory');

    assert.match(legacyConfig, /^  artifactProtocol: ai-factory$/m);
    assert.doesNotMatch(legacyConfig, /^  openspec:$/m);
    assert.doesNotMatch(legacyConfig, /validateOnPlan|allowWarnOnDone/);
  });

  it('switches to OpenSpec mode with missing CLI as degraded capability', async () => {
    const rootDir = await createTempRoot();

    const result = await switchToOpenSpecMode({
      rootDir,
      detectOpenSpec: async () => missingCliDetection(),
      timestamp: '2026-04-29T00-00-00-000Z'
    });

    assert.equal(result.ok, true);
    const config = await readFixture(rootDir, '.ai-factory/config.yaml');
    assert.match(config, /artifactProtocol: openspec/);
    for (const line of [
      'installSkills: false',
      'validateOnPlan: true',
      'validateOnImprove: true',
      'validateOnVerify: true',
      'statusOnVerify: true',
      'archiveOnDone: true',
      'useInstructionsApply: true',
      'compileRulesOnSync: true',
      'validateOnSync: true',
      'requireCliForPlan: false',
      'requireCliForImprove: false',
      'requireCliForVerify: false',
      'requireCliForDone: true',
      'requireGeneratedRulesForVerify: false',
      'requireGeneratedRulesForDone: true',
      'requireRulesPassForVerify: false',
      'requireRulesPassForDone: true',
      'requireSpecCoverageForVerify: false',
      'requireSpecCoverageForDone: true',
      'allowWarnOnDone:',
      'rules: false',
      'coverage: false',
      'openspecStatus: true',
      'utilities:',
      'graphify:',
      'enabled: false',
      'uv_check: uv --version',
      'install: uv tool install graphifyy',
      'activate: graphify install',
      'report_command: graphify .'
    ]) {
      assert.match(config, new RegExp(line), `OpenSpec config should include ${line}`);
    }
    assert.equal(await pathExists(rootDir, 'openspec/config.yaml'), true);
    assert.equal(await pathExists(rootDir, 'openspec/specs'), true);
    assert.equal(await pathExists(rootDir, 'openspec/changes'), true);
    assert.equal(await pathExists(rootDir, '.ai-factory/state'), true);
    assert.equal(await pathExists(rootDir, '.ai-factory/qa'), true);
    assert.equal(await pathExists(rootDir, '.ai-factory/rules/generated'), true);
    assert.equal(await pathExists(rootDir, '.codex/skills/openspec'), false);
    assert.equal(await pathExists(rootDir, '.ai-factory/state/mode-switches/2026-04-29T00-00-00-000Z-openspec.md'), true);
  });

  it('suggests legacy migration when switching to OpenSpec with legacy plans', async () => {
    const rootDir = await createTempRoot();
    await writeFixture(rootDir, '.ai-factory/plans/add-oauth.md', '# Add OAuth\n');

    const result = await switchToOpenSpecMode({
      rootDir,
      detectOpenSpec: async () => missingCliDetection(),
      timestamp: '2026-04-29T00-00-00-000Z'
    });

    assert.equal(result.ok, true);
    assert.equal(result.migration.skipped, true);
    assert.deepEqual(result.migration.commands, [
      'ai-factory aifhub-migrate-legacy-plans --all --dry-run',
      'ai-factory aifhub-migrate-legacy-plans --all'
    ]);
    assert.equal(await pathExists(rootDir, 'openspec/changes/add-oauth/proposal.md'), false);
  });

  it('captures a custom pre-switch legacy root for later status and sync without scanning decoys', async () => {
    const rootDir = await createTempRoot();
    await writeFixture(rootDir, '.ai-factory/config.yaml', [
      'aifhub:',
      '  artifactProtocol: ai-factory',
      'paths:',
      '  plans: custom/legacy-plans',
      '  specs: .ai-factory/specs',
      '  rules: .ai-factory/rules',
      ''
    ].join('\n'));
    await writeFixture(rootDir, 'custom/legacy-plans/custom-plan.md', '# Custom plan\n');
    await writeFixture(rootDir, '.ai-factory/plans/default-decoy.md', '# Default decoy\n');
    await writeFixture(rootDir, 'openspec/changes/canonical-decoy/proposal.md', '# Canonical decoy\n');

    const switched = await switchToOpenSpecMode({
      rootDir,
      detectOpenSpec: async () => missingCliDetection(),
      timestamp: '2026-08-14T00-00-00-000Z'
    });

    assert.equal(switched.ok, true);
    assert.equal(switched.legacyPlanSourceRoot, 'custom/legacy-plans');
    assert.deepEqual(switched.legacy.plans.map((plan) => plan.id), ['custom-plan']);
    assert.equal(switched.legacyPlanSourceState.persisted, true);
    assert.deepEqual(await readJsonFixture(rootDir, '.ai-factory/state/legacy-plan-source.json'), {
      schema_version: 1,
      kind: 'aifhub-legacy-plan-source',
      legacyPlanSourceRoot: 'custom/legacy-plans',
      reason: 'migration-declined',
      recorded_at: '2026-08-14T00-00-00-000Z'
    });

    const status = await getModeStatus({
      rootDir,
      detectOpenSpec: async () => missingCliDetection(),
      getCurrentBranch: async () => 'main'
    });
    assert.equal(status.mode, 'openspec');
    assert.equal(status.legacyPlanSourceRoot, 'custom/legacy-plans');
    assert.equal(status.legacyPlanSource.source, 'recorded');
    assert.deepEqual(status.legacyPlans.map((plan) => plan.id), ['custom-plan']);

    const sync = await syncOpenSpecArtifacts({
      rootDir,
      all: true,
      detectOpenSpec: async () => missingCliDetection(),
      timestamp: '2026-08-14T00-00-01-000Z'
    });
    assert.equal(sync.legacy.legacyPlanSourceRoot, 'custom/legacy-plans');
    assert.deepEqual(sync.legacy.plans.map((plan) => plan.id), ['custom-plan']);
    assert.equal(await pathExists(rootDir, 'openspec/changes/custom-plan/proposal.md'), false);
    assert.equal(await pathExists(rootDir, '.ai-factory/plans/default-decoy.md'), true);
    assert.equal(await pathExists(rootDir, 'openspec/changes/canonical-decoy/proposal.md'), true);
  });

  it('gives an explicit legacy root precedence over recorded and default roots', async () => {
    const rootDir = await createTempRoot();
    await writeFixture(rootDir, '.ai-factory/config.yaml', [
      'aifhub:',
      '  artifactProtocol: openspec',
      'paths:',
      '  plans: openspec/changes',
      ''
    ].join('\n'));
    await writeFixture(rootDir, '.ai-factory/state/legacy-plan-source.json', `${JSON.stringify({
      schema_version: 1,
      kind: 'aifhub-legacy-plan-source',
      legacyPlanSourceRoot: 'recorded/plans',
      reason: 'migration-declined',
      recorded_at: '2026-08-14T00:00:00.000Z'
    }, null, 2)}\n`);
    await writeFixture(rootDir, 'recorded/plans/recorded.md', '# Recorded\n');
    await writeFixture(rootDir, 'explicit/plans/explicit.md', '# Explicit\n');
    await writeFixture(rootDir, '.ai-factory/plans/default-decoy.md', '# Default\n');
    await writeFixture(rootDir, 'openspec/changes/canonical-decoy/proposal.md', '# Canonical\n');

    const status = await getModeStatus({
      rootDir,
      legacyPlanSourceRoot: 'explicit/plans',
      detectOpenSpec: async () => missingCliDetection(),
      getCurrentBranch: async () => 'main'
    });
    assert.equal(status.legacyPlanSource.source, 'explicit');
    assert.deepEqual(status.legacyPlans.map((plan) => plan.id), ['explicit']);

    const sync = await syncOpenSpecArtifacts({
      rootDir,
      legacyPlanSourceRoot: 'explicit/plans',
      all: true,
      detectOpenSpec: async () => missingCliDetection(),
      timestamp: '2026-08-14T00-00-02-000Z'
    });
    assert.deepEqual(sync.legacy.plans.map((plan) => plan.id), ['explicit']);
    assert.equal(await pathExists(rootDir, 'openspec/changes/explicit/proposal.md'), false);
  });

  it('reports wouldPersist during dry-run and leaves config, state, sources, and destinations byte-identical', async () => {
    const rootDir = await createTempRoot();
    await writeFixture(rootDir, '.ai-factory/config.yaml', [
      'aifhub:',
      '  artifactProtocol: ai-factory',
      'paths:',
      '  plans: custom/legacy-plans',
      '  specs: .ai-factory/specs',
      '  rules: .ai-factory/rules',
      ''
    ].join('\n'));
    await writeFixture(rootDir, 'custom/legacy-plans/custom-plan.md', '# Custom plan\n');
    await writeFixture(rootDir, '.ai-factory/plans/default-decoy.md', '# Default decoy\n');
    const observed = [
      '.ai-factory/config.yaml',
      '.ai-factory/state/legacy-plan-source.json',
      'custom/legacy-plans/custom-plan.md',
      '.ai-factory/plans/default-decoy.md',
      'openspec/changes/custom-plan/proposal.md',
      'openspec/config.yaml'
    ];
    const before = await snapshotSelectedPaths(rootDir, observed);

    const result = await switchToOpenSpecMode({
      rootDir,
      dryRun: true,
      detectOpenSpec: async () => missingCliDetection(),
      timestamp: '2026-08-14T00-00-03-000Z'
    });

    assert.equal(result.ok, true);
    assert.equal(result.legacyPlanSourceState.persisted, false);
    assert.equal(result.legacyPlanSourceState.wouldPersist, 'custom/legacy-plans');
    assert.deepEqual(await snapshotSelectedPaths(rootDir, observed), before);
  });

  it('preserves existing utility settings while adding Graphify defaults', async () => {
    const rootDir = await createTempRoot();
    await writeFixture(rootDir, '.ai-factory/config.yaml', [
      'aifhub:',
      '  artifactProtocol: ai-factory',
      'paths:',
      '  plans: .ai-factory/plans',
      '  specs: .ai-factory/specs',
      '  rules: .ai-factory/rules',
      'utilities:',
      '  custom_tool:',
      '    enabled: true',
      ''
    ].join('\n'));

    const result = await switchToOpenSpecMode({
      rootDir,
      detectOpenSpec: async () => missingCliDetection(),
      timestamp: '2026-04-29T00-00-00-000Z'
    });

    assert.equal(result.ok, true);
    const config = await readFixture(rootDir, '.ai-factory/config.yaml');
    assert.match(config, /^  custom_tool:\s*$/m);
    assert.match(config, /^    enabled: true\s*$/m);
    assert.match(config, /^  graphify:\s*$/m);
    assert.match(config, /^    enabled: false\s*$/m);
    assert.match(config, /^    uv_check: uv --version\s*$/m);
    assert.match(config, /^    install: uv tool install graphifyy\s*$/m);
    assert.match(config, /^    activate: graphify install\s*$/m);
    assert.match(config, /^    report_command: graphify \.\s*$/m);
  });

  it('does not duplicate existing scalar or commented Graphify utility settings', async () => {
    for (const graphifyLine of [
      '  graphify: false',
      '  graphify: # managed manually'
    ]) {
      const rootDir = await createTempRoot();
      await writeFixture(rootDir, '.ai-factory/config.yaml', [
        'aifhub:',
        '  artifactProtocol: ai-factory',
        'paths:',
        '  plans: .ai-factory/plans',
        '  specs: .ai-factory/specs',
        '  rules: .ai-factory/rules',
        'utilities:',
        graphifyLine,
        ''
      ].join('\n'));

      const result = await switchToOpenSpecMode({
        rootDir,
        detectOpenSpec: async () => missingCliDetection(),
        timestamp: '2026-04-29T00-00-00-000Z'
      });

      assert.equal(result.ok, true);
      const config = await readFixture(rootDir, '.ai-factory/config.yaml');
      assert.equal((config.match(/^  graphify:/gm) ?? []).length, 1);
      assert.match(config, new RegExp(graphifyLine.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.doesNotMatch(config, /^    install: uv tool install graphifyy\s*$/m);
    }
  });

  it('preserves scalar utilities settings instead of appending an invalid child block', async () => {
    for (const utilitiesLine of [
      'utilities: false',
      'utilities: disabled # managed manually'
    ]) {
      const rootDir = await createTempRoot();
      await writeFixture(rootDir, '.ai-factory/config.yaml', [
        'aifhub:',
        '  artifactProtocol: ai-factory',
        'paths:',
        '  plans: .ai-factory/plans',
        '  specs: .ai-factory/specs',
        '  rules: .ai-factory/rules',
        utilitiesLine,
        ''
      ].join('\n'));

      const result = await switchToOpenSpecMode({
        rootDir,
        detectOpenSpec: async () => missingCliDetection(),
        timestamp: '2026-04-29T00-00-00-000Z'
      });

      assert.equal(result.ok, true);
      const config = await readFixture(rootDir, '.ai-factory/config.yaml');
      assert.match(config, new RegExp(`^${utilitiesLine.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
      assert.doesNotMatch(config, /^  graphify:\s*$/m);
      assert.doesNotMatch(config, /^    install: uv tool install graphifyy\s*$/m);
    }
  });

  it('switches to AI Factory mode without deleting OpenSpec artifacts', async () => {
    const rootDir = await createTempRoot();
    await writeFixture(rootDir, 'openspec/changes/add-oauth/proposal.md', '# Proposal\n');

    const result = await switchToAiFactoryMode({
      rootDir,
      timestamp: '2026-04-29T00-00-00-000Z'
    });

    assert.equal(result.ok, true);
    const config = await readFixture(rootDir, '.ai-factory/config.yaml');
    assert.match(config, /artifactProtocol: ai-factory/);
    for (const line of [
      'utilities:',
      'graphify:',
      'enabled: false',
      'uv_check: uv --version',
      'install: uv tool install graphifyy',
      'activate: graphify install',
      'report_command: graphify .'
    ]) {
      assert.match(config, new RegExp(line), `AI Factory config should include ${line}`);
    }
    assert.doesNotMatch(config, /^  openspec:\s*$/m);
    assert.doesNotMatch(config, /^  state:\s*\.ai-factory\/state\s*$/m);
    assert.doesNotMatch(config, /^  qa:\s*\.ai-factory\/qa\s*$/m);
    assert.doesNotMatch(config, /^  generated_rules:\s*\.ai-factory\/rules\/generated\s*$/m);
    assert.equal(await pathExists(rootDir, '.ai-factory/plans'), true);
    assert.equal(await pathExists(rootDir, '.ai-factory/specs'), true);
    assert.equal(await pathExists(rootDir, '.ai-factory/rules'), true);
    assert.equal(await pathExists(rootDir, 'openspec/changes/add-oauth/proposal.md'), true);
  });
});

describe('artifact sync and export', () => {
  it('syncs generated rules from OpenSpec specs', async () => {
    const rootDir = await createTempRoot();
    await writeFixture(rootDir, '.ai-factory/config.yaml', [
      'aifhub:',
      '  artifactProtocol: openspec',
      'paths:',
      '  plans: openspec/changes',
      '  specs: openspec/specs',
      '  state: .ai-factory/state',
      '  qa: .ai-factory/qa',
      '  generated_rules: .ai-factory/rules/generated',
      ''
    ].join('\n'));
    await writeFixture(rootDir, 'openspec/config.yaml', 'project: test\n');
    await writeFixture(rootDir, 'openspec/changes/add-mfa/proposal.md', '# Proposal\n');
    await writeFixture(rootDir, 'openspec/changes/add-mfa/specs/auth/spec.md', [
      '# Auth',
      '',
      '## ADDED Requirements',
      '',
      '### Requirement: Require MFA',
      '',
      'The system MUST require MFA for administrators.',
      ''
    ].join('\n'));

    const result = await syncOpenSpecArtifacts({
      rootDir,
      changeId: 'add-mfa',
      detectOpenSpec: async () => missingCliDetection(),
      timestamp: '2026-04-29T00-00-00-000Z'
    });

    assert.equal(result.ok, true);
    assert.deepEqual(result.generatedRules.files.map((file) => file.kind), ['base', 'change', 'merged', 'trace', 'index']);
    assert.match(await readFixture(rootDir, '.ai-factory/rules/generated/openspec-base.md'), /No base OpenSpec requirements found/);
    assert.match(await readFixture(rootDir, '.ai-factory/rules/generated/openspec-change-add-mfa.md'), /Requirement: Require MFA/);
    assert.match(await readFixture(rootDir, '.ai-factory/rules/generated/openspec-merged-add-mfa.md'), /Requirement: Require MFA/);
    const trace = await readJsonFixture(rootDir, '.ai-factory/rules/generated/openspec-rules-trace-add-mfa.json');
    const index = await readJsonFixture(rootDir, '.ai-factory/rules/generated/index.json');
    assert.equal(trace.schema_version, 1);
    assert.equal(trace.change_id, 'add-mfa');
    assert.deepEqual(trace.inputs.map((input) => input.kind), ['delta-spec']);
    assert.equal(index.base.markdown, '.ai-factory/rules/generated/openspec-base.md');
    assert.deepEqual(index.changes.map((entry) => entry.change_id), ['add-mfa']);
    assert.equal(index.changes[0].trace, '.ai-factory/rules/generated/openspec-rules-trace-add-mfa.json');

    const status = await getModeStatus({
      rootDir,
      detectOpenSpec: async () => missingCliDetection(),
      getCurrentBranch: async () => 'feat/add-mfa'
    });
    assert.equal(status.generatedRules.state, 'ok');
    assert.equal(result.validation.skipped, true);
    assert.equal(result.validation.reason, 'missing-cli');
    assert.equal(result.generatedRules.openspecCli.command, 'openspec');
    assert.equal(result.generatedRules.openspecCli.commandSource, 'path');
    assert.equal(result.validation.detection.command, 'openspec');
    assert.equal(result.validation.detection.commandSource, 'path');
    const report = await readFixture(rootDir, '.ai-factory/state/mode-switches/2026-04-29T00-00-00-000Z-sync-openspec.md');
    assert.match(report, /OpenSpec command: openspec/);
    assert.match(report, /OpenSpec command source: path/);
    assert.equal(await pathExists(rootDir, '.ai-factory/state/mode-switches/2026-04-29T00-00-00-000Z-sync-openspec.md'), true);
  });

  it('propagates one explicit OpenSpec command through compiler detection, show, JSON, and human report', async () => {
    const rootDir = await createTempRoot();
    const detectionCalls = [];
    const showCalls = [];
    const command = 'custom-openspec';
    await writeFixture(rootDir, '.ai-factory/config.yaml', [
      'aifhub:',
      '  artifactProtocol: openspec',
      '  openspec:',
      '    validateOnSync: false',
      'paths:',
      '  plans: openspec/changes',
      '  specs: openspec/specs',
      '  state: .ai-factory/state',
      '  qa: .ai-factory/qa',
      '  generated_rules: .ai-factory/rules/generated',
      ''
    ].join('\n'));
    await writeFixture(rootDir, 'openspec/config.yaml', 'project: test\n');
    await writeFixture(rootDir, 'openspec/changes/explicit-cli/proposal.md', '# Proposal\n');
    await writeFixture(rootDir, 'openspec/changes/explicit-cli/specs/auth/spec.md', [
      '# Auth',
      '',
      '## ADDED Requirements',
      '',
      '### Requirement: Explicit CLI',
      '',
      'The system MUST preserve explicit CLI selection.',
      ''
    ].join('\n'));

    const result = await syncOpenSpecArtifacts({
      rootDir,
      changeId: 'explicit-cli',
      command,
      detectOpenSpec: async (options) => {
        detectionCalls.push(options);
        return availableCliDetection({ command, commandSource: 'explicit' });
      },
      showOpenSpecItem: async (itemName, options) => {
        showCalls.push({ itemName, options });
        return {
          ok: true,
          json: {
            requirements: [{
              title: 'Explicit CLI',
              description: 'The system MUST preserve explicit CLI selection.',
              scenarios: []
            }]
          }
        };
      },
      timestamp: '2026-04-29T00-10-00-000Z'
    });

    assert.equal(result.ok, true);
    assert.equal(detectionCalls.length, 1);
    assert.equal(detectionCalls[0].command, command);
    assert.equal(showCalls.length, 1);
    assert.equal(showCalls[0].options.command, command);
    assert.deepEqual(result.generatedRules.openspecCli, {
      available: true,
      canValidate: true,
      canArchive: true,
      version: '1.3.1',
      command,
      commandSource: 'explicit',
      reason: null
    });
    const report = await readFixture(rootDir, '.ai-factory/state/mode-switches/2026-04-29T00-10-00-000Z-sync-openspec.md');
    assert.match(report, /OpenSpec command: custom-openspec/);
    assert.match(report, /OpenSpec command source: explicit/);
  });

  it('syncs generated rules for all active OpenSpec changes', async () => {
    const rootDir = await createTempRoot();
    await writeFixture(rootDir, '.ai-factory/config.yaml', [
      'aifhub:',
      '  artifactProtocol: openspec',
      'paths:',
      '  plans: openspec/changes',
      '  specs: openspec/specs',
      '  state: .ai-factory/state',
      '  qa: .ai-factory/qa',
      '  generated_rules: .ai-factory/rules/generated',
      ''
    ].join('\n'));
    await writeFixture(rootDir, 'openspec/config.yaml', 'project: test\n');
    await writeFixture(rootDir, 'openspec/specs/auth/spec.md', [
      '# Auth',
      '',
      '## Requirements',
      '',
      '### Requirement: Base Auth',
      '',
      'The system MUST preserve accepted authentication behavior.',
      ''
    ].join('\n'));
    await writeFixture(rootDir, 'openspec/changes/add-mfa/proposal.md', '# Proposal\n');
    await writeFixture(rootDir, 'openspec/changes/add-mfa/specs/auth/spec.md', [
      '# Auth',
      '',
      '## ADDED Requirements',
      '',
      '### Requirement: Require MFA',
      '',
      'The system MUST require MFA for administrators.',
      ''
    ].join('\n'));
    await writeFixture(rootDir, 'openspec/changes/add-passkeys/proposal.md', '# Proposal\n');
    await writeFixture(rootDir, 'openspec/changes/add-passkeys/specs/auth/spec.md', [
      '# Auth',
      '',
      '## ADDED Requirements',
      '',
      '### Requirement: Support Passkeys',
      '',
      'The system MUST support passkey sign-in.',
      ''
    ].join('\n'));

    const result = await syncOpenSpecArtifacts({
      rootDir,
      all: true,
      detectOpenSpec: async () => missingCliDetection(),
      timestamp: '2026-04-29T01-00-00-000Z'
    });

    assert.equal(result.ok, true);
    assert.deepEqual(result.changes.changeIds, ['add-mfa', 'add-passkeys']);
    assert.match(await readFixture(rootDir, '.ai-factory/rules/generated/openspec-base.md'), /Requirement: Base Auth/);
    assert.match(await readFixture(rootDir, '.ai-factory/rules/generated/openspec-change-add-mfa.md'), /Requirement: Require MFA/);
    assert.match(await readFixture(rootDir, '.ai-factory/rules/generated/openspec-merged-add-passkeys.md'), /Requirement: Support Passkeys/);
    const index = await readJsonFixture(rootDir, '.ai-factory/rules/generated/index.json');
    assert.deepEqual(index.changes.map((entry) => entry.change_id), ['add-mfa', 'add-passkeys']);
  });

  it('skips sync validation for active changes without delta specs', async () => {
    const rootDir = await createTempRoot();
    const validated = [];
    await writeFixture(rootDir, '.ai-factory/config.yaml', [
      'aifhub:',
      '  artifactProtocol: openspec',
      'paths:',
      '  plans: openspec/changes',
      '  specs: openspec/specs',
      '  state: .ai-factory/state',
      '  qa: .ai-factory/qa',
      '  generated_rules: .ai-factory/rules/generated',
      ''
    ].join('\n'));
    await writeFixture(rootDir, 'openspec/config.yaml', 'project: test\n');
    await writeFixture(rootDir, 'openspec/changes/docs-only/proposal.md', '# Proposal\n');
    await writeFixture(rootDir, 'openspec/changes/add-mfa/proposal.md', '# Proposal\n');
    await writeFixture(rootDir, 'openspec/changes/add-mfa/specs/auth/spec.md', [
      '# Auth',
      '',
      '## ADDED Requirements',
      '',
      '### Requirement: Require MFA',
      '',
      'The system MUST require MFA for administrators.',
      '',
      '#### Scenario: administrator signs in',
      '',
      '- GIVEN an administrator account',
      '- WHEN the administrator signs in',
      '- THEN an MFA challenge is required',
      ''
    ].join('\n'));

    const result = await syncOpenSpecArtifacts({
      rootDir,
      all: true,
      detectOpenSpec: async () => availableCliDetection(),
      validateOpenSpecChange: async (changeId) => {
        validated.push(changeId);
        return { ok: true, stdout: '{"valid":true}', stderr: '', json: { valid: true } };
      },
      getOpenSpecStatus: async (changeId) => ({
        ok: true,
        stdout: JSON.stringify({ changeId }),
        stderr: '',
        json: { changeId }
      }),
      timestamp: '2026-04-29T01-30-00-000Z'
    });

    assert.equal(result.ok, true);
    assert.deepEqual(validated, ['add-mfa']);
    assert.equal(result.validation.results.length, 1);
    assert.equal(result.validation.skippedChanges.length, 1);
    assert.equal(result.validation.skippedChanges[0].changeId, 'docs-only');
    assert.ok(result.validation.warnings.some((warning) => warning.code === 'no-delta-specs'));
  });

  it('validates native skip_specs changes during all-change sync', async () => {
    const rootDir = await createTempRoot();
    const validated = [];
    await writeFixture(rootDir, '.ai-factory/config.yaml', [
      'aifhub:',
      '  artifactProtocol: openspec',
      '  openspec:',
      '    compileRulesOnSync: false',
      'paths:',
      '  plans: openspec/changes',
      '  specs: openspec/specs',
      '  state: .ai-factory/state',
      '  qa: .ai-factory/qa',
      '  generated_rules: .ai-factory/rules/generated',
      ''
    ].join('\n'));
    await writeFixture(rootDir, 'openspec/config.yaml', 'project: test\n');
    await writeFixture(rootDir, 'openspec/changes/docs-only/proposal.md', '# Proposal\n');
    await writeFixture(rootDir, 'openspec/changes/docs-only/.openspec.yaml', [
      'schema: spec-driven',
      'created: 2026-08-09',
      'skip_specs: true',
      ''
    ].join('\n'));
    await writeFixture(rootDir, 'openspec/changes/nested-change/proposal.md', '# Proposal\n');
    await writeFixture(rootDir, 'openspec/changes/nested-change/specs/area/capability/spec.md', [
      '## ADDED Requirements',
      '',
      '### Requirement: Nested capability',
      '',
      'The system SHALL validate nested capability paths.',
      '',
      '#### Scenario: nested path is present',
      '',
      '- **WHEN** the nested delta is validated',
      '- **THEN** validation succeeds',
      ''
    ].join('\n'));

    const result = await syncOpenSpecArtifacts({
      rootDir,
      all: true,
      detectOpenSpec: async () => availableCliDetection(),
      validateOpenSpecChange: async (changeId) => {
        validated.push(changeId);
        return { ok: true, stdout: '{"valid":true}', stderr: '', json: { valid: true } };
      },
      getOpenSpecStatus: async (changeId) => ({
        ok: true,
        stdout: JSON.stringify({ changeId }),
        stderr: '',
        json: { changeId }
      }),
      timestamp: '2026-08-09T00-00-00-000Z'
    });

    assert.equal(result.ok, true);
    assert.deepEqual(validated, ['docs-only', 'nested-change']);
    assert.equal(result.validation.skippedChanges.length, 0);
    assert.ok(!result.validation.warnings.some((warning) => warning.code === 'no-delta-specs'));
  });

  it('preserves full OpenSpec 1.12 INFO reports during sync without failing valid changes', async () => {
    const rootDir = await createTempRoot();
    await writeFixture(rootDir, '.ai-factory/config.yaml', 'aifhub:\n  artifactProtocol: openspec\n  openspec:\n    compileRulesOnSync: false\n');
    await writeFixture(rootDir, 'openspec/config.yaml', 'schema: spec-driven\n');
    await writeFixture(rootDir, 'openspec/changes/info-change/proposal.md', '# Proposal\n');
    await writeFixture(rootDir, 'openspec/changes/info-change/specs/widgets/spec.md', '## MODIFIED Requirements\n### Requirement: Missing\nThe system SHALL handle requests.\n\n#### Scenario: request\n- **WHEN** a request arrives\n- **THEN** it is handled\n');
    const payload = {
      items: [{ id: 'info-change', type: 'change', valid: true, issues: [{
        level: 'INFO', path: 'widgets/spec.md', message: 'Archive would refuse this delta: missing target.'
      }] }], summary: { totals: { items: 1, passed: 1, failed: 0 } }, version: '1.0'
    };
    const result = await syncOpenSpecArtifacts({
      rootDir, all: true,
      detectOpenSpec: async () => availableCliDetection({ version: '1.12.0' }),
      validateOpenSpecChange: async () => ({ ok: true, exitCode: 0, stdout: JSON.stringify(payload), stderr: '', json: payload }),
      getOpenSpecStatus: async () => ({ ok: true, stdout: '{}', stderr: '', json: {} })
    });
    assert.equal(result.ok, true);
    assert.equal(result.validation.results.length, 1);
    assert.deepEqual(result.validation.results[0].validation.json, payload);
    assert.deepEqual(JSON.parse(result.validation.results[0].validation.stdout), payload);
    assert.deepEqual(result.validation.errors, []);
  });

  it('treats numeric-leading OpenSpec status rejection as non-blocking during sync', async () => {
    const rootDir = await createTempRoot();
    const changeId = '81-command-wrappers';
    await writeFixture(rootDir, '.ai-factory/config.yaml', [
      'aifhub:',
      '  artifactProtocol: openspec',
      '  openspec:',
      '    compileRulesOnSync: false',
      'paths:',
      '  plans: openspec/changes',
      '  specs: openspec/specs',
      '  state: .ai-factory/state',
      '  qa: .ai-factory/qa',
      '  generated_rules: .ai-factory/rules/generated',
      ''
    ].join('\n'));
    await writeFixture(rootDir, 'openspec/config.yaml', 'project: test\n');
    await writeFixture(rootDir, `openspec/changes/${changeId}/proposal.md`, '# Proposal\n');
    await writeFixture(rootDir, `openspec/changes/${changeId}/specs/commands/spec.md`, [
      '# Commands',
      '',
      '## ADDED Requirements',
      '',
      '### Requirement: Command Wrappers',
      '',
      'The system MUST expose command wrappers.',
      '',
      '#### Scenario: wrapper is invoked',
      '',
      '- GIVEN an installed helper command',
      '- WHEN the wrapper runs',
      '- THEN it delegates to the helper',
      ''
    ].join('\n'));

    const result = await syncOpenSpecArtifacts({
      rootDir,
      changeId,
      detectOpenSpec: async () => availableCliDetection(),
      validateOpenSpecChange: async () => ({
        ok: true,
        exitCode: 0,
        stdout: '{"valid":true}',
        stderr: '',
        json: { valid: true },
        error: null
      }),
      getOpenSpecStatus: async (id) => ({
        ok: false,
        exitCode: 1,
        command: 'openspec',
        args: ['status', '--change', id, '--json', '--no-color'],
        stdout: '\n',
        stderr: `Error: Invalid change name '${id}': Change name must start with a letter\n`,
        json: null,
        jsonParseError: null,
        error: {
          code: 'non-zero-exit',
          message: 'OpenSpec command failed with exit code 1.'
        }
      }),
      timestamp: '2026-05-17T00-00-00-000Z'
    });

    assert.equal(result.ok, true);
    assert.equal(result.validation.ok, true);
    assert.equal(result.validation.results[0].ok, true);
    assert.equal(result.validation.results[0].status.ok, false);
    assert.equal(result.validation.results[0].statusWarning.code, 'openspec-status-unsupported-change-id');
    assert.deepEqual(result.validation.errors, []);
    assert.ok(result.validation.warnings.some((warning) => warning.code === 'openspec-status-unsupported-change-id'));
    assert.ok(result.warnings.some((warning) => warning.code === 'openspec-status-unsupported-change-id'));
  });

  it('does not skip no-delta validation for targeted sync', async () => {
    const rootDir = await createTempRoot();
    const validated = [];
    await writeFixture(rootDir, '.ai-factory/config.yaml', [
      'aifhub:',
      '  artifactProtocol: openspec',
      'paths:',
      '  plans: openspec/changes',
      '  specs: openspec/specs',
      '  state: .ai-factory/state',
      '  qa: .ai-factory/qa',
      '  generated_rules: .ai-factory/rules/generated',
      ''
    ].join('\n'));
    await writeFixture(rootDir, 'openspec/config.yaml', 'project: test\n');
    await writeFixture(rootDir, 'openspec/changes/docs-only/proposal.md', '# Proposal\n');

    const result = await syncOpenSpecArtifacts({
      rootDir,
      changeId: 'docs-only',
      detectOpenSpec: async () => availableCliDetection(),
      validateOpenSpecChange: async (changeId) => {
        validated.push(changeId);
        return {
          ok: false,
          stdout: '',
          stderr: 'Change must have at least one delta.',
          json: null,
          errors: [
            {
              code: 'openspec-validation-failed',
              message: 'Change must have at least one delta.'
            }
          ]
        };
      },
      getOpenSpecStatus: async (changeId) => ({
        ok: true,
        stdout: JSON.stringify({ changeId }),
        stderr: '',
        json: { changeId }
      }),
      timestamp: '2026-04-29T01-45-00-000Z'
    });

    assert.equal(result.ok, false);
    assert.deepEqual(validated, ['docs-only']);
    assert.equal(result.validation.skipped, false);
    assert.deepEqual(result.validation.skippedChanges, []);
    assert.equal(result.validation.results.length, 1);
    assert.equal(result.validation.results[0].changeId, 'docs-only');
    assert.ok(result.validation.errors.some((error) => error.code === 'openspec-validation-failed'));
    assert.ok(!result.validation.warnings.some((warning) => warning.code === 'no-delta-specs'));
  });

  it('refreshes base generated rules after archive when no active changes exist', async () => {
    const rootDir = await createTempRoot();
    await writeFixture(rootDir, '.ai-factory/config.yaml', [
      'aifhub:',
      '  artifactProtocol: openspec',
      'paths:',
      '  plans: openspec/changes',
      '  specs: openspec/specs',
      '  state: .ai-factory/state',
      '  qa: .ai-factory/qa',
      '  generated_rules: .ai-factory/rules/generated',
      ''
    ].join('\n'));
    await writeFixture(rootDir, 'openspec/config.yaml', 'project: test\n');
    await writeFixture(rootDir, 'openspec/specs/auth/spec.md', [
      '# Auth',
      '',
      '## Requirements',
      '',
      '### Requirement: Accepted Auth',
      '',
      'The system MUST support accepted authentication.',
      ''
    ].join('\n'));

    const result = await syncOpenSpecArtifacts({
      rootDir,
      detectOpenSpec: async () => missingCliDetection(),
      getCurrentBranch: async () => 'main',
      timestamp: '2026-04-29T02-00-00-000Z'
    });

    assert.equal(result.ok, true);
    assert.equal(result.changes.source, 'none');
    assert.deepEqual(result.changes.changeIds, []);
    assert.equal(result.generatedRules.baseOnly, true);
    assert.equal(result.generatedRules.changeSpecificSkipped, true);
    assert.deepEqual(result.generatedRules.files.map((file) => file.kind), ['base', 'index']);
    assert.equal(result.validation.skipped, true);
    assert.equal(result.validation.reason, 'no-selected-changes');
    assert.match(await readFixture(rootDir, '.ai-factory/rules/generated/openspec-base.md'), /Requirement: Accepted Auth/);
    const index = await readJsonFixture(rootDir, '.ai-factory/rules/generated/index.json');
    assert.equal(index.base.markdown, '.ai-factory/rules/generated/openspec-base.md');
    assert.deepEqual(index.changes, []);
    assert.equal(await pathExists(rootDir, '.ai-factory/rules/generated/openspec-change-accepted-auth.md'), false);
    assert.equal(await pathExists(rootDir, 'openspec/changes/.ai-factory'), false);
    assert.equal(await pathExists(rootDir, '.ai-factory/state/mode-switches/2026-04-29T02-00-00-000Z-sync-openspec.md'), true);
  });

  it('falls back to bounded base-only sync when active change selection is ambiguous', async () => {
    const rootDir = await createTempRoot();
    await writeFixture(rootDir, '.ai-factory/config.yaml', [
      'aifhub:',
      '  artifactProtocol: openspec',
      'paths:',
      '  plans: openspec/changes',
      '  specs: openspec/specs',
      '  state: .ai-factory/state',
      '  qa: .ai-factory/qa',
      '  generated_rules: .ai-factory/rules/generated',
      ''
    ].join('\n'));
    await writeFixture(rootDir, 'openspec/config.yaml', 'project: test\n');
    await writeFixture(rootDir, 'openspec/specs/auth/spec.md', [
      '# Auth',
      '',
      '## Requirements',
      '',
      '### Requirement: Accepted Auth',
      '',
      'The system MUST support accepted authentication.',
      ''
    ].join('\n'));
    await writeFixture(rootDir, 'openspec/changes/unrelated-alpha/proposal.md', '# Proposal\n');
    await writeFixture(rootDir, 'openspec/changes/unrelated-beta/proposal.md', '# Proposal\n');
    await writeFixture(rootDir, '.ai-factory/rules/generated/index.json', `${JSON.stringify({
      schema_version: 1,
      generated_at: '2026-04-29T01:00:00.000Z',
      base: null,
      changes: ['unrelated-alpha', 'unrelated-beta'].map((changeId) => ({
        change_id: changeId,
        generated_at: '2026-04-29T01:00:00.000Z',
        trace: `.ai-factory/rules/generated/openspec-rules-trace-${changeId}.json`,
        markdown: {
          base: '.ai-factory/rules/generated/openspec-base.md',
          change: `.ai-factory/rules/generated/openspec-change-${changeId}.md`,
          merged: `.ai-factory/rules/generated/openspec-merged-${changeId}.md`
        }
      }))
    }, null, 2)}\n`);

    const result = await syncOpenSpecArtifacts({
      rootDir,
      detectOpenSpec: async () => missingCliDetection(),
      getCurrentBranch: async () => 'main',
      timestamp: '2026-04-29T02-30-00-000Z'
    });

    assert.equal(result.ok, true);
    assert.equal(result.changes.source, 'ambiguous-base-only');
    assert.deepEqual(result.changes.changeIds, []);
    assert.ok(result.changes.warnings.some((warning) => warning.code === 'ambiguous-active-change-base-only'));
    assert.equal(result.generatedRules.baseOnly, true);
    assert.equal(result.generatedRules.changeSpecificSkipped, true);
    assert.equal(result.validation.skipped, true);
    assert.equal(result.validation.reason, 'no-selected-changes');
    const index = await readJsonFixture(rootDir, '.ai-factory/rules/generated/index.json');
    assert.deepEqual(index.changes.map((entry) => entry.change_id), ['unrelated-alpha', 'unrelated-beta']);
  });

  it('respects compileRulesOnSync and validateOnSync config toggles', async () => {
    const rootDir = await createTempRoot();
    let validateCalls = 0;
    await writeFixture(rootDir, '.ai-factory/config.yaml', [
      'aifhub:',
      '  artifactProtocol: openspec',
      '  openspec:',
      '    compileRulesOnSync: false',
      '    validateOnSync: false',
      'paths:',
      '  plans: openspec/changes',
      '  specs: openspec/specs',
      '  state: .ai-factory/state',
      '  qa: .ai-factory/qa',
      '  generated_rules: .ai-factory/rules/generated',
      ''
    ].join('\n'));
    await writeFixture(rootDir, 'openspec/config.yaml', 'project: test\n');
    await writeFixture(rootDir, 'openspec/changes/add-mfa/proposal.md', '# Proposal\n');
    await writeFixture(rootDir, 'openspec/changes/add-mfa/specs/auth/spec.md', [
      '# Auth',
      '',
      '## ADDED Requirements',
      '',
      '### Requirement: Require MFA',
      '',
      'The system MUST require MFA for administrators.',
      ''
    ].join('\n'));

    const result = await syncOpenSpecArtifacts({
      rootDir,
      changeId: 'add-mfa',
      detectOpenSpec: async () => availableCliDetection(),
      validateOpenSpecChange: async () => {
        validateCalls += 1;
        return { ok: true, stdout: '{"valid":true}', stderr: '', json: { valid: true } };
      },
      timestamp: '2026-04-29T00-00-00-000Z'
    });

    assert.equal(result.ok, true);
    assert.equal(result.generatedRules.skipped, true);
    assert.equal(result.validation.skipped, true);
    assert.equal(result.validation.reason, 'validateOnSync-disabled');
    assert.equal(validateCalls, 0);
    assert.equal(await pathExists(rootDir, '.ai-factory/rules/generated/openspec-change-add-mfa.md'), false);
  });

  it('dry-run writes nothing', async () => {
    const rootDir = await createTempRoot();

    const result = await switchToOpenSpecMode({
      rootDir,
      dryRun: true,
      detectOpenSpec: async () => missingCliDetection(),
      timestamp: '2026-04-29T00-00-00-000Z'
    });

    assert.equal(result.ok, true);
    assert.equal(result.dryRun, true);
    assert.equal(await pathExists(rootDir, '.ai-factory/config.yaml'), false);
    assert.equal(await pathExists(rootDir, 'openspec/config.yaml'), false);
    assert.equal(await pathExists(rootDir, '.ai-factory/state/mode-switches/2026-04-29T00-00-00-000Z-openspec.md'), false);
  });

  it('exports OpenSpec changes to legacy compatibility artifacts', async () => {
    const rootDir = await createTempRoot();
    await writeFixture(rootDir, 'openspec/changes/add-oauth/proposal.md', '# Proposal\n\nAdd OAuth.\n');
    await writeFixture(rootDir, 'openspec/changes/add-oauth/tasks.md', '# Tasks\n\n- [ ] Implement OAuth.\n');
    await writeFixture(rootDir, 'openspec/changes/add-oauth/design.md', '# Design\n\nUse provider state.\n');
    await writeFixture(rootDir, 'openspec/changes/add-oauth/specs/auth/spec.md', '# Auth Delta\n');
    await writeFixture(rootDir, '.ai-factory/rules/generated/openspec-merged-add-oauth.md', '# Generated Rules\n');

    const result = await exportOpenSpecCompatibility({
      rootDir,
      changeId: 'add-oauth',
      yes: true
    });

    assert.equal(result.ok, true);
    assert.match(await readFixture(rootDir, '.ai-factory/plans/add-oauth.md'), /Add OAuth/);
    assert.match(await readFixture(rootDir, '.ai-factory/plans/add-oauth/task.md'), /Implement OAuth/);
    assert.match(await readFixture(rootDir, '.ai-factory/plans/add-oauth/context.md'), /openspec\/changes\/add-oauth\/specs\/auth\/spec\.md/);
    assert.match(await readFixture(rootDir, '.ai-factory/plans/add-oauth/rules.md'), /Generated Rules/);
  });

  it('blocks compatibility export collisions unless explicitly approved', async () => {
    const rootDir = await createTempRoot();
    await writeFixture(rootDir, 'openspec/changes/add-oauth/proposal.md', '# Proposal\n\nNew.\n');
    await writeFixture(rootDir, 'openspec/changes/add-oauth/tasks.md', '# Tasks\n');
    await writeFixture(rootDir, '.ai-factory/plans/add-oauth.md', '# Existing\n');

    const blocked = await exportOpenSpecCompatibility({
      rootDir,
      changeId: 'add-oauth'
    });

    assert.equal(blocked.ok, false);
    assert.equal(blocked.errors[0].code, 'target-exists');
    assert.equal((await readFixture(rootDir, '.ai-factory/plans/add-oauth.md')).trim(), '# Existing');

    const overwritten = await exportOpenSpecCompatibility({
      rootDir,
      changeId: 'add-oauth',
      yes: true
    });

    assert.equal(overwritten.ok, true);
    assert.match(await readFixture(rootDir, '.ai-factory/plans/add-oauth.md'), /New/);
  });
});

describe('generated-rules archive reconciliation', () => {
  it('targeted sync preserves active siblings and prunes archived index/files with bounded relative operations', async () => {
    const rootDir = await createTempRoot();
    await writeFixture(rootDir, '.ai-factory/config.yaml', [
      'aifhub:',
      '  artifactProtocol: openspec',
      '  openspec:',
      '    compileRulesOnSync: true',
      '    validateOnSync: false',
      'paths:',
      '  plans: openspec/changes',
      '  specs: openspec/specs',
      '  rules: .ai-factory/rules',
      '  state: .ai-factory/state',
      '  qa: .ai-factory/qa',
      '  generated_rules: .ai-factory/rules/generated',
      ''
    ].join('\n'));
    await writeFixture(rootDir, 'openspec/specs/base/spec.md', [
      '# Base',
      '',
      '## Requirements',
      '',
      '### Requirement: Keep accepted behavior',
      '',
      'The system MUST keep accepted behavior.',
      ''
    ].join('\n'));
    for (const changeId of ['change-a', 'change-b', 'archived-change']) {
      await writeFixture(rootDir, `openspec/changes/${changeId}/proposal.md`, `# ${changeId}\n`);
      await writeFixture(rootDir, `openspec/changes/${changeId}/specs/demo/spec.md`, [
        '# Delta',
        '',
        '## ADDED Requirements',
        '',
        `### Requirement: ${changeId}`,
        '',
        `The system MUST implement ${changeId}.`,
        ''
      ].join('\n'));
    }

    const initial = await syncOpenSpecArtifacts({
      rootDir,
      all: true,
      writeReport: false,
      detectOpenSpec: async () => missingCliDetection(),
      now: new Date('2026-08-22T00:00:00.000Z')
    });
    assert.equal(initial.ok, true, 'all initial generated-rules sync should succeed');
    await rm(path.join(rootDir, 'openspec', 'changes', 'archived-change'), { recursive: true, force: true });

    const targeted = await syncOpenSpecArtifacts({
      rootDir,
      changeId: 'change-a',
      writeReport: false,
      detectOpenSpec: async () => missingCliDetection(),
      now: new Date('2026-08-22T01:00:00.000Z')
    });
    const index = await readJsonFixture(rootDir, '.ai-factory/rules/generated/index.json');

    assert.equal(targeted.ok, true, 'explicit/change-a post-archive sync should succeed');
    assert.deepEqual(index.changes.map((entry) => entry.change_id), ['change-a', 'change-b'], 'explicit/change-a must preserve active sibling membership');
    assert.equal(await pathExists(rootDir, '.ai-factory/rules/generated/openspec-change-archived-change.md'), false, 'archived change overlay must be pruned');
    assert.deepEqual(targeted.generatedRules.operations.filter((item) => item.action === 'remove').map((item) => item.target), [
      '.ai-factory/rules/generated/openspec-change-archived-change.md',
      '.ai-factory/rules/generated/openspec-merged-archived-change.md',
      '.ai-factory/rules/generated/openspec-rules-trace-archived-change.json'
    ]);
    assert.equal(targeted.generatedRules.operations.every((item) => !path.isAbsolute(item.target)), true, 'public generated-rules operations must stay project-relative');
    const status = await getModeStatus({
      rootDir,
      detectOpenSpec: async () => missingCliDetection(),
      getCurrentBranch: async () => 'main'
    });
    assert.equal(status.generatedRules.state, 'ok', 'post-reconciliation full membership and hashes should be green');
  });

  it('blocks generated mutation on authoritative inventory failure while still writing a bounded failure report', async () => {
    const rootDir = await createTempRoot();
    await writeFixture(rootDir, '.ai-factory/config.yaml', [
      'aifhub:',
      '  artifactProtocol: openspec',
      '  openspec:',
      '    compileRulesOnSync: true',
      '    validateOnSync: false',
      'paths:',
      '  plans: openspec/changes',
      '  specs: openspec/specs',
      '  rules: .ai-factory/rules',
      '  state: .ai-factory/state',
      '  qa: .ai-factory/qa',
      '  generated_rules: .ai-factory/rules/generated',
      ''
    ].join('\n'));
    await writeFixture(rootDir, 'openspec/changes/change-a/proposal.md', '# change-a\n');
    await writeFixture(rootDir, '.ai-factory/rules/generated/openspec-base.md', 'sentinel base\n');
    const before = await readFixture(rootDir, '.ai-factory/rules/generated/openspec-base.md');

    const failed = await syncOpenSpecArtifacts({
      rootDir,
      all: true,
      timestamp: '2026-08-22T04-00-00-000Z',
      detectOpenSpec: async () => missingCliDetection(),
      fileOps: {
        readdir: async (targetPath, options) => {
          if (targetPath === path.join(rootDir, 'openspec', 'changes')) {
            throw Object.assign(new Error('injected inventory failure'), { code: 'EACCES' });
          }
          return readdir(targetPath, options);
        }
      }
    });

    assert.equal(failed.ok, false, 'all inventory failure must fail sync');
    assert.equal(failed.generatedRules.errors[0].code, 'active-inventory-read-failed');
    assert.equal(failed.generatedRules.operation_count, 0);
    assert.equal(await readFixture(rootDir, '.ai-factory/rules/generated/openspec-base.md'), before, 'inventory failure must not mutate generated bytes');
    assert.equal(failed.report.ok, true, 'normal bounded failure report remains allowed');
    const report = await readFixture(rootDir, failed.report.path);
    assert.match(report, /active-inventory-read-failed/, 'failure report should identify stable inventory code');
    assert.doesNotMatch(report, /injected inventory failure/, 'failure report must not dump raw injected error detail');
  });
});

describe('doctor', () => {
  it('detects ambiguous active change', async () => {
    const rootDir = await createTempRoot();
    await writeFixture(rootDir, '.ai-factory/config.yaml', [
      'aifhub:',
      '  artifactProtocol: openspec',
      '  openspec:',
      '    archiveOnDone: true',
      '    requireGeneratedRulesForDone: false',
      '    requireRulesPassForDone: false',
      '    requireSpecCoverageForDone: false',
      'paths:',
      '  plans: openspec/changes',
      '  specs: openspec/specs',
      '  state: .ai-factory/state',
      '  qa: .ai-factory/qa',
      '  generated_rules: .ai-factory/rules/generated',
      ''
    ].join('\n'));
    await writeFixture(rootDir, 'openspec/config.yaml', 'project: test\n');
    await writeFixture(rootDir, 'openspec/changes/alpha/proposal.md', '# Alpha\n');
    await writeFixture(rootDir, 'openspec/changes/beta/proposal.md', '# Beta\n');
    await mkdir(path.join(rootDir, '.ai-factory/state'), { recursive: true });
    await mkdir(path.join(rootDir, '.ai-factory/qa'), { recursive: true });
    await mkdir(path.join(rootDir, '.ai-factory/rules/generated'), { recursive: true });

    const result = await doctorAifMode({
      rootDir,
      detectOpenSpec: async () => missingCliDetection(),
      getCurrentBranch: async () => 'feat/unmatched'
    });

    assert.equal(result.ok, false);
    assert.ok(result.diagnostics.some((item) => item.code === 'ambiguous-active-change'));
    assert.ok(result.diagnostics.some((item) => item.code === 'aif-done-archive-unavailable'));
  });

  it('validates only the resolved active change', async () => {
    const rootDir = await createTempRoot();
    const validated = [];
    await writeFixture(rootDir, '.ai-factory/config.yaml', [
      'aifhub:',
      '  artifactProtocol: openspec',
      '  openspec:',
      '    archiveOnDone: true',
      '    requireGeneratedRulesForDone: false',
      '    requireRulesPassForDone: false',
      '    requireSpecCoverageForDone: false',
      'paths:',
      '  plans: openspec/changes',
      '  specs: openspec/specs',
      '  state: .ai-factory/state',
      '  qa: .ai-factory/qa',
      '  generated_rules: .ai-factory/rules/generated',
      ''
    ].join('\n'));
    await writeFixture(rootDir, 'openspec/config.yaml', 'project: test\n');
    await writeFixture(rootDir, 'openspec/changes/alpha/proposal.md', '# Alpha\n');
    await writeFixture(rootDir, 'openspec/changes/beta/proposal.md', '# Beta\n');
    await writeFixture(rootDir, '.ai-factory/state/current.yaml', 'change_id: beta\n');
    await mkdir(path.join(rootDir, 'openspec/specs'), { recursive: true });
    await mkdir(path.join(rootDir, '.ai-factory/qa'), { recursive: true });
    await mkdir(path.join(rootDir, '.ai-factory/rules/generated'), { recursive: true });

    const result = await doctorAifMode({
      rootDir,
      detectOpenSpec: async () => availableCliDetection(),
      getCurrentBranch: async () => 'feat/unmatched',
      validateOpenSpecChange: async (changeId) => {
        validated.push(changeId);
        return { ok: true, stdout: '{"valid":true}', stderr: '', json: { valid: true } };
      },
      validateOpenSpecArtifactContract: async (options) => ({
        schema_version: 1,
        validator: 'aifhub-openspec-artifact-contract',
        change_id: options.changeId,
        status: 'pass',
        blocking: false,
        checks: [],
        suggested_next: null
      }),
      getOpenSpecStatus: async () => ({
        ok: true,
        stdout: '{"ok":true}',
        stderr: '',
        json: { ok: true }
      })
    });

    assert.deepEqual(validated, ['beta']);
    assert.equal(result.ok, true);
    assert.equal(result.effectivePolicy.requirements.generatedRules.done, false);
    assert.ok(result.diagnostics.some((item) => item.code === 'active-change'));
    assert.ok(result.diagnostics.some((item) => item.code === 'openspec-effective-policy'));
    assert.ok(result.diagnostics.some((item) => item.code === 'openspec-validation'));
  });

  it('reports the latest verify gate result for the resolved active change', async () => {
    const rootDir = await createTempRoot();
    await writeFixture(rootDir, '.ai-factory/config.yaml', [
      'aifhub:',
      '  artifactProtocol: openspec',
      '  openspec:',
      '    archiveOnDone: true',
      'paths:',
      '  plans: openspec/changes',
      '  specs: openspec/specs',
      '  state: .ai-factory/state',
      '  qa: .ai-factory/qa',
      '  generated_rules: .ai-factory/rules/generated',
      ''
    ].join('\n'));
    await writeFixture(rootDir, 'openspec/config.yaml', 'project: test\n');
    await writeFixture(rootDir, 'openspec/changes/beta/proposal.md', '# Beta\n');
    await writeFixture(rootDir, '.ai-factory/state/current.yaml', 'change_id: beta\n');
    await writeFixture(rootDir, '.ai-factory/qa/beta/verify.md', [
      '# Verify: beta',
      '',
      'Verdict: FAIL',
      'Code verification: FAIL',
      '',
      renderGateResultBlock(createGateResult({
        gate: 'verify',
        status: 'fail',
        blockers: [{
          id: 'tests-failed',
          severity: 'error',
          file: 'src/auth.ts',
          summary: 'Tests failed.'
        }],
        affectedFiles: ['src/auth.ts'],
        suggestedNext: {
          command: '/aif-fix',
          reason: 'Verification failed.'
        }
      })),
      ''
    ].join('\n'));
    await mkdir(path.join(rootDir, 'openspec/specs'), { recursive: true });
    await mkdir(path.join(rootDir, '.ai-factory/rules/generated'), { recursive: true });

    const result = await doctorAifMode({
      rootDir,
      detectOpenSpec: async () => missingCliDetection(),
      getCurrentBranch: async () => 'feat/unmatched'
    });

    assert.equal(result.ok, false);
    assert.ok(result.diagnostics.some((item) => item.code === 'verify-gate-failed'));
  });

  it('includes coverage matrix diagnostics for the resolved active change', async () => {
    const rootDir = await createTempRoot();
    await writeFixture(rootDir, '.ai-factory/config.yaml', [
      'aifhub:',
      '  artifactProtocol: openspec',
      '  openspec:',
      '    archiveOnDone: false',
      'paths:',
      '  plans: openspec/changes',
      '  specs: openspec/specs',
      '  state: .ai-factory/state',
      '  qa: .ai-factory/qa',
      '  generated_rules: .ai-factory/rules/generated',
      ''
    ].join('\n'));
    await writeFixture(rootDir, 'openspec/config.yaml', 'project: test\n');
    await writeFixture(rootDir, 'openspec/changes/beta/proposal.md', '# Beta\n');
    await writeFixture(rootDir, 'openspec/changes/beta/tasks.md', '# Tasks\n');
    await writeFixture(rootDir, 'openspec/changes/beta/specs/auth/spec.md', '# Auth\n');
    await writeFixture(rootDir, '.ai-factory/state/current.yaml', 'change_id: beta\n');
    await writeFixture(rootDir, '.ai-factory/qa/beta/openspec-validation.json', JSON.stringify({
      changeId: 'beta',
      ok: true
    }, null, 2));
    await writeFixture(rootDir, '.ai-factory/qa/beta/verify.md', [
      '# Verify: beta',
      '',
      'Verdict: PASS',
      'Code verification: PASS',
      '',
      renderGateResultBlock(createGateResult({
        gate: 'verify',
        status: 'pass',
        blockers: [],
        affectedFiles: [],
        suggestedNext: null
      })),
      ''
    ].join('\n'));
    await writeFixture(rootDir, '.ai-factory/qa/beta/coverage.json', JSON.stringify({
      schema_version: 1,
      change_id: 'beta',
      status: 'pass',
      blocking: false,
      policy: {
        mode: 'strict',
        missing_requirement: 'fail'
      },
      requirements: [],
      summary: {
        covered: 0,
        partial: 0,
        missing: 0,
        not_applicable: 0
      },
      sources: [],
      stale: false,
      diagnostics: [],
      warnings: [],
      errors: []
    }, null, 2));
    await mkdir(path.join(rootDir, 'openspec/specs'), { recursive: true });
    await mkdir(path.join(rootDir, '.ai-factory/rules/generated'), { recursive: true });

    const result = await doctorAifMode({
      rootDir,
      detectOpenSpec: async () => availableCliDetection(),
      getCurrentBranch: async () => 'feat/unmatched',
      validateOpenSpecArtifactContract: async (options) => ({
        schema_version: 1,
        validator: 'aifhub-openspec-artifact-contract',
        change_id: options.changeId,
        status: 'pass',
        blocking: false,
        checks: [],
        suggested_next: null
      }),
      validateOpenSpecChange: async () => ({
        ok: true,
        stdout: '{"valid":true}',
        stderr: '',
        json: { valid: true }
      }),
      getOpenSpecStatus: async () => ({
        ok: true,
        stdout: '{"ok":true}',
        stderr: '',
        json: { ok: true }
      })
    });

    assert.equal(result.coverage.coverage.status, 'pass');
    assert.ok(result.diagnostics.some((item) => item.code === 'openspec-coverage-pass'));
  });

  it('reports unsupported Node for OpenSpec CLI capability', async () => {
    const rootDir = await createTempRoot();
    await writeFixture(rootDir, '.ai-factory/config.yaml', [
      'aifhub:',
      '  artifactProtocol: openspec',
      'paths:',
      '  plans: openspec/changes',
      '  specs: openspec/specs',
      '  state: .ai-factory/state',
      '  qa: .ai-factory/qa',
      '  generated_rules: .ai-factory/rules/generated',
      ''
    ].join('\n'));
    await writeFixture(rootDir, 'openspec/config.yaml', 'project: test\n');
    await mkdir(path.join(rootDir, 'openspec/specs'), { recursive: true });
    await mkdir(path.join(rootDir, 'openspec/changes'), { recursive: true });
    await mkdir(path.join(rootDir, '.ai-factory/state'), { recursive: true });
    await mkdir(path.join(rootDir, '.ai-factory/qa'), { recursive: true });
    await mkdir(path.join(rootDir, '.ai-factory/rules/generated'), { recursive: true });

    const result = await doctorAifMode({
      rootDir,
      detectOpenSpec: async () => availableCliDetection({
        nodeVersion: '20.18.0',
        nodeSupported: false,
        reason: 'unsupported-node',
        errors: [
          {
            code: 'unsupported-node',
            message: 'Node 20.18.0 does not satisfy OpenSpec requirement >=20.19.0.'
          }
        ]
      })
    });

    assert.equal(result.ok, false);
    assert.ok(result.diagnostics.some((item) => item.code === 'openspec-node-unsupported'));
  });
});
