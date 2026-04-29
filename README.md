# AIFHub Extension

AIFHub Extension adds an OpenSpec-native artifact protocol to the AI Factory CLI user experience.

The v1 workflow keeps AI Factory commands as the user-facing path and uses OpenSpec artifacts as the canonical source of truth for specs and changes:

```text
AI Factory UX + OpenSpec artifact protocol
```

## What This Extension Does

- Keeps `/aif-analyze`, `/aif-plan`, `/aif-explore`, `/aif-improve`, `/aif-implement`, `/aif-verify`, `/aif-fix`, and `/aif-done` as the public command vocabulary.
- In OpenSpec-native mode, writes canonical change artifacts under `openspec/changes/<change-id>/` and accepted specs under `openspec/specs/`.
- Keeps AI Factory runtime state, verification evidence, finalization evidence, and generated rules outside canonical OpenSpec changes.
- Preserves legacy AI Factory-only plan folders as compatibility and migration input only.
- Publishes namespaced Codex and Claude agent files through the extension manifest for explicit user or orchestrator invocation.
- Does not install OpenSpec skills or slash commands.

## Quick Start

Install the extension:

```bash
ai-factory extension add https://github.com/ichinya/aifhub-extension.git
```

Bootstrap project context:

```text
/aif-analyze
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
```

Implement, verify, fix if needed, and finalize:

```text
/aif-implement add-oauth-login
/aif-verify add-oauth-login
/aif-fix add-oauth-login
/aif-verify add-oauth-login
/aif-done add-oauth-login
```

`/aif-done` is an explicit finalizer after passing verification. It archives through the OpenSpec CLI when archive is required, writes final evidence under `.ai-factory/qa/<change-id>/`, and writes final summaries under `.ai-factory/state/<change-id>/`.

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

## OpenSpec Compatibility

OpenSpec is optional for extension install and AI Factory-only workflows.

| Capability | Requirement |
|---|---|
| AI Factory extension install/use | `ai-factory >=2.10.0 <3.0.0` |
| OpenSpec-native validation/archive | OpenSpec CLI `>=1.3.1 <2.0.0` |
| OpenSpec CLI runtime | Node `>=20.19.0` |
| OpenSpec skills/commands | Not installed by this extension |

When the OpenSpec CLI is missing or unsupported, OpenSpec-aware commands report degraded validate/archive capabilities. Planning and filesystem-based context loading can continue, but archive-required `/aif-done` fails until a compatible CLI is available.

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
| [Context Loading Policy](docs/context-loading-policy.md) | Consumer context, ownership, and legacy boundaries |
| [OpenSpec Compatibility](docs/openspec-compatibility.md) | Optional CLI adapter policy and capability flags |
| [Legacy Plan Migration](docs/legacy-plan-migration.md) | Explicit migration from legacy plans to OpenSpec-native changes |
| [Active Change Resolver](docs/active-change-resolver.md) | Active change selection and runtime paths |
| [ADR 0001](docs/adr/0001-openspec-native-artifact-protocol.md) | v1 artifact ownership decision |
| [Codex Agents](docs/codex-agents.md) | Namespaced Codex agent files |
| [Claude Agents](docs/claude-agents.md) | Namespaced Claude agent files |

## Validation

Run the local checks:

```bash
npm run validate
npm test
```

`npm run validate` checks manifest paths, Codex/Claude agent schemas, and markdown links under `docs/`, `injections/`, and `skills/`. Root `README.md` links should be checked manually when edited.

## Update Behavior

- `ai-factory update` refreshes built-in skills and reapplies extension injections.
- `ai-factory extension update` refreshes the installed extension copy from its Git source.
- `ai-factory extension remove aifhub-extension` returns the workflow to upstream AI Factory behavior.

## License

MIT
