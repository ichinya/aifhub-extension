# AIFHub Extension

AIFHub Extension adds an OpenSpec-native artifact protocol to the AI Factory CLI user experience.

The v1 workflow keeps AI Factory commands as the user-facing path and uses OpenSpec artifacts as the canonical source of truth for specs and changes:

```text
AI Factory UX + OpenSpec artifact protocol
```

## What This Extension Does

- Keeps `/aif-analyze`, `/aif-plan`, `/aif-explore`, `/aif-improve`, `/aif-implement`, `/aif-rules-check`, `/aif-review`, `/aif-security-checklist`, `/aif-verify`, `/aif-fix`, `/aif-done`, `/aif-commit`, `/aif-evolve`, and `/aif-mode` as the public command vocabulary.
- In OpenSpec-native mode, writes canonical change artifacts under `openspec/changes/<change-id>/` and accepted specs under `openspec/specs/`.
- Keeps AI Factory runtime state, verification evidence, finalization evidence, and generated rules outside canonical OpenSpec changes.
- Requests OpenSpec validation, status, instructions, and archive through the AIFHub wrapper and `scripts/openspec-runner.mjs` when a compatible CLI is available.
- Preserves legacy AI Factory-only plan folders as compatibility and migration input only.
- Publishes namespaced Codex CLI and Claude agent files through the extension manifest for explicit user or orchestrator invocation.
- Publishes an optional `aifhub` MCP server whose settings are rendered by AI Factory per runtime.
- Documents upstream project-context utilities such as `/aif-architecture`, `/aif-roadmap`, `/aif-docs`, `/aif-qa`, `/aif-archive`, and `/aif-distillation` with AIFHub write-boundary guardrails.
- Does not install OpenSpec skills or slash commands.

## Quick Start

Install the extension:

```bash
ai-factory extension add https://github.com/ichinya/aifhub-extension.git
ai-factory update
ai-factory extension update aifhub-extension
```

Bootstrap project context:

```text
/aif-analyze
```

Inspect or switch artifact mode:

```text
/aif-mode status
/aif-mode openspec
/aif-mode sync
```

Confirm or request OpenSpec-native mode when bootstrapping a v1 OpenSpec workflow. The expected config marker is:

```yaml
aifhub:
  artifactProtocol: openspec
```

On first bootstrap, when `.ai-factory/config.yaml` is missing and you did not explicitly ask for OpenSpec-native mode, `/aif-analyze` asks which artifact protocol to use: `legacy AI Factory-only` or `OpenSpec-native`. Existing configs are preserved without that question. If the run is autonomous and cannot ask, it defaults to legacy AI Factory-only and reports OpenSpec-native mode as an open question.

Create and refine a change:

```text
/aif-plan full "add OAuth login"
/aif-improve add-oauth-login
/aif-mode sync --change add-oauth-login
```

Implement, check optional gates, verify, fix if needed, finalize, sync, commit, and optionally evolve:

```text
/aif-implement add-oauth-login
/aif-mode sync --change add-oauth-login
/aif-rules-check
/aif-review
/aif-security-checklist
/aif-verify add-oauth-login
/aif-fix add-oauth-login
/aif-verify add-oauth-login
/aif-mode doctor --change add-oauth-login
/aif-done add-oauth-login
/aif-mode sync
/aif-commit
/aif-evolve
```

Core AI Factory workflow:

```text
/aif-explore
/aif-plan full "..."
/aif-improve <change-id>
/aif-implement <change-id>
/aif-verify <change-id>
/aif-commit
/aif-evolve
```

OpenSpec validation overlay:

```text
/aif-mode sync --change <change-id>
/aif-rules-check
/aif-review
/aif-security-checklist
/aif-mode doctor --change <change-id>
/aif-done <change-id>
```

`/aif-done` finalizes the OpenSpec lifecycle. It archives the accepted OpenSpec change through the OpenSpec CLI when archive is required and writes final evidence under `.ai-factory/qa/<change-id>/` plus final summaries under `.ai-factory/state/<change-id>/`.

A dirty workspace is blocking by default before `/aif-done`. Inspect with `git status --short`; commit or stash unrelated changes, or rerun `/aif-done <change-id> --record-dirty-state` when the current dirty state should be recorded in final QA evidence before archive.

It does not replace `/aif-commit`. After `/aif-done`, run `/aif-commit` or your normal git workflow to commit implementation changes, OpenSpec archive/spec changes, QA evidence, and final summaries.

### AI Factory 2.17 Reviewed Baseline

AIFHub is reviewed against AI Factory `2.17.0` while retaining the compatibility range `>=2.11.0 <3.0.0`. The cumulative `2.16`/`2.17` adaptation keeps upstream skills as command owners and adds only AIFHub-owned OpenSpec boundaries:

- Planning preserves explicit input as immutable `## Original Request`; research-backed plans use a revision-bound `## Research Context` and report `WARN [research-drift]` instead of silently rebasing scope. See [Usage](docs/usage.md) and [Context Loading Policy](docs/context-loading-policy.md).
- Post-verify fixes use the same targeted regression check before and after the edit and keep the result as supporting runtime evidence; `/aif-verify` remains authoritative. See [Usage](docs/usage.md).
- `/aif-qa-check` consumes branch-scoped `test-cases.md` and writes branch-scoped `qa-check.md`; it does not satisfy AIFHub verify, coverage, done, or archive gates. See [OpenSpec Compatibility](docs/openspec-compatibility.md).
- AI Factory `2.16+` Universal / Other MCP rendering uses `.mcp.json` with `mcpServers`; older compatible runtimes are not promised this rendering. See [AIFHub MCP](docs/aifhub-mcp.md).
- `aif-analyze` may add a project-specific `Control Flow` base rule only when repository evidence supports it. Generated OpenSpec rules remain a separate derived layer.

The full tag audit and reviewed no-ops are recorded in [OpenSpec Compatibility](docs/openspec-compatibility.md): upstream architecture refinements remain upstream-owned, generated-rules compilation is not duplicated, community-extension docs are not copied, and legacy custom fix-plan cleanup remains upstream-owned.

AI Factory 2.13+ owns generic active plan `## Commit Plan` grouping in `/aif-commit`. AIFHub must not duplicate that grouping logic, and `/aif-commit` remains the only commit owner; `/aif-done` finalizes OpenSpec lifecycle evidence but does not create git commits.

The AIFHub `aif-commit` injection is only a read-only roadmap/GitHub freshness overlay. In OpenSpec-native mode, if an active OpenSpec change is available, commit planning should use `openspec/changes/<change-id>/tasks.md` as the source that may contain `## Commit Plan`. If no active change/plan resolves, keep upstream staged-diff behavior.

AI Factory 2.13+ includes `/aif-distillation`. It is an upstream utility skill for turning books, docs, folders, or URLs into reusable Agent Skills. It is not an AIFHub lifecycle stage, does not create OpenSpec changes, and must not write `openspec/changes/**`, `openspec/specs/**`, `.ai-factory/qa/**`, or `.ai-factory/rules/generated/**`. It writes generated skill packages to the current agent skills directory.

Upstream project-context utilities remain available with AIFHub guardrails. `/aif-architecture` writes project-level architecture context at `paths.architecture` plus limited pointers in `paths.description` and root `AGENTS.md`. `/aif-docs` writes the root `README.md`, the configured `paths.docs` directory, and documentation entries in `AGENTS.md`. `/aif-qa` writes upstream manual QA artifacts under `paths.qa/<branch-slug>/`, distinct from AIFHub verification/finalization evidence under `.ai-factory/qa/<change-id>/`. These commands are not required per-change OpenSpec lifecycle gates and must not create canonical OpenSpec changes/specs, generated rules, or AIFHub runtime evidence.

AI Factory 2.14+ includes upstream `/aif-archive` and `paths.archive`, with default archive root `.ai-factory/archive/`. That command is legacy AI Factory-only plan cleanup: completed `paths.plans/*.md` files move to `paths.archive/plans/*.md`, optional roadmap snapshots can be written under `paths.archive/roadmap/`, and archived plans are excluded from active sequential plan numbering and discovery. AIFHub does not route `/aif-archive` to `openspec archive`, and `/aif-archive` must not write `openspec/changes/**`, `openspec/specs/**`, `.ai-factory/qa/**`, `.ai-factory/state/**`, or `.ai-factory/rules/generated/**`.

AI Factory 2.15+ preserves managed agent config files during update/init workflows and can offer newly available built-in skills interactively during update. AIFHub documents this as upstream installer/update behavior only; it does not make AIFHub the owner of OpenSpec canonical artifacts, generated rules, or project-specific agent config files.

Useful AIFHub source examples:

```text
/aif-distillation docs/memory-tools-research --name aifhub-memory-tool-selection
/aif-distillation docs/context-providers.md --name aifhub-context-providers
```

Validation gates:

- Optional before verify in relaxed/manual workflow.
- Required before `/aif-done` when done policy requires durable gate evidence.

- `/aif-rules-check` - read-only rules compliance.
- `/aif-review` - read-only code review.
- `/aif-security-checklist` - read-only security gate.
- `/aif-mode doctor` - mode/config/artifact readiness.
- `/aif-mode sync` - derived artifact refresh and OpenSpec validation/status when available.

## Bug Fix Workflows

OpenSpec-native mode has two distinct bug-fix workflows.

### Workflow A: New Bug Report

A new bug report starts as planned OpenSpec work:

```text
/aif-plan full "fix <bug description>"
/aif-improve <change-id>
/aif-mode sync --change <change-id>
/aif-implement <change-id>
/aif-rules-check                  # optional
/aif-verify <change-id>
/aif-done <change-id>
/aif-mode sync
/aif-commit
```

- A bug fix is still an OpenSpec change when it changes product or workflow behavior.
- Create delta specs when behavior changes.
- Docs/tooling-only bug fixes may omit delta specs only when the proposal explains why no product or workflow behavior changes.
- Missing OpenSpec CLI means degraded validation, not planning failure.
- No OpenSpec-native bug-fix path creates `.ai-factory/plans/<id>/`.

### Workflow B: Fix After Failed Verification

`/aif-fix` is for findings inside an existing active OpenSpec change:

```text
/aif-verify <change-id> -> fail
/aif-fix <change-id>
/aif-mode sync --change <change-id>     # optional if canonical artifacts changed
/aif-rules-check                        # optional
/aif-verify <change-id>
```

- `/aif-fix` requires existing QA evidence or selected findings.
- `/aif-fix` does not create a new OpenSpec change.
- `/aif-fix` writes fix traces under `.ai-factory/state/<change-id>/fixes/`.
- `/aif-fix` does not write QA verdicts.
- `/aif-fix` does not archive.
- `/aif-fix` routes back to `/aif-verify <change-id>`.
- No OpenSpec-native bug-fix path creates `.ai-factory/plans/<id>/`.

## Artifact Layout

OpenSpec-native v1 uses this ownership model in user projects:

```text
openspec/
  specs/
    <capability>/spec.md
  changes/
    <change-id>/
      proposal.md
      design.md
      tasks.md
      specs/
        <capability>/spec.md

.ai-factory/
  state/
    <change-id>/
      implementation/
      fixes/
      final-summary.md
      migration-report.md
  qa/
    <change-id>/
      verify.md
      coverage.json
      openspec-validation.json
      openspec-status.json
      openspec-archive.json
      done.md
      raw/
  rules/
    generated/
      openspec-base.md
      openspec-change-<change-id>.md
      openspec-merged-<change-id>.md
      openspec-rules-trace-<change-id>.json
      index.json
```

| Path | Ownership |
|---|---|
| `openspec/specs` | Canonical current behavior |
| `openspec/changes` | Canonical proposed changes |
| `.ai-factory/state` | Runtime execution traces and summaries |
| `.ai-factory/qa` | Verification and finalization evidence |
| `.ai-factory/rules/generated` | Derived rules, safe to regenerate |
| `.ai-factory/plans` | Legacy compatibility and migration input only |

The `aifhub-extension` package repository stays artifact-light. Root `openspec/`, `.ai-factory/state/`, `.ai-factory/qa/`, `.ai-factory/plans/`, and `.ai-factory/rules/generated/` are created in user projects and are not shipped as extension package content. Root `.ai-factory/rules/generated/` is derived and safe to regenerate. OpenSpec examples in this repo belong only under fixture paths such as `test/fixtures/` or `scripts/fixtures/`; extension behavior requirements are validated by prompt contracts and tests, not by committed root OpenSpec specs.

## Manifest And Metadata

`extension.json` is the strict upstream AI Factory extension manifest. It declares:

```json
"$schema": "https://raw.githubusercontent.com/lee-to/ai-factory/2.x/schemas/extension.schema.json"
```

AIFHub-owned metadata lives in `aifhub-extension.json` and is validated by `schemas/aifhub-extension.schema.json`. This keeps private fields such as `compat` and `sources` out of the upstream manifest while preserving local compatibility and provenance checks.

## OpenSpec Compatibility

OpenSpec is optional for extension install and AI Factory-only workflows.

| Capability | Requirement |
|---|---|
| AI Factory extension install/use | `ai-factory >=2.11.0 <3.0.0` from `aifhub-extension.json -> compat.ai-factory` |
| OpenSpec-native validation/archive | OpenSpec CLI `>=1.3.1 <2.0.0` |
| OpenSpec CLI runtime | Node `>=20.19.0` |
| OpenSpec skills/commands | Not installed by this extension |

The reviewed OpenSpec baseline is OpenSpec `1.4.1`, while the compatible CLI range remains `>=1.3.1 <2.0.0`. See [OpenSpec Compatibility](docs/openspec-compatibility.md) for the OpenSpec 1.4.1 reviewed baseline, `openspec update` boundary, and adapter-only ownership notes.

When the OpenSpec CLI is missing or unsupported, OpenSpec-aware commands report degraded validate/archive capabilities. Planning and filesystem-based context loading can continue, but archive-required `/aif-done` fails until a compatible CLI is available.

If the OpenSpec CLI is present but outside `>=1.3.1 <2.0.0`, update or reinstall the CLI before relying on validation/archive. The bootstrap still reports this as degraded capability rather than an install failure.

OpenSpec CLI integration is adapter-only: users keep calling `/aif-plan`, `/aif-improve`, `/aif-implement`, `/aif-verify`, `/aif-done`, and `/aif-mode`; the extension never installs OpenSpec command skills.

OpenSpec can be initialized without tool integrations:

```bash
openspec init --tools none
```

That command is optional and is not run by the extension installer.

See [OpenSpec Compatibility](docs/openspec-compatibility.md) for supported versions, capability flags, and degraded-mode behavior.

## Legacy Migration

Existing `.ai-factory/plans` artifacts are legacy AI Factory-only records. Migrate them explicitly before using the OpenSpec-native flow for that work:

```bash
ai-factory aifhub-migrate-legacy-plans --list
ai-factory aifhub-migrate-legacy-plans <change-id> --dry-run
ai-factory aifhub-migrate-legacy-plans <change-id>
```

The migration writes canonical artifacts under `openspec/changes/<change-id>/`, preserves runtime material under `.ai-factory/state/<change-id>/`, preserves QA material under `.ai-factory/qa/<change-id>/`, and never silently deletes legacy source files.

See [Legacy Plan Migration](docs/legacy-plan-migration.md) for collision modes, validation behavior, and the full artifact map.

## Mode Switching

`/aif-mode` is the extension-owned mode controller:

```text
/aif-mode status
/aif-mode openspec
/aif-mode ai-factory
/aif-mode sync
/aif-mode doctor
```

Switching to OpenSpec-native mode updates `.ai-factory/config.yaml`, ensures `openspec/config.yaml`, `openspec/specs/`, `openspec/changes/`, `.ai-factory/state/`, `.ai-factory/qa/`, and `.ai-factory/rules/generated/`, detects legacy plans, compiles generated rules, validates changes when a compatible CLI is available, and writes a report under `.ai-factory/state/mode-switches/`.

Switching to AI Factory-only mode updates the legacy path profile and preserves `openspec/`. Use `--export-openspec` only when compatibility legacy artifacts are needed from OpenSpec changes.

## Troubleshooting

| Symptom | Action |
|---|---|
| OpenSpec CLI missing | Continue in degraded mode for planning or install a compatible `openspec` CLI before validation/archive-required finalization. |
| Node too old | Use Node `>=20.19.0` for OpenSpec validation/archive. |
| Invalid delta spec | Fix `openspec/changes/<change-id>/specs/**/spec.md`, then rerun `/aif-verify <change-id>`. |
| Ambiguous active change | Pass an explicit `<change-id>` or update `.ai-factory/state/current.yaml`. |
| Missing or stale generated rules | Regenerate derived rules from OpenSpec specs before relying on rules guidance. |
| Missing or stale coverage | Rerun `/aif-verify <change-id>` to refresh `.ai-factory/qa/<change-id>/coverage.json` before `/aif-done`. |
| Dirty working tree before `/aif-done` | Inspect with `git status --short`; commit or stash unrelated changes, or rerun `/aif-done <change-id> --record-dirty-state` to record the dirty workspace in final QA evidence before archive. |

## Documentation

| Guide | Description |
|---|---|
| [Documentation Index](docs/README.md) | Reading order and docs map |
| [Usage](docs/usage.md) | Full command flow, read/write boundaries, upstream project-context utilities, examples, and troubleshooting |
| [Context Providers](docs/context-providers.md) | Optional Graphify and Context7 provider guidance, reviewed-note paths, degraded behavior, and user-owned setup boundaries |
| [Memory Tool Recommendations](docs/memory-tool-recommendations.md) | Local metadata-driven optional memory/context tool recommendations and installed wrapper commands |
| [Context Loading Policy](docs/context-loading-policy.md) | Consumer context, optional provider context, GitHub-aware roadmap evidence, command ownership, upstream utility boundaries, and legacy boundaries |
| [OpenSpec Compatibility](docs/openspec-compatibility.md) | Optional CLI adapter policy, OpenSpec 1.4.1 reviewed baseline, AI Factory 2.17 planning/fix/QA/MCP/Control Flow adaptations, reviewed no-ops, archive boundary, and capability flags |
| [OpenSpec Artifact Validation](docs/openspec-validation.md) | Read-only AIFHub contract validator for OpenSpec-native artifacts |
| [OpenSpec Coverage Matrix](docs/spec-coverage.md) | Requirement-to-code coverage artifact and verify/done policy |
| [Legacy Plan Migration](docs/legacy-plan-migration.md) | Explicit migration from legacy plans to OpenSpec-native changes |
| [Active Change Resolver](docs/active-change-resolver.md) | Active change selection and runtime paths |
| [ADR 0001](docs/adr/0001-openspec-native-artifact-protocol.md) | v1 artifact ownership decision |
| [AIFHub MCP](docs/aifhub-mcp.md) | Optional MCP server tools, runtime-specific settings shapes, and AI Factory 2.16+ Universal / Other rendering |
| [Codex Agents](docs/codex-agents.md) | Namespaced Codex CLI agent files |
| [Claude Agents](docs/claude-agents.md) | Namespaced Claude agent files |

## Validation

Run the local checks:

```bash
npm run validate
npm test
```

`npm run validate` checks the upstream `extension.json` manifest, AIFHub metadata in `aifhub-extension.json`, Codex/Claude agent schemas, and markdown links under `docs/`, `injections/`, and `skills/`. Root `README.md` links should be checked manually when edited.

## Update Behavior

- `ai-factory update` refreshes built-in skills and reapplies extension injections.
- `ai-factory extension update` refreshes the installed extension copy from its Git source.
- `ai-factory extension remove aifhub-extension` returns the workflow to upstream AI Factory behavior.

## License

MIT
