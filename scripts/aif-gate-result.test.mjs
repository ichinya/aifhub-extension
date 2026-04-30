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
          summary: 'Required generated rules are missing.'
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
          summary: 'Required generated rules are missing.'
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
          summary: 'Rule blocker.'
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
      blockers: [],
      affected_files: [],
      suggested_next: {
        command: '/aif-verify',
        reason: 'Wrong gate follow-up.'
      }
    }).errors[0].code, 'invalid-suggested-next-command');
  });
});

describe('aif-rules-check skill gate contract', () => {
  it('documents the final rules gate result fenced block', async () => {
    const skill = await readFile(path.join(REPO_ROOT, 'skills', 'aif-rules-check', 'SKILL.md'), 'utf8');

    assert.match(skill, /final fenced JSON block/i);
    assert.match(skill, /```aif-gate-result/);
    assert.match(skill, /"gate": "rules"/);
    assert.match(skill, /Use lowercase JSON `status`: `pass`, `warn`, or `fail`/);
    assert.match(skill, /"status": "warn"/);
    assert.match(skill, /"suggested_next": null/);
  });
});
