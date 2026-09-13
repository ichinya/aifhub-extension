// Plan compliance / drift receipt. Compares canonical plan, SessionBrief, and changed scope.
import { execFile } from 'node:child_process';
import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { ensureRuntimeGitignore } from './runtime-gitignore.mjs';
import { resolveActiveChange, normalizeChangeId } from './active-change-resolver.mjs';
import { parseExecutionTasks } from './execution-task-source.mjs';
import { findExactMarkdownH2Sections } from './markdown-structural-markers.mjs';
import { inspectSessionBrief } from './session-brief.mjs';
import { readProviderFile, writeProviderFile, safeProviderPath } from './provider-files.mjs';

const SCHEMA = 'aifhub.plan_compliance.v1';
const MAX_FILES = 1024;
const execFileAsync = promisify(execFile);

export function complianceError(code) {
  const error = new Error(code);
  error.complianceCode = code;
  return error;
}

export function planCompliancePaths(changeId) {
  if (!normalizeChangeId(changeId).ok) throw complianceError('invalid-change-id');
  return { json: `.ai-factory/state/${changeId}/implementation/plan-compliance.json` };
}

export async function checkPlanCompliance(options = {}) {
  try {
    const snapshot = await buildSnapshot(options);
    const receipt = buildReceipt(snapshot);
    const output = json(receipt);
    if (output.length > 4 * 1024 * 1024) throw complianceError('receipt_budget_exceeded');
    const target = planCompliancePaths(snapshot.changeId).json;
    await ensureRuntimeGitignore(snapshot.root, '.ai-factory/state');
    const written = await writeProviderFile(snapshot.root, target, receipt);
    return { ok: receipt.outcome === 'compliant' || receipt.outcome === 'acceptable_drift', outcome: receipt.outcome, receipt: written };
  } catch (error) { return failure(error); }
}

async function buildSnapshot(options) {
  const root = path.resolve(options.rootDir ?? process.cwd());
  if (options.changeId !== undefined && (typeof options.changeId !== 'string' || !options.changeId || !normalizeChangeId(options.changeId).ok)) throw complianceError('invalid-change-id');
  const resolution = await resolveActiveChange({ rootDir: root, cwd: options.cwd ?? root, changeId: options.changeId, getCurrentBranch: options.getCurrentBranch });
  if (!resolution.ok) throw complianceError('active_change_unresolved');
  const changeId = resolution.changeId;
  const status = await inspectSessionBrief({ rootDir: root, cwd: options.cwd ?? root, changeId, includeBrief: true });
  const tasks = await readTasks(root, resolution.changePath);
  const trace = await findTrace(root, changeId, options.runId);
  const changedFiles = options.changedFiles ?? (trace ? trace.changedFiles : await gitChangedFiles(root));
  return { root, changeId, status, tasks, trace, changedFiles, brief: status.brief };
}

async function readTasks(root, changePath) {
  const relative = toPosix(path.relative(root, path.join(changePath, 'tasks.md')));
  if (!relative || relative.startsWith('..') || relative.includes(':')) throw complianceError('unsafe_path');
  const bytes = await readProviderFile(root, relative, 2 * 1024 * 1024);
  if (bytes === null) return null;
  const text = bytes.toString('utf8');
  try { return parseExecutionTasks(text); } catch { throw complianceError('invalid_tasks'); }
}

async function findTrace(root, changeId, runId) {
  const implDir = `.ai-factory/state/${changeId}/implementation`;
  const entries = await listTraceFiles(root, implDir);
  if (entries.length === 0) return null;
  let selected = runId ? entries.find((entry) => entry.name === `${runId}.md`) : null;
  if (!selected) {
    entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
    selected = entries[0];
  }
  if (!selected) return null;
  const bytes = await readProviderFile(root, `${implDir}/${selected.name}`, 4 * 1024 * 1024);
  if (bytes === null) return null;
  const content = bytes.toString('utf8');
  const changedFiles = parseTraceList(content, 'Changed files');
  const binding = parseTraceSection(content, 'SessionBrief binding');
  const sessionBriefDigest = binding?.match(/^Digest: ([a-f0-9]{64})$/m)?.[1] ?? null;
  const run = selected.name.replace(/\.md$/, '');
  const acceptanceImpact = traceAcceptanceImpact(content);
  return { runId: run, changedFiles, sessionBriefDigest, acceptanceImpact };
}

async function listTraceFiles(root, directory) {
  const dir = await safeProviderPath(root, directory);
  if (!dir.exists) return [];
  const stat = await lstat(dir.path);
  if (!stat.isDirectory()) throw complianceError('unsafe_path');
  const names = await readdir(dir.path);
  const results = [];
  for (const name of names) {
    if (!name.endsWith('.md')) continue;
    const file = await safeProviderPath(root, `${directory}/${name}`);
    if (!file.exists) continue;
    const info = await lstat(file.path);
    if (!info.isFile() || info.nlink !== 1) throw complianceError('unsafe_path');
    results.push({ name, mtimeMs: info.mtimeMs });
  }
  if (results.length > MAX_FILES) throw complianceError('trace_inventory_exceeded');
  return results;
}

function parseTraceList(content, heading) {
  const sections = findExactMarkdownH2Sections(content, heading);
  if (sections.length === 0) return [];
  const lines = sections[0].join('\n').split(/\r\n|\n|\r/);
  const items = [];
  for (const line of lines) {
    const trimmed = line.trim();
    const match = trimmed.match(/^[-*+]\s+(.+)$/);
    if (match) items.push(toPosix(match[1].trim()));
  }
  return items;
}

function parseTraceSection(content, heading) {
  const sections = findExactMarkdownH2Sections(content, heading);
  if (sections.length === 0) return '';
  return sections[0].join('\n').trim();
}

const ACCEPTANCE_HEADINGS = {
  test_check: 'Focused automated check',
  red_result: 'RED result',
  green_result: 'GREEN result',
  refactor_result: 'REFACTOR result',
  fallback_decision: 'Fallback decision'
};

function traceAcceptanceImpact(content) {
  const impact = [];
  const sections = findExactMarkdownH2Sections(content, 'Development cycle');
  if (sections.length > 0) {
    const body = sections[0].join('\n');
    for (const [marker, heading] of Object.entries(ACCEPTANCE_HEADINGS)) {
      if (new RegExp(`^### ${heading}$`, 'im').test(body)) impact.push(marker);
    }
  }
  return impact;
}

async function gitChangedFiles(root) {
  try {
    const result = await execFileAsync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: root, timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
    if (result.stderr) return null;
    const files = [];
    for (const line of result.stdout.split(/\r\n|\n|\r/)) {
      if (!line) continue;
      const file = toPosix(line.slice(3).split(' -> ').pop().trim());
      if (file) files.push(file);
    }
    return files;
  } catch { return null; }
}

function buildReceipt(snapshot) {
  const brief = snapshot.brief;
  const planRevision = brief?.source_revision ?? null;
  const sessionBriefDigest = brief?.digest ?? null;
  const traceRunId = snapshot.trace?.runId ?? null;
  const completedTasks = [];
  const skippedTasks = [];
  if (snapshot.tasks) {
    for (const task of snapshot.tasks) {
      if (task.checked) completedTasks.push({ id: task.id, title: task.title });
      else skippedTasks.push({ id: task.id, title: task.title });
    }
  }

  const blockedReasons = [];
  if (!brief || !snapshot.status.ok || snapshot.status.status !== 'valid') blockedReasons.push('session_brief_not_current');
  if (!snapshot.tasks) blockedReasons.push('missing_tasks');
  if (!snapshot.changedFiles) blockedReasons.push('missing_changed_scope');
  if (snapshot.trace && snapshot.trace.sessionBriefDigest && snapshot.trace.sessionBriefDigest !== sessionBriefDigest) blockedReasons.push('trace_session_brief_stale');

  if (blockedReasons.length > 0) {
    return emptyReceipt(snapshot.changeId, { planRevision, sessionBriefDigest, traceRunId, completedTasks, skippedTasks, outcome: 'blocked' });
  }

  const allowed = collectSurfacePatterns(brief.change_surface?.allowed ?? []);
  const forbidden = collectSurfacePatterns(brief.change_surface?.forbidden ?? []);
  const unplanned = [];
  const scopeExpansions = [];
  let forbiddenTouched = false;

  for (const file of snapshot.changedFiles) {
    if (matchesAny(file, forbidden)) { forbiddenTouched = true; scopeExpansions.push(file); continue; }
    if (matchesAny(file, allowed)) continue;
    if (isScopeExpansion(file, allowed)) scopeExpansions.push(file);
    else unplanned.push(file);
  }

  let outcome = 'compliant';
  if (forbiddenTouched || scopeExpansions.length > 0) outcome = 'replan_required';
  else if (unplanned.length > 0 || skippedTasks.length > 0) outcome = 'acceptable_drift';

  return emptyReceipt(snapshot.changeId, {
    planRevision,
    sessionBriefDigest,
    traceRunId,
    completedTasks,
    skippedTasks,
    unplannedChanges: unplanned,
    scopeExpansions,
    newConstraints: [],
    acceptanceImpact: snapshot.trace?.acceptanceImpact ?? [],
    outcome,
    replanRequired: outcome === 'replan_required'
  });
}

function emptyReceipt(changeId, values) {
  return {
    schema: SCHEMA,
    change_id: changeId,
    plan_revision: values.planRevision ?? null,
    session_brief_digest: values.sessionBriefDigest ?? null,
    trace_run_id: values.traceRunId ?? null,
    completed_tasks: values.completedTasks ?? [],
    skipped_tasks: values.skippedTasks ?? [],
    unplanned_changes: values.unplannedChanges ?? [],
    scope_expansions: values.scopeExpansions ?? [],
    new_constraints: values.newConstraints ?? [],
    acceptance_impact: values.acceptanceImpact ?? [],
    outcome: values.outcome ?? 'blocked',
    replan_required: values.replanRequired ?? (values.outcome === 'replan_required')
  };
}

function collectSurfacePatterns(sections) {
  const patterns = [];
  for (const section of sections) {
    for (const line of String(section ?? '').split(/\r\n|\n|\r/)) {
      const item = toPosix(line.trim().replace(/^[-*+]\s+/, '').trim());
      if (item) patterns.push(item);
    }
  }
  return patterns;
}

// Glob semantics: '**/' matches zero or more whole path segments (so 'src/**/*'
// also matches 'src/a/b/c.mjs'), a bare '**' matches anything including '/',
// '*' stays within one segment, and '?' matches exactly one non-slash character.
// A trailing '/' on a pattern is treated as '<dir>/**'.
function globToRegex(pattern) {
  let regex = '^';
  let i = 0;
  while (i < pattern.length) {
    if (pattern.slice(i, i + 2) === '**') {
      if (pattern[i + 2] === '/') {
        regex += '(?:.*/)?';
        i += 3;
      } else {
        regex += '.*';
        i += 2;
      }
      continue;
    }
    const c = pattern[i];
    if (c === '*') regex += '[^/]*';
    else if (c === '?') regex += '[^/]';
    else if (/[a-zA-Z0-9_]/.test(c) || c === '-') regex += c;
    else regex += '\\' + c;
    i++;
  }
  regex += '$';
  return new RegExp(regex);
}

function matchesAny(file, patterns) {
  for (const pattern of patterns) {
    const normalized = pattern.endsWith('/') ? pattern.slice(0, -1) + '/**' : pattern;
    const regex = globToRegex(normalized);
    if (regex.test(file)) return true;
  }
  return false;
}

function isScopeExpansion(file, patterns) {
  const top = file.split('/')[0];
  for (const pattern of patterns) {
    const first = pattern.split('/')[0];
    if (first === '**') return false;
    if (first === top) return false;
    if (matchesTopLevel(top, first)) return false;
  }
  return true;
}

function matchesTopLevel(top, pattern) {
  if (!pattern.includes('*') && !pattern.includes('?')) return false;
  const regex = globToRegex(pattern);
  return regex.test(top);
}

function failure(error) {
  const receipt = emptyReceipt('unknown', { planRevision: null, sessionBriefDigest: null, traceRunId: null, completedTasks: [], skippedTasks: [], outcome: 'blocked' });
  receipt.change_id = typeof error?.changeId === 'string' ? error.changeId : 'unknown';
  return { ok: false, outcome: 'blocked', errors: [{ code: error.complianceCode ?? 'plan_compliance_io_error' }], receipt };
}

function json(value) { return `${JSON.stringify(value, null, 2)}\n`; }

function toPosix(value) { return String(value ?? '').replaceAll('\\', '/'); }

export async function runPlanComplianceCommand(argv = process.argv.slice(2), options = {}) {
  const [command, ...args] = argv;
  const parsed = { ...options };
  let jsonOutput = false;
  let invalid = !['check'].includes(command);
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (seen.has(flag)) invalid = true;
    seen.add(flag);
    if (flag === '--json') jsonOutput = true;
    else if (flag === '--change' && args[i + 1] && !args[i + 1].startsWith('--')) parsed.changeId = args[++i];
    else if (flag === '--run-id' && args[i + 1] && !args[i + 1].startsWith('--')) parsed.runId = args[++i];
    else invalid = true;
  }
  let result;
  if (invalid) result = { ok: false, outcome: 'blocked', errors: [{ code: 'invalid_arguments' }], receipt: emptyReceipt('unknown', {}) };
  else result = await checkPlanCompliance(parsed);
  const exitCode = invalid || result.errors?.length ? 2 : result.ok ? 0 : 1;
  const output = jsonOutput ? json(result.receipt) : `Plan compliance: ${result.outcome}\n${(result.errors ?? []).map((error) => error.code).join('\n')}`;
  (options.stdout ?? process.stdout).write(output.endsWith('\n') ? output : `${output}\n`);
  return exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await runPlanComplianceCommand();
}
