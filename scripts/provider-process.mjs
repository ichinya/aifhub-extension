// Bounded process boundary. Raw streams are ephemeral and must never be persisted.
import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import path from 'node:path';

async function installedExecutable(executable, cwd, env) {
  if (path.isAbsolute(executable)) return executable;
  if (!/^[a-zA-Z0-9_.-]+$/.test(executable)) return null;
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path');
  for (const directory of String(env[pathKey] ?? '').split(path.delimiter)) {
    if (!path.isAbsolute(directory)) continue;
    const relative = path.relative(path.resolve(cwd ?? process.cwd()), path.resolve(directory));
    if (!relative || !relative.startsWith('..') && !path.isAbsolute(relative)) continue;
    const candidate = path.join(directory, process.platform === 'win32' && !/\.exe$/i.test(executable) ? `${executable}.exe` : executable);
    try { await access(candidate); return candidate; } catch { /* Continue through the explicit PATH. */ }
  }
  return null;
}

export async function runProviderProcess(executable, args, options = {}) {
  const { cwd, signal, timeoutMs = 30000, maxOutputBytes = 1024 * 1024 } = options;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000
    || !Number.isInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > 4 * 1024 * 1024) {
    return { outcome: 'configuration_error', exitCode: null, stdout: '', stderr: '' };
  }
  if (signal?.aborted) return { outcome: 'cancelled', exitCode: null, stdout: '', stderr: '' };
  const resolved = await installedExecutable(executable, cwd, options.env ?? process.env);
  if (resolved === null) return { outcome: 'unavailable', exitCode: null, stdout: '', stderr: '' };
  return new Promise((resolve) => {
    let child;
    let finished = false;
    let failure = null;
    let bytes = 0;
    let timer;
    let reapTimer;
    let killer;
    let killerTimer;
    const stdout = [];
    const stderr = [];
    const finish = (exitCode) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearTimeout(reapTimer);
      signal?.removeEventListener('abort', cancel);
      child?.stdout?.destroy();
      child?.stderr?.destroy();
      resolve({ outcome: failure ?? 'completed', exitCode,
        stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') });
    };
    const stop = (reason) => {
      if (failure || finished) return;
      failure = reason;
      if (child?.pid) {
        if (process.platform === 'win32') {
          killer = spawn(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'],
            { shell: false, windowsHide: true, stdio: 'ignore' });
          killer.on('error', () => child.kill('SIGKILL'));
          // Keep the tree terminator alive until completion. In particular, do
          // not resolve/dispose the process boundary while Windows is still
          // enumerating descendants.
          killer.on('close', (code) => {
            clearTimeout(killerTimer);
            if (code !== 0) child.kill('SIGKILL');
          });
          killerTimer = setTimeout(() => { killer.kill('SIGKILL'); child.kill('SIGKILL'); }, 5000);
        } else {
          try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
        }
      }
      reapTimer = setTimeout(() => {
        child.kill('SIGKILL');
        child.unref();
        finish(null);
      }, 6000);
    };
    const cancel = () => stop('cancelled');
    try {
      child = spawn(resolved, args, { cwd, env: options.env ?? process.env,
        shell: false, windowsHide: true, detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      failure = 'spawn_error';
      finish(null);
      return;
    }
    for (const [stream, chunks] of [[child.stdout, stdout], [child.stderr, stderr]]) {
      stream.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > maxOutputBytes) stop('output_limit');
        else if (!failure) chunks.push(chunk);
      });
    }
    child.on('error', (error) => {
      failure ??= error.code === 'ENOENT' ? 'unavailable' : 'spawn_error';
      finish(null);
    });
    child.on('close', (code, killedSignal) => {
      if (killedSignal) failure ??= 'signal';
      finish(code);
    });
    timer = setTimeout(() => stop('timeout'), timeoutMs);
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
  });
}
