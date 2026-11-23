import assert from 'node:assert/strict';
import { link, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { migrateConfig } from './aifhub-config-migration.mjs';

const legacy = 'aifhub:\n  artifactProtocol: openspec\n';

async function fixture(t, raw) {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'aifhub-config-migration-'));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const directory = path.join(rootDir, '.ai-factory');
  const file = path.join(directory, 'config.yaml');
  if (raw !== undefined) {
    await mkdir(directory);
    await writeFile(file, raw);
  }
  return { rootDir, directory, file };
}

test('legacy preview preserves BOM, CRLF, comments and independent provider switches', async (t) => {
  const raw = [
    '\uFEFF# user settings',
    'aifhub:',
    '  artifactProtocol: "openspec" # selected',
    '  providers:',
    '    hlv:',
    '      enable: true',
    '    lekalo:',
    '      enable: false',
    'paths:',
    '  plans: "openspec/changes"',
    '  specs: openspec/specs # keep this',
    '  roadmap: custom/ROADMAP.md',
    'unknown: private-sentinel'
  ].join('\r\n');
  const { rootDir, file } = await fixture(t, raw);
  const preview = await migrateConfig({ rootDir });
  assert.equal(preview.status, 'ready');
  assert.deepEqual(preview.paths, { plans: 'openspec/changes', specs: 'openspec/specs' });
  assert.doesNotMatch(JSON.stringify(preview), /private-sentinel|selected/);
  assert.equal(await readFile(file, 'utf8'), raw);
  assert.equal((await migrateConfig({ rootDir, revision: preview.revision_sha256 })).status, 'applied');
  assert.equal(await readFile(file, 'utf8'), raw.replace('  artifactProtocol: "openspec" # selected',
    '  # selected\r\n  tools:\r\n    openspec: true\r\n    hlv: true\r\n    lekalo: false'));
});

test('an explicit matching map keeps existing raw paths and removes only the marker', async (t) => {
  const raw = 'paths:\n  plans: custom/plans\n  specs: custom/specs\n'
    + 'aifhub:\n  tools:\n    openspec: false\n    lekalo: true\n  artifactProtocol: ai-factory';
  const { rootDir, file } = await fixture(t, raw);
  const preview = await migrateConfig({ rootDir });
  assert.deepEqual(preview.changed_keys, ['aifhub.artifactProtocol']);
  assert.deepEqual(preview.paths, { plans: '.ai-factory/plans', specs: '.ai-factory/specs' });
  assert.equal((await migrateConfig({ rootDir, revision: preview.revision_sha256 })).status, 'applied');
  assert.equal(await readFile(file, 'utf8'), raw.replace('  artifactProtocol: ai-factory', ''));
  assert.equal((await migrateConfig({ rootDir })).status, 'noop');
});

test('missing config is a noop and does not create directories', async (t) => {
  const { rootDir } = await fixture(t);
  assert.equal((await migrateConfig({ rootDir })).status, 'noop');
  assert.deepEqual(await readdir(rootDir), []);
});

test('rejects malformed or conflicting config before writing', async (t) => {
  for (const [raw, code] of [
    [legacy + '  tools:\n    openspec: false\n', 'conflicting-modes'],
    [legacy + 'paths:\n  plans: custom/plans\n', 'effective-paths-changed'],
    [legacy + 'paths: # retained\n  plans: custom/plans\n  specs: custom/specs\n', 'invalid-paths'],
    [legacy + 'paths:\n  plans: openspec/changes\n  plans: openspec/changes\n', 'invalid-paths'],
    [legacy + 'paths:\n  plans: ../openspec/changes\n', 'invalid-paths'],
    [legacy + '  providers:\n    hlv:\n      enable: [invalid\n', 'invalid-config'],
    [Buffer.concat([Buffer.from(legacy), Buffer.from([0xc3])]), 'invalid-config']
  ]) {
    const { rootDir, file, directory } = await fixture(t, raw);
    const preview = await migrateConfig({ rootDir });
    assert.equal(preview.status, 'blocked');
    assert.equal(preview.code, code);
    assert.equal(preview.revision_sha256, undefined);
    assert.deepEqual(await readFile(file), Buffer.from(raw));
    assert.deepEqual(await readdir(directory), ['config.yaml']);
  }
});

test('revisions cannot move between projects or overwrite changed bytes', async (t) => {
  const first = await fixture(t, legacy);
  const second = await fixture(t, legacy);
  const revision = (await migrateConfig(first)).revision_sha256;
  assert.equal((await migrateConfig({ rootDir: second.rootDir, revision })).code, 'stale-preview');
  assert.equal(await readFile(second.file, 'utf8'), legacy);
  await writeFile(first.file, legacy + '# changed\n');
  assert.equal((await migrateConfig({ rootDir: first.rootDir, revision })).code, 'stale-preview');
  assert.equal(await readFile(first.file, 'utf8'), legacy + '# changed\n');
});

test('apply rechecks config before rename and cleans up after failure', async (t) => {
  const { rootDir, file, directory } = await fixture(t, legacy);
  const revision = (await migrateConfig({ rootDir })).revision_sha256;
  const failed = await migrateConfig({ rootDir, revision, beforeReplace() { throw new Error('private-sentinel'); } });
  assert.equal(failed.code, 'config-write-failed');
  assert.doesNotMatch(JSON.stringify(failed), /private-sentinel/);
  assert.equal(await readFile(file, 'utf8'), legacy);
  assert.deepEqual(await readdir(directory), ['config.yaml']);
  const updated = legacy + '# concurrent update\n';
  const drifted = await migrateConfig({ rootDir, revision, beforeReplace: () => writeFile(file, updated) });
  assert.equal(drifted.code, 'stale-preview');
  assert.equal(await readFile(file, 'utf8'), updated);
  assert.deepEqual(await readdir(directory), ['config.yaml']);
});

test('config with another hard link is rejected', async (t) => {
  const { rootDir, file } = await fixture(t, legacy);
  await link(file, path.join(rootDir, 'linked.yaml'));
  assert.equal((await migrateConfig({ rootDir })).code, 'config-unreadable');
  assert.equal(await readFile(file, 'utf8'), legacy);
});
