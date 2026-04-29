# Delta for v1 Documentation

## ADDED Requirements

### Requirement: OpenSpec-native workflow is the primary public documentation story

The documentation MUST present AI Factory UX with the OpenSpec artifact protocol as the primary v1 workflow.

#### Scenario: README quick start uses OpenSpec-native flow

- GIVEN a user opens `README.md`
- WHEN they read the quick start
- THEN the documented flow starts with `/aif-analyze`
- AND includes `/aif-plan full "<request>"`
- AND uses explicit `<change-id>` arguments for improve, implement, verify, fix, and done where applicable
- AND does not present `.ai-factory/plans` as the normal OpenSpec-native workflow.

#### Scenario: Legacy mode is compatibility-only

- GIVEN a user reads any public workflow documentation
- WHEN legacy `.ai-factory/plans` artifacts are mentioned
- THEN the section labels them as legacy AI Factory-only mode or migration input
- AND points users to the migration guide for converting existing legacy plans.

### Requirement: Documentation distinguishes canonical, runtime, QA, generated, and legacy artifacts

The documentation MUST clearly distinguish canonical OpenSpec artifacts from AI Factory runtime state, QA evidence, generated rules, and legacy compatibility artifacts.

#### Scenario: Canonical artifact layout is documented consistently

- GIVEN a user reads the README or usage documentation
- WHEN they inspect the artifact layout
- THEN `openspec/specs` is described as canonical current behavior
- AND `openspec/changes` is described as canonical proposed changes
- AND `.ai-factory/state` is described as runtime execution traces
- AND `.ai-factory/qa` is described as verification and finalization evidence
- AND `.ai-factory/rules/generated` is described as derived and safe to regenerate
- AND `.ai-factory/plans` is described as legacy compatibility only.

### Requirement: Usage guide documents command read and write boundaries

The usage guide MUST document what each v1 workflow command reads, writes, and does not write.

#### Scenario: Plan command boundaries are explicit

- GIVEN a user reads the `/aif-plan full` section in `docs/usage.md`
- WHEN they compare reads, writes, and does-not-write lists
- THEN reads include project context and `openspec/specs/**`
- AND writes include `openspec/changes/<change-id>/proposal.md`, `design.md`, `tasks.md`, and `specs/**/spec.md`
- AND forbidden writes include `.ai-factory/plans/<id>.md` and `.ai-factory/plans/<id>/task.md` in OpenSpec-native mode.

#### Scenario: Runtime commands keep state outside canonical changes

- GIVEN a user reads implement, fix, verify, and done sections
- WHEN they inspect write locations
- THEN implementation traces are under `.ai-factory/state/<change-id>/implementation/`
- AND fix traces are under `.ai-factory/state/<change-id>/fixes/`
- AND verification and finalization evidence are under `.ai-factory/qa/<change-id>/`
- AND runtime traces are not documented as writes under `openspec/changes/<change-id>/`.

### Requirement: OpenSpec compatibility policy is explicit

The documentation MUST state the optional OpenSpec CLI adapter policy, supported range, Node requirement, degraded behavior, and no-skills-installation rule.

#### Scenario: Compatibility page includes capability metadata

- GIVEN a user reads `docs/openspec-compatibility.md`
- WHEN they inspect runtime capability behavior
- THEN the documented shape includes `available`, `canValidate`, `canArchive`, `version`, `supportedRange: ">=1.3.1 <2.0.0"`, and `requiresNode: ">=20.19.0"`
- AND the page states AIFHub Extension does not install OpenSpec skills or commands.

### Requirement: Legacy migration guide documents safe migration behavior

The migration guide MUST explain how existing `.ai-factory/plans` artifacts migrate into OpenSpec-native changes and runtime or QA preservation paths.

#### Scenario: Migration commands match the real CLI

- GIVEN a user reads `docs/legacy-plan-migration.md`
- WHEN they copy commands from the guide
- THEN the guide includes `node scripts/migrate-legacy-plans.mjs --list`
- AND includes single-plan dry-run and migration commands
- AND includes all-plan dry-run and migration commands
- AND documents `--on-collision fail|merge-safe|suffix|overwrite`
- AND does not invent script names.

#### Scenario: Migration preserves legacy files

- GIVEN a user reads the migration guide
- WHEN they inspect safety behavior
- THEN the guide says legacy files are not silently deleted
- AND validation runs after migration when the compatible OpenSpec CLI is available
- AND missing CLI records degraded validation behavior
- AND users should run `/aif-improve <change-id>` after migration.

### Requirement: Troubleshooting covers expected v1 failure modes

The documentation MUST provide troubleshooting guidance for common OpenSpec-native workflow failures.

#### Scenario: Troubleshooting includes required failure modes

- GIVEN a user reads troubleshooting documentation
- WHEN they scan the listed issues
- THEN it covers OpenSpec CLI missing
- AND Node too old for OpenSpec
- AND invalid delta spec
- AND ambiguous active change
- AND missing or stale generated rules
- AND dirty working tree before `/aif-done`.
