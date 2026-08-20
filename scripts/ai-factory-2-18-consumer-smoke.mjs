// ai-factory-2-18-consumer-smoke.mjs - deterministic/live consumer compatibility orchestration
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  access,
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  AI_FACTORY_ULTRA_MIN_VERSION,
  compareStableAiFactoryVersions,
  parseStableAiFactoryVersion
} from './ai-factory-version-resolver.mjs';
import { classifyLegacyPlanShape } from './legacy-plan-migration.mjs';

export const SMOKE_SCHEMA_VERSION = 1;
export const EXPECTED_AI_FACTORY_VERSIONS = Object.freeze({
  v217: '2.17.0',
  v218Boundary: AI_FACTORY_ULTRA_MIN_VERSION,
  v218: '2.18.1'
});
export const AI_FACTORY_2181_EXPLORE_SENTINELS = Object.freeze({
  coherenceHeading: '#### Research Coherence Gate (all persisted modes)',
  ultraHeading: '#### Ultra mode: adaptive bundle',
  bundleIntegrityOrdering: 'Run the Research Coherence Gate, then the Bundle Integrity Gate'
});
export const SMOKE_STATUS = Object.freeze({
  PASS: 'PASS',
  NOT_RUN: 'NOT_RUN',
  FAIL: 'FAIL',
  TIMEOUT: 'TIMEOUT',
  TRANSPORT_FAILURE: 'TRANSPORT_FAILURE',
  ENVIRONMENT_FAILURE: 'ENVIRONMENT_FAILURE'
});

const EXTENSION_NAME = 'aifhub-extension';
const DUMMY_EXTENSION_NAME = 'aifhub-smoke-dummy';
const DEFAULT_TIMEOUT_MS = 120_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 300_000;
const MAX_BUFFER_BYTES = 1024 * 1024;
const CONFIG_SENTINEL = 'aifhub-issue-152-config-preserved';
const LEDGER_SENTINEL = 'aifhub-issue-152-ledger-preserved';
const CUSTOM_AGENT_SENTINEL = 'aifhub-issue-152-custom-agent-preserved';
const STALE_AGENT_SENTINEL = 'aifhub-issue-152-stale-managed-agent';
const SAFE_LOCAL_PATH = '<local-path>';
const TRANSPORT_PATTERN = /(?:EAI_AGAIN|ENETUNREACH|ECONNRESET|ECONNREFUSED|ETIMEDOUT|network|registry|remote repository|fetch failed|unable to access|rate limit)/i;
const LEGACY_PLAN_SOURCE_ROOT = '.ai-factory/plans';
const CLASSIC_PLAN_ID = 'classic-smoke';
const ULTRA_PLAN_ID = 'ultra-smoke';

const ARTIFACT_FIXTURES = Object.freeze({
  'openspec/changes/smoke-preserved/proposal.md': '# Proposal\n\nPreserve canonical proposal.\n',
  'openspec/changes/smoke-preserved/design.md': '# Design\n\nPreserve canonical design.\n',
  'openspec/changes/smoke-preserved/tasks.md': '# Tasks\n\n- [ ] Preserve canonical task.\n',
  'openspec/changes/smoke-preserved/specs/consumer/spec.md': '# Consumer delta\n\n## ADDED Requirements\n\n### Requirement: Preserve\n\n#### Scenario: Update\n\n- **WHEN** update runs\n- **THEN** bytes remain unchanged\n',
  '.ai-factory/plans/classic-smoke.md': '# Classic plan\n\nPreserve classic source.\n',
  '.ai-factory/plans/classic-smoke/task.md': '# Classic tasks\n\n- [ ] Preserve classic task.\n',
  '.ai-factory/plans/ultra-smoke/index.md': '<!-- aif:plan-mode:ultra -->\n\n# Ultra plan\n\n## Phase Index\n\n1. [Phase 01](phase-01-contract.md)\n\n## Tasks\n\n- [ ] **Task 1:** Preserve phase.\n',
  '.ai-factory/plans/ultra-smoke/phase-01-contract.md': '# Phase 01: Contract\n\n## Task 1: Preserve phase\n\nPreserve ultra phase without phase-local progress checkboxes.\n'
});

const ARTIFACT_PATHS = Object.freeze(Object.keys(ARTIFACT_FIXTURES).sort());

class SmokeFailure extends Error {
  constructor(status, flow, code, message = code, details = {}) {
    super(message);
    this.name = 'SmokeFailure';
    this.status = status;
    this.flow = flow;
    this.code = code;
    this.details = details;
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function pathDigest(value) {
  return sha256(path.resolve(value));
}

function normalizeRelativePath(value) {
  return value.replaceAll('\\', '/');
}

function normalizeManifestPath(value) {
  return normalizeRelativePath(String(value ?? '').replace(/^\.\//, ''));
}

function countOccurrences(text, needle) {
  if (!needle) return 0;
  let count = 0;
  let offset = 0;
  while ((offset = text.indexOf(needle, offset)) !== -1) {
    count += 1;
    offset += needle.length;
  }
  return count;
}

export function aiFactoryVersionIncludesTransfer(version) {
  const parsed = parseStableAiFactoryVersion(version);
  return parsed.ok && compareStableAiFactoryVersions(parsed.version, AI_FACTORY_ULTRA_MIN_VERSION) >= 0;
}

function assertContract(condition, flow, code, details = {}) {
  if (!condition) {
    throw new SmokeFailure(SMOKE_STATUS.FAIL, flow, code, code, details);
  }
}

function assertSafeToken(value, label) {
  if (typeof value !== 'string' || value.length === 0 || /[\u0000\r\n]/.test(value)) {
    throw new SmokeFailure(SMOKE_STATUS.NOT_RUN, 'preflight', 'invalid-toolchain-token', label);
  }
}

function resolveTimeoutMs(value) {
  const timeoutMs = value ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < MIN_TIMEOUT_MS || timeoutMs > MAX_TIMEOUT_MS) {
    throw new SmokeFailure(
      SMOKE_STATUS.NOT_RUN,
      'preflight',
      'invalid-timeout',
      `timeout must be an integer from ${MIN_TIMEOUT_MS} to ${MAX_TIMEOUT_MS}`
    );
  }
  return timeoutMs;
}

async function exists(value) {
  try {
    await access(value);
    return true;
  } catch {
    return false;
  }
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function writeProjectFile(projectDir, relativePath, content) {
  const target = path.join(projectDir, ...relativePath.split('/'));
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, 'utf8');
  return target;
}

async function hashFile(filePath) {
  return sha256(await readFile(filePath));
}

async function snapshotRelativeFiles(rootDir, relativePaths) {
  const entries = [];
  for (const relativePath of [...relativePaths].sort()) {
    const absolutePath = path.join(rootDir, ...relativePath.split('/'));
    const bytes = await readFile(absolutePath);
    entries.push({
      path: relativePath,
      size: bytes.byteLength,
      sha256: sha256(bytes)
    });
  }
  const digest = sha256(entries.map((entry) => `${entry.path}\0${entry.size}\0${entry.sha256}\n`).join(''));
  return { paths: entries.map((entry) => entry.path), entries, digest };
}

async function listRegularFiles(rootDir) {
  if (!await exists(rootDir)) return [];
  const files = [];

  async function walk(currentDir) {
    for (const entry of await readdir(currentDir, { withFileTypes: true })) {
      const target = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(target);
      } else if (entry.isFile()) {
        files.push(target);
      } else {
        throw new SmokeFailure(SMOKE_STATUS.FAIL, 'targeted-update', 'unsupported-dummy-file-type');
      }
    }
  }

  await walk(rootDir);
  return files.sort((left, right) => left.localeCompare(right));
}

async function snapshotTrees(projectDir, roots) {
  const entries = [];
  for (const relativeRoot of [...roots].sort()) {
    const absoluteRoot = path.join(projectDir, ...relativeRoot.split('/'));
    for (const filePath of await listRegularFiles(absoluteRoot)) {
      const relativePath = normalizeRelativePath(path.relative(projectDir, filePath));
      const bytes = await readFile(filePath);
      entries.push({ path: relativePath, size: bytes.byteLength, sha256: sha256(bytes) });
    }
  }
  entries.sort((left, right) => left.path.localeCompare(right.path));
  return {
    paths: entries.map((entry) => entry.path),
    entries,
    digest: sha256(entries.map((entry) => `${entry.path}\0${entry.size}\0${entry.sha256}\n`).join(''))
  };
}

function stableJsonDigest(value) {
  function sortValue(input) {
    if (Array.isArray(input)) return input.map(sortValue);
    if (input && typeof input === 'object') {
      return Object.fromEntries(Object.keys(input).sort().map((key) => [key, sortValue(input[key])]));
    }
    return input;
  }
  return sha256(JSON.stringify(sortValue(value)));
}

function isWithin(parentDir, childPath) {
  const relative = path.relative(parentDir, childPath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function quoteWindowsCmdToken(value) {
  assertSafeToken(value, 'Windows command token');
  if (/["%!]/.test(value)) {
    throw new SmokeFailure(SMOKE_STATUS.NOT_RUN, 'preflight', 'unsafe-windows-command-token');
  }

  let result = '"';
  let backslashes = 0;
  for (const character of value) {
    if (character === '\\') {
      backslashes += 1;
      continue;
    }
    result += '\\'.repeat(backslashes);
    backslashes = 0;
    result += character;
  }
  result += `${'\\'.repeat(backslashes * 2)}"`;
  return result;
}

export function buildNoShellInvocation({ command, args = [], platform = process.platform, comSpec = process.env.ComSpec }) {
  assertSafeToken(command, 'command');
  for (const [index, argument] of args.entries()) assertSafeToken(argument, `argv[${index}]`);

  const extension = path.extname(command).toLowerCase();
  if (platform === 'win32' && (extension === '.cmd' || extension === '.bat')) {
    if (!comSpec || !path.win32.isAbsolute(comSpec)) {
      throw new SmokeFailure(SMOKE_STATUS.NOT_RUN, 'preflight', 'missing-comspec');
    }
    const commandLine = [command, ...args].map(quoteWindowsCmdToken).join(' ');
    return {
      command: comSpec,
      args: ['/d', '/s', '/c', `"${commandLine}"`],
      adapter: 'windows-comspec',
      options: { shell: false }
    };
  }

  return {
    command,
    args,
    adapter: 'direct-exec-file',
    options: { shell: false }
  };
}

export function createNoShellProcessRunner({
  execFileImpl = execFile,
  platform = process.platform,
  comSpec = process.env.ComSpec,
  environment = process.env
} = {}) {
  const runProcess = async function runProcess({ command, args = [], cwd, timeoutMs = DEFAULT_TIMEOUT_MS }) {
    const boundedTimeout = resolveTimeoutMs(timeoutMs);
    const invocation = buildNoShellInvocation({ command, args, platform, comSpec });
    const options = {
      cwd,
      env: {
        ...environment,
        CI: '1',
        NO_COLOR: '1'
      },
      encoding: 'utf8',
      maxBuffer: MAX_BUFFER_BYTES,
      timeout: boundedTimeout,
      windowsHide: true,
      shell: false
    };

    return new Promise((resolve) => {
      execFileImpl(invocation.command, invocation.args, options, (error, stdout = '', stderr = '') => {
        const numericExitCode = typeof error?.code === 'number' ? error.code : (error ? null : 0);
        resolve({
          exitCode: numericExitCode,
          processCode: typeof error?.code === 'string' ? error.code : null,
          signal: error?.signal ?? null,
          timedOut: Boolean(error?.killed && error?.signal) || error?.code === 'ETIMEDOUT',
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
          adapter: invocation.adapter,
          shell: false,
          timeoutMs: boundedTimeout
        });
      });
    });
  };
  runProcess.preflight = async ({ command, args = [] }) => {
    const invocation = buildNoShellInvocation({ command, args, platform, comSpec });
    if (invocation.adapter === 'windows-comspec') {
      if (!await exists(invocation.command) || !(await stat(invocation.command)).isFile()) {
        throw new SmokeFailure(SMOKE_STATUS.NOT_RUN, 'preflight', 'missing-comspec');
      }
    }
    return { adapter: invocation.adapter, shell: false };
  };
  return runProcess;
}

function classifyProcessFailure(processResult, networkEnabled) {
  if (processResult.timedOut) return SMOKE_STATUS.TIMEOUT;
  if (processResult.processCode === 'ENOENT' || processResult.processCode === 'EACCES') {
    return SMOKE_STATUS.ENVIRONMENT_FAILURE;
  }
  const combined = `${processResult.stderr ?? ''}\n${processResult.stdout ?? ''}\n${processResult.processCode ?? ''}`;
  if (TRANSPORT_PATTERN.test(combined)) return SMOKE_STATUS.TRANSPORT_FAILURE;
  if (networkEnabled && /(?:git|npm|https?:)/i.test(combined)) return SMOKE_STATUS.TRANSPORT_FAILURE;
  return SMOKE_STATUS.FAIL;
}

function parseReportedVersion(stdout) {
  const normalized = String(stdout ?? '')
    .replace(/\u001b\[[0-9;]*m/g, '')
    .trim();
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(normalized) ? normalized : null;
}

async function validateBoundToolchain(toolchain, key, expectedVersion) {
  if (!toolchain || typeof toolchain !== 'object') {
    throw new SmokeFailure(SMOKE_STATUS.NOT_RUN, 'preflight', `missing-${key}-toolchain`);
  }
  const { command, argv = [], provenanceRoot } = toolchain;
  assertSafeToken(command, `${key}.command`);
  if (!path.isAbsolute(command) || !await exists(command) || !(await stat(command)).isFile()) {
    throw new SmokeFailure(SMOKE_STATUS.NOT_RUN, 'preflight', `missing-${key}-command`);
  }
  if (!Array.isArray(argv)) {
    throw new SmokeFailure(SMOKE_STATUS.NOT_RUN, 'preflight', `invalid-${key}-argv`);
  }
  for (const [index, argument] of argv.entries()) assertSafeToken(argument, `${key}.argv[${index}]`);
  if (!provenanceRoot || !path.isAbsolute(provenanceRoot) || !await exists(provenanceRoot)) {
    throw new SmokeFailure(SMOKE_STATUS.NOT_RUN, 'preflight', `missing-${key}-provenance`);
  }

  const resolvedRoot = await realpath(provenanceRoot);
  if (!(await stat(resolvedRoot)).isDirectory()) {
    throw new SmokeFailure(SMOKE_STATUS.NOT_RUN, 'preflight', `invalid-${key}-provenance`);
  }
  const packageJsonPath = path.join(resolvedRoot, 'package.json');
  if (!await exists(packageJsonPath)) {
    throw new SmokeFailure(SMOKE_STATUS.NOT_RUN, 'preflight', `missing-${key}-package-json`);
  }
  let packageJson;
  try {
    packageJson = await readJson(packageJsonPath);
  } catch {
    throw new SmokeFailure(SMOKE_STATUS.NOT_RUN, 'preflight', `invalid-${key}-package-json`);
  }
  if (packageJson.name !== 'ai-factory' || packageJson.version !== expectedVersion) {
    throw new SmokeFailure(SMOKE_STATUS.NOT_RUN, 'preflight', `${key}-provenance-mismatch`, undefined, {
      expectedVersion,
      packageName: packageJson.name ?? null,
      packageVersion: packageJson.version ?? null
    });
  }
  const binValue = typeof packageJson.bin === 'string' ? packageJson.bin : packageJson.bin?.['ai-factory'];
  if (typeof binValue !== 'string') {
    throw new SmokeFailure(SMOKE_STATUS.NOT_RUN, 'preflight', `${key}-missing-bin-provenance`);
  }
  const entrypoint = path.resolve(resolvedRoot, binValue);
  if (!isWithin(resolvedRoot, entrypoint) || !await exists(entrypoint) || !(await stat(entrypoint)).isFile()) {
    throw new SmokeFailure(SMOKE_STATUS.NOT_RUN, 'preflight', `${key}-invalid-bin-provenance`);
  }

  const resolvedCommand = await realpath(command);
  const argvPaths = [];
  for (const argument of argv) {
    if (path.isAbsolute(argument) && await exists(argument)) argvPaths.push(await realpath(argument));
  }
  let bound = resolvedCommand === entrypoint || argvPaths.includes(entrypoint);
  const commandExtension = path.extname(resolvedCommand).toLowerCase();
  if (!bound && (commandExtension === '.cmd' || commandExtension === '.bat')) {
    const shim = normalizeRelativePath(await readFile(resolvedCommand, 'utf8')).toLowerCase();
    const entrypointNormalized = normalizeRelativePath(entrypoint).toLowerCase();
    const packageTail = `${path.basename(resolvedRoot).toLowerCase()}/${normalizeManifestPath(binValue).toLowerCase()}`;
    bound = shim.includes(entrypointNormalized) || shim.includes(packageTail);
  }
  if (!bound) {
    throw new SmokeFailure(SMOKE_STATUS.NOT_RUN, 'preflight', `${key}-unbound-provenance`);
  }

  return {
    key,
    command: resolvedCommand,
    argv: [...argv],
    provenanceRoot: resolvedRoot,
    entrypoint,
    expectedVersion,
    safeProvenance: {
      packageName: 'ai-factory',
      packageVersion: packageJson.version,
      commandDigest: pathDigest(resolvedCommand),
      entrypointDigest: pathDigest(entrypoint),
      rootDigest: pathDigest(resolvedRoot)
    }
  };
}

async function validateExtensionRoot(extensionRoot) {
  if (!extensionRoot || !path.isAbsolute(extensionRoot) || !await exists(extensionRoot)) {
    throw new SmokeFailure(SMOKE_STATUS.NOT_RUN, 'preflight', 'missing-extension-root');
  }
  const resolvedRoot = await realpath(extensionRoot);
  const manifestPath = path.join(resolvedRoot, 'extension.json');
  if (!await exists(manifestPath)) {
    throw new SmokeFailure(SMOKE_STATUS.NOT_RUN, 'preflight', 'missing-extension-manifest');
  }
  let manifest;
  try {
    manifest = await readJson(manifestPath);
  } catch {
    throw new SmokeFailure(SMOKE_STATUS.NOT_RUN, 'preflight', 'invalid-extension-manifest');
  }
  if (manifest.name !== EXTENSION_NAME) {
    throw new SmokeFailure(SMOKE_STATUS.NOT_RUN, 'preflight', 'extension-name-mismatch');
  }
  const codexAgentFiles = (manifest.agentFiles ?? []).filter((entry) => entry.runtime === 'codex');
  if (codexAgentFiles.length === 0) {
    throw new SmokeFailure(SMOKE_STATUS.NOT_RUN, 'preflight', 'missing-codex-agent-files');
  }
  const injectionKeys = (manifest.injections ?? []).map((entry) => `${entry.target}:${entry.position}`);
  if (new Set(injectionKeys).size !== injectionKeys.length) {
    throw new SmokeFailure(SMOKE_STATUS.NOT_RUN, 'preflight', 'duplicate-extension-injection');
  }
  const contributesTransfer = (manifest.skills ?? []).some((entry) => path.basename(normalizeManifestPath(entry)) === 'aif-transfer')
    || (manifest.injections ?? []).some((entry) => entry.target === 'aif-transfer')
    || await exists(path.join(resolvedRoot, 'skills', 'aif-transfer'));
  if (contributesTransfer) {
    throw new SmokeFailure(SMOKE_STATUS.NOT_RUN, 'preflight', 'duplicate-transfer-ownership');
  }

  return {
    root: resolvedRoot,
    manifest,
    manifestDigest: await hashFile(manifestPath),
    codexAgentFiles,
    injectionKeys
  };
}

function safeCliArgs(cliArgs) {
  return cliArgs.map((argument) => path.isAbsolute(argument) ? SAFE_LOCAL_PATH : argument);
}

function createResult(evidence) {
  return {
    schemaVersion: SMOKE_SCHEMA_VERSION,
    suite: 'ai-factory-2.18-consumer-compatibility',
    evidence,
    status: SMOKE_STATUS.NOT_RUN,
    compatibilityScope: 'isolated-local-consumer-contract',
    provesReleaseOrDeployment: false,
    versions: {},
    flows: {
      cleanInstall: { status: SMOKE_STATUS.NOT_RUN },
      globalUpdate: { status: SMOKE_STATUS.NOT_RUN },
      targetedUpdate: { status: SMOKE_STATUS.NOT_RUN }
    },
    events: []
  };
}

function createRecorder(result) {
  return function record(flow, step, status, details = {}) {
    result.events.push({
      sequence: result.events.length + 1,
      flow,
      step,
      status,
      ...details
    });
  };
}

async function invokeCli({ toolchain, cliArgs, projectDir, runner, timeoutMs, flow, step, networkEnabled, record }) {
  const processResult = await runner({
    command: toolchain.command,
    args: [...toolchain.argv, ...cliArgs],
    cwd: projectDir,
    timeoutMs,
    logicalToolchain: toolchain.key,
    cliArgs: [...cliArgs],
    networkEnabled
  });
  const safeDetails = {
    toolchain: toolchain.key,
    argv: safeCliArgs(cliArgs),
    adapter: processResult.adapter ?? 'injected-executor',
    timeoutMs
  };
  if (processResult.exitCode !== 0 || processResult.processCode) {
    const status = classifyProcessFailure(processResult, networkEnabled);
    record(flow, step, status, {
      ...safeDetails,
      outputFingerprint: sha256(`${processResult.stdout ?? ''}\0${processResult.stderr ?? ''}`)
    });
    throw new SmokeFailure(status, flow, `${step}-command-failed`);
  }
  record(flow, step, SMOKE_STATUS.PASS, safeDetails);
  return processResult;
}

async function probeToolchain({ toolchain, runner, timeoutMs, networkEnabled, record }) {
  const result = await invokeCli({
    toolchain,
    cliArgs: ['--version'],
    projectDir: toolchain.provenanceRoot,
    runner,
    timeoutMs,
    flow: 'preflight',
    step: `${toolchain.key}-version`,
    networkEnabled,
    record
  });
  const reportedVersion = parseReportedVersion(result.stdout);
  if (reportedVersion !== toolchain.expectedVersion) {
    throw new SmokeFailure(SMOKE_STATUS.NOT_RUN, 'preflight', `${toolchain.key}-reported-version-mismatch`, undefined, {
      expectedVersion: toolchain.expectedVersion,
      reportedVersion
    });
  }
  return {
    expected: toolchain.expectedVersion,
    reported: reportedVersion,
    provenance: toolchain.safeProvenance
  };
}

export function createTemporaryWorkspaceFactory({ temporaryRoot = os.tmpdir() } = {}) {
  return async function createWorkspace(label) {
    const rootDir = await mkdtemp(path.join(temporaryRoot, `aifhub-218-${label}-`));
    const projectDir = path.join(rootDir, 'project');
    const fixtureDir = path.join(rootDir, 'fixtures');
    await mkdir(projectDir, { recursive: true });
    await mkdir(fixtureDir, { recursive: true });
    const resolvedTemporaryRoot = path.resolve(temporaryRoot);
    const resolvedRoot = path.resolve(rootDir);
    return {
      projectDir,
      fixtureDir,
      async cleanup() {
        if (!isWithin(resolvedTemporaryRoot, resolvedRoot) || !path.basename(resolvedRoot).startsWith('aifhub-218-')) {
          throw new Error('Refusing to remove an unverified smoke workspace.');
        }
        await rm(resolvedRoot, { recursive: true, force: true });
      }
    };
  };
}

async function readConsumerLedger(projectDir) {
  return readJson(path.join(projectDir, '.ai-factory.json'));
}

function findCodexAgent(ledger, flow) {
  const agent = (ledger.agents ?? []).find((entry) => entry.id === 'codex');
  assertContract(agent, flow, 'missing-codex-ledger');
  return agent;
}

async function assertCanonicalOpenSpecConfig(projectDir, flow) {
  const configPath = path.join(projectDir, '.ai-factory', 'config.yaml');
  assertContract(await exists(configPath), flow, 'missing-aif-config');
  const config = await readFile(configPath, 'utf8');
  assertContract(countOccurrences(config, 'artifactProtocol: openspec') === 1, flow, 'noncanonical-openspec-config');
  return { digest: sha256(config), markerCount: 1 };
}

async function inspectInjectionCardinality(projectDir, manifest, flow) {
  const entries = [];
  for (const injection of manifest.injections ?? []) {
    const skillPath = path.join(projectDir, '.codex', 'skills', injection.target, 'SKILL.md');
    assertContract(await exists(skillPath), flow, 'missing-injection-target', { target: injection.target });
    const content = await readFile(skillPath, 'utf8');
    const marker = `<!-- aif-ext:${EXTENSION_NAME}:${injection.target}:${injection.position}:start -->`;
    const count = countOccurrences(content, marker);
    assertContract(count === 1, flow, 'injection-cardinality-mismatch', { target: injection.target, count });
    entries.push({ target: injection.target, position: injection.position, count });
  }
  entries.sort((left, right) => `${left.target}:${left.position}`.localeCompare(`${right.target}:${right.position}`));
  return { count: entries.length, digest: stableJsonDigest(entries), entries };
}

async function inspectExploreUpstreamContract(projectDir, extension, toolchain, flow) {
  const exploreInjections = (extension.manifest.injections ?? []).filter((entry) => entry.target === 'aif-explore');
  assertContract(
    exploreInjections.length === 1 && exploreInjections[0].position === 'prepend',
    flow,
    'explore-injection-contract-mismatch',
    { count: exploreInjections.length, position: exploreInjections[0]?.position ?? null }
  );

  const upstreamPath = path.resolve(toolchain.provenanceRoot, 'skills', 'aif-explore', 'SKILL.md');
  assertContract(isWithin(toolchain.provenanceRoot, upstreamPath), flow, 'unsafe-upstream-explore-source');
  assertContract(await exists(upstreamPath), flow, 'missing-upstream-explore-source');
  const installedPath = path.join(projectDir, '.codex', 'skills', 'aif-explore', 'SKILL.md');
  assertContract(await exists(installedPath), flow, 'missing-installed-explore-skill');

  const [upstreamBytes, installedBytes] = await Promise.all([
    readFile(upstreamPath),
    readFile(installedPath)
  ]);
  const retainedBytes = installedBytes.subarray(Math.max(0, installedBytes.byteLength - upstreamBytes.byteLength));
  assertContract(
    installedBytes.byteLength >= upstreamBytes.byteLength && retainedBytes.equals(upstreamBytes),
    flow,
    'upstream-explore-bytes-changed',
    { upstreamVersion: toolchain.expectedVersion }
  );

  const upstream = upstreamBytes.toString('utf8');
  const installed = installedBytes.toString('utf8');
  const injectionMarker = `<!-- aif-ext:${EXTENSION_NAME}:aif-explore:prepend:start -->`;
  const injectionMarkerCount = countOccurrences(installed, injectionMarker);
  const coherenceHeadingCount = countOccurrences(upstream, AI_FACTORY_2181_EXPLORE_SENTINELS.coherenceHeading);
  const bundleIntegrityOrderingCount = countOccurrences(
    upstream,
    AI_FACTORY_2181_EXPLORE_SENTINELS.bundleIntegrityOrdering
  );
  const allowedTools = /^allowed-tools:\s*(.+)$/m.exec(upstream)?.[1]?.trim().split(/\s+/) ?? [];
  const taskCapabilityCount = allowedTools.filter((entry) => entry === 'Task').length;
  assertContract(injectionMarkerCount === 1, flow, 'explore-injection-marker-cardinality-mismatch', {
    count: injectionMarkerCount
  });
  assertContract(coherenceHeadingCount === 1, flow, 'upstream-explore-coherence-sentinel-mismatch', {
    count: coherenceHeadingCount
  });
  assertContract(taskCapabilityCount === 1, flow, 'upstream-explore-task-capability-mismatch', {
    count: taskCapabilityCount
  });
  assertContract(bundleIntegrityOrderingCount === 1, flow, 'upstream-explore-bundle-ordering-mismatch', {
    count: bundleIntegrityOrderingCount
  });
  assertContract(
    upstream.indexOf(AI_FACTORY_2181_EXPLORE_SENTINELS.coherenceHeading)
      < upstream.indexOf(AI_FACTORY_2181_EXPLORE_SENTINELS.ultraHeading),
    flow,
    'upstream-explore-gate-ordering-mismatch'
  );

  return {
    upstreamVersion: toolchain.expectedVersion,
    injectionMarkerCount,
    coherenceHeadingCount,
    taskCapabilityCount,
    bundleIntegrityOrderingCount,
    upstreamDigest: sha256(upstreamBytes)
  };
}

async function inspectTransferInventory(projectDir, expectedCount, flow) {
  const ledger = await readConsumerLedger(projectDir);
  const codexAgent = findCodexAgent(ledger, flow);
  const recordedCount = (codexAgent.installedSkills ?? []).filter((entry) => entry === 'aif-transfer').length;
  const fileCount = await exists(path.join(projectDir, '.codex', 'skills', 'aif-transfer', 'SKILL.md')) ? 1 : 0;
  assertContract(recordedCount === expectedCount, flow, 'transfer-ledger-count-mismatch', { expectedCount, recordedCount });
  assertContract(fileCount === expectedCount, flow, 'transfer-file-count-mismatch', { expectedCount, fileCount });
  return { expectedCount, recordedCount, fileCount, owner: expectedCount === 1 ? 'upstream' : 'not-selected' };
}

async function assertAdapterInventory(projectDir, manifest, flow) {
  const adapters = [];
  for (const skillPath of manifest.skills ?? []) {
    const skillName = path.basename(normalizeManifestPath(skillPath));
    const target = path.join(projectDir, '.codex', 'skills', skillName, 'SKILL.md');
    assertContract(await exists(target), flow, 'missing-aifhub-adapter', { skillName });
    adapters.push(skillName);
  }
  assertContract(new Set(adapters).size === adapters.length, flow, 'duplicate-aifhub-adapter');
  return adapters.sort();
}

async function assertManagedAgentsMatchSource(projectDir, extension, flow) {
  const ledger = await readConsumerLedger(projectDir);
  const codexAgent = findCodexAgent(ledger, flow);
  const entries = [];
  for (const agentFile of extension.codexAgentFiles) {
    const sourcePath = path.resolve(extension.root, normalizeManifestPath(agentFile.source));
    const targetPath = path.resolve(projectDir, codexAgent.agentsDir ?? '.codex/agents', agentFile.target);
    assertContract(isWithin(extension.root, sourcePath), flow, 'unsafe-agent-source');
    assertContract(isWithin(projectDir, targetPath), flow, 'unsafe-agent-target');
    assertContract(await exists(sourcePath) && await exists(targetPath), flow, 'missing-managed-agent', { target: agentFile.target });
    const sourceHash = await hashFile(sourcePath);
    const targetHash = await hashFile(targetPath);
    assertContract(targetHash === sourceHash, flow, 'managed-agent-source-mismatch', { target: agentFile.target });
    const managed = codexAgent.managedAgentFiles?.[agentFile.target];
    assertContract(
      managed?.sourceHash === sourceHash && managed?.installedHash === targetHash,
      flow,
      'managed-agent-ledger-mismatch',
      { target: agentFile.target }
    );
    assertContract(
      codexAgent.agentFileSources?.[agentFile.target]?.extensionName === EXTENSION_NAME,
      flow,
      'managed-agent-owner-mismatch',
      { target: agentFile.target }
    );
    entries.push({ target: agentFile.target, sourceHash, targetHash });
  }
  entries.sort((left, right) => left.target.localeCompare(right.target));
  return { count: entries.length, digest: stableJsonDigest(entries), entries };
}

async function seedPreservationSentinels(projectDir) {
  const configPath = path.join(projectDir, '.ai-factory', 'config.yaml');
  await appendFile(configPath, `\nconsumerSmoke:\n  unknownKey: ${CONFIG_SENTINEL}\n`, 'utf8');

  const ledgerPath = path.join(projectDir, '.ai-factory.json');
  const ledger = await readJson(ledgerPath);
  ledger.consumerSmoke = {
    unknownKey: LEDGER_SENTINEL,
    nested: { preserve: true }
  };
  await writeJson(ledgerPath, ledger);

  await writeProjectFile(
    projectDir,
    '.codex/agents/consumer-custom.toml',
    `name = "consumer-custom"\nsentinel = "${CUSTOM_AGENT_SENTINEL}"\n`
  );
  for (const [relativePath, content] of Object.entries(ARTIFACT_FIXTURES)) {
    await writeProjectFile(projectDir, relativePath, content);
  }
}

async function inspectRepresentativeArtifactShapes(projectDir, flow) {
  const classifierOptions = {
    rootDir: projectDir,
    legacyPlanSourceRoot: LEGACY_PLAN_SOURCE_ROOT
  };
  const [classic, ultra] = await Promise.all([
    classifyLegacyPlanShape(CLASSIC_PLAN_ID, classifierOptions),
    classifyLegacyPlanShape(ULTRA_PLAN_ID, classifierOptions)
  ]);
  const classicDetails = {
    shape: classic.shape,
    planFile: classic.planFile,
    planDir: classic.planDir,
    companionCount: Object.keys(classic.files ?? {}).length
  };
  assertContract(classic.shape === 'classic-pair', flow, 'classic-fixture-shape-invalid', classicDetails);
  assertContract(
    classic.planDir === `${LEGACY_PLAN_SOURCE_ROOT}/${CLASSIC_PLAN_ID}`,
    flow,
    'classic-fixture-companion-missing',
    classicDetails
  );
  assertContract(
    classic.files?.task === `${LEGACY_PLAN_SOURCE_ROOT}/${CLASSIC_PLAN_ID}/task.md`,
    flow,
    'classic-fixture-task-missing',
    classicDetails
  );

  const ultraDetails = {
    shape: ultra.shape,
    planDir: ultra.planDir,
    markerCount: ultra.markerCount,
    phaseCount: ultra.phaseFiles.length,
    errorCodes: ultra.errors.map((entry) => entry.code)
  };
  assertContract(ultra.shape === 'ultra-valid', flow, 'ultra-fixture-shape-invalid', ultraDetails);

  return {
    classic: {
      shape: classic.shape,
      planDir: classic.planDir,
      companionCount: classicDetails.companionCount
    },
    ultra: {
      shape: ultra.shape,
      markerCount: ultra.markerCount,
      phaseCount: ultra.phaseFiles.length
    }
  };
}

async function snapshotPreservationState(projectDir, flow) {
  const ledger = await readConsumerLedger(projectDir);
  const config = await readFile(path.join(projectDir, '.ai-factory', 'config.yaml'), 'utf8');
  const customAgent = await readFile(path.join(projectDir, '.codex', 'agents', 'consumer-custom.toml'));
  return {
    configDigest: sha256(config),
    configSentinelPresent: config.includes(CONFIG_SENTINEL),
    ledgerSentinel: ledger.consumerSmoke,
    customAgentDigest: sha256(customAgent),
    artifacts: await snapshotRelativeFiles(projectDir, ARTIFACT_PATHS),
    artifactShapes: await inspectRepresentativeArtifactShapes(projectDir, flow)
  };
}

async function assertPreservationState(projectDir, baseline, flow) {
  const current = await snapshotPreservationState(projectDir, flow);
  assertContract(current.configSentinelPresent, flow, 'unknown-yaml-config-key-lost');
  assertContract(current.configDigest === baseline.configDigest, flow, 'yaml-config-changed');
  assertContract(stableJsonDigest(current.ledgerSentinel) === stableJsonDigest(baseline.ledgerSentinel), flow, 'unknown-ledger-key-lost');
  assertContract(current.customAgentDigest === baseline.customAgentDigest, flow, 'unmanaged-agent-changed');
  assertContract(current.artifacts.digest === baseline.artifacts.digest, flow, 'artifact-digest-changed');
  assertContract(
    stableJsonDigest(current.artifacts.paths) === stableJsonDigest(baseline.artifacts.paths),
    flow,
    'artifact-path-set-changed'
  );
  assertContract(
    stableJsonDigest(current.artifactShapes) === stableJsonDigest(baseline.artifactShapes),
    flow,
    'artifact-shape-summary-changed'
  );
  return current;
}

async function createDummyExtension(fixtureDir) {
  const root = path.join(fixtureDir, DUMMY_EXTENSION_NAME);
  await writeProjectFile(root, 'extension.json', `${JSON.stringify({
    name: DUMMY_EXTENSION_NAME,
    version: '1.0.0',
    description: 'Local consumer smoke sentinel.',
    skills: ['skills/aifhub-smoke-dummy']
  }, null, 2)}\n`);
  await writeProjectFile(
    root,
    'skills/aifhub-smoke-dummy/SKILL.md',
    '---\nname: aifhub-smoke-dummy\ndescription: Consumer smoke sentinel.\n---\n\nDummy bytes must remain unchanged.\n'
  );
  return root;
}

async function snapshotDummyState(projectDir) {
  const ledger = await readConsumerLedger(projectDir);
  const extensionRecord = (ledger.extensions ?? []).find((entry) => entry.name === DUMMY_EXTENSION_NAME);
  assertContract(extensionRecord, 'targeted-update', 'missing-dummy-ledger');
  const trees = await snapshotTrees(projectDir, [
    `.ai-factory/extensions/${DUMMY_EXTENSION_NAME}`,
    '.codex/skills/aifhub-smoke-dummy'
  ]);
  assertContract(trees.entries.length > 0, 'targeted-update', 'missing-dummy-files');
  return {
    ledgerDigest: stableJsonDigest(extensionRecord),
    filesDigest: trees.digest,
    fileCount: trees.entries.length
  };
}

function selectiveSkillList(manifest) {
  return [...new Set((manifest.injections ?? []).map((entry) => entry.target))].sort();
}

async function runCleanInstallFlow(context) {
  const { extension, toolchains, runner, timeoutMs, networkEnabled, workspaceFactory, record } = context;
  const workspace = await workspaceFactory('clean');
  try {
    await invokeCli({
      toolchain: toolchains.v218,
      cliArgs: ['init', '--agents', 'codex', '--skills', 'all', '--config'],
      projectDir: workspace.projectDir,
      runner,
      timeoutMs,
      flow: 'clean-install',
      step: 'init-2.18',
      networkEnabled,
      record
    });
    await invokeCli({
      toolchain: toolchains.v218,
      cliArgs: ['extension', 'add', extension.root],
      projectDir: workspace.projectDir,
      runner,
      timeoutMs,
      flow: 'clean-install',
      step: 'extension-add',
      networkEnabled,
      record
    });
    await invokeCli({
      toolchain: toolchains.v218,
      cliArgs: ['aifhub-mode', 'openspec', '--json'],
      projectDir: workspace.projectDir,
      runner,
      timeoutMs,
      flow: 'clean-install',
      step: 'openspec-mode',
      networkEnabled,
      record
    });

    const ledger = await readConsumerLedger(workspace.projectDir);
    assertContract(ledger.version === EXPECTED_AI_FACTORY_VERSIONS.v218, 'clean-install', 'clean-ledger-version-mismatch');
    const config = await assertCanonicalOpenSpecConfig(workspace.projectDir, 'clean-install');
    const injections = await inspectInjectionCardinality(workspace.projectDir, extension.manifest, 'clean-install');
    const upstreamExplore = await inspectExploreUpstreamContract(
      workspace.projectDir,
      extension,
      toolchains.v218,
      'clean-install'
    );
    const transfer = await inspectTransferInventory(workspace.projectDir, 1, 'clean-install');
    const adapters = await assertAdapterInventory(workspace.projectDir, extension.manifest, 'clean-install');
    const agents = await assertManagedAgentsMatchSource(workspace.projectDir, extension, 'clean-install');
    record('clean-install', 'contract-assertions', SMOKE_STATUS.PASS, {
      injectionCount: injections.count,
      exploreUpstreamDigest: upstreamExplore.upstreamDigest,
      transferCount: transfer.fileCount,
      adapterCount: adapters.length,
      managedAgentCount: agents.count
    });
    return {
      status: SMOKE_STATUS.PASS,
      version: ledger.version,
      config,
      injections: { count: injections.count, digest: injections.digest },
      upstreamExplore,
      transfer,
      adapters,
      managedAgents: { count: agents.count, digest: agents.digest }
    };
  } finally {
    await workspace.cleanup();
  }
}

async function runUpdateFlows(context) {
  const { extension, toolchains, runner, timeoutMs, networkEnabled, workspaceFactory, record, result } = context;
  const workspace = await workspaceFactory('update');
  try {
    const selectedSkills = selectiveSkillList(extension.manifest);
    await invokeCli({
      toolchain: toolchains.v217,
      cliArgs: ['init', '--agents', 'codex', '--skills', selectedSkills.join(','), '--config'],
      projectDir: workspace.projectDir,
      runner,
      timeoutMs,
      flow: 'global-update',
      step: 'init-2.17',
      networkEnabled,
      record
    });
    await invokeCli({
      toolchain: toolchains.v217,
      cliArgs: ['extension', 'add', extension.root],
      projectDir: workspace.projectDir,
      runner,
      timeoutMs,
      flow: 'global-update',
      step: 'extension-add-2.17',
      networkEnabled,
      record
    });
    await invokeCli({
      toolchain: toolchains.v217,
      cliArgs: ['aifhub-mode', 'openspec', '--json'],
      projectDir: workspace.projectDir,
      runner,
      timeoutMs,
      flow: 'global-update',
      step: 'openspec-mode-2.17',
      networkEnabled,
      record
    });
    await seedPreservationSentinels(workspace.projectDir);
    const preservationBaseline = await snapshotPreservationState(workspace.projectDir, 'global-update');
    const beforeInjections = await inspectInjectionCardinality(workspace.projectDir, extension.manifest, 'global-update');
    const beforeTransfer = await inspectTransferInventory(workspace.projectDir, 0, 'global-update');
    record('global-update', 'preservation-snapshot', SMOKE_STATUS.PASS, {
      artifactCount: preservationBaseline.artifacts.paths.length,
      artifactDigest: preservationBaseline.artifacts.digest,
      artifactShapes: preservationBaseline.artifactShapes,
      injectionDigest: beforeInjections.digest,
      transferCount: beforeTransfer.fileCount,
      logPrefix: '[FIX:issue-152]'
    });

    await invokeCli({
      toolchain: toolchains.v218,
      cliArgs: ['update', '--force'],
      projectDir: workspace.projectDir,
      runner,
      timeoutMs,
      flow: 'global-update',
      step: 'global-update-force',
      networkEnabled,
      record
    });

    const globalLedger = await readConsumerLedger(workspace.projectDir);
    assertContract(globalLedger.version === EXPECTED_AI_FACTORY_VERSIONS.v218, 'global-update', 'global-ledger-version-mismatch');
    const globalPreservation = await assertPreservationState(workspace.projectDir, preservationBaseline, 'global-update');
    const globalInjections = await inspectInjectionCardinality(workspace.projectDir, extension.manifest, 'global-update');
    const globalExplore = await inspectExploreUpstreamContract(
      workspace.projectDir,
      extension,
      toolchains.v218,
      'global-update'
    );
    const globalTransfer = await inspectTransferInventory(workspace.projectDir, 0, 'global-update');
    const globalAgents = await assertManagedAgentsMatchSource(workspace.projectDir, extension, 'global-update');
    record('global-update', 'contract-assertions-recorded', SMOKE_STATUS.PASS, {
      artifactDigest: globalPreservation.artifacts.digest,
      injectionDigest: globalInjections.digest,
      exploreUpstreamDigest: globalExplore.upstreamDigest,
      transferCount: globalTransfer.fileCount,
      managedAgentCount: globalAgents.count
    });
    const globalResult = {
      status: SMOKE_STATUS.PASS,
      fromVersion: EXPECTED_AI_FACTORY_VERSIONS.v217,
      toVersion: globalLedger.version,
      preservation: {
        configDigest: globalPreservation.configDigest,
        customAgentDigest: globalPreservation.customAgentDigest,
        artifactCount: globalPreservation.artifacts.paths.length,
        artifactDigest: globalPreservation.artifacts.digest,
        artifactShapes: globalPreservation.artifactShapes
      },
      injections: { count: globalInjections.count, digest: globalInjections.digest },
      upstreamExplore: globalExplore,
      transfer: globalTransfer,
      managedAgents: { count: globalAgents.count, digest: globalAgents.digest }
    };
    result.flows.globalUpdate = globalResult;

    const dummySource = await createDummyExtension(workspace.fixtureDir);
    await invokeCli({
      toolchain: toolchains.v218,
      cliArgs: ['extension', 'add', dummySource],
      projectDir: workspace.projectDir,
      runner,
      timeoutMs,
      flow: 'targeted-update',
      step: 'dummy-extension-add-after-global',
      networkEnabled,
      record
    });
    const dummyBaseline = await snapshotDummyState(workspace.projectDir);
    const targetedPreservationBaseline = await snapshotPreservationState(workspace.projectDir, 'targeted-update');
    const targetedInjectionBaseline = await inspectInjectionCardinality(workspace.projectDir, extension.manifest, 'targeted-update');
    const targetAgent = extension.codexAgentFiles[0];
    const codexAgent = findCodexAgent(await readConsumerLedger(workspace.projectDir), 'targeted-update');
    const targetPath = path.resolve(workspace.projectDir, codexAgent.agentsDir ?? '.codex/agents', targetAgent.target);
    const sourcePath = path.resolve(extension.root, normalizeManifestPath(targetAgent.source));
    assertContract(isWithin(workspace.projectDir, targetPath), 'targeted-update', 'unsafe-stale-agent-target');
    const sourceHash = await hashFile(sourcePath);
    await writeFile(targetPath, `${STALE_AGENT_SENTINEL}\n`, 'utf8');
    const staleHash = await hashFile(targetPath);
    assertContract(staleHash !== sourceHash, 'targeted-update', 'stale-sentinel-hash-collision');
    record('targeted-update', 'dummy-snapshotted-and-agent-staled', SMOKE_STATUS.PASS, {
      dummyLedgerDigest: dummyBaseline.ledgerDigest,
      dummyFilesDigest: dummyBaseline.filesDigest,
      target: targetAgent.target,
      staleHash
    });

    await invokeCli({
      toolchain: toolchains.v218,
      cliArgs: ['extension', 'update', EXTENSION_NAME, '--force'],
      projectDir: workspace.projectDir,
      runner,
      timeoutMs,
      flow: 'targeted-update',
      step: 'exact-targeted-extension-update',
      networkEnabled,
      record
    });

    const targetHash = await hashFile(targetPath);
    assertContract(targetHash !== staleHash, 'targeted-update', 'targeted-update-was-no-op');
    assertContract(targetHash === sourceHash, 'targeted-update', 'targeted-agent-source-mismatch');
    const targetedAgents = await assertManagedAgentsMatchSource(workspace.projectDir, extension, 'targeted-update');
    const dummyCurrent = await snapshotDummyState(workspace.projectDir);
    assertContract(dummyCurrent.ledgerDigest === dummyBaseline.ledgerDigest, 'targeted-update', 'dummy-ledger-changed');
    assertContract(dummyCurrent.filesDigest === dummyBaseline.filesDigest, 'targeted-update', 'dummy-files-changed');
    const targetedPreservation = await assertPreservationState(
      workspace.projectDir,
      targetedPreservationBaseline,
      'targeted-update'
    );
    const targetedInjections = await inspectInjectionCardinality(workspace.projectDir, extension.manifest, 'targeted-update');
    const targetedExplore = await inspectExploreUpstreamContract(
      workspace.projectDir,
      extension,
      toolchains.v218,
      'targeted-update'
    );
    assertContract(
      targetedInjections.digest === targetedInjectionBaseline.digest,
      'targeted-update',
      'targeted-injection-cardinality-changed'
    );
    const targetedTransfer = await inspectTransferInventory(workspace.projectDir, 0, 'targeted-update');
    record('targeted-update', 'contract-assertions', SMOKE_STATUS.PASS, {
      target: targetAgent.target,
      sourceHash,
      targetHash,
      dummyLedgerDigest: dummyCurrent.ledgerDigest,
      dummyFilesDigest: dummyCurrent.filesDigest,
      artifactDigest: targetedPreservation.artifacts.digest,
      injectionDigest: targetedInjections.digest
    });
    return {
      globalUpdate: globalResult,
      targetedUpdate: {
        status: SMOKE_STATUS.PASS,
        exactCommand: ['extension', 'update', EXTENSION_NAME, '--force'],
        target: targetAgent.target,
        staleHash,
        sourceHash,
        targetHash,
        dummy: dummyCurrent,
        preservation: {
          configDigest: targetedPreservation.configDigest,
          customAgentDigest: targetedPreservation.customAgentDigest,
          artifactCount: targetedPreservation.artifacts.paths.length,
          artifactDigest: targetedPreservation.artifacts.digest,
          artifactShapes: targetedPreservation.artifactShapes
        },
        injections: { count: targetedInjections.count, digest: targetedInjections.digest },
        upstreamExplore: targetedExplore,
        transfer: targetedTransfer,
        managedAgents: { count: targetedAgents.count, digest: targetedAgents.digest }
      }
    };
  } finally {
    await workspace.cleanup();
  }
}

function applyFailure(result, error) {
  const failure = error instanceof SmokeFailure
    ? error
    : new SmokeFailure(SMOKE_STATUS.FAIL, 'internal', 'unexpected-smoke-error');
  result.status = failure.status;
  result.failure = {
    flow: failure.flow,
    code: failure.code,
    ...(Object.keys(failure.details ?? {}).length > 0 ? { details: failure.details } : {})
  };
  const flowKey = failure.flow === 'clean-install'
    ? 'cleanInstall'
    : failure.flow === 'global-update'
      ? 'globalUpdate'
      : failure.flow === 'targeted-update'
        ? 'targetedUpdate'
        : null;
  if (flowKey) result.flows[flowKey] = { status: failure.status, code: failure.code };
  return result;
}

export async function runAiFactory218ConsumerSmoke({
  toolchains,
  extensionRoot,
  runner = createNoShellProcessRunner(),
  workspaceFactory = createTemporaryWorkspaceFactory(),
  timeoutMs: timeoutInput,
  networkEnabled = false,
  evidence = 'live'
} = {}) {
  const result = createResult(evidence);
  const record = createRecorder(result);
  try {
    const timeoutMs = resolveTimeoutMs(timeoutInput);
    const extension = await validateExtensionRoot(extensionRoot);
    const boundToolchains = {
      v217: await validateBoundToolchain(toolchains?.v217, 'v217', EXPECTED_AI_FACTORY_VERSIONS.v217),
      v218: await validateBoundToolchain(toolchains?.v218, 'v218', EXPECTED_AI_FACTORY_VERSIONS.v218)
    };
    if (typeof runner.preflight === 'function') {
      await runner.preflight({
        command: boundToolchains.v217.command,
        args: [...boundToolchains.v217.argv, '--version']
      });
      await runner.preflight({
        command: boundToolchains.v218.command,
        args: [...boundToolchains.v218.argv, '--version']
      });
    }
    record('preflight', 'local-prerequisites', SMOKE_STATUS.PASS, {
      extensionManifestDigest: extension.manifestDigest,
      networkEnabled: Boolean(networkEnabled),
      timeoutMs
    });

    result.versions.v217 = await probeToolchain({
      toolchain: boundToolchains.v217,
      runner,
      timeoutMs,
      networkEnabled,
      record
    });
    result.versions.v218 = await probeToolchain({
      toolchain: boundToolchains.v218,
      runner,
      timeoutMs,
      networkEnabled,
      record
    });
    record('preflight', 'identity-complete-before-project-mutation', SMOKE_STATUS.PASS);

    const context = {
      extension,
      toolchains: boundToolchains,
      runner,
      timeoutMs,
      networkEnabled,
      workspaceFactory,
      record,
      result
    };
    result.flows.cleanInstall = await runCleanInstallFlow(context);
    const updates = await runUpdateFlows(context);
    result.flows.globalUpdate = updates.globalUpdate;
    result.flows.targetedUpdate = updates.targetedUpdate;
    result.status = SMOKE_STATUS.PASS;
    return result;
  } catch (error) {
    return applyFailure(result, error);
  }
}

export function summarizeSmokeResult(result) {
  return {
    schemaVersion: result.schemaVersion,
    suite: result.suite,
    evidence: result.evidence,
    status: result.status,
    compatibilityScope: result.compatibilityScope,
    provesReleaseOrDeployment: false,
    versions: result.versions,
    flows: result.flows,
    events: result.events,
    ...(result.failure ? { failure: result.failure } : {})
  };
}
