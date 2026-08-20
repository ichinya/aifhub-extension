// context-mode-codex-doc-contract.test.mjs - append-only policy contracts for issue #134
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';

const ROOT = process.cwd();
const readDoc = (relativePath) => readFile(path.join(ROOT, relativePath), 'utf8');
const readJson = async (relativePath) => JSON.parse(await readDoc(relativePath));
const LIVE_EVIDENCE = 'docs/memory-tools-research/context-mode-codex-ai-tester/live-authorized-evidence.json';

describe('context-mode Codex documentation policy', () => {
  it('preserves historical 1.0.151 evidence and appends exact 1.0.169 evidence classes', async () => {
    const results = await readDoc('docs/memory-tools-research/context-mode-benchmark-results.md');
    assert.match(results, /1\.0\.151/);
    assert.match(results, /v1\.0\.169/);
    assert.match(results, /plugin_snapshot_isolated/);
    assert.match(results, /NOT_RUN\(auth_isolation_unavailable\)/);
    assert.match(results, /direct_hook_contract/);
  });

  it('keeps rg baseline, explicit opt-in and separate MCP/plugin conclusions', async () => {
    const [research, recommendations, providers, metadata] = await Promise.all([
      readDoc('docs/memory-tools-research/context-mode.md'),
      readDoc('docs/memory-tool-recommendations.md'),
      readDoc('docs/context-providers.md'),
      readDoc('docs/memory-tools-research/recommendation-metadata.yaml')
    ]);
    for (const body of [research, recommendations, providers, metadata]) {
      assert.match(body, /\brg\b/);
      assert.match(body, /explicit_user_opt_in_only|явн/i);
      assert.doesNotMatch(body, /^\s*(?:auto_install|auto_register_hooks|auto_trust_hooks):\s*(?:true|enabled)\s*$/im);
    }
    assert.match(research, /MCP-only/i);
    assert.match(research, /Codex plugin/i);
    assert.match(metadata, /codex_plugin_status:/);
    assert.match(metadata, /normal_command_selection:\s*forbidden/);
  });

  it('keeps disabled context-mode probing out of active safe-probe guidance', async () => {
    const [analyzeSkill, recommendations] = await Promise.all([
      readDoc('skills/aif-analyze/SKILL.md'),
      readDoc('docs/memory-tool-recommendations.md')
    ]);
    for (const body of [analyzeSkill, recommendations]) {
      assert.doesNotMatch(body, /context-mode doctor/);
      assert.match(body, /dedicated_harness_required/);
    }
    assert.ok(
      recommendations.indexOf('Для `context-mode` Codex surface') >
      recommendations.indexOf('- continuity tasks:'),
      'the context-mode note must not split the dimension-selection bullet list'
    );
  });

  it('keeps generic matrices and normal selection away from context-mode', async () => {
    const [matrixGuide, analyzeSkill, recommendations, metadata, evidence] = await Promise.all([
      readDoc('docs/memory-tools-research/ai-tester-matrix.md'),
      readDoc('skills/aif-analyze/SKILL.md'),
      readDoc('docs/memory-tool-recommendations.md'),
      readDoc('docs/memory-tools-research/recommendation-metadata.yaml'),
      readJson(LIVE_EVIDENCE)
    ]);
    assert.doesNotMatch(matrixGuide, /memory-tool-ai-tester-matrix\.mjs[^\n]*--tool context-mode/);
    assert.doesNotMatch(matrixGuide, /--preinitialize-tool context-mode/);
    assert.match(matrixGuide, /context-mode-codex-ai-tester-/);
    for (const body of [analyzeSkill, recommendations]) {
      assert.match(body, /normal_command_selection:\s*forbidden/);
      assert.match(body, /recommendation-only|manual guidance/i);
      assert.match(body, /manual_guidance/);
      assert.match(body, /configuration_policy:\s*do_not_enable/);
      assert.match(body, /utilities\.context_tools\.enabled/);
    }
    const updated = metadata.match(/^updated:\s*"([^"]+)"/m)?.[1];
    assert.ok(updated >= evidence.recorded_date, `${updated} must cover ${evidence.recorded_date}`);
  });

  it('documents stable probe fields and optional diagnostics', async () => {
    const recommendations = await readDoc('docs/memory-tool-recommendations.md');
    assert.match(recommendations, /availability.*command/s);
    assert.match(recommendations, /reason.*note.*optional/s);
  });

  it('records sanitized authorized live evidence without promoting normal lifecycle', async () => {
    const [evidence, research, results, recommendations, providers, metadata] = await Promise.all([
      readJson(LIVE_EVIDENCE),
      readDoc('docs/memory-tools-research/context-mode.md'),
      readDoc('docs/memory-tools-research/context-mode-benchmark-results.md'),
      readDoc('docs/memory-tool-recommendations.md'),
      readDoc('docs/context-providers.md'),
      readDoc('docs/memory-tools-research/recommendation-metadata.yaml')
    ]);

    assert.match(LIVE_EVIDENCE, /^docs\//);
    assert.equal(evidence.schema, 'aifhub.context_mode_codex.live_evaluation.v1');
    assert.equal(evidence.artifact_class, 'sanitized_public_evaluation_evidence');
    assert.equal(evidence.authorization.class, 'explicit_isolated_full');
    assert.equal(evidence.authorization.scope, 'isolated_evaluation');
    assert.equal(evidence.authorization.purpose, 'test_only');
    assert.equal(evidence.authorization.auth_copy_disposition, 'deleted');
    assert.equal(evidence.authorization.normal_command_authorized, false);
    assert.equal(evidence.authorization.hook_trust_bypass, 'approved_test_only_for_pinned_snapshot');
    assert.equal(evidence.lifecycle.install_lifecycle, 'NOT_RUN(postinstall_forbidden)');
    assert.equal(evidence.matrix.fixture_revision, 'context-mode-134-synthetic-v2');
    assert.equal(evidence.matrix.dry_run_rows, 18);
    assert.equal(evidence.scenarios.large_stdout_truncation.baseline.status, 'FAIL');
    assert.equal(evidence.scenarios.large_stdout_truncation.mcp_only.status, 'PASS');
    assert.equal(evidence.scenarios.large_stdout_truncation.mcp_only.raw_rollout_audit.status, 'PASS');
    assert.equal(evidence.scenarios.large_stdout_truncation.plugin.status, 'FAIL');
    assert.equal(evidence.scenarios.session_continuity.status, 'NOT_RUN(resume_driver_parity_unavailable)');
    assert.equal(evidence.decision.token_savings, 'not_demonstrated');
    assert.deepEqual(evidence.privacy, {
      tracked_raw_traces: 0,
      tracked_raw_rollout_records: 0,
      tracked_raw_content: 0,
      tracked_absolute_paths: 0,
      tracked_environment_values: 0,
      tracked_credentials: 0,
      tracked_auth_fingerprints: 0
    });

    const serializedEvidence = JSON.stringify(evidence);
    assert.doesNotMatch(serializedEvidence, /[A-Za-z]:\\\\|\/Users\/|\/home\//);
    assert.doesNotMatch(serializedEvidence, /auth\.json|CODEX_HOME|Bearer\s|API_KEY/i);

    for (const body of [research, results, recommendations, providers, metadata]) {
      assert.match(body, /explicit_isolated_full/);
      assert.match(body, /resume_driver_parity_unavailable/);
      assert.match(body, /token savings|token_savings|эконом(?:ит|ии).*token|не экономит billed tokens/i);
    }
    for (const body of [research, recommendations, providers, metadata]) {
      assert.match(body, /hook_trust_mode/);
      assert.match(body, /test_only_pinned_snapshot_bypass/);
    }
    assert.match(metadata, /mcp_only_status:\s*conditional_large_truncating_output_only/);
    assert.match(metadata, /codex_plugin_status:\s*avoid_tested_nested_shell_stack/);
  });
});
