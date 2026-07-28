---
name: aif-analyze
description: Bootstrap project context. Resolves localization and stack, creates/updates config.yaml and rules/base.md, then checks DESCRIPTION and guides core skill execution.
version: 0.9.1
author: ichi
---

# AIF Analyze

Bootstrap project context for AI Factory. This skill prepares configuration and rules, then checks core artifacts and guides the next core skills.

## Ownership Boundary

| Artifact | Owner | This Skill |
|----------|-------|------------|
| `config.yaml` | **aif-analyze** | Creates/updates |
| `rules/base.md` | **aif-analyze** | Creates if missing |
| `paths.context` / project glossary | **aif-analyze** | Registers the path; creates or patch-updates only with explicit user opt-in |
| `DESCRIPTION.md` | core `aif` | Checks existence, suggests the selected runtime invocation (`$aif` for `codex-app`, `/aif` for slash-command runtimes) if missing |
| `ARCHITECTURE.md` | core `aif-architecture` | Initiates the selected runtime invocation based on workflow flag |
| `ROADMAP.md` | core `aif-roadmap` | Initiates the selected runtime invocation based on workflow flag |

## Workflow

### Step 1: Resolve Localization

- Follow `skills/shared/LANGUAGE-POLICY.md` when producing user-facing responses or generated artifacts; this skill remains the owner of localization discovery and config persistence.
- This step is mandatory and must finish before any repository analysis.
- Treat the language as a project-level preference, not a user-level global setting.
- Read project memory in this order: `.ai-factory/config.yaml`, then `AGENTS.md`, then `CLAUDE.md`, then `.ai-factory/RULES.md`.
- Check `config.language.ui` and `config.language.artifacts`
- If config.yaml exists with localization settings, use them without asking.
- Treat only explicit localization markers as saved memory.
- Valid memory in `AGENTS.md` or `CLAUDE.md` is a dedicated `## Interaction Preferences` section containing both `Preferred language:` and `Translation scope:` lines.
- Valid memory in `.ai-factory/RULES.md` is both exact bullets `- Preferred language: ...` and `- Translation scope: ...`.
- Never treat tech-stack fields such as `Language: TypeScript`, the current conversation language, or OS locale as a saved project language.
- If the explicit localization markers are missing or incomplete, asking is mandatory before repository inspection or artifact generation. Do not infer the answer.
- Ask question 1 exactly as the project language selector.
- The language options must always include `original (English)` and `russian`.
- Add one context-derived language option only when strong evidence exists.
- Ask question 2 exactly as the translation-scope selector with these options: `communication only`, `communication and artifacts`, `artifacts only`.
- Persist answers to config.yaml (preferred) or bridge file if present.
- If `.ai-factory/config.yaml` is missing, do not create a full config only to persist localization answers before bootstrap mode is resolved. Keep localization answers as pending config values until bootstrap mode is resolved.
- If the translation scope excludes artifacts, keep generated artifacts in the original project language.
- If the translation scope includes artifacts, generate them in the preferred language.
- Keep file names, commands, and identifiers in English.
- Choose the question format by runtime. See `skills/shared/QUESTION-TOOL.md` for the mapping:
  - Claude Code / Kilo CLI / OpenCode: use `question(questions: [...])`.
  - Codex Default mode: use plain-text questions only (no form tool available).
  - Codex Plan mode: use `request_user_input` only when the user already switched the session into Plan mode, and only for 1-3 short questions.
  - If Codex planning guidance needs Plan mode, recommend manual `/plan-mode` as a user action; do not imply this skill can switch modes itself.
  - Autonomous / subagent mode: do not ask interactive questions; record assumptions and blockers/open questions and return them to the parent.

### Step 1.5: Check Extension Compatibility

If this project is an ai-factory extension (has `extension.json`):

1. Read `.ai-factory.json` to get installed ai-factory version
2. Read `aifhub-extension.json` to get `compat.ai-factory` semver range
3. If both exist, compare:
   - If version satisfies range → continue normally
   - If version does NOT satisfy range → output warning:

```
⚠️ Compatibility Warning

ai-factory {installed_version} несовместим с extension (requires {compat_range})

Рекомендации:
- Обновите ai-factory до совместимой версии
- Или обновите compat range в aifhub-extension.json
```

4. Continue execution (warning only, do not block)

### Step 1.6: Check Legacy Workflow Aliases

If this project contains legacy skill-context directories under `.ai-factory/skill-context/` for deprecated `*-plus` workflow names:

then emit a non-blocking migration note:

```
ℹ️ Legacy Workflow Compatibility

This project still contains legacy skill-context for `aif-*-plus`.
Canonical workflow entries are runtime-specific:
- codex-app: `$aif-explore`, `$aif-plan full`, `$aif-improve`, `$aif-implement`, `$aif-verify`, `$aif-fix`
- slash-command runtimes: `/aif-explore`, `/aif-plan full`, `/aif-improve`, `/aif-implement`, `/aif-verify`, `/aif-fix`

If docs or handoff notes mention `Explore`, `New`, `Apply`, or `Done`, treat them only as stage names.
Do not present `/aif-new` or `/aif-apply` as current public commands.
Mention `aif-done` only as the explicit post-verify AIFHub finalizer using the selected runtime invocation style, not as a legacy alias or part of the canonical public workflow.

Backward-compatible fallback is still supported, but renaming the skill-context folders is recommended.
```

Do not rewrite or delete those folders automatically in this skill.

### Step 2: Inspect the Repository

- Use [references/project-scan-checklist.md](references/project-scan-checklist.md) as the scan order.
- Read existing `.ai-factory/*` context files before writing new content.
- Prefer direct evidence from manifests, source layout, config files, and project docs.
- Note the tech stack for rules/base.md generation.

### Step 2.1: Optional Context/Memory Tool Recommendations

Use local recommendation metadata to suggest optional context and memory tools during repository inspection. This skill recommends the needed tools; it does not execute provider setup, indexing, MCP registration, or agent configuration.

Read metadata from the installed extension path when available:

```text
.ai-factory/extensions/aifhub-extension/docs/memory-tools-research/recommendation-metadata.yaml
```

When this skill is running inside the AIFHub extension source repository, the source-tree metadata path may be used:

```text
docs/memory-tools-research/recommendation-metadata.yaml
```

Installed-project diagnostics should use the wrapper command:

```bash
ai-factory aifhub-memory-tools labels --from-project --json
ai-factory aifhub-memory-tools recommend --command aif-analyze --shape <project_shape> --language <language> --volume <volume> --complexity <complexity> --repo-shape <repo_shape> --artifact-mode <artifact_mode> --task <task_signal> --json
ai-factory aifhub-memory-tools select --from-project --command <skill> --json
ai-factory aifhub-memory-tools status --json
ai-factory aifhub-memory-tools metadata --json
```

`recommend --from-project --json` remains a shortcut for diagnostics and compatibility. `/aif-analyze` itself must use the labels-first flow: call `labels --from-project --json`, inspect `available_labels`, `project_profile`, `selected_labels`, `matched_dimension_signals`, and per-label `evidence`, choose task signals from the request/analysis context, then call `recommend` with explicit labels from `project_profile`.

If metadata is unavailable, skip recommendations with a degraded note and keep `rg` as the baseline tool.

Classify project shape from repository evidence:

- `multirepo`
- `large_framework_app`
- `large_legacy`
- `go_service`
- `small_microservice`

Detect task signals from the user request and analysis context:

- `exact_file_or_symbol_lookup`
- `architecture_or_impact_discovery`
- `multirepo_surface_mapping`
- `resume_previous_work`
- `open_work_or_completion_check`
- `large_command_output_compression`
- `version_sensitive_library_docs`
- `manual_durable_notes`

Recommendation rules:

- `rg` remains the baseline for exact file/symbol lookup, small projects, and first-pass literal search.
- Start from labels, not hidden recommendation classification: first report selected project labels, then explain recommendations and non-recommendations against those labels.
- Recommend only tools allowed by local metadata.
- Prefer installed/local tools in recommendations; non-installed tools may be described as optional manual install only when metadata allows.
- Include enriched recommendation details when metadata provides them: allowed command scopes, forbidden command scopes, command-specific permission, execution guidance, privacy caveat, read scope, purge path, availability, and explicit opt-in install policy.
- The final analysis response must include a concise optional tool block with `Project labels`, `Recommended tools`, and `Do not use` sections. `Project labels` must include languages, volume, complexity, repo shape, artifact mode, project shape, task signals, and matched dimension signals when present.
- Ask the user which recommended tools to enable. Write only accepted tool ids to `utilities.context_tools.enabled`; do not enable a tool just because it was recommended.
- After config is updated, follow-on skills should call `ai-factory aifhub-memory-tools select --from-project --command <skill> --json` and use only `selected_tools`. Do not hard-code provider-specific tool lists into follow-on skills.
- Never auto-install, run setup, start MCP, register MCP, index source, sync memory, install hooks, start background daemons, or persist provider output.
- Provider output is supporting context only, never canonical OpenSpec evidence.
- `codex-mem` and `eagle-mem` are not recommended by default.
- `agent-memory` is recommended only when the user explicitly asks for manual durable notes.
- `CodeGraph` is `manual_cli_only` with `suggest_manual_cli_for_repo_graph_when_enabled_or_explicit`: explicit CLI scoped read/purge is verified for broad repo graph questions, but `install`/MCP/agent configuration mutation surface is not accepted. `/aif-analyze` may recommend it; `/aif-explore` may use it only when `select --command aif-explore --json` returns it in `selected_tools` and the run can purge with the returned purge command.
- Treat protected validation artifacts as off limits for context/compression rewriting. Optional tools must not rewrite validation artifacts and must not compress protected artifacts in place, including `aif-gate-result`, `coverage.json`, `done-readiness.json`, `openspec/specs/**`, generated-rules traces, and exact evidence snippets.

CodeGraph manual CLI lifecycle is metadata-owned execution guidance for a later selected explore run:

```bash
codegraph init <project>
codegraph index --quiet <project>
codegraph query --path <project> --limit 10 --json "<query>"
codegraph uninit --force <project>
```

Do not run `codegraph install`, `codegraph sync`, `codegraph serve`, `codegraph serve --mcp`, agent configuration commands, hooks, or background services.

Safe local availability probes are limited to:

```bash
rg --version
uv --version
graphify --version
graphify --help
codex-agent-mem-policy --help
codex-agent-mem-smoke --help
context-mode doctor
codegraph --version
codegraph --help
codegraph status
ctx7 --version
npx --no-install ctx7 --help
```

Run the Context7 probes only when a docs-provider check is explicitly requested. Do not run `ctx7 setup`.

Optional Graphify context remains allowed only as supporting context. During repository inspection, this skill may read existing reviewed Graphify outputs:

- `graphify-out/GRAPH_REPORT.md`
- `graphify-out/graph.json`
- `.ai-factory/references/graphify/GRAPH_REPORT.md`
- `.ai-factory/state/<change-id>/graphify/GRAPH_REPORT.md`

Missing Graphify or missing reports are degraded context, not bootstrap failure. Do not install `graphifyy`, run `graphify`, add Graphify dependencies or manifest entries, or start/register Graphify MCP automatically.

Treat Graphify findings as supporting context only. `GRAPH_REPORT.md` can contain extracted, inferred, ambiguous, or confidence-labeled relationships; use those claims as hypotheses for direct repository inspection. Bootstrap decisions, config content, rules/base.md content, and artifact status must still be grounded in manifests, source files, project docs, existing AIFHub artifacts, or other direct repository evidence.

Do not copy Graphify output during bootstrap unless the user explicitly asks to preserve reviewed output. If preserving reviewed Graphify context, use `.ai-factory/references/graphify/` for project-wide references or `.ai-factory/state/<change-id>/graphify/` for change-scoped runtime context. Never store Graphify generated files under `openspec/changes/<change-id>/`, `openspec/specs/`, `.ai-factory/rules/generated/`, or `.ai-factory/qa/<change-id>/`.

Before reading or preserving provider output, treat privacy as an explicit caveat: do not persist API keys, tokens, raw authorization headers, credential helper output, private backend diagnostics, private provider diagnostics, or unreviewed sensitive output in `.ai-factory/`, `openspec/`, docs, runtime state, QA evidence, generated rules, or provider reference copies.

### Step 2.5: Resolve Bootstrap Mode

Resolve the bootstrap/config mode before creating directories:

- Use `openspec-native` mode when the user explicitly asks for `openspec-native`, `OpenSpec-native`, or OpenSpec artifact protocol bootstrap.
- Use `openspec-native` mode when an existing `.ai-factory/config.yaml` has `aifhub.artifactProtocol: openspec`.
- Preserve legacy `ai-factory` mode when an existing `.ai-factory/config.yaml` does not declare `aifhub.artifactProtocol: openspec`.
- If `.ai-factory/config.yaml` is missing and no artifact protocol was explicitly requested, ask one artifact protocol question before writing config or creating mode-specific directories.
  - Options must be exactly `legacy AI Factory-only` and `OpenSpec-native`.
  - Codex Default mode: ask a short plain-text artifact protocol question; do not use `question(...)`, `questionnaire(...)`, or `request_user_input`.
  - Codex Plan mode: use one `request_user_input` question only when the user already switched the session into Plan mode.
  - Claude Code / Kilo CLI / OpenCode: use `question(questions: [...])`.
  - Autonomous / subagent mode: do not ask; choose legacy `ai-factory` mode by default and report OpenSpec-native mode as an open question/blocker.
- Use the selected first-bootstrap answer to choose legacy `ai-factory` mode or `openspec-native` mode.
- Do not silently migrate a legacy AI Factory-only project to OpenSpec-native mode.
- Preserve existing config values. Add only missing keys required by the resolved mode.
- Record the resolved mode and selection source for the final handoff: existing config, explicit user request, first-bootstrap answer, or autonomous default.

### Step 3: Create or Update config.yaml

- If config.yaml is missing, create it with v1 schema only after bootstrap mode is resolved.
- If config.yaml exists, preserve existing values and add missing fields.
- Preserve existing `language.ui`, `language.artifacts`, and `language.technical_terms` values. If `language.technical_terms` is missing, default it to `keep`; accepted values are `keep | translate | mixed`.
- If localization answers were collected while config was missing, write those pending config values into the selected legacy `ai-factory` or `openspec-native` config shape.
- Keep schema consistent with nested sections: `language`, `aifhub`, `paths`, `utilities`, `rules`, `workflow`.
- Preserve existing `aifhub.contextDedup` values, add only missing keys, and never enable context dedup automatically. The optional profile is protocol-neutral and disabled by default. `enabled: false|true` remains a legacy read-compatible alias for `mode: off|aifhub`, but new config MUST use the type-stable mode enum:

```yaml
aifhub:
  contextDedup:
    mode: "off" # off | aifhub | sqz
    minBytes: 2048
    maxEntries: 500
    protectedPatterns: []
    sqz:
      command: sqz
```

- `protectedPatterns` contains only additional project patterns. Built-in protection for canonical plans, specs, QA, generated rules, coverage, gate, and done-readiness artifacts remains non-removable.
- If the user explicitly selects `sqz`, disclose before activation that it is a new third-party user-owned executable, name the tested `ojuschugh1/sqz` v1.3.0 source and Elastic License 2.0, explain the cross-session cache/reference risk and that the CLI may keep user-owned statistics under `~/.sqz`, and require explicit confirmation before any install action. This skill MUST NOT download `sqz`, run `sqz init`, install hooks, register MCP, mutate agent config, start a daemon, or claim ownership of SQZ user state. Write `mode: sqz` only after the user accepts the external-tool requirement; manual config edits are handled later by bounded runtime readiness diagnostics.
- Ensure the shared optional utility config is present in both legacy `ai-factory` and `openspec-native` modes, preserving existing user values. `utilities.context_tools.enabled` is the stable user-accepted tool id list. `utilities.graphify.enabled` and `utilities.codegraph.enabled` are backward-compatible preference shims. New optional memory/context recommendations come from local `recommendation-metadata.yaml`, not from a generic provider config abstraction:

```yaml
utilities:
  context_tools:
    # accepted tool ids from /aif-analyze recommendations
    enabled: []
  graphify:
    enabled: false
    uv_check: uv --version
    install: uv tool install graphifyy
    activate: graphify install
    report_command: graphify .
  codegraph:
    enabled: false
    command: codegraph
    status: codegraph status
    init: codegraph init .
    index: codegraph index --quiet .
    query: codegraph query --path . --limit 10 --json
    purge: codegraph uninit --force .
```

- In legacy `ai-factory` mode:
  - Ensure this selected-protocol profile is present:

```yaml
aifhub:
  artifactProtocol: ai-factory
  contextDedup:
    mode: "off"
    minBytes: 2048
    maxEntries: 500
    protectedPatterns: []
    sqz:
      command: sqz
```

  - Preserve the existing AI Factory-only path defaults.
  - Keep `paths.plans` at `.ai-factory/plans` unless an existing value says otherwise.
  - Keep `paths.specs` at `.ai-factory/specs` unless an existing value says otherwise.
  - Do not add `aifhub.openspec`, OpenSpec policy defaults, or OpenSpec runtime path defaults (`paths.state`, `paths.qa`, `paths.generated_rules`) unless OpenSpec-native mode is selected.
  - Preserve existing user-authored config values unless the user explicitly requests mode cleanup or `/aif-mode` switching.
- In `openspec-native` mode:
  - Ensure this config shape is present:

```yaml
aifhub:
  artifactProtocol: openspec
  contextDedup:
    mode: "off"
    minBytes: 2048
    maxEntries: 500
    protectedPatterns: []
    sqz:
      command: sqz
  openspec:
    root: openspec
    installSkills: false
    validateOnPlan: true
    validateOnImprove: true
    validateOnVerify: true
    statusOnVerify: true
    archiveOnDone: true
    useInstructionsApply: true
    compileRulesOnSync: true
    validateOnSync: true
    requireCliForPlan: false
    requireCliForImprove: false
    requireCliForVerify: false
    requireCliForDone: true
    requireGeneratedRulesForVerify: false
    requireGeneratedRulesForDone: true
    requireRulesPassForVerify: false
    requireRulesPassForDone: true
    requireSpecCoverageForVerify: false
    requireSpecCoverageForDone: true
    allowWarnOnDone:
      rules: false
      coverage: false
      openspecStatus: true
```

  - Ensure canonical artifact paths are set or completed:

```yaml
paths:
  context: CONTEXT.md
  plans: openspec/changes
  specs: openspec/specs
  state: .ai-factory/state
  qa: .ai-factory/qa
  generated_rules: .ai-factory/rules/generated
```

  - Preserve `paths.description`, `paths.architecture`, `paths.context`, `paths.roadmap`, `paths.research`, and `paths.rules` unless they are missing.
  - Do not install OpenSpec skills, slash commands, or dependencies.

Use [references/config-template.yaml](references/config-template.yaml) as reference.

### Step 3.25: Optional Project Glossary

`/aif-analyze` is the only AIFHub command allowed to create or update the project glossary. Other AIFHub commands and packaged agents are read-only consumers through the shared glossary policy.

- Register or preserve `paths.context`; use `CONTEXT.md` when the key is missing. The configured value must be a normalized project-relative file path.
- Reject absolute paths, URI-like values, paths that escape the project root, and directory targets. Do not read or write any rejected target.
- On rejection, emit one sanitized warning with the rejection reason. Continue without glossary context. Do not include an external absolute path or any glossary contents.
- Missing glossary files are a normal non-fatal state. Do not create an empty placeholder only because `paths.context` exists.
- Create the glossary only after explicit user opt-in and only when repository evidence provides concrete source-grounded terms. If no concrete term is available, report `skipped`.
- For an existing glossary, require an explicit update request or the user accepts a proposed glossary update. Use a patch-style update: preserve manual entries and unknown headings, and change only the accepted terminology entries.
- Use [references/project-glossary-template.md](references/project-glossary-template.md) as the allowed lexical shape. Do not place requirements, project rules, architecture decisions, task notes, provider output, or scratch notes in the glossary.
- In the final handoff, report the glossary status as `created`, `updated`, `preserved`, or `skipped` and include only its project-relative path. Never include glossary contents in the handoff.

### Step 3.5: Detect OpenSpec Capabilities

Run this step only in `openspec-native` mode, after config mode is resolved and before directory creation.

- Installed-project capability reads should prefer the AIFHub mode wrapper:

```bash
ai-factory aifhub-mode status --json
```

- Read `openspecCli` from the JSON output and report equivalent capability fields.
- Source-repo direct runner detection is allowed only when working inside the extension package source tree.
- If `scripts/openspec-runner.mjs` exists, use `detectOpenSpec()` from that file.
- In Node-capable runtimes, a valid detection command is:

```bash
node --input-type=module -e "import { detectOpenSpec } from './scripts/openspec-runner.mjs'; console.log(JSON.stringify(await detectOpenSpec(), null, 2));"
```

- Report capability fields equivalent to:

```yaml
openspec:
  available: boolean
  canValidate: boolean
  canArchive: boolean
  version: string | null
  supportedRange: ">=1.3.1 <2.0.0"
  requiresNode: ">=20.19.0"
  nodeSupported: boolean
  versionSupported: boolean
```

- The runner may also return `nodeVersion`, `command`, `reason`, and `errors`; include those when useful for troubleshooting.
- Do not print raw command output unless troubleshooting requires it.
- If the OpenSpec CLI is compatible, prefer or recommend `openspec init --tools none`.
- If the OpenSpec CLI is missing or unsupported, continue bootstrap with `canValidate: false` and `canArchive: false`.
- Missing or unsupported OpenSpec CLI is a degraded capability state, not a bootstrap failure.
- If `reason` is `unsupported-version`, recommend installing or updating OpenSpec CLI to `>=1.3.1 <2.0.0`.
- If `reason` is `unsupported-node`, recommend using Node `>=20.19.0` for OpenSpec validation/archive.
- If `scripts/openspec-runner.mjs` is missing, report that capability detection is unavailable and continue with degraded capability values.

### Step 4: Create rules/base.md

- Check if `.ai-factory/rules/base.md` exists.
- **If missing**: Create rules directory and base.md.
- Infer project-specific rules from codebase evidence:
  - Primary language and style conventions
  - Naming conventions (from existing code)
  - Module boundaries (from project structure)
  - Error handling patterns (from existing code)
  - Testing requirements (from test files presence)
  - Control-flow conventions, but only when repeated direct evidence supports them:
    - Inspect representative implementation and test files for guard clauses, early returns or continues, and small classification helpers.
    - Also inspect intentional nested conditionals such as framework lifecycle, parser/state-machine, or transaction branching; do not flatten those into generic "avoid nesting" advice.
    - Record the evidence paths and the concrete patterns observed. Never copy secrets or sensitive values into the rule or report.
    - Generate a `Control Flow` rule only when the evidence supports a project convention. If evidence is absent, mixed, or ambiguous, omit the section or report it as unresolved instead of inventing generic advice.
    - Keep this project analysis in `.ai-factory/rules/base.md`. Do not add control-flow detection to the generated OpenSpec rules compiler; configured rule loading already composes base rules with generated rules.
- Use [references/rules-base-template.md](references/rules-base-template.md) as scaffold.
- Fill placeholders with project-specific values, not generic advice.
- Do NOT create optional area rules (api.md, frontend.md, etc.) — planning owns those when the active plan needs them.
- If `.ai-factory/RULES.md` exists, treat it as additional project-level rules (do not overwrite it).

### Step 5: Ensure Directories Exist

- Create only directory-valued configured paths. File-valued paths such as `paths.description`, `paths.architecture`, `paths.context`, `paths.roadmap`, and `paths.research` must never be created as directories.

- In legacy `ai-factory` mode, create directories from config paths if missing:
  - `paths.plans` (typically `.ai-factory/plans`)
  - `paths.specs` (typically `.ai-factory/specs`)
  - `paths.rules` (typically `.ai-factory/rules`)
- In `openspec-native` mode:
  - If compatible OpenSpec CLI capabilities are available, prefer or recommend:

```bash
openspec init --tools none
```

  - Verify or create the OpenSpec skeleton without installing tool integrations:
    - `openspec/config.yaml`
    - `openspec/specs/`
    - `openspec/changes/`
  - Preserve an existing `openspec/config.yaml`; do not overwrite it.
  - Verify or create runtime/generated AI Factory directories:
    - `.ai-factory/state/`
    - `.ai-factory/qa/`
    - `.ai-factory/rules/generated/`
  - Do not install OpenSpec skills or slash commands.
  - Record created versus preserved skeleton paths for the final handoff.

### Step 6: Check DESCRIPTION and Guide Core Skills

- Check if `.ai-factory/DESCRIPTION.md` exists.
- If missing: do not generate DESCRIPTION content in this skill; suggest the selected runtime invocation for `aif` first (`$aif` for `codex-app`, `/aif` for slash-command runtimes).
- If DESCRIPTION exists and `workflow.analyze_updates_architecture: true`, suggest or initiate the selected runtime invocation for `aif-architecture`.
- If `workflow.architecture_updates_roadmap: true`, suggest or initiate the selected runtime invocation for `aif-roadmap`.
- If automatic invocation is not available in the current runtime, provide explicit next commands to the user in order.

### Step 7: Finish with Guided Handoff

- Use the saved scope plus preferred language for the reply.
- Mention created/updated files: `config.yaml`, `rules/base.md`, and artifact status (`DESCRIPTION.md`, `ARCHITECTURE.md`, `ROADMAP.md`).
- If a `Control Flow` rule was generated, report the evidence paths and patterns that support it. If it was omitted or left unresolved, say that repository evidence was insufficient or mixed; do not substitute unsupported generic advice.
- Report the resolved bootstrap mode.
- Report the bootstrap mode selection source: existing config, explicit user request, first-bootstrap answer, or autonomous default.
- Report whether config values were created or preserved.
- Report the optional glossary status as `created`, `updated`, `preserved`, or `skipped` plus its project-relative path; never report glossary contents.
- Report project labels from `ai-factory aifhub-memory-tools labels --from-project --json` first: languages, volume, complexity, repo shape, artifact mode, project shape, task signals, matched dimension signals, and short evidence for the labels that affected recommendations.
- Report optional local tool recommendations from explicit-label `ai-factory aifhub-memory-tools recommend --command aif-analyze ... --json` output when the installed wrapper is available, or from source-tree metadata only when running inside the AIFHub extension repository. Include baseline `rg`, recommended tools with availability/read scope/purge path/skill usefulness, and not-recommended tools with label-based reasons such as `codex-mem`, `eagle-mem`, tools forbidden for the skill, or tools without exact skill+label evidence. Ask which recommendations to enable and write accepted tool ids to `utilities.context_tools.enabled`. If metadata is unavailable, report a degraded note and continue.
- Report that follow-on skills select their own usable subset with `ai-factory aifhub-memory-tools select --from-project --command <skill> --json`; enabled config entries are not permission to use a tool unless they appear in `selected_tools`.
- When the recommender output includes enriched fields, include allowed command scopes, forbidden command scopes, command-specific permission, execution guidance, privacy caveat, and protected validation artifacts in the concise recommendation summary when relevant.
- Report the backward-compatible Graphify utility setting and `uv` availability only as compatibility context. If `utilities.graphify.enabled` is missing or `false`, Graphify may still be recommended only through local metadata; show manual setup commands only as explicit opt-in guidance: `uv --version`, `uv tool install graphifyy`, `graphify install`, and `graphify .`.
- If autonomous/subagent mode defaulted to legacy `ai-factory` because the artifact protocol question could not be asked, report OpenSpec-native mode selection as an open question/blocker.
- Report the active path set.
- In `openspec-native` mode, include the OpenSpec capability object, degraded reason when present, created/preserved skeleton directories, and the statement that OpenSpec skill installation was skipped by design.
- In `openspec-native` mode, explicitly report whether `.ai-factory/state`, `.ai-factory/qa`, and `.ai-factory/rules/generated` were created or preserved.
- Report what was invoked automatically versus what remains as manual next command.
- If DESCRIPTION is missing, first recommended command must use the selected runtime invocation style: `$aif` for `codex-app`, `/aif` for slash-command runtimes.
- When reporting next commands, use the selected runtime invocation style: `codex-app` runtime uses `$aif-explore`, `$aif-plan full`, `$aif-verify`, and other `$aif-*` skills; slash-command runtimes use `/aif-explore`, `/aif-plan full`, `/aif-verify`, and other `/aif-*` commands.
- After bootstrap, describe the current public workflow as starting with the runtime-specific explore or plan invocation, not legacy `/aif-new`.
- If a new plan is needed, recommend the runtime-specific plan command (`$aif-plan full` for `codex-app`, `/aif-plan full` for slash-command runtimes) as the canonical entrypoint.
- If handoff stage vocabulary is mentioned, explicitly mark it as a naming layer, not as slash commands.
- If `aif-done` is mentioned, describe it as the explicit post-verify finalizer using the selected runtime invocation style, not as a legacy workflow alias.

## Config v1 Schema

Common fields:

```yaml
language:
  ui: russian                    # Communication language
  artifacts: russian             # Generated artifacts language
  technical_terms: keep          # keep | translate | mixed

workflow:
  auto_create_dirs: true
  plan_id_format: slug
  analyze_updates_architecture: true
  architecture_updates_roadmap: true
  verify_mode: normal

rules:
  base: .ai-factory/rules/base.md
  # area rules added by planning when needed

utilities:
  graphify:
    enabled: false
    uv_check: uv --version
    install: uv tool install graphifyy
    activate: graphify install
    report_command: graphify .

agent_profile: default
```

Legacy AI Factory-only profile:

```yaml
aifhub:
  artifactProtocol: ai-factory

paths:
  description: .ai-factory/DESCRIPTION.md
  architecture: .ai-factory/ARCHITECTURE.md
  context: CONTEXT.md
  roadmap: .ai-factory/ROADMAP.md
  research: .ai-factory/RESEARCH.md
  plans: .ai-factory/plans
  specs: .ai-factory/specs
  rules: .ai-factory/rules
```

OpenSpec-native profile:

```yaml
aifhub:
  artifactProtocol: openspec
  openspec:
    root: openspec
    installSkills: false
    validateOnPlan: true
    validateOnImprove: true
    validateOnVerify: true
    statusOnVerify: true
    archiveOnDone: true
    useInstructionsApply: true
    compileRulesOnSync: true
    validateOnSync: true
    requireCliForPlan: false
    requireCliForImprove: false
    requireCliForVerify: false
    requireCliForDone: true
    requireGeneratedRulesForVerify: false
    requireGeneratedRulesForDone: true
    requireRulesPassForVerify: false
    requireRulesPassForDone: true
    requireSpecCoverageForVerify: false
    requireSpecCoverageForDone: true
    allowWarnOnDone:
      rules: false
      coverage: false
      openspecStatus: true

paths:
  description: .ai-factory/DESCRIPTION.md
  architecture: .ai-factory/ARCHITECTURE.md
  context: CONTEXT.md
  roadmap: .ai-factory/ROADMAP.md
  research: .ai-factory/RESEARCH.md
  plans: openspec/changes
  specs: openspec/specs
  rules: .ai-factory/rules
  state: .ai-factory/state
  qa: .ai-factory/qa
  generated_rules: .ai-factory/rules/generated
```

## Rules

- Use evidence over assumptions.
- Create/update `config.yaml` and `rules/base.md` first.
- Use OpenSpec-native mode only when explicitly requested, when existing config has `aifhub.artifactProtocol: openspec`, or when the user selects `OpenSpec-native` in the first-bootstrap artifact protocol question.
- Do not write a missing config with a default artifact protocol before first-bootstrap artifact protocol resolution completes.
- In OpenSpec-native mode, use `detectOpenSpec()` from `scripts/openspec-runner.mjs` when available and treat missing or unsupported CLI as degraded capability, not failure.
- In OpenSpec-native mode, AIFHub skills may request OpenSpec validation, status, instructions, and archive through `scripts/openspec-runner.mjs`; never install or depend on OpenSpec slash commands.
- In OpenSpec-native mode, use or recommend `openspec init --tools none` only for compatible CLI environments.
- Never install OpenSpec skills, slash commands, dependencies, or manifest entries.
- Never treat missing OpenSpec validate/archive capability as bootstrap failure; report it as degraded OpenSpec capability and continue with the configured runtime/generated path layout.
- Never generate DESCRIPTION directly in this skill.
- If DESCRIPTION is missing, suggest the selected runtime invocation for `aif` first (`$aif` for `codex-app`, `/aif` for slash-command runtimes).
- Follow workflow flags to suggest or initiate the selected runtime invocation for `aif-architecture` and `aif-roadmap`.
- Create `rules/base.md` with project-specific rules, not generic advice.
- Do NOT create optional area rules — planning owns those when needed.
- Ensure all directory-valued config paths exist; never create file-valued paths such as `paths.context` as directories.
- Keep the result concise and repository-specific.

## Example Requests

- "Bootstrap AI Factory config for this project."
- "Initialize project context and run required core skills."
- "Настрой конфигурацию AI Factory."
- "Create project rules."
- "Initialize config.yaml and rules, then suggest core commands for DESCRIPTION/ARCHITECTURE/ROADMAP."
