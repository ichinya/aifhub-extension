// validate-doc-links.test.mjs — tests for markdown doc link validator
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
  tmpDir = await mkdtemp(join(tmpdir(), 'validate-links-test-'));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

async function runValidatorExitCode(cwd) {
  try {
    await execFileAsync('node', [
      join(__dirname, 'validate-doc-links.mjs')
    ], { cwd, timeout: 10000 });
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

describe('validate-doc-links.mjs', () => {
  it('passes with valid internal links', async () => {
    await writeFixture(tmpDir, 'docs/README.md', '# Docs\n\nSee [usage](usage.md) for details.');
    await writeFixture(tmpDir, 'docs/usage.md', '# Usage');
    const code = await runValidatorExitCode(tmpDir);
    assert.equal(code, 0);
  });

  it('fails with empty plan placeholder', async () => {
    await writeFixture(tmpDir, 'docs/guide.md', '# Guide\n\nSee [plan](.ai-factory/plans/.md)');
    const code = await runValidatorExitCode(tmpDir);
    assert.equal(code, 1);
  });

  it('passes with external links (ignored)', async () => {
    await writeFixture(tmpDir, 'docs/links.md', '# Links\n\n[GitHub](https://github.com)');
    const code = await runValidatorExitCode(tmpDir);
    assert.equal(code, 0);
  });

  it('passes with anchor-only links', async () => {
    await writeFixture(tmpDir, 'docs/page.md', '# Page\n\n[Section](#section)');
    const code = await runValidatorExitCode(tmpDir);
    assert.equal(code, 0);
  });

  it('fails with broken internal link', async () => {
    await writeFixture(tmpDir, 'docs/page.md', '# Page\n\nSee [missing](nonexistent.md) for details.');
    const code = await runValidatorExitCode(tmpDir);
    assert.equal(code, 1);
  });

  it('passes with no markdown files', async () => {
    const code = await runValidatorExitCode(tmpDir);
    assert.equal(code, 0);
  });
});
