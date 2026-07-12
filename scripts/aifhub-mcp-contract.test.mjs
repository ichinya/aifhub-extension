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
      'install_skill',
      'propose_skill_improvement',
      'run_skill_tests',
      'search_skills'
    ]);
  });

  it('documents version-gated Universal MCP configuration alongside runtime-specific formats', async () => {
    const docs = await readRepoFile('docs/aifhub-mcp.md');

    for (const [expected, label] of [
      ['aifhub.search_skills', 'search tool'],
      ['aifhub.install_skill', 'install tool'],
      ['aifhub.run_skill_tests', 'test tool'],
      ['aifhub.propose_skill_improvement', 'improvement proposal tool'],
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
