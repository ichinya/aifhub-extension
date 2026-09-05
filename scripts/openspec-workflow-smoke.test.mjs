// openspec-workflow-smoke.test.mjs - workflow smoke coverage for new project and add-feature flows
import { execFile } from 'node:child_process';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  doctorAifMode,
  getModeStatus,
  switchToOpenSpecMode,
  syncOpenSpecArtifacts
} from './aif-artifact-sync.mjs';
import {
  buildImplementationContext,
  writeExecutionTrace
} from './openspec-execution-context.mjs';
import {
  buildVerificationContext,
  writeVerificationEvidence
} from './openspec-verification-context.mjs';
import { finalizeOpenSpecChange } from './openspec-done-finalizer.mjs';
import {
  createGateResult,
  renderGateResultBlock
} from './aif-gate-result.mjs';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const tempRoots = [];

async function createTempRoot(prefix = 'aifhub-workflow-smoke-') {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(rootDir);
  return rootDir;
}

async function writeFixture(rootDir, relativePath, content) {
  const targetPath = path.join(rootDir, ...relativePath.split('/'));
  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeFile(targetPath, content, 'utf8');
  return targetPath;
}

async function readText(rootDir, relativePath) {
  return readFile(path.join(rootDir, ...relativePath.split('/')), 'utf8');
}

async function readJson(rootDir, relativePath) {
  return JSON.parse(await readText(rootDir, relativePath));
}

async function pathExists(rootDir, relativePath) {
  try {
    await access(path.join(rootDir, ...relativePath.split('/')));
    return true;
  } catch {
    return false;
  }
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

function availableCliDetection() {
  return {
    available: true,
    canValidate: true,
    canArchive: true,
    version: '1.3.1',
    command: 'openspec',
    nodeVersion: '20.19.0',
    nodeSupported: true,
    versionSupported: true,
    reason: null,
    errors: []
  };
}

function validationResult(changeId, overrides = {}) {
  const ok = overrides.ok ?? true;

  return {
    ok,
    command: 'openspec',
    args: ['validate', changeId, '--type', 'change', '--strict', '--json', '--no-interactive', '--no-color'],
    exitCode: overrides.exitCode ?? (ok ? 0 : 1),
    stdout: overrides.stdout ?? JSON.stringify({ valid: ok, change: changeId }),
    stderr: overrides.stderr ?? '',
    json: Object.hasOwn(overrides, 'json') ? overrides.json : { valid: ok, change: changeId },
    jsonParseError: Object.hasOwn(overrides, 'jsonParseError') ? overrides.jsonParseError : null,
    error: Object.hasOwn(overrides, 'error') ? overrides.error : (ok ? null : {
      code: 'openspec-validation-failed',
      message: 'OpenSpec validation failed.'
    })
  };
}

function statusResult(changeId, overrides = {}) {
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

function archiveResult(changeId, overrides = {}) {
  return {
    ok: overrides.ok ?? true,
    command: 'openspec',
    args: ['archive', changeId, '--yes', '--no-color'],
    exitCode: overrides.exitCode ?? 0,
    stdout: overrides.stdout ?? `Archived ${changeId}\n`,
    stderr: overrides.stderr ?? '',
    json: null,
    jsonParseError: null,
    error: overrides.error ?? null
  };
}

function openspecInstructionsResult(changeId) {
  return {
    ok: true,
    command: 'openspec',
    args: ['instructions', 'apply', '--change', changeId, '--json', '--no-color'],
    exitCode: 0,
    stdout: JSON.stringify({ change: changeId, steps: ['apply workflow smoke fixture'] }),
    stderr: '',
    json: { change: changeId, steps: ['apply workflow smoke fixture'] },
    jsonParseError: null,
    error: null
  };
}

function passVerifyMarkdown(changeId) {
  return [
    `# Verify: ${changeId}`,
    '',
    'Verdict: PASS',
    'OpenSpec validation: PASS',
    'OpenSpec status: PASS',
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
  ].join('\n');
}

async function createOpenSpecConfig(rootDir) {
  await writeFixture(rootDir, '.ai-factory/config.yaml', [
    'aifhub:',
    '  artifactProtocol: openspec',
    '  openspec:',
    '    installSkills: false',
    '    compileRulesOnSync: true',
    '    validateOnSync: true',
    '    validateOnVerify: true',
    '    statusOnVerify: true',
    '    requireCliForPlan: false',
    '    requireCliForImprove: false',
    '    requireCliForVerify: false',
    '    requireCliForDone: true',
    '    requireGeneratedRulesForVerify: false',
    '    requireGeneratedRulesForDone: true',
    '    requireRulesPassForVerify: false',
    '    requireRulesPassForDone: true',
    '    requireSpecCoverageForVerify: false',
    '    requireSpecCoverageForDone: true',
    '    allowWarnOnDone:',
    '      rules: false',
    '      coverage: false',
    '      openspecStatus: true',
    'paths:',
    '  plans: openspec/changes',
    '  specs: openspec/specs',
    '  state: .ai-factory/state',
    '  qa: .ai-factory/qa',
    '  generated_rules: .ai-factory/rules/generated',
    ''
  ].join('\n'));
  await writeFixture(rootDir, 'openspec/config.yaml', 'project: workflow-smoke\n');
}

async function createOauthFeatureChange(rootDir, changeId = 'add-oauth-login') {
  await writeFixture(rootDir, 'openspec/specs/auth/spec.md', [
    '# Auth',
    '',
    '## Requirements',
    '',
    '### Requirement: Existing sign in',
    '',
    'The system MUST preserve existing sign in behavior.',
    ''
  ].join('\n'));
  await writeFixture(rootDir, `openspec/changes/${changeId}/proposal.md`, '# Proposal: Add OAuth Login\n');
  await writeFixture(rootDir, `openspec/changes/${changeId}/design.md`, '# Design: Add OAuth Login\n');
  await writeFixture(rootDir, `openspec/changes/${changeId}/tasks.md`, [
    '# Tasks',
    '',
    '- [ ] Add OAuth login smoke fixture',
    ''
  ].join('\n'));
  await writeFixture(rootDir, `openspec/changes/${changeId}/specs/auth/spec.md`, [
    '# Auth Delta',
    '',
    '## ADDED Requirements',
    '',
    '### Requirement: OAuth login',
    '',
    'The system MUST support OAuth login.',
    '',
    '#### Scenario: user signs in with OAuth',
    '',
    '- GIVEN an existing user account',
    '- WHEN the user signs in with an OAuth provider',
    '- THEN the system establishes a valid authenticated session.',
    ''
  ].join('\n'));
}

async function runValidateExtension() {
  try {
    await execFileAsync(process.execPath, ['scripts/validate-extension.mjs'], {
      cwd: REPO_ROOT,
      maxBuffer: 1024 * 1024
    });
  } catch (err) {
    assert.fail([
      'Scenario A expected extension.json to remain valid against upstream schema.',
      `stdout:\n${err?.stdout ?? ''}`,
      `stderr:\n${err?.stderr ?? ''}`
    ].join('\n'));
  }
}

async function finalizeWithArchive(rootDir, changeId) {
  const archiveCalls = [];
  await writeRulesGateEvidence(rootDir, changeId);
  await writePassingCoverageEvidence(rootDir, changeId);
  const finalized = await finalizeOpenSpecChange({
    rootDir,
    changeId,
    detectOpenSpec: async () => availableCliDetection(),
    validateOpenSpecChange: async () => validationResult(changeId),
    getOpenSpecStatus: async () => statusResult(changeId),
    gitStatus: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    archiveOpenSpecChange: async (requestedChangeId, options) => {
      archiveCalls.push({ changeId: requestedChangeId, options });
      return archiveResult(requestedChangeId);
    }
  });

  return { finalized, archiveCalls };
}

async function writeRulesGateEvidence(rootDir, changeId) {
  await writeFixture(rootDir, `.ai-factory/qa/${changeId}/rules.md`, [
    '# Rules Gate',
    '',
    renderGateResultBlock(createGateResult({
      gate: 'rules',
      status: 'pass',
      blockers: [],
      affectedFiles: [],
      suggestedNext: null
    })),
    ''
  ].join('\n'));
}

async function writePassingCoverageEvidence(rootDir, changeId) {
  await writeFixture(rootDir, `.ai-factory/qa/${changeId}/coverage.json`, JSON.stringify({
    schema_version: 1,
    change_id: changeId,
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
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((rootDir) => rm(rootDir, {
    recursive: true,
    force: true
  })));
});

describe('OpenSpec workflow smoke: new project setup', () => {
  it('models /aif-analyze -> /aif-mode openspec -> status -> doctor with missing CLI degraded', async () => {
    const rootDir = await createTempRoot();

    const switched = await switchToOpenSpecMode({
      rootDir,
      detectOpenSpec: async () => missingCliDetection(),
      timestamp: '2026-05-05T00-00-00-000Z'
    });
    const status = await getModeStatus({
      rootDir,
      detectOpenSpec: async () => missingCliDetection(),
      getCurrentBranch: async () => 'main'
    });
    const doctor = await doctorAifMode({
      rootDir,
      detectOpenSpec: async () => missingCliDetection(),
      getCurrentBranch: async () => 'main'
    });

    assert.equal(switched.ok, true, 'Scenario A setup should not fail solely because OpenSpec CLI is missing.');
    for (const expectedPath of [
      '.ai-factory/config.yaml',
      'openspec/config.yaml',
      'openspec/specs',
      'openspec/changes',
      '.ai-factory/state',
      '.ai-factory/qa',
      '.ai-factory/rules/generated'
    ]) {
      assert.equal(await pathExists(rootDir, expectedPath), true, `Scenario A expected artifact path ${expectedPath}`);
    }

    const config = await readText(rootDir, '.ai-factory/config.yaml');
    assert.match(config, /openspec:\s*true/, 'Scenario A expected OpenSpec-native config marker.');
    assert.match(config, /installSkills:\s*false/, 'Scenario A expected OpenSpec skills installation disabled.');
    assert.equal(await pathExists(rootDir, '.codex/skills/openspec'), false, 'Scenario A must not install Codex OpenSpec skills.');
    assert.equal(await pathExists(rootDir, '.claude/commands/openspec.md'), false, 'Scenario A must not install OpenSpec slash commands.');
    assert.equal(status.mode, 'openspec', 'Scenario A status should report OpenSpec mode.');
    assert.equal(status.openspecCli.state, 'degraded', 'Scenario A status should report missing CLI as degraded.');
    assert.ok(
      doctor.diagnostics.some((item) => item.code === 'openspec-cli-known' && /degraded/.test(item.message)),
      'Scenario A doctor should expose degraded OpenSpec CLI capability.'
    );
    assert.ok(
      doctor.diagnostics.some((item) => item.code === 'aif-done-archive-unavailable'),
      'Scenario A doctor should keep archive-required /aif-done strict while setup succeeds.'
    );

    const metadata = JSON.parse(await readFile(path.join(REPO_ROOT, 'aifhub-extension.json'), 'utf8'));
    assert.equal(
      metadata.compat['ai-factory'],
      '>=2.11.0 <3.0.0',
      'Scenario A expected aifhub-extension.json compatibility to remain stable.'
    );
    await runValidateExtension();
  });
});

describe('OpenSpec workflow smoke: add feature', () => {
  it('models add-feature sync, implementation, verify evidence, done archive, and post-archive sync', async () => {
    const rootDir = await createTempRoot();
    const changeId = 'add-oauth-login';
    await createOpenSpecConfig(rootDir);
    await createOauthFeatureChange(rootDir, changeId);

    const sync = await syncOpenSpecArtifacts({
      rootDir,
      changeId,
      detectOpenSpec: async () => availableCliDetection(),
      validateOpenSpecChange: async (id) => validationResult(id),
      getOpenSpecStatus: async (id) => statusResult(id),
      timestamp: '2026-05-05T01-00-00-000Z'
    });

    assert.equal(sync.ok, true, 'Scenario B /aif-mode sync --change should pass with injected compatible CLI.');
    for (const [relativePath, expectedRequirement] of [
      ['.ai-factory/rules/generated/openspec-base.md', 'Requirement: Existing sign in'],
      ['.ai-factory/rules/generated/openspec-change-add-oauth-login.md', 'Requirement: OAuth login'],
      ['.ai-factory/rules/generated/openspec-merged-add-oauth-login.md', 'Requirement: OAuth login']
    ]) {
      assert.match(
        await readText(rootDir, relativePath),
        new RegExp(expectedRequirement),
        `Scenario B generated rule ${relativePath} should include ${expectedRequirement}.`
      );
    }

    const implementation = await buildImplementationContext({
      rootDir,
      changeId,
      detectOpenSpec: async () => availableCliDetection(),
      getOpenSpecInstructions: async () => openspecInstructionsResult(changeId)
    });
    assert.equal(implementation.ok, true, 'Scenario B implementation context should load canonical artifacts.');
    assert.deepEqual(implementation.canonicalArtifacts.deltaSpecs.map((item) => item.path), [
      'openspec/changes/add-oauth-login/specs/auth/spec.md'
    ]);

    const trace = await writeExecutionTrace(changeId, {
      summary: 'Loaded add-feature workflow smoke context.',
      canonicalArtifactsRead: [
        `openspec/changes/${changeId}/proposal.md`,
        `openspec/changes/${changeId}/design.md`,
        `openspec/changes/${changeId}/tasks.md`
      ],
      generatedRulesRead: sync.generatedRules.files.map((file) => file.relativePath),
      changedFiles: ['scripts/openspec-workflow-smoke.test.mjs'],
      nextStep: `/aif-verify ${changeId}`
    }, {
      rootDir,
      runId: 'workflow-smoke'
    });
    assert.equal(trace.relativePath, '.ai-factory/state/add-oauth-login/implementation/workflow-smoke.md');

    const verification = await buildVerificationContext({
      rootDir,
      changeId,
      detectOpenSpec: async () => availableCliDetection(),
      validateOpenSpecChange: async (id) => validationResult(id),
      getOpenSpecStatus: async (id) => statusResult(id)
    });
    assert.equal(verification.ok, true, 'Scenario B /aif-verify context should write QA evidence.');
    assert.ok(
      verification.qaEvidence.files.includes('.ai-factory/qa/add-oauth-login/openspec-validation.json'),
      'Scenario B expected openspec-validation.json evidence.'
    );
    assert.ok(
      verification.qaEvidence.files.includes('.ai-factory/qa/add-oauth-login/openspec-status.json'),
      'Scenario B expected optional openspec-status.json evidence.'
    );
    assert.ok(
      verification.qaEvidence.files.includes('.ai-factory/qa/add-oauth-login/verify.md'),
      'Scenario B expected verify.md evidence.'
    );

    const validationEvidence = await readJson(rootDir, '.ai-factory/qa/add-oauth-login/openspec-validation.json');
    assert.equal(
      validationEvidence.rawStdoutPath,
      '.ai-factory/qa/add-oauth-login/raw/openspec-validate.stdout',
      'Scenario B validation evidence should expose raw stdout path.'
    );
    assert.equal(
      validationEvidence.rawStderrPath,
      '.ai-factory/qa/add-oauth-login/raw/openspec-validate.stderr',
      'Scenario B validation evidence should expose raw stderr path.'
    );
    assert.match(
      await readText(rootDir, '.ai-factory/qa/add-oauth-login/verify.md'),
      /```aif-gate-result/,
      'Scenario B verify.md should include final aif-gate-result block.'
    );

    await writeFixture(rootDir, `.ai-factory/qa/${changeId}/verify.md`, passVerifyMarkdown(changeId));
    const { finalized, archiveCalls } = await finalizeWithArchive(rootDir, changeId);

    assert.equal(finalized.ok, true, 'Scenario B /aif-done should finalize passed verification.');
    assert.deepEqual(
      archiveCalls.map((call) => call.changeId),
      [changeId],
      'Scenario B archive runner should be called exactly once for add-oauth-login.'
    );
    assert.equal(await pathExists(rootDir, '.ai-factory/qa/add-oauth-login/openspec-archive.json'), true);
    assert.equal(await pathExists(rootDir, '.ai-factory/qa/add-oauth-login/done.md'), true);
    assert.equal(await pathExists(rootDir, '.ai-factory/state/add-oauth-login/final-summary.md'), true);
    assert.deepEqual(
      (await readJson(rootDir, '.ai-factory/qa/add-oauth-login/openspec-archive.json')).args,
      ['archive', changeId, '--yes', '--no-color'],
      'Scenario B archive evidence should record openspec archive add-oauth-login --yes --no-color.'
    );
    assert.equal(await pathExists(rootDir, 'openspec/changes/add-oauth-login/done.md'), false);
    assert.equal(await pathExists(rootDir, '.ai-factory/plans/add-oauth-login/task.md'), false);

    await rm(path.join(rootDir, 'openspec', 'changes', changeId), { recursive: true, force: true });
    await writeFixture(rootDir, 'openspec/specs/auth/spec.md', [
      '# Auth',
      '',
      '## Requirements',
      '',
      '### Requirement: Accepted OAuth login',
      '',
      'The system MUST preserve accepted OAuth login behavior.',
      ''
    ].join('\n'));
    const postArchiveSync = await syncOpenSpecArtifacts({
      rootDir,
      detectOpenSpec: async () => missingCliDetection(),
      getCurrentBranch: async () => 'main',
      timestamp: '2026-05-05T02-00-00-000Z'
    });

    assert.equal(postArchiveSync.ok, true, 'Scenario B post-archive /aif-mode sync should refresh base generated rules.');
    assert.equal(postArchiveSync.changes.changeIds.length, 0, 'Scenario B post-archive sync should tolerate no active change.');
    assert.equal(postArchiveSync.generatedRules.baseOnly, true, 'Scenario B post-archive sync should run base-only generated rules.');
    assert.match(
      await readText(rootDir, '.ai-factory/rules/generated/openspec-base.md'),
      /Requirement: Accepted OAuth login/,
      'Scenario B post-archive base generated rules should include accepted spec behavior.'
    );
    for (const relativePath of [
      `.ai-factory/rules/generated/openspec-change-${changeId}.md`,
      `.ai-factory/rules/generated/openspec-merged-${changeId}.md`,
      `.ai-factory/rules/generated/openspec-rules-trace-${changeId}.json`
    ]) {
      assert.equal(
        await pathExists(rootDir, relativePath),
        false,
        `Scenario B archived ${changeId} managed output ${relativePath} should be pruned.`
      );
    }
    const postArchiveIndex = await readJson(rootDir, '.ai-factory/rules/generated/index.json');
    assert.deepEqual(postArchiveIndex.changes, [], `Scenario B archived ${changeId} index membership should be pruned.`);
    assert.deepEqual(
      postArchiveSync.generatedRules.operations.filter((item) => item.action === 'remove').map((item) => item.target),
      [
        `.ai-factory/rules/generated/openspec-change-${changeId}.md`,
        `.ai-factory/rules/generated/openspec-merged-${changeId}.md`,
        `.ai-factory/rules/generated/openspec-rules-trace-${changeId}.json`
      ],
      `Scenario B archived ${changeId} should report every bounded managed removal.`
    );

    const stableBefore = await Promise.all([
      readText(rootDir, '.ai-factory/rules/generated/openspec-base.md'),
      readText(rootDir, '.ai-factory/rules/generated/index.json')
    ]);
    const repeatedSync = await syncOpenSpecArtifacts({
      rootDir,
      detectOpenSpec: async () => missingCliDetection(),
      getCurrentBranch: async () => 'main',
      timestamp: '2026-05-05T03-00-00-000Z'
    });
    const stableAfter = await Promise.all([
      readText(rootDir, '.ai-factory/rules/generated/openspec-base.md'),
      readText(rootDir, '.ai-factory/rules/generated/index.json')
    ]);
    assert.equal(repeatedSync.ok, true, `Scenario B archived ${changeId} repeated sync should succeed.`);
    assert.equal(repeatedSync.generatedRules.operationCount, 0, `Scenario B archived ${changeId} repeated sync should plan no generated operations.`);
    assert.deepEqual(stableAfter, stableBefore, `Scenario B archived ${changeId} repeated sync should keep generated bytes stable.`);
  });

  it('blocks dirty done finalization until explicit dirty-state recording is requested', async () => {
    const rootDir = await createTempRoot();
    const changeId = 'dirty-done-recovery';
    const dirtyStatus = ' M README.md\n';
    const archiveCalls = [];

    await createOpenSpecConfig(rootDir);
    await createOauthFeatureChange(rootDir, changeId);
    await syncOpenSpecArtifacts({
      rootDir,
      changeId,
      detectOpenSpec: async () => availableCliDetection(),
      validateOpenSpecChange: async (id) => validationResult(id),
      getOpenSpecStatus: async (id) => statusResult(id),
      timestamp: '2026-05-05T03-00-00-000Z'
    });
    await buildVerificationContext({
      rootDir,
      changeId,
      detectOpenSpec: async () => availableCliDetection(),
      validateOpenSpecChange: async (id) => validationResult(id),
      getOpenSpecStatus: async (id) => statusResult(id)
    });
    await writeFixture(rootDir, `.ai-factory/qa/${changeId}/verify.md`, passVerifyMarkdown(changeId));
    await writeRulesGateEvidence(rootDir, changeId);
    await writePassingCoverageEvidence(rootDir, changeId);

    const blocked = await finalizeOpenSpecChange({
      rootDir,
      changeId,
      detectOpenSpec: async () => availableCliDetection(),
      validateOpenSpecChange: async (id) => validationResult(id),
      getOpenSpecStatus: async (id) => statusResult(id),
      gitStatus: async () => ({ exitCode: 0, stdout: dirtyStatus, stderr: '' }),
      archiveOpenSpecChange: async (requestedChangeId, options) => {
        archiveCalls.push({ changeId: requestedChangeId, options });
        return archiveResult(requestedChangeId);
      }
    });

    assert.equal(blocked.ok, false, 'Dirty workspace should block /aif-done by default.');
    assert.equal(blocked.readiness.checks.dirty_workspace, 'fail');
    assert.equal(
      blocked.readiness.suggested_next.command,
      `/aif-done ${changeId} --record-dirty-state`
    );
    assert.equal(archiveCalls.length, 0, 'Blocked dirty workspace must not archive.');

    const finalized = await finalizeOpenSpecChange({
      rootDir,
      changeId,
      recordDirtyState: true,
      skipSpecs: true,
      detectOpenSpec: async () => availableCliDetection(),
      validateOpenSpecChange: async (id) => validationResult(id),
      getOpenSpecStatus: async (id) => statusResult(id),
      gitStatus: async () => ({ exitCode: 0, stdout: dirtyStatus, stderr: '' }),
      archiveOpenSpecChange: async (requestedChangeId, options) => {
        archiveCalls.push({ changeId: requestedChangeId, options });
        return archiveResult(requestedChangeId);
      }
    });

    assert.equal(finalized.ok, true, 'Explicit dirty-state recording should let /aif-done finalize.');
    assert.equal(finalized.readiness.status, 'warn');
    assert.equal(finalized.readiness.checks.dirty_workspace, 'warn');
    assert.equal(finalized.archive.skipSpecs, true);
    assert.deepEqual(finalized.workingTree.entries, [' M README.md']);
    assert.deepEqual(
      archiveCalls.map((call) => [call.changeId, call.options.skipSpecs]),
      [[changeId, true]]
    );
  });

  it('refuses done finalization before missing, failed, or pending verify gates can archive', async () => {
    for (const [caseName, setupEvidence, expectedCode] of [
      ['missing verify evidence', async () => {}, 'verification-evidence-missing'],
      ['failed verify gate evidence', async (rootDir, changeId) => {
        await writeVerificationEvidence(changeId, {
          validation: validationResult(changeId, { ok: false }),
          status: null,
          generatedRules: [],
          shouldRunCodeVerification: false,
          errors: [
            {
              code: 'openspec-validation-failed',
              message: 'Injected validation failure.'
            }
          ],
          warnings: []
        }, { rootDir });
      }, 'verification-not-passed'],
      ['pending verify evidence', async (rootDir, changeId) => {
        await writeVerificationEvidence(changeId, {
          validation: validationResult(changeId),
          status: statusResult(changeId),
          generatedRules: [],
          shouldRunCodeVerification: true,
          warnings: [],
          errors: []
        }, { rootDir });
      }, 'verification-ambiguous']
    ]) {
      const rootDir = await createTempRoot();
      const changeId = `done-gate-${caseName.replaceAll(' ', '-')}`;
      let archiveCalls = 0;
      await createOpenSpecConfig(rootDir);
      await createOauthFeatureChange(rootDir, changeId);
      await setupEvidence(rootDir, changeId);

      const finalized = await finalizeOpenSpecChange({
        rootDir,
        changeId,
        detectOpenSpec: async () => availableCliDetection(),
        gitStatus: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
        archiveOpenSpecChange: async () => {
          archiveCalls += 1;
          return archiveResult(changeId);
        }
      });

      assert.equal(finalized.ok, false, `Scenario B done gate should reject ${caseName}.`);
      assert.equal(finalized.errors[0].code, expectedCode, `Scenario B done gate should report ${expectedCode}.`);
      assert.equal(archiveCalls, 0, `Scenario B done gate must not archive for ${caseName}.`);
    }
  });
});

describe('OpenSpec workflow smoke: docs and prompt alignment', () => {
  it('keeps high-signal add-feature workflow commands visible in docs', async () => {
    const readme = await readFile(path.join(REPO_ROOT, 'README.md'), 'utf8');
    const usage = await readFile(path.join(REPO_ROOT, 'docs', 'usage.md'), 'utf8');

    for (const [label, source] of [
      ['README.md', readme],
      ['docs/usage.md', usage]
    ]) {
      for (const fragment of [
        '/aif-mode sync --change add-oauth-login',
        '/aif-verify add-oauth-login',
        '/aif-done add-oauth-login',
        '/aif-mode sync',
        '/aif-commit'
      ]) {
        assert.ok(source.includes(fragment), `${label} should keep workflow command fragment ${fragment}.`);
      }
    }
  });
});
