// Fresh-context AI review context preparation. Produces a review target diff and
// a supporting receipt without running the actual AI reviewer.
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { ensureRuntimeGitignore } from './runtime-gitignore.mjs';
import { resolveActiveChange, normalizeChangeId } from './active-change-resolver.mjs';
import { inspectSessionBrief } from './session-brief.mjs';
import { loadReviewPolicy } from './review-policy-resolver.mjs';
import { readProviderFile, safeProviderPath, writeProviderFile } from './provider-files.mjs';

const SCHEMA = 'aifhub.ai_cross_context_review.v1';
const MAX_DIFF_BYTES = 16 * 1024 * 1024;
const MAX_UNTRACKED_FILE_BYTES = 2 * 1024 * 1024;
const execFileAsync = promisify(execFile);

export function reviewError(code) {
  const error = new Error(code);
  error.reviewCode = code;
  return error;
}

export function freshContextReviewPaths(changeId, reviewId) {
  if (!normalizeChangeId(changeId).ok) throw reviewError('invalid-change-id');
  if (!reviewId || typeof reviewId !== 'string') throw reviewError('invalid-review-id');
  const dir = `.ai-factory/state/${changeId}/reviews/${reviewId}`;
  return {
    dir,
    json: `${dir}/ai-cross-context-review.json`,
    diff: `${dir}/review-target.diff`
  };
}

export async function prepareFreshContextReview(options = {}) {
  try {
    const snapshot = await buildReviewSnapshot(options);
    const receipt = buildReceipt(snapshot);
    if (receipt.outcome === 'blocked') {
      const minimal = emptyReceipt({
        changeId: snapshot.changeId,
        reviewId: snapshot.reviewId,
        contextMode: snapshot.contextMode,
        executionProfile: snapshot.executionProfile,
        sameSessionFallback: snapshot.sameSessionFallback
      }, {
        outcome: 'blocked',
        blockedReasons: receipt.blocked_reasons
      });
      return { ok: false, outcome: 'blocked', receipt: minimal };
    }
    const target = freshContextReviewPaths(snapshot.changeId, snapshot.reviewId);
    await ensureRuntimeGitignore(snapshot.root, '.ai-factory/state');
    const diffText = snapshot.targetDiff;
    if (diffText) await writeReviewTextFile(snapshot.root, target.diff, diffText);
    const written = await writeProviderFile(snapshot.root, target.json, receipt);
    return { ok: true, outcome: receipt.outcome, receipt: written };
  } catch (error) { return failure(error); }
}

async function buildReviewSnapshot(options) {
  const root = path.resolve(options.rootDir ?? process.cwd());
  if (options.changeId !== undefined && (typeof options.changeId !== 'string' || !options.changeId || !normalizeChangeId(options.changeId).ok)) throw reviewError('invalid-change-id');
  const resolution = await resolveActiveChange({ rootDir: root, cwd: options.cwd ?? root, changeId: options.changeId, getCurrentBranch: options.getCurrentBranch });
  if (!resolution.ok) throw reviewError('active_change_unresolved');
  const changeId = resolution.changeId;
  const status = await inspectSessionBrief({ rootDir: root, cwd: options.cwd ?? root, changeId, includeBrief: true });
  const brief = status.brief;
  const reviewId = options.reviewId ?? `review-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const contextMode = options.sameSessionFallback ? 'same_session' : 'fresh';
  const executionProfile = options.executionProfile ?? 'ai-fresh-context';

  const blockedReasons = [];
  if (!brief || !status.ok || status.status !== 'valid') blockedReasons.push('session_brief_not_current');

  const policy = await loadReviewPolicy({ rootDir: root });
  const targetInfo = await buildTargetDiff(root, options);
  if (!targetInfo) blockedReasons.push('missing_target');
  if (targetInfo?.tooLarge) blockedReasons.push('target_too_large');

  const sourceRevisions = buildSourceRevisions(brief, policy);

  return {
    root,
    changeId,
    reviewId,
    contextMode,
    executionProfile,
    sameSessionFallback: !!options.sameSessionFallback,
    brief,
    policy,
    targetDiff: targetInfo?.diff ?? null,
    targetInfo,
    sourceRevisions,
    blockedReasons
  };
}

function buildSourceRevisions(brief, policy) {
  const revisions = [];
  if (brief?.context_manifest) {
    for (const entry of brief.context_manifest) {
      if (entry?.path) revisions.push({ path: entry.path, sha256: entry.sha256 ?? null });
    }
  }
  if (policy?.ok && policy.state === 'present' && policy.path) {
    revisions.push({ path: toPosix(policy.path), sha256: policy.revision ?? null });
  }
  return revisions;
}

async function buildTargetDiff(root, options) {
  if (typeof options.targetDiff === 'string') {
    return { diff: options.targetDiff, changedFiles: options.changedFiles ?? [], untrackedFiles: [], base: options.targetBase ?? null, head: options.targetHead ?? 'worktree', fingerprint: sha256(options.targetDiff), tooLarge: false };
  }
  if (Array.isArray(options.changedFiles)) {
    const parts = [];
    for (const file of [...options.changedFiles].sort()) {
      const content = await readTextFile(root, file, MAX_UNTRACKED_FILE_BYTES);
      if (content === null) continue;
      parts.push(untrackedFileDiff(file, content));
    }
    const diff = parts.join('\n');
    return { diff, changedFiles: options.changedFiles, untrackedFiles: options.changedFiles, base: null, head: 'worktree', fingerprint: diff ? sha256(diff) : null, tooLarge: false };
  }
  const gitStatus = await gitStatus(root);
  if (!gitStatus) return null;
  const { tracked, untracked } = gitStatus;
  if (tracked.length === 0 && untracked.length === 0) {
    return { diff: '', changedFiles: [], untrackedFiles: [], base: gitStatus.base, head: 'worktree', fingerprint: null, tooLarge: false };
  }
  let diff = '';
  if (tracked.length > 0) {
    const trackedDiff = await gitDiff(root, tracked);
    if (trackedDiff === null) return null;
    diff += trackedDiff;
  }
  for (const file of untracked) {
    if (Buffer.byteLength(diff) > MAX_DIFF_BYTES) return { diff: null, changedFiles: tracked, untrackedFiles: untracked, base: gitStatus.base, head: 'worktree', fingerprint: null, tooLarge: true };
    const content = await readTextFile(root, file, MAX_UNTRACKED_FILE_BYTES);
    if (content === null) continue; // missing or unsafe
    const fileDiff = untrackedFileDiff(file, content);
    if (diff.length > 0) diff += '\n';
    diff += fileDiff;
  }
  if (Buffer.byteLength(diff) > MAX_DIFF_BYTES) {
    return { diff: null, changedFiles: tracked, untrackedFiles: untracked, base: gitStatus.base, head: 'worktree', fingerprint: null, tooLarge: true };
  }
  const fingerprint = diff === '' ? null : sha256(diff);
  return { diff, changedFiles: [...tracked, ...untracked], untrackedFiles: untracked, base: gitStatus.base, head: 'worktree', fingerprint, tooLarge: false };
}

async function gitStatus(root) {
  try {
    const head = await gitHead(root);
    const result = await execFileAsync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: root, timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
    if (result.stderr) return null;
    const tracked = [];
    const untracked = [];
    for (const line of result.stdout.split(/\r\n|\n|\r/)) {
      if (!line) continue;
      const status = line.slice(0, 2);
      if (status === '!!') continue;
      const rest = line.slice(3);
      const file = toPosix(rest.split(' -> ').pop().trim());
      if (!file) continue;
      if (status === '??') untracked.push(file);
      else tracked.push(file);
    }
    return { base: head, tracked, untracked };
  } catch { return null; }
}

async function gitHead(root) {
  try {
    const result = await execFileAsync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: root, timeout: 30000 });
    if (result.stderr) return null;
    return result.stdout.trim();
  } catch { return null; }
}

async function gitDiff(root, paths) {
  try {
    const result = await execFileAsync('git', ['diff', 'HEAD', '--', ...paths], { cwd: root, timeout: 60000, maxBuffer: MAX_DIFF_BYTES });
    if (result.stderr) return null;
    return result.stdout;
  } catch { return null; }
}

async function readTextFile(root, relative, limit) {
  try {
    const bytes = await readProviderFile(root, relative, limit);
    if (bytes === null) return null;
    return bytes.toString('utf8');
  } catch { return null; }
}

function untrackedFileDiff(filePath, text) {
  const hasTrailing = text.endsWith('\n');
  const rawLines = text.split(/\r\n|\n|\r/);
  const lines = hasTrailing ? rawLines.slice(0, -1) : rawLines;
  const n = lines.length;
  const header = [
    `diff --git a/${filePath} b/${filePath}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ b/${filePath}`,
    n === 0 ? '@@ -0,0 +1,0 @@' : `@@ -0,0 +1,${n} @@`
  ];
  const body = lines.map((line) => `+${line}`);
  if (!hasTrailing && n > 0) body.push('\\ No newline at end of file');
  return [...header, ...body].join('\n') + '\n';
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function buildReceipt(snapshot) {
  const brief = snapshot.brief;
  const blockedReasons = [...snapshot.blockedReasons];
  const target = snapshot.targetInfo ?? { base: null, head: null, fingerprint: null, path: null, changed_files: [], untracked_files: [], too_large: false };

  if (blockedReasons.length > 0) {
    return { ...emptyReceipt(snapshot), outcome: 'blocked', blocked_reasons: blockedReasons };
  }

  const paths = freshContextReviewPaths(snapshot.changeId, snapshot.reviewId);
  const receipt = emptyReceipt(snapshot);
  receipt.target = {
    base: target.base,
    head: target.head,
    fingerprint: target.fingerprint,
    path: snapshot.targetDiff === null ? null : 'review-target.diff',
    changed_files: target.changedFiles ?? [],
    untracked_files: target.untrackedFiles ?? [],
    too_large: target.tooLarge ?? false
  };
  receipt.session_brief_digest = brief?.digest ?? null;
  receipt.source_revisions = snapshot.sourceRevisions;
  receipt.acceptance_criteria = brief?.acceptance_criteria ?? [];
  receipt.acceptance_examples = brief?.acceptance_examples ?? [];
  receipt.change_surface = {
    allowed: brief?.change_surface?.allowed ? brief.change_surface.allowed.flatMap((s) => parseBulletSection(s)) : [],
    forbidden: brief?.change_surface?.forbidden ? brief.change_surface.forbidden.flatMap((s) => parseBulletSection(s)) : []
  };
  receipt.findings = [];
  receipt.finding_count = 0;
  receipt.outcome = 'prepared';
  receipt.blocked_reasons = [];
  return receipt;
}

function emptyReceipt(snapshot, overrides = {}) {
  const now = new Date().toISOString();
  return {
    schema: SCHEMA,
    change_id: snapshot?.changeId ?? 'unknown',
    review_id: snapshot?.reviewId ?? overrides?.reviewId ?? 'unknown',
    context_mode: snapshot?.contextMode ?? overrides?.contextMode ?? 'fresh',
    execution_profile: snapshot?.executionProfile ?? overrides?.executionProfile ?? 'ai-fresh-context',
    target: { base: null, head: null, fingerprint: null, path: null, changed_files: [], untracked_files: [], too_large: false },
    session_brief_digest: null,
    source_revisions: [],
    acceptance_criteria: [],
    acceptance_examples: [],
    change_surface: { allowed: [], forbidden: [] },
    findings: [],
    finding_count: 0,
    outcome: overrides?.outcome ?? 'blocked',
    created_at: now,
    same_session_fallback: snapshot?.sameSessionFallback ?? overrides?.sameSessionFallback ?? false,
    blocked_reasons: overrides?.blockedReasons ?? []
  };
}

function parseBulletSection(section) {
  const items = [];
  for (const line of String(section ?? '').split(/\r\n|\n|\r/)) {
    const item = line.trim().replace(/^[-*+]\s+/, '').trim();
    if (item) items.push(item);
  }
  return items;
}

async function writeReviewTextFile(root, relative, text) {
  if (Buffer.byteLength(text) > MAX_DIFF_BYTES) throw reviewError('target_too_large');
  const target = await safeProviderPath(root, relative);
  if (target.exists) {
    const info = await lstat(target.path);
    if (!info.isFile() || info.nlink !== 1) throw reviewError('unsafe_path');
  }
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
  return target.path;
}

function failure(error) {
  const receipt = emptyReceipt(null, {
    outcome: 'blocked',
    blockedReasons: [error.reviewCode ?? 'fresh_context_review_io_error']
  });
  if (error?.changeId) receipt.change_id = error.changeId;
  if (error?.reviewId) receipt.review_id = error.reviewId;
  return { ok: false, outcome: 'blocked', errors: [{ code: error.reviewCode ?? 'fresh_context_review_io_error' }], receipt };
}

function toPosix(value) { return String(value ?? '').replaceAll('\\', '/'); }

export async function runFreshContextReviewCommand(argv = process.argv.slice(2), options = {}) {
  const [command, ...args] = argv;
  const parsed = { ...options };
  let jsonOutput = false;
  let invalid = !['prepare'].includes(command);
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (seen.has(flag)) invalid = true;
    seen.add(flag);
    if (flag === '--json') jsonOutput = true;
    else if (flag === '--change' && args[i + 1] && !args[i + 1].startsWith('--')) parsed.changeId = args[++i];
    else if (flag === '--review-id' && args[i + 1] && !args[i + 1].startsWith('--')) parsed.reviewId = args[++i];
    else if (flag === '--same-session') parsed.sameSessionFallback = true;
    else if (flag === '--execution-profile' && args[i + 1] && !args[i + 1].startsWith('--')) parsed.executionProfile = args[++i];
    else invalid = true;
  }
  let result;
  if (invalid) result = { ok: false, outcome: 'blocked', errors: [{ code: 'invalid_arguments' }], receipt: emptyReceipt(null, {}) };
  else result = await prepareFreshContextReview(parsed);
  const exitCode = invalid || result.errors?.length ? 2 : result.ok ? 0 : 1;
  const output = jsonOutput ? `${JSON.stringify(result.receipt, null, 2)}\n` : `Fresh-context review: ${result.outcome}\n${(result.errors ?? []).map((error) => error.code).join('\n')}`;
  (options.stdout ?? process.stdout).write(output.endsWith('\n') ? output : `${output}\n`);
  return exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await runFreshContextReviewCommand();
}
