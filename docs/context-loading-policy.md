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

- `aif-new`
- `aif-verify`
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
