---
name: aif-fix
description: Fix issues found by aif-verify+. Reads verification findings and implements fixes for blocking and important issues. Use when verification fails or user says "fix the issues".
argument-hint: "[plan-id] [finding-ids...] [--all]"
---

# AIF Fix

Fix issues identified by `aif-verify+`. Reads verification findings and implements corrections for blocking and important issues.

## Workflow

1. **Load plan and findings**
   - Find plan folder (by argument or current branch)
   - Read `status.yaml` → `verification.findings`
   - If no verification run, suggest running `aif-verify+` first
   - Read plan artifacts: `task.md`, `rules.md`, `constraints-*.md`

2. **Identify issues to fix**
   - With `[finding-ids...]`: fix only specified findings (B001, I001, etc.)
   - With `--all`: fix all findings including optional
   - Default: fix blocking + important findings

3. **Prioritize fixes**
   - Blocking issues first (B001, B002, ...)
   - Important issues second (I001, I002, ...)
   - Optional issues last (only with --all)

4. **Implement fixes**
   - For each finding:
     - Read affected file(s)
     - Implement fix following `rules.md` constraints
     - Verify fix addresses the finding
   - Run tests after each fix if applicable

5. **Update status**
   - Mark fixed findings in status.yaml
   - Update verification section

6. **Re-verify**
   - Suggest running `aif-verify+` to confirm fixes
   - Or show manual verification steps

## Fix Implementation Rules

### For Task Completeness Issues

```
Finding: Missing implementation for task item
Fix:
1. Read task.md → Scope → In Scope for requirement details
2. Implement the missing functionality
3. Add/update tests
4. Update documentation if required
```

### For Rules Compliance Issues

```
Finding: Violation of rule in rules.md
Fix:
1. Read the specific rule from rules.md
2. Understand what the rule requires
3. Modify code to comply with rule
4. Verify no other code violates same rule
```

### For Code Quality Issues

```
Finding: Build/test/lint failure
Fix:
1. Read error output
2. Identify root cause
3. Fix the issue
4. Re-run the failing check
```

### For Documentation Issues

```
Finding: Missing or outdated documentation
Fix:
1. Identify what needs documentation
2. Update relevant doc files
3. Ensure consistency with code
```

## Fix Report Format

After fixing, report what was done:

```
## Fix Report: {{plan-id}}

### Issues Fixed

| ID | Severity | Issue | Fix Applied |
|----|----------|-------|-------------|
| B001 | blocking | Missing rate limiting | Added rate-limit middleware to login |
| I001 | important | TODO in code | Removed TODO, implemented proper error handling |

### Files Modified

- `src/auth/login.ts` — Added rate limiting, removed TODO
- `src/middleware/rate-limit.ts` — New file

### Tests

- Added: `tests/auth/login.rate-limit.test.ts`
- Result: ✅ All tests pass

### Remaining Issues

| ID | Severity | Issue | Reason |
|----|----------|-------|--------|
| O001 | optional | Missing API docs | Deferred (not blocking) |

---

## Next Steps

✅ Run `/aif-verify+` to confirm all fixes
```

## Status Update

Update `status.yaml` after fixes:

```yaml
status: fixing  # or ready-for-verify

verification:
  last_run: 2024-01-15T10:30:00Z
  verdict: fail  # Previous verdict
  findings:
    blocking: 0    # Updated after fixes
    important: 0
    optional: 1

fixes_applied:
  - finding_id: B001
    fixed_at: 2024-01-15T10:45:00Z
    description: "Added rate limiting middleware"
  - finding_id: I001
    fixed_at: 2024-01-15T10:50:00Z
    description: "Removed TODO comment"
```

## Fix Loop

```
aif-verify+ (FAIL) → aif-fix → aif-verify+ (PASS) → aif-done
         ↑__________________|
              (if still FAIL)
```

Maximum fix iterations: 3
After 3 failed attempts, escalate to user for manual intervention.

## Integration

| Skill | Relationship |
|-------|--------------|
| `aif-verify+` | Predecessor — provides findings to fix |
| `aif-verify+` | Successor — confirms fixes |
| `aif-done` | Final successor — after verification passes |

## Rules

- Always read findings from status.yaml or verification output
- Follow rules.md constraints when implementing fixes
- Run tests after fixes when applicable
- Update status.yaml with fix results
- Suggest re-verification after fixes complete
- Do not mark findings as fixed without implementing the fix

## Example Usage

```
# Fix all blocking and important issues from last verification
/aif-fix

# Fix specific findings
/aif-fix B001 I001

# Fix everything including optional
/aif-fix --all

# Fix issues in specific plan
/aif-fix add-oauth B001 B002
```
