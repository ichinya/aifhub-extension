// Hidden grader for the fix lifecycle scenario (passkey swallowed GCM auth error).
// Usage: node fix-passkey-grader.mjs <projectRoot>
//
// Checks, in order:
// 1. The prepared QA evidence verify.md was not rewritten by the fixer.
// 2. A fix trace exists under .ai-factory/state/<change-id>/fixes/.
// 3. The injected hidden Go test passes after the fix (uniform rejection + valid round trip).

import { copyFile, readFile, readdir, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { caseRootOf, pass, readText } from './grader-lib.mjs';

const projectRoot = process.argv[2];
if (!projectRoot) throw new Error('project root argument is required');
const changeId = 'lifecycle-decrypt-auth';
const caseRoot = caseRootOf(projectRoot);

const evidencePath = path.join(projectRoot, '.ai-factory', 'qa', changeId, 'verify.md');
const expectedSha = (await readText(path.join(caseRoot, 'treatment', 'verify-evidence.sha256'), 'verify-evidence.sha256')).trim();
const actualSha = createHash('sha256').update(await readFile(evidencePath)).digest('hex');
if (actualSha !== expectedSha) {
  throw new Error('the fixer rewrote the authoritative QA evidence verify.md; /aif-fix must not write QA verdicts');
}

const fixesDir = path.join(projectRoot, '.ai-factory', 'state', changeId, 'fixes');
let traceEntries = [];
try {
  traceEntries = await readdir(fixesDir);
} catch {
  throw new Error(`fix trace directory is missing under .ai-factory/state/${changeId}/fixes/`);
}
if (traceEntries.length === 0) {
  throw new Error('fix trace directory is empty; the fixer must persist its trace');
}

const graderPath = fileURLToPath(new URL('../ponytail-pi-ab/passkey-invalid-ciphertext_test.go', import.meta.url));
const injectedPath = path.join(projectRoot, 'go', 'ponytail_ab_hidden_test.go');
await copyFile(graderPath, injectedPath);
let exitCode;
let outputTail = '';
try {
  const child = spawnSync('go', ['test', '-skip', 'OpenSSL', './...'], {
    cwd: path.join(projectRoot, 'go'),
    encoding: 'utf8',
  });
  exitCode = child.status;
  outputTail = `${child.stdout ?? ''}${child.stderr ?? ''}`.slice(-400);
} finally {
  await rm(injectedPath, { force: true });
}
if (exitCode !== 0) {
  throw new Error(`hidden Go test failed after the fix (exit ${exitCode}): ${outputTail}`);
}

pass('ponytail_lifecycle_fix_grader');
