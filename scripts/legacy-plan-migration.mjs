// legacy-plan-migration.mjs - explicit migration from legacy AI Factory plans to OpenSpec changes
import { access, mkdir, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ensureRuntimeGitignore } from './runtime-gitignore.mjs';
import process from 'node:process';

import {
  ensureRuntimeLayout as defaultEnsureRuntimeLayout,
  normalizeChangeId
} from './active-change-resolver.mjs';
import {
  detectOpenSpec as defaultDetectOpenSpec,
  validateOpenSpecChange as defaultValidateOpenSpecChange
} from './openspec-runner.mjs';
import {
  countActiveStandaloneMarker,
  findExactMarkdownH2Sections,
  maskMarkdownCode,
  ULTRA_PLAN_MARKER
} from './markdown-structural-markers.mjs';

const DEFAULT_PLANS_DIR = path.join('.ai-factory', 'plans');
const DEFAULT_CHANGES_DIR = path.join('openspec', 'changes');
const DEFAULT_STATE_DIR = path.join('.ai-factory', 'state');
const DEFAULT_QA_DIR = path.join('.ai-factory', 'qa');
const LEGACY_PLAN_SOURCE_STATE_PATH = path.join(DEFAULT_STATE_DIR, 'legacy-plan-source.json');
const LEGACY_PLAN_SOURCE_STATE_SCHEMA_VERSION = 1;
const ULTRA_PHASE_FILE_PATTERN = /^phase-(\d{2})-([a-z0-9][a-z0-9-]*)\.md$/i;
const ULTRA_PHASE_LIKE_PATTERN = /^phase-\d{2}-.+/i;
const KNOWN_PLAN_FILES = {
  task: 'task.md',
  context: 'context.md',
  rules: 'rules.md',
  verify: 'verify.md',
  status: 'status.yaml',
  explore: 'explore.md'
};
const COLLISION_MODES = new Set(['fail', 'merge-safe', 'suffix', 'overwrite']);
const EXCLUDED_PLAN_NAMES = new Set(['archive', 'archives', 'archived', 'backup', 'backups']);

export function normalizeLegacyPlanId(input) {
  const normalized = normalizeChangeId(String(input ?? '').trim());

  if (
    !normalized.ok
    || normalized.changeId.startsWith('.')
    || EXCLUDED_PLAN_NAMES.has(normalized.changeId.toLowerCase())
  ) {
    return {
      ok: false,
      planId: null,
      error: {
        code: 'invalid-legacy-plan-id',
        message: `Invalid legacy plan id: ${JSON.stringify(input)}.`
      }
    };
  }

  return {
    ok: true,
    planId: normalized.changeId,
    error: null
  };
}

export function normalizeLegacyPlanSourceRoot(input, options = {}) {
  const value = String(input ?? '').trim().replaceAll('\\', '/');
  const normalized = path.posix.normalize(value);

  if (
    value.length === 0
    || normalized === '.'
    || path.isAbsolute(value)
    || /^[a-z][a-z0-9+.-]*:/i.test(value)
    || value.startsWith('//')
    || normalized === '..'
    || normalized.startsWith('../')
  ) {
    return {
      ok: false,
      legacyPlanSourceRoot: null,
      error: {
        code: 'invalid-legacy-plan-source-root',
        message: `Legacy plan source root must be a safe project-relative directory: ${JSON.stringify(input)}.`
      }
    };
  }

  const changesDir = String(options.changesDir ?? DEFAULT_CHANGES_DIR).replaceAll('\\', '/');
  const normalizedChanges = path.posix.normalize(changesDir);
  if (pathsOverlap(normalized, normalizedChanges)) {
    return {
      ok: false,
      legacyPlanSourceRoot: null,
      error: {
        code: 'legacy-plan-source-overlaps-canonical-changes',
        message: `Legacy plan source root must not overlap canonical OpenSpec changes: ${normalized}.`,
        path: normalized
      }
    };
  }

  return {
    ok: true,
    legacyPlanSourceRoot: normalized,
    error: null
  };
}

export async function readLegacyPlanSourceState(options = {}) {
  const rootDir = resolveRootDir(options);
  const statePath = resolveFromRoot(rootDir, LEGACY_PLAN_SOURCE_STATE_PATH);
  const relativeStatePath = toPosix(path.relative(rootDir, statePath));
  let raw;

  try {
    raw = await readFile(statePath, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') {
      return {
        ok: true,
        exists: false,
        path: relativeStatePath,
        legacyPlanSourceRoot: null,
        warnings: [],
        errors: []
      };
    }

    return {
      ok: false,
      exists: false,
      path: relativeStatePath,
      legacyPlanSourceRoot: null,
      warnings: [],
      errors: [{
        code: 'legacy-plan-source-state-read-failed',
        message: `Unable to read legacy plan source state: ${relativeStatePath}.`,
        path: relativeStatePath
      }]
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return invalidLegacyPlanSourceState(relativeStatePath, 'invalid-json');
  }

  if (
    parsed?.schema_version !== LEGACY_PLAN_SOURCE_STATE_SCHEMA_VERSION
    || parsed?.kind !== 'aifhub-legacy-plan-source'
  ) {
    return invalidLegacyPlanSourceState(relativeStatePath, 'invalid-schema');
  }

  const normalized = normalizeLegacyPlanSourceRoot(parsed.legacyPlanSourceRoot, options);
  if (!normalized.ok) {
    return {
      ok: false,
      exists: true,
      path: relativeStatePath,
      legacyPlanSourceRoot: null,
      warnings: [],
      errors: [normalized.error]
    };
  }

  return {
    ok: true,
    exists: true,
    path: relativeStatePath,
    legacyPlanSourceRoot: normalized.legacyPlanSourceRoot,
    reason: parsed.reason ?? null,
    warnings: [],
    errors: []
  };
}

export async function resolveLegacyPlanSourceRoot(options = {}) {
  const rootDir = resolveRootDir(options);
  const explicitValue = options.legacyPlanSourceRoot ?? options.plansDir;
  let source = 'default';
  let candidate = DEFAULT_PLANS_DIR;
  let state = null;

  if (explicitValue !== undefined && explicitValue !== null) {
    source = 'explicit';
    candidate = explicitValue;
  } else if (options.useRecordedLegacyPlanSource !== false) {
    state = await readLegacyPlanSourceState({ ...options, rootDir });
    if (!state.ok) {
      return {
        ok: false,
        source: 'recorded',
        legacyPlanSourceRoot: null,
        state,
        warnings: state.warnings,
        errors: state.errors
      };
    }

    if (state.exists) {
      source = 'recorded';
      candidate = state.legacyPlanSourceRoot;
    }
  }

  const normalized = normalizeLegacyPlanSourceRoot(candidate, options);
  if (!normalized.ok) {
    return {
      ok: false,
      source,
      legacyPlanSourceRoot: null,
      state,
      warnings: [],
      errors: [normalized.error]
    };
  }

  const sourcePath = resolveFromRoot(rootDir, normalized.legacyPlanSourceRoot);
  const changesPath = resolveFromRoot(rootDir, options.changesDir ?? DEFAULT_CHANGES_DIR);
  const actualSource = await realpathIfPresent(sourcePath);
  const actualChanges = await realpathIfPresent(changesPath);
  if (pathsOverlap(toPosix(actualSource), toPosix(actualChanges))) {
    return {
      ok: false,
      source,
      legacyPlanSourceRoot: null,
      state,
      warnings: [],
      errors: [{
        code: 'legacy-plan-source-overlaps-canonical-changes',
        message: `Legacy plan source root must not overlap canonical OpenSpec changes: ${normalized.legacyPlanSourceRoot}.`,
        path: normalized.legacyPlanSourceRoot
      }]
    };
  }

  return {
    ok: true,
    source,
    legacyPlanSourceRoot: normalized.legacyPlanSourceRoot,
    state,
    warnings: [],
    errors: []
  };
}

export async function writeLegacyPlanSourceState(legacyPlanSourceRoot, options = {}) {
  const rootDir = resolveRootDir(options);
  const normalized = normalizeLegacyPlanSourceRoot(legacyPlanSourceRoot, options);
  const dryRun = Boolean(options.dryRun);
  const relativeStatePath = toPosix(LEGACY_PLAN_SOURCE_STATE_PATH);

  if (!normalized.ok) {
    return {
      ok: false,
      dryRun,
      persisted: false,
      wouldPersist: null,
      path: relativeStatePath,
      operations: [],
      warnings: [],
      errors: [normalized.error]
    };
  }

  const operation = {
    action: dryRun ? 'would-write' : 'write',
    target: relativeStatePath
  };
  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      persisted: false,
      wouldPersist: normalized.legacyPlanSourceRoot,
      path: relativeStatePath,
      operations: [operation],
      warnings: [],
      errors: []
    };
  }

  const statePath = resolveFromRoot(rootDir, relativeStatePath);
  const content = `${JSON.stringify({
    schema_version: LEGACY_PLAN_SOURCE_STATE_SCHEMA_VERSION,
    kind: 'aifhub-legacy-plan-source',
    legacyPlanSourceRoot: normalized.legacyPlanSourceRoot,
    reason: options.reason ?? 'migration-incomplete',
    recorded_at: options.timestamp ?? new Date().toISOString()
  }, null, 2)}\n`;
  await ensureRuntimeGitignore(rootDir, DEFAULT_STATE_DIR);
  await mkdir(path.dirname(statePath), { recursive: true });
  await writeFile(statePath, content, 'utf8');

  return {
    ok: true,
    dryRun: false,
    persisted: true,
    wouldPersist: null,
    legacyPlanSourceRoot: normalized.legacyPlanSourceRoot,
    path: relativeStatePath,
    operations: [operation],
    warnings: [],
    errors: []
  };
}

export async function discoverLegacyPlans(options = {}) {
  const rootDir = resolveRootDir(options);
  const source = await resolveLegacyPlanSourceRoot({ ...options, rootDir });
  if (!source.ok) {
    return {
      ok: false,
      legacyPlanSourceRoot: null,
      legacyPlanSource: source,
      plans: [],
      ignored: [],
      warnings: source.warnings,
      errors: source.errors
    };
  }

  const plansRoot = resolveFromRoot(rootDir, source.legacyPlanSourceRoot);
  const changesRoot = resolveFromRoot(rootDir, options.changesDir ?? DEFAULT_CHANGES_DIR);
  const planFilesById = new Map();
  const planDirsById = new Map();
  const warnings = [];

  let entries;
  try {
    entries = await readdir(plansRoot, { withFileTypes: true });
  } catch (err) {
    if (err?.code === 'ENOENT') {
      return {
        ok: true,
        legacyPlanSourceRoot: source.legacyPlanSourceRoot,
        legacyPlanSource: source,
        plans: [],
        ignored: [],
        warnings: [],
        errors: []
      };
    }

    return {
      ok: false,
      legacyPlanSourceRoot: source.legacyPlanSourceRoot,
      legacyPlanSource: source,
      plans: [],
      ignored: [],
      warnings: [],
      errors: [
        {
          code: 'filesystem-error',
          message: `Unable to read legacy plans directory: ${toPosix(path.relative(rootDir, plansRoot))}.`,
          detail: err?.message ?? 'Unknown filesystem error.'
        }
      ]
    };
  }

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (shouldExcludePlanEntry(entry.name)) {
      continue;
    }

    if (entry.isFile()) {
      if (path.extname(entry.name) !== '.md') {
        continue;
      }

      const id = path.basename(entry.name, '.md');
      const normalized = normalizeLegacyPlanId(id);
      if (!normalized.ok) {
        warnings.push(createSkippedUnsafeWarning(entry.name));
        continue;
      }

      planFilesById.set(normalized.planId, toPosix(path.relative(rootDir, path.join(plansRoot, entry.name))));
      continue;
    }

    if (!entry.isDirectory()) {
      continue;
    }

    const normalized = normalizeLegacyPlanId(entry.name);
    if (!normalized.ok) {
      warnings.push(createSkippedUnsafeWarning(entry.name));
      continue;
    }

    planDirsById.set(normalized.planId, path.join(plansRoot, entry.name));
  }

  const plans = [];
  const ignored = [];
  const ids = [...new Set([...planFilesById.keys(), ...planDirsById.keys()])].sort();
  for (const id of ids) {
    const planFile = planFilesById.get(id) ?? null;
    const planDirPath = planDirsById.get(id) ?? null;
    const classification = await classifyLegacyPlanShape(id, {
      ...options,
      rootDir,
      legacyPlanSourceRoot: source.legacyPlanSourceRoot,
      planFile,
      planDirPath
    });

    if (classification.shape === 'unrelated-directory' && planFile === null) {
      ignored.push(classification);
      continue;
    }

    const plan = ensureDiscoveredPlan(new Map(), id, rootDir, changesRoot);
    plan.shape = classification.shape;
    plan.planFile = planFile;
    plan.planDir = classification.planDir;
    plan.files = classification.files;
    plan.phaseFiles = classification.phaseFiles;
    plan.markerCount = classification.markerCount;
    plan.warnings = classification.warnings;
    plan.errors = classification.errors;
    plan.hasCanonicalTarget = await isDirectory(path.join(changesRoot, plan.id));

    if (options.includeContent) {
      plan.contents = await readLegacyPlanContents(rootDir, plan);
    }

    plans.push(plan);
  }

  return {
    ok: true,
    legacyPlanSourceRoot: source.legacyPlanSourceRoot,
    legacyPlanSource: source,
    plans,
    ignored,
    warnings,
    errors: []
  };
}

export async function classifyLegacyPlanShape(planId, options = {}) {
  const rootDir = resolveRootDir(options);
  const normalizedId = normalizeLegacyPlanId(planId);
  if (!normalizedId.ok) {
    return createPlanClassification({
      id: null,
      shape: 'unrelated-directory',
      errors: [normalizedId.error]
    });
  }

  const source = await resolveLegacyPlanSourceRoot({ ...options, rootDir });
  if (!source.ok) {
    return createPlanClassification({
      id: normalizedId.planId,
      shape: 'unrelated-directory',
      errors: source.errors
    });
  }

  const planFile = options.planFile ?? await relativeFileIfPresent(
    rootDir,
    resolveFromRoot(rootDir, path.join(source.legacyPlanSourceRoot, `${normalizedId.planId}.md`))
  );
  const planDirPath = options.planDirPath ?? resolveFromRoot(
    rootDir,
    path.join(source.legacyPlanSourceRoot, normalizedId.planId)
  );
  const planDirExists = await isDirectory(planDirPath);
  const planDir = planDirExists ? toPosix(path.relative(rootDir, planDirPath)) : null;

  if (!planDirExists) {
    return createPlanClassification({
      id: normalizedId.planId,
      shape: planFile === null ? 'unrelated-directory' : 'classic-pair',
      planFile,
      planDir: null
    });
  }

  const entries = (await readdir(planDirPath, { withFileTypes: true }))
    .sort((left, right) => left.name.localeCompare(right.name));
  const indexEntries = entries.filter((entry) => entry.name.toLowerCase() === 'index.md');
  const indexEntry = indexEntries.find((entry) => entry.name === 'index.md');
  const nonCanonicalIndexEntries = indexEntries.filter((entry) => entry.name !== 'index.md');
  const phaseLikeEntries = entries.filter((entry) => ULTRA_PHASE_LIKE_PATTERN.test(entry.name));
  const ultraLike = indexEntries.length > 0 || phaseLikeEntries.length > 0;

  if (!ultraLike) {
    const files = await discoverCompanionFiles(rootDir, planDirPath);
    const hasCompanions = Object.keys(files).length > 0;
    return createPlanClassification({
      id: normalizedId.planId,
      shape: planFile !== null ? 'classic-pair' : hasCompanions ? 'classic-folder-only' : 'unrelated-directory',
      planFile,
      planDir: hasCompanions ? planDir : null,
      files
    });
  }

  const validation = await validateUltraPlanBundle(rootDir, planDirPath, {
    indexEntry,
    nonCanonicalIndexEntries,
    phaseLikeEntries,
    planDir
  });
  if (planFile !== null) {
    return createPlanClassification({
      id: normalizedId.planId,
      shape: 'collision',
      planFile,
      planDir,
      phaseFiles: validation.phaseFiles,
      markerCount: validation.markerCount,
      warnings: validation.warnings,
      errors: [
        {
          code: 'classic-ultra-plan-collision',
          message: `Classic plan file and ultra-like directory share plan id '${normalizedId.planId}'.`,
          path: planDir
        },
        ...validation.errors
      ]
    });
  }

  return createPlanClassification({
    id: normalizedId.planId,
    shape: validation.ok ? 'ultra-valid' : 'ultra-invalid',
    planDir,
    phaseFiles: validation.phaseFiles,
    markerCount: validation.markerCount,
    warnings: validation.warnings,
    errors: validation.errors
  });
}

async function validateUltraPlanBundle(rootDir, planDirPath, context) {
  const errors = [];
  const warnings = [];
  const phaseFiles = context.phaseLikeEntries
    .map((entry) => toPosix(path.relative(rootDir, path.join(planDirPath, entry.name))))
    .sort();
  let markerCount = 0;

  for (const entry of context.nonCanonicalIndexEntries ?? []) {
    errors.push(planIntegrityDiagnostic(
      'ultra-index-name-noncanonical',
      'Ultra plan index file must use the exact lowercase name index.md.',
      toPosix(path.relative(rootDir, path.join(planDirPath, entry.name)))
    ));
  }

  if (context.indexEntry === undefined) {
    if ((context.nonCanonicalIndexEntries ?? []).length === 0) {
      errors.push(planIntegrityDiagnostic(
        'ultra-index-missing',
        'Ultra-like plan directory is missing direct index.md.',
        context.planDir
      ));
    }
    return { ok: false, phaseFiles, markerCount, warnings, errors };
  }

  const indexPath = path.join(planDirPath, context.indexEntry.name);
  const relativeIndexPath = toPosix(path.relative(rootDir, indexPath));
  if (!context.indexEntry.isFile()) {
    errors.push(planIntegrityDiagnostic(
      'ultra-index-not-file',
      'Ultra plan index.md must be a direct regular file.',
      relativeIndexPath
    ));
    return { ok: false, phaseFiles, markerCount, warnings, errors };
  }

  const indexContent = await readFile(indexPath, 'utf8');
  const maskedIndex = maskMarkdownCode(indexContent);
  markerCount = countActiveStandaloneMarker(indexContent, ULTRA_PLAN_MARKER);
  const rawMarkerCount = countLiteral(indexContent, ULTRA_PLAN_MARKER);

  if (markerCount === 0) {
    errors.push(planIntegrityDiagnostic(
      rawMarkerCount > 0 ? 'ultra-marker-code-only' : 'ultra-marker-missing',
      rawMarkerCount > 0
        ? 'Ultra plan marker appears only inside Markdown code.'
        : 'Ultra plan index.md is missing its active standalone marker.',
      relativeIndexPath
    ));
  } else if (markerCount > 1) {
    errors.push(planIntegrityDiagnostic(
      'ultra-marker-duplicate',
      `Ultra plan index.md contains ${markerCount} active standalone markers; exactly one is required.`,
      relativeIndexPath
    ));
  } else if (!hasValidUltraMarkerPosition(maskedIndex)) {
    errors.push(planIntegrityDiagnostic(
      'ultra-marker-position-invalid',
      'Ultra plan marker must be the first line or immediately follow one Handoff annotation.',
      relativeIndexPath
    ));
  }

  const phaseIndex = extractMarkdownSection(maskedIndex, 'Phase Index');
  if (phaseIndex.matches === 0) {
    errors.push(planIntegrityDiagnostic(
      'ultra-phase-index-missing',
      'Ultra plan index.md is missing exact heading ## Phase Index.',
      relativeIndexPath
    ));
  } else if (phaseIndex.matches > 1) {
    errors.push(planIntegrityDiagnostic(
      'ultra-phase-index-duplicate',
      'Ultra plan index.md contains more than one ## Phase Index section.',
      relativeIndexPath
    ));
  }

  const linkedTargets = [];
  if (phaseIndex.matches === 1) {
    const nonEmptyLines = phaseIndex.content.split(/\r?\n/).filter((line) => line.trim().length > 0);
    for (const line of nonEmptyLines) {
      const links = [...line.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)];
      if (links.length !== 1 || !/^\s*(?:[-*]|\d+\.)\s+/.test(line)) {
        errors.push(planIntegrityDiagnostic(
          'ultra-phase-index-malformed',
          'Each non-empty Phase Index row must be one Markdown list item with one direct phase link.',
          relativeIndexPath
        ));
        continue;
      }

      const target = links[0][1].trim();
      if (!isSafeDirectPhaseLink(target)) {
        errors.push(planIntegrityDiagnostic(
          'ultra-phase-link-unsafe',
          `Phase Index link must name one direct phase file: ${safeDiagnosticValue(target)}.`,
          relativeIndexPath
        ));
        continue;
      }

      if (linkedTargets.includes(target)) {
        errors.push(planIntegrityDiagnostic(
          'ultra-phase-link-duplicate',
          `Phase Index links the same phase more than once: ${target}.`,
          relativeIndexPath
        ));
        continue;
      }

      linkedTargets.push(target);
    }

    if (linkedTargets.length === 0) {
      errors.push(planIntegrityDiagnostic(
        'ultra-phase-index-empty',
        'Ultra plan Phase Index must link at least one direct phase file.',
        relativeIndexPath
      ));
    }
  }

  const directPhaseNames = context.phaseLikeEntries.map((entry) => entry.name).sort();
  const unexpectedEntries = (await readdir(planDirPath, { withFileTypes: true }))
    .filter((entry) => entry.name.toLowerCase() !== 'index.md' && !ULTRA_PHASE_LIKE_PATTERN.test(entry.name));
  for (const entry of unexpectedEntries) {
    errors.push(planIntegrityDiagnostic(
      'ultra-bundle-entry-unexpected',
      'Ultra plan bundles may contain only index.md and direct phase-NN-<slug>.md files.',
      toPosix(path.relative(rootDir, path.join(planDirPath, entry.name)))
    ));
  }

  for (const entry of context.phaseLikeEntries) {
    const relativePhasePath = toPosix(path.relative(rootDir, path.join(planDirPath, entry.name)));
    if (!entry.isFile() || !ULTRA_PHASE_FILE_PATTERN.test(entry.name)) {
      errors.push(planIntegrityDiagnostic(
        'ultra-phase-file-invalid',
        'Ultra phase must be a direct regular file named phase-NN-<slug>.md.',
        relativePhasePath
      ));
    }
  }

  const linkedSet = new Set(linkedTargets);
  for (const phaseName of directPhaseNames) {
    if (!linkedSet.has(phaseName)) {
      errors.push(planIntegrityDiagnostic(
        'ultra-phase-file-orphan',
        `Direct phase file is not linked from Phase Index: ${phaseName}.`,
        toPosix(path.relative(rootDir, path.join(planDirPath, phaseName)))
      ));
    }
  }

  const directSet = new Set(directPhaseNames);
  for (const target of linkedTargets) {
    const phasePath = path.join(planDirPath, target);
    if (!directSet.has(target) || !await isFile(phasePath)) {
      errors.push(planIntegrityDiagnostic(
        'ultra-phase-file-missing',
        `Phase Index target is missing as a direct regular file: ${target}.`,
        toPosix(path.relative(rootDir, phasePath))
      ));
    }
  }

  if (!hasSequentialPhaseOrder(linkedTargets)) {
    errors.push(planIntegrityDiagnostic(
      'ultra-phase-order-invalid',
      'Phase Index links must use ordered contiguous phase numbers starting at 01.',
      relativeIndexPath
    ));
  }

  const indexTasks = collectIndexTaskIds(maskedIndex);
  if (indexTasks.length === 0) {
    errors.push(planIntegrityDiagnostic(
      'ultra-index-tasks-missing',
      'Ultra plan index.md must contain progress tasks identified as Task N.',
      relativeIndexPath
    ));
  }
  for (const duplicate of findDuplicates(indexTasks)) {
    errors.push(planIntegrityDiagnostic(
      'ultra-index-task-duplicate',
      `Ultra plan index contains duplicate Task ${duplicate}.`,
      relativeIndexPath
    ));
  }

  const phaseTaskCounts = new Map();
  for (const target of linkedTargets) {
    const phasePath = path.join(planDirPath, target);
    if (!await isFile(phasePath)) {
      continue;
    }

    const phaseContent = maskMarkdownCode(await readFile(phasePath, 'utf8'));
    const relativePhasePath = toPosix(path.relative(rootDir, phasePath));
    if (/^\s*[-*]\s+\[[ xX]\]\s+/m.test(phaseContent)) {
      errors.push(planIntegrityDiagnostic(
        'ultra-phase-progress-checkbox',
        'Ultra phase files must not contain task progress checkboxes; index.md is the sole progress ledger.',
        relativePhasePath
      ));
    }

    for (const taskId of collectPhaseTaskIds(phaseContent)) {
      const occurrences = phaseTaskCounts.get(taskId) ?? [];
      occurrences.push(relativePhasePath);
      phaseTaskCounts.set(taskId, occurrences);
    }
  }

  for (const taskId of new Set(indexTasks)) {
    const occurrences = phaseTaskCounts.get(taskId) ?? [];
    if (occurrences.length === 0) {
      errors.push(planIntegrityDiagnostic(
        'ultra-task-mapping-missing',
        `Index Task ${taskId} has no matching phase heading ## Task ${taskId}:.`,
        relativeIndexPath
      ));
    } else if (occurrences.length > 1) {
      errors.push(planIntegrityDiagnostic(
        'ultra-task-mapping-duplicate',
        `Index Task ${taskId} maps to more than one phase heading.`,
        occurrences[0]
      ));
    }
  }

  const indexTaskSet = new Set(indexTasks);
  for (const [taskId, occurrences] of phaseTaskCounts) {
    if (!indexTaskSet.has(taskId)) {
      errors.push(planIntegrityDiagnostic(
        'ultra-task-mapping-orphan',
        `Phase heading Task ${taskId} has no matching index progress task.`,
        occurrences[0]
      ));
    }
  }

  return {
    ok: errors.length === 0,
    phaseFiles,
    markerCount,
    warnings,
    errors: dedupeDiagnostics(errors)
  };
}

function createPlanClassification({
  id,
  shape,
  planFile = null,
  planDir = null,
  files = {},
  phaseFiles = [],
  markerCount = 0,
  warnings = [],
  errors = []
}) {
  return {
    ok: errors.length === 0,
    id,
    shape,
    planFile,
    planDir,
    files,
    phaseFiles,
    markerCount,
    warnings,
    errors
  };
}

async function discoverCompanionFiles(rootDir, planDirPath) {
  const files = {};
  for (const [key, fileName] of Object.entries(KNOWN_PLAN_FILES)) {
    const filePath = path.join(planDirPath, fileName);
    if (await isFile(filePath)) {
      files[key] = toPosix(path.relative(rootDir, filePath));
    }
  }
  return files;
}

function planIntegrityDiagnostic(code, message, diagnosticPath) {
  return {
    code,
    message,
    ...(diagnosticPath ? { path: diagnosticPath } : {})
  };
}

function hasValidUltraMarkerPosition(content) {
  const lines = String(content ?? '').split(/\r?\n/);
  const markerIndex = lines.findIndex((line) => line.trim() === ULTRA_PLAN_MARKER);
  if (markerIndex === 0) {
    return true;
  }

  return markerIndex === 1
    && /^<!-- handoff:task:[^>]+ -->$/.test(lines[0].trim());
}

function countLiteral(content, literal) {
  return String(content ?? '').split(literal).length - 1;
}

function extractMarkdownSection(content, heading) {
  const sections = findExactMarkdownH2Sections(content, heading);
  return sections.length === 1
    ? { matches: 1, content: sections[0].join('\n') }
    : { matches: sections.length, content: '' };
}

function isSafeDirectPhaseLink(target) {
  return target.length > 0
    && !target.includes('\\')
    && !target.includes('/')
    && !target.includes('?')
    && !target.includes('#')
    && !target.includes('%')
    && !/^[a-z][a-z0-9+.-]*:/i.test(target)
    && ULTRA_PHASE_FILE_PATTERN.test(target);
}

function hasSequentialPhaseOrder(targets) {
  if (targets.length === 0) {
    return true;
  }

  return targets.every((target, index) => {
    const match = target.match(ULTRA_PHASE_FILE_PATTERN);
    return match !== null && Number.parseInt(match[1], 10) === index + 1;
  });
}

function collectIndexTaskIds(content) {
  const ids = [];
  const pattern = /^\s*[-*]\s+\[[ xX]\]\s+(?:\*\*)?Task\s+(\d+)\s*:/gm;
  for (const match of String(content ?? '').matchAll(pattern)) {
    ids.push(Number.parseInt(match[1], 10));
  }
  return ids;
}

function collectPhaseTaskIds(content) {
  const ids = [];
  const pattern = /^## Task\s+(\d+)\s*:/gm;
  for (const match of String(content ?? '').matchAll(pattern)) {
    ids.push(Number.parseInt(match[1], 10));
  }
  return ids;
}

function findDuplicates(values) {
  const seen = new Set();
  const duplicates = new Set();
  for (const value of values) {
    if (seen.has(value)) {
      duplicates.add(value);
    }
    seen.add(value);
  }
  return [...duplicates].sort((left, right) => left - right);
}

function safeDiagnosticValue(value) {
  const normalized = String(value ?? '').replace(/[\r\n\t]/g, ' ').slice(0, 160);
  return JSON.stringify(normalized);
}

export function mapLegacyPlanToOpenSpecArtifacts(legacyPlan, options = {}) {
  const planId = legacyPlan?.id;
  const normalized = normalizeLegacyPlanId(planId);

  if (!normalized.ok) {
    return {
      ok: false,
      planId: null,
      changeId: null,
      canonicalArtifacts: [],
      runtimeArtifacts: [],
      qaArtifacts: [],
      sourceArtifacts: [],
      manualFollowUps: [],
      warnings: [],
      errors: [normalized.error]
    };
  }

  const changeId = options.changeId ?? normalized.planId;
  const normalizedChange = normalizeChangeId(changeId);
  const paths = getMigrationPathConfig(options);
  if (!normalizedChange.ok) {
    return {
      ok: false,
      planId: normalized.planId,
      changeId: null,
      canonicalArtifacts: [],
      runtimeArtifacts: [],
      qaArtifacts: [],
      sourceArtifacts: [],
      manualFollowUps: [],
      warnings: [],
      errors: [normalizedChange.error]
    };
  }

  const contents = legacyPlan.contents ?? {};
  const sourceArtifacts = collectSourceArtifacts(legacyPlan);
  const title = extractTitle(contents.plan) ?? titleFromId(normalized.planId);
  const canonicalArtifacts = [
    {
      kind: 'proposal',
      target: toPosix(path.join(paths.changesDir, normalizedChange.changeId, 'proposal.md')),
      source: legacyPlan.planFile ?? sourceArtifacts[0] ?? null,
      content: renderProposal({ title, legacyPlan, contents, sourceArtifacts })
    },
    {
      kind: 'tasks',
      target: toPosix(path.join(paths.changesDir, normalizedChange.changeId, 'tasks.md')),
      source: legacyPlan.files?.task ?? null,
      content: renderTasks(contents.task)
    }
  ];
  const runtimeArtifacts = [];
  const qaArtifacts = [];
  const manualFollowUps = [
    'Review generated OpenSpec artifacts before implementation.',
    `Run /aif-improve ${normalizedChange.changeId} after migration to refine proposal, design, tasks, and specs.`
  ];
  const warnings = [];

  if (isDesignLike(contents.context)) {
    canonicalArtifacts.push({
      kind: 'design',
      target: toPosix(path.join(paths.changesDir, normalizedChange.changeId, 'design.md')),
      source: legacyPlan.files?.context ?? null,
      content: renderDesign({ title, legacyPlan, contents })
    });
  }

  if (hasText(contents.context)) {
    runtimeArtifacts.push({
      kind: 'legacy-context',
      target: toPosix(path.join(paths.stateDir, normalizedChange.changeId, 'legacy-context.md')),
      source: legacyPlan.files?.context ?? null,
      content: renderPreservedMarkdown('Legacy Context', legacyPlan.files?.context, contents.context)
    });
  }

  if (hasText(contents.rules)) {
    runtimeArtifacts.push({
      kind: 'legacy-rules',
      target: toPosix(path.join(paths.stateDir, normalizedChange.changeId, 'legacy-rules.md')),
      source: legacyPlan.files?.rules ?? null,
      content: renderPreservedMarkdown('Legacy Rules', legacyPlan.files?.rules, contents.rules)
    });
    warnings.push({
      code: 'legacy-rules-preserved',
      message: 'Legacy rules were preserved as runtime notes. Regenerate OpenSpec-derived rules after migration.'
    });
  }

  if (hasText(contents.status)) {
    runtimeArtifacts.push({
      kind: 'legacy-status',
      target: toPosix(path.join(paths.stateDir, normalizedChange.changeId, 'legacy-status.yaml')),
      source: legacyPlan.files?.status ?? null,
      content: contents.status
    });
  }

  if (hasText(contents.explore)) {
    runtimeArtifacts.push({
      kind: 'legacy-explore',
      target: toPosix(path.join(paths.stateDir, normalizedChange.changeId, 'legacy-explore.md')),
      source: legacyPlan.files?.explore ?? null,
      content: renderPreservedMarkdown('Legacy Exploration Notes', legacyPlan.files?.explore, contents.explore)
    });
  }

  if (hasText(contents.verify)) {
    qaArtifacts.push({
      kind: 'legacy-verify',
      target: toPosix(path.join(paths.qaDir, normalizedChange.changeId, 'legacy-verify.md')),
      source: legacyPlan.files?.verify ?? null,
      content: contents.verify
    });
  }

  const requirements = extractClearRequirements([
    contents.plan,
    contents.context,
    contents.rules
  ]);

  if (requirements.length > 0) {
    canonicalArtifacts.push({
      kind: 'delta-spec',
      target: toPosix(path.join(paths.changesDir, normalizedChange.changeId, 'specs', 'migrated', 'spec.md')),
      source: sourceArtifacts[0] ?? null,
      content: renderDeltaSpec(requirements)
    });
  } else {
    warnings.push({
      code: 'manual-spec-authoring-needed',
      message: 'No clear behavioral requirements were extracted; write or refine delta specs manually.'
    });
    manualFollowUps.push('Author or refine OpenSpec delta specs manually if validation requires them.');
  }

  return {
    ok: true,
    planId: normalized.planId,
    changeId: normalizedChange.changeId,
    canonicalArtifacts,
    runtimeArtifacts,
    qaArtifacts,
    sourceArtifacts,
    manualFollowUps,
    warnings,
    errors: []
  };
}

export async function migrateLegacyPlan(planId, options = {}) {
  const rootDir = resolveRootDir(options);
  const normalized = normalizeLegacyPlanId(planId);
  const dryRun = Boolean(options.dryRun);
  const onCollision = options.onCollision ?? 'fail';
  let paths = getMigrationPathConfig(options);

  if (!normalized.ok) {
    return createMigrationFailure({
      dryRun,
      planId: null,
      changeId: null,
      errors: [normalized.error]
    });
  }

  if (!COLLISION_MODES.has(onCollision)) {
    return createMigrationFailure({
      dryRun,
      planId: normalized.planId,
      changeId: normalized.planId,
      errors: [
        {
          code: 'invalid-collision-mode',
          message: `Invalid collision mode: ${onCollision}.`
        }
      ]
    });
  }

  const discovery = await discoverLegacyPlans({ ...options, rootDir, includeContent: true });
  if (!discovery.ok) {
    return createMigrationFailure({
      dryRun,
      planId: normalized.planId,
      changeId: normalized.planId,
      warnings: discovery.warnings,
      errors: discovery.errors
    });
  }

  const migrationOptions = {
    ...options,
    legacyPlanSourceRoot: discovery.legacyPlanSourceRoot
  };
  paths = getMigrationPathConfig(migrationOptions);

  const legacyPlan = discovery.plans.find((plan) => plan.id === normalized.planId);
  if (legacyPlan === undefined) {
    return createMigrationFailure({
      dryRun,
      planId: normalized.planId,
      changeId: normalized.planId,
      errors: [
        {
          code: 'legacy-plan-not-found',
          message: `Legacy plan '${normalized.planId}' was not found.`
        }
      ]
    });
  }

  if (legacyPlan.shape === 'ultra-valid') {
    return {
      ok: true,
      outcome: 'skipped-ultra',
      skipped: true,
      dryRun,
      planId: normalized.planId,
      changeId: null,
      shape: legacyPlan.shape,
      targetChangePath: null,
      operations: [],
      validation: createValidationSummary('SKIPPED', false, null),
      reportPath: null,
      warnings: dedupeDiagnostics([
        ...discovery.warnings,
        ...(legacyPlan.warnings ?? []),
        {
          code: 'ultra-plan-not-migrated',
          message: `Marked ultra plan remains upstream-owned: ${legacyPlan.planDir}.`,
          path: legacyPlan.planDir
        }
      ]),
      errors: []
    };
  }

  if (legacyPlan.shape === 'ultra-invalid' || legacyPlan.shape === 'collision') {
    return createMigrationFailure({
      dryRun,
      planId: normalized.planId,
      changeId: null,
      shape: legacyPlan.shape,
      warnings: legacyPlan.warnings,
      errors: legacyPlan.errors.length > 0
        ? legacyPlan.errors
        : [{
            code: 'legacy-plan-shape-invalid',
            message: `Legacy plan shape cannot be migrated: ${legacyPlan.shape}.`,
            path: legacyPlan.planDir ?? legacyPlan.planFile
          }]
    });
  }

  const collision = await resolveCollisionTarget(normalized.planId, { ...migrationOptions, rootDir, onCollision });
  if (!collision.ok) {
    return createMigrationFailure({
      dryRun,
      planId: normalized.planId,
      changeId: normalized.planId,
      targetChangePath: toPosix(path.join(paths.changesDir, normalized.planId)),
      errors: collision.errors
    });
  }

  const mapped = mapLegacyPlanToOpenSpecArtifacts(legacyPlan, {
    ...paths,
    changeId: collision.changeId
  });
  if (!mapped.ok) {
    return createMigrationFailure({
      dryRun,
      planId: normalized.planId,
      changeId: collision.changeId,
      errors: mapped.errors
    });
  }

  const plannedArtifacts = [
    ...mapped.canonicalArtifacts.map((artifact) => ({ ...artifact, bucket: 'canonical' })),
    ...mapped.runtimeArtifacts.map((artifact) => ({ ...artifact, bucket: 'state' })),
    ...mapped.qaArtifacts.map((artifact) => ({ ...artifact, bucket: 'qa' }))
  ];
  const operations = [];
  const errors = [];

  for (const artifact of plannedArtifacts) {
    try {
      assertSafeArtifactTarget(rootDir, collision.changeId, artifact, paths);
    } catch (err) {
      errors.push({
        code: 'unsafe-target',
        message: err?.message ?? 'Unsafe migration target.',
        target: artifact.target
      });
    }

    const exists = await pathExists(resolveFromRoot(rootDir, artifact.target));
    if (exists && onCollision === 'merge-safe') {
      operations.push({
        action: 'skip',
        target: artifact.target,
        source: artifact.source,
        reason: 'target-exists'
      });
      continue;
    }

    operations.push({
      action: 'write',
      target: artifact.target,
      source: artifact.source
    });
  }

  const reportPath = await resolveMigrationReportPath(rootDir, collision.changeId, {
    ...paths,
    onCollision
  });
  operations.push({
    action: 'write',
    target: reportPath,
    source: 'migration-result'
  });

  try {
    assertSafeArtifactTarget(rootDir, collision.changeId, {
      target: reportPath,
      bucket: 'state'
    }, paths);
  } catch (err) {
    errors.push({
      code: 'unsafe-target',
      message: err?.message ?? 'Unsafe migration report target.',
      target: reportPath
    });
  }

  if (errors.length > 0) {
    return createMigrationFailure({
      dryRun,
      planId: normalized.planId,
      changeId: collision.changeId,
      targetChangePath: toPosix(path.join(paths.changesDir, collision.changeId)),
      operations,
      warnings: mapped.warnings,
      errors
    });
  }

  const baseResult = {
    ok: true,
    outcome: 'migrated',
    skipped: false,
    dryRun,
    planId: normalized.planId,
    changeId: collision.changeId,
    shape: legacyPlan.shape,
    targetChangePath: toPosix(path.join(paths.changesDir, collision.changeId)),
    operations,
    validation: createValidationSummary('SKIPPED', false, null),
    reportPath,
    warnings: [...discovery.warnings, ...mapped.warnings],
    errors: []
  };

  if (dryRun) {
    return baseResult;
  }

  const ensureRuntimeLayout = options.ensureRuntimeLayout ?? defaultEnsureRuntimeLayout;
  await ensureRuntimeLayout(collision.changeId, {
    rootDir,
    cwd: options.cwd,
    stateDir: options.stateDir,
    qaDir: options.qaDir
  });

  for (const artifact of plannedArtifacts) {
    if (operations.some((operation) => operation.action === 'skip' && operation.target === artifact.target)) {
      continue;
    }

    await writeArtifact(rootDir, artifact);
  }

  const validation = await validateMigratedChange(collision.changeId, { ...options, rootDir });
  const result = {
    ...baseResult,
    ok: validation.status !== 'FAIL',
    outcome: validation.status === 'FAIL' ? 'failed' : 'migrated',
    validation,
    errors: validation.status === 'FAIL'
      ? [
          {
            code: 'openspec-validation-failed',
            message: 'OpenSpec validation failed after migration.'
          }
        ]
      : []
  };

  const report = await writeMigrationReport(normalized.planId, {
    ...result,
    sourceArtifacts: mapped.sourceArtifacts,
    generatedOpenSpecArtifacts: mapped.canonicalArtifacts.map((artifact) => artifact.target),
    runtimeArtifacts: [
      ...mapped.runtimeArtifacts.map((artifact) => artifact.target),
      ...mapped.qaArtifacts.map((artifact) => artifact.target)
    ],
    manualFollowUps: mapped.manualFollowUps
  }, {
    ...migrationOptions,
    rootDir,
    changeId: collision.changeId,
    reportPath
  });

  return {
    ...result,
    reportPath: report.path
  };
}

export async function migrateAllLegacyPlans(options = {}) {
  const rootDir = resolveRootDir(options);
  const discovery = await discoverLegacyPlans({ ...options, rootDir });

  if (!discovery.ok) {
    return {
      ok: false,
      partial: false,
      dryRun: Boolean(options.dryRun),
      preflightFailed: true,
      results: [],
      migrated: [],
      wouldMigrate: [],
      skipped: [],
      failed: [],
      warnings: discovery.warnings,
      errors: discovery.errors
    };
  }

  const preflightResults = [];
  for (const plan of discovery.plans) {
    preflightResults.push(await migrateLegacyPlan(plan.id, {
      ...options,
      rootDir,
      dryRun: true
    }));
  }

  const preflightFailed = preflightResults.some((result) => result.outcome === 'failed');
  const dryRun = Boolean(options.dryRun);
  let results = preflightResults;

  if (!dryRun && !preflightFailed) {
    results = [];
    for (const result of preflightResults) {
      if (result.outcome === 'skipped-ultra') {
        results.push({ ...result, dryRun: false });
        continue;
      }

      results.push(await migrateLegacyPlan(result.planId, {
        ...options,
        rootDir,
        dryRun: false
      }));
    }
  }

  const migrated = preflightFailed && !dryRun
    ? []
    : results.filter((result) => result.outcome === 'migrated').map((result) => result.planId);
  const wouldMigrate = preflightResults
    .filter((result) => result.outcome === 'migrated')
    .map((result) => result.planId);
  const skipped = results
    .filter((result) => result.outcome === 'skipped-ultra')
    .map((result) => result.planId);
  const failed = results
    .filter((result) => result.outcome === 'failed')
    .map((result) => result.planId);

  return {
    ok: failed.length === 0,
    partial: !preflightFailed && migrated.length > 0 && failed.length > 0,
    dryRun,
    preflightFailed,
    results,
    migrated,
    wouldMigrate,
    skipped,
    failed,
    warnings: dedupeDiagnostics([
      ...discovery.warnings,
      ...results.flatMap((result) => result.warnings ?? [])
    ]),
    errors: results.flatMap((result) => result.errors ?? [])
  };
}

export async function writeMigrationReport(planId, report, options = {}) {
  const rootDir = resolveRootDir(options);
  const changeId = options.changeId ?? report?.changeId ?? planId;
  const normalized = normalizeChangeId(changeId);
  const paths = getMigrationPathConfig(options);

  if (!normalized.ok) {
    throw new Error(normalized.error.message);
  }

  const reportPath = options.reportPath
    ? toPosix(options.reportPath)
    : toPosix(path.join(paths.stateDir, normalized.changeId, 'migration-report.md'));
  const artifact = {
    bucket: 'state',
    target: reportPath,
    content: renderMigrationReport({
      planId,
      changeId: normalized.changeId,
      ...report
    })
  };
  assertSafeArtifactTarget(rootDir, normalized.changeId, artifact, paths);

  if (options.dryRun) {
    return {
      ok: true,
      dryRun: true,
      path: reportPath
    };
  }

  await ensureRuntimeGitignore(rootDir, paths.stateDir);
  await writeArtifact(rootDir, artifact);

  return {
    ok: true,
    path: reportPath
  };
}

export async function detectMigrationNeed(options = {}) {
  const rootDir = resolveRootDir(options);
  const input = options.changeId ?? options.planId;
  const normalized = normalizeLegacyPlanId(input);

  if (!normalized.ok) {
    return {
      ok: false,
      migrationSuggested: false,
      changeId: null,
      changeExists: false,
      legacyPlan: null,
      commands: [],
      warnings: [],
      errors: [normalized.error]
    };
  }

  const changePath = resolveFromRoot(rootDir, path.join(options.changesDir ?? DEFAULT_CHANGES_DIR, normalized.planId));
  const changeExists = await pathExists(changePath);
  const discovery = await discoverLegacyPlans({ ...options, rootDir });
  const legacyPlan = discovery.plans.find((plan) => plan.id === normalized.planId) ?? null;
  const classicShape = legacyPlan?.shape === 'classic-pair' || legacyPlan?.shape === 'classic-folder-only';
  const migrationSuggested = !changeExists && classicShape;
  const shapeErrors = legacyPlan?.shape === 'ultra-invalid' || legacyPlan?.shape === 'collision'
    ? legacyPlan.errors
    : [];
  const ultraWarnings = legacyPlan?.shape === 'ultra-valid'
    ? [{
        code: 'ultra-plan-not-migrated',
        message: `Marked ultra plan remains upstream-owned: ${legacyPlan.planDir}.`,
        path: legacyPlan.planDir
      }]
    : [];

  return {
    ok: discovery.ok && shapeErrors.length === 0,
    migrationSuggested,
    changeId: normalized.planId,
    changeExists,
    legacyPlan,
    commands: migrationSuggested
      ? [
          `ai-factory aifhub-migrate-legacy-plans ${normalized.planId} --dry-run`,
          `ai-factory aifhub-migrate-legacy-plans ${normalized.planId}`
        ]
      : [],
    warnings: dedupeDiagnostics([...discovery.warnings, ...ultraWarnings]),
    errors: [...discovery.errors, ...shapeErrors]
  };
}

async function resolveCollisionTarget(planId, options) {
  const rootDir = resolveRootDir(options);
  const paths = getMigrationPathConfig(options);
  const changesDir = paths.changesDir;
  const onCollision = options.onCollision ?? 'fail';
  const target = resolveFromRoot(rootDir, path.join(changesDir, planId));
  const exists = await pathExists(target);

  if (!exists || onCollision === 'merge-safe' || onCollision === 'overwrite') {
    return {
      ok: true,
      changeId: planId,
      errors: []
    };
  }

  if (onCollision === 'fail') {
    return {
      ok: false,
      changeId: null,
      errors: [
        {
          code: 'target-exists',
          message: `OpenSpec change target already exists: ${toPosix(path.join(changesDir, planId))}.`,
          source: toPosix(path.join(paths.plansDir, `${planId}.md`)),
          target: toPosix(path.join(changesDir, planId))
        }
      ]
    };
  }

  for (let index = 0; index < 100; index += 1) {
    const suffix = index === 0 ? '-migrated' : `-migrated-${index + 1}`;
    const candidate = `${planId}${suffix}`;
    const normalized = normalizeChangeId(candidate);
    if (!normalized.ok) {
      continue;
    }

    if (!await pathExists(resolveFromRoot(rootDir, path.join(changesDir, candidate)))) {
      return {
        ok: true,
        changeId: candidate,
        errors: []
      };
    }
  }

  return {
    ok: false,
    changeId: null,
    errors: [
      {
        code: 'suffix-exhausted',
        message: `Unable to find available migration suffix for '${planId}'.`
      }
    ]
  };
}

async function resolveMigrationReportPath(rootDir, changeId, options = {}) {
  const paths = getMigrationPathConfig(options);
  const defaultReportPath = toPosix(path.join(paths.stateDir, changeId, 'migration-report.md'));

  if (options.onCollision === 'overwrite' || !await pathExists(resolveFromRoot(rootDir, defaultReportPath))) {
    return defaultReportPath;
  }

  for (let index = 0; index < 100; index += 1) {
    const suffix = index === 0 ? '-migrated' : `-migrated-${index + 1}`;
    const candidate = toPosix(path.join(paths.stateDir, changeId, `migration-report${suffix}.md`));
    if (!await pathExists(resolveFromRoot(rootDir, candidate))) {
      return candidate;
    }
  }

  throw new Error(`Unable to find available migration report path for '${changeId}'.`);
}

async function validateMigratedChange(changeId, options) {
  const detectOpenSpec = options.detectOpenSpec ?? defaultDetectOpenSpec;
  const validateOpenSpecChange = options.validateOpenSpecChange ?? defaultValidateOpenSpecChange;
  let detection;

  try {
    detection = await detectOpenSpec(createRunOptions(options));
  } catch (err) {
    return createValidationSummary('SKIPPED', false, null, {
      code: 'openspec-detection-failed',
      message: err?.message ?? 'OpenSpec detection failed.'
    });
  }

  if (!detection?.available || !detection?.canValidate) {
    return createValidationSummary('SKIPPED', Boolean(detection?.available), detection);
  }

  const result = await validateOpenSpecChange(changeId, createRunOptions(options));
  return createValidationSummary(result?.ok ? 'PASS' : 'FAIL', true, result);
}

function createValidationSummary(status, available, result, error = null) {
  return {
    status,
    available,
    result,
    error
  };
}

function createRunOptions(options) {
  return {
    cwd: options.rootDir ?? process.cwd(),
    command: options.command,
    env: options.env,
    executor: options.executor,
    nodeVersion: options.nodeVersion
  };
}

function createMigrationFailure({ dryRun, planId, changeId, shape = null, targetChangePath = null, operations = [], warnings = [], errors = [] }) {
  return {
    ok: false,
    outcome: 'failed',
    skipped: false,
    dryRun,
    planId,
    changeId,
    shape,
    targetChangePath,
    operations,
    validation: createValidationSummary('SKIPPED', false, null),
    reportPath: null,
    warnings,
    errors
  };
}

function ensureDiscoveredPlan(plansById, id, rootDir, changesRoot) {
  if (!plansById.has(id)) {
    plansById.set(id, {
      id,
      planFile: null,
      planDir: null,
      files: {},
      hasCanonicalTarget: false,
      targetChangePath: toPosix(path.relative(rootDir, path.join(changesRoot, id)))
    });
  }

  return plansById.get(id);
}

function getMigrationPathConfig(options = {}) {
  return {
    plansDir: options.legacyPlanSourceRoot ?? options.plansDir ?? DEFAULT_PLANS_DIR,
    changesDir: options.changesDir ?? DEFAULT_CHANGES_DIR,
    stateDir: options.stateDir ?? DEFAULT_STATE_DIR,
    qaDir: options.qaDir ?? DEFAULT_QA_DIR
  };
}

async function readLegacyPlanContents(rootDir, plan) {
  const contents = {};

  if (plan.planFile !== null) {
    contents.plan = await readFile(resolveFromRoot(rootDir, plan.planFile), 'utf8');
  }

  for (const key of Object.keys(KNOWN_PLAN_FILES)) {
    if (plan.files[key] !== undefined) {
      contents[key] = await readFile(resolveFromRoot(rootDir, plan.files[key]), 'utf8');
    }
  }

  return contents;
}

function collectSourceArtifacts(legacyPlan) {
  return [
    legacyPlan.planFile,
    ...Object.values(legacyPlan.files ?? {})
  ].filter(Boolean);
}

function renderProposal({ title, legacyPlan, contents, sourceArtifacts }) {
  const summary = extractSection(contents.plan, ['Intent', 'Summary', 'Overview']) ?? firstMeaningfulParagraph(contents.plan) ?? 'Migrated legacy plan. Review and refine this proposal before implementation.';
  const scope = extractSection(contents.plan, ['Scope']) ?? '- Review migrated legacy scope.';
  const approach = extractSection(contents.plan, ['Approach', 'Implementation', 'Plan']) ?? 'Review legacy plan notes and refine the OpenSpec change design.';
  const notes = hasText(contents.plan) ? contents.plan.trim() : 'No top-level legacy plan file was present.';

  return [
    `# Proposal: ${title}`,
    '',
    '## Intent',
    '',
    summary.trim(),
    '',
    '## Scope',
    '',
    scope.trim(),
    '',
    '## Approach',
    '',
    approach.trim(),
    '',
    '## Legacy source',
    '',
    'Migrated from:',
    ...sourceArtifacts.map((source) => `- ${source}`),
    '',
    '## Legacy plan notes',
    '',
    notes,
    ''
  ].join('\n');
}

function renderTasks(taskContent) {
  if (!hasText(taskContent)) {
    return [
      '# Tasks',
      '',
      '## Migrated legacy tasks',
      '',
      '- [ ] Review migrated legacy artifacts and author implementation tasks.',
      ''
    ].join('\n');
  }

  const checklist = [];
  for (const line of taskContent.split(/\r?\n/)) {
    const match = line.match(/^\s*[-*]\s+\[([ xX])\]\s+(.+?)\s*$/);
    if (match) {
      checklist.push(`- [${match[1].toLowerCase() === 'x' ? 'x' : ' '}] ${match[2]}`);
    }
  }

  if (checklist.length > 0) {
    return [
      '# Tasks',
      '',
      '## Migrated legacy tasks',
      '',
      ...checklist,
      ''
    ].join('\n');
  }

  return [
    '# Tasks',
    '',
    '## Migrated legacy tasks',
    '',
    taskContent.trim(),
    ''
  ].join('\n');
}

function renderDesign({ title, legacyPlan, contents }) {
  const designContext = extractSection(contents.context, ['Design', 'Architecture', 'Technical Approach']) ?? contents.context.trim();

  return [
    `# Design: ${title}`,
    '',
    '## Technical Approach',
    '',
    designContext,
    '',
    '## Data / Artifact Model',
    '',
    'Migrated from legacy AI Factory plan artifacts. Preserve runtime-only source material under `.ai-factory/state/<change-id>/` and QA evidence under `.ai-factory/qa/<change-id>/`.',
    '',
    '## Integration Points',
    '',
    `- Legacy source: ${legacyPlan.files?.context ?? 'none'}`,
    '',
    '## Alternatives Considered',
    '',
    '- Preserve raw context only as runtime notes. Rejected when the context contains design-relevant implementation guidance.',
    '',
    '## Risks',
    '',
    '- Migrated context may include raw notes that need manual refinement before implementation.',
    ''
  ].join('\n');
}

function renderDeltaSpec(requirements) {
  const lines = [
    '# Delta for Migrated Legacy Plan',
    '',
    '## ADDED Requirements',
    ''
  ];

  for (const requirement of requirements) {
    lines.push(
      `### Requirement: ${requirement.name}`,
      '',
      requirement.text,
      '',
      '#### Scenario: Migrated legacy behavior',
      '',
      '- GIVEN the migrated legacy plan context',
      '- WHEN the migrated change is implemented',
      `- THEN ${scenarioThenText(requirement.text)}`,
      ''
    );
  }

  return lines.join('\n');
}

function renderPreservedMarkdown(title, source, content) {
  return [
    `# ${title}`,
    '',
    '## Legacy source',
    '',
    source === undefined || source === null ? '- unknown' : `- ${source}`,
    '',
    '## Preserved content',
    '',
    content.trim(),
    ''
  ].join('\n');
}

function renderMigrationReport(report) {
  return [
    `# Legacy Plan Migration: ${report.changeId ?? report.planId}`,
    '',
    '## Summary',
    '',
    'Migrated from legacy `.ai-factory/plans` artifacts to OpenSpec-native artifacts.',
    '',
    '## Source artifacts',
    '',
    ...renderList(report.sourceArtifacts),
    '',
    '## Generated OpenSpec artifacts',
    '',
    ...renderList(report.generatedOpenSpecArtifacts),
    '',
    '## Runtime artifacts',
    '',
    ...renderList(report.runtimeArtifacts),
    '',
    '## Validation',
    '',
    `OpenSpec validation: ${report.validation?.status ?? 'SKIPPED'}`,
    '',
    '## Diagnostics',
    '',
    ...renderDiagnostics('Warnings', report.warnings ?? []),
    '',
    ...renderDiagnostics('Errors', report.errors ?? []),
    '',
    '## Manual follow-ups',
    '',
    ...renderList(report.manualFollowUps ?? [
      'Review generated delta specs.',
      `Run /aif-improve ${report.changeId ?? report.planId} to refine proposal/design/tasks/specs.`,
      'Run rules compiler if needed.'
    ]),
    ''
  ].join('\n');
}

function renderList(items) {
  const values = Array.isArray(items) ? items.filter(Boolean) : [];
  return values.length === 0 ? ['- none'] : values.map((item) => `- ${item}`);
}

function renderDiagnostics(label, diagnostics) {
  const items = Array.isArray(diagnostics) ? diagnostics : [];
  if (items.length === 0) {
    return [`${label}: none`];
  }

  return [
    `${label}:`,
    ...items.map((item) => `- ${item.code ?? 'diagnostic'}: ${item.message ?? JSON.stringify(item)}`)
  ];
}

function extractClearRequirements(contents) {
  const requirements = [];
  const seen = new Set();

  for (const content of contents) {
    if (!hasText(content)) {
      continue;
    }

    for (const line of content.split(/\r?\n/)) {
      const cleaned = line.replace(/^\s*[-*]\s+/, '').trim();
      if (!/\b(?:MUST|SHALL)\b/.test(cleaned)) {
        continue;
      }

      const text = cleaned.replace(/\s+$/, '').replace(/[.;]?$/, '.');
      const key = text.toLowerCase();
      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      requirements.push({
        name: requirementNameFromText(text),
        text
      });
    }
  }

  return requirements;
}

function requirementNameFromText(text) {
  const withoutPrefix = text
    .replace(/^The system MUST\s+/i, '')
    .replace(/^The system SHALL\s+/i, '')
    .replace(/\.$/, '');
  return titleFromWords(withoutPrefix.split(/\s+/).slice(0, 8).join(' '));
}

function scenarioThenText(text) {
  return text
    .replace(/^The system MUST\s+/i, 'the system must ')
    .replace(/^The system SHALL\s+/i, 'the system shall ')
    .replace(/\.$/, '.');
}

function extractTitle(content) {
  if (!hasText(content)) {
    return null;
  }

  const match = content.match(/^#\s+(.+?)\s*$/m);
  return match ? match[1].trim() : null;
}

function extractSection(content, headings) {
  if (!hasText(content)) {
    return null;
  }

  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^(#{2,6})\s+(.+?)\s*$/);
    if (!match || !headings.some((heading) => heading.toLowerCase() === match[2].trim().toLowerCase())) {
      continue;
    }

    const level = match[1].length;
    const body = [];
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const next = lines[cursor].match(/^(#{2,6})\s+/);
      if (next && next[1].length <= level) {
        break;
      }
      body.push(lines[cursor]);
    }

    const text = body.join('\n').trim();
    return text.length > 0 ? text : null;
  }

  return null;
}

function firstMeaningfulParagraph(content) {
  if (!hasText(content)) {
    return null;
  }

  return content
    .split(/\r?\n\r?\n/)
    .map((block) => block.trim())
    .find((block) => block.length > 0 && !block.startsWith('#')) ?? null;
}

function isDesignLike(content) {
  return hasText(content) && /\b(design|architecture|implementation|approach|adapter|middleware|callback|state)\b/i.test(content);
}

async function writeArtifact(rootDir, artifact) {
  const targetPath = resolveFromRoot(rootDir, artifact.target);
  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeFile(targetPath, artifact.content, 'utf8');
}

function assertSafeArtifactTarget(rootDir, changeId, artifact, options = {}) {
  const paths = getMigrationPathConfig(options);
  const targetPath = resolveFromRoot(rootDir, artifact.target);
  assertWithinRoot(rootDir, targetPath);
  assertNotLegacyPlanPath(rootDir, targetPath, paths);
  assertNotBaseSpecPath(rootDir, targetPath);

  if (artifact.bucket === 'canonical') {
    assertWithinDirectory(targetPath, resolveFromRoot(rootDir, path.join(paths.changesDir, changeId)), 'Canonical migration target must stay inside the OpenSpec change folder.');
    return;
  }

  if (artifact.bucket === 'state') {
    assertWithinDirectory(targetPath, resolveFromRoot(rootDir, path.join(paths.stateDir, changeId)), 'Runtime state migration target must stay inside the change state folder.');
    return;
  }

  if (artifact.bucket === 'qa') {
    assertWithinDirectory(targetPath, resolveFromRoot(rootDir, path.join(paths.qaDir, changeId)), 'QA migration target must stay inside the change QA folder.');
    return;
  }

  throw new Error(`Unknown migration artifact bucket: ${artifact.bucket}.`);
}

function assertWithinRoot(rootDir, targetPath) {
  assertWithinDirectory(targetPath, path.resolve(rootDir), 'Migration target escapes repository root.');
}

function assertNotLegacyPlanPath(rootDir, targetPath, options = {}) {
  const paths = getMigrationPathConfig(options);
  const legacyPlansPath = resolveFromRoot(rootDir, paths.plansDir);
  if (isWithinDirectory(targetPath, legacyPlansPath)) {
    throw new Error('Migration target must not write under legacy plan folders.');
  }
}

function assertNotBaseSpecPath(rootDir, targetPath) {
  const baseSpecsPath = resolveFromRoot(rootDir, path.join('openspec', 'specs'));
  if (isWithinDirectory(targetPath, baseSpecsPath)) {
    throw new Error('Migration target must not write under openspec/specs.');
  }
}

function assertWithinDirectory(targetPath, directoryPath, message) {
  if (!isWithinDirectory(targetPath, directoryPath)) {
    throw new Error(message);
  }
}

function isWithinDirectory(targetPath, directoryPath) {
  const relative = path.relative(path.resolve(directoryPath), path.resolve(targetPath));
  return relative.length === 0 || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function shouldExcludePlanEntry(name) {
  const lower = name.toLowerCase();
  return name.startsWith('.')
    || EXCLUDED_PLAN_NAMES.has(lower)
    || lower.endsWith('.bak')
    || lower.endsWith('.backup')
    || lower.includes('~');
}

function createSkippedUnsafeWarning(name) {
  return {
    code: 'skipped-unsafe-plan-entry',
    message: `Skipped unsafe legacy plan entry: ${name}.`
  };
}

function hasText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function titleFromId(id) {
  return titleFromWords(String(id).replace(/[-_]+/g, ' '));
}

function titleFromWords(value) {
  return String(value)
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`)
    .join(' ');
}

function resolveRootDir(options = {}) {
  return path.resolve(options.rootDir ?? process.cwd());
}

function resolveFromRoot(rootDir, value) {
  return path.resolve(rootDir, value);
}

function pathsOverlap(left, right) {
  const normalizedLeft = path.resolve(String(left));
  const normalizedRight = path.resolve(String(right));
  return isWithinDirectory(normalizedLeft, normalizedRight)
    || isWithinDirectory(normalizedRight, normalizedLeft);
}

async function realpathIfPresent(targetPath) {
  try {
    return await realpath(targetPath);
  } catch {
    return path.resolve(targetPath);
  }
}

async function relativeFileIfPresent(rootDir, targetPath) {
  return await isFile(targetPath)
    ? toPosix(path.relative(rootDir, targetPath))
    : null;
}

function invalidLegacyPlanSourceState(relativeStatePath, reason) {
  return {
    ok: false,
    exists: true,
    path: relativeStatePath,
    legacyPlanSourceRoot: null,
    warnings: [],
    errors: [{
      code: 'legacy-plan-source-state-invalid',
      message: `Legacy plan source state is invalid (${reason}): ${relativeStatePath}.`,
      path: relativeStatePath
    }]
  };
}

function toPosix(value) {
  return String(value).replaceAll('\\', '/');
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

async function isFile(targetPath) {
  try {
    const item = await stat(targetPath);
    return item.isFile();
  } catch {
    return false;
  }
}

function dedupeDiagnostics(diagnostics) {
  const seen = new Set();
  const result = [];

  for (const diagnostic of diagnostics) {
    const key = `${diagnostic.code ?? ''}:${diagnostic.message ?? ''}:${diagnostic.path ?? ''}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(diagnostic);
    }
  }

  return result;
}
