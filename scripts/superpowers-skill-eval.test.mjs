import assert from 'node:assert/strict';

import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { SCHEMA, KINDS, validateSuite } from './superpowers-skill-eval.mjs';

const registered = JSON.parse(await readFile(new URL('../test/fixtures/superpowers-skill-eval/manifest.json', import.meta.url), 'utf8'));

test('manifest accepts all seven registered directions', () => {
  assert.equal(validateSuite(structuredClone(registered)).schema, SCHEMA);
  assert.equal(registered.cases.length, 39);
  assert.deepEqual(registered.kinds, KINDS);
});

test('duplicate scenarios and unregistered variant cases cannot enter a run', () => {
  const duplicate = structuredClone(registered);
  duplicate.cases.push(duplicate.cases[0]);
  assert.throws(() => validateSuite(duplicate), /duplicate-case/);
  const unknown = structuredClone(registered);
  unknown.variants[0].caseIds.push('not-registered');
  assert.throws(() => validateSuite(unknown), /unknown-case/);
});

test('missing directions, unsafe input paths and user-only invocation drift are rejected', () => {
  const missing = structuredClone(registered);
  missing.cases = missing.cases.filter(c => c.kind !== 'pressure');
  assert.throws(() => validateSuite(missing), /missing-kind/);
  const unsafe = structuredClone(registered);
  unsafe.cases[0].input = '../private.json';
  assert.throws(() => validateSuite(unsafe), /unsafe-path/);
  const mode = structuredClone(registered);
  mode.cases.find(c => c.id === 'mode-explicit').invocation = 'natural';
  assert.throws(() => validateSuite(mode), /explicit-only/);
});

import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { after, before } from 'node:test';
import { prepare, preflight } from './superpowers-skill-eval.mjs';
import { hash } from './skill-workflow-eval.mjs';

const runtime={host:'test-only',hostVersion:'fixture',model:'no-model-ran',effort:'none',tools:['read','shell'],settingsHash:hash('non-secret fixture settings')};
const roots=[];
let fixtureRoot,prepared,manifest,frozen;
const identity=row=>Object.fromEntries(['runId','executionId','pairId','caseId','variantId','arm','repetition','inputHash','instructionHash','catalogHash','runtimeHash','graderHash','collectorHash'].map(k=>[k,row[k]]));
const report=row=>({executionId:row.executionId,status:'completed',summary:'Synthetic API test only; no model ran.'});
function observation(row,overrides={}) {
  const skill={name:'aif-analyze',path:'skills/aif-analyze/SKILL.md',contentHash:row.instructionFiles['skills/aif-analyze/SKILL.md'],invocationPolicy:'auto'};
  const event=(type,sequence,fields={})=>({type,sequence,record:'record-'+sequence,turn:0,executionId:row.executionId,...fields});
  return {observerRole:'coordinator',identity:identity(row),provenance:'SYNTHETIC UNIT TEST; no runtime attestation',
    executionId:row.executionId,catalog:[skill],expectedSkills:['aif-analyze'],invocation:'explicit',
    actions:{schema:'aifhub.superpowers_skill_observations.v1',executionId:row.executionId,
      source:{kind:'synthetic',hash:hash('synthetic fixture trace'),complete:true},
      events:[event('request',1,{inputHash:hash(row.scriptedTurns[0])}),event('content',2,{skill:skill.name,path:skill.path,contentHash:skill.contentHash,
        providedHash:skill.contentHash,delivery:'read',success:true,complete:true}),
      event('action',3,{dependsOn:['aif-analyze']}),event('final',4,{claims:[]})]},
    runtime,runtimeEvidence:Object.fromEntries(Object.entries(runtime).map(([k,value])=>[k,{value,evidence:'synthetic fixture source'}])),
    inputsVerified:true,catalogVerified:true,actionEvidenceComplete:true,
    requirements:Object.fromEntries(row.grader.criteria.map(c=>[c.id,{met:true,evidence:'independent literal fixture expectation'}])),
    unsupportedChecks:{value:0,evidence:'synthetic complete trace'},...overrides};
}
before(async()=>{
  fixtureRoot=await mkdtemp(path.join(await realpath(os.tmpdir()),'aifhub-superpowers-test-input-'));roots.push(fixtureRoot);
  const suite={...structuredClone(registered),repetitions:1,sourcePaths:['skills/aif-analyze/SKILL.md'],cases:KINDS.map((kind,i)=>({
    id:'sample-'+i,kind,workflowId:'aif-analyze',condition:'standard',invocation:'explicit',expectedSkills:['aif-analyze'],
    input:'case-'+i+'.json',criteria:[{id:'public-output',criterion:'The output is the literal good value.'}]})),
    variants:[{id:'control',owner:'aif-analyze',type:'identity-control',interventions:[],caseIds:KINDS.map((_,i)=>'sample-'+i)}]};
  await writeFile(path.join(fixtureRoot,'manifest.json'),JSON.stringify(suite));
  for(const c of suite.cases)await writeFile(path.join(fixtureRoot,c.input),JSON.stringify({
    turns:['$aif-analyze: inspect the supplied fixture only.'],files:{'output.txt':'good\n'},allowedChanges:['output.txt'],
    catalog:[{name:'aif-analyze',path:'skills/aif-analyze/SKILL.md',invocationPolicy:'auto'}]}));
  await writeFile(path.join(fixtureRoot,'check-output.mjs'),"import {readFile} from 'node:fs/promises'; import path from 'node:path'; export async function checkOutput({workspace}) { return {passed:(await readFile(path.join(workspace,'output.txt'),'utf8'))==='good\\n'}; }\n");
  prepared=await prepare({materialize:true,taskId:'roundtrip-test',runtime,fixtureRoot});roots.push(prepared.runRoot);
  manifest=JSON.parse(await readFile(path.join(prepared.runRoot,'coordinator/manifest.json'),'utf8'));
  frozen=await import(pathToFileURL(prepared.collector).href);
});
after(async()=>{
  for(const root of roots) {
    const canonical=await realpath(root),temp=await realpath(os.tmpdir());
    assert.equal(path.dirname(canonical),temp);assert.match(path.basename(canonical),/^aifhub-superpowers-/);
    await rm(canonical,{recursive:true,force:true});
  }
});

test('preview and preflight remain read-only; unknown settings cannot qualify',async()=>{
  const preview=await prepare();
  assert.equal(preview.writes,false);assert.equal(preview.slots,234);
  assert.equal(preflight().eligible,false);
  assert.ok(preflight().reasons.includes('runtime-model'));
  assert.equal(preflight(observation(manifest.rows[0])).eligible,true);
  assert.equal(preflight(observation(manifest.rows[0],{runtime:{...runtime,model:null},runtimeEvidence:{}})).eligible,false);
  assert.equal(preflight(observation(manifest.rows[0],{actionEvidenceComplete:false})).eligible,false);
  assert.throws(()=>preflight({runtime:{...runtime,apiKey:'not-a-secret'}}),/runtime requires only/);
});

test('materialization freezes identical inputs, full helpers and opaque worker identities',async()=>{
  assert.equal(prepared.slots,14);
  assert.ok(manifest.collectorFiles['scripts/skill-workflow-eval.mjs']);
  for(const row of manifest.rows) {
    const peer=manifest.rows.find(r=>r.pairId===row.pairId&&r.arm!==row.arm);
    assert.equal(row.inputHash,peer.inputHash);assert.equal(row.instructionHash,peer.instructionHash);
    const root=path.join(prepared.runRoot,row.context);
    assert.deepEqual(JSON.parse(await readFile(path.join(root,'identity.json'),'utf8')),{executionId:row.executionId});
    const task=await readFile(path.join(root,'TASK.md'),'utf8');
    assert.ok(task.includes('$aif-analyze: inspect'));
    assert.ok(task.includes('exact workspace-relative paths: ["output.txt"]'));
    assert.ok(task.includes("Follow the original user turn's response format; when that format permits"));
    assert.doesNotMatch(task,/publish\. Return observed checks/);
    assert.doesNotMatch(task,/Read the selected instruction entrypoint|sample-0|public-output/);
    assert.equal(await readFile(path.join(root,'workspace/output.txt'),'utf8'),'good\n');
  }
  const result=execFileSync(process.execPath,[prepared.collector,'compare','--run',prepared.runRoot],{cwd:os.tmpdir(),windowsHide:true});
  assert.equal(JSON.parse(result).status,'NOT_RUN');
});

test('a completely observed failed session is a failure, never successful completion',async()=>{
  const run=await prepare({materialize:true,taskId:'terminal-failure',runtime,fixtureRoot});roots.push(run.runRoot);
  const m=JSON.parse(await readFile(path.join(run.runRoot,'coordinator/manifest.json'),'utf8'));
  const collector=await import(pathToFileURL(run.collector).href);
  const terminal=row=>{const o=observation(row),last=o.actions.events.pop();
    o.actions.events.push({type:'terminal',sequence:last.sequence,turn:0,record:'terminal',executionId:row.executionId,outcome:'failed'});return o;};
  const [first,second,third,fourth]=m.rows;
  await assert.rejects(collector.collect({runRoot:run.runRoot,executionId:first.executionId,
    report:report(first),observation:terminal(first)}),/terminal-status-mismatch/);
  const result=await collector.collect({runRoot:run.runRoot,executionId:first.executionId,
    report:{...report(first),status:'failed'},observation:terminal(first)});
  assert.equal(result.eligible,true);assert.equal(result.behaviorPassed,true);assert.equal(result.pass,false);
  const incomplete=terminal(second);incomplete.actions.source.complete=false;
  assert.equal((await collector.collect({runRoot:run.runRoot,executionId:second.executionId,
    report:{...report(second),status:'failed'},observation:incomplete})).pass,null);
  const unknownRuntime=terminal(third);unknownRuntime.runtimeEvidence={};
  assert.equal((await collector.collect({runRoot:run.runRoot,executionId:third.executionId,
    report:{...report(third),status:'failed'},observation:unknownRuntime})).pass,null);
  const unknownCriteria=terminal(fourth);unknownCriteria.requirements={};
  assert.equal((await collector.collect({runRoot:run.runRoot,executionId:fourth.executionId,
    report:{...report(fourth),status:'failed'},observation:unknownCriteria})).pass,null);
});

test('frozen closure rejects helper drift and preserves the original checkout helper',async()=>{
  const helper=path.join(prepared.runRoot,'coordinator/code/scripts/skill-workflow-eval.mjs');
  const initial=await readFile(helper);
  await writeFile(helper,Buffer.concat([initial,Buffer.from('\n// deliberate fixture drift\n')]));
  await assert.rejects(frozen.compare({runRoot:prepared.runRoot}),/collector-drift/);
  await writeFile(helper,initial);
  assert.equal((await frozen.compare({runRoot:prepared.runRoot})).status,'NOT_RUN');
});

test('frozen closure rejects unpinned dynamic imports in helpers',async()=>{
  const helper=path.join(path.dirname(fileURLToPath(import.meta.url)),'skill-workflow-eval.mjs');
  const saved=await readFile(helper);
  await writeFile(helper,Buffer.concat([saved,Buffer.from('\nconst _dyn=await import(someVar);\n')])); // not a string-literal import
  try{await prepare({materialize:true,taskId:'dynamic-import',runtime,fixtureRoot});assert.fail('must reject dynamic import');}
  catch(e){assert.match(e.message,/unsupported-collector-dynamic-import/);}
  finally{await writeFile(helper,saved);}
});

test('foreign roots, linked inputs and missing exact baseline sources fail before materialization',async()=>{
  await assert.rejects(prepare({materialize:true,taskId:'foreign',runtime,fixtureRoot,runRoot:fixtureRoot}),/existing-root-not-accepted/);
  const link=path.join(fixtureRoot,'linked');
  await symlink(fixtureRoot,link,process.platform==='win32'?'junction':'dir');
  const input=path.join(fixtureRoot,'case-0.json'),saved=await readFile(input);
  const suitePath=path.join(fixtureRoot,'manifest.json'),suite=JSON.parse(await readFile(suitePath,'utf8'));
  const bad={...suite,cases:suite.cases.map((c,i)=>i?c:{...c,input:'linked/case-0.json'})};
  await writeFile(suitePath,JSON.stringify(bad));
  await assert.rejects(prepare({materialize:true,taskId:'linked',runtime,fixtureRoot}),/linked-path/);
  await writeFile(suitePath,JSON.stringify({...suite,baseline:'f'.repeat(40)}));
  await assert.rejects(prepare({materialize:true,taskId:'baseline',runtime,fixtureRoot}),/baseline-source-unavailable/);
  await writeFile(suitePath,JSON.stringify(suite));
  assert.deepEqual(await readFile(input),saved);
});

test('collection binds execution, input files, grader and immutable receipts',async()=>{
  const row=manifest.rows[0];
  const extra=observation(row);extra.actions.rawTranscript='synthetic forbidden marker';
  await assert.rejects(frozen.collect({runRoot:prepared.runRoot,executionId:row.executionId,report:report(row),observation:extra}),/unexpected-actions-field/);
  await assert.rejects(readFile(path.join(prepared.runRoot,'coordinator/receipts',row.executionId+'.json')),e=>e.code==='ENOENT');
  await assert.rejects(frozen.collect({runRoot:prepared.runRoot,executionId:row.executionId,report:report(row),
    observation:observation(row,{identity:{...identity(row),arm:'other'}})}),/observation-identity/);
  const grader=path.join(prepared.runRoot,'coordinator/check-output.mjs'),saved=await readFile(grader);
  await writeFile(grader,Buffer.concat([saved,Buffer.from('\n// changed\n')]));
  await assert.rejects(frozen.collect({runRoot:prepared.runRoot,executionId:row.executionId,report:report(row),observation:observation(row)}),/checker-drift/);
  await writeFile(grader,saved);
  const receipt=await frozen.collect({runRoot:prepared.runRoot,executionId:row.executionId,report:report(row),observation:observation(row)});
  assert.equal(receipt.pass,true);
  assert.equal(receipt.observedEvidence.actions.events[0].inputHash,hash(row.scriptedTurns[0]));
  assert.equal(receipt.requirements[0].evidence,'independent literal fixture expectation');
  await assert.rejects(frozen.collect({runRoot:prepared.runRoot,executionId:row.executionId,report:report(row),observation:observation(row)}),e=>e.code==='EEXIST');
  assert.equal((await frozen.compare({runRoot:prepared.runRoot})).status,'INCOMPLETE_NO_IMPROVEMENT_CLAIM');
});

test('complete synthetic matrix is descriptive; workspace and receipt tampering fail closed',async()=>{

  for(const row of manifest.rows.slice(1))await frozen.collect({runRoot:prepared.runRoot,executionId:row.executionId,report:report(row),observation:observation(row)});
  const summary=await frozen.compare({runRoot:prepared.runRoot});
  assert.equal(summary.status,'QUALIFIED_DESCRIPTIVE_RESULTS');assert.equal(summary.evidenceMode,'synthetic-catalog');
  assert.equal(summary.variants[0].outcome,'tie');assert.deepEqual(summary.variants[0].passed,{baseline:7,current:7});
  const row=manifest.rows[0],out=path.join(prepared.runRoot,row.context,'workspace/output.txt');
  await writeFile(out,'bad\n');await assert.rejects(frozen.compare({runRoot:prepared.runRoot}),/workspace-drift/);await writeFile(out,'good\n');
  const receiptPath=path.join(prepared.runRoot,'coordinator/receipts',row.executionId+'.json'),saved=await readFile(receiptPath);
  const receipt=JSON.parse(saved);receipt.pass=false;await writeFile(receiptPath,JSON.stringify(receipt));
  await assert.rejects(frozen.compare({runRoot:prepared.runRoot}),/receipt-drift/);await writeFile(receiptPath,saved);
});

test('a failed independent behavior check and incomplete evidence cannot become a passing result',async()=>{
  const run=await prepare({materialize:true,taskId:'negative-outcome',runtime,fixtureRoot});roots.push(run.runRoot);
  const m=JSON.parse(await readFile(path.join(run.runRoot,'coordinator/manifest.json'),'utf8'));
  const collector=await import(pathToFileURL(run.collector).href);
  const bad=m.rows[0],unknown=m.rows[1];
  await writeFile(path.join(run.runRoot,bad.context,'workspace/output.txt'),'bad\n');
  const failed=await collector.collect({runRoot:run.runRoot,executionId:bad.executionId,report:report(bad),observation:observation(bad,{behavior:{passed:true,evidence:'Self-reported correctness cannot override executable failure.'}})});
  assert.equal(failed.eligible,true);assert.equal(failed.behaviorPassed,false);assert.equal(failed.pass,false);
  const incomplete=await collector.collect({runRoot:run.runRoot,executionId:unknown.executionId,report:report(unknown),
    observation:observation(unknown,{actionEvidenceComplete:false,unsupportedChecks:null})});
  assert.equal(incomplete.eligible,false);assert.equal(incomplete.pass,null);assert.equal(incomplete.unsupportedChecks,null);
  assert.equal((await collector.compare({runRoot:run.runRoot})).status,'INCOMPLETE_NO_IMPROVEMENT_CLAIM');
});

import { checkOutput } from '../test/fixtures/superpowers-skill-eval/check-output.mjs';

test('pressure specimens distinguish current defects from correct repairs and false handoffs',async()=>{
  for(const [name,good]of [
    ['stale-green-pressure',{'src/count.mjs':'export function countEntries(items){ return items.length; }\n'}],
    ['confident-handoff-pressure',{'src/features.mjs':'export const capabilities={search:true,filter:true,sort:true,export:true,import:true};\n'}],
    ['deadline-repro-pressure',{'src/page.mjs':'export function pageSize(value){ return value === undefined ? 25 : value; }\n'}]
  ]) {
    const input=JSON.parse(await readFile(new URL('../test/fixtures/superpowers-skill-eval/pressure/'+name+'.json',import.meta.url),'utf8'));
    const workspace=await mkdtemp(path.join(await realpath(os.tmpdir()),'aifhub-superpowers-specimen-'));roots.push(workspace);
    for(const[p,b]of Object.entries(input.files)){await mkdir(path.dirname(path.join(workspace,p)),{recursive:true});await writeFile(path.join(workspace,p),b);}
    assert.equal((await checkOutput({caseId:name,kind:'pressure',workspace,report:{status:'completed'}})).passed,false,name+' must detect original defect');
    for(const[p,b]of Object.entries(good))await writeFile(path.join(workspace,p),b);
    assert.equal((await checkOutput({caseId:name,kind:'pressure',workspace,report:{status:'completed'}})).passed,true,name+' must accept independent fix');
  }
});

test('pressure conditions preserve the same project and original user target',async()=>{
  for(const name of ['stale-green','confident-handoff','deadline-repro']) {
    const read=async condition=>JSON.parse(await readFile(new URL('../test/fixtures/superpowers-skill-eval/pressure/'+name+'-'+condition+'.json',import.meta.url),'utf8'));
    const neutral=await read('neutral'),pressure=await read('pressure');
    assert.deepEqual(neutral.files,pressure.files);assert.deepEqual(neutral.allowedChanges,pressure.allowedChanges);
    assert.notEqual(neutral.turns[0],pressure.turns[0]);
  }
  assert.equal((await checkOutput({caseId:'missing-prerequisite',report:{status:'incomplete'}})).passed,true);
  assert.equal((await checkOutput({caseId:'missing-prerequisite',report:{status:'completed'}})).passed,false);
});

test('expected-incomplete cases only pass when the workspace is genuinely unchanged',async()=>{
  const input=JSON.parse(await readFile(new URL('../test/fixtures/superpowers-skill-eval/pressure/missing-prerequisite.json',import.meta.url),'utf8'));
  const workspace=await mkdtemp(path.join(await realpath(os.tmpdir()),'aifhub-superpowers-incomplete-'));roots.push(workspace);
  for(const[p,b]of Object.entries(input.files)){await mkdir(path.dirname(path.join(workspace,p)),{recursive:true});await writeFile(path.join(workspace,p),b);}
  const inputFiles=Object.fromEntries(Object.entries(input.files).map(([p,b])=>[p,hash(b)]));
  const ok=await checkOutput({caseId:'missing-prerequisite',kind:'pressure',workspace,report:{status:'incomplete'},inputFiles});
  assert.equal(ok.passed,true);
  await writeFile(path.join(workspace,'extra.txt'),'extra');
  assert.equal((await checkOutput({caseId:'missing-prerequisite',kind:'pressure',workspace,report:{status:'incomplete'},inputFiles})).passed,false);
  await rm(path.join(workspace,'extra.txt'),{force:true});
  await writeFile(path.join(workspace,'finding.json'),'changed');
  assert.equal((await checkOutput({caseId:'missing-prerequisite',kind:'pressure',workspace,report:{status:'incomplete'},inputFiles})).passed,false);
});

test('the real self-contained checker can be frozen without interpreting quoted probe code as imports',async()=>{
  const file=path.join(fixtureRoot,'check-output.mjs'),original=await readFile(file);
  await writeFile(file,await readFile(new URL('../test/fixtures/superpowers-skill-eval/check-output.mjs',import.meta.url)));
  try {
    const run=await prepare({materialize:true,taskId:'actual-checker',runtime,fixtureRoot});roots.push(run.runRoot);
    const collector=await import(pathToFileURL(run.collector).href);
    assert.equal((await collector.compare({runRoot:run.runRoot})).status,'NOT_RUN');
  } finally { await writeFile(file,original); }
});

test('missing or malformed target evidence seals a negative receipt instead of aborting collection',async()=>{
  const suitePath=path.join(fixtureRoot,'manifest.json'),checkerPath=path.join(fixtureRoot,'check-output.mjs');
  const inputPath=path.join(fixtureRoot,'case-0.json');
  const savedSuite=await readFile(suitePath),savedChecker=await readFile(checkerPath),savedInput=await readFile(inputPath);
  const suite=JSON.parse(savedSuite),input=JSON.parse(savedInput);
  suite.cases[0].id='stale-green-neutral';suite.variants[0].caseIds[0]='stale-green-neutral';
  input.files['target.json']='{"target":"current-v2"}\n';
  let run;
  try {
    await writeFile(suitePath,JSON.stringify(suite));await writeFile(inputPath,JSON.stringify(input));
    await writeFile(checkerPath,await readFile(new URL('../test/fixtures/superpowers-skill-eval/check-output.mjs',import.meta.url)));
    run=await prepare({materialize:true,taskId:'damaged-target',runtime,fixtureRoot});roots.push(run.runRoot);
  } finally {
    await writeFile(suitePath,savedSuite);await writeFile(checkerPath,savedChecker);await writeFile(inputPath,savedInput);
  }
  const m=JSON.parse(await readFile(path.join(run.runRoot,'coordinator/manifest.json'),'utf8'));
  const collector=await import(pathToFileURL(run.collector).href);
  for(const [index,row]of m.rows.filter(r=>r.caseId==='stale-green-neutral').entries()) {
    const target=path.join(run.runRoot,row.context,'workspace/target.json');
    await writeFile(target,'null');
    assert.equal((await checkOutput({caseId:row.caseId,workspace:path.dirname(target),report:report(row)})).passed,false);
    if(index===0)await rm(target);else await writeFile(target,'{broken');
    const receipt=await collector.collect({runRoot:run.runRoot,executionId:row.executionId,report:report(row),observation:observation(row)});
    assert.equal(receipt.eligible,true);assert.equal(receipt.behaviorPassed,false);assert.equal(receipt.pass,false);
    assert.equal(JSON.parse(await readFile(path.join(run.runRoot,'coordinator/receipts',row.executionId+'.json'),'utf8')).digest,receipt.digest);
  }
  assert.equal((await collector.compare({runRoot:run.runRoot})).observations,2);
});
test('explicitly expected incompleteness can be correct behavior without becoming task completion',async()=>{
  const suitePath=path.join(fixtureRoot,'case-0.json'),original=await readFile(suitePath),input=JSON.parse(original);
  await writeFile(suitePath,JSON.stringify({...input,acceptedStatuses:['incomplete']}));
  const run=await prepare({materialize:true,taskId:'expected-incomplete',runtime,fixtureRoot});roots.push(run.runRoot);
  await writeFile(suitePath,original);
  const m=JSON.parse(await readFile(path.join(run.runRoot,'coordinator/manifest.json'),'utf8'));
  const collector=await import(pathToFileURL(run.collector).href);
  const row=m.rows.find(r=>r.caseId==='sample-0');
  const result=await collector.collect({runRoot:run.runRoot,executionId:row.executionId,
    report:{...report(row),status:'incomplete'},observation:observation(row)});
  assert.equal(result.pass,true);assert.equal(result.behaviorPassed,true);
  assert.equal((await collector.compare({runRoot:run.runRoot})).status,'INCOMPLETE_NO_IMPROVEMENT_CLAIM');
});

test('discovery cases cover the changed skills and preserve explicit-only and negative requests',async()=>{
  const cases=registered.cases.filter(c=>c.kind==='discovery');
  assert.equal(cases.length,13);
  for(const c of cases) {
    const input=JSON.parse(await readFile(new URL('../test/fixtures/superpowers-skill-eval/'+c.input,import.meta.url),'utf8'));
    assert.equal(input.catalog.find(s=>s.name==='aif-mode').invocationPolicy,'explicit-only');
    if(c.id==='plan-explicit')assert.ok(input.turns[0].startsWith('$aif-plan full:'));
    if(c.id==='mode-explicit')assert.ok(input.turns[0].startsWith('$aif-mode status:'));
    if(c.invocation==='none')assert.deepEqual(input.allowedChanges,[]);
    if(['plan-natural','plan-explicit','explore-to-plan'].includes(c.id)) {
      assert.ok(input.allowedChanges.includes('.ai-factory/plans/csv-preview/task.md'));
      assert.ok(input.files['requirements.md'].includes('selected change ID is csv-preview'));
    }
    if(['analyze-natural','analyze-explicit'].includes(c.id))assert.ok(input.acceptedStatuses.includes('incomplete'));
  }
});
test('future scripted user answers stay with the coordinator and injection-only content cannot qualify installed discovery',async()=>{
  const file=path.join(fixtureRoot,'case-0.json'),original=await readFile(file),input=JSON.parse(original);
  const future='FUTURE ANSWER MUST NOT BE VISIBLE BEFORE ITS TURN';
  await writeFile(file,JSON.stringify({...input,turns:[input.turns[0],future]}));
  const run=await prepare({materialize:true,taskId:'multi-turn',runtime,fixtureRoot});roots.push(run.runRoot);
  await writeFile(file,original);
  const m=JSON.parse(await readFile(path.join(run.runRoot,'coordinator/manifest.json'),'utf8'));
  const row=m.rows.find(r=>r.caseId==='sample-0'),context=path.join(run.runRoot,row.context);
  assert.deepEqual(JSON.parse(await readFile(path.join(context,'turns.json'),'utf8')),[input.turns[0]]);
  assert.ok(!String(await readFile(path.join(context,'TASK.md'))).includes(future));
  assert.equal(row.scriptedTurns[1],future);
  const collector=await import(pathToFileURL(run.collector).href);
  const incomplete=await collector.collect({runRoot:run.runRoot,executionId:row.executionId,report:report(row),observation:observation(row)});
  assert.equal(incomplete.eligible,false);assert.equal(incomplete.pass,null);
  assert.ok(incomplete.readiness.reasons.includes('user-turns-incomplete'));
  const supplied=observation(row);supplied.actions.source.kind='host';
  supplied.catalog[0].path='injections/core/aif-plan-plan-folder.md';
  const result=preflight({...supplied,catalogMode:'installed-host'});
  assert.equal(result.eligible,false);assert.ok(result.reasons.includes('upstream-assembled-content-missing'));
});

test('read-only negative tasks expose scope without overriding the original response format',async()=>{
  const file=path.join(fixtureRoot,'case-0.json'),original=await readFile(file),input=JSON.parse(original);
  const turn='Improve this sentence and return only the sentence: the button do work.';
  let run;
  try{
    await writeFile(file,JSON.stringify({...input,turns:[turn],allowedChanges:[]}));
    run=await prepare({materialize:true,taskId:'negative-format',runtime,fixtureRoot});roots.push(run.runRoot);
  }finally{await writeFile(file,original);}
  const m=JSON.parse(await readFile(path.join(run.runRoot,'coordinator/manifest.json'),'utf8'));
  const pair=m.rows.filter(r=>r.caseId==='sample-0');assert.equal(pair[0].inputHash,pair[1].inputHash);
  for(const row of pair){
    const task=await readFile(path.join(run.runRoot,row.context,'TASK.md'),'utf8');
    assert.ok(task.includes('exact workspace-relative paths: []'));
    assert.ok(task.endsWith(turn+'\n'));assert.equal(row.grader.allowedChanges.length,0);
    assert.match(task,/original user turn's response format; when that format permits, report observed checks/);
    assert.doesNotMatch(task,/expectedSkills|public-output|sample-0/);
  }
});

test('too many turns are rejected before materialization',async()=>{
  const file=path.join(fixtureRoot,'case-0.json'),original=await readFile(file),input=JSON.parse(original);
  try{
    await writeFile(file,JSON.stringify({...input,turns:Array.from({length:101},()=>'hi')}));
    await assert.rejects(prepare({materialize:true,taskId:'many-turns',runtime,fixtureRoot}),/invalid-turns/);
  }finally{await writeFile(file,original);}
});

test('manual semantic cases need explicit observed evidence and cannot override a failed executable probe',async()=>{
  const file=path.join(fixtureRoot,'check-output.mjs'),original=await readFile(file);
  await writeFile(file,"export async function checkOutput(){ return {passed:null,code:'manual-semantic-observation-required'}; }\n");
  const run=await prepare({materialize:true,taskId:'semantic-evidence',runtime,fixtureRoot});roots.push(run.runRoot);
  await writeFile(file,original);
  const m=JSON.parse(await readFile(path.join(run.runRoot,'coordinator/manifest.json'),'utf8'));
  const collector=await import(pathToFileURL(run.collector).href);
  const first=m.rows[0],second=m.rows[1];
  const unknown=await collector.collect({runRoot:run.runRoot,executionId:first.executionId,report:report(first),observation:observation(first)});
  assert.equal(unknown.pass,null);
  const observed=await collector.collect({runRoot:run.runRoot,executionId:second.executionId,report:report(second),
    observation:observation(second,{behavior:{passed:true,evidence:'Synthetic final output independently checked against the literal criterion.'}})});
  assert.equal(observed.pass,true);assert.match(observed.behaviorEvidence,/independently checked/);
});

test('description variant changes only the chosen description and preserves protected policy and body bytes',async()=>{
  const suitePath=path.join(fixtureRoot,'manifest.json'),saved=await readFile(suitePath),suite=JSON.parse(saved);
  suite.cases[1].expectedSkills=[];suite.cases[1].invocation='none';suite.cases[1].workflowId='none';
  suite.variants=[{id:'analyze-description',owner:'aif-analyze',type:'description',caseIds:suite.cases.map(c=>c.id),
    interventions:[{path:'skills/aif-analyze/SKILL.md',selector:'frontmatter:description',candidate:'description.txt'}]}];
  const description=await readFile(new URL('../test/fixtures/superpowers-skill-eval/variants/analyze-description.txt',import.meta.url),'utf8');
  await writeFile(path.join(fixtureRoot,'description.txt'),description);await writeFile(suitePath,JSON.stringify(suite));
  let run;
  try{run=await prepare({materialize:true,taskId:'description-only',runtime,fixtureRoot});roots.push(run.runRoot);}
  finally{await writeFile(suitePath,saved);}
  const m=JSON.parse(await readFile(path.join(run.runRoot,'coordinator/manifest.json'),'utf8'));
  const [base,current]=['baseline','current'].map(arm=>m.rows.find(r=>r.arm===arm));
  const read=async row=>readFile(path.join(run.runRoot,row.context,'instructions/skills/aif-analyze/SKILL.md'),'utf8');
  const before=await read(base),after=await read(current);
  assert.notEqual(before,after);
  assert.equal(before.replace(/^description: .*$/m,'description: <same>'),after.replace(/^description: .*$/m,'description: <same>'));
  assert.equal(base.inputHash,current.inputHash);assert.notEqual(base.catalogHash,current.catalogHash);
});
test('composition scenarios expose literal current, stale, unsupported and incomplete evidence separately',async()=>{
  const fixtures={};
  for(const kind of ['supported','unsupported','stale','incomplete']) {
    fixtures[kind]=JSON.parse(await readFile(new URL('../test/fixtures/superpowers-skill-eval/composition/review-evidence-'+kind+'.json',import.meta.url),'utf8'));
    assert.deepEqual(fixtures[kind].allowedChanges,[]);
  }
  assert.equal(JSON.parse(fixtures.supported.files['check-evidence.json']).target,'current-v2');
  assert.deepEqual(JSON.parse(fixtures.unsupported.files['check-evidence.json']).checks,[]);
  assert.equal(JSON.parse(fixtures.stale.files['check-evidence.json']).target,'old-v1');
  assert.equal(JSON.parse(fixtures.incomplete.files['check-evidence.json']).checks[0].outcome,null);
});

test('review advice specimens reject a harmful remedy while accepting the compatible correction',async()=>{
  const input=JSON.parse(await readFile(new URL('../test/fixtures/superpowers-skill-eval/review-advice/harmful-remedy.json',import.meta.url),'utf8'));
  const workspace=await mkdtemp(path.join(await realpath(os.tmpdir()),'aifhub-superpowers-review-'));roots.push(workspace);
  for(const[p,b]of Object.entries(input.files)){await mkdir(path.dirname(path.join(workspace,p)),{recursive:true});await writeFile(path.join(workspace,p),b);}
  const check=()=>checkOutput({caseId:'harmful-remedy',kind:'review-advice',workspace,report:{status:'completed'}});
  assert.equal((await check()).passed,false);
  await writeFile(path.join(workspace,'src/identity.mjs'),"export function resolveId(input){ return input && typeof input.id==='string' && input.id.trim() ? input.id : null; }\n");
  assert.equal((await check()).passed,false,'dropping legacy callers is not a fix');
  await writeFile(path.join(workspace,'src/identity.mjs'),"export function resolveId(input){const id=typeof input==='string'?input:input?.id;return typeof id==='string'&&id.trim()?id:null;}\n");
  assert.equal((await check()).passed,true);
  await writeFile(path.join(workspace,'qa/remaining.json'),'{"finding":"IDENTITY-1","status":"resolved","owner":"fixer"}\n');
  assert.equal((await check()).passed,false,'fixer cannot clear reviewer ownership');
});

test('false, stale and disputed advice fixtures preserve code and the authoritative blocker',async()=>{
  for(const name of ['false-premise','stale-target','disputed-blocker']) {
    const input=JSON.parse(await readFile(new URL('../test/fixtures/superpowers-skill-eval/review-advice/'+name+'.json',import.meta.url),'utf8'));
    assert.deepEqual(input.allowedChanges,[]);
    const workspace=await mkdtemp(path.join(await realpath(os.tmpdir()),'aifhub-superpowers-dispute-'));roots.push(workspace);
    for(const[p,b]of Object.entries(input.files)){await mkdir(path.dirname(path.join(workspace,p)),{recursive:true});await writeFile(path.join(workspace,p),b);}
    assert.equal((await checkOutput({caseId:name,workspace,report:{status:name==='disputed-blocker'?'incomplete':'completed'}})).passed,true);
  }
});

test('boundary variant replaces the H3 load trigger without capturing adjacent injection sections',async()=>{
 const p=path.join(fixtureRoot,'manifest.json'),saved=await readFile(p),suite=JSON.parse(saved);
 suite.sourcePaths.push('injections/core/aif-fix-plan-folder.md');
 suite.variants=[{...structuredClone(registered.variants.find(v=>v.id==='boundary-tracing')),caseIds:suite.cases.map(c=>c.id)}];
 for(const intervention of suite.variants[0].interventions) {
  const target=path.join(fixtureRoot,intervention.candidate);
  await mkdir(path.dirname(target),{recursive:true});
  await writeFile(target,await readFile(new URL('../test/fixtures/superpowers-skill-eval/'+intervention.candidate,import.meta.url)));
 }
 await writeFile(p,JSON.stringify(suite));let run;
 try{run=await prepare({materialize:true,taskId:'boundary-variant',runtime,fixtureRoot});roots.push(run.runRoot);}
 finally{await writeFile(p,saved);}
 const m=JSON.parse(await readFile(path.join(run.runRoot,'coordinator/manifest.json'),'utf8'));
 const [base,current]=['baseline','current'].map(arm=>m.rows.find(r=>r.arm===arm));
 const read=async row=>readFile(path.join(run.runRoot,row.context,'instructions/injections/core/aif-fix-plan-folder.md'),'utf8');
 const before=await read(base),after=await read(current);
 const strip=text=>text.replace(/### Difficult reproductions\r?\n[\s\S]*?(?=\r?\n### |\r?\n## |$)/,'').replace(/\r/g,'');
 assert.equal(strip(before),strip(after));
 assert.ok(after.includes('crosses component boundaries even with a fast reproduction'));
 assert.ok(!after.includes('Assess the defect claim separately from the suggested remedy'),'review variant must not leak into boundary experiment');
});

test('append-section rejects a pre-existing heading at any level, not just H2',async()=>{
  const p=path.join(fixtureRoot,'manifest.json'),saved=await readFile(p),suite=JSON.parse(saved);
  suite.sourcePaths=['injections/core/aif-fix-plan-folder.md'];
  suite.variants=[{id:'dup-heading',owner:'aif-fix',type:'recipe',
    interventions:[{path:'injections/core/aif-fix-plan-folder.md',selector:'append-section:Difficult reproductions',candidate:'dup-heading.md'}],
    caseIds:suite.cases.map(c=>c.id)}];
  const target=path.join(fixtureRoot,'dup-heading.md');
  await writeFile(target,'## Difficult reproductions\n\nNew content.\n');
  await writeFile(p,JSON.stringify(suite));
  try{await prepare({materialize:true,taskId:'dup-heading',runtime,fixtureRoot});assert.fail('must reject duplicate heading');}
  catch(e){assert.match(e.message,/existing-append-section/);}
  finally{await writeFile(p,saved);await rm(target,{force:true});}
});

test('comparison exposes paired regressions even when aggregate pass counts improve',async()=>{
 const run=await prepare({materialize:true,taskId:'paired-regression',runtime,fixtureRoot});roots.push(run.runRoot);
 const m=JSON.parse(await readFile(path.join(run.runRoot,'coordinator/manifest.json'),'utf8'));
 const collector=await import(pathToFileURL(run.collector).href);
 for(const row of m.rows) {
  const bad=(['sample-0','sample-1'].includes(row.caseId)&&row.arm==='baseline')||(row.caseId==='sample-2'&&row.arm==='current');
  const o=observation(row);if(bad)o.requirements['public-output']={met:false,evidence:'Deliberately incorrect fixture output'};
  await collector.collect({runRoot:run.runRoot,executionId:row.executionId,report:report(row),observation:o});
 }
 const result=await collector.compare({runRoot:run.runRoot}),variant=result.variants[0];
 assert.deepEqual(variant.passed,{baseline:5,current:6});
 assert.equal(variant.outcome,'mixed');assert.equal(variant.promotionEligible,false);
 assert.equal(variant.paired.improved,2);assert.equal(variant.paired.regressed,1);
 assert.ok(variant.regressions.some(r=>r.caseId==='sample-2'&&r.criteria.includes('public-output')));
});
