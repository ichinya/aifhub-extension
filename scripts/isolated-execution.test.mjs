import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { executionProject } from './fixtures/execution-project.mjs';
import { executionCommand } from './execution-state.mjs';
import { storeFor } from './workflow-state-store.mjs';

const exec = promisify(execFile);
const trace = name => `.ai-factory/state/work/implementation/${name}.md`;
async function project(t, options = {}) {
  const p = await executionProject(options), workers = [], container = await mkdtemp(path.join(os.tmpdir(), 'aifhub-isolation-'));
  t.after(async () => {
    for (const w of workers) {
      assert.ok(path.resolve(w.root).startsWith(path.resolve(container) + path.sep));
      await p.git('worktree', 'remove', '--force', w.root);
    }
    assert.ok(path.resolve(container).startsWith(path.resolve(os.tmpdir()) + path.sep));
    await rm(container, { recursive: true, force: true, maxRetries: 3 }); await p.cleanup();
  });
  await p.git('config', 'core.autocrlf', 'false');
  await p.put('src/a.js', 'module.exports = () => 1;\n'); await p.put('src/b.js', 'module.exports = () => 1;\n');
  for (const [name, data] of Object.entries(options.initial ?? {})) await p.put(name, data);
  await p.git('add', '.'); await p.git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'behavior fixture');
  await p.put('outside.txt', 'pre-existing dirty data\n');
  for (let i = 0; i < 2; i++) {
    const root = path.join(container, `worker-${i}`);
    await p.git('worktree', 'add', '--detach', root, 'HEAD');
    const w = { root, worker: `worker-${i}`, run_id: `run-${i}`, task_id: `1.${i + 1}`, files: options.scopes?.[i] ?? [i ? 'src/b.js' : 'src/a.js'], dependencies: [] };
    workers.push(w);
    await cp(path.join(p.root, '.ai-factory'), path.join(root, '.ai-factory'), { recursive: true });
    await cp(path.join(p.root, 'outside.txt'), path.join(root, 'outside.txt'));
    if (options.admitWorkers !== false) await executionCommand('start', { change_id: p.id, run_id: w.run_id, task_id: w.task_id, owner: 'parent', worker: w.worker, role: 'implement', scope: w.files }, { rootDir: root });
  }
  await p.put(trace('preflight'), 'The two fixture exports have independent callers. No interface dependencies.\n');
  const start = { change_id: p.id, group_id: 'wave-1', owner: 'parent', assignments: workers.map(w => ({ ...w })), preflight_paths: [trace('preflight')] };
  for (let i = 1; i < (options.preflightCount ?? 1); i++) {
    const file = trace(`preflight-${i}`); await p.put(file, `Independent fixture premise ${i}.\n`); start.preflight_paths.push(file);
  }
  const call = (action, input, extra = {}) => p.call(`isolation-${action}`, input, extra);
  const mutation = (version, extra = {}) => ({ change_id: p.id, group_id: 'wave-1', actor: 'parent', version, ...extra });
  const inspect = () => call('inspect', { change_id: p.id, group_id: 'wave-1' });
  async function finish(w, value, changes = null, beforeResult = async () => {}) {
    for (const [file, contents] of Object.entries(changes ?? { [w.files[0]]: `module.exports = () => ${value};\n` })) {
      const target = path.join(w.root, file);
      if (contents === null) await rm(target); else { await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, contents); }
    }
    await beforeResult();
    const observed = await exec(process.execPath, ['-e', `if(require('./${w.files[0]}')()!==${value})process.exit(1)`], { cwd: w.root, windowsHide: true });
    assert.equal(observed.stderr, '');
    const evidence = trace(`worker-${w.task_id}`);
    await mkdir(path.dirname(path.join(w.root, evidence)), { recursive: true }); await writeFile(path.join(w.root, evidence), `Fixture check exited 0 for value ${value}.\n`);
    const result = await executionCommand('result', { change_id: p.id, run_id: w.run_id, actor: w.worker, version: 1,
      result: { result_id: `result-${w.task_id}`, status: 'completed', changed_files: Object.keys(changes ?? { [w.files[0]]: '' }).sort(), checks: [{ name: 'fixture public export', exit_code: 0 }], evidence: [evidence] } }, { rootDir: w.root });
    await executionCommand('accept', { change_id: p.id, run_id: w.run_id, actor: 'parent', version: result.version, result_digest: result.result_digest }, { rootDir: w.root });
    await p.put(trace(`stop-${w.task_id}`), 'Test-owned worker function and its awaited child check have exited. No background worker remains.\n');
    return result.result_digest;
  }
  const apply = async (w, result, extra = {}) => call('apply', mutation((await inspect()).version, { task_id: w.task_id, result_digest: result, stop_evidence: [trace(`stop-${w.task_id}`)] }), extra);
  async function verification(name, files, a, b) {
    await exec(process.execPath, ['-e', `if(require('./src/a.js')()!==${a} || require('./src/b.js')()!==${b})process.exit(1)`], { cwd: p.root, windowsHide: true });
    const evidence = trace(name); await p.put(evidence, `Observed combined fixture exports ${a}, ${b}; check exited 0.\n`);
    return { result_id: name, status: 'completed', changed_files: [...files].sort(), checks: [{ name: 'combined fixture behavior', exit_code: 0 }], evidence: [evidence] };
  }
  return { ...p, workers, call, start, mutation, inspect, finish, apply, verification };
}

test('preflight rejects a junction alias before ordinary runs can be created', async t => {
  const p = await project(t, { admitWorkers: false });
  const alias = path.join(path.dirname(p.workers[0].root), 'worker-alias');
  try { await symlink(p.workers[0].root, alias, 'junction'); }
  catch (error) { if (error.code === 'EPERM') return t.skip('junction unavailable'); throw error; }
  const before = await readdir(path.join(p.workers[0].root, '.ai-factory'), { recursive: true });
  const input = structuredClone(p.start); input.assignments[0].root = alias;
  await assert.rejects(p.call('preflight', input), { code: 'invalid-isolation-binding' });
  assert.deepEqual(await readdir(path.join(p.workers[0].root, '.ai-factory'), { recursive: true }), before);
  assert.equal(await p.get('outside.txt'), 'pre-existing dirty data\n');
});

for (const mode of ['openspec', 'classic']) test(`isolated ${mode} workers integrate in reverse order; only closed fresh group authorizes its accepted set`, async t => {
  const p = await project(t, { mode, ...(mode === 'classic' ? { plans: 'planning' } : {}) });
  await p.call('start', p.start);
  await assert.rejects(() => executionCommand('start', { change_id: p.id, run_id: 'parent-run', task_id: '1.1', owner: 'parent', worker: 'local', role: 'implement', scope: ['outside.txt'] }, { rootDir: p.root }), { code: 'isolation-group-active' });
  const finished = await Promise.allSettled(p.workers.map((w, i) => p.finish(w, i + 2)));
  for (const r of finished) assert.equal(r.status, 'fulfilled', String(r.reason));
  const b = await p.apply(p.workers[1], finished[1].value);
  assert.equal(b.phase, 'pending'); assert.equal(b.closure, null);
  await assert.rejects(() => p.apply(p.workers[0], finished[0].value), { code: 'integration-pending' });
  const checkedB = await p.verification('integration-b', ['src/b.js'], 1, 3);
  await p.call('accept', p.mutation(b.version, { task_id: '1.2', verification: checkedB }));
  const a = await p.apply(p.workers[0], finished[0].value);
  await p.call('accept', p.mutation(a.version, { task_id: '1.1', verification: await p.verification('integration-a', ['src/a.js'], 2, 3) }));
  const closeInput = p.mutation((await p.inspect()).version, { verification: await p.verification('integration-all', ['src/a.js', 'src/b.js'], 2, 3) });
  const closed = await p.call('close', closeInput);
  assert.deepEqual(closed.closure.accepted, ['1.1', '1.2']); assert.deepEqual(closed.closure.unfinished, []);
  assert.equal((await p.call('resume', { change_id: p.id, group_id: 'wave-1' })).resumable, false);
  assert.equal(await p.get('outside.txt'), 'pre-existing dirty data\n');
  const checklist = mode === 'classic' ? 'planning/work/task.md' : 'openspec/changes/work/tasks.md';
  assert.match(await p.get(checklist), /\[ \] 1\.1/);
  await p.put(checklist, (await p.get(checklist)).replaceAll('[ ]', '[x]'));
  if (mode === 'classic') await p.put('planning/work.md', (await p.get('planning/work.md')).replaceAll('[ ]', '[x]'));
  await assert.rejects(() => p.call('resume', { change_id: p.id, group_id: 'wave-1' }), { code: 'stale-isolation-context' });
  const replay = await p.call('close', closeInput); assert.equal(replay.historical, true); assert.equal(replay.version, closed.version);
});

test('partial apply and rollback replay exact images without overwriting a third image', async t => {
  const p = await project(t);
  const w = p.workers[0];
  // Interrupt immediately after the file image is durable but before the journal finishes.
  await p.call('start', p.start); const result = await p.finish(w, 2);
  const input = p.mutation(1, { task_id: w.task_id, result_digest: result, stop_evidence: [trace(`stop-${w.task_id}`)] });
  await assert.rejects(() => p.call('apply', input, { fault: point => { if (point === 'after-file-0') throw new Error('fixture fault'); } }), /fixture fault/);
  const interrupted = await p.inspect(); assert.equal(interrupted.phase, 'applying'); assert.deepEqual(interrupted.recovery, input);
  await p.put('src/a.js', 'third image\n');
  await assert.rejects(() => p.call('apply', input), { code: 'integration-recovery-conflict' });
  assert.equal(await p.get('src/a.js'), 'third image\n');
  await p.put('src/a.js', 'module.exports = () => 2;\n');
  const applied = await p.call('apply', input); assert.equal(applied.phase, 'pending');
  const rejectInput = p.mutation(applied.version, { task_id: w.task_id, reason: 'Combined behavior rejected by parent' });
  await assert.rejects(() => p.call('reject', rejectInput, { fault: point => { if (point === 'after-file-0') throw new Error('rollback fault'); } }), /rollback fault/);
  const rejected = await p.call('reject', rejectInput); assert.equal(rejected.assignments[0].status, 'rejected');
  assert.equal(await p.get('src/a.js'), 'module.exports = () => 1;\n');
  const replay = await p.call('apply', input); assert.equal(replay.historical, true);
  assert.equal(await p.get('src/a.js'), 'module.exports = () => 1;\n');
});

test('stale evidence and unrelated parent edits stop integration; accumulated evidence supports mixed closure', async t => {
  const p = await project(t, { preflightCount: 100 }); await p.call('start', p.start);
  const w = p.workers[0], result = await p.finish(w, 2);
  const evidence = path.join(w.root, trace(`worker-${w.task_id}`)), saved = await readFile(evidence);
  await writeFile(evidence, 'changed evidence'); await assert.rejects(() => p.apply(w, result), { code: 'stale-evidence' }); await writeFile(evidence, saved);
  await p.put('outside.txt', 'concurrent user edit\n'); await assert.rejects(() => p.apply(w, result), { code: 'stale-integration-tree' });
  assert.equal(await p.get('src/a.js'), 'module.exports = () => 1;\n'); await p.put('outside.txt', 'pre-existing dirty data\n');
  const applied = await p.apply(w, result), verification = await p.verification('combined', ['src/a.js'], 2, 1);
  verification.checks[0].exit_code = 1;
  await assert.rejects(() => p.call('accept', p.mutation(applied.version, { task_id: w.task_id, verification })), { code: 'failed-completion-check' });
  assert.equal((await p.inspect()).phase, 'pending');
  verification.checks[0].exit_code = 0;
  const accepted = await p.call('accept', p.mutation(applied.version, { task_id: w.task_id, verification }));
  const checked = await p.get(trace('combined'));
  await p.put(trace('combined'), 'rewritten check');
  await assert.rejects(() => p.call('resume', { change_id: p.id, group_id: 'wave-1' }), { code: 'stale-isolation-evidence' });
  await p.put(trace('combined'), checked);
  const other = p.workers[1];
  await mkdir(path.dirname(path.join(other.root, trace('stopped'))), { recursive: true });
  await writeFile(path.join(other.root, trace('stopped')), 'Test-owned worker was never dispatched; no child process exists.\n');
  await executionCommand('interrupt', { change_id: p.id, run_id: other.run_id, actor: 'parent', version: 1, recovery_id: 'stop-unused', reason: 'cancelled', execution_state: 'stopped', evidence: [trace('stopped')] }, { rootDir: other.root });
  await p.put(trace('stop-unused'), 'Observed test-owned unused worker retirement.\n');
  const retired = await p.call('retire', p.mutation(accepted.version, { task_id: other.task_id, reason: 'cancelled', stop_evidence: [trace('stop-unused')] }));
  const closed = await p.call('close', p.mutation(retired.version, { verification: await p.verification('partial-final', ['src/a.js'], 2, 1) }));
  assert.deepEqual(closed.closure.accepted, ['1.1']); assert.deepEqual(closed.closure.unfinished, ['1.2']);
  assert.match(await p.get('openspec/changes/work/tasks.md'), /\[ \] 1\.2/);
});

test('abandon preserves partial code and stops late output after source drift; no completion authority', async t => {
  const p = await project(t); await p.call('start', p.start); const w = p.workers[0], result = await p.finish(w, 2);
  const input = p.mutation(1, { task_id: w.task_id, result_digest: result, stop_evidence: [trace(`stop-${w.task_id}`)] });
  await assert.rejects(() => p.call('apply', input, { fault: point => { if (point === 'after-file-0') throw new Error('fixture fault'); } }), /fixture fault/);
  await p.put('.ai-factory/config.yaml', 'aifhub:\n  tools:\n    openspec: false\n');
  await p.put(trace('stop-all'), 'Both fixture worker functions and all child checks have exited.\n');
  const abandoned = await p.call('abandon', p.mutation((await p.inspect()).version, { reason: 'source changed', stop_evidence: [trace('stop-all')] }));
  assert.equal(abandoned.phase, 'abandoned'); assert.equal(abandoned.closure, null);
  assert.equal(await p.get('src/a.js'), 'module.exports = () => 2;\n');
  await assert.rejects(() => p.call('apply', input), { code: 'version-conflict' });
  await assert.rejects(() => p.call('resume', { change_id: p.id, group_id: 'wave-1' }), { code: 'isolation-abandoned' });
  await p.put('.ai-factory/config.yaml', 'aifhub:\n  artifactProtocol: ai-factory\n');
  const tasks = '- [ ] 1.1 First task\n- [ ] 1.2 Second task\n';
  await p.put('.ai-factory/plans/work.md', '# Plan\n'+tasks);
  for (const [name, data] of Object.entries({ 'task.md': tasks, 'context.md': '# Context\n', 'rules.md': '# Rules\n', 'verify.md': '# Verify\n', 'status.yaml': 'status: planned\nplan_id: work\n' })) await p.put(`.ai-factory/plans/work/${name}`, data);
  await assert.rejects(() => executionCommand('start', { change_id: p.id, run_id: 'different-source', task_id: '1.1', owner: 'parent', worker: 'new-worker', role: 'implement', scope: ['src/a.js'] }, { rootDir: p.root }), { code: 'state-source-collision' });
  await assert.rejects(() => executionCommand('batch-start', { change_id: p.id, run_id: 'different-source', owner: 'parent', worker: 'new-worker', role: 'implement', preflight_paths: [trace('preflight')], manifest: p.workers.map(w => ({ task_id: w.task_id, files: w.files, expected_change: 'Change the export', check: 'fixture export', dependencies: [] })) }, { rootDir: p.root }), { code: 'state-source-collision' });
});

test('admission refuses intra-wave dependencies, reused roots and mismatched worker scopes before saving a group', async t => {
  const p = await project(t);
  const dependent = structuredClone(p.start); dependent.assignments[1].dependencies = ['1.1'];
  await assert.rejects(() => p.call('start', dependent), { code: 'dependent-items' });
  const reused = structuredClone(p.start); reused.assignments[1].root = reused.assignments[0].root;
  await assert.rejects(() => p.call('start', reused), { code: 'duplicate-isolated-assignment' });
  const mismatched = structuredClone(p.start); mismatched.assignments[0].files = ['outside.txt'];
  await assert.rejects(() => p.call('start', mismatched), { code: 'worker-assignment-mismatch' });
  await assert.rejects(() => p.inspect(), { code: 'missing-isolation-group' });
});

test('multi-file partial transfer restores tracked deletion, binary creation and executable mode; corrupt journal cannot authorize it', async t => {
  const p = await project(t, { initial: { 'src/old.txt': 'tracked original\n', 'src/run.sh': 'original script\n' }, scopes: [['src/a.js', 'src/new.bin', 'src/old.txt', 'src/run.sh'], ['src/b.js']] });
  await p.call('start', p.start); const w = p.workers[0], binary = Buffer.from([0, 255, 13, 10, 128]);
  const result = await p.finish(w, 2, { 'src/a.js': 'module.exports = () => 2;\n', 'src/new.bin': binary, 'src/old.txt': null, 'src/run.sh': 'new script\n' }, async () => {
    if (process.platform !== 'win32') await chmod(path.join(w.root, 'src/run.sh'), 0o755);
  });
  const input = p.mutation(1, { task_id: w.task_id, result_digest: result, stop_evidence: [trace(`stop-${w.task_id}`)] });
  await assert.rejects(() => p.call('apply', input, { fault: point => { if (point === 'after-file-1') throw new Error('partial transfer'); } }), /partial transfer/);
  assert.equal(await p.get('src/a.js'), 'module.exports = () => 2;\n');
  assert.deepEqual(await readFile(path.join(p.root, 'src/new.bin')), binary);
  assert.equal(await p.get('src/old.txt'), 'tracked original\n');
  assert.equal(await p.get('src/run.sh'), 'original script\n');
  const store = await storeFor(p.root), filename = '.ai-factory/state/work/execution/isolation/wave-1.json', saved = await store.load(filename);
  const corrupt = structuredClone(saved); corrupt.events[0].images[0].after.data = Buffer.from('forged').toString('base64');
  await store.save(filename, corrupt);
  await assert.rejects(() => p.call('apply', input), { code: 'invalid-transfer-result' });
  assert.equal(await p.get('src/old.txt'), 'tracked original\n'); await store.save(filename, saved);
  const applied = await p.call('apply', input); assert.equal(applied.phase, 'pending');
  await assert.rejects(() => p.get('src/old.txt'), { code: 'ENOENT' });
  assert.deepEqual(await readFile(path.join(p.root, 'src/new.bin')), binary);
  if (process.platform !== 'win32') assert.equal((await lstat(path.join(p.root, 'src/run.sh'))).mode & 0o111, 0o111);
  const reject = p.mutation(applied.version, { task_id: w.task_id, reason: 'fixture rejection' });
  await assert.rejects(() => p.call('reject', reject, { fault: point => { if (point === 'after-file-1') throw new Error('partial rollback'); } }), /partial rollback/);
  await p.call('reject', reject);
  assert.equal(await p.get('src/old.txt'), 'tracked original\n');
  assert.equal(await p.get('src/run.sh'), 'original script\n');
  await assert.rejects(() => p.get('src/new.bin'), { code: 'ENOENT' });
  assert.equal(await p.get('outside.txt'), 'pre-existing dirty data\n');
  assert.equal((await p.call('resume', { change_id: p.id, group_id: 'wave-1' })).phase, 'active');
});

test('competing integrations have one winner and an orphan lock grants no retry permission', async t => {
  const p = await project(t); await p.call('start', p.start);
  const results = await Promise.allSettled(p.workers.map((w, i) => p.finish(w, i + 2)));
  for (const r of results) assert.equal(r.status, 'fulfilled', String(r.reason));
  const inputs = p.workers.map((w, i) => p.mutation(1, { task_id: w.task_id, result_digest: results[i].value, stop_evidence: [trace(`stop-${w.task_id}`)] }));
  await p.put('.ai-factory/state/execution-write.lock', 'orphan fixture lock');
  await assert.rejects(() => p.call('apply', inputs[0]), { code: 'state-locked' });
  assert.equal(await p.get('.ai-factory/state/execution-write.lock'), 'orphan fixture lock');
  await rm(path.join(p.root, '.ai-factory/state/execution-write.lock')); // Test owns this injected lock; no helper reclaimed it.
  const raced = await Promise.allSettled(inputs.map(input => p.call('apply', input)));
  assert.equal(raced.filter(r => r.status === 'fulfilled').length, 1);
  for (const r of raced.filter(r => r.status === 'rejected')) assert.ok(['state-locked', 'version-conflict'].includes(r.reason.code));
  const winner = raced.findIndex(r => r.status === 'fulfilled');
  assert.equal(await p.get('src/a.js'), `module.exports = () => ${winner === 0 ? 2 : 1};\n`);
  assert.equal(await p.get('src/b.js'), `module.exports = () => ${winner === 1 ? 3 : 1};\n`);
});

test('CLI classifies ultra and handles read-only/error actions without local state or worker access', async t => {
  const p = await executionProject(); t.after(p.cleanup);
  async function cli(action, input) {
    const child = exec(process.execPath, [fileURLToPath(new URL('./execution-state.mjs', import.meta.url)), action, '--json'], { cwd: p.root, windowsHide: true });
    child.child.stdin.end(JSON.stringify(input));
    try { const result = await child; return { ...result, code: 0 }; }
    catch (error) { return error; }
  }
  const before = await p.snapshot();
  const missing = await cli('isolation-inspect', { change_id: 'work', group_id: 'missing' });
  assert.equal(missing.code, 2); assert.equal(missing.stderr, '');
  assert.deepEqual(JSON.parse(missing.stdout), { ok: false, code: 'missing-isolation-group' });
  assert.deepEqual(await p.snapshot(), before);
  await p.put('.ai-factory/config.yaml', 'aifhub:\n  tools:\n    openspec: false\n');
  const index = '<!-- aif:plan-mode:ultra -->\n\n# Plan\n\n## Phase Index\n\n1. [Phase 01](phase-01-work.md)\n\n## Tasks\n\n- [ ] **Task 1:** Work.\n';
  await p.put('.ai-factory/plans/work/index.md', index);
  await p.put('.ai-factory/plans/work/phase-01-work.md', '# Phase 01\n\n## Task 1: Work\n\nDetail.\n');
  const ultraBefore = await p.snapshot();
  const input = { change_id: 'work', group_id: 'wave-1', owner: 'parent', assignments: [{ task_id: '1', run_id: 'not-created', root: path.join(p.root, 'not-created'), worker: 'worker', files: ['src/a.js'], dependencies: [] }], preflight_paths: [trace('not-created')] };
  for (const action of ['isolation-preflight', 'isolation-start']) {
    const delegated = await cli(action, input);
    assert.equal(delegated.code, 0, delegated.stdout); assert.equal(delegated.stderr, '');
    assert.deepEqual(JSON.parse(delegated.stdout), { ok: true, delegated: true, handoff: '/aif-implement .ai-factory/plans/work/index.md' });
    assert.deepEqual(await p.snapshot(), ultraBefore);
  }
  await p.put('.ai-factory/plans/work.md', '# Collision\n');
  const collisionBefore = await p.snapshot(), collision = await cli('isolation-start', input);
  assert.equal(JSON.parse(collision.stdout).code, 'plan-integrity-error');
  assert.deepEqual(await p.snapshot(), collisionBefore);
});

test('preflight checks prepared worktrees without creating runs, locks or state; a ready preview cannot authorize later drift', async t => {
  const p = await project(t, { admitWorkers: false });
  const before = await p.snapshot(), workerFiles = await Promise.all(p.workers.map(w => readdir(path.join(w.root, '.ai-factory'), { recursive: true })));
  const preview = await p.call('preflight', p.start);
  assert.equal(preview.ready, true); assert.equal(preview.admitted, false); assert.equal(preview.assignments.length, 2);
  assert.deepEqual(await p.snapshot(), before);
  for (let i = 0; i < p.workers.length; i++) assert.deepEqual(await readdir(path.join(p.workers[i].root, '.ai-factory'), { recursive: true }), workerFiles[i]);
  for (const w of p.workers) await executionCommand('start', { change_id: p.id, run_id: w.run_id, task_id: w.task_id, owner: 'parent', worker: w.worker, role: 'implement', scope: w.files }, { rootDir: w.root });
  await p.put('outside.txt', 'changed after preview\n');
  await assert.rejects(() => p.call('start', p.start), { code: 'worker-baseline-mismatch' });
  await assert.rejects(() => p.inspect(), { code: 'missing-isolation-group' });
});

test('preflight rejects dirty/context drift, index changes and orphan worker locks without mutating either checkout', async t => {
  const p = await project(t, { admitWorkers: false }), w = p.workers[0];
  async function refused(code) {
    const parent = await p.snapshot(), store = await storeFor(w.root), state = await store.inventory('.ai-factory');
    await assert.rejects(() => p.call('preflight', p.start), { code });
    assert.deepEqual(await p.snapshot(), parent); assert.deepEqual(await store.inventory('.ai-factory'), state);
  }
  await writeFile(path.join(w.root, 'outside.txt'), 'mismatched dirty data\n'); await refused('worker-baseline-mismatch');
  await writeFile(path.join(w.root, 'outside.txt'), 'pre-existing dirty data\n');
  const configPath = path.join(w.root, '.ai-factory/config.yaml'), config = await readFile(configPath);
  await writeFile(configPath, Buffer.concat([config, Buffer.from('# changed context\n')])); await refused('worker-context-mismatch'); await writeFile(configPath, config);
  await exec('git', ['add', 'outside.txt'], { cwd: w.root, windowsHide: true }); await refused('worker-baseline-mismatch');
  await exec('git', ['restore', '--staged', 'outside.txt'], { cwd: w.root, windowsHide: true }); // This test owns the entire fixture index.
  const lock = path.join(w.root, '.ai-factory/state/execution-write.lock'); await mkdir(path.dirname(lock), { recursive: true }); await writeFile(lock, 'test-owned orphan');
  await refused('state-locked'); assert.equal(await readFile(lock, 'utf8'), 'test-owned orphan');
  await rm(lock); assert.equal((await p.call('preflight', p.start)).ready, true);
});
