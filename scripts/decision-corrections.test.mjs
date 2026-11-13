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

import { canonical, digest, WorkflowError } from './workflow-state-store.mjs';
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
      source_observation: { schema: 'aifhub.requirement_lint_observation.v1', change_id: 'work', language: 'ru', inputs: [{ path: 'docs/spec.md', sha256: null, bytes: 82, kind: 'file' }] },
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
    honesty_note: 'run проверяет текущую реализацию на fixture, а не provider-качество',
    counts: {
      development: { cases: 1, holds: 0, false_regression: 0, label_change: 1, ambiguous: 0, not_run: 0, stale: 0, report_only: 0, invalid_record: 0 },
      calibration: { cases: 0, holds: 0, false_regression: 0, label_change: 0, ambiguous: 0, not_run: 0, stale: 0, report_only: 0, invalid_record: 0 },
      held_out: { cases: 0, holds: 0, false_regression: 0, label_change: 0, ambiguous: 0, not_run: 0, stale: 0, report_only: 0, invalid_record: 0 },
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

  it('rejects an extra field at the record, payload, and nested identity levels', () => {
    const record = literalCaseRecord();
    record.telemetry = true;
    assert.ok(validateJsonAgainstSchema(record, CASE_SCHEMA).length > 0, 'record-level additionalProperties must be closed');
    const payloadRecord = literalCaseRecord();
    payloadRecord.payload.export_to = 'somewhere';
    assert.ok(validateJsonAgainstSchema(payloadRecord, CASE_SCHEMA).length > 0, 'payload-level additionalProperties must be closed');
    const nestedRecord = literalCaseRecord();
    nestedRecord.payload.identity.source_observation.structural = { requirements: 2 };
    assert.ok(
      validateJsonAgainstSchema(nestedRecord, CASE_SCHEMA).length > 0,
      'nested identity projection fields must stay inside the closed producer union grammar',
    );
    const unknownObservationKey = literalCaseRecord();
    unknownObservationKey.payload.identity.source_observation.coverage = {};
    assert.ok(
      validateJsonAgainstSchema(unknownObservationKey, CASE_SCHEMA).length > 0,
      'identity projection keys stay on the declared allowlist',
    );
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

  it('resolves every $ref inside both closed schemas', () => {
    for (const schema of [CASE_SCHEMA, RUN_SCHEMA]) {
      const refs = [];
      const walk = (node) => {
        if (Array.isArray(node)) return node.forEach(walk);
        if (!node || typeof node !== 'object') return;
        if (typeof node.$ref === 'string') {
          const resolved = node.$ref.slice(2).split('/').reduce(
            (acc, part) => acc?.[part.replaceAll('~1', '/').replaceAll('~0', '~')],
            schema,
          );
          refs.push({ ref: node.$ref, resolved: resolved !== undefined });
        }
        for (const value of Object.values(node)) walk(value);
      };
      walk(schema);
      assert.ok(refs.length > 0, 'the schema inventory actually found references');
      assert.deepEqual(refs.filter((item) => !item.resolved), [], `every $ref resolves inside ${schema.title}`);
    }
  });

  it('accepts conforming producer projections from every grammar branch', () => {
    const identitySchema = CASE_SCHEMA.$defs.payload.properties.identity.properties.source_observation;
    const sha = (seed) => `sha256:${seed.repeat(64)}`;
    // trace-link structural branch: exercises the scenario ref form and the
    // behavioral span anchors (the identity_byte_span transitive refs).
    const tlStructural = {
      trace: { path: '.ai-factory/traces/work/lekalo-trace-manifest.json', sha256: 'a'.repeat(64), bytes: 10, schema_version: 'lekalo/trace-manifest/v0.2.16', identity: 'dev.lekalo.trace-manifest@0.2.16', completeness: 'full', manifest_digest: sha('b') },
      scan: { coverage: 'full', declared_sources: 1, scanned_sources: 1, missing_sources: [], delta_spec_inventory: ['docs/spec.md'], missing_sources_count: 0, truncations: [] },
      outcome: 'candidate',
      outcome_summary: { total_nodes: 1, total_edges: 1, by_outcome: { candidate: 1, related_only: 0 } },
      nodes: [{ node_id: 'n1', kind: 'scenario', exact_ref: { spec_path: 'docs/spec.md', requirement_ref: 'R1', heading: 'Scenario', span: { start: 0, end: 1 }, document_sha256: sha('c'), span_sha256: sha('d') } }],
      edges: [{ edge_id: 'edge-1', from_node_id: 'n1', to_node_id: 'n1', relation: 'requirement_symbol', outcome: 'candidate', behavioral_assertion_refs: [{ path: 'docs/spec.md', span: { start: 0, end: 1 }, document_sha256: sha('e'), span_sha256: sha('f') }] }],
    };
    assert.deepEqual(
      validateJsonAgainstSchema({ schema: 'aifhub.trace_link_suggestions_observation.v1', change_id: 'work', language: 'en', structural: tlStructural }, identitySchema, { rootSchema: CASE_SCHEMA }),
      [],
      'a trace-link producer projection must pass the closed union grammar',
    );
    // claim-evidence semantic branch: exercises the claim assessment items.
    const ceSemantic = {
      run_status: 'complete', freshness: 'current', abstained: false, outcome_reason: null,
      coverage: { state: 'full', declared_sources: 0, scanned_sources: 0, missing_sources: [] },
      assessments: [{ claim_id: 'claim-1', verdict: 'supports', rationale: 'literal quote found' }],
    };
    assert.deepEqual(
      validateJsonAgainstSchema({ schema: 'aifhub.claim_evidence_observation.v1', change_id: 'work', language: 'en', semantic: ceSemantic }, identitySchema, { rootSchema: CASE_SCHEMA }),
      [],
      'a claim-evidence producer projection must pass the closed union grammar',
    );
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
  extractOutcomeSignature,
  hasCorrectionsLeak,
  parseDecisionCorrectionsConfigSubset,
  projectIdentityObservation,
  readDecisionCorrectionsConfig,
  runDecisionCorrectionsCommand,
} from './decision-corrections.mjs';
import { evolutionCommand } from './evolution-transactions.mjs';
import { runRequirementLintCommand } from './requirement-lint.mjs';

const SPEC_BYTES = '# Spec\n\n- R1: The system shall store data.\n- R2: The system shall not lose data.\n';
const ENABLED_CONFIG = 'aifhub:\n  requirementLint:\n    enabled: true\n';
// The verbatim honesty note is a contract term quoted from the delta spec.
// Assertions compare against this independent literal (never against the
// imported constant alone) so a drifted runtime translation cannot pass.
const HONESTY_NOTE_LITERAL = 'run проверяет текущую реализацию на fixture, а не provider-качество';

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
      source_observation: { schema: 'aifhub.requirement_lint_observation.v1', change_id: 'work', language: 'ru', inputs: [{ path: 'docs/spec.md', sha256: null, bytes: 82, kind: 'file' }] },
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
    // After the rewrite the PRE-redaction digest still confirms nothing: the
    // binding is to the exact new fixture bytes, not to the case history.
    await assert.rejects(
      () => decisionCorrectionsCommand('confirm', { case_id: input.case_id, scope: input.scope, expected_label: input.expected_label, payload_digest: preview.payload_digest }, { rootDir: root, ...STORE_OPTIONS() }),
      (error) => error?.code === 'payload-mismatch',
    );
    const reConfirmed = await decisionCorrectionsCommand('confirm', {
      case_id: input.case_id, scope: input.scope, expected_label: input.expected_label, payload_digest: redactionPreview.payload_digest,
    }, { rootDir: root, ...STORE_OPTIONS() });
    assert.equal(reConfirmed.case.status, 'confirmed');
    assert.equal(reConfirmed.case.payload.fixture.version, 2);
  });

  it('supports confirm, reject and supersede on every status with idempotent repeats', async () => {
    const root = await makeTemp('aif-dc-lifecycle-');
    await seedStoreProject(root);
    // Independent enumeration: every (source status x action) cell starts
    // from a freshly seeded case driven to the source status, so the
    // transition matrix is proven cell by cell, not through drifted state.
    const actionForStatus = { confirmed: 'confirm', rejected: 'reject', superseded: 'supersede' };
    const expectedForAction = { confirm: 'confirmed', reject: 'rejected', supersede: 'superseded' };
    let revision = 0;
    const seedTo = async (caseId, target) => {
      const input = baseCaseInput({
        case_id: caseId,
        identity: { ...baseCaseInput().identity, subject_revision: `rev-mx-${revision += 1}` },
      });
      await saveCase(root, input);
      if (target === 'draft') return input;
      const body = { case_id: caseId, scope: 'work' };
      if (target !== 'confirmed') body.reason = `mx seed ${target}`;
      if (target === 'confirmed') {
        const preview = await decisionCorrectionsCommand('preview', input, { rootDir: root, ...STORE_OPTIONS() });
        body.expected_label = input.expected_label;
        body.payload_digest = preview.payload_digest;
      }
      const seeded = await decisionCorrectionsCommand(actionForStatus[target], body, { rootDir: root, ...STORE_OPTIONS() });
      assert.equal(seeded.case.status, target, `${caseId}: seed status ${target}`);
      return input;
    };
    for (const sourceStatus of ['draft', 'confirmed', 'rejected', 'superseded']) {
      for (const action of ['confirm', 'reject', 'supersede']) {
        const caseId = `dev-mx-${sourceStatus}-${action}`;
        const input = await seedTo(caseId, sourceStatus);
        for (let repeat = 1; repeat <= 2; repeat += 1) {
          const body = { case_id: caseId, scope: 'work' };
          if (action !== 'confirm') body.reason = `mx ${action} ${repeat}`;
          if (action === 'confirm') {
            // A confirm always binds the expected label to the CURRENT
            // fixture digest: read it from the live record via preview.
            const preview = await decisionCorrectionsCommand('preview', input, { rootDir: root, ...STORE_OPTIONS() });
            body.expected_label = input.expected_label;
            body.payload_digest = preview.payload_digest;
          }
          const result = await decisionCorrectionsCommand(action, body, { rootDir: root, ...STORE_OPTIONS() });
          assert.equal(result.case.status, expectedForAction[action], `${action} is defined on source status ${sourceStatus} (repeat ${repeat})`);
        }
      }
    }
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
    // Superset differential (rules-gate rounds 1-2 counter-examples): every
    // real single-backslash shape in a value is path material and refuses,
    // regardless of the character after the backslash, while JSON escape
    // sequences of stored multiline fixture bytes are content encoding and
    // keep saving (the redaction suite saves multiline bytes).
    assert.equal(hasCorrectionsLeak({ note: 'private\\memo' }), true, 'a real single backslash is leak material');
    assert.equal(hasCorrectionsLeak({ note: 'private\\notes' }), true, 'backslash+n is path material, not an encoded newline');
    assert.equal(hasCorrectionsLeak({ note: 'private\\todo' }), true, 'backslash+t is path material, not an encoded tab');
    assert.equal(hasCorrectionsLeak({ note: 'private\\u1234' }), true, 'backslash+u is path material, not a unicode escape');
    assert.equal(hasCorrectionsLeak({ note: 'line1\nline2' }), false, 'escaped newlines are content encoding, not leaks');
    assert.equal(hasCorrectionsLeak({ note: 'line1\r\nline2' }), false, 'CR/LF control chars stay content encodings');
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
    assert.equal(previewRun.run.honesty_note, HONESTY_NOTE_LITERAL, 'the honesty note is verbatim in the output');
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

  it('stores a consumer without a pinned run-command surface and reports an honest unsupported_consumer replay outcome', async () => {
    const root = await makeTemp('aif-dc-run5-');
    await seedStoreProject(root);
    // context_selection_overlay has no pinned run-command DI surface yet: the
    // case stays storeable (its grammars are not enforced), and the replay
    // must report the honest unsupported_consumer outcome without ever
    // calling an engine (must-not-call) and without scoring the case.
    const input = baseCaseInput({
      case_id: 'dev-overlay-1',
      identity: { ...baseCaseInput().identity, subject_revision: 'rev-overlay' },
      original_assessment: { consumer: 'context_selection_overlay', verdict: 'overlay verdict', summary: null },
    });
    await saveCase(root, input);
    await confirmCase(root, input);
    let engineCalls = 0;
    const spyEngine = async () => { engineCalls += 1; return 0; };
    const run = await decisionCorrectionsCommand('run', { scope: 'work' }, {
      rootDir: root,
      ...STORE_OPTIONS(),
      replayEngines: {
        requirements_semantic_lint: spyEngine,
        claim_evidence_check: spyEngine,
        trace_link_suggestions: spyEngine,
      },
    });
    const entry = run.run.cases.find((item) => item.case_id === 'dev-overlay-1');
    assert.equal(entry.outcome, 'unsupported_consumer', 'a consumer without a run-command surface is honest unsupported_consumer');
    assert.equal(entry.signature, null, 'no engine signature exists for an unsupported consumer');
    assert.equal(engineCalls, 0, 'no engine is called for an unsupported consumer');
    assert.equal(run.run.counts.development.not_run, 1, 'the unsupported outcome lands in the honest not_run bucket');
    assert.equal(run.run.counts.development.cases, 1);
    // A consumer outside the closed intake allowlist is still refused.
    await assert.rejects(
      () => saveCase(root, baseCaseInput({
        case_id: 'dev-unknown-consumer',
        identity: { ...baseCaseInput().identity, subject_revision: 'rev-unknown' },
        original_assessment: { consumer: 'made_up_consumer', verdict: 'x', summary: null },
      })),
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

// ---------------------------------------------------------------------------
// Corpus evaluation (fixtures + labels): every shipped case file is driven
// through the store in an isolated temp project and compared against
// labels.json with the exact-match rule. Declared-only provenance; the
// corpus proves transport/guards/lifecycle, never provider quality.
// ---------------------------------------------------------------------------

import { cp } from 'node:fs/promises';

const CORPUS_DIR = path.join(REPO_ROOT, 'test', 'fixtures', 'decision-corrections');
const CORPUS_LABELS = parseStrictJson(await readFile(path.join(CORPUS_DIR, 'labels.json'), 'utf8'));

async function corpusCase(file, { digest = undefined } = {}) {
  const input = parseStrictJson(await readFile(path.join(CORPUS_DIR, 'cases', file), 'utf8'));
  if (digest !== undefined) input.evolution = { ...input.evolution, proposal_digest: digest };
  return input;
}

async function corpusProject(prefix, { seedTransaction = false } = {}) {
  const root = await makeTemp(prefix);
  await mkdir(path.join(root, 'docs'), { recursive: true });
  await cp(path.join(CORPUS_DIR, 'sources', 'spec.md'), path.join(root, 'docs', 'spec.md'));
  await cp(path.join(CORPUS_DIR, 'sources', 'spec-crlf.md'), path.join(root, 'docs', 'spec-crlf.md'));
  await writeFile(path.join(root, 'docs', 'extra.md'), 'extra provenance input\n');
  if (seedTransaction) {
    await writeFile(path.join(root, 'docs', 'evidence.md'), 'evidence for the corpus transaction\n');
    const proposal = {
      transaction_id: 'tx-corpus',
      skill: 'aif-implement',
      after: '# Updated context for the corpus transaction\n',
      reason: 'repair installed helper context',
      evidence: ['docs/evidence.md'],
    };
    const proposed = await evolutionCommand('propose', proposal, { rootDir: root });
    await evolutionCommand('apply', { transaction_id: 'tx-corpus', proposal_digest: proposed.proposal_digest }, { rootDir: root });
  }
  return root;
}

async function corpusSave(root, input, { corruptDigest = false } = {}) {
  try {
    const preview = await decisionCorrectionsCommand('preview', input, { rootDir: root, ...STORE_OPTIONS() });
    if (preview.idempotent) return { ok: 'idempotent', saved: preview };
    const echo = corruptDigest ? 'e'.repeat(64) : preview.payload_digest;
    const saved = await decisionCorrectionsCommand('save', { ...input, payload_digest: echo }, { rootDir: root, ...STORE_OPTIONS() });
    return { ok: 'ok', saved };
  } catch (error) {
    if (!(error instanceof WorkflowError)) throw error;
    return { ok: error.code };
  }
}

async function corpusLifecycle(root, action, input, digest = undefined) {
  try {
    const result = await decisionCorrectionsCommand(action, {
      case_id: input.case_id, scope: input.scope,
      ...(action === 'confirm' ? { expected_label: input.expected_label, payload_digest: digest } : {}),
    }, { rootDir: root, ...STORE_OPTIONS() });
    return { ok: result.case.status };
  } catch (error) {
    if (!(error instanceof WorkflowError)) throw error;
    return { ok: error.code };
  }
}

describe('decision-corrections corpus evaluation (fixtures + labels)', () => {
  it('matches every declared dev case label exactly', async () => {
    const root = await corpusProject('aif-dc-corpus-dev-', { seedTransaction: true });
    const txView = await evolutionCommand('show', { transaction_id: 'tx-corpus' }, { rootDir: root });
    for (const [file, labels] of Object.entries(CORPUS_LABELS.groups.dev)) {
      if (labels.expected.role === 'redaction-material') continue; // consumed by the dev-redaction leg
      const input = await corpusCase(file, { digest: labels.expected.evolution_active ? txView.proposal_digest : undefined });
      const saved = await corpusSave(root, input, { corruptDigest: labels.expected.save === 'payload-mismatch' });
      assert.equal(saved.ok, labels.expected.save, `${file}: save outcome`);
      if (labels.expected.save !== 'ok') continue;
      if (labels.expected.resave === 'idempotent') {
        const resaved = await corpusSave(root, input);
        assert.equal(resaved.ok, 'idempotent', `${file}: repeated save must stay idempotent`);
      }
      if (labels.expected.confirm === 'ok') {
        const preview = await decisionCorrectionsCommand('preview', input, { rootDir: root, ...STORE_OPTIONS() });
        const confirmed = await corpusLifecycle(root, 'confirm', input, preview.payload_digest);
        assert.equal(confirmed.ok, labels.expected.status ?? 'confirmed', `${file}: confirm outcome`);
      }
      if (labels.expected.redaction) {
        const v2 = await corpusCase('dev-redaction-v2.json');
        const redactionPreview = await decisionCorrectionsCommand('preview', v2, { rootDir: root, ...STORE_OPTIONS() });
        assert.equal(redactionPreview.payload.fixture.version, labels.expected.redaction.version, `${file}: redaction version`);
        const redactionSave = await decisionCorrectionsCommand('save', { ...v2, payload_digest: redactionPreview.payload_digest }, { rootDir: root, ...STORE_OPTIONS() });
        assert.equal(redactionSave.case.status, labels.expected.redaction.status, `${file}: redaction demotes to draft`);
        assert.equal(redactionSave.case.payload.expected_label_confirmed, labels.expected.redaction.confirmed, `${file}: redaction resets confirmation`);
        const reconfirmPreview = await decisionCorrectionsCommand('preview', v2, { rootDir: root, ...STORE_OPTIONS() });
        const reconfirmed = await corpusLifecycle(root, 'confirm', v2, reconfirmPreview.payload_digest);
        assert.equal(reconfirmed.ok, 'confirmed', `${file}: re-confirmation needs the fresh digest`);
      }
      if (labels.expected.new_identity === true) {
        const listed = await decisionCorrectionsCommand('list', { scope: 'work' }, { rootDir: root, ...STORE_OPTIONS() });
        const original = listed.cases.find((item) => item.case_id === 'dev-valid-case');
        const next = listed.cases.find((item) => item.case_id === 'dev-question-v2');
        assert.ok(original && next, `${file}: both question versions coexist`);
        assert.notEqual(next.logical_identity, original.logical_identity, `${file}: next question version is a new identity`);
        assert.equal(original.status, 'confirmed', `${file}: the original confirmed fixture stays untouched`);
      }
      if (labels.expected.evolution_active === true) {
        const shown = await decisionCorrectionsCommand('show', { case_id: input.case_id, scope: input.scope }, { rootDir: root, ...STORE_OPTIONS() });
        assert.equal(shown.evolution.active, true, `${file}: applied transaction is an active application`);
      }
      if (labels.expected.bytes_exact === true) {
        const shown = await decisionCorrectionsCommand('show', { case_id: input.case_id, scope: input.scope }, { rootDir: root, ...STORE_OPTIONS() });
        const crlfBytes = (await readFile(path.join(CORPUS_DIR, 'sources', 'spec-crlf.md'))).toString('utf8');
        assert.equal(shown.case.payload.fixture.files[0].bytes, crlfBytes, `${file}: CRLF fixture bytes stay exact`);
      }
    }
    // Scope separation across the two scope files: same material identity,
    // different scope inputs, no merge.
    const alpha = await decisionCorrectionsCommand('list', { scope: 'alpha' }, { rootDir: root, ...STORE_OPTIONS() });
    const beta = await decisionCorrectionsCommand('list', { scope: 'beta' }, { rootDir: root, ...STORE_OPTIONS() });
    assert.equal(alpha.cases.length, 1);
    assert.equal(beta.cases.length, 1);
    assert.notEqual(alpha.cases[0].logical_identity, beta.cases[0].logical_identity, 'scope is an identity input: no merge');
  });

  it('runs the confirmed dev set and matches the labeled run outcomes', async () => {
    const root = await corpusProject('aif-dc-corpus-run-');
    await writeFile(path.join(root, 'docs', 'extra.md'), 'extra provenance input\n');
    for (const file of ['dev-valid-case.json', 'dev-ambiguous.json', 'dev-stale-inputs.json']) {
      const input = await corpusCase(file);
      const saved = await corpusSave(root, input);
      assert.equal(saved.ok, 'ok', `${file}: save`);
      // Confirm every leg first: staleness is detected at replay time, after
      // the drift below, and only confirmed cases enter the replay.
      const preview = await decisionCorrectionsCommand('preview', input, { rootDir: root, ...STORE_OPTIONS() });
      const confirmed = await corpusLifecycle(root, 'confirm', input, preview.payload_digest);
      assert.equal(confirmed.ok, 'confirmed', `${file}: confirm`);
    }
    await writeFile(path.join(root, 'docs', 'extra.md'), 'extra provenance input changed\n');
    const run = await decisionCorrectionsCommand('run', { scope: 'work' }, { rootDir: root, ...STORE_OPTIONS() });
    const byId = Object.fromEntries(run.run.cases.map((item) => [item.case_id, item]));
    assert.equal(byId['dev-valid-case'].outcome, CORPUS_LABELS.groups.dev['dev-valid-case.json'].expected.run_outcome,
      'the bundle enables the requirement lint, so replay completes and the label comparison decides');
    assert.equal(byId['dev-ambiguous'].outcome, 'ambiguous');
    assert.equal(byId['dev-stale-inputs'].outcome, 'stale');
    assert.equal(run.run.honesty_note, HONESTY_NOTE_LITERAL);
  });

  it('keeps held-out cases report-only under the same labels discipline', async () => {
    const root = await corpusProject('aif-dc-corpus-heldout-');
    for (const [file, labels] of Object.entries(CORPUS_LABELS.groups.heldout)) {
      const input = await corpusCase(file);
      const saved = await corpusSave(root, input);
      assert.equal(saved.ok, labels.expected.save, `${file}: held-out save`);
      const preview = await decisionCorrectionsCommand('preview', input, { rootDir: root, ...STORE_OPTIONS() });
      assert.equal((await corpusLifecycle(root, 'confirm', input, preview.payload_digest)).ok, labels.expected.confirm, `${file}: confirm refused`);
      assert.equal((await corpusLifecycle(root, 'reject', input)).ok, labels.expected.reject, `${file}: reject refused`);
      assert.equal((await corpusLifecycle(root, 'supersede', input)).ok, labels.expected.supersede, `${file}: supersede refused`);
    }
    const run = await decisionCorrectionsCommand('run', { scope: 'work' }, { rootDir: root, ...STORE_OPTIONS() });
    assert.deepEqual(run.run.cases.map((item) => item.outcome), ['report_only'], 'held-out cases are never replayed in any status');
  });

  it('refuses every limit case with its labeled typed code and leaves no artifacts', async () => {
    const root = await corpusProject('aif-dc-corpus-limit-', { seedTransaction: true });
    const txView = await evolutionCommand('show', { transaction_id: 'tx-corpus' }, { rootDir: root });
    for (const [file, labels] of Object.entries(CORPUS_LABELS.groups.limit)) {
      // The limit fixtures keep their labeled (wrong) digests: only
      // dev-tx-link receives the sealed real digest.
      const input = await corpusCase(file);
      const saved = await corpusSave(root, input);
      assert.equal(saved.ok, labels.expected.save, `${file}: typed refusal`);
    }
    const casesDir = path.join(root, '.ai-factory', 'state', DECISION_CORRECTIONS_NAMESPACE, 'work', 'cases');
    assert.deepEqual((await readdirSafe(casesDir)).filter((name) => name.endsWith('.json')), [],
      'refused limit saves leave no case artifacts');
  });
});

// ---------------------------------------------------------------------------
// Review hardening (#285 round 2): config malformed-line parity, digest echo
// on the idempotent branch, scope aliases, delete leaf proof, usage echo
// sanitization, held-out must-not-call on the replay path, injected-provider
// self-referential roots, and consumer-aware outcome signatures.
// ---------------------------------------------------------------------------

describe('decision-corrections review hardening', () => {
  it('keeps a non-mapping line inside the namespace from leaving it enabled (malformed-line)', async () => {
    const root = await makeTemp('aif-dc-malformed-');
    await seedStoreProject(root);
    // A garbage line sits below `enabled: true`; a silent skip would keep the
    // mechanism on contrary to the malformed-namespace contract.
    const config = await readDecisionCorrectionsConfig(root, { readConfigBytes: async () => Buffer.from('aifhub:\n  decisionCorrections:\n    enabled: true\n    garbage\n', 'utf8') });
    assert.equal(config.enabledMalformed, true, 'a malformed namespace line must force off');
    assert.ok(config.diagnostics.some((d) => d.code === 'decision-corrections:malformed-line'), 'the malformed-line diagnostic must be reported');
    await assert.rejects(
      () => decisionCorrectionsCommand('list', { scope: 'work' }, { rootDir: root, enabled: true, config }),
      (error) => error?.code === 'decision-corrections-disabled',
      'CLI override must not rescue a malformed namespace',
    );
    void parseDecisionCorrectionsConfigSubset;
  });

  it('checks the digest echo unconditionally, including the idempotent branch', async () => {
    const root = await makeTemp('aif-dc-echo-');
    await seedStoreProject(root);
    const input = baseCaseInput();
    const { preview } = await saveCase(root, input);
    await assert.rejects(
      () => decisionCorrectionsCommand('save', { ...input, payload_digest: 'e'.repeat(64) }, { rootDir: root, ...STORE_OPTIONS() }),
      (error) => error?.code === 'payload-mismatch' && error.blocked === true,
      'a repeated save with a wrong digest echo is a contract violation, not a free pass',
    );
    const resaved = await decisionCorrectionsCommand('save', { ...input, payload_digest: preview.payload_digest }, { rootDir: root, ...STORE_OPTIONS() });
    assert.equal(resaved.idempotent, true);
  });

  it('refuses show of a case whose evolution link points at a missing transaction', async () => {
    const root = await makeTemp('aif-dc-showtx-');
    await seedStoreProject(root);
    const input = baseCaseInput({ case_id: 'dev-tx-missing-show', evolution: { transaction_id: 'tx-absent', proposal_digest: 'a'.repeat(64) } });
    await assert.rejects(() => saveCase(root, input), (error) => error?.code === 'missing-or-invalid-transaction');
    // A record with a missing link cannot exist through the public API; the
    // refusal covers both save and any direct-store show defense.
    const listed = await decisionCorrectionsCommand('list', { scope: 'work' }, { rootDir: root, ...STORE_OPTIONS() });
    assert.equal(listed.cases.length, 0, 'a refused save leaves no case to show');
  });

  it('refuses Windows case-only scope directory aliases for writes and reads', async () => {
    const root = await makeTemp('aif-dc-scopealias-');
    await seedStoreProject(root);
    await saveCase(root, baseCaseInput({ scope: 'alpha' }));
    await assert.rejects(
      () => saveCase(root, baseCaseInput({ scope: 'ALPHA', identity: { ...baseCaseInput().identity, subject_revision: 'rev-alpha2' } })),
      (error) => error?.code === 'scope-collision' && error.blocked === true,
      'an alias scope directory would merge two logical identities on a case-insensitive filesystem',
    );
    const aliasList = await decisionCorrectionsCommand('list', { scope: 'ALPHA' }, { rootDir: root, ...STORE_OPTIONS() });
    assert.deepEqual(aliasList.cases, [], 'an alias scope must not surface the neighboring scope’s cases');
  });

  it('proves leaf ownership before delete (case-only alias cannot delete a neighbor)', async () => {
    const root = await makeTemp('aif-dc-delalias-');
    await seedStoreProject(root);
    await saveCase(root, baseCaseInput({ case_id: 'case-1' }));
    await assert.rejects(
      () => decisionCorrectionsCommand('delete', { case_id: 'CASE-1', scope: 'work' }, { rootDir: root, ...STORE_OPTIONS() }),
      (error) => error?.code === 'case-collision',
      'the resolved leaf must prove it belongs to the requested case before removal',
    );
    const listed = await decisionCorrectionsCommand('list', { scope: 'work' }, { rootDir: root, ...STORE_OPTIONS() });
    assert.equal(listed.cases.length, 1, 'the neighbor case survives the aliased delete');
  });

  it('never echoes a hostile argv fragment through the invalid-usage envelope', async () => {
    const root = await makeTemp('aif-dc-usageleak-');
    await seedStoreProject(root);
    const outputs = [];
    const exit = await runDecisionCorrectionsCommand(['list', '--see-https://attacker.invalid/x'], {
      rootDir: root, enabled: true, output: (value) => outputs.push(value),
      readStdin: async () => Buffer.alloc(0),
    });
    assert.equal(exit, 2);
    const printed = outputs.join('');
    assert.ok(!printed.includes('attacker.invalid'), 'the usage branch must pass the leak scan before printing');
    assert.equal(JSON.parse(printed).code, 'privacy-leak');
  });

  it('accepts a numeric --limit flag that matches the stdin body', async () => {
    const root = await makeTemp('aif-dc-limitflag-');
    await seedStoreProject(root);
    const outputs = [];
    const exit = await runDecisionCorrectionsCommand(['list', '--scope', 'work', '--limit', '5', '--json'], {
      rootDir: root, enabled: true, output: (value) => outputs.push(value),
      readStdin: async () => Buffer.from(JSON.stringify({ limit: 5 }), 'utf8'),
    });
    assert.equal(exit, 0, `equal limit values must not conflict: ${outputs.join('').slice(0, 120)}`);
    assert.equal(JSON.parse(outputs.join('')).ok, true);
  });

  it('refuses provenance inputs inside the store namespace and a destination that is a presented input', async () => {
    const root = await makeTemp('aif-dc-selfref-');
    await seedStoreProject(root);
    await assert.rejects(
      () => saveCase(root, baseCaseInput({ case_id: 'dev-selfref', identity: { ...baseCaseInput().identity, input_paths: ['.ai-factory/state/decision-corrections/work/cases/x.json'] } })),
      (error) => error?.code === 'self-referential-input',
    );
    await assert.rejects(
      () => saveCase(root, baseCaseInput({ case_id: 'dev-case-1', identity: { ...baseCaseInput().identity, input_paths: ['.ai-factory/state/decision-corrections/work/cases/dev-case-1.json'] } })),
      (error) => error?.code === 'self-referential-input' || error?.code === 'missing-evidence',
    );
  });

  it('runs an explicitly selected late case even at limit 1', async () => {
    const root = await makeTemp('aif-dc-limitlate-');
    await seedStoreProject(root);
    await saveCase(root, baseCaseInput({ case_id: 'a-case' }));
    const late = baseCaseInput({ case_id: 'z-case', identity: { ...baseCaseInput().identity, subject_revision: 'rev-z' } });
    await saveCase(root, late);
    await confirmCase(root, late);
    const run = await decisionCorrectionsCommand('run', { scope: 'work', case_ids: ['z-case'], limit: 1 }, { rootDir: root, ...STORE_OPTIONS() });
    assert.deepEqual(run.run.cases.map((item) => item.case_id), ['z-case'], 'the wanted filter applies before the limit slices');
  });

  it('refuses a fixture path that exceeds the schema cap with a typed field code', async () => {
    const root = await makeTemp('aif-dc-pathlen-');
    await seedStoreProject(root);
    await assert.rejects(
      () => saveCase(root, baseCaseInput({ case_id: 'dev-longpath', fixture: { kind: 'synthetic', files: [{ path: `docs/${'x'.repeat(300)}.md`, media_type: 'text/markdown', bytes: 'x' }] } })),
      (error) => error?.code === 'unsafe-fixture-path',
    );
  });

  it('never measures a held-out case on the replay path (must-not-call, defense in depth)', async () => {
    const root = await makeTemp('aif-dc-heldoutrun-');
    await seedStoreProject(root);
    const input = baseCaseInput({ case_id: 'heldout-planted', partition: 'held_out', identity: { ...baseCaseInput().identity, subject_revision: 'rev-heldout-planted' } });
    const { preview } = await saveCase(root, input);
    // A confirmed held-out case is unreachable through the public API
    // (confirm refuses); plant one directly to prove the replay-path guard
    // holds even for pre-existing state.
    const caseFile = path.join(root, '.ai-factory', 'state', DECISION_CORRECTIONS_NAMESPACE, 'work', 'cases', 'heldout-planted.json');
    const envelope = parseStrictJson(await readFile(caseFile, 'utf8'));
    envelope.record.status = 'confirmed';
    envelope.record.payload.expected_label_confirmed = true;
    envelope.record.payload_digest = digest(canonical(envelope.record.payload));
    envelope.checksum = digest(envelope.record);
    await writeFile(caseFile, `${JSON.stringify(envelope, null, 2)}\n`);
    let engineCalls = 0;
    const run = await decisionCorrectionsCommand('run', { scope: 'work' }, {
      rootDir: root, ...STORE_OPTIONS(),
      assessor: async () => { engineCalls += 1; return { findings: [] }; },
    });
    const entry = run.run.cases.find((item) => item.case_id === 'heldout-planted');
    assert.equal(entry.outcome, 'report_only', 'a held-out case is reported, never measured');
    assert.equal(entry.signature, null, 'no signature is produced for a held-out case');
    assert.equal(engineCalls, 0, 'the replay engine must never be invoked for a held-out case');
    assert.equal(run.run.counts.held_out.report_only, 1);
    assert.equal(run.run.counts.held_out.holds + run.run.counts.held_out.false_regression + run.run.counts.held_out.label_change, 0);
    // The revision flow is part of the tuning surface: a changed payload on
    // the existing held-out case refuses.
    await assert.rejects(
      () => saveCase(root, baseCaseInput({
        case_id: 'heldout-planted', partition: 'held_out',
        identity: { ...baseCaseInput().identity, subject_revision: 'rev-heldout-planted' },
        expected_label: 'a changed label',
      })),
      (error) => error?.code === 'held-out-tuning',
      'a fixture revision of an existing held-out case is tuning',
    );
    const deleted = await decisionCorrectionsCommand('delete', { case_id: 'heldout-planted', scope: 'work' }, { rootDir: root, ...STORE_OPTIONS() });
    assert.equal(deleted.deleted, true, 'retention stays available for held-out cases');
  });

  it('decodes consumer-specific outcome material into the signature', async () => {
    const claimObservation = {
      schema: 'aifhub.claim_evidence_observation.v1',
      semantic: { run_status: 'complete', assessments: [{ claim_id: 'c1', verdict: 'supports' }] },
      structural: { pairs: [{ quote_check: 'exact_found' }, { quote_check: 'not_found' }] },
      diagnostics: [],
    };
    const claimSignature = extractOutcomeSignature(JSON.stringify(claimObservation));
    assert.equal(claimSignature.run_status, 'complete', 'claim-evidence run_status is read from semantic.run_status');
    assert.ok(claimSignature.signature.includes('quote_checks=exact_found|not_found'), claimSignature.signature);
    assert.ok(claimSignature.signature.includes('verdicts=supports'), claimSignature.signature);
    const traceObservation = {
      schema: 'aifhub.trace_link_suggestions_observation.v1',
      semantic: { run_status: 'complete', assessments: [] },
      structural: { outcome: 'partial', nodes: [], edges: [{ relation: 'requirement_symbol' }] },
      diagnostics: [],
    };
    const traceSignature = extractOutcomeSignature(JSON.stringify(traceObservation));
    assert.equal(traceSignature.run_status, 'complete', 'trace-link run_status is read from semantic.run_status');
    assert.ok(traceSignature.signature.includes('outcome=partial'), traceSignature.signature);
    assert.ok(traceSignature.signature.includes('relations=requirement_symbol'), traceSignature.signature);
    const disabled = extractOutcomeSignature(JSON.stringify({ schema_version: 1, state: 'not_run', codes: ['x-disabled'] }));
    assert.equal(disabled.run_status, 'not_run', 'a not-performed envelope stays honestly not_run');
  });

  it('validates request filters before the empty-scope fast path', async () => {
    const root = await makeTemp('aif-dc-listfilters-');
    await seedStoreProject(root);
    await assert.rejects(
      () => decisionCorrectionsCommand('list', { scope: 'work', limit: 0 }, { rootDir: root, ...STORE_OPTIONS() }),
      (error) => error?.code === 'invalid-limit',
      'an invalid limit must refuse even when the scope has no cases yet',
    );
    await assert.rejects(
      () => decisionCorrectionsCommand('list', { scope: 'work', status_filter: 'archived' }, { rootDir: root, ...STORE_OPTIONS() }),
      (error) => error?.code === 'invalid-status-filter',
    );
  });
});

// ---------------------------------------------------------------------------
// Review hardening round 2 (QA): the self-referential-input rule covers the
// injected-provider path too, and held-out revisions refuse in the corpus.
// ---------------------------------------------------------------------------

describe('decision-corrections QA namespace review hardening', () => {
  it('refuses an injected SnapshotProvider whose declared root sits inside the namespace', async () => {
    const root = await makeTemp('aif-dc-qa6-');
    const options = await seedGitProject(root);
    const store = await qaStore(options);
    const { payload } = await store.manifest();
    const injected = {
      observe: async () => ({
        complete: true,
        worktree_identity: 'c'.repeat(64),
        modules: { 'scripts/qa-manifest.mjs': digest('z') },
        actual_diff: null,
        files: {},
        directory_names: [],
        ignored_names: [],
        changed_paths: [],
      }),
    };
    const poisoned = JSON.parse(JSON.stringify(payload));
    poisoned.checks[0].inputs = [`.ai-factory/state/${DECISION_CORRECTIONS_NAMESPACE}`];
    await assert.rejects(
      () => observeQaSnapshot(store, poisoned, { SnapshotProvider: injected }),
      (error) => error?.code === 'self-referential-input',
      'an injected provider must not silently hide a closed namespace a declared root points into',
    );
  });
});

describe('decision-corrections held-out corpus revision refusal', () => {
  it('refuses a fixture revision of an existing held-out case', async () => {
    const root = await corpusProject('aif-dc-corpus-heldout2-');
    const input = await corpusCase('heldout-holdout.json');
    const saved = await corpusSave(root, input);
    assert.equal(saved.ok, 'ok', 'creating a held-out case stays allowed');
    const revised = { ...input, expected_label: 'a changed label' };
    // corpusSave previews first: the revision leg refuses held-out-tuning.
    const revisedSave = await corpusSave(root, revised);
    assert.equal(revisedSave.ok, 'held-out-tuning', 'a fixture revision of a held-out case is tuning');
  });
});

// ---------------------------------------------------------------------------
// Review round 2 (#285): pre-mutation temp guards, portable delete preflight,
// run scope guard, held-out branch order, replay-engine spy boundary,
// invalid_record visibility, list hardening, and end-to-end consumer bundles.
// ---------------------------------------------------------------------------

async function gitInit(root) {
  const child = spawn('git', ['init', '--initial-branch=main'], { cwd: root, windowsHide: true });
  await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', () => resolve()); });
  for (const args of [['config', 'user.email', 'fixture@example.com'], ['config', 'user.name', 'fixture'], ['add', '.'], ['commit', '-m', 'init']]) {
    const step = spawn('git', args, { cwd: root, windowsHide: true });
    await new Promise((resolve, reject) => { step.on('error', reject); step.on('close', (code) => code === 0 ? resolve() : reject(new Error(`git \${args.join(' ')} exited \${code}`))); });
  }
}

function plantedCaseEnvelope(record) {
  return { checksum: digest(record), record };
}

async function plantCaseRecord(root, scope, caseId, mutate) {
  const caseFile = path.join(root, '.ai-factory', 'state', DECISION_CORRECTIONS_NAMESPACE, scope, 'cases', `${caseId}.json`);
  const envelope = parseStrictJson(await readFile(caseFile, 'utf8'));
  mutate(envelope.record);
  envelope.record.payload_digest = digest(canonical(envelope.record.payload));
  envelope.checksum = digest(envelope.record);
  await writeFile(caseFile, `${JSON.stringify(envelope, null, 2)}\n`);
}

describe('decision-corrections review round 2', () => {
  it('guards temp siblings before the first mutation and refuses instead of skipping', async () => {
    const root = await makeTemp('aif-dc-r2-sib-');
    await seedStoreProject(root);
    await saveCase(root, baseCaseInput({ case_id: 'r2-case' }));
    const casesDir = path.join(root, '.ai-factory', 'state', DECISION_CORRECTIONS_NAMESPACE, 'work', 'cases');
    await writeFile(path.join(casesDir, 'r2-case.json.planted.tmp'), 'planted');
    const guardCalls = [];
    const refusingGuard = async (rootDir, relative) => {
      guardCalls.push(relative);
      // Pass the case leaf and namespace surfaces; only the planted temp
      // sibling is tracked, so the refusal proves the sibling guard ran
      // before the case unlink.
      if (relative.endsWith('.tmp')) return { ok: false, code: 'observation-path-tracked', detail: relative };
      return { ok: true, gitWorktree: true, ignored: true, tracked: false };
    };
    await assert.rejects(
      () => decisionCorrectionsCommand('delete', { case_id: 'r2-case', scope: 'work' }, { rootDir: root, ...STORE_OPTIONS(), gitGuard: refusingGuard }),
      (error) => error?.code === 'observation-path-tracked' && error.blocked === true,
      'a tracked temp sibling refuses the whole delete before any mutation',
    );
    assert.ok(guardCalls.some((p) => p.endsWith('r2-case.json.planted.tmp')), 'the sibling must be guarded before the case leaf is unlinked');
    const listed = await decisionCorrectionsCommand('list', { scope: 'work' }, { rootDir: root, ...STORE_OPTIONS() });
    assert.equal(listed.cases.length, 1, 'the case survives the refused delete');
    assert.ok((await readdirSafe(casesDir)).some((name) => name.endsWith('.tmp')), 'nothing was removed when the guard refused');
  });

  it('refuses a present-but-unproven leaf on delete instead of reporting deleted:false', async () => {
    const root = await makeTemp('aif-dc-r2-corrupt-');
    await seedStoreProject(root);
    await saveCase(root, baseCaseInput({ case_id: 'r2-corrupt' }));
    const caseFile = path.join(root, '.ai-factory', 'state', DECISION_CORRECTIONS_NAMESPACE, 'work', 'cases', 'r2-corrupt.json');
    await writeFile(caseFile, '{"checksum":"broken","record":{"case_id":"r2-corrupt"}}');
    await assert.rejects(
      () => decisionCorrectionsCommand('delete', { case_id: 'r2-corrupt', scope: 'work' }, { rootDir: root, ...STORE_OPTIONS() }),
      (error) => error?.code === 'case-leaf-conflict' && error.blocked === true,
      'a corrupt leaf cannot prove ownership: refusal, not a silent deleted:false',
    );
    // The corrupt leaf also blocks saves in the scope (identity scan), so the
    // typed refusal is the honest recovery boundary for the owner.
    await assert.rejects(
      () => saveCase(root, baseCaseInput({ case_id: 'r2-other', identity: { ...baseCaseInput().identity, subject_revision: 'rev-other' } })),
      (error) => error?.code === 'invalid-state',
    );
    assert.ok(await lstatExists(caseFile), 'the corrupt file stays on disk until the owner resolves it');
  });

  it('keeps the run scoped: alias scope replays nothing and labels the record with the requested scope', async () => {
    const root = await makeTemp('aif-dc-r2-runscope-');
    await seedStoreProject(root);
    await saveCase(root, baseCaseInput({ scope: 'alpha' }));
    await confirmCase(root, baseCaseInput({ scope: 'alpha' }));
    await assert.rejects(
      () => decisionCorrectionsCommand('run', { scope: 'ALPHA' }, { rootDir: root, ...STORE_OPTIONS() }),
      (error) => error?.code === 'scope-collision',
      'an alias scope refuses the run on every platform (portable preflight)',
    );
  });

  it('reports held-out cases as report_only in any status, before draft and ambiguity branches', async () => {
    const root = await makeTemp('aif-dc-r2-heldorder-');
    await seedStoreProject(root);
    await saveCase(root, baseCaseInput({ case_id: 'held-draft', partition: 'held_out', identity: { ...baseCaseInput().identity, subject_revision: 'rev-h1' } }));
    await saveCase(root, baseCaseInput({ case_id: 'held-ambiguous', partition: 'held_out', ambiguity: 'ambiguous', identity: { ...baseCaseInput().identity, subject_revision: 'rev-h2' } }));
    let engineCalls = 0;
    const run = await decisionCorrectionsCommand('run', { scope: 'work' }, {
      rootDir: root, ...STORE_OPTIONS(),
      replayEngines: {
        requirements_semantic_lint: async () => { engineCalls += 1; return 0; },
      },
    });
    const byId = Object.fromEntries(run.run.cases.map((item) => [item.case_id, item]));
    assert.equal(byId['held-draft'].outcome, 'report_only', 'held-out drafts are report_only, not skipped_draft');
    assert.equal(byId['held-ambiguous'].outcome, 'report_only', 'held-out ambiguous cases are report_only, not ambiguous');
    assert.equal(engineCalls, 0, 'no replay engine is invoked for held-out cases');
    assert.equal(run.run.counts.held_out.report_only, 2);
    assert.equal(run.run.counts.held_out.cases, 2);
    assert.equal(run.run.counts.development.cases, 0);
  });

  it('spies the replay engine dispatch boundary with a positive control', async () => {
    const root = await makeTemp('aif-dc-r2-spy-');
    await seedStoreProject(root);
    const devInput = baseCaseInput({ case_id: 'dev-spy' });
    await saveCase(root, devInput);
    await confirmCase(root, devInput);
    const heldInput = baseCaseInput({ case_id: 'held-spy', partition: 'held_out', identity: { ...baseCaseInput().identity, subject_revision: 'rev-spy' } });
    await saveCase(root, heldInput);
    const calls = [];
    const spyEngine = async (argv, engineOptions) => {
      calls.push(argv);
      // Pass the runner's own output collector through: the spy sits on the
      // dispatch boundary, not on the output channel.
      return runRequirementLintCommand(argv, engineOptions);
    };
    const run = await decisionCorrectionsCommand('run', { scope: 'work' }, {
      rootDir: root, ...STORE_OPTIONS(),
      replayEngines: { requirements_semantic_lint: spyEngine },
    });
    const byId = Object.fromEntries(run.run.cases.map((item) => [item.case_id, item]));
    assert.ok(['holds', 'false_regression', 'label_change'].includes(byId['dev-spy'].outcome),
      `positive control: the spy runs the real engine over the development case (got ${byId['dev-spy'].outcome})`);
    assert.ok(byId['dev-spy'].signature.startsWith('run_status='), 'the spy captured a parsed engine observation');
    assert.equal(byId['held-spy'].outcome, 'report_only');
    assert.deepEqual(calls.filter((argv) => argv.includes('--write')), [], 'the spy never sees a --write flag');
    assert.equal(calls.length, 1, 'exactly the development case reached the engine dispatch boundary');
  });

  it('reports a corrupt case as invalid_record instead of dropping it from the run', async () => {
    const root = await makeTemp('aif-dc-r2-invalid-');
    await seedStoreProject(root);
    await saveCase(root, baseCaseInput({ case_id: 'broken-case' }));
    const caseFile = path.join(root, '.ai-factory', 'state', DECISION_CORRECTIONS_NAMESPACE, 'work', 'cases', 'broken-case.json');
    const envelope = parseStrictJson(await readFile(caseFile, 'utf8'));
    delete envelope.record.payload.expected_label;
    envelope.record.payload_digest = digest(canonical(envelope.record.payload));
    envelope.checksum = digest(envelope.record);
    await writeFile(caseFile, `${JSON.stringify(envelope, null, 2)}\n`);
    const run = await decisionCorrectionsCommand('run', { scope: 'work', case_ids: ['broken-case'] }, { rootDir: root, ...STORE_OPTIONS() });
    assert.deepEqual(run.run.cases.map((item) => item.outcome), ['invalid_record'], 'an explicitly selected corrupt case stays visible with a typed outcome');
    assert.equal(run.run.counts.development.invalid_record, 1);
    const listed = await decisionCorrectionsCommand('list', { scope: 'work' }, { rootDir: root, ...STORE_OPTIONS() });
    assert.deepEqual(listed.cases, [], 'the listing skips a structurally broken record instead of crashing');
  });

  it('refuses an invalid overwrite leaf and an occupied run leaf', async () => {
    const root = await makeTemp('aif-dc-r2-leaf-');
    await seedStoreProject(root);
    await saveCase(root, baseCaseInput({ case_id: 'r2-leaf' }));
    // Break the stored record in a way the checksum envelope cannot see: the
    // logical identity no longer derives from the stored material.
    const caseFile = path.join(root, '.ai-factory', 'state', DECISION_CORRECTIONS_NAMESPACE, 'work', 'cases', 'r2-leaf.json');
    const envelope = parseStrictJson(await readFile(caseFile, 'utf8'));
    envelope.record.payload.logical_identity = 'b'.repeat(64);
    envelope.record.payload_digest = digest(canonical(envelope.record.payload));
    envelope.checksum = digest(envelope.record);
    await writeFile(caseFile, `${JSON.stringify(envelope, null, 2)}\n`);
    const revision = baseCaseInput({
      case_id: 'r2-leaf',
      fixture: { kind: 'redacted', files: baseCaseInput().fixture.files.map((file) => ({ ...file, bytes: `${file.bytes}<!-- x -->\n` })) },
    });
    // Both preview and save resolve the stored leaf and must refuse: an
    // overwrite proves the stored record fully valid before replacing it.
    await assert.rejects(
      () => decisionCorrectionsCommand('preview', revision, { rootDir: root, ...STORE_OPTIONS() }),
      (error) => error?.code === 'logical-identity-mismatch',
      'preview refuses an invariant-broken stored leaf',
    );
    await assert.rejects(
      () => decisionCorrectionsCommand('save', { ...revision, payload_digest: 'c'.repeat(64) }, { rootDir: root, ...STORE_OPTIONS() }),
      (error) => ['logical-identity-mismatch', 'payload-mismatch'].includes(error?.code),
      'save refuses an invariant-broken stored leaf before any materialization',
    );
    // Occupied run leaf: the test seam pins the run id.
    const occupied = path.join(root, '.ai-factory', 'state', DECISION_CORRECTIONS_NAMESPACE, 'work', 'runs', 'r2run.json');
    await mkdir(path.dirname(occupied), { recursive: true });
    await writeFile(occupied, '{}');
    await assert.rejects(
      () => decisionCorrectionsCommand('run', { scope: 'work', case_ids: ['no-case'], write: true }, { rootDir: root, ...STORE_OPTIONS(), runId: 'r2run' }),
      (error) => error?.code === 'run-record-conflict',
    );
  });

  it('refuses show of a planted record whose evolution link points at a missing transaction', async () => {
    const root = await makeTemp('aif-dc-r2-show-');
    await seedStoreProject(root);
    const input = baseCaseInput({ case_id: 'r2-show' });
    await saveCase(root, input);
    await plantCaseRecord(root, 'work', 'r2-show', (record) => {
      record.payload.evolution = { transaction_id: 'tx-absent', proposal_digest: 'a'.repeat(64) };
    });
    await assert.rejects(
      () => decisionCorrectionsCommand('show', { case_id: 'r2-show', scope: 'work' }, { rootDir: root, ...STORE_OPTIONS() }),
      (error) => error?.code === 'missing-or-invalid-transaction' && error.blocked === true,
      'the fixed branch: show resolves the link itself and refuses a missing transaction',
    );
  });

  it('refuses a destination that is a presented input at save time (reaches the fixed branch)', async () => {
    const root = await makeTemp('aif-dc-r2-collision-');
    await seedStoreProject(root);
    // The destination file must exist for the provenance read to succeed;
    // the collision refusal then fires in save, not in preview.
    const destination = path.join(root, '.ai-factory', 'state', DECISION_CORRECTIONS_NAMESPACE, 'work', 'cases', 'r2-collide.json');
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, 'would-be-overwritten');
    await assert.rejects(
      () => saveCase(root, baseCaseInput({ case_id: 'r2-collide', identity: { ...baseCaseInput().identity, input_paths: ['.ai-factory/state/decision-corrections/work/cases/r2-collide.json'] } })),
      (error) => error?.code === 'observation-source-collision' || error?.code === 'self-referential-input',
    );
    assert.equal(await readFile(destination, 'utf8'), 'would-be-overwritten', 'the presented input file is untouched');
  });

  it('leaves a fresh project clean when a save refuses before materialization', async () => {
    const root = await makeTemp('aif-dc-r2-fresh-');
    await seedStoreProject(root);
    const namespaceDir = path.join(root, '.ai-factory', 'state', DECISION_CORRECTIONS_NAMESPACE);
    const input = baseCaseInput();
    await assert.rejects(
      () => decisionCorrectionsCommand('save', { ...input, payload_digest: 'f'.repeat(64) }, { rootDir: root, ...STORE_OPTIONS() }),
      (error) => error?.code === 'payload-mismatch',
      'the pre-materialization pass refuses the digest echo before anything is created',
    );
    assert.equal(await lstatExists(namespaceDir), false, 'a refused save on a fresh root leaves no namespace directory behind');
  });

  it('refuses a fixture role bundle that cannot produce a valid replay argv', async () => {
    const root = await makeTemp('aif-dc-r2-roles-');
    await seedStoreProject(root);
    // Trace-link inputs must match the frozen test path form.
    await assert.rejects(
      () => saveCase(root, baseCaseInput({
        case_id: 'r2-trace-role',
        original_assessment: { consumer: 'trace_link_suggestions', verdict: 'v', summary: null },
        fixture: { kind: 'synthetic', files: [{ path: 'docs/spec.md', media_type: 'text/markdown', bytes: 'x' }] },
      })),
      (error) => error?.code === 'invalid-test-input-role',
      'a canonical spec presented as a trace test input is refused at save time',
    );
    // Claim-evidence takes exactly one pairs envelope.
    await assert.rejects(
      () => saveCase(root, baseCaseInput({
        case_id: 'r2-claim-role',
        original_assessment: { consumer: 'claim_evidence_check', verdict: 'v', summary: null },
        fixture: { kind: 'synthetic', files: [
          { path: 'pairs.json', media_type: 'application/json', bytes: '{}' },
          { path: 'pairs2.json', media_type: 'application/json', bytes: '{}' },
        ] },
      })),
      (error) => error?.code === 'invalid-fixture-input-count',
    );
    // An explicit support role keeps a project file out of the consumer argv.
    const supportOnly = baseCaseInput({
      case_id: 'r2-req-support',
      fixture: { kind: 'synthetic', files: [
        { path: 'docs/spec.md', media_type: 'text/markdown', bytes: SPEC_BYTES, role: 'support' },
      ] },
    });
    await assert.rejects(
      () => saveCase(root, supportOnly),
      (error) => error?.code === 'invalid-fixture-input-count',
      'requirement-lint needs at least one role-input file',
    );
  });

  it('replays claim-evidence and trace-link bundles end to end with correct input roles', async () => {
    const root = await makeTemp('aif-dc-r2-e2e-');
    await seedStoreProject(root);
    const pairsEnvelope = {
      schema: 'aifhub.claim_evidence_pairs.v1',
      carrier: { path: 'docs/research.md' },
      checked_scope: 'e2e replay scope',
      claims: [
        { claim_id: 'c1', claim_ref: 'storage requirement', source_ref: { path: 'docs/spec.md' }, relation: 'inference' },
      ],
    };
    const claimInput = baseCaseInput({
      case_id: 'r2-claim-e2e',
      original_assessment: { consumer: 'claim_evidence_check', verdict: 'old verdict', summary: null },
      identity: { ...baseCaseInput().identity, subject_revision: 'rev-claim' },
      fixture: { kind: 'synthetic', files: [
        { path: 'pairs.json', media_type: 'application/json', bytes: `${JSON.stringify(pairsEnvelope, null, 2)}\n` },
        { path: 'docs/research.md', media_type: 'text/markdown', bytes: '# Research\n\nresearch line\n', role: 'support' },
        { path: 'docs/spec.md', media_type: 'text/markdown', bytes: SPEC_BYTES, role: 'support' },
        { path: '.ai-factory/config.yaml', media_type: 'text/yaml', bytes: 'aifhub:\n  claimEvidence:\n    enabled: true\n' },
      ] },
    });
    await saveCase(root, claimInput);
    await confirmCase(root, claimInput);
    const traceInput = baseCaseInput({
      case_id: 'r2-trace-e2e',
      original_assessment: { consumer: 'trace_link_suggestions', verdict: 'old verdict', summary: null },
      identity: { ...baseCaseInput().identity, subject_revision: 'rev-trace' },
      fixture: { kind: 'synthetic', files: [
        { path: '.ai-factory/traces/work/lekalo-trace-manifest.json', media_type: 'application/json', bytes: '{"schema_version":"bogus"}' },
        { path: 'tests/demo.test.js', media_type: 'text/javascript', bytes: 'test("demo", () => {});\n' },
        { path: '.ai-factory/config.yaml', media_type: 'text/yaml', bytes: 'aifhub:\n  traceLinkSuggestions:\n    enabled: true\n' },
      ] },
    });
    await saveCase(root, traceInput);
    await confirmCase(root, traceInput);
    const run = await decisionCorrectionsCommand('run', { scope: 'work' }, { rootDir: root, ...STORE_OPTIONS() });
    const byId = Object.fromEntries(run.run.cases.map((item) => [item.case_id, item]));
    // Claim-evidence: the valid pairs envelope passes the structural stage
    // (quote_checks extracted from a parsed observation); the semantic stage
    // without a DI assessor is an honest not_run.
    assert.equal(byId['r2-claim-e2e'].outcome, 'not_run');
    assert.ok(byId['r2-claim-e2e'].signature.includes('quote_checks=not_applicable'), byId['r2-claim-e2e'].signature);
    // Trace-link: the test file passes the frozen path form and the custody
    // manifest is read from its support path — the bogus manifest is reported
    // as trace-invalid, never as invalid-test-input or invalid-usage.
    assert.equal(byId['r2-trace-e2e'].outcome, 'not_run');
    assert.ok(byId['r2-trace-e2e'].signature.includes('codes=trace-invalid'), byId['r2-trace-e2e'].signature);
    assert.ok(!byId['r2-trace-e2e'].signature.includes('invalid-test-input'), byId['r2-trace-e2e'].signature);
  });
});

async function lstatExists(target) {
  try {
    await (await import('node:fs/promises')).lstat(target);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Review round 3 (#285): effective-ignore proof for the atomic temp shape,
// request-scoped cleanup that never deletes shared ignore infrastructure,
// exact-code branch tests, persisted traversal containment, old-label
// signature stability, role-less legacy idempotency, and sanitized
// invalid_record entries.
// ---------------------------------------------------------------------------

describe('decision-corrections review round 3', () => {
  it('refuses a save when a preserved narrow .gitignore leaves the temp shape visible', async () => {
    const root = await makeTemp('aif-dc-r3-narrow-');
    await seedStoreProject(root);
    // The effective-ignore question only exists inside a git worktree: seed
    // one so verifyObservationIgnored evaluates the real ignore rules.
    await gitInit(root);
    // A pre-existing namespace .gitignore with narrow rules: ensureRuntime
    // Gitignore preserves it, so `*.tmp` siblings would NOT be ignored.
    const namespaceDir = path.join(root, '.ai-factory', 'state', DECISION_CORRECTIONS_NAMESPACE);
    await mkdir(namespaceDir, { recursive: true });
    await writeFile(path.join(namespaceDir, '.gitignore'), '*.json\n!.gitignore\n');
    // The digest echo must be valid so the pre-materialization pass clears
    // and the probe guard (after prepareNamespace) is the refusing branch.
    const input = baseCaseInput();
    const preview = await decisionCorrectionsCommand('preview', input, { rootDir: root, ...STORE_OPTIONS() });
    const outputs = [];
    const exit = await runDecisionCorrectionsCommand(['save', '--json'], {
      rootDir: root, enabled: true, output: (value) => outputs.push(value),
      readStdin: async () => Buffer.from(JSON.stringify({ ...input, payload_digest: preview.payload_digest }), 'utf8'),
    });
    assert.equal(exit, 1, 'the save must refuse when the temp shape is not effectively ignored');
    assert.equal(JSON.parse(outputs.join('')).code, 'observation-path-not-ignored');
    const stored = await readdirSafe(path.join(namespaceDir, 'work', 'cases'));
    assert.deepEqual(stored.filter((name) => name.endsWith('.json')), [], 'no case file is written behind an ineffective ignore');
    assert.equal((await readdirSafe(namespaceDir)).includes('.gitignore'), true, 'the pre-existing ignore file is never deleted');
    assert.equal((await readdirSafe(path.join(namespaceDir, 'work', 'cases'))).some((name) => name.endsWith('.tmp')), false, 'no temp file was ever materialized');
  });

  it('keeps the shared .gitignore when another writer holds the scope lock', async () => {
    const root = await makeTemp('aif-dc-r3-locked-');
    await seedStoreProject(root);
    // Writer "A" state: namespace .gitignore exists (created by A) and A is
    // mid-flight holding the scope lock; writer B must fail state-locked
    // WITHOUT deleting the shared ignore infrastructure.
    const namespaceDir = path.join(root, '.ai-factory', 'state', DECISION_CORRECTIONS_NAMESPACE);
    const lockPath = path.join(namespaceDir, 'work', 'write.lock');
    await mkdir(path.dirname(lockPath), { recursive: true });
    await writeFile(path.join(namespaceDir, '.gitignore'), '*\n!.gitignore\n');
    const { open } = await import('node:fs/promises');
    const handle = await open(lockPath, 'wx');
    try {
      await assert.rejects(
        () => saveCase(root, baseCaseInput()),
        (error) => error?.code === 'state-locked',
      );
    } finally {
      await handle.close();
      await rm(lockPath, { force: true });
    }
    assert.equal((await readdirSafe(namespaceDir)).includes('.gitignore'), true, 'the concurrent writer’s ignore file survives B’s failed save');
  });

  it('reaches the observation-source-collision save guard through a direct save call', async () => {
    const root = await makeTemp('aif-dc-r3-collide-');
    await seedStoreProject(root);
    const destinationRelative = `.ai-factory/state/${DECISION_CORRECTIONS_NAMESPACE}/work/cases/r3-collide.json`;
    const destination = path.join(root, ...destinationRelative.split('/'));
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, 'presented input bytes');
    await assert.rejects(
      () => decisionCorrectionsCommand('save', {
        ...baseCaseInput({ case_id: 'r3-collide', identity: { ...baseCaseInput().identity, input_paths: [destinationRelative] } }),
        payload_digest: 'a'.repeat(64),
      }, { rootDir: root, ...STORE_OPTIONS() }),
      (error) => error?.code === 'observation-source-collision' && error.blocked === true,
      'the save-level collision guard fires before the identity pass',
    );
    assert.equal(await readFile(destination, 'utf8'), 'presented input bytes', 'the presented input is untouched');
  });

  it('pins the overwrite-leaf refusal to the exact invariant code', async () => {
    const root = await makeTemp('aif-dc-r3-overwrite-');
    await seedStoreProject(root);
    await saveCase(root, baseCaseInput({ case_id: 'r3-leaf' }));
    const caseFile = path.join(root, '.ai-factory', 'state', DECISION_CORRECTIONS_NAMESPACE, 'work', 'cases', 'r3-leaf.json');
    const envelope = parseStrictJson(await readFile(caseFile, 'utf8'));
    envelope.record.payload.logical_identity = 'b'.repeat(64);
    envelope.record.payload_digest = digest(canonical(envelope.record.payload));
    envelope.checksum = digest(envelope.record);
    await writeFile(caseFile, `${JSON.stringify(envelope, null, 2)}\n`);
    const revision = baseCaseInput({
      case_id: 'r3-leaf',
      fixture: { kind: 'redacted', files: baseCaseInput().fixture.files.map((file) => ({ ...file, bytes: `${file.bytes}<!-- x -->\n` })) },
    });
    await assert.rejects(
      () => decisionCorrectionsCommand('save', { ...revision, payload_digest: 'c'.repeat(64) }, { rootDir: root, ...STORE_OPTIONS() }),
      (error) => error?.code === 'logical-identity-mismatch',
      'the pre-materialization pass refuses the invariant-broken leaf with its own code',
    );
  });

  it('bounds a persisted traversal path to its case (invalid_record, engine untouched)', async () => {
    const root = await makeTemp('aif-dc-r3-traverse-');
    await seedStoreProject(root);
    const input = baseCaseInput({ case_id: 'r3-traverse' });
    await saveCase(root, input);
    await confirmCase(root, input);
    // Persisted adversarial fixture path: the schema has no path pattern, so
    // only the replay-path revalidation can catch it.
    const caseFile = path.join(root, '.ai-factory', 'state', DECISION_CORRECTIONS_NAMESPACE, 'work', 'cases', 'r3-traverse.json');
    const envelope = parseStrictJson(await readFile(caseFile, 'utf8'));
    envelope.record.payload.fixture.files[0].path = '../escape.md';
    envelope.record.payload_digest = digest(canonical(envelope.record.payload));
    envelope.checksum = digest(envelope.record);
    await writeFile(caseFile, `${JSON.stringify(envelope, null, 2)}\n`);
    let engineCalls = 0;
    const run = await decisionCorrectionsCommand('run', { scope: 'work', case_ids: ['r3-traverse'] }, {
      rootDir: root, ...STORE_OPTIONS(),
      replayEngines: { requirements_semantic_lint: async () => { engineCalls += 1; return 0; } },
    });
    const [traversalOutcome, traversalReason] = run.run.cases.map((item) => [item.outcome, item.signature])[0];
    assert.equal(traversalOutcome, 'invalid_record');
    assert.ok(['unsafe-path', 'unsafe-fixture-path'].includes(traversalReason), `typed reason, got \${traversalReason}`);
    assert.equal(engineCalls, 0, 'the engine is never invoked for a case with an unsafe persisted path');
    assert.equal(run.run.counts.development.invalid_record, 1);
    assert.equal(await lstatExists(path.join(root, 'escape.md')), false, 'nothing escapes the replay root');
  });

  it('keeps old-format stored labels stable when the engine output gains no codes field', async () => {
    const root = await makeTemp('aif-dc-r3-oldlabel-');
    await seedStoreProject(root);
    const knownSignature = 'run_status=complete; findings=none; diagnostics=none';
    const input = baseCaseInput({ case_id: 'r3-oldlabel', expected_label: knownSignature });
    await saveCase(root, input);
    await confirmCase(root, input);
    const run = await decisionCorrectionsCommand('run', { scope: 'work' }, { rootDir: root, ...STORE_OPTIONS() });
    assert.equal(run.run.cases.find((item) => item.case_id === 'r3-oldlabel').outcome, 'holds',
      'a stored pre-codes label must keep holding when the observation shape is unchanged');
  });

  it('keeps role-less legacy bundles idempotent without demoting confirmation', async () => {
    const root = await makeTemp('aif-dc-r3-legacy-');
    await seedStoreProject(root);
    const input = baseCaseInput({ case_id: 'r3-legacy' });
    const { preview } = await saveCase(root, input);
    await confirmCase(root, input);
    // Strip the optional role key from the stored bundle: a legacy record
    // written before roles existed must still compare idempotent.
    const caseFile = path.join(root, '.ai-factory', 'state', DECISION_CORRECTIONS_NAMESPACE, 'work', 'cases', 'r3-legacy.json');
    const envelope = parseStrictJson(await readFile(caseFile, 'utf8'));
    for (const file of envelope.record.payload.fixture.files) delete file.role;
    envelope.record.payload_digest = digest(canonical(envelope.record.payload));
    envelope.checksum = digest(envelope.record);
    await writeFile(caseFile, `${JSON.stringify(envelope, null, 2)}\n`);
    const legacyPreview = await decisionCorrectionsCommand('preview', input, { rootDir: root, ...STORE_OPTIONS() });
    assert.equal(legacyPreview.idempotent, true, 'the role-less legacy record previews as idempotent');
    const resaved = await decisionCorrectionsCommand('save', { ...input, payload_digest: legacyPreview.payload_digest }, { rootDir: root, ...STORE_OPTIONS() });
    assert.equal(resaved.idempotent, true, 'a role-less legacy record must stay idempotent (roles derive from paths)');
    assert.equal(resaved.case.status, 'confirmed', 'the idempotent re-save keeps the confirmation');
    void preview;
  });

  it('sanitizes invalid_record entries so a hostile record cannot break the run schema', async () => {
    const root = await makeTemp('aif-dc-r3-sanitize-');
    await seedStoreProject(root);
    await saveCase(root, baseCaseInput({ case_id: 'r3-hostile' }));
    const caseFile = path.join(root, '.ai-factory', 'state', DECISION_CORRECTIONS_NAMESPACE, 'work', 'cases', 'r3-hostile.json');
    const envelope = parseStrictJson(await readFile(caseFile, 'utf8'));
    envelope.record.payload.case_id = '!!bad-case-id-that-is-way-longer-than-eighty-characters-and-fails-the-pattern-check';
    envelope.record.payload.original_assessment.consumer = 'unknown-consumer';
    envelope.record.payload_digest = digest(canonical(envelope.record.payload));
    envelope.checksum = digest(envelope.record);
    await writeFile(caseFile, `${JSON.stringify(envelope, null, 2)}\n`);
    const run = await decisionCorrectionsCommand('run', { scope: 'work' }, { rootDir: root, ...STORE_OPTIONS() });
    assert.deepEqual(run.run.cases.map((item) => item.outcome), ['invalid_record'], 'the run schema stays valid');
    assert.equal(run.run.cases[0].case_id, 'r3-hostile', 'the diagnostic identity mirrors the filename for a hostile case_id');
    assert.equal(run.run.cases[0].consumer, 'requirements_semantic_lint', 'an untrusted consumer mirrors the default engine');
    assert.equal(run.run.counts.development.invalid_record, 1);
  });

  it('degrades a claim bundle without consumable inputs to an honest not_run', async () => {
    const root = await makeTemp('aif-dc-r3-nopairs-');
    await seedStoreProject(root);
    const input = baseCaseInput({
      case_id: 'r3-nopairs',
      original_assessment: { consumer: 'claim_evidence_check', verdict: 'old verdict', summary: null },
      fixture: { kind: 'synthetic', files: [
        { path: 'pairs.json', media_type: 'application/json', bytes: '{"schema":"aifhub.claim_evidence_pairs.v1"}' },
        { path: 'docs/spec.md', media_type: 'text/markdown', bytes: SPEC_BYTES, role: 'support' },
        { path: '.ai-factory/config.yaml', media_type: 'text/yaml', bytes: 'aifhub:\n  claimEvidence:\n    enabled: true\n' },
      ] },
    });
    await saveCase(root, input);
    await confirmCase(root, input);
    // Legacy/adversarial shape planted on the stored record: the pairs
    // envelope moved under `.ai-factory/` makes every file support — zero
    // role-input files. Such a bundle cannot be created through save (the
    // grammar gate refuses), so it is planted directly.
    {
      const caseFile = path.join(root, '.ai-factory', 'state', DECISION_CORRECTIONS_NAMESPACE, 'work', 'cases', 'r3-nopairs.json');
      const envelope = parseStrictJson(await readFile(caseFile, 'utf8'));
      envelope.record.payload.fixture.files = envelope.record.payload.fixture.files.map((file) => ({
        ...file, path: file.path.startsWith('.ai-factory/') ? file.path : `.ai-factory/moved/${file.path}`,
      }));
      envelope.record.payload_digest = digest(canonical(envelope.record.payload));
      envelope.checksum = digest(envelope.record);
      await writeFile(caseFile, `${JSON.stringify(envelope, null, 2)}\n`);
    }
    const run = await decisionCorrectionsCommand('run', { scope: 'work' }, { rootDir: root, ...STORE_OPTIONS() });
    assert.equal(run.run.cases[0].outcome, 'not_run', 'the replayed producer refuses the missing --pairs honestly');
    assert.ok(run.run.cases[0].signature.includes('codes=empty-input'), run.run.cases[0].signature);
  });
});

// ---------------------------------------------------------------------------
// Devin PR-review round (#296): duplicate fixture paths, occurrence-preserving
// signatures, full-signature comparison, fixture-corruption staleness, and
// embedded private paths in leak checks.
// ---------------------------------------------------------------------------

describe('decision-corrections devin PR-review round', () => {
  it('refuses a duplicate fixture path at save time', async () => {
    const root = await makeTemp('aif-dc-d4-dup-');
    await seedStoreProject(root);
    const input = baseCaseInput({ case_id: 'd4-dup' });
    input.fixture.files.push({ path: 'docs/spec.md', media_type: 'text/markdown', bytes: 'overwriting bytes' });
    await assert.rejects(
      () => saveCase(root, input),
      (error) => error?.code === 'duplicate-fixture-path' && error.blocked === true,
      'a repeated fixture path would let replay overwrite stored evidence',
    );
  });

  it('keeps repeated findings occurrence-sensitive in the signature', async () => {
    const two = extractOutcomeSignature(JSON.stringify({
      run_status: 'complete',
      findings: [{ type: 'ambiguity' }, { type: 'ambiguity' }],
      diagnostics: [],
    }));
    const one = extractOutcomeSignature(JSON.stringify({
      run_status: 'complete',
      findings: [{ type: 'ambiguity' }],
      diagnostics: [],
    }));
    assert.notEqual(two.signature, one.signature, 'losing one of two same-type findings must change the signature');
    assert.ok(two.signature.includes('findings=ambiguity|ambiguity'), two.signature);
    assert.ok(one.signature.includes('findings=ambiguity'), one.signature);
  });

  it('compares labels against the full signature, not the truncated stored prefix', async () => {
    const root = await makeTemp('aif-dc-d4-trunc-');
    await seedStoreProject(root);
    // Shared 500+ char prefix, diverging tail: comparing the stored
    // 500-character prefix would falsely hold; the full-signature comparison
    // must classify label_change.
    const sharedPrefix = 'run_status=complete; findings=none; diagnostics=none; padding=' + 'p'.repeat(480);
    const input = baseCaseInput({
      case_id: 'd4-trunc',
      identity: { ...baseCaseInput().identity, subject_revision: 'rev-trunc' },
      expected_label: `${sharedPrefix}; tail=EXPECTED`,
    });
    await saveCase(root, input);
    await confirmCase(root, input);
    const spyObservation = JSON.stringify({
      run_status: 'complete',
      findings: [],
      diagnostics: [],
      padding_note: `${sharedPrefix}; tail=REPLAYED`,
    });
    // Padding notes are not part of the real signature; instead make the
    // observation carry a long diagnostics list so the real signature exceeds
    // 500 characters with the expected prefix and a diverging tail.
    const longDiagnostics = Array.from({ length: 60 }, (_, index) => ({ code: `pad-${String(index).padStart(3, '0')}` }));
    const longObservation = JSON.stringify({
      run_status: 'complete',
      findings: [],
      diagnostics: longDiagnostics,
    });
    void spyObservation;
    void longObservation;
    const stored = parseStrictJson(await readFile(path.join(root, '.ai-factory', 'state', DECISION_CORRECTIONS_NAMESPACE, 'work', 'cases', 'd4-trunc.json'), 'utf8'));
    // The expected signature form mirrors exactly what the extractor derives
    // from a `findings: []` observation (no codes section — it is included
    // only when the envelope defines a codes array), so the diverging tail
    // below is the ONLY difference between the compared signatures.
    const expectedFull = `run_status=complete; findings=none; diagnostics=pad-000|pad-001|pad-002|pad-003|pad-004|pad-005|pad-006|pad-007|pad-008|pad-009|pad-010|pad-011|pad-012|pad-013|pad-014|pad-015|pad-016|pad-017|pad-018|pad-019|pad-020|pad-021|pad-022|pad-023|pad-024|pad-025|pad-026|pad-027|pad-028|pad-029|pad-030|pad-031|pad-032|pad-033|pad-034|pad-035|pad-036|pad-037|pad-038|pad-039|pad-040|pad-041|pad-042|pad-043|pad-044|pad-045|pad-046|pad-047|pad-048|pad-049|pad-050|pad-051|pad-052|pad-053|pad-054|pad-055|pad-056|pad-057|pad-058|pad-059`;
    // Overwrite the confirmed label with the full-length expected signature.
    stored.record.payload.expected_label = expectedFull;
    stored.record.payload_digest = digest(canonical(stored.record.payload));
    stored.checksum = digest(stored.record);
    await writeFile(path.join(root, '.ai-factory', 'state', DECISION_CORRECTIONS_NAMESPACE, 'work', 'cases', 'd4-trunc.json'), `${JSON.stringify(stored, null, 2)}\n`);
    // The spy emits the same signature but with a diverging tail beyond the
    // 500-character stored bound.
    const divergingDiagnostics = longDiagnostics.slice(0, 59);
    const spyEngine = async (argv, engineOptions) => {
      const observation = JSON.stringify({
        run_status: 'complete',
        findings: [],
        diagnostics: [...divergingDiagnostics, { code: 'pad-tail' }],
      });
      engineOptions.output(`${observation}\n`);
      return 0;
    };
    const run = await decisionCorrectionsCommand('run', { scope: 'work' }, {
      rootDir: root, ...STORE_OPTIONS(),
      replayEngines: { requirements_semantic_lint: spyEngine },
    });
    const entry = run.run.cases.find((item) => item.case_id === 'd4-trunc');
    assert.equal(entry.outcome, 'label_change', 'a diverging tail beyond the 500-char stored prefix must not falsely hold');
    assert.equal(entry.signature.length, 500, 'the stored signature stays bounded at 500 characters');
  });

  it('classifies a corrupted fixture as stale per the policy', async () => {
    const root = await makeTemp('aif-dc-d4-corrupt-');
    await seedStoreProject(root);
    const input = baseCaseInput({ case_id: 'd4-corrupt' });
    await saveCase(root, input);
    await confirmCase(root, input);
    // Corrupt the evidence bytes AND keep the envelope self-consistent: the
    // fixture digest invariant must catch it and the run must classify stale.
    const caseFile = path.join(root, '.ai-factory', 'state', DECISION_CORRECTIONS_NAMESPACE, 'work', 'cases', 'd4-corrupt.json');
    const envelope = parseStrictJson(await readFile(caseFile, 'utf8'));
    envelope.record.payload.fixture.files[0].bytes = `${envelope.record.payload.fixture.files[0].bytes}tampered`;
    envelope.record.payload_digest = digest(canonical(envelope.record.payload));
    envelope.checksum = digest(envelope.record);
    await writeFile(caseFile, `${JSON.stringify(envelope, null, 2)}\n`);
    const run = await decisionCorrectionsCommand('run', { scope: 'work' }, { rootDir: root, ...STORE_OPTIONS() });
    assert.deepEqual(run.run.cases.map((item) => [item.outcome, item.signature]), [['stale', 'fixture-digest-mismatch']],
      'corrupted fixture evidence is stale per the policy, not invalid_record');
    assert.equal(run.run.counts.development.stale, 1);
    assert.equal(run.run.counts.development.invalid_record, 0);
  });

  it('refuses an embedded private unix path that does not follow a JSON quote', async () => {
    const root = await makeTemp('aif-dc-d4-leak-');
    await seedStoreProject(root);
    await assert.rejects(
      () => saveCase(root, baseCaseInput({ case_id: 'd4-leak', rationale: 'see /home/alice/private notes' })),
      (error) => error?.code === 'privacy-leak',
      'an embedded private path must trip the leak predicate without a leading quote',
    );
    assert.equal(hasCorrectionsLeak({ note: 'see /home/alice/private notes' }), true);
    // Legitimate repo-relative references stay allowed.
    assert.equal(hasCorrectionsLeak({ note: 'see docs/research.md for details' }), false);
  });
});

// ---------------------------------------------------------------------------
// Signature format versioning (#297 / R3-3): the replay signature format is
// versioned at the record level, legacy records read as version 1, a foreign
// version is stale (never label_change), and lifecycle transitions preserve
// the version.
// ---------------------------------------------------------------------------

describe('decision-corrections signature format version', () => {
  const KNOWN_SIGNATURE = 'run_status=complete; findings=none; diagnostics=none';

  async function readStoredRecord(root, scope, caseId) {
    const caseFile = path.join(root, '.ai-factory', 'state', DECISION_CORRECTIONS_NAMESPACE, scope, 'cases', `${caseId}.json`);
    return parseStrictJson(await readFile(caseFile, 'utf8')).record;
  }

  async function rewriteStoredRecord(root, scope, caseId, mutate) {
    const caseFile = path.join(root, '.ai-factory', 'state', DECISION_CORRECTIONS_NAMESPACE, scope, 'cases', `${caseId}.json`);
    const envelope = parseStrictJson(await readFile(caseFile, 'utf8'));
    mutate(envelope.record);
    envelope.record.payload_digest = digest(canonical(envelope.record.payload));
    envelope.checksum = digest(envelope.record);
    await writeFile(caseFile, `${JSON.stringify(envelope, null, 2)}\n`);
    return envelope.record;
  }

  it('carries signature_format_version = 1 on every new record', async () => {
    const root = await makeTemp('aif-dc-v1-new-');
    await seedStoreProject(root);
    await saveCase(root, baseCaseInput({ case_id: 'v1-new' }));
    const record = await readStoredRecord(root, 'work', 'v1-new');
    assert.equal(record.signature_format_version, 1, 'a freshly saved record pins the current signature format version');
    // The record level is outside the payload: the digest and identity are
    // untouched by the versioning field.
    assert.equal(Object.hasOwn(record.payload, 'signature_format_version'), false);
  });

  it('classifies a foreign signature format version as stale, never label_change', async () => {
    const root = await makeTemp('aif-dc-v1-foreign-');
    await seedStoreProject(root);
    // Labels chosen so the replay WOULD report label_change if the version
    // gate failed to fire (confirmed, unambiguous, development partition —
    // the only shape that reaches the pre-engine stale branch).
    const input = baseCaseInput({
      case_id: 'v1-foreign',
      identity: { ...baseCaseInput().identity, subject_revision: 'rev-v1-foreign' },
      original_assessment: { consumer: 'requirements_semantic_lint', verdict: 'the old verdict', summary: null },
      expected_label: 'some expected label',
    });
    await saveCase(root, input);
    await confirmCase(root, input);
    await rewriteStoredRecord(root, 'work', 'v1-foreign', (record) => {
      record.signature_format_version = 2;
    });
    let engineCalls = 0;
    const spyEngine = async () => { engineCalls += 1; return 0; };
    const run = await decisionCorrectionsCommand('run', { scope: 'work' }, {
      rootDir: root, ...STORE_OPTIONS(),
      replayEngines: { requirements_semantic_lint: spyEngine },
    });
    const entry = run.run.cases.find((item) => item.case_id === 'v1-foreign');
    assert.deepEqual([entry.outcome, entry.signature], ['stale', 'signature-format-version'],
      'a foreign format version is stale with its own signature, not a label comparison');
    assert.equal(run.run.counts.development.stale, 1);
    assert.equal(run.run.counts.development.label_change, 0);
    assert.equal(engineCalls, 0, 'the engine is never called for a foreign-format record');
  });

  it('reads a legacy record without the field as version 1 and holds', async () => {
    const root = await makeTemp('aif-dc-v1-legacy-');
    await seedStoreProject(root);
    const input = baseCaseInput({
      case_id: 'v1-legacy',
      identity: { ...baseCaseInput().identity, subject_revision: 'rev-v1-legacy' },
      expected_label: KNOWN_SIGNATURE,
    });
    await saveCase(root, input);
    await confirmCase(root, input);
    // Strip the field to simulate a pre-versioning stored record; the
    // checksum rewrite keeps the envelope self-consistent.
    const stripped = await rewriteStoredRecord(root, 'work', 'v1-legacy', (record) => {
      delete record.signature_format_version;
    });
    assert.equal(Object.hasOwn(stripped, 'signature_format_version'), false);
    const run = await decisionCorrectionsCommand('run', { scope: 'work' }, { rootDir: root, ...STORE_OPTIONS() });
    const entry = run.run.cases.find((item) => item.case_id === 'v1-legacy');
    assert.equal(entry.outcome, 'holds', 'a legacy record replays with its ordinary outcome');
    assert.equal(run.run.counts.development.stale, 0);
  });

  it('keeps an idempotent re-save of a legacy record idempotent without adding the field', async () => {
    const root = await makeTemp('aif-dc-v1-idem-');
    await seedStoreProject(root);
    const input = baseCaseInput({ case_id: 'v1-idem', identity: { ...baseCaseInput().identity, subject_revision: 'rev-v1-idem' } });
    await saveCase(root, input);
    await confirmCase(root, input);
    await rewriteStoredRecord(root, 'work', 'v1-idem', (record) => {
      delete record.signature_format_version;
    });
    const again = await decisionCorrectionsCommand('preview', input, { rootDir: root, ...STORE_OPTIONS() });
    assert.equal(again.idempotent, true, 'a legacy record still resolves idempotently');
    const resaved = await decisionCorrectionsCommand('save', { ...input, payload_digest: again.payload_digest }, { rootDir: root, ...STORE_OPTIONS() });
    assert.equal(resaved.idempotent, true);
    assert.equal(resaved.case.status, 'confirmed', 'an idempotent re-save must not demote a confirmed legacy case');
    const stored = await readStoredRecord(root, 'work', 'v1-idem');
    assert.equal(Object.hasOwn(stored, 'signature_format_version'), false,
      'the idempotent branch returns the stored record untouched — it must not backfill the field');
  });

  it('preserves the signature format version through confirm and lifecycle transitions', async () => {
    const root = await makeTemp('aif-dc-v1-cycle-');
    await seedStoreProject(root);
    const input = baseCaseInput({ case_id: 'v1-cycle', identity: { ...baseCaseInput().identity, subject_revision: 'rev-v1-cycle' } });
    await saveCase(root, input);
    await confirmCase(root, input);
    assert.equal((await readStoredRecord(root, 'work', 'v1-cycle')).signature_format_version, 1, 'confirm keeps the version');
    await decisionCorrectionsCommand('supersede', { case_id: 'v1-cycle', scope: 'work', reason: 'moved on' }, { rootDir: root, ...STORE_OPTIONS() });
    const superseded = await readStoredRecord(root, 'work', 'v1-cycle');
    assert.equal(superseded.signature_format_version, 1, 'lifecycle spread preserves the version');
    assert.equal(superseded.status, 'superseded');
  });
});
