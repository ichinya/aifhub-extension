// memory-tool-field-run.test.mjs - safety contract for optional context tool field runs
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  REJECTED_FULL_INSTALL_IDS,
  SAFE_TOOL_IDS,
  assertWithinDirectory,
  buildPublicRunSummary,
  discoverProjectRoots,
  getContext7RunStatus,
  getProfileLifecycleRunStatus,
  getToolPlan,
  hasSensitivePathLeak,
  prepareSanitizedCopy,
  runMemoryToolFieldRun,
  safeRemoveWithin
} from './memory-tool-field-run.mjs';

let tmpDir;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'memory-tool-field-run-'));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

async function writeFixtureFile(relativePath, content = 'fixture') {
  const target = path.join(tmpDir, relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, 'utf8');
  return target;
}

describe('project discovery', () => {
  it('returns anonymous profiles without leaking project names in public summaries', async () => {
    await writeFixtureFile(path.join('secret-product', 'package.json'), '{"name":"secret-product"}');
    await writeFixtureFile(path.join('another-private-service', 'go.mod'), 'module private.local/service');

    const profiles = await discoverProjectRoots([tmpDir], { maxProfiles: 10 });
    const summary = buildPublicRunSummary({ profiles, rootInputs: [tmpDir], tools: getToolPlan('safe') });
    const encoded = JSON.stringify(summary);

    assert.equal(profiles.length, 2);
    assert.deepEqual(profiles.map((profile) => profile.id), ['field-profile-01', 'field-profile-02']);
    assert.equal(encoded.includes('secret-product'), false);
    assert.equal(encoded.includes('another-private-service'), false);
    assert.equal(hasSensitivePathLeak(summary, [tmpDir]), false);
  });

  it('skips first-level non-project folders but includes nested project roots', async () => {
    await writeFixtureFile(path.join('docs', 'notes.md'), '# docs only');
    await writeFixtureFile(path.join('archive', 'old.txt'), 'not a project');
    await writeFixtureFile(path.join('workspace', 'nested-service', 'package.json'), '{"name":"nested-service"}');
    await writeFixtureFile(path.join('direct-service', 'go.mod'), 'module private.local/direct');

    const profiles = await discoverProjectRoots([tmpDir], { maxProfiles: 10 });
    const basenames = profiles.map((profile) => path.basename(profile.sourceRoot)).sort();

    assert.deepEqual(basenames, ['direct-service', 'nested-service']);
  });

  it('honors maxProfiles 0 as an empty profile cap', async () => {
    await writeFixtureFile(path.join('first-service', 'package.json'), '{}');
    await writeFixtureFile(path.join('second-service', 'go.mod'), 'module private.local/second');

    const profiles = await discoverProjectRoots([tmpDir], { maxProfiles: 0 });

    assert.deepEqual(profiles, []);
  });

  it('excludes a selected root and nested project roots under it', async () => {
    await writeFixtureFile(path.join('included', 'package.json'), '{}');
    await writeFixtureFile(path.join('excluded', 'package.json'), '{}');
    await writeFixtureFile(path.join('excluded', 'nested', 'package.json'), '{}');

    const profiles = await discoverProjectRoots([tmpDir], {
      maxProfiles: 10,
      excludeRoots: [path.join(tmpDir, 'excluded')]
    });
    const basenames = profiles.map((profile) => path.basename(profile.sourceRoot));

    assert.deepEqual(basenames, ['included']);
  });
});

describe('sanitized copies', () => {
  it('excludes protected directories, env files, lock files, and build artifacts', async () => {
    const sourceRoot = path.join(tmpDir, 'source-project');
    await writeFixtureFile(path.join('source-project', 'package.json'), '{}');
    await writeFixtureFile(path.join('source-project', 'src', 'index.js'), 'console.log("ok");');
    await writeFixtureFile(path.join('source-project', '.git', 'config'), 'private git config');
    await writeFixtureFile(path.join('source-project', '.env'), 'TOKEN=secret');
    await writeFixtureFile(path.join('source-project', '.agents', 'skills', 'aif-build-automation', 'templates', 'magefile.go'), 'package main');
    await writeFixtureFile(path.join('source-project', '.codex', 'skills', 'aif-build-automation', 'templates', 'magefile.go'), 'package main');
    await writeFixtureFile(path.join('source-project', '.github', 'skills', 'aif-build-automation', 'templates', 'magefile.go'), 'package main');
    await writeFixtureFile(path.join('source-project', '.github', 'workflows', 'validate.yml'), 'name: validate\n');
    await writeFixtureFile(path.join('source-project', 'node_modules', 'pkg', 'index.js'), 'dependency');
    await writeFixtureFile(path.join('source-project', 'runs', 'private-trace.json'), '{"private":"trace"}');
    await writeFixtureFile(path.join('source-project', 'package-lock.json'), '{}');
    await writeFixtureFile(path.join('source-project', 'dist', 'bundle.js'), 'built');

    const outDir = path.join(tmpDir, 'run-output');
    await mkdir(outDir, { recursive: true });
    const copy = await prepareSanitizedCopy({
      profile: { id: 'field-profile-01', sourceRoot },
      outDir
    });

    assert.equal(await exists(path.join(copy.copyPath, 'src', 'index.js')), true);
    assert.equal(await exists(path.join(copy.copyPath, '.git', 'config')), false);
    assert.equal(await exists(path.join(copy.copyPath, '.env')), false);
    assert.equal(await exists(path.join(copy.copyPath, '.agents')), false);
    assert.equal(await exists(path.join(copy.copyPath, '.codex')), false);
    assert.equal(await exists(path.join(copy.copyPath, '.github', 'skills')), false);
    assert.equal(await exists(path.join(copy.copyPath, '.github', 'workflows', 'validate.yml')), true);
    assert.equal(await exists(path.join(copy.copyPath, 'node_modules')), false);
    assert.equal(await exists(path.join(copy.copyPath, 'runs')), false);
    assert.equal(await exists(path.join(copy.copyPath, 'package-lock.json')), false);
    assert.equal(await exists(path.join(copy.copyPath, 'dist')), false);
  });

  it('treats leading ** slash ignore globs as zero or more directories', async () => {
    const sourceRoot = path.join(tmpDir, 'source-project');
    await writeFixtureFile(path.join('source-project', 'package.json'), '{}');
    await writeFixtureFile(path.join('source-project', '.gitignore'), '**/*.secret\n');
    await writeFixtureFile(path.join('source-project', 'top.secret'), 'root secret');
    await writeFixtureFile(path.join('source-project', 'src', 'nested.secret'), 'nested secret');
    await writeFixtureFile(path.join('source-project', 'src', 'index.js'), 'console.log("ok");');

    const outDir = path.join(tmpDir, 'run-output');
    await mkdir(outDir, { recursive: true });
    const copy = await prepareSanitizedCopy({
      profile: { id: 'field-profile-01', sourceRoot },
      outDir
    });

    assert.equal(await exists(path.join(copy.copyPath, 'top.secret')), false);
    assert.equal(await exists(path.join(copy.copyPath, 'src', 'nested.secret')), false);
    assert.equal(await exists(path.join(copy.copyPath, 'src', 'index.js')), true);
  });
});

describe('path guards', () => {
  it('rejects copy and delete targets outside the selected run directory', async () => {
    const runDir = path.join(tmpDir, 'run');
    await mkdir(runDir, { recursive: true });

    assert.throws(
      () => assertWithinDirectory(runDir, path.join(tmpDir, 'outside'), 'test target'),
      /outside/i
    );
    await assert.rejects(
      () => safeRemoveWithin(runDir, path.join(tmpDir, 'outside')),
      /outside/i
    );
  });

  it('removes stale tool-owned directories inside the selected run directory', async () => {
    const toolsDir = path.join(tmpDir, 'run', 'tools');
    const cloneDir = path.join(toolsDir, 'codex-agent-mem-repo');
    await mkdir(cloneDir, { recursive: true });
    await writeFile(path.join(cloneDir, 'stale.txt'), 'old clone', 'utf8');

    await safeRemoveWithin(toolsDir, cloneDir);

    assert.equal(await exists(cloneDir), false);
  });
});

describe('tool plan', () => {
  it('keeps rejected providers out of safe full-install runs', () => {
    const plan = getToolPlan('safe');
    const installed = plan.filter((tool) => tool.fullInstall).map((tool) => tool.id);
    const ids = plan.map((tool) => tool.id);

    assert.deepEqual(ids, ['rg', 'git-gh', 'codegraph', 'repowise', 'graphify', 'context7', 'context-mode', 'codex-agent-mem']);
    assert.equal(installed.includes('codex-mem'), false);
    assert.equal(installed.includes('eagle-mem'), false);
    assert.equal(installed.includes('agent-memory'), false);
    assert.equal(SAFE_TOOL_IDS.includes('rohitg00-agentmemory'), false);
    assert.equal(ids.includes('rohitg00-agentmemory'), false);
    assert.equal(REJECTED_FULL_INSTALL_IDS.has('rohitg00-agentmemory'), true);
  });
});

describe('tool status aggregation', () => {
  it('downgrades lifecycle tools when every profile run fails', () => {
    assert.equal(getProfileLifecycleRunStatus([
      { lifecycle_passed: false },
      { lifecycle_passed: false }
    ]), 'degraded');
    assert.equal(getProfileLifecycleRunStatus([
      { lifecycle_passed: false },
      { lifecycle_passed: true }
    ]), 'pass');
  });

  it('requires successful Context7 help or lookup, not just an attempted lookup', () => {
    assert.equal(getContext7RunStatus({
      helpExitCode: 1,
      docsLookup: { attempted: true, passed: false }
    }), 'degraded');
    assert.equal(getContext7RunStatus({
      helpExitCode: 1,
      docsLookup: { attempted: true, passed: true }
    }), 'pass');
    assert.equal(getContext7RunStatus({
      helpExitCode: 0,
      docsLookup: { attempted: true, passed: false }
    }), 'pass');
  });
});

describe('cli', () => {
  it('prints help without starting discovery or installs', async () => {
    const stdout = [];
    const result = await runMemoryToolFieldRun(['--help'], { stdout, exit: false });

    assert.equal(result.exitCode, 0);
    assert.match(stdout.join(''), /--dry-run/);
    assert.match(stdout.join(''), /--roots <dir>/);
  });
});

describe('public summaries', () => {
  it('detects direct local path leaks before writing docs', () => {
    const summary = {
      profiles: [{ id: 'field-profile-01', note: 'copied from C:\\projects\\private-root' }]
    };

    assert.equal(hasSensitivePathLeak(summary, ['C:\\projects']), true);
  });
});

async function exists(targetPath) {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
}
