import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { archiveOpenSpecChange, detectOpenSpec, runOpenSpec, validateOpenSpecChange } from './openspec-runner.mjs';

describe('OpenSpec 1.12 report and advisory preflight boundary', () => {
  it('keeps full per-change argv and INFO without changing upstream validity', async () => {
    const report = {
      items: [{ id: 'audit-change', type: 'change', valid: true, issues: [{
        level: 'INFO', path: 'widgets/spec.md', message: 'Archive would refuse this delta: missing target.'
      }] }], summary: { totals: { items: 1, passed: 1, failed: 0 } }, version: '1.0', root: { source: 'nearest' }
    };
    const calls = [];
    const result = await validateOpenSpecChange('audit-change', {
      report: 'findings', all: true,
      executor: async ({ args }) => {
        calls.push(args);
        return { exitCode: 0, stdout: JSON.stringify(report), stderr: '' };
      }
    });
    assert.deepEqual(calls, [['validate', 'audit-change', '--type', 'change', '--strict', '--json', '--no-interactive', '--no-color']]);
    assert.equal(result.ok, true);
    assert.deepEqual(result.json, report);
    const archive = await archiveOpenSpecChange('audit-change', {
      executor: async () => ({ exitCode: 1, stdout: 'No files were changed.', stderr: 'Missing target.' })
    });
    assert.equal(archive.ok, false);
    assert.equal(archive.error.code, 'non-zero-exit');
    assert.equal(archive.stdout, 'No files were changed.');
    assert.equal(archive.stderr, 'Missing target.');
  });

  it('preserves optional findings envelopes and full-scope failure evidence', async () => {
    for (const exitCode of [0, 1]) {
      const report = {
        report: { kind: 'validation-findings', version: '1.0', scope: 'all', returnedItems: exitCode, totalItems: 2 },
        itemFindings: exitCode ? [{ id: 'broken', valid: false, issues: [{ level: 'ERROR', path: 'specs', message: 'Invalid delta.' }] }] : [],
        summary: { totals: { items: 2, passed: 2 - exitCode, failed: exitCode } }, root: { source: 'nearest' }
      };
      const stdout = JSON.stringify(report);
      const result = await runOpenSpec(['validate', '--all', '--report', 'findings', '--json'], {
        expectJson: true, executor: async () => ({ exitCode, stdout, stderr: '' })
      });
      assert.equal(result.ok, exitCode === 0);
      assert.equal(result.stdout, stdout);
      assert.deepEqual(result.json, exitCode === 0 ? report : null);
      assert.deepEqual(JSON.parse(result.stdout).summary, report.summary);
    }
  });

  it('advances freshness once while preserving stable support, the Node floor and prerelease exclusion', async () => {
    for (const [version, nodeVersion, supported, outdated] of [
      ['1.11.0', '20.19.0', true, true], ['1.12.0', '20.19.0', true, false],
      ['1.12.0', '20.18.0', false, false], ['1.12.1', '20.19.0', true, false],
      ['1.12.0-beta.1', '20.19.0', false, null]
    ]) {
      const result = await detectOpenSpec({ nodeVersion, executor: async () => ({ exitCode: 0, stdout: version, stderr: '' }) });
      assert.equal(result.latestReviewedVersion, '1.12.0');
      assert.equal(result.canValidate, supported);
      assert.equal(result.canArchive, supported);
      assert.equal(result.versionOutdated, outdated);
    }
    const skill = await readFile(new URL('../skills/aif-analyze/SKILL.md', import.meta.url), 'utf8');
    assert.match(skill, /^version: 0\.15\.0$/m);
  });

  it('documents report scope, advisory preflight and proportional source grounding', async () => {
    const docs = await readFile(new URL('../docs/openspec-validation.md', import.meta.url), 'utf8');
    for (const phrase of ['itemFindings', 'entire selected scope', 'even under `--strict`', 'actual archive command can still fail']) {
      assert.ok(docs.includes(phrase), `Missing validation boundary: ${phrase}`);
    }
    for (const name of ['aif-plan', 'aif-improve']) {
      const prompt = await readFile(new URL(`../injections/core/${name}-plan-folder.md`, import.meta.url), 'utf8');
      for (const phrase of ['read-only', 'proportional', 'outside `openspec/`', 'target repository', 'greenfield', 'direct file evidence']) {
        assert.ok(prompt.includes(phrase), `Missing ${name} grounding: ${phrase}`);
      }
    }
    const audit = await readFile(new URL('../docs/openspec-1.12.0-audit.md', import.meta.url), 'utf8');
    for (const phrase of ['e062b9572be933564ba3899d059377dfa1393e32', 'c844543999f673cdd72445879b86a4abea4c07ef', '389', 'upstream-owned', '0 accepted specs']) {
      assert.ok(audit.includes(phrase), `Missing 1.12 custody: ${phrase}`);
    }
  });
});
