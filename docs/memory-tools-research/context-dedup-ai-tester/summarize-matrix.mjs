#!/usr/bin/env node
// Summarize the latest complete issue #133 matrix without persisting model prose.
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const ARMS = ['baseline', 'aifhub', 'sqz'];
const PAYLOAD_CLASSES = ['firstRead', 'exactRepeat', 'changed', 'protected', 'freshSession'];

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--runs') result.runs = argv[++index];
    else if (argv[index] === '--output') result.output = argv[++index];
    else if (argv[index] === '--since') result.since = argv[++index];
  }
  return result;
}

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const resolved = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(resolved));
    else if (entry.isFile() && entry.name.endsWith('.json')) files.push(resolved);
  }
  return files;
}

export function classify(name) {
  const arm = ARMS.find((candidate) => name.endsWith(`-${candidate}`));
  if (!arm) return null;
  return {
    arm,
    caseId: name.replace(/^context-dedup-/u, '').replace(new RegExp(`-${arm}$`, 'u'), '')
  };
}

export function metrics(trace) {
  const rows = [];
  const pattern = /\[dedup-metric\] arm=(\w+) phase=(\w+) decision=([\w-]+) inputBytes=(\d+) outputBytes=(\d+) savedBytes=(\d+)/gu;
  for (const turn of trace.turns ?? []) {
    for (const call of turn.toolCalls ?? []) {
      const content = typeof call.resultContent === 'string'
        ? call.resultContent
        : JSON.stringify(call.resultContent ?? '');
      for (const match of content.matchAll(pattern)) {
        const inputBytes = Number(match[4]);
        const outputBytes = Number(match[5]);
        rows.push({
          arm: match[1],
          phase: match[2],
          decision: match[3] === 'compressed' && inputBytes === outputBytes
            ? 'full'
            : match[3],
          inputBytes,
          outputBytes
        });
      }
    }
  }
  return rows
    .filter((row) => row.phase === 'read')
    .map((row, readIndex) => ({ ...row, readIndex }));
}

export function classifyPayload(caseId, readIndex) {
  if (caseId === 'protected-openspec') return 'protected';
  if (caseId === 'fresh-session-preseeded-cache') return 'freshSession';
  if (caseId === 'changed-source' && readIndex > 0) return 'changed';
  if (caseId === 'repeat-source' && readIndex > 0) return 'exactRepeat';
  return 'firstRead';
}

function summarizeMeasurements(measurements) {
  const inputBytes = measurements.reduce((sum, row) => sum + row.inputBytes, 0);
  const outputBytes = measurements.reduce((sum, row) => sum + row.outputBytes, 0);
  const savedBytes = Math.max(0, inputBytes - outputBytes);
  return {
    reads: measurements.length,
    inputBytes,
    outputBytes,
    savedBytes,
    savedPercent: inputBytes === 0
      ? 0
      : Number(((savedBytes / inputBytes) * 100).toFixed(2))
  };
}

function payloadByClass(measurements) {
  return Object.fromEntries(PAYLOAD_CLASSES.map((className) => [
    className,
    summarizeMeasurements(measurements.filter((measurement) => measurement.payloadClass === className))
  ]));
}

export function buildRows(entries, runsRoot) {
  return entries.map(({ file, trace, identity }) => {
    const measurements = metrics(trace).map((measurement) => ({
      ...measurement,
      payloadClass: classifyPayload(identity.caseId, measurement.readIndex)
    }));
    const totals = summarizeMeasurements(measurements);
    return {
      scenario: trace.scenario.name,
      caseId: identity.caseId,
      arm: identity.arm,
      pass: trace.scoring?.overallPass === true,
      failedAssertions: (trace.assertions ?? [])
        .filter((assertion) => assertion.pass === false)
        .map((assertion) => assertion.id),
      decisions: measurements.map((row) => row.decision),
      inputBytes: totals.inputBytes,
      outputBytes: totals.outputBytes,
      savedBytes: totals.savedBytes,
      inputTokens: trace.cost?.inputTokens ?? null,
      outputTokens: trace.cost?.outputTokens ?? null,
      payloadByClass: payloadByClass(measurements),
      measurements,
      trace: path.relative(runsRoot, file).split(path.sep).join('/')
    };
  }).sort((left, right) =>
    left.caseId.localeCompare(right.caseId) || left.arm.localeCompare(right.arm));
}

function buildAggregate(rows, arm) {
  const armRows = rows.filter((row) => row.arm === arm);
  const measurements = armRows.flatMap((row) => row.measurements);
  const totals = summarizeMeasurements(measurements);
  return {
    arm,
    passed: armRows.filter((row) => row.pass).length,
    total: armRows.length,
    inputBytes: totals.inputBytes,
    outputBytes: totals.outputBytes,
    savedBytes: totals.savedBytes,
    savedPercent: totals.savedPercent,
    payloadByClass: payloadByClass(measurements)
  };
}

function comparisonForArm(rows, arm, options = {}) {
  const selectedRows = rows.filter((row) => row.arm === arm);
  const measurements = [];
  let adjustedFailedRows = 0;

  for (const row of selectedRows) {
    if (options.caseId && row.caseId !== options.caseId) continue;
    for (const measurement of row.measurements) {
      if (options.classes && !options.classes.includes(measurement.payloadClass)) continue;
      let outputBytes = measurement.outputBytes;
      if (options.zeroFailedSavings && !row.pass) {
        outputBytes = measurement.inputBytes;
        adjustedFailedRows += 1;
      }
      if (options.forceFullClasses?.includes(measurement.payloadClass)) {
        outputBytes = measurement.inputBytes;
      }
      if (options.forceFirstReadFull && measurement.payloadClass === 'firstRead') {
        outputBytes = measurement.inputBytes;
      }
      measurements.push({ ...measurement, outputBytes });
    }
  }

  return {
    arm,
    ...summarizeMeasurements(measurements),
    adjustedFailedRows
  };
}

export function buildSummary(rows) {
  const aggregates = ARMS.map((arm) => buildAggregate(rows, arm));
  const comparisonViews = {
    exactRepeatOnly: ARMS.map((arm) => comparisonForArm(rows, arm, {
      classes: ['exactRepeat']
    })),
    fairTwoReadExactRepeat: ARMS.map((arm) => comparisonForArm(rows, arm, {
      caseId: 'repeat-source',
      classes: ['firstRead', 'exactRepeat'],
      forceFirstReadFull: true
    })),
    correctnessAdjusted: ARMS.map((arm) => comparisonForArm(rows, arm, {
      zeroFailedSavings: true
    })),
    policyAndCorrectnessAdjusted: ARMS.map((arm) => comparisonForArm(rows, arm, {
      zeroFailedSavings: true,
      forceFullClasses: ['protected']
    }))
  };
  return { aggregates, comparisonViews };
}

export async function writeSummaryExclusive(filePath, summary) {
  await writeFile(filePath, `${JSON.stringify(summary, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx'
  });
}

export async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.runs || !args.output) {
    throw new Error('Usage: summarize-matrix.mjs --runs <ai-tester-runs> --output <directory> [--since <ISO>]');
  }
  const runsRoot = path.resolve(args.runs);
  const since = args.since ? Date.parse(args.since) : 0;
  if (!Number.isFinite(since)) throw new Error('--since must be a valid ISO timestamp.');

  const latest = new Map();
  for (const file of await walk(runsRoot)) {
    const trace = JSON.parse(await readFile(file, 'utf8'));
    const name = trace?.scenario?.name;
    const identity = typeof name === 'string' ? classify(name) : null;
    const startedAt = Date.parse(trace?.runner?.startedAt ?? 0);
    if (!identity || !name.startsWith('context-dedup-') || startedAt < since) continue;
    const existing = latest.get(name);
    if (!existing || startedAt > existing.startedAt) {
      latest.set(name, { file, trace, identity, startedAt });
    }
  }
  if (latest.size !== 12) {
    throw new Error(`Expected exactly 12 latest matrix traces, found ${latest.size}. Use --since to isolate the run.`);
  }

  const rows = buildRows([...latest.values()], runsRoot);
  const { aggregates, comparisonViews } = buildSummary(rows);

  const output = path.resolve(args.output);
  await mkdir(output, { recursive: true });
  await writeSummaryExclusive(
    path.join(output, 'matrix-summary.json'),
    {
      schemaVersion: 2,
      model: 'gpt-5.6-luna',
      reasoning: 'low',
      rows,
      aggregates,
      comparisonViews
    }
  );
  process.stdout.write(`${JSON.stringify({ aggregates, comparisonViews })}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    process.stderr.write(`${error?.message ?? error}\n`);
    process.exitCode = 1;
  });
}
