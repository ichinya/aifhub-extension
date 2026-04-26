[Back to Documentation](README.md)

# Active Change Resolver

`scripts/active-change-resolver.mjs` provides the shared dependency-free resolver for OpenSpec-native runtime flows. It selects one active change, returns machine-readable diagnostics, and computes AI Factory runtime paths without writing to canonical OpenSpec artifacts.

## Precedence

Resolution uses this order:

1. Explicit `changeId`.
2. Current working directory under `openspec/changes/<change-id>/`.
3. Current git branch mapped to an existing active change.
4. `.ai-factory/state/current.yaml`.
5. A single active change under `openspec/changes/`.
6. A structured failure with candidates when no unique change can be selected.

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

Branch mapping only selects existing active changes. For a branch such as `feat/add-oauth`, the resolver checks these variants against active change IDs:

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

## See Also

- [ADR 0001: OpenSpec-native artifact protocol](adr/0001-openspec-native-artifact-protocol.md)
- [OpenSpec Compatibility](openspec-compatibility.md)
