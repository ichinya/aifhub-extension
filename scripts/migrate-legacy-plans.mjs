#!/usr/bin/env node
// migrate-legacy-plans.mjs - dependency-free CLI for legacy plan migration
import {
  discoverLegacyPlans,
  migrateAllLegacyPlans,
  migrateLegacyPlan
} from './legacy-plan-migration.mjs';

const COLLISION_MODES = new Set(['fail', 'merge-safe', 'suffix', 'overwrite']);

async function main(argv) {
  const parsed = parseArgs(argv);

  if (!parsed.ok) {
    writeError(parsed.error);
    return 2;
  }

  const options = {
    dryRun: parsed.dryRun,
    onCollision: parsed.onCollision
  };

  if (parsed.list) {
    const result = await discoverLegacyPlans();
    output(parsed.json, result, renderList(result));
    return result.ok ? 0 : 1;
  }

  if (parsed.all) {
    const result = await migrateAllLegacyPlans(options);
    output(parsed.json, publicResult(result), renderAll(result));
    return result.ok ? 0 : 1;
  }

  const result = await migrateLegacyPlan(parsed.planId, options);
  output(parsed.json, publicResult(result), renderMigration(result));
  return result.ok ? 0 : 1;
}

function parseArgs(argv) {
  const result = {
    ok: true,
    list: false,
    all: false,
    dryRun: false,
    json: false,
    onCollision: 'fail',
    planId: null,
    error: null
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--list') {
      result.list = true;
      continue;
    }

    if (arg === '--all') {
      result.all = true;
      continue;
    }

    if (arg === '--dry-run') {
      result.dryRun = true;
      continue;
    }

    if (arg === '--json') {
      result.json = true;
      continue;
    }

    if (arg === '--on-collision') {
      const value = argv[index + 1];
      if (value === undefined || !COLLISION_MODES.has(value)) {
        return invalid(`Invalid --on-collision value: ${value ?? '<missing>'}. Expected fail, merge-safe, suffix, or overwrite.`);
      }

      result.onCollision = value;
      index += 1;
      continue;
    }

    if (arg.startsWith('--')) {
      return invalid(`Unknown option: ${arg}.`);
    }

    if (result.planId !== null) {
      return invalid(`Unexpected extra argument: ${arg}.`);
    }

    result.planId = arg;
  }

  if (result.list && (result.all || result.planId !== null)) {
    return invalid('--list cannot be combined with --all or a plan id.');
  }

  if (!result.list && !result.all && result.planId === null) {
    return invalid('Provide a plan id, --all, or --list.');
  }

  if (result.all && result.planId !== null) {
    return invalid('--all cannot be combined with a plan id.');
  }

  return result;
}

function invalid(message) {
  return {
    ok: false,
    error: message
  };
}

function output(json, value, humanText) {
  if (json) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    return;
  }

  process.stdout.write(`${humanText}\n`);
}

function writeError(message) {
  process.stderr.write(`${message}\n`);
}

function renderList(result) {
  if (!result.ok) {
    return renderDiagnostics('Errors', result.errors);
  }

  if (result.plans.length === 0) {
    return 'No legacy plans found.';
  }

  return [
    'Legacy plans:',
    ...result.plans.map((plan) => `- ${plan.id} -> ${plan.targetChangePath}`)
  ].join('\n');
}

function renderMigration(result) {
  const lines = [
    `${result.dryRun ? 'Dry run' : 'Migration'}: ${result.planId ?? '<unknown>'}`,
    `Status: ${result.ok ? 'OK' : 'FAILED'}`,
    `Change: ${result.changeId ?? '<none>'}`,
    `Target: ${result.targetChangePath ?? '<none>'}`,
    `Validation: ${result.validation?.status ?? 'SKIPPED'}`
  ];

  if (result.reportPath) {
    lines.push(`Report: ${result.reportPath}`);
  }

  if (result.operations?.length > 0) {
    lines.push('', 'Operations:');
    for (const operation of result.operations) {
      lines.push(`- ${operation.action}: ${operation.target}`);
    }
  }

  return [
    ...lines,
    '',
    ...renderDiagnostics('Warnings', result.warnings),
    '',
    ...renderDiagnostics('Errors', result.errors),
    ...renderTargetExistsHint(result, result.planId ?? '<change-id>')
  ].join('\n');
}

function renderAll(result) {
  return [
    `${result.dryRun ? 'Dry run' : 'Migration'}: all legacy plans`,
    `Status: ${result.ok ? 'OK' : result.partial ? 'PARTIAL' : 'FAILED'}`,
    `Migrated: ${result.migrated.join(', ') || 'none'}`,
    `Failed: ${result.failed.join(', ') || 'none'}`,
    '',
    ...renderDiagnostics('Warnings', result.warnings),
    '',
    ...renderDiagnostics('Errors', result.errors),
    ...renderTargetExistsHint(result, '--all')
  ].join('\n');
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

function renderTargetExistsHint(result, subjectArgs) {
  const errors = Array.isArray(result.errors) ? result.errors : [];
  if (!errors.some((error) => error.code === 'target-exists')) {
    return [];
  }

  const command = `node scripts/migrate-legacy-plans.mjs ${subjectArgs}`;

  return [
    '',
    'Hint:',
    '- Existing OpenSpec targets were found. The default collision mode is fail.',
    `- Preview a safe merge: ${command} --on-collision merge-safe --dry-run`,
    `- Apply a safe merge: ${command} --on-collision merge-safe`,
    `- Create separate migrated targets: ${command} --on-collision suffix`
  ];
}

function publicResult(value) {
  if (Array.isArray(value)) {
    return value.map((item) => publicResult(item));
  }

  if (value === null || typeof value !== 'object') {
    return value;
  }

  const clone = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === 'content' || key === 'contents') {
      continue;
    }

    clone[key] = publicResult(child);
  }
  return clone;
}

process.exitCode = await main(process.argv.slice(2));
