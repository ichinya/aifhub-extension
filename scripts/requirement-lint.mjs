// Opt-in, advisory semantic lint for ambiguous requirements presented to
// /aif-plan and /aif-improve (issue #281). The lint never creates an
// `aif-gate-result`, never writes QA evidence, never edits canonical or spec
// artifacts, never sends questions, and grants no workflow authority. Exactly
// four closed finding types; every finding carries an exact source ref
// (a presented catalog ID or a deterministic UTF-8 byte span over the raw
// document revision) plus a clarifying question — never an answer, a numeric
// SLA, or a ready/verified verdict. Untrusted requirement text is data, never
// commands: the offline rules path imports no process/network API, opens no
// URLs, and invents no identifiers. The live model provider is a separate
// opt-in step outside this first implementation (design R17).
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, realpath, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { digest, portablePath } from './workflow-state-store.mjs';
import { parseStrictJson } from './json-strict.mjs';
import { validateJsonAgainstSchema } from './json-schema-subset.mjs';
import { readProviderFile, safeProviderPath } from './provider-files.mjs';
import { normalizeChangeId } from './active-change-resolver.mjs';
import { ensureRuntimeGitignore } from './runtime-gitignore.mjs';
import { verifyObservationIgnored } from './requirement-lint-git-guard.mjs';
import {
  buildAssessmentBinding,
  notRunAssessment,
  runTypedAssessment,
} from './typed-assessment.mjs';

export const REQUIREMENT_LINT_SCHEMA = 'aifhub.requirement_lint_observation.v1';
export const REQUIREMENT_LINT_PROFILE_SCHEMA = 'aifhub.requirement_lint_profile.v1';
export const REQUIREMENT_LINT_CONSUMER_ID = 'requirements_semantic_lint';
export const FINDING_TYPES = Object.freeze([
  'undefined_observable_outcome',
  'missing_error_case',
  'owner_decision_assumed',
  'suspected_requirement_revision_conflict',
]);
export const STATE_ROOT = '.ai-factory/state';
export const QA_ROOT = '.ai-factory/qa';
export const LINT_NAMESPACE = 'requirement-lint';
export const ENGINE_MODULE = 'scripts/requirement-lint.mjs';
export const HELPER_MODULE = 'scripts/typed-assessment.mjs';
export const PROFILE_MODULE = 'scripts/requirement-lint.profile.json';
export const CONTRACT_MODULE = 'schemas/requirement-lint-observation.schema.json';
export const PARSER_VERSION = 1;
export const DEDUP_POLICY_REVISION = 1;
export const DOCUMENT_LIMIT = 1024 * 1024;
export const MAX_INPUTS = 50;
export const MAX_FINDINGS = 500;
export const MAX_FINDINGS_PER_DOCUMENT = 200;
export const MAX_DIAGNOSTICS = 200;
export const DEFAULT_DEADLINE_MS = 30000;
export const NOT_RUN_MESSAGE = 'advisory scan was not performed';
export const usage = 'ai-factory aifhub-requirement-lint --change <id> [--enabled true|false] --file <path> [--file <path> ...] [--language ru|en] [--json] [--write]';

export function requirementLintPaths(changeId) {
  const normalized = normalizeChangeId(changeId);
  if (!normalized.ok) throw new Error('invalid-change-id');
  return {
    directory: `${STATE_ROOT}/${normalized.changeId}/${LINT_NAMESPACE}`,
    observation: `${STATE_ROOT}/${normalized.changeId}/${LINT_NAMESPACE}/observation.json`,
  };
}

// ---------------------------------------------------------------------------
// Argument parsing (explicit-only; unknown/duplicate/missing -> invalid usage)
// ---------------------------------------------------------------------------

export function parseRequirementLintArgs(argv) {
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
// Bounded closed config read for the `aifhub.requirementLint` opt-in namespace.
// The parser mirrors parseConfigSubset (docs-readability) but adds explicit
// detections the plain subset parser silently mis-reads: duplicate keys,
// `<<` merge keys, `&` anchors, `*` aliases, flow mappings, and quoted
// booleans inside the lint subtree. Every detection is a bounded
// `requirement-lint:<code>` diagnostic that leaves the lint disabled — a
// malformed lint namespace degrades to "advisory scan was not performed", it
// never becomes a required-gate failure, and pre-existing hub-level parser
// failures elsewhere are neither softened nor extended here.
// ---------------------------------------------------------------------------

const LINT_CONFIG_PATH = Object.freeze(['aifhub', 'requirementLint']);
const LINT_CONFIG_CLOSED_KEYS = Object.freeze(new Set(['enabled']));
// Structural ancestors whose duplication or scalarization must be diagnosed:
// a second `aifhub:`/`requirementLint:` block must not silently win, and a
// flow-scalarized `paths:` must not hide `paths.state` from the writer guard.
const LINT_STRUCTURAL_PATHS = Object.freeze([
  ['aifhub'],
  LINT_CONFIG_PATH,
  ['paths'],
]);

function lintConfigDiagnostic(code, detail) {
  return { code: `requirement-lint:${code}`, path: '.ai-factory/config.yaml', detail: detail === undefined ? null : String(detail).slice(0, 200) };
}

// Strip a trailing comment only outside quotes: `enabled: "true # x"` must
// stay a quoted string (quoted-boolean family), never become an unquoted
// boolean opt-in.
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

export function parseRequirementLintConfigSubset(raw) {
  const diagnostics = [];
  const root = Object.create(null);
  const stack = [{ indent: -1, value: root, path: [] }];
  const belowLint = (path) => path.length > LINT_CONFIG_PATH.length
    && LINT_CONFIG_PATH.every((part, index) => path[index] === part);
  const structural = (path) => LINT_STRUCTURAL_PATHS.some((candidate) => candidate.length === path.length
    && candidate.every((part, index) => path[index] === part));
  const scalar = (rawValue) => {
    if (/^(['"]).*\1$/.test(rawValue)) return { text: rawValue.slice(1, -1), quoted: true };
    // An unterminated quote must never be quote-stripped into a boolean: the
    // paired-quote form is the only string form, everything else is a
    // malformed scalar the guarded readers diagnose.
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
    const inside = belowLint(ownPath);
    const guarded = inside || structural(ownPath);
    if (guarded && key === '<<') {
      diagnostics.push(lintConfigDiagnostic('merge-key', key));
      continue;
    }
    if (guarded && rawValue.startsWith('&')) {
      diagnostics.push(lintConfigDiagnostic('anchor', key));
      continue;
    }
    if (guarded && rawValue.startsWith('*')) {
      diagnostics.push(lintConfigDiagnostic('alias', key));
      continue;
    }
    if (guarded && /^[{[]/.test(rawValue)) {
      diagnostics.push(lintConfigDiagnostic('flow-mapping', key));
      continue;
    }
    // Mappings are prototype-less: a `__proto__` key must not pollute the
    // parse result, and readers use own-property lookups.
    if (guarded && Object.hasOwn(parent.value, key)) {
      diagnostics.push(lintConfigDiagnostic('duplicate-key', `${ownPath.join('.')}`));
      continue;
    }
    if (inside && !LINT_CONFIG_CLOSED_KEYS.has(key)) {
      diagnostics.push(lintConfigDiagnostic('unknown-key', key));
      continue;
    }
    if (rawValue.length === 0) {
      parent.value[key] = Object.create(null);
      stack.push({ indent, value: parent.value[key], path: ownPath });
      continue;
    }
    const parsed = scalar(rawValue);
    if (guarded && parsed.unterminated) {
      diagnostics.push(lintConfigDiagnostic('unterminated-quote', key));
      continue;
    }
    if (inside && key === 'enabled' && parsed.quoted && /^(true|false)$/i.test(parsed.text)) {
      diagnostics.push(lintConfigDiagnostic('quoted-boolean', rawValue));
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

export async function readRequirementLintConfig(rootDir, options = {}) {
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
    return config;
  }
  if (bytes === null) return config;
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    diagnostics.push({ code: 'config-malformed', path: '.ai-factory/config.yaml', detail: 'utf8-fatal' });
    return config;
  }
  const parsed = parseRequirementLintConfigSubset(text);
  diagnostics.push(...parsed.diagnostics);
  const hub = parsed.value?.aifhub;
  const paths = parsed.value?.paths;
  // A flow-scalarized structural section (`paths: {state: .state}`) must not
  // hide `paths.state` from the writer guard: the lint degrades to not-run
  // with a diagnostic instead of silently using the default root.
  let structuralDamage = false;
  for (const [name, section] of [['aifhub', hub], ['paths', paths]]) {
    if (section !== undefined && section !== null && (typeof section !== 'object' || Array.isArray(section))) {
      diagnostics.push(lintConfigDiagnostic('scalarized-section', name));
      structuralDamage = true;
    }
  }
  const lintSection = hub && typeof hub === 'object' ? hub.requirementLint : undefined;
  if (lintSection !== undefined && (lintSection === null || typeof lintSection !== 'object' || Array.isArray(lintSection))) {
    diagnostics.push(lintConfigDiagnostic('scalarized-section', 'aifhub.requirementLint'));
  }
  const enabled = lintSection && typeof lintSection === 'object' ? lintSection.enabled : undefined;
  if (enabled !== undefined) {
    if (typeof enabled === 'boolean') config.enabled = enabled;
    else {
      config.enabledMalformed = true;
      diagnostics.push(lintConfigDiagnostic('not-a-boolean', JSON.stringify(enabled)));
    }
  }
  // Every lint-relevant anomaly disables the opt-in: parser diagnostics and
  // structural damage alike — a scalarized `paths` must never leave the lint
  // running against the silently-defaulted state root.
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
// Profile (pinned, offline, resolved next to this module)
// ---------------------------------------------------------------------------

export async function loadRequirementLintProfile(options = {}) {
  const profileUrl = new URL('./requirement-lint.profile.json', import.meta.url);
  const reader = options.readProfile ?? ((url) => readFile(url));
  let bytes;
  try {
    bytes = await reader(profileUrl);
  } catch {
    return {
      ok: false, sha256: null, profile: null, rules: new Map(), exclusionPolicy: null,
      diagnostics: [{ code: 'profile-unavailable', path: PROFILE_MODULE, detail: 'profile-missing' }],
    };
  }
  const sha256 = digest(bytes);
  let parsed;
  try { parsed = parseStrictJson(bytes.toString('utf8')); } catch {
    return {
      ok: false, sha256, profile: null, rules: new Map(), exclusionPolicy: null,
      diagnostics: [{ code: 'profile-unavailable', path: PROFILE_MODULE, detail: 'profile-malformed' }],
    };
  }
  // Root-shape check first: `null` or scalar JSON must degrade to the honest
  // profile-unavailable outcome, never reach property access that would turn
  // a damaged profile into an operational crash (exit 1).
  const shapeOk = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed);
  // The pinned profile must cover the full closed finding-type set exactly
  // once: an empty, duplicated, or partial rule set would let the assessor
  // silently fall back to built-in rules while recording a "loaded" profile.
  const rulesValid = shapeOk && Array.isArray(parsed.rules) && parsed.rules.length === FINDING_TYPES.length
    && parsed.rules.every((rule) => typeof rule?.id === 'string' && Number.isInteger(rule?.version)
      && ['project', 'upstream'].includes(rule?.origin) && FINDING_TYPES.includes(rule?.type))
    && new Set(parsed.rules.map((rule) => rule.id)).size === parsed.rules.length
    && new Set(parsed.rules.map((rule) => rule.type)).size === FINDING_TYPES.length;
  if (!shapeOk || parsed?.schema !== REQUIREMENT_LINT_PROFILE_SCHEMA || typeof parsed.profile_id !== 'string'
    || !Number.isInteger(parsed.profile_version) || !rulesValid) {
    return {
      ok: false, sha256, profile: null, rules: new Map(), exclusionPolicy: null,
      diagnostics: [{ code: 'profile-unavailable', path: PROFILE_MODULE, detail: 'profile-invalid' }],
    };
  }
  const rules = new Map(parsed.rules.map((rule) => [rule.id, rule]));
  const exclusion = parsed.exclusion_policy && typeof parsed.exclusion_policy === 'object'
    ? { id: String(parsed.exclusion_policy.id ?? 'unknown'), version: Number(parsed.exclusion_policy.version ?? 0) }
    : { id: 'unknown', version: 0 };
  return {
    ok: true, sha256, profile: parsed, rules, exclusionPolicy: exclusion,
    diagnostics: [],
  };
}

// ---------------------------------------------------------------------------
// Bounded requirement source reading with deterministic UTF-8 byte spans
// ---------------------------------------------------------------------------

export async function readRequirementDocument(rootDir, relative, options = {}) {
  const reader = options.readInput ?? readProviderFile;
  let bytes = null;
  try {
    bytes = await reader(rootDir, relative, DOCUMENT_LIMIT);
  } catch (error) {
    return { ok: false, kind: 'malformed', code: String(error?.message ?? error).slice(0, 80), bytes: null, sha256: null, text: '', lines: [] };
  }
  if (bytes === null) return { ok: false, kind: 'missing', code: 'file-missing', bytes: null, sha256: null, text: '', lines: [] };
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, kind: 'malformed', code: 'utf8-fatal', bytes, sha256: digest(bytes), text: '', lines: [] };
  }
  const lines = [];
  let start = 0;
  for (let index = 0; index <= bytes.length; index += 1) {
    if (index === bytes.length || bytes[index] === 0x0A) {
      let end = index;
      if (end > start && bytes[end - 1] === 0x0D) end -= 1;
      if (end > start) lines.push({ start, end, text: bytes.subarray(start, end).toString('utf8') });
      start = index + 1;
    }
  }
  return { ok: true, kind: 'file', code: null, bytes, sha256: digest(bytes), text, lines };
}

function quoteOf(text, limit = 120) {
  const collapsed = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (collapsed.length <= limit) return collapsed;
  return `${collapsed.slice(0, limit - 1)}…`;
}

// ---------------------------------------------------------------------------
// Offline deterministic rule assessor (fake/rules first; live provider is a
// separate opt-in step). Markers are advisory heuristics pinned by the profile;
// RU stems use a letter lookbehind because \b is ASCII-only in JS regex.
// ---------------------------------------------------------------------------

const REQUIREMENT_MARKER_RE = /(?:^|[\s(«"'])(?:MUST|SHALL|SHOULD|must|shall|should|обязан|обязана|обязано|обязаны|должен|должна|должно|должны|необходимо|требуется|следует)(?=$|[\s:;,.)"'»])/i;
const EN_OBSERVABLE_RE = /\b(?:when|then|until|once|visible|display|displays|displayed|shown|show|appears|appear|return|returns|returned|complete|completes|completed|succeeds|succeeded|fail|fails|failed|error|errors|message|messages|status|log|logged|logs|exit|result|results|output|response|screen|report|reporting|event|events|acknowledged|signal|signals|criterion|criteria|use|uses|using|used|queue|cron|cache|postgres|mysql|sqlite|http|grpc|rest|websocket|format|protocol|library|framework|database|storage|driver|engine|runtime|tool|command|flag|option|parameter)\b/i;
const RU_OBSERVABLE_RE = /(?<![A-Za-zА-Яа-яЁё])(?:когда|тогда|пока|появ|отображ|показ|возврат|верн|возвращ|заверш|успешн|ошибк|сбой|сообщен|статус|лог|журнал|выхо|результа|ответ|экран|отч[её]т|файл|событи|видн|видим|признак|критери|использ|очеред|кэш|кеш|формат|протокол|библиотек|баз[уеы]\s+данных|хранилищ|драйвер|движок|инструмен|команд|опци|параметр|флаг)/i;
const EN_SUCCESS_ACTION_RE = /\b(?:create|creates|created|write|writes|wrote|send|sends|sent|save|saves|saved|store|stores|stored|delete|deletes|deleted|remove|removes|removed|install|installs|installed|upload|uploads|download|downloads|parse|parses|fetch|fetches|import|imports|export|exports|migrate|migrates|deploy|deploys|publish|publishes|sync|syncs|generate|generates|copy|copies|move|moves|commit|commits)\b/i;
const RU_SUCCESS_ACTION_RE = /(?<![A-Za-zА-Яа-яЁё])(?:созда|запис|отправ|сохран|загруж|скачив|установ|удал|парс|разбор|разбира|получ|мигр|перенос|публик|синхрон|генери|копир|перемещ|коммит)/i;
const EN_ERROR_AWARE_RE = /\b(?:error|errors|failure|failures|fails?|failed|failing|invalid|unavailable|timeout|retry|retries|fallback|reject|aborts?|exception|malformed|corrupt)\b/i;
const RU_ERROR_AWARE_RE = /(?<![A-Za-zА-Яа-яЁё])(?:ошибк|сбой|некорректн|недоступн|таймаут|повтор|отказ|прерыва|исключен|неверн|поврежд|несуществ|отсутству)/i;
const EN_STRONG_ASSUMPTION_RE = /\b(?:obviously|naturally|of course|as usual|presumably|we assume|assuming that|assume that|assumed that|takes for granted|self-evident|it is clear that)\b/i;
const RU_STRONG_ASSUMPTION_RE = /(?<![A-Za-zА-Яа-яЁё])(?:очевидно|естественно|разумеется|само\s+собой|как\s+обычно|предположим|будем\s+считать|принято\s+считать|заранее\s+известно|понятно,\s*что)/i;
const OWNER_ATTRIBUTION_RE = /\b(?:owner|user|customer|stakeholder)\s+(?:approved|decided|decides|confirmed|chose|selected|requested)\b|\bdecided by\b|\bapproved by\b|\bper (?:user|owner) decision\b|\bper discussion\b|\bper (?:prior|earlier) agreement\b|\bas agreed\b|\bexplicitly decided\b|по\s+решению|согласовано|утвержд|владелец\s+подтвер|пользователь\s+подтвер|решение\s+(?:владельца|пользователя)|подтверждено\s+владельцем|выбрано\s+владельцем|как\s+договорились/i;
const EN_REVISION_MARKER_RE = /\b(?:instead of|replaces?|replaced by|supersedes?|superseded|no longer|previously (?:stated|said|required|specified|declared)|changed to)\b/gi;
const RU_REVISION_MARKER_RE = /(?<![A-Za-zА-Яа-яЁё])(?:вместо|замен[яеё]т|заменён|заменен|заменить|заменяем|более\s+не|больше\s+не|ранее\s+(?:было|был|была|говорил|указыв|требов|писал)|пересмотрен|пересматривается|изменено\s+на)/gi;
const RESOLUTION_RE = /\b(?:declared precedence|owner (?:approved|decided|resolved|confirmed)|user (?:approved|confirmed|resolved)|by (?:user|owner) decision|supersedes? #\d+|superseded by #\d+|replaces #\d+)\b|по\s+решению|согласовано|утвержд|приоритет\s+объявлен|владелец\s+подтвер|пользователь\s+подтвер|заменяет\s+#\d+/i;

const PROSE = Object.freeze({
  undefined_observable_outcome: Object.freeze({
    en: Object.freeze({
      rationale: 'Obligation without an observable completion criterion.',
      question: (quote) => `What observable signal (state, output, or user-visible behavior) marks this requirement satisfied: "${quote}"?`,
    }),
    ru: Object.freeze({
      rationale: 'Обязанность без наблюдаемого критерия завершения.',
      question: (quote) => `Какой наблюдаемый сигнал (состояние, вывод или видимое пользователю поведение) означает выполнение требования: «${quote}»?`,
    }),
  }),
  missing_error_case: Object.freeze({
    en: Object.freeze({
      rationale: 'Success-path obligation mentions no error or failure handling.',
      question: (quote) => `What should happen when this action fails or its input is invalid: "${quote}"?`,
    }),
    ru: Object.freeze({
      rationale: 'Обязанность успешного сценария не упоминает обработку ошибок или сбоев.',
      question: (quote) => `Что должно происходить при сбое этого действия или некорректном входе: «${quote}»?`,
    }),
  }),
  owner_decision_assumed: Object.freeze({
    en: Object.freeze({
      rationale: 'Requirement assumes a decision without explicit owner attribution.',
      question: (quote) => `Which owner decided this, and was the choice explicitly confirmed: "${quote}"?`,
    }),
    ru: Object.freeze({
      rationale: 'Требование принимает решение без явного подтверждения владельцем.',
      question: (quote) => `Кто владелец этого решения и подтверждён ли выбор явно: «${quote}»?`,
    }),
  }),
  suspected_requirement_revision_conflict: Object.freeze({
    en: Object.freeze({
      rationale: 'One requirement carries two revision markers with no declared precedence or owner approval.',
      question: (quote) => `Which revision of this requirement is current, and who confirmed the precedence: "${quote}"?`,
    }),
    ru: Object.freeze({
      rationale: 'Одно требование содержит два признака ревизии без объявленного приоритета или подтверждения владельца.',
      question: (quote) => `Какая ревизия требования действует и кто подтвердил приоритет: «${quote}»?`,
    }),
  }),
});

export function resolveProseLanguage(documents, override) {
  if (override === 'ru' || override === 'en') return { language: override, source: 'override' };
  let cyrillic = 0;
  let latin = 0;
  for (const document of documents) {
    for (const character of document.text) {
      const code = character.codePointAt(0);
      if (code >= 0x0400 && code <= 0x04FF) cyrillic += 1;
      else if ((code >= 0x41 && code <= 0x5A) || (code >= 0x61 && code <= 0x7A)) latin += 1;
    }
  }
  return { language: cyrillic > latin ? 'ru' : 'en', source: 'detected' };
}

function spanRef(document, start, end) {
  const boundedEnd = Math.min(Math.max(end, start), document.bytes.length);
  return {
    kind: 'span',
    path: document.path,
    span: { start, end: boundedEnd },
    document_sha256: `sha256:${document.sha256}`,
    span_sha256: `sha256:${digest(document.bytes.subarray(start, boundedEnd))}`,
  };
}

function byteOffsetOfLine(lineText, characterIndex) {
  return Buffer.byteLength(lineText.slice(0, characterIndex), 'utf8');
}

export function buildFinding(type, rule, refs, language, quote) {
  const prose = PROSE[type][language] ?? PROSE[type].en;
  return {
    finding_type: type,
    rule: { id: rule.id, version: rule.version, origin: rule.origin },
    refs,
    ref_relation: type === 'suspected_requirement_revision_conflict' ? 'conflicting_revision_pair' : 'describes',
    rationale: prose.rationale,
    proposed_question: prose.question(quote),
  };
}

function collectMatches(lineText, patterns) {
  const matches = [];
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    let match = pattern.exec(lineText);
    while (match !== null) {
      matches.push({ index: match.index, text: match[0] });
      if (match.index === pattern.lastIndex) pattern.lastIndex += 1;
      match = pattern.exec(lineText);
    }
  }
  return matches.sort((left, right) => left.index - right.index);
}

export function createRulesAssessor(profileRules) {
  const ruleFor = (type) => {
    const rule = [...(profileRules?.values?.() ?? [])].find((entry) => entry.type === type);
    return rule ?? { id: `requirement-lint:${type}`, version: 1, origin: 'project' };
  };
  return async (input, context) => {
    const documents = Array.isArray(input?.documents) ? input.documents : [];
    const language = input?.language === 'ru' ? 'ru' : 'en';
    const findings = [];
    const diagnostics = [];
    let truncated = false;
    for (const document of documents) {
      if (context.expired()) return { ok: false, code: 'deadline-exceeded' };
      // Fences are tracked by character and run length: `````` inside a ``` fence
      // stays excluded, and ~~~ fences close only on a matching run.
      let fence = null;
      let perDocument = 0;
      // Budget is enforced per finding, not per line: a single line can carry
      // several findings, and the cap must stop at the exact overshoot with an
      // honest truncation marker and degraded coverage.
      const room = () => findings.length < MAX_FINDINGS && perDocument < MAX_FINDINGS_PER_DOCUMENT;
      const outOfBudget = () => {
        truncated = true;
        if (diagnostics.length < MAX_DIAGNOSTICS) {
          diagnostics.push({
            code: 'findings-truncated',
            path: document.path,
            detail: `per-document=${MAX_FINDINGS_PER_DOCUMENT}, global=${MAX_FINDINGS}`,
          });
        }
      };
      documentLoop: for (const line of document.lines) {
        const trimmed = line.text.trim();
        const fenceMatch = /^(`{3,}|~{3,})(.*)$/.exec(trimmed);
        if (fenceMatch) {
          if (fence === null) fence = { character: fenceMatch[1][0], length: fenceMatch[1].length };
          else if (fenceMatch[1][0] === fence.character && fenceMatch[1].length >= fence.length
            && fenceMatch[2].trim().length === 0) fence = null;
          continue;
        }
        if (fence !== null || trimmed.length === 0) continue;
        if (!room()) {
          outOfBudget();
          break;
        }
        const hasMarker = REQUIREMENT_MARKER_RE.test(line.text);
        const quote = quoteOf(line.text);
        if (hasMarker && !EN_OBSERVABLE_RE.test(line.text) && !RU_OBSERVABLE_RE.test(line.text)) {
          if (!room()) { outOfBudget(); break documentLoop; }
          findings.push(buildFinding('undefined_observable_outcome', ruleFor('undefined_observable_outcome'),
            [spanRef(document, line.start, line.end)], language, quote));
          perDocument += 1;
        }
        if (hasMarker && (EN_SUCCESS_ACTION_RE.test(line.text) || RU_SUCCESS_ACTION_RE.test(line.text))
          && !EN_ERROR_AWARE_RE.test(line.text) && !RU_ERROR_AWARE_RE.test(line.text)) {
          if (!room()) { outOfBudget(); break documentLoop; }
          findings.push(buildFinding('missing_error_case', ruleFor('missing_error_case'),
            [spanRef(document, line.start, line.end)], language, quote));
          perDocument += 1;
        }
        // Strong assumption markers do not require a requirement marker: an
        // unattributed "obviously"/«будем считать» is an owner decision taken
        // silently regardless of sentence form.
        if ((EN_STRONG_ASSUMPTION_RE.test(line.text) || RU_STRONG_ASSUMPTION_RE.test(line.text))
          && !OWNER_ATTRIBUTION_RE.test(line.text)) {
          if (!room()) { outOfBudget(); break documentLoop; }
          findings.push(buildFinding('owner_decision_assumed', ruleFor('owner_decision_assumed'),
            [spanRef(document, line.start, line.end)], language, quote));
          perDocument += 1;
        }
        const markers = hasMarker ? collectMatches(line.text, [EN_REVISION_MARKER_RE, RU_REVISION_MARKER_RE]) : [];
        if (markers.length >= 2 && !RESOLUTION_RE.test(line.text)) {
          // Refs bind the two revision markers of the same presented
          // requirement — the deterministic anchor points of each side in this
          // line-based heuristic (recorded in the profile notes and design).
          if (!room()) { outOfBudget(); break documentLoop; }
          const refs = markers.slice(0, 2).map((marker) => {
            const start = line.start + byteOffsetOfLine(line.text, marker.index);
            return spanRef(document, start, start + Buffer.byteLength(marker.text, 'utf8'));
          });
          findings.push(buildFinding('suspected_requirement_revision_conflict', ruleFor('suspected_requirement_revision_conflict'),
            refs, language, quote));
          perDocument += 1;
        }
      }
    }
    return { findings, diagnostics, truncated };
  };
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

export function bindingCanonicalObject({
  worktreeIdentity, changeId, methodology, inputDigests, profilePart, engine, helper, contract, languageOptions, exclusionPolicy,
}) {
  return {
    consumer: REQUIREMENT_LINT_CONSUMER_ID,
    worktree_identity: worktreeIdentity,
    change_id: changeId,
    methodology,
    input_digests: inputDigests,
    profile: profilePart,
    engine,
    helper,
    contract,
    language_options: languageOptions,
    exclusion_policy: exclusionPolicy,
  };
}

// Digest records derived from the exact bytes the assessor is about to see —
// never from a second read: a source swapped between reads must not get
// findings from A under a binding over B.
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

export async function currentRequirementLintContext(rootDir, inputs, options = {}) {
  const profile = await loadRequirementLintProfile(options);
  const contractSha = await moduleSha256(new URL(`../${CONTRACT_MODULE}`, import.meta.url), options);
  const engineSha = await moduleSha256(new URL(`../${ENGINE_MODULE}`, import.meta.url), options);
  const helperSha = await moduleSha256(new URL(`../${HELPER_MODULE}`, import.meta.url), options);
  const profilePart = profile.ok
    ? { sha256: profile.sha256, id: profile.profile.profile_id, version: profile.profile.profile_version, rules: Object.fromEntries([...profile.rules.entries()].map(([id, rule]) => [id, rule.version])) }
    : { sha256: profile.sha256 ?? null, id: null, version: null, rules: {} };
  return {
    profile,
    inputDigests: inputDigestRecords(inputs),
    profilePart,
    engine: { module: ENGINE_MODULE, sha256: engineSha, parser_version: PARSER_VERSION },
    helper: { module: HELPER_MODULE, sha256: helperSha },
    contract: { name: REQUIREMENT_LINT_SCHEMA, sha256: contractSha },
  };
}

function findingDedupKey(finding) {
  return digest({
    finding_type: finding.finding_type,
    refs: finding.refs,
  });
}

function sortFindings(findings) {
  return [...findings].sort((left, right) => {
    const leftRef = left.refs[0] ?? {};
    const rightRef = right.refs[0] ?? {};
    return (leftRef.path ?? '').localeCompare(rightRef.path ?? '')
      || (leftRef.span?.start ?? 0) - (rightRef.span?.start ?? 0)
      || left.finding_type.localeCompare(right.finding_type)
      || left.dedup_key.localeCompare(right.dedup_key);
  });
}

export function assembleObservation({ changeId, generatedAt, outcome, inputs, context, language, languageSource, worktreeIdentity, binding, diagnostics }) {
  const findings = outcome.run_status === 'complete' && !outcome.abstained
    ? sortFindings(Object.values(Object.fromEntries(outcome.findings.map((finding) => [findingDedupKey(finding), { ...finding, dedup_key: findingDedupKey(finding) }]))))
    : [];
  const byType = Object.fromEntries(FINDING_TYPES.map((type) => [type, 0]));
  for (const finding of findings) byType[finding.finding_type] = (byType[finding.finding_type] ?? 0) + 1;
  const scanned = inputs.filter((input) => input.kind === 'file').length;
  const missingSources = inputs.filter((input) => input.kind !== 'file')
    .map((input) => ({ path: input.path, reason: input.kind === 'missing' ? 'file-missing' : String(input.code ?? 'malformed') }));
  // Truncated scans never claim full coverage: an unprocessed tail is a
  // partial outcome even when every file was readable — either the assessor
  // or the helper reported the truncation (helper coverage degrades even if
  // the diagnostics budget trimmed its marker).
  const wasTruncated = diagnostics.some((entry) => entry.code === 'findings-truncated')
    || (outcome.run_status === 'complete' && !outcome.abstained && outcome.coverage?.state === 'partial');
  const coverageState = scanned === 0 ? 'none' : (scanned === inputs.length && !wasTruncated ? 'full' : 'partial');
  const coverage = outcome.run_status === 'complete' && outcome.abstained
    ? { ...outcome.coverage, declared_sources: inputs.length, scanned_sources: scanned }
    : { state: coverageState, declared_sources: inputs.length, scanned_sources: scanned, missing_sources: missingSources };
  const outcomeReason = outcome.run_status === 'complete'
    ? (outcome.abstained ? 'assessor-abstain' : null)
    : String(outcome.diagnostics.find((entry) => entry.code !== 'assessment-stale')?.code ?? outcome.diagnostics[0]?.code ?? 'unspecified').slice(0, 200);
  return {
    schema: REQUIREMENT_LINT_SCHEMA,
    change_id: changeId,
    generated_at: generatedAt,
    diagnostic_only: true,
    authorizes: [],
    run_status: outcome.run_status,
    freshness: outcome.freshness,
    outcome_reason: outcomeReason,
    abstained: outcome.abstained,
    coverage,
    inputs: inputs.map((input) => ({ path: input.path, sha256: input.sha256 ?? null, bytes: input.bytes ?? 0, kind: input.kind })),
    profile: {
      id: context.profilePart.id,
      version: context.profilePart.version,
      sha256: context.profilePart.sha256,
      state: context.profile.ok ? 'loaded' : 'unavailable',
    },
    findings,
    findings_summary: { total: findings.length, by_type: byType },
    dedup_policy: { revision: DEDUP_POLICY_REVISION, key_shape: 'finding_type+source_refs' },
    contract: context.contract,
    language: language === 'ru' ? 'ru' : (language === 'en' ? 'en' : 'unknown'),
    language_source: languageSource,
    language_options: { override: languageSource === 'override' ? language : null },
    diagnostics,
    worktree_identity: worktreeIdentity,
    binding,
    engine: context.engine,
  };
}

// ---------------------------------------------------------------------------
// Read-time revalidation (AC2): any divergence between the recorded composite
// binding and the current worktree/inputs/profile/engine/helper/contract/
// language state names the drifted fields and marks the observation stale.
// ---------------------------------------------------------------------------

export async function validateObservationBinding(rootDir, observation, options = {}) {
  if (!observation || typeof observation !== 'object' || observation.schema !== REQUIREMENT_LINT_SCHEMA
    || typeof observation.change_id !== 'string' || typeof observation.binding !== 'string') {
    return { ok: false, code: 'observation-invalid' };
  }
  const normalized = normalizeChangeId(observation.change_id);
  if (!normalized.ok) return { ok: false, code: 'observation-invalid' };
  // Full schema-form check before any binding comparison: damaged or stripped
  // findings must fail the validation instead of silently passing as fresh.
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
  if (recordedInputs.length > MAX_INPUTS) return { ok: false, code: 'observation-invalid' };
  // Semantic admissibility beyond the schema form: refs must belong to a
  // recorded input, stay inside its recorded byte length, carry the recorded
  // document digest, and dedup keys, summary, and outcome invariants must be
  // internally consistent — schema-valid tampering must fail here, not pass
  // as fresh.
  const inputsByPath = new Map(recordedInputs.map((input) => [input?.path, input]));
  const summaryByType = Object.fromEntries(FINDING_TYPES.map((type) => [type, 0]));
  const recordedFindings = Array.isArray(observation.findings) ? observation.findings : [];
  // Honest outcome invariants: a failed/not_run scan and an abstention can
  // never carry findings, and an abstention never claims scanned coverage.
  if ((observation.run_status === 'failed' || observation.run_status === 'not_run' || observation.abstained === true)
    && recordedFindings.length > 0) {
    return { ok: false, code: 'observation-invalid' };
  }
  if (observation.abstained === true && observation.coverage?.state !== 'none') {
    return { ok: false, code: 'observation-invalid' };
  }
  for (const finding of recordedFindings) {
    if (!finding || typeof finding !== 'object') return { ok: false, code: 'observation-invalid' };
    summaryByType[finding.finding_type] = (summaryByType[finding.finding_type] ?? 0) + 1;
    const refs = Array.isArray(finding.refs) ? finding.refs : [];
    if (finding.finding_type === 'suspected_requirement_revision_conflict') {
      if (refs.length !== 2) return { ok: false, code: 'observation-invalid' };
      if (new Set(refs.map((ref) => ref?.path)).size !== 1) return { ok: false, code: 'observation-invalid' };
    }
    for (const ref of refs) {
      if (ref?.kind !== 'span') continue;
      const input = inputsByPath.get(ref.path);
      if (!input || input.kind !== 'file') return { ok: false, code: 'observation-invalid' };
      const { start, end } = ref.span ?? {};
      if (!Number.isInteger(start) || !Number.isInteger(end)
        || start < 0 || end < start || end > (input.bytes ?? 0)) {
        return { ok: false, code: 'observation-invalid' };
      }
      // The recorded document digest must match the recorded input digest —
      // an internal contradiction of the record itself, independent of disk.
      if (ref.document_sha256 !== `sha256:${input.sha256}`) {
        return { ok: false, code: 'observation-invalid' };
      }
    }
    // Dedup keys are recomputed, not trusted: the stable key binds
    // finding_type + exact refs.
    if (finding.dedup_key !== digest({ finding_type: finding.finding_type, refs: finding.refs })) {
      return { ok: false, code: 'observation-invalid' };
    }
  }
  // Findings summary must agree with the findings array.
  const recordedSummary = observation.findings_summary ?? {};
  if ((recordedSummary.total ?? -1) !== recordedFindings.length
    || FINDING_TYPES.some((type) => (recordedSummary.by_type?.[type] ?? -1) !== summaryByType[type])
    || Object.keys(recordedSummary.by_type ?? {}).length !== FINDING_TYPES.length) {
    return { ok: false, code: 'observation-invalid' };
  }
  // Coverage consistency mirrors the writer's assembly rules: an incomplete
  // scan never claims full, an abstention never claims scanned sources.
  const recordedCoverage = observation.coverage ?? {};
  if (recordedCoverage.state === 'full'
    && ((recordedCoverage.scanned_sources ?? 0) < (recordedCoverage.declared_sources ?? 0)
      || (recordedCoverage.missing_sources ?? []).length > 0)) {
    return { ok: false, code: 'observation-invalid' };
  }
  if ((observation.diagnostics ?? []).some((entry) => entry?.code === 'findings-truncated')
    && recordedCoverage.state === 'full') {
    return { ok: false, code: 'observation-invalid' };
  }
  // Digest records are rebuilt from CURRENT disk bytes (never from the
  // recorded observation itself): an edited or renamed input must name its
  // field and flip the recomputed binding.
  const freshRecords = [];
  for (const input of recordedInputs) {
    const read = await readRequirementDocument(root, input.path, options);
    freshRecords.push({
      path: input.path,
      sha256: read.ok ? read.sha256 : (read.sha256 ?? null),
      bytes: read.bytes?.length ?? 0,
      kind: read.kind,
    });
  }
  const { profile, inputDigests, profilePart, engine, helper, contract } = await currentRequirementLintContext(root, freshRecords, options);
  for (const digestRecord of inputDigests) {
    const recorded = recordedInputs.find((candidate) => candidate?.path === digestRecord.path);
    if (!recorded || (recorded.sha256 ?? null) !== digestRecord.sha256 || (recorded.bytes ?? 0) !== digestRecord.bytes) {
      mismatched.push(`inputs:${digestRecord.path}`);
    }
  }
  const recordedProfile = observation.profile ?? {};
  if ((recordedProfile.id ?? null) !== (profilePart.id ?? null)
    || (recordedProfile.version ?? null) !== (profilePart.version ?? null)
    || (recordedProfile.sha256 ?? null) !== (profilePart.sha256 ?? null)
    || (recordedProfile.state ?? null) !== (profile.ok ? 'loaded' : 'unavailable')) mismatched.push('profile');
  const recordedEngine = observation.engine ?? {};
  if ((recordedEngine.module ?? null) !== engine.module
    || (recordedEngine.sha256 ?? null) !== engine.sha256
    || (recordedEngine.parser_version ?? null) !== engine.parser_version) mismatched.push('engine');
  const recordedContract = observation.contract ?? {};
  if ((recordedContract.name ?? null) !== contract.name
    || (recordedContract.sha256 ?? null) !== contract.sha256) mismatched.push('contract');
  const override = observation.language_options?.override ?? null;
  const documents = [];
  for (const input of recordedInputs) {
    const read = await readRequirementDocument(root, input.path, options);
    if (read.ok) documents.push(read);
  }
  const resolved = resolveProseLanguage(documents, override);
  if ((observation.language ?? 'unknown') !== (documents.length === 0 ? 'unknown' : resolved.language)) mismatched.push('language');
  const binding = buildAssessmentBinding(bindingCanonicalObject({
    worktreeIdentity,
    changeId: normalized.changeId,
    methodology: 'openspec',
    inputDigests,
    profilePart,
    engine,
    helper,
    contract,
    languageOptions: { override, resolved: documents.length === 0 ? 'unknown' : resolved.language, raw_quotes: 'preserve' },
    exclusionPolicy: profile.ok ? profile.exclusionPolicy : { id: 'unknown', version: 0 },
  }));
  if (binding !== observation.binding) mismatched.push('binding');
  return { ok: true, stale: mismatched.length > 0, mismatched: [...new Set(mismatched)], state: mismatched.length > 0 ? 'stale-observation' : null };
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

export async function writeRequirementLintObservation(rootDir, observation, config, options = {}) {
  const normalized = normalizeChangeId(observation.change_id);
  if (!normalized.ok) return { ok: false, code: 'invalid-change-id' };
  // Custom state roots are refused (owner-approved narrowing): the QA
  // projection covers only the default state root, so an observation under a
  // custom root would silently change required QA surfaces.
  const rawState = config.stateRootRaw;
  const stateRoot = normalizeConfigPath(rawState === undefined ? config.stateRoot : rawState);
  if (stateRoot === null) return { ok: false, code: 'state-root-mismatch', detail: String(rawState) };
  if (stateRoot !== STATE_ROOT) return { ok: false, code: 'state-root-mismatch', detail: stateRoot };
  const paths = requirementLintPaths(normalized.changeId);
  const relative = paths.observation;
  const rawQa = config.qaRootRaw;
  const qaRoot = canonicalizeConfigRoot(rawQa === undefined ? QA_ROOT : rawQa);
  if (qaRoot === null) return { ok: false, code: 'qa-root-unsafe', detail: String(rawQa ?? QA_ROOT) };
  if (withinCi(`${qaRoot}/`, relative) || relative.toLowerCase() === qaRoot.toLowerCase()) {
    return { ok: false, code: 'qa-namespace-conflict', detail: relative };
  }
  const root = await realpath(options.rootDir ?? rootDir);
  const parts = relative.split('/');
  // Read-only sources: the observation destination must never equal a selected
  // input — the writer would overwrite exactly the material the scan claims to
  // describe (readability `report-source-collision` precedent).
  const outputLower = relative.toLowerCase();
  const sourceCollision = (observation.inputs ?? []).find((input) => typeof input?.path === 'string'
    && normalizeConfigPath(input.path)?.toLowerCase() === outputLower);
  if (sourceCollision) return { ok: false, code: 'observation-source-collision', detail: sourceCollision.path };
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
    if (!prior || prior.schema !== REQUIREMENT_LINT_SCHEMA || prior.change_id !== observation.change_id) return leafConflict();
    if (validateJsonAgainstSchema(prior, schema).length !== 0) return leafConflict();
    return null;
  };
  const firstRejection = await assertLeafWritable();
  if (firstRejection) return firstRejection;
  // AC3 guard: the writer refuses a tracked or not-effectively-ignored output
  // for EVERY path it may create — the observation and the namespace
  // .gitignore. The QA snapshot's `actual_diff` channel (git diff --binary
  // HEAD) has no namespace filter, so restoring a tracked-then-deleted
  // namespace gitignore would shift required QA surfaces exactly like a
  // tracked observation would.
  const gitGuard = options.gitGuard ?? verifyObservationIgnored;
  const gitignoreRelative = `${paths.directory}/.gitignore`;
  for (const guarded of [relative, gitignoreRelative]) {
    const verdict = await gitGuard(root, guarded, options);
    if (!verdict.ok) return { ok: false, code: verdict.code, detail: verdict.detail ?? null };
  }
  // Gitignore lives inside the closed lint namespace: the namespace contents
  // stay local while the ignore rule itself is excluded from QA projections.
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
  // rename — the checks the shared helper performed and a bare path.join
  // writer would lose.
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
    // Post-temp containment re-check (TOCTOU): the destination and the
    // temporary must still resolve to safe, link-free paths inside the root.
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
    const lines = [`Requirement lint (advisory): ${value.state}`];
    for (const code of value.codes ?? []) lines.push(`  diagnostic: ${code}`);
    if (value.message) lines.push(value.message);
    lines.push(`Usage: ${value.usage ?? usage}`);
    return lines.join('\n');
  }
  const lines = [
    `Requirement lint (advisory, no gate evidence): change ${value.change_id}`,
    `Run: ${value.run_status}; freshness: ${value.freshness}; coverage: ${value.coverage?.state}; findings: ${value.findings_summary?.total ?? 0}`,
  ];
  if (value.run_status !== 'complete' || value.abstained || value.freshness !== 'current' || value.coverage?.state !== 'full') {
    lines.push('Degraded outcome — this is NOT a zero-findings result.');
  } else if ((value.findings_summary?.total ?? 0) === 0) {
    lines.push('No findings in the presented scope; this is not a readiness, verification, or approval signal.');
  }
  for (const finding of value.findings ?? []) {
    const renderRef = (ref) => (ref.kind === 'span' ? `${ref.path}:${ref.span?.start}-${ref.span?.end}` : ref.source_id);
    const at = finding.ref_relation === 'conflicting_revision_pair'
      ? (finding.refs ?? []).map(renderRef).join(' <-> ')
      : renderRef(finding.refs?.[0] ?? {});
    lines.push(`  ${finding.finding_type} @ ${at} — ${finding.rationale}`);
    lines.push(`    question: ${finding.proposed_question}`);
  }
  for (const diagnostic of value.diagnostics ?? []) {
    lines.push(`  diagnostic: ${diagnostic.code}${diagnostic.path ? ` (${diagnostic.path})` : ''}${diagnostic.detail ? ` — ${diagnostic.detail}` : ''}`);
  }
  return lines.join('\n');
}

export async function runRequirementLintCommand(argv = process.argv.slice(2), options = {}) {
  const output = options.output ?? ((value) => process.stdout.write(value));
  const emit = (value, json) => output(json ? `${JSON.stringify(value, null, 2)}\n` : `${renderHuman(value)}\n`);
  const now = options.now ?? Date.now;
  const startedAt = now();

  const parsed = parseRequirementLintArgs(argv);
  if (!parsed.ok) {
    emit(notRunEnvelope(['invalid-usage', parsed.error]), parsed.json);
    return 2;
  }
  let rootDir;
  try {
    rootDir = await realpath(options.rootDir ?? process.cwd());
  } catch {
    process.stderr.write('requirement-lint: project root is unreadable\n');
    return 1;
  }
  const config = options.config ?? await readRequirementLintConfig(rootDir, options);
  const cliEnabled = parsed.enabled;
  // A malformed lint namespace keeps the lint off regardless of the parsed
  // value: the opt-in must stay explicit and intact to run.
  const enabled = config.enabledMalformed ? false : (cliEnabled ?? config.enabled);
  const configCodes = (config.diagnostics ?? [])
    .filter((diagnostic) => String(diagnostic.code).startsWith('requirement-lint:')
      || diagnostic.code === 'config-unreadable' || diagnostic.code === 'config-malformed')
    .map((diagnostic) => diagnostic.code);
  if (enabled !== true) {
    const codes = configCodes.length > 0
      ? ['requirement-lint-disabled', ...configCodes.slice(0, 11)]
      : ['requirement-lint-disabled'];
    emit(notRunEnvelope(codes), parsed.json);
    return 0;
  }
  if (typeof parsed.changeId !== 'string') {
    emit(notRunEnvelope(['missing-change']), parsed.json);
    return 2;
  }
  // Schema-compatible change-id bounds are checked before any read or scan, so
  // an oversized id is a typed invalid invocation (exit 2), not a late
  // schema-parity failure after the whole assessment already ran.
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
  if (parsed.files.length === 0) {
    emit(notRunEnvelope(['empty-input']), parsed.json);
    return 2;
  }
  if (parsed.files.length > MAX_INPUTS) {
    emit(notRunEnvelope(['inputs-limit-exceeded']), parsed.json);
    return 2;
  }
  const formViolations = parsed.files.filter((relative) => !validateFileForm(relative));
  if (formViolations.length > 0) {
    emit(notRunEnvelope(formViolations.map((relative) => `unsafe-file:${relative}`).slice(0, 12)), parsed.json);
    return 2;
  }

  try {
    const diagnostics = [...(config.diagnostics ?? [])];
    const inputs = [];
    for (const relative of [...new Set(parsed.files)]) {
      const read = await readRequirementDocument(rootDir, relative, options);
      inputs.push({ path: relative, sha256: read.ok ? read.sha256 : (read.sha256 ?? null), bytes: read.bytes?.length ?? 0, data: read.bytes, kind: read.kind, code: read.code, ok: read.ok, text: read.text, lines: read.lines });
      if (!read.ok) diagnostics.push({ code: read.code === 'file-missing' ? 'file-missing' : 'malformed-input', path: relative, detail: read.code });
    }
    const context = await currentRequirementLintContext(rootDir, inputs, options);
    const prose = resolveProseLanguage(inputs.filter((input) => input.ok), parsed.language);
    const resolvedLanguage = inputs.some((input) => input.ok) ? prose.language : 'unknown';
    const worktreeIdentity = await computeWorktreeIdentity(rootDir, options);
    // Binding input digests come from the exact bytes read above; the watch
    // re-reads only for drift detection.
    const binding = buildAssessmentBinding(bindingCanonicalObject({
      worktreeIdentity,
      changeId,
      methodology: 'openspec',
      inputDigests: context.inputDigests,
      profilePart: context.profilePart,
      engine: context.engine,
      helper: context.helper,
      contract: context.contract,
      languageOptions: { override: prose.source === 'override' ? prose.language : null, resolved: resolvedLanguage, raw_quotes: 'preserve' },
      exclusionPolicy: context.profile.ok ? context.profile.exclusionPolicy : { id: 'unknown', version: 0 },
    }));

    // Post-scan freshness probe (AC2): re-reads current disk state and
    // compares the recomputed binding against the one built from the scanned
    // bytes, so a mid-scan A→B swap yields stale, not a silent current.
    const watch = {
      changed: async () => {
        const freshInputs = [];
        for (const relative of inputs.map((input) => input.path)) {
          const read = await readRequirementDocument(rootDir, relative, options);
          freshInputs.push({ path: relative, sha256: read.ok ? read.sha256 : (read.sha256 ?? null), bytes: read.bytes?.length ?? 0, kind: read.kind });
        }
        const current = await currentRequirementLintContext(rootDir, freshInputs, options);
        return buildAssessmentBinding(bindingCanonicalObject({
          worktreeIdentity: await computeWorktreeIdentity(rootDir, options),
          changeId,
          methodology: 'openspec',
          inputDigests: current.inputDigests,
          profilePart: current.profilePart,
          engine: current.engine,
          helper: current.helper,
          contract: current.contract,
          languageOptions: { override: prose.source === 'override' ? prose.language : null, resolved: resolvedLanguage, raw_quotes: 'preserve' },
          exclusionPolicy: current.profile.ok ? current.profile.exclusionPolicy : { id: 'unknown', version: 0 },
        })) !== binding;
      },
    };
    // A missing or damaged pinned profile never falls back to built-in rules:
    // the scan honestly does not run instead of reporting findings under a
    // profile it could not verify.
    if (!context.profile.ok) {
      diagnostics.push(...context.profile.diagnostics);
      const outcome = notRunAssessment('profile-unavailable', []);
      const observation = assembleObservation({
        changeId,
        generatedAt: new Date(startedAt).toISOString(),
        outcome,
        inputs,
        context,
        language: resolvedLanguage,
        languageSource: prose.source,
        worktreeIdentity,
        binding,
        diagnostics,
      });
      const schemaBytes = await readFile(new URL(`../${CONTRACT_MODULE}`, import.meta.url), 'utf8');
      const schema = parseStrictJson(schemaBytes);
      const schemaErrors = validateJsonAgainstSchema(observation, schema);
      if (schemaErrors.length > 0) {
        emit(failureEnvelope('operational-failure', ['schema-parity-failure', ...schemaErrors.slice(0, 5).map((error) => error.message)]), parsed.json);
        return 1;
      }
      if (parsed.write) {
        const written = await writeRequirementLintObservation(rootDir, observation, config, options);
        if (!written.ok) {
          emit({ ...failureEnvelope('observation-not-saved', [written.code]), change_id: changeId, detail: written.detail ?? null }, parsed.json);
          return 1;
        }
      }
      emit(observation, parsed.json);
      return 0;
    }
    // Document order is normalized (sorted by path): the same input set must
    // produce the same saved findings under one binding regardless of CLI
    // order, because global caps make the sequence observable.
    const documents = inputs.filter((input) => input.ok)
      .slice()
      .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
      .map((input) => ({ path: input.path, sha256: input.sha256, bytes: input.data, text: input.text, lines: input.lines }));
    const scannedCoverage = {
      state: documents.length === 0 ? 'none' : (documents.length === inputs.length ? 'full' : 'partial'),
      declared_sources: inputs.length,
      scanned_sources: documents.length,
      missing_sources: inputs.filter((input) => input.kind !== 'file')
        .map((input) => ({ path: input.path, reason: input.kind === 'missing' ? 'file-missing' : String(input.code ?? 'malformed') })),
    };
    const assessor = options.assessor ?? createRulesAssessor(context.profile.rules);
    const outcome = await runTypedAssessment({
      assessor,
      input: { documents, language: prose.language },
      coverage: scannedCoverage,
      limits: { deadlineMs: options.deadlineMs ?? DEFAULT_DEADLINE_MS, maxFindings: MAX_FINDINGS, maxDiagnostics: MAX_DIAGNOSTICS },
      watch,
      now,
    });
    // Outcome diagnostics land first so the stale/truncation markers are
    // protected when the tail is trimmed, and an explicit marker survives a
    // full diagnostics budget.
    const combinedDiagnostics = [...outcome.diagnostics, ...diagnostics];
    if (combinedDiagnostics.length > MAX_DIAGNOSTICS) {
      combinedDiagnostics.length = Math.max(1, MAX_DIAGNOSTICS - 1);
      combinedDiagnostics.push({ code: 'diagnostics-truncated', path: null, detail: `limit=${MAX_DIAGNOSTICS}` });
    }

    const observation = assembleObservation({
      changeId,
      generatedAt: new Date(startedAt).toISOString(),
      outcome,
      inputs,
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
      const written = await writeRequirementLintObservation(rootDir, observation, config, options);
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
  process.exitCode = await runRequirementLintCommand();
}
