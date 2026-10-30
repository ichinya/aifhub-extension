import os from 'node:os';
import path from 'node:path';
import { lstat } from 'node:fs/promises';
import { digest, readProviderFile, safeId, safeProviderPath } from './provider-files.mjs';
import { runProviderProcess } from './provider-process.mjs';
import { normalizeSemanticEvidence } from './semantic-provider-contract.mjs';

export const LEKALO_COMMAND_CONTRACT = Object.freeze({
  id: 'aifhub.lekalo-cli', version: '1.1.0', toolVersion: '1.1.0',
  source: 'https://github.com/ichinya/lekalo/tree/v1.1.0',
  operations: ['detect', 'status', 'doctor', 'validate', 'readiness', 'trace', 'impact', 'context']
});
export const LEKALO_WORKFLOW_CONTRACT = Object.freeze({
  identity: 'dev.lekalo.workflow-provider@0.8.0', schemaVersion: 'lekalo/workflow-provider/v0.8.0',
  // Entire reviewed manifest: closed fields, operations, effects, bounds and pins.
  manifestDigest: 'sha256:a674f1dd6f5608a28b8f1727bcddae4ad67adceace33e871ebb4334f091315d0',
  maxExportBytes: 33554432
});
const CHECKS = ['project.root', 'model.version', 'model.references', 'fs.confinement', 'lock.freshness',
  'adapters.inventory', 'adapters.trust', 'capabilities.profiles', 'bindings.freshness', 'artifacts.drift',
  'tools.gates', 'cache.health', 'integrations.hlv', 'platform.limits'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const count = value => Number.isSafeInteger(value) && value >= 0 && value <= 1000000;
const ref = value => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
const symbol = value => typeof value === 'string' && value.length <= 256
  && /^(project|module|type|entity|operation|policy|event|effect|endpoint|scenario|target-binding|requirement):[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
const hashRef = value => `sha256:${digest(value)}`;
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  return object(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
}
const unsupported = reason => ({ status: 'unsupported', reason, diagnostics: [] });

async function invoke(args, cwd, config, options) {
  if (config.executable !== undefined && (typeof config.executable !== 'string'
    || !path.isAbsolute(config.executable) || /[\x00-\x1f]/.test(config.executable)
    || /\.(?:cmd|bat|ps1|sh|mjs|js)$/i.test(config.executable))) {
    return { outcome: 'configuration_error', stdout: '', stderr: '', exitCode: null };
  }
  const result = await (options.runProcess ?? runProviderProcess)(config.executable ?? 'lekalo', args,
    { cwd, timeoutMs: config.timeoutMs, maxOutputBytes: config.maxOutputBytes, signal: options.signal, env: options.env });
  return Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) > (config.maxOutputBytes ?? 1024 * 1024)
    ? { ...result, outcome: 'output_limit', stdout: '', stderr: '' } : result;
}
function processFailure(result) {
  if (result.outcome === 'completed') return null;
  if (result.outcome === 'output_limit') return { status: 'infrastructure_error', reason: 'output_overflow' };
  const reason = ['timeout', 'cancelled', 'unavailable', 'spawn_error', 'signal', 'configuration_error'].includes(result.outcome)
    ? result.outcome : 'process_error';
  return { status: reason === 'unavailable' ? 'unavailable'
    : reason === 'configuration_error' ? 'configuration_error' : 'infrastructure_error', reason };
}

export async function detectLekaloVersion(rootDir, config = {}, options = {}) {
  // Discovery has no project input; never execute it in the consumer project.
  const versionResult = await invoke(['--version'], os.tmpdir(), config, options);
  const failed = processFailure(versionResult);
  if (failed) return { ...failed, version: null };
  const match = versionResult.stdout.trim().match(/^lekalo ([0-9]{1,5}\.[0-9]{1,5}\.[0-9]{1,5})$/);
  if (versionResult.exitCode !== 0 || !match) return { status: 'unsupported', reason: 'version_shape', version: null };
  const version = match[1];
  if (version !== LEKALO_COMMAND_CONTRACT.toolVersion) return { status: 'unsupported', reason: 'tool_version', version };
  const result = await invoke(['provider', 'describe', '--json'], os.tmpdir(), config, options);
  const failure = processFailure(result);
  if (failure) return { ...failure, version };
  try {
    const payload = JSON.parse(result.stdout);
    const { manifestDigest, ...manifest } = payload.manifest;
    if (result.exitCode !== 0 || payload.status !== 'valid'
      || manifest.identity !== LEKALO_WORKFLOW_CONTRACT.identity || manifest.schemaVersion !== LEKALO_WORKFLOW_CONTRACT.schemaVersion
      || manifestDigest !== LEKALO_WORKFLOW_CONTRACT.manifestDigest || hashRef(JSON.stringify(canonical(manifest))) !== manifestDigest) throw new Error('manifest');
    return { status: 'pass', reason: 'detected', version };
  } catch { return { status: 'unsupported', reason: 'capability_contract', version }; }
}

export async function detectLekalo(rootDir, config = {}, options = {}) {
  const marker = await readProviderFile(rootDir, 'lekalo/project.yaml', 256 * 1024);
  if (marker === null) return { status: 'unavailable', reason: 'layout_missing', version: null, layout: null };
  return { ...await detectLekaloVersion(rootDir, config, options), layout: 'adopt' };
}

function diagnosticsFrom(payload) {
  const rows = payload.diagnostics ?? [];
  if (!Array.isArray(rows) || rows.length > 2000) throw new Error('diagnostics');
  return rows.map(item => {
    if (!object(item) || !/^LEK-[A-Z]{2,12}-[0-9]{3}$/.test(item.code)
      || !['error', 'warning', 'info'].includes(item.severity)) throw new Error('diagnostic');
    const result = { code: item.code, severity: item.severity };
    if (item.id !== undefined) {
      if (typeof item.id !== 'string' || item.id.length > 128 || !/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/.test(item.id)) throw new Error('id');
      result.id = item.id;
    }
    if (item.category !== undefined) {
      if (!['model', 'semantic', 'compatibility', 'adapter', 'infrastructure', 'security'].includes(item.category)) throw new Error('category');
      result.category = item.category;
    }
    return result;
  });
}

export function normalizeLekaloResult(operation, payload, exitCode) {
  if (!object(payload)) throw new Error('envelope');
  const diagnostics = diagnosticsFrom(payload);
  if (exitCode !== 0) {
    const expected = { 1: ['invalid'], 3: ['denied'], 4: ['unsupported', 'unavailable'], 5: ['unsupported-version'] }[exitCode];
    if (!expected?.includes(payload.status) || [1, 3, 5].includes(exitCode) && !diagnostics.length) throw new Error('exit_envelope');
    return { status: exitCode === 4 ? payload.status : exitCode === 5 ? 'unsupported' : 'fail',
      reason: exitCode === 1 ? 'validation_result' : exitCode === 3 ? 'denied' : exitCode === 5 ? 'contract_version' : 'capability_unavailable', diagnostics };
  }
  if (payload.status !== 'valid') throw new Error('status');
  if (['status', 'doctor', 'readiness'].includes(operation)) {
    if (payload.schemaVersion !== 'lekalo/doctor/v0.3.2' || payload.identity !== 'dev.lekalo.doctor@0.3.2'
      || payload.report !== operation || !['ready', 'degraded', 'blocked'].includes(payload.verdict)
      || !Array.isArray(payload.checks) || !payload.checks.length || payload.checks.length > CHECKS.length
      || new Set(payload.checks.map(item => item.id)).size !== payload.checks.length
      || !payload.checks.every(item => object(item) && CHECKS.includes(item.id)
        && ['ok', 'degraded', 'blocked', 'unknown'].includes(item.state) && typeof item.required === 'boolean')
      || operation === 'readiness' && payload.phase !== 'release') throw new Error('report');
    const blocked = payload.checks.some(item => (item.required || operation === 'doctor') && ['blocked', 'unknown'].includes(item.state));
    const degraded = payload.checks.some(item => item.state !== 'ok');
    if (payload.verdict === 'ready' && degraded || payload.verdict !== 'blocked' && blocked) throw new Error('contradictory_report');
    return { status: { ready: 'pass', degraded: 'warn', blocked: 'fail' }[payload.verdict], reason: 'report_verdict', diagnostics };
  }
  if (operation === 'validate') {
    const report = payload.validation;
    if (payload.modelVersion !== '0.2.16' || !object(report) || !['default', 'strict'].includes(report.profile)
      || report.profileVersion !== '0.6.4' || report.registryVersion !== '0.6.4'
      || !count(report.rulesEnabled) || report.rulesEnabled === 0 || report.rulesEnabled > 4096
      || !object(report.counts) || !['error', 'warning', 'info'].every(key => count(report.counts[key])
        && report.counts[key] === diagnostics.filter(item => item.severity === key).length)
      || (payload.diagnostics === undefined) !== (payload.reasonCodes === undefined)
      || payload.reasonCodes !== undefined && (!Array.isArray(payload.reasonCodes) || !diagnostics.length
        || payload.reasonCodes.length !== diagnostics.length || payload.reasonCodes.some((id, i) => id !== diagnostics[i].id))
      || report.profile === 'strict' && report.counts.error) throw new Error('validation');
    return { status: diagnostics.length ? 'warn' : 'pass', reason: 'validation_result', diagnostics,
      summary: { errors: report.counts.error, warnings: report.counts.warning, infos: report.counts.info } };
  }
  if (operation === 'trace') {
    const trace = payload.trace;
    if (trace === null || trace === undefined) return { status: 'unavailable', reason: 'trace_missing', diagnostics };
    if (!object(trace) || trace.schemaVersion !== 'lekalo/trace-manifest/v0.2.16'
      || trace.identity !== 'dev.lekalo.trace-manifest@0.2.16' || !ref(payload.manifestDigest)
      || hashRef(JSON.stringify(trace)) !== payload.manifestDigest
      || !['full', 'partial'].includes(trace.completeness) || !Array.isArray(trace.nodes)
      || !Array.isArray(trace.relations) || !Array.isArray(trace.gaps)
      || trace.nodes.length > 100000 || trace.relations.length > 250000 || trace.gaps.length > 10000
      || (trace.completeness === 'full') !== (trace.gaps.length === 0)) throw new Error('trace');
    return { status: trace.completeness === 'partial' ? 'warn' : 'pass', reason: 'trace_exported', diagnostics,
      summary: { contentDigest: digest(JSON.stringify(trace)), format: 'lekalo-trace-manifest-v0.2.16' } };
  }
  throw new Error('operation');
}

async function execute(args, rootDir, config, options) {
  const result = await invoke(args, rootDir, config, options);
  const streams = { stdout: result.stdout.length ? 'present' : 'empty', stderr: result.stderr.length ? 'present' : 'empty',
    exitCode: Number.isInteger(result.exitCode) ? result.exitCode : null };
  const failure = processFailure(result);
  if (failure) return { failure: { ...failure, diagnostics: [], streams } };
  if (![0, 1, 3, 4, 5].includes(result.exitCode)) return { failure: {
    status: 'infrastructure_error', reason: 'unexpected_exit', diagnostics: [], streams } };
  try {
    const payload = JSON.parse([1, 5].includes(result.exitCode) ? result.stderr : result.stdout);
    return { payload, exitCode: result.exitCode, streams };
  } catch { return { failure: { status: 'infrastructure_error', reason: 'json_missing_or_invalid', diagnostics: [], streams } }; }
}

async function traceArgs(rootDir, options) {
  const relative = options.tracePath ?? (safeId(options.changeId)
    ? `.ai-factory/traces/${options.changeId}/lekalo-trace-manifest.json` : null);
  if (relative === null || relative === '') return null;
  if (typeof relative !== 'string' || !relative.startsWith('.ai-factory/traces/')) throw new Error('trace_custody');
  const target = await safeProviderPath(rootDir, relative);
  if (!target.exists) return null;
  const stat = await lstat(target.path);
  if (!stat.isFile()) throw new Error('trace_custody');
  if (stat.size > LEKALO_WORKFLOW_CONTRACT.maxExportBytes) return 'overflow';
  try { await readProviderFile(rootDir, relative, LEKALO_WORKFLOW_CONTRACT.maxExportBytes); }
  catch (error) {
    if (error.message === 'file_limit' || (await lstat(target.path)).size > LEKALO_WORKFLOW_CONTRACT.maxExportBytes) return 'overflow';
    throw error;
  }
  return ['trace', 'export', target.path];
}

const SEMANTIC_MANIFEST = { contract: { id: 'aifhub.provider', version: '1.0.0' }, kind: 'semantic_model',
  toolVersion: '1.1.0', operations: ['validate', 'impact', 'context', 'trace'] };
function normalizedProcessResult(operation, result) {
  try { return { ...normalizeLekaloResult(operation, result.payload, result.exitCode), streams: result.streams }; }
  catch { return { ...unsupported('result_schema'), streams: result.streams }; }
}
function normalizeImpact(payload) {
  const impact = payload.impact;
  if (payload.status !== 'valid' || !object(impact) || impact.schemaVersion !== 'lekalo/impact/v0.2.16'
    || impact.identity !== 'dev.lekalo.impact@0.2.16' || !ref(impact.digest)
    || !Array.isArray(impact.roots) || impact.roots.length > 128 || !impact.roots.every(symbol)
    || !object(impact.completeness) || typeof impact.completeness.complete !== 'boolean') throw new Error('impact');
  const ids = new Set(impact.roots);
  for (const key of ['direct', 'transitive', 'mandatoryPublic']) {
    const items = impact[key]?.items ?? [];
    if (!object(impact[key]) || !Array.isArray(items) || items.length > 2000) throw new Error('impact_section');
    for (const item of items) {
      if (!object(item) || !symbol(item.subject)) throw new Error('impact_symbol');
      ids.add(item.subject);
    }
  }
  if (ids.size > 2000) throw new Error('semantic_overflow');
  return { ids: impact.roots, refs: [...ids].map(hashRef), complete: impact.completeness.complete, digest: impact.digest };
}
async function runSemantic(operation, rootDir, config, options) {
  const impactResult = await execute(['impact', '--changed', '--worktree', '--project', rootDir], rootDir, config, options);
  if (impactResult.failure) return impactResult.failure;
  if (impactResult.exitCode !== 0) return normalizedProcessResult('impact', impactResult);
  let result = impactResult;
  try {
    const impact = normalizeImpact(impactResult.payload);
    // Impact alone has no context capsule. Never relabel its digest as context.
    let context = null;
    if (operation === 'context') {
      if (!impact.ids.length) return { status: 'unavailable', reason: 'changed_symbols_missing', diagnostics: [] };
      result = await execute(['context', '--changed', impact.ids.join(','), '--budget', '5000', '--project', rootDir], rootDir, config, options);
      if (result.failure) return result.failure;
      if (result.exitCode !== 0) return normalizedProcessResult(operation, result);
      const capsule = result.payload.context;
      if (result.payload.status !== 'valid' || !object(capsule)
        || !['0.2.16', '0.8.0'].some(version => capsule.schemaVersion === `lekalo/context/v${version}` && capsule.identity === `dev.lekalo.context@${version}`)
        || !object(capsule.budget) || !count(capsule.budget.estimated) || !count(capsule.budget.minimumRequired)
        || typeof capsule.budget.fits !== 'boolean' || capsule.budget.limit !== 5000 || typeof capsule.complete !== 'boolean'
        || !object(capsule.manifest) || !Array.isArray(capsule.manifest.excluded) || capsule.manifest.excluded.length > 50000
        || capsule.budget.fits && (capsule.budget.estimated > 5000 || capsule.budget.minimumRequired > 5000)) throw new Error('context');
      context = { digest: hashRef(JSON.stringify(capsule)), tokens: capsule.budget.estimated,
        fits: capsule.budget.fits, minimumRequired: capsule.budget.minimumRequired,
        complete: capsule.complete && impact.complete && capsule.budget.fits && capsule.manifest.excluded.length === 0,
        excluded: capsule.manifest.excluded.length };
    }
    const diagnostics = diagnosticsFrom(result.payload);
    const complete = impact.complete && context?.complete !== false;
    const status = diagnostics.some(item => item.severity === 'error') ? 'fail'
      : !complete || context?.fits === false || context?.excluded > 0 || diagnostics.length ? 'warn' : 'pass';
    const semantic = normalizeSemanticEvidence(SEMANTIC_MANIFEST, { status,
      diagnostics: diagnostics.map((item, index) => ({ code: item.code, severity: item.severity,
        symbol: hashRef(result.payload.diagnostics[index].symbol ?? item.id ?? item.code) })),
      impact: impact.refs, context, complete, trace: { schemaVersion: '1.0.0', links: [] } });
    if (!['pass', 'warn', 'fail'].includes(semantic.status)) return { ...unsupported(semantic.reason), streams: result.streams };
    return { status, reason: 'semantic_result', diagnostics, semantic, streams: result.streams };
  } catch (error) {
    return { ...(error.message === 'semantic_overflow'
      ? { status: 'infrastructure_error', reason: 'export_overflow', diagnostics: [] } : unsupported('result_schema')),
    streams: result.streams };
  }
}

export async function runLekaloOperation(operation, rootDir, config = {}, options = {}) {
  if (operation === 'detect') return { ...await detectLekalo(rootDir, config, options), diagnostics: [] };
  if (!LEKALO_COMMAND_CONTRACT.operations.includes(operation)) return unsupported('operation_unavailable');
  try {
    if (['impact', 'context'].includes(operation)) return await runSemantic(operation, rootDir, config, options);
    const args = operation === 'trace' ? await traceArgs(rootDir, options)
      : operation === 'validate' ? ['validate', '--no-cache', '--project', rootDir]
        : operation === 'readiness' ? ['readiness', '--phase', 'done', '--project', rootDir] : [operation, '--project', rootDir];
    if (args === null) return { status: 'unavailable', reason: 'trace_missing', diagnostics: [] };
    if (args === 'overflow') return { status: 'infrastructure_error', reason: 'export_overflow', diagnostics: [] };
    const result = await execute(args, rootDir, config, options);
    if (result.failure) return result.failure;
    return normalizedProcessResult(operation, result);
  } catch (error) {
    return error.message === 'semantic_overflow' ? { status: 'infrastructure_error', reason: 'export_overflow', diagnostics: [] }
      : unsupported('unsafe_path_or_result_schema');
  }
}
