// aif-explore-improve-openspec-artifacts.test.mjs - instruction-level tests for OpenSpec explore/improve contracts
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

function assertNoInstallGuidance(source, label) {
  assert.doesNotMatch(
    source,
    /\b(?:must|should|need(?:s)? to|required to|recommended to|recommend)\s+install OpenSpec skills\b/i,
    `${label} should not tell agents to install OpenSpec skills`
  );
}

function extractSection(markdown, heading) {
  const lines = markdown.split(/\r?\n/);
  let inFence = false;
  let start = -1;
  let startLevel = 0;
  let end = lines.length;

  for (let index = 0; index < lines.length; index += 1) {
    if (/^\s*(```|~~~)/.test(lines[index])) {
      inFence = !inFence;
      continue;
    }

    const match = inFence ? null : lines[index].match(/^(#{1,6})\s+(.+?)\s*$/);

    if (match && match[2] === heading) {
      start = index + 1;
      startLevel = match[1].length;
      break;
    }
  }

  assert.notEqual(start, -1, `Expected section heading: ${'#'.repeat(startLevel || 3)} ${heading}`);

  inFence = false;
  for (let index = start; index < lines.length; index += 1) {
    if (/^\s*(```|~~~)/.test(lines[index])) {
      inFence = !inFence;
      continue;
    }

    const match = inFence ? null : lines[index].match(/^(#{1,6})\s+(.+?)\s*$/);

    if (match && match[1].length <= startLevel) {
      end = index;
      break;
    }
  }

  return lines.slice(start, end).join('\n');
}

describe('aif-explore and aif-improve OpenSpec-native contracts', () => {
  it('defines mode-gated OpenSpec-native and legacy sections in both injections', async () => {
    for (const [relativePath, legacyHeading] of [
      ['injections/core/aif-explore-plan-folder.md', 'Legacy AI Factory-only mode'],
      ['injections/core/aif-improve-plan-folder.md', 'Legacy AI Factory-only mode']
    ]) {
      const injection = await readRepoFile(relativePath);
      const openspec = extractSection(injection, 'OpenSpec-native mode');
      const legacy = extractSection(injection, legacyHeading);

      assertIncludes(openspec, 'aifhub.artifactProtocol: openspec', `${relativePath} OpenSpec-native section`);
      assertIncludes(legacy, 'When OpenSpec-native mode is not enabled', `${relativePath} legacy section`);
      assertIncludes(legacy, '.ai-factory/plans/<plan-id>.md', `${relativePath} legacy section`);
      assertIncludes(legacy, '.ai-factory/plans/<plan-id>/', `${relativePath} legacy section`);
    }
  });

  it('keeps /aif-explore research-oriented without legacy plan-file requirements', async () => {
    const injection = await readRepoFile('injections/core/aif-explore-plan-folder.md');
    const openspec = extractSection(injection, 'OpenSpec-native mode');

    for (const expected of [
      'research-oriented',
      '.ai-factory/config.yaml',
      '.ai-factory/DESCRIPTION.md',
      '.ai-factory/ARCHITECTURE.md',
      '.ai-factory/RESEARCH.md',
      'openspec/specs/**',
      'openspec/changes/<change-id>/**',
      '.ai-factory/state/<change-id>/explore.md',
      '.ai-factory/state/<change-id>/research-notes.md',
      'Do not create non-OpenSpec files under `openspec/changes/<change-id>/`',
      'Report where research was written'
    ]) {
      assertIncludes(openspec, expected, 'aif-explore OpenSpec-native section');
    }

    for (const unexpected of [
      '.ai-factory/plans/<id>.md',
      '.ai-factory/plans/<plan-id>.md',
      '.ai-factory/plans/<id>/',
      '.ai-factory/plans/<plan-id>/',
      'openspec/changes/<change-id>/explore.md',
      'openspec/changes/<change-id>/research-notes.md'
    ]) {
      assertNotIncludes(openspec, unexpected, 'aif-explore OpenSpec-native section');
    }
  });

  it('limits /aif-explore OpenSpec change files to canonical artifacts and current commands', async () => {
    const injection = await readRepoFile('injections/core/aif-explore-plan-folder.md');
    const openspec = extractSection(injection, 'OpenSpec-native mode');

    for (const expected of [
      'openspec/changes/<change-id>/proposal.md',
      'openspec/changes/<change-id>/design.md',
      'openspec/changes/<change-id>/tasks.md',
      'openspec/changes/<change-id>/specs/**/spec.md',
      '/aif-plan full "<request>"',
      '/aif-improve <change-id>',
      '/aif-implement <change-id>'
    ]) {
      assertIncludes(openspec, expected, 'aif-explore OpenSpec-native section');
    }

    for (const unexpected of [
      'aif-plan-plus',
      'aif-improve-plus',
      'aif-implement-plus'
    ]) {
      assertNotIncludes(openspec, unexpected, 'aif-explore OpenSpec-native section');
    }
  });

  it('targets only canonical OpenSpec artifacts from /aif-improve OpenSpec-native mode', async () => {
    const injection = await readRepoFile('injections/core/aif-improve-plan-folder.md');
    const openspec = extractSection(injection, 'OpenSpec-native mode');

    for (const expected of [
      'scripts/active-change-resolver.mjs',
      'resolveActiveChange',
      'openspec/changes/<change-id>/proposal.md',
      'openspec/changes/<change-id>/design.md',
      'openspec/changes/<change-id>/tasks.md',
      'openspec/changes/<change-id>/specs/**/spec.md',
      '`task.md`, `context.md`, `rules.md`, `verify.md`, and `status.yaml` are not OpenSpec-native refinement targets'
    ]) {
      assertIncludes(openspec, expected, 'aif-improve OpenSpec-native section');
    }

    for (const unexpected of [
      '.ai-factory/plans/<id>.md',
      '.ai-factory/plans/<plan-id>.md',
      '.ai-factory/plans/<id>/task.md',
      '.ai-factory/plans/<plan-id>/task.md',
      'refine `task.md`',
      'refine `context.md`',
      'refine `rules.md`',
      'refine `verify.md`',
      'refine `status.yaml`'
    ]) {
      assertNotIncludes(openspec, unexpected, 'aif-improve OpenSpec-native section');
    }
  });

  it('requires preservation, archived-change handling, runtime-state boundaries, and validation for /aif-improve', async () => {
    const injection = await readRepoFile('injections/core/aif-improve-plan-folder.md');
    const openspec = extractSection(injection, 'OpenSpec-native mode');

    for (const expected of [
      'Read current artifact content before editing',
      'Preserve user-written sections',
      'patch-style',
      'create only missing artifacts',
      'update the relevant requirement in an existing delta spec',
      'Changed:',
      'Preserved:',
      'openspec/changes/archive/**',
      'immutable by default',
      'validateOpenSpecChange(changeId)',
      'scripts/openspec-runner.mjs',
      'Missing or unsupported OpenSpec CLI is degraded validation',
      'ensureRuntimeLayout(changeId)',
      '.ai-factory/state/<change-id>/improve-summary.md',
      '.ai-factory/state/<change-id>/last-validation.json'
    ]) {
      assertIncludes(openspec, expected, 'aif-improve OpenSpec-native section');
    }
  });

  it('does not tell OpenSpec-native users to install OpenSpec skills', async () => {
    for (const relativePath of [
      'injections/core/aif-explore-plan-folder.md',
      'injections/core/aif-improve-plan-folder.md'
    ]) {
      const injection = await readRepoFile(relativePath);
      const openspec = extractSection(injection, 'OpenSpec-native mode');

      assertIncludes(openspec, 'Do not install OpenSpec skills', `${relativePath} OpenSpec-native section`);
      assertNoInstallGuidance(openspec, `${relativePath} OpenSpec-native section`);
    }
  });
});
