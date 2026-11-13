// Opt-in, advisory trace-link suggestion producer for OpenSpec-native /aif-review
// and /aif-improve (issue #283). Read-only semantic suggestions of
// requirement -> semantic symbol -> scenario/test links as a typed graph of
// nodes and edges (N:M via explicit edges, no cross-product). This is a
// structural diagnostic, never a verifier and never proof coverage: it never
// creates an `aif-gate-result`, never writes QA evidence or `coverage.json`,
// never edits canonical or spec artifacts, and never grants workflow authority
// (frozen #228 boundary). Topic match is the ceiling for `related_only`; a
// `candidate` outcome requires behavioral anchors that resolve to real bytes.
// The trace manifest is read by this engine's own custody reader over
// `readProviderFile`/`safeProviderPath` (the module-private `traceArgs` rules
// are mirrored, not imported): only this change's own custody directory, the
// 32 MiB export limit, and symlink/hardlink refusal. Presented requirement and
// test text is data, never commands: the default path opens no URLs, reads no
// paths out of the text, and the test allowlist is built from the explicitly
// presented `--test` inputs before any read. Without an injected assessor the
// semantic stage reports an honest `not_run`; errors, abstentions, and
// deadline cutoffs are never coerced into a positive verdict.
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readdir, readFile, realpath, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { digest, portablePath } from './workflow-state-store.mjs';
import { parseStrictJson } from './json-strict.mjs';
import { validateJsonAgainstSchema } from './json-schema-subset.mjs';
import { readProviderFile, safeProviderPath } from './provider-files.mjs';
import { ensureRuntimeGitignore } from './runtime-gitignore.mjs';
import { verifyObservationIgnored } from './requirement-lint-git-guard.mjs';
import { resolveProseLanguage } from './requirement-lint.mjs';
import { createMarkdownCodeMask } from './markdown-structural-markers.mjs';
import {
  assessmentDigest,
  buildAssessmentBinding,
  notRunAssessment,
  runTypedAssessment,
} from './typed-assessment.mjs';

export const TRACE_LINK_SCHEMA = 'aifhub.trace_link_suggestions_observation.v1';
export const TRACE_LINK_CONSUMER_ID = 'trace_link_suggestions';
export const TRACE_LINK_NAMESPACE = 'trace-link-suggestions';
export const STATE_ROOT = '.ai-factory/state';
export const QA_ROOT = '.ai-factory/qa';
export const ENGINE_MODULE = 'scripts/trace-link-suggestions.mjs';
export const HELPER_MODULE = 'scripts/typed-assessment.mjs';
export const CONTRACT_MODULE = 'schemas/trace-link-suggestion-observation.schema.json';
export const PARSER_VERSION = 1;
export const DOCUMENT_LIMIT = 1024 * 1024;
export const MAX_TEST_INPUTS = 50;
export const MAX_DIAGNOSTICS = 200;
export const DEFAULT_DEADLINE_MS = 30000;
export const NOT_RUN_MESSAGE = 'advisory scan was not performed';
export const TRACE_EXPORT_LIMIT = 33554432; // LEKALO_WORKFLOW_CONTRACT.maxExportBytes (own constant; not imported)
export const TRACE_CUSTODY_ROOT = '.ai-factory/traces';
export const TRACE_MANIFEST_FILE = 'lekalo-trace-manifest.json';
export const TRACE_SCHEMA_VERSION = 'lekalo/trace-manifest/v0.2.16';
export const TRACE_IDENTITY = 'dev.lekalo.trace-manifest@0.2.16';
// Closed engine-owned trace-node kind support (P0): only these four prefixes
// resolve into graph nodes; other form-valid prefixes are bounded diagnostics.
export const SUPPORTED_TRACE_KINDS = Object.freeze(['requirement', 'scenario', 'operation', 'endpoint']);
// The Lekalo symbol form (shape only — existence is resolved against parsed
// trace nodes): mirror of the form regex in scripts/lekalo-provider.mjs:25-26.
export const TRACE_SYMBOL_FORM = /^(project|module|type|entity|operation|policy|event|effect|endpoint|scenario|target-binding|requirement):[A-Za-z0-9][A-Za-z0-9._:-]*$/;
export const TRACE_LINK_RUBRIC = Object.freeze({ id: 'trace-link-structural-default', version: 1 });
export const RELATION_POLICY = Object.freeze({
  id: 'trace-link-relations-v1',
  version: 1,
  relations: Object.freeze([
    Object.freeze({ relation: 'requirement_symbol', from_kind: 'requirement', to_kind: 'semantic_symbol' }),
    Object.freeze({ relation: 'symbol_scenario', from_kind: 'semantic_symbol', to_kind: 'scenario' }),
    Object.freeze({ relation: 'symbol_test', from_kind: 'semantic_symbol', to_kind: 'test' }),
    Object.freeze({ relation: 'scenario_test', from_kind: 'scenario', to_kind: 'test' }),
  ]),
});
export const TRACE_LINK_EXCLUSION_POLICY = Object.freeze({ id: 'none', version: 1 });
export const GRAPH_LIMITS = Object.freeze({
  max_nodes: 500,
  max_edges: 1000,
  max_total_elements: 1500,
  max_assertion_refs_per_edge: 50,
  max_observation_bytes: 1024 * 1024,
  max_diagnostics: 200,
});
export const STRUCTURAL_OUTCOMES = Object.freeze(['candidate', 'related_only', 'none', 'abstain']);
export const EDGE_OUTCOMES = Object.freeze(['candidate', 'related_only']);
export const NOT_RUN_CODES = Object.freeze([
  'trace-missing', 'trace-custody', 'export-overflow', 'trace-invalid', 'trace-changed',
]);
export const usage = 'ai-factory aifhub-trace-link-suggestions --change <id> [--enabled true|false] [--test <path> ...] [--json] [--write]';
// Single change-id form (custody contract `safeId`): stricter than the #282
// observation schema, validated explicitly before any read (decision 7).
export const CHANGE_ID_FORM = /^[a-z0-9][a-z0-9-]{0,99}$/;
// Coverage-fact diagnostics survive the bounded diagnostics budget (S3):
// a consumer must see that missing_sources or the anchor scan was truncated
// even when ordinary diagnostics fill the budget.
export const COVERAGE_FACT_DIAGNOSTIC_CODES = Object.freeze(new Set([
  'missing-sources-truncated',
  'delta-spec-inventory-truncated',
  'anchor-scan-truncated',
  'assertion-refs-truncated',
  'declared-sources-truncated',
  'graph-truncated',
]));
// Mirror of the frozen TEST_PATH_PATTERN shape (scripts/openspec-coverage-matrix.mjs:27,
// module-private): presented test inputs must match this form; conformance
// parity is pinned on shared fixtures.
export const TEST_PATH_FORM = /(^|\/)(test|tests|__tests__)\/|[._-](test|spec)\.[A-Za-z0-9]+$/i;

export function traceLinkPaths(changeId) {
  if (typeof changeId !== 'string' || !CHANGE_ID_FORM.test(changeId)) throw new Error('invalid-change-id');
  return {
    directory: `${STATE_ROOT}/${changeId}/${TRACE_LINK_NAMESPACE}`,
    observation: `${STATE_ROOT}/${changeId}/${TRACE_LINK_NAMESPACE}/observation.json`,
  };
}

export function traceManifestPath(changeId) {
  if (typeof changeId !== 'string' || !CHANGE_ID_FORM.test(changeId)) throw new Error('invalid-change-id');
  return `${TRACE_CUSTODY_ROOT}/${changeId}/${TRACE_MANIFEST_FILE}`;
}

// ---------------------------------------------------------------------------
// Argument parsing (explicit-only; unknown/duplicate/missing -> invalid usage)
// ---------------------------------------------------------------------------

export function parseTraceLinkArgs(argv) {
  const result = { ok: true, changeId: null, testPaths: [], json: false, write: false, enabled: null, error: null };
  const invalid = (error) => ({ ...result, ok: false, error });
  const seen = new Set();
  const args = Array.from(argv ?? []);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!['--change', '--test', '--enabled', '--json', '--write'].includes(arg)) {
      return invalid(`unknown option: ${arg}`);
    }
    if (arg !== '--test' && seen.has(arg)) return invalid(`duplicate option: ${arg}`);
    if (arg !== '--test') seen.add(arg);
    if (arg === '--json') { result.json = true; continue; }
    if (arg === '--write') { result.write = true; continue; }
    const value = args[index + 1];
    if (typeof value !== 'string' || value.startsWith('--')) return invalid(`missing value for ${arg}`);
    index += 1;
    if (arg === '--change') result.changeId = value;
    else if (arg === '--test') result.testPaths.push(value);
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
// Bounded closed config read for the `aifhub.traceLinkSuggestions` opt-in
// namespace (mirror of the claim-evidence subset parser: explicit detections
// keep the producer off with bounded `trace-link-suggestions:<code>`
// diagnostics; a malformed namespace degrades to "advisory scan was not
// performed" and never becomes a required-gate failure).
// ---------------------------------------------------------------------------

const CHECK_CONFIG_PATH = Object.freeze(['aifhub', 'traceLinkSuggestions']);
const CHECK_CONFIG_CLOSED_KEYS = Object.freeze(new Set(['enabled']));
const CHECK_STRUCTURAL_PATHS = Object.freeze([
  ['aifhub'],
  CHECK_CONFIG_PATH,
  ['paths'],
]);

function checkConfigDiagnostic(code, detail) {
  return { code: `trace-link-suggestions:${code}`, path: '.ai-factory/config.yaml', detail: detail === undefined ? null : String(detail).slice(0, 200) };
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

export function parseTraceLinkSuggestionsConfigSubset(raw) {
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
    if (!match) {
      // A non-mapping line inside a guarded context is a malformed namespace
      // form, never a silent skip: the namespace must not stay enabled
      // because an unparseable line happened to sit next to `enabled: true`.
      const parentPath = stack.at(-1).path;
      if (belowCheck(parentPath) || structural(parentPath)
        || (parentPath.length >= CHECK_CONFIG_PATH.length
          && CHECK_CONFIG_PATH.every((part, index) => parentPath[index] === part))) {
        diagnostics.push(checkConfigDiagnostic('malformed-line', withoutComment.trim().slice(0, 100)));
      }
      continue;
    }
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

export async function readTraceLinkSuggestionsConfig(rootDir, options = {}) {
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
  const parsed = parseTraceLinkSuggestionsConfigSubset(text);
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
  const checkSection = hub && typeof hub === 'object' ? hub.traceLinkSuggestions : undefined;
  if (checkSection !== undefined && (checkSection === null || typeof checkSection !== 'object' || Array.isArray(checkSection))) {
    diagnostics.push(checkConfigDiagnostic('scalarized-section', 'aifhub.traceLinkSuggestions'));
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
// Custody trace reader (solution 3, variant A). Mirrors the module-private
// `traceArgs` rules (scripts/lekalo-provider.mjs:168-188) and the trace-branch
// self-checks of `normalizeLekaloResult` (:138-150) 1:1 — never imports them.
// ---------------------------------------------------------------------------

const SHA256_REF = /^sha256:[a-f0-9]{64}$/;
const HEX64 = /^[a-f0-9]{64}$/;
const SHA256_PREFIX = (hex) => `sha256:${hex}`;

function traceInvalid(reason) {
  return { ok: false, code: 'trace-invalid', detail: String(reason).slice(0, 200) };
}

export async function readTraceManifest(rootDir, changeId, options = {}) {
  // Custody rules first: only this change's own directory below the traces
  // root is ever touched; a foreign path is never read. The whole body is
  // guarded: every refusal — path safety, vanished files (TOCTOU window
  // between path resolution and stat/read), stat errors — is a bounded
  // not_run code, never an exception escaping the {ok, code} contract.
  const relative = traceManifestPath(changeId);
  try {
    let target;
    try {
      target = await safeProviderPath(rootDir, relative);
    } catch (error) {
      return { ok: false, code: 'trace-custody', detail: String(error?.message ?? error).slice(0, 120) };
    }
    if (!target.exists) return { ok: false, code: 'trace-missing', detail: relative };
    let stat;
    try {
      stat = await lstat(target.path);
    } catch (error) {
      return { ok: false, code: error?.code === 'ENOENT' ? 'trace-missing' : 'trace-changed', detail: String(error?.message ?? error).slice(0, 120) };
    }
    if (!stat.isFile()) return { ok: false, code: 'trace-custody', detail: 'not-a-file' };
    if (stat.size > TRACE_EXPORT_LIMIT) return { ok: false, code: 'export-overflow', detail: String(stat.size) };
    const reader = options.readTrace ?? (async (root, rel, limit) => readProviderFile(root, rel, limit));
    let bytes = null;
    try {
      bytes = await reader(rootDir, relative, TRACE_EXPORT_LIMIT);
    } catch (error) {
      const message = String(error?.message ?? error);
      if (message === 'file_limit') {
        return { ok: false, code: 'export-overflow', detail: message.slice(0, 120) };
      }
      if (message === 'file_changed') return { ok: false, code: 'trace-changed', detail: relative };
      if (message === 'unsafe_file' || message === 'unsafe_path' || message === 'path_unreadable') {
        return { ok: false, code: 'trace-custody', detail: message.slice(0, 120) };
      }
      // A vanished file (or any other stat/read error) is an unstable custody
      // state, never a crash.
      return { ok: false, code: error?.code === 'ENOENT' ? 'trace-missing' : 'trace-changed', detail: message.slice(0, 120) };
    }
    return await parseTraceEnvelope(bytes, relative);
  } catch (error) {
    return { ok: false, code: 'trace-changed', detail: String(error?.message ?? error).slice(0, 120) };
  }
}

async function parseTraceEnvelope(bytes, relative) {
  if (bytes === null) return { ok: false, code: 'trace-missing', detail: relative };
  let envelope;
  try {
    envelope = parseStrictJson(bytes.toString('utf8'));
  } catch {
    return traceInvalid('malformed-json');
  }
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) return traceInvalid('envelope');
  if (Object.keys(envelope).length !== 2 || !Object.hasOwn(envelope, 'trace') || !Object.hasOwn(envelope, 'manifestDigest')) {
    return traceInvalid('envelope-keys');
  }
  const trace = envelope.trace;
  if (trace === null || trace === undefined || typeof trace !== 'object' || Array.isArray(trace)) return traceInvalid('trace');
  if (trace.schemaVersion !== TRACE_SCHEMA_VERSION) return traceInvalid('schema-version');
  if (trace.identity !== TRACE_IDENTITY) return traceInvalid('identity');
  if (typeof envelope.manifestDigest !== 'string' || !SHA256_REF.test(envelope.manifestDigest)) return traceInvalid('manifest-digest');
  if (SHA256_PREFIX(digest(JSON.stringify(trace))) !== envelope.manifestDigest) return traceInvalid('manifest-digest-mismatch');
  if (!['full', 'partial'].includes(trace.completeness)) return traceInvalid('completeness');
  if (!Array.isArray(trace.nodes) || !Array.isArray(trace.relations) || !Array.isArray(trace.gaps)) return traceInvalid('arrays');
  if (trace.nodes.length > 100000 || trace.relations.length > 250000 || trace.gaps.length > 10000) return traceInvalid('array-limits');
  if ((trace.completeness === 'full') !== (trace.gaps.length === 0)) return traceInvalid('completeness-gaps-invariant');
  // Closed engine-owned structural schema for the parsed nodes/relations the
  // engine resolves from (the whole export is never reinterpreted).
  for (const node of trace.nodes) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return traceInvalid('node');
    if (Object.keys(node).length !== 1 || !Object.hasOwn(node, 'symbol') || typeof node.symbol !== 'string'
      || node.symbol.length > 256 || !TRACE_SYMBOL_FORM.test(node.symbol)) return traceInvalid('node-symbol');
  }
  const symbols = new Set(trace.nodes.map((node) => node.symbol));
  for (const relation of trace.relations) {
    if (!relation || typeof relation !== 'object' || Array.isArray(relation)) return traceInvalid('relation');
    if (Object.keys(relation).length !== 2 || !Object.hasOwn(relation, 'from') || !Object.hasOwn(relation, 'to')
      || typeof relation.from !== 'string' || typeof relation.to !== 'string'
      || !symbols.has(relation.from) || !symbols.has(relation.to)) return traceInvalid('relation-endpoints');
  }
  for (const gap of trace.gaps) {
    if (!gap || typeof gap !== 'object' || Array.isArray(gap)) return traceInvalid('gap');
    const keys = Object.keys(gap);
    if (keys.length > 2 || keys.some((key) => key !== 'symbol' && key !== 'reason')) return traceInvalid('gap-keys');
    if (gap.symbol !== undefined && (typeof gap.symbol !== 'string' || gap.symbol.length > 256 || !TRACE_SYMBOL_FORM.test(gap.symbol))) return traceInvalid('gap-symbol');
    if (gap.reason !== undefined && (typeof gap.reason !== 'string' || gap.reason.length > 200)) return traceInvalid('gap-reason');
  }
  return {
    ok: true,
    trace,
    path: relative,
    manifestDigest: envelope.manifestDigest,
    sha256: digest(bytes),
    bytes: bytes.length,
    rawBytes: bytes,
  };
}

// ---------------------------------------------------------------------------
// Local requirement parser with byte-exact spans. Behavioral parity with the
// module-private `parseRequirements` (scripts/openspec-coverage-matrix.mjs)
// is pinned on the shared fixture surface — requirement titles, scenario
// headings, and section assignment — and is deliberately NOT a byte-for-byte
// clone: empty lines are dropped by the byte splitter, scenario keyword
// composition differs (the coverage matrix prefixes "Scenario N:"), and
// CR-only/BOM handling is byte-based. The diverging keyword composition is
// not consumed by edges (topic matching uses node prose, not this list).
// ---------------------------------------------------------------------------

function splitByteLines(bytes) {
  const lines = [];
  let start = 0;
  for (let index = 0; index <= bytes.length; index += 1) {
    if (index === bytes.length || bytes[index] === 0x0A || bytes[index] === 0x0D) {
      if (index > start) {
        lines.push({ start, end: index, text: bytes.subarray(start, index).toString('utf8') });
      }
      if (bytes[index] === 0x0D && bytes[index + 1] === 0x0A) index += 1;
      start = index + 1;
    }
  }
  return lines;
}

// Local topic-match primitives with behavioral parity to the module-private
// `tokenize`/`intersects`/STOPWORDS of the coverage matrix. The stopword list
// is English-only; the lexical level is never claimed RU/EN-neutral.
const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'be', 'by', 'can', 'for', 'from', 'has', 'have',
  'in', 'into', 'is', 'it', 'of', 'on', 'or', 'shall', 'should', 'the', 'then',
  'to', 'when', 'with', 'without', 'must', 'user', 'system', 'requirement', 'scenario',
]);

export function tokenize(text) {
  const tokens = String(text ?? '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !STOPWORDS.has(token));
  return [...new Set(tokens)];
}

export function intersects(left, right) {
  const rightSet = new Set(right);
  return left.some((token) => rightSet.has(token));
}

export function parseRequirementsFromBytes(bytes, specPath) {
  const lines = splitByteLines(bytes);
  const codeMask = createMarkdownCodeMask(lines.map((line) => line.text));
  const requirements = [];
  let currentSection = null;
  let currentRequirement = null;
  let currentScenario = null;
  let bodyLines = [];

  const closeScenario = () => {
    if (!currentScenario) return;
    // The scenario span ends after the last content line of the scenario
    // block (before the next recognized heading); terminators stay excluded.
    const last = bodyLines.at(-1);
    // An empty scenario keeps its heading-line span (never zero-length):
    // the heading bytes are real behavioral text, and a zero-length span
    // would let a trace relation claim a candidate over no bytes at all.
    currentScenario.end = last ? last.end : currentScenario.end;
    currentRequirement.scenarios.push(currentScenario);
    currentScenario = null;
  };
  const closeRequirement = () => {
    closeScenario();
    if (!currentRequirement) return;
    const text = [
      currentRequirement.title,
      ...bodyLines.map((line) => line.text),
      ...currentRequirement.scenarios.map((scenario) => scenario.heading),
    ].join('\n');
    requirements.push({
      spec_path: specPath,
      title: currentRequirement.title,
      section: currentSection ?? 'unknown',
      scenarios: currentRequirement.scenarios,
      keywords: tokenize(text),
    });
    currentRequirement = null;
    bodyLines = [];
  };

  for (const [index, line] of lines.entries()) {
    if (codeMask[index]) {
      bodyLines.push(line);
      continue;
    }
    const section = line.text.match(/^##\s+(ADDED|MODIFIED|REMOVED|DEPRECATED)\s+Requirements/i);
    if (section) {
      closeRequirement();
      currentSection = section[1].toLowerCase();
      continue;
    }
    const requirement = line.text.match(/^###\s+Requirement:\s+(.+?)\s*$/i);
    if (requirement) {
      closeRequirement();
      currentRequirement = { title: requirement[1].trim(), scenarios: [] };
      bodyLines = [];
      continue;
    }
    if (!currentRequirement) continue;
    const scenario = line.text.match(/^####\s+Scenario:\s+(.+?)\s*$/i);
    if (scenario) {
      closeScenario();
      currentScenario = { heading: scenario[1].trim(), start: line.start, end: line.end };
      bodyLines = [];
      continue;
    }
    bodyLines.push(line);
  }
  closeRequirement();
  return requirements;
}

// ---------------------------------------------------------------------------
// Comment/string masking for behavioral anchor extraction. A byte position is
// masked when it sits inside a line/block comment or a string literal; an
// assertion that only exists inside such a region is not behavioral evidence.
// ---------------------------------------------------------------------------

// Masking families for behavioral anchor extraction (P0, documented): the
// JS family (line/block comments, quoted strings, template literals with
// nested `${...}` interpolations), the hash-comment family (`#` line
// comments plus quoted strings — no triple-quote handling), and `none` for
// prose/unknown extensions where there are no recognized comment/literal
// forms, so nothing is masked (every byte counts). An assertion that only
// exists inside a masked region is not behavioral evidence.
const JS_MASK_EXTENSIONS = new Set(['js', 'cjs', 'mjs', 'ts', 'jsx', 'tsx', 'java', 'cs', 'go', 'rs', 'swift', 'kt', 'scala', 'c', 'cc', 'cpp', 'h', 'hpp', 'php', 'json']);
const HASH_MASK_EXTENSIONS = new Set(['py', 'sh', 'bash', 'zsh', 'rb', 'pl', 'yaml', 'yml', 'toml', 'r', 'jl', 'ps1']);

export function maskModeForPath(testPath) {
  const base = String(testPath ?? '');
  const dot = base.lastIndexOf('.');
  const extension = dot >= 0 ? base.slice(dot + 1).toLowerCase() : '';
  if (JS_MASK_EXTENSIONS.has(extension)) return 'js';
  if (HASH_MASK_EXTENSIONS.has(extension)) return 'hash';
  return 'none';
}

export function maskCodeRegions(bytes, mode = 'js') {
  const masked = new Uint8Array(bytes.length);
  if (mode === 'none') return masked;
  if (mode === 'hash') {
    let state = 'code';
    for (let index = 0; index < bytes.length; index += 1) {
      const byte = bytes[index];
      if (state === 'code') {
        if (byte === 0x23) { state = 'line-comment'; masked[index] = 1; continue; }
        if (byte === 0x27) { state = 'single-quote'; masked[index] = 1; continue; }
        if (byte === 0x22) { state = 'double-quote'; masked[index] = 1; continue; }
        continue;
      }
      masked[index] = 1;
      if (state === 'line-comment') {
        if (byte === 0x0A || byte === 0x0D) { masked[index] = 0; state = 'code'; }
      } else if (byte === 0x5C) {
        masked[index + 1] = 1; index += 1;
      } else if ((state === 'single-quote' && byte === 0x27) || (state === 'double-quote' && byte === 0x22)) {
        state = 'code';
      }
    }
    return masked;
  }
  // js mode: a context stack handles nested template interpolations, so a
  // needle inside a nested backtick literal stays masked while real code in
  // `${...}` remains unmasked.
  const stack = []; // { kind: 'template' } | { kind: 'expr', depth }
  const enclosingState = () => (stack.length > 0 && stack[stack.length - 1].kind === 'expr' ? 'expr' : 'code');
  let state = 'code';
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index];
    const next = bytes[index + 1];
    if (state === 'code' || state === 'expr') {
      if (byte === 0x2F && next === 0x2F) { state = 'line-comment'; masked[index] = 1; continue; }
      if (byte === 0x2F && next === 0x2A) { state = 'block-comment'; masked[index] = 1; continue; }
      if (byte === 0x27) { state = 'single-quote'; masked[index] = 1; continue; }
      if (byte === 0x22) { state = 'double-quote'; masked[index] = 1; continue; }
      if (byte === 0x60) { stack.push({ kind: 'template' }); state = 'template'; masked[index] = 1; continue; }
      if (state === 'expr') {
        if (byte === 0x7B) { stack[stack.length - 1].depth += 1; continue; }
        if (byte === 0x7D) {
          if (stack[stack.length - 1].depth === 0) { stack.pop(); state = 'template'; masked[index] = 1; }
          else stack[stack.length - 1].depth -= 1;
        }
      }
      continue;
    }
    masked[index] = 1;
    if (state === 'line-comment') {
      // A comment can start inside a template interpolation: its end restores
      // the enclosing context, otherwise the closing `}` of the interpolation
      // would be read as code and the literal tail after it unmasked.
      if (byte === 0x0A || byte === 0x0D) { masked[index] = 0; state = enclosingState(); }
    } else if (state === 'block-comment') {
      if (byte === 0x2A && next === 0x2F) { masked[index + 1] = 1; state = enclosingState(); index += 1; }
    } else if (byte === 0x5C) {
      masked[index + 1] = 1; index += 1; // escaped character stays inside the literal
    } else if (state === 'single-quote' && byte === 0x27) {
      state = enclosingState();
    } else if (state === 'double-quote' && byte === 0x22) {
      state = enclosingState();
    } else if (state === 'template' && byte === 0x60) {
      stack.pop();
      state = enclosingState();
    } else if (state === 'template' && byte === 0x24 && next === 0x7B) {
      masked[index + 1] = 1;
      stack.push({ kind: 'expr', depth: 0 });
      state = 'expr';
      index += 1;
    }
  }
  return masked;
}

function findUnmaskedOccurrences(bytes, masked, needleBytes, limit) {
  const occurrences = [];
  if (needleBytes.length === 0) return { occurrences, truncated: false };
  let cursor = 0;
  while (cursor + needleBytes.length <= bytes.length) {
    const found = bytes.indexOf(needleBytes, cursor);
    if (found < 0) break;
    let clean = true;
    for (let offset = 0; offset < needleBytes.length; offset += 1) {
      if (masked[found + offset]) { clean = false; break; }
    }
    // Identifier boundary on both sides: a match that continues or is
    // preceded by an identifier character is a longer name (auth.loginWithOtp
    // contains auth.login) or a differently qualified one (my.auth.login) —
    // anchoring it would claim a candidate for behavior the test never calls.
    if (clean) {
      const before = found > 0 ? bytes[found - 1] : 0;
      const after = found + needleBytes.length < bytes.length ? bytes[found + needleBytes.length] : 0;
      const identifierByte = (byte) => (byte >= 0x41 && byte <= 0x5A) || (byte >= 0x61 && byte <= 0x7A)
        || (byte >= 0x30 && byte <= 0x39) || byte === 0x5F || byte === 0x2D || byte === 0x2E || byte === 0x24;
      if (identifierByte(before) || identifierByte(after)) { cursor = found + 1; continue; }
    }
    if (clean) {
      // `truncated` means real anchors beyond the cap were dropped: exactly
      // `limit` occurrences is a complete anchor set, not a truncation.
      if (occurrences.length < limit) occurrences.push({ start: found, end: found + needleBytes.length });
      else return { occurrences, truncated: true };
    }
    cursor = found + 1;
  }
  return { occurrences, truncated: false };
}

function anchorRecord(path, bytes, sha256, occurrence) {
  return {
    path,
    span: { start: occurrence.start, end: occurrence.end },
    document_sha256: SHA256_PREFIX(sha256),
    span_sha256: SHA256_PREFIX(digest(bytes.subarray(occurrence.start, occurrence.end))),
  };
}

// ---------------------------------------------------------------------------
// Graph construction, closed-shape validation, and outcome invariants
// ---------------------------------------------------------------------------

function kindForSymbol(symbol) {
  const prefix = symbol.slice(0, symbol.indexOf(':'));
  if (prefix === 'requirement') return 'requirement';
  if (prefix === 'scenario') return 'scenario';
  if (prefix === 'operation' || prefix === 'endpoint') return 'semantic_symbol';
  return null;
}

function sortKey(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

// Defense-in-depth validator over the closed graph shape: cross-reference
// invariants (unique node ids, kind ↔ exact_ref key correlation — the schema
// oneOf branches pin kind consts AND ref shapes, this re-checks them outside
// the schema gate too, resolvable endpoints, relation/kind admissibility,
// outcome/anchor agreement). Exported for tests; also runs before emit and
// during read-time revalidation.
const KIND_REF_KEYS = Object.freeze({
  requirement: ['requirement_ref', 'spec_path'],
  semantic_symbol: ['symbol_ref'],
  scenario: ['document_sha256', 'heading', 'requirement_ref', 'span', 'span_sha256', 'spec_path'],
  test: ['path', 'sha256'],
});

export function validateGraphShape(graph, options = {}) {
  const policy = options.relationPolicy ?? RELATION_POLICY;
  if (!policy || policy.id !== RELATION_POLICY.id || policy.version !== RELATION_POLICY.version
    || JSON.stringify(policy.relations) !== JSON.stringify(RELATION_POLICY.relations)) {
    return { ok: false, code: 'unsupported-version' };
  }
  const allowed = new Map(policy.relations.map((entry) => [`${entry.from_kind}>${entry.to_kind}`, entry.relation]));
  const knownRelations = new Set(policy.relations.map((entry) => entry.relation));
  const nodeKinds = new Map();
  for (const node of graph.nodes ?? []) {
    if (!node || typeof node !== 'object') return { ok: false, code: 'invalid-node' };
    if (nodeKinds.has(node.node_id)) return { ok: false, code: 'duplicate-node-id' };
    nodeKinds.set(node.node_id, node.kind);
    // kind ↔ exact_ref correlation: a node whose ref shape does not match its
    // kind is invalid even though the loose-form subset could not reject it.
    const expectedKeys = KIND_REF_KEYS[node.kind];
    const actualKeys = node.exact_ref && typeof node.exact_ref === 'object' && !Array.isArray(node.exact_ref)
      ? Object.keys(node.exact_ref).sort()
      : null;
    if (expectedKeys === undefined || actualKeys === null
      || actualKeys.length !== expectedKeys.length
      || actualKeys.some((key, index) => key !== expectedKeys[index])) {
      return { ok: false, code: 'kind-ref-mismatch' };
    }
  }
  for (const edge of graph.edges ?? []) {
    if (!edge || typeof nodeKinds.get(edge.from_node_id) !== 'string') return { ok: false, code: 'dangling-endpoint' };
    if (typeof nodeKinds.get(edge.to_node_id) !== 'string') return { ok: false, code: 'dangling-endpoint' };
    // Classification order mirrors the delta contract: a relation name that
    // is not in the closed vocabulary is `unknown-relation`; a KNOWN name
    // whose endpoint kinds do not admit it is exactly `invalid-kind-pair`
    // (delta scenario: relation `symbol_test` from `scenario` to `test`).
    const expected = allowed.get(`${nodeKinds.get(edge.from_node_id)}>${nodeKinds.get(edge.to_node_id)}`);
    if (expected === undefined || edge.relation !== expected) {
      if (!knownRelations.has(edge.relation)) return { ok: false, code: 'unknown-relation' };
      return { ok: false, code: 'invalid-kind-pair' };
    }
    if (!EDGE_OUTCOMES.includes(edge.outcome)) return { ok: false, code: 'invalid-outcome' };
    if (edge.outcome === 'candidate' && (!Array.isArray(edge.behavioral_assertion_refs) || edge.behavioral_assertion_refs.length === 0)) {
      return { ok: false, code: 'candidate-without-anchor' };
    }
  }
  return { ok: true };
}

export function assertStructuralInvariants(observation) {
  const structural = observation?.structural;
  if (!structural) throw new TypeError('missing structural section');
  const { scan, outcome, nodes, edges } = structural;
  if (!STRUCTURAL_OUTCOMES.includes(outcome)) throw new TypeError('invalid structural outcome');
  // `none` means "no suggestions produced by a full scan": resolved universe
  // nodes may exist (declared scenario/symbol/requirement entities), but not
  // a single emitted edge — otherwise the section must be `abstain` or carry
  // per-edge outcomes.
  if (outcome === 'none' && (scan.coverage !== 'full' || edges.length > 0)) {
    throw new TypeError('none outcome requires a full scan with no suggestions');
  }
  if (scan.coverage === 'partial' && outcome !== 'abstain') {
    throw new TypeError('partial coverage must abstain');
  }
  if (outcome === 'abstain' && scan.coverage !== 'partial') {
    throw new TypeError('abstain outcome requires partial coverage');
  }
  if (scan.coverage === 'none' && edges.length > 0) {
    throw new TypeError('none coverage cannot carry suggestions');
  }
  if ((scan.missing_sources ?? []).length > 0 && scan.coverage !== 'partial') {
    throw new TypeError('missing sources require partial coverage');
  }
  if ((scan.truncations ?? []).length > 0 && scan.coverage !== 'partial') {
    throw new TypeError('recorded truncations require partial coverage');
  }
  if (scan.coverage === 'full' && ((scan.truncations ?? []).length > 0 || (scan.missing_sources_count ?? 0) > 0)) {
    throw new TypeError('full coverage cannot carry truncations or missing sources');
  }
  if ((scan.missing_sources ?? []).length > (scan.missing_sources_count ?? 0)) {
    throw new TypeError('missing_sources list cannot exceed its true count');
  }
  if (structural.trace.completeness === 'partial' && scan.coverage !== 'partial') {
    throw new TypeError('partial trace completeness requires partial coverage');
  }
  // Declared/scanned accounting: scanned can never exceed declared, and a
  // full scan reads every declared source (equal counts by construction).
  if (scan.scanned_sources > scan.declared_sources) {
    throw new TypeError('scanned sources exceed declared sources');
  }
  if (scan.coverage === 'full' && scan.declared_sources !== scan.scanned_sources) {
    throw new TypeError('full coverage requires equal declared and scanned counts');
  }
  // Section outcome and outcome_summary must agree with the emitted edges:
  // the binding hashes the graph, not these derived fields, so a tampered
  // none→candidate flip or edited summary counters are caught here (these
  // invariants run at emit and during read-time revalidation).
  const summary = structural.outcome_summary ?? {};
  if ((summary.total_nodes ?? -1) !== nodes.length || (summary.total_edges ?? -1) !== edges.length) {
    throw new TypeError('outcome_summary disagrees with the graph');
  }
  const candidateEdges = edges.filter((edge) => edge?.outcome === 'candidate').length;
  const relatedEdges = edges.filter((edge) => edge?.outcome === 'related_only').length;
  if ((summary.by_outcome?.candidate ?? -1) !== candidateEdges || (summary.by_outcome?.related_only ?? -1) !== relatedEdges
    || candidateEdges + relatedEdges !== edges.length) {
    throw new TypeError('outcome_summary by_outcome disagrees with the edges');
  }
  if (outcome === 'candidate' && (scan.coverage !== 'full' || candidateEdges === 0)) {
    throw new TypeError('candidate outcome requires full coverage and a candidate edge');
  }
  if (outcome === 'related_only' && (scan.coverage !== 'full' || edges.length === 0 || candidateEdges > 0)) {
    throw new TypeError('related_only outcome requires full coverage with only related_only edges');
  }
  if (outcome === 'abstain' && candidateEdges + relatedEdges !== edges.length) {
    throw new TypeError('abstain outcome must carry only structural edge outcomes');
  }
  const shape = validateGraphShape({ nodes, edges });
  if (!shape.ok) throw new TypeError(`invalid graph shape: ${shape.code}`);
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

export function traceLinkSuggestionsBindingObject({
  worktreeIdentity, changeId, trace, validatedExportDigest, inputDigests, candidatePayloadDigest,
  graphLimits, rubric, relationPolicy, engine, helper, contract, languageOptions, exclusionPolicy,
  deltaSpecInventory,
}) {
  return {
    consumer: TRACE_LINK_CONSUMER_ID,
    worktree_identity: worktreeIdentity,
    change_id: changeId,
    methodology: 'openspec',
    trace,
    validated_export_digest: validatedExportDigest,
    input_digests: inputDigests,
    // The canonical delta-spec inventory (sorted relative paths of the
    // change's spec.md files) is binding input: a spec added or removed after
    // the observation was written must invalidate it, not just edited bytes.
    delta_spec_inventory: deltaSpecInventory,
    candidate_payload_digest: candidatePayloadDigest,
    graph_limits: graphLimits,
    rubric,
    relation_policy: relationPolicy,
    parser_revision: PARSER_VERSION,
    engine,
    helper,
    contract,
    language_options: languageOptions,
    exclusion_policy: exclusionPolicy,
  };
}

export async function currentTraceLinkContext(rootDir, inputs, options = {}) {
  const contractSha = await moduleSha256(new URL(`../${CONTRACT_MODULE}`, import.meta.url), options);
  const engineSha = await moduleSha256(new URL(`../${ENGINE_MODULE}`, import.meta.url), options);
  const helperSha = await moduleSha256(new URL(`../${HELPER_MODULE}`, import.meta.url), options);
  return {
    inputDigests: inputDigestRecords(inputs),
    rubric: { ...TRACE_LINK_RUBRIC },
    relationPolicy: { ...RELATION_POLICY, relations: RELATION_POLICY.relations.map((entry) => ({ ...entry })) },
    engine: { module: ENGINE_MODULE, sha256: engineSha, parser_version: PARSER_VERSION },
    helper: { module: HELPER_MODULE, sha256: helperSha },
    contract: { name: TRACE_LINK_SCHEMA, sha256: contractSha },
  };
}

function isValidObservationDiagnostic(entry) {
  return entry && typeof entry === 'object' && !Array.isArray(entry)
    && Object.keys(entry).length === 3
    && typeof entry.code === 'string' && entry.code.length >= 1 && entry.code.length <= 200
    && (entry.path === null || (typeof entry.path === 'string' && entry.path.length >= 1 && entry.path.length <= 500))
    && (entry.detail === null || (typeof entry.detail === 'string' && entry.detail.length <= 500));
}

export function normalizeSemanticOutcome(outcome, knownEdgeIds = null) {
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
  const seenEdgeIds = new Set();
  let assessmentsInvalid = false;
  for (const finding of rawAssessments) {
    if (!finding || typeof finding !== 'object' || Array.isArray(finding)
      || typeof finding.edge_id !== 'string' || !/^edge-[0-9]{1,8}$/.test(finding.edge_id)
      || !['supports', 'contradicts', 'insufficient'].includes(finding.verdict)
      || typeof finding.rationale !== 'string' || finding.rationale.length < 1 || finding.rationale.length > 500
      || (knownEdgeIds !== null && !knownEdgeIds.has(finding.edge_id))
      || seenEdgeIds.has(finding.edge_id)) {
      assessmentsInvalid = true;
      diagnostics.push({ code: 'semantic-assessment-invalid', path: null, detail: 'dropped a finding outside the closed verdict shape' });
      continue;
    }
    seenEdgeIds.add(finding.edge_id);
    assessments.push({ edge_id: finding.edge_id, verdict: finding.verdict, rationale: finding.rationale });
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
      // The not_run reason keeps the concrete cause (e.g. `assessor-unavailable`),
      // which lives in the diagnostic detail, not in its generic code.
      : String(diagnostics.find((entry) => entry.code !== 'assessment-stale')?.detail
        ?? diagnostics.find((entry) => entry.code !== 'assessment-stale')?.code
        ?? diagnostics[0]?.code
        ?? 'unspecified').slice(0, 200),
    // Numeric edge order, not lexicographic (`edge-10` sorts after `edge-9`).
    assessments: assessments.sort((left, right) => edgeIdNumber(left.edge_id) - edgeIdNumber(right.edge_id)),
    diagnostics,
  };
}

function edgeIdNumber(edgeId) {
  return Number.parseInt(String(edgeId).slice('edge-'.length), 10) || 0;
}

export function assembleObservation({
  changeId, generatedAt, structural, semantic, inputs, context, language, languageSource,
  worktreeIdentity, binding, diagnostics,
}) {
  return {
    schema: TRACE_LINK_SCHEMA,
    change_id: changeId,
    generated_at: generatedAt,
    diagnostic_only: true,
    authorizes: [],
    language: language === 'ru' ? 'ru' : (language === 'en' ? 'en' : 'unknown'),
    language_source: languageSource,
    language_options: { override: languageSource === 'override' ? language : null },
    structural,
    semantic: {
      run_status: semantic.run_status,
      freshness: semantic.freshness,
      abstained: semantic.abstained,
      outcome_reason: semantic.outcome_reason,
      coverage: semantic.coverage,
      assessments: semantic.assessments,
    },
    inputs: inputs.map((input) => ({ path: input.path, sha256: input.sha256 ?? null, bytes: input.bytes ?? 0, kind: input.kind })),
    diagnostics,
    worktree_identity: worktreeIdentity,
    binding,
    rubric: { ...context.rubric },
    relation_policy: { ...context.relationPolicy, relations: context.relationPolicy.relations.map((entry) => ({ ...entry })) },
    exclusion_policy: { ...TRACE_LINK_EXCLUSION_POLICY },
    engine: context.engine,
    helper: context.helper,
    contract: context.contract,
    graph_limits: { ...GRAPH_LIMITS },
  };
}

// ---------------------------------------------------------------------------
// Read-time revalidation: any divergence between the recorded composite
// binding and the current worktree/inputs/trace/rubric/engine/helper/contract/
// language state names the drifted fields and marks the observation stale.
// ---------------------------------------------------------------------------

export async function validateObservationBinding(rootDir, observation, options = {}) {
  if (!observation || typeof observation !== 'object' || observation.schema !== TRACE_LINK_SCHEMA
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
  try {
    assertStructuralInvariants(observation);
  } catch {
    return { ok: false, code: 'observation-invalid' };
  }
  const mismatched = [];
  if (worktreeIdentity !== observation.worktree_identity) mismatched.push('worktree_identity');
  const recordedInputs = Array.isArray(observation.inputs) ? observation.inputs : [];
  if (recordedInputs.length > MAX_TEST_INPUTS + MAX_DELTA_SPEC_FILES) return { ok: false, code: 'observation-invalid' };
  // Cross-field honesty invariants on the recorded observation itself: a
  // scan with missing sources can never claim full coverage, and a failed,
  // not_run, or abstained semantic stage can never carry assessments — nor
  // assessments naming edges that the recorded graph does not contain.
  const recordedScan = observation.structural?.scan ?? {};
  if ((recordedScan.missing_sources ?? []).length > 0 && recordedScan.coverage !== 'partial') {
    return { ok: false, code: 'observation-invalid' };
  }
  const recordedSemantic = observation.semantic ?? {};
  const recordedAssessments = Array.isArray(recordedSemantic.assessments) ? recordedSemantic.assessments : [];
  const recordedEdgeIds = new Set((observation.structural?.edges ?? []).map((edge) => edge?.edge_id));
  if ((recordedSemantic.run_status === 'failed' || recordedSemantic.run_status === 'not_run' || recordedSemantic.abstained === true)
    && recordedAssessments.length > 0) {
    return { ok: false, code: 'observation-invalid' };
  }
  for (const assessment of recordedAssessments) {
    if (!recordedEdgeIds.has(assessment?.edge_id)) return { ok: false, code: 'observation-invalid' };
  }
  if (new Set(recordedAssessments.map((assessment) => assessment?.edge_id)).size !== recordedAssessments.length) {
    return { ok: false, code: 'observation-invalid' };
  }
  // Digest records are rebuilt from CURRENT disk bytes (never from the
  // recorded observation itself): an edited or renamed input must name its
  // field and flip the recomputed binding.
  const reader = options.readTestFile ?? (async (dir, rel) => readProviderFile(dir, rel, DOCUMENT_LIMIT));
  const freshInputs = [];
  for (const input of recordedInputs) {
    let bytes = null;
    try { bytes = await reader(root, input.path, DOCUMENT_LIMIT); } catch { bytes = null; }
    freshInputs.push({ path: input.path, ...classifyInputBytes(bytes) });
  }
  let context;
  try {
    context = await currentTraceLinkContext(root, freshInputs, options);
  } catch {
    return { ok: false, code: 'root-unreadable' };
  }
  for (const digestRecord of context.inputDigests) {
    const recorded = recordedInputs.find((candidate) => candidate?.path === digestRecord.path);
    if (!recorded || (recorded.sha256 ?? null) !== digestRecord.sha256 || (recorded.bytes ?? 0) !== digestRecord.bytes
      || (recorded.kind ?? null) !== digestRecord.kind) {
      mismatched.push(`inputs:${digestRecord.path}`);
    }
  }
  // The trace manifest is re-read through the custody reader: raw-byte
  // identity (sha256/bytes) is binding input; the recorded manifestDigest is
  // re-derived content identity, not a byte identity.
  const freshTrace = await readTraceManifest(root, observation.change_id, options);
  const recordedTrace = observation.structural?.trace ?? null;
  if (!freshTrace.ok) {
    mismatched.push('trace');
  } else if (!recordedTrace || recordedTrace.path !== traceManifestPath(observation.change_id)
    || recordedTrace.sha256 !== freshTrace.sha256 || recordedTrace.bytes !== freshTrace.bytes
    || recordedTrace.manifest_digest !== freshTrace.manifestDigest
    || recordedTrace.completeness !== freshTrace.trace.completeness) {
    mismatched.push('trace');
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
  const recordedPolicy = observation.relation_policy ?? {};
  if ((recordedPolicy.id ?? null) !== context.relationPolicy.id
    || (recordedPolicy.version ?? null) !== context.relationPolicy.version
    || JSON.stringify(recordedPolicy.relations ?? null) !== JSON.stringify(context.relationPolicy.relations)) mismatched.push('relation_policy');
  const recordedExclusion = observation.exclusion_policy ?? {};
  if ((recordedExclusion.id ?? null) !== TRACE_LINK_EXCLUSION_POLICY.id
    || (recordedExclusion.version ?? null) !== TRACE_LINK_EXCLUSION_POLICY.version) mismatched.push('exclusion_policy');
  // The engine never emits a language override; a recorded override is
  // schema-valid tampering, not a state this engine can revalidate.
  if (observation.language_source !== 'detected' || observation.language_options?.override !== null) {
    return { ok: false, code: 'observation-invalid' };
  }
  // The canonical delta-spec inventory is rebuilt from the CURRENT disk tree
  // (bounded walk): a spec added or removed after the observation was written
  // must name its field and flip the binding — the recorded input digests
  // alone cannot see a spec that was never read. A truncated fresh walk
  // cannot prove inventory equality either, so it degrades to stale.
  const freshWalk = await collectDeltaSpecPaths(root, observation.change_id);
  const freshInventory = freshWalk.paths.sort();
  const recordedInventory = Array.isArray(recordedScan.delta_spec_inventory) ? recordedScan.delta_spec_inventory : [];
  if (freshWalk.truncated || freshInventory.join('|') !== recordedInventory.join('|')) mismatched.push('delta_spec_inventory');
  // Scan-fact provenance (C3): the recorded scan accounting is pinned to the
  // provable inputs of the fresh data ALREADY read above — validation stays
  // cheap (no buildGraph, no anchor scan, no assessor). The block runs only
  // when the fresh trace read OK: a failed custody read already pushed
  // 'trace' into the mismatched list, so stale is guaranteed there, and
  // touching freshTrace.trace below without this guard would turn a stale
  // into an operational failure. A truncated fresh walk likewise already
  // forced the inventory mismatch (stale is guaranteed) and its counts prove
  // nothing, so the recomputation is skipped rather than duplicated.
  if (freshTrace.ok && !freshWalk.truncated) {
    // Mirror of the writer's declared universe: fresh delta-spec paths plus
    // unique presented test paths (the recorded inputs minus the fresh
    // inventory paths) plus unique supported-kind trace symbols.
    const freshSupportedSymbols = new Set(freshTrace.trace.nodes
      .map((node) => node?.symbol)
      .filter((symbol) => typeof symbol === 'string' && kindForSymbol(symbol) !== null));
    const inventoryPaths = new Set(freshInventory);
    const presentedTestInputs = new Set(recordedInputs
      .map((input) => input?.path)
      .filter((candidate) => typeof candidate === 'string' && !inventoryPaths.has(candidate)));
    const freshDeclared = freshInventory.length + presentedTestInputs.size + freshSupportedSymbols.size;
    // Clamp parity: the recorded declared count must equal the fresh value
    // clamped at the schema maximum, and an actual fresh overflow must carry
    // the writer's truncation marker — a maximum-valued count without the
    // marker proves the marker was stripped from an overflowing run (early
    // invalid verdict, winning over any stale fields accumulated above).
    const MAX_ACCOUNTED_SOURCES = 100000;
    const recordedTruncations = Array.isArray(recordedScan.truncations) ? recordedScan.truncations : [];
    if (freshDeclared > MAX_ACCOUNTED_SOURCES && !recordedTruncations.includes('declared-sources-truncated')) {
      return { ok: false, code: 'observation-invalid' };
    }
    if ((recordedScan.declared_sources ?? null) !== Math.min(freshDeclared, MAX_ACCOUNTED_SOURCES)) {
      mismatched.push('declared_sources');
    }
    // Provable-truncation bound: every supported-kind trace symbol derives a
    // mandatory semantic_symbol node with no test-anchor search (best-effort
    // bound — requirement/scenario refs may resolve to null and are
    // conservatively NOT counted, so the bound undercounts). When the bound
    // exceeds the node limit, an honest run must have truncated the graph and
    // degraded coverage, so a recorded full-coverage observation over such a
    // trace is a provably impossible form, not merely drifted.
    const nodeLimit = observation.graph_limits?.max_nodes ?? GRAPH_LIMITS.max_nodes;
    if (freshSupportedSymbols.size > nodeLimit && recordedScan.coverage === 'full') {
      return { ok: false, code: 'observation-invalid' };
    }
    // Full coverage implies every presented input was readable when the
    // observation was written: a fresh input that now classifies as missing
    // or malformed would have produced missing_sources and partial coverage.
    if (recordedScan.coverage === 'full' && freshInputs.some((input) => input.kind !== 'file')) {
      return { ok: false, code: 'observation-invalid' };
    }
  }
  const binding = buildAssessmentBinding(traceLinkSuggestionsBindingObject({
    worktreeIdentity,
    changeId: observation.change_id,
    trace: recordedTrace ? {
      path: recordedTrace.path,
      sha256: freshTrace.ok ? freshTrace.sha256 : recordedTrace.sha256,
      bytes: freshTrace.ok ? freshTrace.bytes : recordedTrace.bytes,
    } : null,
    validatedExportDigest: recordedTrace?.manifest_digest ?? null,
    inputDigests: context.inputDigests,
    deltaSpecInventory: freshInventory,
    candidatePayloadDigest: assessmentDigest({
      nodes: observation.structural?.nodes ?? [],
      edges: observation.structural?.edges ?? [],
    }),
    graphLimits: observation.graph_limits ?? null,
    rubric: context.rubric,
    relationPolicy: context.relationPolicy,
    engine: context.engine,
    helper: context.helper,
    contract: context.contract,
    languageOptions: { override: null, resolved: observation.language ?? 'unknown' },
    exclusionPolicy: { ...TRACE_LINK_EXCLUSION_POLICY },
  }));
  if (binding !== observation.binding) {
    // Everything else matches: the only remaining binding input is the
    // candidate payload (nodes + edges + behavioral anchors), so a flipped
    // binding names the edited graph instead of a generic field.
    if (mismatched.length === 0) mismatched.push('candidate_payload');
    mismatched.push('binding');
  }
  return { ok: true, stale: mismatched.length > 0, mismatched: [...new Set(mismatched)], state: mismatched.length > 0 ? 'stale-observation' : null };
}


// One shared byte classifier for the scan, the freshness probe, and
// revalidation (F4: single definition): a malformed-UTF-8 input records kind
// "malformed" at write time and revalidates as "malformed", so a recorded
// observation is never "born stale" and the probe never lies about unchanged
// inputs.
function classifyInputBytes(bytes) {
  if (bytes === null) return { sha256: null, bytes: 0, kind: 'missing' };
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return { sha256: digest(bytes), bytes: bytes.length, kind: 'file' };
  } catch {
    return { sha256: digest(bytes), bytes: bytes.length, kind: 'malformed' };
  }
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

export async function writeTraceLinkObservation(rootDir, observation, config, options = {}) {
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
  const paths = traceLinkPaths(observation.change_id);
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
  // presented input — the writer would overwrite exactly the material the
  // scan claims to describe.
  const outputLower = relative.toLowerCase();
  const presented = (observation.inputs ?? []).map((input) => input?.path).filter((value) => typeof value === 'string');
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
    if (!prior || prior.schema !== TRACE_LINK_SCHEMA || prior.change_id !== observation.change_id) return leafConflict();
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
  // Atomic write owned by this module: the third ownership check runs after
  // the temporary write and immediately before the rename, closing the
  // check-then-rename window a foreign replacement could slip through.
  const payload = `${JSON.stringify(observation, null, 2)}\n`;
  const temporary = path.join(liveDirectory, `${parts[parts.length - 1]}.${randomUUID()}.tmp`);
  const openFile = options.openFile ?? open;
  let renamed = false;
  try {
    await safeProviderPath(root, relative);
    const handle = await openFile(temporary, 'wx', 0o600);
    try { await handle.writeFile(payload, 'utf8'); } finally { await handle.close(); }
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
    if (!renamed) await unlink(temporary).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Structural scan over only the presented inputs
// ---------------------------------------------------------------------------

function buildGraph({ traceManifest, specs, tests, diagnostics, specsIncomplete = false }) {
  const trace = traceManifest.trace;
  const universe = new Map(); // symbol -> { symbol, kind }
  for (const node of trace.nodes) {
    const kind = kindForSymbol(node.symbol);
    if (kind === null) {
      diagnostics.push({ code: 'unsupported-trace-node-kind', path: traceManifestPathLabel(traceManifest), detail: node.symbol.slice(0, 200) });
      continue;
    }
    universe.set(node.symbol, { symbol: node.symbol, kind });
  }
  const refusal = (reason, detail) => ({ refusal: { reason, detail: detail === undefined ? null : String(detail).slice(0, 200) } });
  // When the declared spec inventory is incomplete (unreadable/truncated
  // specs), a ref with ZERO readable matches may be a casualty of the
  // missing source rather than an invented reference: it degrades to a
  // bounded diagnostic with the affected edges dropped (partial scan)
  // instead of destroying the whole partial result with a typed refusal.
  // Proven ambiguity among READABLE specs (>= 2 matches, duplicate headings)
  // is real evidence and always refuses, inventory state notwithstanding.
  // The helper must only be consumed per-symbol (its {node:null} result is
  // never a buildGraph return value).
  const unresolved = (code, symbol) => {
    if (specsIncomplete) {
      diagnostics.push({ code: `${code}-missing-source`, path: traceManifestPathLabel(traceManifest), detail: String(symbol).slice(0, 200) });
      return { node: null };
    }
    return refusal(code, symbol);
  };

  const requirementsByTitle = new Map();
  for (const spec of specs) {
    for (const requirement of spec.requirements) {
      const bucket = requirementsByTitle.get(requirement.title) ?? [];
      bucket.push(requirement);
      requirementsByTitle.set(requirement.title, bucket);
    }
  }
  const scenariosByHeading = new Map();
  for (const spec of specs) {
    for (const requirement of spec.requirements) {
      for (const scenario of requirement.scenarios) {
        const bucket = scenariosByHeading.get(scenario.heading) ?? [];
        bucket.push({ requirement, scenario, spec });
        scenariosByHeading.set(scenario.heading, bucket);
      }
    }
  }

  const nodes = new Map(); // node_id -> node
  // Every parsed scenario of the change's delta specs is a declared graph
  // node: scenario_test suggestions are derived from parsed scenarios against
  // presented tests (topic match and byte anchors), independent of whether a
  // trace `scenario:` ref names them. Requirement nodes stay trace-referenced
  // only: the closed relation dictionary has no requirement->test edge. A
  // duplicate heading inside one requirement would silently collapse to the
  // last span in this map, so it is a typed ambiguity refusal before any
  // suggestion is emitted. The duplicate is proven by READABLE spec bytes, so
  // it refuses unconditionally — an incomplete inventory cannot create or
  // excuse it, and a {node:null} here would break the buildGraph contract.
  for (const spec of specs) {
    for (const requirement of spec.requirements) {
      for (const scenario of requirement.scenarios) {
        const nodeId = `scn:${spec.path}#${requirement.title}#${scenario.heading}`;
        if (nodeId.length > 200) return refusal('node-id-overflow', nodeId);
        if (nodes.has(nodeId)) return refusal('ambiguous-scenario-ref', nodeId);
        nodes.set(nodeId, {
          node_id: nodeId,
          kind: 'scenario',
          exact_ref: {
            spec_path: spec.path,
            requirement_ref: requirement.title,
            heading: scenario.heading,
            span: { start: scenario.start, end: scenario.end },
            document_sha256: SHA256_PREFIX(spec.sha256),
            span_sha256: SHA256_PREFIX(digest(spec.bytes.subarray(scenario.start, scenario.end))),
          },
        });
      }
    }
  }
  const resolveUniverse = (entry) => {
    if (entry.kind === 'semantic_symbol') {
      const nodeId = entry.symbol;
      if (nodeId.length > 200) return refusal('node-id-overflow', entry.symbol);
      nodes.set(nodeId, { node_id: nodeId, kind: 'semantic_symbol', exact_ref: { symbol_ref: entry.symbol } });
      return { node: nodes.get(nodeId) };
    }
    if (entry.kind === 'requirement') {
      const key = entry.symbol.slice('requirement:'.length);
      const matches = requirementsByTitle.get(key) ?? [];
      // Zero readable matches may be a casualty of a missing spec (downgraded
      // when the inventory is incomplete); two or more readable matches are
      // proven ambiguity and always refuse, inventory state notwithstanding.
      if (matches.length === 0) return unresolved('unresolved-ref', entry.symbol);
      if (matches.length > 1) return refusal('unresolved-ref', `${entry.symbol}: ambiguous requirement title`);
      const requirement = matches[0];
      const nodeId = `req:${requirement.spec_path}#${requirement.title}`;
      if (nodeId.length > 200) return refusal('node-id-overflow', nodeId);
      nodes.set(nodeId, { node_id: nodeId, kind: 'requirement', exact_ref: { spec_path: requirement.spec_path, requirement_ref: requirement.title } });
      return { node: nodes.get(nodeId) };
    }
    // scenario
    const key = entry.symbol.slice('scenario:'.length);
    const matches = scenariosByHeading.get(key) ?? [];
    if (matches.length === 0) return unresolved('unresolved-ref', entry.symbol);
    if (matches.length > 1) return refusal('ambiguous-scenario-ref', entry.symbol);
    const { requirement, scenario, spec } = matches[0];
    const nodeId = `scn:${spec.path}#${requirement.title}#${scenario.heading}`;
    return { node: nodes.get(nodeId) };
  };

  const resolvedBySymbol = new Map();
  for (const entry of universe.values()) {
    const outcome = resolveUniverse(entry);
    if (outcome.refusal) return outcome;
    resolvedBySymbol.set(entry.symbol, outcome.node);
  }
  // Unique resolved trace refs feed the declared/scanned accounting (R6:
  // duplicate trace nodes count once on both sides).
  const resolvedTraceRefs = [...resolvedBySymbol.values()].filter((node) => node !== null).length;
  for (const test of tests) {
    if (!test.ok) continue;
    const nodeId = `test:${test.path}`;
    if (nodeId.length > 200) return refusal('node-id-overflow', nodeId);
    nodes.set(nodeId, { node_id: nodeId, kind: 'test', exact_ref: { path: test.path, sha256: SHA256_PREFIX(test.sha256) } });
  }

  const edgeMap = new Map(); // relation|from|to -> { relation, from, to, anchors: Map }
  const addEdge = (relation, fromNodeId, toNodeId, anchors) => {
    const key = `${relation}|${fromNodeId}|${toNodeId}`;
    const existing = edgeMap.get(key) ?? { relation, from_node_id: fromNodeId, to_node_id: toNodeId, anchors: new Map() };
    for (const anchor of anchors) existing.anchors.set(`${anchor.span.start}:${anchor.span.end}:${anchor.span_sha256}`, anchor);
    edgeMap.set(key, existing);
  };

  for (const relation of trace.relations) {
    const fromKind = universe.get(relation.from)?.kind;
    const toKind = universe.get(relation.to)?.kind;
    if (fromKind === undefined || toKind === undefined) {
      diagnostics.push({ code: 'unsupported-trace-relation', path: traceManifestPathLabel(traceManifest), detail: `${relation.from} -> ${relation.to}`.slice(0, 200) });
      continue;
    }
    const fromNode = resolvedBySymbol.get(relation.from);
    const toNode = resolvedBySymbol.get(relation.to);
    if (fromNode === null || toNode === null) {
      // An endpoint attributed to a missing spec source: the affected edge is
      // dropped, the scan stays partial (never a refusal, never a crash).
      diagnostics.push({ code: 'edge-dropped-missing-source', path: traceManifestPathLabel(traceManifest), detail: `${relation.from} -> ${relation.to}`.slice(0, 200) });
      continue;
    }
    if (fromKind === 'requirement' && toKind === 'semantic_symbol') {
      addEdge('requirement_symbol', fromNode.node_id, toNode.node_id, []);
      continue;
    }
    if (fromKind === 'semantic_symbol' && toKind === 'scenario') {
      const anchors = [{
        path: toNode.exact_ref.spec_path,
        span: { ...toNode.exact_ref.span },
        document_sha256: toNode.exact_ref.document_sha256,
        span_sha256: toNode.exact_ref.span_sha256,
      }];
      addEdge('symbol_scenario', fromNode.node_id, toNode.node_id, anchors);
      continue;
    }
    diagnostics.push({ code: 'unsupported-trace-relation', path: traceManifestPathLabel(traceManifest), detail: `${relation.from} -> ${relation.to}`.slice(0, 200) });
  }

  // Bounded anchor search: the (node × test) product with per-needle
  // indexOf scans is capped by a global scan budget; exceeding it degrades
  // the scan to partial (honest abstain) instead of running unbounded work
  // over a maximal trace export.
  const MAX_ANCHOR_SCAN_BYTES = 256 * 1024 * 1024;
  let anchorScanBytes = 0;
  let scanTruncated = false;
  let truncatedAnchorScan = false;
  for (const test of tests) {
    if (!test.ok) continue;
    const testNode = nodes.get(`test:${test.path}`);
    const masked = maskCodeRegions(test.bytes, maskModeForPath(test.path));
    const testTokens = tokenize(test.text);
    for (const node of nodes.values()) {
      if (anchorScanBytes > MAX_ANCHOR_SCAN_BYTES) {
        scanTruncated = true;
        break;
      }
      let needle = null;
      if (node.kind === 'semantic_symbol') {
        needle = node.exact_ref.symbol_ref.slice(node.exact_ref.symbol_ref.indexOf(':') + 1);
      } else if (node.kind === 'scenario') {
        needle = node.exact_ref.heading;
      } else {
        continue;
      }
      // Each needle search charges one haystack pass to the budget.
      anchorScanBytes += test.bytes.length;
      const { occurrences, truncated } = findUnmaskedOccurrences(test.bytes, masked, Buffer.from(needle, 'utf8'), GRAPH_LIMITS.max_assertion_refs_per_edge);
      if (truncated) {
        // Dropped anchors beyond the cap are a coverage fact: the scan that
        // truncated can never be presented as `full`.
        scanTruncated = true;
        diagnostics.push({ code: 'assertion-refs-truncated', path: test.path, detail: node.node_id });
      }
      const topicMatch = intersects(tokenize(needle), testTokens);
      if (occurrences.length === 0 && !topicMatch) continue;
      const anchors = occurrences.map((occurrence) => anchorRecord(test.path, test.bytes, test.sha256, occurrence));
      addEdge(node.kind === 'semantic_symbol' ? 'symbol_test' : 'scenario_test', node.node_id, testNode.node_id, anchors);
    }
    if (scanTruncated) break;
  }
  if (scanTruncated) {
    truncatedAnchorScan = true;
    diagnostics.push({ code: 'anchor-scan-truncated', path: null, detail: 'anchor-scan-budget' });
  }

  const KIND_ORDER = { requirement: 0, semantic_symbol: 1, scenario: 2, test: 3 };
  let nodeList = [...nodes.values()].sort((left, right) => KIND_ORDER[left.kind] - KIND_ORDER[right.kind] || sortKey(left.node_id, right.node_id));
  const truncations = [];
  if (truncatedAnchorScan) truncations.push('anchor-scan-truncated');
  let truncated = truncatedAnchorScan;
  if (nodeList.length > GRAPH_LIMITS.max_nodes) {
    nodeList = nodeList.slice(0, GRAPH_LIMITS.max_nodes);
    truncated = true;
    truncations.push('graph-truncated');
    diagnostics.push({ code: 'graph-truncated', path: null, detail: 'nodes' });
  }
  const keptNodeIds = new Set(nodeList.map((node) => node.node_id));
  let edgeList = [...edgeMap.values()]
    .filter((edge) => keptNodeIds.has(edge.from_node_id) && keptNodeIds.has(edge.to_node_id))
    .map((edge) => ({
      relation: edge.relation,
      from_node_id: edge.from_node_id,
      to_node_id: edge.to_node_id,
      behavioral_assertion_refs: [...edge.anchors.values()]
        .sort((left, right) => left.span.start - right.span.start || sortKey(left.span_sha256, right.span_sha256)),
    }))
    .sort((left, right) => sortKey(left.relation, right.relation) || sortKey(left.from_node_id, right.from_node_id) || sortKey(left.to_node_id, right.to_node_id));
  if (edgeList.length > GRAPH_LIMITS.max_edges) {
    edgeList = edgeList.slice(0, GRAPH_LIMITS.max_edges);
    truncated = true;
    truncations.push('graph-truncated');
    diagnostics.push({ code: 'graph-truncated', path: null, detail: 'edges' });
  }
  if (nodeList.length + edgeList.length > GRAPH_LIMITS.max_total_elements) {
    edgeList = edgeList.slice(0, Math.max(0, GRAPH_LIMITS.max_total_elements - nodeList.length));
    truncated = true;
    truncations.push('graph-truncated');
    diagnostics.push({ code: 'graph-truncated', path: null, detail: 'total' });
  }
  const edges = edgeList.map((edge, index) => ({
    edge_id: `edge-${index + 1}`,
    from_node_id: edge.from_node_id,
    to_node_id: edge.to_node_id,
    relation: edge.relation,
    outcome: edge.behavioral_assertion_refs.length > 0 ? 'candidate' : 'related_only',
    behavioral_assertion_refs: edge.behavioral_assertion_refs,
  }));
  return { nodes: nodeList, edges, truncated, resolvedTraceRefs, truncations };
}

function traceManifestPathLabel(traceManifest) {
  return traceManifest.path ?? null;
}



function testScenarioText(node) {
  const ref = node.exact_ref;
  return `${ref.requirement_ref} ${ref.heading}`;
}

// ---------------------------------------------------------------------------
// Bounded delta-spec collection (presented scope only)
// ---------------------------------------------------------------------------

// Inventory caps stay compatible with the observation schema: 100 delta
// specs + 50 presented tests fit the inputs array (maxItems 150).
const MAX_DELTA_SPEC_FILES = 100;
const MAX_DELTA_SPEC_DIRECTORIES = 500;
const MAX_MISSING_SOURCES = 100;

// Local bounded walk of `openspec/changes/<change-id>/specs/**`: only files
// named spec.md (parity with the canonical collector's isSpecMarkdown
// predicate) are declared inputs; every read goes through the bounded
// provider reader. Base specs, proposal/design/tasks, and everything else in
// the repository are never read by the engine. Missing, dangling-symlink,
// and malformed-UTF-8 spec files stay declared-but-unreadable entries: they
// become missing_sources and degrade coverage, never silently skipped scans.
async function collectDeltaSpecPaths(rootDir, changeId) {
  const specsRoot = `openspec/changes/${changeId}/specs`;
  const files = [];
  const directories = [specsRoot];
  let visitedDirectories = 0;
  let truncated = false;
  // Confined root anchor for the per-directory containment check below.
  const realRoot = await realpath(rootDir);
  const markTruncated = (detail) => {
    truncated = true;
    return detail;
  };
  while (directories.length > 0) {
    if (visitedDirectories >= MAX_DELTA_SPEC_DIRECTORIES) {
      markTruncated('directory-limit');
      break;
    }
    const relative = directories.shift();
    visitedDirectories += 1;
    // Path confinement (SEC): every walked directory must resolve inside the
    // project root. A symlinked specs root or subdirectory pointing outside
    // the project would leak external spec.md paths into the observation —
    // the walk degrades instead of listing them.
    let realDirectory;
    try {
      realDirectory = await realpath(path.join(rootDir, relative));
    } catch (error) {
      // Only a missing specs root is a legitimate zero-declared-spec change;
      // any other unreadable directory degrades the walk (C1/S1 semantics).
      if (relative === specsRoot && error?.code === 'ENOENT') continue;
      markTruncated(`realpath:${error?.code ?? 'error'}`);
      break;
    }
    if (!realDirectory.toLowerCase().startsWith(`${realRoot.toLowerCase()}${path.sep}`)) {
      markTruncated('path-escape');
      break;
    }
    let entries;
    try {
      entries = await readdir(realDirectory, { withFileTypes: true });
    } catch (error) {
      // Only git-style ENOENT on the specs root itself is a legitimate
      // zero-declared-spec change; EACCES/ENOTDIR or any other failure —
      // root or child — hides its subtree, so the walk degrades instead of
      // presenting a silent full scan (S1/C1).
      if (relative === specsRoot && error?.code === 'ENOENT') continue;
      markTruncated(`readdir:${error?.code ?? 'error'}`);
      continue;
    }
    for (const entry of entries.sort((left, right) => sortKey(left.name, right.name))) {
      const childRelative = `${relative}/${entry.name}`;
      // A symlink named spec.md is a declared entry that must not vanish
      // silently: the bounded read below refuses it and the entry degrades
      // coverage like any other unreadable spec (dangling symlinks included).
      if (entry.name === 'spec.md' && (entry.isFile() || entry.isSymbolicLink())) {
        // The cap is only a truncation when a 101st declared file is actually
        // encountered: exactly 100 specs are a complete inventory (S1).
        if (files.length >= MAX_DELTA_SPEC_FILES) { markTruncated('inventory-limit'); break; }
        files.push(childRelative);
        continue;
      }
      if (entry.isDirectory()) directories.push(childRelative);
      else if (entry.isSymbolicLink()) {
        // A symlinked subdirectory is never traversed (custody escape risk):
        // its subtree is unknown, so the walk degrades instead of skipping.
        markTruncated('symlinked-directory');
        break;
      }
    }
    if (truncated) break;
  }
  return { paths: files.slice(0, MAX_DELTA_SPEC_FILES), truncated };
}

async function collectDeltaSpecs(rootDir, changeId, diagnostics) {
  const specsRoot = `openspec/changes/${changeId}/specs`;
  const walk = await collectDeltaSpecPaths(rootDir, changeId);
  if (walk.truncated) {
    diagnostics.push({ code: 'delta-spec-inventory-truncated', path: specsRoot, detail: 'inventory-walk-truncated' });
  }
  const specs = [];
  for (const relative of walk.paths) {
    let bytes = null;
    try {
      bytes = await readProviderFile(rootDir, relative, DOCUMENT_LIMIT);
    } catch (error) {
      bytes = null;
      diagnostics.push({ code: 'malformed-input', path: relative, detail: String(error?.message ?? error).slice(0, 80) });
    }
    if (bytes === null) {
      specs.push({ path: relative, ok: false, reason: 'file-missing', bytes: null, sha256: null, text: '', requirements: [] });
      diagnostics.push({ code: 'file-missing', path: relative, detail: 'delta-spec' });
      continue;
    }
    let text = '';
    let ok = true;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      ok = false;
      text = '';
      diagnostics.push({ code: 'malformed-input', path: relative, detail: 'utf8-fatal' });
    }
    specs.push({
      path: relative,
      ok,
      reason: ok ? null : 'utf8-fatal',
      bytes,
      sha256: digest(bytes),
      text,
      requirements: ok ? parseRequirementsFromBytes(bytes, relative) : [],
    });
  }
  return { specs, truncated: walk.truncated };
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
    const lines = [`Trace link suggestions (advisory): ${value.state}`];
    for (const code of value.codes ?? []) lines.push(`  diagnostic: ${code}`);
    if (value.message) lines.push(value.message);
    lines.push(`Usage: ${value.usage ?? usage}`);
    return lines.join('\n');
  }
  const lines = [
    `Trace link suggestions (advisory, no gate evidence): change ${value.change_id}`,
    `Structural outcome: ${value.structural?.outcome}; nodes ${value.structural?.outcome_summary?.total_nodes ?? 0}, edges ${value.structural?.outcome_summary?.total_edges ?? 0} (candidate: ${value.structural?.outcome_summary?.by_outcome?.candidate ?? 0}, related_only: ${value.structural?.outcome_summary?.by_outcome?.related_only ?? 0}); coverage: ${value.structural?.scan?.coverage}`,
    `Semantic: ${value.semantic?.run_status}${value.semantic?.abstained ? ' (abstained)' : ''}; freshness: ${value.semantic?.freshness}; coverage: ${value.semantic?.coverage?.state}`,
  ];
  if (value.structural?.outcome === 'none' && (value.structural?.scan?.coverage !== 'full')) {
    lines.push('Degraded structural outcome — this is NOT a zero-findings result.');
  }
  if (value.semantic?.run_status !== 'complete' || value.semantic?.abstained || value.semantic?.freshness !== 'current' || value.semantic?.coverage?.state !== 'full') {
    lines.push('Degraded semantic outcome — this is NOT a zero-findings result.');
  }
  for (const edge of value.structural?.edges ?? []) {
    lines.push(`  ${edge.edge_id} ${edge.from_node_id} -[${edge.relation}]-> ${edge.to_node_id}: ${edge.outcome} (${edge.behavioral_assertion_refs.length} anchors)`);
  }
  for (const diagnostic of value.diagnostics ?? []) {
    lines.push(`  diagnostic: ${diagnostic.code}${diagnostic.path ? ` (${diagnostic.path})` : ''}${diagnostic.detail ? ` — ${diagnostic.detail}` : ''}`);
  }
  lines.push('Suggestions never verify coverage and never authorize progression; acceptance runs through the existing review/owner workflow.');
  return lines.join('\n');
}

export async function runTraceLinkSuggestionsCommand(argv = process.argv.slice(2), options = {}) {
  const output = options.output ?? ((value) => process.stdout.write(value));
  const emit = (value, json) => output(json ? `${JSON.stringify(value, null, 2)}\n` : `${renderHuman(value)}\n`);
  const now = options.now ?? Date.now;
  const startedAt = now();

  const parsed = parseTraceLinkArgs(argv);
  // A malformed argument list must still honor an explicit `--json` request
  // regardless of where the flag sat relative to the offending argument.
  if (!parsed.ok) {
    emit(notRunEnvelope(['invalid-usage', parsed.error]), parsed.json === true || argv.includes('--json'));
    return 2;
  }
  // Explicit change-id validation happens before ANY read (decision 7): the
  // custody form is checked before the project-root, config, trace, and test
  // reads, so a disabled producer can never swallow a custody-invalid
  // invocation — a malformed id is a typed exit-2 refusal, not a silent
  // "advisory scan was not performed".
  if (typeof parsed.changeId !== 'string') {
    emit(notRunEnvelope(['missing-change']), parsed.json);
    return 2;
  }
  // Single custody-safe change-id form (decision 7): broader #282-style forms
  // are refused, not normalized.
  if (!CHANGE_ID_FORM.test(parsed.changeId)) {
    emit(notRunEnvelope(['invalid-change-id']), parsed.json);
    return 2;
  }
  let rootDir;
  try {
    rootDir = await realpath(options.rootDir ?? process.cwd());
  } catch {
    process.stderr.write('trace-link-suggestions: project root is unreadable\n');
    return 1;
  }
  const config = options.config ?? await readTraceLinkSuggestionsConfig(rootDir, options);
  const cliEnabled = parsed.enabled;
  const enabled = config.enabledMalformed ? false : (cliEnabled ?? config.enabled);
  const configCodes = (config.diagnostics ?? [])
    .filter((diagnostic) => String(diagnostic.code).startsWith('trace-link-suggestions:')
      || diagnostic.code === 'config-unreadable' || diagnostic.code === 'config-malformed')
    .map((diagnostic) => diagnostic.code);
  if (enabled !== true) {
    const codes = configCodes.length > 0
      ? ['trace-link-suggestions-disabled', ...configCodes.slice(0, 11)]
      : ['trace-link-suggestions-disabled'];
    emit(notRunEnvelope(codes), parsed.json);
    return 0;
  }
  // Presence and form were already validated before any read (decision 7);
  // the disabled branch above can no longer swallow a custody-invalid id.
  const changeId = parsed.changeId;
  if (parsed.testPaths.length > MAX_TEST_INPUTS) {
    emit(notRunEnvelope(['test-inputs-limit-exceeded']), parsed.json);
    return 2;
  }
  for (const testPath of parsed.testPaths) {
    if (!validateFileForm(testPath) || !TEST_PATH_FORM.test(testPath)) {
      emit(notRunEnvelope([`invalid-test-input:${testPath}`]), parsed.json);
      return 2;
    }
  }
  const uniqueTestPaths = [...new Set(parsed.testPaths)];

  // Custody trace read: bounded not_run codes on any refusal — never an
  // interpreted payload, never an empty "success" list.
  const traceManifest = await readTraceManifest(rootDir, changeId, options);
  if (!traceManifest.ok) {
    emit(notRunEnvelope([traceManifest.code]), parsed.json);
    return 0;
  }
  const deadlineExceeded = () => (now() - startedAt) >= (options.deadlineMs ?? DEFAULT_DEADLINE_MS);

  try {
    const diagnostics = [...(config.diagnostics ?? [])];
    // Requirement sources are the canonical change artifacts of this change
    // only: a bounded local walk of the change's own specs directory (files
    // named spec.md, parity with the canonical collector's isSpecMarkdown).
    // Base specs, proposal/design/tasks, and every other canonical file are
    // outside the presented scope and are never read; every read is bounded.
    const specCollection = await collectDeltaSpecs(rootDir, changeId, diagnostics);
    const specs = specCollection.specs;
    if (deadlineExceeded()) {
      emit(notRunEnvelope(['deadline-exceeded']), parsed.json);
      return 0;
    }
    // Test allowlist was fixed from the presented --test inputs before any
    // read (arguments were validated above); each presented path is read
    // bounded exactly once.
    const tests = [];
    for (const testPath of uniqueTestPaths) {
      let bytes = null;
      try {
        bytes = await readProviderFile(rootDir, testPath, DOCUMENT_LIMIT);
      } catch (error) {
        bytes = null;
        diagnostics.push({ code: 'malformed-input', path: testPath, detail: String(error?.message ?? error).slice(0, 80) });
      }
      if (bytes === null) {
        tests.push({ path: testPath, ok: false, code: 'file-missing', bytes: null, sha256: null, text: '' });
        diagnostics.push({ code: 'file-missing', path: testPath, detail: 'test-input' });
        continue;
      }
      let text = '';
      let ok = true;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch {
        ok = false;
        text = '';
      }
      tests.push({ path: testPath, ok, code: ok ? null : 'utf8-fatal', bytes, sha256: digest(bytes), text });
      if (!ok) diagnostics.push({ code: 'malformed-input', path: testPath, detail: 'utf8-fatal' });
    }

    const missingSources = [];
    // Every declared-but-unreadable source is an honest missing entry: spec
    // files (missing, dangling symlink, malformed UTF-8) degrade coverage
    // exactly like unreadable presented tests, so a scan that skipped a
    // canonical input can never report `none`. The budget cap keeps the
    // observation within its schema bounds; truncation is itself a coverage
    // fact recorded as a diagnostic.
    for (const spec of specs) {
      if (!spec.ok) missingSources.push({ path: spec.path, reason: String(spec.reason ?? 'unreadable').slice(0, 200) });
    }
    for (const test of tests) {
      if (!test.ok) missingSources.push({ path: test.path, reason: String(test.code ?? 'unreadable').slice(0, 200) });
    }
    // The true missing count is captured BEFORE the cap (S3): a consumer must
    // see that the missing_sources list itself was truncated even when the
    // diagnostic tail is dropped by the bounded diagnostics budget.
    const missingSourcesCount = missingSources.length;
    let missingSourcesCapped = false;
    if (missingSources.length > MAX_MISSING_SOURCES) {
      missingSources.length = MAX_MISSING_SOURCES;
      missingSourcesCapped = true;
      diagnostics.push({ code: 'missing-sources-truncated', path: null, detail: `limit=${MAX_MISSING_SOURCES}` });
    }
    if (deadlineExceeded()) {
      emit(notRunEnvelope(['deadline-exceeded']), parsed.json);
      return 0;
    }
    // Unreadable declared specs are visible to resolution: trace refs that
    // cannot resolve while the spec inventory is incomplete are attributed to
    // the missing sources (affected edges dropped, scan stays partial) instead
    // of destroying the whole partial result with a typed refusal.
    const specsIncomplete = specCollection.truncated || specs.some((spec) => !spec.ok);
    const graph = buildGraph({ traceManifest, specs, tests, diagnostics, specsIncomplete });
    if (graph.refusal) {
      emit(notRunEnvelope([`invalid-candidate:${graph.refusal.reason}`]), parsed.json);
      return 2;
    }
    if (deadlineExceeded()) {
      emit(notRunEnvelope(['deadline-exceeded']), parsed.json);
      return 0;
    }
    // Consistent units on both sides: declared = delta spec files + presented
    // test paths + supported-kind trace nodes; scanned = the same universe
    // actually read/resolved. A test is counted once, spec files count even
    // when unreadable (they are declared inputs), unsupported trace kinds are
    // bounded diagnostics rather than declared sources.
    // Unique supported symbols on both sides: a repeated trace node counts
    // once as declared and at most once as resolved.
    const supportedTraceSymbols = new Set(traceManifest.trace.nodes
      .map((node) => node.symbol)
      .filter((symbol) => kindForSymbol(symbol) !== null));
    // The declared/scanned schema maximum (100000) cannot express the largest
    // admissible trace (100000 supported nodes + specs + tests): when the
    // accounting overflows, the counts clamp to the schema bound and the
    // degradation is recorded as a truncation (partial -> abstain), never a
    // schema-parity crash.
    const MAX_ACCOUNTED_SOURCES = 100000;
    let truncations = [...graph.truncations];
    if (specCollection.truncated) truncations.push('delta-spec-inventory-truncated');
    if (missingSourcesCapped) truncations.push('missing-sources-truncated');
    let declaredSources = specs.length + uniqueTestPaths.length + supportedTraceSymbols.size;
    let scannedSources = specs.filter((spec) => spec.ok).length
      + tests.filter((test) => test.ok).length
      + graph.resolvedTraceRefs;
    if (declaredSources > MAX_ACCOUNTED_SOURCES || scannedSources > MAX_ACCOUNTED_SOURCES) {
      truncations.push('declared-sources-truncated');
      diagnostics.push({ code: 'declared-sources-truncated', path: null, detail: `limit=${MAX_ACCOUNTED_SOURCES}` });
      declaredSources = Math.min(declaredSources, MAX_ACCOUNTED_SOURCES);
      scannedSources = Math.min(scannedSources, MAX_ACCOUNTED_SOURCES);
    }
    truncations.sort();
    const partial = traceManifest.trace.completeness === 'partial' || truncations.length > 0 || missingSources.length > 0;
    const coverage = {
      state: partial ? 'partial' : 'full',
      declared_sources: declaredSources,
      scanned_sources: scannedSources,
      missing_sources: missingSources,
      missing_sources_count: missingSourcesCount,
      truncations,
    };
    if (traceManifest.trace.completeness === 'partial') {
      diagnostics.push({ code: 'trace-incomplete', path: traceManifestPath(changeId), detail: 'completeness=partial' });
    }
    const byOutcome = { candidate: 0, related_only: 0 };
    for (const edge of graph.edges) byOutcome[edge.outcome] += 1;
    const outcome = coverage.state === 'partial'
      ? 'abstain'
      : (graph.edges.length === 0 ? 'none' : (byOutcome.candidate > 0 ? 'candidate' : 'related_only'));
    const structural = {
      trace: {
        path: traceManifestPath(changeId),
        sha256: traceManifest.sha256,
        bytes: traceManifest.bytes,
        schema_version: traceManifest.trace.schemaVersion,
        identity: traceManifest.trace.identity,
        completeness: traceManifest.trace.completeness,
        manifest_digest: traceManifest.manifestDigest,
      },
      scan: {
        coverage: coverage.state,
        declared_sources: coverage.declared_sources,
        scanned_sources: coverage.scanned_sources,
        missing_sources: coverage.missing_sources,
        delta_spec_inventory: specs.map((spec) => spec.path).sort(),
        missing_sources_count: coverage.missing_sources_count,
        truncations: coverage.truncations,
      },
      outcome,
      outcome_summary: {
        total_nodes: graph.nodes.length,
        total_edges: graph.edges.length,
        by_outcome: byOutcome,
      },
      nodes: graph.nodes,
      edges: graph.edges,
    };

    const languageDocs = specs.filter((spec) => spec.text.length > 0).map((spec) => ({ text: spec.text }));
    const prose = resolveProseLanguage(languageDocs, null);
    const resolvedLanguage = languageDocs.length > 0 ? prose.language : 'unknown';
    const worktreeIdentity = await computeWorktreeIdentity(rootDir, options);
    // One shared byte classifier for the scan, the freshness probe, and
    // revalidation: a malformed-UTF-8 input records kind `malformed` at write
    // time and revalidates as `malformed`, so a recorded observation is never
    // "born stale" and the probe never lies about unchanged inputs.
    const inputRecords = [
      ...specs.map((spec) => ({ path: spec.path, ...classifyInputBytes(spec.bytes) })),
      ...tests.map((test) => ({ path: test.path, ...classifyInputBytes(test.bytes) })),
    ];
    const inputs = inputRecords.map((input) => ({ path: input.path, sha256: input.sha256, bytes: input.bytes, kind: input.kind }));
    const deltaSpecInventory = specs.map((spec) => spec.path).sort();
    const context = await currentTraceLinkContext(rootDir, inputs, options);
    const candidatePayloadDigest = assessmentDigest({ nodes: graph.nodes, edges: graph.edges });
    const traceBinding = {
      path: structural.trace.path,
      sha256: structural.trace.sha256,
      bytes: structural.trace.bytes,
    };
    const binding = buildAssessmentBinding(traceLinkSuggestionsBindingObject({
      worktreeIdentity,
      changeId,
      trace: traceBinding,
      validatedExportDigest: structural.trace.manifest_digest,
      inputDigests: context.inputDigests,
      deltaSpecInventory,
      candidatePayloadDigest,
      graphLimits: { ...GRAPH_LIMITS },
      rubric: context.rubric,
      relationPolicy: context.relationPolicy,
      engine: context.engine,
      helper: context.helper,
      contract: context.contract,
      languageOptions: { override: null, resolved: resolvedLanguage },
      exclusionPolicy: { ...TRACE_LINK_EXCLUSION_POLICY },
    }));

    // Post-scan freshness probe: re-reads current disk state and compares the
    // recomputed binding against the one built from the scanned bytes, so a
    // mid-scan swap yields stale, not a silent current. The probe re-derives
    // the delta-spec inventory too, so a spec added mid-run drifts — unless
    // the scan-time walk was itself truncated: a capped inventory is a prefix
    // that cannot prove or disprove drift beyond the cap, and the observation
    // already reports that degradation (partial coverage, abstain). Read-time
    // revalidation stays conservative: a truncated fresh walk marks stale.
    if (typeof options.mutateDuringScan === 'function') await options.mutateDuringScan();
    const inventoryProvable = !specCollection.truncated;
    let probeInventory = deltaSpecInventory;
    const watch = {
      changed: async () => {
        const freshTrace = await readTraceManifest(rootDir, changeId, options);
        if (!freshTrace.ok || freshTrace.sha256 !== structural.trace.sha256 || freshTrace.bytes !== structural.trace.bytes) return true;
        if (inventoryProvable) {
          const freshWalk = await collectDeltaSpecPaths(rootDir, changeId);
          // A truncated probe walk cannot prove inventory equality: drift wins.
          if (freshWalk.truncated) return true;
          probeInventory = freshWalk.paths.sort();
          if (probeInventory.join('|') !== deltaSpecInventory.join('|')) return true;
        }
        const freshInputs = [];
        for (const input of inputs) {
          let bytes = null;
          try { bytes = await readProviderFile(rootDir, input.path, DOCUMENT_LIMIT); } catch { bytes = null; }
          freshInputs.push({ path: input.path, ...classifyInputBytes(bytes) });
        }
        const current = await currentTraceLinkContext(rootDir, freshInputs, options);
        return buildAssessmentBinding(traceLinkSuggestionsBindingObject({
          worktreeIdentity: await computeWorktreeIdentity(rootDir, options),
          changeId,
          trace: { path: structural.trace.path, sha256: freshTrace.sha256, bytes: freshTrace.bytes },
          validatedExportDigest: freshTrace.manifestDigest,
          inputDigests: current.inputDigests,
          deltaSpecInventory: probeInventory,
          candidatePayloadDigest,
          graphLimits: { ...GRAPH_LIMITS },
          rubric: current.rubric,
          relationPolicy: current.relationPolicy,
          engine: current.engine,
          helper: current.helper,
          contract: current.contract,
          languageOptions: { override: null, resolved: resolvedLanguage },
          exclusionPolicy: { ...TRACE_LINK_EXCLUSION_POLICY },
        })) !== binding;
      },
    };

    // The semantic stage is opt-in-DI only in this phase: without an injected
    // assessor the helper returns an honest not_run, and the deterministic
    // structural results above stay intact in their own section.
    const assessorInput = {
      edges: graph.edges.map((edge) => ({
        edge_id: edge.edge_id,
        relation: edge.relation,
        outcome: edge.outcome,
        from_node_id: edge.from_node_id,
        to_node_id: edge.to_node_id,
      })),
      language: resolvedLanguage,
    };
    // The semantic stage gets only the REMAINING command budget, not a fresh
    // full deadline: the deadline bounds the whole command, not its segments.
    // The remaining budget is measured with a SINGLE clock read — measuring
    // it separately from an earlier deadline pre-check meant two different
    // now() reads, so a deadline crossed between them could fall through to a
    // floor-clamped positive remainder (S2). An exhausted or crossed budget
    // stops here — the assessor is never invoked just to have its result
    // discarded by the final deadline check, and the remainder is never
    // clamped to a positive value.
    const remainingBudget = (options.deadlineMs ?? DEFAULT_DEADLINE_MS) - (now() - startedAt);
    if (remainingBudget <= 0) {
      emit(notRunEnvelope(['deadline-exceeded']), parsed.json);
      return 0;
    }
    const semanticOutcome = await runTypedAssessment({
      assessor: typeof options.assessor === 'function' ? options.assessor : null,
      input: assessorInput,
      coverage,
      limits: { deadlineMs: remainingBudget, maxFindings: GRAPH_LIMITS.max_edges, maxDiagnostics: MAX_DIAGNOSTICS },
      watch,
      now,
    });
    const semantic = normalizeSemanticOutcome(semanticOutcome, new Set(graph.edges.map((edge) => edge.edge_id)));
    // Coverage degradations established by the helper (scanned/declared
    // clamps, missing entries) are authoritative for a stage that actually
    // ran: merge to the honest direction instead of re-asserting the
    // pre-scan estimate. An abstention never claims scanned coverage.
    const coverageRank = { none: 0, partial: 1, full: 2 };
    const helperRan = semanticOutcome.run_status === 'complete';
    const helperCoverageState = helperRan && coverageRank[semanticOutcome.coverage?.state] !== undefined
      ? semanticOutcome.coverage.state
      : coverage.state;
    const mergedCoverageState = coverageRank[coverage.state] <= coverageRank[helperCoverageState] ? coverage.state : helperCoverageState;
    // The semantic coverage section has its own closed shape (no scan
    // accounting fields): project it explicitly instead of spreading the
    // structural coverage object.
    const semanticCoverage = {
      state: semantic.abstained ? 'none' : mergedCoverageState,
      declared_sources: coverage.declared_sources,
      scanned_sources: coverage.scanned_sources,
      missing_sources: coverage.missing_sources,
    };

    const combinedDiagnostics = [...semantic.diagnostics, ...diagnostics];
    if (combinedDiagnostics.length > MAX_DIAGNOSTICS) {
      // Coverage-fact markers survive the bounded diagnostics budget (S3):
      // a consumer must learn that missing_sources or the anchor scan was
      // truncated even when ordinary diagnostics fill the budget.
      const reserved = combinedDiagnostics.filter((entry) => COVERAGE_FACT_DIAGNOSTIC_CODES.has(entry?.code));
      const ordinary = combinedDiagnostics.filter((entry) => !COVERAGE_FACT_DIAGNOSTIC_CODES.has(entry?.code));
      const replacement = [
        ...ordinary.slice(0, Math.max(0, MAX_DIAGNOSTICS - 1 - reserved.length)),
        ...reserved,
      ].slice(0, MAX_DIAGNOSTICS - 1);
      combinedDiagnostics.length = 0;
      combinedDiagnostics.push(...replacement);
      combinedDiagnostics.push({ code: 'diagnostics-truncated', path: null, detail: `limit=${MAX_DIAGNOSTICS}` });
    }
    const observation = assembleObservation({
      changeId,
      generatedAt: new Date(startedAt).toISOString(),
      structural,
      semantic: {
        run_status: semantic.run_status,
        freshness: semantic.freshness,
        abstained: semantic.abstained,
        outcome_reason: semantic.outcome_reason,
        coverage: semanticCoverage,
        assessments: semantic.assessments,
      },
      inputs,
      context,
      language: resolvedLanguage,
      languageSource: prose.source,
      worktreeIdentity,
      binding,
      diagnostics: combinedDiagnostics,
    });
    // The engine-owned builder cannot produce a shape-violating graph, so
    // this is a defensive gate: if it ever fires, the delta contract demands
    // a typed `invalid-candidate:<code>` refusal before any persistence —
    // never a crash and never a written observation.
    try {
      assertStructuralInvariants(observation);
    } catch (error) {
      const shapeCode = /invalid graph shape: ([a-z-]+)/.exec(String(error?.message ?? error))?.[1] ?? 'invalid-shape';
      emit(notRunEnvelope([`invalid-candidate:${shapeCode}`]), parsed.json);
      return 2;
    }
    if (Buffer.byteLength(JSON.stringify(observation, null, 2), 'utf8') > GRAPH_LIMITS.max_observation_bytes) {
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
    // The deadline bounds the whole command: a budget exhausted between the
    // scan and the persistence is a bounded not_run, never a half-run write.
    if (deadlineExceeded()) {
      emit(notRunEnvelope(['deadline-exceeded']), parsed.json);
      return 0;
    }
    if (parsed.write) {
      const written = await writeTraceLinkObservation(rootDir, observation, config, options);
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
  process.exitCode = await runTraceLinkSuggestionsCommand();
}
