[Back to Workflow Mechanics](workflow-mechanics.md) · [Back to Documentation](README.md)

# Isolated execution in the existing implementation workflow

The `/aif-implement` coordinator can run independent tasks in host-managed Git worktrees and integrate their results serially through the installed `ai-factory aifhub-execution isolation-* --json` actions. Each action consumes one JSON object on stdin, using the existing helper's output and exit-code contract. The [coordinator and worker policy](../skills/shared/ISOLATED-EXECUTION.md) controls dispatch, checks and task progress. The helper records state and transfers exact file images; the host provides worktrees, worker handles and observed process termination.

## Admission and ownership

Before creating worker runs, use `isolation-preflight` with the exact planned `isolation-start` payload shown below. It reads prepared worktrees, source/config context, HEAD/index/dirty baselines, prerequisites, scope reservations and existing locks without writing files, directories or runs. It rejects a planned run ID already in use; recover an existing assignment instead of creating a duplicate. A successful response has `schema: aifhub.isolated-preflight.v1`, `ready: true`, `admitted: false` and current input/context/worktree digests. This is a point-in-time preview, not an admission receipt or reservation. Ordinary worker `start` and parent `isolation-start` still recheck current state. Ultra delegates before examining worker paths; a failed preview leaves both checkouts unchanged.

One integration worktree admits one active group of 1–5 independent implementation tasks. Each has a different worktree in the same Git common repository, a fresh single-task execution v2 run, exact disjoint files, and dependencies that are already checked canonical tasks outside this group. The total scope is at most 100 files. Interface independence and the expected changes/checks must be established in preflight notes by the parent; disjoint paths alone cannot prove it.

Prepare workers through the host's existing worktree capability. Preserve their ownership and any useful dirty or ignored data. Before registering a group, all workers must reproduce the parent's HEAD, index, full source-tree content and executable bits, and canonical/config context. Branch names may differ. A clean checkout of HEAD is insufficient when the parent has dirty files. Checkout line endings, Git filters and ignored inputs must also agree. Explicit `context_paths` must match across all runs. Sources under configured paths keep their existing identities. A mismatched source, context or baseline rejects admission before a group record is saved.

Materialize only already authorized source/context. Do not clone execution history or QA receipts into a worker to satisfy a digest. If the current change needs QA/SessionBrief context that the host cannot make available under existing ownership rules, use serial execution. No helper copies credentials, initializes optional tools or changes Git configuration. Exact files containing protected canonical/runtime paths, symlinks, hardlinks or aliases are rejected by the existing scope rules.

In each worker root, the parent first calls ordinary `start` using the canonical `task_id`, `role: implement`, matching `owner`, assigned `worker`, unique `run_id` and exact `scope` files. Each run must still be `version: 1`, `status: started` when the parent calls `isolation-start` in the integration root. Do not let workers edit before successful registration. Recover or retire pre-created runs if registration fails.

Example `isolation-start` payload (replace the absolute roots with host-owned worktrees):

```json
{
  "change_id": "add-widget",
  "group_id": "wave-1",
  "owner": "parent-session",
  "assignments": [
    {"task_id":"1.1","root":"C:/worktrees/widget-a","run_id":"task-a","worker":"worker-a","files":["src/a.js"],"dependencies":[]},
    {"task_id":"1.2","root":"C:/worktrees/widget-b","run_id":"task-b","worker":"worker-b","files":["src/b.js"],"dependencies":[]}
  ],
  "preflight_paths": [".ai-factory/state/add-widget/implementation/independence.md"]
}
```

Optional `context_paths` supplies the same extra immutable references as the worker starts. The response includes group version 1, canonical context/worktree digests, worker roots/run IDs and per-task status. The source selection rules match ordinary execution: configured OpenSpec and complete classic pairs are supported; valid ultra returns its exact upstream implementation handoff before local state. Invalid/colliding shapes stop. Historical group source bindings remain reserved even after closure or abandonment; ordinary starts, batch starts and upgrades respect that namespace.

## Worker result and serial integration

Workers use ordinary `resume`, `checkpoint` and `result` in their own worktrees. They keep HEAD/index unchanged and return result digests to the parent. They do not accept results, edit the integration tree, synchronize canonical checkboxes or dispatch nested workers.

The parent observes the actual owned worker's stop and saves sanitized evidence in the integration root. It inspects the worker diff and observed checks, then uses ordinary `accept` in that worker root. Local worker acceptance alone grants no group task-progress authority. In the integration root, submit `isolation-apply`:

```json
{
  "change_id":"add-widget","group_id":"wave-1","actor":"parent-session","version":1,
  "task_id":"1.1","result_digest":"<exact accepted worker result digest>",
  "stop_evidence":[".ai-factory/state/add-widget/implementation/worker-a-stopped.md"]
}
```

The helper rereads the accepted worker's source, history, code and evidence. It records typed transfer intent with before/after file images, then copies exactly the reported changes into the parent tree. It neither applies a shell patch nor commits/merges branches. Additions, tracked/untracked deletions and executable bits are represented explicitly. Existing parent permission bits are preserved except for executable changes; new files use 0644 permissions (Windows reports writable files as 0666) plus worker executable bits. The resulting group is `pending`; a second result cannot be imported yet. Successful apply usually advances two versions because intent and completion are separately durable. Always use returned versions.

Inspect the combined diff and run affected checks in the integration root. Submit `isolation-accept` with a standard completed result payload under `verification`:

```json
{
  "change_id":"add-widget","group_id":"wave-1","actor":"parent-session","version":3,"task_id":"1.1",
  "verification":{
    "result_id":"integrated-a","status":"completed","changed_files":["src/a.js"],
    "checks":[{"name":"combined widget behavior","exit_code":0}],
    "evidence":[".ai-factory/state/add-widget/implementation/integrated-a.md"]
  }
}
```

Here `changed_files` is exactly this transfer's changed set. The helper validates exit codes and hashes referenced observations against the integrated snapshot. It does not execute those checks or authenticate actor labels. Record a truthful existing no-test `fallback` if no automated check is applicable; project-required checks remain required. Failed checks cannot produce completed acceptance. Use distinct evidence paths for later observations: changing saved preflight, stop or verification evidence makes the group stale.

If the integrated result fails, save the failure evidence and call `isolation-reject` with the current common fields, `task_id` and a bounded `reason`. It restores only the saved file images from that transfer. Rejected work stays unfinished; a corrected task requires a fresh assignment after reconciling/closing the group. Do not mutate imported or unrelated files to force acceptance. Such drift blocks automatic transfer/reversal.

## Closure and task progress

After each acceptance/rejection, the next independent completed worker may be integrated. An unfinished worker must be stopped and retired through its ordinary `inspect`/`interrupt`/`stop-confirm` contract, then `isolation-retire` records its task ID, reason and nonempty `stop_evidence` in the group. The retirement action does not stop or retire the worker process/run itself.

Once every task is accepted, rejected or retired, rerun the final combined checks and call `isolation-close` with current common mutation fields and `verification`. Its `changed_files` must describe the entire parent diff from the group's baseline. The closure returns the exact `accepted` and `unfinished` task sets plus context, worktree and verification digests. Even a mixed outcome must report the unaccepted tasks explicitly.

Keep canonical checkboxes unchanged while the group is open. Immediately after close and before synchronization, call read-only `isolation-resume` with `change_id` and `group_id`. It verifies the closed source/tree/evidence. Only that fresh closure authorizes the parent to synchronize `closure.accepted` through existing progress rules. Then recompute readiness from the updated tasks and integrated code; dependent tasks belong to a later group with fresh baselines. Existing SessionBrief recompilation, `/aif-verify`, `/aif-done` and publication ownership remain in force.

## Recovery and limits

`isolation-inspect` reads historical state without claiming freshness. Its `recovery` field contains the exact input for an interrupted apply/reject transaction. Replaying that same operation resumes the saved transfer. `isolation-resume` refuses an incomplete transaction and otherwise checks the current parent context/tree/evidence. It neither launches workers nor restarts a transfer.

Every changing action requires `change_id`, `group_id`, parent `actor` and the current `version`; apply/accept/reject/retire also require `task_id`. Exact completed-operation retries return `historical: true` and the recorded operation version without reapplying files or renewing progress authority. Conflicting retries fail. Transfer intent is persisted before source writes; recovery first checks every target against its saved before/after images. A third image is never overwritten. Atomic file replacement uses staging under the execution runtime directory. Recovery can finish a partial multi-file operation; the whole group is not one filesystem transaction.

If source/evidence drift or an unexpected file image prevents continuation, inspect custody and stop all owned workers. `isolation-abandon` accepts the current common mutation fields, a `reason` and nonempty observed `stop_evidence`. It preserves current code and journal history, records retained changes and releases the group reservation. It works during a partial transfer and after source drift, grants no completion authority and cannot be resumed. Reconcile retained work before any new assignment. It does not prove worker death or remove worktrees.

Records live at `.ai-factory/state/<change-id>/execution/isolation/<group-id>.json`; transfer staging lives under `execution/isolation-transfers/<group-id>/`. Typed journal replay validates state transitions and image/result correspondence inside the existing checksummed store. Runtime records and staging are forbidden as context/evidence. At most 100 historical groups are scanned per integration checkout; stored image data is limited to 8 MiB of base64 text per group. Large/generated files should use serial execution. Unknown actions/fields, corrupt histories, scope collisions and stale baselines stop with bounded error codes.

The parent project lock serializes all isolation mutations with ordinary execution admission. An active group blocks ordinary parent runs; existing active runs or pending ordinary transactions block group admission. Orphan locks remain blocked and are never removed based on age/PID/silence. All helpers must be the same compatible version and cooperative; this is not an OS security boundary against other writers. Worker/result labels and stop notes are assertions from the host. The host alone owns process cancellation and any worktree cleanup after termination and data reconciliation.

The implementation supports bounded waves with completed prerequisites. It does not schedule an arbitrary DAG, create worktrees, supervise processes, auto-resolve semantic conflicts or publish code. Behavioral coverage in `scripts/isolated-execution.test.mjs` uses real temporary Git worktrees and actual Node fixture checks; it does not measure model quality or validate a full installed multi-agent host session.
