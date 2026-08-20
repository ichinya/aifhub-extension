// openspec-lifecycle-contract.test.mjs - lifecycle-level OpenSpec CLI prompt contracts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

const LIFECYCLE_ASSETS = {
  planning: [
    'injections/core/aif-plan-plan-folder.md'
  ],
  improvement: [
    'injections/core/aif-improve-plan-folder.md'
  ],
  planPolisher: [
    'agent-files/codex/aifhub-plan-polisher.toml',
    'agent-files/claude/aifhub-plan-polisher.md'
  ],
  sync: [
    'skills/aif-mode/SKILL.md',
    'skills/aif-mode/references/ARTIFACT-SYNC.md'
  ],
  verify: [
    'injections/core/aif-verify-plan-folder.md',
    'agent-files/codex/aifhub-verifier.toml',
    'agent-files/claude/aifhub-verifier.md'
  ],
  done: [
    'skills/aif-done/SKILL.md',
    'skills/aif-done/references/finalization-contract.md',
    'agent-files/codex/aifhub-done-finalizer.toml',
    'agent-files/claude/aifhub-done-finalizer.md'
  ]
};

const OPENSPEC_SLASH_COMMAND_PATTERNS = [
  /\/opsx:[\w-]+/i,
  /\/openspec:[\w-]+/i
];

async function readRepoFile(relativePath) {
  return readFile(join(REPO_ROOT, relativePath), 'utf8');
}

async function readJoined(paths) {
  const parts = await Promise.all(paths.map(async (relativePath) => [
    `\n\n<!-- ${relativePath} -->\n`,
    await readRepoFile(relativePath)
  ].join('')));

  return parts.join('\n');
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
    `${label} should not tell users or agents to install OpenSpec skills`
  );
  assert.doesNotMatch(
    source,
    /\b(?:must|should|need(?:s)? to|required to|recommended to|recommend)\s+install OpenSpec slash commands\b/i,
    `${label} should not tell users or agents to install OpenSpec slash commands`
  );
}

describe('OpenSpec lifecycle CLI integration contract', () => {
  it('keeps OpenSpec CLI routing behind the shared runner and off OpenSpec slash commands', async () => {
    const lifecyclePaths = Object.values(LIFECYCLE_ASSETS).flat();

    for (const relativePath of lifecyclePaths) {
      const asset = stripFencedBlocks(await readRepoFile(relativePath));

      assertNoInstallGuidance(asset, relativePath);

      for (const pattern of OPENSPEC_SLASH_COMMAND_PATTERNS) {
        assert.doesNotMatch(
          asset,
          pattern,
          `${relativePath} should not route users to OpenSpec slash commands`
        );
      }

      if (/\b(?:validateOpenSpecChange|getOpenSpecStatus|archiveOpenSpecChange|getOpenSpecInstructions)\b/.test(asset)) {
        assertIncludes(asset, 'scripts/openspec-runner.mjs', relativePath);
      }
    }
  });

  it('requires planning to create canonical artifacts and request degraded validation through the runner', async () => {
    const planning = await readJoined(LIFECYCLE_ASSETS.planning);

    for (const expected of [
      'openspec/changes/<change-id>/proposal.md',
      'openspec/changes/<change-id>/design.md',
      'openspec/changes/<change-id>/tasks.md',
      'openspec/changes/<change-id>/specs/<capability>/spec.md',
      'validateOpenSpecChange(changeId)',
      'scripts/openspec-runner.mjs',
      'Missing or unsupported OpenSpec CLI is degraded validation, not planning failure'
    ]) {
      assertIncludes(planning, expected, 'planning lifecycle');
    }
  });

  it('requires improvement to patch canonical artifacts, preserve user edits, and request validation', async () => {
    const improvement = await readJoined(LIFECYCLE_ASSETS.improvement);

    for (const expected of [
      'openspec/changes/<change-id>/proposal.md',
      'openspec/changes/<change-id>/design.md',
      'openspec/changes/<change-id>/tasks.md',
      'openspec/changes/<change-id>/specs/**/spec.md',
      'Read current artifact content before editing',
      'Preserve user-written sections',
      'patch-style',
      'validateOpenSpecChange(changeId)',
      'scripts/openspec-runner.mjs',
      'Missing or unsupported OpenSpec CLI is degraded validation'
    ]) {
      assertIncludes(improvement, expected, 'improvement lifecycle');
    }
  });

  it('requires plan-polisher agents to validate touched canonical artifacts through the runner', async () => {
    for (const relativePath of LIFECYCLE_ASSETS.planPolisher) {
      const asset = await readRepoFile(relativePath);

      for (const expected of [
        'proposal.md',
        'design.md',
        'tasks.md',
        'specs/**/spec.md',
        'validateOpenSpecChange(changeId)',
        'scripts/openspec-runner.mjs'
      ]) {
        assertIncludes(asset, expected, relativePath);
      }

      assert.match(
        asset,
        /degraded validation|CLI is unavailable|missing CLI/i,
        `${relativePath} should report degraded validation when the CLI is missing`
      );
    }
  });

  it('requires sync to compile generated rules and request validation/status through the runner', async () => {
    const sync = await readJoined(LIFECYCLE_ASSETS.sync);

    for (const expected of [
      'compile generated rules',
      'validateOpenSpecChange(changeId)',
      'getOpenSpecStatus(changeId)',
      'scripts/openspec-runner.mjs',
      'no-delta-specs',
      'base-only sync',
      'Missing or unsupported OpenSpec CLI is degraded'
    ]) {
      assertIncludes(sync, expected, 'sync lifecycle');
    }
  });

  it('requires verify to validate/status through the runner, fail invalid OpenSpec first, and write verify evidence', async () => {
    const verify = await readJoined(LIFECYCLE_ASSETS.verify);

    for (const expected of [
      'scripts/openspec-verification-context.mjs',
      'scripts/openspec-runner.mjs',
      'validateOpenSpecChange(changeId)',
      'getOpenSpecStatus(changeId)',
      'Fail invalid OpenSpec artifacts before code checks',
      '.ai-factory/qa/<change-id>/',
      'aif-gate-result',
      '"gate": "verify"'
    ]) {
      assertIncludes(verify, expected, 'verify lifecycle');
    }

    assert.match(verify, /missing CLI.*degraded|degraded missing-CLI/i);
    assert.match(verify, /strict config|requireCliForVerify/i);
    assert.match(verify, /\/aif-verify.*does not archive|Do not archive/i);
    assert.match(verify, /\/aif-done.*owns OpenSpec archive\/finalization/i);
  });

  it('requires done to own archive/finalization and only done to call archiveOpenSpecChange', async () => {
    const done = await readJoined(LIFECYCLE_ASSETS.done);
    const nonDone = await readJoined([
      ...LIFECYCLE_ASSETS.planning,
      ...LIFECYCLE_ASSETS.improvement,
      ...LIFECYCLE_ASSETS.planPolisher,
      ...LIFECYCLE_ASSETS.sync,
      ...LIFECYCLE_ASSETS.verify
    ]);

    for (const expected of [
      'ai-factory aifhub-done-finalizer --change <change-id> --json',
      'archiveOpenSpecChange(changeId)',
      'scripts/openspec-runner.mjs',
      'extension-local implementation',
      '--skip-specs',
      'If OpenSpec CLI is missing or unsupported and archive is required, fail',
      '/aif-verify does not archive',
      'Do not directly mutate `openspec/specs/**`',
      '.ai-factory/qa/<change-id>/',
      '.ai-factory/state/<change-id>/'
    ]) {
      assertIncludes(done, expected, 'done lifecycle');
    }

    assert.match(done, /\/aif-done.*archive\/finalization|only OpenSpec-native archive\/finalization step/i);
    assertNotIncludes(nonDone, 'archiveOpenSpecChange(changeId)', 'non-done lifecycle assets');

    for (const relativePath of LIFECYCLE_ASSETS.done) {
      const asset = await readRepoFile(relativePath);
      assertIncludes(
        asset,
        'ai-factory aifhub-done-finalizer --change <change-id> --json',
        relativePath
      );
      assert.match(
        asset,
        /scripts\/openspec-(?:done-finalizer|done-readiness|runner)\.mjs[^\n]*(?:extension-local|implementation module)|(?:extension-local|implementation module)[^\n]*scripts\/openspec-(?:done-finalizer|done-readiness|runner)\.mjs/i,
        `${relativePath} should label source-repository module references as extension-local implementation`
      );
      assert.doesNotMatch(
        asset,
        /\bnode(?:\.exe)?\s+(?:scripts[\\/]|[^\n]*\.ai-factory[\\/]extensions[\\/][^\n]*scripts[\\/])openspec-(?:done-finalizer|done-readiness|runner)\.mjs\b/i,
        `${relativePath} should not expose an internal module as an installed-project executable`
      );
    }
  });

  it('bounds done roadmap lifecycle co-ownership and keeps GitHub state external', async () => {
    for (const relativePath of LIFECYCLE_ASSETS.done) {
      const asset = stripFencedBlocks(await readRepoFile(relativePath));

      assert.match(
        asset,
        /co-owns only the marker-delimited.*OpenSpec Change Lifecycle.*block/i,
        `${relativePath} should bound done ownership to the managed lifecycle block`
      );
      assert.match(
        asset,
        /after successful OpenSpec archive/i,
        `${relativePath} should place lifecycle mutation after archive success`
      );
      assert.match(
        asset,
        /readiness, verification, artifact-contract, dirty-tree, or archive failure.*(?:must not|does not|do not).*roadmap/i,
        `${relativePath} should forbid roadmap mutation on pre-archive failures`
      );
      assert.match(
        asset,
        /updated.*skipped.*handoff/i,
        `${relativePath} should expose bounded local roadmap outcomes`
      );
      assertIncludes(asset, '/aif-roadmap check', relativePath);
      assert.match(
        asset,
        /(?:must not|do not|never).*roll back.*archive/i,
        `${relativePath} should preserve successful archive evidence on roadmap handoff`
      );
      assert.match(
        asset,
        /separately from (?:external )?GitHub.*(?:issue|pull request|PR)/i,
        `${relativePath} should report local lifecycle separately from GitHub state`
      );
      assert.match(
        asset,
        /(?:must not|does not|do not|never).*claim.*GitHub issue.*closed.*(?:pull request|PR).*merged/i,
        `${relativePath} should never infer external closure from local finalization`
      );
    }
  });
});
