# Rules Gate Reference

## Required Inputs

- `.ai-factory/config.yaml` to resolve the artifact protocol, active change or active plan, and rules paths
- current diff and changed files
- OpenSpec-native generated rules when `aifhub.artifactProtocol: openspec`
- `.ai-factory/RULES.md` if present
- `.ai-factory/rules/base.md` if present
- active plan-local `rules.md` only in Legacy AI Factory-only mode

## OpenSpec-native mode

OpenSpec-native mode reads canonical OpenSpec artifacts as context:

- `openspec/specs/**`
- `openspec/changes/<change-id>/proposal.md`
- `openspec/changes/<change-id>/design.md`
- `openspec/changes/<change-id>/tasks.md`
- `openspec/changes/<change-id>/specs/**/spec.md`

Rules are loaded in this exact priority order:

```text
1. .ai-factory/rules/generated/openspec-merged-<change-id>.md
2. .ai-factory/rules/generated/openspec-change-<change-id>.md
3. .ai-factory/rules/generated/openspec-base.md
4. .ai-factory/RULES.md
5. .ai-factory/rules/base.md
```

OpenSpec-native mode does not require plan-local `rules.md`. If generated rules are missing or stale, return `WARN`, report whether generated rules were present, missing, or stale, and ask the caller to regenerate through the compiler-owning workflow. This gate must not regenerate or edit generated rules.

Do not write runtime state or QA evidence. If output needs to name related evidence locations, use `.ai-factory/state/<change-id>/` and `.ai-factory/qa/<change-id>/` only as external runtime state and QA evidence paths.

## Legacy AI Factory-only mode

The legacy gate checks compliance against a three-level hierarchy:

```text
1. .ai-factory/plans/<plan-id>/rules.md - plan-local rules (highest priority when active)
2. .ai-factory/RULES.md                 - project-level rules
3. .ai-factory/rules/base.md            - base rules from aif-analyze
```

Legacy AI Factory-only mode may read the active plan pair and plan-local `rules.md`. It remains read-only.

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
- active OpenSpec change scope, Legacy AI Factory-only active plan scope, or both when explicitly provided
- explicitly passed file paths (if provided by user)

The gate does not scan the entire codebase - only the changed scope.
