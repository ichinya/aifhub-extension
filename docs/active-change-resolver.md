[Previous Page](legacy-plan-migration.md) | [Back to Documentation](README.md) | [Next Page](adr/0001-openspec-native-artifact-protocol.md)

# Active Change Resolver

`scripts/active-change-resolver.mjs` provides the shared dependency-free resolver for OpenSpec-native runtime flows. It selects one active change, returns machine-readable diagnostics, and computes AI Factory runtime paths without writing to canonical OpenSpec artifacts.

## Precedence

Resolution uses this order:

1. Explicit `changeId`.
2. Current working directory under `openspec/changes/<change-id>/`.
3. Current git branch matched to an exact persisted `## AIFHub Source Binding`.
4. Current git branch mapped to an unbound active change by legacy slug variants.
5. `.ai-factory/state/current.yaml`.
6. A single active change under `openspec/changes/`.
7. A structured failure with candidates when no unique change can be selected.

Explicit IDs are authoritative. An invalid or missing explicit ID returns `invalid-change-id` or `explicit-change-not-found` and does not fall back to another source.

Archived changes under `openspec/changes/archive/`, hidden directories, files, and unmarked directories are not active changes.

## Result Shape

Resolver results are stable objects:

```js
{
  ok: true,
  changeId: 'add-oauth',
  source: 'explicit',
  changePath: '/repo/openspec/changes/add-oauth',
  statePath: '/repo/.ai-factory/state/add-oauth',
  qaPath: '/repo/.ai-factory/qa/add-oauth',
  candidates: ['add-oauth'],
  warnings: [],
  errors: []
}
```

Failures keep the same top-level fields and set `ok: false`, `changeId: null`, `changePath: null`, `statePath: null`, and `qaPath: null`. Diagnostic entries always include stable `code` and `message` fields.

Common failure codes:

| Code | Meaning |
|---|---|
| `invalid-change-id` | The supplied ID is empty, absolute, contains path separators, contains `..`, or contains characters outside letters, numbers, `.`, `_`, and `-`. |
| `explicit-change-not-found` | The explicit ID is safe but no matching active change directory exists. |
| `source-binding-duplicate` / `source-binding-fields-invalid` | A reserved proposal source-binding section is duplicated or malformed. |
| `source-binding-provider-invalid` / `source-binding-primary-source-invalid` / `source-binding-external-id-invalid` / `source-binding-branch-invalid` | A source binding contains a non-canonical provider, work-item reference, external ID, or branch value. |
| `source-binding-change-id-mismatch` | The change directory ID does not start with the normalized external ID followed by a request slug. |
| `ambiguous-branch-binding` | More than one active source-bound change is bound to the exact current branch. |
| `ambiguous-branch-change` | The current branch maps to more than one active change. |
| `current-pointer-not-found` | The current pointer references a missing or inactive change. |
| `ambiguous-active-change` | More than one active change exists and no higher-precedence source selected one. |
| `no-active-change` | No active change could be resolved. |
| `filesystem-error` | The resolver could not inspect active change directories. |

## Runtime Paths

Runtime state is outside canonical OpenSpec changes:

```text
.ai-factory/state/<change-id>/
.ai-factory/qa/<change-id>/
.ai-factory/state/current.yaml
```

`resolveActiveChange()` computes `statePath` and `qaPath` on success but does not create directories. Use `ensureRuntimeLayout(changeId, options)` to create runtime directories. That helper returns absolute `statePath` and `qaPath` plus relative `created` and `preserved` arrays.

The helper never creates `.ai-factory/plans/<change-id>` and never writes under `openspec/changes/<change-id>/`.

`scripts/openspec-execution-context.mjs` builds on this resolver for `/aif-implement` and `/aif-fix`. In OpenSpec-native mode it reads canonical OpenSpec artifacts, generated rules, optional OpenSpec `instructions apply` output, and QA evidence for fixes; trace writers then write only under `.ai-factory/state/<change-id>/implementation/` or `.ai-factory/state/<change-id>/fixes/`.

OpenSpec-native implement/fix context does not require legacy `.ai-factory/plans/<id>/task.md`. Generated rules remain derived guidance, and missing OpenSpec CLI instructions degrade to warnings instead of blocking filesystem-based context loading.

`scripts/openspec-verification-context.mjs` also builds on this resolver for `/aif-verify`. It validates the active OpenSpec change before code checks when validation is enabled, writes validation/status evidence only under `.ai-factory/qa/<change-id>/`, treats missing CLI as degraded mode unless strict config requires CLI, and blocks code verification when OpenSpec validation is invalid.

`/aif-plan full` uses the same change-id vocabulary in OpenSpec-native mode. It should create canonical OpenSpec change artifacts under `openspec/changes/<change-id>/` and keep planning runtime evidence, when needed, under `.ai-factory/state/<change-id>/`.

`/aif-improve` also uses this vocabulary in OpenSpec-native mode. It refines only canonical OpenSpec artifacts, keeps runtime evidence under `.ai-factory/state/<change-id>/`, and treats archived targets under `openspec/changes/archive/**` as immutable by default. If further work is needed for an archived change, create a new active change instead of editing the archive silently.

## Current Pointer

The pointer file is `.ai-factory/state/current.yaml` by default. The resolver reads these YAML keys:

```yaml
change_id: add-oauth
changeId: add-oauth
active_change: add-oauth
activeChange: add-oauth
```

It also accepts equivalent JSON with one of those keys. `writeCurrentChangePointer()` writes the canonical YAML form:

```yaml
change_id: add-oauth
```

A stale pointer is an error and blocks fallback, so broken runtime state is visible instead of silently selecting another change.

## Branch Mapping

Plans created from GitHub, Linear, Jira, YouGile, or another MCP work item persist exact identity in `proposal.md`:

```markdown
## AIFHub Source Binding

- Provider: linear
- Primary source: mcp://linear/issue/6a1f24c8
- External ID: ENG-431
- Branch: feature/some-request-slug
```

`parseWorkItemSourceBinding()` requires one exact section, a canonical lowercase provider, one canonical HTTPS work-item URL or stable `mcp://` resource URI, a bounded readable external ID, and one exact safe branch name or `none`. `deriveSourceBoundChangeId()` normalizes `ENG-431` plus `Fix login timeout` to `eng-431-fix-login-timeout`; `matchesSourceBoundChangeId()` enforces that prefix and non-empty slug. `matchesPrimarySourceBinding()` compares the full primary reference, so the same `156` or `PROJ-77` from another repository, tenant, or provider never matches by key alone. `parseLegacyWorkItemSourceBinding()` applies the same value contract to double-quoted `source_binding.provider`, `source_binding.primary_source`, `source_binding.external_id`, and `source_binding.branch` values in legacy `status.yaml`.

The resolver scans active proposals after detecting the branch. One exact binding match returns source `branch-binding` before ordinary slug matching. Duplicate, malformed, ID-mismatched, or ambiguous bindings fail closed and do not fall through to an older slug change or current pointer. Changes with valid bindings to another branch are excluded from legacy slug matching because their persisted binding is authoritative.

For active changes without a source binding, the legacy branch mapping remains available. For a branch such as `feat/add-oauth`, the resolver checks these variants against unbound active change IDs:

- `feat/add-oauth`
- `add-oauth`
- `feat-add-oauth`

If exactly one variant matches, the source is `branch`. If multiple variants match, resolution fails with `ambiguous-branch-change`.

## Configuration

The resolver reads simple scalar path keys from `.ai-factory/config.yaml`:

```yaml
paths:
  plans: openspec/changes
  specs: openspec/specs
  state: .ai-factory/state
  qa: .ai-factory/qa
```

`paths.plans` maps to the OpenSpec changes directory only when it points at `openspec/changes`. Legacy `.ai-factory/plans` values are ignored for active OpenSpec change resolution.

## Troubleshooting

When resolution returns `ambiguous-active-change`, pass an explicit `<change-id>` to the command:

```text
/aif-improve <change-id>
/aif-implement <change-id>
/aif-verify <change-id>
```

When resolution returns `current-pointer-not-found`, update or remove `.ai-factory/state/current.yaml`. A stale pointer blocks fallback so broken runtime state is visible.

When a legacy plan exists but no OpenSpec change exists, run explicit migration instead of expecting automatic fallback:

```bash
ai-factory aifhub-migrate-legacy-plans <change-id> --dry-run
ai-factory aifhub-migrate-legacy-plans <change-id>
```

## See Also

- [Usage](usage.md)
- [Legacy Plan Migration](legacy-plan-migration.md)
- [ADR 0001: OpenSpec-native artifact protocol](adr/0001-openspec-native-artifact-protocol.md)
- [OpenSpec Compatibility](openspec-compatibility.md)
