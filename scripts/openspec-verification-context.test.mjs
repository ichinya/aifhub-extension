// openspec-verification-context.test.mjs - tests for OpenSpec verify runtime context
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  buildVerificationContext,
  readLatestVerificationEvidence,
  runOpenSpecVerification,
  summarizeOpenSpecValidation,
  writeVerificationEvidence
} from './openspec-verification-context.mjs';

const tempRoots = [];

async function createTempRoot() {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'aifhub-openspec-verify-'));
  tempRoots.push(rootDir);
  return rootDir;
}

async function writeFixture(rootDir, relativePath, content) {
  const targetPath = path.join(rootDir, ...relativePath.split('/'));
  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeFile(targetPath, content, 'utf8');
  return targetPath;
}

async function createOpenSpecChange(rootDir, changeId = 'add-oauth') {
  await writeFixture(rootDir, `openspec/changes/${changeId}/proposal.md`, '# Proposal\n');
  await writeFixture(rootDir, `openspec/changes/${changeId}/design.md`, '# Design\n');
  await writeFixture(rootDir, `openspec/changes/${changeId}/tasks.md`, '# Tasks\n\n- [ ] Implement\n');
  await writeFixture(rootDir, `openspec/changes/${changeId}/specs/auth/spec.md`, '# Auth Delta\n');
  await writeFixture(rootDir, 'openspec/specs/auth/spec.md', '# Auth Base\n');
}

async function createGeneratedRules(rootDir, changeId = 'add-oauth') {
  await writeFixture(rootDir, '.ai-factory/rules/generated/openspec-base.md', '# Base Rules\n');
  await writeFixture(rootDir, `.ai-factory/rules/generated/openspec-change-${changeId}.md`, '# Change Rules\n');
  await writeFixture(rootDir, `.ai-factory/rules/generated/openspec-merged-${changeId}.md`, '# Merged Rules\n');
}

async function pathExists(targetPath) {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function readJson(targetPath) {
  return JSON.parse(await readFile(targetPath, 'utf8'));
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

function validationResult(overrides = {}) {
  return {
    ok: overrides.ok ?? true,
    command: 'openspec',
    args: [
      'validate',
      'add-oauth',
      '--type',
      'change',
      '--strict',
      '--json',
      '--no-interactive',
      '--no-color'
    ],
    exitCode: overrides.exitCode ?? 0,
    stdout: overrides.stdout ?? '{"valid":true}',
    stderr: overrides.stderr ?? '',
    json: Object.hasOwn(overrides, 'json') ? overrides.json : { valid: true },
    jsonParseError: Object.hasOwn(overrides, 'jsonParseError') ? overrides.jsonParseError : null,
    error: Object.hasOwn(overrides, 'error') ? overrides.error : null
  };
}

function statusResult(overrides = {}) {
  return {
    ok: overrides.ok ?? true,
    command: 'openspec',
    args: ['status', '--change', 'add-oauth', '--json', '--no-color'],
    exitCode: overrides.exitCode ?? 0,
    stdout: overrides.stdout ?? '{"change":"add-oauth"}',
    stderr: overrides.stderr ?? '',
    json: Object.hasOwn(overrides, 'json') ? overrides.json : { change: 'add-oauth' },
    jsonParseError: Object.hasOwn(overrides, 'jsonParseError') ? overrides.jsonParseError : null,
    error: Object.hasOwn(overrides, 'error') ? overrides.error : null
  };
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((rootDir) => rm(rootDir, {
    recursive: true,
    force: true
  })));
});

describe('OpenSpec verification context API', () => {
  it('exports the required public functions', () => {
    for (const fn of [
      buildVerificationContext,
      runOpenSpecVerification,
      writeVerificationEvidence,
      readLatestVerificationEvidence,
      summarizeOpenSpecValidation
    ]) {
      assert.equal(typeof fn, 'function', 'verification context public API should export functions');
    }
  });

  it('builds a passing verification context and writes QA evidence', async () => {
    const rootDir = await createTempRoot();
    await createOpenSpecChange(rootDir);
    await createGeneratedRules(rootDir);

    const result = await buildVerificationContext({
      rootDir,
      changeId: 'add-oauth',
      detectOpenSpec: async () => availableCliDetection(),
      validateOpenSpecChange: async () => validationResult(),
      getOpenSpecStatus: async () => statusResult()
    });

    assert.equal(result.ok, true, 'valid OpenSpec validation should pass verification context');
    assert.equal(result.mode, 'openspec-native');
    assert.equal(result.changeId, 'add-oauth');
    assert.equal(result.shouldRunCodeVerification, true, 'valid validation should allow code verification');
    assert.equal(result.openspec.validation.ok, true);
    assert.equal(result.openspec.status.ok, true);
    assert.deepEqual(result.canonicalArtifacts.baseSpecs.map((item) => item.path), [
      'openspec/specs/auth/spec.md'
    ]);
    assert.deepEqual(result.canonicalArtifacts.deltaSpecs.map((item) => item.path), [
      'openspec/changes/add-oauth/specs/auth/spec.md'
    ]);
    assert.deepEqual(result.generatedRules.map((item) => item.path), [
      '.ai-factory/rules/generated/openspec-merged-add-oauth.md',
      '.ai-factory/rules/generated/openspec-change-add-oauth.md',
      '.ai-factory/rules/generated/openspec-base.md'
    ]);
    assert.ok(
      result.qaEvidence.files.includes('.ai-factory/qa/add-oauth/openspec-validation.json'),
      'verification context should record validation evidence under QA path'
    );

    const validationEvidencePath = path.join(rootDir, '.ai-factory', 'qa', 'add-oauth', 'openspec-validation.json');
    const statusEvidencePath = path.join(rootDir, '.ai-factory', 'qa', 'add-oauth', 'openspec-status.json');
    const verifyPath = path.join(rootDir, '.ai-factory', 'qa', 'add-oauth', 'verify.md');

    assert.equal(await pathExists(validationEvidencePath), true, 'validation evidence JSON should be written');
    assert.equal(await pathExists(statusEvidencePath), true, 'status evidence JSON should be written');
    assert.equal(await pathExists(verifyPath), true, 'verify.md summary should be written');
    assert.equal(await pathExists(path.join(rootDir, 'openspec', 'changes', 'add-oauth', 'verify.md')), false);
    assert.equal(await pathExists(path.join(rootDir, '.ai-factory', 'plans', 'add-oauth')), false);

    const validationEvidence = await readJson(validationEvidencePath);
    assert.equal(validationEvidence.changeId, 'add-oauth');
    assert.deepEqual(validationEvidence.parsedJson, { valid: true });
    assert.equal(validationEvidence.rawStdoutPath, '.ai-factory/qa/add-oauth/raw/openspec-validate.stdout');
    assert.equal(validationEvidence.rawStderrPath, '.ai-factory/qa/add-oauth/raw/openspec-validate.stderr');
    assert.match(await readFile(verifyPath, 'utf8'), /Code verification: PENDING/);
  });

  it('uses injected active-change resolver and runtime layout hooks', async () => {
    const rootDir = await createTempRoot();
    const cwd = path.join(rootDir, 'workspace');
    const stateDir = path.join('.ai-factory', 'custom-state');
    const qaDir = path.join('.ai-factory', 'custom-qa');
    const layoutStatePath = path.join(rootDir, '.ai-factory', 'custom-state', 'add-oauth');
    const layoutQaPath = path.join(rootDir, '.ai-factory', 'custom-qa', 'add-oauth');
    const calls = {
      resolveActiveChange: [],
      ensureRuntimeLayout: []
    };

    await createOpenSpecChange(rootDir);
    await createGeneratedRules(rootDir);

    const result = await buildVerificationContext({
      rootDir,
      cwd,
      changeId: 'add-oauth',
      stateDir,
      qaDir,
      getCurrentBranch: async () => 'feat/add-oauth',
      resolveActiveChange: async (options) => {
        calls.resolveActiveChange.push(options);

        return {
          ok: true,
          changeId: options.changeId,
          source: 'injected-resolver',
          changePath: path.join(rootDir, 'openspec', 'changes', options.changeId),
          statePath: path.join(rootDir, '.ai-factory', 'resolver-state', options.changeId),
          qaPath: path.join(rootDir, '.ai-factory', 'resolver-qa', options.changeId),
          candidates: [options.changeId],
          warnings: [
            {
              code: 'resolver-hook-used',
              message: 'Injected resolver was used.'
            }
          ],
          errors: []
        };
      },
      ensureRuntimeLayout: async (changeId, options) => {
        calls.ensureRuntimeLayout.push({
          changeId,
          options
        });

        return {
          ok: true,
          changeId,
          statePath: layoutStatePath,
          qaPath: layoutQaPath,
          created: [],
          preserved: []
        };
      },
      detectOpenSpec: async () => availableCliDetection(),
      validateOpenSpecChange: async () => validationResult(),
      getOpenSpecStatus: async () => statusResult()
    });

    assert.equal(result.ok, true);
    assert.equal(result.resolver.source, 'injected-resolver');
    assert.equal(result.paths.state, layoutStatePath, 'context should use the injected layout state path');
    assert.equal(result.paths.qa, layoutQaPath, 'context should write QA evidence through the injected layout path');
    assert.deepEqual(
      calls.resolveActiveChange,
      [
        {
          rootDir,
          cwd,
          changeId: 'add-oauth',
          getCurrentBranch: calls.resolveActiveChange[0].getCurrentBranch
        }
      ],
      'resolver hook should receive root, cwd, explicit change id, and branch hook'
    );
    assert.equal(typeof calls.resolveActiveChange[0].getCurrentBranch, 'function');
    assert.equal(calls.ensureRuntimeLayout.length, 1, 'runtime layout hook should be called once');
    assert.equal(calls.ensureRuntimeLayout[0].changeId, 'add-oauth');
    assert.deepEqual(
      calls.ensureRuntimeLayout[0].options,
      {
        rootDir,
        cwd,
        stateDir,
        qaDir
      },
      'runtime layout hook should receive configured runtime paths'
    );
    assert.ok(
      result.warnings.some((warning) => warning.code === 'resolver-hook-used'),
      'context should preserve diagnostics returned by the injected resolver'
    );
    assert.equal(
      await pathExists(path.join(layoutQaPath, 'openspec-validation.json')),
      true,
      'validation evidence should be written under the injected QA layout path'
    );
  });

  it('fails fast on invalid validation and persists parsed non-zero stdout JSON', async () => {
    const rootDir = await createTempRoot();
    await createOpenSpecChange(rootDir);

    const result = await runOpenSpecVerification('add-oauth', {
      rootDir,
      detectOpenSpec: async () => availableCliDetection(),
      validateOpenSpecChange: async () => validationResult({
        ok: false,
        exitCode: 1,
        stdout: '{"valid":false,"errors":["bad spec"]}',
        stderr: 'validation failed',
        json: null,
        error: {
          code: 'non-zero-exit',
          message: 'OpenSpec command failed with exit code 1.'
        }
      }),
      getOpenSpecStatus: async () => statusResult()
    });

    assert.equal(result.ok, false, 'invalid OpenSpec validation should fail context');
    assert.equal(result.shouldRunCodeVerification, false, 'invalid validation should stop code verification');
    assert.equal(result.errors[0].code, 'openspec-validation-failed');
    assert.deepEqual(result.openspec.validation.parsedJson, {
      valid: false,
      errors: ['bad spec']
    });
    assert.equal(
      await readFile(path.join(rootDir, '.ai-factory', 'qa', 'add-oauth', 'raw', 'openspec-validate.stderr'), 'utf8'),
      'validation failed'
    );

    const validationEvidence = await readJson(path.join(rootDir, '.ai-factory', 'qa', 'add-oauth', 'openspec-validation.json'));
    assert.deepEqual(validationEvidence.parsedJson, {
      valid: false,
      errors: ['bad spec']
    });
  });

  it('uses degraded missing-CLI mode unless strict config requires CLI', async () => {
    const rootDir = await createTempRoot();
    await createOpenSpecChange(rootDir);

    const degraded = await buildVerificationContext({
      rootDir,
      changeId: 'add-oauth',
      detectOpenSpec: async () => missingCliDetection()
    });

    assert.equal(degraded.ok, true, 'missing CLI should degrade by default');
    assert.equal(degraded.shouldRunCodeVerification, true, 'default missing CLI should allow code verification');
    assert.ok(
      degraded.warnings.some((warning) => warning.code === 'openspec-cli-unavailable'),
      'default missing CLI should warn with openspec-cli-unavailable'
    );

    await writeFixture(rootDir, '.ai-factory/config.yaml', [
      'aifhub:',
      '  openspec:',
      '    requireCliForVerify: "true" # enforce strict verify'
    ].join('\n'));

    const strict = await buildVerificationContext({
      rootDir,
      changeId: 'add-oauth',
      detectOpenSpec: async () => missingCliDetection()
    });

    assert.equal(strict.ok, false, 'strict missing CLI should fail verification context');
    assert.equal(strict.shouldRunCodeVerification, false, 'strict missing CLI should stop code verification');
    assert.equal(strict.errors[0].code, 'openspec-cli-required');
  });

  it('skips validation when config disables validateOnVerify', async () => {
    const rootDir = await createTempRoot();
    await createOpenSpecChange(rootDir);
    let validateCalls = 0;
    await writeFixture(rootDir, '.ai-factory/config.yaml', [
      'aifhub:',
      '  openspec:',
      "    validateOnVerify: 'false' # caller disabled OpenSpec validation",
      '    requireCliForVerify: false'
    ].join('\n'));

    const result = await buildVerificationContext({
      rootDir,
      changeId: 'add-oauth',
      detectOpenSpec: async () => availableCliDetection(),
      validateOpenSpecChange: async () => {
        validateCalls += 1;
        return validationResult();
      }
    });

    assert.equal(result.ok, true);
    assert.equal(result.config.validateOnVerify, false);
    assert.equal(result.shouldRunCodeVerification, true);
    assert.equal(validateCalls, 0, 'validateOpenSpecChange should not run when validateOnVerify is false');
    assert.equal(result.openspec.validation.skipped, true);
    assert.ok(
      result.warnings.some((warning) => warning.code === 'openspec-validation-disabled'),
      'validateOnVerify false should record a warning/config note'
    );

    const validationEvidence = await readJson(path.join(rootDir, '.ai-factory', 'qa', 'add-oauth', 'openspec-validation.json'));
    assert.equal(validationEvidence.ok, true);
    assert.equal(validationEvidence.skipped, true);
    assert.equal(validationEvidence.reason, 'validateOnVerify-disabled');
    assert.equal(
      validationEvidence.message,
      'OpenSpec validation skipped because aifhub.openspec.validateOnVerify is false.'
    );
    assert.equal(validationEvidence.rawStdoutPath, null);
    assert.equal(validationEvidence.rawStderrPath, null);

    const verifySummary = await readFile(path.join(rootDir, '.ai-factory', 'qa', 'add-oauth', 'verify.md'), 'utf8');
    assert.match(verifySummary, /OpenSpec validation: SKIPPED/);
  });

  it('skips status evidence when statusOnVerify is false', async () => {
    const rootDir = await createTempRoot();
    await createOpenSpecChange(rootDir);
    let statusCalls = 0;
    await writeFixture(rootDir, '.ai-factory/config.yaml', [
      'aifhub:',
      '  openspec:',
      '    validateOnVerify: true',
      '    statusOnVerify: false'
    ].join('\n'));

    const result = await buildVerificationContext({
      rootDir,
      changeId: 'add-oauth',
      detectOpenSpec: async () => availableCliDetection(),
      validateOpenSpecChange: async () => validationResult(),
      getOpenSpecStatus: async () => {
        statusCalls += 1;
        return statusResult();
      }
    });

    assert.equal(result.ok, true);
    assert.equal(result.config.statusOnVerify, false);
    assert.equal(statusCalls, 0);
    assert.equal(result.openspec.status, null);
    assert.equal(await pathExists(path.join(rootDir, '.ai-factory', 'qa', 'add-oauth', 'openspec-status.json')), false);

    const verifySummary = await readFile(path.join(rootDir, '.ai-factory', 'qa', 'add-oauth', 'verify.md'), 'utf8');
    assert.match(verifySummary, /OpenSpec status: SKIPPED/);
  });

  it('records invalid JSON output with raw stream paths and stops code verification', async () => {
    const rootDir = await createTempRoot();
    await createOpenSpecChange(rootDir);

    const result = await buildVerificationContext({
      rootDir,
      changeId: 'add-oauth',
      detectOpenSpec: async () => availableCliDetection(),
      validateOpenSpecChange: async () => validationResult({
        ok: false,
        stdout: 'not json',
        stderr: 'bad json',
        json: null,
        jsonParseError: {
          code: 'invalid-json',
          message: 'OpenSpec command returned invalid JSON.'
        },
        error: {
          code: 'invalid-json',
          message: 'OpenSpec command returned invalid JSON.'
        }
      })
    });

    assert.equal(result.ok, false);
    assert.equal(result.shouldRunCodeVerification, false);
    assert.equal(result.openspec.validation.jsonParseError.code, 'invalid-json');

    const validationEvidence = await readJson(path.join(rootDir, '.ai-factory', 'qa', 'add-oauth', 'openspec-validation.json'));
    assert.equal(validationEvidence.jsonParseError.code, 'invalid-json');
    assert.equal(validationEvidence.rawStdoutPath, '.ai-factory/qa/add-oauth/raw/openspec-validate.stdout');
    assert.equal(
      await readFile(path.join(rootDir, '.ai-factory', 'qa', 'add-oauth', 'raw', 'openspec-validate.stdout'), 'utf8'),
      'not json'
    );
  });

  it('loads latest verification evidence without requiring optional status output', async () => {
    const rootDir = await createTempRoot();
    await createOpenSpecChange(rootDir);
    await writeVerificationEvidence('add-oauth', {
      validation: validationResult(),
      status: null,
      generatedRules: [],
      shouldRunCodeVerification: true,
      warnings: [],
      errors: []
    }, {
      rootDir
    });

    const latest = await readLatestVerificationEvidence('add-oauth', { rootDir });

    assert.equal(latest.ok, true);
    assert.equal(latest.validation.changeId, 'add-oauth');
    assert.equal(latest.status, null, 'missing optional status output should not throw');
    assert.equal(latest.verify.exists, true);
  });

  it('rejects QA evidence writes outside QA runtime paths', async () => {
    const rootDir = await createTempRoot();
    await createOpenSpecChange(rootDir);

    await assert.rejects(
      () => buildVerificationContext({
        rootDir,
        changeId: 'add-oauth',
        qaDir: 'openspec/changes',
        detectOpenSpec: async () => availableCliDetection(),
        validateOpenSpecChange: async () => validationResult()
      }),
      /QA evidence path/
    );
    assert.equal(await pathExists(path.join(rootDir, 'openspec', 'changes', 'add-oauth', 'openspec-validation.json')), false);

    await assert.rejects(
      () => writeVerificationEvidence('add-oauth', {
        validation: validationResult()
      }, {
        rootDir,
        qaDir: '.ai-factory/plans'
      }),
      /QA evidence path/
    );
    assert.equal(await pathExists(path.join(rootDir, '.ai-factory', 'plans', 'add-oauth', 'openspec-validation.json')), false);
  });

  it('summarizes validation status and next steps', () => {
    const failed = summarizeOpenSpecValidation({
      ok: false,
      changeId: 'add-oauth',
      shouldRunCodeVerification: false,
      openspec: {
        validation: {
          ok: false
        },
        status: null
      },
      warnings: [],
      errors: [
        {
          code: 'openspec-validation-failed',
          message: 'OpenSpec validation failed.'
        }
      ]
    });

    assert.match(failed, /OpenSpec validation: FAIL/);
    assert.match(failed, /Code verification: BLOCKED/);
    assert.match(failed, /Next step: \/aif-fix add-oauth/);
  });
});
