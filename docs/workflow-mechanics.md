[Previous: Prime Agent evaluation](runtime-research/prime-agent/README.md) · [Back to README](../README.md)

# Persistent workflow mechanics

AIFHub records task execution against canonical inputs, accepts worker results individually, reconciles small sealed batches, and retires interrupted assignments without losing retry history. It also supports reversible skill-context evolution. These mechanisms extend the [Prime Agent evaluation](runtime-research/prime-agent/README.md); runtime adoption remains deferred. No Prime runtime, provider, Python kernel, or new slash-command workflow is installed.

The installed helpers are `ai-factory aifhub-execution <action> --json` and `ai-factory aifhub-evolution <action> --json`. Both consume one UTF-8 JSON object from stdin, write one JSON envelope to stdout, and keep stderr empty for handled errors. Exit codes: `0` success, `1` stale/conflicting/blocked operation, `2` invalid input/state or unavailable filesystem/Git. Unknown actions, fields, and flags fail closed. Input is limited to 1 MiB. Send JSON as data rather than interpolating it into a shell command.

The existing `/aif-implement`, `/aif-fix`, and `/aif-evolve` injections call these helpers. Their instructions and the Claude/Codex workers include the integration contract. An older installation without the execution helper can use the documented local trace fallback; it cannot claim durable resume or structured acceptance. Versioned evolution requires the helper before applying its proposal.

## Execution checkpoint

Execution v2 runs from the root of an initialized Git repository. Effective tools and paths select the task source before admission. An explicit tools mapping overrides the legacy artifact protocol; omitted tools are false. Missing config defaults to classic AI Factory. A retained OpenSpec directory never activates OpenSpec. HLV/Lekalo selection does not choose a task source or run a provider.

| Selected source | Required artifacts |
| --- | --- |
| OpenSpec | Effective changes root with existing `proposal.md` and `tasks.md`, resolved by the canonical active-change resolver |
| Classic AI Factory | Effective plans root with `<id>.md` and `<id>/{task.md,context.md,rules.md,verify.md,status.yaml}`; parent and task checklist must agree |
| Marked ultra | Exact `/aif-implement <plans>/<id>/index.md` or `/aif-fix <plans>/<id>/index.md` handoff; no local execution state |

Malformed config, duplicate consumed keys, inconsistent bindings, incomplete classic pairs and ultra collisions fail before admission. The helper does not repair or migrate canonical artifacts. A later source race is checked again under the admission lock and publishes no run; empty lock-parent directories may remain.

Task IDs support numeric forms such as `1.1`, classic `Task 12: Title` as `12`, and `task-<ordinal>` for unnumbered real checkboxes. YAML frontmatter, HTML comments, fenced code and indented examples outside task lists do not manufacture tasks. Nested tasks remain tasks; leading-zero aliases and duplicate IDs fail. Implement requires an unchecked task. Fix may target an already checked task with existing explicit finding context in `context_paths`, preserving its checked state. SessionBrief/SDD work in issue #168 remains separate.

Start before changing code, with a unique run ID and explicit writable files or directories:

```json
{
  "change_id": "add-widget",
  "run_id": "widget-implementation-1",
  "task_id": "1.1",
  "owner": "parent-session",
  "worker": "worker-session",
  "role": "implement",
  "scope": ["src/widget", "test/widget.test.js"],
  "context_paths": ["REVIEW.md"]
}
```

Send this payload to `ai-factory aifhub-execution start --json`. `role` is `implement` or `fix`. Owner and worker are bounded correlation labels; local execution may use the same label for both. They are not authentication credentials. The helper returns `kind: single`, `status: started`, `lifecycle: active`, `execution_state: running`, `version: 1`, and revision digests. Task/run/actor identifiers are portable tokens of at most 80 characters. Canonical source IDs retain safe sequential forms and may be up to 240 characters; they are never silently shortened. Avoid case-only IDs on case-insensitive filesystems.

Run records live at `.ai-factory/state/<change-id>/execution/runs/<run-id>.json`. The same execution folder contains `source.json`, one canonical `fix-attempts.json`, and recoverable `transactions/*.json`. A stable namespace binds source kind, identifier, entrypoint, checklist and primary source binding separately from changing context content. Reusing a namespace for another source fails with `state-source-collision`; a source/config revision cannot erase history.

The identity includes HEAD, branch, index, and content/executable mode of tracked and nonignored untracked files. Explicit scope directories also include ignored files inside them. Existing unrelated dirty files are part of the baseline and must remain unchanged. Runtime `.ai-factory/**` files have separate identities: canonical change/base specs, config, root `AGENTS.md`, rules, skill-context, and the selected change's QA inventory are pinned as context. Added and removed context files invalidate the run. Extra policy files, configured context outside those roots, ignored fixtures, or an already compiled SessionBrief must be listed in `context_paths` if the assignment depends on them. A context file inside the writable scope is consequently read-only for that run.

Classic `status.yaml` contributes only its fixed `plan_id` and synchronized source-binding projection. Ordinary status/history/current-task/timestamp changes do not invalidate execution, including when a custom status path is tracked outside `.ai-factory`. Parent policy, task, context, rules and verify content still do. Configured canonical roots are protected from worker scopes. Extra context, preflight, result, experiment and stop evidence cannot reference any source's mutable execution records, ledger, journals or locks, or directories containing them.

Live research is not automatically added: the embedded canonical Research Context remains authoritative and the existing research-drift warning behavior is preserved. Checkpoints do not compile a SessionBrief or substitute for upstream warmup.

On entry/re-entry send only `change_id` and `run_id` to `resume`. This operation creates no directories or lock files. A fresh active started run returns `resumable: true`; a fresh sealed/closed or terminal-result run returns `resumable: false`. Changed context, Git revision/index, evidence, or checkpoint contents produces a blocking diagnostic. The parent must retire stale dispatches, review current inputs and issue a fresh assignment. Never use a checkpoint write or seal to hide staleness encountered during re-entry.

After a worker deliberately changes in-scope files, save progress with `checkpoint`:

```json
{
  "change_id": "add-widget",
  "run_id": "widget-implementation-1",
  "actor": "worker-session",
  "version": 1,
  "progress": {
    "completed_steps": ["Implemented input validation"],
    "next_step": "Run the focused regression check"
  }
}
```

An optional `blocker` is a short string inside `progress`. Every checkpoint/result/accept transition returns a new version; use it in the next transition. All changed files must fit the originally assigned scope. Canonical OpenSpec, `.ai-factory`, and Git internals cannot be assigned as worker write scopes. Existing trace helpers continue writing implementation/fix traces independently. Do not stage, commit, or switch branches during an active run. Coordinate quiet snapshot boundaries in shared worktrees; concurrent writes from another task can invalidate a run even when its assigned task differs.

## Structured result and acceptance

A delegation admission handle proves only that work was admitted. The worker reports its observed outcome using `result`:

```json
{
  "change_id": "add-widget",
  "run_id": "widget-implementation-1",
  "actor": "worker-session",
  "version": 2,
  "result": {
    "result_id": "widget-result-1",
    "status": "completed",
    "changed_files": ["src/widget/input.js", "test/widget.test.js"],
    "checks": [{"name": "widget regression", "exit_code": 0}],
    "evidence": [".ai-factory/state/add-widget/implementation/widget-test.md"],
    "summary": "Validation and regression check completed."
  }
}
```

`status` is `completed | failed | blocked | cancelled | timed_out`. Changed files must match the actual changes since start, including deletions. Evidence paths must already exist; their hashes are stored. Checks contain a bounded name and an observed exit code from 0 to 255. A completed result needs evidence and passing checks, or an explicit `fallback` explaining why no useful automated check exists (for example a documentation-only change). These are worker assertions with evidence references; the helper does not run tests or infer that a report is truthful. Keep credentials, raw transcripts, and sensitive command arguments out of notes and evidence.

The returned result has a digest bound to task/run/context/worktree identity. An exact delivery retry with the original submitted version is idempotent while its files/evidence remain fresh. A conflicting second answer cannot replace the original. Terminal failure statuses cannot be accepted.

The parent inspects the diff and evidence, then calls `accept`:

```json
{
  "change_id": "add-widget",
  "run_id": "widget-implementation-1",
  "actor": "parent-session",
  "version": 3,
  "result_digest": "<digest from the result response>"
}
```

Only the current completed result can transition to `accepted`, closing that single dispatch. Any later file or evidence change blocks acceptance. Exact result/accept retries use the original submitted version, remain subject to freshness, and do not advance the version again. The helper does not update task checkboxes; the parent rechecks current evidence before doing so. Coupled/shared-file tasks run serially through fresh assignments. Canonical updates intentionally invalidate the old context.

`accepted` means the parent accepted the worker report. It does not write QA, grant approval, or imply `/aif-done`. Existing [Handoff validation](handoff-validation-profile.md), `/aif-verify`, coverage, rules, and done ownership stay authoritative.

## No-progress guard for fixes

Fix attempts use single-task runs. `attempt-check` reports failed/interrupted counts and whether this run has a pending attempt. It always reports `post_edit_fingerprint_checked: false`: the next edit is not pre-approved. `attempt-begin` independently checks the post-edit fingerprint and both limits. At most one v2 attempt may remain pending.

A fix run uses the same checkpoint/result contract after the parent selects existing QA findings. Before editing for a hypothesis, send the following payload to read-only `attempt-check` to check the remaining three-hypothesis budget. After an allowed edit and before its experiment or post-fix check, send the same payload to `attempt-begin`:

```json
{
  "change_id": "add-widget",
  "run_id": "widget-fix-1",
  "actor": "worker-session",
  "version": 1,
  "finding_id": "QA-1",
  "hypothesis": "Empty input reaches the parser without validation",
  "check": "widget-empty-input-regression",
  "environment_revision": "fixture-v3-node20",
  "input_paths": ["test/fixtures/widget.json"]
}
```

Make the proposed edit before `attempt-begin`, then run the check once against that pinned code. `check` is a stable label, not an executed command. `environment_revision` identifies actual non-sensitive runtime/fixture/service inputs; it is hashed in the ledger. List relevant ignored input files explicitly. The helper cannot measure remote services or validate an asserted environment label. Do not rename identifiers or invent environment changes to evade a stop.

Finish with `attempt-finish`, using the same run/actor/version plus `attempt_id`, `outcome: passed | failed | blocked`, and existing sanitized `evidence` paths. These attempt actions do not increment the run version. Source or explicit input changes during a check invalidate its result. An exact finish retry is idempotent. Do not submit a terminal worker result while an experiment is pending.

Attempts persist in `.ai-factory/state/<change-id>/execution/fix-attempts.json`, shared across runs. A pending, failed, blocked or interrupted experiment with identical task/finding/context/check/worktree/environment/explicit inputs produces `no-progress`; a different hypothesis sentence alone does not help. Three failed experiments for the same task/finding/context/environment/explicit inputs produce `attempt-budget-exhausted`, even when code changes between them. Three interrupted attempts independently produce `interruption-budget-exhausted`. Stop and reassess the root cause and architecture. New measured inputs or new authoritative evidence may justify another attempt; history is never silently cleared or pruned. The ledger stops at 1,000 records.

The expected failing pre-fix reproduction remains `preFixResult` trace evidence, not a failed hypothesis. A successful experiment remains supporting runtime evidence and is never a reused QA verdict. Owner interruption records pending experiments as `interrupted`, preserving their original identities and evidence. Stop confirmation releases a scope reservation; it does not clear a no-progress fingerprint or reset either allowance.

## Small sealed batches

Use `batch-start` for 2-5 independent implementation tasks in the same canonical source. One task uses `start`; six must be split. Each item declares exact files (including intended new/deleted files), an expected change, exactly one `check` or `fallback`, and a `dependencies` list. Duplicate IDs, case aliases, overlapping files, directory/glob paths, protected roots and dependencies within the proposed batch are rejected before state writes.

The coordinator must actually inspect interface dependencies and record relevant preflight resolutions. File disjointness and prose do not prove semantic independence. Coupled tasks are serialized. All `preflight_paths` must already exist and remain unchanged through close.

```json
{
  "change_id": "work",
  "run_id": "run-1",
  "owner": "parent",
  "worker": "worker",
  "role": "implement",
  "manifest": [
    {"task_id":"1.1","files":["src/a.js"],"expected_change":"Handle input A","check":"focused-check","dependencies":[]},
    {"task_id":"1.2","files":["src/b.js"],"expected_change":"Handle input B","check":"focused-check","dependencies":[]}
  ],
  "preflight_paths": [".ai-factory/state/work/implementation/preflight.md"]
}
```

The worker resumes before edits, works only within the manifest, and records a final `checkpoint`. It stops editing and runs the final checks against the complete shared inputs. Rerun any earlier check whose sibling input changed. Then send `batch-seal` with the returned checkpoint version and an exact evidence path list for **every** item:

```json
{
  "change_id":"work", "run_id":"run-1", "actor":"worker", "version":2,
  "evidence": {
    "1.1":[".ai-factory/state/work/implementation/1.md"],
    "1.2":[".ai-factory/state/work/implementation/2.md"]
  }
}
```

An omitted/unready item's inventory is `[]`; it cannot acquire new evidence after sealing. Seal requires the current worktree to equal the saved final checkpoint, reconciles the union diff, hashes all item evidence, and returns `seal_digest` plus version 3 in this example. An extra unreferenced runtime note grants no additional evidence authority.

| Action | Payload in addition to `change_id`, `run_id`, `actor`, current `version` | Caller / effect |
| --- | --- | --- |
| `batch-seal` | `evidence` map above | Worker: active → sealed |
| `batch-result` | `task_id`, returned `seal_digest`, existing strict `result` payload | Worker: store one item result |
| `batch-accept` | `task_id`, `seal_digest`, returned `result_digest` | Parent: accept one fresh completed item |
| `batch-close` | `seal_digest` | Parent: freeze accepted and unfinished sets; sealed → closed |

Each mutation advances one shared version. Submit results and accept items sequentially using returned versions; either acceptance order works. Two mutations at one version cannot both succeed. A result's `changed_files` must exactly match its own item's real diff, and its `evidence` must equal that item's sealed inventory. Creation and deletion count as changes. All evidence and the whole worktree remain pinned; a sibling edit, stale preflight, HEAD/index/context change or altered/missing sealed evidence blocks result, acceptance and close.

Exact seal/result/accept replay uses its original submitted version and still checks freshness. Altered retries and new late worker output fail. Close returns `closure` with accepted/unfinished task sets and context/worktree/seal digests. Four accepted results out of five leave the fifth unfinished even with an aggregate green check.

Before marking canonical tasks, close the dispatch, then call read-only `resume` against the closed record to recheck current inputs and evidence against its closure. It returns `resumable: false` when fresh. Apply only that exact accepted set. Drift between close and synchronization prevents checkbox updates. Canonical progress updates intentionally make the old record stale. An exact `batch-close` retry thereafter returns `historical: true`; it never renews checkbox authority. Interrupted history cannot supply a successful closure.

## Historical inspection and interruption

`inspect` accepts `{"change_id":"work","run_id":"run-1"}`. It reads the recognized saved assignment without requiring current canonical source resolution. It returns bounded version/status/lifecycle/stop knowledge, digests, pending attempt IDs and recovery/transaction IDs. It returns no source bodies, raw snapshots, progress text or resumability claim. Omitting `run_id` returns bounded counts and `predecessor_inventory_digest` for explicit upgrade. Inspection never creates locks or directories.

On cancellation, timeout or abandonment, the parent obtains the saved version and sends `interrupt`:

```json
{
  "change_id":"work", "run_id":"run-1", "actor":"parent", "version":1,
  "recovery_id":"recovery-1", "reason":"timed_out", "execution_state":"unknown"
}
```

`reason` is `cancelled | timed_out | abandoned`. `execution_state` is `stopped | running | unknown`. Optional `evidence` lists existing sanitized references; `stopped` requires a nonempty list documenting actual observed stop. Use the real host's existing cancellation capability for the owned worker handle when available. The helper has no worker handle, does not launch or kill a worker, and cannot authenticate a PID. Elapsed time and a completed/cancelled result are not proof of process death.

Interruption works after worktree/context/revision/input drift, even with missing, disabled or malformed current source config. It records bounded drift categories separately and preserves the original context, checkpoints and result payloads. Completed-but-unaccepted single results may be retired. Already accepted batch items survive as history. An accepted single or closed dispatch cannot be reclassified, and late worker checkpoint/result/attempt-finish cannot revive interrupted work.

`running` and `unknown` keep the original scope reserved. After observing exit, the parent sends `stop-confirm` using the interruption's returned version:

```json
{
  "change_id":"work", "run_id":"run-1", "actor":"parent", "version":2,
  "recovery_id":"recovery-1", "confirmation_id":"stop-1",
  "evidence":[".ai-factory/state/work/implementation/stop.md"]
}
```

This releases only the interrupted reservation. A replacement still needs fresh canonical inputs and a new run ID. Recovery and stop retries must repeat the exact ID/payload and original submitted version; they return immutable historical receipts without double-counting attempts. Changed payload conflicts. The pending attempt set comes from the journaled persisted snapshot, never from a caller-supplied list.

Controlled-child tests cover readiness, observed exit before replacement and abrupt death with leftover locks on the test host. They do not claim coverage of actual Claude/Codex host cancellation adapters; those remain deferred.

## Explicit v1 compatibility and transaction recovery

New records use `aifhub.execution.v2` with `kind: single | batch`, ledger `aifhub.fix-attempts.v2`, source `aifhub.execution-source.v1` and journal `aifhub.execution-transaction.v1`. Checksums and nested schema/correspondence validation are both required. Unknown/corrupt history is never interpreted as an empty store.

`start`/`resume` never silently upgrade predecessor v1 state. Stop all old helper dispatch, inspect the exact source inventory and reconcile every open assignment/pending attempt first. Recognized active v1 assignments can be interrupted before upgrade: their exact predecessor envelopes are journaled and an explicit successor terminal record is written. The canonical old ledger remains until the explicit upgrade.

Send `upgrade` with `change_id`, parent `actor`, a unique `upgrade_id`, and the exact `predecessor_inventory_digest` returned by source-level `inspect`. Every predecessor owner must match, every assignment must be quiescent and no attempt may remain pending. The helper checks the inventory again; a concurrent old-ledger write conflicts.

Upgrade preserves complete predecessor envelope bytes in its journal and replaces the one canonical ledger path with v2, which the old v1 attempt writer rejects. It preserves original contexts, budget/fingerprint history and ordinal-to-canonical task aliases. Mapping must be proved from source bytes matching the old stored task hash and the known old parser; changed or ambiguous task snapshots block upgrade. Unchanged authoritative inputs retain previous failure/interruption counts under new run IDs. Historical results never become new acceptance.

Mixed-version dispatch is unsupported; this cooperative guard does not enforce old-process quiescence at the OS level. Some old snapshots cannot prove their mapping and require explicit reconciliation rather than guessed migration.

Admission, interruption and upgrade journal exact before/after images before publishing multiple files. Every image and size is checked first. A prepared journal blocks new dispatch and permits only its exact action/payload replay; replay accepts only exact before or already-written after images. A third value conflicts. A recovered admission after source drift is historical and still fails worker `resume` until reassessed. Close/recovery/stop/upgrade replay never reopens work or grants new current acceptance.

The project catalogue is bounded to 1,000 runs across source IDs; unknown records or missing lineage fail closed. All new mutations acquire `.ai-factory/state/execution-write.lock` then the per-source `execution/write.lock` in that order. Open runs, old started/completed-unaccepted runs and interrupted running/unknown assignments reserve overlapping file/directory scopes, including case aliases. Disjoint runs can coexist but retain whole-worktree freshness. Terminal unsuccessful worker results require owner retirement before releasing their v2 scope.

## Versioned evolution

Upstream `/aif-evolve` keeps its prevention registry, analysis, report, and existing approval semantics. Replace the skill-context write step with `aifhub-evolution propose`, one skill per transaction:

```json
{
  "transaction_id": "fix-rule-1",
  "skill": "aif-fix",
  "after": "# Project fix guidance\n\nRecord one falsifiable hypothesis before editing.\n",
  "reason": "Repeated speculative edits in the selected fix traces",
  "evidence": [".ai-factory/state/add-widget/fixes/parser-fix.md"]
}
```

`after` is the complete replacement text (maximum 256 KiB), or `null` for deletion. The only writable target is `.ai-factory/skill-context/<aif-skill>/SKILL.md`. The proposal stores exact before/after content, evidence hashes, and its digest under `.ai-factory/evolutions/transactions/<transaction-id>.json`. It returns a whole-file unified diff without editing the target. `show` accepts just `transaction_id` and displays that proposal without writing. These snapshots contain skill-context text: store only project guidance suitable for local persistence.

After the existing user/session decision authorizes the exact diff, `apply` accepts `transaction_id` and `proposal_digest`. No additional approval ceremony is introduced. A changed target, stale evidence, or wrong digest blocks application. The journal records the transition before writing the target and then saves an applied receipt. Keep transaction IDs in the upstream evolution log. A multi-skill batch consists of independent transactions; report partial application explicitly. Patch-cursor updates retain upstream ownership and patch-only semantics and happen only after the required approved changes succeed.

`rollback` accepts the same ID/digest. It restores exact prior text or prior absence only if the current target still equals that transaction's output. It refuses to erase a later edit. To undo several overlapping evolutions, undo the newest applicable one first. Repeating an already completed operation is idempotent only while its destination still matches. An apply after rollback requires a new proposal.

## Filesystem and recovery limits

Writes use exclusive helper locks, checksummed records, and atomic same-directory replacement. Portable relative paths are required; traversal, absolute paths, symlinks/junctions, hardlinks, and non-regular file reads fail closed. Limits are 16 MiB per inspected file/state record, 20,000 Git paths, and 10,000 files per context/scope inventory. Binary source files are hashed; evidence references are hashed without copying their contents into records.

Locks serialize these helpers, not arbitrary editors or other OS processes. They do not provide a sandbox, authenticated worker identity, a coherent snapshot while other tools are writing, or protection from someone deliberately rewriting all valid records and their checksums. Run snapshot/apply/accept operations while the relevant inputs are quiescent. Git submodules and symlink-based source trees remain unsupported and fail closed. Inputs ignored by Git outside assigned scope need explicit context/input references.

Abrupt helper death can leave either execution lock, or an evolution `write.lock`. The helper returns `state-locked`; it never steals a lock using age or PID guesses. This increment recovers worker interruptions and replayable transactions, not orphan-lock ownership. A responsible operator must establish that the actual writer is stopped before separately reconciling that exact lock. Execution `inspect` and evolution `show` remain read-only while locked.

For evolution, repeat the same `apply`/`rollback` with the same digest after explicit lock reconciliation. Its `applying`/`rolling_back` journal recovers only when the target equals the expected source or destination; a third value conflicts. Filesystem/power-loss guarantees depend on the host; leftover temporary files are never promoted by guessing.

These records are local supporting artifacts, excluded from canonical OpenSpec and QA paths. They do not install or execute model-generated code, change base skills/agent roles, alter Handoff policy, publish changes, or mark the Prime runtime or issue #168 adopted.

## See Also

- [Usage](usage.md) — workflow and authoritative verification ownership.
- [Task coordination](../skills/shared/TASK-COORDINATION.md) — independence checks and parent reconciliation.
- [Prime Agent evaluation](runtime-research/prime-agent/README.md) — provenance and deferred runtime adoption.
