## AIFHub Verify Plan-Folder Override

Apply this block before the upstream `aif-verify` body. When this guidance conflicts with the base skill text, this block wins.

### Goal

Use the built-in `/aif-verify` skill as the canonical verification command for the extension's plan-folder workflow.

### Skill-Context Resolution

Read skill-context in this order:

1. `.ai-factory/skill-context/aif-verify/SKILL.md`
2. `.ai-factory/skill-context/aif-verify-plus/SKILL.md` as legacy compatibility fallback

If both exist, `aif-verify` wins.

### Plan-Folder Contract

When the resolved target is a plan folder, preserve the current verification contract:

- read `task.md`, `context.md`, `rules.md`, `verify.md`, `status.yaml`, optional `constraints-*.md`, optional `explore.md`
- update only `status.yaml` and `verify.md`
- keep source code and project context files read-only

### Workflow Integration

- In the extension workflow, `/aif-implement-plus` should hand off to `/aif-verify`.
- Route failing verification to `/aif-fix`.
- Route passing verification to `/aif-done`.

Do not redirect the user to a separate `aif-verify-plus` command. `/aif-verify` is the canonical command.
