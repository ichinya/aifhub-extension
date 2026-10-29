// Offline HostClient model: request index, commits, responses and tombstones are separate.
import { canonical, digest } from '../workflow-state-store.mjs';

export function createFakeHost({ state, mode = 'normal', capabilities = {}, failpoint } = {}) {
  state ??= { requests: new Map(), tombstones: new Map(), responses: new Map(), messages: [], completions: [], epoch: 'epoch-1',
    counters: { create_calls: 0, read_calls: 0, fetch_calls: 0 }, trace: [] };
  const host = { state, mode, capabilitiesOverride: capabilities,
    async capabilities() {
      return { idempotent_create: true, read_by_request_id: true, fetch_response: true,
        target_kinds: ['message', 'completion'], transport: { utf8_stdin: true, utf8_file: true },
        idempotency: { scope_digest: digest('fake-host-namespace'), continuity_token: state.epoch,
          retention_until: 'durable', conflicting_payload: 'reject' }, ...host.capabilitiesOverride };
    },
    async createRequest(input) {
      const uuid = input.request_uuid;
      state.trace.push(['create', uuid]); state.counters.create_calls++;
      if (host.mode === 'before-commit') throw new Error('timeout');
      const signature = canonical({ identity: input.identity, binding: input.binding, target: input.target, body_sha256: digest(input.body) });
      const old = state.tombstones.get(uuid);
      if (old) {
        if (old.signature !== signature) throw new Error('conflicting-payload');
        state.requests.set(uuid, structuredClone(old.request)); return structuredClone(old.request);
      }
      const caps = await host.capabilities(), kind = input.target.kind;
      const request = { state: host.mode === 'pending' ? 'pending' : 'completed', identity: structuredClone(input.identity),
        binding: structuredClone(input.binding), target: structuredClone(input.target), namespace_digest: caps.idempotency.scope_digest,
        continuity_token: state.epoch, message_id: kind === 'message' ? `message-${uuid}` : null,
        completion_id: kind === 'completion' ? `completion-${uuid}` : null };
      state.requests.set(uuid, request); state.tombstones.set(uuid, { signature, request: structuredClone(request) });
      state[kind === 'message' ? 'messages' : 'completions'].push({ request_uuid: uuid, body_sha256: digest(input.body) });
      state.responses.set(uuid, Buffer.from(input.body));
      await failpoint?.('after-host-commit');
      if (host.mode === 'lost-index') state.requests.delete(uuid);
      if (host.mode === 'lost-all') { state.requests.delete(uuid); state.tombstones.delete(uuid); state.epoch = 'epoch-2'; }
      if (['after-commit', 'lost-index', 'lost-all'].includes(host.mode)) throw new Error('response-lost');
      return structuredClone(request);
    },
    async readRequest({ request_uuid }) {
      state.trace.push(['read', request_uuid]); state.counters.read_calls++;
      const request = state.requests.get(request_uuid), caps = await host.capabilities();
      if (!request) return { state: 'not_found', namespace_digest: caps.idempotency.scope_digest,
        continuity_token: state.epoch, deduplication_retained: host.mode !== 'lost-all' || state.epoch === 'epoch-1' };
      const found = structuredClone(request);
      if (host.mode === 'conflicting-payload') found.identity.body_sha256 = digest('other-body');
      if (host.mode === 'wrong-target') found.target.kind = 'message';
      if (host.mode === 'wrong-namespace') found.namespace_digest = digest('other-namespace');
      if (host.mode === 'wrong-mapping') found.completion_id = 'other-completion';
      return found;
    },
    async fetchResponse({ request_uuid }) {
      state.trace.push(['fetch', request_uuid]); state.counters.fetch_calls++;
      if (host.mode === 'missing-body') return null;
      if (host.mode === 'temporary-body') { host.mode = 'normal'; return null; }
      const body = state.responses.get(request_uuid);
      if (!body) return null;
      return { body: host.mode === 'changed-body' ? Buffer.concat([body, Buffer.from('\nnormalized')]) : Buffer.from(body) };
    },
    complete(uuid) {
      const request = state.requests.get(uuid); request.state = 'completed';
      state.tombstones.get(uuid).request.state = 'completed';
    }
  };
  return host;
}
