// understand-anything-eligibility.mjs - fail-closed agent-skill eligibility gates
import {
  GATE_BLOCKED,
  GATE_FAIL,
  GATE_PASS,
  UNDERSTAND_ANYTHING_PINNED_COMMIT,
  UNDERSTAND_ANYTHING_PINNED_TAG
} from './understand-anything-static-audit.mjs';

export const UNDERSTAND_ANYTHING_ELIGIBILITY_SCHEMA = 'aifhub.understand_anything.eligibility.v1';

const REQUIRED_GATES = [
  'exact_revision',
  'private_workspace_preparation',
  'interactive_skill_execution',
  'understandignore_confirmations',
  'bounded_subagents',
  'path_isolation',
  'config_and_credentials',
  'hooks_viewer_daemon_disabled',
  'output_schema',
  'cleanup_inventory',
  'windows_behavior'
];

export function evaluateUnderstandAnythingEligibility(input = {}, options = {}) {
  const audit = input.audit ?? {};
  const runtime = input.runtime ?? {};
  const gates = [
    exactRevisionGate(audit, runtime),
    privateWorkspaceGate(audit, runtime),
    simpleGate('interactive_skill_execution', runtime.interactive_skill_execution, 'interactive_skill_execution_missing'),
    understandIgnoreGate(runtime.understandignore_confirmations),
    boundedSubagentsGate(audit, runtime),
    pathIsolationGate(runtime.path_isolation),
    configAndCredentialsGate(runtime.config_and_credentials),
    hooksViewerDaemonGate(audit, runtime),
    outputSchemaGate(audit, runtime),
    cleanupGate(audit, runtime),
    windowsGate(audit, runtime)
  ];

  const outcome = summarizeEligibility(gates);
  if (typeof options.logger === 'function') {
    for (const gate of gates) {
      options.logger(gate.status === GATE_FAIL ? 'ERROR' : gate.status === GATE_BLOCKED ? 'WARN' : 'DEBUG', {
        gate_id: gate.id,
        status: gate.status,
        reason_code: gate.reason_code
      });
    }
    options.logger('INFO', {
      outcome,
      gate_count: gates.length
    });
  }

  return {
    schema: UNDERSTAND_ANYTHING_ELIGIBILITY_SCHEMA,
    outcome,
    gates,
    summary: {
      required_gates: REQUIRED_GATES,
      pass: gates.filter((gate) => gate.status === GATE_PASS).length,
      fail: gates.filter((gate) => gate.status === GATE_FAIL).length,
      blocked: gates.filter((gate) => gate.status === GATE_BLOCKED).length
    }
  };
}

function exactRevisionGate(audit, runtime) {
  if (runtime.exact_revision === false) {
    return gate('exact_revision', GATE_FAIL, 'revision_drift_detected');
  }
  if (runtime.exact_revision !== true) {
    return gate('exact_revision', GATE_BLOCKED, 'revision_runtime_unverified');
  }
  if (audit?.revision?.tag !== UNDERSTAND_ANYTHING_PINNED_TAG || audit?.revision?.commit !== UNDERSTAND_ANYTHING_PINNED_COMMIT) {
    return gate('exact_revision', GATE_FAIL, 'revision_audit_mismatch');
  }
  return gate('exact_revision', GATE_PASS, 'revision_verified');
}

function privateWorkspaceGate(audit, runtime) {
  if (runtime.private_workspace_preparation === false) {
    return gate('private_workspace_preparation', GATE_FAIL, 'private_workspace_preparation_failed');
  }
  if (runtime.private_workspace_preparation !== true) {
    return gate('private_workspace_preparation', GATE_BLOCKED, 'private_workspace_preparation_unverified');
  }
  if (audit?.workspace?.private_workspace_package !== true) {
    return gate('private_workspace_preparation', GATE_FAIL, 'audit_requires_private_workspace');
  }
  return gate('private_workspace_preparation', GATE_PASS, 'private_workspace_preparation_verified');
}

function understandIgnoreGate(value) {
  if (value?.authored === true && value?.bounded === true) {
    return gate('understandignore_confirmations', GATE_PASS, 'authored_confirmations_verified');
  }
  if (value?.authored === false || value?.bounded === false) {
    return gate('understandignore_confirmations', GATE_FAIL, 'authored_confirmations_missing');
  }
  return gate('understandignore_confirmations', GATE_BLOCKED, 'authored_confirmations_unverified');
}

function boundedSubagentsGate(audit, runtime) {
  if (runtime.bounded_subagents?.verified === false) {
    return gate('bounded_subagents', GATE_FAIL, 'subagent_bound_failed');
  }
  if (runtime.bounded_subagents?.verified !== true) {
    return gate('bounded_subagents', GATE_BLOCKED, 'subagent_bound_unverified');
  }
  const expectedMax = audit?.interactive_skill?.bounded_subagents_max;
  if (!Number.isFinite(expectedMax) || expectedMax <= 0) {
    return gate('bounded_subagents', GATE_BLOCKED, 'subagent_bound_missing_from_audit');
  }
  if (Number(runtime.bounded_subagents?.observed_max ?? Number.NaN) > expectedMax) {
    return gate('bounded_subagents', GATE_FAIL, 'subagent_bound_exceeded');
  }
  return gate('bounded_subagents', GATE_PASS, 'subagent_bound_verified');
}

function pathIsolationGate(value) {
  if (value?.fixture_root === true && value?.output_root === true && value?.dependency_root === true) {
    return gate('path_isolation', GATE_PASS, 'path_isolation_verified');
  }
  if (value?.fixture_root === false || value?.output_root === false || value?.dependency_root === false) {
    return gate('path_isolation', GATE_FAIL, 'path_isolation_failed');
  }
  return gate('path_isolation', GATE_BLOCKED, 'path_isolation_unverified');
}

function configAndCredentialsGate(value) {
  if (value?.home_isolated === true && value?.config_isolated === true && value?.credentials_exposed === false) {
    return gate('config_and_credentials', GATE_PASS, 'config_and_credentials_verified');
  }
  if (value?.credentials_exposed === true || value?.home_isolated === false || value?.config_isolated === false) {
    return gate('config_and_credentials', GATE_FAIL, 'config_or_credentials_failed');
  }
  return gate('config_and_credentials', GATE_BLOCKED, 'config_or_credentials_unverified');
}

function hooksViewerDaemonGate(audit, runtime) {
  if (runtime.hooks_viewer_daemon_disabled?.verified === false) {
    return gate('hooks_viewer_daemon_disabled', GATE_FAIL, 'hooks_viewer_daemon_runtime_failed');
  }
  if (runtime.hooks_viewer_daemon_disabled?.verified !== true) {
    return gate('hooks_viewer_daemon_disabled', GATE_BLOCKED, 'hooks_viewer_daemon_runtime_unverified');
  }
  if (audit?.hooks?.installs_git_hooks !== false || audit?.viewer?.enabled !== false || audit?.viewer?.daemon !== false) {
    return gate('hooks_viewer_daemon_disabled', GATE_FAIL, 'hooks_viewer_daemon_audit_failed');
  }
  return gate('hooks_viewer_daemon_disabled', GATE_PASS, 'hooks_viewer_daemon_verified');
}

function outputSchemaGate(audit, runtime) {
  if (runtime.output_schema?.detected === false) {
    return gate('output_schema', GATE_FAIL, 'output_schema_missing');
  }
  if (runtime.output_schema?.detected !== true) {
    return gate('output_schema', GATE_BLOCKED, 'output_schema_unverified');
  }
  if (typeof audit?.ua_schema?.version !== 'string' || !audit.ua_schema.version) {
    return gate('output_schema', GATE_FAIL, 'output_schema_audit_missing');
  }
  return gate('output_schema', GATE_PASS, 'output_schema_verified');
}

function cleanupGate(audit, runtime) {
  if (runtime.cleanup_inventory?.verified === false) {
    return gate('cleanup_inventory', GATE_FAIL, 'cleanup_inventory_failed');
  }
  if (runtime.cleanup_inventory?.verified !== true) {
    return gate('cleanup_inventory', GATE_BLOCKED, 'cleanup_inventory_unverified');
  }
  if (audit?.purge_inventory?.requires_descendant_cleanup !== true) {
    return gate('cleanup_inventory', GATE_FAIL, 'cleanup_inventory_audit_missing');
  }
  if (runtime.cleanup_inventory?.descendant_only !== true || runtime.cleanup_inventory?.residual_count !== 0) {
    return gate('cleanup_inventory', GATE_FAIL, 'cleanup_inventory_residual_detected');
  }
  return gate('cleanup_inventory', GATE_PASS, 'cleanup_inventory_verified');
}

function windowsGate(audit, runtime) {
  if (runtime.windows_behavior?.supports_spaces === false) {
    return gate('windows_behavior', GATE_FAIL, 'windows_spaces_failed');
  }
  if (runtime.windows_behavior?.supports_spaces !== true) {
    return gate('windows_behavior', GATE_BLOCKED, 'windows_spaces_unverified');
  }
  if (audit?.windows_behavior?.supports_spaces !== true) {
    return gate('windows_behavior', GATE_FAIL, 'windows_audit_missing');
  }
  return gate('windows_behavior', GATE_PASS, 'windows_spaces_verified');
}

function simpleGate(id, value, blockedReason) {
  if (value === true) return gate(id, GATE_PASS, `${id}_verified`);
  if (value === false) return gate(id, GATE_FAIL, `${id}_failed`);
  return gate(id, GATE_BLOCKED, blockedReason);
}

function summarizeEligibility(gates) {
  if (gates.some((gate) => gate.status === GATE_FAIL)) return GATE_FAIL;
  if (gates.some((gate) => gate.status === GATE_BLOCKED)) return GATE_BLOCKED;
  return GATE_PASS;
}

function gate(id, status, reasonCode) {
  return { id, status, reason_code: reasonCode };
}
