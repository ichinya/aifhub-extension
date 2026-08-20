// Correctness-first evaluator for the dedicated Understand Anything paired matrix.
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import {
  UNDERSTAND_ANYTHING_MATRIX_SCHEMA,
  UNDERSTAND_ANYTHING_PINNED_PROFILE,
  UNDERSTAND_ANYTHING_SCENARIOS,
  UNDERSTAND_ANYTHING_VARIANTS,
  containsCredentialLikeMaterial
} from './understand-anything-ai-tester-matrix.mjs';
import { REVIEWED_OUTPUT_CONTEXT_SCHEMA } from './understand-anything-reviewed-output-adapter.mjs';

export const UNDERSTAND_ANYTHING_RESULTS_SCHEMA = 'aifhub.understand_anything.ai_tester_results.v1';
export const UNDERSTAND_ANYTHING_PAIR_DECISIONS = Object.freeze(['recommend', 'conditional', 'avoid', 'forbid']);
export const UNDERSTAND_ANYTHING_PROVIDER_POLICIES = Object.freeze(['reject_defer', 'manual_quality_experiment_only']);

const LOG_LEVELS = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40, silent: 100 });

export async function collectUnderstandAnythingTraceIndex({ runsDir } = {}) {
  if (!runsDir) throw new Error('runsDir is required');
  const resolvedRuns = path.resolve(runsDir);
  const byScenario = new Map();
  let filesRead = 0;
  let filesSkipped = 0;
  let directories = [];
  try {
    directories = await readdir(resolvedRuns, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { files_read: 0, files_skipped: 0, duplicate_scenarios: [], latest_by_scenario: {} };
    }
    throw error;
  }
  for (const directory of directories) {
    if (!directory.isDirectory()) continue;
    const directoryPath = path.join(resolvedRuns, directory.name);
    const names = await readdir(directoryPath).catch(() => []);
    for (const name of names.filter((item) => item.endsWith('.json'))) {
      try {
        const record = JSON.parse(await readFile(path.join(directoryPath, name), 'utf8'));
        const trace = normalizeUnderstandAnythingTraceRecord(record);
        if (!trace.scenario_name) {
          filesSkipped += 1;
          continue;
        }
        const list = byScenario.get(trace.scenario_name) ?? [];
        list.push(trace);
        byScenario.set(trace.scenario_name, list);
        filesRead += 1;
      } catch {
        filesSkipped += 1;
      }
    }
  }
  const duplicateScenarios = [...byScenario.entries()]
    .filter(([, records]) => records.length !== 1)
    .map(([scenario]) => scenario)
    .sort();
  return {
    files_read: filesRead,
    files_skipped: filesSkipped,
    duplicate_scenarios: duplicateScenarios,
    latest_by_scenario: Object.fromEntries([...byScenario.entries()].map(([scenario, records]) => [
      scenario,
      [...records].sort((left, right) => String(right.finished_at).localeCompare(String(left.finished_at)))[0]
    ]))
  };
}

export function normalizeUnderstandAnythingTraceRecord(record = {}) {
  const inputTokens = number(record.cost?.inputTokens);
  const outputTokens = number(record.cost?.outputTokens);
  const cacheCreationTokens = number(record.cost?.cacheCreationTokens);
  const cacheReadTokens = number(record.cost?.cacheReadTokens);
  const finalOutput = String(record.finalOutput ?? '');
  const privacyAudit = auditUnderstandAnythingTrace(record);
  const contextFileAccessed = traceToolCalls(record).some((toolCall) => {
    const input = stableText(toolCall?.input);
    const resultContent = String(toolCall?.resultContent ?? '');
    const fingerprintEvidence = /sha256:[0-9a-f]{64}/.test(resultContent);
    const rawContextPayloadEvidence = resultContent.includes(REVIEWED_OUTPUT_CONTEXT_SCHEMA);
    // Raw payload proves access for correctness, while the privacy audit rejects retaining it.
    return input.includes('reviewed-graph-context.json')
      && (fingerprintEvidence || rawContextPayloadEvidence);
  });
  return {
    scenario_name: String(record.scenario?.name ?? ''),
    runtime: String(record.runner?.runtime ?? ''),
    model: String(record.runner?.model ?? ''),
    reasoning: String(record.runner?.reasoning ?? ''),
    finished_at: record.runner?.finishedAt ?? null,
    ai_tester_pass: record.scoring?.overallPass === true,
    assertions_pass: asArray(record.assertions).length > 0
      && asArray(record.assertions).every((assertion) => assertion?.pass === true),
    error_count: asArray(record.errors).length,
    query: {
      duration_ms: number(record.runner?.durationMs),
      turns: number(record.runner?.turnsUsed),
      tool_calls: number(record.toolCallSummary?.total, countToolCalls(record)),
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_creation_tokens: cacheCreationTokens,
      cache_read_tokens: cacheReadTokens,
      total_tokens: inputTokens + outputTokens + cacheCreationTokens + cacheReadTokens,
      output_bytes: Buffer.byteLength(finalOutput, 'utf8')
    },
    final_output: finalOutput,
    final_output_sha256: sha256(finalOutput),
    context_file_accessed: contextFileAccessed,
    trace_privacy: privacyAudit
  };
}

export function buildUnderstandAnythingResultsReport({
  matrix,
  traceIndex,
  generatedAt = new Date().toISOString(),
  lifecycle = {
    status: 'NOT_RUN', reason_code: 'lifecycle_unavailable', purge_status: 'NOT_RUN'
  }
} = {}) {
  validateMatrixIdentity(matrix);
  if (asArray(traceIndex?.duplicate_scenarios).length > 0) {
    throw new Error(`duplicate or stale traces detected for ${traceIndex.duplicate_scenarios.length} scenarios`);
  }
  const latest = traceIndex?.latest_by_scenario ?? {};
  const rows = matrix.cases.map((matrixCase) => evaluateCase({
    matrix,
    matrixCase,
    trace: latest[matrixCase.id] ?? null
  }));
  const pairs = buildPairResults(rows);
  const expectedPairs = UNDERSTAND_ANYTHING_SCENARIOS.length * UNDERSTAND_ANYTHING_PINNED_PROFILE.repetitions;
  const expectedRows = expectedPairs * UNDERSTAND_ANYTHING_VARIANTS.length;
  const evidenceComplete = rows.length === expectedRows
    && rows.every((row) => row.trace_status === 'PASS')
    && pairs.length === expectedPairs
    && pairs.every((pair) => pair.complete);
  const privacyPass = rows.every((row) => row.privacy_pass);
  const correctnessPass = rows.every((row) => row.correctness_pass);
  const providerPolicy = evaluateUnderstandAnythingProviderPolicy({
    provenance: { class: matrix.provenance_class, valid: true },
    lifecycle_status: lifecycle.status,
    purge_status: lifecycle.purge_status,
    privacy_status: privacyPass ? 'PASS' : 'FAIL',
    evidence_complete: evidenceComplete,
    pairs
  });
  const report = {
    schema: UNDERSTAND_ANYTHING_RESULTS_SCHEMA,
    generated_at: generatedAt,
    matrix_run_id: matrix.run_id,
    runtime: matrix.runtime,
    model: matrix.model,
    reasoning: matrix.reasoning,
    repetitions: matrix.repetitions,
    provenance_class: matrix.provenance_class,
    no_promote: true,
    evidence_complete: evidenceComplete,
    correctness_pass: correctnessPass,
    privacy_pass: privacyPass,
    lifecycle: {
      status: lifecycle.status,
      reason_code: lifecycle.reason_code,
      purge_status: lifecycle.purge_status
    },
    generation_cost: {
      status: lifecycle.status === 'PASS' ? 'RECORDED_SEPARATELY' : 'NOT_RUN',
      reason_code: lifecycle.status === 'PASS' ? null : lifecycle.reason_code
    },
    summary: {
      expected_rows: matrix.cases.length,
      executed_rows: rows.filter((row) => row.trace_status !== 'NOT_RUN').length,
      pass_rows: rows.filter((row) => row.trace_status === 'PASS').length,
      fail_rows: rows.filter((row) => row.trace_status === 'FAIL').length,
      not_run_rows: rows.filter((row) => row.trace_status === 'NOT_RUN').length,
      stale_rows: rows.filter((row) => row.trace_status === 'STALE').length,
      settings_mismatch_rows: rows.filter((row) => row.trace_status === 'SETTINGS_MISMATCH').length,
      pairs: pairs.length,
      complete_pairs: pairs.filter((pair) => pair.complete).length,
      decisions: countBy(pairs, 'decision'),
      baseline_query: aggregateQuery(rows.filter((row) => row.variant === 'baseline_rg')),
      candidate_query: aggregateQuery(rows.filter((row) => row.variant === 'candidate_reviewed_graph'))
    },
    rows,
    pairs,
    provider_policy: providerPolicy,
    trace_files_read: number(traceIndex?.files_read),
    trace_files_skipped: number(traceIndex?.files_skipped),
    limitations: [
      'Synthetic reviewed-output evidence validates only the adapter/context contract and cannot promote provider policy.',
      'Two repetitions per variant are a bounded behavioral signal, not statistical proof.',
      'Provider generation cost is not amortized because the provider lifecycle was not executed.'
    ]
  };
  log('info', 'report.complete', {
    run_id: report.matrix_run_id,
    pass_rows: report.summary.pass_rows,
    pairs: report.summary.pairs,
    decision: report.provider_policy.decision
  });
  return report;
}

export function evaluateUnderstandAnythingProviderPolicy({
  provenance = {},
  lifecycle_status = 'NOT_RUN',
  purge_status = 'NOT_RUN',
  privacy_status = 'NOT_RUN',
  evidence_complete = false,
  pairs = []
} = {}) {
  const reasons = [];
  if (provenance.class !== 'provider_generated') reasons.push('synthetic_evidence_non_promotable');
  if (provenance.valid !== true) reasons.push('provider_provenance_invalid');
  if (lifecycle_status !== 'PASS') reasons.push('provider_lifecycle_not_pass');
  if (purge_status !== 'PASS') reasons.push('provider_purge_not_pass');
  if (privacy_status !== 'PASS') reasons.push('privacy_not_pass');
  if (evidence_complete !== true) reasons.push('paired_evidence_incomplete');
  if (pairs.some((pair) => !['recommend', 'conditional'].includes(pair.decision))) {
    reasons.push('non_positive_pair_decision');
  }
  if (pairs.filter((pair) => pair.decision === 'recommend').length < 2) {
    reasons.push('material_benefit_not_proven');
  }
  return {
    decision: reasons.length === 0 ? 'manual_quality_experiment_only' : 'reject_defer',
    reason_codes: [...new Set(reasons)]
  };
}

export function renderUnderstandAnythingResultsMarkdown(report = {}) {
  const lines = [
    '# Understand Anything ai-tester Aggregate',
    '',
    `- Run: \`${md(report.matrix_run_id)}\``,
    `- Profile: \`${md(report.runtime)}\` / \`${md(report.model)}\` / \`${md(report.reasoning)}\``,
    `- Provenance: \`${md(report.provenance_class)}\``,
    `- Evidence complete: \`${report.evidence_complete === true}\``,
    `- Provider policy: \`${md(report.provider_policy?.decision)}\``,
    '',
    '| Pair | Rep | Decision | Correctness | Privacy | Baseline ms/tokens | Candidate ms/tokens |',
    '|---|---:|---|---|---|---:|---:|'
  ];
  for (const pair of asArray(report.pairs)) {
    lines.push(`| ${md(pair.scenario_id)} | ${pair.repetition} | ${md(pair.decision)} | ${pair.correctness_pass ? 'PASS' : 'FAIL'} | ${pair.privacy_pass ? 'PASS' : 'FAIL'} | ${pair.baseline.query.duration_ms}/${pair.baseline.query.total_tokens} | ${pair.candidate.query.duration_ms}/${pair.candidate.query.total_tokens} |`);
  }
  lines.push('', 'Raw graph data, source text and model transcripts are intentionally excluded.', '');
  return lines.join('\n');
}

export async function writeUnderstandAnythingResults({
  matrixPath,
  runsDir,
  outDir,
  jsonFile = 'understand-anything-ai-tester-results.json',
  markdownFile = 'understand-anything-ai-tester-results.md',
  lifecycle
} = {}) {
  if (!matrixPath || !runsDir || !outDir) throw new Error('matrixPath, runsDir and outDir are required');
  const matrix = JSON.parse(await readFile(path.resolve(matrixPath), 'utf8'));
  const traceIndex = await collectUnderstandAnythingTraceIndex({ runsDir });
  const report = buildUnderstandAnythingResultsReport({ matrix, traceIndex, lifecycle });
  const resolvedOut = path.resolve(outDir);
  await mkdir(resolvedOut, { recursive: true });
  await writeFile(path.join(resolvedOut, jsonFile), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await writeFile(path.join(resolvedOut, markdownFile), renderUnderstandAnythingResultsMarkdown(report), 'utf8');
  return report;
}

function evaluateCase({ matrix, matrixCase, trace }) {
  const base = {
    id: matrixCase.id,
    run_id: matrixCase.run_id,
    pair_id: matrixCase.pair_id,
    scenario_id: matrixCase.scenario_id,
    repetition: matrixCase.repetition,
    variant: matrixCase.variant,
    settings_fingerprint: matrixCase.settings_fingerprint,
    provenance_class: matrixCase.provenance_class,
    context_fingerprint: matrixCase.context_fingerprint ?? null,
    expected_context_fingerprint: matrixCase.expected_context_fingerprint ?? null,
    required_files: [...matrixCase.required_files],
    required_edges: [...matrixCase.required_edges]
  };
  if (!trace) {
    return {
      ...base,
      trace_status: 'NOT_RUN',
      reason_codes: ['missing_trace'],
      correctness_pass: false,
      privacy_pass: false,
      query: emptyQuery(),
      output_fingerprint: null
    };
  }
  const reasons = [];
  if (trace.runtime !== matrixCase.runtime || trace.model !== matrixCase.model || trace.reasoning !== matrixCase.reasoning) {
    reasons.push('settings_mismatch');
  }
  if (trace.finished_at && Date.parse(trace.finished_at) < Date.parse(matrix.generated_at)) reasons.push('stale_trace');
  if (!trace.ai_tester_pass || !trace.assertions_pass || trace.error_count > 0) reasons.push('ai_tester_assertion_failed');
  const output = trace.final_output;
  const missingFiles = matrixCase.required_files.filter((item) => !output.includes(item));
  const missingEdges = matrixCase.required_edges.filter((item) => !output.includes(item));
  const unsupportedClaims = matrixCase.forbidden_claims.filter((item) => includesFold(output, item));
  const exposedCanaries = matrixCase.privacy_canaries.filter((item) => output.includes(item));
  const pathLeak = /(?:[A-Za-z]:\\Users\\|\/Users\/|\/home\/[^/]+\/|AppData[\\/](?:Local|Roaming)[\\/])/i.test(output);
  const expectedContextFingerprint = String(matrixCase.expected_context_fingerprint ?? '');
  const contextMarkerMatches = output.includes(`supporting_context_fingerprint=${expectedContextFingerprint}`);
  const candidateContextProven = matrixCase.variant !== 'candidate_reviewed_graph'
    || (trace.context_file_accessed === true
      && /^sha256:[0-9a-f]{64}$/.test(expectedContextFingerprint)
      && contextMarkerMatches);
  const baselineContextBounded = matrixCase.variant !== 'baseline_rg'
    || (trace.context_file_accessed !== true
      && expectedContextFingerprint === 'none'
      && contextMarkerMatches);
  const correctnessPass = missingFiles.length === 0
    && missingEdges.length === 0
    && unsupportedClaims.length === 0
    && candidateContextProven
    && baselineContextBounded;
  const tracePrivacyPass = trace.trace_privacy?.pass === true;
  const privacyPass = exposedCanaries.length === 0 && !pathLeak && tracePrivacyPass;
  if (!candidateContextProven) reasons.push('candidate_context_not_proven');
  if (!baselineContextBounded) reasons.push('baseline_context_boundary_failed');
  for (const reasonCode of asArray(trace.trace_privacy?.reason_codes)) reasons.push(reasonCode);
  if (!correctnessPass) reasons.push('correctness_failed');
  if (!privacyPass) reasons.push('privacy_failed');
  let traceStatus = reasons.length === 0 ? 'PASS' : 'FAIL';
  if (reasons.includes('settings_mismatch')) traceStatus = 'SETTINGS_MISMATCH';
  else if (reasons.includes('stale_trace')) traceStatus = 'STALE';
  return {
    ...base,
    trace_status: traceStatus,
    reason_codes: reasons,
    correctness_pass: correctnessPass,
    privacy_pass: privacyPass,
    missing_file_ids: missingFiles,
    missing_edge_ids: missingEdges,
    unsupported_claim_count: unsupportedClaims.length,
    exposed_canary_count: exposedCanaries.length,
    path_leak: pathLeak,
    context_file_accessed: trace.context_file_accessed === true,
    context_evidence_pass: candidateContextProven && baselineContextBounded,
    trace_privacy: { ...trace.trace_privacy },
    correctness_score: matrixCase.required_files.length + matrixCase.required_edges.length
      - missingFiles.length - missingEdges.length - unsupportedClaims.length,
    query: { ...trace.query },
    output_fingerprint: trace.final_output_sha256
  };
}

function buildPairResults(rows) {
  const grouped = new Map();
  for (const row of rows) {
    const group = grouped.get(row.pair_id) ?? [];
    group.push(row);
    grouped.set(row.pair_id, group);
  }
  return [...grouped.entries()].map(([pairId, pairRows]) => {
    const baseline = pairRows.find((row) => row.variant === 'baseline_rg');
    const candidate = pairRows.find((row) => row.variant === 'candidate_reviewed_graph');
    const complete = pairRows.length === 2 && baseline?.trace_status === 'PASS' && candidate?.trace_status === 'PASS';
    const reasons = [];
    let decision = 'conditional';
    if (!complete) {
      reasons.push('pair_incomplete');
      const candidateCorrectnessFailed = Boolean(candidate) && candidate.correctness_pass !== true;
      const candidatePrivacyFailed = Boolean(candidate) && candidate.privacy_pass !== true;
      if (candidateCorrectnessFailed) reasons.push('candidate_correctness_failed');
      if (candidatePrivacyFailed) reasons.push('candidate_privacy_failed');
      decision = candidateCorrectnessFailed || candidatePrivacyFailed ? 'forbid' : 'avoid';
    } else if (candidate.correctness_score < baseline.correctness_score) {
      decision = 'avoid';
      reasons.push('candidate_correctness_regression');
    } else if (candidate.correctness_score > baseline.correctness_score) {
      decision = 'recommend';
      reasons.push('material_correctness_benefit');
    } else {
      decision = 'conditional';
      reasons.push('correctness_parity_only');
    }
    return {
      pair_id: pairId,
      run_id: baseline?.run_id ?? candidate?.run_id ?? null,
      scenario_id: baseline?.scenario_id ?? candidate?.scenario_id ?? null,
      repetition: baseline?.repetition ?? candidate?.repetition ?? null,
      settings_fingerprint: baseline?.settings_fingerprint ?? candidate?.settings_fingerprint ?? null,
      complete,
      correctness_pass: baseline?.correctness_pass === true && candidate?.correctness_pass === true,
      privacy_pass: baseline?.privacy_pass === true && candidate?.privacy_pass === true,
      decision,
      reason_codes: [...new Set(reasons)],
      baseline: publicRow(baseline),
      candidate: publicRow(candidate)
    };
  });
}

function validateMatrixIdentity(matrix) {
  if (matrix?.schema !== UNDERSTAND_ANYTHING_MATRIX_SCHEMA) {
    throw new Error(`matrix schema must be ${UNDERSTAND_ANYTHING_MATRIX_SCHEMA}`);
  }
  if (matrix.runtime !== UNDERSTAND_ANYTHING_PINNED_PROFILE.runtime
    || matrix.model !== UNDERSTAND_ANYTHING_PINNED_PROFILE.model
    || matrix.reasoning !== UNDERSTAND_ANYTHING_PINNED_PROFILE.reasoning) {
    throw new Error(`matrix profile must be ${UNDERSTAND_ANYTHING_PINNED_PROFILE.runtime}/${UNDERSTAND_ANYTHING_PINNED_PROFILE.model}/${UNDERSTAND_ANYTHING_PINNED_PROFILE.reasoning}`);
  }
  if (matrix.repetitions !== UNDERSTAND_ANYTHING_PINNED_PROFILE.repetitions || matrix.no_promote !== true) {
    throw new Error('matrix repetitions/no-promote mismatch');
  }
  const ids = matrix.cases.map((item) => item.id);
  if (new Set(ids).size !== ids.length) throw new Error('duplicate matrix case ids');
  const pairs = new Map();
  for (const matrixCase of matrix.cases) {
    const list = pairs.get(matrixCase.pair_id) ?? [];
    list.push(matrixCase);
    pairs.set(matrixCase.pair_id, list);
  }
  for (const [pairId, pair] of pairs) {
    if (pair.length !== 2 || !sameOrderedValues(pair.map((item) => item.variant), UNDERSTAND_ANYTHING_VARIANTS)) {
      throw new Error(`asymmetric variants for pair ${pairId}`);
    }
    if (new Set(pair.map((item) => item.settings_fingerprint)).size !== 1
      || new Set(pair.map((item) => item.run_id)).size !== 1) {
      throw new Error(`asymmetric settings for pair ${pairId}`);
    }
    const baseline = pair.find((item) => item.variant === 'baseline_rg');
    const candidate = pair.find((item) => item.variant === 'candidate_reviewed_graph');
    if (baseline?.expected_context_fingerprint !== 'none'
      || !/^sha256:[0-9a-f]{64}$/.test(String(candidate?.expected_context_fingerprint ?? ''))) {
      throw new Error(`context evidence contract missing for pair ${pairId}`);
    }
  }
}

function publicRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    trace_status: row.trace_status,
    correctness_pass: row.correctness_pass,
    privacy_pass: row.privacy_pass,
    correctness_score: row.correctness_score ?? 0,
    reason_codes: [...row.reason_codes],
    context_evidence_pass: row.context_evidence_pass,
    trace_privacy: { ...row.trace_privacy },
    query: { ...row.query },
    output_fingerprint: row.output_fingerprint
  };
}

function aggregateQuery(rows) {
  const complete = rows.filter((row) => !['NOT_RUN', 'STALE', 'SETTINGS_MISMATCH'].includes(row.trace_status));
  return {
    rows: complete.length,
    duration_ms_total: sum(complete.map((row) => row.query.duration_ms)),
    duration_ms_average: average(complete.map((row) => row.query.duration_ms)),
    total_tokens: sum(complete.map((row) => row.query.total_tokens)),
    total_tokens_average: average(complete.map((row) => row.query.total_tokens)),
    turns_total: sum(complete.map((row) => row.query.turns)),
    tool_calls_total: sum(complete.map((row) => row.query.tool_calls)),
    output_bytes_total: sum(complete.map((row) => row.query.output_bytes))
  };
}

function emptyQuery() {
  return { duration_ms: 0, turns: 0, tool_calls: 0, input_tokens: 0, output_tokens: 0,
    cache_creation_tokens: 0, cache_read_tokens: 0, total_tokens: 0, output_bytes: 0 };
}

function countToolCalls(record) {
  return asArray(record.turns).reduce((total, turn) => total + asArray(turn?.toolCalls).length, 0);
}

function auditUnderstandAnythingTrace(record) {
  const strings = [];
  collectStrings(record, strings);
  const toolCalls = traceToolCalls(record);
  const resultContents = toolCalls.map((toolCall) => String(toolCall?.resultContent ?? ''));
  const pathLeak = strings.some((value) => /(?:\\\\\?\\)?[A-Za-z]:\\|\/Users\/[^/]+\/|\/home\/[^/]+\/|\/tmp\/ai-tester-/i.test(value));
  const secretLeak = containsCredentialLikeMaterial(record);
  const rawContextPayload = resultContents.some((value) => value.includes(REVIEWED_OUTPUT_CONTEXT_SCHEMA));
  const rawInstructionBody = resultContents.some((value) => /<SUBAGENT-STOP>|^---\s*\r?\nname:\s*using-superpowers/m.test(value));
  const reasonCodes = [];
  if (pathLeak) reasonCodes.push('raw_trace_path_leak');
  if (secretLeak) reasonCodes.push('raw_trace_secret_leak');
  if (rawContextPayload) reasonCodes.push('raw_context_payload_retained');
  if (rawInstructionBody) reasonCodes.push('raw_instruction_body_retained');
  if (reasonCodes.length > 0) {
    log('warn', '[FIX:129] trace.privacy.failed', {
      scenario: String(record?.scenario?.name ?? ''),
      reason_codes: reasonCodes,
      issue_count: reasonCodes.length
    });
  }
  return {
    pass: reasonCodes.length === 0,
    path_leak: pathLeak,
    secret_leak: secretLeak,
    raw_context_payload: rawContextPayload,
    raw_instruction_body: rawInstructionBody,
    issue_count: reasonCodes.length,
    reason_codes: reasonCodes
  };
}

function traceToolCalls(record) {
  return asArray(record?.turns).flatMap((turn) => asArray(turn?.toolCalls));
}

function collectStrings(value, output) {
  if (typeof value === 'string') {
    output.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectStrings(entry, output);
    return;
  }
  if (value && typeof value === 'object') {
    for (const entry of Object.values(value)) collectStrings(entry, output);
  }
}

function stableText(value) {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value ?? '');
  } catch {
    return '';
  }
}

function countBy(values, field) {
  const result = {};
  for (const value of values) result[value[field]] = (result[value[field]] ?? 0) + 1;
  return result;
}

function includesFold(haystack, needle) {
  return String(haystack).toLocaleLowerCase('en-US').includes(String(needle).toLocaleLowerCase('en-US'));
}

function number(...values) {
  for (const value of values) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function sum(values) {
  return values.reduce((total, value) => total + number(value), 0);
}

function average(values) {
  return values.length === 0 ? 0 : Math.round((sum(values) / values.length) * 1000) / 1000;
}

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function md(value) {
  return String(value ?? '').replaceAll('|', '\\|').replaceAll('`', '\\`');
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function sameOrderedValues(actual, expected) {
  return Array.isArray(actual) && actual.length === expected.length
    && actual.every((value, index) => value === expected[index]);
}

function log(level, event, details = {}) {
  const configured = String(process.env.AIF_UNDERSTAND_ANYTHING_LOG_LEVEL ?? process.env.LOG_LEVEL ?? 'warn').toLowerCase();
  const threshold = LOG_LEVELS[configured] ?? LOG_LEVELS.warn;
  if ((LOG_LEVELS[level] ?? LOG_LEVELS.info) < threshold) return;
  process.stderr.write(`${JSON.stringify({ component: 'understand-anything-results', level, event, ...details })}\n`);
}

function parseCliArgs(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === '--matrix') parsed.matrixPath = args[++index];
    else if (token === '--runs-dir') parsed.runsDir = args[++index];
    else if (token === '--out') parsed.outDir = args[++index];
    else if (token === '--json-file') parsed.jsonFile = args[++index];
    else if (token === '--markdown-file') parsed.markdownFile = args[++index];
    else if (token === '--json') parsed.json = true;
    else if (token === '--help' || token === '-h') parsed.help = true;
    else throw new Error(`Unknown argument: ${token}`);
  }
  return parsed;
}

async function main() {
  const parsed = parseCliArgs(process.argv.slice(2));
  if (parsed.help) {
    process.stdout.write('Usage: node scripts/understand-anything-ai-tester-results-report.mjs --matrix <file> --runs-dir <dir> --out <dir> [--json]\n');
    return;
  }
  const report = await writeUnderstandAnythingResults(parsed);
  const result = {
    schema: report.schema,
    run_id: report.matrix_run_id,
    executed_rows: report.summary.executed_rows,
    complete_pairs: report.summary.complete_pairs,
    provider_policy: report.provider_policy.decision
  };
  process.stdout.write(parsed.json ? `${JSON.stringify(result, null, 2)}\n` : `${result.provider_policy}: ${result.executed_rows}/${report.summary.expected_rows} rows.\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    log('error', 'report.failed', { message: error instanceof Error ? error.message : String(error) });
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
