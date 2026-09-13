import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  EVIDENCE_CLASSES, exportEvaluation, exportExchangeBundle, exportWorkflowProfile,
  runExchangeCommand, validateDesignContext
} from './workflow-exchange.mjs';
import { compileSessionBrief } from './session-brief.mjs';

const roots = [];

async function put(root, relative, content) {
  const target = path.join(root, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
}

async function fixture({ designContext } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aifhub-exchange-'));
  roots.push(root);
  await put(root, '.ai-factory/config.yaml', 'aifhub:\n  artifactProtocol: openspec\n  openspec:\n    useInstructionsApply: false\n');
  const change = 'add-oauth';
  const base = `openspec/changes/${change}`;
  const proposal = [
    '## Original Request', '', 'Add OAuth login.', '',
    '## Why', '', 'Users need authentication.', '',
    '## What Changes', '', '- Add OAuth flow.', '',
    '## Capabilities', '', '### New Capabilities', '', '- behavior', '',
    '## SDD Profile Inputs', '', '```json', JSON.stringify({
      planning_mode: 'full', behavior_change: true, modules: 1, repositories: 1,
      public_api: false, data_migration: false, reversible: true, security_sensitive: false,
      architecture_novelty: false, requirements_clear: true, expected_files: 2
    }, null, 2), '```', '',
    '## Acceptance Examples', '', '- Valid token logs user in.', '',
    '## Non-goals', '', '- Social providers.', '',
    '## Allowed Change Surface', '', '- src/auth/**', '',
    '## Forbidden Change Surface', '', '- src/billing/**'
  ].join('\n');
  await put(root, `${base}/proposal.md`, proposal);
  await put(root, `${base}/tasks.md`, '# Tasks\n\n- [ ] 1.1 Implement OAuth handler.\n- [x] 1.2 Add tests.\n');
  await put(root, `${base}/design.md`, '# Design\n\n## Constraints\n\n- Use existing provider.\n');
  await put(root, `${base}/specs/behavior/spec.md`, '## ADDED Requirements\n\n### Requirement: OAuth\nThe system SHALL accept a valid token.\n\n#### Scenario: Valid token\n- **WHEN** token is valid\n- **THEN** login succeeds\n');
  if (designContext !== undefined) {
    await put(root, `${base}/design.context.json`, typeof designContext === 'string' ? designContext : JSON.stringify(designContext));
  }
  return { root, change, base };
}

async function compiledFixture(options = {}) {
  const ctx = await fixture(options);
  const compiled = await compileSessionBrief({ rootDir: ctx.root, changeId: ctx.change });
  assert.equal(compiled.status, 'valid', JSON.stringify(compiled));
  return ctx;
}

after(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

function stdout() {
  return { written: '', write(value) { this.written += value; } };
}

describe('Workflow profile export', () => {
  it('exports the registry-facing profile catalog without a project', async () => {
    const result = await exportWorkflowProfile({ rootDir: os.tmpdir(), now: '2026-09-13T00:00:00.000Z' });
    assert.equal(result.ok, true);
    const profile = result.profile;
    assert.equal(profile.schema, 'aifhub.workflow_profile_export.v1');
    assert.equal(profile.exporter.id, 'aifhub-extension');
    assert.equal(profile.framework.id, 'openspec');
    assert.equal(profile.resolved_decision, null);
    const ids = profile.profiles.map((entry) => entry.id);
    assert.deepEqual(ids, ['direct', 'quick', 'standard', 'expanded', 'ultra', 'tracer', 'research']);
    // ADR 0004: internal `expanded` maps to the cross-project `full` depth.
    assert.equal(profile.profile_mapping.expanded, 'full');
    assert.equal(profile.profiles.find((entry) => entry.id === 'expanded').registry_depth, 'full');
    assert.equal(profile.profiles.find((entry) => entry.id === 'research').recommended_mode, null);
    assert.deepEqual(profile.quality_gates.required, ['done', 'project_policy', 'tests', 'verify']);
    // The quick floor cannot weaken the gate baseline (issue #203 invariant).
    assert.deepEqual(profile.quality_gates.conditional, ['rules', 'review', 'security', 'migration_rollback', 'human_review']);
    // Review contract: fresh by default, human review stays an external policy.
    assert.deepEqual(profile.review.context_modes, ['fresh', 'same_session']);
    assert.equal(profile.review.default_context_mode, 'fresh');
    assert.equal(profile.review.human_review, 'external_policy');
    assert.ok(profile.adapters.includes('openspec'));
    // Deferred capabilities stay honestly marked.
    const caps = Object.fromEntries(profile.capabilities.map((cap) => [cap.id, cap.support]));
    assert.equal(caps.session_brief, 'yes');
    assert.equal(caps.context_compaction, 'no');
    assert.equal(caps.fresh_context_review, 'partial');
    assert.ok(profile.artifact_vocabulary.some((entry) => entry.kind === 'design_context' && entry.extension === true));
  });

  it('binds the export to a stored profile decision with --change', async () => {
    const { root, change } = await compiledFixture();
    const result = await exportWorkflowProfile({ rootDir: root, changeId: change, now: '2026-09-13T00:00:00.000Z' });
    assert.equal(result.ok, true);
    assert.equal(result.profile.resolved_decision.change_id, change);
    assert.equal(result.profile.resolved_decision.decision.schema, 'aifhub.sdd_profile_decision.v1');
    assert.equal(result.profile.resolved_decision.decision.profile, 'quick');
    assert.equal(result.profile.framework.adapter_version, '0.1.0');
  });

  it('fails profile --change when the change cannot be resolved', async () => {
    const result = await exportWorkflowProfile({ rootDir: os.tmpdir(), changeId: 'missing-change' });
    assert.equal(result.outcome, 'failed');
    assert.equal(result.errors[0].code, 'active_change_unresolved');
  });

  it('degrades instead of silently dropping a malformed stored decision', async () => {
    const { root, change } = await compiledFixture();
    await put(root, `.ai-factory/state/${change}/sdd/profile-decision.json`, '{not json');
    const result = await exportWorkflowProfile({ rootDir: root, changeId: change });
    assert.equal(result.outcome, 'degraded');
    assert.equal(result.profile.resolved_decision, null);
    assert.ok(result.notes.some((note) => note.code === 'invalid_profile_decision'));
  });
});

describe('Exchange bundle export', () => {
  it('exports plan, session brief, artifacts, and lineage for a compiled change', async () => {
    const { root, change, base } = await compiledFixture();
    const result = await exportExchangeBundle({ rootDir: root, changeId: change, now: '2026-09-13T00:00:00.000Z' });
    assert.equal(result.outcome, 'exported', JSON.stringify(result.notes));
    const bundle = result.bundle;
    assert.equal(bundle.schema, 'aifhub.exchange_bundle.v1');
    assert.equal(bundle.change_id, change);
    assert.equal(bundle.plan.methodology, 'openspec');
    assert.equal(bundle.plan.sdd_profile, 'quick');
    assert.equal(bundle.plan.original_request, 'Add OAuth login.');
    assert.equal(bundle.plan.tasks.length, 2);
    // Session brief payload is exported with its digest binding intact.
    assert.match(bundle.session_brief.digest, /^[a-f0-9]{64}$/);
    assert.equal(bundle.session_brief.status, 'valid');
    assert.equal(bundle.session_brief.profile, 'quick');
    // Canonical documents map to the provider-neutral lineage vocabulary.
    const kinds = Object.fromEntries(bundle.artifacts.map((artifact) => [artifact.ref, artifact.kind]));
    assert.equal(kinds[`${base}/proposal.md`], 'change_spec');
    assert.equal(kinds[`${base}/design.md`], 'change_spec');
    assert.equal(kinds[`${base}/tasks.md`], 'work_item_spec');
    assert.equal(kinds[`${base}/specs/behavior/spec.md`], 'change_spec');
    // Policy files are references, not lineage artifacts.
    assert.ok(bundle.references.some((ref) => ref.path === '.ai-factory/config.yaml'));
    // The brief derives from every canonical artifact.
    const briefRef = `.ai-factory/state/${change}/context/session-brief.json`;
    assert.ok(bundle.lineage.some((edge) => edge.from === briefRef && edge.relation === 'derives_from' && edge.to === `${base}/proposal.md`));
    assert.ok(bundle.lineage.some((edge) => edge.from === briefRef && edge.relation === 'derives_from' && edge.to === `${base}/tasks.md`));
    assert.equal(bundle.receipts.plan_compliance, null);
    assert.equal(bundle.receipts.tracer, null);
    assert.equal(bundle.design_context, null);
    assert.deepEqual(bundle.vocabulary_extensions, ['design_context']);
  });

  it('exports compliance, review, and tracer receipts when present', async () => {
    const { root, change } = await compiledFixture();
    const state = `.ai-factory/state/${change}`;
    await put(root, `${state}/implementation/plan-compliance.json`, JSON.stringify({
      schema: 'aifhub.plan_compliance.v1', change_id: change, plan_revision: null,
      session_brief_digest: null, trace_run_id: null,
      completed_tasks: [{ id: 'task_001', title: 'Implement OAuth handler.' }],
      skipped_tasks: [], unplanned_changes: [], scope_expansions: [],
      new_constraints: [], acceptance_impact: [], outcome: 'compliant', replan_required: false
    }));
    await put(root, `${state}/reviews/review-1/ai-cross-context-review.json`, JSON.stringify({
      schema: 'aifhub.ai_cross_context_review.v1', change_id: change, review_id: 'review-1',
      context_mode: 'fresh', execution_profile: 'ai-fresh-context',
      target: { base: 'abc', head: 'worktree', fingerprint: 'a'.repeat(64), path: 'review-target.diff', changed_files: [], untracked_files: [], too_large: false },
      session_brief_digest: null, source_revisions: [], acceptance_criteria: [], acceptance_examples: [],
      change_surface: { allowed: [], forbidden: [] }, findings: [], finding_count: 2,
      outcome: 'prepared', created_at: '2026-09-13T00:00:00.000Z', same_session_fallback: false, blocked_reasons: []
    }));
    await put(root, `${state}/tracer/decision.json`, JSON.stringify({
      schema: 'aifhub.tracer_decision.v1', change_id: change, decision: 'promote',
      reason: 'Slice proved the hypothesis.', promotion_steps: [],
      created_at: '2026-09-13T00:00:00.000Z', updated_at: '2026-09-13T00:00:00.000Z'
    }));
    const result = await exportExchangeBundle({ rootDir: root, changeId: change });
    assert.equal(result.outcome, 'exported');
    const bundle = result.bundle;
    assert.equal(bundle.receipts.plan_compliance.outcome, 'compliant');
    assert.equal(bundle.receipts.reviews.length, 1);
    assert.equal(bundle.receipts.reviews[0].receipt.finding_count, 2);
    assert.equal(bundle.receipts.tracer.decision.decision, 'promote');
    const complianceRef = `${state}/implementation/plan-compliance.json`;
    assert.ok(bundle.lineage.some((edge) => edge.from === complianceRef && edge.relation === 'verifies'));
    assert.ok(bundle.lineage.some((edge) => edge.from === `${state}/reviews/review-1/ai-cross-context-review.json` && edge.relation === 'verifies'));
    assert.ok(bundle.lineage.some((edge) => edge.from === `${state}/tracer/decision.json` && edge.relation === 'refines'));
  });

  it('exports a degraded bundle with notes when the brief is missing', async () => {
    const { root, change } = await fixture();
    const result = await exportExchangeBundle({ rootDir: root, changeId: change });
    assert.equal(result.outcome, 'degraded');
    assert.equal(result.ok, false);
    assert.equal(result.bundle.session_brief, null);
    assert.ok(result.bundle.artifacts.length > 0);
  });

  it('includes a valid design.context.json and reports a malformed one', async () => {
    const designContext = {
      schema: 'aifhub.design_context.v1',
      summary: 'Login screen mock.',
      surfaces: [{ id: 'login-screen', kind: 'figma', ref: 'figma:file/abc123', description: 'OAuth login mock.' }]
    };
    const { root, change, base } = await compiledFixture({ designContext });
    const result = await exportExchangeBundle({ rootDir: root, changeId: change });
    assert.equal(result.outcome, 'exported');
    assert.equal(result.bundle.design_context.surfaces[0].id, 'login-screen');
    assert.equal(result.bundle.artifacts.find((a) => a.ref === `${base}/design.context.json`)?.kind, 'design_context');

    const bad = await compiledFixture({ designContext: '{not json' });
    const badResult = await exportExchangeBundle({ rootDir: bad.root, changeId: bad.change });
    assert.equal(badResult.outcome, 'degraded');
    assert.equal(badResult.bundle.design_context, null);
    assert.ok(badResult.notes.some((note) => note.code === 'invalid_design_context'));
  });

  it('marks an invalid compliance receipt as a note instead of exporting it', async () => {
    const { root, change } = await compiledFixture();
    await put(root, `.ai-factory/state/${change}/implementation/plan-compliance.json`, '{"schema":"other"}');
    const result = await exportExchangeBundle({ rootDir: root, changeId: change });
    assert.equal(result.bundle.receipts.plan_compliance, null);
    assert.ok(result.notes.some((note) => note.code === 'invalid_plan_compliance_receipt'));
  });

  it('rejects contract-violating, unparseable, and foreign-change receipts with notes', async () => {
    const { root, change } = await compiledFixture();
    const state = `.ai-factory/state/${change}`;
    // Correct schema but an outcome outside the v1 contract.
    await put(root, `${state}/implementation/plan-compliance.json`, JSON.stringify({
      schema: 'aifhub.plan_compliance.v1', change_id: change, plan_revision: null,
      session_brief_digest: null, trace_run_id: null, completed_tasks: [],
      skipped_tasks: [], unplanned_changes: [], scope_expansions: [],
      new_constraints: [], acceptance_impact: [], outcome: 'success', replan_required: false
    }));
    // Unparseable review payload.
    await put(root, `${state}/reviews/broken/ai-cross-context-review.json`, '{not json');
    // Valid contract but bound to a different change.
    await put(root, `${state}/tracer/decision.json`, JSON.stringify({
      schema: 'aifhub.tracer_decision.v1', change_id: 'other-change', decision: 'promote',
      reason: 'ok', promotion_steps: [], created_at: '2026-09-13T00:00:00.000Z', updated_at: '2026-09-13T00:00:00.000Z'
    }));
    const result = await exportExchangeBundle({ rootDir: root, changeId: change });
    assert.equal(result.outcome, 'degraded');
    const bundle = result.bundle;
    assert.equal(bundle.receipts.plan_compliance, null);
    assert.equal(bundle.receipts.reviews.length, 0);
    assert.equal(bundle.receipts.tracer, null);
    const details = Object.fromEntries(result.notes.filter((note) => note.detail).map((note) => [note.code, note.detail]));
    assert.equal(details.invalid_plan_compliance_receipt, 'contract_violation');
    assert.equal(details.invalid_review_receipt, 'unparseable');
    assert.equal(details.invalid_tracer_decision, 'change_binding_mismatch');
  });

  it('exports a degraded bundle for a native-only AI Factory plan', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'aifhub-exchange-aif-'));
    roots.push(root);
    await put(root, '.ai-factory/config.yaml', 'paths:\n  plan: .ai-factory/PLAN.md\n');
    await put(root, '.ai-factory/PLAN.md', '# Plan\n\n- [ ] 1.1 Do the native task.\n');
    const result = await exportExchangeBundle({ rootDir: root, changeId: 'native-task', methodology: 'aifactory' });
    assert.equal(result.outcome, 'degraded');
    const bundle = result.bundle;
    assert.equal(bundle.plan.methodology, 'aifactory');
    assert.equal(bundle.plan.public_mode, 'fast');
    assert.equal(bundle.plan.tasks.length, 1);
    assert.ok(result.notes.some((note) => note.code === 'aifactory-native-plan-parsing-incomplete'));
    // SessionBrief is OpenSpec-protocol-bound; aifactory exports stay degraded.
    assert.ok(result.notes.some((note) => note.code === 'session_brief_blocked'));
  });
});

describe('Evaluation export', () => {
  it('rejects unknown evidence classes and missing runner metrics files', async () => {
    const { root, change } = await fixture();
    const bad = await exportEvaluation({ rootDir: root, changeId: change, evidenceClass: 'production' });
    assert.equal(bad.outcome, 'failed');
    assert.equal(bad.errors[0].code, 'invalid_evidence_class');
    const missing = await exportEvaluation({ rootDir: root, changeId: change, evidenceClass: 'synthetic_fixture', runnerMetricsPath: 'metrics/none.json' });
    assert.equal(missing.errors[0].code, 'runner_metrics_not_found');
  });

  it('emits anonymized metrics with runner data and no paths or change id', async () => {
    const { root, change } = await compiledFixture();
    await put(root, 'metrics/run-1.json', JSON.stringify({
      schema: 'aifhub.runner_metrics.v1', run_id: 'run-1',
      tokens: { input: 1200, output: 300, total: 1500 },
      cost: { amount: 0.02, currency: 'USD' }, latency_ms: 4200,
      retries: 1, changed_loc: 87, unrelated_changes: 0, human_review_ms: 60000,
      verified_success: true,
      model: { provider: 'anthropic', id: 'claude-sonnet', version: 'exact' },
      harness: { id: 'ai-factory', version: '2.18.1' }
    }));
    const result = await exportEvaluation({
      rootDir: root, changeId: change, evidenceClass: 'maintainer_controlled',
      runnerMetricsPath: 'metrics/run-1.json', now: '2026-09-13T00:00:00.000Z'
    });
    assert.equal(result.outcome, 'exported', JSON.stringify(result.notes));
    const record = result.evaluation;
    assert.equal(record.schema, 'aifhub.evaluation_export.v1');
    assert.match(record.export_id, /^[a-f0-9]{64}$/);
    assert.equal(record.evidence_class, 'maintainer_controlled');
    assert.equal(record.subject.sdd_profile, 'quick');
    assert.equal(record.metrics.brief_bytes > 0, true);
    assert.equal(record.metrics.tokens_total, 1500);
    assert.equal(record.metrics.cost.amount, 0.02);
    assert.equal(record.metrics.latency_ms, 4200);
    assert.equal(record.metrics.tasks_total, 2);
    assert.equal(record.metrics.tasks_completed, 1);
    assert.equal(record.metrics.retries, 1);
    assert.equal(record.metrics.changed_loc, 87);
    assert.equal(record.metrics.unrelated_changes, 0);
    assert.equal(record.metrics.human_review_ms, 60000);
    assert.equal(record.outcomes.verified_success, true);
    assert.equal(record.runtime.model.id, 'claude-sonnet');
    // No private content leaks: the serialized record carries no project paths,
    // no prompts, and no change identifier.
    const serialized = JSON.stringify(record);
    assert.equal(serialized.includes('openspec/'), false);
    assert.equal(serialized.includes('.ai-factory/'), false);
    assert.equal(serialized.includes(change), false);
    assert.equal(record.privacy.contains_paths, false);
    assert.equal(record.privacy.contains_change_id, false);
    // Same inputs produce the same content identity.
    const again = await exportEvaluation({
      rootDir: root, changeId: change, evidenceClass: 'maintainer_controlled',
      runnerMetricsPath: 'metrics/run-1.json', now: '2026-09-13T00:00:00.000Z'
    });
    assert.equal(again.evaluation.export_id, record.export_id);
    // The fingerprint is HMAC-salted per project, not a bare hash of the id.
    const { createHash } = await import('node:crypto');
    assert.notEqual(record.subject.change_fingerprint, createHash('sha256').update(`change:${change}`).digest('hex'));
    const salt = JSON.parse(await readFile(path.join(root, '.ai-factory/state/exchange/fingerprint-salt.json'), 'utf8'));
    assert.match(salt.salt, /^[a-f0-9]{64}$/);
    // A second project gets a different fingerprint for the same change id.
    const other = await compiledFixture();
    const otherRecord = await exportEvaluation({ rootDir: other.root, changeId: change, evidenceClass: 'maintainer_controlled' });
    assert.notEqual(otherRecord.evaluation.subject.change_fingerprint, record.subject.change_fingerprint);
  });

  it('keeps metrics null without runner data and marks outcome fields null', async () => {
    const { root, change } = await fixture();
    const result = await exportEvaluation({ rootDir: root, changeId: change, evidenceClass: 'synthetic_fixture' });
    assert.equal(result.outcome, 'degraded');
    const record = result.evaluation;
    assert.equal(record.metrics.brief_bytes, null);
    assert.equal(record.metrics.tokens_input, null);
    assert.equal(record.metrics.cost, null);
    assert.equal(record.outcomes.plan_compliance, null);
    assert.equal(record.outcomes.tracer, null);
  });

  it('strips note details that may carry project paths from public records', async () => {
    const { root, change } = await compiledFixture();
    // A receipt whose path-bearing detail would otherwise leak into the record.
    await put(root, `.ai-factory/state/${change}/implementation/plan-compliance.json`, '{"schema":"other"}');
    const result = await exportEvaluation({ rootDir: root, changeId: change, evidenceClass: 'synthetic_fixture' });
    assert.equal(result.outcome, 'degraded');
    assert.ok(result.evaluation.exchange_notes.some((note) => note.code === 'invalid_plan_compliance_receipt'));
    for (const note of result.evaluation.exchange_notes) assert.equal('detail' in note, false);
    assert.equal(JSON.stringify(result.evaluation).includes('openspec/'), false);
  });

  it('rejects malformed runner metrics content', async () => {
    const { root, change } = await compiledFixture();
    await put(root, 'metrics/bad.json', JSON.stringify({ schema: 'aifhub.runner_metrics.v1', tokens: { input: 'lots' } }));
    const result = await exportEvaluation({ rootDir: root, changeId: change, evidenceClass: 'synthetic_fixture', runnerMetricsPath: 'metrics/bad.json' });
    assert.equal(result.outcome, 'failed');
    assert.equal(result.errors[0].code, 'invalid_runner_metrics');
  });
});

describe('Exchange command', () => {
  it('rejects invalid arguments and unknown actions', async () => {
    const out = stdout();
    assert.equal(await runExchangeCommand(['nope'], { rootDir: os.tmpdir(), stdout: out }), 2);
    assert.equal(await runExchangeCommand(['bundle', '--change'], { rootDir: os.tmpdir(), stdout: out }), 2);
    assert.equal(await runExchangeCommand(['evaluation', '--change', 'x', '--evidence-class', 'bad'], { rootDir: os.tmpdir(), stdout: out }), 2);
  });

  it('writes the bundle through --output and blocks path escapes', async () => {
    const { root, change } = await compiledFixture();
    const out = stdout();
    const exit = await runExchangeCommand(
      ['bundle', '--change', change, '--json', '--output', `.ai-factory/state/${change}/exchange/bundle.json`],
      { rootDir: root, stdout: out }
    );
    assert.equal(exit, 0);
    const stored = JSON.parse(await readFile(path.join(root, `.ai-factory/state/${change}/exchange/bundle.json`), 'utf8'));
    assert.equal(stored.schema, 'aifhub.exchange_bundle.v1');
    const escape = await runExchangeCommand(
      ['bundle', '--change', change, '--output', '../outside.json'],
      { rootDir: root, stdout: stdout() }
    );
    assert.equal(escape, 2);
  });

  it('exports the profile catalog to stdout in json mode', async () => {
    const out = stdout();
    const exit = await runExchangeCommand(['profile', '--json'], { rootDir: os.tmpdir(), stdout: out });
    assert.equal(exit, 0);
    const profile = JSON.parse(out.written);
    assert.equal(profile.schema, 'aifhub.workflow_profile_export.v1');
  });
});

describe('Design context validation', () => {
  it('accepts bounded surfaces and rejects malformed input', () => {
    assert.deepEqual(EVIDENCE_CLASSES.length, 5);
    assert.deepEqual(validateDesignContext({ schema: 'aifhub.design_context.v1', surfaces: [] }), []);
    assert.deepEqual(validateDesignContext({
      schema: 'aifhub.design_context.v1',
      surfaces: [{ id: 's1', kind: 'html', ref: 'docs/mock.html', sha256: 'a'.repeat(64) }]
    }), []);
    assert.ok(validateDesignContext({ schema: 'other', surfaces: [] }).length > 0);
    assert.ok(validateDesignContext({ schema: 'aifhub.design_context.v1', surfaces: [{ id: 'BAD', kind: 'html', ref: 'x' }] }).length > 0);
    assert.ok(validateDesignContext({ schema: 'aifhub.design_context.v1', surfaces: [{ id: 's1', kind: 'url', ref: 'x' }] }).length > 0);
    assert.ok(validateDesignContext({ schema: 'aifhub.design_context.v1', surfaces: [{ id: 's1', kind: 'html', ref: 'x', extra: true }] }).length > 0);
    assert.ok(validateDesignContext({ schema: 'aifhub.design_context.v1', surfaces: [], unknown_top_level: true }).length > 0);
  });
});
