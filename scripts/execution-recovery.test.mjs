import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { executionProject } from './fixtures/execution-project.mjs';
import { writeLegacyExecution } from './fixtures/execution-v1.mjs';
import { digest, storeFor } from './workflow-state-store.mjs';
const projects=[];afterEach(async()=>{for(const p of projects.splice(0))await p.cleanup();});
const project=async()=>{const p=await executionProject();projects.push(p);return p;};
const trace='.ai-factory/state/work/implementation/stop.md';
const inspect=p=>p.call('inspect',{change_id:p.id,run_id:'run-1'});
const interrupt=(p,extra={})=>p.actor(1,{actor:'parent',recovery_id:'recovery-1',reason:'timed_out',execution_state:'unknown',...extra});
const hypothesis=(p,extra={})=>p.actor(1,{finding_id:'QA-1',hypothesis:'Boundary check',check:'focused-check',environment_revision:'fixture-1',input_paths:[],...extra});
const begin=(p,extra={})=>p.call('attempt-begin',hypothesis(p,extra));
const folder='.ai-factory/state/work/execution';
async function persisted(p,name) {return JSON.parse(await p.get(`${folder}/${name}`)).record;}
async function deadline(promise) {let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('owned child deadline')),30000);})]);}finally{clearTimeout(timer);}}
async function retire(p,run='run-1',version=1) {await p.put(trace,'Observed worker exit.');return p.call('interrupt',interrupt(p,{run_id:run,version,execution_state:'stopped',evidence:[trace]}));}

test('inspect is exact, bounded and read-only even with missing config; nested corruption cannot hide behind a checksum',async()=>{
  const p=await project();const absent=await p.snapshot();await p.call('inspect',{change_id:p.id});assert.deepEqual(await p.snapshot(),absent);
  await p.call('start',p.start({role:'fix'}));await begin(p);await rm(path.join(p.root,'.ai-factory/config.yaml'));
  const before=await p.snapshot(),saved=await inspect(p);assert.equal(saved.version,1);assert.equal(saved.pending_attempts.length,1);assert.equal(saved.historical,true);assert.equal(saved.resumable,undefined);assert.equal(saved.progress,undefined);assert.deepEqual(await p.snapshot(),before);
  const store=await storeFor(p.root),run=await persisted(p,'runs/run-1.json');run.checkpoint.worktree.files['../escape']=digest('hostile');await store.save(`${folder}/runs/run-1.json`,run);
  const corrupt=await p.snapshot();await assert.rejects(inspect(p));assert.deepEqual(await p.snapshot(),corrupt);
});
test('owner retires drifted pending work, preserves snapshots and blocks late worker mutations',async()=>{
  const p=await project();await p.put('ignored/input.txt','one');await p.call('start',p.start({role:'fix',context_paths:['ignored/input.txt']}));
  const a=await begin(p,{input_paths:['ignored/input.txt']});const before=await persisted(p,'runs/run-1.json');
  await p.put('src/a.js','changed');await p.put('ignored/input.txt','two');await p.put('.ai-factory/config.yaml','aifhub:\n  tools:\n    openspec: invalid\n');await p.git('add','src/a.js');
  const input=interrupt(p);const recovered=await p.call('interrupt',input);assert.equal(recovered.lifecycle,'interrupted');
  const run=await persisted(p,'runs/run-1.json');assert.deepEqual(run.initial_worktree,before.initial_worktree);assert.deepEqual(run.context,before.context);assert.deepEqual(run.checkpoint,before.checkpoint);assert.deepEqual(run.recovery.pending_attempts,[a.attempt_id]);assert.ok(run.recovery.drift.includes('source-unavailable'));
  assert.equal((await persisted(p,'fix-attempts.json')).attempts[0].outcome,'interrupted');
  assert.equal((await p.call('interrupt',input)).version,2);
  for(const [action,payload]of [['checkpoint',{progress:{completed_steps:[],next_step:'Late'}}],['result',{result:{result_id:'late',status:'failed',changed_files:[],checks:[],evidence:[]}}],['attempt-finish',{attempt_id:a.attempt_id,outcome:'passed',evidence:[trace]}]])await assert.rejects(p.call(action,p.actor(2,payload)),e=>e.code==='run-interrupted');
  await assert.rejects(p.call('interrupt',{...input,reason:'cancelled'}),e=>e.code==='conflicting-replay');
});
test('wrong actor/version/recovery payload do not change history',async()=>{
  const p=await project();await p.call('start',p.start());const before=await p.snapshot();
  for(const extra of [{actor:'worker'},{version:9},{reason:'success'},{execution_state:'stopped'},{evidence:['.ai-factory/state/other/execution/runs/x.json']},{pending_attempts:[]}])await assert.rejects(p.call('interrupt',interrupt(p,extra)));
  assert.deepEqual(await p.snapshot(),before);
});
test('completed unaccepted payload survives retirement; accepted single is final',async()=>{
  const p=await project();await p.call('start',p.start());await p.put(trace,'check');
  const result={result_id:'r',status:'completed',changed_files:[],checks:[{name:'check',exit_code:0}],evidence:[trace]};
  const r=await p.call('result',p.actor(1,{result}));await p.put('src/a.js','drift');await retire(p,'run-1',2);
  assert.deepEqual((await persisted(p,'runs/run-1.json')).result,JSON.parse(JSON.stringify(r.result)));
  await assert.rejects(p.call('accept',p.actor(3,{actor:'parent',result_digest:r.result_digest})),e=>e.code==='run-interrupted');
  await p.call('start',p.start({run_id:'accepted'}));const next=await p.call('result',p.actor(1,{run_id:'accepted',result}));
  await p.call('accept',p.actor(2,{run_id:'accepted',actor:'parent',result_digest:next.result_digest}));
  await assert.rejects(p.call('interrupt',interrupt(p,{run_id:'accepted',version:3})),e=>e.code==='run-terminal');
});
for(const point of ['before-journal','after-journal','before-write-0','after-write-0','before-write-1','after-write-1','before-applied','after-applied'])test(`recovery publication replay converges at ${point}`,async()=>{
  const p=await project();await p.call('start',p.start({role:'fix'}));const a=await begin(p);await p.put(trace,'Observed exit');
  const input=interrupt(p,{execution_state:'stopped',evidence:[trace]});let hit=false;
  await assert.rejects(p.call('interrupt',input,{failpoint:stage=>{if(stage===point){hit=true;throw new Error('injected');}}}));assert.equal(hit,true);
  if(!['before-journal','after-applied'].includes(point))await assert.rejects(p.call('start',p.start({run_id:'replacement'})),e=>e.code==='pending-transaction');
  const result=await p.call('interrupt',input);assert.equal(result.version,2);await p.call('interrupt',input);
  const ledger=await persisted(p,'fix-attempts.json');assert.equal(ledger.attempts.length,1);assert.equal(ledger.attempts[0].outcome,'interrupted');assert.equal(ledger.attempts[0].attempt_id,a.attempt_id);
  await p.call('start',p.start({run_id:'replacement',role:'fix'}));
  await assert.rejects(begin(p,{run_id:'replacement'}),e=>e.code==='no-progress');
});
test('only one v2 attempt can remain pending; attempt-check does not authorize future edits',async()=>{
  const p=await project();await p.call('start',p.start({role:'fix'}));await begin(p);
  const check=await p.call('attempt-check',hypothesis(p));assert.equal(check.pending_attempt,true);assert.equal(check.ready_for_hypothesis,false);assert.equal(check.post_edit_fingerprint_checked,false);
  await p.put('src/a.js','another edit');await assert.rejects(begin(p),e=>e.code==='pending-attempt');
});
test('interruption allowance persists across three new run IDs without consuming failed counts',async()=>{
  const p=await project();
  for(let i=0;i<3;i++){
    const run=`round-${i}`;await p.call('start',p.start({role:'fix',run_id:run}));await p.put('src/a.js',`experiment ${i}`);await begin(p,{run_id:run});await retire(p,run);
  }
  await p.call('start',p.start({role:'fix',run_id:'fourth'}));await p.put('src/a.js','fourth');
  await assert.rejects(begin(p,{run_id:'fourth'}),e=>e.code==='interruption-budget-exhausted');
  const ledger=await persisted(p,'fix-attempts.json');assert.equal(ledger.attempts.filter(a=>a.outcome==='failed').length,0);assert.equal(ledger.attempts.filter(a=>a.outcome==='interrupted').length,3);
});
test('unknown stop reserves scope until owner confirms observed stop, with historical replay',async()=>{
  const p=await project();await p.call('start',p.start());await p.call('interrupt',interrupt(p));
  await assert.rejects(p.call('start',p.start({run_id:'replacement',scope:['src']})),e=>e.code==='scope-reserved');
  await p.put(trace,'Observed stop');const input=p.actor(2,{actor:'parent',recovery_id:'recovery-1',confirmation_id:'stop-1',evidence:[trace]});
  for(const extra of [{actor:'worker'},{version:1},{recovery_id:'wrong'},{evidence:[]}])await assert.rejects(p.call('stop-confirm',{...input,...extra}));
  const stopped=await p.call('stop-confirm',input);assert.equal(stopped.execution_state,'stopped');await p.put(trace,'later');assert.equal((await p.call('stop-confirm',input)).historical,true);
  await p.call('start',p.start({run_id:'replacement'}));await assert.rejects(p.call('stop-confirm',{...input,confirmation_id:'different'}),e=>e.code==='conflicting-replay');
});
test('test-owned child has an IPC readiness and observed-exit barrier before replacement',async()=>{
  const p=await project();await p.call('start',p.start());
  const child=spawn(process.execPath,['-e',"process.on('message',m=>{if(m==='stop')process.exit(0)});process.send('ready')"],{stdio:['ignore','ignore','ignore','ipc'],windowsHide:true});
  const exit=once(child,'exit');
  try {
    const [ready]=await deadline(once(child,'message'));assert.equal(ready,'ready');
    await p.call('interrupt',interrupt(p));await assert.rejects(p.call('start',p.start({run_id:'replacement'})),e=>e.code==='scope-reserved');
    child.send('stop');const [code]=await deadline(exit);assert.equal(code,0);
    await p.put(trace,'Test-owned child exit event observed with code 0; no host adapter claim.');
    await p.call('stop-confirm',p.actor(2,{actor:'parent',recovery_id:'recovery-1',confirmation_id:'child-stop',evidence:[trace]}));
    await p.call('start',p.start({run_id:'replacement'}));
  }finally{if(child.exitCode===null && child.signalCode===null){child.kill();await deadline(exit);}}
});
test('orphan project and per-change locks are never reclaimed',async()=>{
  const p=await project();await p.call('start',p.start());
  for(const lock of ['.ai-factory/state/execution-write.lock',`${folder}/write.lock`]){
    await p.put(lock,'{"pid":999999,"created_at":"2000-01-01"}');const before=await p.get(lock);
    await assert.rejects(p.call('interrupt',interrupt(p)),e=>e.code==='state-locked');assert.equal(await p.get(lock),before);await rm(path.join(p.root,lock));
  }
});
test('explicit v1 upgrade preserves exact predecessor envelopes, ordinal aliases and three failed hypotheses',async()=>{
  const p=await project();await p.put('openspec/changes/work/tasks.md','- [ ] Task 12: Work\n');const legacy=await writeLegacyExecution(p,{failures:3,task:'task-1'});
  const before=await p.snapshot();await p.call('inspect',{change_id:p.id,run_id:'legacy'});assert.deepEqual(await p.snapshot(),before);
  await assert.rejects(p.call('start',p.start({task_id:'12'})),e=>e.code==='upgrade-required');
  let inventory=await p.call('inspect',{change_id:p.id});
  await assert.rejects(p.call('upgrade',{change_id:p.id,actor:'parent',upgrade_id:'up',predecessor_inventory_digest:inventory.predecessor_inventory_digest}),e=>e.code==='predecessor-not-quiescent');
  await retire(p,'legacy');inventory=await p.call('inspect',{change_id:p.id});const input={change_id:p.id,actor:'parent',upgrade_id:'up',predecessor_inventory_digest:inventory.predecessor_inventory_digest};
  await p.call('upgrade',input);assert.equal((await p.call('upgrade',input)).replay,true);
  const ledger=await persisted(p,'fix-attempts.json');assert.equal(ledger.schema,'aifhub.fix-attempts.v2');assert.equal(ledger.attempts.length,3);assert.equal(ledger.aliases[0].task_id,'12');assert.equal(ledger.aliases[0].old_task_id,'task-1');
  const journals=[];for(const file of await readdir(path.join(p.root,folder,'transactions')))journals.push(await persisted(p,'transactions/'+file));
  assert.ok(journals.some(j=>j.writes.some(w=>w.before===legacy.runBytes)));assert.ok(journals.some(j=>j.writes.some(w=>w.before===legacy.ledgerBytes)));
  await p.call('start',p.start({role:'fix',task_id:'12'}));await assert.rejects(begin(p),e=>e.code==='attempt-budget-exhausted');
});
test('v1 recovery reconciles every pending entry; ambiguous task snapshots and changed predecessor inventory block upgrade',async()=>{
  const p=await project();await writeLegacyExecution(p,{pending:2});await retire(p,'legacy');
  const ledger=await persisted(p,'fix-attempts.json');assert.deepEqual(ledger.attempts.map(a=>a.outcome),['interrupted','interrupted']);
  const inventory=await p.call('inspect',{change_id:p.id}),input={change_id:p.id,actor:'parent',upgrade_id:'up',predecessor_inventory_digest:inventory.predecessor_inventory_digest};
  const store=await storeFor(p.root),run=await persisted(p,'runs/legacy.json');run.updated_at=new Date(Date.now()+1000).toISOString();await store.save(`${folder}/runs/legacy.json`,run);
  await assert.rejects(p.call('upgrade',input),e=>e.code==='predecessor-inventory-conflict');
  const fresh=await p.call('inspect',{change_id:p.id});await p.put('openspec/changes/work/tasks.md','- [ ] 1.1 Altered task\n');
  await assert.rejects(p.call('upgrade',{...input,predecessor_inventory_digest:fresh.predecessor_inventory_digest}),e=>e.code==='ambiguous-legacy-source');
});
test('unknown schemas, missing namespaces and source switches fail closed without discarding history',async()=>{
  const p=await project();await p.call('start',p.start());await retire(p);
  const store=await storeFor(p.root),run=await persisted(p,'runs/run-1.json');
  await p.put('.ai-factory/config.yaml','paths:\n  plans: planning\n');await p.put('planning/work.md','- [ ] 1.1 First task\n');
  for(const [name,text]of Object.entries({'task.md':'- [ ] 1.1 First task\n','context.md':'context','rules.md':'rules','verify.md':'verify','status.yaml':'plan_id: work\n'}))await p.put(`planning/work/${name}`,text);
  await assert.rejects(p.call('start',p.start({run_id:'new'})),e=>e.code==='state-source-collision');
  run.schema='aifhub.execution.v99';await store.save(`${folder}/runs/run-1.json`,run);await assert.rejects(inspect(p),e=>e.code==='unsupported-run-schema');
  run.schema='aifhub.execution.v2';await store.save(`${folder}/runs/run-1.json`,run);await rm(path.join(p.root,folder,'source.json'));await assert.rejects(inspect(p),e=>e.code==='state-source-collision');
});

for(const point of ['after-journal','after-write-0','after-write-1','after-write-2','before-applied'])test(`admission recovers exact images at ${point} and cannot be bypassed`,async()=>{
  const p=await project();const input=p.start();let hit=false;
  await assert.rejects(p.call('start',input,{failpoint:stage=>{if(stage===point){hit=true;throw new Error('injected');}}}));assert.equal(hit,true);
  await assert.rejects(p.call('start',p.start({run_id:'other'})),e=>e.code==='pending-transaction');
  // Reconciliation remains possible after current input disappears; the resulting
  // historical admission does not pass the worker's mandatory resume gate.
  await p.put('.ai-factory/config.yaml','aifhub:\n  tools:\n    openspec: invalid\n');
  const recovered=await p.call('start',input);assert.equal(recovered.historical,true);
  await assert.rejects(p.call('resume',{change_id:p.id,run_id:'run-1'}),e=>e.code==='tool-configuration-error');
  await retire(p);assert.equal((await inspect(p)).lifecycle,'interrupted');
});
for(const point of ['after-journal','after-write-0','after-write-1','after-write-2','before-applied'])test(`upgrade preserves one ledger and replays at ${point}`,async()=>{
  const p=await project();await writeLegacyExecution(p,{failures:1});await retire(p,'legacy');const inventory=await p.call('inspect',{change_id:p.id});
  const input={change_id:p.id,actor:'parent',upgrade_id:'upgrade',predecessor_inventory_digest:inventory.predecessor_inventory_digest};
  await assert.rejects(p.call('upgrade',input,{failpoint:stage=>{if(stage===point)throw new Error('injected');}}));
  await assert.rejects(p.call('start',p.start()),e=>e.code==='pending-transaction');
  await p.call('upgrade',input);assert.equal((await p.call('upgrade',input)).historical,true);
  assert.equal((await persisted(p,'fix-attempts.json')).attempts.length,1);await p.call('start',p.start({role:'fix'}));
  const check=await p.call('attempt-check',hypothesis(p));assert.equal(check.failed_hypotheses,1);
});
test('abrupt death of a test-owned helper leaves either actual lock authoritative',async()=>{
  const p=await project();await p.call('start',p.start());
  const module=pathToFileURL(path.resolve('scripts/workflow-state-store.mjs')).href;
  for(const lock of ['.ai-factory/state/execution-write.lock',`${folder}/write.lock`]){
    const code=`import {storeFor} from ${JSON.stringify(module)};const store=await storeFor(${JSON.stringify(p.root)});await store.lock(${JSON.stringify(lock)},async()=>{process.on('message',()=>{});process.send('locked');await new Promise(()=>{});});`;
    const child=spawn(process.execPath,['--input-type=module','-e',code],{stdio:['ignore','ignore','ignore','ipc'],windowsHide:true});
    const exited=once(child,'exit');let timer;
    try {
      const ready=await Promise.race([once(child,'message'),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('helper readiness timeout')),10000);})]);assert.equal(ready[0],'locked');
      assert.equal(child.exitCode,null);child.kill();await deadline(exited);const bytes=await p.get(lock);
      await assert.rejects(p.call('interrupt',interrupt(p)),e=>e.code==='state-locked');assert.equal(await p.get(lock),bytes);
    }finally{clearTimeout(timer);if(child.exitCode===null && child.signalCode===null){child.kill();await exited;}await rm(path.join(p.root,lock),{force:true});}
  }
});

test('a third ledger image conflicts before any upgrade publication and exact restoration permits replay',async()=>{
  const p=await project();await writeLegacyExecution(p,{failures:1});await retire(p,'legacy');
  const inventory=await p.call('inspect',{change_id:p.id}),input={change_id:p.id,actor:'parent',upgrade_id:'upgrade',predecessor_inventory_digest:inventory.predecessor_inventory_digest};
  const beforeRun=await p.get(`${folder}/runs/legacy.json`),beforeLedger=await p.get(`${folder}/fix-attempts.json`),store=await storeFor(p.root);
  await assert.rejects(p.call('upgrade',input,{failpoint:async stage=>{if(stage==='after-journal'){const ledger=await persisted(p,'fix-attempts.json');ledger.attempts[0].hypothesis='Concurrent old helper';await store.save(`${folder}/fix-attempts.json`,ledger);}}}),e=>e.code==='transaction-conflict');
  assert.equal(await p.get(`${folder}/runs/legacy.json`),beforeRun);
  await assert.rejects(p.call('upgrade',input),e=>e.code==='transaction-conflict');
  await p.put(`${folder}/fix-attempts.json`,beforeLedger);await p.call('upgrade',input);assert.equal((await persisted(p,'fix-attempts.json')).attempts.length,1);
});

test('catalogue limit fails before reading oversized run inventories or admitting a replacement',async()=>{
  const p=await project();await p.call('start',p.start());
  for(let offset=0;offset<1000;offset+=40)await Promise.all(Array.from({length:Math.min(40,1000-offset)},(_,i)=>p.put(`${folder}/runs/excess-${offset+i}.json`,'{}')));
  await assert.rejects(p.call('start',p.start({run_id:'replacement',scope:['src/b.js']})),e=>e.code==='execution-catalogue-full');
  await assert.rejects(p.get(`${folder}/runs/replacement.json`),{code:'ENOENT'});
});

test('nested receipt, ledger and journal corruption fails even with recomputed envelope checksums',async()=>{
  const p=await project();await p.call('start',p.start({role:'fix'}));await begin(p);await retire(p);
  const store=await storeFor(p.root),original=await persisted(p,'runs/run-1.json');
  for(const mutate of [r=>r.recovery.pending_attempts.push('../bad'),r=>r.receipts.interrupt.output.version=99,r=>r.execution_state='running',r=>r.checkpoint.progress.completed_steps={}]) {
    const run=structuredClone(original);mutate(run);await store.save(`${folder}/runs/run-1.json`,run);await assert.rejects(inspect(p));
  }
  await store.save(`${folder}/runs/run-1.json`,original);const ledger=await persisted(p,'fix-attempts.json');ledger.attempts[0].identity.context=digest('fake');await store.save(`${folder}/fix-attempts.json`,ledger);await assert.rejects(inspect(p),e=>e.code==='invalid-attempt-ledger');
  const journals=await readdir(path.join(p.root,folder,'transactions')),name=journals[0],tx=await persisted(p,'transactions/'+name);tx.response={arbitrary:'untrusted-body'};await store.save(`${folder}/transactions/${name}`,tx);await assert.rejects(inspect(p));
});

// The expected rejection comes from the lifecycle contract, independent of the
// serializer: a valid checksum cannot close an unaccepted native assignment.
test('state correspondence rejects a closed started single before inspect or replacement',async()=>{
  const p=await project();await p.call('start',p.start());
  const run=await persisted(p,'runs/run-1.json');run.lifecycle='closed';run.execution_state='stopped';
  await (await storeFor(p.root)).save(`${folder}/runs/run-1.json`,run);
  const before=await p.snapshot();
  await assert.rejects(inspect(p),e=>e.code==='invalid-state');
  await assert.rejects(p.call('start',p.start({run_id:'replacement'})),e=>e.code==='invalid-state');
  assert.deepEqual(await p.snapshot(),before);
});

test('state correspondence rejects stop knowledge without the matching transition receipt',async()=>{
  const p=await project();await p.call('start',p.start());await p.call('interrupt',interrupt(p));
  await p.put(trace,'Observed child exit');
  const run=await persisted(p,'runs/run-1.json');
  run.confirmation={confirmation_id:'stop-1',recovery_id:'recovery-1',evidence:{[trace]:digest('Observed child exit')}};
  run.execution_state='stopped';
  await (await storeFor(p.root)).save(`${folder}/runs/run-1.json`,run);
  const before=await p.snapshot();
  await assert.rejects(inspect(p),e=>e.code==='invalid-state');
  await assert.rejects(p.call('start',p.start({run_id:'replacement'})),e=>e.code==='invalid-state');
  assert.deepEqual(await p.snapshot(),before);
});

test('state correspondence binds native result, acceptance and recovery receipts to their records',async()=>{
  const p=await project();await p.call('start',p.start());await p.put(trace,'Observed check');
  const result={result_id:'done',status:'completed',changed_files:[],checks:[{name:'literal-check',exit_code:0}],evidence:[trace]};
  const completed=await p.call('result',p.actor(1,{result}));
  await p.call('accept',p.actor(2,{actor:'parent',result_digest:completed.result_digest}));
  const store=await storeFor(p.root),original=await persisted(p,'runs/run-1.json');
  const mutations=[r=>delete r.receipts.result,r=>delete r.receipts.accept,r=>{delete r.result;r.status='started';delete r.accepted_by;},
    r=>{r.receipts.accept.output.result_digest=digest('different');},r=>{r.receipts.result.submitted_version=2;r.receipts.result.output.version=3;}];
  for(const mutate of mutations){
    const run=structuredClone(original);mutate(run);
    for(const receipt of Object.values(run.receipts)){const {receipt_digest,...body}=receipt.output;receipt.output.receipt_digest=digest(body);}
    await store.save(`${folder}/runs/run-1.json`,run);const before=await p.snapshot();
    await assert.rejects(inspect(p),e=>e.code==='invalid-state');assert.deepEqual(await p.snapshot(),before);
  }
  await store.save(`${folder}/runs/run-1.json`,original);assert.equal((await inspect(p)).status,'accepted');
});

test('state correspondence validates recovery IDs, confirmation versions and auxiliary evidence',async()=>{
  const p=await project();await p.call('start',p.start());await p.call('interrupt',interrupt(p));await p.put(trace,'Observed exit');
  await p.call('stop-confirm',p.actor(2,{actor:'parent',recovery_id:'recovery-1',confirmation_id:'stop-1',evidence:[trace]}));
  const original=await persisted(p,'runs/run-1.json'),store=await storeFor(p.root);
  const mutations=[r=>delete r.receipts.interrupt,r=>r.receipts.interrupt.output.recovery_id='wrong',
    r=>r.receipts['stop-confirm'].output.confirmation_id='wrong',r=>{r.version=4;r.receipts['stop-confirm'].submitted_version=3;r.receipts['stop-confirm'].output.version=4;},
    r=>r.confirmation.evidence={[`${folder}/runs/run-1.json`]:digest('cycle')}];
  for(const mutate of mutations){
    const run=structuredClone(original);mutate(run);
    for(const receipt of Object.values(run.receipts)){const {receipt_digest,...body}=receipt.output;receipt.output.receipt_digest=digest(body);}
    await store.save(`${folder}/runs/run-1.json`,run);const before=await p.snapshot();
    await assert.rejects(inspect(p));await assert.rejects(p.call('start',p.start({run_id:'replacement'})));assert.deepEqual(await p.snapshot(),before);
  }
  await store.save(`${folder}/runs/run-1.json`,original);await p.call('start',p.start({run_id:'replacement'}));
});

for(const status of ['failed','accepted'])test(`state correspondence preserves proven v1 ${status} history without synthesizing receipts`,async()=>{
  const p=await project();const legacy=await writeLegacyExecution(p,{status});
  const inventory=await p.call('inspect',{change_id:p.id});
  await p.call('upgrade',{change_id:p.id,actor:'parent',upgrade_id:'terminal-upgrade',predecessor_inventory_digest:inventory.predecessor_inventory_digest});
  const saved=await persisted(p,'runs/legacy.json');assert.deepEqual(saved.result,legacy.run.result);assert.deepEqual(saved.receipts,{});
  const observed=await p.call('inspect',{change_id:p.id,run_id:'legacy'});assert.equal(observed.status,status);assert.equal(observed.lifecycle,'closed');
  const [journal]=await readdir(path.join(p.root,folder,'transactions')),bytes=await p.get(`${folder}/transactions/${journal}`);
  assert.ok(JSON.parse(bytes).record.writes.some(w=>w.before===legacy.runBytes));
  await rm(path.join(p.root,folder,'transactions',journal));
  await assert.rejects(p.call('inspect',{change_id:p.id,run_id:'legacy'}),e=>e.code==='invalid-state');
  await p.put(`${folder}/transactions/${journal}`,bytes);await p.call('start',p.start());
});

test('state correspondence preserves inherited completed result through interruption, stop and upgrade',async()=>{
  const p=await project();const legacy=await writeLegacyExecution(p,{status:'completed'});
  await p.call('interrupt',interrupt(p,{run_id:'legacy',version:2}));await p.put(trace,'Observed legacy exit');
  await p.call('stop-confirm',p.actor(3,{run_id:'legacy',actor:'parent',recovery_id:'recovery-1',confirmation_id:'stop-1',evidence:[trace]}));
  const inventory=await p.call('inspect',{change_id:p.id});
  await p.call('upgrade',{change_id:p.id,actor:'parent',upgrade_id:'recovered-upgrade',predecessor_inventory_digest:inventory.predecessor_inventory_digest});
  const saved=await persisted(p,'runs/legacy.json');assert.deepEqual(saved.result,legacy.run.result);assert.equal(saved.receipts.result,undefined);assert.equal(saved.version,4);
  assert.equal((await p.call('inspect',{change_id:p.id,run_id:'legacy'})).execution_state,'stopped');await p.call('start',p.start());
});

test('state correspondence rejects impossible v1 result versions before granting a history exception',async()=>{
  const p=await project();const legacy=await writeLegacyExecution(p,{status:'failed'}),store=await storeFor(p.root);
  const invalid=structuredClone(legacy.run);invalid.version=invalid.result.submitted_version;
  await store.save(`${folder}/runs/legacy.json`,invalid);const before=await p.snapshot();
  await assert.rejects(p.call('inspect',{change_id:p.id,run_id:'legacy'}),e=>e.code==='invalid-state');
  assert.deepEqual(await p.snapshot(),before);
});

test('state correspondence rejects a legacy proof journal that has no matching successor',async()=>{
  const p=await project();await writeLegacyExecution(p,{status:'failed'});
  const inventory=await p.call('inspect',{change_id:p.id});
  await p.call('upgrade',{change_id:p.id,actor:'parent',upgrade_id:'terminal-upgrade',predecessor_inventory_digest:inventory.predecessor_inventory_digest});
  const [journal]=await readdir(path.join(p.root,folder,'transactions')),tx=await persisted(p,'transactions/'+journal);
  const write=tx.writes.find(w=>w.path===`${folder}/runs/legacy.json`);write.after=write.before;
  await (await storeFor(p.root)).save(`${folder}/transactions/${journal}`,tx);const before=await p.snapshot();
  await assert.rejects(p.call('inspect',{change_id:p.id,run_id:'legacy'}),e=>e.code==='invalid-transaction');
  await assert.rejects(p.call('start',p.start()),e=>e.code==='invalid-transaction');assert.deepEqual(await p.snapshot(),before);
});
