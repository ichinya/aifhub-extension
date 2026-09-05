// docs-workflow-contract.test.mjs - docs coverage for the complete OpenSpec workflow tail
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

function assertIncludes(source, expected, label) {
  assert.ok(source.includes(expected), `${label} should include ${JSON.stringify(expected)}`);
}

function assertNotIncludes(source, unexpected, label) {
  assert.ok(!source.includes(unexpected), `${label} should not include ${JSON.stringify(unexpected)}`);
}

function assertOrder(source, orderedFragments, label) {
  let cursor = -1;

  for (const fragment of orderedFragments) {
    const index = source.indexOf(fragment, cursor + 1);
    assert.notEqual(index, -1, `${label} should include ${JSON.stringify(fragment)} after index ${cursor}`);
    assert.ok(index > cursor, `${label} should order ${JSON.stringify(fragment)} after previous fragment`);
    cursor = index;
  }
}

function extractSection(markdown, heading) {
  const lines = markdown.split(/\r?\n/);
  const startIndex = lines.findIndex((line) => line.trim() === heading);
  assert.notEqual(startIndex, -1, `Expected heading ${heading}`);
  const level = heading.match(/^#+/)?.[0].length ?? 1;
  let endIndex = lines.length;
  let inFence = false;

  for (let index = startIndex + 1; index < lines.length; index += 1) {
    if (lines[index].trim().startsWith('```')) {
      inFence = !inFence;
      continue;
    }

    if (inFence) {
      continue;
    }

    const match = lines[index].match(/^(#{1,6})\s+/);
    if (match && match[1].length <= level) {
      endIndex = index;
      break;
    }
  }

  return lines.slice(startIndex, endIndex).join('\n');
}

describe('complete OpenSpec workflow documentation contract', () => {
  it('documents the complete quick-start tail in README.md in workflow order', async () => {
    const readme = await readRepoFile('README.md');
    const quickStart = extractSection(readme, '## Quick Start');

    for (const expected of [
      '/aif-mode sync --change add-oauth-login',
      '/aif-rules-check',
      '/aif-review',
      '/aif-security-checklist',
      '/aif-verify add-oauth-login',
      '/aif-done add-oauth-login',
      '/aif-mode sync',
      '/aif-commit',
      '/aif-evolve'
    ]) {
      assertIncludes(quickStart, expected, 'README.md Quick Start');
    }

    assertOrder(quickStart, [
      '/aif-plan full "add OAuth login"',
      '/aif-improve add-oauth-login',
      '/aif-mode sync --change add-oauth-login',
      '/aif-implement add-oauth-login',
      '/aif-rules-check',
      '/aif-verify add-oauth-login',
      '/aif-done add-oauth-login',
      '/aif-mode sync',
      '/aif-commit',
      '/aif-evolve'
    ], 'README.md Quick Start');

    assertIncludes(quickStart, '/aif-done` finalizes the OpenSpec lifecycle', 'README.md Quick Start');
    assertIncludes(quickStart, 'It does not replace `/aif-commit`', 'README.md Quick Start');
    assertIncludes(quickStart, 'Validation gates:', 'README.md Quick Start');
    assertIncludes(quickStart, 'Optional before verify in relaxed/manual workflow.', 'README.md Quick Start');
    assertIncludes(quickStart, 'Required before `/aif-done` when done policy requires durable gate evidence.', 'README.md Quick Start');
    assertIncludes(quickStart, 'Core AI Factory workflow:', 'README.md Quick Start');
    assertIncludes(quickStart, 'OpenSpec validation overlay:', 'README.md Quick Start');
    assertNotIncludes(quickStart, 'Optional gates:', 'README.md Quick Start');
  });

  it('documents the complete manual workflow in docs/usage.md in workflow order', async () => {
    const usage = await readRepoFile('docs/usage.md');

    for (const expected of [
      '/aif-mode sync --change <change-id>',
      '/aif-rules-check',
      '/aif-review',
      '/aif-security-checklist',
      '/aif-verify <change-id>',
      '/aif-done <change-id>',
      '/aif-mode sync',
      '/aif-commit',
      '/aif-evolve',
      'required',
      'recommended',
      'optional'
    ]) {
      assertIncludes(usage, expected, 'docs/usage.md');
    }

    assertOrder(usage, [
      '/aif-plan full "<request>"',
      '/aif-implement <change-id>',
      '/aif-verify <change-id>',
      '/aif-done <change-id>',
      '/aif-mode sync',
      '/aif-commit',
      '/aif-evolve'
    ], 'docs/usage.md workflow');
  });

  it('documents deterministic prompt-language fallback without weakening exact output contracts', async () => {
    const readme = await readRepoFile('README.md');
    const usage = await readRepoFile('docs/usage.md');
    const changelog = await readRepoFile('CHANGELOG.md');
    const languageResolution = extractSection(usage, '## Prompt Language Resolution');
    const release = extractSection(changelog, '## [1.5.0] - 2026-09-01');

    for (const expected of [
      'usable non-empty `language.ui`',
      'current conversation language for the current response only',
      'English only when the conversation language is indeterminate',
      'OS locale and repository programming language are not inputs',
      'does not persist the inferred choice',
      'exactly one concise setup hint',
      'only when the active output contract permits human-readable prose',
      'before any required final `aif-gate-result` block',
      'exact-output-only',
      'exact handoffs, fixed commands, paths, keys/enums, and machine-only output',
      '`language.artifacts` remains separate'
    ]) {
      assertIncludes(languageResolution, expected, 'docs/usage.md Prompt Language Resolution');
    }

    assertOrder(languageResolution, [
      'usable non-empty `language.ui`',
      'current conversation language for the current response only',
      'English only when the conversation language is indeterminate'
    ], 'docs/usage.md prompt-language precedence');
    assertIncludes(
      readme,
      '`language.ui` → current conversation → English only when indeterminate',
      'README.md prompt-language summary'
    );
    for (const expected of [
      'issue #166',
      '`language.ui` → current conversation → English-last',
      'exact-output-only',
      'matched start/end'
    ]) {
      assertIncludes(release, expected, 'CHANGELOG.md 1.5.0 prompt-language fix');
    }
  });

  it('documents optional project glossary ownership, lexical precedence, mode preservation, and deferred OKF', async () => {
    const contextPolicy = await readRepoFile('docs/context-loading-policy.md');
    const usage = await readRepoFile('docs/usage.md');
    const compatibility = await readRepoFile('docs/openspec-compatibility.md');
    const modeSkill = await readRepoFile('skills/aif-mode/SKILL.md');
    const modes = await readRepoFile('skills/aif-mode/references/MODES.md');
    const adr1 = await readRepoFile('docs/adr/0001-openspec-native-artifact-protocol.md');
    const adr2 = await readRepoFile('docs/adr/0002-optional-project-context-glossary.md');
    const docsIndex = await readRepoFile('docs/README.md');
    const readme = await readRepoFile('README.md');
    const glossarySection = extractSection(contextPolicy, '## Optional Project Glossary');

    assertIncludes(
      extractSection(contextPolicy, '## Base Context'),
      'configured `paths.context` project glossary (`CONTEXT.md` by default), when present',
      'docs/context-loading-policy.md Base Context glossary placement'
    );

    for (const expected of [
      '`paths.context`',
      '`CONTEXT.md`',
      'project-relative',
      '`/aif-analyze` is the only writer',
      'explicit opt-in',
      'read-only consumers',
      'missing or empty',
      'unsafe or unreadable',
      'human-readable prose',
      'code and API identifiers',
      'source/tests and verifiable QA facts',
      'canonical OpenSpec requirements',
      'project rules and accepted architecture decisions',
      'generated-rule inputs',
      'QA evidence',
      'runtime traces',
      'provider stores',
      'OKF remains deferred'
    ]) {
      assertIncludes(glossarySection, expected, 'docs/context-loading-policy.md Optional Project Glossary');
    }

    for (const [source, label] of [
      [usage, 'docs/usage.md'],
      [compatibility, 'docs/openspec-compatibility.md'],
      [modeSkill, 'skills/aif-mode/SKILL.md'],
      [modes, 'skills/aif-mode/references/MODES.md']
    ]) {
      assertIncludes(source, 'paths.context', `${label} glossary config key`);
      assertIncludes(source, 'CONTEXT.md', `${label} glossary default path`);
      assertIncludes(source, 'protocol-neutral', `${label} glossary mode boundary`);
    }

    assert.ok(
      (compatibility.match(/^  context: CONTEXT\.md$/gm) ?? []).length >= 2,
      'docs/openspec-compatibility.md should show paths.context in both artifact protocol profiles'
    );
    assert.ok(
      (modes.match(/^  context: CONTEXT\.md$/gm) ?? []).length >= 2,
      'skills/aif-mode/references/MODES.md should show paths.context in both mode profiles'
    );

    for (const expected of [
      '# ADR 0002: Optional project context glossary',
      '## Status\n\nAccepted',
      'configurable `CONTEXT.md`',
      '`/aif-analyze`',
      'explicit opt-in',
      'read-only consumers',
      'lexical authority',
      'OKF',
      'separate OpenSpec change and ADR'
    ]) {
      assertIncludes(adr2, expected, 'docs/adr/0002-optional-project-context-glossary.md');
    }

    assertIncludes(adr1, '[Next Page](0002-optional-project-context-glossary.md)', 'ADR 0001 navigation');
    for (const [source, label] of [
      [docsIndex, 'docs/README.md'],
      [readme, 'README.md']
    ]) {
      assertIncludes(source, 'Optional Project Glossary', `${label} glossary discoverability`);
      assertIncludes(source, '0002-optional-project-context-glossary.md', `${label} ADR 0002 link`);
    }
    assertIncludes(docsIndex, 'context-loading-policy.md', 'docs/README.md context policy link');
    assertIncludes(readme, 'docs/context-loading-policy.md', 'README.md context policy link');
  });

  it('documents task intake normalization inside existing planning and refinement commands', async () => {
    const usage = await readRepoFile('docs/usage.md');
    const plan = extractSection(usage, '### `/aif-plan full`');
    const improve = extractSection(usage, '### `/aif-improve`');
    const legacy = extractSection(usage, '## Legacy AI Factory-Only Mode');

    for (const expected of [
      'task intake normalization',
      'canonical OpenSpec artifacts',
      '`proposal.md`: intent, scope, non-goals, approach, assumptions, risks, and open questions',
      '`design.md`: technical approach, C4 impact, ADR candidates, dependency graph, integration points, alternatives, and risks',
      '`tasks.md`: executable implementation checklist',
      '`specs/**/spec.md`: behavior-changing requirements and scenarios',
      'does not create `/aif-task-prepare`',
      'does not create `.ai-factory/specs/<task-id>.md`',
      'does not create `task-prepare.md`',
      '.ai-factory/state/<change-id>/'
    ]) {
      assertIncludes(plan, expected, 'docs/usage.md /aif-plan full');
    }

    for (const expected of [
      'task quality refinement',
      'optional and repeatable',
      'patch-style',
      'intent, scope, non-goals',
      'C4 impact',
      'ADR candidates',
      'dependency notes',
      'executable checklist',
      'behavior deltas',
      'blocker',
      'warn',
      'info'
    ]) {
      assertIncludes(improve, expected, 'docs/usage.md /aif-improve');
    }

    for (const expected of [
      '.ai-factory/plans/<plan-id>/task.md',
      '.ai-factory/plans/<plan-id>/context.md',
      '.ai-factory/plans/<plan-id>/rules.md',
      '.ai-factory/plans/<plan-id>/verify.md',
      '.ai-factory/plans/<plan-id>/status.yaml',
      '.ai-factory/plans/<plan-id>/explore.md',
      'not the default OpenSpec-native workflow',
      'No `task-prepare.md` artifact is required for the MVP'
    ]) {
      assertIncludes(legacy, expected, 'docs/usage.md Legacy AI Factory-Only Mode');
    }

    for (const unexpected of [
      '.ai-factory/plans/<plan-id>/task.md',
      '.ai-factory/plans/<plan-id>/context.md',
      '.ai-factory/plans/<plan-id>/rules.md',
      '.ai-factory/plans/<plan-id>/verify.md',
      '.ai-factory/plans/<plan-id>/status.yaml'
    ]) {
      assertNotIncludes(plan, unexpected, 'docs/usage.md /aif-plan full');
      assertNotIncludes(improve, unexpected, 'docs/usage.md /aif-improve');
    }
  });

  it('documents milestone-aware roadmap phase audits', async () => {
    const usage = await readRepoFile('docs/usage.md');
    const contextPolicy = await readRepoFile('docs/context-loading-policy.md');
    const usageRoadmap = extractSection(usage, '### `/aif-roadmap`');
    const contextRoadmap = extractSection(contextPolicy, '## GitHub-Aware Roadmap Context');

    for (const [label, section] of [
      ['docs/usage.md /aif-roadmap', usageRoadmap],
      ['docs/context-loading-policy.md GitHub-Aware Roadmap Context', contextRoadmap]
    ]) {
      for (const expected of [
        'milestones as roadmap phases',
        'Closed milestones produce phase audit sections',
        'local evidence status',
        'open_issues = 0',
        'phase-completion drift',
        'unphased backlog/drift',
        'supporting evidence only'
      ]) {
        assertIncludes(section, expected, label);
      }
    }
  });

  it('documents commit roadmap freshness as read-only handoff context', async () => {
    const usage = await readRepoFile('docs/usage.md');
    const contextPolicy = await readRepoFile('docs/context-loading-policy.md');
    const usageCommit = extractSection(usage, '### `/aif-commit`');
    const commandOwnership = extractSection(contextPolicy, '## Command Ownership');
    const qualityTail = extractSection(contextPolicy, '## Quality Gates and Finalization Tail');

    for (const expected of [
      'configured roadmap artifact',
      'optional GitHub issue, PR, milestone',
      'read-only roadmap/GitHub freshness gate',
      '/aif-roadmap check',
      'still writes only the git commit after user confirmation',
      '.ai-factory/ROADMAP.md',
      'GitHub issues, milestones, PRs, labels, or linked branches',
      'Generic `## Commit Plan` grouping is parent-owned in AI Factory 2.13+.',
      'AIFHub must not duplicate this grouping logic',
      '`/aif-commit` remains the only commit owner',
      'openspec/changes/<change-id>/tasks.md',
      'Follow Commit Plan',
      'Commit everything together',
      'Adjust grouping',
      'If no active change/plan resolves, keep upstream staged-diff behavior.'
    ]) {
      assertIncludes(usageCommit, expected, 'docs/usage.md /aif-commit');
    }

    assertIncludes(commandOwnership, '| `/aif-commit` | no | git commit only |', 'docs/context-loading-policy.md Command Ownership');

    for (const expected of [
      'the configured roadmap artifact',
      'optional GitHub issue/PR/milestone freshness context',
      'must not mutate OpenSpec lifecycle artifacts, `.ai-factory/ROADMAP.md`, runtime state, QA evidence, generated rules, or GitHub objects manually',
      '/aif-roadmap check',
      'still writes only the git commit after user confirmation',
      'Generic `## Commit Plan` grouping is parent-owned in AI Factory 2.13+.',
      'AIFHub adds only roadmap/GitHub freshness findings before the commit proposal.'
    ]) {
      assertIncludes(qualityTail, expected, 'docs/context-loading-policy.md Quality Gates and Finalization Tail');
    }
  });

  it('documents blocking local lifecycle drift separately from volatile GitHub drift', async () => {
    const usage = await readRepoFile('docs/usage.md');
    const contextPolicy = await readRepoFile('docs/context-loading-policy.md');
    const usageCommit = extractSection(usage, '### `/aif-commit`');
    const qualityTail = extractSection(contextPolicy, '## Quality Gates and Finalization Tail');

    for (const [label, section] of [
      ['docs/usage.md /aif-commit', usageCommit],
      ['docs/context-loading-policy.md Quality Gates and Finalization Tail', qualityTail]
    ]) {
      for (const expected of [
        'Deterministic local lifecycle drift',
        'ERROR [roadmap-local]',
        'successful local finalization',
        'managed `OpenSpec Change Lifecycle` row',
        'missing or not exactly `finalized`',
        '/aif-roadmap check',
        'user confirmation cannot bypass',
        'does not create a git commit',
        'WARN [roadmap-external]',
        'Unavailable, partial, or later-changing GitHub evidence',
        'warning-only by default'
      ]) {
        assertIncludes(section, expected, label);
      }
    }
  });

  it('documents standardized roadmap linkage and the managed local lifecycle in user workflow docs', async () => {
    const usage = await readRepoFile('docs/usage.md');
    const plan = extractSection(usage, '### `/aif-plan full`');
    const roadmap = extractSection(usage, '### `/aif-roadmap`');
    const done = extractSection(usage, '### `/aif-done`');

    for (const expected of [
      '## Roadmap Linkage',
      '`Issues`',
      '`Milestone`',
      '`Roadmap item/slice`',
      '`Rationale`',
      'explicit `none`',
      '/aif-roadmap check',
      '`planned`'
    ]) {
      assertIncludes(plan, expected, 'docs/usage.md /aif-plan full roadmap linkage');
    }

    for (const expected of [
      '<!-- aifhub:roadmap-change-lifecycle:start -->',
      '<!-- aifhub:roadmap-change-lifecycle:end -->',
      'OpenSpec Change Lifecycle',
      '`planned` and `finalized`',
      'local lifecycle',
      'outside the markers',
      'post-merge',
      '/aif-roadmap check'
    ]) {
      assertIncludes(roadmap, expected, 'docs/usage.md /aif-roadmap managed lifecycle');
    }

    for (const expected of [
      'after successful OpenSpec archive',
      'pre-archive failure leaves the managed lifecycle unchanged',
      'post-archive roadmap update failure',
      'does not roll back archive',
      '/aif-roadmap check',
      'does not claim that a GitHub issue is closed or a pull request is merged'
    ]) {
      assertIncludes(done, expected, 'docs/usage.md /aif-done roadmap transition');
    }
  });

  it('documents roadmap lifecycle co-ownership in context, compatibility, and ADR docs', async () => {
    const contextPolicy = await readRepoFile('docs/context-loading-policy.md');
    const compatibility = await readRepoFile('docs/openspec-compatibility.md');
    const adr = await readRepoFile('docs/adr/0001-openspec-native-artifact-protocol.md');

    for (const [label, source] of [
      ['docs/context-loading-policy.md', contextPolicy],
      ['docs/openspec-compatibility.md', compatibility],
      ['docs/adr/0001-openspec-native-artifact-protocol.md', adr]
    ]) {
      for (const expected of [
        '## Roadmap Linkage',
        'OpenSpec Change Lifecycle',
        '`planned`',
        '`finalized`',
        'marker-bounded',
        '/aif-done',
        '/aif-commit',
        '/aif-roadmap check',
        'post-merge',
        'GitHub open/closed/merged state'
      ]) {
        assertIncludes(source, expected, `${label} roadmap lifecycle contract`);
      }
    }
  });

  it('documents the bounded roadmap transition for Codex and Claude finalizer agents', async () => {
    const codex = extractSection(await readRepoFile('docs/codex-agents.md'), '### Finalization');
    const claude = extractSection(await readRepoFile('docs/claude-agents.md'), '### Finalization');

    for (const [label, section] of [
      ['docs/codex-agents.md Finalization', codex],
      ['docs/claude-agents.md Finalization', claude]
    ]) {
      for (const expected of [
        '## Roadmap Linkage',
        'after successful OpenSpec archive',
        'marker-bounded `OpenSpec Change Lifecycle`',
        '`finalized`',
        'pre-archive failure leaves the roadmap unchanged',
        'does not roll back archive',
        '/aif-roadmap check',
        'GitHub open/closed/merged state remains separate'
      ]) {
        assertIncludes(section, expected, label);
      }
    }
  });

  it('documents durable rules gate evidence persistence for strict done readiness', async () => {
    const usage = await readRepoFile('docs/usage.md');
    const validation = await readRepoFile('docs/openspec-validation.md');

    for (const [label, source] of [
      ['docs/usage.md', usage],
      ['docs/openspec-validation.md', validation]
    ]) {
      assertIncludes(source, 'requireRulesPassForDone', label);
      assertIncludes(source, '.ai-factory/qa/<change-id>/rules.md', label);
      assertIncludes(source, 'ai-factory aifhub-write-gate-evidence --change add-oauth-login --gate rules', label);
      assertIncludes(source, '--from /tmp/aif-rules-check-output.md', label);
      assertIncludes(source, 'final `aif-gate-result` block', label);
    }
  });

  it('documents explicit dirty-state recording for done readiness dead-end recovery', async () => {
    const readme = await readRepoFile('README.md');
    const usage = await readRepoFile('docs/usage.md');
    const validation = await readRepoFile('docs/openspec-validation.md');

    for (const [label, source] of [
      ['README.md', readme],
      ['docs/usage.md', usage],
      ['docs/openspec-validation.md', validation]
    ]) {
      assertIncludes(
        source,
        'ai-factory aifhub-done-finalizer --change <change-id> --record-dirty-state --json',
        label
      );
      assertIncludes(source, 'git status --short', label);
      assertIncludes(source, 'final QA evidence', label);
      assertIncludes(source, 'dirty workspace', label);
    }

    assertIncludes(
      usage,
      'ai-factory aifhub-done-finalizer --change <change-id> --skip-specs --record-dirty-state --json',
      'docs/usage.md'
    );
    assertNotIncludes(
      readme,
      'explicitly allow the dirty state only when the finalizer supports that path',
      'README.md'
    );
    assertNotIncludes(
      usage,
      'explicit supported dirty-state override when available',
      'docs/usage.md'
    );
  });

  it('documents installed-project helper execution through AIFHub wrappers', async () => {
    const readme = await readRepoFile('README.md');
    const usage = await readRepoFile('docs/usage.md');
    const validation = await readRepoFile('docs/openspec-validation.md');
    const compatibility = await readRepoFile('docs/openspec-compatibility.md');
    const codexAgents = await readRepoFile('docs/codex-agents.md');
    const claudeAgents = await readRepoFile('docs/claude-agents.md');
    const changelog = await readRepoFile('CHANGELOG.md');
    const handoffProfile = await readRepoFile('docs/handoff-validation-profile.md');

    for (const expected of [
      'ai-factory aifhub-validate-artifacts --change <change-id> --json',
      'ai-factory aifhub-validate-artifacts --change <change-id> --require-verification-evidence --json'
    ]) {
      assertIncludes(validation, expected, 'docs/openspec-validation.md');
    }

    for (const [label, source] of [
      ['README.md', readme],
      ['docs/usage.md', usage],
      ['docs/openspec-validation.md', validation],
      ['docs/openspec-compatibility.md', compatibility],
      ['docs/codex-agents.md', codexAgents],
      ['docs/claude-agents.md', claudeAgents],
      ['CHANGELOG.md', changelog]
    ]) {
      assertIncludes(
        source,
        'ai-factory aifhub-done-finalizer --change <change-id> --json',
        label
      );
    }

    for (const expected of [
      'Explicit non-empty',
      'project-local',
      '`PATH`',
      'auto-install',
      'commandSource',
      'Filesystem-based'
    ]) {
      assertIncludes(compatibility, expected, 'docs/openspec-compatibility.md');
    }

    assertIncludes(
      handoffProfile,
      'ai-factory aifhub-handoff-gate-summary --change <change-id> --stage review --json',
      'docs/handoff-validation-profile.md'
    );

    for (const [label, source] of [
      ['README.md', readme],
      ['docs/usage.md', usage],
      ['docs/openspec-validation.md', validation],
      ['docs/openspec-compatibility.md', compatibility],
      ['docs/codex-agents.md', codexAgents],
      ['docs/claude-agents.md', claudeAgents],
      ['docs/handoff-validation-profile.md', handoffProfile]
    ]) {
      assert.doesNotMatch(
        source,
        /\bnode\s+scripts\/[A-Za-z0-9_.-]+\.mjs\b/,
        `${label} should not expose root scripts as installed-project helper commands`
      );
    }

    for (const [label, source] of [
      ['docs/usage.md', usage],
      ['docs/openspec-validation.md', validation],
      ['docs/openspec-compatibility.md', compatibility]
    ]) {
      assert.match(
        source,
        /scripts\/openspec-[A-Za-z0-9_.-]+\.mjs[^\n]*(?:extension-local|implementation module)|(?:extension-local|implementation module)[^\n]*scripts\/openspec-[A-Za-z0-9_.-]+\.mjs/i,
        `${label} should identify internal OpenSpec module references as implementation-only`
      );
    }
  });

  it('documents planned bug fixes separately from post-verify fixes', async () => {
    const readme = await readRepoFile('README.md');
    const usage = await readRepoFile('docs/usage.md');
    const contextPolicy = await readRepoFile('docs/context-loading-policy.md');
    const readmeBugFixes = extractSection(readme, '## Bug Fix Workflows');
    const usageBugFixes = extractSection(usage, '## Bug Fix Workflows');
    const contextBugFixes = extractSection(contextPolicy, '## Bug Fix Context');

    for (const [label, section] of [
      ['README.md Bug Fix Workflows', readmeBugFixes],
      ['docs/usage.md Bug Fix Workflows', usageBugFixes]
    ]) {
      for (const expected of [
        '/aif-plan full "fix <bug description>"',
        '/aif-improve <change-id>',
        '/aif-mode sync --change <change-id>',
        '/aif-implement <change-id>',
        '/aif-rules-check',
        '/aif-verify <change-id>',
        '/aif-done <change-id>',
        '/aif-mode sync',
        '/aif-commit',
        '/aif-verify <change-id> -> fail',
        '/aif-fix <change-id>',
        'A bug fix is still an OpenSpec change when it changes product or workflow behavior.',
        'Create delta specs when behavior changes.',
        'Docs/tooling-only bug fixes may omit delta specs only when the proposal explains why no product or workflow behavior changes.',
        'Missing OpenSpec CLI means degraded validation, not planning failure.',
        '`/aif-fix` requires existing QA evidence or selected findings.',
        '`/aif-fix` does not create a new OpenSpec change.',
        '`.ai-factory/state/<change-id>/fixes/`',
        '`/aif-fix` does not write QA verdicts.',
        '`/aif-fix` does not archive.',
        '`/aif-fix` routes back to `/aif-verify <change-id>`.',
        'No OpenSpec-native bug-fix path creates `.ai-factory/plans/<id>/`.'
      ]) {
        assertIncludes(section, expected, label);
      }
    }

    for (const expected of [
      'New bug reports are planning input.',
      'Post-verify fixes are execution input.',
      'Fresh bug reports must start with `/aif-plan full "fix <bug description>"`.',
      '`/aif-fix` must not create a canonical OpenSpec change',
      '`/aif-fix` must not create `.ai-factory/plans/<id>/`'
    ]) {
      assertIncludes(contextBugFixes, expected, 'docs/context-loading-policy.md Bug Fix Context');
    }

    assertNotIncludes(readmeBugFixes, '.ai-factory/plans/<id>/task.md', 'README.md Bug Fix Workflows');
    assertNotIncludes(usageBugFixes, '.ai-factory/plans/<id>/task.md', 'docs/usage.md Bug Fix Workflows');
  });

  it('documents branch-scoped QA-check binding, staleness, safety, and redaction', async () => {
    const usage = await readRepoFile('docs/usage.md');
    const contextPolicy = await readRepoFile('docs/context-loading-policy.md');
    const compatibility = await readRepoFile('docs/openspec-compatibility.md');
    const combined = [usage, contextPolicy, compatibility].join('\n');

    for (const expected of [
      '/aif-qa-check',
      'paths.qa/<branch-slug>/test-cases.md',
      'paths.qa/<branch-slug>/qa-check.md',
      '<safe-prefix>-<hash8>',
      'tested_revision',
      'worktree_digest',
      'manual_build_id',
      'source_digest',
      'case_digests',
      'Stale',
      'agent-context.md',
      'agent-history.md',
      'explicit authorization',
      '[REDACTED]',
      'no implicit bridge'
    ]) {
      assertIncludes(combined, expected, `QA-check docs contract: ${expected}`);
    }

    for (const sensitiveExample of [
      'Authorization: Bearer ',
      'Cookie: session=',
      'access_token=secret',
      'password=secret'
    ]) {
      assertNotIncludes(combined, sensitiveExample, `QA-check redaction contract: ${sensitiveExample}`);
    }
  });

  it('documents the AI Factory 2.19 source snapshot, cumulative 2.18.1 executable baseline, and ownership boundaries', async () => {
    const metadata = JSON.parse(await readRepoFile('aifhub-extension.json'));
    const manifest = JSON.parse(await readRepoFile('extension.json'));
    const readme = await readRepoFile('README.md');
    const changelog = await readRepoFile('CHANGELOG.md');
    const usage = await readRepoFile('docs/usage.md');
    const compatibility = await readRepoFile('docs/openspec-compatibility.md');
    const docsIndex = await readRepoFile('docs/README.md');
    const contextPolicy = await readRepoFile('docs/context-loading-policy.md');
    const mcpDocs = await readRepoFile('docs/aifhub-mcp.md');
    const handoff = await readRepoFile('docs/handoff.md');
    const codexAgents = await readRepoFile('docs/codex-agents.md');
    const combinedDocs = [readme, changelog, usage, compatibility, docsIndex, contextPolicy, mcpDocs, handoff].join('\n');

    assert.equal(metadata.compat['ai-factory'], '>=2.11.0 <3.0.0', 'aifhub-extension.json compat.ai-factory');
    assert.equal(metadata.sources['ai-factory'].version, '2.19.0', 'aifhub-extension.json sources.ai-factory.version');
    assert.equal(metadata.sources['ai-factory'].baselineVersion, '2.19.0', 'aifhub-extension.json sources.ai-factory.baselineVersion');
    assert.equal(metadata.sources['ai-factory'].lastSync, '2026-09-01', 'aifhub-extension.json sources.ai-factory.lastSync');
    assertIncludes(metadata.sources['ai-factory'].notes, 'snapshot declaring 2.19.0', 'aifhub-extension.json sources.ai-factory.notes');
    assertIncludes(metadata.sources['ai-factory'].notes, '3c1ddd4740d7b1c30d8ecb3dc80fa5e7b8d7ef5a', '2.19 source custody: exact commit');
    assertIncludes(metadata.sources['ai-factory'].notes, '7 commits and 16 changed files', '2.19 source custody: exact comparison size');
    assertIncludes(metadata.sources['ai-factory'].notes, 'No 2.19.0 Git tag, GitHub release, or npm package', '2.19 source custody: unpublished boundary');
    assertIncludes(metadata.sources['ai-factory'].notes, 'last exact published-executable consumer smoke remains 2.18.1', '2.19 source custody: executable boundary');
    assertIncludes(metadata.sources['ai-factory'].notes, 'upstream-owned /aif-warmup', '2.19 ownership: warmup');
    assertIncludes(metadata.sources['ai-factory'].notes, 'warmup.paths: []', '2.19 config: fresh default');
    assertIncludes(metadata.sources['ai-factory'].notes, 'without backfill', '2.19 config: preserve/no backfill');
    assertIncludes(metadata.sources['ai-factory'].notes, 'root Microsoft APM manifest', '2.19 ownership: APM');
    assertIncludes(metadata.sources['ai-factory'].notes, '2.18.0...2.18.1', '2.18.1 baseline: patch comparison');
    assertIncludes(metadata.sources['ai-factory'].notes, '2 commits across 8 files', '2.18.1 baseline: reviewed patch size');
    assertIncludes(metadata.sources['ai-factory'].notes, 'Research Coherence Gate', '2.18.1 baseline: upstream explore gate');
    assertIncludes(metadata.sources['ai-factory'].notes, 'Commit Plan grouping', 'aifhub-extension.json sources.ai-factory.notes');
    assertIncludes(metadata.sources['ai-factory'].notes, '/aif-distillation', 'aifhub-extension.json sources.ai-factory.notes');
    assertIncludes(metadata.sources['ai-factory'].notes, '/aif-archive', 'aifhub-extension.json sources.ai-factory.notes');
    assertIncludes(metadata.sources['ai-factory'].notes, '/aif-architecture', 'aifhub-extension.json sources.ai-factory.notes');
    assertIncludes(metadata.sources['ai-factory'].notes, '/aif-docs', 'aifhub-extension.json sources.ai-factory.notes');
    assertIncludes(metadata.sources['ai-factory'].notes, '/aif-qa', 'aifhub-extension.json sources.ai-factory.notes');
    assertIncludes(metadata.sources['ai-factory'].notes, 'paths.archive', 'aifhub-extension.json sources.ai-factory.notes');
    assertIncludes(metadata.sources['ai-factory'].notes, 'archive-aware sequential plan behavior', 'aifhub-extension.json sources.ai-factory.notes');
    assertIncludes(metadata.sources['ai-factory'].notes, 'config-aware project utilities', 'aifhub-extension.json sources.ai-factory.notes');
    assertIncludes(metadata.sources['ai-factory'].notes, 'managed agent config preservation', 'aifhub-extension.json sources.ai-factory.notes');
    assertIncludes(metadata.sources['ai-factory'].notes, 'Agent Skills', 'aifhub-extension.json sources.ai-factory.notes');
    assertIncludes(metadata.sources['ai-factory'].notes, 'extension schema/loader', '2.18 baseline: extension schema and loader no-op');
    assertIncludes(metadata.sources['ai-factory'].notes, 'injection and MCP contracts', '2.18 baseline: injection and MCP no-op');
    assertIncludes(metadata.sources['ai-factory'].notes, 'Node >=18', '2.18 baseline: Node contract');
    assertIncludes(metadata.sources['ai-factory'].notes, 'ultra planning', '2.18 baseline: ultra planning adapter');
    assertIncludes(metadata.sources['ai-factory'].notes, 'ultra research', '2.18 baseline: ultra research adapter');
    assertIncludes(metadata.sources['ai-factory'].notes, '/aif-loop', '2.18 baseline: loop reviewed no-op');
    assertIncludes(metadata.sources['ai-factory'].notes, '/aif-transfer', '2.18 baseline: transfer reviewed no-op');
    assertIncludes(metadata.sources['ai-factory'].notes, 'skills.sh', '2.18 baseline: skills.sh docs no-op');

    for (const [source, expected, label] of [
      [readme, '### AI Factory 2.19 Reviewed Source Snapshot', 'README.md AI Factory 2.19 source-snapshot heading'],
      [readme, 'immutable `## Original Request`', 'original-request: README.md immutable source'],
      [readme, '`WARN [research-drift]`', 'research-drift: README.md warning'],
      [readme, 'same targeted regression check before and after the edit', 'fix-regression: README.md pre/post contract'],
      [readme, '`/aif-qa-check` consumes branch-scoped `test-cases.md`', 'qa-check: README.md branch scope'],
      [mcpDocs, 'AI Factory `2.16+`', 'universal-mcp: docs/aifhub-mcp.md version boundary'],
      [mcpDocs, 'Universal / Other (`.mcp.json`)', 'universal-mcp: docs/aifhub-mcp.md runtime and path'],
      [mcpDocs, '`mcpServers`', 'universal-mcp: docs/aifhub-mcp.md standard key'],
      [readme, 'project-specific `Control Flow` base rule only when repository evidence supports it', 'control-flow: README.md evidence gate'],
      [readme, 'source-reviewed against the AI Factory `2.x` snapshot', 'README.md AI Factory 2.19 source baseline'],
      [readme, 'upstream-owned Research Coherence Gate', 'README.md upstream explore gate ownership'],
      [changelog, 'Reviewed AI Factory source baseline обновлён до snapshot, declaring `2.19.0`', 'CHANGELOG.md Unreleased AI Factory source-baseline version'],
      [docsIndex, 'pinned AI Factory 2.19 source snapshot', 'docs/README.md AI Factory source-snapshot index entry'],
      [docsIndex, 'AI Factory 2.18.1 published-executable baseline', 'docs/README.md AI Factory executable-baseline index entry']
    ]) {
      assertIncludes(source, expected, label);
    }

    for (const [expected, label] of [
      ['AI Factory 2.18 Reviewed Baseline', '2.18 baseline: docs/openspec-compatibility.md heading'],
      ['AI Factory 2.19 Reviewed Source Snapshot', '2.19 source snapshot: docs/openspec-compatibility.md heading'],
      ['7 commits and 16 changed files', '2.19 source snapshot: exact range size'],
      ['no `2.19.0` Git tag, GitHub release, or npm package', '2.19 source snapshot: unpublished boundary'],
      ['`/aif-warmup`', '2.19 source snapshot: upstream warmup'],
      ['`warmup.paths` config', '2.19 source snapshot: user-owned config'],
      ['Microsoft APM manifest', '2.19 source snapshot: upstream APM boundary'],
      ['AI Factory 2.18 audit', '2.18 baseline: compatibility audit table'],
      ['AI Factory 2.18.1 patch audit', '2.18.1 baseline: compatibility patch audit'],
      ['AI Factory 2.18 consumer ledger', '2.18 baseline: consumer ledger'],
      ['Extension schema and loader', '2.18 no-op: extension schema and loader'],
      ['Injection and MCP runtime', '2.18 no-op: injection and MCP runtime'],
      ['Node, bin and dependencies', '2.18 no-op: Node and dependencies'],
      ['Ultra planning', '2.18 adapter: ultra planning'],
      ['Ultra research', '2.18 adapter: ultra research'],
      ['Completed-phase `/aif-loop` budget', '2.18 no-op: loop budget'],
      ['Privacy-gated `/aif-transfer`', '2.18 no-op: transfer'],
      ['skills.sh installation documentation', '2.18 no-op: skills.sh docs'],
      ['Research Coherence Gate', '2.18.1 adapter: upstream explore gate'],
      ['prompt/docs-only', '2.18.1 no-op: runtime/API patch surface'],
      ['Custom fix-plan preservation', 'fix-plan no-op: docs/openspec-compatibility.md'],
      ['AIFHub adds no delete implementation', 'fix-plan no-op ownership: docs/openspec-compatibility.md'],
      ['Refined `/aif-architecture` structure', 'architecture no-op: docs/openspec-compatibility.md'],
      ['`injections/core/aif-architecture-context-boundary.md` remains boundary-only', 'architecture no-op boundary: docs/openspec-compatibility.md'],
      ['Generated-rules changes', 'generated-rules no-op: docs/openspec-compatibility.md'],
      ['does not duplicate it in the generated-rules compiler', 'generated-rules no-op ownership: docs/openspec-compatibility.md'],
      ['Community-extension documentation', 'community docs no-op: docs/openspec-compatibility.md'],
      ['complete upstream community documentation bodies are not copied', 'community docs no-op copy boundary: docs/openspec-compatibility.md']
    ]) {
      assertIncludes(compatibility, expected, label);
    }

    assert.equal(
      manifest.injections.some((entry) => entry.target === 'aif-qa-check'),
      false,
      'qa-check: extension.json must not register an implicit aif-qa-check injection'
    );
    assert.equal(
      manifest.commands.some((entry) => entry.name === 'aif-qa-check'),
      false,
      'qa-check: extension.json must not add an extension-owned aif-qa-check command'
    );
    assert.equal(
      manifest.skills.includes('skills/aif-architecture'),
      false,
      'architecture no-op: extension.json must not add an extension-owned aif-architecture skill'
    );
    assert.equal(
      manifest.injections.some((entry) => entry.target === 'aif-warmup'),
      false,
      '2.19 warmup no-op: extension.json must not register an aif-warmup injection'
    );
    assert.equal(
      manifest.skills.some((entry) => entry.replaceAll('\\', '/').split('/').at(-1) === 'aif-warmup'),
      false,
      '2.19 warmup no-op: extension.json must not add an extension-owned aif-warmup skill'
    );
    assert.equal(
      manifest.commands.some((entry) => entry.name === 'aif-warmup'),
      false,
      '2.19 warmup no-op: extension.json must not add an extension-owned aif-warmup command'
    );

    assertNotIncludes(readme, '### AI Factory 2.13 Sync', 'README.md');
    assertIncludes(
      compatibility,
      'AI Factory 2.12+ provides an optional read-only artifact audit command',
      'docs/openspec-compatibility.md'
    );
    for (const expected of [
      'AI Factory 2.19 Reviewed Source Snapshot',
      'AI Factory `2.19.0`',
      'warmup.paths',
      'upstream-owned `/aif-warmup`',
      'AI Factory 2.18 Reviewed Baseline',
      'AI Factory `2.18.1`',
      'config-aware project-context utilities',
      'project-context utilities',
      '/aif-architecture',
      '/aif-docs',
      '/aif-qa',
      'paths.architecture',
      'paths.docs',
      'paths.qa/<branch-slug>/',
      'not required per-change OpenSpec lifecycle gates',
      'upstream project-level architecture context',
      'OpenSpec canonical change/spec generation',
      'upstream manual QA artifacts',
      'distinct from AIFHub verification and finalization evidence',
      '/aif-archive',
      'paths.archive',
      '.ai-factory/archive/',
      'paths.archive/plans/*.md',
      'paths.archive/roadmap/',
      'Archived legacy plans are excluded from active sequential plan numbering and discovery',
      'archived legacy plans are excluded from active plan discovery',
      'archived legacy plans are excluded from active sequential plan discovery and numbering',
      'must not run `openspec archive <change-id> --yes`',
      'must not write `openspec/changes/**`',
      'must not write `openspec/specs/**`',
      'must not write `.ai-factory/qa/**`',
      'must not write `.ai-factory/state/**`',
      'must not write `.ai-factory/rules/generated/**`',
      'OpenSpec-native finalization remains `/aif-verify <change-id>` followed by `/aif-done <change-id>`',
      'managed agent config files',
      'newly available built-in skills',
      'upstream installer/update behavior only',
      'AI Factory 2.13+',
      '/aif-distillation',
      'upstream utility skill',
      'books, docs, folders, or URLs',
      'reusable Agent Skills',
      'not an AIFHub lifecycle stage',
      'does not create OpenSpec changes',
      'openspec/changes/**',
      'openspec/specs/**',
      '.ai-factory/qa/**',
      '.ai-factory/rules/generated/**',
      'current agent skills directory',
      '/aif-distillation docs/memory-tools-research --name aifhub-memory-tool-selection',
      '/aif-distillation docs/context-providers.md --name aifhub-context-providers'
    ]) {
      assertIncludes(combinedDocs, expected, `AI Factory 2.18 cumulative docs contract: ${expected}`);
    }
    for (const forbiddenClaim of [
      '`/aif-done` creates commits',
      '`/aif-done` creates git commits',
      '`/aif-done` writes commits',
      '`/aif-done` writes git commits',
      '/aif-done creates commits',
      '/aif-done writes commits'
    ]) {
      assertNotIncludes(combinedDocs, forbiddenClaim, 'docs must not claim /aif-done creates commits');
    }
    for (const forbiddenClaim of [
      '`/aif-archive` finalizes the OpenSpec lifecycle',
      '`/aif-archive` runs `openspec archive <change-id> --yes`',
      '`/aif-archive` writes OpenSpec finalization evidence',
      '/aif-archive finalizes the OpenSpec lifecycle',
      '/aif-archive runs openspec archive',
      '/aif-archive writes OpenSpec finalization evidence'
    ]) {
      assertNotIncludes(combinedDocs, forbiddenClaim, 'docs must not assign OpenSpec finalization to /aif-archive');
    }
    for (const forbiddenClaim of [
      '`/aif-architecture` is required per-change',
      '`/aif-docs` is required per-change',
      '`/aif-qa` is required per-change',
      '`/aif-architecture` writes OpenSpec changes',
      '`/aif-docs` writes OpenSpec changes',
      '`/aif-qa` writes OpenSpec finalization evidence',
      '/aif-architecture is required per-change',
      '/aif-docs is required per-change',
      '/aif-qa is required per-change',
      '/aif-architecture writes OpenSpec changes',
      '/aif-docs writes OpenSpec changes',
      '/aif-qa writes OpenSpec finalization evidence'
    ]) {
      assertNotIncludes(combinedDocs, forbiddenClaim, 'docs must keep project utilities out of required OpenSpec lifecycle gates');
    }

    assertIncludes(contextPolicy, '| `/aif-architecture` | no | no |', 'docs/context-loading-policy.md Command Ownership');
    assertIncludes(contextPolicy, '| `/aif-docs` | no | no |', 'docs/context-loading-policy.md Command Ownership');
    assertIncludes(contextPolicy, '| `/aif-qa` | no | upstream manual QA artifacts under `paths.qa/<branch-slug>/`; not AIFHub `.ai-factory/qa/<change-id>/` evidence |', 'docs/context-loading-policy.md Command Ownership');
    assertIncludes(contextPolicy, 'Adjacent upstream project-context utilities:', 'docs/context-loading-policy.md Quality Gates and Finalization Tail');
    assertIncludes(contextPolicy, '| `/aif-archive` | no | legacy classic/marked-ultra archive plus `paths.archive/roadmap/*.md`; OpenSpec-native plan-mutating targets stop before discovery |', 'docs/context-loading-policy.md Command Ownership aif-archive boundary');
    assertIncludes(handoff, 'не является Handoff Done stage и не владеет OpenSpec-native archive/finalization', 'docs/handoff.md aif-archive ownership boundary');
    assertIncludes(handoff, 'Не используйте `/aif-archive` для OpenSpec-native Done.', 'docs/handoff.md');

    assertIncludes(readme, 'Codex CLI and Claude agent files', 'README.md');
    assertIncludes(readme, 'Namespaced Codex CLI agent files', 'README.md');

    for (const expected of [
      'Codex CLI (`codex`)',
      '.codex/skills',
      '.codex/agents',
      'runtime: "codex"',
      'Codex app (`codex-app`)',
      '.agents/skills',
      'no extension `agentFiles` target yet',
      '.codex/config.toml',
      '$aif-*',
      'The extension `agentFiles` cannot target `codex-app` yet',
      'extension helpers',
      'not replacements for upstream bundled Codex CLI agents',
      'plan-coordinator',
      'implement-coordinator',
      'review-sidecar'
    ]) {
      assertIncludes(codexAgents, expected, 'docs/codex-agents.md');
    }
  });

  it('documents AI Factory 2.18 mode, marker, archive, ownership, update, and language-policy boundaries', async () => {
    const manifest = JSON.parse(await readRepoFile('extension.json'));
    const packageJson = JSON.parse(await readRepoFile('package.json'));
    const readme = await readRepoFile('README.md');
    const usage = await readRepoFile('docs/usage.md');
    const contextPolicy = await readRepoFile('docs/context-loading-policy.md');
    const migration = await readRepoFile('docs/legacy-plan-migration.md');
    const adr = await readRepoFile('docs/adr/0001-openspec-native-artifact-protocol.md');
    const archiveInjection = await readRepoFile('injections/core/aif-archive-openspec-boundary.md');
    const modeMatrix = extractSection(usage, '## AI Factory 2.18 Artifact Profiles');
    const updateBehavior = extractSection(readme, '## Update Behavior');
    const consumerSmoke = extractSection(usage, '## Local Consumer Smoke Checks');
    const combinedBoundaries = [readme, usage, contextPolicy, migration, adr].join('\n');

    for (const expected of [
      '| OpenSpec-native | regular/full | `proposal.md`, `design.md`, `tasks.md`, applicable delta specs | canonical OpenSpec workflow |',
      '| OpenSpec-native | explicit `ultra`, stable AI Factory `>=2.18.0` | the same canonical files with a stricter Ultra Detail Gate | no `index.md`, `phase-*`, companion files, or active ultra marker |',
      '| Legacy AI Factory-only | classic | `<id>.md` plus classic companion directory | existing AIFHub classic compatibility workflow |',
      '| Legacy AI Factory-only | explicit `ultra`, stable AI Factory `>=2.18.0` | `<id>/index.md` plus direct `phase-NN-<slug>.md`, exactly one `<!-- aif:plan-mode:ultra -->`; `index.md` is the only checkbox/progress ledger | marker-first exact upstream handoff; no sibling classic plan or companion synchronization |',
      'provenance-matched CLI/project version evidence stops before writes',
      'unverified global/PATH-only CLI evidence is ignored with a bounded warning'
    ]) {
      assertIncludes(modeMatrix, expected, `docs/usage.md AI Factory 2.18 Artifact Profiles row: ${expected}`);
    }

    for (const [source, expected, label] of [
      [migration, 'AIFHub migrates only classic shapes.', 'docs/legacy-plan-migration.md classic-only migration boundary'],
      [migration, 'reported as `skipped-ultra`', 'docs/legacy-plan-migration.md valid marked-ultra outcome'],
      [migration, '.ai-factory/state/legacy-plan-source.json', 'docs/legacy-plan-migration.md captured legacy source binding'],
      [migration, '--legacy-source <project-relative-plans-root>', 'docs/legacy-plan-migration.md explicit legacy source override'],
      [contextPolicy, '<parent(paths.research)>/research/<slug>/', 'docs/context-loading-policy.md ultra-research supporting-context root'],
      [contextPolicy, 'upstream-owned `Research Coherence Gate`', 'docs/context-loading-policy.md upstream coherence ownership'],
      [contextPolicy, 'before the Bundle Integrity Gate', 'docs/context-loading-policy.md ultra coherence ordering'],
      [contextPolicy, '.ai-factory/state/legacy-ultra-verification/', 'docs/context-loading-policy.md revision-bound ultra receipt root'],
      [contextPolicy, 'plan-mutating targets return `/aif-done <change-id>` before resolving `paths.plans`', 'docs/context-loading-policy.md OpenSpec archive owner handoff'],
      [contextPolicy, 'marked-ultra archive', 'docs/context-loading-policy.md legacy marked-ultra archive ownership'],
      [adr, 'sole canonical change ledger', 'docs/adr/0001 OpenSpec single-source invariant'],
      [readme, 'AIFHub ships no duplicate loop/transfer skill or injection.', 'README.md upstream aif-loop/aif-transfer no-op ownership']
    ]) {
      assertIncludes(source, expected, label);
    }

    for (const forbiddenClaim of [
      'OpenSpec-native ultra writes `index.md`',
      'OpenSpec-native ultra writes `phase-',
      'AIFHub automatically migrates marked ultra',
      'AIFHub synchronizes marked ultra into OpenSpec',
      '`/aif-done` writes the legacy ultra verification receipt',
      '`/aif-archive` finalizes OpenSpec-native changes'
    ]) {
      assertNotIncludes(combinedBoundaries, forbiddenClaim, `AI Factory 2.18 docs forbidden ownership claim: ${forbiddenClaim}`);
    }

    for (const ownedRuntimeName of ['aif-loop', 'aif-transfer']) {
      assert.equal(
        manifest.skills.some((entry) => entry.replaceAll('\\', '/').split('/').at(-1) === ownedRuntimeName),
        false,
        `extension.json skills must not duplicate upstream ${ownedRuntimeName}`
      );
      assert.equal(
        manifest.injections.some((entry) => entry.target === ownedRuntimeName),
        false,
        `extension.json injections must not duplicate upstream ${ownedRuntimeName}`
      );
    }

    const archiveInjections = manifest.injections.filter((entry) => entry.target === 'aif-archive');
    assert.equal(archiveInjections.length, 1, 'extension.json injections must contain exactly one aif-archive boundary');
    assert.equal(archiveInjections[0].position, 'prepend', 'extension.json aif-archive injection position');
    assert.equal(
      archiveInjections[0].file,
      './injections/core/aif-archive-openspec-boundary.md',
      'extension.json aif-archive injection file'
    );
    assertIncludes(
      archiveInjection,
      'Follow `skills/shared/LANGUAGE-POLICY.md` before producing user-facing responses.',
      'injections/core/aif-archive-openspec-boundary.md language-policy coverage'
    );
    assertIncludes(
      archiveInjection,
      'This prepend boundary performs classification and routing only.',
      'injections/core/aif-archive-openspec-boundary.md classification-only ownership'
    );
    assertNotIncludes(
      archiveInjection,
      '/aif-transfer',
      'injections/core/aif-archive-openspec-boundary.md must not invoke upstream transfer'
    );

    for (const expected of [
      'ai-factory update --force',
      'ai-factory extension update aifhub-extension --force',
      '`ai-factory upgrade` is the v1-to-v2 skill-name migration command',
      'missing prerequisites are `NOT_RUN`',
      'never downloads a toolchain',
      'not release, deployment, registry, or end-user migration proof'
    ]) {
      assertIncludes(updateBehavior, expected, `README.md Update Behavior contract: ${expected}`);
    }
    for (const expected of [
      'ai-factory update --force',
      'ai-factory extension update aifhub-extension --force',
      'No toolchain is downloaded or resolved through `npx`.',
      'Missing command/package/extension prerequisites are `NOT_RUN`, not PASS.',
      '`ai-factory upgrade` is intentionally absent'
    ]) {
      assertIncludes(consumerSmoke, expected, `docs/usage.md Local Consumer Smoke Checks contract: ${expected}`);
    }
    for (const expected of [
      'exact `2.17.0`/`2.18.1`',
      '`2.18.0` remains a separate stable feature boundary',
      'upstream `aif-explore` bytes',
      'Research Coherence Gate'
    ]) {
      assertIncludes(consumerSmoke, expected, `docs/usage.md AI Factory 2.18.1 smoke contract: ${expected}`);
    }
    assert.equal(
      packageJson.scripts['smoke:ai-factory-2-18'],
      'node scripts/ai-factory-2-18-live-smoke.mjs',
      'package.json scripts.smoke:ai-factory-2-18 must be non-globbed opt-in live driver'
    );
  });

  it('documents the cumulative exact-tagged OpenSpec 1.12.0 baseline, custody and adapter boundary', async () => {
    const metadata = JSON.parse(await readRepoFile('aifhub-extension.json'));
    const readme = await readRepoFile('README.md');
    const compatibility = await readRepoFile('docs/openspec-compatibility.md');
    const validation = await readRepoFile('docs/openspec-validation.md');
    const docsIndex = await readRepoFile('docs/README.md');
    const changelog = await readRepoFile('CHANGELOG.md');
    const openspec = metadata.sources.openspec;
    const combinedDocs = [readme, compatibility, validation, docsIndex, changelog].join('\n');
    const readmeCompatibility = extractSection(readme, '## OpenSpec Compatibility');

    assert.equal(openspec.version, '1.12.0');
    assert.equal(openspec.baselineVersion, '1.3.1');
    assert.equal(openspec.supportedRange, '>=1.3.1 <2.0.0');
    assert.deepEqual(openspec.reviewedStableVersions, ['1.3.1', '1.4.0', '1.4.1', '1.5.0', '1.6.0', '1.7.0', '1.8.0', '1.9.0', '1.10.0', '1.11.0', '1.12.0']);
    assert.deepEqual(openspec.reviewedPrereleaseVersions, ['1.6.0-beta.1']);
    assert.equal(openspec.lastSync, '2026-09-05');
    assertIncludes(openspec.notes, 'upstream OpenSpec 1.3.1 through 1.12.0', 'aifhub-extension.json');
    assertIncludes(openspec.notes, 'adapter-only', 'aifhub-extension.json');

    assertIncludes(
      readmeCompatibility,
      `The reviewed OpenSpec baseline is OpenSpec \`${openspec.version}\``,
      'README.md OpenSpec Compatibility reviewed baseline'
    );
    assertIncludes(docsIndex, 'OpenSpec 1.12.0', 'docs/README.md');

    for (const expected of [
      'OpenSpec 1.12.0 Reviewed Baseline',
      'Exact 1.10.0 Custody and Evidence Boundary',
      'Exact 1.10.0 CLI Matrix',
      '1.10.0 Source Classification',
      'Git source custody',
      'npm executable custody',
      'official tag [`v1.10.0`]',
      '`1ebddd17f40dde15dfd28289e4493c3cf05ee9df`',
      '`@fission-ai/openspec@1.10.0`',
      '`sha512-fuL3Rz7Jv+NnHeUM1XkbaXFo4bUdPttOWOC66/6SyfJr9rPOvGE47oBp+8XdDtPiiWZawa0Z9RDzGasetFu2eQ==`',
      '`a29f5a69038df6ab1f7be3d36645c866279f0245`',
      '`openspec: ./bin/openspec.js`',
      'Node engine `>=20.19.0`',
      'no `preinstall`, `install`, or `postinstall` lifecycle script',
      '`@inquirer/core`',
      '`@inquirer/prompts`',
      'local exact-package compatibility evidence',
      'does not constitute CI verification, deployment verification, or production verification',
      '18 commits and 78 changed files',
      '`adapter-change-required`',
      '`regression-or-no-op`',
      '`upstream-owned`',
      '`planningHome.root`',
      'schema without a specs artifact',
      'stderr-only telemetry',
      'inline completion verification',
      'bounded checklist migration',
      'test, command, observable behavior, or delivered artifact',
      'Zed',
      '`init --language`',
      'Exact 1.11.0 Custody and Evidence Boundary',
      'strict task-numbering',
      'Non-strict validation',
      '`widgets/spec.md`',
      'rootless',
      'built-in `spec-driven` schema',
      'exactly one final newline',
      'Archived-wide Validation Is Advisory',
      '`openspec validate --archived`',
      'release acceptance PASS boolean',
      '## [1.5.0] - 2026-09-01',
      'OpenSpec `1.8.0`',
      'Baseline `1.3.1`',
      'Reviewed stable releases',
      'Kimi CLI',
      'Mistral Vibe',
      'sync skills',
      'case-insensitive requirement headers',
      'clearer validation hints',
      '`workspace.yaml`',
      '`openspec update`',
      'Stores',
      'config parsing',
      'CRLF',
      'additive `root`',
      '`1.6.0-beta.1`',
      'reviewed but unsupported',
      'archive validation failures return a non-zero exit code',
      '/opsx:update',
      'Oh My Pi',
      'Trae',
      'nested specs and task files',
      '.openspec.yaml',
      '`skip_specs: true`',
      '`openspec instructions archive --change <id> --json`',
      'leading digits',
      'nested spec folders',
      'UTF-8 BOM',
      '`retire_capabilities: true`',
      'scenario loss',
      'nested task progress',
      'agents target',
      'MiniMax Code',
      'Rovo Dev CLI',
      '.openspec-workspace/view.yaml',
      '/opsx:*',
      'adapter-only',
      'does not install or manage OpenSpec skills',
      'does not install or manage Kimi CLI or Mistral Vibe integrations',
      'does not own OpenSpec workspace beta state',
      'does not run or manage `openspec update`',
      '`openspec show <item> --json`',
      '`openspec update` is upstream OpenSpec behavior',
      '`/aif-mode sync` compiles AIFHub generated rules'
    ]) {
      assertIncludes(combinedDocs, expected, 'OpenSpec 1.10.0 docs baseline');
    }

    for (const forbiddenClaim of [
      'AIFHub installs OpenSpec skills',
      'AIFHub manages /opsx',
      'AIFHub manages Kimi',
      'AIFHub manages Mistral',
      'AIFHub owns workspace beta state',
      'AIFHub runs openspec update'
    ]) {
      assertNotIncludes(combinedDocs, forbiddenClaim, 'OpenSpec 1.10.0 docs ownership boundaries');
    }
  });

  it('documents Codex app flows with skill invocations and keeps slash commands runtime-specific', async () => {
    const usage = await readRepoFile('docs/usage.md');
    const planMode = await readRepoFile('docs/codex-plan-mode.md');
    const usageCodexFlow = extractSection(usage, '## Recommended Codex App Flow');
    const planModeCodexFlow = extractSection(planMode, '## Recommended Codex App Flow');

    for (const expected of [
      '$aif-explore "task description"',
      '$aif-plan full "task description"',
      '$aif-improve <change-id>',
      '$aif-mode sync --change <change-id>',
      '$aif-implement <change-id>',
      '$aif-rules-check',
      '$aif-verify <change-id>',
      '$aif-done <change-id>',
      '$aif-mode sync',
      '$aif-commit'
    ]) {
      assertIncludes(usageCodexFlow, expected, 'docs/usage.md Recommended Codex App Flow');
    }

    for (const stale of [
      '/aif-explore "task description"',
      '/aif-plan full "task description"',
      '/aif-improve <change-id>',
      '/aif-mode sync --change <change-id>',
      '/aif-implement <change-id>',
      '/aif-verify <change-id>'
    ]) {
      assertNotIncludes(usageCodexFlow, stale, 'docs/usage.md Recommended Codex App Flow');
    }

    for (const expected of [
      '/plan-mode',
      '$aif-explore "task description"',
      '$aif-plan full "task description"',
      '$aif-improve',
      '$aif-implement',
      '$aif-verify',
      'client-owned mode command',
      'AI Factory skills use `$aif-*`',
      'slash-command runtimes keep `/aif-*`'
    ]) {
      assertIncludes(planModeCodexFlow, expected, 'docs/codex-plan-mode.md Recommended Codex App Flow');
    }

    for (const stale of [
      '/aif-explore "task description"',
      '/aif-plan full "task description"',
      '/aif-implement',
      '/aif-verify'
    ]) {
      assertNotIncludes(planModeCodexFlow, stale, 'docs/codex-plan-mode.md Recommended Codex App Flow');
    }
  });

  it('documents OpenSpec plan IDs and optional audit-artifacts bridge', async () => {
    const compatibility = await readRepoFile('docs/openspec-compatibility.md');
    const aifMode = await readRepoFile('skills/aif-mode/SKILL.md');

    for (const expected of [
      'OpenSpec-native mode uses OpenSpec `change-id` values and ignores AI Factory `workflow.plan_id_format`',
      'Legacy AI Factory-only mode follows upstream `workflow.plan_id_format`',
      'ai-factory audit-artifacts openspec .ai-factory/qa .ai-factory/state --json',
      'optional read-only artifact audit command',
      'diagnostic-only',
      'not mandatory, not archive-blocking'
    ]) {
      assertIncludes(compatibility, expected, 'docs/openspec-compatibility.md');
    }

    for (const expected of [
      'selected `codex-app` runtime uses `$aif-mode`',
      'slash-command runtimes use `/aif-mode`',
      'Read-only diagnostics',
      'ai-factory audit-artifacts openspec .ai-factory/qa .ai-factory/state --json',
      'optional',
      'not mandatory',
      'not archive-blocking',
      'hard dependency'
    ]) {
      assertIncludes(aifMode, expected, 'skills/aif-mode/SKILL.md');
    }
  });

  it('keeps Ponytail evaluation manual, implementation-only, and outside extension integration', async () => {
    const providerGuide = await readRepoFile('docs/skill-providers.md');
    const usage = await readRepoFile('docs/usage.md');
    const docsIndex = await readRepoFile('docs/README.md');
    const readme = await readRepoFile('README.md');
    const changelog = await readRepoFile('CHANGELOG.md');
    const extensionManifest = await readRepoFile('extension.json');
    const packageManifest = await readRepoFile('package.json');
    const analyzeSkill = await readRepoFile('skills/aif-analyze/SKILL.md');
    const claudeImplementWorker = await readRepoFile('agent-files/claude/aifhub-implement-worker.md');
    const codexImplementWorker = await readRepoFile('agent-files/codex/aifhub-implement-worker.toml');

    for (const expected of [
      'manual_experiment_only',
      'v4.9.0',
      '0a4dd63ad4541f4f655c4108a295916f3c1d8fda',
      'SessionStart',
      'SubagentStart',
      'UserPromptSubmit',
      'PONYTAIL_SUBAGENT_MATCHER',
      'fails open',
      'NOT_RUN(dedicated_isolated_runner_required)',
      'EXECUTED(mixed_non_promotable)',
      'skill-providers-research/ponytail-pi-ab/README.md',
      'omniroute/lq/qwen3.8-27b',
      'omniroute/la/ornith-1.5-35b-a3b',
      '/aif-security-checklist',
      'fresh isolated copies',
      'extension/plugin/package dependencies',
      'recommendation metadata',
      'auto-inject Ponytail',
      'raw hook output'
    ]) {
      assertIncludes(providerGuide, expected, 'docs/skill-providers.md provider boundary');
    }

    assertIncludes(usage, 'manual_experiment_only', 'docs/usage.md provider status');
    assertIncludes(usage, 'semantic security gate', 'docs/usage.md security boundary');
    assertIncludes(docsIndex, 'skill-providers.md', 'docs/README.md discoverability');
    assertIncludes(readme, 'skill-providers.md', 'README.md discoverability');
    assertIncludes(changelog, 'DietrichGebert/ponytail', 'CHANGELOG.md evaluation record');
    assertIncludes(changelog, 'manual_experiment_only', 'CHANGELOG.md provider status');

    assertNotIncludes(extensionManifest, 'ponytail', 'extension.json integration boundary');
    assertNotIncludes(packageManifest, 'ponytail', 'package.json dependency boundary');
    assertNotIncludes(analyzeSkill, 'ponytail', 'aif-analyze recommendation boundary');
    assertNotIncludes(claudeImplementWorker, 'ponytail', 'Claude implementation instruction boundary');
    assertNotIncludes(codexImplementWorker, 'ponytail', 'Codex implementation instruction boundary');
  });

  it('documents provider-neutral MCP work-item IDs across OpenSpec and legacy modes', async () => {
    const readme = await readRepoFile('README.md');
    const usage = await readRepoFile('docs/usage.md');
    const compatibility = await readRepoFile('docs/openspec-compatibility.md');
    const resolver = await readRepoFile('docs/active-change-resolver.md');
    const changelog = await readRepoFile('CHANGELOG.md');
    const planUsage = extractSection(usage, '### `/aif-plan full`');
    const planPolicy = extractSection(compatibility, '## Workflow Plan ID Policy');
    const unreleased = extractSection(changelog, '## [В разработке]');

    for (const expected of [
      'GitHub, Linear, Jira, YouGile',
      '`156-fix-login`',
      '`eng-431-fix-login`',
      'persist provider, full primary source, external ID, and creation branch separately',
      'resolver checks one exact binding before slug matching',
      'current pointer to disambiguate several plans intentionally created on the same branch',
      'contains unrelated malformed bindings to warnings',
      'Ambiguous multi-item input keeps ordinary allocation',
      'collisions fail closed'
    ]) {
      assertIncludes(readme, expected, 'README.md MCP work-item plan identity');
    }

    for (const expected of [
      'exactly one explicit primary work item',
      '`156-fix-login-timeout`',
      '`eng-431-fix-login-timeout`',
      '`proj-77-refresh-token`',
      '`yougile-a1b2c3d4-refresh-token`',
      'A bare number, PR URL, branch name, title, label, milestone, or discovered search result does not establish this binding',
      'explicitly primary',
      '`source-plan-id-collision`',
      '## AIFHub Source Binding',
      'Provider: linear',
      'Primary source: mcp://linear/issue/6a1f24c8',
      'External ID: ENG-431',
      'secondary reference in `Roadmap Linkage.Issues`',
      'source_binding.primary_source',
      'source_binding.external_id',
      'source_binding.branch',
      'one exact binding is checked before ordinary slug branch variants',
      'complete resolved change ID to the current-change pointer',
      'pointer selects one of the exact candidates',
      'unrelated invalid binding becomes a warning',
      'roadmap-list membership and external-ID equality are insufficient'
    ]) {
      assertIncludes(planUsage, expected, 'docs/usage.md MCP work-item plan identity');
    }

    for (const expected of [
      'takes precedence over ordinary new-plan allocation',
      '`openspec/changes/156-fix-login-timeout/`',
      '`openspec/changes/eng-431-fix-login-timeout/`',
      '`0042_PROJ-77-refresh-token`',
      '`source-plan-id-collision`',
      '`HANDOFF_BRANCH_PREPARED=1` retains upstream precedence',
      'source-bound proposal persists one exact `## AIFHub Source Binding` with `Provider`, `Primary source`, `External ID`, and `Branch`',
      'secondary links and equal external IDs never satisfy a collision check',
      'source_binding.primary_source',
      'source_binding.external_id',
      'source_binding.branch',
      'same full `Primary source`'
    ]) {
      assertIncludes(planPolicy, expected, 'docs/openspec-compatibility.md Workflow Plan ID Policy');
    }

    for (const expected of [
      'Current git branch matched to one exact persisted `## AIFHub Source Binding`',
      '`source-binding-change-id-mismatch`',
      '`ambiguous-branch-binding`',
      '`ambiguous-branch-binding-disambiguated`',
      '`parseWorkItemSourceBinding()`',
      '`parseSynchronizedWorkItemSourceBinding()`',
      '`matchesPrimarySourceBinding()`',
      '`deriveSourceBoundChangeId()`',
      'another repository, tenant, or provider never matches by key alone',
      'source `branch-binding` before ordinary slug matching',
      'may disambiguate only by naming one of those candidates',
      'one unrelated artifact cannot block every command in the repository'
    ]) {
      assertIncludes(resolver, expected, 'docs/active-change-resolver.md source binding');
    }

    for (const expected of [
      'GitHub, Linear, Jira, YouGile',
      '`<external-id>-<request-slug>`',
      'primary source',
      'four-digit compatibility prefix'
    ]) {
      assertIncludes(unreleased, expected, 'CHANGELOG.md unreleased MCP work-item plan identity');
    }
  });

  it('documents bounded generated-rules reconciliation across tracked source surfaces', async () => {
    const readme = await readRepoFile('README.md');
    const usage = await readRepoFile('docs/usage.md');
    const compatibility = await readRepoFile('docs/openspec-compatibility.md');
    const contextPolicy = await readRepoFile('docs/context-loading-policy.md');
    const canonicalSkill = await readRepoFile('skills/aif-mode/SKILL.md');
    const canonicalSync = await readRepoFile('skills/aif-mode/references/ARTIFACT-SYNC.md');
    const canonicalSafety = await readRepoFile('skills/aif-mode/references/SAFETY.md');
    const canonicalTemplate = await readRepoFile('skills/aif-mode/templates/mode-switch-report.md');

    for (const [asset, label] of [
      [usage, 'docs/usage.md'],
      [compatibility, 'docs/openspec-compatibility.md'],
      [canonicalSync, 'skills/aif-mode/references/ARTIFACT-SYNC.md']
    ]) {
      for (const expected of [
        'authoritative active-change inventory',
        'before the first mutation',
        'complete active',
        'at most 200',
        'unknown files',
        'partial'
      ]) {
        assertIncludes(asset, expected, label);
      }
    }

    assertIncludes(readme, 'bounded project-relative `remove`/`would-remove` operations', 'README.md generated-rules troubleshooting');
    assertIncludes(contextPolicy, 'Do not treat the directory itself', 'docs/context-loading-policy.md cleanup authority');
    assertIncludes(contextPolicy, 'raw paths found in `index.json`', 'docs/context-loading-policy.md index boundary');
    assertNotIncludes(contextPolicy, 'Files in that directory are safe to delete', 'docs/context-loading-policy.md broad cleanup wording');

    assertIncludes(canonicalSkill, 'version: "1.3.0"', 'skills/aif-mode/SKILL.md version');
    assertIncludes(canonicalSkill, 'openspec-change-<safe-id>.md', 'skills/aif-mode/SKILL.md cleanup boundary');
    assertIncludes(canonicalSkill, 'normal bounded failure report', 'skills/aif-mode/SKILL.md failure-report exception');
    assertIncludes(canonicalSkill, 'selected `codex-app` runtime uses `$aif-mode`', 'skills/aif-mode/SKILL.md Codex invocation guidance');
    assertIncludes(canonicalSkill, 'slash-command runtimes use `/aif-mode`', 'skills/aif-mode/SKILL.md slash-command guidance');

    assertIncludes(canonicalSafety, 'must never recurse', 'skills/aif-mode/references/SAFETY.md recursive boundary');
    assertIncludes(canonicalSafety, 'must not reduce the validated internal cleanup plan', 'skills/aif-mode/references/SAFETY.md public cap boundary');

    for (const placeholder of ['{{operation_count}}', '{{operations_truncated}}', '{{generated_rule_operations}}']) {
      assertIncludes(canonicalTemplate, placeholder, 'skills/aif-mode/templates/mode-switch-report.md');
    }
  });
});
