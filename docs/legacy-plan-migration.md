[← Previous Page](active-change-resolver.md) · [Back to README](README.md)

# Legacy Plan Migration

Use this migration when a project has legacy AI Factory plan artifacts but the active workflow expects OpenSpec-native changes.

Legacy sources are read from `.ai-factory/plans/<id>.md` and `.ai-factory/plans/<id>/`. The migration creates canonical OpenSpec change artifacts under `openspec/changes/<change-id>/` and preserves runtime-only material under `.ai-factory/state/<change-id>/` or `.ai-factory/qa/<change-id>/`.

## Commands

List legacy plans:

```bash
node scripts/migrate-legacy-plans.mjs --list
```

Preview one migration without writing files:

```bash
node scripts/migrate-legacy-plans.mjs add-oauth --dry-run
```

Migrate one plan:

```bash
node scripts/migrate-legacy-plans.mjs add-oauth
```

Preview or migrate all discovered plans:

```bash
node scripts/migrate-legacy-plans.mjs --all --dry-run
node scripts/migrate-legacy-plans.mjs --all
```

The package script is an optional convenience:

```bash
npm run migrate:legacy-plans -- add-oauth --dry-run
```

Use `--json` when automation needs structured output.

## Collision Behavior

Default collision behavior is `fail`: if `openspec/changes/<id>` already exists, migration stops without overwriting it.

Supported modes:

| Mode | Behavior |
|------|----------|
| `fail` | Stop when the target OpenSpec change exists |
| `suffix` | Create a distinct target such as `<id>-migrated` |
| `merge-safe` | Create only missing files and report skipped existing files |
| `overwrite` | Overwrite generated targets only when explicitly requested |

Example:

```bash
node scripts/migrate-legacy-plans.mjs add-oauth --on-collision suffix
```

## Artifact Mapping

Canonical OpenSpec artifacts:

| Legacy source | OpenSpec target |
|---------------|-----------------|
| `.ai-factory/plans/<id>.md` | `openspec/changes/<id>/proposal.md` |
| `.ai-factory/plans/<id>/task.md` | `openspec/changes/<id>/tasks.md` |
| Design-like `context.md` | `openspec/changes/<id>/design.md` |
| Clear behavioral requirements | `openspec/changes/<id>/specs/migrated/spec.md` |

Runtime and QA preservation:

| Legacy source | Runtime target |
|---------------|----------------|
| `context.md` | `.ai-factory/state/<id>/legacy-context.md` |
| `rules.md` | `.ai-factory/state/<id>/legacy-rules.md` |
| `status.yaml` | `.ai-factory/state/<id>/legacy-status.yaml` |
| `explore.md` | `.ai-factory/state/<id>/legacy-explore.md` |
| `verify.md` | `.ai-factory/qa/<id>/legacy-verify.md` |

`verify.md` and `status.yaml` are never copied into `openspec/changes/<id>/`. The migration never mutates `openspec/specs/**`.

## Validation and Reports

After a non-dry-run migration, the script writes:

```text
.ai-factory/state/<id>/migration-report.md
```

The report lists source artifacts, generated OpenSpec artifacts, runtime artifacts, validation status, diagnostics, and manual follow-ups.

When a compatible OpenSpec CLI is available, migration runs change validation through the shared runner. Missing or unsupported OpenSpec CLI records `SKIPPED` and does not block migration.

If validation fails, generated files remain in place and the report records `FAIL`; the script does not rollback by deleting migrated or legacy artifacts.

## After Migration

Legacy artifacts are not deleted. Review the generated OpenSpec change and refine it before implementation:

```bash
/aif-improve <change-id>
```

Generated delta specs are conservative. Review them before relying on them as product requirements.
