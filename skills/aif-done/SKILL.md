---
name: aif-done
description: Finalize a plan, mark it complete, and archive artifacts to specs/. Use after aif-verify+ passes or when manually marking work as done.
argument-hint: "[plan-id] [--summary]"
---

# AIF Done

Finalize a plan by marking it complete, archiving artifacts to `.ai-factory/specs/`, and optionally updating project context.

## Workflow

1. **Find and load plan**
   - If `plan-id` argument provided → use `.ai-factory/plans/<plan-id>/`
   - Else check current git branch → look for matching plan folder
   - Read `status.yaml` to verify workflow state

2. **Verify completion eligibility**
   - Check `status.yaml → status` is `verifying` or `fixing`
   - Check `status.yaml → verification.verdict` is `pass` or `pass-with-notes`
   - If not eligible, ask user to confirm manual completion

3. **Generate completion summary**
   - Read all plan artifacts
   - Create summary of what was accomplished
   - List files changed/created
   - Capture lessons learned (optional)

4. **Archive to specs**
   - Copy plan artifacts to `.ai-factory/specs/<plan-id>/`
   - Create `spec.md` summary using [spec-template.md](references/spec-template.md)
   - Update `specs/index.yaml` following [index-schema.yaml](references/index-schema.yaml)
   - Preserve original timestamps

5. **Update project context** (if applicable)
   - Note changes that affect DESCRIPTION.md
   - Note architecture decisions for ARCHITECTURE.md
   - Suggest roadmap updates

6. **Clean up plan folder**
   - Option to remove or keep original plan folder
   - Update status.yaml → status: done

7. **Report completion**
   - Show archived location
   - List updated context files
   - Suggest next actions

## Specs Organization

```
.ai-factory/specs/
├── index.yaml              # Catalog of all specs
├── <plan-id>/
│   ├── spec.md             # Summary document
│   ├── task.md             # Original task
│   ├── context.md          # Context at completion time
│   ├── rules.md            # Rules used
│   ├── verify.md           # Final verification results
│   ├── status.yaml         # Final status
│   └── explore.md          # Exploration notes (if any)
```

### spec.md Structure

```markdown
# Spec: {{plan-id}}

## Summary
Brief description of what was implemented.

## Status
- **Completed:** {{completion_date}}
- **Verdict:** {{verification_verdict}}
- **Files Changed:** {{file_count}}

## Implementation

### Scope Delivered
- [x] Item 1
- [x] Item 2
- [ ] Item 3 (deferred)

### Key Changes
| File | Change Type | Description |
|------|-------------|-------------|
| src/auth/login.ts | modified | Added rate limiting |
| src/middleware/rate-limit.ts | created | New middleware |

## Verification

### Final Results
- Task Completeness: ✅ Pass
- Rules Compliance: ✅ Pass
- Code Quality: ✅ Pass (build, tests, lint)
- Architecture: ✅ Pass

### Findings Resolved
| ID | Issue | Resolution |
|----|-------|------------|
| B001 | Missing rate limiting | Added middleware |
| I001 | TODO in code | Removed |

## Lessons Learned
<!-- Optional: what went well, what to improve -->

## References
- Original plan: `.ai-factory/plans/{{plan-id}}/`
- Issue: #{{issue_number}}
- PR: #{{pr_number}}
```

### index.yaml Structure

```yaml
# Specs Catalog
# Index of all finalized specifications

specs:
  - id: add-oauth
    title: Add OAuth Authentication
    completed: 2024-01-15
    verdict: pass
    files_changed: 12
    tags: [auth, security]

  - id: add-dark-mode
    title: Add Dark Mode Support
    completed: 2024-01-20
    verdict: pass-with-notes
    files_changed: 8
    tags: [ui, theming]

# Stats
stats:
  total: 2
  by_verdict:
    pass: 1
    pass-with-notes: 1
    fail: 0
```

## Completion Summary (with --summary flag)

When `--summary` is provided, generate a detailed summary:

```markdown
## Completion Summary: {{plan-id}}

### What Was Done
- Added OAuth authentication with Google and GitHub providers
- Implemented session management with JWT tokens
- Added rate limiting to auth endpoints
- Updated documentation

### Files Changed (12)
- Created: 4 files
- Modified: 8 files

### Tests
- Added: 15 tests
- All passing: ✅

### Verification
- Result: ✅ PASS
- Findings: 0 blocking, 0 important, 1 optional

### Time
- Started: 2024-01-14
- Completed: 2024-01-15
- Duration: 2 days

### Next Steps
- Monitor auth performance
- Consider adding more OAuth providers
```

## Context Updates

After archiving, suggest updates to project context:

### DESCRIPTION.md Updates
If the implementation added/changed:
- New dependencies → suggest adding to tech stack
- New modules → suggest documenting
- New integrations → suggest listing

### ARCHITECTURE.md Updates
If the implementation:
- Added new architectural patterns → suggest documenting
- Changed dependencies between modules → suggest updating
- Introduced new layers → suggest adding

### ROADMAP.md Updates
Suggest marking milestones as complete:
```yaml
# Check if plan relates to roadmap milestone
- Find matching milestone in ROADMAP.md
- Suggest updating status to "done"
- Add completion date and spec reference
```

## Status Update

Final status.yaml state:

```yaml
status: done

completed_at: 2024-01-15T10:30:00Z

verification:
  last_run: 2024-01-15T10:25:00Z
  verdict: pass

archived_to: .ai-factory/specs/add-oauth/

history:
  - timestamp: 2024-01-14T09:00:00Z
    event: created
    to: draft
  - timestamp: 2024-01-14T10:00:00Z
    event: status_change
    to: implementing
  - timestamp: 2024-01-15T10:20:00Z
    event: status_change
    to: verifying
  - timestamp: 2024-01-15T10:30:00Z
    event: completed
    to: done
```

## Cleanup Options

Ask user about plan folder cleanup:

```
Plan artifacts archived to .ai-factory/specs/{{plan-id}}/

Keep original plan folder?

Options:
1. Remove — Delete .ai-factory/plans/{{plan-id}}/ (recommended)
2. Keep — Retain both copies
3. Keep for N days — Remove after retention period
```

## Integration

| Skill | Relationship |
|-------|--------------|
| `aif-verify+` | Predecessor — must pass before done |
| `aif-fix` | Predecessor — fixes issues before verify |
| `aif-analyze` | May need update if DESCRIPTION.md changed |
| `aif-roadmap` | May need update for milestone completion |

## Rules

- Only mark done after verification passes (or manual confirmation)
- Always archive to specs/ before marking done
- Preserve original artifacts in archive
- Update index.yaml with new spec entry
- Suggest context updates but don't auto-modify
- Keep history trail in status.yaml

## Example Usage

```
# After verify+ passes
/aif-done

# With detailed summary
/aif-done --summary

# Specific plan
/aif-done add-oauth

# Manual completion (skip verification)
/aif-done --force
```
