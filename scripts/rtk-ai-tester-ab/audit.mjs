import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const inputs = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const root = path.resolve(inputs.root);
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const git = (cwd, args) => {
  const result = spawnSync(inputs.git, args, { cwd, encoding: 'utf8', windowsHide: true,
    env: { ...process.env, GIT_CONFIG_GLOBAL: 'NUL', GIT_CONFIG_NOSYSTEM: '1' } });
  assert.equal(result.status, 0, 'audit Git command failed');
  return result.stdout.trim();
};
const sources = {};
for (const [name, source] of Object.entries(inputs.projects)) {
  assert.equal(git(source.path, ['rev-parse', 'HEAD']), source.commit);
  assert.equal(git(source.path, ['status', '--porcelain']), '');
  sources[name] = { commit: source.commit, originalClean: true };
}
const fixtures = {};
for (const name of fs.readdirSync(path.join(root, 'fixtures'))) {
  const dir = path.join(root, 'fixtures', name);
  const files = git(dir, ['ls-files']).split('\n');
  const contentHashes = Object.fromEntries(files.map(file => [file, hash(fs.readFileSync(path.join(dir, file)))]));
  fixtures[name] = { dir, files, contentHashes, head: git(dir, ['rev-parse', 'HEAD']),
    treeSha256: hash(JSON.stringify(contentHashes)) };
}
let runsAudited = 0, sourceFilesCompared = 0, generatedPriceFiles = 0;
for (const job of fs.readdirSync(path.join(root, 'jobs')).filter(x => /^(matrix|retry)-/.test(x))) {
  const dir = path.join(root, 'jobs', job);
  const row = JSON.parse(fs.readFileSync(path.join(dir, 'result.json'), 'utf8'));
  const metrics = JSON.parse(fs.readFileSync(path.join(dir, 'private-metrics.json'), 'utf8'));
  const config = JSON.parse(fs.readFileSync(path.join(dir, 'case.json'), 'utf8'));
  assert.equal(row.totalTokens, metrics.totalTokens, 'usage changed after result collection');
  assert(!Object.keys(config.commandEnv).some(key => /API_KEY|TOKEN|PASSWORD|AUTH/i.test(key)), 'credential variable exposed to command environment');
  if (!metrics.sandbox) continue;
  const sandbox = path.resolve(metrics.sandbox);
  assert(sandbox.startsWith(path.join(root, 'sandboxes') + path.sep), 'unexpected sandbox root');
  const fixture = fixtures[row.scenario];
  assert.equal(git(sandbox, ['rev-parse', 'HEAD']), fixture.head, 'copied history changed');
  for (const file of fixture.files) {
    const contents = fs.readFileSync(path.join(sandbox, file));
    if (row.scenario === 'price-fix' && file === 'src/Support/ValueObjects/Price.php') {
      // Supplementary heuristic; not an OS containment proof.
      assert(!/\b(?:eval|exec|shell_exec|system|passthru|proc_open|popen|file_get_contents|file_put_contents|fopen|getenv|curl_exec|fsockopen|include|require)\s*\(/i.test(contents.toString('utf8')), 'generated PHP requires further review');
      generatedPriceFiles++;
    } else {
      assert.equal(hash(contents), fixture.contentHashes[file], 'unexpected source mutation');
      sourceFilesCompared++;
    }
  }
  runsAudited++;
}
const noGlobalRtk = !fs.existsSync(path.join(process.env.APPDATA, 'rtk/config.toml')) && !fs.existsSync(path.join(process.env.LOCALAPPDATA, 'rtk'));
assert(noGlobalRtk, 'RTK global state appeared');
const piConfig = path.join(root, 'pi-config');
assert.equal(Object.keys(JSON.parse(fs.readFileSync(path.join(piConfig, 'auth.json'), 'utf8'))).length, 0, 'temporary auth file contains entries');
assert(!fs.existsSync(path.join(piConfig, 'sessions')), 'Pi session transcripts appeared');
const audit = { schema: 1, sources, runsAudited, sourceFilesCompared, generatedPriceFiles,
  fixtureCustody: Object.fromEntries(Object.entries(fixtures).map(([name, f]) => [name, { gitHead: f.head, files: f.files.length, treeSha256: f.treeSha256 }])),
  originalSourcesUnchanged: true, nonTargetSourceBytesUnchanged: true, credentialsAbsentFromCommandEnvironments: true,
  generatedPhpIoHeuristicPassed: true, usageStableAfterCompletion: true, globalRtkStateAbsent: true,
  temporaryPiAuthEmpty: true, piSessionFilesAbsent: true,
  piAcpInstallLockSha256: hash(fs.readFileSync(path.join(root, 'adapter/package-lock.json'))) };
fs.writeFileSync(path.join(root, 'audit.json'), JSON.stringify(audit, null, 2) + '\n');
console.log(JSON.stringify(audit, null, 2));
