import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, lstat, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { listAdapters, resolvePlanContext, resolvePlanContextCommand } from './common-plan-resolver.mjs';
import { compileOpenSpecRules } from './openspec-rules-compiler.mjs';
import { digest, readProviderFile } from './provider-files.mjs';
import { compileSessionBrief } from './session-brief.mjs';

const roots = [];

async function fixture({ sdd = true } = {}) {
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
  await writeFile(path.join(base, 'proposal.md'), sdd ? proposal : proposal.replace(/## SDD Profile Inputs\n[\s\S]*?(?=## Acceptance Examples)/, ''));
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

  it('returns the original task section in JSON and text for both repository checklist layouts', async () => {
    const { root, change } = await fixture({ sdd: false });
    const taskFile = `openspec/changes/${change}/tasks.md`;
    for (const [fixturePath, id, start, line, checked] of [
      ['scripts/fixtures/ponytail-lifecycle-ab/canonical/lifecycle-price-format/tasks.md', '2.1', '## 2. Verification', 7, false],
      ['test/fixtures/openspec-valid-change/openspec/changes/fixture-change/tasks.md', '1.1', '# Tasks', 3, true]
    ]) {
      const raw = await readFile(new URL(`../${fixturePath}`, import.meta.url), 'utf8');
      await writeFile(path.join(root, taskFile), raw);
      const expected = raw.slice(raw.indexOf(start));
      const { exitCode, result } = await taskCall(root, ['--change', change, '--task', id, '--json']);
      assert.equal(exitCode, 0);
      assert.equal(result.change_id, change);
      assert.equal(result.task_id, id);
      assert.deepEqual(result.task, { line, checked });
      assert.equal(result.section.path, taskFile);
      assert.equal(result.section.markdown, expected);
      const text = await taskCall(root, ['--change', change, '--task', id]);
      assert.equal(text.exitCode, 0);
      assert.ok(text.output.includes(expected));
    }
  });

  it('keeps Unicode and CRLF in the selected H2 while skipping hidden headings', async () => {
    const { root, change } = await fixture({ sdd: false });
    const first = '\uFEFF## First \u{1F680}\r\n- [x] 1.1 Done\r\n<!--\r\n## Hidden\r\n- [ ] 1.1 Hidden\r\n-->\r\n```md\r\n## Fenced\r\n```\r\n';
    await writeFile(path.join(root, `openspec/changes/${change}/tasks.md`), `${first}## Second\r\n- [ ] 2.1 Pending\r\n`);
    const { exitCode, result } = await taskCall(root, ['--change', change, '--task', '1.1', '--json']);
    assert.equal(exitCode, 0);
    assert.equal(result.section.markdown, first);
    assert.equal(result.section.start_line, 1);
    assert.equal(result.section.end_line, 9);
  });

  it('rejects invalid task arguments before reading sources and honours JSON after the invalid flag', async () => {
    for (const args of [
      ['--change', 'fixture', '--task', '1.1', '--output', 'out.json'],
      ['--change', 'fixture', '--task', '1.1', '--methodology', 'openspec'],
      ['--change', 'fixture', '--task'],
      ['--change', 'fixture', '--task', '1.1', '--task', '1.2']
    ]) {
      let reads = 0;
      const { exitCode, result } = await taskCall('.', [...args, '--json'], { readSource() { reads++; } });
      assert.equal(exitCode, 2);
      assert.deepEqual(result, { ok: false, error: 'invalid_task_arguments' });
      assert.equal(reads, 0);
    }
  });

  it('rejects missing, ambiguous or archived selections and requires effective OpenSpec mode', async () => {
    const { root, change } = await fixture();
    const call = (target, task) => taskCall(root, ['--change', target, '--task', task, '--json']);
    assert.equal((await call(change, '9.9')).result.error, 'unknown-or-ambiguous-task');
    await writeFile(path.join(root, `openspec/changes/${change}/tasks.md`), '- [ ] 1.1 First\n- [x] 1.1 Second\n');
    assert.equal((await call(change, '1.1')).result.error, 'unknown-or-ambiguous-task');
    assert.equal((await call('archive', '1.1')).exitCode, 2);
    await writeFile(path.join(root, '.ai-factory/config.yaml'), 'aifhub:\n  artifactProtocol: openspec\n  tools:\n    openspec: false\n');
    assert.equal((await call(change, '1.1')).result.error, 'openspec_mode_required');
  });

  it('binds task context and verified generated rules to actual files without writing state', async () => {
    const { root, change } = await fixture();
    const generated = await compileOpenSpecRules(change, { rootDir: root, detectOpenSpec: async () => ({ available: false }) });
    assert.equal(generated.ok, true);
    const brief = await compileSessionBrief({ rootDir: root, changeId: change });
    assert.equal(brief.status, 'valid');
    const before = await taskFixtureSnapshot(root);
    const args = ['--change', change, '--task', '1.1'];
    const { exitCode, result } = await taskCall(root, [...args, '--json']);
    assert.equal(exitCode, 0);
    assert.equal(result.context.status, 'valid');
    assert.equal(result.context.digest, brief.digest);
    assert.equal(result.context.intent, 'Users need authentication.');
    assert.equal(result.rules.generated.status, 'verified');
    assert.deepEqual(result.rules.generated.refs.map(ref => ref.path), [
      `.ai-factory/rules/generated/openspec-merged-${change}.md`,
      `.ai-factory/rules/generated/openspec-change-${change}.md`,
      '.ai-factory/rules/generated/openspec-base.md'
    ]);
    const text = await taskCall(root, args);
    assert.match(text.output, /Users need authentication/);
    assert.match(text.output, new RegExp(`openspec-merged-${change}\\.md`));
    assert.deepEqual(await taskFixtureSnapshot(root), before);
  });

  it('binds configured project rules outside the rules directory and detects drift', async () => {
    const { root, change } = await fixture();
    const config = path.join(root, '.ai-factory/config.yaml');
    await writeFile(config, `${await readFile(config, 'utf8')}rules:\n  base: policy/base.md\n  skills: policy/skills.md\n`);
    await mkdir(path.join(root, 'policy'));
    const rules = [
      ['.ai-factory/RULES.md', '# Project rules\n'],
      ['policy/base.md', '# Base rules\n'],
      ['policy/skills.md', '# Skill rules\n']
    ];
    for (const [file, content] of rules) await writeFile(path.join(root, file), content);

    const brief = await compileSessionBrief({ rootDir: root, changeId: change });
    assert.equal(brief.status, 'valid');
    const args = ['--change', change, '--task', '1.1', '--json'];
    const before = await taskFixtureSnapshot(root);
    const fresh = await taskCall(root, args);
    assert.equal(fresh.exitCode, 0);
    assert.equal(fresh.result.context.status, 'valid');
    assert.equal(fresh.result.context.digest, brief.digest);
    assert.deepEqual(fresh.result.rules.project, rules.map(([file, content]) => ({
      path: file, sha256: digest(Buffer.from(content)), fidelity: 'full'
    })));
    assert.deepEqual(await taskFixtureSnapshot(root), before);

    await writeFile(path.join(root, 'policy/skills.md'), '# Revised skill rules\n');
    const stale = await taskCall(root, args);
    assert.equal(stale.exitCode, 1);
    assert.equal(stale.result.context.status, 'stale');
    assert.ok(stale.result.context.stale_reasons.includes('source_revision_changed'));
    assert.equal(stale.result.context.digest, undefined);
    assert.deepEqual(stale.result.rules.project, []);
  });

  it('uses base.md in the effective rules directory with or without a SessionBrief', async () => {
    const content = '# Base rules\n';
    for (const custom of [false, true]) {
      const { root, change } = await fixture({ sdd: custom });
      const rulesDir = custom ? 'policy' : '.ai-factory/rules';
      const rulePath = `${rulesDir}/base.md`;
      await mkdir(path.join(root, rulesDir));
      await writeFile(path.join(root, rulePath), content);
      if (custom) {
        const config = path.join(root, '.ai-factory/config.yaml');
        await writeFile(config, `${await readFile(config, 'utf8')}paths:\n  rules: ${rulesDir}\n`);
        await mkdir(path.join(root, '.ai-factory/rules'));
        await writeFile(path.join(root, '.ai-factory/rules/base.md'), '# Unselected default\n');
        assert.equal((await compileSessionBrief({ rootDir: root, changeId: change })).status, 'valid');
      }

      const result = await taskCall(root, ['--change', change, '--task', '1.1', '--json']);
      assert.equal(result.exitCode, 0);
      assert.equal(result.result.context.status, custom ? 'valid' : 'disabled');
      assert.deepEqual(result.result.rules.project, [{
        path: rulePath, sha256: digest(Buffer.from(content)), fidelity: 'full'
      }]);
    }
  });

  it('distinguishes unopted, missing, stale and blocked context without returning a stale digest', async () => {
    const { root, change } = await fixture();
    const call = () => taskCall(root, ['--change', change, '--task', '1.1', '--json']);
    const missing = await call();
    assert.equal(missing.exitCode, 1);
    assert.equal(missing.result.context.status, 'missing');
    assert.equal(missing.result.owner_handoff, `ai-factory aifhub-session-brief compile --change ${change} --json`);
    await compileSessionBrief({ rootDir: root, changeId: change });
    await writeFile(path.join(root, `openspec/changes/${change}/tasks.md`), '- [x] 1.1 Implement OAuth handler.\n');
    const stale = await call();
    assert.equal(stale.exitCode, 1);
    assert.equal(stale.result.task.checked, true);
    assert.equal(stale.result.context.status, 'stale');
    assert.ok(stale.result.context.stale_reasons.includes('source_revision_changed'));
    assert.equal(stale.result.context.digest, undefined);
    const proposal = path.join(root, `openspec/changes/${change}/proposal.md`);
    await writeFile(proposal, (await readFile(proposal, 'utf8')).replace('## Allowed Change Surface', '## Other'));
    const blocked = await call();
    assert.equal(blocked.exitCode, 1);
    assert.ok(blocked.result.context.blocked_reasons.includes('missing_allowed_change_surface'));
    assert.equal(blocked.result.owner_handoff, 'aif-plan');
    const unopted = await fixture({ sdd: false });
    const result = await taskCall(unopted.root, ['--change', unopted.change, '--task', '1.1', '--json']);
    assert.equal(result.exitCode, 0);
    assert.equal(result.result.context.status, 'disabled');
    assert.equal(result.result.rules.generated.status, 'missing');
  });

  it('blocks a generated index with unsafe inputs and a generated root junction before reading derived context', async () => {
    const { root, change } = await fixture();
    const args = ['--change', change, '--task', '1.1', '--json'];
    assert.equal((await compileOpenSpecRules(change, { rootDir: root, detectOpenSpec: async () => ({ available: false }) })).ok, true);
    const generated = path.join(root, '.ai-factory/rules/generated');
    const indexPath = path.join(generated, 'index.json');
    const index = JSON.parse(await readFile(indexPath, 'utf8'));
    index.base.inputs.push({ path: '../outside/spec.md', kind: 'base-spec', sha256: 'a'.repeat(64) });
    await writeFile(indexPath, JSON.stringify(index));
    const invalid = await taskCall(root, args);
    assert.equal(invalid.exitCode, 1);
    assert.ok(invalid.result.context.blocked_reasons.includes('unsafe-generated-index-path'));
    const linkedFixture = await fixture();
    await mkdir(path.join(linkedFixture.root, '.ai-factory/rules'));
    const outside = await mkdtemp(path.join(os.tmpdir(), 'aifhub-task-external-'));
    roots.push(outside);
    const trace = `openspec-rules-trace-${change}.json`;
    await writeFile(path.join(outside, trace), 'invalid external trace');
    await symlink(outside, path.join(linkedFixture.root, '.ai-factory/rules/generated'), 'junction');
    const linked = await taskCall(linkedFixture.root, args);
    assert.equal(linked.exitCode, 1);
    assert.equal(linked.result.context.blocked_reasons.length, 1);
    assert.match(linked.result.context.blocked_reasons[0], /generated.*root/);
    assert.doesNotMatch(linked.output, /invalid.external.trace|invalid-generated-rules-trace/);
  });

  it('withholds the brief if a rule is changed after inspection and distrusts traces without output hashes', async () => {
    const { root, change } = await fixture();
    const config = path.join(root, '.ai-factory/config.yaml');
    await writeFile(config, `${await readFile(config, 'utf8')}rules:\n  base: .ai-factory/rules/base.md\n`);
    assert.equal((await compileOpenSpecRules(change, { rootDir: root, detectOpenSpec: async () => ({ available: false }) })).ok, true);
    const rule = '.ai-factory/rules/base.md';
    await writeFile(path.join(root, rule), '# Original rule\n');
    const brief = await compileSessionBrief({ rootDir: root, changeId: change });
    assert.equal(brief.status, 'valid');
    const args = ['--change', change, '--task', '1.1', '--json'];
    const raced = await taskCall(root, args, {
      async readSource(readRoot, file, limit) {
        if (file === rule) await writeFile(path.join(readRoot, file), '# Changed rule\n');
        return readProviderFile(readRoot, file, limit);
      }
    });
    assert.equal(raced.exitCode, 1);
    assert.equal(raced.result.context.status, 'stale');
    assert.equal(raced.result.context.digest, undefined);
    const tracePath = path.join(root, `.ai-factory/rules/generated/openspec-rules-trace-${change}.json`);
    const trace = JSON.parse(await readFile(tracePath, 'utf8'));
    delete trace.outputs;
    await writeFile(tracePath, JSON.stringify(trace));
    assert.equal((await compileSessionBrief({ rootDir: root, changeId: change })).status, 'valid');
    const legacy = await taskCall(root, args);
    assert.equal(legacy.exitCode, 0);
    assert.equal(legacy.result.rules.generated.status, 'unverified');
    assert.deepEqual(legacy.result.rules.generated.refs, []);
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

async function taskCall(rootDir, args, options = {}) {
  let output = '';
  const exitCode = await resolvePlanContextCommand(['task', ...args], {
    rootDir, ...options, stdout: { write: value => { output += value; } }
  });
  const result = output.trimStart().startsWith('{') ? JSON.parse(output) : null;
  return { exitCode, output, result };
}

async function taskFixtureSnapshot(root) {
  const snapshot = {};
  for (const file of await readdir(root, { recursive: true, withFileTypes: true })) {
    const target = path.join(file.parentPath, file.name);
    snapshot[path.relative(root, target)] = file.isFile() ? digest(await readFile(target)) : null;
  }
  return snapshot;
}

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
