// memory-tool-recommender.test.mjs - metadata-driven optional memory/context tool recommendations
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import {
  buildRecommendationResult,
  buildSelectionResult,
  classifyProjectProfile,
  isWindowsShellCommandNotFound,
  loadRecommendationMetadata,
  parseRecommendationMetadata,
  provenLabelAvoidsRequest,
  provenLabelAllowsRequest,
  resolveMetadataPath,
  SOURCE_DENYLIST_TOOL_IDS,
  runMemoryToolRecommender
} from './memory-tool-recommender.mjs';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const REAL_METADATA = path.join(REPO_ROOT, 'docs', 'memory-tools-research', 'recommendation-metadata.yaml');

let tmpDir;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'memory-tool-recommender-'));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

async function runCli(args, options = {}) {
  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    [path.join(REPO_ROOT, 'scripts', 'memory-tool-recommender.mjs'), ...args],
    {
      cwd: options.cwd ?? REPO_ROOT,
      env: {
        ...process.env,
        ...(options.env ?? {})
      },
      timeout: options.timeout ?? 10000
    }
  );

  assert.equal(stderr, '');
  return JSON.parse(stdout);
}

async function runJsonWithDeterministicProbes(args, options = {}) {
  const stdout = [];
  const stderr = [];
  const probedTools = [];
  const debugFix = ['debug', 'trace'].includes(
    String(process.env.AIFHUB_LOG_LEVEL ?? process.env.LOG_LEVEL ?? '').toLowerCase()
  );
  const result = await runMemoryToolRecommender(args, {
    cwd: options.cwd ?? REPO_ROOT,
    stdout,
    stderr,
    exit: false,
    probeRunner: async (toolId) => {
      probedTools.push(toolId);
      if (debugFix) {
        process.stderr.write(`[FIX:memory-tool-recommender-test-probe] tool=${toolId} availability=unknown\n`);
      }
      return { availability: 'unknown', command: null };
    }
  });

  assert.equal(result.exitCode, 0);
  assert.deepEqual(stderr, []);
  assert.equal(stdout.length, 1);
  return {
    body: JSON.parse(stdout[0]),
    probedTools
  };
}

describe('recommendation metadata parsing', () => {
  it('parses required policy fields and tool decisions', async () => {
    const raw = await readFile(REAL_METADATA, 'utf8');
    const metadata = parseRecommendationMetadata(raw, { sourcePath: REAL_METADATA });

    assert.equal(metadata.schema, 'aifhub.memory_tools.recommendation.v1');
    assert.equal(metadata.default_policy.baseline_tool, 'rg');
    assert.equal(metadata.default_policy.never_auto_install, true);
    assert.equal(metadata.default_policy.install_policy, 'explicit_user_opt_in_only');
    assert.equal(metadata.default_policy.require_explicit_paths, true);
    assert.equal(metadata.default_policy.require_purge_path, true);
    assert.ok(metadata.skill_usage_matrix['aif-analyze']);
    assert.deepEqual(metadata.skill_usage_matrix['aif-architecture'].allowed, ['rg', 'graphify', 'context7']);
    assert.deepEqual(metadata.skill_usage_matrix['aif-architecture'].forbidden, [
      'codex-agent-mem',
      'context-mode',
      'codex-mem',
      'eagle-mem',
      'codegraph',
      'repowise',
      'rohitg00-agentmemory',
      'understand-anything'
    ]);
    assert.deepEqual(metadata.project_dimensions.languages, ['php', 'go', 'js', 'python', 'rust', 'multi']);
    assert.deepEqual(metadata.project_dimensions.volume, ['mini', 'standard', 'large']);
    assert.deepEqual(metadata.project_dimensions.complexity, ['mini', 'framework', 'legacy', 'integration_heavy']);
    assert.deepEqual(metadata.project_dimensions.repo_shape, ['single_repo', 'monorepo', 'multirepo']);
    assert.deepEqual(metadata.project_dimensions.artifact_mode, ['openspec_native', 'legacy_ai_factory_only', 'none']);
    assert.equal(metadata.benchmark_matrix.ai_tester.result_schema, 'aifhub.memory_tools.ai_tester_matrix.v1');
    assert.equal(metadata.proven_label_evidence[0].scenario_id, 'architecture-impact-discovery');
    assert.equal(metadata.proven_label_evidence[0].run_class, 'accepted_evidence');
    assert.equal(metadata.proven_label_evidence.every((entry) => entry.run_class === 'accepted_evidence'), true);
    assert.deepEqual(metadata.proven_label_evidence.filter((entry) => entry.tool_id === 'repowise'), []);
    assert.deepEqual(metadata.benchmark_matrix.ai_tester.decision_actions, ['recommend', 'conditional', 'avoid', 'forbid']);
    assert.ok(metadata.benchmark_matrix.ai_tester.comparison_metrics.includes('usefulness_vs_rg'));
    assert.equal(metadata.benchmark_matrix.ai_tester.reduced_matrix_policy.default_matrix_size, 'screening');
    assert.equal(metadata.benchmark_matrix.ai_tester.reduced_matrix_policy.presets.screening.expected_scenarios_per_tool, 300);
    assert.equal(metadata.benchmark_matrix.ai_tester.skill_test_groups.length, 8);
    assert.deepEqual(metadata.benchmark_matrix.ai_tester.skill_test_groups[0].representatives, ['aif-analyze']);
    assert.ok(metadata.dimension_signals.mini_go_service.avoid_tools.includes('codegraph'));
    assert.ok(!metadata.dimension_signals.large_framework_broad_discovery.conditional_tools.includes('codegraph'));
    assert.ok(metadata.evidence_runs.some((run) => run.id === 'codegraph-forced-benchmark-2026-05-26'));
    assert.ok(metadata.evidence_runs.some((run) => run.id === 'codegraph-screening-preinit-nosipout-gpt54mini-2026-05-27'));
    assert.equal(metadata.tool_permissions.graphify['aif-analyze'], 'recommend_only');
    assert.equal(metadata.tool_permissions.graphify['aif-architecture'], 'read_existing_reviewed_output');
    assert.equal(metadata.tool_permissions.context7['aif-architecture'], 'read_existing_reviewed_output');
    assert.equal(metadata.tool_permissions['codex-agent-mem']['aif-architecture'], 'forbidden');
    assert.equal(metadata.tool_permissions['context-mode']['aif-architecture'], 'forbidden');
    assert.equal(metadata.tool_permissions.codegraph['aif-architecture'], 'forbidden');
    assert.equal(metadata.availability_probes.graphify[0], 'graphify --version');
    assert.ok(metadata.forbidden_operations.includes('auto_install'));
    assert.ok(metadata.protected_artifacts.includes('aif-gate-result'));
    assert.ok(metadata.protected_artifacts.includes('coverage.json'));
    assert.equal(metadata.tools.graphify.decision, 'manual_quality_experiment_only');
    assert.equal(metadata.tools.graphify.screening_policy.default_decision, 'avoid_by_default');
    assert.ok(metadata.evidence_runs.some((run) => run.id === 'targeted-graphify-context7-ai-tester-2026-05-28'));
    assert.equal(metadata.tools['codex-agent-mem'].read_scope, 'explicit_sqlite_db_path');
    assert.equal(metadata.tools['context-mode'].decision, 'manual_helper_only');
    assert.equal(metadata.tools['context-mode'].mcp_only_status, 'conditional_large_truncating_output_only');
    assert.equal(metadata.tools['context-mode'].codex_plugin_status, 'avoid_tested_nested_shell_stack');
    assert.equal(metadata.tools['context-mode'].authorized_live_followup.token_savings, 'not_demonstrated');
    assert.equal(
      metadata.tools['context-mode'].authorized_live_followup.session_continuity,
      'not_run_resume_driver_parity_unavailable'
    );
    assert.equal(metadata.tools['context-mode'].normal_command_selection, 'forbidden');
    assert.equal(metadata.tools['context-mode'].auto_register_hooks, false);
    assert.deepEqual(metadata.availability_probes['context-mode'], []);
    assert.equal(metadata.tools['codex-mem'].decision, 'reject_default');
    assert.equal(metadata.tools['eagle-mem'].decision, 'reject_defer');
    assert.equal(metadata.tools.context7.decision, 'optional');
    assert.ok(metadata.tools.context7.allowed_in.includes('aif-architecture'));
    assert.ok(metadata.tools.graphify.allowed_in.includes('aif-architecture'));
    assert.equal(metadata.tools.codegraph.decision, 'manual_cli_only');
    assert.equal(metadata.tools.codegraph.screening_policy.default_decision, 'avoid_by_default');
    assert.equal(metadata.tools.codegraph.screening_policy.aggregate.rows_executed, 300);
    assert.ok(metadata.tools.codegraph.forbidden_in.includes('aif-architecture'));
    assert.equal(metadata.tools['understand-anything'].repository, 'https://github.com/Egonex-AI/Understand-Anything');
    assert.match(metadata.tools['understand-anything'].tested_version, /v2\.9\.0/);
    assert.match(metadata.tools['understand-anything'].tested_version, /f08763d11d0202a8a8f52b5dedda6d1b2e2ebac8/);
    assert.equal(metadata.tools['understand-anything'].decision, 'reject_defer');
    assert.equal(metadata.tools['understand-anything'].recommendation_action, 'do_not_suggest_install');
    assert.equal(metadata.tools['understand-anything'].integration_role, 'user_owned_repo_graph');
    assert.deepEqual(metadata.tools['understand-anything'].allowed_in, []);
    assert.ok(metadata.tools['understand-anything'].forbidden_in.includes('aif-explore'));
    assert.equal(metadata.tool_permissions['understand-anything'].default, 'forbidden');
    assert.equal(Object.hasOwn(metadata.availability_probes, 'understand-anything'), false);
    assert.equal(SOURCE_DENYLIST_TOOL_IDS.has('understand-anything'), true);
    for (const [command, policy] of Object.entries(metadata.skill_usage_matrix)) {
      assert.ok(
        policy.forbidden.includes('understand-anything'),
        `${command}: understand-anything must be explicitly forbidden`
      );
    }
  });

  it('keeps similarly named AgentMemory identities distinct', async () => {
    const metadata = await loadRecommendationMetadata({ metadataPath: REAL_METADATA });
    const manualNotes = metadata.tools['agent-memory'];
    const continuity = metadata.tools['codex-agent-mem'];
    const candidate = metadata.tools['rohitg00-agentmemory'];

    assert.equal(manualNotes.repository, 'https://github.com/jayzeng/agentmemory');
    assert.equal(manualNotes.tested_version, 'myagentmemory 0.4.12');
    assert.equal(continuity.repository, 'https://github.com/MarceloCaporale/codex-agent-mem');
    assert.equal(candidate.repository, 'https://github.com/rohitg00/agentmemory');
    assert.deepEqual(candidate.packages, ['@agentmemory/agentmemory', '@agentmemory/mcp']);
    assert.equal(candidate.doc, 'agentmemory-rohitg00.md');
    assert.equal(candidate.results_doc, 'agentmemory-rohitg00-benchmark-results.md');
    assert.match(candidate.tested_version, /0\.9\.28/);
    assert.match(candidate.tested_version, /isolated standalone ai-tester PASS/);
    assert.equal(candidate.isolated_runtime_evidence.status, 'pass');
    assert.equal(candidate.isolated_runtime_evidence.run_id, 'agentmemory-isolated-0-9-28-20260720-r4');
    assert.equal(candidate.isolated_runtime_evidence.pass_pairs, 2);
    assert.equal(candidate.isolated_runtime_evidence.eligible_for_metadata, false);
    assert.equal(candidate.decision, 'reject_default');
    assert.equal(candidate.recommendation_action, 'do_not_suggest_as_aifhub_provider');
    assert.equal(candidate.integration_role, 'user_owned_continuity_candidate_only');
    assert.deepEqual(candidate.allowed_in, []);
    assert.deepEqual(candidate.forbidden_operations, [
      'auto_install',
      'auto_run_setup',
      'auto_sync_memory',
      'auto_register_mcp',
      'mutate_provider_config',
      'install_hooks',
      'start_background_daemons',
      'run_provider_cli'
    ]);
    assert.equal(metadata.tool_permissions['rohitg00-agentmemory'].default, 'forbidden');
    assert.equal(Object.hasOwn(metadata.availability_probes, 'rohitg00-agentmemory'), false);
    for (const [command, policy] of Object.entries(metadata.skill_usage_matrix)) {
      assert.ok(
        policy.forbidden.includes('rohitg00-agentmemory'),
        `${command}: rohitg00-agentmemory must be explicitly forbidden`
      );
    }
  });
});

describe('metadata source resolution', () => {
  it('prefers installed script-relative metadata', async () => {
    const installedRoot = path.join(tmpDir, '.ai-factory', 'extensions', 'aifhub-extension');
    await mkdir(path.join(installedRoot, 'scripts'), { recursive: true });
    await mkdir(path.join(installedRoot, 'docs', 'memory-tools-research'), { recursive: true });
    await copyFile(
      REAL_METADATA,
      path.join(installedRoot, 'docs', 'memory-tools-research', 'recommendation-metadata.yaml')
    );

    const resolved = await resolveMetadataPath({
      scriptDir: path.join(installedRoot, 'scripts'),
      cwd: tmpDir
    });

    assert.equal(
      resolved.path,
      path.join(installedRoot, 'docs', 'memory-tools-research', 'recommendation-metadata.yaml')
    );
    assert.equal(resolved.kind, 'installed-script-relative');
  });

  it('uses source-tree metadata only inside the aifhub extension repository', async () => {
    const sourceRoot = path.join(tmpDir, 'source');
    await mkdir(path.join(sourceRoot, 'docs', 'memory-tools-research'), { recursive: true });
    await writeFile(
      path.join(sourceRoot, 'extension.json'),
      JSON.stringify({ name: 'aifhub-extension' }),
      'utf8'
    );
    await copyFile(
      REAL_METADATA,
      path.join(sourceRoot, 'docs', 'memory-tools-research', 'recommendation-metadata.yaml')
    );

    const resolved = await resolveMetadataPath({
      scriptDir: path.join(sourceRoot, 'scripts'),
      cwd: sourceRoot
    });

    assert.equal(
      resolved.path,
      path.join(sourceRoot, 'docs', 'memory-tools-research', 'recommendation-metadata.yaml')
    );
    assert.equal(resolved.kind, 'source-tree');
  });
});

describe('recommendation results', () => {
  it('keeps Graphify off broad large framework discovery unless an explicit quality experiment is requested', async () => {
    const metadata = await loadRecommendationMetadata({ metadataPath: REAL_METADATA });
    const broadResult = await buildRecommendationResult({
      metadata,
      projectShape: 'large_framework_app',
      taskSignals: ['architecture_or_impact_discovery'],
      probeRunner: async () => ({ availability: 'unknown' })
    });
    const explicitResult = await buildRecommendationResult({
      metadata,
      projectShape: 'large_framework_app',
      taskSignals: ['explicit_graph_quality_experiment'],
      probeRunner: async () => ({ availability: 'unknown' })
    });

    const graphify = explicitResult.recommendations.find((item) => item.tool_id === 'graphify');
    assert.equal(broadResult.schema, 'aifhub.memory_tools.recommendation_result.v1');
    assert.deepEqual(broadResult.baseline, ['rg']);
    assert.equal(broadResult.recommendations.some((item) => item.tool_id === 'graphify'), false);
    assert.ok(graphify);
    assert.equal(explicitResult.recommendations.some((item) => item.tool_id === 'context-mode'), false);
    assert.equal(graphify.display_name, 'Graphify');
    assert.equal(graphify.status, 'manual_quality_experiment_only');
    assert.equal(graphify.install_policy, 'explicit_user_opt_in_only');
    assert.equal(graphify.read_scope, 'explicit_project_path');
    assert.deepEqual(graphify.allowed_in, ['aif-analyze', 'aif-explore', 'aif-architecture', 'aif-plan', 'aif-review']);
    assert.ok(graphify.forbidden_in.includes('aif-implement'));
    assert.equal(graphify.permission, 'recommend_only');
    assert.match(graphify.privacy_caveat, /explicit project path/i);
    assert.match(graphify.next_step, /Use rg first/i);
  });

  it('surfaces protected artifacts and matrix policy in metadata JSON', async () => {
    const metadata = await loadRecommendationMetadata({ metadataPath: REAL_METADATA });
    const result = await runMemoryToolRecommender([
      'metadata',
      '--metadata',
      REAL_METADATA,
      '--json'
    ], {
      cwd: REPO_ROOT,
      stdout: [],
      stderr: [],
      exit: false
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.body.schema, 'aifhub.memory_tools.metadata_result.v1');
    assert.deepEqual(result.body.skill_usage_matrix['aif-analyze'].allowed, [
      'rg',
      'graphify',
      'context7',
      'codex-agent-mem',
      'context-mode',
      'codegraph',
      'repowise'
    ]);
    assert.equal(result.body.tool_permissions.graphify['aif-implement'], 'forbidden');
    assert.equal(result.body.tool_permissions.codegraph['aif-analyze'], 'recommend_only');
    assert.equal(result.body.tool_permissions.codegraph['aif-explore'], 'manual_purged_cli_execution');
    assert.match(JSON.stringify(result.body.tools.codegraph.execution), /codegraph init <project>/);
    assert.match(JSON.stringify(result.body.tools.graphify.execution), /read_existing_reviewed_output/);
    assert.ok(result.body.forbidden_operations.includes('auto_register_mcp'));
    assert.ok(result.body.protected_artifacts.includes('done-readiness.json'));
    assert.ok(result.body.protected_artifacts.includes('openspec/specs/**'));
    assert.deepEqual(result.body.project_dimensions.languages, ['php', 'go', 'js', 'python', 'rust', 'multi']);
    assert.equal(result.body.benchmark_matrix.ai_tester.result_schema, 'aifhub.memory_tools.ai_tester_matrix.v1');
    assert.equal(result.body.proven_label_evidence[0].tool_id, 'codegraph');
    assert.ok(result.body.dimension_signals.includes('mini_go_service'));
    assert.equal(metadata.tools.codegraph.recommendation_action, 'suggest_manual_cli_for_repo_graph_when_enabled_or_explicit');
    assert.equal(result.body.tools['rohitg00-agentmemory'].repository, 'https://github.com/rohitg00/agentmemory');
    assert.deepEqual(result.body.tools['rohitg00-agentmemory'].packages, [
      '@agentmemory/agentmemory',
      '@agentmemory/mcp'
    ]);
    assert.match(result.body.tools['rohitg00-agentmemory'].tested_version, /isolated standalone ai-tester PASS/);
    assert.equal(
      result.body.tools['rohitg00-agentmemory'].integration_role,
      'user_owned_continuity_candidate_only'
    );
    assert.equal(
      result.body.tools['rohitg00-agentmemory'].storage_scope,
      'user_home_agentmemory_and_user_owned_runtime'
    );
    assert.equal(result.body.tools['rohitg00-agentmemory'].purge_status, 'unverified');
    assert.ok(
      result.body.tools['rohitg00-agentmemory'].forbidden_operations.includes('auto_register_mcp')
    );
    assert.equal(result.body.tools['context-mode'].codex_plugin_status, 'avoid_tested_nested_shell_stack');
    assert.equal(result.body.tools['context-mode'].mcp_only_status, 'conditional_large_truncating_output_only');
    assert.equal(result.body.tools['context-mode'].authorized_live_followup.token_savings, 'not_demonstrated');
    assert.equal(
      result.body.tools['context-mode'].authorized_live_followup.session_continuity,
      'not_run_resume_driver_parity_unavailable'
    );
    assert.equal(result.body.tools['context-mode'].normal_command_selection, 'forbidden');
    assert.equal(result.body.tools['context-mode'].auto_register_hooks, false);
    assert.deepEqual(result.body.availability_probes['context-mode'], []);
  });

  it('allows CodeGraph only as scoped manual CLI for analyze recommendations and enabled explore use', async () => {
    const metadata = await loadRecommendationMetadata({ metadataPath: REAL_METADATA });
    const codegraph = metadata.tools.codegraph;

    assert.equal(codegraph.display_name, 'CodeGraph');
    assert.equal(codegraph.decision, 'manual_cli_only');
    assert.equal(codegraph.recommendation_action, 'suggest_manual_cli_for_repo_graph_when_enabled_or_explicit');
    assert.equal(codegraph.install_policy, 'explicit_user_opt_in_only');
    assert.equal(codegraph.stable_cli, 'verified_for_version_help_status_init_index_query_uninit');
    assert.equal(codegraph.read_scope, 'explicit_project_path_verified_for_cli_init_index_status_query');
    assert.equal(codegraph.purge_path, 'codegraph uninit --force <project> verified');
    assert.deepEqual(codegraph.allowed_in, ['aif-analyze', 'aif-explore']);
    assert.ok(!codegraph.forbidden_in.includes('aif-analyze'));
    assert.ok(!codegraph.forbidden_in.includes('aif-explore'));
    assert.ok(codegraph.forbidden_in.includes('aif-implement'));
    assert.equal(metadata.tool_permissions.codegraph['aif-analyze'], 'recommend_only');
    assert.equal(metadata.tool_permissions.codegraph['aif-explore'], 'manual_purged_cli_execution');
    assert.equal(metadata.tool_permissions.codegraph.default, 'forbidden');
    assert.deepEqual(metadata.availability_probes.codegraph, [
      'codegraph --version',
      'codegraph --help',
      'codegraph status'
    ]);
    assert.match(codegraph.privacy_caveat, /\.codegraph/i);
    assert.match(codegraph.privacy_caveat, /purged/i);
  });

  it('records CodeGraph real-root lifecycle evidence for manual CLI use', async () => {
    const metadata = await loadRecommendationMetadata({ metadataPath: REAL_METADATA });
    const run = metadata.evidence_runs.find((item) => item.id === 'local-real-project-codegraph-safety-2026-05-23');

    assert.ok(run);
    assert.equal(run.install.user_requested, true);
    assert.equal(run.install.version, '0.9.3');
    assert.ok(run.not_run.includes('codegraph install'));
    assert.ok(run.not_run.includes('codegraph serve --mcp'));
    assert.equal(run.outcomes.codegraph.roots_tested, 29);
    assert.equal(run.outcomes.codegraph.lifecycle_passed, 29);
    assert.equal(run.outcomes.codegraph.command_failures, 0);
    assert.equal(run.outcomes.codegraph.query_failures, 0);
    assert.equal(run.outcomes.codegraph.protected_config_mutations, 0);
    assert.equal(run.outcomes.codegraph.leftover_codegraph_dirs, 0);
    assert.deepEqual(metadata.tools.codegraph.allowed_in, ['aif-analyze', 'aif-explore']);
  });

  it('declares explicit allowed scopes for rejected providers', async () => {
    const metadata = await loadRecommendationMetadata({ metadataPath: REAL_METADATA });

    for (const toolId of ['codex-mem', 'eagle-mem']) {
      assert.deepEqual(
        metadata.tools[toolId].allowed_in,
        [],
        `${toolId} should declare allowed_in: [] instead of relying on an absent field`
      );
      assert.ok(metadata.tools[toolId].forbidden_in.length > 0);
      assert.equal(metadata.tools[toolId].install_policy, 'do_not_auto_install');
      assert.match(metadata.tools[toolId].privacy_caveat, /\S/);
    }
  });

  it('recommends codex-agent-mem only for continuity tasks', async () => {
    const metadata = await loadRecommendationMetadata({ metadataPath: REAL_METADATA });
    const result = await buildRecommendationResult({
      metadata,
      projectShape: 'go_service',
      taskSignals: ['resume_previous_work'],
      probeRunner: async () => ({ availability: 'not_installed' })
    });

    const continuity = result.recommendations.find((item) => item.tool_id === 'codex-agent-mem');
    assert.ok(continuity);
    assert.equal(continuity.status, 'optional');
    assert.equal(continuity.availability, 'not_installed');
    assert.equal(continuity.read_scope, 'explicit_sqlite_db_path');
    assert.match(continuity.next_step, /explicit DB path/i);
  });

  it('keeps context-mode as non-configurable manual guidance for large temporary output compression', async () => {
    const metadata = await loadRecommendationMetadata({ metadataPath: REAL_METADATA });
    let probes = 0;
    const result = await buildRecommendationResult({
      metadata,
      projectShape: 'large_framework_app',
      taskSignals: ['large_command_output_compression'],
      probeRunner: async () => {
        probes += 1;
        return { availability: 'installed' };
      }
    });

    const contextMode = result.manual_guidance.find((item) => item.tool_id === 'context-mode');
    assert.ok(contextMode);
    assert.equal(result.recommendations.some((item) => item.tool_id === 'context-mode'), false);
    assert.equal(contextMode.status, 'manual_helper_only');
    assert.equal(contextMode.read_scope, 'explicit_indexed_content');
    assert.equal(contextMode.normal_command_selection, 'forbidden');
    assert.equal(contextMode.selection_policy, 'recommendation_only');
    assert.equal(contextMode.configuration_policy, 'do_not_enable');
    assert.match(contextMode.next_step, /manual user-owned MCP-only.*purge/i);
    assert.equal(probes, 0);
  });

  it('does not pass duplicate command fields to recommendation builders', async () => {
    const source = await readFile(path.join(REPO_ROOT, 'scripts', 'memory-tool-recommender.mjs'), 'utf8');
    const builderContexts = [...source.matchAll(/buildRecommendation\(toolId, tool, \{([\s\S]*?)\}\)/g)]
      .map((match) => match[1]);

    assert.ok(builderContexts.length >= 3);
    for (const context of builderContexts) {
      assert.doesNotMatch(context, /^\s*command(?:\s*:|,)/m);
    }
  });

  it('keeps context-mode recommendation-only even when project config enables it', async () => {
    const metadata = await loadRecommendationMetadata({ metadataPath: REAL_METADATA });
    let probes = 0;
    const result = await buildSelectionResult({
      metadata,
      projectShape: 'large_framework_app',
      taskSignals: ['large_command_output_compression'],
      command: 'aif-analyze',
      config: {
        source_kind: 'project_config',
        source_path: null,
        enabled_tools: ['context-mode'],
        warnings: []
      },
      probeRunner: async () => {
        probes += 1;
        return { availability: 'installed', command: 'context-mode doctor' };
      }
    });
    assert.deepEqual(result.selected_tools, []);
    assert.equal(result.not_selected_tools[0].tool_id, 'context-mode');
    assert.match(result.not_selected_tools[0].reason, /normal command selection is forbidden/i);
    assert.deepEqual(result.warnings, [{
      code: 'configured-tool-manual-guidance-only',
      tool_id: 'context-mode',
      message: 'context-mode is configured but normal command selection is forbidden; remove it from utilities.context_tools.enabled and use manual guidance only.'
    }]);
    assert.equal(probes, 0);

    const forbiddenCommand = await buildSelectionResult({
      metadata,
      projectShape: 'large_framework_app',
      taskSignals: ['large_command_output_compression'],
      command: 'aif-plan',
      config: {
        source_kind: 'project_config',
        source_path: null,
        enabled_tools: ['context-mode'],
        warnings: []
      }
    });
    assert.deepEqual(forbiddenCommand.selected_tools, []);
    assert.equal(forbiddenCommand.not_selected_tools[0].reason, 'context-mode is forbidden for aif-plan.');
    assert.equal(forbiddenCommand.warnings[0].code, 'configured-tool-manual-guidance-only');
  });

  it('keeps small microservices on rg baseline and avoids repo graph helpers', async () => {
    const metadata = await loadRecommendationMetadata({ metadataPath: REAL_METADATA });
    const result = await buildRecommendationResult({
      metadata,
      projectShape: 'small_microservice',
      taskSignals: ['exact_file_or_symbol_lookup'],
      probeRunner: async () => ({ availability: 'installed' })
    });

    assert.deepEqual(result.baseline, ['rg']);
    assert.equal(result.recommendations.some((item) => item.tool_id === 'graphify'), false);
    assert.equal(result.recommendations.some((item) => item.tool_id === 'codegraph'), false);
    assert.equal(result.recommendations.some((item) => item.tool_id === 'context-mode'), false);
    assert.ok(result.do_not_recommend.some((item) => item.tool_id === 'codex-mem'));
    assert.ok(result.do_not_recommend.some((item) => item.tool_id === 'eagle-mem'));
  });

  it('recommends CodeGraph only for screening-matched command and project labels', async () => {
    const metadata = await loadRecommendationMetadata({ metadataPath: REAL_METADATA });
    const analyzeResult = await buildRecommendationResult({
      metadata,
      projectShape: 'large_framework_app',
      taskSignals: ['architecture_or_impact_discovery'],
      command: 'aif-analyze',
      probeRunner: async (toolId) => ({
        availability: 'installed',
        command: toolId === 'codegraph' ? 'codegraph --version' : `${toolId} --version`
      })
    });
    const exploreResult = await buildRecommendationResult({
      metadata,
      projectProfile: {
        project_shape: 'small_microservice',
        languages: ['js'],
        volume: 'mini',
        complexity: 'framework',
        repo_shape: 'single_repo',
        artifact_mode: 'none'
      },
      taskSignals: ['architecture_or_impact_discovery'],
      command: 'aif-explore',
      probeRunner: async () => ({ availability: 'installed', command: 'codegraph --version' })
    });

    const analyzeCodegraph = analyzeResult.recommendations.find((item) => item.tool_id === 'codegraph');
    const exploreCodegraph = exploreResult.recommendations.find((item) => item.tool_id === 'codegraph');

    assert.equal(analyzeCodegraph, undefined);
    assert.ok(exploreCodegraph);
    assert.equal(exploreCodegraph.status, 'manual_cli_only');
    assert.equal(exploreCodegraph.permission, 'manual_purged_cli_execution');
    assert.equal(exploreCodegraph.install_policy, 'explicit_user_opt_in_only');
    assert.equal(exploreCodegraph.availability, 'installed');
    assert.match(exploreCodegraph.next_step, /screening policy matched/i);
    assert.match(exploreCodegraph.next_step, /codegraph init <project>/i);
    assert.match(exploreCodegraph.next_step, /non-empty and useful/i);
    assert.match(exploreCodegraph.next_step, /codegraph uninit --force <project>/i);
  });

  it('keeps CodeGraph out when an exact known avoid case matches the command, task, and labels', async () => {
    const metadata = await loadRecommendationMetadata({ metadataPath: REAL_METADATA });
    for (const taskSignal of ['architecture_or_impact_discovery', 'multirepo_surface_mapping']) {
      const result = await buildRecommendationResult({
        metadata,
        projectProfile: {
          project_shape: 'multirepo',
          languages: ['js'],
          volume: 'standard',
          complexity: 'framework',
          repo_shape: 'monorepo',
          artifact_mode: 'legacy_ai_factory_only'
        },
        taskSignals: [taskSignal],
        command: 'aif-explore',
        probeRunner: async () => ({ availability: 'installed', command: 'codegraph --version' })
      });

      assert.equal(result.recommendations.some((item) => item.tool_id === 'codegraph'), false);
    }
  });

  it('does not recommend tools forbidden for the current command', async () => {
    const metadata = await loadRecommendationMetadata({ metadataPath: REAL_METADATA });
    const planResult = await buildRecommendationResult({
      metadata,
      projectShape: 'large_framework_app',
      taskSignals: ['architecture_or_impact_discovery'],
      command: 'aif-plan',
      probeRunner: async () => ({ availability: 'installed', command: 'tool --version' })
    });
    const reviewResult = await buildRecommendationResult({
      metadata,
      projectShape: 'large_framework_app',
      taskSignals: ['architecture_or_impact_discovery'],
      command: 'aif-review',
      probeRunner: async () => ({ availability: 'installed', command: 'tool --version' })
    });
    const compressionForPlan = await buildRecommendationResult({
      metadata,
      projectShape: 'large_framework_app',
      taskSignals: ['large_command_output_compression'],
      command: 'aif-plan',
      probeRunner: async () => ({ availability: 'installed', command: 'tool --version' })
    });

    assert.equal(planResult.recommendations.some((item) => item.tool_id === 'graphify'), false);
    assert.equal(planResult.recommendations.some((item) => item.tool_id === 'codegraph'), false);
    assert.equal(reviewResult.recommendations.some((item) => item.tool_id === 'codegraph'), false);
    assert.equal(compressionForPlan.recommendations.some((item) => item.tool_id === 'context-mode'), false);
    for (const result of [planResult, reviewResult, compressionForPlan]) {
      assert.equal(result.recommendations.some((item) => item.permission === 'forbidden'), false);
    }
  });

  it('uses proven label evidence as an exact skill-task-label allow without bypassing command boundaries', async () => {
    const metadata = parseRecommendationMetadata(makeProvenLabelMetadataYaml());
    const allowed = await buildRecommendationResult({
      metadata,
      projectProfile: {
        project_shape: 'large_framework_app',
        languages: ['js'],
        volume: 'standard',
        complexity: 'framework',
        repo_shape: 'single_repo',
        artifact_mode: 'openspec_native'
      },
      taskSignals: ['architecture_or_impact_discovery'],
      command: 'aif-explore',
      probeRunner: async () => ({ availability: 'installed', command: 'graphify --version' })
    });
    const forbidden = await buildRecommendationResult({
      metadata,
      projectProfile: {
        project_shape: 'large_framework_app',
        languages: ['js'],
        volume: 'standard',
        complexity: 'framework',
        repo_shape: 'single_repo',
        artifact_mode: 'openspec_native'
      },
      taskSignals: ['architecture_or_impact_discovery'],
      command: 'aif-implement',
      probeRunner: async () => ({ availability: 'installed', command: 'graphify --version' })
    });

    assert.equal(
      provenLabelAllowsRequest(metadata, 'graphify', allowed.project_profile, ['architecture_or_impact_discovery'], 'aif-explore'),
      true
    );
    assert.ok(allowed.recommendations.find((item) => item.tool_id === 'graphify'));
    assert.equal(forbidden.recommendations.some((item) => item.tool_id === 'graphify'), false);
  });

  it('honors negative proven label evidence before screening-policy allow cases', async () => {
    const metadata = parseRecommendationMetadata(makeNegativeProvenLabelMetadataYaml());
    const result = await buildRecommendationResult({
      metadata,
      projectProfile: {
        project_shape: 'large_framework_app',
        languages: ['js'],
        volume: 'standard',
        complexity: 'framework',
        repo_shape: 'single_repo',
        artifact_mode: 'openspec_native'
      },
      taskSignals: ['architecture_or_impact_discovery'],
      command: 'aif-explore',
      probeRunner: async () => ({ availability: 'installed', command: 'graphify --version' })
    });

    assert.equal(
      provenLabelAvoidsRequest(metadata, 'graphify', result.project_profile, ['architecture_or_impact_discovery'], 'aif-explore'),
      true
    );
    assert.equal(result.recommendations.some((item) => item.tool_id === 'graphify'), false);
    assert.ok(result.do_not_recommend.some((item) => (
      item.tool_id === 'graphify'
      && /exact avoid evidence/.test(item.reason)
    )));
  });

  it('uses dimension signals without bypassing command-specific permissions', async () => {
    const metadata = await loadRecommendationMetadata({ metadataPath: REAL_METADATA });
    const analyzeResult = await buildRecommendationResult({
      metadata,
      projectShape: 'large_framework_app',
      projectProfile: {
        project_shape: 'large_framework_app',
        languages: ['js'],
        volume: 'large',
        complexity: 'framework',
        repo_shape: 'single_repo',
        artifact_mode: 'openspec_native'
      },
      taskSignals: ['architecture_or_impact_discovery'],
      command: 'aif-analyze',
      probeRunner: async () => ({ availability: 'installed', command: 'tool --version' })
    });
    const implementResult = await buildRecommendationResult({
      metadata,
      projectShape: 'large_framework_app',
      projectProfile: {
        project_shape: 'large_framework_app',
        languages: ['js'],
        volume: 'large',
        complexity: 'framework',
        repo_shape: 'single_repo',
        artifact_mode: 'openspec_native'
      },
      taskSignals: ['architecture_or_impact_discovery'],
      command: 'aif-implement',
      probeRunner: async () => ({ availability: 'installed', command: 'tool --version' })
    });

    assert.equal(analyzeResult.project_profile.volume, 'large');
    assert.ok(analyzeResult.dimension_matches.includes('large_framework_broad_discovery'));
    assert.equal(analyzeResult.recommendations.some((item) => item.tool_id === 'codegraph'), false);
    assert.equal(implementResult.recommendations.some((item) => item.tool_id === 'codegraph'), false);
    assert.equal(implementResult.recommendations.some((item) => item.tool_id === 'graphify'), false);
  });

  it('keeps mini Go projects on rg and records dimension-specific avoid decisions', async () => {
    const metadata = await loadRecommendationMetadata({ metadataPath: REAL_METADATA });
    const result = await buildRecommendationResult({
      metadata,
      projectShape: 'go_service',
      projectProfile: {
        project_shape: 'go_service',
        languages: ['go'],
        volume: 'mini',
        complexity: 'mini',
        repo_shape: 'single_repo',
        artifact_mode: 'none'
      },
      taskSignals: ['architecture_or_impact_discovery'],
      command: 'aif-analyze',
      probeRunner: async () => ({ availability: 'installed', command: 'tool --version' })
    });

    assert.deepEqual(result.baseline, ['rg']);
    assert.ok(result.dimension_matches.includes('mini_go_service'));
    assert.equal(result.recommendations.some((item) => item.tool_id === 'codegraph'), false);
    assert.equal(result.recommendations.some((item) => item.tool_id === 'graphify'), false);
    assert.ok(result.do_not_recommend.some((item) => item.tool_id === 'codegraph'));
    assert.ok(result.do_not_recommend.some((item) => item.tool_id === 'graphify'));
  });

  it('selects enabled tools from project config per command without prompt-specific tool lists', async () => {
    await mkdir(path.join(tmpDir, '.ai-factory'), { recursive: true });
    await writeFile(
      path.join(tmpDir, '.ai-factory', 'config.yaml'),
      [
        'utilities:',
        '  context_tools:',
        '    enabled:',
        '      - codegraph',
        '      - graphify',
        ''
      ].join('\n'),
      'utf8'
    );

    const explore = await runMemoryToolRecommender([
      'select',
      '--shape',
      'small_microservice',
      '--language',
      'js',
      '--volume',
      'mini',
      '--complexity',
      'framework',
      '--repo-shape',
      'single_repo',
      '--artifact-mode',
      'none',
      '--task',
      'architecture_or_impact_discovery',
      '--command',
      'aif-explore',
      '--metadata',
      REAL_METADATA,
      '--json'
    ], {
      cwd: tmpDir,
      stdout: [],
      stderr: [],
      exit: false,
      probeRunner: async () => ({ availability: 'installed', command: 'tool --version' })
    });
    const plan = await runMemoryToolRecommender([
      'select',
      '--shape',
      'multirepo',
      '--language',
      'js',
      '--volume',
      'standard',
      '--complexity',
      'framework',
      '--repo-shape',
      'monorepo',
      '--artifact-mode',
      'legacy_ai_factory_only',
      '--task',
      'multirepo_surface_mapping',
      '--command',
      'aif-plan',
      '--metadata',
      REAL_METADATA,
      '--json'
    ], {
      cwd: tmpDir,
      stdout: [],
      stderr: [],
      exit: false,
      probeRunner: async () => ({ availability: 'installed', command: 'tool --version' })
    });
    const implement = await runMemoryToolRecommender([
      'select',
      '--shape',
      'multirepo',
      '--language',
      'js',
      '--volume',
      'standard',
      '--complexity',
      'framework',
      '--repo-shape',
      'monorepo',
      '--artifact-mode',
      'legacy_ai_factory_only',
      '--task',
      'multirepo_surface_mapping',
      '--command',
      'aif-implement',
      '--metadata',
      REAL_METADATA,
      '--json'
    ], {
      cwd: tmpDir,
      stdout: [],
      stderr: [],
      exit: false,
      probeRunner: async () => ({ availability: 'installed', command: 'tool --version' })
    });

    assert.equal(explore.exitCode, 0);
    assert.equal(explore.body.schema, 'aifhub.memory_tools.selection_result.v1');
    assert.deepEqual(explore.body.config.enabled_tools, ['codegraph', 'graphify']);
    const exploreCodegraph = explore.body.selected_tools.find((item) => item.tool_id === 'codegraph');
    const exploreGraphify = explore.body.selected_tools.find((item) => item.tool_id === 'graphify');
    assert.ok(exploreCodegraph);
    assert.equal(exploreGraphify, undefined);
    assert.equal(exploreCodegraph.permission, 'manual_purged_cli_execution');
    const skippedExploreGraphify = explore.body.not_selected_tools.find((item) => item.tool_id === 'graphify');
    assert.ok(skippedExploreGraphify);
    assert.match(skippedExploreGraphify.reason, /not applicable|avoided/i);
    assert.match(JSON.stringify(exploreCodegraph.execution), /codegraph init <project>/);
    assert.match(JSON.stringify(exploreCodegraph.execution), /codegraph uninit --force <project>/);

    assert.equal(plan.exitCode, 0);
    assert.equal(plan.body.schema, 'aifhub.memory_tools.selection_result.v1');
    assert.equal(plan.body.selected_tools.some((item) => item.tool_id === 'graphify'), false);
    assert.equal(plan.body.selected_tools.some((item) => item.tool_id === 'codegraph'), false);
    const skippedCodegraph = plan.body.not_selected_tools.find((item) => item.tool_id === 'codegraph');
    const skippedPlanGraphify = plan.body.not_selected_tools.find((item) => item.tool_id === 'graphify');
    assert.ok(skippedCodegraph);
    assert.ok(skippedPlanGraphify);
    assert.match(skippedCodegraph.reason, /forbidden/i);
    assert.match(skippedPlanGraphify.reason, /not applicable/i);

    assert.equal(implement.exitCode, 0);
    assert.deepEqual(implement.body.selected_tools, []);
    assert.ok(implement.body.not_selected_tools.some((item) => item.tool_id === 'codegraph'));
    assert.ok(implement.body.not_selected_tools.some((item) => item.tool_id === 'graphify'));
    assert.ok(implement.body.not_selected_tools.every((item) => /forbidden|not applicable/i.test(item.reason)));
  });

  it('selects architecture context providers only through command-specific policy', async () => {
    await mkdir(path.join(tmpDir, '.ai-factory'), { recursive: true });
    await writeFile(
      path.join(tmpDir, '.ai-factory', 'config.yaml'),
      [
        'utilities:',
        '  context_tools:',
        '    enabled:',
        '      - codegraph',
        '      - graphify',
        '      - context7',
        '      - codex-agent-mem',
        '      - context-mode',
        ''
      ].join('\n'),
      'utf8'
    );

    const result = await runMemoryToolRecommender([
      'select',
      '--shape',
      'large_framework_app',
      '--language',
      'js',
      '--volume',
      'large',
      '--complexity',
      'framework',
      '--repo-shape',
      'single_repo',
      '--artifact-mode',
      'openspec_native',
      '--task',
      'architecture_or_impact_discovery',
      '--command',
      'aif-architecture',
      '--metadata',
      REAL_METADATA,
      '--json'
    ], {
      cwd: tmpDir,
      stdout: [],
      stderr: [],
      exit: false,
      probeRunner: async () => ({ availability: 'installed', command: 'tool --version' })
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.body.schema, 'aifhub.memory_tools.selection_result.v1');
    assert.deepEqual(result.body.config.enabled_tools, [
      'codegraph',
      'graphify',
      'context7',
      'codex-agent-mem',
      'context-mode'
    ]);

    const selectedIds = result.body.selected_tools.map((item) => item.tool_id);
    assert.deepEqual(selectedIds, ['context7']);
    assert.equal(result.body.selected_tools[0].permission, 'read_existing_reviewed_output');
    assert.equal(result.body.selected_tools.some((item) => item.permission === 'forbidden'), false);
    assert.deepEqual(
      result.body.warnings.filter((warning) => warning.code === 'configured-tool-manual-guidance-only'),
      [{
        code: 'configured-tool-manual-guidance-only',
        tool_id: 'context-mode',
        message: 'context-mode is configured but normal command selection is forbidden; remove it from utilities.context_tools.enabled and use manual guidance only.'
      }]
    );

    for (const toolId of ['codegraph', 'codex-agent-mem', 'context-mode']) {
      assert.equal(
        result.body.selected_tools.some((item) => item.tool_id === toolId),
        false,
        `${toolId} should not be selected for aif-architecture`
      );
      const skipped = result.body.not_selected_tools.find((item) => item.tool_id === toolId);
      assert.ok(skipped, `${toolId} should appear in not_selected_tools`);
      assert.equal(skipped.permission, 'forbidden');
      assert.match(skipped.reason, /forbidden/i, `${toolId} should be skipped by command boundary`);
    }

    const skippedGraphify = result.body.not_selected_tools.find((item) => item.tool_id === 'graphify');
    assert.ok(skippedGraphify);
    assert.equal(skippedGraphify.permission, 'read_existing_reviewed_output');
    assert.match(skippedGraphify.reason, /not applicable|avoided/i);
  });

  it('selects enabled tools from inline YAML config lists', async () => {
    await mkdir(path.join(tmpDir, '.ai-factory'), { recursive: true });
    await writeFile(
      path.join(tmpDir, '.ai-factory', 'config.yaml'),
      [
        'utilities:',
        '  context_tools:',
        '    enabled: [codegraph, graphify]',
        ''
      ].join('\n'),
      'utf8'
    );

    const result = await runMemoryToolRecommender([
      'select',
      '--shape',
      'small_microservice',
      '--language',
      'js',
      '--volume',
      'mini',
      '--complexity',
      'framework',
      '--repo-shape',
      'single_repo',
      '--artifact-mode',
      'none',
      '--task',
      'architecture_or_impact_discovery',
      '--command',
      'aif-explore',
      '--metadata',
      REAL_METADATA,
      '--json'
    ], {
      cwd: tmpDir,
      stdout: [],
      stderr: [],
      exit: false,
      probeRunner: async () => ({ availability: 'installed', command: 'tool --version' })
    });

    assert.equal(result.exitCode, 0);
    assert.deepEqual(result.body.config.enabled_tools, ['codegraph', 'graphify']);
    assert.ok(result.body.selected_tools.some((item) => item.tool_id === 'codegraph'));
    assert.equal(result.body.selected_tools.some((item) => item.tool_id === 'graphify'), false);
    assert.ok(result.body.not_selected_tools.some((item) => item.tool_id === 'graphify'));
  });

  it('selects legacy utility-enabled tools as compatibility config', async () => {
    await mkdir(path.join(tmpDir, '.ai-factory'), { recursive: true });
    await writeFile(
      path.join(tmpDir, '.ai-factory', 'config.yaml'),
      [
        'utilities:',
        '  codegraph:',
        '    enabled: true',
        ''
      ].join('\n'),
      'utf8'
    );

    const result = await runMemoryToolRecommender([
      'select',
      '--shape',
      'small_microservice',
      '--language',
      'js',
      '--volume',
      'mini',
      '--complexity',
      'framework',
      '--repo-shape',
      'single_repo',
      '--artifact-mode',
      'none',
      '--task',
      'architecture_or_impact_discovery',
      '--command',
      'aif-explore',
      '--metadata',
      REAL_METADATA,
      '--json'
    ], {
      cwd: tmpDir,
      stdout: [],
      stderr: [],
      exit: false,
      probeRunner: async () => ({ availability: 'installed', command: 'tool --version' })
    });

    assert.equal(result.exitCode, 0);
    assert.deepEqual(result.body.config.enabled_tools, ['codegraph']);
    assert.equal(result.body.config.source_kind, 'project-config');
    assert.ok(result.body.selected_tools.some((item) => item.tool_id === 'codegraph'));
  });

  it('only recommends agent-memory for explicit manual durable notes tasks', async () => {
    const metadata = await loadRecommendationMetadata({ metadataPath: REAL_METADATA });
    const withoutManualNotes = await buildRecommendationResult({
      metadata,
      projectShape: 'large_framework_app',
      taskSignals: ['architecture_or_impact_discovery'],
      probeRunner: async () => ({ availability: 'unknown' })
    });
    const withManualNotes = await buildRecommendationResult({
      metadata,
      projectShape: 'large_framework_app',
      taskSignals: ['manual_durable_notes'],
      probeRunner: async () => ({ availability: 'unknown' })
    });

    assert.equal(withoutManualNotes.recommendations.some((item) => item.tool_id === 'agent-memory'), false);
    assert.equal(withManualNotes.recommendations.some((item) => item.tool_id === 'agent-memory'), true);
  });

  it('rejects rohitg00-agentmemory for normal tasks even when project config enables it', async () => {
    const metadata = await loadRecommendationMetadata({ metadataPath: REAL_METADATA });
    const taskSignals = [
      'architecture_or_impact_discovery',
      'resume_previous_work',
      'manual_durable_notes'
    ];
    let candidateProbeCalls = 0;
    const probeRunner = async (toolId) => {
      if (toolId === 'rohitg00-agentmemory') candidateProbeCalls += 1;
      return { availability: 'unknown', command: null };
    };

    for (const taskSignal of taskSignals) {
      const recommendation = await buildRecommendationResult({
        metadata,
        projectShape: 'large_framework_app',
        taskSignals: [taskSignal],
        command: 'aif-analyze',
        probeRunner
      });

      assert.equal(
        recommendation.recommendations.some((item) => item.tool_id === 'rohitg00-agentmemory'),
        false,
        `${taskSignal}: rejected candidate must not be recommended`
      );
      assert.ok(
        recommendation.do_not_recommend.some((item) => item.tool_id === 'rohitg00-agentmemory'),
        `${taskSignal}: rejected candidate must be reported in do_not_recommend`
      );
    }

    await mkdir(path.join(tmpDir, '.ai-factory'), { recursive: true });
    await writeFile(
      path.join(tmpDir, '.ai-factory', 'config.yaml'),
      'utilities:\n  context_tools:\n    enabled: [rohitg00-agentmemory]\n',
      'utf8'
    );

    for (const taskSignal of taskSignals) {
      const selection = await runMemoryToolRecommender([
        'select',
        '--shape',
        'large_framework_app',
        '--task',
        taskSignal,
        '--command',
        'aif-analyze',
        '--metadata',
        REAL_METADATA,
        '--json'
      ], {
        cwd: tmpDir,
        stdout: [],
        stderr: [],
        exit: false,
        probeRunner
      });
      const rejected = selection.body.not_selected_tools.find(
        (item) => item.tool_id === 'rohitg00-agentmemory'
      );

      assert.equal(selection.exitCode, 0);
      assert.equal(
        selection.body.selected_tools.some((item) => item.tool_id === 'rohitg00-agentmemory'),
        false,
        `${taskSignal}: explicit config must not select rejected candidate`
      );
      assert.ok(rejected, `${taskSignal}: rejected candidate must be reported in not_selected_tools`);
      assert.match(rejected.reason, /forbidden|reject/i);
    }

    assert.equal(candidateProbeCalls, 0, 'rejected candidate must never reach an availability probe');
  });

  it('preserves existing manual-notes and read-only continuity policies', async () => {
    const metadata = await loadRecommendationMetadata({ metadataPath: REAL_METADATA });
    const manualNotes = metadata.tools['agent-memory'];
    const continuity = metadata.tools['codex-agent-mem'];

    assert.equal(manualNotes.decision, 'docs_only_manual_notes');
    assert.equal(manualNotes.integration_role, 'manual_markdown_memory');
    assert.deepEqual(manualNotes.recommended_for.tasks, ['manual_durable_notes']);
    assert.deepEqual(manualNotes.allowed_in, ['manual_notes_only']);
    assert.ok(manualNotes.forbidden_in.includes('aif-implement'));

    assert.equal(continuity.decision, 'optional');
    assert.equal(continuity.integration_role, 'read_only_continuity_memory');
    assert.equal(continuity.read_scope, 'explicit_sqlite_db_path');
    assert.ok(continuity.recommended_for.tasks.includes('resume_previous_work'));
    assert.ok(continuity.allowed_in.includes('aif-analyze'));
    assert.ok(continuity.forbidden_in.includes('aif-implement'));

    const manualResult = await buildRecommendationResult({
      metadata,
      projectShape: 'large_framework_app',
      taskSignals: ['manual_durable_notes'],
      probeRunner: async () => ({ availability: 'unknown', command: null })
    });
    const continuityResult = await buildRecommendationResult({
      metadata,
      projectShape: 'go_service',
      taskSignals: ['resume_previous_work'],
      probeRunner: async () => ({ availability: 'unknown', command: null })
    });

    assert.ok(manualResult.recommendations.some((item) => item.tool_id === 'agent-memory'));
    assert.equal(manualResult.recommendations.some((item) => item.tool_id === 'codex-agent-mem'), false);
    assert.ok(continuityResult.recommendations.some((item) => item.tool_id === 'codex-agent-mem'));
    assert.equal(continuityResult.recommendations.some((item) => item.tool_id === 'agent-memory'), false);
  });

  it('keeps understand-anything denylisted for recommendations, selection, and probes', async () => {
    const metadata = await loadRecommendationMetadata({ metadataPath: REAL_METADATA });
    let probeCalls = 0;
    const probeRunner = async (toolId) => {
      if (toolId === 'understand-anything') probeCalls += 1;
      return { availability: 'installed', command: 'understand --help' };
    };

    const recommendation = await buildRecommendationResult({
      metadata,
      projectShape: 'large_framework_app',
      taskSignals: ['explicit_graph_quality_experiment'],
      command: 'aif-explore',
      probeRunner
    });

    assert.equal(
      recommendation.recommendations.some((item) => item.tool_id === 'understand-anything'),
      false
    );
    assert.ok(
      recommendation.do_not_recommend.some((item) => item.tool_id === 'understand-anything')
    );

    const selection = await buildSelectionResult({
      metadata,
      config: {
        source_kind: 'project-config',
        source_path: path.join(tmpDir, '.ai-factory', 'config.yaml'),
        enabled_tools: ['understand-anything'],
        warnings: []
      },
      projectShape: 'large_framework_app',
      taskSignals: ['explicit_graph_quality_experiment'],
      command: 'aif-explore',
      probeRunner
    });
    const rejected = selection.not_selected_tools.find((item) => item.tool_id === 'understand-anything');

    assert.equal(selection.selected_tools.some((item) => item.tool_id === 'understand-anything'), false);
    assert.ok(rejected);
    assert.match(rejected.reason, /forbidden|reject/i);
    assert.equal(probeCalls, 0, 'source-denylisted tool must never reach an availability probe');
  });
});

function makeProvenLabelMetadataYaml() {
  return [
    'schema: aifhub.memory_tools.recommendation.v1',
    'default_policy:',
    '  baseline_tool: rg',
    '  install_policy: explicit_user_opt_in_only',
    'tools:',
    '  graphify:',
    '    display_name: Graphify',
    '    decision: manual_quality_experiment_only',
    '    allowed_in: [aif-explore]',
    '    forbidden_in: [aif-implement]',
    '    read_scope: explicit_project_path',
    '    purge_path: delete graphify-out/',
    '    screening_policy:',
    '      default_decision: avoid_by_default',
    '      conditional_cases: []',
    'skill_usage_matrix:',
    '  aif-explore:',
    '    allowed: [rg, graphify]',
    '  aif-implement:',
    '    allowed: [rg]',
    'tool_permissions:',
    '  graphify:',
    '    aif-explore: recommend_only',
    '    aif-implement: forbidden',
    'task_signals:',
    '  architecture_or_impact_discovery:',
    '    conditional: []',
    'proven_label_evidence:',
    '  - id: graphify-proven-js-standard',
    '    source_evidence: synthetic-ai-tester',
    '    scenario_id: architecture-impact-discovery',
    '    run_class: accepted_evidence',
    '    tool_id: graphify',
    '    task_scenario: architecture_or_impact_discovery',
    '    skills: [aif-explore, aif-implement]',
    '    required_labels: [js, standard, framework, single_repo, openspec_native, large_framework_app]',
    '    pairs:',
    '      total: 2',
    '      pass_pass: 2',
    '      useful: 2',
    '    decision: conditional',
    ''
  ].join('\n');
}

function makeNegativeProvenLabelMetadataYaml() {
  return [
    'schema: aifhub.memory_tools.recommendation.v1',
    'default_policy:',
    '  baseline_tool: rg',
    '  install_policy: explicit_user_opt_in_only',
    'tools:',
    '  graphify:',
    '    display_name: Graphify',
    '    decision: manual_quality_experiment_only',
    '    allowed_in: [aif-explore]',
    '    read_scope: explicit_project_path',
    '    purge_path: delete graphify-out/',
    '    screening_policy:',
    '      default_decision: avoid_by_default',
    '      conditional_cases:',
    '        - id: old-positive-screening-case',
    '          skills: [aif-explore]',
    '          tasks: [architecture_or_impact_discovery]',
    '          required_labels: [js, standard, framework, single_repo, openspec_native, large_framework_app]',
    'skill_usage_matrix:',
    '  aif-explore:',
    '    allowed: [rg, graphify]',
    'tool_permissions:',
    '  graphify:',
    '    aif-explore: recommend_only',
    'task_signals:',
    '  architecture_or_impact_discovery:',
    '    conditional: []',
    'proven_label_evidence:',
    '  - id: graphify-negative-js-standard',
    '    source_evidence: synthetic-ai-tester-negative',
    '    scenario_id: architecture-impact-discovery',
    '    run_class: accepted_evidence',
    '    tool_id: graphify',
    '    task_scenario: architecture_or_impact_discovery',
    '    skills: [aif-explore]',
    '    required_labels: [js, standard, framework, single_repo, openspec_native, large_framework_app]',
    '    pairs:',
    '      total: 2',
    '      pass_pass: 2',
    '      useful: 0',
    '    decision: avoid',
    ''
  ].join('\n');
}

describe('CLI behavior', () => {
  it('normalizes probe output through an explicit bounded public contract', async () => {
    const result = await runMemoryToolRecommender([
      'status',
      '--metadata',
      REAL_METADATA,
      '--json'
    ], {
      cwd: tmpDir,
      stdout: [],
      stderr: [],
      exit: false,
      probeRunner: async () => ({
        availability: 'unknown',
        command: 'tool --version',
        reason: 'probe_reason',
        note: 'safe note',
        raw_output: 'must-not-cross-the-status-boundary'
      })
    });

    assert.deepEqual(result.body.probes.rg, {
      availability: 'unknown',
      command: 'tool --version',
      reason: 'probe_reason',
      note: 'safe note'
    });
  });

  it('does not execute context-mode during installed-facing status', async () => {
    const result = await runMemoryToolRecommender([
      'status',
      '--metadata',
      REAL_METADATA,
      '--json'
    ], {
      cwd: tmpDir,
      stdout: [],
      stderr: [],
      exit: false
    });
    assert.equal(result.exitCode, 0);
    assert.deepEqual(result.body.probes['context-mode'], {
      availability: 'unknown',
      command: null,
      reason: 'dedicated_harness_required',
      note: 'Automatic context-mode probes are disabled because the current runtime lifecycle is not eligible.'
    });
  });

  it('uses the production-default no-probe path for rohitg00-agentmemory status', async () => {
    const metadataPath = path.join(tmpDir, 'minimal-rejected-metadata.yaml');
    await writeFile(metadataPath, [
      'schema: aifhub.memory_tools.recommendation.v1',
      'default_policy:',
      '  baseline_tool: rg',
      'tools:',
      '  rohitg00-agentmemory:',
      '    display_name: agentmemory (rohitg00)',
      '    decision: reject_default',
      '    recommendation_action: do_not_suggest_as_aifhub_provider',
      ''
    ].join('\n'), 'utf8');

    const result = await runMemoryToolRecommender([
      'status',
      '--metadata',
      metadataPath,
      '--json'
    ], {
      cwd: tmpDir,
      stdout: [],
      stderr: [],
      exit: false
    });

    assert.equal(result.exitCode, 0);
    assert.deepEqual(result.body.probes['rohitg00-agentmemory'], {
      availability: 'unknown',
      command: null
    });
  });

  it('uses the source-denylisted no-probe path for understand-anything status', async () => {
    const result = await runMemoryToolRecommender([
      'status',
      '--metadata',
      REAL_METADATA,
      '--json'
    ], {
      cwd: tmpDir,
      stdout: [],
      stderr: [],
      exit: false,
      probeRunner: async (toolId) => {
        assert.notEqual(toolId, 'understand-anything');
        return { availability: 'unknown', command: null };
      }
    });

    assert.equal(result.exitCode, 0);
    assert.deepEqual(result.body.probes['understand-anything'], {
      availability: 'unknown',
      command: null,
      note: 'Availability probe skipped by source denylist.'
    });
  });

  it('keeps broad architecture recommendation JSON on rg unless an exact tool policy matches', async () => {
    const { body: result, probedTools } = await runJsonWithDeterministicProbes([
      'recommend',
      '--shape',
      'large_framework_app',
      '--task',
      'architecture_or_impact_discovery',
      '--metadata',
      REAL_METADATA,
      '--json'
    ]);

    assert.equal(result.schema, 'aifhub.memory_tools.recommendation_result.v1');
    assert.equal(result.project_shape, 'large_framework_app');
    assert.deepEqual(result.task_signals, ['architecture_or_impact_discovery']);
    assert.equal(result.recommendations.some((item) => item.tool_id === 'graphify'), false);
    assert.deepEqual(probedTools, ['repowise']);
  });

  it('keeps command permissions while excluding Repowise outside its smoke-backed shapes', async () => {
    const { body: result, probedTools } = await runJsonWithDeterministicProbes([
      'recommend',
      '--shape',
      'small_microservice',
      '--language',
      'js',
      '--volume',
      'mini',
      '--complexity',
      'framework',
      '--repo-shape',
      'single_repo',
      '--artifact-mode',
      'none',
      '--task',
      'architecture_or_impact_discovery',
      '--command',
      'aif-explore',
      '--metadata',
      REAL_METADATA,
      '--json'
    ]);

    const codegraph = result.recommendations.find((item) => item.tool_id === 'codegraph');
    assert.ok(codegraph);
    assert.equal(codegraph.permission, 'manual_purged_cli_execution');
    assert.equal(result.recommendations.some((item) => item.tool_id === 'repowise'), false);
    assert.deepEqual(probedTools, ['codegraph']);
  });

  it('accepts explicit project dimensions in addition to legacy shape', async () => {
    const result = await runCli([
      'recommend',
      '--shape',
      'go_service',
      '--language',
      'go',
      '--volume',
      'mini',
      '--complexity',
      'mini',
      '--repo-shape',
      'single_repo',
      '--artifact-mode',
      'none',
      '--task',
      'architecture_or_impact_discovery',
      '--metadata',
      REAL_METADATA,
      '--json'
    ]);

    assert.equal(result.project_shape, 'go_service');
    assert.equal(result.project_profile.volume, 'mini');
    assert.deepEqual(result.project_profile.languages, ['go']);
    assert.ok(result.dimension_matches.includes('mini_go_service'));
    assert.equal(result.recommendations.some((item) => item.tool_id === 'codegraph'), false);
  });

  it('classifies rich project profile dimensions from project files', async () => {
    await mkdir(path.join(tmpDir, 'apps', 'api'), { recursive: true });
    await mkdir(path.join(tmpDir, 'src', 'Http', 'Controllers'), { recursive: true });
    await mkdir(path.join(tmpDir, 'openspec'), { recursive: true });
    await writeFile(path.join(tmpDir, 'go.mod'), 'module example.local/service', 'utf8');
    await writeFile(path.join(tmpDir, 'package.json'), '{"workspaces":["apps/*"]}', 'utf8');
    await writeFile(path.join(tmpDir, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n', 'utf8');
    await writeFile(path.join(tmpDir, 'composer.json'), '{"require":{"laravel/framework":"^10.0"}}', 'utf8');
    await writeFile(path.join(tmpDir, 'openspec', 'config.yaml'), 'project: example\n', 'utf8');

    const profile = await classifyProjectProfile(tmpDir);

    assert.equal(profile.project_shape, 'multirepo');
    assert.deepEqual(profile.languages.sort(), ['go', 'js', 'php']);
    assert.equal(profile.volume, 'mini');
    assert.equal(profile.complexity, 'framework');
    assert.equal(profile.repo_shape, 'monorepo');
    assert.equal(profile.artifact_mode, 'openspec_native');
  });

  it('reports available and selected labels with project evidence', async () => {
    await mkdir(path.join(tmpDir, 'apps', 'api'), { recursive: true });
    await mkdir(path.join(tmpDir, 'src', 'Http', 'Controllers'), { recursive: true });
    await mkdir(path.join(tmpDir, 'openspec'), { recursive: true });
    await writeFile(path.join(tmpDir, 'go.mod'), 'module example.local/service', 'utf8');
    await writeFile(path.join(tmpDir, 'package.json'), '{"workspaces":["apps/*"]}', 'utf8');
    await writeFile(path.join(tmpDir, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n', 'utf8');
    await writeFile(path.join(tmpDir, 'composer.json'), '{"require":{"laravel/framework":"^10.0"}}', 'utf8');
    await writeFile(path.join(tmpDir, 'openspec', 'config.yaml'), 'project: example\n', 'utf8');

    const result = await runMemoryToolRecommender([
      'labels',
      '--from-project',
      '--metadata',
      REAL_METADATA,
      '--json'
    ], {
      cwd: tmpDir,
      stdout: [],
      stderr: [],
      exit: false
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.body.schema, 'aifhub.memory_tools.labels_result.v1');
    assert.equal(result.body.metadata_available, true);
    assert.ok(result.body.available_labels.languages.includes('js'));
    assert.ok(result.body.available_labels.languages.includes('no-primary-language'));
    assert.ok(result.body.available_labels.volume.includes('standard'));
    assert.ok(result.body.available_labels.project_shape.includes('multirepo'));
    assert.ok(result.body.available_labels.task_signals.includes('architecture_or_impact_discovery'));
    assert.equal(result.body.project_profile.project_shape, 'multirepo');
    assert.deepEqual(result.body.project_profile.languages.sort(), ['go', 'js', 'php']);
    assert.ok(result.body.selected_labels.includes('go'));
    assert.ok(result.body.selected_labels.includes('js'));
    assert.ok(result.body.selected_labels.includes('php'));
    assert.ok(result.body.selected_labels.includes('mini'));
    assert.ok(result.body.selected_labels.includes('framework'));
    assert.ok(result.body.selected_labels.includes('monorepo'));
    assert.ok(result.body.selected_labels.includes('openspec_native'));
    assert.ok(result.body.selected_labels.includes('multirepo'));
    assert.equal(result.body.evidence.js.category, 'languages');
    assert.ok(result.body.evidence.js.markers.includes('package.json'));
    assert.equal(result.body.evidence.framework.category, 'complexity');
    assert.ok(result.body.evidence.framework.markers.some((marker) => marker.startsWith('src/')));
    assert.deepEqual(result.body.dimension_matches, ['mini_exact_lookup']);
    assert.equal(result.body.matched_dimension_signals[0].id, 'mini_exact_lookup');
    assert.ok(result.body.matched_dimension_signals[0].avoid_tools.includes('codegraph'));
  });

  it('lets analyze call recommend with explicit labels from labels output', async () => {
    await mkdir(path.join(tmpDir, 'src'), { recursive: true });
    await mkdir(path.join(tmpDir, '.ai-factory'), { recursive: true });
    await writeFile(path.join(tmpDir, 'package.json'), '{"name":"fixture"}', 'utf8');
    await writeFile(path.join(tmpDir, 'src', 'index.js'), 'console.log("ok");', 'utf8');
    await writeFile(path.join(tmpDir, '.ai-factory', 'config.yaml'), 'language:\n  ui: ru\n', 'utf8');

    const labels = await runMemoryToolRecommender([
      'labels',
      '--from-project',
      '--metadata',
      REAL_METADATA,
      '--json'
    ], {
      cwd: tmpDir,
      stdout: [],
      stderr: [],
      exit: false
    });
    const profile = labels.body.project_profile;
    const languageArgs = profile.languages.flatMap((language) => ['--language', language]);
    const explicitArgs = [
      'recommend',
      '--shape',
      profile.project_shape,
      ...languageArgs,
      '--volume',
      profile.volume,
      '--complexity',
      profile.complexity,
      '--repo-shape',
      profile.repo_shape,
      '--artifact-mode',
      profile.artifact_mode,
      '--task',
      'architecture_or_impact_discovery',
      '--command',
      'aif-analyze',
      '--metadata',
      REAL_METADATA,
      '--json'
    ];

    const explicit = await runMemoryToolRecommender(explicitArgs, {
      cwd: tmpDir,
      stdout: [],
      stderr: [],
      exit: false,
      probeRunner: async () => ({ availability: 'unknown', command: 'tool --version' })
    });
    const shortcut = await runMemoryToolRecommender([
      'recommend',
      '--from-project',
      '--task',
      'architecture_or_impact_discovery',
      '--command',
      'aif-analyze',
      '--metadata',
      REAL_METADATA,
      '--json'
    ], {
      cwd: tmpDir,
      stdout: [],
      stderr: [],
      exit: false,
      probeRunner: async () => ({ availability: 'unknown', command: 'tool --version' })
    });

    assert.equal(explicit.body.schema, 'aifhub.memory_tools.recommendation_result.v1');
    assert.deepEqual(explicit.body.project_profile, shortcut.body.project_profile);
    assert.deepEqual(explicit.body.dimension_matches, shortcut.body.dimension_matches);
    assert.deepEqual(
      explicit.body.recommendations.map((item) => item.tool_id),
      shortcut.body.recommendations.map((item) => item.tool_id)
    );
    assert.deepEqual(
      explicit.body.do_not_recommend.map((item) => item.tool_id),
      shortcut.body.do_not_recommend.map((item) => item.tool_id)
    );
  });

  it('ignores generated ai-factory runtime state when classifying project dimensions', async () => {
    await mkdir(path.join(tmpDir, 'src'), { recursive: true });
    await mkdir(path.join(tmpDir, '.ai-factory', 'state', 'fixture', 'nested-project'), { recursive: true });
    await mkdir(path.join(tmpDir, '.agents', 'skills', 'aif-build-automation', 'templates'), { recursive: true });
    await mkdir(path.join(tmpDir, '.codex', 'skills', 'aif-build-automation', 'templates'), { recursive: true });
    await mkdir(path.join(tmpDir, '.claude', 'skills', 'aif-build-automation', 'templates'), { recursive: true });
    await mkdir(path.join(tmpDir, '.opencode', 'skills', 'aif-build-automation', 'templates'), { recursive: true });
    await mkdir(path.join(tmpDir, '.github', 'skills', 'aif-build-automation', 'templates'), { recursive: true });
    await mkdir(path.join(tmpDir, '.github', 'workflows'), { recursive: true });
    await mkdir(path.join(tmpDir, '.vscode'), { recursive: true });
    await mkdir(path.join(tmpDir, '.idea'), { recursive: true });
    await writeFile(path.join(tmpDir, 'package.json'), '{"name":"fixture"}', 'utf8');
    await writeFile(path.join(tmpDir, 'src', 'index.js'), 'console.log("ok");', 'utf8');
    await writeFile(path.join(tmpDir, '.ai-factory', 'config.yaml'), 'tools:\n  enabled: []\n', 'utf8');
    await writeFile(path.join(tmpDir, '.ai-factory', 'state', 'fixture', 'nested-project', 'package.json'), '{"name":"noise"}', 'utf8');
    await writeFile(path.join(tmpDir, '.ai-factory', 'state', 'fixture', 'nested-project', 'go.mod'), 'module noise.local', 'utf8');
    await writeFile(path.join(tmpDir, '.agents', 'skills', 'aif-build-automation', 'templates', 'magefile.go'), 'package main', 'utf8');
    await writeFile(path.join(tmpDir, '.codex', 'skills', 'aif-build-automation', 'templates', 'magefile.go'), 'package main', 'utf8');
    await writeFile(path.join(tmpDir, '.claude', 'skills', 'aif-build-automation', 'templates', 'magefile.go'), 'package main', 'utf8');
    await writeFile(path.join(tmpDir, '.opencode', 'skills', 'aif-build-automation', 'templates', 'magefile.go'), 'package main', 'utf8');
    await writeFile(path.join(tmpDir, '.github', 'skills', 'aif-build-automation', 'templates', 'magefile.go'), 'package main', 'utf8');
    await writeFile(path.join(tmpDir, '.github', 'workflows', 'validate.yml'), 'name: validate\n', 'utf8');
    await writeFile(path.join(tmpDir, '.vscode', 'settings.json'), '{"deno.enable":true}', 'utf8');
    await writeFile(path.join(tmpDir, '.idea', 'workspace.xml'), '<project />', 'utf8');
    await writeFile(path.join(tmpDir, 'AGENTS.md'), 'agent instructions\n', 'utf8');
    await writeFile(path.join(tmpDir, 'CLAUDE.md'), 'claude instructions\n', 'utf8');

    const profile = await classifyProjectProfile(tmpDir);

    assert.equal(profile.repo_shape, 'single_repo');
    assert.equal(profile.artifact_mode, 'legacy_ai_factory_only');
    assert.deepEqual(profile.languages, ['js']);
  });

  it('honors project ignore files when classifying project dimensions', async () => {
    await mkdir(path.join(tmpDir, 'src'), { recursive: true });
    await mkdir(path.join(tmpDir, 'generated', 'go-service'), { recursive: true });
    await mkdir(path.join(tmpDir, 'docker-noise', 'backend'), { recursive: true });
    await mkdir(path.join(tmpDir, 'tools', 'noise'), { recursive: true });
    await writeFile(path.join(tmpDir, 'package.json'), '{"name":"fixture"}', 'utf8');
    await writeFile(path.join(tmpDir, 'src', 'index.ts'), 'export const ok = true;\n', 'utf8');
    await writeFile(path.join(tmpDir, '.gitignore'), 'generated/\n*.tmp.go\n', 'utf8');
    await writeFile(path.join(tmpDir, '.dockerignore'), 'docker-noise/\n', 'utf8');
    await writeFile(path.join(tmpDir, 'tools', '.gitignore'), 'noise/\n', 'utf8');
    await writeFile(path.join(tmpDir, 'generated', 'go-service', 'go.mod'), 'module ignored.local', 'utf8');
    await writeFile(path.join(tmpDir, 'generated', 'unused.tmp.go'), 'package main', 'utf8');
    await writeFile(path.join(tmpDir, 'docker-noise', 'backend', 'requirements.txt'), 'fastapi\n', 'utf8');
    await writeFile(path.join(tmpDir, 'tools', 'noise', 'Cargo.toml'), '[package]\nname="noise"\n', 'utf8');

    const result = await runMemoryToolRecommender([
      'labels',
      '--from-project',
      '--metadata',
      REAL_METADATA,
      '--json'
    ], {
      cwd: tmpDir,
      stdout: [],
      stderr: [],
      exit: false
    });

    assert.equal(result.exitCode, 0);
    assert.deepEqual(result.body.project_profile.languages, ['js']);
    assert.equal(result.body.project_profile.repo_shape, 'single_repo');
    assert.ok(!result.body.selected_labels.includes('go'));
    assert.ok(!result.body.selected_labels.includes('python'));
    assert.ok(!result.body.selected_labels.includes('rust'));
    assert.ok(result.body.evidence.js.markers.includes('package.json'));
    assert.ok(result.body.evidence.js.markers.includes('src/index.ts'));
    assert.ok(!result.body.evidence.js.markers.some((marker) => marker.startsWith('generated/')));
  });

  it('degrades recommend output when metadata is unavailable', async () => {
    const result = await runMemoryToolRecommender([
      'recommend',
      '--shape',
      'large_framework_app',
      '--metadata',
      path.join(tmpDir, 'missing.yaml'),
      '--json'
    ], {
      cwd: tmpDir,
      stdout: [],
      stderr: [],
      exit: false
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.body.schema, 'aifhub.memory_tools.recommendation_result.v1');
    assert.equal(result.body.metadata_available, false);
    assert.deepEqual(result.body.baseline, ['rg']);
    assert.deepEqual(result.body.recommendations, []);
    assert.ok(result.body.warnings.some((warning) => /metadata unavailable/i.test(warning.message)));
  });

  it('reports safe probe failures as unknown or not_installed without failing recommendations', async () => {
    const metadata = await loadRecommendationMetadata({ metadataPath: REAL_METADATA });
    const result = await buildRecommendationResult({
      metadata,
      projectShape: 'large_framework_app',
      taskSignals: ['explicit_graph_quality_experiment'],
      probeRunner: async () => ({ availability: 'not_installed', command: 'graphify --version' })
    });

    const graphify = result.recommendations.find((item) => item.tool_id === 'graphify');
    assert.ok(graphify);
    assert.equal(graphify.availability, 'not_installed');
  });

  it('classifies Windows shell fallback failures only from explicit not-found output', () => {
    assert.equal(
      isWindowsShellCommandNotFound("'codegraph' is not recognized as an internal or external command."),
      true
    );
    assert.equal(
      isWindowsShellCommandNotFound('Error: project index is missing. Run codegraph init first.'),
      false
    );
    assert.equal(
      isWindowsShellCommandNotFound('The CLI returned exit code 1 because workspace state is invalid.'),
      false
    );
  });

  it('detects Windows npm command shims during status probes', { skip: process.platform !== 'win32' }, async () => {
    await writeFile(
      path.join(tmpDir, 'codegraph.cmd'),
      '@echo off\r\necho 0.9.3\r\nexit /b 0\r\n',
      'utf8'
    );

    const previousPath = process.env.PATH;
    process.env.PATH = `${tmpDir}${path.delimiter}${previousPath}`;
    try {
      const result = await runMemoryToolRecommender([
        'status',
        '--metadata',
        REAL_METADATA,
        '--json'
      ], {
        cwd: REPO_ROOT,
        stdout: [],
        stderr: [],
        exit: false
      });

      assert.equal(result.exitCode, 0);
      assert.equal(result.body.probes.codegraph.availability, 'installed');
      assert.equal(result.body.probes.codegraph.command, 'codegraph --version');
    } finally {
      process.env.PATH = previousPath;
    }
  });
});
