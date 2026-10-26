// Expand scripts/*.test.mjs in-process: cmd.exe (npm on Windows) does not expand
// shell globs, and node:test glob arguments require Node >= 21; CI runs 18.x and 20.19.x.
// Files that temporarily mutate shared repo helpers run serially before the parallel
// wave: concurrent readers hashing the same file would observe the mutation window.
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = fileURLToPath(new URL('./', import.meta.url));
const mutating = ['superpowers-skill-eval.test.mjs'];
const names = readdirSync(directory).filter(name => name.endsWith('.test.mjs')).sort();
let status = 0;
for (const name of names.filter(name => mutating.includes(name)))
  status |= spawnSync(process.execPath, ['--test', path.join(directory, name).replaceAll(path.sep, '/')], { stdio: 'inherit', windowsHide: true }).status ?? 1;
const files = names.filter(name => !mutating.includes(name))
  .map(name => path.join(directory, name).replaceAll(path.sep, '/'));
status |= spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit', windowsHide: true }).status ?? 1;
process.exitCode = status;
