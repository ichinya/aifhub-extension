import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  T_SEARCH_AB_CATALOG_SCHEMA,
  T_SEARCH_HARNESS_REVISION,
  buildTSearchCorpus,
  loadTSearchAbCatalog,
  parseMarkedChunks,
  runRgBaseline,
  runTSearchAbBenchmark,
  scoreRanking,
  summarizeTSearchAb,
  validateCandidateResult,
  validateTSearchAbCatalog,
  verifyCandidateModelFile
} from './t-search-ab-benchmark.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CATALOG = path.join(REPO_ROOT, 'docs', 'memory-tools-research', 't-search-ab-scenarios.json');
const FIXTURE = path.join(REPO_ROOT, 'test', 'fixtures', 't-search-evaluation', 'project');
const ADAPTER = path.join(REPO_ROOT, 'scripts', 't-search-ab-adapter.py');
const NO_MATCH_RG_COMMAND_RUNNER = async () => ({
  exitCode: 1,
  stdout: '',
  stderr: '',
  timedOut: false,
  overflow: false,
  elapsedMs: 1
});

describe('T-Search A/B scenario catalog', () => {
  it('pins a bilingual, non-promotable paired pilot', async () => {
    const { catalog } = await loadTSearchAbCatalog({ catalogPath: CATALOG });
    assert.equal(catalog.schema, T_SEARCH_AB_CATALOG_SCHEMA);
    assert.deepEqual(catalog.defaults.variants, ['baseline_rg', 'candidate_t_search']);
    assert.equal(catalog.defaults.no_promote, true);
    assert.equal(catalog.defaults.profile, 'local_gguf_q4_reduced_context');
    assert.equal(catalog.defaults.server_context_tokens, 8192);
    assert.equal(catalog.defaults.temperature, 0.7);
    assert.equal(catalog.defaults.top_p, 1);
    assert.equal(catalog.candidate_identity.model_revision, '5e5a39987b20533c6bf09ca10d3c0c6e81eae067');
    assert.equal(catalog.candidate_identity.model_size_bytes, 21713463136);
    assert.equal(catalog.candidate_identity.model_sha256, 'f645dce898117a1f9165dfbb014d61e5f09daec06bb64f4b91de7f103b8761bb');
    assert.equal(catalog.candidate_identity.harness_revision, T_SEARCH_HARNESS_REVISION);
    assert.equal(catalog.candidate_identity.llama_cpp_build, 10068);
    assert.equal(catalog.candidate_identity.llama_cpp_revision, '571d0d540df04f25298d0e159e520d9fc62ed121');
    assert.ok(catalog.scenarios.length >= 6);
    assert.deepEqual(new Set(catalog.scenarios.map((scenario) => scenario.language)), new Set(['en', 'ru']));
    assert.deepEqual(validateTSearchAbCatalog(catalog), []);
  });

  it('rejects duplicate ids, unsafe truth paths and canaries in model queries', async () => {
    const { catalog } = await loadTSearchAbCatalog({ catalogPath: CATALOG });
    const invalid = structuredClone(catalog);
    invalid.scenarios[1].id = invalid.scenarios[0].id;
    invalid.scenarios[2].ground_truth_chunk_ids = ['../../private#c001'];
    invalid.scenarios[3].query = `leak ${invalid.defaults.privacy_canaries[0]}`;
    const errors = validateTSearchAbCatalog(invalid).join('\n');
    assert.match(errors, /duplicates/);
    assert.match(errors, /unsafe ids/);
    assert.match(errors, /privacy canary/);
  });
});

describe('T-Search bounded synthetic corpus', () => {
  it('builds stable marked chunks while excluding env, QA and vendor canaries', async () => {
    const { catalog } = await loadTSearchAbCatalog({ catalogPath: CATALOG });
    const corpus = await buildTSearchCorpus({ fixtureRoot: FIXTURE });
    assert.equal(corpus.chunks.length, 30);
    assert.ok(corpus.files.length >= 20);
    assert.match(corpus.fingerprint, /^sha256:[0-9a-f]{64}$/);
    assert.ok(corpus.chunks.some((chunk) => chunk.chunk_id === 'src/auth/session-guard.ts#c001'));
    assert.ok(corpus.chunks.some((chunk) => chunk.chunk_id === 'openspec/specs/provider-privacy/spec.md#c011'));
    const serialized = JSON.stringify(corpus.chunks);
    for (const canary of catalog.defaults.privacy_canaries) assert.doesNotMatch(serialized, new RegExp(canary));
    assert.equal(corpus.files.some((file) => file.relative_path.includes('.ai-factory/qa')), false);
    assert.equal(corpus.files.some((file) => file.relative_path.includes('vendor/')), false);
    assert.equal(corpus.files.some((file) => file.relative_path.endsWith('.env')), false);
  });

  it('parses source and Markdown markers into line-bound stable ids', () => {
    const chunks = parseMarkedChunks('sample.ts', '// chunk: one\nconst a = 1;\n// chunk: two\nconst b = 2;\n');
    assert.deepEqual(chunks.map((chunk) => chunk.chunk_id), ['sample.ts#one', 'sample.ts#two']);
    assert.deepEqual(chunks.map((chunk) => [chunk.start_line, chunk.end_line]), [[2, 2], [4, 5]]);
    assert.throws(() => parseMarkedChunks('unmarked.md', '# no marker'), /no chunk markers/);
  });

  it('accepts marked PHP and Vue sources for Laravel project pilots', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 't-search-laravel-corpus-test-'));
    try {
      await writeFile(path.join(root, 'Example.php'), '// chunk: php-source\n<?php final class Example {}\n');
      await writeFile(path.join(root, 'Panel.vue'), '<!-- chunk: vue-source -->\n<template><main>Panel</main></template>\n');
      await mkdir(path.join(root, 'storage', 'framework'), { recursive: true });
      await writeFile(path.join(root, 'storage', 'framework', 'private.php'), '// chunk: private-storage\nsecret\n');
      await mkdir(path.join(root, 'bootstrap', 'cache'), { recursive: true });
      await writeFile(path.join(root, 'bootstrap', 'cache', 'services.php'), '// chunk: generated-cache\nsecret\n');
      const corpus = await buildTSearchCorpus({ fixtureRoot: root });
      assert.deepEqual(corpus.chunks.map((chunk) => chunk.chunk_id), [
        'Example.php#php-source',
        'Panel.vue#vue-source'
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('T-Search rg baseline and scoring', () => {
  it('runs one bounded rg search and returns only eligible chunk ids', async () => {
    const { catalog } = await loadTSearchAbCatalog({ catalogPath: CATALOG });
    const corpus = await buildTSearchCorpus({ fixtureRoot: FIXTURE });
    const scenario = catalog.scenarios.find((item) => item.id === 'order-status-audit-path');
    const target = corpus.chunks.find((chunk) => chunk.chunk_id === 'src/orders/status-service.ts#c012');
    let invocation;
    const result = await runRgBaseline({
      corpus,
      query: scenario.query,
      topK: catalog.defaults.top_k,
      commandRunner: async (command, args, options) => {
        invocation = { command, args, options };
        return {
          exitCode: 0,
          stdout: `${JSON.stringify({
            type: 'match',
            data: {
              path: { text: target.relative_path },
              lines: { text: target.content },
              line_number: target.start_line,
              submatches: [{ start: 0, end: 1 }]
            }
          })}\n`,
          stderr: '',
          timedOut: false,
          overflow: false,
          elapsedMs: 1
        };
      }
    });
    assert.equal(result.status, 'PASS');
    assert.equal(result.metrics.search_calls, 1);
    assert.ok(result.ranked_chunk_ids.includes('src/orders/status-service.ts#c012'));
    assert.ok(result.ranked_chunk_ids.every((chunkId) => corpus.chunks.some((chunk) => chunk.chunk_id === chunkId)));
    assert.equal(invocation.command, 'rg');
    assert.equal(invocation.options.cwd, corpus.root);
    assert.ok(invocation.args.includes('--json'));
    assert.ok(invocation.args.includes(target.relative_path));
  });

  it('computes bounded Recall@10, precision and reciprocal rank', () => {
    assert.deepEqual(scoreRanking(['a.md#x', 'b.md#x', 'c.md#x'], ['b.md#x', 'z.md#x']), {
      recall_at_10: 0.5,
      precision_at_10: 0.333333,
      false_positive_rate: 0.666667,
      reciprocal_rank: 0.5,
      relevant_found: 1,
      relevant_total: 2
    });
  });
});

describe('T-Search candidate output boundary', () => {
  it('verifies a candidate model by exact external filename, size and SHA-256', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 't-search-model-test-'));
    const modelFile = path.join(root, 'fixture.gguf');
    const bytes = Buffer.from('bounded synthetic model fixture');
    try {
      await writeFile(modelFile, bytes);
      const identity = {
        model_file: 'fixture.gguf',
        model_size_bytes: bytes.length,
        model_sha256: createHash('sha256').update(bytes).digest('hex')
      };
      assert.equal(await verifyCandidateModelFile({ modelFile, identity }), true);
      await writeFile(modelFile, Buffer.from('drift'));
      await assert.rejects(verifyCandidateModelFile({ modelFile, identity }), /size mismatch/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('accepts aggregate-only rows and rejects snippets, transcripts, canaries and absolute paths', async () => {
    const { catalog } = await loadTSearchAbCatalog({ catalogPath: CATALOG });
    const corpus = await buildTSearchCorpus({ fixtureRoot: FIXTURE });
    const safe = makeCandidate(catalog.scenarios[0]);
    assert.equal(validateCandidateResult(safe, {
      scenarioId: safe.scenario_id,
      privacyCanaries: catalog.defaults.privacy_canaries,
      allowedChunkIds: new Set(corpus.chunks.map((chunk) => chunk.chunk_id)),
      topK: catalog.defaults.top_k
    }), safe);
    assert.throws(() => validateCandidateResult({ ...safe, messages: [] }, { scenarioId: safe.scenario_id }), /forbidden field/);
    assert.throws(() => validateCandidateResult({ ...safe, note: 'C:\\private\\trace.json' }, { scenarioId: safe.scenario_id }), /absolute path/);
    assert.throws(() => validateCandidateResult({ ...safe, note: catalog.defaults.privacy_canaries[0] }, {
      scenarioId: safe.scenario_id,
      privacyCanaries: catalog.defaults.privacy_canaries
    }), /privacy canary/);
    assert.throws(() => validateCandidateResult({
      ...safe,
      ranked_chunk_ids: ['outside.md#c999']
    }, {
      scenarioId: safe.scenario_id,
      allowedChunkIds: new Set(corpus.chunks.map((chunk) => chunk.chunk_id))
    }), /escaped the bounded corpus/);
  });

  it('pins harness source digests and never serializes the complete RetrievalResult', async () => {
    const adapter = await readFile(ADAPTER, 'utf8');
    assert.match(adapter, new RegExp(T_SEARCH_HARNESS_REVISION));
    assert.match(adapter, /EXPECTED_HARNESS_FILES/);
    assert.match(adapter, /EXPECTED_HARNESS_TREE_DIGEST/);
    assert.match(adapter, /"\.php"/);
    assert.match(adapter, /"\.vue"/);
    assert.match(adapter, /"storage"/);
    assert.match(adapter, /"bootstrap\/cache"/);
    assert.doesNotMatch(adapter, /result\.to_dict\s*\(/);
    assert.match(adapter, /privacy_passed = not contains_private_material/);
    assert.match(adapter, /endpoint_not_loopback_http/);
    assert.match(adapter, /endpoint_model_identity_mismatch/);
    const runner = await readFile(path.join(REPO_ROOT, 'scripts', 't-search-ab-benchmark.mjs'), 'utf8');
    assert.match(runner, /taskkill\.exe/);
    assert.match(runner, /process\.kill\(-child\.pid, 'SIGKILL'\)/);
    assert.match(runner, /'--no-sync', '--offline'/);
    assert.match(runner, /'--no-python-downloads'/);
    assert.match(runner, /aifhub-t-search-candidate-/);
    assert.match(runner, /candidate_sandbox_purge_failed/);
  });
});

describe('T-Search paired pilot decisions', () => {
  it('keeps unexecuted candidate safety gates unknown in a baseline-only run', async () => {
    const result = await runTSearchAbBenchmark({
      catalogPath: CATALOG,
      fixtureRoot: FIXTURE,
      baselineOnly: true,
      maxScenarios: 1,
      rgCommandRunner: NO_MATCH_RG_COMMAND_RUNNER
    });
    assert.equal(result.summary.pilot_decision, 'not_run');
    assert.equal(result.summary.privacy_passed, null);
    assert.equal(result.summary.freshness_passed, null);
    assert.equal(result.summary.purge_passed, null);
    assert.equal(result.summary.persistent_state_created, null);
    assert.equal(result.summary.pairs[0].candidate_recall_at_10, null);
  });

  it('records a synthetic all-pass candidate as pilot-positive without promoting policy', async () => {
    const result = await runTSearchAbBenchmark({
      catalogPath: CATALOG,
      fixtureRoot: FIXTURE,
      rgCommandRunner: NO_MATCH_RG_COMMAND_RUNNER,
      candidateRunner: async (scenario) => makeCandidate(scenario)
    });
    assert.equal(result.summary.pilot_decision, 'pilot_positive');
    assert.equal(result.summary.policy_decision, 'reject_defer');
    assert.equal(result.summary.no_promote, true);
    assert.equal(result.summary.pair_count, 6);
    assert.equal(result.summary.candidate_average_recall_at_10, 1);
    assert.equal(result.summary.candidate_average_false_positive_rate, 0);
    assert.equal(result.summary.candidate_total_tokens, 720);
    assert.equal(result.summary.privacy_passed, true);
    assert.equal(result.summary.freshness_passed, true);
    assert.equal(result.summary.purge_passed, true);
    assert.equal(result.summary.persistent_state_created, false);
    assert.equal(result.summary.harness_provenance_passed, true);
    assert.equal(result.summary.model_identity_passed, true);
    assert.equal(result.summary.corpus_unchanged_passed, true);
  });

  it('does not call a recall gain positive when false-positive rate gets worse', async () => {
    const result = await runTSearchAbBenchmark({
      catalogPath: CATALOG,
      fixtureRoot: FIXTURE,
      rgCommandRunner: NO_MATCH_RG_COMMAND_RUNNER,
      candidateRunner: async (scenario) => ({
        ...makeCandidate(scenario),
        ranked_chunk_ids: [
          ...scenario.ground_truth_chunk_ids,
          'src/cache/refresh.ts#c021',
          'src/billing/invoice.ts#c023',
          'src/security/csrf.ts#c025',
          'src/dashboard/view.ts#c030'
        ].slice(0, 10)
      })
    });

    assert.equal(result.summary.candidate_average_recall_at_10, 1);
    assert.ok(
      result.summary.candidate_average_false_positive_rate
        > result.summary.baseline_average_false_positive_rate
    );
    assert.equal(result.summary.pilot_decision, 'pilot_negative');
    assert.equal(result.summary.policy_decision, 'reject_defer');
  });

  it('lets an explicit privacy failure veto retrieval quality', async () => {
    const { catalog } = await loadTSearchAbCatalog({ catalogPath: CATALOG });
    const corpus = await buildTSearchCorpus({ fixtureRoot: FIXTURE });
    const rows = catalog.scenarios.flatMap((scenario) => [
      makeScoredRow(scenario, 'baseline_rg', true),
      makeScoredRow(scenario, 'candidate_t_search', scenario.id !== catalog.scenarios[0].id)
    ]);
    const summary = summarizeTSearchAb({ catalog, corpus, rows });
    assert.equal(summary.pilot_decision, 'forbid');
    assert.equal(summary.policy_decision, 'reject_defer');
  });

  it('lets a lifecycle failure veto retrieval quality', async () => {
    const { catalog } = await loadTSearchAbCatalog({ catalogPath: CATALOG });
    const corpus = await buildTSearchCorpus({ fixtureRoot: FIXTURE });
    const rows = catalog.scenarios.flatMap((scenario, index) => [
      makeScoredRow(scenario, 'baseline_rg', true),
      {
        ...makeScoredRow(scenario, 'candidate_t_search', true),
        purge_passed: index !== 0,
        persistent_state_created: index === 0
      }
    ]);
    const summary = summarizeTSearchAb({ catalog, corpus, rows });
    assert.equal(summary.pilot_decision, 'forbid');
    assert.equal(summary.purge_passed, false);
    assert.equal(summary.persistent_state_created, true);
  });

  it('refuses a non-loopback model endpoint before candidate execution', async () => {
    await assert.rejects(runTSearchAbBenchmark({
      catalogPath: CATALOG,
      fixtureRoot: FIXTURE,
      maxScenarios: 1,
      harnessRoot: os.tmpdir(),
      endpoint: 'https://example.com/v1',
      rgCommandRunner: NO_MATCH_RG_COMMAND_RUNNER
    }), /local HTTP|loopback-only/);
  });

  it('writes only sanitized aggregate rows when an output directory is explicit', async () => {
    const out = await mkdtemp(path.join(os.tmpdir(), 't-search-ab-test-'));
    try {
      const result = await runTSearchAbBenchmark({
        catalogPath: CATALOG,
        fixtureRoot: FIXTURE,
        maxScenarios: 1,
        outDir: out,
        rgCommandRunner: NO_MATCH_RG_COMMAND_RUNNER,
        candidateRunner: async (scenario) => makeCandidate(scenario)
      });
      const summary = await readFile(path.join(out, 'summary.json'), 'utf8');
      const rows = await readFile(path.join(out, 'rows.json'), 'utf8');
      assert.equal(JSON.parse(summary).schema, result.summary.schema);
      for (const forbidden of ['messages', 'all_round_messages', 'snippet', 'TSEARCH_PRIVATE_CANARY']) {
        assert.doesNotMatch(rows, new RegExp(forbidden));
      }
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });
});

function makeCandidate(scenario) {
  return {
    schema: 'aifhub.t_search.ab_candidate.v1',
    scenario_id: scenario.id,
    status: 'PASS',
    ranked_chunk_ids: [...scenario.ground_truth_chunk_ids],
    privacy_passed: true,
    source_boundary_passed: true,
    freshness_passed: true,
    purge_passed: true,
    persistent_state_created: false,
    harness_provenance_passed: true,
    model_identity_passed: true,
    metrics: {
      elapsed_ms: 10,
      search_calls: 3,
      search_turns: 3,
      rounds_completed: 1,
      returned_count: scenario.ground_truth_chunk_ids.length,
      prompt_tokens: 100,
      completion_tokens: 20,
      total_tokens: 120,
      finalize_calls: 1,
      termination_reason: 'finalized'
    },
    error_code: null
  };
}

function makeScoredRow(scenario, variant, privacyPassed) {
  return {
    schema: 'aifhub.t_search.ab_row.v1',
    scenario_id: scenario.id,
    language: scenario.language,
    variant,
    status: 'PASS',
    ranked_chunk_ids: [...scenario.ground_truth_chunk_ids],
    score: scoreRanking(scenario.ground_truth_chunk_ids, scenario.ground_truth_chunk_ids),
    privacy_passed: privacyPassed,
    source_boundary_passed: true,
    freshness_passed: true,
    purge_passed: true,
    persistent_state_created: false,
    metrics: {},
    error_code: privacyPassed ? null : 'privacy_canary_exposed'
  };
}
