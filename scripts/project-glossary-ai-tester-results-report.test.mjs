// project-glossary-ai-tester-results-report.test.mjs - paired trace evaluator contracts
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  buildProjectGlossaryMatrix,
  loadProjectGlossaryScenarioCatalog
} from './project-glossary-ai-tester-matrix.mjs';
import {
  buildProjectGlossaryResultsReport,
  collectProjectGlossaryTraceIndex,
  normalizeTraceRecord,
  renderProjectGlossaryResultsMarkdown,
  writeProjectGlossaryResults
} from './project-glossary-ai-tester-results-report.mjs';

let tempDir;
let matrix;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'project-glossary-ai-tester-results-'));
  const catalog = await loadProjectGlossaryScenarioCatalog({ cwd: process.cwd() });
  matrix = buildProjectGlossaryMatrix({
    catalog,
    runId: 'glossary-luna-low-report-test',
    generatedAt: '2026-07-21T12:00:00.000Z'
  });
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe('project glossary trace normalization', () => {
  it('extracts final output, runner settings, metrics, and a relative trace path', () => {
    const matrixCase = matrix.cases[0];
    const record = traceRecord(matrixCase, baselineOutput(matrixCase));
    const normalized = normalizeTraceRecord(record, {
      filePath: path.join(tempDir, 'runs', 'inline_case', 'trace.json'),
      runsDir: path.join(tempDir, 'runs'),
      directoryName: 'inline_case',
      fileName: 'trace.json'
    });
    assert.equal(normalized.scenario_name, matrixCase.id);
    assert.equal(normalized.model, 'gpt-5.6-luna');
    assert.equal(normalized.reasoning, 'low');
    assert.equal(normalized.scenario_path, '');
    assert.equal(normalized.total_tokens, 175);
    assert.equal(normalized.tool_calls, 2);
    assert.equal(normalized.trace_file, 'inline_case/trace.json');
    assert.equal(normalized.final_output, baselineOutput(matrixCase));
    assert.match(normalized.output_sha256, /^[a-f0-9]{64}$/);
  });
});

describe('project glossary paired evaluation', () => {
  it('allows a benefit claim only for complete safe improved pairs', async () => {
    const traceIndex = await writeCompleteTraceSet({ matrix, runsDir: path.join(tempDir, 'runs') });
    const report = buildProjectGlossaryResultsReport({ matrix, traceIndex });
    assert.equal(report.summary.expected_rows, 8);
    assert.equal(report.summary.executed_rows, 8);
    assert.equal(report.summary.complete_pairs, 4);
    assert.equal(report.evidence_complete, true);
    assert.equal(report.safety_pass, true);
    assert.equal(report.outcome, 'benefit_observed');
    assert.equal(report.benefit_claim_allowed, true);
    assert.ok(report.summary.candidate_terminology_score_average > report.summary.baseline_terminology_score_average);
    assert.ok(report.pairs.every((pair) => pair.decision === 'improved'));
  });

  it('rejects NOT_RUN, stale, and settings-mismatched rows as evidence', async () => {
    const runsDir = path.join(tempDir, 'runs');
    await writeCompleteTraceSet({ matrix, runsDir });
    await rm(path.join(runsDir, `inline_${matrix.cases[0].id}`), { recursive: true, force: true });
    const staleCase = matrix.cases[1];
    await writeTrace(runsDir, staleCase, candidateOutput(staleCase), { finishedAt: '2026-07-21T11:00:00.000Z' });
    const mismatchCase = matrix.cases[2];
    await writeTrace(runsDir, mismatchCase, baselineOutput(mismatchCase), { model: 'gpt-5.6-sol' });
    const traceIndex = await collectProjectGlossaryTraceIndex({ runsDir });
    const report = buildProjectGlossaryResultsReport({ matrix, traceIndex });
    assert.equal(report.evidence_complete, false);
    assert.equal(report.outcome, 'inconclusive');
    assert.equal(report.benefit_claim_allowed, false);
    assert.ok(report.rows.some((row) => row.trace_status === 'NOT_RUN'));
    assert.ok(report.rows.some((row) => row.trace_status === 'STALE'));
    assert.ok(report.rows.some((row) => row.trace_status === 'SETTINGS_MISMATCH'));
  });

  it('accepts ai-tester v2 traces that identify generated scenario files without embedding descriptions', async () => {
    const runsDir = path.join(tempDir, 'runs');
    for (const matrixCase of matrix.cases) {
      const output = matrixCase.condition === 'candidate_with_glossary'
        ? candidateOutput(matrixCase)
        : baselineOutput(matrixCase);
      await writeTrace(runsDir, matrixCase, output, {
        omitDescription: true,
        scenarioPath: path.resolve(tempDir, matrixCase.scenario_file)
      });
    }
    const traceIndex = await collectProjectGlossaryTraceIndex({ runsDir });
    const report = buildProjectGlossaryResultsReport({ matrix, traceIndex, matrixDir: tempDir });
    assert.equal(report.summary.settings_mismatch_rows, 0);
    assert.equal(report.evidence_complete, true);
    assert.equal(report.outcome, 'benefit_observed');
  });

  it('records identifier and authority regressions without a benefit claim', async () => {
    const runsDir = path.join(tempDir, 'runs');
    await writeCompleteTraceSet({ matrix, runsDir });
    const candidate = matrix.cases.find((item) => item.condition === 'candidate_with_glossary');
    await writeTrace(
      runsDir,
      candidate,
      'Dispatch Relay uses the Recovery Window. A new requirement says we must rename everything. evaluation_complete'
    );
    const traceIndex = await collectProjectGlossaryTraceIndex({ runsDir });
    const report = buildProjectGlossaryResultsReport({ matrix, traceIndex });
    const row = report.rows.find((item) => item.id === candidate.id);
    assert.equal(row.identifiers_preserved, false);
    assert.equal(row.authority_preserved, false);
    assert.equal(report.outcome, 'regressive');
    assert.equal(report.benefit_claim_allowed, false);
  });

  it('keeps final outputs, sentinel values, glossary body, and absolute paths out of durable reports', async () => {
    const runsDir = path.join(tempDir, 'runs');
    const outDir = path.join(tempDir, 'report');
    await writeCompleteTraceSet({ matrix, runsDir });
    await writeFile(path.join(tempDir, 'matrix.json'), `${JSON.stringify(matrix)}\n`, 'utf8');
    const report = await writeProjectGlossaryResults({
      matrixPath: path.join(tempDir, 'matrix.json'),
      runsDir,
      outDir
    });
    const json = await readFile(path.join(outDir, 'project-glossary-ai-tester-results.json'), 'utf8');
    const markdown = await readFile(path.join(outDir, 'project-glossary-ai-tester-results.md'), 'utf8');
    assert.equal(report.outcome, 'benefit_observed');
    assert.doesNotMatch(json, /GLOSSARY_SENTINEL_127|## Language|## Avoid|A new requirement/);
    assert.doesNotMatch(json, /[A-Za-z]:\\Users\\/);
    assert.doesNotMatch(markdown, /GLOSSARY_SENTINEL_127|## Language|## Avoid/);
    assert.match(markdown, /Candidate terminology score/);
    assert.match(markdown, /gpt-5\.6-luna/);
  });

  it('renders a concise metric and limitation report without model prose', async () => {
    const traceIndex = await writeCompleteTraceSet({ matrix, runsDir: path.join(tempDir, 'runs') });
    const report = buildProjectGlossaryResultsReport({ matrix, traceIndex });
    const markdown = renderProjectGlossaryResultsMarkdown(report);
    assert.match(markdown, /## Rows/);
    assert.match(markdown, /## Pairs/);
    assert.match(markdown, /## Limitations/);
    assert.doesNotMatch(markdown, /The worker invokes/);
  });
});

async function writeCompleteTraceSet({ matrix: sourceMatrix, runsDir }) {
  for (const matrixCase of sourceMatrix.cases) {
    const output = matrixCase.condition === 'candidate_with_glossary'
      ? candidateOutput(matrixCase)
      : baselineOutput(matrixCase);
    await writeTrace(runsDir, matrixCase, output);
  }
  return collectProjectGlossaryTraceIndex({ runsDir });
}

async function writeTrace(runsDir, matrixCase, output, overrides = {}) {
  const directory = path.join(runsDir, `inline_${matrixCase.id}`);
  await mkdir(directory, { recursive: true });
  const record = traceRecord(matrixCase, output, overrides);
  await writeFile(path.join(directory, `${matrixCase.id}__2026-07-21T12-10-00Z__test.json`), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
}

function traceRecord(matrixCase, output, overrides = {}) {
  return {
    schemaVersion: 2,
    scenario: {
      name: matrixCase.id,
      ...(!overrides.omitDescription ? {
        description: overrides.description ?? `project-glossary condition=${matrixCase.condition} repetition=${matrixCase.repetition} settings=${matrixCase.settings_fingerprint}`
      } : {}),
      ...(overrides.scenarioPath ? { path: overrides.scenarioPath } : {})
    },
    runner: {
      runtime: overrides.runtime ?? matrixCase.runtime,
      model: overrides.model ?? matrixCase.model,
      reasoning: overrides.reasoning ?? matrixCase.reasoning,
      finishedAt: overrides.finishedAt ?? '2026-07-21T12:10:00.000Z',
      durationMs: 1250,
      turnsUsed: 3
    },
    turns: [{ toolCalls: [{ name: 'Bash' }, { name: 'Read' }] }],
    finalOutput: output,
    toolCallSummary: { total: 2 },
    scoring: { overallPass: overrides.overallPass ?? true },
    cost: {
      inputTokens: 100,
      outputTokens: 25,
      cacheCreationTokens: 10,
      cacheReadTokens: 40
    }
  };
}

function baselineOutput(matrixCase) {
  const identifiers = matrixCase.required_identifiers.join(', ');
  return `The worker uses a retry timeout. Preserve ${identifiers}. evaluation_complete`;
}

function candidateOutput(matrixCase) {
  const identifiers = matrixCase.required_identifiers.join(', ');
  return `The Dispatch Relay uses the Recovery Window. Preserve ${identifiers}. evaluation_complete`;
}
