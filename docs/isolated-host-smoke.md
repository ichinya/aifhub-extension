# Isolated host smoke

This opt-in qualification uses the existing Orca host and installed AI Factory CLI,
two independent pure functions, unchanged Node acceptance tests and a deliberately
dirty unrelated file. It does not require a new provider or service. The fixture
builder creates only its own temporary Git project:

```powershell
node scripts/fixtures/isolated-host-project.mjs --create
```

The host owns installation of the requested AIFHub checkout, worktree creation,
worker dispatch, observed process stop and cleanup. The builder performs none of
these actions. Existing user configuration, credentials and unrelated worktrees
must never be copied into the fixture. Copy only this fixture's installed skill
roots, explicit tool configuration and identical dirty baseline to its workers.

## Repeatable sequence

1. Install the existing core implement/verify skills and local extension in the
   owned fixture and run installed `aifhub-mode init --json`. Prepare two same-Git-common worktrees with identical HEAD, index,
   source, context and full-tree bytes. Save bounded preflight evidence.
2. Run installed `isolation-preflight` before ordinary worker runs. Resolve any
   baseline mismatch from observed paths; a ready preview does not reserve work.
3. Admit both ordinary single-task runs and register the parent group before
   allowing either worker to edit. Assign only `src/clamp.cjs` or `src/slug.cjs`.
4. Let clamp finish an observed RED/GREEN cycle and submit its result. Ask slug to
   save an intentionally incomplete checkpoint with its remaining failing test,
   then wait for parent cancellation. Neither worker checks canonical tasks.
5. Observe the exact clamp worker stop; inspect and accept its ordinary result.
   Cancel the exact slug dispatch, independently inspect its process state, and
   record ordinary interrupt/stop evidence before retiring its group assignment.
6. Apply clamp through the journal, run its test in the parent tree, accept it,
   close the group and perform a fresh resume. Reconcile only the accepted task;
   slug remains unchecked. Preserve its partial file and checkpoint evidence.
7. Reuse the stopped slug worktree. Materialize the new exact parent baseline
   after preserving partial bytes; admit a fresh run/group. A fresh worker uses
   the saved checkpoint context and completes slug. Repeat actual stop, ordinary
   acceptance, integration and combined checks; close and freshly reconcile.
8. Run the installed verify workflow on the final parent tree. A passing test
   command alone is not an authoritative verify gate. Audit unrelated dirty
   bytes, index, canonical progress, evidence and worker processes before cleanup.

An interrupted assignment is historical evidence. Its late output cannot authorize
the replacement run, and preserved partial bytes are not automatically accepted.
Correct source/context at group boundaries; changing it while a group is active
requires the documented stop/abandon/reconciliation path.

## Observed run, 2026-09-07

Host: Windows, Orca 1.4.197, AI Factory 2.18.1, Node 24.13.0, local AIFHub extension
1.5.1 plus the uncommitted issue #164 changes. Orca run `run_2c7ed728166e`.

The exercised sequence completed. [Sanitized observations](isolated-host-smoke-results.json)
record exact dispatches, group closures, final source binding, checks and custody.
The installed verifier returned `warn`, `blocking: false`: strict OpenSpec
validation passed, focused tests passed, the combined suite passed 2/2, 65 additional
behavior probes passed and both requirements were covered. Seven optional warnings
retain missing generated rules/rules evidence, project context and build/lint
limitations. This result does not establish `/aif-done` readiness.

Wave 1 accepted only task 1.1 and retired the stopped partial task 1.2. Wave 2
recovered task 1.2 in its existing worktree and accepted it. Parent progress was
reconciled only after each closure plus fresh resume. Final verification compared
717 non-QA files and preserved HEAD, index and the original dirty file.

Both worker trees, including ignored runtime history and the partial source, were
archived with all 1403 file hashes matching. The stopped slug worktree was removed
through Orca. The clamp worktree was retained because inspection found an additional
live terminal whose ownership was not established by this run. That terminal was
left untouched. The parent fixture, worker archives and bounded raw observations
remain local for audit; only sanitized evidence is included here.

The first preflight detected Orca-created `.repowise/` metadata that made the
prepared trees differ. The fixture-specific ignore was corrected; production
snapshot rules were not relaxed. The reusable fixture excludes that host metadata.

Controlled cancellation returned `dispatch_inactive` from `worker-stop`, while
subsequent `worker-show` reported the exact worker exited, its capability revoked,
and its terminal disconnected/nonwritable. The coordinator used that independent
observation as stop evidence. `worker-release` then retained the already exited
resource with `identity_unproven`; this response was not treated as proof of stop.

The initial minimal OpenSpec fixture had no spec delta, and real CLI validation
correctly failed. A complete delta was added at the closed first-group boundary;
the reusable fixture includes it from creation. Fresh validation passed before
the second group. These fixture corrections are recorded, not hidden as worker
successes.

The verifier also caught missing OpenSpec initialization metadata in the original
fixture. The parent ran the installed mode initializer after both groups were
closed, and the verifier restarted context and validation reads. The reusable
fixture now includes basic OpenSpec configuration and a retained base-spec folder;
host preparation still runs the initializer before worker admission.

## Limits

One controlled local run qualifies the exercised host path only. It does not
establish throughput gains, remote-host portability, crash behavior at every
journal transition or model-quality improvement. Runtime fault/lock/image tests
cover separate deterministic cases; [instruction evaluation](skill-workflow-evaluation.md)
measures a different boundary. The helper still does not stop processes or create
worktrees, and no dynamic DAG scheduler is added.
