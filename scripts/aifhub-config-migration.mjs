import { randomUUID } from 'node:crypto';
import { lstat, open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';

import { parseProjectConfig } from './aif-artifact-sync.mjs';
import { digest, readProviderFile, safeProviderPath } from './provider-files.mjs';
import { parseToolConfig, TOOL_IDS } from './tool-config.mjs';

const CONFIG_PATH = '.ai-factory/config.yaml';
const CONFIG_LIMIT = 256 * 1024;
const MIGRATION = 'artifact-protocol-to-tools-v1';
const MARKER_KEY = 'aifhub.artifactProtocol';

export async function migrateConfig({ rootDir = process.cwd(), revision, beforeReplace } = {}) {
  let target;
  let bytes;
  try {
    target = await safeProviderPath(rootDir, CONFIG_PATH);
    bytes = await readProviderFile(rootDir, CONFIG_PATH, CONFIG_LIMIT);
  } catch {
    return outcome('blocked', 'config-unreadable');
  }

  let proposal;
  try {
    if (bytes !== null) proposal = prepareMigration(bytes);
  } catch {
    return outcome('blocked', 'invalid-config');
  }
  if (!proposal) return revision
    ? outcome('blocked', 'stale-preview')
    : outcome('noop', 'no-legacy-marker');
  if (proposal.code) return outcome('blocked', proposal.code);

  const { nextBytes, changed_keys, paths } = proposal;
  const project = path.dirname(path.dirname(target.path));
  const currentRevision = digest(JSON.stringify([project, CONFIG_PATH, MIGRATION, digest(bytes), digest(nextBytes)]));
  if (revision === undefined) {
    return { ...outcome('ready', 'preview-ready'), revision_sha256: currentRevision, changed_keys, paths };
  }
  if (revision !== currentRevision) return outcome('blocked', 'stale-preview');

  const code = await replaceConfig(project, target.path, bytes, nextBytes, beforeReplace);
  if (code) return outcome('blocked', code);
  return { ...outcome('applied', 'config-migrated'), changed_keys, paths };
}

function prepareMigration(bytes) {
  const raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  if (/\u0000|\r(?!\n)/.test(raw)) throw new Error('invalid document');
  const selection = parseToolConfig(raw);
  const lines = raw.replace(/^\uFEFF/, '').split(/(?<=\n)/);
  const hubStart = lines.findIndex((line) => /^aifhub:/.test(line));
  if (hubStart < 0) return null;
  const hubEnd = lines.findIndex((line, index) => index > hubStart && /^[^\s#]/.test(line));
  const markers = lines.slice(hubStart + 1, hubEnd < 0 ? undefined : hubEnd)
    .map((line, index) => ({ line, index: hubStart + 1 + index }))
    .filter(({ line }) => /^\s+artifactProtocol\s*:/.test(line));
  if (!markers.length) return null;
  if (markers.length !== 1) return { code: 'invalid-legacy-marker' };
  const [{ line, index }] = markers;
  const match = line.match(/^  artifactProtocol:[ ]*(['"]?)(openspec|ai-factory)\1(?:[ ]+(#[^\r\n]*))?[ ]*(\r?\n)?$/);
  if (!match) return { code: 'invalid-legacy-marker' };
  const [, , legacyMode, comment, terminator = ''] = match;
  if (legacyMode !== selection.mode) return { code: 'conflicting-modes' };

  const before = parseProjectConfig(raw);
  const beforePaths = inspectPaths(raw, before);
  if (!beforePaths) return { code: 'invalid-paths' };

  const replacement = comment ? ['  ' + comment] : [];
  if (!selection.explicit) {
    replacement.push('  tools:', ...TOOL_IDS.map((id) => '    ' + id + ': ' + before.tools[id]));
  }
  const lineEnding = terminator || raw.match(/\r?\n/)?.[0] || '\n';
  lines[index] = replacement.length ? replacement.join(lineEnding) + terminator : '';
  const nextRaw = (raw.startsWith('\uFEFF') ? '\uFEFF' : '') + lines.join('');
  const nextBytes = Buffer.from(nextRaw);
  if (nextBytes.length > CONFIG_LIMIT) return { code: 'config-limit' };

  const after = parseProjectConfig(nextRaw);
  const paths = inspectPaths(nextRaw, after);
  if (!paths) return { code: 'invalid-paths' };
  if (after.marker !== before.marker || TOOL_IDS.some((id) => after.tools[id] !== before.tools[id])) {
    return { code: 'effective-tools-changed' };
  }
  if (paths.plans !== beforePaths.plans || paths.specs !== beforePaths.specs) {
    return { code: 'effective-paths-changed' };
  }

  return {
    nextBytes,
    changed_keys: selection.explicit ? [MARKER_KEY] : [MARKER_KEY, ...TOOL_IDS.map((id) => 'aifhub.tools.' + id)],
    paths
  };
}

function inspectPaths(raw, config) {
  const lines = raw.replace(/^\uFEFF/, '').split(/\r?\n/).filter((line) => line.trim() && !line.trimStart().startsWith('#'));
  const starts = lines.flatMap((line, index) => /^(?:paths|['"]paths['"])\s*:/.test(line) ? [index] : []);
  const declared = new Map();
  if (starts.length > 1) return null;
  if (starts.length) {
    const [start] = starts;
    const end = lines.findIndex((line, index) => index > start && /^\S/.test(line));
    const body = lines.slice(start + 1, end < 0 ? undefined : end);
    if (!/^paths:[ ]*$/.test(lines[start])) return null;
    const indent = body[0]?.match(/^ +/)?.[0].length;
    for (const line of body) {
      if (/\t/.test(line) || /^\s*(?:<<|['"])/.test(line)) return null;
      const match = line.match(/^( +)(plans|specs)\s*:[ ]*([^#]*?)[ ]*(?:\s+#.*)?$/);
      if (!match) {
        if (/^\s*(?:plans|specs)\s*:/.test(line)) return null;
        continue;
      }
      const [, spaces, key, scalar] = match;
      const value = scalar.replace(/^(['"])(.*)\1$/, '$2');
      if (spaces.length !== indent || declared.has(key) || !portablePath(value) || value !== config.parsed.paths?.[key]) {
        return null;
      }
      declared.set(key, value);
    }
  }

  const defaults = config.marker === 'openspec'
    ? { plans: 'openspec/changes', specs: 'openspec/specs' }
    : { plans: '.ai-factory/plans', specs: '.ai-factory/specs' };
  const result = {};
  for (const key of ['plans', 'specs']) {
    const effective = config.paths[key] ?? defaults[key];
    if (!portablePath(effective) || (config.parsed.paths?.[key] !== undefined && !declared.has(key))) return null;
    result[key] = effective;
  }
  return result;
}

function portablePath(value) {
  return typeof value === 'string' && value.length <= 200
    && value.split('/').every((part) => /^[a-z0-9._-]+$/i.test(part)
      && !part.endsWith('.') && !/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part));
}

async function replaceConfig(root, targetPath, bytes, nextBytes, beforeReplace) {
  const temporary = CONFIG_PATH + '.' + randomUUID() + '.tmp';
  let tempPath;
  let tempIdentity;
  let replaced = false;
  try {
    tempPath = (await safeProviderPath(root, temporary)).path;
    const target = await lstat(targetPath);
    const directory = await lstat(path.dirname(targetPath));
    const handle = await open(tempPath, 'wx', 0o600);
    try {
      tempIdentity = await handle.stat();
      await handle.writeFile(nextBytes);
      await handle.chmod(target.mode & 0o777);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await beforeReplace?.();

    const checkedTemp = await safeProviderPath(root, temporary);
    const currentDirectory = await lstat(path.dirname(targetPath));
    const current = await lstat(targetPath);
    const currentBytes = await readProviderFile(root, CONFIG_PATH, CONFIG_LIMIT);
    if (!checkedTemp.exists || !sameFile(await lstat(tempPath), tempIdentity)
      || !sameFile(currentDirectory, directory) || !sameFile(current, target) || current.mode !== target.mode
      || !currentBytes?.equals(bytes)) return 'stale-preview';

    await rename(tempPath, targetPath);
    replaced = true;
    return null;
  } catch {
    return 'config-write-failed';
  } finally {
    if (!replaced && tempIdentity) {
      const live = await lstat(tempPath).catch(() => null);
      if (live && sameFile(live, tempIdentity)) await unlink(tempPath).catch(() => {});
    }
  }
}

function sameFile(left, right) {
  return left.ino === right.ino && left.dev === right.dev;
}

function outcome(status, code) {
  return { ok: status !== 'blocked', migration: MIGRATION, status, code };
}
