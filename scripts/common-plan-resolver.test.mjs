import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { listAdapters, resolvePlanContext } from './common-plan-resolver.mjs';

const roots = [];

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aifhub-resolver-'));
  roots.push(root);
  await mkdir(path.join(root, '.ai-factory'), { recursive: true });
  await writeFile(path.join(root, '.ai-factory/config.yaml'), 'aifhub:\n  artifactProtocol: openspec\n  openspec:\n    useInstructionsApply: false\n');
  const change = 'add-oauth';
  const base = path.join(root, `openspec/changes/${change}`);
  await mkdir(path.join(base, 'specs/behavior'), { recursive: true });
  const proposal = [
    '## Original Request', '', 'Add OAuth login.', '',
    '## Why', '', 'Users need authentication.', '',
    '## What Changes', '', '- Add OAuth flow.', '',
    '## Capabilities', '', '### New Capabilities', '', '- behavior', '',
    '## SDD Profile Inputs', '', '```json', JSON.stringify({
      planning_mode: 'full', behavior_change: true, modules: 1, repositories: 1,
      public_api: false, data_migration: false, reversible: true, security_sensitive: false,
      architecture_novelty: false, requirements_clear: true, expected_files: 2
    }, null, 2), '```', '',
    '## Acceptance Examples', '', '- Valid token logs user in.', '',
    '## Non-goals', '', '- Social providers.', '',
    '## Allowed Change Surface', '', '- src/auth/**', '',
    '## Forbidden Change Surface', '', '- src/billing/**'
  ].join('\n');
  await writeFile(path.join(base, 'proposal.md'), proposal);
  await writeFile(path.join(base, 'tasks.md'), '# Tasks\n\n- [ ] 1.1 Implement OAuth handler.\n- [x] 1.2 Add tests.\n');
  await writeFile(path.join(base, 'design.md'), '# Design\n\n## Constraints\n\n- Use existing provider.\n');
  await writeFile(path.join(base, 'specs/behavior/spec.md'), '## ADDED\n\n### Requirement: OAuth\n- **WHEN** token is valid\n- **THEN** login succeeds\n');
  return { root, change };
}

after(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

describe('Common plan resolver', () => {
  it('lists installed adapters', async () => {
    const adapters = await listAdapters();
    assert.ok(adapters.includes('openspec'));
    assert.ok(adapters.includes('aifactory'));
  });

  it('resolves OpenSpec plan context from canonical artifacts', async () => {
    const { root, change } = await fixture();
    const context = await resolvePlanContext({ rootDir: root, changeId: change, methodology: 'openspec' });
    assert.equal(context.schema, 'aifhub.plan_context.v1');
    assert.equal(context.plan_id, change);
    assert.equal(context.methodology, 'openspec');
    assert.equal(context.public_mode, 'full');
    assert.equal(context.sdd_profile, 'quick');
    assert.equal(context.requirements.intent, 'Users need authentication.');
    assert.equal(context.requirements.target_outcome, '- Add OAuth flow.');
    assert.equal(context.tasks.length, 2);
    assert.equal(context.tasks[0].text, '1.1 Implement OAuth handler.');
    assert.equal(context.tasks[1].done, true);
    assert.ok(context.acceptance_examples[0].includes('Valid token logs user in.'));
    assert.ok(context.non_goals[0].includes('Social providers.'));
    assert.ok(context.change_surface.allowed[0].includes('src/auth/**'));
    assert.ok(context.change_surface.forbidden[0].includes('src/billing/**'));
    assert.ok(context.documents.some((doc) => doc.path === `openspec/changes/${change}/specs/behavior/spec.md`));
    assert.ok(/^[a-f0-9]{64}$/.test(context.source_revision));
  });

  it('resolves AI Factory native plan from .ai-factory/plans/<id>.md', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'aifhub-resolver-'));
    roots.push(root);
    const change = 'add-oauth';
    await mkdir(path.join(root, '.ai-factory/plans'), { recursive: true });
    await writeFile(path.join(root, `.ai-factory/plans/${change}.md`), '# Plan\n\n- [ ] 1.1 Implement auth.\n- [x] 1.2 Verify.\n');
    const context = await resolvePlanContext({ rootDir: root, changeId: change, methodology: 'aifactory' });
    assert.equal(context.schema, 'aifhub.plan_context.v1');
    assert.equal(context.methodology, 'aifactory');
    assert.equal(context.public_mode, 'full');
    assert.equal(context.tasks.length, 2);
    assert.equal(context.errors[0].code, 'aifactory-native-plan-parsing-incomplete');
    assert.equal(context.sdd_inputs, null);
    assert.equal(context.sdd_profile, null);
    assert.deepEqual(context.errors.map((error) => error.code), ['aifactory-native-plan-parsing-incomplete']);
  });

  it('fails on unknown methodology', async () => {
    const { root, change } = await fixture();
    await assert.rejects(resolvePlanContext({ rootDir: root, changeId: change, methodology: 'unknown' }), /unknown-methodology/);
  });
});
