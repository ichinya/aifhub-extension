// openspec-done-finalizer.mjs - shared OpenSpec done/finalization runtime helpers
import { execFile } from 'node:child_process';
import { access, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

import {
  ensureRuntimeLayout as defaultEnsureRuntimeLayout,
  normalizeChangeId,
  resolveActiveChange as defaultResolveActiveChange
} from './active-change-resolver.mjs';
import {
  archiveOpenSpecChange as defaultArchiveOpenSpecChange,
  detectOpenSpec as defaultDetectOpenSpec,
  getOpenSpecStatus as defaultGetOpenSpecStatus
} from './openspec-runner.mjs';
import {
  readLatestVerificationEvidence as defaultReadLatestVerificationEvidence
} from './openspec-verification-context.mjs';
import {
  collectCanonicalChangeArtifacts,
  collectGeneratedRules
} from './openspec-execution-context.mjs';

const execFileAsync = promisify(execFile);
const MODE = 'openspec-native';
const DEFAULT_STATE_DIR = path.join('.ai-factory', 'state');
const DEFAULT_QA_DIR = path.join('.ai-factory', 'qa');
const ARCHIVE_JSON = 'openspec-archive.json';
const DONE_MARKDOWN = 'done.md';
const FINAL_SUMMARY_MARKDOWN = 'final-summary.md';

export async function finalizeOpenSpecChange(options = {}) {
  const rootDir = resolveRootDir(options);
  const context = await buildDoneContext({ ...options, rootDir });

  if (!context.ok) {
    return {
      ...context,
      status: 'FAIL',
      archive: createSkippedArchiveSummary(context.changeId, options, 'context-failed'),
      workingTree: null,
      commitMessage: context.changeId ? createCommitMessage(context.changeId) : '',
      prSummary: '',
      summaryFiles: []
    };
  }

  const workingTree = await detectWorkingTreeState({
    ...options,
    rootDir
  });

  if (!workingTree.ok) {
    return createFinalizeFailure({
      context,
      workingTree,
      archive: createSkippedArchiveSummary(context.changeId, options, 'dirty-working-tree'),
      errors: workingTree.errors
    });
  }

  const archive = await archiveChangeWithOpenSpec(context.changeId, {
    ...options,
    rootDir
  });

  const baseResult = {
    ok: archive.ok,
    mode: MODE,
    changeId: context.changeId,
    status: archive.ok ? archive.status : 'FAIL',
    context,
    verification: context.verification,
    workingTree,
    archive,
    commitMessage: createCommitMessage(context.changeId),
    prSummary: createPrSummary({
      changeId: context.changeId,
      context,
      archive
    }),
    warnings: dedupeDiagnostics([
      ...context.warnings,
      ...workingTree.warnings,
      ...archive.warnings
    ]),
    errors: archive.errors,
    summaryFiles: []
  };

  if (!archive.ok) {
    return baseResult;
  }

  const summary = await writeDoneSummary(context.changeId, baseResult, {
    ...options,
    rootDir,
    qaPath: context.paths.qa,
    statePath: context.paths.state
  });

  return {
    ...baseResult,
    summaryFiles: summary.files
  };
}

export async function buildDoneContext(options = {}) {
  const rootDir = resolveRootDir(options);
  const resolveActiveChange = options.resolveActiveChange ?? defaultResolveActiveChange;
  const ensureRuntimeLayout = options.ensureRuntimeLayout ?? defaultEnsureRuntimeLayout;
  const changeIdInput = options.changeId;
  const resolverResult = await resolveActiveChange({
    rootDir,
    cwd: options.cwd ?? process.cwd(),
    changeId: changeIdInput,
    getCurrentBranch: options.getCurrentBranch
  });

  if (!resolverResult.ok) {
    const archived = await detectArchivedFromFailedResolution(rootDir, changeIdInput, resolverResult);
    if (archived !== null) {
      const existingSummaries = await readExistingFinalSummaries(rootDir, archived.changeId);
      return createContextFailure({
        changeId: archived.changeId,
        source: resolverResult.source,
        candidates: resolverResult.candidates,
        warnings: resolverResult.warnings,
        existingSummaries,
        errors: [
          {
            code: 'change-already-archived',
            message: 'This change appears to be already archived.',
            path: archived.path
          }
        ]
      });
    }

    return createContextFailure({
      changeId: resolverResult.changeId,
      source: resolverResult.source,
      candidates: resolverResult.candidates,
      warnings: resolverResult.warnings,
      errors: resolverResult.errors
    });
  }

  const archived = await detectArchivedActiveChange(rootDir, resolverResult);
  if (archived !== null) {
    const existingSummaries = await readExistingFinalSummaries(rootDir, resolverResult.changeId);
    return createContextFailure({
      changeId: resolverResult.changeId,
      source: resolverResult.source,
      candidates: resolverResult.candidates,
      warnings: resolverResult.warnings,
      existingSummaries,
      errors: [
        {
          code: 'change-already-archived',
          message: 'This change appears to be already archived.',
          path: archived.path
        }
      ]
    });
  }

  const layout = await ensureRuntimeLayout(resolverResult.changeId, {
    rootDir,
    cwd: options.cwd,
    stateDir: options.stateDir,
    qaDir: options.qaDir
  });
  assertSafeRuntimePath(rootDir, layout.qaPath, 'QA evidence path');
  assertSafeRuntimePath(rootDir, layout.statePath, 'State summary path');

  const canonical = await collectCanonicalChangeArtifacts(resolverResult.changeId, {
    ...options,
    rootDir
  });
  const generatedRules = await collectGeneratedRules(resolverResult.changeId, {
    ...options,
    rootDir
  });
  const verification = await assertVerificationPassed(resolverResult.changeId, {
    ...options,
    rootDir,
    qaPath: layout.qaPath
  });
  const runtimeTraces = await collectRuntimeTraces(rootDir, layout.statePath);
  const openspec = await detectOpenSpecCapability(options, rootDir);
  const warnings = dedupeDiagnostics([
    ...resolverResult.warnings,
    ...canonical.warnings,
    ...generatedRules.warnings,
    ...verification.warnings,
    ...runtimeTraces.warnings,
    ...openspec.warnings
  ]);
  const errors = [
    ...canonical.errors,
    ...generatedRules.errors,
    ...verification.errors,
    ...runtimeTraces.errors,
    ...openspec.errors
  ];

  return {
    ok: errors.length === 0,
    mode: MODE,
    changeId: resolverResult.changeId,
    resolver: createResolverSummary(resolverResult),
    paths: {
      change: resolverResult.changePath,
      state: layout.statePath,
      qa: layout.qaPath
    },
    verification: verification.verification,
    openspec: openspec.openspec,
    canonicalArtifacts: canonical.canonicalArtifacts,
    runtimeTraces: runtimeTraces.runtimeTraces,
    generatedRules: generatedRules.generatedRules,
    warnings,
    errors
  };
}

export async function assertVerificationPassed(changeId, options = {}) {
  const rootDir = resolveRootDir(options);
  const normalized = normalizeChangeId(changeId);

  if (!normalized.ok) {
    return createVerificationFailure({
      changeId: null,
      code: normalized.error.code,
      message: normalized.error.message,
      evidence: null
    });
  }

  const readLatestVerificationEvidence = options.readLatestVerificationEvidence ?? defaultReadLatestVerificationEvidence;
  const evidence = await readLatestVerificationEvidence(normalized.changeId, {
    ...options,
    rootDir
  });

  if (!evidence?.verify?.exists) {
    return createVerificationFailure({
      changeId: normalized.changeId,
      code: 'verification-evidence-missing',
      message: `Run /aif-verify ${normalized.changeId} before /aif-done.`,
      evidence
    });
  }

  if (evidence.changeId !== null && evidence.changeId !== undefined && evidence.changeId !== normalized.changeId) {
    return createVerificationFailure({
      changeId: normalized.changeId,
      code: 'verification-ambiguous',
      message: 'Verification evidence is ambiguous; rerun /aif-verify before finalizing.',
      evidence
    });
  }

  if (Array.isArray(evidence.errors) && evidence.errors.length > 0) {
    return createVerificationFailure({
      changeId: normalized.changeId,
      code: 'verification-not-passed',
      message: 'Refusing to archive because verification did not pass.',
      evidence
    });
  }

  const validation = evidence.validation;
  if (validation === null || validation === undefined) {
    return createVerificationFailure({
      changeId: normalized.changeId,
      code: 'verification-ambiguous',
      message: 'Verification evidence is ambiguous; rerun /aif-verify before finalizing.',
      evidence
    });
  }

  if (!validation.ok) {
    return createVerificationFailure({
      changeId: normalized.changeId,
      code: 'verification-not-passed',
      message: 'Refusing to archive because verification did not pass.',
      evidence
    });
  }

  const verifyContent = evidence.verify.content ?? '';
  if (/\b(Code verification:\s*PENDING|Code verification:\s*BLOCKED)\b/i.test(verifyContent)) {
    return createVerificationFailure({
      changeId: normalized.changeId,
      code: 'verification-ambiguous',
      message: 'Verification evidence is ambiguous; rerun /aif-verify before finalizing.',
      evidence
    });
  }

  if (/\b(Verdict:\s*FAIL|OpenSpec validation:\s*FAIL|\/aif-verify:\s*FAIL)\b/i.test(verifyContent)) {
    return createVerificationFailure({
      changeId: normalized.changeId,
      code: 'verification-not-passed',
      message: 'Refusing to archive because verification did not pass.',
      evidence
    });
  }

  if (!hasFinalPassSignal(verifyContent)) {
    return createVerificationFailure({
      changeId: normalized.changeId,
      code: 'verification-ambiguous',
      message: 'Verification evidence is ambiguous; rerun /aif-verify before finalizing.',
      evidence
    });
  }

  return {
    ok: true,
    changeId: normalized.changeId,
    passed: true,
    verification: normalizeVerificationSummary(evidence, true),
    warnings: evidence.warnings ?? [],
    errors: []
  };
}

export async function archiveChangeWithOpenSpec(changeId, options = {}) {
  const rootDir = resolveRootDir(options);
  const normalized = normalizeChangeId(changeId);

  if (!normalized.ok) {
    return createArchiveFailure({
      changeId: null,
      skipSpecs: Boolean(options.skipSpecs),
      error: normalized.error
    });
  }

  const skipSpecs = Boolean(options.skipSpecs);

  if (options.skipArchive || options.dryRun || options.summaryOnly) {
    const archive = {
      ok: true,
      changeId: normalized.changeId,
      status: 'DRY-RUN',
      archived: false,
      skipSpecs,
      command: null,
      args: [],
      exitCode: null,
      rawStdoutPath: null,
      rawStderrPath: null,
      stdout: '',
      stderr: '',
      preArchiveStatus: null,
      warnings: [
        {
          code: 'archive-skipped',
          message: 'Archive did not run because dry-run or summary-only mode was explicitly requested.'
        }
      ],
      errors: []
    };

    await writeArchiveEvidence(normalized.changeId, archive, { ...options, rootDir });
    return archive;
  }

  const detectOpenSpec = options.detectOpenSpec ?? defaultDetectOpenSpec;
  const detection = await detectOpenSpec(createRunOptions(options, rootDir));

  if (!detection?.available || !detection?.canArchive) {
    const archive = createArchiveFailure({
      changeId: normalized.changeId,
      skipSpecs,
      error: {
        code: 'openspec-cli-required-for-archive',
        message: 'OpenSpec CLI is required to archive this change.',
        detail: detection?.errors?.[0]?.message ?? detection?.reason ?? null
      }
    });
    await writeArchiveEvidence(normalized.changeId, archive, { ...options, rootDir });
    return archive;
  }

  const preArchiveStatus = await readPreArchiveStatus(normalized.changeId, options, rootDir);
  const archiveOpenSpecChange = options.archiveOpenSpecChange ?? defaultArchiveOpenSpecChange;
  const archiveOptions = createRunOptions(options, rootDir);

  if (skipSpecs) {
    archiveOptions.skipSpecs = true;
  }

  if (options.noValidate) {
    archiveOptions.noValidate = true;
  }

  const rawArchive = await archiveOpenSpecChange(normalized.changeId, archiveOptions);
  const archive = normalizeArchiveResult(normalized.changeId, rawArchive, {
    rootDir,
    skipSpecs,
    preArchiveStatus
  });

  await writeArchiveEvidence(normalized.changeId, archive, { ...options, rootDir });

  return archive;
}

export async function writeDoneSummary(changeId, summary, options = {}) {
  const rootDir = resolveRootDir(options);
  const normalized = normalizeChangeId(changeId);

  if (!normalized.ok) {
    throw new Error(normalized.error.message);
  }

  const qaPath = options.qaPath !== undefined
    ? path.resolve(options.qaPath)
    : path.join(rootDir, DEFAULT_QA_DIR, normalized.changeId);
  const statePath = options.statePath !== undefined
    ? path.resolve(options.statePath)
    : path.join(rootDir, DEFAULT_STATE_DIR, normalized.changeId);

  assertSafeRuntimePath(rootDir, qaPath, 'QA evidence path');
  assertSafeRuntimePath(rootDir, statePath, 'State summary path');

  await mkdir(qaPath, { recursive: true });
  await mkdir(statePath, { recursive: true });

  const donePath = path.join(qaPath, DONE_MARKDOWN);
  const finalSummaryPath = path.join(statePath, FINAL_SUMMARY_MARKDOWN);
  await writeFile(donePath, `${renderDoneMarkdown(normalized.changeId, summary)}\n`, 'utf8');
  await writeFile(finalSummaryPath, `${renderFinalSummaryMarkdown(summary)}\n`, 'utf8');

  return {
    ok: true,
    changeId: normalized.changeId,
    files: [
      toPosix(path.relative(rootDir, donePath)),
      toPosix(path.relative(rootDir, finalSummaryPath))
    ],
    warnings: [],
    errors: []
  };
}

export async function detectWorkingTreeState(options = {}) {
  const rootDir = resolveRootDir(options);
  const gitStatus = options.gitStatus ?? defaultGitStatus;
  let status;

  try {
    status = await gitStatus({ cwd: rootDir });
  } catch (err) {
    if (err?.code === 'ENOENT') {
      return createNonGitWorkingTree(err.message);
    }

    throw err;
  }

  const exitCode = status?.exitCode ?? 0;
  const stdout = normalizeOutput(status?.stdout);
  const stderr = normalizeOutput(status?.stderr);

  if (exitCode !== 0) {
    if (/not a git repository/i.test(stderr) || /not a git repository/i.test(stdout)) {
      return createNonGitWorkingTree(stderr || stdout);
    }

    return {
      ok: false,
      isGitRepo: true,
      dirty: false,
      entries: [],
      warnings: [],
      errors: [
        {
          code: 'git-status-failed',
          message: 'Unable to inspect working tree state.',
          detail: stderr || stdout || null
        }
      ]
    };
  }

  const entries = stdout.split(/\r?\n/).filter((line) => line.length > 0);
  const dirty = entries.length > 0;

  if (!dirty) {
    return {
      ok: true,
      isGitRepo: true,
      dirty: false,
      entries: [],
      warnings: [],
      errors: []
    };
  }

  if (options.allowDirty || options.recordDirtyState) {
    return {
      ok: true,
      isGitRepo: true,
      dirty: true,
      entries,
      warnings: [
        {
          code: 'dirty-working-tree-recorded',
          message: 'Working tree dirty state was recorded because explicit dirty-state recording is enabled.'
        }
      ],
      errors: []
    };
  }

  return {
    ok: false,
    isGitRepo: true,
    dirty: true,
    entries,
    warnings: [],
    errors: [
      {
        code: 'dirty-working-tree',
        message: 'Working tree has uncommitted changes. Commit/stash or run with explicit dirty-state recording.'
      }
    ]
  };
}

export function summarizeDoneResult(result, options = {}) {
  const status = result?.status ?? (result?.ok ? 'PASS' : 'FAIL');
  const changeId = result?.changeId ?? '<change-id>';
  const archived = result?.archive?.archived ? 'yes' : 'no';
  const skipSpecs = result?.archive?.skipSpecs ? 'yes' : 'no';
  const lines = [
    `Finalization status: ${status}`,
    `Change: ${changeId}`,
    `Archived: ${archived}`,
    `Skip specs: ${skipSpecs}`
  ];

  if (Array.isArray(result?.summaryFiles) && result.summaryFiles.length > 0) {
    lines.push('Summary files:');
    lines.push(...result.summaryFiles.map((file) => `- ${file}`));
  }

  if (options.includeErrors && Array.isArray(result?.errors) && result.errors.length > 0) {
    lines.push('Errors:');
    lines.push(...result.errors.map((error) => `- ${error.code}: ${error.message}`));
  }

  return lines.join('\n');
}

async function writeArchiveEvidence(changeId, archive, options = {}) {
  const rootDir = resolveRootDir(options);
  const qaPath = resolveQaPath(rootDir, changeId, options);
  assertSafeRuntimePath(rootDir, qaPath, 'QA evidence path');

  const rawDir = path.join(qaPath, 'raw');
  await mkdir(rawDir, { recursive: true });

  const stdout = normalizeOutput(archive.stdout);
  const stderr = normalizeOutput(archive.stderr);
  const stdoutPath = archive.command !== null
    ? path.join(rawDir, 'openspec-archive.stdout')
    : null;
  const stderrPath = archive.command !== null
    ? path.join(rawDir, 'openspec-archive.stderr')
    : null;

  if (stdoutPath !== null) {
    await writeFile(stdoutPath, stdout, 'utf8');
  }

  if (stderrPath !== null) {
    await writeFile(stderrPath, stderr, 'utf8');
  }

  const evidence = {
    changeId,
    archived: Boolean(archive.archived),
    skipSpecs: Boolean(archive.skipSpecs),
    command: archive.command,
    args: Array.from(archive.args ?? []),
    exitCode: archive.exitCode ?? null,
    ok: Boolean(archive.ok),
    status: archive.status ?? (archive.ok ? 'PASS' : 'FAIL'),
    preArchiveStatus: archive.preArchiveStatus ?? null,
    rawStdoutPath: stdoutPath === null ? null : toPosix(path.relative(rootDir, stdoutPath)),
    rawStderrPath: stderrPath === null ? null : toPosix(path.relative(rootDir, stderrPath)),
    error: archive.error ?? null,
    warnings: archive.warnings ?? [],
    errors: archive.errors ?? []
  };

  await writeFile(path.join(qaPath, ARCHIVE_JSON), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');

  archive.rawStdoutPath = evidence.rawStdoutPath;
  archive.rawStderrPath = evidence.rawStderrPath;

  return {
    ok: true,
    path: toPosix(path.relative(rootDir, path.join(qaPath, ARCHIVE_JSON)))
  };
}

async function readPreArchiveStatus(changeId, options, rootDir) {
  const getOpenSpecStatus = options.getOpenSpecStatus ?? defaultGetOpenSpecStatus;

  try {
    const status = await getOpenSpecStatus(changeId, createRunOptions(options, rootDir));
    return {
      ok: Boolean(status?.ok),
      command: status?.command ?? null,
      args: Array.from(status?.args ?? []),
      exitCode: status?.exitCode ?? null,
      json: status?.json ?? null,
      stdout: normalizeOutput(status?.stdout),
      stderr: normalizeOutput(status?.stderr),
      error: status?.error ?? null
    };
  } catch (err) {
    return {
      ok: false,
      command: 'openspec',
      args: ['status', '--change', changeId, '--json', '--no-color'],
      exitCode: null,
      json: null,
      stdout: '',
      stderr: '',
      error: {
        code: err?.code ?? 'openspec-status-failed',
        message: err?.message ?? 'OpenSpec status failed before archive.'
      }
    };
  }
}

function normalizeArchiveResult(changeId, result, { skipSpecs, preArchiveStatus }) {
  const ok = Boolean(result?.ok);
  const error = result?.error ?? null;
  const warnings = [];

  if (preArchiveStatus !== null && preArchiveStatus.ok === false) {
    warnings.push({
      code: 'openspec-status-unavailable',
      message: 'OpenSpec status was unavailable before archive; archive result is still authoritative.',
      detail: preArchiveStatus.error?.message ?? null
    });
  }

  return {
    ok,
    changeId,
    status: ok ? 'PASS' : 'FAIL',
    archived: ok,
    skipSpecs,
    command: result?.command ?? 'openspec',
    args: Array.from(result?.args ?? []),
    exitCode: result?.exitCode ?? null,
    stdout: normalizeOutput(result?.stdout),
    stderr: normalizeOutput(result?.stderr),
    rawStdoutPath: null,
    rawStderrPath: null,
    preArchiveStatus,
    error,
    warnings,
    errors: ok ? [] : [
      error ?? {
        code: 'openspec-archive-failed',
        message: 'OpenSpec archive command failed.'
      }
    ]
  };
}

function createArchiveFailure({ changeId, skipSpecs, error }) {
  return {
    ok: false,
    changeId,
    status: 'FAIL',
    archived: false,
    skipSpecs,
    command: null,
    args: [],
    exitCode: null,
    stdout: '',
    stderr: '',
    rawStdoutPath: null,
    rawStderrPath: null,
    preArchiveStatus: null,
    error,
    warnings: [],
    errors: [error]
  };
}

function createSkippedArchiveSummary(changeId, options, reason) {
  return {
    ok: false,
    changeId,
    status: 'SKIPPED',
    archived: false,
    skipSpecs: Boolean(options?.skipSpecs),
    command: null,
    args: [],
    exitCode: null,
    rawStdoutPath: null,
    rawStderrPath: null,
    warnings: [
      {
        code: reason,
        message: 'Archive did not run.'
      }
    ],
    errors: []
  };
}

function createFinalizeFailure({ context, workingTree, archive, errors }) {
  return {
    ok: false,
    mode: MODE,
    changeId: context.changeId,
    status: 'FAIL',
    context,
    verification: context.verification,
    workingTree,
    archive,
    commitMessage: createCommitMessage(context.changeId),
    prSummary: createPrSummary({
      changeId: context.changeId,
      context,
      archive
    }),
    warnings: dedupeDiagnostics([
      ...context.warnings,
      ...(workingTree?.warnings ?? []),
      ...(archive?.warnings ?? [])
    ]),
    errors,
    summaryFiles: []
  };
}

function createVerificationFailure({ changeId, code, message, evidence }) {
  return {
    ok: false,
    changeId,
    passed: false,
    verification: normalizeVerificationSummary(evidence, false),
    warnings: evidence?.warnings ?? [],
    errors: [
      {
        code,
        message
      }
    ]
  };
}

function normalizeVerificationSummary(evidence, passed) {
  return {
    exists: Boolean(evidence?.verify?.exists || evidence?.validation),
    passed,
    validation: evidence?.validation ?? null,
    status: evidence?.status ?? null,
    verify: {
      exists: Boolean(evidence?.verify?.exists),
      path: evidence?.verify?.path ?? null,
      content: evidence?.verify?.content ?? ''
    },
    warnings: evidence?.warnings ?? [],
    errors: evidence?.errors ?? []
  };
}

function hasFinalPassSignal(content) {
  return /\bVerdict:\s*PASS(?:-with-notes)?\b/i.test(content)
    || /\b\/aif-verify:\s*PASS\b/i.test(content)
    || /\bCode verification:\s*PASS\b/i.test(content);
}

async function detectOpenSpecCapability(options, rootDir) {
  const detectOpenSpec = options.detectOpenSpec ?? defaultDetectOpenSpec;

  try {
    const detection = await detectOpenSpec(createRunOptions(options, rootDir));
    return {
      openspec: {
        available: Boolean(detection?.available),
        canArchive: Boolean(detection?.canArchive),
        canValidate: Boolean(detection?.canValidate),
        version: detection?.version ?? null,
        command: detection?.command ?? 'openspec',
        reason: detection?.reason ?? null,
        errors: detection?.errors ?? []
      },
      warnings: [],
      errors: []
    };
  } catch (err) {
    return {
      openspec: {
        available: false,
        canArchive: false,
        canValidate: false,
        version: null,
        command: 'openspec',
        reason: 'detection-failed',
        errors: [
          {
            code: err?.code ?? 'openspec-detection-failed',
            message: err?.message ?? 'OpenSpec detection failed.'
          }
        ]
      },
      warnings: [
        {
          code: 'openspec-detection-failed',
          message: 'OpenSpec detection failed; archive may not be available.'
        }
      ],
      errors: []
    };
  }
}

async function collectRuntimeTraces(rootDir, statePath) {
  const implementation = await collectTextFiles(rootDir, path.join(statePath, 'implementation'));
  const fixes = await collectTextFiles(rootDir, path.join(statePath, 'fixes'));

  return {
    runtimeTraces: [...fixes, ...implementation].sort((left, right) => left.path.localeCompare(right.path)),
    warnings: [],
    errors: []
  };
}

async function collectTextFiles(rootDir, directoryPath) {
  if (!await isDirectory(directoryPath)) {
    return [];
  }

  const paths = [];
  await collectFilePaths(directoryPath, paths);
  const sorted = paths.sort((left, right) => toPosix(path.relative(rootDir, left)).localeCompare(toPosix(path.relative(rootDir, right))));
  const result = [];

  for (const filePath of sorted) {
    result.push({
      path: toPosix(path.relative(rootDir, filePath)),
      content: await readFile(filePath, 'utf8')
    });
  }

  return result;
}

async function collectFilePaths(directoryPath, filePaths) {
  const entries = await readdir(directoryPath, { withFileTypes: true });

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const childPath = path.join(directoryPath, entry.name);

    if (entry.isDirectory()) {
      await collectFilePaths(childPath, filePaths);
    } else if (entry.isFile()) {
      filePaths.push(childPath);
    }
  }
}

async function detectArchivedFromFailedResolution(rootDir, changeIdInput, resolverResult) {
  if (
    resolverResult?.errors?.[0]?.code !== 'explicit-change-not-found'
    || changeIdInput === undefined
    || changeIdInput === null
  ) {
    return null;
  }

  const normalized = normalizeChangeId(String(changeIdInput));

  if (!normalized.ok) {
    return null;
  }

  return findArchivedChange(rootDir, normalized.changeId);
}

async function detectArchivedActiveChange(rootDir, resolverResult) {
  const archiveDir = path.join(rootDir, 'openspec', 'changes', 'archive');
  const changePath = resolverResult?.changePath;

  if (typeof changePath === 'string' && isWithinDirectory(path.resolve(changePath), archiveDir)) {
    return {
      changeId: resolverResult.changeId,
      path: toPosix(path.relative(rootDir, changePath))
    };
  }

  if (!await pathExists(changePath)) {
    return findArchivedChange(rootDir, resolverResult.changeId);
  }

  return null;
}

async function findArchivedChange(rootDir, changeId) {
  const archiveDir = path.join(rootDir, 'openspec', 'changes', 'archive');

  if (!await isDirectory(archiveDir)) {
    return null;
  }

  const matches = [];
  await collectArchivedMatches(rootDir, archiveDir, changeId, matches);
  matches.sort((left, right) => left.path.localeCompare(right.path));
  return matches[0] ?? null;
}

async function collectArchivedMatches(rootDir, directoryPath, changeId, matches) {
  const entries = await readdir(directoryPath, { withFileTypes: true });

  for (const entry of entries) {
    const childPath = path.join(directoryPath, entry.name);

    if (!entry.isDirectory()) {
      continue;
    }

    if (entry.name === changeId) {
      matches.push({
        changeId,
        path: toPosix(path.relative(rootDir, childPath))
      });
    }

    await collectArchivedMatches(rootDir, childPath, changeId, matches);
  }
}

async function readExistingFinalSummaries(rootDir, changeId) {
  const candidates = [
    path.join(rootDir, DEFAULT_QA_DIR, changeId, DONE_MARKDOWN),
    path.join(rootDir, DEFAULT_STATE_DIR, changeId, FINAL_SUMMARY_MARKDOWN)
  ];
  const summaries = [];

  for (const filePath of candidates) {
    if (!await pathExists(filePath)) {
      continue;
    }

    summaries.push({
      path: toPosix(path.relative(rootDir, filePath)),
      content: await readFile(filePath, 'utf8')
    });
  }

  return summaries;
}

function createContextFailure({ changeId, source, candidates = [], warnings = [], errors = [], existingSummaries = [] }) {
  return {
    ok: false,
    mode: MODE,
    changeId,
    resolver: {
      source: source ?? null,
      candidates,
      warnings
    },
    paths: {},
    verification: {
      exists: false,
      passed: false,
      validation: null,
      status: null,
      verify: {
        exists: false,
        path: null,
        content: ''
      }
    },
    openspec: {
      available: false,
      canArchive: false,
      canValidate: false,
      version: null,
      command: 'openspec',
      reason: null,
      errors: []
    },
    canonicalArtifacts: {},
    runtimeTraces: [],
    generatedRules: [],
    existingSummaries,
    warnings: dedupeDiagnostics(warnings),
    errors
  };
}

function createResolverSummary(result) {
  return {
    source: result?.source ?? null,
    candidates: result?.candidates ?? [],
    warnings: result?.warnings ?? []
  };
}

function createCommitMessage(changeId) {
  return `feat: finalize ${changeId}`;
}

function createPrSummary({ changeId, context, archive }) {
  const validationState = summarizeValidationState(context?.verification?.validation);
  const codeState = summarizeCodeState(context?.verification?.verify?.content);
  return [
    '## Summary',
    '',
    `- Finalized OpenSpec change \`${changeId}\`.`,
    `- Prepared final QA and state summaries for \`${changeId}\`.`,
    '',
    '## OpenSpec',
    '',
    `- Change: ${changeId}`,
    `- Archived: ${archive?.archived ? 'yes' : 'no'}`,
    `- Skip specs: ${archive?.skipSpecs ? 'yes' : 'no'}`,
    '',
    '## Verification',
    '',
    '- /aif-verify: PASS',
    `- OpenSpec validation: ${validationState}`,
    `- Code verification: ${codeState}`,
    '',
    '## Artifacts',
    '',
    `- .ai-factory/qa/${changeId}/done.md`,
    `- .ai-factory/qa/${changeId}/openspec-archive.json`,
    `- .ai-factory/state/${changeId}/final-summary.md`,
    ''
  ].join('\n');
}

function renderDoneMarkdown(changeId, summary) {
  const context = summary.context ?? {};
  const archive = summary.archive ?? {};
  const verificationGate = context?.verification?.passed ? 'PASS' : 'FAIL';
  const finalizationStatus = summary.status ?? (summary.ok ? 'PASS' : 'FAIL');
  const canonicalPaths = collectCanonicalArtifactPaths(context.canonicalArtifacts);
  const qaEvidencePaths = collectQaEvidencePaths(changeId, context.verification);
  const runtimeTracePaths = Array.isArray(context.runtimeTraces)
    ? context.runtimeTraces.map((trace) => trace.path)
    : [];

  return [
    `# Done: ${changeId}`,
    '',
    '## Finalization status',
    '',
    finalizationStatus,
    '',
    '## Verification gate',
    '',
    verificationGate,
    '',
    '## OpenSpec archive',
    '',
    `Archived: ${archive.archived ? 'yes' : 'no'}`,
    `Skip specs: ${archive.skipSpecs ? 'yes' : 'no'}`,
    '',
    '## Canonical artifacts finalized',
    '',
    ...renderList(canonicalPaths),
    '',
    '## QA evidence',
    '',
    ...renderList(qaEvidencePaths),
    '',
    '## Runtime traces',
    '',
    ...renderList(runtimeTracePaths),
    '',
    '## Working tree',
    '',
    ...renderList(summary.workingTree?.entries ?? ['clean']),
    '',
    '## Suggested commit message',
    '',
    summary.commitMessage ?? createCommitMessage(changeId),
    '',
    '## Suggested PR summary',
    '',
    summary.prSummary ?? createPrSummary({ changeId, context, archive })
  ].join('\n');
}

function renderFinalSummaryMarkdown(summary) {
  return [
    `# Final Summary: ${summary.changeId}`,
    '',
    '## Suggested commit message',
    '',
    summary.commitMessage ?? createCommitMessage(summary.changeId),
    '',
    '## Suggested PR summary',
    '',
    summary.prSummary ?? ''
  ].join('\n');
}

function collectCanonicalArtifactPaths(canonicalArtifacts = {}) {
  const paths = [];

  for (const key of ['proposal', 'design', 'tasks']) {
    if (canonicalArtifacts?.[key]?.path !== undefined) {
      paths.push(canonicalArtifacts[key].path);
    }
  }

  for (const listKey of ['baseSpecs', 'deltaSpecs']) {
    for (const item of canonicalArtifacts?.[listKey] ?? []) {
      paths.push(item.path);
    }
  }

  return paths;
}

function collectQaEvidencePaths(changeId, verification) {
  const paths = [
    verification?.verify?.path,
    `.ai-factory/qa/${changeId}/${ARCHIVE_JSON}`,
    `.ai-factory/qa/${changeId}/${DONE_MARKDOWN}`
  ].filter(Boolean);

  if (verification?.validation !== null && verification?.validation !== undefined) {
    paths.push(`.ai-factory/qa/${changeId}/openspec-validation.json`);
  }

  if (verification?.status !== null && verification?.status !== undefined) {
    paths.push(`.ai-factory/qa/${changeId}/openspec-status.json`);
  }

  return Array.from(new Set(paths));
}

function summarizeValidationState(validation) {
  if (validation === null || validation === undefined) {
    return 'UNKNOWN';
  }

  if (validation.skipped && validation.ok) {
    return 'SKIPPED';
  }

  return validation.ok ? 'PASS' : 'FAIL';
}

function summarizeCodeState(content = '') {
  const match = String(content).match(/Code verification:\s*([A-Z-]+)/i);
  return match?.[1]?.toUpperCase() ?? 'UNKNOWN';
}

function renderList(values) {
  const items = Array.isArray(values) ? values.filter((value) => String(value).trim().length > 0) : [];

  if (items.length === 0) {
    return ['- none'];
  }

  return items.map((item) => `- ${item}`);
}

function createRunOptions(options, rootDir) {
  const runOptions = {
    cwd: rootDir,
    command: options.command,
    env: options.env,
    executor: options.executor,
    nodeVersion: options.nodeVersion
  };

  for (const key of Object.keys(runOptions)) {
    if (runOptions[key] === undefined) {
      delete runOptions[key];
    }
  }

  return runOptions;
}

function resolveQaPath(rootDir, changeId, options) {
  if (options.qaPath !== undefined) {
    return path.resolve(options.qaPath);
  }

  const qaRoot = path.resolve(rootDir, options.qaDir ?? DEFAULT_QA_DIR);
  return path.join(qaRoot, changeId);
}

async function defaultGitStatus({ cwd }) {
  try {
    const { stdout, stderr } = await execFileAsync('git', ['status', '--porcelain'], {
      cwd,
      windowsHide: true
    });

    return {
      exitCode: 0,
      stdout,
      stderr
    };
  } catch (err) {
    return {
      exitCode: typeof err?.code === 'number' ? err.code : (err?.status ?? 1),
      stdout: normalizeOutput(err?.stdout),
      stderr: normalizeOutput(err?.stderr ?? err?.message)
    };
  }
}

function createNonGitWorkingTree(detail) {
  return {
    ok: true,
    isGitRepo: false,
    dirty: false,
    entries: [],
    warnings: [
      {
        code: 'not-a-git-repository',
        message: 'Working tree state could not be checked because this is not a git repository.',
        detail
      }
    ],
    errors: []
  };
}

function assertSafeRuntimePath(rootDir, targetPath, label) {
  const resolvedRoot = path.resolve(rootDir);
  const resolvedTarget = path.resolve(targetPath);

  if (!isWithinDirectory(resolvedTarget, resolvedRoot)) {
    throw new Error(`${label} escapes repository root: ${resolvedTarget}`);
  }

  for (const forbiddenDir of [
    path.join(resolvedRoot, 'openspec', 'changes'),
    path.join(resolvedRoot, '.ai-factory', 'plans')
  ]) {
    if (isWithinDirectory(resolvedTarget, forbiddenDir)) {
      throw new Error(`${label} must stay outside canonical OpenSpec changes and legacy plan folders: ${resolvedTarget}`);
    }
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

async function isDirectory(targetPath) {
  try {
    const item = await stat(targetPath);
    return item.isDirectory();
  } catch {
    return false;
  }
}

function isWithinDirectory(targetPath, directoryPath) {
  const relative = path.relative(directoryPath, targetPath);
  return relative.length === 0 || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function resolveRootDir(options = {}) {
  return path.resolve(options.rootDir ?? process.cwd());
}

function normalizeOutput(value) {
  if (value === undefined || value === null) {
    return '';
  }

  return Buffer.isBuffer(value) ? value.toString('utf8') : String(value);
}

function toPosix(value) {
  return String(value).replaceAll('\\', '/');
}

function dedupeDiagnostics(diagnostics) {
  const seen = new Set();
  const result = [];

  for (const diagnostic of diagnostics) {
    const key = `${diagnostic?.code ?? ''}:${diagnostic?.message ?? ''}:${diagnostic?.path ?? ''}`;

    if (!seen.has(key)) {
      seen.add(key);
      result.push(diagnostic);
    }
  }

  return result;
}
