---
name: aif-roadmap-plus
description: Create or update `.ai-factory/ROADMAP.md` with an evidence-based maturity audit across project slices. Use for roadmap requests, progress reviews, or maturity checks.
---

# AIF Roadmap Plus

Create or update `.ai-factory/ROADMAP.md` with a slice-based maturity assessment.

## Workflow

1. Load context first.
   - Read project language memory first from `AGENTS.md`, then `CLAUDE.md`, then `.ai-factory/RULES.md`.
   - Treat only explicit localization markers as saved memory. In `AGENTS.md` or `CLAUDE.md`, use a dedicated `## Interaction Preferences` section with `Preferred language:` and `Translation scope:` lines.
   - Never treat tech-stack fields such as `Language: TypeScript`, the current conversation language, or OS locale as a saved project language.
   - If the explicit localization markers are missing or incomplete, asking is mandatory before analysis or roadmap generation.
   - Ask question 1 for the language. The options must always include `original (English)` and `russian`, plus a context-derived option when strong evidence exists.
   - Ask question 2 for the translation scope with these options: `communication only`, `communication and artifacts`, `artifacts only`.
   - If the translation scope excludes artifacts, keep generated artifacts in the original project language.
   - If the translation scope includes artifacts, generate them in the preferred language.
   - Read `.ai-factory/DESCRIPTION.md` and `.ai-factory/ARCHITECTURE.md` when present.
   - Read the current `.ai-factory/ROADMAP.md` before editing it.
   - If the user explicitly changes the project localization preference, update the same project memory file before finishing.

2. Decide the mode from the user request.
   - Use default mode for new roadmap generation or general roadmap updates.
   - Use check mode when the user asks to verify, re-audit, or compare the roadmap against the current repository.

3. Analyze the repository across these 11 slices.
   - Launch / Runtime
   - Architecture / Structure
   - Core Business Logic
   - API / Contracts
   - Data / Database / Migrations
   - Security / Auth / Secrets
   - Integrations / External Services
   - Quality / Tests / Validation
   - CI/CD / Delivery
   - Observability / Logs / Metrics
   - Documentation / DX
   - Use [references/slice-checklist.md](references/slice-checklist.md) for the detailed checklist behind each slice.
   - Status definitions are strict:
   - `done` means comprehensive evidence exists in the repository for that slice.
   - `partial` means some meaningful evidence exists, but important pieces are missing or incomplete.
   - `missing` means there is no meaningful implementation evidence, or only aspirational notes without working artifacts.
   - Evidence priority is strict:
   - Primary evidence is source code, config files, schemas, tests, pipelines, and automation definitions.
   - Secondary evidence is project documentation when it matches the repository state.
   - Git history is supporting context only and must never be the sole reason to mark a slice `done`.
   - Preserve manual notes when they still match the codebase.

4. Write `.ai-factory/ROADMAP.md`.
   - Follow [references/roadmap-template.md](references/roadmap-template.md).
   - Mark a slice `done` only with concrete proof.
   - Prefer `partial` over optimistic grading.
   - Treat the roadmap as an audit artifact, not as a generic task list.

5. Report the outcome.
   - Summarize the strongest areas, critical gaps, and any status changes.
   - In check mode, call out regressions explicitly.

## Rules

- Use files and configs as primary evidence.
- Keep slice statuses independent.
- Make next steps specific and actionable.
- Do not hide uncertainty; explain missing or unclear evidence.
- Keep the reply language and artifact translation behavior aligned with the saved project preference unless the user explicitly overrides them.

## Example requests

- "Create a project roadmap from the current codebase."
- "Check whether `.ai-factory/ROADMAP.md` still matches the repo."
- "Проверь зрелость проекта и обнови roadmap."
