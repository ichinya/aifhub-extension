// AI Factory exposes Commander registration, but no manifest post-update hook.
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInstalledScript } from './run-installed-script.mjs';

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
    if (before !== null) pending.set(action, { rootDir, before });
  });
  program.hook('postAction', async (_root, action) => {
    const state = pending.get(action);
    pending.delete(action);
    if (!state || Number(processLike.exitCode ?? 0) !== 0) return;
    const after = await refreshStamp(state.rootDir, moduleUrl);
    if (after === state.before) return; // The installed initializer was not refreshed.
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
  });
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
    if (path.resolve(fileURLToPath(new URL('../', moduleUrl))) !== installedRoot) return null;
    const config = JSON.parse(await readFile(path.join(rootDir, '.ai-factory.json'), 'utf8'));
    if (!config.extensions?.some((entry) => entry.name === EXTENSION_NAME)) return null;
    const scriptPath = path.join(installedRoot, 'scripts', 'aif-mode.mjs');
    if (path.resolve(await realpath(scriptPath)) !== scriptPath) return null;
    const script = await lstat(scriptPath, { bigint: true });
    if (!script.isFile() || script.isSymbolicLink() || script.nlink !== 1n) return null;
    return [script.dev, script.ino, script.size, script.mtimeNs, script.ctimeNs].join(':');
  } catch {
    return null;
  }
}
