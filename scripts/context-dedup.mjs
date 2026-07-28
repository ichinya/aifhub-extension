#!/usr/bin/env node
// context-dedup.mjs - optional session-scoped read deduplication service
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, realpath, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { StringDecoder } from 'node:string_decoder';
import { pathToFileURL } from 'node:url';

export const CONTEXT_DEDUP_SCHEMA_VERSION = 3;

export const PROTECTED_READ_PATTERNS = [
  'openspec/specs/**',
  'openspec/changes/**',
  '.ai-factory/plans/**',
  '.ai-factory/rules/generated/**',
  '.ai-factory/qa/**',
  '**/aif-gate-result*',
  '**/coverage.json',
  '**/done-readiness.json'
];

const DEFAULT_CONFIG_PATH = path.join('.ai-factory', 'config.yaml');
const DEDUP_STATE_DIR = path.join('.ai-factory', 'state', 'context-dedup');
const LEDGER_FILE = 'ledger.json';
const BYTES_PER_TOKEN_ESTIMATE = 4;
const PROCESS_SESSION_ID = `process-${process.pid}-${randomUUID()}`;
const LOCK_RETRY_MS = 20;
const LOCK_ATTEMPTS = 500;
const LOCK_STALE_MS = 30_000;
const SQZ_TIMEOUT_MS = 15_000;
const SQZ_MAX_OUTPUT_BYTES = 1024 * 1024;
const PURGE_LOCK_ATTEMPTS = Math.ceil((SQZ_TIMEOUT_MS + 5_000) / LOCK_RETRY_MS);
const SQZ_REFERENCE_PATTERN = /^§ref:[0-9a-f]{8,64}§\s*$/iu;
const SQZ_DELTA_PATTERN = /^§delta:[0-9a-f]{8,64}§(?:\r?\n|$)/iu;
const UNSAFE_YAML_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function defaultContextDedupPolicy() {
  return {
    mode: 'off',
    enabled: false,
    minBytes: 2048,
    maxEntries: 500,
    sqz: {
      command: 'sqz'
    },
    protectedPatterns: [...PROTECTED_READ_PATTERNS],
    stateDir: toPosix(DEDUP_STATE_DIR),
    diagnostics: []
  };
}

export function resolveContextDedupPolicy(configOrRaw, options = {}) {
  const defaults = defaultContextDedupPolicy();
  const parsedConfig = extractParsedConfig(configOrRaw);
  const raw = extractContextDedupConfig(parsedConfig);
  const diagnostics = [];

  const legacyEnabled = normalizeOptionalBoolean('enabled', raw.enabled, diagnostics);
  const mode = normalizeMode(raw.mode, legacyEnabled, diagnostics);
  const minBytes = normalizeInteger('minBytes', raw.minBytes, defaults.minBytes, diagnostics);
  const maxEntries = normalizeInteger('maxEntries', raw.maxEntries, defaults.maxEntries, diagnostics);
  const extraPatterns = normalizeStringList('protectedPatterns', raw.protectedPatterns, diagnostics);
  const sqz = normalizeSqzConfig(raw.sqz, defaults.sqz, diagnostics);

  for (const key of Object.keys(raw)) {
    if (!['mode', 'enabled', 'minBytes', 'maxEntries', 'protectedPatterns', 'sqz'].includes(key)) {
      diagnostics.push({
        code: 'context-dedup-unknown-key',
        severity: 'warning',
        message: `Unknown aifhub.contextDedup key: ${key}`
      });
    }
  }

  if (mode === 'sqz') {
    diagnostics.push({
      code: 'context-dedup-sqz-external-tool',
      severity: 'warning',
      message: 'SQZ mode requires a separately installed user-owned sqz executable; AIFHub does not download it, run sqz init, install hooks, or mutate agent config.'
    });
  }

  return {
    mode,
    enabled: mode !== 'off',
    minBytes,
    maxEntries,
    sqz,
    protectedPatterns: unique([
      ...defaults.protectedPatterns,
      ...deriveProtectedPatterns(parsedConfig, diagnostics),
      ...extraPatterns
    ]),
    stateDir: deriveStateDir(parsedConfig, diagnostics),
    diagnostics,
    configPath: options.configPath ?? null
  };
}

export async function readContextDedupPolicy(options = {}) {
  const rootDir = resolveRootDir(options);
  const configPath = path.resolve(rootDir, options.configPath ?? DEFAULT_CONFIG_PATH);

  try {
    const raw = await readFile(configPath, 'utf8');
    return canonicalizePolicyProtectedPatterns(
      resolveContextDedupPolicy(raw, { configPath }),
      rootDir
    );
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
  const normalized = toPosix(filePath).toLowerCase();
  return patterns.some((pattern) => matchesGlob(normalized, toPosix(pattern).toLowerCase()));
}

export async function resolveSessionId(options = {}) {
  const env = options.env ?? process.env;
  const explicit = firstNonEmpty(
    options.sessionId,
    env.AIFHUB_SESSION_ID,
    env.CODEX_THREAD_ID,
    env.CLAUDE_SESSION_ID
  );
  if (explicit) {
    return normalizeSessionId(explicit);
  }

  return PROCESS_SESSION_ID;
}

export function resolveLedgerPath(sessionId, options = {}) {
  const stateDir = resolveDedupStateDir(options);
  return path.join(resolveRootDir(options), stateDir, sessionStorageKey(sessionId), LEDGER_FILE);
}

export function createLedger(sessionId) {
  const now = new Date().toISOString();
  return {
    schemaVersion: CONTEXT_DEDUP_SCHEMA_VERSION,
    sessionId: normalizeSessionId(sessionId),
    createdAt: now,
    updatedAt: now,
    entries: Object.create(null),
    totals: {
      reads: 0,
      dedupHits: 0,
      observedBytes: 0,
      servedBytes: 0,
      savedBytes: 0,
      estimatedSavedTokens: 0
    }
  };
}

export async function loadLedger(options = {}) {
  const sessionId = await resolveSessionId(options);
  await assertSafeStateDir(resolveRootDir(options), resolveDedupStateDir(options));
  const ledgerPath = resolveLedgerPath(sessionId, { ...options, policy: options.policy });

  try {
    const parsed = JSON.parse(await readFile(ledgerPath, 'utf8'));
    return {
      ledger: normalizeLedger(parsed, sessionId),
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
  const sessionId = normalizeSessionId(ledger?.sessionId ?? (await resolveSessionId(options)));
  await assertSafeStateDir(resolveRootDir(options), resolveDedupStateDir(options));
  const ledgerPath = options.ledgerPath ?? resolveLedgerPath(sessionId, options);
  const payload = { ...ledger, sessionId, updatedAt: new Date().toISOString() };
  const tmpPath = `${ledgerPath}.${process.pid}.${randomUUID()}.tmp`;

  await mkdir(path.dirname(ledgerPath), { recursive: true });
  try {
    await writeFile(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    await rename(tmpPath, ledgerPath);
  } finally {
    await rm(tmpPath, { force: true }).catch(() => {});
  }

  return { ledgerPath, ledger: payload };
}

export async function recordRead(options = {}) {
  const rootDir = resolveRootDir(options);
  const policy = options.policy ?? (await readContextDedupPolicy({ rootDir, configPath: options.configPath }));
  const target = await resolveCanonicalTarget(rootDir, options.filePath);
  const relativePath = target.relativePath;
  const content = options.content ?? await readFile(target.absolutePath, 'utf8');
  const bytes = Buffer.byteLength(content, 'utf8');
  const digest = hashContent(content);
  debugFix(options, 'read-observed', { path: relativePath, bytes });

  if (!policy.enabled) {
    return decision('disabled', 'Context dedup is disabled in aifhub.contextDedup.', { relativePath, digest, bytes, content });
  }

  if (isProtectedReadPath(relativePath, policy)) {
    return decision('protected', 'Protected validation artifacts are never deduplicated.', { relativePath, digest, bytes, content });
  }

  if (bytes < policy.minBytes) {
    return decision('below-threshold', `Content is smaller than minBytes (${policy.minBytes}).`, { relativePath, digest, bytes, content });
  }

  if (policy.maxEntries === 0) {
    return decision('full', 'maxEntries is zero; no content is retained for deduplication.', {
      relativePath,
      digest,
      bytes,
      content
    });
  }

  const sessionId = await resolveSessionId(options);
  const stateDir = resolveDedupStateDir({ ...options, policy });
  await assertSafeStateDir(rootDir, stateDir);
  const ledgerPath = resolveLedgerPath(sessionId, { ...options, rootDir, policy });
  let sessionLock;
  try {
    sessionLock = await acquireSessionTransactionLock(rootDir, stateDir, ledgerPath);
  } catch (error) {
    return {
      ...decision('full', 'Ledger lock could not be acquired; serving full content.', {
        relativePath,
        digest,
        bytes,
        content
      }),
      warnings: [{ code: 'context-dedup-ledger-unwritable', severity: 'warning', message: error.message }]
    };
  }

  try {
    const { ledger, warnings } = await loadLedger({ ...options, rootDir, policy, sessionId });
    const existing = ledger.entries[relativePath] ?? null;
    const now = new Date().toISOString();
    const force = options.force === true;

    if (policy.mode === 'sqz') {
      return await recordSqzRead({
        ...options,
        rootDir,
        policy,
        sessionId,
        ledgerPath,
        ledger,
        warnings,
        existing,
        now,
        force,
        relativePath,
        content,
        bytes,
        digest
      });
    }

    const sameDigest = Boolean(existing) && existing.digest === digest && !force;
    const entry = {
      digest,
      bytes,
      firstSeenAt: existing?.firstSeenAt ?? now,
      lastSeenAt: now,
      readCount: (existing?.readCount ?? 0) + 1,
      revisions: existing ? existing.revisions + (existing.digest === digest ? 0 : 1) : 1
    };
    const replay = sameDigest ? formatReplay(relativePath, digest) : null;
    const replayBytes = replay ? Buffer.byteLength(replay.text, 'utf8') : 0;
    const deduplicated = sameDigest && replayBytes < bytes;
    const netSavedBytes = deduplicated ? bytes - replayBytes : 0;

    ledger.totals.reads += 1;
    ledger.totals.observedBytes += bytes;
    if (deduplicated) {
      ledger.totals.dedupHits += 1;
      ledger.totals.servedBytes += replayBytes;
      ledger.totals.savedBytes += netSavedBytes;
      ledger.totals.estimatedSavedTokens = estimateTokens(ledger.totals.savedBytes);
    } else {
      ledger.totals.servedBytes += bytes;
    }

    ledger.entries[relativePath] = entry;
    evictOldestEntries(ledger, policy.maxEntries, relativePath);

    try {
      const persistLedger = options.saveLedgerFn ?? options.persistLedger ?? saveLedger;
      await persistLedger(ledger, { ...options, rootDir, policy, ledgerPath });
    } catch (error) {
      debugFix(options, 'ledger-persist-failed', { path: relativePath, message: error.message });
      return {
        ...decision('full', 'Ledger could not be persisted; serving full content.', {
          relativePath,
          digest,
          bytes,
          content
        }),
        firstSeenAt: existing?.firstSeenAt ?? now,
        readCount: (existing?.readCount ?? 0) + 1,
        previousDigest: existing?.digest ?? null,
        warnings: [
          ...warnings,
          { code: 'context-dedup-ledger-unwritable', severity: 'warning', message: error.message }
        ]
      };
    }

    if (deduplicated) {
      debugFix(options, 'read-deduplicated', {
        path: relativePath,
        inputBytes: bytes,
        outputBytes: replayBytes,
        savedBytes: netSavedBytes
      });
      return {
        ...decision('deduplicated', 'Identical content was already provided in this session.', {
          relativePath,
          digest,
          bytes,
          content: null
        }),
        firstSeenAt: entry.firstSeenAt,
        readCount: entry.readCount,
        replayBytes,
        savedBytes: netSavedBytes,
        estimatedSavedTokens: estimateTokens(netSavedBytes),
        replay,
        warnings
      };
    }

    if (sameDigest) {
      debugFix(options, 'replay-not-beneficial', {
        path: relativePath,
        inputBytes: bytes,
        outputBytes: bytes,
        candidateReplayBytes: replayBytes,
        savedBytes: 0
      });
      return {
        ...decision('full', 'Dedup replay would not reduce the model-visible payload; serving full content.', {
          relativePath,
          digest,
          bytes,
          content
        }),
        firstSeenAt: entry.firstSeenAt,
        readCount: entry.readCount,
        previousDigest: existing?.digest ?? null,
        warnings
      };
    }

    return {
      ...decision(existing ? 'changed' : 'full', existing
        ? 'Content changed since the previous read in this session.'
        : 'First read of this path in this session.', {
        relativePath,
        digest,
        bytes,
        content
      }),
      firstSeenAt: entry.firstSeenAt,
      readCount: entry.readCount,
      previousDigest: existing?.digest ?? null,
      warnings
    };
  } finally {
    await releaseLedgerLock(sessionLock);
  }
}

export async function summarizeSession(options = {}) {
  const rootDir = resolveRootDir(options);
  const policy = options.policy ?? (await readContextDedupPolicy({ rootDir, configPath: options.configPath }));
  const { ledger, ledgerPath, warnings } = await loadLedger({ ...options, rootDir, policy });
  const totals = ledger.totals;

  return {
    mode: policy.mode,
    sessionId: ledger.sessionId,
    ledgerPath: toPosix(path.relative(resolveRootDir(options), ledgerPath)),
    reads: totals.reads,
    dedupHits: totals.dedupHits,
    trackedPaths: Object.keys(ledger.entries).length,
    observedBytes: totals.observedBytes,
    servedBytes: totals.servedBytes,
    savedBytes: totals.savedBytes,
    estimatedSavedTokens: estimateTokens(totals.savedBytes),
    estimateBasis: `${BYTES_PER_TOKEN_ESTIMATE} bytes per token`,
    savedPercent: totals.observedBytes > 0
      ? Number(((totals.savedBytes / totals.observedBytes) * 100).toFixed(2))
      : 0,
    warnings
  };
}

async function recordSqzRead(context) {
  const {
    rootDir,
    policy,
    sessionId,
    ledgerPath,
    ledger,
    warnings,
    existing,
    now,
    force,
    relativePath,
    content,
    bytes,
    digest
  } = context;

  let outcome = {
    ok: true,
    kind: 'full',
    content,
    bytes,
    warning: null
  };
  const sameDigest = Boolean(existing) && existing.digest === digest && !force;
  const replay = sameDigest ? formatReplay(relativePath, digest, { provider: 'sqz' }) : null;
  const replayBytes = replay ? Buffer.byteLength(replay.text, 'utf8') : 0;
  const useSessionReplay = sameDigest && replayBytes < bytes;

  if (useSessionReplay) {
    outcome = {
      ok: true,
      kind: 'reference',
      content: replay.text,
      bytes: replayBytes,
      warning: null
    };
  } else if (!force) {
    const sqzHome = assertInsideDedupDir(
      path.join(path.dirname(ledgerPath), 'sqz'),
      rootDir,
      resolveDedupStateDir({ ...context, policy })
    );
    await mkdir(sqzHome, { recursive: true });
    debugFix(context, 'sqz-start', { path: relativePath, inputBytes: bytes, mode: 'sqz' });

    const runner = context.sqzRunner ?? runSqzCompression;
    const sqzEnv = buildSqzEnv(context.env ?? process.env, sqzHome);
    const result = await runner({
      command: policy.sqz.command,
      content,
      cwd: rootDir,
      homeDir: sqzHome,
      env: sqzEnv,
      timeoutMs: context.sqzTimeoutMs ?? SQZ_TIMEOUT_MS,
      maxOutputBytes: context.sqzMaxOutputBytes ?? SQZ_MAX_OUTPUT_BYTES
    });

    outcome = classifySqzResult(result, content);
    debugFix(context, outcome.ok ? 'sqz-outcome' : 'sqz-failed', {
      path: relativePath,
      outcome: outcome.kind,
      inputBytes: bytes,
      outputBytes: outcome.bytes,
      code: outcome.warning?.code ?? null
    });
  }

  const servedContent = outcome.ok && outcome.bytes < bytes ? outcome.content : content;
  const servedBytes = Buffer.byteLength(servedContent, 'utf8');
  const savedBytes = Math.max(0, bytes - servedBytes);
  const decisionKind = savedBytes === 0
    ? 'full'
    : outcome.kind === 'reference'
      ? 'deduplicated'
      : outcome.kind;
  const entry = {
    digest,
    bytes,
    firstSeenAt: existing?.firstSeenAt ?? now,
    lastSeenAt: now,
    readCount: (existing?.readCount ?? 0) + 1,
    revisions: existing ? existing.revisions + (existing.digest === digest ? 0 : 1) : 1,
    provider: 'sqz',
    providerOutcome: decisionKind
  };

  ledger.totals.reads += 1;
  ledger.totals.observedBytes += bytes;
  ledger.totals.servedBytes += servedBytes;
  ledger.totals.savedBytes += savedBytes;
  if (decisionKind === 'deduplicated') {
    ledger.totals.dedupHits += 1;
  }
  ledger.totals.estimatedSavedTokens = estimateTokens(ledger.totals.savedBytes);
  ledger.entries[relativePath] = entry;
  evictOldestEntries(ledger, policy.maxEntries, relativePath);

  try {
    const persistLedger = context.saveLedgerFn ?? context.persistLedger ?? saveLedger;
    await persistLedger(ledger, { ...context, rootDir, policy, sessionId, ledgerPath });
  } catch (error) {
    debugFix(context, 'ledger-persist-failed', { path: relativePath, message: error.message });
    const sqzHome = assertInsideDedupDir(
      path.join(path.dirname(ledgerPath), 'sqz'),
      rootDir,
      resolveDedupStateDir({ ...context, policy })
    );
    await rm(sqzHome, { recursive: true, force: true }).catch(() => {});
    return {
      ...decision('full', 'Ledger could not be persisted after SQZ execution; serving full content.', {
        relativePath,
        digest,
        bytes,
        content
      }),
      provider: 'sqz',
      firstSeenAt: entry.firstSeenAt,
      readCount: entry.readCount,
      previousDigest: existing?.digest ?? null,
      warnings: [
        ...warnings,
        { code: 'context-dedup-ledger-unwritable', severity: 'warning', message: error.message }
      ]
    };
  }

  const providerWarnings = outcome.warning ? [...warnings, outcome.warning] : warnings;
  return {
    ...decision(
      decisionKind,
      sqzDecisionReason(decisionKind, force, outcome),
      {
        relativePath,
        digest,
        bytes,
        content: decisionKind === 'deduplicated' ? null : servedContent
      }
    ),
    provider: 'sqz',
    providerOutcome: outcome.kind,
    firstSeenAt: entry.firstSeenAt,
    readCount: entry.readCount,
    previousDigest: existing?.digest ?? null,
    outputBytes: servedBytes,
    savedBytes,
    estimatedSavedTokens: estimateTokens(savedBytes),
    replay: decisionKind === 'deduplicated' ? replay : null,
    replayBytes: decisionKind === 'deduplicated' ? replayBytes : 0,
    warnings: providerWarnings
  };
}

function sqzDecisionReason(kind, force, outcome) {
  if (force) return 'Forced full read bypassed SQZ.';
  if (!outcome.ok) return 'SQZ was unavailable or failed; serving full content.';
  if (kind === 'full') return 'SQZ output did not reduce the model-visible payload; serving full content.';
  if (kind === 'deduplicated') return 'AIFHub recognized identical content already served through SQZ in this session.';
  return 'SQZ returned a shorter compressed payload.';
}

function classifySqzResult(result, originalContent) {
  const originalBytes = Buffer.byteLength(originalContent, 'utf8');
  if (!result?.ok) {
    return {
      ok: false,
      kind: 'full',
      content: originalContent,
      bytes: originalBytes,
      warning: {
        code: result?.code === 'timeout'
          ? 'context-dedup-sqz-timeout'
          : result?.code === 'output-limit'
            ? 'context-dedup-sqz-output-limit'
            : 'context-dedup-sqz-unavailable',
        severity: 'warning',
        message: 'SQZ could not produce a bounded response; full content was served.'
      }
    };
  }

  const output = typeof result.stdout === 'string' ? result.stdout : '';
  const outputBytes = Buffer.byteLength(output, 'utf8');
  if (outputBytes === 0) {
    return {
      ok: false,
      kind: 'full',
      content: originalContent,
      bytes: originalBytes,
      warning: {
        code: 'context-dedup-sqz-invalid-output',
        severity: 'warning',
        message: 'SQZ returned an empty response; full content was served.'
      }
    };
  }

  if (SQZ_REFERENCE_PATTERN.test(output) || SQZ_DELTA_PATTERN.test(output)) {
    return {
      ok: false,
      kind: 'full',
      content: originalContent,
      bytes: originalBytes,
      warning: {
        code: 'context-dedup-sqz-stateful-output',
        severity: 'warning',
        message: 'SQZ returned state-dependent output despite cache bypass; full content was served.'
      }
    };
  }

  return {
    ok: true,
    kind: outputBytes < originalBytes ? 'compressed' : 'full',
    content: output,
    bytes: outputBytes,
    warning: null
  };
}

export async function runSqzCompression(options = {}) {
  const command = typeof options.command === 'string' && options.command.trim()
    ? options.command.trim()
    : 'sqz';
  const content = String(options.content ?? '');
  const maxOutputBytes = options.maxOutputBytes ?? SQZ_MAX_OUTPUT_BYTES;
  const timeoutMs = options.timeoutMs ?? SQZ_TIMEOUT_MS;
  const env = buildSqzEnv(options.env ?? process.env, options.homeDir);
  const spawnFn = options.spawnFn ?? spawn;

  return new Promise((resolve) => {
    let child;
    try {
      child = spawnFn(command, ['compress', '--no-cache'], {
        cwd: options.cwd ?? process.cwd(),
        env,
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe']
      });
    } catch {
      resolve({ ok: false, code: 'spawn-error', stdout: '' });
      return;
    }

    let stdout = '';
    let stdoutBytes = 0;
    const stdoutDecoder = new StringDecoder('utf8');
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish({ ok: false, code: 'timeout', stdout: '' });
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxOutputBytes) {
        child.kill('SIGTERM');
        finish({ ok: false, code: 'output-limit', stdout: '' });
        return;
      }
      stdout += stdoutDecoder.write(chunk);
    });
    child.stderr.on('data', () => {});
    child.on('error', () => finish({ ok: false, code: 'spawn-error', stdout: '' }));
    child.on('close', (code) => {
      if (settled) return;
      const decodedStdout = code === 0 ? `${stdout}${stdoutDecoder.end()}` : '';
      finish({
        ok: code === 0,
        code: code === 0 ? 'ok' : 'exit-error',
        stdout: decodedStdout
      });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(content);
  });
}

function buildSqzEnv(baseEnv, homeDir) {
  const env = {};
  for (const [key, value] of Object.entries(baseEnv ?? {})) {
    if (/^(?:PATH|PATHEXT|SYSTEMROOT|WINDIR|TEMP|TMP|TMPDIR|LANG|LC_ALL|LC_CTYPE)$/iu.test(key)) {
      env[key] = value;
    }
  }

  if (homeDir) {
    env.HOME = homeDir;
    env.USERPROFILE = homeDir;
    env.XDG_CACHE_HOME = path.join(homeDir, 'cache');
    env.XDG_CONFIG_HOME = path.join(homeDir, 'config');
    env.XDG_DATA_HOME = path.join(homeDir, 'data');
    env.SQZ_HOME = homeDir;
  }
  return env;
}

export async function purgeSession(options = {}) {
  const rootDir = resolveRootDir(options);
  const policy = options.policy ?? (await readContextDedupPolicy({ rootDir, configPath: options.configPath }));
  const stateDir = resolveDedupStateDir({ ...options, policy });
  await assertSafeStateDir(rootDir, stateDir);

  if (options.all === true) {
    const dedupDir = path.join(rootDir, stateDir);
    const globalLock = await acquireLedgerLock(resolveGlobalLockPath(rootDir, stateDir), rootDir);
    try {
      await waitForActiveSessionLocks(rootDir, stateDir);
      await rm(dedupDir, { recursive: true, force: true });
      return { all: true, removed: [toPosix(path.relative(rootDir, dedupDir))] };
    } finally {
      await releaseLedgerLock(globalLock);
    }
  }

  const sessionId = await resolveSessionId(options);
  const ledgerPath = resolveLedgerPath(sessionId, { ...options, rootDir, policy });
  const sessionDir = assertInsideDedupDir(
    path.dirname(ledgerPath),
    rootDir,
    stateDir
  );
  const sessionLock = await acquireLedgerLock(resolveSessionLockPath(ledgerPath), rootDir);
  try {
    await rm(sessionDir, { recursive: true, force: true });
    return { all: false, sessionId, removed: [toPosix(path.relative(rootDir, sessionDir))] };
  } finally {
    await releaseLedgerLock(sessionLock);
  }
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

function formatReplay(relativePath, digest, options = {}) {
  const shortDigest = digest.startsWith('sha256:') ? digest.slice(0, 23) : digest.slice(0, 16);
  const contextDescription = options.provider === 'sqz'
    ? 'was already provided as a self-contained compressed payload in this session'
    : 'was already provided in this session';
  return {
    text: `[aifhub-context-dedup] ${relativePath} ${contextDescription} (${shortDigest}, unchanged); reuse that earlier session context. Use force=true for a full read.`,
    digest,
    forceRead: { path: relativePath, force: true }
  };
}

function evictOldestEntries(ledger, maxEntries, keepPath = null) {
  const entries = Object.entries(ledger.entries);
  if (entries.length <= maxEntries) {
    return;
  }

  entries
    .filter(([key]) => key !== keepPath)
    .sort((left, right) => {
      const timestampOrder = String(left[1].lastSeenAt).localeCompare(String(right[1].lastSeenAt));
      return timestampOrder || left[0].localeCompare(right[0]);
    })
    .slice(0, entries.length - maxEntries)
    .forEach(([key]) => {
      delete ledger.entries[key];
    });
}

function estimateTokens(bytes) {
  return Math.ceil((bytes ?? 0) / BYTES_PER_TOKEN_ESTIMATE);
}

function extractParsedConfig(configOrRaw) {
  if (typeof configOrRaw === 'string') {
    return parseSimpleYaml(configOrRaw);
  }
  if (isPlainObject(configOrRaw?.raw)) {
    return configOrRaw.raw;
  }
  if (typeof configOrRaw?.raw === 'string') {
    return parseSimpleYaml(configOrRaw.raw);
  }
  return isPlainObject(configOrRaw) ? configOrRaw : {};
}

function extractContextDedupConfig(configOrRaw) {
  if (!isPlainObject(configOrRaw)) {
    return {};
  }

  if (isPlainObject(configOrRaw.aifhub)) {
    return isPlainObject(configOrRaw.aifhub.contextDedup) ? configOrRaw.aifhub.contextDedup : {};
  }

  if (isPlainObject(configOrRaw.contextDedup)) {
    return configOrRaw.contextDedup;
  }

  const policyKeys = new Set(['mode', 'enabled', 'minBytes', 'maxEntries', 'protectedPatterns', 'sqz']);
  return Object.keys(configOrRaw).every((key) => policyKeys.has(key)) ? configOrRaw : {};
}

function deriveProtectedPatterns(config, diagnostics) {
  const aifhub = isPlainObject(config?.aifhub) ? config.aifhub : {};
  const paths = isPlainObject(config?.paths)
    ? config.paths
    : isPlainObject(aifhub.paths)
      ? aifhub.paths
      : {};
  const openspec = isPlainObject(aifhub.openspec) ? aifhub.openspec : {};
  const openspecRoot = normalizeProjectRelativeDir(openspec.root, 'openspec', diagnostics, 'aifhub.openspec.root');
  const defaults = {
    plans: aifhub.artifactProtocol === 'openspec' ? `${openspecRoot}/changes` : '.ai-factory/plans',
    specs: `${openspecRoot}/specs`,
    qa: '.ai-factory/qa',
    generated_rules: '.ai-factory/rules/generated',
    state: '.ai-factory/state'
  };
  const plans = normalizeProjectRelativeDir(paths.plans, defaults.plans, diagnostics, 'paths.plans');
  const specs = normalizeProjectRelativeDir(paths.specs, defaults.specs, diagnostics, 'paths.specs');
  const qa = normalizeProjectRelativeDir(paths.qa, defaults.qa, diagnostics, 'paths.qa');
  const generated = normalizeProjectRelativeDir(
    paths.generated_rules,
    defaults.generated_rules,
    diagnostics,
    'paths.generated_rules'
  );
  const state = normalizeProjectRelativeDir(paths.state, defaults.state, diagnostics, 'paths.state');
  return [
    `${plans}/**`,
    `${specs}/**`,
    `${qa}/**`,
    `${generated}/**`,
    `${state}/**`
  ];
}

function deriveStateDir(config, diagnostics) {
  const paths = isPlainObject(config?.paths)
    ? config.paths
    : isPlainObject(config?.aifhub?.paths)
      ? config.aifhub.paths
      : {};
  const state = normalizeProjectRelativeDir(paths.state, '.ai-factory/state', diagnostics, 'paths.state');
  return `${state}/context-dedup`;
}

function normalizeProjectRelativeDir(value, fallback, diagnostics, key) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return toPosix(fallback);
  }
  const normalized = toPosix(String(value).trim()).replace(/^\.\/+/, '').replace(/\/+$/g, '');
  if (!normalized || path.isAbsolute(normalized) || /^[A-Za-z]:\//.test(normalized) || isEscapingRelativePath(normalized)) {
    diagnostics.push({
      code: 'context-dedup-unsafe-config-path',
      severity: 'warning',
      message: `${key} must be a safe project-relative directory; default was used.`
    });
    return toPosix(fallback);
  }
  return normalized;
}

async function canonicalizePolicyProtectedPatterns(policy, rootDir) {
  const canonicalRoot = await realpath(rootDir).catch(() => path.resolve(rootDir));
  const canonicalPatterns = [];

  for (const pattern of policy.protectedPatterns) {
    const normalized = toPosix(pattern);
    const wildcardIndex = normalized.search(/[*?]/);
    const prefix = (wildcardIndex === -1 ? normalized : normalized.slice(0, wildcardIndex))
      .replace(/\/+$/g, '');
    if (!prefix) continue;

    const canonicalPrefix = await realpath(path.resolve(rootDir, prefix)).catch(() => null);
    if (!canonicalPrefix) continue;
    try {
      assertPathInside(canonicalPrefix, canonicalRoot, prefix);
    } catch {
      continue;
    }

    const suffix = wildcardIndex === -1 ? '' : normalized.slice(wildcardIndex);
    const canonicalRelative = toPosix(path.relative(canonicalRoot, canonicalPrefix));
    canonicalPatterns.push(`${canonicalRelative}/${suffix}`.replace(/\/+/g, '/'));
  }

  return { ...policy, protectedPatterns: unique([...policy.protectedPatterns, ...canonicalPatterns]) };
}

async function assertSafeStateDir(rootDir, stateDir) {
  const lexicalRoot = path.resolve(rootDir);
  const lexicalState = path.resolve(lexicalRoot, stateDir);
  assertPathInside(lexicalState, lexicalRoot, stateDir);
  const canonicalRoot = await realpath(lexicalRoot).catch(() => lexicalRoot);

  let existing = lexicalState;
  while (true) {
    try {
      const canonicalExisting = await realpath(existing);
      assertPathInside(canonicalExisting, canonicalRoot, stateDir);
      return;
    } catch (error) {
      if (error?.message?.startsWith('filePath must stay inside')) throw error;
      if (error?.code !== 'ENOENT') throw error;
      const parent = path.dirname(existing);
      if (parent === existing) throw error;
      existing = parent;
    }
  }
}

export async function resolveCanonicalTarget(rootDir, filePath) {
  const rawPath = String(filePath ?? '').trim();
  if (!rawPath) {
    throw new Error('filePath must be a non-empty path');
  }

  const lexicalRoot = path.resolve(rootDir);
  const canonicalRoot = await realpath(lexicalRoot).catch(() => lexicalRoot);
  const lexicalTarget = path.isAbsolute(rawPath) ? path.resolve(rawPath) : path.resolve(lexicalRoot, rawPath);
  assertPathInside(lexicalTarget, lexicalRoot, rawPath);
  const canonicalTarget = await canonicalizeExistingAncestor(lexicalTarget);
  assertPathInside(canonicalTarget, canonicalRoot, rawPath);

  return {
    absolutePath: canonicalTarget,
    relativePath: toPosix(path.relative(canonicalRoot, canonicalTarget))
  };
}

async function canonicalizeExistingAncestor(target) {
  let candidate = target;
  const missingParts = [];

  while (true) {
    try {
      const canonicalAncestor = await realpath(candidate);
      return path.resolve(canonicalAncestor, ...missingParts);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      const parent = path.dirname(candidate);
      if (parent === candidate) throw error;
      missingParts.unshift(path.basename(candidate));
      candidate = parent;
    }
  }
}

function assertPathInside(target, root, displayPath) {
  const relative = path.relative(root, target);
  if (relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
    return;
  }
  throw new Error(`filePath must stay inside the project root: ${displayPath}`);
}

function normalizeLedger(parsed, sessionId) {
  if (!isPlainObject(parsed)
    || parsed.schemaVersion !== CONTEXT_DEDUP_SCHEMA_VERSION
    || parsed.sessionId !== normalizeSessionId(sessionId)
    || !isPlainObject(parsed.entries)
    || !isPlainObject(parsed.totals)) {
    throw new Error('Ledger payload is not a compatible context dedup ledger object.');
  }

  const ledger = createLedger(sessionId);
  ledger.createdAt = typeof parsed.createdAt === 'string' ? parsed.createdAt : ledger.createdAt;
  ledger.updatedAt = typeof parsed.updatedAt === 'string' ? parsed.updatedAt : ledger.updatedAt;

  for (const [entryPath, entry] of Object.entries(parsed.entries)) {
    if (!isPlainObject(entry)
      || typeof entry.digest !== 'string'
      || !isNonNegativeSafeInteger(entry.bytes)
      || !isNonNegativeSafeInteger(entry.readCount)
      || !isNonNegativeSafeInteger(entry.revisions)) {
      throw new Error(`Ledger entry is malformed: ${entryPath}`);
    }
    ledger.entries[entryPath] = { ...entry };
  }

  for (const key of ['reads', 'dedupHits', 'observedBytes', 'servedBytes', 'savedBytes', 'estimatedSavedTokens']) {
    if (!isNonNegativeSafeInteger(parsed.totals[key])) {
      throw new Error(`Ledger total is malformed: ${key}`);
    }
    ledger.totals[key] = parsed.totals[key];
  }
  return ledger;
}

function isNonNegativeSafeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function resolveGlobalLockPath(rootDir, stateDir) {
  return path.join(rootDir, path.dirname(stateDir), '.context-dedup-locks', 'all.lock');
}

function resolveSessionLockPath(ledgerPath) {
  const sessionDir = path.dirname(ledgerPath);
  const dedupDir = path.dirname(sessionDir);
  return path.join(path.dirname(dedupDir), '.context-dedup-locks', `${path.basename(sessionDir)}.lock`);
}

async function acquireLedgerLock(lockPath, rootDir, options = {}) {
  const lockDir = path.dirname(lockPath);
  const safeLockDir = path.relative(path.resolve(rootDir), path.resolve(lockDir));
  const attempts = options.attempts ?? LOCK_ATTEMPTS;
  await assertSafeStateDir(rootDir, safeLockDir);
  await mkdir(lockDir, { recursive: true });
  await assertSafeStateDir(rootDir, safeLockDir);

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await assertSafeStateDir(rootDir, safeLockDir);
    try {
      const handle = await open(lockPath, 'wx');
      await handle.writeFile(`${process.pid}:${randomUUID()}\n`, 'utf8');
      return { handle, lockPath, rootDir, safeLockDir };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const lockStat = await stat(lockPath).catch(() => null);
      if (lockStat && Date.now() - lockStat.mtimeMs > LOCK_STALE_MS) {
        await assertSafeStateDir(rootDir, safeLockDir);
        await unlink(lockPath).catch(() => {});
        continue;
      }
      if (attempt + 1 < attempts) {
        await delay(LOCK_RETRY_MS);
      }
    }
  }
  const error = new Error('Timed out waiting for the context dedup ledger lock.');
  error.code = 'CONTEXT_DEDUP_LOCK_TIMEOUT';
  throw error;
}

async function acquireSessionTransactionLock(rootDir, stateDir, ledgerPath) {
  const globalLockPath = resolveGlobalLockPath(rootDir, stateDir);
  const sessionLockPath = resolveSessionLockPath(ledgerPath);

  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
    let globalLock;
    try {
      globalLock = await acquireLedgerLock(globalLockPath, rootDir);
      try {
        return await acquireLedgerLock(sessionLockPath, rootDir, { attempts: 1 });
      } catch (error) {
        if (error?.code !== 'CONTEXT_DEDUP_LOCK_TIMEOUT') throw error;
      }
    } finally {
      await releaseLedgerLock(globalLock);
    }

    if (attempt + 1 < LOCK_ATTEMPTS) {
      await delay(LOCK_RETRY_MS);
    }
  }

  const error = new Error('Timed out waiting for the context dedup session lock.');
  error.code = 'CONTEXT_DEDUP_LOCK_TIMEOUT';
  throw error;
}

async function waitForActiveSessionLocks(rootDir, stateDir) {
  const lockDir = path.dirname(resolveGlobalLockPath(rootDir, stateDir));
  const entries = await readdir(lockDir, { withFileTypes: true }).catch((error) => {
    if (error?.code === 'ENOENT') return [];
    throw error;
  });

  for (const entry of entries) {
    if (!entry.isFile() || entry.name === 'all.lock' || !entry.name.endsWith('.lock')) continue;
    const sessionLock = await acquireLedgerLock(
      path.join(lockDir, entry.name),
      rootDir,
      { attempts: PURGE_LOCK_ATTEMPTS }
    );
    await releaseLedgerLock(sessionLock);
  }
}

async function releaseLedgerLock(lock) {
  if (!lock) return;
  await lock.handle.close().catch(() => {});
  try {
    await assertSafeStateDir(lock.rootDir, lock.safeLockDir);
  } catch {
    return;
  }
  await unlink(lock.lockPath).catch(() => {});
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function debugFix(options, event, fields) {
  if (options.logFix !== true && process.env.AIFHUB_CONTEXT_DEDUP_DEBUG !== '1') return;
  const logger = options.logger ?? console.error;
  logger(`[FIX:133] ${event} ${JSON.stringify(fields)}`);
}

function normalizeBoolean(key, value, fallback, diagnostics) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;

  diagnostics.push(malformed(key, value, 'boolean'));
  return fallback;
}

function normalizeOptionalBoolean(key, value, diagnostics) {
  if (value === undefined || value === null) return null;
  return normalizeBoolean(key, value, null, diagnostics);
}

function normalizeMode(value, legacyEnabled, diagnostics) {
  const legacyMode = legacyEnabled === true ? 'aifhub' : 'off';
  if (value === undefined || value === null || String(value).trim() === '') {
    return legacyMode;
  }

  const normalized = String(value).trim().toLowerCase();
  if (!['off', 'aifhub', 'sqz'].includes(normalized)) {
    diagnostics.push(malformed('mode', value, 'one of off | aifhub | sqz'));
    return legacyMode;
  }

  if (legacyEnabled !== null && (legacyEnabled === true) !== (normalized !== 'off')) {
    diagnostics.push({
      code: 'context-dedup-mode-conflict',
      severity: 'warning',
      message: `aifhub.contextDedup.mode=${normalized} overrides conflicting legacy enabled=${legacyEnabled}.`
    });
  }

  return normalized;
}

function normalizeSqzConfig(value, fallback, diagnostics) {
  if (value === undefined || value === null) return { ...fallback };
  if (!isPlainObject(value)) {
    diagnostics.push(malformed('sqz', value, 'mapping'));
    return { ...fallback };
  }

  const command = typeof value.command === 'string' && value.command.trim()
    ? value.command.trim()
    : fallback.command;
  if (value.command !== undefined && command === fallback.command && value.command !== fallback.command) {
    diagnostics.push(malformed('sqz.command', value.command, 'non-empty string'));
  }

  for (const key of Object.keys(value)) {
    if (key !== 'command') {
      diagnostics.push({
        code: 'context-dedup-unknown-key',
        severity: 'warning',
        message: `Unknown aifhub.contextDedup.sqz key: ${key}`
      });
    }
  }

  return { command };
}

function normalizeInteger(key, value, fallback, diagnostics) {
  if (value === undefined || value === null) return fallback;
  const parsed = typeof value === 'number'
    ? value
    : /^\d+$/.test(String(value).trim())
      ? Number(String(value).trim())
      : Number.NaN;
  if (Number.isSafeInteger(parsed) && parsed >= 0) return parsed;

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

function normalizeSessionId(value) {
  const normalized = String(value ?? '').trim();
  return normalized || PROCESS_SESSION_ID;
}

function sessionStorageKey(value) {
  return `session-${createHash('sha256').update(normalizeSessionId(value)).digest('hex')}`;
}

function resolveDedupStateDir(options = {}) {
  const candidate = options.stateDir ?? options.policy?.stateDir ?? DEDUP_STATE_DIR;
  const normalized = toPosix(candidate).replace(/\/+$/g, '');
  if (!normalized || path.isAbsolute(normalized) || isEscapingRelativePath(normalized)) {
    return toPosix(DEDUP_STATE_DIR);
  }
  return normalized;
}

function assertInsideDedupDir(targetDir, rootDir, stateDir = DEDUP_STATE_DIR) {
  const dedupDir = path.resolve(rootDir, stateDir);
  const resolved = path.resolve(targetDir);
  if (resolved !== dedupDir && !resolved.startsWith(`${dedupDir}${path.sep}`)) {
    throw new Error(`Refusing to operate outside ${stateDir}: ${resolved}`);
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
  const stack = [{ indent: -1, value: root, parent: null, key: null }];

  for (const rawLine of String(raw ?? '').split(/\r?\n/)) {
    if (!rawLine.trim() || rawLine.trimStart().startsWith('#')) {
      continue;
    }

    const listMatch = rawLine.match(/^(\s*)-\s+(.+?)\s*$/);
    if (listMatch) {
      const indent = listMatch[1].length;
      while (stack.length > 1 && indent <= stack.at(-1).indent) {
        stack.pop();
      }
      const holder = stack.at(-1);
      if (!Array.isArray(holder.value) && holder.parent && holder.key) {
        holder.value = [];
        holder.parent[holder.key] = holder.value;
      }
      if (Array.isArray(holder.value)) {
        holder.value.push(parseScalar(listMatch[2]));
      }
      continue;
    }

    const match = rawLine.match(/^(\s*)([A-Za-z0-9_-]+):(?:\s*(.*?))?\s*$/);
    if (!match) {
      continue;
    }

    const indent = match[1].length;
    const key = match[2];
    const rawValue = match[3] ?? '';

    if (UNSAFE_YAML_KEYS.has(key)) {
      continue;
    }

    while (stack.length > 1 && indent <= stack.at(-1).indent) {
      stack.pop();
    }

    const parent = stack.at(-1).value;

    if (rawValue.length === 0) {
      parent[key] = {};
      stack.push({ indent, value: parent[key], parent, key });
    } else {
      parent[key] = parseScalar(rawValue);
    }
  }

  return root;
}

function parseScalar(rawValue) {
  const value = stripYamlInlineComment(rawValue).trim().replace(/^['"]|['"]$/g, '');
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^-?\d+$/.test(value)) return Number.parseInt(value, 10);
  return value;
}

function stripYamlInlineComment(value) {
  let quote = null;
  for (let index = 0; index < String(value).length; index += 1) {
    const character = value[index];
    if ((character === '"' || character === "'") && value[index - 1] !== '\\') {
      quote = quote === character ? null : quote ?? character;
    }
    if (character === '#' && quote === null && (index === 0 || /\s/.test(value[index - 1]))) {
      return value.slice(0, index);
    }
  }
  return String(value);
}

function isEscapingRelativePath(value) {
  const normalized = toPosix(value);
  return normalized.split('/').some((part) => part === '..');
}

function unique(values) {
  return [...new Set(values.filter(Boolean).map((value) => toPosix(value)))];
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
    '  --session <id>        Session id. Defaults to a host session id, then a process-local nonce.',
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
        stdout.write(`${result.decision === 'deduplicated' ? result.replay?.text ?? result.content : result.content}\n`);
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
