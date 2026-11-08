// decision-corrections.test.mjs - project-scoped DecisionCorrectionFixture store (#285).
// Every scenario runs inside disposable temp projects (mkdtemp + realpath);
// the checkout is never written to. No network, no SDK, no keys, no paid
// calls. The QA-namespace section below (step 3 of the change plan) only
// exercises scripts/qa-manifest-inputs.mjs with case files written directly;
// engine-backed scenarios join the same file as the engine lands.
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonical, digest } from './workflow-state-store.mjs';
import { parseStrictJson } from './json-strict.mjs';
import { validateJsonAgainstSchema } from './json-schema-subset.mjs';
import { prepareQaManifest } from './qa-manifest.mjs';
import { qaStore } from './qa-manifest-store.mjs';
import { observeQaSnapshot } from './qa-manifest-inputs.mjs';
import { ensureRuntimeGitignore } from './runtime-gitignore.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DECISION_CORRECTIONS_NAMESPACE = 'decision-corrections';
const roots = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function makeTemp(prefix) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
  roots.push(root);
  return root;
}

async function gitIn(root, args) {
  const child = spawn('git', args, { cwd: root, windowsHide: true });
  let stdout = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  return new Promise((resolve, reject) => { child.on('error', reject); child.on('close', () => resolve(stdout)); });
}

async function seedGitProject(root) {
  await mkdir(path.join(root, 'docs'), { recursive: true });
  await mkdir(path.join(root, '.ai-factory'), { recursive: true });
  await mkdir(path.join(root, 'openspec', 'changes', 'work'), { recursive: true });
  await writeFile(path.join(root, '.gitignore'), '.ai-factory/\n');
  await writeFile(path.join(root, 'docs', 'spec.md'), '# Spec\n\nQA isolation fixture.\n');
  await writeFile(path.join(root, 'openspec', 'changes', 'work', 'proposal.md'), '# Proposal\n\n## Why\n\nQA isolation fixture.\n');
  await writeFile(path.join(root, 'openspec', 'changes', 'work', 'tasks.md'), '- [ ] 1.1 Task\n');
  await gitIn(root, ['init', '--initial-branch=main']);
  await gitIn(root, ['config', 'user.email', 'fixture@example.com']);
  await gitIn(root, ['config', 'user.name', 'fixture']);
  await gitIn(root, ['add', '.']);
  await gitIn(root, ['commit', '-m', 'init']);
  await ensureRuntimeGitignore(root, '.ai-factory/state');
  const toolchain = [{ name: 'fixture-node', sha256: digest('node') }];
  const check = {
    id: 'check-verify', gate: 'verify', profile: 'declared.v1', dependencies_complete: true,
    inputs: ['docs'], command: { argv: ['fake'], cwd: '.' }, toolchain, env_inputs: [], requires_observed: false,
  };
  const options = {
    rootDir: root, changeId: 'work', scope: ['docs'], checks: [check], environment: {},
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

function casePath(root, scope, filename) {
  return path.join(root, '.ai-factory', 'state', DECISION_CORRECTIONS_NAMESPACE, scope, 'cases', filename);
}

// ---------------------------------------------------------------------------
// QA namespace isolation (#285): the constant store namespace must never
// change required QA surfaces, whatever the snapshot provider in front of it.
// ---------------------------------------------------------------------------

describe('decision-corrections QA namespace isolation', () => {
  it('keeps the QA fingerprint identical across write, overwrite, and deletion of a case', async () => {
    const root = await makeTemp('aif-dc-qa1-');
    const options = await seedGitProject(root);
    const before = await observe(options);
    await mkdir(path.dirname(casePath(root, 'work', 'case-1.json')), { recursive: true });
    const caseBytes = JSON.stringify({ envelope: 'fixture bytes for the namespace probe' });
    await writeFile(casePath(root, 'work', 'case-1.json'), caseBytes);
    const afterWrite = await observe(options);
    assert.deepEqual(afterWrite, before, 'writing a case must not shift the QA fingerprint');
    await writeFile(casePath(root, 'work', 'case-1.json'), `${caseBytes}\n`);
    const afterOverwrite = await observe(options);
    assert.deepEqual(afterOverwrite, before, 'overwriting a case must not shift the QA fingerprint');
    await rm(casePath(root, 'work', 'case-1.json'));
    const afterDelete = await observe(options);
    assert.deepEqual(afterDelete, before, 'deleting a case must not shift the QA fingerprint');
    assert.ok(!before.files.some((p) => p.includes(DECISION_CORRECTIONS_NAMESPACE)), 'namespace never enters the projected file catalog');
    assert.ok(!before.ignored_names.some((p) => p.includes(DECISION_CORRECTIONS_NAMESPACE)), 'namespace never enters ignored_names');
    assert.ok(!before.changed_paths.some((p) => p.includes(DECISION_CORRECTIONS_NAMESPACE)), 'namespace never enters changed_paths');
  });

  it('filters the namespace at the projection layer even in front of an injected SnapshotProvider', async () => {
    const root = await makeTemp('aif-dc-qa2-');
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
          'docs/spec.md': Buffer.from('# Spec\n'),
          [`.ai-factory/state/${DECISION_CORRECTIONS_NAMESPACE}/work/cases/case-1.json`]: Buffer.from('{}'),
          [`.ai-factory/state/${DECISION_CORRECTIONS_NAMESPACE}/.gitignore`]: Buffer.from('*\n'),
        },
        directory_names: [`.ai-factory/state/${DECISION_CORRECTIONS_NAMESPACE}/work`],
        ignored_names: [`.ai-factory/state/${DECISION_CORRECTIONS_NAMESPACE}/work/cases/case-1.json`],
        changed_paths: [`.ai-factory/state/${DECISION_CORRECTIONS_NAMESPACE}/work/cases/case-1.json`],
      }),
    };
    const snapshot = await observeQaSnapshot(store, payload, { SnapshotProvider: injected });
    const leak = (p) => p.includes(DECISION_CORRECTIONS_NAMESPACE);
    assert.ok(!Object.keys(snapshot.files).some(leak), 'injected-provider files must not leak the namespace');
    assert.ok(!snapshot.ignored_names.some(leak), 'injected-provider ignored_names must not leak the namespace');
    assert.ok(!snapshot.changed_paths.some(leak), 'injected-provider changed_paths must not leak the namespace');
    assert.ok(snapshot.files['docs/spec.md'], 'presented scope stays projected');
  });

  it('refuses a declared root inside the namespace fail-closed (self-referential-input)', async () => {
    const root = await makeTemp('aif-dc-qa3-');
    const options = await seedGitProject(root);
    const store = await qaStore(options);
    const { payload } = await store.manifest();
    // The constant namespace is not owned by one QA target: a scope that
    // declares the store itself as a dependency must fail closed instead of
    // silently projecting (or silently hiding) its own evidence store.
    const poisoned = JSON.parse(JSON.stringify(payload));
    poisoned.checks[0].inputs = [`.ai-factory/state/${DECISION_CORRECTIONS_NAMESPACE}`];
    await assert.rejects(
      () => observeQaSnapshot(store, poisoned),
      (error) => error?.code === 'self-referential-input',
    );
  });

  it('closes the namespace regardless of the QA target id (constant store namespace)', async () => {
    const root = await makeTemp('aif-dc-qa4-');
    const options = await seedGitProject(root);
    const store = await qaStore(options);
    const { payload } = await store.manifest();
    // The store is shared by the whole command, so the closure must not be
    // tied to payload.target.id: a different target id still excludes it.
    const injected = {
      observe: async () => ({
        complete: true,
        worktree_identity: 'b'.repeat(64),
        modules: { 'scripts/qa-manifest.mjs': digest('y') },
        actual_diff: null,
        files: {
          [`.ai-factory/state/${DECISION_CORRECTIONS_NAMESPACE}/other-scope/cases/case-9.json`]: Buffer.from('{}'),
        },
        directory_names: [],
        ignored_names: [],
        changed_paths: [],
      }),
    };
    const snapshot = await observeQaSnapshot(store, payload, { SnapshotProvider: injected });
    assert.ok(!Object.keys(snapshot.files).some((p) => p.includes(DECISION_CORRECTIONS_NAMESPACE)),
      'the constant namespace stays closed for every target id');
  });
});

// ---------------------------------------------------------------------------
// Closed schemas: schema-side literal parity (the runtime builder parity
// joins when the engine lands). The schemas use only the repository's
// json-schema-subset keywords, keep additionalProperties:false on every
// level, and never authorize progression (authorizes: maxItems 0).
// ---------------------------------------------------------------------------

const CASE_SCHEMA = parseStrictJson(await readFile(path.join(REPO_ROOT, 'schemas', 'decision-correction-fixture.schema.json'), 'utf8'));
const RUN_SCHEMA = parseStrictJson(await readFile(path.join(REPO_ROOT, 'schemas', 'decision-correction-run.schema.json'), 'utf8'));
const FIXTURE_BYTES = '# Spec\n\n- R1: The system shall store data.\n';

function fixtureSha256(bytes) {
  return digest(Buffer.from(bytes, 'utf8'));
}

function literalCasePayload() {
  return {
    case_id: 'dev-case-1',
    scope: 'work',
    partition: 'development',
    ambiguity: 'clear',
    logical_identity: 'a'.repeat(64),
    identity: {
      scope: 'work',
      partition: 'development',
      source_observation: { schema: 'aifhub.requirement_lint_observation.v1', structural: { requirements: 2 } },
      subject_revision: 'r1',
      input_revisions: { 'docs/spec.md': fixtureSha256(FIXTURE_BYTES) },
      question: { id: 'are requirements consistent', version: '1' },
      rubric: { id: 'consistency', version: '1' },
    },
    fixture: {
      version: 1,
      kind: 'synthetic',
      files: [{ path: 'docs/spec.md', media_type: 'text/markdown', sha256: fixtureSha256(FIXTURE_BYTES), bytes: FIXTURE_BYTES }],
    },
    original_assessment: { consumer: 'requirements_semantic_lint', verdict: 'two findings reported', summary: null },
    expected_label: 'no findings reported',
    expected_label_confirmed: false,
    rationale: 'owner review',
    feedback: null,
    replay: { args: ['--change', 'work'] },
    evolution: null,
  };
}

function literalCaseRecord() {
  const payload = literalCasePayload();
  return {
    schema: 'aifhub.decision_correction_fixture.v1',
    diagnostic_only: true,
    authorizes: [],
    status: 'draft',
    status_reason: null,
    payload_digest: digest(canonical(payload)),
    payload,
  };
}

function literalRunRecord() {
  return {
    schema: 'aifhub.decision_correction_run.v1',
    diagnostic_only: true,
    authorizes: [],
    run_id: 'run-0001',
    scope: 'work',
    written: false,
    honesty_note: 'Run verifies the current implementation against stored fixtures; it does not measure provider quality.',
    counts: {
      development: { cases: 1, holds: 0, false_regression: 0, label_change: 1, ambiguous: 0, not_run: 0, stale: 0 },
      calibration: { cases: 0, holds: 0, false_regression: 0, label_change: 0, ambiguous: 0, not_run: 0, stale: 0 },
      held_out: { cases: 0, holds: 0, false_regression: 0, label_change: 0, ambiguous: 0, not_run: 0, stale: 0 },
    },
    cases: [{
      case_id: 'dev-case-1',
      consumer: 'requirements_semantic_lint',
      partition: 'development',
      status: 'confirmed',
      ambiguity: 'clear',
      outcome: 'label_change',
      signature: 'run_status=complete; findings=none; diagnostics=none',
    }],
  };
}

describe('decision-corrections closed schema parity', () => {
  it('accepts a hand-built schema-shaped case record and run record', () => {
    assert.deepEqual(validateJsonAgainstSchema(literalCaseRecord(), CASE_SCHEMA), []);
    assert.deepEqual(validateJsonAgainstSchema(literalRunRecord(), RUN_SCHEMA), []);
  });

  it('rejects an extra field at the record and payload levels', () => {
    const record = literalCaseRecord();
    record.telemetry = true;
    assert.ok(validateJsonAgainstSchema(record, CASE_SCHEMA).length > 0, 'record-level additionalProperties must be closed');
    const payloadRecord = literalCaseRecord();
    payloadRecord.payload.export_to = 'somewhere';
    assert.ok(validateJsonAgainstSchema(payloadRecord, CASE_SCHEMA).length > 0, 'payload-level additionalProperties must be closed');
    const run = literalRunRecord();
    run.extra = 1;
    assert.ok(validateJsonAgainstSchema(run, RUN_SCHEMA).length > 0, 'run-record additionalProperties must be closed');
  });

  it('never authorizes progression and stays diagnostic-only by schema', () => {
    const record = literalCaseRecord();
    record.authorizes = ['verify'];
    assert.ok(validateJsonAgainstSchema(record, CASE_SCHEMA).length > 0, 'authorizes must have maxItems 0');
    record.diagnostic_only = false;
    assert.ok(validateJsonAgainstSchema(record, CASE_SCHEMA).length > 0, 'diagnostic_only must stay true');
    const run = literalRunRecord();
    run.authorizes = ['review'];
    assert.ok(validateJsonAgainstSchema(run, RUN_SCHEMA).length > 0);
  });

  it('rejects unknown enum values and malformed digests', () => {
    const record = literalCaseRecord();
    record.status = 'archived';
    assert.ok(validateJsonAgainstSchema(record, CASE_SCHEMA).length > 0);
    const partitionRecord = literalCaseRecord();
    partitionRecord.payload.partition = 'shadow';
    assert.ok(validateJsonAgainstSchema(partitionRecord, CASE_SCHEMA).length > 0);
    const digestRecord = literalCaseRecord();
    digestRecord.payload_digest = 'not-a-digest';
    assert.ok(validateJsonAgainstSchema(digestRecord, CASE_SCHEMA).length > 0);
    const outcomeRun = literalRunRecord();
    outcomeRun.cases[0].outcome = 'tuned';
    assert.ok(validateJsonAgainstSchema(outcomeRun, RUN_SCHEMA).length > 0, 'run outcomes must stay in the closed set');
  });
});

// ---------------------------------------------------------------------------
// Engine (#285): store, identity/dedup, lifecycle, privacy, evolution link,
// replay runner, CLI. Every scenario runs in a disposable temp project.
// ---------------------------------------------------------------------------

import {
  DECISION_CORRECTIONS_SCHEMA,
  HONESTY_NOTE,
  assertPayloadInvariants,
  computeLogicalIdentity,
  decisionCorrectionsCommand,
  hasCorrectionsLeak,
  parseDecisionCorrectionsConfigSubset,
  projectIdentityObservation,
  readDecisionCorrectionsConfig,
  runDecisionCorrectionsCommand,
} from './decision-corrections.mjs';
import { evolutionCommand } from './evolution-transactions.mjs';

const SPEC_BYTES = '# Spec\n\n- R1: The system shall store data.\n- R2: The system shall not lose data.\n';
const ENABLED_CONFIG = 'aifhub:\n  requirementLint:\n    enabled: true\n';

async function readdirSafe(dir) {
  try {
    return await (await import('node:fs/promises')).readdir(dir);
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

async function seedStoreProject(root, { config = undefined } = {}) {
  await mkdir(path.join(root, 'docs'), { recursive: true });
  await mkdir(path.join(root, '.ai-factory'), { recursive: true });
  await writeFile(path.join(root, 'docs', 'spec.md'), SPEC_BYTES);
  if (config !== undefined) await writeFile(path.join(root, '.ai-factory', 'config.yaml'), config);
}

function baseCaseInput(overrides = {}) {
  return {
    case_id: 'dev-case-1',
    scope: 'work',
    partition: 'development',
    ambiguity: 'clear',
    identity: {
      source_observation: { schema: 'aifhub.requirement_lint_observation.v1', change_id: 'work', structural: { requirements: 2 } },
      subject_revision: 'r1',
      input_paths: ['docs/spec.md'],
      question: { id: 'are requirements consistent', version: '1' },
      rubric: { id: 'consistency', version: '1' },
    },
    fixture: {
      kind: 'synthetic',
      files: [
        { path: '.ai-factory/config.yaml', media_type: 'text/yaml', bytes: ENABLED_CONFIG },
        { path: 'docs/spec.md', media_type: 'text/markdown', bytes: SPEC_BYTES },
      ],
    },
    original_assessment: { consumer: 'requirements_semantic_lint', verdict: 'two findings reported', summary: null },
    expected_label: 'no findings reported',
    rationale: 'owner review',
    replay: { args: ['--change', 'work'] },
    ...overrides,
  };
}

const STORE_OPTIONS = () => ({ enabled: true });

async function saveCase(root, input, options = {}) {
  const preview = await decisionCorrectionsCommand('preview', input, { rootDir: root, ...STORE_OPTIONS(), ...options });
  if (preview.idempotent) return { preview, saved: preview };
  const saved = await decisionCorrectionsCommand('save', { ...input, payload_digest: preview.payload_digest }, { rootDir: root, ...STORE_OPTIONS(), ...options });
  return { preview, saved };
}

async function confirmCase(root, input, options = {}) {
  const preview = await decisionCorrectionsCommand('preview', input, { rootDir: root, ...STORE_OPTIONS(), ...options });
  return decisionCorrectionsCommand('confirm', {
    case_id: input.case_id, scope: input.scope, expected_label: input.expected_label, payload_digest: preview.payload_digest,
  }, { rootDir: root, ...STORE_OPTIONS(), ...options });
}

describe('decision-corrections enablement and state-root guards', () => {
  it('is off by default and refuses operations without opt-in', async () => {
    const root = await makeTemp('aif-dc-off-');
    await seedStoreProject(root);
    await assert.rejects(
      () => decisionCorrectionsCommand('list', { scope: 'work' }, { rootDir: root }),
      (error) => error?.code === 'decision-corrections-disabled' && error.blocked === true,
    );
    // CLI opt-in enables it even with no config key present.
    const listed = await decisionCorrectionsCommand('list', { scope: 'work' }, { rootDir: root, enabled: true });
    assert.equal(listed.ok, true);
  });

  it('refuses a custom paths.state before any write (state-root-mismatch)', async () => {
    const root = await makeTemp('aif-dc-root-');
    await seedStoreProject(root, { config: 'paths:\n  state: .ai-factory/other-state\n' });
    const input = baseCaseInput();
    await assert.rejects(
      () => decisionCorrectionsCommand('preview', input, { rootDir: root, enabled: true }),
      (error) => error?.code === 'state-root-mismatch' && error.blocked === true,
    );
    // The state-root gate is live on the scalar form too (structural paths).
    const scalarConfig = await readDecisionCorrectionsConfig(root, { readConfigBytes: async () => Buffer.from('paths: .ai-factory/other-state\n', 'utf8') });
    assert.equal(scalarConfig.enabledMalformed, true);
    assert.ok(scalarConfig.diagnostics.some((d) => d.code === 'decision-corrections:scalarized-section'));
  });
});

describe('decision-corrections closed config parser', () => {
  it('keeps unknown, duplicate, and malformed namespaces off even against a CLI override', async () => {
    const root = await makeTemp('aif-dc-config-');
    await seedStoreProject(root);
    const unknown = await readDecisionCorrectionsConfig(root, { readConfigBytes: async () => Buffer.from('aifhub:\n  decisionCorrections:\n    enabled: true\n    mode: aggressive\n', 'utf8') });
    assert.equal(unknown.enabledMalformed, true);
    assert.ok(unknown.diagnostics.some((d) => d.code === 'decision-corrections:unknown-key'));
    const duplicate = await readDecisionCorrectionsConfig(root, { readConfigBytes: async () => Buffer.from('aifhub:\n  decisionCorrections:\n    enabled: true\n    enabled: false\n', 'utf8') });
    assert.equal(duplicate.enabledMalformed, true);
    assert.ok(duplicate.diagnostics.some((d) => d.code === 'decision-corrections:duplicate-key'));
    const quoted = await readDecisionCorrectionsConfig(root, { readConfigBytes: async () => Buffer.from("aifhub:\n  decisionCorrections:\n    enabled: 'true'\n", 'utf8') });
    assert.equal(quoted.enabledMalformed, true);
    assert.ok(quoted.diagnostics.some((d) => d.code === 'decision-corrections:quoted-boolean'));
    const scalar = await readDecisionCorrectionsConfig(root, { readConfigBytes: async () => Buffer.from('aifhub: decisionCorrections\n', 'utf8') });
    assert.equal(scalar.enabledMalformed, true);
    assert.ok(scalar.diagnostics.some((d) => d.code === 'decision-corrections:scalarized-section'));
    // A well-formed key enables via config alone (no CLI flag needed).
    const valid = await readDecisionCorrectionsConfig(root, { readConfigBytes: async () => Buffer.from('aifhub:\n  decisionCorrections:\n    enabled: true\n', 'utf8') });
    assert.equal(valid.enabledMalformed, false);
    assert.equal(valid.enabled, true);
    // Malformed config forces off despite CLI true.
    const input = baseCaseInput({ case_id: 'cfg-case' });
    await assert.rejects(
      () => decisionCorrectionsCommand('preview', input, { rootDir: root, enabled: true, config: unknown }),
      (error) => error?.code === 'decision-corrections-disabled',
    );
    void parseDecisionCorrectionsConfigSubset;
  });
});

describe('decision-corrections identity projection and dedup matrix', () => {
  it('projects volatile observation fields away and keeps the identity stable', async () => {
    const projected = projectIdentityObservation({
      schema: 'aifhub.requirement_lint_observation.v1',
      change_id: 'work',
      structural: { requirements: 2 },
      generated_at: '2026-11-08T00:00:00.000Z',
      elapsed_ms: 42,
      binding: { helper: 'sha' },
    });
    assert.deepEqual(Object.keys(projected).sort(), ['change_id', 'schema', 'structural']);
    const material = {
      scope: 'work',
      partition: 'development',
      source_observation: projected,
      subject_revision: 'r1',
      input_revisions: { 'docs/spec.md': digest(SPEC_BYTES) },
      question: { id: 'q', version: '1' },
      rubric: { id: 'r', version: '1' },
    };
    assert.equal(computeLogicalIdentity(material), computeLogicalIdentity({ ...material }));
    // A nested volatile key inside an allowlisted field is incompatible: loud
    // refusal instead of a digest that cannot round-trip.
    assert.throws(
      () => computeLogicalIdentity({ ...material, source_observation: { schema: 'x', findings: [{ generated_at: 1 }] } }),
      /identity-source-incompatible|binding input/,
    );
    // The partition is part of the identity: relabeling creates a new case.
    assert.notEqual(computeLogicalIdentity({ ...material, partition: 'held_out' }), computeLogicalIdentity(material));
  });

  it('is idempotent for the same identity and payload, without a new record or confirmation reset', async () => {
    const root = await makeTemp('aif-dc-idem-');
    await seedStoreProject(root);
    const input = baseCaseInput();
    const { preview, saved } = await saveCase(root, input);
    assert.equal(saved.created, true);
    const confirmed = await confirmCase(root, input);
    assert.equal(confirmed.case.status, 'confirmed');
    // Re-preview of the identical material resolves to the stored payload
    // (with its post-confirmation digest), never to a new revision.
    const again = await decisionCorrectionsCommand('preview', input, { rootDir: root, ...STORE_OPTIONS() });
    assert.equal(again.idempotent, true);
    assert.equal(again.payload_digest, confirmed.case.payload_digest);
    const resaved = await decisionCorrectionsCommand('save', { ...input, payload_digest: again.payload_digest }, { rootDir: root, ...STORE_OPTIONS() });
    assert.equal(resaved.idempotent, true);
    assert.equal(resaved.case.status, 'confirmed', 'idempotent re-save must not demote a confirmed case');
  });

  it('refuses the same identity with a changed payload under another case_id (revision-conflict)', async () => {
    const root = await makeTemp('aif-dc-rev-');
    await seedStoreProject(root);
    await saveCase(root, baseCaseInput());
    const other = baseCaseInput({ case_id: 'dev-case-2', expected_label: 'a different label' });
    await assert.rejects(() => saveCase(root, other), (error) => error?.code === 'revision-conflict' && error.blocked === true);
  });

  it('refuses the same case_id with a different identity (case-identity-collision)', async () => {
    const root = await makeTemp('aif-dc-coll-');
    await seedStoreProject(root);
    await saveCase(root, baseCaseInput());
    const colliding = baseCaseInput({ identity: { ...baseCaseInput().identity, subject_revision: 'r2' } });
    await assert.rejects(
      () => decisionCorrectionsCommand('preview', colliding, { rootDir: root, ...STORE_OPTIONS() }),
      (error) => error?.code === 'case-identity-collision',
    );
  });

  it('refuses Windows case-only case_id collisions deterministically', async () => {
    const root = await makeTemp('aif-dc-case-');
    await seedStoreProject(root);
    await saveCase(root, baseCaseInput({ case_id: 'Case-1' }));
    await assert.rejects(
      () => decisionCorrectionsCommand('preview', baseCaseInput({ case_id: 'CASE-1' }), { rootDir: root, ...STORE_OPTIONS() }),
      (error) => error?.code === 'case-collision',
    );
  });

  it('separates scopes by construction (no merge)', async () => {
    const root = await makeTemp('aif-dc-scope-');
    await seedStoreProject(root);
    await saveCase(root, baseCaseInput({ scope: 'alpha' }));
    await saveCase(root, baseCaseInput({ scope: 'beta' }));
    const alpha = await decisionCorrectionsCommand('list', { scope: 'alpha' }, { rootDir: root, ...STORE_OPTIONS() });
    const beta = await decisionCorrectionsCommand('list', { scope: 'beta' }, { rootDir: root, ...STORE_OPTIONS() });
    assert.equal(alpha.cases.length, 1);
    assert.equal(beta.cases.length, 1);
    assert.notEqual(alpha.cases[0].logical_identity, beta.cases[0].logical_identity, 'scope is an identity input');
  });

  it('serializes dedup-check and write through the scope write lock (state-locked refusal)', async () => {
    const root = await makeTemp('aif-dc-lock-');
    await seedStoreProject(root);
    const lockPath = path.join(root, '.ai-factory', 'state', DECISION_CORRECTIONS_NAMESPACE, 'work', 'write.lock');
    await mkdir(path.dirname(lockPath), { recursive: true });
    const { open } = await import('node:fs/promises');
    const handle = await open(lockPath, 'wx');
    try {
      await assert.rejects(() => saveCase(root, baseCaseInput()), (error) => error?.code === 'state-locked' && error.blocked === true);
    } finally {
      await handle.close();
      await rm(lockPath, { force: true });
    }
  });
});

describe('decision-corrections digest-bound preview and save', () => {
  it('previews the full payload with a digest and writes nothing', async () => {
    const root = await makeTemp('aif-dc-preview-');
    await seedStoreProject(root);
    const input = baseCaseInput();
    const preview = await decisionCorrectionsCommand('preview', input, { rootDir: root, ...STORE_OPTIONS() });
    assert.equal(preview.ok, true);
    assert.equal(preview.payload.case_id, input.case_id);
    assert.equal(preview.payload.fixture.files[1].bytes, SPEC_BYTES, 'fixture bytes stay exact');
    assert.match(preview.payload_digest, /^[a-f0-9]{64}$/);
    const casesDir = path.join(root, '.ai-factory', 'state', DECISION_CORRECTIONS_NAMESPACE, 'work', 'cases');
    await assert.rejects(() => readFile(path.join(casesDir, `${input.case_id}.json`)), /ENOENT/, 'preview must not write a case file');
  });

  it('saves a draft on a matching digest echo and refuses without any artifact on a mismatch', async () => {
    const root = await makeTemp('aif-dc-save-');
    await seedStoreProject(root);
    const input = baseCaseInput();
    const preview = await decisionCorrectionsCommand('preview', input, { rootDir: root, ...STORE_OPTIONS() });
    const saved = await decisionCorrectionsCommand('save', { ...input, payload_digest: preview.payload_digest }, { rootDir: root, ...STORE_OPTIONS() });
    assert.equal(saved.ok, true);
    assert.equal(saved.case.status, 'draft');
    await assert.rejects(
      () => decisionCorrectionsCommand('save', { ...baseCaseInput({ case_id: 'dev-case-9' }), payload_digest: 'f'.repeat(64) }, { rootDir: root, ...STORE_OPTIONS() }),
      (error) => error?.code === 'payload-mismatch' && error.blocked === true,
    );
    const scopeDir = path.join(root, '.ai-factory', 'state', DECISION_CORRECTIONS_NAMESPACE, 'work');
    const leftovers = (await readdirSafe(path.join(scopeDir, 'cases'))).filter((name) => name !== '.gitignore');
    assert.deepEqual(leftovers, ['dev-case-1.json'], 'a refused save leaves no case artifacts');
    assert.equal((await readdirSafe(scopeDir)).includes('write.lock'), false, 'a refused save leaves no lock');
  });

  it('keeps the runtime builder in parity with the closed schema and catches tampering with invariants', async () => {
    const root = await makeTemp('aif-dc-parity-');
    await seedStoreProject(root);
    const { saved } = await saveCase(root, baseCaseInput());
    const schema = parseStrictJson(await readFile(path.join(REPO_ROOT, 'schemas', 'decision-correction-fixture.schema.json'), 'utf8'));
    assert.deepEqual(validateJsonAgainstSchema(saved.case, schema), [], 'a runtime-built case must pass its closed schema');
    // Schema-valid tampering is caught by the cross-field invariants, not by
    // the schema: the digest no longer matches the payload.
    const tampered = JSON.parse(JSON.stringify(saved.case));
    tampered.payload.expected_label = 'silent relabel';
    assert.deepEqual(validateJsonAgainstSchema(tampered, schema), [], 'the tampered record stays schema-valid');
    assert.throws(() => assertPayloadInvariants(tampered), /-mismatch|WorkflowError/);
    const tamperedIdentity = JSON.parse(JSON.stringify(saved.case));
    tamperedIdentity.payload.identity.subject_revision = 'r-rewritten';
    assert.throws(() => assertPayloadInvariants(tamperedIdentity), /-mismatch|WorkflowError/);
    const tamperedFixture = JSON.parse(JSON.stringify(saved.case));
    tamperedFixture.payload.fixture.files[1].bytes = `${tamperedFixture.payload.fixture.files[1].bytes}x`;
    assert.throws(() => assertPayloadInvariants(tamperedFixture), /-mismatch|WorkflowError/);
    const tamperedLogical = JSON.parse(JSON.stringify(saved.case));
    tamperedLogical.payload.logical_identity = 'a'.repeat(64);
    tamperedLogical.payload_digest = digest(canonical(tamperedLogical.payload));
    assert.deepEqual(validateJsonAgainstSchema(tamperedLogical, schema), [], 'schema-valid with a consistent digest');
    assert.throws(() => assertPayloadInvariants(tamperedLogical), /-mismatch|WorkflowError/);
    void DECISION_CORRECTIONS_SCHEMA;
  });
});

describe('decision-corrections lifecycle, ambiguity, and re-confirmation', () => {
  it('confirms only with the expected label and the current payload digest', async () => {
    const root = await makeTemp('aif-dc-confirm-');
    await seedStoreProject(root);
    const input = baseCaseInput();
    const { preview } = await saveCase(root, input);
    await assert.rejects(
      () => decisionCorrectionsCommand('confirm', { case_id: input.case_id, scope: input.scope, expected_label: 'wrong label', payload_digest: preview.payload_digest }, { rootDir: root, ...STORE_OPTIONS() }),
      (error) => error?.code === 'label-mismatch',
    );
    await assert.rejects(
      () => decisionCorrectionsCommand('confirm', { case_id: input.case_id, scope: input.scope, expected_label: input.expected_label, payload_digest: 'a'.repeat(64) }, { rootDir: root, ...STORE_OPTIONS() }),
      (error) => error?.code === 'payload-mismatch',
    );
    const confirmed = await confirmCase(root, input);
    assert.equal(confirmed.case.status, 'confirmed');
    assert.equal(confirmed.case.payload.expected_label_confirmed, true);
  });

  it('resets confirmation after a redaction and requires a fresh digest to confirm again', async () => {
    const root = await makeTemp('aif-dc-redact-');
    await seedStoreProject(root);
    const input = baseCaseInput();
    const { preview } = await saveCase(root, input);
    await confirmCase(root, input);
    const redacted = baseCaseInput({
      fixture: {
        kind: 'redacted',
        files: [
          { path: '.ai-factory/config.yaml', media_type: 'text/yaml', bytes: ENABLED_CONFIG },
          { path: 'docs/spec.md', media_type: 'text/markdown', bytes: `${SPEC_BYTES}\n<!-- secret removed -->\n` },
        ],
      },
    });
    const redactionPreview = await decisionCorrectionsCommand('preview', redacted, { rootDir: root, ...STORE_OPTIONS() });
    assert.equal(redactionPreview.payload.fixture.version, 2, 'redaction creates the next fixture version');
    assert.equal(redactionPreview.payload.expected_label_confirmed, false);
    assert.notEqual(redactionPreview.payload_digest, preview.payload_digest);
    // The old digest no longer confirms anything.
    await assert.rejects(
      () => decisionCorrectionsCommand('confirm', { case_id: input.case_id, scope: input.scope, expected_label: input.expected_label, payload_digest: preview.payload_digest }, { rootDir: root, ...STORE_OPTIONS() }),
      (error) => error?.code === 'payload-mismatch',
    );
    const saved = await decisionCorrectionsCommand('save', { ...redacted, payload_digest: redactionPreview.payload_digest }, { rootDir: root, ...STORE_OPTIONS() });
    assert.equal(saved.case.status, 'draft');
    assert.equal(saved.case.payload.expected_label_confirmed, false);
    const reConfirmed = await decisionCorrectionsCommand('confirm', {
      case_id: input.case_id, scope: input.scope, expected_label: input.expected_label, payload_digest: redactionPreview.payload_digest,
    }, { rootDir: root, ...STORE_OPTIONS() });
    assert.equal(reConfirmed.case.status, 'confirmed');
    assert.equal(reConfirmed.case.payload.fixture.version, 2);
  });

  it('supports reject and supersede on every status', async () => {
    const root = await makeTemp('aif-dc-lifecycle-');
    await seedStoreProject(root);
    await saveCase(root, baseCaseInput({ case_id: 'dev-reject-1' }));
    const rejected = await decisionCorrectionsCommand('reject', { case_id: 'dev-reject-1', scope: 'work', reason: 'superseded by review' }, { rootDir: root, ...STORE_OPTIONS() });
    assert.equal(rejected.case.status, 'rejected');
    const reRejected = await decisionCorrectionsCommand('reject', { case_id: 'dev-reject-1', scope: 'work' }, { rootDir: root, ...STORE_OPTIONS() });
    assert.equal(reRejected.case.status, 'rejected', 'transitions are defined on every status and repeatable');
    await saveCase(root, baseCaseInput({ case_id: 'dev-supersede-1', identity: { ...baseCaseInput().identity, subject_revision: 'rev-supersede' }, ambiguity: 'ambiguous' }));
    const superseded = await decisionCorrectionsCommand('supersede', { case_id: 'dev-supersede-1', scope: 'work' }, { rootDir: root, ...STORE_OPTIONS() });
    assert.equal(superseded.case.status, 'superseded');
  });
});

describe('decision-corrections privacy fail-closed', () => {
  it('refuses secret-like, path-like, URL-like, NUL, and oversize feedback bodies with typed codes', async () => {
    const root = await makeTemp('aif-dc-leak-');
    await seedStoreProject(root);
    const cases = [
      { name: 'url', overrides: { rationale: 'reviewed at https://attacker.invalid/x' } },
      { name: 'windows-path', overrides: { rationale: 'see C:\\\\Users\\\\someone\\\\file' } },
      { name: 'token', overrides: { feedback: 'token ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA embedded' } },
      { name: 'private-key', overrides: { feedback: '-----BEGIN RSA PRIVATE KEY-----' } },
      { name: 'nul', overrides: { feedback: 'bad\0text' } },
    ];
    for (const item of cases) {
      await assert.rejects(
        () => saveCase(root, baseCaseInput({ case_id: `case-${item.name}`, identity: { ...baseCaseInput().identity, subject_revision: `rev-${item.name}` }, ...item.overrides })),
        (error) => error?.code === 'privacy-leak' || error?.code === 'invalid-feedback' || error?.code === 'invalid-rationale',
        `leak case ${item.name} must refuse`,
      );
    }
    assert.equal(hasCorrectionsLeak({ unc: '\\\\\\\\server' }), true, 'UNC shapes are leak indicators');
    await assert.rejects(
      () => saveCase(root, baseCaseInput({ case_id: 'case-oversize', identity: { ...baseCaseInput().identity, subject_revision: 'rev-oversize' }, rationale: 'x'.repeat(3000) })),
      (error) => error?.code === 'invalid-rationale',
    );
  });

  it('never echoes payload content through the CLI envelope and strips a leaking envelope', async () => {
    const root = await makeTemp('aif-dc-envelope-');
    await seedStoreProject(root);
    const outputs = [];
    const secretLabel = `label with ghp_${'A'.repeat(30)} inside`;
    const exit = await runDecisionCorrectionsCommand(['preview', '--json'], {
      rootDir: root, enabled: true, output: (value) => outputs.push(value),
      readStdin: async () => Buffer.from(JSON.stringify(baseCaseInput({ expected_label: secretLabel })), 'utf8'),
    });
    assert.equal(exit, 1, 'a leaking request refuses blocked');
    const printed = outputs.join('');
    assert.ok(!printed.includes('ghp_'), 'the envelope must not echo the leaking content');
    assert.ok(printed.includes('privacy-leak'));
  });
});

describe('decision-corrections held-out immunity', () => {
  it('refuses confirm/reject/supersede on held-out cases before any engine call (must-not-call)', async () => {
    const root = await makeTemp('aif-dc-heldout-');
    await seedStoreProject(root);
    const input = baseCaseInput({ case_id: 'heldout-case-1', partition: 'held_out' });
    await saveCase(root, input);
    let engineCalls = 0;
    const spyOptions = { rootDir: root, ...STORE_OPTIONS(), assessor: async () => { engineCalls += 1; return { findings: [] }; } };
    await assert.rejects(
      () => decisionCorrectionsCommand('confirm', { case_id: input.case_id, scope: input.scope, expected_label: input.expected_label, payload_digest: '0'.repeat(64) }, spyOptions),
      (error) => error?.code === 'held-out-tuning' && error.blocked === true,
    );
    await assert.rejects(
      () => decisionCorrectionsCommand('reject', { case_id: input.case_id, scope: input.scope }, spyOptions),
      (error) => error?.code === 'held-out-tuning',
    );
    await assert.rejects(
      () => decisionCorrectionsCommand('supersede', { case_id: input.case_id, scope: input.scope }, spyOptions),
      (error) => error?.code === 'held-out-tuning',
    );
    assert.equal(engineCalls, 0, 'the replay engine must never be invoked for a held-out mutation path');
    const listed = await decisionCorrectionsCommand('list', { scope: 'work', partition_filter: 'held_out' }, { rootDir: root, ...STORE_OPTIONS() });
    assert.equal(listed.cases[0].status, 'draft', 'held-out stays report-only');
  });

  it('treats a partition relabel as a new identity, keeping the original case intact', async () => {
    const root = await makeTemp('aif-dc-relabel-');
    await seedStoreProject(root);
    await saveCase(root, baseCaseInput({ case_id: 'dev-original' }));
    await saveCase(root, baseCaseInput({ case_id: 'heldout-copy', partition: 'held_out' }));
    const listed = await decisionCorrectionsCommand('list', { scope: 'work' }, { rootDir: root, ...STORE_OPTIONS() });
    assert.equal(listed.cases.length, 2);
    const dev = listed.cases.find((item) => item.case_id === 'dev-original');
    const held = listed.cases.find((item) => item.case_id === 'heldout-copy');
    assert.notEqual(dev.logical_identity, held.logical_identity);
  });
});

describe('decision-corrections evolution link', () => {
  async function seedTransaction(root, transactionId, { apply = true } = {}) {
    await writeFile(path.join(root, 'docs', 'evidence.md'), 'evidence for the transaction\n');
    const proposal = {
      transaction_id: transactionId,
      skill: 'aif-implement',
      after: `# Updated context for ${transactionId}\n`,
      reason: 'repair installed helper context',
      evidence: ['docs/evidence.md'],
    };
    const proposed = await evolutionCommand('propose', proposal, { rootDir: root });
    if (apply) await evolutionCommand('apply', { transaction_id: transactionId, proposal_digest: proposed.proposal_digest }, { rootDir: root });
    return proposed;
  }

  it('accepts a link to an applied transaction with a matching digest', async () => {
    const root = await makeTemp('aif-dc-tx1-');
    await seedStoreProject(root);
    const proposed = await seedTransaction(root, 'tx-applied');
    const input = baseCaseInput({ case_id: 'dev-tx-1', evolution: { transaction_id: 'tx-applied', proposal_digest: proposed.proposal_digest } });
    const { saved } = await saveCase(root, input);
    assert.equal(saved.ok, true);
    const shown = await decisionCorrectionsCommand('show', { case_id: input.case_id, scope: input.scope }, { rootDir: root, ...STORE_OPTIONS() });
    assert.equal(shown.evolution.linked, true);
    assert.equal(shown.evolution.active, true, 'an applied transaction is an active application');
    assert.equal(shown.evolution.transaction_status, 'applied');
  });

  it('refuses a missing transaction and a digest mismatch at write time', async () => {
    const root = await makeTemp('aif-dc-tx2-');
    await seedStoreProject(root);
    await seedTransaction(root, 'tx-real');
    await assert.rejects(
      () => saveCase(root, baseCaseInput({ case_id: 'dev-tx-missing', evolution: { transaction_id: 'tx-absent', proposal_digest: 'a'.repeat(64) } })),
      (error) => error?.code === 'missing-or-invalid-transaction',
    );
    await assert.rejects(
      () => saveCase(root, baseCaseInput({ case_id: 'dev-tx-mismatch', evolution: { transaction_id: 'tx-real', proposal_digest: 'b'.repeat(64) } })),
      (error) => error?.code === 'proposal-mismatch',
    );
  });

  it('distinguishes a historical receipt from an active application after rollback', async () => {
    const root = await makeTemp('aif-dc-tx3-');
    await seedStoreProject(root);
    const proposed = await seedTransaction(root, 'tx-rolled');
    const input = baseCaseInput({ case_id: 'dev-tx-rolled', evolution: { transaction_id: 'tx-rolled', proposal_digest: proposed.proposal_digest } });
    await saveCase(root, input);
    await evolutionCommand('rollback', { transaction_id: 'tx-rolled', proposal_digest: proposed.proposal_digest }, { rootDir: root });
    const shown = await decisionCorrectionsCommand('show', { case_id: input.case_id, scope: input.scope }, { rootDir: root, ...STORE_OPTIONS() });
    assert.equal(shown.evolution.linked, true);
    assert.equal(shown.evolution.active, false, 'rolled_back invalidates the active binding');
    assert.equal(shown.evolution.transaction_status, 'rolled_back', 'the historical receipt stays visible');
    assert.equal(shown.evolution.digest_matched, true);
  });

  it('keeps a case valid without a transaction reference', async () => {
    const root = await makeTemp('aif-dc-tx4-');
    await seedStoreProject(root);
    const { saved } = await saveCase(root, baseCaseInput({ case_id: 'dev-no-tx' }));
    assert.equal(saved.case.payload.evolution, null);
    const shown = await decisionCorrectionsCommand('show', { case_id: 'dev-no-tx', scope: 'work' }, { rootDir: root, ...STORE_OPTIONS() });
    assert.equal(shown.evolution.linked, false);
  });
});

describe('decision-corrections replay runner', () => {
  it('previews by default and writes only with --write', async () => {
    const root = await makeTemp('aif-dc-run1-');
    await seedStoreProject(root);
    const input = baseCaseInput();
    await saveCase(root, input);
    await confirmCase(root, input);
    const previewRun = await decisionCorrectionsCommand('run', { scope: 'work' }, { rootDir: root, ...STORE_OPTIONS() });
    assert.equal(previewRun.preview, true);
    assert.equal(previewRun.run.written, false);
    assert.equal(previewRun.run.honesty_note, HONESTY_NOTE, 'the honesty note is verbatim in the output');
    const runsDir = path.join(root, '.ai-factory', 'state', DECISION_CORRECTIONS_NAMESPACE, 'work', 'runs');
    assert.deepEqual(await readdirSafe(runsDir), [], 'a preview run persists nothing');
    const writtenRun = await decisionCorrectionsCommand('run', { scope: 'work', write: true }, { rootDir: root, ...STORE_OPTIONS() });
    assert.equal(writtenRun.preview, false);
    assert.equal(writtenRun.run.written, true);
    assert.equal((await readdirSafe(runsDir)).length, 1, '--write persists exactly one run record');
  });

  it('reports an honest not_run when the advisory scan was not performed and separates outcomes', async () => {
    const root = await makeTemp('aif-dc-run2-');
    await seedStoreProject(root);
    // Fixture bundle WITHOUT the enabling config: the replayed advisory scan
    // honestly reports not_run (never a zero-findings result).
    const disabled = baseCaseInput({
      case_id: 'dev-disabled',
      identity: { ...baseCaseInput().identity, subject_revision: 'rev-disabled' },
      fixture: { kind: 'synthetic', files: [{ path: 'docs/spec.md', media_type: 'text/markdown', bytes: SPEC_BYTES }] },
      expected_label: 'run_status=complete; findings=none; diagnostics=none',
    });
    await saveCase(root, disabled);
    await confirmCase(root, disabled);
    // Ambiguous case: counted, not scored.
    const ambiguous = baseCaseInput({ case_id: 'dev-ambiguous', identity: { ...baseCaseInput().identity, subject_revision: 'rev-ambiguous' }, ambiguity: 'ambiguous' });
    await saveCase(root, ambiguous);
    await confirmCase(root, ambiguous);
    // Draft case: skipped.
    await saveCase(root, baseCaseInput({ case_id: 'dev-draft', identity: { ...baseCaseInput().identity, subject_revision: 'rev-draft' } }));
    // Stale case: confirmed, then its provenance input changes under it.
    await writeFile(path.join(root, 'docs', 'extra.md'), 'extra provenance input\n');
    const stale = baseCaseInput({
      case_id: 'dev-stale',
      identity: {
        ...baseCaseInput().identity,
        subject_revision: 'rev-stale',
        input_paths: ['docs/extra.md'],
      },
    });
    await saveCase(root, stale);
    await confirmCase(root, stale);
    await writeFile(path.join(root, 'docs', 'extra.md'), 'extra provenance input changed\n');
    const run = await decisionCorrectionsCommand('run', { scope: 'work' }, { rootDir: root, ...STORE_OPTIONS() });
    const byId = Object.fromEntries(run.run.cases.map((item) => [item.case_id, item]));
    assert.equal(byId['dev-disabled'].outcome, 'not_run', 'a not-performed advisory scan is never coerced into a label');
    assert.equal(byId['dev-ambiguous'].outcome, 'ambiguous');
    assert.equal(byId['dev-draft'].outcome, 'skipped_draft');
    assert.equal(byId['dev-stale'].outcome, 'stale');
    assert.equal(run.run.counts.development.ambiguous, 1);
    assert.equal(run.run.counts.development.not_run, 1);
    assert.equal(run.run.counts.development.stale, 1);
    assert.equal(run.run.counts.development.cases, 4);
  });

  it('classifies holds, false regression, and label change against original and expected labels', async () => {
    const root = await makeTemp('aif-dc-run3-');
    await seedStoreProject(root);
    // The replayed requirement-lint structural stage over the enabled fixture
    // produces a known signature; three cases pin the three comparison branches.
    const knownSignature = 'run_status=complete; findings=none; diagnostics=none';
    const holdsInput = baseCaseInput({ case_id: 'dev-holds', identity: { ...baseCaseInput().identity, subject_revision: 'rev-holds' }, expected_label: knownSignature });
    await saveCase(root, holdsInput);
    await confirmCase(root, holdsInput);
    const regressionInput = baseCaseInput({
      case_id: 'dev-regression',
      identity: { ...baseCaseInput().identity, subject_revision: 'rev-regression' },
      original_assessment: { consumer: 'requirements_semantic_lint', verdict: knownSignature, summary: null },
      expected_label: 'some other expected label',
    });
    await saveCase(root, regressionInput);
    await confirmCase(root, regressionInput);
    const changeInput = baseCaseInput({
      case_id: 'dev-change',
      identity: { ...baseCaseInput().identity, subject_revision: 'rev-change' },
      original_assessment: { consumer: 'requirements_semantic_lint', verdict: 'the old verdict', summary: null },
      expected_label: 'some expected label',
    });
    await saveCase(root, changeInput);
    await confirmCase(root, changeInput);
    const run = await decisionCorrectionsCommand('run', { scope: 'work' }, { rootDir: root, ...STORE_OPTIONS() });
    const byId = Object.fromEntries(run.run.cases.map((item) => [item.case_id, item]));
    assert.equal(byId['dev-holds'].outcome, 'holds');
    assert.equal(byId['dev-regression'].outcome, 'false_regression', 'matching the original verdict means the misassessment still reproduces');
    assert.equal(byId['dev-change'].outcome, 'label_change');
    assert.equal(run.run.counts.development.holds, 1);
    assert.equal(run.run.counts.development.false_regression, 1);
    assert.equal(run.run.counts.development.label_change, 1);
  });

  it('refuses replay arguments that carry write flags or path syntax', async () => {
    const root = await makeTemp('aif-dc-run4-');
    await seedStoreProject(root);
    await assert.rejects(
      () => saveCase(root, baseCaseInput({ case_id: 'dev-write-arg', replay: { args: ['--write'] } })),
      (error) => error?.code === 'replay-write-forbidden',
    );
    await assert.rejects(
      () => saveCase(root, baseCaseInput({ case_id: 'dev-path-arg', replay: { args: ['--file=../escape'] } })),
      (error) => error?.code === 'unsafe-replay-arg',
    );
  });

  it('refuses an unsupported consumer at save time', async () => {
    const root = await makeTemp('aif-dc-run5-');
    await seedStoreProject(root);
    await assert.rejects(
      () => saveCase(root, baseCaseInput({ case_id: 'dev-unknown-consumer', original_assessment: { consumer: 'context_selection_overlay', verdict: 'x', summary: null } })),
      (error) => error?.code === 'unsupported-consumer',
    );
  });
});

describe('decision-corrections retention and delete', () => {
  it('deletes a case with owned transient surfaces and reports honestly on a repeated delete', async () => {
    const root = await makeTemp('aif-dc-del-');
    await seedStoreProject(root);
    await saveCase(root, baseCaseInput({ case_id: 'dev-delete-1' }));
    await saveCase(root, baseCaseInput({ case_id: 'dev-delete-2', identity: { ...baseCaseInput().identity, subject_revision: 'rev-delete-2' } }));
    const casesDir = path.join(root, '.ai-factory', 'state', DECISION_CORRECTIONS_NAMESPACE, 'work', 'cases');
    // A leftover crashed-writer temp sibling is cleaned up together with the case.
    await writeFile(path.join(casesDir, 'dev-delete-1.json.deadbeef.tmp'), 'partial');
    const deleted = await decisionCorrectionsCommand('delete', { case_id: 'dev-delete-1', scope: 'work' }, { rootDir: root, ...STORE_OPTIONS() });
    assert.equal(deleted.deleted, true);
    assert.deepEqual((await readdirSafe(casesDir)).filter((name) => name.endsWith('.json')), ['dev-delete-2.json'], 'other cases stay untouched');
    assert.equal((await readdirSafe(casesDir)).some((name) => name.endsWith('.tmp')), false, 'owned temp siblings are cleaned up');
    assert.equal((await readdirSafe(path.join(root, '.ai-factory', 'state', DECISION_CORRECTIONS_NAMESPACE))).includes('.gitignore'), true, 'the namespace .gitignore survives');
    const again = await decisionCorrectionsCommand('delete', { case_id: 'dev-delete-1', scope: 'work' }, { rootDir: root, ...STORE_OPTIONS() });
    assert.equal(again.deleted, false, 'a repeated delete honestly reports absence');
  });
});

describe('decision-corrections CLI contracts', () => {
  function cliOptions(root, { input = null, outputs = [] } = {}) {
    return {
      rootDir: root,
      enabled: true,
      output: (value) => outputs.push(value),
      readStdin: async () => (input === null ? Buffer.alloc(0) : Buffer.from(typeof input === 'string' ? input : JSON.stringify(input), 'utf8')),
    };
  }

  it('maps exit codes 0/1/2 and accepts flag-only reads', async () => {
    const root = await makeTemp('aif-dc-cli-');
    await seedStoreProject(root);
    const outputs = [];
    assert.equal(await runDecisionCorrectionsCommand(['list', '--scope', 'work', '--json'], cliOptions(root, { outputs })), 0);
    assert.equal(JSON.parse(outputs.join('')).ok, true);
    outputs.length = 0;
    assert.equal(await runDecisionCorrectionsCommand(['save', '--json'], cliOptions(root, { outputs, input: baseCaseInput({ payload_digest: 'a'.repeat(64) }) })), 1, 'a blocked refusal exits 1');
    outputs.length = 0;
    assert.equal(await runDecisionCorrectionsCommand(['frobnicate', '--json'], cliOptions(root, { outputs })), 2, 'unknown action exits 2');
    assert.equal(JSON.parse(outputs.join('')).code, 'invalid-usage');
    outputs.length = 0;
    assert.equal(await runDecisionCorrectionsCommand(['list', '--wat'], cliOptions(root, { outputs })), 2, 'unknown flag exits 2');
    outputs.length = 0;
    assert.equal(await runDecisionCorrectionsCommand(['save'], cliOptions(root, { outputs, input: 'not json' })), 2, 'malformed stdin JSON exits 2');
    outputs.length = 0;
    const big = Buffer.alloc(1024 * 1024 + 2);
    assert.equal(await runDecisionCorrectionsCommand(['list'], { ...cliOptions(root, { outputs }), readStdin: async () => big }), 2, 'stdin over 1 MiB exits 2');
  });

  it('maps --case to case_id and reports state-locked as blocked', async () => {
    const root = await makeTemp('aif-dc-cli2-');
    await seedStoreProject(root);
    await saveCase(root, baseCaseInput());
    const outputs = [];
    assert.equal(await runDecisionCorrectionsCommand(['show', '--scope', 'work', '--case', 'dev-case-1', '--json'], cliOptions(root, { outputs })), 0);
    const envelope = JSON.parse(outputs.join(''));
    assert.equal(envelope.case.payload.case_id, 'dev-case-1');
    const lockPath = path.join(root, '.ai-factory', 'state', DECISION_CORRECTIONS_NAMESPACE, 'work', 'write.lock');
    const { open } = await import('node:fs/promises');
    const handle = await open(lockPath, 'wx');
    try {
      outputs.length = 0;
      const exit = await runDecisionCorrectionsCommand(['delete', '--scope', 'work', '--case', 'dev-case-1', '--json'], cliOptions(root, { outputs }));
      assert.equal(exit, 1);
      assert.equal(JSON.parse(outputs.join('')).code, 'state-locked');
    } finally {
      await handle.close();
      await rm(lockPath, { force: true });
    }
  });

  it('never lets the QA snapshot see case files (engine-backed fingerprint)', async () => {
    const root = await makeTemp('aif-dc-qa5-');
    const options = await seedGitProject(root);
    await seedStoreProject(root);
    await saveCase(root, baseCaseInput());
    const afterWrite = await observe(options);
    const overwriteInput = baseCaseInput({ fixture: { kind: 'redacted', files: baseCaseInput().fixture.files.map((file) => ({ ...file, bytes: `${file.bytes}<!-- redacted -->\n` })) } });
    const overwritePreview = await decisionCorrectionsCommand('preview', overwriteInput, { rootDir: root, ...STORE_OPTIONS() });
    assert.equal(overwritePreview.payload.fixture.version, 2, 'redaction overwrites the same case as fixture version 2');
    await decisionCorrectionsCommand('save', { ...overwriteInput, payload_digest: overwritePreview.payload_digest }, { rootDir: root, ...STORE_OPTIONS() });
    const afterSecond = await observe(options);
    assert.deepEqual(afterSecond, afterWrite, 'engine-driven case writes must not shift the QA fingerprint');
    await decisionCorrectionsCommand('delete', { case_id: 'dev-case-1', scope: 'work' }, { rootDir: root, ...STORE_OPTIONS() });
    const afterDelete = await observe(options);
    assert.deepEqual(afterDelete, afterWrite);
  });
});

// ---------------------------------------------------------------------------
// Config registration (#285): the optional opt-in key is declared with the
// sibling format, the template keeps it commented out, and the managed
// config diff never reports it as a missing required key.
// ---------------------------------------------------------------------------

describe('decision-corrections config registration', () => {
  it('registers the optional managed key and keeps the required-keys diff clean', async () => {
    const manifest = parseStrictJson(await readFile(path.join(REPO_ROOT, 'skills', 'aif-analyze', 'references', 'config-keys.json'), 'utf8'));
    const entry = manifest.keys.find((item) => item.key === 'aifhub.decisionCorrections.enabled');
    assert.ok(entry, 'config-keys must declare aifhub.decisionCorrections.enabled');
    assert.equal(entry.required, false, 'the decision corrections opt-in must stay optional');
    assert.equal(entry.since, '1.8.1');
    assert.ok(!manifest.keys.some((item) => item.key.startsWith('aifhub.decisionCorrections.') && item.key !== 'aifhub.decisionCorrections.enabled'),
      'policy keys must not be exposed');
    const template = await readFile(path.join(REPO_ROOT, 'skills', 'aif-analyze', 'references', 'config-template.yaml'), 'utf8');
    assert.ok(template.includes('# decisionCorrections:'));
    assert.ok(template.includes('#   enabled: false'));
    // The preserve-line in SKILL.md and the command registration join in the
    // deferred group (step 10, after #284 merges); the key itself never
    // appears as a missing required key in the managed diff.
    const { buildAnalyzeConfigDiff } = await import('./aif-analyze-config-diff.mjs');
    const { renderConfigForMode } = await import('./aif-artifact-sync.mjs');
    const root = await makeTemp('aif-dc-diff-');
    const rendered = renderConfigForMode('', 'openspec', { analyzeSkillVersion: '0.11.0' });
    const lines = rendered.split('\n');
    const hubIndex = lines.findIndex((line) => /^aifhub:$/.test(line));
    assert.ok(hubIndex >= 0, 'fresh openspec config must contain the aifhub hub');
    let insertAt = lines.findIndex((line, index) => index > hubIndex && /^\S/.test(line));
    if (insertAt < 0) insertAt = lines.length;
    lines.splice(insertAt, 0, '  decisionCorrections:', '    enabled: false');
    await mkdir(path.join(root, '.ai-factory'), { recursive: true });
    await writeFile(path.join(root, '.ai-factory', 'config.yaml'), lines.join('\n'), 'utf8');
    const diff = await buildAnalyzeConfigDiff({ rootDir: root });
    assert.equal(diff.ok, true, JSON.stringify(diff.errors ?? []));
    assert.equal((diff.missing ?? []).length, 0, 'optional decision-corrections key must never appear as a missing required key');
  });
});
