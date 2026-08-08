#!/usr/bin/env node
// openspec-done-readiness.mjs - pre-archive readiness gate for OpenSpec done finalization
import { execFile } from 'node:child_process';
import { access, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  ensureRuntimeLayout as defaultEnsureRuntimeLayout,
  normalizeChangeId,
  resolveActiveChange as defaultResolveActiveChange
} from './active-change-resolver.mjs';
import {
  getLatestGateResult
} from './aif-gate-result.mjs';
import {
  collectGeneratedRules as defaultCollectGeneratedRules
} from './openspec-execution-context.mjs';
import {
  readLatestVerificationEvidence as defaultReadLatestVerificationEvidence
} from './openspec-verification-context.mjs';
import {
  detectOpenSpec as defaultDetectOpenSpec,
  getOpenSpecStatus as defaultGetOpenSpecStatus,
  validateOpenSpecChange as defaultValidateOpenSpecChange
} from './openspec-runner.mjs';
import {
  validateOpenSpecArtifactContract as defaultValidateOpenSpecArtifactContract
} from './openspec-artifact-validator.mjs';
import {
  readOpenSpecCoverageMatrix as defaultReadOpenSpecCoverageMatrix
} from './openspec-coverage-matrix.mjs';
import {
  readOpenSpecPolicy,
  readOpenSpecRulesGateEvidence as defaultReadOpenSpecRulesGateEvidence
} from './openspec-policy.mjs';

const execFileAsync = promisify(execFile);

export const DONE_READINESS_SCHEMA_VERSION = 1;
export const DONE_READINESS_GATE = 'done-readiness';
export const DONE_READINESS_FILE = 'done-readiness.json';

const DEFAULT_QA_DIR = path.join('.ai-factory', 'qa');
const DEFAULT_STATE_DIR = path.join('.ai-factory', 'state');
const CHECKS = Object.freeze([
  'openspec_validate',
  'openspec_status',
  'artifact_contract',
  'generated_rules',
  'rules_gate',
  'coverage',
  'verify_gate',
  'dirty_workspace'
]);
const SUGGESTION_PRIORITY = Object.freeze([
  'generated_rules',
  'rules_gate',
  'coverage',
  'verify_gate',
  'artifact_contract',
  'openspec_validate',
  'openspec_status',
  'dirty_workspace'
]);

export async function buildOpenSpecDoneReadiness(options = {}) {
  const rootDir = resolveRootDir(options);
  const resolveActiveChange = options.resolveActiveChange ?? defaultResolveActiveChange;
  const ensureRuntimeLayout = options.ensureRuntimeLayout ?? defaultEnsureRuntimeLayout;
  const resolved = await resolveActiveChange({
    rootDir,
    cwd: options.cwd ?? process.cwd(),
    changeId: options.changeId,
    getCurrentBranch: options.getCurrentBranch
  });

  if (!resolved.ok) {
    return createReadinessResult({
      changeId: resolved.changeId ?? null,
      checks: emptyChecks('fail'),
      diagnostics: [{
        check: 'openspec_validate',
        level: 'fail',
        blocking: true,
        code: resolved.errors?.[0]?.code ?? 'active-change-unresolved',
        message: resolved.errors?.[0]?.message ?? 'Unable to resolve an active OpenSpec change.',
        suggested_next: {
          command: '/aif-mode status',
          reason: 'select or pass an active OpenSpec change before checking done readiness'
        }
      }],
      paths: {},
      resolver: createResolverSummary(resolved)
    });
  }

  const layout = await ensureRuntimeLayout(resolved.changeId, {
    rootDir,
    cwd: options.cwd,
    stateDir: options.stateDir ?? DEFAULT_STATE_DIR,
    qaDir: options.qaDir ?? DEFAULT_QA_DIR
  });
  assertSafeRuntimePath(rootDir, layout.qaPath, 'Done readiness QA path');
  assertSafeRuntimePath(rootDir, layout.statePath, 'Done readiness state path');

  const policy = options.policy ?? await readOpenSpecPolicy({ ...options, rootDir });
  const checks = emptyChecks('pass');
  const diagnostics = [];
  const context = {
    resolver: createResolverSummary(resolved),
    paths: {
      change: resolved.changePath,
      qa: layout.qaPath,
      state: layout.statePath,
      readiness: toPosix(path.relative(rootDir, path.join(layout.qaPath, DONE_READINESS_FILE)))
    },
    effectivePolicy: policy,
    openspec: null,
    validation: null,
    status: null,
    artifactContract: null,
    generatedRules: null,
    rulesGate: null,
    coverage: null,
    verification: null,
    workingTree: null
  };

  const openspec = await inspectOpenSpecCapability(rootDir, options);
  context.openspec = openspec;
  const validation = await inspectOpenSpecValidation(resolved.changeId, {
    ...options,
    rootDir,
    openspec,
    policy
  });
  context.validation = validation.value;
  recordCheck(checks, diagnostics, validation);

  const status = await inspectOpenSpecStatus(resolved.changeId, {
    ...options,
    rootDir,
    openspec,
    policy
  });
  context.status = status.value;
  recordCheck(checks, diagnostics, status);

  const artifactContract = await inspectArtifactContract(resolved.changeId, {
    ...options,
    rootDir
  });
  context.artifactContract = artifactContract.value;
  recordCheck(checks, diagnostics, artifactContract);

  const generatedRules = await inspectGeneratedRules(resolved.changeId, {
    ...options,
    rootDir,
    policy
  });
  context.generatedRules = generatedRules.value;
  recordCheck(checks, diagnostics, generatedRules);

  const rulesGate = await inspectRulesGate(resolved.changeId, {
    ...options,
    rootDir,
    qaPath: layout.qaPath,
    policy
  });
  context.rulesGate = rulesGate.value;
  recordCheck(checks, diagnostics, rulesGate);

  const coverage = await inspectCoverage(resolved.changeId, {
    ...options,
    rootDir,
    qaPath: layout.qaPath,
    policy
  });
  context.coverage = coverage.value;
  recordCheck(checks, diagnostics, coverage);

  const verification = await inspectVerifyGate(resolved.changeId, {
    ...options,
    rootDir,
    qaPath: layout.qaPath
  });
  context.verification = verification.value;
  recordCheck(checks, diagnostics, verification);

  const workingTree = await inspectDirtyWorkspace({
    ...options,
    rootDir,
    changeId: resolved.changeId
  });
  context.workingTree = workingTree.value;
  recordCheck(checks, diagnostics, workingTree);

  return createReadinessResult({
    changeId: resolved.changeId,
    checks,
    diagnostics: dedupeDiagnostics(diagnostics),
    paths: context.paths,
    resolver: context.resolver,
    context
  });
}

export async function writeOpenSpecDoneReadiness(changeId, readiness, options = {}) {
  const rootDir = resolveRootDir(options);
  const normalized = normalizeChangeId(changeId ?? readiness?.change_id);

  if (!normalized.ok) {
    throw new Error(normalized.error.message);
  }

  const qaPath = resolveQaPath(rootDir, normalized.changeId, options);
  assertSafeRuntimePath(rootDir, qaPath, 'Done readiness QA path');
  await mkdir(qaPath, { recursive: true });

  const readinessPath = path.join(qaPath, DONE_READINESS_FILE);
  const relativePath = toPosix(path.relative(rootDir, readinessPath));
  const persisted = {
    ...readiness,
    change_id: normalized.changeId,
    evidence_path: relativePath
  };
  if (readiness?.context !== undefined) {
    Object.defineProperty(persisted, 'context', {
      value: readiness.context,
      enumerable: false,
      configurable: false,
      writable: false
    });
  }
  await writeFile(readinessPath, `${JSON.stringify(persisted, null, 2)}\n`, 'utf8');

  return {
    ok: true,
    changeId: normalized.changeId,
    path: relativePath,
    readiness: persisted,
    warnings: [],
    errors: []
  };
}

export function summarizeOpenSpecDoneReadiness(readiness, options = {}) {
  const result = readiness ?? {};
  const lines = [
    `Done readiness: ${String(result.status ?? 'unknown').toUpperCase()}`,
    `Change: ${result.change_id ?? 'unresolved'}`,
    `Blocking: ${result.blocking ? 'yes' : 'no'}`
  ];

  const evidencePath = result.evidence_path ?? options.evidencePath;
  if (evidencePath) {
    lines.push(`Evidence: ${evidencePath}`);
  }

  lines.push('', 'Checks:');
  const checks = result.checks ?? {};
  for (const check of CHECKS) {
    lines.push(`- ${String(checks[check] ?? 'missing').toUpperCase()} ${check}`);
  }

  const diagnostics = Array.isArray(result.diagnostics) ? result.diagnostics : [];
  if (diagnostics.length > 0) {
    lines.push('', 'Diagnostics:');
    for (const diagnostic of diagnostics) {
      const suffix = diagnostic.path ? ` (${diagnostic.path})` : '';
      lines.push(`- ${String(diagnostic.level ?? 'warn').toUpperCase()} ${diagnostic.code}${suffix}: ${diagnostic.message}`);
    }
  }

  if (result.suggested_next) {
    lines.push(
      '',
      `Suggested next: ${result.suggested_next.command}`,
      `Reason: ${result.suggested_next.reason}`
    );
  }

  return lines.join('\n');
}

export function parseDoneReadinessArgs(argv) {
  const args = Array.from(argv ?? []);
  const parsed = {
    ok: true,
    changeId: null,
    json: false,
    write: true,
    recordDirtyState: false
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === '--change') {
      const value = args[index + 1];
      if (value === undefined || value.startsWith('--')) {
        return invalidArgs('Missing value for --change.');
      }
      parsed.changeId = value;
      index += 1;
      continue;
    }

    if (arg === '--json') {
      parsed.json = true;
      continue;
    }

    if (arg === '--no-write') {
      parsed.write = false;
      continue;
    }

    if (arg === '--record-dirty-state') {
      parsed.recordDirtyState = true;
      continue;
    }

    return invalidArgs(`Unknown option: ${arg}.`);
  }

  return parsed;
}

export async function runDoneReadinessCommand(argv, options = {}) {
  const parsed = parseDoneReadinessArgs(argv);
  if (!parsed.ok) {
    return {
      exitCode: 2,
      stdout: '',
      stderr: `${parsed.error}\n`
    };
  }

  const readiness = await buildOpenSpecDoneReadiness({
    ...options,
    changeId: parsed.changeId ?? options.changeId,
    recordDirtyState: parsed.recordDirtyState || options.recordDirtyState
  });
  let output = readiness;

  if (parsed.write && readiness.change_id) {
    const written = await writeOpenSpecDoneReadiness(readiness.change_id, readiness, options);
    output = written.readiness;
  }

  const stdout = parsed.json
    ? `${JSON.stringify(output, null, 2)}\n`
    : `${summarizeOpenSpecDoneReadiness(output)}\n`;
  const unresolved = output.change_id === null || output.change_id === undefined;
  const exitCode = unresolved ? 2 : output.blocking ? 1 : 0;

  return {
    exitCode,
    stdout,
    stderr: ''
  };
}

async function inspectOpenSpecCapability(rootDir, options) {
  const detectOpenSpec = options.detectOpenSpec ?? defaultDetectOpenSpec;
  try {
    const detection = await detectOpenSpec(createRunOptions(options, rootDir));
    return {
      available: Boolean(detection?.available),
      canValidate: Boolean(detection?.canValidate),
      canArchive: Boolean(detection?.canArchive),
      version: detection?.version ?? null,
      command: detection?.command ?? 'openspec',
      commandSource: detection?.commandSource ?? 'path',
      reason: detection?.reason ?? null,
      errors: detection?.errors ?? []
    };
  } catch (err) {
    return {
      available: false,
      canValidate: false,
      canArchive: false,
      version: null,
      command: 'openspec',
      commandSource: 'path',
      reason: err?.code ?? 'openspec-detection-failed',
      errors: [{
        code: err?.code ?? 'openspec-detection-failed',
        message: err?.message ?? 'OpenSpec CLI capability detection failed.'
      }]
    };
  }
}

async function inspectOpenSpecValidation(changeId, options) {
  const required = Boolean(options.policy?.requirements?.cli?.done);
  if (!options.openspec?.canValidate) {
    return checkResult({
      check: 'openspec_validate',
      level: required ? 'fail' : 'warn',
      blocking: required,
      code: required ? 'openspec-cli-required-for-done' : 'openspec-cli-unavailable',
      message: required
        ? 'OpenSpec CLI validation capability is required before /aif-done can archive.'
        : 'OpenSpec CLI validation capability is unavailable; continuing because done CLI is not required.',
      value: null,
      suggestedNext: {
        command: `/aif-done ${changeId}`,
        reason: 'install a compatible OpenSpec CLI before archive-required finalization'
      }
    });
  }

  const validateOpenSpecChange = options.validateOpenSpecChange ?? defaultValidateOpenSpecChange;
  const raw = await validateOpenSpecChange(changeId, createRunOptions(options, options.rootDir));
  const validation = normalizeCommandResult(raw);

  if (validation.ok) {
    return checkResult({
      check: 'openspec_validate',
      level: 'pass',
      code: 'openspec-validation-pass',
      message: 'OpenSpec validation passed.',
      value: validation
    });
  }

  return checkResult({
    check: 'openspec_validate',
    level: 'fail',
    blocking: true,
    code: 'openspec-validation-failed',
    message: validation.error?.message ?? 'OpenSpec validation failed before done finalization.',
    value: validation,
    suggestedNext: {
      command: `/aif-verify ${changeId}`,
      reason: 'fix OpenSpec validation errors and rerun verification before done finalization'
    }
  });
}

async function inspectOpenSpecStatus(changeId, options) {
  if (!options.openspec?.canValidate) {
    const allowed = Boolean(options.policy?.allowWarnOnDone?.openspecStatus);
    return checkResult({
      check: 'openspec_status',
      level: allowed ? 'warn' : 'fail',
      blocking: !allowed,
      code: 'openspec-status-unavailable',
      message: allowed
        ? 'OpenSpec status is unavailable and accepted by done warning policy.'
        : 'OpenSpec status is unavailable and allowWarnOnDone.openspecStatus is false.',
      value: null,
      suggestedNext: {
        command: `/aif-done ${changeId}`,
        reason: 'make OpenSpec status available before archive-required finalization'
      }
    });
  }

  const getOpenSpecStatus = options.getOpenSpecStatus ?? defaultGetOpenSpecStatus;
  const raw = await getOpenSpecStatus(changeId, createRunOptions(options, options.rootDir));
  const status = normalizeCommandResult(raw);

  if (status.ok) {
    return checkResult({
      check: 'openspec_status',
      level: 'pass',
      code: 'openspec-status-pass',
      message: 'OpenSpec status passed.',
      value: status
    });
  }

  const allowed = Boolean(options.policy?.allowWarnOnDone?.openspecStatus);
  return checkResult({
    check: 'openspec_status',
    level: allowed ? 'warn' : 'fail',
    blocking: !allowed,
    code: 'openspec-status-warn',
    message: allowed
      ? 'OpenSpec status returned warnings accepted by done policy.'
      : 'OpenSpec status returned warnings and allowWarnOnDone.openspecStatus is false.',
    value: status,
    suggestedNext: {
      command: `/aif-mode doctor --change ${changeId}`,
      reason: 'inspect OpenSpec status warnings before done finalization'
    }
  });
}

async function inspectArtifactContract(changeId, options) {
  const validateOpenSpecArtifactContract = options.validateOpenSpecArtifactContract ?? defaultValidateOpenSpecArtifactContract;
  const result = await validateOpenSpecArtifactContract({
    ...options,
    changeId,
    requireVerificationEvidence: true
  });

  if (result?.status === 'pass') {
    return checkResult({
      check: 'artifact_contract',
      level: 'pass',
      code: 'artifact-contract-pass',
      message: 'AIFHub artifact contract passed.',
      value: result
    });
  }

  const failing = (result?.checks ?? []).find((check) => check.status === 'fail')
    ?? (result?.checks ?? []).find((check) => check.status === 'warn');
  return checkResult({
    check: 'artifact_contract',
    level: result?.status === 'warn' ? 'warn' : 'fail',
    blocking: true,
    code: `artifact-contract-${result?.status ?? 'missing'}`,
    message: failing?.message ?? 'AIFHub artifact contract must pass before archive.',
    path: failing?.path,
    value: result,
    suggestedNext: result?.suggested_next ?? {
      command: `/aif-mode doctor --change ${changeId}`,
      reason: 'resolve AIFHub artifact contract diagnostics before done finalization'
    }
  });
}

async function inspectGeneratedRules(changeId, options) {
  const collectGeneratedRules = options.collectGeneratedRules ?? defaultCollectGeneratedRules;
  const result = await collectGeneratedRules(changeId, {
    ...options,
    rootDir: options.rootDir
  });
  const diagnostics = [
    ...(result?.errors ?? []),
    ...(result?.warnings ?? [])
  ];

  if (diagnostics.length === 0) {
    return checkResult({
      check: 'generated_rules',
      level: 'pass',
      code: 'generated-rules-pass',
      message: 'Generated OpenSpec rules are present and current.',
      value: result
    });
  }

  const required = Boolean(options.policy?.requirements?.generatedRules?.done);
  const first = diagnostics[0] ?? {};
  return checkResult({
    check: 'generated_rules',
    level: required ? 'fail' : 'warn',
    blocking: required,
    code: first.code ?? 'generated-rules-not-current',
    message: first.message ?? 'Generated OpenSpec rules are missing or stale.',
    path: first.path ?? '.ai-factory/rules/generated',
    value: result,
    suggestedNext: {
      command: `/aif-mode sync --change ${changeId}`,
      reason: 'generated rules are missing or stale'
    }
  });
}

async function inspectRulesGate(changeId, options) {
  const readRulesGate = options.readOpenSpecRulesGateEvidence ?? defaultReadOpenSpecRulesGateEvidence;
  const rulesGate = await readRulesGate(changeId, {
    ...options,
    rootDir: options.rootDir,
    qaPath: options.qaPath
  });
  const status = rulesGate?.status ?? 'missing';

  if (status === 'pass') {
    return checkResult({
      check: 'rules_gate',
      level: 'pass',
      code: 'rules-gate-pass',
      message: 'Rules gate passed.',
      path: rulesGate.path,
      value: rulesGate
    });
  }

  const allowWarn = Boolean(options.policy?.allowWarnOnDone?.rules);
  const required = Boolean(options.policy?.requirements?.rulesPass?.done);
  const acceptedWarn = status === 'warn' && allowWarn;
  const blocking = acceptedWarn ? false : required;
  const error = rulesGate?.errors?.[0];
  const evidencePath = rulesGate?.path ?? toPosix(path.join(DEFAULT_QA_DIR, changeId, 'rules.md'));
  return checkResult({
    check: 'rules_gate',
    level: blocking ? 'fail' : 'warn',
    blocking,
    code: error?.code ?? `rules-gate-${status}`,
    message: acceptedWarn
      ? 'Rules gate completed with warnings accepted by done policy.'
      : error?.message ?? `Rules gate evidence is ${status}.`,
    path: rulesGate?.path,
    value: rulesGate,
    suggestedNext: createRulesGateSuggestedNext(changeId, evidencePath)
  });
}

function createRulesGateSuggestedNext(changeId, evidencePath) {
  const rulesEvidencePath = toPosix(evidencePath ?? path.join(DEFAULT_QA_DIR, changeId, 'rules.md'));

  return {
    command: `ai-factory aifhub-write-gate-evidence --change ${changeId} --gate rules --from <rules-output.md>`,
    reason: `Run /aif-rules-check, save its final rules output, then persist it to ${rulesEvidencePath} before /aif-done.`
  };
}

async function inspectCoverage(changeId, options) {
  const readCoverage = options.readOpenSpecCoverageMatrix ?? defaultReadOpenSpecCoverageMatrix;
  const coverage = await readCoverage(changeId, {
    ...options,
    rootDir: options.rootDir,
    qaPath: options.qaPath
  });
  const coverageStatus = coverage?.coverage?.status ?? (coverage?.exists ? 'invalid' : 'missing');
  const allowWarn = Boolean(options.policy?.allowWarnOnDone?.coverage);
  const required = Boolean(options.policy?.requirements?.specCoverage?.done);

  if (coverage?.exists && coverage.ok && !coverage.stale && coverageStatus === 'pass') {
    return checkResult({
      check: 'coverage',
      level: 'pass',
      code: 'coverage-pass',
      message: 'OpenSpec coverage passed.',
      path: coverage.relativePath,
      value: coverage
    });
  }

  if (coverage?.exists && coverage.ok && !coverage.stale && coverageStatus === 'warn' && allowWarn) {
    return checkResult({
      check: 'coverage',
      level: 'warn',
      blocking: false,
      code: 'coverage-policy-warn',
      message: 'OpenSpec coverage completed with warnings accepted by done policy.',
      path: coverage.relativePath,
      value: coverage
    });
  }

  const blocking = coverageStatus === 'warn' && !allowWarn ? true : required;
  const code = !coverage?.exists
    ? 'coverage-evidence-missing'
    : !coverage.ok
      ? 'coverage-evidence-invalid'
      : coverage.stale
        ? 'coverage-evidence-stale'
        : `coverage-policy-${coverageStatus}`;
  const message = coverage?.diagnostics?.[0]?.message
    ?? (coverageStatus === 'warn'
      ? 'OpenSpec coverage completed with warnings and allowWarnOnDone.coverage is false.'
      : `OpenSpec coverage evidence is ${coverageStatus}.`);
  return checkResult({
    check: 'coverage',
    level: blocking ? 'fail' : 'warn',
    blocking,
    code,
    message,
    path: coverage?.relativePath,
    value: coverage,
    suggestedNext: {
      command: `/aif-verify ${changeId}`,
      reason: 'coverage evidence must be current and acceptable before done finalization'
    }
  });
}

async function inspectVerifyGate(changeId, options) {
  const readLatestVerificationEvidence = options.readLatestVerificationEvidence ?? defaultReadLatestVerificationEvidence;
  const evidence = await readLatestVerificationEvidence(changeId, {
    ...options,
    rootDir: options.rootDir,
    qaPath: options.qaPath
  });
  const verifyContent = evidence?.verify?.content ?? '';
  const gate = evidence?.gateResult ?? getLatestGateResult(verifyContent, { gate: 'verify' });

  if (!evidence?.verify?.exists) {
    return checkResult({
      check: 'verify_gate',
      level: 'fail',
      blocking: true,
      code: 'verification-evidence-missing',
      message: `Run /aif-verify ${changeId} before /aif-done.`,
      path: evidence?.verify?.path,
      value: evidence,
      suggestedNext: {
        command: `/aif-verify ${changeId}`,
        reason: 'verification evidence is required before done finalization'
      }
    });
  }

  if (Array.isArray(evidence.errors) && evidence.errors.length > 0) {
    return checkResult({
      check: 'verify_gate',
      level: 'fail',
      blocking: true,
      code: 'verification-not-passed',
      message: evidence.errors[0]?.message ?? 'Verification evidence contains errors.',
      path: evidence.verify.path,
      value: evidence,
      suggestedNext: {
        command: `/aif-verify ${changeId}`,
        reason: 'rerun verification after fixing verification evidence errors'
      }
    });
  }

  if (gate === null || gate === undefined) {
    return verifyGateFailure(changeId, evidence, 'verification-gate-missing', 'Verification evidence is missing the final aif-gate-result block for the verify gate.');
  }

  if (!gate.ok) {
    return verifyGateFailure(changeId, evidence, 'verification-gate-invalid', 'Verification evidence contains an invalid final aif-gate-result block for the verify gate.');
  }

  if (gate.result.status === 'fail') {
    return checkResult({
      check: 'verify_gate',
      level: 'fail',
      blocking: true,
      code: 'verification-gate-failed',
      message: 'The latest verify gate result failed.',
      path: evidence.verify.path,
      value: evidence,
      suggestedNext: {
        command: `/aif-fix ${changeId}`,
        reason: 'fix the failing verification evidence before rerunning /aif-verify'
      }
    });
  }

  if (/\b(Code verification:\s*PENDING|Code verification:\s*BLOCKED)\b/i.test(verifyContent) || /\b(Verdict:\s*FAIL|OpenSpec validation:\s*FAIL|\/aif-verify:\s*FAIL)\b/i.test(verifyContent)) {
    return verifyGateFailure(changeId, evidence, 'verification-ambiguous', 'Verification evidence is ambiguous; rerun /aif-verify before finalizing.');
  }

  if (!hasFinalPassSignal(verifyContent)) {
    return verifyGateFailure(changeId, evidence, 'verification-ambiguous', 'Verification evidence is ambiguous; rerun /aif-verify before finalizing.');
  }

  return checkResult({
    check: 'verify_gate',
    level: gate.result.status === 'warn' ? 'warn' : 'pass',
    blocking: false,
    code: gate.result.status === 'warn' ? 'verification-gate-warn' : 'verification-gate-pass',
    message: gate.result.status === 'warn'
      ? 'The latest verify gate completed with warnings.'
      : 'The latest verify gate passed.',
    path: evidence.verify.path,
    value: evidence
  });
}

function verifyGateFailure(changeId, evidence, code, message) {
  return checkResult({
    check: 'verify_gate',
    level: 'fail',
    blocking: true,
    code,
    message,
    path: evidence?.verify?.path,
    value: evidence,
    suggestedNext: {
      command: `/aif-verify ${changeId}`,
      reason: 'verification evidence must pass before done finalization'
    }
  });
}

async function inspectDirtyWorkspace(options) {
  const workingTree = await detectWorkingTreeState(options);

  if (!workingTree.dirty && workingTree.ok && workingTree.isGitRepo) {
    return checkResult({
      check: 'dirty_workspace',
      level: 'pass',
      code: 'working-tree-clean',
      message: 'Working tree is clean.',
      value: workingTree
    });
  }

  if (workingTree.ok) {
    return checkResult({
      check: 'dirty_workspace',
      level: workingTree.dirty ? 'warn' : 'warn',
      blocking: false,
      code: workingTree.warnings?.[0]?.code ?? 'working-tree-state-recorded',
      message: workingTree.warnings?.[0]?.message ?? 'Working tree state was recorded.',
      value: workingTree
    });
  }

  return checkResult({
    check: 'dirty_workspace',
    level: 'fail',
    blocking: true,
    code: workingTree.errors?.[0]?.code ?? 'dirty-working-tree',
    message: workingTree.errors?.[0]?.message ?? 'Working tree is not ready for archive.',
    value: workingTree,
    suggestedNext: dirtyWorkspaceSuggestedNext(options.changeId, options)
  });
}

function dirtyWorkspaceSuggestedNext(changeId, options = {}) {
  const commandParts = ['/aif-done'];
  if (changeId) {
    commandParts.push(changeId);
  }
  if (options.skipSpecs) {
    commandParts.push('--skip-specs');
  }
  commandParts.push('--record-dirty-state');

  return {
    command: commandParts.join(' '),
    reason: 'record current dirty workspace entries in final QA evidence before archive; inspect first with git status --short if needed'
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
      errors: [{
        code: 'git-status-failed',
        message: 'Unable to inspect working tree state.',
        detail: stderr || stdout || null
      }]
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
      warnings: [{
        code: 'dirty-working-tree-recorded',
        message: 'Working tree dirty state was recorded because explicit dirty-state recording is enabled.'
      }],
      errors: []
    };
  }

  return {
    ok: false,
    isGitRepo: true,
    dirty: true,
    entries,
    warnings: [],
    errors: [{
      code: 'dirty-working-tree',
      message: 'Working tree has uncommitted changes. Commit/stash or run with explicit dirty-state recording.'
    }]
  };
}

function createReadinessResult({ changeId, checks, diagnostics, paths, resolver, context }) {
  const blocking = diagnostics.some((diagnostic) => diagnostic.blocking);
  const status = blocking ? 'fail' : diagnostics.some((diagnostic) => diagnostic.level === 'warn') ? 'warn' : 'pass';
  const suggestedNext = chooseSuggestedNext(diagnostics);

  const result = {
    schema_version: DONE_READINESS_SCHEMA_VERSION,
    gate: DONE_READINESS_GATE,
    change_id: changeId ?? null,
    status,
    blocking,
    checks,
    diagnostics: diagnostics.map(stripInternalDiagnosticFields),
    suggested_next: suggestedNext,
    paths,
    resolver
  };

  if (context !== undefined) {
    Object.defineProperty(result, 'context', {
      value: context,
      enumerable: false,
      configurable: false,
      writable: false
    });
  }

  return result;
}

function recordCheck(checks, diagnostics, result) {
  checks[result.check] = result.level;

  if (result.level !== 'pass') {
    diagnostics.push({
      check: result.check,
      level: result.level,
      blocking: Boolean(result.blocking),
      code: result.code,
      message: result.message,
      path: result.path,
      value: result.value,
      suggested_next: result.suggestedNext
    });
  }
}

function checkResult({ check, level, blocking = level === 'fail', code, message, path: checkPath, value, suggestedNext }) {
  return {
    check,
    level,
    blocking,
    code,
    message,
    path: checkPath,
    value,
    suggestedNext
  };
}

function chooseSuggestedNext(diagnostics) {
  const blocking = diagnostics.filter((diagnostic) => diagnostic.blocking && diagnostic.suggested_next);

  for (const check of SUGGESTION_PRIORITY) {
    const diagnostic = blocking.find((item) => item.check === check);
    if (diagnostic?.suggested_next) {
      return diagnostic.suggested_next;
    }
  }

  return blocking[0]?.suggested_next ?? null;
}

function stripInternalDiagnosticFields(diagnostic) {
  const result = {
    check: diagnostic.check,
    level: diagnostic.level,
    blocking: Boolean(diagnostic.blocking),
    code: diagnostic.code,
    message: diagnostic.message
  };

  if (diagnostic.path !== undefined && diagnostic.path !== null) {
    result.path = diagnostic.path;
  }

  if (diagnostic.suggested_next !== undefined && diagnostic.suggested_next !== null) {
    result.suggested_next = diagnostic.suggested_next;
  }

  return result;
}

function emptyChecks(status) {
  return Object.fromEntries(CHECKS.map((check) => [check, status]));
}

function createResolverSummary(result) {
  return {
    source: result?.source ?? null,
    candidates: result?.candidates ?? [],
    warnings: result?.warnings ?? []
  };
}

function normalizeCommandResult(result) {
  return {
    ok: Boolean(result?.ok),
    command: result?.command ?? 'openspec',
    commandSource: result?.commandSource ?? 'path',
    args: Array.from(result?.args ?? []),
    exitCode: result?.exitCode ?? null,
    json: result?.json ?? null,
    stdout: normalizeOutput(result?.stdout),
    stderr: normalizeOutput(result?.stderr),
    error: result?.error ?? (result?.ok ? null : {
      code: 'openspec-command-failed',
      message: normalizeOutput(result?.stderr) || normalizeOutput(result?.stdout) || 'OpenSpec command failed.'
    })
  };
}

function hasFinalPassSignal(content = '') {
  return /\b(Verdict:\s*PASS|\/aif-verify:\s*PASS|Code verification:\s*PASS)\b/i.test(content);
}

function resolveQaPath(rootDir, changeId, options = {}) {
  if (options.qaPath !== undefined) {
    return path.resolve(options.qaPath);
  }

  const qaRoot = path.resolve(rootDir, options.qaDir ?? DEFAULT_QA_DIR);
  return path.join(qaRoot, changeId);
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
    warnings: [{
      code: 'not-a-git-repository',
      message: 'Working tree state could not be checked because this is not a git repository.',
      detail
    }],
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
    const key = `${diagnostic?.check ?? ''}:${diagnostic?.code ?? ''}:${diagnostic?.message ?? ''}:${diagnostic?.path ?? ''}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(diagnostic);
    }
  }

  return result;
}

function invalidArgs(error) {
  return {
    ok: false,
    error
  };
}

async function main() {
  const result = await runDoneReadinessCommand(process.argv.slice(2));
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
  main().catch((err) => {
    process.stderr.write(`${err?.message ?? String(err)}\n`);
    process.exitCode = 2;
  });
}
