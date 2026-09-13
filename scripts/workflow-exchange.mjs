// Cross-project exchange exports (issue #203 P2). Emits three versioned
// artifacts: registry-facing workflow profile metadata (aifhub#29), a
// per-change exchange bundle for orchestrator import (orkora#229), and an
// anonymized evaluation record. The helper reads canonical/runtime sources
// only; artifacts are written exclusively through the optional --output flag.
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveActiveChange, normalizeChangeId } from './active-change-resolver.mjs';
import { resolvePlanContext, listAdapters } from './common-plan-resolver.mjs';
import { inspectSessionBrief } from './session-brief.mjs';
import { parseStrictJson } from './json-strict.mjs';
import { readProviderFile, writeProviderFile } from './provider-files.mjs';
import { ensureRuntimeGitignore } from './runtime-gitignore.mjs';
import { SDD_GATES } from './sdd-profiles.mjs';

const EXCHANGE_BUNDLE_SCHEMA = 'aifhub.exchange_bundle.v1';
const WORKFLOW_PROFILE_SCHEMA = 'aifhub.workflow_profile_export.v1';
const EVALUATION_SCHEMA = 'aifhub.evaluation_export.v1';
const RUNNER_METRICS_SCHEMA = 'aifhub.runner_metrics.v1';
const DESIGN_CONTEXT_SCHEMA = 'aifhub.design_context.v1';
const EXPORTER_ID = 'aifhub-extension';
const EXTENSION_MANIFEST = new URL('../extension.json', import.meta.url);
const HASH = /^[a-f0-9]{64}$/;
const MAX_READ_BYTES = 4 * 1024 * 1024;
const MAX_REVIEWS = 64;
const MAX_REFERENCES = 1024;
const MAX_LABEL = 200;
const EXCHANGE_SALT_PATH = '.ai-factory/state/exchange/fingerprint-salt.json';

export const EVIDENCE_CLASSES = Object.freeze([
  'synthetic_fixture',
  'public_real_repository',
  'maintainer_controlled',
  'private_anonymized_aggregate',
  'community_submission'
]);

const DESIGN_SURFACE_KINDS = Object.freeze([
  'markdown', 'html', 'image', 'figma', 'storybook', 'live_url', 'other'
]);

// Baseline gates every SDD profile keeps (mirrors selectSddProfile). Project
// policy can only add gates; no profile may remove this floor.
const BASE_GATES = Object.freeze(['done', 'project_policy', 'tests', 'verify']);
const CONDITIONAL_GATES = Object.freeze(SDD_GATES.filter((gate) => !BASE_GATES.includes(gate)));

// Registry-facing catalog. `registry_depth` is the cross-project vocabulary:
// aifhub#29 and orkora#229 name the deep profile `full`; ADR 0004 reserves
// `full` for the public planning mode, so the internal `expanded` maps
// explicitly instead of colliding with the command token.
const PROFILE_CATALOG = Object.freeze([
  {
    id: 'direct', registry_depth: 'direct', recommended_mode: 'fast',
    intended_scope: ['trivial_non_behavioral'], risk_classes: ['low'],
    required_artifacts: [], conditional_artifacts: [],
    contract: 'Upstream fast-path handoff; no canonical change or brief is produced.'
  },
  {
    id: 'quick', registry_depth: 'quick', recommended_mode: 'full',
    intended_scope: ['bounded_change'], risk_classes: ['low', 'medium'],
    required_artifacts: ['proposal', 'session_brief', 'tasks'],
    conditional_artifacts: ['delta_specs', 'design'],
    contract: 'Compact canonical planning; delta_specs are required for behavior changes.'
  },
  {
    id: 'standard', registry_depth: 'standard', recommended_mode: 'full',
    intended_scope: ['multi_module_change'], risk_classes: ['medium'],
    required_artifacts: ['design', 'proposal', 'session_brief', 'tasks'],
    conditional_artifacts: ['delta_specs'],
    contract: 'Normal OpenSpec-native workflow across multiple modules or broad surfaces.'
  },
  {
    id: 'expanded', registry_depth: 'full', recommended_mode: 'full',
    intended_scope: ['cross_repository', 'migration', 'public_api', 'security_sensitive'],
    risk_classes: ['medium', 'high'],
    required_artifacts: ['design', 'proposal', 'session_brief', 'tasks'],
    conditional_artifacts: ['delta_specs'],
    contract: 'Expanded depth for high-risk or cross-repository work; named full in the registry vocabulary.'
  },
  {
    id: 'ultra', registry_depth: 'ultra', recommended_mode: 'ultra',
    intended_scope: ['maximum_depth'], risk_classes: ['high'],
    required_artifacts: ['design', 'proposal', 'session_brief', 'tasks'],
    conditional_artifacts: ['delta_specs'],
    contract: 'Existing AI Factory >=2.18 ultra depth/version contract.'
  },
  {
    id: 'tracer', registry_depth: 'tracer', recommended_mode: 'full',
    intended_scope: ['architecture_uncertainty'], risk_classes: ['medium', 'high'],
    required_artifacts: ['proposal', 'session_brief', 'tasks'],
    conditional_artifacts: ['delta_specs', 'design'],
    contract: 'Minimum vertical slice with explicit promote/discard/replan decision; cannot finalize as production.'
  },
  {
    id: 'research', registry_depth: 'research', recommended_mode: null,
    intended_scope: ['missing_information'], risk_classes: [],
    required_artifacts: [], conditional_artifacts: [],
    contract: 'Missing facts, unclear requirements, or unresolved questions return to explore before implementation.'
  }
]);

// Capability vocabulary follows aifhub#29 section 5. Support levels are
// honest: flags validated but not executed by any runtime stay declared-only.
const EXCHANGE_CAPABILITIES = Object.freeze([
  { id: 'session_brief', support: 'yes', provenance: 'probed', note: 'Deterministic compiler, digest binding, stale detection.' },
  { id: 'spec_lineage', support: 'yes', provenance: 'probed', note: 'Exact source inventory and revision digests per change.' },
  { id: 'plan_compliance', support: 'yes', provenance: 'probed', note: 'aifhub.plan_compliance.v1 drift receipts.' },
  { id: 'tracer_slice', support: 'yes', provenance: 'probed', note: 'aifhub.tracer_brief/findings/decision.v1 runtime.' },
  { id: 'fresh_context_review', support: 'partial', provenance: 'declared', note: 'Prepares review package and prepared receipt; reviewed outcome owner is not yet defined.' },
  { id: 'context_budget_reporting', support: 'partial', provenance: 'probed', note: 'source_bytes/brief_bytes measured; token_estimate stays null without model metadata.' },
  { id: 'structured_design_input', support: 'partial', provenance: 'declared', note: 'Optional design.context.json is inventoried, hashed, and surfaced to exchange consumers.' },
  { id: 'session_split', support: 'unknown', provenance: 'declared', note: 'context_policy flags are validated and echoed, not executed by a runtime.' },
  { id: 'independent_reviewer', support: 'unknown', provenance: 'declared', note: 'Packaged Claude/Codex reviewer agents exist; execution is external.' },
  { id: 'context_compaction', support: 'no', provenance: 'declared', note: 'Flag is validated only; no runtime compacts supporting context.' }
]);

// Provider-neutral artifact lineage vocabulary (aifhub#29 section 3).
// design_context is an extension kind pending registry vocabulary support.
const ARTIFACT_VOCABULARY = Object.freeze([
  { kind: 'change_spec', native: ['openspec/changes/<id>/proposal.md', 'openspec/changes/<id>/design.md', 'openspec/changes/<id>/specs/**'] },
  { kind: 'work_item_spec', native: ['openspec/changes/<id>/tasks.md'] },
  { kind: 'capability_spec', native: ['openspec/specs/**'] },
  { kind: 'session_brief', native: ['.ai-factory/state/<id>/context/session-brief.json'] },
  { kind: 'plan_compliance_receipt', native: ['.ai-factory/state/<id>/implementation/plan-compliance.json'] },
  { kind: 'review_receipt', native: ['.ai-factory/state/<id>/reviews/*/ai-cross-context-review.json'] },
  { kind: 'tracer_result', native: ['.ai-factory/state/<id>/tracer/*.json'] },
  { kind: 'design_context', native: ['openspec/changes/<id>/design.context.json'], extension: true }
]);

const CREDENTIAL_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,}|AKIA[A-Z0-9]{16})\b|\bBearer\s+[A-Za-z0-9._~-]{8,}|\b(?:password|api[_ -]?key|client[_ -]?secret|access[_ -]?token)\s*[:=]\s*[^\s,}]+/i;

export function exchangeError(code) {
  const error = new Error(code);
  error.exchangeCode = code;
  return error;
}

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

function json(value) { return JSON.stringify(value, null, 2); }

async function exporterVersion() {
  try {
    const manifest = parseStrictJson(await readFile(fileURLToPath(EXTENSION_MANIFEST), 'utf8'));
    return typeof manifest.version === 'string' ? manifest.version : 'unknown';
  } catch { return 'unknown'; }
}

async function readJsonIfExists(root, relative, { strict = false } = {}) {
  const bytes = await readProviderFile(root, relative, MAX_READ_BYTES);
  if (bytes === null) return null;
  try {
    return parseStrictJson(bytes.toString('utf8'));
  } catch (error) {
    if (strict) throw error;
    return null;
  }
}

async function readDesignContext(root, changeId, notes) {
  const relative = `openspec/changes/${changeId}/design.context.json`;
  const bytes = await readProviderFile(root, relative, MAX_READ_BYTES);
  if (bytes === null) return null;
  let parsed;
  try {
    parsed = parseStrictJson(bytes.toString('utf8'));
  } catch {
    notes.push({ code: 'invalid_design_context', detail: 'unparseable' });
    return null;
  }
  const errors = validateDesignContext(parsed);
  if (errors.length) {
    notes.push({ code: 'invalid_design_context', detail: errors.join(';') });
    return null;
  }
  return parsed;
}

export function validateDesignContext(input) {
  const errors = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) return ['not_an_object'];
  if (Object.keys(input).some((key) => !['schema', 'summary', 'surfaces'].includes(key))) errors.push('keys');
  if (input.schema !== DESIGN_CONTEXT_SCHEMA) errors.push('schema');
  if (input.summary !== undefined && (typeof input.summary !== 'string' || input.summary.length > 4000)) errors.push('summary');
  const surfaces = input.surfaces;
  if (!Array.isArray(surfaces) || surfaces.length > 64) return [...errors, 'surfaces'];
  for (const [index, surface] of surfaces.entries()) {
    if (!surface || typeof surface !== 'object' || Array.isArray(surface)) { errors.push(`surfaces[${index}]`); continue; }
    const keys = Object.keys(surface);
    if (keys.some((key) => !['id', 'kind', 'ref', 'sha256', 'description'].includes(key))) errors.push(`surfaces[${index}].keys`);
    if (typeof surface.id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,79}$/.test(surface.id)) errors.push(`surfaces[${index}].id`);
    if (!DESIGN_SURFACE_KINDS.includes(surface.kind)) errors.push(`surfaces[${index}].kind`);
    if (typeof surface.ref !== 'string' || !surface.ref || surface.ref.length > 512 || /[\x00-\x1f]/.test(surface.ref)) errors.push(`surfaces[${index}].ref`);
    if (surface.sha256 !== undefined && surface.sha256 !== null && (typeof surface.sha256 !== 'string' || !HASH.test(surface.sha256))) errors.push(`surfaces[${index}].sha256`);
    if (surface.description !== undefined && (typeof surface.description !== 'string' || surface.description.length > 500)) errors.push(`surfaces[${index}].description`);
  }
  return errors;
}

function validateRunnerMetrics(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw exchangeError('invalid_runner_metrics');
  if (input.schema !== RUNNER_METRICS_SCHEMA) throw exchangeError('invalid_runner_metrics');
  const allowed = ['schema', 'run_id', 'tokens', 'cost', 'latency_ms', 'model', 'harness', 'retries', 'changed_loc', 'unrelated_changes', 'human_review_ms', 'verified_success'];
  if (Object.keys(input).some((key) => !allowed.includes(key))) throw exchangeError('invalid_runner_metrics');
  const label = (value) => value === null || value === undefined || (typeof value === 'string' && value.length <= MAX_LABEL && !/[\x00-\x1f]/.test(value));
  if (!label(input.run_id)) throw exchangeError('invalid_runner_metrics');
  const intOrNull = (value) => value === null || value === undefined || (Number.isSafeInteger(value) && value >= 0);
  if (input.tokens !== undefined && input.tokens !== null) {
    const tokens = input.tokens;
    if (typeof tokens !== 'object' || Array.isArray(tokens)
      || Object.keys(tokens).some((key) => !['input', 'output', 'total', 'cache_read', 'cache_write'].includes(key))
      || !intOrNull(tokens.input) || !intOrNull(tokens.output) || !intOrNull(tokens.total)
      || !intOrNull(tokens.cache_read) || !intOrNull(tokens.cache_write)) throw exchangeError('invalid_runner_metrics');
  }
  if (input.cost !== undefined && input.cost !== null) {
    const cost = input.cost;
    if (typeof cost !== 'object' || Array.isArray(cost)
      || Object.keys(cost).some((key) => !['amount', 'currency'].includes(key))
      || typeof cost.amount !== 'number' || !Number.isFinite(cost.amount) || cost.amount < 0
      || typeof cost.currency !== 'string' || !/^[A-Z]{3}$/.test(cost.currency)) throw exchangeError('invalid_runner_metrics');
  }
  if (!intOrNull(input.latency_ms)) throw exchangeError('invalid_runner_metrics');
  for (const key of ['retries', 'changed_loc', 'unrelated_changes', 'human_review_ms']) {
    if (!intOrNull(input[key])) throw exchangeError('invalid_runner_metrics');
  }
  if (input.verified_success !== undefined && input.verified_success !== null && typeof input.verified_success !== 'boolean') throw exchangeError('invalid_runner_metrics');
  for (const side of ['model', 'harness']) {
    const value = input[side];
    if (value === undefined || value === null) continue;
    const allowedFields = side === 'model' ? ['provider', 'id', 'version'] : ['id', 'version'];
    if (typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some((key) => !allowedFields.includes(key))
      || Object.values(value).some((field) => !label(field))) throw exchangeError('invalid_runner_metrics');
  }
  return input;
}

// Receipts are validated against their full v1 contract and the change binding
// before export; rejected files degrade the bundle with an explicit note
// instead of contaminating or silently disappearing from the export.
const RECEIPT_CONTRACTS = Object.freeze({
  'aifhub.plan_compliance.v1': {
    required: ['schema', 'change_id', 'plan_revision', 'session_brief_digest', 'trace_run_id', 'completed_tasks', 'skipped_tasks', 'unplanned_changes', 'scope_expansions', 'new_constraints', 'acceptance_impact', 'outcome', 'replan_required'],
    check: (receipt) => ['compliant', 'acceptable_drift', 'replan_required', 'blocked'].includes(receipt.outcome)
      && typeof receipt.replan_required === 'boolean'
      && ['completed_tasks', 'skipped_tasks', 'unplanned_changes', 'scope_expansions', 'new_constraints', 'acceptance_impact'].every((key) => Array.isArray(receipt[key]))
  },
  'aifhub.ai_cross_context_review.v1': {
    required: ['schema', 'change_id', 'review_id', 'context_mode', 'execution_profile', 'target', 'session_brief_digest', 'source_revisions', 'acceptance_criteria', 'acceptance_examples', 'change_surface', 'findings', 'finding_count', 'outcome', 'created_at', 'same_session_fallback', 'blocked_reasons'],
    check: (receipt) => ['fresh', 'same_session'].includes(receipt.context_mode)
      && ['prepared', 'reviewed', 'blocked', 'stale'].includes(receipt.outcome)
      && Number.isSafeInteger(receipt.finding_count) && receipt.finding_count >= 0
      && Array.isArray(receipt.findings)
  },
  'aifhub.tracer_brief.v1': {
    required: ['schema', 'change_id', 'profile', 'hypothesis', 'minimum_vertical_path', 'architecture_questions', 'production_non_goals', 'budget', 'expected_artifacts', 'canonical_sources', 'created_at', 'updated_at'],
    check: (receipt) => receipt.profile === 'tracer'
  },
  'aifhub.tracer_findings.v1': {
    required: ['schema', 'change_id', 'findings', 'result_summary', 'evidence', 'created_at', 'updated_at'],
    check: (receipt) => Array.isArray(receipt.findings)
  },
  'aifhub.tracer_decision.v1': {
    required: ['schema', 'change_id', 'decision', 'reason', 'promotion_steps', 'created_at', 'updated_at'],
    check: (receipt) => [null, 'promote', 'discard', 'replan', 'blocked'].includes(receipt.decision) && Array.isArray(receipt.promotion_steps)
  },
  'aifhub.sdd_profile_decision.v1': {
    required: ['schema', 'change_id', 'profile', 'planning_mode', 'recommended_planning_mode', 'reasons', 'risk_signals', 'required_artifacts', 'conditional_artifacts', 'required_gates', 'implementation_allowed', 'blocked_reason', 'policy_revision', 'source_revision'],
    check: (receipt) => typeof receipt.profile === 'string' && Array.isArray(receipt.required_gates)
  }
});

function receiptContractError(parsed, schemaId, changeId) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 'not_an_object';
  if (parsed.schema !== schemaId) return 'unexpected_schema';
  const contract = RECEIPT_CONTRACTS[schemaId];
  if (contract.required.some((key) => !(key in parsed))) return 'missing_required_fields';
  if (parsed.change_id !== changeId) return 'change_binding_mismatch';
  if (!contract.check(parsed)) return 'contract_violation';
  return null;
}

async function readReceipt(root, relative, schemaId, changeId, notes, code) {
  const bytes = await readProviderFile(root, relative, MAX_READ_BYTES);
  if (bytes === null) return null;
  let parsed = null;
  try { parsed = parseStrictJson(bytes.toString('utf8')); } catch { /* reported below */ }
  const problem = parsed === null ? 'unparseable' : receiptContractError(parsed, schemaId, changeId);
  if (problem !== null) {
    notes.push({ code, detail: problem });
    return null;
  }
  return parsed;
}

async function listReviewReceipts(root, changeId, notes) {
  const dir = `.ai-factory/state/${changeId}/reviews`;
  let entries;
  try {
    entries = await readdir(path.join(root, dir), { withFileTypes: true });
  } catch { return []; }
  if (entries.length > MAX_REVIEWS) throw exchangeError('review_inventory_limit');
  const receipts = [];
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    if (!entry.isDirectory()) continue;
    const relative = `${dir}/${entry.name}/ai-cross-context-review.json`;
    const receipt = await readReceipt(root, relative, 'aifhub.ai_cross_context_review.v1', changeId, notes, 'invalid_review_receipt');
    if (receipt) receipts.push({ path: relative, receipt });
  }
  return receipts;
}

async function readTracerState(root, changeId, notes) {
  const dir = `.ai-factory/state/${changeId}/tracer`;
  const [brief, findings, decision] = await Promise.all([
    readReceipt(root, `${dir}/brief.json`, 'aifhub.tracer_brief.v1', changeId, notes, 'invalid_tracer_brief'),
    readReceipt(root, `${dir}/findings.json`, 'aifhub.tracer_findings.v1', changeId, notes, 'invalid_tracer_findings'),
    readReceipt(root, `${dir}/decision.json`, 'aifhub.tracer_decision.v1', changeId, notes, 'invalid_tracer_decision')
  ]);
  if (!brief && !findings && !decision) return null;
  return { brief, findings, decision };
}

function lineageKind(ref, changeId) {
  const base = `openspec/changes/${changeId}`;
  if (ref === `${base}/design.context.json`) return 'design_context';
  if (ref === `${base}/proposal.md` || ref === `${base}/design.md` || ref.startsWith(`${base}/specs/`)) return 'change_spec';
  if (ref === `${base}/tasks.md`) return 'work_item_spec';
  if (ref.startsWith('openspec/specs/')) return 'capability_spec';
  return null;
}

async function resolveExchangeChangeId(root, methodology, options) {
  // Non-OpenSpec methodologies do not require an OpenSpec change directory; an
  // explicit --change names the native plan identity the adapter resolves.
  if (methodology !== 'openspec' && options.changeId !== undefined) {
    return normalizeChangeId(options.changeId).changeId;
  }
  const resolution = await resolveActiveChange({ rootDir: root, cwd: options.cwd ?? root, changeId: options.changeId, getCurrentBranch: options.getCurrentBranch });
  if (!resolution.ok) throw exchangeError('active_change_unresolved');
  return resolution.changeId;
}

async function buildExchangeSnapshot(options) {
  const root = path.resolve(options.rootDir ?? process.cwd());
  const methodology = options.methodology ?? 'openspec';
  if (options.changeId !== undefined && (typeof options.changeId !== 'string' || !options.changeId || !normalizeChangeId(options.changeId).ok)) throw exchangeError('invalid-change-id');
  const changeId = await resolveExchangeChangeId(root, methodology, options);
  const notes = [];
  // The plan context and the brief must describe the same source snapshot; a
  // concurrent recompile between the two reads yields a bounded retry, then a
  // degraded export instead of a bundle mixing revisions.
  let planContext;
  let briefStatus;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    planContext = await resolvePlanContext({ rootDir: root, changeId, methodology });
    briefStatus = await inspectSessionBrief({ rootDir: root, cwd: options.cwd ?? root, changeId, includeBrief: true });
    const briefRevision = briefStatus.brief?.plan_context?.source_revision ?? null;
    if (briefRevision === null || briefRevision === planContext.source_revision) break;
    if (attempt === 1) notes.push({ code: 'revision_mismatch' });
  }
  // Adapter-level soft errors (incomplete parsing, unknown sections) degrade the
  // export instead of failing it; the bundle still carries the resolved fields.
  for (const error of planContext.errors) notes.push({ code: error.code, detail: error.path ?? null });
  for (const error of briefStatus.errors ?? []) notes.push({ code: `session_brief_${error.code}` });
  if (briefStatus.status !== 'valid' && briefStatus.status !== 'disabled') {
    notes.push({ code: `session_brief_${briefStatus.status}` });
    for (const reason of briefStatus.stale_reasons ?? []) notes.push({ code: `session_brief_${reason}` });
  }
  const complianceReceipt = await readReceipt(root, `.ai-factory/state/${changeId}/implementation/plan-compliance.json`, 'aifhub.plan_compliance.v1', changeId, notes, 'invalid_plan_compliance_receipt');
  const reviews = await listReviewReceipts(root, changeId, notes);
  const tracer = await readTracerState(root, changeId, notes);
  const designContext = await readDesignContext(root, changeId, notes);
  const degraded = notes.length > 0 || (briefStatus.status !== 'valid' && briefStatus.status !== 'disabled');
  return { root, changeId, notes, planContext, briefStatus, complianceReceipt, reviews, tracer, designContext, degraded };
}

function buildArtifactInventory(snapshot) {
  const seen = new Map();
  const add = (ref, sha256, bytes, role) => {
    if (typeof ref !== 'string' || seen.has(ref)) return;
    seen.set(ref, { ref, sha256, bytes, role });
  };
  for (const doc of snapshot.planContext?.documents ?? []) add(doc.path, doc.sha256, doc.bytes, doc.kind);
  for (const source of snapshot.briefStatus?.brief?.sources ?? []) add(source.path, source.sha256, source.bytes, source.kind);
  const artifacts = [];
  const references = [];
  for (const entry of seen.values()) {
    const kind = lineageKind(entry.ref, snapshot.changeId);
    if (kind) artifacts.push({ ref: entry.ref, kind, sha256: entry.sha256, bytes: entry.bytes ?? null });
    else references.push({ path: entry.ref, sha256: entry.sha256, kind: entry.role ?? 'supporting' });
  }
  if (artifacts.length + references.length > MAX_REFERENCES) throw exchangeError('artifact_inventory_limit');
  return {
    artifacts: artifacts.sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0)),
    references: references.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  };
}

function buildLineageEdges(snapshot, artifacts) {
  const brief = snapshot.briefStatus?.brief ?? null;
  const state = `.ai-factory/state/${snapshot.changeId}`;
  const briefRef = `${state}/context/session-brief.json`;
  const edges = [];
  if (brief) {
    for (const artifact of artifacts) edges.push({ from: briefRef, relation: 'derives_from', to: artifact.ref });
  }
  if (snapshot.complianceReceipt) {
    edges.push({ from: `${state}/implementation/plan-compliance.json`, relation: 'verifies', to: briefRef });
    for (const artifact of artifacts.filter((item) => item.kind === 'work_item_spec' || item.kind === 'change_spec')) {
      edges.push({ from: `${state}/implementation/plan-compliance.json`, relation: 'implements', to: artifact.ref });
    }
  }
  for (const { path: receiptPath, receipt } of snapshot.reviews) {
    const diffRef = receipt?.target?.path ? receiptPath.replace(/[^/]+$/, receipt.target.path) : receiptPath;
    edges.push({ from: receiptPath, relation: 'verifies', to: diffRef });
  }
  if (snapshot.tracer?.decision) {
    const proposal = artifacts.find((item) => item.ref.endsWith('/proposal.md'));
    if (proposal) edges.push({ from: `${state}/tracer/decision.json`, relation: 'refines', to: proposal.ref });
  }
  return edges;
}

function buildBundle(snapshot, version, now) {
  const brief = snapshot.briefStatus?.brief ?? null;
  const { artifacts, references } = buildArtifactInventory(snapshot);
  const plan = snapshot.planContext;
  const bundle = {
    schema: EXCHANGE_BUNDLE_SCHEMA,
    exporter: { id: EXPORTER_ID, version },
    generated_at: now,
    change_id: snapshot.changeId,
    plan: {
      plan_id: plan?.plan_id ?? snapshot.changeId,
      methodology: plan?.methodology ?? 'openspec',
      adapter_version: plan?.adapter_version ?? null,
      public_mode: plan?.public_mode ?? null,
      sdd_profile: plan?.sdd_profile ?? null,
      source_revision: plan?.source_revision ?? null,
      original_request: plan?.original_request ?? '',
      requirements: plan?.requirements ?? null,
      tasks: (plan?.tasks ?? []).map((task) => ({ id: task.id, text: task.text, done: task.done })),
      acceptance_examples: plan?.acceptance_examples ?? [],
      non_goals: plan?.non_goals ?? [],
      change_surface: plan?.change_surface ?? { allowed: [], forbidden: [] }
    },
    session_brief: brief ? {
      digest: brief.digest,
      status: snapshot.briefStatus.status,
      stale_reasons: snapshot.briefStatus.stale_reasons ?? [],
      profile: brief.profile,
      planning_mode: brief.planning_mode,
      source_revision: brief.source_revision,
      policy_revision: brief.policy_revision,
      scope_fingerprint: brief.scope_fingerprint,
      intent: brief.intent,
      target_outcome: brief.target_outcome,
      acceptance_criteria: brief.acceptance_criteria,
      acceptance_examples: brief.acceptance_examples,
      non_goals: brief.non_goals,
      change_surface: brief.change_surface,
      constraints: brief.constraints,
      assumptions: brief.assumptions,
      open_questions: brief.open_questions,
      verification_plan: brief.verification_plan,
      expected_artifacts: brief.expected_artifacts,
      verification: brief.verification,
      context_manifest: brief.context_manifest,
      required_capabilities: brief.required_capabilities,
      plan_context: brief.plan_context,
      budget: brief.budget,
      sources: brief.sources
    } : null,
    artifacts,
    references,
    lineage: buildLineageEdges(snapshot, artifacts),
    receipts: {
      plan_compliance: snapshot.complianceReceipt,
      reviews: snapshot.reviews.map(({ path: receiptPath, receipt }) => ({ path: receiptPath, receipt })),
      tracer: snapshot.tracer
    },
    design_context: snapshot.designContext,
    vocabulary_extensions: ['design_context'],
    exchange_notes: snapshot.notes
  };
  assertNoCredentials(JSON.stringify(bundle));
  return bundle;
}

// A persisted per-project salt keeps change_fingerprint stable across exports
// while the change identifier stays unguessable to recipients: the fingerprint
// is an HMAC over the id, never a bare hash of a guessable token.
async function exchangeFingerprintSalt(root) {
  const existing = await readJsonIfExists(root, EXCHANGE_SALT_PATH);
  if (existing?.schema === 'aifhub.exchange_salt.v1' && typeof existing.salt === 'string' && HASH.test(existing.salt)) return existing.salt;
  const salt = randomBytes(32).toString('hex');
  await ensureRuntimeGitignore(root, '.ai-factory/state');
  await writeProviderFile(root, EXCHANGE_SALT_PATH, { schema: 'aifhub.exchange_salt.v1', salt });
  return salt;
}

function buildEvaluationRecord(snapshot, version, now, options) {
  const brief = snapshot.briefStatus?.brief ?? null;
  const compliance = snapshot.complianceReceipt;
  const runner = options.runnerMetrics ?? null;
  const metrics = {
    source_bytes: brief?.budget?.source_bytes ?? null,
    brief_bytes: brief?.budget?.brief_bytes ?? null,
    context_manifest_entries: brief?.context_manifest?.length ?? null,
    sources_count: brief?.sources?.length ?? null,
    tasks_total: snapshot.planContext?.tasks?.length ?? null,
    tasks_completed: snapshot.planContext?.tasks?.filter((task) => task.done).length ?? null,
    tokens_input: runner?.tokens?.input ?? null,
    tokens_output: runner?.tokens?.output ?? null,
    tokens_total: runner?.tokens?.total ?? null,
    tokens_cache_read: runner?.tokens?.cache_read ?? null,
    tokens_cache_write: runner?.tokens?.cache_write ?? null,
    cost: runner?.cost ?? null,
    latency_ms: runner?.latency_ms ?? null,
    retries: runner?.retries ?? null,
    changed_loc: runner?.changed_loc ?? null,
    unrelated_changes: runner?.unrelated_changes ?? null,
    human_review_ms: runner?.human_review_ms ?? null
  };
  const record = {
    schema: EVALUATION_SCHEMA,
    exporter: { id: EXPORTER_ID, version },
    generated_at: now,
    evidence_class: options.evidenceClass,
    subject: {
      methodology: snapshot.planContext?.methodology ?? 'openspec',
      adapter_version: snapshot.planContext?.adapter_version ?? null,
      sdd_profile: snapshot.planContext?.sdd_profile ?? brief?.profile ?? null,
      planning_mode: brief?.planning_mode ?? snapshot.planContext?.public_mode ?? null,
      change_fingerprint: createHmac('sha256', options.salt).update(`change:${snapshot.changeId}`).digest('hex'),
      source_revision: brief?.source_revision ?? snapshot.planContext?.source_revision ?? null
    },
    metrics,
    outcomes: {
      session_brief_status: snapshot.briefStatus?.status ?? null,
      plan_compliance: compliance?.outcome ?? null,
      replan_required: compliance?.replan_required ?? null,
      drift: compliance ? {
        unplanned_changes: compliance.unplanned_changes?.length ?? 0,
        scope_expansions: compliance.scope_expansions?.length ?? 0,
        skipped_tasks: compliance.skipped_tasks?.length ?? 0
      } : null,
      reviews: snapshot.reviews.map(({ receipt }) => ({
        context_mode: receipt?.context_mode ?? null,
        outcome: receipt?.outcome ?? null,
        finding_count: receipt?.finding_count ?? null,
        same_session_fallback: receipt?.same_session_fallback ?? null
      })),
      tracer: snapshot.tracer?.decision ? { decision: snapshot.tracer.decision.decision ?? null } : null,
      verified_success: runner?.verified_success ?? null
    },
    runtime: {
      run_id: runner?.run_id ?? null,
      model: runner?.model ?? null,
      harness: runner?.harness ?? null
    },
    privacy: {
      contains_paths: false,
      contains_prompts: false,
      contains_source_content: false,
      contains_transcripts: false,
      contains_change_id: false,
      note: 'Aggregate metrics and digests only. Project-relative paths, prompts, source bytes, change IDs, and transcripts are excluded.'
    },
    // Public exports carry note codes only: details may contain project paths.
    exchange_notes: snapshot.notes.map(({ code }) => ({ code }))
  };
  record.export_id = hash(json({ ...record, export_id: undefined, generated_at: undefined }));
  assertNoCredentials(JSON.stringify(record));
  return record;
}

async function buildProfileExport(options, version, now, notes) {
  const artifact = {
    schema: WORKFLOW_PROFILE_SCHEMA,
    exporter: { id: EXPORTER_ID, version },
    generated_at: now,
    framework: { id: 'openspec', adapter_version: null },
    capabilities: EXCHANGE_CAPABILITIES,
    artifact_vocabulary: ARTIFACT_VOCABULARY,
    profiles: PROFILE_CATALOG,
    profile_mapping: { expanded: 'full' },
    quality_gates: { required: BASE_GATES, conditional: CONDITIONAL_GATES },
    review: {
      context_modes: ['fresh', 'same_session'],
      default_context_mode: 'fresh',
      human_review: 'external_policy',
      note: 'AI review produces prepared receipts only; it never satisfies the human_review gate, and the reviewed-outcome owner is still undefined.'
    },
    adapters: await listAdapters(),
    context_policy: {
      strategy: 'measured',
      protected_artifacts: 'full',
      declared_flags: ['reserve_output', 'reserve_tools', 'fresh_session_on_phase_change', 'compact_supporting_context'],
      execution: 'flags are validated and echoed into the profile decision; no runtime executes them yet'
    },
    resolved_decision: null
  };
  if (options.changeId !== undefined) {
    // --change binds the export to a concrete project decision.
    const root = path.resolve(options.rootDir ?? process.cwd());
    const methodology = options.methodology ?? 'openspec';
    const changeId = await resolveExchangeChangeId(root, methodology, options);
    const decision = await readReceipt(root, `.ai-factory/state/${changeId}/sdd/profile-decision.json`, 'aifhub.sdd_profile_decision.v1', changeId, notes, 'invalid_profile_decision');
    if (decision) artifact.resolved_decision = { change_id: changeId, decision };
    const planContext = await resolvePlanContext({ rootDir: root, changeId, methodology }).catch(() => null);
    if (planContext) artifact.framework.adapter_version = planContext.adapter_version;
  }
  return artifact;
}

function assertNoCredentials(value) {
  if (CREDENTIAL_RE.test(value)) throw exchangeError('sensitive_export_content');
}

async function maybeWrite(root, output, artifact) {
  if (!output) return null;
  if (output.replaceAll('\\', '/').startsWith('.ai-factory/state/')) await ensureRuntimeGitignore(root, '.ai-factory/state');
  await writeProviderFile(root, output, artifact);
  return output;
}

export async function exportExchangeBundle(options = {}) {
  try {
    const snapshot = await buildExchangeSnapshot(options);
    const bundle = buildBundle(snapshot, await exporterVersion(), options.now ?? new Date().toISOString());
    const written = await maybeWrite(snapshot.root, options.output, bundle);
    return { ok: !snapshot.degraded, outcome: snapshot.degraded ? 'degraded' : 'exported', bundle, written, notes: snapshot.notes };
  } catch (error) { return failure(error); }
}

export async function exportEvaluation(options = {}) {
  try {
    if (!EVIDENCE_CLASSES.includes(options.evidenceClass)) throw exchangeError('invalid_evidence_class');
    let runnerMetrics = options.runnerMetrics ?? null;
    if (options.runnerMetricsPath) {
      const root = path.resolve(options.rootDir ?? process.cwd());
      const bytes = await readProviderFile(root, options.runnerMetricsPath, MAX_READ_BYTES);
      if (bytes === null) throw exchangeError('runner_metrics_not_found');
      runnerMetrics = validateRunnerMetrics(parseStrictJson(bytes.toString('utf8')));
    } else if (runnerMetrics !== null) {
      runnerMetrics = validateRunnerMetrics(runnerMetrics);
    }
    const snapshot = await buildExchangeSnapshot(options);
    const salt = await exchangeFingerprintSalt(snapshot.root);
    const record = buildEvaluationRecord(snapshot, await exporterVersion(), options.now ?? new Date().toISOString(), { ...options, runnerMetrics, salt });
    const written = await maybeWrite(snapshot.root, options.output, record);
    return { ok: !snapshot.degraded, outcome: snapshot.degraded ? 'degraded' : 'exported', evaluation: record, written, notes: snapshot.notes };
  } catch (error) { return failure(error); }
}

export async function exportWorkflowProfile(options = {}) {
  try {
    const notes = [];
    const artifact = await buildProfileExport(options, await exporterVersion(), options.now ?? new Date().toISOString(), notes);
    const root = path.resolve(options.rootDir ?? process.cwd());
    const written = await maybeWrite(root, options.output, artifact);
    return { ok: notes.length === 0, outcome: notes.length ? 'degraded' : 'exported', profile: artifact, written, notes };
  } catch (error) { return failure(error); }
}

function failure(error) {
  const code = error?.exchangeCode ?? error?.planResolverCode ?? error?.sddCode ?? 'exchange_export_failed';
  return { ok: false, outcome: 'failed', errors: [{ code }] };
}

export async function runExchangeCommand(argv = process.argv.slice(2), options = {}) {
  const [action, ...args] = argv;
  const parsed = { rootDir: options.rootDir, getCurrentBranch: options.getCurrentBranch };
  let jsonOutput = false;
  let invalid = !['profile', 'bundle', 'evaluation'].includes(action);
  const seen = new Set();
  for (let i = 0; i < args.length && !invalid; i++) {
    const flag = args[i];
    if (seen.has(flag)) invalid = true;
    seen.add(flag);
    if (flag === '--json') jsonOutput = true;
    else if (flag === '--change' && args[i + 1] && !args[i + 1].startsWith('--')) parsed.changeId = args[++i];
    else if (flag === '--methodology' && args[i + 1] && !args[i + 1].startsWith('--')) parsed.methodology = args[++i];
    else if (flag === '--output' && args[i + 1] && !args[i + 1].startsWith('--')) parsed.output = args[++i];
    else if (flag === '--evidence-class' && args[i + 1] && !args[i + 1].startsWith('--')) parsed.evidenceClass = args[++i];
    else if (flag === '--runner-metrics' && args[i + 1] && !args[i + 1].startsWith('--')) parsed.runnerMetricsPath = args[++i];
    else invalid = true;
  }
  let result;
  if (invalid) result = { ok: false, outcome: 'failed', errors: [{ code: 'invalid_arguments' }] };
  else if (action === 'profile') result = await exportWorkflowProfile(parsed);
  else if (action === 'bundle') result = await exportExchangeBundle(parsed);
  else result = await exportEvaluation(parsed);
  const exitCode = invalid ? 2 : result.outcome === 'failed' ? 2 : result.ok ? 0 : 1;
  const payload = result.profile ?? result.bundle ?? result.evaluation ?? { ok: result.ok, outcome: result.outcome, errors: result.errors ?? [] };
  const output = jsonOutput
    ? `${JSON.stringify(payload, null, 2)}\n`
    : `Exchange ${action}: ${result.outcome}\n${(result.errors ?? []).map((error) => error.code).join('\n')}${(result.errors ?? []).length ? '\n' : ''}${(result.notes ?? []).length ? `notes: ${result.notes.map((note) => note.code).join(', ')}\n` : ''}${result.written ? `written: ${result.written}\n` : ''}`;
  (options.stdout ?? process.stdout).write(output);
  return exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await runExchangeCommand();
}
