// OpenSpec methodology adapter for the common plan resolver.
// Reads canonical OpenSpec change artifacts and exposes a methodology-neutral
// plan context. Does not modify canonical artifacts.
import { createHash } from 'node:crypto';
import path from 'node:path';
import { findExactMarkdownH2Sections } from '../scripts/markdown-structural-markers.mjs';
import { parseStrictJson } from '../scripts/json-strict.mjs';
import { readProviderFile } from '../scripts/provider-files.mjs';

const ADAPTER_VERSION = '0.1.0';
const SDD_SIGNALS_HEADING = 'SDD Profile Inputs';

export function createAdapter() {
  return {
    methodology: 'openspec',
    version: ADAPTER_VERSION,
    resolveIdentity,
    readContext,
    validate,
    proposeEdits
  };
}

function planError(code) {
  const error = new Error(code);
  error.planCode = code;
  return error;
}

function sha256(value) { return createHash('sha256').update(value).digest('hex'); }

async function resolveIdentity(root, changeId) {
  const base = `openspec/changes/${changeId}`;
  const documents = [`${base}/proposal.md`, `${base}/tasks.md`];
  const optional = [`${base}/design.md`, `${base}/.openspec.yaml`, `${base}/design.context.json`];
  for (const file of optional) {
    const bytes = await readProviderFile(root, file, 4 * 1024 * 1024);
    if (bytes !== null) documents.push(file);
  }
  const specsDir = `${base}/specs`;
  // Simple spec discovery: up to 2 levels.
  await collectSpecs(root, specsDir, documents, 0);
  return { planId: changeId, changeId, base, documents };
}

async function collectSpecs(root, dir, documents, depth) {
  if (depth > 2) return;
  try {
    const { readdir } = await import('node:fs/promises');
    const entries = await readdir(path.posix.join(root, dir), { withFileTypes: true });
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const file = `${dir}/${entry.name}`;
      if (entry.isDirectory()) await collectSpecs(root, file, documents, depth + 1);
      else if (entry.isFile() && entry.name.endsWith('.md')) documents.push(file);
    }
  } catch { /* missing directory is fine */ }
}

function section(content, heading) {
  if (!content) return null;
  const sections = findExactMarkdownH2Sections(content, heading);
  if (sections.length > 1) throw planError('duplicate_source_section');
  if (sections.length === 0) return null;
  return sections[0].join('\n').trim();
}

function readSections(proposal, design, heading) {
  const sections = [];
  for (const content of [proposal, design]) {
    const value = section(content, heading);
    if (value) sections.push(value);
  }
  return sections;
}

function parseTasks(tasksContent, sourcePath) {
  if (!tasksContent) return [];
  const lines = tasksContent.split(/\r\n|\n|\r/);
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

function parseSddInputs(proposal) {
  const inputsSection = section(proposal, SDD_SIGNALS_HEADING);
  if (!inputsSection) return null;
  const match = /^```json\n([\s\S]+?)\n```$/s.exec(inputsSection);
  if (!match) throw planError('invalid-sdd-inputs');
  try { return parseStrictJson(match[1]); } catch (error) { throw planError(error.sddCode ?? 'invalid-sdd-inputs'); }
}

async function readContext(root, identity) {
  const proposalBytes = await readProviderFile(root, `${identity.base}/proposal.md`, 4 * 1024 * 1024);
  const proposal = proposalBytes ? proposalBytes.toString('utf8') : '';
  const designBytes = await readProviderFile(root, `${identity.base}/design.md`, 4 * 1024 * 1024);
  const design = designBytes ? designBytes.toString('utf8') : '';
  const tasksBytes = await readProviderFile(root, `${identity.base}/tasks.md`, 4 * 1024 * 1024);
  const tasksContent = tasksBytes ? tasksBytes.toString('utf8') : '';
  const sddInputs = parseSddInputs(proposal);
  const tasks = parseTasks(tasksContent, `${identity.base}/tasks.md`);
  const intent = section(proposal, 'Why');
  const targetOutcome = section(proposal, 'What Changes');
  const constraints = readSections(proposal, design, 'Constraints');
  const assumptions = readSections(proposal, design, 'Assumptions');
  const openQuestions = readSections(proposal, design, 'Open Questions');
  const acceptanceCriteria = readSections(proposal, design, 'Acceptance Criteria');
  const acceptanceExamples = readSections(proposal, design, 'Acceptance Examples');
  const nonGoals = readSections(proposal, design, 'Non-goals');
  const allowed = readSections(proposal, design, 'Allowed Change Surface');
  const forbidden = readSections(proposal, design, 'Forbidden Change Surface');
  const verificationPlan = readSections(proposal, design, 'Verification Plan');
  const originalRequest = section(proposal, 'Original Request') ?? '';

  return {
    adapter_version: ADAPTER_VERSION,
    public_mode: sddInputs?.planning_mode ?? null,
    sdd_inputs: sddInputs,
    original_request: originalRequest,
    requirements: {
      intent: intent ?? '',
      target_outcome: targetOutcome ?? '',
      constraints,
      assumptions,
      open_questions: openQuestions,
      acceptance_criteria: acceptanceCriteria,
      verification_plan: verificationPlan
    },
    tasks,
    acceptance_examples: acceptanceExamples,
    non_goals: nonGoals,
    change_surface: { allowed, forbidden }
  };
}

async function validate(root, identity) {
  const errors = [];
  const proposal = await readProviderFile(root, `${identity.base}/proposal.md`, 4 * 1024 * 1024);
  if (proposal === null) errors.push({ code: 'missing_proposal', path: `${identity.base}/proposal.md` });
  const tasks = await readProviderFile(root, `${identity.base}/tasks.md`, 4 * 1024 * 1024);
  if (tasks === null) errors.push({ code: 'missing_tasks', path: `${identity.base}/tasks.md` });
  return errors;
}

async function proposeEdits(root, identity, changes) {
  // OpenSpec adapter only proposes edits; applying them is coordinator-owned.
  return changes.map((change) => ({ ...change, status: 'proposed', target: `${identity.base}/${change.target}` }));
}
