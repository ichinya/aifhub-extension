// Expand scripts/*.test.mjs in-process: cmd.exe (npm on Windows) does not expand
// shell globs, and node:test glob arguments require Node >= 21; CI runs 18.x and 20.19.x.
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = fileURLToPath(new URL('./', import.meta.url));
const files = readdirSync(directory).filter(name => name.endsWith('.test.mjs')).sort()
  .map(name => path.join(directory, name).replaceAll(path.sep, '/'));
const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit', windowsHide: true });
process.exitCode = result.status ?? 1;
