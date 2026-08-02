// context-mode-codex-ai-tester-results.mjs - bounded full-trace normalization for issue #134
import { lstat, realpath, rm } from 'node:fs/promises';
import path from 'node:path';

export const CONTEXT_MODE_RESULTS_SCHEMA = 'aifhub.context_mode_codex.ai_tester_results.v1';

export function normalizeContextModeTrace(record = {}) {
  const costKeys = [
    'cold_setup_ms',
    'mcp_startup_ms',
    'index_ms',
    'warm_query_ms',
    'answer_ms',
    'input_tokens',
    'output_tokens'
  ];
  const cost = Object.fromEntries(costKeys.map((key) => [key, finiteNonNegativeOrNull(record.cost?.[key])]));
  cost.input_output_tokens = Number.isFinite(cost.input_tokens) && Number.isFinite(cost.output_tokens)
    ? cost.input_tokens + cost.output_tokens
    : null;
  const required = positiveIntegerOrNull(record.scoring?.required_facts);
  const recovered = nonNegativeIntegerOrNull(record.scoring?.recovered_facts);
  const lifecycleComplete = ['privacy', 'purge', 'cleanup', 'continuity']
    .every((key) => typeof record.lifecycle?.[key] === 'boolean');
  const scoringComplete = typeof record.scoring?.overall_pass === 'boolean' &&
    required !== null && recovered !== null && recovered <= required;
  const turnsComplete = Array.isArray(record.turns) && record.turns.every((turn) =>
    Number.isInteger(Number(turn?.tool_calls)) && Number(turn.tool_calls) >= 0
  );
  const identityComplete = [record.row_id, record.triad_id, record.variant,
    record.settings_fingerprint, record.evidence_class]
    .every((value) => typeof value === 'string' && value.length > 0);
  const complete = identityComplete && scoringComplete && lifecycleComplete &&
    costKeys.every((key) => cost[key] !== null) && turnsComplete &&
    typeof record.final_output === 'string';
  const requestedStatus = ['PASS', 'FAIL', 'BLOCKED', 'NOT_RUN'].includes(record.status)
    ? record.status
    : null;
  const status = requestedStatus === 'PASS' || requestedStatus === null
    ? (complete && record.scoring.overall_pass === true ? 'PASS' : 'FAIL')
    : requestedStatus;
  const incomplete = (requestedStatus === 'PASS' || requestedStatus === null) && !complete;
  return {
    row_id: record.row_id,
    triad_id: record.triad_id,
    variant: record.variant,
    status,
    reason: incomplete ? 'incomplete_trace_evidence' :
      (record.reason ?? (status === 'FAIL' && record.scoring?.overall_pass === false ? 'assertions_failed' : undefined)),
    settings_fingerprint: record.settings_fingerprint,
    correctness_pass: status === 'PASS' && record.scoring?.overall_pass === true && recovered === required,
    fact_coverage: required === null || recovered === null ? null : recovered / required,
    privacy_pass: record.lifecycle?.privacy === true,
    purge_pass: record.lifecycle?.purge === true,
    cleanup_pass: record.lifecycle?.cleanup === true,
    continuity_pass: record.lifecycle?.continuity === true,
    evidence_class: record.evidence_class,
    cost,
    tool_calls: (record.turns ?? []).reduce(
      (total, turn) => total + numberOrZero(turn.tool_calls),
      0
    ),
    turns: Array.isArray(record.turns) ? record.turns.length : 0,
    final_output_bytes: Buffer.byteLength(String(record.final_output ?? ''))
  };
}

export function scanCompleteTrace(record, {
  canaries = [],
  contentFingerprints = []
} = {}) {
  const serialized = JSON.stringify(record);
  const scanText = serialized.replaceAll('\\\\', '\\');
  const reasons = new Set();
  let matchCount = 0;
  const patterns = [
    ['credential_material', /(?:OPENAI_API_KEY|GITHUB_TOKEN|AWS_SECRET_ACCESS_KEY|DATABASE_URL|SSH_AUTH_SOCK|authorization|password|api[_-]?key|token)\s*["']?\s*[:=]\s*["']?[^\s"',}]{4,}/gi],
    ['private_key_material', /BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY/gi],
    ['absolute_path', /(?:[A-Za-z]:\\(?:Users|projects|Temp)\\|\/(?:Users|home|tmp)\/)[^"'\s]*/gi]
  ];
  for (const [reason, pattern] of patterns) {
    const matches = scanText.match(pattern) ?? [];
    if (matches.length > 0) {
      reasons.add(reason);
      matchCount += matches.length;
    }
  }
  for (const canary of canaries) {
    if (canary && serialized.includes(canary)) {
      reasons.add('canary_material');
      matchCount += 1;
    }
  }
  for (const content of contentFingerprints) {
    if (content && serialized.includes(content)) {
      reasons.add('indexed_content');
      matchCount += 1;
    }
  }
  return {
    safe: reasons.size === 0,
    reason_codes: [...reasons].sort(),
    match_count: matchCount
  };
}

export async function sanitizeAndDeleteUnsafeTrace({ tracePath, scan, allowedRoot, logger }) {
  if (scan?.safe !== false) {
    return { status: 'PASS', reason_codes: [], match_count: 0, raw_trace_deleted: false };
  }
  const blocked = () => {
    logFix(logger, 'unsafe_trace_delete_blocked', { reason: 'unsafe_trace_delete_target' });
    return {
      status: 'BLOCKED',
      reason_codes: ['unsafe_trace_delete_target'],
      match_count: numberOrZero(scan.match_count),
      raw_trace_deleted: false
    };
  };
  if (!allowedRoot || !tracePath) return blocked();
  try {
    const resolvedRoot = path.resolve(allowedRoot);
    if (path.parse(resolvedRoot).root === resolvedRoot) return blocked();
    const [rootInfo, targetInfo] = await Promise.all([lstat(resolvedRoot), lstat(tracePath)]);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || targetInfo.isSymbolicLink()) return blocked();
    const [canonicalRoot, canonicalTarget] = await Promise.all([
      realpath(resolvedRoot),
      realpath(tracePath)
    ]);
    const relative = path.relative(canonicalRoot, canonicalTarget);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return blocked();
  } catch {
    return blocked();
  }
  await rm(tracePath, { force: true });
  logFix(logger, 'unsafe_trace_deleted', {
    reason_count: new Set(scan.reason_codes ?? []).size,
    match_count: numberOrZero(scan.match_count)
  });
  return {
    status: 'FAIL',
    reason_codes: [...new Set(scan.reason_codes ?? [])].sort(),
    match_count: numberOrZero(scan.match_count),
    raw_trace_deleted: true
  };
}

export function buildContextModeResults(rows = []) {
  const triadIds = [...new Set(rows.map((row) => row.triad_id))].sort();
  const triads = triadIds.map((triadId) => buildTriad(
    triadId,
    rows.filter((row) => row.triad_id === triadId)
  ));
  return {
    schema: CONTEXT_MODE_RESULTS_SCHEMA,
    expected_variants_per_triad: 3,
    rows: rows.map(sanitizeRow),
    triads,
    mcp_outcome: reduceDecision(triads.map((triad) => triad.mcp_decision)),
    plugin_outcome: reduceDecision(triads.map((triad) => triad.plugin_decision)),
    gates: {
      correctness_veto: true,
      privacy_veto: true,
      lifecycle_veto: true,
      purge_veto: true,
      cleanup_veto: true
    }
  };
}

function buildTriad(triadId, rows) {
  const variants = Object.fromEntries(rows.map((row) => [row.variant, row]));
  const fingerprints = new Set(rows.map((row) => row.settings_fingerprint).filter(Boolean));
  const complete = ['baseline', 'mcp_only', 'codex_plugin'].every((variant) => variants[variant]);
  const symmetric = fingerprints.size === 1 && rows.length === 3;
  return {
    triad_id: triadId,
    complete,
    symmetric,
    mcp_decision: decideCandidate(variants.baseline, variants.mcp_only, { positive: 'conditional', symmetric }),
    plugin_decision: decideCandidate(variants.baseline, variants.codex_plugin, { positive: 'recommend', symmetric }),
    mcp_token_delta: tokenDelta(variants.baseline, variants.mcp_only),
    plugin_token_delta: tokenDelta(variants.baseline, variants.codex_plugin)
  };
}

function decideCandidate(baseline, candidate, { positive, symmetric }) {
  if (!candidate || candidate.status === 'NOT_RUN') return 'NOT_RUN';
  if (!baseline || baseline.status !== 'PASS') return 'NOT_RUN';
  if (!symmetric) return 'avoid';
  if (candidate.status === 'BLOCKED') return 'forbid';
  if (candidate.status !== 'PASS' || candidate.privacy_pass === false ||
      candidate.purge_pass === false || candidate.cleanup_pass === false) {
    return 'forbid';
  }
  if (candidate.correctness_pass !== true || candidate.continuity_pass === false) return 'avoid';
  return positive;
}

function tokenDelta(baseline, candidate) {
  const baselineTokens = baseline?.cost?.input_output_tokens;
  const candidateTokens = candidate?.cost?.input_output_tokens;
  if (!Number.isFinite(baselineTokens) || !Number.isFinite(candidateTokens)) return null;
  return candidateTokens - baselineTokens;
}

function reduceDecision(decisions) {
  if (decisions.includes('forbid')) return 'forbid';
  if (decisions.includes('avoid')) return 'avoid';
  if (decisions.length === 0 || decisions.includes('NOT_RUN')) return 'NOT_RUN';
  if (decisions.every((decision) => decision === 'recommend')) return 'recommend';
  return 'conditional';
}

function sanitizeRow(row) {
  return {
    row_id: row.row_id,
    triad_id: row.triad_id,
    variant: row.variant,
    status: row.status,
    reason: row.reason,
    settings_fingerprint: row.settings_fingerprint,
    correctness_pass: row.correctness_pass,
    privacy_pass: row.privacy_pass,
    purge_pass: row.purge_pass,
    cleanup_pass: row.cleanup_pass,
    continuity_pass: row.continuity_pass,
    evidence_class: row.evidence_class,
    cost: row.cost
  };
}

function numberOrZero(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function finiteNonNegativeOrNull(value) {
  const numeric = Number(value);
  return value !== null && value !== undefined && Number.isFinite(numeric) && numeric >= 0
    ? numeric
    : null;
}

function positiveIntegerOrNull(value) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
}

function nonNegativeIntegerOrNull(value) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric >= 0 ? numeric : null;
}

function logFix(logger, event, fields) {
  if (typeof logger !== 'function') return;
  logger(`[FIX:134] ${event} ${JSON.stringify(fields)}`);
}
