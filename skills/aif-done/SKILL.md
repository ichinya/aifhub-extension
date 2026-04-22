---
name: aif-done
description: Finalize a verified plan, archive artifacts to specs/, and prepare commit/PR summaries. Works after /aif-verify passes or when manually marking work as done.
version: 1.0.0
author: ichi
---

# AIF Done

AIFHub/Handoff finalization skill. Archives a verified plan, drafts commit and PR summaries, and suggests evolution follow-ups.

This skill does not duplicate `/aif-verify` — it runs **after** a passing verification (PASS or PASS-with-notes).

## Precondition

- Active plan must have a passing verification state (`pass` or `pass-with-notes`).
- If verification has not run or verdict is `fail`, this skill stops and suggests running `/aif-verify` first.

## Workflow

### Step 1: Validate Precondition

1. Resolve the active plan (same resolution logic as `/aif-implement`).
2. Read `status.yaml` and check `verification.verdict`.
3. If verdict is missing or not `pass`/`pass-with-notes`:
   - Stop with message: "Plan has not passed verification. Run `/aif-verify` first."
4. Check workspace state:
   - If `git status` shows uncommitted changes **outside** the current plan scope:
     - Stop and ask user to confirm or clean up.
     - Only plan-related changes (files touched by the plan's implementation) are acceptable.

### Step 2: Archive Plan

1. Resolve archive path: `.ai-factory/specs/<plan-id>/`.
2. **Idempotency check:** If `.ai-factory/specs/<plan-id>/` already exists (e.g. `/aif-verify` archived the plan without `--check-only`):
   - Skip copying plan folder contents — the archive is already present.
   - Still proceed to steps 3–5 below (spec.md merge, index update, commit/PR drafts).
   - Inform the user: "Plan already archived by `/aif-verify`. Skipping archive copy, proceeding with finalization."
3. If archive does not exist:
   - Copy plan folder contents (minus `status.yaml` execution metadata) into the archive.
   - Archive the companion plan file as `plan.md` alongside the folder artifacts.
4. Create or update `spec.md` summarizing what was implemented, if part of current contract.
5. Update `.ai-factory/specs/index.yaml` with the new entry.

### Step 3: Prepare Commit Message

1. Analyze all changes made under this plan.
2. Draft a conventional commit message summarizing the implementation.
3. Present the draft to the user for review.

### Step 4: Prepare PR Summary (if applicable)

1. Check if a feature branch exists (branch != main/master).
2. If `gh` CLI is available:
   - Draft PR title and body based on plan scope and implementation evidence.
   - Present the draft; do not create the PR automatically.
3. If `gh` is not available:
   - Output manual PR instructions with the drafted title and body.

### Step 5: Suggest Follow-ups

1. Check plan for evidence of:
   - Roadmap milestone completion → suggest `/aif-roadmap` update.
   - New architecture decisions → suggest `/aif-architecture` update.
   - New or modified rules → suggest rules update.
2. Suggest `/aif-evolve` for an evolution pass if applicable.
3. All follow-ups are suggestion-only — do not auto-edit `.ai-factory/ROADMAP.md`, `.ai-factory/RULES.md`, or `.ai-factory/ARCHITECTURE.md`.

### Step 6: Mark Plan Done

1. Update `status.yaml`:
   - Set `status: done`.
   - Record finalization timestamp.
2. Output completion summary:
   - Archive path.
   - Commit message draft.
   - PR summary draft (or manual instructions).
   - Suggested follow-ups.

## Ownership Boundary

| Artifact | Owner | This Skill |
|----------|-------|------------|
| `.ai-factory/specs/<plan-id>/` | **aif-done** | Creates on finalization |
| `.ai-factory/specs/index.yaml` | **aif-done** | Updates |
| `.ai-factory/plans/<plan-id>/status.yaml` | **aif-done** | Updates `status: done` |
| Commit/PR drafts | **aif-done** | Outputs to user |
| `.ai-factory/ROADMAP.md` | project owner | Suggestion only |
| `.ai-factory/RULES.md` | project owner | Suggestion only |
| `.ai-factory/ARCHITECTURE.md` | project owner | Suggestion only |

## Rules

- Never finalize a plan that has not passed verification.
- Never auto-edit project-level governance files (ROADMAP, RULES, ARCHITECTURE).
- Never auto-create a PR — always present drafts for user approval.
- If `gh` is unavailable, provide manual instructions instead of failing.
- Keep archival scope bounded: specs directory and index only.
- Do not reintroduce `/aif-done` as the canonical upstream workflow step — this is an AIFHub/Handoff finalizer only.

## Example Requests

- "Finalize this plan."
- "Archive the verified plan."
- "Prepare commit and PR summary."
- "/aif-done"
