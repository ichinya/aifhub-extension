// Diagnostic kernel probe, NOT a VS Code UI/session smoke.
// node client-kernel.mjs PINNED_SOURCE_DIR CANDIDATES_DIR BASELINE NEW_SCRATCH
// Sources: microsoft/vscode@645f29cc3176500b4b5762ba887cf2a7f0ffdf2c.
// Executes unchanged selected parser/discovery functions with a filesystem adapter.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import { createHash } from 'node:crypto';

const [sources, candidates, baseline, scratch] = process.argv.slice(2).map(p => path.resolve(p));
fs.mkdirSync(scratch); // Fail if an earlier result would be overwritten.
const expected = {
  'yaml.ts': '6a1b91e893b0ae191cd218956170a6477f6fe3dcd25df36b1b40f59805f1fbe8',
  'agentPluginParser.ts': '74ac06b34f3cfaf14310b71a1758be36ce813440ce6f1a1ba36db9c837eacd35',
  'pluginParsers.ts': 'b9d8442f6a35e3ec620cff516bf92833a5e373d6b8a53f204f8062e7938cb21f'
};
const read = file => {
  const bytes = fs.readFileSync(path.join(sources, file));
  if (createHash('sha256').update(bytes).digest('hex') !== expected[file]) throw new Error(`Pinned source digest mismatch: ${file}`);
  return bytes.toString('utf8');
};
const parsers = read('pluginParsers.ts');
function section(start, end) {
  const a = parsers.indexOf(start), b = parsers.indexOf(end, a);
  if (a < 0 || b < a) throw new Error('Pinned source layout changed');
  return parsers.slice(a, b);
}
const yaml = read('yaml.ts').replace(/^import .*;\r?\n/gm, '');
const manifest = read('agentPluginParser.ts').replace(/^import .*;\r?\n/gm, '');
const selected = section('export async function readSkills(', 'export async function readMarkdownComponents(')
  + section('export async function parseSkillFile(', 'export async function parseRuleFile(');
const ts = yaml + '\n' + manifest + '\n' + selected;
const js = stripTypeScriptTypes(ts, { mode: 'transform' }).replace(/^export /gm, '');
const context = vm.createContext({
  // Valid JSON fixtures only; JSONC compatibility is outside this probe.
  parseJSONC: JSON.parse, localize: (_key, message) => message,
  URI: { joinPath: path.join }, joinPath: path.join,
  basename: path.basename, dirname: path.dirname, normalizePath: path.normalize,
  isEqualOrParent: (child, parent) => { const rel = path.relative(parent, child); return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + path.sep)); },
  PluginFormat: { AgentPlugin: 'agent-plugin' },
  pathExists: async uri => fs.existsSync(uri)
});
vm.runInContext(js + '\nglobalThis.api = { readAgentPluginManifest, readPluginSkills, parseSkillFile, toSkillInvocationFlags };', context);
const fileService = {
  exists: async uri => fs.existsSync(uri),
  readFile: async uri => ({ value: fs.readFileSync(uri) }),
  realpath: async uri => fs.realpathSync(uri),
  resolve: async uri => ({ isDirectory: fs.statSync(uri).isDirectory(), children: fs.readdirSync(uri).map(name => ({ resource: path.join(uri, name) })) })
};
const rows = [];
for (const variant of ['original', 'normalized']) {
  const root = path.join(scratch, variant);
  fs.mkdirSync(path.join(root, 'skills'), { recursive: true });
  for (const name of ['aif-analyze', 'aif-done', 'aif-mode']) {
    fs.cpSync(path.join(candidates, variant, name), path.join(root, 'skills', name), { recursive: true });
  }
  fs.cpSync(path.join(baseline, 'skills', 'shared'), path.join(root, 'skills', 'shared'), { recursive: true });
  fs.writeFileSync(path.join(root, 'plugin.json'), JSON.stringify({ $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json', name: 'aifhub-extension' }));
  const manifest = await context.api.readAgentPluginManifest(root, fileService);
  const skills = await context.api.readPluginSkills(root, [path.join(root, 'skills')], { format: 'agent-plugin' }, fileService);
  rows.push({ variant, manifest_recognized: Boolean(manifest), skills: skills.map(({ uri, ...rest }) => rest) });
}
const protectedSkill = path.join(candidates, 'preserve_invocation', 'aif-mode', 'SKILL.md');
const parsed = await context.api.parseSkillFile(protectedSkill, fileService);
rows.push({ variant: 'preserve_invocation', skill: parsed.name, flags: context.api.toSkillInvocationFlags(parsed.userInvocable, parsed.disableModelInvocation) });
console.log(JSON.stringify({
  vscode_commit: '645f29cc3176500b4b5762ba887cf2a7f0ffdf2c', node: process.version,
  source_sha256: Object.fromEntries(['yaml.ts', 'agentPluginParser.ts', 'pluginParsers.ts'].map(f => [f, createHash('sha256').update(fs.readFileSync(path.join(sources, f))).digest('hex')])),
  kind: 'selected-source-kernel-with-filesystem-adapter', full_client_loads: 'NOT_RUN', rows
}, null, 2));
