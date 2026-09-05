import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { getOpenSpecStatus, showOpenSpecItem, runOpenSpec, detectOpenSpec } from './openspec-runner.mjs';

describe('OpenSpec 1.11 optional surfaces and strict diagnostics', () => {
  it('keeps status per-change and show without diff even when given unowned options', async () => {
    const calls = [];
    const executor = async ({ args }) => {
      calls.push(args);
      return { exitCode: 0, stdout: '{}', stderr: '' };
    };
    await getOpenSpecStatus('audit-change', { executor, all: true });
    await showOpenSpecItem('audit-change', { executor, type: 'change', deltasOnly: true, diff: true });
    assert.deepEqual(calls, [
      ['status', '--change', 'audit-change', '--json', '--no-color'],
      ['show', 'audit-change', '--type', 'change', '--deltas-only', '--json', '--no-interactive', '--no-color']
    ]);
  });

  it('retains failed Purpose and partial batch documents as raw evidence without reporting success', async () => {
    const documents = [
      { items: [{ id: 'widgets', type: 'spec', valid: false, issues: [{
        level: 'WARNING', path: 'overview', line: 4,
        message: 'Purpose is still the placeholder left by archive. Edit the main spec directly.'
      }] }], summary: { totals: { items: 1, passed: 0, failed: 1 } }, version: '1.0', root: { source: 'nearest' } },
      { changes: [
        { changeName: 'broken', status: [{ code: 'change_error', severity: 'error', message: 'Unknown schema' }] },
        { changeName: 'healthy', artifacts: [{ id: 'proposal', status: 'done' }] }
      ], root: { source: 'nearest' } }
    ];
    for (const [index, document] of documents.entries()) {
      const argv = index === 0 ? ['validate', '--specs', '--strict', '--json'] : ['status', '--all', '--json'];
      const stdout = JSON.stringify(document);
      const result = await runOpenSpec(argv, {
        expectJson: true,
        executor: async () => ({ exitCode: 1, stdout, stderr: '' })
      });
      assert.equal(result.ok, false);
      assert.equal(result.exitCode, 1);
      assert.equal(result.error.code, 'non-zero-exit');
      assert.equal(result.json, null);
      assert.equal(result.stdout, stdout);
      assert.deepEqual(JSON.parse(result.stdout), document);
    }
  });

  it('keeps 1.10 supported and outdated, with the same Node floor for 1.11', async () => {
    for (const [version, nodeVersion, canValidate, outdated] of [
      ['1.10.0', '20.19.0', true, true],
      ['1.11.0', '20.19.0', true, true],
      ['1.11.0', '20.18.0', false, true],
      ['1.11.0-beta.1', '20.19.0', false, null]
    ]) {
      const result = await detectOpenSpec({ nodeVersion, executor: async () => ({ exitCode: 0, stdout: version, stderr: '' }) });
      assert.equal(result.canValidate, canValidate);
      assert.equal(result.canArchive, canValidate);
      assert.equal(result.versionOutdated, outdated);
    }
  });

  it('documents direct Purpose remediation and keeps historical evidence outside mandatory gates', async () => {
    const docs = await readFile(new URL('../docs/openspec-validation.md', import.meta.url), 'utf8');
    assert.match(docs, /existing Purpose.*not replaced by.*delta/s);
    assert.match(docs, /--allow-base-spec-mutation/);
    assert.match(docs, /Do not rewrite archived changes/);
    for (const name of ['aif-plan', 'aif-improve']) {
      const prompt = await readFile(new URL(`../injections/core/${name}-plan-folder.md`, import.meta.url), 'utf8');
      assert.match(prompt, /new capability/);
      assert.match(prompt, /Purpose.*not replaced by a delta's Purpose/);
      assert.match(prompt, /archived/);
    }
    const audit = await readFile(new URL('../docs/openspec-1.11.0-audit.md', import.meta.url), 'utf8');
    for (const text of ['#171', 'status --all', 'show --diff', 'upstream-owned', '0 accepted specs', 'schema init --default', 'Antigravity']) {
      assert.ok(audit.includes(text), `Missing audit decision: ${text}`);
    }
  });
});
