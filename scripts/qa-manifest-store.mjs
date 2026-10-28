// QA storage primitives. Local integrity bookkeeping, not hostile-process isolation.
import { open, readdir } from 'node:fs/promises';
import { digest, canonical, storeFor, portablePath, identifier, requireValue } from './workflow-state-store.mjs';
import { extractGateResultBlocks, getLatestGateResult, SUPPORTED_GATES } from './aif-gate-result.mjs';

export const QA_LIMITS = Object.freeze({ files: 20000, blob: 16 * 1024 * 1024,
  bytes: 256 * 1024 * 1024, checks: 64, results: 256, refs: 256 });
export const QA_SCHEMA = 'aifhub.qa-manifest.v1';
export const sorted = values => [...new Set(values)].sort();
export const within = (file, root) => file === root || file.startsWith(`${root}/`);
export const gateView = (target, gate) => `${target.qa}/${target.flow === 'classic' && gate === 'rules' ? 'gates/rules' : gate}.md`;

export function jsonValue(value) {
  requireValue(value === null || ['string', 'boolean'].includes(typeof value)
    || (typeof value === 'number' && Number.isFinite(value))
    || (Array.isArray(value) && value.every(v => { jsonValue(v); return true; }))
    || (value && [Object.prototype, null].includes(Object.getPrototypeOf(value))
      && Object.values(value).every(v => { jsonValue(v); return true; })), 'invalid-json-value', true);
  return value;
}

export function qaTarget(options = {}) {
  const flow = options.flow ?? (options.plan ? 'classic' : 'openspec');
  const id = identifier(options.id ?? options.changeId ?? options.plan);
  const namespace = identifier(options.namespace ?? flow);
  const qa = portablePath(options.qaDir ?? (flow === 'classic'
    ? options.planDir ?? `.ai-factory/plans/${id}` : `.ai-factory/qa/${id}`));
  requireValue(!qa.split('/').some(p => p.toLowerCase() === '.git')
    && !within(qa, 'openspec/changes'), 'unsafe-qa-directory', true);
  return { flow, id, namespace, qa };
}

export async function qaStore(options = {}) {
  const store = await storeFor(options.rootDir);
  const target = qaTarget(options);
  const qa = target.qa;
  async function bytes(relative) {
    const data = await store.bytes(portablePath(relative));
    if (options.readBudget) {
      options.readBudget.bytes += data?.length ?? 0;
      requireValue(options.readBudget.bytes <= QA_LIMITS.bytes, 'qa-read-budget', true);
    }
    return data;
  }
  async function json(relative) {
    const data = await bytes(relative);
    if (data === null) return null;
    try { return JSON.parse(data.toString('utf8')); } catch { requireValue(false, 'invalid-qa-json', true); }
  }
  async function immutable(relative, value) {
    const data = Buffer.isBuffer(value) ? value : Buffer.from(typeof value === 'string' ? value : `${canonical(jsonValue(value))}\n`);
    requireValue(data.length <= QA_LIMITS.blob, 'qa-blob-limit', true);
    const filename = await store.target(relative, true);
    let handle;
    try { handle = await open(filename, 'wx', 0o600); }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      requireValue((await bytes(relative))?.equals(data), 'immutable-conflict', true);
      return;
    }
    try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
  }
  async function enrollment() {
    const value = await json(`${qa}/enrollment.json`);
    if (value !== null) requireValue(value.schema === 'aifhub.qa-enrollment.v1'
      && canonical(value.target) === canonical(target), 'enrollment-target-mismatch', true);
    return value;
  }
  async function manifest() {
    const pointer = await json(`${qa}/manifest.json`);
    requireValue(pointer && typeof pointer.wave_id === 'string', 'manifest-missing', true);
    identifier(pointer.wave_id);
    const value = await json(`${qa}/waves/${pointer.wave_id}/inputs.json`);
    requireValue(value?.schema === QA_SCHEMA && value.manifest_digest === digest(value.payload)
      && pointer.manifest_digest === value.manifest_digest, 'manifest-digest-mismatch', true);
    requireValue(canonical(value.payload.target) === canonical(target), 'manifest-target-mismatch', true);
    requireValue(options.waveId === undefined || options.waveId === value.payload.wave_id, 'wave-id-mismatch', true);
    return value;
  }
  async function results() {
    const directory = `${qa}/results`;
    let names;
    try { names = await readdir(await store.target(directory)); }
    catch (e) { if (e.code === 'ENOENT') return []; throw e; }
    requireValue(names.length <= QA_LIMITS.results, 'qa-results-limit', true);
    const records = [];
    for (const name of names.sort()) {
      requireValue(name.endsWith('.json'), 'result-catalog-invalid', true);
      identifier(name.slice(0, -5));
      const envelope = await json(`${directory}/${name}`);
      requireValue(envelope?.checksum === digest(envelope.record), 'result-digest-mismatch', true);
      requireValue(envelope.record.id === name.slice(0, -5), 'result-id-mismatch', true);
      records.push(envelope.record);
    }
    return records;
  }
  return { ...store, safeTarget: store.target, target, qa, bytes, json, immutable, enrollment, manifest, results,
    lock: action => store.lock(`${qa}/qa.lock`, action) };
}

// Strict final block: neither wrong-gate nor an unclosed attempt may hide a prior PASS.
export function strictQaGate(markdown, gate) {
  requireValue(SUPPORTED_GATES.includes(gate) && typeof markdown === 'string', 'invalid-gate-evidence', true);
  const lines = markdown.replaceAll('\r\n', '\n').split('\n');
  let start = -1;
  for (let i = 0; i < lines.length; i++) if (lines[i].trimEnd() === '```aif-gate-result') start = i;
  requireValue(start >= 0 && lines.slice(start + 1).some(line => line.trim() === '```'), 'invalid-gate-evidence', true);
  const latest = getLatestGateResult(markdown, { gate });
  requireValue(latest?.ok && extractGateResultBlocks(markdown).at(-1)?.startLine === latest.startLine,
    'invalid-gate-evidence', true);
  return latest.result;
}

export function qaFailure(error) {
  const code = error?.code && /^[a-z][a-z0-9-]+$/.test(error.code) ? error.code : 'qa-custody-unavailable';
  return { ok: false, enrolled: true, state: 'blocked', code, affected_checks: [], authorizes: [],
    errors: [{ code, message: `QA binding blocked: ${code}.` }] };
}
