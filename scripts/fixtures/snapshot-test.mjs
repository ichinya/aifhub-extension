// Test-only dependency injection: production helpers have no observer/test hooks.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
export async function helperWithGit(name, implementation, exposeIdentity = false, transform = source => source) {
  const url = new URL(`../${name}`, import.meta.url);
  let source = await fs.readFile(url, 'utf8');
  source = source.replace(/(['"])(\.\/[^'"\n]+\.mjs)\1/g, (_, quote, relative) => `${quote}${new URL(relative, url).href}${quote}`);
  const key = `snapshot-test-${randomUUID()}`;
  globalThis[key] = implementation;
  source = source.replace('const exec = promisify(execFile);', `const exec = globalThis[${JSON.stringify(key)}];`);
  if (exposeIdentity) source += '\nexport { identity as testIdentity };\n';
  source = transform(source);
  try { return await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`); }
  finally { delete globalThis[key]; }
}
export async function fakeRepository(t, names = ['data/a.txt']) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'snapshot unit-')));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 3 }));
  await fs.mkdir(path.join(root, '.git')); await fs.writeFile(path.join(root, '.git/HEAD'), 'ref: refs/heads/main\n');
  for (const name of names) { await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true }); await fs.writeFile(path.join(root, name), 'initial\n'); }
  const calls = [], head = 'a'.repeat(40);
  const git = async (_command, args) => {
    calls.push(args);
    const text = args[0] === 'rev-parse' ? args.length === 2 && args[1] === '--git-common-dir' ? '.git\n' : `${root}\n${path.join(root, '.git')}\n.git\n${head}\nmain\n`
      : args.includes('--stage') ? names.map(n => `100644 ${'b'.repeat(40)} 0\t${n}\0`).join('') : names.join('\0')+'\0';
    return { stdout: Buffer.from(text) };
  };
  return { root, calls, git, head };
}
