// Keep generated runtime contents local while sharing the ignore rule with Git.
import { lstat, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { safeProviderPath } from './provider-files.mjs';

export const RUNTIME_GITIGNORE = '*\n!.gitignore\n';

export async function ensureRuntimeGitignore(rootDir, directory, options = {}) {
  if (typeof directory !== 'string' || !directory) throw new Error('unsafe_runtime_directory');
  const root = path.resolve(rootDir);
  const relative = path.relative(root, path.resolve(root, directory)).replaceAll('\\', '/');
  // An ignore-all rule must never hide the project or canonical artifact roots.
  const protectedRoots = ['.git', 'openspec', '.ai-factory/plans', '.ai-factory/specs', '.ai-factory/archive'];
  if (!relative || relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)
    || ['.ai-factory', '.ai-factory/rules'].includes(relative.toLowerCase())
    || protectedRoots.some((entry) => relative.toLowerCase() === entry || relative.toLowerCase().startsWith(`${entry}/`))) {
    throw new Error('unsafe_runtime_directory');
  }
  const target = `${relative}/.gitignore`;
  let checked = await safeProviderPath(root, target);
  if (checked.exists) {
    if (!(await lstat(checked.path)).isFile()) throw new Error('unsafe_runtime_gitignore');
    return { action: 'preserve', target };
  }
  if (options.dryRun) return { action: 'would-create', target };
  await mkdir(path.dirname(checked.path), { recursive: true });
  checked = await safeProviderPath(root, target);
  try {
    await writeFile(checked.path, RUNTIME_GITIGNORE, { encoding: 'utf8', flag: 'wx' });
    return { action: 'create', target };
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    // A concurrent creator owns the file. Validate it without replacing its rules.
    return ensureRuntimeGitignore(root, relative, { dryRun: true });
  }
}

export async function ensureRuntimeGitignores(rootDir, directories, options = {}) {
  const unique = [...new Set(directories)];
  // Reject unsafe later destinations before creating any earlier directory.
  const preview = [];
  for (const directory of unique) preview.push(await ensureRuntimeGitignore(rootDir, directory, { dryRun: true }));
  if (options.dryRun) return preview;
  const operations = [];
  for (const directory of unique) operations.push(await ensureRuntimeGitignore(rootDir, directory));
  return operations;
}
