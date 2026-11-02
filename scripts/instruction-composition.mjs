// Instruction composition producer/reader: aifhub.instruction_composition.v1.
// Single owner of the composition digest contract: canonicalization comes from
// workflow-state-store (no fourth serialization), JSON-domain checks reuse
// jsonValue, component hashes are sha256 over raw file bytes (CRLF/BOM as is).
// Honesty boundary: 'verified' proves deterministic bytes plus validated agent
// declarations; it never proves what a model actually read (see
// agent_consumption: 'not_observed_offline' in measure-entrypoints.mjs).
// The producer never throws on environmental failures: they degrade to
// 'unavailable'/'incomplete' with distinguishable degradation codes; only
// internal invariant violations stay exceptions.
import { randomUUID } from 'node:crypto';
import { lstat, open, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { canonical, digest, identifier, portablePath, requireValue, storeFor, WorkflowError } from './workflow-state-store.mjs';
import { jsonValue } from './qa-manifest-store.mjs';
import { PROMPT_REFERENCES, PROMPT_SUPPORT } from './prompt-reference-graph.mjs';
import { injectionMarkerPair, ledgerRuntimeDirs, publishedInjectionBlock, readInstallation } from './prompt-assets.mjs';

export const COMPOSITION_SCHEMA = 'aifhub.instruction_composition.v1';
export const COMPOSITION_INDEX_SCHEMA = 'aifhub.instruction_composition_index.v1';
export const PREPARED_SCHEMA = 'aifhub.instruction_composition_prepared.v1';
export const CONSUMPTION_SCHEMA = 'aifhub.instruction_composition_consumption.v1';
export const NORMALIZATION_VERSION = 1;
export const COMPOSITION_STATUSES = Object.freeze(['unavailable', 'incomplete', 'unverified', 'stale', 'verified']);
// Fixed role vocabulary (contract decision 5): roles discriminate layers.
export const COMPOSITION_ROLES = Object.freeze([
  'runtime_skill_entrypoint', 'runtime_agent_entrypoint',
  'runtime_injection_prepend', 'runtime_injection_append',
  'extension_injection_source',
  'project_skill_context_global', 'project_skill_context_build',
  'project_skill_context_individual', 'project_skill_context_legacy_fallback',
  'runtime_reference', 'extension_reference', 'extension_support', 'reference_candidate',
]);
const INJECTION_BLOCK_ROLES = Object.freeze(['runtime_injection_prepend', 'runtime_injection_append']);
const SKILL_CONTEXT_ROLES = Object.freeze(['project_skill_context_global', 'project_skill_context_build',
  'project_skill_context_individual', 'project_skill_context_legacy_fallback']);
const REFERENCE_ROLES = Object.freeze(['runtime_reference', 'extension_reference', 'extension_support', 'reference_candidate']);
// Required composition: declared published entrypoints, injected blocks, and
// their extension sources. Skill-context layers and references are observed
// inventory: absent optional context degrades without a required gap.
const REQUIRED_ROLES = Object.freeze(['runtime_skill_entrypoint', 'runtime_agent_entrypoint',
  ...INJECTION_BLOCK_ROLES, 'extension_injection_source']);
const BUILD_SKILL_BASENAMES = Object.freeze(['aif-fix', 'aif-implement', 'aif-plan', 'aif-verify', 'aif-improve']);
const EXTENSION_ROOT = '.ai-factory/extensions/aifhub-extension';
const MAX_COMPONENTS = 4096;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const HASH = /^[a-f0-9]{64}$/;
const REFERENCE_DIR = 'injections/references';

function compositionError(code, blocked = false) { return new WorkflowError(code, blocked); }
const now = () => new Date().toISOString();
const compareStrings = (a, b) => a < b ? -1 : a > b ? 1 : 0;

// Bounded project-relative read: rejects symlinked segments, hardlinks, and
// oversized files before any content read (FS class per workflow-mechanics).
async function readBounded(root, relative) {
  portablePath(relative);
  let current = root, total = 0;
  const parts = relative.split('/');
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    let info;
    try { info = await lstat(current); } catch (error) {
      if (error.code === 'ENOENT') return { code: 'absent' };
      if (error.code === 'EACCES' || error.code === 'EPERM') return { code: 'unreadable' };
      throw error;
    }
    if (info.isSymbolicLink()) return { code: 'unsafe' };
    if (index < parts.length - 1) {
      if (!info.isDirectory()) return { code: 'unsafe' };
      continue;
    }
    if (!info.isFile() || info.nlink !== 1 || info.size > MAX_FILE_BYTES) return { code: 'unsafe' };
  }
  try { return { code: null, data: await readFile(current) }; }
  catch (error) {
    // ENOENT between the per-segment lstat and the content read is a lost race,
    // not an internal bug (review F13).
    if (error.code === 'ENOENT') return { code: 'absent' };
    if (['EACCES', 'EPERM', 'EISDIR'].includes(error.code)) return { code: 'unreadable' };
    throw error;
  }
}

function runtimeId(value) { requireValue(typeof value === 'string' && /^\.[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) && !value.endsWith('.') , 'invalid-runtime-id'); return value; }

async function readExtensionManifest(root) {
  try { return JSON.parse(await readFile(path.join(root, `${EXTENSION_ROOT}/extension.json`), 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw compositionError('extension-manifest-corrupt');
  }
}

function configuredRuntimes(installation) {
  return Array.isArray(installation?.agents) && installation.agents.length
    ? installation.agents.map(agent => runtimeId(`.${agent?.id}`))
    : ['.agents', '.codex', '.claude'];
}

function requiredReferenceTargets(runtimeIdValue) {
  // Validatable set (contract decision 16): implement mode refs (both
  // methodologies), done triple, worker ref by runtime, QUESTION-TOOL example.
  const targets = [
    ...PROMPT_REFERENCES['injections/core/aif-implement-plan-folder.md'],
    ...PROMPT_REFERENCES['skills/aif-done/SKILL.md'],
    ...PROMPT_REFERENCES['skills/shared/QUESTION-TOOL.md'],
  ];
  const worker = runtimeIdValue === '.codex'
    ? PROMPT_REFERENCES['agent-files/codex/aifhub-implement-worker.toml']
    : PROMPT_REFERENCES['agent-files/claude/aifhub-implement-worker.md'];
  return Object.freeze([...targets, ...worker]);
}

async function collectRuntimeComposition(root, extension, runtimeIdValue, dirs) {
  const components = [], missing = [], injectionEntries = [], contextOrder = [], selectedReferences = [];
  let totalBytes = 0;
  const skillsRoot = dirs.skillsDir, agentsRoot = dirs.agentsDir;
  const runtimeAbsent = await lstat(path.join(root, skillsRoot)).then(info => !info.isDirectory()).catch(error => {
    if (error.code === 'ENOENT') return true;
    if (error.code === 'EACCES' || error.code === 'EPERM') return true;
    throw error;
  }) || await lstat(path.join(root, agentsRoot)).then(info => !info.isDirectory()).catch(error => {
    if (error.code === 'ENOENT') return true;
    if (error.code === 'EACCES' || error.code === 'EPERM') return true;
    throw error;
  });
  function addComponent(relative, data, role) {
    totalBytes += data.length;
    requireValue(totalBytes <= MAX_TOTAL_BYTES && components.length < MAX_COMPONENTS, 'composition-budget-exceeded');
    components.push({ path: relative, sha256: digest(data), role });
    return components.length - 1;
  }
  function markMissing(relative, role, reason) {
    missing.push({ path: relative, role, reason });
    return null;
  }
  async function component(relative, role) {
    const found = await readBounded(root, relative);
    if (found.code) { markMissing(relative, role, found.code); return null; }
    return addComponent(relative, found.data, role);
  }
  if (runtimeAbsent) {
    const manifest = {
      schema: COMPOSITION_SCHEMA, normalization_version: NORMALIZATION_VERSION,
      runtime: { id: runtimeIdValue, skills_dir: skillsRoot, agents_dir: agentsRoot },
      surface: { extension_root: EXTENSION_ROOT, skills_root: skillsRoot, agents_root: agentsRoot },
      components, injection_order: [], skill_context_order: [], selected_references: [],
      missing: [{ path: skillsRoot, role: 'runtime_skill_entrypoint', reason: 'runtime-absent' }],
      required_gaps: [`${skillsRoot}:runtime-absent`],
    };
    return { payload: manifest, status: 'unavailable' };
  }
  // Composition surface (review F1): published entrypoints and their
  // skill-context layers come from the union of extension.skills and the
  // injection targets — the main implement/fix/plan/verify entrypoints are
  // declared only as injection targets, and their full SKILL.md body outside
  // the marker block must change the digest too.
  const injections = [...(extension.injections ?? [])];
  requireValue(injections.every(injection => injection && typeof injection === 'object' && !Array.isArray(injection)
    && /^[\w-]+$/.test(String(injection?.target)) && ['prepend', 'append'].includes(injection?.position)), 'unsafe-composition-manifest');
  const skillTargets = [...new Set([
    ...(extension.skills ?? []).map(skill => path.posix.basename(String(skill ?? ''))),
    ...injections.map(injection => String(injection.target)),
  ])].sort(compareStrings);
  requireValue(skillTargets.every(target => /^[\w-]+$/.test(target)), 'unsafe-composition-manifest');
  for (const target of skillTargets) {
    await component(`${skillsRoot}/${target}/SKILL.md`, 'runtime_skill_entrypoint');
    // Published per-skill reference copies are observed inventory, not required.
    for (const [, targets] of Object.entries(PROMPT_REFERENCES)) {
      for (const reference of targets.filter(item => item.startsWith('skills/'))) {
        const published = `${skillsRoot}/${reference.replace(/^skills\//, '')}`;
        if (published.startsWith(`${skillsRoot}/${target}/`)) await component(published, 'runtime_reference');
      }
    }
  }
  const agentTargets = (extension.agentFiles ?? [])
    .filter(agent => `.${agent?.runtime}` === runtimeIdValue)
    .map(agent => String(agent?.target)).sort(compareStrings);
  requireValue(agentTargets.every(target => /^[\w.-]+$/.test(target)), 'unsafe-composition-manifest');
  for (const target of agentTargets) await component(`${agentsRoot}/${target}`, 'runtime_agent_entrypoint');
  const declaredInjections = injections.map((injection, declared_index) => ({ injection, declared_index }))
    .sort((a, b) => compareStrings(String(a.injection.target), String(b.injection.target))
      || compareStrings(String(a.injection.position), String(b.injection.position)) || a.declared_index - b.declared_index);
  const extensionSourceOf = injection => `${EXTENSION_ROOT}/${String(injection.file).replace(/^\.\//, '')}`;
  for (const { injection, declared_index } of declaredInjections) {
    await component(extensionSourceOf(injection), 'extension_injection_source');
    const published = `${skillsRoot}/${injection.target}/SKILL.md`;
    const found = await readBounded(root, published);
    if (found.code) { markMissing(published, injection.position === 'prepend' ? 'runtime_injection_prepend' : 'runtime_injection_append', found.code); continue; }
    let block;
    try { block = publishedInjectionBlock(found.data.toString('utf8'), injection.target, injection.position); }
    catch (error) {
      if (error.message === 'invalid-installed-marker-pair') { markMissing(published, injection.position === 'prepend' ? 'runtime_injection_prepend' : 'runtime_injection_append', 'unsafe'); continue; }
      throw error;
    }
    const [start] = injectionMarkerPair(injection.target, injection.position);
    const role = injection.position === 'prepend' ? 'runtime_injection_prepend' : 'runtime_injection_append';
    const componentIndex = addComponent(published, Buffer.from(block, 'utf8'), role);
    // Byte offset in the published file (review F8): Buffer indexOf over raw
    // bytes, not a UTF-16 index of the decoded string.
    injectionEntries.push({
      target: injection.target, position: injection.position, path: published,
      offset: found.data.indexOf(Buffer.from(start, 'utf8')), declared_index, component_index: componentIndex,
    });
  }
  // Document order (contract decision 15): ascending byte offset per published
  // file; the declarative extension.json index rides along per entry and stays
  // separate from the published ordinal.
  injectionEntries.sort((a, b) => compareStrings(a.path, b.path) || a.offset - b.offset || compareStrings(a.target, b.target) || compareStrings(a.position, b.position));
  const injectionOrder = injectionEntries.map((entry, ordinal) => ({ ...entry, ordinal }));
  const publishedSkillBases = skillTargets.filter(target => components.some(item => item.path === `${skillsRoot}/${target}/SKILL.md`));
  for (const target of publishedSkillBases) {
    const individual = `.ai-factory/skill-context/${target}/SKILL.md`;
    const legacy = `.ai-factory/skill-context/${target}-plus/SKILL.md`;
    const found = await readBounded(root, individual);
    if (!found.code) {
      addComponent(individual, found.data, 'project_skill_context_individual');
      contextOrder.push({ path: individual, role: 'project_skill_context_individual' });
    } else {
      const fallback = await readBounded(root, legacy);
      if (!fallback.code) {
        addComponent(legacy, fallback.data, 'project_skill_context_legacy_fallback');
        contextOrder.push({ path: legacy, role: 'project_skill_context_legacy_fallback' });
      }
    }
  }
  if (skillTargets.some(target => BUILD_SKILL_BASENAMES.includes(target))) {
    const build = '.ai-factory/skill-context/build-skill-context.md';
    const found = await readBounded(root, build);
    if (!found.code) { addComponent(build, found.data, 'project_skill_context_build'); contextOrder.push({ path: build, role: 'project_skill_context_build' }); }
  }
  const global = '.ai-factory/skill-context/global-skill-context.md';
  const globalFound = await readBounded(root, global);
  if (!globalFound.code) { addComponent(global, globalFound.data, 'project_skill_context_global'); contextOrder.push({ path: global, role: 'project_skill_context_global' }); }
  // Selected references: declarative closure of PROMPT_REFERENCES for this
  // surface (design fix) — never a runtime text-condition choice.
  const declaredTargets = new Set(Object.values(PROMPT_REFERENCES).flat());
  for (const [source, targets] of Object.entries(PROMPT_REFERENCES)) {
    for (const reference of targets) {
      const componentIndex = await component(`${EXTENSION_ROOT}/${reference}`, 'extension_reference');
      if (componentIndex !== null) selectedReferences.push({ source, target: reference, component_index: componentIndex });
    }
  }
  for (const support of PROMPT_SUPPORT) await component(`${EXTENSION_ROOT}/${support}`, 'extension_support');
  // Inventory: undeclared reference files stay candidates (contract decision 16).
  const candidateRoot = `${EXTENSION_ROOT}/${REFERENCE_DIR}`;
  const walk = async relative => {
    const info = await lstat(path.join(root, relative)).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!info) return;
    requireValue(!info.isSymbolicLink() && info.isDirectory(), 'unsafe-composition-manifest');
    for (const entry of (await readdir(path.join(root, relative), { withFileTypes: true })).sort((a, b) => compareStrings(a.name, b.name))) {
      const child = `${relative}/${entry.name}`;
      if (entry.isDirectory()) await walk(child);
      else {
        // Declared targets are inventoried as extension_reference above; every
        // other non-directory entry must be visible as a component or a
        // missing/unsafe record instead of silently disappearing from the
        // candidate inventory (review F16).
        if (declaredTargets.has(`${REFERENCE_DIR}/${child.slice(candidateRoot.length + 1)}`)) continue;
        const found = await readBounded(root, child);
        if (found.code) markMissing(child, 'reference_candidate', found.code);
        else addComponent(child, found.data, 'reference_candidate');
      }
    }
  };
  await walk(candidateRoot);
  const requiredMissing = missing.filter(entry => REQUIRED_ROLES.includes(entry.role));
  const status = requiredMissing.length ? 'incomplete' : 'verified';
  return {
    payload: {
      schema: COMPOSITION_SCHEMA, normalization_version: NORMALIZATION_VERSION,
      runtime: { id: runtimeIdValue, skills_dir: skillsRoot, agents_dir: agentsRoot },
      surface: { extension_root: EXTENSION_ROOT, skills_root: skillsRoot, agents_root: agentsRoot },
      components, injection_order: injectionOrder, skill_context_order: contextOrder,
      selected_references: selectedReferences, missing,
      required_gaps: requiredMissing.map(entry => `${entry.path}:${entry.reason}`),
    },
    status,
  };
}

function unavailable(degradation, status = 'unavailable') {
  return { ok: true, status, degradation, digest: null, index: null, manifests: [] };
}

export async function buildCompositionBaseline(rootDir = process.cwd()) {
  try {
    const root = path.resolve(rootDir);
    let installation;
    try { installation = await readInstallation(root); }
    catch { return unavailable('ledger-corrupt'); }
    if (installation === null) return unavailable('ledger-absent');
    const extension = await readExtensionManifest(root);
    if (extension === null) return unavailable('extension-unavailable');
    // Malformed-but-valid JSON degrades instead of throwing (review F13 /
    // devin blocker): wrong shapes are producer-environmental failures.
    requireValue(extension && typeof extension === 'object' && !Array.isArray(extension), 'extension-manifest-corrupt');
    for (const field of ['skills', 'injections', 'agentFiles']) {
      requireValue(extension[field] === undefined || Array.isArray(extension[field]), 'extension-manifest-corrupt');
    }
    if (!(extension.skills?.length || extension.injections?.length || extension.agentFiles?.length)) {
      return unavailable('extension-surface-empty');
    }
    const runtimes = configuredRuntimes(installation);
    // ledgerRuntimeDirs throws a plain Error on unsafe installed layouts; the
    // producer degrades instead of surfacing it as an exception.
    let dirs;
    try { dirs = ledgerRuntimeDirs(installation, runtimes); }
    catch { return unavailable('invalid-installed-layout'); }
    const manifests = [];
    for (const runtime of runtimes.slice().sort(compareStrings)) {
      const collected = await collectRuntimeComposition(root, extension, runtime, dirs[runtime]);
      manifests.push({ runtime_id: runtime, payload: collected.payload, status: collected.status, manifest_digest: digest(collected.payload) });
    }
    const index = {
      schema: COMPOSITION_INDEX_SCHEMA, normalization_version: NORMALIZATION_VERSION,
      compositions: manifests.map(entry => ({
        runtime_id: entry.runtime_id, manifest_digest: entry.manifest_digest,
        manifest_ref: `compositions/manifests/${entry.manifest_digest}.json`, status: entry.status,
      })),
    };
    const worst = manifests.some(entry => entry.status === 'unavailable') ? 'unavailable'
      : manifests.some(entry => entry.status === 'incomplete') ? 'incomplete' : 'verified';
    return { ok: true, status: worst, degradation: null, digest: digest(index), index, manifests };
  } catch (error) {
    // Producer never throws on environmental failures (design: producer never
    // throws); invariant violations must surface honestly instead.
    if (error instanceof WorkflowError) return unavailable(error.code);
    if (error instanceof SyntaxError) return unavailable('ledger-corrupt');
    if (['EACCES', 'EPERM', 'EISDIR', 'EMFILE', 'ENFILE'].includes(error.code)) return unavailable('composition-unreadable');
    throw error;
  }
}

export function validateCompositionManifest(value) {
  requireValue(value && typeof value === 'object' && !Array.isArray(value), 'invalid-composition-manifest');
  requireValue(Object.keys(value).length === 10, 'invalid-composition-manifest');
  requireValue(value.schema === COMPOSITION_SCHEMA && value.normalization_version === NORMALIZATION_VERSION, 'invalid-composition-manifest');
  requireValue(value.runtime && typeof value.runtime === 'object' && !Array.isArray(value.runtime)
    && Object.keys(value.runtime).length === 3
    && typeof value.runtime.id === 'string' && typeof value.runtime.skills_dir === 'string' && typeof value.runtime.agents_dir === 'string', 'invalid-composition-manifest');
  runtimeId(value.runtime.id);
  for (const dir of [value.runtime.skills_dir, value.runtime.agents_dir]) portablePath(dir);
  requireValue(value.surface && typeof value.surface === 'object' && !Array.isArray(value.surface)
    && canonical(value.surface) === canonical({
      extension_root: EXTENSION_ROOT, skills_root: value.runtime.skills_dir, agents_root: value.runtime.agents_dir,
    }), 'invalid-composition-surface');
  requireValue(Array.isArray(value.components) && value.components.length <= MAX_COMPONENTS, 'invalid-composition-manifest');
  const seen = new Set();
  const nonInjectionPaths = new Set();
  for (const item of value.components) {
    requireValue(item && typeof item === 'object' && !Array.isArray(item) && Object.keys(item).length === 3, 'invalid-composition-manifest');
    portablePath(item.path);
    requireValue(HASH.test(item.sha256) && COMPOSITION_ROLES.includes(item.role), 'invalid-composition-manifest');
    requireValue(!seen.has(`${item.path}\u0000${item.sha256}\u0000${item.role}`), 'invalid-composition-manifest');
    seen.add(`${item.path}\u0000${item.sha256}\u0000${item.role}`);
    // Published files appear once outside marker-block roles; blocks of the
    // same published file may repeat with distinct hashes.
    if (INJECTION_BLOCK_ROLES.includes(item.role)) continue;
    requireValue(!nonInjectionPaths.has(item.path), 'invalid-composition-manifest');
    nonInjectionPaths.add(item.path);
  }
  requireValue(Array.isArray(value.injection_order) && value.injection_order.length <= MAX_COMPONENTS, 'invalid-composition-manifest');
  let previous = null;
  for (const entry of value.injection_order) {
    requireValue(entry && typeof entry === 'object' && !Array.isArray(entry) && Object.keys(entry).length === 7, 'invalid-composition-manifest');
    requireValue(/^[\w-]+$/.test(entry.target) && ['prepend', 'append'].includes(entry.position), 'invalid-composition-manifest');
    portablePath(entry.path);
    requireValue(Number.isSafeInteger(entry.offset) && entry.offset >= 0
      && Number.isSafeInteger(entry.ordinal) && entry.ordinal >= 0
      && Number.isSafeInteger(entry.declared_index) && entry.declared_index >= 0
      && Number.isSafeInteger(entry.component_index) && entry.component_index >= 0
      && entry.component_index < value.components.length, 'invalid-composition-manifest');
    const component = value.components[entry.component_index];
    requireValue(component.path === entry.path && component.role === (entry.position === 'prepend' ? 'runtime_injection_prepend' : 'runtime_injection_append'), 'invalid-composition-manifest');
    if (previous) requireValue(previous.path < entry.path || (previous.path === entry.path && previous.offset <= entry.offset), 'invalid-composition-manifest');
    previous = entry;
  }
  requireValue(new Set(value.injection_order.map(entry => entry.ordinal)).size === value.injection_order.length, 'invalid-composition-manifest');
  requireValue(Array.isArray(value.skill_context_order), 'invalid-composition-manifest');
  for (const entry of value.skill_context_order) {
    requireValue(entry && typeof entry === 'object' && !Array.isArray(entry) && Object.keys(entry).length === 2
      && SKILL_CONTEXT_ROLES.includes(entry.role), 'invalid-composition-manifest');
    portablePath(entry.path);
    requireValue(entry.role === 'project_skill_context_global' ? entry.path === '.ai-factory/skill-context/global-skill-context.md'
      : entry.role === 'project_skill_context_build' ? entry.path === '.ai-factory/skill-context/build-skill-context.md'
      : entry.role === 'project_skill_context_individual' ? /^\.ai-factory\/skill-context\/[\w-]+\/SKILL\.md$/.test(entry.path)
      : /^\.ai-factory\/skill-context\/[\w-]+-plus\/SKILL\.md$/.test(entry.path), 'invalid-composition-manifest');
    requireValue(value.components.some(item => item.path === entry.path && item.role === entry.role), 'invalid-composition-manifest');
  }
  requireValue(Array.isArray(value.selected_references), 'invalid-composition-manifest');
  for (const entry of value.selected_references) {
    requireValue(entry && typeof entry === 'object' && !Array.isArray(entry) && Object.keys(entry).length === 3
      && typeof entry.source === 'string' && typeof entry.target === 'string', 'invalid-composition-manifest');
    portablePath(entry.source); portablePath(entry.target);
    requireValue(Number.isSafeInteger(entry.component_index) && entry.component_index >= 0
      && entry.component_index < value.components.length, 'invalid-composition-manifest');
    const component = value.components[entry.component_index];
    requireValue(component.path === `${EXTENSION_ROOT}/${entry.target}` && component.role === 'extension_reference', 'invalid-composition-manifest');
  }
  requireValue(Array.isArray(value.missing) && Array.isArray(value.required_gaps), 'invalid-composition-manifest');
  for (const entry of value.missing) {
    requireValue(entry && typeof entry === 'object' && !Array.isArray(entry) && Object.keys(entry).length === 3
      && COMPOSITION_ROLES.includes(entry.role) && ['absent', 'unreadable', 'unsafe', 'runtime-absent'].includes(entry.reason), 'invalid-composition-manifest');
    portablePath(entry.path);
  }
  requireValue(value.required_gaps.every(gap => typeof gap === 'string' && value.missing.some(entry => `${entry.path}:${entry.reason}` === gap)), 'invalid-composition-manifest');
  requireValue(value.missing.some(entry => entry.reason === 'runtime-absent') ? value.components.length === 0 : true, 'invalid-composition-manifest');
  return value;
}

export function compositionStatus(value) {
  requireValue(value && typeof value === 'object' && !Array.isArray(value), 'invalid-composition-manifest');
  if (value.missing.some(entry => entry.reason === 'runtime-absent')) return 'unavailable';
  return value.missing.some(entry => REQUIRED_ROLES.includes(entry.role)) ? 'incomplete' : 'verified';
}

export function validateCompositionIndex(value) {
  requireValue(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 3, 'invalid-composition-index');
  requireValue(value.schema === COMPOSITION_INDEX_SCHEMA && value.normalization_version === NORMALIZATION_VERSION, 'invalid-composition-index');
  requireValue(Array.isArray(value.compositions) && value.compositions.length <= 64, 'invalid-composition-index');
  let previous = null;
  for (const entry of value.compositions) {
    requireValue(entry && typeof entry === 'object' && !Array.isArray(entry) && Object.keys(entry).length === 4, 'invalid-composition-index');
    runtimeId(entry.runtime_id);
    requireValue(HASH.test(entry.manifest_digest) && COMPOSITION_STATUSES.includes(entry.status), 'invalid-composition-index');
    portablePath(entry.manifest_ref);
    requireValue(entry.manifest_ref === `compositions/manifests/${entry.manifest_digest}.json`, 'invalid-composition-index');
    if (previous) requireValue(previous.runtime_id < entry.runtime_id, 'invalid-composition-index');
    previous = entry;
  }
  return value;
}

export async function compositionStore(rootDir, changeId) {
  const store = await storeFor(rootDir);
  identifier(changeId);
  const base = `.ai-factory/state/${changeId}/compositions`;
  async function bytes(relative) { return store.bytes(portablePath(relative)); }
  async function readJson(relative) {
    const data = await bytes(relative);
    if (data === null) return null;
    try { return JSON.parse(data.toString('utf8')); } catch { requireValue(false, 'invalid-composition-json', true); }
  }
  async function writeImmutable(relative, value) {
    const data = Buffer.from(`${canonical(jsonValue(value))}\n`);
    const filename = await store.target(relative, true);
    let handle;
    try { handle = await open(filename, 'wx', 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      requireValue((await bytes(relative))?.equals(data), 'immutable-conflict', true);
      return false;
    }
    try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
    return true;
  }
  return {
    ...store,
    compositionsRoot: base,
    async writeIndex(value) {
      validateCompositionIndex(value);
      const indexDigest = digest(value);
      await writeImmutable(`${base}/indexes/${indexDigest}.json`, value);
      return indexDigest;
    },
    async writeManifest(value) {
      validateCompositionManifest(value);
      const manifestDigest = digest(value);
      await writeImmutable(`${base}/manifests/${manifestDigest}.json`, value);
      return manifestDigest;
    },
    // Readers validate the stored shape and re-bind content to the digest in
    // the filename: a CAS file tampered after creation is rejected (review F14).
    readIndex: async indexDigest => {
      requireValue(HASH.test(indexDigest), 'invalid-composition-index', true);
      const value = await readJson(`${base}/indexes/${indexDigest}.json`);
      if (value !== null) { validateCompositionIndex(value); requireValue(digest(value) === indexDigest, 'composition-digest-mismatch', true); }
      return value;
    },
    readManifest: async manifestDigest => {
      requireValue(HASH.test(manifestDigest), 'invalid-composition-manifest', true);
      const value = await readJson(`${base}/manifests/${manifestDigest}.json`);
      if (value !== null) { validateCompositionManifest(value); requireValue(digest(value) === manifestDigest, 'composition-digest-mismatch', true); }
      return value;
    },
    preparedPath: (attemptId, runtimeIdValue) => `${base}/attempts/${identifier(attemptId)}/${portablePath(runtimeIdValue)}/prepared.json`,
    consumptionPath: (attemptId, runtimeIdValue, consumptionId) => `${base}/attempts/${identifier(attemptId)}/${portablePath(runtimeIdValue)}/consumptions/${identifier(consumptionId)}.json`,
    readPrepared: async (attemptId, runtimeIdValue) => {
      const value = await readJson(`${base}/attempts/${identifier(attemptId)}/${portablePath(runtimeIdValue)}/prepared.json`);
      if (value !== null) validatePrepared(value);
      return value;
    },
    async readConsumptions(attemptId, runtimeIdValue) {
      const directory = `${base}/attempts/${identifier(attemptId)}/${portablePath(runtimeIdValue)}/consumptions`;
      const entries = await readdir(await store.target(directory)).catch(error => {
        if (error.code === 'ENOENT') return [];
        throw error;
      });
      const records = [];
      for (const name of entries.sort()) {
        requireValue(name.endsWith('.json'), 'invalid-composition-json', true);
        const record = await readJson(`${directory}/${name}`);
        requireValue(record?.consumption_id === name.slice(0, -5), 'invalid-composition-json', true);
        records.push(record);
      }
      return records;
    },
    writePrepared: async (attemptId, runtimeIdValue, value) => {
      validatePrepared(value);
      await writeImmutable(`${base}/attempts/${identifier(attemptId)}/${portablePath(runtimeIdValue)}/prepared.json`, value);
      return value;
    },
    writeConsumption: async (attemptId, runtimeIdValue, value) => {
      validateConsumption(value);
      await writeImmutable(`${base}/attempts/${identifier(attemptId)}/${portablePath(runtimeIdValue)}/consumptions/${value.consumption_id}.json`, value);
      return value;
    },
  };
}

function validatePrepared(value) {
  // No timestamp: the record is fully derived from the manifest and index, so
  // retries produce byte-identical CAS content (review F15).
  requireValue(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 10, 'invalid-composition-prepared');
  requireValue(value.schema === PREPARED_SCHEMA, 'invalid-composition-prepared');
  identifier(value.attempt_id); runtimeId(value.runtime_id); identifier(value.change_id);
  requireValue(HASH.test(value.index_digest) && HASH.test(value.manifest_digest) && COMPOSITION_STATUSES.includes(value.status), 'invalid-composition-prepared');
  requireValue(Array.isArray(value.components) && value.components.length <= MAX_COMPONENTS, 'invalid-composition-prepared');
  for (const item of value.components) {
    requireValue(item && typeof item === 'object' && !Array.isArray(item) && Object.keys(item).length === 3
      && COMPOSITION_ROLES.includes(item.role) && HASH.test(item.sha256), 'invalid-composition-prepared');
    portablePath(item.path);
  }
  // Marker selectors ride along so consumption can re-extract block bytes;
  // required gaps ride along so consumption inherits prepared incompleteness.
  requireValue(Array.isArray(value.injection_order) && value.injection_order.length <= MAX_COMPONENTS, 'invalid-composition-prepared');
  for (const entry of value.injection_order) {
    requireValue(entry && typeof entry === 'object' && !Array.isArray(entry) && Object.keys(entry).length === 7
      && ['prepend', 'append'].includes(entry.position)
      && Number.isSafeInteger(entry.component_index) && entry.component_index >= 0
      && entry.component_index < value.components.length, 'invalid-composition-prepared');
    portablePath(entry.path);
  }
  requireValue(Array.isArray(value.required_gaps) && value.required_gaps.length <= MAX_COMPONENTS
    && value.required_gaps.every(gap => typeof gap === 'string' && gap.length > 0), 'invalid-composition-prepared');
  return value;
}

function validateConsumption(value) {
  requireValue(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === (value.predecessor_consumption_id === undefined ? 13 : 14), 'invalid-composition-consumption');
  requireValue(value.schema === CONSUMPTION_SCHEMA, 'invalid-composition-consumption');
  identifier(value.attempt_id); runtimeId(value.runtime_id); identifier(value.change_id); identifier(value.consumption_id);
  requireValue(HASH.test(value.index_digest) && HASH.test(value.manifest_digest) && COMPOSITION_STATUSES.includes(value.status), 'invalid-composition-consumption');
  requireValue(value.assessment && typeof value.assessment === 'object' && !Array.isArray(value.assessment)
    && Object.keys(value.assessment).length === 3
    && ['pass', 'fail'].includes(value.assessment.completeness)
    && ['pass', 'stale'].includes(value.assessment.freshness)
    && ['pass', 'fail', 'unverified'].includes(value.assessment.declaration_verification), 'invalid-composition-consumption');
  requireValue(Array.isArray(value.reasons) && value.reasons.length <= 100
    && value.reasons.every(reason => typeof reason === 'string' && /^[a-z0-9][a-z0-9._:/-]{0,199}$/i.test(reason)), 'invalid-composition-consumption');
  requireValue(Array.isArray(value.rehash) && value.rehash.length <= MAX_COMPONENTS, 'invalid-composition-consumption');
  for (const entry of value.rehash) {
    requireValue(entry && typeof entry === 'object' && !Array.isArray(entry) && Object.keys(entry).length === 5
      && typeof entry.match === 'boolean' && COMPOSITION_ROLES.includes(entry.role)
      && (entry.observed_sha256 === null || HASH.test(entry.observed_sha256)) && HASH.test(entry.expected_sha256), 'invalid-composition-consumption');
    portablePath(entry.path);
  }
  requireValue(value.declaration === null || (value.declaration && typeof value.declaration === 'object' && !Array.isArray(value.declaration)
    && Object.keys(value.declaration).length === 1 && Array.isArray(value.declaration.references)
    && value.declaration.references.length <= 1000), 'invalid-composition-consumption');
  if (value.declaration) {
    // Duplicate paths are a semantic verdict (declaration-duplicate-or-malformed,
    // completeness fail), recorded in the immutable record — not a shape error.
    for (const reference of value.declaration.references) {
      requireValue(reference && typeof reference === 'object' && !Array.isArray(reference)
        && Object.keys(reference).length === 2 && HASH.test(reference.sha256), 'invalid-composition-consumption');
      portablePath(reference.path);
    }
  }
  if (value.predecessor_consumption_id !== undefined) identifier(value.predecessor_consumption_id);
  requireValue(typeof value.created_at === 'string' && Number.isFinite(Date.parse(value.created_at)), 'invalid-composition-consumption');
  return value;
}

// Persist the prepared baseline for one attempt: per-runtime prepared records
// pinned to the baseline index digest (contract decision 8). Idempotent: the
// CAS accepts identical rewrites and rejects conflicting ones.
export async function prepareCompositionAttempt(rootDir, changeId, attemptId, baseline, options = {}) {
  requireValue(baseline?.ok === true && typeof baseline.digest === 'string'
    && Array.isArray(baseline.manifests) && baseline.manifests.length > 0, 'composition-unavailable', true);
  identifier(attemptId);
  const store = await compositionStore(rootDir, changeId);
  const prepared = [];
  for (const manifest of baseline.manifests) {
    await store.writeManifest(manifest.payload);
    const record = {
      schema: PREPARED_SCHEMA, change_id: changeId, attempt_id: attemptId, runtime_id: manifest.runtime_id,
      index_digest: baseline.digest, manifest_digest: manifest.manifest_digest, status: manifest.status,
      components: manifest.payload.components, injection_order: manifest.payload.injection_order,
      required_gaps: manifest.payload.required_gaps,
    };
    await store.writePrepared(attemptId, manifest.runtime_id, record);
    prepared.push(record);
  }
  await store.writeIndex(baseline.index);
  return { index_digest: baseline.digest, prepared };
}

// Consumption gate: re-hash the whole prepared surface through the
// file-identity pattern (readLeaf), validate the agent declaration against the
// prepared set (declared sha must equal the prepared hash AND the current
// bytes), inherit prepared incompleteness, and persist one immutable
// consumption record (contract decision 8/9; review F6/F10).
export async function recordCompositionConsumption(rootDir, changeId, input) {
  const attemptId = identifier(input.attemptId);
  const runtimeIdValue = runtimeId(input.runtimeId);
  const store = await compositionStore(rootDir, changeId);
  const prepared = await store.readPrepared(attemptId, runtimeIdValue);
  requireValue(prepared, 'composition-prepared-missing', true);
  // A consumption bound to a pinned baseline index must use the prepared
  // record pinned to exactly that index (review F11).
  requireValue(input.expectedIndexDigest === undefined || prepared.index_digest === input.expectedIndexDigest, 'composition-prepared-mismatch', true);
  const reasons = [];
  const rehash = [];
  let freshness = 'pass';
  const markerFor = component => prepared.injection_order?.find(entry => entry.component_index === prepared.components.indexOf(component)
    && entry.path === component.path) ?? null;
  for (const component of prepared.components) {
    let observed = null;
    try {
      const leaf = await store.readLeaf(component.path);
      if (leaf !== null) {
        if (INJECTION_BLOCK_ROLES.includes(component.role)) {
          // Block identity: re-extract the exact bytes between marker pairs
          // from the current published file; whole-file equality is checked
          // separately through the entrypoint component. A broken marker pair
          // is a drift observation, not a gate crash (review F12).
          const marker = markerFor(component);
          const text = leaf.data.toString('utf8');
          try { observed = marker && text ? digest(Buffer.from(publishedInjectionBlock(text, marker.target, marker.position), 'utf8')) : null; }
          catch { observed = null; }
        } else observed = digest(leaf.data);
      }
    } catch (error) {
      if (!(error instanceof WorkflowError)) throw error;
      observed = null;
      reasons.push(`rehash-unsupported:${component.path}`);
    }
    const match = observed === component.sha256;
    if (!match) { freshness = 'stale'; reasons.push(`rehash-mismatch:${component.path}`); }
    rehash.push({ path: component.path, role: component.role, expected_sha256: component.sha256, observed_sha256: observed, match });
  }
  const byPath = new Map();
  for (const component of prepared.components) {
    if (INJECTION_BLOCK_ROLES.includes(component.role)) continue;
    if (!byPath.has(component.path)) byPath.set(component.path, component);
  }
  const runtimeRoot = skillsRootOf(prepared);
  const observedBytes = new Map();
  const currentHash = async componentPath => {
    if (observedBytes.has(componentPath)) return observedBytes.get(componentPath);
    let value = null;
    try {
      const leaf = await store.readLeaf(componentPath);
      value = leaf === null ? null : digest(leaf.data);
    } catch { value = null; }
    observedBytes.set(componentPath, value);
    return value;
  };
  // Prepared incompleteness is inherited: a partial prepared surface can never
  // attest a verified consumption (review F6).
  let completeness = prepared.status === 'verified' ? 'pass' : 'fail';
  if (prepared.status !== 'verified') {
    reasons.push(`prepared-${prepared.status}`);
    for (const gap of (prepared.required_gaps ?? []).slice(0, 20)) reasons.push(`prepared-gap:${gap}`);
  }
  const declaration = input.declaration === undefined ? null : input.declaration;
  let declarationVerification = 'unverified';
  let candidateDeclared = false;
  if (declaration !== null) {
    declarationVerification = 'pass';
    const references = declaration?.references;
    if (!Array.isArray(references)) {
      completeness = 'fail';
      declarationVerification = 'fail';
      reasons.push('declaration-malformed');
    } else {
      const seen = new Set();
      for (const reference of references) {
        const componentPath = typeof reference?.path === 'string' ? reference.path : null;
        if (componentPath === null || seen.has(componentPath)) { completeness = 'fail'; declarationVerification = 'fail'; reasons.push('declaration-duplicate-or-malformed'); continue; }
        seen.add(componentPath);
        const component = byPath.get(componentPath);
        // Namespace rule (design): runtime root and extension root are two
        // distinct namespaces; role and path must agree with each other.
        if (!component || (component.role.startsWith('runtime_') && !component.path.startsWith(`${runtimeRoot}/`))
          || (!component.role.startsWith('runtime_') && !component.path.startsWith(`${EXTENSION_ROOT}/`))) {
          completeness = 'fail'; declarationVerification = 'fail'; reasons.push('reference-outside-prepared'); continue;
        }
        const observed = await currentHash(componentPath);
        // Declared sha must equal the prepared hash (membership in the pinned
        // snapshot) and the current bytes (review F10): bytes changed after
        // prepare are attested stale by the rehash, never verified.
        if (observed !== reference.sha256 || component.sha256 !== reference.sha256) {
          completeness = 'fail'; declarationVerification = 'fail'; reasons.push(`reference-sha-mismatch:${componentPath}`); continue;
        }
        if (component.role === 'reference_candidate') candidateDeclared = true;
      }
      for (const required of requiredReferenceTargets(runtimeIdValue)) {
        const componentPath = `${EXTENSION_ROOT}/${required}`;
        if (!seen.has(componentPath)) { completeness = 'fail'; declarationVerification = 'fail'; reasons.push(`required-reference-undeclared:${componentPath}`); continue; }
        const component = byPath.get(componentPath);
        const observed = await currentHash(componentPath);
        const declared = references.find(reference => reference.path === componentPath);
        if (!observed || declared.sha256 !== observed || component.sha256 !== declared.sha256) {
          completeness = 'fail'; declarationVerification = 'fail'; reasons.push(`required-reference-sha-mismatch:${componentPath}`);
        }
      }
      if (completeness === 'pass' && candidateDeclared) { declarationVerification = 'unverified'; reasons.push('candidate-reference-unverified'); }
    }
  } else reasons.push('declaration-absent');
  const status = freshness === 'stale' ? 'stale' : completeness === 'fail' ? 'incomplete'
    : declarationVerification === 'unverified' ? 'unverified' : 'verified';
  const consumptionId = input.consumptionId ?? `consumption-${randomUUID()}`;
  const record = {
    schema: CONSUMPTION_SCHEMA, change_id: changeId, attempt_id: attemptId, runtime_id: runtimeIdValue,
    consumption_id: consumptionId, index_digest: prepared.index_digest, manifest_digest: prepared.manifest_digest,
    declaration, rehash, assessment: { completeness, freshness, declaration_verification: declarationVerification },
    status, reasons, created_at: input.now ?? now(),
    ...(input.predecessorConsumptionId !== undefined ? { predecessor_consumption_id: identifier(input.predecessorConsumptionId) } : {}),
  };
  await store.writeConsumption(attemptId, runtimeIdValue, record);
  return record;
}

function skillsRootOf(prepared) {
  const entry = prepared.components.find(item => item.role === 'runtime_skill_entrypoint');
  // Runtime namespace root: the first path segment of a published entrypoint
  // (e.g. '.claude' covers both '.claude/skills/...' and '.claude/agents/...').
  return entry ? entry.path.split('/')[0] : '';
}

// Same-runtime comparison only: different runtimes legitimately produce
// different digests for identical bytes (contract decision 3).
export function compositionDigestMatches(expected, observed) {
  if (typeof expected !== 'string' || typeof observed !== 'string') return false;
  return expected === observed;
}

// Update rebasing (contract decision: post-update-init): rebuild the baseline
// for every change directory that already owns a compositions namespace and
// append a new immutable index; old bindings stay addressable and read stale.
export async function rebaseCompositions(rootDir = process.cwd(), options = {}) {
  const root = path.resolve(rootDir);
  const results = [];
  let entries;
  try { entries = await readdir(path.join(root, '.ai-factory/state'), { withFileTypes: true }); }
  catch (error) {
    if (error.code === 'ENOENT') return results;
    throw error;
  }
  // The baseline does not depend on the change id: build it once and reuse it
  // for every change directory (review F17 perf).
  const baseline = await buildCompositionBaseline(root);
  for (const entry of entries.sort((a, b) => compareStrings(a.name, b.name))) {
    if (!entry.isDirectory()) continue;
    const changeId = entry.name;
    let hasCompositions = false;
    try { hasCompositions = (await lstat(path.join(root, '.ai-factory/state', changeId, 'compositions'))).isDirectory(); }
    catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    if (!hasCompositions) continue;
    if (!baseline.ok || baseline.digest === null) {
      results.push({ change_id: changeId, status: 'unavailable', degradation: baseline.degradation });
      continue;
    }
    const store = await compositionStore(root, changeId);
    for (const manifest of baseline.manifests) await store.writeManifest(manifest.payload);
    const indexDigest = await store.writeIndex(baseline.index);
    results.push({ change_id: changeId, status: baseline.status, index_digest: indexDigest, rebased_at: options.now ?? now() });
  }
  return results;
}
