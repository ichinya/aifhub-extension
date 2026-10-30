import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { detectOpenSpec, OPENSPEC_SUPPORTED_RANGE, OPENSPEC_NODE_RANGE, OPENSPEC_LATEST_REVIEWED_VERSION } from './openspec-runner.mjs';

const repo = name => readFile(new URL(`../${name}`, import.meta.url), 'utf8');

describe('OpenSpec 1.15 cumulative reviewed baseline', () => {
  it('keeps support and freshness independent across all seven checkpoints and runtime boundaries', async () => {
    assert.equal(OPENSPEC_SUPPORTED_RANGE, '>=1.3.1 <2.0.0');
    assert.equal(OPENSPEC_NODE_RANGE, '>=20.19.0');
    assert.equal(OPENSPEC_LATEST_REVIEWED_VERSION, '1.15.0');
    for (const [version, nodeVersion, supported, outdated] of [
      ...['1.13.0', '1.13.1', '1.13.2', '1.14.0', '1.14.1', '1.14.2', '1.14.3'].map(v => [v, '20.19.0', true, true]),
      ['1.15.0', '20.19.0', true, false], ['1.15.1', '20.19.0', true, false],
      ['1.15.0', '18.20.8', false, false], ['1.15.0', '20.18.0', false, false],
      ['1.3.0', '20.19.0', false, null], ['2.0.0', '20.19.0', false, null],
      ['1.15.0-beta.1', '20.19.0', false, null]
    ]) {
      const result = await detectOpenSpec({ nodeVersion, executor: async () => ({ exitCode: 0, stdout: version, stderr: '' }) });
      assert.equal(result.canValidate, supported, `${version} / Node ${nodeVersion}`);
      assert.equal(result.canArchive, supported);
      assert.equal(result.versionOutdated, outdated);
    }
  });

  it('binds the seven source checkpoints and executable custody without erasing historical evidence', async () => {
    const metadata = JSON.parse(await repo('aifhub-extension.json')).sources.openspec;
    assert.equal(metadata.version, OPENSPEC_LATEST_REVIEWED_VERSION);
    assert.deepEqual(metadata.reviewedStableVersions.slice(-7), ['1.13.1', '1.13.2', '1.14.0', '1.14.1', '1.14.2', '1.14.3', '1.15.0']);
    const audit = await repo('docs/openspec-1.15.0-audit.md');
    for (const phrase of ['8e0288df12d401b0e183e2f47254d22528c1dffb', '5f516375c1a340425677cb997dc8fc74954d2076',
      'sha512-lG/EPEiL22bB70yKJhWWSPk1UQGLnwO7Dp+hNc/jUmBwb0qxPLzHCUkXEfkny4iYDOsgnsNQmc39/g9QcvnBnA==',
      '165 commits, 300 files', 'SHA256SUMS', 'resolved upstream in 1.13.1']) assert.ok(audit.includes(phrase), phrase);
    assert.equal((audit.match(/^## /gm) ?? []).length, 4);
    assert.match(await repo('scripts/openspec-1-13-live-cases.mjs'), /shown\.deltas\.length, 1,/);
    assert.match(await repo('docs/openspec-1.13.0-audit.md'), /resolved upstream in 1\.13\.1/);
  });

  it('keeps authoring guidance aligned with the exact upstream metadata and strict boundaries', async () => {
    for (const skill of ['aif-plan', 'aif-improve']) {
      const prompt = await repo(`injections/core/${skill}-plan-folder.md`);
      for (const phrase of ['500 characters', 'MODIFIED', 'skip_design', 'preserve user metadata', 'durable requirement/scenario names']) assert.ok(prompt.includes(phrase), `${skill}: ${phrase}`);
    }
    // This checks the source-derived known-key contract, not upstream validation.
    // Actual metadata acceptance is established only by checksum-bound live fixtures.
    const knownKeys = ['schema', 'created', 'goal', 'affected_areas', 'initiative', 'skip_specs', 'retire_capabilities'];
    const docs = await repo('docs/openspec-validation.md');
    for (const key of knownKeys) assert.ok(docs.includes(`\`${key}\``), key);
    assert.ok(docs.includes('`skip_design` is unsupported'));
  });
});
