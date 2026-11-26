// A Git process can take longer to start on a busy Windows host. Keep every
// read bounded and let each guard interpret Git's actual exit status.
const timeout = process.platform === 'win32' ? 30_000 : 10_000;

export async function runGuardGit(execGit, args, options) {
  const debug = process.env.LOG_LEVEL === 'debug';
  const start = debug ? performance.now() : 0;
  try {
    return await execGit('git', args, { ...options, windowsHide: true, timeout });
  } catch (error) {
    if (debug) {
      console.error('[FIX:186] Git guard exit', {
        command: args[0], elapsedMs: Math.round(performance.now() - start),
        timeoutMs: timeout, code: error?.code, signal: error?.signal, killed: error?.killed,
      });
    }
    throw error;
  }
}
