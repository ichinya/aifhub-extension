// active-change-resolver.mjs - shared active OpenSpec change resolution utilities
import { execFile } from 'node:child_process';
import { access, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

import { findExactMarkdownH2Sections } from './markdown-structural-markers.mjs';
import { readToolConfig, parseToolConfig, toolArtifactPaths } from './tool-config.mjs';

const execFileAsync = promisify(execFile);

export const DEFAULT_PATHS = {
  changes: path.join('openspec', 'changes'),
  specs: path.join('openspec', 'specs'),
  state: path.join('.ai-factory', 'state'),
  qa: path.join('.ai-factory', 'qa'),
  currentPointer: path.join('.ai-factory', 'state', 'current.yaml')
};

const ACTIVE_CHANGE_MARKERS = ['proposal.md', 'design.md', 'tasks.md', 'specs'];
const CURRENT_POINTER_KEYS = ['change_id', 'changeId', 'active_change', 'activeChange'];
const SOURCE_BINDING_HEADING = 'AIFHub Source Binding';
const SOURCE_BINDING_FIELDS = ['Provider', 'Primary source', 'External ID', 'Branch'];
const LEGACY_SOURCE_BINDING_FIELDS = ['provider', 'primary_source', 'external_id', 'branch'];
const MAX_GIT_BRANCH_LENGTH = 255;
const MAX_SOURCE_PROVIDER_LENGTH = 64;
const MAX_PRIMARY_SOURCE_LENGTH = 2048;
const MAX_EXTERNAL_ID_LENGTH = 80;
const MAX_NORMALIZED_EXTERNAL_ID_LENGTH = 64;
const MAX_SOURCE_BOUND_CHANGE_ID_LENGTH = 120;

export async function resolveActiveChange(options = {}) {
  try {
    const selection = await readToolConfig(path.resolve(options.rootDir ?? process.cwd()));
    if (selection.explicit && !selection.tools.openspec) {
      return createFailureResult({ source: 'tools', candidates: [], error: {
        code: 'openspec-disabled', message: 'OpenSpec is disabled by aifhub.tools.openspec; use AI Factory artifacts.' } });
    }
  } catch {
    return createFailureResult({ source: 'tools', candidates: [], error: {
      code: 'tool-configuration-error', message: 'Tool configuration is invalid or unreadable.' } });
  }
  const context = await createResolverContext(options);

  if (options.changeId !== undefined && options.changeId !== null && String(options.changeId).length > 0) {
    return resolveExplicitChange(options.changeId, context);
  }

  const cwdResult = await resolveCwdChange(context);

  if (cwdResult !== null) {
    return cwdResult;
  }

  const listed = await listActiveOpenSpecChangesWithDiagnostics(context);
  const branchResult = await resolveBranchChange(context, listed.changeIds, listed.warnings);

  if (branchResult !== null) {
    return branchResult;
  }

  const pointerResult = await resolveCurrentPointer(context, listed.changeIds, listed.warnings);

  if (pointerResult !== null) {
    return pointerResult;
  }

  return resolveSingleActiveChange(context, listed.changeIds, listed.warnings);
}

export async function listActiveOpenSpecChanges(options = {}) {
  const context = await createResolverContext(options);
  const { changeIds } = await listActiveOpenSpecChangesWithDiagnostics(context);
  return changeIds;
}

async function listActiveOpenSpecChangesWithDiagnostics(context) {
  try {
    const entries = await readdir(context.changesDir, { withFileTypes: true });
    const markedChangeIds = [];
    const fallbackChangeIds = [];

    for (const entry of entries) {
      if (!entry.isDirectory() || !isSelectableChangeId(entry.name)) {
        continue;
      }

      if (await hasActiveChangeMarker(path.join(context.changesDir, entry.name))) {
        markedChangeIds.push(entry.name);
      } else {
        fallbackChangeIds.push(entry.name);
      }
    }

    const changeIds = markedChangeIds.length > 0 ? markedChangeIds : fallbackChangeIds;

    return {
      changeIds: changeIds.sort((left, right) => left.localeCompare(right)),
      warnings: []
    };
  } catch (err) {
    return {
      changeIds: [],
      warnings: [
        {
          code: 'filesystem-error',
          message: `Unable to list active OpenSpec changes in '${context.changesDir}'.`,
          path: context.changesDir,
          detail: err?.message ?? 'Unknown filesystem error.'
        }
      ]
    };
  }
}

export async function ensureRuntimeLayout(changeId, options = {}) {
  const context = await createResolverContext(options);
  const normalized = normalizeChangeId(changeId);

  if (!normalized.ok) {
    throw new Error(normalized.error.message);
  }

  const statePath = path.join(context.stateDir, normalized.changeId);
  const qaPath = path.join(context.qaDir, normalized.changeId);
  const created = [];
  const preserved = [];

  for (const dirPath of [statePath, qaPath]) {
    if (await pathExists(dirPath)) {
      if (!await isDirectory(dirPath)) {
        throw new Error(`Runtime layout path exists but is not a directory: ${dirPath}`);
      }

      preserved.push(path.relative(context.rootDir, dirPath));
      continue;
    }

    await mkdir(dirPath, { recursive: true });
    created.push(path.relative(context.rootDir, dirPath));
  }

  return {
    ok: true,
    changeId: normalized.changeId,
    statePath,
    qaPath,
    created,
    preserved
  };
}

export async function readCurrentChangePointer(options = {}) {
  const context = await createResolverContext(options);

  try {
    const raw = await readFile(context.currentPointerPath, 'utf8');
    return parseCurrentPointer(raw);
  } catch {
    return null;
  }
}

export async function writeCurrentChangePointer(changeId, options = {}) {
  const context = await createResolverContext(options);
  const normalized = normalizeChangeId(changeId);

  if (!normalized.ok) {
    throw new Error(normalized.error.message);
  }

  await mkdir(path.dirname(context.currentPointerPath), { recursive: true });
  await writeFile(context.currentPointerPath, `change_id: ${normalized.changeId}\n`, 'utf8');

  return {
    ok: true,
    changeId: normalized.changeId,
    pointerPath: context.currentPointerPath
  };
}

export function mapBranchToChangeCandidates(branchName, openChangeIds) {
  const branch = String(branchName ?? '').trim();

  if (branch.length === 0) {
    return [];
  }

  const variants = createBranchVariants(branch);
  return Array.from(new Set(openChangeIds.filter((changeId) => variants.has(changeId))))
    .sort((left, right) => left.localeCompare(right));
}

export function parseWorkItemSourceBinding(content) {
  if (typeof content !== 'string') {
    return invalidSourceBinding('source-binding-input-invalid', 'Source binding content must be text.');
  }

  const sections = findExactMarkdownH2Sections(content, SOURCE_BINDING_HEADING);

  if (sections.length === 0) {
    return absentSourceBinding();
  }

  if (sections.length > 1) {
    return invalidSourceBinding(
      'source-binding-duplicate',
      `Proposal contains more than one '## ${SOURCE_BINDING_HEADING}' section.`
    );
  }

  const parsedFields = parseExactBindingFields(sections[0], SOURCE_BINDING_FIELDS, /^-\s+([^:]+):\s*(.*?)\s*$/);

  if (!parsedFields.ok) {
    return parsedFields;
  }

  return validateSourceBindingValues({
    provider: parsedFields.values.Provider,
    primarySource: parsedFields.values['Primary source'],
    externalId: parsedFields.values['External ID'],
    branch: parsedFields.values.Branch
  });
}

export function parseLegacyWorkItemSourceBinding(content) {
  if (typeof content !== 'string') {
    return invalidSourceBinding('source-binding-input-invalid', 'Source binding content must be text.');
  }

  const sections = findLegacySourceBindingSections(content);

  if (sections.length === 0) {
    return absentSourceBinding();
  }

  if (sections.length > 1) {
    return invalidSourceBinding(
      'source-binding-duplicate',
      "Legacy status contains more than one top-level 'source_binding' mapping."
    );
  }

  const parsedFields = parseLegacyBindingFields(sections[0]);

  if (!parsedFields.ok) {
    return parsedFields;
  }

  return validateSourceBindingValues({
    provider: parsedFields.values.provider,
    primarySource: parsedFields.values.primary_source,
    externalId: parsedFields.values.external_id,
    branch: parsedFields.values.branch
  });
}

export function matchesPrimarySourceBinding(content, primarySource, options = {}) {
  if (!isCanonicalPrimarySource(primarySource)) {
    return false;
  }

  const parser = options.format === 'legacy-status'
    ? parseLegacyWorkItemSourceBinding
    : parseWorkItemSourceBinding;
  const parsed = parser(content);

  return parsed.ok
    && parsed.status === 'bound'
    && parsed.binding.primarySource === primarySource;
}

export function parseSynchronizedWorkItemSourceBinding(markdownContent, legacyStatusContent) {
  const markdown = parseWorkItemSourceBinding(markdownContent);
  if (!markdown.ok) {
    return markdown;
  }

  const legacy = parseLegacyWorkItemSourceBinding(legacyStatusContent);
  if (!legacy.ok) {
    return legacy;
  }

  if (markdown.status !== 'bound' || legacy.status !== 'bound') {
    return invalidSourceBinding(
      'source-binding-sync-missing',
      'Classic legacy plans require synchronized Markdown and status source bindings.'
    );
  }

  if (!sourceBindingsEqual(markdown.binding, legacy.binding)) {
    return invalidSourceBinding(
      'source-binding-sync-mismatch',
      'Classic legacy Markdown and status source bindings must contain the same values.'
    );
  }

  return markdown;
}

// Backward-compatible export names for consumers of the first source-binding draft.
export const parseIssueSourceBinding = parseWorkItemSourceBinding;
export const parseLegacyIssueSourceBinding = parseLegacyWorkItemSourceBinding;
export const matchesPrimaryIssueBinding = matchesPrimarySourceBinding;

export function normalizeExternalWorkItemId(input) {
  if (typeof input !== 'string') {
    return invalidExternalWorkItemId();
  }

  const externalId = input.trim();
  if (
    externalId.length === 0
    || externalId.length > MAX_EXTERNAL_ID_LENGTH
    || /[\u0000-\u001f\u007f]/.test(externalId)
  ) {
    return invalidExternalWorkItemId();
  }

  const normalizedExternalId = normalizeIdentifierComponent(externalId)
    .slice(0, MAX_NORMALIZED_EXTERNAL_ID_LENGTH)
    .replace(/-+$/g, '');

  if (normalizedExternalId.length === 0) {
    return invalidExternalWorkItemId();
  }

  return {
    ok: true,
    externalId,
    normalizedExternalId,
    error: null
  };
}

export function deriveSourceBoundChangeId(externalId, requestSlug) {
  const normalizedExternalId = normalizeExternalWorkItemId(externalId);
  if (!normalizedExternalId.ok) {
    return {
      ok: false,
      changeId: null,
      error: normalizedExternalId.error
    };
  }

  let normalizedRequestSlug = normalizeIdentifierComponent(requestSlug);
  const prefix = `${normalizedExternalId.normalizedExternalId}-`;

  if (normalizedRequestSlug.startsWith(prefix)) {
    normalizedRequestSlug = normalizedRequestSlug.slice(prefix.length);
  }

  if (normalizedRequestSlug.length === 0) {
    return {
      ok: false,
      changeId: null,
      error: {
        code: 'source-binding-request-slug-invalid',
        message: 'A source-bound change requires a non-empty request slug.'
      }
    };
  }

  const availableSlugLength = MAX_SOURCE_BOUND_CHANGE_ID_LENGTH - prefix.length;
  normalizedRequestSlug = normalizedRequestSlug
    .slice(0, availableSlugLength)
    .replace(/-+$/g, '');

  if (normalizedRequestSlug.length === 0) {
    return {
      ok: false,
      changeId: null,
      error: {
        code: 'source-binding-request-slug-invalid',
        message: 'A source-bound change requires a non-empty request slug.'
      }
    };
  }

  return {
    ok: true,
    changeId: `${prefix}${normalizedRequestSlug}`,
    normalizedExternalId: normalizedExternalId.normalizedExternalId,
    normalizedRequestSlug,
    error: null
  };
}

export function matchesSourceBoundChangeId(changeId, externalId) {
  const normalizedChange = normalizeChangeId(changeId);
  const normalizedExternalId = normalizeExternalWorkItemId(externalId);

  if (!normalizedChange.ok || !normalizedExternalId.ok) {
    return false;
  }

  const prefix = `${normalizedExternalId.normalizedExternalId}-`;
  return normalizedChange.changeId.startsWith(prefix)
    && normalizedChange.changeId.length > prefix.length;
}

export function normalizeChangeId(input) {
  if (typeof input !== 'string') {
    return invalidChangeId(input);
  }

  const changeId = input.trim();

  if (
    changeId.length === 0
    || path.isAbsolute(changeId)
    || changeId.includes('/')
    || changeId.includes('\\')
    || changeId === '..'
    || changeId.includes('..')
    || !/^[A-Za-z0-9._-]+$/.test(changeId)
  ) {
    return invalidChangeId(input);
  }

  return {
    ok: true,
    changeId,
    error: null
  };
}

async function resolveExplicitChange(input, context) {
  const normalized = normalizeChangeId(input);

  if (!normalized.ok) {
    return createFailureResult({
      source: 'explicit',
      candidates: [],
      error: normalized.error
    });
  }

  const changeId = normalized.changeId;
  const changePath = path.join(context.changesDir, changeId);

  if (!isSelectableChangeId(changeId) || !await isDirectory(changePath)) {
    const listed = await listActiveOpenSpecChangesWithDiagnostics(context);

    return createFailureResult({
      source: 'explicit',
      candidates: listed.changeIds,
      warnings: listed.warnings,
      error: {
        code: 'explicit-change-not-found',
        message: `OpenSpec change '${changeId}' was not found.`
      }
    });
  }

  return createSuccessResult({
    changeId,
    source: 'explicit',
    changePath,
    context,
    candidates: [changeId]
  });
}

async function resolveCwdChange(context) {
  const relativeCwd = path.relative(context.changesDir, context.cwd);

  if (
    relativeCwd.length === 0
    || relativeCwd.startsWith('..')
    || path.isAbsolute(relativeCwd)
  ) {
    return null;
  }

  const [candidate] = relativeCwd.split(/[\\/]+/).filter(Boolean);

  if (candidate === undefined || candidate === 'archive' || candidate.startsWith('.')) {
    return null;
  }

  const normalized = normalizeChangeId(candidate);

  if (!normalized.ok) {
    return null;
  }

  const changeId = normalized.changeId;
  const changePath = path.join(context.changesDir, changeId);

  if (!await isDirectory(changePath)) {
    return null;
  }

  return createSuccessResult({
    changeId,
    source: 'cwd',
    changePath,
    context,
    candidates: [changeId]
  });
}

async function resolveBranchChange(context, openChangeIds, inheritedWarnings = []) {
  let branchName;

  try {
    branchName = await context.getCurrentBranch({ cwd: context.rootDir });
  } catch (err) {
    return nullWithWarning(inheritedWarnings, {
      code: 'git-branch-detection-failed',
      message: 'Unable to detect the current git branch.',
      detail: err?.message ?? 'Unknown git branch detection error.'
    });
  }

  if (typeof branchName !== 'string' || branchName.trim().length === 0) {
    return null;
  }

  const normalizedBranch = branchName.trim();
  const bindings = await inspectActiveSourceBindings(context, normalizedBranch, openChangeIds);
  inheritedWarnings.push(...bindings.warnings);

  if (bindings.errors.length > 0) {
    return createFailureResult({
      source: 'branch-binding',
      candidates: bindings.errors.map((error) => error.changeId),
      warnings: inheritedWarnings,
      error: bindings.errors[0]
    });
  }

  if (bindings.candidates.length > 1) {
    const pointer = await readCurrentChangePointer(context);
    const normalizedPointer = normalizeChangeId(pointer);

    if (normalizedPointer.ok && bindings.candidates.includes(normalizedPointer.changeId)) {
      const changeId = normalizedPointer.changeId;
      inheritedWarnings.push({
        code: 'ambiguous-branch-binding-disambiguated',
        message: `Current pointer selected '${changeId}' from multiple changes bound to git branch '${normalizedBranch}'.`,
        branch: normalizedBranch,
        changeId
      });

      return createSuccessResult({
        changeId,
        source: 'current-pointer',
        changePath: path.join(context.changesDir, changeId),
        context,
        candidates: [changeId],
        warnings: inheritedWarnings
      });
    }

    return createFailureResult({
      source: 'branch-binding',
      candidates: bindings.candidates,
      warnings: inheritedWarnings,
      error: {
        code: 'ambiguous-branch-binding',
        message: `Git branch '${normalizedBranch}' is bound to multiple active OpenSpec changes.`,
        branch: normalizedBranch
      }
    });
  }

  if (bindings.candidates.length === 1) {
    const changeId = bindings.candidates[0];

    return createSuccessResult({
      changeId,
      source: 'branch-binding',
      changePath: path.join(context.changesDir, changeId),
      context,
      candidates: [changeId],
      warnings: inheritedWarnings
    });
  }

  const unboundChangeIds = openChangeIds.filter((changeId) => !bindings.boundChangeIds.includes(changeId));
  const candidates = mapBranchToChangeCandidates(normalizedBranch, unboundChangeIds);

  if (candidates.length === 0) {
    return null;
  }

  if (candidates.length > 1) {
    return createFailureResult({
      source: 'branch',
      candidates,
      warnings: inheritedWarnings,
      error: {
        code: 'ambiguous-branch-change',
        message: `Git branch '${normalizedBranch}' maps to multiple active OpenSpec changes.`,
        branch: normalizedBranch
      }
    });
  }

  const changeId = candidates[0];

  return createSuccessResult({
    changeId,
    source: 'branch',
    changePath: path.join(context.changesDir, changeId),
    context,
    candidates,
    warnings: inheritedWarnings
  });
}

async function inspectActiveSourceBindings(context, branchName, openChangeIds) {
  const candidates = [];
  const boundChangeIds = [];
  const errors = [];
  const warnings = [];
  const inspections = await Promise.all(openChangeIds.map(async (changeId) => {
    const proposalPath = path.join(context.changesDir, changeId, 'proposal.md');

    try {
      return {
        changeId,
        proposalPath,
        content: await readFile(proposalPath, 'utf8'),
        readError: null
      };
    } catch (err) {
      return {
        changeId,
        proposalPath,
        content: null,
        readError: err
      };
    }
  }));

  for (const inspection of inspections) {
    const { changeId, proposalPath, content, readError } = inspection;

    if (readError !== null) {
      if (readError?.code === 'ENOENT') {
        continue;
      }

      boundChangeIds.push(changeId);
      warnings.push({
        code: 'source-binding-read-failed',
        message: `Unable to inspect source binding in '${projectRelativePath(context.rootDir, proposalPath)}'; the change is excluded from branch slug matching.`,
        changeId,
        path: projectRelativePath(context.rootDir, proposalPath)
      });
      continue;
    }

    const parsed = parseWorkItemSourceBinding(content);

    if (!parsed.ok) {
      boundChangeIds.push(changeId);
      const diagnostic = {
        code: parsed.error.code,
        message: `Invalid source binding in '${projectRelativePath(context.rootDir, proposalPath)}'.`,
        changeId,
        path: projectRelativePath(context.rootDir, proposalPath)
      };
      const declaredBranches = inspectDeclaredSourceBindingBranches(content);

      if (declaredBranches.includes(branchName)) {
        errors.push(diagnostic);
      } else {
        warnings.push({
          ...diagnostic,
          message: `${diagnostic.message} It does not declare the current branch and was excluded from branch matching.`
        });
      }
      continue;
    }

    if (parsed.status !== 'bound') {
      continue;
    }

    boundChangeIds.push(changeId);

    if (!matchesSourceBoundChangeId(changeId, parsed.binding.externalId)) {
      const diagnostic = {
        code: 'source-binding-change-id-mismatch',
        message: `Source binding in '${projectRelativePath(context.rootDir, proposalPath)}' does not match its external-id-prefixed change id.`,
        changeId,
        path: projectRelativePath(context.rootDir, proposalPath)
      };

      if (parsed.binding.branch === branchName) {
        errors.push(diagnostic);
      } else {
        warnings.push(diagnostic);
      }
      continue;
    }

    if (parsed.binding.branch === branchName) {
      candidates.push(changeId);
    }
  }

  return {
    candidates: candidates.sort((left, right) => left.localeCompare(right)),
    boundChangeIds: boundChangeIds.sort((left, right) => left.localeCompare(right)),
    errors: errors.sort((left, right) => left.changeId.localeCompare(right.changeId)),
    warnings: warnings.sort((left, right) => left.changeId.localeCompare(right.changeId))
  };
}

async function resolveCurrentPointer(context, openChangeIds, inheritedWarnings = []) {
  const pointer = await readCurrentChangePointer(context);

  if (pointer === null) {
    return null;
  }

  const normalized = normalizeChangeId(pointer);

  if (!normalized.ok) {
    return createFailureResult({
      source: 'current-pointer',
      candidates: openChangeIds,
      warnings: inheritedWarnings,
      error: {
        code: 'current-pointer-invalid',
        message: `Current change pointer '${pointer}' is not a safe OpenSpec change id.`
      }
    });
  }

  const changeId = normalized.changeId;
  const changePath = path.join(context.changesDir, changeId);

  if (!openChangeIds.includes(changeId) || !await isDirectory(changePath)) {
    return createFailureResult({
      source: 'current-pointer',
      candidates: openChangeIds,
      warnings: inheritedWarnings,
      error: {
        code: 'current-pointer-not-found',
        message: `Current change pointer '${changeId}' does not reference an active OpenSpec change.`,
        pointer: changeId
      }
    });
  }

  return createSuccessResult({
    changeId,
    source: 'current-pointer',
    changePath,
    context,
    candidates: [changeId],
    warnings: inheritedWarnings
  });
}

function resolveSingleActiveChange(context, openChangeIds, inheritedWarnings = []) {
  if (openChangeIds.length === 1) {
    const changeId = openChangeIds[0];

    return createSuccessResult({
      changeId,
      source: 'single-active-change',
      changePath: path.join(context.changesDir, changeId),
      context,
      candidates: [changeId],
      warnings: inheritedWarnings
    });
  }

  if (openChangeIds.length > 1) {
    return createFailureResult({
      source: null,
      candidates: openChangeIds,
      warnings: inheritedWarnings,
      error: {
        code: 'ambiguous-active-change',
        message: 'Multiple active OpenSpec changes are available; provide an explicit change id.'
      }
    });
  }

  return createFailureResult({
    source: null,
    candidates: [],
    warnings: inheritedWarnings,
    error: {
      code: 'no-active-change',
      message: 'No active OpenSpec change could be resolved.'
    }
  });
}

function nullWithWarning(inheritedWarnings, warning) {
  inheritedWarnings.push(warning);
  return null;
}

async function createResolverContext(options = {}) {
  if (
    options.rootDir !== undefined
    && options.cwd !== undefined
    && options.changesDir !== undefined
    && options.stateDir !== undefined
    && options.qaDir !== undefined
    && options.currentPointerPath !== undefined
    && typeof options.getCurrentBranch === 'function'
  ) {
    return options;
  }

  const rootDir = path.resolve(options.rootDir ?? process.cwd());
  const config = await readProjectConfig(rootDir);
  const specsPath = config.paths.specs ?? DEFAULT_PATHS.specs;
  const statePath = config.paths.state ?? DEFAULT_PATHS.state;
  const qaPath = config.paths.qa ?? DEFAULT_PATHS.qa;
  const configuredPlansPath = normalizePathSeparators(config.paths.plans);
  const changesPath = configuredPlansPath === DEFAULT_PATHS.changes
    ? config.paths.plans
    : DEFAULT_PATHS.changes;
  const stateDir = resolveFromRoot(rootDir, options.stateDir ?? statePath);

  return {
    rootDir,
    cwd: path.resolve(options.cwd ?? process.cwd()),
    changesDir: resolveFromRoot(rootDir, options.changesDir ?? changesPath),
    specsDir: resolveFromRoot(rootDir, options.specsDir ?? specsPath),
    stateDir,
    qaDir: resolveFromRoot(rootDir, options.qaDir ?? qaPath),
    currentPointerPath: resolveFromRoot(
      rootDir,
      options.currentPointerPath ?? path.join(path.relative(rootDir, stateDir), 'current.yaml')
    ),
    getCurrentBranch: options.getCurrentBranch ?? getCurrentBranch
  };
}

async function readProjectConfig(rootDir) {
  try {
    const raw = await readFile(path.join(rootDir, '.ai-factory', 'config.yaml'), 'utf8');
    return {
      paths: toolArtifactPaths(parseToolConfig(raw), parseSimplePathsConfig(raw))
    };
  } catch {
    return {
      paths: {}
    };
  }
}

function parseSimplePathsConfig(raw) {
  const paths = {};
  const lines = raw.split(/\r?\n/);
  let inPaths = false;

  for (const line of lines) {
    if (/^paths:\s*$/.test(line)) {
      inPaths = true;
      continue;
    }

    if (inPaths && /^\S/.test(line)) {
      inPaths = false;
    }

    if (!inPaths) {
      continue;
    }

    const match = line.match(/^\s{2}([A-Za-z0-9_-]+):\s*["']?([^"'\r\n#]+?)["']?\s*(?:#.*)?$/);

    if (match) {
      paths[match[1]] = match[2].trim();
    }
  }

  return paths;
}

function resolveFromRoot(rootDir, value) {
  return path.resolve(rootDir, value);
}

function normalizePathSeparators(value) {
  return String(value ?? '').replaceAll('\\', '/');
}

function createSuccessResult({ changeId, source, changePath, context, candidates, warnings = [] }) {
  return {
    ok: true,
    changeId,
    source,
    changePath,
    statePath: path.join(context.stateDir, changeId),
    qaPath: path.join(context.qaDir, changeId),
    candidates,
    warnings,
    errors: []
  };
}

function createFailureResult({ source, candidates, error, warnings = [] }) {
  return {
    ok: false,
    changeId: null,
    source,
    changePath: null,
    statePath: null,
    qaPath: null,
    candidates,
    warnings,
    errors: [error]
  };
}

function invalidChangeId(input) {
  return {
    ok: false,
    changeId: null,
    error: {
      code: 'invalid-change-id',
      message: `Invalid OpenSpec change id: ${JSON.stringify(input)}.`
    }
  };
}

function isSelectableChangeId(changeId) {
  return normalizeChangeId(changeId).ok
    && changeId !== 'archive'
    && !changeId.startsWith('.');
}

async function hasActiveChangeMarker(changePath) {
  for (const marker of ACTIVE_CHANGE_MARKERS) {
    if (await pathExists(path.join(changePath, marker))) {
      return true;
    }
  }

  return false;
}

async function pathExists(targetPath) {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function isDirectory(targetPath) {
  try {
    const item = await stat(targetPath);
    return item.isDirectory();
  } catch {
    return false;
  }
}

function parseCurrentPointer(raw) {
  try {
    const parsed = JSON.parse(raw);
    for (const key of CURRENT_POINTER_KEYS) {
      if (typeof parsed?.[key] === 'string') {
        return parsed[key];
      }
    }
  } catch {
    // YAML fallback below.
  }

  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*):\s*["']?([^"'\r\n#]+?)["']?\s*(?:#.*)?$/);

    if (match && CURRENT_POINTER_KEYS.includes(match[1])) {
      return match[2].trim();
    }
  }

  return null;
}

function createBranchVariants(branchName) {
  const variants = new Set();
  const normalized = branchName.replaceAll('\\', '/');
  const parts = normalized.split('/').filter(Boolean);
  const basename = parts.at(-1) ?? normalized;

  variants.add(normalized);
  variants.add(basename);
  variants.add(normalized.replaceAll('/', '-'));

  return variants;
}

function findLegacySourceBindingSections(content) {
  const lines = content.split(/\r\n|\n|\r/);
  const sections = [];

  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index] !== 'source_binding:') {
      continue;
    }

    const section = [];

    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      if (lines[cursor].length > 0 && !/^\s/.test(lines[cursor])) {
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

function parseExactBindingFields(lines, expectedFields, fieldPattern, parseValue = (value) => value) {
  const values = {};

  for (const line of lines) {
    if (line.trim().length === 0) {
      continue;
    }

    const match = line.match(fieldPattern);

    if (!match || !expectedFields.includes(match[1]) || Object.hasOwn(values, match[1])) {
      return invalidSourceBinding(
        'source-binding-fields-invalid',
        'Source binding must contain each required field exactly once and no additional content.'
      );
    }

    const parsedValue = parseValue(match[2]);

    if (parsedValue === null) {
      return invalidSourceBinding(
        'source-binding-fields-invalid',
        'Source binding contains an invalid scalar value.'
      );
    }

    values[match[1]] = parsedValue;
  }

  if (expectedFields.some((field) => !Object.hasOwn(values, field))) {
    return invalidSourceBinding(
      'source-binding-fields-invalid',
      'Source binding must contain each required field exactly once.'
    );
  }

  return {
    ok: true,
    values
  };
}

function parseLegacyBindingFields(lines) {
  const values = {};
  let indentation = null;

  for (const line of lines) {
    if (line.trim().length === 0) {
      continue;
    }

    const match = line.match(/^( {2,})([A-Za-z_][A-Za-z0-9_]*):\s*(.*?)\s*$/);
    if (
      !match
      || (indentation !== null && match[1] !== indentation)
      || !LEGACY_SOURCE_BINDING_FIELDS.includes(match[2])
      || Object.hasOwn(values, match[2])
    ) {
      return invalidSourceBinding(
        'source-binding-fields-invalid',
        'Legacy source binding must contain one consistently indented scalar for each required field.'
      );
    }

    indentation ??= match[1];
    const parsedValue = parseLegacyBindingScalar(match[3]);
    if (parsedValue === null) {
      return invalidSourceBinding(
        'source-binding-fields-invalid',
        'Legacy source binding contains an invalid quoted scalar value.'
      );
    }

    values[match[2]] = parsedValue;
  }

  if (LEGACY_SOURCE_BINDING_FIELDS.some((field) => !Object.hasOwn(values, field))) {
    return invalidSourceBinding(
      'source-binding-fields-invalid',
      'Legacy source binding must contain each required field exactly once.'
    );
  }

  return {
    ok: true,
    values
  };
}

function parseLegacyBindingScalar(value) {
  const scalar = value.trim();

  if (scalar.startsWith("'") && scalar.endsWith("'") && scalar.length >= 2) {
    const body = scalar.slice(1, -1);
    return body.replaceAll("''", '').includes("'")
      ? null
      : body.replaceAll("''", "'");
  }

  if (scalar.startsWith('"') && scalar.endsWith('"')) {
    try {
      const parsed = JSON.parse(scalar);
      return typeof parsed === 'string' ? parsed : null;
    } catch {
      return null;
    }
  }

  return null;
}

function inspectDeclaredSourceBindingBranches(content) {
  const branches = new Set();

  for (const section of findExactMarkdownH2Sections(content, SOURCE_BINDING_HEADING)) {
    const branchLines = section
      .map((line) => line.match(/^-\s+Branch:\s*(.*?)\s*$/))
      .filter(Boolean);

    if (branchLines.length !== 1) {
      continue;
    }

    const normalized = normalizeSourceBindingBranch(branchLines[0][1]);
    if (normalized.ok && normalized.branch !== null) {
      branches.add(normalized.branch);
    }
  }

  return [...branches];
}

function sourceBindingsEqual(left, right) {
  return left.provider === right.provider
    && left.primarySource === right.primarySource
    && left.externalId === right.externalId
    && left.branch === right.branch;
}

function validateSourceBindingValues({ provider, primarySource, externalId, branch }) {
  const normalizedProvider = normalizeSourceProvider(provider);
  if (!normalizedProvider.ok) {
    return invalidSourceBinding(
      'source-binding-provider-invalid',
      'Provider must be one canonical lowercase provider or MCP server identifier.'
    );
  }

  if (!isCanonicalPrimarySource(primarySource)) {
    return invalidSourceBinding(
      'source-binding-primary-source-invalid',
      'Primary source must be one canonical HTTPS work-item URL or stable MCP resource URI.'
    );
  }

  const normalizedExternalId = normalizeExternalWorkItemId(externalId);
  if (!normalizedExternalId.ok) {
    return invalidSourceBinding(
      'source-binding-external-id-invalid',
      'External ID must contain a bounded, human-readable identifier.'
    );
  }

  const normalizedBranch = normalizeSourceBindingBranch(branch);

  if (!normalizedBranch.ok) {
    return invalidSourceBinding(
      'source-binding-branch-invalid',
      'Branch must be an exact safe git branch name or the literal none.'
    );
  }

  return {
    ok: true,
    status: 'bound',
    binding: {
      provider: normalizedProvider.provider,
      primarySource,
      externalId: normalizedExternalId.externalId,
      normalizedExternalId: normalizedExternalId.normalizedExternalId,
      branch: normalizedBranch.branch
    },
    error: null
  };
}

function normalizeSourceProvider(input) {
  if (typeof input !== 'string') {
    return { ok: false, provider: null };
  }

  const provider = input.trim();
  const valid = provider.length > 0
    && provider.length <= MAX_SOURCE_PROVIDER_LENGTH
    && provider === provider.toLowerCase()
    && /^[a-z0-9][a-z0-9._-]*$/.test(provider);

  return valid
    ? { ok: true, provider }
    : { ok: false, provider: null };
}

function isCanonicalPrimarySource(input) {
  if (
    typeof input !== 'string'
    || input.length === 0
    || input.length > MAX_PRIMARY_SOURCE_LENGTH
    || input !== input.trim()
    || /[\u0000-\u0020\u007f]/.test(input)
  ) {
    return false;
  }

  let source;
  try {
    source = new URL(input);
  } catch {
    return false;
  }

  return (source.protocol === 'https:' || source.protocol === 'mcp:')
    && source.hostname.length > 0
    && source.pathname !== '/'
    && source.username.length === 0
    && source.password.length === 0
    && source.search.length === 0
    && source.hash.length === 0;
}

function normalizeIdentifierComponent(input) {
  if (typeof input !== 'string') {
    return '';
  }

  return input
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-');
}

function invalidExternalWorkItemId() {
  return {
    ok: false,
    externalId: null,
    normalizedExternalId: null,
    error: {
      code: 'source-binding-external-id-invalid',
      message: 'External ID must contain a bounded, human-readable identifier.'
    }
  };
}

function normalizeSourceBindingBranch(input) {
  if (typeof input !== 'string') {
    return { ok: false, branch: null };
  }

  const branch = input.trim();

  if (branch === 'none') {
    return { ok: true, branch: null };
  }

  const segments = branch.split('/');
  const invalid = branch.length === 0
    || branch.length > MAX_GIT_BRANCH_LENGTH
    || branch === 'HEAD'
    || branch === '@'
    || branch.startsWith('-')
    || branch.startsWith('/')
    || branch.endsWith('/')
    || branch.includes('//')
    || branch.includes('..')
    || branch.includes('@{')
    || /[\u0000-\u0020\u007f~^:?*[\\]/.test(branch)
    || segments.some((segment) => (
      segment.length === 0
      || segment.startsWith('.')
      || segment.endsWith('.')
      || segment.endsWith('.lock')
    ));

  return invalid
    ? { ok: false, branch: null }
    : { ok: true, branch };
}

function absentSourceBinding() {
  return {
    ok: true,
    status: 'absent',
    binding: null,
    error: null
  };
}

function invalidSourceBinding(code, message) {
  return {
    ok: false,
    status: 'invalid',
    binding: null,
    error: {
      code,
      message
    }
  };
}

function projectRelativePath(rootDir, targetPath) {
  if (typeof targetPath !== 'string' || targetPath.length === 0) {
    return '';
  }

  if (typeof rootDir !== 'string' || rootDir.length === 0) {
    return path.basename(targetPath).replaceAll('\\', '/');
  }

  return path.relative(rootDir, targetPath).replaceAll('\\', '/');
}

async function getCurrentBranch(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const { stdout } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd,
    windowsHide: true
  });

  return stdout.trim();
}
