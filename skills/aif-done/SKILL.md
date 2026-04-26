---
name: aif-done
description: Finalize a verified OpenSpec-native change or legacy AI Factory-only plan, prepare commit/PR summaries, and drive evidence-backed follow-ups.
version: 1.2.0
author: ichi
---

# AIF Done

AIFHub/Handoff finalization skill. Finalizes a verified OpenSpec-native change or a legacy AI Factory-only plan, drafts commit and PR summaries, drives evidence-backed governance follow-ups, and can run or recommend evolution follow-ups.

This skill does not duplicate `/aif-verify` — it runs **after** a passing verification (PASS or PASS-with-notes).

Resolve mode from `.ai-factory/config.yaml`:

- Use OpenSpec-native mode when `aifhub.artifactProtocol: openspec`.
- Use Legacy AI Factory-only mode otherwise.

## OpenSpec-native mode

OpenSpec-native mode finalizes the verified change state without implementing archive integration from issue #33.

### Preconditions

- Resolve exactly one active change or explicit `<change-id>`.
- Read QA evidence from `.ai-factory/qa/<change-id>/`.
- Treat verification as passing only when QA evidence records `pass` or `pass-with-notes`.
- If verification has not run or verdict is `fail`, stop and suggest `/aif-verify` or `/aif-fix`.

### Canonical Context

Read canonical OpenSpec artifacts:

- `openspec/specs/**`
- `openspec/changes/<change-id>/proposal.md`
- `openspec/changes/<change-id>/design.md`
- `openspec/changes/<change-id>/tasks.md`
- `openspec/changes/<change-id>/specs/**/spec.md`

Read generated rules as derived guidance when present:

- `.ai-factory/rules/generated/openspec-merged-<change-id>.md`
- `.ai-factory/rules/generated/openspec-change-<change-id>.md`
- `.ai-factory/rules/generated/openspec-base.md`

Runtime state and QA evidence live outside canonical changes:

- `.ai-factory/state/<change-id>/`
- `.ai-factory/qa/<change-id>/`

### Archive Policy

- Do not silently archive OpenSpec changes through legacy `.ai-factory/specs`.
- Do not run `openspec archive <change-id> --yes` in this issue. Full archive integration belongs to issue #33 or later runtime integration.
- If the user requests archive/finalization before #33 exists, report that archive integration is deferred and prepare commit/PR/governance outputs from verified evidence only.
- Do not write runtime-only output into `openspec/changes/<change-id>/`.

### OpenSpec-Native Output

Normal output must report:

- selected `change-id`;
- precondition state and QA verdict;
- canonical artifacts inspected;
- generated rules state when relevant;
- runtime state and QA evidence paths;
- archive integration status: deferred to #33 unless a later runtime integration explicitly owns it.

## Legacy AI Factory-only mode

Legacy AI Factory-only mode preserves the verified plan finalization contract based on `.ai-factory/plans/<plan-id>/` and `.ai-factory/specs/<plan-id>/`.

### Precondition

- Active plan must have a passing verification state (`pass` or `pass-with-notes`).
- If verification has not run or verdict is `fail`, this skill stops and suggests running `/aif-verify` first.

### Workflow

#### Step 1: Validate Precondition

1. Resolve the active plan (same resolution logic as `/aif-implement`).
2. Read `status.yaml` and check `verification.verdict`.
3. If verdict is missing or not `pass`/`pass-with-notes`:
   - Stop with message: "Plan has not passed verification. Run `/aif-verify` first."
4. Check workspace state:
   - If `git status` shows uncommitted changes **outside** the current plan scope:
     - Stop and ask the user to confirm or clean up.
     - Only plan-related changes (files touched by the plan's implementation) are acceptable without confirmation.

#### Step 2: Archive Plan

1. Resolve archive path: `.ai-factory/specs/<plan-id>/`.
2. **Idempotency check:** If `.ai-factory/specs/<plan-id>/` already exists:
   - Treat the run as a refresh/finalize-again pass.
   - Rebuild `spec.md`, refresh the index entry, and regenerate commit/PR/follow-up outputs from current plan evidence.
   - If the archive came from legacy `/aif-verify` auto-archive behavior, adopt it instead of failing or blindly re-copying.
   - Inform the user that finalization is refreshing an existing archive.
3. If archive does not exist:
   - Copy plan folder contents (minus `status.yaml` execution metadata) into the archive.
   - Archive the companion plan file as `plan.md` alongside the folder artifacts.
4. Create or update `spec.md` summarizing what was implemented, if part of the current contract.
5. Update `.ai-factory/specs/index.yaml` with the new entry.

#### Step 3: Prepare Commit Message

1. Analyze all changes made under this plan.
2. Draft a conventional commit message summarizing the implementation.
3. Present the draft to the user for review.

#### Step 4: Prepare PR Summary (if applicable)

1. Check if a feature branch exists (branch != main/master).
2. If `gh` CLI is available:
   - Draft PR title and body based on plan scope and implementation evidence.
   - Present the draft; do not create the PR automatically.
3. If `gh` is not available:
   - Output manual PR instructions with the drafted title and body.

#### Step 5: Apply Evidence-Driven Follow-ups

1. Check plan for evidence of:
   - roadmap milestone completion or maturity movement;
   - new architecture decisions, boundaries, or modules;
   - new or modified durable project rules;
   - evolution candidates worth feeding into `/aif-evolve`.
2. Apply follow-ups only when the evidence exists:
   - Roadmap -> update through the roadmap owner or return an exact `/aif-roadmap` handoff.
   - Architecture -> update through the architecture owner or return an exact `/aif-architecture` handoff.
   - Rules -> update the project rules owner path or return an exact handoff if direct update is not safe in the current runtime.
3. If the current runtime cannot safely perform the owner update, do not silently skip it — return the exact next command/instruction instead.
4. Run `/aif-evolve` when the user explicitly asked for integrated finalization and the runtime can chain the action; otherwise propose it as the next step.
5. Never invent governance changes that are not supported by plan evidence.

#### Step 6: Mark Plan Done

1. Update `status.yaml`:
   - Set `status: done`.
   - Record finalization timestamp.
2. Output completion summary:
   - Archive path.
   - Commit message draft.
   - PR summary draft (or manual instructions).
   - Governance updates performed or exact handoffs prepared.
   - `/aif-evolve` action taken or recommended.

## Ownership Boundary

| Artifact | Owner | This Skill |
|----------|-------|------------|
| `openspec/changes/<change-id>/` | OpenSpec-native workflow | Reads only until #33 archive integration exists |
| `.ai-factory/qa/<change-id>/` | `/aif-verify` | Reads precondition and QA evidence |
| `.ai-factory/state/<change-id>/` | OpenSpec-native runtime | Reads finalization context when present |
| `.ai-factory/specs/<plan-id>/` | **aif-done** | Creates or refreshes on finalization |
| `.ai-factory/specs/index.yaml` | **aif-done** | Updates |
| `.ai-factory/plans/<plan-id>/status.yaml` | **aif-done** | Updates `status: done` |
| Commit/PR drafts | **aif-done** | Outputs to user |
| `.ai-factory/ROADMAP.md` | roadmap owner | Update only with plan-backed evidence; otherwise hand off |
| `.ai-factory/RULES.md` | project rules owner | Update only for durable plan-backed rules; otherwise hand off |
| `.ai-factory/ARCHITECTURE.md` | architecture owner | Update only with plan-backed evidence; otherwise hand off |

## Rules

- Never finalize a plan that has not passed verification.
- In OpenSpec-native mode, never silently archive through legacy `.ai-factory/specs`; report archive integration as deferred to #33.
- Never invent governance changes without evidence from the verified plan.
- When governance updates belong to another owner, use the owning path or return an exact handoff instead of silently skipping the change.
- Never auto-create a PR — always present drafts for user approval.
- If `gh` is unavailable, provide manual instructions instead of failing.
- Keep direct archival writes bounded to the plan status, specs directory, and specs index.
- Do not reintroduce `/aif-done` as the canonical upstream workflow step — this is an AIFHub/Handoff finalizer only.

## Example Requests

- "Finalize this plan."
- "Archive the verified plan."
- "Prepare commit and PR summary."
- "/aif-done"
