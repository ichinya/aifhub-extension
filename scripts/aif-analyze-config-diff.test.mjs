// aif-analyze-config-diff.test.mjs - tests for the analyze config required-keys diff
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  buildAnalyzeConfigDiff,
  runAnalyzeConfigDiffCommand
} from './aif-analyze-config-diff.mjs';
import {
  flattenConfigKeyPaths,
  parseSimpleYaml,
  readAnalyzeSkillVersion,
  renderConfigForMode
} from './aif-artifact-sync.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const tempRoots = [];

async function createTempRoot() {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'aifhub-analyze-config-diff-'));
  tempRoots.push(rootDir);
  return rootDir;
}

async function writeFixture(rootDir, relativePath, content) {
  const targetPath = path.join(rootDir, ...relativePath.split('/'));
  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeFile(targetPath, content, 'utf8');
  return targetPath;
}

async function createSkillFixture(rootDir, version) {
  const skillPath = await writeFixture(rootDir, 'extension/skills/aif-analyze/SKILL.md', [
    '---',
    'name: aif-analyze',
    `version: ${version}`,
    '---',
    '',
    '# AIF Analyze',
    ''
  ].join('\n'));
  return pathToFileURL(skillPath).href;
}

async function createManifestFixture(rootDir, entries, rawOverride) {
  const manifestPath = await writeFixture(
    rootDir,
    'extension/skills/aif-analyze/references/config-keys.json',
    rawOverride ?? JSON.stringify({ schema_version: 1, keys: entries }, null, 2)
  );
  return pathToFileURL(manifestPath).href;
}

async function createConfigFixture(rootDir, content) {
  await writeFixture(rootDir, '.ai-factory/config.yaml', content);
}

const BASE_MANIFEST = [
  { key: 'config_version', required: true, since: '1.0.0', purpose: 'Config schema version.' },
  { key: 'language.ui', required: true, since: '1.0.0', purpose: 'UI language.' },
  { key: 'aifhub.artifactProtocol', required: true, since: '1.0.0', purpose: 'Artifact protocol switch.' },
  { key: 'analyze.skill_version', required: true, since: '0.11.0', purpose: 'Version of the aif-analyze skill that last wrote this config.' }
];

const COMPLETE_CONFIG = [
  'config_version: 1',
  'language:',
  '  ui: en',
  'aifhub:',
  '  artifactProtocol: openspec',
  'analyze:',
  '  skill_version: 0.11.0',
  ''
].join('\n');

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((rootDir) => rm(rootDir, {
    recursive: true,
    force: true
  })));
});

describe('analyze config required-keys diff', () => {
  it('reports missing required keys with purposes and version drift', async () => {
    const rootDir = await createTempRoot();
    await createConfigFixture(rootDir, [
      'config_version: 1',
      'language:',
      '  ui: en',
      'aifhub:',
      '  artifactProtocol: openspec',
      ''
    ].join('\n'));
    const manifestUrl = await createManifestFixture(rootDir, BASE_MANIFEST);
    const analyzeSkillUrl = await createSkillFixture(rootDir, '0.11.0');

    const result = await buildAnalyzeConfigDiff({ rootDir, manifestUrl, analyzeSkillUrl });

    assert.equal(result.ok, true);
    assert.equal(result.up_to_date, false);
    assert.equal(result.version_drift, true);
    assert.equal(result.config_analyze_version, null);
    assert.deepEqual(
      result.missing.map((item) => item.key),
      ['analyze.skill_version']
    );
    assert.match(result.missing[0].purpose, /aif-analyze skill/);
    assert.equal(result.missing[0].since, '0.11.0');
  });

  it('takes the fast path when the config is up to date', async () => {
    const rootDir = await createTempRoot();
    await createConfigFixture(rootDir, COMPLETE_CONFIG);
    const manifestUrl = await createManifestFixture(rootDir, BASE_MANIFEST);
    const analyzeSkillUrl = await createSkillFixture(rootDir, '0.11.0');

    const result = await buildAnalyzeConfigDiff({ rootDir, manifestUrl, analyzeSkillUrl });

    assert.equal(result.ok, true);
    assert.equal(result.up_to_date, true);
    assert.equal(result.version_drift, false);
    assert.deepEqual(result.missing, []);
    assert.equal(result.config_analyze_version, '0.11.0');
  });

  it('keeps a legacy config up to date without OpenSpec-only required paths', async () => {
    const rootDir = await createTempRoot();
    await createConfigFixture(
      rootDir,
      renderConfigForMode('', 'ai-factory', { analyzeSkillVersion: '0.12.0' })
    );

    const result = await buildAnalyzeConfigDiff({ rootDir });

    assert.equal(result.ok, true);
    assert.equal(result.up_to_date, true);
    assert.deepEqual(result.missing, []);
  });

  it('reports a mode-specific required key for its matching artifact protocol', async () => {
    const rootDir = await createTempRoot();
    await createConfigFixture(rootDir, COMPLETE_CONFIG);
    const manifestUrl = await createManifestFixture(rootDir, [
      ...BASE_MANIFEST,
      {
        key: 'paths.state',
        required: true,
        modes: ['openspec'],
        since: '1.0.0',
        purpose: 'OpenSpec runtime state root.'
      }
    ]);
    const analyzeSkillUrl = await createSkillFixture(rootDir, '0.11.0');

    const result = await buildAnalyzeConfigDiff({ rootDir, manifestUrl, analyzeSkillUrl });

    assert.equal(result.ok, true);
    assert.equal(result.up_to_date, false);
    assert.deepEqual(result.missing.map((item) => item.key), ['paths.state']);
  });

  it('never flags unknown user-owned keys as missing or obsolete', async () => {
    const rootDir = await createTempRoot();
    await createConfigFixture(rootDir, [
      'config_version: 1',
      'language:',
      '  ui: en',
      'aifhub:',
      '  artifactProtocol: openspec',
      'analyze:',
      '  skill_version: 0.11.0',
      'custom_user_block:',
      '  nested_setting: keep-me',
      ''
    ].join('\n'));
    const manifestUrl = await createManifestFixture(rootDir, BASE_MANIFEST);
    const analyzeSkillUrl = await createSkillFixture(rootDir, '0.11.0');

    const result = await buildAnalyzeConfigDiff({ rootDir, manifestUrl, analyzeSkillUrl });

    assert.equal(result.ok, true);
    assert.equal(result.up_to_date, true);
    const reportedKeys = [...result.missing, ...result.obsolete].map((item) => item.key);
    assert.ok(!reportedKeys.includes('custom_user_block'));
    assert.ok(!reportedKeys.includes('custom_user_block.nested_setting'));
  });

  it('reports deprecated manifest keys still present in the config as obsolete', async () => {
    const rootDir = await createTempRoot();
    await createConfigFixture(rootDir, [
      'config_version: 1',
      'language:',
      '  ui: en',
      'aifhub:',
      '  artifactProtocol: openspec',
      'analyze:',
      '  skill_version: 0.11.0',
      'utilities:',
      '  legacy_shim: true',
      ''
    ].join('\n'));
    const manifestUrl = await createManifestFixture(rootDir, [
      ...BASE_MANIFEST,
      { key: 'utilities.legacy_shim', deprecated: true, purpose: 'Replaced by mode enum.' }
    ]);
    const analyzeSkillUrl = await createSkillFixture(rootDir, '0.11.0');

    const result = await buildAnalyzeConfigDiff({ rootDir, manifestUrl, analyzeSkillUrl });

    assert.equal(result.ok, true);
    assert.deepEqual(
      result.obsolete.map((item) => item.key),
      ['utilities.legacy_shim']
    );
    assert.match(result.obsolete[0].purpose, /mode enum/);
    assert.equal(result.up_to_date, true, 'deprecated keys alone do not break up_to_date');
  });

  it('fails closed when the config is missing', async () => {
    const rootDir = await createTempRoot();
    const manifestUrl = await createManifestFixture(rootDir, BASE_MANIFEST);
    const analyzeSkillUrl = await createSkillFixture(rootDir, '0.11.0');

    const result = await buildAnalyzeConfigDiff({ rootDir, manifestUrl, analyzeSkillUrl });

    assert.equal(result.ok, false);
    assert.equal(result.errors[0].code, 'config-missing');
    assert.equal(result.missing, null);
    assert.equal(result.obsolete, null);
    assert.equal(result.version_drift, null);
  });

  it('fails closed when the manifest is invalid JSON', async () => {
    const rootDir = await createTempRoot();
    await createConfigFixture(rootDir, COMPLETE_CONFIG);
    const manifestUrl = await createManifestFixture(rootDir, null, '{ not json');
    const analyzeSkillUrl = await createSkillFixture(rootDir, '0.11.0');

    const result = await buildAnalyzeConfigDiff({ rootDir, manifestUrl, analyzeSkillUrl });

    assert.equal(result.ok, false);
    assert.equal(result.errors[0].code, 'manifest-invalid');
  });

  it('rejects unknown options and missing values with usage output', async () => {
    const missingValue = await runAnalyzeConfigDiffCommand(['--config']);
    assert.equal(missingValue.exitCode, 2);
    assert.match(missingValue.stderr, /Missing value for --config/);
    assert.match(missingValue.stderr, /Usage: node scripts\/aif-analyze-config-diff\.mjs/);

    const unknown = await runAnalyzeConfigDiffCommand(['--bogus']);
    assert.equal(unknown.exitCode, 2);
    assert.match(unknown.stderr, /Unknown option: --bogus/);
  });

  it('prints a JSON report and exits 0 for a successful diff', async () => {
    const rootDir = await createTempRoot();
    await createConfigFixture(rootDir, COMPLETE_CONFIG);
    const manifestUrl = await createManifestFixture(rootDir, BASE_MANIFEST);
    const analyzeSkillUrl = await createSkillFixture(rootDir, '0.11.0');

    const command = await runAnalyzeConfigDiffCommand(
      ['--json'],
      { rootDir, manifestUrl, analyzeSkillUrl }
    );

    assert.equal(command.exitCode, 0);
    const parsed = JSON.parse(command.stdout);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.up_to_date, true);
  });

  it('accepts CLI override paths containing URL-reserved characters', async () => {
    const rootDir = await createTempRoot();
    await createConfigFixture(rootDir, COMPLETE_CONFIG);
    const manifestPath = await writeFixture(
      rootDir,
      'extension#review/skills/aif-analyze/references/config-keys.json',
      JSON.stringify({ schema_version: 1, keys: BASE_MANIFEST }, null, 2)
    );
    const skillPath = await writeFixture(rootDir, 'extension#review/skills/aif-analyze/SKILL.md', [
      '---',
      'name: aif-analyze',
      'version: 0.11.0',
      '---',
      ''
    ].join('\n'));

    const command = await runAnalyzeConfigDiffCommand(
      ['--manifest', manifestPath, '--skill', skillPath, '--json'],
      { rootDir }
    );

    assert.equal(command.exitCode, 0);
    const parsed = JSON.parse(command.stdout);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.up_to_date, true);
  });
});

describe('analyze config manifest and patcher invariants', () => {
  it('renders every manifest required key in a fresh openspec config', async () => {
    const manifestUrl = new URL('../skills/aif-analyze/references/config-keys.json', import.meta.url);
    const manifest = JSON.parse(await (await import('node:fs/promises')).readFile(manifestUrl, 'utf8'));
    assert.ok(Array.isArray(manifest.keys) && manifest.keys.length > 0, 'manifest must list keys');

    const rendered = renderConfigForMode('', 'openspec', { analyzeSkillVersion: '0.11.0' });
    const flat = flattenConfigKeyPaths(parseSimpleYaml(rendered));

    const missing = manifest.keys
      .filter((entry) => entry.required === true && !flat.has(entry.key))
      .map((entry) => entry.key);
    assert.deepEqual(missing, [], 'patcher render must cover every manifest required key');
  });

  it('reads the real aif-analyze skill version from extension-local frontmatter', async () => {
    const skill = await readAnalyzeSkillVersion();
    assert.equal(skill.ok, true);
    assert.match(skill.version, /^\d+\.\d+\.\d+$/);
    assert.notEqual(skill.version, '0.10.0', 'skill version must be bumped with the diff behavior');
  });

  it('preserves, appends, and omits the analyze block correctly', () => {
    const preserved = renderConfigForMode(
      'analyze:\n  skill_version: 0.10.0\n  extra_note: keep\n',
      'openspec',
      { analyzeSkillVersion: '0.11.0' }
    );
    assert.match(preserved, /skill_version: 0\.10\.0/);
    assert.doesNotMatch(preserved, /skill_version: 0\.11\.0/);
    assert.match(preserved, /extra_note: keep/);

    const appended = renderConfigForMode(
      'analyze:\n  mode_note: x\n',
      'openspec',
      { analyzeSkillVersion: '0.11.0' }
    );
    assert.match(appended, /skill_version: 0\.11\.0/);
    assert.match(appended, /mode_note: x/);

    const fresh = renderConfigForMode('', 'openspec', { analyzeSkillVersion: '0.11.0' });
    assert.match(fresh, /analyze:\n  skill_version: 0\.11\.0/);

    const omitted = renderConfigForMode('', 'openspec');
    assert.doesNotMatch(omitted, /^analyze:/m);

    const unknownKept = renderConfigForMode(
      'custom_user_block:\n  nested_setting: keep-me\n',
      'openspec',
      { analyzeSkillVersion: '0.11.0' }
    );
    assert.match(unknownKept, /custom_user_block:/);
    assert.match(unknownKept, /nested_setting: keep-me/);
  });
});
