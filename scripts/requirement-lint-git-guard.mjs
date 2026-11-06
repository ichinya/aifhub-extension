// Fixed-path git verification for the requirement-lint observation writer. The
// writer receives only the repository-relative path built from a normalized
// change id; untrusted requirement text never reaches a process argument. The
// main lint module stays free of process/network imports; this guard is the
// single sanctioned git touchpoint, mirroring scripts/docs-readability-git-guard.mjs.
// It closes the AC3 gap the snapshot projections cannot see: `git diff --binary
// HEAD --` feeds `actual_diff` without a namespace filter, so a tracked
// observation (or any not-effectively-ignored output) must be refused before
// the first write, not filtered afterwards.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

async function git(rootDir, args, run) {
  const value = await run('git', args, { cwd: rootDir, windowsHide: true, timeout: 10000, maxBuffer: 262144 });
  return String(value.stdout ?? value ?? '');
}

export async function verifyObservationIgnored(rootDir, relative, options = {}) {
  const run = options.execGit ?? exec;
  let inside;
  try {
    inside = (await git(rootDir, ['rev-parse', '--is-inside-work-tree'], run)).trim();
  } catch (error) {
    const stderr = String(error?.stderr ?? error?.message ?? '');
    // Only git's own explicit line-anchored verdict ("fatal: not a git
    // repository …") means "no tracking semantics to verify"; any other
    // failure fails closed.
    if (error?.code === 128 && /^fatal: not a git repository(?:$|\s|\()/im.test(stderr)) {
      return { ok: true, gitWorktree: false, ignored: true, tracked: false, reason: 'not-git' };
    }
    return { ok: false, code: 'git-verify-failed', detail: 'rev-parse' };
  }
  if (inside !== 'true') return { ok: true, gitWorktree: false, ignored: true, tracked: false, reason: 'not-git' };
  // Tracked status is checked first: a tracked file is never "ignored" by
  // git's own check-ignore verdict, so the tracked refusal must not be
  // masked by the not-ignored code.
  let tracked;
  try {
    tracked = (await git(rootDir, ['ls-files', '--cached', '-z', '--', relative], run)).length > 0;
  } catch {
    return { ok: false, code: 'git-verify-failed', detail: 'ls-files' };
  }
  if (tracked) return { ok: false, code: 'observation-path-tracked', detail: relative };
  let ignored;
  try {
    await run('git', ['check-ignore', '-q', '--', relative],
      { cwd: rootDir, windowsHide: true, timeout: 10000, maxBuffer: 65536 });
    ignored = true; // exit 0: git's own verdict — path is ignored
  } catch (error) {
    if (error?.code === 1) ignored = false; // git's own verdict: not ignored
    else return { ok: false, code: 'git-verify-failed', detail: 'check-ignore' };
  }
  if (!ignored) return { ok: false, code: 'observation-path-not-ignored', detail: relative };
  return { ok: true, gitWorktree: true, ignored: true, tracked: false };
}
