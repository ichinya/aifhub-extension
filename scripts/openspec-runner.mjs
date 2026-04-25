// openspec-runner.mjs - shared OpenSpec CLI runner and capability detection
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export const OPENSPEC_SUPPORTED_RANGE = '>=1.3.1 <2.0.0';
export const OPENSPEC_NODE_RANGE = '>=20.19.0';

const execFileAsync = promisify(execFile);
const OPENSPEC_MIN_VERSION = '1.3.1';
const OPENSPEC_MAX_VERSION = '2.0.0';
const NODE_MIN_VERSION = '20.19.0';
const DEFAULT_MAX_BUFFER = 10 * 1024 * 1024;

const ERRORS = {
  invalidJson: {
    code: 'invalid-json',
    message: 'OpenSpec command returned invalid JSON.'
  },
  missingCli: {
    code: 'missing-cli',
    message: 'OpenSpec CLI is not available on PATH.'
  },
  nonZeroExit(exitCode) {
    return {
      code: 'non-zero-exit',
      message: `OpenSpec command failed with exit code ${exitCode}.`
    };
  },
  unsupportedNode(nodeVersion) {
    return {
      code: 'unsupported-node',
      message: `Node ${nodeVersion} does not satisfy OpenSpec requirement ${OPENSPEC_NODE_RANGE}.`
    };
  },
  unsupportedVersion(version) {
    return {
      code: 'unsupported-version',
      message: `OpenSpec CLI version ${version} is outside supported range ${OPENSPEC_SUPPORTED_RANGE}.`
    };
  },
  versionDetectionFailed: {
    code: 'version-detection-failed',
    message: 'OpenSpec version detection failed.'
  }
};

export async function detectOpenSpec(options = {}) {
  const {
    command = 'openspec',
    cwd = process.cwd(),
    env = process.env,
    executor = defaultExecutor,
    nodeVersion = process.versions.node
  } = options;

  const nodeSupported = satisfiesGte(nodeVersion, NODE_MIN_VERSION);
  const versionResult = await runOpenSpec(['--version'], {
    command,
    cwd,
    env,
    executor,
    expectJson: false
  });

  if (versionResult.error?.code === 'missing-cli') {
    return createDetectionResult({
      available: false,
      command,
      nodeVersion,
      nodeSupported,
      reason: 'missing-cli',
      errors: [ERRORS.missingCli]
    });
  }

  if (!versionResult.ok) {
    return createDetectionResult({
      available: true,
      command,
      nodeVersion,
      nodeSupported,
      reason: 'version-detection-failed',
      errors: [ERRORS.versionDetectionFailed]
    });
  }

  const version = extractOpenSpecVersion(`${versionResult.stdout}\n${versionResult.stderr}`);

  if (version === null) {
    return createDetectionResult({
      available: true,
      command,
      nodeVersion,
      nodeSupported,
      reason: 'version-detection-failed',
      errors: [ERRORS.versionDetectionFailed]
    });
  }

  const versionSupported = satisfiesGteLt(version, OPENSPEC_MIN_VERSION, OPENSPEC_MAX_VERSION);
  const errors = [];

  if (!nodeSupported) {
    errors.push(ERRORS.unsupportedNode(nodeVersion));
  }

  if (!versionSupported) {
    errors.push(ERRORS.unsupportedVersion(version));
  }

  const capabilitiesEnabled = errors.length === 0;

  return createDetectionResult({
    available: true,
    canValidate: capabilitiesEnabled,
    canArchive: capabilitiesEnabled,
    version,
    command,
    nodeVersion,
    nodeSupported,
    versionSupported,
    reason: capabilitiesEnabled ? null : errors[0].code,
    errors
  });
}

export async function runOpenSpec(args, options = {}) {
  const {
    command = 'openspec',
    cwd = process.cwd(),
    env = process.env,
    executor = defaultExecutor,
    expectJson = false
  } = options;

  const normalizedArgs = Array.from(args ?? []);
  const base = {
    ok: false,
    exitCode: null,
    command,
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
      command,
      args: normalizedArgs,
      cwd,
      env
    });
  } catch (err) {
    return {
      ...base,
      ...normalizeThrownExecutionError(err)
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
      error: ERRORS.nonZeroExit(exitCode)
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

async function defaultExecutor({ command, args, cwd, env }) {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      cwd,
      env,
      maxBuffer: DEFAULT_MAX_BUFFER,
      windowsHide: true
    });

    return {
      exitCode: 0,
      stdout,
      stderr
    };
  } catch (err) {
    if (err.code === 'ENOENT') {
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

function createDetectionResult(overrides = {}) {
  const version = overrides.version ?? null;
  const versionSupported = overrides.versionSupported ?? false;
  const nodeVersion = overrides.nodeVersion ?? process.versions.node;
  const nodeSupported = overrides.nodeSupported ?? satisfiesGte(nodeVersion, NODE_MIN_VERSION);

  return {
    available: overrides.available ?? false,
    canValidate: overrides.canValidate ?? false,
    canArchive: overrides.canArchive ?? false,
    version,
    supportedRange: OPENSPEC_SUPPORTED_RANGE,
    versionSupported,
    requiresNode: OPENSPEC_NODE_RANGE,
    nodeVersion,
    nodeSupported,
    command: overrides.command ?? 'openspec',
    reason: overrides.reason ?? null,
    errors: overrides.errors ?? []
  };
}

function normalizeThrownExecutionError(err) {
  if (err?.code === 'ENOENT') {
    return {
      error: ERRORS.missingCli
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

  return `${parsed.major}.${parsed.minor}.${parsed.patch}`;
}

function parseSemver(version) {
  const match = String(version).match(/(?:^|[^\d])(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?/);

  if (!match) {
    return null;
  }

  return {
    major: Number.parseInt(match[1], 10),
    minor: Number.parseInt(match[2], 10),
    patch: Number.parseInt(match[3], 10)
  };
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

  return 0;
}

function satisfiesGteLt(version, min, max) {
  const minComparison = compareSemver(version, min);
  const maxComparison = compareSemver(version, max);

  return minComparison !== null
    && maxComparison !== null
    && minComparison >= 0
    && maxComparison < 0;
}

function satisfiesGte(version, min) {
  const comparison = compareSemver(version, min);
  return comparison !== null && comparison >= 0;
}
