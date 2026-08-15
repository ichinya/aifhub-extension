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

const VALID_LEGACY_ULTRA_IMPLEMENTER_MD = `---
name: aifhub-implement-worker
description: Contract fixture
tools: Read, Write
model: inherit
maxTurns: 6
---

## Legacy AI Factory-only mode

Before task discovery or any write, classify the entrypoint marker-first with \`classifyLegacyPlanShape()\`.
For \`ultra-valid\`, return exactly \`/aif-implement <entrypoint>\` and stop.
Never write an ultra bundle, companion, status, or QA artifact.
Fail \`ultra-invalid\` and \`collision\` closed without classic fallback.
`;

const BROKEN_LEGACY_ULTRA_IMPLEMENTER_MD = VALID_LEGACY_ULTRA_IMPLEMENTER_MD
  .replace('/aif-implement <entrypoint>', '/aif-implement <plan-id>');

const VALID_EXTENSION_JSON = JSON.stringify({
  agentFiles: [{
    runtime: 'claude',
    source: './agent-files/claude/aifhub-test-agent.md',
    target: 'aifhub-test-agent.md'
  }]
}, null, 2);

const NON_NAMESPACED_TARGET_EXTENSION_JSON = JSON.stringify({
  agentFiles: [{
    runtime: 'claude',
    source: './agent-files/claude/aifhub-test-agent.md',
    target: 'test-agent.md'
  }]
}, null, 2);

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

  it('fails for non-namespaced agent frontmatter', async () => {
    await writeFixture(tmpDir, 'agent-files/claude/generic.md', NON_NAMESPACED_MD);
    const code = await runValidatorExitCode(tmpDir);
    assert.equal(code, 1);
  });

  it('passes a complete packaged-agent legacy ultra instruction contract', async () => {
    await writeFixture(tmpDir, 'agent-files/claude/aifhub-implement-worker.md', VALID_LEGACY_ULTRA_IMPLEMENTER_MD);
    const code = await runValidatorExitCode(tmpDir);
    assert.equal(code, 0);
  });

  it('fails a packaged agent with a non-exact legacy ultra handoff', async () => {
    await writeFixture(tmpDir, 'agent-files/claude/aifhub-implement-worker.md', BROKEN_LEGACY_ULTRA_IMPLEMENTER_MD);
    const code = await runValidatorExitCode(tmpDir);
    assert.equal(code, 1);
  });

  it('validates namespaced Claude manifest targets when extension.json exists', async () => {
    await writeFixture(tmpDir, 'agent-files/claude/valid.md', VALID_MD);
    await writeFixture(tmpDir, 'extension.json', VALID_EXTENSION_JSON);
    const code = await runValidatorExitCode(tmpDir);
    assert.equal(code, 0);
  });

  it('fails for non-namespaced Claude manifest targets', async () => {
    await writeFixture(tmpDir, 'agent-files/claude/valid.md', VALID_MD);
    await writeFixture(tmpDir, 'extension.json', NON_NAMESPACED_TARGET_EXTENSION_JSON);
    const code = await runValidatorExitCode(tmpDir);
    assert.equal(code, 1);
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
