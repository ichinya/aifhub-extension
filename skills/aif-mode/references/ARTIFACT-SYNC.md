# Artifact Sync

## OpenSpec-Native Sync

OpenSpec sync performs these actions without changing mode:

1. Ensure `openspec/config.yaml`, `openspec/specs/`, `openspec/changes/`, `.ai-factory/state/`, `.ai-factory/qa/`, and `.ai-factory/rules/generated/`.
2. Resolve selected changes from `--change <id>`, `--all`, or active change resolution.
3. Compile generated rules through `scripts/openspec-rules-compiler.mjs` when `aifhub.openspec.compileRulesOnSync` is not `false`.
4. Validate selected changes through `validateOpenSpecChange(changeId)` and collect status through `getOpenSpecStatus(changeId)` from `scripts/openspec-runner.mjs` when `aifhub.openspec.validateOnSync` is not `false` and compatible CLI capabilities are available.
5. Detect legacy plans that may need migration.
6. Write a sync report under `.ai-factory/state/mode-switches/`.

When no active changes are selected, base-only sync still refreshes `.ai-factory/rules/generated/openspec-base.md` and `.ai-factory/rules/generated/index.json`, skips change-specific generated rules, skips change validation with `no-selected-changes`, writes a report, and returns OK.

When `--all` selects active changes that have no `openspec/changes/<change-id>/specs/**/spec.md` delta specs, sync reports `no-delta-specs` warnings and skips validation/status for those changes. This keeps maintenance sync usable for old migrated or docs-only active changes while preserving stricter per-change verification in `/aif-verify <change-id>`.

Missing or unsupported OpenSpec CLI is degraded sync validation/status, not a sync failure unless strict command context requires CLI-backed evidence.

Generated rules are derived artifacts:

```text
.ai-factory/rules/generated/openspec-base.md
.ai-factory/rules/generated/openspec-change-<change-id>.md
.ai-factory/rules/generated/openspec-merged-<change-id>.md
.ai-factory/rules/generated/openspec-rules-trace-<change-id>.json
.ai-factory/rules/generated/index.json
```

They may be overwritten by sync, but canonical OpenSpec artifacts must remain unchanged. Trace metadata records source input hashes and generated markdown output hashes, so status/doctor can detect both stale specs and manual edits to generated rule text. Missing or invalid generated trace metadata is warning-only for rules gates; rerun `/aif-mode sync --change <change-id>` to refresh it.

Reconciliation uses one prepare/commit batch. The full authoritative active-change inventory is read separately from the selected compilation scope; base sources are collected once, every selected overlay is rendered and target-checked before the first mutation, and `index.json` is finalized once. An inventory read failure, noncanonical `paths.generated_rules`, unsafe managed entry, selected-change failure, or precommit inventory digest conflict blocks generated writes, index replacement, and cleanup.

Mode behavior is explicit:

- `--all` rebuilds exact active membership.
- Targeted or resolved sync refreshes the selected change, retains active sibling entries, and prunes archived entries/files.
- `ambiguous-base-only` refreshes base rules and prunes archived state without compiling an overlay.
- No-active sync writes an empty `changes` set and removes obsolete managed overlays.

A malformed index may be rebuilt only with prepared complete active coverage or when that inventory is empty. Parseable unsafe paths always fail closed. Cleanup is non-recursive and recognizes only direct regular files named `openspec-change-<safe-id>.md`, `openspec-merged-<safe-id>.md`, or `openspec-rules-trace-<safe-id>.json`; unknown files and managed-name directories/symlinks/reparse points are preserved, with unsafe collisions reported non-green.

Dry-run uses sorted project-relative `would-write` and `would-remove` operations. JSON, human output, and reports expose total operation count plus truncation state and at most 200 operation details; execution still applies the complete validated internal plan. A second semantically identical sync reuses timestamps and performs no generated writes or cleanup. If commit or unlink fails after mutation begins, the result is `partial` and status/doctor inspect the remaining drift; a normal bounded failure report is still allowed.

OpenSpec CLI use is adapter-only. Do not call OpenSpec slash commands or install OpenSpec command layers; `/aif-mode` stays the orchestration surface.

## AI Factory Sync

AI Factory sync performs these actions without changing mode:

1. Ensure `.ai-factory/plans/`, `.ai-factory/specs/`, and `.ai-factory/rules/`.
2. Preserve `openspec/`.
3. Export compatibility artifacts only when `--export-openspec` is passed.
4. Write a sync report under `.ai-factory/state/mode-switches/`.

## Compatibility Export

Compatibility export flattens OpenSpec changes to legacy plan artifacts:

```text
openspec/changes/<id>/proposal.md -> .ai-factory/plans/<id>.md
openspec/changes/<id>/tasks.md    -> .ai-factory/plans/<id>/task.md
proposal + design + specs summary -> .ai-factory/plans/<id>/context.md
generated rules                   -> .ai-factory/plans/<id>/rules.md
```

This is not migration. The OpenSpec artifacts remain preserved and may retain structure that the legacy compatibility files cannot represent.

Do not overwrite existing legacy compatibility files unless `--yes` is explicitly passed.
