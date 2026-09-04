// aif-plan-openspec-artifacts.test.mjs - instruction-level tests for OpenSpec-native planning
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
  let inFence = false;
  let start = -1;
  let end = lines.length;

  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].startsWith('```')) {
      inFence = !inFence;
      continue;
    }

    if (!inFence && lines[index] === `### ${heading}`) {
      start = index + 1;
      break;
    }
  }

  assert.notEqual(start, -1, `Expected section heading: ### ${heading}`);

  inFence = false;
  for (let index = start; index < lines.length; index += 1) {
    if (lines[index].startsWith('```')) {
      inFence = !inFence;
      continue;
    }

    if (!inFence && lines[index].startsWith('### ')) {
      end = index;
      break;
    }
  }

  return lines.slice(start, end).join('\n');
}

function extractFencedBlockAfter(markdown, anchor) {
  const anchorIndex = markdown.indexOf(anchor);
  assert.notEqual(anchorIndex, -1, `Expected fenced-block anchor: ${anchor}`);

  const fenceStart = markdown.indexOf('```markdown\n', anchorIndex);
  assert.notEqual(fenceStart, -1, `Expected markdown fence after: ${anchor}`);
  const bodyStart = fenceStart + '```markdown\n'.length;
  const fenceEnd = markdown.indexOf('\n```', bodyStart);
  assert.notEqual(fenceEnd, -1, `Expected closing markdown fence after: ${anchor}`);
  return markdown.slice(bodyStart, fenceEnd);
}

describe('aif-plan OpenSpec-native planning contract', () => {
  it('defines mode-gated OpenSpec-native and legacy sections', async () => {
    const injection = await readRepoFile('injections/core/aif-plan-plan-folder.md');
    const openspec = extractSection(injection, 'OpenSpec-native mode');
    const legacy = extractSection(injection, 'Legacy AI Factory-only mode');

    assertIncludes(openspec, 'aifhub.artifactProtocol: openspec', 'OpenSpec-native section');
    assertIncludes(openspec, 'OpenSpec-native instructions override legacy plan-folder instructions', 'OpenSpec-native section');
    assertIncludes(legacy, 'When OpenSpec-native mode is not enabled', 'Legacy section');
    assertIncludes(legacy, '.ai-factory/plans/<plan-id>.md', 'Legacy section');
    assertIncludes(legacy, '.ai-factory/plans/<plan-id>/task.md', 'Legacy section');
  });

  it('resolves the explicit ultra profile through the shared version gate before writes', async () => {
    const injection = await readRepoFile('injections/core/aif-plan-plan-folder.md');
    const gate = extractSection(injection, 'Planning profile and AI Factory version gate');

    assertOrder(
      injection,
      [
        '### Planning profile and AI Factory version gate',
        '### OpenSpec-native mode',
        '### Legacy AI Factory-only mode'
      ],
      'aif-plan profile routing'
    );

    for (const expected of [
      'scripts/ai-factory-version-resolver.mjs',
      'injected test toolchain/version',
      'project-managed `.ai-factory.json.version`',
      'only when the executable provenance is proven to match the same project installation',
      'unverified global/PATH-only CLI evidence is ignored with a bounded `ai-factory-cli-provenance-unverified` warning',
      'Missing, malformed, prerelease, unsupported `<2.18.0`, or provenance-matched CLI/project mismatch',
      'fail closed and create no plan, change, bundle, companion, runtime-state, or research artifact',
      '`mode`, `profile`, `version`, `source`, and stable `code`',
      '/aif-plan full <request>',
      'Never include the request body, research body, provider output, credentials, raw stdout, or raw stderr'
    ]) {
      assertIncludes(gate, expected, 'aif-plan ultra version gate');
    }
  });

  it('maps OpenSpec ultra to canonical detail and leaves legacy ultra upstream-owned', async () => {
    const injection = await readRepoFile('injections/core/aif-plan-plan-folder.md');
    const gate = extractSection(injection, 'Planning profile and AI Factory version gate');
    const legacy = extractSection(injection, 'Legacy AI Factory-only mode');

    for (const expected of [
      'OpenSpec-native mode, `ultra` is a depth profile over the canonical OpenSpec change',
      'upstream Ultra Detail Gate',
      'exact files and symbols',
      'ordered edits',
      'failure handling',
      'acceptance criteria',
      'rollback',
      'verification detail',
      'MUST NOT create `index.md`, `phase-NN-*.md`, companion files, or an active standalone `<!-- aif:plan-mode:ultra -->`'
    ]) {
      assertIncludes(gate, expected, 'OpenSpec ultra depth profile');
    }

    for (const expected of [
      'explicit `/aif-plan ultra`',
      'leave creation and orchestration to the upstream skill',
      '`<paths.plans>/<plan-id>/index.md` plus direct `phase-NN-<slug>.md` files',
      '`index.md` is its sole progress ledger',
      'Do not create a sibling `<plan-id>.md`',
      'do not create or synchronize `task.md`, `context.md`, `rules.md`, `verify.md`, `status.yaml`, or `explore.md`'
    ]) {
      assertIncludes(legacy, expected, 'legacy ultra ownership');
    }
  });

  it('uses one explicit MCP work item as provider-neutral plan identity before ordinary allocation', async () => {
    const injection = await readRepoFile('injections/core/aif-plan-plan-folder.md');
    const identity = extractSection(injection, 'MCP work-item-derived plan identity');

    assertOrder(
      injection,
      [
        '### Planning profile and AI Factory version gate',
        '### MCP work-item-derived plan identity',
        '### OpenSpec-native mode',
        '### Legacy AI Factory-only mode'
      ],
      'aif-plan work-item identity routing'
    );

    for (const expected of [
      'GitHub Issues, Linear, Jira, YouGile',
      'structured MCP record selected for that input',
      '`identifier`, `key`, `number`, or display ID',
      '`mcp://<server>/<resource-kind>/<stable-record-id>`',
      '`yougile-a1b2c3d4`',
      'A bare number',
      'a pull-request URL',
      'is not identity evidence',
      'Exactly one distinct work item selects `source_provider`, `primary_source`, and `external_id`',
      'explicitly primary',
      'never choose the first, lowest, or highest item implicitly',
      '`deriveSourceBoundChangeId(external_id, request_slug)`',
      '## AIFHub Source Binding',
      '- Provider: <source_provider>',
      '- Primary source: <primary_source>',
      '- External ID: <external_id>',
      '- Branch: <exact current git branch|none>',
      'MUST NOT establish or replace the primary binding'
    ]) {
      assertIncludes(identity, expected, 'aif-plan explicit MCP work-item identity');
    }
  });

  it('maps external work-item IDs to readable OpenSpec IDs and compatible legacy identifiers', async () => {
    const injection = await readRepoFile('injections/core/aif-plan-plan-folder.md');
    const identity = extractSection(injection, 'MCP work-item-derived plan identity');
    const openspec = extractSection(injection, 'OpenSpec-native mode');

    for (const expected of [
      '`<normalized-external-id>-<request-slug>`',
      '`156-fix-login-timeout`',
      '`eng-431-fix-login-timeout`',
      '`proj-77-refresh-token`',
      'set the new canonical `change-id` to `deriveSourceBoundChangeId(external_id, request_slug).changeId`',
      'independent of `workflow.plan_id_format`',
      'validate it with `normalizeChangeId()` before any write',
      'use `<normalized-external-id>-<request-slug>` as the plan identifier',
      'keep the required four-digit compatibility prefix',
      '`0042_PROJ-77-refresh-token`',
      '`HANDOFF_BRANCH_PREPARED=1` retains upstream precedence and disables the legacy sequential prefix',
      'writeCurrentChangePointer(<resolved-change-id>)',
      'One exact persisted branch binding remains higher-precedence than ordinary slug branch matching'
    ]) {
      assertIncludes(identity, expected, 'aif-plan source-bound mode mapping');
    }

    assertIncludes(
      openspec,
      'use `deriveSourceBoundChangeId(external_id, request_slug).changeId`',
      'OpenSpec Change ID policy'
    );
  });

  it('fails closed on source-bound ID collisions without losing the external-ID prefix', async () => {
    const injection = await readRepoFile('injections/core/aif-plan-plan-folder.md');
    const identity = extractSection(injection, 'MCP work-item-derived plan identity');

    for (const expected of [
      'scan active source-bound artifacts',
      '`Primary source` equal to `primary_source`',
      'reuse its existing identifier and route to refinement even if the current request would derive a different slug',
      'ambiguous-primary-source-binding',
      '`openspec/changes/<derived-change-id>/` exists',
      'equality of `Provider` / `External ID`, is insufficient',
      'source-plan-id-collision',
      'Never overwrite, allocate a suffix, or silently drop the external-ID prefix',
      'persisted full primary source protects the remaining cross-provider and cross-tenant collision case',
      'INFO [aif-plan] source-bound plan identity: provider=<provider> external-id=<bounded-id> artifact=<project-relative-path>'
    ]) {
      assertIncludes(identity, expected, 'aif-plan source-bound collision contract');
    }
  });

  it('requires canonical OpenSpec change artifacts without legacy plan companion files', async () => {
    const injection = await readRepoFile('injections/core/aif-plan-plan-folder.md');
    const openspec = extractSection(injection, 'OpenSpec-native mode');

    for (const expected of [
      'openspec/changes/<change-id>/proposal.md',
      'openspec/changes/<change-id>/design.md',
      'openspec/changes/<change-id>/tasks.md',
      'openspec/changes/<change-id>/specs/<capability>/spec.md'
    ]) {
      assertIncludes(openspec, expected, 'OpenSpec-native section');
    }

    for (const unexpected of [
      '.ai-factory/plans/<id>.md',
      '.ai-factory/plans/<id>/task.md',
      '.ai-factory/plans/<id>/context.md',
      '.ai-factory/plans/<id>/rules.md',
      '.ai-factory/plans/<id>/verify.md',
      '.ai-factory/plans/<id>/status.yaml'
    ]) {
      assertNotIncludes(openspec, unexpected, 'OpenSpec-native section');
    }
  });

  it('documents OpenSpec artifact templates and delta requirements', async () => {
    const injection = await readRepoFile('injections/core/aif-plan-plan-folder.md');
    const openspec = extractSection(injection, 'OpenSpec-native mode');

    for (const expected of [
      '## Why',
      '## What Changes',
      '## Capabilities',
      '### New Capabilities',
      '### Modified Capabilities',
      '## Impact',
      '# Design: <Title>',
      '## Technical Approach',
      '## Data / Artifact Model',
      '# Tasks',
      '## ADDED Requirements',
      '## MODIFIED Requirements',
      '## REMOVED Requirements',
      '#### Scenario: <Scenario name>',
      'openspec/changes/<change-id>/.openspec.yaml',
      'skip_specs: true',
      '>=1.7.0',
      'older supported CLI',
      'retire_capabilities: true',
      'explicitly authorizes capability retirement',
      'must not infer retirement'
    ]) {
      assertIncludes(openspec, expected, 'OpenSpec-native section');
    }
  });

  it('keeps the proposal source-template headings exact and ordered', async () => {
    const injection = await readRepoFile('injections/core/aif-plan-plan-folder.md');
    const openspec = extractSection(injection, 'OpenSpec-native mode');
    const proposalTemplate = extractFencedBlockAfter(openspec, '`proposal.md` should use:');
    const sourceHeadings = [
      '## Why',
      '## What Changes',
      '## Capabilities',
      '### New Capabilities',
      '### Modified Capabilities',
      '## Impact'
    ];
    const actualSourceHeadings = proposalTemplate
      .split(/\r?\n/)
      .filter((line) => sourceHeadings.includes(line));

    assert.deepEqual(actualSourceHeadings, sourceHeadings);
    for (const staleHeading of ['## Intent', '## Scope', '## Approach', '## Risks / Open Questions']) {
      assertNotIncludes(proposalTemplate, staleHeading, 'OpenSpec proposal source template');
    }
    assertOrder(
      proposalTemplate,
      ['## Original Request', '## Roadmap Linkage', '## Why', '## What Changes', '## Capabilities', '## Impact'],
      'OpenSpec proposal template'
    );
    assertNotIncludes(proposalTemplate, '## AIFHub Source Binding', 'universal OpenSpec proposal template');

    const conditionalBinding = extractFencedBlockAfter(
      openspec,
      'For source-bound proposals only, insert this exact block'
    );
    assertIncludes(conditionalBinding, '## AIFHub Source Binding', 'conditional source-binding template');
    assertIncludes(
      openspec,
      'For every ordinary plan, omit the complete heading and body',
      'conditional source-binding template'
    );
  });

  it('persists provider, primary source, external ID, and branch separately in OpenSpec and legacy plans', async () => {
    const injection = await readRepoFile('injections/core/aif-plan-plan-folder.md');
    const identity = extractSection(injection, 'MCP work-item-derived plan identity');
    const legacy = extractSection(injection, 'Legacy AI Factory-only mode');

    for (const expected of [
      'write the exact section once in `proposal.md`',
      '`Primary source` is the single canonical collision identity',
      '`Issues` list in `## Roadmap Linkage` remains lifecycle linkage',
      '`parseWorkItemSourceBinding()`',
      '`parseLegacyWorkItemSourceBinding()`',
      '`parseSynchronizedWorkItemSourceBinding()`',
      '`matchesPrimarySourceBinding()`',
      'source_binding.provider',
      'source_binding.primary_source',
      'source_binding.external_id',
      'source_binding.branch'
    ]) {
      assertIncludes(identity, expected, 'aif-plan persisted source binding');
    }

    for (const expected of [
      'source_binding:',
      'provider: "linear"',
      'primary_source: "mcp://linear/issue/<stable-record-id>"',
      'external_id: "ENG-431"',
      'branch: "<exact current git branch|none>"',
      'require the exact Markdown source-binding section in `index.md`',
      'do not create or synchronize `task.md`, `context.md`, `rules.md`, `verify.md`, `status.yaml`, or `explore.md`'
    ]) {
      assertIncludes(legacy, expected, 'aif-plan legacy persisted source binding');
    }
  });

  it('requires task intake normalization before writing OpenSpec artifacts', async () => {
    const injection = await readRepoFile('injections/core/aif-plan-plan-folder.md');
    const openspec = extractSection(injection, 'OpenSpec-native mode');

    assertIncludes(openspec, '#### Task Intake Normalization', 'aif-plan OpenSpec-native section');
    assertOrder(
      openspec,
      ['#### Task Intake Normalization', '#### Required artifact shape'],
      'aif-plan OpenSpec-native section'
    );

    for (const expected of [
      'task type',
      'goal',
      'non-goals',
      'constraints',
      'assumptions',
      'impacted capabilities',
      'C4 impact',
      'ADR candidates',
      'dependency graph',
      'acceptance criteria',
      'open questions',
      'suggested next command',
      '`proposal.md` for the exact OpenSpec source-template headings `## Why`, `## What Changes`, `## Capabilities`, and `## Impact`',
      '`design.md` for technical approach, C4 impact, ADR candidates, dependency graph, integration points, alternatives, and risks',
      '`tasks.md` for an executable implementation checklist',
      '`specs/**/spec.md` for behavior-changing requirements and scenarios',
      'Raw input trace, normalization confidence, and temporary notes are runtime state only',
      'may be persisted only under `.ai-factory/state/<change-id>/`',
      'must never be written under `openspec/changes/<change-id>/`'
    ]) {
      assertIncludes(openspec, expected, 'aif-plan OpenSpec-native section');
    }

    for (const expected of [
      '`/aif-task-prepare`',
      '`.ai-factory/specs/<task-id>.md`',
      '`task-prepare.md`',
      'legacy companion files under `openspec/changes/<change-id>/`',
      'must not be created'
    ]) {
      assertIncludes(openspec, expected, 'aif-plan OpenSpec-native forbidden artifacts');
    }
  });

  it('preserves multiline Original Request input and commits revision-bound research context', async () => {
    const injection = await readRepoFile('injections/core/aif-plan-plan-folder.md');
    const openspec = extractSection(injection, 'OpenSpec-native mode');
    const label = 'injections/core/aif-plan-plan-folder.md Original Request and Research Context contract';

    assertOrder(openspec, ['## Original Request', '## Why'], `${label} section ordering`);

    for (const expected of [
      'recognized invocation tokens that occur in command positions',
      'Do not remove words such as `full`, `fast`, `ultra`, `--list`, or `--parallel` when they occur inside the actual request text',
      'request wording, casing, punctuation, internal whitespace, and line breaks exactly',
      'If planning starts only from the resolved research artifact and no explicit request exists, omit `## Original Request`',
      'keep both `## Original Request` and `## Research Context`',
      'Source: <exact selected RESEARCH.md source> (Active Summary, Updated: <timestamp>, SHA256: <digest>)',
      'normalizing line endings to LF',
      'ending the digest input with exactly one newline',
      'WARN [research-drift]',
      'expected=<embedded revision>',
      'current=<live revision>',
      'unless the user explicitly requests a research rebase'
    ]) {
      assertIncludes(openspec, expected, label);
    }
  });

  it('uses the shared ultra research resolver with deterministic selection and bounded ambiguity', async () => {
    const injection = await readRepoFile('injections/core/aif-plan-plan-folder.md');
    const openspec = extractSection(injection, 'OpenSpec-native mode');
    const label = 'aif-plan ultra research resolver contract';

    for (const expected of [
      'resolveUltraResearchSource()',
      'scripts/ultra-research-resolver.mjs',
      'structured `source`, `revision`, `content`, and `diagnostic`',
      'safe explicit project-relative `RESEARCH.md` path',
      'exact bundle slug',
      'exactly one caller-reviewed materially relevant active candidate',
      '`ultra-research-ambiguous`',
      'recency, fuzzy matching, and a newer `Updated` value never break the tie',
      'Missing, unmarked, inactive, unsafe, symlinked, or invalid explicit sources stop Research Context creation',
      'use only `content.activeSummary` from the selected exact `source.path`',
      'sibling C4, ADR, and dependency artifacts are rationale and cannot expand scope'
    ]) {
      assertIncludes(openspec, expected, label);
    }
  });

  it('records explicit roadmap linkage in the canonical proposal and returns the owner handoff', async () => {
    const injection = await readRepoFile('injections/core/aif-plan-plan-folder.md');
    const openspec = extractSection(injection, 'OpenSpec-native mode');
    const label = 'aif-plan standardized Roadmap Linkage contract';

    const proposalTemplate = extractFencedBlockAfter(openspec, '`proposal.md` should use:');
    assertOrder(
      proposalTemplate,
      ['## Original Request', '## Roadmap Linkage', '## Why'],
      `${label} proposal ordering`
    );

    for (const expected of [
      '#### Roadmap Linkage',
      '- Issues: <comma-separated canonical HTTPS work-item URL(s) or stable MCP resource URI(s)|none>',
      '- Milestone: <exact title|none>',
      '- Roadmap item/slice: <exact item or slice|none>',
      '- Rationale: <one bounded explanation|none>',
      'https://github.com/<owner>/<repo>/issues/<number>',
      'report only the captured linkage fields',
      '/aif-roadmap check'
    ]) {
      assertIncludes(openspec, expected, label);
    }
  });

  it('preserves explicit none values in every roadmap linkage field', async () => {
    const injection = await readRepoFile('injections/core/aif-plan-plan-folder.md');
    const openspec = extractSection(injection, 'OpenSpec-native mode');
    const label = 'aif-plan explicit-none Roadmap Linkage contract';

    for (const expected of [
      'Always include `## Roadmap Linkage`',
      'preserve an explicit `none` value verbatim',
      'Do not omit a field whose value is `none`',
      'all four fields are `none`'
    ]) {
      assertIncludes(openspec, expected, label);
    }
  });

  it('does not infer roadmap linkage from repository context', async () => {
    const injection = await readRepoFile('injections/core/aif-plan-plan-folder.md');
    const openspec = extractSection(injection, 'OpenSpec-native mode');
    const label = 'aif-plan no-inference Roadmap Linkage contract';

    for (const expected of [
      'MUST NOT infer',
      'issue title',
      'branch name',
      'repository labels',
      'unrelated roadmap text',
      'do not return `/aif-roadmap check` solely for an all-`none` linkage'
    ]) {
      assertIncludes(openspec, expected, label);
    }
  });

  it('defines safe change IDs, runtime-state boundaries, and validation through the runner', async () => {
    const injection = await readRepoFile('injections/core/aif-plan-plan-folder.md');
    const openspec = extractSection(injection, 'OpenSpec-native mode');

    for (const expected of [
      'normalizeChangeId()',
      'ensureRuntimeLayout(changeId)',
      '.ai-factory/state/<change-id>/',
      'Do not write runtime-only files into `openspec/changes/<change-id>/`',
      'validateOpenSpecChange(changeId)',
      'scripts/openspec-runner.mjs',
      'openspec validate <change-id> --type change --strict --json --no-interactive --no-color',
      'Missing or unsupported OpenSpec CLI is degraded validation, not planning failure',
      'Do not install OpenSpec skills'
    ]) {
      assertIncludes(openspec, expected, 'OpenSpec-native section');
    }
  });

  it('keeps Codex and IDE planning-mode guidance capability-gated', async () => {
    const injection = await readRepoFile('injections/core/aif-plan-plan-folder.md');

    for (const expected of [
      'skills/shared/QUESTION-TOOL.md',
      'CLI or IDE runtime exposes a planning mode',
      'do not fabricate unavailable tools or client actions',
      'user controls the mode'
    ]) {
      assertIncludes(injection, expected, 'aif-plan injection');
    }
  });

  it('keeps compatibility docs aligned with OpenSpec-native planning support', async () => {
    const compatibility = await readRepoFile('docs/openspec-compatibility.md');

    assertNotIncludes(
      compatibility,
      'does not implement later OpenSpec-native `/aif-plan`',
      'docs/openspec-compatibility.md'
    );
    assertNotIncludes(
      compatibility,
      'planning, verification, archive integration, migration, generated rules, and broader prompt rewrites remain separate follow-up work',
      'docs/openspec-compatibility.md'
    );
    assertIncludes(
      compatibility,
      '`/aif-plan full`',
      'docs/openspec-compatibility.md'
    );
  });

  it('uses CLI-selected optional tools for /aif-plan instead of a prompt-owned provider list', async () => {
    const injection = await readRepoFile('injections/core/aif-plan-plan-folder.md');

    for (const expected of [
      'Enabled optional tool use',
      'ai-factory aifhub-memory-tools select --from-project --command aif-plan --json',
      'selected_tools',
      'not_selected_tools',
      'tool_id',
      'permission',
      'execution',
      'forbidden_operations',
      'protected_artifacts',
      'Do not use tools that are absent from `selected_tools`',
      'This provider-specific boundary applies only when `selected_tools` includes Graphify',
      'This provider-specific boundary applies only when `selected_tools` includes Context7'
    ]) {
      assertIncludes(injection, expected, 'aif-plan enabled optional tool use');
    }
  });
});
