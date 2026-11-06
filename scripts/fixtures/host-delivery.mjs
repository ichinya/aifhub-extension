// Offline HostClient model: request index, commits, responses and tombstones are separate.
import { canonical, digest } from '../workflow-state-store.mjs';

// Stage-2 usage reporting fixture (#270): `usage` activates a `usage_reporting`
// capability declaration and attaches well-formed usage objects to read/fetch
// responses. Modes: 'full' (every dimension), 'partial' (only tokens.input),
// 'null-dims' (all null members — declared but unsupported dimensions),
// 'conflict' (fetch usage contradicts read usage). `stopAfterResponses`
// models "the host stopped reporting" (erase-mode: later answers carry no
// usage). `model_requests` is its own declared number — never derived from the
// fixture's own create counter.
export function createFakeHost({ state, mode = 'normal', capabilities = {}, failpoint, usage } = {}) {
  state ??= { requests: new Map(), tombstones: new Map(), responses: new Map(), messages: [], completions: [], epoch: 'epoch-1',
    counters: { create_calls: 0, read_calls: 0, fetch_calls: 0 }, trace: [], usage_responses: 0 };
  const host = { state, mode, capabilitiesOverride: capabilities, usageSpec: usage ?? null,
    async capabilities() {
      const base = { idempotent_create: true, read_by_request_id: true, fetch_response: true,
        target_kinds: ['message', 'completion'], transport: { utf8_stdin: true, utf8_file: true },
        idempotency: { scope_digest: digest('fake-host-namespace'), continuity_token: state.epoch,
          retention_until: 'durable', conflicting_payload: 'reject' }, ...host.capabilitiesOverride };
      if (host.usageSpec) base.usage_reporting = { tokens: true, tool_calls: true, model_requests: true,
        scope: host.usageSpec.scope ?? 'request' };
      return base;
    },
    usageFor(answerKind) {
      if (!host.usageSpec) return undefined;
      if (host.usageSpec.stopAfterResponses !== undefined && state.usage_responses >= host.usageSpec.stopAfterResponses) return undefined;
      state.usage_responses += 1;
      const kind = host.usageSpec.kind ?? 'full';
      if (kind === 'null-dims') return { tokens: { input: null, output: null, total: null, cache_read: null, cache_write: null, reasoning: null },
        tool_calls: null, model_requests: null };
      const tokens = kind === 'partial'
        ? { input: 10, output: null, total: null, cache_read: null, cache_write: null, reasoning: null }
        : { input: 10, output: 5, total: 15, cache_read: 2, cache_write: 1, reasoning: 3 };
      if (kind === 'partial') return { tokens, tool_calls: null, model_requests: null };
      const toolCalls = host.usageSpec.tool_calls ?? 3;
      const modelRequests = answerKind === 'fetch' && kind === 'conflict' ? (host.usageSpec.model_requests ?? 2) + 7
        : (host.usageSpec.model_requests ?? 2);
      return { tokens, tool_calls: toolCalls, model_requests: modelRequests };
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
      // shared-completion models host-side payload dedup: different request UUIDs
      // carrying the same bytes resolve to one host id, which is the fixture the
      // runner-metrics collector uses for its response-deduplication matrix.
      const shared = host.mode === 'shared-completion';
      const hostId = (prefix) => shared ? `${prefix}-${input.identity.body_sha256}` : `${prefix}-${uuid}`;
      const request = { state: host.mode === 'pending' ? 'pending' : 'completed', identity: structuredClone(input.identity),
        binding: structuredClone(input.binding), target: structuredClone(input.target), namespace_digest: caps.idempotency.scope_digest,
        continuity_token: state.epoch, message_id: kind === 'message' ? hostId('message') : null,
        completion_id: kind === 'completion' ? hostId('completion') : null };
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
      const usage = host.usageFor('read');
      if (usage) found.usage = usage;
      return found;
    },
    async fetchResponse({ request_uuid }) {
      state.trace.push(['fetch', request_uuid]); state.counters.fetch_calls++;
      if (host.mode === 'missing-body') return null;
      if (host.mode === 'temporary-body') { host.mode = 'normal'; return null; }
      const body = state.responses.get(request_uuid);
      if (!body) return null;
      const answer = { body: host.mode === 'changed-body' ? Buffer.concat([body, Buffer.from('\nnormalized')]) : Buffer.from(body) };
      const usage = host.usageFor('fetch');
      if (usage) answer.usage = usage;
      return answer;
    },
    async releaseRequest({ request_uuid }) {
      state.trace.push(['release', request_uuid]); state.counters.release_calls = (state.counters.release_calls ?? 0) + 1;
      const request = state.requests.get(request_uuid);
      if (request?.state !== 'completed') return { state: 'unknown' };
      state.released ??= new Set(); state.released.add(request_uuid);
      return { state: 'released' };
    },
    complete(uuid) {
      const request = state.requests.get(uuid); request.state = 'completed';
      state.tombstones.get(uuid).request.state = 'completed';
    }
  };
  return host;
}
