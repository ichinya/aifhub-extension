// agentmemory-ai-tester-adapter.test.mjs - isolated AgentMemory benchmark safety contracts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import {
  AGENTMEMORY_MCP_VERSION,
  AGENTMEMORY_INSTALL_TIMEOUT_MS,
  buildPinnedInstallInvocation,
  buildIsolatedProviderEnv,
  resolveConfinedPath
} from './agentmemory-ai-tester-adapter.mjs';

describe('AgentMemory ai-tester adapter safety boundary', () => {
  it('pins the provider package used by the authored ai-tester scenario', () => {
    assert.equal(AGENTMEMORY_MCP_VERSION, '0.9.28');
    assert.equal(AGENTMEMORY_INSTALL_TIMEOUT_MS, 300000);
  });

  it('accepts only descendants of the ai-tester project root', () => {
    const projectRoot = path.resolve('C:/fixtures/sanitized-project');

    assert.equal(
      resolveConfinedPath(projectRoot, '.ai-tester-agentmemory', 'sandbox root'),
      path.join(projectRoot, '.ai-tester-agentmemory')
    );
    assert.throws(
      () => resolveConfinedPath(projectRoot, '..', 'sandbox root'),
      /sandbox root must stay inside the ai-tester project root/
    );
    assert.throws(
      () => resolveConfinedPath(projectRoot, '.', 'sandbox root'),
      /sandbox root must stay inside the ai-tester project root/
    );
  });

  it('builds a minimal isolated environment without inherited credentials', () => {
    const sandboxRoot = path.resolve('C:/fixtures/sanitized-project/.ai-tester-agentmemory');
    const storePath = path.join(sandboxRoot, 'stores', 'continuity.json');
    const env = buildIsolatedProviderEnv({
      sandboxRoot,
      storePath,
      baseEnv: {
        PATH: 'C:\\Windows\\System32',
        SystemRoot: 'C:\\Windows',
        TEMP: 'C:\\Temp',
        OPENAI_API_KEY: 'must-not-pass-through',
        GITHUB_TOKEN: 'must-not-pass-through',
        AGENTMEMORY_FORCE_PROXY: '1',
        AGENTMEMORY_URL: 'https://private.example'
      }
    });

    assert.equal(env.PATH, 'C:\\Windows\\System32');
    assert.equal(env.SystemRoot, 'C:\\Windows');
    assert.equal(env.OPENAI_API_KEY, undefined);
    assert.equal(env.GITHUB_TOKEN, undefined);
    assert.equal(env.AGENTMEMORY_FORCE_PROXY, undefined);
    assert.equal(env.AGENTMEMORY_URL, 'http://127.0.0.1:1');
    assert.equal(env.AGENTMEMORY_PROBE_TIMEOUT_MS, '50');
    assert.equal(env.STANDALONE_PERSIST_PATH, storePath);
    assert.equal(env.CI, '1');
    assert.equal(env.NO_COLOR, '1');

    for (const key of [
      'HOME',
      'USERPROFILE',
      'APPDATA',
      'LOCALAPPDATA',
      'XDG_CONFIG_HOME',
      'XDG_DATA_HOME'
    ]) {
      const relative = path.relative(sandboxRoot, env[key]);
      assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), `${key} must be isolated`);
    }
  });

  it('installs only the pinned package with lifecycle scripts disabled', () => {
    const packageRoot = path.resolve('C:/fixtures/sanitized-project/.ai-tester-tools/agentmemory');
    const sandboxRoot = path.resolve('C:/fixtures/sanitized-project/.ai-tester-agentmemory');
    const invocation = buildPinnedInstallInvocation({
      packageRoot,
      sandboxRoot,
      npmCliPath: path.resolve('C:/runtime/npm-cli.js'),
      baseEnv: { PATH: 'C:\\Windows\\System32', OPENAI_API_KEY: 'must-not-pass-through' }
    });

    assert.equal(invocation.command, process.execPath);
    assert.deepEqual(invocation.args, [
      path.resolve('C:/runtime/npm-cli.js'),
      'install',
      '--prefix',
      packageRoot,
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '@agentmemory/mcp@0.9.28'
    ]);
    assert.equal(invocation.env.OPENAI_API_KEY, undefined);
    assert.equal(invocation.env.npm_config_ignore_scripts, 'true');
    assert.equal(invocation.env.npm_config_audit, 'false');
    assert.equal(invocation.env.npm_config_fund, 'false');
  });
});
