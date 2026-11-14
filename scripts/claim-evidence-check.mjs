// Opt-in, advisory claim↔source evidence check for pairs presented to
// /aif-explore and /aif-review (issue #282). The check is a structural
// diagnostic, never a verifier: it never creates an `aif-gate-result`, never
// writes QA evidence, never edits canonical or spec artifacts, and never
// grants workflow authority (frozen #228 boundary). The structural stage is
// fully deterministic over the raw bytes of ONLY the presented inputs:
// existence, exact quote spans (UTF-8 byte offsets with raw document and span
// SHA-256), and known source-revision metadata. The semantic stage runs
// through the shared typed-assessment helper with a DI assessor seam; without
// an injected assessor it reports an honest `not_run`, and assessor errors,
// abstentions, and deadline cutoffs are never coerced into `supports`.
// Presented claim/source text is data, never commands: the default path opens
// no URLs, reads no paths out of the text, and the allowlist is built from
// the explicitly presented inputs before any read.
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, realpath, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { canonical, digest, portablePath } from './workflow-state-store.mjs';
import { parseStrictJson } from './json-strict.mjs';
import { validateJsonAgainstSchema } from './json-schema-subset.mjs';
import { readProviderFile, safeProviderPath } from './provider-files.mjs';
import { normalizeChangeId } from './active-change-resolver.mjs';
import { ensureRuntimeGitignore } from './runtime-gitignore.mjs';
import { verifyObservationIgnored } from './requirement-lint-git-guard.mjs';
import { readRequirementDocument, resolveProseLanguage } from './requirement-lint.mjs';
import {
  buildAssessmentBinding,
  notRunAssessment,
  runTypedAssessment,
} from './typed-assessment.mjs';

export const CLAIM_EVIDENCE_SCHEMA = 'aifhub.claim_evidence_observation.v1';
export const CLAIM_EVIDENCE_PAIRS_SCHEMA = 'aifhub.claim_evidence_pairs.v1';
export const CLAIM_EVIDENCE_CONSUMER_ID = 'claim_evidence_check';
export const STATE_ROOT = '.ai-factory/state';
export const QA_ROOT = '.ai-factory/qa';
export const CLAIM_EVIDENCE_NAMESPACE = 'claim-evidence';
export const ENGINE_MODULE = 'scripts/claim-evidence-check.mjs';
export const HELPER_MODULE = 'scripts/typed-assessment.mjs';
export const CONTRACT_MODULE = 'schemas/claim-evidence-observation.schema.json';
export const PARSER_VERSION = 1;
export const DOCUMENT_LIMIT = 1024 * 1024;
export const MAX_CLAIM_PAIRS = 50;
export const MAX_SOURCES = 50;
// Schema maxItems of the missing_sources lists (both projections): the cap
// stays on the LIST, never on the per-pair counter.
export const MAX_MISSING_SOURCE_ENTRIES = 100;
export const MAX_ENVELOPE_BYTES = 1024 * 1024;
export const MAX_QUOTE_BYTES = 64 * 1024;
export const MAX_DIAGNOSTICS = 200;
export const DEFAULT_DEADLINE_MS = 30000;
export const NOT_RUN_MESSAGE = 'advisory scan was not performed';
// First-phase rubric: the structural stage is deterministic and needs no
// pinned rule file; the live semantic rubric arrives with the separate
// opt-in live phase. The constant revision still enters the composite
// binding so a future rubric change invalidates recorded observations.
export const CLAIM_EVIDENCE_RUBRIC = Object.freeze({ id: 'claim-evidence-structural-default', version: 1 });
export const CLAIM_EVIDENCE_EXCLUSION_POLICY = Object.freeze({ id: 'none', version: 1 });
export const QUOTE_CHECK_OUTCOMES = Object.freeze([
  'exact_found',
  'literal_match_out_of_context',
  'not_found',
  'source_unavailable',
  'truncated',
  'not_applicable',
]);
export const KNOWN_REVISION_OUTCOMES = Object.freeze(['match', 'changed', 'not_declared', 'unverifiable']);
export const SEMANTIC_VERDICTS = Object.freeze(['supports', 'contradicts', 'insufficient']);
export const RELATIONS = Object.freeze(['literal_quote', 'paraphrase', 'inference']);
export const usage = 'ai-factory aifhub-claim-evidence-check --change <id> [--enabled true|false] (--pairs <path> | --stdin) [--json] [--write]';

export function claimEvidencePaths(changeId) {
  const normalized = normalizeChangeId(changeId);
  if (!normalized.ok) throw new Error('invalid-change-id');
  return {
    directory: `${STATE_ROOT}/${normalized.changeId}/${CLAIM_EVIDENCE_NAMESPACE}`,
    observation: `${STATE_ROOT}/${normalized.changeId}/${CLAIM_EVIDENCE_NAMESPACE}/observation.json`,
  };
}

// ---------------------------------------------------------------------------
// Argument parsing (explicit-only; unknown/duplicate/missing -> invalid usage)
// ---------------------------------------------------------------------------

export function parseClaimEvidenceArgs(argv) {
  const result = { ok: true, changeId: null, pairsPath: null, stdin: false, json: false, write: false, enabled: null, error: null };
  const invalid = (error) => ({ ...result, ok: false, error });
  const seen = new Set();
  const args = Array.from(argv ?? []);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!['--change', '--pairs', '--stdin', '--enabled', '--json', '--write'].includes(arg)) {
      return invalid(`unknown option: ${arg}`);
    }
    if (seen.has(arg)) return invalid(`duplicate option: ${arg}`);
    seen.add(arg);
    if (arg === '--stdin') { result.stdin = true; continue; }
    if (arg === '--json') { result.json = true; continue; }
    if (arg === '--write') { result.write = true; continue; }
    const value = args[index + 1];
    if (typeof value !== 'string' || value.startsWith('--')) return invalid(`missing value for ${arg}`);
    index += 1;
    if (arg === '--change') result.changeId = value;
    else if (arg === '--pairs') result.pairsPath = value;
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

function validateClaimId(value) {
  return typeof value === 'string' && value.length >= 1 && value.length <= 200
    && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value);
}

const SHA256_REF = /^sha256:[a-f0-9]{64}$/;

function validateSpanForm(span) {
  if (!span || typeof span !== 'object' || Array.isArray(span)) return false;
  const keys = Object.keys(span);
  if (keys.length !== 2 || !keys.includes('start') || !keys.includes('end')) return false;
  const { start, end } = span;
  // The observation schema caps span offsets at the safe-integer maximum, so
  // the form check matches it before any source read: a missing source may
  // never turn an oversized span into an operational (exit 1) failure.
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) return false;
  return true;
}

// Closed envelope validation (strict shape, bounded). Every violation is a
// typed invalid invocation (exit 2), never a silent reinterpretation: an
// unknown key, an oversized quote, or a span with an invalid range is refused
// before any read (D4: refuse, not clamp).
export function validatePairsEnvelope(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, error: 'envelope must be an object' };
  const rootKeys = Object.keys(value);
  if (!rootKeys.every((key) => ['schema', 'carrier', 'checked_scope', 'claims'].includes(key))) {
    return { ok: false, error: 'unknown envelope key' };
  }
  if (value.schema !== CLAIM_EVIDENCE_PAIRS_SCHEMA) return { ok: false, error: 'unknown envelope schema' };
  const carrier = value.carrier;
  if (!carrier || typeof carrier !== 'object' || Array.isArray(carrier) || Object.keys(carrier).length !== 1
    || !Object.hasOwn(carrier, 'path') || !validateFileForm(carrier.path)) {
    return { ok: false, error: 'invalid carrier' };
  }
  if (typeof value.checked_scope !== 'string' || value.checked_scope.length < 1 || value.checked_scope.length > 500
    || /[\x00-\x1f]/.test(value.checked_scope)) {
    return { ok: false, error: 'invalid checked_scope' };
  }
  if (!Array.isArray(value.claims) || value.claims.length < 1 || value.claims.length > MAX_CLAIM_PAIRS) {
    return { ok: false, error: `claims must be an array of 1..${MAX_CLAIM_PAIRS}` };
  }
  const seenIds = new Set();
  for (const claim of value.claims) {
    if (!claim || typeof claim !== 'object' || Array.isArray(claim)) return { ok: false, error: 'claim must be an object' };
    const allowed = ['claim_id', 'parent_claim_id', 'claim_ref', 'source_ref', 'relation', 'quote', 'known_source_revision'];
    if (!Object.keys(claim).every((key) => allowed.includes(key))) return { ok: false, error: 'unknown claim key' };
    if (!validateClaimId(claim.claim_id)) return { ok: false, error: 'invalid claim_id' };
    if (seenIds.has(claim.claim_id)) return { ok: false, error: `duplicate claim_id: ${claim.claim_id}` };
    seenIds.add(claim.claim_id);
    if (claim.parent_claim_id !== undefined && (claim.parent_claim_id === null || !validateClaimId(claim.parent_claim_id))) {
      return { ok: false, error: 'invalid parent_claim_id' };
    }
    if (claim.claim_ref !== undefined && (claim.claim_ref === null || typeof claim.claim_ref !== 'string'
      || claim.claim_ref.length < 1 || claim.claim_ref.length > 500 || /[\x00-\x1f]/.test(claim.claim_ref))) {
      return { ok: false, error: 'invalid claim_ref' };
    }
    const sourceRef = claim.source_ref;
    if (!sourceRef || typeof sourceRef !== 'object' || Array.isArray(sourceRef)) return { ok: false, error: 'missing source_ref' };
    const sourceKeys = Object.keys(sourceRef);
    if (sourceKeys.length < 1 || sourceKeys.length > 2 || !sourceKeys.includes('path')
      || sourceKeys.some((key) => key !== 'path' && key !== 'span')) return { ok: false, error: 'invalid source_ref keys' };
    if (!validateFileForm(sourceRef.path)) return { ok: false, error: 'invalid source_ref path' };
    if (sourceKeys.includes('span') && !validateSpanForm(sourceRef.span)) return { ok: false, error: 'invalid source_ref span' };
    if (!RELATIONS.includes(claim.relation)) return { ok: false, error: 'invalid relation' };
    if (claim.relation === 'literal_quote') {
      if (typeof claim.quote !== 'string' || claim.quote.length < 1
        || Buffer.byteLength(claim.quote, 'utf8') > MAX_QUOTE_BYTES) return { ok: false, error: 'literal_quote requires a bounded quote' };
    } else if (Object.hasOwn(claim, 'quote')) {
      return { ok: false, error: `${claim.relation} must not carry a quote` };
    }
    if (claim.known_source_revision !== undefined
      && (claim.known_source_revision === null || !SHA256_REF.test(claim.known_source_revision))) {
      return { ok: false, error: 'invalid known_source_revision' };
    }
  }
  // Parent references must resolve inside the same presented envelope.
  for (const claim of value.claims) {
    if (claim.parent_claim_id !== undefined && !seenIds.has(claim.parent_claim_id)) {
      return { ok: false, error: 'unresolved parent_claim_id' };
    }
  }
  return { ok: true, envelope: value };
}

async function readStdinBounded(limit) {
  const chunks = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    total += chunk.length;
    if (total > limit) throw new Error('stdin-limit-exceeded');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------------------
// Bounded closed config read for the `aifhub.claimEvidence` opt-in namespace
// (mirror of the requirement-lint subset parser: explicit detections keep the
// check off with bounded `claim-evidence:<code>` diagnostics; a malformed
// namespace degrades to "advisory scan was not performed" and never becomes a
// required-gate failure).
// ---------------------------------------------------------------------------

const CHECK_CONFIG_PATH = Object.freeze(['aifhub', 'claimEvidence']);
const CHECK_CONFIG_CLOSED_KEYS = Object.freeze(new Set(['enabled']));
const CHECK_STRUCTURAL_PATHS = Object.freeze([
  ['aifhub'],
  CHECK_CONFIG_PATH,
  ['paths'],
]);

function checkConfigDiagnostic(code, detail) {
  return { code: `claim-evidence:${code}`, path: '.ai-factory/config.yaml', detail: detail === undefined ? null : String(detail).slice(0, 200) };
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

export function parseClaimEvidenceConfigSubset(raw) {
  const diagnostics = [];
  const root = Object.create(null);
  const stack = [{ indent: -1, value: root, path: [] }];
  const belowCheck = (path) => path.length > CHECK_CONFIG_PATH.length
    && CHECK_CONFIG_PATH.every((part, index) => path[index] === part);
  const structural = (path) => CHECK_STRUCTURAL_PATHS.some((candidate) => candidate.length === path.length
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
    if (!match) continue;
    const indent = match[1].length;
    const key = match[2].trim();
    const rawValue = match[3]?.trim() ?? '';
    while (stack.length > 1 && stack.at(-1).indent >= indent) stack.pop();
    const parent = stack.at(-1);
    const ownPath = [...parent.path, key];
    const inside = belowCheck(ownPath);
    const guarded = inside || structural(ownPath);
    if (guarded && key === '<<') {
      diagnostics.push(checkConfigDiagnostic('merge-key', key));
      continue;
    }
    if (guarded && rawValue.startsWith('&')) {
      diagnostics.push(checkConfigDiagnostic('anchor', key));
      continue;
    }
    if (guarded && rawValue.startsWith('*')) {
      diagnostics.push(checkConfigDiagnostic('alias', key));
      continue;
    }
    if (guarded && /^[{[]/.test(rawValue)) {
      diagnostics.push(checkConfigDiagnostic('flow-mapping', key));
      continue;
    }
    if (guarded && Object.hasOwn(parent.value, key)) {
      diagnostics.push(checkConfigDiagnostic('duplicate-key', `${ownPath.join('.')}`));
      continue;
    }
    if (inside && !CHECK_CONFIG_CLOSED_KEYS.has(key)) {
      diagnostics.push(checkConfigDiagnostic('unknown-key', key));
      continue;
    }
    if (rawValue.length === 0) {
      parent.value[key] = Object.create(null);
      stack.push({ indent, value: parent.value[key], path: ownPath });
      continue;
    }
    const parsed = scalar(rawValue);
    if (guarded && parsed.unterminated) {
      diagnostics.push(checkConfigDiagnostic('unterminated-quote', key));
      continue;
    }
    if (inside && key === 'enabled' && parsed.quoted && /^(true|false)$/i.test(parsed.text)) {
      diagnostics.push(checkConfigDiagnostic('quoted-boolean', rawValue));
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

export async function readClaimEvidenceConfig(rootDir, options = {}) {
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
    bytes = await readProviderFile(rootDir, '.ai-factory/config.yaml', 256 * 1024);
  } catch (error) {
    // A config that exists but cannot be read must not stand in for the
    // project's configured roots: with `--enabled true --write` the writer
    // would otherwise save under the defaulted state root while a readable
    // config would have refused it (`state-root-mismatch`). The check stays
    // off, like every other malformed-namespace path.
    diagnostics.push({ code: 'config-unreadable', path: '.ai-factory/config.yaml', detail: String(error?.message ?? error).slice(0, 500) });
    config.enabledMalformed = true;
    return config;
  }
  if (bytes === null) return config;
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    diagnostics.push({ code: 'config-malformed', path: '.ai-factory/config.yaml', detail: 'utf8-fatal' });
    config.enabledMalformed = true;
    return config;
  }
  const parsed = parseClaimEvidenceConfigSubset(text);
  diagnostics.push(...parsed.diagnostics);
  const hub = parsed.value?.aifhub;
  const paths = parsed.value?.paths;
  let structuralDamage = false;
  for (const [name, section] of [['aifhub', hub], ['paths', paths]]) {
    if (section !== undefined && section !== null && (typeof section !== 'object' || Array.isArray(section))) {
      diagnostics.push(checkConfigDiagnostic('scalarized-section', name));
      structuralDamage = true;
    }
  }
  const checkSection = hub && typeof hub === 'object' ? hub.claimEvidence : undefined;
  if (checkSection !== undefined && (checkSection === null || typeof checkSection !== 'object' || Array.isArray(checkSection))) {
    diagnostics.push(checkConfigDiagnostic('scalarized-section', 'aifhub.claimEvidence'));
    config.enabledMalformed = true;
  }
  const enabled = checkSection && typeof checkSection === 'object' ? checkSection.enabled : undefined;
  if (enabled !== undefined) {
    if (typeof enabled === 'boolean') config.enabled = enabled;
    else {
      config.enabledMalformed = true;
      diagnostics.push(checkConfigDiagnostic('not-a-boolean', JSON.stringify(enabled)));
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
// Local byte-span primitive (spanRef in requirement-lint.mjs stays
// module-private; this consumer owns its own record shape). Input spans are
// validated by the caller with a refusal — never clamped.
// ---------------------------------------------------------------------------

function spanRecord(bytes, documentSha256, start, end) {
  return {
    start,
    end,
    document_sha256: `sha256:${documentSha256}`,
    span_sha256: `sha256:${digest(bytes.subarray(start, end))}`,
  };
}

// ---------------------------------------------------------------------------
// Deterministic structural stage over ONLY the presented inputs
// ---------------------------------------------------------------------------

const TRUNCATION_CODES = Object.freeze(new Set(['file_limit', 'unsafe_file']));

function sourceOutcomeForRead(read) {
  if (read.ok) return null;
  if (read.kind === 'missing') return { quote_check: 'source_unavailable', reason: 'file-missing' };
  if (TRUNCATION_CODES.has(String(read.code))) return { quote_check: 'truncated', reason: String(read.code) };
  return { quote_check: 'source_unavailable', reason: String(read.code ?? 'malformed') };
}

// One structural check per presented pair. Quote bytes are searched over the
// raw source bytes with Buffer.indexOf; a presented span anchor must match
// exactly, otherwise a literal match outside the presented context is its own
// honest outcome. Known-revision metadata is a separate dimension and never
// replaces the quote-check outcome.
export function checkStructuralPair(pair, sourceBytes, sourceSha256, sourceOk, read) {
  const record = {
    claim_id: pair.claim_id,
    parent_claim_id: pair.parent_claim_id ?? null,
    claim_ref: pair.claim_ref ?? null,
    source_path: pair.source_ref.path,
    source_span: pair.source_ref.span ?? null,
    relation: pair.relation,
    quote_sha256: pair.quote !== undefined ? digest(Buffer.from(pair.quote, 'utf8')) : null,
    quote_check: 'not_applicable',
    quote_span: null,
    known_revision: 'not_declared',
    known_source_revision: pair.known_source_revision ?? null,
  };
  if (!sourceOk) {
    const outcome = sourceOutcomeForRead(read);
    record.quote_check = outcome.quote_check;
    // A declared revision whose source cannot be read was declared but is
    // unverifiable: reporting `not_declared` would erase the declaration.
    if (pair.known_source_revision !== undefined) record.known_revision = 'unverifiable';
    return { record, missing: { path: pair.source_ref.path, reason: outcome.reason } };
  }
  if (pair.known_source_revision !== undefined) {
    record.known_revision = `sha256:${sourceSha256}` === pair.known_source_revision ? 'match' : 'changed';
  }
  if (pair.relation !== 'literal_quote') {
    record.quote_check = 'not_applicable';
    return { record, missing: null };
  }
  const quoteBytes = Buffer.from(pair.quote, 'utf8');
  const span = pair.source_ref.span;
  if (span) {
    // Full refusal on an out-of-range input span (D4: refuse, not clamp).
    if (span.end > sourceBytes.length) throw new Error('span-out-of-range');
    if (Buffer.compare(sourceBytes.subarray(span.start, span.end), quoteBytes) === 0) {
      record.quote_check = 'exact_found';
      record.quote_span = spanRecord(sourceBytes, sourceSha256, span.start, span.end);
      return { record, missing: null };
    }
    const elsewhere = sourceBytes.indexOf(quoteBytes);
    if (elsewhere >= 0) {
      record.quote_check = 'literal_match_out_of_context';
      record.quote_span = spanRecord(sourceBytes, sourceSha256, elsewhere, elsewhere + quoteBytes.length);
      return { record, missing: null };
    }
    record.quote_check = 'not_found';
    return { record, missing: null };
  }
  const found = sourceBytes.indexOf(quoteBytes);
  if (found >= 0) {
    record.quote_check = 'exact_found';
    record.quote_span = spanRecord(sourceBytes, sourceSha256, found, found + quoteBytes.length);
    return { record, missing: null };
  }
  record.quote_check = 'not_found';
  return { record, missing: null };
}

function countBy(records, field, values) {
  const counts = Object.fromEntries(values.map((value) => [value, 0]));
  for (const record of records) counts[record[field]] += 1;
  return counts;
}

// ---------------------------------------------------------------------------
// Worktree identity, module revisions, composite binding
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

export function inputDigestRecords(inputs) {
  const records = inputs.map((input) => ({
    path: input.path,
    sha256: input.sha256 ?? null,
    bytes: input.bytes ?? 0,
    kind: input.kind,
  }));
  records.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return records;
}

function claimRefRecords(envelope) {
  return envelope.claims.map((claim) => ({
    claim_id: claim.claim_id,
    parent_claim_id: claim.parent_claim_id ?? null,
    claim_ref: claim.claim_ref ?? null,
    source_path: claim.source_ref.path,
    source_span: claim.source_ref.span ?? null,
    relation: claim.relation,
    quote_sha256: claim.quote !== undefined ? digest(Buffer.from(claim.quote, 'utf8')) : null,
    known_source_revision: claim.known_source_revision ?? null,
  })).sort((left, right) => (left.claim_id < right.claim_id ? -1 : left.claim_id > right.claim_id ? 1 : 0));
}

export function claimEvidenceBindingObject({
  worktreeIdentity, changeId, carrier, claimRefs, inputDigests, checkedScope, truncation, transport,
  rubric, engine, helper, contract, languageOptions, exclusionPolicy,
}) {
  return {
    consumer: CLAIM_EVIDENCE_CONSUMER_ID,
    worktree_identity: worktreeIdentity,
    change_id: changeId,
    methodology: 'openspec',
    carrier,
    claim_refs: claimRefs,
    input_digests: inputDigests,
    checked_scope: checkedScope,
    truncation,
    transport,
    rubric,
    engine,
    helper,
    contract,
    language_options: languageOptions,
    exclusion_policy: exclusionPolicy,
  };
}

export async function currentClaimEvidenceContext(rootDir, inputs, options = {}) {
  const contractSha = await moduleSha256(new URL(`../${CONTRACT_MODULE}`, import.meta.url), options);
  const engineSha = await moduleSha256(new URL(`../${ENGINE_MODULE}`, import.meta.url), options);
  const helperSha = await moduleSha256(new URL(`../${HELPER_MODULE}`, import.meta.url), options);
  return {
    inputDigests: inputDigestRecords(inputs),
    rubric: { ...CLAIM_EVIDENCE_RUBRIC },
    engine: { module: ENGINE_MODULE, sha256: engineSha, parser_version: PARSER_VERSION },
    helper: { module: HELPER_MODULE, sha256: helperSha },
    contract: { name: CLAIM_EVIDENCE_SCHEMA, sha256: contractSha },
  };
}

function sortAssessments(assessments) {
  return [...assessments].sort((left, right) => left.claim_id.localeCompare(right.claim_id)
    || left.verdict.localeCompare(right.verdict));
}

// Compound roll-up (engine-owned; the helper knows nothing about claims). A
// parent inherits `supported` only when every presented part carries a
// `supports` assessment from a completed, non-abstained semantic stage; any
// insufficient/abstain/absent part — or a stage that never ran — keeps the
// parent honestly `not_supported`.
export function computeCompoundParents(envelope, semantic) {
  const partsByParent = new Map();
  for (const claim of envelope.claims) {
    if (claim.parent_claim_id === undefined) continue;
    const bucket = partsByParent.get(claim.parent_claim_id) ?? [];
    bucket.push(claim.claim_id);
    partsByParent.set(claim.parent_claim_id, bucket);
  }
  const assessmentByClaim = new Map(semantic.assessments.map((entry) => [entry.claim_id, entry]));
  const stageRan = semantic.run_status === 'complete' && semantic.abstained === false;
  const parents = [...partsByParent.keys()].sort((left, right) => left.localeCompare(right)).map((claimId) => {
    const parts = [...partsByParent.get(claimId)].sort((left, right) => left.localeCompare(right));
    const supported = stageRan && parts.every((part) => assessmentByClaim.get(part)?.verdict === 'supports');
    return { claim_id: claimId, parts, verdict: supported ? 'supported' : 'not_supported' };
  });
  return { parents };
}

// The observation schema admits exactly {code, path, detail} diagnostics:
// provider-supplied diagnostics are untrusted, so anything outside the
// closed shape is dropped here rather than failing schema parity after the
// whole scan already ran (the structural section must always survive).
function isValidObservationDiagnostic(entry) {
  return entry && typeof entry === 'object' && !Array.isArray(entry)
    && Object.keys(entry).length === 3
    && typeof entry.code === 'string' && entry.code.length >= 1 && entry.code.length <= 200
    && (entry.path === null || (typeof entry.path === 'string' && entry.path.length >= 1 && entry.path.length <= 500))
    && (entry.detail === null || (typeof entry.detail === 'string' && entry.detail.length <= 500));
}

// Closed-shape normalization of helper findings into semantic assessments.
// A finding outside the closed verdict shape — naming a claim outside the
// presented envelope (when the caller provides the presented id set) — or
// carrying a verdict for a claim that another finding already assessed is
// never coerced into a result: it is dropped with a diagnostic, and the
// stage degrades to an explicit `failed` outcome — a partial or
// contradictory supports set would be dishonest. Helper diagnostics are
// validated at the same boundary and returned exactly once, so callers can
// merge them without duplicating entries in the observation.
export function normalizeSemanticOutcome(outcome, knownClaimIds = null) {
  const rawDiagnostics = Array.isArray(outcome.diagnostics) ? outcome.diagnostics : [];
  const diagnostics = [];
  let diagnosticsInvalid = false;
  for (const entry of rawDiagnostics) {
    if (isValidObservationDiagnostic(entry)) {
      diagnostics.push(entry);
      continue;
    }
    diagnosticsInvalid = true;
    diagnostics.push({ code: 'semantic-diagnostic-invalid', path: null, detail: 'dropped a helper diagnostic outside the closed shape' });
  }
  const rawAssessments = outcome.run_status === 'complete' && !outcome.abstained ? outcome.findings : [];
  const assessments = [];
  const seenClaimIds = new Set();
  let assessmentsInvalid = false;
  for (const finding of rawAssessments) {
    if (!finding || typeof finding !== 'object' || Array.isArray(finding)
      || !validateClaimId(finding.claim_id) || !SEMANTIC_VERDICTS.includes(finding.verdict)
      || typeof finding.rationale !== 'string' || finding.rationale.length < 1 || finding.rationale.length > 500
      || (knownClaimIds !== null && !knownClaimIds.has(finding.claim_id))
      || seenClaimIds.has(finding.claim_id)) {
      assessmentsInvalid = true;
      diagnostics.push({ code: 'semantic-assessment-invalid', path: null, detail: 'dropped a finding outside the closed verdict shape' });
      continue;
    }
    seenClaimIds.add(finding.claim_id);
    assessments.push({ claim_id: finding.claim_id, verdict: finding.verdict, rationale: finding.rationale });
  }
  if (assessmentsInvalid || diagnosticsInvalid) {
    return {
      run_status: 'failed',
      freshness: outcome.freshness,
      abstained: false,
      outcome_reason: assessmentsInvalid ? 'semantic-assessment-invalid' : 'semantic-diagnostic-invalid',
      assessments: [],
      diagnostics,
    };
  }
  return {
    run_status: outcome.run_status,
    freshness: outcome.freshness,
    abstained: outcome.abstained,
    outcome_reason: outcome.run_status === 'complete'
      ? (outcome.abstained ? 'assessor-abstain' : null)
      : String(diagnostics.find((entry) => entry.code !== 'assessment-stale')?.code ?? diagnostics[0]?.code ?? 'unspecified').slice(0, 200),
    assessments: sortAssessments(assessments).slice(0, MAX_CLAIM_PAIRS),
    diagnostics,
  };
}

export function assembleObservation({
  changeId, generatedAt, structural, semantic, compound, inputs, transport,
  context, language, languageSource, worktreeIdentity, binding, diagnostics,
}) {
  return {
    schema: CLAIM_EVIDENCE_SCHEMA,
    change_id: changeId,
    generated_at: generatedAt,
    diagnostic_only: true,
    authorizes: [],
    language: language === 'ru' ? 'ru' : (language === 'en' ? 'en' : 'unknown'),
    language_source: languageSource,
    language_options: { override: languageSource === 'override' ? language : null },
    structural: {
      checked_scope: structural.checkedScope,
      carrier: structural.carrier,
      pairs: structural.pairs,
      outcome_summary: {
        total: structural.pairs.length,
        by_quote_check: countBy(structural.pairs, 'quote_check', QUOTE_CHECK_OUTCOMES),
        by_known_revision: countBy(structural.pairs, 'known_revision', KNOWN_REVISION_OUTCOMES),
      },
      missing_sources: structural.missingSources,
    },
    semantic: {
      run_status: semantic.run_status,
      freshness: semantic.freshness,
      abstained: semantic.abstained,
      outcome_reason: semantic.outcome_reason,
      coverage: semantic.coverage,
      assessments: semantic.assessments,
    },
    compound,
    inputs: inputs.map((input) => ({ path: input.path, sha256: input.sha256 ?? null, bytes: input.bytes ?? 0, kind: input.kind })),
    transport,
    diagnostics,
    worktree_identity: worktreeIdentity,
    binding,
    rubric: { ...context.rubric },
    exclusion_policy: { ...CLAIM_EVIDENCE_EXCLUSION_POLICY },
    engine: context.engine,
    helper: context.helper,
    contract: context.contract,
  };
}

// ---------------------------------------------------------------------------
// Read-time revalidation: any divergence between the recorded composite
// binding and the current worktree/inputs/rubric/engine/helper/contract/
// language state names the drifted fields and marks the observation stale.
// ---------------------------------------------------------------------------

export async function validateObservationBinding(rootDir, observation, options = {}) {
  if (!observation || typeof observation !== 'object' || observation.schema !== CLAIM_EVIDENCE_SCHEMA
    || typeof observation.change_id !== 'string' || typeof observation.binding !== 'string') {
    return { ok: false, code: 'observation-invalid' };
  }
  const normalized = normalizeChangeId(observation.change_id);
  if (!normalized.ok) return { ok: false, code: 'observation-invalid' };
  let schema;
  try {
    schema = parseStrictJson(await readFile(new URL(`../${CONTRACT_MODULE}`, import.meta.url), 'utf8'));
  } catch {
    return { ok: false, code: 'root-unreadable' };
  }
  if (validateJsonAgainstSchema(observation, schema).length > 0) {
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
  const recordedInputs = Array.isArray(observation.inputs) ? observation.inputs : [];
  if (recordedInputs.length > MAX_SOURCES + 1) return { ok: false, code: 'observation-invalid' };
  const semantic = observation.semantic ?? {};
  const recordedPairs = observation.structural?.pairs ?? [];
  const recordedAssessments = Array.isArray(semantic.assessments) ? semantic.assessments : [];
  const claimIds = new Set(recordedPairs.map((pair) => pair?.claim_id));
  // Honest outcome invariants: a failed/not_run semantic stage and an
  // abstention can never carry assessments, and every assessment must name a
  // presented claim.
  if ((semantic.run_status === 'failed' || semantic.run_status === 'not_run' || semantic.abstained === true)
    && recordedAssessments.length > 0) {
    return { ok: false, code: 'observation-invalid' };
  }
  // An abstention never claims scanned coverage (mirror of the helper
  // invariant, enforced on the recorded observation itself).
  if (semantic.abstained === true && semantic.coverage?.state !== 'none') {
    return { ok: false, code: 'observation-invalid' };
  }
  // A findings-truncated marker is a coverage fact: the stage that truncated
  // can never be presented with full coverage (mirror of the helper's
  // normalizeCoverage downgrade).
  if ((observation.diagnostics ?? []).some((entry) => entry?.code === 'findings-truncated')
    && semantic.coverage?.state === 'full') {
    return { ok: false, code: 'observation-invalid' };
  }
  // The engine never emits a language override; a recorded override (or any
  // non-detected source) is schema-valid tampering, not a state this engine
  // can revalidate.
  if (observation.language_source !== 'detected' || observation.language_options?.override !== null) {
    return { ok: false, code: 'observation-invalid' };
  }
  // Exactly one assessment per presented claim: duplicated claim ids would
  // let contradictory verdicts survive the sort and flip the compound
  // roll-up through a last-wins map.
  for (const assessment of recordedAssessments) {
    if (!claimIds.has(assessment?.claim_id)) return { ok: false, code: 'observation-invalid' };
  }
  if (new Set(recordedAssessments.map((assessment) => assessment?.claim_id)).size !== recordedAssessments.length) {
    return { ok: false, code: 'observation-invalid' };
  }
  // Compound consistency: parents must exist in the recorded pairs, parts
  // must be the recorded children, and `supported` requires every part to
  // carry a `supports` assessment from a completed, non-abstained stage.
  const partsByParent = new Map();
  for (const pair of recordedPairs) {
    if (pair?.parent_claim_id === null || pair?.parent_claim_id === undefined) continue;
    const bucket = partsByParent.get(pair.parent_claim_id) ?? [];
    bucket.push(pair.claim_id);
    partsByParent.set(pair.parent_claim_id, bucket);
  }
  const recordedParents = observation.compound?.parents ?? [];
  if (recordedParents.length !== partsByParent.size) return { ok: false, code: 'observation-invalid' };
  const assessmentVerdicts = new Map(recordedAssessments.map((entry) => [entry.claim_id, entry.verdict]));
  for (const parent of recordedParents) {
    const expectedParts = [...(partsByParent.get(parent?.claim_id) ?? [])].sort((left, right) => left.localeCompare(right));
    if (!Array.isArray(parent?.parts) || [...parent.parts].sort((left, right) => left.localeCompare(right)).join('|') !== expectedParts.join('|')) {
      return { ok: false, code: 'observation-invalid' };
    }
    const stageRan = semantic.run_status === 'complete' && semantic.abstained === false;
    const supported = stageRan && expectedParts.every((part) => assessmentVerdicts.get(part) === 'supports');
    if (parent.verdict !== (supported ? 'supported' : 'not_supported')) {
      return { ok: false, code: 'observation-invalid' };
    }
  }
  if (recordedPairs.some((pair) => pair?.parent_claim_id !== null && pair?.parent_claim_id !== undefined
    && !recordedParents.some((parent) => parent.claim_id === pair.parent_claim_id))) {
    return { ok: false, code: 'observation-invalid' };
  }
  // Structural summary must agree with the pairs array; quote spans must sit
  // inside the recorded source bytes and carry the recorded document digest.
  const summary = observation.structural?.outcome_summary ?? {};
  if ((summary.total ?? -1) !== recordedPairs.length
    || QUOTE_CHECK_OUTCOMES.some((outcome) => (summary.by_quote_check?.[outcome] ?? -1) !== recordedPairs.filter((pair) => pair?.quote_check === outcome).length)
    || KNOWN_REVISION_OUTCOMES.some((outcome) => (summary.by_known_revision?.[outcome] ?? -1) !== recordedPairs.filter((pair) => pair?.known_revision === outcome).length)) {
    return { ok: false, code: 'observation-invalid' };
  }
  const inputsByPath = new Map(recordedInputs.map((input) => [input?.path, input]));
  const recordedMissing = observation.structural?.missing_sources ?? [];
  if (recordedPairs.filter((pair) => pair?.quote_check === 'source_unavailable' || pair?.quote_check === 'truncated').length > 0
    && (recordedMissing.length === 0 || (semantic.coverage?.state === 'full'))) {
    return { ok: false, code: 'observation-invalid' };
  }
  // Per-pair counter invariants (#282): the deduplicated list must have
  // unique paths, never exceed its per-pair count, satisfy the scanned
  // formula, and be IDENTICAL in both projections — the counters were never
  // cross-checked before, so drifted counts or divergent projections could
  // pass as a consistent observation.
  const coverageMissingCount = semantic.coverage?.missing_sources_count;
  if (new Set(recordedMissing.map((entry) => entry?.path)).size !== recordedMissing.length
    || recordedMissing.length > coverageMissingCount
    || semantic.coverage?.scanned_sources !== semantic.coverage?.declared_sources - coverageMissingCount
    || canonical(recordedMissing) !== canonical(semantic.coverage?.missing_sources ?? null)) {
    return { ok: false, code: 'observation-invalid' };
  }
  // Digest records are rebuilt from CURRENT disk bytes (never from the
  // recorded observation itself): an edited or renamed input must name its
  // field and flip the recomputed binding.
  const freshRecords = [];
  const freshByPath = new Map();
  for (const input of recordedInputs) {
    const read = await readRequirementDocument(root, input.path, options);
    freshRecords.push({
      path: input.path,
      sha256: read.ok ? read.sha256 : (read.sha256 ?? null),
      bytes: read.bytes?.length ?? 0,
      kind: read.kind,
    });
    freshByPath.set(input.path, read.ok ? { bytes: read.bytes, sha256: digest(read.bytes) } : null);
  }
  // Quote spans must sit inside the recorded source bytes and carry the
  // recorded document digest. When the current disk bytes still match the
  // recorded document digest, the recorded span digest must also match the
  // actual span bytes: a saved observation whose quote_span.span_sha256 was
  // edited is internal tampering, not a freshness verdict.
  for (const pair of recordedPairs) {
    if (pair?.quote_span === null || pair?.quote_span === undefined) continue;
    const input = inputsByPath.get(pair.source_path);
    if (!input || input.kind !== 'file') return { ok: false, code: 'observation-invalid' };
    const { start, end } = pair.quote_span;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > (input.bytes ?? 0)) {
      return { ok: false, code: 'observation-invalid' };
    }
    if (pair.quote_span.document_sha256 !== `sha256:${input.sha256}`) {
      return { ok: false, code: 'observation-invalid' };
    }
    const fresh = freshByPath.get(pair.source_path);
    if (fresh !== null && fresh !== undefined && fresh.sha256 === input.sha256
      && pair.quote_span.span_sha256 !== `sha256:${digest(fresh.bytes.subarray(start, end))}`) {
      return { ok: false, code: 'observation-invalid' };
    }
  }
  const context = await currentClaimEvidenceContext(root, freshRecords, options);
  for (const digestRecord of context.inputDigests) {
    const recorded = recordedInputs.find((candidate) => candidate?.path === digestRecord.path);
    if (!recorded || (recorded.sha256 ?? null) !== digestRecord.sha256 || (recorded.bytes ?? 0) !== digestRecord.bytes) {
      mismatched.push(`inputs:${digestRecord.path}`);
    }
  }
  // File-transport envelopes are re-read and compared by content: the
  // presented pairs file is binding input just like the sources, so an
  // edited quote or declared revision must invalidate the observation.
  // A stdin envelope no longer exists on disk; its content digest stays
  // recorded in the transport section as provenance only.
  if (observation.transport?.mode === 'file' && typeof observation.transport?.envelope_path === 'string') {
    let currentEnvelopeBytes = null;
    try {
      currentEnvelopeBytes = await readProviderFile(root, observation.transport.envelope_path, MAX_ENVELOPE_BYTES);
    } catch {
      currentEnvelopeBytes = null;
    }
    if (currentEnvelopeBytes === null || digest(currentEnvelopeBytes) !== observation.transport.envelope_sha256) {
      mismatched.push('envelope');
    }
  }
  const recordedEngine = observation.engine ?? {};
  if ((recordedEngine.module ?? null) !== context.engine.module
    || (recordedEngine.sha256 ?? null) !== context.engine.sha256
    || (recordedEngine.parser_version ?? null) !== context.engine.parser_version) mismatched.push('engine');
  const recordedHelper = observation.helper ?? {};
  if ((recordedHelper.module ?? null) !== context.helper.module
    || (recordedHelper.sha256 ?? null) !== context.helper.sha256) mismatched.push('helper');
  const recordedContract = observation.contract ?? {};
  if ((recordedContract.name ?? null) !== context.contract.name
    || (recordedContract.sha256 ?? null) !== context.contract.sha256) mismatched.push('contract');
  const recordedRubric = observation.rubric ?? {};
  if ((recordedRubric.id ?? null) !== context.rubric.id
    || (recordedRubric.version ?? null) !== context.rubric.version) mismatched.push('rubric');
  const documents = [];
  for (const input of recordedInputs) {
    const read = await readRequirementDocument(root, input.path, options);
    if (read.ok) documents.push(read);
  }
  const resolved = resolveProseLanguage(documents, null);
  if ((observation.language ?? 'unknown') !== (documents.length === 0 ? 'unknown' : resolved.language)) mismatched.push('language');
  const carrierInput = recordedInputs.find((input) => input?.path === observation.structural?.carrier?.path) ?? null;
  const binding = buildAssessmentBinding(claimEvidenceBindingObject({
    worktreeIdentity,
    changeId: normalized.changeId,
    carrier: observation.structural?.carrier ?? null,
    claimRefs: claimRefRecordsFromPairs(recordedPairs),
    inputDigests: context.inputDigests,
    checkedScope: observation.structural?.checked_scope ?? '',
    truncation: observation.structural
      ? { envelope_truncated: false, pairs_truncated: false, sources_truncated: recordedPairs.some((pair) => pair?.quote_check === 'truncated') }
      : { envelope_truncated: false, pairs_truncated: false, sources_truncated: false },
    transport: observation.transport ?? null,
    rubric: context.rubric,
    engine: context.engine,
    helper: context.helper,
    contract: context.contract,
    languageOptions: { override: null, resolved: documents.length === 0 ? 'unknown' : resolved.language },
    exclusionPolicy: { ...CLAIM_EVIDENCE_EXCLUSION_POLICY },
  }));
  if (binding !== observation.binding) mismatched.push('binding');
  return { ok: true, stale: mismatched.length > 0, mismatched: [...new Set(mismatched)], state: mismatched.length > 0 ? 'stale-observation' : null, carrier: carrierInput };
}

function claimRefRecordsFromPairs(pairs) {
  return [...pairs].map((pair) => ({
    claim_id: pair.claim_id,
    parent_claim_id: pair.parent_claim_id ?? null,
    claim_ref: pair.claim_ref ?? null,
    source_path: pair.source_path,
    source_span: pair.source_span ?? null,
    relation: pair.relation,
    quote_sha256: pair.quote_sha256 ?? null,
    known_source_revision: pair.known_source_revision ?? null,
  })).sort((left, right) => (left.claim_id < right.claim_id ? -1 : left.claim_id > right.claim_id ? 1 : 0));
}

// ---------------------------------------------------------------------------
// Observation writer (state-only; guards fail closed before the first write)
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

export async function writeClaimEvidenceObservation(rootDir, observation, config, options = {}) {
  const normalized = normalizeChangeId(observation.change_id);
  if (!normalized.ok) return { ok: false, code: 'invalid-change-id' };
  // Custom state roots are refused (owner-approved narrowing): the QA
  // projection covers only the default state root, so an observation under a
  // custom root would silently change required QA surfaces.
  const rawState = config.stateRootRaw;
  const stateRoot = normalizeConfigPath(rawState === undefined ? config.stateRoot : rawState);
  if (stateRoot === null) return { ok: false, code: 'state-root-mismatch', detail: String(rawState) };
  if (stateRoot !== STATE_ROOT) return { ok: false, code: 'state-root-mismatch', detail: stateRoot };
  const paths = claimEvidencePaths(normalized.changeId);
  const relative = paths.observation;
  const rawQa = config.qaRootRaw;
  const qaRoot = canonicalizeConfigRoot(rawQa === undefined ? QA_ROOT : rawQa);
  if (qaRoot === null) return { ok: false, code: 'qa-root-unsafe', detail: String(rawQa ?? QA_ROOT) };
  if (withinCi(`${qaRoot}/`, relative) || relative.toLowerCase() === qaRoot.toLowerCase()) {
    return { ok: false, code: 'qa-namespace-conflict', detail: relative };
  }
  const root = await realpath(options.rootDir ?? rootDir);
  const parts = relative.split('/');
  // Read-only sources: the observation destination must never equal a
  // presented input or the presented envelope file — the writer would
  // overwrite exactly the material the scan claims to describe. The
  // collision set covers every presented source path, the carrier, and (for
  // file transport) the envelope path itself.
  const outputLower = relative.toLowerCase();
  const presented = [
    ...(observation.inputs ?? []).map((input) => input?.path).filter((value) => typeof value === 'string'),
    observation.transport?.mode === 'file' && typeof observation.transport?.envelope_path === 'string'
      ? observation.transport.envelope_path
      : null,
  ].filter((value) => value !== null);
  const sourceCollision = presented.find((presentedPath) => normalizeConfigPath(presentedPath)?.toLowerCase() === outputLower);
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
  // same change may be replaced — a matching schema+change_id pair alone is
  // not ownership, and an unreadable previous leaf (oversized, unsafe) cannot
  // prove ownership at all, so it fails closed.
  const schemaBytes = await readFile(new URL(`../${CONTRACT_MODULE}`, import.meta.url), 'utf8');
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
    if (!prior || prior.schema !== CLAIM_EVIDENCE_SCHEMA || prior.change_id !== observation.change_id) return leafConflict();
    if (validateJsonAgainstSchema(prior, schema).length !== 0) return leafConflict();
    return null;
  };
  const firstRejection = await assertLeafWritable();
  if (firstRejection) return firstRejection;
  // QA isolation guard: the writer refuses a tracked or
  // not-effectively-ignored output for EVERY path it may create — the
  // observation and the namespace .gitignore. The QA snapshot's
  // `actual_diff` channel (git diff --binary HEAD) has no namespace filter,
  // so restoring a tracked-then-deleted namespace gitignore would shift
  // required QA surfaces exactly like a tracked observation would.
  const gitGuard = options.gitGuard ?? verifyObservationIgnored;
  const gitignoreRelative = `${paths.directory}/.gitignore`;
  for (const guarded of [relative, gitignoreRelative]) {
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
  // the same real path (no symlink/junction swap).
  let liveDirectory;
  try {
    liveDirectory = await realpath(directory);
  } catch (error) {
    return { ok: false, code: 'observation-write-failed', detail: String(error?.message ?? error).slice(0, 200) };
  }
  if (path.resolve(liveDirectory).toLowerCase() !== path.resolve(directory).toLowerCase()) {
    return { ok: false, code: 'file-shadow', detail: parts.slice(0, -1).join('/') };
  }
  const secondRejection = await assertLeafWritable();
  if (secondRejection) return secondRejection;
  // Atomic write owned by this module (readability writer model): the third
  // ownership check runs after the temporary write and immediately before the
  // rename, closing the check-then-rename window a foreign replacement could
  // otherwise slip through. Destination and temporary are re-validated through
  // safeProviderPath (containment, no symlinks, identity) right before the
  // rename.
  const payload = `${JSON.stringify(observation, null, 2)}\n`;
  const temporary = path.join(liveDirectory, `${parts[parts.length - 1]}.${randomUUID()}.tmp`);
  const openFile = options.openFile ?? open;
  let renamed = false;
  try {
    await safeProviderPath(root, relative);
    const handle = await openFile(temporary, 'wx', 0o600);
    try { await handle.writeFile(payload, 'utf8'); } finally { await handle.close(); }
    // Controlled TOCTOU probe seam: the hook fires in the vulnerable window
    // (after the temp write, before the final ownership check + rename), so
    // a test can deterministically swap the leaf and prove the final checks
    // catch it.
    if (typeof options.beforeRename === 'function') await options.beforeRename();
    const thirdRejection = await assertLeafWritable();
    if (thirdRejection) return thirdRejection;
    await safeProviderPath(root, relative);
    await safeProviderPath(root, path.posix.join(...parts.slice(0, -1), path.basename(temporary)));
    await rename(temporary, leaf);
    renamed = true;
    return { ok: true, path: relative };
  } catch (error) {
    return { ok: false, code: 'observation-write-failed', detail: String(error?.message ?? error).slice(0, 200) };
  } finally {
    // A failed create/write must not leave a partial temporary behind; after a
    // successful rename the temporary no longer exists (ENOENT is expected).
    if (!renamed) await unlink(temporary).catch(() => {});
  }
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

function failureEnvelope(state, codes) {
  return { schema_version: 1, diagnostic_only: true, state, codes, message: NOT_RUN_MESSAGE, usage, authorizes: [] };
}

function renderHuman(value) {
  if (!value || typeof value !== 'object') return String(value);
  if (value.schema_version === 1) {
    const lines = [`Claim evidence check (advisory): ${value.state}`];
    for (const code of value.codes ?? []) lines.push(`  diagnostic: ${code}`);
    if (value.message) lines.push(value.message);
    lines.push(`Usage: ${value.usage ?? usage}`);
    return lines.join('\n');
  }
  const lines = [
    `Claim evidence check (advisory, no gate evidence): change ${value.change_id}`,
    `Structural: ${value.structural?.outcome_summary?.total ?? 0} pairs (exact_found: ${value.structural?.outcome_summary?.by_quote_check?.exact_found ?? 0}, not_found: ${value.structural?.outcome_summary?.by_quote_check?.not_found ?? 0}, out_of_context: ${value.structural?.outcome_summary?.by_quote_check?.literal_match_out_of_context ?? 0}, unavailable: ${(value.structural?.outcome_summary?.by_quote_check?.source_unavailable ?? 0) + (value.structural?.outcome_summary?.by_quote_check?.truncated ?? 0)}, n/a: ${value.structural?.outcome_summary?.by_quote_check?.not_applicable ?? 0}); stale revision metadata: ${value.structural?.outcome_summary?.by_known_revision?.changed ?? 0}`,
    `Semantic: ${value.semantic?.run_status}${value.semantic?.abstained ? ' (abstained)' : ''}; freshness: ${value.semantic?.freshness}; coverage: ${value.semantic?.coverage?.state}`,
  ];
  if (value.semantic?.run_status !== 'complete' || value.semantic?.abstained || value.semantic?.freshness !== 'current' || value.semantic?.coverage?.state !== 'full') {
    lines.push('Degraded semantic outcome — this is NOT a zero-findings result.');
  }
  for (const parent of value.compound?.parents ?? []) {
    lines.push(`  compound ${parent.claim_id}: ${parent.verdict} (${parent.parts.join(', ')})`);
  }
  for (const pair of value.structural?.pairs ?? []) {
    lines.push(`  ${pair.claim_id} <- ${pair.source_path} [${pair.relation}]: ${pair.quote_check}${pair.known_revision !== 'not_declared' ? `; known_revision: ${pair.known_revision}` : ''}`);
  }
  for (const diagnostic of value.diagnostics ?? []) {
    lines.push(`  diagnostic: ${diagnostic.code}${diagnostic.path ? ` (${diagnostic.path})` : ''}${diagnostic.detail ? ` — ${diagnostic.detail}` : ''}`);
  }
  lines.push('This diagnostic never verifies facts and never authorizes progression.');
  return lines.join('\n');
}

export async function runClaimEvidenceCheckCommand(argv = process.argv.slice(2), options = {}) {
  const output = options.output ?? ((value) => process.stdout.write(value));
  const emit = (value, json) => output(json ? `${JSON.stringify(value, null, 2)}\n` : `${renderHuman(value)}\n`);
  const now = options.now ?? Date.now;
  const startedAt = now();

  const parsed = parseClaimEvidenceArgs(argv);
  if (!parsed.ok) {
    emit(notRunEnvelope(['invalid-usage', parsed.error]), parsed.json);
    return 2;
  }
  let rootDir;
  try {
    rootDir = await realpath(options.rootDir ?? process.cwd());
  } catch {
    process.stderr.write('claim-evidence-check: project root is unreadable\n');
    return 1;
  }
  const config = options.config ?? await readClaimEvidenceConfig(rootDir, options);
  const cliEnabled = parsed.enabled;
  const enabled = config.enabledMalformed ? false : (cliEnabled ?? config.enabled);
  const configCodes = (config.diagnostics ?? [])
    .filter((diagnostic) => String(diagnostic.code).startsWith('claim-evidence:')
      || diagnostic.code === 'config-unreadable' || diagnostic.code === 'config-malformed')
    .map((diagnostic) => diagnostic.code);
  if (enabled !== true) {
    const codes = configCodes.length > 0
      ? ['claim-evidence-disabled', ...configCodes.slice(0, 11)]
      : ['claim-evidence-disabled'];
    emit(notRunEnvelope(codes), parsed.json);
    return 0;
  }
  if (typeof parsed.changeId !== 'string') {
    emit(notRunEnvelope(['missing-change']), parsed.json);
    return 2;
  }
  if (parsed.changeId.length < 1 || parsed.changeId.length > 200 || !/^[A-Za-z0-9._-]+$/.test(parsed.changeId)) {
    emit(notRunEnvelope(['invalid-change-id']), parsed.json);
    return 2;
  }
  const normalizedChange = normalizeChangeId(parsed.changeId);
  if (!normalizedChange.ok) {
    emit(notRunEnvelope(['invalid-change-id']), parsed.json);
    return 2;
  }
  const changeId = normalizedChange.changeId;
  const transport = parsed.stdin && parsed.pairsPath !== null
    ? { mode: null, envelope_path: null }
    : { mode: parsed.stdin ? 'stdin' : 'file', envelope_path: parsed.stdin ? null : parsed.pairsPath };
  if (transport.mode === null) {
    emit(notRunEnvelope(['invalid-usage', 'use --pairs or --stdin, not both']), parsed.json);
    return 2;
  }
  if (transport.mode === 'file' && typeof transport.envelope_path !== 'string') {
    emit(notRunEnvelope(['empty-input']), parsed.json);
    return 2;
  }
  if (transport.mode === 'file' && !validateFileForm(transport.envelope_path)) {
    emit(notRunEnvelope([`unsafe-file:${transport.envelope_path}`]), parsed.json);
    return 2;
  }

  try {
    const diagnostics = [...(config.diagnostics ?? [])];
    // Envelope bytes are read before any presented input is read: the
    // allowlist (carrier + sources, plus the envelope path for file
    // transport) is fixed from the presented inputs first (D5).
    let envelopeBytes = null;
    if (transport.mode === 'file') {
      try {
        envelopeBytes = await readProviderFile(rootDir, transport.envelope_path, MAX_ENVELOPE_BYTES);
      } catch (error) {
        emit(notRunEnvelope([`envelope-unreadable:${String(error?.message ?? error).slice(0, 60)}`]), parsed.json);
        return 2;
      }
      if (envelopeBytes === null) {
        emit(notRunEnvelope(['envelope-missing']), parsed.json);
        return 2;
      }
    } else {
      const reader = options.readStdin ?? readStdinBounded;
      try {
        envelopeBytes = await reader(MAX_ENVELOPE_BYTES);
      } catch (error) {
        emit(notRunEnvelope([`envelope-unreadable:${String(error?.message ?? error).slice(0, 60)}`]), parsed.json);
        return 2;
      }
    }
    let envelopeValue;
    try {
      envelopeValue = parseStrictJson(envelopeBytes.toString('utf8'));
    } catch {
      emit(notRunEnvelope(['invalid-envelope:malformed-json']), parsed.json);
      return 2;
    }
    const envelopeVerdict = validatePairsEnvelope(envelopeValue);
    if (!envelopeVerdict.ok) {
      emit(notRunEnvelope([`invalid-envelope:${envelopeVerdict.error.slice(0, 120)}`]), parsed.json);
      return 2;
    }
    const envelope = envelopeVerdict.envelope;
    const sourcePaths = [...new Set(envelope.claims.map((claim) => claim.source_ref.path))];
    if (sourcePaths.length > MAX_SOURCES) {
      emit(notRunEnvelope(['sources-limit-exceeded']), parsed.json);
      return 2;
    }
    // The carrier may itself be a presented source: read every unique
    // presented path exactly once so identity digests never duplicate.
    const readInputs = [...new Set([envelope.carrier.path, ...sourcePaths])];
    const inputs = [];
    for (const relative of readInputs) {
      const read = await readRequirementDocument(rootDir, relative, options);
      inputs.push({
        path: relative,
        sha256: read.ok ? read.sha256 : (read.sha256 ?? null),
        bytes: read.bytes?.length ?? 0,
        data: read.bytes,
        kind: read.kind,
        code: read.code,
        ok: read.ok,
        text: read.text,
      });
      if (!read.ok) diagnostics.push({ code: read.code === 'file-missing' ? 'file-missing' : 'malformed-input', path: relative, detail: read.code });
    }
    const sourceBytesByPath = new Map(sourcePaths.map((relative) => {
      const input = inputs.find((candidate) => candidate.path === relative);
      return [relative, input];
    }));
    // Input spans are range-checked against the read bytes BEFORE any
    // structural work: an out-of-document span is a typed refusal (exit 2),
    // never a clamp (D4).
    for (const claim of envelope.claims) {
      const span = claim.source_ref.span;
      if (!span) continue;
      const input = sourceBytesByPath.get(claim.source_ref.path);
      if (input.ok && span.end > input.bytes) {
        emit(notRunEnvelope([`invalid-envelope:span-out-of-range:${claim.claim_id}`]), parsed.json);
        return 2;
      }
    }
    const structuralPairs = [];
    const missingSources = [];
    for (const claim of envelope.claims) {
      const input = sourceBytesByPath.get(claim.source_ref.path);
      const checked = checkStructuralPair(claim, input.data, input.sha256, input.ok, input);
      structuralPairs.push(checked.record);
      if (checked.missing) missingSources.push(checked.missing);
    }
    // Missing sources are deduplicated by path with first-occurrence order
    // (#282): several claims citing the same unavailable source collapse to
    // one list entry, while the per-pair counter keeps the true number of
    // missing pairs (pre-dedup, pre-cap) so `scanned = declared − count`
    // stays pair-exact and the list stays bound to the counter.
    const missingSourcesCount = missingSources.length;
    const seenMissingPaths = new Set();
    const missingSourcesDeduped = [];
    for (const entry of missingSources) {
      if (seenMissingPaths.has(entry.path)) continue;
      seenMissingPaths.add(entry.path);
      missingSourcesDeduped.push(entry);
    }
    // The 100-entry cap applies to the LIST only (schema maxItems), never to
    // the counter; tripping it records a diagnostic-only truncation marker
    // (no new schema field) and coverage never upgrades to full. Unreachable
    // with MAX_CLAIM_PAIRS=50, kept as schema-parity defense.
    if (missingSourcesDeduped.length > MAX_MISSING_SOURCE_ENTRIES) {
      diagnostics.push({ code: 'missing-sources-truncated', path: null, detail: `limit=${MAX_MISSING_SOURCE_ENTRIES}` });
      missingSourcesDeduped.length = MAX_MISSING_SOURCE_ENTRIES;
    }

    const context = await currentClaimEvidenceContext(rootDir, inputs, options);
    const documents = inputs.filter((input) => input.ok).map((input) => ({ text: input.text }));
    const prose = resolveProseLanguage(documents, null);
    const resolvedLanguage = documents.length > 0 ? prose.language : 'unknown';
    const worktreeIdentity = await computeWorktreeIdentity(rootDir, options);
    // Coverage counts presented sources (not read records): a carrier that is
    // itself the only presented source is one honest scanned input, not a
    // silent zero.
    const scannedSources = sourcePaths.filter((relative) => sourceBytesByPath.get(relative)?.ok === true).length;
    const semanticCoverage = {
      state: structuralPairs.length === 0 || scannedSources === 0 ? 'none' : (missingSources.length === 0 ? 'full' : 'partial'),
      declared_sources: structuralPairs.length,
      scanned_sources: structuralPairs.length - missingSourcesCount,
      missing_sources: missingSourcesDeduped,
      missing_sources_count: missingSourcesCount,
    };
    const envelopeSha256 = digest(envelopeBytes);
    const transportRecord = { mode: transport.mode, envelope_path: transport.mode === 'file' ? transport.envelope_path : null, envelope_sha256: envelopeSha256 };
    const binding = buildAssessmentBinding(claimEvidenceBindingObject({
      worktreeIdentity,
      changeId,
      carrier: { path: envelope.carrier.path, sha256: inputs.find((input) => input.path === envelope.carrier.path)?.sha256 ?? null, bytes: inputs.find((input) => input.path === envelope.carrier.path)?.bytes ?? 0, kind: inputs.find((input) => input.path === envelope.carrier.path)?.kind ?? 'missing' },
      claimRefs: claimRefRecords(envelope),
      inputDigests: context.inputDigests,
      checkedScope: envelope.checked_scope,
      truncation: { envelope_truncated: false, pairs_truncated: false, sources_truncated: missingSources.some((entry) => entry.reason === 'file_limit' || entry.reason === 'unsafe_file') },
      transport: transportRecord,
      rubric: context.rubric,
      engine: context.engine,
      helper: context.helper,
      contract: context.contract,
      languageOptions: { override: null, resolved: resolvedLanguage },
      exclusionPolicy: { ...CLAIM_EVIDENCE_EXCLUSION_POLICY },
    }));

    // Post-scan freshness probe: re-reads current disk state and compares the
    // recomputed binding against the one built from the scanned bytes, so a
    // mid-scan swap yields stale, not a silent current.
    const watch = {
      changed: async () => {
        // The presented pairs file is binding input just like the sources
        // (R2-1): for file transport the probe re-reads it bounded and
        // compares content digests, so a mid-run change, deletion, or
        // unreadable/oversized envelope drifts exactly like a source swap.
        // A stdin envelope has no disk state to re-read; its recorded digest
        // stays provenance only.
        if (transportRecord.mode === 'file' && typeof transportRecord.envelope_path === 'string') {
          let currentEnvelopeBytes = null;
          try {
            currentEnvelopeBytes = await readProviderFile(rootDir, transportRecord.envelope_path, MAX_ENVELOPE_BYTES);
          } catch {
            currentEnvelopeBytes = null;
          }
          if (currentEnvelopeBytes === null || digest(currentEnvelopeBytes) !== transportRecord.envelope_sha256) {
            return true;
          }
        }
        const freshInputs = [];
        for (const relative of readInputs) {
          const read = await readRequirementDocument(rootDir, relative, options);
          freshInputs.push({ path: relative, sha256: read.ok ? read.sha256 : (read.sha256 ?? null), bytes: read.bytes?.length ?? 0, kind: read.kind });
        }
        const current = await currentClaimEvidenceContext(rootDir, freshInputs, options);
        return buildAssessmentBinding(claimEvidenceBindingObject({
          worktreeIdentity: await computeWorktreeIdentity(rootDir, options),
          changeId,
          carrier: { path: envelope.carrier.path, sha256: freshInputs.find((input) => input.path === envelope.carrier.path)?.sha256 ?? null, bytes: freshInputs.find((input) => input.path === envelope.carrier.path)?.bytes ?? 0, kind: freshInputs.find((input) => input.path === envelope.carrier.path)?.kind ?? 'missing' },
          claimRefs: claimRefRecords(envelope),
          inputDigests: current.inputDigests,
          checkedScope: envelope.checked_scope,
          truncation: { envelope_truncated: false, pairs_truncated: false, sources_truncated: missingSources.some((entry) => entry.reason === 'file_limit' || entry.reason === 'unsafe_file') },
          transport: transportRecord,
          rubric: current.rubric,
          engine: current.engine,
          helper: current.helper,
          contract: current.contract,
          languageOptions: { override: null, resolved: resolvedLanguage },
          exclusionPolicy: { ...CLAIM_EVIDENCE_EXCLUSION_POLICY },
        })) !== binding;
      },
    };

    // The semantic stage is opt-in-DI only in this phase: without an injected
    // assessor the helper returns an honest not_run, and the deterministic
    // structural results above stay intact in their own section.
    const assessorInput = {
      pairs: structuralPairs.map((pair) => ({
        claim_id: pair.claim_id,
        parent_claim_id: pair.parent_claim_id,
        relation: pair.relation,
        quote_check: pair.quote_check,
        known_revision: pair.known_revision,
        source_path: pair.source_path,
        quote_sha256: pair.quote_sha256,
      })),
      language: resolvedLanguage,
    };
    const semanticOutcome = await runTypedAssessment({
      assessor: typeof options.assessor === 'function' ? options.assessor : null,
      input: assessorInput,
      coverage: semanticCoverage,
      limits: { deadlineMs: options.deadlineMs ?? DEFAULT_DEADLINE_MS, maxFindings: MAX_CLAIM_PAIRS, maxDiagnostics: MAX_DIAGNOSTICS },
      watch,
      now,
    });
    const semantic = normalizeSemanticOutcome(semanticOutcome, new Set(envelope.claims.map((claim) => claim.claim_id)));
    const compound = computeCompoundParents(envelope, semantic);
    // Coverage degradations established by the helper (findings truncation,
    // scanned/declared clamps) are authoritative for a stage that actually
    // ran: the engine merges to the honest direction instead of re-asserting
    // its own pre-scan estimate. A not_run/failed stage keeps the engine's
    // estimate of the presented sources (the helper's empty coverage is a
    // placeholder for "never scanned", not a degradation of what was read).
    // An abstention keeps the helper's contract at the observation level
    // too: the stage presented nothing, so the section never claims scanned
    // coverage even when every source was readable.
    const coverageRank = { none: 0, partial: 1, full: 2 };
    const helperRan = semanticOutcome.run_status === 'complete';
    const helperCoverageState = helperRan && coverageRank[semanticOutcome.coverage?.state] !== undefined
      ? semanticOutcome.coverage.state
      : semanticCoverage.state;
    const mergedCoverageState = coverageRank[semanticCoverage.state] <= coverageRank[helperCoverageState] ? semanticCoverage.state : helperCoverageState;
    const presentedCoverage = semantic.abstained ? { ...semanticCoverage, state: 'none' } : { ...semanticCoverage, state: mergedCoverageState };

    // semantic.diagnostics already carries the helper diagnostics exactly
    // once (validated at the semantic boundary) — never merge them again.
    const combinedDiagnostics = [...semantic.diagnostics, ...diagnostics];
    if (combinedDiagnostics.length > MAX_DIAGNOSTICS) {
      combinedDiagnostics.length = Math.max(1, MAX_DIAGNOSTICS - 1);
      combinedDiagnostics.push({ code: 'diagnostics-truncated', path: null, detail: `limit=${MAX_DIAGNOSTICS}` });
    }
    const structural = {
      checkedScope: envelope.checked_scope,
      carrier: { path: envelope.carrier.path, sha256: inputs.find((input) => input.path === envelope.carrier.path)?.sha256 ?? null, bytes: inputs.find((input) => input.path === envelope.carrier.path)?.bytes ?? 0, kind: inputs.find((input) => input.path === envelope.carrier.path)?.kind ?? 'missing' },
      pairs: structuralPairs,
      missingSources: missingSourcesDeduped,
    };
    const observation = assembleObservation({
      changeId,
      generatedAt: new Date(startedAt).toISOString(),
      structural,
      semantic: {
        run_status: semantic.run_status,
        freshness: semantic.freshness,
        abstained: semantic.abstained,
        outcome_reason: semantic.outcome_reason,
        coverage: presentedCoverage,
        assessments: semantic.assessments,
      },
      compound,
      inputs,
      transport: transportRecord,
      context,
      language: resolvedLanguage,
      languageSource: prose.source,
      worktreeIdentity,
      binding,
      diagnostics: combinedDiagnostics,
    });
    const schemaBytes = await readFile(new URL(`../${CONTRACT_MODULE}`, import.meta.url), 'utf8');
    const schema = parseStrictJson(schemaBytes);
    const schemaErrors = validateJsonAgainstSchema(observation, schema);
    if (schemaErrors.length > 0) {
      emit(failureEnvelope('operational-failure', ['schema-parity-failure', ...schemaErrors.slice(0, 5).map((error) => error.message)]), parsed.json);
      return 1;
    }
    if (parsed.write) {
      const written = await writeClaimEvidenceObservation(rootDir, observation, config, options);
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

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runClaimEvidenceCheckCommand();
}
