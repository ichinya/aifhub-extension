// openspec-execution-context.test.mjs - tests for OpenSpec implement/fix runtime context
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const tempRoots = [];
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const PROMPT_ASSETS = [
  'injections/core/aif-implement-plan-folder.md',
  'injections/core/aif-fix-plan-folder.md',
  'agent-files/codex/aifhub-implement-worker.toml',
  'agent-files/codex/aifhub-fixer.toml',
  'agent-files/claude/aifhub-implement-worker.md',
  'agent-files/claude/aifhub-fixer.md'
];

async function loadExecutionContext() {
  return import('./openspec-execution-context.mjs');
}

async function createTempRoot() {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'aifhub-openspec-context-'));
  tempRoots.push(rootDir);
  return rootDir;
}

async function writeFixture(rootDir, relativePath, content) {
  const targetPath = path.join(rootDir, ...relativePath.split('/'));
  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeFile(targetPath, content, 'utf8');
  return targetPath;
}

async function createOpenSpecChange(rootDir, changeId = 'add-oauth') {
  await writeFixture(rootDir, `openspec/changes/${changeId}/proposal.md`, '# Proposal\n');
  await writeFixture(rootDir, `openspec/changes/${changeId}/design.md`, '# Design\n');
  await writeFixture(rootDir, `openspec/changes/${changeId}/tasks.md`, '# Tasks\n\n- [ ] Implement\n');
  await writeFixture(rootDir, `openspec/changes/${changeId}/specs/auth/spec.md`, deltaAuthSpec);
  await writeFixture(rootDir, 'openspec/specs/auth/spec.md', baseAuthSpec);
}

async function createGeneratedRules(rootDir, changeId = 'add-oauth', options = {}) {
  const baseFingerprint = options.baseFingerprint ?? 'sha256:test-base';
  const changeFingerprint = options.changeFingerprint ?? 'sha256:test-change';
  await writeFixture(rootDir, '.ai-factory/rules/generated/openspec-base.md', generatedRulesContent({
    title: 'Base OpenSpec Rules',
    fingerprints: [`${baseFingerprint} openspec/specs/auth/spec.md`]
  }));
  await writeFixture(rootDir, `.ai-factory/rules/generated/openspec-change-${changeId}.md`, generatedRulesContent({
    title: 'Change OpenSpec Rules',
    fingerprints: [`${changeFingerprint} openspec/changes/${changeId}/specs/auth/spec.md`]
  }));
  await writeFixture(rootDir, `.ai-factory/rules/generated/openspec-merged-${changeId}.md`, generatedRulesContent({
    title: 'Merged OpenSpec Rules',
    fingerprints: [
      `${baseFingerprint} openspec/specs/auth/spec.md`,
      `${changeFingerprint} openspec/changes/${changeId}/specs/auth/spec.md`
    ]
  }));
}

async function pathExists(targetPath) {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function missingCliDetection() {
  return {
    available: false,
    canValidate: false,
    canArchive: false,
    reason: 'missing-cli',
    errors: [
      {
        code: 'missing-cli',
        message: 'OpenSpec CLI is not available on PATH.'
      }
    ]
  };
}

function availableCliDetection() {
  return {
    available: true,
    canValidate: true,
    canArchive: true,
    reason: null,
    errors: []
  };
}

function generatedRulesContent({ title, fingerprints }) {
  return [
    '# Generated OpenSpec Rules',
    '',
    `View: ${title}`,
    'Source of truth: OpenSpec canonical specs',
    '',
    '## Source Fingerprints',
    '',
    ...fingerprints.map((fingerprint) => `- ${fingerprint}`),
    ''
  ].join('\n');
}

const baseAuthSpec = `# Auth

## Requirements

### Requirement: Existing sign in

The system MUST preserve existing sign in behavior.
`;

const deltaAuthSpec = `# Auth Delta

## ADDED Requirements

### Requirement: OAuth sign in

The system MUST support OAuth sign in.
`;

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((rootDir) => rm(rootDir, {
    recursive: true,
    force: true
  })));
});

describe('OpenSpec execution context API', () => {
  it('exports the required public functions', async () => {
    const context = await loadExecutionContext();

    for (const name of [
      'buildImplementationContext',
      'buildFixContext',
      'collectCanonicalChangeArtifacts',
      'collectGeneratedRules',
      'collectQaEvidence',
      'writeExecutionTrace',
      'writeFixTrace'
    ]) {
      assert.equal(typeof context[name], 'function', `${name} should be exported`);
    }
  });

  it('builds implementation context for an explicit change id and reads canonical artifacts', async () => {
    const { buildImplementationContext } = await loadExecutionContext();
    const rootDir = await createTempRoot();
    await createOpenSpecChange(rootDir, 'add-oauth');

    const result = await buildImplementationContext({
      rootDir,
      changeId: 'add-oauth',
      detectOpenSpec: async () => missingCliDetection()
    });

    assert.equal(result.ok, true);
    assert.equal(result.mode, 'openspec-native');
    assert.equal(result.changeId, 'add-oauth');
    assert.equal(result.resolver.source, 'explicit');
    assert.deepEqual(result.resolver.candidates, ['add-oauth']);
    assert.equal(result.canonicalArtifacts.proposal.content, '# Proposal\n');
    assert.equal(result.canonicalArtifacts.design.content, '# Design\n');
    assert.match(result.canonicalArtifacts.tasks.content, /- \[ \] Implement/);
    assert.deepEqual(result.canonicalArtifacts.baseSpecs.map((item) => item.path), [
      'openspec/specs/auth/spec.md'
    ]);
    assert.deepEqual(result.canonicalArtifacts.deltaSpecs.map((item) => item.path), [
      'openspec/changes/add-oauth/specs/auth/spec.md'
    ]);
  });

  it('reads generated rules when present and warns when fingerprints are stale', async () => {
    const { buildImplementationContext } = await loadExecutionContext();
    const rootDir = await createTempRoot();
    await createOpenSpecChange(rootDir, 'add-oauth');
    await createGeneratedRules(rootDir, 'add-oauth');

    const result = await buildImplementationContext({
      rootDir,
      changeId: 'add-oauth',
      detectOpenSpec: async () => missingCliDetection()
    });

    assert.equal(result.ok, true);
    assert.deepEqual(result.generatedRules.map((item) => item.path), [
      '.ai-factory/rules/generated/openspec-merged-add-oauth.md',
      '.ai-factory/rules/generated/openspec-change-add-oauth.md',
      '.ai-factory/rules/generated/openspec-base.md'
    ]);
    assert.equal(result.generatedRules.every((item) => item.exists), true);
    assert.ok(
      result.warnings.some((warning) => warning.code === 'stale-generated-rules'),
      'stale generated rules should warn when fingerprints differ'
    );
  });

  it('warns when generated rules are missing', async () => {
    const { buildImplementationContext } = await loadExecutionContext();
    const rootDir = await createTempRoot();
    await createOpenSpecChange(rootDir, 'add-oauth');

    const result = await buildImplementationContext({
      rootDir,
      changeId: 'add-oauth',
      detectOpenSpec: async () => missingCliDetection()
    });

    assert.equal(result.ok, true);
    assert.equal(result.generatedRules.length, 3);
    assert.equal(result.generatedRules.every((item) => item.exists === false), true);
    assert.ok(
      result.warnings.some((warning) => warning.code === 'missing-generated-rules'),
      'missing generated rules should warn'
    );
  });

  it('uses OpenSpec apply instructions when compatible CLI support is injected', async () => {
    const { buildImplementationContext } = await loadExecutionContext();
    const rootDir = await createTempRoot();
    const calls = [];
    await createOpenSpecChange(rootDir, 'add-oauth');

    const result = await buildImplementationContext({
      rootDir,
      changeId: 'add-oauth',
      detectOpenSpec: async () => availableCliDetection(),
      getOpenSpecInstructions: async (artifact, options) => {
        calls.push({ artifact, options });
        return {
          ok: true,
          json: { steps: ['apply change'] },
          stdout: '{"steps":["apply change"]}',
          stderr: ''
        };
      }
    });

    assert.equal(result.ok, true);
    assert.deepEqual(calls.map((call) => ({ artifact: call.artifact, change: call.options.change })), [
      { artifact: 'apply', change: 'add-oauth' }
    ]);
    assert.deepEqual(result.openspecInstructions.json, { steps: ['apply change'] });
    assert.equal(result.openspecInstructions.available, true);
  });

  it('does not fail context creation when OpenSpec CLI is missing', async () => {
    const { buildImplementationContext } = await loadExecutionContext();
    const rootDir = await createTempRoot();
    await createOpenSpecChange(rootDir, 'add-oauth');

    const result = await buildImplementationContext({
      rootDir,
      changeId: 'add-oauth',
      detectOpenSpec: async () => missingCliDetection()
    });

    assert.equal(result.ok, true);
    assert.equal(result.openspecInstructions.available, false);
    assert.ok(
      result.warnings.some((warning) => warning.code === 'openspec-instructions-unavailable'),
      'missing CLI should produce degraded instructions warning'
    );
  });

  it('builds fix context with QA evidence and warns or fails when QA evidence is missing', async () => {
    const { buildFixContext } = await loadExecutionContext();
    const rootDir = await createTempRoot();
    await createOpenSpecChange(rootDir, 'add-oauth');
    await writeFixture(rootDir, '.ai-factory/qa/add-oauth/verify.md', '# Verify\n');

    const withQa = await buildFixContext({
      rootDir,
      changeId: 'add-oauth',
      detectOpenSpec: async () => missingCliDetection()
    });

    assert.equal(withQa.ok, true);
    assert.deepEqual(withQa.qaEvidence.map((item) => item.path), [
      '.ai-factory/qa/add-oauth/verify.md'
    ]);

    const missingRoot = await createTempRoot();
    await createOpenSpecChange(missingRoot, 'add-oauth');

    const missingQa = await buildFixContext({
      rootDir: missingRoot,
      changeId: 'add-oauth',
      detectOpenSpec: async () => missingCliDetection()
    });

    assert.equal(missingQa.ok, true);
    assert.ok(
      missingQa.warnings.some((warning) => warning.code === 'missing-qa-evidence'),
      'missing QA evidence should warn by default'
    );

    const requiredQa = await buildFixContext({
      rootDir: missingRoot,
      changeId: 'add-oauth',
      requireQaEvidence: true,
      detectOpenSpec: async () => missingCliDetection()
    });

    assert.equal(requiredQa.ok, false);
    assert.equal(requiredQa.errors[0].code, 'missing-qa-evidence');
  });

  it('writes implementation and fix traces only under runtime state', async () => {
    const {
      writeExecutionTrace,
      writeFixTrace
    } = await loadExecutionContext();
    const rootDir = await createTempRoot();
    await createOpenSpecChange(rootDir, 'add-oauth');

    const execution = await writeExecutionTrace('add-oauth', {
      summary: 'Implemented OAuth',
      canonicalArtifactsRead: ['openspec/changes/add-oauth/tasks.md'],
      generatedRulesRead: ['.ai-factory/rules/generated/openspec-base.md'],
      changedFiles: ['src/auth.js']
    }, {
      rootDir,
      runId: 'run-001'
    });

    const fix = await writeFixTrace('add-oauth', {
      summary: 'Fixed OAuth',
      canonicalArtifactsRead: ['openspec/changes/add-oauth/tasks.md'],
      generatedRulesRead: [],
      changedFiles: ['src/auth.js']
    }, {
      rootDir,
      runId: 'fix-001'
    });

    assert.equal(execution.ok, true);
    assert.equal(execution.relativePath, '.ai-factory/state/add-oauth/implementation/run-001.md');
    assert.equal(fix.ok, true);
    assert.equal(fix.relativePath, '.ai-factory/state/add-oauth/fixes/fix-001.md');
    assert.match(await readFile(execution.path, 'utf8'), /# Implementation Trace: add-oauth/);
    assert.match(await readFile(fix.path, 'utf8'), /# Fix Trace: add-oauth/);
    assert.equal(await pathExists(path.join(rootDir, 'openspec', 'changes', 'add-oauth', '.ai-factory')), false);
    assert.equal(await pathExists(path.join(rootDir, '.ai-factory', 'plans', 'add-oauth')), false);

    await assert.rejects(
      () => writeExecutionTrace('add-oauth', { summary: 'bad state' }, {
        rootDir,
        stateDir: 'openspec/changes',
        runId: 'escape'
      }),
      /canonical runtime state directory/
    );
    assert.equal(
      await pathExists(path.join(rootDir, 'openspec', 'changes', 'add-oauth', 'implementation', 'escape.md')),
      false
    );
  });

  it('returns stable failure shape for unsafe change ids and rejects unsafe run ids', async () => {
    const {
      buildImplementationContext,
      writeExecutionTrace
    } = await loadExecutionContext();
    const rootDir = await createTempRoot();

    const result = await buildImplementationContext({
      rootDir,
      changeId: '../escape',
      detectOpenSpec: async () => missingCliDetection()
    });

    assert.equal(result.ok, false);
    assert.equal(result.mode, 'openspec-native');
    assert.equal(result.changeId, null);
    assert.deepEqual(result.canonicalArtifacts, {});
    assert.deepEqual(result.generatedRules, []);
    assert.equal(result.errors[0].code, 'invalid-change-id');

    await assert.rejects(
      () => writeExecutionTrace('add-oauth', { summary: 'bad' }, { rootDir, runId: '../escape' }),
      /Invalid OpenSpec run id/
    );
    assert.equal(await pathExists(path.join(rootDir, '.ai-factory', 'state', 'add-oauth')), false);
  });

  it('does not require legacy plan-folder files for OpenSpec-native context', async () => {
    const { buildImplementationContext } = await loadExecutionContext();
    const rootDir = await createTempRoot();
    await createOpenSpecChange(rootDir, 'add-oauth');

    const result = await buildImplementationContext({
      rootDir,
      changeId: 'add-oauth',
      detectOpenSpec: async () => missingCliDetection()
    });

    assert.equal(result.ok, true);
    assert.equal(await pathExists(path.join(rootDir, '.ai-factory', 'plans', 'add-oauth', 'task.md')), false);
  });

  it('updates implement and fix prompt assets to reference execution context helper', async () => {
    for (const relativePath of PROMPT_ASSETS) {
      const content = await readFile(path.join(REPO_ROOT, relativePath), 'utf8');

      assert.match(
        content,
        /openspec-execution-context\.mjs|buildImplementationContext|buildFixContext/,
        `${relativePath} should reference the OpenSpec execution context helper`
      );
      assert.match(
        content,
        /\.ai-factory\/state\/<change-id>\//,
        `${relativePath} should keep runtime traces under .ai-factory/state/<change-id>/`
      );
    }
  });
});
