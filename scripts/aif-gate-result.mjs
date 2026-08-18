// aif-gate-result.mjs - helpers for AI Factory machine-readable gate summaries
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const GATE_RESULT_LANGUAGE = 'aif-gate-result';
export const SCHEMA_VERSION = 1;
export const SUPPORTED_GATES = Object.freeze(['verify', 'review', 'security', 'rules']);
export const SUPPORTED_STATUSES = Object.freeze(['pass', 'warn', 'fail']);

const BLOCKING_STATUS = 'fail';
const SUGGESTED_COMMANDS_BY_GATE = Object.freeze({
  verify: ['/aif-fix', '/aif-verify'],
  review: ['/aif-fix', '/aif-review'],
  security: ['/aif-fix', '/aif-security-checklist'],
  rules: ['/aif-rules', '/aif-rules-check', '/aif-fix', '/aif-mode']
});

export function createGateResult(input = {}) {
  const gate = normalizeLowerString(input.gate);
  const status = normalizeLowerString(input.status);
  const blockers = normalizeBlockers(input.blockers);
  const affectedFiles = dedupeStrings([
    ...normalizeStringArray(input.affected_files ?? input.affectedFiles),
    ...blockers.map((blocker) => blocker.file).filter(Boolean)
  ]);
  const result = {
    schema_version: SCHEMA_VERSION,
    gate,
    status,
    blocking: status === BLOCKING_STATUS,
    blockers,
    affected_files: affectedFiles,
    suggested_next: normalizeSuggestedNext(input.suggested_next ?? input.suggestedNext)
  };
  const validation = validateGateResult(result);

  if (!validation.ok) {
    throw new Error(`Invalid aif-gate-result: ${validation.errors.map((error) => error.message).join('; ')}`);
  }

  return result;
}

export function renderGateResultBlock(result) {
  const validation = validateGateResult(result);

  if (!validation.ok) {
    throw new Error(`Invalid aif-gate-result: ${validation.errors.map((error) => error.message).join('; ')}`);
  }

  return [
    `\`\`\`${GATE_RESULT_LANGUAGE}`,
    JSON.stringify(validation.value, null, 2),
    '```'
  ].join('\n');
}

export function extractGateResultBlocks(markdown, options = {}) {
  const lines = String(markdown ?? '').replace(/\r\n/g, '\n').split('\n');
  const blocks = [];
  const gateFilter = options.gate === undefined ? null : normalizeLowerString(options.gate);

  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trimEnd() !== `\`\`\`${GATE_RESULT_LANGUAGE}`) {
      continue;
    }

    const startLine = index + 1;
    const content = [];
    let endIndex = -1;

    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      if (lines[cursor].trim() === '```') {
        endIndex = cursor;
        break;
      }

      content.push(lines[cursor]);
    }

    if (endIndex === -1) {
      break;
    }

    index = endIndex;

    let parsed;
    try {
      parsed = JSON.parse(content.join('\n'));
    } catch (err) {
      const raw = content.join('\n');
      if (gateFilter !== null && shouldSkipRawGate(raw, gateFilter)) {
        continue;
      }

      blocks.push(createParsedBlock({
        ok: false,
        result: null,
        raw,
        startLine,
        endLine: endIndex + 1,
        errors: [
          diagnostic(
            'invalid-json',
            `aif-gate-result block contains invalid JSON: ${err?.message ?? 'parse failed'}.`
          )
        ]
      }));
      continue;
    }

    if (gateFilter !== null && shouldSkipParsedGate(parsed, gateFilter)) {
      continue;
    }

    const validation = validateGateResult(parsed);
    if (!validation.ok) {
      blocks.push(createParsedBlock({
        ok: false,
        result: null,
        raw: content.join('\n'),
        startLine,
        endLine: endIndex + 1,
        errors: validation.errors
      }));
      continue;
    }

    blocks.push(createParsedBlock({
      ok: true,
      result: validation.value,
      raw: content.join('\n'),
      startLine,
      endLine: endIndex + 1,
      errors: []
    }));
  }

  return blocks;
}

export function getLatestGateResult(markdown, options = {}) {
  const blocks = extractGateResultBlocks(markdown, options);
  return blocks.at(-1) ?? null;
}

export async function readLatestGateResultFile(filePath, options = {}) {
  const content = await readFile(filePath, 'utf8');
  return getLatestGateResult(content, options);
}

export function validateGateResult(value, options = {}) {
  const errors = [];

  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return {
      ok: false,
      value: null,
      errors: [diagnostic('invalid-result', 'Gate result must be a JSON object.')]
    };
  }

  const normalized = {
    schema_version: value.schema_version,
    gate: normalizeLowerString(value.gate),
    status: normalizeLowerString(value.status),
    blocking: value.blocking,
    blockers: Array.isArray(value.blockers) ? value.blockers.map((blocker) => ({ ...blocker })) : value.blockers,
    affected_files: Array.isArray(value.affected_files) ? [...value.affected_files] : value.affected_files,
    suggested_next: value.suggested_next === undefined ? null : value.suggested_next
  };

  if (normalized.schema_version !== SCHEMA_VERSION) {
    errors.push(diagnostic('invalid-schema-version', `schema_version must be ${SCHEMA_VERSION}.`));
  }

  if (!SUPPORTED_GATES.includes(normalized.gate)) {
    errors.push(diagnostic('invalid-gate', `gate must be one of: ${SUPPORTED_GATES.join(', ')}.`));
  } else if (options.gate !== undefined && normalized.gate !== normalizeLowerString(options.gate)) {
    errors.push(diagnostic('gate-mismatch', `gate must be ${normalizeLowerString(options.gate)}.`));
  }

  if (!SUPPORTED_STATUSES.includes(normalized.status)) {
    errors.push(diagnostic('invalid-status', `status must be one of: ${SUPPORTED_STATUSES.join(', ')}.`));
  }

  if (typeof normalized.blocking !== 'boolean') {
    errors.push(diagnostic('invalid-blocking', 'blocking must be a boolean.'));
  } else if (SUPPORTED_STATUSES.includes(normalized.status) && normalized.blocking !== (normalized.status === BLOCKING_STATUS)) {
    errors.push(diagnostic('invalid-blocking', 'blocking must be true only when status is fail.'));
  }

  if (!Array.isArray(normalized.blockers)) {
    errors.push(diagnostic('invalid-blockers', 'blockers must be an array.'));
  } else {
    for (const [index, blocker] of normalized.blockers.entries()) {
      errors.push(...validateBlocker(blocker, index));
    }
    errors.push(...validateRulesFailProvenance(normalized));
  }

  if (!Array.isArray(normalized.affected_files)) {
    errors.push(diagnostic('invalid-affected-files', 'affected_files must be an array.'));
  } else if (!normalized.affected_files.every((item) => typeof item === 'string')) {
    errors.push(diagnostic('invalid-affected-files', 'affected_files must contain only strings.'));
  }

  errors.push(...validateSuggestedNext(normalized.suggested_next, normalized.gate, normalized.status));

  return {
    ok: errors.length === 0,
    value: errors.length === 0 ? normalized : null,
    errors
  };
}

function normalizeBlockers(blockers) {
  return Array.from(blockers ?? []).map((blocker) => {
    const source = blocker !== null && typeof blocker === 'object' && !Array.isArray(blocker)
      ? blocker
      : {};
    const normalized = {
      ...source,
      id: String(source.id ?? '').trim(),
      severity: normalizeLowerString(source.severity),
      summary: String(source.summary ?? '').trim()
    };

    if (source.file !== undefined && source.file !== null) {
      normalized.file = normalizePathString(source.file);
    }

    return normalized;
  });
}

function validateBlocker(blocker, index) {
  const errors = [];
  const prefix = `blockers[${index}]`;

  if (blocker === null || typeof blocker !== 'object' || Array.isArray(blocker)) {
    return [diagnostic('invalid-blocker', `${prefix} must be an object.`)];
  }

  if (typeof blocker.id !== 'string' || blocker.id.trim().length === 0) {
    errors.push(diagnostic('invalid-blocker-id', `${prefix}.id must be a non-empty string.`));
  }

  if (!['error', 'warning'].includes(blocker.severity)) {
    errors.push(diagnostic('invalid-blocker-severity', `${prefix}.severity must be error or warning.`));
  }

  if (blocker.file !== undefined && (typeof blocker.file !== 'string' || blocker.file.trim().length === 0)) {
    errors.push(diagnostic('invalid-blocker-file', `${prefix}.file must be a non-empty string when present.`));
  }

  if (typeof blocker.summary !== 'string' || blocker.summary.trim().length === 0) {
    errors.push(diagnostic('invalid-blocker-summary', `${prefix}.summary must be a non-empty string.`));
  }

  return errors;
}

function validateRulesFailProvenance(result) {
  if (result.gate !== 'rules' || result.status !== 'fail') {
    return [];
  }

  if (result.blockers.length === 0) {
    return [diagnostic(
      'invalid-rules-fail-provenance',
      'rules fail results must include at least one trace-backed blocker.'
    )];
  }

  return result.blockers.flatMap((blocker, index) => {
    if (hasRulesBlockerProvenance(blocker)) {
      return [];
    }

    return [diagnostic(
      'invalid-rules-fail-provenance',
      `blockers[${index}] for rules fail must include rule_id, rule_source, evidence_path, or source.path plus source.requirement.`
    )];
  });
}

function hasRulesBlockerProvenance(blocker) {
  return hasNonEmptyString(blocker?.rule_id)
    || hasNonEmptyString(blocker?.rule_source)
    || hasNonEmptyString(blocker?.evidence_path)
    || (
      blocker?.source !== null
      && typeof blocker?.source === 'object'
      && !Array.isArray(blocker.source)
      && hasNonEmptyString(blocker.source.path)
      && hasNonEmptyString(blocker.source.requirement)
    );
}

function hasNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function normalizeSuggestedNext(value) {
  if (value === null || value === undefined) {
    return null;
  }

  return {
    command: String(value.command ?? '').trim(),
    reason: String(value.reason ?? '').trim()
  };
}

function validateSuggestedNext(value, gate, status) {
  if (status === 'pass' && value !== null) {
    return [diagnostic(
      'invalid-suggested-next-on-pass',
      'suggested_next must be null when status is pass; terminal routing is prose-only.'
    )];
  }

  if (value === null) {
    return [];
  }

  if (value === undefined || typeof value !== 'object' || Array.isArray(value)) {
    return [diagnostic('invalid-suggested-next', 'suggested_next must be an object or null.')];
  }

  const errors = [];
  if (typeof value.command !== 'string' || value.command.trim().length === 0) {
    errors.push(diagnostic('invalid-suggested-next-command', 'suggested_next.command must be a non-empty string.'));
  } else if (SUPPORTED_GATES.includes(gate) && !isAllowedSuggestedCommand(value.command, gate)) {
    errors.push(diagnostic(
      'invalid-suggested-next-command',
      `suggested_next.command for ${gate} must start with one of: ${SUGGESTED_COMMANDS_BY_GATE[gate].join(', ')}.`
    ));
  }

  if (typeof value.reason !== 'string' || value.reason.trim().length === 0) {
    errors.push(diagnostic('invalid-suggested-next-reason', 'suggested_next.reason must be a non-empty string.'));
  }

  return errors;
}

function isAllowedSuggestedCommand(command, gate) {
  const value = String(command ?? '').trim();
  return SUGGESTED_COMMANDS_BY_GATE[gate].some((allowed) => (
    value === allowed || value.startsWith(`${allowed} `)
  ));
}

function createParsedBlock({ ok, result, raw, startLine, endLine, errors }) {
  return {
    ok,
    result,
    raw,
    startLine,
    endLine,
    errors
  };
}

function shouldSkipParsedGate(parsed, gateFilter) {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return false;
  }

  const parsedGate = normalizeLowerString(parsed.gate);
  return parsedGate.length > 0 && parsedGate !== gateFilter;
}

function shouldSkipRawGate(raw, gateFilter) {
  const match = String(raw ?? '').match(/"gate"\s*:\s*"([^"]+)"/);
  if (!match) {
    return false;
  }

  return normalizeLowerString(match[1]) !== gateFilter;
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map(normalizePathString).filter((item) => item.length > 0);
}

function normalizeLowerString(value) {
  return String(value ?? '').trim().toLowerCase();
}

function normalizePathString(value) {
  return String(value ?? '').trim().replaceAll('\\', '/');
}

function dedupeStrings(values) {
  const seen = new Set();
  const result = [];

  for (const value of values) {
    if (!seen.has(value)) {
      seen.add(value);
      result.push(value);
    }
  }

  return result;
}

function diagnostic(code, message) {
  return { code, message };
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  const targetPath = process.argv[2];
  if (!targetPath) {
    process.stderr.write('Usage: node scripts/aif-gate-result.mjs <markdown-file> [gate]\n');
    process.exitCode = 2;
  } else {
    const result = await readLatestGateResultFile(targetPath, { gate: process.argv[3] });
    process.stdout.write(`${JSON.stringify(result?.ok ? result.result : result, null, 2)}\n`);
    process.exitCode = result?.ok ? 0 : 1;
  }
}
