// openspec-done-finalizer.test.mjs - tests for OpenSpec done/finalization runtime
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  archiveChangeWithOpenSpec,
  assertCoverageAcceptable,
  assertRulesGateAcceptable,
  assertVerificationPassed,
  buildDoneContext,
  detectWorkingTreeState,
  finalizeOpenSpecChange,
  parseDoneFinalizerArgs,
  projectDoneFinalizerResult,
  runDoneFinalizerCommand,
  summarizeDoneResult,
  writeDoneSummary
} from './openspec-done-finalizer.mjs';
import {
  createGateResult,
  renderGateResultBlock
} from './aif-gate-result.mjs';
import {
  syncOpenSpecArtifacts
} from './aif-artifact-sync.mjs';
import {
  ROADMAP_LIFECYCLE_START_MARKER
} from './roadmap-change-lifecycle.mjs';

const tempRoots = [];
const DEFAULT_ROADMAP_PATH = '.ai-factory/ROADMAP.md';
const CUSTOM_ROADMAP_PATH = 'docs/project-roadmap.md';
const LINKED_PROPOSAL = `# Proposal: Add OAuth

## Roadmap Linkage

- Issues: https://github.com/ichinya/aifhub-extension/issues/88
- Milestone: none
- Roadmap item/slice: Workflow governance
- Rationale: Track local finalization independently from GitHub.
`;
const UNLINKED_PROPOSAL = `# Proposal: Add OAuth

## Roadmap Linkage

- Issues: none
- Milestone: none
- Roadmap item/slice: none
- Rationale: none
`;

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
  await syncOpenSpecArtifacts({
    rootDir,
    changeId,
    writeReport: false,
    detectOpenSpec: async () => missingCliDetection()
  });
  await writeRulesGateEvidence(rootDir, changeId);
}

async function createLinkedFinalizationFixture(rootDir, options = {}) {
  const roadmapPath = options.roadmapPath ?? CUSTOM_ROADMAP_PATH;
  await createOpenSpecChange(rootDir);
  await writeFixture(
    rootDir,
    'openspec/changes/add-oauth/proposal.md',
    options.proposalContent ?? LINKED_PROPOSAL
  );
  await createRuntimeEvidence(rootDir);
  await writeFixture(rootDir, '.ai-factory/config.yaml', [
    'aifhub:',
    '  artifactProtocol: openspec',
    'paths:',
    `  roadmap: ${roadmapPath}`,
    ''
  ].join('\n'));
  if (options.createRoadmap !== false) {
    await writeFixture(rootDir, roadmapPath, options.roadmapContent ?? '# Project Roadmap\n');
  }
  return roadmapPath;
}

function passingFinalizerOptions(rootDir, overrides = {}) {
  return {
    rootDir,
    changeId: 'add-oauth',
    detectOpenSpec: async () => availableCliDetection(),
    validateOpenSpecChange: async () => statusResult(),
    getOpenSpecStatus: async () => statusResult(),
    gitStatus: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    readLatestVerificationEvidence: async () => verificationEvidence(),
    readOpenSpecCoverageMatrix: async () => coverageEvidence(),
    validateOpenSpecArtifactContract: async () => ({
      schema_version: 1,
      validator: 'aifhub-openspec-artifact-contract',
      change_id: 'add-oauth',
      status: 'pass',
      blocking: false,
      checks: [],
      suggested_next: null
    }),
    archiveOpenSpecChange: async () => archiveResult(),
    ...overrides
  };
}

async function writeRulesGateEvidence(rootDir, changeId = 'add-oauth', status = 'pass', qaRoot = '.ai-factory/qa') {
  await writeFixture(rootDir, `${qaRoot}/${changeId}/rules.md`, [
    '# Rules Gate',
    '',
    renderGateResultBlock(createGateResult({
      gate: 'rules',
      status,
      blockers: status === 'fail'
        ? [{
          id: 'rules-failed',
          severity: 'error',
          summary: 'Rules failed.',
          source: {
            path: `openspec/changes/${changeId}/specs/auth/spec.md`,
            requirement: 'Rules gate evidence'
          }
        }]
        : [],
      affectedFiles: [],
      suggestedNext: status === 'fail'
        ? {
          command: '/aif-fix',
          reason: 'Rules failed.'
        }
        : null
    })),
    ''
  ].join('\n'));
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
    commandSource: 'path',
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
    commandSource: 'path',
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
    commandSource: overrides.commandSource ?? 'path',
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
    commandSource: overrides.commandSource ?? 'path',
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
    '',
    renderGateResultBlock(createGateResult({
      gate: 'verify',
      status: overrides.gateStatus ?? 'pass',
      blockers: overrides.gateStatus === 'fail'
        ? [{
          id: 'verify-failed',
          severity: 'error',
          summary: 'Verification failed.'
        }]
        : [],
      affectedFiles: [],
      suggestedNext: overrides.gateStatus === 'fail'
        ? {
          command: '/aif-fix',
          reason: 'Verification failed.'
        }
        : null
    })),
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
    gateResult: overrides.gateResult,
    warnings: overrides.warnings ?? [],
    errors: overrides.errors ?? []
  };
}

function coverageMatrix(overrides = {}) {
  return {
    schema_version: 1,
    change_id: overrides.changeId ?? 'add-oauth',
    status: overrides.status ?? 'pass',
    blocking: overrides.status === 'fail',
    policy: {
      mode: overrides.policy ?? 'strict',
      missing_requirement: overrides.policy === 'normal' ? 'warn' : 'fail'
    },
    requirements: overrides.requirements ?? [],
    summary: overrides.summary ?? {
      covered: 0,
      partial: 0,
      missing: 0,
      not_applicable: 0
    },
    sources: overrides.sources ?? [],
    stale: false,
    diagnostics: overrides.diagnostics ?? [],
    warnings: [],
    errors: []
  };
}

function coverageEvidence(overrides = {}) {
  return {
    ok: overrides.ok ?? true,
    exists: overrides.exists ?? true,
    stale: overrides.stale ?? false,
    changeId: overrides.changeId ?? 'add-oauth',
    coveragePath: overrides.coveragePath ?? null,
    relativePath: overrides.relativePath ?? '.ai-factory/qa/add-oauth/coverage.json',
    coverage: overrides.coverage ?? coverageMatrix(overrides),
    diagnostics: overrides.diagnostics ?? [],
    warnings: overrides.warnings ?? [],
    errors: overrides.errors ?? []
  };
}

function finalizerCommandResult(overrides = {}) {
  return {
    ok: overrides.ok ?? true,
    mode: 'openspec-native',
    changeId: Object.prototype.hasOwnProperty.call(overrides, 'changeId')
      ? overrides.changeId
      : 'add-oauth',
    status: overrides.status ?? (overrides.ok === false ? 'FAIL' : 'PASS'),
    readiness: overrides.readiness ?? {
      status: 'pass',
      blocking: false,
      suggested_next: null,
      context: {
        private: 'verification contents must not escape'
      }
    },
    workingTree: overrides.workingTree ?? {
      ok: true,
      isGitRepo: true,
      dirty: false,
      entries: [],
      warnings: [],
      errors: []
    },
    archive: overrides.archive ?? {
      ok: true,
      status: 'PASS',
      archived: true,
      skipSpecs: false,
      command: 'node_modules/.bin/openspec.cmd',
      commandSource: 'project-local',
      stdout: 'raw archive output must not escape',
      stderr: 'raw archive error must not escape'
    },
    roadmap: overrides.roadmap ?? {
      status: 'updated',
      reason: 'lifecycle-updated',
      path: DEFAULT_ROADMAP_PATH,
      changed: true,
      suggestedNext: null
    },
    context: overrides.context ?? {
      openspec: {
        command: 'node_modules/.bin/openspec.cmd',
        commandSource: 'project-local'
      },
      verification: {
        content: 'verification contents must not escape'
      },
      runtimeTraces: [{ content: 'runtime contents must not escape' }]
    },
    verification: {
      content: 'verification contents must not escape'
    },
    summaryFiles: overrides.summaryFiles ?? [
      '.ai-factory/qa/add-oauth/done.md',
      '.ai-factory/state/add-oauth/final-summary.md'
    ],
    commitMessage: overrides.commitMessage ?? 'feat: finalize add-oauth',
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

describe('OpenSpec done finalizer command', () => {
  it('parses only the public finalizer flags', () => {
    assert.deepEqual(
      parseDoneFinalizerArgs([
        '--change',
        'add-oauth',
        '--skip-specs',
        '--record-dirty-state',
        '--json'
      ]),
      {
        ok: true,
        changeId: 'add-oauth',
        skipSpecs: true,
        recordDirtyState: true,
        json: true
      }
    );
  });

  it('rejects missing, unknown, and bypass flags before calling the finalizer API', async () => {
    const invalidArgv = [
      ['--change'],
      ['--unknown'],
      ['--force'],
      ['--no-validate'],
      ['--skip-archive'],
      ['--dry-run'],
      ['--summary-only']
    ];

    for (const argv of invalidArgv) {
      let calls = 0;
      const command = await runDoneFinalizerCommand(argv, {
        finalizeOpenSpecChange: async () => {
          calls += 1;
          return finalizerCommandResult();
        }
      });

      assert.equal(command.exitCode, 2, `${argv.join(' ')} should be a command error`);
      assert.equal(command.stdout, '');
      assert.match(command.stderr, /Missing value|Unknown option|Unsupported finalizer option/);
      assert.equal(calls, 0, `${argv.join(' ')} must not call finalizer API`);
    }
  });

  it('maps public flags and strips internal bypass options from the API call', async () => {
    const calls = [];
    const command = await runDoneFinalizerCommand([
      '--change',
      'add-oauth',
      '--skip-specs',
      '--record-dirty-state'
    ], {
      noValidate: true,
      skipArchive: true,
      dryRun: true,
      summaryOnly: true,
      finalizeOpenSpecChange: async (options) => {
        calls.push(options);
        return finalizerCommandResult();
      }
    });

    assert.equal(command.exitCode, 0);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].changeId, 'add-oauth');
    assert.equal(calls[0].skipSpecs, true);
    assert.equal(calls[0].recordDirtyState, true);
    for (const key of ['noValidate', 'skipArchive', 'dryRun', 'summaryOnly']) {
      assert.equal(Object.hasOwn(calls[0], key), false, `${key} must not reach public finalizer execution`);
    }
  });

  it('renders bounded human output with pre-archive command diagnostics and errors', async () => {
    const command = await runDoneFinalizerCommand([], {
      finalizeOpenSpecChange: async () => finalizerCommandResult({
        ok: false,
        readiness: {
          status: 'fail',
          blocking: true,
          suggested_next: {
            command: '/aif-fix add-oauth',
            reason: 'fix the blocking gate'
          }
        },
        archive: {
          status: 'SKIPPED',
          archived: false,
          skipSpecs: false,
          command: null,
          commandSource: null,
          stdout: 'raw archive output must not escape'
        },
        errors: [{
          code: 'verification-failed',
          message: 'Verification failed at C:\\Users\\private name\\verify.md before archive.',
          detail: 'raw detail must not escape'
        }]
      })
    });

    assert.equal(command.exitCode, 1);
    assert.match(command.stdout, /Finalization status: FAIL/);
    assert.match(command.stdout, /OpenSpec command: node_modules\/\.bin\/openspec\.cmd \(project-local\)/);
    assert.match(command.stdout, /Suggested next: \/aif-fix add-oauth/);
    assert.match(command.stdout, /verification-failed:/);
    assert.doesNotMatch(command.stdout, /Users|private name|raw archive|raw detail|verification contents/);
  });

  it('projects JSON through an allowlist and uses pre-archive command context', async () => {
    const result = finalizerCommandResult({
      ok: false,
      readiness: {
        status: 'fail',
        blocking: true,
        suggested_next: {
          command: '/aif-fix add-oauth',
          reason: 'fix the blocking gate'
        }
      },
      workingTree: {
        ok: true,
        isGitRepo: true,
        dirty: true,
        entries: [' M private-file.md'],
        warnings: [{ code: 'dirty-working-tree-recorded', message: 'recorded' }],
        errors: []
      },
      archive: {
        status: 'SKIPPED',
        archived: false,
        skipSpecs: true,
        command: null,
        commandSource: null,
        stdout: 'raw archive output must not escape',
        stderr: 'raw archive error must not escape'
      },
      summaryFiles: [
        '.ai-factory/qa/add-oauth/done.md',
        'C:\\Users\\private\\secret.md'
      ],
      warnings: [{
        code: 'safe-warning',
        message: 'Inspect C:\\Users\\private name\\warning.txt before retrying.',
        path: '.ai-factory/qa/add-oauth/done.md',
        detail: 'raw warning detail must not escape'
      }],
      errors: [{
        code: 'safe-error',
        message: 'Finalization blocked.',
        path: 'C:\\Users\\private\\error.txt',
        detail: 'raw error detail must not escape'
      }]
    });
    const projection = projectDoneFinalizerResult(result);
    const serialized = JSON.stringify(projection);

    assert.deepEqual(Object.keys(projection), [
      'ok',
      'mode',
      'change_id',
      'status',
      'readiness',
      'working_tree',
      'archive',
      'roadmap',
      'summary_files',
      'commit_message',
      'warnings',
      'errors'
    ]);
    assert.equal(projection.archive.command, 'node_modules/.bin/openspec.cmd');
    assert.equal(projection.archive.command_source, 'project-local');
    assert.deepEqual(projection.roadmap, {
      status: 'updated',
      reason: 'lifecycle-updated',
      path: DEFAULT_ROADMAP_PATH,
      changed: true,
      suggested_next: null
    });
    assert.equal(projection.working_tree.recorded, true);
    assert.equal(projection.working_tree.entry_count, 1);
    assert.equal(Object.hasOwn(projection.working_tree, 'entries'), false);
    assert.deepEqual(projection.summary_files, ['.ai-factory/qa/add-oauth/done.md']);
    assert.equal(projection.warnings[0].path, '.ai-factory/qa/add-oauth/done.md');
    assert.equal(Object.hasOwn(projection.errors[0], 'path'), false);
    for (const forbidden of [
      'context',
      'verification contents',
      'runtime contents',
      'raw archive',
      'raw warning detail',
      'raw error detail',
      'C:\\\\Users',
      'private-file.md'
    ]) {
      assert.equal(serialized.includes(forbidden), false, `JSON projection must omit ${forbidden}`);
    }

    const command = await runDoneFinalizerCommand(['--json'], {
      finalizeOpenSpecChange: async () => result
    });
    assert.equal(command.exitCode, 1);
    assert.deepEqual(JSON.parse(command.stdout), projection);
  });

  it('redacts quoted root paths and UNC server roots while preserving slash commands', () => {
    const projection = projectDoneFinalizerResult(finalizerCommandResult({
      readiness: {
        status: 'fail',
        blocking: true,
        suggested_next: {
          command: '/aif-fix add-oauth',
          reason: 'Inspect "/секрет" before retrying.'
        }
      },
      errors: [
        {
          code: 'quoted-root',
          message: 'Inspect "/секрет" before retrying.'
        },
        {
          code: 'unc-root',
          message: 'Inspect "\\\\сервер" before retrying.'
        }
      ]
    }));
    const serialized = JSON.stringify(projection);

    assert.equal(projection.readiness.suggested_next.command, '/aif-fix add-oauth');
    assert.match(serialized, /\[path\]/);
    assert.equal(serialized.includes('секрет'), false);
    assert.equal(serialized.includes('сервер'), false);
  });

  it('classifies success, blockers, unresolved scope, and unexpected exceptions', async () => {
    const success = await runDoneFinalizerCommand([], {
      finalizeOpenSpecChange: async () => finalizerCommandResult({ status: 'WARN' })
    });
    const blocker = await runDoneFinalizerCommand([], {
      finalizeOpenSpecChange: async () => finalizerCommandResult({ ok: false })
    });
    const unresolved = await runDoneFinalizerCommand([], {
      finalizeOpenSpecChange: async () => finalizerCommandResult({ ok: false, changeId: null })
    });
    const unexpected = await runDoneFinalizerCommand([], {
      finalizeOpenSpecChange: async () => {
        throw new Error('C:\\Users\\private\\secret');
      }
    });

    assert.equal(success.exitCode, 0);
    assert.equal(blocker.exitCode, 1);
    assert.equal(unresolved.exitCode, 2);
    assert.equal(unexpected.exitCode, 2);
    assert.equal(unexpected.stdout, '');
    assert.equal(unexpected.stderr, 'Done finalizer command failed unexpectedly.\n');
  });
});

describe('OpenSpec done finalizer API', () => {
  it('exports the required public functions', () => {
    for (const fn of [
      finalizeOpenSpecChange,
      buildDoneContext,
      assertCoverageAcceptable,
      assertRulesGateAcceptable,
      assertVerificationPassed,
      archiveChangeWithOpenSpec,
      writeDoneSummary,
      detectWorkingTreeState,
      parseDoneFinalizerArgs,
      projectDoneFinalizerResult,
      runDoneFinalizerCommand,
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
      readLatestVerificationEvidence: async () => verificationEvidence(),
      readOpenSpecCoverageMatrix: async () => coverageEvidence()
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

  it('builds context using the configured QA evidence path', async () => {
    const rootDir = await createTempRoot();
    await createOpenSpecChange(rootDir);
    await writeFixture(rootDir, '.ai-factory/config.yaml', [
      'paths:',
      '  qa: custom-qa',
      '  state: custom-state',
      ''
    ].join('\n'));
    await writeFixture(rootDir, 'custom-qa/add-oauth/openspec-validation.json', JSON.stringify({
      changeId: 'add-oauth',
      ok: true,
      skipped: false,
      error: null
    }, null, 2));
    await writeFixture(rootDir, 'custom-qa/add-oauth/verify.md', [
      '# Verify: add-oauth',
      '',
      '## AIF Verify Gate',
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
    await writeFixture(rootDir, 'custom-qa/add-oauth/coverage.json', JSON.stringify(coverageMatrix(), null, 2));
    await createRuntimeEvidence(rootDir);
    await writeRulesGateEvidence(rootDir, 'add-oauth', 'pass', 'custom-qa');

    const context = await buildDoneContext({
      rootDir,
      changeId: 'add-oauth',
      detectOpenSpec: async () => availableCliDetection()
    });

    assert.equal(context.ok, true);
    assert.equal(context.verification.passed, true);
    assert.match(context.paths.qa, /custom-qa[\\/]add-oauth$/);
    assert.equal(context.verification.verify.path, 'custom-qa/add-oauth/verify.md');
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
        gateStatus: 'fail',
        content: [
          '# Verify',
          '',
          'OpenSpec validation: FAIL',
          'Code verification: BLOCKED',
          '',
          renderGateResultBlock(createGateResult({
            gate: 'verify',
            status: 'fail',
            blockers: [{
              id: 'openspec-validation-failed',
              severity: 'error',
              summary: 'OpenSpec validation failed.'
            }],
            affectedFiles: [],
            suggestedNext: {
              command: '/aif-fix',
              reason: 'OpenSpec validation failed.'
            }
          })),
          ''
        ].join('\n')
      })
    });
    assert.equal(failed.ok, false);
    assert.equal(failed.errors[0].code, 'verification-not-passed');

    const pending = await assertVerificationPassed('add-oauth', {
      readLatestVerificationEvidence: async () => verificationEvidence({
        codeState: 'PENDING',
        content: [
          '# Verify',
          '',
          'OpenSpec validation: PASS',
          'Code verification: PENDING',
          '',
          renderGateResultBlock(createGateResult({
            gate: 'verify',
            status: 'warn',
            blockers: [],
            affectedFiles: [],
            suggestedNext: null
          })),
          ''
        ].join('\n')
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

  it('does not treat branch-scoped qa-check.md as done or archive evidence', async () => {
    const rootDir = await createTempRoot();
    await createOpenSpecChange(rootDir);
    await writeFixture(rootDir, '.ai-factory/qa/feature-oauth-a1b2c3d4/qa-check.md', '# QA Check\n\n- [x] Manual smoke passed\n');

    const context = await buildDoneContext({
      rootDir,
      changeId: 'add-oauth',
      detectOpenSpec: async () => availableCliDetection(),
      readLatestVerificationEvidence: async () => ({
        ok: false,
        changeId: 'add-oauth',
        validation: null,
        status: null,
        verify: { exists: false, path: null, content: '' },
        coverage: { exists: false, relativePath: null, coverage: null },
        warnings: [],
        errors: []
      }),
      readOpenSpecCoverageMatrix: async () => coverageEvidence({ exists: false, coverage: null })
    });

    assert.equal(context.ok, false, 'branch qa-check.md must not make done context ready');
    assert.equal(context.verification.passed, false, 'branch qa-check.md must not satisfy final verify gate');
    assert.equal(await pathExists(path.join(rootDir, '.ai-factory', 'qa', 'add-oauth', 'done.md')), false);
    assert.equal(await pathExists(path.join(rootDir, '.ai-factory', 'qa', 'add-oauth', 'openspec-archive.json')), false);
  });

  it('requires a valid latest verify gate result before finalization', async () => {
    const missingGate = await assertVerificationPassed('add-oauth', {
      readLatestVerificationEvidence: async () => verificationEvidence({
        content: '# Verify\n\nVerdict: PASS\nCode verification: PASS\n'
      })
    });
    assert.equal(missingGate.ok, false);
    assert.equal(missingGate.errors[0].code, 'verification-gate-missing');

    const invalidGate = await assertVerificationPassed('add-oauth', {
      readLatestVerificationEvidence: async () => verificationEvidence({
        content: [
          '# Verify',
          '',
          'Verdict: PASS',
          'Code verification: PASS',
          '',
          '```aif-gate-result',
          '{"schema_version":1,"gate":"verify"',
          '```',
          ''
        ].join('\n')
      })
    });
    assert.equal(invalidGate.ok, false);
    assert.equal(invalidGate.errors[0].code, 'verification-gate-invalid');

    const legacyGate = await assertVerificationPassed('add-oauth', {
      readLatestVerificationEvidence: async () => verificationEvidence({
        content: [
          '# Verify',
          '',
          'Verdict: PASS',
          'Code verification: PASS',
          '',
          '```aif-gate-result',
          JSON.stringify({
            schema_version: 1,
            gate: 'verify',
            status: 'pass',
            blocking: false,
            blockers: [],
            affected_files: [],
            suggested_next: { command: '/aif-verify add-oauth', reason: 'rerun' }
          }),
          '```',
          ''
        ].join('\n')
      })
    });
    assert.equal(legacyGate.ok, false);
    assert.equal(legacyGate.errors[0].code, 'verification-gate-legacy-suggested-next');
    assert.match(legacyGate.errors[0].message, /rerun \/aif-verify once/);

    const failedGate = await assertVerificationPassed('add-oauth', {
      readLatestVerificationEvidence: async () => verificationEvidence({
        gateStatus: 'fail'
      })
    });
    assert.equal(failedGate.ok, false);
    assert.equal(failedGate.errors[0].code, 'verification-gate-failed');
  });

  it('requires current coverage evidence before finalization', async () => {
    const missing = await assertCoverageAcceptable('add-oauth', {
      readOpenSpecCoverageMatrix: async () => coverageEvidence({
        ok: false,
        exists: false,
        coverage: null,
        warnings: ['missing']
      })
    });
    assert.equal(missing.ok, false);
    assert.equal(missing.errors[0].code, 'coverage-evidence-missing');

    const stale = await assertCoverageAcceptable('add-oauth', {
      readOpenSpecCoverageMatrix: async () => coverageEvidence({
        stale: true,
        warnings: ['stale']
      })
    });
    assert.equal(stale.ok, false);
    assert.equal(stale.errors[0].code, 'coverage-evidence-stale');

    const failed = await assertCoverageAcceptable('add-oauth', {
      readOpenSpecCoverageMatrix: async () => coverageEvidence({
        coverage: coverageMatrix({
          status: 'fail',
          summary: { covered: 0, partial: 0, missing: 1, not_applicable: 0 }
        })
      })
    });
    assert.equal(failed.ok, false);
    assert.equal(failed.errors[0].code, 'coverage-policy-failed');

    const warned = await assertCoverageAcceptable('add-oauth', {
      readOpenSpecCoverageMatrix: async () => coverageEvidence({
        coverage: coverageMatrix({
          status: 'warn',
          policy: 'normal',
          summary: { covered: 0, partial: 0, missing: 1, not_applicable: 0 }
        })
      })
    });
    assert.equal(warned.ok, false);
    assert.equal(warned.errors[0].code, 'coverage-policy-warn');

    const acceptedWarn = await assertCoverageAcceptable('add-oauth', {
      policy: {
        requirements: { specCoverage: { done: true } },
        allowWarnOnDone: { coverage: true }
      },
      readOpenSpecCoverageMatrix: async () => coverageEvidence({
        coverage: coverageMatrix({
          status: 'warn',
          policy: 'normal',
          summary: { covered: 0, partial: 0, missing: 1, not_applicable: 0 }
        })
      })
    });
    assert.equal(acceptedWarn.ok, true);
    assert.equal(acceptedWarn.warnings[0].code, 'coverage-policy-warn');
  });

  it('requires rules gate evidence according to done policy', async () => {
    const rootDir = await createTempRoot();

    const missing = await assertRulesGateAcceptable('add-oauth', { rootDir });
    assert.equal(missing.ok, false);
    assert.equal(missing.errors[0].code, 'rules-gate-evidence-missing');

    await writeRulesGateEvidence(rootDir, 'add-oauth', 'warn');
    const warned = await assertRulesGateAcceptable('add-oauth', { rootDir });
    assert.equal(warned.ok, false);
    assert.equal(warned.errors[0].code, 'rules-gate-warn');

    const acceptedWarn = await assertRulesGateAcceptable('add-oauth', {
      rootDir,
      policy: {
        requirements: { rulesPass: { done: true } },
        allowWarnOnDone: { rules: true }
      }
    });
    assert.equal(acceptedWarn.ok, true);
    assert.equal(acceptedWarn.warnings[0].code, 'rules-gate-warn');

    await writeRulesGateEvidence(rootDir, 'add-oauth', 'pass');
    const passed = await assertRulesGateAcceptable('add-oauth', { rootDir });
    assert.equal(passed.ok, true);

    const legacy = await assertRulesGateAcceptable('add-oauth', {
      rootDir,
      rulesGateEvidence: {
        exists: true,
        path: '.ai-factory/qa/add-oauth/rules.md',
        gateResult: {
          ok: false,
          result: null,
          errors: [{
            code: 'invalid-suggested-next-on-pass',
            message: 'suggested_next must be null when status is pass; terminal routing is prose-only.'
          }]
        }
      }
    });
    assert.equal(legacy.ok, false);
    assert.equal(legacy.errors[0].code, 'rules-gate-legacy-suggested-next');
    assert.match(legacy.errors[0].message, /rerun \/aif-rules-check/);
  });

  it('allows non-pass rules gate results when done policy does not require pass', async () => {
    const rootDir = await createTempRoot();
    const relaxedPolicy = {
      requirements: { rulesPass: { done: false } },
      allowWarnOnDone: { rules: false }
    };

    const missing = await assertRulesGateAcceptable('add-oauth', {
      rootDir,
      policy: relaxedPolicy
    });
    assert.equal(missing.ok, true);
    assert.equal(missing.rulesGate.status, 'missing');
    assert.equal(missing.warnings.at(-1).code, 'rules-gate-evidence-missing');

    await writeRulesGateEvidence(rootDir, 'add-oauth', 'warn');
    const warned = await assertRulesGateAcceptable('add-oauth', {
      rootDir,
      policy: relaxedPolicy
    });
    assert.equal(warned.ok, true);
    assert.equal(warned.rulesGate.status, 'warn');
    assert.equal(warned.warnings.at(-1).code, 'rules-gate-warn');

    await writeRulesGateEvidence(rootDir, 'add-oauth', 'fail');
    const failed = await assertRulesGateAcceptable('add-oauth', {
      rootDir,
      policy: relaxedPolicy
    });
    assert.equal(failed.ok, true);
    assert.equal(failed.rulesGate.status, 'fail');
    assert.equal(failed.warnings.at(-1).code, 'rules-gate-fail');
    assert.match(failed.warnings.at(-1).message, /requireRulesPassForDone is false/);

    const invalid = await assertRulesGateAcceptable('add-oauth', {
      rootDir,
      policy: relaxedPolicy,
      rulesGateEvidence: {
        exists: true,
        path: '.ai-factory/qa/add-oauth/rules.md',
        gateResult: { ok: false }
      }
    });
    assert.equal(invalid.ok, true);
    assert.equal(invalid.rulesGate.status, 'invalid');
    assert.equal(invalid.warnings.at(-1).code, 'rules-gate-result-invalid');

    const relaxedLegacy = await assertRulesGateAcceptable('add-oauth', {
      rootDir,
      policy: relaxedPolicy,
      rulesGateEvidence: {
        exists: true,
        path: '.ai-factory/qa/add-oauth/rules.md',
        gateResult: {
          ok: false,
          result: null,
          errors: [{
            code: 'invalid-suggested-next-on-pass',
            message: 'suggested_next must be null when status is pass; terminal routing is prose-only.'
          }]
        }
      }
    });
    assert.equal(relaxedLegacy.ok, true);
    assert.equal(relaxedLegacy.warnings.at(-1).code, 'rules-gate-legacy-suggested-next');
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

  it('refuses to archive when the OpenSpec artifact contract fails', async () => {
    const rootDir = await createTempRoot();
    await createOpenSpecChange(rootDir);
    await createRuntimeEvidence(rootDir);
    let archiveCalls = 0;

    const result = await finalizeOpenSpecChange({
      rootDir,
      changeId: 'add-oauth',
      detectOpenSpec: async () => availableCliDetection(),
      validateOpenSpecChange: async () => statusResult(),
      readLatestVerificationEvidence: async () => verificationEvidence(),
      readOpenSpecCoverageMatrix: async () => coverageEvidence(),
      validateOpenSpecArtifactContract: async () => ({
        schema_version: 1,
        validator: 'aifhub-openspec-artifact-contract',
        change_id: 'add-oauth',
        status: 'fail',
        blocking: true,
        checks: [
          {
            id: 'runtime-files-outside-change',
            status: 'fail',
            path: 'openspec/changes/add-oauth/openspec-validation.json',
            message: 'Runtime evidence must stay outside canonical changes.'
          }
        ],
        suggested_next: null
      }),
      archiveOpenSpecChange: async () => {
        archiveCalls += 1;
        return archiveResult();
      }
    });

    assert.equal(result.ok, false);
    assert.equal(result.archive.archived, false);
    assert.equal(result.readiness.status, 'fail');
    assert.equal(result.errors[0].code, 'artifact-contract-failed');
    assert.equal(archiveCalls, 0);
    assert.equal(await pathExists(path.join(rootDir, '.ai-factory', 'qa', 'add-oauth', 'done-readiness.json')), true);
  });

  it('finalizes passing changes, writes done summaries, and stays out of canonical/legacy paths', async () => {
    const rootDir = await createTempRoot();
    await createOpenSpecChange(rootDir);
    await createRuntimeEvidence(rootDir);

    const result = await finalizeOpenSpecChange({
      rootDir,
      changeId: 'add-oauth',
      detectOpenSpec: async () => availableCliDetection(),
      validateOpenSpecChange: async () => statusResult(),
      getOpenSpecStatus: async () => statusResult(),
      gitStatus: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      readLatestVerificationEvidence: async () => verificationEvidence(),
      readOpenSpecCoverageMatrix: async () => coverageEvidence(),
      archiveOpenSpecChange: async () => archiveResult()
    });

    assert.equal(result.ok, true);
    assert.equal(result.archive.archived, true);
    assert.match(result.commitMessage, /^feat: finalize add-oauth$/);
    assert.match(result.prSummary, /## OpenSpec/);
    assert.match(result.prSummary, /Done readiness: PASS/);
    assert.match(result.prSummary, /Coverage matrix: PASS/);
    assert.match(summarizeDoneResult(result), /Finalization status: PASS/);

    const readinessPath = path.join(rootDir, '.ai-factory', 'qa', 'add-oauth', 'done-readiness.json');
    const donePath = path.join(rootDir, '.ai-factory', 'qa', 'add-oauth', 'done.md');
    const finalSummaryPath = path.join(rootDir, '.ai-factory', 'state', 'add-oauth', 'final-summary.md');
    assert.equal(await pathExists(readinessPath), true, 'done-readiness.json should be written under QA path');
    assert.equal(await pathExists(donePath), true, 'done.md should be written under QA path');
    assert.equal(await pathExists(finalSummaryPath), true, 'final-summary.md should be written under state path');
    assert.equal((await readJson(readinessPath)).gate, 'done-readiness');
    assert.match(await readFile(donePath, 'utf8'), /# Done: add-oauth/);
    assert.match(await readFile(donePath, 'utf8'), /## Done readiness/);
    assert.match(await readFile(donePath, 'utf8'), /Coverage matrix: PASS/);
    assert.match(await readFile(donePath, 'utf8'), /Archived: yes/);
    assert.match(await readFile(finalSummaryPath, 'utf8'), /## Suggested PR summary/);
    assert.equal(await pathExists(path.join(rootDir, 'openspec', 'changes', 'add-oauth', 'done.md')), false);
    assert.equal(await pathExists(path.join(rootDir, '.ai-factory', 'plans', 'add-oauth')), false);
  });

  it('updates the configured roadmap after archive and records bounded lifecycle evidence', async () => {
    const rootDir = await createTempRoot();
    const roadmapPath = await createLinkedFinalizationFixture(rootDir);

    const result = await finalizeOpenSpecChange(passingFinalizerOptions(rootDir));

    assert.equal(result.ok, true);
    assert.equal(result.status, 'PASS');
    assert.equal(result.archive.archived, true);
    assert.deepEqual(result.roadmap, {
      status: 'updated',
      reason: 'lifecycle-updated',
      path: roadmapPath,
      changed: true,
      suggestedNext: null
    });

    const roadmap = await readFile(path.join(rootDir, ...roadmapPath.split('/')), 'utf8');
    assert.match(roadmap, /<!-- aifhub:roadmap-change-lifecycle:start -->/);
    assert.match(
      roadmap,
      /\| `add-oauth` \| https:\/\/github\.com\/ichinya\/aifhub-extension\/issues\/88 \| none \| Workflow governance \| finalized \| \.ai-factory\/qa\/add-oauth\/done\.md \|/
    );

    for (const summaryPath of [
      '.ai-factory/qa/add-oauth/done.md',
      '.ai-factory/state/add-oauth/final-summary.md'
    ]) {
      const summary = await readFile(path.join(rootDir, ...summaryPath.split('/')), 'utf8');
      assert.match(summary, /## Roadmap lifecycle/);
      assert.match(summary, /Status: updated/);
      assert.match(summary, /Path: docs\/project-roadmap\.md/);
    }

    assert.deepEqual(projectDoneFinalizerResult(result).roadmap, {
      status: 'updated',
      reason: 'lifecycle-updated',
      path: roadmapPath,
      changed: true,
      suggested_next: null
    });
  });

  it('preserves archive success and hands off when the configured roadmap is missing', async () => {
    const rootDir = await createTempRoot();
    const roadmapPath = await createLinkedFinalizationFixture(rootDir, { createRoadmap: false });

    const result = await finalizeOpenSpecChange(passingFinalizerOptions(rootDir));

    assert.equal(result.ok, true);
    assert.equal(result.status, 'WARN');
    assert.equal(result.archive.archived, true);
    assert.deepEqual(result.roadmap, {
      status: 'handoff',
      reason: 'roadmap-missing',
      path: roadmapPath,
      changed: false,
      suggestedNext: '/aif-roadmap check'
    });
    assert.equal(await pathExists(path.join(rootDir, ...roadmapPath.split('/'))), false);
    assert.match(summarizeDoneResult(result), /Roadmap lifecycle: handoff/);
    assert.match(summarizeDoneResult(result), /Suggested next: \/aif-roadmap check/);

    for (const summaryPath of [
      '.ai-factory/qa/add-oauth/done.md',
      '.ai-factory/state/add-oauth/final-summary.md'
    ]) {
      const summary = await readFile(path.join(rootDir, ...summaryPath.split('/')), 'utf8');
      assert.match(summary, /Status: handoff/);
      assert.match(summary, /\/aif-roadmap check/);
    }
  });

  it('skips roadmap mutation for an explicitly unlinked change', async () => {
    const rootDir = await createTempRoot();
    const originalRoadmap = '# Project Roadmap\n\nOwned by maintainers.\n';
    const roadmapPath = await createLinkedFinalizationFixture(rootDir, {
      proposalContent: UNLINKED_PROPOSAL,
      roadmapContent: originalRoadmap
    });

    const result = await finalizeOpenSpecChange(passingFinalizerOptions(rootDir));

    assert.equal(result.ok, true);
    assert.equal(result.status, 'PASS');
    assert.deepEqual(result.roadmap, {
      status: 'skipped',
      reason: 'roadmap-linkage-none',
      path: null,
      changed: false,
      suggestedNext: null
    });
    assert.equal(await readFile(path.join(rootDir, ...roadmapPath.split('/')), 'utf8'), originalRoadmap);
  });

  it('preserves malformed marker content and returns the exact roadmap handoff', async () => {
    const rootDir = await createTempRoot();
    const originalRoadmap = `# Project Roadmap\n\n${ROADMAP_LIFECYCLE_START_MARKER}\nunfinished\n`;
    const roadmapPath = await createLinkedFinalizationFixture(rootDir, {
      roadmapContent: originalRoadmap
    });

    const result = await finalizeOpenSpecChange(passingFinalizerOptions(rootDir));

    assert.equal(result.ok, true);
    assert.equal(result.status, 'WARN');
    assert.equal(result.archive.archived, true);
    assert.equal(result.roadmap.status, 'handoff');
    assert.equal(result.roadmap.reason, 'roadmap-markers-incomplete');
    assert.equal(result.roadmap.suggestedNext, '/aif-roadmap check');
    assert.equal(await readFile(path.join(rootDir, ...roadmapPath.split('/')), 'utf8'), originalRoadmap);
  });

  it('keeps repeated finalization idempotent after the first roadmap update', async () => {
    const rootDir = await createTempRoot();
    const roadmapPath = await createLinkedFinalizationFixture(rootDir);

    const first = await finalizeOpenSpecChange(passingFinalizerOptions(rootDir));
    const second = await finalizeOpenSpecChange(passingFinalizerOptions(rootDir));

    assert.equal(first.roadmap.status, 'updated');
    assert.deepEqual(second.roadmap, {
      status: 'skipped',
      reason: 'lifecycle-current',
      path: roadmapPath,
      changed: false,
      suggestedNext: null
    });
    const roadmap = await readFile(path.join(rootDir, ...roadmapPath.split('/')), 'utf8');
    assert.equal((roadmap.match(/\| `add-oauth` \|/g) ?? []).length, 1);
    assert.equal((roadmap.match(/aifhub:roadmap-change-lifecycle:start/g) ?? []).length, 1);
  });

  it('bounds an unexpected post-archive roadmap failure without rolling archive success back', async () => {
    const rootDir = await createTempRoot();
    await createLinkedFinalizationFixture(rootDir);

    const result = await finalizeOpenSpecChange(passingFinalizerOptions(rootDir, {
      updateRoadmapChangeLifecycle: async () => {
        throw new Error('C:\\Users\\private\\roadmap-secret');
      }
    }));
    const serialized = JSON.stringify(projectDoneFinalizerResult(result));

    assert.equal(result.ok, true);
    assert.equal(result.status, 'WARN');
    assert.equal(result.archive.archived, true);
    assert.deepEqual(result.roadmap, {
      status: 'handoff',
      reason: 'roadmap-update-failed',
      path: null,
      changed: false,
      suggestedNext: '/aif-roadmap check'
    });
    assert.match(summarizeDoneResult(result), /Suggested next: \/aif-roadmap check/);
    assert.doesNotMatch(serialized, /Users|private|secret/);
    assert.equal(await pathExists(path.join(rootDir, '.ai-factory', 'qa', 'add-oauth', 'done.md')), true);
    assert.equal(await pathExists(path.join(rootDir, '.ai-factory', 'state', 'add-oauth', 'final-summary.md')), true);
  });

  it('never invokes roadmap mutation on any pre-archive failure path', async () => {
    const cases = [
      {
        label: 'verification',
        overrides: {
          readLatestVerificationEvidence: async () => verificationEvidence({ gateStatus: 'fail' })
        }
      },
      {
        label: 'readiness',
        overrides: {
          validateOpenSpecChange: async () => statusResult({
            ok: false,
            exitCode: 1,
            error: { code: 'validation-failed', message: 'Validation failed.' }
          })
        }
      },
      {
        label: 'artifact contract',
        overrides: {
          validateOpenSpecArtifactContract: async () => ({
            schema_version: 1,
            validator: 'aifhub-openspec-artifact-contract',
            change_id: 'add-oauth',
            status: 'fail',
            blocking: true,
            checks: [{ id: 'contract-failed', status: 'fail', message: 'Contract failed.' }],
            suggested_next: null
          })
        }
      },
      {
        label: 'dirty tree',
        overrides: {
          gitStatus: async () => ({ exitCode: 0, stdout: ' M README.md\n', stderr: '' })
        }
      },
      {
        label: 'archive',
        overrides: {
          archiveOpenSpecChange: async () => archiveResult({
            ok: false,
            status: 'FAIL',
            archived: false,
            exitCode: 1,
            error: { code: 'archive-failed', message: 'Archive failed.' },
            errors: [{ code: 'archive-failed', message: 'Archive failed.' }]
          })
        }
      }
    ];

    for (const testCase of cases) {
      const rootDir = await createTempRoot();
      const originalRoadmap = `# Project Roadmap\n\n${testCase.label}\n`;
      const roadmapPath = await createLinkedFinalizationFixture(rootDir, {
        roadmapContent: originalRoadmap
      });
      let roadmapCalls = 0;

      const result = await finalizeOpenSpecChange(passingFinalizerOptions(rootDir, {
        ...testCase.overrides,
        updateRoadmapChangeLifecycle: async () => {
          roadmapCalls += 1;
          await writeFixture(rootDir, roadmapPath, 'MUTATED\n');
          return {
            status: 'updated',
            reason: 'lifecycle-updated',
            path: roadmapPath,
            changed: true,
            suggestedNext: null
          };
        }
      }));

      assert.equal(result.ok, false, `${testCase.label} should block finalization`);
      assert.equal(result.archive.archived, false, `${testCase.label} should not report archive success`);
      assert.equal(roadmapCalls, 0, `${testCase.label} must not call the roadmap helper`);
      assert.equal(
        await readFile(path.join(rootDir, ...roadmapPath.split('/')), 'utf8'),
        originalRoadmap,
        `${testCase.label} must not mutate the roadmap`
      );
    }
  });

  it('records dirty state and still writes summaries when explicit recording is requested', async () => {
    const rootDir = await createTempRoot();
    await createOpenSpecChange(rootDir);
    await createRuntimeEvidence(rootDir);
    const archiveCalls = [];

    const result = await finalizeOpenSpecChange({
      rootDir,
      changeId: 'add-oauth',
      recordDirtyState: true,
      skipSpecs: true,
      detectOpenSpec: async () => availableCliDetection(),
      validateOpenSpecChange: async () => statusResult(),
      gitStatus: async () => ({ exitCode: 0, stdout: ' M README.md\n', stderr: '' }),
      readLatestVerificationEvidence: async () => verificationEvidence(),
      readOpenSpecCoverageMatrix: async () => coverageEvidence(),
      archiveOpenSpecChange: async (changeId, options) => {
        archiveCalls.push({ changeId, options });
        return archiveResult({
          args: ['archive', 'add-oauth', '--yes', '--skip-specs', '--no-color']
        });
      }
    });

    assert.equal(result.ok, true);
    assert.equal(result.readiness.status, 'warn');
    assert.equal(result.readiness.checks.dirty_workspace, 'warn');
    assert.equal(result.workingTree.dirty, true);
    assert.deepEqual(result.workingTree.entries, [' M README.md']);
    assert.equal(result.archive.skipSpecs, true);
    assert.deepEqual(archiveCalls.map((call) => call.changeId), ['add-oauth']);
    assert.equal(archiveCalls[0].options.skipSpecs, true);
    assert.match(
      await readFile(path.join(rootDir, '.ai-factory', 'qa', 'add-oauth', 'done.md'), 'utf8'),
      /M README\.md/
    );
  });
});
