# Isolated implementation and serial integration

Use from the `/aif-implement` coordinator only when parallel implementation is authorized, the host can provide separate owned Git worktrees and worker handles, and the installed execution helper supports `isolation-*` actions. Preserve mode/marker classification, conflict preflight, task ownership and project policy. A normal task or same-shape single-worker batch keeps its existing path. This policy supplies no new host, provider, automatic worktree creation, process cancellation or publication permission.

Read [isolated execution mechanics](../../docs/isolated-execution.md) for exact payloads, recovery and limits. Resolve that guide and the helper from the installed extension, not from files invented in the consumer project. A missing capability keeps execution serial; a present helper's rejection must not be bypassed.

## Prepare one independent group

Select up to five unfinished implementation tasks from the same canonical source after checking file and interface dependencies. Name each task's exact files, required completed producers and expected checks in the existing assignment/preflight notes. Dependencies within the proposed group and overlapping files require serial work. File separation alone does not prove independence.

Use the host's existing worktree capability and preserve existing workers on resume. Each worktree must belong to the same Git repository, have its own Git directory, and reproduce the coordinator's exact HEAD, index, source/config context and working-tree bytes before admission; branches may differ. Account for dirty files, checkout line endings, filters, ignored context and configured paths. Copy only the already permitted source/context needed for that assignment, preserving its identity. Do not copy execution records, QA receipts, credentials or arbitrary ignored directories to make a check pass; do not install or initialize optional providers. If the host cannot materialize a compatible snapshot, keep the work serial and report the missing capability.

Before creating any worker run, the parent should call read-only `isolation-preflight` with the planned `isolation-start` payload in the prepared integration root. It checks the same source, scope and baseline constraints without creating runs, locks or directories. `ready: true, admitted: false` is a preview: it gives no permission for worker edits, reserves nothing, and cannot replace the fresh checks at `start`/`isolation-start`. On an existing assignment, recover its saved state instead of rerunning preparation or duplicating runs.

The parent admits one existing `start` run in each worker worktree with the assigned canonical task, exact file scope and matching context paths. Register those fresh runs with `isolation-start` in the integration worktree before allowing worker edits. A registration failure is not dispatch authority: inspect the already created runs and either reuse compatible ones or retire them through existing recovery. Do not duplicate runs or clear their history.

## Execute in the assigned worktree

The implementation worker receives its exact worktree, admitted group/run, canonical task, allowed files, existing checks and return destination. It uses ordinary `resume`, checkpoints and `result` in that worktree. Keep HEAD/index unchanged; do not commit, switch branches, edit the coordinator checkout, update canonical checkboxes, accept results or start nested workers. Return findings and the exact result digest/version to the parent. A local passing check is a worker result, not an integration or QA verdict.

## Integrate one result at a time

The parent observes the owned worker's actual stop through the host and records sanitized evidence. Inspect its complete diff and checks, then use the existing `accept` in that worker worktree for the local result. In the coordinator worktree, use `isolation-apply` to transfer that exact accepted result. No second transfer starts while integration is pending.

Inspect the transferred diff and run the affected checks against the combined coordinator tree. Submit those actual observations with `isolation-accept`. If integration fails, preserve the failure evidence and use `isolation-reject` to restore only that transfer's recorded files, or return the unresolved case to the owning planner/fixer. Do not edit around a stale snapshot or import a worker's old test result as a fresh integration check. A coupled fix or changed task needs a fresh authorized assignment.

Keep the canonical checklist unchanged while the group is open. After every item has been integrated or retired with observed-stop evidence, run the final combined checks and `isolation-close`. Immediately call read-only `isolation-resume` to verify the closed snapshot/evidence, then synchronize only `closure.accepted` through existing task-progress rules. Unaccepted tasks stay unfinished. A historical replay never renews checkbox authority. Recompute the next ready group from the updated canonical tasks and actual integrated code.

## Recover or retire

On interruption, use `isolation-inspect` and the host's existing worker/session records. An unfinished file transaction returns its exact recovery input; replay that operation only after inspecting current custody. A third file image, source drift, evidence drift or orphan lock blocks automatic recovery. Never remove locks based on age, PID or silence.

For an unfinished worker, use the existing worker `inspect`/`interrupt`/`stop-confirm` contract before `isolation-retire`. If the group cannot continue, stop every owned worker and use `isolation-abandon` with observed-stop evidence. Abandonment preserves all current code and journal history, reports retained changes, and grants no completion authority; reconcile those changes before a new assignment. It does not roll back arbitrary user edits or confirm process death itself.

Only the host/owner may clean up worktrees after actual worker termination, reconciliation and preservation of useful diffs, ignored data and evidence. No isolation helper removes a worktree, branch or execution history. Existing `/aif-verify`, `/aif-done`, commit and publication ownership remain unchanged.
