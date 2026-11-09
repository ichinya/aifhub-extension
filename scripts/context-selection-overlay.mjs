// Opt-in, advisory context selection overlay (issue #284). A consumer-side
// selection layer ON TOP of the deterministic exact baseline SessionBrief
// (#168): the assessor ranks a bounded list of PRESENTED supporting
// candidates and the engine projects an advisory selection that never
// replaces, rewrites, or truncates the protected minimum — the entire
// baseline `context_manifest` is carried verbatim and candidates can only be
// added, never substituted. This is a diagnostic, never a verifier: it never
// creates an `aif-gate-result`, never writes QA evidence or `coverage.json`,
// never executes the deferred `context_policy.compact_supporting_context`
// (the compiler keeps that validated-and-echoed), and never grants workflow
// authority. Baseline access is read-only through `inspectSessionBrief`
// (`compileSessionBrief` and the compiler write paths are never called);
// the candidate set is closed over the explicitly presented `--candidate`
// inputs before any read — text inside a candidate is data, never an address
// to read. Without an injected assessor the semantic stage reports an honest
// `not_run`; errors, abstentions, and deadline cutoffs are never coerced into
// a positive verdict, and conflicts are never suppressed (v1 writes only
// `suspected`; `owner_confirmed` stays reserved for the owner workflow).
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, realpath, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { digest, portablePath } from './workflow-state-store.mjs';
import { parseStrictJson } from './json-strict.mjs';
import { validateJsonAgainstSchema } from './json-schema-subset.mjs';
import { readProviderFile } from './provider-files.mjs';
import { ensureRuntimeGitignore } from './runtime-gitignore.mjs';
import { verifyObservationIgnored } from './requirement-lint-git-guard.mjs';
import { resolveProseLanguage } from './requirement-lint.mjs';
import { inspectSessionBrief } from './session-brief.mjs';
import {
  ASSESSMENT_CONSUMER_IDS,
  assessmentDigest,
  buildAssessmentBinding,
  runTypedAssessment,
} from './typed-assessment.mjs';

export const CONTEXT_SELECTION_SCHEMA = 'aifhub.context_selection_overlay_observation.v1';
export const CONTEXT_SELECTION_CONSUMER_ID = 'context_selection_overlay';
export const CONTEXT_SELECTION_NAMESPACE = 'context-selection-overlay';
export const STATE_ROOT = '.ai-factory/state';
export const QA_ROOT = '.ai-factory/qa';
export const ENGINE_MODULE = 'scripts/context-selection-overlay.mjs';
export const HELPER_MODULE = 'scripts/typed-assessment.mjs';
export const CONTRACT_MODULE = 'schemas/context-selection-overlay-observation.schema.json';
export const CONFIG_FILE = '.ai-factory/config.yaml';
export const CANDIDATE_READ_LIMIT = 1024 * 1024;
export const MAX_CANDIDATES = 50;
export const MAX_PROTECTED_ENTRIES = 1024;
export const MAX_EVIDENCE_REFS_PER_CANDIDATE = 20;
// The schema caps every span endpoint at the JSON-safe-integer bound
// (schemas/context-selection-overlay-observation.schema.json); the
// normalizer enforces the same ceiling so an oversized-but-integer span is
// dropped at the refs boundary instead of surviving normalization and
// detonating the final schema gate into an operational-failure that would
// discard the whole baseline projection (review RG284-003).
export const MAX_SPAN_VALUE = 9007199254740991;
export const MAX_MISSING = 100;
export const MAX_PRESENTATION_SECTIONS = 4;
export const MAX_PRESENTATION_BYTES = 1024 * 1024;
export const MAX_OBSERVATION_BYTES = 1024 * 1024;
export const MAX_DIAGNOSTICS = 200;
export const MAX_ASSESSMENT_TEXT = 65536;
export const DEFAULT_DEADLINE_MS = 30000;
export const NOT_RUN_MESSAGE = 'advisory scan was not performed';
export const usage = 'ai-factory aifhub-context-selection-overlay --change <id> [--enabled true|false] [--candidate <path> ...] [--json] [--write]';
// Single change-id form (custody contract `safeId`), same as the #283
// producer: validated before any read, refused not normalized.
export const CHANGE_ID_FORM = /^[a-z0-9][a-z0-9-]{0,99}$/;
// Closed selection rubric / policies. The assessor ranks; the engine never
// lets a score collapse the triple (relevance / evidence_support /
// contradiction stay separate), and v1 records conflicts as `suspected` only.
export const CONTEXT_SELECTION_RUBRIC = Object.freeze({ id: 'context-selection-advisory-default', version: 1 });
export const EXCLUSION_POLICY = Object.freeze({ id: 'none', version: 1 });
export const PRESENTATION_POLICY = Object.freeze({ id: 'context-selection-sections-v1', version: 1 });
export const CANDIDATE_STATUSES = Object.freeze(['included', 'conflicting', 'excluded', 'unassessed']);
export const PRESENTATION_SECTIONS = Object.freeze(['protected_minimum', 'relevant', 'conflicts', 'unresolved']);
export const CONFLICT_STATES = Object.freeze(['suspected', 'owner_confirmed']);
export const ASSESSMENT_LIMITS = Object.freeze({
  max_candidates: MAX_CANDIDATES,
  max_assessment_text: MAX_ASSESSMENT_TEXT,
  max_evidence_refs: MAX_EVIDENCE_REFS_PER_CANDIDATE,
});
export const BUDGET_POLICY = Object.freeze({ strategy: 'measured', limit: MAX_PRESENTATION_BYTES });
export const OVERSIZE_MESSAGE = 'protected minimum does not fit the presentation budget';

export function contextSelectionPaths(changeId) {
  if (typeof changeId !== 'string' || !CHANGE_ID_FORM.test(changeId)) throw new Error('invalid-change-id');
  return {
    directory: `${STATE_ROOT}/${changeId}/${CONTEXT_SELECTION_NAMESPACE}`,
    observation: `${STATE_ROOT}/${changeId}/${CONTEXT_SELECTION_NAMESPACE}/observation.json`,
  };
}

// ---------------------------------------------------------------------------
// Argument parsing (explicit-only; unknown/duplicate/missing -> invalid usage)
// ---------------------------------------------------------------------------

export function parseOverlayArgs(argv) {
  const result = { ok: true, changeId: null, candidatePaths: [], json: false, write: false, enabled: null, error: null };
  const invalid = (error) => ({ ...result, ok: false, error });
  const seen = new Set();
  const args = Array.from(argv ?? []);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!['--change', '--candidate', '--enabled', '--json', '--write'].includes(arg)) {
      return invalid(`unknown option: ${arg}`);
    }
    if (arg !== '--candidate' && seen.has(arg)) return invalid(`duplicate option: ${arg}`);
    if (arg !== '--candidate') seen.add(arg);
    if (arg === '--json') { result.json = true; continue; }
    if (arg === '--write') { result.write = true; continue; }
    const value = args[index + 1];
    if (typeof value !== 'string' || value.startsWith('--')) return invalid(`missing value for ${arg}`);
    index += 1;
    if (arg === '--change') result.changeId = value;
    else if (arg === '--candidate') result.candidatePaths.push(value);
    else if (!['true', 'false'].includes(value)) return invalid(`--enabled expects true|false, got: ${value}`);
    else result.enabled = value === 'true';
  }
  return result;
}

function validateFileForm(relative) {
  if (typeof relative !== 'string' || !relative || relative.includes('\\') || relative.includes(':')
    || relative.split('/').some((part) => !part || part === '.' || part === '..')
    || /[\x00-\x1f]/.test(relative)) return false;
  try { portablePath(relative); } catch { return false; }
  return true;
}

// ---------------------------------------------------------------------------
// Bounded closed config read for the `aifhub.contextSelectionOverlay` opt-in
// namespace (mirror of the #281-#283 subset parsers: explicit detections keep
// the overlay off with bounded `context-selection-overlay:<code>` diagnostics;
// a malformed namespace degrades to "advisory scan was not performed" and the
// CLI override cannot rescue it). The structural guard includes `paths` so a
// custom `paths.state` still reaches the writer's `state-root-mismatch`
// refusal instead of dying as an unparseable namespace.
// ---------------------------------------------------------------------------

const OVERLAY_CONFIG_PATH = Object.freeze(['aifhub', 'contextSelectionOverlay']);
const OVERLAY_CONFIG_CLOSED_KEYS = Object.freeze(new Set(['enabled']));
const OVERLAY_STRUCTURAL_PATHS = Object.freeze([
  ['aifhub'],
  OVERLAY_CONFIG_PATH,
  ['paths'],
]);

function overlayConfigDiagnostic(code, detail) {
  return { code: `context-selection-overlay:${code}`, path: CONFIG_FILE, detail: detail === undefined ? null : String(detail).slice(0, 200) };
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

export function parseContextSelectionOverlayConfigSubset(raw) {
  const diagnostics = [];
  const root = Object.create(null);
  const stack = [{ indent: -1, value: root, path: [] }];
  const belowOverlay = (path) => path.length > OVERLAY_CONFIG_PATH.length
    && OVERLAY_CONFIG_PATH.every((part, index) => path[index] === part);
  const structural = (path) => OVERLAY_STRUCTURAL_PATHS.some((candidate) => candidate.length === path.length
    && candidate.every((part, index) => path[index] === part));
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
      // form, never a silent skip: the overlay must not stay enabled because
      // an unparseable line happened to sit next to `enabled: true`.
      const parentPath = stack.at(-1).path;
      if (belowOverlay(parentPath) || structural(parentPath)
        || (parentPath.length >= OVERLAY_CONFIG_PATH.length
          && OVERLAY_CONFIG_PATH.every((part, index) => parentPath[index] === part))) {
        diagnostics.push(overlayConfigDiagnostic('malformed-line', withoutComment.trim().slice(0, 100)));
      }
      continue;
    }
    const indent = match[1].length;
    const key = match[2].trim();
    const rawValue = match[3]?.trim() ?? '';
    while (stack.length > 1 && stack.at(-1).indent >= indent) stack.pop();
    const parent = stack.at(-1);
    const ownPath = [...parent.path, key];
    const inside = belowOverlay(ownPath);
    const guarded = inside || structural(ownPath);
    if (guarded && key === '<<') {
      diagnostics.push(overlayConfigDiagnostic('merge-key', key));
      continue;
    }
    if (guarded && rawValue.startsWith('&')) {
      diagnostics.push(overlayConfigDiagnostic('anchor', key));
      continue;
    }
    if (guarded && rawValue.startsWith('*')) {
      diagnostics.push(overlayConfigDiagnostic('alias', key));
      continue;
    }
    if (guarded && /^[{[]/.test(rawValue)) {
      diagnostics.push(overlayConfigDiagnostic('flow-mapping', key));
      continue;
    }
    if (guarded && Object.hasOwn(parent.value, key)) {
      diagnostics.push(overlayConfigDiagnostic('duplicate-key', `${ownPath.join('.')}`));
      continue;
    }
    if (inside && !OVERLAY_CONFIG_CLOSED_KEYS.has(key)) {
      diagnostics.push(overlayConfigDiagnostic('unknown-key', key));
      continue;
    }
    if (rawValue.length === 0) {
      parent.value[key] = Object.create(null);
      stack.push({ indent, value: parent.value[key], path: ownPath });
      continue;
    }
    const parsed = scalar(rawValue);
    if (guarded && parsed.unterminated) {
      diagnostics.push(overlayConfigDiagnostic('unterminated-quote', key));
      continue;
    }
    if (inside && key === 'enabled' && parsed.quoted && /^(true|false)$/i.test(parsed.text)) {
      diagnostics.push(overlayConfigDiagnostic('quoted-boolean', rawValue));
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

export async function readContextSelectionOverlayConfig(rootDir, options = {}) {
  const diagnostics = [];
  const config = {
    enabled: null, // null = key absent -> default false; never auto-enabled
    enabledMalformed: false,
    stateRoot: STATE_ROOT,
    qaRoot: QA_ROOT,
    stateRootRaw: undefined,
    qaRootRaw: undefined,
    diagnostics,
  };
  let bytes = null;
  try {
    bytes = await readProviderFile(rootDir, CONFIG_FILE, 256 * 1024);
  } catch (error) {
    diagnostics.push({ code: 'config-unreadable', path: CONFIG_FILE, detail: String(error?.message ?? error).slice(0, 500) });
    config.enabledMalformed = true;
    return config;
  }
  if (bytes === null) return config;
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    diagnostics.push({ code: 'config-malformed', path: CONFIG_FILE, detail: 'utf8-fatal' });
    config.enabledMalformed = true;
    return config;
  }
  const parsed = parseContextSelectionOverlayConfigSubset(text);
  diagnostics.push(...parsed.diagnostics);
  const hub = parsed.value?.aifhub;
  const paths = parsed.value?.paths;
  let structuralDamage = false;
  for (const [name, section] of [['aifhub', hub], ['paths', paths]]) {
    if (section !== undefined && section !== null && (typeof section !== 'object' || Array.isArray(section))) {
      diagnostics.push(overlayConfigDiagnostic('scalarized-section', name));
      structuralDamage = true;
    }
  }
  const overlaySection = hub && typeof hub === 'object' ? hub.contextSelectionOverlay : undefined;
  if (overlaySection !== undefined && (overlaySection === null || typeof overlaySection !== 'object' || Array.isArray(overlaySection))) {
    diagnostics.push(overlayConfigDiagnostic('scalarized-section', 'aifhub.contextSelectionOverlay'));
    config.enabledMalformed = true;
  }
  const enabled = overlaySection && typeof overlaySection === 'object' ? overlaySection.enabled : undefined;
  if (enabled !== undefined) {
    if (typeof enabled === 'boolean') config.enabled = enabled;
    else {
      config.enabledMalformed = true;
      diagnostics.push(overlayConfigDiagnostic('not-a-boolean', JSON.stringify(enabled)));
    }
  }
  if (parsed.diagnostics.length > 0 || structuralDamage) config.enabledMalformed = true;
  if (paths && typeof paths === 'object' && !Array.isArray(paths)) {
    const rawState = paths.state;
    if (rawState !== undefined) config.stateRootRaw = rawState;
    const stateRoot = normalizeConfigPath(rawState);
    if (stateRoot !== null) config.stateRoot = stateRoot;
    const rawQa = paths.qa;
    if (rawQa !== undefined) config.qaRootRaw = rawQa;
    const qaRoot = normalizeConfigPath(rawQa);
    if (qaRoot !== null) config.qaRoot = qaRoot;
  }
  return config;
}

// ---------------------------------------------------------------------------
// Candidate intake: closed over the presented `--candidate` inputs before any
// read. One shared byte classifier for intake, freshness probe, and
// revalidation: a candidate that cannot be read whole never masquerades as
// `file`, and a truncated read is re-derived identically at probe time so a
// recorded observation is never "born stale".
// ---------------------------------------------------------------------------

function classifyCandidateBytes(bytes, error) {
  if (bytes !== null) {
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      return { sha256: digest(bytes), bytes: bytes.length, kind: 'file', reason: null };
    } catch {
      return { sha256: digest(bytes), bytes: bytes.length, kind: 'malformed', reason: 'utf8-fatal' };
    }
  }
  const message = String(error?.message ?? error ?? '');
  if (message === 'file_limit' || message === 'file_changed') {
    // The read started and was cut short by the bounded reader: an honest
    // truncation, never a silently partial document.
    return { sha256: null, bytes: 0, kind: 'truncated', reason: message === 'file_changed' ? 'file-changed' : 'file-limit' };
  }
  if (message === 'unsafe_file' || message === 'unsafe_path') {
    // The read was REFUSED before any content was verified (hardlink or
    // non-regular file, path outside the portable containment): a form
    // refusal, not a truncation and not an absence. The `unsafe_file`
    // oversize sub-case is refined by `classifyCandidateInput` below.
    return { sha256: null, bytes: 0, kind: 'malformed', reason: message === 'unsafe_file' ? 'unsafe-file' : 'unsafe-path' };
  }
  return { sha256: null, bytes: 0, kind: 'missing', reason: message ? message.slice(0, 200) : 'file-missing' };
}

// The bounded reader signals oversize files through `unsafe_file` together
// with hardlink/non-regular shapes; only the oversize sub-case is a real
// truncation. One metadata-only stat (no content read) separates them so the
// classification stays honest at intake, probe, and revalidation time.
async function classifyCandidateInput(rootDir, candidatePath, bytes, error) {
  const classified = classifyCandidateBytes(bytes, error);
  if (classified.kind === 'malformed' && classified.reason === 'unsafe-file') {
    try {
      const info = await lstat(path.join(rootDir, candidatePath));
      if (info.isFile() && info.size > CANDIDATE_READ_LIMIT) {
        return { sha256: null, bytes: 0, kind: 'truncated', reason: 'file-limit' };
      }
    } catch {
      // Unstatable at classification time: the refusal form stands.
    }
  }
  return classified;
}

export async function readCandidates(rootDir, candidatePaths, diagnostics, options = {}) {
  const unique = [];
  const seen = new Set();
  for (const candidatePath of candidatePaths) {
    if (seen.has(candidatePath)) {
      diagnostics.push({ code: 'duplicate-candidate', path: candidatePath, detail: 'presented more than once; assessed once' });
      continue;
    }
    seen.add(candidatePath);
    unique.push(candidatePath);
  }
  const reader = options.readCandidate ?? (async (root, rel, limit) => readProviderFile(root, rel, limit));
  const candidates = [];
  for (const candidatePath of unique) {
    let bytes = null;
    let error = null;
    try {
      bytes = await reader(rootDir, candidatePath, CANDIDATE_READ_LIMIT);
    } catch (readError) {
      bytes = null;
      error = readError;
    }
    const classified = await classifyCandidateInput(rootDir, candidatePath, bytes, error);
    if (classified.kind !== 'file') {
      diagnostics.push({ code: `candidate-${classified.kind}`, path: candidatePath, detail: classified.reason });
    }
    candidates.push({
      path: candidatePath,
      sha256: classified.sha256,
      bytes: classified.bytes,
      kind: classified.kind,
      reason: classified.reason,
      text: bytes === null ? '' : safeDecode(bytes),
    });
  }
  // Deterministic ids: sorted by path, so the same presentation always maps
  // to the same candidate ids regardless of CLI order.
  candidates.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return candidates.map((candidate, index) => ({ ...candidate, candidate_id: `cand-${index}` }));
}

function safeDecode(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return '';
  }
}

// Bounded assessor text in UTF-8 BYTES (review F07): the 64 KiB policy limit
// is a byte budget, so multibyte content (Cyrillic, emoji) cannot exceed it
// by counting UTF-16 code units, and the cut backs off to the last complete
// UTF-8 sequence — it never splits a code point mid-sequence.
export function boundAssessmentText(text, limit) {
  if (typeof text !== 'string') return { text: '', truncated: false };
  let byteLength = Buffer.byteLength(text, 'utf8');
  if (byteLength <= limit) return { text, truncated: false };
  const buffer = Buffer.from(text, 'utf8');
  let end = limit;
  let scan = end;
  let continuation = 0;
  while (scan > 0 && (buffer[scan - 1] & 0xC0) === 0x80) {
    continuation += 1;
    scan -= 1;
  }
  if (scan > 0) {
    const lead = buffer[scan - 1];
    const expected = lead >= 0xF0 ? 4 : lead >= 0xE0 ? 3 : lead >= 0xC0 ? 2 : 1;
    if (expected > 1 && continuation + 1 < expected) end = scan - 1;
  }
  const bounded = buffer.subarray(0, end).toString('utf8');
  byteLength = Buffer.byteLength(bounded, 'utf8');
  return { text: bounded, truncated: true, bytes: byteLength };
}

// ---------------------------------------------------------------------------
// Protected minimum (decision 2-A): the ENTIRE baseline `context_manifest`
// verbatim — paths, hashes, fidelity — with measured bytes joined from the
// brief's `sources[]`. No selection happens inside the baseline; an entry
// whose bytes cannot be verified degrades the run honestly instead of
// inventing a size.
// ---------------------------------------------------------------------------

export function buildProtectedMinimum(brief, diagnostics) {
  const manifest = Array.isArray(brief?.context_manifest) ? brief.context_manifest : [];
  const sources = Array.isArray(brief?.sources) ? brief.sources : [];
  const bytesByPath = new Map(sources.map((source) => [source.path, source]));
  const protected_minimum = [];
  const missing = [];
  let minimumRequired = 0;
  for (const entry of manifest) {
    const source = bytesByPath.get(entry?.path);
    const verified = Boolean(source && source.sha256 === entry.sha256 && Number.isInteger(source.bytes) && source.bytes >= 0);
    protected_minimum.push({ path: entry.path, sha256: entry.sha256, fidelity: entry.fidelity });
    if (verified) {
      minimumRequired += source.bytes;
    } else {
      // Not by compiler construction, but honest if it ever happens: the
      // baseline claims a protected source whose measured identity is not
      // joinable — fail closed, never invent bytes.
      missing.push({ path: entry.path, reason: 'protected-minimum-unverified' });
      diagnostics.push({ code: 'protected-minimum-unverified', path: entry.path, detail: 'no measured source pair for the manifest entry' });
    }
  }
  return { protected_minimum, missing, minimumRequired, supported: manifest.length <= MAX_PROTECTED_ENTRIES };
}

// ---------------------------------------------------------------------------
// Assessor findings normalization. The assessor owns candidate vocabulary;
// every finding outside the closed shape is dropped with a bounded
// diagnostic and its candidate stays `unassessed`. `owner_confirmed` is
// reserved for the owner workflow: the engine never records it, and a
// finding that claims it is dropped wholesale — confirmation is never a
// model self-declaration (precedent: requirement-lint suspected conflicts +
// owner workflow).
// ---------------------------------------------------------------------------

function sanitizeEvidenceRef(ref, diagnostics, candidateId) {
  if (!ref || typeof ref !== 'object' || Array.isArray(ref)) return null;
  if (!validateFileForm(ref.path)) {
    diagnostics.push({ code: 'evidence-ref-invalid', path: candidateId, detail: 'path outside the portable form' });
    return null;
  }
  const out = { path: ref.path, document_sha256: typeof ref.document_sha256 === 'string' && /^[a-f0-9]{64}$/.test(ref.document_sha256) ? ref.document_sha256 : null };
  if (out.document_sha256 === null) {
    diagnostics.push({ code: 'evidence-ref-invalid', path: candidateId, detail: 'missing document digest' });
    return null;
  }
  if (ref.span !== undefined) {
    // Exactness over availability: a ref whose span is present-but-garbage is
    // dropped outright — a pointer that cannot be trusted is worse than none.
    // The schema ceiling is checked HERE, at the refs boundary: an
    // oversized-but-integer span (Number.isInteger(1e20) is true) must not
    // survive normalization only to detonate the final schema gate into an
    // operational-failure that discards the protected-minimum projection
    // (review RG284-003).
    if (!ref.span || typeof ref.span !== 'object' || Array.isArray(ref.span)
      || !Number.isInteger(ref.span.start) || !Number.isInteger(ref.span.end)
      || ref.span.start < 0 || ref.span.end < ref.span.start
      || ref.span.start > MAX_SPAN_VALUE || ref.span.end > MAX_SPAN_VALUE) {
      diagnostics.push({ code: 'evidence-ref-invalid', path: candidateId, detail: 'span outside the closed shape' });
      return null;
    }
    out.span = { start: ref.span.start, end: ref.span.end };
  }
  if (typeof ref.span_sha256 === 'string' && /^[a-f0-9]{64}$/.test(ref.span_sha256)) out.span_sha256 = ref.span_sha256;
  return out;
}

function sanitizeRefs(rawRefs, diagnostics, candidateId) {
  const refs = [];
  let truncated = false;
  for (const raw of Array.isArray(rawRefs) ? rawRefs : []) {
    const ref = sanitizeEvidenceRef(raw, diagnostics, candidateId);
    if (ref === null) continue;
    if (refs.length >= MAX_EVIDENCE_REFS_PER_CANDIDATE) { truncated = true; break; }
    refs.push(ref);
  }
  if (truncated) diagnostics.push({ code: 'evidence-refs-truncated', path: candidateId, detail: `limit=${MAX_EVIDENCE_REFS_PER_CANDIDATE}` });
  return refs;
}

function sanitizeScores(rawScores, diagnostics, candidateId) {
  if (rawScores === null || rawScores === undefined) return null;
  if (!rawScores || typeof rawScores !== 'object' || Array.isArray(rawScores)) return { invalid: true };
  const bounded = (value) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null);
  const scores = {
    relevance: bounded(rawScores.relevance),
    evidence_support: bounded(rawScores.evidence_support),
    contradiction: bounded(rawScores.contradiction),
  };
  // A triple that is entirely absent numbers is a shape violation, not a
  // null triple: the assessor either scores or stays silent.
  if (scores.relevance === null && scores.evidence_support === null && scores.contradiction === null
    && (rawScores.relevance !== null || rawScores.evidence_support !== null || rawScores.contradiction !== null)) {
    diagnostics.push({ code: 'invalid-assessment', path: candidateId, detail: 'scores outside the closed triple' });
    return { invalid: true };
  }
  // A partially invalid triple keeps its valid numbers but never silently:
  // every dropped field is named.
  const unboundedFields = ['relevance', 'evidence_support', 'contradiction']
    .filter((field) => rawScores[field] !== undefined && rawScores[field] !== null && scores[field] === null);
  if (unboundedFields.length > 0) {
    diagnostics.push({ code: 'invalid-score-field', path: candidateId, detail: `unbounded fields: ${unboundedFields.join(',')}`.slice(0, 500) });
  }
  return scores;
}

const BOUNDED_TEXT = (value) => (typeof value === 'string' ? (value.length > 500 ? value.slice(0, 500) : value) : null);

export function normalizeAssessorFindings(outcome, candidates, diagnostics) {
  if (outcome.run_status !== 'complete' || outcome.abstained === true) return new Map();
  // The assessor was presented ONLY readable candidates as assessable input;
  // a finding for a missing/malformed/truncated candidate id (whose content
  // the assessor never saw) is an outside-envelope reference and is dropped
  // like any unknown id — its candidate stays honestly unassessed (review
  // R2-N3/codex N3).
  const byId = new Map(candidates
    .filter((candidate) => candidate.kind === 'file')
    .map((candidate) => [candidate.candidate_id, candidate]));
  const assessments = new Map();
  for (const finding of Array.isArray(outcome.findings) ? outcome.findings : []) {
    const candidate = finding && typeof finding === 'object' && !Array.isArray(finding) ? byId.get(finding.candidate_id) : null;
    if (!candidate) {
      diagnostics.push({ code: 'unknown-candidate-reference', path: null, detail: 'dropped a finding outside the presented candidates' });
      continue;
    }
    if (assessments.has(candidate.candidate_id)) {
      diagnostics.push({ code: 'duplicate-candidate-assessment', path: candidate.candidate_id, detail: 'kept the first assessment' });
      continue;
    }
    if (!CANDIDATE_STATUSES.includes(finding.status) || finding.status === 'unassessed') {
      if (finding.status !== 'unassessed') diagnostics.push({ code: 'invalid-assessment', path: candidate.candidate_id, detail: 'status outside the closed set' });
      continue;
    }
    // The engine never records owner confirmation (decision D6).
    if (finding.conflict && typeof finding.conflict === 'object' && finding.conflict.state === 'owner_confirmed') {
      diagnostics.push({ code: 'owner-confirmation-reserved', path: candidate.candidate_id, detail: 'finding dropped: owner confirmation is not a model self-declaration' });
      continue;
    }
    const scores = sanitizeScores(finding.scores ?? null, diagnostics, candidate.candidate_id);
    if (scores && scores.invalid === true) continue;
    const reason = BOUNDED_TEXT(finding.reason);
    const limitation = BOUNDED_TEXT(finding.limitation);
    if (finding.status === 'conflicting') {
      const refs = sanitizeRefs(finding.conflict?.refs, diagnostics, candidate.candidate_id);
      if (refs.length === 0) {
        // A conflict without exact refs is invisible and unverifiable: it is
        // dropped, the candidate stays unassessed, and the consumer learns
        // why through the bounded diagnostic.
        diagnostics.push({ code: 'conflict-without-refs', path: candidate.candidate_id, detail: 'conflict finding dropped' });
        continue;
      }
      const evidenceRefs = sanitizeRefs(finding.evidence_refs, diagnostics, candidate.candidate_id);
      if (evidenceRefs.length === 0) {
        // Same honesty at the second refs leg: a conflicting candidate with
        // conflict refs but NO exact evidence refs would violate the engine
        // invariant (`conflicting ⇒ non-empty exact refs`) and crash the run
        // downstream. It is a dropped finding with a diagnostic, never an
        // invariant failure — the candidate stays unassessed.
        diagnostics.push({ code: 'conflict-without-evidence-refs', path: candidate.candidate_id, detail: 'conflict finding dropped' });
        continue;
      }
      if (finding.conflict?.state !== undefined && finding.conflict?.state !== 'suspected' && finding.conflict?.state !== 'owner_confirmed') {
        // Unknown state vocabularies normalize to `suspected` visibly: the
        // coercion is a bounded diagnostic, not a silent rewrite.
        diagnostics.push({ code: 'conflict-state-normalized', path: candidate.candidate_id, detail: String(finding.conflict.state).slice(0, 200) });
      }
      assessments.set(candidate.candidate_id, {
        status: 'conflicting',
        scores,
        reason,
        limitation,
        evidence_refs: evidenceRefs,
        conflict: { state: 'suspected', refs },
      });
      continue;
    }
    if (finding.status === 'excluded' && !(typeof reason === 'string' && reason.length > 0)) {
      diagnostics.push({ code: 'invalid-assessment', path: candidate.candidate_id, detail: 'excluded without a reason' });
      continue;
    }
    assessments.set(candidate.candidate_id, {
      status: finding.status,
      scores,
      reason,
      // The engine invariant demands a non-empty limitation for `excluded`
      // only (review R2-N1): an included candidate keeps the assessor's own
      // limitation (usually null) — a default phrased "excluded by the
      // assessor" on an INCLUDED record would be self-contradictory
      // metadata.
      limitation: finding.status === 'excluded' && !(typeof limitation === 'string' && limitation.length > 0)
        ? 'excluded by the assessor'
        : limitation,
      evidence_refs: sanitizeRefs(finding.evidence_refs, diagnostics, candidate.candidate_id),
      conflict: null,
    });
  }
  return assessments;
}

// ---------------------------------------------------------------------------
// Projection assembly: statuses, budget demotions (fail-closed, never silent
// truncation), conflicts, presentation sections, and the AND completeness
// model (`complete` = assessor complete && budget fits && nothing demoted &&
// full coverage && fresh probe).
// ---------------------------------------------------------------------------

const idOrder = (left, right) => {
  const number = (id) => Number.parseInt(String(id).slice('cand-'.length), 10) || 0;
  return number(left) - number(right);
};

export function projectSelection({ candidates, assessments, rankedIds, minimumRequired, conflictRefsBytes, limit }) {
  const diagnostics = [];
  const manifestIncluded = [];
  const manifestExcluded = [];
  let estimated = minimumRequired;
  let demoted = 0;
  // Greedy inclusion follows the assessor's ranking order — the findings
  // array order passed as `rankedIds` — never the path-sorted intake order
  // (review R1-6/devin probe B: a path-early candidate must not beat a
  // top-ranked one under budget pressure). Candidates the assessor marked
  // `excluded` do not consume budget; conflicting candidates are refs-only;
  // and only READABLE candidates consume budget — an unreadable candidate
  // becomes `unassessed` regardless of any assessment, so it must never
  // spend the presentation budget a real supporting candidate needs
  // (review R2-N3/codex N3).
  const rank = new Map((Array.isArray(rankedIds) ? rankedIds : []).map((id, index) => [id, index]));
  const includable = candidates
    .filter((candidate) => candidate.kind === 'file'
      && assessments.get(candidate.candidate_id)?.status === 'included')
    .sort((left, right) => (rank.get(left.candidate_id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(right.candidate_id) ?? Number.MAX_SAFE_INTEGER));
  const demotedIds = new Set();
  const demotionDetails = new Map();
  for (const candidate of includable) {
    if (estimated + candidate.bytes > limit) {
      demotedIds.add(candidate.candidate_id);
      demotionDetails.set(candidate.candidate_id, `estimated=${estimated + candidate.bytes} limit=${limit}`);
      demoted += 1;
      continue;
    }
    estimated += candidate.bytes;
  }
  const records = candidates.map((candidate) => {
    const assessment = assessments.get(candidate.candidate_id);
    const readable = candidate.kind === 'file';
    if (!readable) {
      return {
        candidate_id: candidate.candidate_id,
        path: candidate.path,
        sha256: candidate.sha256,
        bytes: candidate.bytes,
        kind: candidate.kind,
        status: 'unassessed',
        scores: null,
        reason: `candidate-source-${candidate.kind}`,
        limitation: null,
        evidence_refs: [],
        conflict: null,
      };
    }
    if (!assessment) {
      return {
        candidate_id: candidate.candidate_id,
        path: candidate.path,
        sha256: candidate.sha256,
        bytes: candidate.bytes,
        kind: candidate.kind,
        status: 'unassessed',
        scores: null,
        reason: 'assessor-left-unassessed',
        limitation: null,
        evidence_refs: [],
        conflict: null,
      };
    }
    const base = {
      candidate_id: candidate.candidate_id,
      path: candidate.path,
      sha256: candidate.sha256,
      bytes: candidate.bytes,
      kind: candidate.kind,
      scores: assessment.scores,
      evidence_refs: assessment.evidence_refs,
      conflict: assessment.conflict,
    };
    // A conflicting candidate never becomes `excluded` (decision D5): its
    // content is not presented at all (refs-only projection), so the budget
    // cannot demote it and the conflict stays visible at any relevance rank.
    if (assessment.status === 'conflicting') return { ...base, status: 'conflicting', reason: assessment.reason, limitation: assessment.limitation };
    if (assessment.status === 'excluded') {
      return {
        ...base,
        status: 'excluded',
        reason: assessment.reason,
        limitation: assessment.limitation ?? 'excluded by the assessor',
      };
    }
    if (demotedIds.has(candidate.candidate_id)) {
      // A candidate that does not fit the remaining budget is demoted with an
      // explicit reason and limitation — an exhaustive tail, never a silent
      // cut.
      return {
        ...base,
        status: 'excluded',
        reason: 'presentation-budget-exceeded',
        limitation: demotionDetails.get(candidate.candidate_id) ?? `limit=${limit}`,
      };
    }
    manifestIncluded.push({ path: candidate.path, sha256: candidate.sha256, bytes: candidate.bytes });
    return { ...base, status: 'included', reason: assessment.reason, limitation: assessment.limitation };
  });
  for (const record of records) {
    if (record.status === 'excluded') {
      manifestExcluded.push({ path: record.path, sha256: record.sha256, bytes: record.bytes });
    }
  }
  // Conflict refs metadata (pointers, not content) is the last budget
  // consumer and ALWAYS counts toward the measured total (review round 4,
  // Devin: a refs-only degradation must not leave `budget.fits: true` while
  // the true projection exceeds the limit). When even the pointers no longer
  // fit, the conflicts STAY in the `conflicts` section — a conflict is never
  // suppressed — and the run honestly reports the degraded projection
  // (`fits: false`, coverage partial, `complete: false`, needs_review).
  estimated += conflictRefsBytes;
  const conflictFits = estimated <= limit;
  if (!conflictFits) diagnostics.push({ code: 'conflict-evidence-refs-only', path: null, detail: `refsBytes=${conflictRefsBytes} estimated=${estimated} limit=${limit}` });
  const fits = estimated <= limit;
  const hasDemotions = demoted > 0;
  return { records, manifestIncluded, manifestExcluded, estimated, fits, demoted, hasDemotions, conflictFits, diagnostics };
}

export function assertOverlayInvariants(observation) {
  if (!observation || typeof observation !== 'object') throw new TypeError('missing observation');
  const candidates = observation.candidates;
  if (!Array.isArray(candidates)) throw new TypeError('missing candidates');
  if (observation.run_status !== 'complete' && observation.run_status !== 'failed' && observation.run_status !== 'not_run') {
    throw new TypeError('invalid run_status');
  }
  // A run that is not complete can never present assessments: the honest
  // state for every candidate is `unassessed`. (A partial success keeps
  // `run_status: 'complete'` with `complete: false` — assessed candidates
  // survive there; the run level carries the degradation.)
  if (observation.run_status !== 'complete') {
    for (const candidate of candidates) {
      if (candidate?.status !== 'unassessed') throw new TypeError('incomplete run must leave every candidate unassessed');
    }
  }
  // AND completeness (decision D7, lekalo model): `complete` is true only
  // for the full-success path — assessment complete, budget fitting without
  // demotions, full coverage, fresh probe, and an actual selection made.
  const excludedRecords = candidates.filter((candidate) => candidate.status === 'excluded');
  const demotedRecords = excludedRecords.filter((candidate) => candidate.reason === 'presentation-budget-exceeded');
  const andComplete = observation.run_status === 'complete'
    && observation.budget?.fits === true
    && demotedRecords.length === 0
    && observation.coverage?.state === 'full'
    && observation.freshness === 'current'
    && observation.abstained !== true;
  if (observation.complete !== andComplete) throw new TypeError('complete flag disagrees with the AND model');
  if (observation.abstained === true && observation.complete !== false) {
    throw new TypeError('an abstention is not a completed selection');
  }
  if (observation.abstained === true && (observation.coverage?.state !== 'none' || candidates.some((candidate) => candidate.status !== 'unassessed'))) {
    throw new TypeError('abstained run stays selection-free with none coverage');
  }
  if (observation.budget?.fits === false && observation.complete === true) {
    // The AND model refuses completeness on a non-fitting budget (review
    // round 4, Devin: `fits` states the true measured total — the refs-only
    // conflict degradation legitimately reports `fits: false` on a
    // `run_status: 'complete'` partial success whose `complete` is false).
    throw new TypeError('a non-fitting budget can never complete');
  }
  const byId = new Map(candidates.map((candidate) => [candidate.candidate_id, candidate]));
  if (byId.size !== candidates.length) throw new TypeError('duplicate candidate_id');
  for (const candidate of candidates) {
    if (candidate.status === 'conflicting') {
      if (!Array.isArray(candidate.evidence_refs) || candidate.evidence_refs.length === 0) {
        throw new TypeError('conflicting candidate requires non-empty exact refs');
      }
      if (!candidate.conflict || typeof candidate.conflict !== 'object'
        || !Array.isArray(candidate.conflict.refs) || candidate.conflict.refs.length === 0) {
        throw new TypeError('conflicting candidate requires non-empty conflict refs');
      }
      // v1 writes only `suspected` (decision D6): a recorded
      // `owner_confirmed` is schema-valid tampering, never an engine output.
      if (candidate.conflict.state !== 'suspected') throw new TypeError('the engine only records suspected conflicts');
    } else if (candidate.conflict !== null) {
      // A non-conflicting candidate carries no conflict object: a recorded
      // conflict on an included/excluded/unassessed candidate is projection
      // tampering, never an engine output (review R1 low grab-bag).
      throw new TypeError('only a conflicting candidate may carry a conflict');
    }
    if (candidate.status === 'excluded'
      && !(typeof candidate.reason === 'string' && candidate.reason.length > 0
        && typeof candidate.limitation === 'string' && candidate.limitation.length > 0)) {
      throw new TypeError('excluded candidate requires a reason and a limitation');
    }
    if (candidate.status === 'unassessed' && candidate.scores !== null) {
      throw new TypeError('unassessed candidate cannot carry scores');
    }
    if (candidate.status === 'included' && (candidate.sha256 === null || candidate.kind !== 'file')) {
      throw new TypeError('included candidate must pin verified file bytes');
    }
  }
  const presentation = observation.presentation;
  if (!Array.isArray(presentation) || presentation.length > MAX_PRESENTATION_SECTIONS) throw new TypeError('invalid presentation');
  const sectionNames = new Set();
  const seenRefs = new Set();
  for (const section of presentation) {
    if (!PRESENTATION_SECTIONS.includes(section?.section)) throw new TypeError('invalid presentation section');
    if (sectionNames.has(section.section)) throw new TypeError('duplicate presentation section');
    sectionNames.add(section.section);
    for (const ref of section.refs ?? []) {
      if (typeof ref !== 'string') throw new TypeError('presentation ref must be a string');
      if (seenRefs.has(ref)) throw new TypeError(`candidate appears in more than one presentation section: ${ref}`);
      seenRefs.add(ref);
    }
  }
  for (const candidate of candidates) {
    const expected = candidate.status === 'included' ? 'relevant'
      : candidate.status === 'conflicting' ? 'conflicts' : 'unresolved';
    const holder = presentation.find((section) => section.section === expected);
    if (!holder || !holder.refs.includes(candidate.candidate_id)) {
      throw new TypeError(`candidate ${candidate.candidate_id} is missing from its ${expected} section`);
    }
  }
  // Every presentation ref resolves to a known candidate (protected_minimum
  // resolves against the baseline manifest instead).
  const protectedPaths = new Set((observation.manifest?.protected_minimum ?? []).map((entry) => entry?.path));
  for (const section of presentation) {
    for (const ref of section.refs ?? []) {
      if (section.section === 'protected_minimum' ? !protectedPaths.has(ref) : !byId.has(ref)) {
        throw new TypeError(`presentation ref does not resolve: ${ref}`);
      }
    }
  }
  const minimumSection = presentation.find((section) => section.section === 'protected_minimum');
  const expectedPaths = (observation.manifest?.protected_minimum ?? []).map((entry) => entry.path);
  if (!minimumSection || minimumSection.refs.join('|') !== expectedPaths.join('|')) {
    throw new TypeError('protected_minimum section must reference the verbatim baseline manifest');
  }
  // Consistency layer (review F08, #283 precedent): the manifest projection
  // must mirror the candidate records exactly. A manifest edited without its
  // candidates (or vice versa) is tampering, never an engine output; the
  // byte-level equality of the sorted pin triples catches consistent
  // substitution of verify-level pins.
  const manifest = observation.manifest;
  if (manifest === undefined || manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    if (candidates.some((candidate) => candidate.status === 'included' || candidate.status === 'excluded')) {
      throw new TypeError('missing manifest projection for assessed candidates');
    }
  } else {
    const pinKey = (pin) => `${pin?.path ?? ''}\u0000${pin?.sha256 ?? ''}\u0000${String(pin?.bytes ?? 0)}`;
    const recordedIncluded = [...(Array.isArray(manifest.included) ? manifest.included : [])].map(pinKey).sort();
    const expectedIncluded = candidates.filter((candidate) => candidate.status === 'included').map(pinKey).sort();
    if (recordedIncluded.join('|') !== expectedIncluded.join('|')) {
      throw new TypeError('manifest.included must mirror the included candidates exactly');
    }
    const recordedExcluded = [...(Array.isArray(manifest.excluded) ? manifest.excluded : [])].map(pinKey).sort();
    const expectedExcluded = candidates.filter((candidate) => candidate.status === 'excluded').map(pinKey).sort();
    if (recordedExcluded.join('|') !== expectedExcluded.join('|')) {
      throw new TypeError('manifest.excluded must mirror the excluded candidates exactly');
    }
  }
}

// ---------------------------------------------------------------------------
// Worktree identity, module revisions, composite binding (decision D9). The
// baseline components are copied through from the stored brief verbatim —
// the overlay never recomputes the compiler's digests. `capsule.digest` is
// honestly `null` in v1: the stored payload carries no capsule digest and
// the runtime Lekalo digest is unreachable for this offline module.
// ---------------------------------------------------------------------------

export async function computeWorktreeIdentity(rootDir, options = {}) {
  const stat = options.lstatEntry ?? lstat;
  const info = await stat(rootDir, { bigint: true });
  if (!info.isDirectory() || info.ino <= 0n) throw new Error('unsupported-file-identity');
  return digest({ root: String(rootDir), device: String(info.dev), inode: String(info.ino) });
}

async function moduleSha256(relativeUrl, options) {
  const reader = options.readEngine ?? ((url) => readFile(url));
  return digest(await reader(relativeUrl));
}

export function candidateDigestRecords(candidates) {
  const records = candidates.map((candidate) => ({
    path: candidate.path,
    sha256: candidate.sha256 ?? null,
    bytes: candidate.bytes ?? 0,
  }));
  records.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return records;
}

export function baselineBindingComponents(brief) {
  return {
    digest: brief.digest,
    source_revision: brief.source_revision,
    policy_revision: brief.policy_revision,
    scope_fingerprint: brief.scope_fingerprint,
    plan_context_source_revision: brief.plan_context?.source_revision ?? null,
    instruction_composition_digest: brief.instruction_composition_digest ?? null,
    capsule: { digest: null },
  };
}

export function contextSelectionBindingObject({
  worktreeIdentity, changeId, baseline, candidateDigests, candidatePayloadDigest,
  rubric, exclusionPolicy, presentationPolicy, engine, helper, contract, languageOptions, assessmentLimits, budgetPolicy,
}) {
  return {
    consumer: CONTEXT_SELECTION_CONSUMER_ID,
    worktree_identity: worktreeIdentity,
    change_id: changeId,
    baseline,
    candidate_digests: candidateDigests,
    candidate_payload_digest: candidatePayloadDigest,
    rubric,
    exclusion_policy: exclusionPolicy,
    presentation_policy: presentationPolicy,
    engine,
    helper,
    contract,
    language_options: languageOptions,
    assessment_limits: assessmentLimits,
    budget_policy: budgetPolicy,
  };
}

export async function currentOverlayContext(options = {}) {
  const contractSha = await moduleSha256(new URL(`../${CONTRACT_MODULE}`, import.meta.url), options);
  const engineSha = await moduleSha256(new URL(`../${ENGINE_MODULE}`, import.meta.url), options);
  const helperSha = await moduleSha256(new URL(`../${HELPER_MODULE}`, import.meta.url), options);
  return {
    rubric: { ...CONTEXT_SELECTION_RUBRIC },
    exclusionPolicy: { ...EXCLUSION_POLICY },
    presentationPolicy: { ...PRESENTATION_POLICY },
    engine: { module: ENGINE_MODULE, sha256: engineSha },
    helper: { module: HELPER_MODULE, sha256: helperSha },
    contract: { name: CONTEXT_SELECTION_SCHEMA, sha256: contractSha },
    assessmentLimits: { ...ASSESSMENT_LIMITS },
    budgetPolicy: { ...BUDGET_POLICY },
  };
}

// ---------------------------------------------------------------------------
// Read-time revalidation: any divergence between the recorded composite
// binding and the current worktree/candidates/baseline/policy state names
// the drifted fields and marks the observation stale (mirror of the #283
// producer's per-field revalidation).
// ---------------------------------------------------------------------------

export async function validateSelectionBinding(rootDir, observation, options = {}) {
  if (!observation || typeof observation !== 'object' || observation.schema !== CONTEXT_SELECTION_SCHEMA
    || typeof observation.change_id !== 'string' || typeof observation.binding !== 'string') {
    return { ok: false, code: 'observation-invalid' };
  }
  if (!CHANGE_ID_FORM.test(observation.change_id)) return { ok: false, code: 'observation-invalid' };
  let schema;
  try {
    schema = parseStrictJson(await readFile(new URL(`../${CONTRACT_MODULE}`, import.meta.url), 'utf8'));
  } catch {
    return { ok: false, code: 'root-unreadable' };
  }
  if (validateJsonAgainstSchema(observation, schema).length > 0) {
    return { ok: false, code: 'observation-invalid' };
  }
  try {
    assertOverlayInvariants(observation);
  } catch {
    return { ok: false, code: 'observation-invalid' };
  }
  let root;
  try {
    root = await realpath(options.rootDir ?? rootDir);
  } catch {
    return { ok: false, code: 'root-unreadable' };
  }
  let worktreeIdentity;
  try {
    worktreeIdentity = await computeWorktreeIdentity(root, options);
  } catch {
    return { ok: false, code: 'unsupported-file-identity' };
  }
  const mismatched = [];
  if (worktreeIdentity !== observation.worktree_identity) mismatched.push('worktree_identity');
  // Recorded candidate pins are rebuilt from CURRENT disk bytes, never from
  // the recorded observation: an edited, renamed, or vanished candidate must
  // name its field and flip the recomputed binding. Kind transitions are
  // compared per recorded candidate record as well (review round 4, Devin):
  // a missing candidate that BECAME oversized truncates to the same null
  // digest and zero bytes, so only the kind flip exposes the drift.
  const reader = options.readCandidate ?? (async (dir, rel) => readProviderFile(dir, rel, CANDIDATE_READ_LIMIT));
  const recorded = Array.isArray(observation.candidate_digests) ? observation.candidate_digests : [];
  for (const pin of recorded) {
    let bytes = null;
    let error = null;
    try { bytes = await reader(root, pin.path, CANDIDATE_READ_LIMIT); } catch (readError) { error = readError; }
    const fresh = await classifyCandidateInput(root, pin.path, bytes, error);
    if ((pin.sha256 ?? null) !== fresh.sha256 || (pin.bytes ?? 0) !== fresh.bytes) {
      mismatched.push(`candidate_digests:${pin.path}`);
    }
  }
  const recordedRecords = Array.isArray(observation.candidates) ? observation.candidates : [];
  for (const record of recordedRecords) {
    if (!record || typeof record.path !== 'string') continue;
    let bytes = null;
    let error = null;
    try { bytes = await reader(root, record.path, CANDIDATE_READ_LIMIT); } catch (readError) { error = readError; }
    const fresh = await classifyCandidateInput(root, record.path, bytes, error);
    if (fresh.kind !== record.kind) {
      mismatched.push(`candidates:${record.path}`);
    }
  }
  // The baseline is re-inspected through the same read-only API; a stale,
  // missing, or blocked brief means the recorded projection no longer has a
  // current baseline and every baseline component is named.
  let inspection = null;
  try {
    const inspect = options.inspectBrief ?? inspectSessionBrief;
    inspection = await inspect({ changeId: observation.change_id, rootDir: root, includeBrief: true, ...options.inspectOptions });
  } catch {
    inspection = null;
  }
  const recordedBaseline = observation.baseline ?? {};
  if (!inspection || inspection.status !== 'valid' || !inspection.brief) {
    mismatched.push('baseline:status');
  } else {
    const freshBaseline = baselineBindingComponents(inspection.brief);
    for (const [field, value] of Object.entries(freshBaseline)) {
      if (JSON.stringify(recordedBaseline[field] ?? null) !== JSON.stringify(value ?? null)) {
        mismatched.push(`baseline:${field}`);
      }
    }
    // The recorded protected minimum is a baseline projection, not an
    // assessor output: it is compared against the CURRENT baseline manifest
    // verbatim, so a consistent truncation or substitution of the recorded
    // manifest can never pass as fresh (review F02 — the engine invariant
    // only compares the section against the recorded manifest itself).
    const recordedMinimum = Array.isArray(observation.manifest?.protected_minimum) ? observation.manifest.protected_minimum : [];
    const freshMinimum = (Array.isArray(inspection.brief.context_manifest) ? inspection.brief.context_manifest : [])
      .map((entry) => ({ path: entry?.path, sha256: entry?.sha256, fidelity: entry?.fidelity }));
    if (JSON.stringify(recordedMinimum) !== JSON.stringify(freshMinimum)) {
      mismatched.push('baseline:protected_minimum');
    }
  }
  let context;
  try {
    context = await currentOverlayContext(options);
  } catch {
    return { ok: false, code: 'root-unreadable' };
  }
  const recordedEngine = observation.engine ?? {};
  if ((recordedEngine.module ?? null) !== context.engine.module
    || (recordedEngine.sha256 ?? null) !== context.engine.sha256) mismatched.push('engine');
  const recordedHelper = observation.helper ?? {};
  if ((recordedHelper.module ?? null) !== context.helper.module
    || (recordedHelper.sha256 ?? null) !== context.helper.sha256) mismatched.push('helper');
  const recordedContract = observation.contract ?? {};
  if ((recordedContract.name ?? null) !== context.contract.name
    || (recordedContract.sha256 ?? null) !== context.contract.sha256) mismatched.push('contract');
  const recordedRubric = observation.rubric ?? {};
  if ((recordedRubric.id ?? null) !== context.rubric.id
    || (recordedRubric.version ?? null) !== context.rubric.version) mismatched.push('rubric');
  const recordedExclusion = observation.exclusion_policy ?? {};
  if ((recordedExclusion.id ?? null) !== context.exclusionPolicy.id
    || (recordedExclusion.version ?? null) !== context.exclusionPolicy.version) mismatched.push('exclusion_policy');
  const recordedPresentation = observation.presentation_policy ?? {};
  if ((recordedPresentation.id ?? null) !== context.presentationPolicy.id
    || (recordedPresentation.version ?? null) !== context.presentationPolicy.version) mismatched.push('presentation_policy');
  // The engine never emits a language override; a recorded override is
  // schema-valid tampering, not a state this engine can revalidate.
  if (observation.language_options?.override !== null) return { ok: false, code: 'observation-invalid' };
  const payloadDigest = assessmentDigest(Array.isArray(observation.candidates) ? observation.candidates : []);
  const binding = buildAssessmentBinding(contextSelectionBindingObject({
    worktreeIdentity,
    changeId: observation.change_id,
    baseline: recordedBaseline,
    candidateDigests: recorded,
    candidatePayloadDigest: payloadDigest,
    rubric: context.rubric,
    exclusionPolicy: context.exclusionPolicy,
    presentationPolicy: context.presentationPolicy,
    engine: context.engine,
    helper: context.helper,
    contract: context.contract,
    languageOptions: { override: null, resolved: observation.language ?? 'unknown' },
    assessmentLimits: context.assessmentLimits,
    budgetPolicy: context.budgetPolicy,
  }));
  if (binding !== observation.binding) {
    // Everything else matches: the only remaining binding input is the
    // recorded candidate payload (statuses, scores, refs), so a flipped
    // binding names the edited projection instead of a generic field.
    if (mismatched.length === 0) mismatched.push('candidate_payload');
    mismatched.push('binding');
  }
  return { ok: true, stale: mismatched.length > 0, mismatched: [...new Set(mismatched)], state: mismatched.length > 0 ? 'stale-observation' : null };
}

// ---------------------------------------------------------------------------
// Observation writer (state-only; guards fail closed before the first write;
// custom state roots refused — owner-approved narrowing, decision D16).
// ---------------------------------------------------------------------------

function withinCi(prefix, value) {
  return value.toLowerCase().startsWith(prefix.toLowerCase());
}

function canonicalizeConfigRoot(value) {
  const normalized = normalizeConfigPath(value);
  if (!normalized) return null;
  if (/^[A-Za-z]:/.test(normalized) || normalized.startsWith('/')) return null;
  const canonical = path.posix.normalize(normalized);
  if (!canonical || canonical === '.' || canonical === '..' || canonical.startsWith('../')) return null;
  return canonical;
}

export async function writeOverlayObservation(rootDir, observation, config, options = {}) {
  if (typeof observation.change_id !== 'string' || !CHANGE_ID_FORM.test(observation.change_id)) {
    return { ok: false, code: 'invalid-change-id' };
  }
  // Custom state roots are refused (owner-approved narrowing): the QA
  // projection covers only the default state root, so an observation under a
  // custom root would silently change required QA surfaces.
  const rawState = config.stateRootRaw;
  const stateRoot = normalizeConfigPath(rawState === undefined ? config.stateRoot : rawState);
  if (stateRoot === null) return { ok: false, code: 'state-root-mismatch', detail: String(rawState) };
  if (stateRoot !== STATE_ROOT) return { ok: false, code: 'state-root-mismatch', detail: stateRoot };
  const paths = contextSelectionPaths(observation.change_id);
  const relative = paths.observation;
  const rawQa = config.qaRootRaw;
  const qaRoot = canonicalizeConfigRoot(rawQa === undefined ? QA_ROOT : rawQa);
  if (qaRoot === null) return { ok: false, code: 'qa-root-unsafe', detail: String(rawQa ?? QA_ROOT) };
  if (withinCi(`${qaRoot}/`, relative) || relative.toLowerCase() === qaRoot.toLowerCase()) {
    return { ok: false, code: 'qa-namespace-conflict', detail: relative };
  }
  let root;
  try {
    root = await realpath(options.rootDir ?? rootDir);
  } catch (error) {
    return { ok: false, code: 'observation-write-failed', detail: String(error?.message ?? error).slice(0, 200) };
  }
  const parts = relative.split('/');
  // Read-only sources: the observation destination must never equal a
  // presented candidate — the writer would overwrite exactly the material
  // the projection claims to describe.
  const outputLower = relative.toLowerCase();
  const presented = (observation.candidates ?? []).map((candidate) => candidate?.path).filter((value) => typeof value === 'string');
  const sourceCollision = presented.find((candidatePath) => normalizeConfigPath(candidatePath)?.toLowerCase() === outputLower);
  if (sourceCollision) return { ok: false, code: 'observation-source-collision', detail: sourceCollision };
  for (let index = 1; index < parts.length; index += 1) {
    const ancestor = path.join(root, ...parts.slice(0, index));
    let info;
    try { info = await lstat(ancestor); } catch { continue; }
    if (!info.isDirectory()) return { ok: false, code: 'file-shadow', detail: parts.slice(0, index).join('/') };
  }
  const leaf = path.join(root, ...parts);
  const leafConflict = () => ({ ok: false, code: 'observation-leaf-conflict', detail: relative });
  // Leaf ownership: only a previous, fully schema-valid observation of the
  // same change may be replaced; an unreadable previous leaf fails closed.
  let schemaBytes;
  try {
    schemaBytes = await readFile(new URL(`../${CONTRACT_MODULE}`, import.meta.url), 'utf8');
  } catch (error) {
    return { ok: false, code: 'observation-write-failed', detail: String(error?.message ?? error).slice(0, 200) };
  }
  const schema = parseStrictJson(schemaBytes);
  const assertLeafWritable = async () => {
    let leafInfo = null;
    try { leafInfo = await lstat(leaf); } catch { leafInfo = null; }
    if (leafInfo === null) return null;
    if (!leafInfo.isFile()) return leafConflict();
    let previous = null;
    try {
      previous = await readProviderFile(root, relative, 4 * 1024 * 1024);
    } catch {
      return leafConflict();
    }
    if (previous === null) return leafConflict();
    let prior = null;
    try { prior = parseStrictJson(previous.toString('utf8')); } catch { prior = null; }
    if (!prior || prior.schema !== CONTEXT_SELECTION_SCHEMA || prior.change_id !== observation.change_id) return leafConflict();
    if (validateJsonAgainstSchema(prior, schema).length !== 0) return leafConflict();
    return null;
  };
  const firstRejection = await assertLeafWritable();
  if (firstRejection) return firstRejection;
  // QA isolation guard: the writer refuses a tracked or
  // not-effectively-ignored output for EVERY path it may create — the
  // observation, the namespace .gitignore, and the temporary payload
  // (review RG284-002: the temporary name is FIXED before the first guard
  // call so every owned surface is checked before ANY write; a pre-existing
  // `!*.tmp`-style un-ignore rule in a user-managed .gitignore is caught by
  // the guard itself instead of silently trusting ensureRuntimeGitignore,
  // which preserves existing rules rather than replacing them).
  const gitGuard = options.gitGuard ?? verifyObservationIgnored;
  const gitignoreRelative = `${paths.directory}/.gitignore`;
  const tempName = `${parts[parts.length - 1]}.${randomUUID()}.tmp`;
  const temporaryRelative = `${paths.directory}/${tempName}`;
  for (const guarded of [relative, gitignoreRelative, temporaryRelative]) {
    const verdict = await gitGuard(root, guarded, options);
    if (!verdict.ok) return { ok: false, code: verdict.code, detail: verdict.detail ?? null };
  }
  if (!options.skipGitignore) {
    try {
      await ensureRuntimeGitignore(root, paths.directory);
    } catch (error) {
      return { ok: false, code: 'runtime-gitignore-failed', detail: String(error?.message ?? error).slice(0, 200) };
    }
  }
  const directory = path.join(root, ...parts.slice(0, -1));
  try {
    await mkdir(directory, { recursive: true });
  } catch (error) {
    return { ok: false, code: 'observation-write-failed', detail: String(error?.message ?? error).slice(0, 200) };
  }
  // TOCTOU re-check after materialization: the live directory must resolve to
  // the same real path (no symlink/junction swap). The identity comparison is
  // CASE-SENSITIVE and lexically strict (review F01 residual (a)): both
  // values are realpaths, and any divergence — including a differently cased
  // component or a delete-and-recreate by the same name — is refused, never
  // normalized. This is a conservative point-in-time identity check, not an
  // absolute atomicity guarantee.
  const withinRoot = (value) => {
    const relativeLive = path.relative(path.resolve(root), path.resolve(value));
    return relativeLive !== '' && !relativeLive.startsWith('..') && !path.isAbsolute(relativeLive);
  };
  let liveDirectory;
  try {
    liveDirectory = await realpath(directory);
  } catch (error) {
    return { ok: false, code: 'observation-write-failed', detail: String(error?.message ?? error).slice(0, 200) };
  }
  if (path.resolve(liveDirectory) !== path.resolve(directory) || !withinRoot(liveDirectory)) {
    return { ok: false, code: 'file-shadow', detail: parts.slice(0, -1).join('/') };
  }
  const secondRejection = await assertLeafWritable();
  if (secondRejection) return secondRejection;
  // Atomic write owned by this module: after the temporary write and
  // immediately before the rename, BOTH the ancestry and the leaf are
  // re-verified (mirror of trace-link-suggestions custody re-checks): a
  // namespace directory swapped to a symlink/junction between the earlier
  // checks and the rename must not redirect the observation outside the
  // project root (review F01 — the leaf-only check did not close the window).
  // Cleanup ownership (review F01 residual (b) + M2): the temporary file is
  // stat-identified at creation, and a refused run unlinks ONLY the object
  // whose device/inode identity still matches that record — a swap that
  // moved the temp to an unknown location, or an attacker-planted same-named
  // file behind the swapped path, is never unlinked. A temp whose identity
  // cannot be found stays honestly unreclaimed (bounded diagnostic-free
  // bytes inside the attacker-moved directory, never a written observation);
  // the refusal detail names the limit.
  const payload = `${JSON.stringify(observation, null, 2)}\n`;
  // The temporary name was fixed BEFORE the first git-guard call (review
  // RG284-002) so the payload path could be guarded together with the
  // observation and the namespace .gitignore; here it only gets bound to the
  // live directory.
  const temporary = path.join(liveDirectory, tempName);
  const openFile = options.openFile ?? open;
  let renamed = false;
  let swapped = false;
  let liveAfter = null;
  let tempIdentity = null;
  let outcome = null;
  const reclaimTemp = async () => {
    if (tempIdentity === null) return true;
    const candidates = [temporary, ...(swapped && liveAfter ? [path.join(liveAfter, tempName)] : [])];
    for (const candidate of candidates) {
      try {
        const info = await lstat(candidate);
        if (info.isFile() && info.dev === tempIdentity.dev && info.ino === tempIdentity.ino) {
          await unlink(candidate);
          return true;
        }
      } catch {
        // Absent or unreadable at this candidate path: the next candidate
        // (or the honest unreclaimed note) handles it.
      }
    }
    return false;
  };
  try {
    const handle = await openFile(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(payload, 'utf8');
    } finally {
      await handle.close();
    }
    try {
      const info = await lstat(temporary);
      tempIdentity = { dev: info.dev, ino: info.ino };
    } catch {
      // An unstatable temp cannot be written or renamed anyway; the write
      // failure below carries the cause.
      tempIdentity = null;
    }
    if (typeof options.beforeRename === 'function') await options.beforeRename();
    try {
      liveAfter = await realpath(directory);
    } catch (error) {
      liveAfter = null;
      outcome = { ok: false, code: 'observation-write-failed', detail: String(error?.message ?? error).slice(0, 200) };
      return outcome;
    }
    if (path.resolve(liveAfter) !== path.resolve(liveDirectory) || !withinRoot(liveAfter)) {
      swapped = true;
      outcome = { ok: false, code: 'file-shadow', detail: parts.slice(0, -1).join('/') };
      return outcome;
    }
    const thirdRejection = await assertLeafWritable();
    if (thirdRejection) {
      outcome = thirdRejection;
      return outcome;
    }
    await rename(temporary, leaf);
    renamed = true;
    outcome = { ok: true, path: relative };
    return outcome;
  } catch (error) {
    outcome = { ok: false, code: 'observation-write-failed', detail: String(error?.message ?? error).slice(0, 200) };
    return outcome;
  } finally {
    if (!renamed) {
      const reclaimed = await reclaimTemp();
      // The refusal names its own cleanup limit: a swapped-away temp whose
      // identity no longer resolves at any known path is NOT chased (an
      // unlink of an unverified object would break the state-only mutation
      // boundary) — the bounded bytes stay in the attacker-moved directory.
      if (!reclaimed && outcome && outcome.ok === false && swapped) {
        const note = `${outcome.detail ?? ''}; temporary payload could not be reclaimed after the namespace swap`.slice(0, 200);
        outcome.detail = note;
      }
    }
  }
  return outcome;
}

// ---------------------------------------------------------------------------
// Observation assembly (decision D12: presentation order is carried by the
// section list, never by JSON property order).
// ---------------------------------------------------------------------------

export function assembleObservation({
  changeId, generatedAt, runStatus, complete, freshness, abstained, needsReview, ownerHandoff,
  coverage, budget, manifest, candidates, presentation, baseline, candidateDigests,
  context, language, worktreeIdentity, binding, diagnostics,
}) {
  return {
    schema: CONTEXT_SELECTION_SCHEMA,
    change_id: changeId,
    generated_at: generatedAt,
    diagnostic_only: true,
    authorizes: [],
    language: language === 'ru' ? 'ru' : (language === 'en' ? 'en' : 'unknown'),
    language_options: { override: null },
    run_status: runStatus,
    complete,
    freshness,
    abstained,
    needs_review: needsReview,
    owner_handoff: ownerHandoff,
    coverage,
    budget: { ...budget, token_estimate: null },
    manifest,
    candidates,
    presentation,
    baseline,
    candidate_digests: candidateDigests,
    rubric: { ...context.rubric },
    exclusion_policy: { ...context.exclusionPolicy },
    presentation_policy: { ...context.presentationPolicy },
    engine: context.engine,
    helper: context.helper,
    contract: context.contract,
    worktree_identity: worktreeIdentity,
    binding,
    diagnostics,
  };
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

function notRunEnvelope(codes) {
  return {
    schema_version: 1,
    diagnostic_only: true,
    state: 'not_run',
    codes,
    message: NOT_RUN_MESSAGE,
    usage,
    authorizes: [],
  };
}

// A failure envelope is not a not_run: the message names what actually
// happened instead of the generic "advisory scan was not performed" (review
// R1 low — observation-not-saved and operational failures DID run).
const FAILURE_MESSAGES = Object.freeze({
  'observation-not-saved': 'advisory observation was not saved',
  'operational-failure': 'advisory scan failed: no gate evidence was produced',
});

function failureEnvelope(state, codes) {
  return { schema_version: 1, diagnostic_only: true, state, codes, message: FAILURE_MESSAGES[state] ?? NOT_RUN_MESSAGE, usage, authorizes: [] };
}

function renderHuman(value) {
  if (!value || typeof value !== 'object') return String(value);
  if (value.schema_version === 1) {
    const lines = [`Context selection overlay (advisory): ${value.state}`];
    for (const code of value.codes ?? []) lines.push(`  diagnostic: ${code}`);
    if (value.message) lines.push(value.message);
    lines.push(`Usage: ${value.usage ?? usage}`);
    return lines.join('\n');
  }
  const lines = [
    `Context selection overlay (advisory, no gate evidence): change ${value.change_id}`,
    `Run: ${value.run_status}${value.abstained ? ' (abstained)' : ''}; freshness: ${value.freshness}; coverage: ${value.coverage?.state}; budget fits: ${value.budget?.fits}`,
    `Candidates: ${value.candidates?.length ?? 0} (included: ${(value.presentation ?? []).find((section) => section.section === 'relevant')?.refs.length ?? 0},`
    + ` conflicting: ${(value.presentation ?? []).find((section) => section.section === 'conflicts')?.refs.length ?? 0},`
    + ` unresolved: ${(value.presentation ?? []).find((section) => section.section === 'unresolved')?.refs.length ?? 0})`,
  ];
  if (value.needs_review) lines.push(`Conflicts need review — handoff: ${value.owner_handoff}`);
  if (value.run_status !== 'complete' || value.freshness !== 'current' || value.coverage?.state !== 'full') {
    lines.push('Degraded outcome — this is NOT a zero-findings result.');
  }
  for (const diagnostic of value.diagnostics ?? []) {
    lines.push(`  diagnostic: ${diagnostic.code}${diagnostic.path ? ` (${diagnostic.path})` : ''}${diagnostic.detail ? ` — ${diagnostic.detail}` : ''}`);
  }
  lines.push('The overlay never replaces the baseline SessionBrief, never executes compact_supporting_context, and never authorizes progression.');
  return lines.join('\n');
}

function baselineRefusalCode(status, inspection) {
  if (status === 'disabled') return { code: 'baseline-disabled', detail: null };
  if (status === 'delegated') return { code: 'baseline-delegated', detail: String(inspection?.owner_handoff ?? '').slice(0, 200) || null };
  if (status === 'missing') return { code: 'baseline-missing', detail: (inspection?.stale_reasons ?? []).join(',').slice(0, 200) || null };
  if (status === 'stale') return { code: 'baseline-stale', detail: (inspection?.stale_reasons ?? []).join(',').slice(0, 200) || null };
  return {
    code: 'baseline-blocked',
    detail: [...(inspection?.blocked_reasons ?? []), ...(inspection?.errors ?? []).map((error) => error?.code)].filter(Boolean).join(',').slice(0, 200) || null,
  };
}

export async function runContextSelectionOverlayCommand(argv = process.argv.slice(2), options = {}) {
  const output = options.output ?? ((value) => process.stdout.write(value));
  const emit = (value, json) => output(json ? `${JSON.stringify(value, null, 2)}\n` : `${renderHuman(value)}\n`);
  const now = options.now ?? Date.now;
  const startedAt = now();

  const parsed = parseOverlayArgs(argv);
  // A malformed argument list must still honor an explicit `--json` request
  // regardless of where the flag sat relative to the offending argument.
  if (!parsed.ok) {
    emit(notRunEnvelope(['invalid-usage', parsed.error]), parsed.json === true || argv.includes('--json'));
    return 2;
  }
  // Explicit change-id validation happens before ANY read (custody-first,
  // same as the #283 producer): a malformed id is a typed exit-2 refusal,
  // never a silent "advisory scan was not performed".
  if (typeof parsed.changeId !== 'string') {
    emit(notRunEnvelope(['missing-change']), parsed.json);
    return 2;
  }
  if (!CHANGE_ID_FORM.test(parsed.changeId)) {
    emit(notRunEnvelope(['invalid-change-id']), parsed.json);
    return 2;
  }
  const changeId = parsed.changeId;
  let rootDir;
  try {
    rootDir = await realpath(options.rootDir ?? process.cwd());
  } catch {
    process.stderr.write('context-selection-overlay: project root is unreadable\n');
    return 1;
  }
  const config = options.config ?? await readContextSelectionOverlayConfig(rootDir, options);
  const cliEnabled = parsed.enabled;
  const enabled = config.enabledMalformed ? false : (cliEnabled ?? config.enabled);
  const configCodes = (config.diagnostics ?? [])
    .filter((diagnostic) => String(diagnostic.code).startsWith('context-selection-overlay:')
      || diagnostic.code === 'config-unreadable' || diagnostic.code === 'config-malformed')
    .map((diagnostic) => diagnostic.code);
  if (enabled !== true) {
    const codes = configCodes.length > 0
      ? ['context-selection-overlay-disabled', ...configCodes.slice(0, 11)]
      : ['context-selection-overlay-disabled'];
    emit(notRunEnvelope(codes), parsed.json);
    return 0;
  }
  if (parsed.candidatePaths.length > MAX_CANDIDATES) {
    emit(notRunEnvelope(['candidates-limit-exceeded']), parsed.json);
    return 2;
  }
  for (const candidatePath of parsed.candidatePaths) {
    if (!validateFileForm(candidatePath)) {
      emit(notRunEnvelope([`invalid-candidate-input:${String(candidatePath).slice(0, 200)}`]), parsed.json);
      return 2;
    }
  }
  // Case-insensitive collisions between DISTINCT presented paths are refused
  // before any read (review R1 low): on case-insensitive filesystems two such
  // paths are the same file, on case-sensitive ones they are two files — no
  // single intake decision is honest across both, so the presentation is
  // typed and the owner presents one spelling. EXACT duplicates are not a
  // collision (review R2-N2): they keep the documented dedup behavior — the
  // intake below assesses them once with a `duplicate-candidate` diagnostic.
  const exactSeen = new Set();
  const distinctPaths = [];
  for (const candidatePath of parsed.candidatePaths) {
    if (exactSeen.has(candidatePath)) continue;
    exactSeen.add(candidatePath);
    distinctPaths.push(candidatePath);
  }
  const lowerSeen = new Map();
  for (const candidatePath of distinctPaths) {
    const key = candidatePath.toLowerCase();
    if (lowerSeen.has(key)) {
      emit(notRunEnvelope([`candidate-path-case-collision:${lowerSeen.get(key)}|${candidatePath}`.slice(0, 200)]), parsed.json);
      return 2;
    }
    lowerSeen.set(key, candidatePath);
  }
  const deadlineExceeded = () => (now() - startedAt) >= (options.deadlineMs ?? DEFAULT_DEADLINE_MS);
  try {
    const diagnostics = [...(config.diagnostics ?? [])];
    // Read-only baseline access (decision D11): inspect-only; the compiler
    // and its write paths are never called. Every non-`valid` status is an
    // honest not_run with a bounded cause — the baseline is never presented
    // as "assessed" when it is disabled, delegated, blocked, missing, or
    // stale.
    let inspection = null;
    try {
      const inspect = options.inspectBrief ?? inspectSessionBrief;
      inspection = await inspect({ changeId, rootDir, includeBrief: true, ...options.inspectOptions });
    } catch (error) {
      inspection = { ok: false, status: 'blocked', errors: [{ code: String(error?.message ?? error).slice(0, 80) }], stale_reasons: [], blocked_reasons: [] };
    }
    if (!inspection || inspection.status !== 'valid' || !inspection.brief) {
      // `missing` and `stale` are inspect outcomes with ok:false — they carry
      // their own honest codes; only a `blocked`/failure result or a missing
      // inspection object is reported as blocked.
      const refusal = inspection && ['disabled', 'delegated', 'missing', 'stale'].includes(inspection.status)
        ? baselineRefusalCode(inspection.status, inspection)
        : {
          code: 'baseline-blocked',
          detail: [...(inspection?.blocked_reasons ?? []), ...(inspection?.errors ?? []).map((entry) => entry?.code)].filter(Boolean).join(',').slice(0, 200) || null,
        };
      emit(notRunEnvelope([refusal.code, ...(refusal.detail ? [`baseline-detail:${refusal.detail}`] : [])]), parsed.json);
      return 0;
    }
    const brief = inspection.brief;
    if (deadlineExceeded()) {
      emit(notRunEnvelope(['deadline-exceeded']), parsed.json);
      return 0;
    }
    // Candidate intake: the allowlist was fixed from the presented inputs
    // before any read (validated above); each path is read bounded exactly
    // once. Text inside a candidate is data — nothing it names is read.
    const candidates = await readCandidates(rootDir, parsed.candidatePaths, diagnostics, options);
    const missingSources = [];
    for (const candidate of candidates) {
      if (candidate.kind !== 'file') missingSources.push({ path: candidate.path, reason: candidate.reason ?? 'unreadable' });
    }
    // Protected minimum (decision 2-A): the entire baseline manifest
    // verbatim with measured bytes joined from the brief sources.
    const protectedBuild = buildProtectedMinimum(brief, diagnostics);
    missingSources.push(...protectedBuild.missing);
    let missingCapped = false;
    if (missingSources.length > MAX_MISSING) {
      missingSources.length = MAX_MISSING;
      missingCapped = true;
      diagnostics.push({ code: 'missing-sources-truncated', path: null, detail: `limit=${MAX_MISSING}` });
    }
    const coverage = {
      state: 'full',
      declared_sources: candidates.length + protectedBuild.protected_minimum.length,
      scanned_sources: candidates.filter((candidate) => candidate.kind === 'file').length + protectedBuild.protected_minimum.length - protectedBuild.missing.length,
      missing_sources: missingSources,
    };
    if (missingCapped) coverage.state = 'partial';
    if (missingSources.length > 0) coverage.state = 'partial';
    if (protectedBuild.protected_minimum.length === 0 && candidates.length === 0) coverage.state = 'none';
    const budget = {
      strategy: 'measured',
      estimated: protectedBuild.minimumRequired,
      minimum_required: protectedBuild.minimumRequired,
      limit: MAX_PRESENTATION_BYTES,
      fits: true,
    };
    // Budget is fail-closed (decision D7): a protected minimum that does not
    // fit — or whose bytes cannot be verified — fails the run before any
    // assessment. There is never a silent truncation of the baseline.
    const oversize = protectedBuild.minimumRequired > MAX_PRESENTATION_BYTES;
    const unsupported = !protectedBuild.supported;
    if (oversize) diagnostics.push({ code: 'protected-minimum-oversize', path: null, detail: `minimumRequired=${protectedBuild.minimumRequired} limit=${MAX_PRESENTATION_BYTES}` });
    if (unsupported) diagnostics.push({ code: 'protected-minimum-unsupported', path: null, detail: `entries=${protectedBuild.protected_minimum.length} limit=${MAX_PROTECTED_ENTRIES}` });
    const budgetBlocked = oversize || unsupported || protectedBuild.missing.length > 0;
    if (deadlineExceeded()) {
      emit(notRunEnvelope(['deadline-exceeded']), parsed.json);
      return 0;
    }
    // The semantic stage is opt-in-DI only: without an injected assessor the
    // outcome is an honest not_run envelope — the baseline is valid and
    // readable, but no selection was performed, and a "protected minimum
    // only" projection must not masquerade as a selection result.
    if (typeof options.assessor !== 'function') {
      emit(notRunEnvelope(['assessor-unavailable']), parsed.json);
      return 0;
    }
    let freshness = 'current';
    let abstained = false;
    let runStatus = 'complete';
    let complete = false;
    let records = [];
    let manifestIncluded = [];
    let manifestExcluded = [];
    let needsReview = false;
    let ownerHandoff = null;
    const worktreeIdentity = await computeWorktreeIdentity(rootDir, options);
    const languageDocs = candidates.filter((candidate) => candidate.kind === 'file' && candidate.text.length > 0).map((candidate) => ({ text: candidate.text }));
    const prose = resolveProseLanguage(languageDocs, null);
    const resolvedLanguage = languageDocs.length > 0 ? prose.language : 'unknown';

    // Freshness probe (decision D9): re-hash the candidates and re-inspect
    // the brief. A drifted candidate, a recomputed baseline, or a moved
    // worktree marks the outcome stale — the conservative honest direction.
    // The probe is defined for EVERY collected outcome, not only the
    // semantic path: the budget-blocked branch below runs it explicitly,
    // because its failed projection still pins the baseline verbatim and
    // must never declare `current` without re-confirmation (review
    // RG284-001). The same DI seams as intake and read-time revalidation are
    // used, so a test-injected reader/inspector cannot create a probe that
    // sees a different world than the run (review F10).
    const freshProbe = async () => {
      const reader = options.readCandidate ?? ((dir, rel) => readProviderFile(dir, rel, CANDIDATE_READ_LIMIT));
      const inspect = options.inspectBrief ?? inspectSessionBrief;
      for (const candidate of candidates) {
        let bytes = null;
        let error = null;
        try { bytes = await reader(rootDir, candidate.path, CANDIDATE_READ_LIMIT); } catch (readError) { error = readError; }
        const fresh = await classifyCandidateInput(rootDir, candidate.path, bytes, error);
        if (fresh.kind !== candidate.kind || fresh.sha256 !== candidate.sha256 || fresh.bytes !== candidate.bytes) return true;
      }
      try {
        const freshInspection = await inspect({ changeId, rootDir, includeBrief: false, ...options.inspectOptions });
        if (!freshInspection || freshInspection.status !== 'valid' || freshInspection.digest !== brief.digest) return true;
      } catch {
        return true;
      }
      try {
        if (await computeWorktreeIdentity(rootDir, options) !== worktreeIdentity) return true;
      } catch {
        return true;
      }
      return false;
    };

    if (budgetBlocked) {
      // Fail-closed projection: the protected minimum is presented verbatim,
      // every candidate stays unassessed, and the diagnostics name the
      // budget refusal. The assessor is never invoked just to have its
      // result discarded.
      runStatus = 'failed';
      complete = false;
      budget.fits = false;
      records = candidates.map((candidate) => ({
        candidate_id: candidate.candidate_id,
        path: candidate.path,
        sha256: candidate.sha256,
        bytes: candidate.bytes,
        kind: candidate.kind,
        status: 'unassessed',
        scores: null,
        reason: 'protected-minimum-not-presentable',
        limitation: null,
        evidence_refs: [],
        conflict: null,
      }));
      // Freshness probe on the collected failed outcome (review RG284-001):
      // the verbatim baseline projection still carries a freshness claim, so
      // it must be re-confirmed by the same bounded probe the semantic path
      // uses — never declared `current` by default. An unconfirmed probe
      // keeps the projection verbatim and honestly marks the outcome stale
      // with a bounded diagnostic.
      if (await freshProbe()) {
        freshness = 'stale';
        diagnostics.push({ code: 'freshness-unconfirmed', path: null, detail: 'budget-blocked projection could not be re-confirmed' });
      }
    } else {
      // Bounded assessor input: baseline intent/outcome/surface plus the
      // readable candidate texts (bounded per candidate in UTF-8 bytes — the
      // policy limit is a byte budget, not a UTF-16 code-unit count, so
      // Cyrillic or emoji content cannot silently exceed it; the cut never
      // splits a multi-byte sequence). The protected minimum travels as
      // pointers, never as content.
      const assessorInput = {
        language: resolvedLanguage,
        baseline: {
          intent: brief.intent,
          target_outcome: brief.target_outcome,
          acceptance_criteria: brief.acceptance_criteria,
          non_goals: brief.non_goals,
          constraints: brief.constraints,
          protected_minimum: protectedBuild.protected_minimum,
        },
        candidates: candidates.filter((candidate) => candidate.kind === 'file').map((candidate) => {
          const bounded = boundAssessmentText(candidate.text, MAX_ASSESSMENT_TEXT);
          if (bounded.truncated) {
            diagnostics.push({ code: 'candidate-text-truncated', path: candidate.path, detail: `limit=${MAX_ASSESSMENT_TEXT} bytes` });
          }
          return { candidate_id: candidate.candidate_id, path: candidate.path, bytes: candidate.bytes, text: bounded.text };
        }),
      };
      // The assessor gets only the REMAINING command budget, not a fresh
      // full deadline: the deadline bounds the whole command.
      const remainingBudget = Math.max(1, (options.deadlineMs ?? DEFAULT_DEADLINE_MS) - (now() - startedAt));
      const baselineComponents = baselineBindingComponents(brief);
      const candidateDigests = candidateDigestRecords(candidates);
      const bindingBase = {
        worktreeIdentity,
        changeId,
        baseline: baselineComponents,
        candidateDigests,
      };
      const outcome = await runTypedAssessment({
        assessor: options.assessor,
        input: assessorInput,
        coverage: { state: coverage.state, declared_sources: coverage.declared_sources, scanned_sources: coverage.scanned_sources, missing_sources: [] },
        limits: { deadlineMs: remainingBudget, maxFindings: MAX_CANDIDATES, maxDiagnostics: MAX_DIAGNOSTICS },
        watch: { changed: freshProbe },
        now,
      });
      freshness = outcome.freshness === 'stale' ? 'stale' : 'current';
      // The helper passes assessor diagnostics through verbatim; the schema
      // bounds are enforced HERE, at the copy boundary — every field is
      // capped to its closed maximum so an oversized provider diagnostic
      // degrades to bounded metadata instead of a schema-parity crash
      // (review R1: the same fail-open class as dropped findings). An entry
      // without a usable code (empty string, wrong shape) is dropped with
      // its own bounded marker — an uncodeable diagnostic can never reach
      // the schema gate (review R2/codex N5: `''` passes a typeof check but
      // violates the schema `minLength: 1`).
      for (const entry of Array.isArray(outcome.diagnostics) ? outcome.diagnostics : []) {
        if (entry && typeof entry === 'object' && typeof entry.code === 'string' && entry.code.length > 0) {
          diagnostics.push({
            code: entry.code.slice(0, 200),
            path: typeof entry.path === 'string' ? entry.path.slice(0, 500) : null,
            detail: typeof entry.detail === 'string' ? entry.detail.slice(0, 500) : null,
          });
        } else if (entry !== null && entry !== undefined) {
          diagnostics.push({ code: 'assessor-diagnostic-dropped', path: null, detail: 'malformed diagnostic entry' });
        }
      }
      if (outcome.run_status !== 'complete') {
        // Assessor error / timeout / invalid output: the projection stays
        // honest — protected minimum verbatim, every candidate unassessed,
        // and the bounded cause recorded. Never an empty-context success.
        // (The budget itself is untouched: nothing was included, so the
        // measured projection still fits.)
        runStatus = 'failed';
        complete = false;
        records = candidates.map((candidate) => ({
          candidate_id: candidate.candidate_id,
          path: candidate.path,
          sha256: candidate.sha256,
          bytes: candidate.bytes,
          kind: candidate.kind,
          status: 'unassessed',
          scores: null,
          reason: 'assessor-stage-failed',
          limitation: null,
          evidence_refs: [],
          conflict: null,
        }));
      } else if (outcome.abstained === true) {
        // Abstain (helper semantics): a complete, honest "nothing was
        // selected" — never a zero-findings result, and never a completed
        // selection.
        abstained = true;
        complete = false;
        coverage.state = 'none';
        records = candidates.map((candidate) => ({
          candidate_id: candidate.candidate_id,
          path: candidate.path,
          sha256: candidate.sha256,
          bytes: candidate.bytes,
          kind: candidate.kind,
          status: 'unassessed',
          scores: null,
          reason: 'assessor-abstained',
          limitation: null,
          evidence_refs: [],
          conflict: null,
        }));
      } else {
        const assessments = normalizeAssessorFindings(outcome, candidates, diagnostics);
        // The assessor's ranking order is the ACCEPTED assessments order —
        // the normalization Map preserves findings-array insertion order of
        // exactly the kept entries (review R2-N4/codex N4: rebuilding ranks
        // from the raw findings array would let an early DROPPED finding for
        // candidate X outrank a later accepted one and win the budget). The
        // budget is spent top-ranked first, not path-sorted first.
        const rankedIds = [...assessments.keys()];
        // Conflict refs metadata bytes (pointers only) are budget-relevant.
        const conflictRefsBytes = [...assessments.values()]
          .filter((assessment) => assessment.status === 'conflicting')
          .reduce((sum, assessment) => sum + Buffer.byteLength(JSON.stringify(assessment.conflict.refs), 'utf8'), 0);
        const projection = projectSelection({
          candidates,
          assessments,
          rankedIds,
          minimumRequired: protectedBuild.minimumRequired,
          conflictRefsBytes,
          limit: MAX_PRESENTATION_BYTES,
        });
        diagnostics.push(...projection.diagnostics);
        records = projection.records;
        manifestIncluded = projection.manifestIncluded;
        manifestExcluded = projection.manifestExcluded;
        budget.estimated = projection.estimated;
        budget.fits = projection.fits;
        const conflicting = records.filter((record) => record.status === 'conflicting');
        needsReview = conflicting.length > 0;
        ownerHandoff = conflicting.length > 0 ? 'aif-review' : null;
        // A readable candidate the assessor never assessed (empty findings
        // without abstain, or every finding dropped by normalization) is a
        // degradation, not full coverage (review F05): the honest AND model
        // reports it as partial — assessed candidates survive, `complete`
        // flips false.
        const assessorLeftUnassessed = records.some((record) => record.status === 'unassessed' && record.reason === 'assessor-left-unassessed');
        // The helper owns its own coverage facts (review round 4, Devin: a
        // findings-array truncation beyond maxFindings downgrades the
        // helper's normalized coverage to partial even when the kept head
        // assessed every candidate) — the overlay never presents a full
        // selection on top of a helper-reported degradation.
        const helperCoveragePartial = outcome.coverage?.state === 'partial';
        if (missingSources.length > 0 || assessorLeftUnassessed || helperCoveragePartial || projection.hasDemotions || !projection.fits || !projection.conflictFits) {
          coverage.state = 'partial';
        }
        // AND completeness (decision D7): assessment complete && budget
        // fits && no budget demotions && full coverage && fresh probe. A
        // partial success keeps its assessed candidates with
        // `run_status: 'complete'` and reports the degradation through
        // `complete: false` + coverage — the run level never fakes a full
        // selection, and it never demotes a hard failure into "unassessed
        // everything".
        complete = budget.fits && !projection.hasDemotions
          && coverage.state === 'full' && freshness === 'current';
      }
    }

    const includedRecords = records.filter((record) => record.status === 'included');
    const conflictingRecords = records.filter((record) => record.status === 'conflicting');
    const unresolvedRecords = records.filter((record) => record.status === 'excluded' || record.status === 'unassessed');
    const presentation = [
      { section: 'protected_minimum', refs: protectedBuild.protected_minimum.map((entry) => entry.path) },
      { section: 'relevant', refs: includedRecords.map((record) => record.candidate_id).sort(idOrder) },
      { section: 'conflicts', refs: conflictingRecords.map((record) => record.candidate_id).sort(idOrder) },
      { section: 'unresolved', refs: unresolvedRecords.map((record) => record.candidate_id).sort(idOrder) },
    ];
    const context = await currentOverlayContext(options);
    const candidateDigests = candidateDigestRecords(candidates);
    const binding = buildAssessmentBinding(contextSelectionBindingObject({
      worktreeIdentity,
      changeId,
      baseline: baselineBindingComponents(brief),
      candidateDigests,
      candidatePayloadDigest: assessmentDigest(records),
      rubric: context.rubric,
      exclusionPolicy: context.exclusionPolicy,
      presentationPolicy: context.presentationPolicy,
      engine: context.engine,
      helper: context.helper,
      contract: context.contract,
      languageOptions: { override: null, resolved: resolvedLanguage },
      assessmentLimits: context.assessmentLimits,
      budgetPolicy: context.budgetPolicy,
    }));
    const observation = assembleObservation({
      changeId,
      generatedAt: new Date(startedAt).toISOString(),
      runStatus,
      complete,
      freshness,
      abstained,
      needsReview,
      ownerHandoff,
      coverage,
      budget,
      manifest: {
        protected_minimum: protectedBuild.protected_minimum,
        included: manifestIncluded,
        excluded: manifestExcluded,
      },
      candidates: records,
      presentation,
      baseline: baselineBindingComponents(brief),
      candidateDigests,
      context,
      language: resolvedLanguage,
      worktreeIdentity,
      binding,
      diagnostics: diagnostics.slice(0, MAX_DIAGNOSTICS),
    });
    // The engine-owned builder cannot produce an invariant-violating
    // observation, so this is a defensive gate: if it ever fires, the
    // contract demands a typed refusal before any persistence — never a
    // crash and never a written observation.
    try {
      assertOverlayInvariants(observation);
    } catch (error) {
      emit(failureEnvelope('operational-failure', [`invariant-failure:${String(error?.message ?? error).slice(0, 80)}`]), parsed.json);
      return 1;
    }
    if (Buffer.byteLength(JSON.stringify(observation, null, 2), 'utf8') > MAX_OBSERVATION_BYTES) {
      emit(notRunEnvelope(['invalid-candidate:observation-overflow']), parsed.json);
      return 2;
    }
    const schemaBytes = await readFile(new URL(`../${CONTRACT_MODULE}`, import.meta.url), 'utf8');
    const schema = parseStrictJson(schemaBytes);
    const schemaErrors = validateJsonAgainstSchema(observation, schema);
    if (schemaErrors.length > 0) {
      emit(failureEnvelope('operational-failure', ['schema-parity-failure', ...schemaErrors.slice(0, 5).map((error) => error.message)]), parsed.json);
      return 1;
    }
    // No deadline short-circuit past the semantic stage (review F04): once
    // assessment material exists, the honest outcome is the collected
    // observation — a timeout INSIDE the helper already degraded freshness to
    // `stale` and hard failures kept the verbatim minimum with every
    // candidate unassessed. A late cutoff must never replace that honest
    // projection with a not_run envelope. Only the pre-assessment deadline
    // checks above produce not_run.
    if (parsed.write) {
      const written = await writeOverlayObservation(rootDir, observation, config, options);
      if (!written.ok) {
        emit({ ...failureEnvelope('observation-not-saved', [written.code]), change_id: changeId, detail: written.detail ?? null }, parsed.json);
        return 1;
      }
    }
    emit(observation, parsed.json);
    return 0;
  } catch (error) {
    emit(failureEnvelope('operational-failure', [String(error?.message ?? error).slice(0, 120)]), parsed.json);
    return 1;
  }
}

// The closed consumer registry must contain this consumer (mirrored as a
// membership assertion in scripts/typed-assessment.test.mjs).
if (!ASSESSMENT_CONSUMER_IDS.includes(CONTEXT_SELECTION_CONSUMER_ID)) {
  throw new TypeError('context_selection_overlay must stay a registered typed-assessment consumer');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runContextSelectionOverlayCommand();
}
