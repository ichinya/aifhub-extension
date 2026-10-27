import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { git, manifest, put, sha256 } from './fixture.mjs';

export const ENTRYPOINTS = ['scripts/workflow-state-store.mjs', 'scripts/execution-state.mjs', 'scripts/isolated-execution.mjs'];
export async function moduleHashes(root) {
  const files = new Map();
  async function visit(name) {
    if (files.has(name)) return;
    if (!name.startsWith('scripts/') || name.includes('..')) throw new Error('unsafe-module-closure');
    const bytes = await fs.readFile(path.join(root, name)), text = bytes.toString('utf8'); files.set(name, sha256(bytes));
    for (const match of text.matchAll(/['"](\.\.?\/[^'"\n]+\.mjs)['"]/g)) {
      const relative = path.posix.normalize(path.posix.join(path.posix.dirname(name), match[1]));
      await visit(relative);
    }
  }
  for (const entry of ENTRYPOINTS) await visit(entry);
  return Object.fromEntries([...files].sort(([a], [b]) => a.localeCompare(b)));
}
export function validateIdentity(identity) {
  return identity && /^[a-f0-9]{40}$/.test(identity.commit) && ['committed', 'working-tree'].includes(identity.source)
    && identity.modules && ENTRYPOINTS.every(p => Object.hasOwn(identity.modules, p))
    && Object.entries(identity.modules).every(([p, h]) => /^scripts\/[a-zA-Z0-9_./-]+\.mjs$/.test(p) && !p.includes('..') && /^[a-f0-9]{64}$/.test(h));
}
export async function verifyIdentity(root, identity, env) {
  if (!validateIdentity(identity)) throw new Error('invalid-arm-identity');
  const commit = await git(root, env, 'rev-parse', 'HEAD');
  if (commit !== identity.commit || JSON.stringify(await moduleHashes(root)) !== JSON.stringify(identity.modules)) throw new Error('arm-identity-mismatch');
  if (identity.source === 'committed') {
    for (const [name, hash] of Object.entries(identity.modules)) {
      // read as bytes: git() deliberately trims command output and is unsuitable here.
      const { execFile } = await import('node:child_process');
      const bytes = await new Promise((resolve, reject) => execFile('git', ['-c', 'safe.directory=*', 'show', `${commit}:${name}`],
        { cwd: root, env, encoding: 'buffer', windowsHide: true, timeout: 120000, maxBuffer: 16 * 1024 * 1024 }, (e, out) => e ? reject(e) : resolve(out)));
      if (sha256(bytes) !== hash) throw new Error('uncommitted-arm-modules');
    }
  }
}
export function observeFilesystem() {
  const counters = { opens: 0, reads: 0, bytes: 0, lstat: 0, fstat: 0, realpath: 0, readdir: 0, peak_fds: 0 }, originals = new Map();
  let active = 0;
  for (const name of ['open', 'readFile', 'lstat', 'realpath', 'readdir']) {
    const original = fs[name]; originals.set(name, original);
    fs[name] = async (...args) => {
      if (name === 'open') counters.opens++;
      else if (name !== 'readFile') counters[name]++;
      const value = await original(...args);
      if (name === 'readFile') { counters.opens++; counters.reads++; counters.bytes += Buffer.byteLength(value); }
      if (name !== 'open') return value;
      active++; counters.peak_fds = Math.max(counters.peak_fds, active);
      for (const method of ['read', 'stat', 'close']) {
        const call = value[method].bind(value);
        value[method] = async (...params) => {
          if (method === 'read') counters.reads++;
          if (method === 'stat') counters.fstat++;
          const result = await call(...params);
          if (method === 'read') counters.bytes += result.bytesRead;
          if (method === 'close') active--;
          return result;
        };
      }
      return value;
    };
  }
  syncBuiltinESMExports();
  return { counters, stop: () => { for (const [name, original] of originals) fs[name] = original; syncBuiltinESMExports(); } };
}
export function traceCounts(text) {
  const seen = new Set(), counts = { 'rev-parse': 0, 'stage-list': 0, 'names-list': 0, other: 0 };
  for (const line of text.split('\n').filter(Boolean)) {
    const event = JSON.parse(line);
    if (event.event !== 'start' || seen.has(event.sid)) continue;
    seen.add(event.sid);
    const args = event.argv ?? [];
    const kind = args.includes('rev-parse') ? 'rev-parse' : args.includes('ls-files') ? (args.includes('--stage') ? 'stage-list' : 'names-list') : 'other';
    counts[kind]++;
  }
  return counts;
}
const trace = n => `.ai-factory/state/work/implementation/check-${n}.md`;
function peakRSS() { try { return process.resourceUsage().maxRSS || null; } catch { return null; } }
export async function operation(api, fixture, scenario, setupOnly = false) {
  const { executionCommand: execute } = api.execution, store = await api.store.storeFor(fixture.root);
  const call = (action, input, options = {}) => execute(action, input, { rootDir: fixture.root, ...options });
  const target = fixture.target, targets = fixture.targets ?? [target];
  const start = { change_id: 'work', run_id: 'run-1', task_id: '1.1', owner: 'parent', worker: 'worker', role: 'implement', scope: [target] };
  const actor = version => ({ change_id: 'work', run_id: 'run-1', actor: 'worker', version });
  const result = (n, file) => ({ result_id: `result-${n}`, status: 'completed', changed_files: [file], checks: [{ name: 'synthetic', exit_code: 0 }], evidence: [trace(n)] });
  const semantic = async (runId = 'run-1') => {
    const run = await store.load(`.ai-factory/state/work/execution/runs/${runId}.json`);
    const { created_at: _created, updated_at: _updated, ...stable } = run;
    return stable;
  };
  if (['W', 'F'].includes(scenario.family)) return api.store.worktree(store, scenario.scope === 'directory' ? ['data'] : [target]);
  if (scenario.family === 'I') {
    if (setupOnly) return;
    return call('isolation-preflight', { change_id: 'work', group_id: 'pair', owner: 'parent', preflight_paths: [trace('preflight')],
      assignments: fixture.workers.map((root, i) => ({ root, run_id: `worker-${i}`, worker: `worker-${i}`, task_id: `1.${i + 1}`, files: [targets[i]], dependencies: [] })) });
  }
  if (scenario.family === 'S') {
    if (scenario.operation === 'lifecycle' || setupOnly) {
      await call('start', start);
      if (scenario.variant === 'deletion') await fs.unlink(path.join(fixture.root, target));
      else await put(fixture.root, target, 'edited synthetic leaf\n');
      await call('checkpoint', { ...actor(1), progress: { completed_steps: ['Edited leaf'], next_step: 'Review' } });
      const input = { ...actor(2), result: result(1, target) };
      const done = await call('result', input); fixture.replay = input;
      if (scenario.operation !== 'result-replay') {
        fixture.replay = { ...actor(3), actor: 'parent', result_digest: done.result.digest };
        await call('accept', fixture.replay);
      }
    } else await call(scenario.operation === 'result-replay' ? 'result' : 'accept', fixture.replay);
    return semantic();
  }
  if (scenario.family === 'B') {
    if (scenario.operation === 'lifecycle' || setupOnly) {
      const items = targets.slice(0, 3).map((file, i) => ({ task_id: `1.${i + 1}`, files: [file], expected_change: 'Edit leaf', check: 'synthetic', dependencies: [] }));
      const { task_id, scope, ...batch } = start;
      await call('batch-start', { ...batch, manifest: items, preflight_paths: [trace('preflight')] });
      for (const file of targets.slice(0, 3)) await put(fixture.root, file, 'edited synthetic leaf\n');
      await call('checkpoint', { ...actor(1), progress: { completed_steps: ['Edited leaves'], next_step: 'Seal' } });
      const evidence = Object.fromEntries(items.map((item, i) => [item.task_id, [trace(i + 1)]]));
      const seal = await call('batch-seal', { ...actor(2), evidence }); let version = seal.version;
      const results = [];
      for (let i = 0; i < 3; i++) {
        const input = { ...actor(version), task_id: items[i].task_id, seal_digest: seal.seal_digest, result: result(i + 1, targets[i]) };
        const done = await call('batch-result', input); results.push(done); version = done.version; fixture.replay = input;
      }
      if (scenario.operation !== 'replay') {
        for (const i of scenario.order) version = (await call('batch-accept', { ...actor(version), actor: 'parent', task_id: items[i - 1].task_id,
          seal_digest: seal.seal_digest, result_digest: results[i - 1].result_digest })).version;
        await call('batch-close', { ...actor(version), actor: 'parent', seal_digest: seal.seal_digest });
      }
    } else await call('batch-result', fixture.replay);
    return semantic();
  }
  if (scenario.family === 'H') {
    if (setupOnly) return;
    // Admission scans all histories through catalogue; histories were prepared outside timing.
    await call('start', { ...start, run_id: 'measured-run' });
    return semantic('measured-run');
  }
  if (scenario.family !== 'N') throw new Error('unsupported-scenario');
  const variant = scenario.variant;
  if (variant === 'interrupted') {
    try { await call('start', start, { failpoint: point => { if (point === 'after-journal') throw new Error('fixture-interruption'); } }); }
    catch (e) { if (e.message !== 'fixture-interruption') throw e; }
    await call('start', start); return semantic();
  }
  if (['oversize', 'size-boundary', 'count', 'hardlink', 'symlink', 'junction', 'identity-replacement', 'metadata-during-read'].includes(variant)) {
    if (variant === 'oversize' || variant === 'size-boundary') { const fd = await fs.open(path.join(fixture.root, target), 'r+'); try { await fd.truncate(16 * 1024 * 1024 + (variant === 'oversize' ? 1 : 0)); } finally { await fd.close(); } }
    if (variant === 'count') for (let i = 0; i < 10001; i++) await put(fixture.root, `ignored/${i}.txt`, 'x');
    if (variant === 'hardlink') await fs.link(path.join(fixture.root, target), path.join(fixture.root, 'alias.txt'));
    if (variant === 'symlink') { await fs.rename(path.join(fixture.root, target), path.join(fixture.root, 'moved.txt')); await fs.symlink(path.join(fixture.root, 'moved.txt'), path.join(fixture.root, target)); }
    if (variant === 'junction') {
      const alias = path.join(path.dirname(fixture.root), 'aliased-data');
      if (path.dirname(alias) !== fixture.container) throw new Error('unsafe-fixture-alias');
      await fs.rm(alias, { recursive: true, force: true });
      await fs.rename(path.join(fixture.root, 'data'), alias);
      await fs.symlink(alias, path.join(fixture.root, 'data'), process.platform === 'win32' ? 'junction' : 'dir');
    }
    if (variant === 'identity-replacement') {
      const original = fs.open; let changed = false;
      fs.open = async (...args) => {
        const fd = await original(...args);
        if (!changed && path.resolve(String(args[0])) === path.join(fixture.root, target)) {
          try {
            changed = true; const data = await fs.readFile(args[0]);
            await fs.rename(args[0], `${args[0]}.old`); await fs.writeFile(args[0], data);
          } catch (error) { await fd.close(); throw error; }
        }
        return fd;
      };
      syncBuiltinESMExports();
      try { return await api.store.worktree(store, [target]); }
      finally { fs.open = original; syncBuiltinESMExports(); }
    }
    if (variant === 'metadata-during-read') {
      const key = store.readLeaf ? 'readLeaf' : 'bytes', original = store[key]; let changed = false;
      store[key] = async name => { const value = await original(name); if (!changed) { changed = true; await git(fixture.root, fixture.env, 'checkout', '-qb', 'drift'); } return value; };
    }
    return api.store.worktree(store, variant === 'count' ? ['ignored'] : [target]);
  }
  await call('start', { ...start, ...(variant === 'ignored' ? { scope: ['ignored'] } : {}) });
  if (variant === 'ignored') await put(fixture.root, 'ignored/new.txt', 'drift');
  if (variant === 'bytes' || variant === 'scope') await put(fixture.root, variant === 'scope' ? targets[1] : target, 'drift');
  if (variant === 'mode') {
    if (process.platform === 'win32') throw Object.assign(new Error('mode-unavailable'), { code: 'ENOTSUP' });
    await fs.chmod(path.join(fixture.root, target), 0o755);
  }
  if (variant === 'metadata') await git(fixture.root, fixture.env, 'checkout', '-qb', 'drift');
  return call(variant === 'scope' ? 'checkpoint' : 'resume', variant === 'scope' ? { ...actor(1), progress: { completed_steps: [], next_step: 'Check' } } : { change_id: 'work', run_id: 'run-1' });
}

export async function prepare(api, fixture, scenario) {
  fixture.targets = fixture.manifest.leaves.filter(e => e.path.startsWith('data/')).slice(0, 3).map(e => e.path);
  for (const n of [1, 2, 3, 'preflight']) await put(fixture.root, trace(n), 'Synthetic benchmark evidence\n');
  if (scenario.family === 'H') {
    for (let i = 0; i < scenario.changes; i++) {
      const id = `history-${i}`;
      await put(fixture.root, `openspec/changes/${id}/proposal.md`, '# History\n');
      await put(fixture.root, `openspec/changes/${id}/tasks.md`, '- [ ] 1.1 History task\n');
      const input = { change_id: id, run_id: 'history-run', task_id: '1.1', owner: 'parent', worker: 'worker', role: 'implement', scope: [fixture.target] };
      await api.execution.executionCommand('start', input, { rootDir: fixture.root });
      // Interrupt then confirm yields valid closed lineage and real journals without modifying leaves.
      await api.execution.executionCommand('interrupt', { change_id: id, run_id: input.run_id, actor: 'parent', version: 1, recovery_id: 'stop', reason: 'timed_out', execution_state: 'unknown' }, { rootDir: fixture.root });
      await api.execution.executionCommand('stop-confirm', { change_id: id, run_id: input.run_id, actor: 'parent', version: 2, recovery_id: 'stop', confirmation_id: 'confirmed', evidence: [trace(1)] }, { rootDir: fixture.root });
      if (scenario.history === 'large') for (let j = 0; j < 8; j++) {
        const journal = await fs.readdir(path.join(fixture.root, `.ai-factory/state/${id}/execution/transactions`));
        // Valid repeated applied journal history is produced through APIs, never fabricated.
        if (!journal.length) throw new Error('missing-history-journal');
        const runId = `extra-${j}`;
        await api.execution.executionCommand('start', { ...input, run_id: runId }, { rootDir: fixture.root });
        await api.execution.executionCommand('interrupt', { change_id: id, run_id: runId, actor: 'parent', version: 1, recovery_id: 'stop', reason: 'timed_out', execution_state: 'unknown' }, { rootDir: fixture.root });
        await api.execution.executionCommand('stop-confirm', { change_id: id, run_id: runId, actor: 'parent', version: 2, recovery_id: 'stop', confirmation_id: 'confirmed', evidence: [trace(1)] }, { rootDir: fixture.root });
      }
    }
    if (scenario.active_runs === 1) await api.execution.executionCommand('start', { change_id: 'history-0', run_id: 'active-history', task_id: '1.1',
      owner: 'parent', worker: 'worker', role: 'implement', scope: [fixture.targets[1]] }, { rootDir: fixture.root });
  }
  if (['result-replay', 'accept-replay', 'replay'].includes(scenario.operation)) await operation(api, fixture, scenario, true);
}
export async function runArm(config) {
  const { root, identity, fixture, scenario, profile } = config;
  const container = await fs.realpath(fixture.container);
  if (container !== fixture.container || !path.basename(container).startsWith('aifhub-snapshot-')
    || path.dirname(fixture.root) !== container || fixture.workers.some(w => path.dirname(w) !== container)
    || await fs.readFile(path.join(container, '.snapshot-owned'), 'utf8') !== fixture.token) throw new Error('unowned-fixture');
  Object.assign(process.env, fixture.env);
  for (const name of Object.keys(process.env)) if (name.startsWith('GIT_') && !Object.hasOwn(fixture.env, name)) delete process.env[name];
  await verifyIdentity(root, identity, fixture.env);
  const api = { store: await import(pathToFileURL(path.join(root, ENTRYPOINTS[0]))), execution: await import(pathToFileURL(path.join(root, ENTRYPOINTS[1]))) };
  const { capture, restore } = await import('./fixture.mjs');
  const roots = [fixture.root, ...fixture.workers], captureAll = () => Promise.all(roots.map(capture));
  const restoreAll = async images => { for (let n = 0; n < roots.length; n++) await restore(roots[n], images[n]); };
  const imageDigest = images => sha256(JSON.stringify(images.map(image => image.map(e => ({ name: e.name, mode: e.mode, sha256: e.data ? sha256(e.data) : null })))));
  const base = await captureAll();
  if (config.prepareOnly) {
    await prepare(api, fixture, scenario);
    return { prepared: true, targets: fixture.targets, replay: fixture.replay ?? null };
  }
  if (!config.prepared) throw new Error('missing-prepared-fixture');
  const starting = await captureAll(), before = await manifest(fixture.root, fixture.env, fixture.modules);
  const startingDigest = imageDigest(starting);
  const rows = [], count = profile === 'process-warm' ? config.repeats : 1;
  for (let i = profile === 'process-warm' ? -2 : 0; i < count; i++) {
    await restoreAll(starting);
    const current = await manifest(fixture.root, fixture.env, fixture.modules);
    if (current.digest !== before.digest) throw new Error('fixture-restore-mismatch');
    const diagnostic = profile === 'diagnostic', observer = diagnostic ? observeFilesystem() : null;
    if (diagnostic) { await fs.writeFile(config.traceFile, ''); process.env.GIT_TRACE2_EVENT = config.traceFile; }
    else delete process.env.GIT_TRACE2_EVENT;
    const begin = performance.now(); let value, error;
    try { value = await operation(api, fixture, scenario); } catch (e) { error = e; }
    const elapsed = performance.now() - begin;
    delete process.env.GIT_TRACE2_EVENT; observer?.stop();
    const rawCode = error?.code;
    const code = typeof rawCode === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(rawCode) ? rawCode : error ? 'operation-error' : null;
    const unavailable = ['EPERM', 'EACCES', 'ENOTSUP'].includes(code);
    const expected = error ? scenario.expected_codes.includes(code) : scenario.expected_codes.length === 0;
    const after = await manifest(fixture.root, fixture.env, fixture.modules).catch(() => null);
    const readOnly = ['W', 'F', 'I'].includes(scenario.family);
    const unchanged = !readOnly || before.digest === after?.digest && startingDigest === await captureAll().then(imageDigest).catch(() => null);
    if (i >= 0) rows.push({ status: unavailable ? 'NOTRUN' : expected && unchanged ? 'PASS' : 'FAIL', code: unavailable ? 'capability-unavailable' : !expected && !error ? 'unexpected-success' : !unchanged ? 'unexpected-write' : code,
      wall_ms: diagnostic || unavailable ? null : elapsed, fs: observer?.counters ?? null,
      git: diagnostic ? traceCounts(await fs.readFile(config.traceFile, 'utf8')) : null,
      peak_rss_kib: peakRSS(), semantic_digest: value ? sha256(JSON.stringify(value)) : null,
      fixture_digest: sha256(before.digest + startingDigest), unchanged, expected });
  }
  await restoreAll(base);
  await verifyIdentity(root, identity, fixture.env);
  return rows;
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const chunks = []; let length = 0;
    for await (const chunk of process.stdin) { length += chunk.length; if (length > 1024 * 1024) throw new Error('input-too-large'); chunks.push(chunk); }
    process.stdout.write(JSON.stringify(await runArm(JSON.parse(Buffer.concat(chunks)))) + '\n');
  } catch (e) {
    const unavailable = ['EPERM', 'EACCES', 'ENOENT', 'ETIMEDOUT'].includes(e.code);
    process.stdout.write(JSON.stringify([{ status: unavailable ? 'NOTRUN' : 'FAIL', code: unavailable ? 'sandbox-or-capability' : 'arm-error', wall_ms: null, fs: null, git: null, peak_rss_kib: null, semantic_digest: null, fixture_digest: null, unchanged: null, expected: null }]) + '\n');
    process.exitCode = unavailable ? 0 : 1;
  }
}
