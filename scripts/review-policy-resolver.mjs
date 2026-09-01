#!/usr/bin/env node
// review-policy-resolver.mjs - canonical resolver and scaffold lifecycle for REVIEW.md
import { createHash } from 'node:crypto';
import { lstat, mkdir, open, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { TextDecoder } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { parseSimpleYaml } from './aif-artifact-sync.mjs';

export const DEFAULT_REVIEW_POLICY_FILE = 'REVIEW.md';
export const MAX_REVIEW_POLICY_BYTES = 256 * 1024;

const CONFIG_PATH = '.ai-factory/config.yaml';
const DEFAULT_MANAGED_FILES = [
  CONFIG_PATH,
  '.ai-factory/DESCRIPTION.md',
  '.ai-factory/ARCHITECTURE.md',
  '.ai-factory/ROADMAP.md',
  '.ai-factory/RESEARCH.md',
  '.ai-factory/RULES.md',
  '.ai-factory/rules/base.md',
  'AGENTS.md',
  'CLAUDE.md',
  'CONTEXT.md',
  'README.md'
];
const DEFAULT_PROTECTED_ROOTS = [
  'openspec',
  '.ai-factory/plans',
  '.ai-factory/specs',
  '.ai-factory/rules',
  '.ai-factory/state',
  '.ai-factory/qa',
  '.ai-factory/archive'
];
const MANAGED_PATH_KEYS = ['description', 'architecture', 'context', 'roadmap', 'research'];
const PROTECTED_PATH_KEYS = ['plans', 'specs', 'rules', 'state', 'qa', 'generated_rules', 'archive'];
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });
const USAGE = 'Usage: node scripts/review-policy-resolver.mjs resolve|load|scaffold [--path <project-relative.md>] [--json]';

export function normalizeReviewPolicyPath(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return unsafePath('review-policy-path-empty');
  if (raw.includes('\0')) return unsafePath('review-policy-path-invalid');
  if (raw.includes('\\')) return unsafePath('review-policy-path-not-normalized');
  if (
    path.posix.isAbsolute(raw)
    || path.win32.isAbsolute(raw)
    || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(raw)
    || raw.startsWith('//')
  ) {
    return unsafePath('review-policy-path-absolute');
  }

  const segments = raw.split('/');
  if (segments.some((segment) => !isPortableSegment(segment))) {
    return unsafePath('review-policy-path-not-normalized');
  }
  if (path.posix.normalize(raw) !== raw) {
    return unsafePath('review-policy-path-not-normalized');
  }
  if (path.posix.extname(raw).toLowerCase() !== '.md') {
    return unsafePath('review-policy-path-not-markdown');
  }

  return { ok: true, path: raw };
}

export async function resolveReviewPolicy(options = {}) {
  const root = await resolveProjectRoot(options.rootDir ?? process.cwd());
  if (!root.ok) return unsafeResult(null, root.reason);

  const configResult = options.config === undefined
    ? await readPolicyConfig(root)
    : { ok: true, config: normalizeConfig(options.config), exists: true };
  if (!configResult.ok) {
    return unreadableResult(null, configResult.reason);
  }

  const selected = selectPolicyPath(options.policyFile, configResult.config);
  if (!selected.ok) return unsafeResult(null, selected.reason);
  const normalized = normalizeReviewPolicyPath(selected.value);
  if (!normalized.ok) return unsafeResult(null, normalized.reason);

  const ownership = await canonicalizeOwnershipInventory(
    root,
    buildOwnershipInventory(configResult.config, options)
  );
  const lexicalCollision = classifyOwnershipCollision(normalized.path, ownership);
  if (lexicalCollision) return unsafeResult(normalized.path, lexicalCollision);

  const target = await inspectProjectTarget(root, normalized.path);
  if (!target.ok) return unsafeResult(normalized.path, target.reason);

  const canonicalRelative = toPosix(path.relative(root.canonicalPath, target.canonicalPath));
  const canonicalCollision = classifyOwnershipCollision(canonicalRelative, ownership);
  if (canonicalCollision) return unsafeResult(normalized.path, canonicalCollision);

  if (target.exists && await collidesWithManagedIdentity(root, target.identity, ownership.managedFiles)) {
    return unsafeResult(normalized.path, 'review-policy-managed-file-collision');
  }
  if (target.exists && target.identity.nlink > 1) {
    return unsafeResult(normalized.path, 'review-policy-hardlink-target');
  }

  return {
    ok: true,
    state: target.exists ? 'present' : 'missing',
    path: normalized.path,
    reason: null,
    absolutePath: target.absolutePath,
    canonicalPath: target.canonicalPath,
    identity: target.identity,
    configExists: configResult.exists
  };
}

export async function inspectReviewPolicy(options = {}) {
  const loaded = await loadReviewPolicy(options);
  const { content: _content, ...inspection } = loaded;
  return inspection;
}

export async function loadReviewPolicy(options = {}) {
  const resolved = await resolveReviewPolicy(options);
  if (!resolved.ok) return { ...resolved, content: null };
  if (resolved.state !== 'present') return { ...publicSafeResult(resolved), content: null };

  const loaded = await readStableUtf8File(resolved, {
    maxBytes: normalizeMaxBytes(options.maxPolicyBytes, MAX_REVIEW_POLICY_BYTES),
    readReason: 'review-policy-read-failed',
    changedReason: 'review-policy-changed-during-read',
    tooLargeReason: 'review-policy-too-large',
    encodingReason: 'review-policy-encoding-invalid'
  });
  if (!loaded.ok) return { ...unreadableResult(resolved.path, loaded.reason), content: null };

  const revalidated = await resolveReviewPolicy({ ...options, policyFile: resolved.path });
  if (
    !revalidated.ok
    || revalidated.state !== 'present'
    || revalidated.canonicalPath !== resolved.canonicalPath
    || !sameIdentity(revalidated.identity, resolved.identity)
  ) {
    return { ...unreadableResult(resolved.path, 'review-policy-changed-during-read'), content: null };
  }

  const content = loaded.content;
  if (!content.trim()) {
    return {
      ...publicSafeResult(revalidated),
      state: 'empty',
      revision: contentRevision(content),
      content: null
    };
  }
  return {
    ...publicSafeResult(revalidated),
    state: 'present',
    revision: contentRevision(content),
    content
  };
}

export async function scaffoldReviewPolicy(options = {}) {
  const initial = await resolveReviewPolicy(options);
  if (!initial.ok) return scaffoldSkipped(initial);
  if (initial.state === 'present') return scaffoldPreserved(initial);

  try {
    await mkdir(path.dirname(initial.absolutePath), { recursive: true });
  } catch {
    return scaffoldSkipped(unreadableResult(initial.path, 'review-policy-parent-create-failed'));
  }

  const prepared = await resolveReviewPolicy({ ...options, policyFile: initial.path });
  if (!prepared.ok) return scaffoldSkipped(prepared);
  if (prepared.state === 'present') return scaffoldPreserved(prepared);

  let template;
  try {
    template = options.templateContent ?? await readFile(
      options.templatePath ?? fileURLToPath(new URL('../skills/aif-analyze/references/review-policy-template.md', import.meta.url)),
      'utf8'
    );
  } catch {
    return scaffoldSkipped(unreadableResult(prepared.path, 'review-policy-template-unreadable'));
  }

  let handle;
  let openedIdentity;
  try {
    handle = await open(prepared.absolutePath, 'wx', 0o644);
    openedIdentity = fileIdentity(await handle.stat());
    const bound = await resolveReviewPolicy({ ...options, policyFile: prepared.path });
    if (!bound.ok || bound.state !== 'present' || !sameIdentity(bound.identity, openedIdentity)) {
      return scaffoldSkipped(unreadableResult(prepared.path, 'review-policy-target-changed-before-write'));
    }
    await handle.writeFile(template, 'utf8');
  } catch (error) {
    if (error?.code === 'EEXIST') {
      const raced = await resolveReviewPolicy({ ...options, policyFile: prepared.path });
      return raced.ok && raced.state === 'present'
        ? scaffoldPreserved(raced)
        : scaffoldSkipped(raced);
    }
    return scaffoldSkipped(unreadableResult(prepared.path, 'review-policy-create-failed'));
  } finally {
    await handle?.close().catch(() => undefined);
  }

  const created = await resolveReviewPolicy({ ...options, policyFile: prepared.path });
  if (!created.ok || created.state !== 'present') return scaffoldSkipped(created);
  if (openedIdentity) {
    const finalStat = await lstat(created.absolutePath).catch(() => null);
    if (!finalStat || finalStat.isSymbolicLink() || finalStat.dev.toString() !== openedIdentity.dev || finalStat.ino.toString() !== openedIdentity.ino) {
      return scaffoldSkipped(unreadableResult(created.path, 'review-policy-target-changed-during-write'));
    }
  }
  return {
    ok: true,
    state: 'created',
    policy_state: 'present',
    path: created.path,
    reason: null
  };
}

export async function runReviewPolicyCommand(argv = process.argv.slice(2), options = {}) {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    return { exitCode: 2, stdout: '', stderr: `${parsed.error}\n${USAGE}\n` };
  }

  try {
    const commandOptions = {
      ...options,
      rootDir: options.rootDir ?? process.cwd(),
      ...(parsed.policyFile === undefined ? {} : { policyFile: parsed.policyFile })
    };
    const result = parsed.command === 'resolve'
      ? await inspectReviewPolicy(commandOptions)
      : parsed.command === 'load'
        ? await loadReviewPolicy(commandOptions)
        : await scaffoldReviewPolicy(commandOptions);
    const publicResult = parsed.command === 'load'
      ? sanitizeLoadResult(result)
      : sanitizePublicResult(result);
    return {
      exitCode: 0,
      stdout: parsed.json ? `${JSON.stringify(publicResult, null, 2)}\n` : `${renderSummary(publicResult)}\n`,
      stderr: ''
    };
  } catch (error) {
    const errorCode = sanitizeErrorCode(error?.code);
    return {
      exitCode: 1,
      stdout: '',
      stderr: `Review policy resolver failed without reading or writing the configured policy.${errorCode ? ` Code: ${errorCode}.` : ''}\n`
    };
  }
}

async function readPolicyConfig(root) {
  const target = await inspectProjectTarget(root, CONFIG_PATH);
  if (!target.ok) return { ok: false, reason: 'review-policy-config-unsafe' };
  if (!target.exists) return { ok: true, exists: false, config: {} };

  const loaded = await readStableUtf8File(target, {
    maxBytes: MAX_REVIEW_POLICY_BYTES,
    readReason: 'review-policy-config-unreadable',
    changedReason: 'review-policy-config-changed-during-read',
    tooLargeReason: 'review-policy-config-too-large',
    encodingReason: 'review-policy-config-encoding-invalid'
  });
  if (!loaded.ok) return { ok: false, reason: loaded.reason };
  const revalidated = await inspectProjectTarget(root, CONFIG_PATH);
  if (!revalidated.ok || !revalidated.exists || !sameIdentity(target.identity, revalidated.identity)) {
    return { ok: false, reason: 'review-policy-config-changed-during-read' };
  }

  return { ok: true, exists: true, config: normalizeConfig(parseSimpleYaml(loaded.content)) };
}

async function readStableUtf8File(target, policy) {
  let handle;
  try {
    handle = await open(target.absolutePath, 'r');
    const before = fileIdentity(await handle.stat());
    if (!sameIdentity(before, target.identity)) return { ok: false, reason: policy.changedReason };
    if (before.size > policy.maxBytes) return { ok: false, reason: policy.tooLargeReason };

    const bytes = await readBoundedFile(handle, policy.maxBytes);
    if (bytes === null) return { ok: false, reason: policy.tooLargeReason };
    const after = fileIdentity(await handle.stat());
    if (!sameIdentity(before, after)) return { ok: false, reason: policy.changedReason };

    let content;
    try {
      content = UTF8_DECODER.decode(bytes);
    } catch {
      return { ok: false, reason: policy.encodingReason };
    }
    if (content.includes('\0')) return { ok: false, reason: policy.encodingReason };
    return { ok: true, content };
  } catch {
    return { ok: false, reason: policy.readReason };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function readBoundedFile(handle, maxBytes) {
  const buffer = Buffer.allocUnsafe(maxBytes + 1);
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  return offset > maxBytes ? null : buffer.subarray(0, offset);
}

async function resolveProjectRoot(rootDir) {
  const lexicalPath = path.resolve(rootDir);
  try {
    const [rootStat, canonicalPath] = await Promise.all([lstat(lexicalPath), realpath(lexicalPath)]);
    if (!rootStat.isDirectory()) return { ok: false, reason: 'review-policy-root-not-directory' };
    return { ok: true, lexicalPath, canonicalPath };
  } catch {
    return { ok: false, reason: 'review-policy-root-unreadable' };
  }
}

async function inspectProjectTarget(root, relativePath) {
  const segments = relativePath.split('/');
  let lexicalCurrent = root.lexicalPath;
  let canonicalCurrent = root.canonicalPath;

  for (let index = 0; index < segments.length; index += 1) {
    lexicalCurrent = path.join(lexicalCurrent, segments[index]);
    let entry;
    try {
      entry = await lstat(lexicalCurrent);
    } catch (error) {
      if (error?.code !== 'ENOENT') return { ok: false, reason: 'review-policy-path-unreadable' };
      const missing = segments.slice(index);
      const canonicalPath = path.resolve(canonicalCurrent, ...missing);
      if (!isInsideRoot(root.canonicalPath, canonicalPath)) {
        return { ok: false, reason: 'review-policy-canonical-escape' };
      }
      return {
        ok: true,
        exists: false,
        absolutePath: canonicalPath,
        canonicalPath,
        identity: null
      };
    }

    if (entry.isSymbolicLink()) {
      return { ok: false, reason: 'review-policy-linked-component' };
    }
    const last = index === segments.length - 1;
    if (!last && !entry.isDirectory()) {
      return { ok: false, reason: 'review-policy-parent-not-directory' };
    }
    if (last && !entry.isFile()) {
      return { ok: false, reason: entry.isDirectory() ? 'review-policy-target-directory' : 'review-policy-target-not-regular' };
    }

    try {
      canonicalCurrent = await realpath(lexicalCurrent);
    } catch {
      return { ok: false, reason: 'review-policy-realpath-failed' };
    }
    if (!isInsideRoot(root.canonicalPath, canonicalCurrent)) {
      return { ok: false, reason: 'review-policy-canonical-escape' };
    }

    if (last) {
      return {
        ok: true,
        exists: true,
        absolutePath: canonicalCurrent,
        canonicalPath: canonicalCurrent,
        identity: fileIdentity(entry)
      };
    }
  }

  return { ok: false, reason: 'review-policy-path-invalid' };
}

function selectPolicyPath(explicitPath, config) {
  const value = explicitPath !== undefined ? explicitPath : config.reviews?.policy_file;
  if (
    value === undefined
    || value === null
    || (typeof value === 'string' && !value.trim())
    || isEmptyMapping(value)
  ) {
    return { ok: true, value: DEFAULT_REVIEW_POLICY_FILE };
  }
  if (typeof value !== 'string') return { ok: false, reason: 'review-policy-path-invalid-type' };
  return { ok: true, value };
}

function buildOwnershipInventory(config, options) {
  const managedFiles = new Set(DEFAULT_MANAGED_FILES);
  const protectedRoots = new Set(DEFAULT_PROTECTED_ROOTS);
  const paths = config.paths ?? {};

  for (const key of MANAGED_PATH_KEYS) addOwnershipPath(managedFiles, paths[key]);
  for (const value of Object.values(config.rules ?? {})) addOwnershipPath(managedFiles, value);
  for (const key of PROTECTED_PATH_KEYS) addOwnershipPath(protectedRoots, paths[key]);
  addOwnershipPath(protectedRoots, config.aifhub?.openspec?.root);
  for (const value of options.managedFiles ?? []) addOwnershipPath(managedFiles, value);
  for (const value of options.protectedRoots ?? []) addOwnershipPath(protectedRoots, value);

  return {
    managedFiles: [...managedFiles],
    protectedRoots: [...protectedRoots]
  };
}

async function canonicalizeOwnershipInventory(root, ownership) {
  const managedFiles = new Set(ownership.managedFiles);
  const protectedRoots = new Set(ownership.protectedRoots);

  for (const managedPath of ownership.managedFiles) {
    const canonical = await canonicalizeOwnershipPath(root, managedPath);
    if (canonical) managedFiles.add(canonical);
  }
  for (const protectedRoot of ownership.protectedRoots) {
    const canonical = await canonicalizeOwnershipPath(root, protectedRoot);
    if (canonical) protectedRoots.add(canonical);
  }

  return {
    managedFiles: [...managedFiles],
    protectedRoots: [...protectedRoots]
  };
}

async function canonicalizeOwnershipPath(root, relativePath) {
  let candidate = path.resolve(root.lexicalPath, ...relativePath.split('/'));
  const missing = [];

  while (true) {
    try {
      const canonicalAncestor = await realpath(candidate);
      const canonicalPath = path.resolve(canonicalAncestor, ...missing);
      if (!isInsideRoot(root.canonicalPath, canonicalPath)) return null;
      return toPosix(path.relative(root.canonicalPath, canonicalPath));
    } catch (error) {
      if (error?.code !== 'ENOENT') return null;
      const parent = path.dirname(candidate);
      if (parent === candidate) return null;
      missing.unshift(path.basename(candidate));
      candidate = parent;
    }
  }
}

function addOwnershipPath(collection, value) {
  if (typeof value !== 'string') return;
  const normalized = normalizeOwnershipPath(value);
  if (normalized) collection.add(normalized);
}

function normalizeOwnershipPath(value) {
  const raw = String(value).trim().replace(/\/+$/g, '');
  if (!raw || raw.includes('\\') || path.posix.isAbsolute(raw) || path.win32.isAbsolute(raw)) return null;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(raw)) return null;
  const segments = raw.split('/');
  if (segments.some((segment) => !isPortableSegment(segment))) return null;
  return path.posix.normalize(raw) === raw ? raw : null;
}

function classifyOwnershipCollision(candidate, ownership) {
  for (const managed of ownership.managedFiles) {
    if (samePortablePath(candidate, managed)) return 'review-policy-managed-file-collision';
  }
  for (const root of ownership.protectedRoots) {
    if (isSameOrDescendant(candidate, root)) return 'review-policy-protected-root-collision';
  }
  return null;
}

async function collidesWithManagedIdentity(root, identity, managedFiles) {
  if (!identity) return false;
  for (const managedPath of managedFiles) {
    const target = await inspectProjectTarget(root, managedPath);
    if (target.ok && target.exists && sameIdentity(identity, target.identity)) return true;
  }
  return false;
}

function isInsideRoot(root, target) {
  const relative = path.relative(root, target);
  return relative !== ''
    && !path.isAbsolute(relative)
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`);
}

function isSameOrDescendant(candidate, root) {
  const normalizedCandidate = comparePath(candidate);
  const normalizedRoot = comparePath(root);
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}/`);
}

function samePortablePath(left, right) {
  return comparePath(left) === comparePath(right);
}

function comparePath(value) {
  const portable = toPosix(value).replace(/\/+$/g, '');
  // Ownership is deliberately case-insensitive on every host so a config
  // accepted on Linux cannot collide when the same repository is used on
  // Windows or a case-insensitive macOS volume.
  return portable.toLowerCase();
}

function fileIdentity(stat) {
  return {
    dev: String(stat.dev),
    ino: String(stat.ino),
    nlink: stat.nlink,
    size: stat.size,
    mtimeMs: stat.mtimeMs
  };
}

function sameIdentity(left, right) {
  return Boolean(left && right)
    && left.dev === right.dev
    && left.ino === right.ino
    && left.nlink === right.nlink
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs;
}

function contentRevision(content) {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function normalizeMaxBytes(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? Math.min(value, fallback) : fallback;
}

function sanitizeErrorCode(value) {
  return typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(value) ? value : null;
}

function isPortableSegment(segment) {
  return Boolean(segment)
    && segment !== '.'
    && segment !== '..'
    && !/[<>:"|?*\u0000-\u001f]/.test(segment)
    && !/[ .]$/.test(segment)
    && !WINDOWS_RESERVED_NAME.test(segment);
}

function normalizeConfig(config) {
  return config && typeof config === 'object' && !Array.isArray(config) ? config : {};
}

function isEmptyMapping(value) {
  return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0;
}

function unsafePath(reason) {
  return { ok: false, reason };
}

function unsafeResult(policyPath, reason) {
  return { ok: false, state: 'unsafe', path: policyPath, reason };
}

function unreadableResult(policyPath, reason) {
  return { ok: false, state: 'unreadable', path: policyPath, reason };
}

function publicSafeResult(result) {
  return {
    ok: result.ok,
    state: result.state,
    path: result.path,
    reason: result.reason
  };
}

function scaffoldSkipped(result) {
  return {
    ok: false,
    state: 'skipped',
    policy_state: result?.state ?? 'unreadable',
    path: result?.path ?? null,
    reason: result?.reason ?? 'review-policy-scaffold-failed'
  };
}

function scaffoldPreserved(result) {
  return {
    ok: true,
    state: 'preserved',
    policy_state: 'present',
    path: result.path,
    reason: null
  };
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!['resolve', 'load', 'scaffold'].includes(command)) return { ok: false, error: 'Expected resolve, load, or scaffold.' };
  const parsed = { ok: true, command, json: false, policyFile: undefined };
  for (let index = 0; index < rest.length; index += 1) {
    if (rest[index] === '--json') {
      parsed.json = true;
      continue;
    }
    if (rest[index] === '--path') {
      if (rest[index + 1] === undefined || rest[index + 1].startsWith('--')) {
        return { ok: false, error: 'Missing value for --path.' };
      }
      parsed.policyFile = rest[index + 1];
      index += 1;
      continue;
    }
    return { ok: false, error: `Unknown option: ${rest[index]}` };
  }
  return parsed;
}

function sanitizePublicResult(result) {
  const allowed = ['ok', 'state', 'policy_state', 'path', 'revision', 'reason'];
  return Object.fromEntries(allowed.filter((key) => Object.hasOwn(result, key)).map((key) => [key, result[key]]));
}

function sanitizeLoadResult(result) {
  return {
    ...sanitizePublicResult(result),
    content: result.state === 'present' && typeof result.content === 'string' ? result.content : null
  };
}

function renderSummary(result) {
  const label = result.state === 'created' || result.state === 'preserved' || result.state === 'skipped'
    ? 'Review policy scaffold'
    : 'Review policy';
  const details = [
    `${label}: ${String(result.state).toUpperCase()}`,
    `Path: ${result.path ?? '(not disclosed)'}`
  ];
  if (result.reason) details.push(`Reason: ${result.reason}`);
  return details.join('\n');
}

function toPosix(value) {
  return String(value).replaceAll('\\', '/');
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === pathToFileURL(fileURLToPath(import.meta.url)).href) {
  const command = await runReviewPolicyCommand();
  if (command.stdout) process.stdout.write(command.stdout);
  if (command.stderr) process.stderr.write(command.stderr);
  process.exitCode = command.exitCode;
}
