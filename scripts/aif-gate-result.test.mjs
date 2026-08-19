// aif-gate-result.test.mjs - tests for AI Factory machine-readable gate summaries
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import {
  createGateResult,
  extractGateResultBlocks,
  getLatestGateResult,
  renderGateResultBlock,
  validateGateResult
} from './aif-gate-result.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const SCRIPT_PATH = path.join(REPO_ROOT, 'scripts', 'aif-gate-result.mjs');
const execFileAsync = promisify(execFile);

describe('aif-gate-result helper', () => {
  it('exports the required public functions', () => {
    for (const fn of [
      createGateResult,
      extractGateResultBlocks,
      getLatestGateResult,
      renderGateResultBlock,
      validateGateResult
    ]) {
      assert.equal(typeof fn, 'function', 'gate result helper should export functions');
    }
  });

  it('creates normalized rules gate results and renders the fenced JSON block', () => {
    const result = createGateResult({
      gate: 'rules',
      status: 'FAIL',
      blockers: [
        {
          id: 'rules-1',
          severity: 'error',
          file: 'src/example.ts',
          summary: 'Required generated rules are missing.',
          source: {
            path: 'openspec/changes/add-oauth/specs/auth/spec.md',
            requirement: 'Generated rule traceability'
          }
        }
      ],
      affectedFiles: ['src/example.ts'],
      suggestedNext: {
        command: '/aif-fix',
        reason: 'Blocking rule violations remain.'
      }
    });

    assert.deepEqual(result, {
      schema_version: 1,
      gate: 'rules',
      status: 'fail',
      blocking: true,
      blockers: [
        {
          id: 'rules-1',
          severity: 'error',
          file: 'src/example.ts',
          summary: 'Required generated rules are missing.',
          source: {
            path: 'openspec/changes/add-oauth/specs/auth/spec.md',
            requirement: 'Generated rule traceability'
          }
        }
      ],
      affected_files: ['src/example.ts'],
      suggested_next: {
        command: '/aif-fix',
        reason: 'Blocking rule violations remain.'
      }
    });

    assert.equal(renderGateResultBlock(result), [
      '```aif-gate-result',
      JSON.stringify(result, null, 2),
      '```'
    ].join('\n'));
  });

  it('extracts exact aif-gate-result fenced blocks with parse and validation diagnostics', () => {
    const markdown = [
      '# Gate output',
      '',
      '```json',
      '{"schema_version":1,"gate":"rules","status":"fail","blocking":true}',
      '```',
      '',
      '```aif-gate-result',
      '{"schema_version":1,"gate":"rules","status":"pass","blocking":false,"blockers":[],"affected_files":[],"suggested_next":null}',
      '```',
      '',
      '```aif-gate-result',
      '{"schema_version":1,"gate":"rules"',
      '```',
      '',
      '``` aif-gate-result',
      '{"schema_version":1,"gate":"rules","status":"warn","blocking":false,"blockers":[],"affected_files":[],"suggested_next":null}',
      '```'
    ].join('\n');

    const blocks = extractGateResultBlocks(markdown);

    assert.equal(blocks.length, 2, 'only exact fence language should be accepted');
    assert.equal(blocks[0].ok, true);
    assert.equal(blocks[0].startLine, 7);
    assert.equal(blocks[0].endLine, 9);
    assert.equal(blocks[0].result.status, 'pass');
    assert.equal(blocks[1].ok, false);
    assert.equal(blocks[1].startLine, 11);
    assert.equal(blocks[1].endLine, 13);
    assert.equal(blocks[1].errors[0].code, 'invalid-json');
  });

  it('returns the latest gate result, optionally filtered by gate', () => {
    const review = createGateResult({
      gate: 'review',
      status: 'warn',
      blockers: [],
      affectedFiles: ['src/review.ts'],
      suggestedNext: null
    });
    const rules = createGateResult({
      gate: 'rules',
      status: 'fail',
      blockers: [
        {
          id: 'rules-blocker',
          severity: 'error',
          file: 'src/rules.ts',
          summary: 'Rule blocker.',
          source: {
            path: 'openspec/changes/add-oauth/specs/auth/spec.md',
            requirement: 'Generated rule traceability'
          }
        }
      ],
      affectedFiles: ['src/rules.ts'],
      suggestedNext: {
        command: '/aif-fix',
        reason: 'Blocking rule violations remain.'
      }
    });
    const markdown = [
      renderGateResultBlock(review),
      '',
      '```aif-gate-result',
      '{"schema_version":1,"gate":"rules"',
      '```',
      '',
      renderGateResultBlock(rules)
    ].join('\n');

    assert.equal(getLatestGateResult(markdown).result.gate, 'rules');
    assert.equal(getLatestGateResult(markdown, { gate: 'review' }).result.status, 'warn');
  });

  it('returns an invalid latest block instead of falling back to an older valid gate result', () => {
    const pass = createGateResult({
      gate: 'rules',
      status: 'pass',
      blockers: [],
      affectedFiles: [],
      suggestedNext: null
    });
    const markdown = [
      renderGateResultBlock(pass),
      '',
      '```aif-gate-result',
      '{"schema_version":1,"gate":"rules"',
      '```'
    ].join('\n');

    const latest = getLatestGateResult(markdown);

    assert.equal(latest.ok, false);
    assert.equal(latest.result, null);
    assert.equal(latest.errors[0].code, 'invalid-json');
  });

  it('CLI exits non-zero when the latest gate result is invalid', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'aifhub-gate-result-cli-'));
    const reportPath = path.join(tempRoot, 'report.md');

    try {
      const pass = createGateResult({
        gate: 'rules',
        status: 'pass',
        blockers: [],
        affectedFiles: [],
        suggestedNext: null
      });
      await writeFile(reportPath, [
        renderGateResultBlock(pass),
        '',
        '```aif-gate-result',
        '{"schema_version":1,"gate":"rules"',
        '```'
      ].join('\n'), 'utf8');

      await assert.rejects(
        () => execFileAsync(process.execPath, [SCRIPT_PATH, reportPath]),
        (err) => err?.code === 1
      );
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('validates schema version, supported gates, status, blocking, blockers, and suggested next commands', () => {
    assert.equal(validateGateResult({
      schema_version: 2,
      gate: 'rules',
      status: 'pass',
      blocking: false,
      blockers: [],
      affected_files: [],
      suggested_next: null
    }).ok, false);

    assert.equal(validateGateResult({
      schema_version: 1,
      gate: 'unknown',
      status: 'pass',
      blocking: false,
      blockers: [],
      affected_files: [],
      suggested_next: null
    }).errors[0].code, 'invalid-gate');

    assert.equal(validateGateResult({
      schema_version: 1,
      gate: 'rules',
      status: 'warn',
      blocking: true,
      blockers: [],
      affected_files: [],
      suggested_next: null
    }).errors[0].code, 'invalid-blocking');

    assert.equal(validateGateResult({
      schema_version: 1,
      gate: 'rules',
      status: 'fail',
      blocking: true,
      blockers: [{
        id: 'rules-blocker',
        severity: 'error',
        summary: 'Rule blocker.',
        source: {
          path: 'openspec/changes/add-oauth/specs/auth/spec.md',
          requirement: 'Generated rule traceability'
        }
      }],
      affected_files: [],
      suggested_next: {
        command: '/aif-verify',
        reason: 'Wrong gate follow-up.'
      }
    }).errors[0].code, 'invalid-suggested-next-command');
  });

  it('accepts owned suggested commands with arguments and rejects near matches', () => {
    const validRulesSync = validateGateResult({
      schema_version: 1,
      gate: 'rules',
      status: 'warn',
      blocking: false,
      blockers: [],
      affected_files: [],
      suggested_next: {
        command: '/aif-mode sync --change add-oauth-login',
        reason: 'Generated rules are stale.'
      }
    });
    assert.equal(validRulesSync.ok, true);

    const validRulesCheck = validateGateResult({
      schema_version: 1,
      gate: 'rules',
      status: 'warn',
      blocking: false,
      blockers: [],
      affected_files: [],
      suggested_next: {
        command: '/aif-rules-check',
        reason: 'Rerun the rules gate.'
      }
    });
    assert.equal(validRulesCheck.ok, true);

    const validVerifyFix = validateGateResult({
      schema_version: 1,
      gate: 'verify',
      status: 'fail',
      blocking: true,
      blockers: [{ id: 'verify-failed', severity: 'error', summary: 'Verify failed.' }],
      affected_files: [],
      suggested_next: {
        command: '/aif-fix add-oauth-login',
        reason: 'Fix the failing verification finding.'
      }
    });
    assert.equal(validVerifyFix.ok, true);

    for (const command of ['/aif-mode-extra sync --change add-oauth-login', '/aif-fixup add-oauth-login', '/aif-commit']) {
      const invalid = validateGateResult({
        schema_version: 1,
        gate: 'rules',
        status: 'warn',
        blocking: false,
        blockers: [],
        affected_files: [],
        suggested_next: {
          command,
          reason: 'Not an allowed rules remediation command.'
        }
      });
      assert.equal(invalid.errors[0].code, 'invalid-suggested-next-command');
    }
  });

  it('keeps suggested_next null on pass and allows owned remediation commands on warn', () => {
    const passingVerify = validateGateResult({
      schema_version: 1,
      gate: 'verify',
      status: 'pass',
      blocking: false,
      blockers: [],
      affected_files: [],
      suggested_next: null
    });
    assert.equal(passingVerify.ok, true);

    for (const [gate, command] of [['verify', '/aif-verify'], ['rules', '/aif-verify add-oauth-login']]) {
      const invalid = validateGateResult({
        schema_version: 1,
        gate,
        status: 'pass',
        blocking: false,
        blockers: [],
        affected_files: [],
        suggested_next: {
          command,
          reason: 'Terminal routing must stay prose-only.'
        }
      });
      assert.equal(invalid.ok, false);
      assert.equal(invalid.errors[0].code, 'invalid-suggested-next-on-pass');
    }

    const warnWithCommand = validateGateResult({
      schema_version: 1,
      gate: 'review',
      status: 'warn',
      blocking: false,
      blockers: [],
      affected_files: [],
      suggested_next: {
        command: '/aif-review',
        reason: 'Rerun the review gate after addressing notes.'
      }
    });
    assert.equal(warnWithCommand.ok, true);
  });

  it('preserves blocker provenance and requires provenance for rules failures', () => {
    const result = createGateResult({
      gate: 'rules',
      status: 'fail',
      blockers: [{
        id: ' rules-provenance ',
        severity: 'ERROR',
        file: 'src/example.ts',
        summary: 'Trace-backed generated rule failed.',
        rule_id: 'openspec-generated-rule-1',
        rule_source: '.ai-factory/rules/generated/openspec-merged-add-oauth-login.md',
        evidence_path: 'src/example.ts',
        source: {
          path: 'openspec/changes/add-oauth-login/specs/auth/spec.md',
          requirement: 'OAuth login'
        }
      }],
      affectedFiles: [],
      suggestedNext: {
        command: '/aif-fix add-oauth-login',
        reason: 'Fix the trace-backed rule failure.'
      }
    });

    assert.equal(result.blockers[0].id, 'rules-provenance');
    assert.equal(result.blockers[0].severity, 'error');
    assert.equal(result.blockers[0].rule_id, 'openspec-generated-rule-1');
    assert.equal(result.blockers[0].rule_source, '.ai-factory/rules/generated/openspec-merged-add-oauth-login.md');
    assert.equal(result.blockers[0].evidence_path, 'src/example.ts');
    assert.deepEqual(result.blockers[0].source, {
      path: 'openspec/changes/add-oauth-login/specs/auth/spec.md',
      requirement: 'OAuth login'
    });

    const missingBlocker = validateGateResult({
      schema_version: 1,
      gate: 'rules',
      status: 'fail',
      blocking: true,
      blockers: [],
      affected_files: [],
      suggested_next: {
        command: '/aif-fix add-oauth-login',
        reason: 'Fix the rule failure.'
      }
    });
    assert.equal(missingBlocker.errors.some((error) => error.code === 'invalid-rules-fail-provenance'), true);

    const missingProvenance = validateGateResult({
      schema_version: 1,
      gate: 'rules',
      status: 'fail',
      blocking: true,
      blockers: [{ id: 'rules-failed', severity: 'error', summary: 'Rule failed.' }],
      affected_files: [],
      suggested_next: {
        command: '/aif-fix add-oauth-login',
        reason: 'Fix the rule failure.'
      }
    });
    assert.equal(missingProvenance.errors.some((error) => error.code === 'invalid-rules-fail-provenance'), true);
  });
});

describe('aif-rules-check gate contract', () => {
  it('preserves the final rules gate result fenced block contract in the AIFHub overlay', async () => {
    const assets = [
      await readFile(path.join(REPO_ROOT, 'injections', 'core', 'aif-rules-check-openspec-generated-rules.md'), 'utf8')
    ];

    for (const asset of assets) {
      assert.match(asset, /final machine-readable `aif-gate-result` fenced JSON block/i);
      assert.match(asset, /"gate": "rules"/);
      assert.match(asset, /lowercase JSON `status`: `pass`, `warn`, or `fail`/);
      assert.match(asset, /openspec-rules-trace-<change-id>\.json/);
      assert.match(asset, /source\.path/);
      assert.match(asset, /source\.requirement/);
      assert.match(asset, /capped at `WARN`/i);
      assert.match(asset, /Do not return final `status: "fail"` solely/i);
    }
  });

  it('keeps AIFHub rules sidecars aligned with upstream rules gate output and read-only boundaries', async () => {
    const codexAsset = await readFile(
      path.join(REPO_ROOT, 'agent-files', 'codex', 'aifhub-rules-sidecar.toml'),
      'utf8'
    );
    const claudeAsset = await readFile(
      path.join(REPO_ROOT, 'agent-files', 'claude', 'aifhub-rules-sidecar.md'),
      'utf8'
    );

    assert.match(codexAsset, /sandbox_mode = "read-only"/);
    assert.match(claudeAsset, /^tools: Read, Glob, Grep, Bash$/m);
    assert.doesNotMatch(claudeAsset, /^tools:.*(?:Write|Edit)/m);
    assert.match(
      claudeAsset,
      /Bash is allowed here only for the helper's read-only Git inventory\/revision commands\./
    );

    for (const asset of [codexAsset, claudeAsset]) {
      assert.match(asset, /aif-rules-check/);
      assert.match(asset, /aif-gate-result/);
      assert.match(asset, /"gate": "rules"/);
      assert.match(asset, /Verdict: PASS/);
      assert.match(asset, /\.ai-factory\/rules\/generated\/\*/);
      assert.match(asset, /openspec-rules-trace-<change-id>\.json/);
      assert.match(asset, /source\.path/);
      assert.match(asset, /source\.requirement/);
      assert.match(asset, /cap .*WARN/i);
      assert.match(asset, /upstream .*rules-sidecar/i);
      assert.match(asset, /Do not edit files/);
      assert.match(asset, /Set .?suggested_next.? to .?null.? when .?status.? is .?pass/);
    }
  });
});

describe('review and security sidecar gate contracts', () => {
  async function readSidecarAssets(kind) {
    return {
      codex: await readFile(
        path.join(REPO_ROOT, 'agent-files', 'codex', `aifhub-${kind}-sidecar.toml`),
        'utf8'
      ),
      claude: await readFile(
        path.join(REPO_ROOT, 'agent-files', 'claude', `aifhub-${kind}-sidecar.md`),
        'utf8'
      )
    };
  }

  function assertReadOnlySidecarBoundaries(codexAsset, claudeAsset) {
    assert.match(codexAsset, /sandbox_mode = "read-only"/);
    assert.match(claudeAsset, /tools: Read, Glob, Grep/);
    assert.doesNotMatch(claudeAsset, /^tools:.*(?:Write|Edit|Bash)/m);

    for (const asset of [codexAsset, claudeAsset]) {
      assert.match(asset, /Do not edit files/);
      assert.doesNotMatch(asset, /\.ai-factory\/qa\/<change-id>\/verify\.md/);
    }
  }

  function assertGateContract(asset, gate) {
    assert.match(asset, /End with exactly one final fenced `?aif-gate-result`? JSON block/);
    assert.match(asset, new RegExp(`"gate": "${gate}"`));
    assert.match(asset, /pass`, `warn`, or `fail`|pass, warn, or fail/);
    assert.match(asset, /blocking.*true.*fail|fail.*blocking.*true/i);
    assert.match(asset, /suggested_next\.command.*\/aif-fix|suggested_next.*\/aif-fix/i);
    assert.match(asset, /Set .?suggested_next.? to .?null.? when .?status.? is .?pass/);
  }

  it('keeps review sidecars read-only and aligned with review gate output', async () => {
    const { codex, claude } = await readSidecarAssets('review');

    assertReadOnlySidecarBoundaries(codex, claude);
    assertGateContract(codex, 'review');
    assertGateContract(claude, 'review');
  });

  it('keeps security sidecars read-only and aligned with security gate output', async () => {
    const { codex, claude } = await readSidecarAssets('security');

    assertReadOnlySidecarBoundaries(codex, claude);
    assertGateContract(codex, 'security');
    assertGateContract(claude, 'security');
  });
});
