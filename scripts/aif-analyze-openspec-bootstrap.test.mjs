// aif-analyze-openspec-bootstrap.test.mjs - instruction-level OpenSpec bootstrap contract tests
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

async function readRepoFile(relativePath) {
  return readFile(join(REPO_ROOT, relativePath), 'utf8');
}

function assertIncludes(source, expected, filePath) {
  assert.ok(
    source.includes(expected),
    `${filePath} should include ${JSON.stringify(expected)}`
  );
}

describe('aif-analyze OpenSpec-native bootstrap contract', () => {
  it('documents explicit mode selection and preserves legacy default config', async () => {
    const skill = await readRepoFile('skills/aif-analyze/SKILL.md');
    const template = await readRepoFile('skills/aif-analyze/references/config-template.yaml');

    assertIncludes(skill, '### Step 2.5: Resolve Bootstrap Mode', 'skills/aif-analyze/SKILL.md');
    assertIncludes(skill, 'Use `openspec-native` mode when the user explicitly asks', 'skills/aif-analyze/SKILL.md');
    assertIncludes(skill, 'aifhub.artifactProtocol: openspec', 'skills/aif-analyze/SKILL.md');
    assertIncludes(skill, 'Do not silently migrate a legacy AI Factory-only project', 'skills/aif-analyze/SKILL.md');
    assertIncludes(template, 'artifactProtocol: ai-factory', 'skills/aif-analyze/references/config-template.yaml');
  });

  it('defines the OpenSpec-native config shape and canonical runtime paths', async () => {
    const combined = [
      await readRepoFile('skills/aif-analyze/SKILL.md'),
      await readRepoFile('skills/aif-analyze/references/config-template.yaml')
    ].join('\n');

    for (const expected of [
      'artifactProtocol: openspec',
      'root: openspec',
      'installSkills: false',
      'validateOnPlan: true',
      'validateOnVerify: true',
      'archiveOnDone: true',
      'openspec/changes',
      'openspec/specs',
      '.ai-factory/state',
      '.ai-factory/qa',
      '.ai-factory/rules/generated'
    ]) {
      assertIncludes(combined, expected, 'aif-analyze OpenSpec bootstrap artifacts');
    }
  });

  it('requires detectOpenSpec capability reporting and degraded missing-CLI behavior', async () => {
    const skill = await readRepoFile('skills/aif-analyze/SKILL.md');

    for (const expected of [
      'detectOpenSpec()',
      'scripts/openspec-runner.mjs',
      'available: boolean',
      'canValidate: boolean',
      'canArchive: boolean',
      'version: string | null',
      'supportedRange: ">=1.3.1 <2.0.0"',
      'requiresNode: ">=20.19.0"',
      'nodeSupported: boolean',
      'versionSupported: boolean',
      'Missing or unsupported OpenSpec CLI is a degraded capability state, not a bootstrap failure'
    ]) {
      assertIncludes(skill, expected, 'skills/aif-analyze/SKILL.md');
    }
  });

  it('documents compatible CLI initialization, manual skeletons, and no skill installation', async () => {
    const combined = [
      await readRepoFile('skills/aif-analyze/SKILL.md'),
      await readRepoFile('docs/openspec-compatibility.md'),
      await readRepoFile('docs/usage.md')
    ].join('\n');

    for (const expected of [
      'openspec init --tools none',
      'openspec/config.yaml',
      'openspec/specs/',
      'openspec/changes/',
      '.ai-factory/state/',
      '.ai-factory/qa/',
      '.ai-factory/rules/generated/',
      'OpenSpec skills and slash commands are not installed by this extension'
    ]) {
      assertIncludes(combined, expected, 'OpenSpec bootstrap docs');
    }
  });
});
