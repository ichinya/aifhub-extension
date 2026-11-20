// Cooperative journal custody, not authentication against a hostile local writer.
import { canonical, digest, fields, identifier, isNewGitLeafVisible, portablePath, requireValue, stringList, WorkflowError } from './workflow-state-store.mjs';
import { deliveryStore, requestUuid } from './host-delivery-store.mjs';
import { classicStatusProjection, executionId } from './execution-task-source.mjs';
import { names } from './execution-transactions.mjs';

export const SETTLEMENT_SCHEMA = 'aifhub.settlement.v1';
export const PROGRESS_SCHEMA = 'aifhub.progress-journal.v1';
export const FINALIZATION_SCHEMA = 'aifhub.finalization-journal.v1';
export const RELEASE_SCHEMA = 'aifhub.release-journal.v1';
export const LIFECYCLE_LIMITS = Object.freeze({ members: 24, files: 200, bytes: 4 * 1024 * 1024 });
const same = (a, b) => canonical(a) === canonical(b);
const hash = s => requireValue(typeof s === 'string' && /^[a-f0-9]{64}$/.test(s), 'invalid-lifecycle-record', true);
const schemas = { settlement: 'aifhub.settlement-journal.v1', progress: PROGRESS_SCHEMA, finalization: FINALIZATION_SCHEMA };
const publicationKinds = ['progress', 'finalization'];
const recoverySchema = 'aifhub.file-publication-recovery.v1';
const pathKey = value => process.platform === 'win32' ? value.toLowerCase() : value;
const contains = (root, leaf) => root === leaf || leaf.startsWith(`${root}/`);
export const publicationRunKey = run => `${executionId(run.change_id)}/${identifier(run.run_id)}`;

export function publicationRecovery(source, snapshot, runs, origin = null) {
  return { schema: recoverySchema, source_digest: source.namespace_digest, context_digest: source.context.digest,
    worktree_digest: digest(snapshot), origin_digest: origin ? digest(origin) : null,
    runs: Object.fromEntries(runs.map(run => [publicationRunKey(run), digest(run)])) };
}
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
  fields(r.binding, ['manifest_digest', 'seal_digest', 'closure_digest', 'context_digest', 'worktree_digest', 'source_digest', 'accepted', 'results'], ['instruction_composition_digest']);
  for (const key of ['manifest_digest', 'context_digest', 'worktree_digest', 'source_digest']) hash(r.binding[key]);
  for (const key of ['seal_digest', 'closure_digest']) if (r.binding[key] !== null) hash(r.binding[key]);
  // Present composition binding is hash-or-null: null is the legal
  // unavailable degradation, matching execution-record semantics (review R1).
  if (r.binding.instruction_composition_digest !== undefined) requireValue(r.binding.instruction_composition_digest === null || /^[a-f0-9]{64}$/.test(r.binding.instruction_composition_digest), 'invalid-lifecycle-record', true);
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
  fields(j, ['schema', 'journal_id', 'change_id', 'run_id', 'input_digest', 'state', 'writes', 'allowed_paths', 'guards', 'response'], ['recovery']);
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
  if (Object.hasOwn(j, 'recovery')) {
    requireValue(publicationKinds.includes(kind), 'invalid-lifecycle-journal', true);
    const record = j.recovery;
    fields(record, ['schema', 'source_digest', 'context_digest', 'worktree_digest', 'origin_digest', 'runs', 'before_modes']);
    requireValue(record.schema === recoverySchema, 'invalid-lifecycle-journal', true);
    for (const key of ['source_digest', 'context_digest', 'worktree_digest']) hash(record[key]);
    if (kind === 'progress') hash(record.origin_digest);
    else requireValue(record.origin_digest === null, 'invalid-lifecycle-journal', true);
    const runs = record.runs;
    requireValue(runs && typeof runs === 'object' && !Array.isArray(runs) && Object.keys(runs).length <= 1000, 'invalid-lifecycle-journal', true);
    for (const [key, value] of Object.entries(runs)) {
      const [changeId, runId, extra] = key.split('/');
      requireValue(extra === undefined && publicationRunKey({ change_id: changeId, run_id: runId }) === key, 'invalid-lifecycle-journal', true);
      hash(value);
    }
    fields(record.before_modes, j.allowed_paths);
    for (const write of j.writes) {
      const mode = record.before_modes[write.path];
      requireValue(write.before === null ? mode === null : Number.isInteger(mode) && (mode & 0o111) === mode, 'invalid-lifecycle-journal', true);
    }
  }
  return j;
}

function publicationInputs(store, source, scope, snapshot) {
  const context = Object.keys(source.context.sources).map(pathKey);
  const projections = new Map(Object.entries(source.projections).map(([name, hash]) => [pathKey(name), hash]));
  const visible = new Set(Object.keys(snapshot.files).map(pathKey));
  const scopes = scope.map(pathKey);
  return async write => {
    const key = pathKey(write.path);
    if (projections.has(key)) {
      const after = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.from(write.after, 'base64'));
      const parent = await store.textFile(source.entrypoint);
      const status = classicStatusProjection(after, source.id, parent);
      return digest(status.projection) !== projections.get(key);
    }
    if (context.some(root => contains(root, key) || contains(key, root))) return true;
    if (write.path.toLowerCase().startsWith('.ai-factory/')) return false;
    if (visible.has(key)) return true;
    // An absent leaf may enter the worktree inventory when it is created.
    if (write.before !== null) return false;
    return scopes.some(root => contains(root, key)) || isNewGitLeafVisible(store, write.path, snapshot);
  };
}

export async function publicationAffects(store, source, scope, snapshot, writes) {
  const changesInputs = publicationInputs(store, source, scope, snapshot);
  for (const write of writes) if (await changesInputs(write)) return true;
  return false;
}

function beforeImageStore(store, journal, applied) {
  if (!applied.length) return store;
  const images = new Map(applied.map(write => [pathKey(write.path), write]));
  const before = write => write.before === null ? null : Buffer.from(write.before, 'base64');
  const readLeaf = async relative => {
    const write = images.get(pathKey(relative));
    if (!write) return store.readLeaf(relative);
    const data = before(write);
    return data === null ? null : { data, mode: journal.recovery?.before_modes[write.path] ?? 0 };
  };
  const bytes = async relative => (await readLeaf(relative))?.data ?? null;
  return {
    ...store, readLeaf, bytes,
    projectedMissing: relative => images.get(pathKey(relative))?.before === null,
    async textFile(relative) {
      const data = await bytes(relative);
      if (data === null) return null;
      try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data); }
      catch { throw new WorkflowError('invalid-utf8'); }
    },
    async inventory(relative, options = {}) {
      const inventory = await store.inventory(relative, options);
      for (const filename of Object.keys(inventory)) {
        const write = images.get(pathKey(filename));
        if (!write) continue;
        if (write.before === null) delete inventory[filename];
        else if (!options.namesOnly) inventory[filename] = write.before_sha256;
      }
      return inventory;
    },
    async references(paths) {
      const refs = Object.create(null);
      for (const filename of stringList(paths)) {
        const data = await bytes(portablePath(filename));
        requireValue(data !== null, 'missing-evidence', true);
        refs[filename] = digest(data);
      }
      return refs;
    },
  };
}

export async function lifecycleStore(options = {}) {
  const s = await deliveryStore(options);
  // Call under the checkout lock with the source and worktree of this admission.
  async function findPendingPublication(source, scope, snapshot, outputs = []) {
    const changesInputs = publicationInputs(s, source, scope, snapshot);
    const targets = outputs.map(pathKey);
    let scanned = 0;
    for (const change of await names(s, '.ai-factory/state')) {
      if (!change.isDirectory()) continue;
      for (const kind of publicationKinds) {
        const folder = `${lifecyclePaths(change.name, kind, 'scan').folder}/${kind}-journals`;
        for (const entry of await names(s, folder)) {
          requireValue(++scanned <= 1000, 'lifecycle-catalogue-full', true);
          requireValue(entry.isFile() && entry.name.endsWith('.json'), 'invalid-lifecycle-journal', true);
          const journalId = identifier(entry.name.slice(0, -5));
          const journal = validateJournal(await s.load(`${folder}/${entry.name}`), change.name, kind, journalId);
          if (journal.state === 'applied') continue;
          for (const write of journal.writes) {
            const bytes = await s.bytes(write.path);
            const current = bytes === null ? null : digest(bytes);
            if (current === write.after_sha256) continue;
            const key = pathKey(write.path);
            const sharedOutput = targets.some(target => contains(key, target) || contains(target, key));
            if (!sharedOutput && !await changesInputs(write)) continue;
            requireValue(current === write.before_sha256, 'lifecycle-file-conflict', true);
            return { kind, changeId: change.name, journalId };
          }
        }
      }
    }
    return null;
  }
  async function loadJournal(change, kind, id, input) {
    const j = await s.load(lifecyclePaths(change, kind, id).journal);
    if (j === null) return null;
    validateJournal(j, change, kind, id);
    requireValue(j.input_digest === digest(input), kind === 'settlement' ? 'conflicting-settlement' : 'conflicting-lifecycle-replay', true);
    return j;
  }
  async function apply(j, kind, recovering, verifyRecovery) {
    for (const guard of j.guards) {
      const bytes = await s.bytes(guard.path);
      requireValue(bytes !== null && digest(bytes) === guard.sha256, 'lifecycle-source-conflict', true);
    }
    // Check all images before any write, then recheck immediately per file.
    async function image(w) {
      const actual = await s.bytes(w.path), sha = actual === null ? null : digest(actual);
      requireValue(sha === w.before_sha256 || sha === w.after_sha256, 'lifecycle-file-conflict', true); return sha;
    }
    const applied = [], remaining = [];
    for (const w of j.writes) {
      const current = await image(w);
      (current === w.after_sha256 ? applied : remaining).push(w);
    }
    if (j.state === 'applied') {
      requireValue(!remaining.length, 'lifecycle-file-conflict', true);
      return { ...j.response, replay: true, historical: true };
    }
    const recoveringFiles = recovering && publicationKinds.includes(kind);
    if (recoveringFiles) {
      if (remaining.length) await verifyRecovery?.({ remaining, projected: beforeImageStore(s, j, applied) });
      // Recheck the complete image set after the read-only compatibility check.
      for (const w of applied) requireValue(await image(w) === w.after_sha256, 'lifecycle-file-conflict', true);
      for (const w of remaining) requireValue(await image(w) === w.before_sha256, 'lifecycle-file-conflict', true);
    }
    const selected = new Set(recoveringFiles ? remaining : j.writes);
    for (const [i, w] of j.writes.entries()) {
      if (!selected.has(w)) continue;
      await s.hit(`lifecycle-before-write-${i}`);
      if (await image(w) !== w.after_sha256) await s.write(w.path, Buffer.from(w.after, 'base64'));
      await s.hit(`lifecycle-after-write-${i}`);
    }
    await s.hit('lifecycle-before-applied'); j.state = 'applied';
    await s.save(lifecyclePaths(j.change_id, kind, j.journal_id).journal, j); await s.hit('lifecycle-after-applied');
    return recovering ? { ...j.response, recovered: true, historical: true } : j.response;
  }
  async function publish(change, kind, id, input, writes, response, guards = [], recovery) {
    requireValue(writes.length >= 1 && writes.length <= LIFECYCLE_LIMITS.files, 'invalid-lifecycle-journal', true);
    const old = await loadJournal(change, kind, id, input);
    if (old) return apply(old, kind, true);
    const images = [], beforeModes = Object.create(null);
    let budget = 0;
    for (const [path, value] of writes) {
      const leaf = await s.readLeaf(path), before = leaf?.data ?? null, after = Buffer.isBuffer(value) ? value : Buffer.from(value);
      if (recovery) beforeModes[path] = leaf?.mode ?? null;
      budget += after.length + (before?.length ?? 0);
      // Bound the image-construction peak instead of discovering the limit afterwards.
      requireValue(budget <= LIFECYCLE_LIMITS.bytes, 'invalid-lifecycle-journal', true);
      images.push({ path, before: before?.toString('base64') ?? null, after: after.toString('base64'),
        before_sha256: before === null ? null : digest(before), after_sha256: digest(after) });
    }
    const j = { schema: schemas[kind], journal_id: id, change_id: change, run_id: input.run_id ?? id, input_digest: digest(input),
      state: 'prepared', writes: images, allowed_paths: images.map(w => w.path), guards, response,
      ...(recovery ? { recovery: { ...recovery, before_modes: beforeModes } } : {}) };
    validateJournal(j, change, kind, id);
    await s.hit('lifecycle-before-journal'); await s.save(lifecyclePaths(change, kind, id).journal, j); await s.hit('lifecycle-after-journal');
    return apply(j, kind, false);
  }
  return { ...s, findPendingPublication, loadJournal, applyJournal: apply, publishLifecycle: publish };
}
