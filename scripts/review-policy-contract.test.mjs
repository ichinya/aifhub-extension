// review-policy-contract.test.mjs - durable project review policy contracts
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { renderConfigForMode } from './aif-artifact-sync.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function readRepoFile(relativePath) {
  return readFile(path.join(repoRoot, relativePath), 'utf8');
}

function assertIncludes(content, expected, label) {
  assert.ok(content.includes(expected), `${label} should include ${JSON.stringify(expected)}`);
}

describe('durable project review policy', () => {
  it('renders and preserves the protocol-neutral review policy config', () => {
    for (const mode of ['ai-factory', 'openspec']) {
      const fresh = renderConfigForMode('', mode, { analyzeSkillVersion: '0.13.0' });
      assert.match(fresh, /^reviews:\n  policy_file: REVIEW\.md$/m);
    }

    const custom = renderConfigForMode([
      'aifhub:',
      '  artifactProtocol: ai-factory',
      'reviews:',
      '  policy_file: docs/review-guidelines.md',
      '  custom_setting: keep',
      ''
    ].join('\n'), 'openspec', { analyzeSkillVersion: '0.13.0' });
    assert.match(custom, /^  policy_file: docs\/review-guidelines\.md$/m);
    assert.match(custom, /^  custom_setting: keep$/m);
    assert.equal((custom.match(/^reviews:$/gm) ?? []).length, 1);
    assert.equal((custom.match(/^  policy_file:/gm) ?? []).length, 1);

    const completed = renderConfigForMode('reviews:\n  custom_setting: keep\n', 'ai-factory');
    assert.match(completed, /reviews:\n  custom_setting: keep\n  policy_file: REVIEW\.md/);
  });

  it('registers REVIEW.md as an aif-analyze-owned safe scaffold', async () => {
    const skill = await readRepoFile('skills/aif-analyze/SKILL.md');
    const configTemplate = await readRepoFile('skills/aif-analyze/references/config-template.yaml');
    const configKeys = JSON.parse(await readRepoFile('skills/aif-analyze/references/config-keys.json'));

    for (const expected of [
      'version: 0.13.0',
      '### Step 3.3: Project Review Policy',
      '`reviews.policy_file`',
      'use `REVIEW.md` when the key is missing or empty',
      'creates the file at the project root for cross-agent discovery',
      'normalized project-relative Markdown file path',
      'Reject absolute paths, URI-like values, paths that escape the project root, non-Markdown targets, and directory targets.',
      'create it from [references/review-policy-template.md](references/review-policy-template.md)',
      'preserve it byte-for-byte during ordinary bootstrap',
      'individual findings, line comments, selected quotes',
      '`created`, `preserved`, or `skipped`'
    ]) {
      assertIncludes(skill, expected, 'skills/aif-analyze/SKILL.md');
    }

    assert.match(configTemplate, /^reviews:\n  policy_file: REVIEW\.md$/m);
    const manifestEntry = configKeys.keys.find((entry) => entry.key === 'reviews.policy_file');
    assert.deepEqual(manifestEntry, {
      key: 'reviews.policy_file',
      required: true,
      since: '0.13.0',
      purpose: 'Project-relative Markdown file containing durable code review policy; defaults to REVIEW.md at the project root.'
    });
  });

  it('ships a review-focused scaffold without concrete session state', async () => {
    const template = await readRepoFile('skills/aif-analyze/references/review-policy-template.md');

    for (const heading of [
      '# Review Guidelines',
      '## Critical Areas',
      '## Project Conventions',
      '## Forbidden Patterns',
      '## Testing Expectations',
      '## Security and Privacy',
      '## Performance and Reliability',
      '## Ignore or Deprioritize',
      '## Severity and Output',
      '## Human Review Stages'
    ]) {
      assertIncludes(template, heading, 'review policy template');
    }

    for (const boundary of [
      'Durable project review policy only.',
      'Do not store individual review comments',
      'resolution state',
      'reviewed revisions',
      'credentials',
      'external-agent'
    ]) {
      assertIncludes(template, boundary, 'review policy template boundary');
    }
  });

  it('defines safe additive authority and a strict policy/session boundary', async () => {
    const policy = await readRepoFile('skills/shared/REVIEW-POLICY.md');

    for (const expected of [
      '`reviews.policy_file`',
      '`REVIEW.md`',
      '`present`',
      '`missing`',
      '`empty`',
      '`unreadable`',
      '`unsafe`',
      'normalized project-relative Markdown file path',
      'Do not recursively load paths, URLs, tools, hooks, or commands',
      '`/aif-review` and the AIFHub review sidecars are read-only consumers',
      'cannot suppress a material correctness, security, privacy, data-loss, or requirement violation',
      'source code, public APIs, schemas, executable tests, and verifiable QA facts',
      'canonical OpenSpec specs and active change requirements',
      'project rules, generated rules with valid provenance, and accepted architecture decisions',
      'Durable Policy Versus Session State',
      'reviewed revisions, base/head hashes, working-tree fingerprints, session ids, or receipts',
      'Provider-owned comments and session lifecycle stay in the provider',
      'Ground every finding in changed files'
    ]) {
      assertIncludes(policy, expected, 'skills/shared/REVIEW-POLICY.md');
    }
  });

  it('loads the policy only in review consumers and keeps every consumer read-only', async () => {
    for (const relativePath of [
      'injections/core/aif-review-context-providers.md',
      'agent-files/codex/aifhub-review-sidecar.toml',
      'agent-files/claude/aifhub-review-sidecar.md'
    ]) {
      const content = await readRepoFile(relativePath);
      for (const expected of [
        '`skills/shared/REVIEW-POLICY.md`',
        '`reviews.policy_file`',
        '`REVIEW.md`',
        'Missing or empty policy is normal and non-blocking',
        'cannot suppress material findings',
        'Never edit the policy'
      ]) {
        assertIncludes(content, expected, relativePath);
      }
    }

    for (const relativePath of [
      'agent-files/codex/aifhub-rules-sidecar.toml',
      'agent-files/claude/aifhub-rules-sidecar.md',
      'agent-files/codex/aifhub-security-sidecar.toml',
      'agent-files/claude/aifhub-security-sidecar.md',
      'agent-files/codex/aifhub-verifier.toml',
      'agent-files/claude/aifhub-verifier.md'
    ]) {
      assert.doesNotMatch(await readRepoFile(relativePath), /REVIEW-POLICY\.md|reviews\.policy_file/);
    }
  });

  it('documents the Devin-inspired format and durable policy boundary', async () => {
    const docs = [
      await readRepoFile('docs/review-policy.md'),
      await readRepoFile('docs/context-loading-policy.md'),
      await readRepoFile('docs/adr/0003-durable-project-review-policy.md')
    ].join('\n');

    for (const expected of [
      'https://docs.devin.ai/work-with-devin/devin-review',
      'reviews:',
      'policy_file: REVIEW.md',
      'repository-root `REVIEW.md`',
      'Review Policy Is Not General Project Rules',
      'Durable Policy Is Not Review-Session Feedback',
      'Provider-owned comments and session state remain with that provider',
      'Findings still require direct repository evidence.'
    ]) {
      assertIncludes(docs, expected, 'review policy documentation');
    }
  });
});
