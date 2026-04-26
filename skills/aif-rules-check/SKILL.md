---
name: aif-rules-check
description: Read-only gate that checks changed files against project rules hierarchy. Returns PASS, WARN, or FAIL without editing rules or source code.
version: 1.1.0
author: ichi
---

# AIF Rules Check

Read-only gate for rule compliance verification. Checks changed files against the project rules hierarchy and returns a structured verdict without modifying any files.

This is an **extension-owned temporary gate**. When upstream `ai-factory` adds a native `/aif-rules-check`, this skill should be deprecated in favor of the upstream version.

## Behavior

- **Read-only**: never edits rules, source code, or plan artifacts.
- **Reads**:
  - `.ai-factory/config.yaml` - project configuration, mode detection, plan resolution, and rules paths
  - `.ai-factory/rules/generated/openspec-merged-<change-id>.md` - OpenSpec-native merged generated rules, highest priority when present
  - `.ai-factory/rules/generated/openspec-change-<change-id>.md` - OpenSpec-native change generated rules
  - `.ai-factory/rules/generated/openspec-base.md` - OpenSpec-native base generated rules
  - `.ai-factory/RULES.md` - project-level rules (if present)
  - `.ai-factory/rules/base.md` - base rules created by `aif-analyze`
  - plan-local `rules.md` - legacy AI Factory-only plan rules when explicitly in legacy mode
  - changed files and current diff via `git diff`
- **Returns**: `PASS | WARN | FAIL` with structured findings.

## Workflow

### Step 1: Load Rules Hierarchy

1. Read `.ai-factory/config.yaml` for path configuration and active plan resolution.
2. Detect rules mode:
   - OpenSpec-native mode when config contains `aifhub.artifactProtocol: openspec` or the active scope is clearly under `openspec/changes/<change-id>/`.
   - Legacy AI Factory-only mode otherwise.
3. In OpenSpec-native mode, load rules in priority order:
   - `.ai-factory/rules/generated/openspec-merged-<change-id>.md`
   - `.ai-factory/rules/generated/openspec-change-<change-id>.md`
   - `.ai-factory/rules/generated/openspec-base.md`
   - `.ai-factory/RULES.md` (project-level overrides, if present)
   - `.ai-factory/rules/base.md` (base rules from `aif-analyze`, if present)
4. OpenSpec-native mode does not require plan-local `rules.md`. Plan-local `rules.md` is ignored unless the run is explicitly legacy AI Factory-only.
5. If OpenSpec-native generated rules are missing or stale generated rules are detected:
   - Return `WARN` with message: "OpenSpec generated rules are missing or stale; regenerate rules before relying on this gate."
   - Suggest that the owner workflow regenerate rules; this read-only gate must not regenerate or edit generated rules.
6. In legacy AI Factory-only mode, load rules in priority order:
   - plan-local `rules.md` (plan-specific, highest priority, if active plan exists)
   - `.ai-factory/RULES.md` (project-level overrides, if present)
   - `.ai-factory/rules/base.md` (base rules from `aif-analyze`)
7. If no rules files exist:
   - Return `WARN` with message: "No rules files found. Run `/aif-analyze` to create base rules."
   - Stop.

### Step 2: Determine Changed Scope

1. Detect changed files and current diff via `git diff` (staged + unstaged).
2. If no changes are detected:
   - Return `PASS` with message: "No changed files to check."
   - Stop.
3. If an active plan exists, cross-reference changed files against plan scope.

### Step 3: Check Rule Compliance

For each changed file:

1. Check against applicable rules in priority order (plan-local, project, base).
2. Flag **material rule violations** only - not stylistic preferences.
3. Categorize findings:
   - **Blocking**: rule violation that will cause verification failure.
   - **Warning**: rule deviation that should be addressed but is not blocking.

### Step 4: Produce Verdict

Return structured output:

```md
## Rules Check Result: PASS | WARN | FAIL

### Summary
- Files checked: N
- Blocking: N
- Warnings: N

### Findings
[...per-file findings...]

### Recommendations
[...actionable suggestions...]
```

Verdict rules:
- `PASS`: no findings.
- `WARN`: warnings but no blocking findings.
- `FAIL`: one or more blocking findings.

### Step 5: Suggest Follow-ups

- If rules are missing: suggest `/aif-analyze`.
- If rules are outdated: suggest `/aif-rules`.
- If OpenSpec generated rules are missing or stale generated rules are detected: suggest `regenerate rules` through the compiler-owning workflow before relying on this gate.
- If blocking findings exist: suggest `/aif-fix`.
- If plan-local rules are missing in legacy AI Factory-only mode: suggest adding `rules.md` to the plan folder.
- **Never** suggest editing rules from this skill - that is the responsibility of `/aif-rules`.

## Ownership Boundary

| Artifact | Owner | This Skill |
|----------|-------|------------|
| `.ai-factory/rules/generated/*.md` | OpenSpec generated rules compiler | Reads only |
| `.ai-factory/RULES.md` | `/aif-rules` | Reads only |
| `.ai-factory/rules/base.md` | `aif-analyze` | Reads only |
| plan-local `rules.md` | `/aif-plan` | Reads only in legacy AI Factory-only mode |
| source code files | project | Reads only |

## Rules

- Never modify any files - this is a read-only gate.
- Never apply fixes - that is the responsibility of `/aif-fix`.
- Never write or update rules - that is the responsibility of `/aif-rules` or `aif-analyze`.
- Never regenerate or edit generated rules - if `.ai-factory/rules/generated/*.md` is missing or stale, return `WARN` and ask the caller to regenerate rules through the compiler-owning workflow.
- Only flag material rule violations, not general style preferences.
- Use bounded scope: active plan pair or explicitly passed changed scope.
- If rules are missing or outdated, suggest `/aif-analyze` or `/aif-rules` but do not edit them.

## Example Requests

- "Check rules compliance."
- "/aif-rules-check"
- "Run the rules gate on current changes."
