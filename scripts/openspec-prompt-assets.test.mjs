// openspec-prompt-assets.test.mjs - instruction-level tests for OpenSpec-native prompt assets
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LEGACY_ULTRA_AGENT_CONTRACTS,
  validateAgentInstructionContract
} from './agent-instruction-contract.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

const SHARED_LANGUAGE_POLICY_ASSET = 'skills/shared/LANGUAGE-POLICY.md';
const SHARED_PROJECT_GLOSSARY_ASSET = 'skills/shared/PROJECT-GLOSSARY.md';

const EXPLICIT_REFERENCE_ASSETS = [
  SHARED_LANGUAGE_POLICY_ASSET,
  SHARED_PROJECT_GLOSSARY_ASSET,
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

const FIX_PROMPT_ASSETS = [
  'injections/core/aif-fix-plan-folder.md',
  'agent-files/codex/aifhub-fixer.toml',
  'agent-files/claude/aifhub-fixer.md'
];

const PLANNING_RUNTIME_PROMPT_ASSETS = [
  'injections/core/aif-explore-plan-folder.md',
  'injections/core/aif-plan-plan-folder.md',
  'injections/core/aif-improve-plan-folder.md'
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
const ARCHITECTURE_PROMPT_ASSET = 'injections/core/aif-architecture-context-boundary.md';
const COMMIT_PROMPT_ASSET = 'injections/core/aif-commit-roadmap-freshness.md';

const LEGACY_ULTRA_CONSUMER_ASSETS = [
  {
    command: 'aif-improve',
    asset: 'injections/core/aif-improve-plan-folder.md',
    decision: 'adapter',
    outcome: 'fail-closed-stop',
    handoff: '/aif-improve <entrypoint>'
  },
  {
    command: 'aif-implement',
    asset: 'injections/core/aif-implement-plan-folder.md',
    decision: 'adapter',
    outcome: 'fail-closed-stop',
    handoff: '/aif-implement <entrypoint>'
  },
  {
    command: 'aif-verify',
    asset: 'injections/core/aif-verify-plan-folder.md',
    decision: 'adapter',
    outcome: 'fail-closed-stop',
    handoff: '/aif-verify <entrypoint>'
  },
  {
    command: 'aif-fix',
    asset: 'injections/core/aif-fix-plan-folder.md',
    decision: 'adapter',
    outcome: 'fail-closed-stop',
    handoff: '/aif-fix <entrypoint>'
  },
  {
    command: 'aif-rules-check',
    asset: 'injections/core/aif-rules-check-openspec-generated-rules.md',
    decision: 'reviewed-no-op',
    outcome: 'reviewed-no-op',
    handoff: '/aif-rules-check',
    evidence: ['read-only', 'This gate must not regenerate or edit generated rules.']
  },
  {
    command: 'aif-commit',
    asset: 'injections/core/aif-commit-roadmap-freshness.md',
    decision: 'reviewed-no-op',
    outcome: 'reviewed-no-op',
    handoff: '/aif-commit',
    evidence: ['This overlay is read-only except for the git commit', 'It must not write:']
  },
  {
    command: 'aif-roadmap',
    asset: 'injections/core/aif-roadmap-maturity-audit.md',
    decision: 'reviewed-no-op',
    outcome: 'reviewed-no-op',
    handoff: '/aif-roadmap',
    evidence: ['may be used as historical roadmap evidence', 'must also not write runtime state, QA evidence, generated rules, canonical OpenSpec artifacts, or implementation files']
  }
];

const LEGACY_ULTRA_AGENT_FILES = Object.freeze({
  'aifhub-plan-polisher': Object.freeze({
    codex: 'agent-files/codex/aifhub-plan-polisher.toml',
    claude: 'agent-files/claude/aifhub-plan-polisher.md'
  }),
  'aifhub-implement-worker': Object.freeze({
    codex: 'agent-files/codex/aifhub-implement-worker.toml',
    claude: 'agent-files/claude/aifhub-implement-worker.md'
  }),
  'aifhub-verifier': Object.freeze({
    codex: 'agent-files/codex/aifhub-verifier.toml',
    claude: 'agent-files/claude/aifhub-verifier.md'
  }),
  'aifhub-fixer': Object.freeze({
    codex: 'agent-files/codex/aifhub-fixer.toml',
    claude: 'agent-files/claude/aifhub-fixer.md'
  }),
  'aifhub-done-finalizer': Object.freeze({
    codex: 'agent-files/codex/aifhub-done-finalizer.toml',
    claude: 'agent-files/claude/aifhub-done-finalizer.md'
  }),
  'aifhub-rules-sidecar': Object.freeze({
    codex: 'agent-files/codex/aifhub-rules-sidecar.toml',
    claude: 'agent-files/claude/aifhub-rules-sidecar.md'
  })
});

const ULTRA_RESEARCH_DRIFT_ASSETS = [
  'injections/core/aif-improve-plan-folder.md',
  'injections/core/aif-implement-plan-folder.md',
  'injections/core/aif-verify-plan-folder.md',
  'injections/core/aif-fix-plan-folder.md'
];

const AI_FACTORY_218_OWNERSHIP_AUDIT = Object.freeze([
  Object.freeze({
    surface: 'aif-analyze',
    decision: 'retain',
    manifestKind: 'skill',
    ledgerConsumer: 'aif-analyze',
    asset: 'skills/aif-analyze/SKILL.md',
    evidence: Object.freeze([
      'aifhub.artifactProtocol: openspec',
      'Preserve existing config values. Add only missing keys required by the resolved mode.'
    ])
  }),
  Object.freeze({
    surface: 'aif-mode',
    decision: 'adapter',
    manifestKind: 'skill',
    ledgerConsumer: 'aif-mode',
    asset: 'skills/aif-mode/SKILL.md',
    evidence: Object.freeze(['ai-factory aifhub-mode', '.ai-factory/state/mode-switches/'])
  }),
  Object.freeze({
    surface: 'aif-done',
    decision: 'retain',
    manifestKind: 'skill',
    ledgerConsumer: 'aif-done',
    asset: 'skills/aif-done/SKILL.md',
    evidence: Object.freeze(['evaluateLegacyUltraVerificationReceipt()', 'ai-factory aifhub-done-finalizer'])
  }),
  Object.freeze({
    surface: 'aif-evolve',
    decision: 'retain',
    manifestKind: 'injection',
    ledgerConsumer: 'aif-evolve',
    asset: 'injections/core/aif-evolve-plan-evidence.md',
    evidence: Object.freeze(['plan-aware evolution', '### OpenSpec-native evidence'])
  }),
  Object.freeze({
    surface: 'aif-transfer',
    decision: 'no-op',
    manifestKind: 'upstream-only',
    ledgerConsumer: '/aif-loop, /aif-transfer and packaged upstream coordinators'
  }),
  Object.freeze({
    surface: 'aif-loop',
    decision: 'no-op',
    manifestKind: 'upstream-only',
    ledgerConsumer: '/aif-loop, /aif-transfer and packaged upstream coordinators'
  })
]);

const GRAPHIFY_CONTEXT_DOC_ASSETS = [
  'docs/context-loading-policy.md',
  'docs/usage.md'
];

const GRAPHIFY_CONTEXT_PROMPT_ASSETS = [
  'skills/aif-analyze/SKILL.md',
  'injections/core/aif-explore-plan-folder.md',
  'injections/core/aif-plan-plan-folder.md',
  'agent-files/codex/aifhub-review-sidecar.toml',
  'agent-files/claude/aifhub-review-sidecar.md'
];

const CONTEXT7_CONTEXT_DOC_ASSETS = [
  'docs/context-providers.md',
  'docs/context-loading-policy.md',
  'docs/usage.md'
];

const CONTEXT7_CONTEXT_PROMPT_ASSETS = [
  'injections/core/aif-explore-plan-folder.md',
  'injections/core/aif-plan-plan-folder.md',
  'injections/core/aif-review-context-providers.md',
  'agent-files/codex/aifhub-review-sidecar.toml',
  'agent-files/claude/aifhub-review-sidecar.md'
];

const REPOWISE_CONTEXT_DOC_ASSETS = [
  'docs/context-providers.md'
];

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

async function activeManifestPromptAssets() {
  const manifest = await loadManifest();
  const assets = new Set();

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

function parseTwoColumnMarkdownTable(section) {
  const rows = new Map();
  for (const line of section.split(/\r?\n/)) {
    if (!line.trim().startsWith('|') || /^\s*\|\s*-+\s*\|/.test(line)) continue;
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim().replaceAll('`', ''));
    if (cells.length !== 2 || cells[0] === 'Consumer') continue;
    rows.set(cells[0], cells[1]);
  }
  return rows;
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
    assert.ok(index > cursor, `${label} should order ${JSON.stringify(fragment)} after the previous fragment`);
    cursor = index;
  }
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

function assertNoExecutableRootScriptGuidance(source, label) {
  assert.doesNotMatch(
    source,
    /\bnode\s+scripts\/[A-Za-z0-9_.-]+\.mjs\b/,
    `${label} should not expose root scripts as installed-project executable helper commands`
  );
}

function assertGraphifyOptionalContextGuidance(source, label) {
  for (const expected of [
    'Graphify',
    'graphify-out/GRAPH_REPORT.md',
    'graphify-out/graph.json',
    '.ai-factory/references/graphify/',
    '.ai-factory/state/<change-id>/graphify/',
    'openspec/changes/<change-id>/',
    'openspec/specs/',
    '.ai-factory/rules/generated/',
    '.ai-factory/qa/<change-id>/',
    'supporting',
    'degraded',
    'direct repository evidence',
    'API keys',
    'tokens',
    'raw authorization headers',
    'private backend diagnostics'
  ]) {
    assertIncludes(source, expected, label);
  }

  assert.match(
    source,
    /extracted, inferred, ambiguous, or confidence-labeled|extracted, inferred, ambiguous или confidence-labeled/i,
    `${label} should warn that Graphify relationships are hypotheses`
  );
  assert.match(source, /do(?:es)? not .*install `?graphifyy`?|must not .*install `?graphifyy`?|не (?:устанавливает|устанавливайте|должны.*устанавливать).*`?graphifyy`?/i, `${label} should forbid automatic graphifyy install`);
  assert.match(source, /do(?:es)? not .*run `?graphify`?|must not .*run `?graphify`?|не (?:запускает|запускайте|должны.*запускать).*`?graphify`?/i, `${label} should forbid automatic graphify execution`);
  assert.match(source, /Graphify MCP automatically|регистрировать Graphify MCP automatically|регистрирует Graphify MCP automatically/i, `${label} should forbid automatic Graphify MCP registration`);
}

function assertContext7OptionalDocumentationGuidance(source, label) {
  for (const expected of [
    'Context7',
    'npx ctx7',
    'ctx7 library <name> <query>',
    'ctx7 docs <libraryId> <query>',
    'resolve-library-id',
    'get-library-docs',
    'query-docs',
    '.ai-factory/references/context7/',
    '.ai-factory/state/<change-id>/context7/',
    'openspec/changes/<change-id>/',
    'openspec/specs/',
    '.ai-factory/rules/generated/',
    '.ai-factory/qa/<change-id>/',
    'supporting',
    'degraded',
    'direct repository evidence',
    'source-grounded',
    'CONTEXT7_API_KEY',
    'API keys',
    'tokens',
    'raw authorization headers',
    'private provider diagnostics',
    'private backend diagnostics',
    '.mcp.json',
    '.cursor/mcp.json',
    '.opencode.json'
  ]) {
    assertIncludes(source, expected, label);
  }

  assert.match(
    source,
    /do(?:es)? not .*install `?ctx7`?|must not .*install `?ctx7`?|не (?:устанавливайте|устанавливает|должны.*устанавливать).*`?ctx7`?/i,
    `${label} should forbid automatic Context7 CLI install`
  );
  assert.match(
    source,
    /do(?:es)? not .*run `?ctx7 setup`?|must not .*run `?ctx7 setup`?|не (?:запускайте|запускает|должны.*запускать).*`?ctx7 setup`?/i,
    `${label} should forbid automatic Context7 setup`
  );
  assert.match(
    source,
    /Context7 MCP automatically|automatic(?:ally)? .*Context7 MCP|не .*регистрируйте Context7 MCP|не .*регистрирует Context7 MCP/i,
    `${label} should forbid automatic Context7 MCP registration`
  );
}

function assertRepowiseOptionalContextGuidance(source, label) {
  for (const expected of [
    'Repowise',
    'manual_cli_only',
    'repo_intelligence_provider',
    '--index-only',
    'repowise doctor',
    '.repowise',
    '.mcp.json',
    'supporting',
    'canonical OpenSpec evidence'
  ]) {
    assertIncludes(source, expected, label);
  }

  assert.match(
    source,
    /repowise delete|delete -p/i,
    `${label} should document repowise purge`
  );
  assert.match(
    source,
    /do not auto-install Repowise|не .*auto-install Repowise|auto-install Repowise.*(?:forbidden|запрещ)|AIFHub commands не должны auto-install Repowise/i,
    `${label} should forbid automatic Repowise install`
  );
  assert.match(
    source,
    /repowise init.*without constrained|init без constrained-флагов|init.*без constrained/i,
    `${label} should forbid unconstrained repowise init`
  );
}

describe('OpenSpec-native prompt asset contract', () => {
  it('discovers active prompt assets from extension.json only', async () => {
    const assets = await activePromptAssets();

    for (const expected of [
      'skills/aif-analyze/SKILL.md',
      'skills/aif-done/SKILL.md',
      SHARED_LANGUAGE_POLICY_ASSET,
      'injections/core/aif-rules-check-openspec-generated-rules.md',
      ROADMAP_PROMPT_ASSET,
      ARCHITECTURE_PROMPT_ASSET,
      COMMIT_PROMPT_ASSET,
      ...ROADMAP_REFERENCE_ASSETS,
      'injections/core/aif-implement-plan-folder.md',
      'injections/core/aif-review-context-providers.md',
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

  it('records the AI Factory 2.18 extension-owned and upstream-only ownership audit', async (t) => {
    const manifest = await loadManifest();
    const skillNames = (manifest.skills ?? [])
      .map(normalizeManifestPath)
      .map((skillPath) => skillPath.split('/').at(-1));
    const injectionTargets = (manifest.injections ?? []).map(({ target }) => target);
    const compatibility = await readRepoFile('docs/openspec-compatibility.md');
    const ledger = parseTwoColumnMarkdownTable(
      extractMarkdownSection(compatibility, 'AI Factory 2.18 consumer ledger')
    );

    for (const audit of AI_FACTORY_218_OWNERSHIP_AUDIT) {
      await t.test(`surface=${audit.surface} decision=${audit.decision}`, async () => {
        assert.ok(
          ['adapter', 'retain', 'no-op'].includes(audit.decision),
          `surface=${audit.surface} case=decision-vocabulary`
        );
        const ledgerDecision = ledger.get(audit.ledgerConsumer);
        assert.match(
          ledgerDecision ?? '',
          new RegExp(`^${audit.decision}:`),
          `surface=${audit.surface} case=consumer-ledger`
        );

        const skillCount = skillNames.filter((name) => name === audit.surface).length;
        const injectionCount = injectionTargets.filter((target) => target === audit.surface).length;
        if (audit.manifestKind === 'skill') {
          assert.equal(skillCount, 1, `surface=${audit.surface} case=single-owned-skill`);
          assert.equal(injectionCount, 0, `surface=${audit.surface} case=no-duplicate-injection`);
        } else if (audit.manifestKind === 'injection') {
          assert.equal(skillCount, 0, `surface=${audit.surface} case=no-copied-upstream-skill`);
          assert.equal(injectionCount, 1, `surface=${audit.surface} case=single-bounded-injection`);
        } else {
          assert.equal(skillCount, 0, `surface=${audit.surface} case=reviewed-no-op-skill`);
          assert.equal(injectionCount, 0, `surface=${audit.surface} case=reviewed-no-op-injection`);
        }

        if (audit.asset !== undefined) {
          const source = await readRepoFile(audit.asset);
          for (const expected of audit.evidence) {
            assertIncludes(source, expected, `surface=${audit.surface} case=unique-aifhub-boundary`);
          }
        }
      });
    }
  });

  it('keeps transfer privacy upstream-owned and preserves the mandatory done boundary', async () => {
    const manifest = await loadManifest();
    const compatibility = await readRepoFile('docs/openspec-compatibility.md');
    const metadata = JSON.parse(await readRepoFile('aifhub-extension.json'));
    const evolve = await readRepoFile('injections/core/aif-evolve-plan-evidence.md');
    const done = await readRepoFile('skills/aif-done/SKILL.md');
    const manifestAssets = [
      ...(manifest.skills ?? []),
      ...(manifest.injections ?? []).map(({ file }) => file),
      ...(manifest.agentFiles ?? []).map(({ source }) => source)
    ].map(normalizeManifestPath);

    assert.match(
      compatibility,
      /Privacy-gated `\/aif-transfer`[^\n]*sanitized in-memory registry[^\n]*current-project evidence[^\n]*privacy checks[^\n]*explicit approval[^\n]*delegates to upstream `\/aif-evolve`/,
      'surface=aif-transfer case=privacy-gated-delegation'
    );
    assert.match(
      metadata.sources['ai-factory'].notes,
      /privacy-gated \/aif-transfer[^.]*upstream-owned[^.]*delegates accepted project evidence to \/aif-evolve without an AIFHub copy/i,
      'surface=aif-transfer case=metadata-reviewed-no-op'
    );
    assert.equal(
      manifestAssets.some((asset) => /(?:^|\/)aif-(?:transfer|loop)(?:\/|\.|$)/.test(asset)),
      false,
      'surface=aif-transfer,aif-loop case=no-duplicate-assets'
    );
    assert.doesNotMatch(
      evolve,
      /experience-NNN|source[- ]project|prevention registry|transfer registry/i,
      'surface=aif-evolve case=no-transfer-registry-copy'
    );

    for (const expected of [
      'evaluateLegacyUltraVerificationReceipt()',
      '/aif-verify <entrypoint>',
      '/aif-archive <entrypoint>',
      'Do not execute the archive from `/aif-done`'
    ]) {
      assertIncludes(done, expected, `surface=aif-done case=mandatory-finalization-boundary`);
    }
  });

  it('registers the commit roadmap freshness injection in the manifest', async () => {
    const manifest = await loadManifest();
    const injection = manifest.injections.find((entry) => entry.target === 'aif-commit');

    assert.ok(injection, 'extension.json should include an aif-commit injection');
    assert.equal(injection.position, 'prepend');
    assert.equal(normalizeManifestPath(injection.file), COMMIT_PROMPT_ASSET);
    await readRepoFile(COMMIT_PROMPT_ASSET);
  });

  it('registers the architecture context boundary injection in the manifest', async () => {
    const manifest = await loadManifest();
    const injections = (manifest.injections ?? []).filter((entry) => entry.target === 'aif-architecture');

    assert.equal(injections.length, 1, 'extension.json should include exactly one aif-architecture injection');
    assert.equal(injections[0].position, 'prepend');
    assert.equal(normalizeManifestPath(injections[0].file), ARCHITECTURE_PROMPT_ASSET);

    const asset = await readRepoFile(ARCHITECTURE_PROMPT_ASSET);
    for (const expected of [
      'upstream `/aif-architecture`',
      '`skills/shared/LANGUAGE-POLICY.md`',
      'Do not create or use an extension-owned `skills/aif-architecture/` directory',
      'OpenSpec-native mode',
      'paths.architecture',
      'paths.description',
      'AGENTS.md',
      'openspec/changes/**',
      'openspec/specs/**',
      '.ai-factory/state/**',
      '.ai-factory/qa/**',
      '.ai-factory/rules/generated/**',
      'ai-factory aifhub-memory-tools select --from-project --command aif-architecture --json',
      'Graphify',
      'Context7',
      'CodeGraph'
    ]) {
      assertIncludes(asset, expected, ARCHITECTURE_PROMPT_ASSET);
    }

    assert.equal(
      existsSync(join(REPO_ROOT, 'skills', 'aif-architecture')),
      false,
      'AIFHub should not copy or own skills/aif-architecture'
    );
  });

  it('requires active prompt assets to reference the shared language policy', async () => {
    const policy = await readRepoFile(SHARED_LANGUAGE_POLICY_ASSET);

    for (const expected of [
      'language.ui',
      'language.artifacts',
      'language.technical_terms',
      'user-facing responses',
      'generated or updated artifacts',
      'commands, filenames, file paths, code identifiers, JSON keys, YAML keys',
      'current conversation language',
      'Do not persist inferred language guesses',
      'preserve its established language',
      'does not expand ownership boundaries'
    ]) {
      assertIncludes(policy, expected, SHARED_LANGUAGE_POLICY_ASSET);
    }

    const assets = await activeManifestPromptAssets();
    for (const relativePath of assets) {
      const asset = await readRepoFile(relativePath);
      assertIncludes(asset, `\`${SHARED_LANGUAGE_POLICY_ASSET}\``, relativePath);
      assert.doesNotMatch(
        asset,
        /\[[^\]]*LANGUAGE-POLICY[^\]]*\]\([^)]*LANGUAGE-POLICY\.md[^)]*\)/,
        `${relativePath} should reference the language policy as inline code, not as a markdown link`
      );
    }

    for (const excluded of [
      'skills/aif-analyze/references/config-template.yaml',
      'skills/aif-done/references/finalization-contract.md',
      'injections/references/aif-roadmap/roadmap-template.md',
      'injections/references/aif-roadmap/slice-checklist.md'
    ]) {
      assert.ok(!assets.includes(excluded), `language policy coverage should not require reference asset ${excluded}`);
    }
  });

  it('loads optional project glossary policy only through the shared language policy', async () => {
    const languagePolicy = await readRepoFile(SHARED_LANGUAGE_POLICY_ASSET);
    const glossaryPolicy = await readRepoFile(SHARED_PROJECT_GLOSSARY_ASSET);

    assertIncludes(
      languagePolicy,
      `\`${SHARED_PROJECT_GLOSSARY_ASSET}\``,
      `${SHARED_LANGUAGE_POLICY_ASSET} glossary policy link`
    );

    for (const expected of [
      '.ai-factory/config.yaml',
      '`paths.context`',
      '`CONTEXT.md`',
      '`present`',
      '`missing`',
      '`empty`',
      '`unreadable`',
      '`unsafe`',
      'normalized project-relative file path',
      '`/aif-analyze` is the only AIFHub command allowed to create or update the glossary',
      'read-only consumers',
      'human-readable prose',
      'code and API identifiers',
      'source code, public APIs, schemas, and executable tests',
      'canonical OpenSpec specs and active change requirements',
      'project rules and accepted architecture decisions',
      '`DESCRIPTION.md` and `ARCHITECTURE.md`',
      'verifiable QA facts',
      'concise terminology-drift warning',
      'Never copy the glossary body',
      'generated-rule inputs',
      'QA schemas or evidence',
      'runtime traces',
      'provider stores',
      'OKF is deferred'
    ]) {
      assertIncludes(glossaryPolicy, expected, `${SHARED_PROJECT_GLOSSARY_ASSET} consumer contract`);
    }

    for (const relativePath of await activeManifestPromptAssets()) {
      const asset = await readRepoFile(relativePath);
      assertIncludes(asset, `\`${SHARED_LANGUAGE_POLICY_ASSET}\``, `${relativePath} language policy link`);
      assertNotIncludes(
        asset,
        SHARED_PROJECT_GLOSSARY_ASSET,
        `${relativePath} should use only the transitive glossary policy entrypoint`
      );
    }
  });

  it('keeps glossary context out of canonical, generated-rules, QA and execution helpers', async () => {
    for (const relativePath of [
      'scripts/openspec-execution-context.mjs',
      'scripts/openspec-verification-context.mjs',
      'scripts/openspec-rules-compiler.mjs'
    ]) {
      const helper = await readRepoFile(relativePath);
      for (const unexpected of [
        'paths.context',
        'PROJECT-GLOSSARY.md',
        'CONTEXT.md'
      ]) {
        assertNotIncludes(helper, unexpected, `${relativePath} protected artifact boundary`);
      }
    }
  });

  it('enforces raw-source localization exceptions and immutable research snapshots', async () => {
    const policy = await readRepoFile(SHARED_LANGUAGE_POLICY_ASSET);

    for (const expected of [
      '`## Original Request` is a raw-source exception',
      'preserve the request body byte-for-byte',
      'line endings, whitespace, punctuation, casing, and line breaks',
      'An existing `## Research Context` is an immutable committed snapshot',
      'unless the user explicitly requests a research rebase',
      '`language.artifacts` still applies to generated'
    ]) {
      assertIncludes(policy, expected, `${SHARED_LANGUAGE_POLICY_ASSET} raw-source localization contract`);
    }

    for (const relativePath of PLAN_POLISHER_PROMPT_ASSETS) {
      const asset = await readRepoFile(relativePath);
      for (const expected of [
        '## Original Request',
        'byte-for-byte',
        '## Research Context',
        'WARN [research-drift]',
        'expected=<embedded revision>',
        'current=<live revision>',
        'explicit user rebase request',
        'Updated',
        'SHA256',
        'Do not duplicate preserved raw section bodies'
      ]) {
        assertIncludes(asset, expected, `${relativePath} immutable planning source contract`);
      }
    }

    for (const relativePath of [...IMPLEMENT_PROMPT_ASSETS, ...VERIFY_PROMPT_ASSETS, ...FIX_PROMPT_ASSETS]) {
      const asset = await readRepoFile(relativePath);
      for (const expected of [
        '## Original Request',
        '## Research Context',
        'WARN [research-drift]',
        'change-id=<change-id>',
        'source=<path>',
        'expected=<embedded revision>',
        'current=<live revision>',
        'credentials',
        'raw provider output'
      ]) {
        assertIncludes(asset, expected, `${relativePath} downstream research-drift contract`);
      }
    }
  });

  it('binds implement, verify, and fix injections to the shared ultra research resolver', async () => {
    for (const relativePath of [
      'injections/core/aif-implement-plan-folder.md',
      'injections/core/aif-verify-plan-folder.md',
      'injections/core/aif-fix-plan-folder.md'
    ]) {
      const asset = await readRepoFile(relativePath);
      const openspec = extractMarkdownSection(asset, 'OpenSpec-native mode');
      for (const expected of [
        'resolveUltraResearchSource()',
        'scripts/ultra-research-resolver.mjs',
        'exact project-relative `RESEARCH.md` path',
        'structured `source`, `revision`, and `diagnostic`',
        'sibling marker/index/status/link',
        'normalized Active Summary digest',
        'do not implement local selection or hashing heuristics',
        'Missing/invalid source',
        'Recency never selects a replacement source',
        'embedded snapshot'
      ]) {
        assertIncludes(openspec, expected, `${relativePath} ultra research resolver`);
      }
    }
  });

  it('defines OpenSpec-native and legacy sections for remaining mode-gated prompts', async () => {
    for (const relativePath of MODE_GATED_PROMPTS) {
      const asset = await readRepoFile(relativePath);

      assertIncludes(asset, 'OpenSpec-native mode', relativePath);
      assertIncludes(asset, 'Legacy AI Factory-only mode', relativePath);
    }
  });

  it('routes mutating legacy ultra consumers marker-first to exact upstream owners', async () => {
    const adapters = LEGACY_ULTRA_CONSUMER_ASSETS.filter(({ decision }) => decision === 'adapter');
    assert.deepEqual(adapters.map(({ command }) => command), [
      'aif-improve',
      'aif-implement',
      'aif-verify',
      'aif-fix'
    ]);

    for (const { asset: relativePath, handoff, outcome } of adapters) {
      assert.equal(outcome, 'fail-closed-stop', `runtime=injection asset=${relativePath} case=fail-closed-stop`);
      const asset = await readRepoFile(relativePath);
      const guard = extractMarkdownSection(asset, 'Legacy ultra marker-first boundary');
      const openspec = extractMarkdownSection(asset, 'OpenSpec-native mode');

      assertOrder(
        asset,
        ['### Legacy ultra marker-first boundary', '### OpenSpec-native mode', '### Legacy AI Factory-only mode'],
        `${relativePath} mode routing`
      );
      assertOrder(
        guard,
        ['classifyLegacyPlanShape()', 'Marker validation is first', '`ultra-valid`', handoff],
        `runtime=injection asset=${relativePath} case=marker-first-routing`
      );

      for (const expected of [
        'scripts/legacy-plan-migration.mjs',
        'before any write',
        '`ultra-invalid` or `collision`',
        '`classic-pair` or `classic-folder-only`',
        'Do not create or synchronize a sibling `<plan-id>.md`',
        '`task.md`',
        '`context.md`',
        '`rules.md`',
        '`verify.md`',
        '`status.yaml`',
        '`explore.md`',
        '`shape`, safe project-relative `entrypoint`, and `handoff`',
        'never include marker bodies, phase contents, request/research bodies, credentials, raw stdout, or raw stderr'
      ]) {
        assertIncludes(guard, expected, `runtime=injection asset=${relativePath} case=fail-closed-stop`);
      }

      assertIncludes(openspec, 'For plan content, read only the canonical OpenSpec artifacts listed below.', `${relativePath} canonical plan source`);
      assertIncludes(openspec, 'Do not inspect or mutate `.ai-factory/plans/**` after an OpenSpec change resolves.', `${relativePath} canonical plan source`);
    }
  });

  it('records rules-check, commit, and roadmap as reviewed-no-op legacy ultra consumers', async () => {
    const reviewedNoOps = LEGACY_ULTRA_CONSUMER_ASSETS.filter(({ decision }) => decision === 'reviewed-no-op');
    assert.deepEqual(reviewedNoOps.map(({ command }) => command), [
      'aif-rules-check',
      'aif-commit',
      'aif-roadmap'
    ]);

    for (const { asset: relativePath, handoff, decision, outcome, evidence } of reviewedNoOps) {
      assert.equal(decision, 'reviewed-no-op', `runtime=injection asset=${relativePath} case=reviewed-no-op`);
      assert.equal(outcome, 'reviewed-no-op', `runtime=injection asset=${relativePath} case=reviewed-no-op`);
      const asset = await readRepoFile(relativePath);
      assertIncludes(asset, handoff, `runtime=injection asset=${relativePath} case=reviewed-no-op-handoff`);
      for (const expected of evidence) {
        assertIncludes(asset, expected, `runtime=injection asset=${relativePath} case=reviewed-no-op-evidence`);
      }
      assert.doesNotMatch(
        asset,
        /\b(?:create|synchroniz(?:e|ing)|update|write|migrat(?:e|ing))\b[^\n]{0,160}\.ai-factory\/plans\//i,
        `${relativePath} reviewed-no-op must not mutate legacy plan artifacts`
      );
    }
  });

  it('keeps Codex and Claude legacy-ultra agent instructions on one parity contract', async () => {
    assert.deepEqual(
      Object.keys(LEGACY_ULTRA_AGENT_FILES).sort(),
      Object.keys(LEGACY_ULTRA_AGENT_CONTRACTS).sort()
    );

    for (const [name, runtimeFiles] of Object.entries(LEGACY_ULTRA_AGENT_FILES)) {
      const runtimeCases = new Map();
      for (const [runtime, relativePath] of Object.entries(runtimeFiles)) {
        const source = await readRepoFile(relativePath);
        const result = validateAgentInstructionContract({ runtime, name, source });
        assert.equal(result.applicable, true, `runtime=${runtime} agent=${name} case=contract-selected`);
        for (const contractCase of result.cases) {
          assert.equal(
            contractCase.ok,
            true,
            `runtime=${runtime} agent=${name} case=${contractCase.case}`
          );
        }
        assert.deepEqual(
          result.issues,
          [],
          `runtime=${runtime} agent=${name} case=instruction-contract issues=${JSON.stringify(result.issues)}`
        );
        runtimeCases.set(runtime, result.cases.map(({ case: caseName }) => caseName).sort());
      }
      assert.deepEqual(
        runtimeCases.get('codex'),
        runtimeCases.get('claude'),
        `agent=${name} case=codex-claude-instruction-parity`
      );
    }
  });

  it('distinguishes research warnings from legacy fail-closed stops and reviewed no-ops', async () => {
    const warningTemplate = 'WARN [research-drift] change-id=<change-id> source=<path> expected=<embedded revision> current=<live revision>';
    for (const relativePath of ULTRA_RESEARCH_DRIFT_ASSETS) {
      const source = await readRepoFile(relativePath);
      const openspec = extractMarkdownSection(source, 'OpenSpec-native mode');
      assertIncludes(openspec, warningTemplate, `runtime=injection asset=${relativePath} case=warning`);
      assert.match(
        openspec,
        /embedded (?:snapshot|Active Summary)[^\n]*(?:authoritative|committed scope)|continues from the embedded snapshot|without expanding verification scope|keeps the fix bounded/i,
        `runtime=injection asset=${relativePath} case=warning-continues-from-committed-source`
      );
    }

    assert.equal(
      LEGACY_ULTRA_CONSUMER_ASSETS.filter(({ outcome }) => outcome === 'fail-closed-stop').length,
      4,
      'runtime=injection case=fail-closed-stop inventory'
    );
    assert.equal(
      LEGACY_ULTRA_CONSUMER_ASSETS.filter(({ outcome }) => outcome === 'reviewed-no-op').length,
      3,
      'runtime=injection case=reviewed-no-op inventory'
    );
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
      assertIncludes(openspec, '.ai-factory/rules/generated/openspec-rules-trace-<change-id>.json', `${relativePath} OpenSpec-native mode`);
      assertIncludes(openspec, '.ai-factory/rules/generated/index.json', `${relativePath} OpenSpec-native mode`);
      assertIncludes(openspec, 'source.path', `${relativePath} OpenSpec-native mode`);
      assertIncludes(openspec, 'source.requirement', `${relativePath} OpenSpec-native mode`);
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

  it('does not expose root scripts as installed-project executable helper commands in active prompts', async () => {
    for (const relativePath of await activePromptAssets()) {
      const asset = await readRepoFile(relativePath);
      assertNoExecutableRootScriptGuidance(asset, relativePath);
    }
  });

  it('documents Graphify as optional supporting context, not an AIFHub dependency', async () => {
    for (const relativePath of [...GRAPHIFY_CONTEXT_DOC_ASSETS, ...GRAPHIFY_CONTEXT_PROMPT_ASSETS]) {
      const asset = await readRepoFile(relativePath);
      assertGraphifyOptionalContextGuidance(asset, relativePath);
    }

    const readme = await readRepoFile('docs/README.md');
    assertIncludes(readme, 'optional Graphify context', 'docs/README.md');
    assertIncludes(readme, 'Context Loading Policy', 'docs/README.md');
  });

  it('documents manual Graphify CLI usage without making it command-owned', async () => {
    const usage = await readRepoFile('docs/usage.md');

    for (const expected of [
      'uv --version',
      'uv tool install graphifyy',
      'graphify install',
      'graphify .',
      'не добавляйте prefix `/graphify .`',
      'graphify-out/graph.html',
      'graphify query',
      'graphify path',
      'graphify explain',
      'utilities.graphify.enabled',
      'uv_check: uv --version',
      'install: uv tool install graphifyy',
      'activate: graphify install',
      'report_command: graphify .',
      'AIFHub Extension не требует Graphify',
      'не добавляет Graphify в extension dependencies'
    ]) {
      assertIncludes(usage, expected, 'docs/usage.md');
    }
  });

  it('documents Context7 as optional documentation context, not an AIFHub dependency', async () => {
    for (const relativePath of [...CONTEXT7_CONTEXT_DOC_ASSETS, ...CONTEXT7_CONTEXT_PROMPT_ASSETS]) {
      const asset = await readRepoFile(relativePath);
      assertContext7OptionalDocumentationGuidance(asset, relativePath);
    }

    const manifest = await loadManifest();
    const reviewInjection = manifest.injections.find((entry) => entry.target === 'aif-review');
    assert.ok(reviewInjection, 'extension.json should include an aif-review injection');
    assert.equal(reviewInjection.position, 'prepend');
    assert.equal(normalizeManifestPath(reviewInjection.file), 'injections/core/aif-review-context-providers.md');

    const readme = await readRepoFile('docs/README.md');
    assertIncludes(readme, 'Context Providers', 'docs/README.md');
    assertIncludes(readme, 'optional Context7 documentation provider guidance', 'docs/README.md');

    const rootReadme = await readRepoFile('README.md');
    assertIncludes(rootReadme, 'docs/context-providers.md', 'README.md');
  });

  it('documents Repowise as optional repo-intelligence context, not an AIFHub dependency', async () => {
    for (const relativePath of REPOWISE_CONTEXT_DOC_ASSETS) {
      const asset = await readRepoFile(relativePath);
      assertRepowiseOptionalContextGuidance(asset, relativePath);
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

  it('requires fix prompts to route new bug reports to planned OpenSpec changes', async () => {
    for (const relativePath of FIX_PROMPT_ASSETS) {
      const asset = await readRepoFile(relativePath);
      const openspec = extractMarkdownSection(asset, 'OpenSpec-native mode');

      for (const expected of [
        'A new bug report is not a post-verify fix.',
        'No active OpenSpec change or QA evidence was found for this bug fix.',
        '/aif-plan full "fix <bug description>"',
        '`/aif-fix` requires existing QA evidence or selected findings.',
        '`/aif-fix` does not create a new OpenSpec change.',
        '`.ai-factory/state/<change-id>/fixes/`',
        '`/aif-fix` does not write QA verdicts.',
        '`/aif-fix` does not archive.',
        '`/aif-fix` routes back to `/aif-verify <change-id>`.',
        'must not create `.ai-factory/plans/<id>/`'
      ]) {
        assertIncludes(openspec, expected, `${relativePath} OpenSpec-native mode`);
      }

      assertNotIncludes(openspec, '.ai-factory/plans/<id>/status.yaml', `${relativePath} OpenSpec-native mode`);
      assertNotIncludes(openspec, 'legacy `status.yaml` source of truth', `${relativePath} OpenSpec-native mode`);
    }
  });

  it('requires regression-first fix evidence and preserves upstream legacy cleanup ownership', async () => {
    for (const relativePath of FIX_PROMPT_ASSETS) {
      const asset = await readRepoFile(relativePath);
      const openspec = extractMarkdownSection(asset, 'OpenSpec-native mode');

      for (const expected of [
        'narrowest current failing',
        'before editing',
        'smallest root-cause fix',
        'identical',
        'qaEvidenceRead',
        'regressionCheck',
        'preFixResult',
        'postFixResult',
        'fallbackDecision',
        '.ai-factory/state/<change-id>/fixes/',
        'supporting runtime evidence',
        '/aif-verify <change-id>',
        'credentials',
        'tokens',
        'raw provider output'
      ]) {
        assertIncludes(openspec, expected, `${relativePath} regression-first fix contract`);
      }

      assert.match(
        openspec,
        /passes unexpectedly|no useful check exists/i,
        `${relativePath} should define unexpected-pass or no-check fallback behavior`
      );
      assert.match(
        openspec,
        /stop without implementation edits|no implementation edits/i,
        `${relativePath} should stop bounded autonomous fixes without a safe root cause`
      );
    }

    const injectionPath = 'injections/core/aif-fix-plan-folder.md';
    const injection = await readRepoFile(injectionPath);
    const openspec = extractMarkdownSection(injection, 'OpenSpec-native mode');
    const legacy = extractMarkdownSection(injection, 'Legacy AI Factory-only mode');

    for (const expected of [
      'interactive session',
      'investigate further',
      'adjust reproduction',
      'bounded likely fix',
      'autonomous, Handoff, or bounded fixer-agent mode'
    ]) {
      assertIncludes(openspec, expected, `${injectionPath} interactive and autonomous fallback contract`);
    }

    for (const expected of [
      'upstream `/aif-fix` resolved-path workflow',
      'must not implement file deletion',
      'default `.ai-factory/FIX_PLAN.md`',
      'custom `paths.fix_plan` values',
      'remain in place'
    ]) {
      assertIncludes(legacy, expected, `${injectionPath} legacy cleanup ownership contract`);
    }
    assert.doesNotMatch(
      injection,
      /\b(?:rm|unlink)\b|Remove-Item/i,
      `${injectionPath} must not add AIFHub-owned deletion commands or helpers`
    );
  });

  it('requires plan-polisher prompts to validate touched OpenSpec artifacts', async () => {
    for (const relativePath of PLAN_POLISHER_PROMPT_ASSETS) {
      const asset = stripFencedBlocks(await readRepoFile(relativePath));

      for (const expected of [
        'proposal.md',
        'design.md',
        'tasks.md',
        'specs/**/spec.md',
        'ai-factory aifhub-mode status --json',
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
        'ai-factory aifhub-migrate-legacy-plans <change-id> --dry-run',
        'ai-factory aifhub-migrate-legacy-plans <change-id>'
      ]) {
        assertIncludes(openspec, expected, `${relativePath} OpenSpec-native mode`);
      }
    }
  });

  it('requires done prompts to archive verified OpenSpec changes through the done finalizer', async () => {
    for (const relativePath of DONE_PROMPT_ASSETS) {
      const asset = stripFencedBlocks(await readRepoFile(relativePath));

      for (const expected of [
        'ai-factory aifhub-done-finalizer --change <change-id> --json',
        'scripts/openspec-done-finalizer.mjs',
        'extension-local',
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
      assert.doesNotMatch(
        asset,
        /\bnode(?:\.exe)?\s+(?:scripts[\\/]|[^\n]*\.ai-factory[\\/]extensions[\\/][^\n]*scripts[\\/])openspec-(?:done-finalizer|done-readiness|runner)\.mjs\b/i,
        `${relativePath} should not execute extension-local OpenSpec modules as installed-project commands`
      );
    }
  });

  it('requires done prompts to expose explicit dirty-state finalization without involving commit', async () => {
    for (const relativePath of DONE_PROMPT_ASSETS) {
      const asset = stripFencedBlocks(await readRepoFile(relativePath));

      for (const expected of [
        '--record-dirty-state',
        'ai-factory aifhub-done-finalizer --change <change-id> --record-dirty-state --json',
        'git status --short'
      ]) {
        assertIncludes(asset, expected, relativePath);
      }

      assert.match(
        asset,
        /dirty workspace.*blocking|blocking.*dirty workspace|dirty working tree.*blocking|blocking.*dirty working tree/i,
        `${relativePath} should describe dirty workspace as blocking by default`
      );
      assert.match(
        asset,
        /record(?:s|ing)? dirty (?:workspace|working tree|state).*QA evidence|QA evidence.*record(?:s|ing)? dirty (?:workspace|working tree|state)/i,
        `${relativePath} should require dirty state to be recorded in QA evidence`
      );
      assert.doesNotMatch(
        asset,
        /dirty[^\n]*\/aif-commit[^\n]*(?:archive|finaliz)|(?:archive|finaliz)[^\n]*\/aif-commit[^\n]*dirty/i,
        `${relativePath} should not route dirty-workspace archive/finalization through /aif-commit`
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

  it('keeps verify and rules-check next-step guidance one-way with terminal states', async () => {
    for (const relativePath of VERIFY_PROMPT_ASSETS) {
      const asset = stripFencedBlocks(await readRepoFile(relativePath));

      assert.doesNotMatch(
        asset,
        /before or during verification/i,
        `${relativePath} should not invite a rules gate during or after verification`
      );
      for (const expected of [
        'one-way',
        'before verification starts',
        '/aif-done <change-id>',
        '/aif-fix <change-id>'
      ]) {
        assertIncludes(asset, expected, `${relativePath} one-way terminal routing`);
      }
    }

    const rulesAsset = await readRepoFile('injections/core/aif-rules-check-openspec-generated-rules.md');
    const rulesOpenspec = extractMarkdownSection(rulesAsset, 'OpenSpec-native mode');

    for (const expected of [
      'one-way',
      'has not already passed',
      '/aif-verify <change-id>',
      '/aif-done <change-id>',
      'do not suggest `/aif-verify` as remediation'
    ]) {
      assertIncludes(rulesOpenspec, expected, 'rules-check injection one-way terminal routing');
    }

    const usage = await readRepoFile('docs/usage.md');
    assertIncludes(
      usage,
      'one-way with terminal states',
      'docs/usage.md terminal routing statement'
    );
  });

  it('keeps planning-mode guidance capability-gated across active planning prompts', async () => {
    for (const relativePath of PLANNING_RUNTIME_PROMPT_ASSETS) {
      const asset = stripFencedBlocks(await readRepoFile(relativePath));

      for (const expected of [
        'skills/shared/QUESTION-TOOL.md',
        'CLI or IDE runtime exposes a planning mode',
        'do not fabricate unavailable tools or client actions',
        'user controls the mode'
      ]) {
        assertIncludes(asset, expected, relativePath);
      }
    }
  });

  it('requires implement prompts to hydrate runtime todo state from OpenSpec tasks', async () => {
    for (const relativePath of IMPLEMENT_PROMPT_ASSETS) {
      const asset = stripFencedBlocks(await readRepoFile(relativePath));

      for (const expected of [
        'openspec/changes/<change-id>/tasks.md',
        'runtime todo',
        'update_plan',
        'task snapshot',
        'capability fallback',
        'does not authorize broad task expansion'
      ]) {
        assertIncludes(asset, expected, relativePath);
      }
    }
  });

  it('defers roadmap lifecycle completion from OpenSpec implementation', async () => {
    const relativePath = 'injections/core/aif-implement-plan-folder.md';
    const asset = stripFencedBlocks(await readRepoFile(relativePath));
    const label = `${relativePath} roadmap lifecycle deferral contract`;

    for (const expected of [
      'Roadmap lifecycle deferral',
      'overrides the upstream roadmap completion step',
      'must not edit the configured roadmap',
      'must not mark a milestone, phase, slice, or managed lifecycle row complete',
      'even when all implementation tasks are checked',
      'must not claim roadmap completion',
      '/aif-verify <change-id>',
      '/aif-done <change-id>'
    ]) {
      assertIncludes(asset, expected, label);
    }
  });

  it('keeps OpenSpec verification roadmap diagnostics bounded and read-only', async () => {
    const relativePath = 'injections/core/aif-verify-plan-folder.md';
    const asset = stripFencedBlocks(await readRepoFile(relativePath));
    const label = `${relativePath} read-only roadmap validation contract`;

    for (const expected of [
      'Roadmap linkage validation',
      'read-only',
      'WARN [roadmap]',
      'ERROR [roadmap]',
      'malformed',
      'contradictory',
      '/aif-roadmap check',
      'must not copy the managed lifecycle block',
      'Missing linkage alone remains a warning',
      'canonical requirement makes linkage mandatory',
      'must not edit the configured roadmap'
    ]) {
      assertIncludes(asset, expected, label);
    }
  });

  it('documents Codex and Claude implement-worker todo hydration behavior', async () => {
    for (const relativePath of [
      'docs/codex-plan-mode.md',
      'docs/usage.md',
      'docs/codex-agents.md',
      'docs/claude-agents.md'
    ]) {
      const asset = stripFencedBlocks(await readRepoFile(relativePath));

      assertIncludes(asset, 'tasks.md', relativePath);
      assertIncludes(asset, 'runtime todo', relativePath);
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

  it('defines GitHub milestones as roadmap phases with explicit drift handling', async () => {
    for (const relativePath of [
      ROADMAP_PROMPT_ASSET,
      ...ROADMAP_REFERENCE_ASSETS
    ]) {
      const asset = stripFencedBlocks(await readRepoFile(relativePath));

      for (const expected of [
        'Treat GitHub milestones as roadmap phases',
        'Closed milestones',
        'phase audit',
        'open_issues = 0',
        'phase-completion drift',
        'unphased backlog/drift',
        'local artifact evidence remains required'
      ]) {
        assertIncludes(asset, expected, relativePath);
      }
    }
  });

  it('registers linked active OpenSpec changes as planned during roadmap check', async () => {
    for (const relativePath of [ROADMAP_PROMPT_ASSET, ...ROADMAP_REFERENCE_ASSETS]) {
      const asset = stripFencedBlocks(await readRepoFile(relativePath));
      const label = `${relativePath} active lifecycle reconciliation contract`;

      for (const expected of [
        '/aif-roadmap check',
        'active canonical OpenSpec proposal',
        '## Roadmap Linkage',
        'valid non-`none` roadmap linkage',
        'register one local `planned` row',
        'must not claim implementation, verification, finalization, merge, or issue closure'
      ]) {
        assertIncludes(asset, expected, label);
      }
    }
  });

  it('preserves evidence-backed finalized rows for archived changes', async () => {
    for (const relativePath of [ROADMAP_PROMPT_ASSET, ...ROADMAP_REFERENCE_ASSETS]) {
      const asset = stripFencedBlocks(await readRepoFile(relativePath));
      const label = `${relativePath} archived lifecycle reconciliation contract`;

      for (const expected of [
        'archived change',
        'durable local done/archive evidence',
        'preserve its evidence-backed `finalized` row',
        'must never downgrade `finalized` to `planned`',
        'project-relative finalization evidence'
      ]) {
        assertIncludes(asset, expected, label);
      }
    }
  });

  it('does not register or infer lifecycle rows for explicitly unlinked changes', async () => {
    for (const relativePath of [ROADMAP_PROMPT_ASSET, ...ROADMAP_REFERENCE_ASSETS]) {
      const asset = stripFencedBlocks(await readRepoFile(relativePath));
      const label = `${relativePath} unlinked lifecycle reconciliation contract`;

      for (const expected of [
        'explicitly unlinked change',
        'all linkage values are `none`',
        'must not create a managed lifecycle row',
        'must not infer linkage from branch names, GitHub state, labels, or roadmap text'
      ]) {
        assertIncludes(asset, expected, label);
      }
    }
  });

  it('keeps local lifecycle reconciliation available when GitHub evidence is missing', async () => {
    for (const relativePath of [ROADMAP_PROMPT_ASSET, ...ROADMAP_REFERENCE_ASSETS]) {
      const asset = stripFencedBlocks(await readRepoFile(relativePath));
      const label = `${relativePath} missing GitHub reconciliation contract`;

      for (const expected of [
        'GitHub evidence is unavailable, unauthenticated, rate-limited, offline, or partial',
        'local lifecycle reconciliation continues',
        'GitHub limitation is non-blocking',
        'Lifecycle evidence:',
        'GitHub evidence:',
        'report lifecycle and GitHub evidence sources separately'
      ]) {
        assertIncludes(asset, expected, label);
      }
    }
  });

  it('reconciles post-merge GitHub state without fabricating local finalization', async () => {
    for (const relativePath of [ROADMAP_PROMPT_ASSET, ...ROADMAP_REFERENCE_ASSETS]) {
      const asset = stripFencedBlocks(await readRepoFile(relativePath));
      const label = `${relativePath} post-merge reconciliation contract`;

      for (const expected of [
        'post-merge reconciliation',
        'current issue, PR, and milestone state',
        'managed local lifecycle row remains `finalized`',
        'remote closure or merge MUST NOT be rewritten as local finalization evidence',
        'must not promote `planned` to `finalized`'
      ]) {
        assertIncludes(asset, expected, label);
      }
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

  it('defines the commit roadmap freshness gate as read-only and mode-aware', async () => {
    const asset = stripFencedBlocks(await readRepoFile(COMMIT_PROMPT_ASSET));

    for (const expected of [
      'skills/shared/LANGUAGE-POLICY.md',
      'Read `.ai-factory/config.yaml` first',
      'OpenSpec-native mode',
      'Legacy AI Factory-only mode',
      'Missing config mode',
      'do not fabricate OpenSpec context',
      'staged changes and current diff',
      '.ai-factory/qa/<change-id>/done.md',
      '.ai-factory/state/<change-id>/final-summary.md',
      'openspec/specs/**',
      'openspec/changes/archive/**',
      'optional GitHub issue, PR, milestone',
      'openspec/changes/<change-id>/tasks.md',
      '## Commit Plan',
      'Follow Commit Plan',
      'Commit everything together',
      'Adjust grouping',
      'When upstream `/aif-commit` detects an active `## Commit Plan`, preserve the upstream grouping prompt and only add roadmap/GitHub freshness findings before the commit proposal.',
      'must not rewrite active plans',
      'must not force a single commit',
      'If no active change/plan resolves, preserve upstream staged-diff behavior.',
      'WARN',
      'ERROR',
      'no implicit strict mode',
      'closed GitHub milestone exists but `.ai-factory/ROADMAP.md` has no matching phase audit',
      'open GitHub milestone has `open_issues = 0` but roadmap lacks `phase-completion drift`',
      'unphased backlog/drift',
      '/aif-roadmap check',
      'It must not edit `.ai-factory/ROADMAP.md`',
      '.ai-factory/rules/generated/**',
      'canonical OpenSpec artifacts',
      'GitHub issues, milestones, PRs, labels, or linked branches',
      'Keep the upstream conventional commit message flow unchanged'
    ]) {
      assertIncludes(asset, expected, COMMIT_PROMPT_ASSET);
    }
  });

  it('blocks deterministic finalized-state drift without promoting volatile GitHub drift', async () => {
    const asset = stripFencedBlocks(await readRepoFile(COMMIT_PROMPT_ASSET));
    const label = `${COMMIT_PROMPT_ASSET} finalized-state freshness contract`;

    for (const expected of [
      'ERROR [roadmap-local]',
      'deterministic local lifecycle drift',
      'successful `/aif-done`',
      '## Roadmap Linkage',
      'other than `none`',
      'OpenSpec Change Lifecycle',
      'missing, malformed, or not exactly `finalized`',
      'exact `/aif-roadmap check`',
      'stop before the commit proposal',
      'user confirmation MUST NOT bypass',
      'must not create a git commit',
      'WARN [roadmap-external]',
      'volatile external drift',
      'Unavailable, partial, or later-changing GitHub evidence remains warning-only by default',
      'changed after the local snapshot, commit, or merge',
      'does not depend on explicit strict checking',
      'Do not infer successful local finalization from checked tasks'
    ]) {
      assertIncludes(asset, expected, label);
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
