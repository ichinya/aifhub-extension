#!/usr/bin/env node
// context-dedup-benchmark.mjs - deterministic offline replay benchmark for read deduplication modes
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { StringDecoder } from 'node:string_decoder';
import { pathToFileURL } from 'node:url';

import { isProtectedReadPath, readContextDedupPolicy, recordRead } from './context-dedup.mjs';

export const BENCHMARK_MODES = ['baseline', 'variant-a', 'external'];

const BYTES_PER_TOKEN_ESTIMATE = 4;
const DEFAULT_EXTERNAL_TIMEOUT_MS = 30_000;
const MAX_EXTERNAL_OUTPUT_BYTES = 8 * 1024 * 1024;
const SQZ_REFERENCE_PATTERN = /^§ref:[0-9a-f]{8,64}§\s*$/iu;
const SQZ_DELTA_PATTERN = /^§delta:[0-9a-f]{8,64}§(?:\r?\n|$)/iu;

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
  const fileKeys = new Map();
  for (const file of trace?.files ?? []) {
    const safePath = normalizeTracePath(file.path);
    const portableKey = safePath.toLowerCase();
    if (fileKeys.has(portableKey)) {
      throw new Error(`Trace contains duplicate file path: ${safePath}`);
    }
    files.set(safePath, file.revisions ?? []);
    fileKeys.set(portableKey, safePath);
  }

  const reads = (trace?.reads ?? []).map((read) => {
    const safePath = normalizeTracePath(read.path);
    const canonicalPath = fileKeys.get(safePath.toLowerCase());
    const revisions = canonicalPath ? files.get(canonicalPath) : undefined;
    if (!revisions) {
      throw new Error(`Trace read references unknown file: ${safePath}`);
    }

    const content = revisions[read.revision ?? 0];
    if (typeof content !== 'string') {
      throw new Error(`Trace read references unknown revision ${read.revision} for ${safePath}`);
    }

    return { path: canonicalPath, revision: read.revision ?? 0, content };
  });

  return { name: trace?.name ?? 'trace', files, reads };
}

function normalizeTracePath(value) {
  const raw = String(value ?? '');
  if (!raw
    || raw.includes('\0')
    || raw.includes('\\')
    || raw.startsWith('/')
    || /^[A-Za-z]:/.test(raw)
    || raw.startsWith('//')) {
    throw new Error(`Trace path must be a safe project-relative path: ${raw}`);
  }

  const parts = raw.split('/');
  const windowsReservedName = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;
  if (parts.some((part) =>
    !part
    || part === '.'
    || part === '..'
    || part.includes(':')
    || /[. ]$/u.test(part)
    || windowsReservedName.test(part))) {
    throw new Error(`Trace path must be a safe project-relative path: ${raw}`);
  }
  const normalized = parts.join('/');
  if (normalized.toLowerCase() === '.ai-factory/config.yaml') {
    throw new Error(`Trace path must be a safe project-relative path: ${raw}`);
  }
  return normalized;
}

export async function runBenchmark(options = {}) {
  const mode = options.mode ?? 'baseline';
  if (!BENCHMARK_MODES.includes(mode)) {
    throw new Error(`Unknown benchmark mode: ${mode}`);
  }
  if (!['sqz-text', 'hook-json'].includes(options.externalProtocol ?? 'sqz-text')) {
    throw new Error(`Unknown external protocol: ${options.externalProtocol}`);
  }
  if (options.externalTimeoutMs !== undefined
    && (!Number.isSafeInteger(options.externalTimeoutMs) || options.externalTimeoutMs <= 0)) {
    throw new Error('externalTimeoutMs must be a positive integer.');
  }

  const trace = normalizeTrace(options.trace ?? defaultTrace());
  const externalCommand = normalizeExternalCommand(options.externalCommand, options.externalArgs);
  const workspaceParent = path.resolve(options.workspace ?? os.tmpdir());
  await mkdir(workspaceParent, { recursive: true });
  const workspace = await mkdtemp(path.join(workspaceParent, 'aifhub-dedup-bench-'));
  const sessionId = options.sessionId ?? 'benchmark';
  const emit = options.emit ?? (() => {});

  try {
    await writeConfig(workspace, mode);
    const policy = await readContextDedupPolicy({ rootDir: workspace });
    const steps = [];
    const lastContentByPath = new Map();

    for (const [index, read] of trace.reads.entries()) {
      await materialize(workspace, read.path, read.content);
      const firstRead = !lastContentByPath.has(read.path);
      const contentChanged = !firstRead && lastContentByPath.get(read.path) !== read.content;
      lastContentByPath.set(read.path, read.content);

      const step = await runStep(mode, {
        workspace,
        sessionId,
        read,
        policy,
        externalCommand,
        externalProtocol: options.externalProtocol ?? 'sqz-text',
        externalTimeoutMs: options.externalTimeoutMs,
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
        deliveryKind: step.deliveryKind,
        firstRead,
        contentChanged,
        protectedArtifact: isProtectedReadPath(read.path, policy),
        belowThreshold: fullBytes < policy.minBytes,
        servedFullContent,
        emittedBytes,
        fullBytes
      });

      emit(steps.at(-1));
    }

    return summarize(mode, trace, steps, externalCommand);
  } finally {
    await rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

function summarize(mode, trace, steps, externalCommand) {
  const baselineBytes = steps.reduce((total, step) => total + step.fullBytes, 0);
  const emittedBytes = steps.reduce((total, step) => total + step.emittedBytes, 0);
  const savedBytes = Math.max(0, baselineBytes - emittedBytes);
  const changedReads = steps.filter((step) => step.contentChanged);
  const protectedReads = steps.filter((step) => step.protectedArtifact);
  const referenceReads = steps.filter((step) => step.deliveryKind === 'reference');
  const compressionReads = steps.filter((step) => step.deliveryKind === 'compressed');
  const deltaReads = steps.filter((step) => step.deliveryKind === 'delta');
  const savedFor = (matchingSteps) =>
    matchingSteps.reduce((total, step) => total + Math.max(0, step.fullBytes - step.emittedBytes), 0);
  const payloadByClass = Object.fromEntries(
    ['firstRead', 'exactRepeat', 'changed', 'protected', 'belowThreshold'].map((className) => {
      const matchingSteps = steps.filter((step) => classifyPayloadStep(step) === className);
      const inputBytes = matchingSteps.reduce((total, step) => total + step.fullBytes, 0);
      const outputBytes = matchingSteps.reduce((total, step) => total + step.emittedBytes, 0);
      const savedBytes = Math.max(0, inputBytes - outputBytes);
      return [className, {
        reads: matchingSteps.length,
        inputBytes,
        outputBytes,
        savedBytes,
        savedPercent: inputBytes === 0
          ? 0
          : Number(((savedBytes / inputBytes) * 100).toFixed(2))
      }];
    })
  );

  return {
    mode,
    trace: trace.name,
    externalCommand,
    reads: steps.length,
    uniquePaths: new Set(steps.map((step) => step.path)).size,
    repeatReads: steps.length - new Set(steps.map((step) => `${step.path}@${step.revision}`)).size,
    dedupHits: referenceReads.length,
    referenceReads: referenceReads.length,
    compressionReads: compressionReads.length,
    deltaReads: deltaReads.length,
    transformedReads: steps.filter((step) => !step.servedFullContent).length,
    savedBytesByKind: {
      reference: savedFor(referenceReads),
      compressed: savedFor(compressionReads),
      delta: savedFor(deltaReads)
    },
    payloadByClass,
    baselineBytes,
    emittedBytes,
    savedBytes,
    savedPercent: baselineBytes === 0 ? 0 : Number(((savedBytes / baselineBytes) * 100).toFixed(2)),
    estimatedSavedTokens: Math.ceil(savedBytes / BYTES_PER_TOKEN_ESTIMATE),
    correctness: {
      changedContentAlwaysServed: changedReads.every((step) => step.servedFullContent),
      changedContentNeverReferenced: changedReads.every((step) => step.deliveryKind !== 'reference'),
      protectedArtifactsAlwaysServed: protectedReads.every((step) => step.servedFullContent),
      protectedReads: protectedReads.length,
      protectedReadsDeduplicated: protectedReads.filter((step) => step.deliveryKind === 'reference').length,
      protectedReadsTransformed: protectedReads.filter((step) => !step.servedFullContent).length
    },
    steps
  };
}

function classifyPayloadStep(step) {
  if (step.protectedArtifact) return 'protected';
  if (step.contentChanged) return 'changed';
  if (step.firstRead) return 'firstRead';
  if (step.belowThreshold) return 'belowThreshold';
  return 'exactRepeat';
}

async function runStep(mode, context) {
  if (mode === 'baseline') {
    return { emitted: context.read.content, decision: 'baseline-full', deliveryKind: 'full' };
  }

  if (mode === 'variant-a') {
    const result = await recordRead({
      filePath: context.read.path,
      content: context.read.content,
      rootDir: context.workspace,
      sessionId: context.sessionId,
      policy: context.policy
    });

    return {
      emitted: result.content ?? result.replay?.text ?? '',
      decision: result.decision,
      deliveryKind: result.decision === 'deduplicated' ? 'reference' : 'full'
    };
  }

  return runExternalStep(context);
}

async function runExternalStep(context) {
  if (!context.externalCommand) {
    throw new Error('External mode requires --external-command.');
  }

  const protocol = context.externalProtocol ?? 'sqz-text';
  await Promise.all([
    mkdir(path.join(context.workspace, '.external-home'), { recursive: true }),
    mkdir(path.join(context.workspace, '.external-tmp'), { recursive: true })
  ]);
  const payload = protocol === 'hook-json'
    ? JSON.stringify({
      session_id: context.sessionId,
      tool_name: 'Read',
      tool_input: { file_path: path.join(context.workspace, context.read.path) },
      tool_response: {
        type: 'text',
        file: { filePath: path.join(context.workspace, context.read.path), content: context.read.content }
      }
    })
    : context.read.content;
  const { stdout, code, timedOut, outputLimited } = await runCommand(context.externalCommand, payload, {
    cwd: context.workspace,
    env: isolatedExternalEnv(context.workspace, context.env),
    timeoutMs: context.externalTimeoutMs ?? DEFAULT_EXTERNAL_TIMEOUT_MS,
    maxOutputBytes: MAX_EXTERNAL_OUTPUT_BYTES
  });

  if (timedOut) {
    return { emitted: context.read.content, decision: 'external-timeout', deliveryKind: 'full' };
  }
  if (outputLimited) {
    return { emitted: context.read.content, decision: 'external-output-limit', deliveryKind: 'full' };
  }
  if (code !== 0 || !stdout.trim()) {
    return {
      emitted: context.read.content,
      decision: code === 0 ? 'external-passthrough' : 'external-error',
      deliveryKind: 'full'
    };
  }

  let updated = stdout;
  if (protocol === 'hook-json') {
    try {
      const parsed = JSON.parse(stdout);
      updated = parsed?.hookSpecificOutput?.updatedToolOutput;
    } catch {
      return { emitted: context.read.content, decision: 'external-unparsable', deliveryKind: 'full' };
    }
    if (typeof updated !== 'string') {
      return { emitted: context.read.content, decision: 'external-passthrough', deliveryKind: 'full' };
    }
  }

  if (updated === context.read.content) {
    return { emitted: updated, decision: 'external-full', deliveryKind: 'full' };
  }
  if (SQZ_REFERENCE_PATTERN.test(updated)) {
    return { emitted: updated, decision: 'external-reference', deliveryKind: 'reference' };
  }
  if (SQZ_DELTA_PATTERN.test(updated)) {
    return { emitted: updated, decision: 'external-delta', deliveryKind: 'delta' };
  }

  return { emitted: updated, decision: 'external-compressed', deliveryKind: 'compressed' };
}

function isolatedExternalEnv(workspace, overrides = {}) {
  const env = {};
  for (const key of ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  Object.assign(env, overrides);
  const isolatedHome = path.join(workspace, '.external-home');
  Object.assign(env, {
    HOME: isolatedHome,
    USERPROFILE: isolatedHome,
    TEMP: path.join(workspace, '.external-tmp'),
    TMP: path.join(workspace, '.external-tmp'),
    XDG_CACHE_HOME: path.join(isolatedHome, '.cache'),
    XDG_CONFIG_HOME: path.join(isolatedHome, '.config'),
    XDG_DATA_HOME: path.join(isolatedHome, '.local', 'share'),
    SQZ_HOME: path.join(isolatedHome, '.sqz')
  });
  return env;
}

function normalizeExternalCommand(command, args = []) {
  if (!command) return null;
  if (Array.isArray(command)) return command;
  return [command, ...(args ?? [])];
}

function runCommand(command, input, options) {
  const [bin, ...args] = Array.isArray(command) ? command : [command];

  return new Promise((resolve) => {
    const child = spawn(bin, args, {
      cwd: options.cwd,
      env: options.env,
      detached: process.platform !== 'win32',
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    let outputBytes = 0;
    let settled = false;
    let termination = null;
    let timer = null;
    let forceTimer = null;
    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(forceTimer);
      stdout += stdoutDecoder.end();
      stderr += stderrDecoder.end();
      resolve({ stdout, stderr, ...result });
    };
    const terminate = (result) => {
      if (termination) return;
      termination = result;
      killProcessTree(child);
      forceTimer = setTimeout(() => {
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
        finish(termination);
      }, 500);
      forceTimer.unref?.();
    };
    timer = setTimeout(() => {
      terminate({ code: 1, timedOut: true, outputLimited: false });
    }, options.timeoutMs);
    const collect = (stream, decoder, chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > options.maxOutputBytes) {
        terminate({ code: 1, timedOut: false, outputLimited: true });
        return stream;
      }
      return stream + decoder.write(chunk);
    };

    child.stdout.on('data', (chunk) => {
      stdout = collect(stdout, stdoutDecoder, chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr = collect(stderr, stderrDecoder, chunk);
    });
    child.on('error', () => finish(termination ?? { code: 1, timedOut: false, outputLimited: false }));
    child.on('close', (code) => finish(termination ?? {
      code: code ?? 0,
      timedOut: false,
      outputLimited: false
    }));

    child.stdin.end(input);
  });
}

function killProcessTree(child) {
  if (!child?.pid) {
    child?.kill('SIGKILL');
    return;
  }
  if (process.platform !== 'win32') {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
    return;
  }

  const killed = spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
    windowsHide: true,
    shell: false,
    stdio: 'ignore',
    timeout: 5_000
  });
  if (killed.error || killed.status !== 0) child.kill('SIGKILL');
}

async function writeConfig(workspace, mode) {
  const configPath = path.join(workspace, '.ai-factory', 'config.yaml');
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(
    configPath,
    ['aifhub:', '  artifactProtocol: openspec', '  contextDedup:', `    mode: ${mode === 'variant-a' ? 'aifhub' : '"off"'}`, '    minBytes: 2048', ''].join('\n'),
    'utf8'
  );
}

async function materialize(workspace, relativePath, content) {
  const absolute = path.resolve(workspace, relativePath);
  const relative = path.relative(workspace, absolute);
  if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
    throw new Error(`Trace path must be a safe project-relative path: ${relativePath}`);
  }
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
      results.push(await runBenchmark({
        mode,
        trace,
        externalCommand: args.externalCommand,
        externalArgs: args.externalArgs,
        externalProtocol: args.externalProtocol,
        externalTimeoutMs: args.externalTimeoutMs,
        sessionId: args.sessionId
      }));
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
  const lines = ['| mode | reads | emitted bytes | saved bytes | saved % | exact-repeat saved % | est. saved tokens | changed safe | protected served |', '|---|---|---|---|---|---|---|---|---|'];

  for (const result of results) {
    lines.push(
      `| ${result.mode} | ${result.reads} | ${result.emittedBytes} | ${result.savedBytes} | ${result.savedPercent} | ${result.payloadByClass.exactRepeat.savedPercent} | ${result.estimatedSavedTokens} | ${result.correctness.changedContentNeverReferenced ? 'yes' : 'NO'} | ${result.correctness.protectedArtifactsAlwaysServed ? 'yes' : 'NO'} |`
    );
  }

  return `${lines.join('\n')}\n`;
}

function parseArgs(argv) {
  const args = {
    modes: [],
    trace: null,
    externalCommand: null,
    externalArgs: [],
    externalProtocol: 'sqz-text',
    externalTimeoutMs: DEFAULT_EXTERNAL_TIMEOUT_MS,
    sessionId: 'benchmark',
    json: false,
    help: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--json') args.json = true;
    else if (arg === '--mode') args.modes.push(argv[++index]);
    else if (arg === '--trace') args.trace = argv[++index];
    else if (arg === '--external-command') args.externalCommand = argv[++index];
    else if (arg === '--external-arg') args.externalArgs.push(argv[++index]);
    else if (arg === '--external-protocol') args.externalProtocol = argv[++index];
    else if (arg === '--external-timeout-ms') args.externalTimeoutMs = Number(argv[++index]);
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
    '  --external-command <command>          Raw-stdin sqz-compatible executable for external mode.',
    '  --external-arg <argument>              Repeatable argument passed without a shell to the external command.',
    '  --external-protocol <sqz-text|hook-json>  Adapter protocol. Defaults to sqz-text.',
    '  --external-timeout-ms <milliseconds>  Per-read timeout. Defaults to 30000.',
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
