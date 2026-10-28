// Common plan resolver (ADR 0005 B.1). Resolves a versioned plan context from
// an AI Factory plan identity through a methodology adapter. Canonical ownership
// stays with the plan; this module returns a derived context bound to exact
// source revisions.
import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolveActiveChange, normalizeChangeId } from './active-change-resolver.mjs';
import { readProviderFile, writeProviderFile } from './provider-files.mjs';
import { ensureRuntimeGitignore } from './runtime-gitignore.mjs';
import { selectSddProfile, validateSddInputs, validateSddPolicy } from './sdd-profiles.mjs';
import { parseSimpleYaml } from './aif-artifact-sync.mjs';
import { parseToolConfig } from './tool-config.mjs';
import { discoverLegacyPlans } from './legacy-plan-migration.mjs';

const ADAPTER_DIR = new URL('../adapters/', import.meta.url);

export function planResolverError(code, errors = [{ code }]) {
  const error = new Error(code);
  error.planResolverCode = code;
  error.planResolverErrors = errors.map(({ code: value }) => ({ code: value }));
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
  const known = await listAdapters();
  if (!known.includes(methodology)) throw planResolverError('unknown-methodology');
  const safe = methodology.replace(/[^a-z0-9_-]/g, '');
  const file = pathToFileURL(path.join(fileURLToPath(ADAPTER_DIR), `${safe}-plan-adapter.mjs`)).href;
  try {
    const module = await import(file);
    if (!module.createAdapter) throw planResolverError('adapter_missing_factory');
    return module.createAdapter();
  } catch (error) {
    if (error.planResolverCode) throw error;
    throw planResolverError('adapter_load_failed');
  }
}

export async function resolvePlanContext(options = {}) {
  try {
    const root = path.resolve(options.rootDir ?? process.cwd());
    const target = await resolvePlanTarget({ ...options, rootDir: root });
    const { changeId, methodology } = target;
    const adapter = await loadAdapter(methodology);
    const adapterOptions = { ...options, nativeTarget: options.changeId };
    const identity = await adapter.resolveIdentity(root, changeId, adapterOptions);
    const validation = await adapter.validate(root, identity, adapterOptions);
    if (validation.length) throw planResolverError(validation[0].code, validation);
    const rawContext = await adapter.readContext(root, identity, adapterOptions);
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

export async function resolvePlanTarget(options = {}) {
  const root = path.resolve(options.rootDir ?? process.cwd());
  const read = options.readSource ?? ((root, file) => readProviderFile(root, file, 2 * 1024 * 1024));
  const bytes = await read(root, '.ai-factory/config.yaml');
  const raw = bytes?.toString('utf8') ?? '';
  const effective = parseToolConfig(raw);
  const methodology = options.methodology ?? (effective.mode === 'openspec' ? 'openspec' : 'aifactory');
  if (methodology === 'openspec') {
    if (options.changeId !== undefined && !normalizeChangeId(options.changeId).ok) throw planResolverError('invalid-change-id');
    const resolution = await resolveActiveChange({ ...options, rootDir: root, cwd: options.cwd ?? root });
    if (!resolution.ok) throw planResolverError('active_change_unresolved');
    return { ...resolution, methodology };
  }
  if (options.changeId !== undefined) {
    if (typeof options.changeId !== 'string' || !options.changeId) throw planResolverError('invalid-change-id');
    let value = options.changeId.replace(/^@/, '').replaceAll('\\', '/');
    const config = parseSimpleYaml(raw);
    const plans = (config.paths?.plans ?? '.ai-factory/plans').replaceAll('\\', '/').replace(/\/$/, '');
    const fast = (config.paths?.plan ?? '.ai-factory/PLAN.md').replaceAll('\\', '/');
    if (value === fast) value = path.posix.basename(fast, '.md');
    else if (value.startsWith(`${plans}/`)) value = value.slice(plans.length + 1).replace(/\/(?:index|task|context|rules|verify|explore)\.md$|\/status\.yaml$|\.md$|\/$/g, '');
    const normalized = normalizeChangeId(value);
    if (!normalized.ok) throw planResolverError('invalid-change-id');
    return { ok: true, changeId: normalized.changeId, methodology, source: 'explicit', warnings: [], errors: [] };
  }
  const config = parseSimpleYaml(raw);
  const discovery = await discoverLegacyPlans({ rootDir: root, plansDir: config.paths?.plans ?? '.ai-factory/plans', useRecordedLegacyPlanSource: false });
  if (!discovery.ok) throw planResolverError(discovery.errors[0]?.code ?? 'active_change_unresolved', discovery.errors);
  const pairs = discovery.plans.filter(plan => plan.shape === 'classic-pair');
  if (pairs.length !== 1) throw planResolverError(pairs.length ? 'ambiguous_active_plan' : 'active_change_unresolved');
  return { ok: true, changeId: pairs[0].id, methodology, source: 'single-classic-pair', warnings: [], errors: [] };
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
    requirements_reconciliation: raw.requirements_reconciliation ?? '',
    entrypoint: raw.entrypoint ?? identity.entrypoint ?? null,
    checklist: raw.checklist ?? identity.checklist ?? (identity.base ? `${identity.base}/tasks.md` : null),
    shape: raw.shape ?? null,
    upstream_handoff: raw.upstream_handoff ?? null,
    source_binding: raw.source_binding ?? null,
    sections: raw.sections ?? [],
    document_refs: raw.document_refs ?? [],
    document_projections: raw.document_projections ?? {},
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
      const selection = selectSddProfile(inputs, policy, { supportsUltra: raw.public_mode === 'ultra', methodology });
      defaults.sdd_profile = selection.profile;
      defaults.recommended_planning_mode = selection.recommended_planning_mode;
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
    const bytes = await (options.readSource ?? ((root, file) => readProviderFile(root, file, 2 * 1024 * 1024)))(root, file);
    if (bytes === null && kind === 'canonical') throw planResolverError('missing_plan_file');
    const projection = context.document_projections[file];
    if (bytes !== null) docs.push({ path: file, sha256: sha256(projection ?? bytes), kind,
      bytes: projection === undefined ? bytes.length : Buffer.byteLength(projection),
      ...(projection === undefined ? {} : { fidelity: 'projection' }) });
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
  let methodology;
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
      const outputRoot = path.resolve(options.rootDir ?? process.cwd());
      if (outputFile.replaceAll('\\', '/').startsWith('.ai-factory/state/')) await ensureRuntimeGitignore(outputRoot, '.ai-factory/state');
      await writeProviderFile(outputRoot, outputFile, context);
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
