import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hash } from './skill-workflow-eval.mjs';
import { OBSERVATION_SCHEMA, analyzeActions } from './superpowers-skill-observations.mjs';

const contentHash=hash('complete supplied skill content');
const catalog=[{name:'aif-plan',path:'skills/aif-plan/SKILL.md',contentHash,invocationPolicy:'auto'}];
function sample() {
  const event=(type,fields={})=>({type,executionId:'execution-1',turn:0,record:'record',...fields});
  return {executionId:'execution-1',catalog,expectedSkills:['aif-plan'],invocation:'explicit',actions:{
    schema:OBSERVATION_SCHEMA,executionId:'execution-1',source:{kind:'synthetic',hash:hash('synthetic source only'),complete:true},
    events:[event('request',{sequence:1,record:'request-1'}),event('content',{sequence:2,record:'content-1',skill:'aif-plan',path:catalog[0].path,
      contentHash,providedHash:contentHash,delivery:'read',success:true,complete:true}),
      event('action',{sequence:3,record:'action-1',dependsOn:['aif-plan']}),event('final',{sequence:4,record:'final-1',claims:[]})]}};
}
test('exact content before a dependent action satisfies the observed loading criterion',()=>{
  const result=analyzeActions(sample());
  assert.equal(result.eligible,true);assert.equal(result.metrics.missedLoads,0);assert.equal(result.metrics.prematureActions,0);
});

test('observed user turns match the frozen prompt and sequential scripted replies',()=>{
  const input=sample();input.turnHashes=[hash('first prompt'),hash('second prompt')];
  assert.equal(analyzeActions(input).eligible,false);
  input.actions.events[0].inputHash=input.turnHashes[0];
  const incomplete=analyzeActions(input);
  assert.equal(incomplete.eligible,false);assert.deepEqual(incomplete.reasons,['user-turns-incomplete']);
  assert.ok(Object.values(incomplete.metrics).every(value=>value===null));
  const final=input.actions.events.pop();
  input.actions.events.push({type:'user-response',executionId:input.executionId,sequence:4,turn:1,record:'reply',scripted:true,inputHash:hash('invented reply')},{...final,sequence:5,turn:1});
  assert.equal(analyzeActions(input).eligible,false);
  input.actions.events[3].inputHash=input.turnHashes[1];
  assert.equal(analyzeActions(input).eligible,true);
});

test('terminal failure may end a verified prefix but cannot invent a scripted reply',()=>{
  const input=sample();input.turnHashes=[hash('first prompt'),hash('second prompt')];
  input.actions.events[0].inputHash=input.turnHashes[0];
  input.actions.events[3]={type:'terminal',sequence:4,turn:0,record:'terminal',executionId:input.executionId,outcome:'failed'};
  assert.equal(analyzeActions(input).eligible,true);
  assert.equal(analyzeActions(input).terminalOutcome,'failed');
  input.actions.events.splice(3,0,{type:'user-response',sequence:4,turn:1,record:'reply',executionId:input.executionId,scripted:true,inputHash:hash('invented reply')});
  input.actions.events.at(-1).sequence=5;input.actions.events.at(-1).turn=1;
  assert.equal(analyzeActions(input).eligible,false);
});

test('starting a check before loading its required skill is a premature action',()=>{
  const input=sample(),events=input.actions.events;
  events[2]={...events[2],type:'check-start',checkId:'test',commandHash:hash('node test.mjs')};delete events[2].dependsOn;
  [events[1],events[2]]=[events[2],events[1]];events.forEach((e,i)=>e.sequence=i+1);
  events.splice(3,0,{type:'check-result',sequence:4,turn:0,record:'result-1',executionId:input.executionId,
    checkId:'test',commandHash:hash('node test.mjs'),exitCode:0});events.at(-1).sequence=5;
  assert.equal(analyzeActions(input).metrics.prematureActions,1);
});
test('late content remains a premature action even when the final answer sounds correct',()=>{
  const input=sample();[input.actions.events[1],input.actions.events[2]]=[input.actions.events[2],input.actions.events[1]];
  input.actions.events.forEach((e,i)=>e.sequence=i+1);
  const result=analyzeActions(input);assert.equal(result.metrics.prematureActions,1);assert.equal(result.metrics.missedLoads,1);
});
test('clipped or absent logs leave metrics unknown',()=>{
  const input=sample();input.actions.source.complete=false;
  assert.equal(analyzeActions(input).eligible,false);assert.equal(analyzeActions(input).metrics.missedLoads,null);
  delete input.actions;assert.equal(analyzeActions(input).eligible,false);
});

test('description, promise, failed or truncated reads do not make full content available',()=>{
  for(const type of ['description','promise']){
    const input=sample(),old=input.actions.events[1];
    input.actions.events[1]={type,sequence:2,turn:0,executionId:old.executionId,record:old.record,skill:old.skill};
    const result=analyzeActions(input);assert.equal(result.metrics.missedLoads,1);assert.equal(result.metrics.prematureActions,2);
  }
  for(const patch of [{success:false},{complete:false},{providedHash:null},{providedHash:hash('different bytes')},{contentHash:hash('old version')}]) {
    const input=sample();Object.assign(input.actions.events[1],patch);
    const result=analyzeActions(input);assert.equal(result.metrics.missedLoads,1);assert.equal(result.metrics.wrongSkillLoads,1);
  }
});
test('exact host injection before the request and same-session previous-turn content are recognized',()=>{
  const input=sample(),events=input.actions.events;
  [events[0],events[1]]=[events[1],events[0]];events[0].delivery='host-injection';events.forEach((e,i)=>e.sequence=i+1);
  assert.equal(analyzeActions(input).metrics.missedLoads,0);
  const prior=sample();prior.actions.events[2].turn=1;prior.actions.events[3].turn=1;
  assert.equal(analyzeActions(prior).metrics.prematureActions,0);
});
test('wrong alias, duplicate records, reordered or foreign events and raw payloads are rejected',()=>{
  const wrong=sample();wrong.actions.events[1].skill='legacy-alias';
  assert.equal(analyzeActions(wrong).metrics.wrongSkillLoads,1);
  const duplicate=sample();duplicate.actions.events[1].record=duplicate.actions.events[0].record;
  assert.throws(()=>analyzeActions(duplicate),/duplicate-action-record/);
  const order=sample();order.actions.events[1].sequence=3;
  assert.throws(()=>analyzeActions(order),/action-order/);
  const foreign=sample();foreign.actions.events[1].executionId='another-execution';
  assert.throws(()=>analyzeActions(foreign),/action-execution-mismatch/);
  const raw=sample();raw.actions.events[1].transcript='not allowed';
  assert.throws(()=>analyzeActions(raw),/unexpected-action-field/);
  const envelope=sample();envelope.actions.rawTranscript='synthetic forbidden marker';
  assert.throws(()=>analyzeActions(envelope),/unexpected-actions-field/);
});
test('negative and explicit-only cases count unnecessary activation without rewarding a forced load',()=>{
  const negative=sample();negative.expectedSkills=[];negative.actions.events[2].dependsOn=[];
  assert.equal(analyzeActions(negative).metrics.unnecessaryLoads,1);
  const mode=sample();mode.invocation='natural';mode.catalog=[{...catalog[0],name:'aif-mode',invocationPolicy:'explicit-only'}];
  mode.expectedSkills=[];mode.actions.events[1].skill='aif-mode';mode.actions.events[2].dependsOn=[];
  const result=analyzeActions(mode);assert.equal(result.metrics.unnecessaryLoads,1);assert.equal(result.metrics.wrongSkillLoads,1);
});
test('a self-reported check requires the matching observed start and result',()=>{
  const missing=sample();missing.actions.events.at(-1).claims=[{checkId:'test-1',outcome:'passed'}];
  assert.equal(analyzeActions(missing).metrics.unsupportedChecks,1);
  const input=sample(),last=input.actions.events.pop(),commandHash=hash('node --test');
  input.actions.events.push(
    {type:'check-start',sequence:4,turn:0,record:'start',executionId:'execution-1',checkId:'test-1',commandHash},
    {type:'check-result',sequence:5,turn:0,record:'result',executionId:'execution-1',checkId:'test-1',commandHash,exitCode:1},
    {...last,sequence:6,claims:[{checkId:'test-1',outcome:'passed'}]});
  assert.equal(analyzeActions(input).metrics.unsupportedChecks,1);
  input.actions.events.at(-1).claims[0].outcome='failed';
  assert.equal(analyzeActions(input).metrics.unsupportedChecks,0);
});

test('intermediate statements cannot borrow check evidence from later execution',()=>{
  const input=sample(),last=input.actions.events.pop(),commandHash=hash('node --test');
  const event=(type,sequence,fields)=>({type,sequence,turn:0,record:'record-'+sequence,executionId:input.executionId,...fields});
  input.actions.events.push(event('statement',4,{claims:[{checkId:'test-1',outcome:'passed'}]}),
    event('check-start',5,{checkId:'test-1',commandHash}),event('check-result',6,{checkId:'test-1',commandHash,exitCode:0}),
    {...last,sequence:7,claims:[{checkId:'test-1',outcome:'passed'}]});
  assert.equal(analyzeActions(input).metrics.unsupportedChecks,1);
});

test('observed terminal failure is distinct from an assistant final and missing evidence',()=>{
  for(const outcome of ['failed','timed_out']){
    const input=sample(),last=input.actions.events.at(-1);
    input.actions.events[input.actions.events.length-1]={type:'terminal',sequence:last.sequence,turn:0,
      record:'terminal',executionId:input.executionId,outcome};
    const result=analyzeActions(input);
    assert.equal(result.eligible,true);assert.equal(result.terminalOutcome,outcome);
    input.actions.source.complete=false;
    assert.equal(analyzeActions(input).eligible,false);
  }
  const input=sample(),last=input.actions.events.at(-1);
  input.actions.events[input.actions.events.length-1]={...last,type:'terminal',outcome:'completed'};
  delete input.actions.events.at(-1).claims;
  assert.throws(()=>analyzeActions(input),/invalid-terminal-outcome/);
  input.actions.events.at(-1).outcome='failed';
  input.actions.events.push({...last,sequence:5,record:'after-terminal'});
  assert.throws(()=>analyzeActions(input),/terminal-must-be-last/);
});

test('an open check leaves evidence unknown even after a final or terminal event',()=>{
  for(const terminal of [false,true]){
    const input=sample(),last=input.actions.events.pop();
    input.actions.events.push({type:'check-start',sequence:4,turn:0,record:'open-check',executionId:input.executionId,
      checkId:'test-1',commandHash:hash('node --test')},terminal
      ?{type:'terminal',sequence:5,turn:0,record:'terminal',executionId:input.executionId,outcome:'timed_out'}
      :{...last,sequence:5});
    const result=analyzeActions(input);assert.equal(result.eligible,false);
    assert.deepEqual(result.reasons,['actions-check-incomplete']);assert.equal(result.metrics.unsupportedChecks,null);
  }
});

test('native subchecks bind to an open shell check without duplicating its load metric',()=>{
  const input=sample(),last=input.actions.events.pop();
  input.actions.events=input.actions.events.filter(e=>e.type!=='content'&&e.type!=='action');
  const event=(type,fields)=>({type,sequence:input.actions.events.length+1,turn:0,record:'record-'+(input.actions.events.length+1),executionId:input.executionId,...fields});
  input.actions.events.push(event('check-start',{checkId:'shell',commandHash:hash('compound shell')}));
  input.actions.events.push(event('check-start',{checkId:'node',parentCheckId:'shell',commandHash:hash('node original.mjs')}));
  input.actions.events.push(event('check-result',{checkId:'shell',commandHash:hash('compound shell'),exitCode:0}));
  input.actions.events.push(event('check-result',{checkId:'node',commandHash:hash('node original.mjs'),exitCode:1}));
  input.actions.events.push({...last,sequence:6,claims:[{checkId:'node',outcome:'failed'}]});
  const result=analyzeActions(input);assert.equal(result.eligible,true);assert.equal(result.metrics.unsupportedChecks,0);
  assert.equal(result.metrics.prematureActions,2,'one shell invocation plus final; subcheck is the same action');
  input.actions.events[2].parentCheckId='missing';
  assert.throws(()=>analyzeActions(input),/unmatched-parent-check/);
  input.actions.events[2].parentCheckId='shell';
  [input.actions.events[2],input.actions.events[3]]=[input.actions.events[3],input.actions.events[2]];
  input.actions.events.forEach((e,i)=>e.sequence=i+1);
  assert.throws(()=>analyzeActions(input),/unmatched-parent-check/,'cannot invent a subcheck after the shell completed');
});
