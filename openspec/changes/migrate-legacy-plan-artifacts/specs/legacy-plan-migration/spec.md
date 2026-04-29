# Delta for Legacy Plan Migration

## ADDED Requirements

### Requirement: Migration API Surface

The system MUST expose the legacy migration behavior through the required public functions in `scripts/legacy-plan-migration.mjs`.

#### Scenario: Required functions are exported

- GIVEN `scripts/legacy-plan-migration.mjs`
- WHEN the module is imported
- THEN it exports `discoverLegacyPlans`
- AND it exports `migrateLegacyPlan`
- AND it exports `migrateAllLegacyPlans`
- AND it exports `mapLegacyPlanToOpenSpecArtifacts`
- AND it exports `writeMigrationReport`
- AND it exports `detectMigrationNeed`
- AND it exports `normalizeLegacyPlanId`

#### Scenario: Importing the module has no migration side effects

- GIVEN the migration module is imported in a test process
- WHEN no exported function is called
- THEN no directories are created
- AND no files are written

### Requirement: Legacy Plan Discovery

The system MUST discover migratable legacy AI Factory plans from `.ai-factory/plans/` in both parent markdown and companion directory forms.

#### Scenario: Both legacy forms exist

- GIVEN `.ai-factory/plans/add-oauth.md`
- AND `.ai-factory/plans/add-oauth/task.md`
- WHEN legacy plans are discovered
- THEN the result includes one plan with ID `add-oauth`
- AND the result includes both the parent plan file and known companion files
- AND the result includes `targetChangePath: openspec/changes/add-oauth`

#### Scenario: Only one legacy form exists

- GIVEN `.ai-factory/plans/add-oauth.md` exists without `.ai-factory/plans/add-oauth/`
- WHEN legacy plans are discovered
- THEN the result includes plan ID `add-oauth`
- AND `planFile` references `.ai-factory/plans/add-oauth.md`
- AND `planDir` is `null`

#### Scenario: Discovery paths are stable and relative

- GIVEN legacy plans are discovered from a repository root
- WHEN the discovery result is returned
- THEN source and target paths use repository-relative POSIX paths
- AND results do not expose absolute paths except in safety diagnostics

#### Scenario: Non-plan entries are ignored

- GIVEN hidden entries, archive folders, backup folders, and unrelated non-markdown files under `.ai-factory/plans/`
- WHEN legacy plans are discovered
- THEN those entries are excluded from the returned plan list
- AND valid plan results remain sorted by plan ID

### Requirement: Canonical OpenSpec Mapping

The system MUST map legacy planning intent into canonical OpenSpec change artifacts without placing runtime-only files in `openspec/changes/<change-id>/`.

#### Scenario: Legacy plan summary is migrated

- GIVEN `.ai-factory/plans/add-oauth.md` contains legacy plan text
- WHEN plan `add-oauth` is migrated
- THEN `openspec/changes/add-oauth/proposal.md` is written
- AND the proposal references `.ai-factory/plans/add-oauth.md` as a legacy source
- AND the original legacy text remains represented either through structured sections or a clearly labeled legacy notes section

#### Scenario: Legacy tasks are migrated

- GIVEN `.ai-factory/plans/add-oauth/task.md` contains checklist tasks
- WHEN plan `add-oauth` is migrated
- THEN `openspec/changes/add-oauth/tasks.md` contains checkbox tasks preserving the intended work

#### Scenario: Runtime-only legacy files stay outside canonical artifacts

- GIVEN a legacy plan folder contains `verify.md` and `status.yaml`
- WHEN plan `add-oauth` is migrated
- THEN no `verify.md` is written under `openspec/changes/add-oauth/`
- AND no `status.yaml` is written under `openspec/changes/add-oauth/`
- AND `verify.md` is preserved as `.ai-factory/qa/add-oauth/legacy-verify.md`
- AND `status.yaml` is preserved as `.ai-factory/state/add-oauth/legacy-status.yaml`

### Requirement: Runtime Preservation

The system MUST preserve legacy context, rules, status, exploration, and verification evidence in runtime or QA locations.

#### Scenario: Context and rules are preserved

- GIVEN `.ai-factory/plans/add-oauth/context.md` and `.ai-factory/plans/add-oauth/rules.md`
- WHEN plan `add-oauth` is migrated
- THEN full context is preserved as `.ai-factory/state/add-oauth/legacy-context.md`
- AND rules are preserved as `.ai-factory/state/add-oauth/legacy-rules.md`
- AND design-relevant context may also be summarized in `openspec/changes/add-oauth/design.md`

#### Scenario: Exploration notes are preserved

- GIVEN `.ai-factory/plans/add-oauth/explore.md`
- WHEN plan `add-oauth` is migrated
- THEN the notes are preserved as `.ai-factory/state/add-oauth/legacy-explore.md`
- AND the notes are not copied into canonical OpenSpec change artifacts as runtime research logs

### Requirement: Migration Path Safety

The system MUST reject any planned write that escapes its allowed canonical, runtime state, or QA boundary.

#### Scenario: Canonical writes stay inside the change folder

- GIVEN a mapped canonical artifact target outside `openspec/changes/add-oauth/`
- WHEN migration operations are planned
- THEN migration fails before writing files
- AND no legacy artifacts are deleted or modified

#### Scenario: Runtime writes stay outside canonical and legacy folders

- GIVEN a mapped runtime artifact target under `openspec/changes/add-oauth/` or `.ai-factory/plans/add-oauth/`
- WHEN migration operations are planned
- THEN migration fails before writing files
- AND no runtime-only legacy file is written into a canonical OpenSpec folder

#### Scenario: Base specs are never mutated

- GIVEN a migrated plan generates canonical change artifacts
- WHEN migration runs
- THEN no operation targets `openspec/specs/**`

### Requirement: Dry-Run Migration

The system MUST support dry-run migration that performs no filesystem writes while returning a complete operation plan.

#### Scenario: Single-plan dry-run

- GIVEN a legacy plan `add-oauth`
- WHEN `migrateLegacyPlan('add-oauth', { dryRun: true })` runs
- THEN no directories are created
- AND no files are written
- AND the result includes write operations for the canonical, runtime, QA, and report targets that would be produced
- AND runtime layout helpers are not called in a way that creates directories

#### Scenario: All-plan dry-run

- GIVEN multiple legacy plans
- WHEN all legacy plans are migrated with `dryRun: true`
- THEN no directories are created
- AND the result includes one dry-run migration plan per discovered legacy plan

### Requirement: Collision Handling

The system MUST never silently overwrite existing OpenSpec change artifacts.

#### Scenario: Default collision fails

- GIVEN `openspec/changes/add-oauth` already exists
- WHEN plan `add-oauth` is migrated without explicit collision options
- THEN migration fails with a `target-exists` error
- AND the result identifies the legacy source and existing target

#### Scenario: Suffix collision creates distinct target

- GIVEN `openspec/changes/add-oauth` already exists
- WHEN plan `add-oauth` is migrated with `onCollision: 'suffix'`
- THEN migration writes to a distinct safe change ID such as `add-oauth-migrated`
- AND no existing canonical artifact is overwritten

#### Scenario: Merge-safe collision preserves existing files

- GIVEN `openspec/changes/add-oauth/proposal.md` already exists
- WHEN plan `add-oauth` is migrated with `onCollision: 'merge-safe'`
- THEN the existing proposal is not overwritten
- AND missing target files are created
- AND skipped existing files are reported

### Requirement: All-Plan Migration

The system MUST migrate all discovered legacy plans in stable order when explicitly requested.

#### Scenario: All plans migrate successfully

- GIVEN multiple legacy plans
- WHEN `migrateAllLegacyPlans()` runs
- THEN each discovered plan is migrated once in sorted ID order
- AND the top-level result reports all migrated plan IDs

#### Scenario: All-plan migration reports partial failure

- GIVEN multiple legacy plans
- AND one plan collides with an existing OpenSpec change using default collision behavior
- WHEN `migrateAllLegacyPlans()` runs
- THEN non-colliding plans still return their own migration results
- AND the top-level result reports partial failure with per-plan errors

### Requirement: Migration Report

The system MUST write a migration report for every non-dry-run migration.

#### Scenario: Report records artifacts and validation

- GIVEN plan `add-oauth` is migrated without `dryRun`
- WHEN migration completes
- THEN `.ai-factory/state/add-oauth/migration-report.md` is written
- AND the report lists source artifacts
- AND the report lists generated OpenSpec artifacts
- AND the report lists runtime and QA artifacts
- AND the report records OpenSpec validation as `PASS`, `FAIL`, or `SKIPPED`
- AND the report includes manual follow-ups

### Requirement: OpenSpec Validation Integration

The system MUST validate migrated OpenSpec changes when a compatible OpenSpec CLI is available and degrade gracefully when it is not.

#### Scenario: Compatible CLI validates change

- GIVEN OpenSpec detection reports validation support
- WHEN plan `add-oauth` is migrated
- THEN `validateOpenSpecChange('add-oauth')` is called after artifact writes
- AND the validation result is recorded in the migration result and report

#### Scenario: Missing CLI skips validation

- GIVEN OpenSpec CLI detection reports missing or unsupported CLI
- WHEN plan `add-oauth` is migrated
- THEN migration does not fail only because the CLI is missing
- AND validation is recorded as `SKIPPED`

#### Scenario: Validation failure is recorded

- GIVEN OpenSpec validation fails after artifacts are written
- WHEN plan `add-oauth` is migrated
- THEN the migration result records the validation failure
- AND the migration report records `FAIL`
- AND the migration does not delete generated or legacy artifacts as rollback

### Requirement: Migration Command

The system MUST provide an explicit command for listing and migrating legacy plans.

#### Scenario: CLI lists legacy plans

- GIVEN legacy plan artifacts exist
- WHEN `node scripts/migrate-legacy-plans.mjs --list` runs
- THEN the command prints discovered legacy plans and target paths
- AND exits with code `0`

#### Scenario: CLI migrates with collision option

- GIVEN legacy plan `add-oauth`
- WHEN `node scripts/migrate-legacy-plans.mjs add-oauth --on-collision suffix` runs
- THEN migration uses suffix collision behavior
- AND the command reports the created target change ID

#### Scenario: CLI rejects invalid arguments

- GIVEN an unsupported collision mode
- WHEN `node scripts/migrate-legacy-plans.mjs add-oauth --on-collision unsafe` runs
- THEN the command prints a concise argument error
- AND exits with code `2`

#### Scenario: CLI emits JSON metadata

- GIVEN legacy plan `add-oauth`
- WHEN `node scripts/migrate-legacy-plans.mjs add-oauth --dry-run --json` runs
- THEN stdout is parseable JSON
- AND the JSON includes operation paths, diagnostics, dry-run status, and target change ID
- AND the JSON does not include full generated artifact content by default

### Requirement: Migration Suggestions

The system MUST suggest migration when OpenSpec-native improve, implement, or verify cannot resolve a change but matching legacy plan artifacts exist.

#### Scenario: Improve detects matching legacy plan

- GIVEN no `openspec/changes/add-oauth` exists
- AND `.ai-factory/plans/add-oauth.md` exists
- WHEN `/aif-improve add-oauth` cannot resolve an OpenSpec change
- THEN guidance suggests running `node scripts/migrate-legacy-plans.mjs add-oauth --dry-run`
- AND guidance suggests running `node scripts/migrate-legacy-plans.mjs add-oauth`
- AND no automatic migration occurs

#### Scenario: Detection API returns exact suggestion commands

- GIVEN no `openspec/changes/add-oauth` exists
- AND legacy artifacts for `add-oauth` exist
- WHEN `detectMigrationNeed({ changeId: 'add-oauth' })` runs
- THEN the result identifies the legacy source artifacts
- AND includes dry-run and migration commands
- AND marks migration as suggested but not executed

#### Scenario: Implement and verify use same suggestion

- GIVEN matching legacy artifacts exist for an unresolved OpenSpec change ID
- WHEN `/aif-implement add-oauth` or `/aif-verify add-oauth` cannot resolve an OpenSpec change
- THEN each command presents the same explicit migration suggestion
- AND neither command mutates legacy or OpenSpec artifacts as part of suggestion

### Requirement: Documentation and Fixture Coverage

The system MUST document migration behavior and include fixture-backed tests proving intended meaning is preserved.

#### Scenario: User documentation describes migration

- GIVEN user-facing docs are generated
- WHEN a user reads the migration guide
- THEN it explains when migration is needed
- AND it explains dry-run, single-plan migration, all-plan migration, collision behavior, canonical mapping, runtime and QA preservation, validation, and post-migration review with `/aif-improve <id>`

#### Scenario: Fixture migration preserves meaning

- GIVEN the `legacy-plan-basic` fixture contains summary, tasks, design context, rules, verify evidence, status, and exploration notes
- WHEN the fixture is migrated in a temp directory
- THEN generated `proposal.md`, `tasks.md`, `design.md`, runtime notes, QA evidence, and the report preserve the intended meaning of the source artifacts
- AND original legacy fixture artifacts remain present
