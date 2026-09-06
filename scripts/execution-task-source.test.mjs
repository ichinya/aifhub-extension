import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { rm, link, symlink, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { executionProject } from './fixtures/execution-project.mjs';
import { parseExecutionTasks } from './execution-task-source.mjs';

const projects = [];
afterEach(async () => { for (const project of projects.splice(0)) await project.cleanup(); });
const project = async options => { const p = await executionProject(options); projects.push(p); return p; };

// Defect: a retained OpenSpec directory overrides a disabled tool and starts work.
test('disabled OpenSpec cannot be used as an execution source or create state', async () => {
  const p = await project();
  await p.put('.ai-factory/config.yaml', 'aifhub:\n  tools:\n    openspec: false\n');
  const before = await p.snapshot();
  await assert.rejects(p.call('start', p.start()), e => e.code === 'missing-classic-plan');
  assert.deepEqual(await p.snapshot(), before);
});

test('missing config uses complete classic tasks even when OpenSpec remains', async () => {
  const p = await project({ mode: 'classic' });
  await rm(path.join(p.root, '.ai-factory/config.yaml'));
  await p.put(`openspec/changes/${p.id}/tasks.md`, '- [ ] 9.9 Wrong source\n');
  const result = await p.call('start', p.start());
  assert.equal(result.source.kind, 'ai-factory-classic');
  assert.equal(result.source.checklist, '.ai-factory/plans/work/task.md');
});

test('duplicate consumed paths reject instead of selecting the last root', async () => {
  const p = await project({ mode: 'classic' });
  await p.put('.ai-factory/config.yaml', 'paths:\n  plans: ignored/plans\n  plans: .ai-factory/plans\n');
  const before = await p.snapshot();
  await assert.rejects(p.call('start', p.start()), e => e.code === 'tool-configuration-error');
  assert.deepEqual(await p.snapshot(), before);
});

test('classic-pair classification is insufficient when a companion is absent', async () => {
  const p = await project({ mode: 'classic' });
  await rm(path.join(p.root, p.plans, p.id, 'rules.md'));
  const before = await p.snapshot();
  await assert.rejects(p.call('start', p.start()), e => e.code === 'missing-classic-plan');
  assert.deepEqual(await p.snapshot(), before);
});

test('task grammar ignores frontmatter, comments and code but preserves nested tasks and inline titles', () => {
  const text = '\uFEFF---\r\n- [ ] 88 fake\r\n---\r\n# Tasks\r\n    - [ ] 77 example\r\n<!--\r\n- [ ] 66 hidden\r\n-->\r\n```md\r\n- [ ] 55 fenced\r\n```\r\n- [ ] Task 1: Use `x()`\r\n  - [x] 1.1 Child\r\n- [ ] Unnumbered\r\n';
  assert.deepEqual(parseExecutionTasks(text), [
    { id: '1', checked: false, title: 'Use `x()`' }, { id: '1.1', checked: true, title: 'Child' }, { id: 'task-3', checked: false, title: 'Unnumbered' },
  ]);
  for (const bad of ['- [ ] Task 01: Alias', '- [ ] 1.01 Alias', '- [ ] Task 1: One\n- [ ] 1 Two', '---\n- [ ] 1 Hidden']) assert.throws(() => parseExecutionTasks(bad));
  assert.deepEqual(parseExecutionTasks('```html\n<!--\n```\n- [ ] Task 2: Preserve `<!-- literal -->`\n'),[{id:'2',checked:false,title:'Preserve `<!-- literal -->`'}]);
});

test('long sequential source IDs and classic Task N remain exact', async () => {
  const p = await project({ mode: 'classic', id: '001_'+ 'a'.repeat(85) });
  for (const name of [`${p.plans}/${p.id}.md`, `${p.plans}/${p.id}/task.md`]) await p.put(name, '- [ ] Task 12: Exact title\n');
  const run = await p.call('start', p.start({ task_id: '12' }));
  assert.equal(run.change_id, p.id); assert.equal(run.task_id, '12');
});

test('classic title/progress disagreement is rejected before state', async () => {
  const p = await project({ mode: 'classic' });
  for (const content of ['- [ ] 1.1 Different title\n- [ ] 1.2 Second task\n', '- [x] 1.1 First task\n- [ ] 1.2 Second task\n']) {
    await p.put(`${p.plans}/${p.id}/task.md`, content); const before = await p.snapshot();
    await assert.rejects(p.call('start', p.start()), e => e.code === 'classic-checklist-mismatch');
    assert.deepEqual(await p.snapshot(), before);
  }
});

test('checked tasks need fix role and existing finding context', async () => {
  const p = await project(); await p.put('openspec/changes/work/tasks.md', '- [x] 1.1 First task\n');
  await assert.rejects(p.call('start', p.start()), e => e.code === 'task-already-completed');
  await assert.rejects(p.call('start', p.start({ role: 'fix', context_paths: ['missing.md'] })), e => e.code === 'missing-finding-context');
  await p.put('.ai-factory/qa/finding.md', 'Current finding\n');
  assert.equal((await p.call('start', p.start({ role: 'fix', context_paths: ['.ai-factory/qa/finding.md'] }))).role, 'fix');
});

test('custom tracked classic status projects only identity while all other inputs stay authoritative', async () => {
  const p = await project({ mode: 'classic', plans: 'planning' });
  const run = await p.call('start', p.start());
  await p.put('planning/work/status.yaml', 'plan_id: work\nstatus: implementing\ncurrent_task: 2\nupdated_at: tomorrow\nexecution:\n  mode: local\nhistory:\n  - event: progress\n');
  assert.equal((await p.call('resume', { change_id: p.id, run_id: run.run_id })).context_digest, run.context_digest);
  await p.put('planning/work/rules.md', '# Changed policy\n');
  await assert.rejects(p.call('resume', { change_id: p.id, run_id: run.run_id }), e => e.code === 'stale-context');
});

test('new missing authoritative roots and explicit inputs invalidate context', async () => {
  const p = await project(); await p.call('start', p.start({ context_paths: ['ignored/input.txt'] }));
  await p.put('ignored/input.txt', 'new input\n');
  await assert.rejects(p.call('resume', { change_id: p.id, run_id: 'run-1' }), e => e.code === 'stale-context');
});

test('consumed malformed config and protected/custom/runtime paths cannot start', async () => {
  const p = await project({ mode: 'classic', plans: 'planning' });
  const config = await p.get('.ai-factory/config.yaml');
  for (const bad of ['aifhub:\n  tools:\n    openspec: yes\n', config+'paths:\n  plans: planning\n', 'paths:\n  plans: ../escape\n']) {
    await p.put('.ai-factory/config.yaml', bad); const before = await p.snapshot();
    await assert.rejects(p.call('start', p.start())); assert.deepEqual(await p.snapshot(), before);
  }
  await p.put('.ai-factory/config.yaml', config);
  for (const extra of [{scope:['planning/work/task.md']},{scope:['src/../outside.txt']},{scope:['CON']},{context_paths:['.ai-factory/state/other/execution/runs/x.json']}]) {
    const before = await p.snapshot(); await assert.rejects(p.call('start',p.start(extra))); assert.deepEqual(await p.snapshot(),before);
  }
  await link(path.join(p.root,'src/a.js'),path.join(p.root,'src/hard.js'));
  await assert.rejects(p.call('start',p.start({scope:['src/hard.js']})),e=>e.code==='unsafe-filesystem-entry');
});

test('marked ultra delegates both roles before state; collision and malformed marker fail closed', async () => {
  const p = await project({ mode: 'classic' });
  await rm(path.join(p.root, p.plans, p.id+'.md'));
  await rm(path.join(p.root, p.plans, p.id), { recursive: true });
  const index = '<!-- aif:plan-mode:ultra -->\n\n# Plan\n\n## Phase Index\n\n1. [Phase 01](phase-01-work.md)\n\n## Tasks\n\n- [ ] **Task 1:** Work.\n';
  await p.put(`${p.plans}/${p.id}/index.md`,index);
  await p.put(`${p.plans}/${p.id}/phase-01-work.md`,'# Phase 01\n\n## Task 1: Work\n\nDetail.\n');
  const before = await p.snapshot();
  for (const role of ['implement','fix']) assert.deepEqual(await p.call('start',p.start({role})), { delegated:true, handoff:`/aif-${role} ${p.plans}/${p.id}/index.md` });
  assert.deepEqual(await p.snapshot(),before);
  await p.put(`${p.plans}/${p.id}.md`, '# Collision');
  await assert.rejects(p.call('start',p.start()), e=>e.code==='plan-integrity-error');
  await rm(path.join(p.root,p.plans,p.id+'.md'));
  await p.put(`${p.plans}/${p.id}/index.md`,index.replace('<!-- aif:plan-mode:ultra -->',''));
  await assert.rejects(p.call('start',p.start()),e=>e.code==='plan-integrity-error');
});

test('explicit tools override legacy protocol and paths without enabling unrelated providers', async () => {
  const p=await project({mode:'classic'});
  await p.put('.ai-factory/config.yaml','aifhub:\n  artifactProtocol: openspec\n  tools:\n    hlv: true\n    lekalo: true\npaths:\n  plans: dormant/plans\n');
  const started=await p.call('start',p.start());assert.equal(started.source.kind,'ai-factory-classic');assert.equal(started.source.entrypoint,'.ai-factory/plans/work.md');
});

test('source race under admission lock publishes no run, namespace, ledger or journal',async()=>{
  const p=await project();
  await assert.rejects(p.call('start',p.start(),{beforeLock:()=>p.put('openspec/changes/work/tasks.md','- [ ] 1.1 Changed policy\n')}),e=>e.code==='stale-admission');
  const state=await p.snapshot();assert.equal(Object.keys(state).filter(k=>k.startsWith('.ai-factory/state/')&&!k.endsWith('/')).length,0);
});

test('symlink/junction sources are rejected before any execution state',async()=>{
  const p=await project({mode:'classic'});await mkdir(path.join(p.root,'linked'));
  await rm(path.join(p.root,p.plans,p.id),{recursive:true});
  await symlink(path.join(p.root,'linked'),path.join(p.root,p.plans,p.id),process.platform==='win32'?'junction':'dir');
  await assert.rejects(p.call('start',p.start()),e=>e.code==='unsafe-filesystem-entry');
});

test('classic source binding preserves branch none and rejects contradictory YAML identity',async()=>{
  const p=await project({mode:'classic',id:'148-work'});const parent=`${p.plans}/${p.id}.md`,status=`${p.plans}/${p.id}/status.yaml`;
  await p.put(parent,(await p.get(parent))+'\n## AIFHub Source Binding\n\n- Provider: github\n- Primary source: https://github.com/example/repo/issues/148\n- External ID: 148\n- Branch: none\n');
  const yaml='plan_id: 148-work\nsource_binding:\n  provider: "github"\n  primary_source: "https://github.com/example/repo/issues/148"\n  external_id: "148"\n  branch: "none"\n';await p.put(status,yaml);
  const run=await p.call('start',p.start());assert.equal(run.source.binding.branch,null);assert.equal(run.source.binding.externalId,'148');
  await p.put(status,yaml.replace('issues/148','issues/149'));
  await assert.rejects(p.call('resume',{change_id:p.id,run_id:'run-1'}),e=>e.code==='invalid-source-binding');
});

test('unconsumed config values remain opaque to the execution source adapter',async()=>{
  const p=await project({mode:'classic'});
  await p.put('.ai-factory/config.yaml','paths:\n  plans: .ai-factory/plans\n  "unrelated": {opaque: true}\n  another:\n    nested: arbitrary\ncustom:\n  notes: preserve\n');
  assert.equal((await p.call('start',p.start())).source.kind,'ai-factory-classic');
});

// Defect: a configured canonical context file is bound as input but assigned for
// writing. The independent expectation is protected-scope before any state write.
for(const mode of ['classic','openspec'])for(const key of ['description','architecture','generated_rules'])
test(`configured context protection covers ${key} in ${mode} single and batch admission`,async()=>{
  const p=await project({mode}),file=`governance/${key}.md`,preflight='.ai-factory/state/work/implementation/preflight.md';
  const config=await p.get('.ai-factory/config.yaml');
  await p.put('.ai-factory/config.yaml',config+(mode==='openspec'?'paths:\n':'')+`  ${key}: ${file}\n`);
  await p.put(file,'Canonical context');await p.put(preflight,'Independent fixture tasks');
  const reject=async scope=>{
    const single=p.start({scope:[scope]});
    const batch={change_id:p.id,run_id:'batch',owner:'parent',worker:'worker',role:'implement',preflight_paths:[preflight],manifest:[
      {task_id:'1.1',files:[scope],expected_change:'First task',check:'fixture-check',dependencies:[]},
      {task_id:'1.2',files:['src/b.js'],expected_change:'Second task',check:'fixture-check',dependencies:[]}]};
    for(const [action,input]of [['start',single],['batch-start',batch]]){
      const before=await p.snapshot();await assert.rejects(p.call(action,input),e=>e.code==='protected-scope');assert.deepEqual(await p.snapshot(),before);
    }
  };
  await reject(file);await reject(file.toUpperCase());await reject('governance');
  await rm(path.join(p.root,file));await reject(file);
  const permitted=await p.call('start',p.start({scope:[file+'.notes']}));assert.equal(permitted.lifecycle,'active');
});

test('configured context protection covers children of a declared generated-rules directory',async()=>{
  const p=await project({mode:'classic'});
  await p.put('.ai-factory/config.yaml',await p.get('.ai-factory/config.yaml')+'  generated_rules: governance/generated\n');
  await p.put('governance/generated/item.md','Canonical generated rules');
  const before=await p.snapshot();
  await assert.rejects(p.call('start',p.start({scope:['governance/generated/item.md']})),e=>e.code==='protected-scope');
  assert.deepEqual(await p.snapshot(),before);
});
