// understand-anything-sandbox.mjs - test-only sandbox plan and runner for ai-tester
import path from 'node:path';

import { GATE_BLOCKED, GATE_FAIL, GATE_PASS } from './understand-anything-static-audit.mjs';
import { evaluateUnderstandAnythingEligibility } from './understand-anything-eligibility.mjs';

export const UNDERSTAND_ANYTHING_SANDBOX_SCHEMA = 'aifhub.understand_anything.sandbox.v1';

const DEFAULT_LIMITS = {
  max_duration_ms: 300000,
  max_tokens: 12000,
  max_agents: 5,
  max_processes: 12
};

export function buildUnderstandAnythingSandboxPlan(input = {}) {
  const sandboxRoot = path.resolve(input.sandboxRoot ?? '.ua-sandbox');
  const checkoutRoot = assertDescendantPath(sandboxRoot, input.checkoutRoot ?? path.join(sandboxRoot, 'checkout'), 'checkout root');
  const fixtureRoot = assertDescendantPath(sandboxRoot, input.fixtureRoot ?? path.join(sandboxRoot, 'fixture'), 'fixture root');
  const outputRoot = assertDescendantPath(sandboxRoot, input.outputRoot ?? path.join(sandboxRoot, '.ua'), 'output root');
  const homeRoot = assertDescendantPath(sandboxRoot, input.homeRoot ?? path.join(sandboxRoot, 'home'), 'home root');
  const configRoot = assertDescendantPath(sandboxRoot, input.configRoot ?? path.join(sandboxRoot, 'config'), 'config root');
  const dependencyRoot = assertDescendantPath(sandboxRoot, input.dependencyRoot ?? path.join(sandboxRoot, '.ai-tester-tools'), 'dependency root');
  const cleanupTargets = (input.cleanupTargets ?? [checkoutRoot, outputRoot, homeRoot, configRoot, dependencyRoot])
    .map((target) => assertDescendantPath(sandboxRoot, target, 'cleanup target'));
  const confirmations = normalizeConfirmations(input.confirmations);

  return {
    schema: UNDERSTAND_ANYTHING_SANDBOX_SCHEMA,
    command: 'ai-tester',
    sandbox_root: toPublicPath(sandboxRoot, sandboxRoot),
    roots: {
      checkout: toPublicPath(sandboxRoot, checkoutRoot),
      fixture: toPublicPath(sandboxRoot, fixtureRoot),
      output: toPublicPath(sandboxRoot, outputRoot),
      home: toPublicPath(sandboxRoot, homeRoot),
      config: toPublicPath(sandboxRoot, configRoot),
      dependencies: toPublicPath(sandboxRoot, dependencyRoot)
    },
    confirmations,
    cleanup_targets: cleanupTargets.map((target) => toPublicPath(sandboxRoot, target)),
    limits: {
      ...DEFAULT_LIMITS,
      ...(input.limits ?? {})
    }
  };
}

export async function runUnderstandAnythingSandbox(input = {}, options = {}) {
  const eligibility = input.eligibility ?? evaluateUnderstandAnythingEligibility({
    audit: input.audit,
    runtime: input.runtime
  });

  if (eligibility.outcome !== GATE_PASS) {
    return sandboxResult('eligibility', GATE_BLOCKED, 'eligibility_not_pass', {
      executor_invoked: false,
      eligibility_outcome: eligibility.outcome
    });
  }

  if (typeof options.aiTesterExecutor !== 'function') {
    return sandboxResult('prepare', GATE_BLOCKED, 'ai_tester_executor_missing', {
      executor_invoked: false,
      eligibility_outcome: eligibility.outcome
    });
  }

  let plan;
  try {
    plan = buildUnderstandAnythingSandboxPlan(input);
  } catch (error) {
    return sandboxResult('prepare', GATE_FAIL, normalizeErrorCode(error, 'sandbox_plan_invalid'), {
      executor_invoked: false
    });
  }

  if (!hasRequiredConfirmations(plan.confirmations)) {
    return sandboxResult('prepare', GATE_BLOCKED, 'required_confirmations_missing', {
      executor_invoked: false
    });
  }

  if (typeof options.logger === 'function') {
    options.logger('INFO', {
      sandbox_id: input.sandboxId ?? 'sandbox',
      phase: 'execute',
      status: 'starting'
    });
  }

  const execution = await options.aiTesterExecutor({
    plan,
    command: 'ai-tester',
    confirmations: plan.confirmations,
    limits: plan.limits
  });

  const cleanup = await verifySandboxCleanup({
    sandboxRoot: path.resolve(input.sandboxRoot ?? '.ua-sandbox'),
    cleanupTargets: plan.cleanup_targets,
    listResidualPaths: options.listResidualPaths,
    listResidualProcesses: options.listResidualProcesses
  });

  if (execution?.status !== GATE_PASS) {
    return sandboxResult('execute', GATE_FAIL, execution?.reason_code ?? 'ai_tester_execution_failed', {
      executor_invoked: true,
      cleanup,
      output_schema_detected: Boolean(execution?.output_schema_detected)
    });
  }

  if (execution?.output_schema_detected !== true) {
    return sandboxResult('execute', GATE_FAIL, 'output_schema_missing', {
      executor_invoked: true,
      cleanup
    });
  }

  if (cleanup.status !== GATE_PASS) {
    return sandboxResult('cleanup', GATE_FAIL, cleanup.reason_code, {
      executor_invoked: true,
      cleanup,
      output_schema_detected: true
    });
  }

  return sandboxResult('cleanup', GATE_PASS, 'sandbox_passed', {
    executor_invoked: true,
    cleanup,
    output_schema_detected: true
  });
}

export function assertDescendantPath(sandboxRoot, targetPath, label) {
  const root = path.resolve(sandboxRoot);
  const target = path.resolve(targetPath);
  const relative = path.relative(root, target);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    const error = new Error(`${label} must stay inside the sandbox root`);
    error.code = 'sandbox_path_escape';
    throw error;
  }
  return target;
}

async function verifySandboxCleanup({ sandboxRoot, cleanupTargets, listResidualPaths, listResidualProcesses }) {
  const residualPathsRaw = typeof listResidualPaths === 'function'
    ? await listResidualPaths()
    : [];
  for (const item of residualPathsRaw) {
    assertDescendantPath(sandboxRoot, item, 'residual path');
  }
  const residualProcessesRaw = typeof listResidualProcesses === 'function'
    ? await listResidualProcesses()
    : [];

  const residualPaths = residualPathsRaw.map((item) => toPublicPath(sandboxRoot, item));
  const residualProcesses = residualProcessesRaw.map((item) => String(item));
  void cleanupTargets;

  return {
    status: residualPaths.length === 0 && residualProcesses.length === 0 ? GATE_PASS : GATE_FAIL,
    reason_code: residualPaths.length === 0 && residualProcesses.length === 0
      ? 'cleanup_verified'
      : 'cleanup_residual_detected',
    residual_path_count: residualPaths.length,
    residual_process_count: residualProcesses.length,
    residual_paths: residualPaths,
    residual_processes: residualProcesses
  };
}

function normalizeConfirmations(confirmations = []) {
  return Array.isArray(confirmations)
    ? confirmations
      .filter((item) => item && typeof item.id === 'string' && typeof item.response === 'string')
      .map((item) => ({
        id: item.id,
        response: item.response,
        bounded: item.bounded !== false
      }))
    : [];
}

function hasRequiredConfirmations(confirmations) {
  const ids = new Set(confirmations.filter((item) => item.bounded === true).map((item) => item.id));
  return ids.has('understandignore_reviewed') && ids.has('workspace_private_confirmation');
}

function sandboxResult(phase, status, reasonCode, extra = {}) {
  return {
    schema: UNDERSTAND_ANYTHING_SANDBOX_SCHEMA,
    phase,
    status,
    reason_code: reasonCode,
    ...extra
  };
}

function normalizeErrorCode(error, fallback) {
  return typeof error?.code === 'string' ? error.code : fallback;
}

function toPublicPath(root, target) {
  const relative = path.relative(root, target);
  return relative ? relative.replaceAll('\\', '/') : '.';
}
