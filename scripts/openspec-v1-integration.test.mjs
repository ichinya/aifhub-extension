// openspec-v1-integration.test.mjs - integration coverage for OpenSpec-native mode
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { access, cp, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveActiveChange } from './active-change-resolver.mjs';
import {
  buildImplementationContext,
  writeExecutionTrace
} from './openspec-execution-context.mjs';
import {
  buildVerificationContext,
  readLatestVerificationEvidence,
  writeVerificationEvidence
} from './openspec-verification-context.mjs';
import { finalizeOpenSpecChange } from './openspec-done-finalizer.mjs';
import { compileOpenSpecRules } from './openspec-rules-compiler.mjs';
import { migrateLegacyPlan } from './legacy-plan-migration.mjs';
import {
  createGateResult,
  renderGateResultBlock
} from './aif-gate-result.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const FIXTURE_ROOT = path.join(REPO_ROOT, 'test', 'fixtures');
const tempRoots = [];

async function createTempRoot() {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'aifhub-openspec-v1-'));
  tempRoots.push(rootDir);
  return rootDir;
}

async function copyFixture(fixtureName, rootDir) {
  await cp(path.join(FIXTURE_ROOT, fixtureName), rootDir, { recursive: true });
}

async function pathExists(rootDir, relativePath) {
  try {
    await access(path.join(rootDir, ...relativePath.split('/')));
    return true;
  } catch {
    return false;
  }
}

async function readText(rootDir, relativePath) {
  return readFile(path.join(rootDir, ...relativePath.split('/')), 'utf8');
}

async function readJson(rootDir, relativePath) {
  return JSON.parse(await readText(rootDir, relativePath));
}

async function listFiles(rootDir, relativePath = '.') {
  const directoryPath = path.join(rootDir, ...relativePath.split('/').filter(Boolean));
  const files = [];

  if (!await pathExists(rootDir, relativePath)) {
    return files;
  }

  async function walk(currentPath) {
    for (const entry of await readdir(currentPath, { withFileTypes: true })) {
      const childPath = path.join(currentPath, entry.name);

      if (entry.isDirectory()) {
        await walk(childPath);
      } else if (entry.isFile()) {
        files.push(path.relative(rootDir, childPath).replaceAll('\\', '/'));
      }
    }
  }

  await walk(directoryPath);
  return files.sort();
}

function availableCliDetection() {
  return {
    available: true,
    canValidate: true,
    canArchive: true,
    version: '1.3.1',
    command: 'openspec',
    reason: null,
    errors: []
  };
}

function missingCliDetection() {
  return {
    available: false,
    canValidate: false,
    canArchive: false,
    version: null,
    command: 'openspec',
    reason: 'missing-cli',
    errors: [
      {
        code: 'missing-cli',
        message: 'OpenSpec CLI is not available on PATH.'
      }
    ]
  };
}

function validationResult(changeId = 'add-oauth', overrides = {}) {
  const ok = overrides.ok ?? true;

  return {
    ok,
    command: 'openspec',
    args: ['validate', changeId, '--type', 'change', '--strict', '--json', '--no-interactive', '--no-color'],
    exitCode: overrides.exitCode ?? (ok ? 0 : 1),
    stdout: overrides.stdout ?? JSON.stringify({ valid: ok }),
    stderr: overrides.stderr ?? '',
    json: Object.hasOwn(overrides, 'json') ? overrides.json : { valid: ok },
    jsonParseError: Object.hasOwn(overrides, 'jsonParseError') ? overrides.jsonParseError : null,
    error: Object.hasOwn(overrides, 'error') ? overrides.error : (ok ? null : {
      code: 'non-zero-exit',
      message: 'OpenSpec command failed with exit code 1.'
    })
  };
}

function statusResult(changeId = 'add-oauth', overrides = {}) {
  return {
    ok: overrides.ok ?? true,
    command: 'openspec',
    args: ['status', '--change', changeId, '--json', '--no-color'],
    exitCode: overrides.exitCode ?? 0,
    stdout: overrides.stdout ?? JSON.stringify({ change: changeId }),
    stderr: overrides.stderr ?? '',
    json: Object.hasOwn(overrides, 'json') ? overrides.json : { change: changeId },
    jsonParseError: Object.hasOwn(overrides, 'jsonParseError') ? overrides.jsonParseError : null,
    error: Object.hasOwn(overrides, 'error') ? overrides.error : null
  };
}

function archiveResult(changeId = 'add-oauth') {
  return {
    ok: true,
    command: 'openspec',
    args: ['archive', changeId, '--yes', '--no-color'],
    exitCode: 0,
    stdout: `Archived ${changeId}\n`,
    stderr: '',
    json: null,
    jsonParseError: null,
    error: null
  };
}

function openspecInstructionsResult() {
  return {
    ok: true,
    command: 'openspec',
    args: ['instructions', 'apply', '--change', 'add-oauth', '--json', '--no-color'],
    exitCode: 0,
    stdout: '{"artifact":"apply"}',
    stderr: '',
    json: { artifact: 'apply' },
    jsonParseError: null,
    error: null
  };
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((rootDir) => rm(rootDir, {
    recursive: true,
    force: true
  })));
});

describe('OpenSpec-native fixture integration', () => {
  it('resolves the generated add-oauth fixture and loads implementation context artifacts', async () => {
    const rootDir = await createTempRoot();
    const instructionCalls = [];
    await copyFixture('openspec-native', rootDir);

    const resolved = await resolveActiveChange({
      rootDir,
      changeId: 'add-oauth',
      getCurrentBranch: async () => 'feat/add-oauth'
    });

    const context = await buildImplementationContext({
      rootDir,
      changeId: 'add-oauth',
      detectOpenSpec: async () => availableCliDetection(),
      getOpenSpecInstructions: async (artifact, options) => {
        instructionCalls.push({ artifact, options });
        return openspecInstructionsResult();
      }
    });

    assert.equal(resolved.ok, true);
    assert.equal(resolved.source, 'explicit');
    assert.equal(context.ok, true);
    assert.equal(context.mode, 'openspec-native');
    assert.equal(context.changeId, 'add-oauth');
    assert.match(context.canonicalArtifacts.proposal.content, /Add OAuth Authentication/);
    assert.match(context.canonicalArtifacts.design.content, /OAuth callback validates provider state/);
    assert.match(context.canonicalArtifacts.tasks.content, /Add GitHub OAuth callback route/);
    assert.deepEqual(context.canonicalArtifacts.baseSpecs.map((item) => item.path), [
      'openspec/specs/auth/spec.md'
    ]);
    assert.deepEqual(context.canonicalArtifacts.deltaSpecs.map((item) => item.path), [
      'openspec/changes/add-oauth/specs/auth/spec.md'
    ]);
    assert.equal(context.openspecInstructions.available, true);
    assert.equal(instructionCalls[0].artifact, 'apply');
    assert.equal(await pathExists(rootDir, '.ai-factory/plans/add-oauth'), false);
  });

  it('writes verification QA evidence with a fake compatible OpenSpec CLI', async () => {
    const rootDir = await createTempRoot();
    await copyFixture('openspec-native', rootDir);

    const result = await buildVerificationContext({
      rootDir,
      changeId: 'add-oauth',
      detectOpenSpec: async () => availableCliDetection(),
      validateOpenSpecChange: async () => validationResult('add-oauth'),
      getOpenSpecStatus: async () => statusResult('add-oauth')
    });

    assert.equal(result.ok, true);
    assert.equal(result.shouldRunCodeVerification, true);
    assert.equal(result.openspec.validation.ok, true);
    assert.equal(result.openspec.status.ok, true);
    assert.ok(result.qaEvidence.files.includes('.ai-factory/qa/add-oauth/openspec-validation.json'));
    assert.ok(result.qaEvidence.files.includes('.ai-factory/qa/add-oauth/openspec-status.json'));
    assert.ok(result.qaEvidence.files.includes('.ai-factory/qa/add-oauth/verify.md'));
    assert.equal(await pathExists(rootDir, 'openspec/changes/add-oauth/verify.md'), false);
    assert.equal(await pathExists(rootDir, 'openspec/changes/add-oauth/openspec-validation.json'), false);
    assert.equal(await pathExists(rootDir, '.ai-factory/plans/add-oauth'), false);

    const validation = await readJson(rootDir, '.ai-factory/qa/add-oauth/openspec-validation.json');
    assert.deepEqual(validation.parsedJson, { valid: true });
    assert.equal(validation.rawStdoutPath, '.ai-factory/qa/add-oauth/raw/openspec-validate.stdout');
    assert.match(await readText(rootDir, '.ai-factory/qa/add-oauth/verify.md'), /Code verification: PENDING/);
  });

  it('records invalid validation under QA and does not archive failed changes', async () => {
    const rootDir = await createTempRoot();
    let archiveCalls = 0;
    await copyFixture('openspec-native', rootDir);

    const verification = await buildVerificationContext({
      rootDir,
      changeId: 'bad-change',
      detectOpenSpec: async () => availableCliDetection(),
      validateOpenSpecChange: async () => validationResult('bad-change', {
        ok: false,
        stdout: '{"valid":false}',
        json: { valid: false }
      }),
      getOpenSpecStatus: async () => {
        throw new Error('status should not run after failed validation');
      }
    });
    const finalized = await finalizeOpenSpecChange({
      rootDir,
      changeId: 'bad-change',
      detectOpenSpec: async () => availableCliDetection(),
      gitStatus: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      archiveOpenSpecChange: async () => {
        archiveCalls += 1;
        return archiveResult('bad-change');
      }
    });

    assert.equal(verification.ok, false);
    assert.equal(verification.shouldRunCodeVerification, false);
    assert.equal(verification.errors[0].code, 'openspec-validation-failed');
    assert.ok(verification.qaEvidence.files.includes('.ai-factory/qa/bad-change/openspec-validation.json'));
    assert.match(await readText(rootDir, '.ai-factory/qa/bad-change/verify.md'), /Code verification: BLOCKED/);
    assert.equal(finalized.ok, false);
    assert.equal(finalized.archive.status, 'SKIPPED');
    assert.equal(archiveCalls, 0);
    assert.equal(await pathExists(rootDir, 'openspec/changes/bad-change/openspec-validation.json'), false);
    assert.equal(await pathExists(rootDir, 'openspec/changes/bad-change/openspec-archive.json'), false);
  });
});

describe('Legacy migration integration with OpenSpec-native modules', () => {
  it('migrates the legacy dual-plan fixture without deleting sources or leaking runtime-only files', async () => {
    const rootDir = await createTempRoot();
    await copyFixture('legacy-plan-basic', rootDir);

    const dryRun = await migrateLegacyPlan('add-oauth', {
      rootDir,
      dryRun: true,
      detectOpenSpec: async () => missingCliDetection()
    });

    assert.equal(dryRun.ok, true);
    assert.equal(dryRun.dryRun, true);
    assert.equal(await pathExists(rootDir, 'openspec/changes/add-oauth'), false);

    const migrated = await migrateLegacyPlan('add-oauth', {
      rootDir,
      detectOpenSpec: async () => missingCliDetection()
    });
    const resolved = await resolveActiveChange({
      rootDir,
      changeId: 'add-oauth',
      getCurrentBranch: async () => 'feat/add-oauth'
    });
    const context = await buildImplementationContext({
      rootDir,
      changeId: 'add-oauth',
      detectOpenSpec: async () => missingCliDetection()
    });

    assert.equal(migrated.ok, true);
    assert.equal(migrated.validation.status, 'SKIPPED');
    assert.equal(await pathExists(rootDir, 'openspec/changes/add-oauth/proposal.md'), true);
    assert.equal(await pathExists(rootDir, 'openspec/changes/add-oauth/design.md'), true);
    assert.equal(await pathExists(rootDir, 'openspec/changes/add-oauth/tasks.md'), true);
    assert.equal(await pathExists(rootDir, 'openspec/changes/add-oauth/specs/migrated/spec.md'), true);
    assert.equal(await pathExists(rootDir, '.ai-factory/state/add-oauth/legacy-context.md'), true);
    assert.equal(await pathExists(rootDir, '.ai-factory/state/add-oauth/legacy-rules.md'), true);
    assert.equal(await pathExists(rootDir, '.ai-factory/state/add-oauth/legacy-status.yaml'), true);
    assert.equal(await pathExists(rootDir, '.ai-factory/qa/add-oauth/legacy-verify.md'), true);
    assert.equal(await pathExists(rootDir, 'openspec/changes/add-oauth/verify.md'), false);
    assert.equal(await pathExists(rootDir, 'openspec/changes/add-oauth/status.yaml'), false);
    assert.equal(await pathExists(rootDir, '.ai-factory/plans/add-oauth.md'), true);
    assert.equal(await pathExists(rootDir, '.ai-factory/plans/add-oauth/task.md'), true);
    assert.equal(resolved.ok, true);
    assert.equal(context.ok, true);
    assert.match(context.canonicalArtifacts.proposal.content, /GitHub OAuth callback/);
  });
});

describe('Generated rules integration', () => {
  it('writes deterministic generated rules under runtime paths only', async () => {
    const rootDir = await createTempRoot();
    await copyFixture('generated-rules', rootDir);
    await writeFile(path.join(rootDir, 'openspec', 'changes', 'add-oauth', 'proposal.md'), '# Proposal\n', 'utf8');

    const beforeCanonical = [
      ...await listFiles(rootDir, 'openspec/specs'),
      ...await listFiles(rootDir, 'openspec/changes')
    ];
    const first = await compileOpenSpecRules('add-oauth', {
      rootDir,
      detectOpenSpec: async () => missingCliDetection(),
      getCurrentBranch: async () => 'feat/add-oauth'
    });
    const outputsAfterFirst = {
      base: await readText(rootDir, '.ai-factory/rules/generated/openspec-base.md'),
      change: await readText(rootDir, '.ai-factory/rules/generated/openspec-change-add-oauth.md'),
      merged: await readText(rootDir, '.ai-factory/rules/generated/openspec-merged-add-oauth.md')
    };
    const second = await compileOpenSpecRules('add-oauth', {
      rootDir,
      detectOpenSpec: async () => missingCliDetection(),
      getCurrentBranch: async () => 'feat/add-oauth'
    });
    const outputsAfterSecond = {
      base: await readText(rootDir, '.ai-factory/rules/generated/openspec-base.md'),
      change: await readText(rootDir, '.ai-factory/rules/generated/openspec-change-add-oauth.md'),
      merged: await readText(rootDir, '.ai-factory/rules/generated/openspec-merged-add-oauth.md')
    };
    const afterCanonical = [
      ...await listFiles(rootDir, 'openspec/specs'),
      ...await listFiles(rootDir, 'openspec/changes')
    ];

    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.deepEqual(first.files.map((file) => path.relative(rootDir, file.path).replaceAll('\\', '/')), [
      '.ai-factory/rules/generated/openspec-base.md',
      '.ai-factory/rules/generated/openspec-change-add-oauth.md',
      '.ai-factory/rules/generated/openspec-merged-add-oauth.md'
    ]);
    assert.deepEqual(outputsAfterSecond, outputsAfterFirst);
    assert.deepEqual(afterCanonical, beforeCanonical);
    assert.match(outputsAfterFirst.base, /Source of truth: OpenSpec canonical specs/);
    assert.match(outputsAfterFirst.base, /Requirement: Existing sign in/);
    assert.match(outputsAfterFirst.change, /Requirement: OAuth sign in/);
    assert.match(outputsAfterFirst.merged, /openspec\/specs\/auth\/spec\.md/);
    assert.match(outputsAfterFirst.merged, /openspec\/changes\/add-oauth\/specs\/auth\/spec\.md/);
    assert.doesNotMatch(outputsAfterFirst.merged, /\b\d{4}-\d{2}-\d{2}T\d{2}:/);
  });
});

describe('Full OpenSpec v1 mocked paths', () => {
  it('runs rules, implementation context, verification, and done finalization with mocked CLI', async () => {
    const rootDir = await createTempRoot();
    const archiveCalls = [];
    await copyFixture('openspec-native', rootDir);

    const rules = await compileOpenSpecRules('add-oauth', {
      rootDir,
      detectOpenSpec: async () => missingCliDetection(),
      getCurrentBranch: async () => 'feat/add-oauth'
    });
    const implementation = await buildImplementationContext({
      rootDir,
      changeId: 'add-oauth',
      detectOpenSpec: async () => availableCliDetection(),
      getOpenSpecInstructions: async () => openspecInstructionsResult()
    });
    await writeExecutionTrace('add-oauth', {
      summary: 'Loaded canonical OpenSpec artifacts for integration coverage.',
      canonicalArtifactsRead: [
        'openspec/changes/add-oauth/proposal.md',
        'openspec/changes/add-oauth/design.md',
        'openspec/changes/add-oauth/tasks.md'
      ],
      generatedRulesRead: rules.files.map((file) => file.path),
      changedFiles: ['scripts/openspec-v1-integration.test.mjs']
    }, {
      rootDir,
      runId: 'integration'
    });
    const verification = await buildVerificationContext({
      rootDir,
      changeId: 'add-oauth',
      detectOpenSpec: async () => availableCliDetection(),
      validateOpenSpecChange: async () => validationResult('add-oauth'),
      getOpenSpecStatus: async () => statusResult('add-oauth')
    });
    await writeVerificationEvidence('add-oauth', {
      validation: validationResult('add-oauth'),
      status: statusResult('add-oauth'),
      generatedRules: verification.generatedRules,
      shouldRunCodeVerification: true,
      warnings: [],
      errors: []
    }, {
      rootDir
    });
    await writeFile(
      path.join(rootDir, '.ai-factory', 'qa', 'add-oauth', 'verify.md'),
      [
        '# Verify: add-oauth',
        '',
        'Verdict: PASS',
        'OpenSpec validation: PASS',
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
      ].join('\n'),
      'utf8'
    );
    const finalized = await finalizeOpenSpecChange({
      rootDir,
      changeId: 'add-oauth',
      detectOpenSpec: async () => availableCliDetection(),
      getOpenSpecStatus: async () => statusResult('add-oauth'),
      gitStatus: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      archiveOpenSpecChange: async (changeId, options) => {
        archiveCalls.push({ changeId, args: ['archive', changeId, '--yes', '--no-color'], options });
        return archiveResult(changeId);
      }
    });

    assert.equal(rules.ok, true);
    assert.equal(implementation.ok, true);
    assert.equal(verification.ok, true);
    assert.equal(finalized.ok, true);
    assert.equal(finalized.archive.archived, true);
    assert.deepEqual(archiveCalls.map((call) => call.args), [
      ['archive', 'add-oauth', '--yes', '--no-color']
    ]);
    assert.equal(await pathExists(rootDir, '.ai-factory/state/add-oauth/implementation/integration.md'), true);
    assert.equal(await pathExists(rootDir, '.ai-factory/state/add-oauth/final-summary.md'), true);
    assert.equal(await pathExists(rootDir, '.ai-factory/qa/add-oauth/done.md'), true);
    assert.equal(await pathExists(rootDir, '.ai-factory/qa/add-oauth/openspec-archive.json'), true);
    assert.equal(await pathExists(rootDir, 'openspec/changes/add-oauth/done.md'), false);
    assert.equal(await pathExists(rootDir, '.ai-factory/plans/add-oauth'), false);

    const archiveEvidence = await readJson(rootDir, '.ai-factory/qa/add-oauth/openspec-archive.json');
    assert.deepEqual(archiveEvidence.args, ['archive', 'add-oauth', '--yes', '--no-color']);
  });

  it('supports degraded implementation and verification but refuses archive-required done without CLI', async () => {
    const rootDir = await createTempRoot();
    await copyFixture('openspec-native', rootDir);

    const canonicalBefore = await listFiles(rootDir, 'openspec/specs');
    const implementation = await buildImplementationContext({
      rootDir,
      changeId: 'add-oauth',
      detectOpenSpec: async () => missingCliDetection()
    });
    const verification = await buildVerificationContext({
      rootDir,
      changeId: 'add-oauth',
      detectOpenSpec: async () => missingCliDetection()
    });
    await writeFile(
      path.join(rootDir, '.ai-factory', 'qa', 'add-oauth', 'verify.md'),
      [
        '# Verify: add-oauth',
        '',
        'Verdict: PASS-with-notes',
        'OpenSpec validation: SKIPPED',
        'Code verification: PASS',
        '',
        renderGateResultBlock(createGateResult({
          gate: 'verify',
          status: 'warn',
          blockers: [],
          affectedFiles: [],
          suggestedNext: null
        })),
        ''
      ].join('\n'),
      'utf8'
    );
    const finalized = await finalizeOpenSpecChange({
      rootDir,
      changeId: 'add-oauth',
      detectOpenSpec: async () => missingCliDetection(),
      gitStatus: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      archiveOpenSpecChange: async () => {
        throw new Error('archive should not run without CLI capability');
      }
    });
    const canonicalAfter = await listFiles(rootDir, 'openspec/specs');

    assert.equal(implementation.ok, true);
    assert.equal(implementation.openspecInstructions.available, false);
    assert.equal(verification.ok, true);
    assert.equal(verification.shouldRunCodeVerification, true);
    assert.ok(verification.warnings.some((warning) => warning.code === 'openspec-cli-unavailable'));
    assert.equal(finalized.ok, false);
    assert.equal(finalized.archive.errors[0].code, 'openspec-cli-required-for-archive');
    assert.deepEqual(canonicalAfter, canonicalBefore);
    assert.equal(await pathExists(rootDir, 'openspec/specs/archive'), false);
  });
});
