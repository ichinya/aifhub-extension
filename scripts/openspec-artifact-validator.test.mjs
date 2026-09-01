// openspec-artifact-validator.test.mjs - OpenSpec artifact contract validator tests
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  runArtifactValidatorCommand,
  validateOpenSpecArtifactContract
} from './openspec-artifact-validator.mjs';
import {
  compileOpenSpecRules
} from './openspec-rules-compiler.mjs';
import {
  createGateResult,
  renderGateResultBlock
} from './aif-gate-result.mjs';

const tempRoots = [];

async function createTempRoot() {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'aifhub-artifact-validator-'));
  tempRoots.push(rootDir);
  return rootDir;
}

async function writeFixture(rootDir, relativePath, content) {
  const targetPath = path.join(rootDir, ...relativePath.split('/'));
  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeFile(targetPath, content, 'utf8');
  return targetPath;
}

async function createValidChange(rootDir, changeId = 'add-oauth') {
  await writeFixture(rootDir, '.ai-factory/config.yaml', [
    'aifhub:',
    '  artifactProtocol: openspec',
    '  openspec:',
    '    requireDesign: true',
    'paths:',
    '  qa: .ai-factory/qa',
    '  generated_rules: .ai-factory/rules/generated',
    ''
  ].join('\n'));
  await writeFixture(rootDir, `openspec/changes/${changeId}/proposal.md`, [
    '# Proposal',
    '',
    '## Why',
    '',
    'Add OAuth login.',
    ''
  ].join('\n'));
  await writeFixture(rootDir, `openspec/changes/${changeId}/design.md`, '# Design\n');
  await writeFixture(rootDir, `openspec/changes/${changeId}/tasks.md`, '# Tasks\n\n- [ ] Implement OAuth\n');
  await writeFixture(rootDir, 'openspec/specs/auth/spec.md', [
    '# Auth Base',
    '',
    '## Requirements',
    '',
    '### Requirement: Password login',
    '',
    'Users MUST be able to sign in with a password.',
    ''
  ].join('\n'));
  await writeFixture(rootDir, `openspec/changes/${changeId}/specs/auth/spec.md`, [
    '# Auth Delta',
    '',
    '## ADDED Requirements',
    '',
    '### Requirement: OAuth login',
    '',
    'Users MUST be able to sign in with OAuth.',
    '',
    '#### Scenario: sign in with OAuth',
    '',
    '- GIVEN a user has an OAuth provider account',
    '- WHEN they sign in through that provider',
    '- THEN an authenticated session is created.',
    ''
  ].join('\n'));
  await compileOpenSpecRules(changeId, { rootDir });
}

async function writeVerificationEvidence(rootDir, changeId = 'add-oauth', options = {}) {
  await writeFixture(rootDir, `.ai-factory/qa/${changeId}/openspec-validation.json`, `${JSON.stringify({
    changeId,
    ok: options.validationOk ?? true,
    skipped: false
  }, null, 2)}\n`);
  await writeFixture(rootDir, `.ai-factory/qa/${changeId}/verify.md`, options.verifyContent ?? [
    `# Verify: ${changeId}`,
    '',
    'Verdict: PASS',
    '',
    renderGateResultBlock(createGateResult({
      gate: 'verify',
      status: 'pass',
      blockers: [],
      affectedFiles: [],
      suggestedNext: null
    })),
    ''
  ].join('\n'));
}

async function snapshotFiles(rootDir) {
  const files = await collectFiles(rootDir, rootDir);
  const snapshot = {};

  for (const filePath of files) {
    const relativePath = toPosix(path.relative(rootDir, filePath));
    snapshot[relativePath] = await readFile(filePath, 'utf8');
  }

  return snapshot;
}

async function collectFiles(rootDir, directoryPath) {
  const entries = await readdir(directoryPath, { withFileTypes: true });
  const files = [];

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const childPath = path.join(directoryPath, entry.name);

    if (entry.isDirectory()) {
      files.push(...await collectFiles(rootDir, childPath));
      continue;
    }

    if (entry.isFile()) {
      files.push(childPath);
    }
  }

  return files;
}

function getCheck(result, id) {
  return result.checks.find((check) => check.id === id);
}

function toPosix(value) {
  return String(value).replaceAll('\\', '/');
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((rootDir) => rm(rootDir, {
    recursive: true,
    force: true
  })));
});

describe('OpenSpec artifact contract validator', () => {
  it('passes a valid change without requiring verify evidence', async () => {
    const rootDir = await createTempRoot();
    await createValidChange(rootDir);

    const result = await validateOpenSpecArtifactContract({
      rootDir,
      changeId: 'add-oauth'
    });

    assert.equal(result.validator, 'aifhub-openspec-artifact-contract');
    assert.equal(result.status, 'pass');
    assert.equal(result.blocking, false);
    assert.equal(getCheck(result, 'delta-specs-present').status, 'pass');
    assert.equal(getCheck(result, 'issue-source-binding').status, 'pass');
  });

  it('validates provider-neutral MCP work-item bindings and their external ID prefixes', async () => {
    const validRoot = await createTempRoot();
    await createValidChange(validRoot, 'eng-431-fix-login-timeout');
    await writeFixture(validRoot, 'openspec/changes/eng-431-fix-login-timeout/proposal.md', [
      '# Proposal',
      '',
      '## AIFHub Source Binding',
      '',
      '- Provider: linear',
      '- Primary source: mcp://linear/issue/6a1f24c8',
      '- External ID: ENG-431',
      '- Branch: feature/some-request-slug',
      '',
      '## Roadmap Linkage',
      '',
      '- Issues: mcp://linear/issue/6a1f24c8, https://acme.atlassian.net/browse/PROJ-77',
      '- Milestone: none',
      '- Roadmap item/slice: none',
      '- Rationale: primary plus secondary linkage',
      '',
      '## Why',
      '',
      'Implement the primary issue.',
      ''
    ].join('\n'));

    const valid = await validateOpenSpecArtifactContract({
      rootDir: validRoot,
      changeId: 'eng-431-fix-login-timeout'
    });
    assert.equal(valid.status, 'pass');
    assert.equal(getCheck(valid, 'issue-source-binding').status, 'pass');

    await writeFixture(validRoot, 'openspec/changes/eng-431-fix-login-timeout/proposal.md', [
      '# Proposal',
      '',
      '## AIFHub Source Binding',
      '',
      '- Provider: jira',
      '- Primary source: https://acme.atlassian.net/browse/PROJ-77',
      '- External ID: PROJ-77',
      '- Branch: feature/some-request-slug',
      ''
    ].join('\n'));
    const mismatch = await validateOpenSpecArtifactContract({
      rootDir: validRoot,
      changeId: 'eng-431-fix-login-timeout'
    });
    assert.equal(mismatch.status, 'fail');
    assert.equal(getCheck(mismatch, 'issue-source-binding').details.rule_code, 'source-binding-change-id-mismatch');

    const ordinaryNumericRoot = await createTempRoot();
    await createValidChange(ordinaryNumericRoot, '156');
    const ordinaryNumeric = await validateOpenSpecArtifactContract({
      rootDir: ordinaryNumericRoot,
      changeId: '156'
    });
    assert.equal(getCheck(ordinaryNumeric, 'issue-source-binding').status, 'pass');
  });

  it('fails when delta specs are missing without an explicit skip-specs reason', async () => {
    const rootDir = await createTempRoot();
    await createValidChange(rootDir);
    await rm(path.join(rootDir, 'openspec', 'changes', 'add-oauth', 'specs'), {
      recursive: true,
      force: true
    });

    const result = await validateOpenSpecArtifactContract({
      rootDir,
      changeId: 'add-oauth'
    });

    assert.equal(result.status, 'fail');
    assert.equal(getCheck(result, 'delta-specs-present').status, 'fail');
  });

  it('accepts native OpenSpec skip_specs metadata when delta specs are intentionally absent', async () => {
    const rootDir = await createTempRoot();
    await createValidChange(rootDir);
    await rm(path.join(rootDir, 'openspec', 'changes', 'add-oauth', 'specs'), {
      recursive: true,
      force: true
    });
    await writeFixture(rootDir, 'openspec/changes/add-oauth/.openspec.yaml', [
      'schema: spec-driven',
      'created: 2026-08-09',
      'skip_specs: true',
      ''
    ].join('\n'));

    const result = await validateOpenSpecArtifactContract({
      rootDir,
      changeId: 'add-oauth'
    });

    assert.notEqual(result.status, 'fail');
    assert.equal(result.blocking, false);
    assert.equal(getCheck(result, 'delta-specs-present').status, 'pass');
    assert.equal(getCheck(result, 'delta-specs-present').path, 'openspec/changes/add-oauth/.openspec.yaml');
    assert.match(getCheck(result, 'delta-specs-present').message, /skip_specs: true/);
  });

  it('accepts OpenSpec 1.10 no-spec schema scaffolding through native skip_specs metadata', async () => {
    const rootDir = await createTempRoot();
    await createValidChange(rootDir);
    await rm(path.join(rootDir, 'openspec', 'changes', 'add-oauth', 'specs'), {
      recursive: true,
      force: true
    });
    await writeFixture(rootDir, 'openspec/changes/add-oauth/.openspec.yaml', [
      'schema: no-specs',
      'created: 2026-09-01',
      'skip_specs: true',
      ''
    ].join('\n'));

    const result = await validateOpenSpecArtifactContract({
      rootDir,
      changeId: 'add-oauth'
    });

    assert.notEqual(result.status, 'fail');
    assert.equal(result.blocking, false);
    assert.equal(getCheck(result, 'delta-specs-present').status, 'pass');
    assert.equal(getCheck(result, 'delta-specs-present').path, 'openspec/changes/add-oauth/.openspec.yaml');
    assert.match(getCheck(result, 'delta-specs-present').message, /native skip_specs: true/);
  });

  it('fails closed when native skip_specs metadata is not boolean', async () => {
    const rootDir = await createTempRoot();
    await createValidChange(rootDir);
    await rm(path.join(rootDir, 'openspec', 'changes', 'add-oauth', 'specs'), {
      recursive: true,
      force: true
    });
    await writeFixture(rootDir, 'openspec/changes/add-oauth/.openspec.yaml', [
      'schema: spec-driven',
      'skip_specs: "true"',
      ''
    ].join('\n'));

    const result = await validateOpenSpecArtifactContract({
      rootDir,
      changeId: 'add-oauth'
    });

    assert.equal(result.status, 'fail');
    assert.equal(result.blocking, true);
    assert.equal(getCheck(result, 'delta-specs-present').path, 'openspec/changes/add-oauth/.openspec.yaml');
    assert.match(getCheck(result, 'delta-specs-present').message, /boolean true or false/);
  });

  it('warns when generated rules are stale and suggests sync', async () => {
    const rootDir = await createTempRoot();
    await createValidChange(rootDir);
    await writeFixture(rootDir, 'openspec/specs/auth/spec.md', '# Auth Base\n\nChanged after rule sync.\n');

    const result = await validateOpenSpecArtifactContract({
      rootDir,
      changeId: 'add-oauth'
    });

    assert.equal(result.status, 'warn');
    assert.equal(result.suggested_next.command, '/aif-mode sync --change add-oauth');
    assert.ok(result.checks.some((check) => check.id === 'generated-rules-current' && check.status === 'warn'));
  });

  it('fails when runtime evidence is placed inside openspec/changes', async () => {
    const rootDir = await createTempRoot();
    await createValidChange(rootDir);
    await writeFixture(rootDir, 'openspec/changes/add-oauth/state/runtime.json', '{}\n');

    const result = await validateOpenSpecArtifactContract({
      rootDir,
      changeId: 'add-oauth'
    });
    const failures = result.checks.filter((check) =>
      check.id === 'runtime-files-outside-change' && check.status === 'fail'
    );

    assert.equal(result.status, 'fail');
    assert.deepEqual(failures.map((check) => check.path), [
      'openspec/changes/add-oauth/state/runtime.json'
    ]);
  });

  it('allows capability directories whose names match runtime directory names', async () => {
    const rootDir = await createTempRoot();
    await createValidChange(rootDir);
    await writeFixture(rootDir, 'openspec/changes/add-oauth/specs/state/spec.md', [
      '# State Delta',
      '',
      '## ADDED Requirements',
      '',
      '### Requirement: State transition',
      '',
      'The system MUST expose a valid state transition.',
      '',
      '#### Scenario: transition succeeds',
      '',
      '- GIVEN a valid current state',
      '- WHEN the transition is requested',
      '- THEN the next state is recorded.',
      ''
    ].join('\n'));
    await compileOpenSpecRules('add-oauth', { rootDir });

    const result = await validateOpenSpecArtifactContract({
      rootDir,
      changeId: 'add-oauth'
    });

    assert.equal(result.status, 'pass');
    assert.equal(getCheck(result, 'runtime-files-outside-change').status, 'pass');
  });

  it('fails closed on root or nested ultra index, phase, and legacy companion artifacts', async () => {
    const cases = [
      ['index-root', 'openspec/changes/add-oauth/index.md', 'openspec-ultra-index-forbidden'],
      ['index-nested', 'openspec/changes/add-oauth/notes/index.md', 'openspec-ultra-index-forbidden'],
      ['phase-root', 'openspec/changes/add-oauth/phase-01-foundation.md', 'openspec-ultra-phase-forbidden'],
      ['phase-nested', 'openspec/changes/add-oauth/notes/phase-02-integration.md', 'openspec-ultra-phase-forbidden'],
      ['legacy-context', 'openspec/changes/add-oauth/notes/context.md', 'openspec-legacy-companion-forbidden']
    ];

    for (const [name, relativePath, ruleCode] of cases) {
      const rootDir = await createTempRoot();
      await createValidChange(rootDir);
      await writeFixture(rootDir, relativePath, `# ${name}\n`);

      const result = await validateOpenSpecArtifactContract({
        rootDir,
        changeId: 'add-oauth'
      });
      const failure = result.checks.find((check) =>
        check.id === 'planning-artifacts-outside-change'
        && check.status === 'fail'
        && check.details?.rule_code === ruleCode
      );

      assert.equal(result.status, 'fail', name);
      assert.equal(failure?.path, relativePath, name);
      assert.equal(result.suggested_next.command, '/aif-fix add-oauth', name);
    }
  });

  it('rejects only an active standalone ultra marker and allows documented inline or fenced literals', async () => {
    const activeRoot = await createTempRoot();
    await createValidChange(activeRoot);
    await writeFixture(activeRoot, 'openspec/changes/add-oauth/proposal.md', [
      '<!-- aif:plan-mode:ultra -->',
      '# Proposal',
      '',
      '## Why',
      '',
      'Describe ultra depth without changing artifact shape.',
      ''
    ].join('\n'));
    const active = await validateOpenSpecArtifactContract({ rootDir: activeRoot, changeId: 'add-oauth' });
    assert.equal(active.status, 'fail');
    assert.ok(active.checks.some((check) =>
      check.id === 'planning-artifacts-outside-change'
      && check.details?.rule_code === 'openspec-ultra-marker-forbidden'
    ));

    for (const [name, literal] of [
      ['inline', 'The documented marker is `<!-- aif:plan-mode:ultra -->`.'],
      ['fenced', '```md\n<!-- aif:plan-mode:ultra -->\n```']
    ]) {
      const rootDir = await createTempRoot();
      await createValidChange(rootDir);
      await writeFixture(rootDir, 'openspec/changes/add-oauth/proposal.md', [
        '# Proposal',
        '',
        '## Why',
        '',
        literal,
        ''
      ].join('\n'));

      const result = await validateOpenSpecArtifactContract({ rootDir, changeId: 'add-oauth' });
      assert.equal(result.status, 'pass', name);
      assert.equal(getCheck(result, 'planning-artifacts-outside-change').status, 'pass', name);
    }
  });

  it('fails missing verify gate when verification evidence is required', async () => {
    const rootDir = await createTempRoot();
    await createValidChange(rootDir);
    await writeVerificationEvidence(rootDir, 'add-oauth', {
      verifyContent: '# Verify: add-oauth\n\nVerdict: PASS\n'
    });

    const result = await validateOpenSpecArtifactContract({
      rootDir,
      changeId: 'add-oauth',
      requireVerificationEvidence: true
    });

    assert.equal(result.status, 'fail');
    assert.equal(getCheck(result, 'qa-verify-gate').status, 'fail');
  });

  it('fails direct openspec/specs mutation supplied by changedPaths', async () => {
    const rootDir = await createTempRoot();
    await createValidChange(rootDir);

    const result = await validateOpenSpecArtifactContract({
      rootDir,
      changeId: 'add-oauth',
      changedPaths: ['openspec/specs/auth/spec.md']
    });

    assert.equal(result.status, 'fail');
    assert.equal(getCheck(result, 'base-specs-not-directly-mutated').status, 'fail');
  });

  it('does not write files while validating', async () => {
    const rootDir = await createTempRoot();
    await createValidChange(rootDir);
    const before = await snapshotFiles(rootDir);

    await validateOpenSpecArtifactContract({
      rootDir,
      changeId: 'add-oauth'
    });

    assert.deepEqual(await snapshotFiles(rootDir), before);
  });
});

describe('OpenSpec artifact contract CLI', () => {
  it('emits JSON and exits 0 on pass', async () => {
    const rootDir = await createTempRoot();
    await createValidChange(rootDir);

    const result = await runArtifactValidatorCommand(['--change', 'add-oauth', '--json'], { rootDir });
    const parsed = JSON.parse(result.stdout);

    assert.equal(result.exitCode, 0);
    assert.equal(parsed.status, 'pass');
  });

  it('emits human output and exits 0 on warn', async () => {
    const rootDir = await createTempRoot();
    await createValidChange(rootDir);
    await writeFixture(rootDir, 'openspec/specs/auth/spec.md', '# Auth Base\n\nChanged after rule sync.\n');

    const result = await runArtifactValidatorCommand(['--change', 'add-oauth'], { rootDir });

    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /AIFHub OpenSpec artifact contract: WARN/);
  });

  it('exits 1 on contract failure', async () => {
    const rootDir = await createTempRoot();
    await createValidChange(rootDir);
    await rm(path.join(rootDir, 'openspec', 'changes', 'add-oauth', 'specs'), {
      recursive: true,
      force: true
    });

    const result = await runArtifactValidatorCommand(['--change', 'add-oauth'], { rootDir });

    assert.equal(result.exitCode, 1);
    assert.match(result.stdout, /delta-specs-present/);
  });

  it('exits 2 on invalid args or unresolved changes', async () => {
    const rootDir = await createTempRoot();

    assert.equal((await runArtifactValidatorCommand(['--bad'], { rootDir })).exitCode, 2);
    assert.equal((await runArtifactValidatorCommand(['--change', 'missing-change'], { rootDir })).exitCode, 2);
  });
});
