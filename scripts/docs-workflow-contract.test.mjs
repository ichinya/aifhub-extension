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
      '/aif-roadmap',
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
      '/aif-roadmap',
      'still writes only the git commit after user confirmation',
      'Generic `## Commit Plan` grouping is parent-owned in AI Factory 2.13+.',
      'AIFHub adds only roadmap/GitHub freshness findings before the commit proposal.'
    ]) {
      assertIncludes(qualityTail, expected, 'docs/context-loading-policy.md Quality Gates and Finalization Tail');
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

  it('documents the AI Factory 2.17.0 baseline, archive boundary, distillation utility, and Codex runtime split', async () => {
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
    assert.equal(metadata.sources['ai-factory'].version, '2.17.0', 'aifhub-extension.json sources.ai-factory.version');
    assert.equal(metadata.sources['ai-factory'].baselineVersion, '2.17.0', 'aifhub-extension.json sources.ai-factory.baselineVersion');
    assert.equal(metadata.sources['ai-factory'].lastSync, '2026-07-09', 'aifhub-extension.json sources.ai-factory.lastSync');
    assertIncludes(metadata.sources['ai-factory'].notes, 'upstream 2.17.0', 'aifhub-extension.json sources.ai-factory.notes');
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

    for (const [source, expected, label] of [
      [readme, '### AI Factory 2.17 Reviewed Baseline', '2.17 baseline: README.md heading'],
      [readme, 'immutable `## Original Request`', 'original-request: README.md immutable source'],
      [readme, '`WARN [research-drift]`', 'research-drift: README.md warning'],
      [readme, 'same targeted regression check before and after the edit', 'fix-regression: README.md pre/post contract'],
      [readme, '`/aif-qa-check` consumes branch-scoped `test-cases.md`', 'qa-check: README.md branch scope'],
      [mcpDocs, 'AI Factory `2.16+`', 'universal-mcp: docs/aifhub-mcp.md version boundary'],
      [mcpDocs, 'Universal / Other (`.mcp.json`)', 'universal-mcp: docs/aifhub-mcp.md runtime and path'],
      [mcpDocs, '`mcpServers`', 'universal-mcp: docs/aifhub-mcp.md standard key'],
      [readme, 'project-specific `Control Flow` base rule only when repository evidence supports it', 'control-flow: README.md evidence gate'],
      [changelog, 'Reviewed AI Factory baseline обновлён до `2.17.0`', '2.17 baseline: CHANGELOG.md'],
      [docsIndex, 'AI Factory 2.17 baseline compatibility', '2.17 baseline: docs/README.md index']
    ]) {
      assertIncludes(source, expected, label);
    }

    for (const [expected, label] of [
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

    assertNotIncludes(readme, '### AI Factory 2.13 Sync', 'README.md');
    assertIncludes(
      compatibility,
      'AI Factory 2.12+ provides an optional read-only artifact audit command',
      'docs/openspec-compatibility.md'
    );
    for (const expected of [
      'AI Factory 2.17 Reviewed Baseline',
      'AI Factory `2.17.0`',
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
      'archive-aware sequential plan behavior',
      'archived legacy plans are excluded from active plan discovery',
      'archived plans are excluded from active sequential plan numbering and discovery',
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
      assertIncludes(combinedDocs, expected, '2.17.0 docs sync');
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
    assertIncludes(contextPolicy, '| `/aif-archive` | no | `paths.archive/plans/*.md` and `paths.archive/roadmap/*.md` only in legacy AI Factory-only cleanup |', 'docs/context-loading-policy.md Command Ownership');
    assertIncludes(handoff, 'legacy-only path и не описывает OpenSpec-native finalization', 'docs/handoff.md');
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

  it('documents the OpenSpec 1.4.1 reviewed baseline and adapter-only boundaries', async () => {
    const metadata = JSON.parse(await readRepoFile('aifhub-extension.json'));
    const readme = await readRepoFile('README.md');
    const compatibility = await readRepoFile('docs/openspec-compatibility.md');
    const docsIndex = await readRepoFile('docs/README.md');
    const openspec = metadata.sources.openspec;
    const combinedDocs = [readme, compatibility, docsIndex].join('\n');

    assert.equal(openspec.version, '1.4.1');
    assert.equal(openspec.supportedRange, '>=1.3.1 <2.0.0');
    assert.equal(openspec.lastSync, '2026-06-10');
    assertIncludes(openspec.notes, 'upstream OpenSpec 1.4.1', 'aifhub-extension.json');
    assertIncludes(openspec.notes, 'adapter-only', 'aifhub-extension.json');

    assertIncludes(readme, 'OpenSpec 1.4.1', 'README.md');
    assertIncludes(docsIndex, 'OpenSpec 1.4.1', 'docs/README.md');

    for (const expected of [
      'OpenSpec 1.4.1 Reviewed Baseline',
      'OpenSpec `1.4.1`',
      '`openspec update`',
      'Kimi CLI',
      'Mistral Vibe',
      'sync skills',
      'case-insensitive requirement headers',
      'clearer validation hints',
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
      assertIncludes(combinedDocs, expected, 'OpenSpec 1.4.1 docs baseline');
    }

    for (const forbiddenClaim of [
      'AIFHub installs OpenSpec skills',
      'AIFHub manages /opsx',
      'AIFHub manages Kimi',
      'AIFHub manages Mistral',
      'AIFHub owns workspace beta state',
      'AIFHub runs openspec update'
    ]) {
      assertNotIncludes(combinedDocs, forbiddenClaim, 'OpenSpec 1.4.1 docs ownership boundaries');
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
});
