import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile, cp, link, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { executionCommand } from './execution-state.mjs';
import { evolutionCommand } from './evolution-transactions.mjs';
import { storeFor } from './workflow-state-store.mjs';

const exec = promisify(execFile);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let root;
const change = 'add-widget';
const runInput = { change_id: change, run_id: 'worker-1' };
const trace = `.ai-factory/state/${change}/implementation/check.md`;
const startInput = { ...runInput, task_id: '1.1', owner: 'parent', worker: 'worker', role: 'implement', scope: ['src'] };
const worker = (version = 1) => ({ ...runInput, actor: 'worker', version });
const call = (action, input) => executionCommand(action, input, { rootDir: root });
const evolve = (action, input) => evolutionCommand(action, input, { rootDir: root });
const fails = (promise, code) => assert.rejects(promise, error => error.code === code);
async function put(relative, value) { await mkdir(path.dirname(path.join(root, relative)), { recursive: true }); await writeFile(path.join(root, relative), value); }
const git = (...args) => exec('git', args, { cwd: root, windowsHide: true });
const completed = () => ({ result_id: 'result-1', status: 'completed', changed_files: ['src/main.js'], checks: [{ name: 'focused-check', exit_code: 0 }], evidence: [trace] });
async function finish(result = completed()) {
  await put('src/main.js', 'fixed\n'); await put(trace, 'Observed focused-check: exit 0.\n');
  return call('result', { ...worker(), result });
}
async function retireRun(run_id = runInput.run_id) {
  const saved = await call('inspect', { change_id: change, run_id });
  const stop = `.ai-factory/state/${change}/implementation/stop.md`;
  await put(stop, 'Fixture-owned execution has stopped.\n');
  await call('interrupt', { change_id: change, run_id, actor: 'parent', version: saved.version,
    recovery_id: `retire-${run_id}`, reason: 'abandoned', execution_state: 'stopped', evidence: [stop] });
}
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'aifhub-workflow-'));
  await put('.gitignore', '.ai-factory/\nignored/\n');
  await put('src/main.js', 'initial\n'); await put('outside.txt', 'keep\n');
  await put(`openspec/changes/${change}/tasks.md`, '- [ ] 1.1 Implement widget\n- [ ] 1.2 Test widget\n');
  await put(`openspec/changes/${change}/proposal.md`, '# Widget\n');
  await put('.ai-factory/config.yaml', 'aifhub:\n  artifactProtocol: openspec\n');
  await git('init', '-q'); await git('add', '.');
  await git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture');
});
afterEach(async () => { await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); });

describe('revision-bound execution and parent acceptance', () => {
  it('resumes a persisted checkpoint and separates completion from acceptance without writing QA or tasks', async () => {
    await put('outside.txt', 'preexisting user edit\n');
    const tasksBefore = await readFile(path.join(root, `openspec/changes/${change}/tasks.md`));
    assert.equal((await call('start', startInput)).status, 'started');
    await put('src/main.js', 'work in progress\n');
    await fails(call('resume', runInput), 'stale-checkpoint');
    const saved = await call('checkpoint', { ...worker(), progress: { completed_steps: ['Implemented widget'], next_step: 'Run focused test' } });
    assert.equal(saved.version, 2);
    assert.equal((await call('resume', runInput)).progress.next_step, 'Run focused test');
    await put(trace, 'Observed check passed\n');
    const result = await call('result', { ...worker(2), result: completed() });
    assert.equal(result.status, 'completed'); assert.equal(result.accepted_by, null);
    await fails(call('accept', { ...worker(3), result_digest: result.result.digest }), 'actor-mismatch');
    const accepted = await call('accept', { ...runInput, actor: 'parent', version: 3, result_digest: result.result.digest });
    assert.equal(accepted.status, 'accepted'); assert.equal((await call('resume', runInput)).resumable, false);
    assert.deepEqual(await readFile(path.join(root, `openspec/changes/${change}/tasks.md`)), tasksBefore);
    await assert.rejects(readFile(path.join(root, `.ai-factory/qa/${change}/verify.md`)), { code: 'ENOENT' });
    assert.equal(await readFile(path.join(root, 'outside.txt'), 'utf8'), 'preexisting user edit\n');
  });
  it('binds dirty and untracked content, task text, generated rules, and QA inventory', async () => {
    await call('start', startInput);
    await put('src/new.js', 'new\n'); await fails(call('resume', runInput), 'stale-checkpoint');
    await rm(path.join(root, 'src/new.js'));
    for (const relative of [`openspec/changes/${change}/tasks.md`, '.ai-factory/rules/generated/new.md', `.ai-factory/qa/${change}/verify.md`]) {
      const old = await readFile(path.join(root, relative)).catch(() => null);
      await put(relative, 'changed\n'); await fails(call('resume', runInput), 'stale-context');
      if (old === null) await rm(path.join(root, relative)); else await put(relative, old);
    }
    assert.equal((await call('resume', runInput)).resumable, true);
  });
  it('binds HEAD and index even when file content is unchanged', async () => {
    await call('start', startInput);
    await git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-qm', 'next');
    await fails(call('resume', runInput), 'stale-revision');
    await retireRun();
    await call('start', { ...startInput, run_id: 'worker-2' });
    await put('src/main.js', 'staged\n'); await git('add', 'src/main.js');
    await fails(call('resume', { ...runInput, run_id: 'worker-2' }), 'stale-revision');
  });
  it('requires exact changed files, scoped writes, current versions, and matching parent receipt', async () => {
    await call('start', startInput);
    await fails(call('checkpoint', { ...worker(2), progress: { completed_steps: [], next_step: 'Continue' } }), 'version-conflict');
    await put('outside.txt', 'unauthorized\n'); await fails(finish(), 'outside-scope');
    await put('outside.txt', 'keep\n');
    await fails(call('result', { ...worker(), result: { ...completed(), changed_files: [] } }), 'changed-files-mismatch');
    const result = await finish();
    await fails(call('accept', { ...runInput, actor: 'parent', version: 2, result_digest: 'wrong' }), 'result-mismatch');
    await put(trace, 'new evidence\n');
    await fails(call('accept', { ...runInput, actor: 'parent', version: 2, result_digest: result.result.digest }), 'stale-evidence');
  });
  it('accepts an exact delivery replay and rejects duplicate replacement and stale results', async () => {
    await call('start', startInput); const receipt = await finish();
    assert.equal((await call('result', { ...worker(), result: completed() })).replay, true);
    await fails(call('result', { ...worker(), result: { ...completed(), summary: 'replacement' } }), 'conflicting-result');
    await put('src/main.js', 'later user change\n');
    await fails(call('accept', { ...runInput, actor: 'parent', version: 2, result_digest: receipt.result.digest }), 'stale-result');
  });
  it('keeps failed, blocked, cancelled and timed-out results terminal and unaccepted', async () => {
    for (const status of ['failed', 'blocked', 'cancelled', 'timed_out']) {
      const id = `run-${status}`;
      await call('start', { ...startInput, run_id: id });
      await call('result', { ...worker(), run_id: id, result: { result_id: id, status, changed_files: [], checks: [], evidence: [] } });
      await fails(call('accept', { ...runInput, run_id: id, actor: 'parent', version: 2, result_digest: 'none' }), 'result-not-completed');
      await retireRun(id);
    }
  });
  it('requires a real task outside code fences and never creates state on a missing resume', async () => {
    await fails(call('resume', runInput), 'missing-or-invalid-run');
    await assert.rejects(lstat(path.join(root, '.ai-factory/state')), { code: 'ENOENT' });
    await assert.rejects(readFile(path.join(root, `.ai-factory/state/${change}/execution/write.lock`)), { code: 'ENOENT' });
    await put(`openspec/changes/${change}/tasks.md`, '```md\n- [ ] 1.1 Fake task\n```\n');
    await fails(call('start', startInput), 'unknown-or-ambiguous-task');
    await put(`openspec/changes/${change}/tasks.md`, '- [ ] 1.1 `widget()`\n- [ ] `secondTask()`\n');
    await call('start', startInput);
    await retireRun();
    await call('start', { ...startInput, run_id: 'unnumbered', task_id: 'task-2' });
  });
  it('includes ignored files inside explicitly assigned scope', async () => {
    await put('ignored/input.txt', 'one');
    await call('start', { ...startInput, scope: ['ignored'] });
    await put('ignored/input.txt', 'two'); await fails(call('resume', runInput), 'stale-checkpoint');
  });
  it('tracks prototype-like filenames as ordinary worktree inputs', async () => {
    await put('__proto__', 'first');
    await call('start', { ...startInput, scope: ['__proto__'] });
    await put('__proto__', 'second');
    await fails(call('resume', runInput), 'stale-checkpoint');
    await call('checkpoint', { ...worker(), progress: { completed_steps: ['Updated input'], next_step: 'Check' } });
    assert.equal((await call('resume', runInput)).resumable, true);
  });
  it('fails closed on lock contention, corrupted records, and protected scope', async () => {
    await fails(call('start', { ...startInput, scope: ['.ai-factory/qa'] }), 'protected-scope');
    await call('start', startInput);
    await put(`.ai-factory/state/${change}/execution/write.lock`, 'other writer');
    await fails(call('checkpoint', { ...worker(), progress: { completed_steps: [], next_step: 'Continue' } }), 'state-locked');
    await put(`.ai-factory/state/${change}/execution/runs/worker-1.json`, '{"checksum":"wrong","record":{"status":"accepted"}}');
    await fails(call('resume', runInput), 'invalid-state');
  });
});

describe('persistent no-progress guard', () => {
  const begin = (extra = {}) => call('attempt-begin', { ...worker(), finding_id: 'QA-1', hypothesis: 'Widget needs a boundary check', check: 'focused-check', environment_revision: 'fixture-runtime-1', input_paths: [], ...extra });
  const end = (attempt, outcome = 'failed') => call('attempt-finish', { ...worker(), attempt_id: attempt.attempt_id, outcome, evidence: [trace] });
  it('blocks pending and failed identical inputs across new sessions and runs, then permits a changed input', async () => {
    await call('start', { ...startInput, role: 'fix' }); await put(trace, 'Observed assertion failure\n');
    const attempt = await begin(); await fails(begin(), 'no-progress');
    await end(attempt); assert.equal((await end(attempt)).replay, true);
    await fails(begin({ hypothesis: 'Different wording' }), 'no-progress');
    await retireRun();
    await call('start', { ...startInput, role: 'fix', run_id: 'second-session' });
    await fails(begin({ run_id: 'second-session' }), 'no-progress');
    await put('src/main.js', 'new experiment\n');
    assert.equal((await begin({ run_id: 'second-session' })).outcome, 'pending');
  });
  it('stops after three failed hypotheses even with successive code changes', async () => {
    await call('start', { ...startInput, role: 'fix' }); await put(trace, 'Observed failed experiment\n');
    for (let i = 0; i < 3; i++) { await put('src/main.js', `experiment-${i}\n`); await end(await begin()); }
    await fails(call('attempt-check', { ...worker(), finding_id: 'QA-1', hypothesis: 'Fourth hypothesis', check: 'focused-check', environment_revision: 'fixture-runtime-1', input_paths: [] }), 'attempt-budget-exhausted');
    assert.equal(await readFile(path.join(root, 'src/main.js'), 'utf8'), 'experiment-2\n');
    await put('src/main.js', 'fourth experiment\n'); await fails(begin(), 'attempt-budget-exhausted');
    assert.equal((await begin({ environment_revision: 'independently-updated-fixture-runtime-2' })).outcome, 'pending');
  });
  it('prevents a terminal worker response from stranding its pending check', async () => {
    await call('start', { ...startInput, role: 'fix' });
    await begin();
    await fails(call('result', { ...worker(), result: { result_id: 'premature', status: 'blocked', changed_files: [], checks: [], evidence: [] } }), 'pending-attempt');
  });
  it('rejects results measured against changed files or external input references', async () => {
    await call('start', { ...startInput, role: 'fix' }); await put(trace, 'Observed experiment\n');
    await put('ignored/input.txt', 'fixture-1');
    const attempt = await begin({ input_paths: ['ignored/input.txt'] });
    await put('ignored/input.txt', 'fixture-2'); await fails(end(attempt, 'passed'), 'stale-attempt');
    await put('ignored/input.txt', 'fixture-1'); await put('src/main.js', 'different code');
    await fails(end(attempt, 'passed'), 'stale-attempt');
  });
});

describe('versioned skill-context transactions', () => {
  const target = '.ai-factory/skill-context/aif-fix/SKILL.md';
  const proposal = () => ({ transaction_id: 'evolution-1', skill: 'aif-fix', after: '# Better rule\n', reason: 'Repeated focused-check failures', evidence: [trace] });
  const ref = value => ({ transaction_id: value.transaction_id, proposal_digest: value.proposal_digest });
  beforeEach(async () => { await put(trace, 'Two failures with unchanged inputs.\n'); });
  it('shows a reviewable diff without applying, persists evidence, applies once and restores the exact previous text', async () => {
    await put(target, '# Original rule\n'); const value = await evolve('propose', proposal());
    assert.equal(await readFile(path.join(root, target), 'utf8'), '# Original rule\n');
    assert.match(value.diff, /-# Original rule\n\+# Better rule/);
    assert.equal((await evolve('show', { transaction_id: value.transaction_id })).proposal_digest, value.proposal_digest);
    assert.equal((await evolve('apply', ref(value))).status, 'applied');
    assert.equal((await evolve('apply', ref(value))).replay, true);
    assert.equal(await readFile(path.join(root, target), 'utf8'), '# Better rule\n');
    assert.equal((await evolve('rollback', ref(value))).status, 'rolled_back');
    assert.equal(await readFile(path.join(root, target), 'utf8'), '# Original rule\n');
  });
  it('restores absence and deletion exactly', async () => {
    const creation = await evolve('propose', proposal()); await evolve('apply', ref(creation)); await evolve('rollback', ref(creation));
    await assert.rejects(readFile(path.join(root, target)), { code: 'ENOENT' });
    await put(target, '\uFEFForiginal without newline');
    const deletion = await evolve('propose', { ...proposal(), transaction_id: 'delete-1', after: null });
    await evolve('apply', ref(deletion)); await evolve('rollback', ref(deletion));
    assert.equal(await readFile(path.join(root, target), 'utf8'), '\uFEFForiginal without newline');
  });
  it('rejects stale evidence, wrong approval digest, and concurrent edits before applying', async () => {
    const value = await evolve('propose', proposal());
    await fails(evolve('apply', { ...ref(value), proposal_digest: 'wrong' }), 'proposal-mismatch');
    await put(trace, 'new evidence'); await fails(evolve('apply', ref(value)), 'stale-evidence');
    await put(target, 'concurrent user edit'); await fails(evolve('apply', ref(value)), 'target-conflict');
    assert.equal(await readFile(path.join(root, target), 'utf8'), 'concurrent user edit');
  });
  it('never rolls back across a later accepted evolution', async () => {
    const first = await evolve('propose', proposal()); await evolve('apply', ref(first));
    const second = await evolve('propose', { ...proposal(), transaction_id: 'evolution-2', after: 'newer rule' });
    await evolve('apply', ref(second)); await fails(evolve('rollback', ref(first)), 'target-conflict');
    await evolve('rollback', ref(second)); await evolve('rollback', ref(first));
  });
  it('recovers interrupted apply and rollback on either side of the target write', async () => {
    await put(target, 'before'); const value = await evolve('propose', proposal()); const store = await storeFor(root);
    const filename = '.ai-factory/evolutions/transactions/evolution-1.json';
    let state = await store.load(filename); state.status = 'applying'; await store.save(filename, state);
    assert.equal((await evolve('apply', ref(value))).status, 'applied');
    state = await store.load(filename); state.status = 'applying'; await store.save(filename, state);
    assert.equal((await evolve('apply', ref(value))).recovered, true);
    state.status = 'rolling_back'; await store.save(filename, state);
    assert.equal((await evolve('rollback', ref(value))).status, 'rolled_back');
    state.status = 'rolling_back'; await store.save(filename, state);
    assert.equal((await evolve('rollback', ref(value))).recovered, true);
  });
  it('rejects traversal, symlinked directories, hardlinks, and base-skill targets', async () => {
    await fails(evolve('propose', { ...proposal(), skill: '../aif-fix' }), 'invalid-skill');
    await fails(evolve('propose', { ...proposal(), target: 'skills/aif-fix/SKILL.md' }), 'invalid-input');
    await fails(evolve('propose', { ...proposal(), evidence: ['../outside'] }), 'unsafe-path');
    await mkdir(path.join(root, 'linked-context'));
    await symlink(path.join(root, 'linked-context'), path.join(root, '.ai-factory/skill-context'), process.platform === 'win32' ? 'junction' : 'dir');
    await fails(evolve('propose', proposal()), 'unsafe-filesystem-entry');
    await rm(path.join(root, '.ai-factory/skill-context'));
    await mkdir(path.dirname(path.join(root, target)), { recursive: true });
    await link(path.join(root, 'outside.txt'), path.join(root, target));
    await fails(evolve('propose', proposal()), 'unsafe-filesystem-entry');
    assert.equal(await readFile(path.join(root, 'outside.txt'), 'utf8'), 'keep\n');
  });
});

async function runCli(script, action, input, extra = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, action, '--json', ...extra], { cwd: root, windowsHide: true });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject); child.on('close', code => resolve({ code, stdout, stderr }));
    child.stdin.on('error', () => {}); child.stdin.end(typeof input === 'string' ? input : JSON.stringify(input));
  });
}
describe('installed consumer CLI', () => {
  it('runs both real modules through installed wrappers with inherited JSON stdin and consumer cwd', async () => {
    const installation = '.ai-factory/extensions/aifhub-extension';
    // Install the real dependency closure, including the canonical source resolvers.
    await cp(path.join(repo, 'scripts'), path.join(root, installation, 'scripts'), { recursive: true });
    for (const file of ['commands/run-installed-script.mjs', 'commands/aifhub-execution.mjs', 'commands/aifhub-evolution.mjs', 'scripts/execution-state.mjs', 'scripts/evolution-transactions.mjs', 'scripts/workflow-state-store.mjs', 'scripts/markdown-structural-markers.mjs']) {
      await mkdir(path.dirname(path.join(root, installation, file)), { recursive: true });
      await copyFile(path.join(repo, file), path.join(root, installation, file));
    }
    const harness = `${installation}/harness.mjs`;
    await put(harness, `
      const kind = process.argv.splice(2, 1)[0];
      const { register } = await import('./commands/aifhub-' + kind + '.mjs');
      let handler;
      const chain = { description(){return this}, allowUnknownOption(){return this}, allowExcessArguments(){return this}, argument(){return this}, action(fn){handler=fn;return this} };
      register({command(){return chain}}); await handler(process.argv.slice(2));
    `);
    const runWrapper = async (kind, action, input) => {
      // runCli puts its second argument before --json; use a tiny wrapper entry per command.
      const entry = `${installation}/${kind}-entry.mjs`;
      await put(entry, `process.argv.splice(2, 0, '${kind}'); await import('./harness.mjs');`);
      return runCli(path.join(root, entry), action, input);
    };
    const started = await runWrapper('execution', 'start', startInput);
    assert.equal(started.code, 0, started.stdout + started.stderr); assert.equal(JSON.parse(started.stdout).status, 'started');
    await put(trace, 'Observed result\n');
    const proposed = await runWrapper('evolution', 'propose', { transaction_id: 'installed', skill: 'aif-fix', after: 'rule', reason: 'finding', evidence: [trace] });
    assert.equal(proposed.code, 0, proposed.stdout + proposed.stderr); assert.equal(JSON.parse(proposed.stdout).status, 'proposed');
    assert.equal(started.stderr + proposed.stderr, '');
    const stale = await runWrapper('execution', 'resume', runInput);
    assert.equal(stale.code, 0, stale.stdout); // Proposal metadata does not mutate execution inputs.
    await put('src/main.js', 'later edit');
    const blocked = await runWrapper('execution', 'resume', runInput);
    assert.equal(blocked.code, 1); assert.equal(JSON.parse(blocked.stdout).code, 'stale-checkpoint');
  });
  it('returns one safe JSON envelope, exact exit codes, and empty stderr for hostile or malformed input', async () => {
    const script = path.join(repo, 'scripts/execution-state.mjs');
    for (const [action, input, extra, expected] of [
      ['start', '{"secret-canary":', [], 'invalid-json'],
      ['resume', { change_id: '../secret-canary', run_id: 'id' }, [], 'invalid-change-id'],
      ['resume', runInput, ['--secret-canary'], 'invalid-arguments'],
      ['unknown-secret-canary', {}, [], 'unknown-action'],
    ]) {
      const result = await runCli(script, action, input, extra);
      assert.equal(result.code, 2); assert.equal(result.stderr, '');
      assert.deepEqual(JSON.parse(result.stdout), { ok: false, code: expected });
      assert.doesNotMatch(result.stdout, /secret-canary/);
    }
  });
});
