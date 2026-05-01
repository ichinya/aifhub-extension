// aif-artifact-sync.mjs - mode-aware AIFHub artifact synchronization helpers
import { access, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import {
  normalizeChangeId,
  resolveActiveChange,
  writeCurrentChangePointer
} from './active-change-resolver.mjs';
import {
  collectOpenSpecRuleSources,
  compileOpenSpecRules,
  renderGeneratedRules
} from './openspec-rules-compiler.mjs';
import {
  detectOpenSpec as defaultDetectOpenSpec,
  getOpenSpecStatus as defaultGetOpenSpecStatus,
  validateOpenSpecChange as defaultValidateOpenSpecChange
} from './openspec-runner.mjs';
import {
  discoverLegacyPlans,
  migrateAllLegacyPlans
} from './legacy-plan-migration.mjs';
import {
  getLatestGateResult
} from './aif-gate-result.mjs';

export const MODES = {
  openspec: 'openspec',
  aiFactory: 'ai-factory',
  unknown: 'unknown'
};

const DEFAULT_CONFIG_PATH = path.join('.ai-factory', 'config.yaml');
const DEFAULT_OPEN_SPEC_ROOT = 'openspec';
const DEFAULT_OPEN_SPEC_PATHS = {
  plans: 'openspec/changes',
  specs: 'openspec/specs',
  rules: '.ai-factory/rules',
  state: '.ai-factory/state',
  qa: '.ai-factory/qa',
  generated_rules: '.ai-factory/rules/generated'
};
const DEFAULT_OPENSPEC_SETTINGS = {
  root: DEFAULT_OPEN_SPEC_ROOT,
  installSkills: false,
  validateOnPlan: true,
  validateOnImprove: true,
  validateOnVerify: true,
  statusOnVerify: true,
  archiveOnDone: true,
  useInstructionsApply: true,
  compileRulesOnSync: true,
  validateOnSync: true,
  requireCliForVerify: false,
  requireCliForDone: true
};
const DEFAULT_AI_FACTORY_PATHS = {
  plans: '.ai-factory/plans',
  specs: '.ai-factory/specs',
  rules: '.ai-factory/rules'
};
const DEFAULT_CONTEXT_PATHS = {
  description: '.ai-factory/DESCRIPTION.md',
  architecture: '.ai-factory/ARCHITECTURE.md',
  roadmap: '.ai-factory/ROADMAP.md',
  research: '.ai-factory/RESEARCH.md'
};
const MODE_SWITCH_DIR = path.join('.ai-factory', 'state', 'mode-switches');
const OPEN_SPEC_CONFIG = path.join('openspec', 'config.yaml');

export async function getModeStatus(options = {}) {
  const rootDir = resolveRootDir(options);
  const config = await readProjectConfig(rootDir);
  const mode = resolveMode(config);
  const detection = await detectOpenSpecCapability(rootDir, options);
  const openSpecChanges = await listOpenSpecChanges({ rootDir });
  const legacy = await discoverLegacyPlans({ rootDir });
  const generatedRules = await inspectGeneratedRules({
    ...options,
    rootDir,
    changeIds: selectRuleInspectionChanges(openSpecChanges)
  });
  const activeChange = await inspectActiveChange({
    ...options,
    rootDir,
    changeId: options.changeId
  });

  return {
    ok: true,
    mode,
    config,
    configMarker: config.marker,
    configPath: DEFAULT_CONFIG_PATH,
    configExists: config.exists,
    openspecCli: summarizeOpenSpecDetection(detection),
    openSpecChanges,
    legacyPlans: legacy.ok ? legacy.plans : [],
    legacyPlanErrors: legacy.errors ?? [],
    generatedRules,
    activeChange,
    warnings: [
      ...(legacy.warnings ?? []),
      ...generatedRules.warnings
    ],
    errors: [
      ...(legacy.errors ?? []),
      ...generatedRules.errors
    ]
  };
}

export async function switchToOpenSpecMode(options = {}) {
  const rootDir = resolveRootDir(options);
  const dryRun = Boolean(options.dryRun);
  const config = await writeModeConfig(MODES.openspec, { ...options, rootDir });
  const skeleton = await ensureOpenSpecSkeleton({ ...options, rootDir });
  const legacy = await discoverLegacyPlans({ rootDir });
  const migration = await maybeMigrateLegacyPlans({
    ...options,
    rootDir,
    legacyPlans: legacy.ok ? legacy.plans : []
  });
  const sync = await syncOpenSpecArtifacts({
    ...options,
    rootDir,
    all: options.all || options.changeId === undefined,
    writeReport: false
  });
  const report = await writeModeReport('openspec', {
    ...options,
    rootDir,
    dryRun,
    title: 'Mode Switch: OpenSpec',
    mode: MODES.openspec,
    sections: [
      renderConfigSection(config),
      renderSkeletonSection(skeleton),
      renderLegacyMigrationSection(legacy, migration),
      renderSyncSection(sync)
    ]
  });

  return {
    ok: config.ok && skeleton.ok && migration.ok && sync.ok,
    dryRun,
    mode: MODES.openspec,
    config,
    skeleton,
    legacy,
    migration,
    sync,
    report,
    warnings: dedupeDiagnostics([
      ...config.warnings,
      ...skeleton.warnings,
      ...(legacy.warnings ?? []),
      ...migration.warnings,
      ...sync.warnings
    ]),
    errors: [
      ...config.errors,
      ...skeleton.errors,
      ...(legacy.errors ?? []),
      ...migration.errors,
      ...sync.errors
    ]
  };
}

export async function switchToAiFactoryMode(options = {}) {
  const rootDir = resolveRootDir(options);
  const dryRun = Boolean(options.dryRun);
  const config = await writeModeConfig(MODES.aiFactory, { ...options, rootDir });
  const skeleton = await ensureAiFactorySkeleton({ ...options, rootDir });
  const exportResult = options.exportOpenSpec
    ? await exportOpenSpecCompatibility({ ...options, rootDir })
    : createSkippedResult('compatibility export was not requested');
  const report = await writeModeReport('ai-factory', {
    ...options,
    rootDir,
    dryRun,
    title: 'Mode Switch: AI Factory',
    mode: MODES.aiFactory,
    sections: [
      renderConfigSection(config),
      renderSkeletonSection(skeleton),
      renderExportSection(exportResult),
      'OpenSpec artifacts under `openspec/` were preserved.'
    ]
  });

  return {
    ok: config.ok && skeleton.ok && exportResult.ok,
    dryRun,
    mode: MODES.aiFactory,
    config,
    skeleton,
    export: exportResult,
    report,
    warnings: dedupeDiagnostics([
      ...config.warnings,
      ...skeleton.warnings,
      ...exportResult.warnings
    ]),
    errors: [
      ...config.errors,
      ...skeleton.errors,
      ...exportResult.errors
    ]
  };
}

export async function syncArtifacts(options = {}) {
  const rootDir = resolveRootDir(options);
  const status = await getModeStatus({ ...options, rootDir });

  if (status.mode === MODES.openspec) {
    return syncOpenSpecArtifacts({ ...options, rootDir });
  }

  if (status.mode === MODES.aiFactory) {
    return syncAiFactoryArtifacts({ ...options, rootDir });
  }

  return {
    ok: false,
    dryRun: Boolean(options.dryRun),
    mode: MODES.unknown,
    warnings: [],
    errors: [
      {
        code: 'unknown-artifact-mode',
        message: 'Cannot sync artifacts because aifhub.artifactProtocol is missing or unknown.'
      }
    ]
  };
}

export async function syncOpenSpecArtifacts(options = {}) {
  const rootDir = resolveRootDir(options);
  const dryRun = Boolean(options.dryRun);
  const config = await readProjectConfig(rootDir);
  const openspecSettings = getOpenSpecSettings(config);
  const skeleton = await ensureOpenSpecSkeleton({ ...options, rootDir });
  const changes = await resolveSyncChangeIds({ ...options, rootDir });
  const generatedRules = openspecSettings.compileRulesOnSync
    ? await syncGeneratedRules({
      ...options,
      rootDir,
      changeIds: changes.changeIds
    })
    : createSkippedGeneratedRulesSync(dryRun, 'compileRulesOnSync-disabled');
  const validation = openspecSettings.validateOnSync
    ? await validateOpenSpecChanges({
      ...options,
      rootDir,
      changeIds: changes.changeIds
    })
    : createSkippedValidationSync('validateOnSync-disabled');
  const legacy = await discoverLegacyPlans({ rootDir });
  const pointer = await maybeUpdateCurrentPointer({
    ...options,
    rootDir,
    changeIds: changes.changeIds
  });
  const report = options.writeReport === false
    ? createSkippedResult('report write disabled')
    : await writeModeReport('sync-openspec', {
      ...options,
      rootDir,
      dryRun,
      title: 'Artifact Sync: OpenSpec',
      mode: MODES.openspec,
      sections: [
        renderSkeletonSection(skeleton),
        renderChangeSelectionSection(changes),
        renderGeneratedRulesSection(generatedRules),
        renderValidationSection(validation),
        renderLegacyDetectionSection(legacy),
        renderPointerSection(pointer)
      ]
    });

  return {
    ok: skeleton.ok && changes.ok && generatedRules.ok && validation.ok && pointer.ok,
    dryRun,
    mode: MODES.openspec,
    skeleton,
    changes,
    generatedRules,
    validation,
    legacy,
    pointer,
    report,
    warnings: dedupeDiagnostics([
      ...skeleton.warnings,
      ...changes.warnings,
      ...generatedRules.warnings,
      ...validation.warnings,
      ...(legacy.warnings ?? []),
      ...pointer.warnings
    ]),
    errors: [
      ...skeleton.errors,
      ...changes.errors,
      ...generatedRules.errors,
      ...validation.errors,
      ...(legacy.errors ?? []),
      ...pointer.errors
    ]
  };
}

export async function syncAiFactoryArtifacts(options = {}) {
  const rootDir = resolveRootDir(options);
  const dryRun = Boolean(options.dryRun);
  const skeleton = await ensureAiFactorySkeleton({ ...options, rootDir });
  const exportResult = options.exportOpenSpec
    ? await exportOpenSpecCompatibility({ ...options, rootDir })
    : createSkippedResult('compatibility export was not requested');
  const report = options.writeReport === false
    ? createSkippedResult('report write disabled')
    : await writeModeReport('sync-ai-factory', {
      ...options,
      rootDir,
      dryRun,
      title: 'Artifact Sync: AI Factory',
      mode: MODES.aiFactory,
      sections: [
        renderSkeletonSection(skeleton),
        renderExportSection(exportResult),
        'OpenSpec artifacts under `openspec/` were preserved.'
      ]
    });

  return {
    ok: skeleton.ok && exportResult.ok,
    dryRun,
    mode: MODES.aiFactory,
    skeleton,
    export: exportResult,
    report,
    warnings: dedupeDiagnostics([
      ...skeleton.warnings,
      ...exportResult.warnings
    ]),
    errors: [
      ...skeleton.errors,
      ...exportResult.errors
    ]
  };
}

export async function doctorAifMode(options = {}) {
  const rootDir = resolveRootDir(options);
  const status = await getModeStatus({ ...options, rootDir });
  const openspecSettings = getOpenSpecSettings(status.config);
  const diagnostics = [];

  diagnostics.push(status.configExists && status.configMarker !== null
    ? pass('config-marker', `Config marker is ${status.configMarker}.`)
    : fail('config-marker-missing', 'Missing aifhub.artifactProtocol in .ai-factory/config.yaml.'));

  const pathChecks = await inspectConfiguredPaths({
    ...options,
    rootDir,
    mode: status.mode
  });
  diagnostics.push(...pathChecks);

  diagnostics.push(status.openspecCli.known
    ? pass('openspec-cli-known', `OpenSpec CLI capability is ${status.openspecCli.state}.`)
    : warn('openspec-cli-unknown', 'OpenSpec CLI capability could not be detected.'));

  if (status.openspecCli.nodeSupported === false) {
    diagnostics.push(fail(
      'openspec-node-unsupported',
      `Node ${status.openspecCli.nodeVersion ?? 'unknown'} does not satisfy the OpenSpec CLI requirement.`
    ));
  }

  if (status.activeChange.state === 'ambiguous') {
    diagnostics.push(fail('ambiguous-active-change', 'Multiple active OpenSpec changes can be selected.'));
  } else if (status.activeChange.state === 'none') {
    diagnostics.push(warn('no-active-change', 'No active OpenSpec change is selected.'));
  } else {
    diagnostics.push(pass('active-change', `Active change is ${status.activeChange.changeId}.`));
  }

  if (status.generatedRules.state === 'ok') {
    diagnostics.push(pass('generated-rules', 'Generated rules are present and current.'));
  } else if (status.generatedRules.state === 'stale') {
    diagnostics.push(warn('generated-rules-stale', 'Generated rules are stale.'));
  } else {
    diagnostics.push(warn('generated-rules-missing', 'Generated rules are missing.'));
  }

  if (status.mode === MODES.openspec && status.legacyPlans.length > 0) {
    diagnostics.push(warn(
      'legacy-plans-present-in-openspec-mode',
      'Legacy .ai-factory/plans artifacts exist in OpenSpec-native mode; treat them as migration input only.'
    ));
  }

  if (status.mode === MODES.openspec && status.activeChange.state === 'resolved') {
    diagnostics.push(await inspectVerifyGateDiagnostic(rootDir, status));
  }

  if (status.mode === MODES.openspec && status.openspecCli.canValidate && status.activeChange.state === 'resolved') {
    const validation = await validateOpenSpecChanges({
      ...options,
      rootDir,
      changeIds: [status.activeChange.changeId]
    });

    if (validation.ok) {
      diagnostics.push(pass('openspec-validation', 'Active OpenSpec change validates with the available CLI.'));
    } else {
      diagnostics.push(fail('openspec-validation-failed', 'Active OpenSpec change failed validation.'));
    }
  }

  if (status.mode === MODES.openspec && openspecSettings.archiveOnDone && openspecSettings.requireCliForDone) {
    diagnostics.push(status.openspecCli.canArchive
      ? pass('aif-done-archive-ready', '/aif-done archive-required finalization can use the OpenSpec CLI.')
      : fail('aif-done-archive-unavailable', '/aif-done archive-required finalization needs a compatible OpenSpec CLI.'));
  }

  const errors = diagnostics.filter((item) => item.level === 'fail');
  const warnings = diagnostics.filter((item) => item.level === 'warn');

  return {
    ok: errors.length === 0,
    mode: status.mode,
    status,
    diagnostics,
    warnings,
    errors
  };
}

export async function exportOpenSpecCompatibility(options = {}) {
  const rootDir = resolveRootDir(options);
  const dryRun = Boolean(options.dryRun);
  const overwrite = Boolean(options.yes || options.overwrite);
  const selected = await resolveExportChangeIds({ ...options, rootDir });

  if (!selected.ok) {
    return {
      ok: false,
      dryRun,
      exported: [],
      operations: [],
      warnings: selected.warnings,
      errors: selected.errors
    };
  }

  const results = [];
  for (const changeId of selected.changeIds) {
    results.push(await exportOpenSpecChangeToLegacy(changeId, {
      ...options,
      rootDir,
      dryRun,
      overwrite
    }));
  }

  const exported = results.filter((result) => result.ok).map((result) => result.changeId);
  const warnings = dedupeDiagnostics([
    ...selected.warnings,
    ...results.flatMap((result) => result.warnings)
  ]);
  const errors = results.flatMap((result) => result.errors);

  return {
    ok: errors.length === 0,
    dryRun,
    exported,
    operations: results.flatMap((result) => result.operations),
    results,
    warnings,
    errors
  };
}

export async function readProjectConfig(rootDir = process.cwd()) {
  const configPath = path.join(resolveRootDir({ rootDir }), DEFAULT_CONFIG_PATH);

  try {
    const raw = await readFile(configPath, 'utf8');
    const parsed = parseSimpleYaml(raw);
    const marker = parsed.aifhub?.artifactProtocol ?? null;

    return {
      exists: true,
      raw,
      parsed,
      marker,
      paths: parsed.paths ?? {},
      aifhub: parsed.aifhub ?? {}
    };
  } catch {
    return {
      exists: false,
      raw: '',
      parsed: {},
      marker: null,
      paths: {},
      aifhub: {}
    };
  }
}

function getOpenSpecSettings(config) {
  return {
    ...DEFAULT_OPENSPEC_SETTINGS,
    ...(config?.aifhub?.openspec ?? config?.parsed?.aifhub?.openspec ?? {})
  };
}

export async function writeModeConfig(mode, options = {}) {
  const rootDir = resolveRootDir(options);
  const dryRun = Boolean(options.dryRun);
  const config = await readProjectConfig(rootDir);
  const content = renderConfigForMode(config.raw, mode);
  const target = path.join(rootDir, DEFAULT_CONFIG_PATH);
  const operation = {
    action: config.exists ? 'update' : 'create',
    target: DEFAULT_CONFIG_PATH
  };

  if (!dryRun) {
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, 'utf8');
  }

  return {
    ok: true,
    dryRun,
    mode,
    operations: [operation],
    warnings: [],
    errors: []
  };
}

export function renderConfigForMode(existingRaw, mode) {
  const parsed = parseSimpleYaml(existingRaw);
  const paths = parsed.paths ?? {};
  const blocks = parseTopLevelBlocks(existingRaw);
  const used = new Set(['config_version', 'language', 'aifhub', 'paths']);
  const rendered = [];

  rendered.push(renderScalarOrDefault(blocks, 'config_version', 'config_version: 1'));
  rendered.push(renderBlockOrDefault(blocks, 'language', [
    'language:',
    '  ui: en',
    '  artifacts: en',
    '  technical_terms: keep'
  ].join('\n')));
  rendered.push(renderAifhubBlock(mode));
  rendered.push(renderPathsBlock(mode, paths));

  for (const block of blocks) {
    if (!used.has(block.key)) {
      rendered.push(block.text.trimEnd());
    }
  }

  if (!blocks.some((block) => block.key === 'workflow')) {
    rendered.push([
      'workflow:',
      '  auto_create_dirs: true',
      '  plan_id_format: slug',
      '  analyze_updates_architecture: true',
      '  architecture_updates_roadmap: true',
      '  verify_mode: strict'
    ].join('\n'));
  }

  if (!blocks.some((block) => block.key === 'rules')) {
    rendered.push([
      'rules:',
      '  base: .ai-factory/rules/base.md',
      '  skills: .ai-factory/rules/skills.md'
    ].join('\n'));
  }

  if (!blocks.some((block) => block.key === 'agent_profile')) {
    rendered.push('agent_profile: default');
  }

  return `${rendered.filter(Boolean).join('\n')}\n`;
}

export async function ensureOpenSpecSkeleton(options = {}) {
  const rootDir = resolveRootDir(options);
  const dryRun = Boolean(options.dryRun);
  const dirs = [
    'openspec/specs',
    'openspec/changes',
    '.ai-factory/state',
    '.ai-factory/qa',
    '.ai-factory/rules/generated'
  ];
  const ensured = await ensureDirectories(rootDir, dirs, { dryRun });
  const configResult = await ensureOpenSpecConfig(rootDir, { dryRun });

  return {
    ok: ensured.ok && configResult.ok,
    dryRun,
    operations: [...ensured.operations, ...configResult.operations],
    created: [...ensured.created, ...configResult.created],
    preserved: [...ensured.preserved, ...configResult.preserved],
    warnings: dedupeDiagnostics([...ensured.warnings, ...configResult.warnings]),
    errors: [...ensured.errors, ...configResult.errors]
  };
}

export async function ensureAiFactorySkeleton(options = {}) {
  const rootDir = resolveRootDir(options);
  const dryRun = Boolean(options.dryRun);
  return ensureDirectories(rootDir, [
    '.ai-factory/plans',
    '.ai-factory/specs',
    '.ai-factory/rules'
  ], { dryRun });
}

export async function listOpenSpecChanges(options = {}) {
  const rootDir = resolveRootDir(options);
  const changesRoot = path.join(rootDir, 'openspec', 'changes');

  try {
    const entries = await readdir(changesRoot, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => name !== 'archive' && !name.startsWith('.'))
      .filter((name) => normalizeChangeId(name).ok)
      .sort((left, right) => left.localeCompare(right))
      .map((id) => ({ id, path: `openspec/changes/${id}` }));
  } catch {
    return [];
  }
}

export async function inspectGeneratedRules(options = {}) {
  const rootDir = resolveRootDir(options);
  const changeIds = Array.from(options.changeIds ?? []).map((item) => typeof item === 'string' ? item : item.id);
  const expected = new Set(['openspec-base.md']);

  for (const changeId of changeIds) {
    expected.add(`openspec-change-${changeId}.md`);
    expected.add(`openspec-merged-${changeId}.md`);
  }

  const missing = [];
  const stale = [];
  const warnings = [];
  const errors = [];

  for (const fileName of expected) {
    if (!await pathExists(path.join(rootDir, '.ai-factory', 'rules', 'generated', fileName))) {
      missing.push(fileName);
    }
  }

  for (const changeId of changeIds) {
    const normalized = normalizeChangeId(changeId);
    if (!normalized.ok) {
      errors.push(normalized.error);
      continue;
    }

    const collected = await collectOpenSpecRuleSources(normalized.changeId, {
      ...options,
      rootDir
    });
    warnings.push(...collected.warnings);

    if (!collected.ok) {
      errors.push(...collected.errors);
      continue;
    }

    const rendered = renderGeneratedRules(collected.sources, { changeId: normalized.changeId });
    for (const file of rendered.files) {
      const target = path.join(rootDir, '.ai-factory', 'rules', 'generated', file.fileName);
      try {
        const current = await readFile(target, 'utf8');
        if (current !== file.content) {
          stale.push(file.fileName);
        }
      } catch {
        // Already reported as missing.
      }
    }
  }

  const state = stale.length > 0 ? 'stale' : missing.length > 0 ? 'missing' : 'ok';

  return {
    ok: errors.length === 0,
    state,
    expected: [...expected].sort((left, right) => left.localeCompare(right)),
    missing: missing.sort((left, right) => left.localeCompare(right)),
    stale: [...new Set(stale)].sort((left, right) => left.localeCompare(right)),
    warnings: dedupeDiagnostics(warnings),
    errors
  };
}

async function syncGeneratedRules(options = {}) {
  const rootDir = resolveRootDir(options);
  const dryRun = Boolean(options.dryRun);
  const changeIds = Array.from(options.changeIds ?? []);
  const results = [];

  for (const changeId of changeIds) {
    if (dryRun) {
      const collected = await collectOpenSpecRuleSources(changeId, { ...options, rootDir });
      if (!collected.ok) {
        results.push({
          ok: false,
          changeId,
          files: [],
          warnings: collected.warnings,
          errors: collected.errors
        });
        continue;
      }

      const rendered = renderGeneratedRules(collected.sources, { changeId });
      results.push({
        ok: true,
        dryRun: true,
        changeId,
        files: rendered.files.map((file) => ({
          kind: file.kind,
          relativePath: `.ai-factory/rules/generated/${file.fileName}`,
          written: false
        })),
        warnings: collected.warnings,
        errors: []
      });
      continue;
    }

    results.push(await compileOpenSpecRules(changeId, { ...options, rootDir }));
  }

  return {
    ok: results.every((result) => result.ok),
    dryRun,
    results,
    files: results.flatMap((result) => result.files ?? []),
    warnings: dedupeDiagnostics(results.flatMap((result) => result.warnings ?? [])),
    errors: results.flatMap((result) => result.errors ?? [])
  };
}

async function validateOpenSpecChanges(options = {}) {
  const rootDir = resolveRootDir(options);
  const changeIds = Array.from(options.changeIds ?? []);
  const detection = await detectOpenSpecCapability(rootDir, options);

  if (!detection.canValidate) {
    return {
      ok: true,
      skipped: true,
      reason: detection.reason ?? 'openspec-cli-unavailable',
      detection: summarizeOpenSpecDetection(detection),
      results: [],
      warnings: normalizeDetectionWarnings(detection),
      errors: []
    };
  }

  const validateOpenSpecChange = options.validateOpenSpecChange ?? defaultValidateOpenSpecChange;
  const getOpenSpecStatus = options.getOpenSpecStatus ?? defaultGetOpenSpecStatus;
  const results = [];

  for (const changeId of changeIds) {
    const validation = await validateOpenSpecChange(changeId, createRunOptions(rootDir, options));
    const status = validation.ok
      ? await getOpenSpecStatus(changeId, createRunOptions(rootDir, options))
      : null;

    results.push({
      changeId,
      validation,
      status,
      ok: Boolean(validation.ok && (status === null || status.ok))
    });
  }

  return {
    ok: results.every((result) => result.ok),
    skipped: false,
    detection: summarizeOpenSpecDetection(detection),
    results,
    warnings: [],
    errors: results
      .filter((result) => !result.ok)
      .map((result) => ({
        code: 'openspec-validation-failed',
        message: `OpenSpec validation/status failed for '${result.changeId}'.`
      }))
  };
}

async function resolveSyncChangeIds(options = {}) {
  const rootDir = resolveRootDir(options);

  if (options.all) {
    const changes = await listOpenSpecChanges({ rootDir });
    return {
      ok: true,
      source: 'all',
      changeIds: changes.map((change) => change.id),
      warnings: [],
      errors: []
    };
  }

  if (options.changeId) {
    const normalized = normalizeChangeId(options.changeId);
    return normalized.ok
      ? {
        ok: true,
        source: 'explicit',
        changeIds: [normalized.changeId],
        warnings: [],
        errors: []
      }
      : {
        ok: false,
        source: 'explicit',
        changeIds: [],
        warnings: [],
        errors: [normalized.error]
      };
  }

  const resolved = await resolveActiveChange({
    rootDir,
    cwd: options.cwd ?? process.cwd(),
    getCurrentBranch: options.getCurrentBranch
  });

  if (resolved.ok) {
    return {
      ok: true,
      source: resolved.source,
      changeIds: [resolved.changeId],
      warnings: resolved.warnings,
      errors: []
    };
  }

  const changes = await listOpenSpecChanges({ rootDir });
  if (changes.length === 0 && resolved.errors.some((error) => error.code === 'no-active-change')) {
    return {
      ok: true,
      source: 'none',
      changeIds: [],
      warnings: [],
      errors: []
    };
  }

  return {
    ok: false,
    source: 'active',
    changeIds: [],
    warnings: resolved.warnings,
    errors: resolved.errors
  };
}

async function resolveExportChangeIds(options = {}) {
  if (options.all) {
    const changes = await listOpenSpecChanges(options);
    return {
      ok: true,
      changeIds: changes.map((change) => change.id),
      warnings: [],
      errors: []
    };
  }

  if (options.changeId) {
    const normalized = normalizeChangeId(options.changeId);
    return normalized.ok
      ? { ok: true, changeIds: [normalized.changeId], warnings: [], errors: [] }
      : { ok: false, changeIds: [], warnings: [], errors: [normalized.error] };
  }

  const active = await resolveActiveChange(options);
  return active.ok
    ? { ok: true, changeIds: [active.changeId], warnings: active.warnings, errors: [] }
    : { ok: false, changeIds: [], warnings: active.warnings, errors: active.errors };
}

async function exportOpenSpecChangeToLegacy(changeId, options = {}) {
  const rootDir = resolveRootDir(options);
  const dryRun = Boolean(options.dryRun);
  const normalized = normalizeChangeId(changeId);

  if (!normalized.ok) {
    return {
      ok: false,
      changeId: null,
      operations: [],
      warnings: [],
      errors: [normalized.error]
    };
  }

  const id = normalized.changeId;
  const changeDir = path.join(rootDir, 'openspec', 'changes', id);

  if (!await isDirectory(changeDir)) {
    return {
      ok: false,
      changeId: id,
      operations: [],
      warnings: [],
      errors: [
        {
          code: 'openspec-change-not-found',
          message: `OpenSpec change '${id}' was not found.`
        }
      ]
    };
  }

  const artifacts = await renderCompatibilityArtifacts(rootDir, id);
  const collisions = [];
  for (const artifact of artifacts) {
    assertSafeCompatibilityTarget(rootDir, id, artifact.target);
    if (!options.overwrite && await pathExists(path.join(rootDir, artifact.target))) {
      collisions.push(artifact.target);
    }
  }

  if (collisions.length > 0) {
    return {
      ok: false,
      changeId: id,
      operations: artifacts.map((artifact) => ({
        action: 'skip',
        target: artifact.target,
        reason: collisions.includes(artifact.target) ? 'target-exists' : 'blocked-by-collision'
      })),
      warnings: [],
      errors: collisions.map((target) => ({
        code: 'target-exists',
        message: `Compatibility export target already exists: ${target}. Pass --yes to overwrite.`,
        target
      }))
    };
  }

  if (!dryRun) {
    for (const artifact of artifacts) {
      const targetPath = path.join(rootDir, artifact.target);
      await mkdir(path.dirname(targetPath), { recursive: true });
      await writeFile(targetPath, artifact.content, 'utf8');
    }
  }

  return {
    ok: true,
    dryRun,
    changeId: id,
    operations: artifacts.map((artifact) => ({
      action: dryRun ? 'would-write' : 'write',
      target: artifact.target
    })),
    warnings: [],
    errors: []
  };
}

async function renderCompatibilityArtifacts(rootDir, changeId) {
  const proposal = await readOptional(path.join(rootDir, 'openspec', 'changes', changeId, 'proposal.md'));
  const tasks = await readOptional(path.join(rootDir, 'openspec', 'changes', changeId, 'tasks.md'));
  const design = await readOptional(path.join(rootDir, 'openspec', 'changes', changeId, 'design.md'));
  const specs = await listSpecFiles(path.join(rootDir, 'openspec', 'changes', changeId, 'specs'), rootDir);
  const generatedRules = await readOptional(path.join(rootDir, '.ai-factory', 'rules', 'generated', `openspec-merged-${changeId}.md`));

  return [
    {
      target: `.ai-factory/plans/${changeId}.md`,
      content: proposal || `# ${titleFromId(changeId)}\n\nCompatibility export from OpenSpec change '${changeId}'.\n`
    },
    {
      target: `.ai-factory/plans/${changeId}/task.md`,
      content: tasks || '# Tasks\n\n- [ ] Review OpenSpec tasks before legacy compatibility use.\n'
    },
    {
      target: `.ai-factory/plans/${changeId}/context.md`,
      content: renderCompatibilityContext({ changeId, proposal, design, specs })
    },
    {
      target: `.ai-factory/plans/${changeId}/rules.md`,
      content: generatedRules || [
        '# Compatibility Rules',
        '',
        `No generated OpenSpec rules were present for '${changeId}'.`,
        'Run `/aif-mode sync --change <id>` before relying on this compatibility export.',
        ''
      ].join('\n')
    }
  ];
}

function renderCompatibilityContext({ changeId, proposal, design, specs }) {
  return [
    `# Compatibility Context: ${titleFromId(changeId)}`,
    '',
    'This file is a compatibility export from canonical OpenSpec artifacts. OpenSpec remains the source of truth when present.',
    '',
    '## Proposal',
    '',
    proposal?.trim() || 'No proposal.md was present.',
    '',
    '## Design',
    '',
    design?.trim() || 'No design.md was present.',
    '',
    '## Delta Specs Summary',
    '',
    ...(specs.length > 0 ? specs.map((item) => `- ${item}`) : ['- none']),
    ''
  ].join('\n');
}

async function maybeMigrateLegacyPlans(options = {}) {
  const dryRun = Boolean(options.dryRun);
  const plans = options.legacyPlans ?? [];

  if (plans.length === 0) {
    return createSkippedResult('no legacy plans detected');
  }

  const commands = [
    'node scripts/migrate-legacy-plans.mjs --all --dry-run',
    'node scripts/migrate-legacy-plans.mjs --all'
  ];

  if (!options.yes) {
    return {
      ok: true,
      dryRun,
      skipped: true,
      commands,
      warnings: [
        {
          code: 'legacy-plans-detected',
          message: 'Legacy plans were detected. Run the migration dry-run before applying migration.'
        }
      ],
      errors: []
    };
  }

  const result = await migrateAllLegacyPlans({
    ...options,
    rootDir: resolveRootDir(options),
    dryRun
  });

  return {
    ok: result.ok,
    dryRun,
    skipped: false,
    commands,
    result,
    warnings: result.warnings ?? [],
    errors: result.errors ?? []
  };
}

async function maybeUpdateCurrentPointer(options = {}) {
  const rootDir = resolveRootDir(options);
  const changeIds = Array.from(options.changeIds ?? []);

  if (!options.current) {
    return createSkippedResult('current pointer update was not requested');
  }

  if (changeIds.length !== 1) {
    return {
      ok: false,
      skipped: false,
      warnings: [],
      errors: [
        {
          code: 'current-pointer-requires-one-change',
          message: 'Updating current pointer requires exactly one selected change.'
        }
      ]
    };
  }

  if (options.dryRun) {
    return {
      ok: true,
      dryRun: true,
      skipped: false,
      operations: [
        {
          action: 'would-write',
          target: '.ai-factory/state/current.yaml'
        }
      ],
      warnings: [],
      errors: []
    };
  }

  const result = await writeCurrentChangePointer(changeIds[0], { rootDir });
  return {
    ok: true,
    skipped: false,
    operations: [
      {
        action: 'write',
        target: toPosix(path.relative(rootDir, result.pointerPath))
      }
    ],
    warnings: [],
    errors: []
  };
}

async function inspectActiveChange(options = {}) {
  const result = await resolveActiveChange({
    rootDir: resolveRootDir(options),
    cwd: options.cwd ?? process.cwd(),
    changeId: options.changeId,
    getCurrentBranch: options.getCurrentBranch
  });

  if (result.ok) {
    return {
      state: 'resolved',
      changeId: result.changeId,
      source: result.source,
      candidates: result.candidates,
      warnings: result.warnings,
      errors: []
    };
  }

  const ambiguous = result.errors.some((error) => error.code?.includes('ambiguous'));
  return {
    state: ambiguous ? 'ambiguous' : 'none',
    changeId: null,
    source: result.source,
    candidates: result.candidates,
    warnings: result.warnings,
    errors: result.errors
  };
}

async function inspectConfiguredPaths(options = {}) {
  const rootDir = resolveRootDir(options);
  const config = await readProjectConfig(rootDir);
  const mode = options.mode ?? resolveMode(config);
  const paths = mode === MODES.openspec
    ? [
      config.paths.plans ?? DEFAULT_OPEN_SPEC_PATHS.plans,
      config.paths.specs ?? DEFAULT_OPEN_SPEC_PATHS.specs,
      config.paths.state ?? DEFAULT_OPEN_SPEC_PATHS.state,
      config.paths.qa ?? DEFAULT_OPEN_SPEC_PATHS.qa,
      config.paths.generated_rules ?? DEFAULT_OPEN_SPEC_PATHS.generated_rules
    ]
    : [
      config.paths.plans ?? DEFAULT_AI_FACTORY_PATHS.plans,
      config.paths.specs ?? DEFAULT_AI_FACTORY_PATHS.specs,
      config.paths.rules ?? DEFAULT_AI_FACTORY_PATHS.rules
    ];

  const diagnostics = [];
  for (const relativePath of paths) {
    if (await isDirectory(path.join(rootDir, relativePath))) {
      diagnostics.push(pass('configured-path-exists', `Configured path exists: ${relativePath}.`));
    } else {
      diagnostics.push(fail('configured-path-missing', `Configured path is missing: ${relativePath}.`));
    }
  }

  if (mode === MODES.openspec && await pathExists(path.join(rootDir, OPEN_SPEC_CONFIG))) {
    diagnostics.push(pass('openspec-config-exists', 'openspec/config.yaml exists.'));
  } else if (mode === MODES.openspec) {
    diagnostics.push(fail('openspec-config-missing', 'openspec/config.yaml is missing.'));
  }

  return diagnostics;
}

async function inspectVerifyGateDiagnostic(rootDir, status) {
  const qaRoot = status.config.paths.qa ?? DEFAULT_OPEN_SPEC_PATHS.qa;
  const changeId = status.activeChange.changeId;
  const verifyPath = path.join(rootDir, qaRoot, changeId, 'verify.md');
  const content = await readOptional(verifyPath);

  if (!content) {
    return warn('verify-gate-missing', `Verify gate result is missing for active change ${changeId}.`);
  }

  const gate = getLatestGateResult(content, { gate: 'verify' });

  if (gate === null) {
    return warn('verify-gate-missing', `Verify gate result is missing for active change ${changeId}.`);
  }

  if (!gate.ok) {
    return fail('verify-gate-invalid', `Verify gate result is invalid for active change ${changeId}.`);
  }

  if (gate.result.status === 'fail') {
    return fail('verify-gate-failed', `Verify gate result failed for active change ${changeId}.`);
  }

  if (gate.result.status === 'warn') {
    return warn('verify-gate-warn', `Verify gate result has warnings for active change ${changeId}.`);
  }

  return pass('verify-gate-passed', `Verify gate result passed for active change ${changeId}.`);
}

async function writeModeReport(kind, options = {}) {
  const dryRun = Boolean(options.dryRun);
  const rootDir = resolveRootDir(options);
  const timestamp = options.timestamp ?? new Date().toISOString().replace(/[:.]/g, '-');
  const reportPath = toPosix(path.join(MODE_SWITCH_DIR, `${timestamp}-${kind}.md`));
  const content = renderModeReport({
    title: options.title,
    mode: options.mode,
    dryRun,
    sections: options.sections ?? []
  });

  if (!dryRun) {
    const target = path.join(rootDir, reportPath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, 'utf8');
  }

  return {
    ok: true,
    dryRun,
    path: reportPath,
    operations: [
      {
        action: dryRun ? 'would-write' : 'write',
        target: reportPath
      }
    ],
    warnings: [],
    errors: []
  };
}

export function renderModeReport({ title, mode, dryRun, sections }) {
  return [
    `# ${title}`,
    '',
    `Mode: ${mode}`,
    `Dry run: ${dryRun ? 'yes' : 'no'}`,
    '',
    ...sections.flatMap((section) => String(section ?? '').trimEnd().split('\n')),
    ''
  ].join('\n');
}

async function ensureDirectories(rootDir, relativePaths, options = {}) {
  const dryRun = Boolean(options.dryRun);
  const created = [];
  const preserved = [];
  const operations = [];
  const errors = [];

  for (const relativePath of relativePaths) {
    const target = path.join(rootDir, relativePath);

    if (await pathExists(target)) {
      if (!await isDirectory(target)) {
        errors.push({
          code: 'path-not-directory',
          message: `Expected directory path is not a directory: ${relativePath}.`
        });
        continue;
      }

      preserved.push(relativePath);
      operations.push({ action: 'preserve', target: relativePath });
      continue;
    }

    created.push(relativePath);
    operations.push({ action: dryRun ? 'would-create' : 'create', target: relativePath });

    if (!dryRun) {
      await mkdir(target, { recursive: true });
    }
  }

  return {
    ok: errors.length === 0,
    dryRun,
    created,
    preserved,
    operations,
    warnings: [],
    errors
  };
}

async function ensureOpenSpecConfig(rootDir, options = {}) {
  const dryRun = Boolean(options.dryRun);
  const target = path.join(rootDir, OPEN_SPEC_CONFIG);
  const projectName = path.basename(rootDir);

  if (await pathExists(target)) {
    return {
      ok: true,
      dryRun,
      created: [],
      preserved: [OPEN_SPEC_CONFIG],
      operations: [{ action: 'preserve', target: OPEN_SPEC_CONFIG }],
      warnings: [],
      errors: []
    };
  }

  if (!dryRun) {
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, `project: ${projectName}\ntitle: ${titleFromId(projectName)}\n`, 'utf8');
  }

  return {
    ok: true,
    dryRun,
    created: [OPEN_SPEC_CONFIG],
    preserved: [],
    operations: [{ action: dryRun ? 'would-create' : 'create', target: OPEN_SPEC_CONFIG }],
    warnings: [],
    errors: []
  };
}

function resolveMode(config) {
  if (config.marker === MODES.openspec) {
    return MODES.openspec;
  }

  if (config.marker === MODES.aiFactory) {
    return MODES.aiFactory;
  }

  return MODES.unknown;
}

function parseSimpleYaml(raw) {
  const root = {};
  const stack = [{ indent: -1, value: root }];

  for (const rawLine of String(raw ?? '').split(/\r?\n/)) {
    if (!rawLine.trim() || rawLine.trimStart().startsWith('#')) {
      continue;
    }

    const match = rawLine.match(/^(\s*)([A-Za-z0-9_-]+):(?:\s*(.*?))?\s*$/);
    if (!match) {
      continue;
    }

    const indent = match[1].length;
    const key = match[2];
    const rawValue = match[3] ?? '';

    while (stack.length > 1 && indent <= stack.at(-1).indent) {
      stack.pop();
    }

    const parent = stack.at(-1).value;

    if (rawValue.length === 0) {
      parent[key] = {};
      stack.push({ indent, value: parent[key] });
    } else {
      parent[key] = parseScalar(rawValue);
    }
  }

  return root;
}

function parseScalar(value) {
  const trimmed = String(value).replace(/\s+#.*$/, '').trim();

  if (trimmed === 'true') {
    return true;
  }

  if (trimmed === 'false') {
    return false;
  }

  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) {
    return Number(trimmed);
  }

  return trimmed.replace(/^["']|["']$/g, '');
}

function parseTopLevelBlocks(raw) {
  const lines = String(raw ?? '').replace(/\r\n/g, '\n').split('\n');
  const starts = [];

  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^([A-Za-z0-9_-]+):/);
    if (match) {
      starts.push({ key: match[1], index });
    }
  }

  return starts.map((start, index) => {
    const end = starts[index + 1]?.index ?? lines.length;
    return {
      key: start.key,
      text: lines.slice(start.index, end).join('\n').trimEnd()
    };
  });
}

function renderScalarOrDefault(blocks, key, fallback) {
  return blocks.find((block) => block.key === key)?.text.trimEnd() || fallback;
}

function renderBlockOrDefault(blocks, key, fallback) {
  return blocks.find((block) => block.key === key)?.text.trimEnd() || fallback;
}

function renderAifhubBlock(mode) {
  if (mode === MODES.openspec) {
    return [
      'aifhub:',
      '  artifactProtocol: openspec',
      '  openspec:',
      '    root: openspec',
      '    installSkills: false',
      '    validateOnPlan: true',
      '    validateOnImprove: true',
      '    validateOnVerify: true',
      '    statusOnVerify: true',
      '    archiveOnDone: true',
      '    useInstructionsApply: true',
      '    compileRulesOnSync: true',
      '    validateOnSync: true',
      '    requireCliForVerify: false',
      '    requireCliForDone: true'
    ].join('\n');
  }

  return [
    'aifhub:',
    '  artifactProtocol: ai-factory'
  ].join('\n');
}

function renderPathsBlock(mode, existingPaths) {
  const paths = {
    ...DEFAULT_CONTEXT_PATHS,
    ...existingPaths
  };
  const modePaths = mode === MODES.openspec ? DEFAULT_OPEN_SPEC_PATHS : DEFAULT_AI_FACTORY_PATHS;
  const merged = {
    ...paths,
    ...modePaths
  };
  const keys = mode === MODES.openspec
    ? ['description', 'architecture', 'roadmap', 'research', 'plans', 'specs', 'rules', 'state', 'qa', 'generated_rules']
    : ['description', 'architecture', 'roadmap', 'research', 'plans', 'specs', 'rules'];
  const extraKeys = Object.keys(merged)
    .filter((key) => !keys.includes(key))
    .sort((left, right) => left.localeCompare(right));

  return [
    'paths:',
    ...[...keys, ...extraKeys].map((key) => `  ${key}: ${merged[key]}`)
  ].join('\n');
}

function selectRuleInspectionChanges(changes) {
  return changes.map((change) => change.id).slice(0, 50);
}

async function detectOpenSpecCapability(rootDir, options = {}) {
  const detectOpenSpec = options.detectOpenSpec ?? defaultDetectOpenSpec;
  try {
    return await detectOpenSpec(createRunOptions(rootDir, options));
  } catch (err) {
    return {
      available: false,
      canValidate: false,
      canArchive: false,
      reason: 'openspec-detection-failed',
      errors: [
        {
          code: 'openspec-detection-failed',
          message: err?.message ?? 'OpenSpec detection failed.'
        }
      ]
    };
  }
}

function summarizeOpenSpecDetection(detection) {
  const available = Boolean(detection?.available);
  const canValidate = Boolean(detection?.canValidate);
  const canArchive = Boolean(detection?.canArchive);
  return {
    known: detection !== null && detection !== undefined,
    state: available && (canValidate || canArchive) ? 'available' : 'degraded',
    available,
    canValidate,
    canArchive,
    version: detection?.version ?? null,
    nodeVersion: detection?.nodeVersion ?? null,
    nodeSupported: detection?.nodeSupported ?? null,
    versionSupported: detection?.versionSupported ?? null,
    reason: detection?.reason ?? null,
    errors: detection?.errors ?? []
  };
}

function normalizeDetectionWarnings(detection) {
  const errors = detection?.errors ?? [];
  if (errors.length > 0) {
    return errors.map((error) => ({
      code: error.code ?? detection.reason ?? 'openspec-cli-unavailable',
      message: error.message ?? 'OpenSpec CLI unavailable.'
    }));
  }

  return [
    {
      code: detection?.reason ?? 'openspec-cli-unavailable',
      message: 'OpenSpec CLI is unavailable or unsupported; validation was skipped.'
    }
  ];
}

function createRunOptions(rootDir, options = {}) {
  return {
    cwd: rootDir,
    command: options.command,
    env: options.env,
    executor: options.executor,
    nodeVersion: options.nodeVersion
  };
}

async function listSpecFiles(specRoot, rootDir) {
  if (!await isDirectory(specRoot)) {
    return [];
  }

  const files = [];
  await walk(specRoot, async (filePath, entry) => {
    if (entry.isFile() && entry.name === 'spec.md') {
      files.push(toPosix(path.relative(rootDir, filePath)));
    }
  });
  return files.sort((left, right) => left.localeCompare(right));
}

async function walk(dirPath, visitor) {
  const entries = await readdir(dirPath, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const childPath = path.join(dirPath, entry.name);
    await visitor(childPath, entry);
    if (entry.isDirectory()) {
      await walk(childPath, visitor);
    }
  }
}

function assertSafeCompatibilityTarget(rootDir, changeId, relativePath) {
  const target = path.resolve(rootDir, relativePath);
  const planFile = path.resolve(rootDir, '.ai-factory', 'plans', `${changeId}.md`);
  const planDir = path.resolve(rootDir, '.ai-factory', 'plans', changeId);

  if (target === planFile || isWithinDirectory(target, planDir)) {
    return;
  }

  throw new Error(`Compatibility export target escapes legacy plan paths: ${relativePath}`);
}

function renderConfigSection(config) {
  return [
    '## Config',
    '',
    ...renderOperations(config.operations)
  ].join('\n');
}

function renderSkeletonSection(skeleton) {
  return [
    '## Skeleton',
    '',
    ...renderOperations(skeleton.operations)
  ].join('\n');
}

function renderLegacyMigrationSection(legacy, migration) {
  const plans = legacy.ok ? legacy.plans : [];
  return [
    '## Legacy Migration',
    '',
    `Legacy plans: ${plans.length}`,
    ...(migration.commands ? ['Suggested commands:', ...migration.commands.map((command) => `- \`${command}\``)] : []),
    ...renderDiagnostics('Warnings', migration.warnings),
    ...renderDiagnostics('Errors', migration.errors)
  ].join('\n');
}

function renderSyncSection(sync) {
  return [
    '## Sync',
    '',
    `Generated rules files: ${sync.generatedRules?.files?.length ?? 0}`,
    `Validation skipped: ${sync.validation?.skipped ? 'yes' : 'no'}`,
    ...renderDiagnostics('Warnings', sync.warnings ?? []),
    ...renderDiagnostics('Errors', sync.errors ?? [])
  ].join('\n');
}

function renderExportSection(exportResult) {
  return [
    '## Compatibility Export',
    '',
    `Skipped: ${exportResult.skipped ? 'yes' : 'no'}`,
    `Exported: ${(exportResult.exported ?? []).join(', ') || 'none'}`,
    ...renderOperations(exportResult.operations ?? []),
    ...renderDiagnostics('Warnings', exportResult.warnings ?? []),
    ...renderDiagnostics('Errors', exportResult.errors ?? [])
  ].join('\n');
}

function renderChangeSelectionSection(changes) {
  return [
    '## Change Selection',
    '',
    `Source: ${changes.source}`,
    `Changes: ${changes.changeIds.join(', ') || 'none'}`
  ].join('\n');
}

function renderGeneratedRulesSection(generatedRules) {
  return [
    '## Generated Rules',
    '',
    `Files: ${generatedRules.files.length}`,
    ...renderDiagnostics('Warnings', generatedRules.warnings),
    ...renderDiagnostics('Errors', generatedRules.errors)
  ].join('\n');
}

function renderValidationSection(validation) {
  return [
    '## OpenSpec Validation',
    '',
    `Skipped: ${validation.skipped ? 'yes' : 'no'}`,
    `Results: ${validation.results.length}`,
    ...renderDiagnostics('Warnings', validation.warnings),
    ...renderDiagnostics('Errors', validation.errors)
  ].join('\n');
}

function renderLegacyDetectionSection(legacy) {
  const plans = legacy.ok ? legacy.plans : [];
  return [
    '## Legacy Plans',
    '',
    `Detected: ${plans.length}`,
    ...plans.map((plan) => `- ${plan.id}`),
    ...renderDiagnostics('Warnings', legacy.warnings ?? []),
    ...renderDiagnostics('Errors', legacy.errors ?? [])
  ].join('\n');
}

function renderPointerSection(pointer) {
  return [
    '## Current Pointer',
    '',
    `Skipped: ${pointer.skipped ? 'yes' : 'no'}`,
    ...renderOperations(pointer.operations ?? []),
    ...renderDiagnostics('Warnings', pointer.warnings ?? []),
    ...renderDiagnostics('Errors', pointer.errors ?? [])
  ].join('\n');
}

function renderOperations(operations) {
  const items = Array.isArray(operations) ? operations : [];
  return items.length === 0
    ? ['- none']
    : items.map((operation) => `- ${operation.action}: ${operation.target}`);
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

function pass(code, message) {
  return { level: 'pass', code, message };
}

function warn(code, message) {
  return { level: 'warn', code, message };
}

function fail(code, message) {
  return { level: 'fail', code, message };
}

function createSkippedResult(reason) {
  return {
    ok: true,
    skipped: true,
    reason,
    operations: [],
    warnings: [],
    errors: []
  };
}

function createSkippedGeneratedRulesSync(dryRun, reason) {
  return {
    ok: true,
    dryRun,
    skipped: true,
    reason,
    results: [],
    files: [],
    warnings: [
      {
        code: reason,
        message: 'Generated rules compilation skipped because aifhub.openspec.compileRulesOnSync is false.'
      }
    ],
    errors: []
  };
}

function createSkippedValidationSync(reason) {
  return {
    ok: true,
    skipped: true,
    reason,
    detection: null,
    results: [],
    warnings: [
      {
        code: reason,
        message: 'OpenSpec validation skipped because aifhub.openspec.validateOnSync is false.'
      }
    ],
    errors: []
  };
}

function titleFromId(id) {
  return String(id)
    .replace(/[-_]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`)
    .join(' ');
}

function resolveRootDir(options = {}) {
  return path.resolve(options.rootDir ?? process.cwd());
}

async function readOptional(filePath) {
  try {
    return await readFile(filePath, 'utf8');
  } catch {
    return '';
  }
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

function isWithinDirectory(targetPath, directoryPath) {
  const relative = path.relative(path.resolve(directoryPath), path.resolve(targetPath));
  return relative.length === 0 || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function toPosix(value) {
  return String(value).replaceAll('\\', '/');
}

function dedupeDiagnostics(diagnostics) {
  const seen = new Set();
  const result = [];

  for (const diagnostic of diagnostics) {
    const key = `${diagnostic.code ?? ''}:${diagnostic.message ?? ''}:${diagnostic.target ?? ''}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(diagnostic);
    }
  }

  return result;
}
