// Research prototype on trusted local snapshots. Not an installer/export command.
// node remediation.mjs BASELINE AI_FACTORY_ENTRY PINNED_PYTHON
// All writes and MCP activity stay in new OS temporary fixture directories.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

assert.equal(process.argv.length, 5, 'Usage: node remediation.mjs BASELINE AI_FACTORY_ENTRY PINNED_PYTHON');
const [baseline, cli, python] = process.argv.slice(2).map(p => path.resolve(p));
const revision = '02d3f68538abc9ac1712e3396eb69eca74f9e830';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const cliPackage = JSON.parse(fs.readFileSync(path.resolve(path.dirname(cli), '../package.json')));
assert.equal(cliPackage.name, 'ai-factory');
assert.equal(cliPackage.version, '2.19.0');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aifhub-remediation-'));
console.error(`Research scratch: ${root}`);
const bundle = path.join(root, 'portable-subset');
fs.mkdirSync(bundle);
for (const name of ['aif-analyze', 'aif-done', 'shared']) {
  fs.cpSync(path.join(baseline, 'skills', name), path.join(bundle, 'skills', name), { recursive: true });
}
const normalizations = [];
for (const name of ['aif-analyze', 'aif-done']) {
  const file = path.join(bundle, 'skills', name, 'SKILL.md');
  const content = fs.readFileSync(file, 'utf8');
  const match = /^---\r?\n([\s\S]*?)\r?\n---([\s\S]*)$/.exec(content);
  assert.ok(match, name);
  assert.ok(!/^metadata:|^disable-model-invocation:/m.test(match[1]), 'Unexpected source shape; do not silently drop invocation policy');
  const moved = [];
  const lines = match[1].split(/\r?\n/).filter(line => {
    if (/^(author|version|argument-hint):/.test(line)) { moved.push(line); return false; }
    return true;
  });
  lines.push('compatibility: Requires AI Factory 2.19.0 and registered AIFHub 1.7.0 in the explicitly selected project.');
  lines.push('metadata:');
  for (const line of moved) {
    const [key, ...rest] = line.split(':');
    const raw = rest.join(':').trim();
    const value = raw.startsWith('"') ? JSON.parse(raw) : raw;
    lines.push(`  aifhub.source.${key}: ${JSON.stringify(value)}`);
  }
  const preflight = '\n\n## Exported subset prerequisites\n\nBefore following this skill, establish the explicitly selected project root and its registered AIFHub installation. Resolve CLI commands, runtime helper paths and repository-relative prose paths from that installed extension, not from the plugin package. Do not create missing helpers or install dependencies automatically. Shared guides link to pinned source documentation; the matching installed extension documentation is the offline fallback. Stop if the required installed version or guide is unavailable. The separate aif-mode skill remains user-invoked through the canonical installation.\n';
  fs.writeFileSync(file, `---\n${lines.join('\n')}\n---${preflight}${match[2]}`);
  normalizations.push({ skill: name, fields: moved.map(line => line.split(':')[0]), source_sha256: hash(Buffer.from(content)) });
}
const rewrites = [];
for (const [name, from, target] of [
  ['ISOLATED-EXECUTION.md', '../../docs/isolated-execution.md', 'docs/isolated-execution.md'],
  ['TASK-COORDINATION.md', '../../docs/workflow-mechanics.md', 'docs/workflow-mechanics.md']
]) {
  const file = path.join(bundle, 'skills', 'shared', name);
  const content = fs.readFileSync(file, 'utf8');
  assert.equal(content.split(`](${from})`).length - 1, 1);
  const url = `https://github.com/ichinya/aifhub-extension/blob/${revision}/${target}`;
  fs.writeFileSync(file, content.replace(`](${from})`, `](${url})`));
  rewrites.push({ file: `skills/shared/${name}`, from, to: url, installed_extension_fallback: `.ai-factory/extensions/aifhub-extension/${target}` });
}
fs.writeFileSync(path.join(bundle, 'plugin.json'), JSON.stringify({
  $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json', name: 'aifhub-extension', version: '1.7.0',
  description: 'Research subset for an already installed project-bound AIFHub extension.'
}, null, 2) + '\n');
const report = {
  source_revision: revision, profile: 'research-strict-subset',
  included_skills: ['aif-analyze', 'aif-done'],
  excluded: [
    { surface: 'aif-mode', reason: 'manual-only policy retained in canonical installed extension; never normalized into auto-loadable skill' },
    { surface: 'mcp.json', reason: 'MCP uses an explicit native host project binding; not exported as a portable server' },
    { surface: 'commands,injections,agentFiles,config defaults,validation providers', reason: 'owned by installed AI Factory extension; workflow prerequisites' }
  ],
  prerequisites: ['AI Factory 2.19.0 and registered AIFHub 1.7.0 in the selected project', 'Resolve runtime helpers and prose paths from the installed extension', 'Pinned external guides or matching installed documentation must be available; otherwise stop'],
  rewrites, full_workflow_semantics: 'NOT_RUN', full_client_loads: 'NOT_RUN'
};
fs.writeFileSync(path.join(bundle, 'compatibility-report.json'), JSON.stringify(report, null, 2) + '\n');
fs.writeFileSync(path.join(bundle, 'README.md'), '# Research subset\n\nRequires AI Factory 2.19.0 and registered AIFHub 1.7.0 in the selected project.\n\nBefore following either skill, resolve all CLI commands, runtime helpers and repository-root paths in the installed extension. Do not create missing helpers in the package or project. Shared guides use pinned online documentation; matching installed documentation is the offline fallback. Stop when both are unavailable.\n\n`aif-mode` remains user-invoked through the canonical installation. MCP is host-bound separately. Exclusions are recorded in compatibility-report.json. This is not a standalone workflow distribution.\n');
const validations = report.included_skills.map(name => {
  const dir = path.join(bundle, 'skills', name);
  const result = spawnSync(python, ['-X', 'utf8', '-m', 'skills_ref.cli', 'validate', dir], { encoding: 'utf8', timeout: 15000 });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr);
  return { skill: name, exit: result.status, stdout: result.stdout.trim().replaceAll(dir, '<skill>') };
});
assert.ok(!fs.existsSync(path.join(bundle, 'skills/aif-mode')));
assert.ok(!fs.existsSync(path.join(bundle, 'mcp.json')));

const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'aifhub-binding-probe', version: '1' } } };
const read = { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'read_file_deduplicated', arguments: { path: 'binding-probe.txt' } } };
const input = [initialize, { jsonrpc: '2.0', method: 'notifications/initialized' }, read].map(JSON.stringify).join('\n') + '\n';
const projects = {};
for (const name of ['selected', 'other']) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir);
  fs.cpSync(baseline, path.join(dir, '.ai-factory/extensions/aifhub-extension'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.ai-factory.json'), JSON.stringify({ version: '2.19.0', agents: [], extensions: [{ name: 'aifhub-extension', source: 'local-fixture' }] }));
  fs.writeFileSync(path.join(dir, 'binding-probe.txt'), name + '-project');
  projects[name] = dir;
}
function launch(name, cwd, override) {
  const env = { ...process.env };
  delete env.AIFHUB_PROJECT_ROOT;
  if (override) env.AIFHUB_PROJECT_ROOT = override;
  const result = spawnSync(process.execPath, [cli, 'aifhub-mcp'], { cwd, env, input, encoding: 'utf8', timeout: 30000 });
  if (result.error) throw result.error;
  const responses = result.stdout.trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  return { case: name, exit: result.status, handshake: responses.some(row => row.id === 1 && row.result?.serverInfo?.name === 'aifhub-mcp'),
    errors: responses.filter(row => row.error || row.result?.isError),
    content: responses.find(row => row.id === 2)?.result?.content?.[0]?.text ?? null,
    stderr: result.stderr.trim().replaceAll(root, '<scratch>') };
}
const mcp = [
  launch('plugin-root-without-binding', bundle),
  launch('env-only-does-not-register-command', bundle, projects.selected),
  launch('selected-project-cwd', projects.selected),
  launch('stale-override-reads-other-project', projects.selected, projects.other),
  launch('explicit-cwd-and-env-agree', projects.selected, projects.selected)
];
for (const result of mcp.slice(0, 2)) {
  assert.equal(result.exit, 1, result.case);
  assert.equal(result.handshake, false, result.case);
  assert.equal(result.content, null, result.case);
  assert.match(result.stderr, /unknown command/i, result.case);
}
for (const result of mcp.slice(2)) {
  assert.equal(result.exit, 0, result.case);
  assert.equal(result.handshake, true, result.case);
  assert.deepEqual(result.errors, [], result.case);
}
assert.equal(mcp[2].content, 'selected-project'); assert.equal(mcp[3].content, 'other-project');
assert.equal(mcp[4].content, 'selected-project'); assert.equal(mcp[4].handshake, true);
const inventory = [];
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(file);
    else inventory.push({ file: path.relative(bundle, file).split(path.sep).join('/'), bytes: fs.statSync(file).size, sha256: hash(fs.readFileSync(file)) });
  }
}
walk(bundle); inventory.sort((a, b) => a.file.localeCompare(b.file, 'en'));
console.log(JSON.stringify({ source_revision: revision, node: process.version, ai_factory: cliPackage.version,
  normalizations, report, validations, mcp, bundle_files: inventory.length,
  bundle_bytes: inventory.reduce((sum, item) => sum + item.bytes, 0), inventory }, null, 2));
