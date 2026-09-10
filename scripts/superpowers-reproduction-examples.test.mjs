import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {checkOutput} from '../test/fixtures/superpowers-skill-eval/check-output.mjs';

test('the experimental ordered-trial recipe retains joint polluters and non-monotonic masking',async()=>{
 const doc=await fs.readFile(new URL('../test/fixtures/superpowers-skill-eval/variants/test-pollution-2.md',import.meta.url),'utf8');
 const code=doc.match(/<!-- example: ordered-trials -->\r?\n```js\r?\n([\s\S]*?)\r?\n```/)[1];
 const createTrials=new Function(code+'; return createTrials;')();
 const steps={enable:s=>s.enabled=true,blue:s=>s.cache='blue',reset:s=>s.cache=null,noise:()=>{},setup:()=>{throw Error('unrelated');}};
 const options={budget:12,deadline:100,now:()=>0,createState:()=>({enabled:false,cache:null}),steps,
  target:s=>s.enabled&&s.cache==='blue'?'target-symptom':'clean',seed:41};
 const controller=createTrials(options);
 for(const [ids,outcome] of [[[],'clean'],[['noise','enable','blue','noise'],'target-symptom'],[['enable'],'clean'],[['blue'],'clean'],[['enable','blue'],'target-symptom'],[['enable','blue','reset'],'clean'],[['setup','blue'],'unrelated-failure']])
  assert.equal(controller.trial(ids).outcome,outcome);
 assert.deepEqual(controller.history[4].ids,['enable','blue']);
 assert.equal(controller.history.length,7);
 const single=createTrials({...options,createState:()=>({enabled:true,cache:null})});
 assert.equal(single.trial([]).outcome,'clean');
 assert.equal(single.trial(['blue']).outcome,'target-symptom');
});
test('the experimental recipe counts clean trials and enforces one finite budget and deadline',async()=>{
 const doc=await fs.readFile(new URL('../test/fixtures/superpowers-skill-eval/variants/test-pollution-2.md',import.meta.url),'utf8');
 const code=doc.match(/<!-- example: ordered-trials -->\r?\n```js\r?\n([\s\S]*?)\r?\n```/)[1];
 const createTrials=new Function(code+'; return createTrials;')();
 let time=0;
 const options={budget:2,deadline:10,now:()=>time,createState:()=>({}),steps:{slow:()=>{time=10;}},target:()=> 'clean',seed:41};
 const bounded=createTrials(options);
 assert.equal(bounded.trial([]).outcome,'clean');assert.equal(bounded.trial([]).outcome,'clean');
 assert.equal(bounded.trial([]).outcome,'budget-exhausted');assert.equal(bounded.history.length,2);
 const deadline=createTrials(options);assert.equal(deadline.trial(['slow']).outcome,'deadline-exhausted');
 assert.equal(deadline.trial([]).outcome,'budget-exhausted');
 assert.throws(()=>createTrials({...options,budget:Infinity}),RangeError);
});
const root=fileURLToPath(new URL('../test/fixtures/superpowers-skill-eval/',import.meta.url));
async function specimen(name,fn) {
 const input=JSON.parse(await fs.readFile(path.join(root,name+'.json'),'utf8'));
 const temp=await fs.mkdtemp(path.join(os.tmpdir(),'aifhub-sp141-specimen-'));
 try {
  for(const [name,content] of Object.entries(input.files)){const p=path.join(temp,name);await fs.mkdir(path.dirname(p),{recursive:true});await fs.writeFile(p,content);}
  await fn(temp,input);
 } finally {
  assert.equal(path.dirname(await fs.realpath(temp)),await fs.realpath(os.tmpdir()));
  assert.ok(path.basename(temp).startsWith('aifhub-sp141-specimen-'));
  await fs.rm(temp,{recursive:true,force:true});
 }
}
test('boundary checker rejects the original defect, a hard-coded runner and rewritten evidence',async()=>{
 await specimen('boundary-tracing/lost-option',async(workspace,input)=>{
  const check=()=>checkOutput({caseId:'lost-option',workspace,report:{status:'completed'}});
  const failed=await check();assert.equal(failed.passed,false);
  assert.ok(!JSON.stringify(failed).includes('fixture-only-canary'));
  await fs.writeFile(path.join(workspace,'src/runner.mjs'),"export function run(o){return {limit:7,label:o.label};}\n");
  assert.equal((await check()).passed,false);
  await fs.writeFile(path.join(workspace,'src/runner.mjs'),input.files['src/runner.mjs']);
  await fs.writeFile(path.join(workspace,'src/evidence.mjs'),"export function record(o){return {value:7,label:o.label};}\n");
  assert.equal((await check()).passed,false);
  await fs.writeFile(path.join(workspace,'src/evidence.mjs'),input.files['src/evidence.mjs']);
  await fs.writeFile(path.join(workspace,'src/resolver.mjs'),"export function resolveOptions(o){return {label:o.label,limit:o.limit};}\n");
  assert.equal((await check()).passed,true);
  assert.equal(await fs.readFile(path.join(workspace,'private-canary.txt'),'utf8'),input.files['private-canary.txt']);
 });
});

test('pollution specimens require clean original and reduced sequences and tenant isolation',async()=>{
 for(const id of ['single-polluter','joint-polluters'])await specimen('test-pollution/'+id,async(workspace,input)=>{
  const check=()=>checkOutput({caseId:id,workspace,report:{status:'completed'}});
  assert.equal((await check()).passed,false);
  await fs.writeFile(path.join(workspace,'src/cache.mjs'),"export function cacheKey(tenant,id){return JSON.stringify([tenant,id]);}\n");
  assert.equal((await check()).passed,true);
  assert.equal(await fs.readFile(path.join(workspace,'user-owned.txt'),'utf8'),input.files['user-owned.txt']);
  await fs.writeFile(path.join(workspace,'src/cache.mjs'),"export function cacheKey(tenant,id){return tenant+':'+id;}\n");
  assert.equal((await check()).passed,false,'delimiter collisions must not become a supported fix');
 });
});
test('unrelated errors and exhausted trials cannot be declared fixed',async()=>{
 for(const caseId of ['unrelated-error','trial-budget'])await specimen('test-pollution/'+caseId,async(workspace)=>{
  assert.equal((await checkOutput({caseId,workspace,report:{status:'completed'}})).passed,false);
  assert.equal((await checkOutput({caseId,workspace,report:{status:'incomplete'}})).passed,true);
 });
});
test('unavailable boundary remains incomplete evidence, never a localized fix',async()=>{
 await specimen('boundary-tracing/unavailable-boundary',async(workspace)=>{
  assert.equal((await checkOutput({caseId:'unavailable-boundary',workspace,report:{status:'completed'}})).passed,false);
  assert.equal((await checkOutput({caseId:'unavailable-boundary',workspace,report:{status:'incomplete'}})).passed,true);
 });
});
