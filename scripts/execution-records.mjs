// Persisted execution records are validated independently of their checksums.
import { boundedText, canonical, changedFiles, digest, fields, identifier, portablePath, requireValue, stringList } from './workflow-state-store.mjs';
import { assertAuxiliaryPaths, executionId } from './execution-task-source.mjs';
import { parseWorkItemSourceBinding } from './active-change-resolver.mjs';

export const RUN_SCHEMA = 'aifhub.execution.v2';
export const LEDGER_SCHEMA = 'aifhub.fix-attempts.v2';
export const SOURCE_SCHEMA = 'aifhub.execution-source.v1';
export const TX_SCHEMA = 'aifhub.execution-transaction.v1';
export const hash = value => requireValue(typeof value === 'string' && /^[a-f0-9]{64}$/.test(value), 'invalid-state');
const integer = n => requireValue(Number.isSafeInteger(n) && n >= 1, 'invalid-state');
const enumeration = (v, values) => requireValue(values.includes(v), 'invalid-state');
const object = v => requireValue(v && typeof v === 'object' && !Array.isArray(v), 'invalid-state');
export function refs(value, nullable = false) {
  object(value); requireValue(Object.keys(value).length <= 20000, 'invalid-state');
  for (const [p, h] of Object.entries(value)) { portablePath(p); if (!(nullable && h === null)) hash(h); }
}
function evidenceRefs(value) { refs(value); assertAuxiliaryPaths(Object.keys(value)); }
export function snapshot(value) {
  fields(value, ['head', 'branch', 'index', 'files']);
  requireValue(typeof value.head === 'string' && /^[a-f0-9]{40,64}$/.test(value.head), 'invalid-state');
  boundedText(value.branch, 300); hash(value.index); refs(value.files, true);
}
export function contextRecord(value) {
  fields(value, ['digest', 'sources']); hash(value.digest); object(value.sources);
  requireValue(Object.keys(value.sources).length <= 120, 'invalid-state');
  for (const [p, entries] of Object.entries(value.sources)) { portablePath(p); refs(entries); }
  requireValue(value.digest === digest(value.sources), 'invalid-state');
}
export function namespace(value) {
  fields(value, ['kind', 'id', 'entrypoint', 'checklist', 'binding', 'namespace_digest']);
  enumeration(value.kind, ['openspec', 'ai-factory-classic']); executionId(value.id);
  portablePath(value.entrypoint); portablePath(value.checklist);
  if (value.binding !== null) {
    fields(value.binding,['provider','primarySource','externalId','normalizedExternalId','branch']);
    for (const [key,v] of Object.entries(value.binding)) if(key!=='branch'||v!==null)boundedText(v,2000);
    const b=value.binding;
    const parsed=parseWorkItemSourceBinding(`## AIFHub Source Binding\n\n- Provider: ${b.provider}\n- Primary source: ${b.primarySource}\n- External ID: ${b.externalId}\n- Branch: ${b.branch??'none'}\n`);
    requireValue(parsed.ok && canonical(parsed.binding)===canonical(b),'invalid-state');
  }
  const { namespace_digest, ...identity } = value;
  requireValue(namespace_digest === digest(identity), 'invalid-state');
}
export function progressRecord(value) {
  fields(value, ['completed_steps', 'next_step'], ['blocker']);
  stringList(value.completed_steps, 40).forEach(x => boundedText(x)); boundedText(value.next_step);
  if (value.blocker !== undefined) boundedText(value.blocker);
  return value;
}
export function resultPayload(input) {
  fields(input, ['result_id', 'status', 'changed_files', 'checks', 'evidence'], ['fallback', 'summary']);
  identifier(input.result_id); enumeration(input.status, ['completed', 'failed', 'blocked', 'cancelled', 'timed_out']);
  stringList(input.changed_files).forEach(portablePath); assertAuxiliaryPaths(input.evidence);
  requireValue(Array.isArray(input.checks) && input.checks.length <= 50);
  for (const check of input.checks) { fields(check, ['name','exit_code']); boundedText(check.name,300); requireValue(Number.isSafeInteger(check.exit_code) && check.exit_code >= 0 && check.exit_code <= 255); }
  if (input.fallback !== undefined) boundedText(input.fallback);
  if (input.summary !== undefined) boundedText(input.summary);
  if (input.status === 'completed') {
    requireValue(input.evidence.length > 0 && (input.checks.length > 0 || input.fallback), 'missing-result-evidence');
    requireValue(input.checks.every(c => c.exit_code === 0), 'failed-completion-check');
  }
  return {...input, changed_files:[...input.changed_files].sort(), evidence:[...input.evidence].sort()};
}
function resultRecord(value, run, task) {
  const extra = ['change_id','task_id','run_id','base_revision','context_digest','worktree_digest','evidence_digests','payload_digest','submitted_version','digest'];
  const payload = Object.fromEntries(Object.entries(value).filter(([k])=>!extra.includes(k)));
  resultPayload(payload);
  requireValue(value.change_id===run.change_id && value.run_id===run.run_id && value.task_id===task && value.base_revision===run.initial_worktree.head && value.context_digest===run.context.digest, 'invalid-state');
  hash(value.worktree_digest); refs(value.evidence_digests); integer(value.submitted_version);
  requireValue(canonical(Object.keys(value.evidence_digests).sort())===canonical(payload.evidence) && value.payload_digest===digest(payload), 'invalid-state');
  const {digest: checksum,...rest}=value; requireValue(checksum===digest(rest),'invalid-state');
}
function receipt(value) {
  fields(value,['action','input_digest','submitted_version','output']);
  enumeration(value.action,['result','accept','batch-seal','batch-result','batch-accept','batch-close','interrupt','stop-confirm','upgrade']);
  hash(value.input_digest); integer(value.submitted_version);
  fields(value.output,['schema','change_id','run_id','kind','lifecycle','execution_state','version'],['receipt_digest','seal_digest','result_digest','task_id','accepted','unfinished','recovery_id','confirmation_id']);
  requireValue(value.output.schema===RUN_SCHEMA,'invalid-state'); executionId(value.output.change_id); identifier(value.output.run_id); integer(value.output.version);
  enumeration(value.output.kind,['single','batch']); enumeration(value.output.lifecycle,['active','sealed','closed','interrupted']); enumeration(value.output.execution_state,['running','unknown','stopped']);
  for (const k of ['receipt_digest','seal_digest','result_digest']) if(value.output[k]!==undefined) hash(value.output[k]);
  for (const k of ['task_id','recovery_id','confirmation_id']) if(value.output[k]!==undefined) identifier(value.output[k]);
  for (const k of ['accepted','unfinished']) if(value.output[k]!==undefined) stringList(value.output[k],5).forEach(identifier);
  const {receipt_digest,...body}=value.output;
  requireValue(receipt_digest===digest(body) && value.output.version===value.submitted_version+1,'invalid-state');
}
export function manifestRecord(items) {
  requireValue(Array.isArray(items) && items.length>=2 && items.length<=5, 'invalid-manifest');
  const ids=new Set(), files=new Set();
  for(const item of items) {
    fields(item,['task_id','files','expected_change','dependencies'],['check','fallback']);
    identifier(item.task_id); requireValue(!ids.has(item.task_id),'invalid-manifest'); ids.add(item.task_id);
    boundedText(item.expected_change); stringList(item.dependencies).forEach(identifier);
    requireValue(Boolean(item.check) !== Boolean(item.fallback),'invalid-manifest'); boundedText(item.check ?? item.fallback,500);
    requireValue(stringList(item.files).length>0,'invalid-manifest');
    for(const file of item.files) { portablePath(file); const key=file.toLowerCase(); requireValue(![...files].some(f=>overlap(f,key)),'overlapping-items'); files.add(key); }
  }
  for(const item of items) requireValue(!item.dependencies.some(id=>ids.has(id)),'dependent-items');
  return items;
}
export const overlap=(a,b)=> { a=a.toLowerCase(); b=b.toLowerCase(); return a===b || a.startsWith(b+'/') || b.startsWith(a+'/'); };

// Only exact v1 images from validated upgrade/recovery journals may explain
// inherited terminal results without native v2 receipts. A marker is not proof.
export function matchesLegacyPredecessor(run, old) {
  const preserved=['change_id','run_id','task_id','owner','worker','role','scope','context_paths','status','context','initial_worktree','checkpoint','result','accepted_by'];
  return old.schema==='aifhub.execution.v1' && run.kind==='single'
    && preserved.every(key=>canonical(run[key])===canonical(old[key]))
    && old.version===(run.recovery?run.receipts.interrupt?.submitted_version:run.version)
    && (!run.legacy || run.legacy.predecessor_digest===digest(old));
}
function transitionReceipt(run, action, additions, values, key=action) {
  const saved=run.receipts[key];
  requireValue(saved && saved.action===action,'invalid-state');
  fields(saved.output,['schema','change_id','run_id','kind','lifecycle','execution_state','version','receipt_digest',...additions]);
  for(const [key,value] of Object.entries(values))requireValue(canonical(saved.output[key])===canonical(value),'invalid-state');
  return saved;
}
function batchReceipts(run) {
  const keys=[],transitions=[];
  const add=(action,additions,values,key=action)=>{
    const saved=transitionReceipt(run,action,additions,values,key);
    keys.push(key);transitions.push(saved);return saved;
  };
  if(run.lifecycle==='active')requireValue(!run.seal && run.execution_state==='running','invalid-state');
  if(run.lifecycle==='sealed')requireValue(run.seal && run.execution_state==='running','invalid-state');
  let sealed;
  if(run.seal) {
    const values={lifecycle:'sealed',execution_state:'running',seal_digest:run.seal.digest};
    sealed=add('batch-seal',['seal_digest'],values);
    for(const [task_id,item] of Object.entries(run.items)) {
      let result;
      if(item.result) {
        result=add('batch-result',['seal_digest','task_id','result_digest'],{...values,task_id,result_digest:item.result.digest},`batch-result:${task_id}`);
        requireValue(result.submitted_version===item.result.submitted_version && result.submitted_version>=sealed.output.version,'invalid-state');
      }
      if(item.accepted) {
        const accepted=add('batch-accept',['seal_digest','task_id','result_digest'],{...values,task_id,result_digest:item.result.digest},`batch-accept:${task_id}`);
        requireValue(accepted.submitted_version>=result.output.version,'invalid-state');
      }
    }
  }
  if(run.closure)add('batch-close',['seal_digest','accepted','unfinished'],{
    lifecycle:'closed',execution_state:'stopped',version:run.version,seal_digest:run.closure.seal_digest,
    accepted:run.closure.accepted,unfinished:run.closure.unfinished,
  });
  // Recovery receipts are validated by the common transition checks. They also
  // belong to the post-seal chain when a sealed assignment was interrupted.
  for(const key of ['interrupt','stop-confirm'])if(run.receipts[key]){keys.push(key);transitions.push(run.receipts[key]);}
  requireValue(canonical(keys.sort())===canonical(Object.keys(run.receipts).sort()),'invalid-state');
  if(sealed) {
    transitions.sort((a,b)=>a.output.version-b.output.version);
    requireValue(transitions[0]===sealed,'invalid-state');
    let version=sealed.output.version;
    // Checkpoints may precede seal; every later increment must have a receipt.
    for(const saved of transitions.slice(1)) {requireValue(saved.submitted_version===version,'invalid-state');version=saved.output.version;}
    requireValue(version===run.version,'invalid-state');
  }
}
export function validateRun(run, {predecessors=[]}={}) {
  const legacy=run?.schema==='aifhub.execution.v1';
  requireValue(legacy || run?.schema===RUN_SCHEMA,'unsupported-run-schema');
  fields(run,['schema','change_id','run_id','task_id','owner','worker','role','scope','context_paths','version','status','context','initial_worktree','checkpoint',...(!legacy?['kind','lifecycle','execution_state','source','receipts','created_at','updated_at']:[])], ['result','accepted_by',...(!legacy?['manifest','preflight','items','seal','closure','recovery','confirmation','legacy']:[])]);
  executionId(run.change_id); identifier(run.run_id); if(run.task_id!==null || legacy) identifier(run.task_id);
  identifier(run.owner); identifier(run.worker); enumeration(run.role,['implement','fix']);
  requireValue(stringList(run.scope).length>0,'invalid-state'); run.scope.forEach(portablePath); assertAuxiliaryPaths(run.context_paths);
  integer(run.version); enumeration(run.status,['started','completed','failed','blocked','cancelled','timed_out','accepted']);
  contextRecord(run.context); snapshot(run.initial_worktree);
  fields(run.checkpoint,['worktree','progress']); snapshot(run.checkpoint.worktree); progressRecord(run.checkpoint.progress);
  if(run.result) resultRecord(run.result,run,run.task_id);
  if(run.accepted_by!==undefined) requireValue(run.accepted_by===run.owner && run.status==='accepted','invalid-state');
  if(legacy || run.kind==='single') {
    requireValue(Boolean(run.result)===(run.status!=='started'),'invalid-state');
    if(run.result)requireValue((run.status===run.result.status || run.status==='accepted') && digest(run.checkpoint.worktree)===run.result.worktree_digest,'invalid-state');
    if(run.status==='accepted')requireValue(run.result.status==='completed' && run.accepted_by===run.owner,'invalid-state');
  }
  if(legacy) {
    if(run.result)requireValue(run.version===run.result.submitted_version+(run.status==='accepted'?2:1),'invalid-state');
    return run;
  }
  namespace(run.source); requireValue(run.source.id===run.change_id,'invalid-state');
  enumeration(run.kind,['single','batch']); enumeration(run.lifecycle,['active','sealed','closed','interrupted']); enumeration(run.execution_state,['running','unknown','stopped']);
  for(const time of [run.created_at,run.updated_at]) requireValue(typeof time==='string' && Number.isFinite(Date.parse(time)),'invalid-state');
  object(run.receipts); requireValue(Object.keys(run.receipts).length<=24,'invalid-state');
  for(const [key,value] of Object.entries(run.receipts)) { boundedText(key,200); receipt(value); requireValue(key===value.action+(value.output.task_id?':'+value.output.task_id:'') && value.output.run_id===run.run_id && value.output.change_id===run.change_id && value.output.kind===run.kind && value.output.version<=run.version,'invalid-state'); }
  for(const old of predecessors) { requireValue(old?.schema==='aifhub.execution.v1','invalid-state');validateRun(old); }
  const inherited=predecessors.some(old=>matchesLegacyPredecessor(run,old));
  if(run.legacy) { fields(run.legacy,['predecessor_digest']); hash(run.legacy.predecessor_digest); }
  if(run.legacy)requireValue(inherited && run.lifecycle==='interrupted','invalid-state');
  if(run.recovery) {
    fields(run.recovery,['recovery_id','reason','execution_state','evidence','pending_attempts','drift','interrupted_at']);
    identifier(run.recovery.recovery_id); enumeration(run.recovery.reason,['cancelled','timed_out','abandoned']); enumeration(run.recovery.execution_state,['stopped','running','unknown']); evidenceRefs(run.recovery.evidence);
    stringList(run.recovery.pending_attempts,1000).forEach(identifier); stringList(run.recovery.drift,8).forEach(d=>enumeration(d,['source-unavailable','source','context','revision','worktree','evidence']));
    requireValue(typeof run.recovery.interrupted_at==='string' && Number.isFinite(Date.parse(run.recovery.interrupted_at)) && run.lifecycle==='interrupted','invalid-state');
    if(run.recovery.execution_state==='stopped') requireValue(Object.keys(run.recovery.evidence).length>0,'invalid-state');
  }
  requireValue((run.lifecycle==='interrupted')===Boolean(run.recovery),'invalid-state');
  if(run.recovery && !run.confirmation)requireValue(run.execution_state===run.recovery.execution_state,'invalid-state');
  if(run.confirmation) { fields(run.confirmation,['confirmation_id','recovery_id','evidence']); identifier(run.confirmation.confirmation_id); requireValue(run.confirmation.recovery_id===run.recovery?.recovery_id && run.execution_state==='stopped','invalid-state'); evidenceRefs(run.confirmation.evidence); requireValue(Object.keys(run.confirmation.evidence).length>0,'invalid-state'); }
  requireValue(Boolean(run.receipts.interrupt)===Boolean(run.recovery) && Boolean(run.receipts['stop-confirm'])===Boolean(run.confirmation),'invalid-state');
  if(run.recovery) {
    requireValue(run.status!=='accepted','invalid-state');
    const interrupted=transitionReceipt(run,'interrupt',['recovery_id'],{lifecycle:'interrupted',execution_state:run.recovery.execution_state,recovery_id:run.recovery.recovery_id});
    if(run.confirmation) {
      requireValue(run.recovery.execution_state!=='stopped','invalid-state');
      const confirmed=transitionReceipt(run,'stop-confirm',['recovery_id','confirmation_id'],{lifecycle:'interrupted',execution_state:'stopped',recovery_id:run.recovery.recovery_id,confirmation_id:run.confirmation.confirmation_id,version:run.version});
      requireValue(confirmed.submitted_version===interrupted.output.version,'invalid-state');
    } else requireValue(interrupted.output.version===run.version,'invalid-state');
  }
  if(run.kind==='batch') {
    requireValue(run.task_id===null && run.role==='implement' && run.status==='started' && !run.result,'invalid-state'); manifestRecord(run.manifest); evidenceRefs(run.preflight); object(run.items);
    requireValue(canonical(Object.keys(run.items).sort())===canonical(run.manifest.map(x=>x.task_id).sort()) && canonical(run.scope)===canonical(run.manifest.flatMap(x=>x.files).sort()),'invalid-state');
    for(const [id,item] of Object.entries(run.items)) { fields(item,[],['result','accepted']); if(item.result) resultRecord(item.result,run,id); if(item.accepted!==undefined) requireValue(item.accepted===true && item.result?.status==='completed','invalid-state'); }
    if(run.seal) { fields(run.seal,['worktree','evidence','digest']); snapshot(run.seal.worktree); object(run.seal.evidence); requireValue(canonical(Object.keys(run.seal.evidence).sort())===canonical(Object.keys(run.items).sort()),'invalid-state'); Object.values(run.seal.evidence).forEach(v=>refs(v)); requireValue(run.seal.digest===digest({worktree:run.seal.worktree,evidence:run.seal.evidence}),'invalid-state'); }
    if(['sealed','closed'].includes(run.lifecycle)) requireValue(Boolean(run.seal),'invalid-state');
    if(run.closure) { fields(run.closure,['accepted','unfinished','context_digest','worktree_digest','seal_digest']); stringList(run.closure.accepted,5); stringList(run.closure.unfinished,5); for(const k of ['context_digest','worktree_digest','seal_digest']) hash(run.closure[k]); requireValue(run.lifecycle==='closed' && canonical(run.closure.accepted)===canonical(Object.keys(run.items).filter(k=>run.items[k].accepted).sort()) && canonical(run.closure.unfinished)===canonical(Object.keys(run.items).filter(k=>!run.items[k].accepted).sort()),'invalid-state'); }
    if(run.seal) {
      requireValue(canonical(run.seal.worktree)===canonical(run.checkpoint.worktree) && run.receipts['batch-seal']?.output.seal_digest===run.seal.digest,'invalid-state');
      for(const [id,item] of Object.entries(run.items)) {
        evidenceRefs(run.seal.evidence[id]);
        if(item.result) {
          const files=run.manifest.find(i=>i.task_id===id).files;
          requireValue(item.result.worktree_digest===digest(run.seal.worktree) && canonical(item.result.evidence_digests)===canonical(run.seal.evidence[id]) && canonical(item.result.changed_files)===canonical(changedFiles(run.initial_worktree,run.seal.worktree).filter(p=>files.includes(p))) && run.receipts[`batch-result:${id}`]?.output.result_digest===item.result.digest,'invalid-state');
        }
        if(item.accepted)requireValue(run.receipts[`batch-accept:${id}`]?.output.result_digest===item.result.digest,'invalid-state');
      }
    } else requireValue(Object.values(run.items).every(item=>Object.keys(item).length===0),'invalid-state');
    if(run.lifecycle==='closed')requireValue(run.closure && run.execution_state==='stopped' && run.receipts['batch-close'] && run.closure.context_digest===run.context.digest && run.closure.worktree_digest===digest(run.seal.worktree) && run.closure.seal_digest===run.seal.digest,'invalid-state');
    batchReceipts(run);
  } else {
    requireValue(run.task_id!==null && !run.manifest && !run.items && !run.seal && !run.closure && !run.preflight && run.lifecycle!=='sealed','invalid-state');
    requireValue(Object.keys(run.receipts).every(key=>['result','accept','interrupt','stop-confirm'].includes(key)),'invalid-state');
    if(inherited) {
      requireValue(!run.receipts.result && !run.receipts.accept,'invalid-state');
      if(!run.recovery)requireValue(run.lifecycle==='closed' && run.execution_state==='unknown' && !['started','completed'].includes(run.status),'invalid-state');
    } else {
      requireValue((run.lifecycle==='closed')===(run.status==='accepted'),'invalid-state');
      requireValue(Boolean(run.receipts.result)===Boolean(run.result) && Boolean(run.receipts.accept)===(run.status==='accepted'),'invalid-state');
      if(run.lifecycle==='active')requireValue(run.execution_state==='running','invalid-state');
      if(run.result) {
        const result=transitionReceipt(run,'result',['result_digest'],{lifecycle:'active',execution_state:'running',result_digest:run.result.digest});
        requireValue(result.submitted_version===run.result.submitted_version,'invalid-state');
        if(run.status==='accepted') {
          const accepted=transitionReceipt(run,'accept',['result_digest'],{lifecycle:'closed',execution_state:'stopped',result_digest:run.result.digest,version:run.version});
          requireValue(run.execution_state==='stopped' && accepted.submitted_version===result.output.version,'invalid-state');
        } else if(run.recovery)requireValue(run.receipts.interrupt.submitted_version===result.output.version,'invalid-state');
        else requireValue(run.version===result.output.version,'invalid-state');
      }
    }
  }
  return run;
}
export function validateLedger(ledger) {
  requireValue([LEDGER_SCHEMA,'aifhub.fix-attempts.v1'].includes(ledger?.schema),'invalid-attempt-ledger');
  fields(ledger,['schema','attempts'],ledger.schema===LEDGER_SCHEMA?['aliases']:[]);
  requireValue(Array.isArray(ledger.attempts) && ledger.attempts.length<=1000,'invalid-attempt-ledger'); const ids=new Set();
  for(const a of ledger.attempts) {
    fields(a,['attempt_id','run_id','worker','fingerprint','budget','identity','hypothesis','worktree_digest','outcome'],['evidence','recovery_id']);
    for(const k of ['attempt_id','run_id','worker']) identifier(a[k]); requireValue(!ids.has(a.attempt_id),'invalid-attempt-ledger'); ids.add(a.attempt_id);
    for(const k of ['fingerprint','budget','worktree_digest']) hash(a[k]); boundedText(a.hypothesis); enumeration(a.outcome,['pending','passed','failed','blocked','interrupted']);
    fields(a.identity,['task_id','finding_id','context','check','environment','inputs']); identifier(a.identity.task_id); identifier(a.identity.finding_id); hash(a.identity.context); boundedText(a.identity.check,500); hash(a.identity.environment); evidenceRefs(a.identity.inputs);
    const {check,...budget}=a.identity;
    requireValue(a.fingerprint===digest({...a.identity,worktree:a.worktree_digest}) && a.budget===digest(budget),'invalid-attempt-ledger');
    if(a.evidence) evidenceRefs(a.evidence); if(a.recovery_id) identifier(a.recovery_id);
    requireValue((a.outcome==='interrupted')===Boolean(a.recovery_id),'invalid-attempt-ledger');
  }
  if(ledger.aliases) {
    requireValue(Array.isArray(ledger.aliases) && ledger.aliases.length<=1000,'invalid-attempt-ledger');
    for(const a of ledger.aliases) { fields(a,['old_task_id','task_id','old_context','source_digest','authoritative_sources']); identifier(a.old_task_id); identifier(a.task_id); hash(a.old_context); hash(a.source_digest); object(a.authoritative_sources); for(const [p,v] of Object.entries(a.authoritative_sources)) { portablePath(p); refs(v); } }
  }
  return ledger;
}
export function validateSource(source) { fields(source,['schema','source']); requireValue(source.schema===SOURCE_SCHEMA,'invalid-source-state'); namespace(source.source); return source; }
export const envelope = record => JSON.stringify({checksum:digest(record),record},null,2)+'\n';
export function decode(bytes) { const e=JSON.parse(bytes); fields(e,['checksum','record']); requireValue(e.checksum===digest(e.record),'invalid-state'); return e.record; }
