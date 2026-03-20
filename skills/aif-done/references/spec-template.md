---
artifact_type: spec
plan_id: "{{plan_id}}"
title: "{{task_title}}"
artifact_status: archived
owner: aif-done
created_at: {{start_date}}
updated_at: {{archive_date}}
source_issue: {{issue_number}}
source_plan: "{{plan_id}}"
---

# Spec: {{plan_id}}

> Finalized specification archived from plan

## Summary

<!-- Краткое описание реализованного в 1-2 предложения -->

## Status

| Field | Value |
|-------|-------|
| **Completed** | {{completion_date}} |
| **Verdict** | {{verification_verdict}} |
| **Files Changed** | {{file_count}} |
| **Tests Added** | {{tests_added}} |

## Implementation

### Scope Delivered

<!-- Из task.md → Scope → In Scope -->

- [x] Item 1
- [x] Item 2
- [ ] Item 3 (deferred — reason)

### Key Changes

| File | Change Type | Description |
|------|-------------|-------------|
| `path/to/file` | created/modified/deleted | What changed |

### Dependencies Added

<!-- Новые зависимости, если есть -->

| Package | Version | Purpose |
|---------|---------|---------|
| - | - | - |

## Verification

### Final Results

| Check | Status | Notes |
|-------|--------|-------|
| Task Completeness | ✅/❌ | - |
| Rules Compliance | ✅/❌ | - |
| Code Quality | ✅/❌ | build, tests, lint |
| Architecture | ✅/❌ | - |
| Documentation | ✅/❌ | - |

### Findings Resolved

| ID | Severity | Issue | Resolution |
|----|----------|-------|------------|
| B001 | blocking | Description | How resolved |
| I001 | important | Description | How resolved |

### Findings Accepted (optional)

| ID | Severity | Issue | Reason for deferral |
|----|----------|-------|---------------------|
| O001 | optional | Description | Why not fixed now |

## Decisions Made

<!-- Ключевые архитектурные или технические решения -->

1. **Decision 1** — Rationale
2. **Decision 2** — Rationale

## Lessons Learned

<!-- Что пошло хорошо, что можно улучшить -->

### What Went Well
-

### What to Improve
-

## References

| Type | Reference |
|------|-----------|
| Original Plan | `.ai-factory/plans/{{plan_id}}/` |
| Issue | #{{issue_number}} |
| PR | #{{pr_number}} |
| Branch | `feature/{{plan_id}}` |

---

*Archived: {{archive_date}}*
*Duration: {{start_date}} — {{completion_date}}*
