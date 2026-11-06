// Stage-2 measured timings (#270): setup segments, mutating-command stamps,
// legacy validity and the fail-closed stamp cap. Timing values are asserted
// with `>= 0` (Windows timer resolution) or structurally; wall-clock stamps
// are correlation-only, never an execution claim.
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { executionProject } from './fixtures/execution-project.mjs';
import { validateRun } from './execution-records.mjs';
const projects=[];afterEach(async()=>{for(const p of projects.splice(0))await p.cleanup();});
const project=async()=>{const p=await executionProject();projects.push(p);return p;};
const folder='.ai-factory/state/work/execution';
const persisted=async(p,name)=>JSON.parse(await p.get(`${folder}/${name}`)).record;
const iso=s=>typeof s==='string'&&Number.isFinite(Date.parse(s));
const segmentValid=s=>{assert.ok(iso(s.started_at));assert.ok(iso(s.ended_at));assert.equal(Number.isSafeInteger(s.elapsed_ms)&&s.elapsed_ms>=0,true);};

test('start stamps the first action and records both setup segments summing to the total',async()=>{
  const p=await project();await p.call('start',p.start());
  const run=await persisted(p,'runs/run-1.json');
  assert.ok(run.timings,'fresh run carries timings');
  const setup=run.timings.setup;
  assert.equal(setup.complete,true);
  assert.ok(iso(setup.started_at)&&iso(setup.ended_at));
  assert.equal(setup.elapsed_ms,setup.segments.preflight.elapsed_ms+setup.segments.admission.elapsed_ms);
  segmentValid(setup.segments.preflight);segmentValid(setup.segments.admission);
  assert.deepEqual(run.timings.stamps.map(s=>s.action),['start']);
  assert.ok(iso(run.timings.stamps[0].at));
});

test('checkpoint stamps; resume, inspect and attempt commands do not stamp',async()=>{
  const p=await project();await p.call('start',p.start({role:'fix'}));
  await p.call('checkpoint',p.actor(1,{progress:{completed_steps:['a'],next_step:'b'}}));
  let run=await persisted(p,'runs/run-1.json');
  assert.deepEqual(run.timings.stamps.map(s=>s.action),['start','checkpoint']);
  const hypothesis={finding_id:'QA-1',hypothesis:'h',check:'c',environment_revision:'e',input_paths:[]};
  await p.call('attempt-begin',p.actor(2,hypothesis));
  await p.call('attempt-check',p.actor(2,hypothesis));
  await p.call('resume',{change_id:p.id,run_id:'run-1'});
  run=await persisted(p,'runs/run-1.json');
  assert.deepEqual(run.timings.stamps.map(s=>s.action),['start','checkpoint'],'read-only and ledger-only commands leave no stamp');
  await p.call('inspect',{change_id:p.id,run_id:'run-1'});
  run=await persisted(p,'runs/run-1.json');
  assert.equal(run.timings.stamps.length,2);
});

test('failed transitions leave no stamp',async()=>{
  const p=await project();await p.call('start',p.start());
  const before=(await persisted(p,'runs/run-1.json')).timings.stamps.length;
  await assert.rejects(p.call('checkpoint',p.actor(9,{progress:{completed_steps:[],next_step:'x'}})),e=>e.code==='version-conflict');
  assert.equal((await persisted(p,'runs/run-1.json')).timings.stamps.length,before);
});

test('result and accept stamp with their actions; prepared replay recovers without a new measurement',async()=>{
  const p=await project();const trace='.ai-factory/state/work/implementation/stop.md';
  await p.put(trace,'check');
  let hit=false;
  await assert.rejects(p.call('start',p.start(),{failpoint:stage=>{if(stage==='before-write-1'){hit=true;throw new Error('injected');}}}));
  assert.equal(hit,true,'start publication was interrupted after the prepared journal');
  const recovered=await p.call('start',p.start());
  const run=await persisted(p,'runs/run-1.json');
  assert.equal(recovered.recovered,true);
  assert.deepEqual(run.timings.stamps.map(s=>s.action),['start'],'recovered record keeps its original single stamp');
  assert.equal(run.timings.setup.complete,true);
  const result={result_id:'r',status:'completed',changed_files:[],checks:[{name:'check',exit_code:0}],evidence:[trace]};
  await p.call('result',p.actor(1,{result}));
  const completed=await persisted(p,'runs/run-1.json');
  assert.deepEqual(completed.timings.stamps.map(s=>s.action),['start','result']);
  await p.call('accept',p.actor(2,{actor:'parent',result_digest:completed.result.digest}));
  const accepted=(await persisted(p,'runs/run-1.json')).timings.stamps.map(s=>s.action);
  assert.deepEqual(accepted,['start','result','accept']);
});

test('interrupt and stop-confirm stamp; replay adds nothing',async()=>{
  const p=await project();const trace='.ai-factory/state/work/implementation/stop.md';
  await p.call('start',p.start());
  const input=p.actor(1,{actor:'parent',recovery_id:'recovery-1',reason:'cancelled',execution_state:'unknown'});
  await p.call('interrupt',input);
  let run=await persisted(p,'runs/run-1.json');
  assert.deepEqual(run.timings.stamps.map(s=>s.action),['start','interrupt']);
  const count=run.timings.stamps.length;
  await p.call('interrupt',input);
  assert.equal((await persisted(p,'runs/run-1.json')).timings.stamps.length,count,'replay is stamp-free');
  await p.put(trace,'Observed stop');
  await p.call('stop-confirm',p.actor(2,{actor:'parent',recovery_id:'recovery-1',confirmation_id:'stop-1',evidence:[trace]}));
  run=await persisted(p,'runs/run-1.json');
  assert.deepEqual(run.timings.stamps.map(s=>s.action),['start','interrupt','stop-confirm']);
});

test('validateRun accepts records without timings and rejects malformed shapes',async()=>{
  const p=await project();await p.call('start',p.start());
  const run=await persisted(p,'runs/run-1.json');
  validateRun(run); // valid with timings
  const legacy=structuredClone(run);delete legacy.timings;legacy.kind='single';
  validateRun(legacy); // pre-stage-2 record stays valid
  const foreign=structuredClone(run);foreign.timings.setup.foreign=1;
  assert.throws(()=>validateRun(foreign));
  const badSum=structuredClone(run);badSum.timings.setup.elapsed_ms+=1;
  assert.throws(()=>validateRun(badSum));
  const badStamp=structuredClone(run);badStamp.timings.stamps.push({action:'x',at:'not-a-date'});
  assert.throws(()=>validateRun(badStamp));
  const controlChar=structuredClone(run);controlChar.timings.stamps[0].action='a\x00b';
  assert.throws(()=>validateRun(controlChar));
});

test('the 256-stamp cap fails closed on the next rewrite',async()=>{
  const p=await project();await p.call('start',p.start());
  const run=await persisted(p,'runs/run-1.json');
  const at=run.timings.stamps[0].at;
  run.timings.stamps=Array.from({length:257},(_,i)=>({action:`s${i}`,at}));
  assert.throws(()=>validateRun(run),'257 stamps are rejected');
  run.timings.stamps=Array.from({length:256},(_,i)=>({action:`s${i}`,at}));
  validateRun(run); // 256 stamps stay representable
});

const batchTrace = id => `.ai-factory/state/work/implementation/${id}.md`;
const batchManifest = () => [
  { task_id: '1.1', files: ['src/a.js'], expected_change: 'Implement item 1', check: 'focused-check', dependencies: [] },
  { task_id: '1.2', files: ['src/b.js'], expected_change: 'Implement item 2', check: 'focused-check', dependencies: [] },
];
const batchResult = i => ({ result_id: `result-${i}`, status: 'completed', changed_files: [`src/${String.fromCharCode(96 + i)}.js`],
  checks: [{ name: 'focused-check', exit_code: 0 }], evidence: [batchTrace(i)] });

test('batch transitions stamp literal command names; batch-result keys never enter stamp.action (review wedge fix)', async () => {
  const p = await project();
  await p.put(batchTrace('preflight'), 'Observed independent files; no cross-item dependency.');
  await p.call('batch-start', { change_id: p.id, run_id: 'run-1', owner: 'parent', worker: 'worker', role: 'implement', manifest: batchManifest(), preflight_paths: [batchTrace('preflight')] });
  // Edits land before the checkpoint: batch-seal requires the sealed worktree
  // to equal the saved checkpoint (same order as the batches fixture).
  await p.put('src/a.js', 'fixed 1'); await p.put('src/b.js', 'fixed 2');
  await p.put(batchTrace(1), 'Observed item 1.'); await p.put(batchTrace(2), 'Observed item 2.');
  await p.call('checkpoint', p.actor(1, { progress: { completed_steps: [], next_step: 'Seal' } }));
  const evidence = { '1.1': [batchTrace(1)], '1.2': [batchTrace(2)] };
  const seal = await p.call('batch-seal', p.actor(2, { evidence }));
  let version = seal.version;
  const stamps = [];
  const readStamps = async () => (await persisted(p, 'runs/run-1.json')).timings.stamps.map(s => s.action);
  for (const i of [1, 2]) {
    await p.call('batch-result', p.actor(version, { task_id: `1.${i}`, seal_digest: seal.seal_digest, result: batchResult(i) }));
    version = (await persisted(p, 'runs/run-1.json')).version;
  }
  for (const i of [1, 2]) {
    await p.call('batch-accept', p.actor(version, { actor: 'parent', task_id: `1.${i}`, seal_digest: seal.seal_digest, result_digest: (await persisted(p, 'runs/run-1.json')).items[`1.${i}`].result.digest }));
    version = (await persisted(p, 'runs/run-1.json')).version;
  }
  await p.call('batch-close', p.actor(version, { actor: 'parent', seal_digest: seal.seal_digest }));
  stamps.push(...await readStamps());
  assert.deepEqual(stamps, ['batch-start', 'checkpoint', 'batch-seal', 'batch-result', 'batch-result', 'batch-accept', 'batch-accept', 'batch-close'],
    'stamps carry the literal command name; the task-suffixed receipt key never overflows stamp.action');
  const run = await persisted(p, 'runs/run-1.json');
  for (const stamp of run.timings.stamps) assert.ok(stamp.action.length <= 80);
});

test('the 256-stamp cap wedges honestly through a real saveRun rewrite (review coverage gap)', async () => {
  const p = await project();
  await p.call('start', p.start());
  let version = 1;
  const input = () => p.actor(version, { progress: { completed_steps: [], next_step: `step ${version}` } });
  // start contributes one stamp; 255 more checkpoints reach the cap exactly.
  for (let i = 0; i < 255; i += 1) {
    const view = await p.call('checkpoint', input());
    version = view.version;
  }
  let run = await persisted(p, 'runs/run-1.json');
  assert.equal(run.timings.stamps.length, 256, 'the cap is reached, not exceeded, by legal transitions');
  await assert.rejects(p.call('checkpoint', input()), error => error.code === 'invalid-state',
    'the 257th stamp fails the rewrite: an honest fail-closed wedge of this run');
  const after = await persisted(p, 'runs/run-1.json');
  assert.equal(after.timings.stamps.length, 256, 'the rejected transition persisted nothing');
  assert.equal(after.version, version, 'the failed transition left no version advance');
});
