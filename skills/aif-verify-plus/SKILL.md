---
name: aif-verify+
description: Enhanced verification against task, rules, and constraints. Checks implementation completeness, produces structured findings, and routes workflow to aif-fix or aif-done. Use after aif-implement completes.
argument-hint: "[plan-id] [--strict]"
---

# AIF Verify+

Enhanced verification that checks implementation against plan artifacts (task, rules, constraints) and produces structured findings with severity levels.

## Workflow

1. **Find and load plan**
   - If `plan-id` argument provided → use `.ai-factory/plans/<plan-id>/`
   - Else check current git branch → look for matching plan folder
   - Read plan artifacts:
     - `task.md` — what should be implemented
     - `context.md` — relevant codebase context
     - `rules.md` — implementation constraints
     - `verify.md` — verification checklist
     - `status.yaml` — current workflow status
     - `constraints-*.md` — additional constraints (if any)

2. **Read project context**
   - `.ai-factory/config.yaml` — localization
   - `.ai-factory/DESCRIPTION.md` — project spec
   - `.ai-factory/ARCHITECTURE.md` — architecture rules
   - `AGENTS.md` — project structure

3. **Gather implementation evidence**
   ```bash
   # Files changed since plan was created
   git diff --name-only <status.yaml.created>...HEAD
   # Or compare against main
   git diff --name-only main...HEAD
   ```

4. **Run verification checks**
   - Task completeness
   - Rules compliance
   - Constraints verification
   - Code quality (build, tests, lint)
   - Architecture consistency
   - Documentation sync

5. **Produce structured findings**
   - Classify by severity: blocking, important, optional
   - Map findings to specific files and lines
   - Determine overall verdict

6. **Route workflow**
   - **PASS** → suggest `aif-done`
   - **PASS with notes** → show notes, suggest `aif-done` or fix
   - **FAIL** → suggest `aif-fix` with findings summary

## Verification Checks

### Task Completeness

For each item in `task.md → Scope → In Scope`:

| Check | Description |
|-------|-------------|
| Implementation exists | Code that implements the requirement is present |
| Matches specification | Implementation matches what was described |
| Acceptance criteria met | All criteria in task.md are satisfied |

### Rules Compliance

Check each rule in `rules.md`:

| Section | Checks |
|---------|--------|
| Implementation Rules | All rules followed |
| Code Style | Style conventions applied |
| Testing Requirements | Required tests present and passing |
| Documentation Requirements | Docs updated as required |
| Security Considerations | Security rules followed |

### Constraints Verification

For each `constraints-*.md` file:

- Read constraint definitions
- Verify implementation satisfies constraints
- Report any violations

### Code Quality

| Check | Commands |
|-------|----------|
| Build | `npm run build`, `go build`, `cargo check`, etc. |
| Tests | `npm test`, `go test`, `pytest`, etc. |
| Lint | `npm run lint`, `golangci-lint`, etc. |

### Architecture Consistency

- Verify files are in correct locations per ARCHITECTURE.md
- Check dependency rules (no violations of layer boundaries)
- Verify integration points match documented contracts

### Documentation Sync

- Check if new dependencies are documented
- Verify API changes are documented
- Check if README needs updates

## Findings Structure

```yaml
findings:
  blocking:      # Must fix before done
    - id: B001
      check: task-completeness
      file: src/auth/login.ts
      line: 45
      description: "Login endpoint missing rate limiting"
      rule: "rules.md → Implementation Rules → #3"

  important:     # Should fix, but not blocking
    - id: I001
      check: code-quality
      file: src/auth/login.ts
      line: 12
      description: "TODO left in code"
      severity: important

  optional:      # Nice to fix
    - id: O001
      check: documentation
      file: README.md
      description: "New API endpoint not documented"
      severity: optional

summary:
  total: 3
  blocking: 1
  important: 1
  optional: 1

verdict: fail  # pass | pass-with-notes | fail
```

## Verdict Rules

| Verdict | Blocking | Important | Action |
|---------|----------|-----------|--------|
| **PASS** | 0 | 0+ | Ready for `aif-done` |
| **PASS with notes** | 0 | 1+ | Can proceed to `aif-done` or fix |
| **FAIL** | 1+ | any | Must run `aif-fix` |

## Output Format

```
## Verification Report: {{plan-id}}

### Summary
| Category | Found |
|----------|-------|
| Blocking | 1 |
| Important | 2 |
| Optional | 1 |

### Verdict: ❌ FAIL

---

### Blocking Issues

#### B001: Login endpoint missing rate limiting
- **Check:** Task completeness
- **File:** src/auth/login.ts:45
- **Rule:** rules.md → Implementation Rules → #3
- **Fix:** Add rate limiting middleware to login endpoint

### Important Issues

#### I001: TODO left in code
- **File:** src/auth/login.ts:12
- **Fix:** Remove or resolve TODO comment

### Optional Issues

#### O001: New API endpoint not documented
- **File:** README.md
- **Fix:** Add endpoint documentation

---

### Next Steps

❌ Run `/aif-fix` to address blocking and important issues
```

## Status Update

After verification, update `status.yaml`:

```yaml
status: verifying  # or fixing if fail

verification:
  last_run: 2024-01-15T10:30:00Z
  verdict: fail
  findings:
    blocking: 1
    important: 2
    optional: 1
```

## Strict Mode

With `--strict` flag:

- All findings are treated as blocking
- No "optional" category
- Tests MUST pass
- No TODOs/FIXMEs allowed
- Full documentation required

## Integration

| Skill | Relationship |
|-------|--------------|
| `aif-implement` | Predecessor — provides implementation to verify |
| `aif-fix` | Successor on FAIL — fixes issues |
| `aif-done` | Successor on PASS — finalizes plan |

## Rules

- Read plan artifacts before verification
- Use verify.md checklist as primary guide
- Produce structured findings with severity
- Update status.yaml after verification
- Never modify implementation code (read-only)
- Route to appropriate next skill based on verdict
