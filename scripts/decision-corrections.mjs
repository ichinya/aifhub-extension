// Project-scoped store of owner-confirmed AI-assessment corrections as
// immutable decision-correction fixtures (issue #285). State-only, offline:
// no network access, no paid calls, no SDK calls, no URLs opened or fetched;
// every string presented by a caller is data, never a command, path, or
// provider instruction. The advisory engines (#281/#282/#283) are replayed
// read-only through their exported run commands inside an isolated temp root
// and are never modified by this module. A correction case is a diagnostic
// artifact: `diagnostic_only: true` and `authorizes: []` — it never verifies
// facts, never creates an `aif-gate-result`, never writes QA evidence, and
// never grants workflow authority. The replay runner's honesty note is a
// contract term, not decoration: run verifies the current implementation
// against stored fixtures; it does not measure provider quality.
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile, lstat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WorkflowError, boundedText, canonical, digest, fields, identifier, portablePath, requireValue, storeFor } from './workflow-state-store.mjs';
import { parseStrictJson } from './json-strict.mjs';
import { validateJsonAgainstSchema } from './json-schema-subset.mjs';
import { ensureRuntimeGitignore } from './runtime-gitignore.mjs';
import { verifyObservationIgnored } from './requirement-lint-git-guard.mjs';
import { assessmentCanonical } from './typed-assessment.mjs';
import { evolutionCommand } from './evolution-transactions.mjs';
import { runRequirementLintCommand } from './requirement-lint.mjs';
import { runClaimEvidenceCheckCommand } from './claim-evidence-check.mjs';
import { runTraceLinkSuggestionsCommand } from './trace-link-suggestions.mjs';

export const DECISION_CORRECTIONS_SCHEMA = 'aifhub.decision_correction_fixture.v1';
export const DECISION_CORRECTION_RUN_SCHEMA = 'aifhub.decision_correction_run.v1';
export const DECISION_CORRECTIONS_NAMESPACE = 'decision-corrections';
export const STATE_ROOT = '.ai-factory/state';
export const NAMESPACE_ROOT = `${STATE_ROOT}/${DECISION_CORRECTIONS_NAMESPACE}`;
export const CONTRACT_MODULE = 'schemas/decision-correction-fixture.schema.json';
export const RUN_CONTRACT_MODULE = 'schemas/decision-correction-run.schema.json';
export const MAX_STDIN_BYTES = 1024 * 1024;
export const MAX_FIXTURE_FILES = 8;
export const MAX_FIXTURE_FILE_BYTES = 128 * 1024;
export const MAX_FIXTURE_TOTAL_BYTES = 512 * 1024;
export const MAX_INPUT_REVISIONS = 100;
export const MAX_REPLAY_ARGS = 40;
export const MAX_RUN_CASES = 200;
export const MAX_IDENTITY_SOURCE_CHARS = 64 * 1024;
export const HONESTY_NOTE = 'Run verifies the current implementation against stored fixtures; it does not measure provider quality.';

const STATUSES = Object.freeze(['draft', 'confirmed', 'rejected', 'superseded']);
const PARTITIONS = Object.freeze(['development', 'calibration', 'held_out']);
const AMBIGUITY_STATES = Object.freeze(['clear', 'ambiguous']);
const FIXTURE_KINDS = Object.freeze(['redacted', 'synthetic']);
// Replay map (solution 2-A): exported run commands with a DI assessor seam.
// `context_selection_overlay` is intentionally absent: its run-command
// contract is not a pinned DI surface in this repository, so replay reports
// an honest `unsupported_consumer` instead of guessing an integration.
const REPLAY_ENGINES = Object.freeze({
  requirements_semantic_lint: runRequirementLintCommand,
  claim_evidence_check: runClaimEvidenceCheckCommand,
  trace_link_suggestions: runTraceLinkSuggestionsCommand,
});
// Allowlist projection of the identity source observation, applied BEFORE
// assessmentCanonical (observation schemas require `generated_at`, which is a
// banned binding key and would throw). Release-pinned SHAs (binding, engine,
// helper, contract) and run-time fields (run_status, findings, diagnostics,
// coverage, worktree_identity) are deliberately excluded: they would turn
// every helper release into a new logical identity without semantic change.
const IDENTITY_OBSERVATION_FIELDS = Object.freeze(['schema', 'change_id', 'language', 'structural', 'semantic', 'inputs', 'rubric']);

const here = path.dirname(fileURLToPath(import.meta.url));
const CONTRACT_SCHEMA_TEXT = await readFile(path.join(here, '..', CONTRACT_MODULE), 'utf8');
const RUN_SCHEMA_TEXT = await readFile(path.join(here, '..', RUN_CONTRACT_MODULE), 'utf8');

function caseSchema() { return parseStrictJson(CONTRACT_SCHEMA_TEXT); }
function runSchema() { return parseStrictJson(RUN_SCHEMA_TEXT); }

// ---------------------------------------------------------------------------
// Closed config read for the `aifhub.decisionCorrections` opt-in namespace
// (mirror of the claim-evidence subset parser): explicit detections keep the
// mechanism off with bounded diagnostics; a malformed namespace forces off
// even against a CLI override, and `paths` stays structural so the
// `state-root-mismatch` writer guard is live on flow/scalar forms.
// ---------------------------------------------------------------------------

const CORRECTIONS_CONFIG_PATH = Object.freeze(['aifhub', 'decisionCorrections']);
const CORRECTIONS_CONFIG_CLOSED_KEYS = Object.freeze(new Set(['enabled']));
const CORRECTIONS_STRUCTURAL_PATHS = Object.freeze([
  ['aifhub'],
  CORRECTIONS_CONFIG_PATH,
  ['paths'],
]);

function correctionsConfigDiagnostic(code, detail) {
  return { code: `decision-corrections:${code}`, path: '.ai-factory/config.yaml', detail: detail === undefined ? null : String(detail).slice(0, 200) };
}

function stripLineComment(line) {
  let inQuote = null;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (inQuote) {
      if (character === inQuote) inQuote = null;
      continue;
    }
    if (character === '"' || character === "'") inQuote = character;
    else if (character === '#' && index > 0 && /\s/.test(line[index - 1])) return line.slice(0, index);
  }
  return line;
}

export function parseDecisionCorrectionsConfigSubset(raw) {
  const diagnostics = [];
  const root = Object.create(null);
  const stack = [{ indent: -1, value: root, path: [] }];
  const belowNamespace = (candidatePath) => candidatePath.length > CORRECTIONS_CONFIG_PATH.length
    && CORRECTIONS_CONFIG_PATH.every((part, index) => candidatePath[index] === part);
  const structural = (candidatePath) => CORRECTIONS_STRUCTURAL_PATHS.some((entry) => entry.length === candidatePath.length
    && entry.every((part, index) => candidatePath[index] === part));
  const scalar = (rawValue) => {
    if (/^(['"]).*\1$/.test(rawValue)) return { text: rawValue.slice(1, -1), quoted: true };
    if (/^['"]/.test(rawValue)) return { unterminated: true, text: rawValue, quoted: false };
    if (/^(true|false)$/i.test(rawValue)) return { bool: rawValue.toLowerCase() === 'true', text: rawValue, quoted: false };
    if (/^-?\d+(?:\.\d+)?$/.test(rawValue)) return { number: Number(rawValue), text: rawValue, quoted: false };
    return { text: rawValue, quoted: false };
  };
  for (const rawLine of String(raw ?? '').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const withoutComment = stripLineComment(rawLine);
    if (withoutComment.trim().length === 0) continue;
    const match = /^(\s*)([^:]+):(?:\s*(.*))?$/.exec(withoutComment);
    if (!match) {
      // A non-mapping line inside a guarded context is a malformed namespace
      // form, never a silent skip: the mechanism must not stay enabled
      // because an unparseable line happened to sit next to `enabled: true`
      // (parity with the trace-link parser's malformed-line diagnostic).
      const parentPath = stack.at(-1).path;
      if (belowNamespace(parentPath) || structural(parentPath)
        || (parentPath.length >= CORRECTIONS_CONFIG_PATH.length
          && CORRECTIONS_CONFIG_PATH.every((part, index) => parentPath[index] === part))) {
        diagnostics.push(correctionsConfigDiagnostic('malformed-line', withoutComment.trim().slice(0, 100)));
      }
      continue;
    }
    const indent = match[1].length;
    const key = match[2].trim();
    const rawValue = match[3]?.trim() ?? '';
    while (stack.length > 1 && stack.at(-1).indent >= indent) stack.pop();
    const parent = stack.at(-1);
    const ownPath = [...parent.path, key];
    const inside = belowNamespace(ownPath);
    const guarded = inside || structural(ownPath);
    if (guarded && key === '<<') {
      diagnostics.push(correctionsConfigDiagnostic('merge-key', key));
      continue;
    }
    if (guarded && rawValue.startsWith('&')) {
      diagnostics.push(correctionsConfigDiagnostic('anchor', key));
      continue;
    }
    if (guarded && rawValue.startsWith('*')) {
      diagnostics.push(correctionsConfigDiagnostic('alias', key));
      continue;
    }
    if (guarded && /^[{[]/.test(rawValue)) {
      diagnostics.push(correctionsConfigDiagnostic('flow-mapping', key));
      continue;
    }
    if (guarded && Object.hasOwn(parent.value, key)) {
      diagnostics.push(correctionsConfigDiagnostic('duplicate-key', ownPath.join('.')));
      continue;
    }
    if (inside && !CORRECTIONS_CONFIG_CLOSED_KEYS.has(key)) {
      diagnostics.push(correctionsConfigDiagnostic('unknown-key', key));
      continue;
    }
    if (rawValue.length === 0) {
      parent.value[key] = Object.create(null);
      stack.push({ indent, value: parent.value[key], path: ownPath });
      continue;
    }
    const parsed = scalar(rawValue);
    if (guarded && parsed.unterminated) {
      diagnostics.push(correctionsConfigDiagnostic('unterminated-quote', key));
      continue;
    }
    if (inside && key === 'enabled' && parsed.quoted && /^(true|false)$/i.test(parsed.text)) {
      diagnostics.push(correctionsConfigDiagnostic('quoted-boolean', rawValue));
      parent.value[key] = parsed.text;
      continue;
    }
    parent.value[key] = parsed.quoted ? parsed.text : (parsed.bool !== undefined ? parsed.bool : (parsed.number !== undefined ? parsed.number : parsed.text));
  }
  return { value: root, diagnostics };
}

function normalizeConfigPath(value) {
  if (typeof value !== 'string' || !value) return null;
  const normalized = value.replaceAll('\\', '/').replace(/^['"]|['"]$/g, '').replace(/\/+$/, '');
  return normalized || null;
}

export async function readDecisionCorrectionsConfig(rootDir, options = {}) {
  const diagnostics = [];
  const config = {
    enabled: null, // null = key absent -> default false; never auto-enabled
    enabledMalformed: false,
    stateRoot: STATE_ROOT,
    stateRootRaw: undefined,
    diagnostics,
  };
  let bytes = null;
  try {
    bytes = options.readConfigBytes
      ? await options.readConfigBytes()
      : await readFile(path.join(rootDir, '.ai-factory', 'config.yaml')).catch((error) => {
        if (error?.code === 'ENOENT') return null;
        throw error;
      });
  } catch (error) {
    // A config that exists but cannot be read must not stand in for the
    // project's configured state root: writes would silently land under the
    // defaulted root where a readable config would have refused them.
    diagnostics.push(correctionsConfigDiagnostic('config-unreadable', String(error?.message ?? error).slice(0, 200)));
    config.enabledMalformed = true;
    return config;
  }
  if (bytes === null) return config;
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    diagnostics.push(correctionsConfigDiagnostic('config-malformed', 'utf8-fatal'));
    config.enabledMalformed = true;
    return config;
  }
  const parsed = parseDecisionCorrectionsConfigSubset(text);
  diagnostics.push(...parsed.diagnostics);
  const hub = parsed.value?.aifhub;
  const paths = parsed.value?.paths;
  let structuralDamage = false;
  for (const [name, section] of [['aifhub', hub], ['paths', paths]]) {
    if (section !== undefined && section !== null && (typeof section !== 'object' || Array.isArray(section))) {
      diagnostics.push(correctionsConfigDiagnostic('scalarized-section', name));
      structuralDamage = true;
    }
  }
  const correctionsSection = hub && typeof hub === 'object' ? hub.decisionCorrections : undefined;
  if (correctionsSection !== undefined && (correctionsSection === null || typeof correctionsSection !== 'object' || Array.isArray(correctionsSection))) {
    diagnostics.push(correctionsConfigDiagnostic('scalarized-section', 'aifhub.decisionCorrections'));
    config.enabledMalformed = true;
  }
  const enabled = correctionsSection && typeof correctionsSection === 'object' ? correctionsSection.enabled : undefined;
  if (enabled !== undefined) {
    if (typeof enabled === 'boolean') config.enabled = enabled;
    else {
      config.enabledMalformed = true;
      diagnostics.push(correctionsConfigDiagnostic('not-a-boolean', JSON.stringify(enabled)));
    }
  }
  if (parsed.diagnostics.length > 0 || structuralDamage) config.enabledMalformed = true;
  if (paths && typeof paths === 'object' && !Array.isArray(paths)) {
    const rawState = paths.state;
    if (rawState !== undefined) {
      config.stateRootRaw = rawState;
      const stateRoot = normalizeConfigPath(rawState);
      if (stateRoot !== null) config.stateRoot = stateRoot;
    }
  }
  return config;
}

// ---------------------------------------------------------------------------
// Typed privacy predicate: superset of the promote-metadata leak detector,
// extended with URL-scheme shapes. Applied to the serialized case, the
// preview/diagnostics output, and the CLI envelope before any persistence or
// print — a detected leak is a blocked refusal, never a warning.
// ---------------------------------------------------------------------------

export function hasCorrectionsLeak(value) {
  let text;
  try { text = JSON.stringify(value) ?? ''; } catch { return true; }
  // Patterns operate on the JSON-serialized form: a real backslash appears as
  // a doubled escape, so an escaped newline (`...x:\n`) must NOT match the
  // drive-letter rule — only a genuine drive/UNC/scheme shape does.
  return /[A-Za-z]:\\\\/.test(text)
    || /[A-Za-z]:\//.test(text)
    || /\\\\\\\\/.test(text)
    || /(?:^|[^A-Za-z0-9])(?:\/Users|\/home|\/tmp|\/var\/tmp|\/private\/tmp|\/mnt|\/Volumes)\//.test(text)
    || /\b(?:sk|ghp|github_pat)_[A-Za-z0-9_=-]{12,}/i.test(text)
    || /BEGIN (?:RSA|OPENSSH|EC|DSA)? ?PRIVATE KEY/i.test(text)
    || /\braw_transcript\b/i.test(text)
    || /\b(?:https?|file|ftp|ssh):\/\//i.test(text);
}

// ---------------------------------------------------------------------------
// Identity: allowlist projection of the identity source observation followed
// by the strict typed-assessment canonical form. Volatile keys that survive
// projection only through nested allowlisted objects throw
// (`identity-source-incompatible`) instead of silently changing the digest.
// ---------------------------------------------------------------------------

export function projectIdentityObservation(value) {
  requireValue(value && typeof value === 'object' && !Array.isArray(value), 'invalid-identity-source');
  const projected = {};
  for (const key of IDENTITY_OBSERVATION_FIELDS) {
    if (Object.hasOwn(value, key)) projected[key] = value[key];
  }
  requireValue(Object.keys(projected).length > 0, 'identity-source-empty');
  requireValue(canonical(projected).length <= MAX_IDENTITY_SOURCE_CHARS, 'identity-source-oversize');
  return projected;
}

function leakFreeText(value, code, max) {
  requireValue(typeof value === 'string' && value.trim().length > 0, code);
  requireValue(!hasCorrectionsLeak(value), 'privacy-leak', true);
  // NUL, oversize, and empty bodies are refused with the field's own typed
  // code, not the generic bounded-text code, so hostile bodies are
  // attributable in diagnostics.
  requireValue(!value.includes('\0') && value.length <= max, code);
  return boundedText(value, max);
}

// Normalizes caller identity input into the canonical identity material.
// `input_paths` resolve to `input_revisions` digests through the store
// (provenance only): a path that cannot be read refuses the whole request.
// The partition is part of the identity: relabeling development -> held_out
// is a new logical case by construction (held-out immunity cannot be sidestepped
// by relabeling an existing case).
async function normalizeIdentityInput(scope, partition, identityInput, store) {
  fields(identityInput, ['source_observation', 'subject_revision', 'input_paths', 'question', 'rubric'], []);
  requireValue(PARTITIONS.includes(partition), 'invalid-partition');
  const sourceObservation = projectIdentityObservation(identityInput.source_observation);
  const subjectRevision = leakFreeText(identityInput.subject_revision, 'invalid-subject-revision', 200);
  requireValue(Array.isArray(identityInput.input_paths) && identityInput.input_paths.length > 0
    && identityInput.input_paths.length <= MAX_INPUT_REVISIONS, 'invalid-input-revisions');
  for (const inputPath of identityInput.input_paths) {
    const normalized = portablePath(inputPath);
    // Provenance inputs live in the presented project surface, never inside
    // the corrections store itself (a store file citing itself as evidence
    // would make the digest self-referential).
    requireValue(!withinNamespace(normalized), 'self-referential-input', true);
  }
  const inputRevisions = await store.references(identityInput.input_paths);
  requireValue(Object.keys(inputRevisions).length > 0, 'invalid-input-revisions');
  requireValue(!hasCorrectionsLeak({ question: identityInput.question, rubric: identityInput.rubric }), 'privacy-leak', true);
  fields(identityInput.question, ['id', 'version'], []);
  fields(identityInput.rubric, ['id', 'version'], []);
  const question = {
    id: leakFreeText(identityInput.question.id, 'invalid-question', 200),
    version: leakFreeText(identityInput.question.version, 'invalid-question', 100),
  };
  const rubric = {
    id: leakFreeText(identityInput.rubric.id, 'invalid-rubric', 200),
    version: leakFreeText(identityInput.rubric.version, 'invalid-rubric', 100),
  };
  return {
    scope,
    partition,
    source_observation: sourceObservation,
    subject_revision: subjectRevision,
    input_revisions: inputRevisions,
    question,
    rubric,
  };
}

function assertStoredIdentityMaterial(material) {
  requireValue(material && typeof material === 'object' && !Array.isArray(material), 'invalid-identity');
  fields(material, ['scope', 'partition', 'source_observation', 'subject_revision', 'input_revisions', 'question', 'rubric'], []);
  requireValue(PARTITIONS.includes(material.partition), 'invalid-partition');
  // Read-time bounds mirror the write-time input rules: the schema leaves
  // source_observation and input_revisions unconstrained, so the invariants
  // carry the cardinality, size, and allowlist guarantees instead.
  requireValue(material.source_observation && typeof material.source_observation === 'object' && !Array.isArray(material.source_observation), 'invalid-identity-source');
  const reprojection = projectIdentityObservation(material.source_observation);
  requireValue(canonical(reprojection) === canonical(material.source_observation), 'identity-source-not-allowlisted');
  requireValue(canonical(reprojection).length <= MAX_IDENTITY_SOURCE_CHARS, 'identity-source-oversize');
  const revisions = material.input_revisions;
  requireValue(revisions && typeof revisions === 'object' && !Array.isArray(revisions), 'invalid-input-revisions');
  const revisionKeys = Object.keys(revisions);
  requireValue(revisionKeys.length > 0 && revisionKeys.length <= MAX_INPUT_REVISIONS, 'invalid-input-revisions');
  requireValue(revisionKeys.every((key) => /^[a-f0-9]{64}$/.test(revisions[key])), 'invalid-input-revisions');
}

export function computeLogicalIdentity(identityMaterial) {
  try {
    return digest(assessmentCanonical({
      scope: identityMaterial.scope,
      partition: identityMaterial.partition,
      source_observation: identityMaterial.source_observation,
      subject_revision: identityMaterial.subject_revision,
      input_revisions: identityMaterial.input_revisions,
      question: identityMaterial.question,
      rubric: identityMaterial.rubric,
    }));
  } catch {
    // Nested volatile keys (e.g. generated_at inside an allowlisted object)
    // are incompatible with the strict binding canonical form: refuse loudly
    // instead of silently producing an identity that cannot round-trip.
    throw new WorkflowError('identity-source-incompatible', false);
  }
}

// ---------------------------------------------------------------------------
// Case payload assembly (preview/save share one deterministic builder)
// ---------------------------------------------------------------------------

function normalizeFixtureFile(entry) {
  fields(entry, ['path', 'media_type', 'bytes'], ['role']);
  const fixturePath = portablePath(String(entry.path));
  // The schema caps fixture paths at 300; refusing here keeps the typed field
  // code instead of a generic case-schema-invalid refusal at write time.
  requireValue(fixturePath.length <= 300, 'unsafe-fixture-path');
  requireValue(!hasCorrectionsLeak({ path: fixturePath, media_type: entry.media_type }), 'privacy-leak', true);
  requireValue(typeof entry.media_type === 'string' && entry.media_type.length > 0 && entry.media_type.length <= 100, 'invalid-fixture-media-type');
  requireValue(typeof entry.bytes === 'string', 'invalid-fixture-bytes');
  requireValue(Buffer.byteLength(entry.bytes, 'utf8') <= MAX_FIXTURE_FILE_BYTES, 'fixture-too-large');
  // Replay input roles: 'input' files are presented to the replayed consumer
  // with its own input flag; 'support' files are materialized into the replay
  // root only (sources, custody manifests, replay configuration). The default
  // follows the consumer grammars: engine-owned support paths under
  // `.ai-factory/` default to support, everything else defaults to input.
  // The role is serialized ONLY when the caller provided it explicitly: the
  // path-derived default is recomputable at read time, so omitting it keeps
  // the stored bytes (and therefore the digest and the idempotent re-save
  // comparison) stable across engine versions that change the default rule.
  const role = entry.role === undefined
    ? (fixturePath.startsWith('.ai-factory/') ? 'support' : 'input')
    : entry.role;
  requireValue(role === 'input' || role === 'support', 'invalid-fixture-role');
  const normalized = { path: fixturePath, media_type: entry.media_type, sha256: digest(Buffer.from(entry.bytes, 'utf8')), bytes: entry.bytes };
  if (entry.role !== undefined) normalized.role = role;
  return normalized;
}

function deriveRole(fixtureFile) {
  return fixtureFile.role ?? (fixtureFile.path.startsWith('.ai-factory/') ? 'support' : 'input');
}

function normalizeReplayArgs(args) {
  requireValue(Array.isArray(args) && args.length <= MAX_REPLAY_ARGS, 'invalid-replay-args');
  return args.map((arg) => {
    requireValue(typeof arg === 'string' && arg.length > 0 && arg.length <= 200, 'unsafe-replay-arg');
    // Args are closed flag tokens, never paths: fixture paths are appended by
    // the runner itself, and path/command syntax in caller args is refused.
    requireValue(!/[\0\\/:<>"|?*\x00-\x1f]/.test(arg), 'unsafe-replay-arg');
    requireValue(!arg.startsWith('-') || /^--[a-z][a-z0-9._-]*$/i.test(arg) || /^--[a-z][a-z0-9._-]*=[^\s]+$/i.test(arg), 'unsafe-replay-arg');
    // The replay must never write: refuse --write in any case or value form.
    requireValue(!/^--write(=.*)?$/i.test(arg), 'replay-write-forbidden', true);
    requireValue(arg.toLowerCase() !== '--json', 'unsafe-replay-arg');
    return arg;
  });
}

function buildPayload(scope, input, identityMaterial, fixtureVersion, expectedLabelConfirmed = false) {
  const casePayload = {
    case_id: identifier(input.case_id),
    scope,
    partition: identityMaterial.partition,
    ambiguity: input.ambiguity,
    logical_identity: computeLogicalIdentity(identityMaterial),
    identity: identityMaterial,
    fixture: null,
    original_assessment: null,
    expected_label: leakFreeText(input.expected_label, 'invalid-expected-label', 2000),
    expected_label_confirmed: expectedLabelConfirmed === true,
    rationale: input.rationale === undefined || input.rationale === null ? null : leakFreeText(input.rationale, 'invalid-rationale', 2000),
    feedback: input.feedback === undefined || input.feedback === null ? null : leakFreeText(input.feedback, 'invalid-feedback', 2000),
    replay: { args: normalizeReplayArgs(input.replay?.args ?? []) },
    evolution: null,
  };
  requireValue(PARTITIONS.includes(casePayload.partition) && AMBIGUITY_STATES.includes(casePayload.ambiguity), 'invalid-partition-or-ambiguity');
  fields(input.fixture, ['kind', 'files'], []);
  requireValue(FIXTURE_KINDS.includes(input.fixture.kind), 'invalid-fixture-kind');
  requireValue(Array.isArray(input.fixture.files) && input.fixture.files.length > 0 && input.fixture.files.length <= MAX_FIXTURE_FILES, 'invalid-fixture-files');
  const files = [];
  let totalBytes = 0;
  for (const entry of input.fixture.files) {
    const normalized = normalizeFixtureFile(entry);
    // A repeated fixture path would let the replay's second write silently
    // overwrite the first: the confirmed bundle must map paths one-to-one
    // onto the evidence it stores.
    requireValue(!files.some((file) => file.path === normalized.path), 'duplicate-fixture-path', true);
    totalBytes += Buffer.byteLength(normalized.bytes, 'utf8');
    requireValue(totalBytes <= MAX_FIXTURE_TOTAL_BYTES, 'fixture-too-large');
    files.push(normalized);
  }
  casePayload.fixture = { version: fixtureVersion, kind: input.fixture.kind, files };
  fields(input.original_assessment, ['consumer', 'verdict', 'summary'], []);
  requireValue(Object.hasOwn(REPLAY_ENGINES, input.original_assessment.consumer), 'unsupported-consumer');
  // Save-time consumer grammar checks: input roles must be able to produce a
  // well-formed replay argv for this consumer, otherwise the bundle would
  // only degrade to a dishonest not_run at replay time.
  const inputFiles = files.filter((file) => deriveRole(file) === 'input');
  if (input.original_assessment.consumer === 'claim_evidence_check') {
    requireValue(inputFiles.length === 1, 'invalid-fixture-input-count', true);
  } else if (input.original_assessment.consumer === 'requirements_semantic_lint') {
    requireValue(inputFiles.length >= 1, 'invalid-fixture-input-count', true);
  } else if (input.original_assessment.consumer === 'trace_link_suggestions') {
    // Trace-link presented test inputs must match the frozen TEST_PATH_FORM;
    // anything else is refused here instead of degrading to
    // invalid-test-input at replay time (form mirrored from
    // scripts/trace-link-suggestions.mjs:107).
    requireValue(inputFiles.length >= 1, 'invalid-fixture-input-count', true);
    const TEST_PATH_FORM = /(^|\/)(test|tests|__tests__)\/|[._-](test|spec)\.[A-Za-z0-9]+$/i;
    requireValue(inputFiles.every((file) => TEST_PATH_FORM.test(file.path)), 'invalid-test-input-role', true);
  }
  casePayload.original_assessment = {
    consumer: input.original_assessment.consumer,
    verdict: leakFreeText(input.original_assessment.verdict, 'invalid-original-verdict', 2000),
    summary: input.original_assessment.summary === undefined || input.original_assessment.summary === null
      ? null : leakFreeText(input.original_assessment.summary, 'invalid-original-summary', 2000),
  };
  if (input.evolution !== undefined && input.evolution !== null) {
    fields(input.evolution, ['transaction_id', 'proposal_digest'], []);
    requireValue(!hasCorrectionsLeak(input.evolution), 'privacy-leak', true);
    requireValue(/^[a-f0-9]{64}$/.test(input.evolution.proposal_digest), 'invalid-proposal-digest');
    casePayload.evolution = {
      transaction_id: identifier(input.evolution.transaction_id),
      proposal_digest: input.evolution.proposal_digest,
    };
  }
  return casePayload;
}

function payloadDigest(payload) {
  return digest(canonical(payload));
}

function withinNamespace(relative) {
  return relative === NAMESPACE_ROOT || relative.startsWith(`${NAMESPACE_ROOT}/`);
}

function casePaths(scope, caseId) {
  const scopeDir = `${NAMESPACE_ROOT}/${scope}`;
  return { scopeDir, caseFile: `${scopeDir}/cases/${caseId}.json`, lockPath: `${scopeDir}/write.lock` };
}

function validateRecordSchema(record) {
  return validateJsonAgainstSchema(record, caseSchema());
}

export function assertPayloadInvariants(record) {
  const payload = record.payload;
  requireValue(payload.identity.scope === payload.scope, 'identity-scope-mismatch');
  // The displayed partition drives the held-out guard and replay bucketing,
  // so a schema-valid record must not diverge from the identity partition.
  requireValue(payload.identity.partition === payload.partition, 'identity-partition-mismatch');
  // Fixture digests come first: corrupted evidence must surface as
  // `fixture-digest-mismatch` (classified stale by the replay policy), not
  // be masked by the aggregate payload-digest check.
  for (const file of payload.fixture.files) {
    requireValue(digest(Buffer.from(file.bytes, 'utf8')) === file.sha256, 'fixture-digest-mismatch');
  }
  requireValue(payloadDigest(payload) === record.payload_digest, 'payload-digest-mismatch');
  assertStoredIdentityMaterial(payload.identity);
  requireValue(computeLogicalIdentity(payload.identity) === payload.logical_identity, 'logical-identity-mismatch');
  if (record.status === 'confirmed') {
    requireValue(payload.expected_label_confirmed === true, 'confirmation-desync');
  }
  requireValue(record.schema === DECISION_CORRECTIONS_SCHEMA && record.diagnostic_only === true
    && Array.isArray(record.authorizes) && record.authorizes.length === 0, 'invalid-envelope');
}

function validateRecordOrThrow(record) {
  const errors = validateRecordSchema(record);
  requireValue(errors.length === 0, 'case-schema-invalid', true);
  assertPayloadInvariants(record);
}

// ---------------------------------------------------------------------------
// Writer guards (mirror of writeClaimEvidenceObservation, narrowed to the
// constant corrections namespace; every path the writer may create — case
// file, run record, namespace .gitignore, write.lock — is git-guarded BEFORE
// the first write, including the lock the store creates on acquisition).
// ---------------------------------------------------------------------------

async function ensureWritableSurface(root, relative) {
  const parts = relative.split('/');
  for (let index = 1; index < parts.length; index += 1) {
    const ancestor = path.join(root, ...parts.slice(0, index));
    let info;
    try { info = await lstat(ancestor); } catch { continue; }
    if (!info.isDirectory()) return { ok: false, code: 'file-shadow', detail: parts.slice(0, index).join('/') };
  }
  return null;
}

async function guardOwnedSurfaces(root, relatives, options = {}) {
  const gitGuard = options.gitGuard ?? verifyObservationIgnored;
  for (const relative of relatives) {
    portablePath(relative);
    const shadow = await ensureWritableSurface(root, relative);
    if (shadow) return shadow;
    const verdict = await gitGuard(root, relative, options);
    if (!verdict.ok) return { ok: false, code: verdict.code, detail: verdict.detail ?? null };
  }
  return null;
}

async function prepareNamespace(root) {
  try {
    const action = await ensureRuntimeGitignore(root, NAMESPACE_ROOT);
    return { ok: true, action: action.action };
  } catch (error) {
    return { ok: false, code: 'runtime-gitignore-failed', detail: String(error?.message ?? error).slice(0, 200) };
  }
}

// Pre-mutation git guard for the atomic write's transient sibling: the store
// generates `<dest>.<uuid>.tmp` internally (workflow-state-store.mjs), so the
// exact name cannot be pre-guarded. `git check-ignore` evaluates ignore rules
// for non-existent paths, so probing a representative sibling of the same
// shape proves the whole temp pattern `<dest>.*.tmp` is effectively ignored —
// including the case where a PRE-EXISTING namespace .gitignore with narrow
// rules was preserved by ensureRuntimeGitignore and leaves `*.tmp` visible.
async function assertTempAreaIgnored(root, destinationFile, options = {}) {
  const probe = `${destinationFile}.write-probe.tmp`;
  const verdict = await (options.gitGuard ?? verifyObservationIgnored)(root, probe, options);
  if (!verdict.ok || verdict.tracked) {
    return { ok: false, code: verdict.ok ? 'observation-path-tracked' : verdict.code, detail: verdict.detail ?? probe };
  }
  return null;
}

async function assertGuard(guard) {
  if (guard === null) return;
  // Scan the guard payload before refusing on its code: a leaking guard
  // detail is reduced to the typed privacy code, nothing engine-derived with
  // hostile content is ever thrown through.
  requireValue(!hasCorrectionsLeak(guard), 'privacy-leak', true);
  requireValue(false, guard.code ?? 'writer-guard-failed', true);
}

// Windows case-only path/id collisions must fail closed: a directory already
// holding a name that differs only by case cannot host a second entry. The
// same rule applies to the scope directory itself: on a case-insensitive
// filesystem `alpha` and `Alpha` would resolve to one store directory while
// carrying two different logical identities (scope is an identity input).
async function assertNoCaseCollision(store, scopeDir, targetName) {
  let entries = [];
  try { entries = await readdir(path.join(store.root, ...`${scopeDir}/cases`.split('/'))); } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  const lower = targetName.toLowerCase();
  const conflict = entries.find((name) => name.toLowerCase() === lower && name !== targetName);
  requireValue(!conflict, 'case-collision', true);
}

async function assertNoScopeCollision(store, scope) {
  let entries = [];
  try { entries = await readdir(path.join(store.root, ...NAMESPACE_ROOT.split('/'))); } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  const lower = scope.toLowerCase();
  const conflict = entries.find((name) => name.toLowerCase() === lower && name !== scope);
  requireValue(!conflict, 'scope-collision', true);
}

async function readCaseRecord(store, scopeDir, filename, { strict } = { strict: true }) {
  const record = await store.load(`${scopeDir}/cases/${filename}`);
  if (record === null || record.schema !== DECISION_CORRECTIONS_SCHEMA
    || !record.payload || typeof record.payload !== 'object') {
    // Non-strict readers (list/run dedup scans) skip a record whose shape is
    // broken beyond its schema token instead of crashing on its payload.
    if (strict) throw new WorkflowError('case-leaf-conflict', true);
    return null;
  }
  return record;
}

// ---------------------------------------------------------------------------
// Shared enablement + state-root gates
// ---------------------------------------------------------------------------

function checkEnabled(config, cliEnabled) {
  requireValue(config.enabledMalformed !== true, 'decision-corrections-disabled', true);
  const enabled = cliEnabled === undefined || cliEnabled === null ? config.enabled : cliEnabled;
  requireValue(enabled === true, 'decision-corrections-disabled', true);
}

function assertStateRoot(config) {
  const rawState = config.stateRootRaw;
  if (rawState === undefined) return;
  const normalized = normalizeConfigPath(rawState);
  requireValue(normalized !== null && normalized === STATE_ROOT, 'state-root-mismatch', true);
}

async function commandGate(input, required, optional, options) {
  fields(input, required, optional);
  const rootDir = await realpath(options.rootDir ?? process.cwd());
  const config = options.config ?? await readDecisionCorrectionsConfig(rootDir, options);
  checkEnabled(config, options.enabled);
  assertStateRoot(config);
  return { rootDir, config };
}

// ---------------------------------------------------------------------------
// Public case operations
// ---------------------------------------------------------------------------

// Deduplicates and versions the payload deterministically against the current
// store state: same identity + same material -> the stored payload itself
// (idempotent); same identity + changed material -> the next fixture version
// (redaction flow); a different identity under the same case_id -> collision.
async function resolveEffectivePayload(store, scope, caseId, input, identityMaterial) {
  const { caseFile } = casePaths(scope, caseId);
  const existing = await store.load(caseFile);
  if (existing !== null) {
    // Leaf ownership is full-strength on the overwrite path: only a fully
    // schema-valid, invariant-clean case of the same case_id may be replaced.
    requireValue(existing.schema === DECISION_CORRECTIONS_SCHEMA && existing.payload?.case_id === caseId, 'case-leaf-conflict', true);
    validateRecordOrThrow(existing);
    requireValue(existing.payload.logical_identity === computeLogicalIdentity(identityMaterial), 'case-identity-collision', true);
    // Idempotency compares the rebuilt material against the stored payload
    // adopting the stored lifecycle flag: a re-save of the identical material
    // after confirmation must stay idempotent, not silently demote the case.
    const sameMaterial = payloadDigest(buildPayload(scope, input, identityMaterial, existing.payload.fixture.version, existing.payload.expected_label_confirmed));
    if (sameMaterial === existing.payload_digest) {
      return { payload: existing.payload, digestValue: existing.payload_digest, idempotent: true, existing };
    }
    // Held-out immunity covers the revision flow: a fixture revision of a
    // held-out case would author a new held-out outcome, which is exactly the
    // tuning the partition immunity forbids. An idempotent re-save of the
    // identical material stays allowed (it authors nothing), and first-time
    // saves keep every partition available (the partition is chosen at save
    // time).
    requireValue(existing.payload.partition !== 'held_out', 'held-out-tuning', true);
    const version = existing.payload.fixture.version + 1;
    const payload = buildPayload(scope, input, identityMaterial, version);
    return { payload, digestValue: payloadDigest(payload), idempotent: false, existing };
  }
  const payload = buildPayload(scope, input, identityMaterial, 1);
  return { payload, digestValue: payloadDigest(payload), idempotent: false, existing: null };
}

async function findIdentityOwner(store, scope, logicalIdentity, excludeCaseId) {
  const { scopeDir } = casePaths(scope, 'x');
  let entries = [];
  try { entries = await readdir(path.join(store.root, ...`${scopeDir}/cases`.split('/'))); } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  const caseFiles = entries.filter((name) => /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}\.json$/.test(name)).sort();
  for (const name of caseFiles) {
    const record = await readCaseRecord(store, scopeDir, name, { strict: false });
    if (record === null) continue;
    // A checksum-valid but structurally broken record cannot prove identity
    // ownership: validate-and-skip keeps the dedup scan TypeError-free.
    try {
      validateRecordOrThrow(record);
    } catch {
      continue;
    }
    if (record.payload.logical_identity === logicalIdentity && record.payload.case_id !== excludeCaseId) return record;
  }
  return null;
}

export async function previewDecisionCorrection(input, options = {}) {
  const { rootDir } = await commandGate(input, ['case_id', 'scope', 'partition', 'ambiguity', 'identity', 'fixture', 'original_assessment', 'expected_label'], ['rationale', 'feedback', 'evolution', 'replay'], options);
  const store = await storeFor(rootDir);
  const scope = identifier(input.scope);
  const caseId = identifier(input.case_id);
  const { scopeDir } = casePaths(scope, caseId);
  await assertNoScopeCollision(store, scope);
  await assertNoCaseCollision(store, scopeDir, `${caseId}.json`);
  const identityMaterial = await normalizeIdentityInput(scope, input.partition, input.identity, store);
  const resolved = await resolveEffectivePayload(store, scope, caseId, input, identityMaterial);
  if (resolved.idempotent) {
    const envelope = { ok: true, action: 'preview', idempotent: true, payload: resolved.existing.payload, payload_digest: resolved.existing.payload_digest };
    requireValue(!hasCorrectionsLeak(envelope), 'privacy-leak', true);
    return envelope;
  }
  const envelope = { ok: true, action: 'preview', payload: resolved.payload, payload_digest: resolved.digestValue };
  requireValue(!hasCorrectionsLeak(envelope), 'privacy-leak', true);
  return envelope;
}

// Evolution links are resolved in-process (show semantics): the check never
// inspects evidence freshness or the current target — a historical receipt is
// reported as such and never presented as an active application. A link to a
// missing or invalid transaction is a typed refusal on every surface that
// resolves it (save and show); only an existing transaction's rolled_back
// state degrades to a report with the receipt kept visible.
async function verifyEvolutionLink(casePayload, rootDir) {
  if (casePayload.evolution === null) return { linked: false, active: false };
  let view = null;
  let code = null;
  try {
    view = await evolutionCommand('show', { transaction_id: casePayload.evolution.transaction_id }, { rootDir });
  } catch (error) {
    if (!(error instanceof WorkflowError)) throw error;
    code = error.code;
  }
  if (view === null) {
    requireValue(false, code ?? 'missing-or-invalid-transaction', true);
  }
  const digestMatched = view.proposal_digest === casePayload.evolution.proposal_digest;
  requireValue(digestMatched, 'proposal-mismatch', true);
  return {
    linked: true,
    active: view.status === 'applied',
    transaction_status: view.status,
    digest_matched: true,
  };
}

async function loadCaseRecord(store, rootDir, scope, caseId) {
  const { caseFile } = casePaths(scope, caseId);
  const record = await store.load(caseFile);
  requireValue(record !== null && record.schema === DECISION_CORRECTIONS_SCHEMA && record.payload?.case_id === caseId, 'case-not-found', true);
  validateRecordOrThrow(record);
  // The scope is part of the store path and of the identity: on a
  // case-insensitive filesystem a case-only alias of the scope directory
  // could otherwise surface a neighboring scope's record here.
  requireValue(record.payload.scope === scope, 'case-not-found', true);
  return record;
}

export async function saveDecisionCorrection(input, options = {}) {
  const { rootDir } = await commandGate(input, ['case_id', 'scope', 'partition', 'ambiguity', 'identity', 'fixture', 'original_assessment', 'expected_label', 'payload_digest'], ['rationale', 'feedback', 'evolution', 'replay'], options);
  const store = await storeFor(rootDir);
  const scope = identifier(input.scope);
  const caseId = identifier(input.case_id);
  const { caseFile, scopeDir, lockPath } = casePaths(scope, caseId);
  // The destination must never be one of the presented provenance inputs:
  // saving over exactly the material the case cites would corrupt the record.
  const sourceCollision = (input.identity?.input_paths ?? []).find((inputPath) => {
    try { return portablePath(inputPath).toLowerCase() === caseFile.toLowerCase(); } catch { return false; }
  });
  requireValue(!sourceCollision, 'observation-source-collision', true);
  // Read-only validation pass BEFORE any filesystem materialization: on a
  // fresh project a refused save must not leave a namespace .gitignore or
  // store directories behind. The authoritative resolution repeats under the
  // lock (dedup is race-free there); this pass only front-runs the common
  // refusal branches.
  {
    await assertNoScopeCollision(store, scope);
    await assertNoCaseCollision(store, scopeDir, `${caseId}.json`);
    const identityMaterial = await normalizeIdentityInput(scope, input.partition, input.identity, store);
    const resolved = await resolveEffectivePayload(store, scope, caseId, input, identityMaterial);
    requireValue(input.payload_digest === resolved.digestValue, 'payload-mismatch', true);
    if (!resolved.idempotent && resolved.payload.evolution !== null) {
      const link = await verifyEvolutionLink(resolved.payload, rootDir);
      requireValue(link.active === true, link.error ?? 'transaction-not-applied', true);
    }
  }
  await assertGuard(await guardOwnedSurfaces(rootDir, [caseFile, `${NAMESPACE_ROOT}/.gitignore`, lockPath], options));
  let namespaceAction = 'preserve';
  try {
    const namespace = await prepareNamespace(rootDir);
    namespaceAction = namespace.ok ? namespace.action : 'preserve';
    await assertGuard(namespace.ok === true ? null : namespace);
    // Pre-mutation git guard for the transient write sibling: a preserved
    // pre-existing namespace .gitignore may carry narrow rules that leave
    // `<dest>.*.tmp` visible, which would put a tracked temp file into the
    // QA `actual_diff` channel the moment the atomic write runs.
    await assertGuard(await assertTempAreaIgnored(rootDir, caseFile, options));
    return await store.lock(lockPath, async () => {
      // Dedup-check and write are serialized by the scope write lock: the
      // idempotent/revision/collision matrix is race-free within this
      // helper's serialization model. Windows case-only collisions (case and
      // scope directory aliases) are refused deterministically before any
      // payload resolution. The atomic write's transient `<dest>.<uuid>.tmp`
      // shape was proven effectively ignored by the probe guard above.
      await assertNoScopeCollision(store, scope);
      await assertNoCaseCollision(store, scopeDir, `${caseId}.json`);
      const identityMaterial = await normalizeIdentityInput(scope, input.partition, input.identity, store);
      const resolved = await resolveEffectivePayload(store, scope, caseId, input, identityMaterial);
      // The digest echo is checked unconditionally — including the idempotent
      // branch: a repeated save of identical material with a stale or wrong
      // echo is a digest-bound contract violation, not a free pass.
      requireValue(input.payload_digest === resolved.digestValue, 'payload-mismatch', true);
      if (resolved.idempotent) {
        // Same identity + same payload -> no new record, confirmation untouched.
        return { ok: true, action: 'save', idempotent: true, case: resolved.existing };
      }
      const identityOwner = await findIdentityOwner(store, scope, resolved.payload.logical_identity, caseId);
      if (identityOwner !== null) throw new WorkflowError('revision-conflict', true);
      if (resolved.payload.evolution !== null) {
        const link = await verifyEvolutionLink(resolved.payload, rootDir);
        requireValue(link.active === true, link.error ?? 'transaction-not-applied', true);
      }
      const record = {
        schema: DECISION_CORRECTIONS_SCHEMA,
        diagnostic_only: true,
        authorizes: [],
        status: 'draft',
        status_reason: null,
        payload_digest: resolved.digestValue,
        payload: resolved.payload,
      };
      validateRecordOrThrow(record);
      requireValue(!hasCorrectionsLeak(record), 'privacy-leak', true);
      await store.save(caseFile, record);
      return { ok: true, action: 'save', idempotent: false, created: true, case: record };
    });
  } catch (error) {
    // Cleanup of artifacts THIS request created during materialization: empty
    // scope directories are removed deepest-first, and the namespace
    // .gitignore is removed only when OUR prepareNamespace call created it
    // (action 'create') AND it is the sole remaining namespace entry — so a
    // pre-existing or concurrently-created ignore file (with whatever rule
    // scope its owner chose) is never deleted out from under another writer.
    const { rmdir, readdir } = await import('node:fs/promises');
    for (const dir of [`${NAMESPACE_ROOT}/${scope}/cases`, `${NAMESPACE_ROOT}/${scope}`]) {
      await rmdir(path.join(rootDir, ...dir.split('/'))).catch(() => {});
    }
    const namespaceAbsolute = path.join(rootDir, ...NAMESPACE_ROOT.split('/'));
    let remaining = [];
    try { remaining = await readdir(namespaceAbsolute); } catch { remaining = []; }
    if (namespaceAction === 'create' && remaining.length === 1 && remaining[0] === '.gitignore') {
      const { rm: remove } = await import('node:fs/promises');
      await remove(path.join(namespaceAbsolute, '.gitignore'), { force: true }).catch(() => {});
      await rmdir(namespaceAbsolute).catch(() => {});
    }
    throw error;
  }
}

function lifecycleTransition(record, status, reason) {
  const next = {
    ...record,
    status,
    status_reason: reason === undefined || reason === null ? null : leakFreeText(reason, 'invalid-status-reason', 2000),
  };
  if (status === 'confirmed') next.payload = { ...record.payload, expected_label_confirmed: true };
  next.payload_digest = payloadDigest(next.payload);
  validateRecordOrThrow(next);
  requireValue(!hasCorrectionsLeak(next), 'privacy-leak', true);
  return next;
}

async function lifecycleCommand(action, input, options) {
  const required = action === 'confirm'
    ? ['case_id', 'scope', 'expected_label', 'payload_digest']
    : ['case_id', 'scope'];
  const optional = action === 'confirm' ? [] : ['reason'];
  const { rootDir } = await commandGate(input, required, optional, options);
  const store = await storeFor(rootDir);
  const scope = identifier(input.scope);
  const caseId = identifier(input.case_id);
  const { caseFile, lockPath } = casePaths(scope, caseId);
  // Read-only pre-pass before materialization: the common refusal branches
  // (missing case, held-out partition) fire before any namespace artifact is
  // created; the authoritative re-load repeats under the lock.
  {
    const existing = await store.load(caseFile).catch((error) => {
      if (error instanceof WorkflowError && error.code === 'invalid-state') throw new WorkflowError('case-leaf-conflict', true);
      throw error;
    });
    requireValue(existing !== null && existing.schema === DECISION_CORRECTIONS_SCHEMA
      && existing.payload?.case_id === caseId && existing.payload?.scope === scope, 'case-not-found', true);
    validateRecordOrThrow(existing);
    requireValue(existing.payload.partition !== 'held_out', 'held-out-tuning', true);
  }
  await assertGuard(await guardOwnedSurfaces(rootDir, [caseFile, `${NAMESPACE_ROOT}/.gitignore`, lockPath], options));
  const lifecycleNamespace = await prepareNamespace(rootDir);
  await assertGuard(lifecycleNamespace.ok === true ? null : lifecycleNamespace);
  await assertGuard(await assertTempAreaIgnored(rootDir, caseFile, options));
  return store.lock(lockPath, async () => {
    const record = await loadCaseRecord(store, rootDir, scope, caseId);
    // Held-out immunity is enforced before any mutation logic: report-only
    // partitions never accept outcome-affecting mutations (confirm would
    // author a held-out outcome; save-revision and lifecycle are the tuning
    // surfaces). Retention (delete) stays available.
    requireValue(record.payload.partition !== 'held_out', 'held-out-tuning', true);
    let next;
    if (action === 'confirm') {
      requireValue(input.payload_digest === record.payload_digest, 'payload-mismatch', true);
      requireValue(input.expected_label === record.payload.expected_label, 'label-mismatch', true);
      next = lifecycleTransition(record, 'confirmed');
    } else if (action === 'reject') {
      next = lifecycleTransition(record, 'rejected', input.reason);
    } else {
      next = lifecycleTransition(record, 'superseded', input.reason);
    }
    await store.save(caseFile, next);
    return { ok: true, action, case: next };
  });
}

export async function deleteDecisionCorrection(input, options = {}) {
  const { rootDir } = await commandGate(input, ['case_id', 'scope'], [], options);
  const store = await storeFor(rootDir);
  const scope = identifier(input.scope);
  const caseId = identifier(input.case_id);
  const { caseFile, scopeDir } = casePaths(scope, caseId);
  await assertGuard(await guardOwnedSurfaces(rootDir, [caseFile, `${NAMESPACE_ROOT}/.gitignore`, `${scopeDir}/write.lock`], options));
  const gitGuard = options.gitGuard ?? verifyObservationIgnored;
  // Pre-mutation guard of every surface this delete may touch: the case leaf
  // and any temp sibling it may own are verified BEFORE the first mutation —
  // a tracked or not-effectively-ignored sibling refuses the whole delete
  // (fail closed) instead of being silently skipped mid-mutation.
  let siblingNames = [];
  try { siblingNames = await readdir(path.join(store.root, ...`${scopeDir}/cases`.split('/'))); } catch { siblingNames = []; }
  siblingNames = siblingNames.filter((name) => name.startsWith(`${caseId}.json.`) && name.endsWith('.tmp'));
  for (const name of siblingNames) {
    const verdict = await gitGuard(rootDir, `${scopeDir}/cases/${name}`, options).catch(() => ({ ok: false, code: 'git-verify-failed' }));
    requireValue(verdict.ok === true && verdict.tracked !== true, verdict.code ?? 'observation-path-tracked', true);
  }
  // Removal is serialized with the other scope writers: deleting a case while
  // a save holds the lock would race the dedup matrix.
  return store.lock(`${scopeDir}/write.lock`, async () => {
    const { unlink } = await import('node:fs/promises');
    const absolute = path.join(store.root, ...caseFile.split('/'));
    let existed = false;
    // Deterministic case-only alias preflight (portable across
    // case-sensitive and case-insensitive filesystems): a sibling name that
    // differs only by case is a collision on every platform.
    await assertNoCaseCollision(store, scopeDir, `${caseId}.json`);
    // On a case-insensitive filesystem the requested path may resolve to a
    // neighboring case whose name differs only by case: the record under the
    // resolved leaf must prove it belongs to the requested case_id (and
    // scope) before anything is removed. An absent case honestly reports
    // `deleted: false`; a present leaf whose ownership cannot be proven
    // (corrupt envelope) refuses instead of silently keeping the file.
    let owned = false;
    const record = await store.load(caseFile).catch((error) => {
      if (error instanceof WorkflowError && error.code === 'invalid-state') throw new WorkflowError('case-leaf-conflict', true);
      throw error;
    });
    if (record !== null) {
      // A leaf that resolves to a different case (Windows case-only alias) is
      // a collision, not an absent case: refuse instead of silently reporting
      // `deleted: false`.
      requireValue(record.schema === DECISION_CORRECTIONS_SCHEMA
        && record.payload?.case_id === caseId && record.payload?.scope === scope, 'case-collision', true);
      owned = true;
    }
    if (owned) {
      // Deleting a tracked file would shift the QA `actual_diff` channel, so
      // the guard above already refused any tracked owned surface; removal
      // itself only touches ignored runtime state.
      await unlink(absolute);
      existed = true;
    }
    // Cleanup of owned transient surfaces, verified ignored before the first
    // mutation above. A repeated delete honestly reports `deleted: false`.
    for (const name of siblingNames) {
      await rm(path.join(store.root, ...`${scopeDir}/cases`.split('/'), name), { force: true });
      existed = true;
    }
    return { ok: true, action: 'delete', deleted: existed };
  });
}

export async function listDecisionCorrections(input, options = {}) {
  const { rootDir } = await commandGate(input, ['scope'], ['status_filter', 'partition_filter', 'limit'], options);
  const store = await storeFor(rootDir);
  const scope = identifier(input.scope);
  const { scopeDir } = casePaths(scope, 'x');
  // Request validation happens before the empty-scope fast path, so a
  // malformed limit/filter refusal is symmetric whether or not any case
  // exists yet.
  const limit = input.limit === undefined ? MAX_RUN_CASES : input.limit;
  requireValue(Number.isInteger(limit) && limit >= 1 && limit <= MAX_RUN_CASES, 'invalid-limit');
  if (input.status_filter !== undefined) requireValue(STATUSES.includes(input.status_filter), 'invalid-status-filter');
  if (input.partition_filter !== undefined) requireValue(PARTITIONS.includes(input.partition_filter), 'invalid-partition-filter');
  let entries = [];
  try { entries = await readdir(path.join(store.root, ...`${scopeDir}/cases`.split('/'))); } catch (error) {
    if (error?.code === 'ENOENT') return { ok: true, action: 'list', scope, cases: [] };
    throw error;
  }
  // Sidecars (write.lock, *.tmp, .gitignore) and foreign names never enter
  // the listing: only schema-shaped case files are projected.
  const caseFiles = entries.filter((name) => /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}\.json$/.test(name)).sort();
  const summaries = [];
  for (const name of caseFiles) {
    if (summaries.length >= limit) break;
    const record = await readCaseRecord(store, scopeDir, name, { strict: false }).catch((error) => {
      if (error instanceof WorkflowError) return null;
      throw error;
    });
    if (record === null) continue;
    // A checksum-valid record whose shape is broken must not crash the
    // listing with a TypeError on its payload projection: the same
    // validate-and-skip rule the replay path applies keeps the listing
    // bounded and honest.
    try {
      validateRecordOrThrow(record);
    } catch {
      continue;
    }
    // On a case-insensitive filesystem an alias scope directory would resolve
    // to a neighboring scope's cases: only records whose stored scope equals
    // the requested scope are listed.
    if (record.payload.scope !== scope) continue;
    if (input.status_filter !== undefined && record.status !== input.status_filter) continue;
    if (input.partition_filter !== undefined && record.payload.partition !== input.partition_filter) continue;
    summaries.push({
      case_id: record.payload.case_id,
      status: record.status,
      partition: record.payload.partition,
      ambiguity: record.payload.ambiguity,
      fixture_version: record.payload.fixture.version,
      fixture_sha256: record.payload.fixture.files[0].sha256,
      consumer: record.payload.original_assessment.consumer,
      evolution_linked: record.payload.evolution !== null,
      logical_identity: record.payload.logical_identity,
    });
  }
  const envelope = { ok: true, action: 'list', scope, cases: summaries };
  requireValue(!hasCorrectionsLeak(envelope), 'privacy-leak', true);
  return envelope;
}

export async function showDecisionCorrection(input, options = {}) {
  const { rootDir } = await commandGate(input, ['case_id', 'scope'], [], options);
  const store = await storeFor(rootDir);
  const scope = identifier(input.scope);
  const caseId = identifier(input.case_id);
  const record = await loadCaseRecord(store, rootDir, scope, caseId);
  const evolution = await verifyEvolutionLink(record.payload, rootDir);
  const envelope = { ok: true, action: 'show', case: record, evolution };
  requireValue(!hasCorrectionsLeak(envelope), 'privacy-leak', true);
  return envelope;
}

// ---------------------------------------------------------------------------
// Local structural replay (solution 2-A): exported advisory run commands on
// the stored fixture bundle inside an isolated temp root, never with --write,
// never against the real project tree.
// ---------------------------------------------------------------------------

export function extractOutcomeSignature(text) {
  const parsed = parseStrictJson(text);
  // Run status lives in different places per producer: the advisory
  // not_run/failure envelopes carry `state`, requirement-lint observations
  // carry top-level `run_status`, and claim-evidence / trace-link
  // observations carry `semantic.run_status`. All map onto the same honest
  // outcome; a producer whose status cannot be located is honestly unknown.
  const runStatus = typeof parsed?.run_status === 'string' ? parsed.run_status
    : typeof parsed?.state === 'string' ? parsed.state
      : typeof parsed?.semantic?.run_status === 'string' ? parsed.semantic.run_status : null;
  const parts = [];
  // Occurrence-preserving projection: repeated entries stay in the signature
  // (type|type for two same-type findings) so losing one of two identical
  // findings changes the signature instead of hiding behind dedup — the
  // label comparison would otherwise report holds on a changed assessment.
  const addPart = (label, values, { dedup = true } = {}) => {
    const clean = values.filter((value) => typeof value === 'string' && value.length > 0);
    const projected = dedup ? [...new Set(clean)].sort() : clean.sort();
    parts.push(`${label}=${projected.length > 0 ? projected.join('|') : 'none'}`);
  };
  addPart('run_status', runStatus === null ? [] : [runStatus]);
  addPart('findings', (Array.isArray(parsed?.findings) ? parsed.findings : [])
    .map((finding) => (finding && typeof finding.type === 'string' ? finding.type : null)), { dedup: false });
  // Consumer-specific outcome material: claim-evidence carries quote checks
  // and semantic verdicts, trace-link carries the structural outcome and the
  // emitted relation kinds. Sections are included only when the producer
  // defines them, so a signature stays deterministic per observation shape.
  // Occurrence-sensitive sections use dedup:false: losing one of two
  // identical entries must change the signature.
  if (parsed && typeof parsed === 'object' && Array.isArray(parsed.structural?.pairs)) {
    addPart('quote_checks', parsed.structural.pairs.map((pair) => (pair && typeof pair.quote_check === 'string' ? pair.quote_check : null)), { dedup: false });
  }
  if (parsed && typeof parsed === 'object' && Array.isArray(parsed.semantic?.assessments)) {
    addPart('verdicts', parsed.semantic.assessments.map((assessment) => (assessment && typeof assessment.verdict === 'string' ? assessment.verdict : null)), { dedup: false });
  }
  if (parsed && typeof parsed === 'object' && typeof parsed.structural?.outcome === 'string') {
    addPart('outcome', [parsed.structural.outcome]);
  }
  if (parsed && typeof parsed === 'object' && Array.isArray(parsed.structural?.edges)) {
    addPart('relations', parsed.structural.edges.map((edge) => (edge && typeof edge.relation === 'string' ? edge.relation : null)), { dedup: false });
  }
  addPart('diagnostics', (Array.isArray(parsed?.diagnostics) ? parsed.diagnostics : [])
    .map((entry) => (entry && typeof entry.code === 'string' ? entry.code : null)));
  // Advisory not_run/failure envelopes carry their refusal codes in `codes`
  // instead of `diagnostics`; the section is included ONLY when the envelope
  // defines it, so complete-observation signatures stay byte-stable across
  // engine versions that gain the field (a stored label compared against a
  // silently appended `codes=none` would flip holds into label_change).
  if (Array.isArray(parsed?.codes)) {
    addPart('codes', parsed.codes
      .filter((code) => typeof code === 'string' && code.length > 0));
  }
  return {
    run_status: runStatus,
    signature: parts.join('; '),
  };
}

function normalizeLabelText(value) {
  return String(value).trim().toLowerCase().replace(/\s+/g, ' ');
}

// Per-consumer input flag for presented fixture paths (each advisory engine
// owns its own argv grammar: requirement-lint takes repeatable `--file`,
// claim-evidence takes a single `--pairs` envelope (its sources are read
// relative to the replay root), trace-link takes repeatable `--test`).
const REPLAY_INPUT_FLAGS = Object.freeze({
  requirements_semantic_lint: '--file',
  claim_evidence_check: '--pairs',
  trace_link_suggestions: '--test',
});

function fixtureInputFiles(fixtureFiles) {
  return fixtureFiles.filter((file) => deriveRole(file) === 'input');
}

function synthesizeReplayArgs(consumer, replayArgs, fixtureFiles) {
  const inputFlag = REPLAY_INPUT_FLAGS[consumer];
  const synthesized = [...replayArgs];
  const inputFiles = fixtureInputFiles(fixtureFiles);
  if (consumer === 'claim_evidence_check') {
    // The single role-input file is the pairs envelope (count enforced at
    // save time); role-support files are the sources its refs read from the
    // replay root. Legacy or adversarial stores may hold a bundle with zero
    // input files — omitting --pairs lets the replayed producer refuse with
    // its own honest invalid-usage instead of a TypeError escaping here.
    if (inputFiles.length > 0) synthesized.push(inputFlag, inputFiles[0].path);
  } else {
    for (const file of inputFiles) synthesized.push(inputFlag, file.path);
  }
  synthesized.push('--json');
  return synthesized;
}

function freshPartitionCounts() {
  return Object.fromEntries(PARTITIONS.map((partition) => [partition, {
    cases: 0, holds: 0, false_regression: 0, label_change: 0, ambiguous: 0, not_run: 0, stale: 0, report_only: 0, invalid_record: 0,
  }]));
}

export async function runDecisionCorrectionReplay(input, options = {}) {
  const runInput = { ...input };
  if (options.write === true) runInput.write = true;
  const { rootDir } = await commandGate(runInput, ['scope'], ['case_ids', 'limit', 'write'], options);
  const store = await storeFor(rootDir);
  const scope = identifier(runInput.scope);
  const { scopeDir } = casePaths(scope, 'x');
  // Scope alias guard: the run must never replay a neighboring scope's cases
  // through a case-insensitive directory alias (scope is an identity input).
  await assertNoScopeCollision(store, scope);
  let entries = [];
  try { entries = await readdir(path.join(store.root, ...`${scopeDir}/cases`.split('/'))); } catch (error) {
    if (error?.code === 'ENOENT') entries = [];
    else throw error;
  }
  const wanted = runInput.case_ids === undefined ? null : runInput.case_ids;
  if (wanted !== null) {
    requireValue(Array.isArray(wanted) && wanted.length <= MAX_RUN_CASES && wanted.every((id) => typeof id === 'string'), 'invalid-case-ids');
  }
  const limit = runInput.limit === undefined ? MAX_RUN_CASES : runInput.limit;
  requireValue(Number.isInteger(limit) && limit >= 1 && limit <= MAX_RUN_CASES, 'invalid-limit');
  // An explicitly selected case must not silently fall out of the run because
  // of an alphabetical position past the limit: the wanted filter applies
  // before the limit slices.
  const caseFiles = entries
    .filter((name) => /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}\.json$/.test(name))
    .filter((name) => wanted === null || wanted.includes(name.replace(/\.json$/, '')))
    .sort()
    .slice(0, limit);
  const results = [];
  const counts = freshPartitionCounts();
  const engines = (options.replayEngines && typeof options.replayEngines === 'object')
    ? { ...REPLAY_ENGINES, ...options.replayEngines }
    : REPLAY_ENGINES;
  for (const name of caseFiles) {
    const fileNameIdentity = name.replace(/\.json$/, '');
    let record = null;
    try {
      record = await readCaseRecord(store, scopeDir, name, { strict: false });
    } catch (error) {
      if (!(error instanceof WorkflowError)) throw error;
      // A checksum-invalid (corrupt envelope) leaf is a read failure, not an
      // absent case: it stays visible with a diagnostic identity derived from
      // the filename instead of silently disappearing from the report.
      record = null;
      if (error.code !== 'invalid-state') throw error;
    }
    // Diagnostic identity is built only from schema-compatible values: an
    // untrusted case_id mirrors the filename when it fails the identifier
    // pattern, and an untrusted consumer mirrors the default engine — the
    // invalid_record entry must never break the run-record schema itself.
    const trustedCaseId = record !== null
      && typeof record.payload?.case_id === 'string'
      && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(record.payload.case_id)
      ? record.payload.case_id : fileNameIdentity;
    if (wanted !== null && !wanted.includes(trustedCaseId)) continue;
    const trustedConsumer = record !== null
      && typeof record.payload?.original_assessment?.consumer === 'string'
      && Object.hasOwn(REPLAY_ENGINES, record.payload.original_assessment.consumer)
      ? record.payload.original_assessment.consumer : 'requirements_semantic_lint';
    const base = {
      case_id: trustedCaseId,
      consumer: trustedConsumer,
      partition: PARTITIONS.includes(record?.payload?.partition) ? record.payload.partition : 'development',
      status: STATUSES.includes(record?.status) ? record.status : 'draft',
      ambiguity: AMBIGUITY_STATES.includes(record?.payload?.ambiguity) ? record.payload.ambiguity : 'clear',
      signature: null,
    };
    // Full schema/invariant validation on the replay path: the stored record
    // must be provably clean before its fixture bytes are materialized
    // anywhere or fed to an engine. A record that cannot prove its integrity
    // gets an explicit diagnostic outcome instead of silently disappearing
    // from the run report.
    let validationFailed = record === null;
    let fixtureDrifted = false;
    if (record !== null) {
      try {
        validateRecordOrThrow(record);
      } catch (error) {
        validationFailed = true;
        // The policy buckets a corrupted fixture under `stale` (the evidence
        // drifted from its recorded digest), while every other invariant
        // failure means the stored record itself is not trustworthy.
        if (error instanceof WorkflowError && error.code === 'fixture-digest-mismatch') fixtureDrifted = true;
      }
    }
    if (validationFailed) {
      if (fixtureDrifted) {
        const driftCounts = counts[base.partition];
        driftCounts.cases += 1;
        driftCounts.stale += 1;
        results.push({ ...base, outcome: 'stale', signature: 'fixture-digest-mismatch' });
      } else {
        results.push({ ...base, outcome: 'invalid_record' });
        const invalidCounts = counts[base.partition];
        invalidCounts.cases += 1;
        invalidCounts.invalid_record += 1;
      }
      continue;
    }
    const payload = record.payload;
    // A valid record stored under a different scope belongs to that scope's
    // own run (an aliased directory on a case-insensitive filesystem); it is
    // excluded here and reported by its owning scope, not as invalid.
    if (payload.scope !== scope) continue;
    const partitionCounts = counts[payload.partition];
    partitionCounts.cases += 1;
    const outcomeBase = {
      case_id: payload.case_id,
      consumer: payload.original_assessment.consumer,
      partition: payload.partition,
      status: record.status,
      ambiguity: payload.ambiguity,
      signature: null,
    };
    if (payload.partition === 'held_out') {
      // Held-out is strictly report-only for ANY status: the runner never
      // measures a held-out case — no engine call, no signature, no scored
      // outcome — so nothing about the held-out partition can feed tuning.
      partitionCounts.report_only += 1;
      results.push({ ...outcomeBase, outcome: 'report_only' });
      continue;
    }
    if (record.status !== 'confirmed' || payload.expected_label_confirmed !== true) {
      results.push({ ...outcomeBase, outcome: 'skipped_draft' });
      continue;
    }
    if (payload.ambiguity === 'ambiguous') {
      // Ambiguous cases stay outside the scored confirmed set; the runner
      // reports them separately instead of scoring them.
      partitionCounts.ambiguous += 1;
      results.push({ ...outcomeBase, outcome: 'ambiguous' });
      continue;
    }
    // Stale detection BEFORE any engine call: drifted input revisions or a
    // fixture whose bytes no longer match its digest must not be replayed.
    let drifted = null;
    try {
      const current = await store.references(Object.keys(payload.identity.input_revisions));
      if (canonical(current) !== canonical(payload.identity.input_revisions)) drifted = 'input-revisions-drift';
    } catch {
      drifted = 'input-revisions-unreadable';
    }
    for (const file of payload.fixture.files) {
      if (digest(Buffer.from(file.bytes, 'utf8')) !== file.sha256) drifted = 'fixture-digest-mismatch';
    }
    if (drifted !== null) {
      partitionCounts.stale += 1;
      results.push({ ...outcomeBase, outcome: 'stale', signature: drifted });
      continue;
    }
    const engine = engines[payload.original_assessment.consumer];
    if (!engine) {
      results.push({ ...outcomeBase, outcome: 'unsupported_consumer' });
      continue;
    }
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'aif-dc-replay-'));
    let replayOutcome = null;
    let replaySignature = null;
    let replayArgs = null;
    let materializationFailed = null;
    try {
      try {
        for (const file of payload.fixture.files) {
          // The stored record re-proves its own containment here: every fixture
          // path must re-pass the portable-path rules so the write below stays
          // inside the replay temp root by construction. A persisted
          // traversal/unsafe path fails THIS case only.
          const safePath = portablePath(file.path);
          const target = path.join(tempRoot, ...safePath.split('/'));
          requireValue(target.startsWith(tempRoot + path.sep), 'unsafe-fixture-path');
          await mkdir(path.dirname(target), { recursive: true });
          await writeFile(target, file.bytes, 'utf8');
        }
        replayArgs = synthesizeReplayArgs(payload.original_assessment.consumer, normalizeReplayArgs(payload.replay.args), payload.fixture.files);
      } catch (error) {
        // Materialization or argv synthesis failure (persisted unsafe path,
        // legacy bundle without consumable inputs) is bounded to this case.
        materializationFailed = error instanceof WorkflowError ? error.code : 'replay-preparation-failed';
      }
      if (materializationFailed === null) {
        const chunks = [];
        let exitCode;
        try {
          exitCode = await engine(replayArgs, {
            rootDir: tempRoot,
            output: (value) => chunks.push(String(value)),
            assessor: typeof options.assessor === 'function' ? options.assessor : undefined,
            now: typeof options.now === 'function' ? options.now : undefined,
          });
        } catch {
          exitCode = 2;
        }
        let outcome = 'not_run';
        let signature = null;
        try {
          const extracted = extractOutcomeSignature(chunks.join(''));
          // Label comparison uses the FULL signature: the stored summary field
          // is bounded at 500 characters for the schema, but comparing the
          // truncated prefix would let changes beyond the bound produce false
          // holds/false_regression.
          const fullSignature = extracted.signature;
          signature = fullSignature.slice(0, 500);
          // Label comparison happens only for a complete observation: a failed,
          // abstained, or not-performed advisory run is never coerced into a
          // verdict (it is honestly reported as not_run).
          if (extracted.run_status === 'complete' && exitCode === 0) {
            const normalizedSignature = normalizeLabelText(fullSignature);
            if (normalizedSignature === normalizeLabelText(payload.expected_label)) outcome = 'holds';
            else if (normalizedSignature === normalizeLabelText(payload.original_assessment.verdict)) outcome = 'false_regression';
            else outcome = 'label_change';
          }
        } catch {
          outcome = 'not_run';
          signature = null;
        }
        replayOutcome = outcome;
        replaySignature = signature;
      } else {
        replayOutcome = 'invalid_record';
        replaySignature = materializationFailed;
      }
      if (replayOutcome === 'holds') partitionCounts.holds += 1;
      else if (replayOutcome === 'false_regression') partitionCounts.false_regression += 1;
      else if (replayOutcome === 'label_change') partitionCounts.label_change += 1;
      else if (replayOutcome === 'not_run') partitionCounts.not_run += 1;
      else if (replayOutcome === 'invalid_record') partitionCounts.invalid_record += 1;
      results.push({ ...outcomeBase, outcome: replayOutcome, signature: replaySignature });
    } finally {
      await rm(tempRoot, { recursive: true, force: true }).catch(() => {});
    }
  }
  const runRecord = {
    schema: DECISION_CORRECTION_RUN_SCHEMA,
    diagnostic_only: true,
    authorizes: [],
    // `options.runId` is a test-only seam: it lets the suite pre-occupy a run
    // leaf and prove the collision refusal deterministically.
    run_id: typeof options.runId === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(options.runId)
      ? options.runId : randomUUID().slice(0, 8),
    scope,
    written: false,
    honesty_note: HONESTY_NOTE,
    counts,
    cases: results,
  };
  const errors = validateJsonAgainstSchema(runRecord, runSchema());
  requireValue(errors.length === 0, 'run-schema-invalid', true);
  requireValue(!hasCorrectionsLeak(runRecord), 'privacy-leak', true);
  if (runInput.write !== true) {
    // Preview by default: a replay never persists anything without --write.
    return { ok: true, action: 'run', preview: true, run: runRecord };
  }
  const runFile = `${scopeDir}/runs/${runRecord.run_id}.json`;
  await assertGuard(await guardOwnedSurfaces(rootDir, [runFile, `${NAMESPACE_ROOT}/.gitignore`, `${scopeDir}/write.lock`], options));
  const runNamespace = await prepareNamespace(rootDir);
  await assertGuard(runNamespace.ok === true ? null : runNamespace);
  await assertGuard(await assertTempAreaIgnored(rootDir, runFile, options));
  return store.lock(`${scopeDir}/write.lock`, async () => {
    // Run-record leaf ownership: a run id collision (however unlikely for a
    // fresh random id) must never silently overwrite an existing run record.
    const existingRun = await store.load(runFile).catch((error) => {
      if (error instanceof WorkflowError) return { invalid: true };
      throw error;
    });
    requireValue(!existingRun, 'run-record-conflict', true);
    const persisted = { ...runRecord, written: true };
    await store.save(runFile, persisted);
    return { ok: true, action: 'run', preview: false, run: persisted };
  });
}

// ---------------------------------------------------------------------------
// Action dispatch (fields() contracts on the request-formation boundary,
// mirroring evolution-transactions.mjs:34-41)
// ---------------------------------------------------------------------------

export const DECISION_CORRECTIONS_ACTIONS = Object.freeze([
  'preview', 'save', 'confirm', 'reject', 'supersede', 'list', 'show', 'run', 'delete',
]);

export async function decisionCorrectionsCommand(action, input, options = {}) {
  requireValue(DECISION_CORRECTIONS_ACTIONS.includes(action), 'unknown-action');
  requireValue(input && typeof input === 'object' && !Array.isArray(input), 'invalid-input');
  if (action === 'preview') return previewDecisionCorrection(input, options);
  if (action === 'save') return saveDecisionCorrection(input, options);
  if (action === 'confirm' || action === 'reject' || action === 'supersede') return lifecycleCommand(action, input, options);
  if (action === 'delete') return deleteDecisionCorrection(input, options);
  if (action === 'list') return listDecisionCorrections(input, options);
  if (action === 'show') return showDecisionCorrection(input, options);
  return runDecisionCorrectionReplay(input, options);
}

// ---------------------------------------------------------------------------
// CLI: own named-flag parser (cliMain accepts only action + --json, so it
// cannot express this command surface). stdin JSON is the only body channel;
// flags never carry payloads. Exit 0 ok / 1 blocked / 2 invalid.
// ---------------------------------------------------------------------------

function parseDecisionCorrectionsArgs(argv) {
  const parsed = { ok: true, action: null, json: false, enabled: undefined, write: false, flags: {} };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') { parsed.json = true; continue; }
    if (arg === '--write') { parsed.write = true; continue; }
    if (arg === '--enabled') {
      const value = argv[index + 1];
      index += 1;
      if (value !== 'true' && value !== 'false') return { ok: false, error: 'enabled flag requires true or false' };
      parsed.enabled = value === 'true';
      continue;
    }
    if (arg === '--scope' || arg === '--case' || arg === '--limit' || arg === '--status-filter' || arg === '--partition-filter') {
      const value = argv[index + 1];
      index += 1;
      if (typeof value !== 'string') return { ok: false, error: `${arg} requires a value` };
      const key = arg === '--case' ? 'case_id' : arg.slice(2).replaceAll('-', '_');
      parsed.flags[key] = value;
      continue;
    }
    if (arg.startsWith('--')) return { ok: false, error: `unknown flag ${arg}` };
    if (parsed.action !== null) return { ok: false, error: 'exactly one action is required' };
    if (!DECISION_CORRECTIONS_ACTIONS.includes(arg)) return { ok: false, error: `unknown action ${arg}` };
    parsed.action = arg;
  }
  if (parsed.action === null) return { ok: false, error: 'action is required' };
  return parsed;
}

async function readStdinBounded(limit, options) {
  const chunks = [];
  if (options.readStdin !== undefined) {
    const provided = await options.readStdin();
    if (provided.length > limit) throw new WorkflowError('stdin-limit-exceeded');
    chunks.push(provided);
    return Buffer.concat(chunks);
  }
  let total = 0;
  for await (const chunk of process.stdin) {
    total += chunk.length;
    if (total > limit) throw new WorkflowError('stdin-limit-exceeded');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function sanitizeEnvelope(envelope) {
  if (!hasCorrectionsLeak(envelope)) return envelope;
  // Defense in depth: an envelope that trips the leak predicate is reduced to
  // a blocked refusal; nothing engine-derived is echoed, whatever the
  // envelope's original ok flag was.
  return { ok: false, code: 'privacy-leak' };
}

export async function runDecisionCorrectionsCommand(argv = process.argv.slice(2), options = {}) {
  const output = options.output ?? ((value) => process.stdout.write(value));
  const emit = (value, json) => output(json ? `${JSON.stringify(value, null, 2)}\n` : `${JSON.stringify(value)}\n`);
  const parsed = parseDecisionCorrectionsArgs(argv);
  if (!parsed.ok) {
    // The usage error text mirrors caller argv (unknown flags/actions), so it
    // passes through the same leak scan before any print: a token-, URL-, or
    // path-shaped argv fragment is never echoed back.
    const envelope = sanitizeEnvelope({ ok: false, code: 'invalid-usage', detail: parsed.error.slice(0, 200) });
    emit(envelope, argv.includes('--json'));
    return 2;
  }
  try {
    let input = {};
    const body = await readStdinBounded(MAX_STDIN_BYTES, options);
    if (body.length > 0) {
      try {
        input = parseStrictJson(new TextDecoder('utf-8', { fatal: true }).decode(body));
      } catch {
        throw new WorkflowError('invalid-json');
      }
    }
    requireValue(input && typeof input === 'object' && !Array.isArray(input), 'invalid-json');
    if (parsed.write) input.write = true;
    for (const [key, value] of Object.entries(parsed.flags)) {
      // Compare in the same domain as the body field: the limit flag arrives
      // as a string but the stdin field is a number, so coercion happens
      // before the conflict check, not after.
      const coerced = key === 'limit' ? Number(value) : value;
      requireValue(!Object.hasOwn(input, key) || input[key] === coerced, 'conflicting-input');
      input[key] = coerced;
    }
    const cliOptions = { ...options, enabled: parsed.enabled !== undefined ? parsed.enabled : options.enabled };
    const result = await decisionCorrectionsCommand(parsed.action, input, cliOptions);
    const envelope = sanitizeEnvelope({ ok: true, ...result });
    if (envelope.ok !== true) {
      // A success result whose envelope trips the leak predicate is reduced
      // to a blocked refusal and exits blocked, not silently as ok:false with
      // exit 0.
      emit(envelope, parsed.json);
      return 1;
    }
    emit(envelope, parsed.json);
    return 0;
  } catch (error) {
    const blocked = error instanceof WorkflowError && error.blocked;
    const code = error instanceof WorkflowError ? error.code : 'decision-corrections-error';
    emit(sanitizeEnvelope({ ok: false, code }), parsed.json);
    return blocked ? 1 : 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runDecisionCorrectionsCommand();
}
