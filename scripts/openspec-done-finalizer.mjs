#!/usr/bin/env node
// openspec-done-finalizer.mjs - shared OpenSpec done/finalization runtime helpers
import { execFile } from 'node:child_process';
import { access, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ensureRuntimeGitignore } from './runtime-gitignore.mjs';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
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
import {
  getLatestGateResult,
  isLegacySuggestedNextOnPassReceipt
} from './aif-gate-result.mjs';
import {
  validateOpenSpecArtifactContract as defaultValidateOpenSpecArtifactContract
} from './openspec-artifact-validator.mjs';
import {
  readOpenSpecCoverageMatrix,
  summarizeOpenSpecCoverage
} from './openspec-coverage-matrix.mjs';
import {
  readOpenSpecPolicy,
  readOpenSpecRulesGateEvidence
} from './openspec-policy.mjs';
import {
  DONE_READINESS_FILE,
  buildOpenSpecDoneReadiness,
  summarizeOpenSpecDoneReadiness,
  writeOpenSpecDoneReadiness
} from './openspec-done-readiness.mjs';
import {
  updateRoadmapChangeLifecycle as defaultUpdateRoadmapChangeLifecycle
} from './roadmap-change-lifecycle.mjs';

const execFileAsync = promisify(execFile);
const MODE = 'openspec-native';
const DEFAULT_STATE_DIR = path.join('.ai-factory', 'state');
const DEFAULT_QA_DIR = path.join('.ai-factory', 'qa');
const DEFAULT_CONFIG_PATH = path.join('.ai-factory', 'config.yaml');
const DEFAULT_ROADMAP_PATH = path.join('.ai-factory', 'ROADMAP.md');
const ARCHIVE_JSON = 'openspec-archive.json';
const DONE_MARKDOWN = 'done.md';
const FINAL_SUMMARY_MARKDOWN = 'final-summary.md';
const ROADMAP_HANDOFF_COMMAND = '/aif-roadmap check';
const ROADMAP_OUTCOME_STATUSES = new Set(['updated', 'handoff', 'skipped']);
const PUBLIC_COMMAND_SOURCES = new Set(['explicit', 'project-local', 'path']);
const FINALIZER_BYPASS_OPTIONS = new Set([
  '--force',
  '--no-validate',
  '--skip-archive',
  '--dry-run',
  '--summary-only'
]);
const MAX_PUBLIC_DIAGNOSTICS = 50;

export function parseDoneFinalizerArgs(argv) {
  const args = Array.from(argv ?? []);
  const parsed = {
    ok: true,
    changeId: null,
    skipSpecs: false,
    recordDirtyState: false,
    json: false
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === '--change') {
      const value = args[index + 1];
      if (value === undefined || String(value).trim().length === 0 || String(value).startsWith('--')) {
        return invalidFinalizerArgs('Missing value for --change.');
      }
      parsed.changeId = String(value);
      index += 1;
      continue;
    }

    if (arg === '--skip-specs') {
      parsed.skipSpecs = true;
      continue;
    }

    if (arg === '--record-dirty-state') {
      parsed.recordDirtyState = true;
      continue;
    }

    if (arg === '--json') {
      parsed.json = true;
      continue;
    }

    if (FINALIZER_BYPASS_OPTIONS.has(arg)) {
      return invalidFinalizerArgs(`Unsupported finalizer option: ${arg}.`);
    }

    return invalidFinalizerArgs(`Unknown option: ${arg}.`);
  }

  return parsed;
}

export async function runDoneFinalizerCommand(argv, options = {}) {
  const parsed = parseDoneFinalizerArgs(argv);
  if (!parsed.ok) {
    return {
      exitCode: 2,
      stdout: '',
      stderr: `${parsed.error}\n`
    };
  }

  const finalize = options.finalizeOpenSpecChange ?? finalizeOpenSpecChange;
  const finalizerOptions = {
    ...options,
    changeId: parsed.changeId ?? options.changeId,
    skipSpecs: parsed.skipSpecs || Boolean(options.skipSpecs),
    recordDirtyState: parsed.recordDirtyState || Boolean(options.recordDirtyState)
  };
  delete finalizerOptions.finalizeOpenSpecChange;
  delete finalizerOptions.force;
  delete finalizerOptions.noValidate;
  delete finalizerOptions.skipArchive;
  delete finalizerOptions.dryRun;
  delete finalizerOptions.summaryOnly;

  let result;
  try {
    result = await finalize(finalizerOptions);
  } catch {
    return {
      exitCode: 2,
      stdout: '',
      stderr: 'Done finalizer command failed unexpectedly.\n'
    };
  }

  const unresolved = result?.changeId === null || result?.changeId === undefined;
  const stdout = parsed.json
    ? `${JSON.stringify(projectDoneFinalizerResult(result), null, 2)}\n`
    : `${summarizeDoneResult(result, { includeErrors: !result?.ok })}\n`;

  return {
    exitCode: unresolved ? 2 : result?.ok ? 0 : 1,
    stdout,
    stderr: ''
  };
}

export function projectDoneFinalizerResult(result) {
  const command = selectOpenSpecCommandDiagnostic(result);
  const readiness = result?.readiness ?? null;
  const workingTree = result?.workingTree ?? null;
  const archive = result?.archive ?? null;
  const roadmap = normalizeRoadmapOutcome(
    result?.roadmap ?? createSkippedRoadmapOutcome('archive-not-successful')
  );

  return {
    ok: Boolean(result?.ok),
    mode: boundedPublicText(result?.mode ?? MODE, 80),
    change_id: normalizePublicChangeId(result?.changeId),
    status: boundedPublicText(result?.status ?? (result?.ok ? 'PASS' : 'FAIL'), 40),
    readiness: readiness === null ? null : {
      status: boundedPublicText(readiness.status ?? 'unknown', 40),
      blocking: Boolean(readiness.blocking),
      suggested_next: normalizeSuggestedNext(readiness.suggested_next)
    },
    working_tree: workingTree === null ? null : {
      ok: Boolean(workingTree.ok),
      is_git_repo: Boolean(workingTree.isGitRepo),
      dirty: Boolean(workingTree.dirty),
      recorded: isDirtyStateRecorded(workingTree),
      entry_count: Math.min(Array.isArray(workingTree.entries) ? workingTree.entries.length : 0, 1000000)
    },
    archive: archive === null ? null : {
      status: boundedPublicText(archive.status ?? 'unknown', 40),
      archived: Boolean(archive.archived),
      skip_specs: Boolean(archive.skipSpecs),
      command: command.command,
      command_source: command.commandSource
    },
    roadmap: {
      status: roadmap.status,
      reason: roadmap.reason,
      path: roadmap.path,
      changed: roadmap.changed,
      suggested_next: roadmap.suggestedNext === null
        ? null
        : {
          command: ROADMAP_HANDOFF_COMMAND,
          reason: roadmap.reason
        }
    },
    summary_files: normalizePublicPaths(result?.summaryFiles),
    commit_message: boundedPublicText(result?.commitMessage ?? '', 300),
    warnings: normalizePublicDiagnostics(result?.warnings),
    errors: normalizePublicDiagnostics(result?.errors)
  };
}

export async function finalizeOpenSpecChange(options = {}) {
  const rootDir = resolveRootDir(options);
  const context = await buildDoneContext({ ...options, rootDir });
  const readiness = shouldSkipReadinessForContext(context)
    ? null
    : await buildAndWriteDoneReadiness({
      ...options,
      rootDir,
      policy: context.effectivePolicy
    });

  if (!context.ok) {
    const archive = createSkippedArchiveSummary(
      context.changeId,
      options,
      readiness?.blocking ? 'done-readiness-failed' : 'context-failed'
    );
    return {
      ...context,
      status: 'FAIL',
      readiness,
      archive,
      roadmap: createSkippedRoadmapOutcome('archive-not-successful'),
      workingTree: readiness?.context?.workingTree ?? null,
      commitMessage: context.changeId ? createCommitMessage(context.changeId) : '',
      prSummary: context.changeId
        ? createPrSummary({
          changeId: context.changeId,
          context,
          archive,
          readiness
        })
        : '',
      warnings: dedupeDiagnostics([
        ...(context.warnings ?? []),
        ...readinessWarnings(readiness),
        ...archive.warnings
      ]),
      errors: dedupeDiagnostics([
        ...(context.errors ?? []),
        ...readinessErrors(readiness)
      ]),
      summaryFiles: []
    };
  }

  if (readiness?.blocking) {
    return createFinalizeFailure({
      context,
      readiness,
      workingTree: readiness?.context?.workingTree ?? null,
      archive: createSkippedArchiveSummary(context.changeId, options, 'done-readiness-failed'),
      errors: readinessErrors(readiness)
    });
  }

  const workingTree = readiness?.context?.workingTree ?? await detectWorkingTreeState({
    ...options,
    rootDir
  });

  if (!workingTree.ok) {
    return createFinalizeFailure({
      context,
      readiness,
      workingTree,
      archive: createSkippedArchiveSummary(context.changeId, options, 'dirty-working-tree'),
      errors: workingTree.errors
    });
  }

  const archive = await archiveChangeWithOpenSpec(context.changeId, {
    ...options,
    rootDir,
    policy: context.effectivePolicy
  });

  const baseResult = {
    ok: archive.ok,
    mode: MODE,
    changeId: context.changeId,
    status: archive.ok ? archive.status : 'FAIL',
    context,
    verification: context.verification,
    readiness,
    workingTree,
    archive,
    roadmap: createSkippedRoadmapOutcome('archive-not-successful'),
    commitMessage: createCommitMessage(context.changeId),
    prSummary: createPrSummary({
      changeId: context.changeId,
      context,
      archive,
      readiness
    }),
    warnings: dedupeDiagnostics([
      ...context.warnings,
      ...readinessWarnings(readiness),
      ...workingTree.warnings,
      ...archive.warnings
    ]),
    errors: archive.errors,
    summaryFiles: []
  };

  if (!archive.ok) {
    return baseResult;
  }

  const roadmap = archive.archived
    ? await updateRoadmapAfterArchive(context, { ...options, rootDir })
    : createSkippedRoadmapOutcome('archive-not-performed');
  const finalizedResult = {
    ...baseResult,
    status: roadmap.status === 'handoff' ? 'WARN' : baseResult.status,
    roadmap,
    warnings: dedupeDiagnostics([
      ...baseResult.warnings,
      ...roadmapOutcomeWarnings(roadmap)
    ])
  };

  const summary = await writeDoneSummary(context.changeId, finalizedResult, {
    ...options,
    rootDir,
    qaPath: context.paths.qa,
    statePath: context.paths.state
  });

  return {
    ...finalizedResult,
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
  const effectivePolicy = options.policy ?? await readOpenSpecPolicy({ ...options, rootDir });
  const generatedRulesPolicy = classifyGeneratedRulesForDone(generatedRules, effectivePolicy);
  const verification = await assertVerificationPassed(resolverResult.changeId, {
    ...options,
    rootDir,
    qaPath: layout.qaPath
  });
  const coverage = await assertCoverageAcceptable(resolverResult.changeId, {
    ...options,
    rootDir,
    qaPath: layout.qaPath,
    policy: effectivePolicy
  });
  const rulesGate = await assertRulesGateAcceptable(resolverResult.changeId, {
    ...options,
    rootDir,
    qaPath: layout.qaPath,
    policy: effectivePolicy
  });
  const validateOpenSpecArtifactContract = options.validateOpenSpecArtifactContract ?? defaultValidateOpenSpecArtifactContract;
  const artifactContract = await validateOpenSpecArtifactContract({
    ...options,
    rootDir,
    changeId: resolverResult.changeId,
    requireVerificationEvidence: true
  });
  const runtimeTraces = await collectRuntimeTraces(rootDir, layout.statePath);
  const openspec = await detectOpenSpecCapability(options, rootDir);
  const openspecPolicy = classifyOpenSpecCliForDone(openspec, effectivePolicy);
  const warnings = dedupeDiagnostics([
    ...resolverResult.warnings,
    ...canonical.warnings,
    ...generatedRulesPolicy.warnings,
    ...verification.warnings,
    ...coverage.warnings,
    ...rulesGate.warnings,
    ...artifactContractWarnings(artifactContract),
    ...runtimeTraces.warnings,
    ...openspec.warnings,
    ...openspecPolicy.warnings,
    ...(effectivePolicy.diagnostics ?? [])
  ]);
  const errors = [
    ...canonical.errors,
    ...verification.errors,
    ...coverage.errors,
    ...rulesGate.errors,
    ...generatedRules.errors,
    ...generatedRulesPolicy.errors,
    ...artifactContractErrors(artifactContract),
    ...runtimeTraces.errors,
    ...openspec.errors,
    ...openspecPolicy.errors
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
    coverage: coverage.coverage,
    rulesGate: rulesGate.rulesGate,
    effectivePolicy,
    openspec: openspec.openspec,
    canonicalArtifacts: canonical.canonicalArtifacts,
    runtimeTraces: runtimeTraces.runtimeTraces,
    generatedRules: generatedRules.generatedRules,
    artifactContract,
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
  const gate = getVerificationGate(evidence, verifyContent);
  if (gate.missing) {
    return createVerificationFailure({
      changeId: normalized.changeId,
      code: 'verification-gate-missing',
      message: 'Verification evidence is missing the final aif-gate-result block for the verify gate.',
      evidence
    });
  }

  if (!gate.ok) {
    if (isLegacySuggestedNextOnPassReceipt(gate)) {
      return createVerificationFailure({
        changeId: normalized.changeId,
        code: 'verification-gate-legacy-suggested-next',
        message: 'Verification evidence contains a passing gate block with a non-null suggested_next written before or without following the null-on-pass contract; rerun /aif-verify once to rewrite the receipt.',
        evidence
      });
    }
    return createVerificationFailure({
      changeId: normalized.changeId,
      code: 'verification-gate-invalid',
      message: 'Verification evidence contains an invalid final aif-gate-result block for the verify gate.',
      evidence
    });
  }

  if (gate.result.status === 'fail') {
    return createVerificationFailure({
      changeId: normalized.changeId,
      code: 'verification-gate-failed',
      message: 'Refusing to archive because the latest verify gate result failed.',
      evidence
    });
  }

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

export async function assertCoverageAcceptable(changeId, options = {}) {
  const rootDir = resolveRootDir(options);
  const normalized = normalizeChangeId(changeId);

  if (!normalized.ok) {
    return createCoverageFailure({
      changeId: null,
      code: normalized.error.code,
      message: normalized.error.message,
      coverage: null
    });
  }

  const readCoverage = options.readOpenSpecCoverageMatrix ?? readOpenSpecCoverageMatrix;
  const policy = options.policy ?? await readOpenSpecPolicy({ ...options, rootDir });
  const requireCoverage = Boolean(policy.requirements?.specCoverage?.done);
  const allowCoverageWarn = Boolean(policy.allowWarnOnDone?.coverage);
  const coverage = await readCoverage(normalized.changeId, {
    ...options,
    rootDir
  });

  if (!coverage?.exists) {
    return createCoveragePolicyResult({
      blocking: requireCoverage,
      changeId: normalized.changeId,
      code: 'coverage-evidence-missing',
      message: `Run /aif-verify ${normalized.changeId} before /aif-done so coverage.json is generated.`,
      coverage
    });
  }

  if (!coverage.ok) {
    return createCoveragePolicyResult({
      blocking: requireCoverage,
      changeId: normalized.changeId,
      code: 'coverage-evidence-invalid',
      message: 'Refusing to archive because coverage evidence is invalid.',
      coverage
    });
  }

  if (coverage.stale) {
    return createCoveragePolicyResult({
      blocking: requireCoverage,
      changeId: normalized.changeId,
      code: 'coverage-evidence-stale',
      message: 'Refusing to archive because coverage evidence is stale. Rerun /aif-verify.',
      coverage
    });
  }

  if (coverage.coverage?.status === 'fail') {
    return createCoveragePolicyResult({
      blocking: requireCoverage,
      changeId: normalized.changeId,
      code: 'coverage-policy-failed',
      message: 'Refusing to archive because OpenSpec coverage policy failed.',
      coverage
    });
  }

  if (coverage.coverage?.status === 'warn' && !allowCoverageWarn) {
    return createCoveragePolicyResult({
      blocking: true,
      changeId: normalized.changeId,
      code: 'coverage-policy-warn',
      message: 'Refusing to archive because OpenSpec coverage completed with warnings and allowWarnOnDone.coverage is false.',
      coverage
    });
  }

  return {
    ok: true,
    changeId: normalized.changeId,
    coverage: coverage.coverage,
    warnings: coverage.coverage?.status === 'warn'
      ? [{
        code: 'coverage-policy-warn',
        message: 'OpenSpec coverage completed with warnings accepted by policy.'
      }]
      : [],
    errors: []
  };
}

export async function assertRulesGateAcceptable(changeId, options = {}) {
  const rootDir = resolveRootDir(options);
  const normalized = normalizeChangeId(changeId);

  if (!normalized.ok) {
    return createRulesGateFailure({
      changeId: null,
      code: normalized.error.code,
      message: normalized.error.message,
      rulesGate: null
    });
  }

  const policy = options.policy ?? await readOpenSpecPolicy({ ...options, rootDir });
  const rulesGate = await readOpenSpecRulesGateEvidence(normalized.changeId, {
    ...options,
    rootDir
  });
  const requireRulesPass = Boolean(policy.requirements?.rulesPass?.done);
  const allowRulesWarn = Boolean(policy.allowWarnOnDone?.rules);

  if (rulesGate.status === 'pass') {
    return {
      ok: true,
      changeId: normalized.changeId,
      rulesGate,
      warnings: [],
      errors: []
    };
  }

  if (rulesGate.status === 'warn' && allowRulesWarn) {
    return {
      ok: true,
      changeId: normalized.changeId,
      rulesGate,
      warnings: [{
        code: 'rules-gate-warn',
        message: 'Rules gate completed with warnings accepted by policy.',
        path: rulesGate.path
      }],
      errors: []
    };
  }

  const legacyRulesReceipt = rulesGate.status === 'invalid' && isLegacySuggestedNextOnPassReceipt(rulesGate?.gateResult);
  const rulesGatePolicyMessage = requireRulesPass
    ? `Refusing to archive because rules gate evidence is ${rulesGate.status}.`
    : `Rules gate evidence is ${rulesGate.status}; continuing because requireRulesPassForDone is false.`;

  return createRulesGatePolicyResult({
    blocking: requireRulesPass,
    changeId: normalized.changeId,
    code: legacyRulesReceipt ? 'rules-gate-legacy-suggested-next' : rulesGate.errors?.[0]?.code ?? `rules-gate-${rulesGate.status}`,
    message: legacyRulesReceipt
      ? 'Rules gate evidence contains a passing gate block with a non-null suggested_next written before or without following the null-on-pass contract; rerun /aif-rules-check and persist the receipt to rewrite it.'
      : rulesGate.errors?.[0]?.message ?? rulesGatePolicyMessage,
    rulesGate
  });
}

function createCoveragePolicyResult({ blocking, changeId, code, message, coverage }) {
  return blocking
    ? createCoverageFailure({ changeId, code, message, coverage })
    : {
      ok: true,
      changeId,
      coverage: coverage?.coverage ?? null,
      warnings: [
        ...(coverage?.warnings ?? []),
        {
          code,
          message
        }
      ],
      errors: []
    };
}

function createCoverageFailure({ changeId, code, message, coverage }) {
  return {
    ok: false,
    changeId,
    coverage: coverage?.coverage ?? null,
    warnings: coverage?.warnings ?? [],
    errors: [
      {
        code,
        message
      }
    ]
  };
}

function createRulesGatePolicyResult({ blocking, changeId, code, message, rulesGate }) {
  return blocking
    ? createRulesGateFailure({ changeId, code, message, rulesGate })
    : {
      ok: true,
      changeId,
      rulesGate,
      warnings: [
        ...(rulesGate?.warnings ?? []),
        {
          code,
          message,
          path: rulesGate?.path
        }
      ],
      errors: []
    };
}

function createRulesGateFailure({ changeId, code, message, rulesGate }) {
  return {
    ok: false,
    changeId,
    rulesGate,
    warnings: rulesGate?.warnings ?? [],
    errors: [
      {
        code,
        message,
        path: rulesGate?.path
      }
    ]
  };
}

function classifyGeneratedRulesForDone(generatedRules, policy) {
  const diagnostics = generatedRules?.warnings ?? [];
  if (diagnostics.length === 0) {
    return { warnings: [], errors: [] };
  }

  const required = Boolean(policy?.requirements?.generatedRules?.done);
  return required
    ? {
      warnings: [],
      errors: diagnostics.map((diagnostic) => ({
        ...diagnostic,
        message: `${diagnostic.message} Refusing to archive until generated rules are current.`
      }))
    }
    : { warnings: diagnostics, errors: [] };
}

function classifyOpenSpecCliForDone(openspec, policy) {
  const required = Boolean(policy?.requirements?.cli?.done);
  const summary = openspec?.openspec ?? {};
  if (!required || summary.canArchive) {
    return { warnings: [], errors: [] };
  }

  return {
    warnings: [],
    errors: [{
      code: 'openspec-cli-required-for-done',
      message: 'OpenSpec CLI archive capability is required for /aif-done under current policy.',
      detail: summary.errors?.[0]?.message ?? summary.reason ?? null
    }]
  };
}

function artifactContractWarnings(result) {
  if (!result || result.status !== 'warn') {
    return [];
  }

  return (result.checks ?? [])
    .filter((check) => check.status === 'warn')
    .map((check) => ({
      code: `artifact-contract-${check.id}`,
      message: check.message,
      path: check.path ?? undefined
    }));
}

function artifactContractErrors(result) {
  if (!result || result.status !== 'fail') {
    return [];
  }

  return [
    {
      code: 'artifact-contract-failed',
      message: 'Refusing to archive because AIFHub OpenSpec artifact contract validation failed.',
      checks: (result.checks ?? []).filter((check) => check.status === 'fail')
    }
  ];
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
  const policy = options.policy ?? await readOpenSpecPolicy({ ...options, rootDir });

  if (options.skipArchive || options.dryRun || options.summaryOnly) {
    const archive = {
      ok: true,
      changeId: normalized.changeId,
      status: 'DRY-RUN',
      archived: false,
      skipSpecs,
      command: null,
      commandSource: null,
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
  if (preArchiveStatus !== null && preArchiveStatus.ok === false && !policy.allowWarnOnDone?.openspecStatus) {
    const archive = createArchiveFailure({
      changeId: normalized.changeId,
      skipSpecs,
      error: {
        code: 'openspec-status-warning-blocked',
        message: 'OpenSpec status returned warnings before archive and allowWarnOnDone.openspecStatus is false.',
        detail: preArchiveStatus.error?.message ?? null
      }
    });
    archive.preArchiveStatus = preArchiveStatus;
    await writeArchiveEvidence(normalized.changeId, archive, { ...options, rootDir });
    return archive;
  }
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

  await ensureRuntimeGitignore(rootDir, options.qaPath !== undefined ? qaPath : path.dirname(qaPath));
  await ensureRuntimeGitignore(rootDir, options.statePath !== undefined ? statePath : path.dirname(statePath));
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
  const readinessStatus = result?.readiness?.status ? String(result.readiness.status).toUpperCase() : null;
  const command = selectOpenSpecCommandDiagnostic(result);
  const roadmap = normalizeRoadmapOutcome(
    result?.roadmap ?? createSkippedRoadmapOutcome('archive-not-successful')
  );
  const lines = [
    `Finalization status: ${boundedPublicText(status, 40)}`,
    `Change: ${boundedPublicText(changeId, 200)}`,
    `Archived: ${archived}`,
    `Skip specs: ${skipSpecs}`,
    `Roadmap lifecycle: ${roadmap.status}`,
    `Roadmap reason: ${roadmap.reason}`
  ];

  if (roadmap.path !== null) {
    lines.push(`Roadmap path: ${roadmap.path}`);
  }
  if (roadmap.suggestedNext !== null) {
    lines.push(`Suggested next: ${ROADMAP_HANDOFF_COMMAND}`);
    lines.push(`Reason: ${roadmap.reason}`);
  }

  if (readinessStatus !== null) {
    lines.push(`Done readiness: ${boundedPublicText(readinessStatus, 40)}`);
  }

  if (command.command !== null) {
    const source = command.commandSource === null ? '' : ` (${command.commandSource})`;
    lines.push(`OpenSpec command: ${command.command}${source}`);
  }

  if (Array.isArray(result?.summaryFiles) && result.summaryFiles.length > 0) {
    const summaryFiles = normalizePublicPaths(result.summaryFiles);
    if (summaryFiles.length > 0) {
      lines.push('Summary files:');
      lines.push(...summaryFiles.map((file) => `- ${file}`));
    }
  }

  if (result?.readiness?.suggested_next) {
    const suggestedNext = normalizeSuggestedNext(result.readiness.suggested_next);
    if (suggestedNext !== null) {
      lines.push(`Suggested next: ${suggestedNext.command}`);
      lines.push(`Reason: ${suggestedNext.reason}`);
    }
  }

  if (options.includeErrors && Array.isArray(result?.errors) && result.errors.length > 0) {
    const errors = normalizePublicDiagnostics(result.errors);
    lines.push('Errors:');
    lines.push(...errors.map((error) => `- ${error.code}: ${error.message}`));
  }

  return lines.join('\n');
}

async function writeArchiveEvidence(changeId, archive, options = {}) {
  const rootDir = resolveRootDir(options);
  const qaPath = resolveQaPath(rootDir, changeId, options);
  assertSafeRuntimePath(rootDir, qaPath, 'QA evidence path');

  const rawDir = path.join(qaPath, 'raw');
  await ensureRuntimeGitignore(rootDir, options.qaPath !== undefined ? qaPath : path.dirname(qaPath));
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
    commandSource: archive.commandSource ?? null,
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
      commandSource: normalizeCommandSource(status?.commandSource),
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
      commandSource: 'path',
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
    commandSource: normalizeCommandSource(result?.commandSource) ?? 'path',
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
    commandSource: null,
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
    commandSource: null,
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

async function updateRoadmapAfterArchive(context, options = {}) {
  const rootDir = resolveRootDir(options);
  let roadmapPath;
  try {
    roadmapPath = await resolveConfiguredRoadmapPath(rootDir, options);
  } catch {
    return createRoadmapHandoffOutcome('roadmap-config-unreadable');
  }
  if (!roadmapPath.ok) {
    return createRoadmapHandoffOutcome(roadmapPath.reason);
  }

  const evidencePath = normalizePublicPath(toPosix(path.relative(
    rootDir,
    path.join(context.paths.qa, DONE_MARKDOWN)
  )));
  if (evidencePath === null) {
    return createRoadmapHandoffOutcome('evidence-path-invalid', roadmapPath.path);
  }

  const updateRoadmapChangeLifecycle = options.updateRoadmapChangeLifecycle
    ?? defaultUpdateRoadmapChangeLifecycle;
  let outcome;
  try {
    outcome = await updateRoadmapChangeLifecycle({
      rootDir,
      roadmapPath: roadmapPath.path,
      proposalContent: context.canonicalArtifacts?.proposal?.content ?? '',
      changeId: context.changeId,
      localState: 'finalized',
      evidencePath
    });
  } catch {
    return createRoadmapHandoffOutcome('roadmap-update-failed');
  }

  return normalizeRoadmapOutcome(outcome);
}

async function resolveConfiguredRoadmapPath(rootDir, options = {}) {
  if (options.roadmapPath !== undefined) {
    const explicitPath = normalizePublicPath(options.roadmapPath);
    return explicitPath === null
      ? { ok: false, path: null, reason: 'roadmap-path-invalid' }
      : { ok: true, path: explicitPath, reason: null };
  }

  const configPath = options.configPath === undefined
    ? path.join(rootDir, DEFAULT_CONFIG_PATH)
    : path.resolve(rootDir, options.configPath);
  assertSafeRuntimePath(rootDir, configPath, 'Project config path');

  let raw;
  try {
    raw = await readFile(configPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return {
        ok: true,
        path: toPosix(DEFAULT_ROADMAP_PATH),
        reason: null
      };
    }
    return { ok: false, path: null, reason: 'roadmap-config-unreadable' };
  }

  const parsed = parseConfiguredRoadmapPath(raw);
  if (!parsed.ok) {
    return parsed;
  }

  const roadmapPath = normalizePublicPath(parsed.path ?? toPosix(DEFAULT_ROADMAP_PATH));
  return roadmapPath === null
    ? { ok: false, path: null, reason: 'roadmap-path-invalid' }
    : { ok: true, path: roadmapPath, reason: null };
}

function parseConfiguredRoadmapPath(raw) {
  const lines = String(raw ?? '').replace(/^\uFEFF/, '').split(/\r?\n/);
  let pathsIndent = null;
  let pathsCount = 0;
  const values = [];

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) {
      continue;
    }

    const indentText = rawLine.match(/^\s*/)?.[0] ?? '';
    if (indentText.includes('\t')) {
      return { ok: false, path: null, reason: 'roadmap-config-invalid' };
    }
    const indent = indentText.length;

    if (indent === 0) {
      pathsIndent = null;
      const topLevel = rawLine.match(/^paths:\s*(?:#.*)?$/);
      if (topLevel) {
        pathsCount += 1;
        pathsIndent = indent;
        if (pathsCount > 1) {
          return { ok: false, path: null, reason: 'roadmap-config-invalid' };
        }
      }
      continue;
    }

    if (pathsIndent === null || indent <= pathsIndent) {
      continue;
    }

    const roadmapMatch = rawLine.match(/^\s+roadmap:\s*(.*?)\s*$/);
    if (!roadmapMatch) {
      continue;
    }
    const value = parseConfiguredString(roadmapMatch[1]);
    if (value === null) {
      return { ok: false, path: null, reason: 'roadmap-config-invalid' };
    }
    values.push(value);
  }

  if (values.length > 1) {
    return { ok: false, path: null, reason: 'roadmap-config-invalid' };
  }

  return {
    ok: true,
    path: values[0] ?? null,
    reason: null
  };
}

function parseConfiguredString(value) {
  const raw = stripYamlInlineComment(value).trim();
  if (raw.length === 0) {
    return null;
  }

  const first = raw[0];
  if (first === '"' || first === "'") {
    if (raw.length < 2 || raw.at(-1) !== first) {
      return null;
    }
    const unquoted = raw.slice(1, -1);
    return unquoted.length === 0 ? null : unquoted;
  }

  if (/^(?:null|~|true|false|[-+]?\d+(?:\.\d+)?)$/i.test(raw)) {
    return null;
  }
  return raw;
}

function stripYamlInlineComment(value) {
  let quote = null;
  const raw = String(value ?? '');

  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if ((char === '"' || char === "'") && (index === 0 || raw[index - 1] !== '\\')) {
      quote = quote === char ? null : quote ?? char;
      continue;
    }
    if (char === '#' && quote === null && (index === 0 || /\s/.test(raw[index - 1]))) {
      return raw.slice(0, index);
    }
  }

  return raw;
}

function normalizeRoadmapOutcome(value) {
  const status = String(value?.status ?? '');
  if (!ROADMAP_OUTCOME_STATUSES.has(status)) {
    return createRoadmapHandoffOutcome('roadmap-result-invalid');
  }

  const rawReason = String(value?.reason ?? '');
  const reason = /^[a-z0-9][a-z0-9-]{0,99}$/.test(rawReason)
    ? rawReason
    : 'roadmap-result-invalid';
  const pathValue = value?.path === null || value?.path === undefined
    ? null
    : normalizePublicPath(value.path);

  if (reason === 'roadmap-result-invalid'
    || (value?.path !== null && value?.path !== undefined && pathValue === null)
    || (status === 'updated' && pathValue === null)) {
    return createRoadmapHandoffOutcome('roadmap-result-invalid');
  }

  return {
    status,
    reason,
    path: pathValue,
    changed: status === 'updated',
    suggestedNext: status === 'handoff' ? ROADMAP_HANDOFF_COMMAND : null
  };
}

function createSkippedRoadmapOutcome(reason) {
  return {
    status: 'skipped',
    reason,
    path: null,
    changed: false,
    suggestedNext: null
  };
}

function createRoadmapHandoffOutcome(reason, roadmapPath = null) {
  return {
    status: 'handoff',
    reason,
    path: normalizePublicPath(roadmapPath),
    changed: false,
    suggestedNext: ROADMAP_HANDOFF_COMMAND
  };
}

function roadmapOutcomeWarnings(roadmap) {
  if (roadmap?.status !== 'handoff') {
    return [];
  }

  return [{
    code: roadmap.reason,
    message: `OpenSpec archive succeeded, but roadmap lifecycle reconciliation requires attention. Run ${ROADMAP_HANDOFF_COMMAND}.`,
    ...(roadmap.path === null ? {} : { path: roadmap.path })
  }];
}

async function buildAndWriteDoneReadiness(options = {}) {
  const readiness = await buildOpenSpecDoneReadiness(options);

  if (!readiness.change_id) {
    return readiness;
  }

  const written = await writeOpenSpecDoneReadiness(readiness.change_id, readiness, options);
  return written.readiness;
}

function shouldSkipReadinessForContext(context) {
  return (context?.errors ?? []).some((error) => error?.code === 'change-already-archived');
}

function readinessWarnings(readiness) {
  return readinessDiagnostics(readiness)
    .filter((diagnostic) => diagnostic.level === 'warn')
    .map(toReadinessDiagnostic);
}

function readinessErrors(readiness) {
  return readinessDiagnostics(readiness)
    .filter((diagnostic) => diagnostic.blocking || diagnostic.level === 'fail')
    .map(toReadinessDiagnostic);
}

function readinessDiagnostics(readiness) {
  return Array.isArray(readiness?.diagnostics) ? readiness.diagnostics : [];
}

function toReadinessDiagnostic(diagnostic) {
  const result = {
    code: diagnostic.code ?? 'done-readiness-diagnostic',
    message: diagnostic.message ?? 'Done readiness reported a diagnostic.'
  };

  if (diagnostic.path !== undefined && diagnostic.path !== null) {
    result.path = diagnostic.path;
  }

  return result;
}

function createFinalizeFailure({ context, readiness, workingTree, archive, errors }) {
  return {
    ok: false,
    mode: MODE,
    changeId: context.changeId,
    status: 'FAIL',
    context,
    verification: context.verification,
    readiness,
    workingTree,
    archive,
    roadmap: createSkippedRoadmapOutcome('archive-not-successful'),
    commitMessage: createCommitMessage(context.changeId),
    prSummary: createPrSummary({
      changeId: context.changeId,
      context,
      archive,
      readiness
    }),
    warnings: dedupeDiagnostics([
      ...context.warnings,
      ...readinessWarnings(readiness),
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
    gateResult: getVerificationGate(evidence, evidence?.verify?.content ?? ''),
    verify: {
      exists: Boolean(evidence?.verify?.exists),
      path: evidence?.verify?.path ?? null,
      content: evidence?.verify?.content ?? ''
    },
    warnings: evidence?.warnings ?? [],
    errors: evidence?.errors ?? []
  };
}

function getVerificationGate(evidence, verifyContent) {
  const gate = evidence?.gateResult ?? getLatestGateResult(verifyContent, { gate: 'verify' });

  if (gate === null || gate === undefined) {
    return {
      missing: true,
      ok: false,
      result: null,
      errors: []
    };
  }

  if (!gate.ok) {
    return {
      missing: false,
      ok: false,
      result: null,
      errors: gate.errors ?? []
    };
  }

  return {
    missing: false,
    ok: true,
    result: gate.result,
    errors: []
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
        commandSource: normalizeCommandSource(detection?.commandSource) ?? 'path',
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
        commandSource: 'path',
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
    coverage: null,
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

function createPrSummary({ changeId, context, archive, readiness }) {
  const validationState = summarizeValidationState(context?.verification?.validation);
  const codeState = summarizeCodeState(context?.verification?.verify?.content);
  const coverageState = context?.coverage?.status ? context.coverage.status.toUpperCase() : 'UNKNOWN';
  const readinessState = readiness?.status ? String(readiness.status).toUpperCase() : 'UNKNOWN';
  const verificationState = context?.verification?.passed ? 'PASS' : 'FAIL';
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
    `- /aif-verify: ${verificationState}`,
    `- Done readiness: ${readinessState}`,
    `- OpenSpec validation: ${validationState}`,
    `- Code verification: ${codeState}`,
    `- Coverage matrix: ${coverageState}`,
    '',
    '## Artifacts',
    '',
    `- .ai-factory/qa/${changeId}/${DONE_READINESS_FILE}`,
    `- .ai-factory/qa/${changeId}/coverage.json`,
    `- .ai-factory/qa/${changeId}/done.md`,
    `- .ai-factory/qa/${changeId}/openspec-archive.json`,
    `- .ai-factory/state/${changeId}/final-summary.md`,
    ''
  ].join('\n');
}

function renderDoneMarkdown(changeId, summary) {
  const context = summary.context ?? {};
  const archive = summary.archive ?? {};
  const readiness = summary.readiness ?? null;
  const verificationGate = context?.verification?.passed ? 'PASS' : 'FAIL';
  const finalizationStatus = summary.status ?? (summary.ok ? 'PASS' : 'FAIL');
  const canonicalPaths = collectCanonicalArtifactPaths(context.canonicalArtifacts);
  const qaEvidencePaths = collectQaEvidencePaths(changeId, context.verification, context.coverage, readiness);
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
    '## Done readiness',
    '',
    ...(readiness === null
      ? ['Done readiness: UNKNOWN']
      : summarizeOpenSpecDoneReadiness(readiness).split('\n')),
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
    '## Roadmap lifecycle',
    '',
    ...renderRoadmapLifecycle(summary.roadmap),
    '',
    '## Coverage matrix',
    '',
    ...summarizeOpenSpecCoverage(context.coverage).split('\n'),
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
    summary.prSummary ?? createPrSummary({ changeId, context, archive, readiness })
  ].join('\n');
}

function renderFinalSummaryMarkdown(summary) {
  return [
    `# Final Summary: ${summary.changeId}`,
    '',
    '## Roadmap lifecycle',
    '',
    ...renderRoadmapLifecycle(summary.roadmap),
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

function renderRoadmapLifecycle(value) {
  const roadmap = normalizeRoadmapOutcome(
    value ?? createSkippedRoadmapOutcome('archive-not-successful')
  );
  const lines = [
    `Status: ${roadmap.status}`,
    `Reason: ${roadmap.reason}`,
    `Changed: ${roadmap.changed ? 'yes' : 'no'}`
  ];

  if (roadmap.path !== null) {
    lines.push(`Path: ${roadmap.path}`);
  }
  if (roadmap.suggestedNext !== null) {
    lines.push(`Suggested next: ${ROADMAP_HANDOFF_COMMAND}`);
  }

  return lines;
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

function collectQaEvidencePaths(changeId, verification, coverage, readiness) {
  const paths = [
    verification?.verify?.path,
    readiness?.evidence_path ?? `.ai-factory/qa/${changeId}/${DONE_READINESS_FILE}`,
    coverage ? `.ai-factory/qa/${changeId}/coverage.json` : null,
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
    nodeVersion: options.nodeVersion,
    platform: options.platform,
    candidateExists: options.candidateExists,
    execFile: options.execFile,
    comSpec: options.comSpec
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

function selectOpenSpecCommandDiagnostic(result) {
  const preArchive = result?.context?.openspec
    ?? result?.openspec
    ?? result?.readiness?.context?.openspec
    ?? null;
  const archiveCommand = normalizePublicCommand(result?.archive?.command);

  if (archiveCommand !== null) {
    return {
      command: archiveCommand,
      commandSource: normalizeCommandSource(result?.archive?.commandSource)
        ?? normalizeCommandSource(preArchive?.commandSource)
    };
  }

  return {
    command: normalizePublicCommand(preArchive?.command),
    commandSource: normalizeCommandSource(preArchive?.commandSource)
  };
}

function normalizeCommandSource(value) {
  const source = String(value ?? '');
  return PUBLIC_COMMAND_SOURCES.has(source) ? source : null;
}

function normalizePublicCommand(value) {
  if (value === undefined || value === null || String(value).trim().length === 0) {
    return null;
  }

  const command = String(value).trim();
  if (path.win32.isAbsolute(command)) {
    return boundedPublicText(path.win32.basename(command), 240);
  }
  if (path.posix.isAbsolute(command)) {
    return boundedPublicText(path.posix.basename(command), 240);
  }

  return boundedPublicText(command.replaceAll('\\', '/'), 240);
}

function normalizePublicChangeId(value) {
  const normalized = normalizeChangeId(value);
  return normalized.ok ? normalized.changeId : null;
}

function normalizePublicPaths(values) {
  const result = [];
  const seen = new Set();

  for (const value of Array.isArray(values) ? values.slice(0, 100) : []) {
    const normalized = normalizePublicPath(value);
    if (normalized !== null && !seen.has(normalized)) {
      seen.add(normalized);
      result.push(normalized);
    }
  }

  return result;
}

function normalizePublicPath(value) {
  const normalized = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replaceAll('\\', '/')
    .trim();

  if (normalized.length === 0
    || normalized.length > 512
    || path.posix.isAbsolute(normalized)
    || path.win32.isAbsolute(normalized)
    || normalized.split('/').includes('..')) {
    return null;
  }

  return normalized;
}

function normalizeSuggestedNext(value) {
  if (value === null || value === undefined) {
    return null;
  }

  const command = boundedPublicText(value.command ?? '', 500);
  if (command.length === 0) {
    return null;
  }

  return {
    command,
    reason: boundedPublicText(value.reason ?? '', 500)
  };
}

function normalizePublicDiagnostics(values) {
  return (Array.isArray(values) ? values : [])
    .slice(0, MAX_PUBLIC_DIAGNOSTICS)
    .map((diagnostic) => {
      const rawCode = boundedPublicText(diagnostic?.code ?? '', 100);
      const code = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(rawCode)
        ? rawCode
        : 'finalization-diagnostic';
      const result = {
        code,
        message: boundedPublicText(
          diagnostic?.message ?? 'Done finalization reported a diagnostic.',
          500
        )
      };
      const diagnosticPath = normalizePublicPath(diagnostic?.path);

      if (diagnosticPath !== null) {
        result.path = diagnosticPath;
      }

      return result;
    });
}

function boundedPublicText(value, maxLength) {
  const normalized = redactAbsolutePaths(
    String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ')
  )
    .replace(/\s+/g, ' ')
    .trim();

  return normalized.length <= maxLength
    ? normalized
    : `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
}

function redactAbsolutePaths(value) {
  return String(value)
    .replace(/"(?:[A-Za-z]:[\\/]|\\\\|\/)[^"]*"/g, '"[path]"')
    .replace(/'(?:[A-Za-z]:[\\/]|\\\\|\/)[^']*'/g, "'[path]'")
    .replace(/\\\\[^\\/\s"']+(?:[\\/].*)?$/g, '[path]')
    .replace(/[A-Za-z]:[\\/].*$/g, '[path]')
    .replace(/(^|[\s(])\/(?:[^/\s)]+\/).*$/g, '$1[path]');
}

function isDirtyStateRecorded(workingTree) {
  return Boolean(workingTree?.recorded)
    || (Boolean(workingTree?.dirty)
      && Boolean(workingTree?.ok)
      && (workingTree?.warnings ?? []).some((warning) => warning?.code === 'dirty-working-tree-recorded'));
}

function invalidFinalizerArgs(error) {
  return {
    ok: false,
    error
  };
}

async function main() {
  const result = await runDoneFinalizerCommand(process.argv.slice(2));
  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
  process.exitCode = result.exitCode;
}

const isDirect = process.argv[1] !== undefined
  && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isDirect) {
  main().catch(() => {
    process.stderr.write('Done finalizer command failed unexpectedly.\n');
    process.exitCode = 2;
  });
}
