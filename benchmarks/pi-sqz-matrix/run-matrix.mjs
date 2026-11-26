#!/usr/bin/env node
// run-matrix.mjs - orchestrates the pi SQZ benchmark matrix.
//
// Each selected project is frozen once. Pi and its result checks operate on a
// fresh disposable copy for each arm and repetition.
//
// Usage:
//   node run-matrix.mjs [--projects id1,id2] [--tasks id1,id2]
//                       [--arms off,aifhub,sqz] [--repeats N] [--out DIR]
//                       [--timeout-min 15] [--dry-run]
import { execFile, spawn } from "node:child_process";
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { readdir, readFile, rm, mkdir, mkdtemp, cp, copyFile, lstat, realpath, writeFile, access } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
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
    repeats: undefined,
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
    else if (["--manifest", "--profile", "--sqz-exe", "--project-root", "--pi-entry"].includes(arg)) result[arg.slice(2)] = argv[++i];
    else if (arg === "--dry-run") result["dry-run"] = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return result;
}

const list = (v) => (v ? new Set(v) : null);

function gitExec(cwd, args) {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, windowsHide: true, maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(new Error("Git could not enumerate project files."));
      else resolve(stdout);
    });
  });
}

// Resolve aliases also when the last path components have not been created yet.
async function resolveLocation(target) {
  const absolute = path.resolve(target);
  try { return await realpath(absolute); } catch (error) {
    if (error.code !== "ENOENT" || path.dirname(absolute) === absolute) throw error;
    return path.join(await resolveLocation(path.dirname(absolute)), path.basename(absolute));
  }
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

// Freeze one ordinary-file tree per project. Every arm gets independent file bytes,
// including local edits, but no shared Git directory, links, provider cache or ledger.
async function freezeProject(source, dest) {
  const root = await realpath(source);
  if (isWithin(root, dest)) throw new Error('Temporary workspaces must be outside the source project.');
  const ignored = rel => rel.split(path.sep).some(name => ['.git', 'node_modules', '.pi'].includes(name) || /^\.env(?:\.|$)/.test(name)) ||
    isWithin(path.join(root, '.ai-factory', 'state'), path.join(root, rel));
  await mkdir(dest);
  const digest = createHash('sha256');
  async function copy(relative) {
    if (ignored(relative)) return;
    const file = path.resolve(root, relative);
    if (!isWithin(root, file) || await realpath(file) !== file) throw new Error('Unverified source link in benchmark input.');
    const info = await lstat(file);
    if (!info.isFile()) throw new Error('Unsupported benchmark input type.');
    const target = path.join(dest, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(file, target);
    const contentHash = createHash('sha256').update(await readFile(target)).digest('hex');
    digest.update(JSON.stringify([relative.split(path.sep).join('/'), contentHash]) + '\n');
  }
  async function walk(relative) {
    const entries = await readdir(path.join(root, relative), { withFileTypes: true });
    entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of entries) {
      const name = path.join(relative, entry.name);
      if (ignored(name)) continue;
      if (entry.isDirectory()) await walk(name);
      else await copy(name);
    }
  }
  if (await fileExists(path.join(root, '.git'))) {
    const files = await gitExec(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']);
    for (const name of [...new Set(files.split('\0').filter(Boolean))].sort()) {
      const relative = path.normalize(name);
      if (ignored(relative)) continue;
      try { await lstat(path.join(root, relative)); } catch (error) {
        if (error.code === 'ENOENT') continue; // tracked deletion in the current checkout
        throw error;
      }
      await copy(relative);
    }
  } else {
    await walk('');
  }
  return digest.digest('hex');
}

async function runPi({ cwd, runId, mode, task, outDir, timeoutMin, modelCfg, sqzBinary, piEntry }) {
  const sessionDir = path.join(outDir, "sessions", runId);
  const metricsFile = path.join(outDir, "metrics", `${runId}.json`);
  await mkdir(sessionDir, { recursive: true });
  await mkdir(path.dirname(metricsFile), { recursive: true });

  const env = {
    ...Object.fromEntries(["PATH", "Path", "SystemRoot", "ComSpec", "PATHEXT", "HOME", "USERPROFILE", "APPDATA",
      "LOCALAPPDATA", "TMP", "TEMP", "TMPDIR", "LANG", "LC_ALL", "PI_CODING_AGENT_DIR",
      "OPENROUTER_API_KEY", "OMNIROUTE_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"]
      .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]])),
    SQZ_BENCH_MODE: mode,
    SQZ_BENCH_RUN_ID: runId,
    SQZ_BENCH_METRICS: metricsFile,
    SQZ_BENCH_SQZ_CMD: sqzBinary,
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
  const outcome = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [piEntry, ...args], { cwd, env, windowsHide: true, stdio: ["pipe", "ignore", "ignore"] });
    // pi waits for stdin EOF even in --print mode; an open pipe stalls the run.
    child.stdin.end();
    let timedOut = false;
    let killTimer;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
      killTimer = setTimeout(() => child.kill("SIGKILL"), 5000);
    }, timeoutMin * 60 * 1000);
    child.stdin.on("error", () => {});
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      resolve({exitCode: code, signal, timedOut});
    });
  });

  return {
    startedAt,
    finishedAt: new Date().toISOString(),
    ...outcome,
  };
}

function amount(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

async function parseSession(sessionDir, cwd, profile) {
  const files = (await readdir(sessionDir, { withFileTypes: true })).filter(f => f.name.endsWith(".jsonl"));
  if (files.length !== 1 || !files[0].isFile()) {
    return { available: false, reason: files.length ? "ambiguous session files" : "no session file" };
  }
  const raw = await readFile(path.join(sessionDir, files[0].name), "utf8");
  let entries;
  try { entries = raw.split("\n").filter(line => line.trim()).map(line => JSON.parse(line)); }
  catch { return { available: false, reason: "incomplete session data" }; }
  const header = entries[0];
  if (header?.type !== "session" || !header.id || typeof header.cwd !== "string" ||
      path.relative(cwd, header.cwd) !== "" || entries.slice(1).some(e => !e || e.type === "session")) {
    return { available: false, reason: "session ownership unavailable" };
  }
  const messages = entries.filter(e => e.type === "message" && e.message?.role === "assistant").map(e => e.message);
  if (!messages.length || messages.some(m => (m.provider && m.provider !== profile.provider) || (m.model && m.model !== profile.model))) {
    return { available: false, reason: "no attributable assistant usage" };
  }
  // Pi initializes every counter to zero before the provider responds. An
  // interrupted turn can therefore report an all-zero placeholder.
  const interrupted = m => m.stopReason === "error" || m.stopReason === "aborted" || Boolean(m.errorMessage);
  const errorTurns = messages.filter(interrupted).length;
  const totals = {}, partial = {};
  const fields = {input:u => u.input ?? u.inputTokens, output:u => u.output ?? u.outputTokens,
    cacheRead:u => u.cacheRead ?? u.cacheReadTokens, cacheWrite:u => u.cacheWrite ?? u.cacheWriteTokens,
    cost:u => u.cost?.total, billedUsd:u => u.billedUsd, estimatedUsd:u => u.usdEstimate};
  for (const [field, get] of Object.entries(fields)) {
    const values = messages.flatMap(message => {
      const value = amount(get(message.usage ?? {}));
      return value === null || (interrupted(message) && value === 0) ? [] : [value];
    });
    const known = values.reduce((sum, value) => sum + value, 0);
    totals[field] = !errorTurns && values.length === messages.length ? known : null;
    if (values.length && totals[field] === null) partial[field] = { known, observedTurns: values.length, totalTurns: messages.length };
  }
  if (errorTurns) totals.unavailable = "Incomplete usage across interrupted provider turns";
  totals.costAvailable = totals.cost !== null;
  totals.costSource = totals.costAvailable ? "Pi session usage.cost.total" : null;
  totals.partial = partial;
  const blocks = messages.map(m => m.content);
  const toolCalls = blocks.every(Array.isArray) ? blocks.flat().filter(c => c?.type === "toolCall").length : null;
  const last = messages.at(-1);
  const finalText = Array.isArray(last.content) ? last.content.filter(c => c?.type === "text").map(c => c.text).join("\n") : "";
  return { available: true, sessionId: header.id, totals, turns: messages.length, errorTurns, terminalError: interrupted(last), toolCalls, finalText };
}

async function fileExists(p) {
  try { await access(p); return true; } catch { return false; }
}

async function runVerify(projectPath, checks, retry = true) {
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
      if (!isWithin(projectPath, abs)) throw new Error('Validation file is outside the disposable project.');
      if (!(await fileExists(abs))) {
        results.push({ check, pass: false, note: "file missing" });
        continue;
      }
      if (!isWithin(projectPath, await realpath(abs))) {
        throw new Error('Validation file is outside the disposable project.');
      }
      const content = await readFile(abs, "utf8");
      const found = new RegExp(check.pattern, "m").test(content);
      const pass = check.negate ? !found : found;
      results.push({ check, pass, note: check.negate ? (found ? "pattern present but must be absent" : "absent as required") : (found ? "found" : "not found") });
    }
    return results;
  };
  let results = await attempt();
  for (let i = 0; retry && i < 2 && results.some((r) => !r.pass); i += 1) {
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
  const binary = path.resolve(options["sqz-exe"] ?? SQZ_BIN);
  let profile = scenarios.model;
  let manifest;
  if (options.manifest) {
    const { readMatrixManifest } = await import("../../docs/memory-tools-research/context-dedup-ai-tester/generate-matrix.mjs");
    ({ manifest, profile } = await readMatrixManifest(options.manifest, "pi", options.profile,
      options.arms.includes("sqz") ? binary : null));
    if (options.repeats !== undefined && options.repeats !== manifest.repeats) throw new Error("Repeat count differs from manifest.");
  }
  if (manifest && options.arms.join(",") !== "off,aifhub,sqz") throw new Error("A paired snapshot requires the three ordered arms.");
  const piEntry = path.resolve(options["pi-entry"] ?? PI_ENTRY);
  if (manifest && !options["dry-run"]) {
    const actual = createHash("sha256").update(await readFile(piEntry)).digest("hex");
    if (actual !== manifest.runners.pi.entrySha256.toLowerCase()) throw new Error("Pi runner SHA-256 mismatch.");
  }
  const repeats = manifest?.repeats ?? options.repeats ?? 1;
  if (!Number.isSafeInteger(repeats) || repeats < 1 || !Number.isFinite(options["timeout-min"]) || options["timeout-min"] <= 0 ||
      options.arms.some(arm => !["off", "aifhub", "sqz"].includes(arm)) || new Set(options.arms).size !== options.arms.length) {
    throw new Error("Invalid matrix options.");
  }
  if (options["project-root"] && options.projects?.length !== 1) throw new Error("--project-root requires one selected project.");
  const resultsDir = path.join(options.out, "results");

  const projectFilter = list(options.projects);
  const taskFilter = list(options.tasks);
  const cells = [];
  for (const project of scenarios.projects) {
    if (projectFilter && !projectFilter.has(project.id)) continue;
    for (const task of project.tasks) {
      if (manifest && !manifest.piTasks.some(c => c.project === project.id && c.task === task.id)) continue;
      if (taskFilter && !taskFilter.has(task.id)) continue;
      for (let repeat = 1; repeat <= repeats; repeat += 1) {
        for (const arm of options.arms) {
          const prefix = manifest ? profile.id + "-" : "";
          cells.push({ project, task, arm, repeat, runId: prefix + `${project.id}-${task.id}-${arm}-r${repeat}` });
        }
      }
    }
  }

  if (!cells.length) throw new Error("No matching benchmark cells.");
  const ids = new Set(cells.map(c => c.runId));
  if (ids.size !== cells.length || [...ids].some(id => !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(id))) {
    throw new Error("Invalid or duplicate matrix cell.");
  }
  for (const project of new Set(cells.map(cell => cell.project))) {
    const source = await resolveLocation(options["project-root"] ?? project.path);
    if (isWithin(source, await resolveLocation(options.out))) throw new Error("Output must be outside the source project.");
  }
  await mkdir(path.dirname(options.out), { recursive: true });
  try { await mkdir(options.out); } catch (error) {
    if (error.code !== "EEXIST" || manifest || (await readdir(options.out)).length) throw error;
  }
  await mkdir(resultsDir);
  if (manifest) {
    const expectedCells = cells.map(({ project, task, arm, repeat, runId }) => ({
      snapshot: manifest.snapshot, platform: process.platform, profile: profile.id, project: project.id, caseId: task.id, repeat, arm, runId
    }));
    await writeFile(path.join(options.out, "manifest.json"), JSON.stringify({ ...manifest, harness: "pi", profile, expectedCells }, null, 2) + "\n", { flag: "wx" });
  }

  process.stdout.write(`Matrix: ${cells.length} cells\n`);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const summaryPath = path.join(options.out, `matrix-${stamp}.jsonl`);

  const scratch = await realpath(await mkdtemp(path.join(tmpdir(), "pi-sqz-work-")));
  try {
    await runCells({ cells, options, manifest, profile, binary, piEntry, resultsDir, summaryPath, scratch });
  } finally {
    await rm(scratch, { recursive: true, force: true, maxRetries: 3 });
  }
  process.stdout.write(`\nFinished ${cells.length} cells.\n`);
}

async function runCells({ cells, options, manifest, profile, binary, piEntry, resultsDir, summaryPath, scratch }) {
  const baselines = new Map();

  for (const [index, cell] of cells.entries()) {
    const { project, task, arm, repeat, runId } = cell;
    const record = {
      runId,
      project: project.id,
      projectLabel: project.label,
      task: task.id,
      taskKind: task.kind,
      arm,
      repeat,
      model: profile,
      ...(manifest ? { snapshot: manifest.snapshot, profile: profile.id, platform: process.platform } : {}),
      startedAt: new Date().toISOString(),
    };
    process.stdout.write(`\n[${index + 1}/${cells.length}] ${runId}\n`);

    if (options["dry-run"]) {
      record.skipped = "dry-run";
      await mkdir(path.join(options.out, "sessions", runId), { recursive: true });
      await writeFile(path.join(resultsDir, `${runId}.json`), `${JSON.stringify(record, null, 2)}\n`);
      continue;
    }

    let workspace;
    try {
      if (!baselines.has(project.id)) {
        const base = path.join(scratch, 'base-' + baselines.size);
        const digest = freezeProject(options["project-root"] ?? project.path, base);
        baselines.set(project.id, { base, digest });
      }
      const { base, digest } = baselines.get(project.id);
      record.initialTreeSha256 = await digest;
      workspace = path.join(scratch, 'cell-' + runId);
      await cp(base, workspace, { recursive: true, errorOnExist: true, force: false });
      if (task.kind === "execution") {
        if (!task.verify?.length) throw new Error('Execution task requires observable checks.');
        const initial = await runVerify(workspace, task.verify, false);
        if (initial.some(r => r.note === 'file missing' || r.check.type !== 'grep')) throw new Error('Execution precondition unavailable.');
        if (initial.every(r => r.pass)) {
          record.skipped = "execution-already-satisfied";
          continue;
        }
        const preconditions = manifest?.piTasks.find(c => c.project === project.id && c.task === task.id)?.preconditions;
        if (preconditions && !(await runVerify(workspace, preconditions, false)).every(r => r.pass)) {
          record.skipped = "execution-precondition-mismatch";
          continue;
        }
      }
      const pi = await runPi({
        cwd: workspace,
        runId,
        mode: arm,
        task,
        outDir: options.out,
        timeoutMin: options["timeout-min"],
        modelCfg: profile,
        sqzBinary: binary,
        piEntry,
      });
      record.pi = pi;
      record.latencyMs = Date.parse(pi.finishedAt) - Date.parse(pi.startedAt);
      if (pi.timedOut || pi.signal) record.error = pi.timedOut ? "timeout" : "process-signalled";

      const session = await parseSession(path.join(options.out, "sessions", runId), workspace, profile);
      record.attempt = 1;
      record.sessionId = session.sessionId ?? null;
      record.usage = session.available ? session.totals : { unavailable: session.reason };
      record.turns = session.turns ?? null;
      record.errorTurns = session.errorTurns ?? null;
      if (session.terminalError && !record.error) record.error = "terminal-provider-error";
      record.toolCalls = session.toolCalls ?? null;
      record.readMetrics = null;
      const metricsPath = path.join(options.out, "metrics", runId + ".json");
      if (await fileExists(metricsPath)) {
        try {
          const m = await lstat(metricsPath);
          const metrics = m.isFile() ? JSON.parse(await readFile(metricsPath, "utf8")) : null;
          if (session.available && metrics?.runId === runId && metrics?.mode === arm &&
              metrics?.sessionId === session.sessionId && metrics?.attempt === record.attempt) {
            record.readMetrics = metrics.totals ?? null;
            if (metrics.sessionIds?.some(id => id !== session.sessionId)) {
              record.usage = { unavailable: "usage incomplete across observed sessions" };
              record.turns = null;
              record.toolCalls = null;
            }
          }
          else record.readMetricsUnavailable = "metrics ownership unavailable";
        } catch { record.readMetricsUnavailable = "unreadable metrics"; }
      } else record.readMetricsUnavailable = "no metrics file";
      if (task.kind === "research") {
        record.quality = session.available ? runAssertions(session.finalText, task.assertions) : {pass: null, note: session.reason};
      } else {
        record.quality = { checks: await runVerify(workspace, task.verify) };
        record.quality.pass = record.quality.checks.every((c) => c.pass);
      }
    } catch (error) {
      record.error = error.code && /^[A-Z0-9_]+$/.test(error.code) ? error.code :
        error instanceof SyntaxError ? "invalid-result-data" : (error.message || "cell-failed");
    } finally {
      if (workspace) await rm(workspace, { recursive: true, force: true, maxRetries: 3 });
      record.finishedAt = new Date().toISOString();
      await writeFile(path.join(resultsDir, `${runId}.json`), `${JSON.stringify(record, null, 2)}\n`);
      await writeFile(summaryPath, `${JSON.stringify(record)}\n`, { flag: "a" });
      const q = record.quality;
      const input = record.usage?.input ?? "n/a", output = record.usage?.output ?? "n/a";
      process.stdout.write(`  exit: ${record.pi?.exitCode ?? "n/a"}; answer: ${q?.pass === true ? "PASS" : q?.pass === false ? "FAIL" : "n/a"}; usage: ${input}in/${output}out\n`);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
