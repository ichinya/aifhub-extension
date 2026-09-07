# Test quality and readiness waits

Apply this policy only after artifact classification permits local implementation or a selected fix. It applies to OpenSpec-native and classic legacy execution. Keep marker-first ultra delegation, allowed change scope, project-required checks, and `/aif-verify` ownership intact.

## Choose a check that can detect a defect

Before adding or changing an automated check:

1. Name a realistic production defect the check should detect, and the observable failure it would produce. A source-text change alone is not a behavioral defect; prompt/documentation contract tests must be labeled as such.
2. Derive the expected result independently from the requirement, a literal, or a hand-checked fixture. Do not compute both actual and expected values with the same production function, builder, or copied algorithm.
3. Exercise real behavior. Mock only a necessary slow or external boundary; preserve the data shape and side effects that the behavior depends on. An assertion that a mock exists or was called is insufficient when the requirement concerns its caller's result.
4. Reject a check that still passes for the named defect. Replace the assertion or fixture with one that distinguishes correct and incorrect behavior, without broadening the task.

For OpenSpec-native work, record the named defect and the independent expectation source in the existing `testCheck` or `regressionCheck` evidence. In classic legacy mode, use the existing execution/fix evidence location. These are supporting explanations, not new QA verdicts or a new trace schema.

When useful and safe, demonstrate that the check fails against the named defect in a disposable fixture or isolated copy. Do not introduce a deliberate defect into the user's working tree, install a mutation framework, or require a mutation run for every change. A reasoning-only assessment must not be reported as an executed mutation check. Preserve the observed RED/GREEN or pre-fix/post-fix results separately.

Documentation-only work, generated artifacts, user-authorized no-test work, and tasks without a useful automated check retain the existing `fallbackDecision`. Do not invent a failing test, add meaningless tests, or weaken required project checks to satisfy this policy.

## Choose the observable interface

Select the smallest existing public boundary that exercises the required behavior as real callers use it. This can be a module API, command, endpoint or UI flow; it does not always mean an end-to-end test. Include the real interaction when a defect depends on multiple callers, persistence, ordering or permissions. A shallow unit check that omits that interaction is insufficient even when it turns green.

Prefer assertions on returned values, observable errors and required side effects over private methods, internal collaborator call order or implementation-shaped snapshots. Check persisted state directly when persistence is part of the requirement; do not forbid such checks categorically. Retain required security, timing and compatibility assertions. Reuse established test boundaries and the project's testing approach without another confirmation round for routine authorized choices.

An implementation refactor that preserves behavior should not require rewriting these expectations. If the only available check couples to internals, explain the limitation and choose a useful bounded check or the existing fallback. Do not add an abstraction solely to make a mock convenient, delete a valid regression test or insist that every test move to one universal boundary.

## Wait for readiness, with a deadline

When a test or fix waits for asynchronous readiness, use the project's existing event, assertion-retry, or condition-wait facility. Observe the actual readiness condition with a finite deadline and a bounded polling interval or cancellable subscription. Bound underlying asynchronous operations too; an outer loop cannot time out a predicate that never returns.

Do not fix a race by increasing a fixed sleep, retrying indefinitely, swallowing unexpected predicate errors, or passing when the deadline expires. On expiry, fail with a bounded explanation of the unmet condition, without sensitive payloads. Record the condition and timeout rationale with the selected check when they are material to reproduction.

Cover both delayed readiness and readiness that never arrives. Prefer the project's fake clock or controlled scheduler so these checks do not depend on wall-clock speed. Reuse existing test utilities rather than adding a general waiting library for a single fix.

Timing can itself be the requirement: debounce, throttle, expiry, and deadline boundaries need explicit elapsed-time assertions. Preserve those assertions and explain their timing values; do not replace them with eventual-readiness assertions.

For concrete examples, read [independent expectations and controlled waiting](references/test-quality-examples.md). The examples are illustrative, not new project requirements. Their executable tests demonstrate the examples' behavior, not that an arbitrary agent will follow the policy.
