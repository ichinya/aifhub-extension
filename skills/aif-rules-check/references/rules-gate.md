# Rules Gate Reference

## Required Inputs

- `.ai-factory/config.yaml` to resolve the active plan and rules paths
- `.ai-factory/RULES.md` if present
- `.ai-factory/rules/base.md`
- active plan-local `rules.md` if present
- current diff and changed files

## Rules Hierarchy

The rules gate checks compliance against a three-level hierarchy:

```text
1. .ai-factory/plans/<id>/rules.md - plan-local rules (highest priority when active)
2. .ai-factory/RULES.md            - project-level rules
3. .ai-factory/rules/base.md       - base rules from aif-analyze
```

## Finding Categories

### Blocking

Material violations that will cause `/aif-verify` to fail:

- Violation of declared module boundaries from `ARCHITECTURE.md` or rules.
- Breaking naming conventions required by project rules.
- Missing required error handling patterns declared in rules.
- Using prohibited APIs, libraries, or patterns.

### Warning

Deviations that should be addressed but are not blocking:

- Inconsistent style within changed files (not across the project).
- Missing documentation for new public APIs (if required by rules).
- Plan-local rules that may be outdated relative to implementation changes.

## Verdict Matrix

| Blocking | Warnings | Verdict |
|----------|----------|---------|
| 0 | 0 | `PASS` |
| 0 | 1+ | `WARN` |
| 1+ | any | `FAIL` |

## Gate Position in Review Flow

```text
/aif-review             - code review gate
/aif-security-checklist - security gate
/aif-rules-check        - rules compliance gate (extension-owned, temporary)
```

All three gates are independent and can run in any order. If any gate returns `FAIL`, return to the implementing stage.

## Relationship to Other Skills

| Skill | Relationship |
|-------|--------------|
| `/aif-rules` | Creates or updates rules. This gate reads but never writes. |
| `/aif-analyze` | Creates `rules/base.md`. This gate reads it. |
| `/aif-review` | Broader code review. This gate focuses on rule compliance only. |
| `/aif-verify` | Verification against plan and rules. This gate is a pre-verify check. |
| `/aif-fix` | Fixes findings. This gate suggests fixes but does not apply them. |

## Bounded Scope

The gate operates on:

- changed files detected via `git diff` (staged + unstaged)
- current diff content needed to confirm rule compliance
- active plan scope (if a plan is in progress)
- explicitly passed file paths (if provided by user)

The gate does not scan the entire codebase - only the changed scope.
