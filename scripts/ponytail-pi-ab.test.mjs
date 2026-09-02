// ponytail-pi-ab.test.mjs - deterministic contracts for the isolated Pi benchmark
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  PONYTAIL_CONDITIONS,
  buildHiddenGraderInvocation,
  buildPiInvocation,
  buildPonytailPiMatrix,
  cloneGitSnapshot,
  loadPonytailPiCatalog,
  preparePonytailPiMatrix,
  renderCasePrompt,
  runExternalDirect,
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
      [
        '24a55ce21aa6a525dd3bd215b13b2af8ef2e14a8',
        'd643d48ff84c098079f02576a115da3e61135579',
        '1dc513dd7821c30cab2a8738b399768da58b049d'
      ]
    );
    assert.deepEqual(catalog.fixtures[0].validation[0].args, ['test', '-skip', 'OpenSSL', './...']);
    assert.match(catalog.scenarios[1].task, /external-OpenSSL interoperability tests are excluded/);
    assert.deepEqual(catalog.fixtures[2].project_shape, [
      'php', 'laravel', 'commerce', 'money-correctness', 'over-build-sensitive'
    ]);
    assert.equal(catalog.scenarios[2].fixture_id, 'cutcode-shop');
    assert.equal(catalog.scenarios[2].hidden_grader, 'cutcode-price-format.php');
    assert.doesNotMatch(JSON.stringify(catalog), /D:\\projects|[A-Za-z]:\\Users\\|BEGIN PRIVATE KEY/i);
  });

  it('rejects incomplete pairing, weak repetition counts, unsafe paths, and private task material', async () => {
    const catalog = await loadPonytailPiCatalog({ cwd: process.cwd() });
    const unsafe = structuredClone(catalog);
    unsafe.defaults.conditions = ['ponytail_full'];
    unsafe.defaults.repetitions = 1;
    unsafe.fixtures[0].source_directory = '../passkey';
    unsafe.scenarios[0].task = 'token=secret-value';
    unsafe.scenarios[1].hidden_grader = 'grader.txt';
    const errors = validatePonytailPiCatalog(unsafe);
    assert.ok(errors.some((item) => item.includes('defaults.conditions')));
    assert.ok(errors.some((item) => item.includes('defaults.repetitions')));
    assert.ok(errors.some((item) => item.includes('source_directory')));
    assert.ok(errors.some((item) => item.includes('private-looking material')));
    assert.ok(errors.some((item) => item.includes('hidden_grader')));
  });
});

describe('Ponytail Pi A/B matrix', () => {
  it('builds twenty-four paired cases with stable task/settings fingerprints and balanced arm order', async () => {
    const catalog = await loadPonytailPiCatalog({ cwd: process.cwd() });
    const matrix = buildPonytailPiMatrix({
      catalog,
      runId: 'ponytail-lq-low-test',
      generatedAt: '2026-09-01T00:00:00.000Z'
    });
    assert.equal(matrix.cases.length, 24);
    assert.equal(new Set(matrix.cases.map((item) => item.id)).size, 24);
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

  it('retains partial stdout and stderr when an external command times out', async () => {
    const result = await runExternalDirect(process.execPath, [
      '-e',
      "process.stdout.write('partial-out\\n'); process.stderr.write('partial-err\\n'); setTimeout(() => {}, 10_000);"
    ], {
      cwd: tempDir,
      timeoutMs: 1_000,
      maxBuffer: 1024 * 1024
    });

    assert.equal(result.timedOut, true);
    assert.match(result.stdout, /partial-out/);
    assert.match(result.stderr, /partial-err/);
  });

  it('closes child stdin so non-interactive commands can observe EOF', async () => {
    const result = await runExternalDirect(process.execPath, [
      '-e',
      "process.stdin.resume(); process.stdin.once('end', () => process.stdout.write('stdin-closed\\n'));"
    ], {
      cwd: tempDir,
      timeoutMs: 5_000,
      maxBuffer: 1024 * 1024
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.timedOut, false);
    assert.match(result.stdout, /stdin-closed/);
  });

  it('runs JavaScript graders with Node and Laravel graders with PHP', () => {
    assert.deepEqual(
      buildHiddenGraderInvocation(
        { hidden_grader: 'yougile-url-join.mjs' },
        'C:\\temp\\project',
        'C:\\temp\\grader.mjs'
      ),
      { command: process.execPath, args: ['C:\\temp\\grader.mjs', 'C:\\temp\\project'] }
    );
    assert.deepEqual(
      buildHiddenGraderInvocation(
        { hidden_grader: 'cutcode-price-format.php' },
        'C:\\temp\\project',
        'C:\\temp\\grader.php'
      ),
      { command: 'php', args: ['C:\\temp\\grader.php', 'C:\\temp\\project'] }
    );
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
    const cutcodeCommit = await createGitFixture(path.join(referencesRoot, 'cutcode-shop'), {
      'src/Support/Traits/Makeable.php': '<?php\n',
      'src/Support/ValueObjects/Price.php': '<?php\n',
      'composer.json': '{}\n',
      'composer.lock': '{}\n'
    });
    const ponytailCommit = await createGitFixture(ponytailRoot, {
      'skills/ponytail/SKILL.md': '---\nname: ponytail\n---\n# Ponytail\n'
    });
    const catalog = await loadPonytailPiCatalog({ cwd: process.cwd() });
    catalog.fixtures[0].source_commit = passkeyCommit;
    catalog.fixtures[1].source_commit = yougileCommit;
    catalog.fixtures[2].source_commit = cutcodeCommit;
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

    assert.equal(prepared.prepared_cases, 24);
    const summary = JSON.parse(await readFile(path.join(outDir, 'matrix-summary.json'), 'utf8'));
    assert.equal(summary.cases.length, 24);
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
    assert.equal((await execFileAsync('git', ['-C', path.join(referencesRoot, 'cutcode-shop'), 'status', '--porcelain'])).stdout, '');
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

  it('checks out deep Laravel-style files in long Windows case paths', async () => {
    const source = path.join(tempDir, 'long-source');
    const longFile = path.join(
      'database',
      'migrations',
      `2026_09_02_000000_${'long_laravel_migration_'.repeat(5)}table.php`
    );
    const commit = await createGitFixture(source, { [longFile]: '<?php\n' });
    const target = path.join(
      tempDir,
      'cases',
      'ponytail-lq-low-test__laravel-exact-price-formatting__r01__baseline',
      'project'
    );

    await cloneGitSnapshot(source, target, commit);

    assert.equal((await readFile(path.join(target, longFile), 'utf8')).replaceAll('\r\n', '\n'), '<?php\n');
    assert.equal(
      (await execFileAsync('git', ['-C', target, '-c', 'core.longpaths=true', 'status', '--porcelain'])).stdout,
      ''
    );
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
    const cutcodeCommit = await createGitFixture(path.join(referencesRoot, 'cutcode-shop'), { 'src/price.php': '<?php\n' });
    const ponytailCommit = await createGitFixture(ponytailRoot, { 'skills/ponytail/SKILL.md': '# Ponytail\n' });
    const catalog = await loadPonytailPiCatalog({ cwd: process.cwd() });
    catalog.fixtures[0].source_commit = passkeyCommit;
    catalog.fixtures[1].source_commit = yougileCommit;
    catalog.fixtures[2].source_commit = cutcodeCommit;
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

describe('Ponytail Pi A/B public results', () => {
  it('records only bounded two-model aggregate evidence and retains the manual policy', async () => {
    const resultsPath = path.join(
      process.cwd(),
      'docs',
      'skill-providers-research',
      'ponytail-pi-ab',
      'results.json'
    );
    const source = await readFile(resultsPath, 'utf8');
    const evidence = JSON.parse(source);

    assert.equal(evidence.schema, 'aifhub.ponytail_pi_ab.public_results.v1');
    assert.equal(evidence.evidence_status, 'EXECUTED(mixed_non_promotable)');
    assert.equal(evidence.decision, 'retain_manual_experiment_only');
    assert.equal(evidence.runs.length, 2);
    assert.equal(evidence.runs.reduce((sum, run) => sum + run.completed_cases, 0), 48);
    assert.deepEqual(
      evidence.runs.map((run) => [run.model, run.pass_by_condition]),
      [
        ['lq/qwen3.8-27b', { baseline: 6, ponytail_full: 8 }],
        ['la/ornith-1.5-35b-a3b', { baseline: 11, ponytail_full: 9 }]
      ]
    );
    assert.equal(evidence.excluded_comparisons.length, 1);
    assert.equal(evidence.excluded_comparisons[0].status, 'NOT_COMPARABLE(provider_error)');
    assert.equal(evidence.excluded_comparisons[0].tool_calls, 0);
    assert.equal(evidence.adjusted_cross_run_summary.comparable_pairs, 23);
    assert.deepEqual(evidence.adjusted_cross_run_summary.pass_on_comparable_pairs_by_condition, {
      baseline: 16,
      ponytail_full: 17
    });
    assert.ok(evidence.runs.every((run) => (
      run.expected_cases === 24
      && run.complete_pairs === 12
      && run.integrity.source_snapshots_intact
      && run.integrity.ponytail_source_intact
      && run.integrity.treatment_resources_intact
      && run.integrity.dependency_changes === 0
    )));

    for (const run of evidence.runs) {
      const aggregateSource = await readFile(path.join(path.dirname(resultsPath), run.aggregate_file), 'utf8');
      const aggregate = JSON.parse(aggregateSource);
      assert.equal(
        createHash('sha256').update(aggregateSource).digest('hex'),
        run.source_aggregate_sha256
      );
      assert.equal(aggregate.run_id, run.run_id);
      assert.equal(aggregate.model, run.model);
      assert.equal(aggregate.expected_cases, run.expected_cases);
      assert.equal(aggregate.completed_cases, run.completed_cases);
      assert.equal(aggregate.complete_pairs, run.complete_pairs);
      assert.deepEqual(aggregate.pass_by_condition, run.pass_by_condition);
      assert.equal(aggregate.results.length, 24);
      assert.ok(aggregate.results.every((row) => (
        row.source_snapshot_intact
        && row.ponytail_source_intact
        && row.treatment_resource_intact
        && !row.metrics.dependency_files_changed
      )));
      assert.doesNotMatch(aggregateSource, /[A-Za-z]:[\\/]/);
      assert.doesNotMatch(aggregateSource, /"content"\s*:|Canonical task:|Treat this text as/);
      assert.doesNotMatch(aggregateSource, /pi-events\.jsonl|prompt\.md|stdout\.log|stderr\.log/);
    }

    assert.doesNotMatch(source, /[A-Za-z]:[\\/]/);
    assert.doesNotMatch(source, /pi-events\.jsonl|prompt\.md|stdout\.log|stderr\.log/);
    assert.equal(evidence.retention.raw_model_output_committed, false);
    assert.equal(evidence.retention.private_paths_committed, false);
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
