[Previous Page](../active-change-resolver.md) | [Back to Documentation](../README.md) | [Next Page](0002-optional-project-context-glossary.md)

# ADR 0001: OpenSpec-native artifact protocol

## Status

Accepted for v1 planning

## Context

AIFHub Extension v1 keeps the AI Factory user experience and command vocabulary while moving canonical change and specification artifacts to an OpenSpec-compatible layout.

Issue #25 and PR #40 established that OpenSpec is an optional CLI adapter, not a required extension dependency. The supported OpenSpec range is `>=1.3.1 <2.0.0`; OpenSpec validation and archive require Node `>=20.19.0`; AIFHub Extension does not install OpenSpec skills or commands; and a missing OpenSpec CLI means degraded AI Factory-only mode, not install failure.

The project needs a stable ownership contract that separates canonical requirements and change intent from runtime execution state.

## Decision

The v1 artifact protocol uses OpenSpec artifacts as the canonical source of truth for requirements, proposed changes, design intent, task plans, and delta specs.

AI Factory artifacts under `.ai-factory/` are runtime, QA, or generated state used to execute and verify work. They are not canonical requirements unless an artifact explicitly says otherwise.

Future AIFHub-owned artifacts under `.aifhub/` are reserved for later registry, evaluation, context, and knowledge-base work. They are outside the v1 OpenSpec-native artifact protocol implementation.

## Artifact ownership

Canonical OpenSpec artifacts:

```text
openspec/specs/
openspec/changes/<change-id>/
  proposal.md
  design.md
  tasks.md
  specs/**/spec.md
```

These files are the source of truth for accepted specs, proposed changes, design decisions, task plans, and change-local spec deltas.

Runtime AI Factory artifacts:

```text
.ai-factory/state/<change-id>/
.ai-factory/qa/<change-id>/
```

These files store execution progress, working notes, QA evidence, verifier findings, and implementation state. They can be deleted or regenerated unless a future ADR or file-local metadata explicitly documents stronger retention semantics.

The configured roadmap, `.ai-factory/ROADMAP.md` by default, is a project context artifact with bounded shared lifecycle ownership. `/aif-roadmap` owns the complete document. `/aif-done` may update only one linked row inside the marker-bounded `OpenSpec Change Lifecycle` block after successful archive; it does not own arbitrary roadmap content.

Generated AI Factory artifacts:

```text
.ai-factory/rules/generated/
  openspec-base.md
  openspec-change-<change-id>.md
  openspec-merged-<change-id>.md
```

Generated rules are derived from OpenSpec specs and change specs. They are not canonical requirements and must be recoverable from canonical OpenSpec artifacts.

Future-reserved AIFHub artifacts:

```text
.aifhub/
  cache/
  context/
  kb/
  skill-runs/
```

These paths are reserved names only in v1. Their detailed behavior is out of scope for this artifact protocol.

## Command read/write matrix

| Command | Canonical reads | Canonical writes | Runtime writes | Notes |
|---|---|---|---|---|
| `/aif-analyze` | project metadata, existing config | optional `openspec/` skeleton only when configured | capability/config reports | Must not install OpenSpec skills |
| `/aif-plan` | `openspec/specs`, project context | `openspec/changes/<id>/*` | optional `.ai-factory/state/<id>/*` | Creates OpenSpec-native change and records explicit roadmap linkage in v1 |
| `/aif-explore` | project context, optional `openspec/specs` | none by default | `.ai-factory/state/<id>/explore.md` or equivalent | Research is not canonical unless promoted into OpenSpec artifacts |
| `/aif-improve` | `openspec/changes/<id>/*`, `openspec/specs` | `openspec/changes/<id>/*` | patch summary if needed | Must preserve user edits |
| `/aif-implement` | `openspec/specs`, `openspec/changes/<id>/*`, generated rules, optional OpenSpec `instructions apply` | none | `.ai-factory/state/<id>/implementation/*` | Execution traces are runtime-only and do not require legacy `.ai-factory/plans/<id>/task.md` |
| `/aif-fix` | same as implement plus QA reports from `.ai-factory/qa/<id>/*` | none | `.ai-factory/state/<id>/fixes/*` | Fixes implementation, not specs unless explicitly requested; does not require legacy `.ai-factory/plans/<id>/task.md` |
| `/aif-verify` | `openspec/*`, generated rules | none | `.ai-factory/qa/<id>/*` | Validates OpenSpec before code checks; must not archive |
| `/aif-rules-check` | `openspec/specs`, `openspec/changes/<id>/specs` | none | none | Reads generated rules as derived guidance; never regenerates them |
| `/aif-roadmap` | active/archived OpenSpec linkage plus local and optional GitHub evidence | none | configured roadmap artifact | Owns full audit and managed `planned` reconciliation |
| `/aif-done` | `openspec/changes/<id>/*`, QA state | `openspec/specs/*` only through OpenSpec CLI archive | `.ai-factory/qa/<id>/done.md`, archive evidence, `.ai-factory/state/<id>/final-summary.md`, then one managed `finalized` roadmap row | Requires passing `/aif-verify`; supports `--skip-specs`; never custom-mutates OpenSpec specs or arbitrary roadmap content |
| `/aif-commit` | staged diff, finalization evidence, configured roadmap, optional GitHub evidence | none | git commit only | Blocks deterministic local lifecycle drift; never writes roadmap or GitHub state |

## Roadmap lifecycle co-ownership

Canonical planning linkage lives in `openspec/changes/<change-id>/proposal.md`:

```markdown
## AIFHub Source Binding

- Provider: <canonical provider or MCP server ID>
- Primary source: <canonical HTTPS work-item URL or stable MCP resource URI>
- External ID: <human-readable provider key>
- Branch: <exact creation branch|none>

## Roadmap Linkage

- Issues: <canonical HTTPS work-item URL(s) or stable MCP resource URI(s)|none>
- Milestone: <exact title|none>
- Roadmap item/slice: <exact item|none>
- Rationale: <bounded explanation>
```

The source-binding section is conditional on MCP work-item identity and separates one immutable full primary source from the many-valued lifecycle linkage. The change ID starts with the normalized external key and a request slug; its exact branch maps that change back to downstream commands before slug heuristics, while a current pointer remains a lower-precedence fallback. Secondary roadmap links and equal external IDs from another provider, tenant, or repository cannot satisfy source collision checks. Explicit `none` values prevent later commands from inventing issue, milestone, or slice ownership. `/aif-roadmap check` turns a valid linked active change into local `planned`; canonical planning and implementation do not claim completion.

The configured roadmap may contain one marker-bounded block:

```markdown
<!-- aifhub:roadmap-change-lifecycle:start -->
## OpenSpec Change Lifecycle
...
<!-- aifhub:roadmap-change-lifecycle:end -->
```

Only local `planned` and `finalized` state belongs inside the block. `/aif-roadmap` owns the document and may reconcile active or archived changes. `/aif-done` co-owns one linked transition to `finalized` only after successful OpenSpec archive. Pre-archive failure leaves the roadmap unchanged; a post-archive roadmap failure preserves truthful archive evidence, does not roll back archive, and returns `/aif-roadmap check`.

`/aif-commit` consumes the lifecycle block read-only. Successful durable finalization plus a missing or non-`finalized` linked row is deterministic local drift and blocks the commit before proposal without a confirmation bypass. Missing or later-changing external evidence remains warning-only by default.

GitHub open/closed/merged state remains a separate evidence clock. A post-merge `/aif-roadmap check` refreshes issue, PR, and milestone observations without using remote state as local finalization proof or rewriting the evidence-backed `finalized` row.

## Generated rules policy

Generated rules are derived from canonical OpenSpec specs and change-local specs. They are not independent requirements.

The generated rules directory is safe to delete and regenerate. If generated rules are missing or stale, the compiler must rebuild them from:

```text
openspec/specs/
openspec/changes/<change-id>/specs/
```

Generated rule output may guide implementation and review, but conflict resolution must defer to canonical OpenSpec artifacts.

The compiler writes exactly these derived files:

```text
.ai-factory/rules/generated/openspec-base.md
.ai-factory/rules/generated/openspec-change-<change-id>.md
.ai-factory/rules/generated/openspec-merged-<change-id>.md
```

OpenSpec-native consumer and gate skills should read these files as execution guidance when present. Read-only gates such as `aif-rules-check` report missing or stale generated rules and ask the caller to regenerate them through the compiler-owning workflow; they do not write generated files themselves.

Runtime consumers such as `/aif-implement` and `/aif-fix` treat generated rules as derived guidance only. When generated rules are missing or stale, they warn and continue from canonical OpenSpec artifacts rather than silently regenerating or treating generated files as source of truth.

## OpenSpec CLI policy

The OpenSpec CLI is optional for extension install and AI Factory-only workflows.

The OpenSpec CLI is required for OpenSpec validate and archive capabilities. The v1 supported range is `>=1.3.1 <2.0.0`, and OpenSpec validate/archive requires Node `>=20.19.0`.

AIFHub Extension must not install OpenSpec skills or commands. If a compatible OpenSpec CLI is missing, OpenSpec-aware commands must degrade gracefully by reporting unavailable validate/archive capabilities instead of failing extension install.

For `/aif-verify`, invalid OpenSpec validation is a hard fail before lint, tests, or review. Missing or unsupported CLI remains degraded mode unless `aifhub.openspec.requireCliForVerify: true` requires strict CLI availability. Verification evidence belongs under `.ai-factory/qa/<change-id>/`, and `/aif-verify` does not archive.

For `/aif-done`, OpenSpec-native archive is the finalizer step after passing `/aif-verify` evidence. It archives through `openspec archive <change-id> --yes` via the shared runner, supports `--skip-specs` for docs/tooling-only changes, writes final evidence under `.ai-factory/qa/<change-id>/`, and writes final summaries under `.ai-factory/state/<change-id>/`. Missing or unsupported OpenSpec CLI fails archive-required finalization. Legacy `.ai-factory/specs` finalization remains AI Factory-only behavior.

## Legacy artifact policy

Legacy `.ai-factory/plans` artifacts are pre-migration planning and execution records. Commands may read them as compatibility inputs and migration sources.

Legacy plan artifacts are not the v1 canonical source of truth once OpenSpec-native artifacts exist for the same change. Any future migration must preserve user edits and avoid silently overwriting canonical OpenSpec artifacts.

The implemented migration path preserves source artifacts, writes migrated canonical artifacts under `openspec/changes/<change-id>/`, and preserves runtime/QA material under `.ai-factory/state/<change-id>/` and `.ai-factory/qa/<change-id>/`.

## AI Factory 2.18 profile amendment

AI Factory 2.18 introduces upstream marked ultra plan and research bundles. This does not create a second canonical source of truth for OpenSpec-native work.

- OpenSpec-native regular and `ultra` planning both write the same canonical OpenSpec artifact set. `ultra` is a version-gated depth profile for `design.md`, `tasks.md`, and delta specs; `index.md`, `phase-*`, and the active ultra marker are forbidden inside canonical changes.
- Legacy classic plan pairs remain migration-compatible. A valid `<!-- aif:plan-mode:ultra -->` bundle remains one atomic upstream-owned directory; AIFHub classifies it before companion discovery and returns exact upstream command handoffs without editing the bundle.
- Regular research remains the resolved `paths.research` file. Explicit 2.18 ultra research lives under `<parent(paths.research)>/research/<slug>/` as non-canonical supporting context. Its marked `INDEX.md`, `RESEARCH.md`, and evidence-gated C4/ADR/graph files must not be written into `openspec/changes/**` or `openspec/specs/**`.
- The only AIFHub write after upstream marked-ultra verification is a bounded receipt under `.ai-factory/state/legacy-ultra-verification/<entrypoint-digest>.json`. It binds the exact entrypoint and bundle digest to Git `HEAD` or a manual build id, a deterministic worktree digest, and the final verify gate. Done/finalizer consumers re-evaluate the binding and never create the receipt.
- In OpenSpec-native mode, plan-mutating `/aif-archive` targets route to `/aif-done <change-id>` before plan discovery. Read-only archive listing and bounded roadmap-only snapshots retain upstream ownership; all legacy archive behavior, including marked ultra, remains upstream-owned in legacy mode.

These rules keep `openspec/changes/<change-id>/` as the sole canonical change ledger while allowing AI Factory 2.18 detail and legacy compatibility without dual-write synchronization.

## Out of scope

- TOON/context/KB
- AIFHub registry/evals
- custom OpenSpec schema work
- OpenSpec skill or slash-command installation
- future AIFHub registry/runtime artifacts under `.aifhub/`

## Consequences

Benefits:

- Gives v1 a single canonical location for requirements and change intent.
- Keeps AI Factory execution state useful without making it authoritative.
- Allows runtime state, QA evidence, and generated rules to be regenerated safely.
- Preserves degraded AI Factory-only mode when the OpenSpec CLI is unavailable.
- Prevents accidental OpenSpec skill or command installation by this extension.

Tradeoffs:

- Commands must distinguish canonical writes from runtime writes.
- Legacy `.ai-factory/plans` consumers need migration or compatibility logic later.
- Generated rules are operational only when the derived files are present and fresh; consumer migrations still need to preserve canonical OpenSpec precedence.
- OpenSpec validate and archive-required done finalization remain unavailable until a compatible external CLI is present.

## See Also

- [Context Loading Policy](../context-loading-policy.md)
- [OpenSpec Compatibility](../openspec-compatibility.md)
- [ADR 0002: Optional Project Glossary](0002-optional-project-context-glossary.md)
