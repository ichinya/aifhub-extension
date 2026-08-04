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
  runBoundedProcess,
  runSandboxLifecycle
} from './context-mode-codex-ai-tester-adapter.mjs';
import { validateReasoningProof } from './context-mode-codex-ai-tester-matrix.mjs';
import {
  buildContextModeResults,
  auditCodexRolloutRecords,
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
  privacyScanByRow = {},
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
    if (row.session_mode === 'same_thread' && (row.prompts?.length ?? 0) > 1 &&
        row.resume_driver_parity !== true) {
      statuses.push(rowStatus(row, 'NOT_RUN', 'resume_driver_parity_unavailable'));
      continue;
    }
    if (row.session_mode === 'external_fresh_pair') {
      statuses.push(rowStatus(row, 'NOT_RUN', 'fresh_session_driver_unavailable'));
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
    const before = await snapshotTraceFiles(runRoot);
    const rawBefore = row.variant === 'baseline'
      ? null
      : await snapshotRolloutFiles(path.join(env.CODEX_HOME, 'sessions'));
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
      privacyScan: privacyScanByRow[row.id],
      rawBefore,
      codexHome: env.CODEX_HOME,
      sandboxRoot: path.dirname(env.HOME),
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
  const profileProof = validateReasoningProof(options.reasoningProofRecords);
  if (profileProof.status !== 'PASS') {
    return {
      schema: CONTEXT_MODE_RUNNER_SCHEMA,
      status: 'NOT_RUN',
      reason: profileProof.reason,
      statuses: []
    };
  }
  const layout = buildSandboxLayout(options.sandboxRoot);
  if (path.resolve(options.scenarioRoot) !== layout.scenarios ||
      path.resolve(options.runRoot) !== layout.runs) {
    return {
      schema: CONTEXT_MODE_RUNNER_SCHEMA,
      status: 'NOT_RUN',
      reason: 'run_root_config_mismatch',
      statuses: []
    };
  }
  if (!options.sandboxOwnerRoot) {
    return {
      schema: CONTEXT_MODE_RUNNER_SCHEMA,
      status: 'NOT_RUN',
      reason: 'cleanup_boundary_unavailable',
      statuses: []
    };
  }
  if (!await isCanonicalDescendant(options.sandboxOwnerRoot, options.sandboxRoot)) {
    return {
      schema: CONTEXT_MODE_RUNNER_SCHEMA,
      status: 'NOT_RUN',
      reason: 'sandbox_outside_cleanup_owner',
      statuses: []
    };
  }
  const checkpoint = validatePriorRowResults(options.matrix, {
    completedRowIds: options.completedRowIds,
    priorRowResults: options.priorRowResults
  });
  if (checkpoint.status !== 'PASS') {
    return {
      schema: CONTEXT_MODE_RUNNER_SCHEMA,
      status: 'NOT_RUN',
      reason: checkpoint.reason,
      statuses: []
    };
  }
  const pendingRows = planMissingRows(options.matrix.rows, checkpoint.completedRowIds);
  const providerPurgeRequired = pendingRows.some((row) =>
    row.variant !== 'baseline' && row.execution_gate?.status === 'PASS'
  );
  if (providerPurgeRequired && typeof options.purgeProvider !== 'function') {
    return {
      schema: CONTEXT_MODE_RUNNER_SCHEMA,
      status: 'NOT_RUN',
      reason: 'provider_purge_unavailable',
      statuses: []
    };
  }
  let lifecycle;
  try {
    lifecycle = await runSandboxLifecycle({
      ownerRoot: options.sandboxOwnerRoot,
      sandboxRoot: options.sandboxRoot,
      purge: options.purgeProvider,
      purgeRequired: providerPurgeRequired,
      logger: options.logger,
      run: async () => {
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
        const boundedEnv = buildContextModeEnv({
          layout,
          baseEnv: options.env ?? process.env
        });
        const executed = await executeMissingRows({
          ...options,
          completedRowIds: checkpoint.completedRowIds,
          env: boundedEnv
        });
        const statuses = mergeMatrixStatuses(
          options.matrix.rows,
          checkpoint.rows,
          executed.statuses
        );
        const aggregate = aggregateStatuses(statuses);
        const results = buildContextModeResults(statuses);
        return { ...executed, ...aggregate, statuses, provenance, profileProof, results };
      }
    });
  } catch (error) {
    return {
      schema: CONTEXT_MODE_RUNNER_SCHEMA,
      status: 'NOT_RUN',
      reason: error?.code ?? 'cleanup_boundary_unavailable',
      statuses: []
    };
  }
  return { ...lifecycle, schema: CONTEXT_MODE_RUNNER_SCHEMA };
}

async function inspectFreshTrace({
  runRoot,
  before,
  row,
  evidence,
  privacyScan,
  rawBefore,
  codexHome,
  sandboxRoot,
  logger
}) {
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
  const scanMaterial = normalizePrivacyScanMaterial(privacyScan);
  if (scanMaterial.status !== 'PASS') {
    return rowStatus(row, 'NOT_RUN', scanMaterial.reason);
  }
  const scan = scanCompleteTrace({ trace, evidence }, scanMaterial);
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
  if (row.variant !== 'baseline') {
    const providerAudit = await inspectFreshProviderRollouts({
      codexHome,
      before: rawBefore,
      row,
      sandboxRoot
    });
    if (providerAudit.status !== 'PASS') {
      return rowStatus(row, providerAudit.status, providerAudit.reason, {
        provider_audit: providerAudit
      });
    }
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

async function inspectFreshProviderRollouts({ codexHome, before, row, sandboxRoot }) {
  const sessionsRoot = path.join(codexHome, 'sessions');
  const after = await snapshotRolloutFiles(sessionsRoot);
  const changed = [...after.entries()]
    .filter(([file, snapshot]) => before?.get(file)?.digest !== snapshot.digest)
    .map(([file]) => file);
  const records = [];
  for (const file of changed) {
    if (!await isCanonicalDescendant(sessionsRoot, file, { file: true })) {
      return auditCodexRolloutRecords([], {
        sandboxRoot,
        requiredTools: row.raw_provider_policy?.required_tools,
        allowedTools: row.raw_provider_policy?.allowed_tools,
        allowedCommands: row.raw_provider_policy?.allowed_commands
      });
    }
    const previous = before?.get(file);
    const body = await readFile(file);
    let delta = body;
    if (previous) {
      const prefix = body.subarray(0, previous.size);
      const prefixDigest = createHash('sha256').update(prefix).digest('hex');
      if (body.length < previous.size || !previous.ends_with_newline || prefixDigest !== previous.digest) {
        return invalidRawProviderAudit(records.length);
      }
      delta = body.subarray(previous.size);
    }
    for (const line of delta.toString('utf8').split(/\r?\n/).filter(Boolean)) {
      try {
        records.push(JSON.parse(line));
      } catch {
        return invalidRawProviderAudit(records.length);
      }
    }
  }
  return auditCodexRolloutRecords(records, {
    sandboxRoot,
    requiredTools: row.raw_provider_policy?.required_tools ?? [],
    allowedTools: row.raw_provider_policy?.allowed_tools ?? [],
    allowedCommands: row.raw_provider_policy?.allowed_commands ?? []
  });
}

async function snapshotTraceFiles(runRoot) {
  const files = await collectJsonFiles(runRoot);
  const entries = await Promise.all(files.map(async (file) => [
    file,
    createHash('sha256').update(await readFile(file)).digest('hex')
  ]));
  return new Map(entries);
}

async function snapshotRolloutFiles(root) {
  const files = await collectFilesBySuffix(root, '.jsonl');
  const entries = await Promise.all(files.map(async (file) => {
    const body = await readFile(file);
    return [file, {
      digest: createHash('sha256').update(body).digest('hex'),
      size: body.length,
      ends_with_newline: body.length === 0 || body.at(-1) === 0x0a
    }];
  }));
  return new Map(entries);
}

function invalidRawProviderAudit(recordCount) {
  return {
    status: 'NOT_RUN',
    reason: 'raw_provider_audit_invalid',
    record_count: recordCount,
    tool_counts: {},
    required_tools_present: false,
    forbidden_tools_absent: false,
    paths_confined: false
  };
}

async function collectJsonFiles(root) {
  return collectFilesBySuffix(root, '.json');
}

async function collectFilesBySuffix(root, suffix) {
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
    if (info.isDirectory()) files.push(...await collectFilesBySuffix(target, suffix));
    else if (info.isFile() && entry.name.endsWith(suffix)) files.push(target);
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

function normalizePrivacyScanMaterial(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { status: 'NOT_RUN', reason: 'privacy_scan_material_missing' };
  }
  const canaries = normalizeScanStrings(value.canaries);
  const contentFingerprints = normalizeScanStrings(value.contentFingerprints);
  if (!canaries || !contentFingerprints || canaries.length === 0 || contentFingerprints.length === 0) {
    return { status: 'NOT_RUN', reason: 'privacy_scan_material_missing' };
  }
  return { status: 'PASS', canaries, contentFingerprints };
}

function normalizeScanStrings(values) {
  if (!Array.isArray(values) || values.some((value) =>
    typeof value !== 'string' || value.length === 0 || value.length > 512
  )) return null;
  return [...new Set(values)];
}

function validatePriorRowResults(matrix, { completedRowIds, priorRowResults } = {}) {
  const matrixRows = Array.isArray(matrix?.rows) ? matrix.rows : [];
  const matrixById = new Map(matrixRows.map((row) => [row.id, row]));
  const requested = completedRowIds instanceof Set
    ? new Set([...completedRowIds].map(String))
    : new Set(Array.isArray(completedRowIds) ? completedRowIds.map(String) : []);
  const prior = Array.isArray(priorRowResults) ? priorRowResults : [];
  if (requested.size > 0 && prior.length === 0) {
    return { status: 'NOT_RUN', reason: 'completed_row_evidence_missing' };
  }
  if (requested.size === 0) {
    for (const record of prior) requested.add(String(record?.row_id ?? ''));
  }
  const byId = new Map();
  for (const record of prior) {
    const rowId = String(record?.row_id ?? '');
    const expected = matrixById.get(rowId);
    if (!expected || byId.has(rowId) || !requested.has(rowId) ||
        record.triad_id !== expected.triad_id || record.variant !== expected.variant ||
        record.settings_fingerprint !== expected.settings_fingerprint ||
        !['PASS', 'FAIL', 'BLOCKED', 'NOT_RUN'].includes(record.status) ||
        !priorStatusEvidenceComplete(record)) {
      return { status: 'NOT_RUN', reason: 'completed_row_evidence_invalid' };
    }
    byId.set(rowId, sanitizePriorRowResult(record));
  }
  if (requested.size !== byId.size || [...requested].some((rowId) => !byId.has(rowId))) {
    return { status: 'NOT_RUN', reason: 'completed_row_evidence_missing' };
  }
  return {
    status: 'PASS',
    completedRowIds: requested,
    rows: matrixRows.filter((row) => byId.has(row.id)).map((row) => byId.get(row.id))
  };
}

function priorStatusEvidenceComplete(record) {
  if (record.status !== 'PASS') return typeof record.reason === 'string' && record.reason.length > 0;
  const costKeys = [
    'cold_setup_ms', 'mcp_startup_ms', 'index_ms', 'warm_query_ms', 'answer_ms',
    'input_tokens', 'output_tokens', 'input_output_tokens'
  ];
  return record.correctness_pass === true && record.privacy_pass === true &&
    record.purge_pass === true && record.cleanup_pass === true &&
    typeof record.continuity_pass === 'boolean' &&
    typeof record.evidence_class === 'string' && record.evidence_class.length > 0 &&
    costKeys.every((key) => Number.isFinite(record.cost?.[key]) && record.cost[key] >= 0);
}

function sanitizePriorRowResult(record) {
  return {
    row_id: record.row_id,
    triad_id: record.triad_id,
    variant: record.variant,
    settings_fingerprint: record.settings_fingerprint,
    status: record.status,
    reason: record.reason,
    correctness_pass: record.correctness_pass,
    privacy_pass: record.privacy_pass,
    purge_pass: record.purge_pass,
    cleanup_pass: record.cleanup_pass,
    continuity_pass: record.continuity_pass,
    evidence_class: record.evidence_class,
    cost: record.cost ? { ...record.cost } : undefined,
    tool_calls: Number.isInteger(record.tool_calls) ? record.tool_calls : undefined,
    turns: Number.isInteger(record.turns) ? record.turns : undefined,
    final_output_bytes: Number.isInteger(record.final_output_bytes) ? record.final_output_bytes : undefined
  };
}

function mergeMatrixStatuses(matrixRows, priorRows, currentRows) {
  const byId = new Map();
  for (const row of [...priorRows, ...currentRows]) byId.set(row.row_id, row);
  return matrixRows.map((row) => byId.get(row.id) ?? rowStatus(
    row,
    'NOT_RUN',
    'row_evidence_missing'
  ));
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
