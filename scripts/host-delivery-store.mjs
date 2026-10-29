// Cooperative delivery custody. Checksums detect corruption, not a hostile local writer.
import { canonical, digest, fields, identifier, portablePath, requireValue, storeFor } from './workflow-state-store.mjs';
import { executionId } from './execution-task-source.mjs';
import { strictQaGate } from './qa-manifest-store.mjs';

export const DELIVERY_REQUEST_SCHEMA = 'aifhub.delivery-request.v1';
export const DELIVERY_RECORD_SCHEMA = 'aifhub.delivery.v1';
export const RECOVERY_ACTION_TYPES = Object.freeze(['provide-capabilities', 'read-request', 'wait-request', 'fetch-response',
  'resend-same-request', 'reconcile-host-state', 'resolve-identity-conflict']);
export const TRANSPORT_KEYS = Object.freeze(['create_calls', 'read_calls', 'fetch_calls', 'retry_creates', 'recovery_attempts',
  'verified_recoveries', 'uncertain_returns', 'identity_conflicts', 'transport_ms', 'recovery_ms', 'wait_ms', 'incomplete_intervals']);
export const DELIVERY_LIMITS = Object.freeze({ body: 16 * 1024 * 1024, stdin: 1024 * 1024, history: 256, requests: 200 });
const phases = ['reserved', 'prepared', 'in_flight', 'pending', 'observed_completed', 'uncertain', 'blocked', 'verified'];
const equal = (a, b) => canonical(a) === canonical(b);
const count = n => requireValue(Number.isSafeInteger(n) && n >= 0, 'invalid-delivery-state', true);
const hash = s => requireValue(typeof s === 'string' && /^[a-f0-9]{64}$/.test(s), 'invalid-delivery-state', true);
const date = s => requireValue(typeof s === 'string' && Number.isFinite(Date.parse(s)), 'invalid-delivery-state', true);
const opaque = s => requireValue(typeof s === 'string' && s.length > 0 && s.length <= 500 && !/[\x00-\x1f]/.test(s), 'invalid-delivery-state', true);
export function requestUuid(s) {
  requireValue(typeof s === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(s), 'invalid-request-uuid');
  return s;
}
export function deliveryPaths(change, uuid) {
  executionId(change); requestUuid(uuid);
  const folder = `.ai-factory/state/${change}/execution`;
  return { folder, request: `${folder}/requests/${uuid}.json`, body: `${folder}/request-bodies/${uuid}.utf8`,
    journal: `${folder}/delivery-journals/${uuid}.json`, projection: `.ai-factory/state/${change}/delivery/${uuid}.json` };
}
export function validateRecoveryAction(a) {
  fields(a, ['type', 'request_uuid'], ['preconditions']);
  requireValue(RECOVERY_ACTION_TYPES.includes(a.type), 'invalid-recovery-action', true); requestUuid(a.request_uuid);
  if (a.type === 'resend-same-request') {
    fields(a.preconditions, ['namespace_digest', 'continuity_token', 'capabilities_digest', 'body_sha256']);
    for (const k of ['namespace_digest', 'capabilities_digest', 'body_sha256']) hash(a.preconditions[k]);
    opaque(a.preconditions.continuity_token);
  } else requireValue(a.preconditions === undefined, 'invalid-recovery-action', true);
  return a;
}
export function validateDeliveryRecord(r) {
  fields(r, ['schema', 'request_uuid', 'change_id', 'run_id', 'task_id', 'target_kind', 'request_ref', 'retry_count', 'ack', 'query_state', 'updated_at']);
  requireValue(r.schema === DELIVERY_RECORD_SCHEMA, 'invalid-delivery-state', true);
  executionId(r.change_id); requestUuid(r.request_uuid); identifier(r.run_id); identifier(r.task_id);
  requireValue(['message', 'completion'].includes(r.target_kind) && ['unknown', 'pending', 'received'].includes(r.query_state)
    && typeof r.ack === 'boolean' && r.request_ref === deliveryPaths(r.change_id, r.request_uuid).request, 'invalid-delivery-state', true);
  count(r.retry_count); date(r.updated_at); return r;
}
export function frozenRequest(r) {
  return Object.fromEntries(['identity', 'binding', 'body', 'verdict', 'frozen_evidence'].map(k => [k, r[k]]));
}
export function validateDeliveryRequest(r) {
  fields(r, ['schema', 'request_uuid', 'revision', 'phase', 'slot', 'target', 'identity', 'binding', 'body', 'verdict', 'frozen_evidence',
    'frozen_digest', 'host', 'attempt_count', 'recovery', 'history', 'transport', 'interval', 'created_at', 'updated_at']);
  requireValue(r.schema === DELIVERY_REQUEST_SCHEMA && phases.includes(r.phase), 'invalid-delivery-state', true);
  requestUuid(r.request_uuid); count(r.revision); requireValue(r.revision > 0, 'invalid-delivery-state', true);
  fields(r.slot, ['change_id', 'run_id', 'task_id']); executionId(r.slot.change_id); identifier(r.slot.run_id); identifier(r.slot.task_id);
  fields(r.target, ['kind', 'locator']); requireValue(['message', 'completion'].includes(r.target.kind), 'invalid-delivery-state', true); opaque(r.target.locator);
  const p = deliveryPaths(r.slot.change_id, r.request_uuid);
  fields(r.body, ['path', 'encoding', 'byte_length', 'sha256']);
  requireValue(r.body.path === p.body && r.body.encoding === 'utf-8', 'invalid-delivery-state', true);
  count(r.body.byte_length); requireValue(r.body.byte_length <= DELIVERY_LIMITS.body, 'invalid-delivery-state', true); hash(r.body.sha256);
  count(r.attempt_count); count(r.transport.create_calls);
  fields(r.transport, TRANSPORT_KEYS); Object.values(r.transport).forEach(count);
  requireValue(r.attempt_count === r.transport.create_calls && r.transport.retry_creates === Math.max(0, r.attempt_count - 1), 'invalid-delivery-state', true);
  date(r.created_at); date(r.updated_at);
  fields(r.host, ['namespace_digest', 'capabilities_digest', 'continuity_token', 'request_state', 'message_id', 'completion_id', 'delivered_body_sha256']);
  for (const k of ['namespace_digest', 'capabilities_digest', 'delivered_body_sha256']) if (r.host[k] !== null) hash(r.host[k]);
  for (const k of ['message_id', 'completion_id', 'continuity_token']) if (r.host[k] !== null) opaque(r.host[k]);
  requireValue(['not_observed', 'not_found', 'pending', 'completed', 'unknown'].includes(r.host.request_state), 'invalid-delivery-state', true);
  if (r.recovery !== null) { validateRecoveryAction(r.recovery); requireValue(r.recovery.request_uuid === r.request_uuid, 'invalid-delivery-state', true); }
  if (r.interval !== null) {
    fields(r.interval, ['kind', 'started_at']); requireValue(['create', 'read', 'fetch', 'recovery'].includes(r.interval.kind), 'invalid-delivery-state', true); date(r.interval.started_at);
  }
  requireValue(Array.isArray(r.history) && r.history.length <= DELIVERY_LIMITS.history, 'invalid-delivery-state', true);
  let revision = 0;
  for (const e of r.history) {
    fields(e, ['revision', 'phase', 'at']); count(e.revision); date(e.at);
    requireValue(e.revision > revision && e.revision <= r.revision && phases.includes(e.phase), 'invalid-delivery-state', true); revision = e.revision;
  }
  requireValue(revision === r.revision && r.history.at(-1).phase === r.phase && r.history.at(-1).at === r.updated_at, 'invalid-delivery-state', true);
  if (r.phase === 'reserved') {
    requireValue([r.identity, r.binding, r.verdict, r.frozen_evidence, r.frozen_digest].every(v => v === null)
      && r.attempt_count === 0 && r.body.byte_length === 0 && r.body.sha256 === digest(Buffer.alloc(0)), 'invalid-delivery-state', true);
  } else {
    fields(r.identity, ['request_uuid', 'body_sha256', 'target_kind']);
    requireValue(r.identity.request_uuid === r.request_uuid && r.identity.body_sha256 === r.body.sha256 && r.identity.target_kind === r.target.kind, 'invalid-delivery-state', true);
    fields(r.binding, ['change_id', 'run_id', 'task_id', 'run_version_at_prepare', 'result_submitted_version', 'result_digest', 'source_digest', 'context_digest', 'worktree_digest', 'target_digest']);
    for (const k of ['change_id', 'run_id', 'task_id']) requireValue(r.binding[k] === r.slot[k], 'invalid-delivery-state', true);
    count(r.binding.run_version_at_prepare); count(r.binding.result_submitted_version);
    requireValue(r.binding.run_version_at_prepare > r.binding.result_submitted_version && r.binding.result_submitted_version > 0, 'invalid-delivery-state', true);
    for (const k of ['result_digest', 'source_digest', 'context_digest', 'worktree_digest', 'target_digest']) hash(r.binding[k]);
    requireValue(r.binding.target_digest === digest(r.target), 'invalid-delivery-state', true);
    fields(r.verdict, ['gate', 'gate_result_sha256']); hash(r.verdict.gate_result_sha256);
    requireValue(['verify', 'rules', 'review', 'security'].includes(r.verdict.gate), 'invalid-delivery-state', true);
    requireValue(r.frozen_evidence && typeof r.frozen_evidence === 'object' && !Array.isArray(r.frozen_evidence)
      && Object.keys(r.frozen_evidence).length <= 100, 'invalid-delivery-state', true);
    for (const [name, sha] of Object.entries(r.frozen_evidence)) { portablePath(name); hash(sha); }
    requireValue(Object.values(r.frozen_evidence).includes(r.body.sha256) && r.frozen_digest === digest(frozenRequest(r)), 'invalid-delivery-state', true);
  }
  if (r.phase === 'verified') requireValue(r.host.request_state === 'completed' && r.host.delivered_body_sha256 === r.body.sha256
    && typeof r.host[r.target.kind === 'message' ? 'message_id' : 'completion_id'] === 'string' && r.recovery === null, 'invalid-delivery-state', true);
  return r;
}
export function strictBody(data) {
  requireValue(Buffer.isBuffer(data) && data.length <= DELIVERY_LIMITS.body, 'delivery-body-too-large', true);
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data); }
  catch { requireValue(false, 'invalid-utf8', true); }
}
export async function readBody(store, descriptor) {
  fields(descriptor, ['path', 'sha256', 'byte_length', 'encoding']); portablePath(descriptor.path);
  requireValue(descriptor.encoding === 'utf-8', 'invalid-body-descriptor', true); hash(descriptor.sha256); count(descriptor.byte_length);
  const bytes = await store.bytes(descriptor.path);
  requireValue(bytes && bytes.length === descriptor.byte_length && digest(bytes) === descriptor.sha256, 'delivery-body-mismatch', true);
  strictBody(bytes); return bytes;
}
export async function validateFrozenBody(store, r) {
  const bytes = await readBody(store, r.body);
  requireValue(digest(strictQaGate(strictBody(bytes), r.verdict.gate)) === r.verdict.gate_result_sha256, 'delivery-gate-mismatch', true);
  return bytes;
}
export function projection(r) {
  return validateDeliveryRecord({ schema: DELIVERY_RECORD_SCHEMA, request_uuid: r.request_uuid, ...r.slot,
    target_kind: r.target.kind, request_ref: deliveryPaths(r.slot.change_id, r.request_uuid).request,
    retry_count: Math.max(0, r.attempt_count - 1), ack: r.phase === 'verified',
    query_state: r.phase === 'verified' ? 'received' : r.phase === 'pending' ? 'pending' : 'unknown', updated_at: r.updated_at });
}
export async function deliveryStore(options) {
  const store = await storeFor(options.rootDir);
  const hit = async name => { await options.failpoint?.(name); };
  const now = () => new Date(options.clock?.() ?? Date.now()).toISOString();
  async function project(r) {
    const p = deliveryPaths(r.slot.change_id, r.request_uuid), expected = projection(r), text = await store.textFile(p.projection);
    if (text !== null) {
      let actual; try { actual = validateDeliveryRecord(JSON.parse(text)); } catch { requireValue(false, 'invalid-delivery-projection', true); }
      for (const k of Object.keys(expected).filter(k => !['retry_count', 'ack', 'query_state', 'updated_at'].includes(k)))
        requireValue(equal(actual[k], expected[k]), 'delivery-identity-conflict', true);
    }
    await hit('before-delivery-projection'); await store.write(p.projection, JSON.stringify(expected) + '\n'); await hit('after-delivery-projection');
  }
  async function save(r, { preparing = false } = {}) {
    requireValue(r.history.length < DELIVERY_LIMITS.history, 'delivery-history-full', true);
    r.revision++; r.updated_at = now(); r.history.push({ revision: r.revision, phase: r.phase, at: r.updated_at });
    validateDeliveryRequest(r);
    const p = deliveryPaths(r.slot.change_id, r.request_uuid);
    if (preparing) await hit('before-prepare-journal');
    await store.save(p.journal, { schema: 'aifhub.delivery-journal.v1', request_uuid: r.request_uuid, record_digest: digest(r), record: r });
    if (preparing) await hit('after-prepare-journal');
    await store.save(p.request, r); await hit('after-registry-write'); await project(r);
  }
  async function load(change, uuid) {
    const p = deliveryPaths(change, uuid), j = await store.load(p.journal);
    let r = await store.load(p.request);
    if (j !== null) {
      fields(j, ['schema', 'request_uuid', 'record_digest', 'record']); validateDeliveryRequest(j.record);
      requireValue(j.schema === 'aifhub.delivery-journal.v1' && j.request_uuid === uuid && j.record_digest === digest(j.record), 'invalid-delivery-journal', true);
      if (r !== null) {
        validateDeliveryRequest(r);
        requireValue(equal(r.slot, j.record.slot) && equal(r.target, j.record.target) && r.request_uuid === j.request_uuid, 'delivery-identity-conflict', true);
        requireValue(j.record.revision >= r.revision && (j.record.revision !== r.revision || equal(j.record, r)), 'invalid-delivery-journal', true);
        if (r.phase !== 'reserved') requireValue(equal(frozenRequest(r), frozenRequest(j.record)), 'delivery-identity-conflict', true);
      }
      r = j.record;
    }
    requireValue(r, 'delivery-request-missing', true); validateDeliveryRequest(r);
    requireValue(r.slot.change_id === change && r.request_uuid === uuid, 'delivery-identity-conflict', true);
    return r;
  }
  return { ...store, hit, now, saveRequest: save, loadRequest: load, project };
}
