// aif-artifact-sync.test.mjs - tests for AIFHub mode switching and artifact sync
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  doctorAifMode,
  exportOpenSpecCompatibility,
  getModeStatus,
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

async function pathExists(rootDir, relativePath) {
  try {
    await access(path.join(rootDir, ...relativePath.split('/')));
    return true;
  } catch {
    return false;
  }
}

function missingCliDetection() {
  return {
    available: false,
    canValidate: false,
    canArchive: false,
    version: null,
    reason: 'missing-cli',
    errors: [
      {
        code: 'missing-cli',
        message: 'OpenSpec CLI is not available on PATH.'
      }
    ]
  };
}

function availableCliDetection(overrides = {}) {
  return {
    available: true,
    canValidate: true,
    canArchive: true,
    version: '1.3.1',
    nodeVersion: overrides.nodeVersion ?? '20.19.0',
    nodeSupported: overrides.nodeSupported ?? true,
    versionSupported: overrides.versionSupported ?? true,
    reason: overrides.reason ?? null,
    errors: overrides.errors ?? []
  };
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((rootDir) => rm(rootDir, {
    recursive: true,
    force: true
  })));
});

describe('mode status', () => {
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
});

describe('mode switching', () => {
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
      'requireCliForVerify: false',
      'requireCliForDone: true'
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
      'node scripts/migrate-legacy-plans.mjs --all --dry-run',
      'node scripts/migrate-legacy-plans.mjs --all'
    ]);
    assert.equal(await pathExists(rootDir, 'openspec/changes/add-oauth/proposal.md'), false);
  });

  it('switches to AI Factory mode without deleting OpenSpec artifacts', async () => {
    const rootDir = await createTempRoot();
    await writeFixture(rootDir, 'openspec/changes/add-oauth/proposal.md', '# Proposal\n');

    const result = await switchToAiFactoryMode({
      rootDir,
      timestamp: '2026-04-29T00-00-00-000Z'
    });

    assert.equal(result.ok, true);
    assert.match(await readFixture(rootDir, '.ai-factory/config.yaml'), /artifactProtocol: ai-factory/);
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
    assert.match(await readFixture(rootDir, '.ai-factory/rules/generated/openspec-base.md'), /No base OpenSpec requirements found/);
    assert.match(await readFixture(rootDir, '.ai-factory/rules/generated/openspec-change-add-mfa.md'), /Requirement: Require MFA/);
    assert.match(await readFixture(rootDir, '.ai-factory/rules/generated/openspec-merged-add-mfa.md'), /Requirement: Require MFA/);
    assert.equal(result.validation.skipped, true);
    assert.equal(result.validation.reason, 'missing-cli');
    assert.equal(await pathExists(rootDir, '.ai-factory/state/mode-switches/2026-04-29T00-00-00-000Z-sync-openspec.md'), true);
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
    assert.equal(result.validation.skipped, true);
    assert.equal(result.validation.reason, 'no-selected-changes');
    assert.match(await readFixture(rootDir, '.ai-factory/rules/generated/openspec-base.md'), /Requirement: Accepted Auth/);
    assert.equal(await pathExists(rootDir, '.ai-factory/rules/generated/openspec-change-accepted-auth.md'), false);
    assert.equal(await pathExists(rootDir, 'openspec/changes/.ai-factory'), false);
    assert.equal(await pathExists(rootDir, '.ai-factory/state/mode-switches/2026-04-29T02-00-00-000Z-sync-openspec.md'), true);
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

describe('doctor', () => {
  it('detects ambiguous active change', async () => {
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
      getOpenSpecStatus: async () => ({
        ok: true,
        stdout: '{"ok":true}',
        stderr: '',
        json: { ok: true }
      })
    });

    assert.deepEqual(validated, ['beta']);
    assert.equal(result.ok, true);
    assert.ok(result.diagnostics.some((item) => item.code === 'active-change'));
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
