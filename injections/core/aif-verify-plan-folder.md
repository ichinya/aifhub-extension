## AIFHub Verify Plan-Folder Override

Apply this block before the upstream `aif-verify` body. When this guidance conflicts with the base skill text, this block wins.

### Goal

Use the built-in `/aif-verify` skill as the canonical verification command for the extension workflow.

### Skill-Context Resolution

Read skill-context in this order:

1. `.ai-factory/skill-context/aif-verify/SKILL.md`
2. `.ai-factory/skill-context/aif-verify-plus/SKILL.md` as legacy compatibility fallback

If both exist, `aif-verify` wins.

### Plan Resolution

Resolve the active target as a companion pair:

- `.ai-factory/plans/<plan-id>.md`
- `.ai-factory/plans/<plan-id>/`

If verification enters through a legacy folder-only plan, create the missing companion plan file before verification and record the migration in `status.yaml.history`.

### Plan-Folder Contract

When the resolved target is a plan folder, preserve the current verification contract:

- read `task.md`, `context.md`, `rules.md`, `verify.md`, `status.yaml`, optional `constraints-*.md`, optional `explore.md`
- update only `status.yaml` and `verify.md`
- keep source code and project context files read-only

### Workflow Integration

- In the extension workflow, `/aif-implement` hands off to `/aif-verify`.
- Route failing verification to `/aif-fix`.
- On `PASS` or `PASS with notes`, stop at the verified state and recommend `/aif-done` only when archive/commit/PR/follow-up finalization is needed.
- Never archive into `.ai-factory/specs/`, never create `spec.md`, never update `specs/index.yaml`, and never set `status.yaml.status` to `done`.
- When `--check-only` is present, keep the same no-archive behavior and return a verification-only gate result for downstream review/finalization flows.
- Do not redirect the user to legacy finalize aliases, and do not present `/aif-done` as a replacement for `/aif-verify`; `/aif-done` is an optional post-verify AIFHub finalizer.
