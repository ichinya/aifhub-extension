// Separate from execution helper provenance. Preserve bytes before any updater replacement.
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import { PROMPT_REFERENCES, PROMPT_SUPPORT, validatePromptReferences } from './prompt-reference-graph.mjs';

const EXT = '.ai-factory/extensions/aifhub-extension';
const BASELINE = '.ai-factory/state/prompt-assets-baseline.json';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function missing(operation) { try { return await operation(); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } }
async function safe(root, relative, directory = false) {
  if (!relative || relative.split('/').some(p => !p || p === '..' || p === '.') || path.isAbsolute(relative)) throw new Error('unsafe-prompt-path');
  let current = await realpath(root);
  for (const [i, segment] of relative.split('/').entries()) {
    current = path.join(current, segment);
    const info = await lstat(current);
    const dir = i < relative.split('/').length - 1 || directory;
    if (info.isSymbolicLink() || (dir ? !info.isDirectory() : !info.isFile() || info.nlink !== 1 || info.size > 16 * 1024 * 1024)) throw new Error('unsafe-prompt-asset');
  }
  return current;
}
async function ensure(root, relative) {
  for (let i = 1; i <= relative.split('/').length; i++) {
    const part = relative.split('/').slice(0, i).join('/');
    await mkdir(path.join(root, part)).catch(e => { if (e.code !== 'EEXIST') throw e; });
    await safe(root, part, true);
  }
}
export function ledgerRuntimeDirs(installation, runtimes = [...new Set([
  '.agents', '.codex', '.claude', ...(installation?.agents ?? []).map(agent => `.${agent.id}`),
])]) {
  const runtimeDir = (runtime, kind, fallback) => {
    const agent = installation?.agents?.find(entry => entry?.id === runtime.slice(1));
    const dir = String(agent?.[kind] ?? fallback).replaceAll('\\', '/');
    if (path.isAbsolute(dir) || dir.includes(':') || dir.split('/').some(part => !part || part === '..' || part === '.')) throw new Error('invalid-installed-layout');
    return dir;
  };
  return Object.fromEntries(runtimes.map(runtime => [runtime, {
    skillsDir: runtimeDir(runtime, 'skillsDir', `${runtime}/skills`),
    agentsDir: runtimeDir(runtime, 'agentsDir', `${runtime}/agents`)
  }]));
}
export async function readInstallation(root) {
  try { return JSON.parse(await readFile(path.join(root, '.ai-factory.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; return null; }
}
export function injectionMarkerPair(target, position) {
  const prefix = `<!-- aif-ext:aifhub-extension:${target}:${position}:`;
  return [`${prefix}start -->`, `${prefix}end -->`];
}
// Raw extraction only: the update guard keeps its .trim() equality at its own
// call site; composition hashing consumes the untrimmed block bytes.
export function publishedInjectionBlock(text, target, position) {
  if (!/^[\w-]+$/.test(target) || !['prepend', 'append'].includes(position)) throw new Error('unsafe-injection-manifest');
  const [start, end] = injectionMarkerPair(target, position);
  if (text.split(start).length !== 2 || text.split(end).length !== 2 || text.indexOf(start) >= text.indexOf(end)) throw new Error('invalid-installed-marker-pair');
  return text.slice(text.indexOf(start) + start.length, text.indexOf(end));
}

export async function inventoryPromptAssets(root) {
  const files = new Map();
  let totalBytes = 0;
  function addFile(relative, bytes) {
    // Runtime layouts can share prompt paths (e.g. Codex uses .agents/skills).
    // Preserve and budget each path once, retaining exclusive backup writes.
    if (files.has(relative)) return;
    files.set(relative, { path: relative, sha256: hash(bytes), bytes: bytes.length });
    totalBytes += bytes.length;
    if (files.size > 4096 || totalBytes > 64 * 1024 * 1024) throw new Error('prompt-inventory-budget');
  }
  async function walk(relative) {
    if (!await missing(() => safe(root, relative, true))) return;
    for (const entry of (await readdir(path.join(root, relative), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const file = `${relative}/${entry.name}`;
      if (entry.isDirectory()) await walk(file);
      else {
        const bytes = await readFile(await safe(root, file));
        addFile(file, bytes);
      }
    }
  }
  for (const directory of ['skills', 'injections', 'agent-files']) await walk(`${EXT}/${directory}`);
  for (const file of PROMPT_SUPPORT.filter(p => p.startsWith('docs/'))) {
    const filename = await missing(() => safe(root, `${EXT}/${file}`));
    if (filename) addFile(`${EXT}/${file}`, await readFile(filename));
  }
  const manifestPath = await missing(() => safe(root, `${EXT}/extension.json`));
  const manifest = manifestPath ? JSON.parse(await readFile(manifestPath, 'utf8')) : {};
  // Custom runtime layouts from the installed ledger own the prompt locations:
  // ignoring them would let an update replace preserved user edits silently.
  const dirs = ledgerRuntimeDirs(await readInstallation(root));
  for (const runtime of Object.keys(dirs)) {
    const skillsDir = dirs[runtime].skillsDir;
    const agentsDir = dirs[runtime].agentsDir;
    const skills = new Set([...(manifest.skills ?? []).map(s => path.posix.basename(s)), ...(manifest.injections ?? []).map(i => i.target)]);
    for (const skill of skills) {
      if (!/^[\w-]+$/.test(skill)) throw new Error('unsafe-prompt-manifest');
      await walk(`${skillsDir}/${skill}`);
    }
    // Only extension-owned published agent files; unrelated user agents stay outside inventory.
    for (const agent of manifest.agentFiles ?? []) {
      if (runtime !== `.${agent.runtime}`) continue;
      if (!/^[\w.-]+$/.test(agent.target)) throw new Error('unsafe-prompt-manifest');
      const file = `${agentsDir}/${agent.target}`;
      const filename = await missing(() => safe(root, file));
      if (filename) addFile(file, await readFile(filename));
    }
  }
  return [...files.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}
export async function preservePromptAssets(root) {
  const files = await inventoryPromptAssets(root);
  const baselinePath = await missing(() => safe(root, BASELINE));
  let baseline = null;
  if (baselinePath) {
    const data = JSON.parse(await readFile(baselinePath, 'utf8'));
    if (data.schema === 'aifhub.prompt_assets.v1' && Array.isArray(data.files)) baseline = new Map(data.files.map(f => [f.path, f.sha256]));
  }
  const changed = files.filter(f => baseline?.get(f.path) !== f.sha256);
  if (!changed.length) return null;
  const directory = `.ai-factory/state/extension-prompt-updates/${randomUUID()}`;
  await ensure(root, `${directory}/preserve`);
  for (const file of changed) {
    const bytes = await readFile(await safe(root, file.path));
    if (hash(bytes) !== file.sha256) throw new Error('prompt-changed-during-preservation');
    await ensure(root, `${directory}/preserve/${path.posix.dirname(file.path)}`);
    await writeFile(path.join(root, directory, 'preserve', file.path), bytes, { flag: 'wx' });
  }
  const manifest = { schema: 'aifhub.prompt_update_diff.v1', baseline: baseline ? 'installed-inventory' : 'unknown',
    inventory: files, files: changed.map(f => ({ path: f.path, installed_sha256: f.sha256, incoming_sha256: null, disposition: 'preserved-review-required' })) };
  const manifestPath = `${directory}/prompt-diff-manifest.json`;
  await writeFile(path.join(root, manifestPath), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  return { manifestPath, manifest };
}
export async function finishPromptPreservation(root, preserved) {
  if (!preserved) return;
  for (const file of preserved.manifest.files) {
    const filename = await missing(() => safe(root, file.path));
    file.incoming_sha256 = filename ? hash(await readFile(filename)) : null;
  }
  await writeFile(await safe(root, preserved.manifestPath), JSON.stringify(preserved.manifest, null, 2) + '\n');
}
export async function validateInstalledPromptAssets(root) {
  const extension = path.join(root, EXT);
  const manifest = JSON.parse(await readFile(await safe(root, `${EXT}/extension.json`), 'utf8'));
  // Older/minimal installations have no prompt surfaces to validate.
  if (!(manifest.injections?.length || manifest.skills?.length || manifest.agentFiles?.length)) return;
  for (const [source, targets] of Object.entries(PROMPT_REFERENCES)) {
    for (const file of [source, ...targets]) await safe(root, `${EXT}/${file}`);
  }
  for (const file of PROMPT_SUPPORT) await safe(root, `${EXT}/${file}`);
  const refs = await validatePromptReferences(extension);
  for (const ref of refs) await safe(root, `${EXT}/${ref.target}`);
  let targets = 0;
  const installation = await readInstallation(root);
  // The updater refreshes configured agents only; dormant runtime directories
  // can contain older user assets and must not invalidate that update.
  const runtimes = Array.isArray(installation?.agents)
    ? installation.agents.map(agent => `.${agent.id}`)
    : ['.agents', '.codex', '.claude'];
  const dirs = ledgerRuntimeDirs(installation, runtimes);
  for (const runtime of runtimes) {
    const skillsDir = dirs[runtime].skillsDir;
    const agentsDir = dirs[runtime].agentsDir;
    for (const injection of manifest.injections ?? []) {
      if (!/^[\w-]+$/.test(injection.target) || !['prepend', 'append'].includes(injection.position)) throw new Error('unsafe-injection-manifest');
      const filename = await missing(() => safe(root, `${skillsDir}/${injection.target}/SKILL.md`));
      if (!filename) continue;
      const text = await readFile(filename, 'utf8');
      const block = publishedInjectionBlock(text, injection.target, injection.position);
      const source = (await readFile(await safe(root, `${EXT}/${injection.file.replace(/^\.\//, '')}`), 'utf8')).trim();
      if (block.trim() !== source) throw new Error('stale-installed-injection');
      targets++;
    }
    const published = [
      ...(manifest.skills ?? []).map(source => [`${source}/SKILL.md`, `${skillsDir}/${path.posix.basename(source)}/SKILL.md`]),
      ...(manifest.agentFiles ?? []).filter(a => runtime === `.${a.runtime}`).map(a => [a.source.replace(/^\.\//, ''), `${agentsDir}/${a.target}`]),
    ];
    for (const [source, relative] of published) {
      const filename = await missing(() => safe(root, relative));
      if (!filename || !PROMPT_REFERENCES[source]) continue;
      const text = await readFile(filename, 'utf8');
      for (const target of PROMPT_REFERENCES[source]) if (!text.includes('`' + target + '`')) throw new Error('stale-published-reference-route');
    }
  }
  if (manifest.injections?.length && !targets) throw new Error('missing-installed-injection-targets');
}
export async function recordPromptBaseline(root) {
  const files = await inventoryPromptAssets(root);
  if (!files.length) return;
  await ensure(root, '.ai-factory/state');
  const existing = await missing(() => safe(root, BASELINE));
  await writeFile(existing ?? path.join(root, BASELINE), JSON.stringify({ schema: 'aifhub.prompt_assets.v1', files }, null, 2) + '\n', existing ? {} : { flag: 'wx' });
}
