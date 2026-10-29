# Classic and marked ultra finalization

## Legacy AI Factory-only mode

Legacy AI Factory-only mode first separates marked upstream ultra bundles from classic AIFHub companion plans. The classic finalization contract remains based on `.ai-factory/plans/<plan-id>/` and `.ai-factory/specs/<plan-id>/`; it must never consume a marked ultra bundle.

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

### Classic precondition

- Active plan must have a passing verification state (`pass` or `pass-with-notes`).
- If verification has not run or verdict is `fail`, this skill stops and suggests running `/aif-verify` first.

### Classic workflow

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
   - evolution candidates worth reporting as compact proposals, separate from required governance.
2. Apply follow-ups only when the evidence exists:
   - Roadmap -> update through the roadmap owner or return an exact `/aif-roadmap` handoff.
   - Architecture -> update through the architecture owner or return an exact `/aif-architecture` handoff.
   - Rules -> update the project rules owner path or return an exact handoff if direct update is not safe in the current runtime.
3. If the current runtime cannot safely perform the owner update, do not silently skip it — return the exact next command/instruction instead.
4. Present compact evolution proposals under the optional evolution boundary above. Return separately authorized evolution to its owner workflow or an exact handoff; do not execute it inside finalization.
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
   - Compact evolution proposals presented or the exact `/aif-evolve` owner handoff returned. Report evolution as completed only when separately authorized execution actually succeeded.

