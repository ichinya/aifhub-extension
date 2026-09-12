import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LEKALO_COMMAND_CONTRACT, detectLekalo, runLekaloOperation } from './lekalo-provider.mjs';
import { runProviders } from './aifhub-providers.mjs';
import { runProviderProcess } from './provider-process.mjs';

const roots = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function commit(rootDir) {
  for (const args of [['init', '-q'], ['add', '.'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']]) {
    assert.equal((await runProviderProcess('git', args, { cwd: rootDir })).exitCode, 0);
  }
}

test('lekalo adapter stays fail-closed and never spawns a process', async () => {
  const calls = [];
  const runProcess = async (executable, args, opts) => {
    calls.push(executable);
    return runProviderProcess(executable, args, opts);
  };
  const detection = await detectLekalo('/nonexistent', {}, { runProcess });
  assert.equal(detection.status, 'unsupported');
  assert.equal(detection.reason, 'protocol_unpublished');
  assert.equal(detection.version, null);
  assert.equal(detection.layout, null);
  assert.deepEqual(calls, []);

  for (const operation of ['detect', 'status', 'doctor', 'sync', 'validate', 'readiness', 'trace', 'impact', 'context']) {
    const result = await runLekaloOperation(operation, '/nonexistent', {}, { runProcess });
    assert.equal(result.status, 'unsupported');
    assert.equal(result.reason, 'protocol_unpublished');
    assert.deepEqual(result.diagnostics, []);
  }
  assert.deepEqual(calls, []);
  assert.equal(LEKALO_COMMAND_CONTRACT.operations.length, 0);
});

test('runProviders reports lekalo unsupported through the adapter without writes', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'aifhub-lekalo-'));
  roots.push(rootDir);
  await mkdir(path.join(rootDir, '.ai-factory'));
  await writeFile(path.join(rootDir, '.ai-factory/config.yaml'),
    'aifhub:\n  tools:\n    openspec: false\n    hlv: false\n    lekalo: true\n');
  await commit(rootDir);

  const calls = [];
  const runProcess = async (executable, args, opts) => {
    if (executable === 'lekalo') calls.push(args);
    return runProviderProcess(executable, args, opts);
  };
  const result = await runProviders({
    rootDir, phase: 'verify', changeId: 'lekalo-unsupported', write: true, runProcess
  });
  assert.equal(result.blocking, true);
  assert.equal(result.providers.length, 1);
  const [evidence] = result.providers;
  assert.equal(evidence.provider, 'lekalo');
  assert.equal(evidence.kind, 'semantic_model');
  assert.equal(evidence.policy, 'required');
  assert.equal(evidence.status, 'unsupported');
  assert.equal(evidence.reason, 'protocol_unpublished');
  assert.equal(evidence.toolVersion, null);
  assert.equal(evidence.commandContract, null);
  assert.equal(evidence.layout, null);
  assert.deepEqual(evidence.operations, []);
  assert.deepEqual(calls, [], 'lekalo CLI must never run while protocol is unpublished');

  const saved = JSON.parse(await readFile(
    path.join(rootDir, '.ai-factory/qa/lekalo-unsupported/providers/lekalo-verify.json'), 'utf8'));
  assert.equal(saved.schemaVersion, '1.0.0');
  assert.equal(saved.provider, 'lekalo');
  assert.equal(saved.kind, 'semantic_model');
  assert.equal(saved.status, 'unsupported');
  assert.equal(saved.reason, 'protocol_unpublished');
  assert.equal(saved.commandContract, null);
  assert.ok(saved.revision && /^[a-f0-9]{40,64}$/.test(saved.revision.commit));
});
