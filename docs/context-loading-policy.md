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
- support explicit OpenSpec-native bootstrap when requested or when config already has `aifhub.artifactProtocol: openspec`

In OpenSpec-native bootstrap mode, `aif-analyze` may set `paths.plans` to `openspec/changes`, `paths.specs` to `openspec/specs`, and runtime/generated paths to `.ai-factory/state`, `.ai-factory/qa`, and `.ai-factory/rules/generated`. This changes where consumers resolve canonical plan/change and spec artifacts, but it does not install OpenSpec skills.

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

### Gate skills (read-only)

- `aif-rules-check` — extension-owned temporary gate for rule compliance checks

These skills must not depend on bridge files.

`aif-rules-check` must use:

- `.ai-factory/config.yaml`
- in OpenSpec-native mode, generated rules in priority order:
  - `.ai-factory/rules/generated/openspec-merged-<change-id>.md`
  - `.ai-factory/rules/generated/openspec-change-<change-id>.md`
  - `.ai-factory/rules/generated/openspec-base.md`
- `.ai-factory/RULES.md` if present
- `.ai-factory/rules/base.md`
- active plan-local `rules.md` only in legacy AI Factory-only mode
- current changed scope from `git diff` / changed files

OpenSpec-native `aif-rules-check` does not require plan-local `rules.md`. If generated rules are missing or stale, the gate reports `WARN` and asks the caller to regenerate rules; it does not edit or regenerate files. In legacy AI Factory-only mode, plan-local `rules.md` overrides project-level and base rules for the scoped gate result.

## Required Consumer Context Set

Consumer skills must use:

- `.ai-factory/config.yaml`
- `.ai-factory/DESCRIPTION.md`
- `.ai-factory/ARCHITECTURE.md`
- `.ai-factory/RULES.md` if present
- `.ai-factory/rules/base.md`

Optional area rules are loaded via `config.rules.*` when present.

Plan-aware consumer skills additionally use:

In OpenSpec-native mode:

- `openspec/changes/<change-id>/proposal.md`
- `openspec/changes/<change-id>/design.md`
- `openspec/changes/<change-id>/tasks.md`
- `openspec/changes/<change-id>/specs/**/spec.md`
- `.ai-factory/rules/generated/openspec-base.md`
- `.ai-factory/rules/generated/openspec-change-<change-id>.md`
- `.ai-factory/rules/generated/openspec-merged-<change-id>.md`
- `.ai-factory/state/<change-id>/` for runtime state
- `.ai-factory/qa/<change-id>/` for QA output

In legacy AI Factory-only mode:

- `config.paths.plans/<plan-id>.md`
- `config.paths.plans/<plan-id>/task.md`
- `config.paths.plans/<plan-id>/context.md`
- `config.paths.plans/<plan-id>/rules.md`
- `config.paths.plans/<plan-id>/verify.md`
- `config.paths.plans/<plan-id>/status.yaml`
- `config.paths.plans/<plan-id>/explore.md` if present

Special ownership case:

- `aif-explore` may read `config.paths.research` and is the only consumer skill allowed to write it
- `aif-plan` may read the same research artifact and normalize it into plan-local `explore.md` in legacy AI Factory-only mode
- In OpenSpec-native mode, `aif-explore` may write research and runtime notes outside canonical change folders only: `.ai-factory/RESEARCH.md`, `.ai-factory/state/<change-id>/explore.md`, and `.ai-factory/state/<change-id>/research-notes.md`
- In OpenSpec-native mode, `aif-improve` edits only valid OpenSpec change artifacts: `proposal.md`, `design.md`, `tasks.md`, and `specs/**/spec.md`
- OpenSpec-native planning must keep runtime-only notes under `.ai-factory/state/<change-id>/`, not under `openspec/changes/<change-id>/`
- In OpenSpec-native mode, `aif-implement` consumes canonical OpenSpec artifacts and generated rules through `scripts/openspec-execution-context.mjs` when available. It writes implementation traces only under `.ai-factory/state/<change-id>/implementation/` and does not require legacy `.ai-factory/plans/<id>/task.md`
- In OpenSpec-native mode, `aif-fix` consumes the same canonical OpenSpec artifacts plus QA evidence under `.ai-factory/qa/<change-id>/`. It writes fix traces only under `.ai-factory/state/<change-id>/fixes/` and does not require legacy `.ai-factory/plans/<id>/task.md`
- In OpenSpec-native mode, `aif-implement` and `aif-fix` may change implementation source files within the selected task/finding scope; they do not rewrite canonical OpenSpec artifacts unless explicitly requested
- In OpenSpec-native mode, `aif-verify` reads canonical OpenSpec artifacts, validates the active change before code checks when validation is enabled, writes OpenSpec validation/status evidence plus QA findings under `.ai-factory/qa/<change-id>/`, treats missing CLI as degraded mode unless strict config requires CLI, hard-fails invalid OpenSpec before lint/tests/review, and must not archive
- In OpenSpec-native mode, `aif-done` requires passing `/aif-verify` evidence, archives through `openspec archive <change-id> --yes` via the OpenSpec CLI runner, supports `--skip-specs`, writes final evidence under `.ai-factory/qa/<change-id>/`, writes final summaries under `.ai-factory/state/<change-id>/`, and does not use custom archive logic or legacy `.ai-factory/specs` finalization
- Legacy `task.md`, `context.md`, `rules.md`, `verify.md`, `status.yaml`, and `explore.md` apply only to legacy AI Factory-only plan folders, not OpenSpec-native changes
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
- `aif-rules-check` owner: extension; reads rules but never writes
- `.ai-factory/rules/generated/*.md` owner: OpenSpec generated rules compiler; derived from `openspec/specs/**/spec.md` and `openspec/changes/<change-id>/specs/**/spec.md`, safe to delete and regenerate
- `openspec/changes/<change-id>/proposal.md`, `design.md`, `tasks.md`, and `specs/**/spec.md` owner in OpenSpec-native mode: built-in `/aif-plan` with extension injection rules
- OpenSpec-native refinement owner: built-in `/aif-improve` with extension injection rules; it preserves user edits and updates only canonical OpenSpec artifacts
- `.ai-factory/state/<change-id>/implementation/*` owner in OpenSpec-native mode: `/aif-implement` execution traces
- `.ai-factory/state/<change-id>/fixes/*` owner in OpenSpec-native mode: `/aif-fix` fix traces
- `.ai-factory/state/<change-id>/*` owner in OpenSpec-native mode: runtime state for execution progress, fix notes, and git strategy; `/aif-explore` may own research-only state files
- `.ai-factory/qa/<change-id>/*` owner in OpenSpec-native mode: `/aif-verify`
- OpenSpec-native finalizer state owner: `/aif-done`; it owns `.ai-factory/qa/<change-id>/done.md`, `.ai-factory/qa/<change-id>/openspec-archive.json`, raw archive output, and `.ai-factory/state/<change-id>/final-summary.md`; canonical archive mutation must flow through OpenSpec CLI, not custom file movement
- `.ai-factory/plans/<plan-id>.md` owner in legacy AI Factory-only mode: built-in `/aif-plan` with extension injection rules
- `.ai-factory/plans/<plan-id>/status.yaml` owner in legacy AI Factory-only mode: `/aif-implement`, `/aif-verify`, `/aif-fix`
- `rules/*.md` owner: `/aif-plan` when the active plan explicitly adds area-specific rules

## See Also

- [Documentation Index](README.md) - docs overview and reading order
- [Usage](usage.md) - command flow and current workflow behavior
- [Project README](../README.md) - landing page and install path
