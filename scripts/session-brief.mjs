// Rebuildable, extractive execution context. Never writes canonical or QA files.
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readdir, realpath, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { TextDecoder } from 'node:util';
import { ensureRuntimeGitignore } from './runtime-gitignore.mjs';
import { normalizeChangeId, resolveActiveChange } from './active-change-resolver.mjs';
import { parseSimpleYaml } from './aif-artifact-sync.mjs';
import { resolveAiFactoryVersion } from './ai-factory-version-resolver.mjs';
import { resolvePlanContext } from './common-plan-resolver.mjs';
import { parseStrictJson } from './json-strict.mjs';
import {
  SDD_POLICY_PATH, selectSddProfile, sddError, validateSddPolicy
} from './sdd-profiles.mjs';

const COMPILER = 'aifhub.session_brief.compiler.v1';
const CONFIG = '.ai-factory/config.yaml';
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const MAX_FILES = 1024;
const decoder = new TextDecoder('utf-8', { fatal: true });
const HASH = /^[a-f0-9]{64}$/;

export function sessionBriefPaths(changeId) {
  if (!normalizeChangeId(changeId).ok) throw sddError('invalid-change-id');
  const base = `.ai-factory/state/${changeId}`;
  return {
    decision: `${base}/sdd/profile-decision.json`,
    json: `${base}/context/session-brief.json`,
    markdown: `${base}/context/session-brief.md`
  };
}

export async function compileSessionBrief(options = {}) {
  try {
    const snapshot = await buildSnapshot(options, true);
    const result = summarize(snapshot);
    const outputs = [[snapshot.paths.decision, json(snapshot.decision)]];
    if (snapshot.brief) outputs.push([snapshot.paths.markdown, renderSessionBrief(snapshot.brief)], [snapshot.paths.json, json(snapshot.brief)]);
    if (outputs.some(([, content]) => Buffer.byteLength(content) > MAX_BYTES)) throw sddError('brief_budget_exceeded');
    // Validate all destinations before creating even the first runtime directory.
    for (const [file] of outputs) await inspectPath(snapshot.root, file);
    // A concurrent source update cannot be silently compiled from a mixed revision.
    const current = await buildSnapshot(options, true);
    if (json(current.decision) !== json(snapshot.decision) || json(current.brief) !== json(snapshot.brief)) throw sddError('sources_changed_during_compile');
    let written = false;
    for (const [file, content] of outputs) written = await writeRuntimeFile(snapshot.root, file, content) || written;
    return { ...result, written };
  } catch (error) { return failure(error); }
}

export async function inspectSessionBrief(options = {}) {
  try {
    const snapshot = await buildSnapshot(options, false);
    if (snapshot.disabled) return { ok: true, status: 'disabled', change_id: snapshot.changeId, paths: snapshot.paths, stale_reasons: [] };
    const result = summarize(snapshot);
    const stored = await readSafeFile(snapshot.root, snapshot.paths.json);
    const decision = await readSafeFile(snapshot.root, snapshot.paths.decision);
    const markdown = await readSafeFile(snapshot.root, snapshot.paths.markdown);
    const staleReasons = [];
    if (!snapshot.brief) {
      return { ...result, status: 'blocked', stale_reasons: stored ? ['current_sources_block_implementation'] : [] };
    }
    if (!stored || !decision || !markdown) staleReasons.push('missing_runtime_artifact');
    let previous = null;
    if (stored) {
      try { previous = parseStrictJson(stored.content); } catch { staleReasons.push('invalid_brief'); }
      if (previous && json(previous.sources) !== json(snapshot.brief.sources)) staleReasons.push('source_revision_changed');
      if (previous && json(previous) !== json(snapshot.brief)) staleReasons.push('brief_revision_mismatch');
    }
    if (decision && decision.content !== json(snapshot.decision)) staleReasons.push('profile_decision_mismatch');
    if (markdown && markdown.content !== renderSessionBrief(snapshot.brief)) staleReasons.push('markdown_mismatch');
    return {
      ...result, ok: staleReasons.length === 0,
      status: staleReasons.length === 0 ? 'valid' : !stored ? 'missing' : 'stale',
      stale_reasons: staleReasons,
      ...(staleReasons.length === 0 && options.includeBrief ? { brief: snapshot.brief } : {})
    };
  } catch (error) { return failure(error); }
}

export async function assertSessionBriefBinding(changeId, digest, options = {}) {
  const status = await inspectSessionBrief({ ...options, changeId });
  if (status.status === 'disabled' && digest === undefined) return status;
  if (!status.ok || status.status !== 'valid') throw sddError('session_brief_not_current');
  if (typeof digest !== 'string' || !HASH.test(digest) || digest !== status.digest) throw sddError('session_brief_digest_mismatch');
  return status;
}

async function buildSnapshot(options, explicitCompile) {
  const root = await realpath(path.resolve(options.rootDir ?? process.cwd()));
  if (options.changeId !== undefined && (typeof options.changeId !== 'string' || !options.changeId || !normalizeChangeId(options.changeId).ok)) throw sddError('invalid-change-id');
  // Protect resolver reads as well as the later compiler reads.
  for (const file of [CONFIG, 'openspec/changes', '.ai-factory/state/current.yaml']) await inspectPath(root, file);
  const resolution = await resolveActiveChange({ rootDir: root, cwd: options.cwd ?? root, changeId: options.changeId, getCurrentBranch: options.getCurrentBranch });
  if (!resolution.ok) throw sddError('active_change_unresolved');
  const changeId = resolution.changeId;
  const base = `openspec/changes/${changeId}`;
  const paths = sessionBriefPaths(changeId);
  await inspectPath(root, base);
  const policyFile = await readSafeFile(root, SDD_POLICY_PATH);
  const existing = await readSafeFile(root, paths.json);
  const existingDecision = await readSafeFile(root, paths.decision);
  const existingMarkdown = await readSafeFile(root, paths.markdown);
  const configFile = await readSafeFile(root, CONFIG);
  const config = parseSimpleYaml(configFile?.content ?? '');
  // Resolve methodology-neutral plan context (ADR 0005). Canonical ownership stays
  // with the plan; this is a derived execution context bound to source revisions.
  const planContext = await resolvePlanContext({ rootDir: root, changeId, methodology: 'openspec' });
  if (planContext.errors.length > 0) throw sddError(planContext.errors[0].code ?? 'plan_context_unresolved');
  if (!explicitCompile && !planContext.sdd_inputs && !policyFile && !existing && !existingDecision && !existingMarkdown) return { disabled: true, root, changeId, paths };
  if (config.aifhub?.artifactProtocol !== 'openspec') throw sddError('openspec_protocol_required');
  const rawPolicy = policyFile ? parseStrictJson(policyFile.content) : {};
  if (policyFile && rawPolicy.schema !== 'aifhub.sdd_policy.v1') throw sddError('invalid-sdd-policy');
  const policy = validateSddPolicy(rawPolicy);
  // Config/schema ownership remains authoritative; the overlay can only add depth.
  if (config.aifhub?.openspec?.requireDesign === true) policy.require_design = true;
  const inputs = planContext.sdd_inputs;
  const files = new Map();
  let totalBytes = 0;
  const add = async (file, kind = 'supporting') => {
    if (files.has(file)) return files.get(file);
    const item = await readSafeFile(root, file);
    if (item) {
      totalBytes += item.bytes;
      if (files.size >= MAX_FILES || totalBytes > MAX_TOTAL_BYTES) throw sddError('source_budget_exceeded');
      files.set(file, { ...item, kind });
    }
    return item;
  };
  await add(CONFIG, 'policy');
  await add(SDD_POLICY_PATH, 'policy');
  await add('.ai-factory.json', 'policy');
  await add('openspec/config.yaml', 'policy');
  // Local schema/template edits can change the canonical artifact contract.
  for (const file of await walkFiles(root, 'openspec/schemas', (file) => /\.(?:md|yaml|yml|json)$/.test(file))) await add(file, 'policy');
  for (const file of ['proposal.md', 'design.md', 'tasks.md', '.openspec.yaml']) await add(`${base}/${file}`, 'canonical');
  for (const dir of [`${base}/specs`, 'openspec/specs']) {
    for (const file of await walkFiles(root, dir, (file) => file.endsWith('.md'))) await add(file, 'protected');
  }
  const rulesRoot = safeReference(config.paths?.rules ?? '.ai-factory/rules');
  const generatedFiles = [
    'openspec-base.md', `openspec-merged-${changeId}.md`, `openspec-change-${changeId}.md`,
    `openspec-rules-trace-${changeId}.json`
  ];
  for (const file of await walkFiles(root, rulesRoot, (file) => /\.(?:md|json)$/.test(file))) {
    // Other changes' generated outputs are unrelated and may contain private context.
    if (file.startsWith(`${rulesRoot}/generated/`) && !generatedFiles.includes(path.posix.basename(file))) continue;
    await add(file, 'protected');
  }
  // Generated OpenSpec outputs retain their fixed owner path even when the
  // configured project rules directory is elsewhere.
  for (const file of generatedFiles) await add(`.ai-factory/rules/generated/${file}`, 'protected');
  const contextRefs = new Set([
    safeReference(config.paths?.architecture ?? '.ai-factory/ARCHITECTURE.md'),
    safeReference(config.paths?.context ?? 'CONTEXT.md'),
    safeReference(config.reviews?.policy_file ?? 'REVIEW.md'),
    'AGENTS.md', 'CLAUDE.md', ...policy.context_refs.map(safeReference)
  ]);
  for (const file of [...contextRefs].sort()) {
    if (!file.endsWith('.md')) throw sddError('invalid_context_reference');
    const item = await add(file, 'protected');
    if (!item && policy.context_refs.includes(file)) throw sddError('missing_context_reference');
  }
  for (const document of planContext.documents) {
    const current = files.get(document.path);
    if (current && current.sha256 !== document.sha256) throw sddError('sources_changed_during_compile');
  }
  if (policyFile?.sha256 !== files.get(SDD_POLICY_PATH)?.sha256 || configFile?.sha256 !== files.get(CONFIG)?.sha256) throw sddError('sources_changed_during_compile');
  const version = inputs?.planning_mode === 'ultra' || policy.minimum_profile === 'ultra'
    ? await resolveAiFactoryVersion({ rootDir: root }) : { supportsUltra: false };
  const design = files.get(`${base}/design.md`);
  const openQuestions = planContext.requirements.open_questions;
  const selection = selectSddProfile(inputs && openQuestions.length ? { ...inputs, requirements_clear: false } : inputs, policy, version);
  const sources = [...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([file, item]) => ({ path: file, sha256: item.sha256, bytes: item.bytes, kind: item.kind }));
  const sourceRevision = hash(json(sources));
  const policyRevision = hash(json({ compiler: COMPILER, policy, sources: sources.filter((item) => item.kind === 'policy' || item.kind === 'protected') }));
  const decision = { schema: 'aifhub.sdd_profile_decision.v1', change_id: changeId, ...selection, policy_revision: policyRevision, source_revision: sourceRevision };
  let brief = null;
  const blocked = [];
  if (selection.implementation_allowed) {
    const proposalFile = files.get(`${base}/proposal.md`);
    if (!proposalFile) blocked.push('missing_proposal');
    if (!files.get(`${base}/tasks.md`)) blocked.push('missing_tasks');
    if (selection.required_artifacts.includes('design') && !design) blocked.push('missing_design');
    if (selection.required_artifacts.includes('delta_specs') && !sources.some((item) => item.path.startsWith(`${base}/specs/`))) blocked.push('missing_delta_specs');
    const intent = planContext.requirements.intent;
    const targetOutcome = planContext.requirements.target_outcome;
    const nonGoals = planContext.non_goals;
    const acceptanceExamples = planContext.acceptance_examples;
    const allowed = planContext.change_surface.allowed;
    const forbidden = planContext.change_surface.forbidden;
    if (!intent || !targetOutcome) blocked.push('missing_intent_or_outcome');
    if (!allowed.length) blocked.push('missing_allowed_change_surface');
    if (inputs?.behavior_change && (!nonGoals.length || !acceptanceExamples.length)) blocked.push('missing_behavior_acceptance_context');
    if (!blocked.length) {
      const fields = {
        intent, target_outcome: targetOutcome, acceptance_criteria: planContext.requirements.acceptance_criteria,
        acceptance_examples: acceptanceExamples, non_goals: nonGoals,
        change_surface: { allowed, forbidden }, constraints: planContext.requirements.constraints,
        assumptions: planContext.requirements.assumptions, open_questions: openQuestions,
        verification_plan: planContext.requirements.verification_plan
      };
      assertNoCredentials(json(fields));
      const payload = {
        schema: 'aifhub.session_brief.v1', compiler: COMPILER, change_id: changeId,
        profile: selection.profile, planning_mode: selection.planning_mode, sources,
        source_revision: sourceRevision, policy_revision: policyRevision,
        scope_fingerprint: hash(json({ sources, change_surface: fields.change_surface })),
        ...fields, expected_artifacts: selection.required_artifacts,
        verification: { required_checks: selection.required_gates, policy_refs: sources.filter((item) => item.kind === 'policy').map((item) => item.path) },
        context_manifest: sources.map(({ path: file, sha256, kind }) => ({ path: file, sha256, fidelity: kind === 'canonical' && /(?:proposal|design)\.md$/.test(file) ? 'selected_sections' : 'full' })),
        required_capabilities: ['canonical_source_read', 'project_policy_checks'],
        plan_context: { methodology: planContext.methodology, adapter_version: planContext.adapter_version, source_revision: planContext.source_revision },
        budget: { strategy: 'measured', source_bytes: totalBytes, brief_bytes: null, token_estimate: null }
      };
      brief = { ...payload, digest: hash(json(payload)) };
      const rendered = renderSessionBrief(brief);
      payload.budget.brief_bytes = Buffer.byteLength(rendered, 'utf8');
      brief = { ...payload, digest: hash(json(payload)) };
    }
  }
  if (blocked.length) {
    decision.implementation_allowed = false;
    decision.blocked_reason = 'canonical_context_incomplete';
  }
  return { root, changeId, paths, decision, brief, blocked, sources };
}

function summarize(snapshot) {
  return {
    ok: Boolean(snapshot.brief), status: snapshot.brief ? 'valid' : 'blocked', change_id: snapshot.changeId,
    paths: snapshot.paths, decision: snapshot.decision, digest: snapshot.brief?.digest ?? null,
    sources: snapshot.sources, stale_reasons: [],
    blocked_reasons: snapshot.blocked.length ? snapshot.blocked : snapshot.decision.blocked_reason ? [snapshot.decision.blocked_reason] : [],
    owner_handoff: snapshot.decision.profile === 'research' ? 'aif-explore' : snapshot.brief ? null : 'aif-plan'
  };
}

function safeReference(file) {
  portablePath(file);
  if (file === '.ai-factory' || /^(?:openspec|\.git|\.ai-factory\/(?:state|qa|extensions|plans|archive|references))(?:\/|$)/i.test(file)
    || /(?:^|\/)(?:\.env[^/]*|.*(?:transcript|credentials?|secrets?|provider-output).*|RESEARCH\.md)$/i.test(file)) throw sddError('invalid_context_reference');
  return file;
}

function portablePath(file) {
  if (typeof file !== 'string' || file.length > 512 || file.split('/').some((part) => !part || ['.', '..'].includes(part)
    || /[\\<>:"|?*\x00-\x1f\x7f]/.test(part) || /[. ]$/.test(part)
    || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw sddError('unsafe_path');
}

async function inspectPath(root, file) {
  portablePath(file);
  let target = root;
  const parts = file.split('/');
  for (let i = 0; i < parts.length; i++) {
    target = path.join(target, parts[i]);
    let info;
    try { info = await lstat(target); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile()) || (info.isFile() && info.nlink !== 1)) throw sddError('unsafe_path');
    if (i < parts.length - 1 && !info.isDirectory()) throw sddError('unsafe_path');
    const resolved = await realpath(target);
    if (!inside(root, resolved)) throw sddError('unsafe_path');
    if (i === parts.length - 1) return info;
  }
}

async function readSafeFile(root, file) {
  const inspected = await inspectPath(root, file);
  if (!inspected) return null;
  if (!inspected.isFile() || inspected.size > MAX_BYTES) throw sddError('invalid_source_file');
  const handle = await open(path.join(root, file), 'r');
  try {
    const before = await handle.stat();
    if (before.ino !== inspected.ino || before.dev !== inspected.dev || before.nlink !== 1) throw sddError('source_identity_changed');
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const read = await handle.read(buffer, size, buffer.length - size, null);
      if (!read.bytesRead) break;
      size += read.bytesRead;
    }
    const after = await handle.stat();
    const current = await inspectPath(root, file);
    if (size > MAX_BYTES || before.size !== size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
      || current?.ino !== before.ino || current?.dev !== before.dev) throw sddError('source_identity_changed');
    const bytes = buffer.subarray(0, size);
    return { content: decoder.decode(bytes), sha256: hash(bytes), bytes: size };
  } finally { await handle.close(); }
}

async function walkFiles(root, directory, accept, result = [], depth = 0) {
  const info = await inspectPath(root, directory);
  if (!info) return result;
  if (!info.isDirectory() || depth > 32) throw sddError('invalid_source_directory');
  const entries = await readdir(path.join(root, directory), { withFileTypes: true });
  if (entries.length + result.length > MAX_FILES) throw sddError('source_budget_exceeded');
  for (const entry of entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    const file = `${directory}/${entry.name}`;
    await inspectPath(root, file);
    if (entry.isDirectory()) await walkFiles(root, file, accept, result, depth + 1);
    else if (accept(file)) result.push(file);
  }
  return result;
}

async function writeRuntimeFile(root, file, content) {
  if (!/^\.ai-factory\/state\/[^/]+\/(?:sdd\/profile-decision\.json|context\/session-brief\.(?:md|json))$/.test(file)) throw sddError('unsafe_destination');
  const previous = await readSafeFile(root, file);
  await ensureRuntimeGitignore(root, '.ai-factory/state');
  if (previous?.content === content) return false;
  await mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await inspectPath(root, file);
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await open(path.join(root, temporary), 'wx', 0o600);
  try { await handle.writeFile(content, 'utf8'); } finally { await handle.close(); }
  try {
    await inspectPath(root, file);
    await rename(path.join(root, temporary), path.join(root, file));
  } finally { await unlink(path.join(root, temporary)).catch(() => {}); }
  return true;
}

function inside(root, target) {
  const relative = path.relative(root, target);
  return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`);
}

export { parseStrictJson } from './json-strict.mjs';

function assertNoCredentials(value) {
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,}|AKIA[A-Z0-9]{16})\b|\bBearer\s+[A-Za-z0-9._~-]{8,}|\b(?:password|api[_ -]?key|client[_ -]?secret|access[_ -]?token)\s*[:=]\s*[^\s,}]+/i.test(value)) throw sddError('sensitive_brief_content');
}

export function renderSessionBrief(brief) {
  const lines = [
    `# SessionBrief: ${brief.change_id}`, '', `Digest: ${brief.digest}`, `Profile: ${brief.profile}`, '',
    'Derived execution context. Canonical sources, project policy, and permissions remain authoritative.', '',
    '## Intent', '', brief.intent, '', '## Target outcome', '', brief.target_outcome, ''
  ];
  for (const [heading, values] of [
    ['Acceptance criteria', brief.acceptance_criteria], ['Acceptance examples', brief.acceptance_examples],
    ['Non-goals', brief.non_goals], ['Allowed change surface', brief.change_surface.allowed],
    ['Forbidden change surface', brief.change_surface.forbidden], ['Constraints', brief.constraints],
    ['Assumptions', brief.assumptions], ['Open questions', brief.open_questions], ['Verification plan', brief.verification_plan]
  ]) if (values.length) lines.push(`## ${heading}`, '', ...values, '');
  lines.push('## Required checks', '', ...brief.verification.required_checks.map((gate) => `- ${gate}`), '',
    '## Exact source references', '', 'Read full-fidelity references without semantic rewriting; requirements/scenarios remain in the canonical specs.', '',
    ...brief.context_manifest.map((item) => `- ${item.path} sha256=${item.sha256} fidelity=${item.fidelity}`), '');
  return lines.join('\n');
}

function hash(value) { return createHash('sha256').update(value).digest('hex'); }
function json(value) { return `${JSON.stringify(value, null, 2)}\n`; }
function failure(error) {
  const code = error.sddCode ?? error.planResolverCode ?? 'session_brief_io_error';
  return { ok: false, status: 'blocked', errors: [{ code }], stale_reasons: [], owner_handoff: 'aif-plan' };
}

export async function runSessionBriefCommand(argv = process.argv.slice(2), options = {}) {
  const [command, ...args] = argv;
  const parsed = { ...options };
  let jsonOutput = false;
  let invalid = !['compile', 'status', 'show'].includes(command);
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (seen.has(flag)) invalid = true;
    seen.add(flag);
    if (flag === '--json') jsonOutput = true;
    else if (flag === '--change' && args[i + 1] && !args[i + 1].startsWith('--')) parsed.changeId = args[++i];
    else invalid = true;
  }
  let result;
  if (invalid) result = failure(sddError('invalid_arguments'));
  else if (command === 'compile') result = await compileSessionBrief(parsed);
  else result = await inspectSessionBrief({ ...parsed, includeBrief: command === 'show' });
  const exitCode = invalid || result.errors?.length ? 2 : result.ok ? 0 : 1;
  const output = jsonOutput ? json(result) : command === 'show' && result.brief ? renderSessionBrief(result.brief)
    : `SessionBrief: ${result.status}${result.digest ? ` digest=${result.digest}` : ''}\n${(result.errors ?? []).map((error) => error.code).join('\n')}`;
  (options.stdout ?? process.stdout).write(output.endsWith('\n') ? output : `${output}\n`);
  return exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await runSessionBriefCommand();
}
