---
name: aif-mode
description: Configures the optional OpenSpec tool while preserving independent HLV and Lekalo choices, synchronizes selected artifacts, checks configuration drift, and reports migration/export actions.
argument-hint: "[status|openspec|ai-factory|sync|doctor] [--dry-run] [--all] [--change <id>] [--yes]"
disable-model-invocation: true
allowed-tools: Read Write Grep Glob Bash(ai-factory aifhub-mode *) Bash(ai-factory aifhub-migrate-legacy-plans *) Bash(npm run validate) Bash(npm test)
metadata:
  author: aifhub-extension
  version: "1.3.0"
  category: workflow
---

# AIF Mode

Read [tool selection and artifact ownership](../shared/TOOLS.md) before choosing artifact paths or lifecycle instructions.

Switch or inspect `aifhub.tools.openspec` for an AIFHub Extension project. The `hlv` and `lekalo` booleans are independent and preserved by OpenSpec switching. This skill is user-invoked only because it can update `.ai-factory/config.yaml`, create runtime skeleton directories, run migration/export workflows, and write mode reports.

## Commands

Run the deterministic CLI through stable installed-project wrappers:

```bash
ai-factory aifhub-mode status
ai-factory aifhub-mode openspec
ai-factory aifhub-mode ai-factory
ai-factory aifhub-mode sync
ai-factory aifhub-mode doctor
```

Use `--dry-run` before any switching or sync command when reviewing planned writes. Use `--json` when another tool needs structured output.

For installed-project automation, prefer explicit wrapper commands:

```bash
ai-factory aifhub-mode sync --change <change-id> --json
ai-factory aifhub-mode doctor --change <change-id> --json
```

## Invocation Style

Use runtime-specific public invocations when instructing the user: selected `codex-app` runtime uses `$aif-mode` and other `$aif-*` skills, while slash-command runtimes use `/aif-mode` and other `/aif-*` commands.

## Workflow

1. Read `.ai-factory/config.yaml` and resolve `aifhub.tools.openspec`.
   Follow `skills/shared/LANGUAGE-POLICY.md` before producing user-facing responses or generated artifacts.
2. Run the matching CLI subcommand through `ai-factory aifhub-mode`; do not hand-edit mode artifacts.
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
  tools:
    openspec: true
    hlv: false
    lekalo: false
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
    requireCliForPlan: false
    requireCliForImprove: false
    requireCliForVerify: false
    requireCliForDone: true
    requireGeneratedRulesForVerify: false
    requireGeneratedRulesForDone: true
    requireRulesPassForVerify: false
    requireRulesPassForDone: true
    requireSpecCoverageForVerify: false
    requireSpecCoverageForDone: true
    allowWarnOnDone:
      rules: false
      coverage: false
      openspecStatus: true

paths:
  context: CONTEXT.md
  plans: openspec/changes
  specs: openspec/specs
  state: .ai-factory/state
  qa: .ai-factory/qa
  generated_rules: .ai-factory/rules/generated

reviews:
  policy_file: REVIEW.md
```

`paths.context` is protocol-neutral. Render `CONTEXT.md` when the key is missing, preserve a custom project-relative value, and never create or inspect the optional glossary file during mode operations.

`reviews.policy_file` is also protocol-neutral. Render `REVIEW.md` when the key is missing, preserve a custom project-relative value, and never create or inspect the review policy during mode operations; `/aif-analyze` owns initial scaffolding.

If legacy plans exist, suggest these commands unless `--yes` is explicitly passed:

```bash
ai-factory aifhub-migrate-legacy-plans --all --dry-run
ai-factory aifhub-migrate-legacy-plans --all
```

### `ai-factory`

Switch to legacy AI Factory-only mode and ensure `.ai-factory/plans`, `.ai-factory/specs`, and `.ai-factory/rules`. Preserve `paths.context` (default `CONTEXT.md`) and `reviews.policy_file` (default `REVIEW.md`) without creating or inspecting either file. Never delete `openspec/`.

When `--export-openspec` is passed, export compatibility artifacts from OpenSpec changes into legacy plan files. This is a compatibility export, not a migration, because OpenSpec delta structure can be lossy when flattened.

### `sync`

Refresh derived or compatibility artifacts without changing mode.

- In OpenSpec-native mode: ensure skeleton paths, compile generated rules when `compileRulesOnSync` is enabled, validate selected changes through `validateOpenSpecChange(changeId)` and collect status through `getOpenSpecStatus(changeId)` from `scripts/openspec-runner.mjs` when `validateOnSync` is enabled and a compatible CLI is available, detect legacy plans, optionally update `.ai-factory/state/current.yaml` with `--current`, and write a sync report.
- During `sync --all`, skip sync validation for selected changes that do not contain `openspec/changes/<id>/specs/**/spec.md` delta specs; report `no-delta-specs` warnings while still compiling generated rules and validating selected changes that do contain delta specs.
- Keep the authoritative inventory of every active direct-child change separate from the selected compilation scope. Inventory read, canonical-root, unsafe managed entry, or selected-change preflight failure blocks every generated-rule write, index replacement, and cleanup operation.
- Reconcile one prepare/commit batch: collect base once, prepare every selected overlay before mutation, finalize `index.json` once, and remove only exact compiler-owned direct regular files for absent changes. Targeted/resolved sync retains active sibling entries; ambiguous base-only sync prunes archived state without compiling overlays; no-active sync produces an empty `changes` set.
- A malformed index may be rebuilt only when the prepared selection covers the complete active inventory or the active inventory is empty. Unsafe paths never become cleanup targets. `--dry-run` reports bounded `would-write`/`would-remove` operations; a byte-identical second sync reports no generated operations even with a later clock.
- Missing or unsupported OpenSpec CLI is degraded sync validation/status, not a sync failure unless strict command context requires CLI-backed evidence.
- In AI Factory-only mode: ensure legacy paths, optionally export OpenSpec changes with `--export-openspec`, preserve OpenSpec artifacts, and write a sync report.

### `doctor`

Configured `aifhub.providers` are diagnosed independently of artifact protocol, only when the provider has a true `aifhub.tools` switch. False or an omitted tool skips discovery and diagnosis. Enabled providers default to `policy: required`. HLV uses version discovery, `doctor --json` without `--fix`, and `status --json`; detection/doctor never run `hlv check`, project gates, initialization, updates, sync, or evidence writes. Required unavailable/unsupported/failed providers block doctor; optional failures are degraded warnings. See [validation providers](../../docs/validation-providers.md).

Read-only diagnostics for config marker, required configured directories, OpenSpec CLI capability, Node compatibility, active change ambiguity, generated rules, coverage matrix status, legacy artifacts in OpenSpec-native mode, OpenSpec validation when available, and archive readiness for `/aif-done`. Generated-rule membership checks cover the full active inventory; the 50-change cap applies only to expensive trace/hash reads. Orphan index entries/files, missing active membership, malformed index data, or managed-name collisions remain non-green until reconciliation. Optional `paths.context` and `reviews.policy_file` file states are not doctor diagnostics.

AI Factory 2.12+ also exposes an optional read-only artifact audit bridge:

```bash
ai-factory audit-artifacts openspec .ai-factory/qa .ai-factory/state --json
```

Use this only as supplemental diagnostic context when available. It is optional, not mandatory, not archive-blocking, and must not turn `/aif-mode doctor` into a write operation or a hard dependency on upstream AI Factory 2.12+.

## References

- Read [references/MODES.md](references/MODES.md) when changing config mode.
- Read [references/ARTIFACT-SYNC.md](references/ARTIFACT-SYNC.md) when syncing or exporting artifacts.
- Read [references/SAFETY.md](references/SAFETY.md) before applying `--yes` or compatibility export.
- Use [templates/mode-switch-report.md](templates/mode-switch-report.md) as the report shape; the CLI renders reports directly.

## Safety Contract

`aif-mode` must not delete `openspec/`, delete `.ai-factory/plans/`, archive OpenSpec changes, run `/aif-done`, mutate `openspec/specs` manually, install OpenSpec skills, overwrite artifacts without an explicit option, or create runtime files inside `openspec/changes/<id>/`.

Allowed writes are `.ai-factory/config.yaml`, skeleton directories, migration outputs through `scripts/migrate-legacy-plans.mjs`, compatibility export outputs, generated rules through the rules compiler, current pointer updates when requested, and reports under `.ai-factory/state/mode-switches/`.

Generated cleanup is confined to `.ai-factory/rules/generated/` and only the exact direct-child patterns `openspec-change-<safe-id>.md`, `openspec-merged-<safe-id>.md`, and `openspec-rules-trace-<safe-id>.json` for absent active changes. Preserve unknown files, directories, symlinks/reparse points, canonical OpenSpec artifacts, runtime/QA evidence, and external paths. Public JSON/human/report detail is sorted, project-relative, capped at 200 entries, and paired with total/truncation metadata; a normal bounded failure report may still be written after fail-closed preflight.
