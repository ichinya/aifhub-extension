import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  UNDERSTAND_ANYTHING_CATALOG_SCHEMA,
  UNDERSTAND_ANYTHING_MATRIX_SCHEMA,
  buildUnderstandAnythingMatrix,
  generateUnderstandAnythingMatrix,
  renderUnderstandAnythingAiTesterScenario,
  validateUnderstandAnythingScenarioCatalog
} from './understand-anything-ai-tester-matrix.mjs';

let tmpDir;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'ua-matrix-'));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

function catalog() {
  return {
    schema: UNDERSTAND_ANYTHING_CATALOG_SCHEMA,
    defaults: {
      runtime: 'codex',
      model: 'gpt-5.6-luna',
      reasoning: 'low',
      repetitions: 2,
      variants: ['baseline_rg', 'candidate_reviewed_graph'],
      timeout_seconds: 240,
      max_turns: 10,
      assertion_schema: 'aifhub.understand_anything.assertions.v1',
      provenance_class: 'synthetic_schema_fixture',
      no_promote: true
    },
    fixtures_root: 'fixtures',
    scenarios: ['architecture_onboarding', 'change_impact', 'workspace_imports', 'incremental_new_import'].map((id) => ({
      id,
      fixture_id: `${id}-fixture`,
      fixture_revision: `${id}-r2`,
      project_path: `projects/${id}`,
      compact_context_path: `contexts/${id}.json`,
      task: `Inspect the project for ${id}. End with evaluation_complete.`,
      required_files: ['src/entry.ts'],
      required_edges: ['src/entry.ts->src/core.ts'],
      forbidden_claims: ['invented-service'],
      privacy_canaries: ['UA_PRIVATE_CANARY']
    }))
  };
}

describe('Understand Anything scenario catalog', () => {
  it('requires the exact Luna profile, four scenarios, synthetic provenance and no-promote', () => {
    const value = catalog();
    assert.deepEqual(validateUnderstandAnythingScenarioCatalog(value), []);

    value.defaults.reasoning = 'medium';
    value.defaults.no_promote = false;
    value.scenarios.pop();
    const errors = validateUnderstandAnythingScenarioCatalog(value);
    assert.ok(errors.some((error) => error.includes('reasoning')));
    assert.ok(errors.some((error) => error.includes('no_promote')));
    assert.ok(errors.some((error) => error.includes('four required scenarios')));
  });

  it('rejects authored tasks that disclose hidden correctness answers', () => {
    const value = catalog();
    value.scenarios[0].task = `Return ${value.scenarios[0].required_files[0]} and ${value.scenarios[0].required_edges[0]}.`;

    const errors = validateUnderstandAnythingScenarioCatalog(value);

    assert.ok(errors.some((error) => error.includes('task discloses required_files')));
    assert.ok(errors.some((error) => error.includes('task discloses required_edges')));
  });
});

describe('Understand Anything matrix identity', () => {
  it('builds 16 cases with pair-scoped fingerprints shared only by two variants', () => {
    const matrix = buildUnderstandAnythingMatrix({
      catalog: catalog(),
      runId: 'ua-luna-low-20260722-r1',
      generatedAt: '2026-07-22T00:00:00.000Z'
    });

    assert.equal(matrix.schema, UNDERSTAND_ANYTHING_MATRIX_SCHEMA);
    assert.equal(matrix.cases.length, 16);
    assert.equal(new Set(matrix.cases.map((item) => item.id)).size, 16);
    assert.equal(new Set(matrix.cases.map((item) => item.run_id)).size, 8);
    assert.equal(new Set(matrix.cases.map((item) => item.pair_id)).size, 8);
    assert.equal(new Set(matrix.cases.map((item) => item.settings_fingerprint)).size, 8);
    for (const pairId of new Set(matrix.cases.map((item) => item.pair_id))) {
      const pair = matrix.cases.filter((item) => item.pair_id === pairId);
      assert.deepEqual(pair.map((item) => item.variant), ['baseline_rg', 'candidate_reviewed_graph']);
      assert.equal(new Set(pair.map((item) => item.settings_fingerprint)).size, 1);
      assert.equal(new Set(pair.map((item) => item.run_id)).size, 1);
    }
  });
});

describe('Understand Anything matrix generation', () => {
  it('keeps graph context out of baseline and copies compact adapter output only for candidate', async () => {
    const value = catalog();
    const fixturesRoot = path.join(tmpDir, 'fixtures');
    for (const scenario of value.scenarios) {
      const projectRoot = path.join(fixturesRoot, scenario.project_path);
      await mkdir(path.join(projectRoot, 'src'), { recursive: true });
      await writeFile(path.join(projectRoot, 'src', 'entry.ts'), 'export const entry = true;\n', 'utf8');
      await writeFile(path.join(projectRoot, 'src', 'core.ts'), 'export const core = true;\n', 'utf8');
      const contextPath = path.join(fixturesRoot, scenario.compact_context_path);
      await mkdir(path.dirname(contextPath), { recursive: true });
      await writeFile(contextPath, JSON.stringify({
        schema: 'aifhub.understand_anything.reviewed_context.v1',
        provenance: { class: 'synthetic_schema_fixture' },
        fingerprints: { graph: `sha256:${'a'.repeat(64)}` },
        files: scenario.required_files,
        edges: scenario.required_edges
      }), 'utf8');
    }
    const catalogPath = path.join(tmpDir, 'catalog.json');
    await writeFile(catalogPath, JSON.stringify(value), 'utf8');
    const outDir = path.join(tmpDir, 'out');

    const result = await generateUnderstandAnythingMatrix({
      catalogPath,
      outDir,
      runId: 'ua-luna-low-20260722-r1',
      cwd: tmpDir
    });

    assert.equal(result.matrix.cases.length, 16);
    const baseline = result.matrix.cases.find((item) => item.variant === 'baseline_rg');
    const candidate = result.matrix.cases.find((item) => item.variant === 'candidate_reviewed_graph');
    await assert.rejects(
      readFile(path.join(outDir, baseline.fixture_path, '.evaluation', 'reviewed-graph-context.json'), 'utf8'),
      { code: 'ENOENT' }
    );
    const reviewed = JSON.parse(await readFile(
      path.join(outDir, candidate.fixture_path, '.evaluation', 'reviewed-graph-context.json'),
      'utf8'
    ));
    assert.equal(reviewed.provenance.class, 'synthetic_schema_fixture');
    assert.equal(baseline.expected_context_fingerprint, 'none');
    assert.equal(candidate.expected_context_fingerprint, reviewed.fingerprints.graph);
    const baselineScenario = await readFile(path.join(outDir, baseline.scenario_file), 'utf8');
    const candidateScenario = await readFile(path.join(outDir, candidate.scenario_file), 'utf8');
    assert.ok(baselineScenario.includes(value.scenarios[0].task));
    assert.ok(candidateScenario.includes(value.scenarios[0].task));
    assert.ok(baselineScenario.includes('reasoning: "low"'));
    assert.ok(candidateScenario.includes('model: "gpt-5.6-luna"'));
    for (const answer of [...value.scenarios[0].required_files, ...value.scenarios[0].required_edges]) {
      assert.equal(baselineScenario.includes(answer), false, answer);
      assert.equal(candidateScenario.includes(answer), false, answer);
    }
    assert.match(candidateScenario, /supporting_context_fingerprint/);
  });

  it('keeps the rendered prompt answer-independent', () => {
    const value = buildUnderstandAnythingMatrix({
      catalog: catalog(),
      runId: 'ua-luna-low-20260722-r1',
      generatedAt: '2026-07-22T00:00:00.000Z'
    }).cases[0];

    const rendered = renderUnderstandAnythingAiTesterScenario(value);

    for (const answer of [...value.required_files, ...value.required_edges]) {
      assert.equal(rendered.includes(answer), false, answer);
    }
    assert.match(rendered, /observed_edge=<source-file-id>-><target-file-id>/);
    assert.match(rendered, /observed_edge=<importer-file-id>\|<package-name>\|<target-file-id>/);
    assert.match(rendered, /fixture-relative file IDs without the project\/ prefix/);
  });
});
