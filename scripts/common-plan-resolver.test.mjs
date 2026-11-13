import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, lstat, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { listAdapters, resolvePlanContext, resolvePlanContextCommand } from './common-plan-resolver.mjs';

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
    await completeNativePair(root, change);
    const context = await resolvePlanContext({ rootDir: root, changeId: change, methodology: 'aifactory' });
    assert.equal(context.schema, 'aifhub.plan_context.v1');
    assert.equal(context.methodology, 'aifactory');
    assert.equal(context.public_mode, 'full');
    assert.equal(context.tasks.length, 2);
    // reason: classic-native-parsing-complete replaces deferred parser pin.
    assert.ok(context.requirements.intent && context.requirements.target_outcome);
    assert.equal(context.documents.length, 6);
    assert.equal(context.sdd_inputs, null);
    assert.equal(context.sdd_profile, null);
    assert.deepEqual(context.errors, []);
  });

  it('fails on unknown methodology', async () => {
    const { root, change } = await fixture();
    await assert.rejects(resolvePlanContext({ rootDir: root, changeId: change, methodology: 'unknown' }), /unknown-methodology/);
  });
  it('parses CRLF task files in both adapters without losing checkboxes', async () => {
    const { root, change } = await fixture();
    await writeFile(path.join(root, `openspec/changes/${change}/tasks.md`), '# Tasks\r\n\r\n- [ ] 1.1 Implement OAuth handler.\r\n- [x] 1.2 Add tests.\r\n');
    const context = await resolvePlanContext({ rootDir: root, changeId: change, methodology: 'openspec' });
    assert.equal(context.tasks.length, 2);
    assert.equal(context.tasks[1].done, true);
    const nativeRoot = await mkdtemp(path.join(os.tmpdir(), 'aifhub-resolver-'));
    roots.push(nativeRoot);
    await mkdir(path.join(nativeRoot, '.ai-factory/plans'), { recursive: true });
    await writeFile(path.join(nativeRoot, `.ai-factory/plans/${change}.md`), '# Plan\r\n\r\n- [ ] 1.1 Implement auth.\r\n- [x] 1.2 Verify.\r\n');
    await completeNativePair(nativeRoot, change);
    const native = await resolvePlanContext({ rootDir: nativeRoot, changeId: change, methodology: 'aifactory' });
    assert.equal(native.tasks.length, 2);
    assert.equal(native.tasks[1].done, true);
  });
  it('preserves strict JSON diagnostics from SDD profile inputs', async () => {
    const { root, change } = await fixture();
    const proposalPath = path.join(root, `openspec/changes/${change}/proposal.md`);
    const proposalText = await readFile(proposalPath, 'utf8');
    await writeFile(proposalPath, proposalText.replace('  "planning_mode": "full",', '  "planning_mode": "full",\n  "planning_mode": "full",'));
    await assert.rejects(resolvePlanContext({ rootDir: root, changeId: change, methodology: 'openspec' }), /duplicate_json_key/);
  });
  it('classifies SDD fence misses with the addressable trailing prose code (strict channel)', async () => {
    const signalsJson = JSON.stringify({
      planning_mode: 'full', behavior_change: true, modules: 1, repositories: 1,
      public_api: false, data_migration: false, reversible: true, security_sensitive: false,
      architecture_novelty: false, requirements_clear: true, expected_files: 2
    }, null, 2);
    const fence = ['```json', signalsJson, '```'].join('\n');
    for (const [name, body, expected] of [
      ['trailing prose in the same H2', `${fence}\n\nПояснение к сигналам.`, /sdd_inputs_trailing_prose/],
      ['prose under H3 inside the H2 section', `${fence}\n\n### Пояснение\n\nТекст.`, /sdd_inputs_trailing_prose/],
      ['broken JSON with prose keeps strict priority', '```json\n{ oops }\n```\nПояснение.', /invalid_json/],
      ['two fences keep invalid_json', `${fence}\n\n\`\`\`json\n{}\n\`\`\`\nХвост.`, /invalid_json/],
      ['line-start tilde fence keeps invalid_json', `${fence}\n\n~~~json\n{}\n~~~\nХвост.`, /invalid_json/],
      ['inline code span in prose stays trailing prose', `${fence}\n\nПояснение: используйте \`\`\`json inline для формата.`, /sdd_inputs_trailing_prose/],
      ['inline tildes in prose stay trailing prose', `${fence}\n\nПояснение: ~~~ внутри строки — не ограда.`, /sdd_inputs_trailing_prose/],
      ['CRLF inline code span in prose stays trailing prose', ['```json', signalsJson, '```', '', 'Пояснение: используйте ```json inline.'].join('\r\n'), /sdd_inputs_trailing_prose/],
      ['leading prose keeps the closed shape', `Пояснение перед.\n\n${fence}`, /invalid-sdd-inputs/],
      ['leading and trailing prose keep the closed shape', `Пояснение перед.\n\n${fence}\n\nПояснение после.`, /invalid-sdd-inputs/],
      ['fence with a trailing space keeps the closed shape', `\`\`\`json \n${signalsJson}\n\`\`\``, /invalid-sdd-inputs/],
      ['tilde fence keeps the closed shape', '~~~\n{}\n~~~', /invalid-sdd-inputs/],
      ['four backticks keep the closed shape', `\`\`\`\`json\n${signalsJson}\n\`\`\`\``, /invalid-sdd-inputs/],
      ['missing fence keeps the closed shape', 'Просто текст без fence.', /invalid-sdd-inputs/],
      ['CRLF trailing prose', ['```json', signalsJson, '```', '', 'Пояснение.'].join('\r\n'), /sdd_inputs_trailing_prose/]
    ]) {
      const { root, change } = await fixture();
      await rewriteSddSection(root, change, body);
      await assert.rejects(resolvePlanContext({ rootDir: root, changeId: change, methodology: 'openspec' }), expected, name);
    }
  });
  it('accepts fence-only SDD sections with rationale in a neighbor H2 and CRLF fences', async () => {
    const { root, change } = await fixture();
    const signalsJson = JSON.stringify({
      planning_mode: 'full', behavior_change: true, modules: 1, repositories: 1,
      public_api: false, data_migration: false, reversible: true, security_sensitive: false,
      architecture_novelty: false, requirements_clear: true, expected_files: 2
    }, null, 2);
    const fence = ['```json', signalsJson, '```'].join('\n');
    await rewriteSddSection(root, change, `${fence}\n\n## Rationale\n\nПояснение в соседней H2-секции.`);
    const context = await resolvePlanContext({ rootDir: root, changeId: change, methodology: 'openspec' });
    assert.deepEqual(context.errors, []);
    assert.equal(context.sdd_inputs.expected_files, 2);
    await rewriteSddSection(root, change, ['```json', signalsJson, '```'].join('\r\n'));
    const crlf = await resolvePlanContext({ rootDir: root, changeId: change, methodology: 'openspec' });
    assert.deepEqual(crlf.errors, []);
    assert.equal(crlf.sdd_inputs.expected_files, 2);
  });
  it('writes resolved context through the safe provider writer and rejects unsafe output paths', async () => {
    const { root, change } = await fixture();
    const stdout = { written: '', write(value) { this.written += value; } };
    const output = `.ai-factory/state/${change}/plan-context.json`;
    const exit = await resolvePlanContextCommand(['resolve', '--change', change, '--json', '--output', output], { rootDir: root, stdout });
    assert.equal(exit, 0);
    const stored = JSON.parse(await readFile(path.join(root, output), 'utf8'));
    assert.equal(stored.schema, 'aifhub.plan_context.v1');
    assert.notEqual(await lstat(path.join(root, '.ai-factory/state/.gitignore')).catch(() => null), null);
    const unsafe = await resolvePlanContextCommand(['resolve', '--change', change, '--json', '--output', '../escape.json'], { rootDir: root, stdout });
    assert.equal(unsafe, 2);
  });
});

// Replaces the body of the fixture's `## SDD Profile Inputs` section (up to
// the next active H2) with the given text, keeping the surrounding sections.
async function rewriteSddSection(root, change, sectionBody) {
  const proposalPath = path.join(root, `openspec/changes/${change}/proposal.md`);
  const text = await readFile(proposalPath, 'utf8');
  const start = text.indexOf('## SDD Profile Inputs');
  const end = text.indexOf('## Acceptance Examples');
  assert.ok(start !== -1 && end > start, 'fixture must keep the SDD section before acceptance examples');
  await writeFile(proposalPath, `${text.slice(0, start)}## SDD Profile Inputs\n\n${sectionBody}\n\n${text.slice(end)}`);
}

async function completeNativePair(root, change) {
  const base = path.join(root, '.ai-factory/plans', change);
  const source = await readFile(base + '.md', 'utf8');
  await mkdir(base, { recursive: true });
  for (const name of ['task.md', 'context.md', 'rules.md', 'verify.md', 'status.yaml']) {
    await writeFile(path.join(base, name), name === 'task.md' ? source : name === 'status.yaml' ? 'plan_id: ' + change + '\n' : '# Context\n');
  }
  await writeFile(base + '.md', '## Summary\nDeclared native intent.\n\n## Scope\n- src/auth/**\n\n## Requirements\n- Reject invalid input.\n\n' + source);
}
