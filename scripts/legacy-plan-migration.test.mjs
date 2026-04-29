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
  detectMigrationNeed,
  discoverLegacyPlans,
  mapLegacyPlanToOpenSpecArtifacts,
  migrateAllLegacyPlans,
  migrateLegacyPlan,
  normalizeLegacyPlanId,
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
      discoverLegacyPlans,
      migrateLegacyPlan,
      migrateAllLegacyPlans,
      mapLegacyPlanToOpenSpecArtifacts,
      writeMigrationReport,
      detectMigrationNeed,
      normalizeLegacyPlanId
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

    assert.deepEqual(result, {
      ok: true,
      plans: [],
      warnings: [],
      errors: []
    });
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

  it('migrates all legacy plans in sorted order and reports partial failures', async () => {
    const rootDir = await createTempRoot();
    await writeFixture(rootDir, '.ai-factory/plans/alpha.md', '# Alpha\n');
    await writeFixture(rootDir, '.ai-factory/plans/beta.md', '# Beta\n');
    await writeFixture(rootDir, 'openspec/changes/beta/proposal.md', '# Existing\n');

    const result = await migrateAllLegacyPlans({
      rootDir,
      detectOpenSpec: async () => missingCliDetection()
    });

    assert.equal(result.ok, false);
    assert.equal(result.partial, true);
    assert.deepEqual(result.migrated, ['alpha']);
    assert.deepEqual(result.failed, ['beta']);
    assert.equal(await pathExists(rootDir, 'openspec/changes/alpha/proposal.md'), true);
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
      'node scripts/migrate-legacy-plans.mjs add-oauth --dry-run',
      'node scripts/migrate-legacy-plans.mjs add-oauth'
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
});
