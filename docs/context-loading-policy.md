[← Previous Page](usage.md) · [Back to README](../README.md)

# Context Loading Policy

## Goal

Define one explicit context-loading contract across bootstrap, planning, execution, and verification skills.

Эта политика фиксирует контракт extension, проверенный против `ai-factory 2.10.0`.

## Roles

### Bootstrap skill

- `aif-analyze`

Responsibilities:
- create or update `.ai-factory/config.yaml`
- create or update `.ai-factory/rules/base.md`
- support migration and bootstrap compatibility

Bootstrap lookup order follows `aif-analyze`: `.ai-factory/config.yaml`, then `AGENTS.md`, then `CLAUDE.md`, then `.ai-factory/RULES.md`. Legacy bridge files (`AGENTS.md`, `CLAUDE.md`) могут читаться только как migration inputs, если уже существуют, но extension не создаёт новые bridge files. Каноническими bootstrap-результатами остаются `.ai-factory/config.yaml` и `.ai-factory/rules/base.md`.

### Consumer skills

- `aif-explore`
- `aif-plan`
- `aif-improve`
- `aif-implement`
- `aif-verify`
- `aif-fix`
- `aif-roadmap`
- `aif-evolve`

These skills must not depend on bridge files.

## Required Consumer Context Set

Consumer skills must use:

- `.ai-factory/config.yaml`
- `.ai-factory/DESCRIPTION.md`
- `.ai-factory/ARCHITECTURE.md`
- `.ai-factory/RULES.md` if present
- `.ai-factory/rules/base.md`

Optional area rules are loaded via `config.rules.*` when present.

Plan-aware consumer skills additionally use:

- `config.paths.plans/<plan-id>.md`
- `config.paths.plans/<plan-id>/task.md`
- `config.paths.plans/<plan-id>/context.md`
- `config.paths.plans/<plan-id>/rules.md`
- `config.paths.plans/<plan-id>/verify.md`
- `config.paths.plans/<plan-id>/status.yaml`
- `config.paths.plans/<plan-id>/explore.md` if present

Special ownership case:

- `aif-explore` may read `config.paths.research` and is the only consumer skill allowed to write it
- `aif-plan` may read the same research artifact and normalize it into plan-local `explore.md`
- no consumer skill may use bridge files as a substitute for these runtime paths

## Artifact Metadata Contract

Extension-owned markdown workflow artifacts use YAML frontmatter as a metadata layer.

Required frontmatter fields:

- `artifact_type`
- `plan_id`
- `title`
- `artifact_status`
- `owner`
- `created_at`
- `updated_at`

This contract applies to markdown artifacts such as:

- `task.md`
- `context.md`
- `rules.md`
- `verify.md`
- `explore.md`
- `plans/<id>/fixes/*.md`
- `spec.md`

This contract does not apply to YAML-native artifacts such as `status.yaml` and `specs/index.yaml`.
The companion plan file `.ai-factory/plans/<plan-id>.md` remains an upstream-style summary artifact and does not require frontmatter.

## Artifact Loading Order

For markdown workflow artifacts:

1. Read YAML frontmatter first.
2. Use frontmatter for routing, freshness, and identity checks.
3. Read the markdown body only when the current step needs body sections.

If a markdown artifact has no frontmatter:

- treat it as a legacy artifact
- fall back to the existing full-body read path
- do not require a migration before the workflow can continue

Special case: when `aif-plan` imports `.ai-factory/RESEARCH.md` into plan-local `explore.md`, it must preserve the imported body and add metadata only to the plan-local copy. The source `RESEARCH.md` stays unchanged.

## Fallback Behavior

If `config.yaml` is missing or incomplete for the requested operation:

- do not fall back to bridge files in consumer skills
- ask for missing values only when the operation cannot proceed safely
- suggest running `/aif-analyze` to initialize or repair config

## Ownership Notes

- `DESCRIPTION.md` owner: core `/aif`
- `ARCHITECTURE.md` owner: core `/aif-architecture`
- `ROADMAP.md` owner: core `/aif-roadmap`
- `RULES.md` owner: `/aif-rules`
- `rules/base.md` owner: extension `aif-analyze`
- `.ai-factory/plans/<plan-id>.md` owner: built-in `/aif-plan` with extension injection rules
- `.ai-factory/plans/<plan-id>/status.yaml` owner: `/aif-implement`, `/aif-verify`, `/aif-fix`
- `rules/*.md` owner: `/aif-plan` when the active plan explicitly adds area-specific rules

## See Also

- [Documentation Index](README.md) - docs overview and reading order
- [Usage](usage.md) - command flow and current workflow behavior
- [Project README](../README.md) - landing page and install path
