// aifhub-mcp-contract.test.mjs - tests for the AIFHub MCP manifest and runtime guidance contract
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
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
      'install_skill',
      'propose_skill_improvement',
      'run_skill_tests',
      'search_skills'
    ]);
  });

  it('documents runtime-specific MCP configuration without a universal mcpServers example', async () => {
    const docs = await readRepoFile('docs/aifhub-mcp.md');

    for (const expected of [
      'aifhub.search_skills',
      'aifhub.install_skill',
      'aifhub.run_skill_tests',
      'aifhub.propose_skill_improvement',
      'mcpServers',
      'OpenCode',
      'type: "local"',
      'GitHub Copilot',
      'servers',
      'type: "stdio"'
    ]) {
      assert.match(docs, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }

    assert.doesNotMatch(
      docs,
      /mcpServers[^.\n]*(all|every|any|universal)[^.\n]*(agent|runtime|client)|(?:all|every|any|universal)[^.\n]*(agent|runtime|client)[^.\n]*mcpServers/i
    );
  });
});
