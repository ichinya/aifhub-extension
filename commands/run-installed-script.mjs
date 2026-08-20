// run-installed-script.mjs - helpers for extension command wrappers
import { spawn as spawnChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DEFAULT_KILL_TIMEOUT_MS = 5000;
const TIMEOUT_EXIT_CODE = 124;

export function resolveInstalledScriptPath(scriptRelativePath, moduleUrl) {
  return fileURLToPath(new URL(scriptRelativePath, moduleUrl));
}

export async function runInstalledScript(scriptRelativePath, args = [], moduleUrl, options = {}) {
  const processLike = options.processLike ?? process;
  const spawn = options.spawn ?? spawnChildProcess;
  const stdio = options.stdio ?? 'inherit';
  const timeout = normalizeTimeout(options.timeout, 'timeout');
  const killTimeout = normalizeTimeout(
    options.killTimeout ?? DEFAULT_KILL_TIMEOUT_MS,
    'killTimeout'
  );
  const timeoutExitCode = normalizeExitCode(options.timeoutExitCode ?? TIMEOUT_EXIT_CODE);
  const setTimeoutImplementation = options.setTimeout ?? globalThis.setTimeout;
  const clearTimeoutImplementation = options.clearTimeout ?? globalThis.clearTimeout;
  const scriptPath = resolveInstalledScriptPath(scriptRelativePath, moduleUrl);
  const forwardedArgs = Array.isArray(args) ? args : [];

  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(processLike.execPath, [scriptPath, ...forwardedArgs], {
      cwd: processLike.cwd(),
      env: processLike.env,
      stdio
    });
    let settled = false;
    let timedOut = false;
    let timeoutHandle = null;
    let killHandle = null;

    const clearTimers = () => {
      if (timeoutHandle !== null) clearTimeoutImplementation(timeoutHandle);
      if (killHandle !== null) clearTimeoutImplementation(killHandle);
    };
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimers();
      resolve(code);
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimers();
      reject(error);
    };

    child.once('error', (error) => {
      if (timedOut) {
        finish(timeoutExitCode);
        return;
      }
      fail(error);
    });
    child.once('close', (code, signal) => {
      finish(timedOut ? timeoutExitCode : (code ?? (signal ? 1 : 0)));
    });

    if (timeout > 0) {
      timeoutHandle = setTimeoutImplementation(() => {
        timedOut = true;
        try {
          child.kill?.('SIGTERM');
        } catch {
          // Continue to the bounded force-kill fallback.
        }
        if (settled) return;

        killHandle = setTimeoutImplementation(() => {
          try {
            child.kill?.('SIGKILL');
            child.unref?.();
          } finally {
            finish(timeoutExitCode);
          }
        }, killTimeout);
        killHandle?.unref?.();
      }, timeout);
      timeoutHandle?.unref?.();
    }
  });

  if (exitCode !== 0) {
    processLike.exitCode = exitCode;
  }

  return exitCode;
}

export function normalizeWrapperArgs(args, command) {
  if (command && Array.isArray(command.args) && command.args.length > 0) {
    return command.args;
  }
  if (Array.isArray(args)) {
    return args;
  }
  if (args === undefined || args === null) {
    return [];
  }
  return [args];
}

function normalizeTimeout(value, name) {
  if (value === undefined || value === null) return 0;
  const normalized = Number(value);
  if (!Number.isFinite(normalized) || normalized < 0) {
    throw new TypeError(`${name} must be a non-negative finite number.`);
  }
  return normalized;
}

function normalizeExitCode(value) {
  if (!Number.isInteger(value) || value < 1 || value > 255) {
    throw new TypeError('timeoutExitCode must be an integer between 1 and 255.');
  }
  return value;
}
