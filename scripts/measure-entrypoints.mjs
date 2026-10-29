// Read-only physical surfaces; injection source is never added to installed totals.
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const METHOD_VERSION = 'aifhub.entrypoints.v1';
export const SOURCE_SURFACES = Object.freeze([
  '.agents/skills/aif/SKILL.md', '.agents/skills/aif-implement/SKILL.md',
  '.agents/skills/aif-verify/SKILL.md', '.agents/skills/aif-fix/SKILL.md',
  'skills/aif-done/SKILL.md', 'injections/core/aif-implement-plan-folder.md',
  'agent-files/claude/aifhub-implement-worker.md', 'skills/shared/QUESTION-TOOL.md',
  'skills/shared/TASK-COORDINATION.md',
]);
export function measure(bytes) {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  return { bytes: bytes.length, lines: text ? text.split(/\r\n|\n|\r/).length - (/\r\n$|\n$|\r$/.test(text) ? 1 : 0) : 0,
    sha256: createHash('sha256').update(bytes).digest('hex') };
}
const sum = files => ({ bytes: files.reduce((n, f) => n + f.bytes, 0), lines: files.reduce((n, f) => n + f.lines, 0) });
export async function measureEntrypoints({ rootDir = fileURLToPath(new URL('../', import.meta.url)), surface = 'source-surfaces', runtime = 'claude', references = [] } = {}) {
  if (!['source-surfaces', 'installed-flow'].includes(surface) || !['claude', 'codex'].includes(runtime)) throw new Error('invalid-manifest');
  const extension = surface === 'source-surfaces' ? '' : '.ai-factory/extensions/aifhub-extension/';
  let installation = null;
  try { installation = JSON.parse(await readFile(path.join(rootDir, '.ai-factory.json'), 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const agent = installation?.agents?.find(a => a.id === runtime);
  const layout = [agent?.skillsDir ?? `.${runtime}/skills`, agent?.agentsDir ?? `.${runtime}/agents`];
  for (const dir of layout) if (typeof dir !== 'string' || path.isAbsolute(dir) || dir.includes(':') || dir.split(/[\\/]/).some(p => !p || p === '..' || p === '.')) throw new Error('invalid-installed-layout');
  const [skillsDir, agentsDir] = layout.map(dir => dir.replaceAll('\\', '/'));
  const worker = `agent-files/${runtime}/aifhub-implement-worker.${runtime === 'codex' ? 'toml' : 'md'}`;
  const files = surface === 'source-surfaces' ? SOURCE_SURFACES.map(p => p === SOURCE_SURFACES[6] ? worker : p) : [
    ...['aif', 'aif-implement', 'aif-verify', 'aif-fix', 'aif-done'].map(n => `${skillsDir}/${n}/SKILL.md`),
    `${agentsDir}/aifhub-implement-worker.${runtime === 'codex' ? 'toml' : 'md'}`,
    ...['QUESTION-TOOL.md', 'TASK-COORDINATION.md'].map(n => `${extension}skills/shared/${n}`),
  ];
  const read = async p => ({ path: p, ...measure(await readFile(path.join(rootDir, p))) });
  const measured = await Promise.all(files.map(read));
  const support = await Promise.all(['LANGUAGE-POLICY.md', 'TOOLS.md'].map(n => read(`${extension}skills/shared/${n}`)));
  const selected = await Promise.all([...new Set(references)].sort().map(p => {
    if (!/^(?:injections\/references|skills\/[^/]+\/references)\/[\w./-]+\.md$/.test(p) || p.split('/').includes('..')) throw new Error('invalid-reference');
    return read(extension + p);
  }));
  const manifest = JSON.parse(await readFile(path.join(rootDir, extension, 'extension.json'), 'utf8'));
  const metadataRoot = path.join(rootDir, extension);
  let commit = null;
  try {
    const [top, head] = execFileSync('git', ['-c', `safe.directory=${path.resolve(metadataRoot).replaceAll('\\', '/')}`, 'rev-parse', '--show-toplevel', 'HEAD'],
      { cwd: metadataRoot, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim().split(/\r?\n/);
    if (path.resolve(top) === path.resolve(metadataRoot) && /^[a-f0-9]{40,64}$/.test(head)) commit = head;
  } catch { /* installed extension archives need not contain their own Git metadata */ }
  if (commit === null) {
    try {
      const head = (await readFile(path.join(metadataRoot, '.git/HEAD'), 'utf8')).trim();
      commit = head.startsWith('ref: ') ? (await readFile(path.join(metadataRoot, '.git', head.slice(5)), 'utf8')).trim() : head;
      if (!/^[a-f0-9]{40,64}$/.test(commit)) commit = null;
    } catch { /* optional Git metadata */ }
  }
  let upstream = null;
  try { upstream = JSON.parse(await readFile(path.join(rootDir, extension, 'aifhub-extension.json'), 'utf8')).sources?.['ai-factory']?.version ?? null; } catch { /* optional metadata */ }
  const markers = measured.filter(f => /aif-implement\/SKILL\.md$/.test(f.path));
  const cardinality = await Promise.all(markers.map(async f => {
    const text = await readFile(path.join(rootDir, f.path), 'utf8');
    const prefix = '<!-- aif-ext:aifhub-extension:aif-implement:prepend:';
    return { path: f.path, identity: 'aifhub-extension:aif-implement:prepend', start: text.split(prefix + 'start -->').length - 1, end: text.split(prefix + 'end -->').length - 1 };
  }));
  return { method_version: METHOD_VERSION, surface, runtime, node_version: process.versions.node, source_commit: commit, extension_version: manifest.version, upstream_version: installation?.version ?? null, reviewed_upstream_version: upstream,
    files: measured, totals: sum(measured), supporting_files: support, supporting_totals: sum(support), managed_blocks: cardinality,
    selected_references: selected, reference_totals: sum(selected), tokens: null, api_read_bytes: null, agent_consumption: 'not_observed_offline' };
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const args = process.argv.slice(2), options = {};
    while (args.length) {
      const key = args.shift(), value = args.shift();
      if (!value || !['--root', '--surface', '--runtime', '--reference'].includes(key)) throw new Error('invalid-arguments');
      if (key === '--reference') { (options.references ??= []).push(value); continue; }
      options[{ '--root': 'rootDir', '--surface': 'surface', '--runtime': 'runtime' }[key]] = value;
    }
    process.stdout.write(JSON.stringify(await measureEntrypoints(options), null, 2) + '\n');
  } catch (error) { process.stderr.write(`entrypoint measurement failed: ${error.code ?? error.message}\n`); process.exitCode = 1; }
}
