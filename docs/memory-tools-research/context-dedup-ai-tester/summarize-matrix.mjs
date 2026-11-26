#!/usr/bin/env node
// Summarize the latest complete issue #133 matrix without persisting model prose.
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { snapshotScenarioName } from './generate-matrix.mjs';

const ARMS = ['baseline', 'aifhub', 'sqz'];
const PAYLOAD_CLASSES = ['firstRead', 'exactRepeat', 'changed', 'protected', 'freshSession'];

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--runs') result.runs = argv[++index];
    else if (argv[index] === '--output') result.output = argv[++index];
    else if (argv[index] === '--manifest') result.manifest = argv[++index];
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

const metricPattern = /\[dedup-metric\] arm=(\w+) phase=(\w+) decision=([\w-]+) inputBytes=(\d+) outputBytes=(\d+) savedBytes=(-?\d+)/gu;

const expectedProtocol = {
  'repeat-source': ['src/repeat-target.ts', 'src/repeat-target.ts'],
  'changed-source': ['src/change-target.txt', 'mutate', 'src/change-target.txt'],
  'protected-openspec': ['openspec/specs/orders/spec.md', 'openspec/specs/orders/spec.md'],
  'fresh-session-preseeded-cache': ['src/session-target.txt'],
  'short-config': ['src/policy.txt']
};

function matchesCommand(command, expected) {
  if (command === expected) return true;
  if (typeof command !== 'string') return false;
  // Native Codex records the outer shell invocation in command_execution.
  const wrapped = command.match(/^(?:"(?:[A-Za-z]:\\[^"]*\\)?(?:powershell|pwsh)\.exe"|powershell(?:\.exe)?|pwsh(?:\.exe)?) -Command (["'])(.*?)\1$/i)
    ?? command.match(/^(?:\/(?:usr\/)?bin\/(?:ba)?sh|(?:ba)?sh) -lc (["'])(.*?)\1$/);
  return wrapped?.[2] === expected;
}

function followsProtocol(trace, { caseId, arm }) {
  const steps = Object.hasOwn(expectedProtocol, caseId) && expectedProtocol[caseId];
  if (!steps || !Array.isArray(trace.turns) || !trace.turns.every(t => Array.isArray(t.toolCalls))) return false;
  const calls = trace.turns.flatMap(turn => turn.toolCalls);
  if (calls.length !== steps.length) return false;
  return steps.every((step, i) => {
    const call = calls[i];
    if (call?.name !== 'Bash' || call.resultIsError !== false || typeof call.resultContent !== 'string') return false;
    if (step === 'mutate') {
      return matchesCommand(call.input?.command, 'node project/scripts/mutate-change.mjs')
        && call.resultContent.trim() === 'fixture_mutated';
    }
    if (!matchesCommand(call.input?.command, 'node project/scripts/read-context.mjs ' + step)) return false;
    const markers = [...call.resultContent.matchAll(metricPattern)];
    return markers.length === 1 && markers[0][1] === arm && markers[0][2] === 'read'
      && Number(markers[0][4]) - Number(markers[0][5]) === Number(markers[0][6]);
  });
}

export function metrics(trace, arm) {
  const rows = [];

  for (const turn of trace.turns ?? []) {
    for (const call of turn.toolCalls ?? []) {
      const content = typeof call.resultContent === 'string'
        ? call.resultContent
        : JSON.stringify(call.resultContent ?? '');
      for (const match of content.matchAll(metricPattern)) {
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
    .filter((row) => row.phase === 'read' && (!arm || row.arm === arm))
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
  const savedBytes = inputBytes - outputBytes;
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
    const protocolVerified = identity.snapshot == null ? null : followsProtocol(trace, identity);
    const measurements = metrics(trace, identity.arm).map((measurement) => ({
      ...measurement,
      payloadClass: protocolVerified === false ? null : classifyPayload(identity.caseId, measurement.readIndex)
    }));
    const totals = summarizeMeasurements(measurements);
    const qualityPass = trace.scoring?.overallPass ?? null;
    const runner = trace.runner ?? {};
    const exitCode = Number.isInteger(runner.exitCode) ? runner.exitCode : null;
    const ended = exitCode === 0 || (exitCode === null && runner.stoppedReason === 'end_turn' && runner.hitMaxTurns !== true);
    const errorExit = (exitCode !== null && exitCode !== 0) || (trace.errors?.length > 0);
    const status = errorExit ? 'ERROR' : qualityPass === false ? 'FAIL' : ended && qualityPass === true ? 'PASS' : 'INCOMPLETE';
    const cost = trace.cost ?? {};
    const measurement = v => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
    const toolCalls = trace.toolCallSummary?.total ?? (Array.isArray(trace.turns) &&
      trace.turns.every(t => Array.isArray(t.toolCalls)) ? trace.turns.reduce((n,t) => n + t.toolCalls.length, 0) : null);
    return {
      ...identity,
      attempt: identity.attempt ?? runner.attempt ?? 1, sourceRunId: trace.runId ?? null, exitCode, qualityPass, status,
      protocolVerified,
      scenario: trace.scenario.name,
      caseId: identity.caseId,
      arm: identity.arm,
      pass: status === 'PASS',
      failedAssertions: (trace.assertions ?? [])
        .filter((assertion) => assertion.pass === false)
        .map((assertion) => assertion.id),
      decisions: measurements.map((row) => row.decision),
      inputBytes: measurements.length ? totals.inputBytes : null,
      outputBytes: measurements.length ? totals.outputBytes : null,
      savedBytes: measurements.length ? totals.savedBytes : null,
      inputTokens: measurement(cost.inputTokens), outputTokens: measurement(cost.outputTokens), totalTokens: measurement(cost.totalTokens),
      cacheReadTokens: measurement(cost.cacheReadTokens), cacheWriteTokens: measurement(cost.cacheCreationTokens),
      reportedCostUsd: measurement(cost.totalUsd), costUsd: measurement(cost.billedUsd),
      estimatedCostUsd: measurement(cost.usdEstimate), costSource: cost.source ?? null,
      latencyMs: measurement(runner.durationMs), toolCalls: measurement(toolCalls),
      readCalls: measurements.length || null,
      repeatReads: measurements.length && protocolVerified !== false ? measurements.filter(m => m.payloadClass === 'exactRepeat' || (m.payloadClass === 'protected' && m.readIndex > 0)).length : null,
      model: runner.model ?? null, reasoning: runner.reasoning ?? null,
      payloadByClass: measurements.length && protocolVerified !== false ? payloadByClass(measurements) : null,
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

// Keep attempts, cell completion and metric availability separate. A failed attempt
// can have a perfectly valid bill, and an accepted triple can lack one metric.
const taskMetrics = ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens',
  'latencyMs', 'readCalls', 'repeatReads', 'toolCalls', 'inputBytes', 'outputBytes', 'savedBytes',
  'costUsd', 'reportedCostUsd', 'estimatedCostUsd'];

export function cellKey(row) {
  return JSON.stringify([row.snapshot, row.platform, row.profile, row.project ?? '', row.caseId, row.repeat, row.arm]);
}

function statistics(values) {
  values.sort((a, b) => a - b);
  const n = values.length, mid = Math.floor(n / 2);
  return { count: n, median: n ? (values[mid] + values[Math.floor((n - 1) / 2)]) / 2 : null,
    min: n ? values[0] : null, max: n ? values[n - 1] : null };
}

function total(rows, field) {
  return rows.length && rows.every(r => Number.isFinite(r[field]))
    ? rows.reduce((sum, r) => sum + r[field], 0) : null;
}

const partialUsageFields = {
  inputTokens: 'input', outputTokens: 'output', totalTokens: 'totalTokens', cacheReadTokens: 'cacheRead',
  cacheWriteTokens: 'cacheWrite', costUsd: 'billedUsd', reportedCostUsd: 'cost', estimatedCostUsd: 'estimatedUsd'
};

function knownSubtotal(rows, field) {
  const amounts = rows.map(row => row[field] ?? row.usagePartial?.[partialUsageFields[field]]?.known).filter(Number.isFinite);
  return amounts.length ? amounts.reduce((sum, amount) => sum + amount, 0) : null;
}

export function pairedComparisons(rows, expectedCells, arms = ARMS) {
  const observed = new Map();
  for (const row of rows) {
    const key = cellKey(row);
    if (!observed.has(key)) observed.set(key, []);
    observed.get(key).push(row);
  }
  const groups = new Map();
  const planned = new Set();
  for (const e of expectedCells) {
    if (!arms.includes(e.arm) || !Number.isSafeInteger(e.repeat) || e.repeat < 1 ||
        ![e.snapshot, e.platform, e.profile, e.caseId].every(v => typeof v === 'string' && v.length)) {
      throw new Error('Invalid planned cell identity.');
    }
    const key = cellKey(e);
    if (planned.has(key)) throw new Error('Duplicate planned cell identity.');
    planned.add(key);
    const {snapshot, platform, profile, project, caseId} = e;
    const groupKey = JSON.stringify([snapshot, platform, profile, project ?? '', caseId]);
    if (!groups.has(groupKey)) groups.set(groupKey, {snapshot, platform, profile, project, caseId, triples: new Map()});
    const group = groups.get(groupKey);
    if (!group.triples.has(e.repeat)) group.triples.set(e.repeat, new Map());
    group.triples.get(e.repeat).set(e.arm, observed.get(key) ?? []);
  }
  return [...groups.values()].map(({triples, ...identity}) => {
    const result = {...identity, expectedTriples: triples.size, successfulTriples: 0, comparableTriples: 0, missingCells: 0,
      duplicateCells: 0, failedCells: 0, incompleteCells: 0, skippedCells: 0, retries: 0, cells: [], excludedTriples: [], comparisons: {}};
    const failed = [];
    const samples = new Map(arms.slice(1).map(arm => [arm, Object.fromEntries(taskMetrics.map(field => [field, []]))]));
    for (const [repeat, triple] of triples) {
      const success = new Map();
      for (const arm of arms) {
        const attempts = (triple.get(arm) ?? []).slice().sort((a, b) => a.attempt - b.attempt);
        const numbers = attempts.map(r => r.attempt);
        const ids = attempts.map(r => r.sourceRunId).filter(Boolean);
        let status;
        if (!attempts.length) { status = 'MISSING'; result.missingCells++; }
        else if (new Set(numbers).size !== numbers.length || new Set(ids).size !== ids.length) { status = 'DUPLICATE'; result.duplicateCells++; }
        else {
          const last = attempts.at(-1);
          const contiguous = numbers.every((n, i) => n === i + 1);
          const retriedFailures = attempts.slice(0, -1).every(r => r.status === 'FAIL' || r.status === 'ERROR');
          status = contiguous && retriedFailures ? last.status : 'INCOMPLETE';
          result.retries += attempts.length - 1;
          failed.push(...attempts.filter(r => r.status === 'FAIL' || r.status === 'ERROR'));
          if (status === 'PASS') success.set(arm, attempts);
          else if (status === 'FAIL' || status === 'ERROR') result.failedCells++;
          else if (status === 'MISSING') result.missingCells++;
          else if (status === 'NOT_RUN') result.skippedCells++;
          else result.incompleteCells++;
        }
        const payloadByClass = Object.fromEntries(PAYLOAD_CLASSES.map(name => {
          const buckets = attempts.map(r => r.payloadByClass?.[name]).filter(Boolean);
          const complete = buckets.length === attempts.length && status !== 'DUPLICATE';
          return [name, {observedAttempts: buckets.length, reads: complete ? total(buckets, 'reads') : null,
            inputBytes: complete ? total(buckets, 'inputBytes') : null, outputBytes: complete ? total(buckets, 'outputBytes') : null,
            savedBytes: complete ? total(buckets, 'savedBytes') : null}];
        }));
        result.cells.push({repeat, arm, status, attempts: attempts.length, payloadByClass,
          totals: Object.fromEntries(taskMetrics.map(field => [field, status === 'DUPLICATE' ? null : total(attempts, field)]))});
      }
      if (success.size !== arms.length) continue;
      const successfulRows = [...success.values()].flat();
      const roots = new Set(successfulRows.map(r => r.initialTreeSha256 ?? null));
      if (roots.size > 1 || (roots.has(null) && successfulRows.some(r => r.requireInitialTree))) {
        result.excludedTriples.push({repeat, reason:'initial tree mismatch or unavailable'});
        continue;
      }
      result.successfulTriples++;
      if ([...success.values()].some(attempts => attempts.at(-1).protocolVerified === false)) {
        result.excludedTriples.push({ repeat, reason: 'required tool protocol unconfirmed' });
        continue;
      }
      result.comparableTriples++;
      for (const [arm, metrics] of samples) {
        for (const field of taskMetrics) {
          const baseline = total(success.get(arms[0]), field), variant = total(success.get(arm), field);
          if (baseline !== null && variant !== null) metrics[field].push(baseline - variant);
        }
      }
    }
    result.failedAttemptInputTokens = failed.length ? total(failed, 'inputTokens') : 0;
    result.failedAttempts = failed.length;
    result.failedAttemptMetrics = Object.fromEntries(taskMetrics.map(field => {
      const known = failed.filter(r => Number.isFinite(r[field]));
      return [field, {knownAttempts: known.length, attempts: failed.length,
        knownSubtotal: knownSubtotal(failed, field), total: failed.length ? total(failed, field) : 0}];
    }));
    for (const [arm, metrics] of samples) {
      result.comparisons[arm] = Object.fromEntries(Object.entries(metrics).map(([field, vals]) =>
        [field, {...statistics(vals), denominator: triples.size}]));
    }
    return result;
  });
}

export function buildSummary(rows, options = {}) {
  if (options.expectedCells) return { pairedTrials: pairedComparisons(rows, options.expectedCells) };
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

  if (args.manifest) {
    const manifest = JSON.parse(await readFile(args.manifest, 'utf8'));
    const planned = new Map(manifest.expectedCells.map(cell => [cellKey(cell), cell]));
    const scenarios = new Map(manifest.expectedCells.filter(c => c.scenario).map(c => [c.scenario, c]));
    if (scenarios.size !== manifest.expectedCells.filter(c => c.scenario).length) throw new Error('Ambiguous manifest scenario names.');
    const bindings = new Map();
    for (const a of manifest.attempts ?? []) {
      if (typeof a.file !== 'string' || a.file.includes('\\') || path.posix.isAbsolute(a.file) ||
          a.file.split('/').some(p => !p || p === '..' || p === '.') || !planned.has(cellKey(a)) || !Number.isSafeInteger(a.attempt) || a.attempt < 1 || bindings.has(a.file)) {
        throw new Error('Invalid manifest attempt binding.');
      }
      bindings.set(a.file, a);
    }
    const unboundAttempts = [];
    function unbound(trace, reason) {
      const cost = trace.cost ?? {};
      unboundAttempts.push({reason, inputTokens: cost.inputTokens ?? null, outputTokens: cost.outputTokens ?? null,
        billedUsd: cost.billedUsd ?? null, estimatedUsd: cost.usdEstimate ?? null});
    }
    const entries = [];
    const found = new Set();
    for (const file of await walk(runsRoot)) {
      const trace = JSON.parse(await readFile(file, 'utf8'));
      const relative = path.relative(runsRoot, file).split(path.sep).join('/');
      const name = trace.scenario?.name;
      const bound = bindings.get(relative);
      const cell = bound ? planned.get(cellKey(bound)) : scenarios.get(name);
      if (!name && !bound) continue;
      if (!bound && (bindings.size || !cell)) { unbound(trace, 'no manifest binding'); continue; }
      if (!bound && name !== snapshotScenarioName(cell)) {
        unbound(trace, 'legacy scenario requires an explicit attempt binding');
        continue;
      }
      if (name !== (cell.scenario ?? 'context-dedup-' + cell.caseId + '-' + cell.arm) ||
          (trace.snapshot != null && trace.snapshot !== cell.snapshot) ||
          (trace.platform != null && trace.platform !== cell.platform) ||
          (bound && trace.runner?.attempt != null && trace.runner.attempt !== bound.attempt) ||
          (manifest.profile?.model && trace.runner?.model && trace.runner.model !== manifest.profile.model) ||
          (manifest.profile?.reasoning && trace.runner?.reasoning && trace.runner.reasoning !== manifest.profile.reasoning)) {
        unbound(trace, 'trace conflicts with manifest');
        continue;
      }
      if (args.since && !(Date.parse(trace.runner?.startedAt) >= since)) continue;
      found.add(relative);
      const {snapshot, platform, profile, caseId, repeat, arm, providerCache} = cell;
      entries.push({file, trace, identity: {snapshot, platform, profile, caseId, repeat, arm, providerCache,
        attempt: bound?.attempt ?? trace.runner?.attempt ?? 1}});
    }
    const rows = buildRows(entries, runsRoot);
    for (const [file, bound] of bindings) {
      if (!found.has(file)) rows.push({...bound, status:'MISSING', pass:false});
    }
    const summary = {schemaVersion: 3, profile: manifest.profile ?? null, unboundTraceCount: unboundAttempts.length, unboundAttempts, rows,
      pairedTrials: pairedComparisons(rows, manifest.expectedCells)};
    await mkdir(args.output, {recursive:true});
    await writeSummaryExclusive(path.join(args.output, 'matrix-summary.json'), summary);
    process.stdout.write(JSON.stringify({attempts: entries.length, unboundTraceCount: unboundAttempts.length, groups: summary.pairedTrials.length}) + '\n');
    return;
  }
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
      model: [...new Set(rows.map(r => r.model))].length === 1 ? rows[0]?.model : null,
      reasoning: [...new Set(rows.map(r => r.reasoning))].length === 1 ? rows[0]?.reasoning : null,
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
