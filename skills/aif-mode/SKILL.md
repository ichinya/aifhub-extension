---
name: aif-mode
description: Switches AIFHub Extension projects between OpenSpec-native and legacy AI Factory artifact modes, synchronizes derived artifacts, checks mode drift, and reports migration/export actions. Use when changing artifactProtocol, syncing OpenSpec and AI Factory artifacts, or diagnosing mode/config drift.
argument-hint: "[status|openspec|ai-factory|sync|doctor] [--dry-run] [--all] [--change <id>] [--yes]"
disable-model-invocation: true
allowed-tools: Read Write Grep Glob Bash(node scripts/aif-mode.mjs *) Bash(node scripts/migrate-legacy-plans.mjs *) Bash(npm run validate) Bash(npm test)
metadata:
  author: aifhub-extension
  version: "1.0.0"
  category: workflow
---

# AIF Mode

Switch or inspect the artifact protocol for an AIFHub Extension project. This skill is user-invoked only because it can update `.ai-factory/config.yaml`, create runtime skeleton directories, run migration/export workflows, and write mode reports.

## Commands

Run the deterministic CLI from the repository root:

```bash
node scripts/aif-mode.mjs status
node scripts/aif-mode.mjs openspec
node scripts/aif-mode.mjs ai-factory
node scripts/aif-mode.mjs sync
node scripts/aif-mode.mjs doctor
```

Use `--dry-run` before any switching or sync command when reviewing planned writes. Use `--json` when another tool needs structured output.

## Workflow

1. Read `.ai-factory/config.yaml` and resolve `aifhub.artifactProtocol`.
2. Run the matching CLI subcommand through `scripts/aif-mode.mjs`; do not hand-edit mode artifacts.
3. For OpenSpec-native operations, use AIFHub orchestration plus `scripts/openspec-runner.mjs` as the OpenSpec CLI adapter. Do not install or invoke OpenSpec slash commands.
4. Write reports only through the CLI under `.ai-factory/state/mode-switches/`.
5. After a switching or sync command, report the status, report path, migration/export suggestions, and any degraded OpenSpec capability.

## Subcommands

### `status`

Read-only. Reports current mode, config marker, OpenSpec CLI capability, OpenSpec change count, legacy plan count, generated rules state, and active change resolution.

### `openspec`

Switch to OpenSpec-native mode, ensure the OpenSpec skeleton and runtime directories, detect legacy plans, optionally run legacy migration when `--yes` is passed, run artifact sync, and write a switch report.

Use this config shape:

```yaml
aifhub:
  artifactProtocol: openspec
  openspec:
    root: openspec
    installSkills: false
    validateOnPlan: true
    validateOnImprove: true
    validateOnVerify: true
    statusOnVerify: true
    archiveOnDone: true
    useInstructionsApply: true
    compileRulesOnSync: true
    validateOnSync: true
    requireCliForVerify: false
    requireCliForDone: true

paths:
  plans: openspec/changes
  specs: openspec/specs
  state: .ai-factory/state
  qa: .ai-factory/qa
  generated_rules: .ai-factory/rules/generated
```

If legacy plans exist, suggest these commands unless `--yes` is explicitly passed:

```bash
node scripts/migrate-legacy-plans.mjs --all --dry-run
node scripts/migrate-legacy-plans.mjs --all
```

### `ai-factory`

Switch to legacy AI Factory-only mode and ensure `.ai-factory/plans`, `.ai-factory/specs`, and `.ai-factory/rules`. Never delete `openspec/`.

When `--export-openspec` is passed, export compatibility artifacts from OpenSpec changes into legacy plan files. This is a compatibility export, not a migration, because OpenSpec delta structure can be lossy when flattened.

### `sync`

Refresh derived or compatibility artifacts without changing mode.

- In OpenSpec-native mode: ensure skeleton paths, compile generated rules when `compileRulesOnSync` is enabled, validate selected changes when `validateOnSync` is enabled and a compatible CLI is available, detect legacy plans, optionally update `.ai-factory/state/current.yaml` with `--current`, and write a sync report.
- During `sync --all`, skip sync validation for selected changes that do not contain `openspec/changes/<id>/specs/**/spec.md` delta specs; report `no-delta-specs` warnings while still compiling generated rules and validating selected changes that do contain delta specs.
- In AI Factory-only mode: ensure legacy paths, optionally export OpenSpec changes with `--export-openspec`, preserve OpenSpec artifacts, and write a sync report.

### `doctor`

Read-only diagnostics for config marker, configured paths, OpenSpec CLI capability, Node compatibility, active change ambiguity, generated rules, legacy artifacts in OpenSpec-native mode, OpenSpec validation when available, and archive readiness for `/aif-done`.

## References

- Read [references/MODES.md](references/MODES.md) when changing config mode.
- Read [references/ARTIFACT-SYNC.md](references/ARTIFACT-SYNC.md) when syncing or exporting artifacts.
- Read [references/SAFETY.md](references/SAFETY.md) before applying `--yes` or compatibility export.
- Use [templates/mode-switch-report.md](templates/mode-switch-report.md) as the report shape; the CLI renders reports directly.

## Safety Contract

`aif-mode` must not delete `openspec/`, delete `.ai-factory/plans/`, archive OpenSpec changes, run `/aif-done`, mutate `openspec/specs` manually, install OpenSpec skills, overwrite artifacts without an explicit option, or create runtime files inside `openspec/changes/<id>/`.

Allowed writes are `.ai-factory/config.yaml`, skeleton directories, migration outputs through `scripts/migrate-legacy-plans.mjs`, compatibility export outputs, generated rules through the rules compiler, current pointer updates when requested, and reports under `.ai-factory/state/mode-switches/`.
