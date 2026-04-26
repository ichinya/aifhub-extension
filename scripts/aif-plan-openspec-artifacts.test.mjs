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
      '#### Scenario: <Scenario name>'
    ]) {
      assertIncludes(openspec, expected, 'OpenSpec-native section');
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
});
