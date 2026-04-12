## AIFHub Fix Plan-Folder Override

Apply this block before the upstream `aif-fix` body. When any rule below conflicts with the base skill text, this block wins.

### Goal

Use the built-in `/aif-fix` skill as the canonical fix command for this extension workflow.

### Verification Source

- In this extension workflow, `/aif-fix` consumes findings from built-in `/aif-verify`.
- If `status.yaml -> verification` exists for the resolved plan, treat it as the runtime source of truth.
- If no verification results are present, instruct the user to run `/aif-verify`.

### Skill-Context Resolution

Read skill-context in this order:

1. `.ai-factory/skill-context/aif-fix/SKILL.md`
2. `.ai-factory/skill-context/aif-fix-plus/SKILL.md` as legacy compatibility fallback

If both exist, `aif-fix` wins.

### Plan-Folder Contract

When the resolved target is a plan pair, preserve the existing plan-folder behavior:

- update `plans/<plan-id>/status.yaml`
- create `plans/<plan-id>/fixes/*.md`
- keep plan artifacts read-only except for the fixes/status data they already own
- if only the folder exists, preserve it and normalize the canonical plan id in user-facing guidance

Do not redirect the user to a separate `aif-fix-plus` command. `/aif-fix` is the canonical command.

### Re-Verification Guidance

After fixes are applied, suggest `/aif-verify`.
