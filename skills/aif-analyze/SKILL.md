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
- /aif-plan full
- /aif-implement
- /aif-improve
- /aif-verify
- /aif-fix

Если docs или handoff notes упоминают `Explore`, `New`, `Apply` или `Done`, трактуй их только как названия стадий.
Не подавай `/aif-new`, `/aif-apply` или `/aif-done` как текущий public workflow.

Backward-compatible fallback is still supported, but renaming the skill-context folders is recommended.
```

Do not rewrite or delete those folders automatically in this skill.

### Step 2: Inspect the Repository

- Use [references/project-scan-checklist.md](references/project-scan-checklist.md) as the scan order.
- Read existing `.ai-factory/*` context files before writing new content.
- Prefer direct evidence from manifests, source layout, config files, and project docs.
- Note the tech stack for rules/base.md generation.

### Step 3: Create or Update config.yaml

- If config.yaml is missing, create it with v1 schema.
- If config.yaml exists, preserve existing values and add missing fields.
- Keep schema consistent with nested sections: `language`, `paths`, `rules`, `workflow`.

Use [references/config-template.yaml](references/config-template.yaml) as reference.

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

- Create directories from config paths if missing:
  - `paths.plans` (typically `.ai-factory/plans`)
  - `paths.specs` (typically `.ai-factory/specs`)
  - `paths.rules` (typically `.ai-factory/rules`)

### Step 6: Check DESCRIPTION and Guide Core Skills

- Check if `.ai-factory/DESCRIPTION.md` exists.
- If missing: do not generate DESCRIPTION content in this skill; suggest running `/aif`.
- If DESCRIPTION exists and `workflow.analyze_updates_architecture: true`, suggest or initiate `/aif-architecture`.
- If `workflow.architecture_updates_roadmap: true`, suggest or initiate `/aif-roadmap`.
- If automatic invocation is not available in the current runtime, provide explicit next commands to the user in order.

### Step 7: Finish with Guided Handoff

- Use the saved scope plus preferred language for the reply.
- Mention created/updated files: `config.yaml`, `rules/base.md`, and artifact status (`DESCRIPTION.md`, `ARCHITECTURE.md`, `ROADMAP.md`).
- Report what was invoked automatically versus what remains as manual next command.
- If DESCRIPTION is missing, first recommended command must be `/aif`.
- После bootstrap описывай текущий public workflow как начинающийся с `/aif-explore` или `/aif-plan full`, а не с `/aif-new`.
- Если нужен новый plan, рекомендуй `/aif-plan full` как canonical entrypoint.
- Если упоминается handoff stage vocabulary, явно помечай её как naming layer, а не как slash commands.

## Config v1 Schema

```yaml
language:
  ui: russian                    # Communication language
  artifacts: russian             # Generated artifacts language
  technical_terms: english       # Technical terms (always english)

paths:
  description: .ai-factory/DESCRIPTION.md
  architecture: .ai-factory/ARCHITECTURE.md
  roadmap: .ai-factory/ROADMAP.md
  research: .ai-factory/RESEARCH.md
  plans: .ai-factory/plans
  specs: .ai-factory/specs
  rules: .ai-factory/rules

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
