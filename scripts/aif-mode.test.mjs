// aif-mode.test.mjs - tests for aif-mode CLI wrapper
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseArgs, runModeCommand } from './aif-mode.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const tempRoots = [];

async function createTempRoot() {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'aifhub-mode-cli-'));
  tempRoots.push(rootDir);
  return rootDir;
}

async function writeFixture(rootDir, relativePath, content) {
  const targetPath = path.join(rootDir, ...relativePath.split('/'));
  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeFile(targetPath, content, 'utf8');
}

async function readFixture(rootDir, relativePath) {
  return readFile(path.join(rootDir, ...relativePath.split('/')), 'utf8');
}

async function pathExists(rootDir, relativePath) {
  try {
    await access(path.join(rootDir, ...relativePath.split('/')));
    return true;
  } catch {
    return false;
  }
}

function missingCliDetection() {
  return {
    available: false,
    canValidate: false,
    canArchive: false,
    version: null,
    reason: 'missing-cli',
    errors: [
      {
        code: 'missing-cli',
        message: 'OpenSpec CLI is not available on PATH.'
      }
    ]
  };
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((rootDir) => rm(rootDir, {
    recursive: true,
    force: true
  })));
});

describe('parseArgs', () => {
  it('parses supported command flags and rejects unsafe combinations', () => {
    assert.deepEqual(parseArgs(['sync', '--all', '--dry-run', '--json']), {
      ok: true,
      command: 'sync',
      dryRun: true,
      all: true,
      changeId: null,
      yes: false,
      current: false,
      exportOpenSpec: false,
      json: true,
      timestamp: undefined
    });

    assert.equal(parseArgs(['sync', '--all', '--change', 'add-oauth']).ok, false);
    assert.equal(parseArgs(['doctor', '--dry-run']).ok, false);
  });
});

describe('runModeCommand', () => {
  it('prints status in OpenSpec mode', async () => {
    const rootDir = await createTempRoot();
    await writeFixture(rootDir, '.ai-factory/config.yaml', [
      'aifhub:',
      '  artifactProtocol: openspec',
      'paths:',
      '  plans: openspec/changes',
      '  specs: openspec/specs',
      '  state: .ai-factory/state',
      '  qa: .ai-factory/qa',
      '  generated_rules: .ai-factory/rules/generated',
      ''
    ].join('\n'));
    await writeFixture(rootDir, 'openspec/changes/add-oauth/proposal.md', '# Proposal\n');

    const result = await runModeCommand(['status'], {
      rootDir,
      detectOpenSpec: async () => missingCliDetection(),
      getCurrentBranch: async () => 'feat/add-oauth'
    });

    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /Current mode: openspec/);
    assert.match(result.stdout, /OpenSpec CLI: degraded/);
    assert.match(result.stdout, /Active change: add-oauth/);
  });

  it('switches to AI Factory mode through the CLI wrapper', async () => {
    const rootDir = await createTempRoot();
    await writeFixture(rootDir, 'openspec/changes/add-oauth/proposal.md', '# Proposal\n');

    const result = await runModeCommand(['ai-factory', '--timestamp', '2026-04-29T00-00-00-000Z'], {
      rootDir,
      detectOpenSpec: async () => missingCliDetection()
    });

    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /Status: OK/);
    assert.match(await readFixture(rootDir, '.ai-factory/config.yaml'), /artifactProtocol: ai-factory/);
    assert.equal(await pathExists(rootDir, 'openspec/changes/add-oauth/proposal.md'), true);
  });

  it('emits JSON output for automation', async () => {
    const rootDir = await createTempRoot();
    await writeFixture(rootDir, '.ai-factory/config.yaml', [
      'aifhub:',
      '  artifactProtocol: ai-factory',
      ''
    ].join('\n'));

    const result = await runModeCommand(['status', '--json'], {
      rootDir,
      detectOpenSpec: async () => missingCliDetection()
    });
    const parsed = JSON.parse(result.stdout);

    assert.equal(result.exitCode, 0);
    assert.equal(parsed.mode, 'ai-factory');
    assert.equal(parsed.config.raw, undefined);
  });
});

describe('extension manifest', () => {
  it('includes aif-mode as an extension-owned skill', async () => {
    const manifest = JSON.parse(await readFile(path.join(REPO_ROOT, 'extension.json'), 'utf8'));
    assert.ok(manifest.skills.includes('skills/aif-mode'));
  });

  it('does not install the retired aif-rules-check fallback skill', async () => {
    const manifest = JSON.parse(await readFile(path.join(REPO_ROOT, 'extension.json'), 'utf8'));
    assert.equal(manifest.skills.includes('skills/aif-rules-check'), false);
  });
});
