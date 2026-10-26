// Standalone, read-only scanner: never statically import the installed execution runtime.
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

export const HELPER_MODULES = Object.freeze([
  'scripts/workflow-state-store.mjs', 'scripts/execution-state.mjs', 'scripts/execution-records.mjs',
  'scripts/execution-task-source.mjs', 'scripts/isolated-execution.mjs',
]);
const OLD_HASHES = [
  'fa61bfab15fe948ce29918117a0510c57b735c83a5b04f472286220275c90759',
  'de007ec332ac5ea6c520063ad20577f1be3650b70a798b413b218b646d588cc6',
  '21916e772f8d33e66f6d3cd1bf20fd75e1ec396a883a36ca0ae8b9451402b228',
  '21315368c7727d40ff736f8e70fd0b31730a8413470e4fb27787a67b9c1332e4',
  '7dbdbe464fbe6cfcf8a3dcb83759813ed316fa71d6f093820b518bfc0ff6b9a7',
];
export const BASELINE_171 = Object.freeze(Object.fromEntries(HELPER_MODULES.map((p, i) => [p, OLD_HASHES[i]])));
export const helperRoot = fileURLToPath(new URL('../', import.meta.url));
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const exec = promisify(execFile);
const json = async filename => JSON.parse(await readFile(filename, 'utf8'));

export async function helperBaseline(root = helperRoot) {
  const version = await json(path.join(root, 'extension.json')).then(v => typeof v.version === 'string' ? v.version : null).catch(() => null);
  try {
    const manifest = await json(path.join(root, 'provenance.json'));
    if (version && manifest.version === version && typeof manifest.released_at === 'string' && Number.isFinite(Date.parse(manifest.released_at)) &&
        Array.isArray(manifest.files) && manifest.files.length === HELPER_MODULES.length &&
        manifest.files.every(f => f && Object.keys(f).length === 2 && HELPER_MODULES.includes(f.path) && /^[a-f0-9]{64}$/.test(f.sha256)) &&
        new Set(manifest.files.map(f => f.path)).size === HELPER_MODULES.length) {
      return { version, source: 'manifest', expected: Object.fromEntries(manifest.files.map(f => [f.path, f.sha256])) };
    }
  } catch { /* Partial installations must still produce diagnostics. */ }
  return { version, source: version === '1.7.1' ? 'baseline-1.7.1' : 'unknown', expected: version === '1.7.1' ? BASELINE_171 : null };
}

export async function helperBytes(root, relative) {
  const filename = path.join(root, relative), info = await lstat(filename);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 16 * 1024 * 1024) throw new Error('unsafe-helper-file');
  return readFile(filename);
}

export async function helperDiagnostics({ rootDir = helperRoot } = {}) {
  const baseline = await helperBaseline(rootDir);
  const paths = [...HELPER_MODULES, 'scripts/execution-provenance.mjs'];
  const modules = await Promise.all(paths.map(async p => ({ path: p, sha256: await helperBytes(rootDir, p).then(sha256).catch(() => null) })));
  const mismatches = baseline.expected ? modules.filter(m => Object.hasOwn(baseline.expected, m.path) && m.sha256 !== baseline.expected[m.path])
    .map(m => ({ path: m.path, expected_sha256: baseline.expected[m.path], actual_sha256: m.sha256 })) : [];
  let support = 'unknown';
  // Capability is attested by the shipped release manifest alone: importing the audited
  // runtime from a read-only scanner would execute whatever a regenerated manifest vouches for.
  if (baseline.source === 'manifest' && mismatches.length === 0) support = 'yes';
  let git = { available: false, version: null };
  try {
    const { stdout } = await exec('git', ['--version'], { encoding: 'utf8', timeout: 3000, maxBuffer: 4096, windowsHide: true });
    const version = stdout.trim();
    if (/^git version [\w.+() -]+$/.test(version)) git = { available: true, version };
  } catch { /* Git is optional for read-only installed-byte diagnostics. */ }
  return {
    schema: 'aifhub.execution_helper_provenance.v1', declared_version: baseline.version, modules,
    implementation: baseline.expected ? (mismatches.length ? 'locally-modified' : 'release-exact') : 'unknown',
    baseline: baseline.source, mismatches, local_modifications: baseline.expected ? mismatches.length > 0 : null,
    capabilities: [{ id: 'recursive_submodule_snapshots', support, provenance: 'probed' }], git,
  };
}

// Preserve the established bounded JSON CLI contract even when runtime imports fail.
export async function helperCliMain(moduleUrl, execute) {
  if (!process.argv[1] || pathToFileURL(path.resolve(process.argv[1])).href !== moduleUrl) return;
  try {
    const [action, ...args] = process.argv.slice(2);
    if (typeof action !== 'string' || args.length > 1 || args.some(a => a !== '--json')) throw { code: 'invalid-arguments' };
    const chunks = []; let length = 0;
    for await (const chunk of process.stdin) {
      length += chunk.length;
      if (length > 1024 * 1024) throw { code: 'input-too-large' };
      chunks.push(chunk);
    }
    let input;
    try { input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
    catch { throw { code: 'invalid-json' }; }
    const result = await execute(action, input);
    process.stdout.write(JSON.stringify({ ok: true, ...result }) + '\n');
  } catch (error) {
    const known = ['invalid-arguments', 'input-too-large', 'invalid-json', 'invalid-input'];
    const workflow = error?.constructor?.name === 'WorkflowError';
    process.stdout.write(JSON.stringify({ ok: false, code: workflow || known.includes(error?.code) ? error.code : 'workflow-error' }) + '\n');
    process.exitCode = workflow && error.blocked ? 1 : 2;
  }
}

await helperCliMain(import.meta.url, async (action, input) => {
  if (action !== 'diagnostics' || !input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length) throw { code: 'invalid-input' };
  return helperDiagnostics();
});
