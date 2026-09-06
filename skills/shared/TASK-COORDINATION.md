# Task conflicts and bounded batches

Apply after artifact classification permits local implementation and the active canonical tasks have been read. This covers OpenSpec-native and classic legacy execution; ultra-valid delegation and invalid/collision stops take precedence. The `/aif-implement` coordinator owns the scan and task selection. A worker consumes only its assigned scope; this policy does not authorize delegation or nested workers.

## Before implementation or first worker dispatch

Scan the active plan's unfinished tasks and relevant completed producers before implementation edits or first worker dispatch. In the existing execution notes or normal response, identify the canonical task snapshot and record:

- One row per task pair sharing a file or interface: task IDs, shared surface, what each task produces/consumes, conflicting assumptions, and the supported ordering or resolution. Include interface dependencies across different files. Shared-file overlap alone does not block execution; compatible edits may be serialized.
- One row per task with its internal consistency result: created files versus referenced paths, test expectations versus implementation steps, and required inputs versus declared prerequisites. Name concrete contradictions, or record that none were found.

Resolve ordering from canonical requirements and actual repository evidence. For example, a producer returning `userId` and a consumer expecting `id` conflict even in separate files; two independent documentation edits in one file may only need serialization. Do not silently choose one of two contradictory requirements. Hold affected tasks, continue independent authorized tasks when possible, and route material plan/spec changes to the existing `/aif-plan` or `/aif-improve` owner. Record unresolved assumptions instead of declaring the scan clear.

Before dispatching a later task, confirm its inputs still match the scanned snapshot and completed work. Recheck affected rows after a plan, interface, or relevant diff changes; do not reuse stale clearance. Report the scan in existing runtime execution evidence (OpenSpec: `.ai-factory/state/<change-id>/`; classic: existing execution notes/history), never as a new canonical artifact, QA verdict, SessionBrief, receipt schema, or gate.

## Select one task, a coupled group, or a small same-shape batch

Keep the existing one-task or tightly coupled group default. The coordinator may explicitly select a small same-shape batch only when all items belong to the same active plan/change, are independently executable, have the same mechanical change and validation approach, and have comparable low risk. Dependencies within the proposed batch, different behavior/risk, or unresolved conflicts require splitting it. Do not combine unrelated work merely to reduce worker launches; a batch grants no additional write scope.

Give the worker a complete manifest before editing: each canonical task ID, exact project-relative files, expected change, and applicable check or existing no-test fallback. Expand file globs into the explicit intended list. Include relevant preflight resolutions. Keep the batch small enough to inspect every item and its diff in one bounded run; otherwise split it. Use existing task IDs without renumbering or rewriting canonical task intent. If the dispatch lacks these inputs, narrow to a fully specified authorized task or return the missing information to the coordinator before edits.

## Worker execution and coordinator reconciliation

Execute only the supplied manifest. Stop the affected item on a new dependency, conflict, or required out-of-scope edit and report it to the coordinator; do not add items or regroup work yourself. Continue other manifest items only while their independence remains supported.

Return one result per manifest item: task ID, actual files/diff, observed check or fallback evidence, and completed, unfinished, or blocked status. Review the diff against every expected change. An aggregate green command or worker success message does not prove every item was implemented. Before marking progress, the coordinator reconciles the original manifest with the actual diff and per-item evidence; an omitted result stays unfinished. If four of five items are complete, report four of five and leave the fifth unchecked/pending (or blocked with its reason). Mark only the selected items in progress, and only evidenced completed items complete, using the existing canonical checklist and runtime progress rules.

Keep `/aif-verify` authoritative and `/aif-done` responsible for finalization. Batching does not prove reduced cost or latency; make those claims only from measured runs.

## Durable execution, acceptance and interruption

When the installed execution helper is present, apply [persistent workflow mechanics](../../docs/workflow-mechanics.md) in both configured OpenSpec and complete classic plans. Ultra classification and exact upstream delegation happen before state admission. The helper does not repair incomplete plans. Keep the existing trace fallback only for a missing helper; a present helper error cannot be bypassed.

Use `start` for one canonical task and `batch-start` for an explicit 2-5 item independent implementation manifest. Coupled/shared-file tasks execute serially through fresh assignments; a fix attempt belongs to one task. Every manifest item supplies exact files, expected change, check or fallback, and declared dependencies. Provide sanitized preflight evidence paths; the coordinator remains responsible for semantic independence. One `run_id` identifies the entire batch. Overlapping active or unconfirmed interrupted scopes are reserved across all source IDs. Disjoint admission does not relax whole-worktree freshness.

The worker must successfully `resume` before entry/re-entry edits. It may checkpoint deliberate in-scope progress while active. Before `batch-seal`, save a final `checkpoint`, stop edits, and rerun checks whose sibling inputs changed. Seal the exact evidence inventory for every item, using an empty list when evidence is missing. Then submit per-item `batch-result` payloads at the shared `seal_digest`, using each returned version. No new evidence or edits may be added to a sealed assignment.

The parent reconciles each item and uses `batch-accept` with the current shared version, canonical task ID, seal and result digests. Close with `batch-close`; omitted/unaccepted items remain unfinished. Immediately before synchronizing checkboxes, use read-only `resume` to check the closed record's context/worktree/evidence against its closure receipt. Apply only its exact accepted set. Drift or interruption forbids progress synchronization; an exact historical close replay after canonical updates grants no new completion authority. Helper records never write canonical progress or QA.

On cancellation, timeout, abandonment or stale unaccepted output, first `inspect` the exact saved run to recover its current version and pending IDs. If the host exposes cancellation for the actual owned worker handle, request it through that existing capability and observe exit. Call owner `interrupt` with a recovery ID, reason and honest `execution_state`: `stopped` requires nonempty sanitized stop evidence; `running`/`unknown` keeps scope reserved. The helper does not own host handles or cancel processes. After a later observed exit, owner `stop-confirm` attaches evidence to that recovery and releases only its reservation. Never infer death from elapsed time, a PID, a result status or silence.

Interrupt reconciles pending attempts as `interrupted`, preserving their identities and all original results. Three failed hypotheses and three interrupted attempts are separate limits across run IDs. Read-only `attempt-check` reports counts/pending state; it cannot authorize the future code. `attempt-begin` checks both limits and the actual post-edit fingerprint. Return late worker output as retired history, never as progress. Reuse exact recovery/confirmation payloads for retries; do not replace their IDs to evade conflicts.

For predecessor v1 state, stop all old helpers, inspect the inventory, reconcile open assignments and use explicit owner `upgrade` with that digest. Never auto-upgrade or clear retry history. A prepared transaction permits only its exact replay. Orphan project/per-change locks remain `state-locked`; this workflow does not delete them or claim recovery from every host crash. Mixed-version dispatch is unsupported.
