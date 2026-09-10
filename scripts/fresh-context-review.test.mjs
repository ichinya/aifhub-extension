import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileSessionBrief } from './session-brief.mjs';
import { prepareFreshContextReview, freshContextReviewPaths, runFreshContextReviewCommand } from './fresh-context-review.mjs';

const change = '168-bounded-change';
const base = `openspec/changes/${change}`;
const signals = {
  planning_mode: 'full', behavior_change: true, modules: 1, repositories: 1,
  public_api: false, data_migration: false, reversible: true, security_sensitive: false,
  architecture_novelty: false, requirements_clear: true, expected_files: 2
};
const spec = '## ADDED Requirements\n\n### Requirement: Bounded behavior\nThe system SHALL accept a valid input.\n\n#### Scenario: Valid input\n- **WHEN** input is valid\n- **THEN** return its result\n';
const roots = [];

function proposal() {
  return ['## Original Request', '', 'RAW_REQUEST_CANARY retain  two spaces', '',
    '## Why', '', 'Return the bounded result.', '', '## What Changes', '', '- Update one behavior.', '',
    '## Capabilities', '', '### New Capabilities', '', '- behavior', '', '### Modified Capabilities', '',
    '## Impact', '', '- src/handler.mjs', '',
    '## SDD Profile Inputs', '', '```json', JSON.stringify(signals, null, 2), '```', '',
    '## Non-goals', '', '- No storage migration.', '',
    '## Acceptance Examples', '', '| Given | When | Then |', '|---|---|---|', '| valid input | called | result |', '',
    '## Allowed Change Surface', '', '- src/handler.mjs', '- test/handler.test.mjs', '',
    '## Forbidden Change Surface', '', '- storage/**', '',
    '## Verification Plan', '', '- Run the focused behavior check and project gates.', ''].join('\n');
}

async function put(root, file, content) {
  const target = path.join(root, file);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aifhub-fcr-'));
  roots.push(root);
  await put(root, '.ai-factory/config.yaml', 'aifhub:\n  artifactProtocol: openspec\n  openspec:\n    useInstructionsApply: false\n');
  await put(root, `${base}/proposal.md`, proposal());
  await put(root, `${base}/tasks.md`, '# Tasks\n\n- [x] 1.1 Implement behavior; verify focused regression.\n');
  await put(root, `${base}/specs/behavior/spec.md`, spec);
  await put(root, 'REVIEW.md', '# Review Guidelines\n\n## Critical Areas\n\n- src/auth/**\n');
  return root;
}

function options(root, extra = {}) {
  return { rootDir: root, changeId: change, ...extra };
}

after(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

describe('Fresh-context AI review', () => {
  it('prepares a review package with target diff, brief digest, and review policy', async () => {
    const root = await fixture();
    const compiled = await compileSessionBrief(options(root));
    assert.equal(compiled.ok, true);
    const targetDiff = [
      'diff --git a/src/handler.mjs b/src/handler.mjs',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/src/handler.mjs',
      '@@ -0,0 +1,3 @@',
      '+export function handler(x) {',
      '+  return x;',
      '+}',
      ''
    ].join('\n');
    const result = await prepareFreshContextReview({ ...options(root), reviewId: 'review-test', targetDiff, changedFiles: ['src/handler.mjs'] });
    assert.equal(result.ok, true);
    assert.equal(result.outcome, 'prepared');
    const paths = freshContextReviewPaths(change, 'review-test');
    const receipt = JSON.parse(await readFile(path.join(root, paths.json), 'utf8'));
    assert.equal(receipt.schema, 'aifhub.ai_cross_context_review.v1');
    assert.equal(receipt.context_mode, 'fresh');
    assert.equal(receipt.execution_profile, 'ai-fresh-context');
    assert.equal(receipt.session_brief_digest, compiled.digest);
    assert.match(receipt.target.fingerprint, /^[a-f0-9]{64}$/);
    assert.deepEqual(receipt.target.changed_files, ['src/handler.mjs']);
    assert.equal(receipt.target.path, 'review-target.diff');
    assert.equal(receipt.finding_count, 0);
    assert.equal(receipt.same_session_fallback, false);
    assert.ok(receipt.source_revisions.some((rev) => rev.path.endsWith('REVIEW.md')), JSON.stringify(receipt.source_revisions));
    const diff = await readFile(path.join(root, paths.diff), 'utf8');
    assert.ok(diff.includes('src/handler.mjs'));
  });

  it('blocks without current SessionBrief', async () => {
    const root = await fixture();
    const result = await prepareFreshContextReview({ ...options(root), reviewId: 'review-test', targetDiff: 'diff' });
    assert.equal(result.ok, false);
    assert.equal(result.outcome, 'blocked');
    assert.ok(result.receipt.blocked_reasons.includes('session_brief_not_current'));
  });

  it('marks same-session fallback explicitly', async () => {
    const root = await fixture();
    await compileSessionBrief(options(root));
    const result = await prepareFreshContextReview({ ...options(root), reviewId: 'review-test', targetDiff: 'diff', changedFiles: ['src/handler.mjs'], sameSessionFallback: true });
    assert.equal(result.ok, true);
    assert.equal(result.receipt.context_mode, 'same_session');
    assert.equal(result.receipt.same_session_fallback, true);
  });

  it('exports changed files as a diff when targetDiff is not provided', async () => {
    const root = await fixture();
    await compileSessionBrief(options(root));
    await put(root, 'src/handler.mjs', 'export function handler(x) { return x; }\n');
    const result = await prepareFreshContextReview({ ...options(root), reviewId: 'review-test', changedFiles: ['src/handler.mjs'] });
    assert.equal(result.ok, true);
    assert.ok(result.receipt.target.fingerprint);
    const diff = await readFile(path.join(root, freshContextReviewPaths(change, 'review-test').diff), 'utf8');
    assert.ok(diff.includes('src/handler.mjs'));
  });

  it('returns clean CLI output', async () => {
    const root = await fixture();
    await compileSessionBrief(options(root));
    const stdout = { written: '', write(value) { this.written += value; } };
    const exit = await runFreshContextReviewCommand(['prepare', '--change', change, '--review-id', 'review-test', '--json'], { rootDir: root, targetDiff: 'diff\n', changedFiles: ['src/handler.mjs'], stdout });
    assert.equal(exit, 0);
    const receipt = JSON.parse(stdout.written);
    assert.equal(receipt.outcome, 'prepared');
    assert.equal(receipt.review_id, 'review-test');
  });
});
