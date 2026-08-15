// legacy-plan-migration.test.mjs - tests for legacy AI Factory plan migration to OpenSpec
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { access, cp, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  classifyLegacyPlanShape,
  detectMigrationNeed,
  discoverLegacyPlans,
  mapLegacyPlanToOpenSpecArtifacts,
  migrateAllLegacyPlans,
  migrateLegacyPlan,
  normalizeLegacyPlanId,
  normalizeLegacyPlanSourceRoot,
  readLegacyPlanSourceState,
  resolveLegacyPlanSourceRoot,
  writeLegacyPlanSourceState,
  writeMigrationReport
} from './legacy-plan-migration.mjs';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const CLI_PATH = path.join(REPO_ROOT, 'scripts', 'migrate-legacy-plans.mjs');
const tempRoots = [];

async function createTempRoot() {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'aifhub-legacy-migration-'));
  tempRoots.push(rootDir);
  return rootDir;
}

async function writeFixture(rootDir, relativePath, content) {
  const targetPath = path.join(rootDir, ...relativePath.split('/'));
  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeFile(targetPath, content, 'utf8');
  return targetPath;
}

async function readFixture(rootDir, relativePath) {
  return readFile(path.join(rootDir, ...relativePath.split('/')), 'utf8');
}

async function pathExists(rootDir, relativePath) {
  try {
    await access(path.join(rootDir, ...relativePath.split('/')));
    return true;
  } catch {
    return false;
  }
}

async function copyLegacyFixture(rootDir) {
  const fixtureRoot = path.join(REPO_ROOT, 'test', 'fixtures', 'legacy-plan-basic');
  await cp(fixtureRoot, rootDir, { recursive: true });
}

async function listFiles(rootDir, relativePath) {
  const base = path.join(rootDir, ...relativePath.split('/'));
  const output = [];

  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const child = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(child);
      } else {
        output.push(path.relative(rootDir, child).replaceAll('\\', '/'));
      }
    }
  }

  if (await pathExists(rootDir, relativePath)) {
    await walk(base);
  }

  return output.sort();
}

async function snapshotTree(rootDir) {
  const files = await listFiles(rootDir, '.');
  return Promise.all(files.map(async (relativePath) => [
    relativePath,
    (await readFile(path.join(rootDir, ...relativePath.split('/')))).toString('base64')
  ]));
}

async function writeValidUltraPlan(rootDir, planId, options = {}) {
  const plansRoot = options.plansRoot ?? '.ai-factory/plans';
  const marker = options.marker ?? '<!-- aif:plan-mode:ultra -->';
  const index = options.index ?? [
    marker,
    '',
    `# ${planId}`,
    '',
    '## Phase Index',
    '',
    '1. [Phase 01](phase-01-foundation.md)',
    '',
    '## Tasks',
    '',
    '- [ ] **Task 1:** Implement the foundation.',
    ''
  ].join('\n');
  await writeFixture(rootDir, `${plansRoot}/${planId}/index.md`, index);
  await writeFixture(rootDir, `${plansRoot}/${planId}/phase-01-foundation.md`, options.phase ?? [
    '# Phase 01: Foundation',
    '',
    '## Task 1: Implement the foundation',
    '',
    'Implementation detail without progress checkboxes.',
    ''
  ].join('\n'));
}

function missingCliDetection() {
  return {
    available: false,
    canValidate: false,
    canArchive: false,
    version: null,
    command: 'openspec',
    reason: 'missing-cli',
    errors: [
      {
        code: 'missing-cli',
        message: 'OpenSpec CLI is not available on PATH.'
      }
    ]
  };
}

function availableCliDetection() {
  return {
    available: true,
    canValidate: true,
    canArchive: true,
    version: '1.3.1',
    command: 'openspec',
    reason: null,
    errors: []
  };
}

function validationResult(overrides = {}) {
  return {
    ok: overrides.ok ?? true,
    command: 'openspec',
    args: ['validate', overrides.changeId ?? 'add-oauth', '--type', 'change', '--strict', '--json', '--no-interactive', '--no-color'],
    exitCode: overrides.exitCode ?? 0,
    stdout: overrides.stdout ?? '{"valid":true}',
    stderr: overrides.stderr ?? '',
    json: Object.hasOwn(overrides, 'json') ? overrides.json : { valid: true },
    jsonParseError: null,
    error: overrides.error ?? null
  };
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((rootDir) => rm(rootDir, {
    recursive: true,
    force: true
  })));
});

describe('legacy plan migration API', () => {
  it('exports required public functions', () => {
    for (const fn of [
      classifyLegacyPlanShape,
      discoverLegacyPlans,
      migrateLegacyPlan,
      migrateAllLegacyPlans,
      mapLegacyPlanToOpenSpecArtifacts,
      writeMigrationReport,
      detectMigrationNeed,
      normalizeLegacyPlanId,
      normalizeLegacyPlanSourceRoot,
      readLegacyPlanSourceState,
      resolveLegacyPlanSourceRoot,
      writeLegacyPlanSourceState
    ]) {
      assert.equal(typeof fn, 'function');
    }
  });

  it('normalizes safe legacy ids and rejects unsafe ids', () => {
    assert.deepEqual(normalizeLegacyPlanId(' add-oauth '), {
      ok: true,
      planId: 'add-oauth',
      error: null
    });

    for (const input of ['', '../escape', 'nested/change', 'nested\\change', '.hidden', 'archive', 'bad name']) {
      const result = normalizeLegacyPlanId(input);
      assert.equal(result.ok, false, `${input} should be rejected`);
      assert.equal(result.planId, null);
      assert.equal(result.error.code, 'invalid-legacy-plan-id');
    }
  });
});

describe('discoverLegacyPlans', () => {
  it('returns an empty successful result when the legacy plans directory is missing', async () => {
    const rootDir = await createTempRoot();

    const result = await discoverLegacyPlans({ rootDir });

    assert.equal(result.ok, true);
    assert.equal(result.legacyPlanSourceRoot, '.ai-factory/plans');
    assert.equal(result.legacyPlanSource.source, 'default');
    assert.deepEqual(result.plans, []);
    assert.deepEqual(result.ignored, []);
    assert.deepEqual(result.warnings, []);
    assert.deepEqual(result.errors, []);
  });

  it('discovers a legacy plan with both parent markdown and companion directory', async () => {
    const rootDir = await createTempRoot();
    await copyLegacyFixture(rootDir);

    const result = await discoverLegacyPlans({ rootDir });

    assert.equal(result.ok, true);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.plans.map((plan) => plan.id), ['add-oauth']);
    assert.equal(result.plans[0].planFile, '.ai-factory/plans/add-oauth.md');
    assert.equal(result.plans[0].planDir, '.ai-factory/plans/add-oauth');
    assert.deepEqual(result.plans[0].files, {
      task: '.ai-factory/plans/add-oauth/task.md',
      context: '.ai-factory/plans/add-oauth/context.md',
      rules: '.ai-factory/plans/add-oauth/rules.md',
      verify: '.ai-factory/plans/add-oauth/verify.md',
      status: '.ai-factory/plans/add-oauth/status.yaml',
      explore: '.ai-factory/plans/add-oauth/explore.md'
    });
    assert.equal(result.plans[0].hasCanonicalTarget, false);
    assert.equal(result.plans[0].targetChangePath, 'openspec/changes/add-oauth');
  });

  it('discovers parent-only and folder-only forms and returns stable relative paths', async () => {
    const rootDir = await createTempRoot();
    await writeFixture(rootDir, '.ai-factory/plans/parent-only.md', '# Parent only\n');
    await writeFixture(rootDir, '.ai-factory/plans/folder-only/task.md', '# Task only\n');
    await writeFixture(rootDir, '.ai-factory/plans/.hidden.md', '# Hidden\n');
    await writeFixture(rootDir, '.ai-factory/plans/archive/old/task.md', '# Archived\n');
    await writeFixture(rootDir, '.ai-factory/plans/backup/old/task.md', '# Backup\n');
    await writeFixture(rootDir, '.ai-factory/plans/unrelated.txt', 'ignore\n');

    const result = await discoverLegacyPlans({ rootDir });

    assert.equal(result.ok, true);
    assert.deepEqual(result.plans.map((plan) => plan.id), ['folder-only', 'parent-only']);
    assert.equal(result.plans[0].planFile, null);
    assert.equal(result.plans[0].planDir, '.ai-factory/plans/folder-only');
    assert.deepEqual(result.plans[0].files, {
      task: '.ai-factory/plans/folder-only/task.md'
    });
    assert.equal(result.plans[1].planFile, '.ai-factory/plans/parent-only.md');
    assert.equal(result.plans[1].planDir, null);
    assert.deepEqual(result.plans[1].files, {});
  });
});

describe('marker-first legacy plan classification', () => {
  it('accepts the upstream optional Handoff annotation immediately before the marker', async () => {
    const rootDir = await createTempRoot();
    await writeValidUltraPlan(rootDir, 'handoff-ultra', {
      index: [
        '<!-- handoff:task:task-123 -->',
        '<!-- aif:plan-mode:ultra -->',
        '# Ultra Plan',
        '',
        '## Phase Index',
        '',
        '1. [Phase 1: Foundation](phase-01-foundation.md) — Task 1',
        '',
        '## Tasks',
        '',
        '- [ ] Task 1: Implement the foundation.',
        ''
      ].join('\n')
    });

    const result = await classifyLegacyPlanShape('handoff-ultra', { rootDir });
    assert.equal(result.shape, 'ultra-valid');
    assert.deepEqual(result.errors, []);
  });

  it('distinguishes classic, valid ultra, and unrelated directories before companion discovery', async () => {
    const rootDir = await createTempRoot();
    await writeFixture(rootDir, '.ai-factory/plans/classic.md', '# Classic\n');
    await writeFixture(rootDir, '.ai-factory/plans/folder/task.md', '# Task\n');
    await writeValidUltraPlan(rootDir, 'ultra');
    await writeFixture(rootDir, '.ai-factory/plans/notes/README.md', '# Notes\n');

    const result = await discoverLegacyPlans({ rootDir });

    assert.equal(result.ok, true);
    assert.deepEqual(result.plans.map((plan) => [plan.id, plan.shape]), [
      ['classic', 'classic-pair'],
      ['folder', 'classic-folder-only'],
      ['ultra', 'ultra-valid']
    ]);
    assert.deepEqual(result.ignored.map((entry) => [entry.id, entry.shape]), [
      ['notes', 'unrelated-directory']
    ]);
    assert.deepEqual(result.plans.find((plan) => plan.id === 'ultra').files, {});
  });

  it('fails closed for the invalid ultra matrix and never falls back to classic', async () => {
    const cases = [
      {
        id: 'missing-marker',
        expected: 'ultra-marker-missing',
        index: '# Missing marker\n\n## Phase Index\n\n- [Phase 01](phase-01-foundation.md)\n\n## Tasks\n\n- [ ] Task 1: Work.\n'
      },
      {
        id: 'code-only-marker',
        expected: 'ultra-marker-code-only',
        index: '`<!-- aif:plan-mode:ultra -->`\n\n## Phase Index\n\n- [Phase 01](phase-01-foundation.md)\n\n## Tasks\n\n- [ ] Task 1: Work.\n'
      },
      {
        id: 'fenced-marker',
        expected: 'ultra-marker-code-only',
        index: '```md\n<!-- aif:plan-mode:ultra -->\n```\n\n## Phase Index\n\n1. [Phase 01](phase-01-foundation.md)\n\n## Tasks\n\n- [ ] Task 1: Work.\n'
      },
      {
        id: 'duplicate-marker',
        expected: 'ultra-marker-duplicate',
        index: '<!-- aif:plan-mode:ultra -->\n<!-- aif:plan-mode:ultra -->\n\n## Phase Index\n\n- [Phase 01](phase-01-foundation.md)\n\n## Tasks\n\n- [ ] Task 1: Work.\n'
      },
      {
        id: 'misplaced-marker',
        expected: 'ultra-marker-position-invalid',
        index: '# Heading first\n<!-- aif:plan-mode:ultra -->\n\n## Phase Index\n\n1. [Phase 01](phase-01-foundation.md)\n\n## Tasks\n\n- [ ] Task 1: Work.\n'
      },
      {
        id: 'missing-phase-index',
        expected: 'ultra-phase-index-missing',
        index: '<!-- aif:plan-mode:ultra -->\n\n## Tasks\n\n- [ ] Task 1: Work.\n'
      },
      {
        id: 'malformed-phase-index',
        expected: 'ultra-phase-index-malformed',
        index: '<!-- aif:plan-mode:ultra -->\n\n## Phase Index\n\nphase-01-foundation.md\n\n## Tasks\n\n- [ ] Task 1: Work.\n'
      },
      {
        id: 'unsafe-phase-link',
        expected: 'ultra-phase-link-unsafe',
        index: '<!-- aif:plan-mode:ultra -->\n\n## Phase Index\n\n- [Phase 01](../phase-01-foundation.md)\n\n## Tasks\n\n- [ ] Task 1: Work.\n'
      },
      {
        id: 'missing-task-mapping',
        expected: 'ultra-task-mapping-missing',
        phase: '# Phase\n\n## Task 2: Different task\n'
      },
      {
        id: 'phase-progress',
        expected: 'ultra-phase-progress-checkbox',
        phase: '# Phase\n\n## Task 1: Work\n\n- [ ] Phase-local progress\n'
      }
    ];

    for (const fixture of cases) {
      const rootDir = await createTempRoot();
      await writeValidUltraPlan(rootDir, fixture.id, fixture);
      const before = await snapshotTree(rootDir);
      const classification = await classifyLegacyPlanShape(fixture.id, { rootDir });

      assert.equal(classification.shape, 'ultra-invalid', fixture.id);
      assert.ok(
        classification.errors.some((error) => error.code === fixture.expected),
        `${fixture.id} should report ${fixture.expected}: ${JSON.stringify(classification.errors)}`
      );

      const needed = await detectMigrationNeed({ rootDir, changeId: fixture.id });
      assert.equal(needed.ok, false, fixture.id);
      assert.equal(needed.migrationSuggested, false, fixture.id);

      for (const dryRun of [true, false]) {
        const migrated = await migrateLegacyPlan(fixture.id, { rootDir, dryRun });
        assert.equal(migrated.ok, false, fixture.id);
        assert.equal(migrated.outcome, 'failed', fixture.id);
        assert.equal(migrated.shape, 'ultra-invalid', fixture.id);
        assert.deepEqual(await snapshotTree(rootDir), before, fixture.id);
      }
    }
  });

  it('detects missing, orphan, duplicate mapping, and classic-ultra collision diagnostics', async () => {
    const missingRoot = await createTempRoot();
    await writeFixture(missingRoot, '.ai-factory/plans/missing-phase/index.md', [
      '<!-- aif:plan-mode:ultra -->',
      '',
      '## Phase Index',
      '',
      '- [Phase 01](phase-01-foundation.md)',
      '',
      '## Tasks',
      '',
      '- [ ] Task 1: Work.',
      ''
    ].join('\n'));
    const missing = await classifyLegacyPlanShape('missing-phase', { rootDir: missingRoot });
    assert.equal(missing.shape, 'ultra-invalid');
    assert.ok(missing.errors.some((error) => error.code === 'ultra-phase-file-missing'));

    const orphanRoot = await createTempRoot();
    await writeValidUltraPlan(orphanRoot, 'orphan');
    await writeFixture(orphanRoot, '.ai-factory/plans/orphan/phase-02-orphan.md', '# Orphan\n');
    const orphan = await classifyLegacyPlanShape('orphan', { rootDir: orphanRoot });
    assert.equal(orphan.shape, 'ultra-invalid');
    assert.ok(orphan.errors.some((error) => error.code === 'ultra-phase-file-orphan'));

    const duplicateRoot = await createTempRoot();
    await writeFixture(duplicateRoot, '.ai-factory/plans/duplicate/index.md', [
      '<!-- aif:plan-mode:ultra -->',
      '',
      '## Phase Index',
      '',
      '- [Phase 01](phase-01-foundation.md)',
      '- [Phase 02](phase-02-follow-up.md)',
      '',
      '## Tasks',
      '',
      '- [ ] Task 1: Work.',
      ''
    ].join('\n'));
    await writeFixture(duplicateRoot, '.ai-factory/plans/duplicate/phase-01-foundation.md', '## Task 1: First\n');
    await writeFixture(duplicateRoot, '.ai-factory/plans/duplicate/phase-02-follow-up.md', '## Task 1: Again\n');
    const duplicate = await classifyLegacyPlanShape('duplicate', { rootDir: duplicateRoot });
    assert.equal(duplicate.shape, 'ultra-invalid');
    assert.ok(duplicate.errors.some((error) => error.code === 'ultra-task-mapping-duplicate'));

    const collisionRoot = await createTempRoot();
    await writeFixture(collisionRoot, '.ai-factory/plans/collision.md', '# Classic\n');
    await writeValidUltraPlan(collisionRoot, 'collision');
    const collision = await classifyLegacyPlanShape('collision', { rootDir: collisionRoot });
    assert.equal(collision.shape, 'collision');
    assert.ok(collision.errors.some((error) => error.code === 'classic-ultra-plan-collision'));
  });

  it('returns skipped-ultra without proposing or writing migration artifacts', async () => {
    const rootDir = await createTempRoot();
    await writeValidUltraPlan(rootDir, 'upstream-ultra');
    const before = await snapshotTree(rootDir);

    const needed = await detectMigrationNeed({ rootDir, changeId: 'upstream-ultra' });
    assert.equal(needed.ok, true);
    assert.equal(needed.migrationSuggested, false);
    assert.deepEqual(needed.commands, []);
    assert.ok(needed.warnings.some((warning) => warning.code === 'ultra-plan-not-migrated'));

    const result = await migrateLegacyPlan('upstream-ultra', { rootDir });
    assert.equal(result.ok, true);
    assert.equal(result.outcome, 'skipped-ultra');
    assert.equal(result.skipped, true);
    assert.deepEqual(result.operations, []);
    assert.deepEqual(await snapshotTree(rootDir), before);
  });
});

describe('legacy plan source root', () => {
  it('uses explicit, recorded, and default roots in deterministic precedence', async () => {
    const rootDir = await createTempRoot();
    await writeLegacyPlanSourceState('recorded/plans', {
      rootDir,
      timestamp: '2026-08-14T00:00:00.000Z',
      reason: 'migration-declined'
    });

    const recorded = await resolveLegacyPlanSourceRoot({ rootDir });
    assert.equal(recorded.source, 'recorded');
    assert.equal(recorded.legacyPlanSourceRoot, 'recorded/plans');

    const explicit = await resolveLegacyPlanSourceRoot({
      rootDir,
      legacyPlanSourceRoot: 'explicit/plans'
    });
    assert.equal(explicit.source, 'explicit');
    assert.equal(explicit.legacyPlanSourceRoot, 'explicit/plans');

    const defaultRoot = await resolveLegacyPlanSourceRoot({
      rootDir,
      useRecordedLegacyPlanSource: false
    });
    assert.equal(defaultRoot.source, 'default');
    assert.equal(defaultRoot.legacyPlanSourceRoot, '.ai-factory/plans');
  });

  it('dry-run state persistence is byte-identical and reports wouldPersist', async () => {
    const rootDir = await createTempRoot();
    await writeFixture(rootDir, 'custom/plans/alpha.md', '# Alpha\n');
    const before = await snapshotTree(rootDir);

    const result = await writeLegacyPlanSourceState('custom/plans', {
      rootDir,
      dryRun: true
    });

    assert.equal(result.ok, true);
    assert.equal(result.persisted, false);
    assert.equal(result.wouldPersist, 'custom/plans');
    assert.equal(await pathExists(rootDir, '.ai-factory/state/legacy-plan-source.json'), false);
    assert.deepEqual(await snapshotTree(rootDir), before);
  });

  it('rejects traversal, absolute, URI, and canonical-overlap sources', () => {
    for (const value of ['../plans', 'C:/plans', 'https://example.test/plans', 'openspec', 'openspec/changes', 'openspec/changes/nested']) {
      assert.equal(normalizeLegacyPlanSourceRoot(value).ok, false, value);
    }
    assert.deepEqual(normalizeLegacyPlanSourceRoot('custom\\plans'), {
      ok: true,
      legacyPlanSourceRoot: 'custom/plans',
      error: null
    });
  });
});

describe('mapLegacyPlanToOpenSpecArtifacts', () => {
  it('maps legacy artifacts to canonical, runtime, and QA targets without losing intended meaning', async () => {
    const rootDir = await createTempRoot();
    await copyLegacyFixture(rootDir);
    const [legacyPlan] = (await discoverLegacyPlans({ rootDir, includeContent: true })).plans;

    const mapped = mapLegacyPlanToOpenSpecArtifacts(legacyPlan);

    assert.equal(mapped.ok, true);
    assert.ok(mapped.canonicalArtifacts.some((artifact) => artifact.target === 'openspec/changes/add-oauth/proposal.md'));
    assert.ok(mapped.canonicalArtifacts.some((artifact) => artifact.target === 'openspec/changes/add-oauth/tasks.md'));
    assert.ok(mapped.canonicalArtifacts.some((artifact) => artifact.target === 'openspec/changes/add-oauth/design.md'));
    assert.ok(mapped.canonicalArtifacts.some((artifact) => artifact.target === 'openspec/changes/add-oauth/specs/migrated/spec.md'));
    assert.ok(mapped.runtimeArtifacts.some((artifact) => artifact.target === '.ai-factory/state/add-oauth/legacy-context.md'));
    assert.ok(mapped.runtimeArtifacts.some((artifact) => artifact.target === '.ai-factory/state/add-oauth/legacy-rules.md'));
    assert.ok(mapped.runtimeArtifacts.some((artifact) => artifact.target === '.ai-factory/state/add-oauth/legacy-status.yaml'));
    assert.ok(mapped.runtimeArtifacts.some((artifact) => artifact.target === '.ai-factory/state/add-oauth/legacy-explore.md'));
    assert.ok(mapped.qaArtifacts.some((artifact) => artifact.target === '.ai-factory/qa/add-oauth/legacy-verify.md'));

    const proposal = mapped.canonicalArtifacts.find((artifact) => artifact.target.endsWith('/proposal.md')).content;
    assert.match(proposal, /# Proposal: Add OAuth Authentication/);
    assert.match(proposal, /GitHub OAuth callback/);
    assert.match(proposal, /\.ai-factory\/plans\/add-oauth\.md/);

    const tasks = mapped.canonicalArtifacts.find((artifact) => artifact.target.endsWith('/tasks.md')).content;
    assert.match(tasks, /- \[ \] Add GitHub OAuth callback route\./);

    const spec = mapped.canonicalArtifacts.find((artifact) => artifact.target.endsWith('/spec.md')).content;
    assert.match(spec, /The system MUST allow a user with a valid GitHub OAuth callback to sign in\./);
  });

  it('preserves non-checklist task content under migrated legacy tasks', () => {
    const mapped = mapLegacyPlanToOpenSpecArtifacts({
      id: 'plain-task',
      planFile: '.ai-factory/plans/plain-task.md',
      planDir: '.ai-factory/plans/plain-task',
      files: {
        task: '.ai-factory/plans/plain-task/task.md'
      },
      contents: {
        plan: '# Plain Task\n\nMigrate the plain task plan.',
        task: 'Implement the migration in one careful pass.'
      },
      hasCanonicalTarget: false,
      targetChangePath: 'openspec/changes/plain-task'
    });

    assert.equal(mapped.ok, true);
    const tasks = mapped.canonicalArtifacts.find((artifact) => artifact.target.endsWith('/tasks.md')).content;
    assert.match(tasks, /## Migrated legacy tasks/);
    assert.match(tasks, /Implement the migration in one careful pass\./);
  });

  it('honors custom canonical, state, and QA directories during mapping', async () => {
    const rootDir = await createTempRoot();
    await copyLegacyFixture(rootDir);
    const [legacyPlan] = (await discoverLegacyPlans({ rootDir, includeContent: true })).plans;

    const mapped = mapLegacyPlanToOpenSpecArtifacts(legacyPlan, {
      changesDir: 'custom/changes',
      stateDir: 'custom/state',
      qaDir: 'custom/qa'
    });

    assert.equal(mapped.ok, true);
    assert.ok(mapped.canonicalArtifacts.every((artifact) => artifact.target.startsWith('custom/changes/add-oauth/')));
    assert.ok(mapped.runtimeArtifacts.every((artifact) => artifact.target.startsWith('custom/state/add-oauth/')));
    assert.ok(mapped.qaArtifacts.every((artifact) => artifact.target.startsWith('custom/qa/add-oauth/')));
  });
});

describe('migrateLegacyPlan', () => {
  it('rejects unsafe plan ids before writing files', async () => {
    const rootDir = await createTempRoot();

    const result = await migrateLegacyPlan('../escape', { rootDir });

    assert.equal(result.ok, false);
    assert.equal(result.errors[0].code, 'invalid-legacy-plan-id');
    assert.equal(await pathExists(rootDir, 'openspec'), false);
  });

  it('migrates parent-only plans with safe fallback tasks and no runtime-only artifacts', async () => {
    const rootDir = await createTempRoot();
    await writeFixture(rootDir, '.ai-factory/plans/parent-only.md', '# Parent Only\n\nA small migrated plan.\n');

    const result = await migrateLegacyPlan('parent-only', {
      rootDir,
      detectOpenSpec: async () => missingCliDetection()
    });

    assert.equal(result.ok, true);
    assert.match(await readFixture(rootDir, 'openspec/changes/parent-only/proposal.md'), /Parent Only/);
    assert.match(await readFixture(rootDir, 'openspec/changes/parent-only/tasks.md'), /Review migrated legacy artifacts/);
    assert.equal(await pathExists(rootDir, '.ai-factory/qa/parent-only/legacy-verify.md'), false);
    assert.equal(await pathExists(rootDir, '.ai-factory/state/parent-only/legacy-status.yaml'), false);
  });

  it('dry-run returns operations and writes nothing', async () => {
    const rootDir = await createTempRoot();
    await copyLegacyFixture(rootDir);
    let ensureRuntimeLayoutCalls = 0;

    const result = await migrateLegacyPlan('add-oauth', {
      rootDir,
      dryRun: true,
      ensureRuntimeLayout: async () => {
        ensureRuntimeLayoutCalls += 1;
        throw new Error('dry-run must not create runtime layout');
      }
    });

    assert.equal(result.ok, true);
    assert.equal(result.dryRun, true);
    assert.equal(ensureRuntimeLayoutCalls, 0);
    assert.ok(result.operations.some((operation) => operation.target === 'openspec/changes/add-oauth/proposal.md'));
    assert.equal(await pathExists(rootDir, 'openspec/changes/add-oauth/proposal.md'), false);
    assert.equal(await pathExists(rootDir, '.ai-factory/state/add-oauth/migration-report.md'), false);
  });

  it('migrates canonical artifacts and preserves runtime-only artifacts outside OpenSpec change folders', async () => {
    const rootDir = await createTempRoot();
    await copyLegacyFixture(rootDir);

    const result = await migrateLegacyPlan('add-oauth', {
      rootDir,
      detectOpenSpec: async () => missingCliDetection()
    });

    assert.equal(result.ok, true);
    assert.equal(result.validation.status, 'SKIPPED');
    assert.match(await readFixture(rootDir, 'openspec/changes/add-oauth/proposal.md'), /GitHub OAuth/);
    assert.match(await readFixture(rootDir, 'openspec/changes/add-oauth/tasks.md'), /Add GitHub OAuth callback route/);
    assert.match(await readFixture(rootDir, 'openspec/changes/add-oauth/design.md'), /authentication middleware/);
    assert.match(await readFixture(rootDir, 'openspec/changes/add-oauth/specs/migrated/spec.md'), /valid GitHub OAuth callback/);
    assert.match(await readFixture(rootDir, '.ai-factory/state/add-oauth/legacy-context.md'), /provider state/);
    assert.match(await readFixture(rootDir, '.ai-factory/state/add-oauth/legacy-rules.md'), /access tokens/);
    assert.match(await readFixture(rootDir, '.ai-factory/state/add-oauth/legacy-status.yaml'), /status: planned/);
    assert.match(await readFixture(rootDir, '.ai-factory/state/add-oauth/legacy-explore.md'), /GitHub OAuth/);
    assert.match(await readFixture(rootDir, '.ai-factory/qa/add-oauth/legacy-verify.md'), /authentication tests/);
    assert.equal(await pathExists(rootDir, 'openspec/changes/add-oauth/verify.md'), false);
    assert.equal(await pathExists(rootDir, 'openspec/changes/add-oauth/status.yaml'), false);
    assert.deepEqual(await listFiles(rootDir, 'openspec/specs'), []);
    assert.equal(await pathExists(rootDir, '.ai-factory/plans/add-oauth.md'), true);
    assert.equal(await pathExists(rootDir, '.ai-factory/plans/add-oauth/task.md'), true);

    const report = await readFixture(rootDir, '.ai-factory/state/add-oauth/migration-report.md');
    assert.match(report, /OpenSpec validation: SKIPPED/);
    assert.match(report, /\.ai-factory\/plans\/add-oauth\/verify\.md/);
    assert.match(report, /\.ai-factory\/qa\/add-oauth\/legacy-verify\.md/);
  });

  it('honors custom changesDir, stateDir, and qaDir when writing migration artifacts', async () => {
    const rootDir = await createTempRoot();
    await copyLegacyFixture(rootDir);
    let layoutCall = null;

    const result = await migrateLegacyPlan('add-oauth', {
      rootDir,
      changesDir: 'custom/changes',
      stateDir: 'custom/state',
      qaDir: 'custom/qa',
      detectOpenSpec: async () => missingCliDetection(),
      ensureRuntimeLayout: async (changeId, layoutOptions) => {
        layoutCall = {
          changeId,
          stateDir: layoutOptions.stateDir,
          qaDir: layoutOptions.qaDir
        };
      }
    });

    assert.equal(result.ok, true);
    assert.equal(result.targetChangePath, 'custom/changes/add-oauth');
    assert.equal(result.reportPath, 'custom/state/add-oauth/migration-report.md');
    assert.deepEqual(layoutCall, {
      changeId: 'add-oauth',
      stateDir: 'custom/state',
      qaDir: 'custom/qa'
    });
    assert.equal(await pathExists(rootDir, 'custom/changes/add-oauth/proposal.md'), true);
    assert.equal(await pathExists(rootDir, 'custom/changes/add-oauth/tasks.md'), true);
    assert.equal(await pathExists(rootDir, 'custom/changes/add-oauth/specs/migrated/spec.md'), true);
    assert.equal(await pathExists(rootDir, 'custom/state/add-oauth/legacy-status.yaml'), true);
    assert.equal(await pathExists(rootDir, 'custom/state/add-oauth/migration-report.md'), true);
    assert.equal(await pathExists(rootDir, 'custom/qa/add-oauth/legacy-verify.md'), true);
    assert.equal(await pathExists(rootDir, 'openspec/changes/add-oauth/proposal.md'), false);
    assert.equal(await pathExists(rootDir, '.ai-factory/state/add-oauth/migration-report.md'), false);
    assert.equal(await pathExists(rootDir, '.ai-factory/qa/add-oauth/legacy-verify.md'), false);
  });

  it('fails by default on target collision and supports suffix and merge-safe modes', async () => {
    const rootDir = await createTempRoot();
    await copyLegacyFixture(rootDir);
    await writeFixture(rootDir, 'openspec/changes/add-oauth/proposal.md', '# Existing\n');
    await writeFixture(rootDir, '.ai-factory/state/add-oauth/migration-report.md', '# Existing Report\n');

    const failed = await migrateLegacyPlan('add-oauth', { rootDir });
    assert.equal(failed.ok, false);
    assert.equal(failed.errors[0].code, 'target-exists');

    const suffixed = await migrateLegacyPlan('add-oauth', {
      rootDir,
      onCollision: 'suffix',
      detectOpenSpec: async () => missingCliDetection()
    });
    assert.equal(suffixed.ok, true);
    assert.equal(suffixed.changeId, 'add-oauth-migrated');
    assert.equal(await pathExists(rootDir, 'openspec/changes/add-oauth-migrated/proposal.md'), true);
    assert.equal((await readFixture(rootDir, 'openspec/changes/add-oauth/proposal.md')).trim(), '# Existing');

    const merged = await migrateLegacyPlan('add-oauth', {
      rootDir,
      onCollision: 'merge-safe',
      detectOpenSpec: async () => missingCliDetection()
    });
    assert.equal(merged.ok, true);
    assert.ok(merged.operations.some((operation) => operation.action === 'skip' && operation.target === 'openspec/changes/add-oauth/proposal.md'));
    assert.equal((await readFixture(rootDir, 'openspec/changes/add-oauth/proposal.md')).trim(), '# Existing');
    assert.equal(await pathExists(rootDir, 'openspec/changes/add-oauth/tasks.md'), true);
    assert.equal((await readFixture(rootDir, '.ai-factory/state/add-oauth/migration-report.md')).trim(), '# Existing Report');
    assert.equal(merged.reportPath, '.ai-factory/state/add-oauth/migration-report-migrated.md');
    assert.equal(await pathExists(rootDir, '.ai-factory/state/add-oauth/migration-report-migrated.md'), true);
  });

  it('calls validation when CLI is available and records validation failures', async () => {
    const rootDir = await createTempRoot();
    await copyLegacyFixture(rootDir);
    const calls = [];

    const result = await migrateLegacyPlan('add-oauth', {
      rootDir,
      detectOpenSpec: async () => availableCliDetection(),
      validateOpenSpecChange: async (changeId) => {
        calls.push(changeId);
        return validationResult({ ok: false, exitCode: 1, stdout: '{"valid":false}', json: null });
      }
    });

    assert.equal(result.ok, false);
    assert.deepEqual(calls, ['add-oauth']);
    assert.equal(result.validation.status, 'FAIL');
    assert.match(await readFixture(rootDir, '.ai-factory/state/add-oauth/migration-report.md'), /OpenSpec validation: FAIL/);
  });

  it('overwrites existing generated targets only when explicitly requested', async () => {
    const rootDir = await createTempRoot();
    await copyLegacyFixture(rootDir);
    await writeFixture(rootDir, 'openspec/changes/add-oauth/proposal.md', '# Existing\n');

    const result = await migrateLegacyPlan('add-oauth', {
      rootDir,
      onCollision: 'overwrite',
      detectOpenSpec: async () => missingCliDetection()
    });

    assert.equal(result.ok, true);
    assert.match(await readFixture(rootDir, 'openspec/changes/add-oauth/proposal.md'), /GitHub OAuth/);
  });
});

describe('migrateAllLegacyPlans and detectMigrationNeed', () => {
  it('dry-runs all legacy plans without writing targets', async () => {
    const rootDir = await createTempRoot();
    await writeFixture(rootDir, '.ai-factory/plans/alpha.md', '# Alpha\n');
    await writeFixture(rootDir, '.ai-factory/plans/beta.md', '# Beta\n');

    const result = await migrateAllLegacyPlans({ rootDir, dryRun: true });

    assert.equal(result.ok, true);
    assert.deepEqual(result.migrated, ['alpha', 'beta']);
    assert.equal(await pathExists(rootDir, 'openspec/changes/alpha/proposal.md'), false);
    assert.equal(await pathExists(rootDir, 'openspec/changes/beta/proposal.md'), false);
  });

  it('preflights all legacy plans atomically before the first write', async () => {
    const rootDir = await createTempRoot();
    await writeFixture(rootDir, '.ai-factory/plans/alpha.md', '# Alpha\n');
    await writeFixture(rootDir, '.ai-factory/plans/beta.md', '# Beta\n');
    await writeFixture(rootDir, 'openspec/changes/beta/proposal.md', '# Existing\n');

    const result = await migrateAllLegacyPlans({
      rootDir,
      detectOpenSpec: async () => missingCliDetection()
    });

    assert.equal(result.ok, false);
    assert.equal(result.partial, false);
    assert.equal(result.preflightFailed, true);
    assert.deepEqual(result.migrated, []);
    assert.deepEqual(result.wouldMigrate, ['alpha']);
    assert.deepEqual(result.failed, ['beta']);
    assert.equal(await pathExists(rootDir, 'openspec/changes/alpha/proposal.md'), false);
  });

  it('reports migrated, skipped-ultra, and failed outcomes for a mixed batch without writes', async () => {
    const rootDir = await createTempRoot();
    await writeFixture(rootDir, '.ai-factory/plans/alpha.md', '# Alpha\n');
    await writeValidUltraPlan(rootDir, 'beta');
    await writeValidUltraPlan(rootDir, 'delta');
    await writeFixture(rootDir, '.ai-factory/plans/delta.md', '# Delta classic collision\n');
    await writeValidUltraPlan(rootDir, 'gamma', {
      index: '# Missing marker\n\n## Phase Index\n\n- [Phase 01](phase-01-foundation.md)\n\n## Tasks\n\n- [ ] Task 1: Work.\n'
    });
    const before = await snapshotTree(rootDir);

    const result = await migrateAllLegacyPlans({ rootDir });

    assert.equal(result.ok, false);
    assert.equal(result.preflightFailed, true);
    assert.deepEqual(result.migrated, []);
    assert.deepEqual(result.wouldMigrate, ['alpha']);
    assert.deepEqual(result.skipped, ['beta']);
    assert.deepEqual(result.failed, ['delta', 'gamma']);
    assert.deepEqual(result.results.map((entry) => [entry.planId, entry.outcome]), [
      ['alpha', 'migrated'],
      ['beta', 'skipped-ultra'],
      ['delta', 'failed'],
      ['gamma', 'failed']
    ]);
    assert.deepEqual(await snapshotTree(rootDir), before);
  });

  it('detects matching legacy plans and returns exact suggestion commands', async () => {
    const rootDir = await createTempRoot();
    await copyLegacyFixture(rootDir);

    const needed = await detectMigrationNeed({ rootDir, changeId: 'add-oauth' });
    assert.equal(needed.ok, true);
    assert.equal(needed.migrationSuggested, true);
    assert.equal(needed.changeExists, false);
    assert.equal(needed.legacyPlan.id, 'add-oauth');
    assert.deepEqual(needed.commands, [
      'ai-factory aifhub-migrate-legacy-plans add-oauth --dry-run',
      'ai-factory aifhub-migrate-legacy-plans add-oauth'
    ]);

    await writeFixture(rootDir, 'openspec/changes/add-oauth/proposal.md', '# Existing\n');
    const existing = await detectMigrationNeed({ rootDir, changeId: 'add-oauth' });
    assert.equal(existing.migrationSuggested, false);
    assert.equal(existing.changeExists, true);
  });
});

describe('writeMigrationReport', () => {
  it('supports dry-run and real report writes', async () => {
    const rootDir = await createTempRoot();

    const dryRun = await writeMigrationReport('add-oauth', {
      changeId: 'add-oauth',
      validation: { status: 'SKIPPED' },
      sourceArtifacts: ['.ai-factory/plans/add-oauth.md'],
      generatedOpenSpecArtifacts: ['openspec/changes/add-oauth/proposal.md'],
      runtimeArtifacts: ['.ai-factory/state/add-oauth/legacy-context.md']
    }, {
      rootDir,
      dryRun: true
    });

    assert.equal(dryRun.ok, true);
    assert.equal(dryRun.dryRun, true);
    assert.equal(await pathExists(rootDir, '.ai-factory/state/add-oauth/migration-report.md'), false);

    const written = await writeMigrationReport('add-oauth', {
      changeId: 'add-oauth',
      validation: { status: 'PASS' },
      sourceArtifacts: ['.ai-factory/plans/add-oauth.md'],
      generatedOpenSpecArtifacts: ['openspec/changes/add-oauth/proposal.md'],
      runtimeArtifacts: ['.ai-factory/state/add-oauth/legacy-context.md']
    }, {
      rootDir
    });

    assert.equal(written.path, '.ai-factory/state/add-oauth/migration-report.md');
    assert.match(await readFixture(rootDir, '.ai-factory/state/add-oauth/migration-report.md'), /OpenSpec validation: PASS/);
  });
});

describe('migrate-legacy-plans CLI', () => {
  it('lists and dry-runs legacy plans with JSON output', async () => {
    const rootDir = await createTempRoot();
    await copyLegacyFixture(rootDir);

    const list = await execFileAsync(process.execPath, [CLI_PATH, '--list'], {
      cwd: rootDir,
      windowsHide: true
    });
    assert.match(list.stdout, /add-oauth/);

    const dryRun = await execFileAsync(process.execPath, [CLI_PATH, 'add-oauth', '--dry-run', '--json'], {
      cwd: rootDir,
      windowsHide: true
    });
    const parsed = JSON.parse(dryRun.stdout);
    assert.equal(parsed.dryRun, true);
    assert.equal(parsed.changeId, 'add-oauth');
    assert.ok(parsed.operations.some((operation) => operation.target === 'openspec/changes/add-oauth/proposal.md'));
    assert.equal(JSON.stringify(parsed).includes('Add OAuth Authentication'), false);
    assert.equal(await pathExists(rootDir, 'openspec/changes/add-oauth/proposal.md'), false);
  });

  it('returns exit code 2 for invalid arguments', async () => {
    const rootDir = await createTempRoot();
    await copyLegacyFixture(rootDir);

    await assert.rejects(
      () => execFileAsync(process.execPath, [CLI_PATH, 'add-oauth', '--on-collision', 'unsafe'], {
        cwd: rootDir,
        windowsHide: true
      }),
      (err) => {
        assert.equal(err.code, 2);
        assert.match(err.stderr, /Invalid --on-collision value/);
        return true;
      }
    );
  });

  it('uses recorded source for list and all while an explicit source takes precedence', async () => {
    const rootDir = await createTempRoot();
    await writeLegacyPlanSourceState('recorded/plans', {
      rootDir,
      timestamp: '2026-08-14T00:00:00.000Z',
      reason: 'migration-declined'
    });
    await writeFixture(rootDir, 'recorded/plans/recorded.md', '# Recorded\n');
    await writeFixture(rootDir, 'explicit/plans/explicit.md', '# Explicit\n');
    await writeFixture(rootDir, '.ai-factory/plans/default-decoy.md', '# Default decoy\n');
    await writeFixture(rootDir, 'openspec/changes/canonical-decoy/proposal.md', '# Canonical decoy\n');

    const listed = await execFileAsync(process.execPath, [CLI_PATH, '--list', '--json'], {
      cwd: rootDir,
      windowsHide: true
    });
    const listedJson = JSON.parse(listed.stdout);
    assert.equal(listedJson.legacyPlanSourceRoot, 'recorded/plans');
    assert.deepEqual(listedJson.plans.map((plan) => plan.id), ['recorded']);

    const recorded = await execFileAsync(process.execPath, [CLI_PATH, '--all', '--dry-run', '--json'], {
      cwd: rootDir,
      windowsHide: true
    });
    assert.deepEqual(JSON.parse(recorded.stdout).wouldMigrate, ['recorded']);

    const explicit = await execFileAsync(process.execPath, [
      CLI_PATH,
      '--all',
      '--legacy-source',
      'explicit/plans',
      '--dry-run',
      '--json'
    ], {
      cwd: rootDir,
      windowsHide: true
    });
    assert.deepEqual(JSON.parse(explicit.stdout).wouldMigrate, ['explicit']);
    assert.equal(await pathExists(rootDir, 'openspec/changes/recorded/proposal.md'), false);
    assert.equal(await pathExists(rootDir, 'openspec/changes/explicit/proposal.md'), false);
    assert.equal(await pathExists(rootDir, '.ai-factory/plans/default-decoy.md'), true);
    assert.equal(await pathExists(rootDir, 'openspec/changes/canonical-decoy/proposal.md'), true);
  });

  it('prints collision recovery hints when all migration targets already exist', async () => {
    const rootDir = await createTempRoot();
    await writeFixture(rootDir, '.ai-factory/plans/alpha.md', '# Alpha\n');
    await writeFixture(rootDir, '.ai-factory/plans/beta.md', '# Beta\n');
    await writeFixture(rootDir, 'openspec/changes/alpha/proposal.md', '# Existing Alpha\n');
    await writeFixture(rootDir, 'openspec/changes/beta/proposal.md', '# Existing Beta\n');

    await assert.rejects(
      () => execFileAsync(process.execPath, [CLI_PATH, '--all'], {
        cwd: rootDir,
        windowsHide: true
      }),
      (err) => {
        assert.equal(err.code, 1);
        assert.match(err.stdout, /Status: FAILED/);
        assert.match(err.stdout, /target-exists/);
        assert.match(err.stdout, /Preview a safe merge: ai-factory aifhub-migrate-legacy-plans --all --on-collision merge-safe --dry-run/);
        assert.match(err.stdout, /Apply a safe merge: ai-factory aifhub-migrate-legacy-plans --all --on-collision merge-safe/);
        assert.match(err.stdout, /Create separate migrated targets: ai-factory aifhub-migrate-legacy-plans --all --on-collision suffix/);
        return true;
      }
    );
  });
});
