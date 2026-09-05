[Back to Documentation](../README.md)

# ADR 0004: SDD profiles and derived SessionBrief

## Status

OpenSpec-only prototype for issue #168, P0. P1/P2 acceptance remains separate.
The user's subsequent requirement that AI Factory own plans across methodologies
revises the target architecture in [ADR 0005](0005-ai-factory-plan-methodologies.md).
The code described here still requires OpenSpec and needs the common plan/adapter
integration before it satisfies that requirement.

## Decision

Keep public `/aif-plan` tokens `fast | full | ultra` unchanged. Store planning depth
in a separate `profile` field. Use `expanded` for the deeper full-mode profile to
avoid an ambiguous internal profile named `full`.

| Profile ID | Recommended public mode | Contract |
|---|---|---|
| `direct` | `fast` | Trivial non-behavioral one-file work; upstream owns the fast path |
| `quick` | `full` | Compact canonical proposal/tasks and behavioral delta specs; conditional design |
| `standard` | `full` | Multiple modules or more than five expected files; include design |
| `expanded` | `full` | Public API, migration, irreversible/security-sensitive work, or multiple repositories; include design |
| `ultra` | `ultra` | Existing AI Factory >=2.18 depth/version contract; include design |
| `tracer` | `full` | Reserved for P1; no executable tracer selection in P0 |
| `research` | none | Missing facts, unclear requirements, or architecture uncertainty; return to explore |

These are AIFHub SDD profiles, independent of OpenSpec's own CLI profiles. The
selector never changes a public mode token. A mode mismatch returns an owner
handoff. A caller who explicitly chose `full` for otherwise direct work retains
canonical planning as `quick`. Architecture uncertainty goes to `research` in P0;
it must not pretend a tracer lifecycle has already shipped.

Select from reviewed structured facts in a conditional `## SDD Profile Inputs`
section of the canonical proposal. The compiler does not infer safety from request
length or model confidence. Missing values mean unknown. The public pure selector
can evaluate the same facts before `/aif-plan` creates artifacts, including the
direct fast-path handoff. Canonical content creation stays with `/aif-plan`.

Project policy may add a stronger minimum profile, require design, add gates, and
name exact supporting context references in `.ai-factory/sdd-policy.json`.
This optional file is project configuration, not a generated decision. The helper
never creates or modifies it. Configured project gates and canonical schema
requirements remain authoritative even when absent from the overlay gate list.
`project_policy`, `tests`, `verify`, and `done` remain required checks for every
depth. Security and migration facts add their respective checks. No profile
grants tools, network, permissions, or human approval.

The selected OpenSpec schema and existing validation policy determine required
canonical artifacts. `quick` reduces prose and planning rounds; a conditional
design must still be created when the schema or project policy requires it.
Successful brief compilation certifies source binding only, not canonical schema
validation, completed tests, or readiness.

## Runtime ownership and revisions

The compiler writes exactly:

- `.ai-factory/state/<change-id>/sdd/profile-decision.json`
- `.ai-factory/state/<change-id>/context/session-brief.json`
- `.ai-factory/state/<change-id>/context/session-brief.md`

The brief extracts selected sections without LLM calls. It hashes exact file
bytes, records a sorted input inventory, and computes a deterministic scope
fingerprint and digest. It references tasks, requirements/scenarios, rules, policy,
and architecture at full fidelity. It does not copy the raw Original Request,
research/provider transcripts, QA verdicts, or hidden reasoning. The planner must
keep selected sections free of secrets; the compiler also rejects recognizable
credential patterns rather than attempting lossy redaction.

`status` and `show` rebuild the expected representation in memory and compare both
stored brief forms and the decision. Changes, additions, deletions, malformed
content, tampering, and partial writes prevent valid reuse. No mtime, timestamp,
model output, or locale ordering participates in the digest. Identical compile
inputs do not rewrite existing outputs.

Implementation checks status before editing and supplies the consumed digest to
`writeExecutionTrace()`. The trace writer rechecks it before writing. Write the
trace before marking canonical task checkboxes: checkbox edits intentionally
invalidate the exact task revision and require recompilation before the next
task/session. A material canonical revision requires the normal planning owner
workflow; a new brief alone never authorizes expanded scope.

Missing helpers preserve the existing canonical workflow only for changes that
have not opted into SDD. For an opted-in change, return a planning-owner handoff
when the helper cannot validate its binding. Read-only gates never compile briefs.
No new content is written under `openspec/**`, QA, or generated rules by this helper.

## Consequences

This P0 supplies quick/standard/research behavior, deterministic deeper-profile
selection, and exact implementation binding without an external SDD framework.
It conservatively invalidates briefs for any byte change, including progress-only
task edits, and hashes all accepted base specs rather than guessing relevance.

P1 owns compliance/drift receipts, fresh-context reviewer execution, tracer
promotion, and richer measured context policy/metrics. P2 owns cross-project
exchange and evaluation adapters. This implementation does not claim those flows
or change existing verification/finalization semantics.

## References

- [Issue #168](https://github.com/ichinya/aifhub-extension/issues/168)
- [SessionBrief usage and schemas](../sdd-profiles.md)
- [OpenSpec artifact ownership](0001-openspec-native-artifact-protocol.md)
- [Source-reviewed OpenSpec compatibility](../openspec-compatibility.md)
- [OpenSpec schema definition](https://github.com/Fission-AI/OpenSpec/blob/main/schemas/spec-driven/schema.yaml)
