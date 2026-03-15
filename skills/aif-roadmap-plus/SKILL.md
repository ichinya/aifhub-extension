---
name: aif-roadmap-plus
description: Create or update `.ai-factory/ROADMAP.md` with an evidence-based maturity audit across project slices. Use for roadmap requests, progress reviews, or maturity checks.
---

# AIF Roadmap Plus

Create or update `.ai-factory/ROADMAP.md` with a slice-based maturity assessment.

## Workflow

1. Load context first.
   - Read project language memory first from `AGENTS.md`, then `CLAUDE.md`, then `.ai-factory/RULES.md`.
   - Treat only explicit localization markers as saved memory. In `AGENTS.md` or `CLAUDE.md`, use a dedicated `## Interaction Preferences` section with `Default reply language:` and optional `Default artifact language:` lines.
   - Never treat tech-stack fields such as `Language: TypeScript`, the current conversation language, or OS locale as a saved project language.
   - If the explicit localization markers are missing, asking is mandatory before analysis or roadmap generation.
   - Use the same language for replies and artifacts by default unless the user explicitly wants a split.
   - Read `.ai-factory/DESCRIPTION.md` and `.ai-factory/ARCHITECTURE.md` when present.
   - Read the current `.ai-factory/ROADMAP.md` before editing it.
   - If the user explicitly changes the project language, update the same project memory file before finishing.

2. Decide the mode from the user request.
   - Use default mode for new roadmap generation or general roadmap updates.
   - Use check mode when the user asks to verify, re-audit, or compare the roadmap against the current repository.

3. Analyze the repository.
   - Use [references/slice-checklist.md](references/slice-checklist.md) to inspect all required slices.
   - Treat git history as supporting context only, never as sole proof of completion.
   - Preserve manual notes when they still match the codebase.

4. Write `.ai-factory/ROADMAP.md`.
   - Follow [references/roadmap-template.md](references/roadmap-template.md).
   - Mark a slice `done` only with concrete proof.
   - Prefer `partial` over optimistic grading.

5. Report the outcome.
   - Summarize the strongest areas, critical gaps, and any status changes.
   - In check mode, call out regressions explicitly.

## Rules

- Use files and configs as primary evidence.
- Keep slice statuses independent.
- Make next steps specific and actionable.
- Do not hide uncertainty; explain missing or unclear evidence.
- Keep the reply language and artifact language aligned with the saved project preference unless the user explicitly overrides them.

## Example requests

- "Create a project roadmap from the current codebase."
- "Check whether `.ai-factory/ROADMAP.md` still matches the repo."
- "Проверь зрелость проекта и обнови roadmap."
