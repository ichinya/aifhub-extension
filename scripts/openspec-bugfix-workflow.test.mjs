// openspec-bugfix-workflow.test.mjs - workflow smoke coverage for OpenSpec bug-fix paths
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { syncOpenSpecArtifacts } from './aif-artifact-sync.mjs';
import {
  buildFixContext,
  buildImplementationContext,
  writeExecutionTrace,
  writeFixTrace
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const tempRoots = [];

async function createTempRoot() {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'aifhub-bugfix-smoke-'));
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

function statusResult(changeId) {
  return {
    ok: true,
    command: 'openspec',
    args: ['status', '--change', changeId, '--json', '--no-color'],
    exitCode: 0,
    stdout: JSON.stringify({ change: changeId }),
    stderr: '',
    json: { change: changeId },
    jsonParseError: null,
    error: null
  };
}

function archiveResult(changeId) {
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

function passVerifyMarkdown(changeId) {
  return [
    `# Verify: ${changeId}`,
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
  await writeFixture(rootDir, 'openspec/config.yaml', 'project: bugfix-smoke\n');
}

async function createBugFixChange(rootDir, changeId, requirementName = 'Login redirect fix') {
  await writeFixture(rootDir, 'openspec/specs/auth/spec.md', [
    '# Auth',
    '',
    '## Requirements',
    '',
    '### Requirement: Login redirect',
    '',
    'The system MUST redirect users after successful login.',
    ''
  ].join('\n'));
  await writeFixture(rootDir, `openspec/changes/${changeId}/proposal.md`, `# Proposal: ${requirementName}\n`);
  await writeFixture(rootDir, `openspec/changes/${changeId}/design.md`, `# Design: ${requirementName}\n`);
  await writeFixture(rootDir, `openspec/changes/${changeId}/tasks.md`, [
    '# Tasks',
    '',
    '- [ ] Fix login redirect behavior',
    ''
  ].join('\n'));
  await writeFixture(rootDir, `openspec/changes/${changeId}/specs/auth/spec.md`, [
    '# Auth Delta',
    '',
    '## MODIFIED Requirements',
    '',
    '### Requirement: Login redirect',
    '',
    'The system MUST redirect users to their intended destination after successful login.',
    '',
    '#### Scenario: user returns to intended URL',
    '',
    '- GIVEN a user started login from a protected URL',
    '- WHEN login succeeds',
    '- THEN the system redirects the user to that protected URL.',
    ''
  ].join('\n'));
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

describe('OpenSpec bug-fix workflow smoke', () => {
  it('models a planned bug fix as a normal canonical OpenSpec change', async () => {
    const rootDir = await createTempRoot();
    const changeId = 'fix-login-redirect';
    await createOpenSpecConfig(rootDir);
    await createBugFixChange(rootDir, changeId);

    const sync = await syncOpenSpecArtifacts({
      rootDir,
      changeId,
      detectOpenSpec: async () => availableCliDetection(),
      validateOpenSpecChange: async (id) => validationResult(id),
      getOpenSpecStatus: async (id) => statusResult(id),
      timestamp: '2026-05-05T03-00-00-000Z'
    });
    assert.equal(sync.ok, true, 'Path C1 planned bug fix /aif-mode sync --change should pass.');
    assert.match(
      await readText(rootDir, '.ai-factory/rules/generated/openspec-change-fix-login-redirect.md'),
      /Requirement: Login redirect/,
      'Path C1 planned bug fix should compile change generated rules.'
    );

    const implementation = await buildImplementationContext({
      rootDir,
      changeId,
      detectOpenSpec: async () => missingCliDetection()
    });
    assert.equal(implementation.ok, true, 'Path C1 planned bug fix should load implementation context without real CLI.');
    await writeExecutionTrace(changeId, {
      summary: 'Loaded planned bug-fix workflow smoke context.',
      canonicalArtifactsRead: [`openspec/changes/${changeId}/tasks.md`],
      generatedRulesRead: sync.generatedRules.files.map((file) => file.relativePath),
      changedFiles: ['scripts/openspec-bugfix-workflow.test.mjs'],
      nextStep: `/aif-verify ${changeId}`
    }, {
      rootDir,
      runId: 'planned-bugfix'
    });

    const verification = await buildVerificationContext({
      rootDir,
      changeId,
      detectOpenSpec: async () => availableCliDetection(),
      validateOpenSpecChange: async (id) => validationResult(id),
      getOpenSpecStatus: async (id) => statusResult(id)
    });
    assert.equal(verification.ok, true, 'Path C1 planned bug fix /aif-verify context should write QA evidence.');
    await writeFile(
      path.join(rootDir, '.ai-factory', 'qa', changeId, 'verify.md'),
      passVerifyMarkdown(changeId),
      'utf8'
    );

    const { finalized, archiveCalls } = await finalizeWithArchive(rootDir, changeId);

    assert.equal(finalized.ok, true, 'Path C1 planned bug fix /aif-done should finalize passed verification.');
    assert.deepEqual(
      archiveCalls.map((call) => call.changeId),
      [changeId],
      'Path C1 planned bug fix should archive through injected OpenSpec runner.'
    );
    assert.equal(await pathExists(rootDir, '.ai-factory/qa/fix-login-redirect/done.md'), true);
    assert.equal(await pathExists(rootDir, '.ai-factory/state/fix-login-redirect/final-summary.md'), true);
    assert.equal(
      await pathExists(rootDir, '.ai-factory/plans/fix-login-redirect/task.md'),
      false,
      'Path C1 planned bug fix must not require legacy plan task.md.'
    );
  });

  it('models /aif-fix after failed verification without writing QA verdicts or archive evidence', async () => {
    const rootDir = await createTempRoot();
    const changeId = 'fix-oauth-callback-finding';
    await createOpenSpecConfig(rootDir);
    await createBugFixChange(rootDir, changeId, 'OAuth callback finding fix');
    await writeVerificationEvidence(changeId, {
      validation: validationResult(changeId, { ok: false }),
      status: null,
      generatedRules: [],
      shouldRunCodeVerification: false,
      errors: [
        {
          code: 'oauth-callback-regression',
          message: 'OAuth callback verification failed.'
        }
      ],
      warnings: []
    }, {
      rootDir
    });
    const verifyBefore = await readText(rootDir, `.ai-factory/qa/${changeId}/verify.md`);

    const fixContext = await buildFixContext({
      rootDir,
      changeId,
      requireQaEvidence: true,
      detectOpenSpec: async () => missingCliDetection()
    });
    const fixTrace = await writeFixTrace(changeId, {
      summary: 'Applied selected QA finding for OAuth callback smoke.',
      canonicalArtifactsRead: [`openspec/changes/${changeId}/tasks.md`],
      generatedRulesRead: [],
      qaEvidenceRead: fixContext.qaEvidence.map((item) => item.path),
      regressionCheck: {
        command: 'node --test scripts/openspec-bugfix-workflow.test.mjs',
        inputs: 'OAuth callback finding fixture',
        environment: 'temporary OpenSpec workflow root'
      },
      preFixResult: {
        exitCode: 1,
        observed: 'oauth-callback-regression failed before the fix'
      },
      postFixResult: {
        exitCode: 0,
        observed: 'the identical OAuth callback check passed after the fix'
      },
      fallbackDecision: 'Not applicable; the selected finding reproduced.',
      changedFiles: ['scripts/openspec-bugfix-workflow.test.mjs'],
      nextStep: `/aif-verify ${changeId}`
    }, {
      rootDir,
      runId: 'post-verify-fix'
    });

    assert.equal(fixContext.ok, true, 'Path C2 /aif-fix should load context when QA evidence exists.');
    assert.ok(
      fixContext.qaEvidence.some((item) => item.path === `.ai-factory/qa/${changeId}/verify.md`),
      'Path C2 /aif-fix should read existing verify.md QA evidence.'
    );
    assert.equal(
      fixTrace.relativePath,
      `.ai-factory/state/${changeId}/fixes/post-verify-fix.md`,
      'Path C2 /aif-fix should write fix trace under runtime state fixes.'
    );
    const fixTraceContent = await readText(rootDir, fixTrace.relativePath);
    for (const expected of [
      '## QA evidence read',
      `.ai-factory/qa/${changeId}/verify.md`,
      '## Regression check',
      'node --test scripts/openspec-bugfix-workflow.test.mjs',
      '## Pre-fix result',
      '"exitCode": 1',
      'failed before the fix',
      '## Post-fix result',
      '"exitCode": 0',
      'passed after the fix',
      '## Fallback decision',
      'Not applicable; the selected finding reproduced.'
    ]) {
      assert.ok(fixTraceContent.includes(expected), `Path C2 fix trace should include ${expected}.`);
    }
    assert.equal(
      await readText(rootDir, `.ai-factory/qa/${changeId}/verify.md`),
      verifyBefore,
      'Path C2 /aif-fix must preserve existing verify.md QA evidence.'
    );
    assert.equal(
      await pathExists(rootDir, `.ai-factory/qa/${changeId}/done.md`),
      false,
      'Path C2 /aif-fix must not write done QA verdicts.'
    );
    assert.equal(
      await pathExists(rootDir, `.ai-factory/qa/${changeId}/openspec-archive.json`),
      false,
      'Path C2 /aif-fix must not archive.'
    );
    assert.equal(
      await pathExists(rootDir, `.ai-factory/plans/${changeId}/task.md`),
      false,
      'Path C2 /aif-fix must not create legacy plan artifacts.'
    );
    assert.deepEqual(
      await listFiles(rootDir, `openspec/changes/${changeId}`),
      [
        `openspec/changes/${changeId}/design.md`,
        `openspec/changes/${changeId}/proposal.md`,
        `openspec/changes/${changeId}/specs/auth/spec.md`,
        `openspec/changes/${changeId}/tasks.md`
      ],
      'Path C2 /aif-fix must not leak runtime files into canonical change artifacts.'
    );
  });
});

describe('OpenSpec bug-fix workflow alignment', () => {
  it('keeps docs and fix prompt routed back to /aif-verify', async () => {
    const usage = await readFile(path.join(REPO_ROOT, 'docs', 'usage.md'), 'utf8');
    const fixPrompt = await readFile(path.join(REPO_ROOT, 'injections', 'core', 'aif-fix-plan-folder.md'), 'utf8');
    const contextPolicy = await readFile(path.join(REPO_ROOT, 'docs', 'context-loading-policy.md'), 'utf8');

    for (const [label, source] of [
      ['docs/usage.md', usage],
      ['docs/context-loading-policy.md', contextPolicy],
      ['injections/core/aif-fix-plan-folder.md', fixPrompt]
    ]) {
      assert.ok(
        source.includes('/aif-fix') && source.includes('/aif-verify <change-id>'),
        `${label} should keep /aif-fix routed back to /aif-verify <change-id>.`
      );
    }
    assert.ok(
      usage.includes('/aif-plan full "fix <bug description>"'),
      'docs/usage.md should keep planned bug fixes routed through /aif-plan full.'
    );
  });
});
