// Instruction contracts only; actual model dispatch requires a host evaluation.
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const policy = await readFile(new URL('../skills/shared/TASK-COORDINATION.md', import.meta.url), 'utf8');
const review = await readFile(new URL('../skills/shared/REVIEW-DELEGATION.md', import.meta.url), 'utf8');

const fixtures = [
  ['digest-only → helper/direct', policy, ['JSON field extraction', 'direct tool path', 'Do not dispatch an AI worker solely']],
  ['execution form reason → prose', policy, ['direct, serial coupled group, supported same-shape batch, or independent isolated tasks', 'not an additional field in execution helper JSON']],
  ['five eligible items → bounded batch', policy, ['two to five ready items', 'comparable low risk', 'select the existing same-worker batch contract']],
  ['shared interface → coupled/serial', policy, ['A shared interface', 'Keep the affected work coupled/serial']],
  ['overlapping file → serial remains allowed', policy, ['overlapping file', 'compatible edits may be serialized']],
  ['unresolved dependency → exact blocker', policy, ['unresolved dependency', 'report the exact blocker']],
  ['different risk → no independent batch', policy, ['different risk prevents treating', 'general worker-count limit']],
  ['free slot without question → no sidecar', review, ['concrete, independently useful question', 'A free concurrency slot alone is not a reason']],
  ['required independent audit → preserve role', review, ['Preserve every independent audit required', 'must not be relabeled as an independent audit']],
  ['four of five → unfinished', policy, ['four of five', 'leave the fifth unchecked/pending', 'omitted, blocked or unaccepted item remains unfinished']],
  ['cost observations → explicit source/UNKNOWN', policy, ['source of each reported measurement', 'unknown or estimated', 'paired baseline/candidate measurement', 'Keep admitted preflight references and sealed evidence immutable']]
];
for (const [label, source, witnesses] of fixtures) it(`instruction fixture: ${label}`, () => {
  for (const witness of witnesses) assert.ok(source.includes(witness), witness);
});

it('new dispatch guidance introduces no numeric token/time/worker caps or model switches', () => {
  for (const source of [policy, review]) {
    assert.doesNotMatch(source, /(?:maxTurns|max_workers|token_budget|timeout_ms)\s*[:=]\s*\d/i);
    assert.doesNotMatch(source, /(?:at most|no more than|maximum)\s+\d+\s+workers/i);
    assert.doesNotMatch(source, /switch (?:the )?model to\s+\S+/i);
  }
});

it('consumers preserve the mechanical boundary, reason and worker-only cost observations', async () => {
  for (const runtime of ['claude', 'codex']) {
    const ext = runtime === 'claude' ? 'md' : 'toml';
    const worker = await readFile(new URL(`../agent-files/${runtime}/aifhub-implement-worker.${ext}`, import.meta.url), 'utf8');
    for (const witness of ['Perform incidental JSON field extraction', 'Require the supplied execution-form reason', 'report the exact blocker without regrouping', 'only observations from your own assignment', 'Do not assess the whole run']) assert.ok(worker.includes(witness));
  }
  const coordinator = await readFile(new URL('../injections/core/aif-implement-plan-folder.md', import.meta.url), 'utf8');
  for (const witness of ['without a separate AI worker', 'exact digests, freshness checks and parent decision', 'Keep helper payloads unchanged', 'Before selecting the next group']) assert.ok(coordinator.includes(witness));
});
