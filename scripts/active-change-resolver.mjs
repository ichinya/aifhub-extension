// active-change-resolver.mjs - shared active OpenSpec change resolution utilities
import { execFile } from 'node:child_process';
import { access, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

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

export async function resolveActiveChange(options = {}) {
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

  const candidates = mapBranchToChangeCandidates(branchName, openChangeIds);

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
        message: `Git branch '${branchName}' maps to multiple active OpenSpec changes.`,
        branch: branchName
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
  if (options.changesDir !== undefined && options.stateDir !== undefined && options.qaDir !== undefined) {
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
      paths: parseSimplePathsConfig(raw)
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

async function getCurrentBranch(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const { stdout } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd,
    windowsHide: true
  });

  return stdout.trim();
}
