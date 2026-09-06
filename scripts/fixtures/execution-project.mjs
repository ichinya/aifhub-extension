import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { executionCommand } from '../execution-state.mjs';

const exec = promisify(execFile);
export async function executionProject({ mode = 'openspec', id = 'work', plans = '.ai-factory/plans' } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aifhub-execution-'));
  const put = async (name, text) => { await mkdir(path.dirname(path.join(root, name)), { recursive: true }); await writeFile(path.join(root, name), text); };
  const get = name => readFile(path.join(root, name), 'utf8');
  const git = (...args) => exec('git', args, { cwd: root, windowsHide: true });
  const tasks = '- [ ] 1.1 First task\n- [ ] 1.2 Second task\n';
  await put('.gitignore', '.ai-factory/\nignored/\n');
  await put('src/a.js', 'initial a\n'); await put('src/b.js', 'initial b\n'); await put('outside.txt', 'preserve\n');
  if (mode === 'openspec') {
    await put('.ai-factory/config.yaml', 'aifhub:\n  tools:\n    openspec: true\n');
    await put(`openspec/changes/${id}/proposal.md`, '# Proposal\n');
    await put(`openspec/changes/${id}/tasks.md`, tasks);
  } else {
    await put('.ai-factory/config.yaml', `aifhub:\n  artifactProtocol: ai-factory\npaths:\n  plans: ${plans}\n`);
    await put(`${plans}/${id}.md`, '# Plan\n\n'+tasks);
    for (const [name, text] of Object.entries({ 'task.md': tasks, 'context.md': '# Context\n', 'rules.md': '# Rules\n', 'verify.md': '# Verify\n', 'status.yaml': `status: planned\nplan_id: ${id}\n` })) await put(`${plans}/${id}/${name}`, text);
  }
  await git('init', '-q'); await git('add', '.');
  await git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture');
  const call = (action, input, options = {}) => executionCommand(action, input, { rootDir: root, ...options });
  const start = (extra = {}) => ({ change_id: id, run_id: 'run-1', task_id: '1.1', owner: 'parent', worker: 'worker', role: 'implement', scope: ['src/a.js'], ...extra });
  const actor = (version = 1, extra = {}) => ({ change_id: id, run_id: 'run-1', actor: 'worker', version, ...extra });
  const snapshot = async () => {
    const all = {};
    async function walk(dir = '') { for (const e of await readdir(path.join(root, dir), { withFileTypes: true })) {
      if (e.name === '.git') continue;
      const name = dir ? `${dir}/${e.name}` : e.name;
      if (e.isDirectory()) { all[name+'/'] = ''; await walk(name); } else all[name] = (await readFile(path.join(root,name))).toString('base64');
    } }
    await walk(); return all;
  };
  return { root, id, plans, put, get, git, call, start, actor, snapshot, cleanup: () => rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }) };
}
