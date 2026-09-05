import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cases, labels } from './scenarios.mjs';

const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const cfg = read(process.argv[2]);
const matrix = read(process.argv[3]);
const root = fs.realpathSync(cfg.root);
const here = path.dirname(fileURLToPath(import.meta.url));
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const within = candidate => {
  const real = fs.realpathSync(candidate), relative = path.relative(root, real);
  assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'Audit target outside temporary root');
  return real;
};
const git = (cwd, args, binary = false) => {
  const r = spawnSync(cfg.git, args, { cwd, windowsHide: true, encoding: binary ? undefined : 'utf8', maxBuffer: 32 * 1024 * 1024 });
  assert.equal(r.status, 0, 'Git audit command failed');
  return binary ? r.stdout : r.stdout.trim();
};
function files(dir, prefix = '') {
  const result = new Map();
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['.git', '.pytest_cache', '__pycache__'].includes(entry.name)) continue;
    assert(!entry.isSymbolicLink(), 'Unexpected link in benchmark copy');
    const relative = prefix + entry.name, absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) for (const pair of files(absolute, relative + '/')) result.set(...pair);
    else result.set(relative, hash(absolute));
  }
  return result;
}

const sources = {};
for (const label of labels) {
  const source = cfg.projects[label], snapshot = within(path.join(root, 'snapshots', label));
  assert.equal(git(source.path, ['rev-parse', 'HEAD']), source.commit);
  assert.equal(git(source.path, ['status', '--porcelain']), '');
  const tracked = git(snapshot, ['ls-files', '-z']).split('\0').filter(Boolean);
  let compared = 0;
  for (const relative of tracked) {
    if (relative === 'BENCH_NOTES.md') continue;
    assert(!/(^|\/)(\.env(?:\..*)?|auth\.json|credentials\.json|id_rsa|id_ed25519|\.gitmodules)$/.test(relative));
    const original = git(source.path, ['show', `${source.commit}:${relative}`], true);
    assert(fs.readFileSync(path.join(snapshot, relative)).equals(original), `Snapshot bytes differ: ${label}`);
    compared++;
  }
  assert.equal(git(snapshot, ['remote']), '');
  sources[label] = { cleanAndPinnedAfter: true, snapshotFilesComparedWithGitObjects: compared, originalRemotesAbsent: true };
}

const rows = [];
for (const row of matrix.rows) {
  const job = within(path.join(root, 'jobs', `${row.stage}-${row.scenario}-${row.repetition}-${row.arm}`));
  const stats = read(path.join(job, 'private-metrics.json')), config = read(path.join(job, 'case.json'));
  const sandbox = within(stats.sandbox), fixture = within(path.join(root, 'fixtures', row.scenario));
  const spec = cases.find(x => x.id === row.scenario);
  assert(spec);
  const expected = files(fixture), actual = files(sandbox), changed = [];
  for (const [relative, digest] of expected) {
    assert(actual.has(relative), 'Benchmark file was removed');
    if (actual.get(relative) !== digest) {
      assert(spec.writePaths.includes(relative), 'File changed outside permitted source paths');
      changed.push(relative);
    }
  }
  for (const relative of actual.keys()) assert(expected.has(relative), 'Unexpected sandbox file');
  for (const label of labels) {
    assert.equal(git(path.join(sandbox, label), ['rev-parse', 'HEAD']), git(path.join(fixture, label), ['rev-parse', 'HEAD']));
    assert.equal(git(path.join(sandbox, label), ['remote']), '');
  }
  for (const key of ['messages', 'input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens', 'modelErrors', 'rtkCalls', 'rawCalls']) assert.equal(stats[key], row[key]);
  assert(!Object.keys(config.commandEnv).some(key => /API_KEY|TOKEN|PASSWORD|SECRET|AUTH/i.test(key)), 'Credential name in source-command environment');
  assert.equal(config.commandEnv.RTK_TEE, '0');
  assert.equal(config.commandEnv.RTK_TELEMETRY_DISABLED, '1');
  rows.push({ scenario: row.scenario, repetition: row.repetition, arm: row.arm,
    sandboxContained: true, repositoryHeadsPreserved: true, sourceWriteScopePreserved: true,
    checkFilesUnchanged: true, usageMatchesSidecar: true, changedSourceFiles: changed.length });
}
for (const [file, digest] of Object.entries(matrix.provenance.harness)) assert.equal(hash(path.join(here, file)), digest, 'Inference harness changed');
const metadata = spawnSync(cfg.python, ['-c', 'import importlib.metadata as m,json; print(json.dumps({d.metadata["Name"]:d.version for d in m.distributions()},sort_keys=True))'], { windowsHide: true, encoding: 'utf8' });
assert.equal(metadata.status, 0);
const result = { pass: true, sources, observations: rows.length, rows,
  dependencies: JSON.parse(metadata.stdout),
  sharedHarness: Object.fromEntries(['guard.mjs', 'answer.mjs'].map(file => [file, hash(path.join(here, '../rtk-ai-tester-ab', file))])),
  nativeRtkExtensionMatchesPin: hash(cfg.rtkExtension) === matrix.provenance.rtk.extensionSha256,
  inferenceHarnessUnchanged: true,
  privacyScope: 'Aggregate-only output; checks file bytes and credential names, not a complete secret scanner or OS isolation proof.' };
assert(result.nativeRtkExtensionMatchesPin);
const text = JSON.stringify(result, null, 2) + '\n';
assert(!(cfg.forbiddenNames || []).some(name => text.toLowerCase().includes(name.toLowerCase())), 'Private name in audit output');
fs.writeFileSync(process.argv[4], text);
console.log(JSON.stringify({ pass: true, observations: rows.length, sources, inferenceHarnessUnchanged: true }));
