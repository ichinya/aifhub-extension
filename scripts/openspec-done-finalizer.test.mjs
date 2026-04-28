// openspec-done-finalizer.test.mjs - tests for OpenSpec done/finalization runtime
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  archiveChangeWithOpenSpec,
  assertVerificationPassed,
  buildDoneContext,
  detectWorkingTreeState,
  finalizeOpenSpecChange,
  summarizeDoneResult,
  writeDoneSummary
} from './openspec-done-finalizer.mjs';

const tempRoots = [];

async function createTempRoot() {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'aifhub-openspec-done-'));
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
  await writeFixture(rootDir, `openspec/changes/${changeId}/tasks.md`, '# Tasks\n\n- [x] Implement\n');
  await writeFixture(rootDir, `openspec/changes/${changeId}/specs/auth/spec.md`, '# Auth Delta\n');
  await writeFixture(rootDir, 'openspec/specs/auth/spec.md', '# Auth Base\n');
}

async function createRuntimeEvidence(rootDir, changeId = 'add-oauth') {
  await writeFixture(rootDir, `.ai-factory/state/${changeId}/implementation/run-001.md`, '# Implementation Trace\n');
  await writeFixture(rootDir, `.ai-factory/state/${changeId}/fixes/fix-001.md`, '# Fix Trace\n');
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
    canArchive: true,
    canValidate: true,
    version: '1.3.1',
    command: 'openspec',
    reason: null,
    errors: []
  };
}

function missingCliDetection() {
  return {
    available: false,
    canArchive: false,
    canValidate: false,
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

function archiveResult(overrides = {}) {
  return {
    ok: overrides.ok ?? true,
    command: 'openspec',
    args: overrides.args ?? ['archive', 'add-oauth', '--yes', '--no-color'],
    exitCode: overrides.exitCode ?? 0,
    stdout: overrides.stdout ?? 'Archived add-oauth\n',
    stderr: overrides.stderr ?? '',
    json: null,
    jsonParseError: null,
    error: overrides.error ?? null
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
    json: overrides.json ?? { change: 'add-oauth' },
    jsonParseError: null,
    error: overrides.error ?? null
  };
}

function verificationEvidence(overrides = {}) {
  const codeState = overrides.codeState ?? 'PASS';
  const validationOk = overrides.validationOk ?? true;
  const verifyExists = overrides.verifyExists ?? true;
  const content = overrides.content ?? [
    '# Verify: add-oauth',
    '',
    '## AIF Verify Gate',
    '',
    'Verdict: PASS',
    `Code verification: ${codeState}`,
    ''
  ].join('\n');

  return {
    ok: overrides.ok ?? true,
    changeId: overrides.changeId ?? 'add-oauth',
    validation: overrides.validation ?? {
      changeId: 'add-oauth',
      ok: validationOk,
      skipped: false,
      error: validationOk ? null : {
        code: 'openspec-validation-failed',
        message: 'OpenSpec validation failed.'
      }
    },
    status: overrides.status ?? {
      changeId: 'add-oauth',
      ok: true
    },
    verify: {
      exists: verifyExists,
      path: '.ai-factory/qa/add-oauth/verify.md',
      content: verifyExists ? content : ''
    },
    warnings: overrides.warnings ?? [],
    errors: overrides.errors ?? []
  };
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((rootDir) => rm(rootDir, {
    recursive: true,
    force: true
  })));
});

describe('OpenSpec done finalizer API', () => {
  it('exports the required public functions', () => {
    for (const fn of [
      finalizeOpenSpecChange,
      buildDoneContext,
      assertVerificationPassed,
      archiveChangeWithOpenSpec,
      writeDoneSummary,
      detectWorkingTreeState,
      summarizeDoneResult
    ]) {
      assert.equal(typeof fn, 'function', 'done finalizer public API should export functions');
    }
  });

  it('builds context for an explicit change id and reads canonical/runtime evidence', async () => {
    const rootDir = await createTempRoot();
    await createOpenSpecChange(rootDir);
    await createRuntimeEvidence(rootDir);

    const context = await buildDoneContext({
      rootDir,
      changeId: 'add-oauth',
      detectOpenSpec: async () => availableCliDetection(),
      readLatestVerificationEvidence: async () => verificationEvidence()
    });

    assert.equal(context.ok, true);
    assert.equal(context.mode, 'openspec-native');
    assert.equal(context.changeId, 'add-oauth');
    assert.equal(context.verification.exists, true);
    assert.equal(context.verification.passed, true);
    assert.equal(context.openspec.available, true);
    assert.equal(context.openspec.canArchive, true);
    assert.deepEqual(context.canonicalArtifacts.deltaSpecs.map((item) => item.path), [
      'openspec/changes/add-oauth/specs/auth/spec.md'
    ]);
    assert.deepEqual(context.runtimeTraces.map((item) => item.path), [
      '.ai-factory/state/add-oauth/fixes/fix-001.md',
      '.ai-factory/state/add-oauth/implementation/run-001.md'
    ]);
    assert.deepEqual(context.generatedRules.map((item) => item.path), [
      '.ai-factory/rules/generated/openspec-merged-add-oauth.md',
      '.ai-factory/rules/generated/openspec-change-add-oauth.md',
      '.ai-factory/rules/generated/openspec-base.md'
    ]);
  });

  it('refuses missing, failed, and pending verification evidence', async () => {
    const missing = await assertVerificationPassed('add-oauth', {
      readLatestVerificationEvidence: async () => ({
        ok: false,
        changeId: 'add-oauth',
        validation: null,
        status: null,
        verify: { exists: false, path: null, content: '' },
        warnings: [],
        errors: []
      })
    });
    assert.equal(missing.ok, false);
    assert.equal(missing.errors[0].code, 'verification-evidence-missing');

    const failed = await assertVerificationPassed('add-oauth', {
      readLatestVerificationEvidence: async () => verificationEvidence({
        validationOk: false,
        content: '# Verify\n\nOpenSpec validation: FAIL\nCode verification: BLOCKED\n'
      })
    });
    assert.equal(failed.ok, false);
    assert.equal(failed.errors[0].code, 'verification-not-passed');

    const pending = await assertVerificationPassed('add-oauth', {
      readLatestVerificationEvidence: async () => verificationEvidence({
        codeState: 'PENDING',
        content: '# Verify\n\nOpenSpec validation: PASS\nCode verification: PENDING\n'
      })
    });
    assert.equal(pending.ok, false);
    assert.equal(pending.errors[0].code, 'verification-ambiguous');

    const passed = await assertVerificationPassed('add-oauth', {
      readLatestVerificationEvidence: async () => verificationEvidence()
    });
    assert.equal(passed.ok, true);
    assert.equal(passed.passed, true);
  });

  it('detects dirty working tree state and records it only when explicit', async () => {
    const clean = await detectWorkingTreeState({
      gitStatus: async () => ({ exitCode: 0, stdout: '', stderr: '' })
    });
    assert.equal(clean.ok, true);
    assert.equal(clean.dirty, false);

    const dirty = await detectWorkingTreeState({
      gitStatus: async () => ({ exitCode: 0, stdout: ' M openspec/changes/add-oauth/tasks.md\n', stderr: '' })
    });
    assert.equal(dirty.ok, false);
    assert.equal(dirty.dirty, true);
    assert.equal(dirty.errors[0].code, 'dirty-working-tree');
    assert.deepEqual(dirty.entries, [' M openspec/changes/add-oauth/tasks.md']);

    const recorded = await detectWorkingTreeState({
      recordDirtyState: true,
      gitStatus: async () => ({ exitCode: 0, stdout: ' M README.md\n', stderr: '' })
    });
    assert.equal(recorded.ok, true);
    assert.equal(recorded.dirty, true);
    assert.deepEqual(recorded.entries, [' M README.md']);

    const nonGit = await detectWorkingTreeState({
      gitStatus: async () => ({ exitCode: 128, stdout: '', stderr: 'not a git repository' })
    });
    assert.equal(nonGit.ok, true);
    assert.equal(nonGit.isGitRepo, false);
    assert.equal(nonGit.warnings[0].code, 'not-a-git-repository');
  });

  it('archives normal and skip-specs changes through OpenSpec runner and writes archive evidence', async () => {
    const rootDir = await createTempRoot();
    await createOpenSpecChange(rootDir);
    const calls = [];

    const normal = await archiveChangeWithOpenSpec('add-oauth', {
      rootDir,
      detectOpenSpec: async () => availableCliDetection(),
      getOpenSpecStatus: async () => statusResult(),
      archiveOpenSpecChange: async (changeId, options) => {
        calls.push({ changeId, options });
        return archiveResult();
      }
    });

    assert.equal(normal.ok, true);
    assert.equal(normal.archived, true);
    assert.equal(normal.skipSpecs, false);
    assert.equal(calls[0].changeId, 'add-oauth');
    assert.equal(calls[0].options.skipSpecs, undefined);

    const archiveEvidencePath = path.join(rootDir, '.ai-factory', 'qa', 'add-oauth', 'openspec-archive.json');
    const archiveEvidence = await readJson(archiveEvidencePath);
    assert.equal(archiveEvidence.archived, true);
    assert.equal(archiveEvidence.skipSpecs, false);
    assert.equal(archiveEvidence.rawStdoutPath, '.ai-factory/qa/add-oauth/raw/openspec-archive.stdout');
    assert.equal(
      await readFile(path.join(rootDir, '.ai-factory', 'qa', 'add-oauth', 'raw', 'openspec-archive.stdout'), 'utf8'),
      'Archived add-oauth\n'
    );

    await archiveChangeWithOpenSpec('add-oauth', {
      rootDir,
      skipSpecs: true,
      detectOpenSpec: async () => availableCliDetection(),
      archiveOpenSpecChange: async (changeId, options) => {
        calls.push({ changeId, options });
        return archiveResult({
          args: ['archive', 'add-oauth', '--yes', '--skip-specs', '--no-color']
        });
      }
    });

    assert.equal(calls[1].changeId, 'add-oauth');
    assert.equal(calls[1].options.skipSpecs, true);
    assert.equal((await readJson(archiveEvidencePath)).skipSpecs, true);
  });

  it('requires CLI for archive but allows explicit dry-run summary-only mode', async () => {
    const rootDir = await createTempRoot();
    let archiveCalls = 0;

    const required = await archiveChangeWithOpenSpec('add-oauth', {
      rootDir,
      detectOpenSpec: async () => missingCliDetection(),
      archiveOpenSpecChange: async () => {
        archiveCalls += 1;
        return archiveResult();
      }
    });

    assert.equal(required.ok, false);
    assert.equal(required.archived, false);
    assert.equal(required.errors[0].code, 'openspec-cli-required-for-archive');
    assert.equal(archiveCalls, 0);

    const dryRun = await archiveChangeWithOpenSpec('add-oauth', {
      rootDir,
      skipArchive: true,
      detectOpenSpec: async () => missingCliDetection()
    });

    assert.equal(dryRun.ok, true);
    assert.equal(dryRun.archived, false);
    assert.equal(dryRun.status, 'DRY-RUN');
    assert.ok(
      dryRun.warnings.some((warning) => warning.code === 'archive-skipped'),
      'dry-run mode should explicitly report skipped archive'
    );
  });

  it('handles already archived changes explicitly and does not re-archive', async () => {
    const rootDir = await createTempRoot();
    await writeFixture(rootDir, 'openspec/changes/archive/add-oauth/proposal.md', '# Archived\n');
    await writeFixture(rootDir, '.ai-factory/qa/add-oauth/done.md', '# Done: add-oauth\n');
    await writeFixture(rootDir, '.ai-factory/state/add-oauth/final-summary.md', '# Final Summary: add-oauth\n');

    const result = await finalizeOpenSpecChange({
      rootDir,
      changeId: 'add-oauth',
      detectOpenSpec: async () => availableCliDetection(),
      gitStatus: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      archiveOpenSpecChange: async () => {
        throw new Error('archive should not run for already archived changes');
      },
      readLatestVerificationEvidence: async () => verificationEvidence()
    });

    assert.equal(result.ok, false);
    assert.equal(result.errors[0].code, 'change-already-archived');
    assert.deepEqual(result.existingSummaries.map((summary) => summary.path), [
      '.ai-factory/qa/add-oauth/done.md',
      '.ai-factory/state/add-oauth/final-summary.md'
    ]);
  });

  it('finalizes passing changes, writes done summaries, and stays out of canonical/legacy paths', async () => {
    const rootDir = await createTempRoot();
    await createOpenSpecChange(rootDir);
    await createRuntimeEvidence(rootDir);

    const result = await finalizeOpenSpecChange({
      rootDir,
      changeId: 'add-oauth',
      detectOpenSpec: async () => availableCliDetection(),
      getOpenSpecStatus: async () => statusResult(),
      gitStatus: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      readLatestVerificationEvidence: async () => verificationEvidence(),
      archiveOpenSpecChange: async () => archiveResult()
    });

    assert.equal(result.ok, true);
    assert.equal(result.archive.archived, true);
    assert.match(result.commitMessage, /^feat: finalize add-oauth$/);
    assert.match(result.prSummary, /## OpenSpec/);
    assert.match(summarizeDoneResult(result), /Finalization status: PASS/);

    const donePath = path.join(rootDir, '.ai-factory', 'qa', 'add-oauth', 'done.md');
    const finalSummaryPath = path.join(rootDir, '.ai-factory', 'state', 'add-oauth', 'final-summary.md');
    assert.equal(await pathExists(donePath), true, 'done.md should be written under QA path');
    assert.equal(await pathExists(finalSummaryPath), true, 'final-summary.md should be written under state path');
    assert.match(await readFile(donePath, 'utf8'), /# Done: add-oauth/);
    assert.match(await readFile(donePath, 'utf8'), /Archived: yes/);
    assert.match(await readFile(finalSummaryPath, 'utf8'), /## Suggested PR summary/);
    assert.equal(await pathExists(path.join(rootDir, 'openspec', 'changes', 'add-oauth', 'done.md')), false);
    assert.equal(await pathExists(path.join(rootDir, '.ai-factory', 'plans', 'add-oauth')), false);
  });

  it('records dirty state and still writes summaries when explicitly allowed', async () => {
    const rootDir = await createTempRoot();
    await createOpenSpecChange(rootDir);

    const result = await finalizeOpenSpecChange({
      rootDir,
      changeId: 'add-oauth',
      allowDirty: true,
      detectOpenSpec: async () => availableCliDetection(),
      gitStatus: async () => ({ exitCode: 0, stdout: ' M README.md\n', stderr: '' }),
      readLatestVerificationEvidence: async () => verificationEvidence(),
      archiveOpenSpecChange: async () => archiveResult()
    });

    assert.equal(result.ok, true);
    assert.equal(result.workingTree.dirty, true);
    assert.deepEqual(result.workingTree.entries, [' M README.md']);
    assert.match(
      await readFile(path.join(rootDir, '.ai-factory', 'qa', 'add-oauth', 'done.md'), 'utf8'),
      /M README\.md/
    );
  });
});
