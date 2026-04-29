# Delta for OpenSpec Test Coverage

## ADDED Requirements

### Requirement: OpenSpec Mode Fixtures

The test suite MUST include deterministic fixtures for OpenSpec-native mode, OpenSpec-off or missing-CLI mode, generated rules, invalid OpenSpec changes, and legacy dual-plan migration.

#### Scenario: OpenSpec-native fixture declares canonical paths

- GIVEN the OpenSpec-native fixture is created in a temp repository
- WHEN the fixture config is inspected
- THEN it declares `aifhub.artifactProtocol: openspec`
- AND `paths.plans` points to `openspec/changes`
- AND `paths.specs` points to `openspec/specs`
- AND runtime paths point to `.ai-factory/state`, `.ai-factory/qa`, and `.ai-factory/rules/generated`

#### Scenario: OpenSpec-off fixture remains degraded

- GIVEN the OpenSpec-off or missing-CLI fixture is created
- WHEN OpenSpec capability detection is run with a missing CLI or unsupported Node version
- THEN the result reports degraded capability
- AND no real OpenSpec CLI installation is required

### Requirement: V1 Integration Coverage

The test suite MUST exercise the OpenSpec-native artifact protocol across active-change resolution, implementation context, verification context, done finalization, generated rules, and legacy migration.

#### Scenario: Happy path uses mocked compatible CLI

- GIVEN a canonical OpenSpec change fixture exists
- AND a fake compatible OpenSpec CLI is injected
- WHEN rules are compiled, implementation context is loaded, verification succeeds, and done finalization runs
- THEN runtime evidence is written under `.ai-factory/state/<change-id>` and `.ai-factory/qa/<change-id>`
- AND archive is called with `archive <change-id> --yes --no-color`
- AND `.ai-factory/plans/<change-id>` is not created

#### Scenario: Degraded path keeps archive blocked

- GIVEN a canonical OpenSpec change fixture exists
- AND OpenSpec CLI is unavailable
- WHEN implementation context and verification run
- THEN implementation context succeeds
- AND verification records degraded missing-CLI evidence
- AND archive-required done finalization fails clearly
- AND `openspec/specs/**` is not mutated by custom archive logic

### Requirement: Runtime Boundary Assertions

The test suite MUST assert that canonical OpenSpec artifacts and runtime evidence stay in their assigned ownership boundaries.

#### Scenario: Verification evidence stays in QA paths

- GIVEN verification context runs for an OpenSpec change
- WHEN validation evidence and verify summaries are written
- THEN the files are written under `.ai-factory/qa/<change-id>/`
- AND no `verify.md`, status evidence, or runtime logs are written into `openspec/changes/<change-id>/`

#### Scenario: Rules compiler writes only generated rules

- GIVEN base and delta OpenSpec specs exist
- WHEN generated rules are compiled
- THEN generated rules are written under `.ai-factory/rules/generated/`
- AND compiler output includes deterministic source markers
- AND the compiler does not write into `openspec/specs/**` or `openspec/changes/**`

### Requirement: Node Matrix CI

The CI workflow MUST represent both Node 18 degraded/no-CLI behavior and Node 20.19+ OpenSpec-compatible behavior.

#### Scenario: CI validates both supported runtime paths

- GIVEN a pull request or push runs CI
- WHEN the validation workflow executes
- THEN it runs `npm run validate` and `npm test` on Node 18.x
- AND it runs `npm run validate` and `npm test` on Node 20.19.x
- AND the workflow does not require network-dependent OpenSpec CLI tests

#### Scenario: CI install step respects lockfile state

- GIVEN the repository has no package lockfile
- WHEN the CI workflow is updated for the Node matrix
- THEN the workflow does not add `npm ci` unless a valid lockfile is also added intentionally
- AND validation still relies on `npm run validate` and `npm test`
