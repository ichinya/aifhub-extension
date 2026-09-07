# Explore follow-up: explicit prior answers

Two fresh Orca workers ran the refined explore scenario on 2026-09-07, one with
baseline instructions and one with the adaptations committed in `7534e4f`.
[Sanitized observations](skill-workflow-explore-followup-results.json) record the
reports' identities, rubric judgments, workspace hashes and unknown runtime fields.

Both workers preserved the supplied answers about the persistence goal, input
format, 1000-row product limit, evidence standard and deliverable. Both returned
the concrete destination question to the parent: external customer service or a
local customer file. They deferred the stored-ID policy until that choice and,
for the service, the missing contract evidence were available. Neither called the
brief confirmation-ready or started full research.

Both actually ran `node --test test/preview.test.mjs`: one test passed in each
context. Neither claimed that preview established persistence or the 1000-row
capacity. The frozen collector found intact task/instruction identities, no
workspace changes and no missing semantic criteria in the parent observations.

The [earlier pilot](skill-workflow-evaluation-results.md) supplied an initial
request without settled brief roots. This follow-up supplies those roots
explicitly, so it is a different scenario, not a before/after quality measurement.
The observations do not justify changing the existing explore interview policy.

## Evidence limits

The comparison remains `INCOMPLETE_NO_IMPROVEMENT_CLAIM`. Only the two explore
slots were executed; all ten prepared matrix slots remain in the manifest. The
other four cases were not rerun. No aggregate pass-rate, speed, cost or improvement
claim is available.

Orca 1.4.197 again reported null effective model/effort. Captured terminal output
displayed `gpt-6-astra xhigh`, which corroborates the display at that moment but
does not establish all launch controls or their assignment-wide stability. The
prepared descriptor keeps model, effort, tools and settings hash null. Collection
records each as unverified; configured defaults are not substituted for evidence.

The structured transcripts include clipped blocks, and terminal output also
collapses tool details. Consequently `inputsVerified` remains false and the
unsupported-check count remains null. File integrity and the observed preview
test are established separately. No parent clarification or correction occurred
inside either assignment. Both owned worker terminals were released.

## Collector and custody

Preparation now automatically preserves the exact collector in its coordinator
folder. This run used that frozen copy after the checkout changed. Independent
review found a string-versus-array equality defect in runtime field evidence; the
fix and regression passed in the checkout. It cannot affect these two observations,
which supply only matching host/version evidence and leave the other fields
unknown. The corrected assessor independently returned the same unverified fields;
both collector hashes are recorded in JSON.

The historical pilot and this run's prepared hashes and immutable receipts were
not rewritten. Synthetic contexts and raw evidence remain in parent-owned temporary
storage; private paths and transcripts are not published here. The current
collector passed 14 focused tests and all extension validators. The preceding
feature commit had passed the full 1382-test suite; that full suite was not rerun
for this evaluation-only follow-up.

The next comparative run still needs host-backed effective settings and complete
action evidence, followed by repeated executions of all five paired scenarios.
