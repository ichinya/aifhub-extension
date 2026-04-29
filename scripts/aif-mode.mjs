#!/usr/bin/env node
// aif-mode.mjs - CLI for AIFHub artifact mode status, switching, sync, and diagnostics
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  doctorAifMode,
  getModeStatus,
  switchToAiFactoryMode,
  switchToOpenSpecMode,
  syncArtifacts
} from './aif-artifact-sync.mjs';

const COMMANDS = new Set(['status', 'openspec', 'ai-factory', 'sync', 'doctor']);

export async function runModeCommand(argv, options = {}) {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    return {
      exitCode: 2,
      stdout: '',
      stderr: `${parsed.error}\n`
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
    timestamp: parsed.timestamp
  };
  let result;

  if (parsed.command === 'status') {
    result = await getModeStatus(runOptions);
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
    return invalid(`Usage: node scripts/aif-mode.mjs ${[...COMMANDS].join('|')} [--dry-run] [--all] [--change <id>] [--yes] [--export-openspec] [--json]`);
  }

  const result = {
    ok: true,
    command,
    dryRun: false,
    all: false,
    changeId: null,
    yes: false,
    current: false,
    exportOpenSpec: false,
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

  if (command === 'status' && (result.yes || result.exportOpenSpec || result.current)) {
    return invalid('status is read-only and does not accept --yes, --export-openspec, or --current.');
  }

  if (command === 'doctor' && (result.yes || result.exportOpenSpec || result.current || result.dryRun)) {
    return invalid('doctor is read-only and does not accept mutating options.');
  }

  return result;
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
    `Config marker: aifhub.artifactProtocol=${result.configMarker ?? 'missing'}`,
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
    ...renderDiagnostics('Warnings', result.warnings),
    ...renderDiagnostics('Errors', result.errors)
  ].join('\n');
}

function renderSummaryOperations(result) {
  const operations = [
    ...(result.config?.operations ?? []),
    ...(result.skeleton?.operations ?? []),
    ...(result.generatedRules?.files ?? []).map((file) => ({
      action: file.written === false ? 'would-write' : 'write',
      target: file.relativePath
    })),
    ...(result.export?.operations ?? []),
    ...(result.report?.operations ?? [])
  ];

  if (operations.length === 0) {
    return [];
  }

  return [
    '',
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
