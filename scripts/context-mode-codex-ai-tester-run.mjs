// context-mode-codex-ai-tester-run.mjs - explicit provenance runner for issue #134
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, readFile, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import {
  buildContextModeEnv,
  buildSandboxLayout,
  prepareSandbox,
  runBoundedProcess
} from './context-mode-codex-ai-tester-adapter.mjs';
import {
  buildContextModeResults,
  normalizeContextModeTrace,
  sanitizeAndDeleteUnsafeTrace,
  scanCompleteTrace
} from './context-mode-codex-ai-tester-results.mjs';

const execFileAsync = promisify(execFile);
export const CONTEXT_MODE_RUNNER_SCHEMA = 'aifhub.context_mode_codex.ai_tester_runner.v1';

export function validateRunnerProvenance(provenance = {}) {
  if (!path.isAbsolute(String(provenance.executable ?? ''))) {
    return { status: 'NOT_RUN', reason: 'explicit_executable_required' };
  }
  if (provenance.source_clean !== true) return { status: 'NOT_RUN', reason: 'runner_source_dirty' };
  if (!provenance.expected_source_commit ||
      provenance.source_commit !== provenance.expected_source_commit) {
    return { status: 'NOT_RUN', reason: 'runner_source_mismatch' };
  }
  if (!provenance.expected_binary_sha256 ||
      provenance.binary_sha256 !== provenance.expected_binary_sha256) {
    return { status: 'NOT_RUN', reason: 'runner_binary_mismatch' };
  }
  return {
    status: 'PASS',
    reason: 'runner_provenance_verified',
    source_commit: provenance.source_commit,
    binary_sha256: provenance.binary_sha256,
    version: provenance.version
  };
}

export async function inspectRunnerProvenance({
  executable,
  sourceRoot,
  expectedSourceCommit,
  expectedBinarySha256
}) {
  if (!path.isAbsolute(executable) || !path.isAbsolute(sourceRoot)) {
    return { status: 'NOT_RUN', reason: 'explicit_executable_required' };
  }
  await stat(executable);
  const [{ stdout: commitOut }, { stdout: statusOut }, binary] = await Promise.all([
    execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, windowsHide: true }),
    execFileAsync('git', ['status', '--porcelain'], { cwd: sourceRoot, windowsHide: true }),
    readFile(executable)
  ]);
  const versionResult = await runBoundedProcess(executable, ['--version'], {
    cwd: sourceRoot,
    env: minimalRunnerEnv(process.env),
    timeoutMs: 15_000,
    outputCapBytes: 2048
  });
  return {
    executable,
    source_clean: statusOut.trim().length === 0,
    source_commit: commitOut.trim(),
    expected_source_commit: expectedSourceCommit,
    binary_sha256: createHash('sha256').update(binary).digest('hex'),
    expected_binary_sha256: expectedBinarySha256,
    version: firstLine(versionResult.stdout || versionResult.stderr)
  };
}

export function planMissingRows(rows, completedRowIds = new Set()) {
  return rows.filter((row) => !completedRowIds.has(row.id));
}

export function validateTraceRoot(runRoot, tracePath) {
  const root = path.resolve(runRoot);
  const target = path.resolve(tracePath);
  const relative = path.relative(root, target);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative)
    ? { status: 'PASS', trace_class: 'isolated_run_descendant' }
    : { status: 'NOT_RUN', reason: 'unexpected_trace_root' };
}

export function buildRunnerInvocation({
  executable,
  scenarioFile,
  runRoot,
  row,
  dryRun = false
}) {
  if (!path.isAbsolute(executable)) throw runnerError('explicit_executable_required');
  if (!path.isAbsolute(scenarioFile) || !path.isAbsolute(runRoot)) {
    throw runnerError('isolated_absolute_paths_required');
  }
  const args = [
    'run',
    '--file',
    scenarioFile,
    '--runtime',
    'codex',
    '--model',
    row.model,
    '--reasoning',
    row.reasoning,
    '--filter',
    `^${escapeRegex(row.id)}$`,
    '--quiet'
  ];
  if (dryRun) args.push('--dry-run');
  return {
    command: executable,
    args,
    project_root: path.dirname(runRoot),
    argv_contract: {
      runtime: 'codex',
      model: row.model,
      reasoning: row.reasoning,
      row_id: row.id,
      dry_run: dryRun,
      run_root_class: 'configured_project_runs'
    }
  };
}

export async function executeMissingRows({
  matrix,
  executable,
  runRoot,
  scenarioRoot,
  completedRowIds = new Set(),
  env,
  rowEvidence = {},
  provisionRow,
  timeoutMs = 300_000,
  runProcess = runBoundedProcess,
  logger
}) {
  const rows = planMissingRows(matrix.rows, completedRowIds);
  const statuses = [];
  for (const row of rows) {
    if (!row.execution_gate || row.execution_gate.status !== 'PASS') {
      const gate = row.execution_gate ?? {
        status: 'NOT_RUN',
        reason: 'execution_gate_missing'
      };
      statuses.push(rowStatus(row, gate.status, gate.reason));
      logFix(logger, 'runner_row_skipped', {
        row_id: row.id,
        status: gate.status,
        reason: gate.reason
      });
      continue;
    }
    if (row.variant !== 'baseline' && typeof provisionRow !== 'function') {
      statuses.push(rowStatus(row, 'NOT_RUN', 'provider_provisioner_unavailable'));
      logFix(logger, 'runner_row_skipped', {
        row_id: row.id,
        status: 'NOT_RUN',
        reason: 'provider_provisioner_unavailable'
      });
      continue;
    }
    const scenarioFile = path.join(scenarioRoot, `${row.id}.yaml`);
    const dryRun = buildRunnerInvocation({ executable, scenarioFile, runRoot, row, dryRun: true });
    let dryResult;
    try {
      dryResult = await runProcess(dryRun.command, dryRun.args, {
        cwd: dryRun.project_root,
        env,
        timeoutMs: Math.min(timeoutMs, 60_000)
      });
    } catch (error) {
      statuses.push(rowStatus(
        row,
        'NOT_RUN',
        error?.code === 'process_timeout' ? 'dry_run_timeout' : 'dry_run_failed'
      ));
      break;
    }
    if (dryResult.exitCode !== 0) {
      statuses.push(rowStatus(row, 'NOT_RUN', 'dry_run_failed'));
      continue;
    }
    if (row.variant !== 'baseline') {
      let provisioned;
      try {
        provisioned = await provisionRow({ row, env, runRoot, scenarioFile });
      } catch {
        provisioned = { status: 'NOT_RUN', reason: 'provider_provisioning_failed' };
      }
      if (provisioned?.status !== 'PASS') {
        statuses.push(rowStatus(
          row,
          provisioned?.status ?? 'NOT_RUN',
          provisioned?.reason ?? 'provider_provisioning_failed'
        ));
        continue;
      }
    }
    if (row.session_mode === 'external_fresh_pair') {
      statuses.push(rowStatus(row, 'NOT_RUN', 'fresh_session_driver_unavailable'));
      continue;
    }
    const before = await snapshotTraceFiles(runRoot);
    const run = buildRunnerInvocation({ executable, scenarioFile, runRoot, row });
    let result;
    try {
      result = await runProcess(run.command, run.args, {
        cwd: run.project_root,
        env,
        timeoutMs
      });
    } catch (error) {
      statuses.push(rowStatus(
        row,
        'FAIL',
        error?.code === 'process_timeout' ? 'runner_timeout' : 'runner_failed'
      ));
      break;
    }
    if (result.exitCode !== 0) {
      statuses.push(rowStatus(row, 'FAIL', 'runner_failed'));
      continue;
    }
    const trace = await inspectFreshTrace({
      runRoot,
      before,
      row,
      evidence: rowEvidence[row.id],
      logger
    });
    statuses.push(trace);
    logFix(logger, 'runner_row_checked', { row_id: row.id, status: trace.status, reason: trace.reason });
  }
  return {
    schema: CONTEXT_MODE_RUNNER_SCHEMA,
    planned_missing_rows: rows.length,
    statuses
  };
}

export async function runVerifiedMatrix(options) {
  let inspected;
  try {
    inspected = await (options.inspectProvenance ?? inspectRunnerProvenance)({
      executable: options.executable,
      sourceRoot: options.sourceRoot,
      expectedSourceCommit: options.expectedSourceCommit,
      expectedBinarySha256: options.expectedBinarySha256
    });
  } catch {
    return {
      schema: CONTEXT_MODE_RUNNER_SCHEMA,
      status: 'NOT_RUN',
      reason: 'runner_provenance_inspection_failed',
      statuses: []
    };
  }
  if (path.resolve(String(inspected.executable ?? '')) !== path.resolve(String(options.executable ?? ''))) {
    return {
      schema: CONTEXT_MODE_RUNNER_SCHEMA,
      status: 'NOT_RUN',
      reason: 'runner_binary_mismatch',
      statuses: []
    };
  }
  const provenance = validateRunnerProvenance(inspected);
  if (provenance.status !== 'PASS') {
    return { schema: CONTEXT_MODE_RUNNER_SCHEMA, ...provenance, statuses: [] };
  }
  if (options.profileProof?.status !== 'PASS') {
    return {
      schema: CONTEXT_MODE_RUNNER_SCHEMA,
      status: 'NOT_RUN',
      reason: 'profile_unenforced',
      statuses: []
    };
  }
  if (path.resolve(options.runRoot) !== path.join(path.dirname(path.resolve(options.scenarioRoot)), 'runs')) {
    return {
      schema: CONTEXT_MODE_RUNNER_SCHEMA,
      status: 'NOT_RUN',
      reason: 'run_root_config_mismatch',
      statuses: []
    };
  }
  for (const [label, target] of [['scenario_root', options.scenarioRoot], ['run_root', options.runRoot]]) {
    if (!await isCanonicalDescendant(options.sandboxRoot, target)) {
      return {
        schema: CONTEXT_MODE_RUNNER_SCHEMA,
        status: 'NOT_RUN',
        reason: `${label}_outside_sandbox`,
        statuses: []
      };
    }
  }
  const layout = buildSandboxLayout(options.sandboxRoot);
  try {
    await prepareSandbox(layout);
  } catch {
    return {
      schema: CONTEXT_MODE_RUNNER_SCHEMA,
      status: 'NOT_RUN',
      reason: 'sandbox_prepare_failed',
      statuses: []
    };
  }
  const boundedEnv = buildContextModeEnv({
    layout,
    baseEnv: options.env ?? process.env
  });
  const result = await executeMissingRows({ ...options, env: boundedEnv });
  const aggregate = aggregateStatuses(result.statuses);
  const results = buildContextModeResults(result.statuses);
  return { ...result, ...aggregate, provenance, results };
}

async function inspectFreshTrace({ runRoot, before, row, evidence, logger }) {
  const after = await snapshotTraceFiles(runRoot);
  const changed = [...after.entries()]
    .filter(([file, digest]) => before.get(file) !== digest)
    .map(([file]) => file);
  if (changed.length !== 1) {
    return rowStatus(row, 'NOT_RUN', 'trace_evidence_missing_or_stale');
  }
  const tracePath = changed[0];
  if (!await isCanonicalDescendant(runRoot, tracePath, { file: true })) {
    return rowStatus(row, 'NOT_RUN', 'unexpected_trace_root');
  }
  let trace;
  try {
    trace = JSON.parse(await readFile(tracePath, 'utf8'));
  } catch {
    return rowStatus(row, 'NOT_RUN', 'trace_invalid_json');
  }
  if (trace.schemaVersion !== '2.0.0' || trace.scenario?.name !== row.id ||
      trace.runner?.runtime !== 'codex' || trace.runner?.model !== row.model ||
      trace.runner?.reasoning !== row.reasoning) {
    return rowStatus(row, 'NOT_RUN', 'trace_identity_mismatch');
  }
  const scan = scanCompleteTrace({ trace, evidence });
  if (!scan.safe) {
    const sanitized = await sanitizeAndDeleteUnsafeTrace({
      tracePath,
      scan,
      allowedRoot: runRoot,
      logger
    });
    return rowStatus(row, 'FAIL', 'unsafe_trace_evidence', {
      reason_codes: sanitized.reason_codes,
      raw_trace_deleted: sanitized.raw_trace_deleted
    });
  }
  const traceHealthy = Array.isArray(trace.errors) && trace.errors.length === 0 &&
    typeof trace.scoring?.overallPass === 'boolean';
  const requestedStatus = traceHealthy && trace.scoring.overallPass === true ? 'PASS' : 'FAIL';
  const expectedAssertionIds = new Set((row.assertions ?? []).map((assertion) => assertion.id));
  const recoveredFacts = new Set((trace.assertions ?? [])
    .filter((assertion) => assertion?.pass === true && expectedAssertionIds.has(assertion.id))
    .map((assertion) => assertion.id)).size;
  const normalized = normalizeContextModeTrace({
    row_id: row.id,
    triad_id: row.triad_id,
    variant: row.variant,
    settings_fingerprint: row.settings_fingerprint,
    evidence_class: evidence?.evidence_class,
    status: requestedStatus,
    reason: traceHealthy
      ? (trace.scoring.overallPass === true ? 'trace_verified' : 'assertions_failed')
      : 'trace_runtime_error',
    scoring: {
      overall_pass: trace.scoring?.overallPass,
      required_facts: expectedAssertionIds.size,
      recovered_facts: recoveredFacts
    },
    lifecycle: evidence?.lifecycle,
    cost: {
      cold_setup_ms: evidence?.cost?.cold_setup_ms,
      mcp_startup_ms: evidence?.cost?.mcp_startup_ms,
      index_ms: evidence?.cost?.index_ms,
      warm_query_ms: evidence?.cost?.warm_query_ms,
      answer_ms: evidence?.cost?.answer_ms,
      input_tokens: trace.cost?.inputTokens,
      output_tokens: trace.cost?.outputTokens
    },
    turns: Array.isArray(trace.turns)
      ? trace.turns.map((turn) => ({ tool_calls: countToolCalls(turn) }))
      : null,
    final_output: trace.finalOutput
  });
  return { ...normalized, trace_class: 'isolated_run_descendant' };
}

async function snapshotTraceFiles(runRoot) {
  const files = await collectJsonFiles(runRoot);
  const entries = await Promise.all(files.map(async (file) => [
    file,
    createHash('sha256').update(await readFile(file)).digest('hex')
  ]));
  return new Map(entries);
}

async function collectJsonFiles(root) {
  const files = [];
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return files;
    throw error;
  }
  for (const entry of entries) {
    const target = path.join(root, entry.name);
    const info = await lstat(target);
    if (info.isSymbolicLink()) continue;
    if (info.isDirectory()) files.push(...await collectJsonFiles(target));
    else if (info.isFile() && entry.name.endsWith('.json')) files.push(target);
  }
  return files.sort();
}

async function isCanonicalDescendant(rootPath, targetPath, { file = false } = {}) {
  try {
    const [rootInfo, targetInfo] = await Promise.all([lstat(rootPath), lstat(targetPath)]);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || targetInfo.isSymbolicLink()) return false;
    if (file ? !targetInfo.isFile() : !targetInfo.isDirectory()) return false;
    const [root, target] = await Promise.all([realpath(rootPath), realpath(targetPath)]);
    const relative = path.relative(root, target);
    return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
  } catch {
    return false;
  }
}

function rowStatus(row, status, reason, extra = {}) {
  return {
    row_id: row.id,
    triad_id: row.triad_id,
    variant: row.variant,
    settings_fingerprint: row.settings_fingerprint,
    status,
    reason,
    ...extra
  };
}

function countToolCalls(turn) {
  for (const value of [turn?.tool_calls, turn?.toolCalls]) {
    if (Array.isArray(value)) return value.length;
    const numeric = Number(value);
    if (Number.isInteger(numeric) && numeric >= 0) return numeric;
  }
  return 0;
}

function aggregateStatuses(statuses) {
  if (!Array.isArray(statuses) || statuses.length === 0) {
    return { status: 'NOT_RUN', reason: 'no_rows_passed' };
  }
  if (statuses.some((row) => row.status === 'FAIL')) return { status: 'FAIL', reason: 'row_failed' };
  if (statuses.some((row) => row.status === 'BLOCKED')) return { status: 'BLOCKED', reason: 'row_blocked' };
  if (statuses.every((row) => row.status === 'PASS')) return { status: 'PASS', reason: 'all_rows_passed' };
  return { status: 'NOT_RUN', reason: 'no_rows_passed' };
}

function minimalRunnerEnv(baseEnv) {
  const env = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP']) {
    if (typeof baseEnv[key] === 'string') env[key] = baseEnv[key];
  }
  return { ...env, CI: '1', NO_COLOR: '1' };
}

function firstLine(value) {
  return String(value ?? '').split(/\r?\n/, 1)[0].slice(0, 200);
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function runnerError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function logFix(logger, event, fields) {
  if (typeof logger !== 'function') return;
  logger(`[FIX:134] ${event} ${JSON.stringify(fields)}`);
}
