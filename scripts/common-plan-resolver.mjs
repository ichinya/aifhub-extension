// Common plan resolver (ADR 0005 B.1). Resolves a versioned plan context from
// an AI Factory plan identity through a methodology adapter. Canonical ownership
// stays with the plan; this module returns a derived context bound to exact
// source revisions.
import { createHash } from 'node:crypto';
import { readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolveActiveChange, normalizeChangeId } from './active-change-resolver.mjs';
import { readProviderFile, safeProviderPath } from './provider-files.mjs';
import { validateSddInputs, validateSddPolicy } from './sdd-profiles.mjs';

const ADAPTER_DIR = new URL('../adapters/', import.meta.url);

export function planResolverError(code) {
  const error = new Error(code);
  error.planResolverCode = code;
  return error;
}

export const DEFAULT_ADAPTER_VERSION = '0.1.0';

export async function listAdapters() {
  try {
    const entries = await readdir(fileURLToPath(ADAPTER_DIR), { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('-plan-adapter.mjs'))
      .map((entry) => entry.name.replace(/-plan-adapter\.mjs$/, ''))
      .sort();
  } catch { return []; }
}

async function loadAdapter(methodology) {
  if (typeof methodology !== 'string' || !/^[a-z][a-z0-9_-]*$/.test(methodology)) throw planResolverError('invalid-methodology');
  const safe = methodology.replace(/[^a-z0-9_-]/g, '');
  const file = pathToFileURL(path.join(fileURLToPath(ADAPTER_DIR), `${safe}-plan-adapter.mjs`)).href;
  try {
    const module = await import(file);
    if (!module.createAdapter) throw planResolverError('adapter_missing_factory');
    return module.createAdapter();
  } catch (error) {
    if (error.code === 'ERR_MODULE_NOT_FOUND' || error.code === 'ENOENT') throw planResolverError('unknown-methodology');
    throw error;
  }
}

export async function resolvePlanContext(options = {}) {
  try {
    const root = path.resolve(options.rootDir ?? process.cwd());
    let changeId;
    if (options.changeId !== undefined) {
      const normalized = normalizeChangeId(options.changeId);
      if (!normalized.ok) throw planResolverError('invalid-change-id');
      changeId = normalized.changeId;
    } else {
      const resolution = await resolveActiveChange({ rootDir: root, cwd: options.cwd ?? root });
      if (!resolution.ok) throw planResolverError('active_change_unresolved');
      changeId = resolution.changeId;
    }
    const methodology = options.methodology ?? 'openspec';
    const adapter = await loadAdapter(methodology);
    const identity = await adapter.resolveIdentity(root, changeId, options);
    const rawContext = await adapter.readContext(root, identity, options);
    const context = await normalizePlanContext(rawContext, identity, changeId, methodology);
    context.documents = await resolveDocuments(root, identity, context, options);
    context.source_revision = computeSourceRevision(context.documents);
    return context;
  } catch (error) {
    if (error.planResolverCode) throw error;
    const code = typeof error.message === 'string' && /^[a-z0-9_-]+$/.test(error.message) ? error.message : 'plan_resolver_failed';
    throw planResolverError(code);
  }
}

async function normalizePlanContext(raw, identity, changeId, methodology) {
  const defaults = {
    schema: 'aifhub.plan_context.v1',
    plan_id: identity.planId ?? changeId,
    change_id: changeId,
    methodology,
    adapter_version: raw.adapter_version ?? DEFAULT_ADAPTER_VERSION,
    public_mode: raw.public_mode ?? null,
    sdd_profile: raw.sdd_profile ?? null,
    original_request: raw.original_request ?? '',
    requirements: {
      intent: '',
      target_outcome: '',
      constraints: [],
      assumptions: [],
      open_questions: [],
      ...(raw.requirements ?? {})
    },
    tasks: Array.isArray(raw.tasks) ? raw.tasks : [],
    acceptance_examples: Array.isArray(raw.acceptance_examples) ? raw.acceptance_examples : [],
    non_goals: Array.isArray(raw.non_goals) ? raw.non_goals : [],
    change_surface: {
      allowed: [],
      forbidden: [],
      ...(raw.change_surface ?? {})
    },
    documents: [],
    source_revision: '0'.repeat(64),
    sdd_inputs: raw.sdd_inputs ?? null,
    errors: Array.isArray(raw.errors) ? raw.errors : []
  };
  if (raw.sdd_inputs) {
    try {
      const inputs = validateSddInputs(raw.sdd_inputs);
      const policy = validateSddPolicy(raw.sdd_policy ?? {});
      const { selectSddProfile } = await import('./sdd-profiles.mjs');
      const selection = selectSddProfile(inputs, policy, { supportsUltra: raw.public_mode === 'ultra' });
      defaults.sdd_profile = selection.profile;
      defaults.public_mode = selection.recommended_planning_mode;
    } catch (error) {
      defaults.errors.push({ code: error.sddCode ?? error.planResolverCode ?? 'invalid-sdd-profile-selection' });
    }
  }
  return defaults;
}

async function resolveDocuments(root, identity, context, options) {
  const paths = new Set();
  const add = (file, kind) => { if (file) paths.add(JSON.stringify({ path: file, kind })); };
  for (const file of identity.documents ?? []) add(file, 'canonical');
  for (const task of context.tasks) if (task.source_path) add(task.source_path, 'canonical');
  for (const file of options.policyFiles ?? []) add(file, 'policy');
  for (const file of options.protectedFiles ?? []) add(file, 'protected');
  const docs = [];
  for (const key of paths) {
    const { path: file, kind } = JSON.parse(key);
    try {
      const bytes = await readProviderFile(root, file, 4 * 1024 * 1024);
      if (bytes !== null) docs.push({ path: file, sha256: sha256(bytes), kind, bytes: bytes.length });
    } catch { docs.push({ path: file, sha256: '', kind, bytes: 0 }); }
  }
  return docs.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function computeSourceRevision(documents) {
  const hashInput = JSON.stringify(documents.map(({ path, sha256, kind }) => ({ path, sha256, kind })));
  return sha256(Buffer.from(hashInput, 'utf8'));
}

function sha256(value) { return createHash('sha256').update(value).digest('hex'); }

export async function resolvePlanContextCommand(argv = process.argv.slice(2), options = {}) {
  let jsonOutput = false;
  let changeId;
  let methodology = 'openspec';
  let list = false;
  let outputFile;
  const seen = new Set();
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (seen.has(flag)) return invalid({ jsonOutput, stdout: options.stdout });
    seen.add(flag);
    if (flag === '--json') jsonOutput = true;
    else if (flag === '--change' && argv[i + 1] && !argv[i + 1].startsWith('--')) changeId = argv[++i];
    else if (flag === '--methodology' && argv[i + 1] && !argv[i + 1].startsWith('--')) methodology = argv[++i];
    else if (flag === '--output' && argv[i + 1] && !argv[i + 1].startsWith('--')) outputFile = argv[++i];
    else if (flag === 'list') list = true;
    else if (flag === 'resolve') { /* default action */ }
    else return invalid({ jsonOutput, stdout: options.stdout });
  }
  if (list) {
    const adapters = await listAdapters();
    const result = { ok: true, adapters };
    const output = jsonOutput ? `${JSON.stringify(result, null, 2)}\n` : adapters.join('\n') + '\n';
    (options.stdout ?? process.stdout).write(output);
    return 0;
  }
  try {
    const context = await resolvePlanContext({ ...options, changeId, methodology });
    if (outputFile) {
      const target = await safeProviderPath(options.rootDir ?? process.cwd(), outputFile);
      await writeFile(target.path, JSON.stringify(context, null, 2) + '\n');
    }
    const output = jsonOutput ? `${JSON.stringify(context, null, 2)}\n` : `Plan context: ${context.plan_id}\nmethodology: ${context.methodology}\nsource_revision: ${context.source_revision}\n`;
    (options.stdout ?? process.stdout).write(output);
    return context.errors.length > 0 ? 1 : 0;
  } catch (error) {
    const result = { ok: false, error: error.planResolverCode ?? 'plan_resolver_failed' };
    const output = jsonOutput ? `${JSON.stringify(result, null, 2)}\n` : `Plan resolver failed: ${result.error}\n`;
    (options.stdout ?? process.stdout).write(output);
    return 2;
  }
}

function invalid({ jsonOutput, stdout }) {
  const output = jsonOutput ? JSON.stringify({ ok: false, error: 'invalid_arguments' }) + '\n' : 'Plan resolver: invalid_arguments\n';
  (stdout ?? process.stdout).write(output);
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await resolvePlanContextCommand();
}
