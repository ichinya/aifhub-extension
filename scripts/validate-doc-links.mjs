#!/usr/bin/env node
// validate-doc-links.mjs — validates markdown internal links and plan placeholders
// Exit 0 = pass, 1 = fail

import { readFile, readdir, lstat } from 'node:fs/promises';
import { join, dirname, resolve, relative } from 'node:path';

const LOG_LEVEL = process.env.LOG_LEVEL || 'INFO';
const LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };

function log(level, message, details = {}) {
  if (LEVELS[level] < LEVELS[LOG_LEVEL]) return;
  const detailStr = Object.keys(details).length ? ` ${JSON.stringify(details)}` : '';
  console[level === 'DEBUG' ? 'error' : level.toLowerCase()](`[validate-doc-links] ${level} ${message}${detailStr}`);
}

const SCAN_DIRS = ['docs', 'injections', 'skills'];

// Regex for markdown links: [text](path) or [text](path#fragment)
const MD_LINK_RE = /\[([^\]]*)\]\(([^)]+)\)/g;

// Empty plan placeholder patterns
const PLACEHOLDER_RES = [
  /\.ai-factory\/plans\/\.md\b/,
  /plans\/\.md\b/,
];

async function findMdFiles(dirs, root) {
  const files = [];
  for (const dir of dirs) {
    const absDir = join(root, dir);
    try {
      files.push(...await findMdFilesRecursive(absDir));
    } catch {
      log('DEBUG', `Directory not found, skipping`, { dir: absDir });
    }
  }
  return files;
}

async function findMdFilesRecursive(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    // Use lstat to detect symlinks and prevent infinite recursion
    const st = await lstat(full);
    if (st.isDirectory() && !st.isSymbolicLink()) {
      // Skip node_modules, .git, etc.
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      files.push(...await findMdFilesRecursive(full));
    } else if (st.isFile() && entry.name.endsWith('.md')) {
      files.push(full);
    }
  }
  return files;
}

async function validate() {
  const repoRoot = process.cwd();
  let hasErrors = false;

  const mdFiles = await findMdFiles(SCAN_DIRS, repoRoot);
  log('INFO', `Found ${mdFiles.length} markdown file(s) to scan`);

  for (const filePath of mdFiles) {
    const relPath = filePath.slice(repoRoot.length + 1);
    log('DEBUG', 'Scanning file', { file: relPath });

    const content = await readFile(filePath, 'utf-8');
    const fileDir = dirname(filePath);
    let linkCount = 0;

    let match;
    while ((match = MD_LINK_RE.exec(content)) !== null) {
      const [fullMatch, text, target] = match;
      linkCount++;

      // Skip external links, anchors-only, and images
      if (target.startsWith('http://') || target.startsWith('https://')) continue;
      if (target.startsWith('#')) continue;
      if (target.startsWith('mailto:')) continue;
      if (text === '!' && target.startsWith('!')) continue;

      // Check for empty plan placeholders
      for (const re of PLACEHOLDER_RES) {
        if (re.test(target)) {
          log('ERROR', 'Empty plan placeholder detected', { file: relPath, link: target });
          hasErrors = true;
        }
      }

      // Resolve the link path (strip fragment)
      const cleanTarget = target.split('#')[0];
      if (!cleanTarget) continue; // fragment-only link like (#section)

      const resolvedPath = resolve(fileDir, cleanTarget);
      const exists = await lstat(resolvedPath).then(() => true).catch(() => false);

      if (!exists) {
        log('ERROR', 'Broken link', { file: relPath, link: target, resolved: resolvedPath });
        hasErrors = true;
      } else {
        log('DEBUG', 'Link OK', { file: relPath, link: target });
      }
    }

    log('INFO', `Scanned ${linkCount} link(s)`, { file: relPath });
  }

  if (hasErrors) {
    log('ERROR', 'Validation FAILED');
    return 1;
  }

  log('INFO', 'All checks passed');
  return 0;
}

process.exit(await validate());
