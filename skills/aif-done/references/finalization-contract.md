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

If the archive directory already exists from an earlier `/aif-done` run or legacy `/aif-verify` auto-archive behavior, treat finalization as a refresh pass and update the archived artifacts instead of failing.

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

```text
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

## Governance and Evolution Follow-ups

Apply only when the verified plan contains evidence:

| Evidence | Finalization Action |
|----------|--------------------|
| Roadmap milestone referenced and completed | Update roadmap through the roadmap owner or return an exact `/aif-roadmap` handoff |
| New architecture pattern or module introduced | Update architecture through the architecture owner or return an exact `/aif-architecture` handoff |
| New coding rules or conventions established | Update the project rules owner path or return an exact rules handoff |
| Evolution candidates identified | Run `/aif-evolve` when explicitly requested and supported, otherwise recommend it |

Never invent governance changes without plan evidence. If the current runtime cannot safely perform the owning update, return the exact next command/instruction instead of silently skipping it.

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
  governance_updates:
    roadmap: <updated|handoff|skip>
    rules: <updated|handoff|skip>
    architecture: <updated|handoff|skip>
  evolve_action: <ran|suggested|skip>
```

## Error Handling

| Condition | Behavior |
|-----------|----------|
| No active plan found | Stop with guidance to select a plan |
| Verification not run / verdict missing | Stop, suggest `/aif-verify` |
| Verification failed (`fail`) | Stop, suggest `/aif-fix` then `/aif-verify` |
| Workspace dirty outside plan scope | Stop, ask user to confirm |
| Archive already exists | Refresh archive/spec/index outputs; do not fail |
| `gh` not available | Output manual PR instructions instead of failing |
| Specs directory missing | Create `.ai-factory/specs/` and `index.yaml` |
