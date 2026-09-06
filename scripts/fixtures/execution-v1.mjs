// Exact predecessor layout, built from the old source inventory and parser contract.
import { digest, storeFor, worktree } from '../workflow-state-store.mjs';
export async function writeLegacyExecution(p,{failures=0,pending=0,task='1.1',status='started'}={}) {
  const store=await storeFor(p.root),sources=Object.create(null);
  for(const root of [`openspec/changes/${p.id}`,'openspec/specs','.ai-factory/config.yaml','AGENTS.md','.ai-factory/rules.md','.ai-factory/rules','.ai-factory/skill-context',`.ai-factory/qa/${p.id}`].sort()) sources[root]=await store.inventory(root);
  const snapshot=await worktree(store,['src/a.js']);
  const run={schema:'aifhub.execution.v1',change_id:p.id,run_id:'legacy',task_id:task,owner:'parent',worker:'worker',role:'fix',scope:['src/a.js'],context_paths:[],version:1,status:'started',
    context:{digest:digest(sources),sources},initial_worktree:snapshot,checkpoint:{worktree:snapshot,progress:{completed_steps:[],next_step:'Run check'}}};
  if(status!=='started') {
    const evidence=`.ai-factory/state/${p.id}/implementation/legacy.md`;
    await p.put(evidence,'Observed legacy check');
    const payload={result_id:'legacy-result',status:status==='accepted'?'completed':status,changed_files:[],checks:[{name:'legacy-check',exit_code:status==='failed'?1:0}],evidence:[evidence]};
    const result={...payload,change_id:p.id,task_id:task,run_id:run.run_id,base_revision:snapshot.head,context_digest:run.context.digest,
      worktree_digest:digest(snapshot),evidence_digests:{[evidence]:digest('Observed legacy check')},payload_digest:digest(payload),submitted_version:1};
    run.result={...result,digest:digest(result)};run.status=status;run.version=status==='accepted'?3:2;
    if(status==='accepted')run.accepted_by='parent';
  }
  const attempts=[];
  for(let i=0;i<failures+pending;i++) {
    const identity={task_id:task,finding_id:'QA-1',context:run.context.digest,check:'focused-check',environment:digest('fixture-1'),inputs:{}};
    const {check,...budget}=identity,worktree_digest=i===failures+pending-1?digest(snapshot):digest(`legacy-experiment-${i}`);
    attempts.push({attempt_id:`legacy-attempt-${i}`,run_id:run.run_id,worker:run.worker,fingerprint:digest({...identity,worktree:worktree_digest}),budget:digest(budget),identity,hypothesis:`Legacy hypothesis ${i}`,worktree_digest,outcome:i<failures?'failed':'pending',...(i<failures?{evidence:{}}:{})});
  }
  const folder=`.ai-factory/state/${p.id}/execution`;
  await store.save(`${folder}/runs/legacy.json`,run);await store.save(`${folder}/fix-attempts.json`,{schema:'aifhub.fix-attempts.v1',attempts});
  return {run,attempts,runBytes:await p.get(`${folder}/runs/legacy.json`),ledgerBytes:await p.get(`${folder}/fix-attempts.json`)};
}
