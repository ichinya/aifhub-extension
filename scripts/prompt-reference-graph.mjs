// Allowlisted composition graph: never follow arbitrary prompt-provided paths.
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const PROMPT_REFERENCES = Object.freeze({
  'injections/core/aif-implement-plan-folder.md': [
    'injections/references/aif-implement/openspec-native.md',
    'injections/references/aif-implement/classic-sdd.md',
  ],
  'skills/aif-done/SKILL.md': [
    'skills/aif-done/references/openspec-finalization.md',
    'skills/aif-done/references/classic-finalization.md',
    'skills/aif-done/references/finalization-contract.md',
  ],
  'agent-files/claude/aifhub-implement-worker.md': ['injections/references/aif-implement/worker-claude.md'],
  'agent-files/codex/aifhub-implement-worker.toml': ['injections/references/aif-implement/worker-codex.md'],
  'skills/shared/QUESTION-TOOL.md': ['skills/shared/references/question-tool/examples.md'],
});
export const PROMPT_SUPPORT = Object.freeze([
  'skills/shared/TOOLS.md', 'skills/shared/LANGUAGE-POLICY.md', 'skills/shared/TEST-QUALITY.md',
  'skills/shared/TASK-COORDINATION.md', 'skills/shared/ISOLATED-EXECUTION.md',
  'skills/shared/references/test-quality-examples.md',
  'docs/workflow-mechanics.md', 'docs/isolated-execution.md',
]);

export async function validatePromptReferences(root) {
  const refs = [];
  for (const [source, targets] of Object.entries(PROMPT_REFERENCES)) {
    const text = await readFile(path.join(root, source), 'utf8');
    for (const target of targets) {
      if (!text.includes('`' + target + '`')) throw new Error('missing-required-reference-route');
      const bytes = await readFile(path.join(root, target));
      if (!bytes.length) throw new Error('empty-required-reference');
      refs.push({ source, target });
    }
  }
  for (const target of PROMPT_SUPPORT) {
    if (!(await readFile(path.join(root, target))).length) throw new Error('empty-required-reference');
  }
  return refs;
}

// Contract tests inspect the selected section plus its mandatory mode reference.
// Kernels are tested separately on raw bytes, especially marker-first boundaries.
export async function readPromptContract(root, source) {
  let text = await readFile(path.join(root, source), 'utf8');
  const targets = PROMPT_REFERENCES[source] ?? [];
  for (const target of targets) {
    const ref = await readFile(path.join(root, target), 'utf8');
    if (!text.includes('`' + target + '`')) throw new Error('missing-required-reference-route');
    if (target.endsWith('/openspec-native.md')) text = text.replace('### OpenSpec-native mode\n', ref.slice(ref.indexOf('### OpenSpec-native mode\n')) + '\n### OpenSpec-native mode\n');
    else if (target.endsWith('/classic-sdd.md')) text += '\n' + ref;
    else if (target.endsWith('/openspec-finalization.md')) text = text.replace('## OpenSpec-native mode\n', ref.slice(ref.indexOf('## OpenSpec-native mode\n')) + '\n## OpenSpec-native mode\n');
    else if (target.endsWith('/classic-finalization.md')) text = text.replace('## Legacy AI Factory-only mode\n', ref.slice(ref.indexOf('## Legacy AI Factory-only mode\n')) + '\n## Legacy AI Factory-only mode\n');
    else text += '\n' + ref;
  }
  return text;
}
