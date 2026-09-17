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

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const result = { out: [], title: "Pi SQZ context-dedup matrix" };
  // argv is already sliced to flags-only (process.argv.slice(2)).
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--out") result.out.push(path.resolve(argv[++i]));
    else if (argv[i] === "--title") result.title = argv[++i];
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  if (result.out.length === 0) result.out.push(path.join(SCRIPT_DIR, "out"));
  return result;
}

const fmt = (n) => (Number.isFinite(Number(n)) ? Number(n).toLocaleString("en-US") : "n/a");
const pct = (saved, observed) => (observed > 0 ? `${((saved / observed) * 100).toFixed(1)}%` : "n/a");

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const records = [];
  for (const resultsRoot of options.out) {
    const resultsDir = path.join(resultsRoot, "results");
    const names = (await readdir(resultsDir)).filter((n) => n.endsWith(".json"));
    for (const name of names) {
      records.push(JSON.parse(await readFile(path.join(resultsDir, name), "utf8")));
    }
  }
  records.sort((a, b) => `${a.project}-${a.task}-${a.arm}`.localeCompare(`${b.project}-${b.task}-${b.arm}`));

  const lines = [];
  lines.push(`# ${options.title}`);
  lines.push("");
  lines.push("Agent: pi (print mode) · model `la/ornith-1.5-35b-a3b` @ omniroute · thinking low.");
  lines.push("Bytes = model-visible payload measured by the dedup `read` override; tokens = measured provider usage from session files. Cost: provider reports no per-token price for this model, so cost is not computable (`unavailable`).");
  lines.push("");
  lines.push("## Per-cell results");
  lines.push("");
  lines.push("| project | task | arm | quality | turns | in tok | out tok | reads | obs B | served B | saved B | saved % | warnings |");
  lines.push("|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
  for (const r of records) {
    const q = r.quality ? (r.quality.pass ? "PASS" : "FAIL") : (r.error ? "ERROR" : "n/a");
    const u = r.usage ?? {};
    const m = r.readMetrics ?? {};
    lines.push([
      r.projectLabel ?? r.project,
      r.task.replace(/^(research|exec)-/, "$1:"),
      r.arm,
      q,
      r.turns ?? "n/a",
      u.input !== undefined ? fmt(u.input) : "n/a",
      u.output !== undefined ? fmt(u.output) : "n/a",
      m.readCalls ?? "n/a",
      m.observedBytes !== undefined ? fmt(m.observedBytes) : "n/a",
      m.servedBytes !== undefined ? fmt(m.servedBytes) : "n/a",
      m.savedBytes !== undefined ? fmt(m.savedBytes) : "n/a",
      m.savedBytes !== undefined ? pct(m.savedBytes, m.observedBytes ?? 0) : "n/a",
      m.warnedReads ?? "n/a",
    ].join("|").replace(/^/, "| ").concat(" |"));
  }

  lines.push("");
  lines.push("## Aggregates by project × arm (mean over cells)");
  lines.push("");
  lines.push("| project | arm | cells | quality pass | mean in tok | mean out tok | mean saved % |");
  lines.push("|---|---|---:|---:|---:|---:|---:|");
  const groups = new Map();
  for (const r of records) {
    const key = `${r.projectLabel ?? r.project}|${r.arm}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const mean = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : NaN);
  for (const [key, rs] of [...groups.entries()].sort()) {
    const [project, arm] = key.split("|");
    const tok = rs.map((r) => (r.usage?.input ?? 0) + (r.usage?.output ?? 0));
    const savedPct = rs.map((r) => {
      const m = r.readMetrics;
      return m && m.observedBytes > 0 ? (m.savedBytes / m.observedBytes) * 100 : 0;
    });
    lines.push(`| ${project} | ${arm} | ${rs.length} | ${rs.filter((r) => r.quality?.pass).length}/${rs.length} | ${fmt(mean(tok))} | ${mean(savedPct).toFixed(1)}% |`);
  }

  lines.push("");
  lines.push("## Verdict inputs");
  lines.push("");
  const cellTag = (r) => `${r.projectLabel ?? r.project}·${r.task}·${r.arm}`;
  const failed = records.filter((r) => r.quality && !r.quality.pass);
  lines.push(`- FAILED cells: ${failed.length === 0 ? "none" : failed.map((r) => `\`${cellTag(r)}\``).join(", ")}`);
  const errored = records.filter((r) => r.error);
  lines.push(`- ERRORED cells: ${errored.length === 0 ? "none" : errored.map((r) => `\`${cellTag(r)}\``).join(", ")}`);
  const warned = records.filter((r) => (r.readMetrics?.warnedReads ?? 0) > 0);
  lines.push(`- Cells with dedup warnings: ${warned.length === 0 ? "none" : warned.map((r) => `\`${r.runId}\`(${r.readMetrics.warnedReads})`).join(", ")}`);
  lines.push("- Repetitions: see `--repeats`; single-run cells are noisy trajectories, compare arms only via aggregates.");

  process.stdout.write(`${lines.join("\n")}\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
