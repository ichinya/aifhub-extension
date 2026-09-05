import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { link, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { SDD_PROFILE_MODES, selectSddProfile } from './sdd-profiles.mjs';
import { compileSessionBrief, inspectSessionBrief, parseStrictJson, sessionBriefPaths } from './session-brief.mjs';
import { buildImplementationContext, writeExecutionTrace } from './openspec-execution-context.mjs';

const roots = [];
const run = promisify(execFile);
const script = fileURLToPath(new URL('./session-brief.mjs', import.meta.url));
const change = '168-bounded-change';
const base = `openspec/changes/${change}`;
const paths = sessionBriefPaths(change);
const signals = {
  planning_mode: 'full', behavior_change: true, modules: 1, repositories: 1,
  public_api: false, data_migration: false, reversible: true, security_sensitive: false,
  architecture_novelty: false, requirements_clear: true, expected_files: 2
};
const spec = '## ADDED Requirements\n\n### Requirement: Bounded behavior\nThe system SHALL accept a valid input.\n\n#### Scenario: Valid input\n- **WHEN** input is valid\n- **THEN** return its result\n';
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
async function temp() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aifhub-sdd-'));
  roots.push(root);
  return root;
}
async function fixture(input = signals) {
  const root = await temp();
  await put(root, '.ai-factory/config.yaml', 'aifhub:\n  artifactProtocol: openspec\n  openspec:\n    useInstructionsApply: false\n');
  await put(root, `${base}/proposal.md`, proposal(input));
  await put(root, `${base}/tasks.md`, '# Tasks\n\n- [ ] 1.1 Implement behavior; verify focused regression.\n');
  await put(root, `${base}/specs/behavior/spec.md`, spec);
  return root;
}
const options = (root) => ({ rootDir: root, changeId: change });
async function exists(root, file) { return Boolean(await lstat(path.join(root, file)).catch(() => null)); }
async function snapshot(root, prefix = '') {
  const output = {};
  for (const entry of await readdir(path.join(root, prefix), { withFileTypes: true })) {
    const file = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) Object.assign(output, await snapshot(root, file));
    else if (entry.isFile()) output[file] = createHash('sha256').update(await readFile(path.join(root, file))).digest('hex');
  }
  return output;
}
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

describe('SDD planning depth and gate separation', () => {
  it('pins distinct profile IDs and unchanged public modes', () => {
    assert.deepEqual(SDD_PROFILE_MODES, { direct: 'fast', quick: 'full', standard: 'full', expanded: 'full', ultra: 'ultra', tracer: 'full', research: null });
    assert.equal('full' in SDD_PROFILE_MODES, false);
  });
  it('selects deterministic profiles from facts rather than task length or confidence', () => {
    for (const [overrides, expected] of [
      [{ planning_mode: 'fast', behavior_change: false, expected_files: 1 }, 'direct'],
      [{}, 'quick'], [{ modules: 2 }, 'standard'], [{ public_api: true, repositories: 2 }, 'expanded'],
      [{ architecture_novelty: true }, 'research'], [{ security_sensitive: true }, 'expanded'],
      [{ requirements_clear: false }, 'research'], [{ expected_files: null }, 'research']
    ]) assert.equal(selectSddProfile({ ...signals, ...overrides }).profile, expected);
    assert.equal(selectSddProfile(null).profile, 'research');
    assert.throws(() => selectSddProfile({ ...signals, confidence: 1 }), /invalid-sdd-inputs/);
    assert.throws(() => selectSddProfile({ ...signals, security_sensitive: 'false' }), /invalid-sdd-inputs/);
  });
  it('preserves mandatory checks across quick, standard, research, and stronger policy floors', () => {
    const policy = { required_gates: ['review', 'human_review', 'security'] };
    for (const overrides of [{}, { modules: 2 }, { requirements_clear: false }]) {
      assert.deepEqual(selectSddProfile({ ...signals, ...overrides }, policy).required_gates,
        ['done', 'human_review', 'project_policy', 'review', 'security', 'tests', 'verify']);
    }
    assert.equal(selectSddProfile(signals, { minimum_profile: 'expanded' }).profile, 'expanded');
    assert.ok(selectSddProfile({ ...signals, data_migration: true }).required_gates.includes('migration_rollback'));
    assert.throws(() => selectSddProfile(signals, { disable_tests: true }), /invalid-sdd-policy/);
  });
  it('does not reinterpret fast or enable ultra without the existing version gate', () => {
    assert.equal(selectSddProfile({ ...signals, planning_mode: 'fast' }).blocked_reason, 'planning_mode_mismatch');
    assert.equal(selectSddProfile({ ...signals, planning_mode: 'ultra' }).blocked_reason, 'ultra_version_required');
    assert.equal(selectSddProfile({ ...signals, planning_mode: 'ultra' }, {}, { supportsUltra: true }).implementation_allowed, true);
    assert.equal(selectSddProfile(signals).conditional_artifacts.includes('design'), true);
  });
});

describe('SessionBrief compiler and exact revision custody', () => {
  it('creates only runtime context, reproduces exact sources, and is byte/mtime idempotent', async () => {
    const root = await fixture();
    const before = await snapshot(root);
    const result = await compileSessionBrief(options(root));
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.decision.profile, 'quick');
    assert.equal(result.written, true);
    assert.equal(await exists(root, `${base}/design.md`), false);
    assert.equal(await exists(root, `.ai-factory/qa/${change}`), false);
    const after = await snapshot(root);
    for (const [file, hash] of Object.entries(before)) assert.equal(after[file], hash, file);
    assert.deepEqual(Object.keys(after).filter((file) => !(file in before)).sort(), Object.values(paths).sort());
    const status = await inspectSessionBrief({ ...options(root), includeBrief: true });
    assert.equal(status.status, 'valid');
    for (const source of status.sources) assert.equal(source.sha256, before[source.path]);
    const specRef = status.brief.context_manifest.find((item) => item.path.endsWith('specs/behavior/spec.md'));
    assert.equal(specRef.fidelity, 'full');
    assert.equal(JSON.stringify(status.brief).includes('RAW_REQUEST_CANARY'), false);
    assert.equal(JSON.stringify(status.brief).includes('The system SHALL'), false);
    assert.match(status.brief.acceptance_examples[0], /\| Given \| When \| Then \|/);
    const mtime = (await lstat(path.join(root, paths.json))).mtimeMs;
    const second = await compileSessionBrief(options(root));
    assert.equal(second.digest, result.digest);
    assert.equal(second.written, false);
    assert.equal((await lstat(path.join(root, paths.json))).mtimeMs, mtime);
    assert.deepEqual(await snapshot(root), after);
  });
  it('requires behavioral delta specs and richer design without manufacturing artifacts', async () => {
    const root = await fixture({ ...signals, modules: 3 });
    const initial = await snapshot(root);
    const result = await compileSessionBrief(options(root));
    assert.equal(result.ok, false);
    assert.ok(result.blocked_reasons.includes('missing_design'));
    assert.equal(result.decision.implementation_allowed, false);
    assert.equal(await exists(root, paths.json), false);
    assert.equal((await snapshot(root))[`${base}/proposal.md`], initial[`${base}/proposal.md`]);
    await put(root, `${base}/design.md`, '# Design\n\n## Technical Approach\nA bounded design.\n');
    assert.equal((await compileSessionBrief(options(root))).ok, true);
    await rm(path.join(root, `${base}/specs`), { recursive: true });
    const missing = await inspectSessionBrief(options(root));
    assert.equal(missing.ok, false);
    assert.ok(missing.blocked_reasons.includes('missing_delta_specs'));
  });
  it('does not force docs-only work to invent delta requirements', async () => {
    const root = await fixture({ ...signals, behavior_change: false });
    await rm(path.join(root, `${base}/specs`), { recursive: true });
    const result = await compileSessionBrief(options(root));
    assert.equal(result.ok, true);
    assert.equal(result.decision.required_artifacts.includes('delta_specs'), false);
  });
  it('blocks unresolved questions and missing facts with a research handoff', async () => {
    const root = await fixture({ ...signals, public_api: null });
    let result = await compileSessionBrief(options(root));
    assert.equal(result.decision.profile, 'research');
    assert.equal(result.owner_handoff, 'aif-explore');
    assert.equal(await exists(root, paths.json), false);
    await put(root, `${base}/proposal.md`, `${proposal()}\n## Open Questions\n\nWho owns the integration?\n`);
    result = await compileSessionBrief(options(root));
    assert.equal(result.decision.profile, 'research');
  });
  it('detects changed, added, and deleted canonical and policy inputs without status writes', async () => {
    for (const mutation of ['tasks', 'added_spec', 'base_spec', 'policy', 'rules', 'metadata']) {
      const root = await fixture();
      const compiled = await compileSessionBrief(options(root));
      const file = {
        tasks: `${base}/tasks.md`, added_spec: `${base}/specs/extra/spec.md`, base_spec: 'openspec/specs/base/spec.md',
        policy: 'REVIEW.md', rules: '.ai-factory/rules/base.md', metadata: `${base}/.openspec.yaml`
      }[mutation];
      await put(root, file, mutation === 'metadata' ? 'schema: spec-driven\n' : 'Changed exact source\n');
      const before = await snapshot(root);
      const status = await inspectSessionBrief(options(root));
      assert.equal(status.status, 'stale', mutation);
      assert.ok(status.stale_reasons.includes('source_revision_changed'));
      assert.deepEqual(await snapshot(root), before);
      const rebuilt = await compileSessionBrief(options(root));
      assert.notEqual(rebuilt.digest, compiled.digest);
      assert.equal((await inspectSessionBrief(options(root))).status, 'valid');
      if (mutation !== 'tasks') {
        await rm(path.join(root, file));
        assert.equal((await inspectSessionBrief(options(root))).status, 'stale');
      }
    }
  });
  it('binds configured rules, architecture, review policy and policy-added gates', async () => {
    const root = await fixture();
    await put(root, '.ai-factory/config.yaml', 'aifhub:\n  artifactProtocol: openspec\npaths:\n  architecture: docs/architecture.md\n  rules: rules\nreviews:\n  policy_file: docs/review.md\n');
    for (const file of ['docs/architecture.md', 'rules/base.md', 'docs/review.md']) await put(root, file, '# Project policy\n');
    await put(root, '.ai-factory/rules/generated/openspec-base.md', '# Generated source\n');
    await put(root, '.ai-factory/sdd-policy.json', JSON.stringify({ schema: 'aifhub.sdd_policy.v1', required_gates: ['human_review', 'security'] }));
    const result = await compileSessionBrief(options(root));
    assert.equal(result.ok, true);
    assert.ok(result.decision.required_gates.includes('human_review'));
    for (const file of ['docs/architecture.md', 'rules/base.md', 'docs/review.md']) assert.ok(result.sources.some((source) => source.path === file));
    assert.ok(result.sources.some((source) => source.path === '.ai-factory/rules/generated/openspec-base.md'));
  });
  it('rejects JSON/markdown/decision tampering and changed source manifests', async () => {
    for (const file of Object.values(paths)) {
      const root = await fixture();
      await compileSessionBrief(options(root));
      await put(root, file, file.endsWith('.md') ? 'Forged context' : '{}\n');
      assert.equal((await inspectSessionBrief(options(root))).ok, false, file);
      await compileSessionBrief(options(root));
      assert.equal((await inspectSessionBrief(options(root))).status, 'valid');
    }
  });
  it('uses the version resolver for ultra and preserves unresolved planning mode', async () => {
    const root = await fixture({ ...signals, planning_mode: 'ultra' });
    let result = await compileSessionBrief(options(root));
    assert.ok(result.blocked_reasons.includes('ultra_version_required'));
    await put(root, '.ai-factory.json', JSON.stringify({ version: '2.18.1' }));
    await put(root, `${base}/design.md`, '# Design\n');
    result = await compileSessionBrief(options(root));
    assert.equal(result.decision.profile, 'ultra');
    assert.equal(result.ok, true, JSON.stringify(result));
  });
  it('requires the exact consumed digest before trace writes and blocks stale implementation', async () => {
    const root = await fixture();
    const missing = await buildImplementationContext(options(root));
    assert.equal(missing.ok, false);
    assert.equal(await exists(root, `.ai-factory/qa/${change}`), false);
    const compiled = await compileSessionBrief(options(root));
    const context = await buildImplementationContext(options(root));
    assert.equal(context.ok, true);
    assert.equal(context.sessionBrief.digest, compiled.digest);
    assert.equal(context.canonicalArtifacts.proposal.content, undefined, 'compact handoff must not include the producing request');
    assert.equal(context.canonicalArtifacts.tasks.content, undefined);
    assert.equal(context.canonicalArtifacts.tasks.fidelity, 'full');
    assert.match(context.canonicalArtifacts.tasks.sha256, /^[a-f0-9]{64}$/);
    await assert.rejects(writeExecutionTrace(change, {}, { ...options(root), runId: 'missing-digest' }), /session_brief_digest_mismatch/);
    await assert.rejects(writeExecutionTrace(change, { sessionBriefDigest: '0'.repeat(64) }, options(root)), /session_brief_digest_mismatch/);
    const trace = await writeExecutionTrace(change, { summary: 'Implemented task', sessionBriefDigest: compiled.digest }, { ...options(root), runId: 'bound' });
    assert.match(await readFile(trace.path, 'utf8'), new RegExp(`Digest: ${compiled.digest}`));
    await put(root, `${base}/tasks.md`, '# New plan revision\n');
    assert.equal((await buildImplementationContext(options(root))).ok, false);
    await assert.rejects(writeExecutionTrace(change, { sessionBriefDigest: compiled.digest }, options(root)), /session_brief_not_current/);
  });
});

describe('SessionBrief safety and installed CLI contract', () => {
  it('keeps unopted projects compatible and cannot silently downgrade an existing brief to disabled', async () => {
    const root = await fixture();
    await put(root, `${base}/proposal.md`, '# Existing unopted proposal\n');
    assert.equal((await inspectSessionBrief(options(root))).status, 'disabled');
    assert.equal((await buildImplementationContext(options(root))).ok, true);
    await put(root, paths.markdown, '# Incomplete prior SessionBrief\n');
    assert.equal((await inspectSessionBrief(options(root))).status, 'blocked');
  });
  it('rejects invalid policy, unsafe context references, and malformed signal values before writes', async () => {
    for (const policy of [
      { schema: 'aifhub.sdd_policy_decision.v9' },
      { schema: 'aifhub.sdd_policy.v1', required_gates: ['skip_verify'] },
      { schema: 'aifhub.sdd_policy.v1', context_refs: ['../private.md'] },
      { schema: 'aifhub.sdd_policy.v1', context_refs: [`.ai-factory/qa/${change}/coverage.md`] },
      { schema: 'aifhub.sdd_policy.v1', context_refs: ['docs/transcript.md'] }
    ]) {
      const root = await fixture();
      await put(root, '.ai-factory/sdd-policy.json', JSON.stringify(policy));
      const before = await snapshot(root);
      assert.equal((await compileSessionBrief(options(root))).ok, false);
      assert.deepEqual(await snapshot(root), before);
    }
    const root = await fixture({ ...signals, modules: -1 });
    assert.equal((await compileSessionBrief(options(root))).errors[0].code, 'invalid-sdd-inputs');
    assert.equal(await exists(root, '.ai-factory/state'), false);
  });
  it('leaves missing and ambiguous change selection untouched', async () => {
    const root = await fixture();
    await put(root, 'openspec/changes/other/proposal.md', '# Proposal');
    const before = await snapshot(root);
    for (const opts of [{ rootDir: root, getCurrentBranch: async () => null }, { rootDir: root, changeId: 'absent' }, { rootDir: root, changeId: '../escape' }]) {
      assert.equal((await compileSessionBrief(opts)).ok, false);
      assert.deepEqual(await snapshot(root), before);
    }
    assert.equal(await exists(root, '.ai-factory/state'), false);
  });
  it('rejects duplicate decoded keys, nested duplicates, and fenced heading spoofing', async () => {
    for (const raw of ['{"a":1,"\\u0061":2}', '{"x":{"a":1,"a":2}}', '[{"a":1,"a":2}]']) assert.throws(() => parseStrictJson(raw), /duplicate_json_key/);
    const root = await fixture();
    await put(root, `${base}/proposal.md`, proposal().replace('## SDD Profile Inputs', '```markdown\n## SDD Profile Inputs') + '\n```\n');
    assert.equal((await compileSessionBrief(options(root))).decision.profile, 'research');
    await put(root, `${base}/proposal.md`, proposal() + '\n## Why\n\nDuplicate\n');
    assert.equal((await compileSessionBrief(options(root))).errors[0].code, 'duplicate_source_section');
  });
  it('rejects linked source and destination files without changing their targets', async () => {
    for (const destination of [false, true]) {
      const root = await fixture();
      const outside = await temp();
      await put(outside, 'held.md', 'Outside content');
      const file = destination ? paths.json : `${base}/design.md`;
      await mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await link(path.join(outside, 'held.md'), path.join(root, file));
      const result = await compileSessionBrief(options(root));
      assert.equal(result.ok, false);
      assert.equal(result.errors[0].code, 'unsafe_path');
      assert.equal(await readFile(path.join(outside, 'held.md'), 'utf8'), 'Outside content');
      assert.equal(await exists(root, paths.decision), false);
    }
  });
  it('rejects junction/symlink runtime directories before any outside write', async () => {
    const root = await fixture();
    const outside = await temp();
    await symlink(outside, path.join(root, '.ai-factory/state'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal((await compileSessionBrief(options(root))).ok, false);
    assert.deepEqual(await readdir(outside), []);
  });
  it('rejects secrets in selected sections and never prints raw input in diagnostics', async () => {
    const root = await fixture();
    const secret = 'sk-' + 'PRIVATE_CANARY'.repeat(4);
    await put(root, `${base}/proposal.md`, proposal().replace('Return the bounded result.', secret));
    let result;
    try { result = await run(process.execPath, [script, 'compile', '--change', change, '--json'], { cwd: root }); }
    catch (error) { result = error; }
    assert.equal(result.code, 2);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout.includes(secret), false);
    assert.equal(JSON.parse(result.stdout).errors[0].code, 'sensitive_brief_content');
    assert.equal(await exists(root, '.ai-factory/state'), false);
  });
  it('has clean JSON/exit semantics and read-only status/show even from a consumer cwd', async () => {
    const root = await fixture();
    const compiled = await run(process.execPath, [script, 'compile', '--change', change, '--json'], { cwd: root });
    assert.equal(compiled.stderr, '');
    assert.equal(JSON.parse(compiled.stdout).status, 'valid');
    const before = await snapshot(root);
    const shown = await run(process.execPath, [script, 'show', '--change', change], { cwd: root });
    assert.match(shown.stdout, /^# SessionBrief:/);
    assert.equal(shown.stdout.includes('RAW_REQUEST_CANARY'), false);
    const status = await run(process.execPath, [script, 'status', '--change', change, '--json'], { cwd: root });
    assert.equal(JSON.parse(status.stdout).brief, undefined);
    assert.deepEqual(await snapshot(root), before);
    await assert.rejects(run(process.execPath, [script, 'compile', '--change', change, '--json', '--request', 'RAW_DIAGNOSTIC_CANARY'], { cwd: root }), (error) => {
      assert.equal(error.code, 2);
      assert.equal(error.stderr, '');
      assert.equal(error.stdout.includes('RAW_DIAGNOSTIC_CANARY'), false);
      return true;
    });
  });
});
