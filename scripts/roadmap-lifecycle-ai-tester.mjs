// roadmap-lifecycle-ai-tester.mjs - reproducible paired workflow prompt evaluation
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { runBoundedProcess } from './context-mode-codex-ai-tester-adapter.mjs';
import { writeCodexReasoningWrapper } from './context-mode-codex-ai-tester-matrix.mjs';

const execFileAsync = promisify(execFile);

export const ROADMAP_LIFECYCLE_CATALOG_SCHEMA = 'aifhub.roadmap_lifecycle.ai_tester_catalog.v1';
export const ROADMAP_LIFECYCLE_MATRIX_SCHEMA = 'aifhub.roadmap_lifecycle.ai_tester_matrix.v1';
export const ROADMAP_LIFECYCLE_RESULTS_SCHEMA = 'aifhub.roadmap_lifecycle.ai_tester_results.v1';
export const ROADMAP_LIFECYCLE_CONDITIONS = Object.freeze(['baseline', 'refined']);

const DEFAULT_CATALOG = path.join('docs', 'roadmap-lifecycle-ai-tester', 'scenario-catalog.json');
const EXPECTED_SCENARIOS = Object.freeze([
  'issue-linked-planning',
  'successful-done',
  'failed-done-no-roadmap-write',
  'finalized-state-commit-blocking',
  'post-merge-github-reconciliation'
]);
const SAFE_ASSERTION_TYPES = new Set(['output_contains', 'no_output_contains']);

export async function loadRoadmapLifecycleCatalog({
  catalogPath = DEFAULT_CATALOG,
  cwd = process.cwd()
} = {}) {
  const resolved = path.resolve(cwd, catalogPath);
  const catalog = JSON.parse(await readFile(resolved, 'utf8'));
  const errors = validateRoadmapLifecycleCatalog(catalog);
  if (errors.length > 0) {
    throw workflowError('invalid_catalog', errors.join('; '));
  }
  return { ...catalog, source_path: toProjectPath(cwd, resolved) };
}

export function validateRoadmapLifecycleCatalog(catalog = {}) {
  const errors = [];
  if (catalog.schema !== ROADMAP_LIFECYCLE_CATALOG_SCHEMA) {
    errors.push(`schema must be ${ROADMAP_LIFECYCLE_CATALOG_SCHEMA}`);
  }

  if (!/^[a-f0-9]{40}$/.test(String(catalog.baseline?.source_commit ?? ''))) {
    errors.push('baseline.source_commit must be a full lowercase git commit');
  }
  if (!cleanText(catalog.baseline?.description)) {
    errors.push('baseline.description must be sanitized text');
  }

  const defaults = catalog.defaults ?? {};
  if (defaults.runtime !== 'codex') errors.push('defaults.runtime must be codex');
  if (defaults.model !== 'gpt-5.6-luna') errors.push('defaults.model must be gpt-5.6-luna');
  if (defaults.reasoning !== 'low') errors.push('defaults.reasoning must be low');
  if (!sameArray(defaults.conditions, ROADMAP_LIFECYCLE_CONDITIONS)) {
    errors.push(`defaults.conditions must be ${ROADMAP_LIFECYCLE_CONDITIONS.join(', ')}`);
  }
  if (!Number.isInteger(defaults.max_turns) || defaults.max_turns < 1 || defaults.max_turns > 4) {
    errors.push('defaults.max_turns must be an integer from 1 to 4');
  }
  if (!Number.isInteger(defaults.timeout_seconds) || defaults.timeout_seconds < 30 || defaults.timeout_seconds > 600) {
    errors.push('defaults.timeout_seconds must be an integer from 30 to 600');
  }

  const runner = catalog.runner ?? {};
  if (!/^[a-f0-9]{40}$/.test(String(runner.source_commit ?? ''))) {
    errors.push('runner.source_commit must be a full lowercase git commit');
  }
  if (!/^ai-tester \d+\.\d+\.\d+$/.test(String(runner.version ?? ''))) {
    errors.push('runner.version must be an ai-tester semver line');
  }
  if (!/^[a-f0-9]{64}$/.test(String(runner.binary_sha256 ?? ''))) {
    errors.push('runner.binary_sha256 must be a lowercase SHA-256');
  }
  if (runner.reasoning_enforcement !== 'codex_wrapper_model_reasoning_effort_low') {
    errors.push('runner.reasoning_enforcement must pin the low-reasoning Codex wrapper');
  }

  const scenarios = asArray(catalog.scenarios);
  if (!sameArray(scenarios.map((scenario) => scenario?.id), EXPECTED_SCENARIOS)) {
    errors.push(`scenarios must be ${EXPECTED_SCENARIOS.join(', ')}`);
  }
  const seen = new Set();
  for (const [index, scenario] of scenarios.entries()) {
    const prefix = `scenarios[${index}]`;
    if (!safeId(scenario.id)) errors.push(`${prefix}.id must be lowercase kebab-safe`);
    if (seen.has(scenario.id)) errors.push(`${prefix}.id duplicates ${scenario.id}`);
    seen.add(scenario.id);
    if (!safeRelativePath(scenario.source)) errors.push(`${prefix}.source must be project-relative`);
    if (!cleanText(scenario.user_prompt)) errors.push(`${prefix}.user_prompt contains private-looking material`);
    const labels = asArray(scenario.response_labels);
    if (labels.length < 2 || labels.some((label) => !/^[a-z][a-z0-9_]*$/.test(String(label)))) {
      errors.push(`${prefix}.response_labels must contain safe labels`);
    }
    if (new Set(labels).size !== labels.length) errors.push(`${prefix}.response_labels must be unique`);
    for (const condition of ROADMAP_LIFECYCLE_CONDITIONS) {
      if (!cleanText(scenario.policies?.[condition])) {
        errors.push(`${prefix}.policies.${condition} contains private-looking material`);
      }
    }
    const assertions = asArray(scenario.assertions);
    if (assertions.length < 1) errors.push(`${prefix}.assertions must not be empty`);
    const assertionIds = new Set();
    for (const [assertionIndex, assertion] of assertions.entries()) {
      const assertionPrefix = `${prefix}.assertions[${assertionIndex}]`;
      if (!safeId(assertion.id)) errors.push(`${assertionPrefix}.id must be lowercase kebab-safe`);
      if (assertionIds.has(assertion.id)) errors.push(`${assertionPrefix}.id must be unique`);
      assertionIds.add(assertion.id);
      if (!SAFE_ASSERTION_TYPES.has(assertion.type)) {
        errors.push(`${assertionPrefix}.type is unsupported`);
      }
      if (!cleanText(assertion.pattern)) errors.push(`${assertionPrefix}.pattern contains private-looking material`);
    }
  }
  return errors;
}

export function buildRoadmapLifecycleMatrix({
  catalog,
  provenance,
  runId,
  generatedAt = new Date().toISOString()
} = {}) {
  const errors = validateRoadmapLifecycleCatalog(catalog);
  if (errors.length > 0) throw workflowError('invalid_catalog', errors.join('; '));
  if (!safeRunId(runId)) throw workflowError('invalid_run_id');
  validateProvenance(provenance, catalog.runner);

  const rows = [];
  for (const scenario of catalog.scenarios) {
    const baseSettings = {
      catalog_schema: catalog.schema,
      baseline_source_commit: catalog.baseline.source_commit,
      scenario_id: scenario.id,
      source: scenario.source,
      user_prompt: scenario.user_prompt,
      response_labels: scenario.response_labels,
      assertions: scenario.assertions,
      runtime: catalog.defaults.runtime,
      model: catalog.defaults.model,
      reasoning: catalog.defaults.reasoning,
      max_turns: catalog.defaults.max_turns,
      timeout_seconds: catalog.defaults.timeout_seconds,
      provenance: boundedProvenance(provenance)
    };
    const settingsFingerprint = sha256(stableStringify(baseSettings));
    for (const condition of ROADMAP_LIFECYCLE_CONDITIONS) {
      const id = `${runId}__${scenario.id}__${condition}`;
      const policy = scenario.policies[condition];
      const scenarioFingerprint = sha256(stableStringify({
        ...baseSettings,
        condition,
        policy
      }));
      rows.push({
        id,
        scenario_id: scenario.id,
        condition,
        source: scenario.source,
        runtime: catalog.defaults.runtime,
        model: catalog.defaults.model,
        reasoning: catalog.defaults.reasoning,
        max_turns: catalog.defaults.max_turns,
        timeout_seconds: catalog.defaults.timeout_seconds,
        user_prompt: scenario.user_prompt,
        response_labels: [...scenario.response_labels],
        policy,
        assertions: buildAssertions(scenario, catalog.defaults.max_turns),
        settings_fingerprint: settingsFingerprint,
        scenario_fingerprint: scenarioFingerprint,
        prompt_file: toPosix(path.join('prompts', `${id}.md`)),
        scenario_file: toPosix(path.join('scenarios', `${id}.yaml`))
      });
    }
  }

  return {
    schema: ROADMAP_LIFECYCLE_MATRIX_SCHEMA,
    generated_at: generatedAt,
    run_id: runId,
    catalog_schema: catalog.schema,
    baseline_source_commit: catalog.baseline.source_commit,
    runtime: catalog.defaults.runtime,
    model: catalog.defaults.model,
    reasoning: catalog.defaults.reasoning,
    conditions: [...ROADMAP_LIFECYCLE_CONDITIONS],
    provenance: boundedProvenance(provenance),
    rows
  };
}

export async function generateRoadmapLifecycleMatrix({
  catalogPath = DEFAULT_CATALOG,
  outDir,
  provenance,
  runId,
  cwd = process.cwd(),
  dryRun = false
} = {}) {
  if (!outDir) throw workflowError('out_dir_required');
  const catalog = await loadRoadmapLifecycleCatalog({ catalogPath, cwd });
  const matrix = buildRoadmapLifecycleMatrix({ catalog, provenance, runId });
  if (dryRun) return { matrix, written_files: [], dry_run: true };

  const resolvedOut = path.resolve(cwd, outDir);
  await mkdir(path.join(resolvedOut, 'prompts'), { recursive: true });
  await mkdir(path.join(resolvedOut, 'scenarios'), { recursive: true });
  await mkdir(path.join(resolvedOut, 'runs'), { recursive: true });
  const writtenFiles = [];
  await writeTracked(
    path.join(resolvedOut, '.ai-tester.yaml'),
    renderAiTesterConfig(matrix),
    resolvedOut,
    writtenFiles
  );
  await writeTracked(
    path.join(resolvedOut, 'matrix-summary.json'),
    `${JSON.stringify(matrix, null, 2)}\n`,
    resolvedOut,
    writtenFiles
  );
  for (const row of matrix.rows) {
    await writeTracked(
      path.join(resolvedOut, fromPosix(row.prompt_file)),
      renderSystemPrompt(row),
      resolvedOut,
      writtenFiles
    );
    await writeTracked(
      path.join(resolvedOut, fromPosix(row.scenario_file)),
      renderScenarioYaml(row),
      resolvedOut,
      writtenFiles
    );
  }
  return { matrix, written_files: writtenFiles, dry_run: false };
}

export async function inspectRoadmapLifecycleRunner({
  catalog,
  aiTesterRoot,
  aiTesterExecutable,
  codexExecutable
} = {}) {
  if (![aiTesterRoot, aiTesterExecutable, codexExecutable].every((value) => path.isAbsolute(String(value ?? '')))) {
    throw workflowError('explicit_absolute_executables_required');
  }
  const [{ stdout: commitOut }, { stdout: statusOut }, binary] = await Promise.all([
    execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: aiTesterRoot, windowsHide: true }),
    execFileAsync('git', ['status', '--porcelain'], { cwd: aiTesterRoot, windowsHide: true }),
    readFile(aiTesterExecutable)
  ]);
  if (statusOut.trim()) throw workflowError('ai_tester_source_dirty');

  const aiTesterVersion = await runBoundedProcess(aiTesterExecutable, ['--version'], {
    cwd: aiTesterRoot,
    env: process.env,
    timeoutMs: 15_000,
    outputCapBytes: 2048
  });
  if (aiTesterVersion.exitCode !== 0) throw workflowError('ai_tester_version_probe_failed');
  const codexVersion = await runBoundedProcess(codexExecutable, ['--version'], {
    cwd: aiTesterRoot,
    env: process.env,
    timeoutMs: 15_000,
    outputCapBytes: 2048
  });
  if (codexVersion.exitCode !== 0) throw workflowError('codex_version_probe_failed');

  const provenance = {
    ai_tester_source_commit: firstLine(commitOut),
    ai_tester_binary_sha256: createHash('sha256').update(binary).digest('hex'),
    ai_tester_version: firstLine(aiTesterVersion.stdout || aiTesterVersion.stderr),
    codex_version: firstLine(codexVersion.stdout || codexVersion.stderr),
    reasoning_enforcement: 'codex_wrapper_model_reasoning_effort_low'
  };
  validateProvenance(provenance, catalog.runner);
  return provenance;
}

export async function executeRoadmapLifecycleMatrix({
  catalogPath = DEFAULT_CATALOG,
  outDir,
  runId,
  aiTesterRoot,
  aiTesterExecutable,
  codexExecutable,
  cwd = process.cwd(),
  runProcess = runBoundedProcess
} = {}) {
  assertTempOutputDescendant(outDir, cwd);
  const catalog = await loadRoadmapLifecycleCatalog({ catalogPath, cwd });
  const provenance = await inspectRoadmapLifecycleRunner({
    catalog,
    aiTesterRoot,
    aiTesterExecutable,
    codexExecutable
  });
  const generated = await generateRoadmapLifecycleMatrix({
    catalogPath,
    outDir,
    provenance,
    runId,
    cwd
  });
  const resolvedOut = path.resolve(cwd, outDir);
  const wrapperDir = path.join(resolvedOut, '.runner-bin');
  const proofPath = path.join(resolvedOut, 'reasoning-proof.jsonl');
  await writeCodexReasoningWrapper({ outDir: wrapperDir, realCodex: codexExecutable });
  const originalPath = process.env.Path ?? process.env.PATH ?? '';
  const env = {
    ...process.env,
    Path: `${wrapperDir}${path.delimiter}${originalPath}`,
    PATH: `${wrapperDir}${path.delimiter}${originalPath}`,
    CONTEXT_MODE_REASONING_PROOF: proofPath,
    NO_COLOR: '1'
  };

  for (const [index, row] of generated.matrix.rows.entries()) {
    const dryRunInvocation = buildRoadmapLifecycleInvocation(row, {
      matrixDir: resolvedOut,
      dryRun: true
    });
    const dryRunResult = await runProcess(aiTesterExecutable, dryRunInvocation.args, {
      cwd: resolvedOut,
      env,
      timeoutMs: 30_000,
      outputCapBytes: 16 * 1024
    });
    if (dryRunResult.exitCode !== 0) throw workflowError('scenario_dry_run_failed', row.id);
    process.stderr.write(`${JSON.stringify({
      component: 'roadmap-lifecycle-ai-tester',
      event: 'row.dry_run.complete',
      row: index + 1,
      rows: generated.matrix.rows.length,
      scenario_id: row.scenario_id,
      condition: row.condition
    })}\n`);

    const invocation = buildRoadmapLifecycleInvocation(row, { matrixDir: resolvedOut });
    const result = await runProcess(aiTesterExecutable, invocation.args, {
      cwd: resolvedOut,
      env,
      timeoutMs: row.timeout_seconds * 1000,
      outputCapBytes: 32 * 1024
    });
    process.stderr.write(`${JSON.stringify({
      component: 'roadmap-lifecycle-ai-tester',
      event: 'row.complete',
      row: index + 1,
      rows: generated.matrix.rows.length,
      scenario_id: row.scenario_id,
      condition: row.condition,
      exit_code: result.exitCode,
      output_truncated: result.stdout_truncated || result.stderr_truncated
    })}\n`);
  }

  const [traces, reasoningProof] = await Promise.all([
    readTraceRecords(path.join(resolvedOut, 'runs')),
    readReasoningProof(proofPath)
  ]);
  return buildRoadmapLifecycleAggregate({
    matrix: generated.matrix,
    traces,
    reasoningProof
  });
}

export function buildRoadmapLifecycleInvocation(row, {
  matrixDir,
  dryRun = false
} = {}) {
  if (!path.isAbsolute(String(matrixDir ?? ''))) throw workflowError('absolute_matrix_dir_required');
  const args = [
    'run',
    '--file', path.join(matrixDir, fromPosix(row.scenario_file)),
    '--runtime', row.runtime,
    '--model', row.model,
    '--reasoning', row.reasoning,
    '--filter', `^${escapeRegex(row.id)}$`,
    '--quiet'
  ];
  if (dryRun) args.push('--dry-run');
  return { args };
}

export function buildRoadmapLifecycleAggregate({
  matrix,
  traces,
  reasoningProof,
  generatedAt = new Date().toISOString()
} = {}) {
  if (matrix?.schema !== ROADMAP_LIFECYCLE_MATRIX_SCHEMA || !Array.isArray(matrix.rows)) {
    throw workflowError('invalid_matrix');
  }
  const proofPass = Array.isArray(reasoningProof) &&
    reasoningProof.length === matrix.rows.length &&
    reasoningProof.every((record) => record?.phase === 'initial' && record?.profile === 'low');
  const traceByScenario = new Map();
  for (const trace of asArray(traces)) {
    const name = String(trace?.scenario?.name ?? '');
    if (name && !traceByScenario.has(name)) traceByScenario.set(name, trace);
    else if (name) traceByScenario.set(name, null);
  }

  const results = matrix.rows.map((row) => {
    const trace = traceByScenario.get(row.id);
    const base = {
      scenario_id: row.scenario_id,
      condition: row.condition,
      scenario_fingerprint: row.scenario_fingerprint,
      settings_fingerprint: row.settings_fingerprint,
      model: row.model,
      reasoning: row.reasoning,
      reasoning_proof: proofPass ? 'PASS' : 'NOT_RUN',
      assertions: { passed: 0, total: row.assertions.length },
      failed_assertion_ids: [],
      turns: null,
      tokens: emptyTokens()
    };
    if (!trace) return { ...base, status: 'NOT_RUN', reason: trace === null ? 'duplicate_trace' : 'trace_missing' };
    if (trace.runner?.runtime !== row.runtime || trace.runner?.model !== row.model ||
        trace.runner?.reasoning !== row.reasoning) {
      return { ...base, status: 'NOT_RUN', reason: 'runtime_settings_mismatch' };
    }
    if (!proofPass) return { ...base, status: 'NOT_RUN', reason: 'reasoning_profile_unproven' };
    const assertions = asArray(trace.assertions);
    const passed = assertions.filter((assertion) => assertion?.pass === true).length;
    const expectedAssertionIds = new Set([
      ...row.assertions.map((assertion) => assertion.id),
      'no_unanswered_questions',
      'token_budget'
    ]);
    const failedAssertionIds = assertions
      .filter((assertion) => assertion?.pass === false && expectedAssertionIds.has(assertion?.id))
      .map((assertion) => assertion.id)
      .sort();
    const tokens = normalizeTokens(trace.cost);
    const common = {
      ...base,
      assertions: { passed, total: assertions.length },
      failed_assertion_ids: failedAssertionIds,
      turns: nonNegativeInteger(trace.runner?.turnsUsed),
      tokens
    };
    if (asArray(trace.errors).length > 0 || typeof trace.scoring?.overallPass !== 'boolean') {
      return { ...common, status: 'NOT_RUN', reason: 'runtime_error' };
    }
    return trace.scoring.overallPass
      ? { ...common, status: 'PASS', reason: 'all_assertions_passed' }
      : { ...common, status: 'FAIL', reason: 'assertion_failure' };
  });

  const byCondition = Object.fromEntries(ROADMAP_LIFECYCLE_CONDITIONS.map((condition) => [
    condition,
    statusCounts(results.filter((row) => row.condition === condition))
  ]));
  const tokenTotals = Object.fromEntries(ROADMAP_LIFECYCLE_CONDITIONS.map((condition) => [
    condition,
    sumTokens(results.filter((row) => row.condition === condition).map((row) => row.tokens))
  ]));
  const pairDeltas = { improved: 0, regressed: 0, unchanged: 0 };
  for (const scenarioId of new Set(results.map((row) => row.scenario_id))) {
    const baseline = results.find((row) => row.scenario_id === scenarioId && row.condition === 'baseline');
    const refined = results.find((row) => row.scenario_id === scenarioId && row.condition === 'refined');
    if (baseline?.status !== 'PASS' && refined?.status === 'PASS') pairDeltas.improved += 1;
    else if (baseline?.status === 'PASS' && refined?.status !== 'PASS') pairDeltas.regressed += 1;
    else pairDeltas.unchanged += 1;
  }

  const aggregate = {
    schema: ROADMAP_LIFECYCLE_RESULTS_SCHEMA,
    generated_at: generatedAt,
    run_id: matrix.run_id,
    baseline_source_commit: matrix.baseline_source_commit,
    runtime: matrix.runtime,
    model: matrix.model,
    reasoning: matrix.reasoning,
    reasoning_enforcement: {
      status: proofPass ? 'PASS' : 'NOT_RUN',
      reason: proofPass ? 'low_profile_proven_for_every_run' : 'reasoning_profile_unproven'
    },
    provenance: boundedProvenance(matrix.provenance),
    summary: {
      scenarios: new Set(results.map((row) => row.scenario_id)).size,
      runs: results.length,
      by_condition: byCondition,
      pair_deltas: pairDeltas,
      tokens: tokenTotals
    },
    results,
    retention: {
      raw_traces_committed: false,
      raw_transcripts_committed: false,
      credentials_committed: false,
      retained_artifacts: ['scenario-catalog.json', 'results.json', 'results.md']
    }
  };
  const serialized = JSON.stringify(aggregate);
  if (containsPrivateMaterial(serialized) || /finalOutput|sandboxPath|sessionId|toolCallSummary/.test(serialized)) {
    throw workflowError('unsafe_aggregate');
  }
  return aggregate;
}

export function renderRoadmapLifecycleMarkdown(report = {}) {
  if (report.schema !== ROADMAP_LIFECYCLE_RESULTS_SCHEMA) throw workflowError('invalid_results');
  const rows = [];
  for (const scenarioId of new Set(report.results.map((row) => row.scenario_id))) {
    const baseline = report.results.find((row) => row.scenario_id === scenarioId && row.condition === 'baseline');
    const refined = report.results.find((row) => row.scenario_id === scenarioId && row.condition === 'refined');
    rows.push(
      `| \`${scenarioId}\` | ${formatStatus(baseline)} | ${formatStatus(refined)} | ` +
      `\`${shortHash(baseline?.scenario_fingerprint)}\` / \`${shortHash(refined?.scenario_fingerprint)}\` | ` +
      `${baseline?.tokens?.total ?? 0} / ${refined?.tokens?.total ?? 0} | ` +
      `${formatFailedAssertions(baseline)} / ${formatFailedAssertions(refined)} |`
    );
  }
  const baseline = report.summary.by_condition.baseline;
  const refined = report.summary.by_condition.refined;
  const bt = report.summary.tokens.baseline;
  const rt = report.summary.tokens.refined;
  return [
    '# Roadmap Lifecycle ai-tester Results',
    '',
    `- Run: \`${report.run_id}\``,
    `- Runtime/model/reasoning: \`${report.runtime}\` / \`${report.model}\` / \`${report.reasoning}\``,
    `- Reasoning enforcement: \`${report.reasoning_enforcement.status}\` (` +
      '`model_reasoning_effort="low"` через изолированный Codex wrapper)',
    `- ai-tester: \`${report.provenance.ai_tester_version}\`, source \`${shortHash(report.provenance.ai_tester_source_commit)}\`, binary \`${shortHash(report.provenance.ai_tester_binary_sha256)}\``,
    `- Codex: \`${report.provenance.codex_version}\``,
    `- Baseline: ${baseline.pass} PASS, ${baseline.fail} FAIL, ${baseline.not_run} NOT_RUN; tokens ${bt.total} (input ${bt.input}, output ${bt.output}, cache-read ${bt.cache_read}).`,
    `- Refined: ${refined.pass} PASS, ${refined.fail} FAIL, ${refined.not_run} NOT_RUN; tokens ${rt.total} (input ${rt.input}, output ${rt.output}, cache-read ${rt.cache_read}).`,
    `- Pair delta: ${report.summary.pair_deltas.improved} improved, ${report.summary.pair_deltas.regressed} regressed, ${report.summary.pair_deltas.unchanged} unchanged.`,
    '- Сырые trace, model output, sandbox paths, session IDs и credentials не сохранены в репозитории.',
    '',
    '## Reproduction',
    '',
    'Используйте clean checkout и executable с указанными выше commit/SHA-256. `<os-temp-child>` должен быть новым дочерним каталогом системного temp:',
    '',
    '`node scripts/roadmap-lifecycle-ai-tester.mjs --execute --out <os-temp-child> --run-id <run-id> --ai-tester-root <ai-tester-checkout> --ai-tester <ai-tester-executable> --codex <native-codex-executable> --cleanup --json`',
    '',
    '| Scenario | Baseline | Refined | Scenario fingerprints | Tokens baseline/refined | Failed assertions baseline/refined |',
    '| --- | --- | --- | --- | ---: | --- |',
    ...rows,
    '',
    'Статус строки — результат полного набора декларативных assertions для соответствующего arm. `FAIL` у baseline означает отсутствие нового workflow contract, а не ошибку runner.',
    '`FAIL` у refined фиксирует недоказанный strict output contract в этом model run; deterministic prompt/runtime tests проверяются отдельно и не заменяются AI-оценкой.',
    ''
  ].join('\n');
}

function buildAssertions(scenario, maxTurns) {
  return [
    { id: 'no-tools', type: 'no_tool_called', tool_pattern: '.*' },
    { id: 'stay-in-sandbox', type: 'no_path_escape' },
    { id: 'bounded-turns', type: 'turn_count_at_most', max: maxTurns },
    { id: 'evaluation-complete', type: 'output_contains', pattern: 'evaluation_complete' },
    ...scenario.assertions.map((assertion) => ({ ...assertion }))
  ];
}

function renderSystemPrompt(row) {
  return [
    '# Controlled AIFHub Workflow Evaluation',
    '',
    'This is a synthetic, sanitized behavioral evaluation. Apply only the policy excerpt below.',
    '',
    'Rules:',
    '',
    '- Do not use tools, read files, edit files, access GitHub, or infer rules absent from the policy excerpt.',
    '- Treat every identifier and state in the user prompt as synthetic evaluation data.',
    '- Answer concisely with each requested label exactly once, in the supplied order.',
    '- Render labels as plain text with no Markdown punctuation around them.',
    '- Preserve exact command names, status names, section names, and evidence-source labels from the policy.',
    '- End with a separate line containing evaluation_complete.',
    '',
    `Condition: ${row.condition}`,
    `Source contract: ${row.source}`,
    `Scenario fingerprint: ${row.scenario_fingerprint}`,
    '',
    'Policy excerpt:',
    '',
    row.policy,
    '',
    'Required response labels:',
    '',
    ...row.response_labels.map((label) => `- ${label}:`),
    ''
  ].join('\n');
}

function renderScenarioYaml(row) {
  const lines = [
    `scenario: ${row.id}`,
    `description: ${quoteYaml(`issue=88 condition=${row.condition} fingerprint=${row.scenario_fingerprint}`)}`,
    `system_prompt_file: ${quoteYaml(`../${row.prompt_file}`)}`,
    'user_prompt: |',
    ...String(row.user_prompt).split(/\r?\n/).map((line) => `  ${line}`),
    `max_turns: ${row.max_turns}`,
    'runner:',
    `  runtime: ${quoteYaml(row.runtime)}`,
    `  model: ${quoteYaml(row.model)}`,
    `  reasoning: ${quoteYaml(row.reasoning)}`,
    '  permission_mode: plan',
    'assertions:'
  ];
  for (const assertion of row.assertions) {
    lines.push(`  - id: ${assertion.id}`);
    lines.push(`    type: ${assertion.type}`);
    if (assertion.tool_pattern !== undefined) lines.push(`    tool_pattern: ${quoteYaml(assertion.tool_pattern)}`);
    if (assertion.max !== undefined) lines.push(`    max: ${assertion.max}`);
    if (assertion.pattern !== undefined) lines.push(`    pattern: ${quoteYaml(assertion.pattern)}`);
  }
  lines.push('');
  return lines.join('\n');
}

function renderAiTesterConfig(matrix) {
  return [
    'version: 1',
    'runs_dir: ./runs',
    'defaults:',
    `  runtime: ${matrix.runtime}`,
    `  model: ${matrix.model}`,
    `  reasoning: ${matrix.reasoning}`,
    '  permission_mode: plan',
    ''
  ].join('\n');
}

function validateProvenance(provenance = {}, expected = {}) {
  const required = [
    'ai_tester_source_commit',
    'ai_tester_binary_sha256',
    'ai_tester_version',
    'codex_version',
    'reasoning_enforcement'
  ];
  if (required.some((key) => !String(provenance?.[key] ?? '').trim())) {
    throw workflowError('incomplete_runner_provenance');
  }
  if (provenance.ai_tester_source_commit !== expected.source_commit ||
      provenance.ai_tester_binary_sha256 !== expected.binary_sha256 ||
      provenance.ai_tester_version !== expected.version ||
      provenance.reasoning_enforcement !== expected.reasoning_enforcement) {
    throw workflowError('runner_provenance_mismatch');
  }
  if (!/^codex-cli \d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(provenance.codex_version)) {
    throw workflowError('invalid_codex_version');
  }
}

function boundedProvenance(provenance = {}) {
  return {
    ai_tester_source_commit: String(provenance.ai_tester_source_commit ?? ''),
    ai_tester_binary_sha256: String(provenance.ai_tester_binary_sha256 ?? ''),
    ai_tester_version: String(provenance.ai_tester_version ?? ''),
    codex_version: String(provenance.codex_version ?? ''),
    reasoning_enforcement: String(provenance.reasoning_enforcement ?? '')
  };
}

async function writeTracked(filePath, content, rootDir, writtenFiles) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, 'utf8');
  writtenFiles.push(toPosix(path.relative(rootDir, filePath)));
}

async function readTraceRecords(root) {
  const files = await listFiles(root);
  const traces = [];
  for (const file of files.filter((item) => item.endsWith('.json'))) {
    try {
      const trace = JSON.parse(await readFile(file, 'utf8'));
      if (trace?.schemaVersion === '2.0.0') traces.push(trace);
    } catch {
      // Invalid raw traces are excluded and surface as trace_missing/NOT_RUN.
    }
  }
  return traces;
}

async function readReasoningProof(filePath) {
  try {
    const raw = await readFile(filePath, 'utf8');
    return raw.trim() ? raw.trim().split(/\r?\n/).map((line) => JSON.parse(line)) : [];
  } catch {
    return [];
  }
}

async function listFiles(root) {
  const output = [];
  async function visit(current) {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile()) output.push(target);
    }
  }
  await visit(root);
  return output;
}

function normalizeTokens(cost = {}) {
  const result = {
    input: nonNegativeInteger(cost.inputTokens) ?? 0,
    output: nonNegativeInteger(cost.outputTokens) ?? 0,
    cache_creation: nonNegativeInteger(cost.cacheCreationTokens) ?? 0,
    cache_read: nonNegativeInteger(cost.cacheReadTokens) ?? 0,
    total: 0
  };
  result.total = result.input + result.output + result.cache_creation + result.cache_read;
  return result;
}

function emptyTokens() {
  return { input: 0, output: 0, cache_creation: 0, cache_read: 0, total: 0 };
}

function sumTokens(items) {
  return items.reduce((sum, item) => ({
    input: sum.input + item.input,
    output: sum.output + item.output,
    cache_creation: sum.cache_creation + item.cache_creation,
    cache_read: sum.cache_read + item.cache_read,
    total: sum.total + item.total
  }), emptyTokens());
}

function statusCounts(rows) {
  return {
    pass: rows.filter((row) => row.status === 'PASS').length,
    fail: rows.filter((row) => row.status === 'FAIL').length,
    not_run: rows.filter((row) => row.status === 'NOT_RUN').length
  };
}

function cleanText(value) {
  const raw = String(value ?? '').trim();
  return Boolean(raw) && !containsPrivateMaterial(raw);
}

function containsPrivateMaterial(value) {
  return /(?:[A-Za-z]:\\Users\\|\/Users\/|\/home\/[^/]+\/|BEGIN (?:RSA |OPENSSH )?PRIVATE KEY|(?:api[_-]?key|token|password)\s*[:=]\s*\S+|authorization\s*:)/i.test(String(value ?? ''));
}

function safeRelativePath(value) {
  const raw = String(value ?? '');
  if (!raw || path.isAbsolute(raw) || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(raw)) return false;
  const normalized = path.posix.normalize(raw.replaceAll('\\', '/'));
  return normalized !== '.' && normalized !== '..' && !normalized.startsWith('../');
}

function safeId(value) {
  return /^[a-z0-9][a-z0-9-]*$/.test(String(value ?? ''));
}

function safeRunId(value) {
  return /^[a-z0-9][a-z0-9-]{2,80}$/.test(String(value ?? ''));
}

function sameArray(actual, expected) {
  return Array.isArray(actual) && actual.length === expected.length &&
    actual.every((value, index) => value === expected[index]);
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function nonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function quoteYaml(value) {
  return JSON.stringify(String(value));
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function firstLine(value) {
  return String(value ?? '').trim().split(/\r?\n/, 1)[0] ?? '';
}

function shortHash(value) {
  return String(value ?? '').slice(0, 12);
}

function formatStatus(row) {
  if (!row) return 'NOT_RUN (missing row)';
  return `${row.status} (${row.assertions.passed}/${row.assertions.total})`;
}

function formatFailedAssertions(row) {
  const ids = asArray(row?.failed_assertion_ids);
  return ids.length > 0 ? ids.map((id) => `\`${id}\``).join(', ') : 'none';
}

function toProjectPath(root, filePath) {
  return toPosix(path.relative(root, filePath) || '.');
}

function toPosix(value) {
  return String(value).replaceAll(path.sep, '/');
}

function fromPosix(value) {
  return String(value).split('/').join(path.sep);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function workflowError(code, detail = '') {
  const error = new Error(detail ? `${code}: ${detail}` : code);
  error.code = code;
  return error;
}

function parseCliArgs(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === '--catalog') parsed.catalogPath = args[++index];
    else if (token === '--out') parsed.outDir = args[++index];
    else if (token === '--run-id') parsed.runId = args[++index];
    else if (token === '--ai-tester-root') parsed.aiTesterRoot = args[++index];
    else if (token === '--ai-tester') parsed.aiTesterExecutable = args[++index];
    else if (token === '--codex') parsed.codexExecutable = args[++index];
    else if (token === '--execute') parsed.execute = true;
    else if (token === '--cleanup') parsed.cleanup = true;
    else if (token === '--json') parsed.json = true;
    else if (token === '--help' || token === '-h') parsed.help = true;
    else throw workflowError('unknown_argument', token);
  }
  return parsed;
}

function usage() {
  return [
    'Usage: node scripts/roadmap-lifecycle-ai-tester.mjs --execute --out <temp-dir> --run-id <id> --ai-tester-root <dir> --ai-tester <exe> --codex <exe> [--cleanup] [--json]',
    '',
    'Runs paired sanitized workflow scenarios and prints only a bounded aggregate.',
    'Use --cleanup only for an output directory strictly below the operating-system temp directory.',
    ''
  ].join('\n');
}

export async function cleanupRoadmapLifecycleTempOutput(outDir, cwd) {
  const target = assertTempOutputDescendant(outDir, cwd);
  await rm(target, { recursive: true, force: true });
}

function assertTempOutputDescendant(outDir, cwd) {
  const target = path.resolve(cwd, String(outDir ?? ''));
  const tempRoot = path.resolve(os.tmpdir());
  const relative = path.relative(tempRoot, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw workflowError('cleanup_target_not_temp_descendant');
  }
  return target;
}

async function main() {
  const parsed = parseCliArgs(process.argv.slice(2));
  if (parsed.help) {
    process.stdout.write(usage());
    return;
  }
  if (!parsed.execute || !parsed.outDir || !parsed.runId || !parsed.aiTesterRoot ||
      !parsed.aiTesterExecutable || !parsed.codexExecutable) {
    throw workflowError('execute_arguments_required');
  }
  let report;
  try {
    report = await executeRoadmapLifecycleMatrix({ ...parsed, cwd: process.cwd() });
  } finally {
    if (parsed.cleanup) {
      await cleanupRoadmapLifecycleTempOutput(parsed.outDir, process.cwd());
    }
  }
  process.stdout.write(parsed.json
    ? `${JSON.stringify(report, null, 2)}\n`
    : renderRoadmapLifecycleMarkdown(report));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({
      component: 'roadmap-lifecycle-ai-tester',
      event: 'failed',
      code: error?.code ?? 'unexpected_error',
      message: String(error?.message ?? error).slice(0, 500)
    })}\n`);
    process.exitCode = 1;
  });
}
