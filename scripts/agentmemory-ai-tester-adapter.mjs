// agentmemory-ai-tester-adapter.mjs - isolated runtime probe for ai-tester only
import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const AGENTMEMORY_MCP_VERSION = '0.9.28';
export const AGENTMEMORY_INSTALL_TIMEOUT_MS = 300000;
export const AGENTMEMORY_ADAPTER_SCHEMA = 'aifhub.agentmemory.ai_tester_adapter.v1';

const INHERITED_ENV_KEYS = [
  'PATH',
  'SystemRoot',
  'WINDIR',
  'ComSpec',
  'PATHEXT',
  'TEMP',
  'TMP',
  'OS',
  'NUMBER_OF_PROCESSORS'
];
const REQUIRED_TOOLS = [
  'memory_save',
  'memory_recall',
  'memory_governance_delete'
];

export function resolveConfinedPath(projectRoot, inputPath, label = 'path') {
  const root = path.resolve(projectRoot);
  const target = path.resolve(root, String(inputPath ?? ''));
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw adapterError('unsafe_path', `${label} must stay inside the ai-tester project root`);
  }
  return target;
}

export function buildIsolatedProviderEnv({ sandboxRoot, storePath, baseEnv = process.env }) {
  const env = {};
  for (const key of INHERITED_ENV_KEYS) {
    if (typeof baseEnv[key] === 'string' && baseEnv[key]) env[key] = baseEnv[key];
  }

  const home = path.join(sandboxRoot, 'home');
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(sandboxRoot, 'appdata', 'roaming'),
    LOCALAPPDATA: path.join(sandboxRoot, 'appdata', 'local'),
    XDG_CONFIG_HOME: path.join(sandboxRoot, 'xdg', 'config'),
    XDG_DATA_HOME: path.join(sandboxRoot, 'xdg', 'data'),
    STANDALONE_MCP: 'true',
    STANDALONE_PERSIST_PATH: storePath,
    AGENTMEMORY_URL: 'http://127.0.0.1:1',
    AGENTMEMORY_PROBE_TIMEOUT_MS: '50',
    CI: '1',
    NO_COLOR: '1'
  };
}

export function buildPinnedInstallInvocation({
  packageRoot,
  sandboxRoot,
  npmCliPath,
  baseEnv = process.env
}) {
  const env = buildIsolatedProviderEnv({
    sandboxRoot,
    storePath: path.join(sandboxRoot, 'install-unused.json'),
    baseEnv
  });
  return {
    command: process.execPath,
    args: [
      npmCliPath,
      'install',
      '--prefix',
      packageRoot,
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      `@agentmemory/mcp@${AGENTMEMORY_MCP_VERSION}`
    ],
    env: {
      ...env,
      npm_config_ignore_scripts: 'true',
      npm_config_audit: 'false',
      npm_config_fund: 'false'
    }
  };
}

export async function runAgentMemoryVerification(options) {
  const projectRoot = path.resolve(options.projectRoot ?? process.cwd());
  const packageRoot = resolveConfinedPath(projectRoot, options.packageRoot, 'package root');
  const sandboxRoot = resolveConfinedPath(projectRoot, options.sandboxRoot, 'sandbox root');
  const purgeInstall = options.purgeInstall === true;
  const install = options.install === true;
  const mcpPackageRoot = path.join(packageRoot, 'node_modules', '@agentmemory', 'mcp');
  const providerPackageRoot = path.join(packageRoot, 'node_modules', '@agentmemory', 'agentmemory');
  const mcpBin = path.join(mcpPackageRoot, 'bin.mjs');
  let verificationError;

  logEvent('attempt_start', { input_class: 'synthetic_canaries', provider_version: AGENTMEMORY_MCP_VERSION });
  try {
    if (install && !purgeInstall) {
      throw adapterError('unsafe_install_mode', 'adapter-managed install requires --purge-install');
    }
    if (install) await installPinnedPackage({ packageRoot, sandboxRoot });
    await verifyPinnedPackage(mcpPackageRoot, '@agentmemory/mcp');
    await verifyPinnedPackage(providerPackageRoot, '@agentmemory/agentmemory');
    await stat(mcpBin);
    await mkdir(sandboxRoot, { recursive: true });

    const storeA = path.join(sandboxRoot, 'stores', 'continuity-a.json');
    const storeB = path.join(sandboxRoot, 'stores', 'continuity-b.json');
    const canaryA = 'cobalt-orchid synthetic continuity marker';
    const canaryB = 'amber-raven synthetic privacy marker';

    const savedA = await withProvider(mcpBin, sandboxRoot, storeA, async (client) => {
      return saveMemory(client, canaryA);
    });
    const savedB = await withProvider(mcpBin, sandboxRoot, storeB, async (client) => {
      return saveMemory(client, canaryB);
    });

    const aChecks = await withProvider(mcpBin, sandboxRoot, storeA, async (client) => {
      const own = await recallMemory(client, 'cobalt-orchid');
      const foreign = await recallMemory(client, 'amber-raven');
      await deleteMemory(client, savedA);
      return { own, foreign };
    });
    const bChecks = await withProvider(mcpBin, sandboxRoot, storeB, async (client) => {
      const own = await recallMemory(client, 'amber-raven');
      const foreign = await recallMemory(client, 'cobalt-orchid');
      await deleteMemory(client, savedB);
      return { own, foreign };
    });

    if (!containsCanary(aChecks.own, 'cobalt-orchid') || !containsCanary(bChecks.own, 'amber-raven')) {
      throw adapterError('continuity_failed', 'cross-process recall did not return the synthetic canary');
    }
    if (resultCount(aChecks.foreign) !== 0 || resultCount(bChecks.foreign) !== 0) {
      throw adapterError('isolation_failed', 'a synthetic canary crossed an isolated store boundary');
    }

    const afterDeleteA = await withProvider(mcpBin, sandboxRoot, storeA, (client) => {
      return recallMemory(client, 'cobalt-orchid');
    });
    const afterDeleteB = await withProvider(mcpBin, sandboxRoot, storeB, (client) => {
      return recallMemory(client, 'amber-raven');
    });
    if (resultCount(afterDeleteA) !== 0 || resultCount(afterDeleteB) !== 0) {
      throw adapterError('purge_failed', 'governance delete left a synthetic canary recallable');
    }

    return {
      schema: AGENTMEMORY_ADAPTER_SCHEMA,
      status: 'pass',
      provider_version: AGENTMEMORY_MCP_VERSION,
      mode: 'standalone_local_fallback',
      continuity: 'continuity_pass',
      isolation: 'isolation_pass',
      privacy: 'privacy_pass',
      purge: 'purge_pass',
      install_purge: purgeInstall ? 'pass' : 'not_requested',
      forbidden_operations: {
        host_config_mutated: false,
        hooks_installed: false,
        mcp_registered: false,
        daemon_started: false
      }
    };
  } catch (error) {
    verificationError = error;
    throw error;
  } finally {
    try {
      await rm(sandboxRoot, { recursive: true, force: true });
      if (purgeInstall) await rm(packageRoot, { recursive: true, force: true });
      if (await exists(sandboxRoot)) throw adapterError('purge_failed', 'sandbox cleanup was incomplete');
      if (purgeInstall && await exists(packageRoot)) {
        throw adapterError('install_purge_failed', 'local package cleanup was incomplete');
      }
      logEvent(verificationError ? 'attempt_cleanup_after_failure' : 'attempt_pass', {
        sandbox_purged: true,
        install_purged: purgeInstall
      });
    } catch (cleanupError) {
      if (!verificationError) throw cleanupError;
      logEvent('attempt_cleanup_failed', { failure_signature: errorCode(cleanupError) });
    }
  }
}

async function installPinnedPackage({ packageRoot, sandboxRoot }) {
  const npmCliPath = await resolveNpmCliPath();
  await mkdir(sandboxRoot, { recursive: true });
  const invocation = buildPinnedInstallInvocation({ packageRoot, sandboxRoot, npmCliPath });
  const result = await runChildProcess(invocation.command, invocation.args, {
    env: invocation.env,
    timeoutMs: AGENTMEMORY_INSTALL_TIMEOUT_MS
  });
  if (result.exitCode !== 0) {
    throw adapterError('package_install_failed', 'the pinned local provider package could not be installed');
  }
}

async function resolveNpmCliPath() {
  const candidates = [
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.resolve(path.dirname(process.execPath), '..', 'node_modules', 'npm', 'bin', 'npm-cli.js')
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (await exists(candidate)) return path.resolve(candidate);
  }
  throw adapterError('npm_cli_missing', 'npm CLI was not found beside the active Node runtime');
}

function runChildProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (!child.killed) child.kill();
      finishReject(adapterError('package_install_timeout', 'the pinned package install timed out'));
    }, options.timeoutMs ?? AGENTMEMORY_INSTALL_TIMEOUT_MS);

    child.stdout.on('data', (chunk) => {
      stdout = `${stdout}${chunk.toString()}`.slice(-2000);
    });
    child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-2000);
    });
    child.once('error', () => {
      finishReject(adapterError('package_install_spawn_failed', 'the pinned package installer could not start'));
    });
    child.once('exit', (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode, stdout, stderr });
    });

    function finishReject(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    }
  });
}

async function verifyPinnedPackage(packageRoot, expectedName) {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
  } catch {
    throw adapterError('package_missing', 'the pinned local provider package is unavailable');
  }
  if (manifest.name !== expectedName || manifest.version !== AGENTMEMORY_MCP_VERSION) {
    throw adapterError('package_version_mismatch', 'the local provider package does not match the pinned version');
  }
}

async function withProvider(mcpBin, sandboxRoot, storePath, operation) {
  await mkdir(path.dirname(storePath), { recursive: true });
  const client = await createMcpStdioClient(process.execPath, [mcpBin], {
    env: buildIsolatedProviderEnv({ sandboxRoot, storePath })
  });
  try {
    const initialized = await client.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'aifhub-ai-tester', version: '1.0.0' }
    });
    assertRpcSuccess(initialized, 'initialize_failed');
    client.notify('notifications/initialized');
    const listed = assertRpcSuccess(await client.request('tools/list'), 'tools_list_failed');
    const names = new Set((listed.tools ?? []).map((tool) => tool.name));
    if (REQUIRED_TOOLS.some((tool) => !names.has(tool))) {
      throw adapterError('tool_surface_incomplete', 'the standalone MCP surface is missing a required tool');
    }
    return await operation(client);
  } finally {
    await client.close();
  }
}

async function saveMemory(client, content) {
  const result = await callTool(client, 'memory_save', {
    content,
    type: 'fact',
    concepts: ['aifhub-ai-tester']
  });
  if (typeof result.saved !== 'string' || !result.saved.startsWith('mem_')) {
    throw adapterError('save_failed', 'memory_save did not return a memory id');
  }
  return result.saved;
}

async function recallMemory(client, query) {
  return callTool(client, 'memory_recall', { query, limit: 10, format: 'full' });
}

async function deleteMemory(client, memoryId) {
  const result = await callTool(client, 'memory_governance_delete', {
    memoryIds: [memoryId],
    reason: 'aifhub ai-tester synthetic-canary purge'
  });
  if (result.deleted !== 1) throw adapterError('delete_failed', 'governance delete did not remove the canary');
}

async function callTool(client, name, args) {
  const rpc = await client.request('tools/call', { name, arguments: args });
  const result = assertRpcSuccess(rpc, 'tool_call_failed');
  if (result.isError) throw adapterError('tool_call_failed', 'the standalone MCP tool returned an error');
  const text = result.content?.find((item) => item.type === 'text')?.text;
  try {
    return JSON.parse(text);
  } catch {
    throw adapterError('invalid_tool_response', 'the standalone MCP tool returned invalid JSON');
  }
}

function assertRpcSuccess(message, code) {
  if (!message || message.error) throw adapterError(code, 'the standalone MCP request failed');
  return message.result ?? {};
}

function resultCount(result) {
  return Array.isArray(result?.results) ? result.results.length : -1;
}

function containsCanary(result, marker) {
  return Array.isArray(result?.results)
    && result.results.some((entry) => JSON.stringify(entry).toLowerCase().includes(marker));
}

async function createMcpStdioClient(command, args, options) {
  const child = spawn(command, args, {
    env: options.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  });
  const timeoutMs = options.timeoutMs ?? 30000;
  let stdoutBuffer = '';
  let stderrBuffer = '';
  let nextId = 1;
  const pending = new Map();
  let spawnError;

  child.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk.toString();
    let newline;
    while ((newline = stdoutBuffer.indexOf('\n')) >= 0) {
      const line = stdoutBuffer.slice(0, newline).trim();
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      const waiter = pending.get(message.id);
      if (!waiter) continue;
      clearTimeout(waiter.timer);
      pending.delete(message.id);
      waiter.resolve(message);
    }
  });
  child.stderr.on('data', (chunk) => {
    stderrBuffer = `${stderrBuffer}${chunk.toString()}`.slice(-2000);
  });
  child.on('error', (error) => {
    spawnError = error;
    rejectPending(adapterError('provider_spawn_failed', 'the standalone MCP process could not start'));
  });
  child.on('exit', (code) => {
    if (pending.size > 0) {
      rejectPending(adapterError('provider_exited', `the standalone MCP process exited with code ${code}`));
    }
  });

  function rejectPending(error) {
    for (const [id, waiter] of pending.entries()) {
      clearTimeout(waiter.timer);
      pending.delete(id);
      waiter.reject(error);
    }
  }

  return {
    request(method, params = {}) {
      if (spawnError) return Promise.reject(spawnError);
      const id = nextId;
      nextId += 1;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(adapterError('provider_timeout', `the standalone MCP request timed out: ${method}`));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });
    },
    notify(method, params = {}) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
    },
    async close() {
      rejectPending(adapterError('provider_closed', 'the standalone MCP client closed'));
      if (child.exitCode !== null) return;
      child.stdin.end();
      const exited = await waitForExit(child, 1500);
      if (!exited && !child.killed) child.kill();
      if (!exited) await waitForExit(child, 1500);
      if (child.exitCode === null) {
        throw adapterError('provider_cleanup_failed', 'the standalone MCP process did not stop');
      }
      void stderrBuffer;
    }
  };
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      resolve(false);
    }, timeoutMs);
    function onExit() {
      clearTimeout(timer);
      resolve(true);
    }
    child.once('exit', onExit);
  });
}

async function exists(target) {
  try {
    await stat(target);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function adapterError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function errorCode(error) {
  return typeof error?.code === 'string' ? error.code : 'unexpected_error';
}

function logEvent(event, details) {
  process.stderr.write(`[FIX:agentmemory-ai-tester] ${event} ${JSON.stringify(details)}\n`);
}

function parseArgs(argv) {
  const options = { install: false, purgeInstall: false };
  if (argv[0] !== 'verify') throw adapterError('usage', 'expected the verify command');
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--package-root') options.packageRoot = argv[++index];
    else if (arg === '--sandbox-root') options.sandboxRoot = argv[++index];
    else if (arg === '--install') options.install = true;
    else if (arg === '--purge-install') options.purgeInstall = true;
    else throw adapterError('usage', 'unsupported adapter argument');
  }
  if (!options.packageRoot || !options.sandboxRoot) {
    throw adapterError('usage', '--package-root and --sandbox-root are required');
  }
  return options;
}

function isDirectRun() {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isDirectRun()) {
  try {
    const result = await runAgentMemoryVerification(parseArgs(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const failure = {
      schema: AGENTMEMORY_ADAPTER_SCHEMA,
      status: 'fail',
      failure_signature: errorCode(error)
    };
    logEvent('attempt_failed', { failure_signature: failure.failure_signature });
    process.stdout.write(`${JSON.stringify(failure)}\n`);
    process.exitCode = 1;
  }
}
