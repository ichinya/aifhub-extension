#!/usr/bin/env node
// context-dedup-benchmark.mjs - deterministic offline replay benchmark for read deduplication modes
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { isProtectedReadPath, readContextDedupPolicy, recordRead } from './context-dedup.mjs';

export const BENCHMARK_MODES = ['baseline', 'variant-a', 'external'];

const BYTES_PER_TOKEN_ESTIMATE = 4;

export function defaultTrace() {
  const source = (marker) =>
    `// ${marker}\n${Array.from({ length: 160 }, (_, index) => `export const value${index} = '${marker}-${index}';`).join('\n')}\n`;
  const spec = (marker) =>
    `# Spec ${marker}\n${Array.from({ length: 120 }, (_, index) => `- REQ-${index}: requirement ${marker} ${index}`).join('\n')}\n`;

  return {
    name: 'aifhub-session-replay',
    files: [
      { path: 'src/auth/session.ts', revisions: [source('session-v1'), source('session-v2')] },
      { path: 'src/auth/tokens.ts', revisions: [source('tokens-v1')] },
      { path: 'openspec/specs/auth/spec.md', revisions: [spec('auth')] },
      { path: '.ai-factory/qa/add-oauth/coverage.json', revisions: [`${JSON.stringify({ requirements: Array.from({ length: 120 }, (_, index) => ({ id: `REQ-${index}`, covered: true })) }, null, 2)}\n`] },
      { path: 'src/util/tiny.ts', revisions: ["export const tiny = 'x';\n"] }
    ],
    reads: [
      { path: 'src/auth/session.ts', revision: 0 },
      { path: 'src/auth/tokens.ts', revision: 0 },
      { path: 'openspec/specs/auth/spec.md', revision: 0 },
      { path: 'src/auth/session.ts', revision: 0 },
      { path: 'src/util/tiny.ts', revision: 0 },
      { path: '.ai-factory/qa/add-oauth/coverage.json', revision: 0 },
      { path: 'src/auth/tokens.ts', revision: 0 },
      { path: 'openspec/specs/auth/spec.md', revision: 0 },
      { path: 'src/auth/session.ts', revision: 1 },
      { path: 'src/auth/session.ts', revision: 1 },
      { path: '.ai-factory/qa/add-oauth/coverage.json', revision: 0 },
      { path: 'src/util/tiny.ts', revision: 0 }
    ]
  };
}

export function normalizeTrace(trace) {
  const files = new Map();
  for (const file of trace?.files ?? []) {
    files.set(file.path, file.revisions ?? []);
  }

  const reads = (trace?.reads ?? []).map((read) => {
    const revisions = files.get(read.path);
    if (!revisions) {
      throw new Error(`Trace read references unknown file: ${read.path}`);
    }

    const content = revisions[read.revision ?? 0];
    if (typeof content !== 'string') {
      throw new Error(`Trace read references unknown revision ${read.revision} for ${read.path}`);
    }

    return { path: read.path, revision: read.revision ?? 0, content };
  });

  return { name: trace?.name ?? 'trace', files, reads };
}

export async function runBenchmark(options = {}) {
  const mode = options.mode ?? 'baseline';
  if (!BENCHMARK_MODES.includes(mode)) {
    throw new Error(`Unknown benchmark mode: ${mode}`);
  }

  const trace = normalizeTrace(options.trace ?? defaultTrace());
  const workspace = options.workspace ?? (await mkdtemp(path.join(os.tmpdir(), 'aifhub-dedup-bench-')));
  const ownsWorkspace = !options.workspace;
  const sessionId = options.sessionId ?? 'benchmark';
  const emit = options.emit ?? (() => {});

  try {
    await writeConfig(workspace, mode);
    const policy = await readContextDedupPolicy({ rootDir: workspace });
    const steps = [];
    const lastContentByPath = new Map();

    for (const [index, read] of trace.reads.entries()) {
      await materialize(workspace, read.path, read.content);
      const contentChanged = lastContentByPath.get(read.path) !== read.content;
      lastContentByPath.set(read.path, read.content);

      const step = await runStep(mode, {
        workspace,
        sessionId,
        read,
        policy,
        externalCommand: options.externalCommand,
        env: options.env
      });

      const emittedBytes = Buffer.byteLength(step.emitted, 'utf8');
      const fullBytes = Buffer.byteLength(read.content, 'utf8');
      const servedFullContent = step.emitted === read.content;

      steps.push({
        index,
        path: read.path,
        revision: read.revision,
        decision: step.decision,
        contentChanged,
        protectedArtifact: isProtectedReadPath(read.path, policy),
        servedFullContent,
        emittedBytes,
        fullBytes
      });

      emit(steps.at(-1));
    }

    return summarize(mode, trace, steps, options.externalCommand ?? null);
  } finally {
    if (ownsWorkspace) {
      await rm(workspace, { recursive: true, force: true });
    }
  }
}

function summarize(mode, trace, steps, externalCommand) {
  const baselineBytes = steps.reduce((total, step) => total + step.fullBytes, 0);
  const emittedBytes = steps.reduce((total, step) => total + step.emittedBytes, 0);
  const savedBytes = Math.max(0, baselineBytes - emittedBytes);
  const changedReads = steps.filter((step) => step.contentChanged);
  const protectedReads = steps.filter((step) => step.protectedArtifact);

  return {
    mode,
    trace: trace.name,
    externalCommand,
    reads: steps.length,
    uniquePaths: new Set(steps.map((step) => step.path)).size,
    repeatReads: steps.length - new Set(steps.map((step) => `${step.path}@${step.revision}`)).size,
    dedupHits: steps.filter((step) => !step.servedFullContent).length,
    baselineBytes,
    emittedBytes,
    savedBytes,
    savedPercent: baselineBytes === 0 ? 0 : Number(((savedBytes / baselineBytes) * 100).toFixed(2)),
    estimatedSavedTokens: Math.ceil(savedBytes / BYTES_PER_TOKEN_ESTIMATE),
    correctness: {
      changedContentAlwaysServed: changedReads.every((step) => step.servedFullContent),
      protectedArtifactsAlwaysServed: protectedReads.every((step) => step.servedFullContent),
      protectedReads: protectedReads.length,
      protectedReadsDeduplicated: protectedReads.filter((step) => !step.servedFullContent).length
    },
    steps
  };
}

async function runStep(mode, context) {
  if (mode === 'baseline') {
    return { emitted: context.read.content, decision: 'baseline-full' };
  }

  if (mode === 'variant-a') {
    const result = await recordRead({
      filePath: context.read.path,
      content: context.read.content,
      rootDir: context.workspace,
      sessionId: context.sessionId,
      policy: context.policy
    });

    return { emitted: result.content ?? result.replay?.text ?? '', decision: result.decision };
  }

  return runExternalStep(context);
}

async function runExternalStep(context) {
  if (!context.externalCommand) {
    throw new Error('External mode requires --external-command.');
  }

  const payload = {
    session_id: context.sessionId,
    tool_name: 'Read',
    tool_input: { file_path: path.join(context.workspace, context.read.path) },
    tool_response: {
      type: 'text',
      file: { filePath: path.join(context.workspace, context.read.path), content: context.read.content }
    }
  };

  const { stdout, code } = await runCommand(context.externalCommand, JSON.stringify(payload), {
    cwd: context.workspace,
    env: { ...process.env, ...(context.env ?? {}) }
  });

  if (code !== 0 || !stdout.trim()) {
    return { emitted: context.read.content, decision: code === 0 ? 'external-passthrough' : 'external-error' };
  }

  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { emitted: context.read.content, decision: 'external-unparsable' };
  }

  const updated = parsed?.hookSpecificOutput?.updatedToolOutput;
  if (typeof updated !== 'string') {
    return { emitted: context.read.content, decision: 'external-passthrough' };
  }

  return { emitted: updated, decision: 'external-rewritten' };
}

function runCommand(command, input, options) {
  const [bin, ...args] = Array.isArray(command) ? command : command.split(' ').filter(Boolean);

  return new Promise((resolve) => {
    const child = spawn(bin, args, { cwd: options.cwd, env: options.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', () => resolve({ stdout: '', stderr, code: 1 }));
    child.on('close', (code) => resolve({ stdout, stderr, code: code ?? 0 }));

    child.stdin.end(input);
  });
}

async function writeConfig(workspace, mode) {
  const configPath = path.join(workspace, '.ai-factory', 'config.yaml');
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(
    configPath,
    ['aifhub:', '  artifactProtocol: openspec', '  contextDedup:', `    enabled: ${mode === 'variant-a'}`, '    minBytes: 2048', ''].join('\n'),
    'utf8'
  );
}

async function materialize(workspace, relativePath, content) {
  const absolute = path.join(workspace, relativePath);
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, content, 'utf8');
}

export async function main(argv = process.argv.slice(2), io = {}) {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const args = parseArgs(argv);

  if (args.help) {
    stdout.write(usage());
    return 0;
  }

  const modes = args.modes.length > 0 ? args.modes : ['baseline', 'variant-a'];
  for (const mode of modes) {
    if (!BENCHMARK_MODES.includes(mode)) {
      stderr.write(`Unknown mode: ${mode}\n${usage()}`);
      return 1;
    }
  }

  let trace = defaultTrace();
  if (args.trace) {
    try {
      trace = JSON.parse(await readFile(path.resolve(args.trace), 'utf8'));
    } catch (err) {
      stderr.write(`Trace could not be read: ${args.trace}\n${err?.message ?? err}\n`);
      return 1;
    }
  }

  const results = [];
  for (const mode of modes) {
    try {
      results.push(await runBenchmark({ mode, trace, externalCommand: args.externalCommand, sessionId: args.sessionId }));
    } catch (err) {
      stderr.write(`Benchmark failed for mode ${mode}: ${err?.message ?? err}\n`);
      return 1;
    }
  }

  if (args.json) {
    stdout.write(`${JSON.stringify({ trace: trace.name ?? 'trace', results: results.map(withoutSteps) }, null, 2)}\n`);
    return 0;
  }

  stdout.write(renderTable(results));
  return 0;
}

function withoutSteps(result) {
  const { steps, ...rest } = result;
  return rest;
}

function renderTable(results) {
  const lines = ['| mode | reads | emitted bytes | saved bytes | saved % | est. saved tokens | changed served | protected served |', '|---|---|---|---|---|---|---|---|'];

  for (const result of results) {
    lines.push(
      `| ${result.mode} | ${result.reads} | ${result.emittedBytes} | ${result.savedBytes} | ${result.savedPercent} | ${result.estimatedSavedTokens} | ${result.correctness.changedContentAlwaysServed ? 'yes' : 'NO'} | ${result.correctness.protectedArtifactsAlwaysServed ? 'yes' : 'NO'} |`
    );
  }

  return `${lines.join('\n')}\n`;
}

function parseArgs(argv) {
  const args = { modes: [], trace: null, externalCommand: null, sessionId: 'benchmark', json: false, help: false };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--json') args.json = true;
    else if (arg === '--mode') args.modes.push(argv[++index]);
    else if (arg === '--trace') args.trace = argv[++index];
    else if (arg === '--external-command') args.externalCommand = argv[++index];
    else if (arg === '--session') args.sessionId = argv[++index];
  }

  return args;
}

function usage() {
  return [
    'Usage: node scripts/context-dedup-benchmark.mjs [options]',
    '',
    'Options:',
    '  --mode <baseline|variant-a|external>  Repeatable. Defaults to baseline and variant-a.',
    '  --trace <file.json>                   Replay trace. Defaults to the built-in AIFHub session trace.',
    '  --external-command <command>          PostToolUse-style command for external mode.',
    '  --session <id>                        Session id used by variant-a and the external command.',
    '  --json                                Emit machine-readable results.',
    ''
  ].join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => {
    process.exitCode = code;
  });
}
