# Design: Migrate Legacy Plan Artifacts to OpenSpec

## Technical Approach

Add `scripts/legacy-plan-migration.mjs` as a library-first migration module. It should expose pure mapping behavior separately from filesystem writes so tests can cover discovery, mapping, collision handling, dry-run behavior, and OpenSpec validation without depending on a real OpenSpec CLI.

The module should use these layers:

- Path and ID safety: normalize legacy plan IDs, normalize OpenSpec change IDs, and keep all paths inside the configured root.
- Discovery: scan `.ai-factory/plans/` for `<id>.md`, `<id>/`, or both, excluding hidden, archived, backup, and unrelated entries.
- Source loading: read only known legacy files and retain relative source paths for reports.
- Mapping: convert source content into canonical OpenSpec artifacts and runtime preservation files.
- Operation planning: produce ordered `write`, `mkdir`, `skip`, and `validate` operations without side effects.
- Path guarding: verify each planned target is inside the repository and inside the expected canonical, state, or QA boundary before writing.
- Execution: apply the operation plan only when `dryRun` is false.
- Reporting and validation: write the migration report and run OpenSpec validation when available.

The CLI wrapper, `scripts/migrate-legacy-plans.mjs`, should parse arguments without adding dependencies and delegate all behavior to the module.

## Data / Artifact Model

Use stable plain objects so tests and CLI JSON output can assert behavior directly.

Suggested `LegacyPlan` shape:

```js
{
  id: 'add-oauth',
  planFile: '.ai-factory/plans/add-oauth.md',
  planDir: '.ai-factory/plans/add-oauth',
  files: {
    task: '.ai-factory/plans/add-oauth/task.md',
    context: '.ai-factory/plans/add-oauth/context.md',
    rules: '.ai-factory/plans/add-oauth/rules.md',
    verify: '.ai-factory/plans/add-oauth/verify.md',
    status: '.ai-factory/plans/add-oauth/status.yaml',
    explore: '.ai-factory/plans/add-oauth/explore.md'
  },
  contents: {
    plan: '# Legacy plan...',
    task: '- [ ] Do work',
    context: '...',
    rules: '...',
    verify: '...',
    status: '...',
    explore: '...'
  },
  hasCanonicalTarget: false,
  targetChangePath: 'openspec/changes/add-oauth'
}
```

When one legacy form is absent, use `null` for `planFile` or `planDir` and omit only the missing file entries from `files`. Paths returned from public functions should be repository-relative POSIX paths; absolute paths may be used internally but should not leak into reports unless an error needs the resolved path for safety diagnostics.

Suggested migration result shape:

```js
{
  ok: true,
  dryRun: false,
  planId: 'add-oauth',
  changeId: 'add-oauth',
  targetChangePath: 'openspec/changes/add-oauth',
  operations: [
    { action: 'write', target: 'openspec/changes/add-oauth/proposal.md', source: '.ai-factory/plans/add-oauth.md' }
  ],
  validation: {
    status: 'PASS',
    available: true,
    result: {}
  },
  reportPath: '.ai-factory/state/add-oauth/migration-report.md',
  warnings: [],
  errors: []
}
```

Canonical writes may target only:

- `openspec/changes/<change-id>/proposal.md`
- `openspec/changes/<change-id>/design.md`
- `openspec/changes/<change-id>/tasks.md`
- `openspec/changes/<change-id>/specs/**/spec.md`

Runtime preservation writes may target only:

- `.ai-factory/state/<change-id>/legacy-context.md`
- `.ai-factory/state/<change-id>/legacy-rules.md`
- `.ai-factory/state/<change-id>/legacy-status.yaml`
- `.ai-factory/state/<change-id>/legacy-explore.md`
- `.ai-factory/state/<change-id>/migration-report.md`
- `.ai-factory/qa/<change-id>/legacy-verify.md`

The migration must never write legacy `verify.md` or `status.yaml` into `openspec/changes/<change-id>/`.

The implementation should include local guards equivalent to:

- `assertWithinRoot(rootDir, targetPath)`
- `assertCanonicalChangePath(rootDir, changeId, targetPath)`
- `assertRuntimeStatePath(rootDir, changeId, targetPath)`
- `assertRuntimeQaPath(rootDir, changeId, targetPath)`
- `assertNotLegacyPlanPath(rootDir, targetPath)`
- `assertNotBaseSpecPath(rootDir, targetPath)`

These guards should run for planned writes and executed writes so a bug in mapping cannot escape the intended boundaries.

## Integration Points

`scripts/active-change-resolver.mjs`:

- Reuse `normalizeChangeId(changeId)` for target safety.
- Reuse `ensureRuntimeLayout(changeId, options)` only in write mode.

`scripts/openspec-runner.mjs`:

- Reuse `detectOpenSpec(options)` before validation.
- Reuse `validateOpenSpecChange(changeId, options)` when detection reports `canValidate: true`.
- Treat missing or unsupported CLI as `SKIPPED`, not a migration failure.

`package.json`:

- Add `migrate:legacy-plans` only after `scripts/migrate-legacy-plans.mjs` exists.
- Preserve the existing `test` and `validate` scripts.
- Document `npm run migrate:legacy-plans -- <args>` as an optional convenience, not the only supported invocation.

Prompt assets:

- Update `injections/core/aif-improve-plan-folder.md`.
- Update `injections/core/aif-implement-plan-folder.md`.
- Update `injections/core/aif-verify-plan-folder.md`.
- Add focused prompt-asset tests that require the migration suggestion message.

Docs:

- Add `docs/legacy-plan-migration.md`.
- Link it from `docs/usage.md`, `docs/context-loading-policy.md`, and the docs index when appropriate.

Tests and fixtures:

- Add `scripts/legacy-plan-migration.test.mjs`.
- Add fixture files under `test/fixtures/legacy-plan-basic/` unless an existing convention emerges during implementation.
- Keep tests in `node:test` style and use temp directories plus injected runner functions.
- Add a small fixture-copy helper in the test file rather than importing extra dependencies.
- Add an exported-API test before behavior tests so missing named exports fail clearly.

## Alternatives Considered

- Auto-migrate in improve, implement, or verify: rejected because the issue requires explicit migration and forbids silent changes.
- Move legacy files instead of copying: rejected because preserving originals is safer and satisfies the no-delete requirement.
- Always generate delta specs from legacy prose: rejected because weak extraction can create fake product requirements. The mapper should generate specs only for clear behavior or mark generated requirements for review.
- Put all legacy notes into `design.md`: rejected because `rules.md`, `status.yaml`, `verify.md`, and exploration logs are runtime or QA evidence, not canonical OpenSpec change artifacts.

## Risks

- Collision behavior can accidentally overwrite existing OpenSpec work if handled at directory granularity only. Implement file-level checks and tests for every collision mode.
- `suffix` collision behavior can produce an unsafe or ambiguous change ID. Normalize every generated suffix and keep suffix generation deterministic.
- Documentation can drift if the CLI examples and package script disagree. If a package script is added, docs should mention both the direct `node` command and `npm run migrate:legacy-plans -- ...`.
- Validation failures after write must not trigger rollback that deletes migrated artifacts. Record the failure in the result and report instead.
- `migrateAllLegacyPlans` can produce mixed outcomes. Return a top-level result that distinguishes full success, partial success, and total failure without hiding per-plan errors.
- `--json` output can become noisy if it includes full migrated artifact content. Prefer operation and artifact paths, diagnostics, validation summaries, and report paths.
