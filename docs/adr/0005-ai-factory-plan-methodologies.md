[Back to Documentation](../README.md)

# ADR 0005: AI Factory owns plans across methodologies and tools

## Status

Target architecture from the user's clarification on 2026-09-05. Adapter contracts,
storage migration, and runtime integration are not implemented by this ADR.
It revises the target ownership of the issue #168 prototype in
[ADR 0004](0004-sdd-profiles-and-session-brief.md). The existing OpenSpec-native
runtime described in ADR 0001 remains the current implementation, not the target
for new methodology-independent planning.

## Problem

AI Factory is always present. Additional tools must work with its plans across
methodologies such as user stories and specification-driven development. Selecting
a tool must not move the authoritative plan or replace its lifecycle owner.

The current SessionBrief prototype requires `artifactProtocol: openspec` and reads
OpenSpec changes directly. Provider integration, now present in the inspected main
at `86b39cc`, also makes `tools.openspec` select the artifact mode and plan/spec
roots in `tool-config.mjs`.
Those behaviors do not satisfy this target. Provider readiness/evidence and exact
revision binding are reusable, but tool selection and artifact ownership need to
be separated before the two implementations are integrated.

## Independent choices

| Choice | Responsibility |
|---|---|
| AI Factory plan | Identity, original request, execution tasks, progress, lifecycle, and references to authoritative planning material |
| Methodology | Required document structure and semantics: stories, acceptance criteria, scenarios, contracts, or another explicitly supported format |
| Public mode | Existing `fast`, `full`, and `ultra` entrypoints and their native plan layouts |
| SDD profile | Planning depth and required context; independent of methodology and additive quality gates |
| Optional tool adapter | Supported reads, representations, validation, proposed edits, and revision-bound results |

A plan selects a primary requirements format and can include several compatible
document types: user stories, scenarios, C4 views, and ADRs can coexist. A tool may
support several formats; a methodology may use several tools. Enabling a tool
does not by itself select a methodology or turn an
ordinary plan into `ultra`. CCC was named as another candidate; its meaning and
format still need clarification, so this ADR assigns it no schema or capabilities.

## Storage and authority

Resolve AI Factory's configured paths. Preserve its documented native entrypoints:

- `fast`: `paths.plan`, default `.ai-factory/PLAN.md`;
- `full`: `paths.plans/<id>.md`, default root `.ai-factory/plans/`;
- `ultra`: `paths.plans/<id>/index.md` with the upstream ultra marker and phase files.

These are forms of the same logical plan ownership. Methodology documents belong
to the plan and are inventoried through exact references. Their physical companion
layout requires an explicit extension contract covering discovery, progress, and
archive; creating an arbitrary directory must not make upstream classify it as
an ultra bundle. Respect custom paths instead of resetting them when tools change.

The plan records its stable identity, source binding, original request, selected
methodology and format version, public mode/profile, task identities, acceptance
references, and document inventory. Methodology-specific content stays in its
native structured form; the common interface must not flatten it into prose and
discard semantics. Define these additions as extension metadata with a documented
reader/writer contract, not as fields already supported by upstream AI Factory.

Each task has one authoritative progress state. An adapter may expose task IDs or
checkboxes in a tool-specific view, but the mapping must resolve back to those
tasks. A successful tool run cannot independently mark the AI Factory plan done.

Long-lived accepted project specifications can remain at configured `paths.specs`,
linked by the plan. The existing classic `.ai-factory/specs/<plan-id>/` archive
must be migrated before that root can hold accepted capability specifications;
the two meanings of `spec.md` are not interchangeable. Runtime state, SessionBrief,
and QA/provider evidence remain
derived artifacts associated with the plan. Keeping all planning material owned
by AI Factory does not require copying shared specifications and transient
evidence into every plan or confusing them with editable requirements.

## Adapter contract

All consumers, including SessionBrief and optional providers, resolve a common
plan context before choosing methodology-specific behavior. Its contract needs:

- stable plan identity, exact source binding, and resolved native entrypoint;
- methodology ID/version and public mode/profile;
- authoritative requirements, tasks, acceptance examples, constraints, and scope
  references, with the native content available at full fidelity;
- an exact source inventory and revision digest;
- declared tool capabilities, supported methodology versions, and mappings to
  native artifact identities.

If a tool can consume the authoritative documents at configured paths, use that
supported mechanism. If it requires its own directory or schema, an adapter must
produce a derived native representation and record its source revision and ID
mapping. Moving Markdown into a familiar-looking folder is not interoperability.
The adapter must verify the tool's real path, schema, and lifecycle requirements.

Tool-authored changes return as proposed edits for the owning planning workflow,
bound to the source revision. Divergent revisions require reconciliation before
application; do not silently synchronize two independently editable copies.
Unsupported formats or lossy mappings report unsupported explicitly. An optional
tool can be omitted unless project policy requires its capability; required
validation remains blocking when unavailable.

OpenSpec validation/apply/archive integration therefore needs a specific adapter:
its native changes and accepted-spec updates must map to the AI Factory plan and
specification lifecycle. Until that mapping is implemented and verified, the
current OpenSpec-native path is compatibility behavior, not proof of support for
this target architecture. HLV/Lekalo capabilities likewise come from verified
provider contracts, not from listing their names in a plan.

## Consequences for issue #168

1. Introduce the common plan resolver and versioned methodology interface before
   making SessionBrief generally available across planning formats.
2. Move OpenSpec-specific discovery and artifact requirements into its adapter.
   Core profile selection uses reviewed facts and project policy. A requirement
   for delta specs belongs to the OpenSpec methodology, not every user story.
3. Compile SessionBrief from the resolved plan context. Bind its digest to both
   the source revision and methodology/adapter contract versions. Preserve full
   task, requirement, rule, and source identity instead of copying provider output.
4. Make provider switches independent of plan ownership and configured paths.
   Preserve exact evidence binding and apply capabilities to the resolved plan.
5. Define an explicit compatibility/migration path for existing OpenSpec changes
   and AI Factory plan forms. Preserve task completion, original requests, source
   bindings, links, and accepted specification history across the transition.

This requires runtime changes in both the SessionBrief and provider integrations.
The current OpenSpec-only P0 tests establish prototype behavior; they do not
establish acceptance of the revised architecture.

## Acceptance evidence for implementation

- AI Factory plans work with no optional tool, including configured custom paths.
- Switching optional tools preserves plan identity, paths, content, and progress.
- Every claimed methodology has real fixtures and retains its distinct semantics.
- Fast, full, and marked-ultra discovery, implementation, verification, and archive
  retain their upstream contracts; companion documents follow their owning plan.
- Real tool runs consume the intended revision; stale representations/results and
  conflicting tool edits cannot pass as current evidence.
- Source/task/specification edits invalidate SessionBrief and affected provider
  evidence; no tool result creates a second authoritative completion state.
- Existing OpenSpec work has a tested compatibility or migration route preserving
  source bindings, task state, and accepted specifications.

## Sources

- [AI Factory configuration](https://github.com/lee-to/ai-factory/blob/2.x/docs/configuration.md)
- [AI Factory plan files and bundles](https://github.com/lee-to/ai-factory/blob/2.x/docs/plan-files.md)
- [AI Factory extension contract](https://github.com/lee-to/ai-factory/blob/2.x/docs/extensions.md)
- [Existing OpenSpec ownership](0001-openspec-native-artifact-protocol.md)
- [Issue #168 prototype](0004-sdd-profiles-and-session-brief.md)
- [Post-merge storage audit and proposed location/retention map](../artifact-storage-audit.md)
