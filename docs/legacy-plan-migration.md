[Previous Page](openspec-compatibility.md) | [Back to Documentation](README.md) | [Next Page](active-change-resolver.md)

# Legacy Plan Migration

Use legacy migration when a project has `.ai-factory/plans` artifacts and the active workflow expects OpenSpec-native changes.

Migration is explicit. It does not run automatically from `/aif-improve`, `/aif-implement`, or `/aif-verify`.

## Commands

List discovered legacy plans:

```bash
node scripts/migrate-legacy-plans.mjs --list
```

Dry-run one migration:

```bash
node scripts/migrate-legacy-plans.mjs <change-id> --dry-run
```

Migrate one plan:

```bash
node scripts/migrate-legacy-plans.mjs <change-id>
```

Dry-run all discovered plans:

```bash
node scripts/migrate-legacy-plans.mjs --all --dry-run
```

Migrate all discovered plans:

```bash
node scripts/migrate-legacy-plans.mjs --all
```

Use the package wrapper when preferred:

```bash
npm run migrate:legacy-plans -- <change-id> --dry-run
```

Use JSON output for automation:

```bash
node scripts/migrate-legacy-plans.mjs <change-id> --json
```

## Collision Behavior

The default collision mode is `fail`: if `openspec/changes/<change-id>/` already exists, migration stops without overwriting it.

Supported collision modes:

```bash
node scripts/migrate-legacy-plans.mjs <change-id> --on-collision fail
node scripts/migrate-legacy-plans.mjs <change-id> --on-collision merge-safe
node scripts/migrate-legacy-plans.mjs <change-id> --on-collision suffix
node scripts/migrate-legacy-plans.mjs <change-id> --on-collision overwrite
```

| Mode | Behavior |
|---|---|
| `fail` | Stop when the target OpenSpec change exists. |
| `merge-safe` | Write only missing files and report skipped existing files. |
| `suffix` | Create a distinct target such as `<change-id>-migrated`. |
| `overwrite` | Overwrite generated migration targets only when explicitly requested. |

## Artifact Mapping

Canonical and preservation mapping:

| Legacy source | Target |
|---|---|
| `.ai-factory/plans/<id>.md` | `openspec/changes/<id>/proposal.md` |
| `.ai-factory/plans/<id>/task.md` | `openspec/changes/<id>/tasks.md` |
| `.ai-factory/plans/<id>/context.md` | `openspec/changes/<id>/design.md` and/or `.ai-factory/state/<id>/legacy-context.md` |
| `.ai-factory/plans/<id>/rules.md` | `.ai-factory/state/<id>/legacy-rules.md` |
| `.ai-factory/plans/<id>/verify.md` | `.ai-factory/qa/<id>/legacy-verify.md` |
| `.ai-factory/plans/<id>/status.yaml` | `.ai-factory/state/<id>/legacy-status.yaml` |
| `.ai-factory/plans/<id>/explore.md` | `.ai-factory/state/<id>/legacy-explore.md` |

When clear behavioral requirements are extractable, migration may create:

```text
openspec/changes/<id>/specs/migrated/spec.md
```

Review migrated delta specs before treating them as product requirements.

## Safety Behavior

Migration never silently deletes legacy source files.

Migration must not write migrated output under:

- `.ai-factory/plans/`
- `openspec/specs/`
- another change's `.ai-factory/state/<change-id>/`
- another change's `.ai-factory/qa/<change-id>/`

If a safety check fails, the script stops and reports diagnostics.

## Validation and Reports

After a non-dry-run migration, the script writes:

```text
.ai-factory/state/<id>/migration-report.md
```

The report records source artifacts, generated OpenSpec artifacts, runtime artifacts, validation status, diagnostics, and manual follow-ups.

When a compatible OpenSpec CLI is available, migration validates the migrated change through the shared runner.

When the CLI is missing or unsupported, validation is recorded as `SKIPPED`; this is degraded behavior, not silent success.

When validation fails, generated files remain in place and the report records `FAIL`. The script does not roll back by deleting migrated or legacy artifacts.

## After Migration

Refine the migrated OpenSpec-native change before implementation:

```text
/aif-improve <change-id>
```

Then run the normal v1 flow:

```text
/aif-implement <change-id>
/aif-verify <change-id>
/aif-done <change-id>
```

## See Also

- [Usage](usage.md)
- [Context Loading Policy](context-loading-policy.md)
- [Active Change Resolver](active-change-resolver.md)
