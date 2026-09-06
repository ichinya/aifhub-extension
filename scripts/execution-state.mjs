import { randomUUID } from 'node:crypto';
import { maskMarkdownCode } from './markdown-structural-markers.mjs';
import { parseWorkItemSourceBinding } from './active-change-resolver.mjs';
import { assertAuxiliaryPaths, executionId, parseExecutionTasks, resolveExecutionSource, selectExecutionTask, validateExecutionScope } from './execution-task-source.mjs';
import { RUN_SCHEMA, LEDGER_SCHEMA, SOURCE_SCHEMA, manifestRecord, overlap, progressRecord, resultPayload, validateRun, validateLedger } from './execution-records.mjs';
import { catalogue, folderFor, history, pendingTransactions, publish, readTransaction, reserves, validateHistoricalRun } from './execution-transactions.mjs';
import { boundedText, canonical, changedFiles, cliMain, digest, fields, identifier, requireValue, storeFor, stringList, worktree } from './workflow-state-store.mjs';

const common=['change_id','run_id'], mutation=[...common,'actor','version'];
const contracts={
  start:[[...common,'task_id','owner','worker','role','scope'],['context_paths']],
  'batch-start':[[...common,'owner','worker','role','manifest','preflight_paths'],['context_paths']],
  resume:[common,[]], inspect:[['change_id'],['run_id']],
  checkpoint:[[...mutation,'progress'],[]], result:[[...mutation,'result'],[]], accept:[[...mutation,'result_digest'],[]],
  'batch-seal':[[...mutation,'evidence'],[]],
  'batch-result':[[...mutation,'task_id','seal_digest','result'],[]],
  'batch-accept':[[...mutation,'task_id','seal_digest','result_digest'],[]],
  'batch-close':[[...mutation,'seal_digest'],[]],
  interrupt:[[...mutation,'recovery_id','reason','execution_state'],['evidence']],
  'stop-confirm':[[...mutation,'recovery_id','confirmation_id','evidence'],[]],
  upgrade:[['change_id','actor','upgrade_id','predecessor_inventory_digest'],[]],
  'attempt-begin':[[...mutation,'finding_id','hypothesis','check','environment_revision','input_paths'],[]],
  'attempt-check':[[...mutation,'finding_id','hypothesis','check','environment_revision','input_paths'],[]],
  'attempt-finish':[[...mutation,'attempt_id','outcome','evidence'],[]],
};
const now=()=>new Date().toISOString();
const same=(a,b)=>canonical(a)===canonical(b);
const sourceRecord=s=>({...s.namespace,namespace_digest:s.namespace_digest});
const refs=(store,paths)=>store.references(assertAuxiliaryPaths(paths));
function actor(run,input,owner=false,version=true) {
  requireValue(input.actor===(owner?run.owner:run.worker),'actor-mismatch',true);
  if(version)requireValue(Number.isSafeInteger(input.version) && input.version===run.version,'version-conflict',true);
}
function scopeDiff(run,snapshot) {
  const changed=changedFiles(run.initial_worktree,snapshot);
  requireValue(changed.every(p=>run.scope.some(s=>p===s || (run.kind!=='batch' && p.startsWith(s+'/')))),'outside-scope',true);
  return changed;
}
async function current(store,run) {
  requireValue(run.schema===RUN_SCHEMA && !run.legacy,'upgrade-required',true);
  const source=await resolveExecutionSource(store,run.change_id,run.role,run.context_paths);
  requireValue(!source.delegated && source.namespace_digest===run.source.namespace_digest,'stale-source',true);
  requireValue(source.context.digest===run.context.digest,'stale-context',true);
  const snapshot=await worktree(store,run.scope,source.projections);
  requireValue(snapshot.head===run.initial_worktree.head && snapshot.branch===run.initial_worktree.branch && snapshot.index===run.initial_worktree.index,'stale-revision',true);
  scopeDiff(run,snapshot);
  if(run.kind==='batch')requireValue(same(await refs(store,Object.keys(run.preflight)),run.preflight),'stale-preflight',true);
  return snapshot;
}
async function freshResult(store,run,snapshot) {
  requireValue(same(snapshot,run.checkpoint.worktree),'stale-result',true);
  if(run.result)requireValue(same(await refs(store,run.result.evidence),run.result.evidence_digests),'stale-evidence',true);
}
async function freshSeal(store,run,snapshot) {
  requireValue(run.seal && same(snapshot,run.seal.worktree),'stale-seal',true);
  for(const evidence of Object.values(run.seal.evidence))requireValue(same(await refs(store,Object.keys(evidence)),evidence),'stale-evidence',true);
}
function view(run) {
  const base={schema:run.schema,change_id:run.change_id,run_id:run.run_id,task_id:run.task_id,kind:run.kind??'single',
    owner:run.owner,worker:run.worker,role:run.role,status:run.status,version:run.version,
    lifecycle:run.lifecycle??(reserves(run)?'active':'closed'),execution_state:run.execution_state??'unknown',
    base_revision:run.initial_worktree.head,context_digest:run.context.digest,checkpoint_digest:digest(run.checkpoint.worktree),
    scope:run.scope,progress:run.checkpoint.progress,result:run.result??null,accepted_by:run.accepted_by??null,source:run.source??null};
  if(run.kind==='batch')Object.assign(base,{items:run.items,seal_digest:run.seal?.digest??null,closure:run.closure??null});
  if(run.recovery)Object.assign(base,{recovery_id:run.recovery.recovery_id,pending_attempts:run.recovery.pending_attempts,drift:run.recovery.drift});
  return base;
}
function receipt(run,action,input,key,extra={}) {
  const output={schema:RUN_SCHEMA,change_id:run.change_id,run_id:run.run_id,kind:run.kind,lifecycle:run.lifecycle,execution_state:run.execution_state,version:run.version,...extra};
  output.receipt_digest=digest(output);
  run.receipts[key]={action,input_digest:digest(input),submitted_version:input.version,output}; return output;
}
function replay(run,action,input,key) {
  const record=run.receipts?.[key]; if(!record)return null;
  requireValue(record.action===action && record.input_digest===digest(input),action.endsWith('result')?'conflicting-result':'conflicting-replay',true);
  return {...record.output,replay:true};
}
function advance(run) { run.version++; run.updated_at=now(); }
async function saveRun(store,filename,run) { await validateHistoricalRun(store,run); await store.save(filename,run); }
function resultEnvelope(run,task,payload,snapshot,evidence) {
  const value={...payload,change_id:run.change_id,task_id:task,run_id:run.run_id,base_revision:snapshot.head,
    context_digest:run.context.digest,worktree_digest:digest(snapshot),evidence_digests:evidence,payload_digest:digest(payload),submitted_version:run.version};
  return {...value,digest:digest(value)};
}
function transactionId(action,input) { return digest(`${action}:${input.run_id??''}:${input.recovery_id??input.upgrade_id??''}`).slice(0,64); }

/** Local cooperative bookkeeping. Actor labels are correlation, not authentication. */
export async function executionCommand(action,input,options={}) {
  requireValue(Object.hasOwn(contracts,action),'unknown-action'); fields(input,...contracts[action]);
  const change=executionId(input.change_id), id=input.run_id===undefined?null:identifier(input.run_id);
  const store=await storeFor(options.rootDir), folder=folderFor(change), filename=id?`${folder}/runs/${id}.json`:null;
  const starting=['start','batch-start'].includes(action), readOnly=['inspect','resume','attempt-check'].includes(action);
  // Prepared admission is historical intent; worker resume still checks freshness.
  const prepared=starting?await readTransaction(store,folder,transactionId(action,input)):null;
  let preflight;
  if(starting && prepared?.state!=='prepared') {
    identifier(input.owner); identifier(input.worker);
    const extra=assertAuxiliaryPaths(stringList(input.context_paths??[])).slice().sort();
    const source=await resolveExecutionSource(store,change,input.role,extra);
    if(source.delegated)return source;
    let scope,preflightRefs=null;
    if(action==='batch-start') {
      requireValue(input.role==='implement','batch-implement-required'); manifestRecord(input.manifest);
      for(const item of input.manifest) { selectExecutionTask(source,item.task_id,input.role,extra); await validateExecutionScope(store,item.files,source,true); }
      scope=input.manifest.flatMap(item=>item.files).sort();
      requireValue(stringList(input.preflight_paths).length>0,'missing-preflight'); preflightRefs=await refs(store,input.preflight_paths);
    } else { identifier(input.task_id); selectExecutionTask(source,input.task_id,input.role,extra); scope=await validateExecutionScope(store,input.scope,source); }
    preflight={source,scope,extra,refs:preflightRefs};
  }
  async function execute() {
    const pending=await pendingTransactions(store), txId=transactionId(action,input);
    if(action!=='inspect' && pending.length) {
      requireValue(!readOnly && pending.length===1 && pending[0].folder===folder && pending[0].tx.id===txId && pending[0].tx.action===action && pending[0].tx.input_digest===digest(input),'pending-transaction',true);
      return publish(store,folder,txId,action,input,[],null,options);
    }
    const h=await history(store,change); let run=id?h.runs.find(r=>r.run_id===id):null;
    if(action==='inspect') {
      if(id) {
        requireValue(run,'missing-or-invalid-run');
        return {schema:run.schema,change_id:change,run_id:id,kind:run.kind??'single',version:run.version,status:run.status,
          lifecycle:run.lifecycle??(reserves(run)?'active':'closed'),execution_state:run.execution_state??'unknown',
          context_digest:run.context.digest,checkpoint_digest:digest(run.checkpoint.worktree),record_digest:digest(run),
          pending_attempts:(h.ledger?.attempts??[]).filter(a=>a.run_id===id && a.outcome==='pending').map(a=>a.attempt_id),
          recovery_id:run.recovery?.recovery_id??null,pending_transactions:pending.filter(p=>p.folder===folder).map(p=>p.tx.id),historical:true};
      }
      return {change_id:change,predecessor_inventory_digest:h.inventory_digest,runs:h.runs.length,attempts:h.ledger?.attempts.length??0,
        reserved:h.runs.filter(reserves).length,legacy_runs:h.runs.filter(r=>r.schema!==RUN_SCHEMA || r.legacy).length,
        pending_transactions:pending.filter(p=>p.folder===folder).map(p=>p.tx.id),historical:true};
    }
    if(action==='upgrade')return upgrade(store,folder,h,input,options);
    if(starting) {
      requireValue(!run,'run-exists',true);
      requireValue(h.runs.every(r=>r.schema===RUN_SCHEMA && !r.legacy) && (!h.ledger || h.ledger.schema===LEDGER_SCHEMA),'upgrade-required',true);
      if(h.source)requireValue(same(h.source.source,sourceRecord(preflight.source)),'state-source-collision',true);
      const all=await catalogue(store); requireValue(all.length<1000,'execution-catalogue-full',true);
      requireValue(!all.some(r=>reserves(r) && r.scope.some(a=>preflight.scope.some(b=>overlap(a,b)))),'scope-reserved',true);
      const selected=await resolveExecutionSource(store,change,input.role,preflight.extra);
      requireValue(!selected.delegated && same(sourceRecord(selected),sourceRecord(preflight.source)) && selected.context.digest===preflight.source.context.digest,'stale-admission',true);
      await validateExecutionScope(store,preflight.scope,selected,action==='batch-start');
      if(preflight.refs)requireValue(same(await refs(store,input.preflight_paths),preflight.refs),'stale-preflight',true);
      const snapshot=await worktree(store,preflight.scope,selected.projections), timestamp=now();
      const finalSource=await resolveExecutionSource(store,change,input.role,preflight.extra);
      requireValue(!finalSource.delegated && finalSource.context.digest===selected.context.digest && finalSource.namespace_digest===selected.namespace_digest,'stale-admission',true);
      run={schema:RUN_SCHEMA,kind:action==='start'?'single':'batch',change_id:change,run_id:id,task_id:input.task_id??null,
        owner:input.owner,worker:input.worker,role:input.role,scope:preflight.scope,context_paths:preflight.extra,
        version:1,status:'started',lifecycle:'active',execution_state:'running',source:sourceRecord(selected),context:selected.context,
        initial_worktree:snapshot,checkpoint:{worktree:snapshot,progress:{completed_steps:[],next_step:'Execute the assigned task.'}},
        receipts:{},created_at:timestamp,updated_at:timestamp};
      if(run.kind==='batch')Object.assign(run,{manifest:structuredClone(input.manifest),preflight:preflight.refs,items:Object.fromEntries(input.manifest.map(i=>[i.task_id,{}]))});
      validateRun(run); const writes=[];
      if(!h.source)writes.push([`${folder}/source.json`,{schema:SOURCE_SCHEMA,source:run.source}]);
      if(!h.ledger)writes.push([`${folder}/fix-attempts.json`,{schema:LEDGER_SCHEMA,attempts:[],aliases:[]}]);
      writes.push([filename,run]); return publish(store,folder,txId,action,input,writes,view(run),options);
    }
    requireValue(run,'missing-or-invalid-run');
    if(action==='interrupt')return interrupt(store,folder,filename,h,run,input,options);
    if(action==='stop-confirm')return stopConfirm(store,filename,run,input);
    requireValue(run.schema===RUN_SCHEMA && !run.legacy,'upgrade-required',true);
    if(action==='resume') {
      requireValue(run.lifecycle!=='interrupted','run-interrupted',true);
      const snapshot=await current(store,run); requireValue(same(snapshot,run.checkpoint.worktree),'stale-checkpoint',true);
      if(run.seal)await freshSeal(store,run,snapshot); else await freshResult(store,run,snapshot);
      return {...view(run),resumable:run.lifecycle==='active' && run.status==='started'};
    }
    const owner=['accept','batch-accept','batch-close'].includes(action); actor(run,input,owner,false);
    requireValue(action.startsWith('batch-')?run.kind==='batch':(action==='checkpoint'||run.kind==='single'),'wrong-run-kind');
    if(input.task_id!==undefined)requireValue(run.items && Object.hasOwn(run.items,input.task_id),'unknown-or-ambiguous-task');
    if(input.seal_digest!==undefined)requireValue(input.seal_digest===run.seal?.digest,'seal-mismatch',true);
    const key=action+(input.task_id?':'+input.task_id:'');
    if(action==='batch-close') { const old=replay(run,action,input,key); if(old)return {...old,historical:true}; }
    requireValue(run.lifecycle!=='interrupted','run-interrupted',true);
    const old=replay(run,action,input,key);
    if(old) { const snapshot=await current(store,run); if(run.kind==='batch')await freshSeal(store,run,snapshot); else await freshResult(store,run,snapshot); return old; }
    actor(run,input,owner); requireValue(run.lifecycle!=='closed','run-terminal',true);
    const snapshot=await current(store,run);
    if(action==='checkpoint') {
      requireValue(run.lifecycle==='active' && run.status==='started','run-terminal',true);
      run.checkpoint={worktree:snapshot,progress:progressRecord(input.progress)}; advance(run); await saveRun(store,filename,run); return view(run);
    }
    if(action.startsWith('attempt-')) {
      requireValue(run.kind==='single' && run.role==='fix' && run.status==='started' && run.lifecycle==='active','fix-run-required');
      return attempt(store,folder,run,snapshot,h.ledger,action,input);
    }
    let extra={};
    if(action==='result') {
      requireValue(run.status==='started','run-terminal',true);
      requireValue(!h.ledger.attempts.some(a=>a.run_id===id && a.outcome==='pending'),'pending-attempt',true);
      const payload=resultPayload(input.result); requireValue(same(payload.changed_files,scopeDiff(run,snapshot)),'changed-files-mismatch',true);
      run.result=resultEnvelope(run,run.task_id,payload,snapshot,await refs(store,payload.evidence)); run.status=payload.status; run.checkpoint.worktree=snapshot;
      extra={result_digest:run.result.digest};
    } else if(action==='accept') {
      requireValue(run.status==='completed' && run.result,'result-not-completed',true);
      requireValue(input.result_digest===run.result.digest,'result-mismatch',true); await freshResult(store,run,snapshot);
      run.status='accepted'; run.accepted_by=input.actor; run.lifecycle='closed'; run.execution_state='stopped'; extra={result_digest:run.result.digest};
    } else if(action==='batch-seal') {
      requireValue(run.lifecycle==='active','run-terminal',true);
      requireValue(same(snapshot,run.checkpoint.worktree),'stale-checkpoint',true);
      fields(input.evidence,run.manifest.map(i=>i.task_id));
      const evidence=Object.create(null); for(const item of run.manifest)evidence[item.task_id]=await refs(store,input.evidence[item.task_id]);
      const seal={worktree:snapshot,evidence}; run.seal={...seal,digest:digest(seal)}; run.lifecycle='sealed'; run.checkpoint.worktree=snapshot; extra={seal_digest:run.seal.digest};
    } else {
      requireValue(run.lifecycle==='sealed','batch-not-sealed',true); await freshSeal(store,run,snapshot); extra={seal_digest:run.seal.digest};
      if(action==='batch-result') {
        const item=run.items[input.task_id],manifest=run.manifest.find(i=>i.task_id===input.task_id); requireValue(!item.result,'conflicting-result',true);
        const payload=resultPayload(input.result),changes=scopeDiff(run,snapshot).filter(p=>manifest.files.includes(p));
        requireValue(same(payload.changed_files,changes),'changed-files-mismatch',true);
        requireValue(same(payload.evidence,Object.keys(run.seal.evidence[input.task_id]).sort()),'sealed-evidence-mismatch',true);
        item.result=resultEnvelope(run,input.task_id,payload,snapshot,run.seal.evidence[input.task_id]); extra={...extra,task_id:input.task_id,result_digest:item.result.digest};
      } else if(action==='batch-accept') {
        const item=run.items[input.task_id]; requireValue(item.result?.status==='completed' && !item.accepted,'result-not-completed',true);
        requireValue(input.result_digest===item.result.digest,'result-mismatch',true); item.accepted=true; extra={...extra,task_id:input.task_id,result_digest:item.result.digest};
      } else if(action==='batch-close') {
        const accepted=Object.keys(run.items).filter(k=>run.items[k].accepted).sort(),unfinished=Object.keys(run.items).filter(k=>!run.items[k].accepted).sort();
        run.closure={accepted,unfinished,context_digest:run.context.digest,worktree_digest:digest(snapshot),seal_digest:run.seal.digest};
        run.lifecycle='closed'; run.execution_state='stopped'; extra={...extra,accepted,unfinished};
      }
    }
    advance(run); const output=receipt(run,action,input,key,extra); await saveRun(store,filename,run); return {...view(run),...output};
  }
  if(readOnly)return execute();
  await options.beforeLock?.();
  // Fixed lock order. An orphan is never reclaimed using age or a PID guess.
  return store.lock('.ai-factory/state/execution-write.lock',()=>store.lock(`${folder}/write.lock`,execute));
}

async function drift(store,run) {
  const changed=[]; let source;
  try { source=await resolveExecutionSource(store,run.change_id,run.role,run.context_paths);
    if(source.delegated || source.namespace_digest!==run.source?.namespace_digest)changed.push('source');
    if(source.context?.digest!==run.context.digest)changed.push('context');
  } catch { changed.push('source-unavailable'); }
  try { const snapshot=await worktree(store,run.scope,source?.projections);
    if(snapshot.head!==run.initial_worktree.head || snapshot.index!==run.initial_worktree.index || snapshot.branch!==run.initial_worktree.branch)changed.push('revision');
    if(!same(snapshot,run.checkpoint.worktree))changed.push('worktree');
    if(run.seal)await freshSeal(store,run,snapshot); else await freshResult(store,run,snapshot);
  } catch { changed.push('evidence'); }
  return [...new Set(changed)];
}
async function legacySource(store,run) {
  const change=run.change_id,entrypoint=`openspec/changes/${change}/proposal.md`;let binding=null;
  try { const text=await store.textFile(entrypoint),stored=run.context.sources[`openspec/changes/${change}`]?.[entrypoint];
    if(text!==null && digest(text)===stored) { const parsed=parseWorkItemSourceBinding(text);if(parsed.ok)binding=parsed.binding; }
  } catch { /* Unknown legacy binding stays unresolved; recovery still preserves the original hashes. */ }
  const namespace={kind:'openspec',id:change,entrypoint,checklist:`openspec/changes/${change}/tasks.md`,binding};
  return {...namespace,namespace_digest:digest(namespace)};
}
function successor(run,source) {
  if(run.schema===RUN_SCHEMA)return structuredClone(run);
  const timestamp=now();
  return {...structuredClone(run),schema:RUN_SCHEMA,kind:'single',lifecycle:reserves(run)?'active':'closed',execution_state:'unknown',source,
    receipts:{},created_at:timestamp,updated_at:timestamp,legacy:{predecessor_digest:digest(run)}};
}
async function interrupt(store,folder,filename,h,original,input,options) {
  actor(original,input,true,false); identifier(input.recovery_id);
  const old=replay(original,'interrupt',input,'interrupt'); if(old)return {...old,historical:true};
  actor(original,input,true);
  requireValue(['cancelled','timed_out','abandoned'].includes(input.reason) && ['stopped','running','unknown'].includes(input.execution_state),'invalid-recovery');
  requireValue(original.lifecycle!=='closed' && original.lifecycle!=='interrupted' && original.status!=='accepted','run-terminal',true);
  const evidence=await refs(store,input.evidence??[]); requireValue(input.execution_state!=='stopped' || Object.keys(evidence).length>0,'missing-stop-evidence');
  const run=successor(original,h.source?.source??await legacySource(store,original)),ledger=structuredClone(h.ledger??{schema:'aifhub.fix-attempts.v1',attempts:[]});
  const pending=ledger.attempts.filter(a=>a.run_id===run.run_id && a.outcome==='pending');
  for(const a of pending) { a.outcome='interrupted'; a.recovery_id=input.recovery_id; }
  run.recovery={recovery_id:input.recovery_id,reason:input.reason,execution_state:input.execution_state,evidence,
    pending_attempts:pending.map(a=>a.attempt_id),drift:await drift(store,original),interrupted_at:now()};
  run.lifecycle='interrupted'; run.execution_state=input.execution_state; advance(run);
  const output=receipt(run,'interrupt',input,'interrupt',{recovery_id:input.recovery_id}); await validateHistoricalRun(store,run,original); validateLedger(ledger);
  const writes=[]; if(!h.source)writes.push([`${folder}/source.json`,{schema:SOURCE_SCHEMA,source:run.source}]);
  writes.push([`${folder}/fix-attempts.json`,ledger],[filename,run]);
  return publish(store,folder,transactionId('interrupt',input),'interrupt',input,writes,output,options);
}
async function stopConfirm(store,filename,run,input) {
  actor(run,input,true,false); identifier(input.recovery_id); identifier(input.confirmation_id);
  const old=replay(run,'stop-confirm',input,'stop-confirm'); if(old)return {...old,historical:true};
  actor(run,input,true);
  requireValue(run.lifecycle==='interrupted' && run.recovery.recovery_id===input.recovery_id && run.execution_state!=='stopped','invalid-stop-confirmation',true);
  const evidence=await refs(store,input.evidence); requireValue(Object.keys(evidence).length>0,'missing-stop-evidence');
  run.confirmation={confirmation_id:input.confirmation_id,recovery_id:input.recovery_id,evidence}; run.execution_state='stopped'; advance(run);
  const output=receipt(run,'stop-confirm',input,'stop-confirm',{recovery_id:input.recovery_id,confirmation_id:input.confirmation_id});
  await saveRun(store,filename,run); return output;
}
async function attempt(store,folder,run,snapshot,original,action,input) {
  const ledger=structuredClone(original); requireValue(ledger?.schema===LEDGER_SCHEMA,'upgrade-required',true);
  if(['attempt-begin','attempt-check'].includes(action)) {
    identifier(input.finding_id); boundedText(input.hypothesis); boundedText(input.check,500); boundedText(input.environment_revision,500);
    const inputs=await refs(store,input.input_paths),environment=digest(input.environment_revision);
    const identity={task_id:run.task_id,finding_id:input.finding_id,context:run.context.digest,check:input.check,environment,inputs};
    const fingerprint=digest({...identity,worktree:digest(snapshot)}),{check,...budgetIdentity}=identity,budget=digest(budgetIdentity);
    const identities=[identity];
    for(const alias of ledger.aliases??[]) if(alias.task_id===run.task_id && alias.source_digest===run.source.namespace_digest) {
      const observed=Object.create(null); for(const root of Object.keys(alias.authoritative_sources))observed[root]=await store.inventory(root);
      if(same(observed,alias.authoritative_sources))identities.push({...identity,task_id:alias.old_task_id,context:alias.old_context});
    }
    const budgets=new Set(identities.map(({check,...rest})=>digest(rest))),fingerprints=new Set(identities.map(i=>digest({...i,worktree:digest(snapshot)})));
    const relevant=ledger.attempts.filter(a=>budgets.has(a.budget));
    const failures=relevant.filter(a=>a.outcome==='failed').length,interruptions=relevant.filter(a=>a.outcome==='interrupted').length;
    const pending=ledger.attempts.some(a=>a.run_id===run.run_id && a.outcome==='pending');
    requireValue(failures<3,'attempt-budget-exhausted',true); requireValue(interruptions<3,'interruption-budget-exhausted',true);
    if(action==='attempt-check')return {ready_for_hypothesis:!pending,failed_hypotheses:failures,interrupted_attempts:interruptions,remaining:3-failures,interruptions_remaining:3-interruptions,pending_attempt:pending,post_edit_fingerprint_checked:false};
    requireValue(!ledger.attempts.some(a=>fingerprints.has(a.fingerprint) && ['pending','failed','blocked','interrupted'].includes(a.outcome)),'no-progress',true);
    requireValue(!pending,'pending-attempt',true);
    requireValue(ledger.attempts.length<1000,'attempt-ledger-full',true);
    const entry={attempt_id:randomUUID(),run_id:run.run_id,worker:run.worker,fingerprint,budget,identity,hypothesis:input.hypothesis,worktree_digest:digest(snapshot),outcome:'pending'};
    ledger.attempts.push(entry); validateLedger(ledger); await store.save(`${folder}/fix-attempts.json`,ledger);
    return {attempt_id:entry.attempt_id,outcome:entry.outcome,fingerprint};
  }
  identifier(input.attempt_id); requireValue(['passed','failed','blocked'].includes(input.outcome));
  const entry=ledger.attempts.find(a=>a.attempt_id===input.attempt_id); requireValue(entry && entry.run_id===run.run_id && entry.worker===input.actor,'unknown-attempt');
  const evidence=await refs(store,input.evidence); requireValue(Object.keys(evidence).length>0,'missing-result-evidence');
  requireValue(entry.worktree_digest===digest(snapshot) && same(entry.identity.inputs,await refs(store,Object.keys(entry.identity.inputs))),'stale-attempt',true);
  if(entry.outcome!=='pending') { requireValue(entry.outcome===input.outcome && same(entry.evidence,evidence),'conflicting-attempt-result',true); return {attempt_id:entry.attempt_id,outcome:entry.outcome,replay:true}; }
  entry.outcome=input.outcome; entry.evidence=evidence; validateLedger(ledger); await store.save(`${folder}/fix-attempts.json`,ledger);
  return {attempt_id:entry.attempt_id,outcome:entry.outcome};
}

// Prove the old parser's ordinal correspondence from bytes whose saved hash matches.
async function legacyMapping(store,run,source) {
  const filename=`openspec/changes/${run.change_id}/tasks.md`,text=await store.textFile(filename);
  const stored=run.context.sources[`openspec/changes/${run.change_id}`]?.[filename];
  requireValue(text!==null && digest(text)===stored && source.kind==='openspec' && source.checklist===filename,'ambiguous-legacy-source',true);
  const proposal=`openspec/changes/${run.change_id}/proposal.md`,proposalText=await store.textFile(proposal);
  requireValue(proposalText!==null && digest(proposalText)===run.context.sources[`openspec/changes/${run.change_id}`]?.[proposal],'ambiguous-legacy-source',true);
  const lines=text.split(/\r\n|\n|\r/),visible=maskMarkdownCode(text).split('\n'),old=[]; let ordinal=0;
  for(let i=0;i<lines.length;i++) if(/^\s*-\s+\[[ xX]\]\s+/.test(visible[i])) {
    const match=lines[i].match(/^\s*-\s+\[([ xX])\]\s+(?:(\d+(?:\.\d+)*)\s+)?(.+?)\s*$/);
    if(match) { ordinal++; const parsed=parseExecutionTasks(lines[i].trimStart()); requireValue(parsed.length===1,'ambiguous-legacy-task',true); old.push({old:match[2]??`task-${ordinal}`,task:parsed[0].id.startsWith('task-')?`task-${ordinal}`:parsed[0].id}); }
  }
  requireValue(old.filter(x=>x.old===run.task_id).length===1,'ambiguous-legacy-task',true);
  const mapped=old.find(x=>x.old===run.task_id).task; requireValue(source.tasks.some(t=>t.id===mapped),'ambiguous-legacy-task',true); return mapped;
}
async function upgrade(store,folder,h,input,options) {
  identifier(input.actor); identifier(input.upgrade_id);
  const txId=transactionId('upgrade',input),previous=await readTransaction(store,folder,txId);
  if(previous) { requireValue(previous.input_digest===digest(input),'transaction-conflict',true); return {...previous.response,replay:true,historical:true}; }
  requireValue(h.inventory_digest===input.predecessor_inventory_digest,'predecessor-inventory-conflict',true);
  requireValue(h.runs.length>0 && h.runs.every(r=>r.owner===input.actor),'actor-mismatch',true);
  requireValue(h.runs.every(r=>!reserves(r)) && !(h.ledger?.attempts??[]).some(a=>a.outcome==='pending'),'predecessor-not-quiescent',true);
  requireValue(h.runs.some(r=>r.schema==='aifhub.execution.v1'||r.legacy) || h.ledger?.schema==='aifhub.fix-attempts.v1','upgrade-not-required',true);
  const source=await resolveExecutionSource(store,input.change_id,'fix',[]); requireValue(!source.delegated,'ambiguous-legacy-source',true);
  if(h.source)requireValue(same(h.source.source,sourceRecord(source)),'state-source-collision',true);
  const ledger=structuredClone(h.ledger??{schema:'aifhub.fix-attempts.v1',attempts:[]}); ledger.schema=LEDGER_SCHEMA; ledger.aliases??=[];
  const writes=[[`${folder}/source.json`,{schema:SOURCE_SCHEMA,source:sourceRecord(source)}]];
  for(const original of h.runs) {
    if(original.schema===RUN_SCHEMA && !original.legacy)continue;
    const task=await legacyMapping(store,original,source);
    // Keep original result/task/context snapshots historical; aliases affect new attempts only.
    const run=successor(original,sourceRecord(source)); delete run.legacy;
    const alias={old_task_id:original.task_id,task_id:task,old_context:original.context.digest,source_digest:source.namespace_digest,authoritative_sources:structuredClone(original.context.sources)};
    if(!ledger.aliases.some(a=>same(a,alias)))ledger.aliases.push(alias);
    await validateHistoricalRun(store,run,original); writes.push([`${folder}/runs/${run.run_id}.json`,run]);
  }
  validateLedger(ledger); writes.push([`${folder}/fix-attempts.json`,ledger]);
  const response={schema:LEDGER_SCHEMA,change_id:input.change_id,upgrade_id:input.upgrade_id,predecessor_inventory_digest:h.inventory_digest,attempts:ledger.attempts.length,aliases:ledger.aliases.length,historical:true};
  return publish(store,folder,txId,'upgrade',input,writes,response,options);
}

await cliMain(import.meta.url,executionCommand);
