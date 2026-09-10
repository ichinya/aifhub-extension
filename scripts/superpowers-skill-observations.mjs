// Normalized, coordinator-observed metadata. Raw transcripts and reasoning are not accepted.
export const OBSERVATION_SCHEMA = 'aifhub.superpowers_skill_observations.v1';
const HASH=/^[a-f0-9]{64}$/;
const METRICS=['missedLoads','wrongSkillLoads','prematureActions','unnecessaryLoads','unsupportedChecks','userInterventions'];
const FIELDS={
  request:['inputHash'],content:['skill','path','contentHash','providedHash','delivery','success','complete'],
  description:['skill'],promise:['skill'],action:['dependsOn'],
  'check-start':['checkId','commandHash','parentCheckId'],'check-result':['checkId','commandHash','exitCode'],
  'user-response':['scripted','inputHash'],final:['claims'],statement:['claims'],terminal:['outcome']
};
function requireValue(ok,code){if(!ok)throw new Error(code);}
function bounded(s){return typeof s==='string'&&s.length>0&&s.length<=160;}
function unknown(reason){return {eligible:false,reasons:[reason],metrics:Object.fromEntries(METRICS.map(k=>[k,null]))};}
function validateEvents(actions,executionId){
  requireValue(Object.keys(actions).every(k=>['schema','executionId','source','events'].includes(k)),'unexpected-actions-field');
  requireValue(actions.schema===OBSERVATION_SCHEMA&&actions.executionId===executionId,'action-execution-mismatch');
  requireValue(actions.source&&['host','synthetic'].includes(actions.source.kind)&&HASH.test(actions.source.hash)
    &&typeof actions.source.complete==='boolean','invalid-action-source');
  requireValue(Object.keys(actions.source).every(k=>['kind','hash','complete'].includes(k)),'unexpected-source-field');
  requireValue(Array.isArray(actions.events)&&actions.events.length<=10000,'invalid-action-events');
  let sequence=0,turn=-1;const records=new Set();
  for(const event of actions.events){
    requireValue(event&&Object.hasOwn(FIELDS,event.type),'unknown-action-type');
    requireValue(event.executionId===executionId,'action-execution-mismatch');
    requireValue(Number.isInteger(event.sequence)&&event.sequence===sequence+1
      &&Number.isInteger(event.turn)&&event.turn>=turn&&event.turn>=0,'action-order');
    requireValue(bounded(event.record)&&!records.has(event.record),'duplicate-action-record');
    requireValue(Object.keys(event).every(k=>['type','executionId','turn','record','sequence',...FIELDS[event.type]].includes(k)),'unexpected-action-field');
    records.add(event.record);sequence=event.sequence;turn=event.turn;
    if(['request','user-response'].includes(event.type)&&event.inputHash!==undefined)requireValue(HASH.test(event.inputHash),'invalid-turn-hash');
    if(event.type==='content'){
      requireValue(bounded(event.skill)&&bounded(event.path)&&HASH.test(event.contentHash)
        &&(event.providedHash===null||HASH.test(event.providedHash)),'invalid-content-identity');
      requireValue(['read','skill','host-injection'].includes(event.delivery)&&typeof event.success==='boolean'
        &&typeof event.complete==='boolean','invalid-content-result');
    }
    if(event.type==='action')requireValue(Array.isArray(event.dependsOn)&&event.dependsOn.every(bounded),'invalid-action-dependencies');
    if(event.type.startsWith('check-'))requireValue(bounded(event.checkId)&&HASH.test(event.commandHash),'invalid-check-identity');
    if(event.type==='check-start'&&event.parentCheckId!==undefined)requireValue(bounded(event.parentCheckId),'invalid-parent-check');
    if(event.type==='check-result')requireValue(Number.isInteger(event.exitCode)&&event.exitCode>=0&&event.exitCode<=255,'invalid-check-result');
    if(event.type==='user-response')requireValue(typeof event.scripted==='boolean','invalid-user-response');
    if(event.type==='terminal'){
      requireValue(['failed','timed_out'].includes(event.outcome),'invalid-terminal-outcome');
      requireValue(event===actions.events.at(-1),'terminal-must-be-last');
    }
    if(['final','statement'].includes(event.type)){
      requireValue(Array.isArray(event.claims),'invalid-check-claims');
      for(const c of event.claims)requireValue(bounded(c.checkId)&&['passed','failed'].includes(c.outcome)
        &&Object.keys(c).every(k=>['checkId','outcome'].includes(k)),'invalid-check-claim');
    }
  }
}
export function analyzeActions({executionId,catalog,expectedSkills=[],invocation='natural',actions,turnHashes}={}){
  if(!actions)return unknown('actions-missing');
  validateEvents(actions,executionId);
  requireValue(Array.isArray(catalog)&&catalog.length>0,'action-catalog-missing');
  requireValue(new Set(catalog.map(s=>s.name)).size===catalog.length,'action-catalog-duplicate');
  for(const skill of catalog)requireValue(bounded(skill.name)&&bounded(skill.path)&&HASH.test(skill.contentHash)
    &&['auto','explicit-only'].includes(skill.invocationPolicy),'invalid-action-catalog');
  requireValue(Array.isArray(expectedSkills)&&expectedSkills.every(bounded),'invalid-expected-skills');
  if(!actions.source.complete)return unknown('actions-incomplete');
  const events=actions.events;
  if(!['final','terminal'].includes(events.at(-1)?.type)||!events.some(e=>e.type==='request'))return unknown('actions-incomplete');
  if(turnHashes!==undefined) {
    requireValue(Array.isArray(turnHashes)&&turnHashes.length>0&&turnHashes.every(h=>HASH.test(h)),'invalid-turn-hashes');
    const requests=events.filter(e=>e.type==='request');
    if(requests.length!==1||requests[0].inputHash!==turnHashes[0])return unknown('user-turns-unverified');
    let next=1;
    for(const response of events.filter(e=>e.type==='user-response'&&e.scripted))
      if(response.inputHash!==turnHashes[next++])return unknown('user-turns-unverified');
    // A completed assignment must include every mandatory scripted reply.
    // An observed terminal failure can end a verified prefix before later turns.
    if(events.at(-1).type==='final'&&next!==turnHashes.length)return unknown('user-turns-incomplete');
  }
  const metrics=Object.fromEntries(METRICS.map(k=>[k,0]));
  const loaded=new Set(),missed=new Set(),checks=new Map();
  let firstDependent=false;
  for(const event of events){
    if(event.type==='content'){
      const skill=catalog.find(s=>s.name===event.skill);
      const valid=skill&&event.path===skill.path&&event.contentHash===skill.contentHash
        &&event.providedHash===skill.contentHash&&event.success&&event.complete;
      const autonomousForbidden=skill?.invocationPolicy==='explicit-only'&&invocation!=='explicit'&&event.delivery!=='host-injection';
      if(!valid||autonomousForbidden)metrics.wrongSkillLoads++;
      if(event.delivery!=='host-injection'&&(!expectedSkills.includes(event.skill)||autonomousForbidden))metrics.unnecessaryLoads++;
      if(valid&&!autonomousForbidden)loaded.add(event.skill);
    }
    if(event.type==='action' || (event.type==='check-start' && !event.parentCheckId) || event.type==='final' || event.type==='statement'){
      // The expected skill is grader-owned, so a claimed empty dependsOn cannot bypass it.
      const needed=[...new Set([...expectedSkills,...(event.dependsOn??[])])];
      if(!firstDependent){for(const skill of expectedSkills)if(!loaded.has(skill))missed.add(skill);firstDependent=true;}
      if(needed.some(skill=>!loaded.has(skill)))metrics.prematureActions++;
    }
    if(event.type==='check-start'){
      requireValue(!checks.has(event.checkId),'duplicate-check-id');
      if(event.parentCheckId){
        const parent=checks.get(event.parentCheckId);
        requireValue(parent&&parent.exitCode===null&&!parent.parent,'unmatched-parent-check');
      }
      checks.set(event.checkId,{hash:event.commandHash,exitCode:null,parent:event.parentCheckId??null});
    }
    if(event.type==='check-result'){
      const check=checks.get(event.checkId);
      requireValue(check&&check.hash===event.commandHash&&check.exitCode===null,'unmatched-check-result');
      check.exitCode=event.exitCode;
    }
    if(event.type==='user-response'&&!event.scripted)metrics.userInterventions++;
    if(['final','statement'].includes(event.type)){
      for(const claim of event.claims){
        const check=checks.get(claim.checkId);
        if(!check||check.exitCode===null||(claim.outcome==='passed')!==(check.exitCode===0))metrics.unsupportedChecks++;
      }
    }
  }
  if([...checks.values()].some(check=>check.exitCode===null))return unknown('actions-check-incomplete');
  if(!firstDependent)for(const skill of expectedSkills)if(!loaded.has(skill))missed.add(skill);
  metrics.missedLoads=missed.size;
  return {eligible:true,reasons:[],metrics,sourceKind:actions.source.kind,
    ...(events.at(-1).type==='terminal'?{terminalOutcome:events.at(-1).outcome}:{})};
}
