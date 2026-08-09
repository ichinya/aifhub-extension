// aif-plan-openspec-artifacts.test.mjs - instruction-level tests for OpenSpec-native planning
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

async function readRepoFile(relativePath) {
  return readFile(join(REPO_ROOT, relativePath), 'utf8');
}

function assertIncludes(source, expected, label) {
  assert.ok(
    source.includes(expected),
    `${label} should include ${JSON.stringify(expected)}`
  );
}

function assertNotIncludes(source, unexpected, label) {
  assert.ok(
    !source.includes(unexpected),
    `${label} should not include ${JSON.stringify(unexpected)}`
  );
}

function assertOrder(source, orderedFragments, label) {
  let cursor = -1;

  for (const fragment of orderedFragments) {
    const index = source.indexOf(fragment, cursor + 1);
    assert.notEqual(index, -1, `${label} should include ${JSON.stringify(fragment)} after index ${cursor}`);
    assert.ok(index > cursor, `${label} should order ${JSON.stringify(fragment)} after previous fragment`);
    cursor = index;
  }
}

function extractSection(markdown, heading) {
  const lines = markdown.split(/\r?\n/);
  let inFence = false;
  let start = -1;
  let end = lines.length;

  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].startsWith('```')) {
      inFence = !inFence;
      continue;
    }

    if (!inFence && lines[index] === `### ${heading}`) {
      start = index + 1;
      break;
    }
  }

  assert.notEqual(start, -1, `Expected section heading: ### ${heading}`);

  inFence = false;
  for (let index = start; index < lines.length; index += 1) {
    if (lines[index].startsWith('```')) {
      inFence = !inFence;
      continue;
    }

    if (!inFence && lines[index].startsWith('### ')) {
      end = index;
      break;
    }
  }

  return lines.slice(start, end).join('\n');
}

describe('aif-plan OpenSpec-native planning contract', () => {
  it('defines mode-gated OpenSpec-native and legacy sections', async () => {
    const injection = await readRepoFile('injections/core/aif-plan-plan-folder.md');
    const openspec = extractSection(injection, 'OpenSpec-native mode');
    const legacy = extractSection(injection, 'Legacy AI Factory-only mode');

    assertIncludes(openspec, 'aifhub.artifactProtocol: openspec', 'OpenSpec-native section');
    assertIncludes(openspec, 'OpenSpec-native instructions override legacy plan-folder instructions', 'OpenSpec-native section');
    assertIncludes(legacy, 'When OpenSpec-native mode is not enabled', 'Legacy section');
    assertIncludes(legacy, '.ai-factory/plans/<plan-id>.md', 'Legacy section');
    assertIncludes(legacy, '.ai-factory/plans/<plan-id>/task.md', 'Legacy section');
  });

  it('requires canonical OpenSpec change artifacts without legacy plan companion files', async () => {
    const injection = await readRepoFile('injections/core/aif-plan-plan-folder.md');
    const openspec = extractSection(injection, 'OpenSpec-native mode');

    for (const expected of [
      'openspec/changes/<change-id>/proposal.md',
      'openspec/changes/<change-id>/design.md',
      'openspec/changes/<change-id>/tasks.md',
      'openspec/changes/<change-id>/specs/<capability>/spec.md'
    ]) {
      assertIncludes(openspec, expected, 'OpenSpec-native section');
    }

    for (const unexpected of [
      '.ai-factory/plans/<id>.md',
      '.ai-factory/plans/<id>/task.md',
      '.ai-factory/plans/<id>/context.md',
      '.ai-factory/plans/<id>/rules.md',
      '.ai-factory/plans/<id>/verify.md',
      '.ai-factory/plans/<id>/status.yaml'
    ]) {
      assertNotIncludes(openspec, unexpected, 'OpenSpec-native section');
    }
  });

  it('documents OpenSpec artifact templates and delta requirements', async () => {
    const injection = await readRepoFile('injections/core/aif-plan-plan-folder.md');
    const openspec = extractSection(injection, 'OpenSpec-native mode');

    for (const expected of [
      '# Proposal: <Title>',
      '## Intent',
      '## Scope',
      '## Approach',
      '## Risks / Open Questions',
      '# Design: <Title>',
      '## Technical Approach',
      '## Data / Artifact Model',
      '# Tasks',
      '## ADDED Requirements',
      '## MODIFIED Requirements',
      '## REMOVED Requirements',
      '#### Scenario: <Scenario name>',
      'openspec/changes/<change-id>/.openspec.yaml',
      'skip_specs: true',
      '>=1.7.0',
      'older supported CLI'
    ]) {
      assertIncludes(openspec, expected, 'OpenSpec-native section');
    }
  });

  it('requires task intake normalization before writing OpenSpec artifacts', async () => {
    const injection = await readRepoFile('injections/core/aif-plan-plan-folder.md');
    const openspec = extractSection(injection, 'OpenSpec-native mode');

    assertIncludes(openspec, '#### Task Intake Normalization', 'aif-plan OpenSpec-native section');
    assertOrder(
      openspec,
      ['#### Task Intake Normalization', '#### Required artifact shape'],
      'aif-plan OpenSpec-native section'
    );

    for (const expected of [
      'task type',
      'goal',
      'non-goals',
      'constraints',
      'assumptions',
      'impacted capabilities',
      'C4 impact',
      'ADR candidates',
      'dependency graph',
      'acceptance criteria',
      'open questions',
      'suggested next command',
      '`proposal.md` for intent, scope, non-goals, approach, assumptions, risks, and open questions',
      '`design.md` for technical approach, C4 impact, ADR candidates, dependency graph, integration points, alternatives, and risks',
      '`tasks.md` for an executable implementation checklist',
      '`specs/**/spec.md` for behavior-changing requirements and scenarios',
      'Raw input trace, normalization confidence, and temporary notes are runtime state only',
      'may be persisted only under `.ai-factory/state/<change-id>/`',
      'must never be written under `openspec/changes/<change-id>/`'
    ]) {
      assertIncludes(openspec, expected, 'aif-plan OpenSpec-native section');
    }

    for (const expected of [
      '`/aif-task-prepare`',
      '`.ai-factory/specs/<task-id>.md`',
      '`task-prepare.md`',
      'legacy companion files under `openspec/changes/<change-id>/`',
      'must not be created'
    ]) {
      assertIncludes(openspec, expected, 'aif-plan OpenSpec-native forbidden artifacts');
    }
  });

  it('preserves multiline Original Request input and commits revision-bound research context', async () => {
    const injection = await readRepoFile('injections/core/aif-plan-plan-folder.md');
    const openspec = extractSection(injection, 'OpenSpec-native mode');
    const label = 'injections/core/aif-plan-plan-folder.md Original Request and Research Context contract';

    assertOrder(openspec, ['## Original Request', '## Intent'], `${label} section ordering`);

    for (const expected of [
      'recognized invocation tokens that occur in command positions',
      'Do not remove words such as `full`, `fast`, `--list`, or `--parallel` when they occur inside the actual request text',
      'request wording, casing, punctuation, internal whitespace, and line breaks exactly',
      'If planning starts only from the resolved research artifact and no explicit request exists, omit `## Original Request`',
      'keep both `## Original Request` and `## Research Context`',
      'Source: <resolved paths.research> (Active Summary, Updated: <timestamp>, SHA256: <digest>)',
      'normalizing line endings to LF',
      'ending the digest input with exactly one newline',
      'WARN [research-drift]',
      'expected=<embedded revision>',
      'current=<live revision>',
      'unless the user explicitly requests a research rebase'
    ]) {
      assertIncludes(openspec, expected, label);
    }
  });

  it('defines safe change IDs, runtime-state boundaries, and validation through the runner', async () => {
    const injection = await readRepoFile('injections/core/aif-plan-plan-folder.md');
    const openspec = extractSection(injection, 'OpenSpec-native mode');

    for (const expected of [
      'normalizeChangeId()',
      'ensureRuntimeLayout(changeId)',
      '.ai-factory/state/<change-id>/',
      'Do not write runtime-only files into `openspec/changes/<change-id>/`',
      'validateOpenSpecChange(changeId)',
      'scripts/openspec-runner.mjs',
      'openspec validate <change-id> --type change --strict --json --no-interactive --no-color',
      'Missing or unsupported OpenSpec CLI is degraded validation, not planning failure',
      'Do not install OpenSpec skills'
    ]) {
      assertIncludes(openspec, expected, 'OpenSpec-native section');
    }
  });

  it('keeps Codex and IDE planning-mode guidance capability-gated', async () => {
    const injection = await readRepoFile('injections/core/aif-plan-plan-folder.md');

    for (const expected of [
      'skills/shared/QUESTION-TOOL.md',
      'CLI or IDE runtime exposes a planning mode',
      'do not fabricate unavailable tools or client actions',
      'user controls the mode'
    ]) {
      assertIncludes(injection, expected, 'aif-plan injection');
    }
  });

  it('keeps compatibility docs aligned with OpenSpec-native planning support', async () => {
    const compatibility = await readRepoFile('docs/openspec-compatibility.md');

    assertNotIncludes(
      compatibility,
      'does not implement later OpenSpec-native `/aif-plan`',
      'docs/openspec-compatibility.md'
    );
    assertNotIncludes(
      compatibility,
      'planning, verification, archive integration, migration, generated rules, and broader prompt rewrites remain separate follow-up work',
      'docs/openspec-compatibility.md'
    );
    assertIncludes(
      compatibility,
      '`/aif-plan full`',
      'docs/openspec-compatibility.md'
    );
  });

  it('uses CLI-selected optional tools for /aif-plan instead of a prompt-owned provider list', async () => {
    const injection = await readRepoFile('injections/core/aif-plan-plan-folder.md');

    for (const expected of [
      'Enabled optional tool use',
      'ai-factory aifhub-memory-tools select --from-project --command aif-plan --json',
      'selected_tools',
      'not_selected_tools',
      'tool_id',
      'permission',
      'execution',
      'forbidden_operations',
      'protected_artifacts',
      'Do not use tools that are absent from `selected_tools`',
      'This provider-specific boundary applies only when `selected_tools` includes Graphify',
      'This provider-specific boundary applies only when `selected_tools` includes Context7'
    ]) {
      assertIncludes(injection, expected, 'aif-plan enabled optional tool use');
    }
  });
});
