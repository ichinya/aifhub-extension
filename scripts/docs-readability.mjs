// Opt-in, non-blocking readability diagnostics for documents bound to an OpenSpec
// change (issue #228). Advisory only: this module never creates an
// `aif-gate-result`, never writes QA evidence, and grants no workflow authority.
// Untrusted document text is data, never commands: the analysis path below
// imports no process/network API, never opens URLs, and never executes anything
// named in a document. The single sanctioned git touchpoint is the fixed-path
// writer guard in `docs-readability-git-guard.mjs`, which only ever receives
// repository-relative paths validated here.
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { digest, canonical, portablePath } from './workflow-state-store.mjs';
import { parseStrictJson } from './json-strict.mjs';
import { validateJsonAgainstSchema } from './json-schema-subset.mjs';
import { safeProviderPath, readProviderFile } from './provider-files.mjs';
import { normalizeChangeId } from './active-change-resolver.mjs';
import { verifyReportIgnored } from './docs-readability-git-guard.mjs';

export const READABILITY_SCHEMA = 'aifhub.docs_readability.v1';
export const READABILITY_PROFILE_SCHEMA = 'aifhub.docs_readability_profile.v1';
// Closed write-time states. `stale-report` is a read-time revalidation outcome
// (see validateReportBinding), never a persisted report state.
export const READABILITY_STATES = Object.freeze([
  'complete', 'partial-coverage', 'checker-unavailable', 'empty-input',
  'wrong-language', 'ambiguous-language', 'malformed-input', 'timeout',
]);
export const STALE_REPORT_STATE = 'stale-report';
export const PARSER_VERSION = 1;
export const DOCUMENT_LIMIT = 1024 * 1024;
export const ENGINE_MODULE = 'scripts/docs-readability.mjs';
export const PROFILE_MODULE = 'scripts/docs-readability.profile.json';
export const STATE_ROOT = '.ai-factory/state';
export const QA_ROOT = '.ai-factory/qa';
const DEFAULT_CONTEXT_PATH = 'CONTEXT.md';
const DEFAULT_DEADLINE_MS = 30000;
const MAX_FINDINGS = 5000;
const MAX_FINDINGS_PER_DOCUMENT = 2000;
const MAX_DIAGNOSTICS = 200;
// Deterministic degradation aggregation: the first state on this scale wins.
const SEVERITY = Object.freeze([
  'malformed-input', 'timeout', 'checker-unavailable', 'wrong-language',
  'ambiguous-language', 'partial-coverage',
]);
export const usage = 'ai-factory aifhub-docs-readability --change <id> [--enabled true|false] --file <path> [--file <path> ...] [--language ru|en] [--json] [--write]';

// ---------------------------------------------------------------------------
// Argument parsing (explicit-only; unknown/duplicate/missing -> invalid usage)
// ---------------------------------------------------------------------------

export function parseReadabilityArgs(argv) {
  // The accumulator carries the flags seen before an error, so invalid-usage
  // envelopes honor an earlier --json instead of downgrading to human text.
  const result = { ok: true, changeId: null, files: [], language: null, json: false, write: false, enabled: null, error: null };
  const invalid = (error) => ({ ...result, ok: false, error });
  const seen = new Set();
  const args = Array.from(argv ?? []);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--json' || arg === '--write') {
      if (seen.has(arg)) return invalid(`duplicate option: ${arg}`);
      seen.add(arg);
      result.json = result.json || arg === '--json';
      result.write = result.write || arg === '--write';
      continue;
    }
    if (!['--change', '--file', '--language', '--enabled'].includes(arg)) {
      return invalid(`unknown option: ${arg}`);
    }
    if (arg !== '--file' && seen.has(arg)) return invalid(`duplicate option: ${arg}`);
    if (arg !== '--file') seen.add(arg);
    const value = args[index + 1];
    if (typeof value !== 'string' || value.startsWith('--')) return invalid(`missing value for ${arg}`);
    index += 1;
    if (arg === '--change') result.changeId = value;
    else if (arg === '--file') result.files.push(value);
    else if (arg === '--language') {
      if (!['ru', 'en'].includes(value)) return invalid(`unsupported --language value: ${value}`);
      result.language = value;
    } else {
      if (!['true', 'false'].includes(value)) return invalid(`--enabled expects true|false, got: ${value}`);
      result.enabled = value === 'true';
    }
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
// Bounded config read (subset parser modeled on parseSimpleYaml)
// ---------------------------------------------------------------------------

export async function readReadabilityConfig(rootDir, options = {}) {
  const diagnostics = [];
  const config = {
    enabled: null, // null = key absent -> default false
    enabledMalformed: false,
    stateRoot: STATE_ROOT,
    qaRoot: QA_ROOT,
    contextPath: DEFAULT_CONTEXT_PATH,
  };
  let bytes = null;
  try {
    bytes = await readProviderFile(rootDir, '.ai-factory/config.yaml', 256 * 1024);
  } catch (error) {
    // Bounded-reader rejections degrade the config read; defaults stay safe.
    diagnostics.push({ code: 'config-unreadable', path: '.ai-factory/config.yaml', detail: String(error?.message ?? error) });
    return { ...config, diagnostics };
  }
  if (bytes === null) return { ...config, diagnostics };
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    diagnostics.push({ code: 'config-malformed', path: '.ai-factory/config.yaml', detail: 'utf8-fatal' });
    return { ...config, diagnostics };
  }
  const parsed = parseConfigSubset(text);
  const enabled = parsed?.aifhub?.readability?.enabled;
  if (enabled !== undefined) {
    if (typeof enabled === 'boolean') config.enabled = enabled;
    else {
      config.enabledMalformed = true;
      diagnostics.push({ code: 'config-malformed', path: '.ai-factory/config.yaml', detail: 'aifhub.readability.enabled is not a boolean' });
    }
  }
  const stateRoot = normalizeConfigPath(parsed?.paths?.state);
  if (stateRoot !== null) config.stateRoot = stateRoot;
  const qaRoot = normalizeConfigPath(parsed?.paths?.qa);
  if (qaRoot !== null) config.qaRoot = qaRoot;
  const contextPath = normalizeConfigPath(parsed?.paths?.context);
  if (contextPath !== null) config.contextPath = contextPath;
  return { ...config, diagnostics };
}

function normalizeConfigPath(value) {
  if (typeof value !== 'string' || !value) return null;
  const normalized = value.replaceAll('\\', '/').replace(/^['"]|['"]$/g, '').replace(/\/+$/, '');
  return normalized || null;
}

// Nested-key subset parser: indentation stack, comments stripped, boolean and
// number scalars; modeled on parseSimpleYaml (scripts/aif-artifact-sync.mjs).
export function parseConfigSubset(raw) {
  const root = {};
  const stack = [{ indent: -1, value: root }];
  for (const rawLine of String(raw ?? '').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const withoutComment = rawLine.replace(/\s+#.*$/, '');
    if (withoutComment.trim().length === 0) continue;
    const match = /^(\s*)([^:]+):(?:\s*(.*))?$/.exec(withoutComment);
    if (!match) continue;
    const indent = match[1].length;
    const key = match[2].trim();
    const rawValue = match[3]?.trim() ?? '';
    while (stack.length > 1 && stack.at(-1).indent >= indent) stack.pop();
    const parent = stack.at(-1).value;
    if (rawValue.length === 0) {
      parent[key] = {};
      stack.push({ indent, value: parent[key] });
      continue;
    }
    const unquoted = /^(['"]).*\1$/.test(rawValue) ? rawValue.slice(1, -1) : rawValue.replace(/^['"]|['"]$/g, '');
    // Quoted values are strings by construction: `enabled: "true"` must stay a
    // non-boolean diagnostic instead of silently flipping the opt-in.
    if (/^(['"]).*\1$/.test(rawValue)) parent[key] = unquoted;
    else if (/^(true|false)$/i.test(unquoted)) parent[key] = unquoted.toLowerCase() === 'true';
    else if (/^-?\d+(?:\.\d+)?$/.test(unquoted)) parent[key] = Number(unquoted);
    else parent[key] = unquoted;
  }
  return root;
}

// ---------------------------------------------------------------------------
// Profile (pinned, offline, resolved next to this module)
// ---------------------------------------------------------------------------

export async function loadProfile(options = {}) {
  const profileUrl = new URL('./docs-readability.profile.json', import.meta.url);
  const reader = options.readProfile ?? ((url) => readFile(url));
  let bytes;
  try {
    bytes = await reader(profileUrl);
  } catch {
    return { ok: false, sha256: null, diagnostics: [{ code: 'profile-unavailable', path: PROFILE_MODULE, detail: 'profile-missing' }] };
  }
  const sha256 = digest(bytes);
  let parsed;
  try {
    parsed = parseStrictJson(bytes.toString('utf8'));
  } catch {
    return { ok: false, sha256, diagnostics: [{ code: 'profile-unavailable', path: PROFILE_MODULE, detail: 'profile-corrupt' }] };
  }
  const problems = validateProfileShape(parsed);
  if (problems.length > 0) {
    return { ok: false, sha256, diagnostics: [{ code: 'profile-unavailable', path: PROFILE_MODULE, detail: problems.join('; ') }] };
  }
  const rules = new Map();
  for (const rule of parsed.rules) rules.set(rule.id, { ...rule });
  return { ok: true, sha256, profile: { id: parsed.profile_id, version: parsed.profile_version, rules }, diagnostics: [] };
}

function validateProfileShape(parsed) {
  const problems = [];
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return ['profile is not an object'];
  if (parsed.schema !== READABILITY_PROFILE_SCHEMA) problems.push('unexpected profile schema');
  if (typeof parsed.profile_id !== 'string' || !parsed.profile_id) problems.push('profile_id missing');
  if (!Number.isInteger(parsed.profile_version) || parsed.profile_version < 1) problems.push('profile_version invalid');
  if (!Array.isArray(parsed.rules) || parsed.rules.length === 0) problems.push('rules must be a non-empty array');
  for (const rule of Array.isArray(parsed.rules) ? parsed.rules : []) {
    if (!rule || typeof rule !== 'object') { problems.push('rule is not an object'); continue; }
    if (typeof rule.id !== 'string' || !rule.id.startsWith('docs-readability:')) problems.push(`unknown rule id: ${String(rule.id)}`);
    if (!Number.isInteger(rule.version) || rule.version < 1) problems.push(`rule version invalid: ${String(rule.id)}`);
    if (!['project', 'upstream'].includes(rule.origin)) problems.push(`rule origin invalid: ${String(rule.id)}`);
    if (rule.type === 'phrase-list') {
      // Every entry must be a non-empty string: a single malformed phrase must
      // degrade to checker-unavailable instead of crashing the rule engine.
      if (!Array.isArray(rule.phrases) || rule.phrases.length === 0
        || !rule.phrases.every((p) => typeof p === 'string' && p.length > 0)) problems.push(`phrase list invalid: ${String(rule.id)}`);
    } else if (rule.type === 'sentence-length') {
      for (const sectionClass of ['procedure', 'description', 'requirement', 'acceptance', 'general']) {
        const threshold = rule.thresholds?.[sectionClass];
        if (!threshold || typeof threshold !== 'object'
          || !Number.isInteger(threshold.ru) || !Number.isInteger(threshold.en)) {
          problems.push(`sentence thresholds incomplete for ${sectionClass}: ${String(rule.id)}`);
        }
      }
    } else if (rule.type === 'unbalanced-pair') {
      if (!Array.isArray(rule.pairs) || rule.pairs.length === 0
        || !rule.pairs.every((pair) => Array.isArray(pair) && pair.length === 2
          && typeof pair[0] === 'string' && pair[0].length === 1
          && typeof pair[1] === 'string' && pair[1].length === 1)) {
        problems.push(`pairs invalid: ${String(rule.id)}`);
      }
    } else if (rule.type === 'quote-mismatch') {
      if (!Array.isArray(rule.disallowed) || rule.disallowed.length === 0
        || !rule.disallowed.every((mark) => typeof mark === 'string' && [...mark].length === 1)) {
        problems.push(`disallowed quotes invalid: ${String(rule.id)}`);
      }
    } else if (rule.type !== 'glossary-term') {
      problems.push(`unknown rule type: ${String(rule.type)}`);
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Position-preserving document model (source bytes are the only coordinates)
// ---------------------------------------------------------------------------

const ASTRAL_HIGH = 0xD800;
const ASTRAL_LOW = 0xDBFF;
const ASTRAL_MAX = 0xDFFF;

// String-index -> UTF-8 byte offset for every code unit of a well-formed string
// (the input was decoded with fatal UTF-8, so no lone surrogates exist).
export function buildByteOffsets(text) {
  const offsets = new Array(text.length + 1);
  let offset = 0;
  let index = 0;
  while (index < text.length) {
    const code = text.charCodeAt(index);
    const isPair = code >= ASTRAL_HIGH && code <= 0xDBFF && index + 1 < text.length
      && text.charCodeAt(index + 1) >= ASTRAL_LOW && text.charCodeAt(index + 1) <= ASTRAL_MAX;
    const bytes = isPair ? 4 : code >= 0x800 ? 3 : code >= 0x80 ? 2 : 1;
    offsets[index] = offset;
    if (isPair) offsets[index + 1] = offset + 2;
    offset += bytes;
    index += isPair ? 2 : 1;
  }
  offsets[text.length] = offset;
  return offsets;
}

function fenceLineMask(bareLines) {
  const mask = [];
  let fence = null;
  for (const line of bareLines) {
    const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fenceMatch) {
      const token = fenceMatch[1];
      if (fence === null) fence = { char: token[0], length: token.length };
      else if (token[0] === fence.char && token.length >= fence.length
        && /^\s*$/.test(line.slice(fenceMatch[0].length))) fence = null;
      mask.push(true);
      continue;
    }
    mask.push(fence !== null);
  }
  return mask;
}

function lineLevelExclusion(bare) {
  return /^\s{0,3}\$\s/.test(bare) // shell command line
    || /^\s{0,3}PS [A-Za-z]:\\.*>/.test(bare) // PowerShell prompt
    || /^\s{0,3}[A-Za-z]:\\.*>/.test(bare) // cmd.exe prompt
    || /^\s{0,3}\[[^\]]+\]:\s*\S/.test(bare); // link-reference definition
}

function leadingIndent(bare) {
  let indent = 0;
  for (const ch of bare) {
    if (ch === ' ') indent += 1;
    else if (ch === '\t') indent += 4 - (indent % 4);
    else break;
  }
  return indent;
}

function listMarkerIndent(bare) {
  // The leading-indent gate lives in the caller; here any indent is accepted
  // so nested markers (inside an open container) are recognized.
  const match = /^ *(?:[-*+]|\d{1,9}[.)])(?:[ \t]+|$)/.exec(bare);
  if (!match) return null;
  // Content indent is the expanded visual column (tabs count up to the next
  // multiple of four), not the raw character count of the prefix.
  const contentIndent = expandedWidth(match[0]);
  // A bare marker line ("-") behaves like a marker plus one space of content.
  return match[0].length === bare.length ? contentIndent + 1 : contentIndent;
}

function expandedWidth(prefix) {
  let width = 0;
  for (const ch of prefix) {
    if (ch === ' ') width += 1;
    else if (ch === '\t') width += 4 - (width % 4);
  }
  return width;
}

function lineKind(bare) {
  const withoutBom = bare.replace(/^\uFEFF/, '');
  if (/^ {0,3}#{1,6}(?:[ \t]+|$)/.test(withoutBom)) return 'heading';
  if (/^ {0,3}>/.test(withoutBom)) return 'quote';
  if (/^ {0,3}\|/.test(withoutBom)) return 'table';
  return 'text';
}

// Cross-line CommonMark code spans: exact-length backtick runs pair within one
// paragraph (blank lines and paragraph breaks end a span; blocked lines such
// as fences interrupt it). Runs pair with the most recent unpaired opener of
// the same length — an orphan opener stays literal prose and never blocks
// later pairs. Characters already excluded (link destinations, bare URLs) are
// syntax, not span content, and never open or close a span.
function scanInlineCodeSpans(lines, fenceMask, lineBlocked, excluded, firstBodyLine, isSkipped) {
  const breaks = paragraphBoundaries({ lines, fenceMask });
  const openers = [];
  for (let index = firstBodyLine; index < lines.length; index += 1) {
    const line = lines[index];
    if (lineBlocked[index]) { openers.length = 0; continue; }
    if (breaks.has(line.start)) openers.length = 0;
    const bare = line.bare;
    let i = 0;
    while (i < bare.length) {
      if (bare[i] === '`' && !(isSkipped && isSkipped(line.start + i))) {
        let run = 0;
        while (bare[i + run] === '`') run += 1;
        const position = line.start + i;
        let openerIndex = -1;
        for (let cursor = openers.length - 1; cursor >= 0; cursor -= 1) {
          if (openers[cursor].run === run) { openerIndex = cursor; break; }
        }
        if (openerIndex >= 0) {
          excluded.push({ s: openers[openerIndex].s, e: position + run });
          openers.length = openerIndex;
        } else {
          openers.push({ run, s: position });
        }
        i += run;
        continue;
      }
      i += 1;
    }
  }
}

export function buildDocumentModel(text) {
  const rawLines = String(text).match(/[^\r\n]*(?:\r\n|\r|\n|$)/g) ?? [''];
  if (rawLines.length > 1 && rawLines[rawLines.length - 1] === '') rawLines.pop();
  const lines = [];
  let cursor = 0;
  for (const raw of rawLines) {
    const bare = raw.replace(/(?:\r\n|\r|\n)$/, '');
    lines.push({ bare, start: cursor, bodyEnd: cursor + bare.length, end: cursor + raw.length });
    cursor += raw.length;
  }
  const excluded = [];
  const uncovered = [];
  let partial = false;
  // Front matter: a leading --- block is metadata, not prose. A leading BOM is
  // real file content and must not hide the front-matter marker. Fence state
  // is computed over the body only: a ``` line inside closed front matter must
  // not mask the whole document body.
  let firstBodyLine = 0;
  if (lines[0]?.bare.replace(/^\uFEFF/, '').trimEnd() === '---') {
    for (let index = 1; index < lines.length; index += 1) {
      if (lines[index].bare.trimEnd() === '---') {
        for (let front = 0; front <= index; front += 1) excluded.push({ s: lines[front].start, e: lines[front].end });
        firstBodyLine = index + 1;
        break;
      }
    }
    if (firstBodyLine === 0) {
      // Unterminated front matter: the whole leading block is unknown metadata.
      partial = true;
      uncovered.push({ s: lines[0].start, e: lines[lines.length - 1].end, detail: 'unclosed-front-matter' });
      for (let front = 0; front < lines.length; front += 1) excluded.push({ s: lines[front].start, e: lines[front].end });
      firstBodyLine = lines.length;
    }
  }
  const fenceMask = new Array(lines.length).fill(true);
  const bodyMask = fenceLineMask(lines.slice(firstBodyLine).map((line) => line.bare));
  for (let index = firstBodyLine; index < lines.length; index += 1) fenceMask[index] = bodyMask[index - firstBodyLine];
  // An unclosed terminal fence is a known-ambiguous construct: its content is
  // excluded, but the parser reports partial coverage with an uncovered span.
  let openFence = false;
  let openFenceIndex = -1;
  for (let index = firstBodyLine; index < lines.length; index += 1) {
    const fenceMatch = lines[index].bare.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fenceMatch) {
      const token = fenceMatch[1];
      if (openFence === false) {
        openFence = { char: token[0], length: token.length };
        openFenceIndex = index;
      } else if (token[0] === openFence.char && token.length >= openFence.length
        && /^\s*$/.test(lines[index].bare.slice(fenceMatch[0].length))) openFence = false;
    }
  }
  // Pass A: line classification and whole-line exclusions (fences, command
  // lines, indented code with list-container awareness).
  const lineBlocked = new Array(lines.length).fill(false);
  let prevKind = 'blank'; // the document start behaves like a blank line
  let indentedCode = false;
  let listContentIndent = null;
  for (let index = firstBodyLine; index < lines.length; index += 1) {
    const line = lines[index];
    if (fenceMask[index]) {
      excluded.push({ s: line.start, e: line.end });
      lineBlocked[index] = true;
      prevKind = 'fence';
      indentedCode = false;
      continue;
    }
    if (lineLevelExclusion(line.bare)) {
      excluded.push({ s: line.start, e: line.end });
      lineBlocked[index] = true;
      prevKind = 'text';
      continue;
    }
    if (line.bare.trim() === '') {
      // Blank lines continue open indented blocks and list containers.
      prevKind = 'blank';
      indentedCode = false;
      continue;
    }
    const indent = leadingIndent(line.bare);
    // A list marker is recognized up to three columns of its own (or within
    // the open container's content column), so nested markers are not
    // swallowed as indented code. Tabs count as their expanded columns.
    const markerGate = listContentIndent !== null ? listContentIndent + 3 : 3;
    const markerIndent = indent <= markerGate ? listMarkerIndent(line.bare) : null;
    if (markerIndent !== null) {
      listContentIndent = markerIndent;
      prevKind = 'listitem';
      continue; // marker line text stays prose; scanned in pass C
    }
    if (indent >= 4) {
      // Indented code needs the container threshold: inside a list item the
      // block starts only past the item content indent plus four spaces.
      const threshold = listContentIndent !== null ? listContentIndent + 4 : 4;
      const canOpen = prevKind === 'blank' || prevKind === 'code' || prevKind === 'heading' || prevKind === 'fence';
      if ((indentedCode || canOpen) && indent >= threshold) {
        indentedCode = true;
        excluded.push({ s: line.start, e: line.end });
        lineBlocked[index] = true;
        prevKind = 'code';
        continue;
      }
      // Lazy prose continuation (also inside an open list item below the
      // code-block threshold): never treated as code. Continuations at or
      // past the container content column keep the container open.
      prevKind = 'text';
      indentedCode = false;
      if (listContentIndent !== null && indent < listContentIndent) listContentIndent = null;
      continue;
    }
    if (listContentIndent !== null && indent < listContentIndent) listContentIndent = null;
    indentedCode = false;
    prevKind = lineKind(line.bare);
  }
  // Pass B: links, autolinks, HTML tags and bare URLs run first so that
  // backtick characters inside recognized link destinations are syntax and
  // never pair as code spans.
  for (let index = firstBodyLine; index < lines.length; index += 1) {
    if (lineBlocked[index]) continue;
    scanInline(lines[index].bare, lines[index].start, excluded, null);
  }
  excluded.sort((left, right) => left.s - right.s || left.e - right.e);
  const passLinks = [];
  for (const span of excluded) {
    const last = passLinks[passLinks.length - 1];
    if (last && span.s <= last.e) last.e = Math.max(last.e, span.e);
    else passLinks.push({ ...span });
  }
  const isSkipped = makeExclusionPredicate(passLinks);
  // Pass C: cross-line inline code spans over the remaining eligible lines,
  // skipping characters already claimed by link/URL syntax.
  scanInlineCodeSpans(lines, fenceMask, lineBlocked, excluded, firstBodyLine, isSkipped);
  if (openFence !== false && openFenceIndex >= 0) {
    partial = true;
    uncovered.push({ s: lines[openFenceIndex].start, e: lines[lines.length - 1].end, detail: 'unclosed-fence' });
  }
  excluded.sort((left, right) => left.s - right.s || left.e - right.e);
  const merged = [];
  for (const span of excluded) {
    const last = merged[merged.length - 1];
    if (last && span.s <= last.e) last.e = Math.max(last.e, span.e);
    else merged.push({ ...span });
  }
  return { text: String(text), lines, fenceMask, excluded: merged, uncovered, partial };
}

function makeExclusionPredicate(spans) {
  return (index) => {
    let low = 0;
    let high = spans.length - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      const span = spans[mid];
      if (index < span.s) high = mid - 1;
      else if (index >= span.e) low = mid + 1;
      else return true;
    }
    return false;
  };
}

function scanInline(bare, base, excluded, isSkipped) {
  const push = (s, e) => excluded.push({ s: base + s, e: base + e });
  let i = 0;
  while (i < bare.length) {
    const ch = bare[i];
    // Characters already consumed by line-level rules or cross-line code
    // spans are syntax, not prose: links must not be parsed inside them.
    if (isSkipped && isSkipped(base + i)) { i += 1; continue; }
    if (ch === '<') {
      const rest = bare.slice(i);
      const autolink = /^<https?:\/\/[^>\s]*>/i.exec(rest);
      if (autolink) { push(i, i + autolink[0].length); i += autolink[0].length; continue; }
      const tag = /^<\/?[A-Za-z][^<>]*>/.exec(rest);
      if (tag) { push(i, i + tag[0].length); i += tag[0].length; continue; }
      i += 1; continue;
    }
    if (ch === '[') {
      const rest = bare.slice(i);
      // Anchored at the scan position: a link construct must start exactly at
      // this '['; unanchored matching would exclude unrelated prose. The
      // destination accepts up to two levels of balanced parentheses
      // (Wikipedia-style /wiki/Page_(Section) and nested cases); deeper
      // nesting falls back to the balanced bare-URL trim below.
      const inline = /^\[([^\]]*)\]\(((?:[^()]|\((?:[^()]|\([^()]*\))*\))*)\)/.exec(rest);
      if (inline) {
        push(i, i + 1); // the opening bracket is link syntax, not prose
        push(i + 1 + inline[1].length, i + inline[0].length); // ](target) excluded, label stays prose
        i += inline[0].length; continue;
      }
      const reference = /^\[([^\]]+)\]\[([^\]]*)\]/.exec(rest);
      if (reference) {
        push(i, i + 1);
        push(i + 1 + reference[1].length, i + reference[0].length);
        i += reference[0].length; continue;
      }
      i += 1; continue;
    }
    if (ch === 'h' || ch === 'H' || ch === 'w' || ch === 'W') {
      const rest = bare.slice(i);
      const urlMatch = /^(?:https?:\/\/|www\.)[^\s`]+/i.exec(rest);
      if (urlMatch) {
        let urlText = urlMatch[0];
        while (/[.,;:!?'"]$/.test(urlText)) urlText = urlText.slice(0, -1);
        // Strip trailing close parens only while the URL itself is
        // paren-unbalanced: a balanced tail like /Markdown_(язык) keeps its
        // closing paren, so no orphan ')' leaks into the pair balance.
        let openCount = (urlText.match(/\(/g) ?? []).length;
        let closeCount = (urlText.match(/\)/g) ?? []).length;
        while (urlText.endsWith(')') && closeCount > openCount) {
          urlText = urlText.slice(0, -1);
          closeCount -= 1;
        }
        while (/[.,;:!?'"]$/.test(urlText)) urlText = urlText.slice(0, -1);
        push(i, i + urlText.length);
        i += urlText.length; continue;
      }
      i += 1; continue;
    }
    i += 1;
  }
}

function isEligible(model, index) {
  let low = 0;
  let high = model.excluded.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const span = model.excluded[mid];
    if (index < span.s) high = mid - 1;
    else if (index >= span.e) low = mid + 1;
    else return false;
  }
  return true;
}

// Exact active-H2 sections (outside fenced code) with heuristic classification.
const SECTION_CLASSES = Object.freeze([
  ['acceptance', /(?:acceptance|критери|при[её]мк|\bac\b)/i],
  ['requirement', /(?:requirement|требован|scenario|сценар|контракт|contract|спецификац|\bspec)/i],
  ['description', /(?:description|описание|overview|обзор|введение|introduction|about)/i],
  ['procedure', /(?:install|установк|setup|настройк|usage|использован|getting started|начало работ|инструкц|шаг|migration|миграц|upgrade|обновлен|deploy|деплой|запуск)/i],
]);

export function buildSections(model) {
  const sections = [];
  let current = null;
  for (let index = 0; index < model.lines.length; index += 1) {
    const line = model.lines[index];
    if (!model.fenceMask[index] && /^(\uFEFF)?##(?!#)[ \t]+/.test(line.bare)) {
      if (current) sections.push(current);
      const heading = line.bare.replace(/^(\uFEFF)?##[ \t]+/, '').trim();
      current = { heading, start: line.start, end: line.end, sectionClass: classifyHeading(heading) };
    } else if (current) {
      current.end = line.end;
    }
  }
  if (current) sections.push(current);
  if (sections.length === 0) {
    return [{ heading: null, start: 0, end: model.text.length, sectionClass: 'general' }];
  }
  // The prose before the first active H2 belongs to a synthetic general
  // section so every rule covers all eligible text (review: preamble scan).
  const first = sections[0];
  if (first.start > 0) {
    sections.unshift({ heading: null, start: 0, end: first.start, sectionClass: 'general' });
  }
  return sections;
}

function classifyHeading(heading) {
  for (const [sectionClass, pattern] of SECTION_CLASSES) {
    if (pattern.test(heading)) return sectionClass;
  }
  return 'general';
}

function eligibleRuns(model, from, to) {
  const runs = [];
  let runStart = -1;
  for (let index = Math.max(0, from); index < to; index += 1) {
    if (isEligible(model, index)) {
      if (runStart < 0) runStart = index;
    } else if (runStart >= 0) {
      runs.push({ s: runStart, e: index });
      runStart = -1;
    }
  }
  if (runStart >= 0) runs.push({ s: runStart, e: to });
  return runs.filter((run) => run.e > run.s);
}

// ---------------------------------------------------------------------------
// Language resolution (independent of the UI language policy)
// ---------------------------------------------------------------------------

const LANGUAGE_MIN_LETTERS = 200;
const LANGUAGE_CONFIDENCE_SHARE = 0.9;

export function resolveDocumentLanguage(model, override) {
  const runs = eligibleRuns(model, 0, model.text.length);
  let cyrillic = 0;
  let latin = 0;
  for (const run of runs) {
    const chunk = model.text.slice(run.s, run.e);
    cyrillic += (chunk.match(/[\u0400-\u04FF]/g) ?? []).length;
    latin += (chunk.match(/[A-Za-z]/g) ?? []).length;
  }
  const total = cyrillic + latin;
  const confident = total >= LANGUAGE_MIN_LETTERS
    && Math.max(cyrillic, latin) / total >= LANGUAGE_CONFIDENCE_SHARE;
  const detected = confident ? (cyrillic > latin ? 'ru' : 'en') : null;
  if (override !== null && override !== undefined) {
    if (detected !== null && detected !== override) {
      return {
        language: override, languageSource: 'override', resolved: override,
        state: 'wrong-language', observed: detected,
        diagnostic: { code: 'wrong-language', path: null, detail: `detected=${detected} override=${override}` },
      };
    }
    if (detected === null) {
      return {
        language: override, languageSource: 'override', resolved: override,
        state: 'ambiguous-language', observed: null,
        diagnostic: { code: 'ambiguous-language', path: null, detail: 'detection-uncertain-with-override' },
      };
    }
    return { language: override, languageSource: 'override', resolved: override, state: null, observed: detected, diagnostic: null };
  }
  if (detected === null) {
    return {
      language: 'unknown', languageSource: 'detected', resolved: null,
      state: 'ambiguous-language', observed: null,
      diagnostic: { code: 'ambiguous-language', path: null, detail: `letters=${total}` },
    };
  }
  return { language: detected, languageSource: 'detected', resolved: detected, state: null, observed: detected, diagnostic: null };
}

// ---------------------------------------------------------------------------
// Paragraphs and sentences
// ---------------------------------------------------------------------------

function paragraphBoundaries(model) {
  const breaks = new Set();
  let prevWasHeading = false;
  for (let index = 0; index < model.lines.length; index += 1) {
    const line = model.lines[index];
    const bare = line.bare;
    const isHeading = !model.fenceMask[index] && /^(\uFEFF)?#{1,6}[ \t]/.test(bare);
    if (bare.trim() === ''
      || isHeading
      // A heading ends its block: the line after one starts a new paragraph
      // even without a blank line between them.
      || prevWasHeading
      || /^\s{0,3}(?:[-*+]|\d+[.)])(?:[ \t]+|$)/.test(bare)
      || /^\s{0,3}\|/.test(bare)
      || /^\s{0,3}>/.test(bare)
      // Link-reference definitions are syntax, not part of a paragraph.
      || /^\s{0,3}\[[^\]]+\]:\s*\S/.test(bare)
      || model.fenceMask[index]) {
      breaks.add(line.start);
    }
    prevWasHeading = isHeading;
  }
  return breaks;
}

function closeSentence(model, sentences, start, end) {
  let first = start;
  let last = end;
  while (first < last && /\s/.test(model.text[first])) first += 1;
  while (last > first && /\s/.test(model.text[last - 1])) last -= 1;
  if (last <= first) return;
  sentences.push({ s: first, e: last });
}

function collectSentences(model) {
  const breaks = paragraphBoundaries(model);
  const sentences = [];
  let sentenceStart = null;
  const text = model.text;
  for (let index = 0; index < text.length; index += 1) {
    const ch = text[index];
    if (ch === '\n' || ch === '\r') {
      // A newline run closes a sentence when ANY position it crosses starts a
      // new paragraph construct — including the blank line itself inside a
      // multi-newline run. Only single soft wraps inside one paragraph count
      // as whitespace, so hard-wrapped long sentences are measured in full
      // while two unterminated paragraphs never merge.
      let next = index;
      while (next < text.length && (text[next] === '\n' || text[next] === '\r')) next += 1;
      let boundary = next >= text.length;
      for (let p = index + 1; p <= next && !boundary; p += 1) {
        if (breaks.has(p)) boundary = true;
      }
      if (boundary && sentenceStart !== null) {
        closeSentence(model, sentences, sentenceStart, index);
        sentenceStart = null;
      }
      index = next - 1;
      continue;
    }
    if (breaks.has(index) && sentenceStart !== null) {
      closeSentence(model, sentences, sentenceStart, index);
      sentenceStart = null;
    }
    if (!isEligible(model, index)) continue;
    if (sentenceStart === null) sentenceStart = index;
    if (ch === '.' || ch === '!' || ch === '?' || ch === '…') {
      let next = index + 1;
      while (next < text.length && /[)}\]"'»”]/.test(text[next])) next += 1;
      if (next >= text.length || /\s/.test(text[next])) {
        closeSentence(model, sentences, sentenceStart, next);
        sentenceStart = null;
        index = next - 1;
      }
    }
  }
  if (sentenceStart !== null) closeSentence(model, sentences, sentenceStart, text.length);
  return sentences;
}

const WORD_PATTERN = /[\p{L}\p{N}]+/gu;

function countWords(model, sentence) {
  let words = 0;
  for (const run of eligibleRuns(model, sentence.s, sentence.e)) {
    const chunk = model.text.slice(run.s, run.e);
    words += (chunk.match(WORD_PATTERN) ?? []).length;
  }
  return words;
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

function phraseRegex(phrase) {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'giu');
}

function bounded(value, max) {
  const text = String(value);
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function lineAt(model, index) {
  let low = 0;
  let high = model.lines.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (model.lines[mid].start <= index) low = mid;
    else high = mid - 1;
  }
  return { number: low + 1, start: model.lines[low].start };
}

function makeFinding(model, document, sIndex, eIndex, rule, explanation, suggestion, heuristic) {
  const lineInfo = lineAt(model, sIndex);
  return {
    file: document.path,
    source_sha256: document.sha256,
    span: {
      start: model.byteOffsets[sIndex],
      end: model.byteOffsets[eIndex],
      line: lineInfo.number,
      column: sIndex - lineInfo.start + 1,
    },
    rule: { id: rule.id, version: rule.version, origin: rule.origin },
    explanation,
    suggestion: suggestion === null || suggestion === undefined ? null : String(suggestion),
    heuristic: Boolean(heuristic),
  };
}

export function runRules(profile, model, document, glossaryEntries, sections, options = {}) {
  const findings = [];
  const countsOnly = [];
  let truncated = false;
  const cap = options.maxFindings ?? MAX_FINDINGS_PER_DOCUMENT;
  const add = (finding) => {
    if (findings.length >= cap) {
      truncated = true;
      return false;
    }
    findings.push(finding);
    return true;
  };
  const sentenceRule = profile.profile.rules.get('docs-readability:sentence-length');
  if (sentenceRule && document.resolved !== null) {
    for (const sentence of collectSentences(model)) {
      if (findings.length >= cap) { truncated = true; break; }
      const section = sections.find((item) => sentence.s >= item.start && sentence.s < item.end) ?? sections[0];
      const words = countWords(model, sentence);
      const threshold = sentenceRule.thresholds?.[section.sectionClass]?.[document.resolved];
      if (Number.isInteger(threshold) && words > threshold) {
        add(makeFinding(model, document, sentence.s, sentence.e, sentenceRule,
          `Sentence has ${words} words; threshold for ${section.sectionClass} (${document.resolved}) is ${threshold}.`,
          null, false));
      }
    }
  }
  for (const ruleId of ['docs-readability:ru-cliche', 'docs-readability:en-cliche']) {
    if (truncated) break;
    const rule = profile.profile.rules.get(ruleId);
    if (!rule || document.language !== rule.language) continue;
    for (const section of sections) {
      if (truncated) break;
      for (const run of eligibleRuns(model, section.start, section.end)) {
        if (truncated) break;
        const chunk = model.text.slice(run.s, run.e);
        for (const phrase of rule.phrases) {
          const pattern = phraseRegex(phrase);
          let match;
          while ((match = pattern.exec(chunk)) !== null) {
            if (!add(makeFinding(model, document, run.s + match.index, run.s + match.index + match[0].length, rule,
              `Cliche phrase «${bounded(match[0], 40)}» from the pinned ${rule.language} list.`, null, true))) break;
            if (match.index === pattern.lastIndex) pattern.lastIndex += 1;
          }
          if (truncated) break;
        }
      }
    }
  }
  const pairRule = profile.profile.rules.get('docs-readability:unbalanced-pair');
  if (pairRule && !model.partial) {
    for (const section of sections) {
      if (truncated) break;
      const counts = new Map(pairRule.pairs.map(([open, close]) => [`${open}${close}`, { open: 0, close: 0, depth: 0, crossed: false }]));
      // Crossed nesting across different pair kinds (e.g. `([)]`) escapes both
      // total-count balance and per-pair running depth; the outstanding-opener
      // stack flags a closer that has no matching current opener.
      const outstanding = [];
      const crossedWith = new Map();
      for (const run of eligibleRuns(model, section.start, section.end)) {
        for (const ch of model.text.slice(run.s, run.e)) {
          for (const [open, close] of pairRule.pairs) {
            const tally = counts.get(`${open}${close}`);
            if (ch === open) {
              tally.open += 1;
              tally.depth += 1;
              outstanding.push(open);
            } else if (ch === close) {
              tally.close += 1;
              tally.depth -= 1;
              // A closer before its opener escapes total-count balance; a
              // negative running depth flags the reversed order explicitly.
              if (tally.depth < 0) { tally.crossed = true; tally.depth = 0; }
              const top = outstanding[outstanding.length - 1];
              if (top === undefined) continue;
              if (top === open) outstanding.pop();
              else crossedWith.set(`${open}${close}`, top);
            }
          }
        }
      }
      const sectionRuns = eligibleRuns(model, section.start, section.end);
      if (sectionRuns.length === 0) continue;
      const span = { s: sectionRuns[0].s, e: sectionRuns[sectionRuns.length - 1].e };
      for (const [open, close] of pairRule.pairs) {
        const key = `${open}${close}`;
        const tally = counts.get(key);
        const unbalanced = tally.open !== tally.close;
        const blockedBy = crossedWith.get(key);
        if (unbalanced || tally.crossed || blockedBy !== undefined) {
          const reason = unbalanced
            ? `${tally.open} open, ${tally.close} close`
            : tally.crossed
              ? `reversed order: a ${close} appears before its ${open}`
              : `crossed order: a ${close} appears while a ${blockedBy} is still open`;
          add(makeFinding(model, document, span.s, span.e, pairRule,
            `Unbalanced pair ${open}${close} in ${section.heading ? `section «${bounded(section.heading, 40)}»` : 'document'}: ${reason}.`,
            `Check the ${open}${close} pair balance.`, false));
        }
      }
    }
  }
  const quoteRule = profile.profile.rules.get('docs-readability:quote-mismatch');
  if (quoteRule) {
    const disallowed = new Set(quoteRule.disallowed);
    for (const section of sections) {
      if (truncated) break;
      for (const run of eligibleRuns(model, section.start, section.end)) {
        if (truncated) break;
        for (let index = run.s; index < run.e; index += 1) {
          if (disallowed.has(model.text[index])) {
            if (!add(makeFinding(model, document, index, index + 1, quoteRule,
              `Unsupported quotation mark U+${model.text.codePointAt(index).toString(16).toUpperCase().padStart(4, '0')} in prose; use «» or ".`,
              'Replace the unsupported quotation mark with «» or ".', false))) break;
          }
        }
      }
    }
  }
  const glossaryRule = profile.profile.rules.get('docs-readability:glossary-term');
  if (glossaryRule && Array.isArray(glossaryEntries) && glossaryEntries.length > 0) {
    for (const section of sections) {
      if (truncated) break;
      for (const run of eligibleRuns(model, section.start, section.end)) {
        if (truncated) break;
        const chunk = model.text.slice(run.s, run.e);
        for (const entry of glossaryEntries) {
          for (const alias of entry.aliases) {
            const pattern = phraseRegex(alias);
            let match;
            while ((match = pattern.exec(chunk)) !== null) {
              if (!add(makeFinding(model, document, run.s + match.index, run.s + match.index + match[0].length, glossaryRule,
                `Term «${bounded(match[0], 40)}» differs from the glossary preferred form «${bounded(entry.preferred, 40)}».`,
                entry.preferred, true))) break;
              if (match.index === pattern.lastIndex) pattern.lastIndex += 1;
            }
            if (truncated) break;
          }
        }
      }
    }
  }
  return { findings, countsOnly, truncated };
}

// ---------------------------------------------------------------------------
// Glossary (read-only, best-effort; the body is never copied anywhere)
// ---------------------------------------------------------------------------

export async function resolveGlossary(rootDir, config, options = {}) {
  const relative = config.contextPath ?? DEFAULT_CONTEXT_PATH;
  if (typeof relative !== 'string' || !relative || relative.includes('\\') || relative.includes(':')
    || relative.split('/').some((part) => !part || part === '.' || part === '..')) {
    return { path: relative, state: 'unsafe', sha256: null, entries: [], diagnostic: { code: 'glossary-unsafe', path: null, detail: null } };
  }
  let target;
  try {
    target = await safeProviderPath(rootDir, relative);
  } catch {
    return { path: relative, state: 'unsafe', sha256: null, entries: [], diagnostic: { code: 'glossary-unsafe', path: relative, detail: null } };
  }
  if (!target.exists) return { path: relative, state: 'missing', sha256: null, entries: [], diagnostic: null };
  let bytes;
  try {
    bytes = await readProviderFile(rootDir, relative, DOCUMENT_LIMIT);
  } catch (error) {
    return { path: relative, state: 'unreadable', sha256: null, entries: [], diagnostic: { code: 'glossary-unreadable', path: relative, detail: String(error?.message ?? error) } };
  }
  if (bytes === null) return { path: relative, state: 'missing', sha256: null, entries: [], diagnostic: null };
  if (bytes.includes(0)) return { path: relative, state: 'unreadable', sha256: null, entries: [], diagnostic: { code: 'glossary-unreadable', path: relative, detail: 'nul-byte' } };
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return { path: relative, state: 'unreadable', sha256: null, entries: [], diagnostic: { code: 'glossary-unreadable', path: relative, detail: 'utf8-fatal' } };
  }
  if (text.trim().length === 0) return { path: relative, state: 'empty', sha256: digest(bytes), entries: [], diagnostic: null };
  return { path: relative, state: 'present', sha256: digest(bytes), entries: parseGlossaryEntries(text), diagnostic: null };
}

// Best-effort entry recognition: `- **Term** — description`, `- Term: description`,
// `**Term (Alias)**: description`. Unfamiliar Markdown is accepted with zero
// recognized entries (the glossary-term rule then stays inactive).
export function parseGlossaryEntries(text) {
  const model = buildDocumentModel(text);
  const entries = [];
  const seen = new Set();
  const patterns = [
    /^\s{0,3}(?:[-*+]|\d+[.)])[ \t]+\*\*([^*]{1,80})\*\*[ \t]*(?:—|–|-|::|:)[ \t]*(.+)$/,
    /^\s{0,3}(?:[-*+]|\d+[.)])[ \t]+([^*—:]{1,80}?)[ \t]*(?:—|–|::|:)[ \t]*(.+)$/,
    /^\s{0,3}([^*—:#>][^—:]{0,79}?)[ \t]*(?:—|–|::)[ \t]*(.+)$/,
  ];
  for (let index = 0; index < model.lines.length; index += 1) {
    if (model.fenceMask[index]) continue;
    const bare = model.lines[index].bare;
    let captured = null;
    for (const pattern of patterns) {
      const match = pattern.exec(bare);
      if (match) { captured = match[1]; break; }
    }
    if (captured === null) continue;
    const parsed = parseGlossaryTerm(captured);
    if (parsed === null || seen.has(parsed.preferred.toLowerCase())) continue;
    seen.add(parsed.preferred.toLowerCase());
    entries.push(parsed);
  }
  return entries;
}

function parseGlossaryTerm(raw) {
  let term = raw.trim().replace(/^["'«]|["'»]$/g, '').trim();
  const aliases = [];
  const parenthetical = /\(([^)]+)\)\s*$/.exec(term);
  if (parenthetical) {
    for (const alias of parenthetical[1].split(/[,;]/)) {
      const value = alias.trim();
      if (value) aliases.push(value);
    }
    term = term.slice(0, parenthetical.index).trim();
  }
  if (/[.!?,;]/.test(term)) return null;
  term = term.replace(/\*\*/g, '').trim();
  if (!term || !/[\p{L}]/u.test(term) || term.length > 80 || /^https?:/i.test(term)) return null;
  return { preferred: term, aliases: aliases.filter((alias) => alias.toLowerCase() !== term.toLowerCase()) };
}

// ---------------------------------------------------------------------------
// Analysis of one document
// ---------------------------------------------------------------------------

const KNOWN_READ_CODES = Object.freeze(['unsafe_path', 'path_unreadable', 'unsafe_file', 'file_limit', 'file_changed']);

async function readDocument(rootDir, relative, options = {}) {
  const fail = (code, detail, extra = {}) => ({ ok: false, code, detail, ...extra });
  let target;
  try {
    target = await safeProviderPath(rootDir, relative);
    if (!target.exists) return fail('file-missing', relative);
  } catch (error) {
    const code = String(error?.message ?? 'unsafe_path');
    return fail(KNOWN_READ_CODES.includes(code) ? code : 'file-unreadable', relative);
  }
  // Size gate before the bounded read so the spec-named code is exact.
  let info;
  try {
    info = await lstat(target.path);
  } catch (error) {
    return fail('file-unreadable', relative);
  }
  if (!info.isFile()) return fail('unsafe_file', relative);
  if (info.size > DOCUMENT_LIMIT) return fail('file_limit', relative);
  let bytes;
  try {
    bytes = await readProviderFile(rootDir, relative, DOCUMENT_LIMIT);
  } catch (error) {
    const code = String(error?.message ?? 'unsafe_file');
    return fail(KNOWN_READ_CODES.includes(code) ? code : 'file-unreadable', relative);
  }
  if (bytes === null) return fail('file-missing', relative);
  const sha256 = digest(bytes);
  if (bytes.includes(0)) return fail('nul-byte', relative, { sha256 });
  let text;
  try {
    // ignoreBOM:true keeps a leading U+FEFF in the decoded text so that byte
    // offsets stay anchored to the raw file bytes (the BOM is real content).
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return fail('utf8-fatal', relative, { sha256 });
  }
  return { ok: true, relative, sha256, text };
}

function analyzeDocument(profile, glossaryEntries, relative, content, options) {
  const model = buildDocumentModel(content.text);
  model.byteOffsets = buildByteOffsets(content.text);
  const language = resolveDocumentLanguage(model, options.languageOverride);
  const sections = buildSections(model);
  const document = { path: relative, sha256: content.sha256, language: language.language, resolved: language.resolved };
  let eligibleBytes = 0;
  for (const run of eligibleRuns(model, 0, model.text.length)) eligibleBytes += model.byteOffsets[run.e] - model.byteOffsets[run.s];
  const ruleOutcome = profile.ok
    ? runRules(profile, model, document, glossaryEntries, sections)
    : { findings: [], countsOnly: [], truncated: false };
  const diagnostics = [];
  if (model.partial) {
    // Uncovered spans are reported with byte ranges from the raw file bytes.
    const ranges = model.uncovered.length > 0
      ? model.uncovered.map((span) => `bytes=${model.byteOffsets[span.s]}-${model.byteOffsets[span.e]}`).join(', ')
      : 'bytes=unspecified';
    diagnostics.push({ code: 'parser-uncovered-span', path: relative, detail: ranges });
  }
  if (ruleOutcome.truncated) {
    diagnostics.push({ code: 'findings-truncated', path: relative, detail: `limit=${MAX_FINDINGS_PER_DOCUMENT}` });
  }
  if (language.diagnostic) diagnostics.push({ ...language.diagnostic, path: relative });
  if (!profile.ok) diagnostics.push(...profile.diagnostics);
  if (profile.ok && language.resolved === null) {
    diagnostics.push({ code: 'rules-language-unresolved', path: relative, detail: 'language-dependent rules skipped' });
  }
  return {
    path: relative,
    sha256: content.sha256,
    language: language.language,
    languageSource: language.languageSource,
    parsing: model.partial ? 'partial' : 'full',
    eligibleBytes,
    findings: ruleOutcome.findings,
    countsOnly: ruleOutcome.countsOnly,
    truncated: ruleOutcome.truncated,
    diagnostics,
  };
}

// ---------------------------------------------------------------------------
// Report identity, binding and read-time revalidation
// ---------------------------------------------------------------------------

function readableError(code, detail) {
  const error = new Error(String(detail ?? code));
  error.readabilityCode = code;
  return error;
}

async function computeWorktreeIdentity(rootDir, options = {}) {
  const stat = options.lstatEntry ?? lstat;
  const info = await stat(rootDir, { bigint: true });
  if (!info.isDirectory() || info.ino <= 0n) throw readableError('unsupported-file-identity', rootDir);
  return digest({ root: rootDir, device: String(info.dev), inode: String(info.ino) });
}

async function engineModuleSha256(options = {}) {
  const modulePath = fileURLToPath(new URL('./docs-readability.mjs', import.meta.url));
  const reader = options.readEngine ?? ((target) => readFile(target));
  return digest(await reader(modulePath));
}

function bindingCanonicalObject({ worktreeIdentity, changeId, selection, inputDigests, profilePart, engine, glossaryPart, languageOptions }) {
  return {
    worktree_identity: worktreeIdentity,
    change_id: changeId,
    selection: [...selection].sort(),
    input_digests: inputDigests,
    profile: profilePart,
    engine,
    glossary: glossaryPart,
    language_options: languageOptions,
  };
}

async function currentProfilePart(options) {
  const profile = await loadProfile(options);
  if (!profile.ok) {
    return { ok: false, sha256: profile.sha256 ?? null, diagnostics: profile.diagnostics, part: { sha256: profile.sha256 ?? null, id: null, version: null, rules: {} } };
  }
  return {
    ok: true,
    sha256: profile.sha256,
    part: {
      sha256: profile.sha256,
      id: profile.profile.id,
      version: profile.profile.version,
      rules: Object.fromEntries([...profile.profile.rules.entries()].map(([id, rule]) => [id, rule.version])),
    },
  };
}

const MALFORMED_CODES = Object.freeze(['file-missing', 'file_limit', 'file_changed', 'unsafe_file',
  'unsafe_path', 'path_unreadable', 'file-unreadable', 'nul-byte', 'utf8-fatal']);

// Read-time revalidation of a persisted report. Any divergence between the
// recorded composite binding and the current worktree/inputs/profile/engine/
// glossary/language state yields the `stale-report` outcome with named fields.
// Recorded profile/engine/glossary/language_options metadata is cross-checked
// against the current components, so tampering with a single field is named.
export async function validateReportBinding(rootDir, report, options = {}) {
  if (!report || typeof report !== 'object' || report.schema !== READABILITY_SCHEMA
    || typeof report.change_id !== 'string' || typeof report.binding !== 'string') {
    return { ok: false, code: 'report-invalid' };
  }
  const normalized = normalizeChangeId(report.change_id);
  if (!normalized.ok) return { ok: false, code: 'report-invalid' };
  let root;
  try {
    root = await realpath(options.rootDir ?? rootDir);
  } catch {
    return { ok: false, code: 'root-unreadable' };
  }
  let worktreeIdentity;
  try {
    worktreeIdentity = await computeWorktreeIdentity(root, options);
  } catch (error) {
    return { ok: false, code: error?.readabilityCode ?? 'unsupported-file-identity' };
  }
  const mismatched = [];
  if (worktreeIdentity !== report.worktree_identity) mismatched.push('worktree_identity');
  const profilePart = await currentProfilePart(options);
  const engineSha = await engineModuleSha256(options);
  const config = await readReadabilityConfig(root, options);
  const glossary = await resolveGlossary(root, config, options);
  const inputs = Array.isArray(report.inputs) ? report.inputs : [];
  const selection = inputs.map((input) => input.path).sort();
  const inputDigests = {};
  for (const input of inputs) {
    const read = await readDocument(root, input.path, options);
    const currentSha = read.ok ? read.sha256 : (read.sha256 ?? null);
    inputDigests[input.path] = currentSha;
    if (currentSha !== (input.sha256 ?? null)) mismatched.push(`inputs:${input.path}`);
  }
  // The language override is persisted in the report: it cannot be recovered
  // from inputs alone (malformed/skipped inputs never carry language_source).
  const languageOptions = {
    override: typeof report.language_options?.override === 'string' ? report.language_options.override : null,
  };
  const engine = { module: ENGINE_MODULE, sha256: engineSha, parser_version: PARSER_VERSION };
  const glossaryPart = { path: glossary.path ?? null, state: glossary.state, sha256: glossary.sha256 ?? null };
  const recordedProfile = report.profile ?? {};
  if ((recordedProfile.id ?? null) !== (profilePart.part.id ?? null)
    || (recordedProfile.version ?? null) !== (profilePart.part.version ?? null)
    || (recordedProfile.sha256 ?? null) !== (profilePart.part.sha256 ?? null)
    || (recordedProfile.state ?? null) !== (profilePart.ok ? 'loaded' : 'unavailable')) mismatched.push('profile');
  const recordedEngine = report.engine ?? {};
  if ((recordedEngine.module ?? null) !== ENGINE_MODULE
    || (recordedEngine.sha256 ?? null) !== engineSha
    || (recordedEngine.parser_version ?? null) !== PARSER_VERSION) mismatched.push('engine');
  const recordedGlossary = report.glossary ?? {};
  if ((recordedGlossary.path ?? null) !== (glossaryPart.path ?? null)
    || (recordedGlossary.state ?? null) !== glossaryPart.state
    || (recordedGlossary.sha256 ?? null) !== (glossaryPart.sha256 ?? null)) mismatched.push('glossary');
  // language_options has no independent current value to cross-check (the CLI
  // override lives only in the report); tampering with it is caught by the
  // binding digest, which mixes the persisted override in.
  const currentBinding = digest(canonical(bindingCanonicalObject({
    worktreeIdentity,
    changeId: normalized.changeId,
    selection,
    inputDigests,
    profilePart: profilePart.part,
    engine,
    glossaryPart,
    languageOptions,
  })));
  if (currentBinding !== report.binding) mismatched.push('binding');
  return { ok: true, stale: mismatched.length > 0, mismatched: [...new Set(mismatched)], state: mismatched.length > 0 ? STALE_REPORT_STATE : null };
}

// ---------------------------------------------------------------------------
// Report writer (state-only; guards fail closed before the first write)
// ---------------------------------------------------------------------------

function withinCi(prefix, value) {
  return value.toLowerCase().startsWith(prefix.toLowerCase());
}

export async function writeReadabilityReport(rootDir, report, config, options = {}) {
  const normalized = normalizeChangeId(report.change_id);
  if (!normalized.ok) return { ok: false, code: 'invalid-change-id' };
  const stateRoot = normalizeConfigPath(config.stateRoot);
  if (stateRoot !== STATE_ROOT) return { ok: false, code: 'state-root-mismatch', detail: stateRoot };
  const relative = `${STATE_ROOT}/${normalized.changeId}/readability/report.json`;
  if (withinCi(`${config.qaRoot ?? QA_ROOT}/`, relative)) return { ok: false, code: 'qa-namespace-conflict', detail: relative };
  const root = await realpath(options.rootDir ?? rootDir);
  const parts = relative.split('/');
  for (let index = 1; index < parts.length; index += 1) {
    const ancestor = path.join(root, ...parts.slice(0, index));
    let info;
    try { info = await lstat(ancestor); } catch { continue; }
    if (!info.isDirectory()) return { ok: false, code: 'file-shadow', detail: parts.slice(0, index).join('/') };
  }
  const leaf = path.join(root, ...parts);
  const leafConflict = () => ({ ok: false, code: 'report-leaf-conflict', detail: relative });
  // Leaf ownership: only a previous, fully schema-valid report of the same
  // change may be replaced — a matching schema+change_id pair alone is not
  // ownership (review: two-field objects must not pass). A report written by
  // an older extension form without language_options ("fix-base" shape) is
  // accepted through an explicit legacy fill so extension updates can still
  // overwrite their own earlier outputs.
  const assertLeafWritable = async () => {
    let leafInfo = null;
    try { leafInfo = await lstat(leaf); } catch { leafInfo = null; }
    if (leafInfo === null) return null;
    if (!leafInfo.isFile()) return leafConflict();
    const previous = await readProviderFile(root, relative, 4 * 1024 * 1024);
    if (previous === null) return leafConflict();
    let priorReport = null;
    try { priorReport = parseStrictJson(previous.toString('utf8')); } catch { priorReport = null; }
    if (!priorReport || priorReport.schema !== READABILITY_SCHEMA || priorReport.change_id !== report.change_id) {
      return leafConflict();
    }
    const schema = parseStrictJson(await readFile(new URL('../schemas/docs-readability.schema.json', import.meta.url), 'utf8'));
    let priorValid = validateJsonAgainstSchema(priorReport, schema).length === 0;
    if (!priorValid && !('language_options' in priorReport)) {
      priorValid = validateJsonAgainstSchema({ ...priorReport, language_options: { override: null } }, schema).length === 0;
    }
    if (!priorValid) return leafConflict();
    return null;
  };
  const firstRejection = await assertLeafWritable();
  if (firstRejection) return firstRejection;
  const gitGuard = options.verifyReportIgnored ?? verifyReportIgnored;
  const verdict = await gitGuard(root, relative, options);
  if (!verdict.ok) return { ok: false, code: verdict.code, detail: verdict.detail ?? null };
  const directory = path.join(root, ...parts.slice(0, -1));
  await mkdir(directory, { recursive: true });
  // TOCTOU re-check after materialization: the live directory must resolve to
  // the same real path (no symlink/junction swap) and the leaf ownership must
  // still hold right before the atomic rename.
  const liveDirectory = await realpath(directory);
  if (path.resolve(liveDirectory).toLowerCase() !== path.resolve(directory).toLowerCase()) {
    return { ok: false, code: 'file-shadow', detail: parts.slice(0, -1).join('/') };
  }
  const secondRejection = await assertLeafWritable();
  if (secondRejection) return secondRejection;
  const payload = `${JSON.stringify(report, null, 2)}\n`;
  const temporary = path.join(liveDirectory, `${parts[parts.length - 1]}.${randomUUID()}.tmp`);
  await writeFile(temporary, payload, { encoding: 'utf8', mode: 0o600 });
  try {
    // Third ownership check after the temp write, immediately before the
    // atomic rename: the leaf must not have been replaced by foreign content
    // during the write. Inside the finally-guarded block so a failed bounded
    // read cannot leak the temporary file. rename itself is atomic; the
    // residual race is the microseconds between this check and the rename
    // (documented in design.md).
    const thirdRejection = await assertLeafWritable();
    if (thirdRejection) return thirdRejection;
    await rename(temporary, leaf);
  } finally {
    await unlink(temporary).catch((error) => { if (error?.code !== 'ENOENT') throw error; });
  }
  return { ok: true, path: relative };
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

function usageEnvelope(state, codes) {
  return { schema_version: 1, diagnostic_only: true, state, codes, usage, authorizes: [] };
}

function renderHuman(report) {
  if (!report || typeof report !== 'object') return String(report);
  if (report.schema_version === 1) {
    const lines = [`Docs readability (advisory): ${report.state}`];
    for (const code of report.codes ?? []) lines.push(`  diagnostic: ${code}`);
    lines.push(`Usage: ${report.usage ?? usage}`);
    return lines.join('\n');
  }
  if (report.schema !== READABILITY_SCHEMA) return String(report);
  const lines = [
    `Docs readability (advisory, no gate evidence): change ${report.change_id}`,
    `State: ${report.state}; inputs: ${(report.inputs ?? []).length}; findings: ${(report.findings ?? []).length}`,
  ];
  if (report.state !== 'complete') lines.push('Degraded outcome — this is NOT a zero-findings result.');
  for (const finding of report.findings ?? []) {
    lines.push(`  ${finding.file}:${finding.span.line}:${finding.span.column} ${finding.rule.id} — ${finding.explanation}`);
    if (finding.suggestion !== null) lines.push(`    suggestion: ${finding.suggestion}`);
  }
  for (const diagnostic of report.diagnostics ?? []) {
    lines.push(`  diagnostic: ${diagnostic.code}${diagnostic.path ? ` (${diagnostic.path})` : ''}${diagnostic.detail ? ` — ${diagnostic.detail}` : ''}`);
  }
  return lines.join('\n');
}

export async function runDocsReadabilityCommand(argv = process.argv.slice(2), options = {}) {
  const output = options.output ?? ((value) => process.stdout.write(value));
  const emit = (value, json) => output(json ? `${JSON.stringify(value, null, 2)}\n` : `${renderHuman(value)}\n`);
  const now = options.now ?? Date.now;
  const startedAt = now();
  const deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const expired = () => now() - startedAt > deadlineMs;

  const parsed = parseReadabilityArgs(argv);
  if (!parsed.ok) {
    emit(usageEnvelope('invalid-usage', ['invalid-usage', parsed.error]), parsed.json);
    return 2;
  }
  let rootDir;
  try {
    rootDir = await realpath(options.rootDir ?? process.cwd());
  } catch {
    process.stderr.write('docs-readability: project root is unreadable\n');
    return 1;
  }
  const config = await readReadabilityConfig(rootDir, options);
  const cliEnabled = parsed.enabled;
  if (cliEnabled === null && config.enabled !== true) {
    const codes = ['readability-disabled'];
    if (config.enabledMalformed) codes.push('config-malformed');
    emit(usageEnvelope('invalid-usage', codes), parsed.json);
    return 2;
  }
  if (cliEnabled === false) {
    emit(usageEnvelope('invalid-usage', ['readability-disabled']), parsed.json);
    return 2;
  }
  if (typeof parsed.changeId !== 'string') {
    emit(usageEnvelope('invalid-usage', ['missing-change']), parsed.json);
    return 2;
  }
  const normalizedChange = normalizeChangeId(parsed.changeId);
  if (!normalizedChange.ok) {
    emit(usageEnvelope('invalid-usage', ['invalid-change-id']), parsed.json);
    return 2;
  }
  const changeId = normalizedChange.changeId;
  if (parsed.files.length === 0) {
    emit(usageEnvelope('empty-input', ['empty-input']), parsed.json);
    return 2;
  }
  const formViolations = parsed.files.filter((relative) => !validateFileForm(relative));
  if (formViolations.length > 0) {
    emit(usageEnvelope('invalid-usage', formViolations.map((relative) => `unsafe-file:${relative}`)), parsed.json);
    return 2;
  }

  try {
    const profile = await loadProfile(options);
    const glossary = await resolveGlossary(rootDir, config, options);
    const selection = [...new Set(parsed.files)].sort();
    const inputs = [];
    const findings = [];
    const countsOnly = [];
    const diagnostics = [...(config.diagnostics ?? [])];
    let timedOut = false;

    for (const relative of selection) {
      if (expired()) {
        timedOut = true;
        inputs.push({
          path: relative, sha256: null, language: 'unknown', language_source: 'detected',
          parsing: 'partial', eligible_bytes: 0, read_state: 'skipped',
        });
        continue;
      }
      const content = await readDocument(rootDir, relative, options);
      if (!content.ok) {
        diagnostics.push({ code: content.code, path: relative, detail: 'malformed-input' });
        inputs.push({
          path: relative, sha256: content.sha256 ?? null, language: 'unknown', language_source: 'detected',
          parsing: 'partial', eligible_bytes: 0, read_state: 'malformed',
        });
        continue;
      }
      const analysis = analyzeDocument(profile, glossary.entries, relative, content, { languageOverride: parsed.language });
      inputs.push({
        path: analysis.path, sha256: analysis.sha256, language: analysis.language, language_source: analysis.languageSource,
        parsing: analysis.parsing, eligible_bytes: analysis.eligibleBytes, read_state: 'ok',
      });
      // Bounded accumulation without spread: a pathological document can emit
      // tens of thousands of findings and must not grow the array unbounded.
      for (const finding of analysis.findings) {
        if (findings.length >= MAX_FINDINGS) break;
        findings.push(finding);
      }
      for (const entry of analysis.countsOnly) countsOnly.push(entry);
      diagnostics.push(...analysis.diagnostics);
    }
    if (!timedOut && expired()) timedOut = true;
    if (timedOut) diagnostics.push({ code: 'deadline-exceeded', path: null, detail: `deadlineMs=${deadlineMs}` });

    if (findings.length >= MAX_FINDINGS) {
      // The global diagnostic must precede the degradation mapping below, so
      // global truncation (documents each under their own cap, together over
      // the global limit) degrades the outcome exactly like per-document
      // truncation does.
      diagnostics.push({ code: 'findings-truncated', path: null, detail: `limit=${MAX_FINDINGS}` });
    }
    const degraded = new Set();
    for (const diagnostic of diagnostics) {
      if (diagnostic.code === 'wrong-language') degraded.add('wrong-language');
      else if (diagnostic.code === 'ambiguous-language') degraded.add('ambiguous-language');
      else if (diagnostic.code === 'parser-uncovered-span' || diagnostic.code === 'findings-truncated') degraded.add('partial-coverage');
      else if (MALFORMED_CODES.includes(diagnostic.code)) degraded.add('malformed-input');
    }
    if (!profile.ok) degraded.add('checker-unavailable');
    if (timedOut) degraded.add('timeout');
    let state = 'complete';
    for (const candidate of SEVERITY) {
      if (degraded.has(candidate)) { state = candidate; break; }
    }
    if (diagnostics.length > MAX_DIAGNOSTICS) diagnostics.length = MAX_DIAGNOSTICS;
    findings.sort((left, right) => (left.file < right.file ? -1 : left.file > right.file ? 1 : 0)
      || left.span.start - right.span.start
      || (left.rule.id < right.rule.id ? -1 : left.rule.id > right.rule.id ? 1 : 0));

    const worktreeIdentity = await computeWorktreeIdentity(rootDir, options);
    const engineSha = await engineModuleSha256(options);
    // Binding metadata comes from the exact profile snapshot the findings were
    // computed with — a second load here would let a profile change between
    // reads desynchronize findings from the recorded binding.
    const profilePart = profile.ok
      ? {
        sha256: profile.sha256,
        id: profile.profile.id,
        version: profile.profile.version,
        rules: Object.fromEntries([...profile.profile.rules.entries()].map(([id, rule]) => [id, rule.version])),
      }
      : { sha256: profile.sha256 ?? null, id: null, version: null, rules: {} };
    const binding = digest(canonical(bindingCanonicalObject({
      worktreeIdentity,
      changeId,
      selection,
      inputDigests: Object.fromEntries(inputs.map((input) => [input.path, input.sha256])),
      profilePart,
      engine: { module: ENGINE_MODULE, sha256: engineSha, parser_version: PARSER_VERSION },
      glossaryPart: { path: glossary.path ?? null, state: glossary.state, sha256: glossary.sha256 ?? null },
      languageOptions: { override: parsed.language },
    })));
    const report = {
      schema: READABILITY_SCHEMA,
      change_id: changeId,
      generated_at: new Date(startedAt).toISOString(),
      diagnostic_only: true,
      authorizes: [],
      profile: {
        id: profilePart.id,
        version: profilePart.version,
        sha256: profilePart.sha256,
        state: profile.ok ? 'loaded' : 'unavailable',
      },
      inputs,
      glossary: { path: glossary.path ?? null, state: glossary.state, sha256: glossary.sha256 ?? null },
      language_options: { override: parsed.language },
      findings,
      counts_only: countsOnly,
      diagnostics,
      state,
      worktree_identity: worktreeIdentity,
      binding,
      engine: { module: ENGINE_MODULE, sha256: engineSha, parser_version: PARSER_VERSION },
    };
    const schemaBytes = await readFile(new URL('../schemas/docs-readability.schema.json', import.meta.url));
    const schema = parseStrictJson(schemaBytes.toString('utf8'));
    const schemaErrors = validateJsonAgainstSchema(report, schema);
    if (schemaErrors.length > 0) {
      emit({ schema_version: 1, diagnostic_only: true, state: 'operational-failure', codes: ['schema-parity-failure', ...schemaErrors.slice(0, 5).map((error) => error.message)], usage, authorizes: [] }, parsed.json);
      return 1;
    }
    if (parsed.write) {
      const written = await writeReadabilityReport(rootDir, report, config, options);
      if (!written.ok) {
        emit({ ...usageEnvelope('report-not-saved', [written.code]), change_id: changeId }, parsed.json);
        return 1;
      }
    }
    emit(report, parsed.json);
    return 0;
  } catch (error) {
    const code = error?.readabilityCode ?? 'operational-failure';
    emit({ schema_version: 1, diagnostic_only: true, state: 'operational-failure', codes: [code, String(error?.message ?? error)], usage, authorizes: [] }, parsed.json);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runDocsReadabilityCommand();
}
