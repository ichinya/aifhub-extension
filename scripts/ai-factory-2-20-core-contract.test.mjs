// Opt-in offline exact-tag core checks. No CLI, package download, or live smoke.
import { it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const upstream = process.env.AIFHUB_TEST_AI_FACTORY_220_ROOT;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

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

it('AI Factory 2.20 offline core: AIFHub ownership, grouped compose, rollback and migration custody', {
  skip: !upstream && 'NOTRUN: set AIFHUB_TEST_AI_FACTORY_220_ROOT to a built, exact 2.20.0 tag tree'
}, async t => {
  const load = relative => import(pathToFileURL(path.join(upstream, 'dist', relative)).href);
  const ops = await load('core/extension-ops.js');
  const migration = await load('core/skills-migration.js');
  const installer = await load('core/installer.js');
  const targets = await load('core/skill-targets.js');
  const { stripInjection } = await load('core/injections.js');
  const { saveConfig } = await load('core/config.js');
  const manifest = JSON.parse(await fs.readFile(path.join(repo, 'extension.json'), 'utf8'));
  assert.equal(JSON.parse(await fs.readFile(path.join(upstream, 'package.json'), 'utf8')).version, '2.20.0');
  const schema = await fs.readFile(path.join(upstream, 'schemas/extension.schema.json'));
  assert.equal(createHash('sha1').update(`blob ${schema.length}\0`).update(schema).digest('hex'),
    'a82b8a0b834df2047e71857476f72ed66c6472d7');
  assert.deepEqual(await fs.readFile(path.join(repo, 'schemas/extension.schema.json')), schema);
  const temp = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'aifhub-220-core-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const agent = (id, skillsDir, installedSkills) => ({ id, skillsDir, installedSkills, mcp: {} });
  const create = async name => { const dir = path.join(temp, name); await fs.mkdir(dir); return dir; };

  await t.test('real release SKILL.md sentinels remain strict', async () => {
    const skill = name => fs.readFile(path.join(upstream, 'skills', name, 'SKILL.md'), 'utf8');
    const implement = await skill('aif-implement');
    assert.equal(implement.split('Run the requirement consistency gate').length - 1, 1);
    assert.ok(implement.includes('ERROR [requirement-conflict]'));
    assert.equal((await skill('aif-review')).split('Language: `en` (English)').length - 1, 1);
    assert.ok((await skill('aif-qa-check')).includes('browser-replay'));
    await skill('aif-warmup');
  });

  await t.test('actual grouped targets compose AIFHub markers exactly once and preserve rendered base', async () => {
    const project = await create('shared');
    await fs.mkdir(path.join(project, '.agents'));
    const names = [...new Set(manifest.injections.map(i => i.target))];
    const config = { version: '2.20.0', agents: [agent('codex', '.agents/skills', names),
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
        // marker block and require byte equality with the rendered baseline.
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
    const config = { version: '2.20.0', agents: [agent('codex', '.agents/skills', ['aif-plan']),
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
