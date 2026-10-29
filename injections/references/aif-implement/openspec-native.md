# OpenSpec implementation details

### OpenSpec-native mode

When `.ai-factory/config.yaml` declares `aifhub.tools.openspec: true`, `/aif-implement` executes implementation tasks for the active OpenSpec change.

#### SessionBrief binding

For changes with `## SDD Profile Inputs`, `.ai-factory/sdd-policy.json`, or existing SDD runtime artifacts, validate `ai-factory aifhub-session-brief status --change <change-id> --json` before editing. `buildImplementationContext()` also checks this binding before creating runtime directories and exposes `sessionBrief` with its digest and current brief. Prefer that brief as compact execution context, then resolve its exact canonical/task/spec/rules references at full fidelity for the selected task. The brief selects context; source, policy, and permissions remain authoritative.

Missing, stale, research, or invalid context stops implementation and returns the planning-owner compile handoff (or `/aif-explore` for research). Do not silently reuse the old brief or treat it as QA. Supply the exact consumed digest as `trace.sessionBriefDigest` to `writeExecutionTrace()`; its writer revalidates the binding before writes. Write the trace before marking canonical task checkboxes, then recompile after progress/sync changes before the next task or session. Material scope discoveries require the normal canonical planning-owner workflow before continuation.

When helpers are unavailable for an opted-in change, return the owner handoff; do not pretend the brief was validated. Existing unopted changes with no SDD runtime artifacts retain canonical filesystem fallback. A quick profile cannot disable project-required tests/security/review/human approval, migration/rollback, `/aif-verify`, or `/aif-done`. Briefs and profile decisions stay under `.ai-factory/state/<change-id>/`; protected validation artifacts are read in full, never semantically rewritten into the brief.

After implementation on an SDD-managed change, the planning owner or review side may run `ai-factory aifhub-plan-compliance check --change <change-id> --json`; the worker never writes `plan-compliance.json` itself and never treats the receipt as QA evidence. A `replan_required` or `blocked` outcome returns the remaining tasks to the planning owner before further edits. Tracer runtime artifacts under `.ai-factory/state/<change-id>/tracer/` never satisfy completion gates; only an owner `promote` decision followed by canonical updates and a fresh production SessionBrief moves the work forward.

For plan content, read only the canonical OpenSpec artifacts listed below. Do not inspect or mutate `.ai-factory/plans/**` after an OpenSpec change resolves.

Use `buildImplementationContext(options)` from `scripts/openspec-execution-context.mjs` when available before editing implementation files. Treat the returned resolver diagnostics, canonical artifacts, generated rules, OpenSpec apply instructions, runtime paths, warnings, and errors as the machine-readable implementation context. If the helper is unavailable, fall back to the explicit filesystem reads and runtime boundaries in this section.

Use shared vocabulary consistently: `OpenSpec-native mode`, `canonical OpenSpec change`, `active change`, `change-id`, `base specs`, `delta specs`, `generated rules`, `runtime state`, `QA evidence`, and `legacy AI Factory-only mode`.

Resolve the active change using `scripts/active-change-resolver.mjs` when available:

- Prefer an explicit `<change-id>` or `@openspec/changes/<change-id>` input when provided.
- Otherwise use `resolveActiveChange` behavior: current working directory, current branch mapping, current pointer, then single active change.
- Treat selected source, candidate list, warnings, and errors as user-visible implementation context.
- If an explicit or inferred `<change-id>` cannot be resolved as an OpenSpec change, check for matching legacy AI Factory plan artifacts through `detectMigrationNeed(options)` from `scripts/legacy-plan-migration.mjs` or equivalent read-only detection. If migration is suggested, do not auto-migrate. Show exactly:

```text
Found legacy AI Factory plan artifacts for `<change-id>` but no OpenSpec change at `openspec/changes/<change-id>`.
Run the legacy migration script with:

ai-factory aifhub-migrate-legacy-plans <change-id> --dry-run
ai-factory aifhub-migrate-legacy-plans <change-id>
```

Read canonical OpenSpec artifacts before editing implementation files:

- `openspec/specs/**`
- `openspec/changes/<change-id>/proposal.md`
- `openspec/changes/<change-id>/design.md`
- `openspec/changes/<change-id>/tasks.md`
- `openspec/changes/<change-id>/specs/**/spec.md`

Treat planning source sections as read-only implementation context:

- Use `## Original Request` as the raw intent anchor that explains why the change exists. Do not translate, normalize, rewrite, or use it instead of the executable `tasks.md`, design decisions, or requirements.
- When `proposal.md` contains `## Research Context`, use its embedded Active Summary and source revision as the authoritative committed scope.
- When `proposal.md` contains `## Requirements Reconciliation`, treat it as the committed requirement-consistency record: read the declared authority and cited decisions before dispatching work, and never mutate the section during implementation.
- For an embedded ultra source, pass its exact project-relative `RESEARCH.md` path to `resolveUltraResearchSource()` from `scripts/ultra-research-resolver.mjs` and consume only its structured `source`, `revision`, and `diagnostic`. This centrally revalidates the sibling marker/index/status/link and normalized Active Summary digest; do not implement local selection or hashing heuristics.
- Compare the exact regular or ultra source only for revision drift and optional rationale. Missing/invalid source, changed `Updated`, or changed normalized `SHA256` emits `WARN [research-drift] change-id=<change-id> source=<path> expected=<embedded revision> current=<live revision>` and continues from the embedded snapshot. Recency never selects a replacement source.
- Do not silently apply requirements from newer research, expand task scope, or mutate `## Original Request`, `## Research Context`, or `## Requirements Reconciliation` during implementation.
- Before marking a task `in_progress` or delegating it, reconcile the task's expected behavior against the authoritative requirements (canonical specs, `## Requirements Reconciliation`, committed `## Research Context`) and the `## Original Request` raw intent anchor. A clear unresolved conflict emits `ERROR [requirement-conflict]` and stops the task without edits, without marking it `in_progress`, and without merge, commit, review, or done signals; ambiguity that leaves the contract unclear emits `WARN [requirement-ambiguity]` and stops for clarification instead of guessing. Do not resolve a conflict by rewriting source requirements. When behavior depends on independent selectors, states, modes, or input shapes, confirm the task covers each applicable supported combination across validation, persistence, output/transition, and side effects; do not infer a restriction on one dimension from a rule about another.
- Keep credentials, raw provider output, and the full request/research bodies out of drift diagnostics and execution traces.

Hydrate runtime todo state from canonical OpenSpec tasks before editing implementation files:

- Treat `openspec/changes/<change-id>/tasks.md` as the source checklist.
- If the current runtime exposes a todo or plan tool, use it before editing. In Codex, use `update_plan` when available.
- Map checked tasks to `completed`, mark only the selected unfinished task, tightly coupled task group, or explicit small same-shape batch as `in_progress`, and leave other unfinished tasks as `pending`.
- If no todo or plan tool is available, report a concise task snapshot in the normal response and continue from canonical `tasks.md`.
- Report missing todo-tool support as a capability fallback, not as an implementation failure.
- Hydrating runtime todo state does not authorize broad task expansion; `/aif-implement` executes one task, one tightly coupled task group, or one explicit small same-shape batch validated under `skills/shared/TASK-COORDINATION.md`. Complete each item only after reconciling its expected change with the actual diff and evidence.

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

#### Roadmap lifecycle deferral

In OpenSpec-native mode, this section overrides the upstream roadmap completion step.

- `/aif-implement` must not edit the configured roadmap and must not mark a milestone, phase, slice, or managed lifecycle row complete, even when all implementation tasks are checked.
- It may read `## Roadmap Linkage` from the canonical proposal and report only the detected linkage fields plus the fact that lifecycle ownership is deferred.
- Implementation output must not claim roadmap completion or copy unrelated roadmap content.
- Route authoritative validation to `/aif-verify <change-id>`. Only after verification passes may `/aif-done <change-id>` own the successful finalization transition defined by the canonical change.

Read generated rules as derived implementation guidance when present:

- `.ai-factory/rules/generated/openspec-merged-<change-id>.md`
- `.ai-factory/rules/generated/openspec-change-<change-id>.md`
- `.ai-factory/rules/generated/openspec-base.md`

#### Evidence-driven development cycle

For each testable behavior change whose plan, project policy, or existing test conventions call for an automated check, use this bounded cycle before declaring the task complete:

1. **RED** - select or add the narrowest focused automated check, record it as `testCheck`, and run it before the production edit. Record `redResult` only after observing the expected behavioral failure; a syntax, fixture, dependency, or environment failure is not valid RED evidence.
2. **GREEN** - make the smallest in-scope production change that satisfies the focused check, rerun the same check, and record `greenResult`. Do not broaden implementation merely to make unrelated checks green.
3. **REFACTOR** - perform only safe cleanup justified by the task, rerun the same focused check, and record `refactorResult`. Skip cleanup when it would expand scope.

Persist `testCheck`, `redResult`, `greenResult`, `refactorResult`, and `fallbackDecision` through `writeExecutionTrace()` under `.ai-factory/state/<change-id>/implementation/`. For documentation-only work, generated artifacts, user-authorized no-test work, or a task with no useful automated check, do not fabricate RED evidence: record a bounded `fallbackDecision` and run the narrowest applicable non-test verification instead.

This cycle is supporting runtime evidence only. It does not write QA evidence, weaken project-specific test policy, or replace the authoritative `/aif-verify <change-id>` gate.

Execution trace and runtime state boundaries:

- Prefer `writeExecutionTrace(changeId, trace, options)` from `scripts/openspec-execution-context.mjs` for implementation traces.
- Write implementation progress, task execution traces, degraded capability notes, and runner metadata only under `.ai-factory/state/<change-id>/`.
- Do not write runtime-only files, summaries, validation output, or execution traces under `openspec/changes/<change-id>/`.
- Do not create legacy plan-folder execution artifacts in OpenSpec-native mode.
- QA evidence belongs under `.ai-factory/qa/<change-id>/` and is owned by `/aif-verify`; implementation may name the path in normal output but should not write verification results there.

Normal implementation responses should report:

- selected `change-id` and resolver source;
- canonical artifacts read;
- generated rules freshness or missing/stale `WARN`;
- runtime state path under `.ai-factory/state/<change-id>/`;
- task progress from the OpenSpec `tasks.md`;
- runtime todo hydration summary or task snapshot capability fallback;
- next step `/aif-verify <change-id>` when implementation is ready.

After implementation, optional read-only gates are:

- `/aif-rules-check`
- `/aif-review`
- `/aif-security-checklist`

The authoritative final verification remains `/aif-verify <change-id>`.

Do not install OpenSpec skills or slash commands.
Do not route users to deprecated workflow aliases or legacy `*-plus` command names.

