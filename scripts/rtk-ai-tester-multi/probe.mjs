import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const cfg = read(process.argv[2]);
const environment = read(path.join(cfg.root, 'jobs/matrix-multi-diagnostics-1-rtk/case.json')).commandEnv;
const run = (exe, args, cwd) => {
  const r = spawnSync(exe, args, { cwd, env: environment, encoding: 'utf8', windowsHide: true, timeout: 90000, maxBuffer: 8 * 1024 * 1024 });
  assert(!r.error, 'Direct probe failed');
  return r;
};
const review = path.join(cfg.root, 'fixtures/contract-review');
const routing = ['repo-01', 'repo-02', 'repo-05'].map(label => {
  const raw = run(cfg.git, ['-C', label, 'diff'], review);
  const candidate = run(cfg.rtk, ['git', '-C', label, 'diff'], review);
  const local = run(cfg.rtk, ['git', 'diff'], path.join(review, label));
  assert([raw, candidate, local].every(x => x.status === 0));
  assert.equal(candidate.stdout, local.stdout);
  assert.notEqual(candidate.stdout, raw.stdout);
  return { label, rawBytes: Buffer.byteLength(raw.stdout), rtkBytes: Buffer.byteLength(candidate.stdout),
    exitCodes: [raw.status, candidate.status, local.status], gitCMatchesLocalCwd: true, actuallyCompressed: true };
});
const args = ['-q', '--tb=long', '--import-mode=importlib', 'checks'];
const diagnostics = path.join(cfg.root, 'fixtures/multi-diagnostics');
const raw = run(cfg.python, ['-m', 'pytest', ...args], diagnostics);
const compressed = run(cfg.rtk, ['pytest', ...args], diagnostics);
const operands = text => new Set([...text.matchAll(/owner=(repo-\d+) case=(\d+)/g)].map(x => `${x[1]}/${x[2]}`)).size;
assert.equal(raw.status, 1); assert.equal(compressed.status, 1);
assert.equal(operands(raw.stdout), 12);
const result = { routing, diagnostics: { rawExit: raw.status, rtkExit: compressed.status,
  rawBytes: Buffer.byteLength(raw.stdout), rtkBytes: Buffer.byteLength(compressed.stdout),
  rawDistinctCaseOperands: operands(raw.stdout), rtkDistinctCaseOperands: operands(compressed.stdout),
  bytesScope: 'stdout UTF-8 bytes; elapsed-time footer can vary' } };
const text = JSON.stringify(result, null, 2) + '\n';
assert(!(cfg.forbiddenNames || []).some(name => text.toLowerCase().includes(name.toLowerCase())));
fs.writeFileSync(process.argv[3], text);
console.log(text);
