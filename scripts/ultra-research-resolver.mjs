// ultra-research-resolver.mjs - safe, deterministic AI Factory ultra research selection
import { createHash } from 'node:crypto';
import {
  lstat as defaultLstat,
  readFile as defaultReadFile,
  readdir as defaultReaddir,
  realpath as defaultRealpath
} from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {
  countActiveStandaloneMarker,
  maskMarkdownCode
} from './markdown-structural-markers.mjs';

export const ULTRA_RESEARCH_MARKER = '<!-- aif:research-mode:ultra -->';
export const ACTIVE_SUMMARY_START = '<!-- aif:active-summary:start -->';
export const ACTIVE_SUMMARY_END = '<!-- aif:active-summary:end -->';
export const ULTRA_RESEARCH_STATUSES = Object.freeze(['active', 'paused', 'superseded']);

export function normalizeUltraResearchActiveSummary(input) {
  const withoutComments = String(input ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/<!--[\s\S]*?-->/g, '');
  const lines = withoutComments
    .split('\n')
    .filter((line) => !/^\s*Source:\s/.test(line))
    .map((line) => line.replace(/[\t ]+$/g, ''));

  while (lines.length > 0 && lines.at(-1) === '') lines.pop();
  return `${lines.join('\n')}\n`;
}

export function digestUltraResearchActiveSummary(input) {
  const normalized = normalizeUltraResearchActiveSummary(input);
  return {
    normalized,
    sha256: createHash('sha256').update(normalized, 'utf8').digest('hex')
  };
}

export async function inspectUltraResearchBundle(options = {}) {
  const context = await createResolverContext(options);
  if (!context.ok) return context.failure;

  const normalizedBundle = normalizeProjectRelativePath(options.bundlePath, 'bundle path');
  if (!normalizedBundle.ok) {
    return createInspectionFailure(normalizedBundle.error.code, normalizedBundle.error.message, null);
  }

  return inspectBundle(context, normalizedBundle.relativePath);
}

export async function resolveUltraResearchSource(options = {}) {
  const context = await createResolverContext(options);
  if (!context.ok) return context.failure;

  const warnings = [];
  if (options.explicitResearchPath !== undefined || options.explicitPath !== undefined) {
    const explicitPath = options.explicitResearchPath ?? options.explicitPath;
    const candidate = resolveExplicitResearchPath(context, explicitPath);
    if (!candidate.ok) return createResolutionFailure(candidate.error.code, candidate.error.message, 'explicit-path');
    const inspection = await inspectBundle(context, candidate.bundlePath);
    return finishExplicitSelection(inspection, 'explicit-path');
  }

  if (options.exactSlug !== undefined || options.slug !== undefined) {
    const slug = options.exactSlug ?? options.slug;
    const normalizedSlug = normalizeUltraResearchSlug(slug);
    if (!normalizedSlug.ok) {
      return createResolutionFailure(normalizedSlug.error.code, normalizedSlug.error.message, 'exact-slug');
    }
    const bundlePath = joinProjectPath(context.bundlesRootRelative, normalizedSlug.slug);
    const inspection = await inspectBundle(context, bundlePath);
    return finishExplicitSelection(inspection, 'exact-slug');
  }

  const candidates = await discoverActiveCandidates(context, warnings);
  if (!candidates.ok) {
    return createResolutionFailure(candidates.error.code, candidates.error.message, 'implicit', warnings);
  }

  const relevant = await filterRelevantCandidates(candidates.items, options);
  if (!relevant.ok) {
    return createResolutionFailure(relevant.error.code, relevant.error.message, 'implicit', warnings);
  }

  if (relevant.items.length === 0) {
    return createResolutionFailure(
      'ultra-research-not-found',
      'No valid active ultra research bundle matched the requested scope.',
      'implicit',
      warnings,
      candidates.items.length
    );
  }

  if (relevant.items.length > 1) {
    return {
      ...createResolutionFailure(
        'ultra-research-ambiguous',
        'More than one valid active ultra research bundle matched; select an explicit RESEARCH.md path or exact slug.',
        'implicit',
        warnings,
        relevant.items.length
      ),
      candidates: relevant.items.map(({ source }) => source.path)
    };
  }

  return createSelectedResolution(relevant.items[0], 'implicit-relevant', warnings, candidates.items.length);
}

export function normalizeUltraResearchSlug(input) {
  const slug = typeof input === 'string' ? input.trim() : '';
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug === '.' || slug === '..') {
    return {
      ok: false,
      slug: null,
      error: {
        code: 'ultra-research-slug-invalid',
        message: 'Ultra research slug must be a safe lowercase ASCII kebab-case direct child.'
      }
    };
  }
  return { ok: true, slug, error: null };
}

export function deriveUltraResearchBundlesDir(input = '.ai-factory/RESEARCH.md') {
  const researchPath = normalizeProjectRelativePath(input, 'paths.research');
  if (!researchPath.ok) {
    return {
      ok: false,
      researchPath: null,
      bundlesDir: null,
      error: researchPath.error
    };
  }

  return {
    ok: true,
    researchPath: researchPath.relativePath,
    bundlesDir: joinProjectPath(projectDirname(researchPath.relativePath), 'research'),
    error: null
  };
}

async function createResolverContext(options) {
  const rootDir = path.resolve(options.rootDir ?? process.cwd());
  const researchLayout = deriveUltraResearchBundlesDir(
    options.researchPath ?? options.pathsResearch ?? '.ai-factory/RESEARCH.md'
  );
  if (!researchLayout.ok) {
    return {
      ok: false,
      failure: createResolutionFailure(researchLayout.error.code, researchLayout.error.message, null)
    };
  }

  const bundlesRootRelative = researchLayout.bundlesDir;
  const io = {
    lstat: options.lstat ?? defaultLstat,
    readFile: options.readFile ?? defaultReadFile,
    readdir: options.readdir ?? defaultReaddir,
    realpath: options.realpath ?? defaultRealpath
  };

  let projectRealPath;
  try {
    projectRealPath = await io.realpath(rootDir);
  } catch {
    return {
      ok: false,
      failure: createResolutionFailure(
        'ultra-research-project-root-invalid',
        'Project root could not be resolved.',
        null
      )
    };
  }

  return {
    ok: true,
    rootDir,
    projectRealPath,
    researchPath: researchLayout.researchPath,
    bundlesRootRelative,
    bundlesRootAbsolute: path.resolve(rootDir, fromProjectPath(bundlesRootRelative)),
    io
  };
}

function resolveExplicitResearchPath(context, input) {
  const normalized = normalizeProjectRelativePath(input, 'explicit research path');
  if (!normalized.ok) return normalized;

  const expectedPrefix = `${context.bundlesRootRelative}/`;
  const parts = normalized.relativePath.split('/');
  const rootParts = context.bundlesRootRelative === '.' ? [] : context.bundlesRootRelative.split('/');
  const slug = parts[rootParts.length];
  const expectedLength = rootParts.length + 2;
  if (
    !normalized.relativePath.startsWith(expectedPrefix)
    || parts.length !== expectedLength
    || parts.at(-1) !== 'RESEARCH.md'
    || !normalizeUltraResearchSlug(slug).ok
  ) {
    return {
      ok: false,
      error: {
        code: 'ultra-research-explicit-path-invalid',
        message: 'Explicit ultra research source must be a direct <research root>/<slug>/RESEARCH.md path.'
      }
    };
  }

  return {
    ok: true,
    bundlePath: parts.slice(0, -1).join('/'),
    error: null
  };
}

async function discoverActiveCandidates(context, warnings) {
  const rootSafety = await inspectPathSafety(context, context.bundlesRootRelative, { directory: true });
  if (!rootSafety.ok) {
    if (rootSafety.code === 'ultra-research-path-missing') return { ok: true, items: [] };
    return { ok: false, items: [], error: rootSafety.error };
  }

  let entries;
  try {
    entries = await context.io.readdir(context.bundlesRootAbsolute, { withFileTypes: true });
  } catch {
    return {
      ok: false,
      items: [],
      error: {
        code: 'ultra-research-discovery-failed',
        message: 'Ultra research bundle directory could not be enumerated.'
      }
    };
  }

  const items = [];
  for (const entry of [...entries].sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const slug = normalizeUltraResearchSlug(entry.name);
    if (!slug.ok) {
      warnings.push(createWarning('ultra-research-candidate-ignored', joinProjectPath(context.bundlesRootRelative, entry.name)));
      continue;
    }

    const inspection = await inspectBundle(context, joinProjectPath(context.bundlesRootRelative, entry.name));
    if (!inspection.ok) {
      warnings.push(createWarning(inspection.error.code, inspection.bundlePath));
      continue;
    }
    if (!inspection.active) {
      warnings.push(createWarning('ultra-research-inactive', inspection.bundlePath));
      continue;
    }
    items.push(inspection);
  }

  return { ok: true, items };
}

async function filterRelevantCandidates(candidates, options) {
  if (Array.isArray(options.relevantSlugs)) {
    const relevantSlugs = new Set(options.relevantSlugs);
    return { ok: true, items: candidates.filter(({ source }) => relevantSlugs.has(source.slug)) };
  }

  if (typeof options.isRelevant === 'function') {
    const items = [];
    try {
      for (const candidate of candidates) {
        if (await options.isRelevant(toPublicCandidate(candidate))) items.push(candidate);
      }
    } catch {
      return {
        ok: false,
        items: [],
        error: {
          code: 'ultra-research-relevance-failed',
          message: 'Ultra research relevance evaluation failed.'
        }
      };
    }
    return { ok: true, items };
  }

  return { ok: true, items: candidates };
}

async function inspectBundle(context, bundlePath) {
  const slug = bundlePath.split('/').at(-1);
  if (!normalizeUltraResearchSlug(slug).ok || projectDirname(bundlePath) !== context.bundlesRootRelative) {
    return createInspectionFailure(
      'ultra-research-bundle-path-invalid',
      'Ultra research bundle must be a safe direct child of the derived bundle root.',
      bundlePath
    );
  }

  for (const [relativePath, directory] of [
    [bundlePath, true],
    [joinProjectPath(bundlePath, 'INDEX.md'), false],
    [joinProjectPath(bundlePath, 'RESEARCH.md'), false]
  ]) {
    const safety = await inspectPathSafety(context, relativePath, { directory, confinedTo: bundlePath });
    if (!safety.ok) return createInspectionFailure(safety.error.code, safety.error.message, bundlePath);
  }

  const indexPath = joinProjectPath(bundlePath, 'INDEX.md');
  const researchPath = joinProjectPath(bundlePath, 'RESEARCH.md');
  let indexContent;
  let researchContent;
  try {
    [indexContent, researchContent] = await Promise.all([
      context.io.readFile(path.resolve(context.rootDir, fromProjectPath(indexPath)), 'utf8'),
      context.io.readFile(path.resolve(context.rootDir, fromProjectPath(researchPath)), 'utf8')
    ]);
  } catch {
    return createInspectionFailure(
      'ultra-research-read-failed',
      'Ultra research INDEX.md or RESEARCH.md could not be read.',
      bundlePath
    );
  }

  if (countActiveStandaloneMarker(indexContent, ULTRA_RESEARCH_MARKER) !== 1) {
    return createInspectionFailure(
      'ultra-research-marker-invalid',
      'INDEX.md must contain exactly one active standalone ultra research marker.',
      bundlePath
    );
  }

  const indexStatus = parseSingleMetadataValue(indexContent, 'Status');
  if (!indexStatus.ok || !ULTRA_RESEARCH_STATUSES.includes(indexStatus.value)) {
    return createInspectionFailure(
      'ultra-research-status-invalid',
      'INDEX.md must contain exactly one supported Status value.',
      bundlePath
    );
  }

  const linkValidation = await validateArtifactIndex(context, bundlePath, indexContent);
  if (!linkValidation.ok) {
    return createInspectionFailure(linkValidation.error.code, linkValidation.error.message, bundlePath);
  }

  const researchStatus = parseSingleMetadataValue(researchContent, 'Status');
  if (!researchStatus.ok || researchStatus.value !== indexStatus.value) {
    return createInspectionFailure(
      'ultra-research-status-mismatch',
      'RESEARCH.md Status must exist once and match INDEX.md.',
      bundlePath
    );
  }

  const updated = parseSingleMetadataValue(researchContent, 'Updated');
  if (!updated.ok || updated.value.length > 128) {
    return createInspectionFailure(
      'ultra-research-updated-invalid',
      'RESEARCH.md must contain exactly one bounded Updated value.',
      bundlePath
    );
  }

  const summary = extractActiveSummary(researchContent);
  if (!summary.ok) {
    return createInspectionFailure(summary.error.code, summary.error.message, bundlePath);
  }
  const digest = digestUltraResearchActiveSummary(summary.activeSummary);

  return {
    ok: true,
    active: indexStatus.value === 'active',
    status: indexStatus.value,
    bundlePath,
    source: {
      kind: 'ultra-research',
      slug,
      path: researchPath,
      bundlePath,
      indexPath,
      status: indexStatus.value
    },
    revision: {
      updated: updated.value,
      sha256: digest.sha256
    },
    content: {
      activeSummary: summary.activeSummary,
      normalizedActiveSummary: digest.normalized
    },
    artifacts: linkValidation.artifacts,
    error: null
  };
}

async function validateArtifactIndex(context, bundlePath, indexContent) {
  const maskedLines = maskMarkdownCode(indexContent).split('\n');
  const headingIndexes = [];
  for (let index = 0; index < maskedLines.length; index += 1) {
    if (maskedLines[index].trim() === '## Artifact Index') headingIndexes.push(index);
  }
  if (headingIndexes.length !== 1) {
    return createLinkFailure('ultra-research-artifact-index-invalid', 'INDEX.md must contain exactly one ## Artifact Index section.');
  }

  const start = headingIndexes[0] + 1;
  let end = maskedLines.length;
  for (let index = start; index < maskedLines.length; index += 1) {
    if (/^##\s+/.test(maskedLines[index])) {
      end = index;
      break;
    }
  }

  const section = maskedLines.slice(start, end).join('\n');
  const destinations = [];
  const linkPattern = /\[[^\]]*]\(([^)]+)\)/g;
  for (const match of section.matchAll(linkPattern)) {
    const rawDestination = match[1].trim().replace(/^<|>$/g, '');
    const destination = rawDestination.split(/\s+["']/)[0];
    const normalized = normalizeDirectArtifactLink(destination);
    if (!normalized.ok) return normalized;
    destinations.push(normalized.filename);
  }

  if (destinations.filter((filename) => filename === 'RESEARCH.md').length !== 1) {
    return createLinkFailure(
      'ultra-research-research-link-invalid',
      'Artifact Index must link direct-child RESEARCH.md exactly once.'
    );
  }

  if (new Set(destinations).size !== destinations.length) {
    return createLinkFailure(
      'ultra-research-artifact-link-duplicate',
      'Artifact Index must link each generated artifact exactly once.'
    );
  }

  for (const filename of destinations) {
    const linkedPath = joinProjectPath(bundlePath, filename);
    const safety = await inspectPathSafety(context, linkedPath, { directory: false, confinedTo: bundlePath });
    if (!safety.ok) return createLinkFailure(safety.error.code, safety.error.message);
  }

  return { ok: true, artifacts: [...new Set(destinations)], error: null };
}

function normalizeDirectArtifactLink(input) {
  const withoutDot = input.startsWith('./') ? input.slice(2) : input;
  let decoded;
  try {
    decoded = decodeURIComponent(withoutDot);
  } catch {
    return createLinkFailure('ultra-research-link-unsafe', 'Artifact Index contains an invalid encoded link.');
  }

  if (
    decoded === ''
    || decoded.includes('/')
    || decoded.includes('\\')
    || decoded === '.'
    || decoded === '..'
    || decoded.includes('?')
    || decoded.includes('#')
    || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(decoded)
    || path.isAbsolute(decoded)
    || path.win32.isAbsolute(decoded)
  ) {
    return createLinkFailure(
      'ultra-research-link-unsafe',
      'Artifact Index links must be safe relative direct-child filenames.'
    );
  }

  return { ok: true, filename: decoded, error: null };
}

function extractActiveSummary(researchContent) {
  const originalLines = String(researchContent ?? '').replace(/\r\n?/g, '\n').split('\n');
  const maskedLines = maskMarkdownCode(researchContent).split('\n');
  const starts = findStandaloneLineIndexes(maskedLines, ACTIVE_SUMMARY_START);
  const ends = findStandaloneLineIndexes(maskedLines, ACTIVE_SUMMARY_END);
  if (starts.length !== 1 || ends.length !== 1 || starts[0] >= ends[0]) {
    return {
      ok: false,
      activeSummary: null,
      error: {
        code: 'ultra-research-active-summary-invalid',
        message: 'RESEARCH.md must contain one ordered Active Summary marker pair outside Markdown code.'
      }
    };
  }

  return {
    ok: true,
    activeSummary: originalLines.slice(starts[0] + 1, ends[0]).join('\n'),
    error: null
  };
}

function parseSingleMetadataValue(content, key) {
  const pattern = new RegExp(`^${escapeRegExp(key)}:\\s*(.+?)\\s*$`, 'gm');
  const values = [...maskMarkdownCode(content).matchAll(pattern)].map((match) => match[1]);
  if (values.length !== 1 || values[0].trim() === '') return { ok: false, value: null };
  return { ok: true, value: values[0].trim() };
}

function findStandaloneLineIndexes(lines, marker) {
  const indexes = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trim() === marker) indexes.push(index);
  }
  return indexes;
}

async function inspectPathSafety(context, relativePath, options = {}) {
  const absolutePath = path.resolve(context.rootDir, fromProjectPath(relativePath));
  if (!isInsidePath(context.rootDir, absolutePath)) {
    return createSafetyFailure('ultra-research-path-escape', 'Ultra research path escapes the project root.');
  }

  let stat;
  try {
    stat = await context.io.lstat(absolutePath);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return createSafetyFailure('ultra-research-path-missing', 'Required ultra research path is missing.');
    }
    return createSafetyFailure('ultra-research-path-read-failed', 'Ultra research path metadata could not be read.');
  }

  if (stat.isSymbolicLink()) {
    return createSafetyFailure('ultra-research-symlink-rejected', 'Ultra research paths must not be symbolic links.');
  }
  if (options.directory === true && !stat.isDirectory()) {
    return createSafetyFailure('ultra-research-directory-required', 'Expected ultra research bundle path to be a directory.');
  }
  if (options.directory === false && !stat.isFile()) {
    return createSafetyFailure('ultra-research-file-required', 'Expected ultra research artifact path to be a regular file.');
  }

  let resolved;
  try {
    resolved = await context.io.realpath(absolutePath);
  } catch {
    return createSafetyFailure('ultra-research-realpath-failed', 'Ultra research path could not be resolved safely.');
  }
  if (!isInsidePath(context.projectRealPath, resolved)) {
    return createSafetyFailure('ultra-research-symlink-escape', 'Ultra research real path escapes the project root.');
  }

  if (options.confinedTo !== undefined) {
    const confinement = path.resolve(context.rootDir, fromProjectPath(options.confinedTo));
    let confinementRealPath;
    try {
      confinementRealPath = await context.io.realpath(confinement);
    } catch {
      return createSafetyFailure('ultra-research-realpath-failed', 'Ultra research bundle root could not be resolved safely.');
    }
    if (!isInsidePath(confinementRealPath, resolved)) {
      return createSafetyFailure('ultra-research-link-escape', 'Ultra research artifact escapes its bundle.');
    }
  }

  return { ok: true, error: null };
}

function normalizeProjectRelativePath(input, label) {
  const value = typeof input === 'string' ? input.trim() : '';
  if (
    value === ''
    || value.includes('\0')
    || path.isAbsolute(value)
    || path.win32.isAbsolute(value)
    || /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value)
  ) {
    return pathFailure(label);
  }

  const parts = value.replaceAll('\\', '/').split('/');
  if (parts.some((part) => part === '..')) return pathFailure(label);
  const normalizedParts = parts.filter((part) => part !== '' && part !== '.');
  if (normalizedParts.length === 0) return pathFailure(label);
  return { ok: true, relativePath: normalizedParts.join('/'), error: null };
}

function pathFailure(label) {
  return {
    ok: false,
    relativePath: null,
    error: {
      code: 'ultra-research-path-unsafe',
      message: `${label} must be a safe project-relative path.`
    }
  };
}

function finishExplicitSelection(inspection, strategy) {
  if (!inspection.ok) {
    return createResolutionFailure(inspection.error.code, inspection.error.message, strategy);
  }
  if (!inspection.active) {
    return createResolutionFailure(
      'ultra-research-inactive',
      'Explicit ultra research source is not active.',
      strategy
    );
  }
  return createSelectedResolution(inspection, strategy, [], 1);
}

function createSelectedResolution(inspection, strategy, warnings, candidateCount) {
  return {
    ok: true,
    selected: true,
    source: inspection.source,
    revision: inspection.revision,
    content: inspection.content,
    artifacts: inspection.artifacts,
    diagnostic: {
      code: 'ultra-research-selected',
      selection: strategy,
      candidateCount
    },
    candidates: [],
    warnings,
    errors: []
  };
}

function createResolutionFailure(code, message, selection, warnings = [], candidateCount = 0) {
  return {
    ok: false,
    selected: false,
    source: null,
    revision: null,
    content: null,
    artifacts: [],
    diagnostic: { code, selection, candidateCount },
    candidates: [],
    warnings,
    errors: [{ code, message }]
  };
}

function createInspectionFailure(code, message, bundlePath) {
  return {
    ok: false,
    active: false,
    status: null,
    bundlePath,
    source: null,
    revision: null,
    content: null,
    artifacts: [],
    error: { code, message }
  };
}

function createWarning(code, bundlePath) {
  return {
    code,
    path: bundlePath,
    message: 'Ultra research candidate was not eligible for implicit selection.'
  };
}

function createLinkFailure(code, message) {
  return { ok: false, filename: null, artifacts: [], error: { code, message } };
}

function createSafetyFailure(code, message) {
  return { ok: false, code, error: { code, message } };
}

function toPublicCandidate(inspection) {
  return {
    source: inspection.source,
    revision: inspection.revision,
    artifacts: inspection.artifacts
  };
}

function projectDirname(relativePath) {
  const dirname = path.posix.dirname(relativePath);
  return dirname === '' ? '.' : dirname;
}

function joinProjectPath(...parts) {
  return path.posix.join(...parts);
}

function fromProjectPath(relativePath) {
  return relativePath.split('/').join(path.sep);
}

function isInsidePath(parentPath, candidatePath) {
  const relative = path.relative(parentPath, candidatePath);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
