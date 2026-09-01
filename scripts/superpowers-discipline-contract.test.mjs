// superpowers-discipline-contract.test.mjs - bounded workflow ideas adapted from obra/superpowers
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

const IMPLEMENT_PROMPTS = [
  'injections/core/aif-implement-plan-folder.md',
  'agent-files/codex/aifhub-implement-worker.toml',
  'agent-files/claude/aifhub-implement-worker.md'
];

const FIX_PROMPTS = [
  'injections/core/aif-fix-plan-folder.md',
  'agent-files/codex/aifhub-fixer.toml',
  'agent-files/claude/aifhub-fixer.md'
];

const REVIEW_PROMPTS = [
  'injections/core/aif-review-context-providers.md',
  'agent-files/codex/aifhub-review-sidecar.toml',
  'agent-files/claude/aifhub-review-sidecar.md'
];

async function readRepoFile(relativePath) {
  return readFile(join(REPO_ROOT, relativePath), 'utf8');
}

function assertIncludes(source, expected, label) {
  assert.ok(source.includes(expected), `${label} should include ${JSON.stringify(expected)}`);
}

function assertOrder(source, fragments, label) {
  let cursor = -1;

  for (const fragment of fragments) {
    const index = source.indexOf(fragment, cursor + 1);
    assert.notEqual(index, -1, `${label} should include ${JSON.stringify(fragment)}`);
    assert.ok(index > cursor, `${label} should order ${JSON.stringify(fragment)} after the previous fragment`);
    cursor = index;
  }
}

describe('Superpowers-inspired workflow discipline', () => {
  it('requires a bounded RED-GREEN-REFACTOR cycle for testable behavior changes', async () => {
    for (const relativePath of IMPLEMENT_PROMPTS) {
      const source = await readRepoFile(relativePath);

      for (const expected of [
        'testable behavior change',
        'focused automated check',
        'testCheck',
        'redResult',
        'greenResult',
        'refactorResult',
        'fallbackDecision',
        'supporting runtime evidence',
        '/aif-verify <change-id>'
      ]) {
        assertIncludes(source, expected, relativePath);
      }

      assertOrder(source, ['RED', 'GREEN', 'REFACTOR'], relativePath);
      assert.match(
        source,
        /docs-only|documentation-only|generated artifacts|no useful automated check/i,
        `${relativePath} should define a non-test fallback without fabricating a failing test`
      );
    }
  });

  it('requires root-cause evidence and a falsifiable experiment before a fix edit', async () => {
    for (const relativePath of FIX_PROMPTS) {
      const source = await readRepoFile(relativePath);

      for (const expected of [
        'rootCauseEvidence',
        'hypothesis',
        'experiment',
        'falsifiable',
        'one hypothesis at a time',
        'three failed hypotheses',
        'stop without implementation edits'
      ]) {
        assertIncludes(source, expected, relativePath);
      }

      assertOrder(source, ['rootCauseEvidence', 'hypothesis', 'experiment', 'regressionCheck'], relativePath);
    }
  });

  it('orders review as plan/spec compliance before code quality', async () => {
    for (const relativePath of REVIEW_PROMPTS) {
      const source = await readRepoFile(relativePath);

      assertOrder(source, [
        'Pass 1 - plan/spec compliance',
        'Pass 2 - code quality'
      ], relativePath);
      assertIncludes(source, 'Do not let a code-quality pass erase or downgrade a plan/spec compliance finding.', relativePath);
    }
  });

  it('documents adopted ideas, rejected duplication, and the reviewed upstream revision', async () => {
    const source = await readRepoFile('docs/superpowers-adaptation.md');

    for (const expected of [
      'https://github.com/obra/superpowers',
      'b36e0829c6d0140e93cfef2ca599b1b07d4a7797',
      'RED -> GREEN -> REFACTOR',
      'one falsifiable hypothesis',
      'plan/spec compliance',
      'AI Factory already owns',
      'issue #168',
      '/aif-verify'
    ]) {
      assertIncludes(source, expected, 'docs/superpowers-adaptation.md');
    }
  });
});
