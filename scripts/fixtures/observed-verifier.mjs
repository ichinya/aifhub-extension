#!/usr/bin/env node
// Offline fixture verifier for observed-run tests (#227): a real Node script the
// adapter launches through injectable execFile, producing deterministic report
// bytes so crash-resume adoption and declared-digest checks stay reproducible.
// Modes: pass, fail (exit 2), hang (killed by adapter timeout), noreport (exit 0
// without a report), cancel (stopped by an external abort), unsupported (never
// spawned by the adapter; kept for direct smoke runs).
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

export function observedVerifierReport({ mode, check_id = 'check-verify' }) {
  const status = mode === 'pass' ? 'pass' : mode === 'fail' ? 'fail' : 'aborted';
  return `${JSON.stringify({ schema: 'fixture-verifier-report.v1', mode, check_id, status }, null, 2)}\n`;
}

async function main() {
  const args = process.argv.slice(2);
  const value = (name, fallback = null) => {
    const index = args.indexOf(`--${name}`);
    return index >= 0 && typeof args[index + 1] === 'string' ? args[index + 1] : fallback;
  };
  const mode = value('mode', 'pass');
  const report = value('report');
  const checkId = value('check', 'check-verify');
  if (mode === 'pass' || mode === 'fail') {
    if (report) {
      await mkdir(path.dirname(path.resolve(report)), { recursive: true });
      await writeFile(report, observedVerifierReport({ mode, check_id: checkId }));
    }
    process.exitCode = mode === 'fail' ? 2 : 0;
    return;
  }
  if (mode === 'noreport') return; // exits cleanly without writing a report
  if (mode === 'hang' || mode === 'cancel') { await new Promise(resolve => setTimeout(resolve, 30000)); return; }
  if (mode === 'unsupported') { process.exitCode = 3; return; }
  process.exitCode = 64;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === pathToFileURL(fileURLToPath(import.meta.url)).href) {
  await main();
}
