[Previous Page](spec-coverage.md) | [Back to Documentation](README.md) | [Next Page](active-change-resolver.md)

# Legacy Plan Migration

Use legacy migration when a project has classic `.ai-factory/plans` artifacts and the active workflow expects OpenSpec-native changes.

Migration is explicit. It does not run automatically from `/aif-improve`, `/aif-implement`, or `/aif-verify`.

AI Factory 2.18 has two legacy shapes. Classic plans use a sibling `<id>.md` plus optional companion directory. Marked ultra plans use `<id>/index.md`, direct `phase-*.md`, and exactly one standalone `<!-- aif:plan-mode:ultra -->`. AIFHub migrates only classic shapes. A valid marked ultra bundle remains upstream-owned and is reported as `skipped-ultra`; an invalid ultra-like shape or classic/ultra collision fails closed before any write.

## Commands

List discovered legacy plans:

```bash
ai-factory aifhub-migrate-legacy-plans --list
```

Dry-run one migration:

```bash
ai-factory aifhub-migrate-legacy-plans <change-id> --dry-run
```

Migrate one plan:

```bash
ai-factory aifhub-migrate-legacy-plans <change-id>
```

Dry-run all discovered plans:

```bash
ai-factory aifhub-migrate-legacy-plans --all --dry-run
```

Migrate all discovered plans:

```bash
ai-factory aifhub-migrate-legacy-plans --all
```

Use the package script only for repository-local development:

```bash
npm run migrate:legacy-plans -- <change-id> --dry-run
```

Use JSON output for automation:

```bash
ai-factory aifhub-migrate-legacy-plans <change-id> --json
```

## Captured Legacy Source Root

Before switching from legacy to OpenSpec-native mode, `/aif-mode` resolves the current project-relative `paths.plans`. If unresolved legacy work remains after the switch or migration is declined/incomplete, it records that root in:

```text
.ai-factory/state/legacy-plan-source.json
```

Later OpenSpec-mode discovery uses this captured root instead of scanning canonical `openspec/changes`. A caller may override it explicitly for one command:

```bash
ai-factory aifhub-migrate-legacy-plans --list --legacy-source <project-relative-plans-root>
ai-factory aifhub-migrate-legacy-plans <change-id> --legacy-source <project-relative-plans-root> --dry-run
```

The root must be a safe project-relative directory. Lexical or resolved overlap with `openspec/changes` is rejected. Diagnostics may report the safe relative root and source kind (`explicit`, `recorded`, or `default`) but must not expose private absolute paths or plan bodies.

## Upstream Archive Is Not Migration

AI Factory 2.14+ `/aif-archive` is legacy plan cleanup, not OpenSpec migration. AI Factory 2.18 also lets that upstream command archive a marked ultra bundle atomically in legacy mode.

It may move completed legacy `paths.plans/*.md` files into `paths.archive/plans/*.md`, where `paths.archive` defaults to `.ai-factory/archive/`. With `workflow.plan_id_format: sequential`, archived legacy plans are excluded from active plan discovery and from the next sequential number calculation. With `/aif-archive --roadmap`, upstream AI Factory may snapshot closed roadmap milestones under `paths.archive/roadmap/`.

Use `ai-factory aifhub-migrate-legacy-plans ...` when classic legacy plan content must become canonical OpenSpec-native artifacts under `openspec/changes/<change-id>/`. Use upstream `/aif-archive` only for completed legacy classic/marked-ultra artifacts. In OpenSpec-native mode, plan-mutating `/aif-archive` targets stop before plan discovery and return `/aif-done <change-id>`; `/aif-archive` must not modify `openspec/changes/**`, `openspec/specs/**`, `.ai-factory/qa/**`, `.ai-factory/state/**`, or `.ai-factory/rules/generated/**`.

## Collision Behavior

The default collision mode is `fail`: if `openspec/changes/<change-id>/` already exists, migration stops without overwriting it.

Supported collision modes:

```bash
ai-factory aifhub-migrate-legacy-plans <change-id> --on-collision fail
ai-factory aifhub-migrate-legacy-plans <change-id> --on-collision merge-safe
ai-factory aifhub-migrate-legacy-plans <change-id> --on-collision suffix
ai-factory aifhub-migrate-legacy-plans <change-id> --on-collision overwrite
```

| Mode | Behavior |
|---|---|
| `fail` | Stop when the target OpenSpec change exists. |
| `merge-safe` | Write only missing files and report skipped existing files. |
| `suffix` | Create a distinct target such as `<change-id>-migrated`. |
| `overwrite` | Overwrite generated migration targets only when explicitly requested. |

If `--all` reports `target-exists` for every discovered plan, the project already has canonical OpenSpec change directories. Preview the non-destructive merge path first:

```bash
ai-factory aifhub-migrate-legacy-plans --all --on-collision merge-safe --dry-run
```

Then apply it only when the dry-run output is acceptable:

```bash
ai-factory aifhub-migrate-legacy-plans --all --on-collision merge-safe
```

Use `--on-collision suffix` instead when existing OpenSpec changes must remain completely untouched.

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

Marked ultra `index.md` and direct `phase-*.md` files have no migration mapping. They remain one upstream-owned atomic bundle and must not be flattened into `proposal.md`, `tasks.md`, or classic companion files by this command.

When clear behavioral requirements are extractable, migration may create:

```text
openspec/changes/<id>/specs/migrated/spec.md
```

Review migrated delta specs before treating them as product requirements.

## Safety Behavior

Migration never silently deletes legacy source files.

Migration classifies markers and ultra phase/index integrity before classic folder-only discovery. It does not create a sibling classic `<id>.md`, `task.md`, `status.yaml`, or OpenSpec change for a valid marked ultra bundle.

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

## Compatibility Export

OpenSpec-to-legacy export is available through `/aif-mode` for projects that intentionally switch back to legacy AI Factory-only mode:

```text
/aif-mode ai-factory --export-openspec --change <change-id> --yes
/aif-mode sync --export-openspec --change <change-id> --yes
```

This is a compatibility export, not migration. It flattens OpenSpec artifacts into legacy plan files and can lose delta-spec structure:

| OpenSpec source | Legacy compatibility target |
|---|---|
| `openspec/changes/<id>/proposal.md` | `.ai-factory/plans/<id>.md` |
| `openspec/changes/<id>/tasks.md` | `.ai-factory/plans/<id>/task.md` |
| proposal, design, and specs summary | `.ai-factory/plans/<id>/context.md` |
| `.ai-factory/rules/generated/openspec-merged-<id>.md` | `.ai-factory/plans/<id>/rules.md` |

Compatibility export preserves `openspec/` and does not overwrite existing legacy files unless `--yes` is passed.

## See Also

- [Usage](usage.md)
- [Context Loading Policy](context-loading-policy.md)
- [Active Change Resolver](active-change-resolver.md)
