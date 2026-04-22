#!/usr/bin/env node
// validate-codex-agents.mjs — validates Codex agent TOML files
// Exit 0 = pass, 1 = fail

import { readFile, readdir, lstat } from 'node:fs/promises';
import { join, extname } from 'node:path';

const LOG_LEVEL = process.env.LOG_LEVEL || 'INFO';
const LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };

function log(level, message, details = {}) {
  if (LEVELS[level] < LEVELS[LOG_LEVEL]) return;
  const detailStr = Object.keys(details).length ? ` ${JSON.stringify(details)}` : '';
  console[level === 'DEBUG' ? 'error' : level.toLowerCase()](`[validate-codex-agents] ${level} ${message}${detailStr}`);
}

const REQUIRED_FIELDS = ['name', 'description', 'developer_instructions'];
const LEGACY_FIELDS = ['prompt', 'reasoning_effort']; // without model_ prefix

/**
 * Minimal TOML key=value parser (single-line scalars).
 * Handles triple-quoted multi-line values ("""...""" and '''...''').
 * Returns Set<string> of top-level keys.
 */
function parseTomlKeys(content) {
  const keys = new Set();
  const lines = content.split('\n');
  let inTriple = false;
  let tripleDelim = '';

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (inTriple) {
      if (line.startsWith(tripleDelim)) {
        inTriple = false;
      }
      continue;
    }

    // Skip comments, empty lines, table headers
    if (!line || line.startsWith('#') || line.startsWith('[')) continue;

    const eqIdx = line.indexOf('=');
    if (eqIdx <= 0) continue;

    const key = line.slice(0, eqIdx).trim();
    if (!key || !/^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(key)) continue;

    keys.add(key);

    // Check if value starts with triple quotes
    const valuePart = line.slice(eqIdx + 1).trim();
    if (valuePart === '"""' || valuePart === "'''") {
      inTriple = true;
      tripleDelim = valuePart;
    }
  }

  return keys;
}

async function findTomlFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    // Skip hidden directories and node_modules
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const full = join(dir, entry.name);
    // Use lstat to detect symlinks and prevent infinite recursion
    const st = await lstat(full);
    if (st.isDirectory() && !st.isSymbolicLink()) {
      files.push(...await findTomlFiles(full));
    } else if (st.isFile() && extname(entry.name) === '.toml') {
      files.push(full);
    }
  }
  return files;
}

async function validate() {
  const repoRoot = process.cwd();
  const codexDir = join(repoRoot, 'agent-files', 'codex');
  let hasErrors = false;

  log('DEBUG', 'Scanning codex directory', { dir: codexDir });
  let tomlFiles;
  try {
    tomlFiles = await findTomlFiles(codexDir);
  } catch {
    log('ERROR', `Codex directory not found: ${codexDir}`);
    return 1;
  }

  log('INFO', `Found ${tomlFiles.length} TOML file(s)`);

  for (const filePath of tomlFiles) {
    const relPath = filePath.slice(repoRoot.length + 1);
    log('DEBUG', 'Parsing TOML file', { file: relPath });

    let content;
    try {
      content = await readFile(filePath, 'utf-8');
    } catch (err) {
      log('ERROR', `Cannot read file: ${err.message}`, { file: relPath });
      hasErrors = true;
      continue;
    }

    const keys = parseTomlKeys(content);
    log('DEBUG', 'Found keys', { file: relPath, keys: [...keys] });

    // Check required fields
    for (const field of REQUIRED_FIELDS) {
      if (!keys.has(field)) {
        log('ERROR', `Missing required field`, { file: relPath, field });
        hasErrors = true;
      }
    }

    // Check legacy fields
    for (const field of LEGACY_FIELDS) {
      if (keys.has(field)) {
        log('ERROR', `Legacy field detected (use model_ prefix)`, { file: relPath, field });
        hasErrors = true;
      }
    }

    // Check sandbox_mode
    if (!keys.has('sandbox_mode')) {
      log('ERROR', `Missing required field`, { file: relPath, field: 'sandbox_mode' });
      hasErrors = true;
    }

    if (!hasErrors) {
      log('INFO', `Agent OK`, { file: relPath });
    }
  }

  if (hasErrors) {
    log('ERROR', 'Validation FAILED');
    return 1;
  }

  log('INFO', 'All agent files passed');
  return 0;
}

process.exit(await validate());
