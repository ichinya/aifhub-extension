---
name: aif-analyze
description: Analyze the current repository and create or refresh `.ai-factory/DESCRIPTION.md` from code evidence. Use when project context is missing or the user asks for a repo overview.
---

# AIF Analyze

Analyze the current project and create or update `.ai-factory/DESCRIPTION.md`.

## Workflow

1. Resolve localization.
   - Treat the language as a project-level preference, not a user-level global setting.
   - Read project memory in this order: `AGENTS.md`, then `CLAUDE.md`, then `.ai-factory/RULES.md`.
   - Treat only explicit localization markers as saved memory. In `AGENTS.md` or `CLAUDE.md`, use a dedicated `## Interaction Preferences` section with `Default reply language:` and optional `Default artifact language:` lines.
   - Never treat tech-stack fields such as `Language: TypeScript`, the current conversation language, or OS locale as a saved project language.
   - If the explicit localization markers are missing, asking is mandatory before repository inspection or artifact generation. Ask one question: "What language should I use in this project?"
   - Persist the answer back to the project by updating the existing memory file. If no memory file exists, prefer `AGENTS.md`, then `CLAUDE.md`, then create `.ai-factory/RULES.md`.
   - Use the same language for replies and generated artifacts by default.
   - Only split communication language and artifact language when the user explicitly asks for different values.
   - Keep file names, commands, and identifiers in English.

2. Inspect the repository.
   - Use [references/project-scan-checklist.md](references/project-scan-checklist.md) as the scan order.
   - Read existing `.ai-factory/*` context files before writing new content.
   - Prefer direct evidence from manifests, source layout, config files, and project docs.

3. Write `.ai-factory/DESCRIPTION.md`.
   - Follow [references/description-template.md](references/description-template.md).
   - Update the existing file in place when it already exists.
   - Mark unknown or unsupported claims as unclear instead of guessing.

4. Finish with a short handoff.
   - Use the configured communication language for the reply.
   - Mention `.ai-factory/DESCRIPTION.md`, then suggest `aif-architecture` and `aif-roadmap`.

## Rules

- Use evidence over assumptions.
- Do not add implementation tasks, architecture decisions, or skill-install advice.
- Create or update only `.ai-factory/DESCRIPTION.md`, except when you need to persist the project language in `AGENTS.md`, `CLAUDE.md`, or `.ai-factory/RULES.md`.
- Keep the result concise and repository-specific.

## Example requests

- "Analyze this repo and create `.ai-factory/DESCRIPTION.md`."
- "Refresh the project context before architecture work."
- "Собери описание проекта по коду."
