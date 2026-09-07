# Reproduction for difficult bugs

Read when a selected fix has a large, slow or intermittent reproduction and artifact classification permits local investigation. Preserve `/aif-fix` finding selection, change scope, existing unreproducible-case decisions and persistent attempt limits. An ordinary clear regression does not need an additional minimization exercise. This reference does not authorize a new bug fix without the caller's required plan/findings, a new harness dependency, production instrumentation or extra environment access.

## Preserve the original signal

Keep the original command or scenario, the reported symptom, non-sensitive inputs, source revision and relevant environment conditions before simplifying anything. A nearby exception or a missing prerequisite is not reproduction of the reported bug. For performance failures, record comparable workload and baseline measurements; a faster but different workload is not evidence of a fix.

Use the narrowest existing check that reaches the real failing interaction. A multiple-caller or ordering bug needs that interaction in the reproduction, even if a single-function test is easier. Record actual observations separately from the expected result. An unexpectedly passing check retains the caller's existing fallback/owner decision; do not manufacture RED or treat an unexecuted hypothesis as reproduction.

## Reduce only while retaining the symptom

When reduction would help, vary one input, caller, configuration condition or step at a time. Run the reduced case after each meaningful cut and retain the cut only when the same symptom remains. Preserve the original input unchanged. Use only permitted fixture copies and the assigned write/evidence locations; a minimized case must not overwrite pinned input evidence or unrelated user data. If a useful experiment needs a larger scope or unavailable setup, return that prerequisite to the parent.

Stop when the remaining case usefully distinguishes the plausible causes, or when the available evidence/access prevents further reduction. Do not require proof of a globally minimal case before making a supported bounded fix. Label partial reduction honestly. A cut that replaces the real interaction with a mock or changes which error is observed has lost the signal.

For intermittent bugs, select a finite trial budget and deadline suited to the existing environment. Record attempts, occurrences of the target symptom, unrelated failures, seed/scheduling controls and other relevant conditions. Compare before and after under the same conditions. One clean run, an eventual retry success, or zero observed failures in a finite sample does not prove the race absent. Prefer controlled interleavings or the project's existing test facilities; do not raise load, insert production sleeps or run unbounded retries to force reproduction.

## Verify both cases and retain evidence

Use the reduced case as a regression check only if it still exercises the real defect. Preserve observed pre-fix/post-fix results, then rerun the original unreduced scenario against the fixed code. Report the two outcomes separately. If the original case is still failing or cannot be run, retain that defect or evidence gap instead of declaring the whole finding resolved.

Keep the existing one-hypothesis-at-a-time and three-failure/interruption budgets. Expected pre-fix reproduction belongs in `preFixResult`; it is not a failed fix attempt. Experiments and post-fix checks still use the installed attempt guard where required. An intentionally changed fixture or environment is a new measured input, not permission to rename identifiers or reset history.

Use existing `rootCauseEvidence`, `experiment`, `regressionCheck`, `preFixResult`, `postFixResult` and fallback notes; do not extend trace or QA schemas. Remove only this investigation's temporary instrumentation when it is no longer needed, preserving useful regression fixtures and unrelated edits. Complete cleanup before final checks, or rerun affected checks after cleanup changes their inputs. `/aif-verify` remains the owner of the final verification verdict.
