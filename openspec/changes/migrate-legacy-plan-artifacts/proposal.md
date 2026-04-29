# Proposal: Migrate Legacy Plan Artifacts to OpenSpec

## Intent

Existing users may still have legacy AI Factory plan artifacts in the dual `.ai-factory/plans` model:

- `.ai-factory/plans/<id>.md`
- `.ai-factory/plans/<id>/task.md`
- `.ai-factory/plans/<id>/context.md`
- `.ai-factory/plans/<id>/rules.md`
- `.ai-factory/plans/<id>/verify.md`
- `.ai-factory/plans/<id>/status.yaml`
- `.ai-factory/plans/<id>/explore.md`

The current workflow is OpenSpec-native, with canonical change artifacts under `openspec/changes/<change-id>/` and runtime or QA evidence under `.ai-factory/state/<change-id>/` and `.ai-factory/qa/<change-id>/`. Users need an explicit, safe, reversible migration path that preserves legacy files, avoids silent overwrites, and makes runtime-only artifacts non-canonical.

## Scope

In scope:

- Add `scripts/legacy-plan-migration.mjs` with the required exported API:
  - `discoverLegacyPlans(options = {})`
  - `migrateLegacyPlan(planId, options = {})`
  - `migrateAllLegacyPlans(options = {})`
  - `mapLegacyPlanToOpenSpecArtifacts(legacyPlan, options = {})`
  - `writeMigrationReport(planId, report, options = {})`
  - `detectMigrationNeed(options = {})`
  - `normalizeLegacyPlanId(input)`
- Add an explicit dependency-free CLI wrapper, `scripts/migrate-legacy-plans.mjs`.
- Support `--list`, single-plan migration, `--all`, `--dry-run`, `--on-collision`, and optional `--json`.
- Return stable machine-readable results and CLI exit codes for success, partial success, validation failure, invalid arguments, and migration errors.
- Convert legacy plan summary and task artifacts into canonical OpenSpec change artifacts.
- Preserve runtime-only legacy artifacts under `.ai-factory/state/<change-id>/` and `.ai-factory/qa/<change-id>/`.
- Write a migration report for each non-dry-run migration.
- Run OpenSpec validation after migration when a compatible CLI is available.
- Detect matching legacy plans in improve, implement, and verify guidance, then suggest the migration command without auto-migrating.
- Add tests with temp directories, injected OpenSpec runner behavior, and at least one legacy fixture.
- Update user-facing docs for the migration flow.

Out of scope:

- Automatic migration during install, validation, improve, implement, or verify.
- Deleting, archiving, or moving legacy files.
- Mutating `openspec/specs` directly.
- Installing OpenSpec skills or slash commands.
- Rewriting repository OpenSpec bootstrap configuration outside the migration feature.
- CI matrix expansion, full v1 docs rewrite, custom OpenSpec schemas, registry work, or PR/commit creation.

## Approach

Implement the migration as an explicit filesystem operation planner. The core module should discover legacy plans, read source artifacts, map them into canonical and runtime targets, resolve collisions, and return the same operation plan for both dry-run and write modes. Dry-run should execute no writes or directory creation.

Use existing helpers where they fit:

- `normalizeChangeId` from `scripts/active-change-resolver.mjs` for target change IDs.
- `ensureRuntimeLayout` from `scripts/active-change-resolver.mjs` when writes are enabled.
- `detectOpenSpec` and `validateOpenSpecChange` from `scripts/openspec-runner.mjs` for degraded validation behavior.

Add migration-local path guards before every planned or executed write. Canonical targets must stay under `openspec/changes/<change-id>/`, runtime targets must stay under `.ai-factory/state/<change-id>/` or `.ai-factory/qa/<change-id>/`, and no operation may target `openspec/specs/**` or `.ai-factory/plans/**`.

Keep the mapping conservative. Generate `proposal.md`, `design.md`, `tasks.md`, and a delta spec only when legacy text provides enough intent. Preserve raw legacy content under labeled sections or runtime notes when confident structured extraction is not possible. Never copy `verify.md` or `status.yaml` into `openspec/changes/<change-id>/`.

The CLI should be a thin wrapper around the exported API. Human-readable output should summarize sources, targets, collision behavior, dry-run operations, report path, and validation status. `--json` should print the result object for automation and tests.

## Risks / Open Questions

- Requirement extraction from old markdown can create false confidence. Default behavior should prefer preserving notes and marking review-required output over inventing fake requirements.
- A migration can write valid files while strict OpenSpec validation still fails because a legacy plan lacks delta spec content or the repository has no full OpenSpec project scaffold. The report must record `FAIL` or `SKIPPED` clearly.
- `merge-safe` needs precise file-level behavior: create missing canonical/runtime files, never overwrite existing files, and report skipped targets.
- The repository currently has older local `.ai-factory` descriptions alongside OpenSpec-native prompt and script support. This change should update only the docs and prompt guidance needed for migration, not perform a full context rewrite.
