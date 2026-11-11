// Opt-in offline exact-tag core checks for the reviewed AI Factory 2.23.0 matrix
// (issue #290). No CLI, package download, or live smoke. This file coexists with
// the historical ai-factory-2-22-core-contract.test.mjs and the even older
// ai-factory-2-20-core-contract.test.mjs; each reviewed-target matrix stays
// pinned to its own exact release (pattern of ai-factory-2-20-core-contract.test.mjs).
import { it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const upstream = process.env.AIFHUB_TEST_AI_FACTORY_223_ROOT;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

// Exact-tag custody (2.23.0 is the first annotated tag of the line: tag object
// 38190bbc253cf99bf70d612941eb9020e1b3bb3e dereferences to commit
// eabdfe9c8015e07ac7334bb9a66c262d94034d08 = npm ai-factory@2.23.0 gitHead).
// The contract layer is byte-identical to 2.22.0 (schema blob, injections.ts,
// installer/extension-ops/skill-targets/skills-migration/extensions/
// instruction-manifest/completion-hook, all 13 target SKILL.md and
// IMPLEMENT-TASK.md verified per-blob between the two tags), so the pinned
// schema blob and the implement reference bytes carry over unchanged; 2.23.0
// changes only the executable install/update path (dispatch, update opt-in,
// chatgpt/openrouter runtimes).
const UPSTREAM_SCHEMA_BLOB_SHA1 = 'a3d42681f43f644c4f01d2daf80e56a01d1893aa';
const IMPLEMENT_REFERENCE_PATH = 'skills/aif-implement/references/IMPLEMENT-TASK.md';
const IMPLEMENT_REFERENCE_SHA256 = '69ff94a0862d82290a0da9af379f7cfaf55394ca1f93f8e899699d4f6ef842b0';
const IMPLEMENT_RECONCILIATION_GATE = 'Run the requirement consistency gate';
const IMPLEMENT_CONFLICT_TOKEN = 'ERROR [requirement-conflict]';
const IMPLEMENT_REFERENCE_FILES = [
  'IMPLEMENT-COMMANDS.md',
  'IMPLEMENT-COMMITS.md',
  'IMPLEMENT-COMPLETION.md',
  'IMPLEMENT-CONTEXT.md',
  'IMPLEMENT-DISCOVERY.md',
  'IMPLEMENT-INLINE.md',
  'IMPLEMENT-LIST.md',
  'IMPLEMENT-PERSISTENCE.md',
  'IMPLEMENT-RECOVERY.md',
  'IMPLEMENT-TASK.md',
  'IMPLEMENTATION-GUIDE.md',
  'LOGGING-GUIDE.md'
];

async function snapshot(root) {
  const entries = {};
  async function visit(current, relative) {
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink()) entries[relative] = ['link', await fs.readlink(current)];
    else if (stat.isDirectory()) {
      entries[relative] = ['dir'];
      for (const name of (await fs.readdir(current)).sort()) await visit(path.join(current, name), `${relative}/${name}`);
    } else entries[relative] = ['file', digest(await fs.readFile(current))];
  }
  await visit(root, '.');
  return entries;
}

it('AI Factory 2.23 offline core: AIFHub ownership, grouped compose, rollback, migration custody and implement references', {
  skip: !upstream && 'NOTRUN: set AIFHUB_TEST_AI_FACTORY_223_ROOT to a built, exact 2.23.0 tag tree'
}, async t => {
  const load = relative => import(pathToFileURL(path.join(upstream, 'dist', relative)).href);
  const ops = await load('core/extension-ops.js');
  const migration = await load('core/skills-migration.js');
  const installer = await load('core/installer.js');
  const targets = await load('core/skill-targets.js');
  const { stripInjection } = await load('core/injections.js');
  const { saveConfig } = await load('core/config.js');
  const manifest = JSON.parse(await fs.readFile(path.join(repo, 'extension.json'), 'utf8'));
  assert.equal(JSON.parse(await fs.readFile(path.join(upstream, 'package.json'), 'utf8')).version, '2.23.0');
  const schema = await fs.readFile(path.join(upstream, 'schemas/extension.schema.json'));
  assert.equal(createHash('sha1').update(`blob ${schema.length}\0`).update(schema).digest('hex'),
    UPSTREAM_SCHEMA_BLOB_SHA1);
  // Reviewed-target byte-equality: the local schema is the pinned 2.23.0 blob
  // (unchanged since 2.22.0; only the schema URLs were re-pinned).
  assert.deepEqual(await fs.readFile(path.join(repo, 'schemas/extension.schema.json')), schema);
  const temp = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'aifhub-223-core-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const agent = (id, skillsDir, installedSkills) => ({ id, skillsDir, installedSkills, mcp: {} });
  const create = async name => { const dir = path.join(temp, name); await fs.mkdir(dir); return dir; };

  await t.test('real release sentinels bind version-specific paths', async () => {
    const skill = name => fs.readFile(path.join(upstream, 'skills', name, 'SKILL.md'), 'utf8');
    const implement = await skill('aif-implement');
    // 2.22.0 moved the gate into the pinned reference and 2.23.0 keeps the
    // reference bytes identical; SKILL.md keeps the conflict token. A
    // SKILL-only gate (the historical v219/v220 binding) must not be accepted
    // for this target.
    assert.equal(implement.split(IMPLEMENT_RECONCILIATION_GATE).length - 1, 0);
    assert.ok(implement.includes(IMPLEMENT_CONFLICT_TOKEN));
    const reference = await fs.readFile(path.join(upstream, ...IMPLEMENT_REFERENCE_PATH.split('/')), 'utf8');
    assert.equal(reference.split(IMPLEMENT_RECONCILIATION_GATE).length - 1, 1);
    assert.equal(digest(await fs.readFile(path.join(upstream, ...IMPLEMENT_REFERENCE_PATH.split('/')))),
      IMPLEMENT_REFERENCE_SHA256);
    for (const relative of IMPLEMENT_REFERENCE_FILES) {
      await fs.access(path.join(upstream, 'skills/aif-implement/references', relative));
    }
    assert.equal((await skill('aif-review')).split('Language: `en` (English)').length - 1, 1);
    assert.ok((await skill('aif-qa-check')).includes('browser-replay'));
    await skill('aif-warmup');
    const explore = await skill('aif-explore');
    assert.equal(explore.split('#### Research Coherence Gate (all persisted modes)').length - 1, 1);
    assert.equal(explore.split('#### Ultra mode: adaptive bundle').length - 1, 1);
    assert.equal(explore.split('Run the Research Coherence Gate, then the Bundle Integrity Gate').length - 1, 1);
  });

  await t.test('actual grouped targets compose AIFHub markers exactly once and preserve rendered base', async () => {
    const project = await create('shared');
    await fs.mkdir(path.join(project, '.agents'));
    const names = [...new Set(manifest.injections.map(i => i.target))];
    assert.equal(names.length, 13);
    const config = { version: '2.23.0', agents: [agent('codex', '.agents/skills', names),
      agent('codex-app', '.agents/skills', names)], extensions: [] };
    const groups = await targets.resolveSkillTargets(project, config.agents, { select: false });
    assert.equal(groups.length, 1);
    assert.equal(groups[0].targets.length, 2);
    await ops.installSkillsForAllAgents(project, config.agents, names);
    const base = new Map(await Promise.all(names.map(async name => [name,
      await fs.readFile(path.join(project, '.agents/skills', name, 'SKILL.md'))])));
    const extensionDir = path.join(project, '.ai-factory/extensions', manifest.name);
    await fs.mkdir(extensionDir, { recursive: true });
    for (const relative of ['extension.json', 'skills', 'injections'])
      await fs.cp(path.join(repo, relative), path.join(extensionDir, relative), { recursive: true });
    config.extensions = [{ name: manifest.name, version: manifest.version, source: extensionDir, replacedSkills: [] }];
    assert.equal(manifest.replaces, undefined);
    const owners = await migration.collectSkillOwners([{ dir: extensionDir, manifest }]);
    for (const relative of manifest.skills) {
      assert.ok(owners.get(path.basename(relative)).extension);
      assert.equal((await installer.getAvailableSkills()).includes(path.basename(relative)), false);
    }
    await ops.assertNoAgentFileConflicts(project, config, manifest);
    ops.assertNoConfiguredRuntimeOrphans(config, ops.getManifestRuntimeIds(manifest), manifest.name, 'update');
    // Repeat compose mirrors init/global-update/targeted-update reapplication.
    for (let pass = 0; pass < 3; pass += 1) {
      assert.equal(await ops.composeInstalledExtensionSkills(project, config), manifest.injections.length);
      for (const injection of manifest.injections) {
        const content = await fs.readFile(path.join(project, '.agents/skills', injection.target, 'SKILL.md'));
        const text = content.toString('utf8');
        for (const edge of ['start', 'end']) {
          const marker = `<!-- aif-ext:${manifest.name}:${injection.target}:${injection.position}:${edge} -->`;
          assert.equal(text.split(marker).length - 1, 1, `${pass}/${injection.target}/${edge}`);
        }
        const original = base.get(injection.target);
        // Upstream inserts prepend after frontmatter; remove exactly its known
        // marker block and require byte equality with the rendered baseline
        // (no normalization).
        assert.ok(Buffer.from(stripInjection(text, manifest.name, injection.target, injection.position)).equals(original), injection.target);
      }
    }
    // Strip scans skillsDir + workflows/rules, never the entire runtime configDir.
    const marker = '<!-- aif-ext:aifhub-extension:probe:prepend:start -->\nprobe\n<!-- aif-ext:aifhub-extension:probe:prepend:end -->\n';
    for (const relative of ['.codex/workflows/probe.md', '.codex/rules/probe.md', '.codex/agents/unmanaged.md']) {
      await fs.mkdir(path.dirname(path.join(project, relative)), { recursive: true });
      await fs.writeFile(path.join(project, relative), marker);
    }
    await ops.stripInjectionsForAllAgents(project, config.agents, manifest.name);
    for (const relative of ['.codex/workflows/probe.md', '.codex/rules/probe.md'])
      assert.equal((await fs.readFile(path.join(project, relative), 'utf8')).includes('aif-ext:'), false);
    assert.equal(await fs.readFile(path.join(project, '.codex/agents/unmanaged.md'), 'utf8'), marker);
  });

  await t.test('commitResolvedExtension rollback includes injection-only targets', async () => {
    const project = await create('rollback');
    await fs.mkdir(path.join(project, '.agents'));
    const config = { version: '2.23.0', agents: [agent('codex', '.agents/skills', ['aif-plan']),
      agent('codex-app', '.agents/skills', ['aif-plan'])], extensions: [] };
    await ops.installSkillsForAllAgents(project, config.agents, ['aif-plan']);
    await saveConfig(project, config, { hydrateAgentFileSources: false });
    const source = path.join(project, 'source');
    await fs.mkdir(source);
    const probe = { name: 'aifhub-rollback-probe', version: '1.0.0',
      injections: [{ target: 'aif-plan', position: 'prepend', file: 'injection.md' }],
      mcpServers: [{ key: 'broken', template: {} }] };
    await fs.writeFile(path.join(source, 'extension.json'), JSON.stringify(probe));
    await fs.writeFile(path.join(source, 'injection.md'), 'rollback probe');
    const before = await snapshot(path.join(project, '.agents/skills'));
    await assert.rejects(ops.commitResolvedExtension(project, { config, source,
      resolved: { sourceDir: source, manifest: probe, cleanup: async () => {} } }), /MCP|template/i);
    assert.deepEqual(await snapshot(path.join(project, '.agents/skills')), before);
  });

  async function legacy(name) {
    const project = await create(name);
    const codex = agent('codex', '.codex/skills', ['aif']);
    await installer.installSkills({ projectDir: project, agentId: codex.id, skillsDir: codex.skillsDir, skills: codex.installedSkills });
    codex.managedSkills = await installer.buildManagedSkillsState(project, codex, codex.installedSkills);
    const config = { version: '2.19.0', agents: [codex] };
    await saveConfig(project, config, { hydrateAgentFileSources: false });
    await fs.mkdir(path.join(project, '.agents'));
    return { project, config };
  }
  await t.test('proven legacy skills migrate to shared target with rendered receipts', async () => {
    const { project, config } = await legacy('migration');
    await migration.prepareSkillTargets(project, config);
    assert.equal(config.agents[0].skillsDir, '.agents/skills');
    const text = await fs.readFile(path.join(project, '.agents/skills/aif/SKILL.md'), 'utf8');
    assert.ok(text.includes('.agents/skills/'));
  });
  for (const mode of ['unknown-file', 'modified']) {
    await t.test(`migration fails closed without writes on ${mode}`, async () => {
      const { project, config } = await legacy(mode);
      const skill = path.join(project, '.codex/skills/aif');
      if (mode === 'unknown-file') await fs.writeFile(path.join(skill, 'local-note'), 'unmanaged');
      else await fs.appendFile(path.join(skill, 'SKILL.md'), '\nmodified');
      const before = await snapshot(project);
      await assert.rejects(migration.preflightSkillMigration(project, config), /known source|unknown|differ|unproven/i);
      assert.deepEqual(await snapshot(project), before);
    });
  }
  for (const where of ['source', 'destination']) {
    await t.test(`linked ${where} entry rejects before writing either tree`, async () => {
      const { project, config } = await legacy(`linked-${where}`);
      const entry = path.join(project, where === 'source' ? '.codex/skills/aif' : '.agents/skills/aif');
      const unmanaged = path.join(project, 'unmanaged');
      await fs.mkdir(unmanaged);
      await fs.writeFile(path.join(unmanaged, 'private'), 'preserve');
      if (where === 'source') await fs.rm(entry, { recursive: true });
      await fs.mkdir(path.dirname(entry), { recursive: true });
      await fs.symlink(unmanaged, entry, process.platform === 'win32' ? 'junction' : 'dir');
      const before = await snapshot(project);
      await assert.rejects(migration.preflightSkillMigration(project, config), /linked entry/);
      assert.deepEqual(await snapshot(project), before);
    });
  }
});
