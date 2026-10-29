// Native classic sources remain authoritative; this adapter never repairs them.
import { createHash } from 'node:crypto';
import { parseSimpleYaml } from '../scripts/aif-artifact-sync.mjs';
import { readProviderFile } from '../scripts/provider-files.mjs';
import { classifyLegacyPlanShape } from '../scripts/legacy-plan-migration.mjs';
import { parseExecutionTasks } from '../scripts/execution-task-source.mjs';
import { parseClassicStatusProjection } from '../scripts/classic-status-projection.mjs';
import { createMarkdownCodeMask, findExactMarkdownH2Sections, markdownH2Spans } from '../scripts/markdown-structural-markers.mjs';
import { parseStrictJson } from '../scripts/json-strict.mjs';

const ADAPTER_VERSION = '0.2.0';
const LIMIT = 2 * 1024 * 1024;
const COMPANIONS = ['task.md', 'context.md', 'rules.md', 'verify.md', 'status.yaml'];
// Closed aliases for native template headings; fixed upstream tokens stay English.
const ALIASES = {
  summary: ['Summary', 'Резюме', 'Краткое описание'], scope: ['Scope', 'Область изменений', 'Объём работ'],
  requirements: ['Requirements', 'Требования'], approach: ['Approach', 'Подход'], research: ['Research Context', 'Контекст исследования'],
  allowed: ['Allowed Change Surface', 'Разрешённая область изменений'], forbidden: ['Forbidden Change Surface', 'Запрещённая область изменений'],
  intent: ['Intent', 'Why', 'Цель'], outcome: ['Target Outcome', 'What Changes', 'Ожидаемый результат'],
  acceptance: ['Acceptance Criteria', 'Критерии приёмки'], examples: ['Acceptance Examples', 'Примеры приёмки', 'Scenarios', 'Сценарии'],
  nonGoals: ['Non-goals', 'Не входит в объём работ'], constraints: ['Constraints', 'Ограничения'], assumptions: ['Assumptions', 'Допущения'],
  questions: ['Open Questions', 'Открытые вопросы'], verification: ['Verification Plan', 'План проверки'],
  refs: ['Document References', 'Ссылки на документы'], binding: ['AIFHub Source Binding']
};
export function createAdapter() { return { methodology: 'aifactory', version: ADAPTER_VERSION, resolveIdentity, validate, readContext,
  proposeEdits: async (_root, _identity, changes) => changes.map(change => ({ ...change, status: 'proposed' })) }; }
const reader = options => options.readSource ?? ((root, file) => readProviderFile(root, file, LIMIT));

async function resolveIdentity(root, changeId, options = {}) {
  const read = reader(options);
  const configBytes = await read(root, '.ai-factory/config.yaml');
  const config = parseSimpleYaml(configBytes?.toString('utf8') ?? '');
  const plans = (config.paths?.plans ?? '.ai-factory/plans').replaceAll('\\', '/').replace(/\/$/, '');
  const fast = (config.paths?.plan ?? '.ai-factory/PLAN.md').replaceAll('\\', '/');
  const requested = options.nativeTarget?.replace(/^@/, '').replaceAll('\\', '/');
  const isFast = requested === fast;
  const entrypoint = isFast ? fast : `${plans}/${changeId}.md`;
  const base = `${plans}/${changeId}`;
  if (isFast) return { planId: changeId, entrypoint, checklist: entrypoint, base, mode: 'fast', shape: 'fast', documents: [entrypoint] };
  if (options.preflightDirectory) await options.preflightDirectory(base);
  await read(root, entrypoint);
  const shape = await classifyLegacyPlanShape(changeId, { rootDir: root, plansDir: plans, useRecordedLegacyPlanSource: false });
  if (shape.shape === 'ultra-valid') return { planId: changeId, base, entrypoint: `${base}/index.md`, shape: shape.shape, mode: 'ultra', documents: [] };
  if (['collision', 'ultra-invalid'].includes(shape.shape)) return { planId: changeId, base, entrypoint, shape: shape.shape, errors: shape.errors, documents: [] };
  const documents = [entrypoint, ...COMPANIONS.map(name => `${base}/${name}`)];
  if (await read(root, `${base}/explore.md`) !== null) documents.push(`${base}/explore.md`);
  return { planId: changeId, entrypoint, checklist: `${base}/task.md`, base, shape: shape.shape, mode: 'full', documents };
}
async function validate(root, identity, options = {}) {
  if (identity.errors?.length) return identity.errors.map(({ code }) => ({ code }));
  if (identity.mode === 'ultra') return [];
  const errors = [];
  for (const file of identity.documents) if (await reader(options)(root, file) === null) {
    errors.push({ code: file === identity.entrypoint ? 'missing_plan_file' : 'missing_classic_companion', path: file });
  }
  return errors;
}
function sections(text, sourcePath, inventory, errors) {
  const spans = markdownH2Spans(text), bytes = Buffer.from(text);
  inventory.push(...spans.map(span => ({ ...span, source_path: sourcePath,
    sha256: createHash('sha256').update(bytes.subarray(span.start, span.end)).digest('hex') })));
  const get = names => {
    // Selection and duplicate detection must use the same span criterion:
    // tab-prefixed variants resolve to the same heading either way.
    const matches = spans.filter(span => names.includes(span.heading));
    if (matches.length > 1) errors.push({ code: 'duplicate_source_section' });
    return matches[0] ? bytes.subarray(matches[0].body_start, matches[0].end).toString('utf8') : '';
  };
  const result = Object.fromEntries(Object.entries(ALIASES).map(([key, names]) => [key, get(names).trim()]));
  return { ...result, original: get(['Original Request']), reconciliation: get(['Requirements Reconciliation']), sdd: get(['SDD Profile Inputs']).trim() };
}
const meaningful = value => value?.replace(/^#{1,6}[^\r\n]*$/gm, '').replace(/<!--[\s\S]*?-->/g, '').trim();
const list = value => meaningful(value) ? [value.trim()] : [];
const fact = value => {
  const content = meaningful(value);
  return content && !/^(?:[-*]\s*)?(?:\*\*)?(?:TODO|TBD|UNKNOWN|N\/A|не определено|уточнить)(?:\*\*)?[.!?…:]*$/i.test(content) ? value : '';
};
const requiredList = value => list(fact(value));
function researchFields(value) {
  const fields = {};
  let current = null;
  const lines = value.split(/\r\n|\n|\r/), mask = createMarkdownCodeMask(lines);
  for (const [index, line] of lines.entries()) {
    const match = !mask[index] && /^(Goal|Constraints|Decisions|Open questions):\s*(.*)$/.exec(line);
    if (match) { current = match[1]; fields[current] = match[2]; }
    else if (current) fields[current] += '\n' + line;
  }
  return fields;
}
function taskScopeSection(text, heading) {
  const lines = text.split(/\r\n|\n|\r/), mask = createMarkdownCodeMask(lines);
  const matches = [];
  for (let i = 0; i < lines.length; i++) {
    if (mask[i] || lines[i] !== `### ${heading}`) continue;
    let end = i + 1;
    while (end < lines.length && (mask[end] || !/^#{1,3}(?!#)[ \t]+/.test(lines[end]))) end++;
    matches.push(lines.slice(i + 1, end).join('\n').trim());
    i = end - 1;
  }
  return matches;
}
function declaredRefs(value) {
  return value.split(/\r\n|\n|\r/).flatMap(line => {
    const match = /^-\s+(?:`([^`]+)`|\[[^\]]+\]\(([^)]+)\)|([^\s]+))\s*$/.exec(line);
    return match ? [(match[1] ?? match[2] ?? match[3]).replaceAll('\\', '/')] : [];
  });
}
async function readContext(root, identity, options = {}) {
  const common = { adapter_version: ADAPTER_VERSION, public_mode: identity.mode, entrypoint: identity.entrypoint,
    checklist: identity.checklist ?? null, shape: identity.shape };
  if (identity.mode === 'ultra') return { ...common, upstream_handoff: { owner: 'upstream', entrypoint: identity.entrypoint }, errors: [] };
  const read = reader(options), errors = [], inventory = [];
  const texts = Object.fromEntries(await Promise.all(identity.documents.map(async file => [file, (await read(root, file)).toString('utf8')])));
  const parent = texts[identity.entrypoint];
  const s = sections(parent, identity.entrypoint, inventory, errors);
  const c = sections(identity.mode === 'full' ? texts[`${identity.base}/context.md`] : '', `${identity.base}/context.md`, inventory, errors);
  const research = researchFields(s.research);
  const parentTasks = parseExecutionTasks(parent), tasks = parseExecutionTasks(texts[identity.checklist]);
  if (JSON.stringify(parentTasks) !== JSON.stringify(tasks)) errors.push({ code: 'classic-checklist-mismatch' });
  let sourceBinding = null, projections = {};
  if (identity.mode === 'full') {
    try {
      const status = parseClassicStatusProjection(texts[`${identity.base}/status.yaml`], identity.planId, parent);
      sourceBinding = status.binding;
      projections[`${identity.base}/status.yaml`] = JSON.stringify(status.projection);
    } catch (error) { errors.push({ code: error.message }); }
  }
  let inputs = null;
  if (s.sdd) {
    const match = /^```json\r?\n([\s\S]+?)\r?\n```$/.exec(s.sdd);
    try { if (!match) throw new Error(); inputs = parseStrictJson(match[1]); }
    catch (error) { errors.push({ code: error.sddCode ?? 'invalid-sdd-inputs' }); }
  }
  const taskScope = taskScopeSection(texts[identity.checklist], 'In Scope');
  const taskForbidden = taskScopeSection(texts[identity.checklist], 'Out of Scope');
  if (taskScope.length > 1 || taskForbidden.length > 1) errors.push({ code: 'duplicate_source_section' });
  return { ...common, original_request: s.original, requirements_reconciliation: s.reconciliation,
    sections: inventory, document_projections: projections, source_binding: sourceBinding, sdd_inputs: inputs,
    requirements: { intent: fact(s.intent) || fact(s.summary), target_outcome: fact(s.outcome) || fact(s.scope) || fact(research.Goal?.trim()) || '',
      acceptance_criteria: requiredList(s.acceptance || s.requirements),
      constraints: [...list(s.constraints), ...list(c.constraints), ...list(research.Constraints), ...list(texts[`${identity.base}/rules.md`])],
      assumptions: [...list(s.assumptions), ...list(c.assumptions), ...list(research.Decisions)], open_questions: [...list(s.questions), ...list(c.questions), ...list(research['Open questions'])],
      verification_plan: [...requiredList(s.verification), ...requiredList(texts[`${identity.base}/verify.md`])] },
    tasks: tasks.map(task => ({ id: task.id, text: task.title, done: task.checked, source_path: identity.checklist })),
    acceptance_examples: list(s.examples), non_goals: list(s.nonGoals),
    change_surface: { allowed: requiredList(s.allowed || taskScope[0] || s.scope), forbidden: list(s.forbidden || taskForbidden[0]) },
    document_refs: [...new Set([...declaredRefs(s.refs), ...declaredRefs(c.refs)])].sort(), errors };
}
