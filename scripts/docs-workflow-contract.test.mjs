// docs-workflow-contract.test.mjs - docs coverage for the complete OpenSpec workflow tail
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
  assert.ok(source.includes(expected), `${label} should include ${JSON.stringify(expected)}`);
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
  const startIndex = lines.findIndex((line) => line.trim() === heading);
  assert.notEqual(startIndex, -1, `Expected heading ${heading}`);
  const level = heading.match(/^#+/)?.[0].length ?? 1;
  let endIndex = lines.length;

  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const match = lines[index].match(/^(#{1,6})\s+/);
    if (match && match[1].length <= level) {
      endIndex = index;
      break;
    }
  }

  return lines.slice(startIndex, endIndex).join('\n');
}

describe('complete OpenSpec workflow documentation contract', () => {
  it('documents the complete quick-start tail in README.md in workflow order', async () => {
    const readme = await readRepoFile('README.md');
    const quickStart = extractSection(readme, '## Quick Start');

    for (const expected of [
      '/aif-mode sync --change add-oauth-login',
      '/aif-rules-check',
      '/aif-review',
      '/aif-security-checklist',
      '/aif-verify add-oauth-login',
      '/aif-done add-oauth-login',
      '/aif-mode sync',
      '/aif-commit',
      '/aif-evolve'
    ]) {
      assertIncludes(quickStart, expected, 'README.md Quick Start');
    }

    assertOrder(quickStart, [
      '/aif-plan full "add OAuth login"',
      '/aif-improve add-oauth-login',
      '/aif-mode sync --change add-oauth-login',
      '/aif-implement add-oauth-login',
      '/aif-rules-check',
      '/aif-verify add-oauth-login',
      '/aif-done add-oauth-login',
      '/aif-mode sync',
      '/aif-commit',
      '/aif-evolve'
    ], 'README.md Quick Start');

    assertIncludes(quickStart, '/aif-done` finalizes the OpenSpec lifecycle', 'README.md Quick Start');
    assertIncludes(quickStart, 'It does not replace `/aif-commit`', 'README.md Quick Start');
  });

  it('documents the complete manual workflow in docs/usage.md in workflow order', async () => {
    const usage = await readRepoFile('docs/usage.md');

    for (const expected of [
      '/aif-mode sync --change <change-id>',
      '/aif-rules-check',
      '/aif-review',
      '/aif-security-checklist',
      '/aif-verify <change-id>',
      '/aif-done <change-id>',
      '/aif-mode sync',
      '/aif-commit',
      '/aif-evolve',
      'required',
      'recommended',
      'optional'
    ]) {
      assertIncludes(usage, expected, 'docs/usage.md');
    }

    assertOrder(usage, [
      '/aif-plan full "<request>"',
      '/aif-implement <change-id>',
      '/aif-verify <change-id>',
      '/aif-done <change-id>',
      '/aif-mode sync',
      '/aif-commit',
      '/aif-evolve'
    ], 'docs/usage.md workflow');
  });
});
