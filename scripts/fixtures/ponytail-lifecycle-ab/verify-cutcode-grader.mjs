// Hidden grader for the verify lifecycle scenario (cutcode-shop price float precision).
// Usage: node verify-cutcode-grader.mjs <projectRoot>

import path from 'node:path';
import { assertFinalGateBlock, assertKeywordGroups, extractAssistantText, extractGateBlocks, pass, readText } from './grader-lib.mjs';

const projectRoot = process.argv[2];
if (!projectRoot) throw new Error('project root argument is required');
const changeId = 'lifecycle-price-format';

const verifyPath = path.join(projectRoot, '.ai-factory', 'qa', changeId, 'verify.md');
const verifyText = await readText(verifyPath, `.ai-factory/qa/${changeId}/verify.md`);

const gate = assertFinalGateBlock(verifyText, 'verify.md', 'verify');
if (gate.status !== 'fail') {
  throw new Error(`verify must fail for the seeded float-precision defect, got status ${JSON.stringify(gate.status)}`);
}
if (!Array.isArray(gate.blockers) || gate.blockers.length === 0) {
  throw new Error('verify.md gate result must list at least one blocker');
}
assertKeywordGroups(verifyText, [
  ['price', 'Price', '__toString', 'number_format'],
  ['float', 'double', 'precision', '2\\^53', 'IEEE', '9007199254740993', '9223372036854775807', 'точность', 'веществен'],
], 'verify.md');

// The final stdout block must be the same gate result that was persisted.
const assistantText = extractAssistantText(await readText(path.join(path.dirname(path.resolve(projectRoot)), 'pi-events.jsonl'), 'pi-events.jsonl'));
const stdoutBlocks = extractGateBlocks(assistantText, 'verify stdout');
const stdoutGate = stdoutBlocks[stdoutBlocks.length - 1];
if (stdoutGate.parseError || JSON.stringify(stdoutGate.parsed) !== JSON.stringify(gate)) {
  throw new Error('the final stdout aif-gate-result block does not match the persisted verify.md block');
}

pass('ponytail_lifecycle_verify_grader');
