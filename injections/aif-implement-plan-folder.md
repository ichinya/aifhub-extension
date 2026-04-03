## AIFHub Implement Plan-Folder Override

Apply this block before the upstream `aif-implement` body. When any rule below conflicts with the base skill text, this block wins.

### Goal

Use the built-in `/aif-implement` skill as the canonical execution command for the extension's plan-folder workflow.

### Skill-Context Resolution

Read skill-context in this order:

1. `.ai-factory/skill-context/aif-implement/SKILL.md`
2. `.ai-factory/skill-context/aif-implement-plus/SKILL.md` as legacy compatibility fallback

If both exist, `aif-implement` wins.

### Workflow Rule

- Do not redirect the user to a separate `aif-implement-plus` command.
- `/aif-implement` is the canonical execution command for this extension workflow.
- When no plan exists yet, route the user through `/aif-new "<task>" -> /aif-improve`.
- After tasks complete, use `/aif-verify`, `/aif-fix`, and `/aif-done`.

### Subagent Compatibility

When checking optional Claude worker availability, support both current and legacy filenames:

- prefer `.claude/agents/implement-coordinator.md`
- support `.claude/agents/implement-worker.md`
- support legacy `.claude/agents/implementer.md`
- support legacy `.claude/agents/implementer-isolation.md`

When persisting `execution.subagent`, allow:

- `implement-coordinator`
- `implementer`
- `implementer-isolation`
- `null`

Prefer `implement-coordinator` when available.

### Git Strategy Compatibility

Preserve any existing `execution.git.*` fields chosen by `/aif-apply`. Do not drop or overwrite sibling git fields when updating execution mode metadata.

### Compatibility Note

If historical docs or plan notes still mention `aif-implement-plus`, interpret that as `/aif-implement`.
