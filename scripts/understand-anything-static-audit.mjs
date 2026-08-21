// understand-anything-static-audit.mjs - static audit and protected-boundary contracts
import path from 'node:path';

export const UNDERSTAND_ANYTHING_STATIC_AUDIT_SCHEMA = 'aifhub.understand_anything.static_audit.v1';
export const UNDERSTAND_ANYTHING_REPOSITORY = 'https://github.com/Egonex-AI/Understand-Anything';
export const UNDERSTAND_ANYTHING_PINNED_TAG = 'v2.9.0';
export const UNDERSTAND_ANYTHING_PINNED_COMMIT = 'f08763d11d0202a8a8f52b5dedda6d1b2e2ebac8';
export const GATE_PASS = 'PASS';
export const GATE_FAIL = 'FAIL';
export const GATE_BLOCKED = 'BLOCKED';

export const REQUIRED_CLAIM_IDS = [
  'license',
  'private_workspace_package',
  'package_scripts',
  'interactive_skill_steps',
  'agent_and_subagent_prompts',
  'filesystem_scope',
  'ua_schema',
  'hooks',
  'viewer',
  'network_and_model',
  'windows_behavior',
  'purge_inventory'
];

const DEFAULT_AGENT_CONFIG_ROOTS = [
  '.codex',
  '.agents'
];
const DEFAULT_SKILL_ROOTS = [
  '.codex/skills'
];
const DEFAULT_PLUGIN_ROOTS = [
  '.codex/plugins'
];

export function validateUnderstandAnythingStaticAudit(audit, options = {}) {
  const workspaceRoot = path.resolve(options.workspaceRoot ?? process.cwd());
  const protectedBoundary = evaluateProtectedWrites(audit?.protected_boundaries?.forbidden_write_targets ?? [], {
    workspaceRoot,
    userHome: options.userHome
  });
  const errors = [];
  const warnings = [];
  const claims = normalizeClaims(audit?.claims);

  if (audit?.schema !== UNDERSTAND_ANYTHING_STATIC_AUDIT_SCHEMA) {
    errors.push(issue('schema_mismatch', 'Static audit schema must match the pinned contract.'));
  }

  if (audit?.provider?.id !== 'understand-anything') {
    errors.push(issue('provider_id_mismatch', 'Provider id must be understand-anything.'));
  }

  if (audit?.provider?.repository !== UNDERSTAND_ANYTHING_REPOSITORY) {
    errors.push(issue('provider_repository_mismatch', 'Provider repository must match the exact upstream identity.'));
  }

  if (audit?.revision?.tag !== UNDERSTAND_ANYTHING_PINNED_TAG) {
    errors.push(issue('revision_tag_mismatch', 'Static audit must pin the exact reviewed tag.'));
  }

  if (audit?.revision?.commit !== UNDERSTAND_ANYTHING_PINNED_COMMIT) {
    errors.push(issue('revision_commit_mismatch', 'Static audit must pin the exact reviewed commit.'));
  }

  for (const sectionName of [
    'license',
    'workspace',
    'package_scripts',
    'interactive_skill',
    'filesystem_scope',
    'ua_schema',
    'hooks',
    'viewer',
    'network_model',
    'windows_behavior',
    'purge_inventory',
    'protected_boundaries'
  ]) {
    if (!isRecord(audit?.[sectionName])) {
      errors.push(issue('missing_section', `Static audit is missing required section: ${sectionName}.`, { section: sectionName }));
    }
  }

  const seenClaimIds = new Set();
  for (const claim of claims) {
    seenClaimIds.add(claim.id);
    if (!REQUIRED_CLAIM_IDS.includes(claim.id)) {
      warnings.push(issue('unknown_claim', 'Static audit contains an unknown claim id.', { claim_id: claim.id }));
    }

    if (!isGateStatus(claim.status)) {
      errors.push(issue('invalid_claim_status', 'Static audit claim status must be PASS, FAIL, or BLOCKED.', { claim_id: claim.id }));
    }

    if (!Array.isArray(claim.source_refs) || claim.source_refs.length === 0) {
      errors.push(issue('missing_source_refs', 'Static audit claims require at least one compact source reference.', { claim_id: claim.id }));
      continue;
    }

    for (const sourceRef of claim.source_refs) {
      const refErrors = validateSourceRef(sourceRef);
      for (const refError of refErrors) {
        errors.push(issue(refError.code, refError.message, { claim_id: claim.id }));
      }
    }
  }

  for (const claimId of REQUIRED_CLAIM_IDS) {
    if (!seenClaimIds.has(claimId)) {
      errors.push(issue('missing_claim', 'Static audit is missing a required claim.', { claim_id: claimId }));
    }
  }

  const gate = summarizeGate([
    ...claims.map((claim) => claim.status),
    protectedBoundary.gate.status
  ], errors.length);

  logAudit(options.logger, gate.status, {
    claim_count: claims.length,
    warning_count: warnings.length,
    protected_boundary_status: protectedBoundary.gate.status,
    revision: `${UNDERSTAND_ANYTHING_PINNED_TAG}@${UNDERSTAND_ANYTHING_PINNED_COMMIT.slice(0, 12)}`
  });

  return {
    schema: UNDERSTAND_ANYTHING_STATIC_AUDIT_SCHEMA,
    valid: errors.length === 0,
    gate,
    protected_boundary: protectedBoundary,
    errors,
    warnings,
    summary: {
      required_claims: REQUIRED_CLAIM_IDS.length,
      observed_claims: claims.length
    }
  };
}

export function evaluateProtectedWrites(writeTargets = [], options = {}) {
  const workspaceRoot = path.resolve(options.workspaceRoot ?? process.cwd());
  const violations = [];

  for (const target of writeTargets) {
    const boundary = classifyProtectedBoundary(target, {
      workspaceRoot,
      userHome: options.userHome
    });
    if (boundary) {
      violations.push(boundary);
    }
  }

  const status = violations.length === 0 ? GATE_PASS : GATE_FAIL;
  if (violations.length > 0) {
    logAudit(options.logger, status, {
      violation_count: violations.length,
      categories: [...new Set(violations.map((item) => item.category))]
    });
  }

  return {
    gate: {
      status,
      reason_code: violations.length === 0 ? 'no_protected_write_targets' : 'protected_write_target_detected'
    },
    violations
  };
}

export function classifyProtectedBoundary(targetPath, options = {}) {
  if (typeof targetPath !== 'string' || !targetPath.trim()) return null;

  const workspaceRoot = path.resolve(options.workspaceRoot ?? process.cwd());
  const userHome = options.userHome ? path.resolve(options.userHome) : null;
  const absoluteTarget = path.resolve(targetPath);
  const roots = buildProtectedRoots(workspaceRoot, userHome);
  const relativeWorkspace = safeRelative(workspaceRoot, absoluteTarget);

  if (relativeWorkspace && isExactOrDescendant(relativeWorkspace, 'openspec')) {
    return protectedViolation('openspec', `workspace:${toPosix(relativeWorkspace)}`);
  }
  if (relativeWorkspace && isExactOrDescendant(relativeWorkspace, '.ai-factory/rules/generated')) {
    return protectedViolation('generated_rules', `workspace:${toPosix(relativeWorkspace)}`);
  }
  if (relativeWorkspace && isExactOrDescendant(relativeWorkspace, '.ai-factory/qa')) {
    return protectedViolation('qa_evidence', `workspace:${toPosix(relativeWorkspace)}`);
  }
  for (const skillRoot of roots.globalSkillRoots) {
    const relative = safeRelative(skillRoot, absoluteTarget);
    if (relative) return protectedViolation('global_skill_path', `global-skill:${toPosix(relative)}`);
  }
  for (const pluginRoot of roots.globalPluginRoots) {
    const relative = safeRelative(pluginRoot, absoluteTarget);
    if (relative) return protectedViolation('global_plugin_path', `global-plugin:${toPosix(relative)}`);
  }
  for (const configRoot of roots.agentConfigRoots) {
    const relative = safeRelative(configRoot, absoluteTarget);
    if (relative) return protectedViolation('agent_config', `agent-config:${toPosix(relative)}`);
  }
  const hooksRelative = safeRelative(path.join(workspaceRoot, '.git', 'hooks'), absoluteTarget);
  if (hooksRelative) {
    return protectedViolation('git_hooks', `git-hooks:${toPosix(hooksRelative)}`);
  }
  if (relativeWorkspace) {
    return protectedViolation('current_checkout', `workspace:${toPosix(relativeWorkspace)}`);
  }
  return null;
}

function buildProtectedRoots(workspaceRoot, userHome) {
  return {
    agentConfigRoots: userHome
      ? DEFAULT_AGENT_CONFIG_ROOTS.map((entry) => path.join(userHome, entry))
      : [],
    globalSkillRoots: userHome
      ? DEFAULT_SKILL_ROOTS.map((entry) => path.join(userHome, entry))
      : [],
    globalPluginRoots: userHome
      ? DEFAULT_PLUGIN_ROOTS.map((entry) => path.join(userHome, entry))
      : [],
    workspaceRoot
  };
}

function normalizeClaims(claims) {
  if (!Array.isArray(claims)) return [];
  return claims
    .filter(isRecord)
    .map((claim) => ({
      id: String(claim.id ?? ''),
      status: String(claim.status ?? '').toUpperCase(),
      source_refs: Array.isArray(claim.source_refs) ? claim.source_refs : []
    }));
}

function validateSourceRef(sourceRef) {
  const errors = [];
  if (!isRecord(sourceRef)) {
    return [issue('invalid_source_ref', 'Static audit source references must be structured objects.')];
  }
  if (typeof sourceRef.path !== 'string' || !sourceRef.path.trim()) {
    errors.push(issue('missing_source_ref_path', 'Static audit source references must contain a compact relative path.'));
  }
  if (typeof sourceRef.path === 'string' && (path.isAbsolute(sourceRef.path) || /^[A-Za-z]:[\\/]/.test(sourceRef.path))) {
    errors.push(issue('absolute_source_ref_path', 'Static audit source references must not expose absolute paths.'));
  }
  if (typeof sourceRef.kind !== 'string' || !sourceRef.kind.trim()) {
    errors.push(issue('missing_source_ref_kind', 'Static audit source references must identify the compact source-ref kind.'));
  }
  if ('source_body' in sourceRef || 'raw_source' in sourceRef || 'contents' in sourceRef) {
    errors.push(issue('raw_source_leak', 'Static audit source references must not embed raw source bodies.'));
  }
  return errors;
}

function summarizeGate(statuses, errorCount) {
  if (errorCount > 0) {
    return {
      status: GATE_FAIL,
      counts: countStatuses(statuses),
      reason_code: 'contract_validation_failed'
    };
  }
  if (statuses.includes(GATE_FAIL)) {
    return {
      status: GATE_FAIL,
      counts: countStatuses(statuses),
      reason_code: 'audit_claim_failed'
    };
  }
  if (statuses.includes(GATE_BLOCKED)) {
    return {
      status: GATE_BLOCKED,
      counts: countStatuses(statuses),
      reason_code: 'audit_claim_blocked'
    };
  }
  return {
    status: GATE_PASS,
    counts: countStatuses(statuses),
    reason_code: 'audit_claims_passed'
  };
}

function countStatuses(statuses) {
  const counts = { PASS: 0, FAIL: 0, BLOCKED: 0 };
  for (const status of statuses) {
    if (status === GATE_PASS || status === GATE_FAIL || status === GATE_BLOCKED) {
      counts[status] += 1;
    }
  }
  return counts;
}

function protectedViolation(category, pathLabel) {
  return { category, path: pathLabel };
}

function safeRelative(root, target) {
  const relative = path.relative(root, target);
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    return relative || '.';
  }
  return null;
}

function isExactOrDescendant(candidate, expectedPrefix) {
  const normalizedCandidate = toPosix(candidate);
  const normalizedExpected = toPosix(expectedPrefix);
  return normalizedCandidate === normalizedExpected || normalizedCandidate.startsWith(`${normalizedExpected}/`);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isGateStatus(value) {
  return value === GATE_PASS || value === GATE_FAIL || value === GATE_BLOCKED;
}

function issue(code, message, extra = {}) {
  return { code, message, ...extra };
}

function logAudit(logger, level, details) {
  if (typeof logger === 'function') logger(level, details);
}

function toPosix(value) {
  return String(value).replaceAll('\\', '/');
}
