// context-selection-overlay.test.mjs - opt-in advisory context selection overlay (#284).
// The engine always runs inside disposable temp projects (mkdtemp + realpath);
// the checkout is never written to. Fake assessors are injected through the DI
// seam; the baseline is exercised through the real read-only SessionBrief
// compiler/inspector. No network, no SDK, no keys, no paid calls. The fake
// corpus proves transport/guard/invariant behavior only — never semantic
// accuracy of a future model.
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { digest } from './workflow-state-store.mjs';
import { parseStrictJson } from './json-strict.mjs';
import { validateJsonAgainstSchema } from './json-schema-subset.mjs';
import { prepareQaManifest } from './qa-manifest.mjs';
import { qaStore } from './qa-manifest-store.mjs';
import { observeQaSnapshot } from './qa-manifest-inputs.mjs';
import { ensureRuntimeGitignore } from './runtime-gitignore.mjs';
import { compileSessionBrief, inspectSessionBrief } from './session-brief.mjs';
import {
  ASSESSMENT_LIMITS,
  BUDGET_POLICY,
  CHANGE_ID_FORM,
  CONTEXT_SELECTION_CONSUMER_ID,
  CONTEXT_SELECTION_NAMESPACE,
  CONTEXT_SELECTION_RUBRIC,
  CONTEXT_SELECTION_SCHEMA,
  CONTRACT_MODULE,
  EXCLUSION_POLICY,
  HELPER_MODULE,
  MAX_ASSESSMENT_TEXT,
  MAX_CANDIDATES,
  MAX_EVIDENCE_REFS_PER_CANDIDATE,
  MAX_PRESENTATION_BYTES,
  MAX_PRESENTATION_SECTIONS,
  PRESENTATION_POLICY,
  STATE_ROOT,
  assertOverlayInvariants,
  assembleObservation,
  baselineBindingComponents,
  buildProtectedMinimum,
  candidateDigestRecords,
  currentOverlayContext,
  normalizeAssessorFindings,
  parseContextSelectionOverlayConfigSubset,
  parseOverlayArgs,
  projectSelection,
  readCandidates,
  readContextSelectionOverlayConfig,
  runContextSelectionOverlayCommand,
  validateSelectionBinding,
  writeOverlayObservation,
} from './context-selection-overlay.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const roots = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function makeTemp(prefix) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
  roots.push(root);
  return root;
}

async function put(root, file, content) {
  const target = path.join(root, file);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
  return target;
}

async function exists(root, file) {
  return Boolean(await stat(path.join(root, file)).catch(() => null));
}

async function runCommand(root, argv, options = {}) {
  const outputs = [];
  const exitCode = await runContextSelectionOverlayCommand(argv, { rootDir: root, output: (value) => outputs.push(value), ...options });
  const text = outputs.join('');
  let value = null;
  try { value = parseStrictJson(text); } catch { value = null; }
  return { exitCode, value, text };
}

// ---------------------------------------------------------------------------
// SessionBrief seeding: a compilable OpenSpec-native change (same recipe as
// the compiler's own tests) plus the overlay config namespace.
// ---------------------------------------------------------------------------

const SDD_SIGNALS = {
  planning_mode: 'full', behavior_change: true, modules: 1, repositories: 1,
  public_api: false, data_migration: false, reversible: true, security_sensitive: false,
  architecture_novelty: false, requirements_clear: true, expected_files: 2
};
const BRIEF_SPEC = '## ADDED Requirements\n\n### Requirement: Bounded behavior\nThe system SHALL accept a valid input.\n\n#### Scenario: Valid input\n- **WHEN** input is valid\n- **THEN** return its result\n';

function briefProposal(input = SDD_SIGNALS) {
  return ['## Original Request', '', 'Overlay baseline fixture.', '',
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

async function seedBriefProject(root, { changeId = '284-overlay-fixture', config = null, design = true, proposalContent = null } = {}) {
  const base = `openspec/changes/${changeId}`;
  await put(root, '.ai-factory/config.yaml', config ?? 'aifhub:\n  artifactProtocol: openspec\n  openspec:\n    useInstructionsApply: false\n');
  await put(root, `${base}/proposal.md`, proposalContent ?? briefProposal());
  await put(root, `${base}/tasks.md`, '# Tasks\n\n- [ ] 1.1 Implement behavior; verify focused regression.\n');
  await put(root, `${base}/specs/behavior/spec.md`, BRIEF_SPEC);
  if (design) await put(root, `${base}/design.md`, '# Design\n\n## Technical Approach\nA bounded design.\n');
  await put(root, 'notes/research.md', 'Research notes describing the bounded behavior and its valid input acceptance example.\n');
  return { changeId, base };
}

async function compile(root, changeId) {
  const result = await compileSessionBrief({ rootDir: root, changeId });
  assert.equal(result.ok, true, `fixture brief must compile: ${JSON.stringify(result.blocked_reasons ?? result.errors ?? [])}`);
  return result;
}

async function readStoredBrief(root, changeId) {
  return parseStrictJson(await readFile(path.join(root, '.ai-factory', 'state', changeId, 'context', 'session-brief.json'), 'utf8'));
}

const finding = (candidateId, overrides = {}) => ({
  candidate_id: candidateId,
  status: 'included',
  scores: { relevance: 0.9, evidence_support: 0.8, contradiction: 0 },
  reason: 'matches the intent',
  limitation: null,
  evidence_refs: [],
  conflict: null,
  ...overrides,
});

const rankedAssessor = (rules) => async (input) => ({ findings: rules(input) });

// ---------------------------------------------------------------------------
// Custody and argument parsing
// ---------------------------------------------------------------------------

describe('context-selection-overlay argument custody', () => {
  it('refuses unknown, duplicate, and value-less options as typed exit-2 usage', async () => {
    const root = await makeTemp('aif-cso-args-');
    for (const [argv, code] of [
      [['--change', 'x', '--turbo'], 'invalid-usage'],
      [['--change', 'a', '--change', 'b'], 'invalid-usage'],
      [['--candidate'], 'invalid-usage'],
      [['--enabled', 'maybe'], 'invalid-usage'],
    ]) {
      const run = await runCommand(root, [...argv, '--json'], { config: { enabled: true, enabledMalformed: false, stateRoot: STATE_ROOT, qaRoot: '.ai-factory/qa', stateRootRaw: undefined, qaRootRaw: undefined, diagnostics: [] } });
      assert.equal(run.exitCode, 2);
      assert.equal(run.value.state, 'not_run');
      assert.equal(run.value.codes[0], code);
    }
  });

  it('validates change-id presence and form before any read', async () => {
    const root = await makeTemp('aif-cso-id-');
    const missing = await runCommand(root, ['--json']);
    assert.equal(missing.exitCode, 2);
    assert.deepEqual(missing.value.codes, ['missing-change']);
    const malformed = await runCommand(root, ['--change', '../escape', '--json']);
    assert.equal(malformed.exitCode, 2);
    assert.deepEqual(malformed.value.codes, ['invalid-change-id']);
    assert.equal(CHANGE_ID_FORM.test('../escape'), false);
    assert.equal(CHANGE_ID_FORM.test('valid-change'), true);
  });
});

// ---------------------------------------------------------------------------
// Closed config namespace (decision D3/D16 structural paths included)
// ---------------------------------------------------------------------------

describe('context-selection-overlay closed config namespace', () => {
  it('parses only the closed key set and reports explicit detections', () => {
    const good = parseContextSelectionOverlayConfigSubset('aifhub:\n  contextSelectionOverlay:\n    enabled: true\n');
    assert.deepEqual(good.diagnostics, []);
    assert.equal(good.value.aifhub.contextSelectionOverlay.enabled, true);
    const dirty = parseContextSelectionOverlayConfigSubset([
      'aifhub:',
      '  contextSelectionOverlay:',
      '    enabled: true',
      '    unknown: 1',
      '    enabled: false',
    ].join('\n'));
    const codes = dirty.diagnostics.map((entry) => entry.code);
    assert.ok(codes.includes('context-selection-overlay:unknown-key'));
    assert.ok(codes.includes('context-selection-overlay:duplicate-key'));
  });

  it('detects anchors, aliases, flow mappings, quoted booleans, and malformed lines', () => {
    const forms = [
      ['aifhub:\n  contextSelectionOverlay: &anchor\n    enabled: true\n', 'context-selection-overlay:anchor'],
      ['aifhub:\n  contextSelectionOverlay: *anchor\n', 'context-selection-overlay:alias'],
      ['aifhub:\n  contextSelectionOverlay: {enabled: true}\n', 'context-selection-overlay:flow-mapping'],
      ['aifhub:\n  contextSelectionOverlay:\n    enabled: "true"\n', 'context-selection-overlay:quoted-boolean'],
      ['aifhub:\n  contextSelectionOverlay:\n    enabled: true\n  - broken\n', null],
    ];
    for (const [text, expected] of forms) {
      const parsed = parseContextSelectionOverlayConfigSubset(text);
      if (expected === null) {
        assert.ok(parsed.diagnostics.some((entry) => entry.code === 'context-selection-overlay:malformed-line'), text);
      } else {
        assert.ok(parsed.diagnostics.some((entry) => entry.code === expected), text);
      }
    }
  });

  it('keeps structural paths guarded so a custom paths.state still reaches the writer refusal', async () => {
    // The exact structural keys (['aifhub'], the namespace, ['paths']) guard
    // flow/anchor/alias forms; namespace children stay closed-key guarded.
    for (const [text, code] of [
      ['aifhub:\n  contextSelectionOverlay: {enabled: true}\n', 'context-selection-overlay:flow-mapping'],
      ['paths: &a\n  state: x\n', 'context-selection-overlay:anchor'],
      ['paths: *a\n', 'context-selection-overlay:alias'],
      ['paths: {state: custom}\n', 'context-selection-overlay:flow-mapping'],
    ]) {
      const parsed = parseContextSelectionOverlayConfigSubset(text);
      assert.ok(parsed.diagnostics.some((entry) => entry.code === code), `${text} must detect ${code}`);
    }
    // A merge key under `paths` cannot inject state (anchors never expand in
    // the bounded parser), so the custom root never reaches the writer: the
    // config read keeps the default state root instead of guessing.
    const root = await makeTemp('aif-cso-struct-');
    await put(root, '.ai-factory/config.yaml', 'base: &base\n  state: custom/state\npaths:\n  <<: *base\n');
    const config = await readContextSelectionOverlayConfig(root);
    assert.equal(config.stateRoot, STATE_ROOT, 'no anchor expansion: the default root survives');
  });

  it('reads the namespace honestly: absent key defaults off, malformed forces off', async () => {
    const root = await makeTemp('aif-cso-cfg-');
    const absent = await readContextSelectionOverlayConfig(root);
    assert.equal(absent.enabled, null);
    assert.equal(absent.enabledMalformed, false);
    await put(root, '.ai-factory/config.yaml', 'aifhub:\n  contextSelectionOverlay:\n    enabled: true\npaths:\n  state: .ai-factory/state\n');
    const on = await readContextSelectionOverlayConfig(root);
    assert.equal(on.enabled, true);
    assert.equal(on.stateRoot, STATE_ROOT);
    await put(root, '.ai-factory/config.yaml', 'aifhub:\n  contextSelectionOverlay:\n    enabled: "true"\n');
    const malformed = await readContextSelectionOverlayConfig(root);
    assert.equal(malformed.enabledMalformed, true);
  });

  it('a malformed namespace keeps the overlay off even against a CLI override', async () => {
    const root = await makeTemp('aif-cso-force-');
    const { changeId } = await seedBriefProject(root, {
      config: 'aifhub:\n  artifactProtocol: openspec\n  contextSelectionOverlay:\n    enabled: "true"\n',
    });
    await compile(root, changeId);
    const run = await runCommand(root, ['--change', changeId, '--enabled', 'true', '--json']);
    assert.equal(run.exitCode, 0);
    assert.equal(run.value.state, 'not_run');
    assert.ok(run.value.codes.includes('context-selection-overlay-disabled'));
    assert.ok(run.value.codes.some((code) => String(code).startsWith('context-selection-overlay:')), 'bounded config diagnostics survive');
  });

  it('CLI precedence wins over a well-formed config key in both directions', async () => {
    const root = await makeTemp('aif-cso-pre-');
    const { changeId } = await seedBriefProject(root, {
      config: 'aifhub:\n  artifactProtocol: openspec\n  contextSelectionOverlay:\n    enabled: true\n',
    });
    await compile(root, changeId);
    const off = await runCommand(root, ['--change', changeId, '--enabled', 'false', '--json']);
    assert.equal(off.exitCode, 0);
    assert.equal(off.value.state, 'not_run');
    const assessor = rankedAssessor(() => []);
    const on = await runCommand(root, ['--change', changeId, '--json'], { assessor });
    assert.equal(on.exitCode, 0);
    assert.notEqual(on.value.state, 'not_run');
  });
});

// ---------------------------------------------------------------------------
// Fallback matrix (decision D8): never an empty context presented as success
// ---------------------------------------------------------------------------

describe('context-selection-overlay fallback matrix', () => {
  it('reports honest not_run for disabled, delegated, blocked, missing, and stale baselines', async () => {
    const root = await makeTemp('aif-cso-fb-');
    const injected = (status, extra = {}) => ({
      inspectBrief: async () => ({ ok: true, status, change_id: 'x', paths: {}, stale_reasons: [], blocked_reasons: [], errors: [], digest: null, sources: [], ...extra }),
    });
    for (const [status, code, extra] of [
      ['disabled', 'baseline-disabled', {}],
      ['delegated', 'baseline-delegated', { owner_handoff: 'aif-implement other' }],
      ['blocked', 'baseline-blocked', { blocked_reasons: ['missing_design'] }],
      ['missing', 'baseline-missing', { stale_reasons: ['missing_runtime_artifact'] }],
      ['stale', 'baseline-stale', { stale_reasons: ['source_revision_changed'] }],
    ]) {
      const run = await runCommand(root, ['--change', 'some-change', '--enabled', 'true', '--json'], injected(status, extra));
      assert.equal(run.exitCode, 0, status);
      assert.equal(run.value.state, 'not_run', status);
      assert.equal(run.value.codes[0], code, status);
      assert.equal(run.value.message, 'advisory scan was not performed', status);
    }
  });

  it('a failing baseline inspection becomes a bounded blocked refusal, never a crash', async () => {
    const root = await makeTemp('aif-cso-fb2-');
    const run = await runCommand(root, ['--change', 'x', '--enabled', 'true', '--json'], {
      inspectBrief: async () => { throw new Error('invalid-change-id'); },
    });
    assert.equal(run.exitCode, 0);
    assert.equal(run.value.codes[0], 'baseline-blocked');
  });

  it('the seeded real baselines degrade honestly: disabled tree, blocked compile, missing state, stale revision', async () => {
    const root = await makeTemp('aif-cso-fb3-');
    // A canonical change without SDD profile inputs, policy, or runtime
    // artifacts: the inspect reports `disabled` (SDD not opted in).
    const plainBase = 'openspec/changes/284-plain';
    await put(root, '.ai-factory/config.yaml', 'aifhub:\n  artifactProtocol: openspec\n  openspec:\n    useInstructionsApply: false\n');
    await put(root, `${plainBase}/proposal.md`, '# Proposal\n\n## Why\n\nNo SDD inputs here.\n');
    await put(root, `${plainBase}/tasks.md`, '# Tasks\n\n- [ ] 1.1 Task\n');
    const disabled = await runCommand(root, ['--change', '284-plain', '--enabled', 'true', '--json']);
    assert.equal(disabled.value.codes[0], 'baseline-disabled');
    // Canonical artifacts exist but the design is missing: `blocked`
    // (standard profile requires design; quick only lists it as conditional).
    const { changeId } = await seedBriefProject(root, {
      design: false,
      proposalContent: briefProposal({ ...SDD_SIGNALS, modules: 2 }),
    });
    const blocked = await runCommand(root, ['--change', changeId, '--enabled', 'true', '--json']);
    assert.equal(blocked.value.codes[0], 'baseline-blocked');
    // Compilable change whose runtime artifacts were removed: `missing`.
    const compiled = await seedBriefProject(root, { changeId: '284-gone' });
    await compile(root, compiled.changeId);
    await rm(path.join(root, '.ai-factory', 'state', compiled.changeId), { recursive: true, force: true });
    const missing = await runCommand(root, ['--change', compiled.changeId, '--enabled', 'true', '--json']);
    assert.equal(missing.value.codes[0], 'baseline-missing');
    // Compiled, then the canonical source moved on: `stale`.
    const staleSeed = await seedBriefProject(root, { changeId: '284-moved' });
    await compile(root, staleSeed.changeId);
    await put(root, `${staleSeed.base}/proposal.md`, `${briefProposal()}\n## Late Edit\n\nDrift.\n`);
    const stale = await runCommand(root, ['--change', staleSeed.changeId, '--enabled', 'true', '--json']);
    assert.equal(stale.value.codes[0], 'baseline-stale');
    for (const run of [disabled, blocked, missing, stale]) {
      assert.equal(run.exitCode, 0);
      assert.equal(run.value.state, 'not_run');
    }
  });

  it('without an injected assessor the valid-baseline run is an honest not_run, not a selection', async () => {
    const root = await makeTemp('aif-cso-noassessor-');
    const { changeId } = await seedBriefProject(root);
    await compile(root, changeId);
    const run = await runCommand(root, ['--change', changeId, '--enabled', 'true', '--candidate', 'notes/research.md', '--json']);
    assert.equal(run.exitCode, 0);
    assert.equal(run.value.state, 'not_run');
    assert.deepEqual(run.value.codes, ['assessor-unavailable']);
    assert.equal(await exists(root, `${STATE_ROOT}/${changeId}/${CONTEXT_SELECTION_NAMESPACE}`), false, 'no observation is written');
  });

  it('assessor error, timeout, and invalid output fail closed with the protected minimum verbatim and every candidate unassessed', async () => {
    const root = await makeTemp('aif-cso-fail-');
    const { changeId } = await seedBriefProject(root);
    const compiled = await compile(root, changeId);
    const brief = await readStoredBrief(root, changeId);
    const assessorError = async () => { throw new Error('provider exploded'); };
    const errorRun = await runCommand(root, ['--change', changeId, '--enabled', 'true', '--candidate', 'notes/research.md', '--json'], { assessor: assessorError });
    assert.equal(errorRun.exitCode, 0);
    assert.equal(errorRun.value.run_status, 'failed');
    assert.equal(errorRun.value.complete, false);
    assert.deepEqual(errorRun.value.candidates.map((candidate) => candidate.status), ['unassessed']);
    assert.deepEqual(errorRun.value.manifest.protected_minimum, brief.context_manifest, 'protected minimum stays verbatim on failure');
    assert.ok(errorRun.value.diagnostics.some((entry) => entry.code === 'assessor-error'));
    const assessorInvalid = async () => ({ findings: 'not-an-array' });
    const invalidRun = await runCommand(root, ['--change', changeId, '--enabled', 'true', '--candidate', 'notes/research.md', '--json'], { assessor: assessorInvalid });
    assert.equal(invalidRun.value.run_status, 'failed');
    assert.equal(invalidRun.value.candidates[0].status, 'unassessed');
    const assessorTimeout = () => new Promise(() => {});
    const timeoutRun = await runCommand(root, ['--change', changeId, '--enabled', 'true', '--candidate', 'notes/research.md', '--json'], { assessor: assessorTimeout, deadlineMs: 40 });
    // The deadline bounds the whole command: a race-settled timeout is also
    // past the pre-persistence gate, so the honest outcome is the bounded
    // not_run envelope — never a half-run write, never a fake projection.
    assert.equal(timeoutRun.exitCode, 0);
    assert.equal(timeoutRun.value.state, 'not_run');
    assert.ok(timeoutRun.value.codes.includes('deadline-exceeded'));
    assert.equal(compiled.ok, true);
  });

  it('abstain is a complete honest refusal, not a zero-findings selection', async () => {
    const root = await makeTemp('aif-cso-abstain-');
    const { changeId } = await seedBriefProject(root);
    await compile(root, changeId);
    const assessor = async () => ({ abstain: true, reason: 'not enough context' });
    const run = await runCommand(root, ['--change', changeId, '--enabled', 'true', '--candidate', 'notes/research.md', '--json'], { assessor });
    assert.equal(run.exitCode, 0);
    assert.equal(run.value.run_status, 'complete');
    assert.equal(run.value.abstained, true);
    assert.equal(run.value.complete, false);
    assert.equal(run.value.coverage.state, 'none');
    assert.equal(run.value.candidates[0].status, 'unassessed');
  });

  it('a deadline exhausted before the assessment is a bounded not_run envelope', async () => {
    const root = await makeTemp('aif-cso-deadline-');
    const { changeId } = await seedBriefProject(root);
    await compile(root, changeId);
    const run = await runCommand(root, ['--change', changeId, '--enabled', 'true', '--json'], { assessor: rankedAssessor(() => []), deadlineMs: 0 });
    assert.equal(run.exitCode, 0);
    assert.equal(run.value.codes[0], 'deadline-exceeded');
  });
});

// ---------------------------------------------------------------------------
// Happy path, closed status model, and cross-field invariants (D5/D6/D12)
// ---------------------------------------------------------------------------

describe('context-selection-overlay closed status model', () => {
  async function seeded(root) {
    const { changeId } = await seedBriefProject(root);
    await compile(root, changeId);
    return changeId;
  }

  it('produces a complete projection: included candidate, verbatim minimum, four sections', async () => {
    const root = await makeTemp('aif-cso-happy-');
    const changeId = await seeded(root);
    const brief = await readStoredBrief(root, changeId);
    const assessor = rankedAssessor((input) => input.candidates.map((candidate) => finding(candidate.candidate_id)));
    const run = await runCommand(root, ['--change', changeId, '--enabled', 'true', '--candidate', 'notes/research.md', '--json'], { assessor });
    assert.equal(run.exitCode, 0);
    const observation = run.value;
    assert.equal(observation.schema, CONTEXT_SELECTION_SCHEMA);
    assert.equal(observation.diagnostic_only, true);
    assert.deepEqual(observation.authorizes, []);
    assert.equal(observation.run_status, 'complete');
    assert.equal(observation.complete, true);
    assert.equal(observation.freshness, 'current');
    assert.equal(observation.candidates[0].status, 'included');
    assert.deepEqual(observation.manifest.protected_minimum, brief.context_manifest, 'protected minimum is the verbatim baseline manifest');
    assert.deepEqual(observation.presentation.map((section) => section.section), ['protected_minimum', 'relevant', 'conflicts', 'unresolved']);
    assert.deepEqual(observation.presentation.find((section) => section.section === 'relevant').refs, [observation.candidates[0].candidate_id]);
    assert.deepEqual(observation.presentation.find((section) => section.section === 'protected_minimum').refs, brief.context_manifest.map((entry) => entry.path));
    assert.deepEqual(observation.baseline.capsule, { digest: null }, 'v1 carries the honest null capsule digest');
    assert.equal(observation.needs_review, false);
    assert.equal(observation.owner_handoff, null);
    const schema = parseStrictJson(await readFile(path.join(REPO_ROOT, CONTRACT_MODULE), 'utf8'));
    assert.deepEqual(validateJsonAgainstSchema(observation, schema), []);
  });

  it('assigns deterministic sorted candidate ids independent of CLI order', async () => {
    const root = await makeTemp('aif-cso-ids-');
    const changeId = await seeded(root);
    await put(root, 'notes/aaa.md', 'Alpha notes about the bounded behavior.\n');
    await put(root, 'notes/zzz.md', 'Zulu notes about the bounded behavior.\n');
    const assessor = rankedAssessor((input) => input.candidates.map((candidate) => finding(candidate.candidate_id)));
    const first = await runCommand(root, ['--change', changeId, '--enabled', 'true', '--candidate', 'notes/aaa.md', '--candidate', 'notes/zzz.md', '--json'], { assessor });
    const second = await runCommand(root, ['--change', changeId, '--enabled', 'true', '--candidate', 'notes/zzz.md', '--candidate', 'notes/aaa.md', '--json'], { assessor });
    assert.deepEqual(first.value.candidates.map((candidate) => [candidate.candidate_id, candidate.path]),
      second.value.candidates.map((candidate) => [candidate.candidate_id, candidate.path]));
    assert.deepEqual(first.value.candidates.map((candidate) => candidate.path), ['notes/aaa.md', 'notes/zzz.md']);
    assert.equal(first.value.binding, second.value.binding);
  });

  it('keeps excluded assessments exhaustive: reason plus limitation and an unresolved tail', async () => {
    const root = await makeTemp('aif-cso-excl-');
    const changeId = await seeded(root);
    await put(root, 'notes/off-topic.md', 'Completely unrelated material about garden plants.\n');
    const assessor = rankedAssessor((input) => input.candidates.map((candidate) => candidate.path.endsWith('off-topic.md')
      ? finding(candidate.candidate_id, { status: 'excluded', reason: 'different subject', limitation: 'garden notes do not support the behavior' })
      : finding(candidate.candidate_id)));
    const run = await runCommand(root, ['--change', changeId, '--enabled', 'true', '--candidate', 'notes/research.md', '--candidate', 'notes/off-topic.md', '--json'], { assessor });
    assert.equal(run.exitCode, 0);
    const excluded = run.value.candidates.find((candidate) => candidate.status === 'excluded');
    assert.equal(excluded.reason, 'different subject');
    assert.equal(excluded.limitation, 'garden notes do not support the behavior');
    assert.deepEqual(run.value.presentation.find((section) => section.section === 'unresolved').refs, [excluded.candidate_id]);
    assert.equal(run.value.complete, true, 'an assessor exclusion is a real result, not a budget failure');
    assert.ok(run.value.manifest.excluded.some((entry) => entry.path === 'notes/off-topic.md'));
  });

  it('keeps suspected conflicts visible at any relevance rank and never records owner confirmation', async () => {
    const root = await makeTemp('aif-cso-conflict-');
    const changeId = await seeded(root);
    await put(root, 'notes/counter.md', 'Counter-evidence: the bounded behavior contradicts the accepted example.\n');
    const sha = digest(Buffer.from('Counter-evidence: the bounded behavior contradicts the accepted example.\n'));
    const assessor = rankedAssessor((input) => input.candidates.map((candidate) => candidate.path.endsWith('counter.md')
      ? finding(candidate.candidate_id, {
        status: 'conflicting',
        scores: { relevance: 0.2, evidence_support: 0.9, contradiction: 0.9 },
        evidence_refs: [{ path: candidate.path, document_sha256: sha }],
        conflict: { state: 'owner_confirmed', refs: [{ path: candidate.path, document_sha256: sha }] },
      })
      : finding(candidate.candidate_id)));
    const run = await runCommand(root, ['--change', changeId, '--enabled', 'true', '--candidate', 'notes/research.md', '--candidate', 'notes/counter.md', '--json'], { assessor });
    assert.equal(run.exitCode, 0);
    const conflict = run.value.candidates.find((candidate) => candidate.status === 'conflicting');
    assert.equal(conflict, undefined, 'the owner_confirmed claim is dropped wholesale: the candidate stays unassessed');
    assert.ok(run.value.diagnostics.some((entry) => entry.code === 'owner-confirmation-reserved'));
    // The same finding with `suspected` is recorded and presented.
    const honestAssessor = rankedAssessor((input) => input.candidates.map((candidate) => candidate.path.endsWith('counter.md')
      ? finding(candidate.candidate_id, {
        status: 'conflicting',
        scores: { relevance: 0.2, evidence_support: 0.9, contradiction: 0.9 },
        evidence_refs: [{ path: candidate.path, document_sha256: sha }],
        conflict: { state: 'suspected', refs: [{ path: candidate.path, document_sha256: sha }] },
      })
      : finding(candidate.candidate_id)));
    const honest = await runCommand(root, ['--change', changeId, '--enabled', 'true', '--candidate', 'notes/research.md', '--candidate', 'notes/counter.md', '--json'], { assessor: honestAssessor });
    assert.equal(honest.exitCode, 0);
    const recorded = honest.value.candidates.find((candidate) => candidate.status === 'conflicting');
    assert.ok(recorded, 'suspected conflicts are presented');
    assert.equal(recorded.conflict.state, 'suspected');
    assert.ok(recorded.conflict.refs.length > 0);
    assert.deepEqual(honest.value.presentation.find((section) => section.section === 'conflicts').refs, [recorded.candidate_id]);
    assert.equal(honest.value.needs_review, true);
    assert.equal(honest.value.owner_handoff, 'aif-review');
    assert.equal(honest.value.complete, true, 'a fitting conflict does not break the AND model');
    const schema = parseStrictJson(await readFile(path.join(REPO_ROOT, CONTRACT_MODULE), 'utf8'));
    assert.deepEqual(validateJsonAgainstSchema(honest.value, schema), []);
  });

  it('drops findings outside the closed shape: unknown ids, duplicates, ref-less conflicts, invalid scores', async () => {
    const root = await makeTemp('aif-cso-drop-');
    const changeId = await seeded(root);
    await put(root, 'notes/second.md', 'Second research fragment about the bounded behavior.\n');
    const assessor = rankedAssessor(() => [
      finding('cand-99'),
      finding('cand-0'),
      finding('cand-0'),
      // A ref-less conflict on a fresh candidate: dropped, candidate unassessed.
      { candidate_id: 'cand-1', status: 'conflicting', conflict: { state: 'suspected', refs: [] }, scores: null, reason: null, limitation: null, evidence_refs: [] },
      // Out-of-range scores on the still-unassessed tail: dropped again.
      { candidate_id: 'cand-1', status: 'included', scores: { relevance: 7, evidence_support: 'high', contradiction: null }, reason: 'x', limitation: null, evidence_refs: [] },
    ]);
    const run = await runCommand(root, ['--change', changeId, '--enabled', 'true', '--candidate', 'notes/research.md', '--candidate', 'notes/second.md', '--json'], { assessor });
    assert.equal(run.exitCode, 0);
    const codes = run.value.diagnostics.map((entry) => entry.code);
    assert.ok(codes.includes('unknown-candidate-reference'));
    assert.ok(codes.includes('duplicate-candidate-assessment'));
    assert.ok(codes.includes('conflict-without-refs'));
    assert.ok(codes.includes('invalid-assessment'));
    const byPath = new Map(run.value.candidates.map((candidate) => [candidate.path, candidate]));
    assert.equal(byPath.get('notes/research.md').status, 'included', 'keep-first wins for duplicated ids');
    assert.equal(byPath.get('notes/second.md').status, 'unassessed', 'every dropped finding leaves its candidate unassessed');
  });

  it('missing, malformed, and over-limit candidates stay unassessed with coverage evidence', async () => {
    const root = await makeTemp('aif-cso-sources-');
    const changeId = await seeded(root);
    await put(root, 'notes/broken.md', Buffer.from([0xff, 0xfe, 0x00, 0x01]));
    await put(root, 'notes/big.md', 'x'.repeat(1024 * 1024 + 1));
    const assessor = rankedAssessor((input) => input.candidates.map((candidate) => finding(candidate.candidate_id)));
    const run = await runCommand(root, ['--change', changeId, '--enabled', 'true',
      '--candidate', 'notes/ghost.md', '--candidate', 'notes/broken.md', '--candidate', 'notes/big.md', '--candidate', 'notes/research.md', '--json'], { assessor });
    assert.equal(run.exitCode, 0);
    const byPath = new Map(run.value.candidates.map((candidate) => [candidate.path, candidate]));
    assert.equal(byPath.get('notes/ghost.md').status, 'unassessed');
    assert.equal(byPath.get('notes/ghost.md').kind, 'missing');
    assert.equal(byPath.get('notes/broken.md').kind, 'malformed');
    assert.equal(byPath.get('notes/big.md').kind, 'truncated');
    for (const pathName of ['notes/ghost.md', 'notes/broken.md', 'notes/big.md']) {
      assert.equal(byPath.get(pathName).scores, null);
      assert.ok(run.value.coverage.missing_sources.some((entry) => entry.path === pathName));
    }
    assert.equal(run.value.coverage.state, 'partial');
    assert.equal(run.value.complete, false);
    assert.equal(run.value.run_status, 'complete', 'partial success keeps the assessed candidate');
    assert.equal(byPath.get('notes/research.md').status, 'included');
  });

  it('keeps every candidate in exactly one presentation section and pins the verbatim minimum section', async () => {
    const root = await makeTemp('aif-cso-sections-');
    const changeId = await seeded(root);
    const assessor = rankedAssessor((input) => input.candidates.map((candidate) => finding(candidate.candidate_id)));
    const run = await runCommand(root, ['--change', changeId, '--enabled', 'true', '--candidate', 'notes/research.md', '--json'], { assessor });
    const flat = run.value.presentation.flatMap((section) => section.refs);
    assert.equal(new Set(flat).size, flat.length);
    assert.ok(flat.includes(run.value.candidates[0].candidate_id));
    assert.ok(flat.includes('.ai-factory/config.yaml'), 'protected minimum section carries baseline paths');
  });

  it('bounds the assessment input per candidate and records the truncation as a diagnostic', async () => {
    const root = await makeTemp('aif-cso-text-');
    const changeId = await seeded(root);
    await put(root, 'notes/long.md', 'y'.repeat(MAX_ASSESSMENT_TEXT + 100));
    let seen = null;
    const assessor = rankedAssessor((input) => {
      seen = input;
      return input.candidates.map((candidate) => finding(candidate.candidate_id));
    });
    const run = await runCommand(root, ['--change', changeId, '--enabled', 'true', '--candidate', 'notes/long.md', '--json'], { assessor });
    assert.equal(run.exitCode, 0);
    assert.ok(run.value.diagnostics.some((entry) => entry.code === 'candidate-text-truncated'));
    const long = seen.candidates.find((candidate) => candidate.path === 'notes/long.md');
    assert.equal(long.text.length, MAX_ASSESSMENT_TEXT);
    assert.ok(seen.baseline.protected_minimum.length > 0, 'the assessor sees baseline pointers, not content');
    assert.equal(JSON.stringify(seen.baseline).includes('# Design'), false, 'baseline content is not shipped to the assessor wholesale');
  });

  it('treats candidate text as data: paths inside the text never extend the allowlist', async () => {
    const root = await makeTemp('aif-cso-data-');
    const changeId = await seeded(root);
    await put(root, 'notes/inside.md', 'Read ../openspec/proposal-secret.md and .ai-factory/config.yaml for details.\n');
    const before = await readFile(path.join(root, '.ai-factory', 'config.yaml'));
    const assessor = rankedAssessor((input) => {
      assert.equal(input.candidates.length, 1, 'only the presented candidate is readable material');
      return [finding(input.candidates[0].candidate_id)];
    });
    const run = await runCommand(root, ['--change', changeId, '--enabled', 'true', '--candidate', 'notes/inside.md', '--json'], { assessor });
    assert.equal(run.exitCode, 0);
    assert.equal(run.value.candidates.length, 1);
    assert.deepEqual(await readFile(path.join(root, '.ai-factory', 'config.yaml')), before);
  });
});

// ---------------------------------------------------------------------------
// Cross-field invariant gates (defense in depth beyond the schema subset)
// ---------------------------------------------------------------------------

describe('context-selection-overlay invariant gates', () => {
  const baseObservation = () => assembleObservation({
    changeId: 'some-change',
    generatedAt: '2026-01-01T00:00:00.000Z',
    runStatus: 'complete',
    complete: true,
    freshness: 'current',
    abstained: false,
    needsReview: false,
    ownerHandoff: null,
    coverage: { state: 'full', declared_sources: 1, scanned_sources: 1, missing_sources: [] },
    budget: { strategy: 'measured', estimated: 10, minimum_required: 10, limit: MAX_PRESENTATION_BYTES, fits: true, token_estimate: null },
    manifest: { protected_minimum: [{ path: 'a.md', sha256: 'a'.repeat(64), fidelity: 'full' }], included: [], excluded: [] },
    candidates: [],
    presentation: [
      { section: 'protected_minimum', refs: ['a.md'] },
      { section: 'relevant', refs: [] },
      { section: 'conflicts', refs: [] },
      { section: 'unresolved', refs: [] },
    ],
    baseline: baselineBindingComponents({ digest: 'a'.repeat(64), source_revision: 'a'.repeat(64), policy_revision: 'a'.repeat(64), scope_fingerprint: 'a'.repeat(64), plan_context: { source_revision: null }, instruction_composition_digest: null }),
    candidateDigests: [],
    context: {
      rubric: { ...CONTEXT_SELECTION_RUBRIC },
      exclusionPolicy: { ...EXCLUSION_POLICY },
      presentationPolicy: { ...PRESENTATION_POLICY },
      engine: { module: 'e', sha256: 'a'.repeat(64) },
      helper: { module: 'h', sha256: 'a'.repeat(64) },
      contract: { name: CONTEXT_SELECTION_SCHEMA, sha256: 'a'.repeat(64) },
      assessmentLimits: { ...ASSESSMENT_LIMITS },
      budgetPolicy: { ...BUDGET_POLICY },
    },
    language: 'en',
    worktreeIdentity: 'a'.repeat(64),
    binding: 'b'.repeat(64),
    diagnostics: [],
  });

  it('accepts the well-formed empty projection', () => {
    assertOverlayInvariants(baseObservation());
  });

  it('rejects a non-complete run that still carries assessments', () => {
    const tampered = baseObservation();
    tampered.run_status = 'failed';
    tampered.complete = false;
    tampered.candidates = [{ candidate_id: 'cand-0', path: 'x.md', sha256: null, bytes: 0, kind: 'missing', status: 'included', scores: null, reason: null, limitation: null, evidence_refs: [], conflict: null }];
    assert.throws(() => assertOverlayInvariants(tampered), /unassessed/);
  });

  it('rejects a complete flag that disagrees with the AND model', () => {
    const tampered = baseObservation();
    tampered.complete = false;
    assert.throws(() => assertOverlayInvariants(tampered), /AND model/);
    const overclaimed = baseObservation();
    overclaimed.budget.fits = false;
    assert.throws(() => assertOverlayInvariants(overclaimed), /AND model|non-fitting/);
  });

  it('rejects conflicting candidates without exact refs and any recorded owner confirmation', () => {
    const withConflict = baseObservation();
    withConflict.candidates = [{
      candidate_id: 'cand-0', path: 'x.md', sha256: 'a'.repeat(64), bytes: 5, kind: 'file', status: 'conflicting',
      scores: { relevance: 0.1, evidence_support: 0.9, contradiction: 0.9 }, reason: null, limitation: null,
      evidence_refs: [{ path: 'x.md', document_sha256: 'a'.repeat(64) }],
      conflict: { state: 'suspected', refs: [] },
    }];
    withConflict.presentation.find((section) => section.section === 'conflicts').refs.push('cand-0');
    assert.throws(() => assertOverlayInvariants(withConflict), /conflict refs/);
    const confirmed = baseObservation();
    confirmed.candidates = [{
      candidate_id: 'cand-0', path: 'x.md', sha256: 'a'.repeat(64), bytes: 5, kind: 'file', status: 'conflicting',
      scores: null, reason: null, limitation: null,
      evidence_refs: [{ path: 'x.md', document_sha256: 'a'.repeat(64) }],
      conflict: { state: 'owner_confirmed', refs: [{ path: 'x.md', document_sha256: 'a'.repeat(64) }] },
    }];
    confirmed.presentation.find((section) => section.section === 'conflicts').refs.push('cand-0');
    assert.throws(() => assertOverlayInvariants(confirmed), /suspected/);
  });

  it('rejects excluded candidates without reason and limitation, and unassessed candidates with scores', () => {
    const missingReason = baseObservation();
    // An assessor exclusion with an empty reason breaks the closed model
    // even though the AND completeness is unaffected.
    missingReason.candidates = [{ candidate_id: 'cand-0', path: 'x.md', sha256: 'a'.repeat(64), bytes: 5, kind: 'file', status: 'excluded', scores: null, reason: null, limitation: null, evidence_refs: [], conflict: null }];
    missingReason.presentation.find((section) => section.section === 'unresolved').refs.push('cand-0');
    assert.throws(() => assertOverlayInvariants(missingReason), /reason and a limitation/);
    const scored = baseObservation();
    scored.complete = false;
    scored.abstained = true;
    scored.coverage.state = 'none';
    scored.candidates = [{ candidate_id: 'cand-0', path: 'x.md', sha256: 'a'.repeat(64), bytes: 5, kind: 'file', status: 'unassessed', scores: { relevance: 0.5, evidence_support: null, contradiction: null }, reason: null, limitation: null, evidence_refs: [], conflict: null }];
    scored.presentation.find((section) => section.section === 'unresolved').refs.push('cand-0');
    assert.throws(() => assertOverlayInvariants(scored), /scores/);
  });

  it('rejects duplicate presentation sections and candidates in more than one section', () => {
    const duplicateSection = baseObservation();
    duplicateSection.presentation = [
      { section: 'protected_minimum', refs: ['a.md'] },
      { section: 'relevant', refs: [] },
      { section: 'relevant', refs: [] },
      { section: 'unresolved', refs: [] },
    ];
    assert.throws(() => assertOverlayInvariants(duplicateSection), /duplicate presentation/);
    const split = baseObservation();
    split.candidates = [{ candidate_id: 'cand-0', path: 'x.md', sha256: 'a'.repeat(64), bytes: 5, kind: 'file', status: 'included', scores: null, reason: null, limitation: null, evidence_refs: [], conflict: null }];
    split.presentation.find((section) => section.section === 'relevant').refs.push('cand-0');
    split.presentation.find((section) => section.section === 'unresolved').refs.push('cand-0');
    assert.throws(() => assertOverlayInvariants(split), /more than one presentation section|missing from/);
  });

  it('rejects a protected_minimum section that no longer mirrors the baseline manifest', () => {
    const drifted = baseObservation();
    drifted.presentation.find((section) => section.section === 'protected_minimum').refs.push('extra.md');
    assert.throws(() => assertOverlayInvariants(drifted), /verbatim baseline manifest|does not resolve/);
  });

  it('rejects an abstention that still carries scores or coverage', () => {
    const abstained = baseObservation();
    abstained.abstained = true;
    abstained.complete = false;
    abstained.coverage.state = 'none';
    abstained.candidates = [{ candidate_id: 'cand-0', path: 'x.md', sha256: 'a'.repeat(64), bytes: 5, kind: 'file', status: 'unassessed', scores: { relevance: null, evidence_support: null, contradiction: null }, reason: null, limitation: null, evidence_refs: [], conflict: null }];
    abstained.presentation.find((section) => section.section === 'unresolved').refs.push('cand-0');
    assert.throws(() => assertOverlayInvariants(abstained), /scores|selection-free/);
  });

  it('the engine binding never contains volatile keys (helper throw semantics)', async () => {
    const { buildAssessmentBinding } = await import('./typed-assessment.mjs');
    const root = await makeTemp('aif-cso-volatile-');
    const { changeId } = await seedBriefProject(root);
    await compile(root, changeId);
    const brief = await readStoredBrief(root, changeId);
    const context = await currentOverlayContext();
    const parts = {
      consumer: CONTEXT_SELECTION_CONSUMER_ID,
      worktree_identity: 'a'.repeat(64),
      change_id: changeId,
      baseline: baselineBindingComponents(brief),
      candidate_digests: candidateDigestRecords([]),
      candidate_payload_digest: 'a'.repeat(64),
      rubric: context.rubric,
      exclusion_policy: context.exclusionPolicy,
      presentation_policy: context.presentationPolicy,
      engine: context.engine,
      helper: context.helper,
      contract: context.contract,
      language_options: { override: null, resolved: 'en' },
      assessment_limits: context.assessmentLimits,
      budget_policy: context.budgetPolicy,
      // Volatile material must never be added by a future edit: the helper
      // throws instead of stripping (decision: throw semantics).
      generated_at: '2026-01-01T00:00:00.000Z',
    };
    assert.throws(() => buildAssessmentBinding(parts), /volatile key generated_at/);
    delete parts.generated_at;
    const binding = buildAssessmentBinding(parts);
    assert.equal(binding, buildAssessmentBinding({ ...parts, worktree_identity: 'a'.repeat(64) }));
  });
});

// ---------------------------------------------------------------------------
// Budget (decision D7): measured bytes, fail-closed, exhaustive demotion tail
// ---------------------------------------------------------------------------

describe('context-selection-overlay budget', () => {
  it('fails closed when the protected minimum alone exceeds the presentation budget', async () => {
    const root = await makeTemp('aif-cso-oversize-');
    const big = 'P'.repeat(1100 * 1024);
    const { changeId } = await seedBriefProject(root, { proposalContent: `${briefProposal()}\n${big}\n` });
    await compile(root, changeId);
    const brief = await readStoredBrief(root, changeId);
    const assessor = rankedAssessor((input) => input.candidates.map((candidate) => finding(candidate.candidate_id)));
    const run = await runCommand(root, ['--change', changeId, '--enabled', 'true', '--candidate', 'notes/research.md', '--json'], { assessor });
    assert.equal(run.exitCode, 0);
    assert.equal(run.value.run_status, 'failed');
    assert.equal(run.value.complete, false);
    assert.equal(run.value.budget.fits, false);
    assert.ok(run.value.diagnostics.some((entry) => entry.code === 'protected-minimum-oversize'));
    assert.deepEqual(run.value.manifest.protected_minimum, brief.context_manifest, 'the minimum stays verbatim even when it cannot fit');
    assert.equal(run.value.candidates[0].status, 'unassessed');
    assert.equal(await exists(root, `${STATE_ROOT}/${changeId}/${CONTEXT_SELECTION_NAMESPACE}`), false, 'no silent truncation is ever written');
  });

  it('demotes a candidate that does not fit with an explicit exhaustive tail, never silently', async () => {
    const root = await makeTemp('aif-cso-demote-');
    const { changeId } = await seedBriefProject(root);
    await compile(root, changeId);
    const brief = await readStoredBrief(root, changeId);
    const remaining = MAX_PRESENTATION_BYTES - brief.budget.source_bytes;
    await put(root, 'notes/first.md', '1'.repeat(Math.max(1, Math.floor(remaining * 0.6))));
    await put(root, 'notes/second.md', '2'.repeat(Math.max(1, Math.floor(remaining * 0.6))));
    const assessor = rankedAssessor((input) => input.candidates.map((candidate, index) => finding(candidate.candidate_id, { scores: { relevance: 1 - index * 0.1, evidence_support: 0.8, contradiction: 0 } })));
    const run = await runCommand(root, ['--change', changeId, '--enabled', 'true', '--candidate', 'notes/first.md', '--candidate', 'notes/second.md', '--json'], { assessor });
    assert.equal(run.exitCode, 0);
    const statuses = new Map(run.value.candidates.map((candidate) => [candidate.path, candidate]));
    assert.equal(statuses.get('notes/first.md').status, 'included');
    const demoted = statuses.get('notes/second.md');
    assert.equal(demoted.status, 'excluded');
    assert.equal(demoted.reason, 'presentation-budget-exceeded');
    assert.ok(demoted.limitation, 'the demotion records its own exhaustive limitation');
    assert.equal(run.value.complete, false);
    assert.equal(run.value.coverage.state, 'partial');
    assert.equal(run.value.run_status, 'complete');
    assert.ok(run.value.manifest.excluded.some((entry) => entry.path === 'notes/second.md'));
  });

  it('keeps conflicts presentable as refs-only with review handoff when the metadata no longer fits', async () => {
    const root = await makeTemp('aif-cso-refsonly-');
    const { changeId } = await seedBriefProject(root);
    await compile(root, changeId);
    const brief = await readStoredBrief(root, changeId);
    const remaining = MAX_PRESENTATION_BYTES - brief.budget.source_bytes;
    await put(root, 'notes/filler.md', 'F'.repeat(Math.max(2, remaining - 40)));
    await put(root, 'notes/counter.md', 'C'.repeat(64));
    const sha = digest(Buffer.from('C'.repeat(64)));
    const assessor = rankedAssessor((input) => {
      const filler = input.candidates.find((candidate) => candidate.path === 'notes/filler.md');
      const counter = input.candidates.find((candidate) => candidate.path === 'notes/counter.md');
      return [
        finding(filler.candidate_id),
        finding(counter.candidate_id, {
          status: 'conflicting',
          scores: { relevance: 0.3, evidence_support: 0.9, contradiction: 1 },
          evidence_refs: [{ path: counter.path, document_sha256: sha }],
          conflict: { state: 'suspected', refs: [{ path: counter.path, span: { start: 0, end: 32 }, document_sha256: sha, span_sha256: digest(Buffer.from('C'.repeat(32))) }] },
        }),
      ];
    });
    const run = await runCommand(root, ['--change', changeId, '--enabled', 'true', '--candidate', 'notes/filler.md', '--candidate', 'notes/counter.md', '--json'], { assessor });
    assert.equal(run.exitCode, 0);
    const conflict = run.value.candidates.find((candidate) => candidate.status === 'conflicting');
    assert.ok(conflict, 'the conflict is never demoted away');
    assert.deepEqual(run.value.presentation.find((section) => section.section === 'conflicts').refs, [conflict.candidate_id]);
    assert.equal(run.value.needs_review, true);
    assert.equal(run.value.owner_handoff, 'aif-review');
    assert.equal(run.value.complete, false);
    assert.equal(run.value.coverage.state, 'partial');
    assert.ok(run.value.diagnostics.some((entry) => entry.code === 'conflict-evidence-refs-only'));
  });

  it('counts measured bytes only and pins the projection in the manifest', async () => {
    const root = await makeTemp('aif-cso-bytes-');
    const { changeId } = await seedBriefProject(root);
    await compile(root, changeId);
    const brief = await readStoredBrief(root, changeId);
    const assessor = rankedAssessor((input) => input.candidates.map((candidate) => finding(candidate.candidate_id)));
    const run = await runCommand(root, ['--change', changeId, '--enabled', 'true', '--candidate', 'notes/research.md', '--json'], { assessor });
    assert.equal(run.value.budget.strategy, 'measured');
    assert.equal(run.value.budget.token_estimate, null, 'no token estimate exists in v1');
    assert.equal(run.value.budget.minimum_required, brief.budget.source_bytes, 'the minimum is the measured baseline bytes');
    assert.ok(run.value.budget.estimated >= run.value.budget.minimum_required);
    assert.deepEqual(run.value.manifest.included, [{ path: 'notes/research.md', sha256: run.value.candidates[0].sha256, bytes: run.value.candidates[0].bytes }]);
  });
});

// ---------------------------------------------------------------------------
// Composite binding and stale-by-hash revalidation (decision D9)
// ---------------------------------------------------------------------------

describe('context-selection-overlay binding and revalidation', () => {
  it('records a stable binding whose components carry the copy-through baseline', async () => {
    const root = await makeTemp('aif-cso-bind-');
    const { changeId } = await seedBriefProject(root);
    await compile(root, changeId);
    const brief = await readStoredBrief(root, changeId);
    const assessor = rankedAssessor((input) => input.candidates.map((candidate) => finding(candidate.candidate_id)));
    const run = await runCommand(root, ['--change', changeId, '--enabled', 'true', '--candidate', 'notes/research.md', '--json'], { assessor });
    const observation = run.value;
    assert.equal(observation.baseline.digest, brief.digest);
    assert.equal(observation.baseline.source_revision, brief.source_revision);
    assert.equal(observation.baseline.policy_revision, brief.policy_revision);
    assert.equal(observation.baseline.scope_fingerprint, brief.scope_fingerprint);
    assert.equal(observation.baseline.plan_context_source_revision, brief.plan_context.source_revision);
    assert.equal(observation.baseline.instruction_composition_digest, brief.instruction_composition_digest ?? null);
    assert.deepEqual(observation.candidate_digests, [{ path: 'notes/research.md', sha256: observation.candidates[0].sha256, bytes: observation.candidates[0].bytes }]);
    assert.match(observation.binding, /^[a-f0-9]{64}$/);
    assert.match(observation.worktree_identity, /^[a-f0-9]{64}$/);
    const verdict = await validateSelectionBinding(root, observation);
    assert.deepEqual(verdict, { ok: true, stale: false, mismatched: [], state: null });
  });

  it('names a drifted candidate field and marks the recorded observation stale', async () => {
    const root = await makeTemp('aif-cso-stale1-');
    const { changeId } = await seedBriefProject(root);
    await compile(root, changeId);
    const assessor = rankedAssessor((input) => input.candidates.map((candidate) => finding(candidate.candidate_id)));
    const run = await runCommand(root, ['--change', changeId, '--enabled', 'true', '--candidate', 'notes/research.md', '--json'], { assessor });
    const observation = run.value;
    assert.equal((await validateSelectionBinding(root, observation)).stale, false);
    await put(root, 'notes/research.md', 'Rewritten research notes with completely different content.\n');
    const verdict = await validateSelectionBinding(root, observation);
    assert.equal(verdict.stale, true);
    assert.equal(verdict.state, 'stale-observation');
    assert.ok(verdict.mismatched.includes('candidate_digests:notes/research.md'));
    // A vanished candidate is drift too.
    await rm(path.join(root, 'notes', 'research.md'), { force: true });
    const vanished = await validateSelectionBinding(root, observation);
    assert.equal(vanished.stale, true);
    assert.ok(vanished.mismatched.includes('candidate_digests:notes/research.md'));
  });

  it('names the drifted baseline field after a recompile and detects assessment tampering', async () => {
    const root = await makeTemp('aif-cso-stale2-');
    const { changeId, base } = await seedBriefProject(root);
    await compile(root, changeId);
    const assessor = rankedAssessor((input) => input.candidates.map((candidate) => finding(candidate.candidate_id)));
    const run = await runCommand(root, ['--change', changeId, '--enabled', 'true', '--candidate', 'notes/research.md', '--json'], { assessor });
    const observation = run.value;
    await put(root, `${base}/proposal.md`, `${briefProposal()}\n## Late Change\n\nNew acceptance context.\n`);
    await compile(root, changeId);
    const verdict = await validateSelectionBinding(root, observation);
    assert.equal(verdict.stale, true);
    assert.ok(verdict.mismatched.some((field) => field.startsWith('baseline:')), 'the drift names the baseline component');
    // A tampered recorded projection flips the payload digest but nothing
    // else: the binding names the edited candidate payload.
    const tampered = structuredClone(observation);
    tampered.candidates[0].scores.relevance = 0.1;
    const payloadVerdict = await validateSelectionBinding(root, tampered);
    assert.equal(payloadVerdict.stale, true);
    assert.ok(payloadVerdict.mismatched.includes('candidate_payload') || payloadVerdict.mismatched.includes('binding'));
    // A fabricated engine revision is named as well.
    const engineTampered = structuredClone(observation);
    engineTampered.engine.sha256 = 'f'.repeat(64);
    const engineVerdict = await validateSelectionBinding(root, engineTampered);
    assert.ok(engineVerdict.mismatched.includes('engine'));
  });

  it('refuses a structurally invalid or schema-violating recorded observation outright', async () => {
    const root = await makeTemp('aif-cso-invalid-');
    const { changeId } = await seedBriefProject(root);
    await compile(root, changeId);
    const assessor = rankedAssessor((input) => input.candidates.map((candidate) => finding(candidate.candidate_id)));
    const run = await runCommand(root, ['--change', changeId, '--enabled', 'true', '--candidate', 'notes/research.md', '--json'], { assessor });
    const wrongSchema = { ...run.value, schema: 'aifhub.other.v1' };
    assert.equal((await validateSelectionBinding(root, wrongSchema)).code, 'observation-invalid');
    const confirmed = structuredClone(run.value);
    confirmed.candidates[0].status = 'conflicting';
    confirmed.candidates[0].conflict = { state: 'owner_confirmed', refs: [{ path: 'x', document_sha256: 'a'.repeat(64) }] };
    assert.equal((await validateSelectionBinding(root, confirmed)).code, 'observation-invalid', 'a recorded owner confirmation is tampering, never revalidated');
    const broken = structuredClone(run.value);
    broken.candidates[0].status = 'unassessed';
    broken.candidates[0].scores = null;
    broken.presentation.find((section) => section.section === 'relevant').refs = [];
    assert.equal((await validateSelectionBinding(root, broken)).code, 'observation-invalid');
  });
});

// ---------------------------------------------------------------------------
// Baseline invariance (decision D10): the overlay never touches the baseline
// ---------------------------------------------------------------------------

describe('context-selection-overlay baseline invariance', () => {
  it('leaves the baseline artifacts byte- and mtime-identical across on and off runs', async () => {
    const root = await makeTemp('aif-cso-invar-');
    const { changeId } = await seedBriefProject(root);
    await compile(root, changeId);
    const artifacts = [
      `.ai-factory/state/${changeId}/context/session-brief.json`,
      `.ai-factory/state/${changeId}/context/session-brief.md`,
      `.ai-factory/state/${changeId}/sdd/profile-decision.json`,
      '.ai-factory/config.yaml',
    ];
    const before = new Map();
    for (const file of artifacts) {
      const info = await stat(path.join(root, file));
      before.set(file, { bytes: await readFile(path.join(root, file)), mtimeMs: info.mtimeMs });
    }
    const inspectionBefore = await inspectSessionBrief({ rootDir: root, changeId });
    const assessor = rankedAssessor((input) => input.candidates.map((candidate) => finding(candidate.candidate_id)));
    assert.equal((await runCommand(root, ['--change', changeId, '--enabled', 'true', '--candidate', 'notes/research.md', '--json'], { assessor })).exitCode, 0);
    assert.equal((await runCommand(root, ['--change', changeId, '--enabled', 'false', '--json'])).exitCode, 0);
    assert.equal((await runCommand(root, ['--change', changeId, '--enabled', 'true', '--candidate', 'notes/research.md', '--write', '--json'], { assessor })).exitCode, 0);
    for (const file of artifacts) {
      const info = await stat(path.join(root, file));
      const snapshot = before.get(file);
      assert.deepEqual(await readFile(path.join(root, file)), snapshot.bytes, `${file} stays byte-identical`);
      assert.equal(info.mtimeMs, snapshot.mtimeMs, `${file} stays mtime-identical (no rewrite)`);
    }
    const inspectionAfter = await inspectSessionBrief({ rootDir: root, changeId });
    assert.equal(inspectionAfter.digest, inspectionBefore.digest);
    assert.equal(inspectionAfter.status, 'valid');
  });

  it('keeps compact_supporting_context echoed, never executed, and the manifest intact', async () => {
    const root = await makeTemp('aif-cso-policy-');
    const { changeId } = await seedBriefProject(root);
    await put(root, '.ai-factory/sdd-policy.json', JSON.stringify({
      schema: 'aifhub.sdd_policy.v1',
      context_policy: { strategy: 'measured', compact_supporting_context: true, protected_artifacts: 'full' },
    }, null, 2));
    await compile(root, changeId);
    const before = await readFile(path.join(root, '.ai-factory', 'state', changeId, 'context', 'session-brief.json'));
    const brief = await readStoredBrief(root, changeId);
    const assessor = rankedAssessor((input) => input.candidates.map((candidate) => finding(candidate.candidate_id)));
    const run = await runCommand(root, ['--change', changeId, '--enabled', 'true', '--candidate', 'notes/research.md', '--json'], { assessor });
    assert.equal(run.exitCode, 0);
    assert.equal(run.value.run_status, 'complete');
    assert.deepEqual(await readFile(path.join(root, '.ai-factory', 'state', changeId, 'context', 'session-brief.json')), before, 'the deferred policy is not executed through the overlay');
    assert.deepEqual(run.value.manifest.protected_minimum, brief.context_manifest, 'the baseline manifest is never compacted by the overlay');
    assert.equal(JSON.stringify(run.value).includes('compact_supporting_context'), false, 'the observation never claims policy execution');
  });

  it('normalizes the provider context payload byte-identically with the overlay off and on', async () => {
    const root = await makeTemp('aif-cso-capsule-');
    const { changeId } = await seedBriefProject(root);
    await compile(root, changeId);
    // The provider normalization is exercised on the reviewed upstream goldens
    // exactly like the provider's own test — the TEST imports the provider,
    // the overlay engine never does (decision D14).
    const { runLekaloOperation } = await import('./lekalo-provider.mjs');
    const golden = async (kind) => parseStrictJson(await readFile(path.join(REPO_ROOT, 'test', 'fixtures', 'validation-providers', `lekalo-${kind}-v1.1.0.json`), 'utf8'));
    const impact = await golden('impact');
    const context = await golden('context');
    const runProcess = async (_, args) => ({ outcome: 'completed', exitCode: 0, stderr: '',
      stdout: JSON.stringify(args[0] === 'impact' ? { status: 'valid', impact } : context) });
    const normalize = async () => JSON.stringify(await runLekaloOperation('context', root, {}, { runProcess }));
    const before = await normalize();
    assert.ok(before.length > 0);
    const assessor = rankedAssessor(() => []);
    assert.equal((await runCommand(root, ['--change', changeId, '--enabled', 'true', '--candidate', 'notes/research.md', '--json'], { assessor })).exitCode, 0);
    assert.equal(await normalize(), before, 'the overlay run cannot shift provider normalization');
  });
});

// ---------------------------------------------------------------------------
// Isolation (decision D14): offline module, banned imports, read-only baseline
// ---------------------------------------------------------------------------

describe('context-selection-overlay isolation', () => {
  const source = () => readFile(path.join(REPO_ROOT, 'scripts', 'context-selection-overlay.mjs'), 'utf8');

  it('never imports provider, gate, or QA-evidence modules and never calls the compiler', async () => {
    const code = await source();
    for (const banned of [
      "from './lekalo-provider.mjs'",
      "from './aifhub-providers.mjs'",
      "from './aif-gate-result.mjs'",
      "from './write-gate-evidence.mjs'",
    ]) {
      assert.equal(code.includes(banned), false, `the overlay must not import ${banned}`);
    }
    assert.equal(code.includes('compileSessionBrief('), false, 'the compiler write path is never called');
    assert.equal(code.includes('runLekaloOperation('), false, 'no provider operation is invoked');
    assert.ok(code.includes('inspectSessionBrief'), 'the read-only inspector is the only baseline surface');
  });

  it('opens no network surface: no fetch, no child processes, no URLs', async () => {
    const code = await source();
    for (const banned of ['fetch(', 'execFile', 'spawn(', 'XMLHttpRequest', 'require(', "import('node:child_process')", 'http://', 'https://']) {
      assert.equal(code.includes(banned), false, `the overlay must stay offline: ${banned}`);
    }
  });

  it('a preview run mutates nothing outside the closed namespace; --write mutates only the namespace', async () => {
    const root = await makeTemp('aif-cso-isolate-');
    const { changeId } = await seedBriefProject(root);
    await compile(root, changeId);
    const stateEntries = async () => {
      const entries = await readdir(path.join(root, '.ai-factory', 'state', changeId), { recursive: true, withFileTypes: true }).catch(() => []);
      return entries.map((entry) => `${entry.parentPath ?? entry.path}/${entry.name}`.replaceAll('\\', '/')).sort();
    };
    const canonicalFingerprint = async () => {
      const entries = [];
      for (const file of ['openspec', 'notes', '.ai-factory/config.yaml']) {
        try {
          const info = await stat(path.join(root, file));
          entries.push(`${file}:${info.mtimeMs}`);
        } catch { /* absent */ }
      }
      return entries.join('|');
    };
    const stateBefore = await stateEntries();
    const canonicalBefore = await canonicalFingerprint();
    const assessor = rankedAssessor((input) => input.candidates.map((candidate) => finding(candidate.candidate_id)));
    await runCommand(root, ['--change', changeId, '--enabled', 'true', '--candidate', 'notes/research.md', '--json'], { assessor });
    assert.deepEqual(await stateEntries(), stateBefore, 'preview writes nothing');
    assert.equal(await canonicalFingerprint(), canonicalBefore, 'preview mutates no canonical surface');
    await runCommand(root, ['--change', changeId, '--enabled', 'true', '--candidate', 'notes/research.md', '--write', '--json'], { assessor });
    const stateAfter = await stateEntries();
    const added = stateAfter.filter((entry) => !stateBefore.includes(entry));
    assert.ok(added.length > 0, 'the write adds the observation');
    for (const entry of added) {
      assert.ok(entry.includes(CONTEXT_SELECTION_NAMESPACE), `the only added surface is the namespace: ${entry}`);
    }
    assert.equal(await canonicalFingerprint(), canonicalBefore, 'the write mutates no canonical surface');
  });
});

// ---------------------------------------------------------------------------
// Writer guards (decision D16 + git-guard)
// ---------------------------------------------------------------------------

describe('context-selection-overlay writer guards', () => {
  const configFor = (overrides = {}) => ({
    enabled: true, enabledMalformed: false, stateRoot: STATE_ROOT, qaRoot: '.ai-factory/qa',
    stateRootRaw: undefined, qaRootRaw: undefined, diagnostics: [], ...overrides,
  });

  const observationFor = () => assembleObservation({
    changeId: 'writer-change',
    generatedAt: '2026-01-01T00:00:00.000Z',
    runStatus: 'complete',
    complete: true,
    freshness: 'current',
    abstained: false,
    needsReview: false,
    ownerHandoff: null,
    coverage: { state: 'full', declared_sources: 1, scanned_sources: 1, missing_sources: [] },
    budget: { strategy: 'measured', estimated: 10, minimum_required: 10, limit: MAX_PRESENTATION_BYTES, fits: true, token_estimate: null },
    manifest: { protected_minimum: [{ path: 'a.md', sha256: 'a'.repeat(64), fidelity: 'full' }], included: [], excluded: [] },
    candidates: [],
    presentation: [
      { section: 'protected_minimum', refs: ['a.md'] },
      { section: 'relevant', refs: [] },
      { section: 'conflicts', refs: [] },
      { section: 'unresolved', refs: [] },
    ],
    baseline: baselineBindingComponents({ digest: 'a'.repeat(64), source_revision: 'a'.repeat(64), policy_revision: 'a'.repeat(64), scope_fingerprint: 'a'.repeat(64), plan_context: { source_revision: null }, instruction_composition_digest: null }),
    candidateDigests: [],
    context: {
      rubric: { ...CONTEXT_SELECTION_RUBRIC },
      exclusionPolicy: { ...EXCLUSION_POLICY },
      presentationPolicy: { ...PRESENTATION_POLICY },
      engine: { module: 'e', sha256: 'a'.repeat(64) },
      helper: { module: 'h', sha256: 'a'.repeat(64) },
      contract: { name: CONTEXT_SELECTION_SCHEMA, sha256: 'a'.repeat(64) },
      assessmentLimits: { ...ASSESSMENT_LIMITS },
      budgetPolicy: { ...BUDGET_POLICY },
    },
    language: 'en',
    worktreeIdentity: 'a'.repeat(64),
    binding: 'b'.repeat(64),
    diagnostics: [],
  });

  it('refuses custom state roots with state-root-mismatch (owner-approved narrowing)', async () => {
    const root = await makeTemp('aif-cso-writer1-');
    const refused = await writeOverlayObservation(root, observationFor(), configFor({ stateRootRaw: 'custom/state' }));
    assert.equal(refused.ok, false);
    assert.equal(refused.code, 'state-root-mismatch');
    const scalar = await writeOverlayObservation(root, observationFor(), configFor({ stateRootRaw: 42 }));
    assert.equal(scalar.code, 'state-root-mismatch');
    assert.equal(await exists(root, 'custom'), false);
  });

  it('refuses tracked and not-ignored outputs through the git guard before the first write', async () => {
    const root = await makeTemp('aif-cso-writer2-');
    const { spawn } = await import('node:child_process');
    const git = (args) => new Promise((resolve) => {
      const child = spawn('git', args, { cwd: root, windowsHide: true });
      child.on('close', (code) => resolve(code ?? 0));
    });
    await put(root, '.gitignore', 'node_modules/\n');
    await git(['init', '--initial-branch=main']);
    await git(['config', 'user.email', 'fixture@example.com']);
    await git(['config', 'user.name', 'fixture']);
    await git(['add', '.']);
    await git(['commit', '-m', 'init']);
    // Not effectively ignored: the guard refuses before any write.
    const notIgnored = await writeOverlayObservation(root, observationFor(), configFor());
    assert.equal(notIgnored.ok, false);
    assert.equal(notIgnored.code, 'observation-path-not-ignored');
    // A previous valid observation may be written once ignore rules cover the
    // namespace — and then a tracked observation is refused on every
    // subsequent write, even though the leaf itself is replaceable.
    await git(['add', '-f', '.gitignore']);
    await git(['commit', '-m', 'track root ignore']);
    const trackedRoot = await writeOverlayObservation(root, observationFor(), configFor());
    assert.equal(trackedRoot.ok, false, 'a root-level .gitignore does not cover the namespace leaf');
    assert.equal(trackedRoot.code, 'observation-path-not-ignored');
    await ensureRuntimeGitignore(root, STATE_ROOT);
    const allowed = await writeOverlayObservation(root, observationFor(), configFor());
    assert.equal(allowed.ok, true);
    await git(['add', '-f', `${STATE_ROOT}/writer-change/${CONTEXT_SELECTION_NAMESPACE}/observation.json`]);
    const tracked = await writeOverlayObservation(root, observationFor(), configFor());
    assert.equal(tracked.ok, false);
    assert.equal(tracked.code, 'observation-path-tracked');
  });

  it('replaces only a previous schema-valid observation of the same change', async () => {
    const root = await makeTemp('aif-cso-writer3-');
    const observation = observationFor();
    const first = await writeOverlayObservation(root, observation, configFor(), { gitGuard: async () => ({ ok: true }) });
    assert.equal(first.ok, true);
    assert.equal(first.path, `${STATE_ROOT}/writer-change/${CONTEXT_SELECTION_NAMESPACE}/observation.json`);
    const second = await writeOverlayObservation(root, observation, configFor(), { gitGuard: async () => ({ ok: true }) });
    assert.equal(second.ok, true, 'same-change overwrite is allowed');
    const garbage = path.join(root, STATE_ROOT, 'writer-change', CONTEXT_SELECTION_NAMESPACE, 'observation.json');
    await writeFile(garbage, 'not json', 'utf8');
    const corrupted = await writeOverlayObservation(root, observation, configFor(), { gitGuard: async () => ({ ok: true }) });
    assert.equal(corrupted.ok, false, 'an unreadable previous leaf fails closed');
    assert.equal(corrupted.code, 'observation-leaf-conflict');
  });
});

// ---------------------------------------------------------------------------
// QA isolation (decision D15): the namespace is closed at every projection
// ---------------------------------------------------------------------------

describe('context-selection-overlay QA snapshot isolation', () => {
  async function seedGitProject(root) {
    await put(root, '.gitignore', '.ai-factory/\n');
    await seedBriefProject(root, { changeId: 'work', config: 'aifhub:\n  artifactProtocol: openspec\n  openspec:\n    useInstructionsApply: false\n' });
    await compile(root, 'work');
    const { spawn } = await import('node:child_process');
    const git = (args) => new Promise((resolve) => {
      const child = spawn('git', args, { cwd: root, windowsHide: true });
      child.on('close', (code) => resolve(code ?? 0));
    });
    await git(['init', '--initial-branch=main']);
    await git(['config', 'user.email', 'fixture@example.com']);
    await git(['config', 'user.name', 'fixture']);
    await git(['add', '.']);
    await git(['commit', '-m', 'init']);
    await ensureRuntimeGitignore(root, STATE_ROOT);
    const toolchain = [{ name: 'fixture-node', sha256: digest('node') }];
    const check = {
      id: 'check-verify', gate: 'verify', profile: 'declared.v1', dependencies_complete: true,
      inputs: ['openspec/changes/work'], command: { argv: ['fake'], cwd: '.' }, toolchain, env_inputs: [], requires_observed: false,
    };
    const options = {
      rootDir: root, changeId: 'work', scope: ['openspec/changes/work'], checks: [check], environment: {},
      providers: {
        requirements: async () => ({ gates: ['verify'], independent_roles: [], evidence: [] }),
        toolchain: async () => toolchain,
      },
    };
    assert.equal((await prepareQaManifest(options)).ok, true, 'qa enrollment needs a real git worktree');
    return options;
  }

  async function observe(options) {
    const store = await qaStore(options);
    const { payload } = await store.manifest();
    const snapshot = await observeQaSnapshot(store, payload);
    return {
      files: Object.keys(snapshot.files).sort(),
      ignored_names: snapshot.ignored_names,
      changed_paths: snapshot.changed_paths,
      digest: snapshot.digest,
    };
  }

  it('keeps the QA fingerprint identical across write, overwrite, and deletion', async () => {
    const root = await makeTemp('aif-cso-qa1-');
    const options = await seedGitProject(root);
    const before = await observe(options);
    const assessor = rankedAssessor((input) => input.candidates.map((candidate) => finding(candidate.candidate_id)));
    const argv = ['--change', 'work', '--enabled', 'true', '--candidate', 'notes/research.md', '--write', '--json'];
    assert.equal(await runContextSelectionOverlayCommand(argv, { rootDir: root, output: () => {}, assessor }), 0);
    const afterWrite = await observe(options);
    assert.deepEqual(afterWrite, before);
    assert.equal(await runContextSelectionOverlayCommand(argv, { rootDir: root, output: () => {}, assessor }), 0, 'overwrite of the same-change observation is allowed');
    const afterOverwrite = await observe(options);
    assert.deepEqual(afterOverwrite, before);
    await rm(path.join(root, STATE_ROOT, 'work', CONTEXT_SELECTION_NAMESPACE, 'observation.json'), { force: true });
    const afterDelete = await observe(options);
    assert.deepEqual(afterDelete, before);
    assert.ok(!before.files.some((p) => p.includes(CONTEXT_SELECTION_NAMESPACE)), 'namespace never enters the projected file catalog');
    assert.ok(!before.ignored_names.some((p) => p.includes(CONTEXT_SELECTION_NAMESPACE)), 'namespace never enters ignored_names');
    assert.ok(!before.changed_paths.some((p) => p.includes(CONTEXT_SELECTION_NAMESPACE)), 'namespace never enters changed_paths');
  });

  it('filters the namespace at the projection layer even in front of an injected SnapshotProvider', async () => {
    const root = await makeTemp('aif-cso-qa2-');
    const options = await seedGitProject(root);
    const store = await qaStore(options);
    const { payload } = await store.manifest();
    const injected = {
      observe: async () => ({
        complete: true,
        worktree_identity: 'a'.repeat(64),
        modules: { 'scripts/qa-manifest.mjs': digest('x') },
        actual_diff: null,
        files: {
          'docs/spec.md': Buffer.from('spec'),
          [`${STATE_ROOT}/work/${CONTEXT_SELECTION_NAMESPACE}/observation.json`]: Buffer.from('{}'),
          [`${STATE_ROOT}/work/${CONTEXT_SELECTION_NAMESPACE}/.gitignore`]: Buffer.from('*\n'),
        },
        directory_names: [`${STATE_ROOT}/work/${CONTEXT_SELECTION_NAMESPACE}`],
        ignored_names: [`${STATE_ROOT}/work/${CONTEXT_SELECTION_NAMESPACE}/observation.json`],
        changed_paths: [`${STATE_ROOT}/work/${CONTEXT_SELECTION_NAMESPACE}/observation.json`],
      }),
    };
    const snapshot = await observeQaSnapshot(store, payload, { SnapshotProvider: injected });
    const leak = (p) => p.includes(CONTEXT_SELECTION_NAMESPACE);
    assert.ok(!Object.keys(snapshot.files).some(leak), 'injected-provider files must not leak the namespace');
    assert.ok(!snapshot.ignored_names.some(leak), 'injected-provider ignored_names must not leak the namespace');
    assert.ok(!snapshot.changed_paths.some(leak), 'injected-provider changed_paths must not leak the namespace');
    assert.ok(snapshot.files['docs/spec.md'], 'presented scope stays projected');
  });
});

// ---------------------------------------------------------------------------
// Candidate intake primitives (unit level)
// ---------------------------------------------------------------------------

describe('context-selection-overlay candidate intake primitives', () => {
  it('deduplicates presented paths with a bounded diagnostic and sorts deterministically', async () => {
    const root = await makeTemp('aif-cso-intake-');
    await put(root, 'b.md', 'b');
    await put(root, 'a.md', 'a');
    const diagnostics = [];
    const candidates = await readCandidates(root, ['b.md', 'a.md', 'b.md'], diagnostics);
    assert.deepEqual(candidates.map((candidate) => candidate.path), ['a.md', 'b.md']);
    assert.deepEqual(candidates.map((candidate) => candidate.candidate_id), ['cand-0', 'cand-1']);
    assert.ok(diagnostics.some((entry) => entry.code === 'duplicate-candidate'));
  });

  it('classifies unreadable candidates without ever throwing out of intake', async () => {
    const root = await makeTemp('aif-cso-intake2-');
    const diagnostics = [];
    const candidates = await readCandidates(root, ['ghost.md', 'link-target.md'], diagnostics);
    assert.equal(candidates[0].kind, 'missing');
    assert.equal(candidates[0].sha256, null);
    assert.ok(diagnostics.some((entry) => entry.code === 'candidate-missing'));
  });

  it('the protected minimum builder joins measured bytes and degrades unverified entries honestly', () => {
    const diagnostics = [];
    const brief = {
      context_manifest: [
        { path: 'a.md', sha256: 'a'.repeat(64), fidelity: 'full' },
        { path: 'ghost.md', sha256: 'g'.repeat(64), fidelity: 'full' },
      ],
      sources: [
        { path: 'a.md', sha256: 'a'.repeat(64), bytes: 120, kind: 'protected' },
      ],
    };
    const build = buildProtectedMinimum(brief, diagnostics);
    assert.equal(build.minimumRequired, 120);
    assert.deepEqual(build.protected_minimum, brief.context_manifest, 'verbatim, no selection inside the baseline');
    assert.deepEqual(build.missing, [{ path: 'ghost.md', reason: 'protected-minimum-unverified' }]);
    assert.ok(diagnostics.some((entry) => entry.code === 'protected-minimum-unverified'));
  });

  it('the projector never demotes a conflicting candidate and keeps the tail exhaustive', () => {
    const candidates = [
      { candidate_id: 'cand-0', path: 'big.md', sha256: 'a'.repeat(64), bytes: 900, kind: 'file' },
      { candidate_id: 'cand-1', path: 'small.md', sha256: 'a'.repeat(64), bytes: 50, kind: 'file' },
    ];
    const assessments = new Map([
      ['cand-0', { status: 'included', scores: null, reason: null, limitation: null, evidence_refs: [], conflict: null }],
      ['cand-1', { status: 'conflicting', scores: null, reason: null, limitation: null, evidence_refs: [], conflict: { state: 'suspected', refs: [{ path: 'small.md', document_sha256: 'a'.repeat(64) }] } }],
    ]);
    const projection = projectSelection({ candidates, assessments, protectedMinimum: [], minimumRequired: 0, conflictRefsBytes: 10_000, limit: 1000 });
    assert.equal(projection.records[0].status, 'included');
    assert.equal(projection.records[1].status, 'conflicting', 'a conflict is never budget-demoted');
    assert.equal(projection.conflictFits, false, 'oversized conflict metadata degrades honestly');
    assert.ok(projection.diagnostics.some((entry) => entry.code === 'conflict-evidence-refs-only'));
  });

  it('sanitizes evidence refs to portable paths with real digests', () => {
    const diagnostics = [];
    const assessments = normalizeAssessorFindings({
      run_status: 'complete',
      abstained: false,
      findings: [
        {
          candidate_id: 'cand-0', status: 'included', scores: null, reason: 'r', limitation: null,
          evidence_refs: [
            { path: '../escape.md', document_sha256: 'a'.repeat(64) },
            { path: 'ok.md', document_sha256: 'not-a-digest' },
            { path: 'ok.md', document_sha256: 'a'.repeat(64), span: { start: 10, end: 2 } },
            { path: 'ok.md', document_sha256: 'a'.repeat(64), span: { start: 0, end: 2 }, span_sha256: 'b'.repeat(64) },
          ],
          conflict: null,
        },
      ],
    }, [{ candidate_id: 'cand-0', path: 'ok.md', sha256: 'a'.repeat(64), bytes: 2, kind: 'file', text: '' }], diagnostics);
    const refs = assessments.get('cand-0').evidence_refs;
    assert.equal(refs.length, 1);
    assert.equal(refs[0].span_sha256, 'b'.repeat(64));
    assert.ok(diagnostics.some((entry) => entry.code === 'evidence-ref-invalid'));
  });
});

// ---------------------------------------------------------------------------
// Schema↔runtime parity: bounds and closed enums agree on both sides
// ---------------------------------------------------------------------------

describe('context-selection-overlay schema-runtime parity', () => {
  it('pins the schema bounds to the engine constants', async () => {
    const schema = parseStrictJson(await readFile(path.join(REPO_ROOT, CONTRACT_MODULE), 'utf8'));
    assert.equal(schema.properties.schema.const, CONTEXT_SELECTION_SCHEMA);
    assert.equal(schema.properties.diagnostic_only.const, true);
    assert.deepEqual(schema.properties.authorizes.maxItems, 0);
    assert.equal(schema.properties.candidates.maxItems, MAX_CANDIDATES);
    assert.equal(schema.properties.candidate_digests.maxItems, MAX_CANDIDATES);
    assert.equal(schema.properties.manifest.properties.protected_minimum.maxItems, 1024);
    assert.equal(schema.properties.presentation.maxItems, MAX_PRESENTATION_SECTIONS);
    const candidateShape = schema.$defs.candidate;
    const evidenceShape = schema.$defs.evidence_ref;
    assert.equal(candidateShape.properties.evidence_refs.maxItems, MAX_EVIDENCE_REFS_PER_CANDIDATE);
    assert.equal(candidateShape.properties.conflict.properties.refs.maxItems, MAX_EVIDENCE_REFS_PER_CANDIDATE);
    assert.equal(schema.properties.diagnostics.maxItems, 200);
    assert.equal(schema.properties.budget.properties.token_estimate.const, null);
    assert.equal(Object.hasOwn(schema.properties, 'elapsed_ms'), false, 'runtime timing never serializes');
    assert.deepEqual(
      candidateShape.properties.status.enum,
      ['included', 'conflicting', 'excluded', 'unassessed'],
    );
    assert.deepEqual(
      candidateShape.properties.conflict.properties.state.enum,
      ['suspected', 'owner_confirmed'],
      'owner_confirmed stays reserved in the closed enum',
    );
    assert.deepEqual(
      schema.properties.presentation.items.properties.section.enum,
      ['protected_minimum', 'relevant', 'conflicts', 'unresolved'],
    );
    assert.ok(evidenceShape.properties.document_sha256, 'evidence refs carry document digests');
    assert.equal(Object.hasOwn(candidateShape, 'dependentRequired'), true);
  });

  it('pins the engine module surface to the closed consumer registry and policy identity', async () => {
    const { ASSESSMENT_CONSUMER_IDS } = await import('./typed-assessment.mjs');
    assert.ok(ASSESSMENT_CONSUMER_IDS.includes(CONTEXT_SELECTION_CONSUMER_ID));
    assert.equal(CONTEXT_SELECTION_RUBRIC.id, 'context-selection-advisory-default');
    assert.equal(PRESENTATION_POLICY.id, 'context-selection-sections-v1');
    assert.equal(EXCLUSION_POLICY.id, 'none');
    const schema = parseStrictJson(await readFile(path.join(REPO_ROOT, CONTRACT_MODULE), 'utf8'));
    assert.equal(schema.properties.contract.properties.name.const, CONTEXT_SELECTION_SCHEMA);
    assert.equal((await currentOverlayContext()).contract.name, CONTEXT_SELECTION_SCHEMA);
  });
});


// ---------------------------------------------------------------------------
// Corpus evaluation over test/fixtures/context-selection-overlay (labels.json
// discipline: transport/guards/invariants, never semantic accuracy)
// ---------------------------------------------------------------------------

const CORPUS_DIR = path.join(REPO_ROOT, 'test', 'fixtures', 'context-selection-overlay');
const CORPUS_LABELS = parseStrictJson(await readFile(path.join(CORPUS_DIR, 'labels.json'), 'utf8'));

describe('context-selection-overlay corpus evaluation (fixtures + labels)', () => {
  it('pins the shipped candidate bytes to the labels digests', async () => {
    for (const [relative, sha] of Object.entries(CORPUS_LABELS.candidate_digests)) {
      const bytes = await readFile(path.join(CORPUS_DIR, relative));
      assert.equal(digest(bytes), sha, relative);
    }
  });

  it('keeps a CRLF candidate byte-exact across the checkout', async () => {
    const crlf = CORPUS_LABELS.cases.find((entry) => entry.id === 'limit-crlf-bytes');
    const bytes = await readFile(path.join(CORPUS_DIR, 'candidates/limit-crlf.md'));
    assert.equal(digest(bytes), crlf.expected.pinned_sha256);
    assert.equal(bytes.length, crlf.expected.bytes);
    assert.ok(bytes.includes(Buffer.from('\r\n')), 'the fixture ships real CRLF bytes');
  });

  for (const entry of CORPUS_LABELS.cases.filter((item) => !item.expected.write_then_drift)) {
    it(`corpus case ${entry.id}: statuses, coverage, and presentation match the labels`, async () => {
      const root = await makeTemp('aif-cso-corpus-');
      const { changeId } = await seedBriefProject(root);
      await compile(root, changeId);
      const presented = [];
      for (const relative of entry.candidates ?? []) {
        const target = `notes/${path.basename(relative)}`;
        await put(root, target, await readFile(path.join(CORPUS_DIR, relative)));
        presented.push(target);
      }
      for (const ghost of entry.ghost_candidates ?? []) presented.push(ghost);
      for (const generated of entry.generated_candidates ?? []) {
        await put(root, generated.path, 'z'.repeat(generated.bytes_over_limit));
        presented.push(generated.path);
      }
      const labelsByPath = new Map(Object.entries(entry.labels ?? {}).map(([relative, label]) => [`notes/${path.basename(relative)}`, label]));
      const assessor = rankedAssessor((input) => input.candidates.map((candidate) => {
        const label = labelsByPath.get(candidate.path) ?? {};
        const sha = digest(Buffer.from(candidate.text, 'utf8'));
        const refs = (label.evidence_refs ?? []).map((ref) => ({
          path: candidate.path,
          document_sha256: sha,
          ...(ref.span ? { span: ref.span } : {}),
        }));
        return {
          candidate_id: candidate.candidate_id,
          ...(label.status ? { status: label.status } : {}),
          scores: label.scores ?? null,
          reason: label.reason ?? null,
          limitation: label.limitation ?? null,
          evidence_refs: refs,
          conflict: label.conflict ? { state: label.conflict.state, refs: label.conflict.refs.map(() => ({ path: candidate.path, document_sha256: sha })) } : null,
        };
      }));
      const fingerprints = new Map();
      for (const watched of entry.expected.injected_paths_never_read ?? []) {
        fingerprints.set(watched, await readFile(path.join(root, watched)));
      }
      const run = await runCommand(root, [
        '--change', changeId, '--enabled', 'true',
        ...presented.flatMap((candidate) => ['--candidate', candidate]),
        '--json',
      ], { assessor });
      assert.equal(run.exitCode, 0, run.text.slice(0, 400));
      const observation = run.value;
      assert.notEqual(observation.state, 'not_run', 'enabled cases never land in the not_run envelope');
      assert.equal(observation.coverage.state, entry.expected.coverage);
      assert.equal(observation.complete, entry.expected.complete);
      if (entry.expected.run_status) assert.equal(observation.run_status, entry.expected.run_status);
      if (entry.expected.needs_review !== undefined) assert.equal(observation.needs_review, entry.expected.needs_review);
      if (entry.expected.owner_handoff !== undefined) assert.equal(observation.owner_handoff, entry.expected.owner_handoff);
      if (entry.expected.language) assert.equal(observation.language, entry.expected.language);
      if (entry.expected.presentation_sections) {
        assert.deepEqual(observation.presentation.map((section) => section.section), entry.expected.presentation_sections);
      }
      // Presentation completeness: every candidate sits in exactly one
      // non-protected section, and the protected section mirrors the
      // verbatim baseline manifest.
      const flatRefs = observation.presentation.filter((section) => section.section !== 'protected_minimum').flatMap((section) => section.refs);
      assert.equal(new Set(flatRefs).size, flatRefs.length, 'presentation completeness');
      assert.equal(flatRefs.length, observation.candidates.length);
      // Negative-false accusation guard: the included set is exactly the
      // labels' included set, never larger.
      const includedExpected = new Set(Object.entries(entry.expected.statuses ?? {}).filter(([, status]) => status === 'included').map(([statusPath]) => statusPath));
      const includedActual = new Set(observation.candidates.filter((candidate) => candidate.status === 'included').map((candidate) => candidate.path));
      assert.deepEqual([...includedActual].sort(), [...includedExpected].sort());
      for (const [candidatePath, status] of Object.entries(entry.expected.statuses ?? {})) {
        const candidate = observation.candidates.find((item) => item.path === candidatePath);
        assert.ok(candidate, `${candidatePath} recorded`);
        assert.equal(candidate.status, status);
        if (entry.expected.kinds?.[candidatePath]) assert.equal(candidate.kind, entry.expected.kinds[candidatePath]);
        if (status === 'excluded') {
          assert.ok(candidate.reason && candidate.limitation, 'excluded carries reason and limitation');
        }
        if (status === 'conflicting') {
          assert.equal(candidate.conflict.state, entry.expected.conflict_state);
          assert.ok(candidate.conflict.refs.length > 0);
        }
      }
      for (const missing of entry.expected.missing_sources ?? []) {
        assert.ok(observation.coverage.missing_sources.some((source) => source.path === missing), missing);
      }
      // Adversarial transport facts: named paths stay unread bytes.
      for (const [watched, before] of fingerprints) {
        assert.deepEqual(await readFile(path.join(root, watched)), before, `${watched} never read by the overlay`);
      }
      if (entry.expected.injected_paths_never_read) {
        assert.equal(observation.candidates.length, presented.length, 'the allowlist is exactly the presented candidates');
      }
    });
  }

  it('corpus case limit-stale-source: a drifted candidate invalidates the recorded observation with its field named', async () => {
    const entry = CORPUS_LABELS.cases.find((item) => item.id === 'limit-stale-source');
    const root = await makeTemp('aif-cso-corpus-stale-');
    const { changeId } = await seedBriefProject(root);
    await compile(root, changeId);
    const presented = [];
    for (const relative of entry.candidates) {
      const target = `notes/${path.basename(relative)}`;
      await put(root, target, await readFile(path.join(CORPUS_DIR, relative)));
      presented.push(target);
    }
    const assessor = rankedAssessor((input) => input.candidates.map((candidate) => {
      const label = entry.labels[`candidates/${path.basename(candidate.path)}`];
      return {
        candidate_id: candidate.candidate_id,
        status: label.status,
        scores: label.scores,
        reason: null,
        limitation: null,
        evidence_refs: [],
        conflict: null,
      };
    }));
    const run = await runCommand(root, [
      '--change', changeId, '--enabled', 'true',
      ...presented.flatMap((candidate) => ['--candidate', candidate]),
      '--write', '--json',
    ], { assessor });
    assert.equal(run.exitCode, 0);
    assert.equal(run.value.complete, entry.expected.complete);
    await put(root, presented[0], 'Rewritten bytes that drift the pinned digest.\n');
    const verdict = await validateSelectionBinding(root, run.value);
    assert.equal(verdict.stale, true);
    assert.equal(verdict.state, entry.expected.write_then_drift.state);
    assert.ok(verdict.mismatched.includes(entry.expected.write_then_drift.drift_field));
  });
});
