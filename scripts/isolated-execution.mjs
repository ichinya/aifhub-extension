// Host-managed worktrees; local cooperative integration, not process authentication.
import { execFile } from 'node:child_process';
import { lstat, realpath, rename } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { assertAuxiliaryPaths, resolveExecutionSource, selectExecutionTask, validateExecutionScope } from './execution-task-source.mjs';
import { catalogue, history, names, pendingTransactions, reserves } from './execution-transactions.mjs';
import { digest, requireValue, storeFor, worktree, WorkflowError } from './workflow-state-store.mjs';
import { applyImages, eventKey, imageHash, ISOLATION_SCHEMA, isolationFolder, isolationInput, isolationState, same } from './isolated-execution-records.mjs';

const exec = promisify(execFile);
const recordPath = input => `${isolationFolder(input.change_id)}/${input.group_id}.json`;
const allFiles = record => record.start.input.assignments.flatMap(a => a.files).sort();
const sourceRecord = s => ({ ...s.namespace, namespace_digest: s.namespace_digest });
const sameBase = (a, b) => same({ ...a, branch: '' }, { ...b, branch: '' });
const projectLock = '.ai-factory/state/execution-write.lock';

async function identity(store) {
  async function git(args) {
    try { return (await exec('git', args, { cwd: store.root, windowsHide: true, maxBuffer: 2 * 1024 * 1024 })).stdout.trim(); }
    catch { throw new WorkflowError('git-unavailable'); }
  }
  requireValue(await realpath(await git(['rev-parse', '--show-toplevel'])) === store.root, 'project-root-required');
  return { root: store.root, common: await realpath(path.resolve(store.root, await git(['rev-parse', '--git-common-dir']))),
    git_dir: await realpath(await git(['rev-parse', '--absolute-git-dir'])) };
}
function separateRoots(a, b) {
  const rel = path.relative(a.toLowerCase(), b.toLowerCase());
  const reverse = path.relative(b.toLowerCase(), a.toLowerCase());
  return rel && reverse && (rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) && (reverse.startsWith('..' + path.sep) || path.isAbsolute(reverse));
}
async function readRecord(store, input) {
  const record = await store.load(recordPath(input));
  if (record) {
    isolationState(record);
    requireValue(record.start.input.change_id === input.change_id && record.start.input.group_id === input.group_id, 'invalid-isolation-identity');
  }
  return record;
}
export async function isolationGroups(store) {
  const groups = [];
  for (const directory of await names(store, '.ai-factory/state')) if (directory.isDirectory()) {
    for (const entry of await names(store, isolationFolder(directory.name))) {
      requireValue(entry.isFile() && entry.name.endsWith('.json'), 'invalid-isolation-catalogue');
      const record = await readRecord(store, { change_id: directory.name, group_id: entry.name.slice(0, -5) });
      groups.push(record); requireValue(groups.length <= 100, 'isolation-catalogue-full', true);
    }
  }
  return groups;
}
export async function assertIsolationAdmission(store, source) {
  const groups = await isolationGroups(store);
  requireValue(groups.every(r => ['closed', 'abandoned'].includes(isolationState(r).phase)), 'isolation-group-active', true);
  requireValue(groups.filter(r => r.start.input.change_id === source.namespace.id).every(r => same(r.start.source, sourceRecord(source))), 'state-source-collision', true);
}
function view(record, state, extra = {}) {
  return { schema: ISOLATION_SCHEMA, change_id: record.start.input.change_id, group_id: record.start.input.group_id,
    version: state.version, phase: state.phase, owner: record.start.input.owner,
    context_digest: record.start.context.digest, worktree_digest: digest(state.expected),
    assignments: record.start.input.assignments.map(a => ({ task_id: a.task_id, root: record.start.bindings[a.task_id].identity.root, run_id: a.run_id, worker: a.worker, status: state.items[a.task_id].status })),
    pending_task: state.pending?.task_id ?? null, recovery: state.pending?.event?.input ?? null,
    closure: state.closure ? { ...state.closure, digest: digest(state.closure) } : null,
    abandoned: state.abandoned ?? null, ...extra };
}
async function reference(store, paths) { return store.references(assertAuxiliaryPaths(paths)); }
async function savedEvidence(store, paths) {
  // Each input permits 100 references; a five-task group accumulates several inputs.
  requireValue(paths.length <= 1200, 'isolation-evidence-too-large');
  const result = {};
  for (let index = 0; index < paths.length; index += 100) Object.assign(result, await reference(store, paths.slice(index, index + 100)));
  return result;
}

async function groupAdmission(store, input) {
  const groups = await isolationGroups(store);
  requireValue(groups.length < 100 && groups.every(r => ['closed', 'abandoned'].includes(isolationState(r).phase)), 'isolation-group-active', true);
  requireValue(!(await catalogue(store)).some(reserves), 'integration-scope-reserved', true);
  requireValue((await pendingTransactions(store)).length === 0, 'pending-transaction', true);
  const source = await resolveExecutionSource(store, input.change_id, 'implement', input.context_paths ?? []);
  requireValue(!source.delegated, 'stale-isolation-source', true);
  requireValue(groups.filter(g => g.start.input.change_id === input.change_id).every(g => same(g.start.source, sourceRecord(source))), 'state-source-collision', true);
  const h = await history(store, input.change_id);
  requireValue(!h.source || same(h.source.source, sourceRecord(source)), 'state-source-collision', true);
  return source;
}

async function unlocked(store, change) {
  for (const file of [projectLock, `.ai-factory/state/${change}/execution/write.lock`]) requireValue(await store.bytes(file) === null, 'state-locked', true);
}

async function preflight(store, input) {
  requireValue(!await readRecord(store, input), 'isolation-group-exists', true);
  await unlocked(store, input.change_id);
  const source = await groupAdmission(store, input), extra = input.context_paths ?? [];
  const parent = await identity(store), files = input.assignments.flatMap(a => a.files);
  for (const assignment of input.assignments) await validateExecutionScope(store, assignment.files, source, true);
  const baseline = await worktree(store, files, source.projections), evidence = await reference(store, input.preflight_paths), workers = [];
  for (const assignment of input.assignments) {
    selectExecutionTask(source, assignment.task_id, 'implement', extra);
    requireValue(assignment.dependencies.every(id => source.tasks.some(t => t.id === id && t.checked)), 'unfinished-dependency', true);
    const worker = await storeFor(assignment.root), workerIdentity = await identity(worker);
    requireValue(path.resolve(assignment.root).toLowerCase() === workerIdentity.root.toLowerCase(), 'invalid-isolation-binding');
    requireValue(workerIdentity.common === parent.common && separateRoots(workerIdentity.root, parent.root) && workers.every(w => separateRoots(w.identity.root, workerIdentity.root) && w.identity.git_dir !== workerIdentity.git_dir), 'isolated-worktree-required');
    await unlocked(worker, input.change_id);
    const workerSource = await groupAdmission(worker, input), h = await history(worker, input.change_id);
    requireValue(!h.runs.some(r => r.run_id === assignment.run_id), 'worker-run-exists', true);
    requireValue(h.runs.every(r => r.schema === 'aifhub.execution.v2' && !r.legacy) && (!h.ledger || h.ledger.schema === 'aifhub.fix-attempts.v2'), 'upgrade-required', true);
    requireValue(same(sourceRecord(workerSource), sourceRecord(source)), 'worker-source-mismatch', true);
    requireValue(workerSource.context.digest === source.context.digest, 'worker-context-mismatch', true);
    await validateExecutionScope(worker, assignment.files, workerSource, true);
    const tree = await worktree(worker, assignment.files, workerSource.projections);
    requireValue(sameBase(tree, baseline), 'worker-baseline-mismatch', true);
    workers.push({ assignment, store: worker, identity: workerIdentity, tree });
  }
  // A preview cannot reserve a snapshot. Recheck reads and let start make the final decision.
  for (const w of workers) {
    await unlocked(w.store, input.change_id);
    const currentSource = await groupAdmission(w.store, input);
    requireValue(currentSource.context.digest === source.context.digest && same(await identity(w.store), w.identity) && same(await worktree(w.store, w.assignment.files, currentSource.projections), w.tree), 'stale-preflight', true);
    requireValue(!(await history(w.store, input.change_id)).runs.some(r => r.run_id === w.assignment.run_id), 'worker-run-exists', true);
  }
  await unlocked(store, input.change_id);
  const current = await groupAdmission(store, input);
  requireValue(current.context.digest === source.context.digest && same(await identity(store), parent) && same(await worktree(store, files, current.projections), baseline) && same(await reference(store, input.preflight_paths), evidence), 'stale-preflight', true);
  return { schema: 'aifhub.isolated-preflight.v1', change_id: input.change_id, group_id: input.group_id, ready: true, admitted: false,
    input_digest: digest(input), context_digest: source.context.digest, worktree_digest: digest(baseline),
    assignments: workers.map(w => ({ task_id: w.assignment.task_id, root: w.identity.root, run_id: w.assignment.run_id, worker: w.assignment.worker, worktree_digest: digest(w.tree) })) };
}

async function freshContext(store, record, state) {
  requireValue(same(await identity(store), record.start.identity), 'stale-integration-worktree', true);
  const source = await resolveExecutionSource(store, record.start.input.change_id, 'implement', record.start.input.context_paths ?? []);
  requireValue(!source.delegated && same(sourceRecord(source), record.start.source) && source.context.digest === record.start.context.digest, 'stale-isolation-context', true);
  for (const assignment of record.start.input.assignments) await validateExecutionScope(store, assignment.files, source, true);
  requireValue(same(await savedEvidence(store, Object.keys(state.evidence)), state.evidence), 'stale-isolation-evidence', true);
  requireValue((await pendingTransactions(store)).length === 0, 'pending-transaction', true);
  requireValue(!(await catalogue(store)).some(reserves), 'integration-scope-reserved', true);
  return source;
}
async function fresh(store, record, state) {
  const source = await freshContext(store, record, state);
  const current = await worktree(store, allFiles(record), source.projections);
  requireValue(same(current, state.expected), 'stale-integration-tree', true);
  return source;
}
async function workerRecord(record, assignment, execute, initial = false) {
  const store = await storeFor(assignment.root), binding = record.start.bindings[assignment.task_id];
  requireValue(same(await identity(store), binding.identity), 'stale-worker-worktree', true);
  const h = await history(store, record.start.input.change_id), run = h.runs.find(r => r.run_id === assignment.run_id);
  requireValue(run && run.schema === 'aifhub.execution.v2' && !run.legacy && run.kind === 'single' && run.role === 'implement', 'isolated-single-implement-required', true);
  requireValue(run.owner === record.start.input.owner && run.worker === assignment.worker && run.task_id === assignment.task_id && same(run.scope, assignment.files.slice().sort()) && same(run.context_paths, (record.start.input.context_paths ?? []).slice().sort()), 'worker-assignment-mismatch', true);
  requireValue(same(run.source, record.start.source), 'worker-source-mismatch', true);
  requireValue(run.context.digest === record.start.context.digest, 'worker-context-mismatch', true);
  requireValue(sameBase(run.initial_worktree, record.start.baseline) && run.initial_worktree.branch === binding.branch, 'worker-baseline-mismatch', true);
  if (initial) requireValue(run.version === 1 && run.status === 'started' && digest(run) === binding.run_digest, 'worker-already-started', true);
  else requireValue(run.status === 'accepted' && run.lifecycle === 'closed' && run.execution_state === 'stopped' && run.accepted_by === record.start.input.owner, 'worker-not-accepted', true);
  await execute('resume', { change_id: run.change_id, run_id: run.run_id }, { rootDir: store.root });
  return { store, run };
}
async function readImage(store, filename) {
  const data = await store.bytes(filename);
  if (data === null) return null;
  requireValue(data.length <= 4.5 * 1024 * 1024, 'transfer-too-large');
  const info = await lstat(await store.target(filename));
  return { data: data.toString('base64'), mode: info.mode & 0o777 };
}
async function save(store, record) {
  const state = isolationState(record);
  await store.save(recordPath(record.start.input), record);
  return state;
}
async function finishTransfer(store, record, state, options) {
  const source = await freshContext(store, record, state);
  const pending = state.pending, images = state.items[pending.task_id].images;
  const direction = state.phase === 'applying' ? 'after' : 'before';
  const target = applyImages(state.expected, images, direction);
  const current = await worktree(store, allFiles(record), source.projections);
  requireValue(current.head === state.expected.head && current.index === state.expected.index && current.branch === state.expected.branch, 'stale-integration-revision', true);
  const transferPaths = new Set(images.map(i => i.path));
  const outside = tree => Object.fromEntries(Object.entries(tree.files).filter(([p]) => !transferPaths.has(p)));
  requireValue(same(outside(current), outside(state.expected)), 'integration-recovery-conflict', true);
  // Check every image before any recovery write. A third image is never overwritten.
  for (const row of images) {
    const actual = await readImage(store, row.path);
    requireValue(same(actual, row.before) || same(actual, row.after), 'integration-recovery-conflict', true);
  }
  for (let index = 0; index < images.length; index++) {
    const row = images[index], desired = row[direction], actual = await readImage(store, row.path);
    requireValue(same(actual, row.before) || same(actual, row.after), 'integration-recovery-conflict', true);
    if (!same(actual, desired)) {
      if (desired === null) await store.remove(row.path);
      else {
        // Stage under runtime state: a crash cannot leave an untracked source-side temp file.
        const staged = `.ai-factory/state/${record.start.input.change_id}/execution/isolation-transfers/${record.start.input.group_id}/transfer-${digest(row.path)}.tmp`;
        await store.write(staged, Buffer.from(desired.data, 'base64'), desired.mode);
        await rename(await store.target(staged), await store.target(row.path, true));
      }
    }
    await options.fault?.(`after-file-${index}`, { direction });
  }
  requireValue(same(await worktree(store, allFiles(record), source.projections), target), 'stale-integration-tree', true);
  await freshContext(store, record, state);
  await options.fault?.('before-transfer-finish', { direction });
  record.events.push({ kind: direction === 'after' ? 'applied' : 'rejected', intent_digest: digest(pending.event) });
  const next = await save(store, record);
  return view(record, next);
}

// The entrypoint passes its dispatcher to avoid a CLI top-level-await import cycle.
export async function isolatedExecutionCommand(action, input, options = {}, execute) {
  isolationInput(action, input);
  const store = await storeFor(options.rootDir);
  if (action === 'isolation-inspect' || action === 'isolation-resume') {
    const record = await readRecord(store, input); requireValue(record, 'missing-isolation-group');
    const state = isolationState(record);
    if (action === 'isolation-inspect') return view(record, state, { historical: true });
    requireValue(state.phase !== 'abandoned', 'isolation-abandoned', true);
    requireValue(!['applying', 'rejecting'].includes(state.phase), 'integration-transfer-incomplete', true);
    await fresh(store, record, state);
    return view(record, state, { resumable: state.phase !== 'closed' });
  }
  // Classify ultra before creating even the integration lock parent.
  if (action === 'isolation-start' || action === 'isolation-preflight') {
    const selected = await resolveExecutionSource(store, input.change_id, 'implement', input.context_paths ?? []);
    if (selected.delegated) return selected;
  }
  if (action === 'isolation-preflight') return preflight(store, input);
  return store.lock(projectLock, async () => {
    const existing = await readRecord(store, input);
    if (action === 'isolation-start') {
      if (existing) {
        requireValue(same(existing.start.input, input), 'conflicting-isolation-replay', true);
        return view(existing, isolationState(existing), { replay: true, historical: true });
      }
      const source = await groupAdmission(store, input);
      const rootIdentity = await identity(store), bindings = {}, files = input.assignments.flatMap(a => a.files);
      for (const assignment of input.assignments) await validateExecutionScope(store, assignment.files, source, true);
      const baseline = await worktree(store, files, source.projections);
      for (const assignment of input.assignments) {
        selectExecutionTask(source, assignment.task_id, 'implement', input.context_paths ?? []);
        requireValue(assignment.dependencies.every(id => source.tasks.some(t => t.id === id && t.checked)), 'unfinished-dependency', true);
        await validateExecutionScope(store, assignment.files, source, true);
        const workerStore = await storeFor(assignment.root), workerIdentity = await identity(workerStore);
        requireValue(workerIdentity.common === rootIdentity.common && separateRoots(workerIdentity.root, rootIdentity.root) && Object.values(bindings).every(b => separateRoots(b.identity.root, workerIdentity.root) && b.identity.git_dir !== workerIdentity.git_dir), 'isolated-worktree-required');
        const workerHistory = await history(workerStore, input.change_id), run = workerHistory.runs.find(r => r.run_id === assignment.run_id);
        requireValue(run, 'missing-worker-run', true);
        bindings[assignment.task_id] = { identity: workerIdentity, branch: run.initial_worktree.branch, run_digest: digest(run) };
      }
      const record = { schema: ISOLATION_SCHEMA, start: { input: structuredClone(input), identity: rootIdentity, source: sourceRecord(source), context: source.context, baseline, bindings, preflight: await reference(store, input.preflight_paths) }, events: [] };
      for (const assignment of input.assignments) await workerRecord(record, assignment, execute, true);
      await fresh(store, record, isolationState(record));
      return view(record, await save(store, record));
    }
    requireValue(existing, 'missing-isolation-group');
    const record = existing, state = isolationState(record);
    requireValue(input.actor === record.start.input.owner, 'actor-mismatch', true);
    const old = state.receipts[eventKey(action, input)];
    if (old) {
      requireValue(old.input_digest === digest(input), 'conflicting-isolation-replay', true);
      return view(record, state, { replay: true, historical: true, operation_version: old.version });
    }
    if (action !== 'isolation-abandon' && ['applying', 'rejecting'].includes(state.phase)) {
      requireValue(state.pending.event.kind === action && same(state.pending.event.input, input), 'integration-transfer-incomplete', true);
      return finishTransfer(store, record, state, options);
    }
    requireValue(!['closed', 'abandoned'].includes(state.phase) && state.version === input.version, 'version-conflict', true);
    if (input.task_id) requireValue(Object.hasOwn(state.items, input.task_id), 'unknown-or-ambiguous-task');
    // Retirement preserves stopped-worker history even if source/code has drifted.
    if (!['isolation-retire', 'isolation-abandon'].includes(action)) await fresh(store, record, state);
    let event = { kind: action, input: structuredClone(input) };
    if (action === 'isolation-apply') {
      requireValue(state.phase === 'active' && state.items[input.task_id].status === 'waiting', 'integration-pending', true);
      const assignment = record.start.input.assignments.find(a => a.task_id === input.task_id);
      const { store: workerStore, run } = await workerRecord(record, assignment, execute);
      requireValue(input.result_digest === run.result.digest, 'result-mismatch', true);
      const images = []; let imageBytes = 0;
      for (const filename of run.result.changed_files) {
        requireValue(assignment.files.includes(filename), 'outside-scope', true);
        const before = await readImage(store, filename), workerAfter = await readImage(workerStore, filename);
        const defaultMode = process.platform === 'win32' ? 0o666 : 0o644;
        const after = workerAfter === null ? null : { data: workerAfter.data, mode: ((before?.mode ?? defaultMode) & ~0o111) | (workerAfter.mode & 0o111) };
        imageBytes += Buffer.byteLength(before?.data ?? '') + Buffer.byteLength(after?.data ?? '');
        requireValue(imageBytes <= 8 * 1024 * 1024, 'transfer-too-large');
        requireValue(imageHash(after) === (run.checkpoint.worktree.files[filename] ?? null), 'stale-worker-result', true);
        images.push({ path: filename, before, after, before_present: Object.hasOwn(state.expected.files, filename), after_present: Object.hasOwn(run.checkpoint.worktree.files, filename) });
      }
      event = { ...event, images, origin: { result: run.result, record_digest: digest(run) }, stop_refs: await reference(store, input.stop_evidence) };
      // Recheck the source after reading bytes, before persisting transfer intent.
      await workerRecord(record, assignment, execute); await fresh(store, record, state);
    } else if (action === 'isolation-accept' || action === 'isolation-close') {
      event = { ...event, verification_refs: await reference(store, input.verification.evidence), worktree_digest: digest(state.expected) };
    } else if (action === 'isolation-retire' || action === 'isolation-abandon') {
      requireValue(same(await identity(store), record.start.identity), 'stale-integration-worktree', true);
      event = { ...event, stop_refs: await reference(store, input.stop_evidence) };
      if (action === 'isolation-abandon') event.observed_worktree = await worktree(store, allFiles(record));
    }
    record.events.push(event);
    const next = await save(store, record);
    if (['applying', 'rejecting'].includes(next.phase)) {
      await options.fault?.('after-transfer-intent', { direction: next.phase });
      return finishTransfer(store, record, next, options);
    }
    return view(record, next);
  });
}
