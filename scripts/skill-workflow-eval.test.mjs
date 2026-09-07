import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { BASELINE, CASES, collect, compare, compareResults, hash, loadCases, prepare, score } from './skill-workflow-eval.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtime = { host: 'test-only-orca', hostVersion: 'test-fixture', model: 'no-model-executed',
  effort: 'none', tools: ['read', 'shell'], settingsHash: hash('synthetic unit-test settings') };
let prepared;
let manifest;
let cases;
const scratch = [];
before(async () => {
  cases = await loadCases();
  prepared = await prepare({ materialize: true, taskId: 'issue164-harness-test', runtime, repetitions: 2 });
  manifest = JSON.parse(await readFile(prepared.manifest, 'utf8'));
});
after(async () => {
  // Only this test's mkdtemp roots; canonical containment is checked before recursive removal.
  for (const root of [prepared?.runRoot, ...scratch].filter(Boolean)) {
    const canonical = await realpath(root);
    const temp = await realpath(os.tmpdir());
    assert.equal(path.dirname(canonical), temp);
    assert.match(path.basename(canonical), /^aifhub-skill-eval-/);
    await rm(canonical, { recursive: true, force: true });
  }
});
function observation(row, overrides = {}) {
  const fields = ['runId', 'executionId', 'pairId', 'caseId', 'arm', 'repetition', 'inputHash',
    'instructionHash', 'runtimeSourceHash', 'runtimeHash', 'harnessHash', 'graderHash'];
  return { observerRole: 'coordinator', identity: Object.fromEntries(fields.map(k => [k, row[k]])),
    runtime, runtimeVerified: true, inputsVerified: true, provenance: 'SYNTHETIC TEST ONLY; no worker ran',
    requirements: Object.fromEntries(manifest.graders[row.caseId].requirements.map(r => [r.id,
      { met: true, evidence: 'Synthetic test judgment; not evaluation evidence' }])),
    unsupportedChecks: { value: 0, evidence: 'Synthetic complete action log' },
    userInterventions: { value: 0, evidence: 'Synthetic complete interaction log' }, ...overrides };
}
function report(row) { return { executionId: row.executionId, status: 'completed', summary: 'Synthetic report only.', checks: [] }; }

test('preview stays explicit and does not materialize', async () => {
  const preview = await prepare();
  assert.deepEqual(preview.cases, CASES);
  assert.equal(preview.writes, false);
  assert.match(preview.status, /^NOT_RUN/);
  await assert.rejects(prepare({ materialize: true, taskId: '../escape', runtime }), /unsafe id/);
  await assert.rejects(prepare({ materialize: true, taskId: 'safe', runtime, repetitions: 6 }), /1\.\.5/);
  await assert.rejects(prepare({ materialize: true, taskId: 'safe', runtime: { ...runtime, apiKey: 'not-a-secret' } }), /requires only/);
});

test('all five scenarios have identical paired tasks/files and withheld rubric/checker', async () => {
  assert.equal(manifest.rows.length, 20);
  for (const caseId of CASES) {
    const rows = manifest.rows.filter(r => r.caseId === caseId && r.repetition === 1);
    assert.equal(rows[0].inputHash, rows[1].inputHash);
    assert.notEqual(rows[0].executionId, rows[1].executionId);
    assert.equal(rows[0].pairId, rows[1].pairId);
    assert.equal(rows[0].runtimeHash, rows[1].runtimeHash);
    for (const row of rows) {
      const context = path.join(prepared.runRoot, row.context);
      assert.deepEqual((await readdir(context)).sort(), ['TASK.md', 'identity.json', 'instructions', 'workspace']);
      assert.deepEqual(JSON.parse(await readFile(path.join(context, 'identity.json'), 'utf8')), { executionId: row.executionId });
      assert.doesNotMatch(await readFile(path.join(context, 'TASK.md'), 'utf8'), /Withheld|grader|expected answer|bc93bda/);
      for (const [name, body] of Object.entries(cases.find(c => c.id === caseId).input.files)) {
        assert.equal(await readFile(path.join(context, 'workspace', name), 'utf8'), body);
      }
    }
  }
  assert.notEqual(manifest.rows[0].pairId, manifest.rows[2].pairId);
  assert.notEqual(manifest.runtimeSources.baseline.hash, undefined);
  assert.equal(hash(await readFile(path.join(prepared.runRoot, 'coordinator/check-output.mjs'))), manifest.hiddenCheckHash);
});

test('baseline instruction bytes come from pinned Git; current bytes come from worktree', async () => {
  for (const arm of ['baseline', 'current']) {
    const row = manifest.rows.find(r => r.caseId === 'explore' && r.arm === arm);
    const relative = 'injections/core/aif-explore-plan-folder.md';
    const materialized = await readFile(path.join(prepared.runRoot, row.context, 'instructions', relative));
    const expected = arm === 'baseline' ? execFileSync('git', ['-c', `safe.directory=${ROOT}`, 'show', `${BASELINE}:${relative}`],
      { cwd: ROOT, windowsHide: true }) : await readFile(path.join(ROOT, relative));
    assert.deepEqual(materialized, expected);
    assert.equal(hash(materialized), row.instructionFiles[relative]);
  }
});

test('unobserved values stay null; negative requirements, extra files and unsupported checks are visible', () => {
  const row = manifest.rows.find(r => r.caseId === 'explore');
  const grader = manifest.graders.explore;
  const unknown = score({ row, grader, report: report(row), changedFiles: [], observation: {} });
  assert.equal(unknown.pass, null);
  assert.equal(unknown.metrics.missingRequirements, null);
  assert.equal(unknown.metrics.userInterventions, null);
  assert.equal(unknown.metrics.inputTokens, null);
  const obs = observation(row);
  obs.requirements.coverage = { met: false, evidence: 'Response incorrectly calls import complete' };
  obs.unsupportedChecks = { value: 1, evidence: 'Response claims a command absent from the complete action log' };
  const failed = score({ row, grader, report: report(row), observation: obs, changedFiles: ['src/extra.mjs'] });
  assert.equal(failed.pass, false);
  assert.equal(failed.metrics.missingRequirements, 1);
  assert.equal(failed.metrics.unnecessaryChanges, 1);
  assert.equal(failed.metrics.unsupportedChecks, 1);
  assert.throws(() => score({ row, grader, report: report(row), changedFiles: [],
    observation: { unsupportedChecks: { value: 0 } } }), /requires value and evidence/);
});

test('collection rejects stale identities and runtime, records real file diffs, and refuses duplicate receipts', async () => {
  const row = manifest.rows.find(r => r.caseId === 'explore' && r.repetition === 1);
  const collectRow = obs => collect({ runRoot: prepared.runRoot, executionId: row.executionId, report: report(row), observation: obs });
  const wrong = observation(row);
  wrong.identity.repetition = 99;
  await assert.rejects(collectRow(wrong), /repetition mismatch/);
  await assert.rejects(collectRow(observation(row, { runtime: { ...runtime, model: 'other' } })), /runtime mismatch/);
  await writeFile(path.join(prepared.runRoot, row.context, 'workspace', 'unnecessary.md'), 'unexpected write');
  const result = await collectRow(observation(row));
  assert.deepEqual(result.changedFiles, ['unnecessary.md']);
  assert.equal(result.metrics.unnecessaryChanges, 1);
  assert.equal(result.pass, false);
  await assert.rejects(collectRow(observation(row)), /EEXIST/);
  const comparison = await compare({ runRoot: prepared.runRoot });
  assert.equal(comparison.improvement, null);
  assert.equal(comparison.status, 'INCOMPLETE_NO_IMPROVEMENT_CLAIM');
  await writeFile(path.join(prepared.runRoot, row.context, 'workspace', 'unnecessary.md'), 'changed after collection');
  await assert.rejects(compare({ runRoot: prepared.runRoot }), /workspace changed after collection/);
});

test('instruction tampering makes a result ineligible', async () => {
  const row = manifest.rows.find(r => r.caseId === 'review' && r.repetition === 2);
  const file = Object.keys(row.instructionFiles)[0];
  await writeFile(path.join(prepared.runRoot, row.context, 'instructions', file), 'tampered');
  const result = await collect({ runRoot: prepared.runRoot, executionId: row.executionId,
    report: report(row), observation: observation(row) });
  assert.equal(result.integrity, false);
  assert.equal(result.valid, false);
});

test('unverified runtime or launch input cannot contribute improvement', async () => {
  const row = manifest.rows.find(r => r.caseId === 'explore' && r.repetition === 2);
  const result = await collect({ runRoot: prepared.runRoot, executionId: row.executionId,
    report: report(row), observation: observation(row, { inputsVerified: false, runtimeVerified: false }) });
  assert.equal(result.integrity, true);
  assert.equal(result.valid, false);
  assert.equal(compareResults(manifest, [result]).improvement, null);
});

test('pairs reject missing arms, incomplete workers, duplicates, swapped inputs and mixed repetitions', () => {
  const results = manifest.rows.map(row => ({ ...row, valid: true, status: 'completed', pass: true,
    metrics: { missingRequirements: 0, unnecessaryChanges: 0, unsupportedChecks: 0,
      userInterventions: 0, elapsedMs: null, inputTokens: null, outputTokens: null } }));
  const full = compareResults(manifest, results);
  assert.equal(full.status, 'MEASURED_PAIRED_PILOT');
  assert.equal(full.improvement.passRateDelta, 0);
  assert.equal(full.improvement.meanDelta.elapsedMs, null);
  for (const variant of [results.slice(1), [...results, results[0]],
    results.map((r, i) => i ? r : { ...r, status: 'incomplete' }),
    results.map((r, i) => i ? r : { ...r, pass: undefined }),
    results.map((r, i) => i ? r : { ...r, metrics: { ...r.metrics, unsupportedChecks: null } }),
    results.map((r, i) => i ? r : { ...r, inputHash: hash('wrong') })]) {
    assert.equal(compareResults(manifest, variant).improvement, null);
  }
  const mixed = structuredClone(manifest);
  mixed.rows[2].instructionHash = hash('different repetition instructions');
  assert.equal(compareResults(mixed, results.map((r, i) => ({ ...r, instructionHash: mixed.rows[i].instructionHash }))).improvement, null);
  const mismatchedInputs = structuredClone(manifest);
  mismatchedInputs.rows[0].inputHash = hash('different task');
  assert.equal(compareResults(mismatchedInputs, results.map((r, i) => ({ ...r, inputHash: mismatchedInputs.rows[i].inputHash }))).improvement, null);
  assert.match(compareResults(manifest, []).status, /^NOT_RUN/);
  for (const rows of [manifest.rows.filter(r => r.caseId === 'explore' && r.repetition === 1),
    manifest.rows.filter(r => r.repetition === 1), manifest.rows.filter(r => r.arm === 'baseline')]) {
    const truncated = { ...manifest, rows };
    const comparison = compareResults(truncated, results.filter(r => rows.some(row => row.executionId === r.executionId)));
    assert.equal(comparison.improvement, null);
    assert.ok(comparison.errors.length > 0);
  }
  assert.equal(compareResults({ ...manifest, repetitions: undefined }, results).improvement, null);
});

test('saved preparation metadata rejects a truncated manifest before reading worker reports', async () => {
  const original = await readFile(prepared.manifest);
  try {
    await writeFile(prepared.manifest, JSON.stringify({ ...manifest, rows: manifest.rows.slice(0, 2) }));
    await assert.rejects(compare({ runRoot: prepared.runRoot }), /prepared matrix changed/);
  } finally { await writeFile(prepared.manifest, original); }
});

test('hidden checks reject the initial bugs and accept independent correct implementations', async () => {
  const checker = path.join(prepared.runRoot, 'coordinator/check-output.mjs');
  const implementations = {
    implement: "export function summarizeInvoice(lines) { return lines.reduce((sum, line) => ({ totalCents: sum.totalCents + line.unitCents * line.quantity, itemCount: sum.itemCount + line.quantity }), { totalCents: 0, itemCount: 0 }); }\n",
    fix: "const pending = new Map();\nexport function loadOnce(key, loader) { if (pending.has(key)) return pending.get(key); const value = Promise.resolve().then(loader).finally(() => pending.delete(key)); pending.set(key, value); return value; }\n"
  };
  for (const caseId of ['implement', 'fix']) {
    const row = manifest.rows.find(r => r.caseId === caseId);
    const workspace = path.join(prepared.runRoot, row.context, 'workspace');
    const run = () => spawnSync(process.execPath, [checker, caseId, workspace], { timeout: 10_000, maxBuffer: 64 * 1024, windowsHide: true });
    assert.notEqual(run().status, 0, `${caseId} initial defect must fail`);
    const source = caseId === 'implement' ? 'src/invoice.mjs' : 'src/load-once.mjs';
    await writeFile(path.join(workspace, source), implementations[caseId]);
    const fixed = run();
    assert.equal(fixed.status, 0, fixed.stderr.toString());
    assert.equal(JSON.parse(fixed.stdout).met, true);
  }
});

test('task temp ownership and symlink guards fail closed', async t => {
  await assert.rejects(compare({ runRoot: ROOT }), /task-owned temp root/);
  const row = manifest.rows.find(r => r.caseId === 'plan' && r.repetition === 2);
  const extra = path.join(prepared.runRoot, row.context, 'workspace', 'outside');
  const target = await mkdtemp(path.join(os.tmpdir(), 'aifhub-skill-eval-link-test-'));
  scratch.push(target);
  try { await symlink(target, extra, 'junction'); }
  catch (error) { if (error.code === 'EPERM') return t.skip('symlinks unavailable'); throw error; }
  await assert.rejects(collect({ runRoot: prepared.runRoot, executionId: row.executionId,
    report: report(row), observation: observation(row) }), /symlink/);
});

test('CLI preview is machine-readable and rejects unknown flags', () => {
  const script = path.join(ROOT, 'scripts/skill-workflow-eval.mjs');
  const preview = spawnSync(process.execPath, [script, 'prepare'], { windowsHide: true });
  assert.equal(preview.status, 0, preview.stderr.toString());
  assert.equal(JSON.parse(preview.stdout).writes, false);
  const invalid = spawnSync(process.execPath, [script, 'prepare', '--execute'], { windowsHide: true });
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr.toString(), /unknown flag/);
});
