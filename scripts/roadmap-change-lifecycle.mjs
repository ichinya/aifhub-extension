// roadmap-change-lifecycle.mjs - bounded local OpenSpec lifecycle updates for the configured roadmap
import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import { normalizeChangeId } from './active-change-resolver.mjs';

export const ROADMAP_LIFECYCLE_START_MARKER = '<!-- aifhub:roadmap-change-lifecycle:start -->';
export const ROADMAP_LIFECYCLE_END_MARKER = '<!-- aifhub:roadmap-change-lifecycle:end -->';

const ROADMAP_HEADING = '## OpenSpec Change Lifecycle';
const TABLE_HEADER = ['Change', 'Issues', 'Milestone', 'Roadmap item/slice', 'Local state', 'Evidence'];
const TABLE_SEPARATOR = ['---', '---', '---', '---', '---', '---'];
const LINKAGE_FIELDS = ['Issues', 'Milestone', 'Roadmap item/slice', 'Rationale'];
const LOCAL_STATES = new Set(['planned', 'finalized']);
const MAX_PROPOSAL_BYTES = 512 * 1024;
const MAX_ROADMAP_BYTES = 5 * 1024 * 1024;
const MAX_ISSUES = 20;
const MAX_ISSUE_LENGTH = 300;
const MAX_MILESTONE_LENGTH = 200;
const MAX_ROADMAP_ITEM_LENGTH = 300;
const MAX_RATIONALE_LENGTH = 500;
const MAX_PROJECT_PATH_LENGTH = 512;
const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const LOG_LEVELS = new Map([
  ['error', 0],
  ['warn', 1],
  ['info', 2],
  ['debug', 3]
]);

export function parseRoadmapLinkage(proposalContent) {
  if (typeof proposalContent !== 'string' || Buffer.byteLength(proposalContent, 'utf8') > MAX_PROPOSAL_BYTES) {
    return malformedLinkage('roadmap-linkage-invalid-content');
  }

  const sections = findRoadmapLinkageSections(proposalContent);
  if (sections.length === 0) {
    return {
      ok: true,
      status: 'missing',
      reason: 'roadmap-linkage-missing',
      linkage: null
    };
  }
  if (sections.length !== 1) {
    return malformedLinkage('roadmap-linkage-duplicate-section');
  }

  const fields = new Map();
  for (const line of sections[0]) {
    if (line.trim().length === 0) {
      continue;
    }

    const match = line.match(/^\s*-\s+(Issues|Milestone|Roadmap item\/slice|Rationale):\s*(.*?)\s*$/);
    if (!match) {
      return malformedLinkage('roadmap-linkage-invalid-shape');
    }

    const [, field, value] = match;
    if (fields.has(field) || value.length === 0) {
      return malformedLinkage('roadmap-linkage-invalid-shape');
    }
    fields.set(field, value);
  }

  if (LINKAGE_FIELDS.some((field) => !fields.has(field))) {
    return malformedLinkage('roadmap-linkage-invalid-shape');
  }

  const issues = normalizeIssues(fields.get('Issues'));
  if (!issues.ok) {
    return malformedLinkage('roadmap-linkage-invalid-issues');
  }

  const milestone = normalizeOptionalText(fields.get('Milestone'), MAX_MILESTONE_LENGTH);
  if (!milestone.ok) {
    return malformedLinkage('roadmap-linkage-invalid-milestone');
  }

  const roadmapItem = normalizeOptionalText(fields.get('Roadmap item/slice'), MAX_ROADMAP_ITEM_LENGTH);
  if (!roadmapItem.ok) {
    return malformedLinkage('roadmap-linkage-invalid-item');
  }

  const rationale = normalizeOptionalText(fields.get('Rationale'), MAX_RATIONALE_LENGTH);
  if (!rationale.ok) {
    return malformedLinkage('roadmap-linkage-invalid-rationale');
  }

  const linkage = {
    issues: issues.values,
    milestone: milestone.value,
    roadmapItem: roadmapItem.value,
    rationale: rationale.value
  };
  const linked = linkage.issues.length > 0 || linkage.milestone !== null || linkage.roadmapItem !== null;

  return {
    ok: true,
    status: linked ? 'linked' : 'unlinked',
    reason: linked ? 'roadmap-linkage-found' : 'roadmap-linkage-none',
    linkage
  };
}

export async function updateRoadmapChangeLifecycle(options = {}) {
  const log = createLifecycleLogger(options);
  log('debug', 'update.start');

  const linkageResult = parseRoadmapLinkage(options.proposalContent);
  log(linkageResult.ok ? 'debug' : 'warn', 'proposal.parsed', {
    status: linkageResult.status,
    reason: linkageResult.reason
  });

  if (!linkageResult.ok) {
    return finish(log, lifecycleResult('handoff', linkageResult.reason));
  }
  if (linkageResult.status === 'missing' || linkageResult.status === 'unlinked') {
    return finish(log, lifecycleResult('skipped', linkageResult.reason));
  }

  const normalizedChange = normalizeChangeId(options.changeId);
  if (!normalizedChange.ok) {
    return finish(log, lifecycleResult('handoff', 'change-id-invalid'));
  }
  if (!LOCAL_STATES.has(options.localState)) {
    return finish(log, lifecycleResult('handoff', 'local-state-invalid'));
  }

  const rootDir = path.resolve(options.rootDir ?? process.cwd());
  const roadmapTarget = normalizeProjectRelativePath(rootDir, options.roadmapPath);
  if (!roadmapTarget.ok) {
    return finish(log, lifecycleResult('handoff', 'roadmap-path-invalid'));
  }

  const evidenceTarget = normalizeProjectRelativePath(rootDir, options.evidencePath);
  if (!evidenceTarget.ok) {
    return finish(log, lifecycleResult('handoff', 'evidence-path-invalid', roadmapTarget.relativePath));
  }

  const safePath = roadmapTarget.relativePath;
  let sourceStat;
  try {
    sourceStat = await lstat(roadmapTarget.absolutePath);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return finish(log, lifecycleResult('handoff', 'roadmap-missing', safePath));
    }
    log('warn', 'roadmap.stat.failed', { path: safePath, code: boundedErrorCode(error) });
    return finish(log, lifecycleResult('handoff', 'roadmap-read-failed', safePath));
  }

  if (sourceStat.isSymbolicLink()) {
    return finish(log, lifecycleResult('handoff', 'roadmap-path-symlink', safePath));
  }
  if (!sourceStat.isFile()) {
    return finish(log, lifecycleResult('handoff', 'roadmap-not-file', safePath));
  }

  if (!await targetRemainsWithinRoot(rootDir, roadmapTarget.absolutePath)) {
    return finish(log, lifecycleResult('handoff', 'roadmap-path-outside-root'));
  }

  let sourceBuffer;
  try {
    sourceBuffer = await readFile(roadmapTarget.absolutePath);
  } catch (error) {
    log('warn', 'roadmap.read.failed', { path: safePath, code: boundedErrorCode(error) });
    return finish(log, lifecycleResult('handoff', 'roadmap-read-failed', safePath));
  }
  log('debug', 'roadmap.read', { path: safePath, bytes: sourceBuffer.length });

  if (sourceBuffer.length > MAX_ROADMAP_BYTES) {
    return finish(log, lifecycleResult('handoff', 'roadmap-too-large', safePath));
  }

  const decoded = decodeRoadmap(sourceBuffer);
  if (!decoded.ok) {
    return finish(log, lifecycleResult('handoff', decoded.reason, safePath));
  }

  const markerState = analyzeMarkers(decoded.text);
  if (!markerState.ok) {
    return finish(log, lifecycleResult('handoff', markerState.reason, safePath));
  }

  let rows = [];
  if (markerState.present) {
    const parsedBlock = parseLifecycleBlock(decoded.text, markerState, rootDir);
    if (!parsedBlock.ok) {
      return finish(log, lifecycleResult('handoff', parsedBlock.reason, safePath));
    }
    rows = parsedBlock.rows;
  }

  const rowIndex = rows.findIndex((row) => row.changeId === normalizedChange.changeId);
  const existingRow = rowIndex === -1 ? null : rows[rowIndex];
  if (existingRow?.localState === 'finalized' && options.localState === 'planned') {
    return finish(log, lifecycleResult('skipped', 'finalized-state-preserved', safePath));
  }

  const nextRow = {
    changeId: normalizedChange.changeId,
    issues: linkageResult.linkage.issues,
    milestone: linkageResult.linkage.milestone,
    roadmapItem: linkageResult.linkage.roadmapItem,
    localState: options.localState,
    evidencePath: evidenceTarget.relativePath
  };
  if (rowIndex === -1) {
    rows.push(nextRow);
  } else {
    rows[rowIndex] = nextRow;
  }
  rows.sort(compareLifecycleRows);

  const lineEnding = detectLineEnding(decoded.text);
  const renderedBlock = renderLifecycleBlock(rows, lineEnding);
  const nextText = markerState.present
    ? replaceLifecycleBlock(decoded.text, markerState, renderedBlock)
    : appendLifecycleBlock(decoded.text, renderedBlock, lineEnding);
  const nextBuffer = encodeRoadmap(nextText, decoded.hasBom);

  if (nextBuffer.equals(sourceBuffer)) {
    return finish(log, lifecycleResult('skipped', 'lifecycle-current', safePath));
  }

  const sourceDigest = digest(sourceBuffer);
  const temporaryPath = path.join(
    path.dirname(roadmapTarget.absolutePath),
    `.${path.basename(roadmapTarget.absolutePath)}.${process.pid}.${randomUUID()}.tmp`
  );
  let replaced = false;

  try {
    await writeFile(temporaryPath, nextBuffer, { flag: 'wx', mode: sourceStat.mode });
    log('debug', 'roadmap.temporary.written', { path: safePath, bytes: nextBuffer.length });

    if (typeof options.beforeReplace === 'function') {
      await options.beforeReplace();
    }

    let currentBuffer;
    try {
      currentBuffer = await readFile(roadmapTarget.absolutePath);
    } catch (error) {
      log('warn', 'roadmap.conflict.read-failed', { path: safePath, code: boundedErrorCode(error) });
      return finish(log, lifecycleResult('handoff', 'roadmap-source-conflict', safePath));
    }

    if (digest(currentBuffer) !== sourceDigest) {
      log('warn', 'roadmap.conflict.detected', { path: safePath });
      return finish(log, lifecycleResult('handoff', 'roadmap-source-conflict', safePath));
    }

    await rename(temporaryPath, roadmapTarget.absolutePath);
    replaced = true;
    log('info', 'roadmap.replaced', { path: safePath, rows: rows.length });
    return finish(log, lifecycleResult('updated', 'lifecycle-updated', safePath));
  } catch (error) {
    log('warn', 'roadmap.write.failed', { path: safePath, code: boundedErrorCode(error) });
    return finish(log, lifecycleResult('handoff', 'roadmap-write-failed', safePath));
  } finally {
    if (!replaced) {
      await rm(temporaryPath, { force: true }).catch(() => {});
    }
  }
}

function findRoadmapLinkageSections(content) {
  const lines = content.split(/\r\n|\n|\r/);
  const sections = [];
  let fence = null;

  for (let index = 0; index < lines.length; index += 1) {
    const fenceMatch = lines[index].match(/^\s*(`{3,}|~{3,})/);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      fence = fence === marker ? null : fence ?? marker;
      continue;
    }
    if (fence !== null || !/^##(?!#)\s+Roadmap Linkage\s*$/.test(lines[index])) {
      continue;
    }

    const section = [];
    let sectionFence = null;
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const nestedFence = lines[cursor].match(/^\s*(`{3,}|~{3,})/);
      if (nestedFence) {
        const marker = nestedFence[1][0];
        sectionFence = sectionFence === marker ? null : sectionFence ?? marker;
        section.push(lines[cursor]);
        continue;
      }
      if (sectionFence === null && /^##(?!#)\s+/.test(lines[cursor])) {
        index = cursor - 1;
        break;
      }
      section.push(lines[cursor]);
      if (cursor === lines.length - 1) {
        index = cursor;
      }
    }
    sections.push(section);
  }

  return sections;
}

function normalizeIssues(value) {
  if (isNone(value)) {
    return { ok: true, values: [] };
  }
  if (!isBoundedText(value, MAX_ISSUES * MAX_ISSUE_LENGTH)) {
    return { ok: false, values: [] };
  }

  const values = value.split(',').map((entry) => entry.trim());
  if (
    values.length === 0
    || values.length > MAX_ISSUES
    || values.some((entry) => !isCanonicalWorkItemReference(entry))
  ) {
    return { ok: false, values: [] };
  }

  return {
    ok: true,
    values: [...new Set(values)].sort(compareStrings)
  };
}

function isCanonicalWorkItemReference(value) {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > MAX_ISSUE_LENGTH
    || value !== value.trim()
    || /[\u0000-\u0020\u007f]/.test(value)
  ) {
    return false;
  }

  let reference;
  try {
    reference = new URL(value);
  } catch {
    return false;
  }

  return (reference.protocol === 'https:' || reference.protocol === 'mcp:')
    && reference.hostname.length > 0
    && reference.pathname !== '/'
    && reference.username.length === 0
    && reference.password.length === 0
    && reference.search.length === 0
    && reference.hash.length === 0;
}

function normalizeOptionalText(value, maxLength) {
  if (isNone(value)) {
    return { ok: true, value: null };
  }
  return isBoundedText(value, maxLength)
    ? { ok: true, value: value.trim() }
    : { ok: false, value: null };
}

function isNone(value) {
  return typeof value === 'string' && value.trim().toLowerCase() === 'none';
}

function isBoundedText(value, maxLength) {
  return typeof value === 'string'
    && value.trim().length > 0
    && value.trim().length <= maxLength
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function malformedLinkage(reason) {
  return {
    ok: false,
    status: 'malformed',
    reason,
    linkage: null
  };
}

function normalizeProjectRelativePath(rootDir, input) {
  if (typeof input !== 'string') {
    return { ok: false };
  }

  const value = input.trim();
  if (
    value.length === 0
    || value.length > MAX_PROJECT_PATH_LENGTH
    || /[\u0000-\u001f\u007f]/.test(value)
    || path.isAbsolute(value)
    || path.win32.isAbsolute(value)
    || path.posix.isAbsolute(value)
    || /^[A-Za-z]:/.test(value)
  ) {
    return { ok: false };
  }

  const portable = value.replaceAll('\\', '/');
  const segments = portable.split('/');
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    return { ok: false };
  }

  const absolutePath = path.resolve(rootDir, ...segments);
  const relativePath = path.relative(rootDir, absolutePath);
  if (
    relativePath.length === 0
    || path.isAbsolute(relativePath)
    || relativePath === '..'
    || relativePath.startsWith(`..${path.sep}`)
  ) {
    return { ok: false };
  }

  return {
    ok: true,
    absolutePath,
    relativePath: relativePath.replaceAll('\\', '/')
  };
}

async function targetRemainsWithinRoot(rootDir, targetPath) {
  try {
    const [realRoot, realTarget] = await Promise.all([realpath(rootDir), realpath(targetPath)]);
    const relative = path.relative(realRoot, realTarget);
    return relative.length > 0
      && !path.isAbsolute(relative)
      && relative !== '..'
      && !relative.startsWith(`..${path.sep}`);
  } catch {
    return false;
  }
}

function decodeRoadmap(buffer) {
  const hasBom = buffer.subarray(0, UTF8_BOM.length).equals(UTF8_BOM);
  const body = hasBom ? buffer.subarray(UTF8_BOM.length) : buffer;
  const text = body.toString('utf8');

  if (!Buffer.from(text, 'utf8').equals(body) || text.includes('\u0000')) {
    return { ok: false, reason: 'roadmap-encoding-invalid' };
  }
  return { ok: true, text, hasBom };
}

function encodeRoadmap(text, hasBom) {
  const body = Buffer.from(text, 'utf8');
  return hasBom ? Buffer.concat([UTF8_BOM, body]) : body;
}

function analyzeMarkers(source) {
  const starts = findOccurrences(source, ROADMAP_LIFECYCLE_START_MARKER);
  const ends = findOccurrences(source, ROADMAP_LIFECYCLE_END_MARKER);

  if (starts.length === 0 && ends.length === 0) {
    return { ok: true, present: false };
  }
  if (starts.length > 1 || ends.length > 1) {
    return { ok: false, reason: 'roadmap-markers-duplicate' };
  }
  if (starts.length !== 1 || ends.length !== 1) {
    return { ok: false, reason: 'roadmap-markers-incomplete' };
  }
  if (ends[0] < starts[0]) {
    return { ok: false, reason: 'roadmap-markers-reversed' };
  }
  if (
    !isStandaloneMarker(source, starts[0], ROADMAP_LIFECYCLE_START_MARKER)
    || !isStandaloneMarker(source, ends[0], ROADMAP_LIFECYCLE_END_MARKER)
  ) {
    return { ok: false, reason: 'roadmap-markers-invalid' };
  }

  return {
    ok: true,
    present: true,
    startIndex: starts[0],
    endIndex: ends[0]
  };
}

function findOccurrences(source, token) {
  const indexes = [];
  let cursor = 0;
  while (cursor <= source.length - token.length) {
    const index = source.indexOf(token, cursor);
    if (index === -1) {
      break;
    }
    indexes.push(index);
    cursor = index + token.length;
  }
  return indexes;
}

function isStandaloneMarker(source, index, marker) {
  const before = index === 0 || source[index - 1] === '\n' || source[index - 1] === '\r';
  const afterIndex = index + marker.length;
  const after = afterIndex === source.length || source[afterIndex] === '\n' || source[afterIndex] === '\r';
  return before && after;
}

function parseLifecycleBlock(source, markerState, rootDir) {
  const innerStart = markerState.startIndex + ROADMAP_LIFECYCLE_START_MARKER.length;
  const rawInner = source.slice(innerStart, markerState.endIndex);
  const leading = rawInner.match(/^(\r\n|\n|\r)/)?.[0];
  const trailing = rawInner.match(/(\r\n|\n|\r)$/)?.[0];
  if (!leading || !trailing || rawInner.length < leading.length + trailing.length) {
    return { ok: false, reason: 'roadmap-block-malformed' };
  }

  const content = rawInner.slice(leading.length, rawInner.length - trailing.length);
  const lines = content.split(/\r\n|\n|\r/);
  if (lines.length < 4 || lines[0] !== ROADMAP_HEADING || lines[1] !== '') {
    return { ok: false, reason: 'roadmap-block-malformed' };
  }

  const header = parseTableLine(lines[2]);
  const separator = parseTableLine(lines[3]);
  if (
    !header.ok
    || !separator.ok
    || !arraysEqual(header.cells, TABLE_HEADER)
    || separator.cells.length !== TABLE_SEPARATOR.length
    || separator.cells.some((cell) => !/^:?-{3,}:?$/.test(cell))
  ) {
    return { ok: false, reason: 'roadmap-block-malformed' };
  }

  const rows = [];
  const seen = new Set();
  for (const line of lines.slice(4)) {
    if (line.length === 0) {
      return { ok: false, reason: 'roadmap-block-malformed' };
    }
    const row = parseLifecycleRow(line, rootDir);
    if (!row.ok) {
      return { ok: false, reason: 'roadmap-block-malformed' };
    }
    if (seen.has(row.value.changeId)) {
      return { ok: false, reason: 'roadmap-block-duplicate-change' };
    }
    seen.add(row.value.changeId);
    rows.push(row.value);
  }

  return { ok: true, rows };
}

function parseLifecycleRow(line, rootDir) {
  const parsed = parseTableLine(line);
  if (!parsed.ok || parsed.cells.length !== TABLE_HEADER.length) {
    return { ok: false };
  }

  const changeMatch = parsed.cells[0].match(/^`([^`]+)`$/);
  const normalizedChange = normalizeChangeId(changeMatch?.[1]);
  const issues = normalizeIssues(parsed.cells[1]);
  const milestone = normalizeOptionalText(parsed.cells[2], MAX_MILESTONE_LENGTH);
  const roadmapItem = normalizeOptionalText(parsed.cells[3], MAX_ROADMAP_ITEM_LENGTH);
  const evidence = normalizeProjectRelativePath(rootDir, parsed.cells[5]);
  if (
    !normalizedChange.ok
    || !issues.ok
    || !milestone.ok
    || !roadmapItem.ok
    || !LOCAL_STATES.has(parsed.cells[4])
    || !evidence.ok
  ) {
    return { ok: false };
  }

  return {
    ok: true,
    value: {
      changeId: normalizedChange.changeId,
      issues: issues.values,
      milestone: milestone.value,
      roadmapItem: roadmapItem.value,
      localState: parsed.cells[4],
      evidencePath: evidence.relativePath
    }
  };
}

function parseTableLine(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) {
    return { ok: false, cells: [] };
  }

  const body = trimmed.slice(1, -1);
  const cells = [];
  let current = '';
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index];
    if (character === '\\' && (body[index + 1] === '\\' || body[index + 1] === '|')) {
      current += character + body[index + 1];
      index += 1;
      continue;
    }
    if (character === '|') {
      cells.push(unescapeTableValue(current.trim()));
      current = '';
      continue;
    }
    current += character;
  }
  cells.push(unescapeTableValue(current.trim()));
  return { ok: true, cells };
}

function renderLifecycleBlock(rows, lineEnding) {
  const lines = [
    ROADMAP_LIFECYCLE_START_MARKER,
    ROADMAP_HEADING,
    '',
    renderTableLine(TABLE_HEADER),
    renderTableLine(TABLE_SEPARATOR),
    ...rows.map(renderLifecycleRow),
    ROADMAP_LIFECYCLE_END_MARKER
  ];
  return lines.join(lineEnding);
}

function renderLifecycleRow(row) {
  return renderTableLine([
    `\`${row.changeId}\``,
    row.issues.length > 0 ? row.issues.join(', ') : 'none',
    row.milestone ?? 'none',
    row.roadmapItem ?? 'none',
    row.localState,
    row.evidencePath
  ]);
}

function renderTableLine(cells) {
  return `| ${cells.map(escapeTableValue).join(' | ')} |`;
}

function escapeTableValue(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('\\', '\\\\')
    .replaceAll('|', '\\|');
}

function unescapeTableValue(value) {
  let unescaped = '';
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === '\\' && (value[index + 1] === '\\' || value[index + 1] === '|')) {
      unescaped += value[index + 1];
      index += 1;
    } else {
      unescaped += value[index];
    }
  }
  return unescaped
    .replaceAll('&gt;', '>')
    .replaceAll('&lt;', '<')
    .replaceAll('&amp;', '&');
}

function replaceLifecycleBlock(source, markerState, renderedBlock) {
  const startContent = markerState.startIndex + ROADMAP_LIFECYCLE_START_MARKER.length;
  const renderedInner = renderedBlock.slice(
    ROADMAP_LIFECYCLE_START_MARKER.length,
    renderedBlock.length - ROADMAP_LIFECYCLE_END_MARKER.length
  );
  return source.slice(0, startContent)
    + renderedInner
    + source.slice(markerState.endIndex);
}

function appendLifecycleBlock(source, renderedBlock, lineEnding) {
  if (source.length === 0) {
    return renderedBlock;
  }

  const hasFinalNewline = /(?:\r\n|\n|\r)$/.test(source);
  return hasFinalNewline
    ? `${source}${lineEnding}${renderedBlock}${lineEnding}`
    : `${source}${lineEnding}${lineEnding}${renderedBlock}`;
}

function detectLineEnding(source) {
  return source.match(/\r\n|\n|\r/)?.[0] ?? '\n';
}

function arraysEqual(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function compareLifecycleRows(left, right) {
  return compareStrings(left.changeId, right.changeId);
}

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function digest(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function lifecycleResult(status, reason, safePath = null) {
  return {
    status,
    reason,
    path: safePath,
    changed: status === 'updated',
    suggestedNext: status === 'handoff' ? '/aif-roadmap check' : null
  };
}

function finish(log, result) {
  log(result.status === 'handoff' ? 'warn' : 'info', 'update.finish', {
    status: result.status,
    reason: result.reason,
    path: result.path,
    changed: result.changed
  });
  return result;
}

function createLifecycleLogger(options) {
  const configuredLevel = String(
    options.logLevel
    ?? process.env.AIFHUB_LOG_LEVEL
    ?? process.env.LOG_LEVEL
    ?? 'silent'
  ).toLowerCase();
  const threshold = LOG_LEVELS.get(configuredLevel) ?? -1;
  const sink = typeof options.logger === 'function'
    ? options.logger
    : (entry) => console.error(JSON.stringify(entry));

  return (level, event, metadata = {}) => {
    const numericLevel = LOG_LEVELS.get(level);
    if (numericLevel === undefined || numericLevel > threshold) {
      return;
    }
    try {
      sink({
        component: 'roadmap-change-lifecycle',
        level,
        event,
        ...metadata
      });
    } catch {
      // Logging is diagnostic-only and must not change lifecycle behavior.
    }
  };
}

function boundedErrorCode(error) {
  const code = typeof error?.code === 'string' ? error.code : 'UNKNOWN';
  return /^[A-Z0-9_-]{1,40}$/.test(code) ? code : 'UNKNOWN';
}
