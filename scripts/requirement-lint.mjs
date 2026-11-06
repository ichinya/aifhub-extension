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
import { lstat, mkdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { digest, portablePath } from './workflow-state-store.mjs';
import { parseStrictJson } from './json-strict.mjs';
import { validateJsonAgainstSchema } from './json-schema-subset.mjs';
import { readProviderFile, writeProviderFile } from './provider-files.mjs';
import { normalizeChangeId } from './active-change-resolver.mjs';
import { ensureRuntimeGitignore } from './runtime-gitignore.mjs';
import {
  buildAssessmentBinding,
  notRunAssessment,
  runTypedAssessment,
  validateAssessmentObservation,
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

function lintConfigDiagnostic(code, detail) {
  return { code: `requirement-lint:${code}`, path: '.ai-factory/config.yaml', detail: detail === undefined ? null : String(detail).slice(0, 200) };
}

export function parseRequirementLintConfigSubset(raw) {
  const diagnostics = [];
  const root = {};
  const stack = [{ indent: -1, value: root, path: [] }];
  const belowLint = (path) => path.length > LINT_CONFIG_PATH.length
    && LINT_CONFIG_PATH.every((part, index) => path[index] === part);
  const scalar = (rawValue) => {
    if (/^(['"]).*\1$/.test(rawValue)) return { text: rawValue.slice(1, -1), quoted: true };
    const unquoted = rawValue.replace(/^['"]|['"]$/g, '');
    if (/^(true|false)$/i.test(unquoted)) return { bool: unquoted.toLowerCase() === 'true', text: unquoted, quoted: false };
    if (/^-?\d+(?:\.\d+)?$/.test(unquoted)) return { number: Number(unquoted), text: unquoted, quoted: false };
    return { text: unquoted, quoted: false };
  };
  for (const rawLine of String(raw ?? '').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const withoutComment = rawLine.replace(/\s+#.*$/, '');
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
    if (inside && key === '<<') {
      diagnostics.push(lintConfigDiagnostic('merge-key', key));
      continue;
    }
    if (inside && rawValue.startsWith('&')) {
      diagnostics.push(lintConfigDiagnostic('anchor', key));
      continue;
    }
    if (inside && rawValue.startsWith('*')) {
      diagnostics.push(lintConfigDiagnostic('alias', key));
      continue;
    }
    if (inside && /^[{[]/.test(rawValue)) {
      diagnostics.push(lintConfigDiagnostic('flow-mapping', key));
      continue;
    }
    if (inside && Object.hasOwn(parent.value, key)) {
      diagnostics.push(lintConfigDiagnostic('duplicate-key', key));
      continue;
    }
    if (inside && !LINT_CONFIG_CLOSED_KEYS.has(key)) {
      diagnostics.push(lintConfigDiagnostic('unknown-key', key));
      continue;
    }
    if (rawValue.length === 0) {
      parent.value[key] = {};
      stack.push({ indent, value: parent.value[key], path: ownPath });
      continue;
    }
    const parsed = scalar(rawValue);
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
    diagnostics.push({ code: 'config-unreadable', path: '.ai-factory/config.yaml', detail: String(error?.message ?? error) });
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
  const enabled = parsed.value?.aifhub?.requirementLint?.enabled;
  if (enabled !== undefined) {
    if (typeof enabled === 'boolean') config.enabled = enabled;
    else {
      config.enabledMalformed = true;
      diagnostics.push(lintConfigDiagnostic('not-a-boolean', JSON.stringify(enabled)));
    }
  }
  if (parsed.diagnostics.length > 0) config.enabledMalformed = true;
  const rawState = parsed.value?.paths?.state;
  if (rawState !== undefined) config.stateRootRaw = rawState;
  const stateRoot = normalizeConfigPath(rawState);
  if (stateRoot !== null) config.stateRoot = stateRoot;
  const rawQa = parsed.value?.paths?.qa;
  if (rawQa !== undefined) config.qaRootRaw = rawQa;
  const qaRoot = normalizeConfigPath(rawQa);
  if (qaRoot !== null) config.qaRoot = qaRoot;
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
  if (parsed?.schema !== REQUIREMENT_LINT_PROFILE_SCHEMA || typeof parsed.profile_id !== 'string'
    || !Number.isInteger(parsed.profile_version) || !Array.isArray(parsed.rules)
    || parsed.rules.some((rule) => typeof rule?.id !== 'string' || !Number.isInteger(rule?.version)
      || !['project', 'upstream'].includes(rule?.origin) || !FINDING_TYPES.includes(rule?.type))) {
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

function catalogRef(sourceId) {
  return { kind: 'catalog', source_id: sourceId };
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
    for (const document of documents) {
      if (context.expired()) return { ok: false, code: 'deadline-exceeded' };
      let inFence = false;
      let perDocument = 0;
      for (const line of document.lines) {
        const trimmed = line.text.trim();
        if (/^```/.test(trimmed)) { inFence = !inFence; continue; }
        if (inFence || trimmed.length === 0) continue;
        if (findings.length >= MAX_FINDINGS || perDocument >= MAX_FINDINGS_PER_DOCUMENT) break;
        const hasMarker = REQUIREMENT_MARKER_RE.test(line.text);
        const quote = quoteOf(line.text);
        if (hasMarker && !EN_OBSERVABLE_RE.test(line.text) && !RU_OBSERVABLE_RE.test(line.text)) {
          findings.push(buildFinding('undefined_observable_outcome', ruleFor('undefined_observable_outcome'),
            [spanRef(document, line.start, line.end)], language, quote));
          perDocument += 1;
        }
        if (hasMarker && (EN_SUCCESS_ACTION_RE.test(line.text) || RU_SUCCESS_ACTION_RE.test(line.text))
          && !EN_ERROR_AWARE_RE.test(line.text) && !RU_ERROR_AWARE_RE.test(line.text)) {
          findings.push(buildFinding('missing_error_case', ruleFor('missing_error_case'),
            [spanRef(document, line.start, line.end)], language, quote));
          perDocument += 1;
        }
        // Strong assumption markers do not require a requirement marker: an
        // unattributed "obviously"/«будем считать» is an owner decision taken
        // silently regardless of sentence form.
        if ((EN_STRONG_ASSUMPTION_RE.test(line.text) || RU_STRONG_ASSUMPTION_RE.test(line.text))
          && !OWNER_ATTRIBUTION_RE.test(line.text)) {
          findings.push(buildFinding('owner_decision_assumed', ruleFor('owner_decision_assumed'),
            [spanRef(document, line.start, line.end)], language, quote));
          perDocument += 1;
        }
        const markers = hasMarker ? collectMatches(line.text, [EN_REVISION_MARKER_RE, RU_REVISION_MARKER_RE]) : [];
        if (markers.length >= 2 && !RESOLUTION_RE.test(line.text)) {
          const refs = markers.slice(0, 2).map((marker) => {
            const start = line.start + byteOffsetOfLine(line.text, marker.index);
            return spanRef(document, start, start + Buffer.byteLength(marker.text, 'utf8'));
          });
          findings.push(buildFinding('suspected_requirement_revision_conflict', ruleFor('suspected_requirement_revision_conflict'),
            refs, language, quote));
          perDocument += 1;
        }
        if (perDocument >= MAX_FINDINGS_PER_DOCUMENT) break;
      }
    }
    return { findings, diagnostics: [] };
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

export async function currentRequirementLintContext(rootDir, inputs, options = {}) {
  const profile = await loadRequirementLintProfile(options);
  const contractSha = await moduleSha256(new URL(`../${CONTRACT_MODULE}`, import.meta.url), options);
  const engineSha = await moduleSha256(new URL(`../${ENGINE_MODULE}`, import.meta.url), options);
  const helperSha = await moduleSha256(new URL(`../${HELPER_MODULE}`, import.meta.url), options);
  const inputDigests = [];
  for (const input of inputs) {
    const read = await readRequirementDocument(rootDir, input.path, options);
    inputDigests.push({
      path: input.path,
      sha256: read.ok ? read.sha256 : (read.sha256 ?? null),
      bytes: read.bytes?.length ?? 0,
      kind: read.kind,
    });
  }
  inputDigests.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  const profilePart = profile.ok
    ? { sha256: profile.sha256, id: profile.profile.profile_id, version: profile.profile.profile_version, rules: Object.fromEntries([...profile.rules.entries()].map(([id, rule]) => [id, rule.version])) }
    : { sha256: profile.sha256 ?? null, id: null, version: null, rules: {} };
  return {
    profile,
    inputDigests,
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
  const coverageState = scanned === 0 ? 'none' : (scanned === inputs.length ? 'full' : 'partial');
  const coverage = outcome.run_status === 'complete' && outcome.abstained
    ? { ...outcome.coverage }
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
  const { profile, inputDigests, profilePart, engine, helper, contract } = await currentRequirementLintContext(root, recordedInputs, options);
  for (const digestRecord of inputDigests) {
    const recorded = recordedInputs.find((input) => input?.path === digestRecord.path);
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
  // not ownership.
  const schemaBytes = await readFile(new URL(`../${CONTRACT_MODULE}`, import.meta.url), 'utf8');
  const schema = parseStrictJson(schemaBytes);
  const assertLeafWritable = async () => {
    let leafInfo = null;
    try { leafInfo = await lstat(leaf); } catch { leafInfo = null; }
    if (leafInfo === null) return null;
    if (!leafInfo.isFile()) return leafConflict();
    const previous = await readProviderFile(root, relative, 4 * 1024 * 1024);
    if (previous === null) return leafConflict();
    let prior = null;
    try { prior = parseStrictJson(previous.toString('utf8')); } catch { prior = null; }
    if (!prior || prior.schema !== REQUIREMENT_LINT_SCHEMA || prior.change_id !== observation.change_id) return leafConflict();
    if (validateJsonAgainstSchema(prior, schema).length !== 0) return leafConflict();
    return null;
  };
  const firstRejection = await assertLeafWritable();
  if (firstRejection) return firstRejection;
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
  await mkdir(directory, { recursive: true });
  // TOCTOU re-check after materialization: the live directory must resolve to
  // the same real path (no symlink/junction swap).
  const liveDirectory = await realpath(directory);
  if (path.resolve(liveDirectory).toLowerCase() !== path.resolve(directory).toLowerCase()) {
    return { ok: false, code: 'file-shadow', detail: parts.slice(0, -1).join('/') };
  }
  const secondRejection = await assertLeafWritable();
  if (secondRejection) return secondRejection;
  try {
    await writeProviderFile(root, relative, observation);
  } catch (error) {
    return { ok: false, code: 'observation-write-failed', detail: String(error?.message ?? error).slice(0, 200) };
  }
  return { ok: true, path: relative };
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
    const ref = finding.refs?.[0] ?? {};
    const at = ref.kind === 'span' ? `${ref.path}:${ref.span?.start}-${ref.span?.end}` : ref.source_id;
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
    .filter((diagnostic) => String(diagnostic.code).startsWith('requirement-lint:'))
    .map((diagnostic) => diagnostic.code);
  if (enabled !== true) {
    const codes = config.enabledMalformed
      ? ['requirement-lint-disabled', ...configCodes.slice(0, 11)]
      : ['requirement-lint-disabled'];
    emit(notRunEnvelope(codes), parsed.json);
    return 0;
  }
  if (typeof parsed.changeId !== 'string') {
    emit(notRunEnvelope(['missing-change']), parsed.json);
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
    if (!context.profile.ok) diagnostics.push(...context.profile.diagnostics);
    const prose = resolveProseLanguage(inputs.filter((input) => input.ok), parsed.language);
    const resolvedLanguage = inputs.some((input) => input.ok) ? prose.language : 'unknown';
    const worktreeIdentity = await computeWorktreeIdentity(rootDir, options);
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

    // Post-scan freshness probe (AC2): requirement edits, rubric, or profile
    // drift during the scan mark the outcome stale; it is then never presented
    // as current (R7).
    const watch = {
      changed: async () => {
        const current = await currentRequirementLintContext(rootDir, inputs, options);
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
    const assessor = options.assessor ?? createRulesAssessor(context.profile.rules);
    const outcome = await runTypedAssessment({
      assessor,
      input: {
        documents: inputs.filter((input) => input.ok)
          .map((input) => ({ path: input.path, sha256: input.sha256, bytes: input.data, text: input.text, lines: input.lines })),
        language: prose.language,
      },
      coverage: null,
      limits: { deadlineMs: options.deadlineMs ?? DEFAULT_DEADLINE_MS, maxFindings: MAX_FINDINGS, maxDiagnostics: MAX_DIAGNOSTICS },
      watch,
      now,
    });
    diagnostics.push(...outcome.diagnostics);
    if (diagnostics.length > MAX_DIAGNOSTICS) diagnostics.length = MAX_DIAGNOSTICS;

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
  } catch (error) {
    emit(failureEnvelope('operational-failure', [String(error?.message ?? error).slice(0, 120)]), parsed.json);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runRequirementLintCommand();
}
