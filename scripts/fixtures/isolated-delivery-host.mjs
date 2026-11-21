import { randomUUID } from 'node:crypto';
import { appendFile, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DELIVERY_LIMITS, requestUuid, strictBody } from '../host-delivery-store.mjs';
import { canonical, digest, requireValue, WorkflowError } from '../workflow-state-store.mjs';

if (!process.connected) throw new Error('isolated delivery host requires IPC');

const root = process.argv[2];
const requestPath = path.join(root, 'request.json');
const tracePath = path.join(root, 'trace.jsonl');
const capabilities = {
  idempotent_create: true, read_by_request_id: true, fetch_response: true,
  target_kinds: ['completion'], transport: { utf8_stdin: true, utf8_file: false },
  idempotency: {
    scope_digest: digest(randomUUID()), continuity_token: randomUUID(),
    retention_until: 'durable', conflicting_payload: 'reject'
  }
};
const { scope_digest: namespace, continuity_token: epoch } = capabilities.idempotency;
const continuityHash = digest(epoch);
let storedDigest = null;
let sequence = 0;
let hold = false;
let delayedReply = null;

async function loadRequest() {
  if (storedDigest === null) return null;
  const bytes = await readFile(requestPath).catch(() => null);
  requireValue(bytes !== null && digest(bytes) === storedDigest, 'host-continuity-unproven');
  return JSON.parse(bytes.toString('utf8'));
}

async function storeRequest(record) {
  const next = path.join(root, 'request.next.json');
  const bytes = Buffer.from(JSON.stringify(record));
  await writeFile(next, bytes, { flag: 'wx' });
  await rename(next, requestPath);
  storedDigest = digest(bytes);
}

function observation(record) {
  const { identity, binding, target, completion_id } = record;
  return {
    state: completion_id === null ? 'pending' : 'completed', identity, binding, target,
    namespace_digest: namespace, continuity_token: epoch, message_id: null, completion_id
  };
}

function recordProof(context, { identity, binding, target }) {
  context.identity_sha256 = digest(identity);
  context.binding_sha256 = digest(binding);
  context.target_sha256 = digest(target);
}

function reply(message) {
  if (process.connected) process.send(message, () => {});
}

async function execute(call, context) {
  const { operation, params } = call;
  if (operation === 'capabilities') return capabilities;
  if (operation === 'holdNextReply') {
    requireValue(!hold && !delayedReply, 'host-reply-already-held');
    hold = true;
    return true;
  }
  if (operation === 'flushReply') {
    requireValue(delayedReply !== null, 'host-no-held-reply');
    reply(delayedReply);
    delayedReply = null;
    return true;
  }

  if (operation === 'createRequest') {
    requireValue(Buffer.isBuffer(params) && params.length <= DELIVERY_LIMITS.stdin, 'host-input-too-large');
    const input = JSON.parse(strictBody(params));
    context.request_uuid = requestUuid(input.request_uuid);
    requireValue(typeof input.body === 'string' && input.target?.kind === 'completion' &&
      typeof input.binding?.run_id === 'string' && /^[\w.-]{1,80}$/.test(input.binding.run_id), 'host-invalid-create');
    const body = Buffer.from(input.body, 'utf8');
    const bodyHash = digest(body);
    requireValue(input.identity?.body_sha256 === bodyHash, 'host-body-mismatch');
    context.run_id = input.binding.run_id;
    context.body_sha256 = bodyHash;
    const signature = canonical({ identity: input.identity, binding: input.binding, target: input.target, body_sha256: bodyHash });
    const saved = await loadRequest();
    if (saved !== null) {
      if (saved.request_uuid !== context.request_uuid || saved.signature !== signature) return { state: 'conflict' };
      recordProof(context, saved);
      context.outcome = 'replayed';
      return observation(saved);
    }
    const record = {
      request_uuid: context.request_uuid, identity: input.identity, binding: input.binding, target: input.target,
      signature, body: body.toString('base64'), completion_id: null
    };
    await storeRequest(record);
    recordProof(context, record);
    context.outcome = 'stored';
    return observation(record);
  }

  requireValue(['readRequest', 'fetchResponse', 'complete'].includes(operation), 'host-invalid-operation');
  context.request_uuid = requestUuid(params?.request_uuid);
  requireValue(params.namespace_digest === namespace, 'host-namespace-mismatch');
  const saved = await loadRequest();
  if (saved?.request_uuid !== context.request_uuid) {
    if (operation === 'readRequest') {
      return { state: 'not_found', namespace_digest: namespace, continuity_token: epoch, deduplication_retained: true };
    }
    requireValue(operation === 'fetchResponse', 'host-request-missing');
    return null;
  }
  context.run_id = saved.binding.run_id;
  context.body_sha256 = saved.identity.body_sha256;
  recordProof(context, saved);
  if (operation === 'readRequest') return observation(saved);
  if (operation === 'fetchResponse') return saved.completion_id === null ? null : { body: Buffer.from(saved.body, 'base64') };
  if (saved.completion_id === null) {
    saved.completion_id = randomUUID();
    await storeRequest(saved);
  }
  return observation(saved);
}

async function handleCall(call) {
  const { call_id, operation } = call;
  const context = { namespace_digest: namespace, continuity_sha256: continuityHash };
  let response;
  try {
    const value = await execute(call, context);
    response = { call_id, value };
    if (value?.state) context.state = value.state;
    context.outcome ??= value?.state ?? (value === null ? 'unavailable' : 'ok');
  } catch (error) {
    response = { call_id, error: error instanceof WorkflowError ? error.code : 'host-operation-failed' };
    context.outcome = response.error;
  }
  const event = { sequence: ++sequence, call_id, operation, ...context };
  await appendFile(tracePath, JSON.stringify(event) + '\n', 'utf8');
  if (process.env.LOG_LEVEL === 'debug') console.error(JSON.stringify(event));
  if (hold && operation !== 'holdNextReply') {
    hold = false;
    delayedReply = response;
  } else {
    reply(response);
  }
}

let queue = Promise.resolve();
process.on('message', call => {
  queue = queue.then(() => handleCall(call)).catch(() => {
    process.exitCode = 1;
    if (process.connected) process.disconnect();
  });
});
