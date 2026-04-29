// openspec-mode-fixtures.test.mjs - OpenSpec mode fixtures and CI contract coverage
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { access, cp, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { detectOpenSpec } from './openspec-runner.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const FIXTURE_ROOT = path.join(REPO_ROOT, 'test', 'fixtures');
const tempRoots = [];

async function createTempRoot() {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'aifhub-openspec-mode-'));
  tempRoots.push(rootDir);
  return rootDir;
}

async function copyFixture(fixtureName, rootDir) {
  await cp(path.join(FIXTURE_ROOT, fixtureName), rootDir, { recursive: true });
}

async function readFixture(fixtureName, relativePath) {
  return readFile(path.join(FIXTURE_ROOT, fixtureName, ...relativePath.split('/')), 'utf8');
}

async function pathExists(targetPath) {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function listFixtureFiles(fixtureName) {
  const fixturePath = path.join(FIXTURE_ROOT, fixtureName);
  const files = [];

  async function walk(directoryPath) {
    for (const entry of await readdir(directoryPath, { withFileTypes: true })) {
      const childPath = path.join(directoryPath, entry.name);

      if (entry.isDirectory()) {
        await walk(childPath);
      } else if (entry.isFile()) {
        files.push(path.relative(fixturePath, childPath).replaceAll('\\', '/'));
      }
    }
  }

  await walk(fixturePath);
  return files.sort();
}

async function listFiles(rootDir, relativePath = '.') {
  const directoryPath = path.join(rootDir, ...relativePath.split('/').filter(Boolean));
  const files = [];

  if (!await pathExists(directoryPath)) {
    return files;
  }

  async function walk(currentPath) {
    for (const entry of await readdir(currentPath, { withFileTypes: true })) {
      const childPath = path.join(currentPath, entry.name);

      if (entry.isDirectory()) {
        await walk(childPath);
      } else if (entry.isFile()) {
        files.push(path.relative(rootDir, childPath).replaceAll('\\', '/'));
      }
    }
  }

  await walk(directoryPath);
  return files.sort();
}

async function isDirectory(targetPath) {
  try {
    return (await stat(targetPath)).isDirectory();
  } catch {
    return false;
  }
}

function createVersionExecutor(versionOutput) {
  return async () => ({
    exitCode: 0,
    stdout: versionOutput,
    stderr: ''
  });
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((rootDir) => rm(rootDir, {
    recursive: true,
    force: true
  })));
});

describe('OpenSpec mode fixtures', () => {
  it('provides an OpenSpec-native bootstrap and generated change fixture', async () => {
    const files = await listFixtureFiles('openspec-native');

    assert.ok(files.includes('.ai-factory/config.yaml'));
    assert.ok(files.includes('openspec/config.yaml'));
    assert.ok(files.includes('openspec/specs/auth/spec.md'));
    assert.ok(files.includes('openspec/changes/add-oauth/proposal.md'));
    assert.ok(files.includes('openspec/changes/add-oauth/design.md'));
    assert.ok(files.includes('openspec/changes/add-oauth/tasks.md'));
    assert.ok(files.includes('openspec/changes/add-oauth/specs/auth/spec.md'));
    assert.ok(files.includes('openspec/changes/bad-change/proposal.md'));
    assert.ok(files.includes('openspec/changes/bad-change/tasks.md'));
    assert.equal(files.includes('.ai-factory/plans/add-oauth/task.md'), false);

    const config = await readFixture('openspec-native', '.ai-factory/config.yaml');
    assert.match(config, /artifactProtocol:\s*openspec/);
    assert.match(config, /plans:\s*openspec\/changes/);
    assert.match(config, /specs:\s*openspec\/specs/);
    assert.match(config, /state:\s*\.ai-factory\/state/);
    assert.match(config, /qa:\s*\.ai-factory\/qa/);
    assert.match(config, /rules_generated:\s*\.ai-factory\/rules\/generated/);
    assert.doesNotMatch(config, /openspec[-_\s]*skills/i);
    assert.equal(await isDirectory(path.join(FIXTURE_ROOT, 'openspec-native', '.codex', 'skills', 'openspec')), false);
  });

  it('provides an explicit OpenSpec-off missing-CLI fixture', async () => {
    const files = await listFixtureFiles('openspec-missing-cli');
    const config = await readFixture('openspec-missing-cli', '.ai-factory/config.yaml');

    assert.ok(files.includes('.ai-factory/config.yaml'));
    assert.match(config, /artifactProtocol:\s*legacy/);
    assert.doesNotMatch(config, /artifactProtocol:\s*openspec/);
    assert.doesNotMatch(config, /plans:\s*openspec\/changes/);
  });

  it('provides generated-rules fixture specs for base and change output', async () => {
    const files = await listFixtureFiles('generated-rules');

    assert.deepEqual(files, [
      'openspec/changes/add-oauth/specs/auth/spec.md',
      'openspec/specs/auth/spec.md'
    ]);
  });

  it('can copy fixture trees into temp roots without writing to the repository', async () => {
    const rootDir = await createTempRoot();

    await copyFixture('openspec-native', rootDir);

    assert.deepEqual(await listFiles(rootDir, 'openspec/changes/add-oauth'), [
      'openspec/changes/add-oauth/design.md',
      'openspec/changes/add-oauth/proposal.md',
      'openspec/changes/add-oauth/specs/auth/spec.md',
      'openspec/changes/add-oauth/tasks.md'
    ]);
  });
});

describe('OpenSpec Node compatibility and CI matrix', () => {
  it('models Node 18 as degraded and Node 20.19+ as OpenSpec-compatible through injected CLI executors', async () => {
    const node18 = await detectOpenSpec({
      executor: createVersionExecutor('openspec 1.3.1\n'),
      nodeVersion: '18.20.0'
    });
    const node20 = await detectOpenSpec({
      executor: createVersionExecutor('openspec 1.3.1\n'),
      nodeVersion: '20.19.0'
    });

    assert.equal(node18.available, true);
    assert.equal(node18.nodeSupported, false);
    assert.equal(node18.canValidate, false);
    assert.equal(node18.canArchive, false);
    assert.equal(node18.reason, 'unsupported-node');
    assert.equal(node20.available, true);
    assert.equal(node20.nodeSupported, true);
    assert.equal(node20.canValidate, true);
    assert.equal(node20.canArchive, true);
    assert.equal(node20.reason, null);
  });

  it('keeps new OpenSpec integration tests under the npm test glob', async () => {
    const packageJson = JSON.parse(await readFile(path.join(REPO_ROOT, 'package.json'), 'utf8'));

    assert.match(packageJson.scripts.test, /node --test scripts\/\*\.test\.mjs/);
    assert.equal(await pathExists(path.join(REPO_ROOT, 'scripts', 'openspec-mode-fixtures.test.mjs')), true);
    assert.equal(await pathExists(path.join(REPO_ROOT, 'scripts', 'openspec-v1-integration.test.mjs')), true);
  });

  it('runs validate and test across Node 18 and Node 20.19+ without installing a real OpenSpec CLI', async () => {
    const workflow = await readFile(path.join(REPO_ROOT, '.github', 'workflows', 'validate.yml'), 'utf8');

    assert.match(workflow, /fail-fast:\s*false/);
    assert.match(workflow, /node-version:\s*\[[^\]]*18\.x[^\]]*20\.19\.x[^\]]*\]/s);
    assert.match(workflow, /node-version:\s*\$\{\{\s*matrix\.node-version\s*\}\}/);
    assert.match(workflow, /run:\s*npm run validate/);
    assert.match(workflow, /run:\s*npm test/);
    assert.doesNotMatch(workflow, /@fission-ai\/openspec|npx\s+openspec|npm\s+install\s+.*openspec/i);

    const hasLockfile = await pathExists(path.join(REPO_ROOT, 'package-lock.json'))
      || await pathExists(path.join(REPO_ROOT, 'npm-shrinkwrap.json'))
      || await pathExists(path.join(REPO_ROOT, 'pnpm-lock.yaml'))
      || await pathExists(path.join(REPO_ROOT, 'yarn.lock'));

    if (!hasLockfile) {
      assert.doesNotMatch(workflow, /npm ci/);
    }
  });
});
