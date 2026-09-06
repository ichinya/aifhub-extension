import { readdir } from 'node:fs/promises';
import { canonical, digest, fields, identifier, requireValue } from './workflow-state-store.mjs';
import { executionId } from './execution-task-source.mjs';
import { decode, envelope, hash, LEDGER_SCHEMA, RUN_SCHEMA, TX_SCHEMA, matchesLegacyPredecessor, validateLedger, validateRun, validateSource } from './execution-records.mjs';

export const folderFor = id => `.ai-factory/state/${executionId(id)}/execution`;
export async function names(store, relative) {
  const target=await store.target(relative);
  const entries=await readdir(target,{withFileTypes:true}).catch(e=>{if(e.code==='ENOENT')return [];throw e;});
  requireValue(entries.length<=1000,'execution-catalogue-full',true);
  for(const entry of entries) await store.target(`${relative}/${entry.name}`);
  return entries.sort((a,b)=>a.name.localeCompare(b.name));
}
const predecessorsFor=(run,predecessors)=>predecessors.filter(old=>old.run_id===run.run_id && old.change_id===run.change_id);
function validateImage(filename, text, folder, predecessors) {
  if(text===null)return;
  requireValue(typeof text==='string' && Buffer.byteLength(text)<=16*1024*1024,'invalid-transaction');
  const record=decode(text);
  if(filename===`${folder}/source.json`) { validateSource(record); requireValue(folderFor(record.source.id)===folder,'invalid-transaction'); }
  else if(filename===`${folder}/fix-attempts.json`) validateLedger(record);
  else { const match=filename.slice(folder.length).match(/^\/runs\/([^/]+)\.json$/); requireValue(match,'invalid-transaction'); identifier(match[1]); validateRun(record,{predecessors:predecessorsFor(record,predecessors)}); requireValue(record.run_id===match[1] && folder===folderFor(record.change_id),'invalid-transaction'); }
}
function validateTransaction(tx, folder, predecessors=[]) {
  fields(tx,['schema','id','action','input_digest','writes','response','state']);
  requireValue(tx.schema===TX_SCHEMA && ['prepared','applied'].includes(tx.state),'invalid-transaction'); identifier(tx.id); hash(tx.input_digest);
  requireValue(['start','batch-start','interrupt','upgrade'].includes(tx.action),'invalid-transaction');
  requireValue(Array.isArray(tx.writes) && tx.writes.length>0 && tx.writes.length<=1002,'invalid-transaction');
  const seen=new Set();
  for(const write of tx.writes) { fields(write,['path','before','after']); requireValue(!seen.has(write.path),'invalid-transaction'); seen.add(write.path); validateImage(write.path,write.before,folder,predecessors); validateImage(write.path,write.after,folder,predecessors); requireValue(write.after!==null,'invalid-transaction'); }
  requireValue(tx.response && typeof tx.response==='object' && !Array.isArray(tx.response),'invalid-transaction');
  const runs=tx.writes.filter(w=>w.path.includes('/runs/')).map(w=>decode(w.after));
  if(tx.action==='interrupt')requireValue(runs.length===1 && canonical(tx.response)===canonical(runs[0].receipts.interrupt?.output),'invalid-transaction');
  else if(tx.action==='upgrade') {
    fields(tx.response,['schema','change_id','upgrade_id','predecessor_inventory_digest','attempts','aliases','historical']);
    const ledger=decode(tx.writes.find(w=>w.path===`${folder}/fix-attempts.json`)?.after??'null');
    identifier(tx.response.upgrade_id); hash(tx.response.predecessor_inventory_digest);
    requireValue(tx.response.schema===LEDGER_SCHEMA && tx.response.historical===true && folderFor(tx.response.change_id)===folder && tx.response.attempts===ledger.attempts.length && tx.response.aliases===ledger.aliases.length,'invalid-transaction');
  } else {
    const r=runs[0];requireValue(runs.length===1 && r.schema===RUN_SCHEMA && r.version===1,'invalid-transaction');
    fields(tx.response,['schema','change_id','run_id','task_id','kind','owner','worker','role','status','version','lifecycle','execution_state','base_revision','context_digest','checkpoint_digest','scope','progress','result','accepted_by','source'],r.kind==='batch'?['items','seal_digest','closure']:[]);
    for(const key of ['schema','change_id','run_id','task_id','kind','owner','worker','role','status','version','lifecycle','execution_state','scope','source'])requireValue(canonical(tx.response[key])===canonical(r[key]),'invalid-transaction');
    requireValue(tx.response.base_revision===r.initial_worktree.head && tx.response.context_digest===r.context.digest && tx.response.checkpoint_digest===digest(r.checkpoint.worktree) && canonical(tx.response.progress)===canonical(r.checkpoint.progress) && tx.response.result===null && tx.response.accepted_by===null,'invalid-transaction');
    if(r.kind==='batch')requireValue(canonical(tx.response.items)===canonical(r.items) && tx.response.seal_digest===null && tx.response.closure===null,'invalid-transaction');
  }
  return tx;
}
function journalPredecessors(transactions,folder) {
  const found=new Map();
  for(const tx of transactions) {
    if(!['interrupt','upgrade'].includes(tx?.action))continue;
    requireValue(Array.isArray(tx.writes) && tx.writes.length<=1002,'invalid-transaction');
    for(const write of tx.writes) {
      fields(write,['path','before','after']);
      if(write.before===null || typeof write.path!=='string' || !write.path.startsWith(`${folder}/runs/`))continue;
      requireValue(typeof write.before==='string' && Buffer.byteLength(write.before)<=16*1024*1024,'invalid-transaction');
      const old=decode(write.before);
      if(old?.schema==='aifhub.execution.v1') {
        validateRun(old);requireValue(write.path===`${folderFor(old.change_id)}/runs/${old.run_id}.json`,'invalid-transaction');
        requireValue(typeof write.after==='string' && Buffer.byteLength(write.after)<=16*1024*1024,'invalid-transaction');
        const next=decode(write.after);
        requireValue(next?.schema===RUN_SCHEMA && matchesLegacyPredecessor(next,old),'invalid-transaction');
        requireValue(tx.action==='interrupt'
          ? next.lifecycle==='interrupted' && next.legacy?.predecessor_digest===digest(old)
          : next.lifecycle==='closed' && !next.legacy,'invalid-transaction');
        validateRun(next,{predecessors:[old]});
        found.set(digest(old),old);
      }
    }
  }
  return [...found.values()];
}
async function journalHistory(store,folder) {
  const transactions=[];
  for(const file of await names(store,`${folder}/transactions`)) {
    requireValue(file.isFile() && file.name.endsWith('.json'),'invalid-transaction');
    const id=identifier(file.name.slice(0,-5)),tx=await store.load(`${folder}/transactions/${file.name}`);
    requireValue(tx?.id===id,'invalid-transaction');transactions.push(tx);
  }
  const predecessors=journalPredecessors(transactions,folder);
  // Validate every journal before its v1 images can authorize an exception.
  for(const tx of transactions)validateTransaction(tx,folder,predecessors);
  return {transactions,predecessors};
}
export async function validateHistoricalRun(store,run,predecessor=null) {
  let predecessors=[];
  if(run.legacy || (run.kind==='single' && (run.result || run.lifecycle==='closed'))) {
    predecessors=(await journalHistory(store,folderFor(run.change_id))).predecessors;
  }
  if(predecessor?.schema==='aifhub.execution.v1')predecessors.push(predecessor);
  return validateRun(run,{predecessors:predecessorsFor(run,predecessors)});
}
export async function readTransaction(store, folder, id) {
  identifier(id);return (await journalHistory(store,folder)).transactions.find(tx=>tx.id===id)??null;
}
export async function pendingTransactions(store) {
  const pending=[];
  for(const entry of await names(store,'.ai-factory/state')) {
    if(!entry.isDirectory())continue;
    const folder=folderFor(entry.name);
    for(const tx of (await journalHistory(store,folder)).transactions)if(tx.state==='prepared')pending.push({folder,tx});
  }
  return pending;
}
export async function publish(store, folder, id, action, input, records, response, options={}) {
  const filename=`${folder}/transactions/${identifier(id)}.json`;
  let tx=await readTransaction(store,folder,id);
  const recovering=tx?.state==='prepared';
  if(tx) {
    requireValue(tx.action===action && tx.input_digest===digest(input),'transaction-conflict',true);
    if(tx.state==='applied')return {...tx.response,replay:true,historical:true};
  } else {
    const writes=[];
    for(const [relative,record] of records) writes.push({path:relative,before:await store.textFile(relative),after:envelope(record)});
    tx={schema:TX_SCHEMA,id,action,input_digest:digest(input),writes,response,state:'prepared'};
    const predecessors=(await journalHistory(store,folder)).predecessors;
    validateTransaction(tx,folder,[...predecessors,...journalPredecessors([tx],folder)]);
    // Check every size and image before the first publication, including the journal.
    requireValue(Buffer.byteLength(envelope(tx))<=16*1024*1024,'state-too-large');
    await options.failpoint?.('before-journal');
    await store.save(filename,tx); await options.failpoint?.('after-journal');
  }
  // Verify ALL images first: a conflict must not apply an earlier subset.
  for(const write of tx.writes) {
    const actual=await store.textFile(write.path);
    requireValue(actual===write.before || actual===write.after,'transaction-conflict',true);
  }
  for(let i=0;i<tx.writes.length;i++) {
    const write=tx.writes[i]; await options.failpoint?.(`before-write-${i}`);
    if(await store.textFile(write.path)!==write.after) await store.write(write.path,write.after);
    await options.failpoint?.(`after-write-${i}`);
  }
  await options.failpoint?.('before-applied'); tx.state='applied'; await store.save(filename,tx); await options.failpoint?.('after-applied');
  return recovering?{...tx.response,recovered:true,historical:true}:tx.response;
}

export async function history(store, change) {
  const folder=folderFor(change), records=[], inventory=Object.create(null);
  const {predecessors}=await journalHistory(store,folder);
  const sourceText=await store.textFile(`${folder}/source.json`);
  const source=sourceText===null?null:validateSource(decode(sourceText));
  if(sourceText!==null) inventory[`${folder}/source.json`]=digest(sourceText);
  const ledgerText=await store.textFile(`${folder}/fix-attempts.json`);
  const ledger=ledgerText===null?null:validateLedger(decode(ledgerText));
  if(ledgerText!==null) inventory[`${folder}/fix-attempts.json`]=digest(ledgerText);
  for(const file of await names(store,`${folder}/runs`)) {
    requireValue(file.isFile() && file.name.endsWith('.json'),'invalid-run-catalogue');
    const id=identifier(file.name.slice(0,-5)), filename=`${folder}/runs/${file.name}`;
    const text=await store.textFile(filename), run=decode(text);
    validateRun(run,{predecessors:predecessorsFor(run,predecessors)});
    requireValue(run.change_id===change && run.run_id===id,'invalid-run-catalogue');
    if(run.schema!=='aifhub.execution.v1') requireValue(source && canonical(source.source)===canonical(run.source),'state-source-collision',true);
    records.push(run); inventory[filename]=digest(text);
  }
  if(source) requireValue(source.source.id===change,'state-source-collision',true);
  if(source) requireValue(ledger && records.length>0,'invalid-state-lineage',true);
  if(ledger?.schema===LEDGER_SCHEMA) requireValue(source && records.every(r=>r.schema!=='aifhub.execution.v1'),'invalid-state-lineage',true);
  if(records.some(r=>r.schema!=='aifhub.execution.v1' && !r.legacy)) requireValue(source && ledger?.schema===LEDGER_SCHEMA,'invalid-state-lineage',true);
  if(ledger) for(const attempt of ledger.attempts) requireValue(records.some(r=>r.run_id===attempt.run_id && r.worker===attempt.worker && r.role==='fix' && (r.task_id===attempt.identity.task_id || ledger.aliases?.some(a=>a.old_task_id===attempt.identity.task_id && a.task_id===r.task_id))),'invalid-attempt-lineage',true);
  if(ledger) {
    for(const r of records) {
      const attempts=ledger.attempts.filter(a=>a.run_id===r.run_id);
      if(r.recovery)requireValue(canonical(attempts.filter(a=>a.outcome==='interrupted' && a.recovery_id===r.recovery.recovery_id).map(a=>a.attempt_id).sort())===canonical([...r.recovery.pending_attempts].sort()),'invalid-attempt-lineage',true);
      if(r.schema===RUN_SCHEMA && !r.legacy)requireValue(attempts.filter(a=>a.outcome==='pending').length<=1,'invalid-attempt-lineage',true);
      for(const a of attempts)if(a.outcome==='interrupted')requireValue(a.recovery_id===r.recovery?.recovery_id,'invalid-attempt-lineage',true);
    }
    for(const alias of ledger.aliases??[])requireValue(alias.source_digest===source?.source.namespace_digest && alias.old_context===digest(alias.authoritative_sources) && records.some(r=>r.task_id===alias.old_task_id && r.context.digest===alias.old_context),'invalid-attempt-lineage',true);
  }
  return {source,ledger,runs:records,inventory,inventory_digest:digest(inventory)};
}
export async function catalogue(store) {
  const result=[];
  for(const entry of await names(store,'.ai-factory/state')) if(entry.isDirectory()) {
    const found=await history(store,executionId(entry.name)); result.push(...found.runs);
    requireValue(result.length<=1000,'execution-catalogue-full',true);
  }
  return result;
}
export const reserves = run => run.schema==='aifhub.execution.v1'
  ? ['started','completed'].includes(run.status)
  : ['active','sealed'].includes(run.lifecycle) || (run.lifecycle==='interrupted' && run.execution_state!=='stopped');
