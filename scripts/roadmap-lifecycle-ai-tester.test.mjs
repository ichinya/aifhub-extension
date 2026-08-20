// roadmap-lifecycle-ai-tester.test.mjs - sanitized paired workflow evaluation contracts
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  ROADMAP_LIFECYCLE_CONDITIONS,
  buildRoadmapLifecycleInvocation,
  buildRoadmapLifecycleAggregate,
  buildRoadmapLifecycleMatrix,
  cleanupRoadmapLifecycleTempOutput,
  generateRoadmapLifecycleMatrix,
  loadRoadmapLifecycleCatalog,
  renderRoadmapLifecycleMarkdown,
  validateRoadmapLifecycleCatalog
} from './roadmap-lifecycle-ai-tester.mjs';

let tempDir;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'roadmap-lifecycle-ai-tester-'));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

const PROVENANCE = Object.freeze({
  ai_tester_source_commit: '98dd5afb3fe9b9b7593d21dc93bcbc6d98c2cca9',
  ai_tester_binary_sha256: '5e99619cc5fc6734d17a6c08d94520355abf444626c5a68591c3608423f9924d',
  ai_tester_version: 'ai-tester 1.1.0',
  codex_version: 'codex-cli 0.144.6',
  reasoning_enforcement: 'codex_wrapper_model_reasoning_effort_low'
});

describe('roadmap lifecycle ai-tester catalog', () => {
  it('pins five sanitized paired scenarios and Luna low settings', async () => {
    const catalog = await loadRoadmapLifecycleCatalog({ cwd: process.cwd() });
    assert.equal(catalog.defaults.runtime, 'codex');
    assert.equal(catalog.defaults.model, 'gpt-5.6-luna');
    assert.equal(catalog.defaults.reasoning, 'low');
    assert.deepEqual(catalog.defaults.conditions, ROADMAP_LIFECYCLE_CONDITIONS);
    assert.deepEqual(catalog.scenarios.map((item) => item.id), [
      'issue-linked-planning',
      'successful-done',
      'failed-done-no-roadmap-write',
      'finalized-state-commit-blocking',
      'post-merge-github-reconciliation'
    ]);
    assert.deepEqual(validateRoadmapLifecycleCatalog(catalog), []);
    assert.doesNotMatch(JSON.stringify(catalog), /[A-Za-z]:\\Users\\|BEGIN (?:RSA |OPENSSH )?PRIVATE KEY|authorization:/i);
  });

  it('rejects incomplete pairing, private-looking text, and weak assertions', async () => {
    const catalog = await loadRoadmapLifecycleCatalog({ cwd: process.cwd() });
    const invalid = structuredClone(catalog);
    invalid.defaults.conditions = ['refined'];
    invalid.scenarios[0].user_prompt = 'token=secret-value';
    invalid.scenarios[0].assertions = [];
    const errors = validateRoadmapLifecycleCatalog(invalid);
    assert.ok(errors.some((item) => item.includes('defaults.conditions')));
    assert.ok(errors.some((item) => item.includes('private-looking material')));
    assert.ok(errors.some((item) => item.includes('assertions')));
  });
});

describe('roadmap lifecycle ai-tester matrix', () => {
  it('builds symmetric baseline/refined rows with complete execution fingerprints', async () => {
    const catalog = await loadRoadmapLifecycleCatalog({ cwd: process.cwd() });
    const matrix = buildRoadmapLifecycleMatrix({
      catalog,
      provenance: PROVENANCE,
      runId: 'issue-88-luna-low-test',
      generatedAt: '2026-08-12T00:00:00.000Z'
    });
    assert.equal(matrix.rows.length, 10);
    assert.equal(new Set(matrix.rows.map((row) => row.id)).size, 10);
    for (const scenario of catalog.scenarios) {
      const pair = matrix.rows.filter((row) => row.scenario_id === scenario.id);
      assert.deepEqual(pair.map((row) => row.condition), ROADMAP_LIFECYCLE_CONDITIONS);
      assert.equal(new Set(pair.map((row) => row.settings_fingerprint)).size, 1);
      assert.equal(new Set(pair.map((row) => row.scenario_fingerprint)).size, 2);
      assert.ok(pair.every((row) => /^[a-f0-9]{64}$/.test(row.scenario_fingerprint)));
      assert.ok(pair.every((row) => row.model === 'gpt-5.6-luna' && row.reasoning === 'low'));
    }
  });

  it('writes only sanitized generated prompts/scenarios and validates dry-run without writes', async () => {
    const outDir = path.join(tempDir, 'matrix');
    const generated = await generateRoadmapLifecycleMatrix({
      outDir,
      provenance: PROVENANCE,
      runId: 'issue-88-luna-low-test',
      cwd: process.cwd()
    });
    assert.equal(generated.matrix.rows.length, 10);
    const yaml = await readFile(path.join(outDir, generated.matrix.rows[0].scenario_file), 'utf8');
    assert.match(yaml, /model: "gpt-5\.6-luna"/);
    assert.match(yaml, /reasoning: "low"/);
    assert.match(yaml, /type: no_tool_called/);
    assert.match(yaml, /type: output_contains/);
    assert.doesNotMatch(yaml, /C:\\projects|finalOutput|authorization/i);

    const dryRunDir = path.join(tempDir, 'dry-run');
    const dryRun = await generateRoadmapLifecycleMatrix({
      outDir: dryRunDir,
      provenance: PROVENANCE,
      runId: 'issue-88-luna-low-test',
      cwd: process.cwd(),
      dryRun: true
    });
    assert.equal(dryRun.dry_run, true);
    await assert.rejects(access(dryRunDir));
  });

  it('builds exact live and dry-run invocations with pinned settings', async () => {
    const catalog = await loadRoadmapLifecycleCatalog({ cwd: process.cwd() });
    const matrix = buildRoadmapLifecycleMatrix({
      catalog,
      provenance: PROVENANCE,
      runId: 'issue-88-luna-low-test'
    });
    const live = buildRoadmapLifecycleInvocation(matrix.rows[0], { matrixDir: tempDir });
    const dryRun = buildRoadmapLifecycleInvocation(matrix.rows[0], { matrixDir: tempDir, dryRun: true });
    assert.deepEqual(live.args.slice(0, 7), [
      'run', '--file', path.join(tempDir, matrix.rows[0].scenario_file),
      '--runtime', 'codex', '--model', 'gpt-5.6-luna'
    ]);
    assert.ok(live.args.includes('low'));
    assert.ok(live.args.includes(`^${matrix.rows[0].id}$`));
    assert.equal(live.args.includes('--dry-run'), false);
    assert.equal(dryRun.args.at(-1), '--dry-run');
  });

  it('cleans only verified descendants of the operating-system temp directory', async () => {
    const cleanupRoot = path.join(tempDir, 'raw-run');
    await generateRoadmapLifecycleMatrix({
      outDir: cleanupRoot,
      provenance: PROVENANCE,
      runId: 'issue-88-luna-low-test',
      cwd: process.cwd()
    });
    await cleanupRoadmapLifecycleTempOutput(cleanupRoot, process.cwd());
    await assert.rejects(access(cleanupRoot));
    await assert.rejects(
      cleanupRoadmapLifecycleTempOutput(path.join(process.cwd(), 'unsafe-cleanup-target'), process.cwd()),
      /cleanup_target_not_temp_descendant/
    );
  });
});

describe('roadmap lifecycle aggregate', () => {
  it('records bounded pass/fail and token totals without retaining raw trace content', async () => {
    const catalog = await loadRoadmapLifecycleCatalog({ cwd: process.cwd() });
    const matrix = buildRoadmapLifecycleMatrix({
      catalog,
      provenance: PROVENANCE,
      runId: 'issue-88-luna-low-test',
      generatedAt: '2026-08-12T00:00:00.000Z'
    });
    const traces = matrix.rows.map((row, index) => fakeTrace(row, {
      pass: row.condition === 'refined' || index === 0,
      input: 100 + index,
      output: 10 + index
    }));
    traces[0].finalOutput = 'PRIVATE_TRANSCRIPT_SENTINEL';
    traces[0].runner.sandboxPath = 'C:\\Users\\private\\sandbox';

    const aggregate = buildRoadmapLifecycleAggregate({
      matrix,
      traces,
      reasoningProof: matrix.rows.map(() => ({ phase: 'initial', profile: 'low' })),
      generatedAt: '2026-08-12T01:00:00.000Z'
    });
    assert.equal(aggregate.summary.runs, 10);
    assert.deepEqual(aggregate.summary.by_condition.baseline, { pass: 1, fail: 4, not_run: 0 });
    assert.deepEqual(aggregate.summary.by_condition.refined, { pass: 5, fail: 0, not_run: 0 });
    assert.equal(aggregate.results[0].tokens.total, 110);
    assert.ok(aggregate.results.every((row) => row.reasoning_proof === 'PASS'));
    assert.ok(aggregate.results[2].failed_assertion_ids.length > 0);
    const serialized = JSON.stringify(aggregate);
    assert.doesNotMatch(serialized, /PRIVATE_TRANSCRIPT_SENTINEL|C:\\Users\\private|finalOutput|sandboxPath/);

    const markdown = renderRoadmapLifecycleMarkdown(aggregate);
    assert.match(markdown, /gpt-5\.6-luna/);
    assert.match(markdown, /issue-linked-planning/);
    assert.match(markdown, /Baseline.*1.*4/s);
    assert.doesNotMatch(markdown, /PRIVATE_TRANSCRIPT_SENTINEL|C:\\Users\\private/);
  });

  it('marks mismatched runtime settings and missing proof as NOT_RUN', async () => {
    const catalog = await loadRoadmapLifecycleCatalog({ cwd: process.cwd() });
    const matrix = buildRoadmapLifecycleMatrix({
      catalog,
      provenance: PROVENANCE,
      runId: 'issue-88-luna-low-test'
    });
    const traces = matrix.rows.map((row) => fakeTrace(row));
    traces[0].runner.model = 'unexpected-model';
    const aggregate = buildRoadmapLifecycleAggregate({
      matrix,
      traces,
      reasoningProof: []
    });
    assert.equal(aggregate.results[0].status, 'NOT_RUN');
    assert.equal(aggregate.results[0].reason, 'runtime_settings_mismatch');
    assert.ok(aggregate.results.slice(1).every((row) => row.status === 'NOT_RUN'));
    assert.ok(aggregate.results.slice(1).every((row) => row.reason === 'reasoning_profile_unproven'));
  });

  it('keeps committed bounded results current with the sanitized scenario catalog', async () => {
    const catalog = await loadRoadmapLifecycleCatalog({ cwd: process.cwd() });
    const resultsPath = path.join(
      process.cwd(),
      'docs',
      'roadmap-lifecycle-ai-tester',
      'results.json'
    );
    const markdownPath = path.join(
      process.cwd(),
      'docs',
      'roadmap-lifecycle-ai-tester',
      'results.md'
    );
    const results = JSON.parse(await readFile(resultsPath, 'utf8'));
    const matrix = buildRoadmapLifecycleMatrix({
      catalog,
      provenance: results.provenance,
      runId: results.run_id,
      generatedAt: results.generated_at
    });
    assert.equal(results.schema, 'aifhub.roadmap_lifecycle.ai_tester_results.v1');
    assert.equal(results.reasoning_enforcement.status, 'PASS');
    assert.equal(results.results.length, 10);
    assert.deepEqual(
      results.results.map((row) => row.scenario_fingerprint),
      matrix.rows.map((row) => row.scenario_fingerprint)
    );
    assert.ok(results.results.every((row) => Number.isSafeInteger(row.tokens.total)));
    assert.doesNotMatch(
      JSON.stringify(results),
      /finalOutput|sandboxPath|sessionId|toolCallSummary|[A-Za-z]:\\Users\\|authorization:/i
    );
    assert.equal(await readFile(markdownPath, 'utf8'), renderRoadmapLifecycleMarkdown(results));
  });
});

function fakeTrace(row, { pass = true, input = 100, output = 10 } = {}) {
  return {
    schemaVersion: '2.0.0',
    scenario: { name: row.id },
    runner: {
      runtime: row.runtime,
      model: row.model,
      reasoning: row.reasoning,
      turnsUsed: 1
    },
    assertions: row.assertions.map((assertion) => ({
      id: assertion.id,
      type: assertion.type,
      pass
    })),
    scoring: { overallPass: pass, allPassed: pass },
    cost: {
      inputTokens: input,
      outputTokens: output,
      cacheCreationTokens: 0,
      cacheReadTokens: 0
    },
    errors: []
  };
}
