import { after, describe, it } from 'node:test';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  detectOpenSpec,
  OPENSPEC_SUPPORTED_RANGE,
  OPENSPEC_NODE_RANGE,
  OPENSPEC_LATEST_REVIEWED_VERSION,
  OPENSPEC_PACKAGE_NODE_FLOOR,
  OPENSPEC_PACKAGE_NODE_SINCE
} from './openspec-runner.mjs';
import { getModeStatus } from './aif-artifact-sync.mjs';

const tempRoots = [];
async function createTempRoot() {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'openspec-117-compat-'));
  tempRoots.push(rootDir);
  return rootDir;
}
function writeConfig(rootDir) {
  mkdirSync(path.join(rootDir, '.ai-factory'), { recursive: true });
  writeFileSync(path.join(rootDir, '.ai-factory/config.yaml'), 'aifhub:\n  artifactProtocol: openspec\n');
}

describe('OpenSpec 1.17 cumulative reviewed baseline', () => {
  it('advances freshness to 1.17.0 while keeping the stable range, Node floor and prerelease exclusion', async () => {
    assert.equal(OPENSPEC_SUPPORTED_RANGE, '>=1.3.1 <2.0.0');
    assert.equal(OPENSPEC_NODE_RANGE, '>=20.19.0');
    assert.equal(OPENSPEC_LATEST_REVIEWED_VERSION, '1.17.0');
    assert.equal(OPENSPEC_PACKAGE_NODE_FLOOR, '>=22.12.0');
    assert.equal(OPENSPEC_PACKAGE_NODE_SINCE, '1.16.0');
    for (const [version, nodeVersion, supported, outdated] of [
      ...['1.13.0', '1.13.1', '1.13.2', '1.14.0', '1.14.1', '1.14.2', '1.14.3', '1.15.0', '1.15.1'].map(v => [v, '20.19.0', true, true]),
      // 1.16.0/1.16.1 are cumulative source custody checkpoints replayed on 1.17.0.
      ['1.16.0', '20.19.0', true, true], ['1.16.1', '20.19.0', true, true],
      ['1.17.0', '20.19.0', true, false], ['1.17.1', '20.19.0', true, false],
      ['1.17.0', '18.20.8', false, false], ['1.17.0', '20.18.0', false, false],
      ['1.3.0', '20.19.0', false, null], ['2.0.0', '20.19.0', false, null],
      ['1.17.1-beta.1', '20.19.0', false, null]
    ]) {
      const result = await detectOpenSpec({ nodeVersion, executor: async () => ({ exitCode: 0, stdout: version, stderr: '' }) });
      assert.equal(result.canValidate, supported, `${version} / Node ${nodeVersion}`);
      assert.equal(result.canArchive, supported);
      assert.equal(result.versionOutdated, outdated, `${version} freshness`);
    }
  });

  it('marks npm-channel engines for 1.16+ from the CLI version as diagnostics only', async () => {
    for (const [version, nodeVersion, requiresNode, packageSupported] of [
      ['1.16.0', '20.19.0', '>=22.12.0', false],
      ['1.17.0', '20.19.0', '>=22.12.0', false],
      ['1.17.0', '22.11.0', '>=22.12.0', false],
      ['1.17.0', '22.12.0', '>=22.12.0', true],
      ['1.17.0', '24.13.0', '>=22.12.0', true],
      ['1.18.0', '22.12.0', '>=22.12.0', true],
      ['1.15.1', '20.19.0', null, null],
      ['1.15.1', '22.12.0', null, null],
      ['1.3.0', '22.12.0', null, null],
      ['2.0.0', '22.12.0', null, null],
      ['1.17.1-beta.1', '22.12.0', null, null]
    ]) {
      const result = await detectOpenSpec({ nodeVersion, executor: async () => ({ exitCode: 0, stdout: version, stderr: '' }) });
      assert.equal(result.packageRequiresNode, requiresNode, `${version} packageRequiresNode`);
      assert.equal(result.packageNodeSupported, packageSupported, `${version} / Node ${nodeVersion} packageNodeSupported`);
    }
    const fresh = await detectOpenSpec({ nodeVersion: '22.12.0', executor: async () => ({ exitCode: 0, stdout: 'openspec 1.17.0\n', stderr: '' }) });
    assert.equal(fresh.reason, null, 'npm-channel mismatch must not degrade capabilities');
    assert.deepEqual(fresh.errors, []);
    assert.equal(fresh.canValidate, true);
    assert.equal(fresh.canArchive, true);
    const missing = await detectOpenSpec({ nodeVersion: '20.19.0', executor: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); } });
    assert.equal(missing.packageRequiresNode, null);
    assert.equal(missing.packageNodeSupported, null);
    assert.equal(missing.reason, 'missing-cli');
  });

  it('keeps the runner floor failure and the npm-channel mismatch visible at the same time on old Node', async () => {
    const result = await detectOpenSpec({ nodeVersion: '18.20.8', executor: async () => ({ exitCode: 0, stdout: 'openspec 1.17.0', stderr: '' }) });
    assert.equal(result.nodeSupported, false);
    assert.equal(result.canValidate, false);
    assert.equal(result.reason, 'unsupported-node');
    assert.equal(result.errors[0].code, 'unsupported-node');
    assert.equal(result.packageRequiresNode, '>=22.12.0');
    assert.equal(result.packageNodeSupported, false);
  });

  it('propagates the npm-engine marker through mode status summaries without changing state', async () => {
    const rootDir = await createTempRoot();
    writeConfig(rootDir);
    const status = await getModeStatus({
      rootDir,
      detectOpenSpec: async () => ({
        available: true,
        canValidate: true,
        canArchive: true,
        version: '1.17.0',
        latestReviewedVersion: '1.17.0',
        versionOutdated: false,
        nodeVersion: '20.19.0',
        nodeSupported: true,
        packageRequiresNode: '>=22.12.0',
        packageNodeSupported: false,
        versionSupported: true,
        command: 'openspec',
        commandSource: 'path',
        reason: null,
        errors: []
      })
    });
    assert.equal(status.openspecCli.state, 'available');
    assert.equal(status.openspecCli.packageRequiresNode, '>=22.12.0');
    assert.equal(status.openspecCli.packageNodeSupported, false);
    assert.equal(status.openspecCli.canValidate, true);

    // Mocks without the additive fields stay valid and summarize as null markers.
    const legacy = await getModeStatus({
      rootDir,
      detectOpenSpec: async () => ({
        available: true,
        canValidate: true,
        canArchive: true,
        version: '1.15.0',
        latestReviewedVersion: '1.17.0',
        versionOutdated: true,
        nodeVersion: '20.19.0',
        nodeSupported: true,
        versionSupported: true,
        command: 'openspec',
        commandSource: 'path',
        reason: null,
        errors: []
      })
    });
    assert.equal(legacy.openspecCli.packageRequiresNode, null);
    assert.equal(legacy.openspecCli.packageNodeSupported, null);
    assert.equal(legacy.openspecCli.versionOutdated, true);
  });

  it('binds the cumulative 1.16.x/1.17.0 custody checkpoints and channel boundary in the audit', async () => {
    const audit = await readFile(new URL('../docs/openspec-1.17.0-audit.md', import.meta.url), 'utf8');
    for (const phrase of [
      '27c0515724decc633818c735ee596481eec78a8b',
      '0fa4a9705c20ef1c571fe3ded74435733e4b73a1',
      '579fcac57ae00c2dff38f971b6d88b6f1f098b8a',
      'sha512-WQVhZoIR5PoacH/H0qh84VKMcXFbKCIKuAI96arHS3KiKYhJStlRrjUKGxLqLYKLym0j+2hAAY5MZUrPE5qXIA==',
      'sha512-Qu2kdUP3oiXK6WzOA1OcEYiTlG3GmLJE37whoGjTEy4vbzuW4o3OwAwYwxSQpJnKHJ/XGySvo+icRiulBCxyzw==',
      'sha512-D9MCbh1WMuJAoSYmtbkR5csHZdhiweuX5RC6+ZxMo9I2F/wq0x2wpFvlyCdo7yV0zenEqVxqmfRmLPd5wuJC7g==',
      '7dee0ac8c0a72173b59f22bc9d70c4f7caa7d8b9',
      '32 commits, 280 files',
      'npm delivery channel requires Node',
      'npm-канал требует Node',
      '449 installed files',
      'gitHead',
      'legacy',
      'openspec-1-17-live-cases.mjs'
    ]) assert.ok(audit.includes(phrase), phrase);
    assert.equal((audit.match(/^## /gm) ?? []).length, 4);
  });
});

after(() => {
  for (const rootDir of tempRoots.splice(0)) {
    rmSync(rootDir, { recursive: true, force: true, maxRetries: 5 });
  }
});
