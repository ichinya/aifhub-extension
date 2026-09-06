// Research probe only. Node 24.13+; no provider calls or runtime installation.
// Usage: node refinement-probe.mjs <Prime-Agent-source-checkout>
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const revision = '81ae3cb34d27d38ee37f9e205a1e73694993b344';
const sourcePath = 'packages/coding-agent/src/core/refinement/refinement.ts';
const checkout = process.argv[2];
assert.ok(checkout, 'Supply a disposable upstream source checkout');
const source = execFileSync('git', ['-C', checkout, 'show', `${revision}:${sourcePath}`], {
  encoding: 'utf8', maxBuffer: 2 * 1024 * 1024,
});

// Load the exact Git blob with types removed. Unused application/provider imports
// fail if called: this probes real CRUD/persistence/rollback functions, not an LLM
// or the AgentSession /refine orchestration, prompt rebuild, or audit append.
const stubs = new Map([
  ['@earendil-works/pi-ai', 'completeSimple'],
  ['../../config.js', 'getAgentDir'],
  ['../compaction/utils.js', 'serializeConversation'],
  ['../messages.js', 'convertToLlm'],
]);
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (stubs.has(specifier)) {
      const body = `export function ${stubs.get(specifier)}() { throw new Error('Unmocked application call is forbidden'); }`;
      return { url: `data:text/javascript,${encodeURIComponent(body)}`, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
const moduleText = stripTypeScriptTypes(source, { mode: 'strip' });
const upstream = await import(`data:text/javascript,${encodeURIComponent(moduleText)}`);
hooks.deregister();

const tempBase = realpathSync(tmpdir());
const scratch = mkdtempSync(join(tempBase, 'aifhub-prime-refinement-'));
const checks = [];
const record = (id) => checks.push({ id, observation_verified: true });
const proposal = (edits) => ({
  summary: 'Synthetic compatibility probe', rationale: 'Disposable fixture',
  expectedOutcome: 'Record actual mutation behavior', edits,
});
const entry = (kind, id, content, action = 'create') => ({
  action, kind, id, title: id, content,
});
let sequence = 0;
const apply = (state, edits, scope = 'local', extra = {}) => upstream.applyRefinementProposal(
  state, proposal(edits), { id: `probe-${++sequence}`, scope, ...extra },
);

try {
  for (const scope of ['local', 'global']) {
    const stateDir = join(scratch, scope, 'harness');
    const state = upstream.loadHarnessState(stateDir, scope);
    for (const kind of ['prompt', 'subagent']) {
      const id = `aifhub-${kind}-verifier`;
      const original = entry(kind, id, 'Read-only verifier; preserve AIFHub gates.');
      // These are deliberately arbitrary metadata, not a documented protection API.
      original.metadata = { immutable: true, readOnly: true, owner: 'aifhub' };
      assert.equal(apply(state, [original], scope).appliedEdits[0].applied, true);
      const baselineState = structuredClone(state);
      const updated = apply(state, [entry(kind, id, 'Changed synthetic policy.', 'update')], scope, { baselineState });
      assert.equal(updated.appliedEdits[0].applied, true);
      upstream.saveHarnessState(stateDir, state);
      assert.equal(upstream.loadHarnessState(stateDir, scope).entries[kind][id].content, 'Changed synthetic policy.');
      record(`${scope}_${kind}_metadata_does_not_prevent_update`);

      const rollback = await upstream.planRefinement([], state, [updated], {}, '', { rollbackId: updated.id });
      assert.equal(rollback.rollbackScope, scope);
      const restored = upstream.applyRefinementProposal(state, rollback.proposal, {
        id: `rollback-${++sequence}`, rollbackOf: updated.id, scope: rollback.rollbackScope,
      });
      assert.equal(restored.appliedEdits[0].applied, true);
      assert.equal(state.entries[kind][id].content, original.content);
      record(`${scope}_${kind}_rollback_restores_content`);

      assert.equal(apply(state, [{ action: 'delete', kind, id }], scope).appliedEdits[0].applied, true);
      upstream.saveHarnessState(stateDir, state);
      assert.equal(upstream.loadHarnessState(stateDir, scope).entries[kind][id], undefined);
      record(`${scope}_${kind}_metadata_does_not_prevent_delete`);
    }
    for (const action of ['create', 'update', 'delete']) {
      const result = apply(state, [entry('prompt', 'base_system_prompt', 'Synthetic replacement.', action)], scope);
      assert.equal(result.appliedEdits[0].applied, false);
      assert.equal(result.appliedEdits[0].error, 'base system prompt is not editable');
      record(`${scope}_base_system_prompt_${action}_rejected`);
    }
  }

  const local = upstream.loadHarnessState(join(scratch, 'local', 'harness'), 'local');
  const global = upstream.loadHarnessState(join(scratch, 'global', 'harness'), 'global');
  apply(global, [entry('prompt', 'aifhub-policy', 'Global policy.')], 'global');
  apply(local, [entry('prompt', 'aifhub-policy', 'Conflicting local policy.')]);
  const merged = upstream.mergeHarnessStates(global, local);
  assert.equal(merged.entries.prompt['aifhub-policy'].content, 'Global policy.');
  assert.equal(merged.entries.prompt['local:aifhub-policy'].content, 'Conflicting local policy.');
  const formatted = upstream.formatHarnessStateForPrompt(merged);
  assert.ok(formatted.includes('Global policy.') && formatted.includes('Conflicting local policy.'));
  record('global_and_local_same_id_both_reach_supplemental_prompt');

  const baselineState = structuredClone(local);
  apply(local, [entry('prompt', 'aifhub-policy', 'Concurrent update.', 'update')]);
  const stale = apply(local, [entry('prompt', 'aifhub-policy', 'Stale proposal.', 'update')], 'local', { baselineState });
  assert.equal(stale.appliedEdits[0].applied, false);
  assert.equal(stale.appliedEdits[0].error, 'entry changed during refinement planning');
  record('concurrent_edit_rejected');

  console.log(JSON.stringify({
    upstream_revision: revision, source_path: sourcePath,
    source_sha256: createHash('sha256').update(source).digest('hex'),
    node: process.version, level: 'isolated_upstream_functions',
    provider_calls: 0, adoption_pass: false, checks,
  }, null, 2));
} finally {
  assert.equal(dirname(realpathSync(scratch)), tempBase);
  rmSync(scratch, { recursive: true });
}
