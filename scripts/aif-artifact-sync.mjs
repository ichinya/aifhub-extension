// aif-artifact-sync.mjs - mode-aware AIFHub artifact synchronization helpers
import { access, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  normalizeChangeId,
  resolveActiveChange,
  writeCurrentChangePointer
} from './active-change-resolver.mjs';
import {
  compileOpenSpecBaseRules,
  compileOpenSpecRules
} from './openspec-rules-compiler.mjs';
import {
  detectOpenSpec as defaultDetectOpenSpec,
  getOpenSpecStatus as defaultGetOpenSpecStatus,
  validateOpenSpecChange as defaultValidateOpenSpecChange
} from './openspec-runner.mjs';
import {
  collectGeneratedRules as collectGeneratedRuleContext
} from './openspec-execution-context.mjs';
import {
  discoverLegacyPlans,
  migrateAllLegacyPlans,
  resolveLegacyPlanSourceRoot,
  writeLegacyPlanSourceState
} from './legacy-plan-migration.mjs';
import {
  getLatestGateResult
} from './aif-gate-result.mjs';
import {
  validateOpenSpecArtifactContract as defaultValidateOpenSpecArtifactContract
} from './openspec-artifact-validator.mjs';
import {
  readOpenSpecCoverageMatrix,
  summarizeOpenSpecCoverage
} from './openspec-coverage-matrix.mjs';
import {
  readOpenSpecSkipSpecsMarker
} from './openspec-change-metadata.mjs';
import {
  readOpenSpecRulesGateEvidence,
  resolveOpenSpecPolicy,
  summarizeOpenSpecPolicy
} from './openspec-policy.mjs';

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
  requireCliForPlan: false,
  requireCliForImprove: false,
  requireCliForVerify: false,
  requireCliForDone: true,
  requireGeneratedRulesForVerify: false,
  requireGeneratedRulesForDone: true,
  requireRulesPassForVerify: false,
  requireRulesPassForDone: true,
  requireSpecCoverageForVerify: false,
  requireSpecCoverageForDone: true,
  allowWarnOnDone: {
    rules: false,
    coverage: false,
    openspecStatus: true
  }
};
const DEFAULT_AI_FACTORY_PATHS = {
  plans: '.ai-factory/plans',
  specs: '.ai-factory/specs',
  rules: '.ai-factory/rules'
};
const OPEN_SPEC_ONLY_PATH_KEYS = new Set(
  Object.keys(DEFAULT_OPEN_SPEC_PATHS)
    .filter((key) => !Object.hasOwn(DEFAULT_AI_FACTORY_PATHS, key))
);
const DEFAULT_CONTEXT_PATHS = {
  description: '.ai-factory/DESCRIPTION.md',
  architecture: '.ai-factory/ARCHITECTURE.md',
  context: 'CONTEXT.md',
  roadmap: '.ai-factory/ROADMAP.md',
  research: '.ai-factory/RESEARCH.md'
};
const MODE_SWITCH_DIR = path.join('.ai-factory', 'state', 'mode-switches');
const OPEN_SPEC_CONFIG = path.join('openspec', 'config.yaml');

export async function getModeStatus(options = {}) {
  const rootDir = resolveRootDir(options);
  const config = await readProjectConfig(rootDir);
  const effectivePolicy = resolveOpenSpecPolicy(config);
  const mode = resolveMode(config);
  const detection = await detectOpenSpecCapability(rootDir, options);
  const openSpecChanges = await listOpenSpecChanges({ rootDir });
  const legacy = await discoverLegacyPlansForMode(config, mode, { ...options, rootDir });
  const activeChange = await inspectActiveChange({
    ...options,
    rootDir,
    changeId: options.changeId
  });
  const generatedRuleChangeIds = options.changeId !== undefined && activeChange.state === 'resolved'
    ? [activeChange.changeId]
    : selectRuleInspectionChanges(openSpecChanges);
  const generatedRules = await inspectGeneratedRules({
    ...options,
    rootDir,
    changeIds: generatedRuleChangeIds
  });

  return {
    ok: true,
    mode,
    config,
    effectivePolicy,
    configMarker: config.marker,
    configPath: DEFAULT_CONFIG_PATH,
    configExists: config.exists,
    openspecCli: summarizeOpenSpecDetection(detection),
    openSpecChanges,
    legacyPlanSourceRoot: legacy.legacyPlanSourceRoot ?? null,
    legacyPlanSource: legacy.legacyPlanSource ?? null,
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
  const preSwitchConfig = await readProjectConfig(rootDir);
  const preSwitchMode = resolveMode(preSwitchConfig);
  const capturedSource = await resolveLegacyPlanSourceRoot({
    ...options,
    rootDir,
    legacyPlanSourceRoot: options.legacyPlanSourceRoot
      ?? (preSwitchMode === MODES.openspec ? undefined : preSwitchConfig.paths.plans),
    useRecordedLegacyPlanSource: preSwitchMode === MODES.openspec
  });
  const legacy = capturedSource.ok
    ? await discoverLegacyPlans({
        ...options,
        rootDir,
        legacyPlanSourceRoot: capturedSource.legacyPlanSourceRoot
      })
    : createLegacyDiscoveryFailure(capturedSource);

  if (!legacy.ok) {
    return createOpenSpecSwitchPreflightFailure({ dryRun, preSwitchConfig, legacy });
  }

  const config = await writeModeConfig(MODES.openspec, { ...options, rootDir });
  const skeleton = await ensureOpenSpecSkeleton({ ...options, rootDir });
  const migration = await maybeMigrateLegacyPlans({
    ...options,
    rootDir,
    legacyPlanSourceRoot: capturedSource.legacyPlanSourceRoot,
    legacyPlans: legacy.ok ? legacy.plans : []
  });
  const legacyPlanSourceState = await maybePersistLegacyPlanSource({
    ...options,
    rootDir,
    dryRun,
    legacyPlanSourceRoot: capturedSource.legacyPlanSourceRoot,
    legacyPlans: legacy.plans,
    migration
  });
  const sync = await syncOpenSpecArtifacts({
    ...options,
    rootDir,
    legacyPlanSourceRoot: capturedSource.legacyPlanSourceRoot,
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
    ok: config.ok && skeleton.ok && migration.ok && legacyPlanSourceState.ok && sync.ok,
    dryRun,
    mode: MODES.openspec,
    config,
    skeleton,
    legacy,
    legacyPlanSourceRoot: capturedSource.legacyPlanSourceRoot,
    legacyPlanSource: capturedSource,
    legacyPlanSourceState,
    migration,
    sync,
    report,
    warnings: dedupeDiagnostics([
      ...config.warnings,
      ...skeleton.warnings,
      ...(legacy.warnings ?? []),
      ...migration.warnings,
      ...legacyPlanSourceState.warnings,
      ...sync.warnings
    ]),
    errors: [
      ...config.errors,
      ...skeleton.errors,
      ...(legacy.errors ?? []),
      ...migration.errors,
      ...legacyPlanSourceState.errors,
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
      changeIds: changes.changeIds,
      resetIndexChanges: changes.source !== 'ambiguous-base-only'
    })
    : createSkippedGeneratedRulesSync(dryRun, 'compileRulesOnSync-disabled');
  const validation = openspecSettings.validateOnSync
    ? await validateOpenSpecChanges({
      ...options,
      rootDir,
      changeIds: changes.changeIds,
      skipNoDeltaChanges: Boolean(options.all)
    })
    : createSkippedValidationSync('validateOnSync-disabled');
  const legacy = await discoverLegacyPlans({
    ...options,
    rootDir,
    legacyPlanSourceRoot: options.legacyPlanSourceRoot
  });
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
  const effectivePolicy = status.effectivePolicy ?? resolveOpenSpecPolicy(status.config);
  const openspecSettings = effectivePolicy;
  const diagnostics = [];
  let artifactContract = null;
  let coverage = null;
  let rulesGate = null;

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

  diagnostics.push(pass('openspec-effective-policy', summarizeOpenSpecPolicy(effectivePolicy)));
  for (const diagnostic of effectivePolicy.diagnostics ?? []) {
    diagnostics.push(warn(diagnostic.code, diagnostic.message));
  }

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
  } else if (status.generatedRules.state === 'warn') {
    diagnostics.push(policyWarnOrFail(
      effectivePolicy.requirements.generatedRules.done,
      'generated-rules-warning',
      'Generated rules have trace warnings; blocking for /aif-done under current policy.'
    ));
  } else if (status.generatedRules.state === 'stale') {
    diagnostics.push(policyWarnOrFail(
      effectivePolicy.requirements.generatedRules.done,
      'generated-rules-stale',
      'Generated rules are stale; blocking for /aif-done under current policy.'
    ));
  } else {
    diagnostics.push(policyWarnOrFail(
      effectivePolicy.requirements.generatedRules.done,
      'generated-rules-missing',
      'Generated rules are missing; blocking for /aif-done under current policy.'
    ));
  }

  if (status.mode === MODES.openspec && status.legacyPlans.length > 0) {
    diagnostics.push(warn(
      'legacy-plans-present-in-openspec-mode',
      'Legacy .ai-factory/plans artifacts exist in OpenSpec-native mode; treat them as migration input only.'
    ));
  }

  if (status.mode === MODES.openspec && status.activeChange.state === 'resolved') {
    diagnostics.push(await inspectVerifyGateDiagnostic(rootDir, status));
    const validateOpenSpecArtifactContract = options.validateOpenSpecArtifactContract ?? defaultValidateOpenSpecArtifactContract;
    artifactContract = await validateOpenSpecArtifactContract({
      ...options,
      rootDir,
      changeId: status.activeChange.changeId,
      requireVerificationEvidence: true
    });
    diagnostics.push(renderArtifactContractDiagnostic(artifactContract));
    coverage = await readOpenSpecCoverageMatrix(status.activeChange.changeId, {
      ...options,
      rootDir
    });
    diagnostics.push(renderCoverageDiagnostic(coverage, effectivePolicy));
    rulesGate = await readOpenSpecRulesGateEvidence(status.activeChange.changeId, {
      ...options,
      rootDir,
      qaDir: status.config.paths.qa ?? DEFAULT_OPEN_SPEC_PATHS.qa
    });
    diagnostics.push(renderRulesGateDiagnostic(rulesGate, effectivePolicy));
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
    artifactContract,
    coverage,
    rulesGate,
    effectivePolicy,
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
  return resolveOpenSpecPolicy(config ?? { aifhub: { openspec: DEFAULT_OPENSPEC_SETTINGS } });
}

export async function readAnalyzeSkillVersion(options = {}) {
  const skillUrl = options.analyzeSkillUrl ?? new URL('../skills/aif-analyze/SKILL.md', import.meta.url);
  try {
    const raw = await readFile(fileURLToPath(skillUrl), 'utf8');
    const frontmatter = raw.split(/^---\s*$/m)[1] ?? '';
    const match = frontmatter.match(/^version:\s*(\S+)\s*$/m);
    if (!match) {
      return {
        ok: false,
        version: null,
        error: {
          code: 'analyze-skill-version-missing',
          message: 'skills/aif-analyze/SKILL.md frontmatter has no version key.'
        }
      };
    }
    return { ok: true, version: match[1], error: null };
  } catch (err) {
    return {
      ok: false,
      version: null,
      error: {
        code: 'analyze-skill-unreadable',
        message: `Could not read skills/aif-analyze/SKILL.md: ${err?.code ?? err?.message ?? 'unknown error'}`
      }
    };
  }
}

export async function writeModeConfig(mode, options = {}) {
  const rootDir = resolveRootDir(options);
  const dryRun = Boolean(options.dryRun);
  const config = await readProjectConfig(rootDir);
  const skill = await readAnalyzeSkillVersion(options.analyzeSkillUrl ? { analyzeSkillUrl: options.analyzeSkillUrl } : {});
  const content = renderConfigForMode(config.raw, mode, skill.ok ? { analyzeSkillVersion: skill.version } : {});
  const configKeys = summarizeConfigKeyOwnership(config.raw, content);
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
    configKeys,
    warnings: skill.ok ? [] : [skill.error],
    errors: []
  };
}

export function renderConfigForMode(existingRaw, mode, options = {}) {
  const parsed = parseSimpleYaml(existingRaw);
  const paths = parsed.paths ?? {};
  const blocks = parseTopLevelBlocks(existingRaw);
  const used = new Set(['config_version', 'language', 'aifhub', 'paths', 'utilities', 'analyze']);
  const rendered = [];

  rendered.push(renderScalarOrDefault(blocks, 'config_version', 'config_version: 1'));
  rendered.push(renderBlockOrDefault(blocks, 'language', [
    'language:',
    '  ui: en',
    '  artifacts: en',
    '  technical_terms: keep'
  ].join('\n')));
  rendered.push(renderAifhubBlock(mode, blocks));
  rendered.push(renderPathsBlock(mode, paths));
  rendered.push(renderUtilitiesBlock(blocks));

  const analyzeBlock = renderAnalyzeBlock(blocks, options.analyzeSkillVersion);
  if (analyzeBlock !== null) {
    rendered.push(analyzeBlock);
  }

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
  const expected = new Set(['index.json', 'openspec-base.md']);

  for (const changeId of changeIds) {
    expected.add(`openspec-change-${changeId}.md`);
    expected.add(`openspec-merged-${changeId}.md`);
    expected.add(`openspec-rules-trace-${changeId}.json`);
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

    const collected = await collectGeneratedRuleContext(normalized.changeId, {
      ...options,
      rootDir
    });
    warnings.push(...collected.warnings);

    if (!collected.ok) {
      errors.push(...collected.errors);
      continue;
    }

    for (const rule of collected.generatedRules ?? []) {
      const fileName = path.basename(rule.path);

      if (!rule.exists) {
        missing.push(fileName);
      } else if (rule.stale === true) {
        // Includes source-hash drift and generated markdown output hash drift.
        stale.push(fileName);
      }
    }
  }

  const warningOnly = warnings.some((warning) =>
    warning.code === 'missing-generated-rules-trace'
    || warning.code === 'invalid-generated-rules-trace'
  );
  const state = stale.length > 0 ? 'stale' : missing.length > 0 ? 'missing' : warningOnly ? 'warn' : 'ok';

  return {
    ok: errors.length === 0,
    state,
    expected: [...expected].sort((left, right) => left.localeCompare(right)),
    missing: [...new Set(missing)].sort((left, right) => left.localeCompare(right)),
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

  if (changeIds.length === 0) {
    const result = await compileOpenSpecBaseRules({
      ...options,
      rootDir,
      dryRun,
      resetIndexChanges: options.resetIndexChanges ?? true
    });

    return {
      ok: result.ok,
      dryRun,
      baseOnly: true,
      changeSpecificSkipped: true,
      openspecCli: result.openspecCli ?? null,
      results: [result],
      files: result.files ?? [],
      warnings: dedupeDiagnostics([
        ...(result.warnings ?? []),
        {
          code: 'no-active-change-specific-rules',
          message: 'No active OpenSpec changes were selected; refreshed base generated rules only.'
        }
      ]),
      errors: result.errors ?? []
    };
  }

  for (const changeId of changeIds) {
    results.push(await compileOpenSpecRules(changeId, { ...options, rootDir, dryRun }));
  }

  return {
    ok: results.every((result) => result.ok),
    dryRun,
    openspecCli: results.find((result) => result.openspecCli !== null)?.openspecCli ?? null,
    results,
    files: results.flatMap((result) => result.files ?? []),
    warnings: dedupeDiagnostics(results.flatMap((result) => result.warnings ?? [])),
    errors: results.flatMap((result) => result.errors ?? [])
  };
}

async function validateOpenSpecChanges(options = {}) {
  const rootDir = resolveRootDir(options);
  const changeIds = Array.from(options.changeIds ?? []);

  if (changeIds.length === 0) {
    return {
      ok: true,
      skipped: true,
      reason: 'no-selected-changes',
      detection: null,
      results: [],
      skippedChanges: [],
      warnings: [
        {
          code: 'no-selected-changes',
          message: 'OpenSpec validation skipped because no active changes were selected.'
        }
      ],
      errors: []
    };
  }

  const selected = options.skipNoDeltaChanges
    ? await selectValidatableChanges(rootDir, changeIds)
    : {
      changeIds,
      skippedChanges: [],
      warnings: []
    };

  if (selected.changeIds.length === 0) {
    return {
      ok: true,
      skipped: true,
      reason: 'no-validatable-changes',
      detection: null,
      results: [],
      skippedChanges: selected.skippedChanges,
      warnings: selected.warnings,
      errors: []
    };
  }

  const detection = await detectOpenSpecCapability(rootDir, options);

  if (!detection.canValidate) {
    return {
      ok: true,
      skipped: true,
      reason: detection.reason ?? 'openspec-cli-unavailable',
      detection: summarizeOpenSpecDetection(detection),
      results: [],
      skippedChanges: selected.skippedChanges,
      warnings: dedupeDiagnostics([
        ...selected.warnings,
        ...normalizeDetectionWarnings(detection)
      ]),
      errors: []
    };
  }

  const validateOpenSpecChange = options.validateOpenSpecChange ?? defaultValidateOpenSpecChange;
  const getOpenSpecStatus = options.getOpenSpecStatus ?? defaultGetOpenSpecStatus;
  const results = [];

  for (const changeId of selected.changeIds) {
    const validation = await validateOpenSpecChange(changeId, createRunOptions(rootDir, options));
    const status = validation.ok
      ? await getOpenSpecStatus(changeId, createRunOptions(rootDir, options))
      : null;
    const statusWarning = isUnsupportedOpenSpecStatusChangeId(status, changeId)
      ? {
        code: 'openspec-status-unsupported-change-id',
        message: `OpenSpec status skipped because the OpenSpec CLI rejects numeric-leading change id '${changeId}' while validation accepts it.`
      }
      : null;

    results.push({
      changeId,
      validation,
      status,
      statusWarning,
      ok: Boolean(validation.ok && (status === null || status.ok || statusWarning !== null))
    });
  }
  const statusWarnings = results
    .map((result) => result.statusWarning)
    .filter((warning) => warning !== null);

  return {
    ok: results.every((result) => result.ok),
    skipped: false,
    detection: summarizeOpenSpecDetection(detection),
    results,
    skippedChanges: selected.skippedChanges,
    warnings: dedupeDiagnostics([
      ...selected.warnings,
      ...statusWarnings
    ]),
    errors: results
      .filter((result) => !result.ok)
      .map((result) => ({
        code: 'openspec-validation-failed',
        message: `OpenSpec validation/status failed for '${result.changeId}'.`
      }))
  };
}

function isUnsupportedOpenSpecStatusChangeId(result, changeId) {
  const output = normalizeCommandText(result);
  return !result?.ok
    && /^[0-9]/.test(String(changeId ?? ''))
    && /Invalid change name/i.test(output)
    && /Change name must start with a letter/i.test(output);
}

function normalizeCommandText(result) {
  return [
    result?.stderr,
    result?.stdout,
    result?.error?.message
  ]
    .filter((value) => value !== undefined && value !== null)
    .map((value) => String(value))
    .join('\n');
}

async function selectValidatableChanges(rootDir, changeIds) {
  const validatable = [];
  const skippedChanges = [];

  for (const changeId of changeIds) {
    const changeDir = path.join(rootDir, 'openspec', 'changes', changeId);
    const specRoot = path.join(changeDir, 'specs');
    const specFiles = await listSpecFiles(specRoot, rootDir);

    if (specFiles.length === 0) {
      const skipSpecs = await readOpenSpecSkipSpecsMarker(changeDir);
      if (skipSpecs.declared || !skipSpecs.valid) {
        validatable.push(changeId);
        continue;
      }

      skippedChanges.push({
        changeId,
        reason: 'no-delta-specs'
      });
      continue;
    }

    validatable.push(changeId);
  }

  return {
    changeIds: validatable,
    skippedChanges,
    warnings: skippedChanges.map((item) => ({
      code: 'no-delta-specs',
      message: `OpenSpec validation skipped for '${item.changeId}' because the change has no delta spec files.`
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

  if (resolved.errors.some((error) => error.code === 'ambiguous-active-change')) {
    return {
      ok: true,
      source: 'ambiguous-base-only',
      changeIds: [],
      warnings: [
        ...resolved.warnings,
        {
          code: 'ambiguous-active-change-base-only',
          message: 'Multiple active OpenSpec changes are available; continuing with bounded base-only sync. Use --change <id> or --all to refresh change-specific rules.'
        }
      ],
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

async function discoverLegacyPlansForMode(config, mode, options = {}) {
  const explicitRoot = options.legacyPlanSourceRoot
    ?? (mode === MODES.aiFactory ? config.paths.plans ?? DEFAULT_AI_FACTORY_PATHS.plans : undefined);

  return discoverLegacyPlans({
    ...options,
    rootDir: resolveRootDir(options),
    legacyPlanSourceRoot: explicitRoot,
    useRecordedLegacyPlanSource: mode === MODES.openspec
  });
}

function createLegacyDiscoveryFailure(source) {
  return {
    ok: false,
    legacyPlanSourceRoot: null,
    legacyPlanSource: source,
    plans: [],
    ignored: [],
    warnings: source.warnings ?? [],
    errors: source.errors ?? []
  };
}

function createOpenSpecSwitchPreflightFailure({ dryRun, preSwitchConfig, legacy }) {
  const skipped = createSkippedResult('legacy plan source preflight failed');
  return {
    ok: false,
    dryRun,
    mode: MODES.openspec,
    config: skipped,
    skeleton: skipped,
    legacy,
    legacyPlanSourceRoot: null,
    legacyPlanSource: legacy.legacyPlanSource,
    legacyPlanSourceState: skipped,
    migration: skipped,
    sync: skipped,
    report: skipped,
    previousConfig: {
      exists: preSwitchConfig.exists,
      marker: preSwitchConfig.marker
    },
    warnings: legacy.warnings ?? [],
    errors: legacy.errors ?? []
  };
}

async function maybePersistLegacyPlanSource(options = {}) {
  const plans = options.legacyPlans ?? [];
  if (plans.length === 0) {
    return createSkippedResult('no unresolved legacy plan source');
  }

  if (options.dryRun) {
    return writeLegacyPlanSourceState(options.legacyPlanSourceRoot, {
      ...options,
      dryRun: true,
      reason: 'mode-switch-dry-run'
    });
  }

  const migrationResult = options.migration?.result;
  const migrationIncomplete = Boolean(
    options.migration?.skipped
    || !options.migration?.ok
    || migrationResult?.preflightFailed
    || (migrationResult?.failed?.length ?? 0) > 0
    || (migrationResult?.skipped?.length ?? 0) > 0
  );
  if (!migrationIncomplete) {
    return createSkippedResult('legacy migration completed');
  }

  const reason = options.migration?.skipped
    ? 'migration-declined'
    : 'migration-incomplete';
  return writeLegacyPlanSourceState(options.legacyPlanSourceRoot, {
    ...options,
    dryRun: false,
    reason
  });
}

async function maybeMigrateLegacyPlans(options = {}) {
  const dryRun = Boolean(options.dryRun);
  const plans = options.legacyPlans ?? [];

  if (plans.length === 0) {
    return createSkippedResult('no legacy plans detected');
  }

  const sourceFlag = options.legacyPlanSourceRoot
    && options.legacyPlanSourceRoot !== DEFAULT_AI_FACTORY_PATHS.plans
    ? ` --legacy-source ${options.legacyPlanSourceRoot}`
    : '';
  const commands = [
    `ai-factory aifhub-migrate-legacy-plans --all${sourceFlag} --dry-run`,
    `ai-factory aifhub-migrate-legacy-plans --all${sourceFlag}`
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
    legacyPlanSourceRoot: options.legacyPlanSourceRoot,
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

export function parseSimpleYaml(raw) {
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

export function parseTopLevelBlocks(raw) {
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

function parseIndentedBlocks(raw, indent) {
  const lines = String(raw ?? '').replace(/\r\n/g, '\n').split('\n');
  const starts = [];
  const prefix = ' '.repeat(indent);
  const pattern = new RegExp(`^${prefix}([A-Za-z0-9_-]+):`);

  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(pattern);
    if (match) starts.push({ key: match[1], index });
  }

  return starts.map((start, index) => {
    const end = starts[index + 1]?.index ?? lines.length;
    return {
      key: start.key,
      text: lines.slice(start.index, end).join('\n').trimEnd()
    };
  });
}

function summarizeConfigKeyOwnership(beforeRaw, afterRaw) {
  const before = flattenConfigKeyPaths(parseSimpleYaml(beforeRaw));
  const after = flattenConfigKeyPaths(parseSimpleYaml(afterRaw));
  const changed = new Set();
  const preserved = [];

  for (const [keyPath, value] of after) {
    if (!before.has(keyPath) || before.get(keyPath) !== value) changed.add(keyPath);
    else preserved.push(keyPath);
  }
  for (const keyPath of before.keys()) {
    if (!after.has(keyPath)) changed.add(keyPath);
  }

  const changedKeyPaths = [...changed].sort((left, right) => left.localeCompare(right));
  const preservedKeyPaths = preserved.sort((left, right) => left.localeCompare(right));
  const limit = 200;
  return {
    changedKeyCount: changedKeyPaths.length,
    preservedKeyCount: preservedKeyPaths.length,
    changedKeyPaths: changedKeyPaths.slice(0, limit),
    preservedKeyPaths: preservedKeyPaths.slice(0, limit),
    truncated: changedKeyPaths.length > limit || preservedKeyPaths.length > limit
  };
}

export function flattenConfigKeyPaths(value, prefix = '', output = new Map()) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    if (prefix !== '') output.set(prefix, JSON.stringify(value));
    return output;
  }

  const entries = Object.entries(value);
  if (entries.length === 0 && prefix !== '') output.set(prefix, '{}');
  for (const [key, child] of entries) {
    const keyPath = prefix === '' ? key : `${prefix}.${key}`;
    flattenConfigKeyPaths(child, keyPath, output);
  }
  return output;
}

function renderScalarOrDefault(blocks, key, fallback) {
  return blocks.find((block) => block.key === key)?.text.trimEnd() || fallback;
}

function renderAnalyzeBlock(blocks, skillVersion) {
  const existing = blocks.find((block) => block.key === 'analyze')?.text.trimEnd();
  if (existing) {
    if (/^\s*skill_version:/m.test(existing) || skillVersion === undefined) {
      return existing;
    }
    return `${existing}\n  skill_version: ${skillVersion}`;
  }
  if (skillVersion === undefined) {
    return null;
  }
  return `analyze:\n  skill_version: ${skillVersion}`;
}

function renderBlockOrDefault(blocks, key, fallback) {
  return blocks.find((block) => block.key === key)?.text.trimEnd() || fallback;
}

function renderUtilitiesBlock(blocks) {
  const fallback = [
    'utilities:',
    '  context_tools:',
    '    enabled: []',
    '  graphify:',
    '    enabled: false',
    '    uv_check: uv --version',
    '    install: uv tool install graphifyy',
    '    activate: graphify install',
    '    report_command: graphify .',
    '  codegraph:',
    '    enabled: false',
    '    command: codegraph',
    '    status: codegraph status',
    '    init: codegraph init .',
    '    index: codegraph index --quiet .',
    '    query: codegraph query --path . --limit 10 --json',
    '    purge: codegraph uninit --force .'
  ].join('\n');
  const existing = blocks.find((block) => block.key === 'utilities')?.text.trimEnd();

  if (!existing) {
    return fallback;
  }

  if (hasTopLevelScalarValue(existing, 'utilities')) {
    return existing;
  }

  const additions = [];
  if (!/^  context_tools:(?:\s|$)/m.test(existing)) {
    additions.push(
      '  context_tools:',
      '    enabled: []'
    );
  }
  if (!/^  graphify:(?:\s|$)/m.test(existing)) {
    additions.push(
      '  graphify:',
      '    enabled: false',
      '    uv_check: uv --version',
      '    install: uv tool install graphifyy',
      '    activate: graphify install',
      '    report_command: graphify .'
    );
  }
  if (!/^  codegraph:(?:\s|$)/m.test(existing)) {
    additions.push(
      '  codegraph:',
      '    enabled: false',
      '    command: codegraph',
      '    status: codegraph status',
      '    init: codegraph init .',
      '    index: codegraph index --quiet .',
      '    query: codegraph query --path . --limit 10 --json',
      '    purge: codegraph uninit --force .'
    );
  }

  if (additions.length === 0) {
    return existing;
  }

  return [
    existing,
    ...additions
  ].join('\n');
}

function hasTopLevelScalarValue(blockText, key) {
  const firstLine = String(blockText ?? '').split('\n')[0] ?? '';
  const match = firstLine.match(new RegExp(`^${key}:\\s*(.*?)\\s*$`));

  if (!match) {
    return false;
  }

  const value = match[1].replace(/(?:^|\s)#.*$/, '').trim();
  return value.length > 0;
}

function renderAifhubBlock(mode, blocks) {
  const existing = blocks.find((block) => block.key === 'aifhub')?.text.trimEnd() ?? '';
  const children = parseIndentedBlocks(existing, 2);
  const rendered = [
    'aifhub:',
    `  artifactProtocol: ${mode}`
  ];
  const existingOpenSpec = children.find((block) => block.key === 'openspec')?.text ?? '';

  if (mode === MODES.openspec) {
    rendered.push(renderOpenSpecProfileBlock(existingOpenSpec));
  } else if (existingOpenSpec !== '') {
    const dormantOpenSpec = renderDormantOpenSpecProfileBlock(existingOpenSpec);
    if (dormantOpenSpec !== '') rendered.push(dormantOpenSpec);
  }

  for (const child of children) {
    if (child.key === 'artifactProtocol' || child.key === 'openspec') continue;
    rendered.push(child.text.trimEnd());
  }

  return rendered.join('\n');
}

function renderOpenSpecProfileBlock(existing) {
  const children = parseIndentedBlocks(existing, 4);
  const knownKeys = new Set(Object.keys(DEFAULT_OPENSPEC_SETTINGS));
  const rendered = ['  openspec:'];

  for (const [key, value] of Object.entries(DEFAULT_OPENSPEC_SETTINGS)) {
    if (key === 'allowWarnOnDone') continue;
    rendered.push(`    ${key}: ${renderYamlScalar(value)}`);
  }

  const existingAllowWarn = children.find((block) => block.key === 'allowWarnOnDone')?.text ?? '';
  rendered.push(renderAllowWarnOnDoneBlock(existingAllowWarn));

  for (const child of children) {
    if (knownKeys.has(child.key)) continue;
    rendered.push(child.text.trimEnd());
  }

  return rendered.join('\n');
}

function renderDormantOpenSpecProfileBlock(existing) {
  const children = parseIndentedBlocks(existing, 4);
  const knownKeys = new Set(Object.keys(DEFAULT_OPENSPEC_SETTINGS));
  const rendered = [];

  for (const child of children) {
    if (child.key === 'allowWarnOnDone') {
      const dormantAllowWarn = renderDormantAllowWarnOnDoneBlock(child.text);
      if (dormantAllowWarn !== '') rendered.push(dormantAllowWarn);
      continue;
    }
    if (knownKeys.has(child.key)) continue;
    rendered.push(child.text.trimEnd());
  }

  return rendered.length === 0 ? '' : ['  openspec:', ...rendered].join('\n');
}

function renderDormantAllowWarnOnDoneBlock(existing) {
  const children = parseIndentedBlocks(existing, 6);
  const knownKeys = new Set(Object.keys(DEFAULT_OPENSPEC_SETTINGS.allowWarnOnDone));
  const unknownChildren = children
    .filter((child) => !knownKeys.has(child.key))
    .map((child) => child.text.trimEnd());

  return unknownChildren.length === 0
    ? ''
    : ['    allowWarnOnDone:', ...unknownChildren].join('\n');
}

function renderAllowWarnOnDoneBlock(existing) {
  const children = parseIndentedBlocks(existing, 6);
  const settings = DEFAULT_OPENSPEC_SETTINGS.allowWarnOnDone;
  const rendered = ['    allowWarnOnDone:'];

  for (const [key, value] of Object.entries(settings)) {
    rendered.push(`      ${key}: ${renderYamlScalar(value)}`);
  }
  for (const child of children) {
    if (Object.hasOwn(settings, child.key)) continue;
    rendered.push(child.text.trimEnd());
  }
  return rendered.join('\n');
}

function renderYamlScalar(value) {
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  return String(value);
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
    ? ['description', 'architecture', 'context', 'roadmap', 'research', 'plans', 'specs', 'rules', 'state', 'qa', 'generated_rules']
    : ['description', 'architecture', 'context', 'roadmap', 'research', 'plans', 'specs', 'rules'];
  const extraKeys = Object.keys(merged)
    .filter((key) => !keys.includes(key))
    .filter((key) => mode !== MODES.aiFactory || !OPEN_SPEC_ONLY_PATH_KEYS.has(key))
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
    latestReviewedVersion: detection?.latestReviewedVersion ?? null,
    versionOutdated: detection?.versionOutdated ?? null,
    command: detection?.command ?? null,
    commandSource: detection?.commandSource ?? null,
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
    nodeVersion: options.nodeVersion,
    platform: options.platform,
    candidateExists: options.candidateExists,
    execFile: options.execFile,
    comSpec: options.comSpec
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
  const keys = config.configKeys ?? {
    changedKeyCount: 0,
    preservedKeyCount: 0,
    changedKeyPaths: [],
    preservedKeyPaths: [],
    truncated: false
  };
  return [
    '## Config',
    '',
    ...renderOperations(config.operations),
    '',
    `Changed key paths: ${keys.changedKeyCount}`,
    ...keys.changedKeyPaths.map((keyPath) => `- changed: ${keyPath}`),
    `Preserved key paths: ${keys.preservedKeyCount}`,
    ...keys.preservedKeyPaths.map((keyPath) => `- preserved: ${keyPath}`),
    ...(keys.truncated ? ['- config key path inventory truncated'] : [])
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
    ...renderOpenSpecCommand(sync.generatedRules?.openspecCli ?? sync.validation?.detection),
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
    `Base-only sync: ${generatedRules.baseOnly ? 'yes' : 'no'}`,
    `Change-specific rules skipped: ${generatedRules.changeSpecificSkipped ? 'yes' : 'no'}`,
    ...renderOpenSpecCommand(generatedRules.openspecCli),
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
    `Skipped changes: ${validation.skippedChanges?.length ?? 0}`,
    ...renderOpenSpecCommand(validation.detection),
    ...renderDiagnostics('Warnings', validation.warnings),
    ...renderDiagnostics('Errors', validation.errors)
  ].join('\n');
}

function renderOpenSpecCommand(detection) {
  if (detection?.command === null || detection?.command === undefined) {
    return [];
  }

  return [
    `OpenSpec command: ${detection.command}`,
    `OpenSpec command source: ${detection.commandSource ?? 'unknown'}`
  ];
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

function policyWarnOrFail(blocking, code, blockingMessage, warningMessage = null) {
  return blocking
    ? fail(code, blockingMessage)
    : warn(code, warningMessage ?? blockingMessage.replace(/; blocking for \/aif-done under current policy\./, '.'));
}

function renderArtifactContractDiagnostic(result) {
  if (!result) {
    return warn('aifhub-artifact-contract', 'AIFHub OpenSpec artifact contract validation did not run.');
  }

  const failed = (result.checks ?? []).filter((check) => check.status === 'fail');
  const warned = (result.checks ?? []).filter((check) => check.status === 'warn');

  if (result.status === 'pass') {
    return pass('aifhub-artifact-contract', 'AIFHub OpenSpec artifact contract passes.');
  }

  if (result.status === 'warn') {
    return warn(
      'aifhub-artifact-contract',
      `AIFHub OpenSpec artifact contract has ${warned.length} warning(s).`
    );
  }

  const first = failed[0];
  return fail(
    'aifhub-artifact-contract',
    `AIFHub OpenSpec artifact contract failed${first ? `: ${first.id}` : ''}.`
  );
}

function renderCoverageDiagnostic(result, policy = null) {
  const strictDone = Boolean(policy?.requirements?.specCoverage?.done);
  const allowCoverageWarn = Boolean(policy?.allowWarnOnDone?.coverage);

  if (!result?.exists) {
    return policyWarnOrFail(
      strictDone,
      'openspec-coverage-missing',
      `${result?.warnings?.[0] ?? 'Coverage matrix is missing.'} Run /aif-verify to regenerate coverage. Blocking for /aif-done under current policy.`,
      `${result?.warnings?.[0] ?? 'Coverage matrix is missing.'} Run /aif-verify to regenerate coverage.`
    );
  }

  if (!result.ok) {
    return fail('openspec-coverage-invalid', `${result.errors?.[0] ?? 'Coverage matrix is invalid.'} Run /aif-verify to regenerate coverage.`);
  }

  if (result.stale) {
    return policyWarnOrFail(
      strictDone,
      'openspec-coverage-stale',
      'Coverage matrix is stale. Run /aif-verify to regenerate coverage. Blocking for /aif-done under current policy.',
      'Coverage matrix is stale. Run /aif-verify to regenerate coverage.'
    );
  }

  const summary = summarizeOpenSpecCoverage(result.coverage).replace(/\n/g, '; ');
  if (result.coverage?.status === 'fail') {
    return fail('openspec-coverage-failed', summary);
  }

  if (result.coverage?.status === 'warn') {
    return allowCoverageWarn ? warn('openspec-coverage-warn', summary) : fail('openspec-coverage-warn', `${summary}; blocking for /aif-done under current policy.`);
  }

  return pass('openspec-coverage-pass', summary);
}

function renderRulesGateDiagnostic(result, policy) {
  const strictDone = Boolean(policy?.requirements?.rulesPass?.done);
  const allowRulesWarn = Boolean(policy?.allowWarnOnDone?.rules);

  if (!result?.exists) {
    return policyWarnOrFail(
      strictDone,
      'rules-gate-missing',
      `${result?.errors?.[0]?.message ?? 'Rules gate evidence is missing.'} Blocking for /aif-done under current policy.`,
      result?.errors?.[0]?.message ?? 'Rules gate evidence is missing.'
    );
  }

  if (result.status === 'invalid') {
    return fail('rules-gate-invalid', result.errors?.[0]?.message ?? 'Rules gate evidence is invalid.');
  }

  if (result.status === 'fail') {
    return fail('rules-gate-failed', 'Rules gate result failed for active change.');
  }

  if (result.status === 'warn') {
    return allowRulesWarn
      ? warn('rules-gate-warn', 'Rules gate result has policy-accepted warnings.')
      : fail('rules-gate-warn', 'Rules gate result has warnings; blocking for /aif-done under current policy.');
  }

  return pass('rules-gate-pass', 'Rules gate result passed for active change.');
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
    openspecCli: null,
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
