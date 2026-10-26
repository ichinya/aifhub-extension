import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { HELPER_MODULES, helperRoot, sha256 } from './execution-provenance.mjs';

export async function generateProvenance({ rootDir = helperRoot, check = false } = {}) {
  const { version } = JSON.parse(await readFile(path.join(rootDir, 'extension.json'), 'utf8'));
  const files = await Promise.all(HELPER_MODULES.map(async p => ({ path: p, sha256: sha256(await readFile(path.join(rootDir, p))) })));
  const filename = path.join(rootDir, 'provenance.json');
  if (check) {
    const current = JSON.parse(await readFile(filename, 'utf8'));
    if (current.version !== version || !Number.isFinite(Date.parse(current.released_at)) || JSON.stringify(current.files) !== JSON.stringify(files)) throw new Error('stale-provenance');
    return current;
  }
  const manifest = { version, released_at: new Date().toISOString(), files };
  await writeFile(filename, JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    if (process.argv.slice(2).some(a => a !== '--check') || process.argv.length > 3) throw new Error('invalid-arguments');
    const manifest = await generateProvenance({ check: process.argv.includes('--check') });
    console.log(`Provenance ${manifest.version}: ${manifest.files.length} files ${process.argv.includes('--check') ? 'verified' : 'generated'}.`);
  } catch { console.error('Provenance generation/check failed. Run npm run release:prepare and review provenance.json.'); process.exitCode = 1; }
}
