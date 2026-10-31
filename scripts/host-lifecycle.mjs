// One bounded mechanical step per command. No semantic verdicts or owner receipts.
import { canonical, digest, fields, identifier, requireValue, boundedText, WorkflowError } from './workflow-state-store.mjs';
import { history, pendingTransactions, reserves, folderFor } from './execution-transactions.mjs';
import { executionId, parseExecutionTasks, resolveExecutionSource } from './execution-task-source.mjs';
import { deliveryPaths, projection, requestUuid, RECOVERY_ACTION_TYPES, validateFrozenBody, bindingFor, bounded, validCapabilities, DELIVERY_LIMITS } from './host-delivery-store.mjs';
import { lifecycleStore, lifecycleLock, lifecyclePaths, validateSettlement, SETTLEMENT_SCHEMA, RELEASE_SCHEMA, LIFECYCLE_LIMITS } from './host-lifecycle-store.mjs';
import { parseProjectConfig, parseSimpleYaml } from './aif-artifact-sync.mjs';

export const NEXT_ACTION_TYPES = Object.freeze(['lifecycle-collect', 'batch-accept', 'batch-close', 'delivery-recover',
  'lifecycle-settle', 'lifecycle-release', 'lifecycle-progress', 'lifecycle-finalize', 'interrupt', 'stop-confirm', 'manual']);
const same = (a, b) => canonical(a) === canonical(b);
const manual = Object.freeze({ wait: 'delivery-inspect per member / host UI', release: 'host-native release/stop controls' });
export function validateNextAction(a) {
  if (a === null) return a;
  fields(a, ['type', 'reason'], ['run_id', 'task_id', 'request_uuid', 'recovery_type']);
  requireValue(NEXT_ACTION_TYPES.includes(a.type), 'invalid-next-action', true); boundedText(a.reason);
  for (const key of ['run_id', 'task_id']) if (a[key] !== undefined) identifier(a[key]);
  if (a.request_uuid !== undefined) requestUuid(a.request_uuid);
  if (a.recovery_type !== undefined) requireValue(RECOVERY_ACTION_TYPES.includes(a.recovery_type), 'invalid-next-action', true);
  return a;
}
const next = (type, reason, extra = {}) => validateNextAction({ type, reason, ...extra });
const acceptedSet = run => run.kind === 'batch' ? [...(run.closure?.accepted ?? [])] : run.status === 'accepted' ? [run.task_id] : [];
const results = run => run.kind === 'batch' ? Object.entries(run.items).filter(([, i]) => i.result).map(([task_id, i]) => ({ task_id, result: i.result }))
  : run.result ? [{ task_id: run.task_id, result: run.result }] : [];
function owner(run, input) { requireValue(input.actor === run.owner, 'actor-mismatch', true); }
function findRun(h, id) {
  identifier(id); const run = h.runs.find(r => r.run_id === id);
  requireValue(run && run.schema === 'aifhub.execution.v2' && !run.legacy, 'missing-or-invalid-run', true); return run;
}
async function scans(s, change, counters) {
  counters.transaction_scans++; const pending = await pendingTransactions(s);
  counters.history_scans++; const h = await history(s, change); return { pending, h };
}
async function closedFresh(s, run) {
  requireValue(run.lifecycle === 'closed' && (run.kind === 'batch' ? !!run.closure : run.status === 'accepted'), 'lifecycle-closed-run-required', true);
  return s.freshness(s, run);
}
function requestBinding(r, run) {
  requireValue(r.slot.change_id === run.change_id && r.slot.run_id === run.run_id, 'delivery-identity-conflict', true);
  const task_id = r.slot.task_id, result = run.kind === 'batch' ? run.items[task_id]?.result : task_id === run.task_id ? run.result : null;
  requireValue(result && r.binding, 'delivery-result-required', true);
  const expected = bindingFor({ run, result, task_id }, r.target); expected.run_version_at_prepare = r.binding.run_version_at_prepare;
  requireValue(same(expected, r.binding) && same(result.evidence_digests, r.frozen_evidence), 'delivery-identity-conflict', true);
}
function observation(r, caps, found) {
  const scope = caps.idempotency.scope_digest, continuity = caps.idempotency.continuity_token;
  // An absent or shape-invalid observation is a transport failure, not an identity
  // conflict: recovery retries the read instead of asking the owner to resolve identities.
  const shaped = v => !!v && typeof v === 'object' && !Array.isArray(v);
  requireValue(found && typeof found === 'object' && !Array.isArray(found) && typeof found.state === 'string'
    && shaped(found.identity) && shaped(found.binding) && shaped(found.target)
    && typeof found.namespace_digest === 'string' && typeof found.continuity_token === 'string', 'delivery-observation-unavailable', true);
  requireValue(r.host.namespace_digest === scope && r.host.continuity_token === continuity, 'delivery-identity-conflict', true);
  requireValue(same(found.identity, r.identity) && same(found.binding, r.binding) && same(found.target, r.target)
    && found.namespace_digest === scope && found.continuity_token === continuity, 'delivery-identity-conflict', true);
  requireValue(['pending', 'completed'].includes(found.state), 'delivery-host-state-unproven', true);
  const key = r.target.kind === 'message' ? 'message_id' : 'completion_id', other = key === 'message_id' ? 'completion_id' : 'message_id';
  if (found.state === 'completed') requireValue(typeof found[key] === 'string' && found[key].length > 0 && found[other] === null
    && (r.host[key] === null || r.host[key] === found[key]), 'delivery-identity-conflict', true);
  requireValue(!(r.phase === 'verified' && found.state !== 'completed'), 'delivery-host-state-regressed', true);
  return found.state;
}
function receiptDigest(r) {
  return digest({ identity: r.identity, binding: r.binding, host: { namespace_digest: r.host.namespace_digest,
    message_id: r.host.message_id, completion_id: r.host.completion_id }, body_sha256: r.body.sha256 });
}
async function hostCall(fn, options, code) {
  try { return await bounded(fn, options); }
  catch (error) { if (error instanceof WorkflowError) throw error; throw new WorkflowError(code, true); }
}
async function collect(input, s, options, counters) {
  fields(input, ['change_id'], ['members', 'include_all', 'read_host']);
  requireValue(input.read_host === undefined || typeof input.read_host === 'boolean');
  requireValue((Array.isArray(input.members) && input.include_all === undefined) || (input.members === undefined && input.include_all === true));
  const { pending, h } = await scans(s, input.change_id, counters);
  let selected = input.members, corruptRegistry = false;
  if (input.include_all) {
    const inventory = await s.inventory(`${folderFor(input.change_id)}/requests`);
    const requests = [];
    for (const p of Object.keys(inventory)) {
      const name = p.split('/').at(-1).replace(/\.json$/, '');
      try { requestUuid(name); } catch { corruptRegistry = true; continue; } // per-member degradation
      requests.push({ request_uuid: name });
    }
    selected = [...h.runs.map(r => ({ run_id: r.run_id })), ...requests];
  }
  requireValue(selected.length > 0 && selected.length <= LIFECYCLE_LIMITS.members, 'lifecycle-group-limit');
  const seen = new Set();
  for (const member of selected) {
    fields(member, [], ['run_id', 'request_uuid']); requireValue(Object.keys(member).length === 1);
    const key = member.run_id ? `run:${identifier(member.run_id)}` : `request:${requestUuid(member.request_uuid)}`;
    requireValue(!seen.has(key), 'duplicate-lifecycle-member'); seen.add(key);
  }
  const members = []; let suggestion = null, waiting = false, uncertain = corruptRegistry, partial = false;
  const limits = [], client = options.HostClient;
  let caps;
  for (const member of selected) {
    if (member.run_id) {
      const run = findRun(h, member.run_id);
      const state = { kind: 'run', id: run.run_id, lifecycle: run.lifecycle, status: run.status, execution_state: run.execution_state,
        version: run.version, reservation_retained: reserves(run), historical: true, accepted: acceptedSet(run) };
      members.push(state);
      if (run.lifecycle === 'interrupted') {
        // The blocked/uncertain override below always rewrites this to manual; kept typed
        // so future callers can read the specific owner action.
        uncertain = true; suggestion ??= next('stop-confirm', 'Interrupted run requires owner recovery.', { run_id: run.run_id });
      } else if (run.lifecycle === 'closed') {
        await closedFresh(s, run);
        partial ||= run.kind === 'batch' && run.closure.unfinished.length > 0;
        suggestion ??= next('lifecycle-settle', 'Closed run requires an explicit parent decision.', { run_id: run.run_id });
      } else if (run.kind === 'batch' && run.seal) {
        const unaccepted = Object.entries(run.items).find(([, i]) => i.result?.status === 'completed' && !i.accepted);
        const missing = Object.values(run.items).some(i => !i.result);
        waiting ||= missing;
        suggestion ??= unaccepted ? next('batch-accept', 'Parent acceptance is required.', { run_id: run.run_id, task_id: unaccepted[0] })
          : next(missing ? 'lifecycle-collect' : 'batch-close', missing ? 'Await producer result.' : 'Parent can close the batch.', { run_id: run.run_id });
      } else if (run.kind === 'single' && run.result) {
        waiting = true; suggestion ??= next('manual', 'Parent must decide acceptance through the existing execution owner.', { run_id: run.run_id });
      } else { waiting = true; suggestion ??= next('lifecycle-collect', 'Await execution transition.', { run_id: run.run_id }); }
      continue;
    }
    const r = await s.loadRequest(input.change_id, member.request_uuid), run = findRun(h, r.slot.run_id);
    const state = { kind: 'delivery', id: r.request_uuid, task_id: r.slot.task_id, phase: r.phase, query_state: projection(r).query_state,
      host_state: r.host.request_state, reservation_retained: reserves(run), historical: true, recovery_action: r.recovery };
    members.push(state);
    if (r.phase === 'verified') { suggestion ??= next('lifecycle-release', 'Verified response may be released after fresh host verification.', { request_uuid: r.request_uuid }); continue; }
    waiting = true;
    if (!input.read_host) continue;
    if (!client || typeof client.capabilities !== 'function' || typeof client.readRequest !== 'function') { limits.push('host-read'); continue; }
    try {
      caps ??= await bounded(() => client.capabilities(), options);
      requireValue(validCapabilities(caps, r, s), 'lifecycle-capabilities-required', true);
      requireValue(r.phase !== 'reserved', 'delivery-not-prepared', true); requestBinding(r, run); await validateFrozenBody(s, r);
      counters.host_reads++;
      const found = await bounded(() => client.readRequest({ request_uuid: r.request_uuid, namespace_digest: caps.idempotency.scope_digest }), options);
      if (found?.state === 'not_found') {
        state.host_state = 'not_found'; uncertain = true;
        state.recovery_action = { type: 'reconcile-host-state', request_uuid: r.request_uuid };
      } else {
        state.host_state = observation(r, caps, found);
        state.recovery_action = { type: found.state === 'pending' ? 'wait-request' : 'fetch-response', request_uuid: r.request_uuid };
      }
    } catch (error) {
      uncertain = true; state.code = error instanceof WorkflowError ? error.code : 'delivery-observation-unavailable';
      state.recovery_action = { type: state.code === 'delivery-identity-conflict' ? 'resolve-identity-conflict' : 'read-request', request_uuid: r.request_uuid };
      if (state.code === 'lifecycle-capabilities-required') limits.push('host-read');
    }
  }
  // A delivery parked in a local blocked phase is a blocker, not a wait: the driver must
  // stop instead of burning its budget polling a permanent identity problem.
  const blocked = pending.length > 0 || limits.length > 0 || members.some(m => m.kind === 'delivery' && m.phase === 'blocked');
  const delivery = members.find(m => m.kind === 'delivery' && m.phase !== 'verified');
  if (delivery) suggestion = next(delivery.recovery_action?.type === 'wait-request' || !input.read_host ? 'lifecycle-collect' : 'delivery-recover',
    'Delivery requires a separate bounded recovery step.', { request_uuid: delivery.id, ...(delivery.recovery_action ? { recovery_type: delivery.recovery_action.type } : {}) });
  if (blocked || uncertain) suggestion = next('manual', 'Resolve capability, custody or transaction blocker.');
  // Refusal aggregates carry the CLI blocked flag exactly like the catch path, so the
  // published 0/1/2 exit contract holds for every collect refusal, not only throws.
  return { ok: !blocked && !uncertain, blocked: blocked || uncertain, change_id: input.change_id, members,
    state: blocked ? 'blocked' : uncertain ? 'uncertain' : partial ? 'partial' : waiting ? 'waiting' : 'ready',
    ...(limits.length ? { code: 'lifecycle-capabilities-required' } : {}), pending_transactions: pending.map(p => p.tx.id), next_action: suggestion,
    capability_limitations: [...new Set(limits)], reservation_retained: members.some(m => m.reservation_retained) };
}

async function settle(input, s, options, counters) {
  fields(input, ['change_id', 'run_id', 'actor', 'decision'], ['deliveries']);
  fields(input.decision, ['actor', 'outcome', 'decided_at']);
  const { pending, h } = await scans(s, input.change_id, counters), run = findRun(h, input.run_id); owner(run, input);
  requireValue(input.decision.actor === input.actor, 'actor-mismatch', true);
  const old = await s.loadJournal(input.change_id, 'settlement', input.run_id, input);
  if (old) return s.applyJournal(old, 'settlement', true);
  requireValue(!pending.length, 'pending-transaction', true); await closedFresh(s, run);
  const deliveries = Object.create(null), requested = input.deliveries ?? {};
  requireValue(requested && typeof requested === 'object' && !Array.isArray(requested) && Object.keys(requested).length <= 5);
  for (const [task, uuid] of Object.entries(requested)) {
    identifier(task); const r = await s.loadRequest(input.change_id, requestUuid(uuid));
    requireValue(r.slot.task_id === task && r.phase === 'verified', 'lifecycle-verified-delivery-required', true);
    requestBinding(r, run); await validateFrozenBody(s, r);
    deliveries[task] = { request_uuid: uuid, delivery_receipt_digest: receiptDigest(r) };
  }
  const timestamp = s.now(), record = validateSettlement({ schema: SETTLEMENT_SCHEMA, settlement_id: run.run_id, change_id: run.change_id,
    run_id: run.run_id, kind: run.kind, binding: { manifest_digest: digest(run.manifest ?? { task_id: run.task_id, scope: run.scope }),
      seal_digest: run.seal?.digest ?? null, closure_digest: run.closure ? digest(run.closure) : null, context_digest: run.context.digest,
      worktree_digest: digest(run.checkpoint.worktree), source_digest: run.source.namespace_digest, accepted: acceptedSet(run),
      results: results(run).map(({ task_id, result }) => ({ task_id, result_digest: result.digest, evidence_digest: digest(result.evidence_digests) })) },
    deliveries, decision: structuredClone(input.decision), input_digest: digest(input), revision: 1, created_at: timestamp, updated_at: timestamp });
  const path = lifecyclePaths(input.change_id, 'settlement', input.run_id).record;
  requireValue(await s.bytes(path) === null, 'conflicting-settlement', true);
  return s.publishLifecycle(input.change_id, 'settlement', input.run_id, input,
    [[path, JSON.stringify({ checksum: digest(record), record }, null, 2) + '\n']],
    { ok: true, state: 'settled', settlement: record, next_action: next('lifecycle-progress', 'Apply the exact accepted set.', { run_id: run.run_id }), authorizes: [] });
}

// Locations come from the canonical parser, so examples/fences/frontmatter never gain authority.
function checkedText(text, accepted) {
  const locations = parseExecutionTasks(text, { locations: true }), lines = text.split(/\r\n|\n|\r/), endings = text.match(/\r\n|\n|\r/g) ?? [];
  for (const task of locations.filter(t => accepted.includes(t.id) && !t.checked)) {
    const line = lines[task.line], at = task.checkbox;
    requireValue(line.slice(at - 1, at + 2) === '[ ]', 'unsupported-checklist-line', true);
    lines[task.line] = line.slice(0, at) + 'x' + line.slice(at + 1);
  }
  const after = lines.map((line, i) => line + (endings[i] ?? '')).join('');
  const expected = parseExecutionTasks(text).map(t => ({ ...t, checked: t.checked || accepted.includes(t.id) }));
  requireValue(same(parseExecutionTasks(after), expected), 'lifecycle-checklist-conflict', true); return after;
}
async function progress(input, s, options, counters) {
  fields(input, ['change_id', 'run_id', 'actor']);
  const { pending, h } = await scans(s, input.change_id, counters), run = findRun(h, input.run_id); owner(run, input);
  const old = await s.loadJournal(input.change_id, 'progress', input.run_id, input);
  if (old) {
    // Admission cannot see lifecycle journals, so a prepared progress journal may race
    // a newer run on an unchecked task; recheck quiescence before finishing the write (#268).
    if (old.state === 'prepared') requireValue(!pending.length && !h.runs.some(reserves), 'lifecycle-not-quiescent', true);
    return s.applyJournal(old, 'progress', true);
  }
  // The fresh path races the same admission window as the prepared replay above: a
  // sibling run on an unchecked task must not be invalidated by the checklist write.
  requireValue(!pending.length && !h.runs.some(reserves), 'lifecycle-not-quiescent', true); await closedFresh(s, run);
  const source = await resolveExecutionSource(s, input.change_id, run.role, run.context_paths), accepted = acceptedSet(run);
  const paths = source.namespace.kind === 'ai-factory-classic' ? [source.namespace.entrypoint, source.namespace.checklist] : [source.namespace.checklist];
  const writes = [];
  for (const path of paths) {
    const text = await s.textFile(path); requireValue(text !== null, 'missing-tasks', true);
    writes.push([path, checkedText(text, accepted)]);
  }
  if (writes.length === 2) requireValue(same(parseExecutionTasks(writes[0][1]), parseExecutionTasks(writes[1][1])), 'classic-checklist-mismatch', true);
  return s.publishLifecycle(input.change_id, 'progress', input.run_id, input, writes,
    { ok: true, state: 'progress-applied', accepted, next_action: next('lifecycle-finalize', 'Finalization remains owned by /aif-done.'), authorizes: [] });
}

async function release(input, s, options, counters) {
  fields(input, ['change_id', 'run_id', 'actor', 'request_uuid']);
  const { pending, h } = await scans(s, input.change_id, counters), run = findRun(h, input.run_id); owner(run, input);
  const r = await s.loadRequest(input.change_id, requestUuid(input.request_uuid));
  requireValue(r.phase === 'verified', 'lifecycle-verified-delivery-required', true); requestBinding(r, run);
  if (r.release) {
    // loadRequest may have recovered a newer delivery journal than the registry.
    await s.save(deliveryPaths(input.change_id, r.request_uuid).request, r); await s.project(r);
    return { ok: true, state: 'released', release: r.release, replay: true, historical: true, reservation_retained: reserves(run) };
  }
  requireValue(!pending.length, 'pending-transaction', true); await validateFrozenBody(s, r);
  // saveRequest records the release phase write; a registry already at the history limit
  // would release on the host and then never be able to record it.
  requireValue(r.history.length < DELIVERY_LIMITS.history, 'delivery-history-full', true);
  const client = options.HostClient;
  requireValue(client && ['capabilities', 'readRequest', 'releaseRequest'].every(k => typeof client[k] === 'function'), 'lifecycle-capabilities-required', true);
  const caps = await hostCall(() => client.capabilities(), options, 'lifecycle-capabilities-required');
  requireValue(validCapabilities(caps, r, s) && caps.release_after_verify === true, 'lifecycle-capabilities-required', true);
  const path = lifecyclePaths(input.change_id, 'release', r.request_uuid).journal;
  let journal = await s.load(path);
  if (journal) {
    // A checksum-valid but malformed record is a custody conflict, not invalid-input.
    const shape = journal && typeof journal === 'object' && !Array.isArray(journal)
      && ['schema', 'input_digest', 'request_uuid', 'binding_digest', 'state', 'release'].every(k => Object.hasOwn(journal, k))
      && Object.keys(journal).length === 6;
    requireValue(shape && journal.schema === RELEASE_SCHEMA && journal.input_digest === digest(input) && journal.request_uuid === r.request_uuid
      && journal.binding_digest === digest(r.binding) && ['intent', 'released'].includes(journal.state)
      && (journal.state === 'intent' ? journal.release === null
        : !!journal.release && typeof journal.release === 'object' && !Array.isArray(journal.release)
          && Object.keys(journal.release).length === 2
          && ['released_at', 'host_release_state'].every(k => Object.hasOwn(journal.release, k))
          && Number.isFinite(Date.parse(journal.release.released_at)) && journal.release.host_release_state === 'released'), 'conflicting-lifecycle-replay', true);
  }
  if (journal?.state !== 'released') {
    const query = { request_uuid: r.request_uuid, namespace_digest: caps.idempotency.scope_digest };
    counters.host_reads++; const found = await hostCall(() => client.readRequest(query), options, 'delivery-observation-unavailable');
    requireValue(observation(r, caps, found) === 'completed', 'delivery-host-state-regressed', true);
    journal ??= { schema: RELEASE_SCHEMA, input_digest: digest(input), request_uuid: r.request_uuid, binding_digest: digest(r.binding), state: 'intent', release: null };
    await s.hit('lifecycle-before-release-intent'); await s.save(path, journal); await s.hit('lifecycle-after-release-intent');
    counters.host_releases++; const response = await hostCall(() => client.releaseRequest(query), options, 'lifecycle-release-unproven');
    await s.hit('lifecycle-after-host-release');
    requireValue(response?.state === 'released', 'lifecycle-release-unproven', true);
    journal.state = 'released'; journal.release = { released_at: s.now(), host_release_state: response.state };
    await s.save(path, journal); await s.hit('lifecycle-after-release-result');
  }
  r.release = journal.release; await s.saveRequest(r); await s.hit('lifecycle-after-release-write');
  return { ok: true, state: 'released', release: r.release, reservation_retained: reserves(run) };
}

async function finalize(input, s, options, counters) {
  fields(input, ['change_id', 'actor', 'spec']); identifier(input.actor); boundedText(input.spec, 256 * 1024);
  const id = 'finalize', old = await s.loadJournal(input.change_id, 'finalization', id, input);
  if (old) {
    const { pending, h } = await scans(s, input.change_id, counters);
    requireValue(!pending.length && !h.runs.some(reserves), 'lifecycle-not-quiescent', true);
    requireValue(h.runs.every(r => r.owner === input.actor), 'actor-mismatch', true);
    return s.applyJournal(old, 'finalization', true);
  }
  const config = parseProjectConfig(await s.textFile('.ai-factory/config.yaml') ?? ''), specs = config.paths.specs ?? '.ai-factory/specs';
  // Non-scalar configured paths must fail with a typed code, not a raw TypeError.
  requireValue(['specs', 'qa', 'rules', 'generated_rules', 'description', 'architecture', 'rules_file']
    .every(key => config.paths[key] === undefined || typeof config.paths[key] === 'string'), 'tool-configuration-error');
  // Destinations may not alias canonical/evidence roots — configured overrides plus the
  // shipped defaults. Checked before source resolution so the refusal is one typed code
  // (duplicate path values are rejected separately by the shared admission source).
  // The openspec root is deliberately absent: the classic finalizer never reads it as a
  // source, so an archive there cannot overwrite execution inputs. Comparisons are
  // case-insensitive even on case-sensitive filesystems: deterministic ubuntu CI
  // behavior, conservative where 'Plans' and 'plans' name the same directory.
  const roots = new Set(['.ai-factory/qa', '.ai-factory/rules', '.ai-factory/rules/generated', '.ai-factory/evidence']);
  // description/architecture/rules_file are authoritative inputs for every execution
  // source: an archive destination around them would let the finalizer overwrite them.
  for (const key of ['qa', 'rules', 'generated_rules', 'description', 'architecture', 'rules_file']) if (config.paths[key]) roots.add(config.paths[key]);
  const aliased = p => [...roots].some(root => { const r = root.toLowerCase(); return p === r || p.startsWith(r + '/') || r.startsWith(p + '/'); });
  requireValue(!aliased(specs.toLowerCase()) && !/^\.git(?:\/|$)/i.test(specs) && !/^\.ai-factory\/state(?:\/|$)/i.test(specs), 'unsafe-path', true);
  const source = await resolveExecutionSource(s, input.change_id, 'implement');
  if (source.delegated) return { ok: true, state: 'delegated', ...source };
  if (source.namespace.kind !== 'ai-factory-classic') return { ok: true, state: 'delegated', delegated: true,
    handoff: `ai-factory aifhub-done-finalizer --change ${input.change_id} --json` };
  const { pending, h } = await scans(s, input.change_id, counters);
  requireValue(!pending.length && !h.runs.some(reserves), 'lifecycle-not-quiescent', true);
  requireValue(h.runs.every(r => r.owner === input.actor), 'actor-mismatch', true);
  requireValue(source.tasks.length > 0 && source.tasks.every(t => t.checked), 'lifecycle-progress-required', true);
  const base = source.namespace.checklist.slice(0, -'/task.md'.length), statusPath = `${base}/status.yaml`, status = await s.textFile(statusPath);
  const parsed = parseSimpleYaml(status);
  requireValue(['pass', 'pass-with-notes'].includes(parsed.verification?.verdict), 'lifecycle-verification-required', true);
  // The checklist folder and the archive destination must stay disjoint directories.
  const plan = base.toLowerCase(), target = specs.toLowerCase();
  requireValue(target !== plan && !plan.startsWith(target + '/') && !target.startsWith(plan + '/'), 'unsafe-path', true);
  const archive = `${specs}/${input.change_id}`, writes = [], inventory = await s.inventory(base), guards = [];
  // Bound the buffer-accumulation peak before publish builds the base64 images.
  requireValue(Object.keys(inventory).length + 3 <= LIFECYCLE_LIMITS.files, 'invalid-lifecycle-journal', true);
  let planned = 0;
  const budget = bytes => { planned += bytes.length; requireValue(planned <= LIFECYCLE_LIMITS.bytes, 'invalid-lifecycle-journal', true); return bytes; };
  for (const path of Object.keys(inventory)) if (path !== statusPath) writes.push([`${archive}/${path.slice(base.length + 1)}`, budget(await s.bytes(path))]);
  // Companion copies own these two archive names; same-named plan-folder files would be
  // silently replaced and lose their content, so refuse before any write.
  requireValue(!Object.hasOwn(inventory, `${base}/plan.md`) && !Object.hasOwn(inventory, `${base}/spec.md`), 'conflicting-archive-entry', true);
  for (const path of [...Object.keys(inventory).filter(p => p !== statusPath), source.namespace.entrypoint, '.ai-factory/config.yaml']) {
    const bytes = await s.bytes(path); if (bytes !== null) guards.push({ path, sha256: digest(bytes) });
  }
  const add = (path, data) => { const i = writes.findIndex(w => w[0] === path); if (i >= 0) writes[i] = [path, data]; else writes.push([path, data]); };
  add(`${archive}/plan.md`, budget(await s.bytes(source.namespace.entrypoint))); add(`${archive}/spec.md`, budget(Buffer.from(input.spec)));
  const indexPath = `${specs}/index.yaml`, index = await s.textFile(indexPath);
  const entry = `  - id: ${JSON.stringify(input.change_id)}\n    title: ${JSON.stringify(input.change_id)}\n    archived_at: ${JSON.stringify(s.now())}\n    verification: ${parsed.verification.verdict}\n    source_branch: null\n`;
  // Preserve arbitrary index bytes; replace only our exact keyed entry on replay/refresh.
  let indexAfter = index ?? 'specs:\n';
  requireValue(/^specs:\s*(?:\[\])?\s*$/m.test(indexAfter), 'unsupported-spec-index', true);
  indexAfter = indexAfter.replace(/^specs:\s*\[\]\s*$/m, 'specs:');
  // Structural validation before any manipulation: quoted or otherwise unrecognized
  // top-level keys would hide foreign lists from the section boundaries, and entries
  // not starting with `- id:` would be silently duplicated. Sections other than specs
  // own their indentation; inside specs only flat `- id:` entries are representable.
  const doc = indexAfter.split('\n'), specsAt = doc.findIndex(line => /^specs:/.test(line));
  requireValue(specsAt >= 0, 'unsupported-spec-index', true);
  let specsEnd = specsAt + 1;
  while (specsEnd < doc.length && !/^[A-Za-z_][\w-]*:/.test(doc[specsEnd])) specsEnd++;
  for (let i = 0; i < doc.length; i++) {
    // Grammar checks run on the line without its single CRLF tail; the original bytes
    // stay untouched for publication, so line endings never change the verdict.
    const line = doc[i].replace(/\r$/, '');
    if (!line.trim() || /^\s*#/.test(line)) continue;
    if (/^\S/.test(line)) { requireValue(/^[A-Za-z_][\w-]*:(?:\s.*)?$/.test(line), 'unsupported-spec-index', true); continue; }
    if (i <= specsAt || i >= specsEnd) continue;
    requireValue(/^  - id:/.test(line) || /^    \S/.test(line), 'unsupported-spec-index', true);
  }
  const lines = indexAfter.split('\n'), sectionStart = lines.findIndex(line => /^specs:/.test(line));
  requireValue(sectionStart >= 0, 'unsupported-spec-index', true);
  let sectionEnd = sectionStart + 1;
  while (sectionEnd < lines.length && !/^[A-Za-z_][\w-]*:/.test(lines[sectionEnd])) sectionEnd++;
  // Search and removal stay inside the specs list: same-id entries in foreign lists or
  // comments never match. Entry shapes the flat replacement cannot represent — blank or
  // deeper-indented continuation lines, flow/nested verification values — refuse here,
  // before any write, instead of corrupting valid YAML.
  const flat = v => v === undefined || (typeof v === 'string' && !/^[{[]/.test(v.trim()));
  const matches = [];
  for (let i = sectionStart + 1; i < sectionEnd; i++) {
    if (!/^  - id:/.test(lines[i])) continue;
    const row = parseSimpleYaml(lines[i].trim().slice(2));
    if (row.id !== input.change_id) continue;
    requireValue(flat(row.verification), 'unsupported-spec-index', true);
    matches.push(i);
  }
  requireValue(matches.length <= 1, 'unsupported-spec-index', true); const start = matches[0] ?? -1;
  if (start >= 0) {
    let end = start + 1;
    while (end < sectionEnd && /^    \S/.test(lines[end])) end++;
    let probe = end;
    while (probe < sectionEnd && !lines[probe].trim()) probe++;
    requireValue(probe === sectionEnd || /^  - id:/.test(lines[probe]), 'unsupported-spec-index', true);
    lines.splice(start, end - start); indexAfter = lines.join('\n');
  }
  // Insert inside specs, before any following top-level block such as stats.
  const indexLines = indexAfter.split('\n'), specsLine = indexLines.findIndex(line => /^specs:/.test(line));
  let boundary = specsLine + 1;
  while (boundary < indexLines.length && !/^[A-Za-z_][\w-]*:/.test(indexLines[boundary])) boundary++;
  indexLines.splice(boundary, 0, entry.trimEnd());
  const combined = indexLines.join('\n'), listStart = indexLines.findIndex(line => /^specs:/.test(line));
  let listEnd = listStart + 1;
  while (listEnd < indexLines.length && !/^[A-Za-z_][\w-]*:/.test(indexLines[listEnd])) listEnd++;
  const rows = indexLines.slice(listStart + 1, listEnd).join('\n').split(/(?=^  - id:)/m)
    .filter(row => /^  - id:/.test(row)).map(row => parseSimpleYaml(row.replace(/^  - /, '')));
  requireValue(rows.every(row => flat(row.verification)), 'unsupported-spec-index', true);
  let inStats = false, inVerdicts = false;
  const withStats = combined.split('\n').map(line => {
    if (/^\S/.test(line) && !line.startsWith('#')) { inStats = /^stats:/.test(line); inVerdicts = false; }
    if (!inStats) return line;
    if (/^  \S/.test(line)) inVerdicts = /^  by_verdict:/.test(line);
    if (/^  total:/.test(line)) return `  total: ${rows.length}` + (line.endsWith('\r') ? '\r' : '');
    const verdict = inVerdicts && line.match(/^    (pass|pass-with-notes|fail):/);
    return verdict ? `    ${verdict[1]}: ${rows.filter(row => (row.verification ?? row.verdict) === verdict[1]).length}` + (line.endsWith('\r') ? '\r' : '') : line;
  }).join('\n');
  add(indexPath, budget(Buffer.from(withStats.replace(/\n?$/, '\n'))));
  // Keyed rewrites keep CRLF bytes and tolerate spacing before the colon; a duplicated
  // status/finalized_at key is refused before any write.
  const bom = status.startsWith('\uFEFF') ? '\uFEFF' : '', statusBody = status.slice(bom.length);
  requireValue((statusBody.match(/^status\s*:/gm) ?? []).length <= 1 && (statusBody.match(/^finalized_at\s*:/gm) ?? []).length <= 1, 'invalid-classic-status', true);
  let after = /^status\s*:[^\r\n]*/m.test(statusBody) ? statusBody.replace(/^status\s*:[^\r\n]*/m, 'status: done') : statusBody.replace(/\n?$/, '\n') + 'status: done\n';
  const timestamp = `finalized_at: ${JSON.stringify(s.now())}`;
  after = /^finalized_at\s*:[^\r\n]*/m.test(after) ? after.replace(/^finalized_at\s*:[^\r\n]*/m, timestamp) : after.replace(/\n?$/, '\n') + timestamp + '\n';
  after = bom + after;
  // The execution source projection must survive status-only changes.
  const checkStatus = parseSimpleYaml(after);
  requireValue(checkStatus.plan_id === parsed.plan_id && same(checkStatus.source_binding, parsed.source_binding), 'invalid-source-binding', true);
  add(statusPath, budget(Buffer.from(after)));
  return s.publishLifecycle(input.change_id, 'finalization', id, input, writes,
    { ok: true, state: 'finalized', archive, authority: '/aif-done', next_action: null, authorizes: [] }, guards);
}

export async function lifecycleCommand(action, input, options = {}) {
  const counters = options.counters ?? {};
  for (const k of ['service_calls', 'host_reads', 'host_releases', 'history_scans', 'transaction_scans']) counters[k] ??= 0;
  counters.service_calls++;
  const base = { authorizes: [], capability_limitations: options.HostClient ? [] : ['host-read', 'host-release'], manual_path: { ...manual }, next_action: null };
  try {
    const actions = { 'lifecycle-collect': collect, 'lifecycle-settle': settle, 'lifecycle-release': release, 'lifecycle-progress': progress, 'lifecycle-finalize': finalize };
    requireValue(Object.hasOwn(actions, action), 'unknown-action'); executionId(input?.change_id);
    const s = await lifecycleStore(options);
    // CLI injects its already evaluating owner to avoid a top-level-await cycle.
    // Direct library/driver use loads that owner lazily, after module initialization.
    s.freshness = options.lifecycleFreshness ?? (async (store, run) => (await import('./execution-state.mjs')).lifecycleFreshness(store, run));
    const fn = () => actions[action](input, s, options, counters);
    const result = action === 'lifecycle-collect' ? await fn() : await lifecycleLock(s, input.change_id, fn);
    validateNextAction(result.next_action ?? null);
    return { ...base, ...result, capability_limitations: [...new Set([...base.capability_limitations, ...(result.capability_limitations ?? [])])], authorizes: [], service_calls: { ...counters } };
  } catch (error) {
    if (!(error instanceof WorkflowError)) throw error;
    return { ...base, capability_limitations: error.code === 'lifecycle-capabilities-required' ? ['host-read', ...(action === 'lifecycle-release' ? ['host-release'] : [])] : base.capability_limitations,
      ok: false, code: error.code, blocked: error.blocked, state: 'blocked', reservation_retained: true,
      next_action: next('manual', 'Resolve the reported blocker before retrying.'), service_calls: { ...counters } };
  }
}

// Explicit opt-in driver: cadence/events belong to the host, outside execution locks.
// It never executes suggestions such as accept, recover, release, progress or finalize.
export async function driveLifecycle(input, { maxSteps = 1, wait, ...options } = {}) {
  requireValue(Number.isSafeInteger(maxSteps) && maxSteps >= 1 && maxSteps <= 24, 'invalid-lifecycle-budget');
  const counters = options.counters ?? {}; let result, exhausted = false;
  for (let step = 0; step < maxSteps; step++) {
    result = await lifecycleCommand('lifecycle-collect', input, { ...options, counters });
    exhausted = step + 1 === maxSteps && result.state === 'waiting' && result.next_action?.type === 'lifecycle-collect';
    if (result.state !== 'waiting' || result.next_action?.type !== 'lifecycle-collect' || exhausted) break;
    requireValue(typeof wait === 'function', 'lifecycle-wait-driver-required', true); await wait({ step: step + 1, next_action: result.next_action });
  }
  return { ...result, budget_exhausted: exhausted };
}
