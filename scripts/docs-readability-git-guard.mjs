// Fixed-path git verification for the readability report writer. The runner is
// fed only repository-relative paths that the caller already validated; untrusted
// document text never reaches a process argument (decision 13 boundary). The main
// readability module stays free of process/network imports; this guard is the
// single sanctioned git touchpoint, mirroring the output-guard model of
// scripts/runner-metrics-collector.mjs.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

async function git(rootDir, args, run) {
  const value = await run('git', args, { cwd: rootDir, windowsHide: true, timeout: 10000, maxBuffer: 262144 });
  return String(value.stdout ?? value ?? '');
}

export async function verifyReportIgnored(rootDir, relative, options = {}) {
  const run = options.execGit ?? exec;
  let inside;
  try {
    inside = (await git(rootDir, ['rev-parse', '--is-inside-work-tree'], run)).trim();
  } catch (error) {
    if (error?.code === 128 || /not a git repository/i.test(String(error?.stderr ?? ''))) {
      return { ok: true, gitWorktree: false, ignored: true, tracked: false, reason: 'not-git' };
    }
    return { ok: false, code: 'git-verify-failed', detail: 'rev-parse' };
  }
  if (inside !== 'true') return { ok: true, gitWorktree: false, ignored: true, tracked: false, reason: 'not-git' };
  let ignored;
  try {
    await run('git', ['check-ignore', '-q', '--', relative],
      { cwd: rootDir, windowsHide: true, timeout: 10000, maxBuffer: 65536 });
    ignored = true; // exit 0: git's own verdict — path is ignored
  } catch (error) {
    if (error?.code === 1) ignored = false; // git's own verdict: not ignored
    else return { ok: false, code: 'git-verify-failed', detail: 'check-ignore' };
  }
  if (!ignored) return { ok: false, code: 'report-path-not-ignored', detail: relative };
  let tracked;
  try {
    tracked = (await git(rootDir, ['ls-files', '--cached', '-z', '--', relative], run)).length > 0;
  } catch {
    return { ok: false, code: 'git-verify-failed', detail: 'ls-files' };
  }
  if (tracked) return { ok: false, code: 'report-path-tracked', detail: relative };
  return { ok: true, gitWorktree: true, ignored: true, tracked: false };
}
