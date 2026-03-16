---
name: aif-analyze
description: Analyze the current repository and create or refresh `.ai-factory/DESCRIPTION.md` from code evidence. Use when project context is missing or the user asks for a repo overview.
---

# AIF Analyze

Analyze the current project and create or update `.ai-factory/DESCRIPTION.md`.

## Workflow

1. Resolve localization.
   - This step is mandatory and must finish before any repository analysis.
   - Treat the language as a project-level preference, not a user-level global setting.
   - Read project memory in this order: `AGENTS.md`, then `CLAUDE.md`, then `.ai-factory/RULES.md`.
   - Treat only explicit localization markers as saved memory.
   - Valid memory in `AGENTS.md` or `CLAUDE.md` is a dedicated `## Interaction Preferences` section containing both `Preferred language:` and `Translation scope:` lines.
   - Valid memory in `.ai-factory/RULES.md` is both exact bullets `- Preferred language: ...` and `- Translation scope: ...`.
   - Never treat tech-stack fields such as `Language: TypeScript`, the current conversation language, or OS locale as a saved project language.
   - If the explicit localization markers are missing or incomplete, asking is mandatory before repository inspection or artifact generation. Do not infer the answer.
   - Ask question 1 exactly as the project language selector.
   - The language options must always include `original (English)` and `russian`.
   - Add one context-derived language option only when strong evidence exists, for example the dominant natural language of existing project docs or an explicit user request such as Thai.
   - Ask question 2 exactly as the translation-scope selector with these options: `communication only`, `communication and artifacts`, `artifacts only`.
   - Persist both answers back to the project by updating the existing memory file. If no memory file exists, prefer `AGENTS.md`, then `CLAUDE.md`, then create `.ai-factory/RULES.md`.
   - If the translation scope excludes artifacts, keep generated artifacts in the original project language.
   - If the translation scope includes artifacts, generate them in the preferred language.
   - Keep file names, commands, and identifiers in English.

2. Inspect the repository.
   - Use [references/project-scan-checklist.md](references/project-scan-checklist.md) as the scan order.
   - Read existing `.ai-factory/*` context files before writing new content.
   - Prefer direct evidence from manifests, source layout, config files, and project docs.

3. Write `.ai-factory/DESCRIPTION.md`.
   - Follow [references/description-template.md](references/description-template.md).
   - Update the existing file in place when it already exists.
   - Mark unknown or unsupported claims as unclear instead of guessing.
   - Create or update only `.ai-factory/DESCRIPTION.md` as the analysis artifact.
   - Do not create `.ai-factory/ROADMAP.md`.
   - Do not generate skill recommendations.
   - Do not install skills or suggest MCP setup as part of the artifact.

4. Finish with a short handoff.
   - Use the saved scope plus preferred language for the reply.
   - Mention `.ai-factory/DESCRIPTION.md`, then suggest `aif-architecture` and `aif-roadmap`.

## Rules

- Use evidence over assumptions.
- Do not add implementation tasks, architecture decisions, or skill-install advice.
- Create or update only `.ai-factory/DESCRIPTION.md`, except when you need to persist the project localization preference in `AGENTS.md`, `CLAUDE.md`, or `.ai-factory/RULES.md`.
- Localization memory is valid only when both the language and translation scope markers are present.
- Keep the result concise and repository-specific.

## Example requests

- "Analyze this repo and create `.ai-factory/DESCRIPTION.md`."
- "Refresh the project context before architecture work."
- "Собери описание проекта по коду."
