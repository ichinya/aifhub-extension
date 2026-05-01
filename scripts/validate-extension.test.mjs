// validate-extension.test.mjs - tests for extension manifest and AIFHub metadata validator
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm, readFile } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

const UPSTREAM_SCHEMA_URL = 'https://raw.githubusercontent.com/lee-to/ai-factory/2.x/schemas/extension.schema.json';
const AIFHUB_SCHEMA_PATH = './schemas/aifhub-extension.schema.json';

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
    $schema: UPSTREAM_SCHEMA_URL,
    name: 'test-ext',
    version: '1.0.0',
    description: 'test',
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

function validAifhubMetadata(extra = {}) {
  return JSON.stringify({
    $schema: AIFHUB_SCHEMA_PATH,
    compat: { 'ai-factory': '>=2.11.0 <3.0.0' },
    sources: {
      'ai-factory': {
        url: 'https://github.com/lee-to/ai-factory',
        version: '2.11.0',
        baselineVersion: '2.11.0',
        lastSync: '2026-05-01',
        notes: 'Validated against upstream 2.11.0.'
      },
      openspec: {
        url: 'https://github.com/Fission-AI/OpenSpec',
        version: '1.3.1',
        supportedRange: '>=1.3.1 <2.0.0',
        lastSync: '2026-04-25',
        optional: true,
        requiresNode: '>=20.19.0',
        mode: 'optional-cli-adapter',
        notes: 'OpenSpec is used as an optional artifact protocol.'
      }
    },
    ...extra
  });
}

async function writeValidProject({
  manifest = validManifest(),
  metadata = validAifhubMetadata(),
  includeMetadataSchema = true,
  includeExtensionSchema = true
} = {}) {
  await writeFixture(tmpDir, 'extension.json', manifest);
  if (metadata !== null) {
    await writeFixture(tmpDir, 'aifhub-extension.json', metadata);
  }
  if (includeExtensionSchema) {
    const schema = await readFile(join(REPO_ROOT, 'schemas/extension.schema.json'), 'utf-8');
    await writeFixture(tmpDir, 'schemas/extension.schema.json', schema);
  }
  if (includeMetadataSchema) {
    const schema = await readFile(join(REPO_ROOT, 'schemas/aifhub-extension.schema.json'), 'utf-8');
    await writeFixture(tmpDir, 'schemas/aifhub-extension.schema.json', schema);
  }
  await writeFixture(tmpDir, 'skills/aif-analyze/SKILL.md', '# test');
  await writeFixture(tmpDir, 'agent-files/codex/test.toml', 'name = "test"');
  await writeFixture(tmpDir, 'injections/core/test.md', '# test');
}

describe('validate-extension.mjs', () => {
  it('passes with upstream extension manifest, AIFHub metadata, and all files present', async () => {
    await writeValidProject();

    const code = await runValidatorExitCode(tmpDir);
    assert.equal(code, 0);
  });

  it('fails when extension.json contains private AIFHub metadata', async () => {
    const metadata = JSON.parse(validAifhubMetadata());
    const manifest = JSON.stringify({
      ...JSON.parse(validManifest()),
      compat: metadata.compat,
      sources: metadata.sources
    });
    await writeValidProject({ manifest });

    const code = await runValidatorExitCode(tmpDir);
    assert.equal(code, 1);
  });

  it('fails with missing aifhub-extension.json', async () => {
    await writeValidProject({ metadata: null });

    const code = await runValidatorExitCode(tmpDir);
    assert.equal(code, 1);
  });

  it('fails with missing AIFHub metadata schema file', async () => {
    await writeValidProject({ includeMetadataSchema: false });

    const code = await runValidatorExitCode(tmpDir);
    assert.equal(code, 1);
  });

  it('fails when extension.json violates the upstream schema', async () => {
    const parsed = JSON.parse(validManifest());
    parsed.injections = [{ target: 'aif-plan', position: 'middle', file: './injections/core/test.md' }];
    await writeValidProject({ manifest: JSON.stringify(parsed) });

    const code = await runValidatorExitCode(tmpDir);
    assert.equal(code, 1);
  });

  it('fails with missing skill path', async () => {
    const parsed = JSON.parse(validManifest());
    parsed.skills = ['skills/nonexistent'];
    await writeValidProject({ manifest: JSON.stringify(parsed) });

    const code = await runValidatorExitCode(tmpDir);
    assert.equal(code, 1);
  });

  it('fails with missing injection file', async () => {
    const parsed = JSON.parse(validManifest());
    parsed.injections = [{ target: 'aif-plan', position: 'prepend', file: './injections/core/missing.md' }];
    await writeValidProject({ manifest: JSON.stringify(parsed) });

    const code = await runValidatorExitCode(tmpDir);
    assert.equal(code, 1);
  });

  it('fails with missing command module file', async () => {
    const parsed = JSON.parse(validManifest());
    parsed.commands = [{ name: 'aifhub-mcp', description: 'AIFHub MCP server', module: './commands/missing.mjs' }];
    await writeValidProject({ manifest: JSON.stringify(parsed) });

    const code = await runValidatorExitCode(tmpDir);
    assert.equal(code, 1);
  });

  it('fails when an MCP server template contains runtime-specific fields', async () => {
    const parsed = JSON.parse(validManifest());
    parsed.mcpServers = [
      {
        key: 'aifhub',
        template: {
          type: 'local',
          command: ['ai-factory', 'aifhub-mcp']
        }
      }
    ];
    await writeValidProject({ manifest: JSON.stringify(parsed) });

    const code = await runValidatorExitCode(tmpDir);
    assert.equal(code, 1);
  });

  it('passes with a valid extension MCP server template', async () => {
    const parsed = JSON.parse(validManifest());
    parsed.commands = [
      { name: 'aifhub-mcp', description: 'AIFHub MCP server', module: './commands/aifhub-mcp.mjs' }
    ];
    parsed.mcpServers = [
      {
        key: 'aifhub',
        template: {
          command: 'ai-factory',
          args: ['aifhub-mcp']
        },
        instruction: 'Runtime-specific configuration is rendered by AI Factory.'
      }
    ];
    await writeValidProject({ manifest: JSON.stringify(parsed) });
    await writeFixture(tmpDir, 'commands/aifhub-mcp.mjs', 'export function register() {}');

    const code = await runValidatorExitCode(tmpDir);
    assert.equal(code, 0);
  });

  it('fails with invalid semver version', async () => {
    const parsed = JSON.parse(validManifest());
    parsed.version = 'not-semver';
    await writeValidProject({ manifest: JSON.stringify(parsed) });

    const code = await runValidatorExitCode(tmpDir);
    assert.equal(code, 1);
  });

  it('fails with missing compat field in AIFHub metadata', async () => {
    const parsed = JSON.parse(validAifhubMetadata());
    delete parsed.compat;
    await writeValidProject({ metadata: JSON.stringify(parsed) });

    const code = await runValidatorExitCode(tmpDir);
    assert.equal(code, 1);
  });

  it('fails with missing sources field in AIFHub metadata', async () => {
    const parsed = JSON.parse(validAifhubMetadata());
    delete parsed.sources;
    await writeValidProject({ metadata: JSON.stringify(parsed) });

    const code = await runValidatorExitCode(tmpDir);
    assert.equal(code, 1);
  });

  it('fails when AIFHub metadata violates the local schema', async () => {
    const parsed = JSON.parse(validAifhubMetadata());
    parsed.sources['ai-factory'].notes = 42;
    await writeValidProject({ metadata: JSON.stringify(parsed) });

    const code = await runValidatorExitCode(tmpDir);
    assert.equal(code, 1);
  });

  it('fails with non-.toml agentFile target for codex runtime', async () => {
    const parsed = JSON.parse(validManifest());
    parsed.agentFiles[0].target = 'test.yaml';
    await writeValidProject({ manifest: JSON.stringify(parsed) });

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
    await writeValidProject({ manifest });
    await writeFixture(tmpDir, 'agent-files/claude/test.md', '---\nname: test\ndescription: test\ntools: Read\nmodel: inherit\nmaxTurns: 6\n---\n# test');

    const code = await runValidatorExitCode(tmpDir);
    assert.equal(code, 0);
  });

  it('fails with non-.md agentFile target for claude runtime', async () => {
    const manifest = validManifest({
      agentFiles: [
        { runtime: 'claude', source: './agent-files/claude/test.toml', target: 'test.toml' }
      ]
    });
    await writeValidProject({ manifest });
    await writeFixture(tmpDir, 'agent-files/claude/test.toml', 'name = "test"');

    const code = await runValidatorExitCode(tmpDir);
    assert.equal(code, 1);
  });

  it('fails with unknown agentFile runtime', async () => {
    const manifest = validManifest({
      agentFiles: [
        { runtime: 'unknown', source: './agent-files/codex/test.toml', target: 'test.toml' }
      ]
    });
    await writeValidProject({ manifest });

    const code = await runValidatorExitCode(tmpDir);
    assert.equal(code, 1);
  });

  it('fails with path traversal in skill path', async () => {
    const parsed = JSON.parse(validManifest());
    parsed.skills = ['../../etc/passwd'];
    await writeValidProject({ manifest: JSON.stringify(parsed) });

    const code = await runValidatorExitCode(tmpDir);
    assert.equal(code, 1);
  });
});
