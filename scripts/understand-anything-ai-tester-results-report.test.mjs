import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildUnderstandAnythingMatrix } from './understand-anything-ai-tester-matrix.mjs';
import {
  buildUnderstandAnythingResultsReport,
  evaluateUnderstandAnythingProviderPolicy,
  normalizeUnderstandAnythingTraceRecord
} from './understand-anything-ai-tester-results-report.mjs';

function catalog() {
  return {
    schema: 'aifhub.understand_anything.ai_tester_scenario_catalog.v1',
    defaults: {
      runtime: 'codex', model: 'gpt-5.6-luna', reasoning: 'low', repetitions: 2,
      variants: ['baseline_rg', 'candidate_reviewed_graph'], timeout_seconds: 240,
      max_turns: 10, assertion_schema: 'aifhub.understand_anything.assertions.v1',
      provenance_class: 'synthetic_schema_fixture', no_promote: true
    },
    fixtures_root: 'fixtures',
    scenarios: ['architecture_onboarding', 'change_impact', 'workspace_imports', 'incremental_new_import'].map((id) => ({
      id, fixture_id: `${id}-fixture`, fixture_revision: `${id}-r2`,
      project_path: `projects/${id}`, compact_context_path: `contexts/${id}.json`,
      task: `Task ${id}`, required_files: [`src/${id}.ts`],
      required_edges: [`src/${id}.ts->src/core.ts`], forbidden_claims: ['invented-service'],
      privacy_canaries: ['UA_PRIVATE_CANARY']
    }))
  };
}

function matrix() {
  const value = buildUnderstandAnythingMatrix({
    catalog: catalog(), runId: 'ua-luna-low-20260722-r1', generatedAt: '2026-07-22T00:00:00.000Z'
  });
  for (const matrixCase of value.cases) {
    matrixCase.expected_context_fingerprint = matrixCase.variant === 'candidate_reviewed_graph'
      ? `sha256:${matrixCase.settings_fingerprint.slice(-64)}`
      : 'none';
  }
  return value;
}

function trace(matrixCase, {
  omitEdge = false,
  canary = false,
  durationMs = 1000,
  tokens = 100,
  contextFingerprint = matrixCase.expected_context_fingerprint,
  contextAccess = matrixCase.variant === 'candidate_reviewed_graph',
  contextCheck = false,
  rawPathLeak = false,
  rawContextPayload = false
} = {}) {
  const output = [
    ...matrixCase.required_files,
    ...(omitEdge ? [] : matrixCase.required_edges),
    ...(canary ? matrixCase.privacy_canaries : []),
    `supporting_context_fingerprint=${contextFingerprint}`,
    'evaluation_complete'
  ].join('\n');
  const toolCalls = [{
    name: 'Bash',
    input: { command: rawPathLeak ? 'Get-Content C:\\Users\\Example\\secret.txt' : 'rg -n . project/src' },
    resultContent: 'bounded repository evidence'
  }];
  if (contextAccess) {
    toolCalls.push({
      name: 'Bash',
      input: { command: 'Get-Content project/.evaluation/reviewed-graph-context.json' },
      resultContent: rawContextPayload
        ? '{"schema":"aifhub.understand_anything.reviewed_output_context.v1"}'
        : `graph fingerprint ${matrixCase.expected_context_fingerprint}`
    });
  }
  if (contextCheck) {
    toolCalls.push({
      name: 'Bash',
      input: { command: 'Test-Path project/.evaluation/reviewed-graph-context.json' },
      resultContent: 'False'
    });
  }
  return normalizeUnderstandAnythingTraceRecord({
    scenario: { name: matrixCase.id },
    runner: {
      runtime: matrixCase.runtime, model: matrixCase.model, reasoning: matrixCase.reasoning,
      durationMs, turnsUsed: 1, finishedAt: '2026-07-22T00:01:00.000Z'
    },
    scoring: { overallPass: true },
    assertions: [{ id: 'stay-in-sandbox', pass: true }],
    cost: { inputTokens: tokens, outputTokens: 10, cacheCreationTokens: 0, cacheReadTokens: 0 },
    finalOutput: output,
    turns: [{ toolCalls }],
    toolCallSummary: { total: toolCalls.length },
    errors: []
  });
}

function traceIndex(value, overrides = new Map()) {
  return {
    files_read: value.cases.length,
    files_skipped: 0,
    duplicate_scenarios: [],
    latest_by_scenario: Object.fromEntries(value.cases.map((matrixCase) => [
      matrixCase.id,
      overrides.get(matrixCase.id) ?? trace(matrixCase)
    ]))
  };
}

describe('Understand Anything result normalization', () => {
  it('keeps exact profile and separates query cost fields', () => {
    const value = matrix().cases[0];
    const normalized = trace(value, { durationMs: 2500, tokens: 123 });
    assert.equal(normalized.runtime, 'codex');
    assert.equal(normalized.model, 'gpt-5.6-luna');
    assert.equal(normalized.reasoning, 'low');
    assert.equal(normalized.query.duration_ms, 2500);
    assert.equal(normalized.query.total_tokens, 133);
    assert.equal(normalized.final_output_sha256.length, 64);
  });
});

describe('Understand Anything correctness-first report', () => {
  it('accepts eight complete synthetic pairs but keeps policy reject_defer', () => {
    const value = matrix();
    const report = buildUnderstandAnythingResultsReport({ matrix: value, traceIndex: traceIndex(value) });
    assert.equal(report.summary.expected_rows, 16);
    assert.equal(report.summary.complete_pairs, 8);
    assert.equal(report.evidence_complete, true);
    assert.ok(report.pairs.every((pair) => pair.decision === 'conditional'));
    assert.deepEqual(new Set(report.pairs.map((pair) => pair.decision)), new Set(['conditional']));
    assert.equal(report.provider_policy.decision, 'reject_defer');
    assert.ok(report.provider_policy.reason_codes.includes('synthetic_evidence_non_promotable'));
  });

  it('allows baseline to confirm the optional context file is absent without treating it as context use', () => {
    const value = matrix();
    const baseline = value.cases.find((item) => item.variant === 'baseline_rg');
    const overrides = new Map([[baseline.id, trace(baseline, { contextCheck: true })]]);

    const report = buildUnderstandAnythingResultsReport({ matrix: value, traceIndex: traceIndex(value, overrides) });
    const row = report.rows.find((item) => item.id === baseline.id);

    assert.equal(row.correctness_pass, true);
    assert.equal(row.context_file_accessed, false);
  });

  it('rejects missing traces, duplicates and asymmetric pair settings', () => {
    const value = matrix();
    const missing = traceIndex(value);
    delete missing.latest_by_scenario[value.cases[0].id];
    const missingReport = buildUnderstandAnythingResultsReport({ matrix: value, traceIndex: missing });
    assert.equal(missingReport.evidence_complete, false);
    assert.equal(missingReport.summary.not_run_rows, 1);

    const duplicate = traceIndex(value);
    duplicate.duplicate_scenarios = [value.cases[0].id];
    assert.throws(
      () => buildUnderstandAnythingResultsReport({ matrix: value, traceIndex: duplicate }),
      /duplicate/i
    );

    value.cases[1].settings_fingerprint = '0'.repeat(64);
    assert.throws(
      () => buildUnderstandAnythingResultsReport({ matrix: value, traceIndex: traceIndex(value) }),
      /asymmetric/i
    );
  });

  it('forbids a candidate correctness/privacy failure even when it is faster', () => {
    const value = matrix();
    const candidate = value.cases.find((item) => item.variant === 'candidate_reviewed_graph');
    const overrides = new Map([[candidate.id, trace(candidate, {
      omitEdge: true, canary: true, durationMs: 1, tokens: 1
    })]]);
    const report = buildUnderstandAnythingResultsReport({ matrix: value, traceIndex: traceIndex(value, overrides) });
    const pair = report.pairs.find((item) => item.pair_id === candidate.pair_id);
    assert.equal(pair.decision, 'forbid');
    assert.ok(pair.reason_codes.includes('candidate_correctness_failed'));
    assert.ok(pair.reason_codes.includes('candidate_privacy_failed'));
    assert.equal(report.provider_policy.decision, 'reject_defer');
  });

  it('requires candidate context access and its hidden fingerprint while baseline stays context-free', () => {
    const value = matrix();
    const candidate = value.cases.find((item) => item.variant === 'candidate_reviewed_graph');
    const baseline = value.cases.find((item) => item.variant === 'baseline_rg');
    const overrides = new Map([
      [candidate.id, trace(candidate, { contextAccess: false })],
      [baseline.id, trace(baseline, { contextFingerprint: candidate.expected_context_fingerprint })]
    ]);

    const report = buildUnderstandAnythingResultsReport({ matrix: value, traceIndex: traceIndex(value, overrides) });
    const candidateRow = report.rows.find((item) => item.id === candidate.id);
    const baselineRow = report.rows.find((item) => item.id === baseline.id);

    assert.equal(candidateRow.correctness_pass, false);
    assert.ok(candidateRow.reason_codes.includes('candidate_context_not_proven'));
    assert.equal(baselineRow.correctness_pass, false);
    assert.ok(baselineRow.reason_codes.includes('baseline_context_boundary_failed'));
  });

  it('fails privacy on full-trace local paths and raw reviewed context payloads', () => {
    const value = matrix();
    const candidate = value.cases.find((item) => item.variant === 'candidate_reviewed_graph');
    const overrides = new Map([[candidate.id, trace(candidate, {
      rawPathLeak: true,
      rawContextPayload: true
    })]]);

    const report = buildUnderstandAnythingResultsReport({ matrix: value, traceIndex: traceIndex(value, overrides) });
    const row = report.rows.find((item) => item.id === candidate.id);

    assert.equal(row.privacy_pass, false);
    assert.ok(row.reason_codes.includes('raw_trace_path_leak'));
    assert.ok(row.reason_codes.includes('raw_context_payload_retained'));
    assert.equal(report.summary.candidate_query.rows, 8);
    assert.equal(JSON.stringify(report).includes('C:\\Users\\Example'), false);
    assert.equal(JSON.stringify(report).includes('reviewed_output_context.v1'), false);
  });
});

describe('Understand Anything provider policy', () => {
  it('requires provider_generated provenance, purge and at least two material benefits', () => {
    const pairs = [
      { decision: 'recommend' }, { decision: 'recommend' },
      { decision: 'conditional' }, { decision: 'conditional' }
    ];
    const positive = evaluateUnderstandAnythingProviderPolicy({
      provenance: { class: 'provider_generated', valid: true },
      lifecycle_status: 'PASS', purge_status: 'PASS', privacy_status: 'PASS',
      evidence_complete: true, pairs
    });
    assert.equal(positive.decision, 'manual_quality_experiment_only');

    const synthetic = evaluateUnderstandAnythingProviderPolicy({
      provenance: { class: 'synthetic_schema_fixture', valid: true },
      lifecycle_status: 'PASS', purge_status: 'PASS', privacy_status: 'PASS',
      evidence_complete: true, pairs
    });
    assert.equal(synthetic.decision, 'reject_defer');
  });
});
