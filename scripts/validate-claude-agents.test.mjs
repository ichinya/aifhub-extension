// validate-claude-agents.test.mjs — tests for Claude agent frontmatter validator
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm, symlink } from 'node:fs/promises';
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
  tmpDir = await mkdtemp(join(tmpdir(), 'validate-claude-test-'));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

async function runValidatorExitCode(cwd) {
  try {
    await execFileAsync('node', [
      join(__dirname, 'validate-claude-agents.mjs')
    ], { cwd, timeout: 10000 });
    return 0;
  } catch (err) {
    return err.code || 1;
  }
}

const VALID_MD = `---
name: aifhub-test-agent
description: A test agent
tools: Read, Glob
model: inherit
maxTurns: 6
---

You are a test agent.
`;

const MISSING_NAME_MD = `---
description: No name agent
tools: Read
model: inherit
maxTurns: 6
---

You are a test agent.
`;

const MISSING_DESCRIPTION_MD = `---
name: aifhub-no-desc
tools: Read
model: inherit
maxTurns: 6
---

You are a test agent.
`;

const NO_FRONTMATTER_MD = `You are a test agent with no frontmatter.
`;

const NON_NAMESPACED_MD = `---
name: generic-agent
description: Not namespaced
tools: Read
model: inherit
maxTurns: 6
---

You are a generic agent.
`;

async function writeFixture(dir, relPath, content) {
  const fullPath = join(dir, relPath);
  await mkdir(join(fullPath, '..'), { recursive: true });
  await writeFile(fullPath, content, 'utf-8');
}

describe('validate-claude-agents.mjs', () => {
  it('passes with valid frontmatter agent file', async () => {
    await writeFixture(tmpDir, 'agent-files/claude/valid.md', VALID_MD);
    const code = await runValidatorExitCode(tmpDir);
    assert.equal(code, 0);
  });

  it('fails when name is missing', async () => {
    await writeFixture(tmpDir, 'agent-files/claude/no-name.md', MISSING_NAME_MD);
    const code = await runValidatorExitCode(tmpDir);
    assert.equal(code, 1);
  });

  it('fails when description is missing', async () => {
    await writeFixture(tmpDir, 'agent-files/claude/no-desc.md', MISSING_DESCRIPTION_MD);
    const code = await runValidatorExitCode(tmpDir);
    assert.equal(code, 1);
  });

  it('fails when frontmatter is missing', async () => {
    await writeFixture(tmpDir, 'agent-files/claude/no-frontmatter.md', NO_FRONTMATTER_MD);
    const code = await runValidatorExitCode(tmpDir);
    assert.equal(code, 1);
  });

  it('passes with warning for non-namespaced agent', async () => {
    await writeFixture(tmpDir, 'agent-files/claude/generic.md', NON_NAMESPACED_MD);
    const code = await runValidatorExitCode(tmpDir);
    assert.equal(code, 0);
  });

  it('fails when claude directory does not exist', async () => {
    const code = await runValidatorExitCode(tmpDir);
    assert.equal(code, 1);
  });

  it('skips .git and node_modules directories', async () => {
    await writeFixture(tmpDir, 'agent-files/claude/valid.md', VALID_MD);
    await writeFixture(tmpDir, 'agent-files/claude/.git/bad.md', 'no frontmatter');
    await writeFixture(tmpDir, 'agent-files/claude/node_modules/bad.md', 'no frontmatter');

    const code = await runValidatorExitCode(tmpDir);
    assert.equal(code, 0);
  });

  it('skips symlinked directories to prevent infinite recursion', async () => {
    await writeFixture(tmpDir, 'agent-files/claude/valid.md', VALID_MD);
    await mkdir(join(tmpDir, 'agent-files/claude/subdir'), { recursive: true });
    try {
      await symlink(join(tmpDir, 'agent-files/claude'), join(tmpDir, 'agent-files/claude/subdir/loop'), 'junction');
    } catch {
      return;
    }

    const code = await runValidatorExitCode(tmpDir);
    assert.equal(code, 0);
  });
});
