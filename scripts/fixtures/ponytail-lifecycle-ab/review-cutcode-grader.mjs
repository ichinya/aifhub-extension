// Hidden grader for the review lifecycle scenario (cutcode-shop price float precision).
// Usage: node review-cutcode-grader.mjs <projectRoot>

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { assertFinalGateBlock, assertKeywordGroups, caseRootOf, extractAssistantText, pass, readText } from './grader-lib.mjs';

const projectRoot = process.argv[2];
if (!projectRoot) throw new Error('project root argument is required');

const assistantText = extractAssistantText(await readText(path.join(caseRootOf(projectRoot), 'pi-events.jsonl'), 'pi-events.jsonl'));
const gate = assertFinalGateBlock(assistantText, 'review output', 'review');
if (gate.status === 'pass') {
  throw new Error('review verdict is pass but the changed scope contains a material correctness defect');
}
assertKeywordGroups(assistantText, [
  ['price', 'Price', 'Price\\$', '__toString', 'number_format'],
  ['float', 'double', 'precision', '2\\^53', 'IEEE', '9007199254740993', '9223372036854775807', 'точность', 'веществен'],
], 'review output');

// The review sidecar must stay read-only: the worktree must still match the seeded diff.
const headDiff = await readText(path.join(caseRootOf(projectRoot), 'seeded-diff.txt'), 'seeded-diff.txt');
const currentDiff = await readFile(path.join(caseRootOf(projectRoot), 'current-diff.txt'), 'utf8');
if (currentDiff !== headDiff) {
  throw new Error('the changed scope was modified by the review run; review must be read-only');
}

pass('ponytail_lifecycle_review_grader');
