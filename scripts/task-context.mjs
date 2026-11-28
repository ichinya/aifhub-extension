import path from 'node:path';
import { normalizeChangeId } from './active-change-resolver.mjs';
import { planResolverError, resolvePlanContext } from './common-plan-resolver.mjs';
import { parseExecutionTasks } from './execution-task-source.mjs';
import { parseSimpleYaml } from './aif-artifact-sync.mjs';
import { collectGeneratedRules } from './openspec-execution-context.mjs';
import { inspectOpenSpecGeneratedRules, inventoryOpenSpecChanges } from './openspec-rules-compiler.mjs';
import { digest, readProviderFile, safeProviderPath } from './provider-files.mjs';
import { inspectSessionBrief, openSpecProjectRulePaths } from './session-brief.mjs';
import { parseToolConfig } from './tool-config.mjs';

const DEFAULT_LIMIT = 4 * 1024 * 1024;
const CONFIG_PATH = '.ai-factory/config.yaml';
const GENERATED_PATH = '.ai-factory/rules/generated';
const TASK_ID = /^(?:(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*))*|task-[1-9]\d*)$/;
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (values.has(flag)) return null;
    if (flag === '--json') {
      values.set(flag, true);
      continue;
    }
    if (flag !== '--change' && flag !== '--task') return null;
    const value = argv[++index];
    if (!value || value.startsWith('--')) return null;
    values.set(flag, value);
  }
  const changeId = values.get('--change');
  const taskId = values.get('--task');
  const normalized = normalizeChangeId(changeId);
  if (!normalized.ok || normalized.changeId !== changeId || !taskId || taskId.length > 80 || !TASK_ID.test(taskId)) return null;
  return { changeId, taskId };
}

async function resolveTaskSelection(rootDir, changeId, taskId, options) {
  const base = `openspec/changes/${changeId}`;
  const checklist = `${base}/tasks.md`;
  const read = options.readSource ?? readProviderFile;
  const config = await read(rootDir, CONFIG_PATH, 256 * 1024);
  if (parseToolConfig(config ? utf8.decode(config) : '').mode !== 'openspec') throw planResolverError('openspec_mode_required');
  await safeProviderPath(rootDir, `${base}/specs`);
  let checklistBytes;
  const plan = await resolvePlanContext({
    rootDir, changeId, methodology: 'openspec',
    async readSource(root, file, limit = DEFAULT_LIMIT) {
      if (file === CONFIG_PATH) return config;
      const bytes = await read(root, file, limit);
      if (file === checklist) checklistBytes = bytes;
      return bytes;
    }
  });
  if (plan.errors.length) throw planResolverError(plan.errors[0].code);
  if (!checklistBytes) throw planResolverError('missing_plan_file');
  const text = utf8.decode(checklistBytes);
  const headingLines = [];
  const tasks = parseExecutionTasks(text, { locations: true, headingLines });
  const task = tasks.find(item => item.id === taskId);
  if (!task) throw planResolverError('unknown-or-ambiguous-task');
  return { plan, task, config, section: taskSection(checklist, checklistBytes, text, task, headingLines) };
}

function taskSection(checklist, bytes, text, task, headingLines) {
  const starts = [0];
  for (const newline of text.matchAll(/\r\n|\n|\r/g)) {
    const next = newline.index + newline[0].length;
    if (next < text.length) starts.push(next);
  }
  const start = headingLines.findLast(line => line <= task.line) ?? 0;
  const end = headingLines.find(line => line > task.line) ?? starts.length;
  const startByte = Buffer.byteLength(text.slice(0, starts[start]));
  const endByte = end === starts.length ? bytes.length : Buffer.byteLength(text.slice(0, starts[end]));
  return { path: checklist, start_line: start + 1, end_line: end, markdown: utf8.decode(bytes.subarray(startByte, endByte)) };
}

async function inspectTaskContext(rootDir, selection, readSource) {
  const { plan, config } = selection;
  const changeId = plan.change_id;
  const modeHandoff = `/aif-mode sync --change ${changeId}`;
  const inventory = await inventoryOpenSpecChanges({ rootDir });
  if (!inventory.ok) return blockedContext(inventory.errors.map(({ code }) => code), 'aif-plan');
  const membership = await inspectOpenSpecGeneratedRules({ rootDir, activeChangeIds: inventory.changeIds });
  if (!membership.ok) return blockedContext(membership.errors.map(({ code }) => code), modeHandoff);

  const inspected = await inspectSessionBrief({ rootDir, changeId, includeBrief: true });
  if (inspected.status !== 'valid' && inspected.status !== 'disabled') {
    return { context: briefStatus(inspected), rules: emptyRules(), owner_handoff: briefHandoff(inspected, changeId) };
  }
  const project = parseSimpleYaml(config ? utf8.decode(config) : '');
  const projectRefs = await projectRuleReferences(rootDir, project, readSource);
  const generated = await generatedRuleReferences(rootDir, changeId, membership, readSource);
  const { brief, status } = inspected;
  if (status === 'valid' && !await matchesSnapshot(rootDir, selection, brief, [...projectRefs, ...generated.refs], readSource)) {
    return {
      context: briefStatus({ status: 'stale', stale_reasons: ['sources_changed_during_read'] }),
      rules: emptyRules(), owner_handoff: 'aif-plan'
    };
  }
  const basis = brief ?? { ...plan.requirements, change_surface: plan.change_surface };
  const refs = brief?.context_manifest.filter(ref => !ref.path.startsWith(`${GENERATED_PATH}/`))
    ?? await canonicalFallbackRefs(rootDir, plan, readSource);
  return {
    context: {
      ...briefStatus(inspected), ...(brief ? { digest: brief.digest } : {}),
      intent: basis.intent ?? null, target_outcome: basis.target_outcome ?? null,
      constraints: basis.constraints ?? [], change_surface: basis.change_surface, refs
    },
    rules: { project: projectRefs, generated },
    ...(generated.status !== 'verified' ? { owner_handoff: modeHandoff } : {})
  };
}

async function canonicalFallbackRefs(rootDir, plan, readSource) {
  const refs = plan.documents.map(({ path, sha256 }) => ({ path, sha256, fidelity: 'full' }));
  const deltaRoot = `openspec/changes/${plan.change_id}/specs/`;
  for (const document of plan.documents) {
    if (!document.path.startsWith(deltaRoot) || path.posix.basename(document.path) !== 'spec.md') continue;
    const file = `openspec/specs/${document.path.slice(deltaRoot.length)}`;
    const bytes = await readSource(rootDir, file, DEFAULT_LIMIT);
    if (bytes) refs.push({ path: file, sha256: digest(bytes), fidelity: 'full' });
  }
  return refs;
}

function briefStatus(inspected) {
  return {
    status: inspected.status,
    stale_reasons: inspected.stale_reasons ?? [], blocked_reasons: inspected.blocked_reasons ?? []
  };
}

function briefHandoff(inspected, changeId) {
  if (inspected.owner_handoff) return inspected.owner_handoff;
  const reasons = inspected.stale_reasons ?? [];
  const ordinaryDrift = inspected.status === 'stale' && !reasons.includes('invalid_brief')
    && (reasons.includes('source_revision_changed') || reasons.includes('missing_runtime_artifact'));
  return inspected.status === 'missing' || ordinaryDrift
    ? `ai-factory aifhub-session-brief compile --change ${changeId} --json`
    : 'aif-plan';
}

function emptyRules(status = 'unverified') {
  return { project: [], generated: { status, refs: [], diagnostics: [] } };
}

function blockedContext(reasons, ownerHandoff) {
  return {
    context: briefStatus({ status: 'blocked', blocked_reasons: reasons }),
    rules: emptyRules('invalid'), owner_handoff: ownerHandoff
  };
}

async function projectRuleReferences(rootDir, project, readSource) {
  const paths = new Set(openSpecProjectRulePaths(project));
  const refs = [];
  for (const file of paths) {
    if (!file) continue;
    if (file === GENERATED_PATH || file.startsWith(`${GENERATED_PATH}/`)) throw planResolverError('unsafe_project_rule');
    const bytes = await readSource(rootDir, file, DEFAULT_LIMIT);
    if (bytes) refs.push({ path: file, sha256: digest(bytes), fidelity: 'full' });
  }
  return refs;
}

async function generatedRuleReferences(rootDir, changeId, membership, readSource) {
  const generated = await collectGeneratedRules(changeId, { rootDir, strict: true, readSource });
  const selected = generated.generatedRules;
  const missing = membership.indexState === 'missing' || membership.missingActiveIndexEntries.includes(changeId)
    || selected.some(item => !item.exists);
  const status = missing ? 'missing' : selected.some(item => item.stale === true) ? 'stale'
    : selected.every(item => item.verified) ? 'verified' : 'unverified';
  const refs = status === 'verified' ? selected.map(item => ({
    path: item.path, kind: item.kind, sha256: item.sha256.slice('sha256:'.length), fidelity: 'full'
  })) : [];
  return { status, refs, diagnostics: [...new Set(generated.warnings.map(({ code }) => code))] };
}

async function matchesSnapshot(rootDir, { plan, config }, brief, ruleRefs, readSource) {
  if (brief.plan_context.source_revision !== plan.source_revision) return false;
  const expected = new Map(brief.context_manifest.map(ref => [ref.path, ref.sha256]));
  if (expected.get(CONFIG_PATH) !== (config ? digest(config) : undefined)) return false;
  if (ruleRefs.some(ref => expected.get(ref.path) !== ref.sha256)) return false;
  for (const { path: file, sha256 } of brief.context_manifest) {
    const bytes = await readSource(rootDir, file, DEFAULT_LIMIT);
    if (!bytes || digest(bytes) !== sha256) return false;
  }
  return true;
}

function renderResult(result, lineEnding = '\n') {
  const { task_id: taskId, task, section, context, rules, owner_handoff: handoff } = result;
  const refs = [...(context.refs ?? []), ...rules.project, ...rules.generated.refs];
  const details = [
    `SessionBrief: ${context.status}${context.digest ? ` (${context.digest})` : ''}`,
    `Generated rules: ${rules.generated.status}`,
    ...context.stale_reasons, ...context.blocked_reasons, ...rules.generated.diagnostics,
    context.intent, context.target_outcome, ...(context.constraints ?? []),
    ...(context.change_surface?.allowed ?? []), ...(context.change_surface?.forbidden ?? []),
    ...new Set(refs.map(ref => `${ref.path} sha256=${ref.sha256} fidelity=${ref.fidelity}`)),
    handoff && `Owner handoff: ${handoff}`
  ].filter(Boolean);
  return `Task ${taskId}: ${section.path}:${task.line}\n\n${section.markdown}${lineEnding}${details.join('\n')}\n`;
}

export async function runTaskContextCommand(argv, options = {}) {
  const json = argv.includes('--json');
  const stdout = options.stdout ?? process.stdout;
  const args = parseArguments(argv);
  let error = 'invalid_task_arguments';
  if (args) {
    try {
      const rootDir = path.resolve(options.rootDir ?? process.cwd());
      const selection = await resolveTaskSelection(rootDir, args.changeId, args.taskId, options);
      const { plan, task, section } = selection;
      const context = await inspectTaskContext(rootDir, selection, options.readSource ?? readProviderFile);
      const ok = context.context.status === 'valid' || context.context.status === 'disabled';
      const result = {
        schema: 'aifhub.task_context.v1', ok, change_id: plan.change_id, task_id: task.id,
        task: { line: task.line + 1, checked: task.checked }, section, source_revision: plan.source_revision,
        ...context
      };
      stdout.write(json ? `${JSON.stringify(result, null, 2)}\n` : renderResult(result));
      if ((options.env ?? process.env).LOG_LEVEL === 'debug') {
        (options.stderr ?? process.stderr).write(`${JSON.stringify({ event: 'task-context', status: result.context.status, ok })}\n`);
      }
      return ok ? 0 : 1;
    } catch (failure) {
      const code = failure.planResolverCode ?? failure.code ?? failure.message;
      error = typeof code === 'string' && /^[a-z0-9_-]{1,80}$/.test(code) ? code : 'task_context_failed';
    }
  }
  stdout.write(json ? `${JSON.stringify({ ok: false, error })}\n` : `Task context: ${error}\n`);
  return 2;
}
