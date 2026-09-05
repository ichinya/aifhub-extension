// openspec-done-readiness.test.mjs - tests for OpenSpec done readiness gate
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runProviders } from './aifhub-providers.mjs';
import { runProviderProcess } from './provider-process.mjs';

import {
  buildOpenSpecDoneReadiness,
  detectWorkingTreeState,
  runDoneReadinessCommand,
  summarizeOpenSpecDoneReadiness,
  writeOpenSpecDoneReadiness
} from './openspec-done-readiness.mjs';
import {
  createGateResult,
  renderGateResultBlock
} from './aif-gate-result.mjs';

const tempRoots = [];

async function createTempRoot() {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'aifhub-done-readiness-'));
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
  await writeFixture(rootDir, `openspec/changes/${changeId}/tasks.md`, '# Tasks\n\n- [x] 1.1 Implement\n');
  await writeFixture(rootDir, `openspec/changes/${changeId}/specs/auth/spec.md`, [
    '# Delta for Auth',
    '',
    '## ADDED Requirements',
    '',
    '### Requirement: OAuth login',
    '',
    'The system MUST support OAuth login.',
    '',
    '#### Scenario: Successful login',
    '',
    '- GIVEN a valid provider response',
    '- WHEN the user logs in',
    '- THEN a session is created.',
    ''
  ].join('\n'));
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
    command: 'openspec',
    reason: 'missing-cli',
    errors: [{ code: 'missing-cli', message: 'OpenSpec CLI is not available.' }]
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

function verificationEvidence(overrides = {}) {
  const status = overrides.gateStatus ?? 'pass';
  const content = overrides.content ?? [
    '# Verify: add-oauth',
    '',
    'Verdict: PASS',
    'Code verification: PASS',
    '',
    renderGateResultBlock(createGateResult({
      gate: 'verify',
      status,
      blockers: status === 'fail'
        ? [{ id: 'verify-failed', severity: 'error', summary: 'Verify failed.' }]
        : []
    })),
    ''
  ].join('\n');

  return {
    ok: true,
    changeId: 'add-oauth',
    validation: { ok: true, skipped: false },
    status: { ok: true },
    verify: {
      exists: overrides.verifyExists ?? true,
      path: '.ai-factory/qa/add-oauth/verify.md',
      content
    },
    gateResult: overrides.gateResult,
    warnings: [],
    errors: overrides.errors ?? []
  };
}

function coverageEvidence(overrides = {}) {
  const status = overrides.status ?? 'pass';
  return {
    ok: overrides.ok ?? true,
    exists: overrides.exists ?? true,
    stale: overrides.stale ?? false,
    changeId: 'add-oauth',
    relativePath: '.ai-factory/qa/add-oauth/coverage.json',
    coverage: {
      schema_version: 1,
      change_id: 'add-oauth',
      status,
      blocking: status === 'fail',
      policy: { mode: 'strict', missing_requirement: 'fail' },
      requirements: [],
      summary: { covered: 1, partial: 0, missing: 0, not_applicable: 0 },
      sources: [],
      stale: overrides.stale ?? false,
      diagnostics: [],
      warnings: [],
      errors: []
    },
    diagnostics: overrides.diagnostics ?? [],
    warnings: [],
    errors: []
  };
}

function rulesGateEvidence(status = 'pass') {
  return {
    exists: true,
    ok: status === 'pass',
    status,
    path: '.ai-factory/qa/add-oauth/rules.md',
    gateResult: null,
    warnings: [],
    errors: status === 'pass' ? [] : [{
      code: `rules-gate-${status}`,
      message: `Rules gate is ${status}.`,
      path: '.ai-factory/qa/add-oauth/rules.md'
    }]
  };
}

function artifactContract(status = 'pass') {
  return {
    schema_version: 1,
    validator: 'aifhub-openspec-artifact-contract',
    change_id: 'add-oauth',
    status,
    blocking: status === 'fail',
    checks: status === 'pass'
      ? [{ id: 'generated-rules-current', status: 'pass', path: '.ai-factory/rules/generated', message: 'Generated rules are current.' }]
      : [{ id: 'generated-rules-current', status, path: '.ai-factory/rules/generated', message: 'Generated rules are stale.' }],
    suggested_next: status === 'pass'
      ? null
      : { command: '/aif-mode sync --change add-oauth', reason: 'generated rules are stale' }
  };
}

function generatedRules(overrides = {}) {
  return {
    generatedRules: [],
    warnings: overrides.warnings ?? [],
    errors: overrides.errors ?? []
  };
}

function missingRulesGateEvidence() {
  return {
    exists: false,
    ok: false,
    status: 'missing',
    path: '.ai-factory/qa/add-oauth/rules.md',
    gateResult: null,
    warnings: [],
    errors: [{
      code: 'rules-gate-evidence-missing',
      message: 'Rules gate evidence is missing.',
      path: '.ai-factory/qa/add-oauth/rules.md'
    }]
  };
}

function passingOptions(overrides = {}) {
  return {
    detectOpenSpec: async () => availableCliDetection(),
    validateOpenSpecChange: async () => commandResult(true),
    getOpenSpecStatus: async () => commandResult(true),
    validateOpenSpecArtifactContract: async () => artifactContract('pass'),
    collectGeneratedRules: async () => generatedRules(),
    readOpenSpecRulesGateEvidence: async () => rulesGateEvidence('pass'),
    readOpenSpecCoverageMatrix: async () => coverageEvidence(),
    readLatestVerificationEvidence: async () => verificationEvidence(),
    gitStatus: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    ...overrides
  };
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((rootDir) => rm(rootDir, {
    recursive: true,
    force: true
  })));
});

describe('OpenSpec done readiness gate', () => {
  it('binds an OpenSpec requirement to HLV evidence before allowing done readiness', async () => {
    const rootDir = await createTempRoot();
    await createOpenSpecChange(rootDir);
    await writeFixture(rootDir, 'project.yaml', 'schema_version: 1\nproject: fixture\n');
    await writeFixture(rootDir, '.ai-factory/config.yaml',
      'aifhub:\n  tools:\n    openspec: true\n    hlv: true\n');
    for (const args of [['init', '-q'], ['add', '--force', '.'],
      ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']]) {
      assert.equal((await runProviderProcess('git', args, { cwd: rootDir })).exitCode, 0);
    }
    const fakeHlv = fileURLToPath(new URL('../test/fixtures/validation-providers/fake-hlv.mjs', import.meta.url));
    const calls = [];
    const runProcess = async (executable, args, options) => {
      calls.push(args);
      return executable === 'hlv' ? runProviderProcess(process.execPath, [fakeHlv, ...args], options)
        : runProviderProcess(executable, args, options);
    };
    const options = { rootDir, changeId: 'add-oauth', ...passingOptions({ runProcess }) };
    const missing = await buildOpenSpecDoneReadiness(options);
    assert.equal(missing.blocking, true);
    assert.equal(missing.checks.providers, 'fail');
    assert.ok(missing.suggested_next.command.includes('aifhub-providers'));
    assert.equal(calls.some((args) => args.includes('check')), false);
    const verified = await runProviders({ rootDir, changeId: 'add-oauth', phase: 'verify', write: true, runProcess });
    assert.equal(verified.blocking, false);
    const ready = await buildOpenSpecDoneReadiness(options);
    assert.equal(ready.status, 'pass', JSON.stringify(ready));
    assert.equal(ready.checks.providers, 'pass');
    assert.equal(ready.providers.providers[0].revision.commit, verified.providers[0].revision.commit);
    await writeFixture(rootDir, 'openspec/changes/add-oauth/specs/auth/spec.md', '# changed requirement\n');
    const stale = await buildOpenSpecDoneReadiness(options);
    assert.equal(stale.blocking, true);
    assert.equal(stale.checks.providers, 'fail');
    const evidencePath = path.join(rootDir, '.ai-factory/qa/add-oauth/providers/hlv-verify.json');
    const evidence = await readFile(evidencePath, 'utf8');
    await writeFixture(rootDir, '.ai-factory/config.yaml',
      'aifhub:\n  tools:\n    openspec: true\n    hlv: false\n  providers:\n    hlv:\n      policy: required\n');
    calls.length = 0;
    const disabled = await buildOpenSpecDoneReadiness(options);
    assert.equal(disabled.status, 'pass', JSON.stringify(disabled));
    assert.equal(disabled.checks.providers, undefined);
    assert.equal(calls.some((args) => args.includes('--version') || args.includes('--root')), false);
    assert.equal(await readFile(evidencePath, 'utf8'), evidence);
    await writeFixture(rootDir, '.ai-factory/config.yaml',
      'aifhub:\n  tools:\n    openspec: true\n    hlv: true\n');
    assert.equal((await buildOpenSpecDoneReadiness(options)).checks.providers, 'fail');
  });

  it('builds and writes passing readiness under QA evidence', async () => {
    const rootDir = await createTempRoot();
    await createOpenSpecChange(rootDir);

    const readiness = await buildOpenSpecDoneReadiness({
      rootDir,
      changeId: 'add-oauth',
      ...passingOptions()
    });
    assert.equal(readiness.status, 'pass');
    assert.equal(readiness.blocking, false);
    assert.equal(readiness.checks.openspec_validate, 'pass');
    assert.equal(readiness.checks.artifact_contract, 'pass');

    const written = await writeOpenSpecDoneReadiness('add-oauth', readiness, { rootDir });
    assert.equal(written.path, '.ai-factory/qa/add-oauth/done-readiness.json');
    const persisted = JSON.parse(await readFile(path.join(rootDir, '.ai-factory', 'qa', 'add-oauth', 'done-readiness.json'), 'utf8'));
    assert.equal(persisted.gate, 'done-readiness');
    assert.equal(Object.hasOwn(persisted, 'context'), false);
    assert.equal(persisted.evidence_path, '.ai-factory/qa/add-oauth/done-readiness.json');
  });

  it('blocks generated-rules readiness failures with a sync suggestion', async () => {
    const rootDir = await createTempRoot();
    await createOpenSpecChange(rootDir);

    const readiness = await buildOpenSpecDoneReadiness({
      rootDir,
      changeId: 'add-oauth',
      ...passingOptions({
        collectGeneratedRules: async () => generatedRules({
          warnings: [{
            code: 'generated-rules-stale',
            message: 'Generated rules are stale.',
            path: '.ai-factory/rules/generated/openspec-merged-add-oauth.md'
          }]
        })
      })
    });

    assert.equal(readiness.status, 'fail');
    assert.equal(readiness.checks.generated_rules, 'fail');
    assert.equal(readiness.suggested_next.command, '/aif-mode sync --change add-oauth');
  });

  it('blocks missing rules_gate evidence with write-gate-evidence remediation', async () => {
    const rootDir = await createTempRoot();
    await createOpenSpecChange(rootDir);

    const readiness = await buildOpenSpecDoneReadiness({
      rootDir,
      changeId: 'add-oauth',
      ...passingOptions({
        readOpenSpecRulesGateEvidence: async () => missingRulesGateEvidence()
      })
    });

    assert.equal(readiness.status, 'fail');
    assert.equal(readiness.checks.rules_gate, 'fail');
    assert.equal(
      readiness.suggested_next.command,
      'ai-factory aifhub-write-gate-evidence --change add-oauth --gate rules --from <rules-output.md>',
      'rules_gate should route to the durable write-gate-evidence helper'
    );
    assert.match(readiness.suggested_next.reason, /\/aif-rules-check/);
    assert.match(readiness.suggested_next.reason, /\.ai-factory\/qa\/add-oauth\/rules\.md/);
  });

  it('does not let branch-scoped qa-check.md satisfy verify, coverage, or rules readiness', async () => {
    const rootDir = await createTempRoot();
    await createOpenSpecChange(rootDir);
    await writeFixture(rootDir, '.ai-factory/qa/feature-oauth-a1b2c3d4/qa-check.md', '# QA Check\n\n- [x] Manual smoke passed\n');

    const readiness = await buildOpenSpecDoneReadiness({
      rootDir,
      changeId: 'add-oauth',
      ...passingOptions({
        readLatestVerificationEvidence: async () => verificationEvidence({ verifyExists: false }),
        readOpenSpecCoverageMatrix: async () => coverageEvidence({ exists: false, coverage: null }),
        readOpenSpecRulesGateEvidence: async () => missingRulesGateEvidence()
      })
    });

    assert.equal(readiness.status, 'fail');
    assert.equal(readiness.checks.verify_gate, 'fail', 'qa-check.md must not satisfy verify readiness');
    assert.equal(readiness.checks.coverage, 'fail', 'qa-check.md must not satisfy coverage readiness');
    assert.equal(readiness.checks.rules_gate, 'fail', 'qa-check.md must not satisfy rules readiness');
  });

  it('blocks disallowed allowWarnOnDone.rules warnings with write-gate-evidence remediation', async () => {
    const rootDir = await createTempRoot();
    await createOpenSpecChange(rootDir);

    const readiness = await buildOpenSpecDoneReadiness({
      rootDir,
      changeId: 'add-oauth',
      ...passingOptions({
        readOpenSpecRulesGateEvidence: async () => rulesGateEvidence('warn')
      })
    });

    assert.equal(readiness.status, 'fail');
    assert.equal(readiness.checks.rules_gate, 'fail');
    assert.equal(
      readiness.suggested_next.command,
      'ai-factory aifhub-write-gate-evidence --change add-oauth --gate rules --from <rules-output.md>',
      'allowWarnOnDone.rules=false should still route rules_gate to durable evidence persistence'
    );
    assert.match(readiness.suggested_next.reason, /\/aif-rules-check/);
  });

  it('names legacy verify receipts with a targeted rerun hint', async () => {
    const rootDir = await createTempRoot();
    await createOpenSpecChange(rootDir);
    const legacyBlock = [
      '```aif-gate-result',
      JSON.stringify({
        schema_version: 1,
        gate: 'verify',
        status: 'pass',
        blocking: false,
        blockers: [],
        affected_files: [],
        suggested_next: { command: '/aif-verify add-oauth', reason: 'rerun' }
      }, null, 2),
      '```'
    ].join('\n');

    const readiness = await buildOpenSpecDoneReadiness({
      rootDir,
      changeId: 'add-oauth',
      ...passingOptions({
        readLatestVerificationEvidence: async () => verificationEvidence({
          content: `# Verify: add-oauth\n\nVerdict: PASS\n\n${legacyBlock}\n`
        })
      })
    });

    assert.equal(readiness.checks.verify_gate, 'fail');
    const diagnostic = readiness.diagnostics.find((item) => item.check === 'verify_gate');
    assert.equal(diagnostic.code, 'verification-gate-legacy-suggested-next');
    assert.match(diagnostic.message, /passing gate block with a non-null suggested_next/);
    assert.match(diagnostic.message, /rerun \/aif-verify once/);
    assert.equal(diagnostic.suggested_next.command, '/aif-verify add-oauth');
    assert.match(diagnostic.suggested_next.reason, /predates or does not follow/);
    assert.equal(diagnostic.blocking, true);
  });

  it('keeps generic verify diagnostics when a receipt fails other validations too', async () => {
    const rootDir = await createTempRoot();
    await createOpenSpecChange(rootDir);
    const invalidBlock = [
      '```aif-gate-result',
      JSON.stringify({
        schema_version: 2,
        gate: 'verify',
        status: 'pass',
        blocking: false,
        blockers: [],
        affected_files: [],
        suggested_next: null
      }, null, 2),
      '```'
    ].join('\n');

    const readiness = await buildOpenSpecDoneReadiness({
      rootDir,
      changeId: 'add-oauth',
      ...passingOptions({
        readLatestVerificationEvidence: async () => verificationEvidence({
          content: `# Verify: add-oauth\n\nVerdict: PASS\n\n${invalidBlock}\n`
        })
      })
    });

    assert.equal(readiness.checks.verify_gate, 'fail');
    const diagnostic = readiness.diagnostics.find((item) => item.check === 'verify_gate');
    assert.equal(diagnostic.code, 'verification-gate-invalid');
  });

  it('names legacy rules receipts with a targeted rewrite hint', async () => {
    const rootDir = await createTempRoot();
    await createOpenSpecChange(rootDir);

    const readiness = await buildOpenSpecDoneReadiness({
      rootDir,
      changeId: 'add-oauth',
      ...passingOptions({
        readOpenSpecRulesGateEvidence: async () => ({
          exists: true,
          ok: false,
          status: 'invalid',
          path: '.ai-factory/qa/add-oauth/rules.md',
          gateResult: {
            ok: false,
            result: null,
            errors: [{
              code: 'invalid-suggested-next-on-pass',
              message: 'suggested_next must be null when status is pass; terminal routing is prose-only.'
            }]
          },
          warnings: [],
          errors: [{
            code: 'rules-gate-result-invalid',
            message: 'Rules gate evidence contains an invalid aif-gate-result block for the rules gate.',
            path: '.ai-factory/qa/add-oauth/rules.md'
          }]
        })
      })
    });

    assert.equal(readiness.checks.rules_gate, 'fail');
    const diagnostic = readiness.diagnostics.find((item) => item.check === 'rules_gate');
    assert.equal(diagnostic.code, 'rules-gate-legacy-suggested-next');
    assert.match(diagnostic.message, /rerun \/aif-rules-check/);
    assert.match(diagnostic.message, /null-on-pass contract/);
    assert.match(diagnostic.suggested_next.command, /aifhub-write-gate-evidence/);
  });

  it('keeps generic rules diagnostics when a receipt fails other validations too', async () => {
    const rootDir = await createTempRoot();
    await createOpenSpecChange(rootDir);

    const readiness = await buildOpenSpecDoneReadiness({
      rootDir,
      changeId: 'add-oauth',
      ...passingOptions({
        readOpenSpecRulesGateEvidence: async () => ({
          exists: true,
          ok: false,
          status: 'invalid',
          path: '.ai-factory/qa/add-oauth/rules.md',
          gateResult: {
            ok: false,
            result: null,
            errors: [{ code: 'invalid-schema-version', message: 'schema_version must be 1.' }]
          },
          warnings: [],
          errors: [{
            code: 'rules-gate-result-invalid',
            message: 'Rules gate evidence contains an invalid aif-gate-result block for the rules gate.',
            path: '.ai-factory/qa/add-oauth/rules.md'
          }]
        })
      })
    });

    const diagnostic = readiness.diagnostics.find((item) => item.check === 'rules_gate');
    assert.equal(diagnostic.code, 'rules-gate-result-invalid');
  });

  it('renders rules_gate write-gate-evidence remediation in human output', async () => {
    const rootDir = await createTempRoot();
    await createOpenSpecChange(rootDir);

    const readiness = await buildOpenSpecDoneReadiness({
      rootDir,
      changeId: 'add-oauth',
      ...passingOptions({
        readOpenSpecRulesGateEvidence: async () => missingRulesGateEvidence()
      })
    });
    const summary = summarizeOpenSpecDoneReadiness(readiness);

    assert.match(
      summary,
      /Suggested next: ai-factory aifhub-write-gate-evidence --change add-oauth --gate rules --from <rules-output\.md>/,
      summary
    );
    assert.match(summary, /\/aif-rules-check/, summary);
    assert.match(summary, /final .*rules.* output/i, summary);
  });

  it('keeps suggested_next priority for generated_rules, rules_gate, and coverage blockers', async () => {
    const rootDir = await createTempRoot();
    await createOpenSpecChange(rootDir);

    const rulesAndCoverage = await buildOpenSpecDoneReadiness({
      rootDir,
      changeId: 'add-oauth',
      ...passingOptions({
        readOpenSpecRulesGateEvidence: async () => missingRulesGateEvidence(),
        readOpenSpecCoverageMatrix: async () => coverageEvidence({ status: 'fail' })
      })
    });

    assert.equal(rulesAndCoverage.checks.rules_gate, 'fail');
    assert.equal(rulesAndCoverage.checks.coverage, 'fail');
    assert.equal(
      rulesAndCoverage.suggested_next.command,
      'ai-factory aifhub-write-gate-evidence --change add-oauth --gate rules --from <rules-output.md>',
      'rules_gate should have priority over coverage blockers'
    );

    const generatedRulesAndRules = await buildOpenSpecDoneReadiness({
      rootDir,
      changeId: 'add-oauth',
      ...passingOptions({
        collectGeneratedRules: async () => generatedRules({
          warnings: [{
            code: 'generated-rules-stale',
            message: 'Generated rules are stale.',
            path: '.ai-factory/rules/generated/openspec-merged-add-oauth.md'
          }]
        }),
        readOpenSpecRulesGateEvidence: async () => missingRulesGateEvidence()
      })
    });

    assert.equal(generatedRulesAndRules.checks.generated_rules, 'fail');
    assert.equal(generatedRulesAndRules.checks.rules_gate, 'fail');
    assert.equal(
      generatedRulesAndRules.suggested_next.command,
      '/aif-mode sync --change add-oauth',
      'generated_rules should keep priority over rules_gate blockers'
    );
  });

  it('requires artifact contract pass instead of accepting warnings', async () => {
    const rootDir = await createTempRoot();
    await createOpenSpecChange(rootDir);

    const readiness = await buildOpenSpecDoneReadiness({
      rootDir,
      changeId: 'add-oauth',
      ...passingOptions({
        validateOpenSpecArtifactContract: async () => artifactContract('warn')
      })
    });

    assert.equal(readiness.status, 'fail');
    assert.equal(readiness.checks.artifact_contract, 'warn');
    assert.equal(readiness.diagnostics.some((diagnostic) => diagnostic.code === 'artifact-contract-warn'), true);
  });

  it('accepts OpenSpec status warnings according to done policy', async () => {
    const rootDir = await createTempRoot();
    await createOpenSpecChange(rootDir);

    const readiness = await buildOpenSpecDoneReadiness({
      rootDir,
      changeId: 'add-oauth',
      ...passingOptions({
        getOpenSpecStatus: async () => commandResult(false, {
          error: { code: 'status-warn', message: 'Status has warnings.' }
        })
      })
    });

    assert.equal(readiness.status, 'warn');
    assert.equal(readiness.blocking, false);
    assert.equal(readiness.checks.openspec_status, 'warn');
  });

  it('blocks dirty workspace unless explicit dirty recording is enabled', async () => {
    const dirty = await detectWorkingTreeState({
      rootDir: 'C:/tmp',
      gitStatus: async () => ({ exitCode: 0, stdout: ' M README.md\n', stderr: '' })
    });
    assert.equal(dirty.ok, false);
    assert.equal(dirty.errors[0].code, 'dirty-working-tree');

    const recorded = await detectWorkingTreeState({
      rootDir: 'C:/tmp',
      allowDirty: true,
      gitStatus: async () => ({ exitCode: 0, stdout: ' M README.md\n', stderr: '' })
    });
    assert.equal(recorded.ok, true);
    assert.equal(recorded.warnings[0].code, 'dirty-working-tree-recorded');
  });

  it('suggests explicit dirty-state finalization when dirty workspace blocks archive', async () => {
    const rootDir = await createTempRoot();
    await createOpenSpecChange(rootDir);

    const readiness = await buildOpenSpecDoneReadiness({
      rootDir,
      changeId: 'add-oauth',
      ...passingOptions({
        gitStatus: async () => ({ exitCode: 0, stdout: ' M README.md\n', stderr: '' })
      })
    });

    assert.equal(readiness.status, 'fail', 'dirty_workspace should fail readiness by default');
    assert.equal(readiness.checks.dirty_workspace, 'fail', 'dirty_workspace check should be the failing check');
    assert.equal(
      readiness.suggested_next.command,
      '/aif-done add-oauth --record-dirty-state',
      'dirty_workspace should suggest explicit dirty-state finalization'
    );

    const summary = summarizeOpenSpecDoneReadiness(readiness);
    assert.match(summary, /Suggested next: \/aif-done add-oauth --record-dirty-state/);
    assert.match(summary, /git status --short/);
  });

  it('runs the CLI with explicit dirty-state recording enabled', async () => {
    const rootDir = await createTempRoot();
    await createOpenSpecChange(rootDir);

    const result = await runDoneReadinessCommand(['--change', 'add-oauth', '--record-dirty-state', '--json'], {
      rootDir,
      ...passingOptions({
        gitStatus: async () => ({ exitCode: 0, stdout: ' M README.md\n', stderr: '' })
      })
    });

    assert.equal(result.exitCode, 0, 'explicit dirty-state recording should make dirty_workspace non-blocking');
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.status, 'warn');
    assert.equal(parsed.blocking, false);
    assert.equal(parsed.checks.dirty_workspace, 'warn');
    assert.equal(parsed.diagnostics[0].code, 'dirty-working-tree-recorded');
  });

  it('renders the exact suggested next command and reason', async () => {
    const summary = summarizeOpenSpecDoneReadiness({
      change_id: 'add-oauth',
      status: 'fail',
      blocking: true,
      checks: {
        openspec_validate: 'pass',
        openspec_status: 'pass',
        artifact_contract: 'pass',
        generated_rules: 'fail',
        rules_gate: 'pass',
        coverage: 'pass',
        verify_gate: 'pass',
        dirty_workspace: 'pass'
      },
      diagnostics: [],
      suggested_next: {
        command: '/aif-mode sync --change add-oauth',
        reason: 'generated rules are missing or stale'
      }
    });

    assert.match(summary, /Suggested next: \/aif-mode sync --change add-oauth/);
    assert.match(summary, /Reason: generated rules are missing or stale/);
  });

  it('runs the CLI with deterministic JSON output and exit codes', async () => {
    const rootDir = await createTempRoot();
    await createOpenSpecChange(rootDir);

    const result = await runDoneReadinessCommand(['--change', 'add-oauth', '--json'], {
      rootDir,
      ...passingOptions()
    });

    assert.equal(result.exitCode, 0);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.gate, 'done-readiness');
    assert.equal(parsed.status, 'pass');
  });

  it('returns exit code 2 for invalid args', async () => {
    const result = await runDoneReadinessCommand(['--change'], {});
    assert.equal(result.exitCode, 2);
    assert.match(result.stderr, /Missing value for --change/);
  });

  it('returns exit code 2 for unresolved explicit changes', async () => {
    const rootDir = await createTempRoot();
    await createOpenSpecChange(rootDir, 'existing-change');

    const result = await runDoneReadinessCommand(['--change', 'missing-change', '--json'], {
      rootDir,
      ...passingOptions()
    });

    assert.equal(result.exitCode, 2);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.change_id, null);
    assert.equal(parsed.diagnostics[0].code, 'explicit-change-not-found');
  });

  it('blocks missing CLI under strict done policy', async () => {
    const rootDir = await createTempRoot();
    await createOpenSpecChange(rootDir);

    const readiness = await buildOpenSpecDoneReadiness({
      rootDir,
      changeId: 'add-oauth',
      ...passingOptions({
        detectOpenSpec: async () => missingCliDetection()
      })
    });

    assert.equal(readiness.status, 'fail');
    assert.equal(readiness.checks.openspec_validate, 'fail');
    assert.equal(readiness.diagnostics.some((diagnostic) => diagnostic.code === 'openspec-cli-required-for-done'), true);
  });
});
