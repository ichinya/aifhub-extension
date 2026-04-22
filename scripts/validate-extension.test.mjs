// validate-extension.test.mjs — tests for extension manifest validator
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

let tmpDir;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'validate-ext-test-'));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

async function runValidator(cwd) {
  const { stdout, stderr } = await execFileAsync('node', [
    join(__dirname, 'validate-extension.mjs')
  ], { cwd, timeout: 10000 });
  return { stdout, stderr };
}

async function runValidatorExitCode(cwd) {
  try {
    await runValidator(cwd);
    return 0;
  } catch (err) {
    return err.code || 1;
  }
}

async function writeFixture(dir, relPath, content) {
  const fullPath = join(dir, relPath);
  await mkdir(join(fullPath, '..'), { recursive: true });
  await writeFile(fullPath, content, 'utf-8');
}

function validManifest(extra = {}) {
  return JSON.stringify({
    name: 'test-ext',
    version: '1.0.0',
    description: 'test',
    compat: { 'ai-factory': '>=2.10.0 <3.0.0' },
    skills: ['skills/aif-analyze'],
    agentFiles: [
      { runtime: 'codex', source: './agent-files/codex/test.toml', target: 'test.toml' }
    ],
    injections: [
      { target: 'aif-plan', position: 'prepend', file: './injections/core/test.md' }
    ],
    ...extra
  });
}

describe('validate-extension.mjs', () => {
  it('passes with valid manifest and all files present', async () => {
    await writeFixture(tmpDir, 'extension.json', validManifest());
    await writeFixture(tmpDir, 'skills/aif-analyze/SKILL.md', '# test');
    await writeFixture(tmpDir, 'agent-files/codex/test.toml', 'name = "test"');
    await writeFixture(tmpDir, 'injections/core/test.md', '# test');

    const code = await runValidatorExitCode(tmpDir);
    assert.equal(code, 0);
  });

  it('fails with missing skill path', async () => {
    const manifest = validManifest();
    const parsed = JSON.parse(manifest);
    parsed.skills = ['skills/nonexistent'];
    await writeFixture(tmpDir, 'extension.json', JSON.stringify(parsed));
    await writeFixture(tmpDir, 'agent-files/codex/test.toml', 'name = "test"');
    await writeFixture(tmpDir, 'injections/core/test.md', '# test');

    const code = await runValidatorExitCode(tmpDir);
    assert.equal(code, 1);
  });

  it('fails with missing injection file', async () => {
    const manifest = validManifest();
    const parsed = JSON.parse(manifest);
    parsed.injections = [{ target: 'aif-plan', position: 'prepend', file: './injections/core/missing.md' }];
    await writeFixture(tmpDir, 'extension.json', JSON.stringify(parsed));
    await writeFixture(tmpDir, 'skills/aif-analyze/SKILL.md', '# test');
    await writeFixture(tmpDir, 'agent-files/codex/test.toml', 'name = "test"');

    const code = await runValidatorExitCode(tmpDir);
    assert.equal(code, 1);
  });

  it('fails with invalid semver version', async () => {
    const manifest = validManifest();
    const parsed = JSON.parse(manifest);
    parsed.version = 'not-semver';
    await writeFixture(tmpDir, 'extension.json', JSON.stringify(parsed));
    await writeFixture(tmpDir, 'skills/aif-analyze/SKILL.md', '# test');
    await writeFixture(tmpDir, 'agent-files/codex/test.toml', 'name = "test"');
    await writeFixture(tmpDir, 'injections/core/test.md', '# test');

    const code = await runValidatorExitCode(tmpDir);
    assert.equal(code, 1);
  });

  it('fails with missing compat field', async () => {
    const manifest = validManifest();
    const parsed = JSON.parse(manifest);
    delete parsed.compat;
    await writeFixture(tmpDir, 'extension.json', JSON.stringify(parsed));
    await writeFixture(tmpDir, 'skills/aif-analyze/SKILL.md', '# test');
    await writeFixture(tmpDir, 'agent-files/codex/test.toml', 'name = "test"');
    await writeFixture(tmpDir, 'injections/core/test.md', '# test');

    const code = await runValidatorExitCode(tmpDir);
    assert.equal(code, 1);
  });

  it('fails with non-.toml agentFile target for codex runtime', async () => {
    const manifest = validManifest();
    const parsed = JSON.parse(manifest);
    parsed.agentFiles[0].target = 'test.yaml';
    await writeFixture(tmpDir, 'extension.json', JSON.stringify(parsed));
    await writeFixture(tmpDir, 'skills/aif-analyze/SKILL.md', '# test');
    await writeFixture(tmpDir, 'agent-files/codex/test.toml', 'name = "test"');
    await writeFixture(tmpDir, 'injections/core/test.md', '# test');

    const code = await runValidatorExitCode(tmpDir);
    assert.equal(code, 1);
  });

  it('passes with valid manifest including claude runtime agentFiles', async () => {
    const manifest = validManifest({
      agentFiles: [
        { runtime: 'codex', source: './agent-files/codex/test.toml', target: 'test.toml' },
        { runtime: 'claude', source: './agent-files/claude/test.md', target: 'test.md' }
      ]
    });
    await writeFixture(tmpDir, 'extension.json', manifest);
    await writeFixture(tmpDir, 'skills/aif-analyze/SKILL.md', '# test');
    await writeFixture(tmpDir, 'agent-files/codex/test.toml', 'name = "test"');
    await writeFixture(tmpDir, 'agent-files/claude/test.md', '---\nname: test\ndescription: test\ntools: Read\nmodel: inherit\nmaxTurns: 6\n---\n# test');
    await writeFixture(tmpDir, 'injections/core/test.md', '# test');

    const code = await runValidatorExitCode(tmpDir);
    assert.equal(code, 0);
  });

  it('fails with non-.md agentFile target for claude runtime', async () => {
    const manifest = validManifest({
      agentFiles: [
        { runtime: 'claude', source: './agent-files/claude/test.toml', target: 'test.toml' }
      ]
    });
    await writeFixture(tmpDir, 'extension.json', manifest);
    await writeFixture(tmpDir, 'skills/aif-analyze/SKILL.md', '# test');
    await writeFixture(tmpDir, 'agent-files/claude/test.toml', 'name = "test"');
    await writeFixture(tmpDir, 'injections/core/test.md', '# test');

    const code = await runValidatorExitCode(tmpDir);
    assert.equal(code, 1);
  });

  it('fails with unknown agentFile runtime', async () => {
    const manifest = validManifest({
      agentFiles: [
        { runtime: 'unknown', source: './agent-files/codex/test.toml', target: 'test.toml' }
      ]
    });
    await writeFixture(tmpDir, 'extension.json', manifest);
    await writeFixture(tmpDir, 'skills/aif-analyze/SKILL.md', '# test');
    await writeFixture(tmpDir, 'agent-files/codex/test.toml', 'name = "test"');
    await writeFixture(tmpDir, 'injections/core/test.md', '# test');

    const code = await runValidatorExitCode(tmpDir);
    assert.equal(code, 1);
  });

  it('fails with path traversal in skill path', async () => {
    const manifest = validManifest();
    const parsed = JSON.parse(manifest);
    parsed.skills = ['../../etc/passwd'];
    await writeFixture(tmpDir, 'extension.json', JSON.stringify(parsed));
    await writeFixture(tmpDir, 'agent-files/codex/test.toml', 'name = "test"');
    await writeFixture(tmpDir, 'injections/core/test.md', '# test');

    const code = await runValidatorExitCode(tmpDir);
    assert.equal(code, 1);
  });
});
