#!/usr/bin/env node
// validate-extension.mjs — validates extension.json manifest paths and schema
// Exit 0 = pass, 1 = fail

import { readFile, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';

const LOG_LEVEL = process.env.LOG_LEVEL || 'INFO';
const LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };

function log(level, message, details = {}) {
  if (LEVELS[level] < LEVELS[LOG_LEVEL]) return;
  const detailStr = Object.keys(details).length ? ` ${JSON.stringify(details)}` : '';
  console[level === 'DEBUG' ? 'error' : level.toLowerCase()](`[validate-extension] ${level} ${message}${detailStr}`);
}

function resolvePath(baseDir, relPath) {
  const p = relPath.replace(/^\.\//, '');
  const resolved = resolve(baseDir, p);
  // Prevent path traversal: resolved path must stay within baseDir
  // Append path.sep to ensure exact prefix match (e.g. /foo/project vs /foo/project-evil)
  const normalizedBase = baseDir.endsWith(sep) ? baseDir : baseDir + sep;
  if (!resolved.startsWith(normalizedBase)) {
    throw new Error(`Path traversal detected: "${relPath}" resolves outside base directory`);
  }
  return resolved;
}

async function fileExists(absPath) {
  try {
    await stat(absPath);
    return true;
  } catch {
    return false;
  }
}

async function validateExtension() {
  const repoRoot = process.cwd();
  const manifestPath = join(repoRoot, 'extension.json');
  let hasErrors = false;

  // Load extension.json
  log('DEBUG', 'Reading extension.json', { path: manifestPath });
  let manifest;
  try {
    const raw = await readFile(manifestPath, 'utf-8');
    manifest = JSON.parse(raw);
  } catch (err) {
    log('ERROR', `Failed to read or parse extension.json: ${err.message}`);
    return 1;
  }

  // Check version (semver)
  log('DEBUG', 'Checking version field', { version: manifest.version });
  if (!manifest.version) {
    log('ERROR', 'Missing required field: version');
    hasErrors = true;
  } else {
    const semverRe = /^\d+\.\d+\.\d+(-[a-zA-Z0-9.]+)?(\+[a-zA-Z0-9.]+)?$/;
    if (!semverRe.test(manifest.version)) {
      log('ERROR', `Invalid semver version: "${manifest.version}"`);
      hasErrors = true;
    } else {
      log('INFO', 'Version OK', { version: manifest.version });
    }
  }

  // Check compat.ai-factory
  log('DEBUG', 'Checking compat field', { compat: manifest.compat });
  if (!manifest.compat || !manifest.compat['ai-factory']) {
    log('ERROR', 'Missing required field: compat.ai-factory');
    hasErrors = true;
  } else {
    log('INFO', 'compat.ai-factory OK', { compat: manifest.compat['ai-factory'] });
  }

  // Check skills[].path exist
  const skills = manifest.skills || [];
  log('DEBUG', `Checking ${skills.length} skill(s)`);
  for (const skillPath of skills) {
    let abs;
    try {
      abs = resolvePath(repoRoot, skillPath);
    } catch (err) {
      log('ERROR', `Skill path traversal: ${err.message}`, { path: skillPath });
      hasErrors = true;
      continue;
    }
    log('DEBUG', 'Checking skill path', { path: skillPath, resolved: abs });
    const exists = await fileExists(abs);
    if (!exists) {
      log('ERROR', `Skill path not found`, { path: skillPath, resolved: abs });
      hasErrors = true;
    }
  }
  log('INFO', `Skills check complete`, { total: skills.length });

  // Check agentFiles[].source exist and agentFiles[].target extension (.toml)
  const agentFiles = manifest.agentFiles || [];
  log('DEBUG', `Checking ${agentFiles.length} agentFile(s)`);
  for (const af of agentFiles) {
    let srcAbs;
    try {
      srcAbs = resolvePath(repoRoot, af.source);
    } catch (err) {
      log('ERROR', `agentFile source traversal: ${err.message}`, { source: af.source });
      hasErrors = true;
      continue;
    }
    log('DEBUG', 'Checking agentFile source', { source: af.source, resolved: srcAbs });
    const srcExists = await fileExists(srcAbs);
    if (!srcExists) {
      log('ERROR', `agentFile source not found`, { source: af.source, resolved: srcAbs });
      hasErrors = true;
    }

    const target = af.target || '';
    if (!target.endsWith('.toml')) {
      log('ERROR', `agentFile target must have .toml extension`, { target });
      hasErrors = true;
    }
  }
  log('INFO', `AgentFiles check complete`, { total: agentFiles.length });

  // Check injections[].file exist
  const injections = manifest.injections || [];
  log('DEBUG', `Checking ${injections.length} injection(s)`);
  for (const inj of injections) {
    let abs;
    try {
      abs = resolvePath(repoRoot, inj.file);
    } catch (err) {
      log('ERROR', `Injection file traversal: ${err.message}`, { file: inj.file });
      hasErrors = true;
      continue;
    }
    log('DEBUG', 'Checking injection file', { file: inj.file, resolved: abs });
    const exists = await fileExists(abs);
    if (!exists) {
      log('ERROR', `Injection file not found`, { file: inj.file, resolved: abs });
      hasErrors = true;
    }
  }
  log('INFO', `Injections check complete`, { total: injections.length });

  if (hasErrors) {
    log('ERROR', 'Validation FAILED');
    return 1;
  }

  log('INFO', 'All checks passed');
  return 0;
}

process.exit(await validateExtension());
