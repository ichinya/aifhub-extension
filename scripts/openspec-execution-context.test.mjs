// openspec-execution-context.test.mjs - tests for OpenSpec implement/fix runtime context
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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

async function createGeneratedRulesTrace(rootDir, changeId = 'add-oauth', options = {}) {
  const baseFingerprint = options.baseFingerprint ?? fingerprint(baseAuthSpec);
  const changeFingerprint = options.changeFingerprint ?? fingerprint(deltaAuthSpec);
  const trace = {
    schema_version: 1,
    validator: 'aifhub-generated-rules-trace',
    change_id: changeId,
    generated_at: '2026-05-09T00:00:00.000Z',
    inputs: [
      {
        path: 'openspec/specs/auth/spec.md',
        sha256: baseFingerprint,
        kind: 'base-spec'
      },
      {
        path: `openspec/changes/${changeId}/specs/auth/spec.md`,
        sha256: changeFingerprint,
        kind: 'delta-spec'
      }
    ],
    rules: []
  };

  if (options.includeOutputs) {
    const baseRules = await readFile(path.join(rootDir, '.ai-factory', 'rules', 'generated', 'openspec-base.md'), 'utf8');
    const changeRules = await readFile(path.join(rootDir, '.ai-factory', 'rules', 'generated', `openspec-change-${changeId}.md`), 'utf8');
    const mergedRules = await readFile(path.join(rootDir, '.ai-factory', 'rules', 'generated', `openspec-merged-${changeId}.md`), 'utf8');
    trace.outputs = [
      {
        path: '.ai-factory/rules/generated/openspec-base.md',
        sha256: fingerprint(baseRules),
        kind: 'base-rules'
      },
      {
        path: `.ai-factory/rules/generated/openspec-change-${changeId}.md`,
        sha256: fingerprint(changeRules),
        kind: 'change-rules'
      },
      {
        path: `.ai-factory/rules/generated/openspec-merged-${changeId}.md`,
        sha256: fingerprint(mergedRules),
        kind: 'merged-rules'
      }
    ];
  }

  await writeFixture(rootDir, `.ai-factory/rules/generated/openspec-rules-trace-${changeId}.json`, `${JSON.stringify(trace, null, 2)}\n`);
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

function fingerprint(content) {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
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

  it('prefers trace input hashes over markdown fingerprints for generated-rule freshness', async () => {
    const { collectGeneratedRules } = await loadExecutionContext();
    const rootDir = await createTempRoot();
    await createOpenSpecChange(rootDir, 'add-oauth');
    await createGeneratedRules(rootDir, 'add-oauth', {
      baseFingerprint: 'sha256:stale-markdown-base',
      changeFingerprint: 'sha256:stale-markdown-change'
    });
    await createGeneratedRulesTrace(rootDir, 'add-oauth');

    const result = await collectGeneratedRules('add-oauth', { rootDir });

    assert.equal(result.ok, true);
    assert.equal(result.generatedRules.every((item) => item.stale === false), true);
    assert.equal(result.generatedRules.every((item) => item.staleSource === 'trace'), true);
    assert.equal(result.generatedRules.every((item) => item.trace.exists && item.trace.valid), true);
    assert.equal(result.warnings.some((warning) => warning.code === 'stale-generated-rules'), false);
  });

  it('detects generated markdown output drift when trace output hashes are present', async () => {
    const { collectGeneratedRules } = await loadExecutionContext();
    const rootDir = await createTempRoot();
    await createOpenSpecChange(rootDir, 'add-oauth');
    await createGeneratedRules(rootDir, 'add-oauth', {
      baseFingerprint: fingerprint(baseAuthSpec),
      changeFingerprint: fingerprint(deltaAuthSpec)
    });
    await createGeneratedRulesTrace(rootDir, 'add-oauth', { includeOutputs: true });
    await writeFixture(rootDir, '.ai-factory/rules/generated/openspec-merged-add-oauth.md', [
      generatedRulesContent({
        title: 'Merged OpenSpec Rules',
        fingerprints: [
          `${fingerprint(baseAuthSpec)} openspec/specs/auth/spec.md`,
          `${fingerprint(deltaAuthSpec)} openspec/changes/add-oauth/specs/auth/spec.md`
        ]
      }),
      'Manual edit that should be detected.'
    ].join('\n'));

    const result = await collectGeneratedRules('add-oauth', { rootDir });

    assert.equal(result.ok, true);
    assert.equal(result.generatedRules.find((item) => item.kind === 'base').stale, false);
    assert.equal(result.generatedRules.find((item) => item.kind === 'change').stale, false);
    assert.equal(result.generatedRules.find((item) => item.kind === 'merged').stale, true);
    assert.equal(result.generatedRules.find((item) => item.kind === 'merged').staleSource, 'trace-output');
    assert.ok(result.warnings.some((warning) => warning.code === 'stale-generated-rules'));
  });

  it('warns when trace is missing while preserving markdown fingerprint fallback', async () => {
    const { collectGeneratedRules } = await loadExecutionContext();
    const rootDir = await createTempRoot();
    await createOpenSpecChange(rootDir, 'add-oauth');
    await createGeneratedRules(rootDir, 'add-oauth', {
      baseFingerprint: fingerprint(baseAuthSpec),
      changeFingerprint: fingerprint(deltaAuthSpec)
    });

    const result = await collectGeneratedRules('add-oauth', { rootDir });

    assert.equal(result.ok, true);
    assert.equal(result.generatedRules.every((item) => item.stale === false), true);
    assert.equal(result.generatedRules.every((item) => item.staleSource === 'markdown'), true);
    assert.ok(result.warnings.some((warning) => warning.code === 'missing-generated-rules-trace'));
    assert.equal(result.warnings.some((warning) => warning.code === 'stale-generated-rules'), false);
  });

  it('detects stale generated rules from trace input hash drift', async () => {
    const { collectGeneratedRules } = await loadExecutionContext();
    const rootDir = await createTempRoot();
    await createOpenSpecChange(rootDir, 'add-oauth');
    await createGeneratedRules(rootDir, 'add-oauth', {
      baseFingerprint: fingerprint(baseAuthSpec),
      changeFingerprint: fingerprint(deltaAuthSpec)
    });
    await createGeneratedRulesTrace(rootDir, 'add-oauth', {
      baseFingerprint: 'sha256:old-base',
      changeFingerprint: fingerprint(deltaAuthSpec)
    });

    const result = await collectGeneratedRules('add-oauth', { rootDir });

    assert.equal(result.ok, true);
    assert.equal(result.generatedRules.find((item) => item.kind === 'base').stale, true);
    assert.equal(result.generatedRules.find((item) => item.kind === 'change').stale, false);
    assert.equal(result.generatedRules.find((item) => item.kind === 'merged').stale, true);
    assert.ok(result.warnings.some((warning) => warning.code === 'stale-generated-rules'));
  });

  it('warns on invalid trace JSON and falls back to markdown fingerprints', async () => {
    const { collectGeneratedRules } = await loadExecutionContext();
    const rootDir = await createTempRoot();
    await createOpenSpecChange(rootDir, 'add-oauth');
    await createGeneratedRules(rootDir, 'add-oauth', {
      baseFingerprint: fingerprint(baseAuthSpec),
      changeFingerprint: fingerprint(deltaAuthSpec)
    });
    await writeFixture(rootDir, '.ai-factory/rules/generated/openspec-rules-trace-add-oauth.json', JSON.stringify({
      schema_version: 1,
      change_id: 'add-oauth'
    }, null, 2));

    const result = await collectGeneratedRules('add-oauth', { rootDir });

    assert.equal(result.ok, true);
    assert.equal(result.generatedRules.every((item) => item.stale === false), true);
    assert.equal(result.generatedRules.every((item) => item.staleSource === 'markdown'), true);
    assert.ok(result.warnings.some((warning) => warning.code === 'invalid-generated-rules-trace'));
  });

  it('skips OpenSpec apply instructions when useInstructionsApply is false', async () => {
    const { buildImplementationContext } = await loadExecutionContext();
    const rootDir = await createTempRoot();
    let instructionCalls = 0;
    await createOpenSpecChange(rootDir, 'add-oauth');
    await writeFixture(rootDir, '.ai-factory/config.yaml', [
      'aifhub:',
      '  openspec:',
      '    useInstructionsApply: false'
    ].join('\n'));

    const result = await buildImplementationContext({
      rootDir,
      changeId: 'add-oauth',
      detectOpenSpec: async () => availableCliDetection(),
      getOpenSpecInstructions: async () => {
        instructionCalls += 1;
        return {
          ok: true,
          json: { steps: ['apply change'] },
          stdout: '{"steps":["apply change"]}',
          stderr: ''
        };
      }
    });

    assert.equal(result.ok, true);
    assert.equal(instructionCalls, 0);
    assert.equal(result.openspecInstructions.available, false);
    assert.equal(result.openspecInstructions.detail, 'useInstructionsApply-disabled');
    assert.ok(result.warnings.some((warning) => warning.code === 'openspec-instructions-disabled'));
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
    const {
      buildFixContext,
      collectQaEvidence
    } = await loadExecutionContext();
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

    await writeFixture(rootDir, 'custom-qa/add-oauth/verify.md', '# Custom Verify\n');
    const relativeQa = await collectQaEvidence('add-oauth', {
      rootDir,
      qaDir: 'custom-qa/add-oauth'
    });

    assert.deepEqual(relativeQa.qaEvidence.map((item) => item.path), [
      'custom-qa/add-oauth/verify.md'
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
      testCheck: {
        command: 'node --test auth.test.mjs',
        scope: 'OAuth callback behavior'
      },
      redResult: {
        exitCode: 1,
        observed: 'callback expectation failed for the intended reason'
      },
      greenResult: {
        exitCode: 0,
        observed: 'same focused check passed'
      },
      refactorResult: {
        exitCode: 0,
        observed: 'same focused check stayed green after cleanup'
      },
      fallbackDecision: 'Not applicable; focused automated check was available.',
      changedFiles: ['src/auth.js']
    }, {
      rootDir,
      runId: 'run-001'
    });

    const fix = await writeFixTrace('add-oauth', {
      summary: 'Fixed OAuth',
      canonicalArtifactsRead: ['openspec/changes/add-oauth/tasks.md'],
      generatedRulesRead: [],
      testCheck: { command: 'must not render in a Fix trace' },
      qaEvidenceRead: ['.ai-factory/qa/add-oauth/verify.md'],
      rootCauseEvidence: {
        boundary: 'OAuth callback parser',
        observed: 'state was decoded after validation'
      },
      hypothesis: 'Validating decoded state before lookup will reject the stale callback.',
      experiment: 'Move only the validation boundary and rerun the focused callback check.',
      regressionCheck: {
        command: 'node --test auth.test.mjs',
        inputs: 'OAuth callback fixture',
        environment: 'temporary test root'
      },
      preFixResult: {
        exitCode: 1,
        observed: 'callback regression reproduced'
      },
      postFixResult: {
        exitCode: 0,
        observed: 'same callback check passed'
      },
      fallbackDecision: 'Not applicable; regression reproduced.',
      changedFiles: ['src/auth.js']
    }, {
      rootDir,
      runId: 'fix-001'
    });

    assert.equal(execution.ok, true);
    assert.equal(execution.relativePath, '.ai-factory/state/add-oauth/implementation/run-001.md');
    assert.equal(fix.ok, true);
    assert.equal(fix.relativePath, '.ai-factory/state/add-oauth/fixes/fix-001.md');
    assert.equal(
      await readFile(execution.path, 'utf8'),
      [
        '# Implementation Trace: add-oauth',
        '',
        '## Summary',
        '',
        'Implemented OAuth',
        '',
        '## Canonical artifacts read',
        '',
        '- openspec/changes/add-oauth/tasks.md',
        '',
        '## Generated rules read',
        '',
        '- .ai-factory/rules/generated/openspec-base.md',
        '',
        '## Development cycle',
        '',
        '### Focused automated check',
        '',
        '```json',
        '{',
        '  "command": "node --test auth.test.mjs",',
        '  "scope": "OAuth callback behavior"',
        '}',
        '```',
        '',
        '### RED result',
        '',
        '```json',
        '{',
        '  "exitCode": 1,',
        '  "observed": "callback expectation failed for the intended reason"',
        '}',
        '```',
        '',
        '### GREEN result',
        '',
        '```json',
        '{',
        '  "exitCode": 0,',
        '  "observed": "same focused check passed"',
        '}',
        '```',
        '',
        '### REFACTOR result',
        '',
        '```json',
        '{',
        '  "exitCode": 0,',
        '  "observed": "same focused check stayed green after cleanup"',
        '}',
        '```',
        '',
        '### Fallback decision',
        '',
        'Not applicable; focused automated check was available.',
        '',
        '## Changed files',
        '',
        '- src/auth.js',
        '',
        '## Next step',
        '',
        '/aif-verify add-oauth',
        ''
      ].join('\n'),
      'Implementation trace should persist the bounded development-cycle evidence.'
    );
    const fixContent = await readFile(fix.path, 'utf8');
    for (const expected of [
      '# Fix Trace: add-oauth',
      '## QA evidence read',
      '.ai-factory/qa/add-oauth/verify.md',
      '## Root cause evidence',
      'OAuth callback parser',
      'state was decoded after validation',
      '## Hypothesis',
      'Validating decoded state before lookup will reject the stale callback.',
      '## Experiment',
      'Move only the validation boundary and rerun the focused callback check.',
      '## Regression check',
      'node --test auth.test.mjs',
      'OAuth callback fixture',
      'temporary test root',
      '## Pre-fix result',
      '"exitCode": 1',
      'callback regression reproduced',
      '## Post-fix result',
      '"exitCode": 0',
      'same callback check passed',
      '## Fallback decision',
      'Not applicable; regression reproduced.'
    ]) {
      assert.match(fixContent, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `Fix trace should include ${expected}.`);
    }
    assert.doesNotMatch(
      fixContent,
      /## Development cycle/,
      'Fix traces must not render implementation evidence even when mixed-type fields are present.'
    );
    assert.equal(await pathExists(path.join(rootDir, 'openspec', 'changes', 'add-oauth', '.ai-factory')), false);
    assert.equal(await pathExists(path.join(rootDir, '.ai-factory', 'plans', 'add-oauth')), false);

    const customState = await writeExecutionTrace('add-oauth', {
      summary: 'Custom runtime state',
      canonicalArtifactsRead: ['openspec/changes/add-oauth/tasks.md'],
      generatedRulesRead: [],
      changedFiles: []
    }, {
      rootDir,
      stateDir: '.ai-factory/custom-state',
      runId: 'custom-001'
    });

    assert.equal(customState.relativePath, '.ai-factory/custom-state/add-oauth/implementation/custom-001.md');
    assert.doesNotMatch(
      await readFile(customState.path, 'utf8'),
      /## Development cycle/,
      'Legacy implementation trace callers without development-cycle fields should retain their compact shape.'
    );

    const fallbackExecution = await writeExecutionTrace('add-oauth', {
      summary: 'Updated generated documentation.',
      canonicalArtifactsRead: ['openspec/changes/add-oauth/tasks.md'],
      generatedRulesRead: [],
      fallbackDecision: {
        status: 'not-applicable',
        reason: 'documentation-only',
        verification: 'node scripts/validate-doc-links.mjs'
      },
      changedFiles: ['docs/oauth.md']
    }, {
      rootDir,
      runId: 'implementation-docs-only'
    });
    const fallbackExecutionContent = await readFile(fallbackExecution.path, 'utf8');
    assert.match(fallbackExecutionContent, /## Development cycle/);
    assert.match(fallbackExecutionContent, /### Fallback decision/);
    assert.match(fallbackExecutionContent, /"reason": "documentation-only"/);
    assert.doesNotMatch(
      fallbackExecutionContent,
      /### Focused automated check|### RED result|### GREEN result|### REFACTOR result/,
      'Fallback-only implementation traces should not imply that an inapplicable test cycle was skipped.'
    );

    await assert.rejects(
      () => writeExecutionTrace('add-oauth', { summary: 'bad state' }, {
        rootDir,
        stateDir: 'openspec/changes',
        runId: 'escape'
      }),
      /outside canonical OpenSpec changes/
    );
    assert.equal(
      await pathExists(path.join(rootDir, 'openspec', 'changes', 'add-oauth', 'implementation', 'escape.md')),
      false
    );

    const unexpectedPass = await writeFixTrace('add-oauth', {
      summary: 'Regression check passed unexpectedly.',
      regressionCheck: { command: 'node --test auth.test.mjs' },
      preFixResult: { exitCode: 0, observed: 'unexpected pass' },
      fallbackDecision: { status: 'blocked', reason: 'unexpected-pass', action: 'no implementation edits' }
    }, {
      rootDir,
      runId: 'fix-unexpected-pass'
    });
    const unexpectedPassContent = await readFile(unexpectedPass.path, 'utf8');
    assert.match(unexpectedPassContent, /"reason": "unexpected-pass"/, 'Unexpected-pass fallback should be explicit.');
    assert.match(unexpectedPassContent, /## Post-fix result\n\nNot recorded\./, 'Unexpected-pass fallback should make missing post-fix result explicit.');

    const noCheck = await writeFixTrace('add-oauth', {
      summary: 'No useful regression check was available.',
      fallbackDecision: { status: 'blocked', reason: 'no-useful-check', action: 'no implementation edits' }
    }, {
      rootDir,
      runId: 'fix-no-check'
    });
    const noCheckContent = await readFile(noCheck.path, 'utf8');
    assert.match(noCheckContent, /## QA evidence read\n\n- not recorded/, 'No-check fallback should make missing QA provenance explicit.');
    assert.match(noCheckContent, /## Regression check\n\nNot recorded\./, 'No-check fallback should make missing regression check explicit.');
    assert.match(noCheckContent, /"reason": "no-useful-check"/, 'No-check fallback reason should be explicit.');
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
