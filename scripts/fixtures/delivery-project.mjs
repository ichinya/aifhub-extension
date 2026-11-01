// Test-only Git observation injection; actual execution validators/freshness/store stay intact.
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fakeRepository } from './snapshot-test.mjs';

export async function deliveryProject(t, { mode = 'openspec', plans = '.ai-factory/plans' } = {}) {
  const id = 'work', proposal = `openspec/changes/${id}/proposal.md`, tasks = `openspec/changes/${id}/tasks.md`;
  const f = await fakeRepository(t, ['src/a.js', 'src/b.js', 'outside.txt', '.gitignore', proposal, tasks]);
  const put = async (name, bytes) => { await mkdir(path.dirname(path.join(f.root, name)), { recursive: true }); await writeFile(path.join(f.root, name), bytes); };
  const get = name => readFile(path.join(f.root, name), 'utf8');
  await put('.gitignore', '.ai-factory/\n');
  const checklist = '- [ ] 1.1 First task\n- [ ] 1.2 Second task\n';
  if (mode === 'openspec') {
    await put('.ai-factory/config.yaml', 'aifhub:\n  tools:\n    openspec: true\n');
    await put(proposal, '# Proposal\n'); await put(tasks, checklist);
  } else {
    await put('.ai-factory/config.yaml', `aifhub:\n  artifactProtocol: ai-factory\npaths:\n  plans: ${plans}\n`);
    await put(`${plans}/${id}.md`, '# Plan\n\n' + checklist);
    for (const [name, text] of Object.entries({ 'task.md': checklist, 'context.md': '# Context\n', 'rules.md': '# Rules\n',
      'verify.md': '# Verify\n', 'status.yaml': `status: planned\nplan_id: ${id}\n` })) await put(`${plans}/${id}/${name}`, text);
  }
  const modules = {}, slot = `delivery-test-${randomUUID()}`;
  globalThis[slot] = {};
  t.after(() => { delete globalThis[slot]; });
  async function load(name, edit = source => source) {
    const url = new URL(`../${name}`, import.meta.url);
    let source = await readFile(url, 'utf8');
    source = source.replace(/(['"])(\.\/[^'"\n]+\.mjs)\1/g, (_, quote, relative) => `${quote}${modules[relative.slice(2)] ?? new URL(relative, url).href}${quote}`);
    source = edit(source) + `\n//# sourceURL=delivery-fixture-${name}\n`;
    const href = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
    modules[name] = href;
    return import(href);
  }
  // Obtain the same production snapshot implementation with injected Git observations.
  const storeUrl = new URL('../workflow-state-store.mjs', import.meta.url);
  let store = await readFile(storeUrl, 'utf8');
  const gitKey = `delivery-git-${randomUUID()}`; globalThis[gitKey] = f.git;
  t.after(() => { delete globalThis[gitKey]; });
  store = store.replace('const exec = promisify(execFile);', `const exec = globalThis[${JSON.stringify(gitKey)}];`);
  store += '\n//# sourceURL=delivery-fixture-workflow-state-store.mjs\n';
  modules['workflow-state-store.mjs'] = `data:text/javascript;base64,${Buffer.from(store).toString('base64')}`;
  await load('execution-task-source.mjs'); await load('execution-records.mjs'); await load('execution-transactions.mjs');
  const execution = await load('execution-state.mjs', source => source
    .replace(/import\((['"])[^'"\n]*\/host-delivery\.mjs\1\)/, `Promise.resolve(globalThis[${JSON.stringify(slot)}].delivery)`)
    .replace(/import\((['"])[^'"\n]*\/host-lifecycle\.mjs\1\)/, `Promise.resolve(globalThis[${JSON.stringify(slot)}].lifecycle)`));
  await load('host-delivery-store.mjs');
  globalThis[slot].delivery = await load('host-delivery.mjs');
  await load('host-lifecycle-store.mjs');
  globalThis[slot].lifecycle = await load('host-lifecycle.mjs');
  const call = (action, input, options = {}) => execution.executionCommand(action, input, { rootDir: f.root, ...options });
  return { root: f.root, id, plans, put, get, call, drive: (input, options = {}) => globalThis[slot].lifecycle.driveLifecycle(input, { rootDir: f.root, ...options }),
    start: (extra = {}) => ({ change_id: id, run_id: 'run-1', task_id: '1.1', owner: 'parent', worker: 'worker', role: 'implement', scope: ['src/a.js'], ...extra }),
    actor: (version = 1, extra = {}) => ({ change_id: id, run_id: 'run-1', actor: 'worker', version, ...extra }),
    cleanup: () => rm(f.root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }) };
}
