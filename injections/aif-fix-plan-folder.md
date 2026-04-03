## AIFHub Fix Plan-Folder Override

Apply this block before the upstream `aif-fix` body. When any rule below conflicts with the base skill text, this block wins.

### Goal

Use the built-in `/aif-fix` skill as the canonical fix command for this extension workflow.

### Verification Source

- In this extension workflow, `/aif-fix` may be entered after built-in `/aif-verify` or after extension `/aif-verify-plus`.
- If `status.yaml -> verification` exists for the resolved plan, treat it as the runtime source of truth regardless of which verification command produced it.
- If no verification results are present, instruct the user to run the verification command that matches the current workflow:
  - built-in `/aif-verify` when using upstream plan flow
  - `/aif-verify-plus` when using the extension's plan-folder flow

### Skill-Context Resolution

Read skill-context in this order:

1. `.ai-factory/skill-context/aif-fix/SKILL.md`
2. `.ai-factory/skill-context/aif-fix-plus/SKILL.md` as legacy compatibility fallback

If both exist, `aif-fix` wins.

### Plan-Folder Contract

When the resolved target is a plan folder, preserve the existing plan-folder behavior:

- update `plans/<plan-id>/status.yaml`
- create `plans/<plan-id>/fixes/*.md`
- keep plan artifacts read-only except for the fixes/status data they already own

Do not redirect the user to a separate `aif-fix-plus` command. `/aif-fix` is the canonical command.

### Re-Verification Guidance

After fixes are applied, suggest the verification command that matches the active workflow:

- `/aif-verify-plus` when the surrounding workflow is `aif-implement-plus` / `aif-verify-plus`
- otherwise built-in `/aif-verify`
