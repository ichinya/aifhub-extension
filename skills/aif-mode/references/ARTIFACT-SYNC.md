# Artifact Sync

## OpenSpec-Native Sync

OpenSpec sync performs these actions without changing mode:

1. Ensure `openspec/config.yaml`, `openspec/specs/`, `openspec/changes/`, `.ai-factory/state/`, `.ai-factory/qa/`, and `.ai-factory/rules/generated/`.
2. Resolve selected changes from `--change <id>`, `--all`, or active change resolution.
3. Compile generated rules through `scripts/openspec-rules-compiler.mjs` when `aifhub.openspec.compileRulesOnSync` is not `false`.
4. Validate selected changes and collect status through `scripts/openspec-runner.mjs` when `aifhub.openspec.validateOnSync` is not `false` and compatible CLI capabilities are available.
5. Detect legacy plans that may need migration.
6. Write a sync report under `.ai-factory/state/mode-switches/`.

When no active changes are selected, sync still refreshes `.ai-factory/rules/generated/openspec-base.md`, skips change-specific generated rules, skips change validation with `no-selected-changes`, writes a report, and returns OK.

When `--all` selects active changes that have no `openspec/changes/<change-id>/specs/**/spec.md` delta specs, sync reports `no-delta-specs` warnings and skips validation/status for those changes. This keeps maintenance sync usable for old migrated or docs-only active changes while preserving stricter per-change verification in `/aif-verify <change-id>`.

Generated rules are derived artifacts:

```text
.ai-factory/rules/generated/openspec-base.md
.ai-factory/rules/generated/openspec-change-<change-id>.md
.ai-factory/rules/generated/openspec-merged-<change-id>.md
```

They may be overwritten by sync, but canonical OpenSpec artifacts must remain unchanged.

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
