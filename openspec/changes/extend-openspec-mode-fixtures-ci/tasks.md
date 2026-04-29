# Tasks

## 1. Fixture Foundation

- [x] 1.1 Add `scripts/openspec-mode-fixtures.test.mjs` with local temp-root helpers for writing, copying, reading, and listing fixture files; keep helpers dependency-free and Node 18-compatible.
- [x] 1.2 Add or reuse fixtures under `test/fixtures/` for OpenSpec-native config, missing-CLI/OpenSpec-off config, generated OpenSpec change, invalid OpenSpec change, generated-rules specs, and legacy dual-plan migration.
- [x] 1.3 Assert the OpenSpec-native bootstrap fixture contains `aifhub.artifactProtocol: openspec`, `paths.plans: openspec/changes`, `paths.specs: openspec/specs`, runtime paths for state/QA/generated rules, and no OpenSpec skills installed or referenced as installed.
- [x] 1.4 Assert the OpenSpec-off or missing-CLI fixture stays explicit and does not accidentally opt into OpenSpec-native mode.
- [x] 1.5 Keep new test files directly under `scripts/` with `.test.mjs` suffix so `npm test` includes them through the existing `node --test scripts/*.test.mjs` glob.

## 2. Runner And Node Compatibility Coverage

- [x] 2.1 Extend runner coverage for valid validate JSON, invalid JSON, non-zero validate exit, missing CLI, and archive stdout/stderr preservation where current tests do not already assert the integration contract.
- [x] 2.2 Add Node compatibility assertions using injected `nodeVersion` values: Node 18 reports degraded or unsupported OpenSpec CLI capability, and Node 20.19+ reports compatible capability when the fake CLI returns OpenSpec `1.3.1`.
- [x] 2.3 Verify archive wrapper calls use `archive`, `<change-id>`, `--yes`, and `--no-color`, and that archive does not require JSON output.

## 3. OpenSpec-Native Integration Tests

- [x] 3.1 Create `scripts/openspec-v1-integration.test.mjs` to compose existing modules against temp OpenSpec fixtures.
- [x] 3.2 Test the generated `add-oauth` OpenSpec change fixture through explicit active-change resolution and implementation context loading, including proposal, design, tasks, base specs, and delta specs.
- [x] 3.3 Test verification context with fake compatible CLI: validation succeeds, status is recorded, QA evidence is written under `.ai-factory/qa/<change-id>/`, and no `.ai-factory/plans/<change-id>` is created.
- [x] 3.4 Test invalid OpenSpec change validation failure: code verification is blocked, evidence is written under QA runtime paths, archive is not called, and `openspec/changes/<change-id>/` receives no runtime evidence.
- [x] 3.5 Test full mocked v1 happy path: generated rules compile, implementation context loads artifacts, verification passes, done finalizer archives through mocked OpenSpec CLI, final summaries land under runtime state/QA paths, and canonical OpenSpec paths remain clean.
- [x] 3.6 Test full degraded path: missing CLI still allows implementation context and degraded verification, but archive-required done finalization fails clearly without mutating `openspec/specs`.
- [x] 3.7 Use public exports only from `active-change-resolver`, `openspec-execution-context`, `openspec-verification-context`, `openspec-done-finalizer`, `openspec-rules-compiler`, `legacy-plan-migration`, and `openspec-runner`.

## 4. Legacy Migration Integration Coverage

- [x] 4.1 Reuse `test/fixtures/legacy-plan-basic/` to test migration dry-run writes no files and does not create directories.
- [x] 4.2 Test real migration creates `openspec/changes/add-oauth/proposal.md`, `design.md`, `tasks.md`, and any generated migrated delta spec when requirements are clear.
- [x] 4.3 Test runtime-only legacy files are preserved under `.ai-factory/state/add-oauth/` and `.ai-factory/qa/add-oauth/`, never under `openspec/changes/add-oauth/`.
- [x] 4.4 Test legacy files are not deleted and `.ai-factory/plans/add-oauth` remains available after migration.
- [x] 4.5 Test the migrated OpenSpec change can be resolved by `resolveActiveChange` and read by `buildImplementationContext`.

## 5. Generated Rules Snapshot Coverage

- [x] 5.1 Add generated-rules fixture specs for a base `openspec/specs/auth/spec.md` and a delta `openspec/changes/add-oauth/specs/auth/spec.md`.
- [x] 5.2 Test `compileOpenSpecRules('add-oauth')` writes base, change, and merged generated-rules files under `.ai-factory/rules/generated/`.
- [x] 5.3 Assert generated rules include source markers and requirement/scenario content from both base and delta specs.
- [x] 5.4 Assert generated rules output is deterministic across two runs and contains no timestamps.
- [x] 5.5 Assert the rules compiler never writes into `openspec/specs/**` or `openspec/changes/**`.

## 6. CI Matrix

- [x] 6.1 Update `.github/workflows/validate.yml` to run a Node matrix for `18.x` and `20.19.x` with `fail-fast: false`.
- [x] 6.2 Keep `npm run validate` and `npm test` as the CI source of truth for both matrix entries.
- [x] 6.3 Avoid real OpenSpec CLI installation unless it is proven stable and non-network-flaky; rely on fake runner tests for CLI-available behavior.
- [x] 6.4 Do not add `npm ci` unless a valid lockfile is intentionally added. The repository currently has no lockfile and no package dependencies, so the safe default is to keep the existing dependency-free workflow shape.
- [x] 6.5 If a lockfile is added solely to enable `npm ci`, verify `npm ci`, `npm run validate`, and `npm test` locally before committing the workflow change.

## 7. Prompt And Docs Contract Checks

- [x] 7.1 Extend prompt contract tests only where needed to ensure OpenSpec-native prompts keep canonical artifacts under `openspec/changes` and `openspec/specs`, runtime state under `.ai-factory/state`, QA evidence under `.ai-factory/qa`, and generated rules under `.ai-factory/rules/generated`.
- [x] 7.2 Assert OpenSpec-native prompts do not make `.ai-factory/plans` canonical and OpenSpec skills are not installed by the extension.
- [x] 7.3 Update docs minimally only if needed to explain new fixture or CI behavior; do not perform the #37 full docs rewrite.

## 8. Verification

- [x] 8.1 Run `node --test scripts/openspec-mode-fixtures.test.mjs`.
- [x] 8.2 Run `node --test scripts/openspec-v1-integration.test.mjs`.
- [x] 8.3 Run `node --test scripts/openspec-runner.test.mjs` if runner parsing coverage changes.
- [x] 8.4 Run `npm run validate`.
- [x] 8.5 Run `npm test`.
- [x] 8.6 Confirm final diff contains only tests, fixtures, CI workflow, and minimal docs/testability fixes if required.

## Suggested Commit Plan

- Commit 1: `test: add openspec mode fixtures`
- Commit 2: `test: cover openspec v1 integration paths`
- Commit 3: `ci: test openspec coverage across node versions`
- Commit 4: `docs: note openspec fixture and ci coverage`
