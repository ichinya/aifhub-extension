// validate-codex-agents.test.mjs — tests for Codex agent TOML validator
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
  tmpDir = await mkdtemp(join(tmpdir(), 'validate-codex-test-'));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

async function runValidatorExitCode(cwd) {
  try {
    await execFileAsync('node', [
      join(__dirname, 'validate-codex-agents.mjs')
    ], { cwd, timeout: 10000 });
    return 0;
  } catch (err) {
    return err.code || 1;
  }
}

const VALID_TOML = `name = "test-agent"
description = "A test agent"
sandbox_mode = "workspace-write"
developer_instructions = \"\"\"
Do things.
\"\"\"
`;

const MISSING_NAME_TOML = `description = "No name agent"
sandbox_mode = "workspace-write"
developer_instructions = \"\"\"
Do things.
\"\"\"
`;

const LEGACY_PROMPT_TOML = `name = "legacy-prompt"
description = "Has legacy prompt"
sandbox_mode = "workspace-write"
developer_instructions = \"\"\"
Do things.
\"\"\"
prompt = "Old prompt style"
`;

const LEGACY_REASONING_TOML = `name = "legacy-reasoning"
description = "Has legacy reasoning_effort"
sandbox_mode = "workspace-write"
developer_instructions = \"\"\"
Do things.
\"\"\"
reasoning_effort = "high"
`;

const MISSING_SANDBOX_TOML = `name = "no-sandbox"
description = "Missing sandbox_mode"
developer_instructions = \"\"\"
Do things.
\"\"\"
`;

async function writeFixture(dir, relPath, content) {
  const fullPath = join(dir, relPath);
  await mkdir(join(fullPath, '..'), { recursive: true });
  await writeFile(fullPath, content, 'utf-8');
}

describe('validate-codex-agents.mjs', () => {
  it('passes with valid TOML agent file', async () => {
    await writeFixture(tmpDir, 'agent-files/codex/valid.toml', VALID_TOML);
    const code = await runValidatorExitCode(tmpDir);
    assert.equal(code, 0);
  });

  it('fails when name is missing', async () => {
    await writeFixture(tmpDir, 'agent-files/codex/no-name.toml', MISSING_NAME_TOML);
    const code = await runValidatorExitCode(tmpDir);
    assert.equal(code, 1);
  });

  it('fails when legacy prompt field is present', async () => {
    await writeFixture(tmpDir, 'agent-files/codex/legacy-prompt.toml', LEGACY_PROMPT_TOML);
    const code = await runValidatorExitCode(tmpDir);
    assert.equal(code, 1);
  });

  it('fails when legacy reasoning_effort field is present', async () => {
    await writeFixture(tmpDir, 'agent-files/codex/legacy-reasoning.toml', LEGACY_REASONING_TOML);
    const code = await runValidatorExitCode(tmpDir);
    assert.equal(code, 1);
  });

  it('fails when sandbox_mode is missing', async () => {
    await writeFixture(tmpDir, 'agent-files/codex/no-sandbox.toml', MISSING_SANDBOX_TOML);
    const code = await runValidatorExitCode(tmpDir);
    assert.equal(code, 1);
  });

  it('fails when codex directory does not exist', async () => {
    const code = await runValidatorExitCode(tmpDir);
    assert.equal(code, 1);
  });

  it('skips .git and node_modules directories', async () => {
    // Valid agent in the expected location
    await writeFixture(tmpDir, 'agent-files/codex/valid.toml', VALID_TOML);
    // Invalid TOML in .git — must be skipped
    await writeFixture(tmpDir, 'agent-files/codex/.git/bad.toml', 'bad = "no-required-fields"');
    // Invalid TOML in node_modules — must be skipped
    await writeFixture(tmpDir, 'agent-files/codex/node_modules/bad.toml', 'bad = "no-required-fields"');

    const code = await runValidatorExitCode(tmpDir);
    assert.equal(code, 0);
  });

  it('skips symlinked directories to prevent infinite recursion', async () => {
    await writeFixture(tmpDir, 'agent-files/codex/valid.toml', VALID_TOML);
    // Create a subdirectory and symlink it back to parent (would cause infinite loop without protection)
    await mkdir(join(tmpDir, 'agent-files/codex/subdir'), { recursive: true });
    try {
      await symlink(join(tmpDir, 'agent-files/codex'), join(tmpDir, 'agent-files/codex/subdir/loop'), 'junction');
    } catch {
      // Symlink creation may fail on some platforms — skip test in that case
      return;
    }

    const code = await runValidatorExitCode(tmpDir);
    assert.equal(code, 0);
  });
});
