// openspec-validation-fixtures.test.mjs - fixture-driven OpenSpec validation scenarios
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  validateOpenSpecArtifactContract
} from './openspec-artifact-validator.mjs';
import {
  compileOpenSpecRules
} from './openspec-rules-compiler.mjs';
import {
  collectGeneratedRules
} from './openspec-execution-context.mjs';
import {
  readOpenSpecCoverageMatrix
} from './openspec-coverage-matrix.mjs';
import {
  buildOpenSpecDoneReadiness
} from './openspec-done-readiness.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const FIXTURE_ROOT = path.join(REPO_ROOT, 'test', 'fixtures');
const tempRoots = [];

const FIXTURES = Object.freeze([
  'openspec-valid-change',
  'openspec-missing-delta-specs',
  'openspec-stale-generated-rules',
  'openspec-rule-violation',
  'openspec-runtime-state-leak',
  'openspec-coverage-missing',
  'openspec-docs-only-skip-specs',
  'openspec-ultra-index-root',
  'openspec-ultra-index-nested',
  'openspec-ultra-phase-root',
  'openspec-ultra-phase-nested',
  'openspec-ultra-marker-active',
  'openspec-ultra-marker-inline',
  'openspec-ultra-marker-fenced'
]);

async function createTempRoot() {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'aifhub-openspec-validation-fixtures-'));
  tempRoots.push(rootDir);
  return rootDir;
}

async function copyFixture(fixtureName) {
  const rootDir = await createTempRoot();
  for (const name of await resolveFixtureChain(fixtureName)) {
    await cp(path.join(FIXTURE_ROOT, name), rootDir, {
      recursive: true,
      force: true
    });
  }
  return rootDir;
}

async function readExpected(fixtureName) {
  const parsed = await readExpectedDocument(fixtureName);
  if (parsed.extends === undefined) {
    return parsed;
  }

  const { extends: baseName, ...overrides } = parsed;
  return deepMerge(await readExpected(baseName), overrides);
}

async function readExpectedDocument(fixtureName) {
  return JSON.parse(await readFile(path.join(FIXTURE_ROOT, fixtureName, 'expected.json'), 'utf8'));
}

async function resolveFixtureChain(fixtureName, seen = new Set()) {
  assert.equal(seen.has(fixtureName), false, `fixture inheritance cycle: ${fixtureName}`);
  seen.add(fixtureName);
  const parsed = await readExpectedDocument(fixtureName);
  const parents = parsed.extends === undefined
    ? []
    : await resolveFixtureChain(parsed.extends, seen);
  return [...parents, fixtureName];
}

function deepMerge(base, overrides) {
  if (!isPlainObject(base) || !isPlainObject(overrides)) {
    return overrides;
  }

  const merged = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    merged[key] = key in merged ? deepMerge(merged[key], value) : value;
  }
  return merged;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function availableCliDetection() {
  return {
    available: true,
    canValidate: true,
    canArchive: true,
    version: '1.3.1',
    command: 'openspec',
    reason: null,
    errors: []
  };
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
    reason: 'missing-cli',
    errors: [
      {
        code: 'missing-cli',
        message: 'OpenSpec CLI is not available on PATH.'
      }
    ]
  };
}

function commandResult(ok = true, overrides = {}) {
  return {
    ok,
    command: 'openspec',
    args: [],
    exitCode: ok ? 0 : 1,
    stdout: ok ? '{"ok":true}' : '',
    stderr: ok ? '' : 'failed',
    json: ok ? { ok: true } : null,
    error: ok ? null : { code: 'openspec-failed', message: 'OpenSpec command failed.' },
    ...overrides
  };
}

function cleanGitStatus() {
  return {
    exitCode: 0,
    stdout: '',
    stderr: ''
  };
}

async function prepareGeneratedRules(rootDir, fixtureName, changeId) {
  const result = await compileOpenSpecRules(changeId, {
    rootDir,
    detectOpenSpec: async () => missingCliDetection(),
    getCurrentBranch: async () => `feature/${changeId}`,
    now: new Date('2026-05-11T00:00:00.000Z')
  });

  assert.equal(result.ok, true, `${fixtureName} generated rules should compile before fixture checks`);

  if (fixtureName === 'openspec-stale-generated-rules') {
    await writeFile(
      path.join(rootDir, 'openspec', 'specs', 'auth', 'spec.md'),
      [
        '# Auth Base',
        '',
        '## Requirements',
        '',
        '### Requirement: Existing sign in changed after sync',
        '',
        'The system MUST preserve changed sign in behavior after generated rules were compiled.',
        ''
      ].join('\n'),
      'utf8'
    );
  }
}

function normalizeArtifactContract(result, expected) {
  const normalized = {
    status: result.status,
    blocking: result.blocking,
    checks: selectCheckStatuses(result.checks, expected.checks),
    suggested_next: result.suggested_next?.command ?? null
  };

  if (Object.hasOwn(expected, 'rule_codes')) {
    normalized.rule_codes = [...new Set(result.checks
      .map((check) => check.details?.rule_code)
      .filter(Boolean))].sort();
  }

  return normalized;
}

function normalizeGeneratedRules(result, expected) {
  const generatedRules = {};
  for (const kind of Object.keys(expected.generated_rules ?? {})) {
    const rule = result.generatedRules.find((item) => item.kind === kind);
    generatedRules[kind] = {
      exists: rule?.exists ?? false,
      stale: rule?.stale ?? null,
      stale_source: normalizeStaleSource(rule?.staleSource),
      trace: {
        exists: rule?.trace?.exists ?? false,
        valid: rule?.trace?.valid ?? false,
        stale: rule?.trace?.stale ?? null
      }
    };
  }

  return {
    status: result.errors.length > 0 ? 'fail' : result.warnings.length > 0 ? 'warn' : 'pass',
    warning_codes: sortedCodes(result.warnings),
    error_codes: sortedCodes(result.errors),
    generated_rules: generatedRules
  };
}

function normalizeStaleSource(value) {
  if (value === 'trace-output') {
    return 'trace';
  }

  return value ?? null;
}

function normalizeCoverageMatrix(result) {
  return {
    ok: result.ok,
    exists: result.exists,
    stale: result.stale,
    status: result.coverage?.status ?? null,
    blocking: result.coverage?.blocking ?? null,
    summary: result.coverage?.summary ?? null,
    diagnostic_codes: sortedCodes(result.diagnostics)
  };
}

function normalizeDoneReadiness(result, expected) {
  return {
    status: result.status,
    blocking: result.blocking,
    checks: selectObjectKeys(result.checks, expected.checks),
    diagnostic_codes: sortedCodes(result.diagnostics),
    suggested_next: result.suggested_next?.command ?? null
  };
}

function selectCheckStatuses(checks, expectedChecks) {
  const statuses = {};
  for (const id of Object.keys(expectedChecks ?? {})) {
    statuses[id] = checks.find((check) => check.id === id)?.status ?? null;
  }
  return statuses;
}

function selectObjectKeys(value, expectedKeys) {
  const selected = {};
  for (const key of Object.keys(expectedKeys ?? {})) {
    selected[key] = value?.[key] ?? null;
  }
  return selected;
}

function sortedCodes(diagnostics = []) {
  return [...new Set((diagnostics ?? []).map((item) => item?.code).filter(Boolean))].sort();
}

function assertSection(fixtureName, sectionName, actual, expected) {
  assert.deepEqual(
    actual,
    expected,
    `${fixtureName} ${sectionName} normalized result should match expected.json`
  );
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((rootDir) => rm(rootDir, {
    recursive: true,
    force: true
  })));
});

describe('OpenSpec validation fixtures', () => {
  for (const fixtureName of FIXTURES) {
    it(`matches expected validation outcomes for ${fixtureName}`, async () => {
      const expected = await readExpected(fixtureName);
      const rootDir = await copyFixture(fixtureName);
      const changeId = expected.change_id;
      await prepareGeneratedRules(rootDir, fixtureName, changeId);

      const artifactContract = await validateOpenSpecArtifactContract({
        rootDir,
        changeId,
        requireVerificationEvidence: true
      });
      const generatedRules = await collectGeneratedRules(changeId, { rootDir });
      const coverage = await readOpenSpecCoverageMatrix(changeId, { rootDir });
      const doneReadiness = await buildOpenSpecDoneReadiness({
        rootDir,
        changeId,
        detectOpenSpec: async () => availableCliDetection(),
        validateOpenSpecChange: async () => commandResult(true),
        getOpenSpecStatus: async () => commandResult(true),
        gitStatus: async () => cleanGitStatus()
      });

      assertSection(
        fixtureName,
        'artifact_contract',
        normalizeArtifactContract(artifactContract, expected.artifact_contract),
        expected.artifact_contract
      );
      assertSection(
        fixtureName,
        'rules_compiler_trace',
        normalizeGeneratedRules(generatedRules, expected.rules_compiler_trace),
        expected.rules_compiler_trace
      );
      assertSection(
        fixtureName,
        'coverage_matrix',
        normalizeCoverageMatrix(coverage),
        expected.coverage_matrix
      );
      assertSection(
        fixtureName,
        'done_readiness',
        normalizeDoneReadiness(doneReadiness, expected.done_readiness),
        expected.done_readiness
      );
    });
  }
});
