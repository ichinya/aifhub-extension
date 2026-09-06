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

const AGENT_SEMANTIC_PAIRS = [
  {
    label: 'source-aware execution, batch and recovery worker contract',
    codexPath: 'agent-files/codex/aifhub-implement-worker.toml',
    claudePath: 'agent-files/claude/aifhub-implement-worker.md',
    start: '## Persistent execution contract',
    end: '## Legacy AI Factory-only mode'
  },
  {
    label: 'source-aware fix attempts and interruption contract',
    codexPath: 'agent-files/codex/aifhub-fixer.toml',
    claudePath: 'agent-files/claude/aifhub-fixer.md',
    start: '## Persistent execution contract',
    end: '## Legacy AI Factory-only mode'
  },
  {
    label: 'bounded batch worker scope',
    codexPath: 'agent-files/codex/aifhub-implement-worker.toml',
    claudePath: 'agent-files/claude/aifhub-implement-worker.md',
    start: 'After classification permits local execution, follow the worker execution',
    end: 'Preserve marker-first delegation and do not create a replacement policy'
  },
  {
    label: 'fix re-review handoff',
    codexPath: 'agent-files/codex/aifhub-fixer.toml',
    claudePath: 'agent-files/claude/aifhub-fixer.md',
    start: 'After classification permits a selected fix, follow the fixer handoff',
    end: 'Keep evidence in the existing fix report/response'
  },
  {
    label: 'scoped re-review',
    codexPath: 'agent-files/codex/aifhub-review-sidecar.toml',
    claudePath: 'agent-files/claude/aifhub-review-sidecar.md',
    start: 'For a requested re-review after fixes, follow',
    end: 'Return the scoped evidence before the single existing gate result'
  },
  {
    label: 'implementation discipline',
    codexPath: 'agent-files/codex/aifhub-implement-worker.toml',
    claudePath: 'agent-files/claude/aifhub-implement-worker.md',
    start: 'For each testable behavior change',
    end: 'Treat the development cycle as supporting runtime evidence only'
  },
  {
    label: 'fix discipline',
    codexPath: 'agent-files/codex/aifhub-fixer.toml',
    claudePath: 'agent-files/claude/aifhub-fixer.md',
    start: 'Before editing, record direct',
    end: 'A passing post-fix check is supporting runtime evidence'
  },
  {
    label: 'review discipline',
    codexPath: 'agent-files/codex/aifhub-review-sidecar.toml',
    claudePath: 'agent-files/claude/aifhub-review-sidecar.md',
    start: 'Review in two ordered passes for either artifact mode',
    end: 'Return one combined findings-first verdict'
  }
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

function extractLineBlock(source, startFragment, endFragment, label) {
  const lines = source.split(/\r?\n/);
  const startIndex = lines.findIndex((line) => line.includes(startFragment));
  assert.notEqual(startIndex, -1, `${label} should include start witness ${JSON.stringify(startFragment)}`);
  const endIndex = lines.findIndex((line, index) => index >= startIndex && line.includes(endFragment));
  assert.notEqual(endIndex, -1, `${label} should include end witness ${JSON.stringify(endFragment)}`);
  return lines.slice(startIndex, endIndex + 1).join('\n');
}

function normalizePromptSemantics(source) {
  return source
    .replace(/[`*_]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractMarkdownSection(source, heading) {
  const start = source.indexOf(heading);
  assert.notEqual(start, -1, `Expected heading ${heading}`);
  const next = source.indexOf('\n## ', start + heading.length);
  return source.slice(start, next === -1 ? source.length : next);
}

describe('Superpowers-inspired workflow discipline', () => {
  it('resolves extension-owned coordination and re-review policies from every consumer', async () => {
    // Asset wiring only: this does not evaluate an agent's decisions on a real task.
    const policies = new Map([
      ['TASK-COORDINATION.md', IMPLEMENT_PROMPTS],
      ['SCOPED-REVIEW.md', [...FIX_PROMPTS, ...REVIEW_PROMPTS]]
    ]);
    for (const [filename, consumers] of policies) {
      const installedPrefix = '.ai-factory/extensions/aifhub-extension/';
      for (const relativePath of consumers) {
        const source = await readRepoFile(relativePath);
        const installedPath = source.match(new RegExp(
          `${installedPrefix.replaceAll('.', '\\.')}skills/shared/${filename.replaceAll('.', '\\.')}`
        ))?.[0];
        assert.ok(installedPath, `${relativePath} must identify the installed shared policy`);
        const policy = await readRepoFile(installedPath.slice(installedPrefix.length));
        assert.ok(policy.trim().length > 0, `${installedPath} must resolve to a packaged source asset`);
      }
    }
  });

  it('loads shared test quality only after local execution is allowed in both artifact modes', async () => {
    const guidance = [];
    for (const relativePath of [...IMPLEMENT_PROMPTS, ...FIX_PROMPTS]) {
      const source = await readRepoFile(relativePath);
      const block = extractLineBlock(
        source,
        'Once artifact classification permits local execution',
        'Do not create a replacement policy in the consumer project.',
        relativePath
      );
      assertIncludes(block, 'skills/shared/TEST-QUALITY.md', relativePath);
      assertIncludes(block, 'before selecting or changing an automated check or a readiness wait', relativePath);
      assertIncludes(block, 'OpenSpec-native and classic legacy execution', relativePath);
      assertIncludes(block, 'preserve marker-first delegation and no-test fallbacks.', relativePath);
      assertIncludes(block, '.ai-factory/extensions/aifhub-extension/skills/shared/TEST-QUALITY.md', relativePath);
      if (relativePath.startsWith('agent-files/')) guidance.push(normalizePromptSemantics(block));
    }
    assert.equal(new Set(guidance).size, 1, 'all four managed agents should load the same shared policy');

    const policy = await readRepoFile('skills/shared/TEST-QUALITY.md');
    for (const expected of [
      'Derive the expected result independently',
      'Reject a check that still passes for the named defect',
      'existing `testCheck` or `regressionCheck`',
      'not new QA verdicts or a new trace schema',
      'reasoning-only assessment must not be reported as an executed mutation check',
      'finite deadline',
      'predicate that never returns',
      'swallowing unexpected predicate errors',
      'readiness that never arrives',
      'debounce, throttle, expiry, and deadline boundaries',
      'retain the existing `fallbackDecision`',
      'references/test-quality-examples.md'
    ]) assertIncludes(policy, expected, 'shared test quality policy');
  });

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

      assertOrder(source, ['testCheck', 'redResult', 'greenResult', 'refactorResult', 'fallbackDecision'], relativePath);
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

  it('keeps paired Codex and Claude agent semantics synchronized', async () => {
    for (const pair of AGENT_SEMANTIC_PAIRS) {
      const [codexSource, claudeSource] = await Promise.all([
        readRepoFile(pair.codexPath),
        readRepoFile(pair.claudePath)
      ]);
      const codexBlock = normalizePromptSemantics(extractLineBlock(
        codexSource,
        pair.start,
        pair.end,
        pair.codexPath
      ));
      const claudeBlock = normalizePromptSemantics(extractLineBlock(
        claudeSource,
        pair.start,
        pair.end,
        pair.claudePath
      ));

      assert.equal(
        codexBlock,
        claudeBlock,
        `${pair.label} should remain semantically aligned between Codex and Claude agents`
      );
    }
  });

  it('keeps the adaptation guide linked from every documentation entry point', async () => {
    for (const relativePath of ['README.md', 'docs/README.md', 'docs/usage.md']) {
      const source = await readRepoFile(relativePath);
      assertIncludes(source, 'superpowers-adaptation.md', relativePath);
    }
  });

  it('documents adopted ideas, rejected duplication, and the reviewed upstream revision', async () => {
    const source = await readRepoFile('docs/superpowers-adaptation.md');
    const changelog = await readRepoFile('CHANGELOG.md');
    const release = extractMarkdownSection(changelog, '## [1.5.1] - 2026-09-06');

    for (const expected of [
      'https://github.com/obra/superpowers',
      'https://github.com/ichinya/aifhub-extension/issues/141',
      'v6.3.0',
      'b36e0829c6d0140e93cfef2ca599b1b07d4a7797',
      '2026-08-12',
      'RED -> GREEN -> REFACTOR',
      'one falsifiable hypothesis',
      'plan/spec compliance',
      'AI Factory already owns',
      'issue #168',
      'prompt/documentation contract',
      'нормализованную семантическую парность Claude/Codex',
      '/aif-verify'
    ]) {
      assertIncludes(source, expected, 'docs/superpowers-adaptation.md');
    }

    for (const expected of ['issue #141', 'RED -> GREEN -> REFACTOR', 'Claude/Codex-пар']) {
      assertIncludes(release, expected, 'CHANGELOG.md 1.5.1 Superpowers adaptation');
    }
  });
});
