// aifhub-mcp-contract.test.mjs - tests for the AIFHub MCP manifest and runtime guidance contract
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

async function readRepoFile(relPath) {
  return readFile(path.join(REPO_ROOT, relPath), 'utf8');
}

async function readJson(relPath) {
  return JSON.parse(await readRepoFile(relPath));
}

describe('AIFHub MCP extension contract', () => {
  it('publishes aifhub as an extension MCP server through ai-factory command dispatch', async () => {
    const manifest = await readJson('extension.json');
    const mcpServers = manifest.mcpServers || [];
    const aifhubServer = mcpServers.find((server) => server.key === 'aifhub');

    assert.ok(aifhubServer, 'extension.json must declare mcpServers entry with key "aifhub"');
    assert.deepEqual(aifhubServer.template, {
      command: 'ai-factory',
      args: ['aifhub-mcp']
    });
    assert.match(aifhubServer.instruction, /runtime-specific/i);
    assert.match(aifhubServer.instruction, /Universal \/ Other/, 'MCP instruction must name the Universal / Other runtime');
    assert.match(aifhubServer.instruction, /\.mcp\.json/, 'MCP instruction must name the Universal / Other .mcp.json path');
    assert.match(aifhubServer.instruction, /mcpServers/, 'MCP instruction must name the standard mcpServers key');
    assert.match(aifhubServer.instruction, /AI Factory 2\.16\+/, 'MCP instruction must gate Universal rendering at AI Factory 2.16+');
    assert.match(aifhubServer.instruction, /OpenCode/);
    assert.match(aifhubServer.instruction, /GitHub Copilot/);

    const command = (manifest.commands || []).find((entry) => entry.name === 'aifhub-mcp');
    assert.ok(command, 'extension.json must declare the aifhub-mcp command used by the MCP template');
    assert.equal(command.module, './commands/aifhub-mcp.mjs');
  });

  it('exposes the expected MCP tools from the server module', async () => {
    const { handleMcpMessage } = await import('../scripts/aifhub-mcp-server.mjs');

    const response = await handleMcpMessage({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list'
    });

    const toolNames = response.result.tools.map((tool) => tool.name).sort();
    assert.deepEqual(toolNames, [
      'context_dedup_purge',
      'context_dedup_status',
      'install_skill',
      'propose_skill_improvement',
      'read_file_deduplicated',
      'run_skill_tests',
      'search_skills'
    ]);
  });

  it('resolves and threads an explicit project root for the stdio server loop', async () => {
    const { startMcpServer } = await import('../scripts/aifhub-mcp-server.mjs');
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'aifhub-mcp-root-'));

    try {
      await mkdir(path.join(rootDir, '.ai-factory'), { recursive: true });
      await writeFile(
        path.join(rootDir, '.ai-factory', 'config.yaml'),
        'aifhub:\n  contextDedup:\n    mode: aifhub\n    minBytes: 16\n',
        'utf8'
      );
      const content = `${'project-root context\n'.repeat(20)}`;
      await writeFile(path.join(rootDir, 'notes.md'), content, 'utf8');

      const request = JSON.stringify({
        jsonrpc: '2.0',
        id: 10,
        method: 'tools/call',
        params: {
          name: 'read_file_deduplicated',
          arguments: { path: 'notes.md' }
        }
      });
      const chunks = [];

      await startMcpServer({
        input: Readable.from([`${request}\n`]),
        output: { write: (chunk) => chunks.push(String(chunk)) },
        env: { AIFHUB_PROJECT_ROOT: rootDir }
      });

      assert.equal(chunks.length, 1);
      const response = JSON.parse(chunks[0]);
      assert.equal(response.result.isError, undefined, JSON.stringify(response));
      assert.equal(response.result.content[0].text, content);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it('uses the connection project root for relative skill test paths', async () => {
    const { startMcpServer } = await import('../scripts/aifhub-mcp-server.mjs');
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'aifhub-mcp-skill-root-'));

    try {
      await mkdir(path.join(rootDir, 'skill', 'scripts'), { recursive: true });
      await writeFile(
        path.join(rootDir, 'skill', 'scripts', 'test.mjs'),
        "process.stdout.write('rooted skill test\\n');\n",
        'utf8'
      );
      const request = JSON.stringify({
        jsonrpc: '2.0',
        id: 11,
        method: 'tools/call',
        params: {
          name: 'run_skill_tests',
          arguments: { skillPath: 'skill' }
        }
      });
      const chunks = [];
      let runnerOptions;

      await startMcpServer({
        input: Readable.from([`${request}\n`]),
        output: { write: (chunk) => chunks.push(String(chunk)) },
        env: { AIFHUB_PROJECT_ROOT: rootDir },
        runner: async (_command, _args, options) => {
          runnerOptions = options;
          return { ok: true, code: 0, stdout: 'rooted skill test\n', stderr: '' };
        }
      });

      assert.equal(chunks.length, 1);
      const response = JSON.parse(chunks[0]);
      assert.equal(response.result.isError, undefined, JSON.stringify(response));
      const payload = JSON.parse(response.result.content[0].text);
      assert.equal(payload.skillPath, path.join(rootDir, 'skill'));
      assert.equal(payload.exitCode, 0);
      assert.equal(payload.stdout, 'rooted skill test\n');
      assert.equal(runnerOptions.cwd, path.join(rootDir, 'skill'));
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it('returns full content first and a replay summary for repeated dedup reads', async () => {
    const { handleMcpMessage } = await import('../scripts/aifhub-mcp-server.mjs');
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'aifhub-mcp-dedup-'));

    try {
      await mkdir(path.join(rootDir, '.ai-factory'), { recursive: true });
      await writeFile(
        path.join(rootDir, '.ai-factory', 'config.yaml'),
        'aifhub:\n  contextDedup:\n    enabled: true\n    minBytes: 16\n',
        'utf8'
      );
      const content = `${'dedupe me\n'.repeat(50)}`;
      await writeFile(path.join(rootDir, 'notes.md'), content, 'utf8');

      const call = async (name, args) => handleMcpMessage(
        { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } },
        { cwd: rootDir }
      );

      const options = { cwd: rootDir, mcpSessionId: 'mcp-test-session' };
      const scopedCall = async (name, args) => handleMcpMessage(
        { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } },
        options
      );

      const first = await scopedCall('read_file_deduplicated', { path: 'notes.md' });
      assert.equal(first.result.content[0].text, content);

      const second = await scopedCall('read_file_deduplicated', { path: 'notes.md' });
      assert.match(second.result.content[0].text, /already provided in this session/);
      assert.doesNotMatch(second.result.content[0].text, /ai-factory .*--file/);

      const status = await scopedCall('context_dedup_status', {});
      const statusPayload = JSON.parse(status.result.content[0].text);
      assert.equal(statusPayload.dedupHits, 1);
      assert.equal(
        statusPayload.observedBytes,
        statusPayload.servedBytes + statusPayload.savedBytes,
        'MCP status must expose net model-visible byte accounting'
      );
      assert.equal(statusPayload.ledgerPath, undefined);
      assert.equal(statusPayload.sessionId, undefined);
      assert.doesNotMatch(status.result.content[0].text, new RegExp(rootDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

      const preview = await scopedCall('context_dedup_purge', {});
      assert.equal(JSON.parse(preview.result.content[0].text).dryRun, true);
      assert.equal((await scopedCall('context_dedup_status', {})).result.content[0].text, status.result.content[0].text);

      const purge = await scopedCall('context_dedup_purge', { confirm: true });
      assert.equal(JSON.parse(purge.result.content[0].text).scope, 'current-mcp-session');
      assert.equal(JSON.parse((await scopedCall('context_dedup_status', {})).result.content[0].text).reads, 0);

      const otherSession = await handleMcpMessage(
        { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'read_file_deduplicated', arguments: { path: 'notes.md' } } },
        { cwd: rootDir, mcpSessionId: 'mcp-other-session' }
      );
      assert.equal(otherSession.result.content[0].text, content);

      const crafted = await scopedCall('context_dedup_purge', { all: true });
      assert.equal(crafted.result.isError, true);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it('dispatches SQZ mode through a bounded injected runner and keeps protected reads full', async () => {
    const { handleMcpMessage } = await import('../scripts/aifhub-mcp-server.mjs');
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'aifhub-mcp-sqz-'));

    try {
      await mkdir(path.join(rootDir, '.ai-factory'), { recursive: true });
      await mkdir(path.join(rootDir, 'openspec', 'specs', 'auth'), { recursive: true });
      await writeFile(
        path.join(rootDir, '.ai-factory', 'config.yaml'),
        'aifhub:\n  contextDedup:\n    mode: sqz\n    minBytes: 16\n',
        'utf8'
      );
      const content = `${'compressible context\n'.repeat(50)}`;
      await writeFile(path.join(rootDir, 'notes.md'), content, 'utf8');
      await writeFile(path.join(rootDir, 'openspec', 'specs', 'auth', 'spec.md'), content, 'utf8');

      let calls = 0;
      const options = {
        cwd: rootDir,
        mcpSessionId: 'mcp-sqz-session',
        sqzRunner: async () => {
          calls += 1;
          return { ok: true, stdout: 'compact\n' };
        }
      };
      const call = async (pathValue) => handleMcpMessage(
        {
          jsonrpc: '2.0',
          id: 6,
          method: 'tools/call',
          params: { name: 'read_file_deduplicated', arguments: { path: pathValue } }
        },
        options
      );

      const first = await call('notes.md');
      const second = await call('notes.md');
      const protectedRead = await call('openspec/specs/auth/spec.md');
      const status = await handleMcpMessage(
        {
          jsonrpc: '2.0',
          id: 7,
          method: 'tools/call',
          params: { name: 'context_dedup_status', arguments: {} }
        },
        options
      );
      const statusPayload = JSON.parse(status.result.content[0].text);

      assert.equal(first.result.content[0].text, 'compact\n');
      assert.match(second.result.content[0].text, /already provided in this session/);
      assert.equal(protectedRead.result.content[0].text, content);
      assert.equal(calls, 1);
      assert.equal(statusPayload.mode, 'sqz');
      assert.equal(statusPayload.dedupHits, 1);
      assert.equal(statusPayload.observedBytes, statusPayload.servedBytes + statusPayload.savedBytes);
      assert.match(first.result.content[1].text, /context-dedup-sqz-external-tool/);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it('serves full MCP content when SQZ fails without exposing raw stderr', async () => {
    const { handleMcpMessage } = await import('../scripts/aifhub-mcp-server.mjs');
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'aifhub-mcp-sqz-fail-'));

    try {
      await mkdir(path.join(rootDir, '.ai-factory'), { recursive: true });
      await writeFile(
        path.join(rootDir, '.ai-factory', 'config.yaml'),
        'aifhub:\n  contextDedup:\n    mode: sqz\n    minBytes: 1\n',
        'utf8'
      );
      const content = 'full content must survive provider failure\n';
      await writeFile(path.join(rootDir, 'notes.md'), content, 'utf8');

      const response = await handleMcpMessage(
        {
          jsonrpc: '2.0',
          id: 8,
          method: 'tools/call',
          params: { name: 'read_file_deduplicated', arguments: { path: 'notes.md' } }
        },
        {
          cwd: rootDir,
          mcpSessionId: 'mcp-sqz-failure',
          sqzRunner: async () => ({
            ok: false,
            code: 'spawn-error',
            stderr: 'OPENAI_API_KEY=must-not-leak C:\\private\\sqz.exe'
          })
        }
      );

      assert.equal(response.result.content[0].text, content);
      assert.match(response.result.content[1].text, /context-dedup-sqz-unavailable/);
      assert.doesNotMatch(JSON.stringify(response), /must-not-leak|C:\\\\private/);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it('publishes bounded session-owned schemas and surfaces config diagnostics', async () => {
    const { handleMcpMessage } = await import('../scripts/aifhub-mcp-server.mjs');
    const listed = await handleMcpMessage({ jsonrpc: '2.0', id: 4, method: 'tools/list' });
    const tools = Object.fromEntries(listed.result.tools.map((tool) => [tool.name, tool]));

    assert.deepEqual(Object.keys(tools.read_file_deduplicated.inputSchema.properties).sort(), ['force', 'path']);
    assert.deepEqual(tools.context_dedup_status.inputSchema.properties, {});
    assert.deepEqual(Object.keys(tools.context_dedup_purge.inputSchema.properties), ['confirm']);
    assert.equal(tools.context_dedup_purge.annotations, undefined);

    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'aifhub-mcp-diagnostics-'));
    try {
      await mkdir(path.join(rootDir, '.ai-factory'), { recursive: true });
      await writeFile(
        path.join(rootDir, '.ai-factory', 'config.yaml'),
        'aifhub:\n  contextDedup:\n    enabled: sometimes\n',
        'utf8'
      );
      await writeFile(path.join(rootDir, 'small.md'), 'safe text\n', 'utf8');
      await writeFile(path.join(rootDir, 'large.md'), 'x'.repeat((1024 * 1024) + 1), 'utf8');

      const call = async (pathValue) => handleMcpMessage(
        { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'read_file_deduplicated', arguments: { path: pathValue } } },
        { cwd: rootDir, mcpSessionId: 'mcp-bounds' }
      );
      const diagnostic = await call('small.md');
      assert.equal(diagnostic.result.content[0].text, 'safe text\n');
      assert.match(diagnostic.result.content[1].text, /context-dedup-malformed-value/);

      const bounded = await call('large.md');
      assert.equal(bounded.result.isError, true);
      assert.match(bounded.result.content[0].text, /1 MiB/);
      assert.doesNotMatch(bounded.result.content[0].text, /xxxxx/);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it('continues bounded reads after short filesystem chunks until EOF', async () => {
    const { handleMcpMessage } = await import('../scripts/aifhub-mcp-server.mjs');
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'aifhub-mcp-short-read-'));
    const expected = 'short chunks still produce the complete file\n';
    const source = Buffer.from(expected);
    let sourceOffset = 0;

    try {
      await writeFile(path.join(rootDir, 'notes.md'), expected, 'utf8');
      const openFile = async () => ({
        read: async (buffer, bufferOffset, length) => {
          if (sourceOffset >= source.length) return { bytesRead: 0, buffer };
          const chunk = source.subarray(sourceOffset, sourceOffset + Math.min(2, length));
          chunk.copy(buffer, bufferOffset);
          sourceOffset += chunk.length;
          return { bytesRead: chunk.length, buffer };
        },
        close: async () => {}
      });

      const response = await handleMcpMessage(
        {
          jsonrpc: '2.0',
          id: 6,
          method: 'tools/call',
          params: { name: 'read_file_deduplicated', arguments: { path: 'notes.md' } }
        },
        { cwd: rootDir, mcpSessionId: 'mcp-short-read', openFile }
      );
      assert.equal(response.result.content[0].text, expected);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it('documents version-gated Universal MCP configuration alongside runtime-specific formats', async () => {
    const docs = await readRepoFile('docs/aifhub-mcp.md');

    for (const [expected, label] of [
      ['aifhub.search_skills', 'search tool'],
      ['aifhub.install_skill', 'install tool'],
      ['aifhub.run_skill_tests', 'test tool'],
      ['aifhub.propose_skill_improvement', 'improvement proposal tool'],
      ['aifhub.read_file_deduplicated', 'session dedup read tool'],
      ['aifhub.context_dedup_status', 'session dedup status tool'],
      ['aifhub.context_dedup_purge', 'session dedup purge tool'],
      ['Universal / Other', 'Universal / Other runtime'],
      ['.mcp.json', 'Universal / Other .mcp.json path'],
      ['mcpServers', 'standard mcpServers key'],
      ['AI Factory `2.16+`', 'AI Factory 2.16+ version boundary'],
      ['AI Factory `2.11`-`2.15`', 'unsupported pre-2.16 version boundary'],
      ['OpenCode', 'OpenCode runtime'],
      ['type: "local"', 'OpenCode local transport'],
      ['GitHub Copilot', 'GitHub Copilot runtime'],
      ['servers', 'GitHub Copilot servers key'],
      ['type: "stdio"', 'GitHub Copilot stdio transport']
    ]) {
      assert.match(
        docs,
        new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
        `MCP docs must include ${label}`
      );
    }
  });
});
