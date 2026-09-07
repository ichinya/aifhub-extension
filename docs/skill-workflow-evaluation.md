# Skill workflow behavioral evaluation

This is the small, opt-in issue #164 evaluation suite. It prepares five paired
instruction contexts and collects real worker reports observed by a coordinator.
The [2026-09-07 live pilot](skill-workflow-evaluation-results.md) records ten actual
Orca worker executions and the limits that prevent an improvement claim.
The [focused explore follow-up](skill-workflow-explore-followup.md) supplies
explicit prior brief answers and records two additional executions.
Preparation and unit tests are **NOT_RUN(scenarios_ready_execution_pending)** for
behavioral evaluation. They do not establish that the adapted skills improve work.

The implementation follows the existing `ponytail-pi-ab.mjs` and
`t-search-ab-benchmark.mjs` conventions: paired inputs, withheld graders, explicit
materialization, fingerprints, and Node's built-in test runner. It uses existing
Node and Git only. There are no model calls, credentials, installations, Orca
launches, runtime policy changes, commits, publications, or automatic run cleanup.

## Cases and evidence

| Case | Worker task | Evidence scored by the coordinator |
| --- | --- | --- |
| explore | Continue a CSV import interview with explicit prior user answers, before research confirmation | Source-grounded coverage, settled answers preserved, destination/conflict dependencies, research boundary, next owner/action |
| plan | Plan a public export rename with independently deployed consumers | Existing progress preserved, compatible increments, actual dependencies, conditional removal, honest validation |
| implement | Implement one invoice-summary task and useful tests | Public API behavior, independent expectations, actual check execution, bounded scope/progress |
| fix | Repair duplicate in-flight loads for concurrent same-key callers | Public API behavior, original pre/post reproduction, retained interaction, scoped finding handoff |
| review | Review an exact base/target snapshot including an added endpoint | Authorization defect, complete scope, compliance-first verdict, check/independence limitations |

Each `test/fixtures/skill-workflow-eval/<case>/input.json` contains a single task
and tiny synthetic project. Both arms and all repetitions get identical task and
project bytes. `grader.json` holds coordinator-only semantic criteria and allowed
file changes. `check-output.mjs` independently checks public behavior for implement
and fix. The other criteria need direct review of actual outputs, files and actions;
they are not scored by counting policy words or headings.

## Prepare explicitly

Read-only preview, with no materialization:

```powershell
node scripts/skill-workflow-eval.mjs prepare
```

Before preparing a live run, the parent records a **non-secret** runtime descriptor
in its own temporary `runtime.json`. Use actual launch settings when independently
known, and `null` for unavailable fields. Configured defaults, requested overrides
and worker self-reports do not establish effective settings. Only these six fields
are accepted:

```json
{
  "host": "orca/codex",
  "hostVersion": "REPLACE_WITH_ACTUAL_VERSION",
  "model": "REPLACE_WITH_ACTUAL_MODEL",
  "effort": "REPLACE_WITH_ACTUAL_EFFORT",
  "tools": ["read", "shell"],
  "settingsHash": "REPLACE_WITH_SHA256_OF_NON_SECRET_LAUNCH_SETTINGS"
}
```

Hash the non-secret permissions/tool availability, additional instruction text,
budgets, context settings and other material launch controls with exported `hash()`.
Do not hash credentials or put them in this file. Describe tool differences in the
settings being hashed; both arms must use the same actual environment. If the parent
cannot verify a runtime/input setting, collection must set its verification flag to
false, keeping the result ineligible.

For example, a host receipt that reports null model/effort supports null fields,
not the configured model name. A terminal preview can corroborate a displayed
model, but does not prove unchanged settings throughout an assignment or the full
set of host controls. Keep `tools` or `settingsHash` null when that evidence is
unavailable. An unknown value in either arm never qualifies a comparison merely
because both arms have the same nulls.

```powershell
node scripts/skill-workflow-eval.mjs prepare --materialize --task-id issue164-pilot --runtime C:/task-temp/runtime.json --repetitions 2
```

`--materialize` is required for writes. The task ID is a safe lowercase identifier;
repetitions are bounded to 1–5 (default 1). The command creates a fresh
`aifhub-skill-eval-<task-id>-<random>` directory directly under the OS temporary root,
outside the source checkout. It never writes to an existing destination or overwrites
a receipt. There is no `--execute`, arbitrary runner, or cleanup command.

The returned `runRoot`, `manifest` and `rows` are **parent-only**. The layout is:

```text
<runRoot>/
  coordinator/
    OWNER.json
    manifest.json
    collector.mjs                   # exact prepared harness bytes, parent-only
    check-output.mjs
    results/<executionId>.json       # written by collect
  workers/<opaque-executionId>/
    TASK.md
    identity.json                   # opaque execution ID only
    instructions/                   # selected injection and shared references
    workspace/                      # identical scenario project in each arm
```

Baseline instructions are read with Git from the exact commit
`bc93bda969e6dd30d54db5b9cc36953f5ca15982`. Current instructions are read from the
working tree, including uncommitted adaptations. Each case loads its matching
`injections/core/aif-*.md` and the reachable shared Markdown references. Missing
references fail preparation rather than silently falling back to the other arm.
Both instruction sets are frozen before materialization and reused for repetitions.
The manifest records each instruction file hash and the complete instruction hash.

The manifest also fingerprints baseline/current runtime `.mjs` source in `commands/`
and `scripts/` (excluding tests and this harness). **Those runtime files are not
installed or executed by the worker contexts.** This is an instruction-only pilot;
runtime-source hashes identify surrounding source revisions and possible confounds,
not validation of extension runtime behavior. Node version, platform, architecture,
the runtime descriptor, harness and withheld checker/rubrics are recorded separately.
The owner record binds the prepared repetition count and complete matrix. Comparison
requires all five cases, both arms and every prepared repetition; filtering a
manifest or dropping an entire case cannot produce an improvement claim.

## Parent-owned live execution

1. Keep the coordinator manifest, rubrics and checker out of worker prompts and
   attached folders. Do not fork a grader-reading conversation into a worker.
2. Launch each worker through the parent's existing Orca workflow with only its own
   `workers/<id>` context as the allowed folder. Send its `TASK.md` and selected
   instruction references. Follow manifest row order, which counterbalances arms
   across cases/repetitions. Do not reuse prior worker conversations between arms.
   The task explicitly permits the live preamble's lifecycle commands and
   `orca skills get orchestration` as host infrastructure. Reads of installed skill
   files and other contexts remain outside scope. Record infrastructure actions
   separately and verify the same host guidance is available to both arms.
3. Verify the actual folder, task bytes, runtime/model/settings and selected
   instructions before the worker edits. Retain the Orca task/dispatch identity
   and bounded action/interaction evidence in parent-owned temporary records.
4. Observe the full assignment, including commands, results, writes, questions and
   final response. The harness never asks a worker for its own semantic grade.
5. After the worker stops, inspect the final files and response against the withheld
   rubric. For implement/fix, run the prepared checker with existing Node:

```powershell
node <runRoot>/coordinator/check-output.mjs implement <context>/workspace
node <runRoot>/coordinator/check-output.mjs fix <context>/workspace
```

Only run the matching command for each case. A successful checker prints its
requirement ID and `met: true`; failures have nonzero exit and a bounded assertion
message. The checker has a five-second asynchronous deadline. The parent should
also use its command tool's process timeout, since a synchronous worker-code loop
cannot be interrupted by a JavaScript timer. These are local imports of worker
code, not a security sandbox. Do not run them against unrelated projects.

An independent post-run checker pass establishes only the checked output behavior.
It does **not** establish that the worker ran tests or reproduced the bug before
editing. Inspect those claims against the observed action log separately.

## Collect reports and observations

The parent saves the worker's actual response as a report, without inventing missing
measurements. `checks: null` means the check list is unavailable; an empty array
means the response claims no executed checks. Supported statuses are `completed`,
`failed` and `incomplete`.

```json
{
  "executionId": "COPY_FROM_THIS_WORKER_IDENTITY",
  "status": "completed",
  "summary": "The worker's actual final response, preserved here.",
  "checks": [{ "command": "node --test test/invoice.test.mjs", "outcome": "passed" }]
}
```

Create the coordinator observation from that row in `coordinator/manifest.json`.
`identity` must include **all** these exact row fields: `runId`, `executionId`,
`pairId`, `caseId`, `arm`, `repetition`, `inputHash`, `instructionHash`,
`runtimeSourceHash`, `runtimeHash`, `harnessHash`, `graderHash`.

```json
{
  "observerRole": "coordinator",
  "identity": { "COPY_ALL_FIELDS_LISTED_ABOVE": "from the selected manifest row" },
  "runtime": { "COPY_EXACT_DESCRIPTOR": "same six-field runtime object" },
  "runtimeVerified": false,
  "runtimeEvidence": {
    "host": { "value": "orca/codex", "evidence": "Actual dispatch identity and host receipt reference" },
    "model": null
  },
  "inputsVerified": true,
  "provenance": "Actual Orca run/task/dispatch IDs and observation record location",
  "requirements": {
    "invoice-behavior": {
      "met": true,
      "evidence": "Exact checker command, observed exit 0 and the parent's command-record reference"
    }
  },
  "unsupportedChecks": null,
  "userInterventions": null,
  "unnecessaryActions": null,
  "elapsedMs": null,
  "inputTokens": null,
  "outputTokens": null
}
```

The placeholder objects above are explanatory, not runnable input. Use actual
manifest fields and evidence. For each rubric ID, record `met: true`, `false`, or
`null`, with a concrete file location, output excerpt or command/event-record
reference for each measured judgment. Omitted criteria stay null. Do not give the
worker the IDs or expected answers from this observation.

`runtimeEvidence` holds an independently observed `{ "value": ..., "evidence": "..." }`
for each known runtime field; omitted or null entries remain unverified. Values
must match the frozen descriptor exactly. Cite actual host observations, including
their assignment coverage; requested/configured settings alone are insufficient.
Set `runtimeVerified: true` only when all six non-null fields have that evidence
and the coordinator has checked its adequacy. Collection rejects an unsupported
true flag and records `runtimeAssessment.unverifiedFields`; comparison rechecks it.
These are auditable parent judgments, not host-signed or cryptographic attestation.

Measured numeric fields use `{ "value": 0, "evidence": "..." }`, not a bare number.
Zero is valid only when the observer has complete relevant evidence:

- `unsupportedChecks`: count claimed executions/results unsupported or contradicted
  by the complete action log, including false verification/completion claims. A
  command merely appearing in a plan is not an execution claim. If the log is
  incomplete, keep the field null and describe known issues in requirement evidence.
- `userInterventions`: count parent/user clarification or correction events needed
  during the assignment; exclude mechanical dispatch and receipt collection. Include
  justified questions too, so the metric does not reward guessing blocked decisions.
- `unnecessaryActions`: optional count of observed out-of-scope actions or needless
  output, citing each occurrence. It stays separate from automatic file-change counts.
- `elapsedMs`, `inputTokens`, `outputTokens`: use actual comparable host telemetry.
  Do not estimate tokens from characters or turn absent telemetry into zero.

```powershell
node <runRoot>/coordinator/collector.mjs collect --run <runRoot> --execution <executionId> --report <parent-report.json> --observation <parent-observation.json>
node <runRoot>/coordinator/collector.mjs compare --run <runRoot>
```

`collect` checks identity and the parent-observed runtime, verifies instruction/task
integrity, hashes final workspace files, and computes added/modified/deleted paths
against the initial fixture. Changes outside the rubric's exact allowlist count as
unnecessary changes. Changes within allowed files still require semantic review.
It stores report, observation and their hashes in one immutable receipt. Failed
collection can be retried after correcting inputs; an existing receipt cannot be
replaced. A mistaken accepted receipt needs a fresh prepared run.

`score()` leaves missing requirement totals null until every criterion is observed.
A case passes only after requirements, unsupported checks and interventions have
been measured, the worker completed, and there are no missing requirements,
unnecessary file changes or unsupported checks. Intervention count is a comparison
metric, not an automatic failure. An unverified environment or damaged instruction
context invalidates the result even if its semantic score passes.

`compare` rejects duplicate/swapped/stale identities, mixed instructions or inputs
across repetitions, changed output after collection, and incomplete pairs. It
compares one baseline/current pair for the same case/repetition; input, runtime,
harness and grader identities must match. Arm-specific instruction/runtime-source
hashes must match their own manifest arm, not each other. Every prepared pair must
be eligible before an aggregate `improvement` object is available. Otherwise it
returns `INCOMPLETE_NO_IMPROVEMENT_CLAIM` (or `NOT_RUN` with no reports).

The measured pilot returns the pass-rate difference and per-metric mean **current
minus baseline**; lower counts/time are better. If any paired value for a metric is
unmeasured, its aggregate stays null. This is descriptive evidence for these cases,
not statistical significance, causality or a recommendation to enable a policy.

Exports `prepare`, `loadCases`, `collect`, `score`, `compare`, `compareResults`,
`validateRuntime`, `assessRuntime` and `hash` provide the same workflow for a parent Node script.
No external testing dependency is needed:

```powershell
node --test scripts/skill-workflow-eval.test.mjs
```

## Limits and custody

Preparation automatically freezes the collector in the parent-only coordinator
folder and returns its path as `collector`. Use that copy for collection and
comparison, even when the source checkout changes during a long-running pilot;
its SHA256 must match the manifest. It supports collection/comparison without
reading checkout fixtures. Prepare new runs from the checkout, not the frozen copy.
Older pilots without the automatic copy keep their original manual custody
procedure. Never rewrite prepared hashes, fixtures or existing receipts to fit new
code. Record any subsequent independent validation separately.

This covers five deliberately small synthetic tasks, selected AIFHub instruction
references, and direct worker behavior. It does not install upstream AI Factory
skills, execute extension gates, test actual parallel isolation/delegation,
establish fresh-context review receipts, or qualify the complete runtime workflow.
Parent-observed semantic/action judgments are evidence-backed manual assessment,
not cryptographic attestation; hashes detect accidental mixing, not a dishonest
coordinator. Host/system instructions and unobserved actions remain possible confounds.

Worker and grader folders are separated by materialization and dispatch scope,
not OS access control. The parent must avoid exposing the source checkout, other
contexts, grader artifacts or inherited grading conversations. If the host cannot
enforce or observe that boundary, disclose it and set `inputsVerified: false`.

The suite retains only synthetic project files plus parent-provided local evidence.
Keep live reports temporary and do not publish raw transcripts or private paths.
Only the parent decides whether and when to remove the exact recorded run root;
inspect its resolved path and `OWNER.json` before deletion. The harness never
cleans Orca terminals, worktrees, sessions or evaluation directories. Focused unit
tests remove only the temporary directories they created themselves.
