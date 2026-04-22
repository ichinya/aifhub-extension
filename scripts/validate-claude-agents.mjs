#!/usr/bin/env node
// validate-claude-agents.mjs — validates Claude agent markdown frontmatter files
// Exit 0 = pass, 1 = fail

import { readFile, readdir, lstat } from 'node:fs/promises';
import { join, extname } from 'node:path';

const LOG_LEVEL = process.env.LOG_LEVEL || 'INFO';
const LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };

function log(level, message, details = {}) {
  if (LEVELS[level] < LEVELS[LOG_LEVEL]) return;
  const detailStr = Object.keys(details).length ? ` ${JSON.stringify(details)}` : '';
  console[level === 'DEBUG' ? 'error' : level.toLowerCase()](`[validate-claude-agents] ${level} ${message}${detailStr}`);
}

const REQUIRED_FIELDS = ['name', 'description'];

/**
 * Parse YAML frontmatter from a markdown file.
 * Returns { data: Record<string, string>, body: string } or null if no frontmatter.
 */
function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;

  const yamlBlock = match[1];
  const data = {};
  for (const line of yamlBlock.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx <= 0) continue;
    const key = trimmed.slice(0, colonIdx).trim();
    let value = trimmed.slice(colonIdx + 1).trim();
    // Strip surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    data[key] = value;
  }

  return data;
}

async function findMarkdownFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const full = join(dir, entry.name);
    const st = await lstat(full);
    if (st.isDirectory() && !st.isSymbolicLink()) {
      files.push(...await findMarkdownFiles(full));
    } else if (st.isFile() && extname(entry.name) === '.md') {
      files.push(full);
    }
  }
  return files;
}

async function validate() {
  const repoRoot = process.cwd();
  const claudeDir = join(repoRoot, 'agent-files', 'claude');
  let hasErrors = false;

  log('DEBUG', 'Scanning claude directory', { dir: claudeDir });
  let mdFiles;
  try {
    mdFiles = await findMarkdownFiles(claudeDir);
  } catch {
    log('ERROR', `Claude directory not found: ${claudeDir}`);
    return 1;
  }

  log('INFO', `Found ${mdFiles.length} markdown file(s)`);

  for (const filePath of mdFiles) {
    const relPath = filePath.slice(repoRoot.length + 1);
    log('DEBUG', 'Parsing markdown file', { file: relPath });

    let content;
    try {
      content = await readFile(filePath, 'utf-8');
    } catch (err) {
      log('ERROR', `Cannot read file: ${err.message}`, { file: relPath });
      hasErrors = true;
      continue;
    }

    const frontmatter = parseFrontmatter(content);
    if (!frontmatter) {
      log('ERROR', `Missing YAML frontmatter (--- delimiters)`, { file: relPath });
      hasErrors = true;
      continue;
    }

    log('DEBUG', 'Found frontmatter keys', { file: relPath, keys: Object.keys(frontmatter) });

    // Check required fields
    for (const field of REQUIRED_FIELDS) {
      if (!frontmatter[field]) {
        log('ERROR', `Missing required frontmatter field`, { file: relPath, field });
        hasErrors = true;
      }
    }

    // Check name matches aifhub-* namespace
    const name = frontmatter.name || '';
    if (name && !name.startsWith('aifhub-')) {
      log('WARN', `Agent name does not use aifhub-* namespace`, { file: relPath, name });
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
