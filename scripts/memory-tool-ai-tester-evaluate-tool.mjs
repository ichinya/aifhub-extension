#!/usr/bin/env node
// memory-tool-ai-tester-evaluate-tool.mjs - one-shot tool/project ai-tester evaluation
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { runMemoryToolAiTesterMatrix } from './memory-tool-ai-tester-matrix.mjs';
import { runMemoryToolAiTesterMissing } from './memory-tool-ai-tester-run-missing.mjs';
import { runMemoryToolAiTesterResultsReport } from './memory-tool-ai-tester-results-report.mjs';
import { runMemoryToolAiTesterPromoteMetadata } from './memory-tool-ai-tester-promote-metadata.mjs';

export const AI_TESTER_TOOL_EVALUATION_SCHEMA = 'aifhub.memory_tools.ai_tester_tool_evaluation.v1';

const DEFAULT_CATALOG = path.join('docs', 'memory-tools-research', 'ai-tester-scenarios.yaml');
const DEFAULT_METADATA = path.join('docs', 'memory-tools-research', 'recommendation-metadata.yaml');
const DEFAULT_STATE_DIR = path.join('.ai-factory', 'state', 'ai-tester-tool-evaluations');
const DEFAULT_ACCEPTED_RUN_CLASS = 'accepted_evidence';

export async function runMemoryToolAiTesterToolEvaluation(args = [], options = {}) {
  const parsed = parseArgs(args);
  if (parsed.help) return emitText(getCliUsage(), 0, options);
  if (!parsed.tool) throw new Error('Missing required --tool <tool-id>.');
  if (parsed.roots.length === 0) throw new Error('Missing required --root <project-dir>.');
  if (parsed.dryRun && parsed.apply) throw new Error('--dry-run and --apply cannot be used together.');

  const cwd = path.resolve(options.cwd ?? process.cwd());
  const outDir = path.resolve(cwd, parsed.out ?? path.join(
    DEFAULT_STATE_DIR,
    `${safeId(parsed.tool)}-${timestampSlug(new Date())}`
  ));
  const scenarioPrefix = parsed.scenarioPrefix || `${safeId(parsed.tool)}-${timestampSlug(new Date())}`;
  const runId = parsed.runId || scenarioPrefix;
  const runsDir = path.resolve(cwd, parsed.runsDir ?? 'runs');
  const runners = {
    matrix: options.runMatrix ?? runMemoryToolAiTesterMatrix,
    missing: options.runMissing ?? runMemoryToolAiTesterMissing,
    report: options.runReport ?? runMemoryToolAiTesterResultsReport,
    promote: options.runPromote ?? runMemoryToolAiTesterPromoteMetadata
  };

  const matrixArgs = buildMatrixArgs(parsed, {
    outDir,
    scenarioPrefix
  });
  const matrixResult = await runners.matrix(matrixArgs, {
    cwd,
    stdout: [],
    stderr: [],
    exit: false
  });
  assertStepSuccess('matrix', matrixResult);

  let runResult = null;
  if (!parsed.dryRun && !parsed.noRun) {
    const missingArgs = buildMissingArgs(parsed, { outDir, runsDir });
    runResult = await runners.missing(missingArgs, {
      cwd,
      stdout: [],
      stderr: [],
      exit: false,
      runCommand: options.runCommand
    });
    assertStepSuccess('run-missing', runResult);
  }

  let reportResult = null;
  if (!parsed.dryRun) {
    const reportArgs = buildReportArgs(parsed, { outDir, runsDir });
    reportResult = await runners.report(reportArgs, {
      cwd,
      stdout: [],
      stderr: [],
      exit: false
    });
    assertStepSuccess('results-report', reportResult);
  }

  let promotionResult = null;
  if (!parsed.dryRun && !parsed.noPromote) {
    const promoteArgs = buildPromoteArgs(parsed, {
      outDir,
      runId
    });
    promotionResult = await runners.promote(promoteArgs, {
      cwd,
      stdout: [],
      stderr: [],
      exit: false
    });
    assertStepSuccess('promote-metadata', promotionResult);
  }

  const body = {
    schema: AI_TESTER_TOOL_EVALUATION_SCHEMA,
    tool_id: parsed.tool,
    roots: parsed.roots.map((root) => publicPath(cwd, path.resolve(cwd, root))),
    output_dir: publicPath(cwd, outDir),
    scenario_prefix: scenarioPrefix,
    run_id: runId,
    mode: {
      dry_run: parsed.dryRun,
      ran_ai_tester: Boolean(runResult),
      promoted_metadata: Boolean(parsed.apply),
      wrote_promotion_proposal: Boolean(promotionResult && !parsed.promotionDryRun)
    },
    paths: {
      matrix_summary: parsed.dryRun ? null : publicPath(cwd, path.join(outDir, 'matrix-summary.json')),
      report_json: parsed.dryRun ? null : publicPath(cwd, path.join(outDir, 'ai-tester-token-matrices.json')),
      report_markdown: parsed.dryRun ? null : publicPath(cwd, path.join(outDir, 'ai-tester-token-matrices.md')),
      promotion_json: promotionResult?.body?.output?.proposal_json ?? null,
      promotion_markdown: promotionResult?.body?.output?.proposal_markdown ?? null,
      applied_metadata: promotionResult?.body?.output?.applied_metadata ?? null
    },
    summary: {
      matrix_cases: matrixResult.body?.case_count ?? matrixResult.body?.cases?.length ?? null,
      executed_rows: reportResult?.body?.summary?.executed_rows ?? null,
      not_run_rows: reportResult?.body?.summary?.not_run_rows ?? null,
      promotion_entries: promotionResult?.body?.summary?.promoted_entries ?? null,
      promotion_skipped_items: promotionResult?.body?.summary?.skipped_items ?? null,
      run_attempted: runResult?.body?.attempted ?? null,
      run_failed: runResult?.body?.failed ?? null
    },
    steps: {
      matrix: summarizeStep(matrixResult),
      run_missing: summarizeStep(runResult),
      report: summarizeStep(reportResult),
      promotion: summarizeStep(promotionResult)
    },
    notes: buildNotes({ parsed, matrixResult, runResult, reportResult, promotionResult })
  };

  return parsed.json ? emit(body, 0, options) : emitText(renderTextSummary(body), 0, options);
}

function buildMatrixArgs(parsed, { outDir, scenarioPrefix }) {
  const args = [
    '--out',
    outDir,
    '--metadata',
    parsed.metadata ?? DEFAULT_METADATA,
    '--tool',
    parsed.tool,
    '--max-profiles',
    String(parsed.maxProfiles),
    '--scenario-prefix',
    scenarioPrefix,
    '--json'
  ];
  for (const root of parsed.roots) args.push('--roots', root);
  if (parsed.scenarioCatalog !== false) args.push('--scenario-catalog', parsed.scenarioCatalog ?? DEFAULT_CATALOG);
  for (const id of parsed.scenarioIds) args.push('--scenario-id', id);
  for (const runClass of parsed.runClasses.length > 0 ? parsed.runClasses : [DEFAULT_ACCEPTED_RUN_CLASS]) {
    args.push('--run-class', runClass);
  }
  for (const skill of parsed.skills) args.push('--skill', skill);
  for (const task of parsed.tasks) args.push('--task', task);
  for (const label of parsed.labels) args.push('--label', label);
  for (const tool of parsed.preinitializeTools) args.push('--preinitialize-tool', tool);
  if (parsed.preinitialize) args.push('--preinitialize-tool', parsed.tool);
  if (parsed.selectorMode) args.push('--selector-mode', parsed.selectorMode);
  if (parsed.model) args.push('--model', parsed.model);
  if (parsed.profileIdMode) args.push('--profile-id-mode', parsed.profileIdMode);
  if (parsed.dryRun) args.push('--dry-run');
  return args;
}

function buildMissingArgs(parsed, { outDir, runsDir }) {
  const args = [
    '--matrix-dir',
    outDir,
    '--json',
    '--no-report-copy'
  ];
  for (const skill of parsed.skills) args.push('--skill', skill);
  args.push('--runs-dir', runsDir);
  if (Number.isFinite(parsed.maxRuns)) args.push('--max-runs', String(parsed.maxRuns));
  if (Number.isFinite(parsed.timeoutMs)) args.push('--timeout-ms', String(parsed.timeoutMs));
  if (Number.isFinite(parsed.deadlineMinutes)) args.push('--deadline-minutes', String(parsed.deadlineMinutes));
  if (parsed.stopOnFail) args.push('--stop-on-fail');
  return args;
}

function buildReportArgs(parsed, { outDir, runsDir }) {
  const args = [
    '--matrix-dir',
    outDir,
    '--out',
    outDir,
    '--json'
  ];
  args.push('--runs-dir', runsDir);
  if (parsed.copyMarkdown) args.push('--copy-markdown', parsed.copyMarkdown);
  return args;
}

function buildPromoteArgs(parsed, { outDir, runId }) {
  const args = [
    '--report',
    path.join(outDir, 'ai-tester-token-matrices.json'),
    '--metadata',
    parsed.metadata ?? DEFAULT_METADATA,
    '--out',
    path.join(outDir, 'promotion'),
    '--run-id',
    runId,
    '--json'
  ];
  if (parsed.scenarioCatalog !== false) args.push('--scenario-catalog', parsed.scenarioCatalog ?? DEFAULT_CATALOG);
  if (parsed.promotionDryRun) args.push('--dry-run');
  if (parsed.apply) args.push('--apply');
  return args;
}

function buildNotes({ parsed, matrixResult, runResult, reportResult, promotionResult }) {
  const notes = [];
  if (parsed.dryRun) {
    notes.push('Dry run: generated only public matrix JSON; no fixtures, scenarios, ai-tester runs, reports, or metadata proposal files were written.');
  } else if (parsed.noRun) {
    notes.push('No-run mode: scenario files and reports were generated, but ai-tester execution was skipped.');
  }
  if (!parsed.apply) {
    notes.push('Metadata is not modified by default. Use --apply to append promoted entries to recommendation-metadata.yaml.');
  }
  const caseCount = matrixResult?.body?.case_count ?? matrixResult?.body?.cases?.length;
  if (caseCount === 0) {
    notes.push('No matrix cases matched the selected tool, catalog filters, and project labels.');
  }
  if (runResult?.body?.failed > 0) {
    notes.push('One or more ai-tester runs failed; inspect run-missing logs under the output directory.');
  }
  if (reportResult?.body?.summary?.not_run_rows > 0) {
    notes.push('Some matrix rows are still NOT_RUN; promotion may produce no entries until matching pairs complete.');
  }
  if (promotionResult?.body?.summary?.promoted_entries === 0) {
    notes.push('Promotion proposal contains no metadata-ready entries.');
  }
  return notes;
}

function summarizeStep(result) {
  if (!result) return null;
  return {
    exit_code: result.exitCode,
    schema: result.body?.schema ?? null
  };
}

function assertStepSuccess(step, result) {
  if (!result || result.exitCode !== 0) {
    throw new Error(`${step} failed with exit code ${result?.exitCode ?? 'unknown'}.`);
  }
}

function parseArgs(args) {
  const parsed = {
    help: false,
    tool: null,
    roots: [],
    out: null,
    metadata: null,
    scenarioCatalog: null,
    scenarioIds: [],
    runClasses: [],
    skills: [],
    tasks: [],
    labels: [],
    maxProfiles: 1,
    maxRuns: null,
    timeoutMs: null,
    deadlineMinutes: null,
    runsDir: null,
    copyMarkdown: null,
    preinitializeTools: [],
    preinitialize: false,
    selectorMode: null,
    model: null,
    profileIdMode: null,
    scenarioPrefix: null,
    runId: null,
    dryRun: false,
    noRun: false,
    noPromote: false,
    promotionDryRun: false,
    apply: false,
    stopOnFail: false,
    json: false
  };

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === '--help' || token === '-h') parsed.help = true;
    else if (token === '--tool') parsed.tool = args[++index];
    else if (token === '--root' || token === '--roots') parsed.roots.push(args[++index]);
    else if (token === '--out') parsed.out = args[++index];
    else if (token === '--metadata') parsed.metadata = args[++index];
    else if (token === '--scenario-catalog') parsed.scenarioCatalog = args[++index];
    else if (token === '--no-scenario-catalog') parsed.scenarioCatalog = false;
    else if (token === '--scenario-id') parsed.scenarioIds.push(args[++index]);
    else if (token === '--run-class') parsed.runClasses.push(args[++index]);
    else if (token === '--skill') parsed.skills.push(args[++index]);
    else if (token === '--task') parsed.tasks.push(args[++index]);
    else if (token === '--label') parsed.labels.push(args[++index]);
    else if (token === '--max-profiles') parsed.maxProfiles = Number(args[++index]);
    else if (token === '--max-runs') parsed.maxRuns = Number(args[++index]);
    else if (token === '--timeout-ms') parsed.timeoutMs = Number(args[++index]);
    else if (token === '--deadline-minutes') parsed.deadlineMinutes = Number(args[++index]);
    else if (token === '--runs-dir') parsed.runsDir = args[++index];
    else if (token === '--copy-markdown') parsed.copyMarkdown = args[++index];
    else if (token === '--preinitialize-tool') parsed.preinitializeTools.push(args[++index]);
    else if (token === '--preinitialize') parsed.preinitialize = true;
    else if (token === '--selector-mode') parsed.selectorMode = args[++index];
    else if (token === '--model') parsed.model = args[++index];
    else if (token === '--profile-id-mode') parsed.profileIdMode = normalizeProfileIdMode(args[++index]);
    else if (token === '--scenario-prefix') parsed.scenarioPrefix = args[++index];
    else if (token === '--run-id') parsed.runId = args[++index];
    else if (token === '--dry-run') parsed.dryRun = true;
    else if (token === '--no-run') parsed.noRun = true;
    else if (token === '--no-promote') parsed.noPromote = true;
    else if (token === '--promotion-dry-run') parsed.promotionDryRun = true;
    else if (token === '--apply') parsed.apply = true;
    else if (token === '--stop-on-fail') parsed.stopOnFail = true;
    else if (token === '--json') parsed.json = true;
    else throw new Error(`Unknown argument: ${token}`);
  }
  return parsed;
}

function getCliUsage() {
  return [
    'Usage: node scripts/memory-tool-ai-tester-evaluate-tool.mjs --tool <id> --root <project-dir> [options]',
    '',
    'Runs the memory-tool ai-tester pipeline for one candidate tool and one project root:',
    'matrix generation -> optional ai-tester execution -> results report -> metadata promotion proposal.',
    '',
    'Required:',
    '  --tool <id>               Candidate tool id, for example codegraph, graphify, context7.',
    '  --root <dir>              Project directory or project collection root. Repeatable.',
    '',
    'Options:',
    '  --out <dir>               Output run directory. Default: .ai-factory/state/ai-tester-tool-evaluations/<tool>-<timestamp>.',
    '  --scenario-catalog <file> Scenario catalog YAML. Default: docs/memory-tools-research/ai-tester-scenarios.yaml.',
    '  --no-scenario-catalog     Use metadata-driven matrix generation instead of the authored catalog.',
    '  --run-class <class>       Catalog run class filter. Default: accepted_evidence. Repeatable.',
    '  --scenario-id <id>        Limit to a catalog scenario id. Repeatable.',
    '  --skill <aif-skill>       Limit to a skill. Repeatable.',
    '  --task <task-signal>      Limit to a task signal. Repeatable.',
    '  --label <label>           Require a project label. Repeatable.',
    '  --max-profiles <n>        Limit discovered profiles. Default: 1.',
    '  --preinitialize           Preinitialize the selected tool before model turn.',
    '  --preinitialize-tool <id> Preinitialize a specific tool. Repeatable.',
    '  --profile-id-mode ordinal|path-hash',
    '                             Public project id mode for matrix rows and fixture folders.',
    '  --max-runs <n>            Run at most n missing ai-tester scenarios.',
    '  --timeout-ms <n>          Per-scenario ai-tester timeout.',
    '  --deadline-minutes <n>    Stop starting new scenarios after n minutes.',
    '  --runs-dir <dir>          ai-tester runs directory.',
    '  --copy-markdown <file>    Copy Markdown report to a durable docs file.',
    '  --no-run                  Generate matrix/report/promotion from existing traces only.',
    '  --no-promote              Skip metadata promotion proposal.',
    '  --promotion-dry-run       Compute promotion JSON without writing proposal files.',
    '  --apply                   Append promoted entries to recommendation-metadata.yaml.',
    '  --dry-run                 Generate public matrix JSON only; no scenarios/runs/reports/promotion files.',
    '  --json                    Emit JSON summary.',
    '  -h, --help                Show help.'
  ].join('\n');
}

function normalizeProfileIdMode(value) {
  return value === 'path-hash' ? 'path-hash' : 'ordinal';
}

function renderTextSummary(body) {
  const lines = [
    `Tool: ${body.tool_id}`,
    `Output: ${body.output_dir}`,
    `Matrix cases: ${formatNullable(body.summary.matrix_cases)}`,
    `Executed rows: ${formatNullable(body.summary.executed_rows)}`,
    `NOT_RUN rows: ${formatNullable(body.summary.not_run_rows)}`,
    `Promotion entries: ${formatNullable(body.summary.promotion_entries)}`,
    `Report: ${body.paths.report_markdown ?? '(not written)'}`,
    `Promotion proposal: ${body.paths.promotion_json ?? '(not written)'}`,
    `Applied metadata: ${body.paths.applied_metadata ?? '(not applied)'}`
  ];
  if (body.notes.length > 0) {
    lines.push('', 'Notes:');
    for (const note of body.notes) lines.push(`- ${note}`);
  }
  return lines.join('\n');
}

function formatNullable(value) {
  return value === null || value === undefined ? 'n/a' : String(value);
}

function timestampSlug(date) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z').toLowerCase();
}

function safeId(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function publicPath(cwd, targetPath) {
  const relative = path.relative(cwd, path.resolve(cwd, targetPath));
  if (!relative.startsWith('..') && !path.isAbsolute(relative)) return toPosix(relative);
  return path.basename(path.resolve(targetPath));
}

function toPosix(value) {
  return String(value).replaceAll(path.sep, '/');
}

function emit(body, exitCode, options = {}) {
  const output = `${JSON.stringify(body, null, 2)}\n`;
  if (Array.isArray(options.stdout)) {
    options.stdout.push(output);
  } else if (options.stdout && typeof options.stdout.write === 'function') {
    options.stdout.write(output);
  } else {
    process.stdout.write(output);
  }
  if (options.exit !== false) process.exitCode = exitCode;
  return { exitCode, body };
}

function emitText(body, exitCode, options = {}) {
  const output = `${body}\n`;
  if (Array.isArray(options.stdout)) {
    options.stdout.push(output);
  } else if (options.stdout && typeof options.stdout.write === 'function') {
    options.stdout.write(output);
  } else {
    process.stdout.write(output);
  }
  if (options.exit !== false) process.exitCode = exitCode;
  return { exitCode, body };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runMemoryToolAiTesterToolEvaluation(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error?.stack ?? error}\n`);
    process.exitCode = 1;
  });
}
