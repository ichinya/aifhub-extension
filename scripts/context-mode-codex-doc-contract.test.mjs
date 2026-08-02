// context-mode-codex-doc-contract.test.mjs - append-only policy contracts for issue #134
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';

const ROOT = process.cwd();
const readDoc = (relativePath) => readFile(path.join(ROOT, relativePath), 'utf8');

describe('context-mode Codex documentation policy', () => {
  it('preserves historical 1.0.151 evidence and appends exact 1.0.169 evidence classes', async () => {
    const results = await readDoc('docs/memory-tools-research/context-mode-benchmark-results.md');
    assert.match(results, /1\.0\.151/);
    assert.match(results, /v1\.0\.169/);
    assert.match(results, /plugin_snapshot_isolated/);
    assert.match(results, /NOT_RUN\(auth_isolation_unavailable\)/);
    assert.match(results, /direct_hook_contract/);
  });

  it('keeps rg baseline, explicit opt-in and separate MCP/plugin conclusions', async () => {
    const [research, recommendations, providers, metadata] = await Promise.all([
      readDoc('docs/memory-tools-research/context-mode.md'),
      readDoc('docs/memory-tool-recommendations.md'),
      readDoc('docs/context-providers.md'),
      readDoc('docs/memory-tools-research/recommendation-metadata.yaml')
    ]);
    for (const body of [research, recommendations, providers, metadata]) {
      assert.match(body, /\brg\b/);
      assert.match(body, /explicit_user_opt_in_only|явн/i);
      assert.doesNotMatch(body, /^\s*(?:auto_install|auto_register_hooks|auto_trust_hooks):\s*(?:true|enabled)\s*$/im);
    }
    assert.match(research, /MCP-only/i);
    assert.match(research, /Codex plugin/i);
    assert.match(metadata, /codex_plugin_status:/);
    assert.match(metadata, /normal_command_selection:\s*forbidden/);
  });
});
