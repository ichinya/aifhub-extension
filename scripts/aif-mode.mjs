#!/usr/bin/env node
// aif-mode.mjs - CLI for AIFHub artifact mode status, switching, sync, and diagnostics
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  doctorAifMode,
  getModeStatus,
  initializeEnabledTools,
  switchToAiFactoryMode,
  switchToOpenSpecMode,
  syncArtifacts
} from './aif-artifact-sync.mjs';
import { migrateConfig } from './aifhub-config-migration.mjs';

const COMMANDS = new Set(['status', 'init', 'openspec', 'ai-factory', 'sync', 'doctor', 'migrate-config']);

export async function runModeCommand(argv, options = {}) {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    return {
      exitCode: 2,
      stdout: '',
      stderr: `${parsed.error}\n`
    };
  }

  if (parsed.command === 'migrate-config') {
    const result = await migrateConfig({ ...options, revision: parsed.revision });
    return {
      exitCode: result.ok ? 0 : 1,
      stdout: (parsed.json ? JSON.stringify(result, null, 2) : renderMigration(result)) + '\n',
      stderr: ''
    };
  }

  const runOptions = {
    ...options,
    dryRun: parsed.dryRun,
    all: parsed.all,
    changeId: parsed.changeId,
    yes: parsed.yes,
    overwrite: parsed.yes,
    current: parsed.current,
    exportOpenSpec: parsed.exportOpenSpec,
    legacyPlanSourceRoot: parsed.legacyPlanSourceRoot,
    timestamp: parsed.timestamp
  };
  let result;

  if (parsed.command === 'status') {
    result = await getModeStatus(runOptions);
  } else if (parsed.command === 'init') {
    result = await initializeEnabledTools(runOptions);
  } else if (parsed.command === 'openspec') {
    result = await switchToOpenSpecMode(runOptions);
  } else if (parsed.command === 'ai-factory') {
    result = await switchToAiFactoryMode(runOptions);
  } else if (parsed.command === 'sync') {
    result = await syncArtifacts(runOptions);
  } else if (parsed.command === 'doctor') {
    result = await doctorAifMode(runOptions);
  }

  const stdout = parsed.json
    ? `${JSON.stringify(publicResult(result), null, 2)}\n`
    : `${renderHuman(parsed.command, result)}\n`;

  return {
    exitCode: result.ok ? 0 : 1,
    stdout,
    stderr: ''
  };
}

export function parseArgs(argv) {
  const args = Array.from(argv ?? []);
  const command = args.shift();

  if (!COMMANDS.has(command)) {
    return invalid(`Usage: node scripts/aif-mode.mjs ${[...COMMANDS].join('|')} [--dry-run] [--all] [--change <id>] [--legacy-source <dir>] [--yes] [--export-openspec] [--json]`);
  }

  if (command === 'migrate-config') return parseMigrationArgs(args);

  const result = {
    ok: true,
    command,
    dryRun: false,
    all: false,
    changeId: null,
    yes: false,
    current: false,
    exportOpenSpec: false,
    legacyPlanSourceRoot: null,
    json: false,
    timestamp: undefined
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === '--dry-run') {
      result.dryRun = true;
      continue;
    }

    if (arg === '--all') {
      result.all = true;
      continue;
    }

    if (arg === '--yes') {
      result.yes = true;
      continue;
    }

    if (arg === '--current') {
      result.current = true;
      continue;
    }

    if (arg === '--export-openspec') {
      result.exportOpenSpec = true;
      continue;
    }

    if (arg === '--json') {
      result.json = true;
      continue;
    }

    if (arg === '--change') {
      const value = args[index + 1];
      if (value === undefined || value.startsWith('--')) {
        return invalid('Missing value for --change.');
      }

      result.changeId = value;
      index += 1;
      continue;
    }

    if (arg === '--legacy-source') {
      const value = args[index + 1];
      if (value === undefined || value.startsWith('--')) {
        return invalid('Missing value for --legacy-source.');
      }

      result.legacyPlanSourceRoot = value;
      index += 1;
      continue;
    }

    if (arg === '--timestamp') {
      const value = args[index + 1];
      if (value === undefined || value.startsWith('--')) {
        return invalid('Missing value for --timestamp.');
      }

      result.timestamp = value;
      index += 1;
      continue;
    }

    return invalid(`Unknown option: ${arg}.`);
  }

  if (result.all && result.changeId !== null) {
    return invalid('--all cannot be combined with --change.');
  }

  if (command === 'init' && (result.yes || result.exportOpenSpec || result.current || result.all
    || result.changeId !== null || result.legacyPlanSourceRoot !== null || result.timestamp !== undefined)) {
    return invalid('init only accepts --dry-run and --json.');
  }

  if (command === 'status' && (result.yes || result.exportOpenSpec || result.current)) {
    return invalid('status is read-only and does not accept --yes, --export-openspec, or --current.');
  }

  if (command === 'doctor' && (result.yes || result.exportOpenSpec || result.current || result.dryRun)) {
    return invalid('doctor is read-only and does not accept mutating options.');
  }

  return result;
}

function parseMigrationArgs(args) {
  const parsed = { ok: true, command: 'migrate-config', json: false, revision: undefined };
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--json' && !parsed.json) {
      parsed.json = true;
    } else if (args[index] === '--apply' && parsed.revision === undefined) {
      const revision = args[index + 1];
      if (!/^[a-f0-9]{64}$/.test(revision ?? '')) return invalid('--apply requires a valid preview revision.');
      parsed.revision = revision;
      index += 1;
    } else {
      return invalid('migrate-config accepts only --apply <preview-revision> and --json.');
    }
  }
  return parsed;
}

function renderMigration(result) {
  const lines = [result.migration + ': ' + result.status + ' (' + result.code + ')'];
  if (result.changed_keys) lines.push('Changed keys: ' + result.changed_keys.join(', '));
  if (result.paths) lines.push('Paths: ' + result.paths.plans + ', ' + result.paths.specs);
  if (result.revision_sha256) lines.push('Revision: ' + result.revision_sha256);
  if (result.code === 'stale-preview') lines.push('Run ai-factory aifhub-mode migrate-config for a fresh preview.');
  return lines.join('\n');
}

export function renderHuman(command, result) {
  if (command === 'status') {
    return renderStatus(result);
  }

  if (command === 'doctor') {
    return renderDoctor(result);
  }

  return renderAction(command, result);
}

function renderStatus(result) {
  return [
    `Current mode: ${result.mode}`,
    `Tools: openspec=${result.tools.openspec}, hlv=${result.tools.hlv}, lekalo=${result.tools.lekalo}`,
    `OpenSpec CLI: ${result.openspecCli.state}`,
    `OpenSpec changes: ${result.openSpecChanges.length}`,
    `Legacy plans: ${result.legacyPlans.length}`,
    `Generated rules: ${result.generatedRules.state}`,
    `Active change: ${renderActiveChange(result.activeChange)}`,
    ...renderDiagnostics('Warnings', result.warnings),
    ...renderDiagnostics('Errors', result.errors)
  ].join('\n');
}

function renderDoctor(result) {
  return [
    `Doctor: ${result.ok ? 'PASS' : 'FAIL'}`,
    `Current mode: ${result.mode}`,
    '',
    ...result.diagnostics.map((item) => `- ${item.level.toUpperCase()} ${item.code}: ${item.message}`)
  ].join('\n');
}

function renderAction(command, result) {
  return [
    `Command: ${command}`,
    `Status: ${result.ok ? 'OK' : 'FAILED'}`,
    `Mode: ${result.mode ?? 'unknown'}`,
    `Dry run: ${result.dryRun ? 'yes' : 'no'}`,
    ...(result.report?.path ? [`Report: ${result.report.path}`] : []),
    ...renderSummaryOperations(result),
    ...renderConfigKeySummary(result.config?.configKeys),
    ...renderDiagnostics('Warnings', result.warnings),
    ...renderDiagnostics('Errors', result.errors)
  ].join('\n');
}

function renderConfigKeySummary(configKeys) {
  if (configKeys === undefined) return [];
  return [
    '',
    `Config changed key paths: ${configKeys.changedKeyCount}`,
    ...configKeys.changedKeyPaths.map((keyPath) => `- changed: ${keyPath}`),
    `Config preserved key paths: ${configKeys.preservedKeyCount}`,
    ...configKeys.preservedKeyPaths.map((keyPath) => `- preserved: ${keyPath}`),
    ...(configKeys.truncated ? ['- config key path inventory truncated'] : [])
  ];
}

function renderSummaryOperations(result) {
  const generatedOperations = Array.isArray(result.generatedRules?.operations)
    ? result.generatedRules.operations
    : (result.generatedRules?.files ?? []).map((file) => ({
      action: file.written === false ? 'would-write' : 'write',
      target: file.relativePath
    }));
  const operations = [
    ...(result.operations ?? []),
    ...(result.initialization?.operations ?? []),
    ...(result.config?.operations ?? []),
    ...(result.skeleton?.operations ?? []),
    ...generatedOperations,
    ...(result.export?.operations ?? []),
    ...(result.report?.operations ?? [])
  ];

  if (operations.length === 0) {
    return [];
  }

  return [
    '',
    ...(result.generatedRules ? [
      `Generated rules operations: ${result.generatedRules.operation_count ?? result.generatedRules.operationCount ?? generatedOperations.length}`,
      `Generated rules operations truncated: ${(result.generatedRules.operations_truncated ?? result.generatedRules.operationsTruncated) ? 'yes' : 'no'}`
    ] : []),
    'Operations:',
    ...operations.map((operation) => `- ${operation.action}: ${operation.target ?? operation.relativePath}`)
  ];
}

function renderActiveChange(activeChange) {
  if (activeChange.state === 'resolved') {
    return activeChange.changeId;
  }

  return activeChange.state;
}

function renderDiagnostics(label, diagnostics) {
  const items = Array.isArray(diagnostics) ? diagnostics : [];
  if (items.length === 0) {
    return [];
  }

  return [
    '',
    `${label}:`,
    ...items.map((item) => `- ${item.code ?? 'diagnostic'}: ${item.message ?? JSON.stringify(item)}`)
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
    if (key === 'content' || key === 'raw') {
      continue;
    }

    clone[key] = publicResult(child);
  }
  return clone;
}

function invalid(error) {
  return {
    ok: false,
    error
  };
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  const result = await runModeCommand(process.argv.slice(2));
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}
