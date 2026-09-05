# Safety Contract

`aif-mode` coordinates mode switching and artifact sync. It is intentionally conservative.

## Forbidden Actions

Never:

- delete `openspec/`
- delete `.ai-factory/plans/`
- archive OpenSpec changes
- run `/aif-done`
- mutate `openspec/specs/**` manually
- install OpenSpec skills or slash commands
- call OpenSpec slash commands such as `/opsx:propose`, `/opsx:apply`, or `/opsx:archive`
- overwrite legacy or OpenSpec artifacts without an explicit option
- create runtime-only files inside `openspec/changes/<id>/`

## Allowed Actions

The command may:

- update `.ai-factory/config.yaml`
- create skeleton directories
- create `openspec/config.yaml` when missing
- initialize a missing enabled HLV project through the bounded HLV 1.0.0 adopt adapter; preserve root/adopt project maps and existing source, contracts, milestones and instructions without native reinit
- run legacy migration through `scripts/migrate-legacy-plans.mjs`
- export compatibility legacy artifacts when explicitly requested
- compile generated rules through `scripts/openspec-rules-compiler.mjs`
- run OpenSpec validate/status through `scripts/openspec-runner.mjs`
- let other AIFHub skills request OpenSpec instructions/archive through `scripts/openspec-runner.mjs`
- write reports under `.ai-factory/state/mode-switches/`
- update `.ai-factory/state/current.yaml` only when explicitly requested
- reconcile absent-change generated outputs only inside the canonical `.ai-factory/rules/generated/` root and only for exact direct regular compiler-owned filenames

Generated cleanup must never recurse, follow index paths, or treat an inventory failure as an empty active set. Preserve unknown files, directories, symlinks/reparse points, `openspec-base.md`, canonical OpenSpec artifacts, `.ai-factory/state/**`, `.ai-factory/qa/**`, and every external path. Managed-name collisions and unsafe index metadata block mutation.

## Dry Run

`--dry-run` must not write files. It may inspect existing artifacts, resolve changes, detect collisions, and report sorted project-relative `would-write`/`would-remove` operations with total and truncation metadata. The public 200-entry detail limit must not reduce the validated internal cleanup plan.

All selected compilation and target preflight must complete before mutation. Recheck the active/index/managed inventory digest before commit, atomically replace `index.json` through a same-directory temporary file, then perform non-recursive cleanup. Report a truthful `partial` failure when an error occurs after mutation starts; a bounded mode report may still record the failure.

## Collision Handling

Legacy migration uses the migration script's collision policy. Compatibility export defaults to fail-on-collision and only overwrites when `--yes` is passed.

## OpenSpec CLI

Treat missing or unsupported OpenSpec CLI as degraded capability for status, switching, planning, and sync. Treat archive-required `/aif-done` readiness as failed when compatible archive capability is unavailable.

## HLV Project Initialization

`aifhub-mode init` and mutating mode/sync commands may create missing HLV adopt scaffolding only when `aifhub.tools.hlv` is true. Inspect both `project.yaml` and `.hlv/project.yaml` first; a root layout is valid without `.hlv/`. Reuse existing configuration and paths unchanged. Native fresh adopt creates `.hlv/`, missing shared agent assets and an index ignore entry; it does not install/upgrade the executable, execute project gates, move source or reinitialize an existing project. Partial/ambiguous layouts and unsafe paths block setup. Status, doctor and dry-run never invoke native init.
