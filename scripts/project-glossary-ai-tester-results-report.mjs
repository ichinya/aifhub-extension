// project-glossary-ai-tester-results-report.mjs - evaluate paired glossary traces
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { PROJECT_GLOSSARY_MATRIX_SCHEMA } from './project-glossary-ai-tester-matrix.mjs';

export const PROJECT_GLOSSARY_RESULTS_SCHEMA = 'aifhub.project_glossary.ai_tester_results.v1';

const LOG_LEVELS = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40, silent: 100 });

export async function collectProjectGlossaryTraceIndex({ runsDir } = {}) {
  if (!runsDir) throw new Error('runsDir is required');
  const resolvedRuns = path.resolve(runsDir);
  const latestByScenario = new Map();
  let filesRead = 0;
  let filesSkipped = 0;
  let entries = [];
  try {
    entries = await readdir(resolvedRuns, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { runs_dir: resolvedRuns, files_read: 0, files_skipped: 0, latest_by_scenario: {} };
    }
    throw error;
  }

  log('debug', 'traces.scan.start', { directories: entries.length });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const scenarioDir = path.join(resolvedRuns, entry.name);
    let files = [];
    try {
      files = (await readdir(scenarioDir)).filter((name) => name.endsWith('.json'));
    } catch {
      filesSkipped += 1;
      continue;
    }
    for (const fileName of files) {
      const filePath = path.join(scenarioDir, fileName);
      try {
        const record = JSON.parse(await readFile(filePath, 'utf8'));
        const trace = normalizeTraceRecord(record, {
          filePath,
          runsDir: resolvedRuns,
          directoryName: entry.name,
          fileName
        });
        if (!trace.scenario_name) {
          filesSkipped += 1;
          continue;
        }
        const existing = latestByScenario.get(trace.scenario_name);
        if (!existing || compareTraceFreshness(trace, existing) > 0) {
          latestByScenario.set(trace.scenario_name, trace);
        }
        filesRead += 1;
      } catch (error) {
        filesSkipped += 1;
        log('warn', 'trace.read.skipped', {
          file: toPosix(path.relative(resolvedRuns, filePath)),
          message: error instanceof Error ? error.message : String(error)
        });
      }
    }
  }
  log('info', 'traces.scan.complete', { files_read: filesRead, files_skipped: filesSkipped });
  return {
    runs_dir: resolvedRuns,
    files_read: filesRead,
    files_skipped: filesSkipped,
    latest_by_scenario: Object.fromEntries(latestByScenario)
  };
}

export function normalizeTraceRecord(record = {}, {
  filePath = '',
  runsDir = process.cwd(),
  directoryName = '',
  fileName = ''
} = {}) {
  const inputTokens = number(record.cost?.inputTokens);
  const outputTokens = number(record.cost?.outputTokens);
  const cacheCreationTokens = number(record.cost?.cacheCreationTokens);
  const cacheReadTokens = number(record.cost?.cacheReadTokens);
  const finalOutput = String(record.finalOutput ?? '');
  const durationMs = number(record.runner?.durationMs);
  return {
    scenario_name: getScenarioName(record, directoryName, fileName),
    scenario_description: String(record.scenario?.description ?? ''),
    scenario_path: String(record.scenario?.path ?? ''),
    runtime: String(record.runner?.runtime ?? ''),
    model: String(record.runner?.model ?? ''),
    reasoning: String(record.runner?.reasoning ?? ''),
    finished_at: record.runner?.finishedAt ?? null,
    duration_ms: durationMs,
    duration_seconds: round(durationMs / 1000),
    turns: number(record.runner?.turnsUsed),
    tool_calls: number(record.toolCallSummary?.total, countToolCalls(record)),
    ai_tester_pass: record.scoring?.overallPass === true,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_creation_tokens: cacheCreationTokens,
    cache_read_tokens: cacheReadTokens,
    total_tokens: inputTokens + outputTokens + cacheCreationTokens + cacheReadTokens,
    final_output: finalOutput,
    output_sha256: sha256(finalOutput),
    trace_file: toPosix(path.relative(runsDir, filePath))
  };
}

export function buildProjectGlossaryResultsReport({
  matrix,
  traceIndex,
  matrixDir = '',
  generatedAt = new Date().toISOString()
} = {}) {
  if (matrix?.schema !== PROJECT_GLOSSARY_MATRIX_SCHEMA) {
    throw new Error(`matrix schema must be ${PROJECT_GLOSSARY_MATRIX_SCHEMA}`);
  }
  const latest = traceIndex?.latest_by_scenario ?? {};
  const rows = matrix.cases.map((matrixCase) => evaluateMatrixCase({
    matrix,
    matrixCase,
    trace: latest[matrixCase.id] ?? null,
    matrixDir
  }));
  const pairs = buildPairResults(rows);
  const executedRows = rows.filter((row) => row.trace_status !== 'NOT_RUN');
  const completeRows = rows.filter((row) => row.trace_status === 'PASS');
  const evidenceComplete = rows.length > 0
    && completeRows.length === rows.length
    && pairs.every((pair) => pair.complete);
  const safetyPass = evidenceComplete && pairs.every((pair) => pair.safety_pass);
  const baselineScores = rows.filter((row) => row.condition === 'baseline_without_glossary').map((row) => row.terminology_score);
  const candidateScores = rows.filter((row) => row.condition === 'candidate_with_glossary').map((row) => row.terminology_score);
  const baselineAverage = average(baselineScores);
  const candidateAverage = average(candidateScores);
  const scoreDelta = round(candidateAverage - baselineAverage);
  const anySafetyRegression = pairs.some((pair) => pair.complete && !pair.safety_pass);
  const outcome = decideOutcome({ evidenceComplete, safetyPass, scoreDelta, anySafetyRegression });
  const benefitClaimAllowed = outcome === 'benefit_observed';

  return {
    schema: PROJECT_GLOSSARY_RESULTS_SCHEMA,
    generated_at: generatedAt,
    run_id: matrix.run_id,
    model: matrix.model,
    reasoning: matrix.reasoning,
    runtime: matrix.runtime,
    repetitions: matrix.repetitions,
    source_fingerprint: matrix.source_fingerprint,
    evidence_complete: evidenceComplete,
    safety_pass: safetyPass,
    benefit_claim_allowed: benefitClaimAllowed,
    outcome,
    summary: {
      expected_rows: rows.length,
      executed_rows: executedRows.length,
      pass_rows: rows.filter((row) => row.trace_status === 'PASS').length,
      fail_rows: rows.filter((row) => row.trace_status === 'FAIL').length,
      not_run_rows: rows.filter((row) => row.trace_status === 'NOT_RUN').length,
      stale_rows: rows.filter((row) => row.trace_status === 'STALE').length,
      settings_mismatch_rows: rows.filter((row) => row.trace_status === 'SETTINGS_MISMATCH').length,
      pairs: pairs.length,
      complete_pairs: pairs.filter((pair) => pair.complete).length,
      safety_pass_pairs: pairs.filter((pair) => pair.safety_pass).length,
      baseline_terminology_score_average: baselineAverage,
      candidate_terminology_score_average: candidateAverage,
      terminology_score_delta: scoreDelta,
      baseline_metrics: aggregateMetrics(rows.filter((row) => row.condition === 'baseline_without_glossary')),
      candidate_metrics: aggregateMetrics(rows.filter((row) => row.condition === 'candidate_with_glossary'))
    },
    rows,
    pairs,
    trace_files_read: traceIndex?.files_read ?? 0,
    trace_files_skipped: traceIndex?.files_skipped ?? 0,
    limitations: [
      'Model output is stochastic; two repetitions per scenario are a minimum signal, not statistical proof.',
      'The fixture and glossary are synthetic and sanitised; results do not expose a real project glossary.',
      'Contract tests prove harness behavior separately from model usefulness.'
    ]
  };
}

export function renderProjectGlossaryResultsMarkdown(report = {}) {
  const lines = [
    '# Project Glossary ai-tester Results',
    '',
    `- Run: \`${md(report.run_id)}\``,
    `- Runtime/model/reasoning: \`${md(report.runtime)}\` / \`${md(report.model)}\` / \`${md(report.reasoning)}\``,
    `- Outcome: \`${md(report.outcome)}\``,
    `- Evidence complete: \`${report.evidence_complete === true}\``,
    `- Benefit claim allowed: \`${report.benefit_claim_allowed === true}\``,
    '',
    '## Summary',
    '',
    '| Metric | Value |',
    '|---|---:|',
    `| Expected/executed rows | ${num(report.summary?.expected_rows)} / ${num(report.summary?.executed_rows)} |`,
    `| Complete pairs | ${num(report.summary?.complete_pairs)} / ${num(report.summary?.pairs)} |`,
    `| Baseline terminology score | ${num(report.summary?.baseline_terminology_score_average)} |`,
    `| Candidate terminology score | ${num(report.summary?.candidate_terminology_score_average)} |`,
    `| Paired score delta | ${signed(report.summary?.terminology_score_delta)} |`,
    '',
    '## Rows',
    '',
    '| Scenario | Rep | Condition | Trace | Score | Canonical | Avoided | Identifiers | Authority | Duration | Turns | Tools | Total tokens |',
    '|---|---:|---|---|---:|---:|---:|---|---|---:|---:|---:|---:|'
  ];
  for (const row of report.rows ?? []) {
    lines.push([
      md(row.scenario_id),
      num(row.repetition),
      md(row.condition),
      md(row.trace_status),
      num(row.terminology_score),
      `${num(row.canonical_term_hits)}/${num(row.canonical_term_total)}`,
      num(row.avoided_term_hits),
      row.identifiers_preserved ? 'PASS' : 'FAIL',
      row.authority_preserved ? 'PASS' : 'FAIL',
      num(row.duration_seconds),
      num(row.turns),
      num(row.tool_calls),
      num(row.total_tokens)
    ].map((value) => `| ${value} `).join('') + '|');
  }
  lines.push(
    '',
    '## Pairs',
    '',
    '| Pair | Complete | Safety | Baseline | Candidate | Delta | Decision |',
    '|---|---|---|---:|---:|---:|---|'
  );
  for (const pair of report.pairs ?? []) {
    lines.push(`| ${md(pair.pair_id)} | ${pair.complete ? 'PASS' : 'FAIL'} | ${pair.safety_pass ? 'PASS' : 'FAIL'} | ${num(pair.baseline_score)} | ${num(pair.candidate_score)} | ${signed(pair.score_delta)} | ${md(pair.decision)} |`);
  }
  lines.push('', '## Limitations', '');
  for (const limitation of report.limitations ?? []) lines.push(`- ${limitation}`);
  lines.push('');
  return lines.join('\n');
}

export async function writeProjectGlossaryResults({
  matrixPath,
  runsDir,
  outDir,
  jsonFile = 'project-glossary-ai-tester-results.json',
  markdownFile = 'project-glossary-ai-tester-results.md'
} = {}) {
  if (!matrixPath || !runsDir || !outDir) throw new Error('matrixPath, runsDir, and outDir are required');
  log('info', 'report.write.start', { matrix: path.basename(matrixPath) });
  const matrix = JSON.parse(await readFile(matrixPath, 'utf8'));
  const traceIndex = await collectProjectGlossaryTraceIndex({ runsDir });
  const report = buildProjectGlossaryResultsReport({
    matrix,
    traceIndex,
    matrixDir: path.dirname(path.resolve(matrixPath))
  });
  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, jsonFile), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await writeFile(path.join(outDir, markdownFile), renderProjectGlossaryResultsMarkdown(report), 'utf8');
  log('info', 'report.write.complete', {
    outcome: report.outcome,
    expected_rows: report.summary.expected_rows,
    executed_rows: report.summary.executed_rows
  });
  return report;
}

function evaluateMatrixCase({ matrix, matrixCase, trace, matrixDir }) {
  const base = {
    id: matrixCase.id,
    pair_id: matrixCase.pair_id,
    scenario_id: matrixCase.scenario_id,
    skill: matrixCase.skill,
    repetition: matrixCase.repetition,
    condition: matrixCase.condition,
    settings_fingerprint: matrixCase.settings_fingerprint,
    trace_status: 'NOT_RUN',
    ai_tester_pass: false,
    settings_match: false,
    fresh_trace: false,
    terminology_score: 0,
    canonical_term_hits: 0,
    canonical_term_total: matrixCase.canonical_terms.length,
    avoided_term_hits: 0,
    avoided_term_total: matrixCase.avoided_terms.length,
    identifiers_preserved: false,
    missing_identifiers: [...matrixCase.required_identifiers],
    authority_preserved: false,
    authority_violations: [],
    leakage_free: false,
    duration_seconds: null,
    turns: null,
    tool_calls: null,
    input_tokens: null,
    output_tokens: null,
    cache_creation_tokens: null,
    cache_read_tokens: null,
    total_tokens: null,
    output_sha256: null,
    trace_file: null,
    finished_at: null
  };
  if (!trace) return base;

  const freshTrace = isFreshTrace(trace.finished_at, matrix.generated_at);
  const expectedScenarioPath = matrixDir
    ? path.resolve(matrixDir, fromPosix(matrixCase.scenario_file))
    : '';
  const settingsEvidenceMatch = trace.scenario_description.includes(`settings=${matrixCase.settings_fingerprint}`)
    || samePath(trace.scenario_path, expectedScenarioPath);
  const settingsMatch = trace.runtime === matrixCase.runtime
    && trace.model === matrixCase.model
    && trace.reasoning === matrixCase.reasoning
    && settingsEvidenceMatch;
  const canonicalHits = matrixCase.canonical_terms.filter((term) => includesInsensitive(trace.final_output, term)).length;
  const avoidedHits = matrixCase.avoided_terms.filter((term) => includesInsensitive(trace.final_output, term)).length;
  const missingIdentifiers = matrixCase.required_identifiers.filter((identifier) => !trace.final_output.includes(identifier));
  const authorityViolations = matrixCase.forbidden_authority_claims.filter((claim) => includesInsensitive(trace.final_output, claim));
  const leakageFree = !trace.final_output.includes(matrixCase.sentinel);
  const terminologyScore = round(
    ((canonicalHits + (matrixCase.avoided_terms.length - avoidedHits))
      / (matrixCase.canonical_terms.length + matrixCase.avoided_terms.length)) * 100
  );
  const traceStatus = !freshTrace
    ? 'STALE'
    : !settingsMatch
      ? 'SETTINGS_MISMATCH'
      : trace.ai_tester_pass
        ? 'PASS'
        : 'FAIL';

  return {
    ...base,
    trace_status: traceStatus,
    ai_tester_pass: trace.ai_tester_pass,
    settings_match: settingsMatch,
    fresh_trace: freshTrace,
    terminology_score: terminologyScore,
    canonical_term_hits: canonicalHits,
    avoided_term_hits: avoidedHits,
    identifiers_preserved: missingIdentifiers.length === 0,
    missing_identifiers: missingIdentifiers,
    authority_preserved: authorityViolations.length === 0,
    authority_violations: authorityViolations,
    leakage_free: leakageFree,
    duration_seconds: trace.duration_seconds,
    turns: trace.turns,
    tool_calls: trace.tool_calls,
    input_tokens: trace.input_tokens,
    output_tokens: trace.output_tokens,
    cache_creation_tokens: trace.cache_creation_tokens,
    cache_read_tokens: trace.cache_read_tokens,
    total_tokens: trace.total_tokens,
    output_sha256: trace.output_sha256,
    trace_file: trace.trace_file,
    finished_at: trace.finished_at
  };
}

function buildPairResults(rows) {
  const grouped = new Map();
  for (const row of rows) {
    if (!grouped.has(row.pair_id)) grouped.set(row.pair_id, []);
    grouped.get(row.pair_id).push(row);
  }
  return [...grouped.entries()].map(([pairId, pairRows]) => {
    const baseline = pairRows.find((row) => row.condition === 'baseline_without_glossary');
    const candidate = pairRows.find((row) => row.condition === 'candidate_with_glossary');
    const complete = Boolean(
      baseline
      && candidate
      && baseline.trace_status === 'PASS'
      && candidate.trace_status === 'PASS'
      && baseline.settings_fingerprint === candidate.settings_fingerprint
    );
    const safetyPass = Boolean(
      complete
      && baseline.identifiers_preserved
      && baseline.authority_preserved
      && baseline.leakage_free
      && candidate.identifiers_preserved
      && candidate.authority_preserved
      && candidate.leakage_free
    );
    const baselineScore = baseline?.terminology_score ?? 0;
    const candidateScore = candidate?.terminology_score ?? 0;
    const scoreDelta = round(candidateScore - baselineScore);
    const decision = !complete
      ? 'inconclusive'
      : !safetyPass
        ? 'regressive'
        : scoreDelta > 0
          ? 'improved'
          : scoreDelta < 0
            ? 'regressive'
            : 'neutral';
    return {
      pair_id: pairId,
      scenario_id: baseline?.scenario_id ?? candidate?.scenario_id ?? null,
      repetition: baseline?.repetition ?? candidate?.repetition ?? null,
      complete,
      safety_pass: safetyPass,
      baseline_score: baselineScore,
      candidate_score: candidateScore,
      score_delta: scoreDelta,
      decision
    };
  }).sort((left, right) => left.pair_id.localeCompare(right.pair_id));
}

function decideOutcome({ evidenceComplete, safetyPass, scoreDelta, anySafetyRegression }) {
  if (!evidenceComplete) return 'inconclusive';
  if (!safetyPass || anySafetyRegression || scoreDelta < 0) return 'regressive';
  if (scoreDelta === 0) return 'neutral';
  return 'benefit_observed';
}

function aggregateMetrics(rows) {
  return {
    rows: rows.length,
    duration_seconds: round(sum(rows.map((row) => row.duration_seconds))),
    turns: sum(rows.map((row) => row.turns)),
    tool_calls: sum(rows.map((row) => row.tool_calls)),
    input_tokens: sum(rows.map((row) => row.input_tokens)),
    output_tokens: sum(rows.map((row) => row.output_tokens)),
    cache_creation_tokens: sum(rows.map((row) => row.cache_creation_tokens)),
    cache_read_tokens: sum(rows.map((row) => row.cache_read_tokens)),
    total_tokens: sum(rows.map((row) => row.total_tokens))
  };
}

function getScenarioName(record, directoryName, fileName) {
  if (record.scenario?.name) return String(record.scenario.name);
  if (directoryName.startsWith('inline_')) return directoryName.slice('inline_'.length);
  const timestampPart = fileName.match(/__(\d{4}-\d{2}-\d{2}T)/);
  return timestampPart ? fileName.slice(0, timestampPart.index).replace(/^inline_/, '') : null;
}

function compareTraceFreshness(left, right) {
  const leftTime = Date.parse(left.finished_at ?? '');
  const rightTime = Date.parse(right.finished_at ?? '');
  if (!Number.isNaN(leftTime) && !Number.isNaN(rightTime) && leftTime !== rightTime) return leftTime - rightTime;
  return left.trace_file.localeCompare(right.trace_file);
}

function isFreshTrace(finishedAt, matrixGeneratedAt) {
  const finished = Date.parse(finishedAt ?? '');
  const generated = Date.parse(matrixGeneratedAt ?? '');
  return !Number.isNaN(finished) && !Number.isNaN(generated) && finished >= generated;
}

function countToolCalls(record) {
  return asArray(record.turns).reduce((total, turn) => total + asArray(turn.toolCalls).length, 0);
}

function includesInsensitive(value, fragment) {
  return String(value).toLocaleLowerCase('en-US').includes(String(fragment).toLocaleLowerCase('en-US'));
}

function average(values) {
  return values.length === 0 ? 0 : round(sum(values) / values.length);
}

function sum(values) {
  return values.reduce((total, value) => total + number(value), 0);
}

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function round(value) {
  return Math.round(number(value) * 10) / 10;
}

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function md(value) {
  return String(value ?? '').replaceAll('|', ';').replace(/[\r\n]+/g, ' ');
}

function num(value) {
  return Number.isFinite(Number(value)) ? Number(value).toLocaleString('en-US', { maximumFractionDigits: 1 }) : '';
}

function signed(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return '';
  return `${parsed > 0 ? '+' : ''}${parsed.toLocaleString('en-US', { maximumFractionDigits: 1 })}`;
}

function toPosix(value) {
  return String(value).replaceAll(path.sep, '/');
}

function fromPosix(value) {
  return String(value).split('/').join(path.sep);
}

function samePath(left, right) {
  if (!left || !right) return false;
  const normalize = (value) => {
    const withoutExtendedPrefix = String(value).replace(/^\\\\\?\\/, '');
    const resolved = path.resolve(withoutExtendedPrefix);
    return process.platform === 'win32' ? resolved.toLocaleLowerCase('en-US') : resolved;
  };
  return normalize(left) === normalize(right);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function log(level, event, details = {}) {
  const configured = String(process.env.AIF_GLOSSARY_LOG_LEVEL ?? process.env.LOG_LEVEL ?? 'warn').toLowerCase();
  const threshold = LOG_LEVELS[configured] ?? LOG_LEVELS.warn;
  if ((LOG_LEVELS[level] ?? LOG_LEVELS.info) < threshold) return;
  process.stderr.write(`${JSON.stringify({ component: 'project-glossary-ai-tester-report', level, event, ...details })}\n`);
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

function usage() {
  return [
    'Usage: node scripts/project-glossary-ai-tester-results-report.mjs --matrix <file> --runs-dir <dir> --out <dir> [options]',
    '',
    'Reads real ai-tester traces and writes sanitised JSON/Markdown paired results.',
    ''
  ].join('\n');
}

async function main() {
  const parsed = parseCliArgs(process.argv.slice(2));
  if (parsed.help) {
    process.stdout.write(usage());
    return;
  }
  const report = await writeProjectGlossaryResults(parsed);
  const body = {
    schema: report.schema,
    run_id: report.run_id,
    outcome: report.outcome,
    evidence_complete: report.evidence_complete,
    benefit_claim_allowed: report.benefit_claim_allowed,
    expected_rows: report.summary.expected_rows,
    executed_rows: report.summary.executed_rows,
    complete_pairs: report.summary.complete_pairs
  };
  process.stdout.write(parsed.json ? `${JSON.stringify(body, null, 2)}\n` : `${body.outcome}: ${body.executed_rows}/${body.expected_rows} rows.\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    log('error', 'report.failed', { message: error instanceof Error ? error.message : String(error) });
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
