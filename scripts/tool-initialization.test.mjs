import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { initializeEnabledTools, syncArtifacts, switchToAiFactoryMode, switchToOpenSpecMode } from './aif-artifact-sync.mjs';
import { runModeCommand } from './aif-mode.mjs';
import { initializeHlvProject, inspectHlvLayout } from './tool-initialization.mjs';

const roots = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 5 }); });
async function fixture(openspec = true, hlv = true) {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'aifhub-init-'));
  roots.push(rootDir);
  await put(rootDir, '.ai-factory/config.yaml', `aifhub:\n  tools:\n    openspec: ${openspec}\n    hlv: ${hlv}\n    lekalo: false\n`);
  return rootDir;
}
async function put(root, relative, text) {
  const target = path.join(root, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, text);
}
function nativeFixture(calls, version = '1.0.0') {
  return async (executable, args, options) => {
    calls.push(args);
    assert.equal(executable, 'hlv');
    if (args[0] === '--version') return { outcome: 'completed', exitCode: 0, stdout: `hlv ${version}\n`, stderr: '' };
    assert.equal(args[0], 'init');
    assert.equal(args[1], '--adopt');
    assert.equal(args[args.indexOf('--path') + 1], options.cwd);
    assert.equal(args[args.indexOf('--agent') + 1], 'agents');
    await put(options.cwd, '.hlv/project.yaml', 'schema_version: 1\nproject: existing-app\nhlv_root: .hlv\n');
    return { outcome: 'completed', exitCode: 0, stdout: 'private fixture setup output', stderr: '' };
  };
}
for (const openspec of [false, true]) for (const hlv of [false, true]) {
  test(`init creates only enabled tools openspec=${openspec} hlv=${hlv} and is idempotent`, async () => {
    const rootDir = await fixture(openspec, hlv);
    await put(rootDir, 'src/main.js', 'original source\n');
    await put(rootDir, 'AGENTS.md', 'original instructions\n');
    const calls = [];
    const options = { rootDir, runProcess: nativeFixture(calls) };
    const first = await initializeEnabledTools(options);
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(JSON.stringify(first).includes('private'), false);
    assert.equal(await inspectHlvLayout(rootDir), hlv ? 'adopt' : null);
    assert.equal((await readdir(rootDir)).includes('openspec'), openspec);
    if (openspec) assert.match(await readFile(path.join(rootDir, 'openspec/config.yaml'), 'utf8'), /^schema: spec-driven\n/);
    const second = await initializeEnabledTools(options);
    assert.equal(second.ok, true);
    assert.equal(calls.filter(args => args[0] === 'init').length, hlv ? 1 : 0);
    assert.equal(await readFile(path.join(rootDir, 'src/main.js'), 'utf8'), 'original source\n');
    assert.equal(await readFile(path.join(rootDir, 'AGENTS.md'), 'utf8'), 'original instructions\n');
  });
}
for (const layout of ['greenfield', 'adopt']) test(`existing ${layout} HLV is reused with OpenSpec without init or path rewrites`, async () => {
  const rootDir = await fixture();
  const marker = layout === 'greenfield' ? 'project.yaml' : '.hlv/project.yaml';
  const content = 'schema_version: 1\nproject: existing-app\npaths:\n  llm:\n    src: custom/source/\n';
  await put(rootDir, marker, content);
  await put(rootDir, 'human/milestones/001-existing/plan.md', 'existing HLV milestone\n');
  await put(rootDir, 'openspec/config.yaml', 'schema: custom-schema\ncontext: existing\n');
  const result = await initializeEnabledTools({ rootDir, runProcess: () => { throw new Error('must not reinit'); } });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.hlv.state, 'preserved');
  assert.equal(result.hlv.layout, layout);
  assert.equal(await readFile(path.join(rootDir, marker), 'utf8'), content);
  assert.equal(await readFile(path.join(rootDir, 'openspec/config.yaml'), 'utf8'), 'schema: custom-schema\ncontext: existing\n');
  assert.equal(await readFile(path.join(rootDir, 'human/milestones/001-existing/plan.md'), 'utf8'), 'existing HLV milestone\n');
  if (layout === 'greenfield') await assert.rejects(stat(path.join(rootDir, '.hlv')));
});
test('dry run and status do not initialize tools; init rejects unrelated mutation flags', async () => {
  const rootDir = await fixture();
  const mustNotRun = () => { throw new Error('must not execute'); };
  const result = await runModeCommand(['init', '--dry-run', '--json'], { rootDir, runProcess: mustNotRun });
  assert.equal(result.exitCode, 0);
  assert.equal(JSON.parse(result.stdout).hlv.state, 'would-create');
  assert.deepEqual((await readdir(rootDir)).sort(), ['.ai-factory']);
  const status = await runModeCommand(['status', '--json'], { rootDir, runProcess: mustNotRun,
    detectOpenSpec: async () => ({ available: false }), getCurrentBranch: async () => 'main' });
  assert.equal(status.exitCode, 0);
  assert.deepEqual((await readdir(rootDir)).sort(), ['.ai-factory']);
  for (const flag of ['--yes', '--all', '--export-openspec', '--current']) {
    assert.equal((await runModeCommand(['init', flag], { rootDir })).exitCode, 2);
  }
});
test('unsupported CLI, failed process, ambiguous or partial layouts never report initialization success', async () => {
  const rootDir = await fixture(false);
  assert.equal((await initializeHlvProject({ rootDir, runProcess: nativeFixture([], '0.3.0') })).ok, false);
  await assert.rejects(stat(path.join(rootDir, '.hlv')));
  const failure = await initializeHlvProject({ rootDir, runProcess: async (_, args) => args[0] === '--version'
    ? { outcome: 'completed', exitCode: 0, stdout: 'hlv 1.0.0', stderr: '' }
    : { outcome: 'timeout', exitCode: null, stdout: 'private path', stderr: 'secret' } });
  assert.equal(failure.ok, false);
  assert.doesNotMatch(JSON.stringify(failure), /private|secret/);
  await put(rootDir, '.hlv/human/retained.md', 'partial');
  assert.equal((await initializeHlvProject({ rootDir, runProcess: nativeFixture([]) })).ok, false);
  await put(rootDir, '.hlv/project.yaml', 'schema_version: 1\nproject: adopted\n');
  await put(rootDir, 'project.yaml', 'schema_version: 1\nproject: root\n');
  assert.equal((await initializeHlvProject({ rootDir, runProcess: nativeFixture([]) })).ok, false);
});
test('unsafe OpenSpec or HLV paths block initialization before external writes', async () => {
  for (const target of ['openspec', '.hlv', '.agents']) {
    const rootDir = await fixture();
    const external = await fixture(false, false);
    await symlink(external, path.join(rootDir, target), process.platform === 'win32' ? 'junction' : 'dir');
    const before = await readdir(external);
    const calls = [];
    assert.equal((await initializeEnabledTools({ rootDir, runProcess: nativeFixture(calls) })).ok, false);
    assert.deepEqual(calls, []);
    assert.deepEqual(await readdir(external), before);
  }
});
test('a file at the shared skills directory blocks native initialization before any writes', async () => {
  const rootDir = await fixture();
  await put(rootDir, '.agents/skills', 'existing file');
  const calls = [];
  const result = await initializeEnabledTools({ rootDir, runProcess: nativeFixture(calls) });
  assert.equal(result.ok, false);
  assert.deepEqual(calls, []);
  await assert.rejects(stat(path.join(rootDir, '.hlv')));
  await assert.rejects(stat(path.join(rootDir, 'openspec')));
  assert.equal(await readFile(path.join(rootDir, '.agents/skills'), 'utf8'), 'existing file');
});
test('mode switches and sync initialize an enabled missing HLV project', async () => {
  for (const action of [switchToOpenSpecMode, switchToAiFactoryMode, syncArtifacts]) {
    const rootDir = await fixture();
    const calls = [];
    const result = await action({ rootDir, runProcess: nativeFixture(calls), all: true, writeReport: false,
      detectOpenSpec: async () => ({ available: false }), getCurrentBranch: async () => 'main' });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(calls.filter(args => args[0] === 'init').length, 1);
  }
});
