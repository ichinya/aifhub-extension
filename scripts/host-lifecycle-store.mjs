// Cooperative journal custody, not authentication against a hostile local writer.
import { canonical, digest, fields, identifier, portablePath, requireValue } from './workflow-state-store.mjs';
import { deliveryStore, requestUuid } from './host-delivery-store.mjs';
import { executionId } from './execution-task-source.mjs';

export const SETTLEMENT_SCHEMA = 'aifhub.settlement.v1';
export const PROGRESS_SCHEMA = 'aifhub.progress-journal.v1';
export const FINALIZATION_SCHEMA = 'aifhub.finalization-journal.v1';
export const RELEASE_SCHEMA = 'aifhub.release-journal.v1';
export const LIFECYCLE_LIMITS = Object.freeze({ members: 24, files: 200, bytes: 4 * 1024 * 1024 });
const same = (a, b) => canonical(a) === canonical(b);
const hash = s => requireValue(typeof s === 'string' && /^[a-f0-9]{64}$/.test(s), 'invalid-lifecycle-record', true);
const schemas = { settlement: 'aifhub.settlement-journal.v1', progress: PROGRESS_SCHEMA, finalization: FINALIZATION_SCHEMA };
export function lifecyclePaths(change, kind, id) {
  executionId(change); identifier(id);
  requireValue(['settlement', 'progress', 'finalization', 'release'].includes(kind), 'invalid-lifecycle-record', true);
  const folder = `.ai-factory/state/${change}/execution`;
  return { folder, journal: `${folder}/${kind}-journals/${id}.json`, record: `${folder}/settlements/${id}.json` };
}
export const lifecycleLock = (s, change, fn) => s.lock('.ai-factory/state/execution-write.lock',
  () => s.lock(`${lifecyclePaths(change, 'progress', 'lock').folder}/write.lock`, fn));

export function validateSettlement(r) {
  fields(r, ['schema', 'settlement_id', 'change_id', 'run_id', 'kind', 'binding', 'deliveries', 'decision', 'input_digest', 'revision', 'created_at', 'updated_at']);
  requireValue(r.schema === SETTLEMENT_SCHEMA && r.settlement_id === r.run_id && r.revision === 1, 'invalid-lifecycle-record', true);
  executionId(r.change_id); identifier(r.run_id); hash(r.input_digest);
  requireValue(['single', 'batch'].includes(r.kind), 'invalid-lifecycle-record', true);
  fields(r.decision, ['actor', 'outcome', 'decided_at']); identifier(r.decision.actor);
  requireValue(['settled', 'partial', 'rejected'].includes(r.decision.outcome) && typeof r.decision.decided_at === 'string'
    && Number.isFinite(Date.parse(r.decision.decided_at)), 'invalid-lifecycle-record', true);
  fields(r.binding, ['manifest_digest', 'seal_digest', 'closure_digest', 'context_digest', 'worktree_digest', 'source_digest', 'accepted', 'results']);
  for (const key of ['manifest_digest', 'context_digest', 'worktree_digest', 'source_digest']) hash(r.binding[key]);
  for (const key of ['seal_digest', 'closure_digest']) if (r.binding[key] !== null) hash(r.binding[key]);
  requireValue(Array.isArray(r.binding.accepted) && new Set(r.binding.accepted).size === r.binding.accepted.length && r.binding.accepted.length <= 5, 'invalid-lifecycle-record', true);
  r.binding.accepted.forEach(identifier);
  requireValue(Array.isArray(r.binding.results) && r.binding.results.length <= 5, 'invalid-lifecycle-record', true);
  for (const result of r.binding.results) {
    fields(result, ['task_id', 'result_digest', 'evidence_digest']); identifier(result.task_id); hash(result.result_digest); hash(result.evidence_digest);
  }
  requireValue(r.deliveries && typeof r.deliveries === 'object' && !Array.isArray(r.deliveries), 'invalid-lifecycle-record', true);
  requireValue(r.binding.accepted.every(task => r.binding.results.some(result => result.task_id === task)), 'invalid-lifecycle-record', true);
  for (const [task, value] of Object.entries(r.deliveries)) {
    requireValue(r.binding.results.some(result => result.task_id === task), 'invalid-lifecycle-record', true);
    fields(value, ['request_uuid', 'delivery_receipt_digest']); requestUuid(value.request_uuid); hash(value.delivery_receipt_digest);
  }
  for (const key of ['created_at', 'updated_at']) requireValue(typeof r[key] === 'string' && Number.isFinite(Date.parse(r[key])), 'invalid-lifecycle-record', true);
  return r;
}

function validateJournal(j, change, kind, id) {
  fields(j, ['schema', 'journal_id', 'change_id', 'run_id', 'input_digest', 'state', 'writes', 'allowed_paths', 'guards', 'response']);
  requireValue(j.schema === schemas[kind] && j.journal_id === id && j.change_id === change && ['prepared', 'applied'].includes(j.state), 'invalid-lifecycle-journal', true);
  identifier(j.run_id); hash(j.input_digest);
  requireValue(Array.isArray(j.writes) && j.writes.length > 0 && j.writes.length <= LIFECYCLE_LIMITS.files
    && same(j.allowed_paths, j.writes.map(w => w.path)) && new Set(j.allowed_paths.map(p => p.toLowerCase())).size === j.writes.length, 'invalid-lifecycle-journal', true);
  let bytes = 0;
  for (const w of j.writes) {
    fields(w, ['path', 'before', 'after', 'before_sha256', 'after_sha256']); portablePath(w.path);
    requireValue(w.before === null || typeof w.before === 'string', 'invalid-lifecycle-journal', true);
    requireValue(typeof w.after === 'string' && (w.before === null ? w.before_sha256 === null : digest(Buffer.from(w.before, 'base64')) === w.before_sha256)
      && digest(Buffer.from(w.after, 'base64')) === w.after_sha256, 'invalid-lifecycle-journal', true);
    bytes += Buffer.byteLength(w.after, 'base64') + (w.before === null ? 0 : Buffer.byteLength(w.before, 'base64'));
  }
  requireValue(bytes <= LIFECYCLE_LIMITS.bytes && j.response?.authorizes?.length === 0, 'invalid-lifecycle-journal', true);
  requireValue(Array.isArray(j.guards) && j.guards.length <= LIFECYCLE_LIMITS.files, 'invalid-lifecycle-journal', true);
  for (const guard of j.guards) { fields(guard, ['path', 'sha256']); portablePath(guard.path); hash(guard.sha256); }
  return j;
}
export async function lifecycleStore(options = {}) {
  const s = await deliveryStore(options);
  async function loadJournal(change, kind, id, input) {
    const j = await s.load(lifecyclePaths(change, kind, id).journal);
    if (j === null) return null;
    validateJournal(j, change, kind, id);
    requireValue(j.input_digest === digest(input), kind === 'settlement' ? 'conflicting-settlement' : 'conflicting-lifecycle-replay', true);
    return j;
  }
  async function apply(j, kind, recovering) {
    for (const guard of j.guards) {
      const bytes = await s.bytes(guard.path);
      requireValue(bytes !== null && digest(bytes) === guard.sha256, 'lifecycle-source-conflict', true);
    }
    // Check all images before any write, then recheck immediately per file.
    async function image(w) {
      const actual = await s.bytes(w.path), sha = actual === null ? null : digest(actual);
      requireValue(sha === w.before_sha256 || sha === w.after_sha256, 'lifecycle-file-conflict', true); return sha;
    }
    for (const w of j.writes) await image(w);
    if (j.state === 'applied') {
      for (const w of j.writes) requireValue(await image(w) === w.after_sha256, 'lifecycle-file-conflict', true);
      return { ...j.response, replay: true, historical: true };
    }
    for (let i = 0; i < j.writes.length; i++) {
      const w = j.writes[i]; await s.hit(`lifecycle-before-write-${i}`);
      if (await image(w) !== w.after_sha256) await s.write(w.path, Buffer.from(w.after, 'base64'));
      await s.hit(`lifecycle-after-write-${i}`);
    }
    await s.hit('lifecycle-before-applied'); j.state = 'applied';
    await s.save(lifecyclePaths(j.change_id, kind, j.journal_id).journal, j); await s.hit('lifecycle-after-applied');
    return recovering ? { ...j.response, recovered: true, historical: true } : j.response;
  }
  async function publish(change, kind, id, input, writes, response, guards = []) {
    requireValue(writes.length >= 1 && writes.length <= LIFECYCLE_LIMITS.files, 'invalid-lifecycle-journal', true);
    const old = await loadJournal(change, kind, id, input);
    if (old) return apply(old, kind, true);
    const images = [];
    let budget = 0;
    for (const [path, value] of writes) {
      const before = await s.bytes(path), after = Buffer.isBuffer(value) ? value : Buffer.from(value);
      budget += after.length + (before?.length ?? 0);
      // Bound the image-construction peak instead of discovering the limit afterwards.
      requireValue(budget <= LIFECYCLE_LIMITS.bytes, 'invalid-lifecycle-journal', true);
      images.push({ path, before: before?.toString('base64') ?? null, after: after.toString('base64'),
        before_sha256: before === null ? null : digest(before), after_sha256: digest(after) });
    }
    const j = { schema: schemas[kind], journal_id: id, change_id: change, run_id: input.run_id ?? id, input_digest: digest(input),
      state: 'prepared', writes: images, allowed_paths: images.map(w => w.path), guards, response };
    validateJournal(j, change, kind, id);
    await s.hit('lifecycle-before-journal'); await s.save(lifecyclePaths(change, kind, id).journal, j); await s.hit('lifecycle-after-journal');
    return apply(j, kind, false);
  }
  return { ...s, loadJournal, applyJournal: apply, publishLifecycle: publish };
}
