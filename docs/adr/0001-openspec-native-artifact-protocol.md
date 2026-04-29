[Previous Page](../active-change-resolver.md) | [Back to Documentation](../README.md)

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
| `/aif-plan` | `openspec/specs`, project context | `openspec/changes/<id>/*` | optional `.ai-factory/state/<id>/*` | Creates OpenSpec-native change in v1 |
| `/aif-explore` | project context, optional `openspec/specs` | none by default | `.ai-factory/state/<id>/explore.md` or equivalent | Research is not canonical unless promoted into OpenSpec artifacts |
| `/aif-improve` | `openspec/changes/<id>/*`, `openspec/specs` | `openspec/changes/<id>/*` | patch summary if needed | Must preserve user edits |
| `/aif-implement` | `openspec/specs`, `openspec/changes/<id>/*`, generated rules, optional OpenSpec `instructions apply` | none | `.ai-factory/state/<id>/implementation/*` | Execution traces are runtime-only and do not require legacy `.ai-factory/plans/<id>/task.md` |
| `/aif-fix` | same as implement plus QA reports from `.ai-factory/qa/<id>/*` | none | `.ai-factory/state/<id>/fixes/*` | Fixes implementation, not specs unless explicitly requested; does not require legacy `.ai-factory/plans/<id>/task.md` |
| `/aif-verify` | `openspec/*`, generated rules | none | `.ai-factory/qa/<id>/*` | Validates OpenSpec before code checks; must not archive |
| `/aif-rules-check` | `openspec/specs`, `openspec/changes/<id>/specs` | none | none | Reads generated rules as derived guidance; never regenerates them |
| `/aif-done` | `openspec/changes/<id>/*`, QA state | `openspec/specs/*` only through OpenSpec CLI archive | `.ai-factory/qa/<id>/done.md`, archive evidence, `.ai-factory/state/<id>/final-summary.md` | Requires passing `/aif-verify`; supports `--skip-specs`; never custom-mutates OpenSpec specs |

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
