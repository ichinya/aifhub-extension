---
name: aif-fix
description: Fix issues found by /aif-verify. Reads verification findings, implements fixes for blocking and important issues, then suggests re-verification. Use when verification fails or user says "fix the issues".
argument-hint: "[plan-id] [finding-ids...] [--all]"
allowed-tools: Read Write Edit Glob Grep Bash question Questions Task
version: 0.7.0
---

# AIF Fix — Fix Verification Findings

Fix issues identified by `/aif-verify`. Reads structured findings, implements corrections, and drives the fix → verify loop.

**This skill modifies source code.** It reads verification findings and applies targeted fixes following plan rules.

---

## Artifact Ownership

- **Primary ownership:** Source code files that need fixing (guided by findings).
- **Writes:** `plans/<plan-id>/status.yaml` (fixes section), `plans/<plan-id>/fixes/*.md` (fix artifacts).
- **Read-only:** `plans/<plan-id>/task.md`, `rules.md`, `constraints-*.md`, `verify.md`, all project context files.
- **No writes to:** Plan artifact content (task.md, rules.md, etc.), specs/, other plans.

---

## Step 0: Load Context

### 0.1 Load Skill-Context Overrides

**Read `.ai-factory/skill-context/aif-fix/SKILL.md`** — MANDATORY if the file exists.

Treat skill-context rules as project-level overrides:
- When a skill-context rule conflicts with this SKILL.md, **the skill-context rule wins**.
- **CRITICAL:** If a skill-context rule says "fixes MUST include X" — you MUST comply.

**Enforcement:** After each fix, verify it against all skill-context rules.

### 0.2 Load Project Context

Read these files if present:
- `.ai-factory/config.yaml` — localization
- `.ai-factory/DESCRIPTION.md` — tech stack, conventions
- `.ai-factory/ARCHITECTURE.md` — dependency rules, file placement
- `.ai-factory/RULES.md` — project conventions
- `.ai-factory/rules/base.md` — base project rules (path from `config.rules.base`)

### 0.3 Find Plan and Findings

```
1. If $ARGUMENTS contains plan-id → use .ai-factory/plans/<plan-id>/
2. Else get current branch → look for matching plan
3. Else list available plans → ask user
```

Read `status.yaml → verification`:
- If `verification.last_run` is null:
  ```
  No verification results found. Run /aif-verify first to identify issues.
  ```
  → STOP.
- If `verification.verdict` is `pass`:
  ```
  Last verification passed. Nothing to fix.
  Suggest: /aif-done to finalize the plan.
  ```
  → STOP.

Read plan artifacts: `task.md`, `rules.md`, `constraints-*.md`, `verify.md`.

For markdown plan artifacts:
- inspect YAML frontmatter first for artifact identity and traceability
- if frontmatter is missing, treat the file as a legacy artifact and continue with the existing body-first read path

### 0.4 Parse Finding IDs from Arguments

- If `$ARGUMENTS` contains finding IDs (B001, I001, etc.) → fix only those
- If `$ARGUMENTS` contains `--all` → fix all findings including optional
- Default (no IDs, no flags) → fix blocking + important

---

## Step 1: Identify and Prioritize

### 1.1 Load Findings

Read findings from `verify.md → Findings` table or from the verification output.

### 1.2 Build Fix Queue

```
Fix Queue (ordered by priority):
1. 🔴 B001: Login endpoint missing rate limiting [src/auth/login.ts:45]
2. 🔴 B002: Build fails — type error [src/models/user.ts:12]
3. 🟡 I001: TODO left in code [src/auth/login.ts:12]
4. 🟡 I002: Missing unit test for validation [—]
```

Show the queue and confirm:

```
question(questions: [{
  header: "Очередь",
  question: "Очередь исправлений готова. Как proceed?\n\nBlocking: {{blocking_count}} issues\nImportant: {{important_count}} issues",
  options: [
    { label: "Fix blocking + important (Рекомендуется)", description: "Исправить default scope" },
    { label: "Только blocking", description: "Исправить только blocking issues" },
    { label: "Выбрать вручную", description: "Указать конкрет findings" },
    { label: "Отмена", description: "Исправлю самостоятельно" }
  ]
}])
```

---

## Step 2: Implement Fixes

For each finding in the queue:

### 2.1 Announce Current Fix

```
## Fixing B001: Login endpoint missing rate limiting
File: src/auth/login.ts:45
Rule: rules.md → Implementation Rules → #3
```

### 2.2 Read and Understand Context

- Read the affected file(s)
- Read surrounding code for patterns and conventions
- Understand the root cause (not just the symptom)
- Check `rules.md` for constraints that apply to the fix

### 2.3 Apply the Fix

Follow the same conventions as the existing code:
- Match code style, naming patterns, error handling approach
- Follow ARCHITECTURE.md dependency rules
- Follow RULES.md conventions
- Add logging where appropriate (use project's logging pattern)

### 2.4 Verify the Fix Locally

After applying:
- Check code compiles (if applicable)
- Run relevant tests (if applicable)
- Verify the fix actually addresses the finding

### 2.5 Mark Finding as Fixed

Record in `status.yaml`:
```yaml
fixes:
  applied:
    - finding_id: B001
      fixed_at: <timestamp>
      description: "Added rate-limit middleware to login endpoint"
      artifact: ".ai-factory/plans/<plan-id>/fixes/<timestamp>-B001.md"
      files_modified:
        - src/auth/login.ts
        - src/middleware/rate-limit.ts
```

Also create a fix artifact in `plans/<plan-id>/fixes/`:

`<timestamp>-<finding-id>.md`

Template:

```markdown
---
artifact_type: fix
plan_id: <plan-id>
title: "Fix <finding-id>"
artifact_status: recorded
owner: aif-fix
created_at: <timestamp>
updated_at: <timestamp>
finding_id: <finding-id>
source_issue: <status.yaml.links.issue|null>
---

# Fix <finding-id>

## Problem
<finding description>

## Root Cause
<root cause>

## Changes
- <change 1>
- <change 2>

## Files
- <path>

## Resolution
<how validated>

## Prevention
<how to avoid recurrence>
```

Add the artifact path to `status.yaml -> fixes.files[]` and reference it from the matching `fixes.applied[]` entry when possible.

### 2.6 Move to Next Finding

Repeat for each finding in the queue.

---

## Step 3: Fix Strategies by Category

### Task Completeness Issues (missing implementation)

```
1. Read task.md → Scope → find the missing item
2. Read context.md → identify where to implement
3. Implement the missing functionality
4. Add or update tests only if the finding explicitly concerns missing tests or rules.md requires them
5. Update documentation if rules.md requires it
```

### Rules Compliance Issues (rule violation)

```
1. Read the specific rule from rules.md
2. Understand what the rule requires
3. Modify code to comply
4. Grep for same pattern elsewhere — fix all occurrences
```

### Code Quality Issues (build/test/lint failure)

```
1. Read the error output carefully
2. Identify root cause (not just silence the error)
3. Fix the underlying issue
4. Re-run the failing check to confirm
```

### Documentation Issues (missing/outdated docs)

```
1. Identify what needs documentation
2. Update the relevant files (README, API docs, inline comments)
3. Ensure consistency with actual code behavior
```

### Architecture Issues (wrong file location, dependency violation)

```
1. Read ARCHITECTURE.md rules
2. Move files or fix imports to comply
3. Update any references to moved files
4. Verify no broken imports
```

---

## Step 4: Fix Report

After all fixes applied:

```
## Fix Report: <plan-id>

### Issues Fixed: N/M

| ID | Severity | Issue | Fix Applied | Files |
|----|----------|-------|-------------|-------|
| B001 | 🔴 blocking | Missing rate limiting | Added middleware | login.ts, rate-limit.ts |
| B002 | 🔴 blocking | Type error | Fixed type annotation | user.ts |
| I001 | 🟡 important | TODO in code | Implemented proper logic | login.ts |
| I002 | 🟡 important | Missing test | Added unit test | login.test.ts |

### Files Modified
- `src/auth/login.ts` — Added rate limiting, resolved TODO
- `src/middleware/rate-limit.ts` — New file
- `src/models/user.ts` — Fixed type annotation
- `tests/auth/login.test.ts` — New test file

### Remaining Issues
| ID | Severity | Issue | Reason |
|----|----------|-------|--------|
| O001 | ⚪ optional | Missing API docs | Not in fix scope |

### Build/Test Status After Fixes
- Build: ✅ / ❌
- Tests: ✅ N passed / ❌ N failed
```

---

## Step 5: Route to Re-Verification

```
question(questions: [{
  header: "Далее",
  question: "Исправления применены. Что дальше?",
  options: [
    { label: "Re-verify сейчас (Рекомендуется)", description: "/aif-verify для подтверждения" },
    { label: "Закоммитить исправления", description: "/aif-commit" },
    { label: "Продолжить с optional findings", description: "Исправить оставшиеся issues" },
    { label: "Остановиться", description: "Проверю позже" }
  ]
}])
```

---

## Step 6: Update Status

Update `plans/<plan-id>/status.yaml`:

```yaml
status: fixing
updated: <current ISO timestamp>

fixes:
  total_applied: <count>
  iterations: <N>  # Increment each fix cycle
  last_fix: <current ISO timestamp>
  applied:
    - finding_id: B001
      fixed_at: <timestamp>
      description: "..."
    # ... all fixed findings
```

### Context Cleanup

```
question(questions: [{
  header: "Контекст",
  question: "Освободить контекст перед продолжением?",
  options: [
    { label: "/clear — Полный сброс (Рекомендуется)", description: "После исправлений" },
    { label: "/compact — Сжать историю", description: "Компактный режим" },
    { label: "Продолжить как есть", description: "Без изменений" }
  ]
}])
```

---

## Fix Loop

```
aif-verify (FAIL) → aif-fix → aif-verify → PASS → aif-done
         ↑__________________________|
              (if still FAIL)
```

**Maximum iterations: 3**

After 3 failed fix → verify cycles:
```
⚠️ Fix loop limit reached (3 iterations).

The following issues persist after 3 fix attempts:
- B001: ...
- I002: ...

Options:
1. Escalate — I need to review these manually
2. Accept — Proceed to /aif-done with accepted findings
3. One more try — Reset counter and try again
```

---

## Rules

- **Always read findings first** — never fix without knowing what's broken
- **Follow rules.md constraints** when implementing fixes
- **Follow project conventions** — match existing code style
- **One fix at a time** — complete, verify, move to next
- **Run tests after fixes** when applicable
- **Create new tests only when the finding or plan rules explicitly require them**
- **Update status.yaml** with fix results
- **Suggest re-verification** after fixes complete
- **Do not mark findings as fixed** without actually implementing the fix
- **Do not scope-creep** — fix only what was reported, don't refactor
- **Read skill-context overrides** — project-specific fix rules take priority

## Anti-patterns

- ❌ Fixing without reading the finding details
- ❌ Silencing errors instead of fixing root cause
- ❌ Refactoring unrelated code while fixing
- ❌ Skipping re-verification after fixes
- ❌ Exceeding 3 fix iterations without user input
- ❌ Modifying plan artifacts (task.md, rules.md) during fix
