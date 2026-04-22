# Rules Gate Reference

## Rules Hierarchy

The rules gate checks compliance against a three-level hierarchy:

```text
1. .ai-factory/RULES.md          — project-level rules (highest priority)
2. .ai-factory/rules/base.md     — base rules from aif-analyze
3. .ai-factory/plans/<id>/rules.md — plan-local rules (plan-specific)
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
/aif-review          — code review gate
/aif-security-checklist — security gate
/aif-rules-check     — rules compliance gate (this skill)
```

All three gates are independent and can run in any order. If any gate returns `FAIL`, return to implementing stage.

## Relationship to Other Skills

| Skill | Relationship |
|-------|-------------|
| `/aif-rules` | Creates/updates rules. This gate reads but never writes. |
| `/aif-analyze` | Creates `rules/base.md`. This gate reads it. |
| `/aif-review` | Broader code review. This gate focuses on rule compliance only. |
| `/aif-verify` | Verification against plan + rules. This gate is a pre-verify check. |
| `/aif-fix` | Fixes findings. This gate suggests fixes but does not apply them. |

## Bounded Scope

The gate operates on:

- Changed files detected via `git diff` (staged + unstaged).
- Active plan scope (if a plan is in progress).
- Explicitly passed file paths (if provided by user).

The gate does not scan the entire codebase — only the changed scope.
