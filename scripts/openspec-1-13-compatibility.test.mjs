import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { detectOpenSpec } from './openspec-runner.mjs';

describe('OpenSpec 1.13 compatibility boundary', () => {
  it('keeps the stable range and Node floor while advancing freshness', async () => {
    for (const [version, nodeVersion, supported, outdated] of [
      ['1.12.0', '20.19.0', true, true], ['1.13.0', '20.19.0', true, false],
      ['1.13.0', '20.18.0', false, false], ['1.13.1', '20.19.0', true, false],
      ['1.13.0-beta.1', '20.19.0', false, null], ['2.0.0', '20.19.0', false, null]
    ]) {
      const result = await detectOpenSpec({ nodeVersion, executor: async () => ({ exitCode: 0, stdout: version, stderr: '' }) });
      assert.equal(result.latestReviewedVersion, '1.13.0');
      assert.equal(result.canValidate, supported);
      assert.equal(result.canArchive, supported);
      assert.equal(result.versionOutdated, outdated);
    }
  });

  it('keeps spec inventory guidance and the upstream repeated-section limitation explicit', async () => {
    for (const skill of ['aif-explore', 'aif-plan', 'aif-improve']) {
      const prompt = await readFile(new URL(`../injections/core/${skill}-plan-folder.md`, import.meta.url), 'utf8');
      for (const phrase of ['openspec list --specs', 'including scenarios', 'exact path', 'Filesystem discovery remains sufficient']) {
        assert.ok(prompt.includes(phrase), `${skill}: ${phrase}`);
      }
    }
    const audit = await readFile(new URL('../docs/openspec-1.13.0-audit.md', import.meta.url), 'utf8');
    for (const phrase of ['9d4e5974e5c0d9a09b9c6c1e1eb0975e80ec4461', '5b124e7aafb6b539701a671e1fd015dac6b8bbf0', 'missingPrerequisites', 'show JSON is incomplete', 'Upstream-owned']) {
      assert.ok(audit.includes(phrase), `Missing audit boundary: ${phrase}`);
    }
  });
});
