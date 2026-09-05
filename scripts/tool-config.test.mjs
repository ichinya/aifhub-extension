import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseToolConfig } from './tool-config.mjs';
import { runProviderProcess } from './provider-process.mjs';
import { runProviders } from './aifhub-providers.mjs';
import { getModeStatus, doctorAifMode, renderConfigForMode, syncArtifacts, syncOpenSpecArtifacts, writeModeConfig } from './aif-artifact-sync.mjs';
import { buildOpenSpecDoneReadiness } from './openspec-done-readiness.mjs';

const roots = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const fakeHlv = fileURLToPath(new URL('../test/fixtures/validation-providers/fake-hlv.mjs', import.meta.url));
async function rootWithConfig(config) {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'aifhub-tools-'));
  roots.push(rootDir);
  await mkdir(path.join(rootDir, '.ai-factory'));
  await writeFile(path.join(rootDir, '.ai-factory/config.yaml'), config);
  return rootDir;
}
async function commit(rootDir) {
  for (const args of [['init', '-q'], ['add', '.'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']]) {
    assert.equal((await runProviderProcess('git', args, { cwd: rootDir })).exitCode, 0);
  }
}

for (const openspec of [false, true]) for (const hlv of [false, true]) {
  test(`tool composition openspec=${openspec} hlv=${hlv} chooses artifacts and runs only enabled tools`, async () => {
    // Deliberately retain the opposite old mode and paths: tool booleans win.
    const staleRoot = openspec ? '.ai-factory' : 'openspec';
    const rootDir = await rootWithConfig(`aifhub:\n  tools:\n    openspec: ${openspec}\n    hlv: ${hlv}\n    lekalo: false\n  artifactProtocol: ${openspec ? 'ai-factory' : 'openspec'}\npaths:\n  plans: ${staleRoot}/${openspec ? 'plans' : 'changes'}\n  specs: ${staleRoot}/specs\n`);
    if (hlv) {
      await mkdir(path.join(rootDir, '.hlv'));
      await writeFile(path.join(rootDir, '.hlv/project.yaml'), 'schema_version: 1\nproject: fixture\n');
    }
    await commit(rootDir);
    const probes = [];
    const detectOpenSpec = async () => {
      probes.push('openspec');
      return { available: false, canValidate: false, canArchive: false, errors: [] };
    };
    const calls = [];
    const runProcess = async (executable, args, options) => {
      if (executable !== 'hlv') return runProviderProcess(executable, args, options);
      calls.push(args);
      return runProviderProcess(process.execPath, [fakeHlv, ...args], options);
    };
    const options = { rootDir, detectOpenSpec, runProcess, getCurrentBranch: async () => 'main' };
    const status = await getModeStatus(options);
    assert.equal(status.ok, true, JSON.stringify(status));
    assert.equal(status.mode, openspec ? 'openspec' : 'ai-factory');
    assert.deepEqual(status.tools, { openspec, hlv, lekalo: false });
    assert.equal(status.config.paths.plans, openspec ? 'openspec/changes' : '.ai-factory/plans');
    assert.equal(status.config.paths.specs, openspec ? 'openspec/specs' : '.ai-factory/specs');
    const sync = await syncArtifacts({ ...options, all: true, writeReport: false });
    assert.equal(sync.ok, true, JSON.stringify(sync));
    await stat(path.join(rootDir, status.config.paths.plans));
    await stat(path.join(rootDir, status.config.paths.specs));
    await assert.rejects(stat(path.join(rootDir, openspec ? '.ai-factory/plans' : 'openspec')));
    assert.equal(probes.length > 0, openspec);
    const result = await runProviders({ ...options, phase: 'verify', changeId: 'composition', write: true });
    assert.equal(result.blocking, false, JSON.stringify(result));
    assert.equal(result.providers.length, hlv ? 1 : 0);
    assert.equal(calls.some(args => args.includes('check')), hlv);
    const evidencePath = path.join(rootDir, '.ai-factory/qa/composition/providers/hlv-verify.json');
    if (hlv) assert.equal(JSON.parse(await readFile(evidencePath, 'utf8')).kind, 'validation');
    else await assert.rejects(stat(evidencePath));
    if (!openspec) {
      probes.length = 0;
      const doctor = await doctorAifMode(options);
      assert.equal(doctor.ok, true, JSON.stringify(doctor));
      assert.deepEqual(probes, []);
    }
  });
}

test('tool mapping overrides legacy provider opt-in and omitted flags stay disabled', async () => {
  const rootDir = await rootWithConfig('aifhub:\n  tools:\n    openspec: false\n  artifactProtocol: openspec\n  providers:\n    hlv:\n      enable: true\n      policy: required\n');
  const calls = [];
  const result = await runProviders({ rootDir, phase: 'doctor', runProcess: () => calls.push('unexpected') });
  assert.equal(result.blocking, false);
  assert.deepEqual(result.providers, []);
  assert.deepEqual(calls, []);
  const raw = await readFile(path.join(rootDir, '.ai-factory/config.yaml'), 'utf8');
  assert.deepEqual(parseToolConfig(renderConfigForMode(raw, 'openspec')).tools, { openspec: true, hlv: false, lekalo: false });
  for (const mode of ['openspec', 'ai-factory']) {
    const rendered = renderConfigForMode('aifhub:\n  tools:\n    openspec: true\n    hlv: true\n    lekalo: true\n', mode);
    assert.deepEqual(parseToolConfig(rendered).tools, { openspec: mode === 'openspec', hlv: true, lekalo: true });
    assert.doesNotMatch(rendered, /artifactProtocol|enable:/);
  }
});

test('false prevents stale OpenSpec files from selecting done or writing runtime evidence', async () => {
  const rootDir = await rootWithConfig('aifhub:\n  tools:\n    openspec: false\n    hlv: false\n');
  const change = path.join(rootDir, 'openspec/changes/retained');
  await mkdir(change, { recursive: true });
  await writeFile(path.join(change, 'proposal.md'), '# retained\n');
  const calls = [];
  const result = await buildOpenSpecDoneReadiness({ rootDir, changeId: 'retained', detectOpenSpec: () => calls.push('unexpected') });
  assert.equal(result.blocking, true);
  assert.equal(result.diagnostics[0].code, 'openspec-disabled');
  assert.equal((await syncOpenSpecArtifacts({ rootDir })).errors[0].code, 'openspec-disabled');
  assert.deepEqual(calls, []);
  assert.equal(await readFile(path.join(change, 'proposal.md'), 'utf8'), '# retained\n');
  await assert.rejects(stat(path.join(rootDir, '.ai-factory/qa')));
});

test('reserved Lekalo switch reports unsupported without executing guessed commands or creating model files', async () => {
  const rootDir = await rootWithConfig('aifhub:\n  tools:\n    openspec: false\n    hlv: false\n    lekalo: true\n');
  await commit(rootDir);
  const result = await runProviders({ rootDir, phase: 'verify', changeId: 'composition', write: true });
  assert.equal(result.blocking, true);
  assert.equal(result.providers.length, 1);
  assert.equal(result.providers[0].kind, 'semantic_model');
  assert.equal(result.providers[0].reason, 'protocol_unpublished');
  await assert.rejects(stat(path.join(rootDir, 'lekalo')));
});

test('invalid booleans and duplicate or ambiguous tool mappings cannot silently change artifact owners', async () => {
  for (const raw of [
    ...['"false"', "'true'", 'yes', 'no', '1', '0', 'null', '[]', '{}', ''].map(value => `aifhub:\n  tools:\n    openspec: ${value}\n`),
    'aifhub:\n  tools:\n    openspec: true\n    openspec: false\n',
    'aifhub:\n  tools:\n    unknown: true\n',
    'aifhub:\n  tools:\n    hlv: true\n  tools:\n    hlv: false\n',
    'aifhub:\n  tools: {}\n    hlv: true\n',
    'aifhub:\n  tools: &alias\n',
    'aifhub:\n  tools:\n',
    'aifhub:\n    tools:\n      openspec: false\n'
  ]) assert.throws(() => parseToolConfig(raw), raw);
  assert.equal(parseToolConfig('\uFEFFaifhub:\n  tools:\n    openspec: true\n').tools.openspec, true);
  const raw = 'aifhub:\n  tools:\n    openspec: "false"\n';
  const rootDir = await rootWithConfig(raw);
  const calls = [];
  const status = await getModeStatus({ rootDir, detectOpenSpec: () => calls.push('unexpected') });
  assert.equal(status.ok, false);
  assert.equal((await writeModeConfig('ai-factory', { rootDir })).ok, false);
  assert.equal(await readFile(path.join(rootDir, '.ai-factory/config.yaml'), 'utf8'), raw);
  const result = await runProviders({ rootDir, phase: 'verify', runProcess: () => calls.push('unexpected') });
  assert.equal(result.blocking, true);
  assert.deepEqual(calls, []);
});
