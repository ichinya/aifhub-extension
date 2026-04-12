## AIFHub Verify Finalization Override

Apply this block before the upstream `aif-verify` body. When this guidance conflicts with the base skill text, this block wins.

### Goal

Use the built-in `/aif-verify` skill as the canonical verification and finalization command for the extension workflow.

### Skill-Context Resolution

Read skill-context in this order:

1. `.ai-factory/skill-context/aif-verify/SKILL.md`
2. `.ai-factory/skill-context/aif-verify-plus/SKILL.md` as legacy compatibility fallback

If both exist, `aif-verify` wins.

### Plan Resolution

Resolve the active target as a companion pair:

- `.ai-factory/plans/<plan-id>.md`
- `.ai-factory/plans/<plan-id>/`

If verification enters through a legacy folder-only plan, create the missing companion plan file before finalization and record the migration in `status.yaml.history`.

### Plan-Folder Contract

When the resolved target is a plan folder, preserve the current verification contract:

- read `task.md`, `context.md`, `rules.md`, `verify.md`, `status.yaml`, optional `constraints-*.md`, optional `explore.md`
- update only `status.yaml` and `verify.md`
- keep source code and project context files read-only

### Workflow Integration and Finalization

- In the extension workflow, `/aif-implement` hands off to `/aif-verify`.
- Route failing verification to `/aif-fix`.
- On `PASS` or `PASS with notes`, finalize automatically unless the user passed `--check-only`.
- Finalization must archive the companion plan file and plan folder into `.ai-factory/specs/<plan-id>/`, update `.ai-factory/specs/index.yaml`, and set `status.yaml.status` to `done`.
- Copy the companion plan file into the archive as `plan.md`.
- Copy these plan-folder artifacts into the archive when present: `task.md`, `context.md`, `rules.md`, `verify.md`, `status.yaml`, optional `explore.md`, and the full `fixes/` directory.
- Generate `spec.md` using `injections/references/aif-verify/spec-template.md`.
- Create or update `specs/index.yaml` using `injections/references/aif-verify/index-schema.yaml` as the schema reference when bootstrapping the catalog.
- Preserve frontmatter on metadata-bearing archived markdown artifacts; the copied `plan.md` may remain plain markdown if the source companion file has no frontmatter.
- When `--check-only` is present, skip archiving and leave the plan ready for a later final verification run.
- Do not redirect the user to deprecated finalize or legacy verify aliases. `/aif-verify` is the canonical command.
