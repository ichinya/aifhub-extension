// ponytail-pi-ab.test.mjs - deterministic contracts for the isolated Pi benchmark
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  PONYTAIL_CONDITIONS,
  buildPiInvocation,
  buildPonytailPiMatrix,
  cloneGitSnapshot,
  loadPonytailPiCatalog,
  preparePonytailPiMatrix,
  renderCasePrompt,
  summarizePiJson,
  validatePonytailPiCatalog
} from './ponytail-pi-ab.mjs';

const execFileAsync = promisify(execFile);
let tempDir;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'ponytail-pi-ab-'));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe('Ponytail Pi A/B catalog', () => {
  it('pins Pi, Qwen, four repetitions, exact source revisions, and both task shapes', async () => {
    const catalog = await loadPonytailPiCatalog({ cwd: process.cwd() });
    assert.equal(catalog.defaults.runtime, 'pi');
    assert.equal(catalog.defaults.runtime_version, '0.84.4');
    assert.equal(catalog.defaults.provider, 'omniroute');
    assert.equal(catalog.defaults.model, 'lq/qwen3.8-27b');
    assert.equal(catalog.defaults.thinking, 'low');
    assert.equal(catalog.defaults.repetitions, 4);
    assert.deepEqual(catalog.defaults.conditions, PONYTAIL_CONDITIONS);
    assert.equal(catalog.ponytail.source_commit, '0a4dd63ad4541f4f655c4108a295916f3c1d8fda');
    assert.deepEqual(new Set(catalog.scenarios.map((item) => item.shape)), new Set(['over-build', 'security-correctness']));
    assert.deepEqual(
      catalog.fixtures.map((item) => item.source_commit),
      ['24a55ce21aa6a525dd3bd215b13b2af8ef2e14a8', 'd643d48ff84c098079f02576a115da3e61135579']
    );
    assert.deepEqual(catalog.fixtures[0].validation[0].args, ['test', '-skip', 'OpenSSL', './...']);
    assert.match(catalog.scenarios[1].task, /external-OpenSSL interoperability tests are excluded/);
    assert.doesNotMatch(JSON.stringify(catalog), /D:\\projects|[A-Za-z]:\\Users\\|BEGIN PRIVATE KEY/i);
  });

  it('rejects incomplete pairing, weak repetition counts, unsafe paths, and private task material', async () => {
    const catalog = await loadPonytailPiCatalog({ cwd: process.cwd() });
    const unsafe = structuredClone(catalog);
    unsafe.defaults.conditions = ['ponytail_full'];
    unsafe.defaults.repetitions = 1;
    unsafe.fixtures[0].source_directory = '../passkey';
    unsafe.scenarios[0].task = 'token=secret-value';
    const errors = validatePonytailPiCatalog(unsafe);
    assert.ok(errors.some((item) => item.includes('defaults.conditions')));
    assert.ok(errors.some((item) => item.includes('defaults.repetitions')));
    assert.ok(errors.some((item) => item.includes('source_directory')));
    assert.ok(errors.some((item) => item.includes('private-looking material')));
  });
});

describe('Ponytail Pi A/B matrix', () => {
  it('builds sixteen paired cases with stable task/settings fingerprints and balanced arm order', async () => {
    const catalog = await loadPonytailPiCatalog({ cwd: process.cwd() });
    const matrix = buildPonytailPiMatrix({
      catalog,
      runId: 'ponytail-lq-low-test',
      generatedAt: '2026-09-01T00:00:00.000Z'
    });
    assert.equal(matrix.cases.length, 16);
    assert.equal(new Set(matrix.cases.map((item) => item.id)).size, 16);
    for (const pairId of new Set(matrix.cases.map((item) => item.pair_id))) {
      const pair = matrix.cases.filter((item) => item.pair_id === pairId);
      assert.equal(pair.length, 2);
      assert.deepEqual(new Set(pair.map((item) => item.condition)), new Set(PONYTAIL_CONDITIONS));
      assert.equal(new Set(pair.map((item) => item.task_fingerprint)).size, 1);
      assert.equal(new Set(pair.map((item) => item.settings_fingerprint)).size, 1);
      assert.equal(new Set(pair.map((item) => item.fixture_commit)).size, 1);
    }
    for (const scenarioId of new Set(matrix.cases.map((item) => item.scenario_id))) {
      const scenarioCases = matrix.cases.filter((item) => item.scenario_id === scenarioId);
      assert.equal(scenarioCases[0].condition, 'baseline');
      assert.equal(scenarioCases[2].condition, 'ponytail_full');
      assert.equal(scenarioCases[4].condition, 'baseline');
      assert.equal(scenarioCases[6].condition, 'ponytail_full');
    }
  });

  it('changes only explicit skill loading and treatment text between Pi arms', async () => {
    const catalog = await loadPonytailPiCatalog({ cwd: process.cwd() });
    const matrix = buildPonytailPiMatrix({ catalog, runId: 'ponytail-lq-low-test' });
    const baseline = matrix.cases.find((item) => item.condition === 'baseline');
    const candidate = matrix.cases.find((item) => item.pair_id === baseline.pair_id && item.condition === 'ponytail_full');
    const baselineRun = buildPiInvocation(baseline, { ponytailSkillPath: 'C:\\temp\\ponytail\\SKILL.md' });
    const candidateRun = buildPiInvocation(candidate, { ponytailSkillPath: 'C:\\temp\\ponytail\\SKILL.md' });

    for (const expected of [
      '--provider', '--model', '--thinking', '--mode', '--print', '--no-session', '--no-extensions', '--no-skills',
      '--no-prompt-templates', '--no-themes', '--no-context-files', '--no-approve', '--tools', '--exclude-tools'
    ]) {
      assert.ok(baselineRun.args.includes(expected), `baseline missing ${expected}`);
      assert.ok(candidateRun.args.includes(expected), `candidate missing ${expected}`);
    }
    assert.equal(baselineRun.args.includes('--skill'), false);
    assert.equal(candidateRun.args[candidateRun.args.indexOf('--skill') + 1], 'C:\\temp\\ponytail\\SKILL.md');
    assert.equal(baseline.provider, 'omniroute');
    assert.equal(baseline.model, 'lq/qwen3.8-27b');
    assert.match(renderCasePrompt(candidate), /Ponytail skill in full mode/);
    assert.doesNotMatch(renderCasePrompt(baseline), /Ponytail|optional implementation skill/);
    assert.equal(baseline.task, candidate.task);
  });

  it('extracts final provider usage and tool-call count without retaining assistant text', () => {
    const summary = summarizePiJson([
      JSON.stringify({ type: 'session', version: 3 }),
      JSON.stringify({ type: 'tool_execution_start', toolCallId: '1', toolName: 'read', args: {} }),
      JSON.stringify({ type: 'message_update', usage: { input: 10, output: 2 } }),
      JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'private output' }], usage: { input: 10, output: 5, cost: { total: 0.01 } } } })
    ].join('\n'));
    assert.equal(summary.event_count, 4);
    assert.equal(summary.tool_calls, 1);
    assert.deepEqual(summary.provider_usage, { input: 10, output: 5, cost: { total: 0.01 } });
    assert.doesNotMatch(JSON.stringify(summary), /private output/);
  });
});

describe('Ponytail Pi A/B preparation safety', () => {
  it('materializes clean committed snapshots into fresh case directories and leaves inputs unchanged', async () => {
    const referencesRoot = path.join(tempDir, 'references');
    const ponytailRoot = path.join(tempDir, 'ponytail');
    await mkdir(referencesRoot, { recursive: true });
    const passkeyCommit = await createGitFixture(path.join(referencesRoot, 'passkey'), {
      'go/encrypt.go': 'package main\n',
      'go/go.mod': 'module example/passkey\n\ngo 1.22\n'
    });
    const yougileCommit = await createGitFixture(path.join(referencesRoot, 'yougile-mcp'), {
      'src/common/request-helper.ts': 'export const value = 1;\n',
      'package.json': '{"type":"module"}\n',
      'package-lock.json': '{"lockfileVersion":3}\n'
    });
    const ponytailCommit = await createGitFixture(ponytailRoot, {
      'skills/ponytail/SKILL.md': '---\nname: ponytail\n---\n# Ponytail\n'
    });
    const catalog = await loadPonytailPiCatalog({ cwd: process.cwd() });
    catalog.fixtures[0].source_commit = passkeyCommit;
    catalog.fixtures[1].source_commit = yougileCommit;
    catalog.ponytail.source_commit = ponytailCommit;
    delete catalog.source_path;
    const catalogPath = path.join(tempDir, 'catalog.json');
    await writeFile(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8');
    const outDir = path.join(tempDir, 'runs', 'matrix');
    await mkdir(path.dirname(outDir), { recursive: true });

    const prepared = await preparePonytailPiMatrix({
      catalogPath,
      runId: 'ponytail-lq-low-test',
      referencesRoot,
      ponytailRoot,
      outDir,
      cloneSnapshotFn: async (source, target) => cp(source, target, { recursive: true }),
      cwd: process.cwd()
    });

    assert.equal(prepared.prepared_cases, 16);
    const summary = JSON.parse(await readFile(path.join(outDir, 'matrix-summary.json'), 'utf8'));
    assert.equal(summary.cases.length, 16);
    assert.match(summary.ponytail.copied_skill_sha256, /^[0-9a-f]{64}$/);
    const firstCase = summary.cases[0];
    assert.equal(
      (await execFileAsync('git', ['-C', path.join(outDir, ...firstCase.project_path.split('/')), 'rev-parse', 'HEAD'])).stdout.trim(),
      firstCase.fixture_commit
    );
    const candidateCase = summary.cases.find((item) => item.condition === 'ponytail_full');
    const invocation = await readFile(path.join(outDir, ...candidateCase.case_path.split('/'), 'invocation.json'), 'utf8');
    assert.match(invocation, /<case-root>\/treatment\/ponytail\/SKILL\.md/);
    assert.doesNotMatch(invocation, new RegExp(escapeRegex(tempDir), 'i'));
    assert.equal((await execFileAsync('git', ['-C', path.join(referencesRoot, 'passkey'), 'status', '--porcelain'])).stdout, '');
    assert.equal((await execFileAsync('git', ['-C', path.join(referencesRoot, 'yougile-mcp'), 'status', '--porcelain'])).stdout, '');
    assert.equal((await execFileAsync('git', ['-C', ponytailRoot, 'status', '--porcelain'])).stdout, '');
  });

  it('uses a detached local clone without hardlinks for one production snapshot', async () => {
    const source = path.join(tempDir, 'source');
    const target = path.join(tempDir, 'target');
    const commit = await createGitFixture(source, { 'src/value.txt': 'source\n' });
    await cloneGitSnapshot(source, target, commit);
    assert.equal((await execFileAsync('git', ['-C', target, 'rev-parse', 'HEAD'])).stdout.trim(), commit);
    assert.equal((await execFileAsync('git', ['-C', target, 'status', '--porcelain'])).stdout, '');
    await writeFile(path.join(target, 'src', 'value.txt'), 'target-only\n', 'utf8');
    assert.equal(await readFile(path.join(source, 'src', 'value.txt'), 'utf8'), 'source\n');
  });

  it('does not write during dry-run and rejects dirty source copies or overlapping output', async () => {
    const dryOut = path.join(tempDir, 'not-created');
    const dry = await preparePonytailPiMatrix({
      runId: 'ponytail-lq-low-test',
      outDir: dryOut,
      dryRun: true,
      cwd: process.cwd()
    });
    assert.equal(dry.dry_run, true);
    assert.equal(dry.prepared_cases, 0);
    await assert.rejects(readFile(dryOut), /ENOENT/);

    const referencesRoot = path.join(tempDir, 'references');
    const ponytailRoot = path.join(tempDir, 'ponytail');
    await mkdir(referencesRoot, { recursive: true });
    const passkeyCommit = await createGitFixture(path.join(referencesRoot, 'passkey'), { 'go/main.go': 'package main\n' });
    const yougileCommit = await createGitFixture(path.join(referencesRoot, 'yougile-mcp'), { 'src/index.ts': 'export {};\n' });
    const ponytailCommit = await createGitFixture(ponytailRoot, { 'skills/ponytail/SKILL.md': '# Ponytail\n' });
    const catalog = await loadPonytailPiCatalog({ cwd: process.cwd() });
    catalog.fixtures[0].source_commit = passkeyCommit;
    catalog.fixtures[1].source_commit = yougileCommit;
    catalog.ponytail.source_commit = ponytailCommit;
    delete catalog.source_path;
    const catalogPath = path.join(tempDir, 'catalog.json');
    await writeFile(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8');
    await writeFile(path.join(referencesRoot, 'passkey', 'untracked.txt'), 'dirty\n', 'utf8');

    await assert.rejects(preparePonytailPiMatrix({
      catalogPath,
      runId: 'ponytail-lq-low-test',
      referencesRoot,
      ponytailRoot,
      outDir: path.join(tempDir, 'out'),
      cwd: process.cwd()
    }), /reference passkey must be a clean Git snapshot/);

    await rm(path.join(referencesRoot, 'passkey', 'untracked.txt'));
    await assert.rejects(preparePonytailPiMatrix({
      catalogPath,
      runId: 'ponytail-lq-low-test',
      referencesRoot,
      ponytailRoot,
      outDir: path.join(referencesRoot, 'nested-output'),
      cwd: process.cwd()
    }), /outside the reference and Ponytail source roots/);
  });
});

async function createGitFixture(root, files) {
  await mkdir(root, { recursive: true });
  await execFileAsync('git', ['init', '--quiet'], { cwd: root });
  for (const [relativePath, content] of Object.entries(files)) {
    const target = path.join(root, ...relativePath.split('/'));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, 'utf8');
  }
  await execFileAsync('git', ['add', '.'], { cwd: root });
  await execFileAsync('git', [
    '-c', 'user.name=AIFHub Test',
    '-c', 'user.email=aifhub-test@example.invalid',
    'commit', '--quiet', '-m', 'fixture'
  ], { cwd: root });
  return (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim();
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
