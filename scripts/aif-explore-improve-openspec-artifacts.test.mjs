// aif-explore-improve-openspec-artifacts.test.mjs - instruction-level tests for OpenSpec explore/improve contracts
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
  assert.ok(
    source.includes(expected),
    `${label} should include ${JSON.stringify(expected)}`
  );
}

function assertNotIncludes(source, unexpected, label) {
  assert.ok(
    !source.includes(unexpected),
    `${label} should not include ${JSON.stringify(unexpected)}`
  );
}

function assertOrder(source, fragments, label) {
  let cursor = -1;
  for (const fragment of fragments) {
    const index = source.indexOf(fragment, cursor + 1);
    assert.notEqual(index, -1, `${label} should include ${JSON.stringify(fragment)} after index ${cursor}`);
    assert.ok(index > cursor, `${label} should preserve ordering`);
    cursor = index;
  }
}

function assertNoInstallGuidance(source, label) {
  assert.doesNotMatch(
    source,
    /\b(?:must|should|need(?:s)? to|required to|recommended to|recommend)\s+install OpenSpec skills\b/i,
    `${label} should not tell agents to install OpenSpec skills`
  );
}

function extractSection(markdown, heading) {
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

  assert.notEqual(start, -1, `Expected section heading: ${'#'.repeat(startLevel || 3)} ${heading}`);

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

describe('aif-explore and aif-improve OpenSpec-native contracts', () => {
  it('defines mode-gated OpenSpec-native and legacy sections in both injections', async () => {
    for (const [relativePath, legacyHeading] of [
      ['injections/core/aif-explore-plan-folder.md', 'Legacy AI Factory-only mode'],
      ['injections/core/aif-improve-plan-folder.md', 'Legacy AI Factory-only mode']
    ]) {
      const injection = await readRepoFile(relativePath);
      const openspec = extractSection(injection, 'OpenSpec-native mode');
      const legacy = extractSection(injection, legacyHeading);

      assertIncludes(openspec, 'aifhub.artifactProtocol: openspec', `${relativePath} OpenSpec-native section`);
      assertIncludes(legacy, 'When OpenSpec-native mode is not enabled', `${relativePath} legacy section`);
      assertIncludes(legacy, '.ai-factory/plans/<plan-id>.md', `${relativePath} legacy section`);
      assertIncludes(legacy, '.ai-factory/plans/<plan-id>/', `${relativePath} legacy section`);
    }
  });

  it('keeps /aif-explore research-oriented without legacy plan-file requirements', async () => {
    const injection = await readRepoFile('injections/core/aif-explore-plan-folder.md');
    const openspec = extractSection(injection, 'OpenSpec-native mode');

    for (const expected of [
      'research-oriented',
      '.ai-factory/config.yaml',
      '.ai-factory/DESCRIPTION.md',
      '.ai-factory/ARCHITECTURE.md',
      '.ai-factory/RESEARCH.md',
      'openspec/specs/**',
      'openspec/changes/<change-id>/**',
      'write research output only to the resolved `paths.research` file',
      'Do not write exploration output under `.ai-factory/state/<change-id>/` or `.ai-factory/qa/<change-id>/`',
      'Do not create non-OpenSpec files under `openspec/changes/<change-id>/`',
      'Report where research was written'
    ]) {
      assertIncludes(openspec, expected, 'aif-explore OpenSpec-native section');
    }

    for (const unexpected of [
      '.ai-factory/plans/<id>.md',
      '.ai-factory/plans/<plan-id>.md',
      '.ai-factory/plans/<id>/',
      '.ai-factory/plans/<plan-id>/',
      'openspec/changes/<change-id>/explore.md',
      'openspec/changes/<change-id>/research-notes.md',
      '.ai-factory/state/<change-id>/explore.md',
      '.ai-factory/state/<change-id>/research-notes.md',
      'unless the upstream user request explicitly asks for planning through `/aif-plan`'
    ]) {
      assertNotIncludes(openspec, unexpected, 'aif-explore OpenSpec-native section');
    }
  });

  it('gates explicit ultra before writes and falls back to regular explore only', async () => {
    const injection = await readRepoFile('injections/core/aif-explore-plan-folder.md');
    const gate = extractSection(injection, 'Research profile and AI Factory version gate');

    assertOrder(
      injection,
      ['### Research profile and AI Factory version gate', '### OpenSpec-native mode', '### Legacy AI Factory-only mode'],
      'aif-explore profile routing'
    );
    for (const expected of [
      'before creating a file or directory',
      'Remove only an explicit leading `ultra` token',
      'preserve every later occurrence of `ultra` in the topic byte-for-byte',
      'resolveAiFactoryUltraSupport()',
      'scripts/ai-factory-version-resolver.mjs',
      'injected test toolchain/version first',
      'project `.ai-factory.json.version`',
      'CLI evidence only with proven matching project provenance',
      'unverified global/PATH-only CLI evidence is ignored with a bounded `ai-factory-cli-provenance-unverified` warning',
      'Missing, malformed, prerelease, unsupported `<2.18.0`, or provenance-matched CLI/project mismatch is a no-write stop',
      'Recommend regular `/aif-explore <topic>`',
      'do not redirect this failure to `/aif-plan full`',
      'do not silently perform a regular research write'
    ]) {
      assertIncludes(gate, expected, 'aif-explore ultra version gate');
    }
  });

  it('keeps regular and ultra research writes mutually exclusive', async () => {
    const injection = await readRepoFile('injections/core/aif-explore-plan-folder.md');
    const gate = extractSection(injection, 'Research profile and AI Factory version gate');
    const openspec = extractSection(injection, 'OpenSpec-native mode');
    const legacy = extractSection(injection, 'Legacy AI Factory-only mode');

    // Prompt ownership only. Filesystem shape behavior is exercised through the
    // production resolvers/classifier in their behavioral temp-tree suites.
    const ownershipCases = [
      {
        runtime: 'shared',
        profile: 'regular',
        source: gate,
        clauses: [
          'Regular `/aif-explore <topic>` writes only the resolved `paths.research` file',
          'It does not create a research bundle or change-scoped runtime note'
        ]
      },
      {
        runtime: 'shared',
        profile: 'ultra',
        source: gate,
        clauses: [
          'Create or update only one valid marked bundle for the run',
          'Do not write the regular `paths.research` file in the same run'
        ]
      },
      {
        runtime: 'openspec',
        profile: 'regular',
        source: openspec,
        clauses: ['In regular mode, write research output only to the resolved `paths.research` file.']
      },
      {
        runtime: 'openspec',
        profile: 'ultra',
        source: openspec,
        clauses: ['write only the one selected sibling research bundle', 'do not also write `paths.research`']
      },
      {
        runtime: 'legacy',
        profile: 'regular',
        source: legacy,
        clauses: ['Regular mode writes only resolved `paths.research`']
      },
      {
        runtime: 'legacy',
        profile: 'ultra',
        source: legacy,
        clauses: ['explicit stable-2.18 ultra writes only the one marked sibling bundle', 'never writes plan companions']
      }
    ];

    for (const { runtime, profile, source, clauses } of ownershipCases) {
      for (const clause of clauses) {
        assertIncludes(source, clause, `runtime=${runtime} asset=aif-explore case=${profile}-source-ownership`);
      }
    }
  });

  it('defines the exact ultra research bundle root, minimum shape, and inclusion gates', async () => {
    const injection = await readRepoFile('injections/core/aif-explore-plan-folder.md');
    const gate = extractSection(injection, 'Research profile and AI Factory version gate');

    for (const expected of [
      'research_bundles_dir = <parent directory of resolved paths.research>/research/',
      'bundle = <research_bundles_dir>/<english-topic-slug>/',
      '`INDEX.md` plus `RESEARCH.md`',
      '<!-- aif:research-mode:ultra -->',
      '`Status: active`',
      '`## Artifact Index`',
      'safe direct relative link',
      'unmarked directory',
      'missing/duplicate/code-only marker',
      'fail closed without changing either regular research or the directory',
      '`C4-CONTEXT.md`',
      '`C4-CONTAINER.md`',
      '`C4-COMPONENT-<scope>.md`',
      '`ADR-NNNN-<slug>.md`',
      '`DEPENDENCY-GRAPH.md`',
      'only when its upstream evidence-based inclusion gate is satisfied',
      'Do not create empty placeholders',
      'link every generated optional artifact from `INDEX.md` exactly once'
    ]) {
      assertIncludes(gate, expected, 'aif-explore ultra research bundle');
    }
  });

  it('keeps ultra diagnostics bounded and body-free', async () => {
    const injection = await readRepoFile('injections/core/aif-explore-plan-folder.md');
    const gate = extractSection(injection, 'Research profile and AI Factory version gate');

    for (const expected of [
      '`mode`',
      'version `source`',
      'safe project-relative bundle path',
      'created artifact names',
      'stable invalid-marker/collision `code`',
      'Never include topic/research bodies, provider output, credentials, raw stdout, raw stderr, or private absolute paths'
    ]) {
      assertIncludes(gate, expected, 'aif-explore bounded ultra diagnostics');
    }
  });

  it('preserves the upstream 2.18.1 Research Coherence Gate as a non-bypass pass-through', async () => {
    const injection = await readRepoFile('injections/core/aif-explore-plan-folder.md');
    const passThrough = extractSection(injection, 'Upstream Research Coherence Gate pass-through');
    const label = 'runtime=shared asset=aif-explore case=research-coherence-pass-through';

    assertOrder(
      injection,
      [
        '### Research profile and AI Factory version gate',
        '### Upstream Research Coherence Gate pass-through',
        '### OpenSpec-native mode'
      ],
      `${label} section ordering`
    );

    for (const expected of [
      'after every permitted persisted regular or ultra research write or update',
      'continue into the upstream AI Factory 2.18.1 `#### Research Coherence Gate (all persisted modes)`',
      'before presenting the saved result or appending the current session',
      'Fresh-context `Task` delegation is optional',
      'mandatory direct read-only fallback with the same upstream criteria',
      'never skip, delay, replace, or copy the upstream gate implementation',
      'regular: persisted write -> upstream Research Coherence Gate -> presentation/session append',
      'ultra: persisted bundle write -> upstream Research Coherence Gate -> upstream Bundle Integrity Gate -> presentation/session append',
      'non-`PASS` gate outcome stops presentation and session append',
      '`asset`, `runtime`, `case`, bounded gate outcome, and whether direct fallback was used',
      'Never log research bodies, quoted mismatch passages, provider output, credentials, raw stdout/stderr, or private absolute paths'
    ]) {
      assertIncludes(passThrough, expected, label);
    }

    for (const copiedImplementation of [
      'Each mismatch quotes verbatim both',
      'The Active Summary is understandable without the conversation',
      'Correct or qualify mismatches, record insufficient evidence'
    ]) {
      assertNotIncludes(passThrough, copiedImplementation, `${label} ownership`);
    }
  });

  it('limits /aif-explore OpenSpec change files to canonical artifacts and current commands', async () => {
    const injection = await readRepoFile('injections/core/aif-explore-plan-folder.md');
    const openspec = extractSection(injection, 'OpenSpec-native mode');

    for (const expected of [
      'openspec/changes/<change-id>/proposal.md',
      'openspec/changes/<change-id>/design.md',
      'openspec/changes/<change-id>/tasks.md',
      'openspec/changes/<change-id>/specs/**/spec.md',
      '/aif-plan full "<request>"',
      '/aif-improve <change-id>',
      '/aif-implement <change-id>'
    ]) {
      assertIncludes(openspec, expected, 'aif-explore OpenSpec-native section');
    }

    for (const unexpected of [
      'aif-plan-plus',
      'aif-improve-plus',
      'aif-implement-plus'
    ]) {
      assertNotIncludes(openspec, unexpected, 'aif-explore OpenSpec-native section');
    }
  });

  it('targets only canonical OpenSpec artifacts from /aif-improve OpenSpec-native mode', async () => {
    const injection = await readRepoFile('injections/core/aif-improve-plan-folder.md');
    const openspec = extractSection(injection, 'OpenSpec-native mode');

    for (const expected of [
      'scripts/active-change-resolver.mjs',
      'resolveActiveChange',
      'openspec/changes/<change-id>/proposal.md',
      'openspec/changes/<change-id>/design.md',
      'openspec/changes/<change-id>/tasks.md',
      'openspec/changes/<change-id>/specs/**/spec.md',
      '`task.md`, `context.md`, `rules.md`, `verify.md`, and `status.yaml` are not OpenSpec-native refinement targets'
    ]) {
      assertIncludes(openspec, expected, 'aif-improve OpenSpec-native section');
    }

    for (const unexpected of [
      '.ai-factory/plans/<id>.md',
      '.ai-factory/plans/<plan-id>.md',
      '.ai-factory/plans/<id>/task.md',
      '.ai-factory/plans/<plan-id>/task.md',
      'refine `task.md`',
      'refine `context.md`',
      'refine `rules.md`',
      'refine `verify.md`',
      'refine `status.yaml`'
    ]) {
      assertNotIncludes(openspec, unexpected, 'aif-improve OpenSpec-native section');
    }
  });

  it('requires task quality refinement across canonical OpenSpec artifacts', async () => {
    const injection = await readRepoFile('injections/core/aif-improve-plan-folder.md');
    const openspec = extractSection(injection, 'OpenSpec-native mode');

    for (const expected of [
      '#### Task Quality Refinement',
      '`proposal.md` for intent, scope, non-goals, assumptions, risks, and open questions',
      '`design.md` for C4 impact, ADR candidates, dependency notes, integration points, alternatives, and risks',
      '`tasks.md` for an executable checklist',
      '`specs/**/spec.md` for behavior deltas',
      'blocker',
      'warn',
      'info',
      'when useful',
      'without requiring classification in trivial changes',
      'Patch only affected sections',
      'avoid whole-file regeneration unless structurally unusable'
    ]) {
      assertIncludes(openspec, expected, 'aif-improve OpenSpec-native section');
    }
  });

  it('requires preservation, archived-change handling, runtime-state boundaries, and validation for /aif-improve', async () => {
    const injection = await readRepoFile('injections/core/aif-improve-plan-folder.md');
    const openspec = extractSection(injection, 'OpenSpec-native mode');

    for (const expected of [
      'Read current artifact content before editing',
      'Preserve user-written sections',
      'patch-style',
      'create only missing artifacts',
      'update the relevant requirement in an existing delta spec',
      'Changed:',
      'Preserved:',
      'openspec/changes/archive/**',
      'immutable by default',
      'validateOpenSpecChange(changeId)',
      'scripts/openspec-runner.mjs',
      'Missing or unsupported OpenSpec CLI is degraded validation',
      'ensureRuntimeLayout(changeId)',
      '.ai-factory/state/<change-id>/improve-summary.md',
      '.ai-factory/state/<change-id>/last-validation.json'
    ]) {
      assertIncludes(openspec, expected, 'aif-improve OpenSpec-native section');
    }
  });

  it('preserves immutable planning source sections until an explicit research rebase', async () => {
    const injection = await readRepoFile('injections/core/aif-improve-plan-folder.md');
    const openspec = extractSection(injection, 'OpenSpec-native mode');
    const label = 'injections/core/aif-improve-plan-folder.md immutable planning source contract';

    for (const expected of [
      'complete `## Original Request` heading and body as immutable raw source',
      'Preserve its exact bytes, including line endings, whitespace, punctuation, casing, and line breaks',
      'patch other sections around it instead of reconstructing `proposal.md`',
      'existing `## Research Context` body and `Source` revision metadata as the committed requirements snapshot',
      'unless the user explicitly requests a research rebase',
      'WARN [research-drift]',
      'expected=<embedded revision>',
      'current=<live revision>',
      'Do not apply requirements from a newer Active Summary',
      'On an explicit research rebase',
      'update the `Source` path plus `Updated` and `SHA256` metadata',
      'Report `Original Request` and `Research Context` as preserved section names',
      'do not duplicate their raw bodies in output'
    ]) {
      assertIncludes(openspec, expected, label);
    }
  });

  it('uses the shared ultra research resolver for rebase selection and downstream drift', async () => {
    const injection = await readRepoFile('injections/core/aif-improve-plan-folder.md');
    const openspec = extractSection(injection, 'OpenSpec-native mode');
    const label = 'aif-improve ultra research resolver contract';

    for (const expected of [
      'resolveUltraResearchSource()',
      'scripts/ultra-research-resolver.mjs',
      'exact project-relative `RESEARCH.md` path',
      'structured `source`, `revision`, and `diagnostic`',
      'sibling marked `INDEX.md`',
      'Artifact Index link',
      'normalized Active Summary digest',
      'safe explicit `RESEARCH.md` path, exact slug, then exactly one caller-reviewed relevant active candidate',
      'Ambiguity stops; recency never chooses a source',
      'exact regular or ultra source is missing/invalid',
      'Keep the embedded snapshot authoritative'
    ]) {
      assertIncludes(openspec, expected, label);
    }

    assert.match(
      openspec,
      /exact regular or ultra source[^\n]*missing\/invalid[^\n]*WARN \[research-drift\][^\n]*Keep the embedded snapshot authoritative/i,
      'runtime=openspec asset=aif-improve case=warning-source-ownership'
    );
    assert.match(
      openspec,
      /explicit research rebase[^\n]*safe explicit `RESEARCH\.md` path, exact slug, then exactly one caller-reviewed relevant active candidate/i,
      'runtime=openspec asset=aif-improve case=explicit-rebase-source-ownership'
    );
  });

  it('does not tell OpenSpec-native users to install OpenSpec skills', async () => {
    for (const relativePath of [
      'injections/core/aif-explore-plan-folder.md',
      'injections/core/aif-improve-plan-folder.md'
    ]) {
      const injection = await readRepoFile(relativePath);
      const openspec = extractSection(injection, 'OpenSpec-native mode');

      assertIncludes(openspec, 'Do not install OpenSpec skills', `${relativePath} OpenSpec-native section`);
      assertNoInstallGuidance(openspec, `${relativePath} OpenSpec-native section`);
    }
  });

  it('lets /aif-explore use enabled optional tools only within metadata permissions', async () => {
    const injection = await readRepoFile('injections/core/aif-explore-plan-folder.md');
    const openspec = extractSection(injection, 'OpenSpec-native mode');

    for (const expected of [
      'Enabled optional tool use',
      'recommendation-metadata.yaml',
      'ai-factory aifhub-memory-tools select --from-project --command aif-explore --json',
      'utilities.context_tools.enabled',
      'selected_tools',
      'not_selected_tools',
      'tool_id',
      'permission',
      'execution',
      'forbidden_operations',
      'protected_artifacts',
      'Do not use tools that are absent from `selected_tools`',
      'If no optional provider is selected, continue with the rg baseline',
      'This provider-specific boundary applies only when `selected_tools` includes Graphify',
      'This provider-specific boundary applies only when `selected_tools` includes Context7'
    ]) {
      assertIncludes(openspec, expected, 'aif-explore enabled optional tool use');
    }

    for (const unexpected of [
      'codegraph init <project>',
      'codegraph index --quiet <project>',
      'codegraph query --path <project>',
      'codegraph uninit --force <project>',
      'utilities.codegraph.enabled: true',
      'utilities.graphify.enabled: true'
    ]) {
      assertNotIncludes(openspec, unexpected, 'aif-explore should rely on CLI-selected tool execution');
    }
  });

  it('keeps Codex and IDE planning-mode guidance capability-gated', async () => {
    for (const relativePath of [
      'injections/core/aif-explore-plan-folder.md',
      'injections/core/aif-improve-plan-folder.md'
    ]) {
      const injection = await readRepoFile(relativePath);

      for (const expected of [
        'skills/shared/QUESTION-TOOL.md',
        'CLI or IDE runtime exposes a planning mode',
        'do not fabricate unavailable tools or client actions',
        'user controls the mode'
      ]) {
        assertIncludes(injection, expected, relativePath);
      }
    }
  });
});
