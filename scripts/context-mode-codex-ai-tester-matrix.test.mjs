// context-mode-codex-ai-tester-matrix.test.mjs - symmetric issue #134 matrix contracts
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';

import {
  BASELINE_RG_COMMAND_PATTERN,
  CONTEXT_MODE_SCENARIOS,
  CONTEXT_MODE_VARIANTS,
  buildLargeOutputEmitterSource,
  buildContextModeMatrix,
  buildCodexReasoningWrapper,
  loadContextModeScenarioCatalog,
  normalizeContextModeAuthorization,
  renderAiTesterScenario,
  writeCodexReasoningWrapper,
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
    assert.equal(catalog.fixture.profiles.large_stdout_tail.minimum_bytes, 1_048_577);
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

  it('keeps provider gates closed unless a complete path-free authorization envelope is supplied', async () => {
    const catalog = await loadContextModeScenarioCatalog();
    assert.deepEqual(normalizeContextModeAuthorization(), {
      class: 'default_fail_closed',
      mcp_allowed: false,
      plugin_allowed: false
    });
    assert.deepEqual(normalizeContextModeAuthorization({
      scope: 'isolated_evaluation',
      provider_snapshot: 'prepared_pinned_snapshot',
      runtime_dependency_bootstrap: 'approved',
      auth_mode: 'scoped_ephemeral',
      native_codex: true
    }), {
      class: 'explicit_isolated_mcp',
      mcp_allowed: true,
      plugin_allowed: false
    });
    assert.equal(normalizeContextModeAuthorization({
      scope: 'isolated_evaluation',
      provider_snapshot: 'prepared_pinned_snapshot',
      runtime_dependency_bootstrap: 'approved',
      auth_mode: 'scoped_ephemeral',
      native_codex: true,
      hook_trust_mode: 'test_only_pinned_snapshot_bypass',
      path: 'C:/private'
    }).class, 'default_fail_closed');
    const matrix = buildContextModeMatrix({
      catalog,
      runId: 'context-mode-134-authorized',
      provenance,
      authorization: {
        scope: 'isolated_evaluation',
        provider_snapshot: 'prepared_pinned_snapshot',
        runtime_dependency_bootstrap: 'approved',
        auth_mode: 'scoped_ephemeral',
        native_codex: true,
        hook_trust_mode: 'test_only_pinned_snapshot_bypass'
      },
      generatedAt: '2026-08-03T12:00:00.000Z'
    });
    assert.equal(matrix.authorization_class, 'explicit_isolated_full');
    assert.ok(matrix.rows.filter((row) => row.variant !== 'baseline').every((row) =>
      row.execution_gate.status === 'PASS' &&
      row.execution_gate.reason === 'explicit_isolated_authorization'
    ));
    assert.doesNotMatch(JSON.stringify(matrix), /scoped_ephemeral|prepared_pinned_snapshot|runtime_dependency_bootstrap/);
  });

  it('injects low reasoning before both initial exec and resume', () => {
    const wrapper = buildCodexReasoningWrapper({ realCodex: 'codex-real' });
    assert.match(wrapper, /model_reasoning_effort="low"/);
    assert.match(wrapper, /exec/);
    assert.match(wrapper, /resume/);
    assert.equal(validateReasoningProof([
      { phase: 'initial', profile: 'low' },
      { phase: 'resume', profile: 'low' }
    ]).status, 'PASS');
    assert.equal(validateReasoningProof([
      { phase: 'initial', profile: 'default' },
      { phase: 'resume', profile: 'default' }
    ]).reason, 'profile_unenforced');
    assert.equal(validateReasoningProof([
      { phase: 'initial', profile: 'low' },
      null
    ]).reason, 'reasoning_proof_invalid');
  });

  it('rejects authorized matrix generation when context-mode provenance is not the reviewed release', async () => {
    const catalog = await loadContextModeScenarioCatalog();
    assert.throws(() => buildContextModeMatrix({
      catalog,
      runId: 'context-mode-134-wrong-provider',
      provenance: {
        ...provenance,
        context_mode_commit: '0'.repeat(40)
      },
      authorization: {
        scope: 'isolated_evaluation',
        provider_snapshot: 'prepared_pinned_snapshot',
        runtime_dependency_bootstrap: 'approved',
        auth_mode: 'scoped_ephemeral',
        native_codex: true,
        hook_trust_mode: 'test_only_pinned_snapshot_bypass'
      }
    }), /context_mode_provenance_mismatch/);
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
      if (row.variant === 'baseline') assert.match(rendered, /type: tool_called/);
      else assert.doesNotMatch(rendered, /type: tool_called/);
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
      const decoded = JSON.parse(commandScalar);
      if (row.scenario_id === 'large_generated_output_retrieval') {
        assert.match(decoded, /node/);
      } else {
        assert.equal(decoded, BASELINE_RG_COMMAND_PATTERN);
      }
    }
    const matcher = new RegExp(BASELINE_RG_COMMAND_PATTERN, 'i');
    assert.match("& 'C:\\tools\\rg.exe' north project/generated-output.txt", matcher);
    assert.match('pwsh -Command "rg --files"', matcher);
    assert.doesNotMatch('larger-value', matcher);
    assert.doesNotMatch('myrg --files', matcher);
  });

  it('renders the large-output scenario as a compact deterministic emitter whose facts cross 1 MiB', async () => {
    const catalog = await loadContextModeScenarioCatalog();
    const profile = catalog.fixture.profiles.large_stdout_tail;
    const source = buildLargeOutputEmitterSource(profile);
    const emitted = spawnSync(process.execPath, ['--input-type=module', '--eval', source], {
      encoding: 'utf8',
      maxBuffer: 2 * 1024 * 1024
    });
    assert.equal(emitted.status, 0);
    assert.ok(Buffer.byteLength(emitted.stdout) >= profile.minimum_bytes);
    assert.ok(Buffer.byteLength(emitted.stdout.slice(0, emitted.stdout.indexOf('north=731'))) > 1_048_576);
    assert.match(emitted.stdout, /north=731\r?\neast=409\r?\nchecksum=1140\r?\n$/);
    assert.ok(Buffer.byteLength(source) < 2048, 'tracked scenario metadata must not embed the large output');

    const matrix = buildContextModeMatrix({
      catalog,
      runId: 'context-mode-134-large-fixture',
      provenance,
      generatedAt: '2026-08-03T12:00:00.000Z'
    });
    const largeRow = matrix.rows.find((row) =>
      row.scenario_id === 'large_generated_output_retrieval' && row.variant === 'baseline'
    );
    assert.equal(largeRow.session_mode, 'single_turn');
    assert.equal(largeRow.prompts.length, 1);
    const rendered = renderAiTesterScenario(largeRow);
    assert.match(rendered, /emit-large-output\.mjs/);
    assert.doesNotMatch(rendered, /project\/generated-output\.txt|north=17|east=29|checksum=46/);
    assert.ok(Buffer.byteLength(JSON.stringify(matrix)) < 250_000);
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
      assert.deepEqual(validateReasoningProof(proof), {
        status: 'PASS',
        reason: 'profile_enforced_initial_and_resume'
      });
      assert.doesNotMatch(JSON.stringify(proof), /Users|projects|session/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('pins the explicit native Codex path when writing a live reasoning wrapper', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'context-mode-wrapper-native-'));
    try {
      const written = await writeCodexReasoningWrapper({ outDir: root, realCodex: process.execPath });
      assert.equal(written.codex_resolution, 'explicit');
      const moduleText = await readFile(path.join(root, written.module_file), 'utf8');
      assert.match(moduleText, new RegExp(escapeRegex(JSON.stringify(process.execPath))));
      assert.doesNotMatch(moduleText, /const realCodex = "__PATH_AFTER_WRAPPER__"/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('canonicalizes the wrapper directory before excluding it from PATH fallback', () => {
    const wrapper = buildCodexReasoningWrapper({ realCodex: '__PATH_AFTER_WRAPPER__' });
    assert.match(
      wrapper,
      /const own = path\.resolve\(path\.dirname\(process\.argv\[1\]\)\)\.toLowerCase\(\);/
    );
  });
});

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
