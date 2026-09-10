// Tracer profile runtime. Creates a bounded state area for uncertain architecture
// or integration work and records an explicit promotion/discard/replan/blocked
// decision without modifying canonical artifacts.
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { ensureRuntimeGitignore } from './runtime-gitignore.mjs';
import { resolveActiveChange, normalizeChangeId } from './active-change-resolver.mjs';
import { readProviderFile, safeProviderPath, writeProviderFile } from './provider-files.mjs';

const BRIEF_SCHEMA = 'aifhub.tracer_brief.v1';
const FINDINGS_SCHEMA = 'aifhub.tracer_findings.v1';
const DECISION_SCHEMA = 'aifhub.tracer_decision.v1';

export function tracerError(code) {
  const error = new Error(code);
  error.tracerCode = code;
  return error;
}

export function tracerPaths(changeId) {
  if (!normalizeChangeId(changeId).ok) throw tracerError('invalid-change-id');
  const dir = `.ai-factory/state/${changeId}/tracer`;
  return {
    dir,
    brief: `${dir}/brief.json`,
    findings: `${dir}/findings.json`,
    decision: `${dir}/decision.json`,
    summary: `${dir}/implementation-summary.md`
  };
}

export async function runTracer(options = {}) {
  try {
    const snapshot = await buildTracerSnapshot(options, 'run');
    if (snapshot.errors.length > 0) {
      return { ok: false, outcome: 'blocked', errors: snapshot.errors, paths: snapshot.paths };
    }
    await writeTracerState(snapshot);
    return { ok: true, outcome: 'run', paths: snapshot.paths };
  } catch (error) { return failure(error, options.changeId); }
}

export async function decideTracer(options = {}) {
  try {
    const snapshot = await buildTracerSnapshot(options, 'decide');
    if (snapshot.errors.length > 0) {
      return { ok: false, outcome: 'blocked', errors: snapshot.errors, paths: snapshot.paths };
    }
    const decision = await writeDecision(snapshot);
    await writeSummary(snapshot.root, snapshot.changeId);
    return { ok: true, outcome: decision, paths: snapshot.paths };
  } catch (error) { return failure(error, options.changeId); }
}

export async function statusTracer(options = {}) {
  try {
    const root = path.resolve(options.rootDir ?? process.cwd());
    const resolution = await resolveActiveChange({ rootDir: root, cwd: options.cwd ?? root, changeId: options.changeId });
    if (!resolution.ok) return { ok: false, outcome: 'blocked', errors: [{ code: 'active_change_unresolved' }] };
    const paths = tracerPaths(resolution.changeId);
    const brief = await readJsonIfExists(root, paths.brief);
    const findings = await readJsonIfExists(root, paths.findings);
    const decision = await readJsonIfExists(root, paths.decision);
    if (!brief && !findings && !decision) {
      return { ok: false, outcome: 'blocked', errors: [{ code: 'no_tracer_state' }] };
    }
    return { ok: true, outcome: 'status', brief, findings, decision, paths };
  } catch (error) { return failure(error, options.changeId); }
}

async function buildTracerSnapshot(options, phase) {
  const root = path.resolve(options.rootDir ?? process.cwd());
  if (options.changeId !== undefined && (typeof options.changeId !== 'string' || !options.changeId || !normalizeChangeId(options.changeId).ok)) throw tracerError('invalid-change-id');
  const resolution = await resolveActiveChange({ rootDir: root, cwd: options.cwd ?? root, changeId: options.changeId });
  if (!resolution.ok) throw tracerError('active_change_unresolved');
  const changeId = resolution.changeId;
  const paths = tracerPaths(changeId);
  const errors = [];

  const sources = [];
  for (const file of ['proposal.md', 'tasks.md', 'design.md']) {
    const relative = `openspec/changes/${changeId}/${file}`;
    const bytes = await readProviderFile(root, relative, 2 * 1024 * 1024);
    if (bytes !== null) sources.push({ path: relative, sha256: sha256(bytes) });
  }
  if (sources.length === 0) errors.push({ code: 'missing_canonical_sources' });

  const now = new Date().toISOString();
  const hypothesis = options.hypothesis ?? '';
  const minimumVerticalPath = options.minimumVerticalPath ?? '';
  const questions = Array.isArray(options.questions) ? options.questions : [];
  const nonGoals = Array.isArray(options.nonGoals) ? options.nonGoals : [];
  const budget = { time: options.budget?.time ?? '', cost: options.budget?.cost ?? '', tools: Array.isArray(options.budget?.tools) ? options.budget.tools : [] };
  const expectedArtifacts = Array.isArray(options.expectedArtifacts) ? options.expectedArtifacts : [];

  if (phase === 'run') {
    if (!hypothesis) errors.push({ code: 'missing_hypothesis' });
    if (!minimumVerticalPath) errors.push({ code: 'missing_vertical_path' });
  }

  const brief = {
    schema: BRIEF_SCHEMA,
    change_id: changeId,
    profile: 'tracer',
    hypothesis,
    minimum_vertical_path: minimumVerticalPath,
    architecture_questions: questions,
    production_non_goals: nonGoals,
    budget,
    expected_artifacts: expectedArtifacts,
    canonical_sources: sources,
    created_at: now,
    updated_at: now
  };

  const findings = {
    schema: FINDINGS_SCHEMA,
    change_id: changeId,
    findings: Array.isArray(options.findings) ? options.findings : [],
    result_summary: options.resultSummary ?? '',
    evidence: Array.isArray(options.evidence) ? options.evidence : [],
    created_at: now,
    updated_at: now
  };

  const decisionFile = await readJsonIfExists(root, paths.decision);
  const decision = {
    schema: DECISION_SCHEMA,
    change_id: changeId,
    decision: decisionFile?.decision ?? null,
    reason: decisionFile?.reason ?? '',
    promotion_steps: decisionFile?.promotion_steps ?? [],
    created_at: decisionFile?.created_at ?? now,
    updated_at: now
  };

  return { root, changeId, paths, brief, findings, decision, errors, options, now };
}

async function writeTracerState(snapshot) {
  await ensureRuntimeGitignore(snapshot.root, '.ai-factory/state');
  await mkdir(path.join(snapshot.root, path.dirname(snapshot.paths.brief)), { recursive: true });
  await writeProviderFile(snapshot.root, snapshot.paths.brief, snapshot.brief);
  await writeProviderFile(snapshot.root, snapshot.paths.findings, snapshot.findings);
  await writeProviderFile(snapshot.root, snapshot.paths.decision, snapshot.decision);
  await writeTextFile(snapshot.root, snapshot.paths.summary, renderSummary(snapshot));
}

async function writeDecision(snapshot) {
  const decision = String(snapshot.options.decision ?? '');
  const valid = ['promote', 'discard', 'replan', 'blocked'];
  if (!valid.includes(decision)) throw tracerError('invalid_decision');
  const now = new Date().toISOString();
  const reason = snapshot.options.reason ?? '';
  const promotionSteps = decision === 'promote' ? [
    'Update canonical proposal/design/tasks/delta-specs as needed.',
    'Run `ai-factory aifhub-mode sync --change <id>`.',
    'Compile a new production SessionBrief.',
    'Run full implementation against the new brief.'
  ] : [];
  const record = {
    schema: DECISION_SCHEMA,
    change_id: snapshot.changeId,
    decision,
    reason,
    promotion_steps: promotionSteps,
    created_at: snapshot.decision.created_at ?? now,
    updated_at: now
  };
  await writeProviderFile(snapshot.root, snapshot.paths.decision, record);
  return decision;
}

function renderSummary(snapshot) {
  const b = snapshot.brief;
  const d = snapshot.decision;
  const f = snapshot.findings;
  const lines = [
    `# Tracer implementation summary: ${b.change_id}`,
    '',
    '## Hypothesis',
    '',
    b.hypothesis || '(none)',
    '',
    '## Minimum vertical path',
    '',
    b.minimum_vertical_path || '(none)',
    '',
    '## Architecture questions',
    '',
    b.architecture_questions.map((q) => `- ${q}`).join('\n') || '- (none)',
    '',
    '## Production non-goals',
    '',
    b.production_non_goals.map((g) => `- ${g}`).join('\n') || '- (none)',
    '',
    '## Budget',
    '',
    `- Time: ${b.budget.time || 'unspecified'}`,
    `- Cost: ${b.budget.cost || 'unspecified'}`,
    `- Tools: ${b.budget.tools.join(', ') || 'unspecified'}`,
    '',
    '## Expected artifacts',
    '',
    b.expected_artifacts.map((a) => `- ${a}`).join('\n') || '- (none)',
    '',
    '## Findings',
    '',
    f.findings.map((item) => `- [${item.category}] ${item.summary}`).join('\n') || '- (none)',
    '',
    f.result_summary ? `## Result summary\n\n${f.result_summary}\n` : '',
    '## Decision',
    '',
    d.decision ? `**${d.decision}** — ${d.reason}` : '(no decision yet)',
    '',
    d.promotion_steps.length ? d.promotion_steps.map((step) => `- ${step}`).join('\n') : ''
  ];
  return lines.join('\n');
}

async function readJsonIfExists(root, relative) {
  try {
    const bytes = await readProviderFile(root, relative, 4 * 1024 * 1024);
    if (bytes === null) return null;
    return JSON.parse(bytes.toString('utf8'));
  } catch { return null; }
}

async function writeTextFile(root, relative, text) {
  const target = await safeProviderPath(root, relative);
  await mkdir(path.dirname(target.path), { recursive: true });
  const temporary = `${relative}.${randomUUID()}.tmp`;
  const tempTarget = await safeProviderPath(root, temporary);
  const handle = await open(tempTarget.path, 'wx', 0o600);
  try { await handle.writeFile(text, 'utf8'); } finally { await handle.close(); }
  try {
    await safeProviderPath(root, relative);
    await rename(tempTarget.path, target.path);
  } finally {
    try { await unlink(tempTarget.path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

async function readTracerState(root, changeId) {
  const paths = tracerPaths(changeId);
  const [brief, findings, decision] = await Promise.all([
    readJsonIfExists(root, paths.brief),
    readJsonIfExists(root, paths.findings),
    readJsonIfExists(root, paths.decision)
  ]);
  return { root, changeId, paths, brief, findings, decision };
}

async function writeSummary(root, changeId) {
  const state = await readTracerState(root, changeId);
  if (!state.brief) throw tracerError('missing_tracer_brief');
  await writeTextFile(root, state.paths.summary, renderSummary(state));
}

function sha256(value) { return createHash('sha256').update(value).digest('hex'); }

function failure(error, changeId) {
  return {
    ok: false,
    outcome: 'blocked',
    errors: [{ code: error.tracerCode ?? 'tracer_io_error' }],
    paths: changeId ? tracerPaths(changeId) : null
  };
}

export async function runTracerCommand(argv = process.argv.slice(2), options = {}) {
  const [command, ...args] = argv;
  const parsed = { ...options };
  let jsonOutput = false;
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (seen.has(flag)) return invalid({ jsonOutput, stdout: options.stdout });
    seen.add(flag);
    if (flag === '--json') jsonOutput = true;
    else if (flag === '--change' && args[i + 1] && !args[i + 1].startsWith('--')) parsed.changeId = args[++i];
    else if (flag === '--hypothesis' && args[i + 1] && !args[i + 1].startsWith('--')) parsed.hypothesis = args[++i];
    else if (flag === '--vertical-path' && args[i + 1] && !args[i + 1].startsWith('--')) parsed.minimumVerticalPath = args[++i];
    else if (flag === '--question' && args[i + 1] && !args[i + 1].startsWith('--')) { parsed.questions = parsed.questions ?? []; parsed.questions.push(args[++i]); }
    else if (flag === '--non-goal' && args[i + 1] && !args[i + 1].startsWith('--')) { parsed.nonGoals = parsed.nonGoals ?? []; parsed.nonGoals.push(args[++i]); }
    else if (flag === '--budget-time' && args[i + 1] && !args[i + 1].startsWith('--')) { parsed.budget = parsed.budget ?? {}; parsed.budget.time = args[++i]; }
    else if (flag === '--budget-cost' && args[i + 1] && !args[i + 1].startsWith('--')) { parsed.budget = parsed.budget ?? {}; parsed.budget.cost = args[++i]; }
    else if (flag === '--budget-tool' && args[i + 1] && !args[i + 1].startsWith('--')) { parsed.budget = parsed.budget ?? {}; parsed.budget.tools = parsed.budget.tools ?? []; parsed.budget.tools.push(args[++i]); }
    else if (flag === '--expected-artifact' && args[i + 1] && !args[i + 1].startsWith('--')) { parsed.expectedArtifacts = parsed.expectedArtifacts ?? []; parsed.expectedArtifacts.push(args[++i]); }
    else if (flag === '--reason' && args[i + 1] && !args[i + 1].startsWith('--')) parsed.reason = args[++i];
    else if (flag === '--finding' && args[i + 1]) {
      const [category, summary] = args[i + 1].split(':', 2);
      if (!category || !summary) return invalid({ jsonOutput, stdout: options.stdout });
      parsed.findings = parsed.findings ?? [];
      parsed.findings.push({ id: `F-${(parsed.findings.length + 1)}`, category, summary });
      i += 1;
    }
    else if (flag === '--result-summary' && args[i + 1] && !args[i + 1].startsWith('--')) parsed.resultSummary = args[++i];
    else if (flag === '--evidence' && args[i + 1] && !args[i + 1].startsWith('--')) { parsed.evidence = parsed.evidence ?? []; const [path, ...rest] = args[i + 1].split(':'); parsed.evidence.push({ path, description: rest.join(':') }); i += 1; }
    else return invalid({ jsonOutput, stdout: options.stdout });
  }

  let result;
  if (['run', 'promote', 'discard', 'replan', 'blocked', 'status'].includes(command)) {
    if (command === 'run') result = await runTracer(parsed);
    else if (command === 'status') result = await statusTracer(parsed);
    else result = await decideTracer({ ...parsed, decision: command });
  } else {
    return invalid({ jsonOutput, stdout: options.stdout });
  }

  const exitCode = result.ok ? 0 : 1;
  const output = jsonOutput ? `${JSON.stringify(result, null, 2)}\n` : `Tracer: ${result.outcome}\n${(result.errors ?? []).map((error) => error.code).join('\n')}`;
  (options.stdout ?? process.stdout).write(output.endsWith('\n') ? output : `${output}\n`);
  return exitCode;
}

function invalid({ jsonOutput, stdout }) {
  const output = jsonOutput ? JSON.stringify({ ok: false, outcome: 'blocked', errors: [{ code: 'invalid_arguments' }] }) + '\n' : 'Tracer: blocked\ninvalid_arguments\n';
  (stdout ?? process.stdout).write(output);
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await runTracerCommand();
}
