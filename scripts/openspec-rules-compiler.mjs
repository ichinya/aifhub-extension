// openspec-rules-compiler.mjs - derive AI Factory rule guidance from OpenSpec specs
import { createHash } from 'node:crypto';
import {
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  unlink,
  writeFile
} from 'node:fs/promises';
import path from 'node:path';
import { ensureRuntimeGitignore } from './runtime-gitignore.mjs';
import process from 'node:process';

import { detectOpenSpec as defaultDetectOpenSpec, showOpenSpecItem as defaultShowOpenSpecItem } from './openspec-runner.mjs';
import { normalizeChangeId, resolveActiveChange } from './active-change-resolver.mjs';

const GENERATED_DIR = path.join('.ai-factory', 'rules', 'generated');
const BASE_FILE = 'openspec-base.md';
const INDEX_FILE = 'index.json';
const TRACE_FILE_PREFIX = 'openspec-rules-trace-';
const PUBLIC_OPERATION_LIMIT = 200;
const MANAGED_FILE_PATTERNS = [
  { kind: 'change', pattern: /^openspec-change-(.+)\.md$/ },
  { kind: 'merged', pattern: /^openspec-merged-(.+)\.md$/ },
  { kind: 'trace', pattern: /^openspec-rules-trace-(.+)\.json$/ }
];
const SECTION_ORDER = new Map([
  ['Requirements', 0],
  ['ADDED Requirements', 1],
  ['MODIFIED Requirements', 2],
  ['REMOVED Requirements', 3]
]);

export async function compileOpenSpecRules(changeId, options = {}) {
  const rootDir = path.resolve(options.rootDir ?? process.cwd());
  const resolverResult = await resolveActiveChange({
    rootDir,
    cwd: options.cwd ?? process.cwd(),
    changeId,
    getCurrentBranch: options.getCurrentBranch
  });

  if (!resolverResult.ok) {
    return createCompilerResult({
      ok: false,
      warnings: resolverResult.warnings,
      errors: resolverResult.errors
    });
  }

  const collected = await collectOpenSpecRuleSources(resolverResult.changeId, {
    ...options,
    rootDir
  });

  if (!collected.ok) {
    return createCompilerResult({
      ok: false,
      changeId: resolverResult.changeId,
      mode: collected.mode,
      warnings: [...resolverResult.warnings, ...collected.warnings],
      errors: collected.errors,
      sources: collected.sources,
      openspecCli: collected.openspecCli
    });
  }

  const rendered = renderGeneratedRules(collected.sources, {
    ...options,
    changeId: resolverResult.changeId
  });
  const written = await writeGeneratedRules(resolverResult.changeId, rendered, {
    ...options,
    rootDir
  });

  if (!written.ok) {
    return createCompilerResult({
      ok: false,
      changeId: resolverResult.changeId,
      mode: collected.mode,
      warnings: [...resolverResult.warnings, ...collected.warnings, ...rendered.warnings, ...written.warnings],
      errors: written.errors,
      sources: collected.sources,
      files: written.files,
      openspecCli: collected.openspecCli
    });
  }

  return createCompilerResult({
    ok: true,
    changeId: resolverResult.changeId,
    mode: collected.mode,
    warnings: [...resolverResult.warnings, ...collected.warnings, ...rendered.warnings, ...written.warnings],
    errors: [],
    sources: collected.sources,
    files: written.files,
    openspecCli: collected.openspecCli
  });
}

export async function collectOpenSpecRuleSources(changeId, options = {}) {
  const rootDir = path.resolve(options.rootDir ?? process.cwd());
  const normalized = normalizeChangeId(changeId);

  if (!normalized.ok) {
    return createSourceResult({
      ok: false,
      errors: [normalized.error]
    });
  }

  const cli = await detectOpenSpecCapability(rootDir, options);
  const base = await collectOpenSpecBaseRuleSources({ ...options, rootDir, compilerCli: cli });
  const change = await collectOpenSpecChangeRuleSources(normalized.changeId, {
    ...options,
    rootDir,
    compilerCli: cli
  });

  if (!base.ok || !change.ok) {
    return createSourceResult({
      ok: false,
      warnings: dedupeDiagnostics([...(base.warnings ?? []), ...(change.warnings ?? [])]),
      errors: [...(base.errors ?? []), ...(change.errors ?? [])],
      sources: [...(base.sources ?? []), ...(change.sources ?? [])],
      openspecCli: summarizeOpenSpecDetection(cli.detection)
    });
  }

  const sources = sortSources([...base.sources, ...change.sources]);

  return createSourceResult({
    ok: true,
    mode: chooseMode(sources, cli),
    warnings: dedupeDiagnostics([...(base.warnings ?? []), ...(change.warnings ?? [])]),
    sources,
    openspecCli: summarizeOpenSpecDetection(cli.detection)
  });
}

export async function compileOpenSpecBaseRules(options = {}) {
  const rootDir = path.resolve(options.rootDir ?? process.cwd());
  const collected = await collectOpenSpecBaseRuleSources({
    ...options,
    rootDir
  });

  if (!collected.ok) {
    return createCompilerResult({
      ok: false,
      changeId: null,
      mode: collected.mode,
      warnings: collected.warnings,
      errors: collected.errors,
      sources: collected.sources,
      openspecCli: collected.openspecCli
    });
  }

  const rendered = renderDocument({
    kind: 'base',
    title: 'Base OpenSpec Rules',
    changeId: null,
    sources: sortSources(collected.sources),
    emptyMessage: 'No base OpenSpec requirements found.'
  });
  const written = await writeGeneratedBaseRules(rendered, {
    ...options,
    rootDir,
    generatedAt: resolveGeneratedAt(options),
    indexBase: renderIndexBaseEntry(sortSources(collected.sources))
  });

  if (!written.ok) {
    return createCompilerResult({
      ok: false,
      changeId: null,
      mode: collected.mode,
      warnings: [...collected.warnings, ...written.warnings],
      errors: written.errors,
      sources: collected.sources,
      files: written.files,
      openspecCli: collected.openspecCli
    });
  }

  return createCompilerResult({
    ok: true,
    changeId: null,
    mode: collected.mode,
    warnings: [...collected.warnings, ...written.warnings],
    errors: [],
    sources: collected.sources,
    files: written.files,
    openspecCli: collected.openspecCli
  });
}

export async function collectOpenSpecBaseRuleSources(options = {}) {
  const rootDir = path.resolve(options.rootDir ?? process.cwd());
  const fileOps = resolveCompilerFileOps(options);
  const warnings = [];
  const cli = options.compilerCli ?? await detectOpenSpecCapability(rootDir, options);
  warnings.push(...cli.warnings);

  const baseSpecsDir = path.join(rootDir, 'openspec', 'specs');
  const baseInventory = await collectSpecFiles(baseSpecsDir, {
    rootDir,
    fileOps,
    sourceKind: 'base'
  });
  if (!baseInventory.ok) {
    return createSourceResult({
      ok: false,
      warnings: dedupeDiagnostics(warnings),
      errors: baseInventory.errors,
      sources: [],
      openspecCli: summarizeOpenSpecDetection(cli.detection)
    });
  }
  const baseFiles = baseInventory.files;
  const sources = [];

  for (const filePath of baseFiles) {
    const source = await readRuleSource(filePath, {
      rootDir,
      kind: 'base',
      specsDir: baseSpecsDir,
      changeId: null,
      cli,
      fileOps
    });
    warnings.push(...source.warnings);
    sources.push(source.item);
  }

  return createSourceResult({
    ok: true,
    mode: chooseMode(sources, cli),
    warnings: dedupeDiagnostics(warnings),
    sources: sortSources(sources),
    openspecCli: summarizeOpenSpecDetection(cli.detection)
  });
}

export async function collectOpenSpecChangeRuleSources(changeId, options = {}) {
  const rootDir = path.resolve(options.rootDir ?? process.cwd());
  const fileOps = resolveCompilerFileOps(options);
  const normalized = normalizeChangeId(changeId);

  if (!normalized.ok) {
    return createSourceResult({ ok: false, errors: [normalized.error] });
  }

  const resolvedChangeId = normalized.changeId;
  const changeDir = path.join(rootDir, 'openspec', 'changes', resolvedChangeId);
  const changeRoot = await inspectCanonicalDirectoryPath(rootDir, changeDir, {
    fileOps,
    allowMissing: true,
    unsafeCode: 'openspec-source-root-unsafe',
    unsafeMessage: 'The canonical OpenSpec change source root must be a direct regular directory inside the project.',
    readCode: 'openspec-source-inventory-read-failed',
    readMessage: 'Unable to inspect the canonical OpenSpec change source root.',
    sourceKind: 'change',
    changeId: resolvedChangeId
  });

  if (!changeRoot.ok) {
    return createSourceResult({ ok: false, errors: changeRoot.errors });
  }
  if (changeRoot.missing) {
    return createSourceResult({
      ok: false,
      errors: [{
        code: 'explicit-change-not-found',
        message: `OpenSpec change '${resolvedChangeId}' was not found.`
      }]
    });
  }

  const warnings = [];
  const cli = options.compilerCli ?? await detectOpenSpecCapability(rootDir, options);
  warnings.push(...cli.warnings);
  const changeSpecsDir = path.join(changeDir, 'specs');
  const changeInventory = await collectSpecFiles(changeSpecsDir, {
    rootDir,
    fileOps,
    sourceKind: 'change',
    changeId: resolvedChangeId
  });
  if (!changeInventory.ok) {
    return createSourceResult({
      ok: false,
      warnings: dedupeDiagnostics(warnings),
      errors: changeInventory.errors,
      sources: [],
      openspecCli: summarizeOpenSpecDetection(cli.detection)
    });
  }
  const changeFiles = changeInventory.files;
  const sources = [];

  for (const filePath of changeFiles) {
    const source = await readRuleSource(filePath, {
      rootDir,
      kind: 'change',
      specsDir: changeSpecsDir,
      changeId: resolvedChangeId,
      cli,
      fileOps
    });
    warnings.push(...source.warnings);
    sources.push(source.item);
  }

  return createSourceResult({
    ok: true,
    mode: chooseMode(sources, cli),
    warnings: dedupeDiagnostics(warnings),
    sources: sortSources(sources),
    openspecCli: summarizeOpenSpecDetection(cli.detection)
  });
}

export async function inventoryOpenSpecChanges(options = {}) {
  const rootDir = path.resolve(options.rootDir ?? process.cwd());
  const fileOps = resolveCompilerFileOps(options);
  const changesRoot = path.join(rootDir, 'openspec', 'changes');
  const rootInspection = await inspectCanonicalDirectoryPath(rootDir, changesRoot, {
    fileOps,
    allowMissing: Boolean(options.allowMissingRoot || options.dryRun),
    unsafeCode: 'active-inventory-root-unsafe',
    unsafeMessage: 'The authoritative OpenSpec active-change root must be a direct regular directory inside the project.',
    readCode: 'active-inventory-read-failed',
    readMessage: 'Unable to inspect the authoritative OpenSpec active-change root.'
  });

  if (!rootInspection.ok) {
    return createActiveInventoryResult({ ok: false, errors: rootInspection.errors });
  }
  if (rootInspection.missing) {
    return createActiveInventoryResult({ missing: true });
  }
  let entries;

  try {
    entries = await fileOps.readdir(changesRoot, { withFileTypes: true });
  } catch (err) {
    return createActiveInventoryResult({
      ok: false,
      errors: [{
        code: 'active-inventory-read-failed',
        message: 'Unable to read the authoritative OpenSpec active-change inventory.'
      }]
    });
  }

  const changeIds = [];
  const inventoryEntries = [];
  const errors = [];

  for (const entry of Array.from(entries).sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name === 'archive' || entry.name.startsWith('.')) {
      continue;
    }

    const normalized = normalizeChangeId(entry.name);
    if (!normalized.ok) {
      continue;
    }

    const targetPath = path.join(changesRoot, entry.name);
    let targetStat;

    try {
      targetStat = await fileOps.lstat(targetPath);
    } catch {
      errors.push({
        code: 'active-inventory-read-failed',
        message: `Unable to inspect active OpenSpec change '${normalized.changeId}'.`,
        changeId: normalized.changeId
      });
      continue;
    }

    const unsafe = targetStat.isSymbolicLink?.() || !targetStat.isDirectory?.();
    inventoryEntries.push({
      changeId: normalized.changeId,
      type: unsafe ? 'unsafe' : 'directory'
    });

    if (unsafe) {
      errors.push({
        code: 'unsafe-active-change-entry',
        message: `Active OpenSpec change '${normalized.changeId}' is not a direct regular directory.`,
        changeId: normalized.changeId
      });
      continue;
    }

    changeIds.push(normalized.changeId);
  }

  const sortedChangeIds = [...new Set(changeIds)].sort((left, right) => left.localeCompare(right));
  const snapshot = fingerprintValue({
    missing: false,
    root: rootInspection.identity,
    entries: inventoryEntries.sort((left, right) => left.changeId.localeCompare(right.changeId))
  });

  return createActiveInventoryResult({
    ok: errors.length === 0,
    changeIds: sortedChangeIds,
    changes: sortedChangeIds.map((id) => ({ id, path: `openspec/changes/${id}` })),
    snapshot,
    errors
  });
}

export async function inspectOpenSpecGeneratedRules(options = {}) {
  const rootDir = path.resolve(options.rootDir ?? process.cwd());
  const layout = validateGeneratedRulesLayout(rootDir, options.generatedRulesPath);

  if (!layout.ok) {
    return createGeneratedRulesInspection({
      ok: false,
      state: 'invalid',
      errors: layout.errors
    });
  }

  const active = normalizeChangeIdList(options.activeChangeIds ?? []);
  if (!active.ok) {
    return createGeneratedRulesInspection({
      ok: false,
      state: 'invalid',
      errors: active.errors
    });
  }

  const store = await inspectGeneratedRulesStore({
    ...options,
    rootDir,
    generatedDir: layout.generatedDir
  });
  const caseAliasErrors = inspectGeneratedCaseAliases(store.childNames, active.changeIds);
  const activeSet = new Set(active.changeIds);
  const indexedIds = store.index.state === 'valid'
    ? store.index.value.changes.map((entry) => entry.change_id)
    : [];
  const indexedSet = new Set(indexedIds);
  const orphanedIndexEntries = indexedIds.filter((changeId) => !activeSet.has(changeId));
  const orphanedManagedFiles = store.managedFiles
    .filter((item) => !activeSet.has(item.changeId))
    .map((item) => item.relativePath);
  const missingActiveIndexEntries = active.changeIds.filter((changeId) => !indexedSet.has(changeId));
  const managedNames = new Set(store.managedFiles.map((item) => item.fileName));
  const missingActiveManagedFiles = active.changeIds.flatMap((changeId) =>
    expectedChangeOutputs(changeId)
      .filter((item) => !managedNames.has(item.fileName))
      .map((item) => `${GENERATED_DIR.replaceAll(path.sep, '/')}/${item.fileName}`)
  );
  const missing = [];

  if (!store.childNames.includes(BASE_FILE)) {
    missing.push(`${GENERATED_DIR.replaceAll(path.sep, '/')}/${BASE_FILE}`);
  }
  if (store.index.state === 'missing') {
    missing.push(`${GENERATED_DIR.replaceAll(path.sep, '/')}/${INDEX_FILE}`);
  }
  missing.push(...missingActiveManagedFiles);

  const invalid = !store.ok || store.index.state === 'malformed' || caseAliasErrors.length > 0;
  const drift = orphanedIndexEntries.length > 0 || orphanedManagedFiles.length > 0;
  const state = invalid
    ? 'invalid'
    : drift
      ? 'stale'
      : missing.length > 0 || missingActiveIndexEntries.length > 0
        ? 'missing'
        : 'ok';

  return createGeneratedRulesInspection({
    ok: !invalid,
    state,
    indexState: store.index.state,
    activeChangeIds: active.changeIds,
    indexedChangeIds: [...indexedIds].sort((left, right) => left.localeCompare(right)),
    orphanedIndexEntries: [...new Set(orphanedIndexEntries)].sort((left, right) => left.localeCompare(right)),
    orphanedManagedFiles: [...new Set(orphanedManagedFiles)].sort((left, right) => left.localeCompare(right)),
    missingActiveIndexEntries,
    missingActiveManagedFiles: [...new Set(missingActiveManagedFiles)].sort((left, right) => left.localeCompare(right)),
    invalidManagedEntries: [...new Set([
      ...store.invalidManagedEntries.map((item) => item.relativePath),
      ...caseAliasErrors.map((item) => item.conflictingPath)
    ])].sort((left, right) => left.localeCompare(right)),
    missing: [...new Set(missing)].sort((left, right) => left.localeCompare(right)),
    warnings: store.warnings,
    errors: dedupeDiagnostics([
      ...store.errors,
      ...(store.index.state === 'malformed' ? store.index.diagnostics : []),
      ...caseAliasErrors
    ])
  });
}

export async function reconcileOpenSpecGeneratedRules(options = {}) {
  const rootDir = path.resolve(options.rootDir ?? process.cwd());
  const dryRun = Boolean(options.dryRun);
  const generatedAt = resolveGeneratedAt(options);
  const layout = validateGeneratedRulesLayout(rootDir, options.generatedRulesPath);
  const fileOps = resolveCompilerFileOps(options);

  if (!layout.ok) {
    return createReconcileResult({ dryRun, errors: layout.errors });
  }

  const initialInventory = await inventoryOpenSpecChanges({
    ...options,
    rootDir,
    allowMissingRoot: dryRun || Boolean(options.allowMissingChangesRoot)
  });
  if (!initialInventory.ok) {
    return createReconcileResult({ dryRun, errors: initialInventory.errors });
  }

  const suppliedActive = options.activeChangeIds === undefined
    ? { ok: true, changeIds: initialInventory.changeIds, errors: [] }
    : normalizeChangeIdList(options.activeChangeIds);
  if (!suppliedActive.ok) {
    return createReconcileResult({ dryRun, errors: suppliedActive.errors });
  }
  if (!sameStringSet(suppliedActive.changeIds, initialInventory.changeIds)) {
    return createReconcileResult({
      dryRun,
      errors: [{
        code: 'active-inventory-mismatch',
        message: 'The supplied active-change inventory does not match the authoritative filesystem inventory.'
      }]
    });
  }

  const activeChangeIds = initialInventory.changeIds;
  const selected = normalizeChangeIdList(options.selectedChangeIds ?? []);
  if (!selected.ok) {
    return createReconcileResult({ dryRun, activeChangeIds, errors: selected.errors });
  }

  const selectionSource = options.selectionSource ?? 'all';
  const selectionErrors = validateReconcileSelection(selectionSource, activeChangeIds, selected.changeIds);
  if (selectionErrors.length > 0) {
    return createReconcileResult({
      dryRun,
      activeChangeIds,
      selectedChangeIds: selected.changeIds,
      selectionSource,
      errors: selectionErrors
    });
  }

  const store = await inspectGeneratedRulesStore({
    ...options,
    rootDir,
    generatedDir: layout.generatedDir
  });
  if (!store.ok) {
    return createReconcileResult({
      dryRun,
      activeChangeIds,
      selectedChangeIds: selected.changeIds,
      selectionSource,
      errors: store.errors
    });
  }

  const caseAliasErrors = inspectGeneratedCaseAliases(store.childNames, activeChangeIds);
  if (caseAliasErrors.length > 0) {
    return createReconcileResult({
      dryRun,
      activeChangeIds,
      selectedChangeIds: selected.changeIds,
      selectionSource,
      errors: caseAliasErrors
    });
  }

  const completeCoverage = sameStringSet(activeChangeIds, selected.changeIds);
  if (store.index.state === 'malformed' && activeChangeIds.length > 0 && !completeCoverage) {
    return createReconcileResult({
      dryRun,
      activeChangeIds,
      selectedChangeIds: selected.changeIds,
      selectionSource,
      errors: [{
        code: 'generated-index-rebuild-incomplete',
        message: 'Malformed generated-rules index cannot be rebuilt without complete active-change coverage.'
      }, ...store.index.diagnostics]
    });
  }

  const collectBaseSources = options.collectBaseSources ?? collectOpenSpecBaseRuleSources;
  const collectChangeSources = options.collectChangeSources ?? collectOpenSpecChangeRuleSources;
  const compilerCli = await detectOpenSpecCapability(rootDir, options);
  let baseResult;
  const changeResults = new Map();

  try {
    baseResult = await collectBaseSources({ ...options, rootDir, compilerCli });
    if (!baseResult?.ok) {
      throw createPreparationError('base', null, baseResult?.errors);
    }

    for (const changeId of selected.changeIds) {
      const changeResult = await collectChangeSources(changeId, { ...options, rootDir, compilerCli });
      if (!changeResult?.ok) {
        throw createPreparationError('change', changeId, changeResult?.errors);
      }
      changeResults.set(changeId, changeResult);
    }
  } catch (err) {
    const detail = err?.preparationDiagnostic ?? {
      code: 'generated-rules-prepare-failed',
      message: 'Generated-rules batch preparation failed before any mutation.',
      phase: 'collect'
    };
    return createReconcileResult({
      dryRun,
      activeChangeIds,
      selectedChangeIds: selected.changeIds,
      selectionSource,
      warnings: dedupeDiagnostics([...(baseResult?.warnings ?? []), ...compilerCli.warnings]),
      errors: [detail]
    });
  }

  const preparedSourceSnapshot = fingerprintPreparedRuleSources(
    baseResult,
    changeResults,
    selected.changeIds
  );

  const prepared = prepareGeneratedRulesBatch({
    baseSources: baseResult.sources,
    changeResults,
    selectedChangeIds: selected.changeIds,
    generatedAt
  });
  if (!prepared.ok) {
    return createReconcileResult({
      dryRun,
      activeChangeIds,
      selectedChangeIds: selected.changeIds,
      selectionSource,
      warnings: dedupeDiagnostics([...(baseResult.warnings ?? []), ...compilerCli.warnings]),
      errors: prepared.errors
    });
  }

  const currentContents = new Map();
  try {
    for (const file of prepared.files) {
      currentContents.set(file.fileName, await readOptionalGeneratedFile(
        path.join(layout.generatedDir, file.fileName),
        fileOps
      ));
    }
  } catch {
    return createReconcileResult({
      dryRun,
      activeChangeIds,
      selectedChangeIds: selected.changeIds,
      selectionSource,
      errors: [{
        code: 'generated-output-read-failed',
        message: 'Unable to read a compiler-owned generated output during preflight.'
      }]
    });
  }

  const preparedEntries = new Map();
  for (const changeId of selected.changeIds) {
    const traceFile = prepared.files.find((file) => file.kind === 'trace' && file.changeId === changeId);
    const reused = reuseTraceTimestamp(currentContents.get(traceFile.fileName), traceFile.content);
    if (reused.reused) {
      traceFile.content = reused.content;
    }
    preparedEntries.set(changeId, renderIndexChangeEntry(
      changeId,
      traceFile.fileName,
      reused.generatedAt ?? generatedAt
    ));
  }

  const existingChanges = store.index.state === 'valid' ? store.index.value.changes : [];
  const existingIndexedSet = new Set(existingChanges.map((entry) => entry.change_id));
  const activeSet = new Set(activeChangeIds);
  const selectedSet = new Set(selected.changeIds);
  const retainedEntries = selectionSource === 'all' || selectionSource === 'none'
    ? []
    : existingChanges.filter((entry) => activeSet.has(entry.change_id) && !selectedSet.has(entry.change_id));
  const desiredChanges = [
    ...retainedEntries,
    ...selected.changeIds.map((changeId) => preparedEntries.get(changeId))
  ].sort((left, right) => left.change_id.localeCompare(right.change_id));
  const desiredCore = {
    schema_version: 1,
    base: prepared.indexBase,
    changes: desiredChanges
  };
  const existingCore = store.index.state === 'valid'
    ? {
      schema_version: 1,
      base: store.index.value.base,
      changes: store.index.value.changes
    }
    : null;
  const indexUnchanged = existingCore !== null && equalJson(existingCore, desiredCore);
  const desiredIndex = {
    schema_version: 1,
    generated_at: indexUnchanged ? store.index.value.generated_at : generatedAt,
    base: desiredCore.base,
    changes: desiredCore.changes
  };
  const desiredIndexContent = indexUnchanged
    ? store.index.raw
    : `${JSON.stringify(desiredIndex, null, 2)}\n`;
  const indexFile = {
    kind: 'index',
    changeId: null,
    fileName: INDEX_FILE,
    content: desiredIndexContent
  };
  const plannedFiles = [...prepared.files, indexFile];
  currentContents.set(INDEX_FILE, store.index.raw);

  const writes = plannedFiles.filter((file) => currentContents.get(file.fileName) !== file.content);
  const orphanedManaged = store.managedFiles.filter((item) => !activeSet.has(item.changeId));
  const orphanedIndexIds = existingChanges
    .map((entry) => entry.change_id)
    .filter((changeId) => !activeSet.has(changeId));
  const removedChangeIds = [...new Set([
    ...orphanedIndexIds,
    ...orphanedManaged.map((item) => item.changeId)
  ])].sort((left, right) => left.localeCompare(right));
  let ignore;
  try {
    ignore = await ensureRuntimeGitignore(rootDir, layout.generatedDir, { dryRun: true });
  } catch {
    return createReconcileResult({ dryRun, errors: [{
      code: 'unsafe-generated-gitignore', message: 'Generated rules require a safe local .gitignore file.'
    }] });
  }
  const operations = [
    ...(ignore.action === 'would-create' ? [{ ...ignore, action: dryRun ? 'would-write' : 'write', kind: 'gitignore' }] : []),
    ...writes.map((file) => ({
      action: dryRun ? 'would-write' : 'write',
      kind: file.kind,
      target: `${GENERATED_DIR.replaceAll(path.sep, '/')}/${file.fileName}`,
      ...(file.changeId ? { change_id: file.changeId } : {})
    })),
    ...orphanedManaged.map((item) => ({
      action: dryRun ? 'would-remove' : 'remove',
      kind: item.kind,
      target: item.relativePath,
      change_id: item.changeId
    }))
  ].sort(compareOperations);
  const files = plannedFiles.map((file) => ({
    kind: file.kind,
    relativePath: `${GENERATED_DIR.replaceAll(path.sep, '/')}/${file.fileName}`,
    changed: writes.includes(file),
    written: !dryRun && writes.includes(file),
    ...(file.changeId ? { changeId: file.changeId } : {})
  }));
  const warnings = dedupeDiagnostics([
    ...(baseResult.warnings ?? []),
    ...[...changeResults.values()].flatMap((result) => result.warnings ?? []),
    ...compilerCli.warnings
  ]);
  const baseResultFields = {
    dryRun,
    selectionSource,
    activeChangeIds,
    selectedChangeIds: selected.changeIds,
    retainedChangeIds: retainedEntries.map((entry) => entry.change_id),
    removedChangeIds,
    orphanedIndexEntries: [...new Set(orphanedIndexIds)].sort((left, right) => left.localeCompare(right)),
    orphanedManagedFiles: orphanedManaged.map((item) => item.relativePath),
    missingActiveIndexEntries: activeChangeIds.filter((changeId) => !existingIndexedSet.has(changeId)),
    baseOnly: selected.changeIds.length === 0,
    changeSpecificSkipped: selected.changeIds.length === 0,
    openspecCli: summarizeOpenSpecDetection(compilerCli.detection),
    files,
    operations,
    warnings
  };

  if (dryRun || operations.length === 0) {
    return createReconcileResult({ ok: true, ...baseResultFields });
  }

  const initialSnapshot = fingerprintValue({
    active: initialInventory.snapshot,
    generated: store.snapshot
  });
  let mutationCount = 0;

  try {
    await options.beforeCommit?.({
      activeChangeIds: [...activeChangeIds],
      selectedChangeIds: [...selected.changeIds],
      operations: operations.map((item) => ({ ...item }))
    });
    const currentInventory = await inventoryOpenSpecChanges({
      ...options,
      rootDir,
      allowMissingRoot: false
    });
    const currentStore = currentInventory.ok
      ? await inspectGeneratedRulesStore({ ...options, rootDir, generatedDir: layout.generatedDir })
      : null;
    const currentCaseAliasErrors = currentInventory.ok && currentStore?.ok
      ? inspectGeneratedCaseAliases(currentStore.childNames, currentInventory.changeIds)
      : [];
    if (currentCaseAliasErrors.length > 0) {
      return createReconcileResult({
        ...baseResultFields,
        errors: currentCaseAliasErrors
      });
    }
    const currentSnapshot = currentInventory.ok && currentStore?.ok
      ? fingerprintValue({ active: currentInventory.snapshot, generated: currentStore.snapshot })
      : null;

    if (currentSnapshot !== initialSnapshot) {
      return createReconcileResult({
        ...baseResultFields,
        errors: [{
          code: 'generated-rules-inventory-conflict',
          message: 'Generated-rules inventory changed after preflight; no mutation was performed.'
        }]
      });
    }

    const currentSourceSnapshot = await fingerprintCurrentRuleSources(
      rootDir,
      selected.changeIds,
      fileOps
    );
    if (!currentSourceSnapshot.ok || currentSourceSnapshot.snapshot !== preparedSourceSnapshot) {
      return createReconcileResult({
        ...baseResultFields,
        errors: [{
          code: 'generated-rules-source-conflict',
          message: 'Canonical OpenSpec rule sources changed after preparation; no mutation was performed.',
          ...(!currentSourceSnapshot.ok
            ? { causeCodes: currentSourceSnapshot.errors.map((item) => item.code).filter(Boolean).slice(0, 20) }
            : {})
        }]
      });
    }

    await fileOps.mkdir(layout.generatedDir, { recursive: true });
    if (store.missingRoot) {
      mutationCount += 1;
    }
    const commitRoot = await inspectCanonicalDirectoryPath(rootDir, layout.generatedDir, {
      fileOps,
      allowMissing: false,
      unsafeCode: 'generated-rules-root-conflict',
      unsafeMessage: 'The canonical generated-rules root changed after preflight; publishing was stopped.',
      readCode: 'generated-rules-root-conflict',
      readMessage: 'The canonical generated-rules root could not be revalidated before publishing.'
    });
    if (
      !commitRoot.ok
      || commitRoot.missing
      || (!store.missingRoot && !sameDirectoryIdentity(currentStore.rootIdentity, commitRoot.identity))
    ) {
      throw createCommitDiagnostic(
        'generated-rules-root-conflict',
        'The canonical generated-rules root changed after preflight; publishing was stopped.'
      );
    }
    const expectedRootIdentity = commitRoot.identity;
    const ignoreResult = await ensureRuntimeGitignore(rootDir, layout.generatedDir);
    if (ignoreResult.action === 'create') mutationCount += 1;

    for (const file of writes.filter((item) => item.kind !== 'index')) {
      await options.beforeWrite?.({
        action: 'write',
        kind: file.kind,
        target: `${GENERATED_DIR.replaceAll(path.sep, '/')}/${file.fileName}`,
        ...(file.changeId ? { change_id: file.changeId } : {})
      });
      await replaceGeneratedFileAtomically({
        rootDir,
        generatedDir: layout.generatedDir,
        fileName: file.fileName,
        content: file.content,
        fileOps,
        tempToken: options.tempToken,
        expectedRootIdentity
      });
      mutationCount += 1;
    }

    if (writes.some((item) => item.kind === 'index')) {
      await options.beforeWrite?.({
        action: 'write',
        kind: 'index',
        target: `${GENERATED_DIR.replaceAll(path.sep, '/')}/${INDEX_FILE}`
      });
      await replaceGeneratedIndexAtomically({
        rootDir,
        generatedDir: layout.generatedDir,
        content: desiredIndexContent,
        fileOps,
        tempToken: options.tempToken,
        expectedRootIdentity
      });
      mutationCount += 1;
    }

    for (const item of orphanedManaged) {
      await options.beforeRemove?.({
        action: 'remove',
        kind: item.kind,
        target: item.relativePath,
        change_id: item.changeId
      });
      await assertGeneratedRootIdentity({
        rootDir,
        generatedDir: layout.generatedDir,
        fileOps,
        expectedRootIdentity
      });
      const targetPath = path.join(layout.generatedDir, item.fileName);
      const targetStat = await fileOps.lstat(targetPath);
      if (targetStat.isSymbolicLink?.() || !targetStat.isFile?.()) {
        throw new Error('managed cleanup target changed type after preflight');
      }
      await fileOps.unlink(targetPath);
      mutationCount += 1;
    }
  } catch (err) {
    const partial = mutationCount > 0 || Boolean(err?.commitMutation);
    const commitDiagnostic = !partial ? err?.commitDiagnostic : null;
    return createReconcileResult({
      ...baseResultFields,
      partial,
      errors: [commitDiagnostic ?? {
        code: partial ? 'generated-rules-partial-failure' : 'generated-rules-commit-failed',
        message: partial
          ? 'Generated-rules reconciliation failed after mutation began; status/doctor must inspect the partial state.'
          : 'Generated-rules reconciliation commit failed before any mutation.'
      }]
    });
  }

  return createReconcileResult({ ok: true, ...baseResultFields });
}

export function renderGeneratedRules(sources, options = {}) {
  const normalized = normalizeChangeId(options.changeId);
  const changeId = normalized.ok ? normalized.changeId : options.changeId;
  const generatedAt = resolveGeneratedAt(options);
  const sortedSources = sortSources(Array.from(sources ?? []));
  const baseSources = sortedSources.filter((source) => source.kind === 'base');
  const changeSources = sortedSources.filter((source) => source.kind === 'change');
  const baseContent = renderDocument({
    kind: 'base',
    title: 'Base OpenSpec Rules',
    changeId,
    sources: baseSources,
    emptyMessage: 'No base OpenSpec requirements found.'
  });
  const changeContent = renderDocument({
    kind: 'change',
    title: 'Change OpenSpec Rules',
    changeId,
    sources: changeSources,
    emptyMessage: 'No OpenSpec change requirements found.'
  });
  const mergedContent = renderDocument({
    kind: 'merged',
    title: 'Merged OpenSpec Rules',
    changeId,
    sources: sortedSources,
    emptyMessage: 'No OpenSpec requirements found.'
  });
  const traceFileName = `${TRACE_FILE_PREFIX}${changeId}.json`;
  const markdownFiles = [
    {
      kind: 'base',
      fileName: BASE_FILE,
      content: baseContent
    },
    {
      kind: 'change',
      fileName: `openspec-change-${changeId}.md`,
      content: changeContent
    },
    {
      kind: 'merged',
      fileName: `openspec-merged-${changeId}.md`,
      content: mergedContent
    }
  ];
  const traceContent = renderTraceDocument(sortedSources, {
    changeId,
    generatedAt,
    outputs: renderTraceOutputs(markdownFiles)
  });

  return {
    ok: true,
    changeId,
    generatedAt,
    warnings: [],
    indexBase: renderIndexBaseEntry(baseSources),
    indexEntry: renderIndexChangeEntry(changeId, traceFileName, generatedAt),
    files: [
      ...markdownFiles,
      {
        kind: 'trace',
        fileName: traceFileName,
        content: traceContent
      }
    ]
  };
}

export async function writeGeneratedRules(changeId, rendered, options = {}) {
  const rootDir = path.resolve(options.rootDir ?? process.cwd());
  const normalized = normalizeChangeId(changeId);

  if (!normalized.ok) {
    return createWriteResult({
      ok: false,
      errors: [normalized.error]
    });
  }

  const generatedDir = path.resolve(rootDir, GENERATED_DIR);
  const renderedFiles = Array.from(rendered?.files ?? []);
  const expectedNames = new Set([
    BASE_FILE,
    `openspec-change-${normalized.changeId}.md`,
    `openspec-merged-${normalized.changeId}.md`,
    `${TRACE_FILE_PREFIX}${normalized.changeId}.json`
  ]);
  const renderedNames = renderedFiles.map((file) => file.fileName);
  const renderedNameSet = new Set(renderedNames);
  const files = [];

  if (
    renderedFiles.length !== expectedNames.size
    || renderedNameSet.size !== expectedNames.size
    || renderedNames.some((fileName) => !expectedNames.has(fileName))
  ) {
    return createWriteResult({
      ok: false,
      errors: [
        {
          code: 'invalid-rendered-files',
          message: 'Rendered rules must contain exactly the base, change, merged, and trace generated files.'
        }
      ]
    });
  }

  if (!options.dryRun) {
    await ensureRuntimeGitignore(rootDir, generatedDir);
    await mkdir(generatedDir, { recursive: true });
  }

  for (const renderedFile of renderedFiles) {
    const targetPath = path.resolve(generatedDir, renderedFile.fileName);

    if (!isWithinDirectory(targetPath, generatedDir)) {
      return createWriteResult({
        ok: false,
        files,
        errors: [
          {
            code: 'unsafe-generated-path',
            message: `Generated output path escapes '${GENERATED_DIR}': ${renderedFile.fileName}`
          }
        ]
      });
    }

    if (!options.dryRun) {
      await writeFile(targetPath, renderedFile.content, 'utf8');
    }
    files.push(createGeneratedFileResult({
      kind: renderedFile.kind,
      rootDir,
      targetPath,
      written: !options.dryRun
    }));
  }

  const index = await writeGeneratedIndex({
    rootDir,
    generatedDir,
    generatedAt: rendered?.generatedAt ?? resolveGeneratedAt(options),
    base: rendered?.indexBase ?? renderIndexBaseEntry([]),
    changeEntry: rendered?.indexEntry ?? renderIndexChangeEntry(
      normalized.changeId,
      `${TRACE_FILE_PREFIX}${normalized.changeId}.json`,
      rendered?.generatedAt ?? resolveGeneratedAt(options)
    ),
    dryRun: Boolean(options.dryRun),
    resetChanges: false
  });
  files.push(...index.files);

  return createWriteResult({
    ok: true,
    files,
    warnings: index.warnings
  });
}

async function writeGeneratedBaseRules(content, options = {}) {
  const rootDir = path.resolve(options.rootDir ?? process.cwd());
  const generatedDir = path.resolve(rootDir, GENERATED_DIR);
  const targetPath = path.resolve(generatedDir, BASE_FILE);

  if (!isWithinDirectory(targetPath, generatedDir)) {
    return createWriteResult({
      errors: [
        {
          code: 'unsafe-generated-path',
          message: `Generated output path escapes '${GENERATED_DIR}': ${BASE_FILE}`
        }
      ]
    });
  }

  if (options.dryRun) {
    return createWriteResult({
      ok: true,
      files: [
        createGeneratedFileResult({
          kind: 'base',
          rootDir,
          targetPath,
          written: false
        }),
        createGeneratedFileResult({
          kind: 'index',
          rootDir,
          targetPath: path.resolve(generatedDir, INDEX_FILE),
          written: false
        })
      ]
    });
  }

  await ensureRuntimeGitignore(rootDir, generatedDir);
  await mkdir(generatedDir, { recursive: true });
  await writeFile(targetPath, content, 'utf8');
  const index = await writeGeneratedIndex({
    rootDir,
    generatedDir,
    generatedAt: options.generatedAt ?? resolveGeneratedAt(options),
    base: options.indexBase ?? renderIndexBaseEntry([]),
    dryRun: false,
    resetChanges: Boolean(options.resetIndexChanges)
  });

  return createWriteResult({
    ok: true,
    files: [
      createGeneratedFileResult({
        kind: 'base',
        rootDir,
        targetPath,
        written: true
      }),
      ...index.files
    ],
    warnings: index.warnings
  });
}

async function writeGeneratedIndex({
  rootDir,
  generatedDir,
  generatedAt,
  base,
  changeEntry = null,
  dryRun = false,
  resetChanges = false
}) {
  const targetPath = path.resolve(generatedDir, INDEX_FILE);

  if (!isWithinDirectory(targetPath, generatedDir)) {
    return createWriteResult({
      errors: [
        {
          code: 'unsafe-generated-path',
          message: `Generated output path escapes '${GENERATED_DIR}': ${INDEX_FILE}`
        }
      ]
    });
  }

  const files = [
    createGeneratedFileResult({
      kind: 'index',
      rootDir,
      targetPath,
      written: !dryRun
    })
  ];

  if (dryRun) {
    return createWriteResult({
      ok: true,
      files
    });
  }

  const existing = resetChanges ? createEmptyGeneratedIndex(generatedAt) : await readGeneratedIndex(targetPath, generatedAt);
  const changes = resetChanges
    ? []
    : Array.from(existing.changes ?? []).filter((entry) => entry?.change_id !== changeEntry?.change_id);

  if (changeEntry !== null) {
    changes.push(changeEntry);
  }

  const index = {
    schema_version: 1,
    generated_at: generatedAt,
    base,
    changes: changes
      .filter((entry) => typeof entry?.change_id === 'string' && entry.change_id.length > 0)
      .sort((left, right) => left.change_id.localeCompare(right.change_id))
  };

  await writeFile(targetPath, `${JSON.stringify(index, null, 2)}\n`, 'utf8');

  return createWriteResult({
    ok: true,
    files
  });
}

async function readGeneratedIndex(targetPath, generatedAt) {
  try {
    const parsed = JSON.parse(await readFile(targetPath, 'utf8'));

    if (parsed?.schema_version !== 1 || !Array.isArray(parsed.changes)) {
      return createEmptyGeneratedIndex(generatedAt);
    }

    return {
      schema_version: 1,
      generated_at: parsed.generated_at ?? generatedAt,
      base: parsed.base ?? null,
      changes: parsed.changes
    };
  } catch {
    return createEmptyGeneratedIndex(generatedAt);
  }
}

function createEmptyGeneratedIndex(generatedAt) {
  return {
    schema_version: 1,
    generated_at: generatedAt,
    base: null,
    changes: []
  };
}

function createGeneratedFileResult({ kind, rootDir, targetPath, written }) {
  return {
    kind,
    path: targetPath,
    relativePath: toPosix(path.relative(rootDir, targetPath)),
    written
  };
}

function renderTraceDocument(sources, { changeId, generatedAt, outputs = [] }) {
  const inputs = renderTraceInputs(sources);
  const rules = renderTraceRules(sources);

  return `${JSON.stringify({
    schema_version: 1,
    validator: 'aifhub-generated-rules-trace',
    change_id: changeId,
    generated_at: generatedAt,
    inputs,
    outputs,
    rules
  }, null, 2)}\n`;
}

function renderTraceInputs(sources) {
  return sortSources(sources).map((source) => ({
    path: source.relativePath,
    sha256: source.fingerprint,
    kind: source.kind === 'base' ? 'base-spec' : 'delta-spec'
  }));
}

function renderTraceRules(sources) {
  return flattenRequirements(sources).map((requirement) => ({
    id: createTraceRuleId(requirement),
    severity: inferRuleSeverity(requirement),
    source: {
      path: requirement.relativePath,
      requirement: requirement.title
    },
    rule_text: createRuleText(requirement)
  }));
}

function renderTraceOutputs(files) {
  return files.map((file) => ({
    path: `${GENERATED_DIR.replaceAll(path.sep, '/')}/${file.fileName}`,
    sha256: createFingerprint(file.content),
    kind: `${file.kind}-rules`
  }));
}

function createFingerprint(content) {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

function renderIndexBaseEntry(baseSources) {
  return {
    markdown: `${GENERATED_DIR.replaceAll(path.sep, '/')}/${BASE_FILE}`,
    inputs: renderTraceInputs(baseSources)
  };
}

function renderIndexChangeEntry(changeId, traceFileName, generatedAt) {
  return {
    change_id: changeId,
    generated_at: generatedAt,
    trace: `${GENERATED_DIR.replaceAll(path.sep, '/')}/${traceFileName}`,
    markdown: {
      base: `${GENERATED_DIR.replaceAll(path.sep, '/')}/${BASE_FILE}`,
      change: `${GENERATED_DIR.replaceAll(path.sep, '/')}/openspec-change-${changeId}.md`,
      merged: `${GENERATED_DIR.replaceAll(path.sep, '/')}/openspec-merged-${changeId}.md`
    }
  };
}

function createTraceRuleId(requirement) {
  const prefix = requirement.kind === 'base' ? 'base' : 'delta';
  const capability = slugify(requirement.capability || 'root');
  const title = slugify(requirement.title || 'requirement');
  const hash = createHash('sha256')
    .update([
      requirement.kind,
      requirement.relativePath,
      requirement.section,
      requirement.title,
      ...requirement.body,
      ...requirement.scenarios.flatMap((scenario) => [scenario.title, ...scenario.steps])
    ].join('\n'))
    .digest('hex')
    .slice(0, 8);
  const stable = `${prefix}-${capability}-${title}`.replace(/-+/g, '-').replace(/^-|-$/g, '');

  return `${stable.slice(0, 80).replace(/-$/g, '')}-${hash}`;
}

function inferRuleSeverity(requirement) {
  const text = [
    requirement.title,
    ...requirement.body,
    ...requirement.scenarios.flatMap((scenario) => [scenario.title, ...scenario.steps])
  ].join('\n').toUpperCase();

  if (/\b(MUST|MUST NOT|SHALL|REQUIRED)\b/.test(text)) {
    return 'must';
  }

  if (/\b(SHOULD|RECOMMENDED)\b/.test(text)) {
    return 'should';
  }

  if (/\b(MAY|OPTIONAL)\b/.test(text)) {
    return 'may';
  }

  return 'should';
}

function createRuleText(requirement) {
  const body = requirement.body.join(' ').trim();

  if (body.length > 0) {
    return body;
  }

  const scenarioSteps = requirement.scenarios.flatMap((scenario) => scenario.steps).join(' ').trim();

  if (scenarioSteps.length > 0) {
    return scenarioSteps;
  }

  return `Requirement "${requirement.title}" from ${requirement.relativePath}.`;
}

function slugify(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'item';
}

export function parseSpecMarkdownFallback(markdown, options = {}) {
  const warnings = [];
  const requirements = [];
  const lines = String(markdown ?? '').replace(/\r\n/g, '\n').split('\n');
  let currentSection = 'Requirements';
  let currentRequirement = null;
  let currentScenario = null;

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const sectionMatch = line.match(/^#{2,6}\s+((?:ADDED|MODIFIED|REMOVED)\s+Requirements|Requirements)\s*$/i);
    const requirementMatch = line.match(/^#{3,6}\s+Requirement:\s*(.+?)\s*$/i);
    const scenarioMatch = line.match(/^#{4,6}\s+Scenario:\s*(.+?)\s*$/i);

    if (sectionMatch) {
      currentSection = canonicalSection(sectionMatch[1]);
      currentScenario = null;
      continue;
    }

    if (requirementMatch) {
      if (currentRequirement !== null) {
        requirements.push(finalizeRequirement(currentRequirement));
      }

      currentRequirement = {
        title: requirementMatch[1].trim(),
        section: currentSection,
        bodyLines: [],
        scenarios: []
      };
      currentScenario = null;
      continue;
    }

    if (scenarioMatch) {
      if (currentRequirement === null) {
        warnings.push({
          code: 'scenario-without-requirement',
          message: `Scenario '${scenarioMatch[1].trim()}' has no preceding requirement.`
        });
        continue;
      }

      currentScenario = {
        title: scenarioMatch[1].trim(),
        steps: []
      };
      currentRequirement.scenarios.push(currentScenario);
      continue;
    }

    if (currentScenario !== null) {
      const step = normalizeMarkdownLine(line);

      if (step.length > 0) {
        currentScenario.steps.push(step);
      }
      continue;
    }

    if (currentRequirement !== null) {
      const bodyLine = line.trim();

      if (bodyLine.length > 0) {
        currentRequirement.bodyLines.push(bodyLine);
      }
    }
  }

  if (currentRequirement !== null) {
    requirements.push(finalizeRequirement(currentRequirement));
  }

  if (requirements.length === 0 && String(markdown ?? '').trim().length > 0) {
    warnings.push({
      code: 'no-requirements-found',
      message: 'No OpenSpec requirements were parsed from markdown fallback input.'
    });
  }

  return {
    requirements: sortRequirements(requirements),
    warnings,
    source: options.source ?? null
  };
}

export function extractRequirementsFromShowJson(json, options = {}) {
  const warnings = [];
  const requirements = [];
  const seen = new Set();

  visitJsonNode(json, {
    section: options.section ?? 'Requirements',
    requirements,
    warnings,
    seen
  });

  return {
    requirements: sortRequirements(requirements),
    warnings
  };
}

async function detectOpenSpecCapability(rootDir, options) {
  const detectOpenSpec = options.detectOpenSpec ?? defaultDetectOpenSpec;
  const showOpenSpecItem = options.showOpenSpecItem ?? defaultShowOpenSpecItem;

  try {
    const detection = await detectOpenSpec({
      cwd: rootDir,
      command: options.command,
      env: options.env,
      executor: options.executor,
      nodeVersion: options.nodeVersion,
      platform: options.platform,
      candidateExists: options.candidateExists,
      execFile: options.execFile,
      comSpec: options.comSpec
    });
    const warnings = [];

    if (!detection.available || !detection.canValidate) {
      warnings.push(...normalizeDetectionWarnings(detection));
    }

    return {
      detection,
      showOpenSpecItem,
      available: Boolean(detection.available && detection.canValidate),
      runOptions: {
        command: options.command,
        env: options.env,
        executor: options.executor,
        platform: options.platform,
        candidateExists: options.candidateExists,
        execFile: options.execFile,
        comSpec: options.comSpec
      },
      warnings
    };
  } catch (err) {
    return {
      detection: null,
      showOpenSpecItem,
      available: false,
      runOptions: {
        command: options.command,
        env: options.env,
        executor: options.executor,
        platform: options.platform,
        candidateExists: options.candidateExists,
        execFile: options.execFile,
        comSpec: options.comSpec
      },
      warnings: [
        {
          code: 'openspec-detection-failed',
          message: 'OpenSpec CLI detection failed; using filesystem fallback.',
          detail: err?.message ?? 'Unknown detection error.'
        }
      ]
    };
  }
}

async function readRuleSource(filePath, context) {
  const content = await context.fileOps.readFile(filePath, 'utf8');
  const relativePath = toPosix(path.relative(context.rootDir, filePath));
  const capability = toPosix(path.relative(context.specsDir, path.dirname(filePath)));
  const warnings = [];
  let parseResult = null;
  let extractionMode = 'filesystem-fallback';

  if (context.cli.available) {
    const cliResult = await tryReadRequirementsFromCli(capability, context);
    warnings.push(...cliResult.warnings);

    if (cliResult.requirements.length > 0) {
      parseResult = cliResult;
      extractionMode = 'cli-json';
    }
  }

  if (parseResult === null) {
    parseResult = parseSpecMarkdownFallback(content, { source: relativePath });
    warnings.push(...parseResult.warnings.map((warning) => ({
      ...warning,
      path: relativePath
    })));
  }

  const fingerprint = `sha256:${createHash('sha256').update(content).digest('hex')}`;
  const requirements = parseResult.requirements.map((requirement) => ({
    ...requirement,
    kind: context.kind,
    changeId: context.kind === 'change' ? context.changeId : null,
    capability,
    relativePath,
    fingerprint
  }));

  return {
    item: {
      kind: context.kind,
      changeId: context.kind === 'change' ? context.changeId : null,
      capability,
      relativePath,
      path: filePath,
      fingerprint,
      mode: extractionMode,
      requirements
    },
    warnings
  };
}

async function tryReadRequirementsFromCli(capability, context) {
  try {
    const result = await context.cli.showOpenSpecItem(capability, {
      ...context.cli.runOptions,
      cwd: context.rootDir,
      type: 'spec',
      deltasOnly: context.kind === 'change'
    });

    if (!result.ok) {
      return {
        requirements: [],
        warnings: [
          {
            code: 'cli-json-unavailable',
            message: `OpenSpec CLI JSON was unavailable for '${capability}'; using filesystem fallback.`,
            detail: result.error?.message ?? null
          }
        ]
      };
    }

    const extracted = extractRequirementsFromShowJson(result.json);

    if (extracted.requirements.length === 0) {
      return {
        requirements: [],
        warnings: [
          {
            code: 'cli-json-empty',
            message: `OpenSpec CLI JSON for '${capability}' did not contain requirements; using filesystem fallback.`
          },
          ...extracted.warnings
        ]
      };
    }

    return extracted;
  } catch (err) {
    return {
      requirements: [],
      warnings: [
        {
          code: 'cli-json-error',
          message: `OpenSpec CLI JSON extraction failed for '${capability}'; using filesystem fallback.`,
          detail: err?.message ?? 'Unknown CLI JSON extraction error.'
        }
      ]
    };
  }
}

async function collectSpecFiles(specsDir, options = {}) {
  const rootDir = path.resolve(options.rootDir ?? process.cwd());
  const fileOps = options.fileOps ?? resolveCompilerFileOps(options);
  const inspection = await inspectCanonicalDirectoryPath(rootDir, specsDir, {
    fileOps,
    allowMissing: true,
    unsafeCode: 'openspec-source-root-unsafe',
    unsafeMessage: 'A canonical OpenSpec spec root must be a direct regular directory inside the project.',
    readCode: 'openspec-source-inventory-read-failed',
    readMessage: 'Unable to inspect a canonical OpenSpec spec root.',
    sourceKind: options.sourceKind,
    changeId: options.changeId
  });
  if (!inspection.ok) {
    return { ok: false, files: [], errors: inspection.errors };
  }
  if (inspection.missing) {
    return { ok: true, files: [], errors: [] };
  }
  const files = [];
  try {
    await collectSpecFilesRecursive(specsDir, files, fileOps);
  } catch {
    return {
      ok: false,
      files: [],
      errors: [{
        code: 'openspec-source-inventory-read-failed',
        message: 'Unable to read canonical OpenSpec rule sources.',
        ...(options.sourceKind ? { sourceKind: options.sourceKind } : {}),
        ...(options.changeId ? { changeId: options.changeId } : {})
      }]
    };
  }
  return {
    ok: true,
    files: files.sort((left, right) => toPosix(left).localeCompare(toPosix(right))),
    errors: []
  };
}

async function collectSpecFilesRecursive(dirPath, files, fileOps) {
  const entries = await fileOps.readdir(dirPath, { withFileTypes: true });
  const sortedEntries = entries.sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of sortedEntries) {
    const childPath = path.join(dirPath, entry.name);

    if (entry.isDirectory()) {
      const childStat = await fileOps.lstat(childPath);
      if (childStat.isSymbolicLink?.() || !childStat.isDirectory?.()) {
        continue;
      }
      await collectSpecFilesRecursive(childPath, files, fileOps);
      continue;
    }

    if (entry.isFile() && entry.name === 'spec.md') {
      const childStat = await fileOps.lstat(childPath);
      if (!childStat.isSymbolicLink?.() && childStat.isFile?.()) {
        files.push(childPath);
      }
    }
  }
}

function fingerprintPreparedRuleSources(baseResult, changeResults, selectedChangeIds) {
  const sources = [
    ...(baseResult?.sources ?? []),
    ...selectedChangeIds.flatMap((changeId) => changeResults.get(changeId)?.sources ?? [])
  ];
  return fingerprintRuleSourceEntries(sources.map((source) => ({
    kind: source.kind,
    changeId: source.changeId ?? null,
    relativePath: source.relativePath,
    fingerprint: source.fingerprint
  })));
}

async function fingerprintCurrentRuleSources(rootDir, selectedChangeIds, fileOps) {
  const groups = [{
    kind: 'base',
    changeId: null,
    specsDir: path.join(rootDir, 'openspec', 'specs')
  }, ...selectedChangeIds.map((changeId) => ({
    kind: 'change',
    changeId,
    specsDir: path.join(rootDir, 'openspec', 'changes', changeId, 'specs')
  }))];
  const entries = [];

  for (const group of groups) {
    const inventory = await collectSpecFiles(group.specsDir, {
      rootDir,
      fileOps,
      sourceKind: group.kind,
      changeId: group.changeId
    });
    if (!inventory.ok) {
      return { ok: false, snapshot: null, errors: inventory.errors };
    }

    for (const filePath of inventory.files) {
      try {
        const content = await fileOps.readFile(filePath, 'utf8');
        entries.push({
          kind: group.kind,
          changeId: group.changeId,
          relativePath: toPosix(path.relative(rootDir, filePath)),
          fingerprint: createFingerprint(content)
        });
      } catch {
        return {
          ok: false,
          snapshot: null,
          errors: [{
            code: 'openspec-source-inventory-read-failed',
            message: 'Unable to read canonical OpenSpec rule sources.',
            sourceKind: group.kind,
            ...(group.changeId ? { changeId: group.changeId } : {})
          }]
        };
      }
    }
  }

  return { ok: true, snapshot: fingerprintRuleSourceEntries(entries), errors: [] };
}

function fingerprintRuleSourceEntries(entries) {
  const normalized = Array.from(entries ?? [])
    .map((entry) => ({
      kind: entry.kind,
      changeId: entry.changeId ?? null,
      relativePath: toPosix(entry.relativePath),
      fingerprint: entry.fingerprint
    }))
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath)
      || String(left.kind).localeCompare(String(right.kind))
      || String(left.changeId ?? '').localeCompare(String(right.changeId ?? '')));
  return fingerprintValue(normalized);
}

function renderDocument({ kind, title, changeId, sources, emptyMessage }) {
  const lines = [
    '# Generated OpenSpec Rules',
    '',
    `View: ${title}`,
    'Source of truth: OpenSpec canonical specs',
    'Generated files are derived guidance and are safe to delete, overwrite, and regenerate.'
  ];

  if (kind !== 'base') {
    lines.push(`Change: ${changeId}`);
  }

  lines.push('', '## Source Fingerprints');

  if (sources.length === 0) {
    lines.push('', emptyMessage, '');
    return `${lines.join('\n')}\n`;
  }

  for (const source of sources) {
    lines.push(`- ${source.fingerprint} ${source.relativePath}`);
  }

  const requirements = flattenRequirements(sources);

  if (requirements.length === 0) {
    lines.push('', emptyMessage, '');
    return `${lines.join('\n')}\n`;
  }

  let previousSection = null;

  for (const requirement of requirements) {
    if (requirement.section !== previousSection) {
      lines.push('', `## ${requirement.section}`);
      previousSection = requirement.section;
    }

    lines.push('', `### Requirement: ${requirement.title}`, '');
    lines.push('Source:');
    lines.push(`- Kind: ${requirement.kind}`);
    lines.push(`- Path: ${requirement.relativePath}`);
    lines.push(`- Capability: ${requirement.capability}`);
    lines.push(`- Change: ${requirement.changeId ?? 'none'}`);
    lines.push(`- Section: ${requirement.section}`);
    lines.push(`- Fingerprint: ${requirement.fingerprint}`);

    if (requirement.body.length > 0) {
      lines.push('', ...requirement.body);
    }

    for (const scenario of requirement.scenarios) {
      lines.push('', `#### Scenario: ${scenario.title}`);

      for (const step of scenario.steps) {
        lines.push(`- ${step}`);
      }
    }
  }

  lines.push('');
  return `${lines.join('\n')}\n`;
}

function flattenRequirements(sources) {
  return sources
    .flatMap((source) => source.requirements)
    .sort(compareRequirements);
}

function sortSources(sources) {
  return Array.from(sources).sort((left, right) => {
    const kindComparison = compareKind(left.kind, right.kind);

    if (kindComparison !== 0) {
      return kindComparison;
    }

    return left.capability.localeCompare(right.capability)
      || left.relativePath.localeCompare(right.relativePath);
  });
}

function sortRequirements(requirements) {
  return Array.from(requirements).sort(compareRequirements);
}

function compareRequirements(left, right) {
  return compareKind(left.kind, right.kind)
    || left.capability.localeCompare(right.capability)
    || sectionRank(left.section) - sectionRank(right.section)
    || left.title.localeCompare(right.title)
    || firstScenarioTitle(left).localeCompare(firstScenarioTitle(right));
}

function compareKind(left, right) {
  return kindRank(left) - kindRank(right);
}

function kindRank(kind) {
  return kind === 'base' ? 0 : 1;
}

function sectionRank(section) {
  return SECTION_ORDER.get(section) ?? 99;
}

function firstScenarioTitle(requirement) {
  return requirement.scenarios[0]?.title ?? '';
}

function canonicalSection(section) {
  const normalized = String(section ?? '').trim().replace(/\s+/g, ' ');
  const lower = normalized.toLowerCase();

  if (lower === 'added requirements') {
    return 'ADDED Requirements';
  }

  if (lower === 'modified requirements') {
    return 'MODIFIED Requirements';
  }

  if (lower === 'removed requirements') {
    return 'REMOVED Requirements';
  }

  return 'Requirements';
}

function finalizeRequirement(requirement) {
  return {
    title: requirement.title,
    section: requirement.section,
    body: requirement.bodyLines,
    scenarios: requirement.scenarios.map((scenario) => ({
      title: scenario.title,
      steps: scenario.steps
    })),
    kind: requirement.kind ?? 'base',
    changeId: requirement.changeId ?? null,
    capability: requirement.capability ?? '',
    relativePath: requirement.relativePath ?? '',
    fingerprint: requirement.fingerprint ?? ''
  };
}

function normalizeMarkdownLine(line) {
  return line.trim().replace(/^[-*]\s+/, '').trim();
}

function visitJsonNode(node, state) {
  if (node === null || node === undefined) {
    return;
  }

  if (Array.isArray(node)) {
    for (const item of node) {
      visitJsonNode(item, state);
    }
    return;
  }

  if (typeof node !== 'object') {
    return;
  }

  const section = inferJsonSection(node, state.section);

  if (looksLikeRequirement(node)) {
    const requirement = normalizeJsonRequirement(node, section);
    const key = `${requirement.section}:${requirement.title}`;

    if (!state.seen.has(key)) {
      state.seen.add(key);
      state.requirements.push(requirement);
    }
    return;
  }

  for (const [key, value] of Object.entries(node)) {
    if (key === 'requirements' || key === 'reqs') {
      visitJsonRequirementsCollection(value, {
        ...state,
        section
      });
      continue;
    }

    if (/^(added|modified|removed)$/i.test(key)) {
      visitJsonRequirementsCollection(value, {
        ...state,
        section: canonicalSection(`${key.toUpperCase()} Requirements`)
      });
      continue;
    }

    if (/^(added|modified|removed)\s*Requirements$/i.test(key)) {
      visitJsonRequirementsCollection(value, {
        ...state,
        section: canonicalSection(key)
      });
      continue;
    }

    if (typeof value === 'object') {
      visitJsonNode(value, {
        ...state,
        section
      });
    }
  }
}

function visitJsonRequirementsCollection(value, state) {
  if (Array.isArray(value)) {
    for (const item of value) {
      visitJsonNode(item, state);
    }
    return;
  }

  if (value !== null && typeof value === 'object') {
    for (const [title, item] of Object.entries(value)) {
      if (item !== null && typeof item === 'object') {
        visitJsonNode({
          title,
          ...item
        }, state);
      }
    }
  }
}

function looksLikeRequirement(node) {
  return typeof (node.title ?? node.name ?? node.requirement) === 'string'
    && (
      node.description !== undefined
      || node.text !== undefined
      || node.body !== undefined
      || node.scenarios !== undefined
      || node.scenario !== undefined
    );
}

function normalizeJsonRequirement(node, section) {
  const title = String(node.title ?? node.name ?? node.requirement).trim();
  const body = normalizeBody(node.description ?? node.text ?? node.body);
  const scenarios = normalizeJsonScenarios(node.scenarios ?? node.scenario);

  return {
    title,
    section,
    body,
    scenarios,
    kind: 'base',
    changeId: null,
    capability: '',
    relativePath: '',
    fingerprint: ''
  };
}

function normalizeJsonScenarios(input) {
  if (input === undefined || input === null) {
    return [];
  }

  const values = Array.isArray(input) ? input : [input];
  return values.map((scenario, index) => {
    if (typeof scenario === 'string') {
      return {
        title: `Scenario ${index + 1}`,
        steps: normalizeBody(scenario)
      };
    }

    const title = String(scenario.title ?? scenario.name ?? `Scenario ${index + 1}`).trim();
    const steps = normalizeJsonScenarioSteps(scenario);

    return {
      title,
      steps
    };
  });
}

function normalizeJsonScenarioSteps(scenario) {
  const fields = [
    scenario.steps,
    scenario.given,
    scenario.when,
    scenario.then,
    scenario.description,
    scenario.body
  ];

  return fields.flatMap((field) => normalizeBody(field));
}

function normalizeBody(input) {
  if (input === undefined || input === null) {
    return [];
  }

  if (Array.isArray(input)) {
    return input.flatMap((item) => normalizeBody(item));
  }

  return String(input)
    .split(/\r?\n/)
    .map(normalizeMarkdownLine)
    .filter((line) => line.length > 0);
}

function inferJsonSection(node, fallback) {
  const candidate = node.section ?? node.type ?? node.kind ?? fallback;
  return canonicalSection(String(candidate).includes('Requirements') ? candidate : fallback);
}

function chooseMode(sources, cli) {
  if (!cli.available) {
    return 'filesystem-fallback';
  }

  const modes = new Set(sources.map((source) => source.mode));

  if (modes.size === 1 && modes.has('cli-json')) {
    return 'cli-json';
  }

  if (modes.has('cli-json')) {
    return 'mixed';
  }

  return 'filesystem-fallback';
}

function normalizeDetectionWarnings(detection) {
  if (Array.isArray(detection.errors) && detection.errors.length > 0) {
    return detection.errors.map((error) => ({
      code: error.code ?? detection.reason ?? 'openspec-unavailable',
      message: error.message ?? 'OpenSpec CLI is unavailable; using filesystem fallback.'
    }));
  }

  return [
    {
      code: detection.reason ?? 'openspec-unavailable',
      message: 'OpenSpec CLI is unavailable or unsupported; using filesystem fallback.'
    }
  ];
}

function summarizeOpenSpecDetection(detection) {
  if (detection === null || detection === undefined) {
    return null;
  }

  return {
    available: Boolean(detection.available),
    canValidate: Boolean(detection.canValidate),
    canArchive: Boolean(detection.canArchive),
    version: detection.version ?? null,
    command: detection.command ?? null,
    commandSource: detection.commandSource ?? null,
    reason: detection.reason ?? null
  };
}

function resolveGeneratedAt(options = {}) {
  if (typeof options.generatedAt === 'string' && options.generatedAt.trim().length > 0) {
    return options.generatedAt;
  }

  const value = options.now ?? Date.now();
  const date = value instanceof Date ? value : new Date(value);

  return date.toISOString();
}

function resolveCompilerFileOps(options = {}) {
  return {
    lstat,
    mkdir,
    open,
    readdir,
    readFile,
    realpath,
    rename,
    rm,
    unlink,
    writeFile,
    ...(options.fileOps ?? {})
  };
}

function validateGeneratedRulesLayout(rootDir, configuredPath = undefined) {
  const canonical = GENERATED_DIR.replaceAll(path.sep, '/');
  const candidate = configuredPath === undefined || configuredPath === null
    ? canonical
    : String(configuredPath).replaceAll('\\', '/');

  if (
    path.isAbsolute(candidate)
    || candidate.split('/').includes('..')
    || candidate !== canonical
  ) {
    return {
      ok: false,
      generatedDir: null,
      errors: [{
        code: 'generated-rules-root-mismatch',
        message: `OpenSpec generated-rules reconciliation requires canonical path '${canonical}'.`
      }]
    };
  }

  const generatedDir = path.resolve(rootDir, ...canonical.split('/'));
  if (!isWithinDirectory(generatedDir, rootDir)) {
    return {
      ok: false,
      generatedDir: null,
      errors: [{
        code: 'generated-rules-root-mismatch',
        message: `OpenSpec generated-rules reconciliation requires canonical path '${canonical}'.`
      }]
    };
  }

  return { ok: true, generatedDir, errors: [] };
}

async function inspectCanonicalDirectoryPath(rootDir, targetDir, options = {}) {
  const resolvedRoot = path.resolve(rootDir);
  const resolvedTarget = path.resolve(targetDir);
  const fileOps = options.fileOps ?? resolveCompilerFileOps(options);
  const relativeTarget = path.relative(resolvedRoot, resolvedTarget);
  const diagnosticFields = {
    ...(options.sourceKind ? { sourceKind: options.sourceKind } : {}),
    ...(options.changeId ? { changeId: options.changeId } : {})
  };
  const unsafe = () => ({
    ok: false,
    missing: false,
    identity: null,
    errors: [{
      code: options.unsafeCode,
      message: options.unsafeMessage,
      ...diagnosticFields
    }]
  });
  const unreadable = () => ({
    ok: false,
    missing: false,
    identity: null,
    errors: [{
      code: options.readCode,
      message: options.readMessage,
      ...diagnosticFields
    }]
  });

  if (
    relativeTarget.length === 0
    || relativeTarget.startsWith('..')
    || path.isAbsolute(relativeTarget)
  ) {
    return unsafe();
  }

  const segments = relativeTarget.split(path.sep).filter(Boolean);
  let currentPath = resolvedRoot;
  let targetStat = null;

  for (const segment of segments) {
    currentPath = path.join(currentPath, segment);
    try {
      targetStat = await fileOps.lstat(currentPath);
    } catch (err) {
      if (err?.code === 'ENOENT' && options.allowMissing) {
        return { ok: true, missing: true, identity: null, errors: [] };
      }
      return unreadable();
    }

    if (targetStat.isSymbolicLink?.() || !targetStat.isDirectory?.()) {
      return unsafe();
    }
  }

  try {
    const [canonicalRoot, canonicalTarget] = await Promise.all([
      fileOps.realpath(resolvedRoot),
      fileOps.realpath(resolvedTarget)
    ]);
    if (!isWithinDirectory(canonicalTarget, canonicalRoot)) {
      return unsafe();
    }

    return {
      ok: true,
      missing: false,
      identity: createDirectoryIdentity(targetStat, canonicalTarget),
      errors: []
    };
  } catch {
    return unsafe();
  }
}

function createDirectoryIdentity(statValue, resolvedPath) {
  return {
    resolvedPath: normalizeCanonicalPath(resolvedPath),
    device: normalizeFileIdentityValue(statValue?.dev),
    inode: normalizeFileIdentityValue(statValue?.ino),
    birthtimeMs: Number.isFinite(statValue?.birthtimeMs) ? Number(statValue.birthtimeMs) : null
  };
}

function normalizeCanonicalPath(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function normalizeFileIdentityValue(value) {
  if (typeof value === 'bigint') {
    return value.toString();
  }
  return Number.isFinite(value) ? String(value) : null;
}

function sameDirectoryIdentity(left, right) {
  return left !== null && right !== null && equalJson(left, right);
}

async function inspectGeneratedRulesStore(options = {}) {
  const rootDir = path.resolve(options.rootDir ?? process.cwd());
  const generatedDir = path.resolve(options.generatedDir ?? path.join(rootDir, GENERATED_DIR));
  const fileOps = resolveCompilerFileOps(options);
  const canonicalPrefix = GENERATED_DIR.replaceAll(path.sep, '/');
  const rootInspection = await inspectCanonicalDirectoryPath(rootDir, generatedDir, {
    fileOps,
    allowMissing: true,
    unsafeCode: 'generated-rules-root-unsafe',
    unsafeMessage: 'The canonical generated-rules root must be a direct regular directory inside the project.',
    readCode: 'generated-rules-inventory-read-failed',
    readMessage: 'Unable to inspect the generated-rules root.'
  });

  if (!rootInspection.ok) {
    const diagnostic = rootInspection.errors[0];
    return createGeneratedStoreFailure(diagnostic.code, diagnostic.message);
  }
  if (rootInspection.missing) {
    const index = createGeneratedIndexInspection({ state: 'missing', raw: null });
    return {
      ok: true,
      missingRoot: true,
      rootIdentity: null,
      childNames: [],
      managedFiles: [],
      invalidManagedEntries: [],
      index,
      warnings: [],
      errors: [],
      snapshot: fingerprintValue({ missingRoot: true, root: null, index: 'missing', entries: [] })
    };
  }

  let entries;
  try {
    entries = await fileOps.readdir(generatedDir, { withFileTypes: true });
  } catch {
    return createGeneratedStoreFailure(
      'generated-rules-inventory-read-failed',
      'Unable to read the generated-rules direct-child inventory.'
    );
  }

  const childNames = [];
  const managedFiles = [];
  const invalidManagedEntries = [];
  const errors = [];
  const snapshotEntries = [];
  let indexEntry = null;

  for (const entry of Array.from(entries).sort((left, right) => left.name.localeCompare(right.name))) {
    childNames.push(entry.name);
    const targetPath = path.join(generatedDir, entry.name);
    const classified = classifyManagedFileName(entry.name);
    const protectedKind = entry.name === BASE_FILE ? 'base' : entry.name === INDEX_FILE ? 'index' : null;

    if (classified === null && protectedKind === null) {
      continue;
    }

    let targetStat;
    try {
      targetStat = await fileOps.lstat(targetPath);
    } catch {
      errors.push({
        code: 'generated-rules-inventory-read-failed',
        message: `Unable to inspect compiler-owned generated entry '${entry.name}'.`,
        path: `${canonicalPrefix}/${entry.name}`
      });
      continue;
    }

    const entryType = targetStat.isSymbolicLink?.()
      ? 'symlink'
      : targetStat.isFile?.()
        ? 'file'
        : targetStat.isDirectory?.()
          ? 'directory'
          : 'other';
    snapshotEntries.push({ name: entry.name, type: entryType });

    if (protectedKind === 'index') {
      indexEntry = { targetPath, entryType };
      if (entryType !== 'file') {
        errors.push({
          code: 'unsafe-generated-index-entry',
          message: 'Generated-rules index must be a direct regular file.',
          path: `${canonicalPrefix}/${INDEX_FILE}`
        });
      }
      continue;
    }

    if (protectedKind === 'base') {
      if (entryType !== 'file') {
        const item = {
          kind: 'base',
          changeId: null,
          fileName: entry.name,
          relativePath: `${canonicalPrefix}/${entry.name}`,
          type: entryType
        };
        invalidManagedEntries.push(item);
        errors.push({
          code: 'invalid-managed-entry',
          message: `Compiler-owned generated entry '${entry.name}' must be a direct regular file.`,
          path: item.relativePath
        });
      }
      continue;
    }

    if (!classified.valid || entryType !== 'file') {
      const item = {
        kind: classified.kind,
        changeId: classified.changeId,
        fileName: entry.name,
        relativePath: `${canonicalPrefix}/${entry.name}`,
        type: entryType
      };
      invalidManagedEntries.push(item);
      errors.push({
        code: 'invalid-managed-entry',
        message: `Managed-looking generated entry '${entry.name}' is unsafe.`,
        path: item.relativePath,
        ...(classified.changeId ? { changeId: classified.changeId } : {})
      });
      continue;
    }

    const resolvedTarget = path.resolve(generatedDir, entry.name);
    if (!isWithinDirectory(resolvedTarget, generatedDir)) {
      const item = {
        kind: classified.kind,
        changeId: classified.changeId,
        fileName: entry.name,
        relativePath: `${canonicalPrefix}/${entry.name}`,
        type: entryType
      };
      invalidManagedEntries.push(item);
      errors.push({
        code: 'invalid-managed-entry',
        message: `Managed-looking generated entry '${entry.name}' escapes the canonical root.`,
        path: item.relativePath,
        changeId: classified.changeId
      });
      continue;
    }

    managedFiles.push({
      kind: classified.kind,
      changeId: classified.changeId,
      fileName: entry.name,
      relativePath: `${canonicalPrefix}/${entry.name}`,
      type: entryType
    });
  }

  let index;
  if (indexEntry === null) {
    index = createGeneratedIndexInspection({ state: 'missing', raw: null });
  } else if (indexEntry.entryType !== 'file') {
    index = createGeneratedIndexInspection({ state: 'malformed', raw: null });
  } else {
    try {
      const raw = await fileOps.readFile(indexEntry.targetPath, 'utf8');
      index = parseGeneratedIndex(raw);
    } catch {
      index = createGeneratedIndexInspection({
        state: 'malformed',
        raw: null,
        diagnostics: [{
          code: 'generated-index-read-failed',
          message: 'Unable to read generated-rules index.'
        }]
      });
    }
  }

  errors.push(...index.errors);
  const snapshot = fingerprintValue({
    missingRoot: false,
    root: rootInspection.identity,
    index: index.raw === null ? index.state : createFingerprint(index.raw),
    entries: snapshotEntries.sort((left, right) => left.name.localeCompare(right.name))
  });

  return {
    ok: errors.length === 0,
    missingRoot: false,
    rootIdentity: rootInspection.identity,
    childNames: childNames.sort((left, right) => left.localeCompare(right)),
    managedFiles: managedFiles.sort((left, right) => left.relativePath.localeCompare(right.relativePath)),
    invalidManagedEntries: invalidManagedEntries.sort((left, right) => left.relativePath.localeCompare(right.relativePath)),
    index,
    warnings: [],
    errors: dedupeDiagnostics(errors),
    snapshot
  };
}

function createGeneratedStoreFailure(code, message) {
  return {
    ok: false,
    missingRoot: false,
    rootIdentity: null,
    childNames: [],
    managedFiles: [],
    invalidManagedEntries: [],
    index: createGeneratedIndexInspection({ state: 'missing', raw: null }),
    warnings: [],
    errors: [{ code, message }],
    snapshot: null
  };
}

function classifyManagedFileName(fileName) {
  for (const item of MANAGED_FILE_PATTERNS) {
    const match = String(fileName).match(item.pattern);
    if (match === null) {
      continue;
    }

    const normalized = normalizeChangeId(match[1]);
    return {
      kind: item.kind,
      changeId: normalized.ok ? normalized.changeId : null,
      valid: normalized.ok && normalized.changeId === match[1]
    };
  }

  return null;
}

function parseGeneratedIndex(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return createGeneratedIndexInspection({
      state: 'malformed',
      raw,
      diagnostics: [{
        code: 'generated-index-malformed',
        message: 'Generated-rules index is not valid JSON.'
      }]
    });
  }

  const diagnostics = [];
  const errors = [];
  if (
    parsed === null
    || typeof parsed !== 'object'
    || parsed.schema_version !== 1
    || typeof parsed.generated_at !== 'string'
    || !Array.isArray(parsed.changes)
  ) {
    diagnostics.push({
      code: 'generated-index-malformed',
      message: 'Generated-rules index does not match schema version 1.'
    });
  }

  if (parsed?.base !== null && parsed?.base !== undefined) {
    const baseShapeValid = (
      typeof parsed.base === 'object'
      && !Array.isArray(parsed.base)
      && typeof parsed.base.markdown === 'string'
      && Array.isArray(parsed.base.inputs)
    );
    if (!baseShapeValid) {
      diagnostics.push({
        code: 'generated-index-malformed',
        message: 'Generated-rules index contains malformed base metadata.'
      });
    }
    for (const input of Array.isArray(parsed.base?.inputs) ? parsed.base.inputs : []) {
      const inputShapeValid = (
        input !== null
        && typeof input === 'object'
        && !Array.isArray(input)
        && typeof input.path === 'string'
        && typeof input.sha256 === 'string'
        && input.kind === 'base-spec'
      );
      if (!inputShapeValid) {
        diagnostics.push({
          code: 'generated-index-malformed',
          message: 'Generated-rules index contains malformed base input metadata.'
        });
      }
      if (
        typeof input?.path === 'string'
        && isUnsafeGeneratedIndexBaseInputPath(input.path)
      ) {
        errors.push({
          code: 'unsafe-generated-index-path',
          message: 'Generated-rules index contains a base input path outside canonical base specs.'
        });
      }
    }
    if (
      typeof parsed.base?.markdown === 'string'
      && (
        isUnsafeGeneratedIndexPath(parsed.base.markdown)
        || parsed.base.markdown !== `${GENERATED_DIR.replaceAll(path.sep, '/')}/${BASE_FILE}`
      )
    ) {
      errors.push({
        code: 'unsafe-generated-index-path',
        message: 'Generated-rules index base metadata does not match the canonical compiler-owned path.'
      });
    }
  }

  const normalizedEntries = [];
  const seen = new Set();
  for (const entry of Array.isArray(parsed?.changes) ? parsed.changes : []) {
    const pathValues = [
      entry?.trace,
      entry?.markdown?.base,
      entry?.markdown?.change,
      entry?.markdown?.merged
    ];
    const pathShapeValid = pathValues.every((value) => typeof value === 'string');
    const hasUnsafePath = pathValues.some((value) => (
      typeof value === 'string' && isUnsafeGeneratedIndexPath(value)
    ));
    if (!pathShapeValid) {
      diagnostics.push({
        code: 'generated-index-malformed',
        message: 'Generated-rules index contains malformed change path metadata.'
      });
    }
    if (hasUnsafePath) {
      errors.push({
        code: 'unsafe-generated-index-path',
        message: 'Generated-rules index contains path metadata outside the canonical compiler-owned root.'
      });
    }

    const normalized = normalizeChangeId(entry?.change_id);
    if (!normalized.ok || typeof entry?.generated_at !== 'string') {
      diagnostics.push({
        code: 'generated-index-malformed',
        message: 'Generated-rules index contains a malformed change entry.'
      });
      continue;
    }

    const expected = renderIndexChangeEntry(
      normalized.changeId,
      `${TRACE_FILE_PREFIX}${normalized.changeId}.json`,
      entry.generated_at
    );
    if (
      pathShapeValid
      && !hasUnsafePath
      && (
        entry.trace !== expected.trace
        || entry.markdown.base !== expected.markdown.base
        || entry.markdown.change !== expected.markdown.change
        || entry.markdown.merged !== expected.markdown.merged
      )
    ) {
      errors.push({
        code: 'unsafe-generated-index-path',
        message: `Generated-rules index paths for '${normalized.changeId}' do not match canonical compiler-owned targets.`,
        changeId: normalized.changeId
      });
    }

    if (seen.has(normalized.changeId)) {
      diagnostics.push({
        code: 'generated-index-malformed',
        message: `Generated-rules index contains duplicate change '${normalized.changeId}'.`,
        changeId: normalized.changeId
      });
      continue;
    }
    seen.add(normalized.changeId);

    normalizedEntries.push({
      change_id: normalized.changeId,
      generated_at: entry.generated_at,
      trace: entry.trace,
      markdown: entry.markdown
    });
  }

  if (diagnostics.length > 0) {
    return createGeneratedIndexInspection({ state: 'malformed', raw, diagnostics, errors });
  }

  return createGeneratedIndexInspection({
    state: 'valid',
    raw,
    value: {
      schema_version: 1,
      generated_at: parsed.generated_at,
      base: parsed.base ?? null,
      changes: normalizedEntries.sort((left, right) => left.change_id.localeCompare(right.change_id))
    },
    errors
  });
}

function isUnsafeGeneratedIndexPath(value) {
  const normalized = String(value).replaceAll('\\', '/');
  const canonicalPrefix = `${GENERATED_DIR.replaceAll(path.sep, '/')}/`;
  return (
    path.win32.isAbsolute(String(value))
    || path.posix.isAbsolute(normalized)
    || normalized.split('/').includes('..')
    || !normalized.startsWith(canonicalPrefix)
  );
}

function isUnsafeGeneratedIndexBaseInputPath(value) {
  const raw = String(value);
  const normalized = raw.replaceAll('\\', '/');
  return (
    path.win32.isAbsolute(raw)
    || path.posix.isAbsolute(normalized)
    || raw !== normalized
    || path.posix.normalize(normalized) !== normalized
    || !normalized.startsWith('openspec/specs/')
    || !normalized.endsWith('/spec.md')
  );
}

function createGeneratedIndexInspection(overrides = {}) {
  return {
    state: overrides.state ?? 'missing',
    raw: overrides.raw ?? null,
    value: overrides.value ?? createEmptyGeneratedIndex('1970-01-01T00:00:00.000Z'),
    diagnostics: dedupeDiagnostics(overrides.diagnostics ?? []),
    errors: dedupeDiagnostics(overrides.errors ?? [])
  };
}

function expectedChangeOutputs(changeId) {
  return [
    { kind: 'change', fileName: `openspec-change-${changeId}.md` },
    { kind: 'merged', fileName: `openspec-merged-${changeId}.md` },
    { kind: 'trace', fileName: `${TRACE_FILE_PREFIX}${changeId}.json` }
  ];
}

function inspectGeneratedCaseAliases(childNames, activeChangeIds) {
  const canonicalPrefix = GENERATED_DIR.replaceAll(path.sep, '/');
  const reserved = [
    { fileName: BASE_FILE },
    { fileName: INDEX_FILE },
    ...activeChangeIds.flatMap((changeId) => expectedChangeOutputs(changeId))
  ].sort((left, right) => left.fileName.localeCompare(right.fileName));
  const reservedByFoldedName = new Map();
  const diagnostics = [];

  for (const item of reserved) {
    const foldedName = item.fileName.toLowerCase();
    const existing = reservedByFoldedName.get(foldedName);

    if (existing !== undefined && existing.fileName !== item.fileName) {
      diagnostics.push({
        code: 'generated-rules-case-alias',
        message: 'Generated-rules canonical targets collide under case-insensitive path matching.',
        path: `${canonicalPrefix}/${existing.fileName}`,
        conflictingPath: `${canonicalPrefix}/${item.fileName}`
      });
      continue;
    }

    reservedByFoldedName.set(foldedName, item);
  }

  for (const childName of Array.from(childNames ?? []).sort((left, right) => left.localeCompare(right))) {
    const reservedTarget = reservedByFoldedName.get(childName.toLowerCase());

    if (reservedTarget !== undefined && reservedTarget.fileName !== childName) {
      diagnostics.push({
        code: 'generated-rules-case-alias',
        message: 'A generated-rules direct child collides with a canonical target under case-insensitive path matching.',
        path: `${canonicalPrefix}/${reservedTarget.fileName}`,
        conflictingPath: `${canonicalPrefix}/${childName}`
      });
    }
  }

  return dedupeDiagnostics(diagnostics).slice(0, 20);
}

function prepareGeneratedRulesBatch({ baseSources, changeResults, selectedChangeIds, generatedAt }) {
  const sortedBaseSources = sortSources(baseSources ?? []);
  const baseContent = renderDocument({
    kind: 'base',
    title: 'Base OpenSpec Rules',
    changeId: null,
    sources: sortedBaseSources,
    emptyMessage: 'No base OpenSpec requirements found.'
  });
  const files = [{
    kind: 'base',
    changeId: null,
    fileName: BASE_FILE,
    content: baseContent
  }];

  for (const changeId of selectedChangeIds) {
    const changeResult = changeResults.get(changeId);
    const rendered = renderGeneratedRules([...sortedBaseSources, ...(changeResult?.sources ?? [])], {
      changeId,
      generatedAt
    });
    const expected = new Set([BASE_FILE, ...expectedChangeOutputs(changeId).map((item) => item.fileName)]);
    const names = rendered.files.map((file) => file.fileName);
    if (
      names.length !== expected.size
      || new Set(names).size !== expected.size
      || names.some((name) => !expected.has(name))
    ) {
      return {
        ok: false,
        files: [],
        indexBase: null,
        errors: [{
          code: 'generated-rules-prepare-failed',
          message: `Generated-rules target preflight failed for '${changeId}'.`,
          phase: 'target-preflight',
          changeId
        }]
      };
    }

    for (const file of rendered.files.filter((item) => item.kind !== 'base')) {
      files.push({ ...file, changeId });
    }
  }

  return {
    ok: true,
    files,
    indexBase: renderIndexBaseEntry(sortedBaseSources),
    errors: []
  };
}

function createPreparationError(phase, changeId, causes = []) {
  const error = new Error('generated-rules preparation failed');
  error.preparationDiagnostic = {
    code: 'generated-rules-prepare-failed',
    message: changeId === null
      ? 'Generated-rules base preparation failed before any mutation.'
      : `Generated-rules preparation failed for '${changeId}' before any mutation.`,
    phase,
    ...(changeId === null ? {} : { changeId }),
    causeCodes: Array.from(causes ?? []).map((item) => item?.code).filter(Boolean).slice(0, 20)
  };
  return error;
}

async function readOptionalGeneratedFile(targetPath, fileOps) {
  try {
    return await fileOps.readFile(targetPath, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') {
      return null;
    }
    throw err;
  }
}

function reuseTraceTimestamp(existingContent, candidateContent) {
  if (typeof existingContent !== 'string') {
    return { reused: false, content: candidateContent, generatedAt: null };
  }

  try {
    const existing = JSON.parse(existingContent);
    const candidate = JSON.parse(candidateContent);
    const generatedAt = typeof existing.generated_at === 'string' ? existing.generated_at : null;
    delete existing.generated_at;
    delete candidate.generated_at;
    if (generatedAt !== null && equalJson(existing, candidate)) {
      return { reused: true, content: existingContent, generatedAt };
    }
  } catch {
    // A malformed prior trace is replaced with the prepared candidate.
  }

  return { reused: false, content: candidateContent, generatedAt: null };
}

function createCommitDiagnostic(code, message) {
  const error = new Error(message);
  error.commitDiagnostic = { code, message };
  return error;
}

async function assertGeneratedRootIdentity({
  rootDir,
  generatedDir,
  fileOps,
  expectedRootIdentity
}) {
  const inspection = await inspectCanonicalDirectoryPath(rootDir, generatedDir, {
    fileOps,
    allowMissing: false,
    unsafeCode: 'generated-rules-root-conflict',
    unsafeMessage: 'The canonical generated-rules root changed after preflight; publishing was stopped.',
    readCode: 'generated-rules-root-conflict',
    readMessage: 'The canonical generated-rules root could not be revalidated before publishing.'
  });

  if (
    !inspection.ok
    || inspection.missing
    || !sameDirectoryIdentity(expectedRootIdentity, inspection.identity)
  ) {
    throw createCommitDiagnostic(
      'generated-rules-root-conflict',
      'The canonical generated-rules root changed after preflight; publishing was stopped.'
    );
  }
}

async function replaceGeneratedFileAtomically({
  rootDir,
  generatedDir,
  fileName,
  content,
  fileOps,
  tempToken,
  expectedRootIdentity
}) {
  const token = String(tempToken ?? `${process.pid}-${Date.now()}`)
    .replace(/[^A-Za-z0-9_.-]/g, '-')
    .slice(0, 80);
  const targetPath = path.join(generatedDir, fileName);
  const tempPath = path.join(generatedDir, `.${fileName}.${token}.tmp`);
  let tempHandle = null;
  let tempOwned = false;
  let ownedTempPath = null;
  let renamed = false;

  try {
    await assertGeneratedRootIdentity({
      rootDir,
      generatedDir,
      fileOps,
      expectedRootIdentity
    });
    tempHandle = await fileOps.open(tempPath, 'wx');
    tempOwned = true;
    ownedTempPath = await fileOps.realpath(tempPath);
    if (normalizeCanonicalPath(path.dirname(ownedTempPath)) !== expectedRootIdentity.resolvedPath) {
      throw createCommitDiagnostic(
        'generated-rules-root-conflict',
        'The canonical generated-rules root changed while an output was being prepared.'
      );
    }
    await assertGeneratedRootIdentity({
      rootDir,
      generatedDir,
      fileOps,
      expectedRootIdentity
    });
    await tempHandle.writeFile(content, { encoding: 'utf8' });
    await tempHandle.close();
    tempHandle = null;
    await assertGeneratedRootIdentity({
      rootDir,
      generatedDir,
      fileOps,
      expectedRootIdentity
    });
    await fileOps.rename(tempPath, targetPath);
    renamed = true;
    await assertGeneratedRootIdentity({
      rootDir,
      generatedDir,
      fileOps,
      expectedRootIdentity
    });
  } catch (err) {
    if (renamed) {
      err.commitMutation = true;
    }
    throw err;
  } finally {
    if (tempHandle !== null) {
      await tempHandle.close().catch(() => {});
    }
    if (tempOwned && !renamed && ownedTempPath !== null) {
      await fileOps.rm(ownedTempPath, { force: true }).catch(() => {});
    }
  }
}

async function replaceGeneratedIndexAtomically(options) {
  return replaceGeneratedFileAtomically({
    ...options,
    fileName: INDEX_FILE
  });
}

function validateReconcileSelection(selectionSource, activeChangeIds, selectedChangeIds) {
  const active = new Set(activeChangeIds);
  const errors = [];

  for (const changeId of selectedChangeIds) {
    if (!active.has(changeId)) {
      errors.push({
        code: 'selected-change-not-active',
        message: `Selected OpenSpec change '${changeId}' is not present in the active inventory.`,
        changeId
      });
    }
  }

  if (selectionSource === 'all' && !sameStringSet(activeChangeIds, selectedChangeIds)) {
    errors.push({
      code: 'generated-rules-selection-incomplete',
      message: 'All-change generated-rules reconciliation requires the complete active inventory.'
    });
  }
  if (selectionSource === 'none' && (activeChangeIds.length > 0 || selectedChangeIds.length > 0)) {
    errors.push({
      code: 'generated-rules-selection-invalid',
      message: 'No-active generated-rules reconciliation requires an empty active and selected set.'
    });
  }
  if (selectionSource === 'ambiguous-base-only' && selectedChangeIds.length > 0) {
    errors.push({
      code: 'generated-rules-selection-invalid',
      message: 'Ambiguous base-only reconciliation cannot compile change-specific overlays.'
    });
  }

  return errors;
}

function normalizeChangeIdList(values) {
  const changeIds = [];
  const errors = [];

  for (const value of Array.from(values ?? [])) {
    const candidate = typeof value === 'string' ? value : value?.id;
    const normalized = normalizeChangeId(candidate);
    if (!normalized.ok) {
      errors.push(normalized.error);
      continue;
    }
    changeIds.push(normalized.changeId);
  }

  return {
    ok: errors.length === 0,
    changeIds: [...new Set(changeIds)].sort((left, right) => left.localeCompare(right)),
    errors
  };
}

function createActiveInventoryResult(overrides = {}) {
  const missing = Boolean(overrides.missing);
  return {
    ok: overrides.ok ?? true,
    missing,
    changeIds: overrides.changeIds ?? [],
    changes: overrides.changes ?? [],
    snapshot: overrides.snapshot ?? fingerprintValue({ missing, entries: [] }),
    warnings: dedupeDiagnostics(overrides.warnings ?? []),
    errors: dedupeDiagnostics(overrides.errors ?? [])
  };
}

function createGeneratedRulesInspection(overrides = {}) {
  const activeChangeIds = overrides.activeChangeIds ?? [];
  const indexedChangeIds = overrides.indexedChangeIds ?? [];
  const orphanedIndexEntries = overrides.orphanedIndexEntries ?? [];
  const orphanedManagedFiles = overrides.orphanedManagedFiles ?? [];
  const missingActiveIndexEntries = overrides.missingActiveIndexEntries ?? [];
  const missingActiveManagedFiles = overrides.missingActiveManagedFiles ?? [];
  const invalidManagedEntries = overrides.invalidManagedEntries ?? [];
  return {
    ok: overrides.ok ?? true,
    state: overrides.state ?? 'ok',
    indexState: overrides.indexState ?? 'missing',
    activeChangeIds,
    indexedChangeIds,
    orphanedIndexEntries,
    orphanedManagedFiles,
    missingActiveIndexEntries,
    missingActiveManagedFiles,
    invalidManagedEntries,
    active_change_ids: activeChangeIds,
    indexed_change_ids: indexedChangeIds,
    orphaned_index_entries: orphanedIndexEntries,
    orphaned_managed_files: orphanedManagedFiles,
    missing_active_index_entries: missingActiveIndexEntries,
    missing_active_managed_files: missingActiveManagedFiles,
    invalid_managed_entries: invalidManagedEntries,
    missing: overrides.missing ?? [],
    warnings: dedupeDiagnostics(overrides.warnings ?? []),
    errors: dedupeDiagnostics(overrides.errors ?? [])
  };
}

function createReconcileResult(overrides = {}) {
  const allOperations = Array.from(overrides.operations ?? []).sort(compareOperations);
  const operations = allOperations.slice(0, PUBLIC_OPERATION_LIMIT);
  const operationCount = allOperations.length;
  const operationsTruncated = operationCount > operations.length;
  const allFiles = Array.from(overrides.files ?? []);
  const files = allFiles.slice(0, PUBLIC_OPERATION_LIMIT);
  const activeChangeIds = Array.from(overrides.activeChangeIds ?? []);
  const selectedChangeIds = Array.from(overrides.selectedChangeIds ?? []);
  const retainedChangeIds = Array.from(overrides.retainedChangeIds ?? []);
  const removedChangeIds = Array.from(overrides.removedChangeIds ?? []);
  const orphanedIndexEntries = Array.from(overrides.orphanedIndexEntries ?? []);
  const orphanedManagedFiles = Array.from(overrides.orphanedManagedFiles ?? []);
  const missingActiveIndexEntries = Array.from(overrides.missingActiveIndexEntries ?? []);

  return {
    ok: overrides.ok ?? false,
    dryRun: Boolean(overrides.dryRun),
    partial: Boolean(overrides.partial),
    selectionSource: overrides.selectionSource ?? null,
    activeChangeIds: activeChangeIds.slice(0, PUBLIC_OPERATION_LIMIT),
    selectedChangeIds: selectedChangeIds.slice(0, PUBLIC_OPERATION_LIMIT),
    retainedChangeIds: retainedChangeIds.slice(0, PUBLIC_OPERATION_LIMIT),
    removedChangeIds: removedChangeIds.slice(0, PUBLIC_OPERATION_LIMIT),
    active_change_ids: activeChangeIds.slice(0, PUBLIC_OPERATION_LIMIT),
    selected_change_ids: selectedChangeIds.slice(0, PUBLIC_OPERATION_LIMIT),
    retained_change_ids: retainedChangeIds.slice(0, PUBLIC_OPERATION_LIMIT),
    removed_change_ids: removedChangeIds.slice(0, PUBLIC_OPERATION_LIMIT),
    activeChangeCount: activeChangeIds.length,
    selectedChangeCount: selectedChangeIds.length,
    retainedChangeCount: retainedChangeIds.length,
    removedChangeCount: removedChangeIds.length,
    active_change_count: activeChangeIds.length,
    selected_change_count: selectedChangeIds.length,
    retained_change_count: retainedChangeIds.length,
    removed_change_count: removedChangeIds.length,
    orphanedIndexEntries: orphanedIndexEntries.slice(0, PUBLIC_OPERATION_LIMIT),
    orphanedManagedFiles: orphanedManagedFiles.slice(0, PUBLIC_OPERATION_LIMIT),
    missingActiveIndexEntries: missingActiveIndexEntries.slice(0, PUBLIC_OPERATION_LIMIT),
    orphaned_index_entries: orphanedIndexEntries.slice(0, PUBLIC_OPERATION_LIMIT),
    orphaned_managed_files: orphanedManagedFiles.slice(0, PUBLIC_OPERATION_LIMIT),
    missing_active_index_entries: missingActiveIndexEntries.slice(0, PUBLIC_OPERATION_LIMIT),
    baseOnly: Boolean(overrides.baseOnly),
    changeSpecificSkipped: Boolean(overrides.changeSpecificSkipped),
    openspecCli: overrides.openspecCli ?? null,
    files,
    fileCount: allFiles.length,
    filesTruncated: allFiles.length > files.length,
    file_count: allFiles.length,
    files_truncated: allFiles.length > files.length,
    operations,
    operationCount,
    operationsTruncated,
    operation_count: operationCount,
    operations_truncated: operationsTruncated,
    warnings: dedupeDiagnostics(overrides.warnings ?? []),
    errors: dedupeDiagnostics(overrides.errors ?? [])
  };
}

function compareOperations(left, right) {
  return String(left.target).localeCompare(String(right.target))
    || String(left.action).localeCompare(String(right.action))
    || String(left.kind).localeCompare(String(right.kind));
}

function sameStringSet(left, right) {
  const leftValues = [...new Set(left)].sort((a, b) => a.localeCompare(b));
  const rightValues = [...new Set(right)].sort((a, b) => a.localeCompare(b));
  return leftValues.length === rightValues.length
    && leftValues.every((value, index) => value === rightValues[index]);
}

function equalJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function fingerprintValue(value) {
  return createFingerprint(JSON.stringify(value));
}

function createCompilerResult(overrides = {}) {
  return {
    ok: overrides.ok ?? false,
    changeId: overrides.changeId ?? null,
    mode: overrides.mode ?? 'failed',
    warnings: dedupeDiagnostics(overrides.warnings ?? []),
    errors: overrides.errors ?? [],
    sources: overrides.sources ?? [],
    files: overrides.files ?? [],
    openspecCli: overrides.openspecCli ?? null
  };
}

function createSourceResult(overrides = {}) {
  return {
    ok: overrides.ok ?? false,
    mode: overrides.mode ?? 'failed',
    warnings: dedupeDiagnostics(overrides.warnings ?? []),
    errors: overrides.errors ?? [],
    sources: overrides.sources ?? [],
    openspecCli: overrides.openspecCli ?? null
  };
}

function createWriteResult(overrides = {}) {
  return {
    ok: overrides.ok ?? false,
    warnings: dedupeDiagnostics(overrides.warnings ?? []),
    errors: overrides.errors ?? [],
    files: overrides.files ?? []
  };
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

function isWithinDirectory(targetPath, dirPath) {
  const relative = path.relative(dirPath, targetPath);
  return relative.length === 0 || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function toPosix(value) {
  return String(value).replaceAll(path.sep, '/');
}
