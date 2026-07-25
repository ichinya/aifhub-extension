#!/usr/bin/env node
// context-dedup.mjs - optional session-scoped read deduplication service
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { readCurrentChangePointer } from './active-change-resolver.mjs';

export const CONTEXT_DEDUP_SCHEMA_VERSION = 1;

export const PROTECTED_READ_PATTERNS = [
  'openspec/specs/**',
  '.ai-factory/rules/generated/**',
  '.ai-factory/qa/**',
  '**/aif-gate-result*',
  '**/coverage.json',
  '**/done-readiness.json'
];

const DEFAULT_CONFIG_PATH = path.join('.ai-factory', 'config.yaml');
const DEDUP_STATE_DIR = path.join('.ai-factory', 'state', 'context-dedup');
const LEDGER_FILE = 'ledger.json';
const DEFAULT_SESSION_ID = 'default';
const BYTES_PER_TOKEN_ESTIMATE = 4;

export function defaultContextDedupPolicy() {
  return {
    enabled: false,
    minBytes: 2048,
    maxEntries: 500,
    protectedPatterns: [...PROTECTED_READ_PATTERNS],
    diagnostics: []
  };
}

export function resolveContextDedupPolicy(configOrRaw, options = {}) {
  const defaults = defaultContextDedupPolicy();
  const raw = extractContextDedupConfig(configOrRaw);
  const diagnostics = [];

  const enabled = normalizeBoolean('enabled', raw.enabled, defaults.enabled, diagnostics);
  const minBytes = normalizeInteger('minBytes', raw.minBytes, defaults.minBytes, diagnostics);
  const maxEntries = normalizeInteger('maxEntries', raw.maxEntries, defaults.maxEntries, diagnostics);
  const extraPatterns = normalizeStringList('protectedPatterns', raw.protectedPatterns, diagnostics);

  for (const key of Object.keys(raw)) {
    if (!['enabled', 'minBytes', 'maxEntries', 'protectedPatterns'].includes(key)) {
      diagnostics.push({
        code: 'context-dedup-unknown-key',
        severity: 'warning',
        message: `Unknown aifhub.contextDedup key: ${key}`
      });
    }
  }

  return {
    enabled,
    minBytes,
    maxEntries,
    protectedPatterns: [...defaults.protectedPatterns, ...extraPatterns],
    diagnostics,
    configPath: options.configPath ?? null
  };
}

export async function readContextDedupPolicy(options = {}) {
  const rootDir = resolveRootDir(options);
  const configPath = path.resolve(rootDir, options.configPath ?? DEFAULT_CONFIG_PATH);

  try {
    const raw = await readFile(configPath, 'utf8');
    return resolveContextDedupPolicy(raw, { configPath });
  } catch (err) {
    const policy = defaultContextDedupPolicy();
    if (err?.code === 'ENOENT') {
      return { ...policy, configPath };
    }

    return {
      ...policy,
      configPath,
      diagnostics: [
        {
          code: 'context-dedup-config-unreadable',
          severity: 'warning',
          message: `Context dedup config could not be read: ${configPath}`,
          detail: err?.message ?? String(err)
        }
      ]
    };
  }
}

export function hashContent(content) {
  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(String(content ?? ''), 'utf8');
  return `sha256:${createHash('sha256').update(buffer).digest('hex')}`;
}

export function isProtectedReadPath(filePath, policy) {
  const patterns = policy?.protectedPatterns ?? PROTECTED_READ_PATTERNS;
  const normalized = toPosix(filePath);
  return patterns.some((pattern) => matchesGlob(normalized, toPosix(pattern)));
}

export async function resolveSessionId(options = {}) {
  const explicit = firstNonEmpty(options.sessionId, options.env?.AIFHUB_SESSION_ID, process.env.AIFHUB_SESSION_ID);
  if (explicit) {
    return sanitizeSessionId(explicit);
  }

  const pointer = await readCurrentChangePointer({ rootDir: resolveRootDir(options) });
  if (pointer) {
    return sanitizeSessionId(pointer);
  }

  return DEFAULT_SESSION_ID;
}

export function resolveLedgerPath(sessionId, options = {}) {
  return path.join(resolveRootDir(options), DEDUP_STATE_DIR, sanitizeSessionId(sessionId), LEDGER_FILE);
}

export function createLedger(sessionId) {
  const now = new Date().toISOString();
  return {
    schemaVersion: CONTEXT_DEDUP_SCHEMA_VERSION,
    sessionId: sanitizeSessionId(sessionId),
    createdAt: now,
    updatedAt: now,
    entries: {},
    totals: { reads: 0, dedupHits: 0, savedBytes: 0, estimatedSavedTokens: 0 }
  };
}

export async function loadLedger(options = {}) {
  const sessionId = await resolveSessionId(options);
  const ledgerPath = resolveLedgerPath(sessionId, options);

  try {
    const parsed = JSON.parse(await readFile(ledgerPath, 'utf8'));
    if (!isPlainObject(parsed) || !isPlainObject(parsed.entries)) {
      throw new Error('Ledger payload is not a context dedup ledger object.');
    }

    return {
      ledger: { ...createLedger(sessionId), ...parsed, sessionId },
      ledgerPath,
      warnings: []
    };
  } catch (err) {
    if (err?.code === 'ENOENT') {
      return { ledger: createLedger(sessionId), ledgerPath, warnings: [] };
    }

    return {
      ledger: createLedger(sessionId),
      ledgerPath,
      warnings: [
        {
          code: 'context-dedup-ledger-unreadable',
          severity: 'warning',
          message: `Context dedup ledger was reset because it could not be read: ${ledgerPath}`,
          detail: err?.message ?? String(err)
        }
      ]
    };
  }
}

export async function saveLedger(ledger, options = {}) {
  const sessionId = sanitizeSessionId(ledger?.sessionId ?? (await resolveSessionId(options)));
  const ledgerPath = options.ledgerPath ?? resolveLedgerPath(sessionId, options);
  const payload = { ...ledger, sessionId, updatedAt: new Date().toISOString() };
  const tmpPath = `${ledgerPath}.${process.pid}.tmp`;

  await mkdir(path.dirname(ledgerPath), { recursive: true });
  await writeFile(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  await rename(tmpPath, ledgerPath);

  return { ledgerPath, ledger: payload };
}

export async function recordRead(options = {}) {
  const rootDir = resolveRootDir(options);
  const policy = options.policy ?? (await readContextDedupPolicy({ rootDir, configPath: options.configPath }));
  const relativePath = toPosix(path.isAbsolute(options.filePath ?? '')
    ? path.relative(rootDir, options.filePath)
    : options.filePath ?? '');

  if (!relativePath) {
    throw new Error('filePath must be a non-empty path');
  }

  const content = options.content ?? await readFile(path.resolve(rootDir, relativePath), 'utf8');
  const bytes = Buffer.byteLength(content, 'utf8');
  const digest = hashContent(content);

  if (!policy.enabled) {
    return decision('disabled', 'Context dedup is disabled in aifhub.contextDedup.', { relativePath, digest, bytes, content });
  }

  if (isProtectedReadPath(relativePath, policy)) {
    return decision('protected', 'Protected validation artifacts are never deduplicated.', { relativePath, digest, bytes, content });
  }

  if (bytes < policy.minBytes) {
    return decision('below-threshold', `Content is smaller than minBytes (${policy.minBytes}).`, { relativePath, digest, bytes, content });
  }

  const { ledger, ledgerPath, warnings } = await loadLedger({ ...options, rootDir });
  const existing = ledger.entries[relativePath] ?? null;
  const now = new Date().toISOString();
  const force = options.force === true;
  const deduplicated = Boolean(existing) && existing.digest === digest && !force;

  ledger.totals.reads += 1;
  if (deduplicated) {
    ledger.totals.dedupHits += 1;
    ledger.totals.savedBytes += bytes;
    ledger.totals.estimatedSavedTokens = estimateTokens(ledger.totals.savedBytes);
  }

  ledger.entries[relativePath] = {
    digest,
    bytes,
    firstSeenAt: existing?.firstSeenAt ?? now,
    lastSeenAt: now,
    readCount: (existing?.readCount ?? 0) + 1,
    revisions: existing ? existing.revisions + (existing.digest === digest ? 0 : 1) : 1
  };

  evictOldestEntries(ledger, policy.maxEntries, relativePath);

  let persisted = true;
  try {
    await saveLedger(ledger, { ...options, rootDir, ledgerPath });
  } catch (error) {
    persisted = false;
    warnings.push({ code: 'context-dedup-ledger-unwritable', message: error.message });
  }

  const entry = ledger.entries[relativePath];

  if (deduplicated && persisted) {
    return {
      ...decision('deduplicated', 'Identical content was already provided in this session.', {
        relativePath,
        digest,
        bytes,
        content: null
      }),
      firstSeenAt: entry.firstSeenAt,
      readCount: entry.readCount,
      savedBytes: bytes,
      estimatedSavedTokens: estimateTokens(bytes),
      replay: { text: formatReplay(relativePath, entry, digest), digest },
      warnings
    };
  }

  const reason = !persisted
    ? 'Ledger could not be persisted; serving full content.'
    : existing
      ? 'Content changed since the previous read in this session.'
      : 'First read of this path in this session.';

  return {
    ...decision(existing && persisted ? 'changed' : 'full', reason, { relativePath, digest, bytes, content }),
    firstSeenAt: entry.firstSeenAt,
    readCount: entry.readCount,
    previousDigest: existing?.digest ?? null,
    warnings
  };
}

export async function summarizeSession(options = {}) {
  const { ledger, ledgerPath, warnings } = await loadLedger(options);
  const totals = ledger.totals ?? { reads: 0, dedupHits: 0, savedBytes: 0, estimatedSavedTokens: 0 };
  const trackedBytes = Object.values(ledger.entries).reduce((sum, entry) => sum + (entry.bytes ?? 0), 0);
  const servedBytes = trackedBytes + totals.savedBytes;

  return {
    sessionId: ledger.sessionId,
    ledgerPath,
    reads: totals.reads,
    dedupHits: totals.dedupHits,
    trackedPaths: Object.keys(ledger.entries).length,
    savedBytes: totals.savedBytes,
    estimatedSavedTokens: estimateTokens(totals.savedBytes),
    estimateBasis: `${BYTES_PER_TOKEN_ESTIMATE} bytes per token`,
    savedPercent: servedBytes > 0 ? Number(((totals.savedBytes / servedBytes) * 100).toFixed(2)) : 0,
    warnings
  };
}

export async function purgeSession(options = {}) {
  const rootDir = resolveRootDir(options);

  if (options.all === true) {
    const dedupDir = path.join(rootDir, DEDUP_STATE_DIR);
    await rm(dedupDir, { recursive: true, force: true });
    return { all: true, removed: [toPosix(path.relative(rootDir, dedupDir))] };
  }

  const sessionId = await resolveSessionId(options);
  const sessionDir = assertInsideDedupDir(path.dirname(resolveLedgerPath(sessionId, { rootDir })), rootDir);
  await rm(sessionDir, { recursive: true, force: true });

  return { all: false, sessionId, removed: [toPosix(path.relative(rootDir, sessionDir))] };
}

function decision(kind, reason, { relativePath, digest, bytes, content }) {
  return {
    decision: kind,
    reason,
    path: relativePath,
    digest,
    bytes,
    content: content ?? null,
    savedBytes: 0,
    estimatedSavedTokens: 0,
    replay: null,
    warnings: []
  };
}

function formatReplay(relativePath, entry, digest) {
  return [
    `[aifhub-context-dedup] ${relativePath} was already provided in this session.`,
    `digest ${digest} (unchanged), ${entry.bytes} bytes, first read ${entry.firstSeenAt}, read #${entry.readCount}.`,
    'Reuse the earlier content from this session. Force a full re-read with:',
    `  ai-factory aifhub-context-dedup check --file ${relativePath} --force`
  ].join('\n');
}

function evictOldestEntries(ledger, maxEntries, keepPath = null) {
  const entries = Object.entries(ledger.entries);
  if (entries.length <= maxEntries) {
    return;
  }

  entries
    .filter(([key]) => key !== keepPath)
    .sort((left, right) => String(left[1].lastSeenAt).localeCompare(String(right[1].lastSeenAt)))
    .slice(0, entries.length - maxEntries)
    .forEach(([key]) => {
      delete ledger.entries[key];
    });
}

function estimateTokens(bytes) {
  return Math.ceil((bytes ?? 0) / BYTES_PER_TOKEN_ESTIMATE);
}

function extractContextDedupConfig(configOrRaw) {
  if (typeof configOrRaw === 'string') {
    return parseSimpleYaml(configOrRaw).aifhub?.contextDedup ?? {};
  }

  if (!isPlainObject(configOrRaw)) {
    return {};
  }

  if (typeof configOrRaw.raw === 'string') {
    return parseSimpleYaml(configOrRaw.raw).aifhub?.contextDedup ?? {};
  }

  if (isPlainObject(configOrRaw.aifhub?.contextDedup)) {
    return configOrRaw.aifhub.contextDedup;
  }

  if (isPlainObject(configOrRaw.contextDedup)) {
    return configOrRaw.contextDedup;
  }

  return configOrRaw;
}

function normalizeBoolean(key, value, fallback, diagnostics) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;

  diagnostics.push(malformed(key, value, 'boolean'));
  return fallback;
}

function normalizeInteger(key, value, fallback, diagnostics) {
  if (value === undefined || value === null) return fallback;
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
  if (Number.isInteger(parsed) && parsed >= 0) return parsed;

  diagnostics.push(malformed(key, value, 'non-negative integer'));
  return fallback;
}

function normalizeStringList(key, value, diagnostics) {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim());
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '[]' || trimmed === '') return [];
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      return trimmed
        .slice(1, -1)
        .split(',')
        .map((item) => item.trim().replace(/^['"]|['"]$/g, ''))
        .filter(Boolean);
    }
  }

  diagnostics.push(malformed(key, value, 'array of strings'));
  return [];
}

function malformed(key, value, expected) {
  return {
    code: 'context-dedup-malformed-value',
    severity: 'warning',
    message: `aifhub.contextDedup.${key} must be a ${expected}; received ${JSON.stringify(value)}. Default was used.`
  };
}

function matchesGlob(value, pattern) {
  let expression = '';

  for (let index = 0; index < pattern.length;) {
    if (pattern.startsWith('**/', index)) {
      expression += '(?:.*/)?';
      index += 3;
    } else if (pattern.startsWith('**', index)) {
      expression += '.*';
      index += 2;
    } else if (pattern[index] === '*') {
      expression += '[^/]*';
      index += 1;
    } else {
      expression += escapeRegExp(pattern[index]);
      index += 1;
    }
  }

  return new RegExp(`^${expression}$`).test(value);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sanitizeSessionId(value) {
  const normalized = String(value ?? '').trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!normalized || /^\.+$/.test(normalized)) {
    return DEFAULT_SESSION_ID;
  }
  return normalized;
}

function assertInsideDedupDir(targetDir, rootDir) {
  const dedupDir = path.resolve(rootDir, DEDUP_STATE_DIR);
  const resolved = path.resolve(targetDir);
  if (resolved !== dedupDir && !resolved.startsWith(`${dedupDir}${path.sep}`)) {
    throw new Error(`Refusing to operate outside ${DEDUP_STATE_DIR}: ${resolved}`);
  }
  return resolved;
}

function firstNonEmpty(...values) {
  return values.find((value) => typeof value === 'string' && value.trim().length > 0) ?? null;
}

function resolveRootDir(options = {}) {
  return path.resolve(options.rootDir ?? options.cwd ?? process.cwd());
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function toPosix(value) {
  return String(value ?? '').split(path.sep).join('/');
}

function parseSimpleYaml(raw) {
  const root = {};
  const stack = [{ indent: -1, value: root }];

  for (const rawLine of String(raw ?? '').split(/\r?\n/)) {
    if (!rawLine.trim() || rawLine.trimStart().startsWith('#')) {
      continue;
    }

    const match = rawLine.match(/^(\s*)([A-Za-z0-9_-]+):(?:\s*(.*?))?\s*$/);
    if (!match) {
      continue;
    }

    const indent = match[1].length;
    const key = match[2];
    const rawValue = match[3] ?? '';

    while (stack.length > 1 && indent <= stack.at(-1).indent) {
      stack.pop();
    }

    const parent = stack.at(-1).value;

    if (rawValue.length === 0) {
      parent[key] = {};
      stack.push({ indent, value: parent[key] });
    } else {
      parent[key] = parseScalar(rawValue);
    }
  }

  return root;
}

function parseScalar(rawValue) {
  const value = rawValue.trim().replace(/^['"]|['"]$/g, '');
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^-?\d+$/.test(value)) return Number.parseInt(value, 10);
  return value;
}

function parseArgs(argv) {
  const [command = 'status', ...rest] = argv;
  const options = { command, json: false, force: false, all: false };

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === '--json') options.json = true;
    else if (arg === '--force') options.force = true;
    else if (arg === '--all') options.all = true;
    else if (arg === '--file') options.filePath = rest[++index];
    else if (arg === '--session') options.sessionId = rest[++index];
    else if (arg === '--root') options.rootDir = rest[++index];
    else if (arg === '--help' || arg === '-h') options.help = true;
  }

  return options;
}

function usage() {
  return [
    'Usage: node scripts/context-dedup.mjs <command> [options]',
    '',
    'Commands:',
    '  check --file <path>   Decide whether the file content must be provided in full.',
    '  status                Show session dedup totals.',
    '  purge                 Remove ledger state for the session, or --all sessions.',
    '',
    'Options:',
    '  --session <id>        Session id. Defaults to AIFHUB_SESSION_ID, then the current change pointer.',
    '  --root <dir>          Project root. Defaults to the current directory.',
    '  --force               Treat the read as a full read even when the digest is unchanged.',
    '  --all                 Purge every session ledger.',
    '  --json                Emit machine-readable JSON.'
  ].join('\n');
}

function writeDiagnostics(stderr, diagnostics) {
  for (const diagnostic of diagnostics ?? []) {
    stderr.write(`[aifhub-context-dedup] ${diagnostic.code}: ${diagnostic.message}\n`);
  }
}

export async function main(argv = process.argv.slice(2), io = {}) {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const options = parseArgs(argv);

  if (options.help) {
    stdout.write(`${usage()}\n`);
    return 0;
  }

  try {
    if (options.command === 'check') {
      if (!options.filePath) {
        stderr.write('check requires --file <path>\n');
        return 1;
      }

      const policy = await readContextDedupPolicy(options);
      writeDiagnostics(stderr, policy.diagnostics);

      const result = await recordRead({ ...options, policy });
      writeDiagnostics(stderr, result.warnings);
      if (options.json) {
        stdout.write(`${JSON.stringify({ ...result, content: undefined }, null, 2)}\n`);
      } else {
        stdout.write(`${result.decision === 'deduplicated' ? result.replay.text : result.content}\n`);
      }
      return 0;
    }

    if (options.command === 'status') {
      const summary = await summarizeSession(options);
      writeDiagnostics(stderr, summary.warnings);
      stdout.write(options.json
        ? `${JSON.stringify(summary, null, 2)}\n`
        : `session ${summary.sessionId}: ${summary.dedupHits}/${summary.reads} deduplicated reads, ${summary.savedBytes} bytes saved (~${summary.estimatedSavedTokens} tokens, ${summary.savedPercent}%)\n`);
      return 0;
    }

    if (options.command === 'purge') {
      const result = await purgeSession(options);
      stdout.write(options.json
        ? `${JSON.stringify(result, null, 2)}\n`
        : `removed ${result.removed.join(', ')}\n`);
      return 0;
    }

    stderr.write(`${usage()}\n`);
    return 1;
  } catch (err) {
    stderr.write(`[aifhub-context-dedup] ${err?.message ?? String(err)}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
