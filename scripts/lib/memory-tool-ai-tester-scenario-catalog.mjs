// memory-tool-ai-tester-scenario-catalog.mjs - authored ai-tester scenario catalog contracts
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const AI_TESTER_SCENARIO_CATALOG_SCHEMA = 'aifhub.memory_tools.ai_tester_scenario_catalog.v1';

const DEFAULT_ALLOWED_RUN_CLASSES = new Set(['screening', 'accepted_evidence', 'focused', 'smoke', 'safety']);
const DEFAULT_ALLOWED_CANDIDATE_MODES = new Set([
  'direct_tool_run_after_rg',
  'selector_expected_tool_run',
  'isolated_runtime_after_rg'
]);
const DEFAULT_ALLOWED_DECISIONS = new Set(['recommend', 'conditional', 'avoid', 'forbid']);

export async function loadAiTesterScenarioCatalog({ catalogPath, metadata = {}, cwd = process.cwd() } = {}) {
  if (!catalogPath) return null;
  const resolved = path.resolve(cwd, catalogPath);
  const raw = await readFile(resolved, 'utf8');
  return parseAiTesterScenarioCatalog(raw, {
    metadata,
    sourcePath: toPosix(path.relative(cwd, resolved))
  });
}

export function parseAiTesterScenarioCatalog(raw, options = {}) {
  const parsed = parseSimpleYaml(raw);
  const errors = validateAiTesterScenarioCatalog(parsed, options);
  if (errors.length > 0) {
    throw new Error(`Invalid ai-tester scenario catalog: ${errors.join('; ')}`);
  }
  return normalizeAiTesterScenarioCatalog(parsed, options);
}

export function validateAiTesterScenarioCatalog(catalog = {}, options = {}) {
  const metadata = options.metadata ?? {};
  const errors = [];
  if (catalog.schema !== AI_TESTER_SCENARIO_CATALOG_SCHEMA) {
    errors.push(`schema must be ${AI_TESTER_SCENARIO_CATALOG_SCHEMA}`);
  }
  const scenarios = asArray(catalog.scenarios);
  if (scenarios.length === 0) {
    errors.push('scenarios must contain at least one scenario');
  }

  const seen = new Set();
  const knownTools = new Set(Object.keys(metadata.tools ?? {}));
  const knownSkills = new Set(Object.keys(metadata.skill_usage_matrix ?? {}));
  const knownTasks = new Set(Object.keys(metadata.task_signals ?? {}));
  for (const [index, scenario] of scenarios.entries()) {
    const prefix = `scenarios[${index}]`;
    const id = String(scenario.id ?? '').trim();
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(id)) {
      errors.push(`${prefix}.id must be lowercase kebab/snake safe`);
    } else if (seen.has(id)) {
      errors.push(`${prefix}.id duplicates ${id}`);
    } else {
      seen.add(id);
    }

    if (!DEFAULT_ALLOWED_RUN_CLASSES.has(String(scenario.run_class ?? ''))) {
      errors.push(`${prefix}.run_class must be one of ${[...DEFAULT_ALLOWED_RUN_CLASSES].join(', ')}`);
    }

    const taskSignal = String(scenario.task_signal ?? '').trim();
    if (!taskSignal) {
      errors.push(`${prefix}.task_signal is required`);
    } else if (knownTasks.size > 0 && !knownTasks.has(taskSignal)) {
      errors.push(`${prefix}.task_signal is unknown: ${taskSignal}`);
    }

    const skills = asArray(scenario.skills).map(String);
    if (skills.length === 0) {
      errors.push(`${prefix}.skills must not be empty`);
    }
    for (const skill of skills) {
      if (!/^aif-[a-z0-9-]+$/.test(skill)) {
        errors.push(`${prefix}.skills contains unsafe skill: ${skill}`);
      } else if (knownSkills.size > 0 && !knownSkills.has(skill)) {
        errors.push(`${prefix}.skills contains unknown skill: ${skill}`);
      }
    }

    const tools = asArray(scenario.tools).map(String);
    if (tools.length === 0) {
      errors.push(`${prefix}.tools must not be empty`);
    }
    for (const tool of tools) {
      if (tool === 'rg') {
        errors.push(`${prefix}.tools must list candidate tools, not rg baseline`);
      } else if (!/^[a-z0-9][a-z0-9-]*$/.test(tool)) {
        errors.push(`${prefix}.tools contains unsafe tool: ${tool}`);
      } else if (knownTools.size > 0 && !knownTools.has(tool)) {
        errors.push(`${prefix}.tools contains unknown tool: ${tool}`);
      }
    }

    const pairedRuns = scenario.paired_runs ?? {};
    if (pairedRuns.baseline !== 'rg') {
      errors.push(`${prefix}.paired_runs.baseline must be rg`);
    }
    if (!DEFAULT_ALLOWED_CANDIDATE_MODES.has(String(pairedRuns.candidate_mode ?? ''))) {
      errors.push(`${prefix}.paired_runs.candidate_mode is unsupported`);
    }

    const promotion = scenario.promotion_policy ?? {};
    if (promotion.eligible_for_metadata === true) {
      const minPassPairs = Number(promotion.min_pass_pairs ?? 0);
      if (!Number.isFinite(minPassPairs) || minPassPairs < 1) {
        errors.push(`${prefix}.promotion_policy.min_pass_pairs must be >= 1 when metadata promotion is enabled`);
      }
      const allowedDecisions = asArray(promotion.allowed_decisions);
      for (const decision of allowedDecisions) {
        if (!DEFAULT_ALLOWED_DECISIONS.has(String(decision))) {
          errors.push(`${prefix}.promotion_policy.allowed_decisions contains unsupported decision: ${decision}`);
        }
      }
    }

    for (const label of catalogScenarioLabelSets(scenario).flat()) {
      if (!/^[A-Za-z0-9_.-]+$/.test(String(label))) {
        errors.push(`${prefix}.fixture_requirements contains unsafe label: ${label}`);
      }
    }
  }

  return errors;
}

export function filterScenarioCatalogEntries(catalog = null, filters = {}) {
  const scenarios = asArray(catalog?.scenarios);
  const scenarioIds = new Set(asArray(filters.scenarioIds));
  const runClasses = new Set(asArray(filters.runClasses));
  const skills = new Set(asArray(filters.skills));
  const tools = new Set(asArray(filters.tools));
  const tasks = new Set(asArray(filters.taskScenarios));
  return scenarios.filter((scenario) => (
    (scenarioIds.size === 0 || scenarioIds.has(scenario.id))
    && (runClasses.size === 0 || runClasses.has(scenario.run_class))
    && (tasks.size === 0 || tasks.has(scenario.task_signal))
    && (skills.size === 0 || asArray(scenario.skills).some((skill) => skills.has(skill)))
    && (tools.size === 0 || asArray(scenario.tools).some((tool) => tools.has(tool)))
  ));
}

export function scenarioMatchesProfileLabels(scenario, labels = new Set()) {
  const requirements = scenario.fixture_requirements ?? {};
  const labelsAll = asArray(requirements.labels_all);
  if (labelsAll.length > 0 && !labelsAll.every((label) => labels.has(String(label)))) {
    return false;
  }
  const labelsAny = asArray(requirements.labels_any);
  if (labelsAny.length === 0) return true;
  return labelsAny.some((set) => asArray(set).every((label) => labels.has(String(label))));
}

function normalizeAiTesterScenarioCatalog(catalog, options = {}) {
  return {
    schema: catalog.schema,
    source_path: options.sourcePath ?? null,
    defaults: catalog.defaults ?? {},
    scenarios: asArray(catalog.scenarios).map((scenario) => ({
      id: String(scenario.id),
      title: scenario.title ?? scenario.id,
      task_signal: String(scenario.task_signal),
      run_class: String(scenario.run_class),
      skills: asArray(scenario.skills).map(String),
      tools: asArray(scenario.tools).map(String),
      fixture_requirements: normalizeFixtureRequirements(scenario.fixture_requirements ?? {}),
      paired_runs: {
        baseline: scenario.paired_runs?.baseline ?? 'rg',
        candidate_mode: scenario.paired_runs?.candidate_mode ?? 'direct_tool_run_after_rg'
      },
      baseline_assertions: asArray(scenario.baseline_assertions).map(String),
      candidate_assertions: asArray(scenario.candidate_assertions).map(String),
      promotion_policy: normalizePromotionPolicy(scenario.promotion_policy ?? {})
    }))
  };
}

function normalizeFixtureRequirements(requirements = {}) {
  return {
    labels_any: asArray(requirements.labels_any).map((set) => asArray(set).map(String)),
    labels_all: asArray(requirements.labels_all).map(String)
  };
}

function normalizePromotionPolicy(policy = {}) {
  return {
    eligible_for_metadata: policy.eligible_for_metadata === true,
    min_pass_pairs: Number(policy.min_pass_pairs ?? 2),
    require_exact_labels: policy.require_exact_labels !== false,
    accepted_run_class: policy.accepted_run_class ?? null,
    allowed_decisions: asArray(policy.allowed_decisions).map(String)
  };
}

function catalogScenarioLabelSets(scenario) {
  const requirements = scenario.fixture_requirements ?? {};
  return [
    ...asArray(requirements.labels_any).map(asArray),
    asArray(requirements.labels_all)
  ];
}

function parseSimpleYaml(raw) {
  const root = {};
  const stack = [{ indent: -1, value: root, parent: null, key: null }];

  for (const rawLine of String(raw ?? '').split(/\r?\n/)) {
    const uncommented = stripInlineComment(rawLine);
    if (!uncommented.trim()) continue;

    const indent = uncommented.match(/^\s*/)[0].length;
    const content = uncommented.trim();

    while (stack.length > 1 && indent <= stack.at(-1).indent) {
      stack.pop();
    }

    let frame = stack.at(-1);

    if (content.startsWith('- ')) {
      frame = ensureArrayFrame(frame, stack);
      const itemRaw = content.slice(2).trim();
      const keyValue = itemRaw.match(/^([A-Za-z0-9_-]+):(?:\s*(.*?))?\s*$/);

      if (keyValue) {
        const item = {};
        frame.value.push(item);
        const key = keyValue[1];
        const rawValue = keyValue[2] ?? '';
        if (rawValue.length > 0) {
          item[key] = parseScalar(rawValue);
          stack.push({ indent, value: item, parent: frame.value, key: frame.value.length - 1 });
        } else {
          item[key] = {};
          stack.push({ indent, value: item, parent: frame.value, key: frame.value.length - 1 });
          stack.push({ indent: indent + 1, value: item[key], parent: item, key });
        }
      } else {
        frame.value.push(parseScalar(itemRaw));
      }
      continue;
    }

    const match = content.match(/^([A-Za-z0-9_-]+):(?:\s*(.*?))?\s*$/);
    if (!match) continue;

    const key = match[1];
    const rawValue = match[2] ?? '';
    const parent = frame.value;

    if (rawValue.length === 0) {
      parent[key] = {};
      stack.push({ indent, value: parent[key], parent, key });
    } else {
      parent[key] = parseScalar(rawValue);
    }
  }

  return root;
}

function ensureArrayFrame(frame, stack) {
  if (Array.isArray(frame.value)) return frame;
  if (frame.parent && frame.key !== null) {
    const array = [];
    frame.parent[frame.key] = array;
    frame.value = array;
    stack[stack.length - 1] = frame;
    return frame;
  }
  throw new Error('Invalid YAML list placement.');
}

function parseScalar(value) {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) return '';
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
    || (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  const lower = trimmed.toLowerCase();
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) return parseInlineList(trimmed);
  if (lower === 'true') return true;
  if (lower === 'false') return false;
  if (lower === 'null') return null;
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
  return trimmed;
}

function parseInlineList(value) {
  const body = String(value ?? '').trim().slice(1, -1).trim();
  if (!body) return [];
  return splitInlineListItems(body).map((item) => parseScalar(item));
}

function splitInlineListItems(value) {
  const items = [];
  let quote = null;
  let depth = 0;
  let current = '';
  const raw = String(value ?? '');

  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if ((char === '"' || char === "'") && (index === 0 || raw[index - 1] !== '\\')) {
      quote = quote === char ? null : quote ?? char;
      current += char;
      continue;
    }
    if (quote === null && char === '[') depth += 1;
    if (quote === null && char === ']') depth -= 1;
    if (char === ',' && quote === null && depth === 0) {
      items.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim().length > 0) items.push(current.trim());
  return items;
}

function stripInlineComment(value) {
  let quote = null;
  const raw = String(value ?? '');
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if ((char === '"' || char === "'") && (index === 0 || raw[index - 1] !== '\\')) {
      quote = quote === char ? null : quote ?? char;
      continue;
    }
    if (char === '#' && quote === null && (index === 0 || /\s/.test(raw[index - 1]))) {
      return raw.slice(0, index);
    }
  }
  return raw;
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null || value === '') return [];
  return [value];
}

function toPosix(value) {
  return String(value).replaceAll(path.sep, '/');
}
