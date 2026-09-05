import { digest, readProviderFile } from './provider-files.mjs';
import { runProviderProcess } from './provider-process.mjs';

export const HLV_COMMAND_CONTRACT = Object.freeze({
  id: 'aifhub.hlv-cli', version: '1.0.0', toolVersion: '1.0.0',
  source: 'https://github.com/lee-to/hlv/tree/v1.0.0',
  operations: ['detect', 'status', 'doctor', 'validate', 'readiness', 'trace']
});
const STAGES = ['pending', 'verified', 'implementing', 'implemented', 'validating', 'validated'];
const count = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 1000000;
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

export async function detectHlv(rootDir, config, options = {}) {
  const root = await readProviderFile(rootDir, 'project.yaml', 256 * 1024);
  const adopt = await readProviderFile(rootDir, '.hlv/project.yaml', 256 * 1024);
  if (root && adopt) return { status: 'configuration_error', reason: 'ambiguous_layout', version: null, layout: null };
  const layout = root ? 'greenfield' : adopt ? 'adopt' : null;
  if (!layout) return { status: 'unavailable', reason: 'layout_missing', version: null, layout };
  return { ...await detectHlvVersion(rootDir, config, options), layout };
}

export async function detectHlvVersion(rootDir, config, options = {}) {
  const result = await invoke(['--version'], rootDir, config, options);
  const failure = processFailure(result);
  if (failure) return { ...failure, version: null };
  const match = result.stdout.trim().match(/^hlv ([0-9]{1,5}\.[0-9]{1,5}\.[0-9]{1,5})$/);
  if (result.exitCode !== 0 || !match) return { status: 'unsupported', reason: 'version_shape', version: null };
  const version = match[1];
  return { status: version === HLV_COMMAND_CONTRACT.toolVersion ? 'pass' : 'unsupported',
    reason: version === HLV_COMMAND_CONTRACT.toolVersion ? 'detected' : 'tool_version', version };
}

async function invoke(args, rootDir, config, options) {
  return (options.runProcess ?? runProviderProcess)(config.executable ?? 'hlv', args,
    { cwd: rootDir, timeoutMs: config.timeoutMs, maxOutputBytes: config.maxOutputBytes,
      signal: options.signal, env: options.env });
}

function processFailure(result) {
  if (result.outcome === 'completed') return null;
  const reason = ['timeout', 'cancelled', 'output_limit', 'unavailable', 'spawn_error', 'signal'].includes(result.outcome)
    ? result.outcome : 'process_error';
  return { status: reason === 'unavailable' ? 'unavailable' : 'infrastructure_error', reason };
}

export async function runHlvOperation(operation, rootDir, config, options = {}) {
  const command = { validate: 'check', readiness: 'workflow', status: 'status', doctor: 'doctor', trace: 'trace' }[operation];
  if (!command) return { status: 'unsupported', reason: 'operation_unavailable', diagnostics: [] };
  const result = await invoke(['--root', rootDir, command, '--json'], rootDir, config, options);
  const streams = { stdout: result.stdout.length ? 'present' : 'empty', stderr: result.stderr.length ? 'present' : 'empty',
    exitCode: Number.isInteger(result.exitCode) ? result.exitCode : null };
  const failure = processFailure(result);
  if (failure) return { ...failure, diagnostics: [], streams };
  let payload;
  try { payload = JSON.parse(result.stdout); } catch {
    return { status: result.exitCode === 0 ? 'unsupported' : 'infrastructure_error',
      reason: 'json_missing_or_invalid', diagnostics: [], streams };
  }
  try {
    const normalized = normalizeHlvResult(operation, payload, result.exitCode);
    return { ...normalized, streams };
  } catch {
    return { status: 'unsupported', reason: 'result_schema', diagnostics: [], streams };
  }
}

export function normalizeHlvResult(operation, payload, exitCode) {
  if (operation === 'doctor' || operation === 'validate') {
    if (!object(payload) || !Array.isArray(payload.diagnostics) || payload.diagnostics.length > 2000
      || ![0, 1, 2].includes(exitCode) || payload.exit_code !== exitCode) throw new Error('schema');
    const diagnostics = payload.diagnostics.map((item) => {
      if (!object(item) || !/^[A-Z]{2,5}-[0-9]{3}$/.test(item.code)
        || !['error', 'warning', 'info'].includes(item.severity)) throw new Error('schema');
      return { code: item.code, severity: item.severity };
    }).sort((a, b) => a.code.localeCompare(b.code) || a.severity.localeCompare(b.severity));
    const errors = diagnostics.filter((item) => item.severity === 'error').length;
    const warnings = diagnostics.filter((item) => item.severity === 'warning').length;
    if (exitCode === 0 && errors || exitCode === 1 && !errors) throw new Error('contradictory_exit');
    if (operation === 'validate' && (!count(payload.errors) || !count(payload.warnings) || !count(payload.infos)
      || payload.errors !== errors || payload.warnings !== warnings
      || payload.infos !== diagnostics.length - errors - warnings
      || !['relaxed', 'standard', 'strict'].includes(payload.strictness))) throw new Error('schema');
    const status = diagnostics.some((item) => item.code === 'DOC-080') ? 'unsupported'
      : diagnostics.some((item) => ['DOC-001', 'DOC-002', 'PRJ-001'].includes(item.code)) ? 'configuration_error'
        : errors || exitCode === 1 ? 'fail' : warnings || exitCode === 2 ? 'warn' : 'pass';
    return { status, reason: 'validation_result', diagnostics, summary: { errors, warnings, infos: diagnostics.length - errors - warnings } };
  }
  if (exitCode !== 0) throw new Error('nonzero_query');
  if (operation === 'readiness') {
    if (!object(payload) || !count(payload.phase) || payload.phase > 5 || !Array.isArray(payload.stages)
      || payload.stages.length > 1000) throw new Error('schema');
    const stages = payload.stages.map((stage) => {
      if (!object(stage) || !STAGES.includes(stage.status) || !count(stage.task_count)
        || !count(stage.tasks_done) || stage.tasks_done > stage.task_count) throw new Error('schema');
      return { status: stage.status, tasks: stage.task_count, done: stage.tasks_done };
    });
    const applicable = payload.milestone_id !== undefined;
    if (applicable && typeof payload.milestone_id !== 'string' || !applicable && stages.length) throw new Error('schema');
    const ready = !applicable || stages.length > 0 && stages.every((stage) => stage.status === 'validated' && stage.done === stage.tasks);
    return { status: ready ? 'pass' : 'fail', reason: !applicable ? 'no_active_milestone' : ready ? 'stages_validated' : 'stages_not_validated', diagnostics: [],
      summary: { applicable, stages: stages.length, validated: stages.filter((stage) => stage.status === 'validated').length } };
  }
  if (operation === 'status') {
    if (!object(payload) || typeof payload.project !== 'string' || !count(payload.history_count)
      || payload.milestone !== undefined && (!object(payload.milestone) || !Array.isArray(payload.milestone.stages))) {
      throw new Error('schema');
    }
    return { status: 'pass', reason: 'status_available', diagnostics: [],
      summary: { milestone: payload.milestone !== undefined, history: payload.history_count } };
  }
  if (operation === 'trace') {
    if (payload === null) return { status: 'unavailable', reason: 'trace_missing', diagnostics: [] };
    if (!object(payload) || payload.schema_version !== undefined && payload.schema_version !== 1
      || !Array.isArray(payload.requirements) || !Array.isArray(payload.mappings)
      || payload.requirements.length > 2000 || payload.mappings.length > 2000
      || !payload.requirements.every((item) => object(item) && typeof item.id === 'string' && typeof item.statement === 'string')
      || !payload.mappings.every((item) => object(item) && typeof item.requirement === 'string'
        && ['contracts', 'scenarios', 'tests', 'runtime_gates'].every((key) => Array.isArray(item[key])
          && item[key].every((value) => typeof value === 'string')))) throw new Error('schema');
    // The native trace model is not a neutral requirement graph. Preserve its
    // content identity without copying project-owned strings into public QA.
    return { status: 'pass', reason: 'trace_exported', diagnostics: [],
      summary: { contentDigest: digest(JSON.stringify(payload)), format: 'hlv-trace-1.0.0' } };
  }
  throw new Error('operation');
}
