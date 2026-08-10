// openspec-coverage-matrix.test.mjs - tests for OpenSpec spec-to-code coverage matrix
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  buildOpenSpecCoverageMatrix,
  evaluateOpenSpecCoveragePolicy,
  parseCoverageMatrixArgs,
  readOpenSpecCoverageMatrix,
  runCoverageMatrixCommand,
  summarizeOpenSpecCoverage,
  writeOpenSpecCoverageMatrix
} from './openspec-coverage-matrix.mjs';

const tempRoots = [];

async function createTempRoot() {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'aifhub-openspec-coverage-'));
  tempRoots.push(rootDir);
  return rootDir;
}

async function writeFixture(rootDir, relativePath, content) {
  const targetPath = path.join(rootDir, ...relativePath.split('/'));
  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeFile(targetPath, content, 'utf8');
  return targetPath;
}

async function createChange(rootDir, changeId = 'add-oauth') {
  await writeFixture(rootDir, `openspec/changes/${changeId}/proposal.md`, '# Proposal\n');
  await writeFixture(rootDir, `openspec/changes/${changeId}/design.md`, '# Design\n');
  await writeFixture(rootDir, `openspec/changes/${changeId}/tasks.md`, [
    '# Tasks',
    '',
    '- [x] 1.1 Implement OAuth login in src/auth/login.ts and src/auth/session.ts.',
    '  - [x] 1.2 Add nested regression coverage in tests/auth/login.test.ts.',
    ''
  ].join('\n'));
  await writeFixture(rootDir, `openspec/changes/${changeId}/specs/auth/spec.md`, [
    '# Auth Delta',
    '',
    '## ADDED Requirements',
    '',
    '### Requirement: OAuth Login',
    '',
    'The system MUST support OAuth login sessions.',
    '',
    '#### Scenario: Successful login',
    '',
    '- GIVEN a valid OAuth callback',
    '- WHEN the user signs in',
    '- THEN a login session is created',
    ''
  ].join('\n'));
  await writeFixture(rootDir, `.ai-factory/state/${changeId}/implementation/run-001.md`, [
    '# Implementation Trace',
    '',
    'Changed files:',
    '- src/auth/login.ts',
    '- src/auth/session.ts',
    '- tests/auth/login.test.ts',
    ''
  ].join('\n'));
}

async function createGeneratedRules(rootDir, changeId = 'add-oauth') {
  const files = [
    ['merged', `.ai-factory/rules/generated/openspec-merged-${changeId}.md`, '# Merged Rules\n'],
    ['change', `.ai-factory/rules/generated/openspec-change-${changeId}.md`, '# Change Rules\n'],
    ['base', '.ai-factory/rules/generated/openspec-base.md', '# Base Rules\n']
  ];
  const rules = [];
  for (const [kind, relativePath, content] of files) {
    await writeFixture(rootDir, relativePath, content);
    rules.push({
      kind,
      path: relativePath,
      exists: true,
      stale: false,
      content
    });
  }
  return rules;
}

async function captureStdout(fn) {
  const originalWrite = process.stdout.write;
  const chunks = [];
  process.stdout.write = (chunk, ...args) => {
    chunks.push(String(chunk));
    const callback = args.find((arg) => typeof arg === 'function');
    if (callback) {
      callback();
    }
    return true;
  };

  try {
    return {
      result: await fn(),
      stdout: chunks.join('')
    };
  } finally {
    process.stdout.write = originalWrite;
  }
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((rootDir) => rm(rootDir, {
    recursive: true,
    force: true
  })));
});

describe('OpenSpec coverage matrix', () => {
  it('builds requirement-to-nested-task-to-code coverage and writes a stable QA artifact', async () => {
    const rootDir = await createTempRoot();
    await createChange(rootDir);
    const generatedRules = await createGeneratedRules(rootDir);

    const matrix = await buildOpenSpecCoverageMatrix({
      rootDir,
      changeId: 'add-oauth',
      policy: 'strict',
      generatedRules
    });

    assert.equal(matrix.schema_version, 1);
    assert.equal(matrix.change_id, 'add-oauth');
    assert.equal(matrix.status, 'pass');
    assert.deepEqual(matrix.summary, {
      covered: 1,
      partial: 0,
      missing: 0,
      not_applicable: 0
    });
    assert.deepEqual(matrix.requirements[0], {
      id: 'auth.oauth-login',
      source: 'openspec/changes/add-oauth/specs/auth/spec.md',
      status: 'covered',
      tasks: ['1.1', '1.2'],
      implementation_evidence: [
        'src/auth/login.ts',
        'src/auth/session.ts'
      ],
      test_evidence: [
        'tests/auth/login.test.ts'
      ],
      rules_gate: 'pass'
    });

    const writeResult = await writeOpenSpecCoverageMatrix('add-oauth', matrix, { rootDir });
    assert.equal(writeResult.relativePath, '.ai-factory/qa/add-oauth/coverage.json');

    const latest = await readOpenSpecCoverageMatrix('add-oauth', { rootDir });
    assert.equal(latest.ok, true);
    assert.equal(latest.exists, true);
    assert.equal(latest.stale, false);
    assert.equal(latest.coverage.status, 'pass');
    assert.match(summarizeOpenSpecCoverage(latest.coverage), /Coverage matrix: PASS/);
  });

  it('counts active prompt source assets as implementation evidence', async () => {
    const rootDir = await createTempRoot();
    const changeId = 'shared-language-policy';
    await writeFixture(rootDir, `openspec/changes/${changeId}/proposal.md`, '# Proposal\n');
    await writeFixture(rootDir, `openspec/changes/${changeId}/design.md`, '# Design\n');
    await writeFixture(rootDir, `openspec/changes/${changeId}/tasks.md`, [
      '# Tasks',
      '',
      '- [x] 1.1 Make active prompt assets follow the shared language policy in skills/shared/LANGUAGE-POLICY.md, skills/aif-mode/SKILL.md, injections/core/aif-verify-plan-folder.md, agent-files/codex/aifhub-verifier.toml, and agent-files/claude/aifhub-verifier.md.',
      '- [x] 1.2 Add regression coverage in scripts/openspec-prompt-assets.test.mjs.',
      ''
    ].join('\n'));
    await writeFixture(rootDir, `openspec/changes/${changeId}/specs/prompt-localization/spec.md`, [
      '# Prompt Localization Delta',
      '',
      '## ADDED Requirements',
      '',
      '### Requirement: Active prompt assets follow shared language policy',
      '',
      'AIFHub active prompt assets MUST follow the shared language policy.',
      '',
      '#### Scenario: Active prompts reference policy',
      '',
      '- GIVEN active prompt assets are packaged',
      '- WHEN the prompt contract test runs',
      '- THEN each prompt follows the shared language policy',
      ''
    ].join('\n'));
    const generatedRules = await createGeneratedRules(rootDir, changeId);

    const matrix = await buildOpenSpecCoverageMatrix({
      rootDir,
      changeId,
      policy: 'strict',
      generatedRules
    });

    assert.equal(matrix.status, 'pass');
    assert.deepEqual(matrix.summary, {
      covered: 1,
      partial: 0,
      missing: 0,
      not_applicable: 0
    });
    assert.deepEqual(matrix.requirements[0].implementation_evidence, [
      'agent-files/claude/aifhub-verifier.md',
      'agent-files/codex/aifhub-verifier.toml',
      'injections/core/aif-verify-plan-folder.md',
      'skills/aif-mode/SKILL.md',
      'skills/shared/LANGUAGE-POLICY.md'
    ]);
    assert.deepEqual(matrix.requirements[0].test_evidence, [
      'scripts/openspec-prompt-assets.test.mjs'
    ]);
  });

  it('counts root-level tooling and config paths as implementation evidence', async () => {
    const rootDir = await createTempRoot();
    const changeId = 'tooling-config-evidence';
    await writeFixture(rootDir, `openspec/changes/${changeId}/proposal.md`, '# Proposal\n');
    await writeFixture(rootDir, `openspec/changes/${changeId}/design.md`, '# Design\n');
    await writeFixture(rootDir, `openspec/changes/${changeId}/tasks.md`, [
      '# Tasks',
      '',
      '- [x] 1.1 Configure Testo PHP tooling in composer.json, testo.php, .github/workflows/tests.yml, and src/v1.2/auth/login.ts.',
      '- [x] 1.2 Keep non-implementation references out of implementation evidence: docs/testo.md, openspec/changes/tooling-config-evidence/tasks.md, and .ai-factory/state/tooling-config-evidence/implementation/run-001.md.',
      '- [x] 1.3 Add regression coverage in tests/Testo/SmokeTest.php.',
      ''
    ].join('\n'));
    await writeFixture(rootDir, `openspec/changes/${changeId}/specs/testo/spec.md`, [
      '# Testo Delta',
      '',
      '## ADDED Requirements',
      '',
      '### Requirement: Testo PHP tooling config',
      '',
      'The system MUST provide Testo PHP tooling config.',
      '',
      '#### Scenario: Tooling config is covered',
      '',
      '- GIVEN the change configures Testo PHP tooling',
      '- WHEN the coverage matrix is built',
      '- THEN root-level and workflow config files count as implementation evidence',
      ''
    ].join('\n'));
    await writeFixture(rootDir, `.ai-factory/state/${changeId}/implementation/run-001.md`, [
      '# Implementation Trace',
      '',
      'Changed files:',
      '- composer.json',
      '- testo.php',
      '- .github/workflows/tests.yml',
      '- src/v1.2/auth/login.ts',
      '- docs/testo.md',
      '- openspec/changes/tooling-config-evidence/tasks.md',
      '- .ai-factory/state/tooling-config-evidence/implementation/run-001.md',
      '- tests/Testo/SmokeTest.php',
      ''
    ].join('\n'));

    const matrix = await buildOpenSpecCoverageMatrix({
      rootDir,
      changeId,
      policy: 'strict',
      generatedRules: []
    });

    assert.equal(matrix.status, 'pass');
    assert.deepEqual(matrix.summary, {
      covered: 1,
      partial: 0,
      missing: 0,
      not_applicable: 0
    });
    assert.deepEqual(matrix.requirements[0].implementation_evidence, [
      '.github/workflows/tests.yml',
      'composer.json',
      'src/v1.2/auth/login.ts',
      'testo.php'
    ]);
    assert.deepEqual(matrix.requirements[0].test_evidence, [
      'tests/Testo/SmokeTest.php'
    ]);
  });

  it('fails missing requirements in strict mode and warns in normal mode', async () => {
    const rootDir = await createTempRoot();
    await writeFixture(rootDir, 'openspec/changes/add-oauth/proposal.md', '# Proposal\n');
    await writeFixture(rootDir, 'openspec/changes/add-oauth/design.md', '# Design\n');
    await writeFixture(rootDir, 'openspec/changes/add-oauth/tasks.md', '# Tasks\n');
    await writeFixture(rootDir, 'openspec/changes/add-oauth/specs/auth/spec.md', [
      '# Auth Delta',
      '',
      '## ADDED Requirements',
      '',
      '### Requirement: OAuth Login',
      '',
      'The system MUST support OAuth login.',
      ''
    ].join('\n'));

    const strict = await buildOpenSpecCoverageMatrix({
      rootDir,
      changeId: 'add-oauth',
      policy: 'strict',
      generatedRules: []
    });
    const normal = await buildOpenSpecCoverageMatrix({
      rootDir,
      changeId: 'add-oauth',
      policy: 'normal',
      generatedRules: []
    });

    assert.equal(strict.summary.missing, 1);
    assert.equal(strict.status, 'fail');
    assert.equal(strict.blocking, true);
    assert.equal(normal.status, 'warn');
    assert.equal(normal.blocking, false);
    assert.deepEqual(
      evaluateOpenSpecCoveragePolicy(strict, { policy: 'strict' }).errors.map((error) => error),
      ['Coverage matrix has 1 missing requirement(s).']
    );
  });

  it('marks coverage stale when a material source fingerprint changes', async () => {
    const rootDir = await createTempRoot();
    await createChange(rootDir);
    const generatedRules = await createGeneratedRules(rootDir);
    const matrix = await buildOpenSpecCoverageMatrix({
      rootDir,
      changeId: 'add-oauth',
      policy: 'strict',
      generatedRules
    });
    await writeOpenSpecCoverageMatrix('add-oauth', matrix, { rootDir });
    await writeFixture(rootDir, 'openspec/changes/add-oauth/tasks.md', '# Tasks\n\n- [ ] 1.1 Changed task.\n');

    const latest = await readOpenSpecCoverageMatrix('add-oauth', { rootDir });

    assert.equal(latest.exists, true);
    assert.equal(latest.stale, true);
    assert.ok(latest.warnings.some((warning) => warning.includes('tasks.md')));

    const rebuiltForSpec = await buildOpenSpecCoverageMatrix({
      rootDir,
      changeId: 'add-oauth',
      policy: 'strict',
      generatedRules
    });
    await writeOpenSpecCoverageMatrix('add-oauth', rebuiltForSpec, { rootDir });
    await writeFixture(rootDir, 'openspec/changes/add-oauth/specs/auth/spec.md', '# Auth Delta\n\n## ADDED Requirements\n\n### Requirement: Changed OAuth Login\n\nThe system MUST support changed OAuth login.\n');

    const specStale = await readOpenSpecCoverageMatrix('add-oauth', { rootDir });
    assert.equal(specStale.stale, true);
    assert.ok(specStale.warnings.some((warning) => warning.includes('spec.md')));

    const rebuiltForTrace = await buildOpenSpecCoverageMatrix({
      rootDir,
      changeId: 'add-oauth',
      policy: 'strict',
      generatedRules
    });
    await writeOpenSpecCoverageMatrix('add-oauth', rebuiltForTrace, { rootDir });
    await writeFixture(rootDir, '.ai-factory/state/add-oauth/implementation/run-001.md', '# Implementation Trace\n\nChanged files:\n- src/auth/login.ts\n');

    const traceStale = await readOpenSpecCoverageMatrix('add-oauth', { rootDir });
    assert.equal(traceStale.stale, true);
    assert.ok(traceStale.warnings.some((warning) => warning.includes('run-001.md')));

    await writeFixture(rootDir, '.ai-factory/qa/add-oauth/verify.md', '# Verify\n\nCode verification: PASS\n');
    const rebuiltForVerify = await buildOpenSpecCoverageMatrix({
      rootDir,
      changeId: 'add-oauth',
      policy: 'strict',
      generatedRules
    });
    await writeOpenSpecCoverageMatrix('add-oauth', rebuiltForVerify, { rootDir });
    await writeFixture(rootDir, '.ai-factory/qa/add-oauth/verify.md', '# Verify\n\nCode verification: PASS\nUpdated.\n');

    const verifyStale = await readOpenSpecCoverageMatrix('add-oauth', { rootDir });
    assert.equal(verifyStale.stale, true);
    assert.ok(verifyStale.warnings.some((warning) => warning.includes('verify.md')));
  });

  it('parses CLI arguments defensively', () => {
    const parsed = parseCoverageMatrixArgs([
      '--change',
      'add-oauth',
      '--write',
      '--json',
      '--policy',
      'strict'
    ]);

    assert.equal(parsed.ok, true);
    assert.equal(parsed.changeId, 'add-oauth');
    assert.equal(parsed.write, true);
    assert.equal(parsed.json, true);
    assert.equal(parsed.policy, 'strict');

    const invalid = parseCoverageMatrixArgs(['--policy', 'hard']);
    assert.equal(invalid.ok, false);
    assert.match(invalid.errors[0], /Unsupported coverage policy/);

    const invalidChange = parseCoverageMatrixArgs(['--change', '../bad']);
    assert.equal(invalidChange.ok, false);
    assert.match(invalidChange.errors[0], /Invalid OpenSpec change id/);
  });

  it('runs the CLI with deterministic JSON output and exit codes', async () => {
    const passRoot = await createTempRoot();
    await createChange(passRoot);
    const generatedRules = await createGeneratedRules(passRoot);

    const pass = await captureStdout(() => runCoverageMatrixCommand([
      '--change',
      'add-oauth',
      '--write',
      '--json',
      '--policy',
      'strict'
    ], {
      rootDir: passRoot,
      generatedRules
    }));

    assert.equal(pass.result, 0);
    assert.equal(JSON.parse(pass.stdout).status, 'pass');

    const failRoot = await createTempRoot();
    await writeFixture(failRoot, 'openspec/changes/add-oauth/proposal.md', '# Proposal\n');
    await writeFixture(failRoot, 'openspec/changes/add-oauth/design.md', '# Design\n');
    await writeFixture(failRoot, 'openspec/changes/add-oauth/tasks.md', '# Tasks\n');
    await writeFixture(failRoot, 'openspec/changes/add-oauth/specs/auth/spec.md', [
      '# Auth Delta',
      '',
      '## ADDED Requirements',
      '',
      '### Requirement: OAuth Login',
      '',
      'The system MUST support OAuth login.',
      ''
    ].join('\n'));

    const fail = await captureStdout(() => runCoverageMatrixCommand([
      '--change',
      'add-oauth',
      '--json',
      '--policy',
      'strict'
    ], {
      rootDir: failRoot,
      generatedRules: []
    }));

    assert.equal(fail.result, 1);
    assert.equal(JSON.parse(fail.stdout).status, 'fail');

    const invalid = await captureStdout(() => runCoverageMatrixCommand(['--bad', '--json'], {
      rootDir: failRoot
    }));

    assert.equal(invalid.result, 2);
    assert.equal(JSON.parse(invalid.stdout).ok, false);

    const invalidChange = await captureStdout(() => runCoverageMatrixCommand([
      '--change',
      '../bad',
      '--json'
    ], {
      rootDir: failRoot
    }));

    assert.equal(invalidChange.result, 2);
    assert.match(JSON.parse(invalidChange.stdout).errors[0], /Invalid OpenSpec change id/);
  });

  it('rejects invalid change ids with meaningful helper errors', async () => {
    const rootDir = await createTempRoot();

    await assert.rejects(
      () => readOpenSpecCoverageMatrix('../bad', { rootDir }),
      /Invalid OpenSpec change id/
    );
    await assert.rejects(
      () => writeOpenSpecCoverageMatrix('../bad', {
        schema_version: 1,
        change_id: '../bad',
        requirements: [],
        summary: { covered: 0, partial: 0, missing: 0, not_applicable: 0 }
      }, { rootDir }),
      /Invalid OpenSpec change id/
    );
  });

  it('persists exact source fingerprints in coverage.json', async () => {
    const rootDir = await createTempRoot();
    await createChange(rootDir);
    const generatedRules = await createGeneratedRules(rootDir);
    const matrix = await buildOpenSpecCoverageMatrix({
      rootDir,
      changeId: 'add-oauth',
      policy: 'strict',
      generatedRules
    });
    await writeOpenSpecCoverageMatrix('add-oauth', matrix, { rootDir });

    const raw = JSON.parse(await readFile(path.join(rootDir, '.ai-factory', 'qa', 'add-oauth', 'coverage.json'), 'utf8'));

    assert.ok(raw.sources.some((source) => source.path === 'openspec/changes/add-oauth/specs/auth/spec.md'));
    assert.ok(raw.sources.some((source) => source.path === 'openspec/changes/add-oauth/tasks.md'));
    assert.ok(raw.sources.every((source) => /^[a-f0-9]{64}$/.test(source.sha256)));
  });
});
