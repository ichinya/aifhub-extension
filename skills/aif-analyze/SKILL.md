---
name: aif-analyze
description: Bootstrap project context. Resolves localization and stack, creates/updates config.yaml and rules/base.md, then checks DESCRIPTION and guides core skill execution.
version: 0.7.0
author: ichi
---

# AIF Analyze

Bootstrap project context for AI Factory. This skill prepares configuration and rules, then checks core artifacts and guides the next core skills.

## Ownership Boundary

| Artifact | Owner | This Skill |
|----------|-------|------------|
| `config.yaml` | **aif-analyze** | Creates/updates |
| `rules/base.md` | **aif-analyze** | Creates if missing |
| `DESCRIPTION.md` | core `/aif` | Checks existence, suggests `/aif` if missing |
| `ARCHITECTURE.md` | core `/aif-architecture` | Initiates based on workflow flag |
| `ROADMAP.md` | core `/aif-roadmap` | Initiates based on workflow flag |

## Workflow

### Step 1: Resolve Localization

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
2. Read `extension.json` to get `compat.ai-factory` semver range
3. If both exist, compare:
   - If version satisfies range → continue normally
   - If version does NOT satisfy range → output warning:

```
⚠️ Compatibility Warning

ai-factory {installed_version} несовместим с extension (requires {compat_range})

Рекомендации:
- Обновите ai-factory до совместимой версии
- Или обновите compat range в extension.json
```

4. Continue execution (warning only, do not block)

### Step 1.6: Check Legacy Workflow Aliases

If this project contains legacy skill-context directories under `.ai-factory/skill-context/` for deprecated `*-plus` workflow names:

then emit a non-blocking migration note:

```
ℹ️ Legacy Workflow Compatibility

This project still contains legacy skill-context for `aif-*-plus`.
Canonical commands are now:
- /aif-explore
- /aif-plan full
- /aif-improve
- /aif-implement
- /aif-verify
- /aif-fix

Если docs или handoff notes упоминают `Explore`, `New`, `Apply` или `Done`, трактуй их только как названия стадий.
Не подавай `/aif-new` или `/aif-apply` как текущие public commands.
`/aif-done` упоминай только как explicit post-verify AIFHub finalizer, а не как legacy alias или часть canonical public workflow.

Backward-compatible fallback is still supported, but renaming the skill-context folders is recommended.
```

Do not rewrite or delete those folders automatically in this skill.

### Step 2: Inspect the Repository

- Use [references/project-scan-checklist.md](references/project-scan-checklist.md) as the scan order.
- Read existing `.ai-factory/*` context files before writing new content.
- Prefer direct evidence from manifests, source layout, config files, and project docs.
- Note the tech stack for rules/base.md generation.

### Step 2.5: Resolve Bootstrap Mode

Resolve the bootstrap/config mode before creating directories:

- Use `openspec-native` mode when the user explicitly asks for `openspec-native`, `OpenSpec-native`, or OpenSpec artifact protocol bootstrap.
- Use `openspec-native` mode when an existing `.ai-factory/config.yaml` has `aifhub.artifactProtocol: openspec`.
- Otherwise use legacy `ai-factory` mode.
- Do not silently migrate a legacy AI Factory-only project to OpenSpec-native mode.
- Preserve existing config values. Add only missing keys required by the resolved mode.
- Record the resolved mode for the final handoff.

### Step 3: Create or Update config.yaml

- If config.yaml is missing, create it with v1 schema.
- If config.yaml exists, preserve existing values and add missing fields.
- Keep schema consistent with nested sections: `language`, `aifhub`, `paths`, `rules`, `workflow`.
- In legacy `ai-factory` mode:
  - Preserve the existing AI Factory-only path defaults.
  - Keep `paths.plans` at `.ai-factory/plans` unless an existing value says otherwise.
  - Keep `paths.specs` at `.ai-factory/specs` unless an existing value says otherwise.
- In `openspec-native` mode:
  - Ensure this config shape is present:

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
    requireCliForVerify: false
    requireCliForDone: true
```

  - Ensure canonical artifact paths are set or completed:

```yaml
paths:
  plans: openspec/changes
  specs: openspec/specs
  state: .ai-factory/state
  qa: .ai-factory/qa
  generated_rules: .ai-factory/rules/generated
```

  - Preserve `paths.description`, `paths.architecture`, `paths.roadmap`, `paths.research`, and `paths.rules` unless they are missing.
  - Do not install OpenSpec skills, slash commands, or dependencies.

Use [references/config-template.yaml](references/config-template.yaml) as reference.

### Step 3.5: Detect OpenSpec Capabilities

Run this step only in `openspec-native` mode, after config mode is resolved and before directory creation.

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
- Use [references/rules-base-template.md](references/rules-base-template.md) as scaffold.
- Fill placeholders with project-specific values, not generic advice.
- Do NOT create optional area rules (api.md, frontend.md, etc.) — planning owns those when the active plan needs them.
- If `.ai-factory/RULES.md` exists, treat it as additional project-level rules (do not overwrite it).

### Step 5: Ensure Directories Exist

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
- If missing: do not generate DESCRIPTION content in this skill; suggest running `/aif`.
- If DESCRIPTION exists and `workflow.analyze_updates_architecture: true`, suggest or initiate `/aif-architecture`.
- If `workflow.architecture_updates_roadmap: true`, suggest or initiate `/aif-roadmap`.
- If automatic invocation is not available in the current runtime, provide explicit next commands to the user in order.

### Step 7: Finish with Guided Handoff

- Use the saved scope plus preferred language for the reply.
- Mention created/updated files: `config.yaml`, `rules/base.md`, and artifact status (`DESCRIPTION.md`, `ARCHITECTURE.md`, `ROADMAP.md`).
- Report the resolved bootstrap mode.
- Report whether config values were created or preserved.
- Report the active path set.
- In `openspec-native` mode, include the OpenSpec capability object, degraded reason when present, created/preserved skeleton directories, and the statement that OpenSpec skill installation was skipped by design.
- In `openspec-native` mode, explicitly report whether `.ai-factory/state`, `.ai-factory/qa`, and `.ai-factory/rules/generated` were created or preserved.
- Report what was invoked automatically versus what remains as manual next command.
- If DESCRIPTION is missing, first recommended command must be `/aif`.
- После bootstrap описывай текущий public workflow как начинающийся с `/aif-explore` или `/aif-plan full`, а не с `/aif-new`.
- Если нужен новый plan, рекомендуй `/aif-plan full` как canonical entrypoint.
- Если упоминается handoff stage vocabulary, явно помечай её как naming layer, а не как slash commands.
- Если упоминается `/aif-done`, явно описывай его как explicit post-verify finalizer, а не как legacy workflow alias.

## Config v1 Schema

```yaml
language:
  ui: russian                    # Communication language
  artifacts: russian             # Generated artifacts language
  technical_terms: english       # Technical terms (always english)

aifhub:
  artifactProtocol: ai-factory   # ai-factory | openspec
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
    requireCliForVerify: false
    requireCliForDone: true

paths:
  description: .ai-factory/DESCRIPTION.md
  architecture: .ai-factory/ARCHITECTURE.md
  roadmap: .ai-factory/ROADMAP.md
  research: .ai-factory/RESEARCH.md
  plans: .ai-factory/plans
  specs: .ai-factory/specs
  rules: .ai-factory/rules
  state: .ai-factory/state
  qa: .ai-factory/qa
  generated_rules: .ai-factory/rules/generated

# OpenSpec-native path profile:
# paths.plans: openspec/changes
# paths.specs: openspec/specs

workflow:
  auto_create_dirs: true
  plan_id_format: slug
  analyze_updates_architecture: true
  architecture_updates_roadmap: true
  verify_mode: normal

rules:
  base: .ai-factory/rules/base.md
  # area rules added by planning when needed

agent_profile: default
```

## Rules

- Use evidence over assumptions.
- Create/update `config.yaml` and `rules/base.md` first.
- Use OpenSpec-native mode only when explicitly requested or when existing config has `aifhub.artifactProtocol: openspec`.
- In OpenSpec-native mode, use `detectOpenSpec()` from `scripts/openspec-runner.mjs` when available and treat missing or unsupported CLI as degraded capability, not failure.
- In OpenSpec-native mode, AIFHub skills may request OpenSpec validation, status, instructions, and archive through `scripts/openspec-runner.mjs`; never install or depend on OpenSpec slash commands.
- In OpenSpec-native mode, use or recommend `openspec init --tools none` only for compatible CLI environments.
- Never install OpenSpec skills, slash commands, dependencies, or manifest entries.
- Never treat missing OpenSpec validate/archive capability as bootstrap failure; report it as degraded OpenSpec capability and continue with the configured runtime/generated path layout.
- Never generate DESCRIPTION directly in this skill.
- If DESCRIPTION is missing, suggest `/aif` first.
- Follow workflow flags to suggest or initiate `/aif-architecture` and `/aif-roadmap`.
- Create `rules/base.md` with project-specific rules, not generic advice.
- Do NOT create optional area rules — planning owns those when needed.
- Ensure all directories from config paths exist.
- Keep the result concise and repository-specific.

## Example Requests

- "Bootstrap AI Factory config for this project."
- "Initialize project context and run required core skills."
- "Настрой конфигурацию AI Factory."
- "Create project rules."
- "Initialize config.yaml and rules, then suggest core commands for DESCRIPTION/ARCHITECTURE/ROADMAP."
