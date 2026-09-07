import path from 'node:path';
import { boundedText, canonical, changedFiles, digest, fields, identifier, portablePath, requireValue, stringList } from './workflow-state-store.mjs';
import { contextRecord, hash, namespace, overlap, refs, resultPayload, resultRecord, snapshot } from './execution-records.mjs';
import { assertAuxiliaryPaths, executionId } from './execution-task-source.mjs';

export const ISOLATION_SCHEMA = 'aifhub.isolated-execution.v1';
export const isolationFolder = change => `.ai-factory/state/${executionId(change)}/execution/isolation`;
const common = ['change_id', 'group_id'];
const mutation = [...common, 'actor', 'version'];
export const isolationContracts = {
  'isolation-preflight': [[...common, 'owner', 'assignments', 'preflight_paths'], ['context_paths']],
  'isolation-start': [[...common, 'owner', 'assignments', 'preflight_paths'], ['context_paths']],
  'isolation-inspect': [common, []],
  'isolation-resume': [common, []],
  'isolation-apply': [[...mutation, 'task_id', 'result_digest', 'stop_evidence'], []],
  'isolation-accept': [[...mutation, 'task_id', 'verification'], []],
  'isolation-reject': [[...mutation, 'task_id', 'reason'], []],
  'isolation-retire': [[...mutation, 'task_id', 'reason', 'stop_evidence'], []],
  'isolation-abandon': [[...mutation, 'reason', 'stop_evidence'], []],
  'isolation-close': [[...mutation, 'verification'], []],
};
export const same = (a, b) => canonical(a) === canonical(b);
export const integer = n => requireValue(Number.isSafeInteger(n) && n >= 1, 'invalid-isolation-state');
export function rootPath(value) {
  boundedText(value, 1000);
  requireValue(path.isAbsolute(value) && !/[\x00-\x1f]/.test(value), 'invalid-worktree-root');
  return value;
}
export function gitIdentity(value) {
  fields(value, ['root', 'common', 'git_dir']);
  Object.values(value).forEach(rootPath);
}
export function assignments(value) {
  requireValue(Array.isArray(value) && value.length >= 1 && value.length <= 5, 'invalid-isolated-assignments');
  const ids = new Set(), roots = new Set(), files = [];
  for (const item of value) {
    fields(item, ['task_id', 'root', 'run_id', 'worker', 'files', 'dependencies']);
    [item.task_id, item.run_id, item.worker].forEach(identifier); rootPath(item.root);
    requireValue(!ids.has(item.task_id.toLowerCase()) && !roots.has(item.root.toLowerCase()), 'duplicate-isolated-assignment');
    ids.add(item.task_id.toLowerCase()); roots.add(item.root.toLowerCase());
    requireValue(stringList(item.files).length > 0, 'empty-scope');
    for (const file of item.files) {
      portablePath(file); requireValue(!files.some(p => overlap(p, file)), 'overlapping-items'); files.push(file);
    }
    stringList(item.dependencies).forEach(identifier);
  }
  requireValue(files.length <= 100, 'isolation-scope-too-large');
  for (const item of value) requireValue(!item.dependencies.some(id => ids.has(id.toLowerCase())), 'dependent-items');
}
export function isolationInput(action, input) {
  requireValue(Object.hasOwn(isolationContracts, action), 'unknown-action');
  fields(input, ...isolationContracts[action]); executionId(input.change_id); identifier(input.group_id);
  if (input.actor !== undefined) { identifier(input.actor); integer(input.version); }
  if (input.task_id !== undefined) identifier(input.task_id);
  if (input.result_digest !== undefined) hash(input.result_digest);
  if (input.reason !== undefined) boundedText(input.reason);
  if (input.verification !== undefined) {
    resultPayload(input.verification);
    requireValue(input.verification.status === 'completed', 'integration-not-completed');
  }
  for (const key of ['stop_evidence', 'preflight_paths']) if (input[key] !== undefined) {
    requireValue(stringList(input[key]).length > 0, 'missing-evidence'); assertAuxiliaryPaths(input[key]);
  }
  if (action === 'isolation-start' || action === 'isolation-preflight') {
    identifier(input.owner); assignments(input.assignments); assertAuxiliaryPaths(stringList(input.context_paths ?? []));
  }
}
function image(value) {
  if (value === null) return;
  fields(value, ['data', 'mode']);
  requireValue(typeof value.data === 'string' && value.data.length <= 6 * 1024 * 1024 && Buffer.from(value.data, 'base64').toString('base64') === value.data, 'invalid-transfer-image');
  requireValue(Number.isInteger(value.mode) && value.mode >= 0 && value.mode <= 0o777, 'invalid-transfer-image');
}
export const imageHash = value => value === null ? null : digest({ content: digest(Buffer.from(value.data, 'base64')), executable: value.mode & 0o111 });
export function applyImages(base, images, direction = 'after') {
  const next = structuredClone(base);
  for (const row of images) {
    if (row[`${direction}_present`]) next.files[row.path] = imageHash(row[direction]);
    else delete next.files[row.path];
  }
  return next;
}
function evidence(value, paths) {
  refs(value); assertAuxiliaryPaths(Object.keys(value));
  requireValue(same(Object.keys(value).sort(), [...paths].sort()), 'invalid-isolation-evidence');
}
function mergeEvidence(state, value) {
  for (const [name, hash] of Object.entries(value)) {
    requireValue(!Object.hasOwn(state.evidence, name) || state.evidence[name] === hash, 'conflicting-isolation-evidence');
    state.evidence[name] = hash;
  }
  requireValue(Object.keys(state.evidence).length <= 1200, 'isolation-evidence-too-large');
}
export function eventKey(action, input) { return `${action}:${input.task_id ?? ''}`; }

// Rebuild state from a bounded typed journal instead of trusting saved status flags.
export function isolationState(record) {
  fields(record, ['schema', 'start', 'events']);
  requireValue(record.schema === ISOLATION_SCHEMA, 'invalid-isolation-schema');
  const start = record.start;
  fields(start, ['input', 'identity', 'source', 'context', 'baseline', 'bindings', 'preflight']);
  isolationInput('isolation-start', start.input); gitIdentity(start.identity); namespace(start.source);
  requireValue(start.source.id === start.input.change_id, 'invalid-isolation-source');
  contextRecord(start.context); snapshot(start.baseline); evidence(start.preflight, start.input.preflight_paths);
  fields(start.bindings, start.input.assignments.map(a => a.task_id));
  for (const item of start.input.assignments) {
    const binding = start.bindings[item.task_id]; fields(binding, ['identity', 'branch', 'run_digest']);
    gitIdentity(binding.identity); boundedText(binding.branch, 300); hash(binding.run_digest);
    requireValue(path.resolve(item.root).toLowerCase() === binding.identity.root.toLowerCase() && binding.identity.common === start.identity.common && binding.identity.root !== start.identity.root && binding.identity.git_dir !== start.identity.git_dir, 'invalid-isolation-binding');
  }
  requireValue(Array.isArray(record.events) && record.events.length <= 40, 'invalid-isolation-journal');
  const state = { version: 1, phase: 'active', expected: structuredClone(start.baseline), pending: null,
    items: Object.fromEntries(start.input.assignments.map(a => [a.task_id, { status: 'waiting' }])), receipts: {}, evidence: { ...start.preflight }, closure: null };
  let imageBytes = 0;
  for (const event of record.events) {
    const finishing = ['applied', 'rejected'].includes(event.kind);
    if (finishing) {
      fields(event, ['kind', 'intent_digest']); hash(event.intent_digest);
      requireValue(state.pending && event.intent_digest === digest(state.pending.event) && state.phase === (event.kind === 'applied' ? 'applying' : 'rejecting'), 'invalid-isolation-transition');
      const { input } = state.pending.event, item = state.items[input.task_id];
      state.expected = applyImages(state.expected, item.images, event.kind === 'applied' ? 'after' : 'before');
      item.status = event.kind === 'applied' ? 'pending' : 'rejected';
      state.phase = event.kind === 'applied' ? 'pending' : 'active';
      state.receipts[eventKey(state.pending.event.kind, input)] = { input_digest: digest(input), version: state.version + 1 };
      state.pending = event.kind === 'applied' ? { task_id: input.task_id } : null;
    } else {
      requireValue(!['closed', 'abandoned'].includes(state.phase) && (event.kind === 'isolation-abandon' || !['applying', 'rejecting'].includes(state.phase)), 'invalid-isolation-transition');
      const { kind, input } = event;
      isolationInput(kind, input);
      requireValue(input.actor === start.input.owner && input.version === state.version && input.change_id === start.input.change_id && input.group_id === start.input.group_id, 'invalid-isolation-transition');
      const key = eventKey(kind, input); requireValue(!state.receipts[key], 'duplicate-isolation-event');
      const item = input.task_id ? state.items[input.task_id] : null;
      if (input.task_id) requireValue(item, 'invalid-isolation-task');
      if (kind === 'isolation-abandon') {
        fields(event, ['kind', 'input', 'stop_refs', 'observed_worktree']);
        evidence(event.stop_refs, input.stop_evidence); snapshot(event.observed_worktree);
        state.phase = 'abandoned'; state.pending = null;
        state.abandoned = { reason: input.reason, retained_files: changedFiles(start.baseline, event.observed_worktree) };
        state.receipts[key] = { input_digest: digest(input), version: state.version + 1 };
      } else if (kind === 'isolation-apply') {
        fields(event, ['kind', 'input', 'images', 'origin', 'stop_refs']);
        requireValue(state.phase === 'active' && item.status === 'waiting', 'invalid-isolation-transition');
        fields(event.origin, ['result', 'record_digest']); hash(event.origin.record_digest);
        const assignment = start.input.assignments.find(a => a.task_id === input.task_id), binding = start.bindings[input.task_id];
        const workerBase = { ...start.baseline, branch: binding.branch };
        resultRecord(event.origin.result, { change_id: input.change_id, run_id: assignment.run_id, initial_worktree: workerBase, context: start.context }, input.task_id);
        requireValue(event.origin.result.digest === input.result_digest && event.origin.result.status === 'completed', 'invalid-isolation-result');
        requireValue(Array.isArray(event.images) && event.images.length <= 100, 'invalid-transfer-images');
        const paths = [];
        for (const row of event.images) {
          fields(row, ['path', 'before', 'after', 'before_present', 'after_present']); portablePath(row.path);
          requireValue(assignment.files.includes(row.path) && !paths.includes(row.path), 'invalid-transfer-scope'); paths.push(row.path);
          image(row.before); image(row.after);
          imageBytes += Buffer.byteLength(row.before?.data ?? '') + Buffer.byteLength(row.after?.data ?? '');
          requireValue(imageBytes <= 8 * 1024 * 1024, 'transfer-too-large');
          requireValue(typeof row.before_present === 'boolean' && typeof row.after_present === 'boolean' && (row.before === null || row.before_present) && (row.after === null || row.after_present), 'invalid-transfer-image');
          requireValue(row.before_present === Object.hasOwn(state.expected.files, row.path) && imageHash(row.before) === (state.expected.files[row.path] ?? null) && imageHash(row.before) !== imageHash(row.after), 'invalid-transfer-base');
        }
        requireValue(same(paths.slice().sort(), event.origin.result.changed_files) && digest(applyImages(workerBase, event.images)) === event.origin.result.worktree_digest, 'invalid-transfer-result');
        evidence(event.stop_refs, input.stop_evidence); mergeEvidence(state, event.stop_refs);
        Object.assign(item, { status: 'applying', images: event.images, result_digest: input.result_digest });
        state.phase = 'applying'; state.pending = { task_id: input.task_id, event };
      } else if (kind === 'isolation-reject') {
        fields(event, ['kind', 'input']);
        requireValue(state.phase === 'pending' && state.pending.task_id === input.task_id && item.status === 'pending', 'invalid-isolation-transition');
        state.phase = 'rejecting'; state.pending = { task_id: input.task_id, event }; item.status = 'rejecting';
      } else if (kind === 'isolation-accept' || kind === 'isolation-close') {
        fields(event, ['kind', 'input', 'verification_refs', 'worktree_digest']); hash(event.worktree_digest);
        requireValue(event.worktree_digest === digest(state.expected), 'invalid-integration-revision');
        if (kind === 'isolation-accept') {
          requireValue(state.phase === 'pending' && state.pending.task_id === input.task_id && item.status === 'pending', 'invalid-isolation-transition');
          requireValue(same(resultPayload(input.verification).changed_files, item.images.map(r => r.path).sort()), 'changed-files-mismatch');
          item.status = 'accepted'; state.pending = null; state.phase = 'active';
        } else {
          requireValue(state.phase === 'active' && Object.values(state.items).every(i => ['accepted', 'rejected', 'retired'].includes(i.status)), 'isolation-workers-unfinished');
          requireValue(same(resultPayload(input.verification).changed_files, changedFiles(start.baseline, state.expected)), 'changed-files-mismatch');
          state.phase = 'closed';
          state.closure = { accepted: Object.keys(state.items).filter(id => state.items[id].status === 'accepted').sort(), unfinished: Object.keys(state.items).filter(id => state.items[id].status !== 'accepted').sort(), context_digest: start.context.digest, worktree_digest: event.worktree_digest, verification_digest: digest(input.verification) };
        }
        evidence(event.verification_refs, input.verification.evidence); mergeEvidence(state, event.verification_refs);
        state.receipts[key] = { input_digest: digest(input), version: state.version + 1 };
      } else if (kind === 'isolation-retire') {
        fields(event, ['kind', 'input', 'stop_refs']);
        requireValue(state.phase === 'active' && item.status === 'waiting', 'invalid-isolation-transition');
        evidence(event.stop_refs, input.stop_evidence); mergeEvidence(state, event.stop_refs); item.status = 'retired';
        state.receipts[key] = { input_digest: digest(input), version: state.version + 1 };
      } else requireValue(false, 'invalid-isolation-event');
    }
    state.version++;
  }
  return state;
}
