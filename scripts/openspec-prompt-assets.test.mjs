// openspec-prompt-assets.test.mjs - instruction-level tests for OpenSpec-native prompt assets
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

const EXPLICIT_REFERENCE_ASSETS = [
  'skills/aif-analyze/references/config-template.yaml',
  'skills/aif-done/references/finalization-contract.md',
  'injections/references/aif-roadmap/roadmap-template.md',
  'injections/references/aif-roadmap/slice-checklist.md'
];

const MODE_GATED_PROMPTS = [
  'skills/aif-done/SKILL.md',
  'injections/core/aif-rules-check-openspec-generated-rules.md',
  'injections/core/aif-implement-plan-folder.md',
  'injections/core/aif-fix-plan-folder.md',
  'injections/core/aif-verify-plan-folder.md'
];

const VERIFY_PROMPT_ASSETS = [
  'injections/core/aif-verify-plan-folder.md',
  'agent-files/codex/aifhub-verifier.toml',
  'agent-files/claude/aifhub-verifier.md'
];

const IMPLEMENT_PROMPT_ASSETS = [
  'injections/core/aif-implement-plan-folder.md',
  'agent-files/codex/aifhub-implement-worker.toml',
  'agent-files/claude/aifhub-implement-worker.md'
];

const PLAN_POLISHER_PROMPT_ASSETS = [
  'agent-files/codex/aifhub-plan-polisher.toml',
  'agent-files/claude/aifhub-plan-polisher.md'
];

const DONE_PROMPT_ASSETS = [
  'skills/aif-done/SKILL.md',
  'skills/aif-done/references/finalization-contract.md',
  'agent-files/codex/aifhub-done-finalizer.toml',
  'agent-files/claude/aifhub-done-finalizer.md'
];

const SIDECAR_PROMPT_ASSETS = [
  ['agent-files/codex/aifhub-rules-sidecar.toml', 'rules'],
  ['agent-files/claude/aifhub-rules-sidecar.md', 'rules'],
  ['agent-files/codex/aifhub-review-sidecar.toml', 'review'],
  ['agent-files/claude/aifhub-review-sidecar.md', 'review'],
  ['agent-files/codex/aifhub-security-sidecar.toml', 'security'],
  ['agent-files/claude/aifhub-security-sidecar.md', 'security']
];

const ROADMAP_PROMPT_ASSET = 'injections/core/aif-roadmap-maturity-audit.md';

const ROADMAP_REFERENCE_ASSETS = [
  'injections/references/aif-roadmap/roadmap-template.md',
  'injections/references/aif-roadmap/slice-checklist.md'
];

const CANONICAL_CHANGE_FILES = [
  'openspec/changes/<change-id>/proposal.md',
  'openspec/changes/<change-id>/design.md',
  'openspec/changes/<change-id>/tasks.md',
  'openspec/changes/<change-id>/specs/**/spec.md'
];

const GENERATED_RULE_FILES = [
  '.ai-factory/rules/generated/openspec-merged-<change-id>.md',
  '.ai-factory/rules/generated/openspec-change-<change-id>.md',
  '.ai-factory/rules/generated/openspec-base.md'
];

const LEGACY_PLAN_ARTIFACTS = [
  '.ai-factory/plans/<id>/task.md',
  '.ai-factory/plans/<id>/context.md',
  '.ai-factory/plans/<id>/rules.md',
  '.ai-factory/plans/<id>/verify.md',
  '.ai-factory/plans/<id>/status.yaml',
  '.ai-factory/plans/<plan-id>/task.md',
  '.ai-factory/plans/<plan-id>/context.md',
  '.ai-factory/plans/<plan-id>/rules.md',
  '.ai-factory/plans/<plan-id>/verify.md',
  '.ai-factory/plans/<plan-id>/status.yaml'
];

async function readRepoFile(relativePath) {
  return readFile(join(REPO_ROOT, relativePath), 'utf8');
}

function normalizeManifestPath(pathValue) {
  return normalize(pathValue.replace(/^\.\//, '')).replaceAll('\\', '/');
}

async function loadManifest() {
  return JSON.parse(await readRepoFile('extension.json'));
}

async function activePromptAssets() {
  const manifest = await loadManifest();
  const assets = new Set(EXPLICIT_REFERENCE_ASSETS);

  for (const skillPath of manifest.skills ?? []) {
    assets.add(`${normalizeManifestPath(skillPath)}/SKILL.md`);
  }

  for (const injection of manifest.injections ?? []) {
    assets.add(normalizeManifestPath(injection.file));
  }

  for (const agentFile of manifest.agentFiles ?? []) {
    assets.add(normalizeManifestPath(agentFile.source));
  }

  return [...assets].sort();
}

function stripFencedBlocks(markdown) {
  const lines = markdown.split(/\r?\n/);
  const kept = [];
  let inFence = false;

  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }

    if (!inFence) kept.push(line);
  }

  return kept.join('\n');
}

function extractMarkdownSection(markdown, heading) {
  const lines = markdown.split(/\r?\n/);
  let inFence = false;
  let start = -1;
  let startLevel = 0;
  let end = lines.length;

  for (let index = 0; index < lines.length; index += 1) {
    if (/^\s*(```|~~~)/.test(lines[index])) {
      inFence = !inFence;
      continue;
    }

    const match = inFence ? null : lines[index].match(/^(#{1,6})\s+(.+?)\s*$/);
    if (match && match[2] === heading) {
      start = index + 1;
      startLevel = match[1].length;
      break;
    }
  }

  assert.notEqual(start, -1, `Expected section heading ${JSON.stringify(heading)}`);

  inFence = false;
  for (let index = start; index < lines.length; index += 1) {
    if (/^\s*(```|~~~)/.test(lines[index])) {
      inFence = !inFence;
      continue;
    }

    const match = inFence ? null : lines[index].match(/^(#{1,6})\s+(.+?)\s*$/);
    if (match && match[1].length <= startLevel) {
      end = index;
      break;
    }
  }

  return lines.slice(start, end).join('\n');
}

function assertIncludes(source, expected, label) {
  assert.ok(source.includes(expected), `${label} should include ${JSON.stringify(expected)}`);
}

function assertNotIncludes(source, unexpected, label) {
  assert.ok(!source.includes(unexpected), `${label} should not include ${JSON.stringify(unexpected)}`);
}

function assertNoInstallGuidance(source, label) {
  assert.doesNotMatch(
    source,
    /\b(?:must|should|need(?:s)? to|required to|recommended to|recommend)\s+install OpenSpec skills\b/i,
    `${label} should not tell agents to install OpenSpec skills`
  );
  assert.doesNotMatch(
    source,
    /\b(?:must|should|need(?:s)? to|required to|recommended to|recommend)\s+install OpenSpec slash commands\b/i,
    `${label} should not tell agents to install OpenSpec slash commands`
  );
}

describe('OpenSpec-native prompt asset contract', () => {
  it('discovers active prompt assets from extension.json only', async () => {
    const assets = await activePromptAssets();

    for (const expected of [
      'skills/aif-analyze/SKILL.md',
      'skills/aif-done/SKILL.md',
      'injections/core/aif-rules-check-openspec-generated-rules.md',
      ROADMAP_PROMPT_ASSET,
      ...ROADMAP_REFERENCE_ASSETS,
      'injections/core/aif-implement-plan-folder.md',
      'agent-files/codex/aifhub-verifier.toml',
      'agent-files/claude/aifhub-verifier.md'
    ]) {
      assert.ok(assets.includes(expected), `active assets should include ${expected}`);
    }

    for (const asset of assets) {
      assert.ok(!asset.startsWith('injections/handoff/'), `active discovery should exclude dormant handoff stub ${asset}`);
      assert.ok(!asset.startsWith('.ai-factory/extensions/'), `active discovery should exclude installed snapshot ${asset}`);
      assert.ok(!asset.startsWith('skills/aif-rules-check/'), `active discovery should exclude retired fallback ${asset}`);
    }
  });

  it('defines OpenSpec-native and legacy sections for remaining mode-gated prompts', async () => {
    for (const relativePath of MODE_GATED_PROMPTS) {
      const asset = await readRepoFile(relativePath);

      assertIncludes(asset, 'OpenSpec-native mode', relativePath);
      assertIncludes(asset, 'Legacy AI Factory-only mode', relativePath);
    }
  });

  it('keeps OpenSpec-native sections on canonical artifacts and outside legacy plan folders', async () => {
    for (const relativePath of MODE_GATED_PROMPTS) {
      const asset = await readRepoFile(relativePath);
      const openspec = extractMarkdownSection(asset, 'OpenSpec-native mode');

      for (const expected of [
        'openspec/specs/**',
        ...CANONICAL_CHANGE_FILES,
        ...GENERATED_RULE_FILES,
        '.ai-factory/state/<change-id>/',
        '.ai-factory/qa/<change-id>/'
      ]) {
        assertIncludes(openspec, expected, `${relativePath} OpenSpec-native mode`);
      }

      for (const unexpected of LEGACY_PLAN_ARTIFACTS) {
        assertNotIncludes(openspec, unexpected, `${relativePath} OpenSpec-native mode`);
      }
    }
  });

  it('keeps active agent files mode-gated and off status.yaml as OpenSpec-native source of truth', async () => {
    const assets = await activePromptAssets();
    const agentAssets = assets.filter((asset) => asset.startsWith('agent-files/'));

    for (const relativePath of agentAssets) {
      const asset = await readRepoFile(relativePath);
      const openspec = extractMarkdownSection(asset, 'OpenSpec-native mode');
      const legacy = extractMarkdownSection(asset, 'Legacy AI Factory-only mode');

      for (const expected of [
        'active OpenSpec change',
        'canonical artifacts',
        'generated rules',
        'runtime state',
        'QA evidence'
      ]) {
        assertIncludes(openspec, expected, `${relativePath} OpenSpec-native mode`);
      }

      assertNotIncludes(openspec, 'status.yaml as source of truth', `${relativePath} OpenSpec-native mode`);
      assertNotIncludes(openspec, 'active plan pair', `${relativePath} OpenSpec-native mode`);
      assertNotIncludes(openspec, 'plan-local `rules.md`', `${relativePath} OpenSpec-native mode`);
      assert.doesNotMatch(
        openspec,
        /(?:runtime state|QA evidence|verification findings|verdicts|command results|trace(?:s)?)\s+(?:under|inside|to|into)\s+`?openspec\/changes/i,
        `${relativePath} OpenSpec-native mode should not direct runtime-only writes into openspec/changes`
      );
      assertIncludes(legacy, '.ai-factory/plans/<plan-id>/', `${relativePath} Legacy AI Factory-only mode`);
    }
  });

  it('keeps rules-check generated-rules hierarchy in the prompt-assets contract', async () => {
    for (const relativePath of [
      'injections/core/aif-rules-check-openspec-generated-rules.md'
    ]) {
      const asset = await readRepoFile(relativePath);
      const openspec = extractMarkdownSection(asset, 'OpenSpec-native mode');
      const mergedIndex = openspec.indexOf('.ai-factory/rules/generated/openspec-merged-<change-id>.md');
      const changeIndex = openspec.indexOf('.ai-factory/rules/generated/openspec-change-<change-id>.md');
      const generatedBaseIndex = openspec.indexOf('.ai-factory/rules/generated/openspec-base.md');
      const projectRulesIndex = openspec.indexOf('.ai-factory/RULES.md');
      const baseRulesIndex = openspec.indexOf('.ai-factory/rules/base.md');

      assert.notEqual(mergedIndex, -1, `${relativePath} missing merged generated rules priority`);
      assert.notEqual(changeIndex, -1, `${relativePath} missing change generated rules priority`);
      assert.notEqual(generatedBaseIndex, -1, `${relativePath} missing base generated rules priority`);
      assert.ok(mergedIndex < changeIndex, `${relativePath} merged generated rules should be highest priority`);
      assert.ok(changeIndex < generatedBaseIndex, `${relativePath} change generated rules should precede base generated rules`);
      assert.ok(generatedBaseIndex < projectRulesIndex, `${relativePath} generated rules should precede project rules`);
      assert.ok(projectRulesIndex < baseRulesIndex, `${relativePath} project rules should precede base rules`);

      assertIncludes(openspec, 'does not require plan-local `rules.md`', `${relativePath} OpenSpec-native mode`);
      assertIncludes(openspec, 'must not regenerate or edit generated rules', `${relativePath} OpenSpec-native mode`);
      assertIncludes(openspec, 'WARN', `${relativePath} OpenSpec-native mode`);
    }
  });

  it('does not recommend OpenSpec skill or slash-command installation in active prompts', async () => {
    for (const relativePath of await activePromptAssets()) {
      const asset = stripFencedBlocks(await readRepoFile(relativePath));
      assertNoInstallGuidance(asset, relativePath);
    }
  });

  it('requires verifier prompts to use fail-fast OpenSpec verification context', async () => {
    for (const relativePath of VERIFY_PROMPT_ASSETS) {
      const asset = stripFencedBlocks(await readRepoFile(relativePath));

      for (const expected of [
        'scripts/openspec-verification-context.mjs',
        'scripts/openspec-runner.mjs',
        'shouldRunCodeVerification',
        '.ai-factory/qa/<change-id>/',
        '/aif-fix <change-id>',
        '/aif-done <change-id>'
      ]) {
        assertIncludes(asset, expected, relativePath);
      }

      assert.match(
        asset,
        /fail(?:s)? invalid OpenSpec artifacts before code checks|fail-fast OpenSpec validation before code checks/i,
        `${relativePath} should require fail-fast OpenSpec validation before code checks`
      );
      assert.match(
        asset,
        /missing CLI.*degraded|degraded missing-CLI/i,
        `${relativePath} should describe degraded missing-CLI behavior`
      );
      assert.match(
        asset,
        /strict config|requireCliForVerify/i,
        `${relativePath} should describe strict config behavior`
      );
      assert.match(
        asset,
        /never archive|does not archive|no archive/i,
        `${relativePath} should forbid archive from /aif-verify`
      );
    }
  });

  it('requires plan-polisher prompts to validate touched OpenSpec artifacts', async () => {
    for (const relativePath of PLAN_POLISHER_PROMPT_ASSETS) {
      const asset = stripFencedBlocks(await readRepoFile(relativePath));

      for (const expected of [
        'proposal.md',
        'design.md',
        'tasks.md',
        'specs/**/spec.md',
        'scripts/openspec-runner.mjs',
        'validateOpenSpecChange(changeId)'
      ]) {
        assertIncludes(asset, expected, relativePath);
      }

      assert.match(
        asset,
        /After touching .*OpenSpec artifacts|After touching .*proposal\.md.*design\.md.*tasks\.md.*specs/i,
        `${relativePath} should require validation after artifact edits`
      );
      assert.match(
        asset,
        /degraded validation|CLI is unavailable|missing CLI/i,
        `${relativePath} should report degraded validation when the CLI is unavailable`
      );
    }
  });

  it('keeps verify prompt wording aligned with done-owned archive finalization', async () => {
    const asset = stripFencedBlocks(await readRepoFile('injections/core/aif-verify-plan-folder.md'));

    assert.doesNotMatch(
      asset,
      /archive integration (?:is )?deferred to issue #33|deferred archive status/i,
      'verify injection should not describe OpenSpec archive integration as deferred'
    );
    assert.match(
      asset,
      /\/aif-verify.*records verification evidence|verification evidence only/i,
      'verify injection should describe /aif-verify as evidence-only'
    );
    assert.match(
      asset,
      /\/aif-done.*owns OpenSpec archive\/finalization/i,
      'verify injection should state that /aif-done owns OpenSpec archive/finalization'
    );
  });

  it('suggests explicit legacy migration without auto-migrating in improve, implement, and verify prompts', async () => {
    for (const relativePath of [
      'injections/core/aif-improve-plan-folder.md',
      'injections/core/aif-implement-plan-folder.md',
      'injections/core/aif-verify-plan-folder.md'
    ]) {
      const asset = await readRepoFile(relativePath);
      const openspec = extractMarkdownSection(asset, 'OpenSpec-native mode');

      for (const expected of [
        'detectMigrationNeed(options)',
        'scripts/legacy-plan-migration.mjs',
        'do not auto-migrate',
        'Found legacy AI Factory plan artifacts for `<change-id>` but no OpenSpec change at `openspec/changes/<change-id>`.',
        'node scripts/migrate-legacy-plans.mjs <change-id> --dry-run',
        'node scripts/migrate-legacy-plans.mjs <change-id>'
      ]) {
        assertIncludes(openspec, expected, `${relativePath} OpenSpec-native mode`);
      }
    }
  });

  it('requires done prompts to archive verified OpenSpec changes through the done finalizer', async () => {
    for (const relativePath of DONE_PROMPT_ASSETS) {
      const asset = stripFencedBlocks(await readRepoFile(relativePath));

      for (const expected of [
        'scripts/openspec-done-finalizer.mjs',
        'archiveOpenSpecChange',
        '--skip-specs',
        '.ai-factory/qa/<change-id>/',
        '.ai-factory/state/<change-id>/',
        'dirty',
        'openspec archive <change-id> --yes'
      ]) {
        assertIncludes(asset, expected, relativePath);
      }

      assert.match(
        asset,
        /refus(?:e|es).*unverified|refus(?:e|es).*\/aif-verify.*passed|verification.*passed/i,
        `${relativePath} should refuse unverified changes`
      );
      assert.match(
        asset,
        /does not archive in `?\/aif-verify`?|\/aif-verify`? does not archive|never archive from `?\/aif-verify`?/i,
        `${relativePath} should keep archive out of /aif-verify`
      );
      assert.match(
        asset,
        /does not use legacy `?\.ai-factory\/specs`?.*OpenSpec-native|OpenSpec-native.*does not use legacy `?\.ai-factory\/specs`?/i,
        `${relativePath} should forbid legacy specs archive in OpenSpec-native mode`
      );
      assert.doesNotMatch(
        asset,
        /archive integration (?:is )?deferred to issue #33|deferred archive status/i,
        `${relativePath} should no longer describe OpenSpec archive integration as deferred`
      );
    }
  });

  it('requires done prompts to hand off to sync, commit, and optional evolve without replacing commit', async () => {
    for (const relativePath of DONE_PROMPT_ASSETS) {
      const asset = stripFencedBlocks(await readRepoFile(relativePath));

      for (const expected of [
        '/aif-mode sync',
        '/aif-commit',
        '/aif-evolve'
      ]) {
        assertIncludes(asset, expected, relativePath);
      }

      assert.match(
        asset,
        /do not (?:create|make) commits|does not create commits|never create commits/i,
        `${relativePath} should forbid commit creation from done finalization`
      );
      assert.match(
        asset,
        /do not (?:create|open) PRs|does not create PRs|never auto-create PRs/i,
        `${relativePath} should forbid PR creation from done finalization`
      );
      assert.match(
        asset,
        /does not replace `?\/aif-commit`?|do not present `?\/aif-done`?.*replac(?:e|ing) `?\/aif-commit`?/i,
        `${relativePath} should state that /aif-done does not replace /aif-commit`
      );
    }
  });

  it('mentions optional read-only gates in implement and verifier prompts while preserving authoritative verify', async () => {
    for (const relativePath of [...IMPLEMENT_PROMPT_ASSETS, ...VERIFY_PROMPT_ASSETS]) {
      const asset = stripFencedBlocks(await readRepoFile(relativePath));

      for (const expected of [
        '/aif-rules-check',
        '/aif-review',
        '/aif-security-checklist'
      ]) {
        assertIncludes(asset, expected, relativePath);
      }

      assert.match(
        asset,
        /authoritative final verification remains `?\/aif-verify <change-id>`?|\/aif-verify <change-id>.*authoritative final verification/i,
        `${relativePath} should keep /aif-verify as authoritative final verification`
      );
    }
  });

  it('keeps sidecar prompt assets on explicit rules, review, and security gate values', async () => {
    for (const [relativePath, gate] of SIDECAR_PROMPT_ASSETS) {
      const asset = await readRepoFile(relativePath);
      assertIncludes(asset, `"gate": "${gate}"`, relativePath);
    }
  });

  it('defines GitHub-aware roadmap evidence as supporting and non-blocking', async () => {
    const asset = stripFencedBlocks(await readRepoFile(ROADMAP_PROMPT_ASSET));

    for (const expected of [
      'GitHub-aware evidence',
      'milestones',
      'open and closed issues',
      'open, merged, and closed PRs',
      'labels',
      'linked branches',
      'current git tree',
      'supporting evidence only',
      'must never be the sole reason to mark a slice or roadmap item `done`',
      'GitHub evidence was used, unavailable, or partially available'
    ]) {
      assertIncludes(asset, expected, ROADMAP_PROMPT_ASSET);
    }
  });

  it('keeps GitHub-aware roadmap output owner-bounded and credential-safe', async () => {
    const asset = stripFencedBlocks(await readRepoFile(ROADMAP_PROMPT_ASSET));

    for (const expected of [
      'must not mutate GitHub issues, milestones, PRs, labels, or linked branches',
      'must not write tokens',
      'authorization headers',
      'raw credential helper output',
      'private authentication diagnostics',
      'GitHub says done, but local evidence is missing',
      'local implementation exists, but GitHub is stale',
      'OpenSpec change exists, but no linked roadmap/milestone/issue is visible'
    ]) {
      assertIncludes(asset, expected, ROADMAP_PROMPT_ASSET);
    }
  });

  it('keeps roadmap references ready for optional GitHub links without requiring them everywhere', async () => {
    for (const relativePath of ROADMAP_REFERENCE_ASSETS) {
      const asset = stripFencedBlocks(await readRepoFile(relativePath));

      for (const expected of [
        'GitHub evidence',
        'GitHub links are optional',
        'local artifact evidence remains required'
      ]) {
        assertIncludes(asset, expected, relativePath);
      }
    }
  });

  it('documents scoped OpenSpec runtime integrations without deferred done archive wording', async () => {
    const compatibility = await readRepoFile('docs/openspec-compatibility.md');

    assertIncludes(compatibility, 'prompt assets', 'docs/openspec-compatibility.md');
    assertIncludes(compatibility, 'openspec archive <change-id> --yes', 'docs/openspec-compatibility.md');
    assertIncludes(compatibility, 'done finalization covers archive/finalizer integration', 'docs/openspec-compatibility.md');
    assertNotIncludes(
      compatibility,
      'broader prompt rewrites remain separate follow-up work',
      'docs/openspec-compatibility.md'
    );
    assert.doesNotMatch(
      compatibility,
      /archive integration (?:is )?deferred to issue #33/i,
      'docs/openspec-compatibility.md should not describe done archive as deferred'
    );

    for (const expected of [
      '#31',
      '#32'
    ]) {
      assertIncludes(compatibility, expected, 'docs/openspec-compatibility.md');
    }
  });
});
