// openspec-rules-compiler.test.mjs - tests for OpenSpec generated rules compiler
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const tempRoots = [];

async function loadCompiler() {
  return import('./openspec-rules-compiler.mjs');
}

async function createTempRoot() {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'aifhub-openspec-rules-'));
  tempRoots.push(rootDir);
  return rootDir;
}

async function writeFixture(rootDir, relativePath, content) {
  const targetPath = path.join(rootDir, ...relativePath.split('/'));
  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeFile(targetPath, content, 'utf8');
  return targetPath;
}

async function createChange(rootDir, changeId, specs = {}) {
  await writeFixture(rootDir, `openspec/changes/${changeId}/proposal.md`, `# ${changeId}\n`);

  for (const [specPath, content] of Object.entries(specs)) {
    await writeFixture(rootDir, `openspec/changes/${changeId}/specs/${specPath}`, content);
  }
}

async function pathExists(targetPath) {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function readGenerated(rootDir, fileName) {
  return readFile(path.join(rootDir, '.ai-factory', 'rules', 'generated', fileName), 'utf8');
}

async function readGeneratedJson(rootDir, fileName) {
  return JSON.parse(await readGenerated(rootDir, fileName));
}

function fingerprint(content) {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

function missingCliDetection() {
  return {
    available: false,
    canValidate: false,
    canArchive: false,
    version: null,
    supportedRange: '>=1.3.1 <2.0.0',
    versionSupported: false,
    requiresNode: '>=20.19.0',
    nodeVersion: '20.19.0',
    nodeSupported: true,
    command: 'openspec',
    commandSource: 'path',
    reason: 'missing-cli',
    errors: [
      {
        code: 'missing-cli',
        message: "Selected OpenSpec CLI 'openspec' (path) is unavailable."
      }
    ]
  };
}

function compilerOptions(rootDir, overrides = {}) {
  return {
    rootDir,
    detectOpenSpec: async () => missingCliDetection(),
    getCurrentBranch: async () => 'feat/add-generated-rules',
    ...overrides
  };
}

const baseBillingSpec = `# Billing

## Requirements

### Requirement: Track Usage

The system MUST track customer usage.

#### Scenario: usage is captured

- GIVEN a billable account
- WHEN usage is reported
- THEN the usage entry is stored
`;

const deltaAuthSpec = `# Auth Delta

## ADDED Requirements

### Requirement: Require MFA

The system MUST require MFA for administrators.

#### Scenario: administrator signs in

- GIVEN an administrator account
- WHEN the administrator signs in
- THEN an MFA challenge is required
`;

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((rootDir) => rm(rootDir, {
    recursive: true,
    force: true
  })));
});

describe('OpenSpec rules compiler API', () => {
  it('exports the required public functions', async () => {
    const {
      collectOpenSpecRuleSources,
      compileOpenSpecRules,
      compileOpenSpecBaseRules,
      extractRequirementsFromShowJson,
      parseSpecMarkdownFallback,
      renderGeneratedRules,
      writeGeneratedRules
    } = await loadCompiler();

    assert.equal(typeof compileOpenSpecRules, 'function');
    assert.equal(typeof compileOpenSpecBaseRules, 'function');
    assert.equal(typeof collectOpenSpecRuleSources, 'function');
    assert.equal(typeof renderGeneratedRules, 'function');
    assert.equal(typeof writeGeneratedRules, 'function');
    assert.equal(typeof parseSpecMarkdownFallback, 'function');
    assert.equal(typeof extractRequirementsFromShowJson, 'function');
  });
});

describe('compileOpenSpecRules filesystem fallback', () => {
  it('compiles base specs only and leaves canonical OpenSpec files untouched', async () => {
    const { compileOpenSpecRules } = await loadCompiler();
    const rootDir = await createTempRoot();
    await createChange(rootDir, 'add-generated-rules');
    const specPath = await writeFixture(rootDir, 'openspec/specs/billing/spec.md', baseBillingSpec);

    const result = await compileOpenSpecRules('add-generated-rules', compilerOptions(rootDir, {
      now: new Date('2026-05-09T00:00:00.000Z')
    }));

    assert.equal(result.ok, true);
    assert.equal(result.changeId, 'add-generated-rules');
    assert.equal(result.mode, 'filesystem-fallback');
    assert.equal(result.openspecCli.command, 'openspec');
    assert.equal(result.openspecCli.commandSource, 'path');
    assert.deepEqual(result.errors, []);
    assert.equal(result.files.length, 5);
    assert.deepEqual(result.files.map((file) => file.kind), ['base', 'change', 'merged', 'trace', 'index']);
    assert.equal(result.files.every((file) => path.isAbsolute(file.path) && file.written), true);
    assert.equal(result.sources.some((source) => source.kind === 'base' && source.relativePath === 'openspec/specs/billing/spec.md'), true);
    assert.equal(result.warnings.some((warning) => warning.code === 'missing-cli'), true);

    const baseRules = await readGenerated(rootDir, 'openspec-base.md');
    const changeRules = await readGenerated(rootDir, 'openspec-change-add-generated-rules.md');
    const mergedRules = await readGenerated(rootDir, 'openspec-merged-add-generated-rules.md');
    const trace = await readGeneratedJson(rootDir, 'openspec-rules-trace-add-generated-rules.json');
    const index = await readGeneratedJson(rootDir, 'index.json');

    assert.match(baseRules, /^# Generated OpenSpec Rules/m);
    assert.match(baseRules, /openspec\/specs\/billing\/spec\.md/);
    assert.match(baseRules, /Requirement: Track Usage/);
    assert.match(baseRules, /Scenario: usage is captured/);
    assert.match(baseRules, /GIVEN a billable account/);
    assert.match(baseRules, /sha256:/);
    assert.doesNotMatch(baseRules, /\d{4}-\d{2}-\d{2}T/);
    assert.match(changeRules, /No OpenSpec change requirements found/);
    assert.match(mergedRules, /Requirement: Track Usage/);
    assert.equal(trace.schema_version, 1);
    assert.equal(trace.validator, 'aifhub-generated-rules-trace');
    assert.equal(trace.change_id, 'add-generated-rules');
    assert.equal(trace.generated_at, '2026-05-09T00:00:00.000Z');
    assert.deepEqual(trace.inputs, [
      {
        path: 'openspec/specs/billing/spec.md',
        sha256: result.sources[0].fingerprint,
        kind: 'base-spec'
      }
    ]);
    assert.deepEqual(trace.outputs.map((output) => output.kind), ['base-rules', 'change-rules', 'merged-rules']);
    assert.equal(trace.outputs.find((output) => output.kind === 'base-rules').sha256, fingerprint(baseRules));
    assert.equal(trace.outputs.find((output) => output.kind === 'change-rules').sha256, fingerprint(changeRules));
    assert.equal(trace.outputs.find((output) => output.kind === 'merged-rules').sha256, fingerprint(mergedRules));
    assert.equal(trace.rules.length, 1);
    assert.match(trace.rules[0].id, /^base-billing-track-usage-[a-f0-9]{8}$/);
    assert.equal(trace.rules[0].severity, 'must');
    assert.deepEqual(trace.rules[0].source, {
      path: 'openspec/specs/billing/spec.md',
      requirement: 'Track Usage'
    });
    assert.match(trace.rules[0].rule_text, /MUST track customer usage/);
    assert.equal(index.schema_version, 1);
    assert.equal(index.generated_at, '2026-05-09T00:00:00.000Z');
    assert.deepEqual(index.base.inputs, trace.inputs);
    assert.deepEqual(index.changes.map((entry) => entry.change_id), ['add-generated-rules']);
    assert.equal(index.changes[0].trace, '.ai-factory/rules/generated/openspec-rules-trace-add-generated-rules.json');
    assert.equal(index.changes[0].markdown.merged, '.ai-factory/rules/generated/openspec-merged-add-generated-rules.md');
    assert.equal(await readFile(specPath, 'utf8'), baseBillingSpec);
    assert.equal(await pathExists(path.join(rootDir, 'openspec', 'changes', 'add-generated-rules', '.ai-factory')), false);
  });

  it('refreshes base-only generated rules and index without requiring a change trace', async () => {
    const { compileOpenSpecBaseRules } = await loadCompiler();
    const rootDir = await createTempRoot();
    await writeFixture(rootDir, 'openspec/specs/billing/spec.md', baseBillingSpec);

    const result = await compileOpenSpecBaseRules(compilerOptions(rootDir, {
      now: new Date('2026-05-09T01:00:00.000Z')
    }));

    assert.equal(result.ok, true);
    assert.equal(result.changeId, null);
    assert.deepEqual(result.files.map((file) => file.kind), ['base', 'index']);
    assert.match(await readGenerated(rootDir, 'openspec-base.md'), /Requirement: Track Usage/);

    const index = await readGeneratedJson(rootDir, 'index.json');
    assert.equal(index.generated_at, '2026-05-09T01:00:00.000Z');
    assert.equal(index.base.markdown, '.ai-factory/rules/generated/openspec-base.md');
    assert.deepEqual(index.changes, []);
    assert.equal(await pathExists(path.join(rootDir, '.ai-factory', 'rules', 'generated', 'openspec-rules-trace-add-generated-rules.json')), false);
  });

  it('preserves change trace index entries during direct base-only refresh by default', async () => {
    const { compileOpenSpecBaseRules } = await loadCompiler();
    const rootDir = await createTempRoot();
    await writeFixture(rootDir, 'openspec/specs/billing/spec.md', baseBillingSpec);
    await writeFixture(rootDir, '.ai-factory/rules/generated/index.json', `${JSON.stringify({
      schema_version: 1,
      generated_at: '2026-05-09T00:00:00.000Z',
      base: null,
      changes: [
        {
          change_id: 'add-existing',
          generated_at: '2026-05-09T00:00:00.000Z',
          trace: '.ai-factory/rules/generated/openspec-rules-trace-add-existing.json',
          markdown: {
            base: '.ai-factory/rules/generated/openspec-base.md',
            change: '.ai-factory/rules/generated/openspec-change-add-existing.md',
            merged: '.ai-factory/rules/generated/openspec-merged-add-existing.md'
          }
        }
      ]
    }, null, 2)}\n`);

    const result = await compileOpenSpecBaseRules(compilerOptions(rootDir, {
      now: new Date('2026-05-09T02:00:00.000Z')
    }));

    assert.equal(result.ok, true);
    const index = await readGeneratedJson(rootDir, 'index.json');
    assert.equal(index.generated_at, '2026-05-09T02:00:00.000Z');
    assert.equal(index.base.markdown, '.ai-factory/rules/generated/openspec-base.md');
    assert.deepEqual(index.changes.map((entry) => entry.change_id), ['add-existing']);
  });

  it('compiles delta specs only and includes change metadata in change and merged output', async () => {
    const { compileOpenSpecRules } = await loadCompiler();
    const rootDir = await createTempRoot();
    await createChange(rootDir, 'add-mfa', {
      'auth/spec.md': deltaAuthSpec
    });

    const result = await compileOpenSpecRules('add-mfa', compilerOptions(rootDir));

    assert.equal(result.ok, true);
    assert.equal(result.sources.some((source) => source.kind === 'change' && source.changeId === 'add-mfa'), true);

    const baseRules = await readGenerated(rootDir, 'openspec-base.md');
    const changeRules = await readGenerated(rootDir, 'openspec-change-add-mfa.md');
    const mergedRules = await readGenerated(rootDir, 'openspec-merged-add-mfa.md');

    assert.match(baseRules, /No base OpenSpec requirements found/);
    assert.match(changeRules, /Change: add-mfa/);
    assert.match(changeRules, /ADDED Requirements/);
    assert.match(changeRules, /Requirement: Require MFA/);
    assert.match(changeRules, /openspec\/changes\/add-mfa\/specs\/auth\/spec\.md/);
    assert.match(mergedRules, /Change: add-mfa/);
    assert.match(mergedRules, /Requirement: Require MFA/);
  });

  it('writes stable merged output with base requirements before delta requirements', async () => {
    const { compileOpenSpecRules } = await loadCompiler();
    const rootDir = await createTempRoot();
    await writeFixture(rootDir, 'openspec/specs/zeta/spec.md', `# Zeta

## Requirements

### Requirement: Base Zeta

The system MUST keep zeta behavior.
`);
    await writeFixture(rootDir, 'openspec/specs/alpha/spec.md', `# Alpha

## Requirements

### Requirement: Base Alpha

The system MUST keep alpha behavior.
`);
    await createChange(rootDir, 'sort-generated-rules', {
      'beta/spec.md': `# Beta

## ADDED Requirements

### Requirement: Delta Beta

The system MUST add beta behavior.
`
    });

    await compileOpenSpecRules('sort-generated-rules', compilerOptions(rootDir));
    const firstBase = await readGenerated(rootDir, 'openspec-base.md');
    const firstChange = await readGenerated(rootDir, 'openspec-change-sort-generated-rules.md');
    const firstMerged = await readGenerated(rootDir, 'openspec-merged-sort-generated-rules.md');

    await compileOpenSpecRules('sort-generated-rules', compilerOptions(rootDir));
    const secondBase = await readGenerated(rootDir, 'openspec-base.md');
    const secondChange = await readGenerated(rootDir, 'openspec-change-sort-generated-rules.md');
    const secondMerged = await readGenerated(rootDir, 'openspec-merged-sort-generated-rules.md');

    assert.equal(secondBase, firstBase);
    assert.equal(secondChange, firstChange);
    assert.equal(secondMerged, firstMerged);
    assert.ok(secondBase.indexOf('Requirement: Base Alpha') < secondBase.indexOf('Requirement: Base Zeta'));
    assert.ok(secondMerged.indexOf('Requirement: Base Alpha') < secondMerged.indexOf('Requirement: Delta Beta'));
  });

  it('fails clearly for an explicit missing change and writes no generated files', async () => {
    const { compileOpenSpecRules } = await loadCompiler();
    const rootDir = await createTempRoot();
    await createChange(rootDir, 'available-change');

    const result = await compileOpenSpecRules('missing-change', compilerOptions(rootDir));

    assert.equal(result.ok, false);
    assert.equal(result.changeId, null);
    assert.equal(result.files.length, 0);
    assert.equal(result.errors[0].code, 'explicit-change-not-found');
    assert.equal(await pathExists(path.join(rootDir, '.ai-factory', 'rules', 'generated')), false);
  });

  it('rejects unsafe change ids before writing generated files', async () => {
    const { compileOpenSpecRules } = await loadCompiler();
    const rootDir = await createTempRoot();

    const result = await compileOpenSpecRules('../escape', compilerOptions(rootDir));

    assert.equal(result.ok, false);
    assert.equal(result.changeId, null);
    assert.equal(result.files.length, 0);
    assert.equal(result.errors[0].code, 'invalid-change-id');
    assert.equal(await pathExists(path.join(rootDir, '.ai-factory', 'rules', 'generated')), false);
  });

  it('rejects duplicate generated output filenames before writing files', async () => {
    const { writeGeneratedRules } = await loadCompiler();
    const rootDir = await createTempRoot();

    const result = await writeGeneratedRules('duplicate-files', {
      files: [
        {
          kind: 'base',
          fileName: 'openspec-base.md',
          content: 'base one\n'
        },
        {
          kind: 'base',
          fileName: 'openspec-base.md',
          content: 'base two\n'
        },
        {
          kind: 'change',
          fileName: 'openspec-change-duplicate-files.md',
          content: 'change\n'
        }
      ]
    }, { rootDir });

    assert.equal(result.ok, false);
    assert.equal(result.files.length, 0);
    assert.equal(result.errors[0].code, 'invalid-rendered-files');
    assert.equal(await pathExists(path.join(rootDir, '.ai-factory', 'rules', 'generated')), false);
  });

  it('resolves the active change when no change id is provided', async () => {
    const { compileOpenSpecRules } = await loadCompiler();
    const rootDir = await createTempRoot();
    await createChange(rootDir, 'branch-rules', {
      'auth/spec.md': deltaAuthSpec
    });

    const result = await compileOpenSpecRules(undefined, compilerOptions(rootDir, {
      getCurrentBranch: async () => 'feat/branch-rules'
    }));

    assert.equal(result.ok, true);
    assert.equal(result.changeId, 'branch-rules');
    assert.equal(result.files.some((file) => file.relativePath === '.ai-factory/rules/generated/openspec-merged-branch-rules.md'), true);
  });
});

describe('compileOpenSpecRules CLI JSON preference', () => {
  it('prefers compatible OpenSpec CLI JSON requirements when available', async () => {
    const { compileOpenSpecRules } = await loadCompiler();
    const rootDir = await createTempRoot();
    await writeFixture(rootDir, 'openspec/specs/billing/spec.md', `# Billing

## Requirements

### Requirement: Fallback Base

The fallback parser SHOULD NOT be used when CLI JSON is complete.
`);
    await createChange(rootDir, 'cli-rules', {
      'auth/spec.md': `# Auth

## ADDED Requirements

### Requirement: Fallback Delta

The fallback parser SHOULD NOT be used when CLI JSON is complete.
`
    });
    const calls = [];
    const detectionCalls = [];
    const explicitCommand = 'custom-openspec';

    const result = await compileOpenSpecRules('cli-rules', compilerOptions(rootDir, {
      command: explicitCommand,
      detectOpenSpec: async (options) => {
        detectionCalls.push(options);
        return {
        available: true,
        canValidate: true,
        canArchive: true,
        version: '1.3.1',
        supportedRange: '>=1.3.1 <2.0.0',
        versionSupported: true,
        requiresNode: '>=20.19.0',
        nodeVersion: '20.19.0',
        nodeSupported: true,
        command: explicitCommand,
        commandSource: 'explicit',
        reason: null,
        errors: []
        };
      },
      showOpenSpecItem: async (itemName, options) => {
        calls.push({ itemName, options });
        return {
          ok: true,
          json: {
            requirements: [
              {
                title: `CLI ${itemName}`,
                description: `Requirement from CLI for ${itemName}.`,
                scenarios: [
                  {
                    title: 'cli scenario',
                    steps: ['GIVEN CLI JSON', 'WHEN compiled', 'THEN generated rules use it']
                  }
                ]
              }
            ]
          },
          error: null
        };
      }
    }));

    assert.equal(result.ok, true);
    assert.equal(result.mode, 'cli-json');
    assert.equal(detectionCalls.length, 1);
    assert.equal(detectionCalls[0].command, explicitCommand);
    assert.equal(result.openspecCli.command, explicitCommand);
    assert.equal(result.openspecCli.commandSource, 'explicit');
    assert.deepEqual(calls.map((call) => [call.itemName, call.options.deltasOnly]), [
      ['billing', false],
      ['auth', true]
    ]);
    assert.equal(calls.every((call) => call.options.command === explicitCommand), true);

    const mergedRules = await readGenerated(rootDir, 'openspec-merged-cli-rules.md');
    assert.match(mergedRules, /Requirement: CLI billing/);
    assert.match(mergedRules, /Requirement: CLI auth/);
    assert.doesNotMatch(mergedRules, /Fallback Base/);
    assert.doesNotMatch(mergedRules, /Fallback Delta/);
  });
});

describe('OpenSpec requirements extraction helpers', () => {
  it('parses documented markdown fallback sections, requirements, and scenarios', async () => {
    const { parseSpecMarkdownFallback } = await loadCompiler();

    const parsed = parseSpecMarkdownFallback(`# Capability

## Requirements

### Requirement: Base Behavior

The system MUST keep base behavior.

#### Scenario: base scenario

- GIVEN base state
- WHEN base action runs
- THEN base outcome occurs

## MODIFIED Requirements

### Requirement: Modified Behavior

The system MUST update behavior.

## REMOVED Requirements

### Requirement: Removed Behavior

The system MUST remove old behavior.
`);

    assert.deepEqual(parsed.requirements.map((requirement) => [requirement.section, requirement.title]), [
      ['Requirements', 'Base Behavior'],
      ['MODIFIED Requirements', 'Modified Behavior'],
      ['REMOVED Requirements', 'Removed Behavior']
    ]);
    assert.deepEqual(parsed.requirements[0].scenarios[0], {
      title: 'base scenario',
      steps: ['GIVEN base state', 'WHEN base action runs', 'THEN base outcome occurs']
    });
  });

  it('extracts requirements from nested OpenSpec show JSON shapes', async () => {
    const { extractRequirementsFromShowJson } = await loadCompiler();

    const extracted = extractRequirementsFromShowJson({
      spec: {
        requirements: {
          'Base JSON': {
            description: 'The system MUST read base JSON.',
            scenarios: [
              {
                name: 'base json scenario',
                steps: ['GIVEN JSON', 'WHEN extracted', 'THEN it becomes a requirement']
              }
            ]
          }
        }
      },
      deltas: {
        added: {
          requirements: [
            {
              title: 'Added JSON',
              description: 'The system MUST read delta JSON.'
            }
          ]
        }
      }
    });

    assert.deepEqual(extracted.requirements.map((requirement) => [requirement.section, requirement.title]), [
      ['Requirements', 'Base JSON'],
      ['ADDED Requirements', 'Added JSON']
    ]);
    assert.deepEqual(extracted.requirements[0].scenarios[0].steps, [
      'GIVEN JSON',
      'WHEN extracted',
      'THEN it becomes a requirement'
    ]);
  });

  it('preserves structured given when then scenario fields from CLI JSON', async () => {
    const { extractRequirementsFromShowJson } = await loadCompiler();

    const extracted = extractRequirementsFromShowJson({
      requirements: [
        {
          title: 'Structured Scenario',
          description: 'The system MUST preserve structured scenario steps.',
          scenarios: [
            {
              title: 'structured flow',
              given: 'GIVEN an OpenSpec CLI scenario',
              when: 'WHEN generated rules are compiled',
              then: 'THEN every structured step is preserved'
            }
          ]
        }
      ]
    });

    assert.deepEqual(extracted.requirements[0].scenarios[0].steps, [
      'GIVEN an OpenSpec CLI scenario',
      'WHEN generated rules are compiled',
      'THEN every structured step is preserved'
    ]);
  });
});
