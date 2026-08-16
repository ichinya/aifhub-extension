#!/usr/bin/env node
// validate-claude-agents.mjs — validates Claude agent markdown frontmatter files
// Exit 0 = pass, 1 = fail

import { readFile, readdir, lstat } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { validateAgentInstructionContract } from './agent-instruction-contract.mjs';

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
      log('ERROR', `Agent name does not use aifhub-* namespace`, { file: relPath, name });
      hasErrors = true;
    }

    const instructionContract = validateAgentInstructionContract({
      runtime: 'claude',
      name,
      source: content
    });
    for (const contractCase of instructionContract.cases) {
      if (contractCase.ok) {
        log('INFO', 'Agent instruction contract OK', contractCase);
      }
    }
    for (const issue of instructionContract.issues) {
      log('ERROR', issue.message, issue);
      hasErrors = true;
    }

    if (!hasErrors) {
      log('INFO', `Agent OK`, { file: relPath });
    }
  }

  const manifestResult = await validateManifestTargets(repoRoot);
  if (!manifestResult.ok) {
    hasErrors = true;
  }

  if (hasErrors) {
    log('ERROR', 'Validation FAILED');
    return 1;
  }

  log('INFO', 'All agent files passed');
  return 0;
}

async function validateManifestTargets(repoRoot) {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(join(repoRoot, 'extension.json'), 'utf-8'));
  } catch (err) {
    if (err?.code === 'ENOENT') {
      log('DEBUG', 'extension.json not found; skipping manifest target validation');
      return { ok: true };
    }

    log('ERROR', `Cannot read extension.json: ${err.message}`);
    return { ok: false };
  }

  let ok = true;
  const agentFiles = Array.isArray(manifest.agentFiles) ? manifest.agentFiles : [];
  for (const [index, entry] of agentFiles.entries()) {
    if (!isClaudeMarkdownAgentFile(entry)) {
      continue;
    }

    const target = String(entry?.target ?? '').trim();
    if (!target.startsWith('aifhub-') || !target.endsWith('.md')) {
      log('ERROR', 'Claude agent target must use aifhub-*.md namespace', {
        index,
        target
      });
      ok = false;
    }
  }

  return { ok };
}

function isClaudeMarkdownAgentFile(entry) {
  const source = String(entry?.source ?? '').replace(/\\/g, '/');
  const target = String(entry?.target ?? '').replace(/\\/g, '/');
  return (source.includes('agent-files/claude/') && source.endsWith('.md'))
    || (source.endsWith('.md') && target.endsWith('.md') && entry?.runtime === 'claude');
}

process.exit(await validate());
