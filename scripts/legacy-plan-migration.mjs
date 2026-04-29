// legacy-plan-migration.mjs - explicit migration from legacy AI Factory plans to OpenSpec changes
import { access, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import {
  ensureRuntimeLayout as defaultEnsureRuntimeLayout,
  normalizeChangeId
} from './active-change-resolver.mjs';
import {
  detectOpenSpec as defaultDetectOpenSpec,
  validateOpenSpecChange as defaultValidateOpenSpecChange
} from './openspec-runner.mjs';

const DEFAULT_PLANS_DIR = path.join('.ai-factory', 'plans');
const DEFAULT_CHANGES_DIR = path.join('openspec', 'changes');
const DEFAULT_STATE_DIR = path.join('.ai-factory', 'state');
const DEFAULT_QA_DIR = path.join('.ai-factory', 'qa');
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

export async function discoverLegacyPlans(options = {}) {
  const rootDir = resolveRootDir(options);
  const plansRoot = resolveFromRoot(rootDir, options.plansDir ?? DEFAULT_PLANS_DIR);
  const changesRoot = resolveFromRoot(rootDir, options.changesDir ?? DEFAULT_CHANGES_DIR);
  const plansById = new Map();
  const warnings = [];

  let entries;
  try {
    entries = await readdir(plansRoot, { withFileTypes: true });
  } catch (err) {
    if (err?.code === 'ENOENT') {
      return {
        ok: true,
        plans: [],
        warnings: [],
        errors: []
      };
    }

    return {
      ok: false,
      plans: [],
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

      const plan = ensureDiscoveredPlan(plansById, normalized.planId, rootDir, changesRoot);
      plan.planFile = toPosix(path.relative(rootDir, path.join(plansRoot, entry.name)));
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

    const planDirPath = path.join(plansRoot, entry.name);
    const plan = ensureDiscoveredPlan(plansById, normalized.planId, rootDir, changesRoot);
    plan.planDir = toPosix(path.relative(rootDir, planDirPath));

    for (const [key, fileName] of Object.entries(KNOWN_PLAN_FILES)) {
      const filePath = path.join(planDirPath, fileName);
      if (await isFile(filePath)) {
        plan.files[key] = toPosix(path.relative(rootDir, filePath));
      }
    }
  }

  const plans = [];
  for (const plan of [...plansById.values()].sort((left, right) => left.id.localeCompare(right.id))) {
    plan.hasCanonicalTarget = await isDirectory(path.join(changesRoot, plan.id));

    if (options.includeContent) {
      plan.contents = await readLegacyPlanContents(rootDir, plan);
    }

    plans.push(plan);
  }

  return {
    ok: true,
    plans,
    warnings,
    errors: []
  };
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
      target: toPosix(path.join(DEFAULT_CHANGES_DIR, normalizedChange.changeId, 'proposal.md')),
      source: legacyPlan.planFile ?? sourceArtifacts[0] ?? null,
      content: renderProposal({ title, legacyPlan, contents, sourceArtifacts })
    },
    {
      kind: 'tasks',
      target: toPosix(path.join(DEFAULT_CHANGES_DIR, normalizedChange.changeId, 'tasks.md')),
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
      target: toPosix(path.join(DEFAULT_CHANGES_DIR, normalizedChange.changeId, 'design.md')),
      source: legacyPlan.files?.context ?? null,
      content: renderDesign({ title, legacyPlan, contents })
    });
  }

  if (hasText(contents.context)) {
    runtimeArtifacts.push({
      kind: 'legacy-context',
      target: toPosix(path.join(DEFAULT_STATE_DIR, normalizedChange.changeId, 'legacy-context.md')),
      source: legacyPlan.files?.context ?? null,
      content: renderPreservedMarkdown('Legacy Context', legacyPlan.files?.context, contents.context)
    });
  }

  if (hasText(contents.rules)) {
    runtimeArtifacts.push({
      kind: 'legacy-rules',
      target: toPosix(path.join(DEFAULT_STATE_DIR, normalizedChange.changeId, 'legacy-rules.md')),
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
      target: toPosix(path.join(DEFAULT_STATE_DIR, normalizedChange.changeId, 'legacy-status.yaml')),
      source: legacyPlan.files?.status ?? null,
      content: contents.status
    });
  }

  if (hasText(contents.explore)) {
    runtimeArtifacts.push({
      kind: 'legacy-explore',
      target: toPosix(path.join(DEFAULT_STATE_DIR, normalizedChange.changeId, 'legacy-explore.md')),
      source: legacyPlan.files?.explore ?? null,
      content: renderPreservedMarkdown('Legacy Exploration Notes', legacyPlan.files?.explore, contents.explore)
    });
  }

  if (hasText(contents.verify)) {
    qaArtifacts.push({
      kind: 'legacy-verify',
      target: toPosix(path.join(DEFAULT_QA_DIR, normalizedChange.changeId, 'legacy-verify.md')),
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
      target: toPosix(path.join(DEFAULT_CHANGES_DIR, normalizedChange.changeId, 'specs', 'migrated', 'spec.md')),
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

  const collision = await resolveCollisionTarget(normalized.planId, { ...options, rootDir, onCollision });
  if (!collision.ok) {
    return createMigrationFailure({
      dryRun,
      planId: normalized.planId,
      changeId: normalized.planId,
      targetChangePath: toPosix(path.join(DEFAULT_CHANGES_DIR, normalized.planId)),
      errors: collision.errors
    });
  }

  const mapped = mapLegacyPlanToOpenSpecArtifacts(legacyPlan, { changeId: collision.changeId });
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
      assertSafeArtifactTarget(rootDir, collision.changeId, artifact);
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
    });
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
      targetChangePath: toPosix(path.join(DEFAULT_CHANGES_DIR, collision.changeId)),
      operations,
      warnings: mapped.warnings,
      errors
    });
  }

  const baseResult = {
    ok: true,
    dryRun,
    planId: normalized.planId,
    changeId: collision.changeId,
    targetChangePath: toPosix(path.join(DEFAULT_CHANGES_DIR, collision.changeId)),
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
    ...options,
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
      results: [],
      migrated: [],
      failed: [],
      warnings: discovery.warnings,
      errors: discovery.errors
    };
  }

  const results = [];
  for (const plan of discovery.plans) {
    results.push(await migrateLegacyPlan(plan.id, { ...options, rootDir }));
  }

  const migrated = results.filter((result) => result.ok).map((result) => result.planId);
  const failed = results.filter((result) => !result.ok).map((result) => result.planId);

  return {
    ok: failed.length === 0,
    partial: migrated.length > 0 && failed.length > 0,
    dryRun: Boolean(options.dryRun),
    results,
    migrated,
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

  if (!normalized.ok) {
    throw new Error(normalized.error.message);
  }

  const reportPath = options.reportPath
    ? toPosix(options.reportPath)
    : toPosix(path.join(DEFAULT_STATE_DIR, normalized.changeId, 'migration-report.md'));
  const artifact = {
    bucket: 'state',
    target: reportPath,
    content: renderMigrationReport({
      planId,
      changeId: normalized.changeId,
      ...report
    })
  };
  assertSafeArtifactTarget(rootDir, normalized.changeId, artifact);

  if (options.dryRun) {
    return {
      ok: true,
      dryRun: true,
      path: reportPath
    };
  }

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
  const migrationSuggested = !changeExists && legacyPlan !== null;

  return {
    ok: discovery.ok,
    migrationSuggested,
    changeId: normalized.planId,
    changeExists,
    legacyPlan,
    commands: migrationSuggested
      ? [
          `node scripts/migrate-legacy-plans.mjs ${normalized.planId} --dry-run`,
          `node scripts/migrate-legacy-plans.mjs ${normalized.planId}`
        ]
      : [],
    warnings: discovery.warnings,
    errors: discovery.errors
  };
}

async function resolveCollisionTarget(planId, options) {
  const rootDir = resolveRootDir(options);
  const changesDir = options.changesDir ?? DEFAULT_CHANGES_DIR;
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
          source: toPosix(path.join(DEFAULT_PLANS_DIR, `${planId}.md`)),
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
  const defaultReportPath = toPosix(path.join(DEFAULT_STATE_DIR, changeId, 'migration-report.md'));

  if (options.onCollision === 'overwrite' || !await pathExists(resolveFromRoot(rootDir, defaultReportPath))) {
    return defaultReportPath;
  }

  for (let index = 0; index < 100; index += 1) {
    const suffix = index === 0 ? '-migrated' : `-migrated-${index + 1}`;
    const candidate = toPosix(path.join(DEFAULT_STATE_DIR, changeId, `migration-report${suffix}.md`));
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

function createMigrationFailure({ dryRun, planId, changeId, targetChangePath = null, operations = [], warnings = [], errors = [] }) {
  return {
    ok: false,
    dryRun,
    planId,
    changeId,
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

function assertSafeArtifactTarget(rootDir, changeId, artifact) {
  const targetPath = resolveFromRoot(rootDir, artifact.target);
  assertWithinRoot(rootDir, targetPath);
  assertNotLegacyPlanPath(rootDir, targetPath);
  assertNotBaseSpecPath(rootDir, targetPath);

  if (artifact.bucket === 'canonical') {
    assertWithinDirectory(targetPath, resolveFromRoot(rootDir, path.join(DEFAULT_CHANGES_DIR, changeId)), 'Canonical migration target must stay inside the OpenSpec change folder.');
    return;
  }

  if (artifact.bucket === 'state') {
    assertWithinDirectory(targetPath, resolveFromRoot(rootDir, path.join(DEFAULT_STATE_DIR, changeId)), 'Runtime state migration target must stay inside the change state folder.');
    return;
  }

  if (artifact.bucket === 'qa') {
    assertWithinDirectory(targetPath, resolveFromRoot(rootDir, path.join(DEFAULT_QA_DIR, changeId)), 'QA migration target must stay inside the change QA folder.');
    return;
  }

  throw new Error(`Unknown migration artifact bucket: ${artifact.bucket}.`);
}

function assertWithinRoot(rootDir, targetPath) {
  assertWithinDirectory(targetPath, path.resolve(rootDir), 'Migration target escapes repository root.');
}

function assertNotLegacyPlanPath(rootDir, targetPath) {
  const legacyPlansPath = resolveFromRoot(rootDir, DEFAULT_PLANS_DIR);
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
