// Hidden grader for the security-checklist lifecycle scenario (passkey swallowed GCM auth error).
// Usage: node security-passkey-grader.mjs <projectRoot>

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { assertFinalGateBlock, assertKeywordGroups, caseRootOf, extractAssistantText, pass, readText } from './grader-lib.mjs';

const projectRoot = process.argv[2];
if (!projectRoot) throw new Error('project root argument is required');

const assistantText = extractAssistantText(await readText(path.join(caseRootOf(projectRoot), 'pi-events.jsonl'), 'pi-events.jsonl'));
const gate = assertFinalGateBlock(assistantText, 'security output', 'security');
if (gate.status === 'pass') {
  throw new Error('security verdict is pass but the changed scope swallows the AES-GCM authentication error');
}
assertKeywordGroups(assistantText, [
  ['encrypt\\.go', 'Decrypt', 'gcm', 'Open', 'GCM'],
  ['auth', 'tamper', 'wrong.?key', 'integrity', 'swallow', 'discard', 'ignor', 'silent', 'fallback', 'аутент', 'целостн', 'поддел'],
], 'security output');

// The security sidecar must stay read-only: the worktree must still match the seeded diff.
const headDiff = await readText(path.join(caseRootOf(projectRoot), 'seeded-diff.txt'), 'seeded-diff.txt');
const currentDiff = await readFile(path.join(caseRootOf(projectRoot), 'current-diff.txt'), 'utf8');
if (currentDiff !== headDiff) {
  throw new Error('the changed scope was modified by the security run; security audit must be read-only');
}

pass('ponytail_lifecycle_security_grader');
