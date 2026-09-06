// Read-only execution input boundary. It never initializes tools or repairs plans.
import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { parseProjectConfig, parseSimpleYaml } from './aif-artifact-sync.mjs';
import { parseToolConfig } from './tool-config.mjs';
import { classifyLegacyPlanShape, normalizeLegacyPlanId } from './legacy-plan-migration.mjs';
import { resolveActiveChange, parseWorkItemSourceBinding, parseLegacyWorkItemSourceBinding, parseSynchronizedWorkItemSourceBinding } from './active-change-resolver.mjs';
import { canonical, digest, portablePath, requireValue, stringList, boundedText, WorkflowError } from './workflow-state-store.mjs';

const PATH_KEYS = new Set(['plans', 'specs', 'rules', 'rules_file', 'state', 'qa', 'generated_rules', 'description', 'architecture']);
const own = (value, key) => Object.hasOwn(value, key);
export function executionId(value) {
  requireValue(typeof value === 'string' && value === value.trim() && normalizeLegacyPlanId(value).ok, 'invalid-change-id');
  portablePath(value);
  requireValue(!value.includes('/') && value.length <= 240, 'invalid-change-id');
  return value;
}

function configShape(raw) {
  const lines = raw.replace(/^\uFEFF/, '').split(/\r?\n/);
  let paths = false, seenBlock = false; const seen = new Set();
  for (const line of lines) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    if (/^\S/.test(line)) {
      paths = /^paths\s*:/.test(line);
      requireValue(!/^["']paths["']\s*:/.test(line), 'tool-configuration-error');
      if (paths) {
        requireValue(!seenBlock && /^paths:\s*(?:\{\})?\s*(?:#.*)?$/.test(line), 'tool-configuration-error'); seenBlock = true;
      }
      continue;
    }
    if (!paths) continue;
    requireValue(!/^\s*<<\s*:/.test(line),'tool-configuration-error');
    if(!new RegExp(`^\\s*["']?(?:${[...PATH_KEYS].join('|')})["']?\\s*:`).test(line))continue;
    requireValue(!/\t|^\s*<<\s*:|^\s*["']/.test(line), 'tool-configuration-error');
    const match = line.match(/^  ([a-z_]+):\s*(.*?)\s*$/);
    if (match && PATH_KEYS.has(match[1])) {
      requireValue(!seen.has(match[1]) && match[2] && !/^[!&*[{>|]/.test(match[2]), 'tool-configuration-error');
      seen.add(match[1]);
    } else requireValue(!new RegExp(`\\b(?:${[...PATH_KEYS].join('|')})\\s*:`).test(line), 'tool-configuration-error');
  }
}

export function assertAuxiliaryPaths(paths) {
  for (const value of stringList(paths)) {
    const p = portablePath(value).toLowerCase();
    requireValue(p !== '.ai-factory' && p !== '.ai-factory/state'
      && !/^\.ai-factory\/state\/[^/]+$/.test(p)
      && !/^\.ai-factory\/state\/[^/]+\/execution(?:\/|$)/.test(p)
      && p !== '.ai-factory/state/execution-write.lock', 'self-referencing-context');
  }
  return paths;
}

// Preserve inline code in titles. Exclude examples without changing the shared
// marker parser used by other workflow owners.
export function parseExecutionTasks(content) {
  const lines = String(content).replace(/^\uFEFF/, '').split(/\r\n|\n|\r/);
  let frontmatter = lines[0] === '---', fence = null, comment = false, ordinal = 0;
  const tasks = [], seen = new Set();
  let parentIndent = null;
  for (let index = 0; index < lines.length; index++) {
    let line = lines[index];
    if (frontmatter) {
      if (index && /^(---|\.\.\.)\s*$/.test(line)) frontmatter = false;
      continue;
    }
    const rawMarker=line.match(/^\s*(`{3,}|~{3,})(.*)$/);
    if(fence) {
      if(rawMarker && rawMarker[1][0]===fence.char && rawMarker[1].length>=fence.length && !rawMarker[2].trim())fence=null;
      continue;
    }
    let visible = '';
    while (line.length) {
      if (comment) { const end = line.indexOf('-->'); if (end < 0) { line = ''; break; } line = line.slice(end + 3); comment = false; }
      else {
        const start=line.indexOf('<!--'),tick=line.indexOf('`');
        if(tick>=0 && (start<0 || tick<start)) {
          const marker=line.slice(tick).match(/^`+/)[0],end=line.indexOf(marker,tick+marker.length);
          if(end>=0) { visible+=line.slice(0,end+marker.length);line=line.slice(end+marker.length);continue; }
        }
        if(start<0) { visible+=line;break; }
        visible+=line.slice(0,start);line=line.slice(start+4);comment=true;
      }
    }
    line = visible;
    const marker = line.match(/^\s*(`{3,}|~{3,})(.*)$/);
    if (marker) { fence = { char: marker[1][0], length: marker[1].length }; continue; }
    const match = line.match(/^( *)-\s+\[([ xX])\]\s+(.+?)\s*$/);
    if (!match) { if (line.trim() && /^\S/.test(line)) parentIndent = null; continue; }
    const indent = match[1].length;
    // Four-space examples outside a real list are code; nested list tasks are real.
    if (indent >= 4 && (parentIndent === null || indent > parentIndent + 4)) continue;
    parentIndent = indent; ordinal++;
    const numbered = match[3].match(/^(\d+(?:\.\d+)*)\s+(.+)$/);
    const upstream = match[3].match(/^Task (\d+):\s*(.+)$/);
    const id = numbered?.[1] ?? upstream?.[1] ?? `task-${ordinal}`;
    requireValue(!/^(?:\d+\.)*0\d/.test(id) && !id.split('.').some(p => /^0\d/.test(p)), 'invalid-task-id');
    requireValue(!seen.has(id), 'unknown-or-ambiguous-task', true); seen.add(id);
    const title = (numbered?.[2] ?? upstream?.[2] ?? match[3]).replace(/\s+/g, ' ').trim();
    boundedText(title, 8000);
    tasks.push({ id, checked: match[2] !== ' ', title });
    requireValue(tasks.length <= 1000, 'too-many-tasks');
  }
  requireValue(!frontmatter, 'invalid-task-frontmatter');
  return tasks;
}

async function statusProjection(store, filename, id, parent) {
  const text = await store.textFile(filename);
  requireValue(text !== null, 'missing-classic-plan', true);
  const parsed = parseSimpleYaml(text);
  requireValue(!own(parsed, 'plan_id') || parsed.plan_id === id, 'plan-id-mismatch', true);
  requireValue((text.match(/^plan_id\s*:/gm) ?? []).length <= 1, 'plan-id-mismatch');
  const md = parseWorkItemSourceBinding(parent), yaml = parseLegacyWorkItemSourceBinding(text);
  requireValue(md.ok && yaml.ok, 'invalid-source-binding', true);
  let binding = null;
  if (md.status === 'bound' || yaml.status === 'bound') {
    const pair = parseSynchronizedWorkItemSourceBinding(parent, text);
    requireValue(pair.ok, 'invalid-source-binding', true); binding = pair.binding;
  }
  return { projection: { plan_id: parsed.plan_id ?? null, source_binding: binding }, binding };
}

export async function resolveExecutionSource(store, id, role, extraPaths = []) {
  executionId(id); requireValue(['implement', 'fix'].includes(role)); assertAuxiliaryPaths(extraPaths);
  const raw = await store.textFile('.ai-factory/config.yaml');
  requireValue(raw === null || Buffer.byteLength(raw) <= 256 * 1024, 'tool-configuration-error');
  let config, selection;
  try { configShape(raw ?? ''); config = parseProjectConfig(raw ?? ''); selection = parseToolConfig(raw ?? ''); }
  catch { throw new WorkflowError('tool-configuration-error'); }
  const paths = {
    plans: selection.mode === 'openspec' ? 'openspec/changes' : '.ai-factory/plans',
    specs: selection.mode === 'openspec' ? 'openspec/specs' : '.ai-factory/specs',
    rules: '.ai-factory/rules', rules_file: '.ai-factory/rules.md', state: '.ai-factory/state', qa: '.ai-factory/qa',
    ...Object.fromEntries(Object.entries(config.paths).filter(([key]) => PATH_KEYS.has(key))),
  };
  for (const value of Object.values(paths)) portablePath(value);
  assertAuxiliaryPaths(Object.entries(paths).filter(([key]) => key !== 'state').map(([, value]) => value));
  requireValue(![paths.plans, paths.specs].some(p => /^\.git(?:\/|$)/i.test(p)), 'unsafe-path');
  const base = `${paths.plans}/${id}`, projections = Object.create(null);
  let entrypoint, checklist, binding, tasks, roots;
  // Bound and check the entire selected directory before legacy/OpenSpec readers
  // that use ordinary filesystem calls. No links are traversed by this inventory.
  await store.inventory(base);
  if (selection.mode === 'openspec') {
    const selected = await resolveActiveChange({ rootDir: store.root, changeId: id, changesDir: paths.plans, specsDir: paths.specs });
    requireValue(selected.ok, 'missing-openspec-change', true);
    entrypoint = `${base}/proposal.md`; checklist = `${base}/tasks.md`;
    const parent = await store.textFile(entrypoint);
    requireValue(parent!==null,'missing-openspec-change',true);
    const parsed = parseWorkItemSourceBinding(parent ?? ''); requireValue(parsed.ok, 'invalid-source-binding', true);
    binding = parsed.status === 'bound' ? parsed.binding : null;
    const taskText = await store.textFile(checklist); requireValue(taskText !== null, 'missing-tasks', true);
    tasks = parseExecutionTasks(taskText); roots = [base];
  } else {
    await store.target(`${base}.md`);
    const shape = await classifyLegacyPlanShape(id, { rootDir: store.root, plansDir: paths.plans, useRecordedLegacyPlanSource: false });
    if (shape.shape === 'ultra-valid') return { delegated: true, handoff: `/aif-${role === 'fix' ? 'fix' : 'implement'} ${base}/index.md` };
    requireValue(!['ultra-invalid', 'collision'].includes(shape.shape), 'plan-integrity-error', true);
    entrypoint = `${base}.md`; checklist = `${base}/task.md`;
    const parent = await store.textFile(entrypoint); requireValue(parent !== null, 'missing-classic-plan', true);
    roots = [entrypoint];
    for (const name of ['task.md', 'context.md', 'rules.md', 'verify.md', 'status.yaml']) {
      const filename = `${base}/${name}`;
      requireValue(await store.textFile(filename) !== null, 'missing-classic-plan', true); roots.push(filename);
    }
    roots.push(`${base}/explore.md`);
    tasks = parseExecutionTasks(await store.textFile(checklist));
    requireValue(canonical(tasks) === canonical(parseExecutionTasks(parent)), 'classic-checklist-mismatch', true);
    const status = await statusProjection(store, `${base}/status.yaml`, id, parent);
    binding = status.binding; projections[`${base}/status.yaml`] = digest(status.projection);
  }
  roots.push(paths.specs, '.ai-factory/config.yaml', 'AGENTS.md', paths.rules_file, paths.rules,
    '.ai-factory/skill-context', `${paths.qa}/${id}`, ...extraPaths);
  for (const key of ['description', 'architecture', 'generated_rules']) if (paths[key]) roots.push(paths[key]);
  const sources = Object.create(null);
  for (const p of [...new Set(roots)].sort()) sources[p] = own(projections, p) ? { [p]: projections[p] } : await store.inventory(p);
  const namespace = { kind: selection.mode === 'openspec' ? 'openspec' : 'ai-factory-classic', id, entrypoint, checklist, binding };
  return { ...namespace, namespace, namespace_digest: digest(namespace), context: { digest: digest(sources), sources }, projections, tasks,
    protected_paths: [...new Set(['.git', '.ai-factory', 'openspec', ...Object.values(paths)])].sort() };
}

export function selectExecutionTask(source, id, role, contextPaths) {
  const task = source.tasks.find(task => task.id === id);
  requireValue(task, 'unknown-or-ambiguous-task', true);
  requireValue(role !== 'implement' || !task.checked, 'task-already-completed', true);
  requireValue(role !== 'fix' || !task.checked || contextPaths.some(p => Object.keys(source.context.sources[p] ?? {}).length > 0), 'missing-finding-context', true);
  return task;
}

export async function validateExecutionScope(store, paths, source, exact = false) {
  requireValue(stringList(paths).length > 0);
  for (const value of paths) {
    const p = portablePath(value).toLowerCase();
    requireValue(!source.protected_paths.some(root => {
      const r = root.toLowerCase(); return p === r || p.startsWith(r+'/') || r.startsWith(p+'/');
    }), 'protected-scope');
    const target = await store.target(value);
    if (exact) {
      const info = await lstat(target).catch(e => { if (e.code === 'ENOENT') return null; throw e; }); requireValue(!info || info.isFile(), 'exact-files-required');
      let parent=store.root;
      for(const part of value.split('/')) {
        const names=await readdir(parent).catch(e=>{if(e.code==='ENOENT')return [];throw e;});
        requireValue(names.length<=10000,'too-many-files');
        const aliases=names.filter(n=>n.toLowerCase()===part.toLowerCase());
        requireValue(!aliases.length || (aliases.length===1 && aliases[0]===part),'path-case-alias');
        parent=path.join(parent,part);
      }
    }
  }
  return [...paths].sort();
}
