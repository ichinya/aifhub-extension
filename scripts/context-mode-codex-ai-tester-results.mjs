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

export function auditCodexRolloutRecords(records = [], {
  sandboxRoot,
  requiredTools = [],
  allowedTools = [],
  allowedCommands = [],
  providerServer = 'context-mode'
} = {}) {
  const calls = [];
  let invalidArguments = false;
  for (const record of records) {
    walkRecord(record, (candidate) => {
      if (candidate.server !== providerServer || typeof candidate.tool !== 'string' ||
          !/^ctx_[a-z0-9_]+$/.test(candidate.tool)) return;
      let args = candidate.arguments ?? {};
      if (typeof args === 'string') {
        try {
          args = JSON.parse(args);
        } catch {
          invalidArguments = true;
          args = {};
        }
      }
      calls.push({ tool: candidate.tool, arguments: args });
    });
  }
  const toolCounts = {};
  for (const call of calls) toolCounts[call.tool] = (toolCounts[call.tool] ?? 0) + 1;
  const sortedToolCounts = Object.fromEntries(Object.entries(toolCounts).sort(([left], [right]) =>
    left.localeCompare(right)
  ));
  const requiredPresent = requiredTools.every((tool) => toolCounts[tool] > 0);
  const allowed = new Set(allowedTools);
  const commandAllowlist = new Set(allowedCommands);
  const forbiddenAbsent = calls.every((call) => allowed.has(call.tool));
  const pathsConfined = Boolean(sandboxRoot) && calls.every((call) =>
    argumentsStayConfined(call.arguments, sandboxRoot, '', commandAllowlist)
  );
  const common = {
    record_count: records.length,
    tool_counts: sortedToolCounts,
    required_tools_present: requiredPresent,
    forbidden_tools_absent: forbiddenAbsent,
    paths_confined: pathsConfined
  };
  if (invalidArguments || !sandboxRoot) {
    return { status: 'NOT_RUN', reason: 'raw_provider_audit_invalid', ...common };
  }
  if (!pathsConfined) {
    return { status: 'FAIL', reason: 'raw_provider_path_escape', ...common };
  }
  if (!forbiddenAbsent) {
    return { status: 'FAIL', reason: 'raw_provider_tool_forbidden', ...common };
  }
  if (calls.length === 0 || !requiredPresent) {
    return { status: 'NOT_RUN', reason: 'raw_provider_audit_missing', ...common };
  }
  return { status: 'PASS', reason: 'raw_provider_audit_verified', ...common };
}

function walkRecord(value, visit, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  visit(value);
  for (const child of Object.values(value)) {
    if (Array.isArray(child)) {
      for (const item of child) walkRecord(item, visit, seen);
    } else {
      walkRecord(child, visit, seen);
    }
  }
}

function argumentsStayConfined(value, sandboxRoot, key = '', allowedCommands = new Set()) {
  if (Array.isArray(value)) {
    return value.every((item) => argumentsStayConfined(item, sandboxRoot, key, allowedCommands));
  }
  if (value && typeof value === 'object') {
    return Object.entries(value).every(([childKey, child]) =>
      argumentsStayConfined(child, sandboxRoot, childKey, allowedCommands)
    );
  }
  if (/^command$/i.test(key)) {
    return commandValueStaysConfined(value, sandboxRoot, allowedCommands);
  }
  if (typeof value !== 'string') return true;
  const pathLikeKey = /^(?:cwd|path|file|filename|directory|dir|root|source)$/i.test(key);
  const candidates = new Set(embeddedAbsolutePaths(value));
  if (pathLikeKey) candidates.add(value);
  if (candidates.size === 0) return true;
  return [...candidates].every((candidate) => pathValueStaysConfined(candidate, sandboxRoot));
}

function commandValueStaysConfined(value, sandboxRoot, allowedCommands) {
  if (typeof value !== 'string' || !allowedCommands.has(value)) return false;
  if (/[\r\n;&|<>`$]/.test(value)) return false;
  const tokens = value.trim().split(/\s+/).filter(Boolean);
  if (!/^(?:node|node\.exe)$/i.test(tokens[0] ?? '')) return false;
  return tokens.slice(1).every((rawToken) => {
    const token = rawToken.replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, '$1$2');
    if (!token || token.startsWith('-')) return true;
    if (/(?:^|[\\/])\.\.(?:[\\/]|$)/.test(token)) return false;
    if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(token) && !path.win32.isAbsolute(token)) return false;
    if (!/[\\/]/.test(token) && !/\.[A-Za-z0-9]+$/.test(token)) return true;
    return pathValueStaysConfined(token, sandboxRoot);
  });
}

function embeddedAbsolutePaths(value) {
  const matches = [];
  for (const match of value.matchAll(/[A-Za-z]:[\\/][^\s"'`;,\])}]+/g)) {
    matches.push(match[0]);
  }
  for (const match of value.matchAll(/(?:^|[\s"'`=(:,])((?:\/(?!\/)[^\s"'`;,\])}]+)+)/g)) {
    matches.push(match[1]);
  }
  return matches;
}

function pathValueStaysConfined(value, sandboxRoot) {
  let pathApi = path;
  if (path.win32.isAbsolute(value)) {
    if (!path.win32.isAbsolute(sandboxRoot)) return false;
    pathApi = path.win32;
  } else if (path.posix.isAbsolute(value)) {
    if (!path.posix.isAbsolute(sandboxRoot)) return false;
    pathApi = path.posix;
  }
  const target = pathApi.isAbsolute(value)
    ? pathApi.resolve(value)
    : pathApi.resolve(sandboxRoot, value);
  const relative = pathApi.relative(pathApi.resolve(sandboxRoot), target);
  return !relative.startsWith('..') && !pathApi.isAbsolute(relative);
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
