import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileSessionBrief } from './session-brief.mjs';
import { checkPlanCompliance, planCompliancePaths, runPlanComplianceCommand } from './plan-compliance.mjs';

const script = fileURLToPath(new URL('./plan-compliance.mjs', import.meta.url));
const change = '168-bounded-change';
const base = `openspec/changes/${change}`;
const signals = {
  planning_mode: 'full', behavior_change: true, modules: 1, repositories: 1,
  public_api: false, data_migration: false, reversible: true, security_sensitive: false,
  architecture_novelty: false, requirements_clear: true, expected_files: 2
};
const spec = '## ADDED Requirements\n\n### Requirement: Bounded behavior\nThe system SHALL accept a valid input.\n\n#### Scenario: Valid input\n- **WHEN** input is valid\n- **THEN** return its result\n';
const roots = [];

function proposal(input = signals) {
  return ['## Original Request', '', 'RAW_REQUEST_CANARY retain  two spaces', '',
    '## Why', '', 'Return the bounded result.', '', '## What Changes', '', '- Update one behavior.', '',
    '## Capabilities', '', '### New Capabilities', '', '- behavior', '', '### Modified Capabilities', '',
    '## Impact', '', '- src/handler.mjs', '',
    '## SDD Profile Inputs', '', '```json', JSON.stringify(input, null, 2), '```', '',
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

async function fixture(extraTasks = '') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aifhub-compliance-'));
  roots.push(root);
  await put(root, '.ai-factory/config.yaml', 'aifhub:\n  artifactProtocol: openspec\n  openspec:\n    useInstructionsApply: false\n');
  await put(root, `${base}/proposal.md`, proposal());
  await put(root, `${base}/tasks.md`, extraTasks || '# Tasks\n\n- [ ] 1.1 Implement behavior; verify focused regression.\n');
  await put(root, `${base}/specs/behavior/spec.md`, spec);
  return root;
}

function options(root, extra = {}) {
  return { rootDir: root, changeId: change, ...extra };
}

async function compileValidBrief(root, tasksContent) {
  if (tasksContent) await put(root, `${base}/tasks.md`, tasksContent);
  const compiled = await compileSessionBrief(options(root));
  assert.equal(compiled.ok, true, JSON.stringify(compiled));
  return compiled;
}

async function writeTrace(root, digest, files, extra = '') {
  const dir = `.ai-factory/state/${change}/implementation`;
  const trace = [
    `# Implementation Trace: ${change}`,
    '',
    '## Summary',
    '',
    'Implemented.',
    '',
    '## Canonical artifacts read',
    '',
    `- ${base}/proposal.md`,
    `- ${base}/tasks.md`,
    '',
    '## SessionBrief binding',
    '',
    `Digest: ${digest}`,
    '',
    '## Changed files',
    '',
    ...files.map((file) => `- ${file}`),
    '',
    '## Next step',
    '',
    `/aif-verify ${change}`,
    extra,
    ''
  ].join('\n');
  await put(root, `${dir}/run-test.md`, trace);
}

after(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

describe('Plan compliance selection', () => {
  it('returns compliant when changed files match allowed and all tasks are done', async () => {
    const root = await fixture();
    const compiled = await compileValidBrief(root, '# Tasks\n\n- [x] 1.1 Implement behavior; verify focused regression.\n');
    const result = await checkPlanCompliance({ ...options(root), changedFiles: ['src/handler.mjs', 'test/handler.test.mjs'] });
    assert.equal(result.ok, true);
    assert.equal(result.outcome, 'compliant');
    assert.equal(result.receipt.completed_tasks.length, 1);
    assert.equal(result.receipt.skipped_tasks.length, 0);
    assert.equal(result.receipt.unplanned_changes.length, 0);
    assert.equal(result.receipt.scope_expansions.length, 0);
    assert.equal(result.receipt.session_brief_digest, compiled.digest);
    assert.match(result.receipt.plan_revision, /^[a-f0-9]{64}$/);
  });

  it('returns acceptable_drift for skipped tasks', async () => {
    const root = await fixture();
    const compiled = await compileSessionBrief(options(root));
    const result = await checkPlanCompliance({ ...options(root), changedFiles: ['src/handler.mjs', 'test/handler.test.mjs'] });
    assert.equal(result.ok, true);
    assert.equal(result.outcome, 'acceptable_drift');
    assert.equal(result.receipt.skipped_tasks.length, 1);
    assert.equal(result.receipt.completed_tasks.length, 0);
  });

  it('returns replan_required for forbidden surface', async () => {
    const root = await fixture();
    await compileSessionBrief(options(root));
    const result = await checkPlanCompliance({ ...options(root), changedFiles: ['storage/secret.mjs'] });
    assert.equal(result.ok, false);
    assert.equal(result.outcome, 'replan_required');
    assert.deepEqual(result.receipt.scope_expansions, ['storage/secret.mjs']);
    assert.equal(result.receipt.replan_required, true);
  });

  it('returns replan_required for new top-level scope', async () => {
    const root = await fixture();
    await compileSessionBrief(options(root));
    const result = await checkPlanCompliance({ ...options(root), changedFiles: ['docs/readme.md'] });
    assert.equal(result.ok, false);
    assert.equal(result.outcome, 'replan_required');
    assert.deepEqual(result.receipt.scope_expansions, ['docs/readme.md']);
  });

  it('returns acceptable_drift for unplanned changes inside allowed top-level', async () => {
    const root = await fixture();
    await compileSessionBrief(options(root));
    const result = await checkPlanCompliance({ ...options(root), changedFiles: ['src/handler.mjs', 'src/extra.mjs'] });
    assert.equal(result.ok, true);
    assert.equal(result.outcome, 'acceptable_drift');
    assert.deepEqual(result.receipt.unplanned_changes, ['src/extra.mjs']);
  });

  it('blocks without current SessionBrief or changed scope', async () => {
    const root = await fixture();
    const result = await checkPlanCompliance(options(root));
    assert.equal(result.ok, false);
    assert.equal(result.outcome, 'blocked');
    assert.equal(result.receipt.replan_required, false);
  });

  it('blocks when trace SessionBrief digest is stale', async () => {
    const root = await fixture();
    const compiled = await compileSessionBrief(options(root));
    await writeTrace(root, '0'.repeat(64), ['src/handler.mjs']);
    const result = await checkPlanCompliance(options(root));
    assert.equal(result.ok, false);
    assert.equal(result.outcome, 'blocked');
    assert.equal(result.receipt.session_brief_digest, compiled.digest);
  });

  it('uses trace and writes receipt to runtime state', async () => {
    const root = await fixture();
    const compiled = await compileSessionBrief(options(root));
    await writeTrace(root, compiled.digest, ['src/handler.mjs', 'test/handler.test.mjs']);
    const result = await checkPlanCompliance(options(root));
    assert.equal(result.ok, true);
    assert.equal(result.outcome, 'acceptable_drift');
    const receipt = JSON.parse(await readFile(path.join(root, planCompliancePaths(change).json), 'utf8'));
    assert.equal(receipt.schema, 'aifhub.plan_compliance.v1');
    assert.equal(receipt.trace_run_id, 'run-test');
    assert.equal(receipt.session_brief_digest, compiled.digest);
  });

  it('accepts a specific run id and returns clean CLI output', async () => {
    const root = await fixture();
    const compiled = await compileSessionBrief(options(root));
    await writeTrace(root, compiled.digest, ['src/handler.mjs']);
    const stdout = { written: '', write(value) { this.written += value; } };
    const exit = await runPlanComplianceCommand(['check', '--change', change, '--run-id', 'run-test', '--json'], { rootDir: root, stdout });
    assert.equal(exit, 0);
    const receipt = JSON.parse(stdout.written);
    assert.equal(receipt.outcome, 'acceptable_drift');
    assert.equal(receipt.trace_run_id, 'run-test');
  });
  it('matches deeply nested files under a directory glob allowed surface', async () => {
    const root = await fixture();
    await put(root, `${base}/proposal.md`, proposal().replace('- src/handler.mjs\n- test/handler.test.mjs', '- src/**/*'));
    const compiled = await compileValidBrief(root, '# Tasks\n\n- [x] 1.1 Implement behavior; verify focused regression.\n');
    const result = await checkPlanCompliance({ ...options(root), changedFiles: ['src/a/b/c.mjs', 'src/top.ts'] });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.outcome, 'compliant');
    assert.equal(result.receipt.scope_expansions.length, 0);
    assert.equal(result.receipt.unplanned_changes.length, 0);
    assert.equal(result.receipt.session_brief_digest, compiled.digest);
  });
  it('keeps a single-star allowed surface from crossing directory boundaries', async () => {
    const root = await fixture();
    await put(root, `${base}/proposal.md`, proposal().replace('- src/handler.mjs\n- test/handler.test.mjs', '- src/*'));
    await compileSessionBrief(options(root));
    const result = await checkPlanCompliance({ ...options(root), changedFiles: ['src/a/b.ts'] });
    assert.equal(result.ok, true);
    assert.equal(result.outcome, 'acceptable_drift');
    assert.deepEqual(result.receipt.unplanned_changes, ['src/a/b.ts']);
  });
});
