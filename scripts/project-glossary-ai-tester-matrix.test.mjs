// project-glossary-ai-tester-matrix.test.mjs - controlled glossary matrix contracts
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  GLOSSARY_CONDITIONS,
  buildAiTesterRunInvocation,
  buildAiTesterRuntimeEnv,
  buildProjectGlossaryMatrix,
  exactScenarioFilter,
  generateProjectGlossaryMatrix,
  loadProjectGlossaryScenarioCatalog,
  renderAiTesterScenario,
  validateProjectGlossaryScenarioCatalog
} from './project-glossary-ai-tester-matrix.mjs';

let tempDir;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'project-glossary-ai-tester-matrix-'));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe('project glossary ai-tester catalog', () => {
  it('loads the committed synthetic catalog with pinned Luna settings', async () => {
    const catalog = await loadProjectGlossaryScenarioCatalog({ cwd: process.cwd() });
    assert.equal(catalog.defaults.model, 'gpt-5.6-luna');
    assert.equal(catalog.defaults.reasoning, 'low');
    assert.equal(catalog.defaults.repetitions, 2);
    assert.deepEqual(catalog.defaults.conditions, GLOSSARY_CONDITIONS);
    assert.deepEqual(catalog.scenarios.map((item) => item.skill), ['aif-explore', 'aif-plan']);
    assert.doesNotMatch(JSON.stringify(catalog), /[A-Za-z]:\\Users\\|BEGIN PRIVATE KEY/i);
  });

  it('rejects unsafe fixture paths, private-looking content, and incomplete pairing', async () => {
    const catalog = await loadProjectGlossaryScenarioCatalog({ cwd: process.cwd() });
    const unsafe = structuredClone(catalog);
    unsafe.defaults.conditions = ['candidate_with_glossary'];
    unsafe.fixture.source_files['../escape.txt'] = 'token=secret-value';
    const errors = validateProjectGlossaryScenarioCatalog(unsafe);
    assert.ok(errors.some((item) => item.includes('defaults.conditions')));
    assert.ok(errors.some((item) => item.includes('unsafe path')));
    assert.ok(errors.some((item) => item.includes('private-looking material')));
  });
});

describe('project glossary matrix generation', () => {
  it('builds two complete repetitions per skill with matching pair fingerprints', async () => {
    const catalog = await loadProjectGlossaryScenarioCatalog({ cwd: process.cwd() });
    const matrix = buildProjectGlossaryMatrix({ catalog, runId: 'glossary-luna-low-test' });
    assert.equal(matrix.cases.length, 8);
    assert.equal(new Set(matrix.cases.map((item) => item.id)).size, 8);
    for (const pairId of new Set(matrix.cases.map((item) => item.pair_id))) {
      const pair = matrix.cases.filter((item) => item.pair_id === pairId);
      assert.deepEqual(pair.map((item) => item.condition), GLOSSARY_CONDITIONS);
      assert.equal(new Set(pair.map((item) => item.settings_fingerprint)).size, 1);
      assert.equal(new Set(pair.map((item) => item.source_fingerprint)).size, 1);
      assert.equal(pair[0].model, 'gpt-5.6-luna');
      assert.equal(pair[0].reasoning, 'low');
    }
  });

  it('writes identical source fixtures and adds CONTEXT.md only to candidates', async () => {
    const sourceRoot = path.join(tempDir, 'source');
    const outDir = path.join(tempDir, 'state', 'matrix');
    await writeFakeSkillSources(sourceRoot);
    const catalogPath = path.join(process.cwd(), 'docs', 'project-glossary-research', 'ai-tester-scenarios.json');
    const result = await generateProjectGlossaryMatrix({
      catalogPath,
      outDir,
      sourceRoot,
      runId: 'glossary-luna-low-test',
      cwd: process.cwd()
    });
    assert.equal(result.matrix.cases.length, 8);
    const baseline = path.join(outDir, 'fixtures', 'terminology-synthesis', 'baseline_without_glossary');
    const candidate = path.join(outDir, 'fixtures', 'terminology-synthesis', 'candidate_with_glossary');
    await assert.rejects(access(path.join(baseline, 'CONTEXT.md')));
    assert.match(await readFile(path.join(candidate, 'CONTEXT.md'), 'utf8'), /Dispatch Relay/);
    assert.equal(
      await readFile(path.join(baseline, 'README.md'), 'utf8'),
      await readFile(path.join(candidate, 'README.md'), 'utf8')
    );
    assert.match(await readFile(path.join(candidate, 'skills', 'aif-explore', 'SKILL.md'), 'utf8'), /aif-explore/);
    assert.match(await readFile(path.join(candidate, 'skills', 'shared', 'PROJECT-GLOSSARY.md'), 'utf8'), /glossary/i);
    const summary = JSON.parse(await readFile(path.join(outDir, 'matrix-summary.json'), 'utf8'));
    assert.equal(summary.schema, 'aifhub.project_glossary.ai_tester_matrix.v1');
  });

  it('keeps glossary body out of scenario YAML and renders the pinned runner settings', async () => {
    const catalog = await loadProjectGlossaryScenarioCatalog({ cwd: process.cwd() });
    const matrix = buildProjectGlossaryMatrix({ catalog, runId: 'glossary-luna-low-test' });
    const rendered = renderAiTesterScenario(matrix.cases[1]);
    assert.match(rendered, /model: "gpt-5\.6-luna"/);
    assert.match(rendered, /reasoning: "low"/);
    assert.match(rendered, /candidate_with_glossary/);
    assert.match(rendered, /pattern: "evaluation_complete"/);
    assert.doesNotMatch(rendered, /GLOSSARY_SENTINEL_127|Dispatch Relay invokes/);
  });

  it('validates without writes in dry-run mode', async () => {
    const sourceRoot = path.join(tempDir, 'source');
    const outDir = path.join(tempDir, 'not-created');
    await writeFakeSkillSources(sourceRoot);
    const result = await generateProjectGlossaryMatrix({
      outDir,
      sourceRoot,
      runId: 'glossary-luna-low-test',
      cwd: process.cwd(),
      dryRun: true
    });
    assert.equal(result.dry_run, true);
    assert.equal(result.written_files.length, 0);
    await assert.rejects(access(outDir));
  });
});

describe('ai-tester portable invocation', () => {
  it('uses an anchored Rust-compatible exact filter', () => {
    assert.equal(exactScenarioFilter('run__scenario__r01__baseline_without_glossary'), '^run__scenario__r01__baseline_without_glossary$');
    assert.throws(() => exactScenarioFilter('unsafe.*'), /unsafe filter/);
  });

  it('creates the Windows which shim and quotes the exact run invocation', async () => {
    const matrixDir = path.join(tempDir, 'matrix dir');
    const env = await buildAiTesterRuntimeEnv({
      matrixDir,
      platform: 'win32',
      baseEnv: { Path: 'C:\\tools' },
      systemRoot: path.join(tempDir, 'missing-windows')
    });
    assert.ok(env.Path.startsWith(path.join(matrixDir, '.runner-bin')));
    assert.equal(await readFile(path.join(matrixDir, '.runner-bin', 'which.cmd'), 'utf8'), '@echo off\r\nwhere.exe %*\r\n');
    const matrixCase = {
      id: 'glossary-luna-low__terminology-synthesis__r01__baseline_without_glossary',
      scenario_file: 'scenarios/case.yaml',
      runtime: 'codex',
      model: 'gpt-5.6-luna',
      reasoning: 'low'
    };
    const invocation = buildAiTesterRunInvocation(matrixCase, { matrixDir, platform: 'win32', dryRun: true });
    assert.equal(invocation.command, 'powershell.exe');
    const commandText = invocation.args.at(-1);
    assert.match(commandText, /'--model' 'gpt-5\.6-luna'/);
    assert.match(commandText, /'--reasoning' 'low'/);
    assert.match(commandText, /'--filter' '\^glossary-luna-low__terminology-synthesis__r01__baseline_without_glossary\$'/);
    assert.match(commandText, /--dry-run/);
  });
});

async function writeFakeSkillSources(root) {
  for (const skill of ['aif-explore', 'aif-plan']) {
    const skillDir = path.join(root, '.agents', 'skills', skill);
    await mkdir(skillDir, { recursive: true });
    await writeFile(path.join(skillDir, 'SKILL.md'), `---\nname: ${skill}\n---\n# ${skill}\n`, 'utf8');
  }
  const shared = path.join(root, 'skills', 'shared');
  await mkdir(shared, { recursive: true });
  await writeFile(path.join(shared, 'LANGUAGE-POLICY.md'), '# Language\nRead PROJECT-GLOSSARY.md.\n', 'utf8');
  await writeFile(path.join(shared, 'PROJECT-GLOSSARY.md'), '# Project glossary\nOptional glossary.\n', 'utf8');
}
