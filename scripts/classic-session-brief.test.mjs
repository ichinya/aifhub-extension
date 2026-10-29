import { after, it } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, readFile, writeFile, rm, realpath, readdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { compileSessionBrief, inspectSessionBrief, assertSessionBriefBinding } from './session-brief.mjs';
import { resolvePlanContext, resolvePlanTarget } from './common-plan-resolver.mjs';
import { buildImplementationContext, buildFixContext, writeFixTrace, writeExecutionTrace } from './openspec-execution-context.mjs';
import { checkPlanCompliance } from './plan-compliance.mjs';
import { prepareFreshContextReview } from './fresh-context-review.mjs';
import { runTracer, decideTracer } from './tracer.mjs';
import { exportExchangeBundle } from './workflow-exchange.mjs';

const roots = [], id = 'consumer-audit', base = `.ai-factory/plans/${id}`, parent = `${base}.md`;
const files = [parent, ...['task.md', 'context.md', 'rules.md', 'verify.md', 'status.yaml'].map(name => `${base}/${name}`)].sort();
async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'classic-brief-')));
  roots.push(root);
  await cp(new URL('../test/fixtures/classic-session-brief/', import.meta.url), root, { recursive: true });
  return root;
}
const opts = root => ({ rootDir: root, cwd: root, changeId: id, getCurrentBranch: async () => null });
const put = (root, file, text) => writeFile(path.join(root, file), text);
const text = (root, file) => readFile(path.join(root, file), 'utf8');
after(async () => { for (const root of roots) await rm(root, { recursive: true, force: true }); });

it('classic full context and twin-root briefs are reproducible, with mandatory null composition inside digest', async () => {
  const root = await fixture(), twin = await fixture();
  const context = await resolvePlanContext(opts(root));
  assert.deepEqual(context.errors, []);
  assert.deepEqual(context.documents.map(d => d.path), files);
  assert.equal(context.public_mode, 'full');
  assert.equal(context.tasks[0].id, '1');
  assert.ok(context.requirements.intent && context.requirements.target_outcome);
  const first = await compileSessionBrief({ ...opts(root), instruction_composition_digest: 'f'.repeat(64) });
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal((await compileSessionBrief(opts(twin))).digest, first.digest);
  const status = await inspectSessionBrief({ ...opts(root), includeBrief: true });
  assert.equal(status.status, 'valid');
  assert.equal(status.brief.instruction_composition_digest, null);
  assert.equal(status.brief.plan_context.methodology, 'aifactory');
  assert.equal(first.sources.some(source => source.path.startsWith('openspec/')), false);
  assert.equal(status.brief.context_manifest.find(d => d.path.endsWith('status.yaml')).fidelity, 'projection');
});

it('classic status progress is excluded from revision, companion drift is stale', async () => {
  const root = await fixture();
  const compiled = await compileSessionBrief(opts(root));
  await put(root, `${base}/status.yaml`, `plan_id: ${id}\ncurrent_task: 2\nupdated_at: later\nhistory:\n  - progress\n`);
  assert.equal((await inspectSessionBrief(opts(root))).status, 'valid');
  await put(root, `${base}/context.md`, '# Changed committed design\n');
  const stale = await inspectSessionBrief(opts(root));
  assert.equal(stale.status, 'stale');
  assert.ok(stale.stale_reasons.includes('source_revision_changed'));
  await assert.rejects(assertSessionBriefBinding(id, compiled.digest, opts(root)), /session_brief_not_current/);
});

for (const filename of ['task.md', 'context.md', 'rules.md', 'verify.md', 'status.yaml']) it(`validation gates missing companion ${filename}`, async () => {
  const root = await fixture();
  await rm(path.join(root, base, filename));
  await assert.rejects(resolvePlanContext(opts(root)), error => error.planResolverCode === 'missing_classic_companion');
  const compiled = await compileSessionBrief(opts(root));
  assert.deepEqual(compiled.errors, [{ code: 'missing_classic_companion' }]);
});

it('validation gates missing selected parent, checklist mismatch and all source diagnostics survive', async () => {
  const root = await fixture();
  await put(root, `${base}/task.md`, '- [ ] Changed task\n');
  await put(root, `${base}/status.yaml`, 'plan_id: wrong\n');
  const result = await compileSessionBrief(opts(root));
  assert.deepEqual(result.errors, [{ code: 'classic-checklist-mismatch' }, { code: 'plan-id-mismatch' }]);
  await rm(path.join(root, parent));
  await assert.rejects(resolvePlanContext(opts(root)), /missing_plan_file/);
});

it('classic RU aliases and CRLF verbatim bodies preserve code, tables and punctuation', async () => {
  const root = await fixture();
  let source = await text(root, parent);
  source = source.replace('## Summary', '## Резюме').replace('## Scope', '## Область изменений').replace('## Requirements\n', '## Требования\n').replaceAll('\n', '\r\n');
  await put(root, parent, source);
  const context = await resolvePlanContext(opts(root));
  assert.equal(context.original_request, source.split('## Original Request\r\n')[1].split('## Requirements Reconciliation')[0]);
  assert.equal(context.requirements_reconciliation, source.split('## Requirements Reconciliation\r\n')[1].split('## Резюме')[0]);
  assert.ok(context.acceptance_examples[0].includes('```json\r\n'));
  assert.equal((await compileSessionBrief(opts(root))).ok, true);
});

it('fenced headings are examples; duplicate active singular sections fail closed', async () => {
  const root = await fixture();
  await put(root, parent, (await text(root, parent)) + '\n```md\n## Summary\nexample\n```\n');
  assert.equal((await compileSessionBrief(opts(root))).ok, true);
  await put(root, parent, (await text(root, parent)) + '\n## Summary\nsecond\n');
  assert.ok((await compileSessionBrief(opts(root))).errors.some(e => e.code === 'duplicate_source_section'));
});

for (const [heading, code] of [['Summary', 'missing_intent_or_outcome'], ['Scope', 'missing_allowed_change_surface'], ['Requirements', 'missing_behavior_acceptance_context']]) it(`does not invent missing ${heading}`, async () => {
  const root = await fixture();
  await put(root, parent, (await text(root, parent)).replace(new RegExp(`## ${heading}\\n[\\s\\S]*?(?=## )`), ''));
  const result = await compileSessionBrief(opts(root));
  assert.equal(result.status, 'blocked');
  assert.ok(result.blocked_reasons.includes(code), JSON.stringify(result));
});

it('classic consumers share the exact consumed digest; fix and implement reject missing binding', async () => {
  const root = await fixture(), options = opts(root);
  const compiled = await compileSessionBrief(options);
  const context = await buildImplementationContext({ ...options, detectOpenSpec: () => { throw new Error('classic must not detect'); } });
  assert.equal(context.ok, true, JSON.stringify(context));
  assert.equal(context.mode, 'aifactory-classic');
  assert.deepEqual(context.generatedRules, []);
  assert.equal((await buildFixContext(options)).ok, true);
  for (const write of [writeFixTrace, writeExecutionTrace]) {
    await assert.rejects(write(id, {}, { ...options, runId: 'unbound' }), /session_brief_digest_mismatch/);
    const result = await write(id, { sessionBriefDigest: compiled.digest, changedFiles: ['src/consumer/read.mjs'] }, { ...options, runId: 'bound' });
    assert.match(await readFile(result.path, 'utf8'), new RegExp(compiled.digest));
  }
  const receipt = await checkPlanCompliance({ ...options, runId: 'bound' });
  assert.equal(receipt.ok, true, JSON.stringify(receipt));
  const missing = await checkPlanCompliance({ ...options, runId: 'does-not-exist', changedFiles: [] });
  assert.equal(missing.ok, false);
  assert.ok(missing.receipt.blocked_reasons.includes('missing_trace'));
  const review = await prepareFreshContextReview({ ...options, targetDiff: 'diff --git a/src/consumer/read.mjs b/src/consumer/read.mjs\n+change', changedFiles: ['src/consumer/read.mjs'], sessionId: 'independent-review' });
  assert.equal(review.ok, true, JSON.stringify(review));
  const tracer = await runTracer({ ...options, hypothesis: 'Contract fits', minimumVerticalPath: 'consumer -> response' });
  assert.equal(tracer.ok, true, JSON.stringify(tracer));
  const promote = await decideTracer({ ...options, decision: 'promote', reason: 'Evidence retained' });
  assert.equal(promote.ok, true, JSON.stringify(promote));
  const exchange = await exportExchangeBundle(options);
  assert.equal(exchange.ok, true, JSON.stringify(exchange));
});

it('classic discovery is exact-one and never falls back to retained OpenSpec', async () => {
  const root = await fixture();
  assert.equal((await resolvePlanTarget({ rootDir: root })).changeId, id);
  await put(root, '.ai-factory/plans/second.md', '# Other plan\n');
  await assert.rejects(resolvePlanTarget({ rootDir: root }), /ambiguous_active_plan/);
});

it('all consumers normalize explicit native companion targets through the shared resolver', async () => {
  const root = await fixture(), options = { ...opts(root), changeId: `${base}/task.md` };
  const compiled = await compileSessionBrief(options);
  assert.equal(compiled.ok, true, JSON.stringify(compiled));
  assert.equal((await buildImplementationContext(options)).mode, 'aifactory-classic');
  await writeExecutionTrace(id, { sessionBriefDigest: compiled.digest, changedFiles: ['src/consumer/read.mjs'] }, { ...opts(root), runId: 'path-bound' });
  assert.equal((await checkPlanCompliance({ ...options, runId: 'path-bound' })).ok, true);
  assert.equal((await prepareFreshContextReview({ ...options, targetDiff: '+ changed\n', changedFiles: ['src/consumer/read.mjs'], sessionId: 'path-review' })).ok, true);
  assert.equal((await runTracer({ ...options, hypothesis: 'Contract fits', minimumVerticalPath: 'consumer -> response' })).ok, true);
  assert.equal((await exportExchangeBundle(options)).ok, true);
});

it('explicit full and fast identity obey custom paths without intercepting each other', async () => {
  const root = await fixture();
  await mkdir(path.join(root, 'planning'), { recursive: true });
  await cp(path.join(root, '.ai-factory/plans'), path.join(root, 'planning/changes'), { recursive: true });
  await put(root, '.ai-factory/config.yaml', 'aifhub:\n  tools: {}\npaths:\n  plans: planning/changes\n  plan: planning/fast.md\n');
  await put(root, 'planning/fast.md', '## Summary\nFast intent.\n\n## Scope\n- docs/**\n\n## Tasks\n- [ ] Fast task.\n');
  const full = await resolvePlanContext({ ...opts(root), changeId: `planning/changes/${id}.md` });
  assert.equal(full.entrypoint, `planning/changes/${id}.md`);
  assert.equal(full.public_mode, 'full');
  const fast = await resolvePlanContext({ ...opts(root), changeId: 'planning/fast.md' });
  assert.equal(fast.public_mode, 'fast');
  assert.deepEqual(fast.documents, []);
  assert.deepEqual(fast.upstream_handoff, { owner: 'upstream', entrypoint: 'planning/fast.md' });
  const result = await compileSessionBrief({ ...opts(root), changeId: `planning/changes/${id}.md` });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.sources.some(d => d.path.startsWith('.ai-factory/plans/')), false);
  await put(root, 'planning/fast.md', (await text(root, parent)) + '\n## Verification Plan\n\n- Run focused checks.\n');
  const mismatchedFast = await compileSessionBrief({ ...opts(root), changeId: 'planning/fast.md' });
  assert.equal(mismatchedFast.status, 'delegated');
  assert.equal(mismatchedFast.owner_handoff, '/aif-implement planning/fast.md');
  assert.deepEqual(mismatchedFast.blocked_reasons, ['upstream_fast_handoff']);
});

it('synchronized Markdown/YAML binding drift revises the brief; conflicts fail closed', async () => {
  const root = await fixture(), request = await text(root, parent);
  const binding = branch => `\n## AIFHub Source Binding\n\n- Provider: github\n- Primary source: https://github.com/example/consumer/issues/1\n- External ID: 1\n- Branch: ${branch}\n`;
  const status = branch => `plan_id: ${id}\nsource_binding:\n  provider: "github"\n  primary_source: "https://github.com/example/consumer/issues/1"\n  external_id: "1"\n  branch: "${branch}"\n`;
  await put(root, parent, request + binding('feature/one'));
  await put(root, `${base}/status.yaml`, status('feature/one'));
  const compiled = await compileSessionBrief(opts(root));
  assert.equal(compiled.ok, true, JSON.stringify(compiled));
  await put(root, parent, request + binding('feature/two'));
  await put(root, `${base}/status.yaml`, status('feature/two'));
  assert.equal((await inspectSessionBrief(opts(root))).status, 'stale');
  await put(root, `${base}/status.yaml`, status('feature/one'));
  assert.ok((await compileSessionBrief(opts(root))).errors.some(e => e.code === 'invalid-source-binding'));
});

for (const [raw, code] of [
  ['aifhub:\n  tools:\n    nope: true\n', 'invalid_tool_switch'],
  ['aifhub:\n  tools: {}\naifhub:\n  tools: {}\n', 'duplicate_aifhub'],
  ['aifhub:\n  artifactProtocol: other\n', 'invalid_artifact_protocol']
]) it(`malformed effective config fails closed: ${code}`, async () => {
  const root = await fixture();
  await put(root, '.ai-factory/config.yaml', raw);
  assert.deepEqual((await compileSessionBrief(opts(root))).errors, [{ code }]);
});

it('missing config and retained OpenSpec directory do not activate OpenSpec', async () => {
  const root = await fixture();
  await rm(path.join(root, '.ai-factory/config.yaml'));
  await mkdir(path.join(root, 'openspec/changes/decoy'), { recursive: true });
  await put(root, 'openspec/changes/decoy/proposal.md', 'Decoy.\n');
  const result = await compileSessionBrief(opts(root));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.sources.some(d => d.path.startsWith('openspec/')), false);
});

it('exact declared document refs are selected; native specs and recursive references stay excluded', async () => {
  const root = await fixture();
  await mkdir(path.join(root, 'docs'), { recursive: true });
  await mkdir(path.join(root, '.ai-factory/specs'), { recursive: true });
  await put(root, 'docs/interface.md', '# Interface\n\nRead docs/unrelated.md.\n');
  await put(root, 'docs/unrelated.md', 'EXCLUDED\n');
  await put(root, '.ai-factory/specs/decoy.md', 'EXCLUDED\n');
  await put(root, `${base}/context.md`, (await text(root, `${base}/context.md`)) + '\n## Document References\n\n- `docs/interface.md`\n');
  const result = await compileSessionBrief(opts(root));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.sources.some(d => d.path === 'docs/interface.md'), true);
  assert.equal(result.sources.some(d => d.path === 'docs/unrelated.md' || d.path.startsWith('.ai-factory/specs/')), false);
});

it('classic credential checks cover materialized fields and sanitize every diagnostic', async () => {
  const root = await fixture(), secret = 'Bearer abcdefghijklmnopqrstuvwxyz';
  await put(root, parent, (await text(root, parent)).replace('Consumers need a stable response contract.', secret));
  const result = await compileSessionBrief(opts(root));
  assert.deepEqual(result.errors, [{ code: 'sensitive_brief_content' }]);
  assert.equal(JSON.stringify(result).includes(secret), false);
});

async function ultraFixture() {
  const root = await fixture();
  await rm(path.join(root, parent));
  for (const name of ['task.md', 'context.md', 'rules.md', 'verify.md', 'status.yaml']) await rm(path.join(root, base, name));
  await put(root, `${base}/index.md`, '<!-- aif:plan-mode:ultra -->\n\n# Bundle\n\n## Phase Index\n\n1. [Phase 01](phase-01-foundation.md)\n\n## Tasks\n\n- [ ] **Task 1:** Implement the foundation.\n');
  await put(root, `${base}/phase-01-foundation.md`, '# Phase 01\n\n## Task 1: Implement the foundation\n\nDetails.\n');
  return root;
}

it('ultra delegates exact entrypoints to implement/fix/verify without classic parsing or runtime writes', async () => {
  const root = await ultraFixture();
  const context = await resolvePlanContext(opts(root));
  assert.equal(context.public_mode, 'ultra');
  assert.deepEqual(context.upstream_handoff, { owner: 'upstream', entrypoint: `${base}/index.md` });
  assert.deepEqual(context.errors, []);
  for (const role of ['implement', 'fix', 'verify']) {
    const result = await compileSessionBrief({ ...opts(root), role });
    assert.deepEqual(result.blocked_reasons, ['ultra_upstream_handoff']);
    assert.equal(result.owner_handoff, `/aif-${role} ${base}/index.md`);
  }
  assert.equal(await readFile(path.join(root, `.ai-factory/state/${id}/context/session-brief.json`)).catch(() => null), null);
});

for (const [name, mutate, code] of [
  ['missing', s => s.replace('<!-- aif:plan-mode:ultra -->\n', ''), 'ultra-marker-missing'],
  ['duplicate', s => '<!-- aif:plan-mode:ultra -->\n' + s, 'ultra-marker-duplicate'],
  ['position', s => '# First heading\n' + s, 'ultra-marker-position-invalid']
]) it(`ultra ${name} marker fails closed with classifier code`, async () => {
  const root = await ultraFixture();
  await put(root, `${base}/index.md`, mutate(await text(root, `${base}/index.md`)));
  const result = await compileSessionBrief(opts(root));
  assert.ok(result.errors.some(e => e.code === code), JSON.stringify(result));
  assert.ok(result.blocked_reasons.includes('unsupported_plan_shape'));
});

it('ultra/classic collision never enters native parsing', async () => {
  const root = await ultraFixture();
  await put(root, parent, 'Invalid native checklist [source must not parse]\n');
  const result = await compileSessionBrief(opts(root));
  assert.ok(result.errors.some(e => e.code === 'classic-ultra-plan-collision'));
});

it('compiler bounds source bytes before native parsing', async () => {
  const root = await fixture();
  await put(root, parent, 'x'.repeat(2 * 1024 * 1024 + 1));
  assert.deepEqual((await compileSessionBrief(opts(root))).errors, [{ code: 'invalid_source_file' }]);
});

it('compiler bounds case-insensitive ultra phase sources before the shared classifier reads them', async () => {
  const root = await ultraFixture();
  await rm(path.join(root, base, 'phase-01-foundation.md'));
  await put(root, `${base}/index.md`, (await text(root, `${base}/index.md`)).replaceAll('phase-01-foundation.md', 'PHASE-01-FOUNDATION.MD'));
  await put(root, `${base}/PHASE-01-FOUNDATION.MD`, 'x'.repeat(2 * 1024 * 1024 + 1));
  assert.deepEqual((await compileSessionBrief(opts(root))).errors, [{ code: 'invalid_source_file' }]);
});

it('compliance never treats an absent trace or digest as consumed evidence', async () => {
  const root = await fixture();
  await compileSessionBrief(opts(root));
  const missing = await checkPlanCompliance({ ...opts(root), changedFiles: [] });
  assert.equal(missing.ok, false);
  assert.ok(missing.receipt.blocked_reasons.includes('missing_trace'));
  await mkdir(path.join(root, `.ai-factory/state/${id}/implementation`), { recursive: true });
  await put(root, `.ai-factory/state/${id}/implementation/unbound.md`, '# Implementation Trace\n\n## Changed files\n\n- src/consumer/read.mjs\n');
  const unbound = await checkPlanCompliance({ ...opts(root), runId: 'unbound' });
  assert.equal(unbound.ok, false);
  assert.ok(unbound.receipt.blocked_reasons.includes('trace_session_brief_unbound'));
});

it('validation precedes native checklist parsing and placeholder facts never authorize execution', async () => {
  const root = await fixture(), source = await text(root, parent);
  await put(root, parent, source.replace('Task 1:', '01'));
  await rm(path.join(root, base, 'verify.md'));
  // The malformed task would throw invalid-task-id if readContext were called.
  assert.deepEqual((await compileSessionBrief(opts(root))).errors, [{ code: 'missing_classic_companion' }]);
  await put(root, `${base}/verify.md`, '# Verification\n\nRun the focused check.\n');
  await put(root, parent, source.replace('Consumers need a stable response contract.', 'TODO'));
  assert.ok((await compileSessionBrief(opts(root))).blocked_reasons.includes('missing_intent_or_outcome'));
});

it('fenced task scope and research labels cannot supply missing declared facts', async () => {
  const root = await fixture();
  let source = await text(root, parent);
  source = source.replace(/## Scope\n[\s\S]*?(?=## )/, '');
  source += '\n## Research Context\n\n```text\nGoal: invented outcome\n```\n';
  await put(root, parent, source);
  await put(root, `${base}/task.md`, (await text(root, `${base}/task.md`)) + '\n```md\n### In Scope\n- arbitrary/**\n```\n');
  const result = await compileSessionBrief(opts(root));
  assert.ok(result.blocked_reasons.includes('missing_intent_or_outcome'));
  assert.ok(result.blocked_reasons.includes('missing_allowed_change_surface'));
});

it('tracer refuses stale promotion and retains prior findings when a new bound run replaces it', async () => {
  const root = await fixture(), options = { ...opts(root), hypothesis: 'Contract fits', minimumVerticalPath: 'consumer -> response', findings: ['Keep  two spaces.'] };
  await compileSessionBrief(options);
  assert.equal((await runTracer(options)).ok, true);
  const before = await text(root, `.ai-factory/state/${id}/tracer/findings.json`);
  await put(root, `${base}/context.md`, '# Revised design\n\nUse revised contract.\n');
  assert.equal((await decideTracer({ ...options, decision: 'promote' })).ok, false);
  assert.equal(await text(root, `.ai-factory/state/${id}/tracer/findings.json`), before);
  await compileSessionBrief(options);
  assert.equal((await runTracer({ ...options, findings: ['New evidence.'] })).ok, true);
  const historyDir = `.ai-factory/state/${id}/tracer/history`;
  const historyFiles = await readdir(path.join(root, historyDir));
  assert.equal(historyFiles.length, 1);
  const history = JSON.parse(await text(root, `${historyDir}/${historyFiles[0]}`));
  assert.deepEqual(history.findings.findings, ['Keep  two spaces.']);
});

it('classic compiler retains aggregate raw-byte and source-count budgets', async () => {
  const root = await fixture();
  await mkdir(path.join(root, 'docs'), { recursive: true });
  const refs = [];
  for (let i = 0; i < 17; i++) {
    const file = `docs/budget-${i}.md`;
    refs.push(file);
    await put(root, file, 'x'.repeat(2 * 1024 * 1024));
  }
  await put(root, '.ai-factory/sdd-policy.json', JSON.stringify({ schema: 'aifhub.sdd_policy.v1', context_refs: refs }));
  assert.deepEqual((await compileSessionBrief(opts(root))).errors, [{ code: 'source_budget_exceeded' }]);
  await rm(path.join(root, '.ai-factory/sdd-policy.json'));
  await mkdir(path.join(root, '.ai-factory/rules'), { recursive: true });
  for (let i = 0; i < 1025; i++) await put(root, `.ai-factory/rules/budget-${i}.md`, 'small\n');
  assert.deepEqual((await compileSessionBrief(opts(root))).errors, [{ code: 'source_budget_exceeded' }]);
});

it('every committed classic companion and optional explore source participates in freshness', async () => {
  for (const name of ['context.md', 'rules.md', 'verify.md', 'explore.md']) {
    const root = await fixture(), file = `${base}/${name}`;
    if (name === 'explore.md') await put(root, file, '# Explore\n\nCommitted research context.\n');
    const compiled = await compileSessionBrief(opts(root));
    assert.equal(compiled.ok, true);
    assert.equal(compiled.sources.some(source => source.path === file), true);
    await put(root, file, (await text(root, file)) + '\n- Additional committed fact.\n');
    const status = await inspectSessionBrief(opts(root));
    assert.equal(status.status, 'stale', name);
    assert.ok(status.stale_reasons.includes('source_revision_changed'), name);
  }
  const root = await fixture();
  await compileSessionBrief(opts(root));
  for (const file of [parent, `${base}/task.md`]) await put(root, file, (await text(root, file)).replace('- [ ] Task 1:', '- [x] Task 1:'));
  assert.equal((await inspectSessionBrief(opts(root))).status, 'stale', 'synchronized task progress revises the consumed brief');
});

it('missing native verification/design content remains a profile-aware blocker', async () => {
  const root = await fixture();
  await put(root, `${base}/verify.md`, '# Verification\n');
  assert.ok((await compileSessionBrief(opts(root))).blocked_reasons.includes('missing_verification_plan'));
  await put(root, `${base}/verify.md`, '# Verification\n\n- Run focused checks.\n');
  await put(root, '.ai-factory/sdd-policy.json', JSON.stringify({ schema: 'aifhub.sdd_policy.v1', require_design: true }));
  await put(root, `${base}/context.md`, '# Context\n');
  assert.ok((await compileSessionBrief(opts(root))).blocked_reasons.includes('missing_design_context'));
});

// Dependency-free structural contract check against the shipped schemas. This
// checks their used type/enum/required/additionalProperties/pattern vocabulary.
function assertSchema(value, schema, location = '$') {
  if (schema.type) {
    const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : Number.isInteger(value) ? 'integer' : typeof value;
    assert.ok([schema.type].flat().includes(actual), `${location}: type ${actual}`);
  }
  if (schema.enum) assert.ok(schema.enum.includes(value), `${location}: enum`);
  if (Object.hasOwn(schema, 'const')) assert.deepEqual(value, schema.const, `${location}: const`);
  if (schema.pattern && typeof value === 'string') assert.match(value, new RegExp(schema.pattern), location);
  if (Array.isArray(value) && schema.items) for (const [i, item] of value.entries()) assertSchema(item, schema.items, `${location}[${i}]`);
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of schema.required ?? []) assert.ok(Object.hasOwn(value, key), `${location}.${key}: required`);
    for (const [key, item] of Object.entries(value)) {
      const child = schema.properties?.[key];
      if (child) assertSchema(item, child, `${location}.${key}`);
      else if (schema.additionalProperties === false) assert.fail(`${location}.${key}: unknown property`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') assertSchema(item, schema.additionalProperties, `${location}.${key}`);
    }
  }
}
it('emitted context, brief, receipts, tracer and exchange conform to their public structural schemas', async () => {
  const root = await fixture(), options = opts(root);
  await compileSessionBrief(options);
  const context = await resolvePlanContext(options), status = await inspectSessionBrief({ ...options, includeBrief: true });
  const compliance = await checkPlanCompliance({ ...options, changedFiles: [] });
  await runTracer({ ...options, hypothesis: 'Contract fits', minimumVerticalPath: 'consumer -> response' });
  const tracer = JSON.parse(await text(root, `.ai-factory/state/${id}/tracer/brief.json`));
  const exchange = await exportExchangeBundle(options);
  for (const [name, value] of [['plan-context', context], ['session-brief', status.brief], ['plan-compliance', compliance.receipt], ['tracer-brief', tracer], ['exchange-bundle', exchange.bundle]]) {
    const schema = JSON.parse(await readFile(new URL(`../schemas/${name}.schema.json`, import.meta.url), 'utf8'));
    assertSchema(value, schema, name);
  }
  const missingHook = { ...status.brief };
  delete missingHook.instruction_composition_digest;
  const schema = JSON.parse(await readFile(new URL('../schemas/session-brief.schema.json', import.meta.url), 'utf8'));
  assert.throws(() => assertSchema(missingHook, schema), /instruction_composition_digest/);
});

it('migration adoption enables openspec without touching existing settings', async () => {
  const root = await fixture();
  await put(root, '.ai-factory/config.yaml', 'aifhub:\n  openspec:\n    requireDesign: true\npaths:\n  rules: project/rules\nreviews:\n  policy:\n    requireRulesPassForVerify: true\n');
  const { migrateLegacyPlan } = await import('./legacy-plan-migration.mjs');
  const migrated = await migrateLegacyPlan(id, { rootDir: root, detectOpenSpec: async () => ({ available: false }) });
  assert.equal(migrated.ok, true, JSON.stringify(migrated.errors ?? migrated.warnings));
  const config = await text(root, '.ai-factory/config.yaml');
  assert.match(config, /openspec: true/);
  assert.match(config, /requireDesign: true/);
  assert.match(config, /rules: project\/rules/);
  assert.match(config, /requireRulesPassForVerify: true/);
  assert.equal((await import('./tool-config.mjs')).parseToolConfig(config).mode, 'openspec');
});

it('classic rules walk prunes the generated subtree before recursion', async () => {
  const root = await fixture();
  await mkdir(path.join(root, '.ai-factory/rules/generated'), { recursive: true });
  for (let index = 0; index < 1200; index++) {
    await put(root, `.ai-factory/rules/generated/openspec-change-filler-${index}.md`, 'unrelated');
  }
  const compiled = await compileSessionBrief(opts(root));
  assert.equal(compiled.ok, true, JSON.stringify(compiled.errors ?? compiled));
  assert.equal((await inspectSessionBrief({ ...opts(root), includeBrief: true })).brief.sources.some(s => s.path.includes('rules/generated')), false);
});

it('resolver parses and hashes from a single read per source', async () => {
  const root = await fixture();
  const seen = new Map();
  const context = await resolvePlanContext({ ...opts(root), readSource: async (r, file) => {
    let current;
    try { current = await readFile(path.join(r, file)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; return null; }
    seen.set(file, (seen.get(file) ?? 0) + 1);
    return current;
  } });
  assert.deepEqual(context.errors, []);
  assert.equal(seen.get(parent), 1);
  const stored = context.documents.find(d => d.path === parent);
  const actual = await readFile(path.join(root, parent));
  assert.equal(stored.sha256, (await import('node:crypto')).createHash('sha256').update(actual).digest('hex'));
});

it('duplicate active headings with tab-prefixed variants are blocked', async () => {
  const root = await fixture();
  const source = await text(root, parent);
  await put(root, parent, `${source}\n##\tSummary\n\nTab variant summary text.\n`);
  const context = await resolvePlanContext(opts(root));
  assert.ok(context.errors.some(error => error.code === 'duplicate_source_section'), JSON.stringify(context.errors));
});

it('migration adoption flips an existing explicit tools mapping without duplicates', async () => {
  const root = await fixture();
  await put(root, '.ai-factory/config.yaml', 'aifhub:\n  tools:\n    openspec: false\n    hlv: false\n');
  const { migrateLegacyPlan } = await import('./legacy-plan-migration.mjs');
  const migrated = await migrateLegacyPlan(id, { rootDir: root, detectOpenSpec: async () => ({ available: false }) });
  assert.equal(migrated.ok, true, JSON.stringify(migrated.errors ?? migrated.warnings));
  const config = await text(root, '.ai-factory/config.yaml');
  assert.equal(config.match(/openspec:/g).length, 1);
  assert.match(config, /openspec: true/);
  assert.match(config, /hlv: false/);
  assert.equal((await import('./tool-config.mjs')).parseToolConfig(config).mode, 'openspec');
});
