// review-policy-contract.test.mjs - durable project review policy contracts
import assert from 'node:assert/strict';
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { renderConfigForMode } from './aif-artifact-sync.mjs';
import {
  inspectReviewPolicy,
  loadReviewPolicy,
  resolveReviewPolicy,
  runReviewPolicyCommand,
  scaffoldReviewPolicy
} from './review-policy-resolver.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporaryRoots = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createTemporaryRoot(label = 'project') {
  const root = await mkdtemp(path.join(os.tmpdir(), `aifhub-review-policy-${label}-`));
  temporaryRoots.push(root);
  return root;
}

async function writeFixture(root, relativePath, content) {
  const target = path.join(root, ...relativePath.split('/'));
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, 'utf8');
  return target;
}

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
      '`ai-factory aifhub-review-policy scaffold --json`',
      'symlink/Windows junction components',
      'managed files plus canonical OpenSpec',
      'uses [references/review-policy-template.md](references/review-policy-template.md)',
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
      '`ai-factory aifhub-review-policy load --json`',
      '`ai-factory aifhub-review-policy scaffold --json`',
      'symlink or Windows junction component',
      'managed-file collisions',
      'nearest existing parent with `realpath`',
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
        '`ai-factory aifhub-review-policy load --json`',
        'normalized path',
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
      'ai-factory aifhub-review-policy scaffold --json',
      'ai-factory aifhub-review-policy load --json',
      'ai-factory aifhub-review-policy resolve --json',
      'Windows junction',
      'managed-file collisions',
      'Review Policy Is Not General Project Rules',
      'Durable Policy Is Not Review-Session Feedback',
      'Provider-owned comments and session state remain with that provider',
      'Findings still require direct repository evidence.'
    ]) {
      assertIncludes(docs, expected, 'review policy documentation');
    }
  });
});

describe('review policy canonical resolver', () => {
  it('creates a safe missing scaffold and preserves an existing policy byte-for-byte', async () => {
    const rootDir = await createTemporaryRoot('scaffold');
    await writeFixture(rootDir, '.ai-factory/config.yaml', [
      'reviews:',
      '  policy_file: docs/review-guidelines.md',
      ''
    ].join('\n'));

    const created = await scaffoldReviewPolicy({ rootDir, templateContent: '# Safe review policy\n' });
    assert.deepEqual(created, {
      ok: true,
      state: 'created',
      policy_state: 'present',
      path: 'docs/review-guidelines.md',
      reason: null
    });
    assert.equal(await readFile(path.join(rootDir, 'docs/review-guidelines.md'), 'utf8'), '# Safe review policy\n');

    await writeFixture(rootDir, 'docs/review-guidelines.md', Buffer.from([0xef, 0xbb, 0xbf, 0x23, 0x20, 0x55, 0x73, 0x65, 0x72]));
    const before = await readFile(path.join(rootDir, 'docs/review-guidelines.md'));
    const preserved = await scaffoldReviewPolicy({ rootDir, templateContent: '# Replacement\n' });
    const after = await readFile(path.join(rootDir, 'docs/review-guidelines.md'));

    assert.equal(preserved.state, 'preserved');
    assert.deepEqual(after, before);
  });

  it('classifies present, empty, and missing safe policy files without exposing content', async () => {
    const rootDir = await createTemporaryRoot('states');
    await writeFixture(rootDir, 'present.md', '# Review\n');
    await writeFixture(rootDir, 'empty.md', ' \r\n\t');

    const present = await inspectReviewPolicy({ rootDir, config: {}, policyFile: 'present.md' });
    const empty = await inspectReviewPolicy({ rootDir, config: {}, policyFile: 'empty.md' });
    const missing = await inspectReviewPolicy({ rootDir, config: {}, policyFile: 'missing.md' });

    assert.deepEqual({ state: present.state, path: present.path }, { state: 'present', path: 'present.md' });
    assert.deepEqual({ state: empty.state, path: empty.path }, { state: 'empty', path: 'empty.md' });
    assert.deepEqual({ state: missing.state, path: missing.path }, { state: 'missing', path: 'missing.md' });
    assert.equal(Object.hasOwn(present, 'content'), false);
  });

  it('defaults empty config to REVIEW.md and rejects non-portable or escaping paths deterministically', async () => {
    const rootDir = await createTemporaryRoot('lexical');
    const defaulted = await resolveReviewPolicy({
      rootDir,
      config: { reviews: { policy_file: '   ' } }
    });
    assert.deepEqual(
      { ok: defaulted.ok, state: defaulted.state, path: defaulted.path },
      { ok: true, state: 'missing', path: 'REVIEW.md' }
    );

    for (const policyFile of [
      '../REVIEW.md',
      'C:/external/REVIEW.md',
      'https://example.com/REVIEW.md',
      'docs\\REVIEW.md',
      'docs/review.txt',
      'docs/review.md:stream.md'
    ]) {
      const result = await resolveReviewPolicy({ rootDir, config: {}, policyFile });
      assert.equal(result.state, 'unsafe', policyFile);
    }

    const portableCollision = await resolveReviewPolicy({
      rootDir,
      config: {},
      policyFile: 'OpenSpec/Specs/review.md'
    });
    assert.equal(portableCollision.reason, 'review-policy-protected-root-collision');
  });

  it('rejects a directory symlink or Windows junction before external read or scaffold write', async () => {
    const rootDir = await createTemporaryRoot('linked-project');
    const externalDir = await createTemporaryRoot('linked-external');
    await writeFixture(rootDir, '.ai-factory/config.yaml', [
      'reviews:',
      '  policy_file: docs/REVIEW.md',
      ''
    ].join('\n'));
    await writeFixture(externalDir, 'REVIEW.md', '# External instructions\n');
    await symlink(externalDir, path.join(rootDir, 'docs'), process.platform === 'win32' ? 'junction' : 'dir');

    const loaded = await loadReviewPolicy({ rootDir });
    assert.equal(loaded.ok, false);
    assert.equal(loaded.state, 'unsafe');
    assert.equal(loaded.reason, 'review-policy-linked-component');
    assert.equal(loaded.content, null);

    await rm(path.join(externalDir, 'REVIEW.md'));
    const scaffold = await scaffoldReviewPolicy({
      rootDir,
      templateContent: '# Must stay in project\n'
    });
    assert.equal(scaffold.state, 'skipped');
    assert.equal(scaffold.policy_state, 'unsafe');
    await assert.rejects(readFile(path.join(externalDir, 'REVIEW.md')), { code: 'ENOENT' });
  });

  it('executes the Windows junction escape regression on Windows', { skip: process.platform !== 'win32' }, async () => {
    const rootDir = await createTemporaryRoot('junction-project');
    const externalDir = await createTemporaryRoot('junction-external');
    await symlink(externalDir, path.join(rootDir, 'policy'), 'junction');

    const result = await resolveReviewPolicy({ rootDir, config: {}, policyFile: 'policy/REVIEW.md' });
    assert.deepEqual(
      { ok: result.ok, state: result.state, reason: result.reason },
      { ok: false, state: 'unsafe', reason: 'review-policy-linked-component' }
    );
  });

  it('rejects managed files and canonical, generated, runtime, and QA roots before creation', async () => {
    const rootDir = await createTemporaryRoot('collisions');
    const collisions = [
      ['.ai-factory/rules/base.md', 'review-policy-managed-file-collision'],
      ['openspec/specs/auth/spec.md', 'review-policy-protected-root-collision'],
      ['.ai-factory/rules/generated/review.md', 'review-policy-protected-root-collision'],
      ['.ai-factory/state/add-auth/review.md', 'review-policy-protected-root-collision'],
      ['.ai-factory/qa/add-auth/review.md', 'review-policy-protected-root-collision']
    ];

    for (const [policyFile, reason] of collisions) {
      await writeFixture(rootDir, '.ai-factory/config.yaml', [
        'reviews:',
        `  policy_file: ${policyFile}`,
        ''
      ].join('\n'));
      const resolved = await resolveReviewPolicy({ rootDir });
      assert.deepEqual(
        { ok: resolved.ok, state: resolved.state, reason: resolved.reason },
        { ok: false, state: 'unsafe', reason },
        policyFile
      );
      const scaffold = await scaffoldReviewPolicy({ rootDir, templateContent: '# No\n' });
      assert.equal(scaffold.state, 'skipped', policyFile);
    }

    await assert.rejects(readFile(path.join(rootDir, '.ai-factory/rules/base.md')), { code: 'ENOENT' });
    await assert.rejects(readFile(path.join(rootDir, 'openspec/specs/auth/spec.md')), { code: 'ENOENT' });
  });

  it('rejects collisions with configured artifact owners and rules', async () => {
    const rootDir = await createTemporaryRoot('configured-collisions');
    const config = {
      paths: {
        description: 'project/description.md',
        qa: 'quality/runtime'
      },
      rules: {
        base: 'standards/base.md',
        api: 'standards/api.md'
      }
    };

    for (const [policyFile, reason] of [
      ['project/description.md', 'review-policy-managed-file-collision'],
      ['standards/api.md', 'review-policy-managed-file-collision'],
      ['quality/runtime/review.md', 'review-policy-protected-root-collision']
    ]) {
      const result = await resolveReviewPolicy({ rootDir, config, policyFile });
      assert.equal(result.state, 'unsafe', policyFile);
      assert.equal(result.reason, reason, policyFile);
    }
  });

  it('canonicalizes configured artifact-owner aliases before collision checks', async () => {
    const rootDir = await createTemporaryRoot('owner-aliases');
    await writeFixture(rootDir, 'shared/rules/base.md', '# Rules\n');
    await mkdir(path.join(rootDir, 'shared/qa'), { recursive: true });
    const linkType = process.platform === 'win32' ? 'junction' : 'dir';
    await symlink(path.join(rootDir, 'shared/rules'), path.join(rootDir, 'configured-rules'), linkType);
    await symlink(path.join(rootDir, 'shared/qa'), path.join(rootDir, 'configured-qa'), linkType);

    const managedAlias = await resolveReviewPolicy({
      rootDir,
      config: {
        rules: { base: 'configured-rules/base.md' }
      },
      policyFile: 'shared/rules/base.md'
    });
    assert.equal(managedAlias.reason, 'review-policy-managed-file-collision');

    const protectedAlias = await resolveReviewPolicy({
      rootDir,
      config: {
        paths: { qa: 'configured-qa' }
      },
      policyFile: 'shared/qa/review.md'
    });
    assert.equal(protectedAlias.reason, 'review-policy-protected-root-collision');
  });

  it('rejects a hard-link alias of a managed artifact', async () => {
    const rootDir = await createTemporaryRoot('hardlink');
    const baseRules = await writeFixture(rootDir, '.ai-factory/rules/base.md', '# Project rules\n');
    await mkdir(path.join(rootDir, 'docs'), { recursive: true });
    await link(baseRules, path.join(rootDir, 'docs/review.md'));

    const result = await resolveReviewPolicy({ rootDir, config: {}, policyFile: 'docs/review.md' });
    assert.equal(result.state, 'unsafe');
    assert.equal(result.reason, 'review-policy-managed-file-collision');
  });

  it('rejects a hard-link policy target even when its other owner is outside the project', async () => {
    const rootDir = await createTemporaryRoot('external-hardlink-project');
    const externalDir = await createTemporaryRoot('external-hardlink-owner');
    const externalPolicy = await writeFixture(externalDir, 'policy.md', '# External instructions\n');
    await mkdir(path.join(rootDir, 'docs'), { recursive: true });
    await link(externalPolicy, path.join(rootDir, 'docs/review.md'));

    const result = await loadReviewPolicy({ rootDir, config: {}, policyFile: 'docs/review.md' });
    assert.equal(result.state, 'unsafe');
    assert.equal(result.reason, 'review-policy-hardlink-target');
    assert.equal(result.content, null);
  });

  it('keeps resolve diagnostics content-free and returns content only from a validated load snapshot', async () => {
    const rootDir = await createTemporaryRoot('cli');
    await writeFixture(rootDir, 'REVIEW.md', '# Secret policy body\n');
    const command = await runReviewPolicyCommand(['resolve', '--json'], { rootDir, config: {} });
    const output = JSON.parse(command.stdout);

    assert.equal(command.exitCode, 0);
    assert.deepEqual({ ...output, revision: undefined }, {
      ok: true,
      state: 'present',
      path: 'REVIEW.md',
      revision: undefined,
      reason: null
    });
    assert.match(output.revision, /^[a-f0-9]{64}$/);
    assert.doesNotMatch(command.stdout, /Secret policy body|aifhub-review-policy-cli-/);

    const loadCommand = await runReviewPolicyCommand(['load', '--json'], { rootDir, config: {} });
    const snapshot = JSON.parse(loadCommand.stdout);
    assert.equal(loadCommand.exitCode, 0);
    assert.equal(snapshot.state, 'present');
    assert.equal(snapshot.path, 'REVIEW.md');
    assert.equal(snapshot.revision, output.revision);
    assert.equal(snapshot.content, '# Secret policy body\n');
    assert.doesNotMatch(loadCommand.stdout, /aifhub-review-policy-cli-/);
  });

  it('rejects oversized, invalid UTF-8, and NUL-bearing policy snapshots', async () => {
    const rootDir = await createTemporaryRoot('content-safety');
    await writeFixture(rootDir, 'large.md', '#'.repeat(32));
    await writeFixture(rootDir, 'invalid.md', Buffer.from([0xff, 0xfe, 0xfd]));
    await writeFixture(rootDir, 'with-nul.md', Buffer.from('# Review\0hidden\n', 'utf8'));

    const large = await loadReviewPolicy({ rootDir, config: {}, policyFile: 'large.md', maxPolicyBytes: 8 });
    const invalid = await loadReviewPolicy({ rootDir, config: {}, policyFile: 'invalid.md' });
    const nul = await loadReviewPolicy({ rootDir, config: {}, policyFile: 'with-nul.md' });

    assert.deepEqual(
      [large.reason, invalid.reason, nul.reason],
      ['review-policy-too-large', 'review-policy-encoding-invalid', 'review-policy-encoding-invalid']
    );
    assert.equal(large.content, null);
    assert.equal(invalid.content, null);
    assert.equal(nul.content, null);
  });
});
