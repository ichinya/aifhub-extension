#!/usr/bin/env node
// Developer-only, opt-in evaluation. No model client, installation or cleanup.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { hash, validateRuntime, assessRuntime } from './skill-workflow-eval.mjs';
import { analyzeActions } from './superpowers-skill-observations.mjs';

export const SCHEMA = 'aifhub.superpowers_skill_eval.v1';
export const KINDS = ['pressure', 'discovery', 'composition', 'review-advice', 'boundary-tracing', 'test-pollution', 'visual-choice'];
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = fileURLToPath(import.meta.url);
const FIXTURES = path.join(ROOT, 'test/fixtures/superpowers-skill-eval');
const LIMIT = 4 * 1024 * 1024;
const ID = /^[a-z0-9][a-z0-9-]{0,79}$/;
const HASH = /^[a-f0-9]{64}$/;
const WORKFLOWS = ['none', 'aif-plan', 'aif-explore', 'aif-implement', 'aif-fix', 'aif-review', 'aif-analyze', 'aif-done', 'aif-mode'];
const IDENTITY = ['runId', 'executionId', 'pairId', 'caseId', 'variantId', 'arm', 'repetition',
  'inputHash', 'instructionHash', 'catalogHash', 'runtimeHash', 'graderHash', 'collectorHash'];
const unknownRuntime = () => ({host:null,hostVersion:null,model:null,effort:null,tools:null,settingsHash:null});

function requireValue(ok, code) { if (!ok) throw new Error(code); }
function unique(items, code) { requireValue(new Set(items).size === items.length, code); }
function identifier(value) { requireValue(typeof value === 'string' && ID.test(value), 'invalid-id'); return value; }
function safePath(value) {
  requireValue(typeof value === 'string' && value.length <= 240 && value.split('/').every(p =>
    /^[\w.-]+$/.test(p) && !['.', '..'].includes(p) && !/[. ]$/.test(p)
    && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p)), 'unsafe-path');
  return value;
}
function inside(root, target) {
  const relative = path.relative(root, target);
  return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}
async function regular(file) {
  const stat = await lstat(file);
  requireValue(stat.isFile() && !stat.isSymbolicLink() && stat.size <= LIMIT, 'not-bounded-regular-file');
  return readFile(file);
}
async function under(root, relative) {
  safePath(relative);
  let target = root;
  const base = await lstat(root);
  requireValue(base.isDirectory() && !base.isSymbolicLink(), 'linked-root');
  for (const part of relative.split('/')) {
    target = path.join(target, part);
    requireValue(!(await lstat(target)).isSymbolicLink(), 'linked-path');
  }
  requireValue(inside(await realpath(root), await realpath(target)), 'escaped-root');
  return target;
}
async function readUnder(root, relative) { return regular(await under(root, relative)); }
async function json(file) { return JSON.parse((await regular(file)).toString('utf8')); }
async function write(root, relative, value) {
  safePath(relative);
  let directory = root;
  for (const part of relative.split('/').slice(0, -1)) {
    directory = path.join(directory, part);
    try { await mkdir(directory); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    const stat = await lstat(directory);
    requireValue(stat.isDirectory() && !stat.isSymbolicLink(), 'linked-write-directory');
  }
  const bytes = typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value, null, 2) + '\n';
  await writeFile(path.join(root, relative), bytes, {flag:'wx'});
}
async function tree(root, prefix = '', output = {}) {
  const stat = await lstat(root);
  requireValue(stat.isDirectory() && !stat.isSymbolicLink(), 'linked-directory');
  for (const entry of (await readdir(root, {withFileTypes:true})).sort((a,b) => a.name.localeCompare(b.name))) {
    const relative = safePath(prefix + entry.name);
    requireValue(!entry.isSymbolicLink(), 'linked-tree-entry');
    requireValue(relative.split('/').length < 20 && Object.keys(output).length < 1000, 'tree-limit');
    if (entry.isDirectory()) await tree(path.join(root, entry.name), relative + '/', output);
    else output[relative] = hash(await regular(path.join(root, entry.name)));
  }
  return output;
}
function identity(row) { return Object.fromEntries(IDENTITY.map(k => [k, row[k]])); }
function fingerprint(files) { return Object.fromEntries(Object.entries(files).sort().map(([p,b]) => [p,hash(b)])); }
// Bundled helpers use static ESM imports. Match declarations, not words in errors
// or the checker's quoted child-process probe. Dynamic imports must be pinned literals or
// the single runtime checker load; any other expression is rejected as unpinned.
function staticImports(source) {
  return [...source.matchAll(/(?:^|[;\n])\s*(?:import\s+(?:[^'";]*?\s+from\s+)?|export\s+[^'";]*?\s+from\s+)['"]([^'"\r\n]+)['"]/g)].map(m=>m[1]);
}
function dynamicImports(source) {
  const code=source.replace(/\/\*[\s\S]*?\*\//g,'').replace(/\/\/.*$/gm,'');
  const out=[];
  for(const m of code.matchAll(/\bimport\s*\(/g)){
    const after=code.slice(m.index+m[0].length);
    const literal=after.match(/^\s*['"`]([^'"`\r\n]+)['"`]/);
    if(literal)out.push({specifier:literal[1]});
    else out.push({expression:true});
  }
  return out;
}

export function validateSuite(suite) {
  requireValue(suite?.schema === SCHEMA && /^[a-f0-9]{40}$/.test(suite.baseline), 'invalid-suite');
  requireValue(Array.isArray(suite.cases) && suite.cases.length > 0 && suite.cases.length <= 200, 'invalid-cases');
  requireValue(Array.isArray(suite.variants) && suite.variants.length > 0 && suite.variants.length <= 30, 'invalid-variants');
  requireValue(Number.isInteger(suite.repetitions) && suite.repetitions >= 1 && suite.repetitions <= 5, 'invalid-repetitions');
  requireValue(hash(suite.kinds) === hash(KINDS), 'invalid-kinds');
  unique(suite.cases.map(c=>c.id), 'duplicate-case');
  unique(suite.variants.map(v=>v.id), 'duplicate-variant');
  requireValue(KINDS.every(k=>suite.cases.some(c=>c.kind===k)), 'missing-kind');
  requireValue(['synthetic-catalog', 'instruction-only', 'installed-host'].includes(suite.catalogMode), 'invalid-catalog-mode');
  requireValue(Array.isArray(suite.sourcePaths) && suite.sourcePaths.length > 0, 'missing-sources');
  suite.sourcePaths.forEach(safePath);
  unique(suite.sourcePaths.map(p=>p.toLowerCase()), 'duplicate-source');
  requireValue(hash(suite.protectedFields) === hash(['name','disable-model-invocation','allowed-tools']), 'protected-fields-changed');
  for (const c of suite.cases) {
    identifier(c.id); safePath(c.input);
    requireValue(KINDS.includes(c.kind) && WORKFLOWS.includes(c.workflowId), 'unknown-workflow-kind');
    requireValue(['standard','neutral','pressure'].includes(c.condition), 'invalid-condition');
    requireValue(['none','explicit','natural','multi-turn'].includes(c.invocation), 'invalid-invocation');
    requireValue(Array.isArray(c.expectedSkills) && c.expectedSkills.every(s=>WORKFLOWS.includes(s) && s!=='none'), 'invalid-expected-skills');
    requireValue(!c.expectedSkills.includes('aif-mode') || c.invocation === 'explicit', 'explicit-only');
    requireValue(Array.isArray(c.criteria) && c.criteria.length > 0, 'missing-criteria');
    unique(c.criteria.map(r=>r.id), 'duplicate-criterion');
    for (const r of c.criteria) { identifier(r.id); requireValue(typeof r.criterion === 'string' && r.criterion.trim(), 'invalid-criterion'); }
  }
  for (const v of suite.variants) {
    identifier(v.id); requireValue(WORKFLOWS.includes(v.owner), 'invalid-owner');
    requireValue(['identity-control','description','recipe'].includes(v.type), 'invalid-variant-type');
    requireValue(Array.isArray(v.interventions) && v.interventions.length <= 20, 'invalid-interventions');
    requireValue(v.type !== 'identity-control' || v.interventions.length === 0, 'control-intervention');
    requireValue(v.type === 'identity-control' || v.interventions.length > 0, 'missing-intervention');
    requireValue(Array.isArray(v.caseIds) && v.caseIds.length > 0, 'missing-variant-cases');
    unique(v.caseIds, 'duplicate-variant-case');
    requireValue(v.caseIds.every(id=>suite.cases.some(c=>c.id===id)), 'unknown-case');
    unique(v.interventions.map(i=>i.path.toLowerCase()), 'duplicate-intervention');
    for (const i of v.interventions) {
      safePath(i.path);
      requireValue(['file','append','frontmatter:description'].includes(i.selector)
        || /^(?:section|append-section):[A-Za-z][A-Za-z -]+$/.test(i.selector), 'invalid-selector');
      if(i.candidate !== 'checkout') safePath(i.candidate);
      if(v.type === 'description') requireValue(i.selector === 'frontmatter:description', 'description-scope');
    }
    if(v.type === 'description') {
      const covered = suite.cases.filter(c=>v.caseIds.includes(c.id));
      requireValue(covered.some(c=>c.expectedSkills.includes(v.owner)) && covered.some(c=>!c.expectedSkills.length), 'description-case-coverage');
    }
  }
  requireValue(suite.cases.every(c=>suite.variants.some(v=>v.caseIds.includes(c.id))), 'uncovered-case');
  return suite;
}

function validateInput(input) {
  requireValue(Array.isArray(input.turns) && input.turns.length > 0 && input.turns.length <= 100 && input.turns.every(t=>typeof t==='string' && t.trim() && Buffer.byteLength(t)<=LIMIT), 'invalid-turns');
  requireValue(input.files && typeof input.files === 'object' && !Array.isArray(input.files), 'invalid-files');
  requireValue(Object.keys(input.files).length <= 100, 'file-limit');
  Object.keys(input.files).forEach(safePath);
  unique(Object.keys(input.files).map(p=>p.toLowerCase()), 'duplicate-input-path');
  requireValue(Object.values(input.files).every(v=>typeof v==='string' && Buffer.byteLength(v)<=LIMIT), 'invalid-file-body');
  requireValue(Array.isArray(input.allowedChanges), 'invalid-scope');
  input.allowedChanges.forEach(safePath);
  if(input.acceptedStatuses!==undefined)requireValue(Array.isArray(input.acceptedStatuses)&&input.acceptedStatuses.length>0
    &&input.acceptedStatuses.every(s=>['completed','incomplete'].includes(s)),'invalid-accepted-statuses');
  requireValue(Array.isArray(input.catalog) && input.catalog.length > 0, 'missing-catalog');
  unique(input.catalog.map(s=>s.name), 'duplicate-skill');
  for(const skill of input.catalog) {
    requireValue(WORKFLOWS.includes(skill.name) && skill.name!=='none', 'unknown-catalog-skill');
    safePath(skill.path);
    requireValue(['auto','explicit-only'].includes(skill.invocationPolicy), 'invalid-invocation-policy');
    if(skill.name==='aif-mode') requireValue(skill.invocationPolicy==='explicit-only', 'explicit-only');
  }
  return input;
}
function protectedMetadata(text, fields) {
  const frontmatter = text?.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1] ?? '';
  return Object.fromEntries(fields.map(f=>[f,frontmatter.split(/\r?\n/).find(l=>l.startsWith(f+':')) ?? null]));
}
function section(text, name) {
  const lines = text.split('\n');
  const index = lines.findIndex(l=>/^#{2,6} /.test(l) && l.replace(/^#+ /,'').trimEnd()===name);
  requireValue(index>=0, 'missing-intervention-section');
  const level=lines[index].match(/^#+/)[0].length;
  let end=index+1; while(end<lines.length && !(lines[end].match(/^#{1,6} /)?.[0].trim().length<=level))end++;
  return {body:lines.slice(index,end).join('\n'),start:index,end,lines};
}
function applyIntervention(before, candidate, selector) {
  if(selector==='file')return candidate;
  requireValue(typeof before==='string', 'missing-baseline-file');
  if(selector==='append')return before.trimEnd()+'\n\n'+candidate.trim()+'\n';
  if(selector==='frontmatter:description') {
    requireValue(candidate.trim() && !/[\r\n]/.test(candidate.trim()), 'invalid-description');
    const match=before.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    requireValue(match && /^description: .+$/m.test(match[1]), 'missing-description');
    return before.replace(match[0],match[0].replace(/^description: .+$/m,'description: '+candidate.trim()));
  }
  const name=selector.slice(selector.indexOf(':')+1);
  const next=section(candidate,name);
  if(selector.startsWith('append-section:')) {
    requireValue(!before.split('\n').some(l=>/^#{2,6} /.test(l) && l.replace(/^#+ /,'').trimEnd()===name), 'existing-append-section');
    return before.trimEnd()+'\n\n'+next.body.trim()+'\n';
  }
  const previous=section(before,name);
  return [...previous.lines.slice(0,previous.start),next.body.trimEnd(),'',...previous.lines.slice(previous.end)].join('\n');
}
async function baselineSources(repo, suite) {
  const files = {};
  const pending=[...suite.sourcePaths];
  while(pending.length) {
    const relative=safePath(pending.shift());
    if(Object.hasOwn(files,relative))continue;
    requireValue(Object.keys(files).length<150,'source-closure-limit');
    let content;
    try { content=execFileSync('git',['-c','safe.directory='+repo,'show',suite.baseline+':'+relative],
      {cwd:repo,maxBuffer:LIMIT,windowsHide:true,stdio:['ignore','pipe','pipe'],timeout:15000}).toString('utf8'); }
    catch { throw new Error('baseline-source-unavailable'); }
    files[relative]=content;
    for(const m of content.matchAll(/skills\/shared\/[\w./-]+\.md/g))pending.push(m[0]);
    // Same-skill references/ are not automatically closed over unless explicitly listed in sourcePaths;
    // see docs/superpowers-skill-evaluation.md for the documented synthetic-catalog limitation.
    for(const m of content.matchAll(/\]\(([^)\s]+)\)/g)) {
      let [target]=m[1].split(/[?#]/,1);
      if(/^[a-z][a-z0-9+.-]*:/i.test(target)||target.startsWith('//'))continue;
      const p=path.posix.normalize(path.posix.join(path.posix.dirname(relative),target));
      if(p.startsWith('skills/shared/'))pending.push(p);
    }
  }
  return files;
}
async function codeClosure(entry, repo) {
  const files={},pending=[entry];
  while(pending.length) {
    const relative=safePath(pending.shift());
    if(Object.hasOwn(files,relative))continue;
    requireValue(Object.keys(files).length<100,'collector-closure-limit');
    const bytes=await readUnder(repo,relative);
    files[relative]=bytes.toString('utf8');
    for(const specifier of staticImports(files[relative])) {
      if(specifier.startsWith('node:'))continue;
      requireValue(specifier.startsWith('.') && specifier.endsWith('.mjs'),'unsupported-collector-import');
      pending.push(path.posix.normalize(path.posix.join(path.posix.dirname(relative),specifier)));
    }
    for(const d of dynamicImports(files[relative])) {
      if(d.specifier){
        if(d.specifier.startsWith('node:'))continue;
        requireValue(d.specifier.startsWith('.') && d.specifier.endsWith('.mjs'),'unsupported-collector-import');
        pending.push(path.posix.normalize(path.posix.join(path.posix.dirname(relative),d.specifier)));
      } else {
        requireValue(relative===entry && files[relative].includes("'coordinator/check-output.mjs'"),'unsupported-collector-dynamic-import');
      }
    }
  }
  return files;
}
function catalogFor(input, sources) {
  return input.catalog.map(skill=>{
    const text=sources[skill.path];
    requireValue(typeof text==='string','catalog-source-unavailable');
    const declared=text.match(/^description: (.+)$/m)?.[1] ?? skill.name;
    if(skill.name==='aif-mode')requireValue(/^disable-model-invocation: true$/m.test(text),'explicit-only');
    return {...skill,description:declared,contentHash:hash(text)};
  });
}

export function preflight({runtime=unknownRuntime(),runtimeEvidence={},inputsVerified=false,catalogVerified=false,
  actionEvidenceComplete=false,catalogMode='synthetic-catalog',actions,executionId,catalog,expectedSkills=[],invocation='natural',turnHashes}={}) {
  const runtimeAssessment=assessRuntime(runtime,runtimeEvidence);
  const reasons=runtimeAssessment.unverifiedFields.map(f=>'runtime-'+f);
  for(const [ok,code]of [[inputsVerified,'inputs-unverified'],[catalogVerified,'catalog-unverified'],[actionEvidenceComplete,'actions-incomplete']])
    if(ok!==true)reasons.push(code);
  requireValue(['synthetic-catalog','instruction-only','installed-host'].includes(catalogMode),'invalid-catalog-mode');
  const actionAssessment=analyzeActions({actions,executionId,catalog,expectedSkills,invocation,turnHashes});
  if(!actionAssessment.eligible)reasons.push(...actionAssessment.reasons);
  if(catalogMode==='installed-host'&&actionAssessment.sourceKind!=='host')reasons.push('installed-host-evidence-missing');
  if(catalogMode==='installed-host'&&catalog?.some(s=>s.path.startsWith('injections/')))reasons.push('upstream-assembled-content-missing');
  return {schema:SCHEMA,writes:false,eligible:reasons.length===0,catalogMode,reasons,
    actionAssessment,status:reasons.length?'INCOMPLETE_NO_IMPROVEMENT_CLAIM':'PREREQUISITES_OBSERVED'};
}
export async function prepare({materialize=false,taskId,runtime=unknownRuntime(),repo=ROOT,fixtureRoot=FIXTURES,
  suiteFile=path.join(fixtureRoot,'manifest.json'),repetitions,runRoot}={}) {
  const suite=validateSuite(await json(suiteFile));
  const count=repetitions ?? suite.repetitions;
  requireValue(Number.isInteger(count)&&count>=1&&count<=5,'invalid-repetitions');
  const slots=suite.variants.reduce((n,v)=>n+v.caseIds.length*count*2,0);
  if(!materialize)return {schema:SCHEMA,status:'NOT_RUN',writes:false,cases:suite.cases.length,variants:suite.variants.length,slots};
  requireValue(runRoot===undefined,'existing-root-not-accepted');
  identifier(taskId);validateRuntime(runtime);
  repo=await realpath(repo);
  const original=await baselineSources(repo,suite);
  const code=await codeClosure(path.relative(repo,SCRIPT).replaceAll('\\','/'),repo);
  const collectorFiles=fingerprint(code),collectorHash=hash(collectorFiles);
  const checker=(await readUnder(fixtureRoot,'check-output.mjs')).toString('utf8');
  requireValue(staticImports(checker).every(specifier=>specifier.startsWith('node:')),
    'checker-must-be-self-contained');
  const inputs=Object.fromEntries(await Promise.all(suite.cases.map(async c=>[c.id,validateInput(JSON.parse((await readUnder(fixtureRoot,c.input)).toString('utf8')))])));
  const variants={};
  for(const variant of suite.variants) {
    const sources={...original};
    for(const i of variant.interventions) {
      const candidate=(i.candidate==='checkout'?await readUnder(repo,i.path):await readUnder(fixtureRoot,i.candidate)).toString('utf8');
      sources[i.path]=applyIntervention(original[i.path],candidate,i.selector);
      requireValue(hash(protectedMetadata(original[i.path],suite.protectedFields))===hash(protectedMetadata(sources[i.path],suite.protectedFields)),'protected-fields-changed');
    }
    variants[variant.id]=sources;
  }
  // Resolve everything before any run directory is created.
  for(const variant of suite.variants)for(const id of variant.caseIds)for(const sources of [original,variants[variant.id]])catalogFor(inputs[id],sources);
  const temp=await realpath(os.tmpdir());requireValue(!inside(repo,temp)&&repo!==temp,'temp-inside-repo');
  const root=await mkdtemp(path.join(temp,'aifhub-superpowers-'+taskId+'-'));
  const runId=randomUUID(),rows=[];
  for(const [vi,variant]of suite.variants.entries()) for(const caseId of variant.caseIds)for(let repetition=1;repetition<=count;repetition++) {
    const scenario=suite.cases.find(c=>c.id===caseId),input=inputs[caseId];
    const order=(vi+repetition)%2?['baseline','current']:['current','baseline'];
    for(const arm of order) {
      const sources=arm==='baseline'?original:variants[variant.id];
      const catalog=catalogFor(input,sources),executionId=randomUUID(),context='workers/'+executionId;
      const grader={criteria:scenario.criteria,allowedChanges:input.allowedChanges,expectedSkills:scenario.expectedSkills,
        invocation:scenario.invocation,kind:scenario.kind,condition:scenario.condition,acceptedStatuses:input.acceptedStatuses??['completed']};
      const task='Use the provided catalog and user turns. Work only in workspace/; resolve catalog sources inside instructions/. '
        +'Do not modify instructions/, catalog.json, turns.json, TASK.md or identity.json. Do not read other contexts, coordinator data, the source checkout or installed skills. '
        +'Do not install tools, access networks or credentials, launch workers, commit or publish. '
        +'Persistent file changes are authorized only at these exact workspace-relative paths: '+JSON.stringify(input.allowedChanges)+'. '
        +'Preserve other existing files and leave no other new files. Temporary local checks are permitted inside workspace/; remove temporary files you create unless their paths are authorized above. '
        +'Return output in this conversation. Follow the original user turn\'s response format; when that format permits, report observed checks and an honest outcome. '
        +'The coordinator supplies later turns verbatim after the appropriate response.\n\n'+input.turns[0]+'\n';
      const row={runId,executionId,pairId:runId+':'+variant.id+':'+caseId+':'+repetition,caseId,variantId:variant.id,arm,repetition,context,
        inputHash:hash({task,turns:input.turns,files:input.files}),instructionHash:hash(sources),catalogHash:hash(catalog),
        runtimeHash:hash(runtime),graderHash:hash({grader,checker:hash(checker)}),collectorHash,
        inputFiles:fingerprint(input.files),instructionFiles:fingerprint(sources),taskHash:hash(task),turnsHash:hash(input.turns.slice(0,1)),
        scriptedTurns:input.turns,grader};
      rows.push(row);
      await write(root,context+'/TASK.md',task);await write(root,context+'/identity.json',{executionId});
      await write(root,context+'/turns.json',input.turns.slice(0,1));await write(root,context+'/catalog.json',catalog);
      await mkdir(path.join(root,context,'workspace'));
      for(const [p,b]of Object.entries(input.files))await write(root,context+'/workspace/'+p,b);
      for(const [p,b]of Object.entries(sources))await write(root,context+'/instructions/'+p,b);
    }
  }
  const manifest={schema:SCHEMA,runId,taskId,suite,repetitions:count,rows,runtime,collectorFiles,collectorHash,
    checkerHash:hash(checker),node:process.version,platform:process.platform,arch:process.arch};
  for(const [p,b]of Object.entries(code))await write(root,'coordinator/code/'+p,b);
  await write(root,'coordinator/check-output.mjs',checker);
  await write(root,'coordinator/manifest.json',manifest);
  await write(root,'coordinator/OWNER.json',{schema:SCHEMA,runId,manifestHash:hash(manifest)});
  return {schema:SCHEMA,status:'NOT_RUN',runRoot:root,collector:path.join(root,'coordinator/code/scripts/superpowers-skill-eval.mjs'),
    rows:rows.map(r=>({executionId:r.executionId,context:path.join(root,r.context)})),slots:rows.length};
}
function matrixValid(manifest) {
  const expected=[];
  for(const v of manifest.suite.variants)for(const c of v.caseIds)for(let r=1;r<=manifest.repetitions;r++)for(const a of ['baseline','current'])expected.push([v.id,c,r,a].join(':'));
  const actual=manifest.rows.map(r=>[r.variantId,r.caseId,r.repetition,r.arm].join(':'));
  requireValue(hash(expected.sort())===hash(actual.sort()),'matrix-mismatch');
  unique(manifest.rows.map(r=>r.executionId),'duplicate-execution');
  for(const row of manifest.rows) {
    requireValue(row.runId===manifest.runId&&row.context==='workers/'+row.executionId,'row-identity-mismatch');
    const peer=manifest.rows.find(r=>r.pairId===row.pairId&&r.arm!==row.arm);
    requireValue(peer&&peer.variantId===row.variantId&&peer.caseId===row.caseId&&peer.repetition===row.repetition
      &&peer.inputHash===row.inputHash&&peer.runtimeHash===row.runtimeHash&&peer.graderHash===row.graderHash,'pair-mismatch');
  }
}
async function openRun(runRoot) {
  requireValue(typeof runRoot==='string','missing-run');
  const lexical=path.resolve(runRoot),root=await realpath(lexical),temp=await realpath(os.tmpdir());
  requireValue(!(await lstat(lexical)).isSymbolicLink()&&path.dirname(root)===temp&&path.basename(root).startsWith('aifhub-superpowers-'),'not-owned-run');
  const manifest=JSON.parse((await readUnder(root,'coordinator/manifest.json')).toString('utf8'));
  const owner=JSON.parse((await readUnder(root,'coordinator/OWNER.json')).toString('utf8'));
  requireValue(owner.schema===SCHEMA&&owner.runId===manifest.runId&&owner.manifestHash===hash(manifest),'manifest-drift');
  validateSuite(manifest.suite);matrixValid(manifest);
  requireValue(manifest.node===process.version&&manifest.platform===process.platform&&manifest.arch===process.arch,'runtime-platform-drift');
  const frozen=await tree(await under(root,'coordinator/code'));
  requireValue(hash(frozen)===manifest.collectorHash,'collector-drift');
  requireValue(path.resolve(SCRIPT)===path.join(root,'coordinator/code/scripts/superpowers-skill-eval.mjs'),'use-frozen-collector');
  requireValue(hash(await readUnder(root,'coordinator/check-output.mjs'))===manifest.checkerHash,'checker-drift');
  return {root,manifest};
}
async function inspectContext(root,row) {
  const context=await under(root,row.context);
  const sources=await tree(await under(context,'instructions'));
  requireValue(hash(sources)===hash(row.instructionFiles),'instruction-drift');
  requireValue(hash(await readUnder(context,'TASK.md'))===row.taskHash,'task-drift');
  requireValue(hash(JSON.parse((await readUnder(context,'turns.json')).toString('utf8')))===row.turnsHash,'turns-drift');
  const catalog=JSON.parse((await readUnder(context,'catalog.json')).toString('utf8'));
  requireValue(hash(catalog)===row.catalogHash,'catalog-drift');
  const id=JSON.parse((await readUnder(context,'identity.json')).toString('utf8'));
  requireValue(hash(id)===hash({executionId:row.executionId}),'worker-identity-drift');
  const files=await tree(await under(context,'workspace'));
  const changed=[...new Set([...Object.keys(files),...Object.keys(row.inputFiles)])].filter(p=>files[p]!==row.inputFiles[p]).sort();
  return {workspace:path.join(context,'workspace'),files,changed,catalog};
}
export async function collect({runRoot,executionId,report,observation}={}) {
  const {root,manifest}=await openRun(runRoot),row=manifest.rows.find(r=>r.executionId===executionId);
  requireValue(row,'unknown-execution');
  requireValue(observation?.observerRole==='coordinator'&&hash(observation.identity)===hash(identity(row)),'observation-identity');
  requireValue(typeof observation.provenance==='string'&&observation.provenance.trim(),'missing-provenance');
  requireValue(report?.executionId===executionId&&['completed','incomplete','failed'].includes(report.status),'invalid-report');
  requireValue(typeof report.summary==='string'&&report.summary.trim(),'missing-summary');
  requireValue(hash(validateRuntime(observation.runtime))===row.runtimeHash,'runtime-mismatch');
  const observed=await inspectContext(root,row);
  const readiness=preflight({...observation,catalogMode:manifest.suite.catalogMode,executionId,
    catalog:observed.catalog,expectedSkills:row.grader.expectedSkills,invocation:row.grader.invocation,turnHashes:row.scriptedTurns.map(hash)});
  const terminalOutcome=observation.actions?.events?.at(-1)?.type==='terminal'
    ?observation.actions.events.at(-1).outcome:null;
  requireValue(!terminalOutcome||report.status==='failed','terminal-status-mismatch');
  const requirements=row.grader.criteria.map(c=>{
    const value=observation.requirements?.[c.id];
    requireValue(value==null||(typeof value.met==='boolean'&&typeof value.evidence==='string'&&value.evidence.trim()),'invalid-requirement-evidence');
    return {id:c.id,met:value?.met??null,evidence:value?.evidence??null};
  });
  requireValue(Object.keys(observation.requirements??{}).every(id=>row.grader.criteria.some(c=>c.id===id)),'unknown-requirement');
  const checker=await import(pathToFileURL(path.join(root,'coordinator/check-output.mjs')).href);
  const behavior=await checker.checkOutput({caseId:row.caseId,kind:row.grader.kind,workspace:observed.workspace,report,inputFiles:row.inputFiles});
  requireValue(behavior&&[true,false,null].includes(behavior.passed),'invalid-behavior-result');
  let behaviorPassed=behavior.passed;
  if(behaviorPassed===null&&behavior.code==='manual-semantic-observation-required'&&observation.behavior!==undefined) {
    const judgment=observation.behavior;
    requireValue(judgment&&typeof judgment.passed==='boolean'&&typeof judgment.evidence==='string'&&judgment.evidence.trim()
      &&Object.keys(judgment).every(k=>['passed','evidence'].includes(k)),'invalid-behavior-evidence');
    behaviorPassed=judgment.passed;
  }
  const outside=observed.changed.filter(p=>!row.grader.allowedChanges.includes(p));
  const count=observation.unsupportedChecks;
  requireValue(count==null||(Number.isInteger(count.value)&&count.value>=0&&typeof count.evidence==='string'&&count.evidence.trim()),'invalid-count');
  const complete=readiness.eligible&&requirements.every(r=>r.met!==null)&&count!=null&&behaviorPassed!==null;
  const actionMetrics=readiness.actionAssessment.metrics;
  const unsupported=count==null||actionMetrics.unsupportedChecks===null?null:Math.max(count.value,actionMetrics.unsupportedChecks);
  const loadsPass=['missedLoads','wrongSkillLoads','prematureActions','unnecessaryLoads'].every(k=>actionMetrics[k]===0);
  const receipt={schema:SCHEMA,identity:identity(row),workspaceHash:hash(observed.files),changedFiles:observed.changed,requirements,
    eligible:complete,readiness,behaviorPassed,behaviorEvidence:behavior.passed===null?observation.behavior?.evidence??null:'independent-fixture-probe',unsupportedChecks:unsupported,actionMetrics,
    observedEvidence:{actions:observation.actions??null,runtimeEvidence:observation.runtimeEvidence??{},report:{status:report.status,summary:report.summary}},
    unnecessaryChanges:outside.length,pass:complete?!terminalOutcome&&row.grader.acceptedStatuses.includes(report.status)&&requirements.every(r=>r.met)&&!outside.length&&unsupported===0&&behaviorPassed&&loadsPass:null,
    evidenceMode:manifest.suite.catalogMode,provenance:observation.provenance};
  // Exclusive creation: no retry may overwrite an observation or rewrite history.
  const sealed={...receipt,digest:hash(receipt)};
  await write(root,'coordinator/receipts/'+executionId+'.json',sealed);
  return sealed;
}
export async function compare({runRoot}={}) {
  const {root,manifest}=await openRun(runRoot),receipts=[];
  for(const row of manifest.rows) {
    let receipt;
    try { receipt=JSON.parse((await readUnder(root,'coordinator/receipts/'+row.executionId+'.json')).toString('utf8')); }
    catch(e){if(e.code==='ENOENT')continue;throw e;}
    const {digest,...body}=receipt;
    requireValue(digest===hash(body),'receipt-drift');
    requireValue(receipt.schema===SCHEMA&&hash(receipt.identity)===hash(identity(row)),'receipt-identity');
    const observed=await inspectContext(root,row);
    requireValue(receipt.workspaceHash===hash(observed.files),'workspace-drift');
    receipts.push(receipt);
  }
  const eligible=receipts.length===manifest.rows.length&&receipts.every(r=>r.eligible);
  const variants=manifest.suite.variants.map(v=>{
    const rows=receipts.filter(r=>r.identity.variantId===v.id);
    const expected=v.caseIds.length*manifest.repetitions*2,complete=rows.length===expected&&rows.every(r=>r.eligible);
    const counts=Object.fromEntries(['baseline','current'].map(a=>[a,complete?rows.filter(r=>r.identity.arm===a&&r.pass).length:null]));
    const paired=complete?{improved:0,regressed:0,tied:0}:null,regressions=[];
    if(complete)for(const base of rows.filter(r=>r.identity.arm==='baseline')) {
      const current=rows.find(r=>r.identity.pairId===base.identity.pairId&&r.identity.arm==='current');
      paired[base.pass===current.pass?'tied':current.pass?'improved':'regressed']++;
      const criteria=base.requirements.filter(r=>r.met===true&&current.requirements.find(c=>c.id===r.id)?.met!==true).map(r=>r.id);
      const metrics=Object.keys(base.actionMetrics).filter(k=>current.actionMetrics[k]>base.actionMetrics[k]);
      const behavior=base.behaviorPassed===true&&current.behaviorPassed!==true;
      const scope=current.unnecessaryChanges>base.unnecessaryChanges;
      const checks=current.unsupportedChecks>base.unsupportedChecks;
      if(criteria.length||metrics.length||behavior||scope||checks||base.pass&&!current.pass)
        regressions.push({caseId:base.identity.caseId,repetition:base.identity.repetition,criteria,metrics,behavior,scope,checks});
    }
    const outcome=!complete?'unqualified':regressions.length?(paired.improved?'mixed':'regression'):paired.improved?'improvement':'tie';
    return {variantId:v.id,observations:rows.length,expected,eligible:complete,passed:counts,
      paired,regressions:complete?regressions:null,outcome,
      promotionEligible:complete&&outcome==='improvement'&&v.type!=='identity-control'
        &&manifest.repetitions>=3&&manifest.suite.catalogMode==='installed-host'};
  });
  return {schema:SCHEMA,status:!receipts.length?'NOT_RUN':eligible?'QUALIFIED_DESCRIPTIVE_RESULTS':'INCOMPLETE_NO_IMPROVEMENT_CLAIM',
    eligible,observations:receipts.length,expected:manifest.rows.length,variants,evidenceMode:manifest.suite.catalogMode};
}
async function main(args) {
  const action=args.shift()??'prepare',options={};
  while(args.length) {
    const flag=args.shift();
    requireValue(['--materialize','--task','--runtime','--fixtures','--suite','--repetitions','--run','--execution','--report','--observation','--evidence'].includes(flag),'unknown-flag');
    requireValue(!Object.hasOwn(options,flag),'duplicate-flag');
    if(flag==='--materialize')options[flag]=true;
    else { requireValue(args.length>0&&!args[0].startsWith('--'),'missing-argument');options[flag]=args.shift(); }
  }
  let result;
  if(action==='prepare')result=await prepare({materialize:options['--materialize']===true,taskId:options['--task'],
    runtime:options['--runtime']?await json(options['--runtime']):undefined,fixtureRoot:options['--fixtures'],suiteFile:options['--suite'],
    repetitions:options['--repetitions']?Number(options['--repetitions']):undefined});
  else if(action==='preflight') {requireValue(options['--evidence'],'missing-evidence');result=preflight(await json(options['--evidence']));}
  else if(action==='collect')result=await collect({runRoot:options['--run'],executionId:options['--execution'],
    report:await json(options['--report']),observation:await json(options['--observation'])});
  else if(action==='compare')result=await compare({runRoot:options['--run']});
  else throw new Error('unknown-action');
  process.stdout.write(JSON.stringify(result)+'\n');
}
if(process.argv[1]&&path.resolve(process.argv[1])===SCRIPT) {
  try { await main(process.argv.slice(2)); }
  catch(error) {process.stdout.write(JSON.stringify({schema:SCHEMA,ok:false,code: /^[a-z][a-z0-9-]+$/.test(error.message)?error.message:'evaluation-input-or-filesystem-error'})+'\n');process.exitCode=1;}
}
