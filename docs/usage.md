[Back to Documentation](README.md) | [Back to README](../README.md) | [Next Page](context-loading-policy.md)

# Usage

This guide documents the v1 OpenSpec-native workflow for AIFHub Extension.

```text
/aif-mode status
/aif-analyze
  -> /aif-plan full "<request>"
  -> optional /aif-explore "<topic>"
  -> optional /aif-improve <change-id>
  -> /aif-implement <change-id>
  -> /aif-verify <change-id>
      fail -> /aif-fix <change-id> -> /aif-verify <change-id>
  -> /aif-done <change-id>
```

OpenSpec-native mode uses OpenSpec artifacts as canonical planning/spec artifacts and AI Factory paths for runtime state, QA evidence, and generated rules.

AIFHub commands request OpenSpec validation, status, instructions, and archive through `scripts/openspec-runner.mjs` when the CLI is available. Users should keep using `/aif-*` commands; this extension does not install or rely on OpenSpec slash commands.

## Artifact Ownership

| Path | Role |
|---|---|
| `openspec/specs/**/spec.md` | Canonical current behavior |
| `openspec/changes/<change-id>/proposal.md` | Canonical change intent |
| `openspec/changes/<change-id>/design.md` | Canonical design notes |
| `openspec/changes/<change-id>/tasks.md` | Canonical implementation checklist |
| `openspec/changes/<change-id>/specs/**/spec.md` | Canonical proposed behavior deltas |
| `.ai-factory/state/<change-id>/` | Runtime execution state and summaries |
| `.ai-factory/qa/<change-id>/` | Verification and finalization evidence |
| `.ai-factory/rules/generated/` | Derived rules, safe to regenerate |
| `.ai-factory/plans/` | Legacy AI Factory-only compatibility and migration input |

## Command Boundaries

### `/aif-mode`

Reads:

- `.ai-factory/config.yaml`
- `openspec/changes/**`
- `openspec/specs/**`
- `.ai-factory/plans/**`
- `.ai-factory/rules/generated/**`

Writes by subcommand:

- `openspec`: `.ai-factory/config.yaml`, OpenSpec skeleton paths, runtime directories, generated rules, optional legacy migration outputs when `--yes` is passed, and `.ai-factory/state/mode-switches/*.md`
- `ai-factory`: `.ai-factory/config.yaml`, legacy skeleton paths, optional compatibility export outputs when `--export-openspec` is passed, and `.ai-factory/state/mode-switches/*.md`
- `sync`: derived generated rules or compatibility export outputs for the current mode, plus a sync report
- `status` and `doctor`: no writes

Does not write:

- OpenSpec skills or slash commands
- manual changes to `openspec/specs/**`
- archive output or `/aif-done` finalization
- runtime files under `openspec/changes/<change-id>/`

Use `--dry-run` for planned switching or sync writes. Use `--all` or `--change <id>` to control change selection. Use `--export-openspec` only for compatibility legacy exports from OpenSpec changes. In OpenSpec mode, sync respects `aifhub.openspec.compileRulesOnSync` and `aifhub.openspec.validateOnSync`.

### `/aif-analyze`

Reads:

- project files and repository metadata
- existing `.ai-factory/config.yaml` when present
- existing rules/context artifacts when present

Writes:

- `.ai-factory/config.yaml`
- `.ai-factory/rules/base.md`
- optional OpenSpec-native skeleton paths such as `openspec/specs/`, `openspec/changes/`, `.ai-factory/state/`, `.ai-factory/qa/`, and `.ai-factory/rules/generated/`

Does not write:

- OpenSpec skills or slash commands
- canonical change artifacts for a feature request
- `.ai-factory/plans` in OpenSpec-native mode

Select OpenSpec-native mode explicitly by asking for it or by starting from config with:

```yaml
aifhub:
  artifactProtocol: openspec
```

### `/aif-plan full`

Reads:

- `.ai-factory/config.yaml`
- project context and rules
- `openspec/specs/**/spec.md`
- optional `.ai-factory/RESEARCH.md`

Writes in OpenSpec-native mode:

- `openspec/changes/<change-id>/proposal.md`
- `openspec/changes/<change-id>/design.md`
- `openspec/changes/<change-id>/tasks.md`
- `openspec/changes/<change-id>/specs/**/spec.md` when behavior changes
- optional runtime notes under `.ai-factory/state/<change-id>/`

Does not write in OpenSpec-native mode:

- `.ai-factory/plans/<id>.md`
- `.ai-factory/plans/<id>/task.md`
- non-OpenSpec helper files under `openspec/changes/<change-id>/`

Docs/tooling-only changes may omit delta specs only when the proposal explains why no product or workflow behavior changes.

When `aifhub.openspec.validateOnPlan` is enabled, planning requests `openspec validate` through the AIFHub OpenSpec runner if a compatible CLI is available. Missing CLI is a degraded warning, not a planning failure.

### `/aif-explore`

Reads:

- `.ai-factory/config.yaml`
- project context and rules
- `openspec/specs/**/spec.md`
- `openspec/changes/<change-id>/**` when exploring an existing change

Writes:

- `.ai-factory/RESEARCH.md`
- `.ai-factory/state/<change-id>/explore.md` or equivalent runtime notes

Does not write:

- `openspec/changes/<change-id>/proposal.md`
- `openspec/changes/<change-id>/design.md`
- `openspec/changes/<change-id>/tasks.md`
- `openspec/changes/<change-id>/specs/**/spec.md`
- legacy `.ai-factory/plans` artifacts in OpenSpec-native mode

Exploration is research-only until promoted into canonical OpenSpec artifacts by planning or refinement.

### `/aif-improve`

Reads:

- `openspec/changes/<change-id>/proposal.md`
- `openspec/changes/<change-id>/design.md`
- `openspec/changes/<change-id>/tasks.md`
- `openspec/changes/<change-id>/specs/**/spec.md`
- `openspec/specs/**/spec.md`
- project context and generated rules when relevant

Writes:

- patch-style edits to `proposal.md`, `design.md`, `tasks.md`, and `specs/**/spec.md`
- optional runtime evidence under `.ai-factory/state/<change-id>/`

Does not write:

- `task.md`, `context.md`, `rules.md`, `verify.md`, or `status.yaml` under OpenSpec changes
- legacy `.ai-factory/plans` artifacts in OpenSpec-native mode
- archived changes under `openspec/changes/archive/**` unless the user explicitly chooses a supported recovery path

When `aifhub.openspec.validateOnImprove` is enabled, refinement requests OpenSpec validation through the runner after canonical artifact edits.

### `/aif-implement`

Reads:

- `openspec/changes/<change-id>/proposal.md`
- `openspec/changes/<change-id>/design.md`
- `openspec/changes/<change-id>/tasks.md`
- `openspec/changes/<change-id>/specs/**/spec.md`
- `openspec/specs/**/spec.md`
- `.ai-factory/rules/generated/*.md` when present
- optional OpenSpec `instructions apply` output when `aifhub.openspec.useInstructionsApply` is enabled and a compatible CLI is available

Writes:

- implementation source files in the selected task scope
- `.ai-factory/state/<change-id>/implementation/`
- task progress in `openspec/changes/<change-id>/tasks.md`

Does not write:

- runtime traces under `openspec/changes/<change-id>/`
- legacy `.ai-factory/plans/<id>/task.md`
- canonical OpenSpec artifacts outside the selected implementation scope unless the user explicitly expands scope

### `/aif-verify`

Reads:

- canonical OpenSpec specs and change artifacts
- generated rules when present
- runtime state under `.ai-factory/state/<change-id>/`
- changed files and verification commands for the repository

Writes:

- `.ai-factory/qa/<change-id>/verify.md`
- `.ai-factory/qa/<change-id>/openspec-validation.json`
- `.ai-factory/qa/<change-id>/openspec-status.json`
- `.ai-factory/qa/<change-id>/raw/`

Does not write:

- `openspec/specs/**`
- `openspec/changes/archive/**`
- final archive output
- legacy `.ai-factory/specs` archives in OpenSpec-native mode

Invalid OpenSpec validation is a hard stop before code checks. Missing or unsupported CLI is degraded mode unless `aifhub.openspec.requireCliForVerify` is true. `openspec-status.json` is written when `aifhub.openspec.statusOnVerify` is enabled.

### `/aif-fix`

Reads:

- the same canonical OpenSpec artifacts as `/aif-implement`
- QA evidence under `.ai-factory/qa/<change-id>/`
- generated rules when present

Writes:

- implementation fixes in the selected finding scope
- `.ai-factory/state/<change-id>/fixes/`

Does not write:

- runtime traces under `openspec/changes/<change-id>/`
- legacy `.ai-factory/plans/<id>/task.md`
- canonical specs unless the user explicitly asks to fix the spec itself

After fixes, rerun:

```text
/aif-verify <change-id>
```

### `/aif-done`

Reads:

- `openspec/changes/<change-id>/**`
- passing verification evidence from `.ai-factory/qa/<change-id>/`
- git working tree state

Writes:

- `.ai-factory/qa/<change-id>/done.md`
- `.ai-factory/qa/<change-id>/openspec-archive.json`
- `.ai-factory/qa/<change-id>/raw/`
- `.ai-factory/state/<change-id>/final-summary.md`
- `openspec/specs/**` only through `openspec archive <change-id> --yes`

Does not write:

- custom manual mutations to `openspec/specs/**`
- manual file moves from `openspec/changes` to archives
- legacy `.ai-factory/specs` archives in OpenSpec-native mode

Use `--skip-specs` for docs/tooling-only changes where no accepted spec update is expected. Archive-required finalization needs a compatible OpenSpec CLI when `aifhub.openspec.requireCliForDone` is true.

## OAuth Example

Create the change:

```text
/aif-plan full "add OAuth login"
```

Expected canonical artifacts:

```text
openspec/changes/add-oauth-login/
  proposal.md
  design.md
  tasks.md
  specs/
    auth/
      spec.md
```

Refine, implement, verify, and finalize:

```text
/aif-improve add-oauth-login
/aif-implement add-oauth-login
/aif-verify add-oauth-login
/aif-done add-oauth-login
```

Expected runtime and QA output:

```text
.ai-factory/state/add-oauth-login/
.ai-factory/qa/add-oauth-login/
```

Implementation and verification traces stay out of `openspec/changes/add-oauth-login/`.

## Legacy AI Factory-Only Mode

Legacy AI Factory-only mode is still supported for compatibility. It is not the normal OpenSpec-native v1 creation path.

Legacy planning writes:

```text
.ai-factory/plans/<plan-id>.md
.ai-factory/plans/<plan-id>/
  task.md
  context.md
  rules.md
  verify.md
  status.yaml
  explore.md
```

Use the explicit migration command when existing legacy artifacts need to enter the OpenSpec-native workflow:

```bash
node scripts/migrate-legacy-plans.mjs <change-id> --dry-run
node scripts/migrate-legacy-plans.mjs <change-id>
```

After migration, run:

```text
/aif-improve <change-id>
```

See [Legacy Plan Migration](legacy-plan-migration.md).

## Mode Switching and Sync

Use `/aif-mode status` before changing modes:

```text
/aif-mode status
```

Switch to OpenSpec-native mode:

```text
/aif-mode openspec --dry-run
/aif-mode openspec
```

If legacy plans exist, review migration first:

```bash
node scripts/migrate-legacy-plans.mjs --all --dry-run
node scripts/migrate-legacy-plans.mjs --all
```

Switch to legacy AI Factory-only mode without deleting OpenSpec artifacts:

```text
/aif-mode ai-factory
```

Export compatibility legacy files only when requested:

```text
/aif-mode ai-factory --export-openspec --change <change-id> --yes
```

Refresh derived artifacts without changing mode:

```text
/aif-mode sync --change <change-id>
/aif-mode doctor
```

## Recommended Codex App Flow

Codex cannot switch modes from extension prompts. The user controls the mode manually.

```text
# Plan mode, user action
/aif-explore "task description"
/aif-plan full "task description"
/aif-improve <change-id>

# Default mode, user action
/aif-implement <change-id>
/aif-verify <change-id>
/aif-done <change-id>
```

In Codex Default mode, prompts must ask plain-text questions rather than using `request_user_input`.

See [Codex Plan Mode](codex-plan-mode.md) for question-format guidance.

## Troubleshooting

| Problem | Meaning | Action |
|---|---|---|
| OpenSpec CLI missing | `openspec` is not available on `PATH`. | Continue degraded planning or install a compatible CLI before validation/archive-required finalization. |
| Node too old | OpenSpec validate/archive requires Node `>=20.19.0`. | Use Node `>=20.19.0` for OpenSpec commands. |
| Invalid delta spec | OpenSpec validation failed for `specs/**/spec.md`. | Fix the delta spec and rerun `/aif-verify <change-id>`. |
| Ambiguous active change | More than one active change can be selected. | Pass `<change-id>` explicitly or update `.ai-factory/state/current.yaml`. |
| Missing generated rules | Derived rules are absent. | Regenerate `.ai-factory/rules/generated/*.md` from OpenSpec specs before relying on rules guidance. |
| Stale generated rules | Generated rules do not match canonical OpenSpec artifacts. | Regenerate them; do not edit generated rules as source of truth. |
| Dirty working tree before `/aif-done` | Finalization cannot prove archive/summary scope safely. | Commit, stash, or use an explicit supported dirty-state override when available. |

## Release Smoke Checks

1. Check the AI Factory version:

```bash
ai-factory --version
```

Expected range:

```text
>=2.10.0 <3.0.0
```

2. Install the extension:

```bash
ai-factory extension add https://github.com/ichinya/aifhub-extension.git
```

3. Run an OpenSpec-native smoke:

```text
/aif-analyze
/aif-plan full "smoke check feature"
/aif-improve <change-id>
/aif-implement <change-id>
/aif-verify <change-id>
```

Expected OpenSpec-native artifacts:

```text
openspec/changes/<change-id>/
.ai-factory/state/<change-id>/
.ai-factory/qa/<change-id>/
```

Legacy `.ai-factory/plans/` artifacts are expected only when the project is intentionally in legacy AI Factory-only mode.

4. Run local repository checks:

```bash
npm run validate
npm test
```

## See Also

- [Documentation Index](README.md)
- [Context Loading Policy](context-loading-policy.md)
- [OpenSpec Compatibility](openspec-compatibility.md)
- [Legacy Plan Migration](legacy-plan-migration.md)
- [Active Change Resolver](active-change-resolver.md)
- [ADR 0001](adr/0001-openspec-native-artifact-protocol.md)
