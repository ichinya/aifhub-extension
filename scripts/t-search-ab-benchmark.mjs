// t-search-ab-benchmark.mjs - bounded rg vs T-Search retrieval pilot
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const T_SEARCH_AB_CATALOG_SCHEMA = 'aifhub.t_search.ab_scenario_catalog.v1';
export const T_SEARCH_AB_RESULT_SCHEMA = 'aifhub.t_search.ab_results.v1';
export const T_SEARCH_HARNESS_REVISION = '997a0ba1685d24ad840e3e2542b59952ff3fb362';
export const T_SEARCH_VARIANTS = Object.freeze(['baseline_rg', 'candidate_t_search']);

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const DEFAULT_CATALOG = path.join(REPO_ROOT, 'docs', 'memory-tools-research', 't-search-ab-scenarios.json');
const ADAPTER_PATH = path.join(SCRIPT_DIR, 't-search-ab-adapter.py');
const ALLOWED_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.py', '.php', '.vue', '.md', '.json', '.yaml', '.yml', '.toml']);
const EXCLUDED_SEGMENTS = new Set(['.git', 'node_modules', 'vendor', 'storage', 'dist', 'build', 'coverage']);
const FORBIDDEN_OUTPUT_PREFIXES = [
  'openspec/',
  '.ai-factory/qa/',
  '.ai-factory/rules/generated/'
];
const STOP_WORDS = new Set([
  'about', 'after', 'against', 'application', 'before', 'does', 'from', 'into', 'may', 'system', 'that', 'the',
  'their', 'them', 'these', 'this', 'what', 'when', 'where', 'which', 'with',
  'где', 'для', 'его', 'или', 'как', 'какие', 'когда', 'после', 'перед', 'система', 'что', 'эта', 'это'
]);
const FORBIDDEN_CANDIDATE_KEYS = new Set([
  'all_round_messages', 'content', 'documents', 'messages', 'query', 'reasoning', 'round_summaries', 'snippet',
  'text', 'transcript'
]);

export async function loadTSearchAbCatalog({ catalogPath = DEFAULT_CATALOG } = {}) {
  const resolved = path.resolve(catalogPath);
  const catalog = JSON.parse(await readFile(resolved, 'utf8'));
  const errors = validateTSearchAbCatalog(catalog);
  if (errors.length > 0) throw new Error(`invalid T-Search A/B catalog: ${errors.join('; ')}`);
  return { catalog, catalogPath: resolved };
}

export function validateTSearchAbCatalog(catalog = {}) {
  const errors = [];
  if (catalog.schema !== T_SEARCH_AB_CATALOG_SCHEMA) errors.push(`schema must be ${T_SEARCH_AB_CATALOG_SCHEMA}`);
  if (!safeRelativePath(catalog.fixture_root)) errors.push('fixture_root must be a safe relative path');
  const identity = objectValue(catalog.candidate_identity);
  if (identity.model_repo !== 't-tech/T-Search-GGUF') errors.push('candidate_identity.model_repo is invalid');
  if (!/^[0-9a-f]{40}$/.test(String(identity.model_revision ?? ''))) {
    errors.push('candidate_identity.model_revision must be a full commit');
  }
  if (identity.model_file !== 'T-Search-Q4_K_M.gguf') errors.push('candidate_identity.model_file is invalid');
  if (!positiveInteger(identity.model_size_bytes)) errors.push('candidate_identity.model_size_bytes must be positive');
  if (!/^[0-9a-f]{64}$/.test(String(identity.model_sha256 ?? ''))) {
    errors.push('candidate_identity.model_sha256 must be SHA-256');
  }
  if (identity.harness_revision !== T_SEARCH_HARNESS_REVISION) {
    errors.push('candidate_identity.harness_revision must match the pinned harness');
  }
  if (!positiveInteger(identity.llama_cpp_build)) errors.push('candidate_identity.llama_cpp_build must be positive');
  if (!/^[0-9a-f]{40}$/.test(String(identity.llama_cpp_revision ?? ''))) {
    errors.push('candidate_identity.llama_cpp_revision must be a full commit');
  }
  const defaults = objectValue(catalog.defaults);
  if (JSON.stringify(defaults.variants) !== JSON.stringify(T_SEARCH_VARIANTS)) {
    errors.push(`defaults.variants must be ${T_SEARCH_VARIANTS.join(', ')}`);
  }
  if (!positiveInteger(defaults.top_k) || defaults.top_k > 50) errors.push('defaults.top_k must be 1..50');
  if (!positiveInteger(defaults.max_rounds) || defaults.max_rounds > 5) errors.push('defaults.max_rounds must be 1..5');
  if (!positiveInteger(defaults.budget_tokens)) errors.push('defaults.budget_tokens must be positive');
  if (!positiveInteger(defaults.max_tokens_per_turn)) errors.push('defaults.max_tokens_per_turn must be positive');
  if (!positiveInteger(defaults.max_turns_per_round)) errors.push('defaults.max_turns_per_round must be positive');
  if (!positiveInteger(defaults.timeout_seconds)) errors.push('defaults.timeout_seconds must be positive');
  if (!positiveInteger(defaults.server_context_tokens)) errors.push('defaults.server_context_tokens must be positive');
  if (!Number.isFinite(defaults.temperature) || defaults.temperature < 0 || defaults.temperature > 2) {
    errors.push('defaults.temperature must be between 0 and 2');
  }
  if (!Number.isFinite(defaults.top_p) || defaults.top_p <= 0 || defaults.top_p > 1) {
    errors.push('defaults.top_p must be greater than 0 and at most 1');
  }
  if (defaults.no_promote !== true) errors.push('defaults.no_promote must be true for the local pilot');
  const canaries = stringArray(defaults.privacy_canaries);
  if (canaries.length < 2 || canaries.some((value) => value.length < 12)) {
    errors.push('defaults.privacy_canaries must contain at least two bounded synthetic values');
  }

  const scenarios = Array.isArray(catalog.scenarios) ? catalog.scenarios : [];
  if (scenarios.length < 4) errors.push('scenarios must contain at least four entries');
  const ids = new Set();
  const languages = new Set();
  for (const [index, scenario] of scenarios.entries()) {
    const prefix = `scenarios[${index}]`;
    if (!safeId(scenario?.id)) errors.push(`${prefix}.id must be lowercase kebab-safe`);
    if (ids.has(scenario?.id)) errors.push(`${prefix}.id duplicates ${scenario.id}`);
    ids.add(scenario?.id);
    if (!['en', 'ru'].includes(scenario?.language)) errors.push(`${prefix}.language must be en or ru`);
    languages.add(scenario?.language);
    if (!String(scenario?.query ?? '').trim()) errors.push(`${prefix}.query must not be empty`);
    if (containsCanary(scenario?.query, canaries)) errors.push(`${prefix}.query contains a privacy canary`);
    const truth = stringArray(scenario?.ground_truth_chunk_ids);
    if (truth.length === 0) errors.push(`${prefix}.ground_truth_chunk_ids must not be empty`);
    if (new Set(truth).size !== truth.length) errors.push(`${prefix}.ground_truth_chunk_ids contains duplicates`);
    if (truth.some((value) => !safeChunkId(value))) errors.push(`${prefix}.ground_truth_chunk_ids contains unsafe ids`);
  }
  if (!languages.has('en') || !languages.has('ru')) errors.push('scenario catalog must contain English and Russian tasks');
  return errors;
}

export async function buildTSearchCorpus({ fixtureRoot }) {
  const lexicalRoot = path.resolve(fixtureRoot);
  const canonicalRoot = await realpath(lexicalRoot);
  const files = [];
  await walkCorpus(canonicalRoot, canonicalRoot, files);
  files.sort((a, b) => a.relative_path.localeCompare(b.relative_path, 'en'));
  if (files.length === 0) throw new Error('T-Search fixture contains no eligible corpus files');

  const chunks = [];
  for (const file of files) {
    const raw = await readFile(file.absolute_path, 'utf8');
    if (raw.includes('\u0000')) throw new Error(`binary-looking corpus file: ${file.relative_path}`);
    file.bytes = Buffer.byteLength(raw);
    file.sha256 = sha256(raw);
    chunks.push(...parseMarkedChunks(file.relative_path, raw));
  }
  if (chunks.length === 0) throw new Error('T-Search fixture contains no marked chunks');
  const ids = chunks.map((chunk) => chunk.chunk_id);
  if (new Set(ids).size !== ids.length) throw new Error('T-Search fixture contains duplicate chunk ids');

  const fingerprint = sha256(files.map((file) => `${file.relative_path}\0${file.sha256}`).join('\n'));
  return { root: canonicalRoot, files, chunks, fingerprint };
}

export async function verifyCandidateModelFile({ modelFile, identity }) {
  const lexical = path.resolve(modelFile);
  const lexicalStats = await lstat(lexical);
  if (lexicalStats.isSymbolicLink() || !lexicalStats.isFile()) {
    throw new Error('candidate model must be a regular non-symlink file');
  }
  const canonical = await realpath(lexical);
  const relativeToRepo = path.relative(REPO_ROOT, canonical);
  if (!relativeToRepo.startsWith('..') && !path.isAbsolute(relativeToRepo)) {
    throw new Error('candidate model must remain outside the repository');
  }
  if (path.basename(canonical) !== identity.model_file) throw new Error('candidate model filename mismatch');
  if (lexicalStats.size !== identity.model_size_bytes) throw new Error('candidate model size mismatch');
  const digest = await hashFileSha256(canonical);
  if (digest !== identity.model_sha256) throw new Error('candidate model SHA-256 mismatch');
  const finalStats = await lstat(canonical);
  if (!finalStats.isFile() || finalStats.size !== lexicalStats.size || finalStats.mtimeMs !== lexicalStats.mtimeMs) {
    throw new Error('candidate model changed during verification');
  }
  return true;
}

export function parseMarkedChunks(relativePath, raw) {
  const lines = raw.replace(/\r\n/g, '\n').split('\n');
  const markers = [];
  const markerPattern = /^\s*(?:\/\/\s*chunk:\s*([a-z0-9-]+)|<!--\s*chunk:\s*([a-z0-9-]+)\s*-->)\s*$/;
  for (const [index, line] of lines.entries()) {
    const match = line.match(markerPattern);
    if (match) markers.push({ id: match[1] ?? match[2], markerLine: index + 1 });
  }
  if (markers.length === 0) throw new Error(`corpus file has no chunk markers: ${relativePath}`);
  return markers.map((marker, index) => {
    const startLine = marker.markerLine + 1;
    const endLine = index + 1 < markers.length ? markers[index + 1].markerLine - 1 : lines.length;
    const content = lines.slice(startLine - 1, endLine).join('\n').trim();
    if (!content) throw new Error(`empty marked chunk: ${relativePath}#${marker.id}`);
    return {
      chunk_id: `${relativePath}#${marker.id}`,
      relative_path: relativePath,
      marker_id: marker.id,
      start_line: startLine,
      end_line: endLine,
      content
    };
  });
}

export async function runRgBaseline({
  corpus,
  query,
  topK = 10,
  timeoutMs = 30_000,
  command = 'rg',
  commandRunner = runBoundedCommand
}) {
  const started = Date.now();
  const terms = tokenizeQuery(query);
  if (terms.length === 0) {
    return baselineFailure('no_search_terms', Date.now() - started);
  }
  const args = ['--json', '--ignore-case', '--fixed-strings', '--no-messages'];
  for (const term of terms) args.push('-e', term);
  args.push('--', ...corpus.files.map((file) => file.relative_path));
  const run = await commandRunner(command, args, {
    cwd: corpus.root,
    timeoutMs,
    maxOutputBytes: 4 * 1024 * 1024,
    env: process.env
  });
  if (![0, 1].includes(run.exitCode)) return baselineFailure('rg_failed', run.elapsedMs);
  const ranking = rankRgJsonMatches(run.stdout, corpus, terms, topK);
  return {
    schema: 'aifhub.t_search.ab_variant.v1',
    variant: 'baseline_rg',
    status: 'PASS',
    ranked_chunk_ids: ranking,
    privacy_passed: true,
    source_boundary_passed: true,
    freshness_passed: true,
    purge_passed: true,
    persistent_state_created: false,
    metrics: {
      elapsed_ms: run.elapsedMs,
      search_calls: 1,
      query_term_count: terms.length,
      returned_count: ranking.length
    },
    error_code: null
  };
}

export function rankRgJsonMatches(stdout, corpus, terms, topK) {
  const chunkByPath = new Map();
  for (const chunk of corpus.chunks) {
    const list = chunkByPath.get(chunk.relative_path) ?? [];
    list.push(chunk);
    chunkByPath.set(chunk.relative_path, list);
  }
  const scores = new Map();
  for (const line of String(stdout).split(/\r?\n/)) {
    if (!line) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event?.type !== 'match') continue;
    const relativePath = normalizeRelative(event.data?.path?.text);
    const lineNumber = Number(event.data?.line_number);
    const chunk = (chunkByPath.get(relativePath) ?? []).find(
      (item) => lineNumber >= item.start_line && lineNumber <= item.end_line
    );
    if (!chunk) continue;
    const entry = scores.get(chunk.chunk_id) ?? { chunk_id: chunk.chunk_id, terms: new Set(), matches: 0 };
    const lineText = String(event.data?.lines?.text ?? '').toLocaleLowerCase('und');
    for (const term of terms) if (lineText.includes(term)) entry.terms.add(term);
    entry.matches += Math.max(1, Array.isArray(event.data?.submatches) ? event.data.submatches.length : 1);
    scores.set(chunk.chunk_id, entry);
  }
  return [...scores.values()]
    .sort((a, b) => b.terms.size - a.terms.size || b.matches - a.matches || a.chunk_id.localeCompare(b.chunk_id, 'en'))
    .slice(0, topK)
    .map((item) => item.chunk_id);
}

export function scoreRanking(rankedChunkIds, groundTruthChunkIds, topK = 10) {
  const truth = new Set(groundTruthChunkIds);
  const ranking = stringArray(rankedChunkIds).slice(0, topK);
  const hits = ranking.filter((chunkId) => truth.has(chunkId));
  const firstRank = ranking.findIndex((chunkId) => truth.has(chunkId));
  return {
    recall_at_10: truth.size === 0 ? 0 : round(hits.length / truth.size),
    precision_at_10: ranking.length === 0 ? 0 : round(hits.length / Math.min(topK, ranking.length)),
    false_positive_rate: ranking.length === 0 ? null : round((ranking.length - hits.length) / ranking.length),
    reciprocal_rank: firstRank < 0 ? 0 : round(1 / (firstRank + 1)),
    relevant_found: hits.length,
    relevant_total: truth.size
  };
}

export function validateCandidateResult(value, {
  scenarioId,
  privacyCanaries = [],
  allowedChunkIds,
  topK
} = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('candidate output must be an object');
  if (value.schema !== 'aifhub.t_search.ab_candidate.v1') throw new Error('candidate output schema mismatch');
  if (value.scenario_id !== scenarioId) throw new Error('candidate output scenario mismatch');
  if (!['PASS', 'FAIL', 'NOT_RUN'].includes(value.status)) throw new Error('candidate status is invalid');
  if (!Array.isArray(value.ranked_chunk_ids) || value.ranked_chunk_ids.some((id) => !safeChunkId(id))) {
    throw new Error('candidate ranking contains unsafe chunk ids');
  }
  if (new Set(value.ranked_chunk_ids).size !== value.ranked_chunk_ids.length) {
    throw new Error('candidate ranking contains duplicate chunk ids');
  }
  if (positiveInteger(topK) && value.ranked_chunk_ids.length > topK) {
    throw new Error('candidate ranking exceeds the configured top-k');
  }
  if (allowedChunkIds && value.ranked_chunk_ids.some((id) => !allowedChunkIds.has(id))) {
    throw new Error('candidate ranking escaped the bounded corpus');
  }
  if (value.status === 'PASS' && (
    value.privacy_passed !== true
    || value.source_boundary_passed !== true
    || value.freshness_passed !== true
    || value.purge_passed !== true
    || value.persistent_state_created !== false
    || value.harness_provenance_passed !== true
    || value.model_identity_passed !== true
  )) {
    throw new Error('passing candidate must satisfy every safety and provenance gate');
  }
  const serialized = JSON.stringify(value);
  if (containsCanary(serialized, privacyCanaries)) throw new Error('candidate output contains a privacy canary');
  if (looksLikeAbsolutePath(serialized)) throw new Error('candidate output contains an absolute path');
  assertNoForbiddenCandidateKeys(value);
  return value;
}

export function summarizeTSearchAb({
  catalog,
  corpus,
  rows,
  profile = catalog.defaults.profile,
  corpusUnchangedPassed = true,
  modelFileVerified = null
}) {
  const pairs = catalog.scenarios
    .filter((scenario) => rows.some((row) => row.scenario_id === scenario.id))
    .map((scenario) => {
      const baseline = rows.find((row) => row.scenario_id === scenario.id && row.variant === 'baseline_rg');
      const candidate = rows.find((row) => row.scenario_id === scenario.id && row.variant === 'candidate_t_search');
      return {
        scenario_id: scenario.id,
        language: scenario.language,
        baseline_status: baseline?.status ?? 'NOT_RUN',
        candidate_status: candidate?.status ?? 'NOT_RUN',
        baseline_recall_at_10: baseline?.status === 'PASS' ? baseline.score.recall_at_10 : null,
        candidate_recall_at_10: candidate?.status === 'PASS' ? candidate.score.recall_at_10 : null,
        baseline_precision_at_10: baseline?.status === 'PASS' ? baseline.score.precision_at_10 : null,
        candidate_precision_at_10: candidate?.status === 'PASS' ? candidate.score.precision_at_10 : null,
        baseline_false_positive_rate: baseline?.status === 'PASS' ? baseline.score.false_positive_rate : null,
        candidate_false_positive_rate: candidate?.status === 'PASS' ? candidate.score.false_positive_rate : null,
        baseline_reciprocal_rank: baseline?.status === 'PASS' ? baseline.score.reciprocal_rank : null,
        candidate_reciprocal_rank: candidate?.status === 'PASS' ? candidate.score.reciprocal_rank : null,
        candidate_privacy_passed: candidate?.privacy_passed ?? null,
        candidate_source_boundary_passed: candidate?.source_boundary_passed ?? null,
        candidate_freshness_passed: candidate?.freshness_passed ?? null,
        candidate_purge_passed: candidate?.purge_passed ?? null,
        candidate_persistent_state_created: candidate?.persistent_state_created ?? null,
        candidate_harness_provenance_passed: candidate?.harness_provenance_passed ?? null,
        candidate_model_identity_passed: candidate?.model_identity_passed ?? null
      };
    });
  const baselineRows = rows.filter((row) => row.variant === 'baseline_rg' && row.status === 'PASS');
  const candidateRows = rows.filter((row) => row.variant === 'candidate_t_search');
  const passedCandidates = candidateRows.filter((row) => row.status === 'PASS');
  const safetyFailed = !corpusUnchangedPassed || candidateRows.some((row) => (
    row.privacy_passed === false
    || row.source_boundary_passed === false
    || row.freshness_passed === false
    || row.purge_passed === false
    || row.persistent_state_created === true
  ));
  const allCandidateRowsPassed = candidateRows.length === pairs.length && passedCandidates.length === pairs.length;
  const baselineRecall = average(baselineRows.map((row) => row.score.recall_at_10));
  const candidateRecall = average(passedCandidates.map((row) => row.score.recall_at_10));
  const baselineFalsePositiveRate = averageScore(baselineRows, 'false_positive_rate');
  const candidateFalsePositiveRate = averageScore(passedCandidates, 'false_positive_rate');
  let pilotDecision = 'not_run';
  if (safetyFailed) pilotDecision = 'forbid';
  else if (passedCandidates.length === 0) pilotDecision = 'not_run';
  else if (!allCandidateRowsPassed) pilotDecision = 'incomplete';
  else if (
    (candidateRecall > baselineRecall && candidateFalsePositiveRate <= baselineFalsePositiveRate)
    || (candidateRecall >= baselineRecall && candidateFalsePositiveRate < baselineFalsePositiveRate)
  ) pilotDecision = 'pilot_positive';
  else if (
    candidateRecall === baselineRecall
    && candidateFalsePositiveRate === baselineFalsePositiveRate
  ) pilotDecision = 'no_measured_gain';
  else pilotDecision = 'pilot_negative';

  return {
    schema: T_SEARCH_AB_RESULT_SCHEMA,
    candidate_identity: catalog.candidate_identity,
    profile,
    no_promote: true,
    policy_decision: 'reject_defer',
    pilot_decision: pilotDecision,
    model_file_verified: modelFileVerified,
    corpus: {
      fingerprint: corpus.fingerprint,
      file_count: corpus.files.length,
      chunk_count: corpus.chunks.length
    },
    scenario_count: pairs.length,
    pair_count: pairs.filter((pair) => pair.baseline_status === 'PASS' && pair.candidate_status === 'PASS').length,
    baseline_average_recall_at_10: baselineRows.length ? baselineRecall : null,
    candidate_average_recall_at_10: passedCandidates.length ? candidateRecall : null,
    baseline_average_precision_at_10: averageScore(baselineRows, 'precision_at_10'),
    candidate_average_precision_at_10: averageScore(passedCandidates, 'precision_at_10'),
    baseline_average_false_positive_rate: baselineFalsePositiveRate,
    candidate_average_false_positive_rate: candidateFalsePositiveRate,
    baseline_average_reciprocal_rank: averageScore(baselineRows, 'reciprocal_rank'),
    candidate_average_reciprocal_rank: averageScore(passedCandidates, 'reciprocal_rank'),
    baseline_total_elapsed_ms: sumMetric(baselineRows, 'elapsed_ms'),
    candidate_total_elapsed_ms: sumMetric(candidateRows, 'elapsed_ms'),
    candidate_total_prompt_tokens: sumMetric(candidateRows, 'prompt_tokens'),
    candidate_total_completion_tokens: sumMetric(candidateRows, 'completion_tokens'),
    candidate_total_tokens: sumMetric(candidateRows, 'total_tokens'),
    candidate_total_search_calls: sumMetric(candidateRows, 'search_calls'),
    candidate_status_counts: Object.fromEntries(
      ['PASS', 'FAIL', 'NOT_RUN'].map((status) => [
        status,
        pairs.filter((pair) => pair.candidate_status === status).length
      ])
    ),
    privacy_passed: aggregateBooleanGate(candidateRows, 'privacy_passed'),
    source_boundary_passed: aggregateBooleanGate(candidateRows, 'source_boundary_passed'),
    freshness_passed: corpusUnchangedPassed
      ? aggregateBooleanGate(candidateRows, 'freshness_passed')
      : false,
    purge_passed: aggregatePurgeGate(candidateRows),
    persistent_state_created: aggregatePersistentState(candidateRows),
    harness_provenance_passed: aggregateBooleanGate(candidateRows, 'harness_provenance_passed'),
    model_identity_passed: aggregateBooleanGate(candidateRows, 'model_identity_passed'),
    corpus_unchanged_passed: corpusUnchangedPassed,
    pairs
  };
}

export async function runTSearchAbBenchmark({
  catalogPath = DEFAULT_CATALOG,
  fixtureRoot,
  outDir,
  baselineOnly = false,
  dryRun = false,
  maxScenarios,
  scenarioIds = [],
  harnessRoot,
  modelFile,
  endpoint,
  model = 't-tech/T-Search-GGUF',
  uvCommand = 'uv',
  rgCommand = 'rg',
  rgCommandRunner,
  candidateRunner
} = {}) {
  const { catalog, catalogPath: resolvedCatalog } = await loadTSearchAbCatalog({ catalogPath });
  if (model !== catalog.candidate_identity.model_repo) {
    throw new Error('candidate model alias must match the pinned catalog identity');
  }
  const resolvedFixture = path.resolve(fixtureRoot ?? path.join(REPO_ROOT, fromPosix(catalog.fixture_root)));
  const corpus = await buildTSearchCorpus({ fixtureRoot: resolvedFixture });
  for (const scenario of catalog.scenarios) {
    for (const chunkId of scenario.ground_truth_chunk_ids) {
      if (!corpus.chunks.some((chunk) => chunk.chunk_id === chunkId)) {
        throw new Error(`ground-truth chunk is absent from corpus: ${chunkId}`);
      }
    }
  }
  let scenarios = catalog.scenarios.filter((scenario) => scenarioIds.length === 0 || scenarioIds.includes(scenario.id));
  if (positiveInteger(maxScenarios)) scenarios = scenarios.slice(0, maxScenarios);
  if (scenarios.length === 0) throw new Error('no T-Search scenarios selected');

  if (dryRun) {
    return {
      summary: {
        schema: T_SEARCH_AB_RESULT_SCHEMA,
        dry_run: true,
        policy_decision: 'reject_defer',
        candidate_identity: catalog.candidate_identity,
        corpus: { fingerprint: corpus.fingerprint, file_count: corpus.files.length, chunk_count: corpus.chunks.length },
        scenario_count: scenarios.length
      },
      rows: []
    };
  }

  const rows = [];
  let modelFileVerified = null;
  for (const scenario of scenarios) {
    const baseline = await runRgBaseline({
      corpus,
      query: scenario.query,
      topK: catalog.defaults.top_k,
      command: rgCommand,
      commandRunner: rgCommandRunner
    });
    rows.push(toScoredRow(baseline, scenario, catalog.defaults.top_k));
  }

  if (!baselineOnly) {
    if (!candidateRunner) {
      if (!harnessRoot || !endpoint) {
        throw new Error('--harness-root and --endpoint are required for candidate runs');
      }
      assertLoopbackEndpoint(endpoint);
      if (!modelFile) throw new Error('--model-file is required for candidate runs');
      modelFileVerified = await verifyCandidateModelFile({
        modelFile,
        identity: catalog.candidate_identity
      });
      candidateRunner = (scenario) => runCandidateProcess({
        scenario,
        catalog,
        catalogPath: resolvedCatalog,
        fixtureRoot: resolvedFixture,
        harnessRoot,
        endpoint,
        model,
        uvCommand
      });
    }
    for (const scenario of scenarios) {
      let candidate;
      try {
        candidate = validateCandidateResult(await candidateRunner(scenario), {
          scenarioId: scenario.id,
          privacyCanaries: catalog.defaults.privacy_canaries,
          allowedChunkIds: new Set(corpus.chunks.map((chunk) => chunk.chunk_id)),
          topK: catalog.defaults.top_k
        });
      } catch {
        candidate = {
          schema: 'aifhub.t_search.ab_candidate.v1',
          scenario_id: scenario.id,
          variant: 'candidate_t_search',
          status: 'FAIL',
          ranked_chunk_ids: [],
          privacy_passed: false,
          source_boundary_passed: false,
          freshness_passed: false,
          purge_passed: false,
          persistent_state_created: null,
          harness_provenance_passed: false,
          model_identity_passed: false,
          metrics: {},
          error_code: 'invalid_candidate_output'
        };
      }
      rows.push(toScoredRow({ ...candidate, variant: 'candidate_t_search' }, scenario, catalog.defaults.top_k));
    }
  }

  const selectedCatalog = { ...catalog, scenarios };
  const finalCorpus = await buildTSearchCorpus({ fixtureRoot: resolvedFixture });
  const summary = summarizeTSearchAb({
    catalog: selectedCatalog,
    corpus,
    rows,
    corpusUnchangedPassed: finalCorpus.fingerprint === corpus.fingerprint,
    modelFileVerified
  });
  if (outDir) await writeSanitizedResults({ outDir, summary, rows });
  return { summary, rows };
}

export async function runCandidateProcess({
  scenario,
  catalog,
  catalogPath,
  fixtureRoot,
  harnessRoot,
  endpoint,
  model,
  uvCommand = 'uv'
}) {
  const args = [
    'run', '--project', path.resolve(harnessRoot), '--python', '3.12', '--no-sync', '--offline',
    '--no-python-downloads', 'python', ADAPTER_PATH,
    '--catalog', catalogPath,
    '--scenario-id', scenario.id,
    '--fixture-root', fixtureRoot,
    '--harness-root', path.resolve(harnessRoot),
    '--harness-revision', T_SEARCH_HARNESS_REVISION,
    '--endpoint', endpoint,
    '--model', model,
    '--top-k', String(catalog.defaults.top_k),
    '--max-rounds', String(catalog.defaults.max_rounds),
    '--budget-tokens', String(catalog.defaults.budget_tokens),
    '--max-tokens-per-turn', String(catalog.defaults.max_tokens_per_turn),
    '--max-turns-per-round', String(catalog.defaults.max_turns_per_round),
    '--timeout-seconds', String(catalog.defaults.timeout_seconds),
    '--temperature', String(catalog.defaults.temperature),
    '--top-p', String(catalog.defaults.top_p)
  ];
  const tempParent = await realpath(os.tmpdir());
  const runRoot = await realpath(await mkdtemp(path.join(tempParent, 'aifhub-t-search-candidate-')));
  assertDescendant(tempParent, runRoot, 'candidate run directory');
  let cleanupPassed = false;
  let run;
  try {
    run = await runBoundedCommand(uvCommand, args, {
      cwd: runRoot,
      timeoutMs: catalog.defaults.timeout_seconds * 1000 + 30_000,
      maxOutputBytes: 512 * 1024,
      env: buildCandidateEnvironment()
    });
  } finally {
    try {
      await rm(runRoot, { recursive: true, force: true });
      cleanupPassed = true;
    } catch {
      cleanupPassed = false;
    }
  }
  let result = null;
  const jsonLine = run.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
  if (jsonLine) {
    try {
      result = JSON.parse(jsonLine);
    } catch {
      // Fall through to the bounded process-level result below.
    }
  }
  if (!result && run.exitCode !== 0) {
    result = {
      schema: 'aifhub.t_search.ab_candidate.v1',
      scenario_id: scenario.id,
      status: 'FAIL',
      ranked_chunk_ids: [],
      privacy_passed: null,
      source_boundary_passed: null,
      freshness_passed: null,
      purge_passed: null,
      persistent_state_created: null,
      harness_provenance_passed: null,
      model_identity_passed: null,
      metrics: { elapsed_ms: run.elapsedMs },
      error_code: run.timedOut
        ? 'candidate_timeout'
        : run.overflow ? 'candidate_output_limit' : 'candidate_process_failed'
    };
  }
  if (!cleanupPassed && result) {
    return {
      ...result,
      status: 'FAIL',
      purge_passed: false,
      persistent_state_created: true,
      error_code: 'candidate_sandbox_purge_failed'
    };
  }
  return result;
}

export async function runBoundedCommand(command, args, {
  cwd,
  timeoutMs = 30_000,
  maxOutputBytes = 1024 * 1024,
  env = process.env
} = {}) {
  const started = Date.now();
  return new Promise((resolve) => {
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let timedOut = false;
    let overflow = false;
    const child = spawn(command, args, {
      cwd,
      env,
      detached: process.platform !== 'win32',
      shell: false,
      windowsHide: true
    });
    const append = (current, chunk) => {
      const next = Buffer.concat([current, Buffer.from(chunk)]);
      if (next.length > maxOutputBytes) {
        if (!overflow) {
          overflow = true;
          killProcessTree(child);
        }
        return next.subarray(0, maxOutputBytes);
      }
      return next;
    };
    child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk); });
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child);
    }, timeoutMs);
    child.on('error', () => {
      clearTimeout(timer);
      resolve({ exitCode: null, stdout: '', stderr: '', timedOut, overflow, elapsedMs: Date.now() - started });
    });
    child.on('close', (exitCode) => {
      clearTimeout(timer);
      resolve({
        exitCode,
        stdout: stdout.toString('utf8'),
        stderr: stderr.toString('utf8'),
        timedOut,
        overflow,
        elapsedMs: Date.now() - started
      });
    });
  });
}

function killProcessTree(child) {
  if (!child?.pid) {
    child?.kill('SIGKILL');
    return;
  }
  if (process.platform !== 'win32') {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
    return;
  }
  const killed = spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
    windowsHide: true,
    shell: false,
    stdio: 'ignore',
    timeout: 5_000
  });
  if (killed.error || killed.status !== 0) child.kill('SIGKILL');
}

function toScoredRow(result, scenario, topK) {
  return {
    schema: 'aifhub.t_search.ab_row.v1',
    scenario_id: scenario.id,
    language: scenario.language,
    variant: result.variant,
    status: result.status,
    ranked_chunk_ids: stringArray(result.ranked_chunk_ids).slice(0, topK),
    score: scoreRanking(result.ranked_chunk_ids, scenario.ground_truth_chunk_ids, topK),
    privacy_passed: result.privacy_passed === true ? true : result.privacy_passed === false ? false : null,
    source_boundary_passed: result.source_boundary_passed === true ? true : result.source_boundary_passed === false ? false : null,
    freshness_passed: result.freshness_passed === true ? true : result.freshness_passed === false ? false : null,
    purge_passed: result.purge_passed === true ? true : result.purge_passed === false ? false : null,
    persistent_state_created: result.persistent_state_created === true
      ? true
      : result.persistent_state_created === false ? false : null,
    harness_provenance_passed: result.harness_provenance_passed === true
      ? true
      : result.harness_provenance_passed === false ? false : null,
    model_identity_passed: result.model_identity_passed === true
      ? true
      : result.model_identity_passed === false ? false : null,
    metrics: sanitizeMetrics(result.metrics),
    error_code: sanitizeCode(result.error_code)
  };
}

async function writeSanitizedResults({ outDir, summary, rows }) {
  const resolved = path.resolve(outDir);
  assertOutputBoundary(resolved);
  await mkdir(resolved, { recursive: true });
  await writeFile(path.join(resolved, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  await writeFile(path.join(resolved, 'rows.json'), `${JSON.stringify(rows, null, 2)}\n`, 'utf8');
}

async function walkCorpus(root, current, output) {
  const entries = await readdir(current, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name, 'en'));
  for (const entry of entries) {
    const absolute = path.join(current, entry.name);
    const relative = normalizeRelative(path.relative(root, absolute));
    const stats = await lstat(absolute);
    if (stats.isSymbolicLink()) throw new Error(`symlink is forbidden in T-Search corpus: ${relative}`);
    if (isExcludedCorpusPath(relative)) continue;
    if (entry.isDirectory()) {
      await walkCorpus(root, absolute, output);
    } else if (entry.isFile() && ALLOWED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      const canonical = await realpath(absolute);
      assertDescendant(root, canonical, 'corpus file');
      output.push({ relative_path: relative, absolute_path: canonical, bytes: 0, sha256: null });
    }
  }
}

function isExcludedCorpusPath(relativePath) {
  const normalized = normalizeRelative(relativePath);
  const parts = normalized.split('/');
  if (parts.some((part) => EXCLUDED_SEGMENTS.has(part))) return true;
  if (parts.some((part) => part === '.env' || part.startsWith('.env.'))) return true;
  return normalized === 'bootstrap/cache' || normalized.startsWith('bootstrap/cache/')
    || normalized === '.ai-factory/qa' || normalized.startsWith('.ai-factory/qa/')
    || normalized === '.ai-factory/state' || normalized.startsWith('.ai-factory/state/')
    || normalized === '.ai-factory/rules/generated' || normalized.startsWith('.ai-factory/rules/generated/');
}

function tokenizeQuery(query) {
  const values = String(query ?? '').toLocaleLowerCase('und').match(/[\p{L}\p{N}][\p{L}\p{N}_.-]*/gu) ?? [];
  return [...new Set(values.filter((value) => value.length >= 3 && !STOP_WORDS.has(value)))].slice(0, 24);
}

function buildCandidateEnvironment() {
  const allowed = ['APPDATA', 'LOCALAPPDATA', 'PATH', 'SystemRoot', 'TEMP', 'TMP', 'USERPROFILE', 'WINDIR'];
  const env = {};
  for (const key of allowed) if (process.env[key]) env[key] = process.env[key];
  env.NO_PROXY = '127.0.0.1,localhost,::1';
  env.no_proxy = env.NO_PROXY;
  env.PYTHONUTF8 = '1';
  return env;
}

function assertLoopbackEndpoint(endpoint) {
  let parsed;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new Error('candidate endpoint must be a valid URL');
  }
  if (parsed.protocol !== 'http:') throw new Error('candidate endpoint must use local HTTP');
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)) {
    throw new Error('candidate endpoint must be loopback-only');
  }
  if (!parsed.pathname.endsWith('/v1') && !parsed.pathname.endsWith('/v1/')) {
    throw new Error('candidate endpoint must target an OpenAI-compatible /v1 path');
  }
}

function assertOutputBoundary(resolvedOut) {
  const relative = normalizeRelative(path.relative(REPO_ROOT, resolvedOut));
  if (relative === '' || relative === '.') throw new Error('output directory cannot be the repository root');
  if (!relative.startsWith('../') && FORBIDDEN_OUTPUT_PREFIXES.some((prefix) => `${relative}/`.startsWith(prefix))) {
    throw new Error('output directory is inside a protected artifact boundary');
  }
}

function assertNoForbiddenCandidateKeys(value, pathParts = []) {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_CANDIDATE_KEYS.has(key.toLowerCase())) {
      throw new Error(`candidate output contains forbidden field: ${[...pathParts, key].join('.')}`);
    }
    assertNoForbiddenCandidateKeys(child, [...pathParts, key]);
  }
}

function sanitizeMetrics(metrics) {
  const source = objectValue(metrics);
  const numeric = [
    'elapsed_ms', 'search_calls', 'search_turns', 'rounds_completed', 'returned_count', 'query_term_count',
    'prompt_tokens', 'completion_tokens', 'total_tokens', 'finalize_calls'
  ];
  const output = Object.fromEntries(numeric
    .filter((key) => Number.isFinite(source[key]) && source[key] >= 0)
    .map((key) => [key, source[key]]));
  if (/^[a-z0-9_-]{1,64}$/.test(String(source.termination_reason ?? ''))) {
    output.termination_reason = source.termination_reason;
  }
  return output;
}

function sanitizeCode(value) {
  if (value == null) return null;
  return /^[a-z0-9_-]{1,96}$/.test(String(value)) ? String(value) : 'invalid_candidate_error_code';
}

function baselineFailure(errorCode, elapsedMs) {
  return {
    schema: 'aifhub.t_search.ab_variant.v1',
    variant: 'baseline_rg',
    status: 'FAIL',
    ranked_chunk_ids: [],
    privacy_passed: true,
    source_boundary_passed: true,
    freshness_passed: true,
    purge_passed: true,
    persistent_state_created: false,
    metrics: { elapsed_ms: elapsedMs },
    error_code: errorCode
  };
}

function safeId(value) {
  return /^[a-z0-9][a-z0-9-]*$/.test(String(value ?? ''));
}

function safeChunkId(value) {
  const text = String(value ?? '');
  if (!/^[A-Za-z0-9._/-]+#[a-z0-9-]+$/.test(text)) return false;
  const [relative] = text.split('#');
  return safeRelativePath(relative);
}

function safeRelativePath(value) {
  const normalized = normalizeRelative(String(value ?? ''));
  return Boolean(normalized) && normalized !== '.' && !normalized.startsWith('../') && !path.isAbsolute(normalized)
    && !normalized.includes('/../') && !/^[A-Za-z]:/.test(normalized) && !normalized.startsWith('//');
}

function normalizeRelative(value) {
  return String(value ?? '').replaceAll('\\', '/').replace(/^\.\//, '');
}

function fromPosix(value) {
  return String(value).split('/').join(path.sep);
}

function assertDescendant(root, target, label) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${label} must be a strict descendant of the corpus root`);
  }
}

function looksLikeAbsolutePath(value) {
  return /(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/]|\/(?:home|Users|tmp|var)\/)/.test(String(value));
}

function containsCanary(value, canaries) {
  const text = String(value ?? '');
  return canaries.some((canary) => text.includes(canary));
}

function objectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function stringArray(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [];
}

function positiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function hashFileSha256(file) {
  return new Promise((resolve, reject) => {
    const digest = createHash('sha256');
    const stream = createReadStream(file);
    stream.on('data', (chunk) => digest.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(digest.digest('hex')));
  });
}

function round(value) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function average(values) {
  if (values.length === 0) return 0;
  return round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function aggregateBooleanGate(rows, key) {
  const observed = rows.map((row) => row[key]).filter((value) => typeof value === 'boolean');
  if (observed.length === 0) return null;
  if (observed.length !== rows.length) return false;
  return observed.every((value) => value === true);
}

function aggregatePurgeGate(rows) {
  const observed = rows.filter(
    (row) => typeof row.purge_passed === 'boolean' && typeof row.persistent_state_created === 'boolean'
  );
  if (observed.length === 0) return null;
  if (observed.length !== rows.length) return false;
  return observed.every((row) => row.purge_passed === true && row.persistent_state_created === false);
}

function aggregatePersistentState(rows) {
  const observed = rows.map((row) => row.persistent_state_created).filter((value) => typeof value === 'boolean');
  if (observed.length === 0) return null;
  if (observed.some((value) => value === true)) return true;
  return observed.length === rows.length ? false : null;
}

function averageScore(rows, key) {
  const values = rows.map((row) => row.score?.[key]).filter(Number.isFinite);
  return values.length > 0 ? average(values) : null;
}

function sumMetric(rows, key) {
  const values = rows.map((row) => row.metrics?.[key]).filter(Number.isFinite);
  return values.length > 0 ? round(values.reduce((sum, value) => sum + value, 0)) : null;
}

function parseArgs(args) {
  const parsed = { scenarioIds: [] };
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === '--catalog') parsed.catalogPath = args[++index];
    else if (token === '--fixture-root') parsed.fixtureRoot = args[++index];
    else if (token === '--out') parsed.outDir = args[++index];
    else if (token === '--harness-root') parsed.harnessRoot = args[++index];
    else if (token === '--model-file') parsed.modelFile = args[++index];
    else if (token === '--endpoint') parsed.endpoint = args[++index];
    else if (token === '--model') parsed.model = args[++index];
    else if (token === '--uv') parsed.uvCommand = args[++index];
    else if (token === '--rg') parsed.rgCommand = args[++index];
    else if (token === '--scenario') parsed.scenarioIds.push(args[++index]);
    else if (token === '--max-scenarios') parsed.maxScenarios = Number(args[++index]);
    else if (token === '--baseline-only') parsed.baselineOnly = true;
    else if (token === '--dry-run') parsed.dryRun = true;
    else if (token === '--json') parsed.json = true;
    else if (token === '--help' || token === '-h') parsed.help = true;
    else throw new Error(`unknown option: ${token}`);
  }
  return parsed;
}

function usage() {
  return [
    'Usage: node scripts/t-search-ab-benchmark.mjs [options]',
    '',
    '  --dry-run                 Validate the bounded corpus and scenario catalog only.',
    '  --baseline-only           Run the rg side without a model endpoint.',
    '  --harness-root <dir>      Exact pinned t-search-harness source checkout.',
    '  --model-file <gguf>       Exact pinned Q4_K_M file outside the repository.',
    '  --endpoint <loopback/v1>  Local OpenAI-compatible T-Search endpoint.',
    '  --out <dir>               Write sanitized summary.json and rows.json.',
    '  --scenario <id>           Select one scenario; repeatable.',
    '  --max-scenarios <n>       Bound the selected scenario prefix.',
    '  --json                     Print the sanitized summary as JSON.'
  ].join('\n');
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const result = await runTSearchAbBenchmark(parsed);
  process.stdout.write(parsed.json ? `${JSON.stringify(result.summary, null, 2)}\n` : `${result.summary.pilot_decision ?? 'dry_run'}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`[t-search-ab] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  });
}
