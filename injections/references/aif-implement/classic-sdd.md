# Classic implementation details

### Legacy AI Factory-only mode

When OpenSpec-native mode is not enabled, preserve the existing legacy companion plan workflow.

After the owning classic workflow establishes a complete pair, apply the persistent execution contract in this reference and the shared durable task coordination rules. Ordinary status/history/current-task updates are projected out of execution identity; canonical task, policy and binding changes still invalidate it. Helper admission never repairs a missing companion or substitutes a retained OpenSpec tree.

Resolve all of these inputs to one active plan pair before execution starts:

- `.ai-factory/plans/<plan-id>.md`
- `.ai-factory/plans/<plan-id>/`
- `task.md`, `context.md`, `rules.md`, `verify.md`, `status.yaml`, or `explore.md` inside a plan folder

If only the folder exists, create the missing companion plan file first and record the migration event in `status.yaml.history`.

Legacy AI Factory-only workflow rules:

- `/aif-implement` is the canonical execution command for this extension workflow.
- When no plan exists yet, route the user through `/aif-plan full "<task>" -> /aif-improve`.
- `/aif-implement` owns git strategy resolution and must persist `execution.git.*` in `status.yaml`.
- `/aif-implement` also owns `execution.mode`, `execution.runtime`, and `execution.subagent` updates.
- After tasks complete, route to `/aif-verify`; a passing verification leaves the plan ready for optional `/aif-done` finalization.
- Do not route users to deprecated workflow aliases or legacy `*-plus` command names.

### Subagent Compatibility

When checking optional Claude worker availability in Legacy AI Factory-only mode, support both current and legacy filenames:

- prefer `.claude/agents/implement-coordinator.md`
- support `.claude/agents/implement-worker.md`
- support legacy `.claude/agents/implementer.md`
- support legacy `.claude/agents/implementer-isolation.md`

When persisting `execution.subagent`, allow:

- `implement-coordinator`
- `implementer`
- `implementer-isolation`
- `null`

Prefer `implement-coordinator` when available.

### Execution Metadata

- Preserve sibling keys when updating `execution.*`.
- In Legacy AI Factory-only mode, record git-strategy decisions, runtime changes, legacy upgrades, and mode switches in `status.yaml.history`.
- In OpenSpec-native mode, write runtime state only under `.ai-factory/state/<change-id>/`.
- When the implementation flow needs a manual checkpoint, the next command is `/aif-verify`, not a deprecated finalize alias.

### Compatibility Note

If historical docs or plan notes still mention `aif-implement-plus`, interpret that as `/aif-implement`.

#### Persistent execution and worker result acceptance

For both configured OpenSpec and complete classic plans after marker-first classification, use the installed `ai-factory aifhub-execution <action> --json` helper with a JSON object on stdin. Read the installed extension's `docs/workflow-mechanics.md` for payload contracts and follow the durable execution section of `skills/shared/TASK-COORDINATION.md`. This supporting execution state is separate from SessionBrief context compilation and authoritative Handoff/QA gates. The helper selects effective paths/tools, requires a complete classic pair, and delegates valid ultra before writing state.

Apply the service-mechanics boundary in TASK-COORDINATION.md: extract and propagate helper JSON fields through the existing helper/direct tool path, without a separate AI worker. Preserve the recorded actor, current version, exact digests, freshness checks and parent decision for every transition.

Include the selected execution form and its short reason in the existing dispatch manifest or assignment/preflight notes before admission. Keep helper payloads unchanged. Select eligible low-risk same-shape items through the bounded batch policy; keep shared-interface, overlapping-file, unresolved-dependency or different-risk work coupled/serial or report its exact blocker.

Before selecting the next group, reconcile available observed setup/orientation/integration costs with the previous execution-form reason. Keep estimates and unavailable measurements explicit, and preserve all required checks and independent roles.

For authorized parallel implementation in host-provided worktrees, follow `skills/shared/ISOLATED-EXECUTION.md` and the installed extension's `docs/isolated-execution.md`. Register fresh single-task worker runs as one independent group before edits. Workers use ordinary execution actions in their own roots; the parent uses `isolation-*` in the integration root, observes actual worker stops, and verifies each transfer against the combined tree. In this mode, local worker `accept` grants no checkbox authority: defer progress synchronization until `isolation-close` and fresh read-only `isolation-resume`, then apply only `closure.accepted`. Recover the existing group/worker records on re-entry. Worktree preparation, cancellation and cleanup belong to the host; absent capability keeps execution serial.

- Before editing or delegating, the parent calls `start` with one canonical `task_id`, a unique `run_id`, stable `owner` and `worker` labels, `role: implement`, and explicit project-relative file/directory `scope`. Include extra policy, ignored inputs, or an existing SessionBrief in `context_paths` when they influenced the assignment. Serialize coupled/shared-file tasks through fresh assignments. For an independent 2-5 item manifest use `batch-start` with exact files, expected changes, checks/fallbacks, dependencies and preflight references; one `run_id` owns the whole batch.
- On re-entry, call read-only `resume` before any edits or checkpoint writes. Reuse the saved task, scope, progress, and next step only when fresh. A stale checkpoint, context, revision, or evidence stops that run; the parent must reread current inputs and explicitly create a new assignment. Never overwrite a checkpoint merely to clear a stale result.
- After an in-scope work step, call `checkpoint` with the current `version`, worker `actor`, and `progress: {completed_steps, next_step, blocker?}`. Preserve the returned version. Keep notes concise and free of secrets or raw provider output. Write existing implementation traces through `writeExecutionTrace()` as before.
- A delegation admission handle means only that work was admitted. The worker submits `result` with an explicit terminal status, exact `changed_files`, observed check exit codes, and existing evidence paths. `completed` is not parent acceptance, a QA verdict, or permission to finalize.
- The parent reviews the actual diff and evidence, then calls `accept` with its actor label, the current version, and exact `result_digest`. Only a fresh completed result can become `accepted`. Worker results do not update canonical tasks; parent-owned checkbox updates happen after acceptance. Actor labels correlate assignments and do not authenticate another OS process.
- Local execution uses the same sequence with one actor label for owner and worker. Do not stage or commit while a run is active; HEAD, branch, index, context, and file contents are pinned. Concurrent writes in a shared worktree can invalidate another run; coordinate a quiet checkpoint/acceptance boundary.
- Failed, blocked, cancelled, or timed-out work stays terminal and unaccepted. Never infer completion from silence, a timeout, a duplicate reply, or an old successful check. Exact delivery retries are idempotent; conflicting replies fail closed.
- For a batch, the worker saves a final `checkpoint`, stops edits, reruns affected checks, and uses `batch-seal` to freeze per-item evidence at one final snapshot. It submits `batch-result` per task with the returned seal digest and current shared version. The parent reviews each item, uses `batch-accept` sequentially, and `batch-close` before updating only accepted checkboxes. Call `resume` immediately before synchronization; changed source/worktree/evidence forbids it. Omitted items remain unfinished; historical close replay is not current completion authority.
- A stale or interrupted dispatch is retired through exact read-only `inspect` and owner `interrupt`, preserving results and pending attempt history. Use the host's existing cancellation capability for the actual owned worker when available; record `stopped` only after observing exit with sanitized evidence. Otherwise record `running`/`unknown`, keep scope reserved, and use owner `stop-confirm` after later observation. These actions never cancel a process themselves. Do not clear orphan locks or bypass a pending journal; explicit v1 `upgrade` requires quiescent predecessor history and its inspected inventory digest.
- If this helper is absent in an older installation, report the capability fallback and use the existing local trace workflow without claiming durable resume or structured acceptance. A present helper's stale/conflict/error response is not permission to bypass it.

After parent acceptance, continue the existing read-only gates and `/aif-verify <change-id>` Handoff. These records must never replace Handoff gate summaries, QA evidence, or done receipts.

