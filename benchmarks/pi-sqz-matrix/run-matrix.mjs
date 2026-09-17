#!/usr/bin/env node
// run-matrix.mjs - orchestrates the pi SQZ benchmark matrix.
//
// For every (project, task, arm, repeat) cell:
//   1. snapshots user modifications (execution tasks only; never uses git reset)
//   2. runs `pi -p` with provider/model from scenarios.json and the
//      dedup-read.mjs extension in the requested mode
//   3. collects model-visible byte metrics from the extension metrics file
//      and token usage from the pi session file
//   4. checks assertions (research) or verify greps (execution)
//   5. restores the snapshot and removes per-run dedup state
//
// Usage:
//   node run-matrix.mjs [--projects id1,id2] [--tasks id1,id2]
//                       [--arms off,aifhub,sqz] [--repeats N] [--out DIR]
//                       [--timeout-min 15] [--dry-run]
import { execFile, spawn } from "node:child_process";
import { readdir, readFile, rm, mkdir, stat, writeFile, access } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..", "..");
const EXTENSION_PATH = path.join(SCRIPT_DIR, "dedup-read.mjs");
const SQZ_BIN = path.join(SCRIPT_DIR, "bin", "sqz.exe");
// Windows installs pi as pi.cmd; spawn without shell cannot exec it. Launch
// the package's CLI bundle with node directly for a portable, shell-free start.
const PI_ENTRY = path.join(
  process.env.APPDATA ?? path.join(process.env.USERPROFILE ?? "", "AppData", "Roaming"),
  "npm",
  "node_modules",
  "@earendil-works",
  "pi-coding-agent",
  "dist",
  "bundle",
  "cli.js"
);

function parseArgs(argv) {
  const result = {
    projects: null,
    tasks: null,
    arms: ["off", "aifhub", "sqz"],
    repeats: 1,
    out: path.join(SCRIPT_DIR, "out"),
    "timeout-min": 20,
    "dry-run": false,
  };
  // argv is already sliced to flags-only (process.argv.slice(2)).
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--projects") result.projects = argv[++i].split(",");
    else if (arg === "--tasks") result.tasks = argv[++i].split(",");
    else if (arg === "--arms") result.arms = argv[++i].split(",");
    else if (arg === "--repeats") result.repeats = Number(argv[++i]);
    else if (arg === "--out") result.out = path.resolve(argv[++i]);
    else if (arg === "--timeout-min") result["timeout-min"] = Number(argv[++i]);
    else if (arg === "--dry-run") result["dry-run"] = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return result;
}

const esc = (s) => String(s ?? "");
const list = (v) => (v ? new Set(v) : null);

function gitExec(cwd, args) {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, windowsHide: true, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`git ${args.join(" ")} failed: ${stderr || err.message}`));
      else resolve(stdout);
    });
  });
}

// Parses `git status --porcelain -z` output into [{x, y, path}] entries.
function parseStatusZ(output) {
  const entries = [];
  let pos = 0;
  while (pos < output.length) {
    const x = output[pos];
    const y = output[pos + 1];
    if (output[pos + 2] !== " ") throw new Error(`Unexpected porcelain format near offset ${pos}`);
    const nul = output.indexOf("\0", pos + 3);
    const p = output.slice(pos + 3, nul);
    entries.push({ x, y, path: p });
    pos = nul + 1;
    // Renames carry the original path as an extra NUL-terminated record.
    if (x === "R" || x === "C") {
      const nul2 = output.indexOf("\0", pos);
      entries.push({ x: " ", y: " ", path: output.slice(pos, nul2), isOldPath: true });
      pos = nul2 + 1;
    }
  }
  return entries;
}

async function snapshotProject(projectPath) {
  const status = await gitExec(projectPath, ["status", "--porcelain", "-z"]);
  const entries = parseStatusZ(status).filter((e) => !e.isOldPath && e.path);
  const files = new Map();
  for (const entry of entries) {
    const abs = path.join(projectPath, entry.path);
    try {
      const content = await readFile(abs);
      files.set(entry.path, content);
    } catch {
      // Deleted in baseline; remembered as absent.
      files.set(entry.path, null);
    }
  }
  return { files };
}

async function restoreProject(projectPath, snapshot) {
  const before = new Set(snapshot.files.keys());
  const status = await gitExec(projectPath, ["status", "--porcelain", "-z"]);
  const entries = parseStatusZ(status).filter((e) => !e.isOldPath && e.path);

  for (const entry of entries) {
    if (before.has(entry.path)) continue;
    const abs = path.join(projectPath, entry.path);
    if (entry.x === "?" && entry.y === "?") {
      await rm(abs, { recursive: true, force: true }).catch(() => {});
    } else {
      // Agent-modified tracked file that was clean before the run.
      await new Promise((resolve) => {
        execFile("git", ["checkout", "--", entry.path], { cwd: projectPath, windowsHide: true }, () => resolve());
      });
    }
  }

  for (const [rel, content] of snapshot.files) {
    const abs = path.join(projectPath, rel);
    if (content === null) {
      await rm(abs, { force: true }).catch(() => {});
      continue;
    }
    let current = null;
    try {
      current = await readFile(abs);
    } catch {
      current = null;
    }
    if (!current || !current.equals(content)) {
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, content);
    }
  }
}

async function runPi({ cwd, runId, mode, task, outDir, timeoutMin, modelCfg }) {
  const sessionDir = path.join(outDir, "sessions", runId);
  const metricsFile = path.join(outDir, "metrics", `${runId}.json`);
  await mkdir(sessionDir, { recursive: true });
  await mkdir(path.dirname(metricsFile), { recursive: true });

  const env = {
    ...process.env,
    SQZ_BENCH_MODE: mode,
    SQZ_BENCH_RUN_ID: runId,
    SQZ_BENCH_METRICS: metricsFile,
    SQZ_BENCH_SQZ_CMD: SQZ_BIN,
  };

  const args = [
    "--provider", modelCfg.provider,
    "--model", modelCfg.model,
    "--thinking", modelCfg.thinking,
    "--no-extensions",
    "--extension", EXTENSION_PATH,
    "--no-skills",
    "--no-prompt-templates",
    "--no-context-files",
    "--session-dir", sessionDir,
    "--print",
    task.prompt,
  ];

  const startedAt = new Date().toISOString();
  const stdout = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [PI_ENTRY, ...args], { cwd, env, windowsHide: true });
    // pi waits for stdin EOF even in --print mode; an open pipe stalls the run.
    child.stdin.end();
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill();
      setTimeout(() => {
        try { child.kill("SIGKILL"); } catch {}
      }, 5000);
      reject(new Error(`TIMEOUT after ${timeoutMin} min`));
    }, timeoutMin * 60 * 1000);
    child.stdin.on("error", () => {});
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out, err });
    });
  });

  return {
    startedAt,
    finishedAt: new Date().toISOString(),
    stdout: stdout.out,
    stderr: stdout.err,
    exitCode: stdout.code,
  };
}

async function findSessionFile(sessionDir) {
  const names = (await readdir(sessionDir)).filter((n) => n.endsWith(".jsonl"));
  if (names.length === 0) return null;
  const stats = await Promise.all(names.map(async (n) => {
    const full = path.join(sessionDir, n);
    const s = await stat(full);
    return { full, mtime: s.mtimeMs };
  }));
  stats.sort((a, b) => b.mtime - a.mtime);
  return stats[0].full;
}

function sumUsage(usage, totals) {
  if (!usage || typeof usage !== "object") return;
  totals.input += Number(usage.input ?? usage.inputTokens ?? 0) || 0;
  totals.output += Number(usage.output ?? usage.outputTokens ?? 0) || 0;
  totals.cacheRead += Number(usage.cacheRead ?? usage.cacheReadTokens ?? 0) || 0;
  totals.cacheWrite += Number(usage.cacheWrite ?? usage.cacheWriteTokens ?? 0) || 0;
  if (usage.cost && typeof usage.cost === "object" && Number.isFinite(Number(usage.cost.total))) {
    totals.cost += Number(usage.cost.total);
    totals.costAvailable = true;
  }
}

async function parseSession(sessionDir) {
  const sessionFile = await findSessionFile(sessionDir);
  if (!sessionFile) return { available: false, reason: "no session file" };
  const raw = await readFile(sessionFile, "utf8");
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, costAvailable: false };
  let finalText = "";
  let turns = 0;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry.type !== "message" || !entry.message) continue;
    const msg = entry.message;
    if (msg.role === "assistant") {
      turns += 1;
      sumUsage(msg.usage, totals);
      if (Array.isArray(msg.content)) {
        const text = msg.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
        if (text.trim()) finalText = text;
      }
    }
  }
  return { available: true, sessionFile, totals, turns, finalText };
}

async function fileExists(p) {
  try { await access(p); return true; } catch { return false; }
}

async function runVerify(projectPath, checks) {
  // Windows can briefly serve stale file contents right after a write;
  // retry failed negative/positive greps before concluding.
  const attempt = async () => {
    const results = [];
    for (const check of checks) {
      if (check.type !== "grep") {
        results.push({ check, pass: false, note: `unknown check type ${check.type}` });
        continue;
      }
      const abs = path.join(projectPath, check.file);
      if (!(await fileExists(abs))) {
        results.push({ check, pass: false, note: "file missing" });
        continue;
      }
      const content = await readFile(abs, "utf8");
      const found = new RegExp(check.pattern, "m").test(content);
      const pass = check.negate ? !found : found;
      results.push({ check, pass, note: check.negate ? (found ? "pattern present but must be absent" : "absent as required") : (found ? "found" : "not found") });
    }
    return results;
  };
  let results = await attempt();
  for (let i = 0; i < 2 && results.some((r) => !r.pass); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 400));
    results = await attempt();
  }
  return results;
}

function runAssertions(finalText, patterns) {
  if (!finalText || !finalText.trim()) return { pass: false, missing: patterns.slice(), note: "no final assistant text" };
  const missing = [];
  for (const pattern of patterns) {
    if (!new RegExp(pattern, "i").test(finalText)) missing.push(pattern);
  }
  return { pass: missing.length === 0, missing, note: missing.length ? `${patterns.length - missing.length}/${patterns.length} facts found` : "all facts found" };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const scenarios = JSON.parse(await readFile(path.join(SCRIPT_DIR, "scenarios.json"), "utf8"));
  const resultsDir = path.join(options.out, "results");
  await mkdir(resultsDir, { recursive: true });

  const projectFilter = list(options.projects);
  const taskFilter = list(options.tasks);
  const cells = [];
  for (const project of scenarios.projects) {
    if (projectFilter && !projectFilter.has(project.id)) continue;
    for (const task of project.tasks) {
      if (taskFilter && !taskFilter.has(task.id)) continue;
      for (const arm of options.arms) {
        for (let repeat = 1; repeat <= options.repeats; repeat += 1) {
          cells.push({ project, task, arm, repeat });
        }
      }
    }
  }

  process.stdout.write(`Matrix: ${cells.length} cells\n`);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const summaryPath = path.join(options.out, `matrix-${stamp}.jsonl`);

  for (const [index, cell] of cells.entries()) {
    const { project, task, arm, repeat } = cell;
    const runId = `${project.id}-${task.id}-${arm}-r${repeat}`;
    const record = {
      runId,
      project: project.id,
      projectLabel: project.label,
      task: task.id,
      taskKind: task.kind,
      arm,
      repeat,
      model: scenarios.model,
      startedAt: new Date().toISOString(),
    };
    process.stdout.write(`\n[${index + 1}/${cells.length}] ${runId}\n`);

    if (options["dry-run"]) {
      record.skipped = "dry-run";
      await writeFile(path.join(resultsDir, `${runId}.json`), `${JSON.stringify(record, null, 2)}\n`);
      continue;
    }

    let snapshot = null;
    try {
      if (task.kind === "execution") {
        snapshot = await snapshotProject(project.path);
        process.stdout.write(`  snapshot: ${snapshot.files.size} dirty/untracked file(s) preserved\n`);
      }

      const pi = await runPi({
        cwd: project.path,
        runId,
        mode: arm,
        task,
        outDir: options.out,
        timeoutMin: options["timeout-min"],
        modelCfg: scenarios.model,
      });
      record.pi = { exitCode: pi.exitCode, startedAt: pi.startedAt, finishedAt: pi.finishedAt };
      if (pi.stderr && pi.exitCode !== 0) record.piError = pi.stderr.slice(-2000);

      const metricsPath = path.join(options.out, "metrics", `${runId}.json`);
      if (await fileExists(metricsPath)) {
        const metrics = JSON.parse(await readFile(metricsPath, "utf8"));
        record.readMetrics = metrics.totals;
      } else {
        record.readMetrics = null;
      }

      const session = await parseSession(path.join(options.out, "sessions", runId));
      record.usage = session.available ? session.totals : { unavailable: session.reason };
      record.turns = session.turns ?? null;
      if (task.kind === "research") {
        record.quality = runAssertions(session.finalText ?? "", task.assertions);
      } else {
        record.quality = { checks: await runVerify(project.path, task.verify) };
        record.quality.pass = record.quality.checks.every((c) => c.pass);
      }
    } catch (error) {
      record.error = String(error.message ?? error);
    } finally {
      if (snapshot) {
        await restoreProject(project.path, snapshot).catch(async (e) => {
          record.restoreError = String(e.message ?? e);
        });
      }
      await rm(path.join(project.path, ".ai-factory", "state", "context-dedup-bench"), { recursive: true, force: true }).catch(() => {});
      record.finishedAt = new Date().toISOString();
      await writeFile(path.join(resultsDir, `${runId}.json`), `${JSON.stringify(record, null, 2)}\n`);
      await writeFile(summaryPath, `${JSON.stringify(record)}\n`, { flag: "a" });
      const q = record.quality;
      process.stdout.write(`  quality: ${q ? (q.pass ? "PASS" : "FAIL") : "n/a"}; usage: ${record.usage && record.usage.input !== undefined ? `${record.usage.input}in/${record.usage.output}out` : "n/a"}\n`);
    }
  }

  process.stdout.write(`\nDone. Results in ${resultsDir}\nSummary: ${summaryPath}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
