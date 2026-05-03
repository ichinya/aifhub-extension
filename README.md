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
- Publishes namespaced Codex and Claude agent files through the extension manifest for explicit user or orchestrator invocation.
- Publishes an optional `aifhub` MCP server whose settings are rendered by AI Factory per runtime.
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

`/aif-done` finalizes the OpenSpec lifecycle. It archives the accepted OpenSpec change through the OpenSpec CLI when archive is required and writes final evidence under `.ai-factory/qa/<change-id>/` plus final summaries under `.ai-factory/state/<change-id>/`.

It does not replace `/aif-commit`. After `/aif-done`, run `/aif-commit` or your normal git workflow to commit implementation changes, OpenSpec archive/spec changes, QA evidence, and final summaries.

Optional gates:

- `/aif-rules-check` - read-only rules compliance.
- `/aif-review` - read-only code review.
- `/aif-security-checklist` - read-only security gate.
- `/aif-mode doctor` - mode/config/artifact readiness.
- `/aif-mode sync` - derived artifact refresh and OpenSpec validation/status when available.

## Artifact Layout

OpenSpec-native v1 uses this ownership model:

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
```

| Path | Ownership |
|---|---|
| `openspec/specs` | Canonical current behavior |
| `openspec/changes` | Canonical proposed changes |
| `.ai-factory/state` | Runtime execution traces and summaries |
| `.ai-factory/qa` | Verification and finalization evidence |
| `.ai-factory/rules/generated` | Derived rules, safe to regenerate |
| `.ai-factory/plans` | Legacy compatibility and migration input only |

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

When the OpenSpec CLI is missing or unsupported, OpenSpec-aware commands report degraded validate/archive capabilities. Planning and filesystem-based context loading can continue, but archive-required `/aif-done` fails until a compatible CLI is available.

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
node scripts/migrate-legacy-plans.mjs --list
node scripts/migrate-legacy-plans.mjs <change-id> --dry-run
node scripts/migrate-legacy-plans.mjs <change-id>
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
| Dirty working tree before `/aif-done` | Commit, stash, or explicitly allow the dirty state only when the finalizer supports that path. |

## Documentation

| Guide | Description |
|---|---|
| [Documentation Index](docs/README.md) | Reading order and docs map |
| [Usage](docs/usage.md) | Full command flow, read/write boundaries, examples, and troubleshooting |
| [Context Loading Policy](docs/context-loading-policy.md) | Consumer context, GitHub-aware roadmap evidence, ownership, and legacy boundaries |
| [OpenSpec Compatibility](docs/openspec-compatibility.md) | Optional CLI adapter policy and capability flags |
| [Legacy Plan Migration](docs/legacy-plan-migration.md) | Explicit migration from legacy plans to OpenSpec-native changes |
| [Active Change Resolver](docs/active-change-resolver.md) | Active change selection and runtime paths |
| [ADR 0001](docs/adr/0001-openspec-native-artifact-protocol.md) | v1 artifact ownership decision |
| [AIFHub MCP](docs/aifhub-mcp.md) | Optional MCP server tools and runtime-specific settings shapes |
| [Codex Agents](docs/codex-agents.md) | Namespaced Codex agent files |
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
