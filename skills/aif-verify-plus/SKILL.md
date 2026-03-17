---
name: aif-verify+
description: Enhanced verification against task, rules, and constraints. Checks implementation completeness, produces structured findings, and routes workflow to aif-fix or aif-done. Use after aif-implement completes.
argument-hint: "[plan-id] [--strict]"
---

# AIF Verify+ — Enhanced Post-Implementation Verification

Verify implementation against plan artifacts (task, rules, constraints) and produce structured findings with severity levels.

**This skill is read-only.** It inspects code but NEVER modifies implementation files. It updates only `status.yaml` and `verify.md` inside the plan folder.

---

## Artifact Ownership

- **Primary ownership:** `plans/<plan-id>/status.yaml` (verification section), `plans/<plan-id>/verify.md` (findings section).
- **Read-only:** All plan artifacts (task.md, context.md, rules.md, constraints-*.md), all project context files, all source code.
- **No writes to:** Source code, project context files, other plans, specs/.

---

## Step 0: Load Context

### 0.1 Load Skill-Context Overrides

**Read `.ai-factory/skill-context/aif-verify-plus/SKILL.md`** — MANDATORY if the file exists.

Treat skill-context rules as project-level overrides:
- When a skill-context rule conflicts with this SKILL.md, **the skill-context rule wins**.
- When there is no conflict, apply both.
- **CRITICAL:** If a skill-context rule says "verification MUST check X" or "report MUST include section Y" — you MUST comply. Producing a verification that ignores skill-context rules is a bug.

**Enforcement:** After generating the verification report, verify it against all skill-context rules. Fix violations before presenting to the user.

### 0.2 Find Plan Folder

```
1. If $ARGUMENTS contains plan-id → use .ai-factory/plans/<plan-id>/
2. Else get current branch:
   git branch --show-current
   → Convert branch to slug → look for .ai-factory/plans/<slug>/
3. Else list available plans:
   ls .ai-factory/plans/
   → Ask user to choose
```

If no plan found:
```
AskUserQuestion: No plan folder found. What should I verify?

Options:
1. Verify branch diff — Compare current branch against main
2. Verify last commit — Check the most recent commit
3. List available plans — Show plans in .ai-factory/plans/
4. Cancel
```

### 0.3 Load Plan Artifacts

Read all artifacts from the plan folder:

| Artifact | Purpose | Required |
|----------|---------|----------|
| `task.md` | What should be implemented | Yes |
| `context.md` | Expected codebase context | Yes |
| `rules.md` | Implementation constraints | Yes |
| `verify.md` | Verification checklist (base) | Yes |
| `status.yaml` | Current status, previous findings | Yes |
| `constraints-*.md` | Additional constraints | If present |
| `explore.md` | Exploration context | If present |

### 0.4 Load Project Context

- `.ai-factory/config.yaml` — localization for report output
- `.ai-factory/DESCRIPTION.md` — tech stack for build/test detection
- `.ai-factory/ARCHITECTURE.md` — architecture rules to check
- `AGENTS.md` — project structure
- `.ai-factory/RULES.md` — project conventions

### 0.5 Gather Changed Files

```bash
# Files changed since plan creation (if branch exists)
git diff --name-only main...HEAD

# Or if on main — use recent commits
git log --oneline -20
git diff --name-only HEAD~N..HEAD
```

Store as `CHANGED_FILES` for targeted checks.

---

## Step 1: Task Completeness Audit

Go through **every item** in `task.md → Scope → In Scope`:

For each item:
1. Use `Glob` and `Grep` to find implementation code
2. Read the relevant files to confirm implementation is **complete** (not just started)
3. Check that implementation matches the specification

For each acceptance criterion in `task.md → Acceptance Criteria`:
1. Verify the criterion is satisfied in code
2. Check edge cases if mentioned

Produce checklist:
```
✅ Item 1: Create user model — COMPLETE
   - User model at src/models/user.ts
   - All fields present

⚠️ Item 2: Add validation — PARTIAL
   - Email validation present
   - MISSING: Phone number validation

❌ Item 3: Add rate limiting — NOT FOUND
   - No rate-limit middleware detected
```

Statuses:
- `✅ COMPLETE` — all requirements verified in code
- `⚠️ PARTIAL` — some requirements implemented, some missing
- `❌ NOT FOUND` — implementation not detected
- `⏭️ SKIPPED` — intentionally skipped by user

---

## Step 2: Rules Compliance

### 2.1 Plan Rules (from rules.md)

For each rule in `rules.md → Implementation Rules`:
- Verify code follows the rule
- Report violations with file:line references

### 2.2 Constraints (from constraints-*.md)

For each constraint file:
- Read constraints
- Verify implementation satisfies each constraint
- Report violations

### 2.3 Project Rules (from RULES.md, ARCHITECTURE.md)

Check against project-level rules:
- File placement matches ARCHITECTURE.md folder structure
- Dependency rules respected (no layer violations)
- Coding conventions followed

---

## Step 3: Code Quality

### 3.1 Build Check

Detect build system from DESCRIPTION.md or project files:

| Detection | Command |
|-----------|---------|
| `tsconfig.json` | `npx tsc --noEmit` |
| `package.json` with `build` | `npm run build` |
| `go.mod` | `go build ./...` |
| `Cargo.toml` | `cargo check` |
| `pyproject.toml` | `python -m py_compile` on changed files |
| `composer.json` | `composer validate` |

### 3.2 Test Check

| Detection | Command |
|-----------|---------|
| `jest.config.*` / `vitest` | `npm test` |
| `pytest` / `pyproject.toml` | `pytest` |
| `go.mod` | `go test ./...` |
| `phpunit.xml*` | `./vendor/bin/phpunit` |
| `Cargo.toml` | `cargo test` |

If tests fail → report which tests and whether they relate to plan tasks.
If no tests exist and `rules.md` doesn't require them → note but don't fail.

### 3.3 Lint Check

| Detection | Command |
|-----------|---------|
| `eslint.config.*` / `.eslintrc*` | `npx eslint <CHANGED_FILES>` |
| `.golangci.yml` | `golangci-lint run ./...` |
| `ruff` in pyproject.toml | `ruff check <CHANGED_FILES>` |
| `.php-cs-fixer*` | `php-cs-fixer fix --dry-run --diff` |

Only lint changed files to keep output focused.

### 3.4 Leftover Artifacts

Search changed files for cleanup issues:
```bash
grep -rn 'TODO\|FIXME\|HACK\|XXX\|TEMP\|PLACEHOLDER' <CHANGED_FILES>
grep -rn 'console\.log.*debug\|print.*debug\|debugger' <CHANGED_FILES>
```

### 3.5 Import & Dependency Check

- Unused imports in changed files
- New dependencies mentioned in tasks → actually added to manifest
- Missing dependencies (imports referencing uninstalled packages)

---

## Step 4: Documentation & Context Sync

### 4.1 Documentation Check

Based on `rules.md → Documentation Requirements`:
- README updated (if required)
- API docs updated (if applicable)
- Inline comments for complex logic

### 4.2 DESCRIPTION.md Sync

Check if implementation introduced changes that should be in DESCRIPTION.md:
- New dependencies/libraries → should be listed
- New modules → should be documented
- New integrations → should be referenced

### 4.3 Environment & Config

Check for undocumented configuration:
```bash
grep -rn 'process\.env\.\|os\.Getenv\|os\.environ\|getenv\(' <CHANGED_FILES>
```
Cross-reference with `.env.example`, docs, README.

---

## Step 5: Produce Findings

Use [findings-template.yaml](references/findings-template.yaml) as the canonical schema.

### Classification Rules

| Severity | When to Use |
|----------|-------------|
| **blocking** | Missing implementation, build failure, test failure, security violation |
| **important** | TODOs in code, partial implementation, lint warnings, missing docs |
| **optional** | Style suggestions, minor improvements, nice-to-have docs |

### Finding Format

Each finding MUST include:
- `id`: Sequential within severity (B001, I001, O001)
- `check`: Which check found it (task-completeness, rules-compliance, code-quality, architecture, documentation)
- `file`: Affected file path (if applicable)
- `line`: Line number (if applicable)
- `description`: Clear, actionable description
- `rule`: Reference to violated rule (if applicable)
- `fix_suggestion`: How to fix it

---

## Step 6: Verdict & Report

### Verdict Rules

| Verdict | Condition | Action |
|---------|-----------|--------|
| **PASS** | 0 blocking, 0 important | → `aif-done` |
| **PASS with notes** | 0 blocking, 1+ important | → `aif-done` or `aif-fix` |
| **FAIL** | 1+ blocking | → `aif-fix` |

### Report Format

```
## Verification Report: <plan-id>

### Summary
| Category | Count |
|----------|-------|
| ✅ Checks passed | N |
| 🔴 Blocking | N |
| 🟡 Important | N |
| ⚪ Optional | N |

### Task Completion: N/M (XX%)
| # | Task | Status | Notes |
|---|------|--------|-------|
| 1 | ... | ✅ Complete | |
| 2 | ... | ⚠️ Partial | Missing: ... |

### Code Quality
- Build: ✅/❌
- Tests: ✅/❌/⏭️ (N passed, N failed)
- Lint: ✅/⚠️ (N warnings)

### Verdict: ✅ PASS / ⚠️ PASS with notes / ❌ FAIL

---

### Blocking Issues (if any)
#### B001: <title>
- **Check:** <check type>
- **File:** <path>:<line>
- **Rule:** <reference>
- **Fix:** <suggestion>

### Important Issues (if any)
...

### Optional Issues (if any)
...
```

### Route Workflow

```
AskUserQuestion: Verification complete. What next?

Options (on FAIL):
1. Fix all — Run /aif-fix to address blocking + important issues
2. Fix blocking only — Run /aif-fix B001 B002 ...
3. Accept as-is — Mark findings as accepted, proceed to /aif-done

Options (on PASS):
1. Finalize — Run /aif-done (recommended)
2. Fix notes — Run /aif-fix for important/optional findings
3. Security check — Run /aif-security-checklist
4. Code review — Run /aif-review
```

---

## Step 7: Update Status

Update `plans/<plan-id>/status.yaml`:

```yaml
status: verifying

verification:
  last_run: <current ISO timestamp>
  verdict: <pass|pass-with-notes|fail>
  findings:
    blocking: <count>
    important: <count>
    optional: <count>
  checks:
    task_completeness: <pass|fail>
    rules_compliance: <pass|fail>
    code_quality:
      build: <pass|fail|skip>
      tests: <pass|fail|skip>
      lint: <pass|fail|skip>
    architecture: <pass|fail|skip>
    documentation: <pass|fail|skip>
```

Update `plans/<plan-id>/verify.md` — fill in the Findings table and Verdict section with actual results.

### Context Cleanup

```
AskUserQuestion: Free up context before continuing?

Options:
1. /clear — Full reset (recommended after heavy verification)
2. /compact — Compress history
3. Continue as is
```

---

## Strict Mode

When invoked with `--strict`:

- **All tasks must be COMPLETE** — no partial or skipped
- **Build must pass** — fail on build errors
- **Tests must pass** — fail on any test failure (tests required)
- **Lint must pass** — zero warnings, zero errors
- **No TODOs/FIXMEs** in changed files
- **No undocumented environment variables**
- **All important findings escalated to blocking**
- **Full documentation required**

Strict mode recommended before merging to main or creating a PR.

---

## Rules

- **Read plan artifacts before verification** — never verify blind
- **Use verify.md checklist as primary guide** — it was designed for this plan
- **Read-only for source code** — never modify implementation
- **Produce structured findings** — every issue needs id, severity, description, fix suggestion
- **Update status.yaml** — always record verification results
- **Route to correct next skill** — FAIL → fix, PASS → done
- **Read skill-context overrides** — project-specific checks take priority

## Anti-patterns

- ❌ Modifying source code during verification
- ❌ Skipping task completeness audit (most important check)
- ❌ Reporting findings without file:line references
- ❌ Not running build/test/lint when tools are available
- ❌ Passing with unresolved blocking issues
