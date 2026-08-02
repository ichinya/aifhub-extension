// context-mode-codex-ai-tester-matrix.test.mjs - symmetric issue #134 matrix contracts
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';

import {
  CONTEXT_MODE_SCENARIOS,
  CONTEXT_MODE_VARIANTS,
  buildContextModeMatrix,
  buildCodexReasoningWrapper,
  loadContextModeScenarioCatalog,
  renderAiTesterScenario,
  validateContextModeScenarioCatalog,
  validateReasoningProof
} from './context-mode-codex-ai-tester-matrix.mjs';

const provenance = {
  fixture_revision: 'fixture-v1',
  ai_tester_source_clean: true,
  ai_tester_source_commit: '98dd5afb3fe9b9b7593d21dc93bcbc6d98c2cca9',
  ai_tester_binary_sha256: 'a'.repeat(64),
  ai_tester_version: '1.1.0',
  codex_version: 'codex-cli 0.144.6',
  codex_features: ['hooks', 'plugins'],
  context_mode_tag: 'v1.0.169',
  context_mode_commit: '589d8214d56740a28b5f7bf63167743d586b0b40',
  context_mode_integrity: 'sha512-94JIaFuLjF9SO2BsGTrbGtyT44K95+9OC8BdbaL/UT76xOkanJLfUR5CzmNw+GELXZQqH4nBrKg9wjBnSFkVnQ=='
};

describe('context-mode scenario catalog', () => {
  it('contains three safe scenarios and exact Luna settings', async () => {
    const catalog = await loadContextModeScenarioCatalog();
    assert.deepEqual(catalog.scenarios.map((item) => item.id), CONTEXT_MODE_SCENARIOS);
    assert.deepEqual(catalog.defaults.variants, CONTEXT_MODE_VARIANTS);
    assert.equal(catalog.defaults.repetitions, 2);
    assert.equal(catalog.defaults.runtime, 'codex');
    assert.equal(catalog.defaults.model, 'gpt-5.6-luna');
    assert.equal(catalog.defaults.reasoning, 'low');
    assert.deepEqual(validateContextModeScenarioCatalog(catalog), []);
    assert.doesNotMatch(JSON.stringify(catalog), /[A-Za-z]:\\Users\\|\/Users\/|BEGIN PRIVATE KEY/i);
    for (const scenario of catalog.scenarios) {
      assert.ok(scenario.assertions.every((item) =>
        typeof item.id === 'string' && typeof item.pattern === 'string'
      ));
      const promptText = scenario.prompts.join('\n');
      for (const assertion of scenario.assertions) {
        assert.doesNotMatch(promptText, new RegExp(escapeRegex(assertion.pattern), 'i'));
      }
    }
    assert.deepEqual(
      catalog.scenarios.find((item) => item.id === 'fresh_session_isolation_and_purge').lifecycle_assertions,
      ['fresh_session_isolated', 'provider_purged', 'sandbox_clean']
    );
  });
});

describe('context-mode three-way matrix', () => {
  it('generates 18 unique symmetric rows with triad provenance fingerprints', async () => {
    const catalog = await loadContextModeScenarioCatalog();
    const matrix = buildContextModeMatrix({
      catalog,
      runId: 'context-mode-134-test',
      provenance,
      generatedAt: '2026-07-28T18:00:00.000Z'
    });
    assert.equal(matrix.rows.length, 18);
    assert.equal(new Set(matrix.rows.map((row) => row.id)).size, 18);
    for (const triadId of new Set(matrix.rows.map((row) => row.triad_id))) {
      const rows = matrix.rows.filter((row) => row.triad_id === triadId);
      assert.deepEqual(rows.map((row) => row.variant), CONTEXT_MODE_VARIANTS);
      assert.equal(new Set(rows.map((row) => row.settings_fingerprint)).size, 1);
      assert.ok(rows.every((row) => row.runtime === 'codex'));
      assert.ok(rows.every((row) => row.model === 'gpt-5.6-luna'));
      assert.ok(rows.every((row) => row.reasoning === 'low'));
      assert.ok(rows.every((row) => row.timeout_ms === catalog.defaults.timeout_ms));
      assert.deepEqual(rows[0].settings_provenance, provenance);
      assert.deepEqual(rows.map((row) => row.execution_gate), [
        { status: 'PASS', reason: 'baseline_ready' },
        { status: 'BLOCKED', reason: 'runtime_dependency_self_install' },
        { status: 'NOT_RUN', reason: 'auth_isolation_unavailable' }
      ]);
    }
  });

  it('injects low reasoning before both initial exec and resume', () => {
    const wrapper = buildCodexReasoningWrapper({ realCodex: 'codex-real' });
    assert.match(wrapper, /model_reasoning_effort="low"/);
    assert.match(wrapper, /exec/);
    assert.match(wrapper, /resume/);
    assert.equal(validateReasoningProof([
      ['-c', 'model_reasoning_effort="low"', 'exec', '--json'],
      ['-c', 'model_reasoning_effort="low"', 'exec', 'resume', 'session']
    ]).status, 'PASS');
    assert.equal(validateReasoningProof([
      ['exec', '--json'],
      ['exec', 'resume', 'session']
    ]).reason, 'profile_unenforced');
  });

  it('keeps expected answers out of prompts and renders independently checkable facts', async () => {
    const catalog = await loadContextModeScenarioCatalog();
    const matrix = buildContextModeMatrix({
      catalog,
      runId: 'context-mode-134-answer-independent',
      provenance,
      generatedAt: '2026-07-28T18:00:00.000Z'
    });
    for (const row of matrix.rows) {
      const rendered = renderAiTesterScenario(row);
      const promptSection = rendered.match(/user_prompts:\n([\s\S]*?)\nfixtures:/)?.[1] ?? '';
      assert.doesNotMatch(promptSection, /Include these literal result markers|north=17|east=29|checksum=46|D-134|F-134|E-134/i);
      for (const assertion of row.assertions) {
        assert.match(rendered, new RegExp(`pattern: ${escapeRegex(JSON.stringify(assertion.pattern))}`));
      }
      assert.match(rendered, /type: tool_called/);
      assert.doesNotMatch(rendered, /setup_commands:|npm install|context-mode@/i);
    }
    const freshRows = matrix.rows.filter((row) => row.scenario_id === 'fresh_session_isolation_and_purge');
    assert.ok(freshRows.every((row) => row.lifecycle_assertions.includes('fresh_session_isolated')));
    assert.doesNotMatch(renderAiTesterScenario(freshRows[0]), /provider_purged|sandbox_clean|fresh_session_isolated/);
  });

  it('renders every baseline command matcher as a parseable YAML double-quoted scalar', async () => {
    const catalog = await loadContextModeScenarioCatalog();
    const matrix = buildContextModeMatrix({
      catalog,
      runId: 'context-mode-134-baseline-yaml',
      provenance,
      generatedAt: '2026-08-02T11:00:00.000Z'
    });
    const baselineRows = matrix.rows.filter((row) => row.variant === 'baseline');
    assert.equal(baselineRows.length, 6);

    for (const row of baselineRows) {
      const rendered = renderAiTesterScenario(row);
      const commandScalar = rendered.match(/^\s+command: (.+)$/m)?.[1];
      assert.ok(commandScalar, `missing baseline command matcher for ${row.id}`);
      assert.doesNotThrow(
        () => JSON.parse(commandScalar),
        `invalid JSON-compatible YAML scalar for ${row.id}: ${commandScalar}`
      );
      assert.equal(
        JSON.parse(commandScalar),
        '(?:^|[\\\\/ ;])rg(?:\\.exe)?(?:[ \\t]|$)'
      );
    }
  });

  it('emits sanitized proof events from executable initial and resume wrapper paths', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'context-mode-wrapper-proof-'));
    try {
      const wrapperPath = path.join(root, 'codex-wrapper.mjs');
      const proofPath = path.join(root, 'proof.jsonl');
      await writeFile(wrapperPath, buildCodexReasoningWrapper({ realCodex: process.execPath }), 'utf8');
      const env = { ...process.env, CONTEXT_MODE_REASONING_PROOF: proofPath };
      spawnSync(process.execPath, [wrapperPath, 'exec', '--json'], { env, stdio: 'ignore' });
      spawnSync(process.execPath, [wrapperPath, 'exec', 'resume', 'session'], { env, stdio: 'ignore' });
      const proof = (await readFile(proofPath, 'utf8')).trim().split(/\r?\n/).map(JSON.parse);
      assert.deepEqual(proof, [
        { phase: 'initial', profile: 'low' },
        { phase: 'resume', profile: 'low' }
      ]);
      assert.doesNotMatch(JSON.stringify(proof), /Users|projects|session/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
