// AI Factory native methodology adapter for the common plan resolver.
// V1 supports the legacy fast/full single-file forms and reports unsupported
// for ultra bundles; it does not replace the upstream plan lifecycle owner.
import { createHash } from 'node:crypto';
import path from 'node:path';
import { readProviderFile } from '../scripts/provider-files.mjs';

const ADAPTER_VERSION = '0.1.0';

export function createAdapter() {
  return {
    methodology: 'aifactory',
    version: ADAPTER_VERSION,
    resolveIdentity,
    readContext,
    validate,
    proposeEdits
  };
}

function sha256(value) { return createHash('sha256').update(value).digest('hex'); }

async function resolveIdentity(root, changeId, options) {
  const configFile = await readProviderFile(root, '.ai-factory/config.yaml', 2 * 1024 * 1024);
  const config = configFile ? parseSimpleYaml(configFile.toString('utf8')) : {};
  const planPath = config.paths?.plan ?? '.ai-factory/PLAN.md';
  const plansDir = config.paths?.plans ?? '.ai-factory/plans/';
  const planFile = `${plansDir.replace(/\/$/, '')}/${changeId}.md`;
  const bundleIndex = `${plansDir.replace(/\/$/, '')}/${changeId}/index.md`;
  const files = [planPath];
  for (const file of [planFile, bundleIndex]) {
    const bytes = await readProviderFile(root, file, 2 * 1024 * 1024);
    if (bytes !== null) files.push(file);
  }
  return { planId: changeId, changeId, documents: files, mode: files.length > 1 ? 'full' : 'fast' };
}

function parseSimpleYaml(raw) {
  const result = {};
  let current = result;
  let key = null;
  for (const line of (raw ?? '').split('\n')) {
    if (!line.trim() || line.startsWith('#')) continue;
    const match = /^(\s*)([\w-]+):\s*(.*)$/.exec(line);
    if (match) {
      const depth = match[1].length;
      const value = match[2];
      const rest = match[3];
      if (depth === 0) { current = result; key = value; }
      else if (current && key) current = result[key] = result[key] ?? {};
      if (rest === '') current[value] = {};
      else current[value] = rest.trim().replace(/^['"]|['"]$/g, '');
    }
  }
  return result;
}

async function readContext(root, identity) {
  const files = identity.documents.filter((file) => file.endsWith('.md'));
  let plan = '';
  let sourcePath = '.ai-factory/PLAN.md';
  for (const file of files) {
    const bytes = await readProviderFile(root, file, 4 * 1024 * 1024);
    if (bytes !== null) {
      plan = bytes.toString('utf8');
      sourcePath = file;
      break;
    }
  }
  const tasks = parseTasks(plan, sourcePath);
  return {
    adapter_version: ADAPTER_VERSION,
    public_mode: identity.mode === 'fast' ? 'fast' : 'full',
    original_request: '',
    requirements: {
      intent: '',
      target_outcome: '',
      constraints: [],
      assumptions: [],
      open_questions: [],
      acceptance_criteria: [],
      verification_plan: []
    },
    tasks,
    acceptance_examples: [],
    non_goals: [],
    change_surface: { allowed: [], forbidden: [] },
    errors: [{ code: 'aifactory-native-plan-parsing-incomplete' }]
  };
}

function parseTasks(content, sourcePath) {
  if (!content) return [];
  const lines = content.split('\n');
  const tasks = [];
  let id = 0;
  for (const line of lines) {
    const match = /^- \[( |x)\] (.+)$/.exec(line);
    if (match) {
      tasks.push({
        id: `task_${String(++id).padStart(3, '0')}`,
        text: match[2].trim(),
        done: match[1] === 'x',
        source_path: sourcePath
      });
    }
  }
  return tasks;
}

async function validate(root, identity) {
  const errors = [];
  for (const file of identity.documents) {
    const bytes = await readProviderFile(root, file, 4 * 1024 * 1024);
    if (bytes === null) errors.push({ code: 'missing_plan_file', path: file });
  }
  return errors;
}

async function proposeEdits(root, identity, changes) {
  return changes.map((change) => ({ ...change, status: 'proposed', target: change.target }));
}
