import { after, it } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { measure, measureEntrypoints, SOURCE_SURFACES } from './measure-entrypoints.mjs';
import { inventoryPromptAssets, preservePromptAssets, finishPromptPreservation, recordPromptBaseline, validateInstalledPromptAssets } from './prompt-assets.mjs';
import { PROMPT_REFERENCES, validatePromptReferences } from './prompt-reference-graph.mjs';
import { compileSessionBrief } from './session-brief.mjs';

const repo = fileURLToPath(new URL('../', import.meta.url)), roots = [];
const ext = '.ai-factory/extensions/aifhub-extension';
const put = async (root, file, text) => { await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), text); };
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aifhub-entrypoints-')); roots.push(root);
  for (const dir of ['skills', 'injections', 'agent-files']) await cp(path.join(repo, dir), path.join(root, ext, dir), { recursive: true });
  for (const file of ['docs/workflow-mechanics.md', 'docs/isolated-execution.md']) await put(root, `${ext}/${file}`, await readFile(path.join(repo, file)));
  for (const file of ['extension.json', 'aifhub-extension.json']) await cp(path.join(repo, file), path.join(root, ext, file));
  const manifest = JSON.parse(await readFile(path.join(root, ext, 'extension.json'), 'utf8'));
  for (const runtime of ['claude', 'codex']) {
    for (const injection of manifest.injections) {
      const source = await readFile(path.join(root, ext, injection.file), 'utf8');
      const key = `<!-- aif-ext:aifhub-extension:${injection.target}:${injection.position}:`;
      await put(root, `.${runtime}/skills/${injection.target}/SKILL.md`, `user prefix\n${key}start -->\n${source.trim()}\n${key}end -->\nuser suffix\n`);
    }
    for (const skill of manifest.skills) await cp(path.join(root, ext, skill), path.join(root, `.${runtime}/skills`, path.basename(skill)), { recursive: true });
    for (const agent of manifest.agentFiles.filter(a => a.runtime === runtime)) await put(root, `.${runtime}/agents/${agent.target}`, await readFile(path.join(root, ext, agent.source)));
    await put(root, `.${runtime}/skills/aif/SKILL.md`, '# Upstream root\n');
  }
  return root;
}
after(async () => { for (const root of roots) {
  assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('aifhub-entrypoints-'));
  await rm(root, { recursive: true, force: true });
} });

it('measures strict UTF-8 physical bytes and CR/LF line endings', () => {
  for (const text of ['', 'a', 'a\n', 'a\r\nb\r\n', 'a\rb']) assert.equal(measure(Buffer.from(text)).lines, text ? text.startsWith('a') && text.includes('b') ? 2 : 1 : 0);
  assert.throws(() => measure(Buffer.from([0xff])), /encoded data/);
});
it('source and installed manifests are deterministic, read-only, and reject missing files', async () => {
  const first = await measureEntrypoints({ rootDir: repo });
  assert.equal(first.files.length, SOURCE_SURFACES.length);
  assert.equal(JSON.stringify(await measureEntrypoints({ rootDir: repo })), JSON.stringify(first));
  assert.equal(first.tokens, null); assert.equal(first.agent_consumption, 'not_observed_offline');
  const reference = 'injections/references/aif-implement/classic-sdd.md';
  const selected = await measureEntrypoints({ rootDir: repo, references: [reference, reference] });
  assert.equal(selected.selected_references.length, 1);
  assert.equal(selected.reference_totals.bytes, (await readFile(path.join(repo, reference))).length);
  assert.equal(JSON.stringify(selected), JSON.stringify(await measureEntrypoints({ rootDir: repo, references: [reference] })));
  await assert.rejects(measureEntrypoints({ rootDir: repo, references: ['injections/references/../../outside.md'] }), /invalid-reference/);
  const root = await fixture();
  const before = await inventoryPromptAssets(root);
  for (const runtime of ['claude', 'codex']) {
    const result = await measureEntrypoints({ rootDir: root, surface: 'installed-flow', runtime });
    assert.equal(result.files.some(f => f.path.startsWith(ext + '/injections/')), false);
    assert.equal(result.managed_blocks[0].start, 1); assert.equal(result.managed_blocks[0].end, 1);
    assert.deepEqual(result, await measureEntrypoints({ rootDir: root, surface: 'installed-flow', runtime }));
  }
  assert.deepEqual(await inventoryPromptAssets(root), before);
  await rm(path.join(root, '.codex/skills/aif/SKILL.md'));
  await assert.rejects(measureEntrypoints({ rootDir: root, surface: 'installed-flow', runtime: 'codex' }), { code: 'ENOENT' });
});
it('raw kernels retain budgets, marker-first boundaries and mandatory reference routes', async () => {
  await validatePromptReferences(repo);
  const budgets = [
    ['injections/core/aif-implement-plan-folder.md', 65, 85], ['skills/aif-done/SKILL.md', 90, 120],
    ['agent-files/claude/aifhub-implement-worker.md', 40, 55], ['agent-files/codex/aifhub-implement-worker.toml', 36, 51],
    ['skills/shared/QUESTION-TOOL.md', 35, 50],
  ];
  for (const [file, min, max] of budgets) {
    const bytes = await readFile(path.join(repo, file)), text = bytes.toString('utf8');
    assert.ok(measure(bytes).lines >= min && measure(bytes).lines <= max, `${file}: ${measure(bytes).lines}`);
    for (const ref of PROMPT_REFERENCES[file]) assert.ok(text.includes('`' + ref + '`'));
    if (file.includes('QUESTION')) continue;
    assert.match(text, /ultra-invalid/); assert.match(text, /collision/); assert.match(text, /classifyLegacyPlanShape\(\)/);
    assert.ok(text.indexOf('classifyLegacyPlanShape()') < text.indexOf('`classic-pair`'));
  }
});
it('separate prompt guard preserves unknown and modified extension/published/reference bytes with hashes', async () => {
  const root = await fixture();
  const unknown = await preservePromptAssets(root);
  assert.equal(unknown.manifest.baseline, 'unknown'); assert.ok(unknown.manifest.files.length > 50);
  await recordPromptBaseline(root);
  assert.equal(await preservePromptAssets(root), null);
  const paths = [`${ext}/injections/core/aif-implement-plan-folder.md`, `${ext}/injections/references/aif-implement/classic-sdd.md`, '.codex/skills/aif-implement/SKILL.md', '.claude/agents/aifhub-implement-worker.md'];
  for (const file of paths) await put(root, file, 'user patch\r\n');
  const preserved = await preservePromptAssets(root);
  assert.deepEqual(preserved.manifest.files.map(f => f.path).sort(), [...paths].sort());
  for (const file of paths) {
    assert.equal(await readFile(path.join(root, path.dirname(preserved.manifestPath), 'preserve', file), 'utf8'), 'user patch\r\n');
    await put(root, file, 'incoming\n');
  }
  await finishPromptPreservation(root, preserved);
  assert.ok(preserved.manifest.files.every(f => f.installed_sha256 !== f.incoming_sha256));
});
it('preservation honors custom runtime directories from the installed ledger', async () => {
  const root = await fixture();
  const ledger = { agents: [{ id: 'codex', skillsDir: 'custom-codex/skills', agentsDir: 'custom-codex/agents' }] };
  await put(root, '.ai-factory.json', JSON.stringify(ledger));
  await put(root, 'custom-codex/skills/aif-implement/SKILL.md', 'custom skill bytes\n');
  await put(root, 'custom-codex/agents/aifhub-fixer.toml', 'custom agent bytes\n');
  const inventory = await inventoryPromptAssets(root);
  assert.ok(inventory.some(f => f.path === 'custom-codex/skills/aif-implement/SKILL.md'));
  assert.ok(inventory.some(f => f.path === 'custom-codex/agents/aifhub-fixer.toml'));
  await recordPromptBaseline(root);
  await put(root, 'custom-codex/skills/aif-implement/SKILL.md', 'user edit\n');
  const preserved = await preservePromptAssets(root);
  assert.ok(preserved.manifest.files.some(f => f.path === 'custom-codex/skills/aif-implement/SKILL.md'));
  const ledgerBounded = JSON.parse(await readFile(path.join(root, '.ai-factory.json'), 'utf8'));
  ledgerBounded.agents.push({ id: 'claude', skillsDir: '../escape' });
  await put(root, '.ai-factory.json', JSON.stringify(ledgerBounded));
  await assert.rejects(inventoryPromptAssets(root), /invalid-installed-layout/);
});

it('preservation fails before replacement when its destination is unsafe', async () => {
  const root = await fixture();
  await put(root, '.ai-factory/state/extension-prompt-updates', 'blocked');
  const before = await inventoryPromptAssets(root);
  await assert.rejects(preservePromptAssets(root));
  assert.deepEqual(await inventoryPromptAssets(root), before);
});
it('installed reference and one-pair contracts reject missing references, duplicate/stale blocks', async () => {
  const root = await fixture(); await validateInstalledPromptAssets(root);
  const file = '.codex/skills/aif-implement/SKILL.md', text = await readFile(path.join(root, file), 'utf8');
  await put(root, file, text + text); await assert.rejects(validateInstalledPromptAssets(root), /marker-pair/);
  await put(root, file, text.replace('Shared execution kernel', 'old execution kernel')); await assert.rejects(validateInstalledPromptAssets(root), /stale-installed/);
  await put(root, file, text);
  await rm(path.join(root, ext, 'injections/references/aif-implement/classic-sdd.md'));
  await assert.rejects(validateInstalledPromptAssets(root), { code: 'ENOENT' });
});
it('fast compiler handoff needs neither full companions nor canonical reads or runtime writes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aifhub-entrypoints-')); roots.push(root);
  await put(root, '.ai-factory/config.yaml', 'aifhub:\n  tools: {}\npaths:\n  plan: planning/quick.md\n  plans: forbidden-plans\n');
  // A poisoned companion folder must not be opened or preflighted for a fast target.
  await put(root, 'forbidden-plans/quick', 'not a companion directory');
  const result = await compileSessionBrief({ rootDir: root, changeId: 'planning/quick.md' });
  assert.equal(result.status, 'delegated', JSON.stringify(result));
  assert.equal(result.owner_handoff, '/aif-implement planning/quick.md');
  assert.deepEqual(result.blocked_reasons, ['upstream_fast_handoff']);
  assert.deepEqual(await readdir(path.join(root, '.ai-factory')), ['config.yaml']);
});
