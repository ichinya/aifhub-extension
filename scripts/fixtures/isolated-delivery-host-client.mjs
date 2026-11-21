import { fork } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DELIVERY_LIMITS } from '../host-delivery-store.mjs';
import { digest, WorkflowError } from '../workflow-state-store.mjs';

const hostModule = fileURLToPath(new URL('./isolated-delivery-host.mjs', import.meta.url));

async function stopChild(child, exited, timeoutMs) {
  const wait = async () => {
    let timer;
    try {
      return await Promise.race([exited, new Promise(resolve => { timer = setTimeout(resolve, timeoutMs, null); })]);
    } finally {
      clearTimeout(timer);
    }
  };
  if (child.connected) child.disconnect();
  const graceful = await wait();
  if (graceful !== null) return graceful;
  child.kill('SIGKILL');
  const killed = await wait();
  if (killed === null) throw new Error('host-exit-unconfirmed');
  return killed;
}

export async function startIsolatedDeliveryHost({ timeoutMs = 5000 } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) throw new Error('host-invalid-timeout');
  const temp = await realpath(os.tmpdir());
  const root = await mkdtemp(path.join(temp, 'aifhub-delivery-host-'));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|SYSTEMROOT|WINDIR|LOG_LEVEL)$/i.test(key)));
  const debug = env.LOG_LEVEL === 'debug';

  async function removeHostRoot() {
    if (path.dirname(await realpath(root)) !== temp) throw new Error('host-cleanup-root-mismatch');
    await rm(root, { recursive: true, maxRetries: 3, retryDelay: 100 });
  }

  let child;
  try {
    child = fork(hostModule, [root], {
      env, execArgv: [], serialization: 'advanced', stdio: ['ignore', 'ignore', debug ? 'inherit' : 'ignore', 'ipc'], windowsHide: true
    });
  } catch (spawnError) {
    if (debug) console.error('[FIX:host-spawn-cleanup]', JSON.stringify({ action: 'fork', error_code: spawnError.code ?? null }));
    try {
      await removeHostRoot();
    } catch (cleanupError) {
      if (debug) console.error('[FIX:host-spawn-cleanup]', JSON.stringify({ outcome: 'cleanup-failed', error_code: cleanupError.code ?? null }));
      const failure = new WorkflowError('host-spawn-cleanup-failed');
      failure.cause = new AggregateError([spawnError, cleanupError]);
      throw failure;
    }
    if (debug) console.error('[FIX:host-spawn-cleanup]', JSON.stringify({ outcome: 'host-root-removed' }));
    throw spawnError;
  }
  const pending = new Map();
  const calls = [];
  let nextCallId = 0;
  let closePromise;

  function finish(id, message, error) {
    const call = pending.get(id);
    if (!call) return;
    pending.delete(id);
    clearTimeout(call.timer);
    call.event.outcome = error ?? 'received';
    if (!error && message) {
      const namespace = message.namespace_digest ?? message.idempotency?.scope_digest;
      const continuity = message.continuity_token ?? message.idempotency?.continuity_token;
      if (namespace) call.event.namespace_digest = namespace;
      if (continuity) call.event.continuity_sha256 = digest(continuity);
      if (message.state) call.event.state = message.state;
      if (message.identity) call.event.identity_sha256 = digest(message.identity);
      if (message.binding) call.event.binding_sha256 = digest(message.binding);
      if (message.target) call.event.target_sha256 = digest(message.target);
      if (Buffer.isBuffer(message.body)) call.event.body_sha256 = digest(message.body);
    }
    if (debug) console.error(JSON.stringify(call.event));
    if (error) call.reject(new Error(error));
    else call.resolve(message);
  }

  const disconnect = () => {
    for (const id of pending.keys()) finish(id, null, 'host-ipc-disconnected');
  };
  child.on('message', message => finish(message.call_id, message.value, message.error));
  child.on('disconnect', disconnect);
  child.on('error', disconnect);
  const exited = new Promise(resolve => {
    child.once('exit', (code, signal) => {
      disconnect();
      resolve({ code, signal });
    });
    child.once('close', (code, signal) => {
      if (child.pid === undefined) resolve({ code, signal });
    });
  });

  function call(operation, params, requestUuid = params?.request_uuid) {
    if (!child.connected || closePromise) return Promise.reject(new Error('host-ipc-disconnected'));
    const callId = ++nextCallId;
    const event = { call_id: callId, operation, request_uuid: requestUuid ?? null, outcome: 'sent' };
    calls.push(event);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(callId, null, 'host-ipc-timeout'), timeoutMs);
      pending.set(callId, { resolve, reject, timer, event });
      try {
        child.send({ call_id: callId, operation, params }, error => {
          if (error) finish(callId, null, 'host-ipc-disconnected');
        });
      } catch {
        finish(callId, null, 'host-ipc-disconnected');
      }
    });
  }

  function close() {
    closePromise ??= (async () => {
      disconnect();
      // IPC is disconnected and stdio is ignored/inherited. The child's exit is
      // the evidence that it can no longer write its trace or temporary state.
      const exit = await stopChild(child, exited, timeoutMs);
      if (debug) console.error('[FIX:pilot-trace-cleanup-on-parse-error]', JSON.stringify({ action: 'read-trace', exit }));
      let trace = [];
      let traceError = null;
      try {
        const traceText = await readFile(path.join(root, 'trace.jsonl'), 'utf8').catch(error => {
          if (error.code !== 'ENOENT') throw error;
          return '';
        });
        const rows = traceText.split('\n').filter(Boolean).map(row => JSON.parse(row));
        if (rows.some(row => !Number.isSafeInteger(row?.call_id) || row.call_id < 1)) {
          throw new SyntaxError('invalid-host-trace-record');
        }
        trace = rows;
      } catch (error) {
        traceError = error instanceof SyntaxError ? 'host-trace-invalid' : 'host-trace-unavailable';
        if (debug) console.error('[FIX:pilot-trace-cleanup-on-parse-error]', JSON.stringify({ outcome: traceError }));
      }
      await removeHostRoot();
      if (debug) console.error('[FIX:pilot-trace-cleanup-on-parse-error]', JSON.stringify({ outcome: 'host-root-removed' }));
      return { trace, calls, exit, traceError };
    })();
    return closePromise;
  }

  return {
    root, close,
    client: {
      capabilities: () => call('capabilities'),
      async createRequest({ transport, serialized_input, request_uuid }) {
        if (transport !== 'stdin') throw new Error('host-unsupported-transport');
        if (!Buffer.isBuffer(serialized_input) || serialized_input.length > DELIVERY_LIMITS.stdin) throw new Error('host-input-too-large');
        return call('createRequest', serialized_input, request_uuid);
      },
      readRequest: query => call('readRequest', query),
      fetchResponse: query => call('fetchResponse', query)
    },
    complete: query => call('complete', query),
    holdNextReply: () => call('holdNextReply'),
    flushReply: () => call('flushReply'),
    lastCallId: () => nextCallId
  };
}
