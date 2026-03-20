# Context Loading Policy

## Goal

Define a single, explicit context-loading contract across skills.

## Roles

### Bootstrap skill

- `aif-analyze`

Responsibilities:
- create/update `.ai-factory/config.yaml`
- create/update `.ai-factory/rules/base.md`
- support migration/bootstrap compatibility

Bridge files (`AGENTS.md`, `CLAUDE.md`, `QWEN.md`) are allowed only in this bootstrap path.

### Consumer skills

- `aif-explore`
- `aif-new`
- `aif-apply`
- `aif-improve-plus`
- `aif-implement-plus`
- `aif-verify-plus`
- `aif-fix`
- `aif-done`
- `aif-roadmap-plus`

These skills must not depend on bridge files.

## Required Consumer Context Set

Consumer skills must use:

- `.ai-factory/config.yaml` (source of truth)
- `.ai-factory/DESCRIPTION.md`
- `.ai-factory/ARCHITECTURE.md`
- `.ai-factory/RULES.md` (if present)
- `.ai-factory/rules/base.md`

Optional area rules are loaded via `config.rules.*` when present.

Plan-aware consumer skills additionally use:

- `config.paths.plans/<plan-id>/task.md`
- `config.paths.plans/<plan-id>/context.md`
- `config.paths.plans/<plan-id>/rules.md`
- `config.paths.plans/<plan-id>/verify.md`
- `config.paths.plans/<plan-id>/status.yaml`
- `config.paths.plans/<plan-id>/explore.md` (if present)

Special ownership case:

- `aif-explore` may read `config.paths.research` and is the only consumer skill allowed to write it
- `aif-new` may read the same research artifact and normalize it into plan-local `explore.md`
- no consumer skill may use bridge files as a substitute for these runtime paths

## Artifact Metadata Contract

Extension-owned markdown workflow artifacts use YAML frontmatter as a cheap metadata layer.

Required frontmatter fields:

- `artifact_type`
- `plan_id`
- `title`
- `artifact_status`
- `owner`
- `created_at`
- `updated_at`

When these metadata fields carry string values, producers should serialize them as quoted YAML scalars. In practice this matters for values such as `plan_id`, `title`, `source_plan`, and `source_artifact`, so sequential ids like `003` and titles containing `:` or `[]` remain parseable.

Optional fields are allowed when the artifact needs traceability, for example:

- `source_issue`
- `source_plan`
- `source_artifact`
- `finding_id`

This contract applies to markdown artifacts such as:

- `task.md`
- `context.md`
- `rules.md`
- `verify.md`
- `explore.md`
- `plans/<id>/fixes/*.md`
- `spec.md`

This contract does **not** apply to YAML-native workflow artifacts:

- `status.yaml`
- `specs/index.yaml`
- schema files and other `.yaml` references

## Artifact Loading Order

For markdown workflow artifacts:

1. read YAML frontmatter first
2. use frontmatter for cheap routing, freshness, and identity checks
3. read the markdown body only if the current step actually needs body sections

If a markdown artifact has no frontmatter:

- treat it as a legacy artifact
- fall back to the existing full-body read path
- do not require a migration before the workflow can continue

Special case: when `aif-new` imports `.ai-factory/RESEARCH.md` into plan-local `explore.md`, it must preserve the imported body and add metadata only to the plan-local copy. The source `RESEARCH.md` stays unchanged.

## Fallback Behavior

If `config.yaml` is missing/incomplete for the requested operation:

- do not fallback to bridge files in consumer skills
- ask user for missing values when needed
- suggest running `/aif-analyze` to initialize/repair config

## Ownership Notes

- `DESCRIPTION.md` owner: core `/aif`
- `ARCHITECTURE.md` owner: core `/aif-architecture`
- `ROADMAP.md` owner: core `/aif-roadmap`
- `RULES.md` owner: `/aif-rules`
- `rules/base.md` owner: extension `aif-analyze`
- `rules/*.md` (area) owner: extension `aif-new`
