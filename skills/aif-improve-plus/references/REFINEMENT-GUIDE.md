# Refinement Guide (AIF Improve+)

## Report Shape

Use a concise report with these sections when refinements are found:

```text
## Plan Refinement Report

Plan: <plan-id>
Mode: local|subagent

Missing scope items: <n>
Artifact improvements: <n>
Verify/rules sync fixes: <n>
Metadata/schema fixes: <n>
```

## Artifact Sync Checklist

When applying changes, verify all of the following:

1. `task.md` checkboxes reflect the intended scope
2. `context.md` references the current relevant files and constraints
3. `rules.md` matches the implementation/testing/docs expectations
4. `verify.md` covers the updated scope and rules
5. `status.yaml.progress.scope_total` matches the number of In Scope items
6. `status.yaml.progress.scope_completed` is not lower than checked In Scope items
7. `status.yaml.updated` and `history` are refreshed

## Preservation Rules

- Never remove completed items silently
- Prefer surgical edits over full rewrites
- If a rewrite is unavoidable, preserve completed checkboxes and Findings/Verdict sections verbatim
