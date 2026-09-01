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

function assertNotIncludes(source, unexpected, filePath) {
  assert.ok(
    !source.includes(unexpected),
    `${filePath} should not include ${JSON.stringify(unexpected)}`
  );
}

function parseFrontmatter(source, filePath) {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  assert.ok(match, `${filePath} should include YAML frontmatter`);

  return new Map(match[1].split(/\r?\n/).flatMap((line) => {
    const separator = line.indexOf(':');
    if (separator <= 0) {
      return [];
    }

    return [[line.slice(0, separator).trim(), line.slice(separator + 1).trim()]];
  }));
}

function compareSemver(left, right) {
  const parse = (value) => String(value).replace(/^['"]|['"]$/g, '').split('.').map(Number);
  const leftParts = parse(left);
  const rightParts = parse(right);

  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) {
      return leftParts[index] - rightParts[index];
    }
  }

  return 0;
}

describe('aif-analyze OpenSpec-native bootstrap contract', () => {
  it('declares bounded metadata for the extension-owned aif-analyze skill', async () => {
    const filePath = 'skills/aif-analyze/SKILL.md';
    const frontmatter = parseFrontmatter(await readRepoFile(filePath), filePath);

    for (const required of ['name', 'description', 'allowed-tools']) {
      assert.ok(frontmatter.get(required), `${filePath} frontmatter should declare ${required}`);
    }

    assert.equal(frontmatter.get('name'), 'aif-analyze');

    const allowedTools = frontmatter.get('allowed-tools');
    for (const requiredTool of [
      'Read',
      'Write',
      'Edit',
      'Glob',
      'Grep',
      'Bash(mkdir *)',
      'Bash(ai-factory aifhub-memory-tools *)',
      'Bash(ai-factory aifhub-mode status --json)',
      'Bash(node --input-type=module -e *openspec-runner.mjs*)',
      'Bash(openspec init --tools none)',
      'Skill',
      'AskUserQuestion',
      'Questions'
    ]) {
      assertIncludes(allowedTools, requiredTool, `${filePath} allowed-tools`);
    }

    assert.doesNotMatch(allowedTools, /(?:^|\s)Bash(?:\s|$)/, 'allowed-tools must not permit unrestricted Bash');
    for (const overlyBroad of ['Bash(ai-factory *)', 'Bash(npx *)', 'Bash(openspec *)']) {
      assertNotIncludes(allowedTools, overlyBroad, `${filePath} allowed-tools`);
    }
  });

  it('declares the feature-level aif-analyze version freshness bump', async () => {
    const filePath = 'skills/aif-analyze/SKILL.md';
    const frontmatter = parseFrontmatter(await readRepoFile(filePath), filePath);
    const version = frontmatter.get('version');

    assert.ok(version, `${filePath} frontmatter should declare version`);
    assert.match(version, /^['"]?\d+\.\d+\.\d+['"]?$/);
    assert.ok(
      compareSemver(version, '0.13.0') >= 0,
      `${filePath} should include the feature-level metadata bump introduced with durable review policy support`
    );
  });

  it('derives base-rule control flow from evidence without duplicating the generated-rules compiler', async () => {
    const skill = await readRepoFile('skills/aif-analyze/SKILL.md');
    const template = await readRepoFile('skills/aif-analyze/references/rules-base-template.md');
    const compiler = await readRepoFile('scripts/openspec-rules-compiler.mjs');

    for (const expected of [
      'guard clauses',
      'early returns or continues',
      'small classification helpers',
      'intentional nested conditionals',
      'evidence paths',
      'omit the section or report it as unresolved',
      'Do not add control-flow detection to the generated OpenSpec rules compiler'
    ]) {
      assertIncludes(skill, expected, 'base-rule generation');
    }

    for (const expected of [
      '{{#if control_flow_supported}}',
      '## Control Flow',
      '{{control_flow_convention}}',
      '{{control_flow_patterns}}',
      '{{control_flow_evidence_paths}}'
    ]) {
      assertIncludes(template, expected, 'base-rule generation template');
    }

    for (const duplicateDetectionMarker of [
      'control_flow_supported',
      'control_flow_convention',
      'control_flow_evidence_paths'
    ]) {
      assertNotIncludes(compiler, duplicateDetectionMarker, 'generated OpenSpec rules compiler');
    }
  });

  it('documents explicit mode selection and preserves legacy default config', async () => {
    const skill = await readRepoFile('skills/aif-analyze/SKILL.md');
    const template = await readRepoFile('skills/aif-analyze/references/config-template.yaml');

    assertIncludes(skill, '### Step 2.5: Resolve Bootstrap Mode', 'skills/aif-analyze/SKILL.md');
    assertIncludes(skill, 'Use `openspec-native` mode when the user explicitly asks', 'skills/aif-analyze/SKILL.md');
    assertIncludes(skill, 'aifhub.artifactProtocol: openspec', 'skills/aif-analyze/SKILL.md');
    assertIncludes(skill, 'Do not silently migrate a legacy AI Factory-only project', 'skills/aif-analyze/SKILL.md');
    assertIncludes(template, 'artifactProtocol: ai-factory', 'skills/aif-analyze/references/config-template.yaml');
    assertIncludes(template, 'utilities:', 'skills/aif-analyze/references/config-template.yaml');
    assertIncludes(template, 'graphify:', 'skills/aif-analyze/references/config-template.yaml');
    assertIncludes(template, 'enabled: false', 'skills/aif-analyze/references/config-template.yaml');
  });

  it('requires patch-preserving config ownership and derives the ultra research root', async () => {
    const skill = await readRepoFile('skills/aif-analyze/SKILL.md');
    const template = await readRepoFile('skills/aif-analyze/references/config-template.yaml');

    for (const expected of [
      'structural patch, not a full-file re-render',
      '`config_version`, `language`, `workflow`, `rules`, and `agent_profile`',
      'unknown user-authored top-level and nested fields',
      'Change only keys owned by the selected AIFHub bootstrap profile',
      '`aifhub.artifactProtocol`',
      '`aifhub.openspec.*`',
      'Do not introduce `research_bundles_dir` or any equivalent config key',
      '<parent(paths.research)>/research/',
      'sorted changed and preserved key paths plus bounded counts',
      'Never include config values, environment data, credentials, tokens, raw provider output, or private absolute paths'
    ]) {
      assertIncludes(skill, expected, 'surface=aif-analyze case=config-update-ownership');
    }

    assertNotIncludes(
      template,
      'research_bundles_dir:',
      'surface=aif-analyze case=no-research-bundles-config-key'
    );
  });

  it('owns a disabled-by-default context dedup profile without auto-enabling it', async () => {
    const skill = await readRepoFile('skills/aif-analyze/SKILL.md');
    const template = await readRepoFile('skills/aif-analyze/references/config-template.yaml');

    for (const expected of [
      'contextDedup:',
      'mode: "off"',
      'minBytes: 2048',
      'maxEntries: 500',
      'protectedPatterns: []',
      'command: sqz'
    ]) {
      assertIncludes(skill, expected, 'skills/aif-analyze/SKILL.md context dedup ownership');
      assertIncludes(template, expected, 'skills/aif-analyze/references/config-template.yaml context dedup profile');
    }

    assert.doesNotMatch(skill, /^\s*mode:\s+off(?:\s+#.*)?$/m);
    assert.doesNotMatch(template, /^\s*mode:\s+off(?:\s+#.*)?$/m);

    for (const expected of [
      'Preserve existing `aifhub.contextDedup` values',
      'add only missing keys',
      'never enable context dedup automatically',
      'off | aifhub | sqz',
      'require explicit confirmation before any install action',
      'MUST NOT download `sqz`'
    ]) {
      assertIncludes(skill, expected, 'skills/aif-analyze/SKILL.md context dedup preservation');
    }
  });

  it('keeps the legacy default template exclusive to the selected protocol', async () => {
    const template = await readRepoFile('skills/aif-analyze/references/config-template.yaml');

    assertIncludes(template, 'artifactProtocol: ai-factory', 'skills/aif-analyze/references/config-template.yaml');
    assert.doesNotMatch(
      template,
      /^  openspec:\s*$/m,
      'skills/aif-analyze/references/config-template.yaml should not include active aifhub.openspec in the legacy profile'
    );

    for (const unexpected of [
      'requireGeneratedRulesForDone',
      'requireRulesPassForDone',
      'requireSpecCoverageForDone',
      'allowWarnOnDone:',
      'useInstructionsApply'
    ]) {
      assertNotIncludes(
        template,
        unexpected,
        'skills/aif-analyze/references/config-template.yaml legacy profile'
      );
    }

    for (const pattern of [
      /^  state:\s*\.ai-factory\/state\s*$/m,
      /^  qa:\s*\.ai-factory\/qa\s*$/m,
      /^  generated_rules:\s*\.ai-factory\/rules\/generated\s*$/m
    ]) {
      assert.doesNotMatch(
        template,
        pattern,
        `skills/aif-analyze/references/config-template.yaml should not include active OpenSpec path key ${pattern}`
      );
    }
  });

  it('documents first-bootstrap artifact protocol prompts without preselecting mode', async () => {
    const skill = await readRepoFile('skills/aif-analyze/SKILL.md');
    const template = await readRepoFile('skills/aif-analyze/references/config-template.yaml');

    for (const expected of [
      'If `.ai-factory/config.yaml` is missing and no artifact protocol was explicitly requested, ask one artifact protocol question before writing config or creating mode-specific directories.',
      '`legacy AI Factory-only`',
      '`OpenSpec-native`',
      'Codex Default mode: ask a short plain-text artifact protocol question; do not use `question(...)`, `questionnaire(...)`, or `request_user_input`.',
      'Codex Plan mode: use one `request_user_input` question only when the user already switched the session into Plan mode.',
      'Autonomous / subagent mode: do not ask; choose legacy `ai-factory` mode by default and report OpenSpec-native mode as an open question/blocker.',
      'Keep localization answers as pending config values until bootstrap mode is resolved.'
    ]) {
      assertIncludes(skill, expected, 'skills/aif-analyze/SKILL.md first-bootstrap prompt contract');
    }

    assertIncludes(
      template,
      'First bootstrap may ask for artifact protocol before this value is written.',
      'skills/aif-analyze/references/config-template.yaml'
    );
  });

  it('defines the OpenSpec-native config shape and canonical runtime paths', async () => {
    const skill = await readRepoFile('skills/aif-analyze/SKILL.md');

    for (const expected of [
      'artifactProtocol: openspec',
      'root: openspec',
      'installSkills: false',
      'validateOnPlan: true',
      'validateOnImprove: true',
      'validateOnVerify: true',
      'statusOnVerify: true',
      'archiveOnDone: true',
      'useInstructionsApply: true',
      'compileRulesOnSync: true',
      'validateOnSync: true',
      'requireCliForPlan: false',
      'requireCliForImprove: false',
      'requireCliForVerify: false',
      'requireCliForDone: true',
      'requireGeneratedRulesForVerify: false',
      'requireGeneratedRulesForDone: true',
      'requireRulesPassForVerify: false',
      'requireRulesPassForDone: true',
      'requireSpecCoverageForVerify: false',
      'requireSpecCoverageForDone: true',
      'allowWarnOnDone:',
      'openspec/changes',
      'openspec/specs',
      '.ai-factory/state',
      '.ai-factory/qa',
      '.ai-factory/rules/generated'
    ]) {
      assertIncludes(skill, expected, 'skills/aif-analyze/SKILL.md OpenSpec bootstrap artifacts');
    }
  });

  it('documents metadata-driven optional tool recommendations and Graphify compatibility config', async () => {
    const skill = await readRepoFile('skills/aif-analyze/SKILL.md');
    const template = await readRepoFile('skills/aif-analyze/references/config-template.yaml');
    const combined = [skill, template].join('\n');

    for (const expected of [
      '### Step 2.1: Optional Context/Memory Tool Recommendations',
      'recommendation-metadata.yaml',
      'ai-factory aifhub-memory-tools labels --from-project --json',
      'ai-factory aifhub-memory-tools recommend --command aif-analyze',
      'ai-factory aifhub-memory-tools select --from-project --command <skill> --json',
      'available_labels',
      'selected_labels',
      'matched_dimension_signals',
      'ai-factory aifhub-memory-tools status --json',
      'ai-factory aifhub-memory-tools metadata --json',
      'exact_file_or_symbol_lookup',
      'architecture_or_impact_discovery',
      'resume_previous_work',
      'large_command_output_compression',
      'version_sensitive_library_docs',
      'codegraph',
      'codex-mem',
      'eagle-mem',
      'Provider output is supporting context only, never canonical OpenSpec evidence.',
      'allowed command scopes',
      'forbidden command scopes',
      'command-specific permission',
      'execution guidance',
      'privacy caveat',
      'protected validation artifacts',
      'utilities.context_tools.enabled',
      'accepted tool ids',
      'selected_tools',
      'utilities.graphify.enabled',
      'utilities.codegraph.enabled',
      'backward-compatible preference',
      'uv --version',
      'uv tool install graphifyy',
      'graphify install',
      'graphify .',
      'utilities:',
      'context_tools:',
      'enabled: []',
      'graphify:',
      'enabled: false',
      'uv_check: uv --version',
      'install: uv tool install graphifyy',
      'activate: graphify install',
      'report_command: graphify .',
      'codegraph:',
      'command: codegraph',
      'status: codegraph status',
      'init: codegraph init .',
      'index: codegraph index --quiet .',
      'query: codegraph query --path . --limit 10 --json',
      'purge: codegraph uninit --force .',
      'Do not install `graphifyy`, run `graphify`'
    ]) {
      assertIncludes(combined, expected, 'aif-analyze Graphify utility guidance');
    }
  });

  it('documents compression guardrails and CodeGraph manual CLI-only status', async () => {
    const combined = [
      await readRepoFile('skills/aif-analyze/SKILL.md'),
      await readRepoFile('docs/context-providers.md'),
      await readRepoFile('docs/context-loading-policy.md'),
      await readRepoFile('docs/memory-tool-recommendations.md'),
      await readRepoFile('docs/memory-tools-research/README.md')
    ].join('\n');

    for (const expected of [
      'CodeGraph',
      'manual_cli_only',
      'suggest_manual_cli_for_repo_graph_when_enabled_or_explicit',
      'codegraph --version',
      'codegraph --help',
      'codegraph status',
      'codegraph init <project>',
      'codegraph index --quiet <project>',
      'codegraph query --path <project>',
      'codegraph uninit --force <project>',
      'Do not run `codegraph install`',
      'serve --mcp',
      'aif-gate-result',
      'coverage.json',
      'done-readiness.json',
      'openspec/specs/**',
      'generated-rules traces',
      'exact evidence snippets',
      'must not rewrite validation artifacts',
      'must not compress protected artifacts in place'
    ]) {
      assertIncludes(combined, expected, 'context/memory provider guardrails');
    }
  });

  it('aggregates rohitg00 AgentMemory docs without treating provider output as canonical evidence', async () => {
    const research = await readRepoFile('docs/memory-tools-research/agentmemory-rohitg00.md');
    const results = await readRepoFile('docs/memory-tools-research/agentmemory-rohitg00-benchmark-results.md');
    const publicDocs = [
      await readRepoFile('docs/memory-tools-research/README.md'),
      await readRepoFile('docs/memory-tool-recommendations.md'),
      await readRepoFile('docs/context-providers.md')
    ].join('\n');
    const combined = [research, results, publicDocs].join('\n');

    for (const expected of [
      'jayzeng/agentmemory',
      'MarceloCaporale/codex-agent-mem',
      'rohitg00/agentmemory',
      '@agentmemory/agentmemory',
      '@agentmemory/mcp',
      'agentmemory-rohitg00.md',
      'agentmemory-rohitg00-benchmark-results.md',
      'reject_default',
      'Isolated runtime status: `PASS`',
      'Full-product runtime status: `NOT_RUN`',
      'agentmemory-isolated-0-9-28-20260720-r4',
      'agentmemory-object-python-mcp-gate-20260720-r1',
      'agentmemory-object-php-uptime-20260720-r1',
      'Python MCP ability/auth gate',
      'PHP uptime interval merge',
      '2/2 `PASS/PASS`',
      '`rg` остаётся baseline'
    ]) {
      assertIncludes(combined, expected, 'rohitg00 AgentMemory provider docs');
    }

    for (const expected of [
      'MCP registration',
      'agent config mutation',
      'hooks',
      'background daemons',
      'supporting context',
      'provider output не становится canonical OpenSpec',
      'не может удовлетворять OpenSpec'
    ]) {
      assertIncludes(combined, expected, 'rohitg00 AgentMemory lifecycle and evidence boundary');
    }
  });

  it('keeps context-mode Codex lifecycle out of normal command ownership', async () => {
    const research = await readRepoFile('docs/memory-tools-research/context-mode.md');
    const results = await readRepoFile('docs/memory-tools-research/context-mode-benchmark-results.md');
    const metadata = await readRepoFile('docs/memory-tools-research/recommendation-metadata.yaml');
    const combined = [research, results, metadata].join('\n');
    for (const expected of [
      '`rg` остаётся baseline',
      'v1.0.169',
      'plugin_snapshot_isolated',
      'NOT_RUN(postinstall_forbidden)',
      'BLOCKED(runtime_dependency_self_install)',
      'NOT_RUN(auth_isolation_unavailable)',
      'normal_command_selection: forbidden',
      'auto_register_hooks: false'
    ]) {
      assertIncludes(combined, expected, 'context-mode Codex lifecycle boundary');
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
      'ai-factory aifhub-mode status --json',
      'Installed-project capability reads should prefer the AIFHub mode wrapper',
      'Source-repo direct runner detection is allowed only when working inside the extension package source tree',
      'Missing or unsupported OpenSpec CLI is a degraded capability state, not a bootstrap failure',
      'If `reason` is `unsupported-version`, recommend installing or updating OpenSpec CLI to `>=1.3.1 <2.0.0`.'
    ]) {
      assertIncludes(skill, expected, 'skills/aif-analyze/SKILL.md');
    }
  });

  it('recommends a user-owned update for supported but outdated OpenSpec without degrading bootstrap', async () => {
    const skill = await readRepoFile('skills/aif-analyze/SKILL.md');
    const compatibility = await readRepoFile('docs/openspec-compatibility.md');
    const usage = await readRepoFile('docs/usage.md');
    const metadata = JSON.parse(await readRepoFile('aifhub-extension.json'));
    const latestReviewedVersion = metadata.sources.openspec.version;
    const combined = [skill, compatibility, usage].join('\n');

    assert.equal(latestReviewedVersion, '1.9.0', 'OpenSpec analyze reviewed baseline');
    assert.equal(metadata.sources.openspec.baselineVersion, '1.3.1');
    assert.equal(metadata.sources.openspec.supportedRange, '>=1.3.1 <2.0.0');
    assert.deepEqual(metadata.sources.openspec.reviewedPrereleaseVersions, ['1.6.0-beta.1']);
    assert.equal(metadata.sources.openspec.requiresNode, '>=20.19.0');
    assert.deepEqual(metadata.sources.openspec.reviewedStableVersions, [
      '1.3.1',
      '1.4.0',
      '1.4.1',
      '1.5.0',
      '1.6.0',
      '1.7.0',
      '1.8.0',
      '1.9.0'
    ]);

    for (const expected of [
      `latestReviewedVersion: "${latestReviewedVersion}"`,
      'versionOutdated: boolean | null',
      'compatible but older than the latest reviewed stable version',
      'non-blocking update recommendation',
      '`project-local`',
      '`path`',
      '`explicit`',
      'Do not guess a package manager',
      'Do not install, update, replace, or re-resolve OpenSpec automatically',
      'do not recommend a downgrade'
    ]) {
      assertIncludes(combined, expected, 'OpenSpec analyze version freshness contract');
    }

    assertIncludes(skill, `latestReviewedVersion: "${latestReviewedVersion}"`, 'skills/aif-analyze/SKILL.md reviewed version');
    assertIncludes(compatibility, `latestReviewedVersion: "${latestReviewedVersion}"`, 'docs/openspec-compatibility.md reviewed version');
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

  it('documents language technical terms policy and runtime-specific invocations', async () => {
    const skill = await readRepoFile('skills/aif-analyze/SKILL.md');
    const template = await readRepoFile('skills/aif-analyze/references/config-template.yaml');
    const combined = [skill, template].join('\n');

    for (const expected of [
      'language.ui',
      'language.artifacts',
      'language.technical_terms',
      'default it to `keep`',
      'keep | translate | mixed',
      'technical_terms: keep',
      'first recommended command must use the selected runtime invocation style',
      '$aif` for `codex-app`',
      'codex-app',
      '$aif-explore',
      '$aif-plan full',
      '$aif-verify',
      '$aif-*',
      'slash-command runtimes',
      '/aif-explore',
      '/aif-plan full',
      '/aif-verify',
      '/aif-*',
      'runtime-specific plan command',
      'selected runtime invocation for `aif-architecture` and `aif-roadmap`',
      'suggest the selected runtime invocation for `aif` first',
      'suggest or initiate the selected runtime invocation for `aif-architecture`',
      'suggest or initiate the selected runtime invocation for `aif-roadmap`',
      'core `aif`',
      'suggests the selected runtime invocation (`$aif` for `codex-app`, `/aif` for slash-command runtimes) if missing',
      'Canonical workflow entries are runtime-specific',
      'codex-app: `$aif-explore`, `$aif-plan full`, `$aif-improve`, `$aif-implement`, `$aif-verify`, `$aif-fix`',
      'slash-command runtimes: `/aif-explore`, `/aif-plan full`, `/aif-improve`, `/aif-implement`, `/aif-verify`, `/aif-fix`',
      'using the selected runtime invocation style'
    ]) {
      assertIncludes(combined, expected, 'aif-analyze language/runtime policy');
    }

    for (const stale of [
      'first recommended command must be `/aif`',
      'After bootstrap describe the current public workflow as starting with `/aif-explore`',
      'If DESCRIPTION is missing, suggest `/aif` first.',
      'suggest running `/aif`',
      'suggest or initiate `/aif-architecture`',
      'suggest or initiate `/aif-roadmap`',
      'core `/aif`',
      'suggests `/aif` if missing',
      'Canonical commands are now:',
      '- /aif-explore\n- /aif-plan full',
      '`/aif-done`'
    ]) {
      assertNotIncludes(skill, stale, 'skills/aif-analyze/SKILL.md');
    }
  });

  it('declares aif-analyze as the explicit-opt-in owner for non-empty glossary creation and approved patch updates', async () => {
    const skill = await readRepoFile('skills/aif-analyze/SKILL.md');
    const configTemplate = await readRepoFile('skills/aif-analyze/references/config-template.yaml');

    for (const expected of [
      '`/aif-analyze` is the only AIFHub command allowed to create or update the project glossary.',
      'explicit user opt-in',
      'concrete source-grounded terms',
      'Do not create an empty placeholder',
      'explicit update request or the user accepts a proposed glossary update',
      'patch-style update',
      'preserve manual entries and unknown headings',
      '`created`, `updated`, `preserved`, or `skipped`',
      'Never include glossary contents in the handoff'
    ]) {
      assertIncludes(skill, expected, 'skills/aif-analyze/SKILL.md glossary ownership contract');
    }

    for (const expected of [
      'context: CONTEXT.md',
      'Optional project glossary',
      'created only with explicit opt-in'
    ]) {
      assertIncludes(configTemplate, expected, 'skills/aif-analyze/references/config-template.yaml glossary profile');
    }
  });

  it('treats paths.context as an optional safe file rather than a required directory', async () => {
    const skill = await readRepoFile('skills/aif-analyze/SKILL.md');

    for (const expected of [
      '### Step 3.25: Optional Project Glossary',
      'normalized project-relative file path',
      'Reject absolute paths, URI-like values, paths that escape the project root, and directory targets.',
      'Do not read or write any rejected target.',
      'Missing glossary files are a normal non-fatal state.',
      'Continue without glossary context',
      'one sanitized warning with the rejection reason',
      'Do not include an external absolute path',
      'File-valued settings such as `paths.description`, `paths.architecture`, `paths.context`, `paths.roadmap`, `paths.research`, and `reviews.policy_file`',
      'must never be created as directories'
    ]) {
      assertIncludes(skill, expected, 'skills/aif-analyze/SKILL.md glossary path-safety contract');
    }
  });

  it('provides a glossary-only template without authority-bearing artifact sections', async () => {
    const template = await readRepoFile('skills/aif-analyze/references/project-glossary-template.md');

    for (const heading of [
      '# Project Glossary',
      '## Language',
      '## Avoid',
      '## Relationships',
      '## Flagged Ambiguities'
    ]) {
      assertIncludes(template, heading, 'project glossary template allowed sections');
    }

    for (const forbiddenHeading of [
      '## Requirements',
      '## Rules',
      '## Decisions',
      '## Scratch Notes'
    ]) {
      assertNotIncludes(template, forbiddenHeading, 'project glossary template authority boundary');
    }

    for (const exclusion of [
      'Do not store requirements, rules, architecture decisions, task notes, or scratch notes here.',
      'Use only concise, source-grounded terminology.'
    ]) {
      assertIncludes(template, exclusion, 'project glossary template exclusions');
    }
  });
});
