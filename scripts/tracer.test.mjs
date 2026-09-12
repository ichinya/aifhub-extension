import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { selectSddProfile } from './sdd-profiles.mjs';
import { runTracer, decideTracer, statusTracer, tracerPaths, runTracerCommand } from './tracer.mjs';

const change = '168-bounded-change';
const base = `openspec/changes/${change}`;
const signals = {
  planning_mode: 'full', behavior_change: true, modules: 1, repositories: 1,
  public_api: false, data_migration: false, reversible: true, security_sensitive: false,
  architecture_novelty: true, requirements_clear: true, expected_files: 2
};
const roots = [];

function proposal() {
  return ['## Original Request', '', 'Try a new integration pattern.', '',
    '## Why', '', 'Uncertain architecture.', '', '## What Changes', '', '- Explore a vertical slice.', '',
    '## Capabilities', '', '### New Capabilities', '', '- behavior', '',
    '## SDD Profile Inputs', '', '```json', JSON.stringify(signals, null, 2), '```'].join('\n');
}

async function put(root, file, content) {
  const target = path.join(root, file);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aifhub-tracer-'));
  roots.push(root);
  await put(root, '.ai-factory/config.yaml', 'aifhub:\n  artifactProtocol: openspec\n  openspec:\n    useInstructionsApply: false\n');
  await put(root, `${base}/proposal.md`, proposal());
  await put(root, `${base}/tasks.md`, '# Tasks\n\n- [ ] 1.1 Build a vertical slice.\n');
  await put(root, `${base}/design.md`, '# Design\n\n## Constraints\n\n- Keep it bounded.\n');
  await put(root, `${base}/specs/behavior/spec.md`, '## ADDED\n\n### Requirement: Slice\n- **WHEN** called\n- **THEN** works\n');
  return root;
}

after(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

describe('Tracer profile', () => {
  it('selects tracer from architecture_novelty', () => {
    const decision = selectSddProfile(signals);
    assert.equal(decision.profile, 'tracer');
    assert.ok(decision.implementation_allowed);
    assert.deepEqual(decision.required_artifacts, ['delta_specs', 'proposal', 'session_brief', 'tasks']);
    assert.deepEqual(decision.conditional_artifacts, ['design']);
    assert.ok(decision.reasons.includes('architecture_uncertainty'));
  });

  it('runs a tracer and writes the four runtime files', async () => {
    const root = await fixture();
    const result = await runTracer({
      rootDir: root,
      changeId: change,
      hypothesis: 'The new integration pattern fits behind an adapter.',
      minimumVerticalPath: 'src/adapter.mjs + test/adapter.test.mjs',
      questions: ['Does the adapter isolate external protocol?'],
      nonGoals: ['Production traffic', 'Full error handling'],
      budget: { time: '4h', cost: 'low', tools: ['node', 'git'] },
      expectedArtifacts: ['src/adapter.mjs', 'test/adapter.test.mjs']
    });
    assert.equal(result.ok, true);
    assert.equal(result.outcome, 'run');
    const paths = tracerPaths(change);
    const brief = JSON.parse(await readFile(path.join(root, paths.brief), 'utf8'));
    assert.equal(brief.schema, 'aifhub.tracer_brief.v1');
    assert.equal(brief.profile, 'tracer');
    assert.equal(brief.hypothesis, 'The new integration pattern fits behind an adapter.');
    const findings = JSON.parse(await readFile(path.join(root, paths.findings), 'utf8'));
    assert.equal(findings.schema, 'aifhub.tracer_findings.v1');
    const decision = JSON.parse(await readFile(path.join(root, paths.decision), 'utf8'));
    assert.equal(decision.schema, 'aifhub.tracer_decision.v1');
    assert.equal(decision.decision, null);
    const summary = await readFile(path.join(root, paths.summary), 'utf8');
    assert.ok(summary.includes('## Hypothesis'));
    assert.ok(summary.includes('(no decision yet)'));
  });

  it('records a promotion decision with promotion steps', async () => {
    const root = await fixture();
    await runTracer({
      rootDir: root,
      changeId: change,
      hypothesis: 'Adapter works.',
      minimumVerticalPath: 'src/adapter.mjs'
    });
    const result = await decideTracer({
      rootDir: root,
      changeId: change,
      decision: 'promote',
      reason: 'Vertical slice proves the hypothesis.'
    });
    assert.equal(result.ok, true);
    assert.equal(result.outcome, 'promote');
    const paths = tracerPaths(change);
    const decision = JSON.parse(await readFile(path.join(root, paths.decision), 'utf8'));
    assert.equal(decision.decision, 'promote');
    assert.ok(decision.promotion_steps.length > 0);
    const summary = await readFile(path.join(root, paths.summary), 'utf8');
    assert.ok(summary.includes('**promote**'));
  });
  it('reports corrupt persisted state distinctly and rejects flag values as finding/evidence arguments', async () => {
    const root = await fixture();
    await runTracer({ rootDir: root, changeId: change, hypothesis: 'Adapter works.', minimumVerticalPath: 'src/adapter.mjs' });
    await writeFile(path.join(root, tracerPaths(change).decision), '{"schema":"aifhub.tracer_decision.v1","decision":null,"decision":null}');
    const status = await statusTracer({ rootDir: root, changeId: change });
    assert.equal(status.ok, false);
    assert.equal(status.errors[0].code, 'corrupt_tracer_state');
    const stdout = { written: '', write(value) { this.written += value; } };
    assert.equal(await runTracerCommand(['run', '--change', change, '--evidence', '--hypothesis', 'x', '--json'], { rootDir: root, stdout }), 2);
    assert.equal(await runTracerCommand(['run', '--change', change, '--finding', '--hypothesis', 'x', '--json'], { rootDir: root, stdout }), 2);
  });

  it('blocks without required hypothesis and vertical path', async () => {
    const root = await fixture();
    const result = await runTracer({ rootDir: root, changeId: change });
    assert.equal(result.ok, false);
    assert.equal(result.outcome, 'blocked');
    assert.ok(result.errors.some((error) => error.code === 'missing_hypothesis'));
    assert.ok(result.errors.some((error) => error.code === 'missing_vertical_path'));
  });

  it('returns status of the tracer state', async () => {
    const root = await fixture();
    await runTracer({
      rootDir: root,
      changeId: change,
      hypothesis: 'Adapter works.',
      minimumVerticalPath: 'src/adapter.mjs'
    });
    const status = await statusTracer({ rootDir: root, changeId: change });
    assert.equal(status.ok, true);
    assert.equal(status.brief.profile, 'tracer');
  });

  it('exposes clean CLI for run and promote', async () => {
    const root = await fixture();
    const stdout = { written: '', write(value) { this.written += value; } };
    const runExit = await runTracerCommand([
      'run', '--change', change, '--json',
      '--hypothesis', 'Adapter fits.',
      '--vertical-path', 'src/adapter.mjs',
      '--question', 'Does it isolate protocol?',
      '--non-goal', 'Production traffic',
      '--budget-time', '4h',
      '--expected-artifact', 'src/adapter.mjs'
    ], { rootDir: root, stdout });
    assert.equal(runExit, 0);
    const runResult = JSON.parse(stdout.written);
    assert.equal(runResult.outcome, 'run');

    stdout.written = '';
    const promoteExit = await runTracerCommand(['promote', '--change', change, '--json', '--reason', 'Validated.'], { rootDir: root, stdout });
    assert.equal(promoteExit, 0);
    const promoteResult = JSON.parse(stdout.written);
    assert.equal(promoteResult.outcome, 'promote');
  });
});
