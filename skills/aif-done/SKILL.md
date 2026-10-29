---
name: aif-done
description: Finalize a verified OpenSpec-native change or legacy AI Factory-only plan, prepare commit/PR summaries, and drive evidence-backed follow-ups.
argument-hint: "[change-id|plan-id] [--skip-specs] [--record-dirty-state]"
allowed-tools: Read Write Edit Glob Grep Bash(ai-factory aifhub-done-finalizer *) Bash(ai-factory aifhub-providers *) Bash(git status *) Bash(git branch --show-current) Bash(git diff *) Bash(git log *) Bash(git ls-files *) Bash(git rev-parse *) Bash(gh --version)
version: 1.5.0
author: ichi
---

# AIF Done

Read `skills/shared/TOOLS.md` from the AIFHub extension root before choosing artifact paths or lifecycle instructions.

AIFHub/Handoff finalization skill. Finalizes a verified OpenSpec-native change or a legacy AI Factory-only plan, drafts commit and PR summaries, drives evidence-backed governance follow-ups, and presents optional compact evolution proposals without starting evolution.

This skill does not duplicate `/aif-verify` — it runs **after** a passing verification (PASS or PASS-with-notes).

Resolve mode from `.ai-factory/config.yaml`:

- Follow `skills/shared/LANGUAGE-POLICY.md` before producing user-facing responses or generated artifacts.
- Use OpenSpec-native mode when `aifhub.tools.openspec: true`.
- Use Legacy AI Factory-only mode otherwise.

For either artifact protocol, only after classification permits non-ultra finalization, required references are read, and one safe change/plan ID is selected, run `ai-factory aifhub-providers done --change <id> --write --json`. Providers run only when their `aifhub.tools` switch is true; false or an omitted tool means a no-op. Enabled providers default to `policy: required`. A required provider blocker prevents finalization; optional provider failures require degraded notes. Provider failures are distinct from code/test failures. HLV validation may execute its project-configured gates; never run initialization, update, sync, or doctor `--fix`. Preserve HLV/OpenSpec/Lekalo canonical artifacts and keep provider summaries under `.ai-factory/qa/<id>/providers/`. OpenSpec readiness independently verifies current provider evidence before archive.

## Reference resolution and required reads

Resolve every reference from the AIFHub extension root (installed: `.ai-factory/extensions/aifhub-extension/`), never from a merged upstream skill. Missing required reference stops the governed action. All referenced rules remain mandatory.
Before any non-ultra provider run, evidence check, finalization, governance follow-up or normal output, read `skills/aif-done/references/finalization-contract.md`. Do not read it or append optional proposals to exact ultra handoffs.

## OpenSpec-native mode

Before resolving an active change, reading policy/QA/canonical artifacts, checking readiness, archiving, writing evidence, updating the managed roadmap block or drafting output, read `skills/aif-done/references/openspec-finalization.md` and the shared finalization contract.
Use only `ai-factory aifhub-done-finalizer --change <change-id> --json` after PASS/PASS-with-notes and current policy-accepted evidence. The finalizer always runs readiness before archive; refuse unverified changes and show exact `suggested_next.command` and `suggested_next.reason` on blockers.
Support `--skip-specs` for docs/tooling only and `--record-dirty-state` for explicit dirty-state recording. Never bypass readiness, manually move changes, or mutate base specs. `/aif-verify` does not archive.

## Legacy AI Factory-only mode

### Marker-first legacy ultra boundary

Before active-plan fallback, companion discovery, `status.yaml` reads, archive discovery, or any write:

1. Normalize the explicit or resolved project-relative plan entrypoint with `normalizeLegacyUltraEntrypoint()` from `scripts/legacy-ultra-verification-receipt.mjs` when it is a directory or `index.md` candidate.
2. Classify it with `classifyLegacyPlanShape()` from `scripts/legacy-plan-migration.mjs`. Marker validation precedes all filename heuristics.
3. For `ultra-valid`, call `evaluateLegacyUltraVerificationReceipt()` with the normalized entrypoint and current project root. The helper must recompute the bundle digest, current Git `HEAD` or bounded manual build id, and deterministic worktree digest before comparing the receipt.
4. Only `legacy-ultra-receipt-current-pass` may return the exact upstream handoff `/aif-archive <entrypoint>`. Do not execute the archive from `/aif-done`.
5. Missing, stale, malformed, wrong-entrypoint, wrong-revision, wrong-worktree, or non-`pass` receipts return the exact handoff `/aif-verify <entrypoint>`. Do not accept `warn`, `pass-with-notes`, timestamps, archive state, or an earlier conversational claim as a substitute for the current exact `pass` receipt.
6. For `ultra-invalid` or `collision`, fail closed with bounded `shape`, safe normalized `entrypoint`, and classifier/evaluator `code`; do not fall through to the classic plan workflow.
7. For `classic-pair` or `classic-folder-only`, continue with the classic workflow below. An unrelated directory is not a plan.

The marked ultra branch is read-only. It must not modify the bundle, create or synchronize companion files, create OpenSpec artifacts, update `status.yaml`, write QA/final evidence, update `.ai-factory/specs`, or write a new receipt. Receipt creation belongs only to `/aif-verify` and is confined to `.ai-factory/state/legacy-ultra-verification/<entrypoint-digest>.json`.

Before evaluating a marked ultra receipt or selecting its exact handoff, read `skills/aif-done/references/classic-finalization.md`; this read authorizes no writes. Keep the marker-first branch above read-only.
For `classic-pair` or `classic-folder-only`, before active-plan fallback, companion/status/archive reads, evidence checks, finalization or output, read that same classic reference and the shared finalization contract. Resolve configured paths and require passing verification; never consume marked ultra as classic.

## Finalization safety kernel

- Never finalize without passing verification; current readiness and provider gates remain mandatory.
- Preserve immutable request/research/reconciliation sources and existing user changes.
- Do not create commits or PRs automatically. `/aif-done` does not replace `/aif-commit`.
- Do not run `/aif-evolve` inside finalization. Optional proposals need durable evidence; separately authorized evolution keeps owner handoff and exact proposal_digest binding.
- Keep runtime under `.ai-factory/state/<change-id>/` and QA/final evidence under `.ai-factory/qa/<change-id>/`; never write runtime-only output in canonical changes.
- Local finalization cannot claim GitHub issue closure or PR merge. After archive, update only the managed `OpenSpec Change Lifecycle` block; failure returns `/aif-roadmap check` without rolling archive back.
- Report verification/readiness, dirty state, archive result, canonical artifacts, effective policy, evidence paths, commit/PR drafts and exact next owner handoffs. After success recommend `/aif-mode sync` and `/aif-commit`.

## Readiness and archive ownership

These checks apply after mode classification and required reference loading.

- Resolve exactly one safe change/plan ID; ambiguity never selects an arbitrary candidate.
- OpenSpec policy comes from `scripts/openspec-policy.mjs`, shared with verify and doctor.
- The latest final `aif-gate-result` must contain valid JSON, `gate: verify`, and pass or policy-accepted warn.
- Current `coverage.json`, generated rules and durable rules gate evidence remain distinct requirements.
- Apply each `allowWarnOnDone` flag to its own evidence category.
- `Code verification: PENDING` never establishes passing verification.
- Required provider blockers prevent finalization; optional failures require explicit degraded notes.
- Provider validation never authorizes initialization, update, sync or doctor `--fix`.
- The installed finalizer writes `done-readiness.json` before archive and refuses readiness blockers.
- Dirty state is blocking unless explicit recording is authorized through `--record-dirty-state`.
- Keep `--skip-specs` limited to docs/tooling; it still writes final evidence and summaries.
- Never add `--force`, `--no-validate`, `--skip-archive`, `--dry-run` or `--summary-only`.

## Final outputs and follow-ups

- Prepare commit/PR drafts from the selected scope and actual evidence.
- Classic finalization may refresh an existing archive without blindly duplicating it.
- Classic status becomes done only after passing verification and completed finalization.
- Preserve historical finalization/evolution records; do not rewrite them as new executions.
- Governance follow-ups require durable evidence and their owning workflow.
- Unavailable owner execution returns its exact handoff instead of a fabricated success.
- Optional evolution never creates an artificial learning backlog or blocks verified finalization.
- Do not dispatch an optional evolution intake worker or apply proposals during finalization.
- The marked ultra receipt branch keeps only its exact handoff output.
- Local archive success remains separate from external GitHub issue, PR and milestone state.
