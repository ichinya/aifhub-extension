#!/usr/bin/env node
// memory-tool-field-run.mjs - isolated field runner for optional memory/context tools
import { execFile } from 'node:child_process';
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);

export const FIELD_RUN_SCHEMA = 'aifhub.memory_tools.field_run.v1';
export const SAFE_TOOL_IDS = [
  'rg',
  'git-gh',
  'codegraph',
  'graphify',
  'context7',
  'context-mode',
  'codex-agent-mem',
  'repowise'
];
export const SOURCE_DENYLIST_TOOL_IDS = new Set([
  'understand-anything'
]);
export const REJECTED_FULL_INSTALL_IDS = new Set([
  'codex-mem',
  'agent-memory',
  'eagle-mem',
  'rohitg00-agentmemory',
  'understand-anything'
]);

const DEFAULT_QUERIES = ['architecture', 'workflow', 'OpenSpec', 'TODO'];
const MANIFEST_NAMES = new Set([
  'package.json',
  'go.mod',
  'pyproject.toml',
  'requirements.txt',
  'Cargo.toml',
  'composer.json',
  'pom.xml',
  'build.gradle',
  'extension.json'
]);
const PROJECT_IGNORE_FILES = new Set([
  '.gitignore',
  '.dockerignore',
  '.ignore',
  '.rgignore',
  '.fdignore'
]);
const IGNORE_FILE_NAMES = new Set([
  '.aider.conf.yml',
  '.aider.model.settings.yml',
  '.aiderignore',
  '.cursorrules',
  '.mcp.json',
  '.opencode.json',
  '.roomodes',
  '.windsurfrules',
  'agents.md',
  'claude.md',
  'copilot-instructions.md',
  'gemini.md',
  'opencode.json'
]);
const IGNORE_DIR_NAMES = new Set([
  '.git',
  '.hg',
  '.svn',
  '.agents',
  '.codex',
  '.claude',
  '.opencode',
  '.cursor',
  '.continue',
  'node_modules',
  'vendor',
  'dist',
  'build',
  'coverage',
  '.ai-factory',
  '.cache',
  '.uv-cache',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.venv',
  'venv',
  '__pycache__',
  '.next',
  '.turbo',
  'target',
  'tmp',
  'temp',
  'logs',
  'runs',
  'graphify-out',
  '.codegraph',
  '.repowise',
  '.idea',
  '.vscode',
  '.windsurf',
  '.roo',
  '.kiro',
  '.qodo',
  '.aider',
  '.openhands'
]);
const IGNORE_DIR_PATHS = new Set([
  '.github/skills',
  '.github/copilot'
]);
const LOCK_FILE_NAMES = new Set([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb',
  'Cargo.lock',
  'composer.lock',
  'poetry.lock',
  'Pipfile.lock',
  'uv.lock'
]);

export async function runMemoryToolFieldRun(args = [], options = {}) {
  const parsed = parseArgs(args);
  if (parsed.help) {
    return emitText(getCliUsage(), 0, options);
  }

  const outDir = path.resolve(parsed.out ?? await mkdtemp(path.join(os.tmpdir(), 'aifhub-memory-tools-')));
  await mkdir(outDir, { recursive: true });

  const rootInputs = parsed.roots.length > 0 ? parsed.roots : [process.cwd()];
  const tools = getToolPlan(parsed.tools);
  const profiles = await discoverProjectRoots(rootInputs, {
    maxProfiles: parsed.maxProfiles,
    excludeRoots: parsed.excludeRoots
  });
  const selectedProfiles = parsed.dryRun ? profiles : profiles;
  const toolResults = [];
  const copies = [];

  if (!parsed.dryRun) {
    for (const profile of selectedProfiles) {
      const copy = await prepareSanitizedCopy({ profile, outDir });
      copies.push(copy);
    }
  }

  const runtime = {
    outDir,
    copies,
    toolsDir: path.join(outDir, 'tools'),
    timeoutMs: parsed.timeoutMs,
    python: parsed.python,
    npm: parsed.npm
  };
  await mkdir(runtime.toolsDir, { recursive: true });

  for (const tool of tools) {
    const result = parsed.dryRun
      ? dryRunToolResult(tool)
      : await runTool(tool, runtime);
    toolResults.push(result);
  }

  const summary = buildPublicRunSummary({
    profiles: selectedProfiles,
    rootInputs,
    tools,
    toolResults,
    copies,
    outDir,
    dryRun: parsed.dryRun
  });

  if (hasSensitivePathLeak(summary, rootInputs)) {
    throw new Error('Public field-run summary contains a sensitive local path.');
  }

  if (parsed.writeJson) {
    const outputPath = path.join(outDir, 'field-run-summary.json');
    assertWithinDirectory(outDir, outputPath, 'field-run summary');
    await writeFile(outputPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  }

  return emit(summary, 0, options);
}

export async function discoverProjectRoots(rootInputs, options = {}) {
  const roots = [];
  const seen = new Set();
  const maxProfiles = Number.isFinite(options.maxProfiles) && options.maxProfiles >= 0
    ? options.maxProfiles
    : null;
  const excludeRoots = asArray(options.excludeRoots).map((item) => path.resolve(item));

  for (const input of rootInputs) {
    const root = path.resolve(input);
    if (!await pathExists(root)) continue;
    if (isExcludedPath(root, excludeRoots)) continue;
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);

    if (await isProjectRoot(root)) {
      addRoot(roots, seen, root, excludeRoots);
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || shouldIgnoreDirectoryPath(entry.name)) continue;
      const candidate = path.join(root, entry.name);
      if (isExcludedPath(candidate, excludeRoots)) continue;
      if (await isProjectRoot(candidate)) {
        addRoot(roots, seen, candidate, excludeRoots);
      }
      for (const nested of await findNestedProjectRoots(candidate, { maxDepth: 3 })) {
        addRoot(roots, seen, nested, excludeRoots);
      }
    }
  }

  const limited = maxProfiles !== null ? roots.slice(0, maxProfiles) : roots;
  return limited.map((sourceRoot, index) => ({
    id: `field-profile-${String(index + 1).padStart(2, '0')}`,
    sourceRoot,
    shape: classifyShapeFromPath(sourceRoot),
    source_kind: 'local-project-root'
  }));
}

export async function prepareSanitizedCopy({ profile, outDir }) {
  const resolvedOutDir = path.resolve(outDir);
  const copyPath = path.join(resolvedOutDir, 'fixtures', profile.id);
  assertWithinDirectory(resolvedOutDir, copyPath, 'sanitized copy');
  await safeRemoveWithin(resolvedOutDir, copyPath);
  await mkdir(copyPath, { recursive: true });
  await copySanitizedDirectory(profile.sourceRoot, copyPath);

  return {
    profile_id: profile.id,
    copyPath,
    copied: true
  };
}

export function getToolPlan(scope = 'safe') {
  if (scope !== 'safe') {
    throw new Error(`Unsupported tool scope: ${scope}`);
  }
  return [
    { id: 'rg', fullInstall: false, role: 'baseline_search' },
    { id: 'git-gh', fullInstall: false, role: 'read_only_repo_context' },
    { id: 'codegraph', fullInstall: false, role: 'repo_graph_cli' },
    { id: 'repowise', fullInstall: false, role: 'repo_intelligence_cli' },
    { id: 'graphify', fullInstall: true, role: 'repo_graph_ast' },
    { id: 'context7', fullInstall: true, role: 'docs_lookup' },
    { id: 'context-mode', fullInstall: false, role: 'dedicated_harness_only' },
    { id: 'codex-agent-mem', fullInstall: false, role: 'continuity_memory_probe' }
  ].filter((tool) => !REJECTED_FULL_INSTALL_IDS.has(tool.id) && !SOURCE_DENYLIST_TOOL_IDS.has(tool.id));
}

export function getProfileLifecycleRunStatus(profiles = [], passKey = 'lifecycle_passed') {
  return profiles.some((profile) => Boolean(profile?.[passKey])) ? 'pass' : 'degraded';
}

export function getContext7RunStatus({ helpExitCode, docsLookup } = {}) {
  return helpExitCode === 0 || docsLookup?.passed === true ? 'pass' : 'degraded';
}

export function buildPublicRunSummary({
  profiles = [],
  rootInputs = [],
  tools = [],
  toolResults = [],
  copies = [],
  outDir = null,
  dryRun = false
} = {}) {
  const copyByProfile = new Map(copies.map((copy) => [copy.profile_id, copy]));
  return {
    schema: FIELD_RUN_SCHEMA,
    generated_at: new Date().toISOString(),
    dry_run: Boolean(dryRun),
    root_input_count: rootInputs.length,
    output_scope: outDir ? 'temp-run-dir' : null,
    profiles: profiles.map((profile) => {
      const copy = copyByProfile.get(profile.id);
      return {
        id: profile.id,
        shape: profile.shape,
        source_kind: profile.source_kind,
        copied: Boolean(copy?.copied)
      };
    }),
    tools: tools.map((tool) => ({
      id: tool.id,
      role: tool.role,
      full_install: Boolean(tool.fullInstall)
    })),
    results: toolResults.map(sanitizeToolResult)
  };
}

export function hasSensitivePathLeak(value, roots = []) {
  const encoded = JSON.stringify(value);
  const normalizedEncoded = normalizeForLeakCheck(encoded);
  const sensitiveRoots = roots.map((root) => normalizeForLeakCheck(path.resolve(root)));

  if (/[A-Za-z]:[\\/]{2}?projects[\\/]/i.test(encoded) || /C:\\\\projects\\\\/i.test(encoded)) {
    return true;
  }

  return sensitiveRoots.some((root) => root && normalizedEncoded.includes(root));
}

export function assertWithinDirectory(baseDir, targetPath, label = 'target') {
  const base = path.resolve(baseDir);
  const target = path.resolve(targetPath);
  const relative = path.relative(base, target);
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    return target;
  }
  throw new Error(`${label} resolves outside the selected run directory.`);
}

export async function safeRemoveWithin(baseDir, targetPath) {
  const target = assertWithinDirectory(baseDir, targetPath, 'delete target');
  await rm(target, { recursive: true, force: true });
}

async function runTool(tool, runtime) {
  try {
    if (tool.id === 'rg') return await runRgBaseline(tool, runtime);
    if (tool.id === 'git-gh') return await runGitGhProbe(tool, runtime);
    if (tool.id === 'codegraph') return await runCodeGraph(tool, runtime);
    if (tool.id === 'repowise') return await runRepowise(tool, runtime);
    if (tool.id === 'graphify') return await runGraphify(tool, runtime);
    if (tool.id === 'context7') return await runContext7(tool, runtime);
    if (tool.id === 'context-mode') return await runContextMode(tool, runtime);
    if (tool.id === 'codex-agent-mem') return await runCodexAgentMem(tool, runtime);
    return skipped(tool, 'unsupported-tool');
  } catch (err) {
    return {
      tool_id: tool.id,
      status: 'error',
      message: err?.message ?? String(err)
    };
  }
}

async function runRgBaseline(tool, runtime) {
  const profiles = [];
  for (const copy of runtime.copies) {
    const started = performance.now();
    const files = await execSafe('rg', ['--files', '.'], { cwd: copy.copyPath, timeoutMs: runtime.timeoutMs });
    const queryResults = [];
    for (const query of DEFAULT_QUERIES) {
      const queryStart = performance.now();
      const result = await execSafe('rg', ['-n', '--max-count', '80', query, '.'], {
        cwd: copy.copyPath,
        timeoutMs: runtime.timeoutMs,
        allowFailure: true
      });
      const chars = `${result.stdout}\n${result.stderr}`.length;
      queryResults.push({
        query,
        exit_code: result.exitCode,
        elapsed_ms: elapsedMs(queryStart),
        output_chars: chars,
        token_estimate: Math.ceil(chars / 4)
      });
    }
    profiles.push({
      profile_id: copy.profile_id,
      elapsed_ms: elapsedMs(started),
      file_count: splitLines(files.stdout).length,
      queries: queryResults
    });
  }
  return { tool_id: tool.id, status: 'pass', profiles };
}

async function runGitGhProbe(tool, runtime) {
  const git = await execSafe('git', ['--version'], { timeoutMs: runtime.timeoutMs, allowFailure: true });
  const gh = await execSafe('gh', ['--version'], { timeoutMs: runtime.timeoutMs, allowFailure: true });
  return {
    tool_id: tool.id,
    status: git.exitCode === 0 || gh.exitCode === 0 ? 'pass' : 'degraded',
    git_available: git.exitCode === 0,
    gh_available: gh.exitCode === 0,
    notes: 'availability probe only; no GitHub or git mutations'
  };
}

async function runCodeGraph(tool, runtime) {
  const codegraph = defaultCommandName('codegraph');
  const version = await execCommandShim(codegraph, ['--version'], { timeoutMs: runtime.timeoutMs, allowFailure: true });
  const npmVersion = await execNpm(runtime, ['view', '@colbymchenry/codegraph', 'version'], {
    timeoutMs: runtime.timeoutMs,
    allowFailure: true
  });

  if (version.exitCode !== 0) {
    return {
      tool_id: tool.id,
      status: 'unavailable',
      installed_available: false,
      npm_version: firstLine(npmVersion.stdout)
    };
  }

  const profiles = [];
  for (const copy of runtime.copies) {
    const started = performance.now();
    const init = await execCommandShim(codegraph, ['init', copy.copyPath], {
      timeoutMs: runtime.timeoutMs,
      allowFailure: true
    });
    const index = init.exitCode === 0
      ? await execCommandShim(codegraph, ['index', '--quiet', copy.copyPath], {
        timeoutMs: Math.max(runtime.timeoutMs, 120000),
        allowFailure: true
      })
      : { exitCode: 1 };
    const query = index.exitCode === 0
      ? await execCommandShim(codegraph, ['query', '--path', copy.copyPath, '--limit', '3', '--json', 'main'], {
        timeoutMs: runtime.timeoutMs,
        allowFailure: true
      })
      : { exitCode: 1, stdout: '' };
    const purge = await execCommandShim(codegraph, ['uninit', '--force', copy.copyPath], {
      timeoutMs: runtime.timeoutMs,
      allowFailure: true
    });
    profiles.push({
      profile_id: copy.profile_id,
      elapsed_ms: elapsedMs(started),
      lifecycle_passed: init.exitCode === 0 && index.exitCode === 0 && query.exitCode === 0 && purge.exitCode === 0,
      query_output_chars: String(query.stdout ?? '').length,
      purge_passed: purge.exitCode === 0
    });
  }

  return {
    tool_id: tool.id,
    status: getProfileLifecycleRunStatus(profiles),
    installed_version: firstLine(version.stdout),
    npm_version: firstLine(npmVersion.stdout),
    profiles
  };
}

async function runRepowise(tool, runtime) {
  const repowise = defaultCommandName('repowise');
  const version = await execCommandShim(repowise, ['--version'], { timeoutMs: runtime.timeoutMs, allowFailure: true });
  const doctor = await execCommandShim(repowise, ['doctor'], { timeoutMs: runtime.timeoutMs, allowFailure: true });

  if (version.exitCode !== 0) {
    return {
      tool_id: tool.id,
      status: 'unavailable',
      installed_available: false,
      doctor: doctor.exitCode === 0 ? 'ok' : 'unavailable'
    };
  }

  const profiles = [];
  for (const copy of runtime.copies) {
    const started = performance.now();
    // Tier 0: deterministic index-only init (zero LLM, zero API keys)
    const init = await execCommandShim(repowise, [
      'init', copy.copyPath,
      '--index-only',
      '--no-claude-md', '--no-agents', '--no-codex', '--no-distill-hook',
      '--yes'
    ], {
      cwd: copy.copyPath,
      timeoutMs: Math.max(runtime.timeoutMs, 180000),
      allowFailure: true
    });
    // Data probe: symbol search over the freshly built index
    const search = init.exitCode === 0
      ? await execCommandShim(repowise, ['search', 'main', '--mode', 'symbol', '--limit', '5'], {
        cwd: copy.copyPath,
        timeoutMs: runtime.timeoutMs,
        allowFailure: true
      })
      : { exitCode: 1, stdout: '' };
    // Two-stage purge: registry removal + filesystem cleanup.
    // `delete --force` still prompts interactively; feed `1\n` via shell wrapper.
    const deleteCmd = process.platform === 'win32'
      ? process.env.ComSpec || 'cmd.exe'
      : 'sh';
    const deleteArgs = process.platform === 'win32'
      ? ['/d', '/s', '/c', `echo 1| "${repowise.replace(/"/g, '""')}" delete -p . --force`]
      : ['-c', `printf '1\\n' | "${repowise}" delete -p . --force`];
    const registryPurge = await execSafe(deleteCmd, deleteArgs, {
      cwd: copy.copyPath,
      timeoutMs: runtime.timeoutMs,
      allowFailure: true
    });
    // Filesystem purge: remove .repowise/ index and project-local .mcp.json
    const repowiseDir = path.join(copy.copyPath, '.repowise');
    const repowiseExisted = await pathExists(repowiseDir);
    await safeRemoveWithin(copy.copyPath, repowiseDir);
    await safeRemoveWithin(copy.copyPath, path.join(copy.copyPath, '.mcp.json'));
    const fsPurgePassed = !await pathExists(repowiseDir);
    profiles.push({
      profile_id: copy.profile_id,
      elapsed_ms: elapsedMs(started),
      lifecycle_passed: init.exitCode === 0 && search.exitCode === 0 && registryPurge.exitCode === 0 && fsPurgePassed,
      search_output_chars: String(search.stdout ?? '').length,
      registry_purge_passed: registryPurge.exitCode === 0,
      filesystem_purge_passed: fsPurgePassed,
      repowise_dir_existed: repowiseExisted
    });
  }

  return {
    tool_id: tool.id,
    status: getProfileLifecycleRunStatus(profiles),
    installed_version: firstLine(version.stdout),
    doctor_status: doctor.exitCode === 0 ? 'ok' : 'unavailable',
    profiles
  };
}

async function runGraphify(tool, runtime) {
  const python = runtime.python ?? process.env.AIFHUB_FIELD_PYTHON ?? 'python';
  const venvDir = path.join(runtime.toolsDir, 'graphify-venv');
  assertWithinDirectory(runtime.toolsDir, venvDir, 'graphify venv');

  const venv = await execSafe(python, ['-m', 'venv', venvDir], {
    timeoutMs: 120000,
    allowFailure: true
  });
  if (venv.exitCode !== 0) {
    return { tool_id: tool.id, status: 'unavailable', reason: 'python-venv-failed' };
  }

  const pip = path.join(venvDir, process.platform === 'win32' ? 'Scripts' : 'bin', process.platform === 'win32' ? 'pip.exe' : 'pip');
  const graphify = path.join(venvDir, process.platform === 'win32' ? 'Scripts' : 'bin', process.platform === 'win32' ? 'graphify.exe' : 'graphify');
  const install = await execSafe(pip, ['install', 'graphifyy'], {
    timeoutMs: 240000,
    allowFailure: true
  });
  if (install.exitCode !== 0) {
    return { tool_id: tool.id, status: 'unavailable', reason: 'temp-install-failed' };
  }

  const version = await execSafe(graphify, ['--version'], { timeoutMs: runtime.timeoutMs, allowFailure: true });
  const profiles = [];
  for (const copy of runtime.copies) {
    const started = performance.now();
    const update = await execSafe(graphify, ['update', '.', '--no-cluster'], {
      cwd: copy.copyPath,
      timeoutMs: Math.max(runtime.timeoutMs, 180000),
      allowFailure: true
    });
    const graphifyOut = path.join(copy.copyPath, 'graphify-out');
    const graphExists = await pathExists(path.join(graphifyOut, 'graph.json'));
    await safeRemoveWithin(copy.copyPath, graphifyOut);
    profiles.push({
      profile_id: copy.profile_id,
      elapsed_ms: elapsedMs(started),
      ast_update_passed: update.exitCode === 0,
      graph_json_created: graphExists,
      cleanup_passed: !await pathExists(graphifyOut)
    });
  }

  return {
    tool_id: tool.id,
    status: profiles.some((profile) => profile.ast_update_passed) ? 'pass' : 'degraded',
    version: firstLine(version.stdout || version.stderr),
    profiles
  };
}

async function runContext7(tool, runtime) {
  const prefix = path.join(runtime.toolsDir, 'context7');
  assertWithinDirectory(runtime.toolsDir, prefix, 'context7 install prefix');
  await mkdir(prefix, { recursive: true });
  const registry = await execNpm(runtime, ['view', 'ctx7', 'version'], {
    timeoutMs: runtime.timeoutMs,
    allowFailure: true
  });
  const install = await execNpm(runtime, ['install', '--prefix', prefix, 'ctx7'], {
    timeoutMs: 180000,
    allowFailure: true
  });
  if (install.exitCode !== 0) {
    return {
      tool_id: tool.id,
      status: 'unavailable',
      npm_version: firstLine(registry.stdout),
      reason: 'temp-install-failed'
    };
  }

  const cli = npmBin(prefix, 'ctx7');
  const help = await execCommandShim(cli, ['--help'], { timeoutMs: runtime.timeoutMs, allowFailure: true });
  const docsLookup = await runContext7Lookup(cli, runtime);
  return {
    tool_id: tool.id,
    status: getContext7RunStatus({ helpExitCode: help.exitCode, docsLookup }),
    npm_version: firstLine(registry.stdout),
    help_available: help.exitCode === 0,
    docs_lookup: docsLookup
  };
}

async function runContextMode(tool, runtime) {
  return getContextModeGenericRouteStatus(tool);
}

export function getContextModeGenericRouteStatus(tool = { id: 'context-mode' }) {
  return {
    tool_id: tool.id,
    status: 'unavailable',
    reason: 'dedicated_harness_required',
    issue: 134,
    notes: 'Use the pinned isolated context-mode Codex harness; the generic floating install route is disabled.'
  };
}

async function runCodexAgentMem(tool, runtime) {
  const python = runtime.python ?? process.env.AIFHUB_FIELD_PYTHON ?? 'python';
  const pypi = await execSafe(python, ['-m', 'pip', 'index', 'versions', 'codex-agent-mem'], {
    timeoutMs: runtime.timeoutMs,
    allowFailure: true
  });

  const cloneDir = path.join(runtime.toolsDir, 'codex-agent-mem-repo');
  assertWithinDirectory(runtime.toolsDir, cloneDir, 'codex-agent-mem clone');
  await safeRemoveWithin(runtime.toolsDir, cloneDir);
  const clone = await execSafe('git', [
    'clone',
    '--depth',
    '1',
    'https://github.com/MarceloCaporale/codex-agent-mem.git',
    cloneDir
  ], {
    timeoutMs: 120000,
    allowFailure: true
  });
  const pyproject = clone.exitCode === 0
    ? await readPyprojectSummary(path.join(cloneDir, 'pyproject.toml'))
    : null;
  return {
    tool_id: tool.id,
    status: clone.exitCode === 0 && pyproject ? 'pass' : 'unavailable',
    pypi_available: pypi.exitCode === 0,
    pypi_version: firstLine(pypi.stdout),
    repo_clone_available: clone.exitCode === 0,
    package: pyproject,
    notes: 'Python package source inspected from GitHub; PyPI registry package may be unavailable. No source indexing was run.'
  };
}

async function runContext7Lookup(cli, runtime) {
  const dependency = await detectFirstPackageDependency(runtime.copies);
  if (!dependency) {
    return { attempted: false, reason: 'no-package-dependency-detected' };
  }
  const lookup = await execCommandShim(cli, ['library', dependency, 'api'], {
    timeoutMs: runtime.timeoutMs,
    allowFailure: true
  });
  return {
    attempted: true,
    dependency,
    exit_code: lookup.exitCode,
    output_chars: `${lookup.stdout}\n${lookup.stderr}`.length,
    passed: lookup.exitCode === 0
  };
}

async function detectFirstPackageDependency(copies) {
  for (const copy of copies) {
    const packagePath = path.join(copy.copyPath, 'package.json');
    if (!await pathExists(packagePath)) continue;
    try {
      const parsed = JSON.parse(await readFile(packagePath, 'utf8'));
      const deps = {
        ...(parsed.dependencies ?? {}),
        ...(parsed.devDependencies ?? {})
      };
      const first = Object.keys(deps).find((name) => !name.startsWith('@types/'));
      if (first) return first;
    } catch {
      // Ignore malformed package files in field fixtures.
    }
  }
  return null;
}

async function readPackageJsonSummary(packagePath) {
  try {
    const parsed = JSON.parse(await readFile(packagePath, 'utf8'));
    return {
      name: parsed.name ?? null,
      version: parsed.version ?? null,
      bin_keys: parsed.bin && typeof parsed.bin === 'object' ? Object.keys(parsed.bin) : []
    };
  } catch {
    return null;
  }
}

async function readPyprojectSummary(pyprojectPath) {
  try {
    const content = await readFile(pyprojectPath, 'utf8');
    const scripts = [];
    const scriptPattern = /^\s*([A-Za-z0-9_.-]+)\s*=/gm;
    const scriptsBlock = content.match(/\[project\.scripts\]([\s\S]*?)(?:\n\[|$)/);
    if (scriptsBlock) {
      let match;
      while ((match = scriptPattern.exec(scriptsBlock[1])) !== null) {
        scripts.push(match[1]);
      }
    }
    return {
      name: firstRegexCapture(content, /^\s*name\s*=\s*"([^"]+)"/m),
      version: firstRegexCapture(content, /^\s*version\s*=\s*"([^"]+)"/m),
      scripts
    };
  } catch {
    return null;
  }
}

function firstRegexCapture(value, pattern) {
  return value.match(pattern)?.[1] ?? null;
}

function dryRunToolResult(tool) {
  return {
    tool_id: tool.id,
    status: 'dry-run',
    notes: 'tool was not executed'
  };
}

function skipped(tool, reason) {
  return {
    tool_id: tool.id,
    status: 'skipped',
    reason
  };
}

function sanitizeToolResult(result) {
  return JSON.parse(JSON.stringify(result, (key, value) => {
    if (typeof value !== 'string') return value;
    if (/^[A-Za-z]:[\\/]/.test(value)) return '[redacted-local-path]';
    return value;
  }));
}

async function copySanitizedDirectory(sourceDir, targetDir, relativeDir = '', inheritedIgnoreRules = []) {
  const localIgnoreRules = await loadProjectIgnoreRules(sourceDir, relativeDir);
  const activeIgnoreRules = [...inheritedIgnoreRules, ...localIgnoreRules];
  const entries = await readdir(sourceDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const relativePath = toPosix(relativeDir ? path.join(relativeDir, entry.name) : entry.name);
    if (
      shouldIgnoreEntry(entry.name, entry.isDirectory(), relativePath)
      || shouldIgnoreByProjectRules(relativePath, entry.isDirectory(), activeIgnoreRules)
    ) {
      continue;
    }
    const source = path.join(sourceDir, entry.name);
    const target = path.join(targetDir, entry.name);
    const stats = await lstat(source).catch(() => null);
    if (!stats || stats.isSymbolicLink()) continue;
    if (stats.isDirectory()) {
      await mkdir(target, { recursive: true });
      await copySanitizedDirectory(source, target, relativePath, activeIgnoreRules);
    } else if (stats.isFile()) {
      await mkdir(path.dirname(target), { recursive: true });
      await cp(source, target, { force: false });
    }
  }
}

async function findNestedProjectRoots(root, options = {}) {
  const results = [];
  const maxDepth = options.maxDepth ?? 3;
  async function walk(current, depth) {
    if (depth > maxDepth) return;
    const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const relativePath = toPosix(path.relative(root, path.join(current, entry.name)));
      if (!entry.isDirectory() || shouldIgnoreDirectoryPath(relativePath)) continue;
      const candidate = path.join(current, entry.name);
      if (await isProjectRoot(candidate)) {
        results.push(candidate);
        continue;
      }
      await walk(candidate, depth + 1);
    }
  }
  await walk(root, 1);
  return results;
}

async function isProjectRoot(candidate) {
  if (await pathExists(path.join(candidate, '.git'))) return true;
  for (const manifest of MANIFEST_NAMES) {
    if (await pathExists(path.join(candidate, manifest))) return true;
  }
  return false;
}

function addRoot(roots, seen, root, excludeRoots = []) {
  const resolved = path.resolve(root);
  if (isExcludedPath(resolved, excludeRoots)) return;
  const key = resolved.toLowerCase();
  if (seen.has(key)) return;
  seen.add(key);
  roots.push(resolved);
}

function isExcludedPath(candidate, excludeRoots = []) {
  const resolved = path.resolve(candidate);
  const normalized = normalizePathForCompare(resolved);
  return excludeRoots.some((root) => {
    const normalizedRoot = normalizePathForCompare(path.resolve(root));
    return normalized === normalizedRoot || normalized.startsWith(`${normalizedRoot}${path.sep}`);
  });
}

function normalizePathForCompare(value) {
  return process.platform === 'win32' ? String(value).toLowerCase() : String(value);
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null || value === '') return [];
  return [value];
}

function classifyShapeFromPath(sourceRoot) {
  const name = path.basename(sourceRoot).toLowerCase();
  if (/workspace|mono|multi/.test(name)) return 'multirepo';
  if (/service|api|mcp/.test(name)) return 'go_service';
  if (/test|tmp|stub/.test(name)) return 'small_microservice';
  return 'large_framework_app';
}

function shouldIgnoreEntry(name, isDirectory, relativePath = name) {
  if (isDirectory) return shouldIgnoreDirectoryPath(relativePath);
  const lowerName = String(name).toLowerCase();
  const lowerPath = toPosix(relativePath).toLowerCase();
  return name.startsWith('.env')
    || LOCK_FILE_NAMES.has(name)
    || IGNORE_FILE_NAMES.has(lowerName)
    || lowerPath.endsWith('.code-workspace')
    || lowerPath.endsWith('.log');
}

function shouldIgnoreDirectory(name) {
  return IGNORE_DIR_NAMES.has(name) || name.startsWith('.env');
}

function shouldIgnoreDirectoryPath(relativePath) {
  const normalized = toPosix(relativePath).toLowerCase();
  if (IGNORE_DIR_PATHS.has(normalized)) return true;
  for (const ignored of IGNORE_DIR_PATHS) {
    if (normalized.startsWith(`${ignored}/`)) return true;
  }
  return normalized.split('/').some((part) => shouldIgnoreDirectory(part));
}

async function loadProjectIgnoreRules(currentDir, relativeDir) {
  const rules = [];
  for (const ignoreFileName of PROJECT_IGNORE_FILES) {
    let raw;
    try {
      raw = await readFile(path.join(currentDir, ignoreFileName), 'utf8');
    } catch {
      continue;
    }
    rules.push(...parseProjectIgnoreRules(raw, {
      baseDir: toPosix(relativeDir)
    }));
  }
  return rules;
}

function parseProjectIgnoreRules(raw, options = {}) {
  const baseDir = toPosix(options.baseDir ?? '');
  const rules = [];
  for (const rawLine of String(raw ?? '').split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    let pattern = trimmed;
    let negated = false;
    if (pattern.startsWith('!')) {
      negated = true;
      pattern = pattern.slice(1).trim();
    }
    if (!pattern) continue;
    if (pattern.startsWith('\\#') || pattern.startsWith('\\!')) pattern = pattern.slice(1);
    const directoryOnly = pattern.endsWith('/');
    pattern = toPosix(pattern)
      .replace(/^\/+/, '')
      .replace(/^\.\//, '')
      .replace(/\/+$/, '');
    if (!pattern) continue;
    rules.push({
      baseDir,
      pattern: pattern.toLowerCase(),
      negated,
      directoryOnly,
      hasSlash: pattern.includes('/'),
      hasGlob: /[*?\[]/.test(pattern)
    });
  }
  return rules;
}

function shouldIgnoreByProjectRules(relativePath, isDirectory, rules) {
  let ignored = false;
  for (const rule of rules) {
    if (projectIgnoreRuleMatches(rule, relativePath, isDirectory)) {
      ignored = !rule.negated;
    }
  }
  return ignored;
}

function projectIgnoreRuleMatches(rule, relativePath, isDirectory) {
  const pathInProject = toPosix(relativePath).toLowerCase();
  const pathInBase = pathRelativeToIgnoreBase(pathInProject, rule.baseDir);
  if (pathInBase === null || pathInBase === '') return false;

  if (!rule.hasSlash) {
    return pathInBase.split('/').some((part) => ignorePatternMatches(rule, part, isDirectory));
  }

  if (rule.directoryOnly && !rule.hasGlob) {
    return pathInBase === rule.pattern || pathInBase.startsWith(`${rule.pattern}/`);
  }

  if (!rule.hasGlob) return pathInBase === rule.pattern;

  return globToRegExp(rule.pattern).test(pathInBase);
}

function pathRelativeToIgnoreBase(relativePath, baseDir) {
  if (!baseDir) return relativePath;
  if (relativePath === baseDir) return '';
  return relativePath.startsWith(`${baseDir}/`)
    ? relativePath.slice(baseDir.length + 1)
    : null;
}

function ignorePatternMatches(rule, value, isDirectory) {
  if (rule.directoryOnly && !isDirectory) return value === rule.pattern;
  if (rule.hasGlob) return globToRegExp(rule.pattern).test(value);
  return value === rule.pattern;
}

function globToRegExp(pattern) {
  let source = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        if (pattern[index + 2] === '/') {
          source += '(?:.*/)?';
          index += 2;
        } else {
          source += '.*';
          index += 1;
        }
      } else {
        source += '[^/]*';
      }
      continue;
    }
    if (char === '?') {
      source += '[^/]';
      continue;
    }
    source += escapeRegExp(char);
  }
  return new RegExp(`^${source}$`, 'i');
}

function escapeRegExp(value) {
  return String(value).replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
}

function toPosix(value) {
  return String(value).replace(/\\/g, '/');
}

async function execSafe(command, args = [], options = {}) {
  const started = performance.now();
  try {
    const result = await execFileAsync(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...(options.env ?? {}) },
      windowsHide: true,
      timeout: options.timeoutMs ?? 30000,
      maxBuffer: 2 * 1024 * 1024
    });
    return {
      exitCode: 0,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      elapsed_ms: elapsedMs(started)
    };
  } catch (err) {
    if (!options.allowFailure) throw err;
    return {
      exitCode: typeof err?.code === 'number' ? err.code : 1,
      stdout: err?.stdout ?? '',
      stderr: err?.stderr ?? err?.message ?? String(err),
      elapsed_ms: elapsedMs(started)
    };
  }
}

async function execCommandShim(commandPath, args = [], options = {}) {
  if (process.platform === 'win32' && commandPath.endsWith('.cmd')) {
    return execSafe(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', quoteCmd(commandPath, args)], options);
  }
  return execSafe(commandPath, args, options);
}

async function execNpm(runtime, args, options = {}) {
  return execCommandShim(runtime.npm ?? defaultCommandName('npm'), args, options);
}

function defaultCommandName(commandName) {
  return process.platform === 'win32' ? `${commandName}.cmd` : commandName;
}

function npmBin(prefix, commandName) {
  return path.join(
    prefix,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? `${commandName}.cmd` : commandName
  );
}

function quoteCmd(commandPath, args) {
  return [quoteCmdToken(commandPath), ...args.map(quoteCmdToken)].join(' ');
}

function quoteCmdToken(value) {
  const token = String(value);
  if (!/[\s&()^|<>"]/.test(token)) return token;
  return `"${token.replaceAll('"', '""')}"`;
}

function parseArgs(args) {
  const parsed = {
    help: false,
    roots: [],
    excludeRoots: [],
    out: null,
    tools: 'safe',
    json: false,
    writeJson: true,
    dryRun: false,
    maxProfiles: null,
    timeoutMs: 30000,
    python: null,
    npm: null
  };

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === '--help' || token === '-h') {
      parsed.help = true;
    } else if (token === '--roots') {
      parsed.roots.push(args[++index]);
    } else if (token === '--exclude-root') {
      parsed.excludeRoots.push(args[++index]);
    } else if (token === '--out') {
      parsed.out = args[++index];
    } else if (token === '--tools') {
      parsed.tools = args[++index];
    } else if (token === '--json') {
      parsed.json = true;
    } else if (token === '--no-write-json') {
      parsed.writeJson = false;
    } else if (token === '--dry-run') {
      parsed.dryRun = true;
    } else if (token === '--max-profiles') {
      parsed.maxProfiles = Number(args[++index]);
    } else if (token === '--timeout-ms') {
      parsed.timeoutMs = Number(args[++index]);
    } else if (token === '--python') {
      parsed.python = args[++index];
    } else if (token === '--npm') {
      parsed.npm = args[++index];
    }
  }
  return parsed;
}

export function getCliUsage() {
  return [
    'Usage: node scripts/memory-tool-field-run.mjs --roots <dir> --out <temp-run-dir> --tools safe --json',
    '',
    'Options:',
    '  --roots <dir>         Root directory to discover project profiles from. Repeatable.',
    '  --exclude-root <dir>  Exclude this root and all nested project profiles. Repeatable.',
    '  --out <dir>           Temp run directory for sanitized copies, tool installs, and JSON output.',
    '  --tools safe          Run the safe optional-context-tool set.',
    '  --json                Emit public JSON summary to stdout.',
    '  --no-write-json       Do not write field-run-summary.json under --out.',
    '  --dry-run             Discover profiles and planned tools without copying or installing.',
    '  --max-profiles <n>    Limit profiles for smoke tests.',
    '  --timeout-ms <n>      Per-command timeout.',
    '  --python <path>       Python executable for temp Graphify venv.',
    '  --npm <path>          npm executable for temp npm-prefix installs.'
  ].join('\n');
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

function emitText(text, exitCode, options = {}) {
  const output = `${text}\n`;
  if (Array.isArray(options.stdout)) {
    options.stdout.push(output);
  } else if (options.stdout && typeof options.stdout.write === 'function') {
    options.stdout.write(output);
  } else {
    process.stdout.write(output);
  }
  if (options.exit !== false) process.exitCode = exitCode;
  return { exitCode, body: text };
}

function normalizeForLeakCheck(value) {
  return String(value ?? '').replaceAll('\\\\', '/').replaceAll('\\', '/').toLowerCase();
}

async function pathExists(targetPath) {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

function splitLines(value) {
  return String(value ?? '').split(/\r?\n/).filter(Boolean);
}

function firstLine(value) {
  return splitLines(value)[0] ?? null;
}

function elapsedMs(started) {
  return Math.round((performance.now() - started) * 10) / 10;
}

function isDirectRun() {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isDirectRun()) {
  const result = await runMemoryToolFieldRun(process.argv.slice(2));
  process.exit(result.exitCode);
}
