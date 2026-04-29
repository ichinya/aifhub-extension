# Tasks

## 1. Discovery and fixture setup

- [x] 1.1 Add an exported-API test in `scripts/legacy-plan-migration.test.mjs` for every required public function.
- [x] 1.2 Create `test/fixtures/legacy-plan-basic/.ai-factory/plans/add-oauth.md` with a clear legacy summary, scope, approach, and behavioral requirement.
- [x] 1.3 Create `test/fixtures/legacy-plan-basic/.ai-factory/plans/add-oauth/task.md` with checklist-shaped legacy tasks.
- [x] 1.4 Create `test/fixtures/legacy-plan-basic/.ai-factory/plans/add-oauth/context.md` with design-like architecture and implementation notes.
- [x] 1.5 Create `test/fixtures/legacy-plan-basic/.ai-factory/plans/add-oauth/rules.md`, `verify.md`, `status.yaml`, and `explore.md` so runtime and QA preservation can be tested.
- [x] 1.6 Add a fixture-copy helper in `scripts/legacy-plan-migration.test.mjs` that copies fixture files into a temp root without adding dependencies.
- [x] 1.7 Add initial discovery tests in `scripts/legacy-plan-migration.test.mjs` for `<id>.md`, `<id>/`, both forms together, partial folders, hidden entries, archive or backup folders, stable sorting, and target path diagnostics.
- [x] 1.8 Assert discovery returns `null` for absent `planFile` or `planDir`, omits absent known files, and reports repository-relative POSIX paths.

## 2. Core migration module

- [x] 2.1 Create `scripts/legacy-plan-migration.mjs` exporting all required API functions and no side-effectful top-level execution.
- [x] 2.2 Implement `normalizeLegacyPlanId(input)` using the same safety constraints as OpenSpec change IDs, rejecting path traversal, absolute paths, slashes, backslashes, empty values, hidden IDs, and `archive`.
- [x] 2.3 Implement `discoverLegacyPlans(options = {})` with `rootDir`, `plansDir`, and `changesDir` options, returning stable relative POSIX paths, warnings, and errors.
- [x] 2.4 Implement source loading for known legacy files only. Unknown files inside detected plan folders may be reported but must not become canonical artifacts.
- [x] 2.5 Keep library functions quiet by default. They should return structured warnings and errors instead of logging; CLI logging belongs only in `scripts/migrate-legacy-plans.mjs`.
- [x] 2.6 Implement path guard helpers for canonical change writes, state writes, QA writes, root containment, legacy-plan exclusion, and `openspec/specs` exclusion.
- [x] 2.7 Add tests that unsafe mapped targets are rejected before any write happens.

## 3. Mapping behavior

- [x] 3.1 Implement `mapLegacyPlanToOpenSpecArtifacts(legacyPlan, options = {})` as a pure function that returns canonical artifacts, runtime artifacts, QA artifacts, source references, warnings, and manual follow-ups.
- [x] 3.2 Map `.ai-factory/plans/<id>.md` to `openspec/changes/<change-id>/proposal.md` with `Intent`, `Scope`, `Approach`, `Legacy source`, and `Legacy plan notes` fallback sections.
- [x] 3.3 Map `task.md` to `openspec/changes/<change-id>/tasks.md`, preserving safe checkboxes and wrapping non-checklist prose under `## Migrated legacy tasks`.
- [x] 3.4 Map design-like `context.md` into `design.md` and always preserve full raw context as `.ai-factory/state/<change-id>/legacy-context.md`.
- [x] 3.5 Preserve `rules.md` as `.ai-factory/state/<change-id>/legacy-rules.md`; only add review-labeled candidate requirement notes when the content clearly contains product behavior.
- [x] 3.6 Preserve `verify.md` only as `.ai-factory/qa/<change-id>/legacy-verify.md`.
- [x] 3.7 Preserve `status.yaml` only as `.ai-factory/state/<change-id>/legacy-status.yaml`.
- [x] 3.8 Preserve `explore.md` only as `.ai-factory/state/<change-id>/legacy-explore.md`.
- [x] 3.9 Generate `openspec/changes/<change-id>/specs/migrated/spec.md` only when clear behavioral requirements can be extracted. Otherwise omit the delta spec and record the manual spec-authoring follow-up.

## 4. Write, dry-run, and collision handling

- [x] 4.1 Implement an operation planner that produces a full `operations` list for both dry-run and write mode.
- [x] 4.2 Implement `migrateLegacyPlan(planId, options = {})` with default `onCollision: 'fail'`.
- [x] 4.3 Ensure `dryRun: true` creates no directories, writes no files, and does not call `ensureRuntimeLayout`, while returning all planned writes and warnings.
- [x] 4.4 Implement `onCollision: 'fail'` so an existing `openspec/changes/<change-id>` returns `target-exists` with source and target paths.
- [x] 4.5 Implement `onCollision: 'suffix'` using a deterministic safe target such as `<id>-migrated`, with numbered fallback if needed.
- [x] 4.6 Implement `onCollision: 'merge-safe'` so only missing canonical and runtime files are written and existing files are reported as skipped.
- [x] 4.7 Implement `onCollision: 'overwrite'` only when explicitly passed, still preserving legacy sources and writing a migration report.
- [x] 4.8 Assert in tests that no migration path deletes legacy artifacts and no operation mutates `openspec/specs`.
- [x] 4.9 Implement `migrateAllLegacyPlans(options = {})` with per-plan results, stable ordering, and a top-level `ok`, `partial`, `migrated`, `failed`, `warnings`, and `errors` summary.
- [x] 4.10 Add tests for `migrateAllLegacyPlans` full success, partial failure, and dry-run behavior.

## 5. Reports and OpenSpec validation

- [x] 5.1 Implement `writeMigrationReport(planId, report, options = {})` writing `.ai-factory/state/<change-id>/migration-report.md`.
- [x] 5.2 Include summary, source artifacts, generated OpenSpec artifacts, runtime artifacts, validation status, warnings, errors, and manual follow-ups in the report.
- [x] 5.3 Integrate `detectOpenSpec` and `validateOpenSpecChange` with dependency injection so tests do not require a real OpenSpec CLI.
- [x] 5.4 Record missing or unsupported CLI as validation `SKIPPED` and keep migration result `ok: true` unless other errors exist.
- [x] 5.5 Record validation failure in the result and report. Default to `ok: false` after files are written, without rollback or deletion.
- [x] 5.6 Add tests for missing CLI, validation called when available, validation pass, validation fail, and report content.

## 6. CLI wrapper and package script

- [x] 6.1 Create `scripts/migrate-legacy-plans.mjs` with dependency-free argument parsing.
- [x] 6.2 Support `node scripts/migrate-legacy-plans.mjs --list`.
- [x] 6.3 Support `node scripts/migrate-legacy-plans.mjs add-oauth --dry-run` and `node scripts/migrate-legacy-plans.mjs add-oauth`.
- [x] 6.4 Support `node scripts/migrate-legacy-plans.mjs --all --dry-run` and `node scripts/migrate-legacy-plans.mjs --all`.
- [x] 6.5 Support `--on-collision fail|merge-safe|suffix|overwrite` and reject unknown values.
- [x] 6.6 Support `--json` for machine-readable output.
- [x] 6.7 Add `migrate:legacy-plans` to `package.json` only if the wrapper is added and the repo convention remains package-script based.
- [x] 6.8 Keep CLI output concise, human-readable, and explicit about dry-run, created targets, skipped targets, report path, and validation status.
- [x] 6.9 Define and test exit codes: `0` for success or list success, `1` for migration or validation failure, and `2` for invalid CLI arguments.
- [x] 6.10 Keep `--json` output focused on result metadata, operation paths, diagnostics, validation summaries, and report paths; do not dump full artifact contents by default.

## 7. Improve, implement, and verify migration suggestions

- [x] 7.1 Implement `detectMigrationNeed(options = {})` so prompt/runtime consumers can detect a missing OpenSpec change with a matching legacy plan and return a suggestion object with exact commands.
- [x] 7.2 Update `injections/core/aif-improve-plan-folder.md` to suggest the migration script when an explicit or resolved `<id>` has legacy artifacts but no `openspec/changes/<id>`.
- [x] 7.3 Update `injections/core/aif-implement-plan-folder.md` with the same suggestion and a clear "do not auto-migrate" instruction.
- [x] 7.4 Update `injections/core/aif-verify-plan-folder.md` with the same suggestion before verification scope fails.
- [x] 7.5 Add prompt-asset tests that require the dry-run and migration commands to appear in improve, implement, and verify guidance.
- [x] 7.6 Add module tests for `detectMigrationNeed` covering match found, no legacy match, existing OpenSpec change, unsafe ID, and command rendering.

## 8. Documentation

- [x] 8.1 Add `docs/legacy-plan-migration.md` explaining when migration is needed, dry-run, single-plan migration, all-plan migration, collision behavior, canonical mapping, runtime/QA preservation, validation, and review follow-ups.
- [x] 8.2 Update `docs/usage.md` with a short migration section and link to the dedicated migration guide.
- [x] 8.3 Update `docs/context-loading-policy.md` to describe legacy migration boundaries between canonical OpenSpec artifacts, runtime state, and QA evidence.
- [x] 8.4 Update `docs/README.md` or the appropriate docs index so the new migration guide is discoverable.
- [x] 8.5 Mention that legacy artifacts are not deleted and `/aif-improve <id>` should run after migration to refine generated artifacts.

## 9. Verification

- [x] 9.1 Run `npm run validate` and fix any manifest, agent, or doc-link failures.
- [x] 9.2 Run `npm test` and fix failures.
- [x] 9.3 Run at least one CLI dry-run against a temp copy of the fixture and confirm it writes nothing.
- [x] 9.4 Run at least one non-dry-run migration in a temp directory and confirm intended meaning is preserved in `proposal.md`, `tasks.md`, `design.md`, runtime notes, QA notes, and the migration report.
- [x] 9.5 Confirm final implementation does not create, delete, or mutate legacy source artifacts except for optional reads.
- [x] 9.6 Confirm final `git diff --stat` shows only the intended migration module, CLI wrapper, fixtures, prompt assets, docs, package metadata, and tests.

## Suggested Commit Plan

Not executed as part of implementation because issue scope excludes git commit creation.

- Commit 1: `feat: add legacy plan migration module`
- Commit 2: `feat: add legacy migration cli and fixture coverage`
- Commit 3: `docs: document legacy plan migration`
- Commit 4: `test: cover migration prompts and validation behavior`

