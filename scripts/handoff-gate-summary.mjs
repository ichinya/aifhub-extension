#!/usr/bin/env node
// handoff-gate-summary.mjs - read-only Handoff orchestration gate summary
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  normalizeChangeId,
  resolveActiveChange as defaultResolveActiveChange
} from './active-change-resolver.mjs';
import { getLatestGateResult } from './aif-gate-result.mjs';
import { evaluateQaBinding } from './qa-bound-evidence.mjs';
import { readOpenSpecCoverageMatrix as defaultReadOpenSpecCoverageMatrix } from './openspec-coverage-matrix.mjs';
import { collectGeneratedRules as defaultCollectGeneratedRules } from './openspec-execution-context.mjs';

export const HANDOFF_GATE_SUMMARY_SCHEMA_VERSION = 1;
export const HANDOFF_GATE_STAGES = Object.freeze(['planning', 'implementing', 'review', 'done']);
export const HANDOFF_GATE_STATUSES = Object.freeze(['pass', 'warn', 'fail']);

const GENERATED_RULES_STALE_CODES = new Set([
  'missing-generated-rules',
  'stale-generated-rules',
  'missing-generated-rules-trace',
  'invalid-generated-rules-trace'
]);

const GATE_CANDIDATES = Object.freeze({
  rules: ['rules.md', 'aif-rules-check.md', 'rules-check.md', path.join('gates', 'rules.md')],
  review: ['review.md', 'aif-review.md', path.join('gates', 'review.md')],
  security: ['security.md', 'aif-security-checklist.md', path.join('gates', 'security.md')],
  verify: ['verify.md']
});

export const REQUIRED_GATES_BY_STAGE = Object.freeze({
  planning: [],
  implementing: ['verify'],
  review: ['review', 'security', 'rules', 'coverage'],
  done: ['verify', 'rules', 'coverage']
});

export function parseHandoffGateSummaryArgs(argv = []) {
  const result = {
    ok: true,
    changeId: null,
    stage: 'review',
    json: false,
    help: false,
    errors: []
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--help' || arg === '-h') {
      result.help = true;
      continue;
    }

    if (arg === '--json') {
      result.json = true;
      continue;
    }

    if (arg === '--change') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        result.errors.push('Missing value for --change.');
      } else {
        const normalized = normalizeChangeId(value);
        if (!normalized.ok) {
          result.errors.push(normalized.error.message);
        } else {
          result.changeId = normalized.changeId;
        }
        index += 1;
      }
      continue;
    }

    if (arg === '--stage') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        result.errors.push('Missing value for --stage.');
      } else if (!HANDOFF_GATE_STAGES.includes(value)) {
        result.errors.push(`Invalid --stage '${value}'. Expected one of: ${HANDOFF_GATE_STAGES.join(', ')}.`);
        index += 1;
      } else {
        result.stage = value;
        index += 1;
      }
      continue;
    }

    result.errors.push(`Unknown argument: ${arg}.`);
  }

  result.ok = result.errors.length === 0;
  return result;
}

export async function buildHandoffGateSummary(options = {}) {
  const rootDir = resolveRootDir(options);
  const stage = normalizeStage(options.stage);
  const resolveActiveChange = options.resolveActiveChange ?? defaultResolveActiveChange;
  const resolved = await resolveActiveChange({
    rootDir,
    cwd: options.cwd ?? process.cwd(),
    changeId: options.changeId,
    getCurrentBranch: options.getCurrentBranch
  });

  if (!resolved.ok) {
    return createUnresolvedSummary({
      stage,
      diagnostics: [
        ...normalizeDiagnostics(resolved.warnings, 'warning'),
        ...normalizeDiagnostics(resolved.errors, 'error')
      ]
    });
  }

  const changeId = resolved.changeId;
  const qaPath = resolved.qaPath ?? path.join(rootDir, '.ai-factory', 'qa', changeId);
  const gateResults = {};
  const gateSignals = {};
  const diagnostics = normalizeDiagnostics(resolved.warnings, 'warning');
  const evidence = {
    generatedRules: '.ai-factory/rules/generated'
  };

  for (const gate of ['rules', 'review', 'security', 'verify']) {
    const result = await readGateStatus(gate, {
      rootDir,
      qaPath,
      readFile: options.readFile ?? readFile
    });
    gateResults[gate] = result.status;
    gateSignals[gate] = result;
    if (result.evidencePath) {
      evidence[gate] = result.evidencePath;
    }
    diagnostics.push(...result.diagnostics);
  }

  const coverage = await readCoverageStatus(changeId, {
    ...options,
    rootDir,
    qaPath
  });
  gateResults.coverage = coverage.status;
  gateSignals.coverage = coverage;
  evidence.coverage = coverage.evidencePath;
  diagnostics.push(...coverage.diagnostics);

  const binding = await (options.evaluateQaManifest ?? evaluateQaBinding)({ ...options, rootDir, changeId,
    requirePublication: true, qaDir: relativePath(rootDir, qaPath), gateContents: Object.fromEntries(Object.entries(gateSignals)
      .filter(([, signal]) => typeof signal.content === 'string').map(([gate, signal]) => [gate, signal.content])) });
  if (binding.enrolled) {
    for (const gate of ['rules', 'review', 'security', 'verify']) {
      const affected = binding.state === 'blocked' || (binding.state === 'stale'
        && binding.affected_checks.some(id => binding.check_gates?.[id] === gate));
      if (affected) gateSignals[gate].issue = binding.state === 'stale' ? 'stale' : 'invalid';
    }
    diagnostics.push({ code: binding.code, severity: binding.state === 'valid' ? 'info' : 'warning',
      message: `QA binding: ${binding.state}.`, state: binding.state, affected_checks: binding.affected_checks });
  } else {
    diagnostics.push({ code: 'manifest-absent', severity: 'info', message: 'QA binding: legacy unbound.',
      state: 'valid', affected_checks: [] });
  }

  const generatedRules = await readGeneratedRulesStatus(changeId, {
    ...options,
    rootDir
  });
  diagnostics.push(...generatedRules.diagnostics);

  const routing = routeSummary({
    changeId,
    stage,
    gates: gateResults,
    signals: gateSignals,
    generatedRules: generatedRules.status
  });

  return {
    schema_version: HANDOFF_GATE_SUMMARY_SCHEMA_VERSION,
    change_id: changeId,
    stage,
    gates: gateResults,
    generatedRules: generatedRules.status,
    blocking: routing.blocking,
    next_stage: routing.nextStage,
    suggested_next: routing.suggestedNext,
    diagnostics: dedupeDiagnostics(diagnostics),
    evidence
  };
}

export function summarizeHandoffGateSummary(summary) {
  if (!summary || summary.ok === false) {
    return [
      'Handoff gate summary: ERROR',
      ...(summary?.diagnostics ?? []).map((diagnostic) => `${diagnostic.severity.toUpperCase()} [${diagnostic.code}] ${diagnostic.message}`)
    ].join('\n');
  }

  const gateText = Object.entries(summary.gates ?? {})
    .map(([gate, status]) => `${gate}=${status}`)
    .join(', ');
  const status = summary.blocking ? 'BLOCKING' : 'NON-BLOCKING';

  return [
    `Handoff gate summary: ${status}`,
    `Change: ${summary.change_id}`,
    `Stage: ${summary.stage} -> ${summary.next_stage}`,
    `Gates: ${gateText}`,
    `Generated rules: ${summary.generatedRules}`,
    `Suggested next: ${summary.suggested_next ?? 'none'}`
  ].join('\n');
}

export async function runHandoffGateSummaryCommand(argv = process.argv.slice(2), options = {}) {
  const parsed = parseHandoffGateSummaryArgs(argv);

  if (parsed.help) {
    const usage = createUsageText();
    if (parsed.json) {
      process.stdout.write(`${JSON.stringify({ ok: true, usage }, null, 2)}\n`);
    } else {
      process.stdout.write(`${usage}\n`);
    }
    return parsed.ok ? 0 : 2;
  }

  if (!parsed.ok) {
    writeCommandOutput(createCommandError(parsed.errors), parsed.json);
    return 2;
  }

  const summary = await buildHandoffGateSummary({
    ...options,
    changeId: parsed.changeId,
    stage: parsed.stage
  });

  if (summary.ok === false) {
    writeCommandOutput(summary, parsed.json);
    return 2;
  }

  writeCommandOutput(summary, parsed.json);
  return summary.blocking ? 1 : 0;
}

async function readGateStatus(gate, options) {
  const candidates = GATE_CANDIDATES[gate];
  const expectedPath = relativePath(options.rootDir, path.join(options.qaPath, candidates[0]));
  const fallbackDiagnostics = [];
  let firstExistingEvidencePath = null;

  for (const candidate of candidates) {
    const candidatePath = path.join(options.qaPath, candidate);
    const evidencePath = relativePath(options.rootDir, candidatePath);

    try {
      await access(candidatePath);
    } catch {
      continue;
    }

    firstExistingEvidencePath ??= evidencePath;

    let content;
    try {
      content = await options.readFile(candidatePath, 'utf8');
    } catch (err) {
      return {
        status: 'warn',
        issue: 'unreadable',
        evidencePath,
        diagnostics: [...fallbackDiagnostics, diagnostic({
          code: `${gate}-evidence-unreadable`,
          severity: 'warning',
          message: `${gate} gate evidence could not be read: ${evidencePath}.`,
          path: evidencePath,
          detail: err?.message ?? String(err)
        })]
      };
    }

    const latest = getLatestGateResult(content, { gate });
    if (latest === null) {
      fallbackDiagnostics.push(diagnostic({
        code: `${gate}-gate-result-missing`,
        severity: 'warning',
        message: `${gate} gate evidence has no aif-gate-result block: ${evidencePath}.`,
        path: evidencePath
      }));
      continue;
    }

    if (!latest.ok) {
      return {
        status: 'warn',
        issue: 'invalid',
        evidencePath,
        diagnostics: [
          ...fallbackDiagnostics,
          ...latest.errors.map((error) => diagnostic({
            code: `${gate}-gate-result-invalid`,
            severity: 'warning',
            message: `${gate} gate latest aif-gate-result block is invalid: ${error.message}`,
            path: evidencePath,
            detail: error.code
          }))
        ]
      };
    }

    return {
      status: latest.result.status,
      content,
      issue: null,
      evidencePath,
      diagnostics: fallbackDiagnostics
    };
  }

  if (firstExistingEvidencePath !== null) {
    return {
      status: 'warn',
      issue: 'missing',
      evidencePath: firstExistingEvidencePath,
      diagnostics: fallbackDiagnostics
    };
  }

  return {
    status: 'warn',
    issue: 'missing',
    evidencePath: expectedPath,
    diagnostics: [diagnostic({
      code: `${gate}-evidence-missing`,
      severity: 'warning',
      message: `${gate} gate evidence is missing at ${expectedPath}.`,
      path: expectedPath
    })]
  };
}

async function readCoverageStatus(changeId, options) {
  const readCoverage = options.readOpenSpecCoverageMatrix ?? defaultReadOpenSpecCoverageMatrix;
  const coverage = await readCoverage(changeId, {
    ...options,
    rootDir: options.rootDir,
    qaPath: options.qaPath
  });
  const status = normalizeCoverageStatus(coverage);
  const issue = normalizeCoverageIssue(coverage);

  return {
    status,
    issue,
    evidencePath: coverage?.relativePath ?? relativePath(options.rootDir, path.join(options.qaPath, 'coverage.json')),
    diagnostics: normalizeDiagnostics(coverage?.diagnostics ?? [], 'warning')
  };
}

async function readGeneratedRulesStatus(changeId, options) {
  const collectGeneratedRules = options.collectGeneratedRules ?? defaultCollectGeneratedRules;
  const generated = await collectGeneratedRules(changeId, {
    ...options,
    rootDir: options.rootDir
  });
  const warnings = normalizeDiagnostics(generated?.warnings ?? [], 'warning');
  const errors = normalizeDiagnostics(generated?.errors ?? [], 'error');
  const hasStaleRules = (generated?.generatedRules ?? []).some((item) => item?.exists === false || item?.stale === true);
  const hasStaleDiagnostics = [...warnings, ...errors].some((item) => GENERATED_RULES_STALE_CODES.has(item.code));
  const status = errors.length > 0 || hasStaleRules || hasStaleDiagnostics
    ? 'stale'
    : warnings.length > 0
      ? 'warn'
      : 'pass';

  return {
    status,
    diagnostics: [...warnings, ...errors]
  };
}

function normalizeCoverageStatus(coverage) {
  const status = coverage?.coverage?.status;

  if (status === 'fail') {
    return 'fail';
  }

  if (coverage?.exists && coverage.ok && !coverage.stale && HANDOFF_GATE_STATUSES.includes(status)) {
    return status;
  }

  return 'warn';
}

function normalizeCoverageIssue(coverage) {
  if (coverage?.exists === false) {
    return 'missing';
  }

  if (coverage?.exists === true && coverage.ok === false) {
    return 'invalid';
  }

  if (coverage?.stale === true) {
    return 'stale';
  }

  return null;
}

function routeSummary({ changeId, stage, gates, signals, generatedRules }) {
  const gateFailure = Object.entries(gates).find(([, status]) => status === 'fail');

  if (generatedRules === 'stale') {
    return {
      blocking: true,
      nextStage: stage,
      suggestedNext: `/aif-mode sync --change ${changeId}`
    };
  }

  const requiredEvidenceBlocker = findRequiredEvidenceBlocker(changeId, stage, signals);
  if (requiredEvidenceBlocker) {
    return {
      blocking: true,
      nextStage: stage,
      suggestedNext: requiredEvidenceBlocker.suggestedNext
    };
  }

  if (gateFailure) {
    return {
      blocking: true,
      nextStage: 'implementing',
      suggestedNext: `/aif-fix ${changeId}`
    };
  }

  if (stage === 'review') {
    return {
      blocking: false,
      nextStage: 'done',
      suggestedNext: `/aif-done ${changeId}`
    };
  }

  const mapping = {
    planning: { nextStage: 'implementing', suggestedNext: `/aif-implement ${changeId}` },
    implementing: { nextStage: 'review', suggestedNext: `/aif-verify ${changeId}` },
    done: { nextStage: 'done', suggestedNext: `/aif-done ${changeId}` }
  };

  return {
    blocking: false,
    nextStage: mapping[stage].nextStage,
    suggestedNext: mapping[stage].suggestedNext
  };
}

function findRequiredEvidenceBlocker(changeId, stage, signals = {}) {
  const requiredGates = REQUIRED_GATES_BY_STAGE[stage] ?? [];
  for (const gate of requiredGates) {
    const issue = signals[gate]?.issue ?? null;
    if (issue === null) {
      continue;
    }

    if (['missing', 'unreadable', 'invalid', 'stale'].includes(issue)) {
      return {
        gate,
        issue,
        suggestedNext: suggestedNextForRequiredGate(gate, changeId)
      };
    }
  }

  return null;
}

function suggestedNextForRequiredGate(gate, changeId) {
  const mapping = {
    review: (changeId) => `/aif-review ${changeId}`,
    security: (changeId) => `/aif-security-checklist ${changeId}`,
    rules: () => '/aif-rules-check',
    coverage: (changeId) => `/aif-verify ${changeId}`,
    verify: (changeId) => `/aif-verify ${changeId}`
  };

  return mapping[gate]?.(changeId) ?? `/aif-verify ${changeId}`;
}

function createUnresolvedSummary({ stage, diagnostics }) {
  return {
    ok: false,
    schema_version: HANDOFF_GATE_SUMMARY_SCHEMA_VERSION,
    change_id: null,
    stage,
    diagnostics: dedupeDiagnostics(diagnostics)
  };
}

function createCommandError(errors) {
  return {
    ok: false,
    schema_version: HANDOFF_GATE_SUMMARY_SCHEMA_VERSION,
    change_id: null,
    diagnostics: errors.map((message) => diagnostic({
      code: 'invalid-arguments',
      severity: 'error',
      message
    })),
    errors
  };
}

function writeCommandOutput(result, json) {
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  if (result.ok === false) {
    process.stderr.write(`${summarizeHandoffGateSummary(result)}\n`);
    return;
  }

  process.stdout.write(`${summarizeHandoffGateSummary(result)}\n`);
}

function createUsageText() {
  return [
    'Usage: node scripts/handoff-gate-summary.mjs [--change <id>] [--stage planning|implementing|review|done] [--json]',
    'Builds a read-only Handoff orchestration gate summary.'
  ].join('\n');
}

function normalizeStage(value) {
  const stage = value ?? 'review';
  if (!HANDOFF_GATE_STAGES.includes(stage)) {
    throw new Error(`Invalid Handoff stage: ${stage}`);
  }
  return stage;
}

function normalizeDiagnostics(items, defaultSeverity) {
  return items.map((item) => {
    if (typeof item === 'string') {
      return diagnostic({
        code: 'diagnostic',
        severity: defaultSeverity,
        message: item
      });
    }

    return diagnostic({
      code: item.code ?? 'diagnostic',
      severity: item.severity ?? defaultSeverity,
      message: item.message ?? String(item),
      path: item.path,
      detail: item.detail
    });
  });
}

function diagnostic({ code, severity, message, path: diagnosticPath, detail }) {
  return {
    code,
    severity,
    message,
    ...(diagnosticPath ? { path: toPosix(diagnosticPath) } : {}),
    ...(detail ? { detail } : {})
  };
}

function dedupeDiagnostics(items) {
  const seen = new Set();
  const result = [];

  for (const item of items) {
    const key = JSON.stringify(item);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(item);
  }

  return result;
}

function resolveRootDir(options) {
  return path.resolve(options.rootDir ?? process.cwd());
}

function relativePath(rootDir, targetPath) {
  return toPosix(path.relative(rootDir, targetPath));
}

function toPosix(value) {
  return String(value).replaceAll('\\', '/');
}

if (process.argv[1] && import.meta.url === pathToFileURL(fileURLToPath(import.meta.url)).href && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runHandoffGateSummaryCommand();
}
