import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { executionProject } from './fixtures/execution-project.mjs';
import { digest, storeFor } from './workflow-state-store.mjs';
const projects=[];
afterEach(async()=>{for(const p of projects.splice(0))await p.cleanup();});
const project=async()=>{const p=await executionProject();projects.push(p);return p;};
const trace=id=>`.ai-factory/state/work/implementation/${id}.md`;
const manifest=(n=2)=>Array.from({length:n},(_,i)=>({task_id:`1.${i+1}`,files:[`src/${String.fromCharCode(97+i)}.js`],expected_change:`Implement item ${i+1}`,check:'focused-check',dependencies:[]}));
const start=(p,extra={})=>({change_id:p.id,run_id:'run-1',owner:'parent',worker:'worker',role:'implement',manifest:manifest(),preflight_paths:[trace('preflight')],...extra});
const owner=(p,version,extra={})=>p.actor(version,{actor:'parent',...extra});
const result=(i,extra={})=>({result_id:`result-${i}`,status:'completed',changed_files:[`src/${String.fromCharCode(96+i)}.js`],checks:[{name:'focused-check',exit_code:0}],evidence:[trace(i)],...extra});
async function prepare(p,n=2) {
  await p.put('openspec/changes/work/tasks.md',manifest(n).map((i,n)=>`- [ ] ${i.task_id} Item ${n+1}\n`).join(''));
  await p.put(trace('preflight'),'Observed independent files; no cross-item dependency.');
  await p.call('batch-start',start(p,{manifest:manifest(n)}));
  for(let i=1;i<=n;i++){await p.put(manifest(n)[i-1].files[0],`fixed ${i}\n`);await p.put(trace(i),`Observed item ${i} against final inputs.\n`);}
  await p.call('checkpoint',p.actor(1,{progress:{completed_steps:['Edited all assigned files'],next_step:'Seal final checks'}}));
  const evidence=Object.fromEntries(manifest(n).map((t,i)=>[t.task_id,[trace(i+1)]]));
  const seal=await p.call('batch-seal',p.actor(2,{evidence})); return {seal,evidence};
}
test('batch admission rejects malformed manifests, dependencies and missing or cyclic preflight without state',async()=>{
  const p=await project();await p.put(trace('preflight'),'Preflight.');
  const base=manifest();
  const bad=[manifest(1),manifest(6),[base[0],base[0]],[base[0],{...base[1],files:['src/A.js']}],[{...base[0],files:['src/A.js']},base[1]],
    [base[0],{...base[1],files:['src']}],[base[0],{...base[1],files:['src/*.js']}],
    [base[0],{...base[1],files:['.ai-factory/rules.md']}],[{...base[0],dependencies:['1.2']},base[1]],
    [{...base[0],extra:'unknown'},base[1]]];
  for(const items of bad){const before=await p.snapshot();await assert.rejects(p.call('batch-start',start(p,{manifest:items})));assert.deepEqual(await p.snapshot(),before);}
  for(const paths of [[],['missing.md'],['.ai-factory/state/other/execution/source.json']]){
    const before=await p.snapshot();await assert.rejects(p.call('batch-start',start(p,{preflight_paths:paths})));assert.deepEqual(await p.snapshot(),before);
  }
});
for(const order of [[1,2],[2,1]])test(`sealed results accept sequentially in order ${order} and replay without transitions`,async()=>{
  const p=await project();const {seal,evidence}=await prepare(p);let version=seal.version;const receipts={};
  const sealInput=p.actor(2,{evidence});assert.equal((await p.call('batch-seal',sealInput)).replay,true);
  for(const i of [1,2]){
    const input=p.actor(version,{task_id:`1.${i}`,seal_digest:seal.seal_digest,result:result(i)});
    receipts[i]=await p.call('batch-result',input);version=receipts[i].version;
    assert.equal((await p.call('batch-result',input)).version,version);
    await assert.rejects(p.call('batch-result',{...input,result:result(i,{summary:'replacement'})}),e=>e.code==='conflicting-result');
  }
  for(const i of order){const input=owner(p,version,{task_id:`1.${i}`,seal_digest:seal.seal_digest,result_digest:receipts[i].result_digest});const accepted=await p.call('batch-accept',input);version=accepted.version;assert.equal((await p.call('batch-accept',input)).replay,true);}
  const closeInput=owner(p,version,{seal_digest:seal.seal_digest}),closed=await p.call('batch-close',closeInput);
  assert.deepEqual(closed.accepted,['1.1','1.2']);assert.deepEqual(closed.unfinished,[]);
  assert.match(await p.get('openspec/changes/work/tasks.md'),/\[ \]/);
  await p.put('openspec/changes/work/tasks.md','- [x] 1.1 Item 1\n- [x] 1.2 Item 2\n');
  const historical=await p.call('batch-close',closeInput);assert.equal(historical.historical,true);assert.equal(historical.version,closed.version);
  await assert.rejects(p.call('resume',{change_id:p.id,run_id:'run-1'}),e=>e.code==='stale-context');
});
test('four accepted items leave the fifth unfinished and preserve dirty baseline',async()=>{
  const p=await project();await p.put('outside.txt','Unrelated user edit\n');const {seal}=await prepare(p,5);let v=seal.version;
  for(let i=1;i<=4;i++){const r=await p.call('batch-result',p.actor(v,{task_id:`1.${i}`,seal_digest:seal.seal_digest,result:result(i)}));const a=await p.call('batch-accept',owner(p,r.version,{task_id:`1.${i}`,seal_digest:seal.seal_digest,result_digest:r.result_digest}));v=a.version;}
  const closed=await p.call('batch-close',owner(p,v,{seal_digest:seal.seal_digest}));assert.deepEqual(closed.unfinished,['1.5']);assert.equal(closed.accepted.length,4);assert.equal(await p.get('outside.txt'),'Unrelated user edit\n');
});
test('seal requires saved final checkpoint; edits outside union and cross-item attribution fail',async()=>{
  const p=await project();await p.put(trace('preflight'),'preflight');await p.call('batch-start',start(p));
  await p.put('src/a.js','new');const evidence={'1.1':[],'1.2':[]};
  await assert.rejects(p.call('batch-seal',p.actor(1,{evidence})),e=>e.code==='stale-checkpoint');
  await p.put('outside.txt','wrong');await assert.rejects(p.call('checkpoint',p.actor(1,{progress:{completed_steps:[],next_step:'Seal'}})),e=>e.code==='outside-scope');
  await p.put('outside.txt','preserve\n');await p.put(trace(1),'check');
  await p.call('checkpoint',p.actor(1,{progress:{completed_steps:[],next_step:'Seal'}}));
  const seal=await p.call('batch-seal',p.actor(2,{evidence:{'1.1':[trace(1)],'1.2':[]}}));
  for(const changed_files of [[],['src/b.js']])await assert.rejects(p.call('batch-result',p.actor(3,{task_id:'1.1',seal_digest:seal.seal_digest,result:result(1,{changed_files})})),e=>e.code==='changed-files-mismatch');
  await p.put(trace(2),'late');await assert.rejects(p.call('batch-result',p.actor(3,{task_id:'1.2',seal_digest:seal.seal_digest,result:result(2,{changed_files:[]})})),e=>e.code==='sealed-evidence-mismatch');
});
test('creation and deletion reconcile as exact item changes',async()=>{
  const p=await project();await p.put(trace('preflight'),'preflight');const items=manifest();items[1].files=['src/new.js'];
  await p.call('batch-start',start(p,{manifest:items}));await rm(path.join(p.root,'src/a.js'));await p.put('src/new.js','created');
  await p.put(trace(1),'deleted check');await p.put(trace(2),'created check');
  await p.call('checkpoint',p.actor(1,{progress:{completed_steps:[],next_step:'Seal'}}));
  const seal=await p.call('batch-seal',p.actor(2,{evidence:{'1.1':[trace(1)],'1.2':[trace(2)]}}));
  const a=await p.call('batch-result',p.actor(3,{task_id:'1.1',seal_digest:seal.seal_digest,result:result(1)}));
  const b=await p.call('batch-result',p.actor(a.version,{task_id:'1.2',seal_digest:seal.seal_digest,result:result(2,{changed_files:['src/new.js']})}));assert.equal(b.version,5);
});
test('seal freshness includes sibling files, all evidence, preflight, HEAD and index',async()=>{
  const p=await project();const {seal}=await prepare(p);
  const submit=()=>p.call('batch-result',p.actor(3,{task_id:'1.1',seal_digest:seal.seal_digest,result:result(1)}));
  for(const [file,content,code]of [['src/b.js','later','stale-seal'],[trace(2),'new evidence','stale-evidence'],[trace('preflight'),'new preflight','stale-preflight'],['AGENTS.md','new policy','stale-context']]){
    const old=await p.get(file).catch(()=>null);await p.put(file,content);await assert.rejects(submit(),e=>e.code===code);
    await assert.rejects(p.call('batch-close',owner(p,3,{seal_digest:seal.seal_digest})),e=>e.code===code);
    if(old===null)await rm(path.join(p.root,file));else await p.put(file,old);
  }
  await rm(path.join(p.root,trace(2)));await assert.rejects(submit(),e=>e.code==='missing-evidence');await p.put(trace(2),'Observed item 2 against final inputs.\n');
  await p.git('add','src/a.js');await assert.rejects(submit(),e=>e.code==='stale-revision');
});
test('strict actors, kinds, payloads and cyclic evidence cannot mutate batch state',async()=>{
  const p=await project();const {seal}=await prepare(p);const before=await p.snapshot();
  const good=p.actor(3,{task_id:'1.1',seal_digest:seal.seal_digest,result:result(1)});
  for(const [action,input]of [['batch-result',{...good,actor:'parent'}],['result',p.actor(3,{result:result(1)})],['batch-result',{...good,extra:1}],['batch-result',{...good,task_id:'9'}],['batch-result',{...good,seal_digest:'wrong'}],['batch-result',{...good,result:result(1,{evidence:['.ai-factory/state/other/execution/fix-attempts.json']})}]])await assert.rejects(p.call(action,input));
  assert.deepEqual(await p.snapshot(),before);
});
test('concurrent overlapping admissions across source IDs have at most one winner; disjoint assignments stay freshness-bound',async()=>{
  const p=await project();await p.put('openspec/changes/other/proposal.md','# Other');await p.put('openspec/changes/other/tasks.md','- [ ] 1.1 Other task\n');
  const starts=[p.start(),p.start({change_id:'other',run_id:'run-2',scope:['src/A.js']})];
  const outcomes=await Promise.allSettled(starts.map(input=>p.call('start',input)));assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1);
  assert.ok(['state-locked','scope-reserved'].includes(outcomes.find(r=>r.status==='rejected').reason.code));
  const winner=outcomes.find(r=>r.status==='fulfilled').value;
  const disjoint=await p.call('start',p.start({change_id:winner.change_id,run_id:'disjoint',task_id:'1.1',scope:['src/b.js']}));
  await p.put('src/b.js','sibling edit');await assert.rejects(p.call('resume',{change_id:winner.change_id,run_id:winner.run_id}),e=>e.code==='outside-scope');assert.equal(disjoint.version,1);
});
test('shared-version mutations have only one winner',async()=>{
  const p=await project();const {seal}=await prepare(p);
  const calls=[1,2].map(i=>p.call('batch-result',p.actor(3,{task_id:`1.${i}`,seal_digest:seal.seal_digest,result:result(i)})));
  const outcomes=await Promise.allSettled(calls);assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1);
  assert.ok(['state-locked','version-conflict'].includes(outcomes.find(r=>r.status==='rejected').reason.code));
});

test('interruption retains accepted item history but forbids closure or any further worker result',async()=>{
  const p=await project();const {seal}=await prepare(p);
  const r=await p.call('batch-result',p.actor(3,{task_id:'1.1',seal_digest:seal.seal_digest,result:result(1)}));
  await p.call('batch-accept',owner(p,4,{task_id:'1.1',seal_digest:seal.seal_digest,result_digest:r.result_digest}));
  await p.put('src/b.js','late mutation');
  await p.call('interrupt',owner(p,5,{recovery_id:'retired',reason:'abandoned',execution_state:'unknown'}));
  const saved=JSON.parse(await p.get('.ai-factory/state/work/execution/runs/run-1.json')).record;
  assert.equal(saved.items['1.1'].accepted,true);assert.equal(saved.items['1.1'].result.digest,r.result_digest);assert.equal(saved.closure,undefined);
  await assert.rejects(p.call('batch-close',owner(p,6,{seal_digest:seal.seal_digest})),e=>e.code==='run-interrupted');
  await assert.rejects(p.call('batch-result',p.actor(6,{task_id:'1.2',seal_digest:seal.seal_digest,result:result(2)})),e=>e.code==='run-interrupted');
});

const runFile='.ai-factory/state/work/execution/runs/run-1.json';
async function rejectBatchImage(p,original,mutate,extra=[]) {
  const run=structuredClone(original);mutate(run);
  for(const saved of Object.values(run.receipts)) {
    const {receipt_digest,...body}=saved.output;saved.output.receipt_digest=digest(body);
  }
  const store=await storeFor(p.root);await store.save(runFile,run);const before=await p.snapshot();
  for(const [action,input] of [
    ['inspect',{change_id:p.id,run_id:'run-1'}],['resume',{change_id:p.id,run_id:'run-1'}],
    ['start',p.start({run_id:'replacement'})],...extra]) {
    await assert.rejects(p.call(action,input),e=>['invalid-state','invalid-input'].includes(e.code),action);
  }
  assert.deepEqual(await p.snapshot(),before);await store.save(runFile,original);
}

// A checksum is deliberately recomputed: the independent expectation is that
// immutable close replay cannot promote the unreported second item.
test('batch receipt correspondence rejects contradictory close replay without mutation',async()=>{
  const p=await project();const {seal}=await prepare(p);
  const r=await p.call('batch-result',p.actor(3,{task_id:'1.1',seal_digest:seal.seal_digest,result:result(1)}));
  const accepted=await p.call('batch-accept',owner(p,r.version,{task_id:'1.1',seal_digest:seal.seal_digest,result_digest:r.result_digest}));
  const input=owner(p,accepted.version,{seal_digest:seal.seal_digest}),closed=await p.call('batch-close',input);
  assert.deepEqual(closed.accepted,['1.1']);assert.deepEqual(closed.unfinished,['1.2']);
  const original=JSON.parse(await p.get(runFile)).record;
  for(const mutate of [
    r=>{r.receipts['batch-close'].output.accepted=['1.1','1.2'];r.receipts['batch-close'].output.unfinished=[];},
    r=>r.receipts['batch-close'].output.seal_digest=digest('wrong seal'),
    r=>r.receipts['batch-close'].output.lifecycle='sealed',
    r=>r.receipts['batch-close'].output.execution_state='running',
    r=>r.receipts['batch-close'].output.result_digest=digest('extra discriminator'),
    r=>{r.receipts['batch-close'].submitted_version--;r.receipts['batch-close'].output.version--;},
  ])await rejectBatchImage(p,original,mutate,[['batch-close',input]]);
  assert.deepEqual((await p.call('batch-close',input)).unfinished,['1.2']);
  await p.put('openspec/changes/work/tasks.md','- [x] 1.1 Item 1\n- [ ] 1.2 Item 2\n');
  assert.equal((await p.call('batch-close',input)).historical,true);
});

test('batch receipt correspondence binds seal and item receipts to legal transitions',async()=>{
  const p=await project();const {seal}=await prepare(p);
  const first=await p.call('batch-result',p.actor(3,{task_id:'1.1',seal_digest:seal.seal_digest,result:result(1)}));
  const second=await p.call('batch-result',p.actor(first.version,{task_id:'1.2',seal_digest:seal.seal_digest,result:result(2)}));
  const accepted=await p.call('batch-accept',owner(p,second.version,{task_id:'1.2',seal_digest:seal.seal_digest,result_digest:second.result_digest}));
  await p.call('batch-accept',owner(p,accepted.version,{task_id:'1.1',seal_digest:seal.seal_digest,result_digest:first.result_digest}));
  const original=JSON.parse(await p.get(runFile)).record;
  const version=(r,key,v)=>{r.receipts[key].submitted_version=v;r.receipts[key].output.version=v+1;};
  for(const mutate of [
    r=>r.receipts['batch-seal'].output.lifecycle='active',
    r=>r.receipts['batch-seal'].output.execution_state='stopped',
    r=>r.receipts['batch-result:1.1'].output.seal_digest=digest('wrong seal'),
    r=>r.receipts['batch-result:1.1'].output.lifecycle='closed',
    r=>r.receipts['batch-accept:1.2'].output.seal_digest=digest('wrong seal'),
    r=>r.receipts['batch-accept:1.2'].output.execution_state='stopped',
    r=>delete r.items['1.2'].accepted,
    r=>{delete r.items['1.2'].result;delete r.items['1.2'].accepted;},
    r=>{r.receipts['batch-result:9']={...r.receipts['batch-result:1.1'],output:{...r.receipts['batch-result:1.1'].output,task_id:'9'}};},
    r=>version(r,'batch-result:1.1',4),
    r=>{version(r,'batch-accept:1.2',6);version(r,'batch-accept:1.1',7);r.version=8;},
    r=>{version(r,'batch-seal',2);version(r,'batch-accept:1.1',1);},
    r=>{r.lifecycle='active';},
    r=>{r.execution_state='unknown';},
  ])await rejectBatchImage(p,original,mutate);
  const closed=await p.call('batch-close',owner(p,original.version,{seal_digest:seal.seal_digest}));
  assert.deepEqual(closed.accepted,['1.1','1.2']);
});

test('batch receipt correspondence preserves pre-seal checkpoints and empty closure',async()=>{
  const p=await project();await p.put(trace('preflight'),'Independent fixture tasks');await p.call('batch-start',start(p));
  for(const v of [1,2,3])await p.call('checkpoint',p.actor(v,{progress:{completed_steps:[],next_step:'Inspect tasks'}}));
  const seal=await p.call('batch-seal',p.actor(4,{evidence:{'1.1':[],'1.2':[]}}));
  const closed=await p.call('batch-close',owner(p,seal.version,{seal_digest:seal.seal_digest}));
  assert.deepEqual(closed.accepted,[]);assert.deepEqual(closed.unfinished,['1.1','1.2']);assert.equal(closed.version,6);
});

for(const sealed of [false,true])test(`batch receipt correspondence preserves interruption and stop confirmation with sealed=${sealed}`,async()=>{
  const p=await project();let version;
  if(sealed){const prepared=await prepare(p);version=prepared.seal.version;}
  else {await p.put(trace('preflight'),'Independent fixture tasks');await p.call('batch-start',start(p));const checkpoint=await p.call('checkpoint',p.actor(1,{progress:{completed_steps:[],next_step:'Inspect tasks'}}));version=checkpoint.version;}
  const input=owner(p,version,{recovery_id:'retired',reason:'abandoned',execution_state:'unknown'});
  const retired=await p.call('interrupt',input);await p.put(trace('stop'),'Fixture worker exit observed');
  const confirmed=await p.call('stop-confirm',owner(p,retired.version,{recovery_id:'retired',confirmation_id:'stopped',evidence:[trace('stop')]}));
  assert.equal(confirmed.version,version+2);assert.equal((await p.call('interrupt',input)).historical,true);
  await p.call('start',p.start({run_id:'replacement'}));
});
