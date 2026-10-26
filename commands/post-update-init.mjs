// AI Factory exposes Commander registration, but no manifest post-update hook.
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInstalledScript } from './run-installed-script.mjs';
import { HELPER_MODULES, helperBaseline, helperBytes, sha256 } from '../scripts/execution-provenance.mjs';

const registered = new WeakSet();
const EXTENSION_NAME = 'aifhub-extension';

export function registerPostUpdateInit(program, moduleUrl, options = {}) {
  if (registered.has(program)) return;
  registered.add(program);
  const processLike = options.processLike ?? process;
  const run = options.runInstalledScript ?? runInstalledScript;
  const pending = new WeakMap();

  program.hook('preAction', async (_root, action) => {
    pending.delete(action);
    if (!updatesAifhub(program, action)) return;
    const rootDir = processLike.cwd();
    const before = await refreshStamp(rootDir, moduleUrl);
    if (before !== null || await installedProject(rootDir, moduleUrl)) {
      try {
        const preservation = await preserveHelper(rootDir);
        pending.set(action, { rootDir, before, preservation });
        // Commander skips postAction when the update action itself throws; the exit
        // fallback is the last chance to hand off preserved copies for review.
        processLike.once?.('exit', () => {
          if (!pending.get(action)) return;
          processLike.stderr.write('AIFHub: update failed after helper preservation; preserved copies and diff-manifest.json remain under .ai-factory/state/extension-updates. Review them before retrying.\n');
        });
      } catch {
        processLike.exitCode = 1;
        throw new Error('AIFHub: helper preservation failed; update stopped before replacement. Review .ai-factory/state/extension-updates and retry.');
      }
    }
  });
  program.hook('postAction', async (_root, action) => {
    const state = pending.get(action);
    pending.delete(action);
    if (!state) return;
    // Finalize the handoff even if the updater/initializer failed or skipped its refresh.
    try {
      await finishPreservation(state, processLike);
    } catch {
      if (Number(processLike.exitCode ?? 0) === 0) processLike.exitCode = 1;
      processLike.stderr.write('AIFHub: helper diff finalization failed; preserved copies remain under .ai-factory/state/extension-updates. Review them before retrying.\n');
    }
    const strictHandoff = state.preservation && processLike.env?.AIFHUB_UPDATE_STRICT === '1';
    if (Number(processLike.exitCode ?? 0) !== 0) return;
    const after = await refreshStamp(state.rootDir, moduleUrl);
    if (after === state.before) {
      if (strictHandoff) processLike.exitCode = 1;
      return; // The installed initializer was not refreshed.
    }
    try {
      if (after === null || processLike.cwd() !== state.rootDir) throw new Error('initialization_unavailable');
      processLike.stdout.write('\nAIFHub: initializing the project after extension update.\n');
      // Resolve at execution time: the updater has replaced the installed scripts.
      const code = await run('../scripts/aif-mode.mjs', ['init', '--json'], moduleUrl, { processLike });
      if (code !== 0) {
        processLike.exitCode = code;
        throw new Error('initialization_failed');
      }
    } catch {
      if (Number(processLike.exitCode ?? 0) === 0) processLike.exitCode = 1;
      processLike.stderr.write('AIFHub: post-update initialization failed. Resolve the setup error and retry ai-factory aifhub-mode init --json.\n');
    }
    if (strictHandoff && Number(processLike.exitCode ?? 0) === 0) processLike.exitCode = 1;
  });
}

async function ensureDirectory(rootDir, relative) {
  let current = await realpath(rootDir);
  for (const segment of relative.split('/')) {
    current = path.join(current, segment);
    await mkdir(current).catch(e => { if (e.code !== 'EEXIST') throw e; });
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('unsafe-preserve-directory');
  }
  return current;
}

async function preserveHelper(rootDir) {
  const installed = path.join(rootDir, '.ai-factory/extensions', EXTENSION_NAME);
  const baseline = await helperBaseline(installed), changed = [];
  for (const relative of HELPER_MODULES) {
    const filename = path.join(installed, relative);
    const bytes = await helperBytes(installed, relative).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
    if (bytes === null) continue; // There is no installed byte stream to preserve.
    if (path.resolve(await realpath(filename)) !== path.resolve(filename)) throw new Error('unsafe-installed-helper');
    const hash = sha256(bytes);
    if (!baseline.expected || baseline.expected[relative] !== hash) changed.push({ path: relative, bytes, hash });
  }
  if (!changed.length) return null;
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8);
  const relative = `.ai-factory/state/extension-updates/${timestamp}`;
  const directory = await ensureDirectory(rootDir, `${relative}/preserve/scripts`);
  for (const file of changed) await writeFile(path.join(directory, path.basename(file.path)), file.bytes, { flag: 'wx' });
  const manifest = {
    schema: 'aifhub.extension_update_diff.v1', declared_version: baseline.version, baseline: baseline.source,
    files: changed.map(file => ({ path: file.path, installed_sha256: file.hash, incoming_sha256: null, disposition: 'preserved-review-required' })),
  };
  const manifestPath = `${relative}/diff-manifest.json`;
  await writeFile(path.join(rootDir, manifestPath), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  return { manifestPath, manifest };
}

async function finishPreservation(state, processLike) {
  const preserved = state.preservation;
  if (!preserved) return;
  const installed = path.join(state.rootDir, '.ai-factory/extensions', EXTENSION_NAME);
  for (const file of preserved.manifest.files) {
    file.incoming_sha256 = await helperBytes(installed, file.path).then(sha256).catch(() => null);
    file.disposition = file.incoming_sha256 === null ? 'preserved-incoming-unavailable' : 'preserved-review-required';
  }
  const filename = path.join(state.rootDir, preserved.manifestPath);
  if (path.resolve(await realpath(filename)) !== path.resolve(filename) || (await lstat(filename)).nlink !== 1) throw new Error('unsafe-diff-manifest');
  await writeFile(filename, JSON.stringify(preserved.manifest, null, 2) + '\n');
  processLike.stderr.write(`AIFHub: preserved modified/unknown installed helper files: ${preserved.manifest.files.map(f => f.path).join(', ')}.\n` +
    `Review ${preserved.manifestPath} and compare preserve/ with the incoming files; migrate the local patch explicitly. Run ai-factory aifhub-execution diagnostics --json with {} on stdin.\n`);
}

function updatesAifhub(program, action) {
  if (action.name() !== 'update') return false;
  if (action.parent === program) return true;
  if (action.parent?.name() !== 'extension' || action.parent.parent !== program) return false;
  const target = (action.processedArgs ?? action.args ?? [])[0];
  return target === undefined || target === EXTENSION_NAME;
}

async function refreshStamp(rootDir, moduleUrl) {
  try {
    const installedRoot = path.resolve(rootDir, '.ai-factory', 'extensions', EXTENSION_NAME);
    if (!await installedProject(rootDir, moduleUrl)) return null;
    const scriptPath = path.join(installedRoot, 'scripts', 'aif-mode.mjs');
    if (path.resolve(await realpath(scriptPath)) !== scriptPath) return null;
    const script = await lstat(scriptPath, { bigint: true });
    if (!script.isFile() || script.isSymbolicLink() || script.nlink !== 1n) return null;
    return [script.dev, script.ino, script.size, script.mtimeNs, script.ctimeNs].join(':');
  } catch {
    return null;
  }
}

async function installedProject(rootDir, moduleUrl) {
  try {
    const installedRoot = path.resolve(rootDir, '.ai-factory', 'extensions', EXTENSION_NAME);
    if (path.resolve(fileURLToPath(new URL('../', moduleUrl))) !== installedRoot) return false;
    const config = JSON.parse(await readFile(path.join(rootDir, '.ai-factory.json'), 'utf8'));
    return Boolean(config.extensions?.some(entry => entry.name === EXTENSION_NAME));
  } catch { return false; }
}
