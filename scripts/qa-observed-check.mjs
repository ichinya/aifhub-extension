// Producer adapter for trusted completion-hook observations (#227). The adapter
// supplies registry-backed evidence only; verification, readiness and archive
// authority stay with their existing owners.
import { open } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { digest, canonical, identifier, portablePath, requireValue, fields, storeFor, WorkflowError } from './workflow-state-store.mjs';
import { qaStore, qaTarget, qaFailure, withinCi, jsonValue, QA_LIMITS } from './qa-manifest-store.mjs';
import { observeQaSnapshot, checkFingerprints } from './qa-manifest-inputs.mjs';
import { createGateResult, renderGateResultBlock } from './aif-gate-result.mjs';
import { recordBoundEvidence } from './qa-manifest-record.mjs';

export const OBSERVED_RUN_SCHEMA = 'aifhub.observed-run.v1';
export const OBSERVATION_RECORD_SCHEMA = 'aifhub.observation.v1';
export const OBSERVED_CHECK_RECEIPT_SCHEMA = 'aifhub.observed-check.v1';
// Process outcomes (completed/failed/timeout/cancelled) and availability outcomes
// (unsupported/missing-report) stay distinct. The consumer treats every
// non-completed outcome as non-PASS, so the adapter must never mask a negative
// outcome into a `warn` gate status: a publish accepts any non-`fail` gate.
export const OBSERVED_OUTCOMES = Object.freeze(['completed', 'failed', 'timeout', 'cancelled', 'unsupported', 'missing-report']);
const SHA = /^[a-f0-9]{64}$/;
const REPORT_FREE_OUTCOMES = ['timeout', 'cancelled', 'missing-report'];

// Deterministic replay key: a crash after installing the result must not grow a
// second corrective record (a random id would auto-supersede the open tip).
export function observedResultId(runId) {
  identifier(runId);
  return `observed-${digest(runId).slice(0, 16)}`;
}

function observationPaths(qa, runId) {
  identifier(runId);
  const dir = `${qa}/artifacts/observations`;
  return { dir, lock: `${dir}/observations.lock`, record: `${dir}/${runId}.json`,
    receipt: `${dir}/receipts/${runId}.json`, reports: `${dir}/reports` };
}

// Strict closed-shape validation of the versioned producer envelope. Unknown
// fields, malformed digests and inconsistent declarations are typed rejections
// before any state is touched.
function validateEnvelope(value) {
  requireValue(value && typeof value === 'object' && !Array.isArray(value), 'observation-envelope-invalid', true);
  // An unsupported capability is an adapter-level blocker detected before strict
  // validation: no verifier launch, no receipt, no registry record.
  if (value.schema === OBSERVED_RUN_SCHEMA && value.outcome === 'unsupported') return null;
  fields(value, ['schema', 'run_id', 'check_id', 'covered_checks', 'change_id', 'manifest_digest',
    'command', 'effective_cwd', 'worktree_identity', 'snapshot_digest', 'fingerprints_digest',
    'modules_digest', 'outcome', 'exit_code', 'report_path', 'report_sha256', 'artifacts']);
  requireValue(value.schema === OBSERVED_RUN_SCHEMA, 'observation-envelope-invalid', true);
  identifier(value.run_id); identifier(value.check_id); identifier(value.change_id);
  requireValue(Array.isArray(value.covered_checks) && value.covered_checks.length === 1
    && value.covered_checks[0] === value.check_id, 'observation-multi-check', true);
  requireValue(OBSERVED_OUTCOMES.includes(value.outcome), 'observation-envelope-invalid', true);
  for (const key of ['manifest_digest', 'snapshot_digest', 'fingerprints_digest', 'modules_digest'])
    requireValue(SHA.test(value[key]), 'observation-envelope-invalid', true);
  requireValue(value.command && typeof value.command === 'object' && !Array.isArray(value.command), 'observation-envelope-invalid', true);
  fields(value.command, ['argv', 'cwd', 'definition']);
  requireValue(Array.isArray(value.command.argv) && value.command.argv.length > 0
    && value.command.argv.every(a => typeof a === 'string' && a.length > 0 && !a.includes('\0')), 'observation-envelope-invalid', true);
  requireValue(typeof value.command.cwd === 'string', 'observation-envelope-invalid', true);
  requireValue(value.command.definition === null || typeof value.command.definition === 'string', 'observation-envelope-invalid', true);
  requireValue(typeof value.effective_cwd === 'string' && value.effective_cwd.length > 0, 'observation-envelope-invalid', true);
  for (const p of [value.effective_cwd, value.command.cwd]) if (p !== '.') portablePath(p);
  if (value.command.definition) portablePath(value.command.definition);
  requireValue(typeof value.worktree_identity === 'string' && value.worktree_identity.length > 0, 'observation-envelope-invalid', true);
  requireValue(value.exit_code === null || (Number.isInteger(value.exit_code)
    && value.exit_code >= 0 && value.exit_code <= 255), 'observation-envelope-invalid', true);
  requireValue(typeof value.report_path === 'string' && value.report_path.length > 0, 'observation-envelope-invalid', true);
  portablePath(value.report_path);
  requireValue(value.report_sha256 === null || SHA.test(value.report_sha256), 'observation-envelope-invalid', true);
  requireValue(value.artifacts && typeof value.artifacts === 'object' && !Array.isArray(value.artifacts)
    && Object.keys(value.artifacts).length <= QA_LIMITS.refs, 'observation-envelope-invalid', true);
  for (const [relative, hash] of Object.entries(value.artifacts)) {
    portablePath(relative);
    requireValue(SHA.test(hash), 'observation-envelope-invalid', true);
  }
  if (REPORT_FREE_OUTCOMES.includes(value.outcome)) {
    requireValue(value.exit_code === null && value.report_sha256 === null
      && Object.keys(value.artifacts).length === 0, 'observation-envelope-invalid', true);
  } else {
    requireValue(Number.isInteger(value.exit_code) && SHA.test(value.report_sha256)
      && value.artifacts[value.report_path] === value.report_sha256, 'observation-declared-mismatch', true);
    requireValue(value.outcome !== 'completed' || value.exit_code === 0, 'observation-envelope-invalid', true);
    requireValue(value.outcome !== 'failed' || (value.exit_code > 0), 'observation-envelope-invalid', true);
  }
  jsonValue(value);
  return value;
}

function registryEnvelope(record) {
  return Buffer.from(`${JSON.stringify({ checksum: digest(record), record }, null, 2)}\n`);
}

async function readRegistryRecord(store, paths, runId) {
  const data = await store.bytes(paths.record);
  if (data === null) return null;
  let envelope;
  try { envelope = JSON.parse(data.toString('utf8')); } catch { return null; }
  if (!envelope?.record || envelope.checksum !== digest(envelope.record)) return null;
  return envelope.record;
}

// Exclusive custody write: `wx` first-write-wins; canonical orphan bytes from a
// crashed earlier attempt are adopted, anything else fails closed.
async function writeExclusive(store, relative, data, conflictCode = 'observation-incomplete') {
  const filename = await store.target(relative, true);
  let handle;
  try { handle = await open(filename, 'wx', 0o600); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const existing = await store.bytes(relative);
    requireValue(existing !== null && existing.equals(data), conflictCode, true);
    return 'adopted';
  }
  try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
  return 'written';
}

// Registry records only ever move forward (absent -> pending -> complete) under
// the registry lock; a crash between the unlink and the rewrite leaves no record,
// so `lookup` fails closed instead of exposing a half-written observation.
async function saveRegistryRecord(store, paths, record) {
  await store.remove(paths.record).catch(error => { if (error.code !== 'ENOENT') throw error; });
  return writeExclusive(store, paths.record, registryEnvelope(record));
}

function registryView(record) {
  return { run_id: record.run_id, check_id: record.check_id, result_id: record.result_id,
    receipt_sha256: record.receipt_sha256, receipt_path: record.receipt_path,
    worktree_identity: record.worktree_identity, exit_code: record.exit_code, outcome: record.outcome };
}

// Injectable host-owned observation registry. Only complete records are visible:
// pending intents and orphan bytes never confirm a check on the consumer side.
export function observationRegistry(rootDir, changeId, options = {}) {
  const target = qaTarget({ ...options, rootDir, changeId });
  async function lookup(runId) {
    try { identifier(runId); } catch { return null; }
    const store = await storeFor(rootDir);
    const record = await readRegistryRecord(store, observationPaths(target.qa, runId), runId);
    return record && record.state === 'complete' ? registryView(record) : null;
  }
  return { lookup, qa: target.qa };
}
