// Bounded process transport shared by runtime adapters and opt-in smoke drivers.
import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import path from 'node:path';

export class ProcessTransportError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const fail = code => { throw new ProcessTransportError(code); };
const token = value => { if (typeof value !== 'string' || !value || /[\x00\r\n]/.test(value)) fail('invalid-toolchain-token'); };
const ENVIRONMENT_KEYS = ['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR', 'HOME',
  'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'CI', 'NO_COLOR',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
  'npm_config_registry', 'npm_config_strict_ssl'];
export const processEnvironment = environment => Object.fromEntries(Object.entries(environment)
  .filter(([key, value]) => ENVIRONMENT_KEYS.includes(key.toUpperCase()) && typeof value === 'string'));
function quoteWindowsCmdToken(value) {
  token(value);
  if (/["%!]/.test(value)) fail('unsafe-windows-command-token');
  let result = '"', backslashes = 0;
  for (const character of value) {
    if (character === '\\') { backslashes++; continue; }
    result += '\\'.repeat(backslashes) + character; backslashes = 0;
  }
  return result + '\\'.repeat(backslashes * 2) + '"';
}
export function buildNoShellInvocation({ command, args = [], platform = process.platform, comSpec = process.env.ComSpec }) {
  token(command);
  if (!Array.isArray(args)) fail('invalid-toolchain-token');
  args.forEach(token);
  if (platform === 'win32' && ['.cmd', '.bat'].includes(path.extname(command).toLowerCase())) {
    if (!comSpec || !path.win32.isAbsolute(comSpec)) fail('missing-comspec');
    token(comSpec);
    const commandLine = [command, ...args].map(quoteWindowsCmdToken).join(' ');
    return { command: comSpec, args: ['/d', '/v:off', '/s', '/c', `"${commandLine}"`], adapter: 'windows-comspec', options: { shell: false } };
  }
  return { command, args: [...args], adapter: 'direct-exec-file', options: { shell: false } };
}
export function createNoShellProcessRunner({ execFileImpl = execFile, platform = process.platform,
  comSpec = process.env.ComSpec, environment = process.env } = {}) {
  const run = async ({ command, args = [], cwd, timeoutMs = 120000, stdin = null, maxBuffer = 1024 * 1024, onChild }) => {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000) fail('invalid-timeout');
    if (!Number.isSafeInteger(maxBuffer) || maxBuffer < 1 || maxBuffer > 16 * 1024 * 1024) fail('invalid-max-buffer');
    if (stdin !== null && (!Buffer.isBuffer(stdin) || stdin.length > 1024 * 1024)) fail('input-too-large');
    const invocation = buildNoShellInvocation({ command, args, platform, comSpec });
    return new Promise(resolve => {
      let inputError = null;
      const complete = (error, stdout = Buffer.alloc(0), stderr = Buffer.alloc(0)) => {
        const stdoutBytes = Buffer.from(stdout ?? ''), stderrBytes = Buffer.from(stderr ?? '');
        let out = '', err = '', decodeError = null;
        try { out = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(stdoutBytes);
          err = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(stderrBytes); }
        catch { decodeError = 'invalid-utf8'; }
        const processCode = inputError ?? (typeof error?.code === 'string' ? error.code : null) ?? decodeError;
        resolve({ exitCode: error ? (typeof error.code === 'number' ? error.code : null) : processCode ? null : 0,
          processCode, signal: error?.signal ?? null, timedOut: Boolean(error?.killed && error?.signal) || error?.code === 'ETIMEDOUT',
          stdoutBytes, stderrBytes, stdout: out, stderr: err, adapter: invocation.adapter, shell: false, timeoutMs,
          stdoutTruncated: error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', stderrTruncated: error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' });
      };
      let child;
      try { child = execFileImpl(invocation.command, invocation.args, { cwd, env: processEnvironment(environment), encoding: 'buffer',
        maxBuffer, timeout: timeoutMs, windowsHide: true, shell: false,
        ...(invocation.adapter === 'windows-comspec' ? { windowsVerbatimArguments: true } : {}) }, complete); }
      catch (error) { complete(error); return; }
      onChild?.(child);
      if (child?.stdin) {
        child.stdin.on('error', error => { inputError = error.code ?? 'stdin-error'; });
        child.stdin.end(stdin ?? undefined);
      }
    });
  };
  run.preflight = async ({ command, args = [] }) => {
    const invocation = buildNoShellInvocation({ command, args, platform, comSpec });
    if (invocation.adapter === 'windows-comspec' && !await stat(invocation.command).then(s => s.isFile()).catch(() => false)) fail('missing-comspec');
    return { adapter: invocation.adapter, shell: false };
  };
  return run;
}
