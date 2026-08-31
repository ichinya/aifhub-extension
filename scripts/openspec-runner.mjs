// openspec-runner.mjs - shared OpenSpec CLI runner and capability detection
import { execFile as execFileCallback } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

export const OPENSPEC_SUPPORTED_RANGE = '>=1.3.1 <2.0.0';
export const OPENSPEC_NODE_RANGE = '>=20.19.0';
export const OPENSPEC_LATEST_REVIEWED_VERSION = '1.9.0';

const execFileAsync = promisify(execFileCallback);
const OPENSPEC_MIN_VERSION = '1.3.1';
const OPENSPEC_MAX_VERSION = '2.0.0';
const NODE_MIN_VERSION = '20.19.0';
const DEFAULT_MAX_BUFFER = 10 * 1024 * 1024;
const WINDOWS_SCRIPT_EXTENSIONS = ['.cmd', '.bat'];
const WINDOWS_CMD_META_CHARACTERS = /([()\][%!^"`<>&|;, *?])/g;
const COMMAND_SOURCES = new Set(['explicit', 'project-local', 'path']);

const ERRORS = {
  invalidJson: {
    code: 'invalid-json',
    message: 'OpenSpec command returned invalid JSON.'
  },
  missingCli(command, commandSource) {
    return {
      code: 'missing-cli',
      message: `Selected OpenSpec CLI '${command}' (${commandSource}) is unavailable.`
    };
  },
  nonZeroExit(exitCode, command, commandSource) {
    return {
      code: 'non-zero-exit',
      message: `OpenSpec command '${command}' (${commandSource}) failed with exit code ${exitCode}.`
    };
  },
  unsupportedNode(nodeVersion) {
    return {
      code: 'unsupported-node',
      message: `Node ${nodeVersion} does not satisfy OpenSpec requirement ${OPENSPEC_NODE_RANGE}.`
    };
  },
  unsupportedVersion(version, command, commandSource) {
    return {
      code: 'unsupported-version',
      message: `OpenSpec CLI '${command}' (${commandSource}) reported version ${version}, outside supported range ${OPENSPEC_SUPPORTED_RANGE}.`
    };
  },
  versionDetectionFailed(command, commandSource) {
    return {
      code: 'version-detection-failed',
      message: `OpenSpec version detection failed for '${command}' (${commandSource}).`
    };
  }
};

export function resolveOpenSpecCommand(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const platform = options.platform ?? process.platform;
  const pathApi = getPlatformPath(platform);
  const candidateExists = options.candidateExists ?? isAccessibleFile;
  const explicitCommand = getExplicitCommand(options);

  if (explicitCommand !== null) {
    return createCommandResolution({
      executable: explicitCommand,
      displayCommand: createSafeCommandDisplay(explicitCommand, cwd, pathApi),
      commandSource: 'explicit'
    });
  }

  const resolvedCwd = pathApi.resolve(String(cwd));
  const localExecutable = pathApi.join(
    resolvedCwd,
    'node_modules',
    '.bin',
    platform === 'win32' ? 'openspec.cmd' : 'openspec'
  );

  if (candidateExists(localExecutable)) {
    return createCommandResolution({
      executable: localExecutable,
      displayCommand: toPosix(pathApi.relative(resolvedCwd, localExecutable)),
      commandSource: 'project-local'
    });
  }

  return createCommandResolution({
    executable: 'openspec',
    displayCommand: 'openspec',
    commandSource: 'path'
  });
}

function getExplicitCommand(options) {
  if (!Object.prototype.hasOwnProperty.call(options, 'command') || options.command === undefined) {
    return null;
  }

  const command = String(options.command ?? '').trim();
  return command.length > 0 ? command : null;
}

function createCommandResolution({ executable, displayCommand, commandSource }) {
  if (!COMMAND_SOURCES.has(commandSource)) {
    throw new Error(`Invalid OpenSpec command source: ${commandSource}.`);
  }

  return {
    executable,
    displayCommand: boundCommandDisplay(displayCommand),
    commandSource
  };
}

function createSafeCommandDisplay(command, cwd, pathApi) {
  const commandText = String(command);

  if (!pathApi.isAbsolute(commandText)) {
    return toPosix(commandText);
  }

  const resolvedCwd = pathApi.resolve(String(cwd));
  const resolvedCommand = pathApi.resolve(commandText);
  const relative = pathApi.relative(resolvedCwd, resolvedCommand);

  if (isSafeRelativePath(relative, pathApi)) {
    return toPosix(relative || pathApi.basename(resolvedCommand));
  }

  return pathApi.basename(resolvedCommand) || 'openspec';
}

function isSafeRelativePath(relativePath, pathApi) {
  return relativePath.length === 0
    || (!relativePath.startsWith('..') && !pathApi.isAbsolute(relativePath));
}

function boundCommandDisplay(value) {
  const normalized = String(value ?? 'openspec')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim();
  const display = normalized.length > 0 ? normalized : 'openspec';
  return display.length <= 240 ? display : `…${display.slice(-239)}`;
}

function getPlatformPath(platform) {
  return platform === 'win32' ? path.win32 : path.posix;
}

function toPosix(value) {
  return String(value).replaceAll('\\', '/');
}

export async function detectOpenSpec(options = {}) {
  const {
    cwd = process.cwd(),
    env = process.env,
    nodeVersion = process.versions.node
  } = options;

  const nodeSupported = satisfiesGte(nodeVersion, NODE_MIN_VERSION);
  const versionResult = await runOpenSpec(['--version'], {
    ...options,
    cwd,
    env,
    expectJson: false
  });
  const command = versionResult.command;
  const commandSource = versionResult.commandSource;

  if (versionResult.error?.code === 'missing-cli') {
    return createDetectionResult({
      available: false,
      command,
      commandSource,
      nodeVersion,
      nodeSupported,
      reason: 'missing-cli',
      errors: [ERRORS.missingCli(command, commandSource)]
    });
  }

  if (!versionResult.ok) {
    return createDetectionResult({
      available: true,
      command,
      commandSource,
      nodeVersion,
      nodeSupported,
      reason: 'version-detection-failed',
      errors: [ERRORS.versionDetectionFailed(command, commandSource)]
    });
  }

  const version = extractOpenSpecVersion(`${versionResult.stdout}\n${versionResult.stderr}`);

  if (version === null) {
    return createDetectionResult({
      available: true,
      command,
      commandSource,
      nodeVersion,
      nodeSupported,
      reason: 'version-detection-failed',
      errors: [ERRORS.versionDetectionFailed(command, commandSource)]
    });
  }

  const versionSupported = satisfiesGteLt(version, OPENSPEC_MIN_VERSION, OPENSPEC_MAX_VERSION);
  const errors = [];

  if (!nodeSupported) {
    errors.push(ERRORS.unsupportedNode(nodeVersion));
  }

  if (!versionSupported) {
    errors.push(ERRORS.unsupportedVersion(version, command, commandSource));
  }

  const capabilitiesEnabled = errors.length === 0;

  return createDetectionResult({
    available: true,
    canValidate: capabilitiesEnabled,
    canArchive: capabilitiesEnabled,
    version,
    command,
    commandSource,
    nodeVersion,
    nodeSupported,
    versionSupported,
    reason: capabilitiesEnabled ? null : errors[0].code,
    errors
  });
}

export async function runOpenSpec(args, options = {}) {
  const {
    cwd = process.cwd(),
    env = process.env,
    expectJson = false
  } = options;
  const resolution = resolveOpenSpecCommand({
    command: options.command,
    cwd,
    platform: options.platform,
    candidateExists: options.candidateExists
  });
  const executor = options.executor ?? ((call) => executeOpenSpecCommand({
    ...call,
    platform: options.platform,
    execFile: options.execFile,
    comSpec: options.comSpec,
    candidateExists: options.candidateExists
  }));

  const normalizedArgs = Array.from(args ?? []);
  const base = {
    ok: false,
    exitCode: null,
    command: resolution.displayCommand,
    commandSource: resolution.commandSource,
    args: normalizedArgs,
    cwd,
    stdout: '',
    stderr: '',
    json: null,
    jsonParseError: null,
    error: null
  };

  let execution;

  try {
    execution = await executor({
      command: resolution.executable,
      args: normalizedArgs,
      cwd,
      env
    });
  } catch (err) {
    return {
      ...base,
      ...normalizeThrownExecutionError(err, resolution)
    };
  }

  const exitCode = execution.exitCode ?? 0;
  const stdout = normalizeOutput(execution.stdout);
  const stderr = normalizeOutput(execution.stderr);

  if (exitCode !== 0) {
    return {
      ...base,
      exitCode,
      stdout,
      stderr,
      error: ERRORS.nonZeroExit(
        exitCode,
        resolution.displayCommand,
        resolution.commandSource
      )
    };
  }

  if (expectJson) {
    try {
      return {
        ...base,
        ok: true,
        exitCode,
        stdout,
        stderr,
        json: JSON.parse(stdout),
        error: null
      };
    } catch {
      return {
        ...base,
        exitCode,
        stdout,
        stderr,
        jsonParseError: ERRORS.invalidJson,
        error: ERRORS.invalidJson
      };
    }
  }

  return {
    ...base,
    ok: true,
    exitCode,
    stdout,
    stderr,
    error: null
  };
}

export async function validateOpenSpecChange(changeId, options = {}) {
  return runOpenSpec([
    'validate',
    changeId,
    '--type',
    'change',
    '--strict',
    '--json',
    '--no-interactive',
    '--no-color'
  ], {
    ...options,
    expectJson: true
  });
}

export async function getOpenSpecStatus(changeId, options = {}) {
  return runOpenSpec([
    'status',
    '--change',
    changeId,
    '--json',
    '--no-color'
  ], {
    ...options,
    expectJson: true
  });
}

export async function showOpenSpecItem(itemName, options = {}) {
  const { type, deltasOnly = false, ...runOptions } = options;
  const args = ['show', itemName];

  if (type !== undefined) {
    args.push('--type', type);
  }

  if (deltasOnly) {
    args.push('--deltas-only');
  }

  args.push('--json', '--no-interactive', '--no-color');

  return runOpenSpec(args, {
    ...runOptions,
    expectJson: true
  });
}

export async function getOpenSpecInstructions(artifact, options = {}) {
  const { change, ...runOptions } = options;
  const args = ['instructions', artifact];

  if (change !== undefined) {
    args.push('--change', change);
  }

  args.push('--json', '--no-color');

  return runOpenSpec(args, {
    ...runOptions,
    expectJson: true
  });
}

export async function archiveOpenSpecChange(changeId, options = {}) {
  const {
    skipSpecs = false,
    noValidate = false,
    ...runOptions
  } = options;
  const args = ['archive', changeId, '--yes'];

  if (skipSpecs) {
    args.push('--skip-specs');
  }

  if (noValidate) {
    args.push('--no-validate');
  }

  args.push('--no-color');

  return runOpenSpec(args, {
    ...runOptions,
    expectJson: false
  });
}

export async function executeOpenSpecCommand(options = {}) {
  const {
    command,
    args = [],
    cwd = process.cwd(),
    env = process.env
  } = options;
  const platform = options.platform ?? process.platform;
  const execFileImplementation = options.execFile ?? execFileAsync;
  const candidateExists = options.candidateExists ?? isAccessibleFile;
  const comSpec = options.comSpec
    ?? getEnvValue(env, 'ComSpec')
    ?? process.env.ComSpec
    ?? 'cmd.exe';
  const execOptions = {
    cwd,
    env,
    maxBuffer: DEFAULT_MAX_BUFFER,
    windowsHide: true
  };

  if (platform === 'win32' && isWindowsCommandScript(command)) {
    return executeWindowsCommandScript({
      commandPath: command,
      args,
      execOptions,
      execFileImplementation,
      comSpec
    });
  }

  try {
    const { stdout, stderr } = await execFileImplementation(command, args, execOptions);

    return {
      exitCode: 0,
      stdout,
      stderr
    };
  } catch (err) {
    if (err.code === 'ENOENT') {
      const windowsShim = findWindowsCommandScript(command, env, {
        platform,
        candidateExists
      });
      if (windowsShim !== null) {
        return executeWindowsCommandScript({
          commandPath: windowsShim,
          args,
          execOptions,
          execFileImplementation,
          comSpec,
          originalError: err
        });
      }

      throw err;
    }

    const exitCode = getExitCode(err);

    if (exitCode !== null) {
      return {
        exitCode,
        stdout: err.stdout,
        stderr: err.stderr
      };
    }

    throw err;
  }
}

async function executeWindowsCommandScript({
  commandPath,
  args,
  execOptions,
  execFileImplementation,
  comSpec,
  originalError = null
}) {
  const commandInterpreter = validateWindowsCommandInterpreter(comSpec);

  try {
    const { stdout, stderr } = await execFileImplementation(
      commandInterpreter,
      ['/d', '/s', '/v:off', '/c', quoteCmdCommand(commandPath, args)],
      {
        ...execOptions,
        windowsVerbatimArguments: true
      }
    );

    return {
      exitCode: 0,
      stdout,
      stderr
    };
  } catch (err) {
    const exitCode = getExitCode(err);

    if (exitCode !== null) {
      return {
        exitCode,
        stdout: err.stdout,
        stderr: err.stderr
      };
    }

    throw originalError ?? err;
  }
}

function validateWindowsCommandInterpreter(value) {
  const commandInterpreter = String(value ?? '').trim();
  if (
    !path.win32.isAbsolute(commandInterpreter)
    || path.win32.basename(commandInterpreter).toLowerCase() !== 'cmd.exe'
  ) {
    const error = new Error('Windows command scripts require ComSpec to be an absolute cmd.exe path.');
    error.code = 'invalid-comspec';
    throw error;
  }
  return commandInterpreter;
}

function findWindowsCommandScript(command, env, options = {}) {
  const platform = options.platform ?? process.platform;
  const candidateExists = options.candidateExists ?? isAccessibleFile;

  if (platform !== 'win32') {
    return null;
  }

  const commandText = String(command ?? '');
  if (commandText.length === 0) {
    return null;
  }

  if (hasPathSeparator(commandText)) {
    return resolveWindowsScriptCandidate(commandText, candidateExists);
  }

  for (const directory of getWindowsPathEntries(env, platform)) {
    const resolved = resolveWindowsScriptCandidate(path.win32.join(directory, commandText), candidateExists);
    if (resolved !== null) {
      return resolved;
    }
  }

  return null;
}

function resolveWindowsScriptCandidate(candidateBase, candidateExists = isAccessibleFile) {
  const extension = path.win32.extname(candidateBase).toLowerCase();
  const candidates = WINDOWS_SCRIPT_EXTENSIONS.includes(extension)
    ? [candidateBase]
    : WINDOWS_SCRIPT_EXTENSIONS.map((suffix) => `${candidateBase}${suffix}`);

  return candidates.find(candidateExists) ?? null;
}

function isWindowsCommandScript(command) {
  return WINDOWS_SCRIPT_EXTENSIONS.includes(path.win32.extname(String(command ?? '')).toLowerCase());
}

function getWindowsPathEntries(env, platform = process.platform) {
  const pathValue = getEnvValue(env, 'PATH');
  if (pathValue === null) {
    return [];
  }

  return pathValue
    .split(platform === 'win32' ? path.win32.delimiter : path.delimiter)
    .filter((item) => item.trim().length > 0);
}

function getEnvValue(env, key) {
  const source = env ?? process.env;
  const exact = source[key];
  if (exact !== undefined) {
    return String(exact);
  }

  const lowerKey = key.toLowerCase();
  const matchingKey = Object.keys(source).find((item) => item.toLowerCase() === lowerKey);
  return matchingKey === undefined ? null : String(source[matchingKey]);
}

function hasPathSeparator(value) {
  return value.includes('/') || value.includes('\\');
}

function isAccessibleFile(filePath) {
  try {
    accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    try {
      accessSync(filePath, constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }
}

function quoteCmdCommand(commandPath, args) {
  return `"${[
    escapeCmdMetaCharacters(commandPath),
    ...Array.from(args ?? [], quoteCmdArg)
  ].join(' ')}"`;
}

function quoteCmdArg(value) {
  let argument = String(value);

  argument = argument.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"');
  argument = argument.replace(/(?=(\\+?)?)\1$/, '$1$1');
  argument = `"${argument}"`;

  // A command shim parses metacharacters once in cmd.exe and again when the
  // batch file expands its forwarded arguments, so preserve them through both.
  return escapeCmdMetaCharacters(escapeCmdMetaCharacters(argument));
}

function escapeCmdMetaCharacters(value) {
  return String(value).replace(WINDOWS_CMD_META_CHARACTERS, '^$1');
}

function createDetectionResult(overrides = {}) {
  const version = overrides.version ?? null;
  const versionSupported = overrides.versionSupported ?? false;
  const nodeVersion = overrides.nodeVersion ?? process.versions.node;
  const nodeSupported = overrides.nodeSupported ?? satisfiesGte(nodeVersion, NODE_MIN_VERSION);
  const reviewedComparison = versionSupported
    ? compareSemver(version, OPENSPEC_LATEST_REVIEWED_VERSION)
    : null;
  const versionOutdated = reviewedComparison === null ? null : reviewedComparison < 0;

  return {
    available: overrides.available ?? false,
    canValidate: overrides.canValidate ?? false,
    canArchive: overrides.canArchive ?? false,
    version,
    supportedRange: OPENSPEC_SUPPORTED_RANGE,
    versionSupported,
    latestReviewedVersion: OPENSPEC_LATEST_REVIEWED_VERSION,
    versionOutdated,
    requiresNode: OPENSPEC_NODE_RANGE,
    nodeVersion,
    nodeSupported,
    command: overrides.command ?? 'openspec',
    commandSource: overrides.commandSource ?? 'path',
    reason: overrides.reason ?? null,
    errors: overrides.errors ?? []
  };
}

function normalizeThrownExecutionError(err, resolution) {
  if (err?.code === 'ENOENT') {
    return {
      error: ERRORS.missingCli(
        resolution.displayCommand,
        resolution.commandSource
      )
    };
  }

  return {
    stdout: normalizeOutput(err?.stdout),
    stderr: normalizeOutput(err?.stderr),
    error: {
      code: err?.code ?? 'execution-failed',
      message: err?.message ?? 'OpenSpec command execution failed.'
    }
  };
}

function normalizeOutput(value) {
  if (value === undefined || value === null) {
    return '';
  }

  return Buffer.isBuffer(value) ? value.toString('utf8') : String(value);
}

function getExitCode(err) {
  if (Number.isInteger(err?.code)) {
    return err.code;
  }

  if (Number.isInteger(err?.exitCode)) {
    return err.exitCode;
  }

  if (Number.isInteger(err?.status)) {
    return err.status;
  }

  return null;
}

function extractOpenSpecVersion(output) {
  const parsed = parseSemver(output);

  if (parsed === null) {
    return null;
  }

  return formatSemver(parsed);
}

function parseSemver(version) {
  const match = String(version).match(/(?:^|[^\d])(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?/);

  if (!match) {
    return null;
  }

  return {
    major: Number.parseInt(match[1], 10),
    minor: Number.parseInt(match[2], 10),
    patch: Number.parseInt(match[3], 10),
    prerelease: match[4] ?? null,
    build: match[5] ?? null
  };
}

function formatSemver(version) {
  let result = `${version.major}.${version.minor}.${version.patch}`;

  if (version.prerelease !== null) {
    result += `-${version.prerelease}`;
  }

  if (version.build !== null) {
    result += `+${version.build}`;
  }

  return result;
}

function compareSemver(a, b) {
  const left = parseSemver(a);
  const right = parseSemver(b);

  if (left === null || right === null) {
    return null;
  }

  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] > right[key]) {
      return 1;
    }

    if (left[key] < right[key]) {
      return -1;
    }
  }

  const prereleaseComparison = comparePrerelease(left.prerelease, right.prerelease);

  if (prereleaseComparison !== 0) {
    return prereleaseComparison;
  }

  return 0;
}

function comparePrerelease(left, right) {
  if (left === null && right === null) {
    return 0;
  }

  if (left === null) {
    return 1;
  }

  if (right === null) {
    return -1;
  }

  const leftParts = left.split('.');
  const rightParts = right.split('.');
  const maxLength = Math.max(leftParts.length, rightParts.length);

  for (let i = 0; i < maxLength; i += 1) {
    const leftPart = leftParts[i];
    const rightPart = rightParts[i];

    if (leftPart === undefined) {
      return -1;
    }

    if (rightPart === undefined) {
      return 1;
    }

    const partComparison = comparePrereleasePart(leftPart, rightPart);

    if (partComparison !== 0) {
      return partComparison;
    }
  }

  return 0;
}

function comparePrereleasePart(left, right) {
  const leftNumeric = isNumericIdentifier(left);
  const rightNumeric = isNumericIdentifier(right);

  if (leftNumeric && rightNumeric) {
    return Number(left) - Number(right);
  }

  if (leftNumeric) {
    return -1;
  }

  if (rightNumeric) {
    return 1;
  }

  return left.localeCompare(right);
}

function isNumericIdentifier(value) {
  return /^(0|[1-9]\d*)$/.test(value);
}

function satisfiesGteLt(version, min, max) {
  const parsed = parseSemver(version);
  const minComparison = compareSemver(version, min);
  const maxComparison = compareSemver(version, max);

  return parsed !== null
    && parsed.prerelease === null
    && minComparison !== null
    && maxComparison !== null
    && minComparison >= 0
    && maxComparison < 0;
}

function satisfiesGte(version, min) {
  const parsed = parseSemver(version);
  const comparison = compareSemver(version, min);
  return parsed !== null
    && parsed.prerelease === null
    && comparison !== null
    && comparison >= 0;
}
