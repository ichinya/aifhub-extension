[Back to Documentation](README.md)

# SDD profiles and SessionBrief (P0)

Implementation status: this is an OpenSpec-only prototype. The revised target in
[ADR 0005](adr/0005-ai-factory-plan-methodologies.md) makes AI Factory the plan owner
across methodologies and optional tools. Its common plan resolver and adapters
are not implemented yet; the instructions below describe the existing prototype.

SDD profiles choose planning depth independently of quality gates. Public planning
tokens remain `fast | full | ultra`; `quick` and `standard` use `full` canonical
planning. See [ADR 0004](adr/0004-sdd-profiles-and-session-brief.md) for the complete
mapping, selection order, ownership, and later-phase boundaries.

## Planning contract

For a new SDD-managed canonical change, `/aif-plan` records reviewed facts once in
`proposal.md`, alongside its existing source-template sections. Do not alter
`## Original Request` or invent unknown facts. Omit unknown signal fields or use
`null`; either produces a `research` decision. Use the actual public planning mode.

````markdown
## SDD Profile Inputs

```json
{
  "planning_mode": "full",
  "behavior_change": true,
  "modules": 1,
  "repositories": 1,
  "public_api": false,
  "data_migration": false,
  "reversible": true,
  "security_sensitive": false,
  "architecture_novelty": false,
  "requirements_clear": true,
  "expected_files": 2
}
```

## Non-goals

- No storage or public API changes.

## Acceptance Examples

| Given | When | Then |
|---|---|---|
| a valid input | the handler runs | return its result |

## Allowed Change Surface

- src/handler.mjs
- test/handler.test.mjs

## Forbidden Change Surface

- storage/**

## Verification Plan

- Run the focused behavior check and all project-required checks.
````

`Allowed Change Surface` is required for an executable brief. Behavioral changes
also need delta specs, non-goals, and acceptance examples. `Acceptance Criteria`,
`Constraints`, `Assumptions`, `Forbidden Change Surface`, and `Verification Plan`
are extracted from proposal/design only when useful. These sections supplement
the exact OpenSpec headings and formal requirements/scenarios. Do not add empty
boilerplate. An active nonempty `Open Questions` section blocks implementation;
omit it once the questions are resolved instead of writing a placeholder.

Quick requires proposal and tasks plus delta specs for behavior changes. Design
is conditional: satisfy the selected OpenSpec schema and project policy before
handoff. Standard, expanded, and ultra require design. Docs/tooling-only work may
omit delta specs through the existing explicit no-spec explanation/metadata
workflow; it must not invent product architecture. Direct returns upstream fast
ownership without generating a canonical change or a brief.

## Optional additive project policy

An existing project can opt in through `.ai-factory/sdd-policy.json`, with reviewed
per-change inputs still required. It can also use only the proposal section with
the default policy. Projects with neither opt-in retain the existing workflow.

```json
{
  "schema": "aifhub.sdd_policy.v1",
  "minimum_profile": "standard",
  "required_gates": ["review", "security", "human_review"],
  "require_design": true,
  "context_refs": ["docs/integration-contract.md"]
}
```

The `required_gates` list only adds requirements. It cannot remove project tests,
security, rules, migration/rollback evidence, human review, `/aif-verify`, or
`/aif-done` policy. The baseline `project_policy` check requires resolving the full
project config/rules; this list is not a substitute policy engine. Existing
`aifhub.openspec.requireDesign` also applies. Context references must be regular,
project-relative Markdown files; transcript, credential, runtime, QA, and provider
output locations are not accepted. No automatic provider execution is involved.

## Installed commands

After canonical planning and `/aif-mode sync --change <change-id>`:

```bash
ai-factory aifhub-session-brief compile --change 168-bounded-change --json
ai-factory aifhub-session-brief status --change 168-bounded-change --json
ai-factory aifhub-session-brief show --change 168-bounded-change
```

Explicit `--change` is recommended for automation. Otherwise the existing active
change resolver applies; unresolved or ambiguous selection performs no writes.
`compile` writes only the profile decision and both brief forms in runtime state.
For research/direct or missing canonical content it may write the decision and
return a blocking owner handoff; it does not invent or repair canonical artifacts.
`status` and `show` are read-only. `show` exposes brief content only when current.
Metadata/diagnostics contain paths, hashes, and fixed reason codes, without raw
requests, provider output, credentials, or exception messages.

Exit `0` means a valid result (or a disabled overlay on an existing unopted change),
`1` means missing/stale/blocked context, and `2` means invalid arguments, unresolved
scope, unsafe/malformed input, or an I/O failure. JSON commands emit one JSON object
on stdout and no diagnostic stderr. An unchanged compile reports `written: false`.

## Source binding and implementation

The compiler reads exact proposal/design/tasks/metadata and delta-spec bytes,
accepted base specs, config, local OpenSpec schemas/templates, AI Factory version
metadata, project/generated rules, and configured architecture/context/review
references. Missing optional files are detected when later added through inventory
rebuilding. Removed or changed sources invalidate the brief. A JSON/Markdown
pair or decision from a different revision also fails validation.

`buildImplementationContext()` validates an opted-in change before runtime layout
creation, exposes its current `sessionBrief`, and blocks stale/missing/research
contexts. For a current brief, its canonical/generated-rule entries contain
hashed full-fidelity references instead of duplicated bodies. The implementer reads the brief and resolves full canonical/task/spec
and policy references for the selected task. Supply its digest as
`trace.sessionBriefDigest` to `writeExecutionTrace()`; missing, wrong, or stale
digests fail before trace writes. Write the trace before changing canonical task
checkboxes. Compile again after progress changes, sync, or owner-approved planning
edits before the next task or session.

A brief is context selection, not authorization or QA evidence. Existing source,
permissions, rules, OpenSpec validation, and verification remain authoritative.
No configured gate is weakened by quick planning. `/aif-review` and `/aif-verify`
may read a current brief, but must resolve protected sources in full. If it is
stale or the helper is unavailable on an opted-in change, return an owner handoff;
read-only gates do not rebuild it themselves. For unopted changes with no SDD
runtime artifacts, missing helpers retain canonical filesystem fallback.

## Limits and later phases

The compiler is extractive and deterministic, with no semantic rewriting of
protected sources. It copies only selected proposal/design sections; other inputs
remain exact hashed references. Task/spec/rules/policy references use `fidelity:
full`. QA artifacts such as `aif-gate-result`, `coverage.json`, `done-readiness.json`,
and verification receipts stay with their existing readers at full fidelity;
they are not reserialized into the brief or claimed as compiler evidence.

Before writing a brief, the compiler also ensures a missing
`.ai-factory/state/.gitignore` with `*` and `!.gitignore`. Existing ignore rules
are preserved. This file is storage policy, not a brief source or quality gate;
read-only status/show do not create or repair it.

Reads and outputs are bounded to 2 MiB per file, with 1,024 source files and 32 MiB
total source bytes. Linked files, symlinks/junctions, path escapes, malformed JSON,
duplicate decoded keys, duplicate active sections, and identifiable selected
credentials fail closed. These limits bound local I/O; they are not percentages
of a model context window. `budget.source_bytes` is measured, while unknown token
and rendered-brief metrics remain `null`. The compiler does not guess model limits.

P0 includes quick/standard/research execution contracts and selection/version
checks for direct/expanded/ultra. P1 compliance receipts, fresh-context AI reviewer
execution, tracer promotion, and richer context metrics are not implemented here.
P2 cross-project adapters and evaluation remain separate. Crit human review and
existing QA ownership are unchanged.

## Schemas

- [Profile inputs](../schemas/sdd-profile-inputs.schema.json)
- [Project policy](../schemas/sdd-policy.schema.json)
- [Profile decision v1](../schemas/sdd-profile-decision.schema.json)
- [SessionBrief v1](../schemas/session-brief.schema.json)
