#!/usr/bin/env node
// summarize.mjs - aggregates run-matrix results into a markdown report.
//
// Usage: node summarize.mjs [--out DIR]... [--title TEXT]
// Reads <out>/results/*.json for every --out and prints a per-cell table plus
// per-project/arm aggregates across all repetitions found.
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { cellKey, pairedComparisons } from "../../docs/memory-tools-research/context-dedup-ai-tester/summarize-matrix.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const result = { out: [], title: "Pi SQZ context-dedup matrix" };
  // argv is already sliced to flags-only (process.argv.slice(2)).
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--out") result.out.push(path.resolve(argv[++i]));
    else if (argv[i] === "--json") result.json = true;
    else if (argv[i] === "--title") result.title = argv[++i];
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  if (result.out.length === 0) result.out.push(path.join(SCRIPT_DIR, "out"));
  return result;
}

function outcome(r) {
  if (r.skipped) return 'NOT_RUN';
  if (r.error || r.pi?.timedOut || r.pi?.signal || (Number.isInteger(r.pi?.exitCode) && r.pi.exitCode !== 0)) return 'ERROR';
  if (r.quality?.pass === false) return 'FAIL';
  return r.pi?.exitCode === 0 && r.quality?.pass === true ? 'PASS' : 'INCOMPLETE';
}

function profileLabel(id, model) {
  return [id, model?.provider, model?.model, model?.thinking].map(v => v ?? 'unknown').join(' / ');
}

function taskRow(r, identity) {
  const u = r.usage ?? {}, m = r.readMetrics ?? {};
  const numeric = value => Number.isFinite(value) && value >= 0 ? value : null;
  const cost = u.costAvailable === false ? null : numeric(u.cost);
  const elapsed = Date.parse(r.pi?.finishedAt) - Date.parse(r.pi?.startedAt);
  return {...identity, attempt: r.attempt ?? 1, runId: r.runId,
    status: outcome(r), qualityPass: r.quality?.pass ?? null, exitCode: r.pi?.exitCode ?? null,
    errorTurns: numeric(r.errorTurns),
    usageUnavailable: u.unavailable ?? null, usagePartial: u.partial ?? null,
    initialTreeSha256: r.initialTreeSha256 ?? null, requireInitialTree: Boolean(r.snapshot),
    turns: numeric(r.turns), inputTokens: numeric(u.input), outputTokens: numeric(u.output), totalTokens: numeric(u.totalTokens),
    cacheReadTokens: numeric(u.cacheRead), cacheWriteTokens: numeric(u.cacheWrite),
    reportedCostUsd: cost, costUsd: numeric(u.billedUsd), estimatedCostUsd: numeric(u.estimatedUsd),
    costSource: u.costSource ?? (cost === null ? null : 'Pi session usage.cost.total'),
    latencyMs: numeric(r.latencyMs) ?? numeric(elapsed),
    readCalls: numeric(m.readCalls), repeatReads: numeric(m.repeatReads), toolCalls: numeric(r.toolCalls),
    inputBytes: numeric(m.observedBytes), outputBytes: numeric(m.servedBytes),
    savedBytes: Number.isFinite(m.observedBytes) && Number.isFinite(m.servedBytes) ? m.observedBytes - m.servedBytes : null,
    payloadByClass: m.payloadByClass ?? null, warnings: numeric(m.warnedReads),
    sessionId: r.sessionId ?? null, limitation: r.readMetricsUnavailable ?? r.skipped ?? null };
}

const arms = ['off', 'aifhub', 'sqz'];
async function collect(directories) {
  const rows = [], expected = new Map(), inferredPlans = [], unboundAttempts = [];
  for (const [index, dir] of directories.entries()) {
    let manifest;
    try { manifest = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const byRun = new Map();
    const attempts = new Map();
    const matched = new Set();
    if (manifest) {
      const seen = new Set();
      for (const e of manifest.expectedCells) {
        const identity = {...e, profile:profileLabel(e.profile, manifest.profile)};
        const key = cellKey(identity);
        if (byRun.has(e.runId) || seen.has(key)) throw new Error('Duplicate planned Pi cell.');
        byRun.set(e.runId, identity);
        seen.add(key);
        expected.set(key, identity);
      }
      for (const binding of manifest.attempts ?? []) {
        if (typeof binding.file !== 'string' || path.basename(binding.file) !== binding.file ||
            !Number.isSafeInteger(binding.attempt) || binding.attempt < 1 || attempts.has(binding.file) ||
            !byRun.has(binding.cellRunId ?? binding.runId)) throw new Error('Invalid Pi attempt binding.');
        attempts.set(binding.file, binding);
      }
    } else inferredPlans.push(index + 1);

    const results = path.join(dir, 'results');
    let names;
    try { names = await readdir(results); } catch (error) {
      if (error.code !== 'ENOENT' || !manifest) throw error;
      names = [];
    }
    const files = names.filter(f => f.endsWith('.json')).sort();
    for (const file of files) {
      const r = JSON.parse(await readFile(path.join(results,file), 'utf8'));
      const identity = {project:r.project, caseId:r.task, repeat:r.repeat ?? 1, arm:r.arm,
        snapshot:r.snapshot ?? 'legacy-input-' + (index + 1), platform:r.platform ?? 'unknown',
        profile:profileLabel(r.profile, r.model)};
      const row = taskRow(r, identity);
      if (manifest) {
        const binding = attempts.get(file);
        const plan = byRun.get(binding?.cellRunId ?? r.runId);
        if (!plan || cellKey(plan) !== cellKey(identity) || (attempts.size && !binding) ||
            (binding && (binding.runId !== r.runId || (r.attempt != null && r.attempt !== binding.attempt)))) {
          unboundAttempts.push({...row, limitation:'result conflicts with manifest'});
          continue;
        }
        if (binding) { row.attempt = binding.attempt; matched.add(file); }
      } else {
        for (const arm of arms) {
          const cell = {...identity, arm};
          expected.set(cellKey(cell),cell);
        }
      }
      rows.push(row);
    }
    for (const [file, binding] of attempts) {
      if (!matched.has(file)) rows.push({...byRun.get(binding.cellRunId ?? binding.runId), attempt: binding.attempt, status:'MISSING'});
    }
  }
  return {rows, unboundAttempts, inferredPlans, pairedTrials:pairedComparisons(rows, [...expected.values()], arms)};
}

const fmt = v => v == null ? 'n/a' : String(v).replaceAll('|','\\|').replace(/[\r\n]+/g, ' ');
function table(lines, headings, rows) {
  lines.push('| ' + headings.join(' | ') + ' |', '|' + headings.map(() => '---').join('|') + '|');
  for (const values of rows) lines.push('| ' + values.map(fmt).join(' | ') + ' |');
  lines.push('');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const summary = await collect(options.out);
  if (options.json) { process.stdout.write(JSON.stringify(summary, null, 2) + '\n'); return; }
  const lines = ['# ' + options.title, '',
    'Usage columns contain the reported counters. Cached tokens are shown separately. Monetary amounts are USD.',
    'Session cost is the value reported by Pi. Billed amounts and estimates have separate columns.', ''];
  if (summary.unboundAttempts.length) lines.push('Unbound attempt records: ' + summary.unboundAttempts.length + '. Their known costs are listed under unboundAttempts in JSON.', '');
  if (summary.inferredPlans.length) lines.push('Inputs without a manifest use observed repeat IDs; completely absent repeats are unknown.', '');
  table(lines, ['project','task','arm','status','profile','repeat','attempt','answer','exit','turns','input tok','output tok','total tok','cache read','cache write','latency ms','tool calls','reads','repeat reads','observed B','served B','net B','session cost','billed','estimate','cost source'],
    summary.rows.map(r=>[r.project,r.caseId.replace(/^(research|exec)-/,'$1:'),r.arm,r.status,r.profile,r.repeat,r.attempt,r.qualityPass,r.exitCode,r.turns,r.inputTokens,r.outputTokens,r.totalTokens,r.cacheReadTokens,r.cacheWriteTokens,r.latencyMs,r.toolCalls,r.readCalls,r.repeatReads,r.inputBytes,r.outputBytes,r.savedBytes,r.reportedCostUsd,r.costUsd,r.estimatedCostUsd,r.costSource]));
  lines.push('## Paired task deltas (off minus variant)', '');
  for (const g of summary.pairedTrials) {
    lines.push([g.snapshot,g.platform,g.profile,g.project,g.caseId].map(fmt).join(' · '), '',
      'Successful triples: ' + g.successfulTriples + '/' + g.expectedTriples + '. Retries: ' + g.retries + '.', '');
    table(lines, ['repeat','arm','cell status','attempts'],g.cells.map(c=>[c.repeat,c.arm,c.status,c.attempts]));
    const classes = [];
    for (const arm of arms) {
      const cells = g.cells.filter(c => c.arm === arm);
      for (const name of Object.keys(cells[0]?.payloadByClass ?? {})) {
        const known = cells.map(c => c.payloadByClass[name]).filter(b => Number.isFinite(b.savedBytes));
        if (known.length) classes.push([arm, name, known.length + '/' + cells.length,
          ...['reads','inputBytes','outputBytes','savedBytes'].map(k => known.reduce((n,b) => n + b[k], 0))]);
      }
    }
    if (classes.length) table(lines, ['arm','read class','measured/planned cells','reads','observed B','served B','net B'], classes);
    if (g.excludedTriples.length) lines.push('Triples excluded for unverified initial files: ' + g.excludedTriples.map(t => t.repeat).join(', ') + '.', '');
    table(lines, ['arm','metric','usable/planned','median','min','max'],Object.entries(g.comparisons).flatMap(([arm,fields])=>
      Object.entries(fields).map(([metric,s])=>[arm,metric,s.count+'/'+s.denominator,s.median,s.min,s.max])));
  }
  process.stdout.write(lines.join('\n') + '\n');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
