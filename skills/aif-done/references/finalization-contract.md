# Finalization Contract

Reference for the `aif-done` skill and `aifhub-done-finalizer` Codex agent.

## Entry Conditions

- `status.yaml` exists in the active plan folder.
- `verification.verdict` is `pass` or `pass-with-notes`.
- No uncommitted changes outside plan scope (user must confirm if present).

## Archival Structure

```text
.ai-factory/specs/<plan-id>/
  |- plan.md          # companion plan file archived from .ai-factory/plans/<plan-id>.md
  |- spec.md          # implementation summary (if applicable)
  |- task.md          # completed task checklist
  |- verify.md        # verification findings
  `- ...              # other plan-folder artifacts (excluding status.yaml execution metadata)
```

## Specs Index Format

`.ai-factory/specs/index.yaml`:

```yaml
specs:
  - id: <plan-id>
    title: "<plan title>"
    archived_at: <ISO timestamp>
    verification: pass|pass-with-notes
    source_branch: <branch name or null>
```

## Commit Message Format

Conventional commit based on plan scope:

```
<type>(<scope>): <summary>

<body — what was implemented, referencing plan artifacts>
```

- `type` inferred from plan title/context (feat, fix, refactor, docs, chore).
- `scope` from plan-id or plan title.
- `body` summarizes key implementation points from the plan.

## PR Summary Format

```markdown
## Summary
- <bullet points from plan scope>

## Plan Reference
- Plan: `<plan-id>`
- Verification: <verdict>

## Test Plan
- [ ] <suggested verification steps based on plan scope>
```

## Follow-up Suggestions

Only suggest when plan contains evidence:

| Evidence | Suggested Follow-up |
|----------|-------------------|
| Roadmap milestone referenced and completed | `/aif-roadmap` update |
| New architecture pattern or module introduced | `/aif-architecture` update |
| New coding rules or conventions established | Rules update |
| Evolution candidates identified | `/aif-evolve` pass |

All follow-ups are suggestion-only — never auto-edit governance files.

## Status Update on Finalization

```yaml
status: done
verification:
  verdict: <preserved from verify>
finalization:
  archived_at: <ISO timestamp>
  archive_path: .ai-factory/specs/<plan-id>/
  commit_message_draft: |
    <draft>
  pr_summary_draft: |
    <draft>
```

## Error Handling

| Condition | Behavior |
|-----------|----------|
| No active plan found | Stop with guidance to select a plan |
| Verification not run / verdict missing | Stop, suggest `/aif-verify` |
| Verification failed (`fail`) | Stop, suggest `/aif-fix` then `/aif-verify` |
| Workspace dirty outside plan scope | Stop, ask user to confirm |
| `gh` not available | Output manual PR instructions instead of failing |
| Specs directory missing | Create `.ai-factory/specs/` and `index.yaml` |
