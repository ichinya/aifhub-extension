import { randomUUID } from 'node:crypto';
import { canonical, digest, fields, requireValue } from './workflow-state-store.mjs';
import { deliveryAdmission } from './execution-state.mjs';
import { strictQaGate } from './qa-manifest-store.mjs';
import { DELIVERY_REQUEST_SCHEMA, DELIVERY_RECORD_SCHEMA, RECOVERY_ACTION_TYPES, DELIVERY_LIMITS, TRANSPORT_KEYS,
  deliveryPaths, deliveryStore, requestUuid, validateDeliveryRequest, validateDeliveryRecord, validateRecoveryAction,
  frozenRequest, strictBody, readBody, validateFrozenBody, projection } from './host-delivery-store.mjs';
export { DELIVERY_REQUEST_SCHEMA, DELIVERY_RECORD_SCHEMA, RECOVERY_ACTION_TYPES, validateDeliveryRequest,
  validateDeliveryRecord, validateRecoveryAction };
// Records one bounded send/recover action may still append after the host
// create: up to six operate calls with a pre/post save each, plus the final
// verification write (review F2 / rules gate R1).
const HISTORY_HEADROOM = 16;
const same = (a, b) => canonical(a) === canonical(b);
const common = ['change_id', 'run_id', 'request_uuid'];
const optional = ['task_id', 'target', 'body', 'body_file', 'binding'];
const lock = (s, change, fn) => s.lock('.ai-factory/state/execution-write.lock', () => s.lock(`${deliveryPaths(change, '00000000-0000-4000-8000-000000000000').folder}/write.lock`, fn));
const bindingFor = ({ run, result, task_id }, target) => ({ change_id: run.change_id, run_id: run.run_id, task_id,
  run_version_at_prepare: run.version, result_submitted_version: result.submitted_version, result_digest: result.digest,
  source_digest: run.source.namespace_digest, context_digest: result.context_digest, worktree_digest: result.worktree_digest, target_digest: digest(target) });

export async function reserveDeliverySlot(input, options = {}) {
  fields(input, ['change_id', 'run_id', 'target'], ['task_id', 'request_uuid']);
  const uuid = requestUuid(input.request_uuid ?? randomUUID()), s = await deliveryStore(options), p = deliveryPaths(input.change_id, uuid);
  return lock(s, input.change_id, async () => {
    const a = await deliveryAdmission(s, input, { resultRequired: false });
    let existing = null;
    try { existing = await s.loadRequest(input.change_id, uuid); }
    catch (error) { if (error.code !== 'delivery-request-missing') throw error; }
    if (existing) {
      requireValue(same(existing.slot, { change_id: input.change_id, run_id: input.run_id, task_id: a.task_id }) && same(existing.target, input.target), 'delivery-identity-conflict', true);
      const persisted = await s.bytes(p.request);
      if (persisted === null) {
        // Interrupted between journal and registry: rebuild the registry entry
        // and verify every stable name before admitting the replay (review F3).
        const bytes = await s.bytes(p.body);
        requireValue(bytes !== null && digest(bytes) === existing.body?.sha256, 'delivery-integrity', true);
        await s.saveRequest(existing);
      }
      await s.project(existing); return localView(existing, a);
    }
    requireValue(Object.keys(await s.inventory(`${p.folder}/requests`)).length < DELIVERY_LIMITS.requests, 'delivery-registry-full', true);
    const timestamp = s.now();
    const r = { schema: DELIVERY_REQUEST_SCHEMA, request_uuid: uuid, revision: 0, phase: 'reserved',
      slot: { change_id: input.change_id, run_id: input.run_id, task_id: a.task_id }, target: structuredClone(input.target),
      identity: null, binding: null, body: { path: p.body, encoding: 'utf-8', byte_length: 0, sha256: digest(Buffer.alloc(0)) },
      verdict: null, frozen_evidence: null, frozen_digest: null,
      host: { namespace_digest: null, capabilities_digest: null, continuity_token: null, request_state: 'not_observed', message_id: null, completion_id: null, delivered_body_sha256: null },
      attempt_count: 0, recovery: null, history: [], transport: Object.fromEntries(TRANSPORT_KEYS.map(k => [k, 0])), interval: null, created_at: timestamp, updated_at: timestamp };
    // Material names exist before the QA wave, even though bytes are not prepared yet.
    await s.write(p.body, Buffer.alloc(0)); await s.saveRequest(r); return localView(r, a);
  });
}
async function suppliedBody(s, input) {
  requireValue(!(input.body !== undefined && input.body_file !== undefined), 'invalid-input');
  if (input.body_file !== undefined) return readBody(s, input.body_file);
  if (input.body !== undefined) {
    requireValue(typeof input.body === 'string' || Buffer.isBuffer(input.body), 'invalid-input');
    const bytes = Buffer.isBuffer(input.body) ? input.body : Buffer.from(input.body, 'utf8');
    const text = strictBody(bytes);
    requireValue(Buffer.isBuffer(input.body) || text === input.body, 'invalid-utf8', true); return bytes;
  }
  return null;
}
function localView(r, admission, extra = {}) {
  return { ok: !['blocked', 'uncertain'].includes(r.phase), request_uuid: r.request_uuid, request_revision: r.revision, state: r.phase,
    query_state: projection(r).query_state, body_sha256: r.identity?.body_sha256 ?? null,
    delivery_verified: false, reservation_retained: admission.reservation_retained, retry_create_allowed: false,
    recovery_action: r.recovery, host_state: r.host.request_state, authorizes: [], historical: admission.historical,
    persisted: admission.mutating !== false,
    runner_metrics: { schema: 'aifhub.runner_metrics.v1', run_id: r.slot.run_id, transport: structuredClone(r.transport) }, ...extra };
}
async function assertIdentity(s, r, input, a) {
  requireValue(input.run_id === r.slot.run_id && (input.task_id === undefined || input.task_id === r.slot.task_id)
    && (input.target === undefined || same(input.target, r.target)), 'delivery-identity-conflict', true);
  if (r.phase !== 'reserved') {
    const expected = bindingFor(a, r.target);
    // The original admission version is frozen; subsequent execution authority is owned elsewhere.
    expected.run_version_at_prepare = r.binding.run_version_at_prepare;
    requireValue(same(expected, r.binding) && same(a.result.evidence_digests, r.frozen_evidence)
      && (input.binding === undefined || same(input.binding, r.binding)), 'delivery-identity-conflict', true);
    const bytes = await suppliedBody(s, input);
    requireValue(bytes === null || digest(bytes) === r.body.sha256, 'delivery-identity-conflict', true);
    await validateFrozenBody(s, r);
  }
}
export async function prepareDelivery(input, options = {}) {
  fields(input, [...common, 'gate'], optional);
  const s = await deliveryStore(options);
  return lock(s, input.change_id, async () => {
    const r = await s.loadRequest(input.change_id, input.request_uuid), a = await deliveryAdmission(s, r.slot);
    try {
      await assertIdentity(s, r, input, a);
      requireValue(r.verdict === null || input.gate === r.verdict.gate, 'delivery-identity-conflict', true);
    } catch (error) {
      if (error.code !== 'delivery-identity-conflict' || r.phase === 'reserved') throw error;
      r.phase = 'blocked'; r.recovery = action(r, 'resolve-identity-conflict'); r.transport.identity_conflicts++;
      await s.saveRequest(r); return localView(r, a, { ok: false, code: error.code });
    }
    if (r.phase !== 'reserved') {
      requireValue(input.gate === r.verdict.gate, 'delivery-identity-conflict', true); await s.project(r); return localView(r, a);
    }
    const bytes = await suppliedBody(s, input); requireValue(bytes, 'delivery-body-required', true);
    const gate = strictQaGate(strictBody(bytes), input.gate);
    requireValue(Object.values(a.result.evidence_digests).includes(digest(bytes)), 'delivery-body-not-frozen-evidence', true);
    r.identity = { request_uuid: r.request_uuid, body_sha256: digest(bytes), target_kind: r.target.kind };
    r.binding = bindingFor(a, r.target); r.body.byte_length = bytes.length; r.body.sha256 = digest(bytes);
    r.verdict = { gate: input.gate, gate_result_sha256: digest(gate) }; r.frozen_evidence = structuredClone(a.result.evidence_digests);
    r.frozen_digest = digest(frozenRequest(r)); r.phase = 'prepared';
    await s.hit('before-body-write'); await s.write(r.body.path, bytes); await s.hit('after-body-write');
    await s.saveRequest(r, { preparing: true }); return localView(r, a);
  });
}
function action(r, type, preconditions) {
  return validateRecoveryAction({ type, request_uuid: r.request_uuid, ...(preconditions ? { preconditions } : {}) });
}
function validCapabilities(c, r, s) {
  const i = c?.idempotency;
  return c?.idempotent_create === true && c.read_by_request_id === true && c.fetch_response === true
    && c.target_kinds?.includes(r.target.kind) && /^[a-f0-9]{64}$/.test(i?.scope_digest)
    && typeof i.continuity_token === 'string' && i.continuity_token.length > 0 && i.conflicting_payload === 'reject'
    && (i.retention_until === 'durable' || Date.parse(i.retention_until) > Date.parse(s.now()));
}
function preconditions(r) {
  return { namespace_digest: r.host.namespace_digest, continuity_token: r.host.continuity_token,
    capabilities_digest: r.host.capabilities_digest, body_sha256: r.body.sha256 };
}
// A host adapter sends this Buffer on stdin; argv contains only its fixed action.
// The file descriptor is checked locally before this function is used for create.
export function deliveryTransportInput(request, capabilities) {
  const { body, body_file, ...control } = request;
  const serialized = Buffer.from(JSON.stringify({ ...control, body: strictBody(body) }));
  if (serialized.length <= DELIVERY_LIMITS.stdin && capabilities.transport?.utf8_stdin === true)
    return { transport: 'stdin', stdin: serialized };
  if (capabilities.transport?.utf8_file === true && body_file) {
    const stdin = Buffer.from(JSON.stringify({ ...control, body_file }));
    requireValue(stdin.length <= DELIVERY_LIMITS.stdin, 'input-too-large', true);
    return { transport: 'file', stdin };
  }
  return null;
}
async function bounded(fn, options) {
  const ms = options.hostTimeoutMs ?? 5000;
  requireValue(Number.isSafeInteger(ms) && ms >= 1 && ms <= 300000, 'invalid-host-timeout');
  let timer;
  try { return await Promise.race([Promise.resolve().then(fn), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('host-timeout')), ms); })]); }
  finally { clearTimeout(timer); }
}
async function operate(kind, s, r, fn, options, writable) {
  if (writable) {
    if (r.interval) { r.transport.incomplete_intervals++; r.interval = null; }
    r.transport[`${kind}_calls`]++;
    if (kind === 'create') { r.attempt_count++; r.transport.retry_creates = Math.max(0, r.attempt_count - 1); }
    r.interval = { kind, started_at: s.now() }; await s.saveRequest(r);
  }
  const start = Date.parse(s.now());
  try { return await bounded(fn, options); }
  finally {
    if (writable) { r.transport.transport_ms += Math.max(0, Date.parse(s.now()) - start); r.interval = null; await s.saveRequest(r); }
  }
}
async function resolveRequest(input, options, mode) {
  fields(input, common, [...optional, 'recovery_action']);
  if (input.recovery_action !== undefined) validateRecoveryAction(input.recovery_action);
  const s = await deliveryStore(options), inspect = mode === 'inspect';
  return lock(s, input.change_id, async () => {
    const r = await s.loadRequest(input.change_id, input.request_uuid);
    const a = await deliveryAdmission(s, r.slot, { historical: true, resultRequired: r.phase !== 'reserved', mutating: !inspect });
    if (a.historical && !inspect) return localView(r, a, { ok: false, code: 'delivery-historical-only', query_state: 'unknown', state: 'blocked' });
    const writable = !inspect && !a.historical;
    const start = Date.parse(s.now());
    async function finish(extra) {
      if (writable) {
        if (mode === 'recover') r.transport.recovery_ms += Math.max(0, Date.parse(s.now()) - start);
        await s.saveRequest(r);
      }
      return localView(r, a, extra);
    }
    async function uncertain(code, type, { conflict = false, pending = false, retry = false } = {}) {
      if (writable) {
        r.transport[conflict ? 'identity_conflicts' : 'uncertain_returns']++;
        // A transient observation failure does not erase historical verification.
        if (r.phase !== 'verified' || conflict) r.phase = conflict ? 'blocked' : pending ? 'pending' : 'uncertain';
        r.recovery = r.phase === 'verified' ? null : action(r, type);
      }
      return finish({ ok: false, state: conflict ? 'blocked' : 'uncertain', code, query_state: pending ? 'pending' : 'unknown',
        delivery_verified: false, retry_create_allowed: retry,
        recovery_action: action(r, type), ...(retry ? { resend_preconditions: preconditions(r) } : {}) });
    }
    try { await assertIdentity(s, r, input, a); }
    catch (e) { if (e.code === 'delivery-identity-conflict') return uncertain(e.code, 'resolve-identity-conflict', { conflict: true }); throw e; }
    if (r.phase === 'reserved') return localView(r, a, { ok: false, code: 'delivery-not-prepared' });
    if (r.phase === 'blocked') return localView(r, a, { ok: false, code: 'delivery-identity-conflict', query_state: 'unknown' });
    if (writable) {
      if (r.interval) { r.transport.incomplete_intervals++; r.interval = null; }
      if (mode === 'recover') r.transport.recovery_attempts++;
      await s.saveRequest(r);
    }
    const client = options.HostClient;
    let caps;
    try { caps = await bounded(() => client?.capabilities(), options); } catch { /* No mutation before capability admission. */ }
    if (!validCapabilities(caps, r, s) || !['createRequest', 'readRequest', 'fetchResponse'].every(k => typeof client?.[k] === 'function'))
      return uncertain('delivery-capabilities-required', 'provide-capabilities');
    const scope = caps.idempotency.scope_digest, continuity = caps.idempotency.continuity_token;
    if (r.host.namespace_digest !== null && r.host.namespace_digest !== scope)
      return uncertain('delivery-identity-conflict', 'resolve-identity-conflict', { conflict: true });
    if (r.host.continuity_token !== null && r.host.continuity_token !== continuity)
      return uncertain('delivery-host-continuity-lost', 'reconcile-host-state');
    if (writable) {
      r.host.namespace_digest = scope; r.host.continuity_token = continuity; r.host.capabilities_digest = digest(caps); await s.saveRequest(r);
    }
    const query = { request_uuid: r.request_uuid, namespace_digest: scope };
    async function read() {
      const found = await operate('read', s, r, () => client.readRequest(query), options, writable);
      await s.hit('after-host-read'); return found;
    }
    let found;
    try { found = await read(); } catch { return uncertain('delivery-observation-unavailable', 'read-request'); }
    if (!found || !['not_found', 'pending', 'completed', 'conflict'].includes(found.state)) return uncertain('delivery-observation-unavailable', 'read-request');
    if (found.state === 'not_found') {
      if (r.phase === 'verified') return uncertain('delivery-request-not-observed', 'reconcile-host-state');
      if (writable) r.host.request_state = 'not_found';
      const proof = found.namespace_digest === scope && found.continuity_token === continuity && found.deduplication_retained === true;
      const retry = proof && r.attempt_count > 0 && r.host.capabilities_digest === digest(caps);
      if (inspect) return uncertain('delivery-request-not-observed', 'reconcile-host-state');
      if (r.attempt_count > 0) {
        const expectedAction = action(r, 'resend-same-request', preconditions(r));
        if (!retry || !same(input.recovery_action, expectedAction)) return uncertain('delivery-request-not-observed', 'reconcile-host-state', { retry });
      }
      if (!proof) return uncertain('delivery-host-state-unproven', 'reconcile-host-state');
      const bytes = await validateFrozenBody(s, r);
      const request = { request_uuid: r.request_uuid, identity: structuredClone(r.identity), binding: structuredClone(r.binding),
        target: structuredClone(r.target), body: Buffer.from(bytes), body_file: structuredClone(r.body) };
      const transfer = deliveryTransportInput(request, caps);
      if (!transfer) return uncertain('delivery-transport-capability-required', 'provide-capabilities');
      // Journaled intent is durable before create. A crash here requires read-by-UUID.
      await s.hit('before-send-intent'); r.phase = 'in_flight'; await s.saveRequest(r); await s.hit('after-send-intent');
      await s.hit('before-host-create');
      try {
        // The operation still has to record its own outcome: without headroom a
        // committed completion could never be persisted (review F2).
        requireValue(r.history.length + HISTORY_HEADROOM <= DELIVERY_LIMITS.history, 'delivery-history-full', true);
        await operate('create', s, r, () => client.createRequest({ ...request, transport: transfer.transport, serialized_input: transfer.stdin }), options, true);
      } catch { /* Local failure is not a remote outcome: observe below. */ }
      await s.hit('after-host-response');
      try { found = await read(); } catch { return uncertain('delivery-observation-unavailable', 'read-request'); }
      if (found?.state === 'not_found') return uncertain('delivery-request-not-observed', 'reconcile-host-state', { retry: found.namespace_digest === scope && found.continuity_token === continuity && found.deduplication_retained === true });
    }
    if (!found || found.state === 'not_found') return uncertain('delivery-observation-unavailable', 'read-request');
    if (found.state === 'conflict' || !same(found.identity, r.identity) || !same(found.target, r.target)
      || found.namespace_digest !== scope || found.continuity_token !== continuity || !same(found.binding, r.binding))
      return uncertain('delivery-identity-conflict', 'resolve-identity-conflict', { conflict: true });
    const idKey = r.target.kind === 'message' ? 'message_id' : 'completion_id', otherKey = r.target.kind === 'message' ? 'completion_id' : 'message_id';
    if (found.state === 'pending') {
      if (r.phase === 'verified') return uncertain('delivery-host-state-regressed', 'reconcile-host-state');
      if (writable) r.host.request_state = 'pending';
      return uncertain('delivery-pending', 'wait-request', { pending: true });
    }
    if (found.state !== 'completed' || typeof found[idKey] !== 'string' || !found[idKey] || found[otherKey] !== null
      || (r.host[idKey] !== null && found[idKey] !== r.host[idKey]))
      return uncertain('delivery-identity-conflict', 'resolve-identity-conflict', { conflict: true });
    if (writable) {
      r.host.request_state = 'completed'; r.host[idKey] = found[idKey];
      if (r.phase !== 'verified') r.phase = 'observed_completed'; await s.saveRequest(r);
    }
    let response;
    try { response = await operate('fetch', s, r, () => client.fetchResponse(query), options, writable); }
    catch { return uncertain('delivery-response-unavailable', 'fetch-response'); }
    await s.hit('after-response-fetch');
    if (!Buffer.isBuffer(response?.body)) return uncertain('delivery-response-unavailable', 'fetch-response');
    try {
      requireValue(digest(response.body) === r.body.sha256, 'delivery-body-mismatch', true);
      requireValue(digest(strictQaGate(strictBody(response.body), r.verdict.gate)) === r.verdict.gate_result_sha256, 'delivery-gate-mismatch', true);
    } catch { return uncertain('delivery-body-mismatch', 'resolve-identity-conflict', { conflict: true }); }
    if (writable) {
      await s.hit('before-verified-write');
      if (r.phase !== 'verified' && mode === 'recover') r.transport.verified_recoveries++;
      r.phase = 'verified'; r.host.delivered_body_sha256 = digest(response.body); r.recovery = null;
      await s.saveRequest(r); await s.hit('after-verified-write');
    }
    return finish({ ok: true, state: 'verified', query_state: 'received', delivery_verified: true,
      recovery_action: null, host_message_id: found.message_id, host_completion_id: found.completion_id,
      delivery_receipt_digest: digest({ identity: r.identity, binding: r.binding, host: { namespace_digest: scope, message_id: found.message_id, completion_id: found.completion_id }, body_sha256: r.body.sha256 }) });
  });
}
export const inspectDelivery = (input, options = {}) => resolveRequest(input, options, 'inspect');
export const deliverPreparedRequest = (input, options = {}) => resolveRequest(input, options, 'send');
export const recoverDelivery = (input, options = {}) => resolveRequest(input, options, 'recover');
export function deliveryCommand(action, input, options = {}) {
  const actions = { 'delivery-reserve': reserveDeliverySlot, 'delivery-prepare': prepareDelivery, 'delivery-inspect': inspectDelivery,
    'delivery-send': deliverPreparedRequest, 'delivery-recover': recoverDelivery };
  requireValue(Object.hasOwn(actions, action), 'unknown-action'); return actions[action](input, options);
}
