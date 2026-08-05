// context-mode-codex-ai-tester-matrix.mjs - dedicated three-way matrix for issue #134
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CONTEXT_MODE_IDENTITY } from './context-mode-codex-ai-tester-adapter.mjs';

export const CONTEXT_MODE_MATRIX_SCHEMA = 'aifhub.context_mode_codex.ai_tester_matrix.v1';
export const CONTEXT_MODE_SCENARIOS = Object.freeze([
  'large_generated_output_retrieval',
  'decision_and_file_state_continuity',
  'fresh_session_isolation_and_purge'
]);
export const CONTEXT_MODE_VARIANTS = Object.freeze([
  'baseline',
  'mcp_only',
  'codex_plugin'
]);
export const BASELINE_RG_COMMAND_PATTERN = String.raw`(?:^|[^A-Za-z0-9_.-])rg(?:\.exe)?(?:['"])?(?:[ \t]|$)`;
const BASELINE_NODE_COMMAND_PATTERN = String.raw`(?:^|[^A-Za-z0-9_.-])node(?:\.exe)?(?:['"])?(?:[ \t]|$)`;
const AUTHORIZATION_BASE_KEYS = Object.freeze([
  'scope',
  'provider_snapshot',
  'runtime_dependency_bootstrap',
  'auth_mode',
  'native_codex'
]);
const AUTHORIZATION_KEYS = Object.freeze([
  ...AUTHORIZATION_BASE_KEYS,
  'hook_trust_mode'
]);
const DEFAULT_CATALOG = path.join(
  'docs',
  'memory-tools-research',
  'context-mode-codex-ai-tester',
  'scenario-catalog.json'
);

export async function loadContextModeScenarioCatalog({
  cwd = process.cwd(),
  catalogPath = path.join(cwd, DEFAULT_CATALOG)
} = {}) {
  return JSON.parse(await readFile(catalogPath, 'utf8'));
}

export function validateContextModeScenarioCatalog(catalog = {}) {
  const errors = [];
  if (catalog.schema !== 'aifhub.context_mode_codex.ai_tester_catalog.v1') errors.push('schema');
  if (catalog.defaults?.runtime !== 'codex') errors.push('defaults.runtime');
  if (catalog.defaults?.model !== 'gpt-5.6-luna') errors.push('defaults.model');
  if (catalog.defaults?.reasoning !== 'low') errors.push('defaults.reasoning');
  if (catalog.defaults?.repetitions !== 2) errors.push('defaults.repetitions');
  if (!Number.isInteger(catalog.defaults?.timeout_ms) || catalog.defaults.timeout_ms <= 0) {
    errors.push('defaults.timeout_ms');
  }
  if (!sameArray(catalog.defaults?.variants, CONTEXT_MODE_VARIANTS)) errors.push('defaults.variants');
  if (!sameArray(catalog.scenarios?.map((item) => item.id), CONTEXT_MODE_SCENARIOS)) {
    errors.push('scenarios');
  }
  if (!isSafeRelativeFile(catalog.fixture?.artifact)) errors.push('fixture.artifact');
  if (typeof catalog.fixture?.content !== 'string' || catalog.fixture.content.length === 0) {
    errors.push('fixture.content');
  }
  const profiles = catalog.fixture?.profiles;
  if (!profiles || profiles.standard?.kind !== 'file' ||
      profiles.large_stdout_tail?.kind !== 'generated_stdout' ||
      !Number.isInteger(profiles.large_stdout_tail?.line_count) ||
      profiles.large_stdout_tail.line_count <= 0 ||
      !Number.isInteger(profiles.large_stdout_tail?.filler_width) ||
      profiles.large_stdout_tail.filler_width <= 0 ||
      !Number.isInteger(profiles.large_stdout_tail?.minimum_bytes) ||
      profiles.large_stdout_tail.minimum_bytes <= 1_048_576 ||
      !Array.isArray(profiles.large_stdout_tail?.tail_lines) ||
      profiles.large_stdout_tail.tail_lines.length !== 3) {
    errors.push('fixture.profiles');
  }
  for (const scenario of catalog.scenarios ?? []) {
    const sessionMode = scenario.session_mode ?? 'same_thread';
    const expectedPromptCount = ['single_turn', 'external_fresh_pair'].includes(sessionMode) ? 1 : 2;
    if (!['single_turn', 'same_thread', 'external_fresh_pair'].includes(sessionMode)) {
      errors.push(`${scenario.id}.session_mode`);
    }
    if (!profiles?.[scenario.fixture_profile ?? 'standard']) {
      errors.push(`${scenario.id}.fixture_profile`);
    }
    if (!Array.isArray(scenario.prompts) || scenario.prompts.length !== expectedPromptCount ||
        scenario.prompts.some((prompt) => typeof prompt !== 'string' || prompt.length === 0)) {
      errors.push(`${scenario.id}.prompts`);
    }
    if (!Array.isArray(scenario.assertions) || scenario.assertions.length === 0) {
      errors.push(`${scenario.id}.assertions`);
    } else {
      const ids = new Set();
      for (const assertion of scenario.assertions) {
        if (!assertion || typeof assertion !== 'object' ||
            !/^[a-z0-9][a-z0-9-]*$/.test(String(assertion.id ?? '')) ||
            assertion.type !== 'output_contains' ||
            typeof assertion.pattern !== 'string' || assertion.pattern.length === 0 ||
            assertion.pattern.length > 1000 || ids.has(assertion.id)) {
          errors.push(`${scenario.id}.assertions`);
          break;
        }
        ids.add(assertion.id);
      }
    }
    if (scenario.session_mode === 'external_fresh_pair') {
      if (!sameArray(scenario.lifecycle_assertions, [
        'fresh_session_isolated',
        'provider_purged',
        'sandbox_clean'
      ])) errors.push(`${scenario.id}.lifecycle_assertions`);
    } else if (scenario.lifecycle_assertions !== undefined) {
      errors.push(`${scenario.id}.lifecycle_assertions`);
    }
  }
  if (looksPrivate(JSON.stringify(catalog))) errors.push('private_material');
  return errors;
}

export function buildContextModeMatrix({
  catalog,
  runId,
  provenance,
  authorization,
  generatedAt = new Date().toISOString()
}) {
  const errors = validateContextModeScenarioCatalog(catalog);
  if (errors.length > 0) throw matrixError('invalid_catalog', errors);
  validateProvenance(provenance);
  const normalizedAuthorization = normalizeContextModeAuthorization(authorization);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(String(runId ?? ''))) throw matrixError('invalid_run_id');
  const rows = [];
  for (const scenario of catalog.scenarios) {
    const resumeDriverParity = scenario.resume_driver_parity === true;
    for (let repetition = 1; repetition <= catalog.defaults.repetitions; repetition += 1) {
      const triadId = `${runId}__${scenario.id}__r${String(repetition).padStart(2, '0')}`;
      const settings = {
        fixture_revision: catalog.fixture.revision,
        fixture_artifact: catalog.fixture.artifact,
        fixture_profile: scenario.fixture_profile ?? 'standard',
        fixture_profile_config: catalog.fixture.profiles[scenario.fixture_profile ?? 'standard'],
        prompts: scenario.prompts,
        assertions: scenario.assertions,
        session_mode: scenario.session_mode ?? 'same_thread',
        resume_driver_parity: resumeDriverParity,
        lifecycle_assertions: scenario.lifecycle_assertions ?? [],
        timeout_ms: catalog.defaults.timeout_ms,
        runtime: catalog.defaults.runtime,
        model: catalog.defaults.model,
        reasoning: catalog.defaults.reasoning,
        provenance,
        authorization_class: normalizedAuthorization.class
      };
      const settingsFingerprint = sha256(stableJson(settings));
      for (const variant of CONTEXT_MODE_VARIANTS) {
        const id = `${triadId}__${variant}`;
        rows.push({
          id,
          triad_id: triadId,
          scenario_id: scenario.id,
          variant,
          repetition,
          runtime: catalog.defaults.runtime,
          model: catalog.defaults.model,
          reasoning: catalog.defaults.reasoning,
          timeout_ms: catalog.defaults.timeout_ms,
          fixture_revision: catalog.fixture.revision,
          fixture_artifact: catalog.fixture.artifact,
          fixture_seed: catalog.fixture.profiles[scenario.fixture_profile ?? 'standard'].kind === 'file'
            ? catalog.fixture.content
            : null,
          fixture_profile: scenario.fixture_profile ?? 'standard',
          fixture_profile_config: structuredClone(
            catalog.fixture.profiles[scenario.fixture_profile ?? 'standard']
          ),
          prompts: [...scenario.prompts],
          assertions: structuredClone(scenario.assertions),
          session_mode: scenario.session_mode ?? 'same_thread',
          resume_driver_parity: resumeDriverParity,
          lifecycle_assertions: [...(scenario.lifecycle_assertions ?? [])],
          execution_gate: executionGateForVariant(variant, normalizedAuthorization),
          authorization_class: normalizedAuthorization.class,
          raw_provider_policy: rawProviderPolicyForRow(variant, scenario.id),
          settings_fingerprint: settingsFingerprint,
          settings_provenance: structuredClone(provenance),
          scenario_file: `scenarios/${id}.yaml`,
          expected_trace_root: `runs/inline_${id}`
        });
      }
    }
  }
  return {
    schema: CONTEXT_MODE_MATRIX_SCHEMA,
    run_id: runId,
    generated_at: generatedAt,
    planned_rows: rows.length,
    scenarios: [...CONTEXT_MODE_SCENARIOS],
    variants: [...CONTEXT_MODE_VARIANTS],
    repetitions: catalog.defaults.repetitions,
    authorization_class: normalizedAuthorization.class,
    rows
  };
}

export async function generateContextModeMatrix({
  outDir,
  runId,
  provenance,
  authorization,
  catalogPath,
  cwd = process.cwd(),
  dryRun = false
}) {
  const catalog = await loadContextModeScenarioCatalog({ cwd, catalogPath });
  const matrix = buildContextModeMatrix({ catalog, runId, provenance, authorization });
  if (dryRun) return { matrix, dry_run: true, written_files: [] };
  const scenariosDir = path.join(outDir, 'scenarios');
  await mkdir(scenariosDir, { recursive: true });
  const writtenFiles = [];
  await writeFile(path.join(outDir, '.ai-tester.yaml'), 'runs_dir: runs\n', 'utf8');
  writtenFiles.push('.ai-tester.yaml');
  for (const row of matrix.rows) {
    const target = path.join(outDir, row.scenario_file);
    await writeFile(target, renderAiTesterScenario(row), 'utf8');
    writtenFiles.push(row.scenario_file);
  }
  await writeFile(path.join(outDir, 'matrix.json'), `${JSON.stringify(matrix, null, 2)}\n`, 'utf8');
  writtenFiles.push('matrix.json');
  return { matrix, dry_run: false, written_files: writtenFiles };
}

export function renderAiTesterScenario(row) {
  const assertionLines = row.assertions
    .map((assertion) => `  - id: ${quoteYaml(assertion.id)}\n    type: ${assertion.type}\n    pattern: ${quoteYaml(assertion.pattern)}`)
    .join('\n');
  const systemPrompt = systemPromptForVariant(row.variant, row);
  const fixtureArtifact = projectFixturePath(row);
  const fixtureLines = ['  files_committed:'];
  if (row.fixture_profile_config?.kind === 'generated_stdout') {
    fixtureLines.push(
      '    - path: "project/emit-large-output.mjs"',
      `      content: ${quoteYaml(buildLargeOutputEmitterSource(row.fixture_profile_config))}`
    );
  } else {
    fixtureLines.push(
      `    - path: ${quoteYaml(fixtureArtifact)}`,
      `      content: ${quoteYaml(row.fixture_seed)}`
    );
  }
  return [
    `scenario: ${quoteYaml(row.id)}`,
    `description: ${quoteYaml(`context-mode-134 variant=${row.variant} triad=${row.triad_id} settings=${row.settings_fingerprint}`)}`,
    'system_prompt: |',
    ...systemPrompt.map((line) => `  ${line}`),
    'max_turns: 8',
    'runner:',
    '  runtime: codex',
    '  model: "gpt-5.6-luna"',
    '  reasoning: "low"',
    '  permission_mode: bypassPermissions',
    `  acp_turn_timeout_seconds: ${Math.ceil(row.timeout_ms / 1000)}`,
    'user_prompts:',
    ...row.prompts.map((prompt) => `  - ${quoteYaml(prompt)}`),
    'fixtures:',
    '  git_init: true',
    ...fixtureLines,
    'assertions:',
    assertionLines,
    ...toolAssertionLinesForVariant(row.variant, row),
    '  - id: "stay-in-sandbox"',
    '    type: no_path_escape',
    '  - id: "bounded-turns"',
    '    type: turn_count_at_most',
    '    max: 8',
    ''
  ].join('\n');
}

export function normalizeContextModeAuthorization(authorization) {
  const fallback = {
    class: 'default_fail_closed',
    mcp_allowed: false,
    plugin_allowed: false
  };
  if (!authorization || typeof authorization !== 'object' || Array.isArray(authorization)) return fallback;
  const keys = Object.keys(authorization).sort();
  if (keys.some((key) => !AUTHORIZATION_KEYS.includes(key)) ||
      !AUTHORIZATION_BASE_KEYS.every((key) => keys.includes(key))) return fallback;
  const mcpAllowed = authorization.scope === 'isolated_evaluation' &&
    authorization.provider_snapshot === 'prepared_pinned_snapshot' &&
    authorization.runtime_dependency_bootstrap === 'approved';
  if (!mcpAllowed) return fallback;
  const pluginAllowed = authorization.auth_mode === 'scoped_ephemeral' &&
    authorization.native_codex === true &&
    authorization.hook_trust_mode === 'test_only_pinned_snapshot_bypass';
  return {
    class: pluginAllowed ? 'explicit_isolated_full' : 'explicit_isolated_mcp',
    mcp_allowed: true,
    plugin_allowed: pluginAllowed
  };
}

function executionGateForVariant(variant, authorization) {
  if (variant === 'baseline') return { status: 'PASS', reason: 'baseline_ready' };
  if (variant === 'mcp_only') {
    if (authorization.mcp_allowed) {
      return { status: 'PASS', reason: 'explicit_isolated_authorization' };
    }
    return { status: 'BLOCKED', reason: 'runtime_dependency_self_install' };
  }
  if (authorization.plugin_allowed) {
    return { status: 'PASS', reason: 'explicit_isolated_authorization' };
  }
  return { status: 'NOT_RUN', reason: 'auth_isolation_unavailable' };
}

function systemPromptForVariant(variant, row) {
  const shared = [
    'This is a controlled synthetic evaluation. Work only in the sandbox.',
    'Never reveal absolute paths, environment values, credentials, or raw fixture content.',
    'Return only the requested facts in the exact requested format.'
  ];
  const largeOutput = row.scenario_id === 'large_generated_output_retrieval';
  const fixtureArtifact = projectFixturePath(row);
  if (variant === 'baseline') {
    return [...shared, largeOutput
      ? 'Run node project/emit-large-output.mjs through the shell. Do not inspect the emitter source or use context-mode.'
      : `Use rg directly against ${fixtureArtifact}. Do not use context-mode.`];
  }
  if (variant === 'mcp_only') {
    return [
      ...shared,
      largeOutput
        ? 'Use only evaluation-scoped ctx_batch_execute for node project/emit-large-output.mjs, query the indexed output, then purge project scope.'
        : 'Use only the isolated context_mode MCP tools for the generated artifact.',
      ...(largeOutput ? [] : [`Index only ${fixtureArtifact}, query it, then purge project scope.`])
    ];
  }
  return [
    ...shared,
    'Use only the isolated registered context-mode Codex plugin and its reviewed hooks.',
    ...(largeOutput ? ['Run node project/emit-large-output.mjs through the shell so the plugin hooks can observe its output.'] : []),
    'Do not install, update, or trust any provider outside the supplied isolated Codex home.'
  ];
}

function toolAssertionLinesForVariant(variant, row) {
  if (variant === 'baseline') {
    const largeOutput = row.scenario_id === 'large_generated_output_retrieval';
    const assertionId = largeOutput ? 'baseline-node-called' : 'baseline-rg-called';
    const pattern = largeOutput
      ? BASELINE_NODE_COMMAND_PATTERN
      : BASELINE_RG_COMMAND_PATTERN;
    return [
      `  - id: "${assertionId}"`,
      '    type: tool_called',
      '    tool: "Bash"',
      '    args_match:',
      `      command: ${quoteYaml(pattern)}`
    ];
  }
  return [];
}

export function buildLargeOutputEmitterSource(profile = {}) {
  if (profile.kind !== 'generated_stdout' || !Number.isInteger(profile.line_count) ||
      profile.line_count <= 0 || !Number.isInteger(profile.filler_width) ||
      profile.filler_width <= 0 || !Array.isArray(profile.tail_lines) ||
      profile.tail_lines.some((line) => typeof line !== 'string' || /[\r\n]/.test(line))) {
    throw matrixError('invalid_large_fixture_profile');
  }
  return [
    `const lineCount = ${profile.line_count};`,
    `const filler = ${JSON.stringify('x'.repeat(profile.filler_width))};`,
    "for (let index = 0; index < lineCount; index += 1) process.stdout.write(`filler-${String(index).padStart(5, '0')} ${filler}\\n`);",
    `process.stdout.write(${JSON.stringify(`${profile.tail_lines.join('\n')}\n`)});`,
    ''
  ].join('\n');
}

function rawProviderPolicyForRow(variant, scenarioId) {
  if (variant === 'baseline') return null;
  if (variant === 'mcp_only' && scenarioId === 'large_generated_output_retrieval') {
    return {
      required_tools: ['ctx_batch_execute', 'ctx_purge'],
      allowed_tools: ['ctx_batch_execute', 'ctx_search', 'ctx_stats', 'ctx_purge'],
      allowed_commands: ['node project/emit-large-output.mjs']
    };
  }
  if (variant === 'mcp_only') {
    return {
      required_tools: ['ctx_index', 'ctx_search', 'ctx_purge'],
      allowed_tools: ['ctx_doctor', 'ctx_index', 'ctx_search', 'ctx_stats', 'ctx_purge']
    };
  }
  return {
    required_tools: ['ctx_search'],
    allowed_tools: ['ctx_search', 'ctx_stats', 'ctx_purge']
  };
}

export function buildCodexReasoningWrapper({ realCodex }) {
  if (!realCodex || !path.isAbsolute(realCodex) && !/^[A-Za-z0-9_.-]+$/.test(realCodex)) {
    throw matrixError('invalid_codex_executable');
  }
  return [
    '#!/usr/bin/env node',
    "import { spawnSync } from 'node:child_process';",
    "import { appendFileSync, existsSync } from 'node:fs';",
    "import path from 'node:path';",
    `const realCodex = ${JSON.stringify(realCodex)};`,
    "const original = process.argv.slice(2);",
    "const isInitial = original[0] === 'exec' && original[1] !== 'resume';",
    "const isResume = original[0] === 'exec' && original[1] === 'resume';",
    "const isProbe = original.length === 1 && ['--version', '--help'].includes(original[0]);",
    "if (!isInitial && !isResume && !isProbe) process.exit(64);",
    "const args = isProbe ? original : ['-c', 'model_reasoning_effort=\"low\"', ...original];",
    "if (!isProbe && process.env.CONTEXT_MODE_REASONING_PROOF) {",
    "  appendFileSync(process.env.CONTEXT_MODE_REASONING_PROOF, JSON.stringify({ phase: isResume ? 'resume' : 'initial', profile: 'low' }) + '\\n');",
    "}",
    "const executable = realCodex === '__PATH_AFTER_WRAPPER__' ? findRealCodex() : realCodex;",
    "const result = spawnSync(executable, args, { stdio: 'inherit', env: process.env });",
    "process.exit(result.status ?? 1);",
    "function findRealCodex() {",
    "  const own = path.resolve(path.dirname(process.argv[1])).toLowerCase();",
    "  const dirs = String(process.env.PATH ?? process.env.Path ?? '').split(path.delimiter).filter((dir) => path.resolve(dir).toLowerCase() !== own);",
    "  for (const suffix of process.platform === 'win32' ? ['codex.exe', 'codex.cmd'] : ['codex']) {",
    "    for (const dir of dirs) { const candidate = path.join(dir, suffix); if (existsSync(candidate)) return candidate; }",
    "  }",
    "  process.exit(69);",
    "}",
    ''
  ].join('\n');
}

export function validateReasoningProof(proofRecords = []) {
  if (!Array.isArray(proofRecords)) {
    return { status: 'NOT_RUN', reason: 'reasoning_proof_invalid' };
  }
  const validRecord = (record) => {
    if (!record || typeof record !== 'object' || Array.isArray(record)) return false;
    const keys = Object.keys(record).sort();
    return sameArray(keys, ['phase', 'profile']) &&
      ['initial', 'resume'].includes(record.phase) &&
      typeof record.profile === 'string';
  };
  if (!proofRecords.every(validRecord)) {
    return { status: 'NOT_RUN', reason: 'reasoning_proof_invalid' };
  }
  const hasInitial = proofRecords.some((record) =>
    record.phase === 'initial' && record.profile === 'low'
  );
  const hasResume = proofRecords.some((record) =>
    record.phase === 'resume' && record.profile === 'low'
  );
  return hasInitial && hasResume
    ? { status: 'PASS', reason: 'profile_enforced_initial_and_resume' }
    : { status: 'NOT_RUN', reason: 'profile_unenforced' };
}

export async function writeCodexReasoningWrapper({ outDir, realCodex = '__PATH_AFTER_WRAPPER__' }) {
  await mkdir(outDir, { recursive: true });
  const modulePath = path.join(outDir, 'codex-wrapper.mjs');
  const commandPath = path.join(outDir, process.platform === 'win32' ? 'codex.cmd' : 'codex');
  await writeFile(
    modulePath,
    buildCodexReasoningWrapper({ realCodex }),
    'utf8'
  );
  if (process.platform === 'win32') {
    await writeFile(commandPath, '@echo off\r\nnode "%~dp0codex-wrapper.mjs" %*\r\n', 'utf8');
    await writeFile(path.join(outDir, 'which.cmd'), '@echo off\r\nwhere.exe %*\r\n', 'utf8');
  } else {
    await writeFile(commandPath, '#!/bin/sh\nexec node "$(dirname "$0")/codex-wrapper.mjs" "$@"\n', { mode: 0o755 });
  }
  return {
    module_file: path.basename(modulePath),
    command_file: path.basename(commandPath),
    codex_resolution: realCodex === '__PATH_AFTER_WRAPPER__' ? 'path_fallback' : 'explicit',
    proof_schema: 'aifhub.context_mode_codex.reasoning_proof.v1'
  };
}

function validateProvenance(provenance = {}) {
  const required = [
    'fixture_revision',
    'ai_tester_source_clean',
    'ai_tester_source_commit',
    'ai_tester_binary_sha256',
    'ai_tester_version',
    'codex_version',
    'codex_features',
    'context_mode_tag',
    'context_mode_commit',
    'context_mode_integrity'
  ];
  const missing = required.filter((key) => provenance[key] === undefined);
  if (missing.length > 0) throw matrixError('incomplete_provenance', missing);
  if (!/^[a-f0-9]{40}$/.test(provenance.ai_tester_source_commit)) {
    throw matrixError('invalid_ai_tester_source_commit');
  }
  if (provenance.ai_tester_source_clean !== true) throw matrixError('ai_tester_source_dirty');
  if (!/^[a-f0-9]{64}$/.test(provenance.ai_tester_binary_sha256)) {
    throw matrixError('invalid_ai_tester_binary_sha256');
  }
  if (provenance.context_mode_tag !== CONTEXT_MODE_IDENTITY.tag ||
      provenance.context_mode_commit !== CONTEXT_MODE_IDENTITY.commit ||
      provenance.context_mode_integrity !== CONTEXT_MODE_IDENTITY.integrity) {
    throw matrixError('context_mode_provenance_mismatch');
  }
  if (looksPrivate(JSON.stringify(provenance))) throw matrixError('private_provenance');
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function sameArray(actual, expected) {
  return Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index]);
}

function isSafeRelativeFile(value) {
  const raw = String(value ?? '');
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(raw) &&
    path.basename(raw) === raw &&
    !path.isAbsolute(raw) &&
    !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(raw);
}

function projectFixturePath(row) {
  if (!isSafeRelativeFile(row?.fixture_artifact)) throw matrixError('invalid_fixture_artifact');
  return path.posix.join('project', row.fixture_artifact);
}

function looksPrivate(value) {
  return /(?:[A-Za-z]:\\Users\\|\/Users\/|\/home\/[^/]+\/|BEGIN (?:RSA |OPENSSH )?PRIVATE KEY|(?:api[_-]?key|token|password)\s*[:=]\s*\S+)/i.test(value);
}

function quoteYaml(value) {
  return JSON.stringify(String(value));
}

function matrixError(code, details = []) {
  const error = new Error(`${code}${details.length ? `:${details.join(',')}` : ''}`);
  error.code = code;
  return error;
}

async function main(argv = process.argv.slice(2)) {
  const provenancePath = valueAfter(argv, '--provenance');
  const authorizationPath = valueAfter(argv, '--authorization');
  const outDir = valueAfter(argv, '--out');
  const runId = valueAfter(argv, '--run-id');
  if (!provenancePath || !outDir || !runId) throw matrixError('required_arguments_missing');
  const provenance = JSON.parse(await readFile(provenancePath, 'utf8'));
  const authorization = authorizationPath
    ? JSON.parse(await readFile(authorizationPath, 'utf8'))
    : undefined;
  const result = await generateContextModeMatrix({
    catalogPath: path.join(process.cwd(), DEFAULT_CATALOG),
    outDir: path.resolve(outDir),
    runId,
    provenance,
    authorization,
    dryRun: argv.includes('--dry-run')
  });
  process.stdout.write(`${JSON.stringify({
    schema: result.matrix.schema,
    run_id: result.matrix.run_id,
    planned_rows: result.matrix.rows.length,
    dry_run: result.dry_run
  })}\n`);
}

function valueAfter(argv, flag) {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    process.stderr.write(`${error?.code ?? 'matrix_failed'}\n`);
    process.exitCode = 1;
  });
}
