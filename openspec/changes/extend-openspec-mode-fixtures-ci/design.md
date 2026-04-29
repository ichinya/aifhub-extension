# Design: Extend OpenSpec Mode Fixtures and CI Coverage

## Technical Approach

This is a tests/fixtures/CI change. The implementation should compose existing modules rather than add behavior:

- `scripts/openspec-runner.mjs`
- `scripts/active-change-resolver.mjs`
- `scripts/openspec-execution-context.mjs`
- `scripts/openspec-verification-context.mjs`
- `scripts/openspec-done-finalizer.mjs`
- `scripts/openspec-rules-compiler.mjs`
- `scripts/legacy-plan-migration.mjs`

Add fixture helpers that create temp repo layouts in a deterministic way. Keep helpers local to the test files unless duplication becomes material. The tests should use Node built-ins only: `node:test`, `node:assert/strict`, `node:fs/promises`, `node:path`, `node:os`, and dependency injection hooks already exposed by the modules.

The new test files should live directly under `scripts/` with names ending in `.test.mjs`. This keeps them covered by the existing package script:

```json
{
  "test": "node --test scripts/*.test.mjs"
}
```

Integration tests should import only public module exports. Do not reach into private helpers from production modules; if a private helper looks necessary, prefer building the fixture through public API behavior or add a narrowly scoped testability export only if the gap cannot be covered otherwise.

The new integration tests should verify behavior at protocol boundaries:

- canonical artifacts live only under `openspec/specs/**` and `openspec/changes/<change-id>/**`;
- runtime state and QA evidence live only under `.ai-factory/state/<change-id>/**`, `.ai-factory/qa/<change-id>/**`, and `.ai-factory/rules/generated/**`;
- OpenSpec-native mode does not require or create `.ai-factory/plans/<change-id>`;
- missing CLI does not block bootstrap, implementation context, verification degraded mode, or migration;
- missing CLI blocks archive-required done finalization unless an explicit dry-run or summary-only mode allows no archive;
- mocked compatible CLI validates, writes evidence, and archives through the shared runner wrapper.

## Data / Artifact Model

Recommended fixture directories:

```text
test/fixtures/openspec-native/
test/fixtures/openspec-missing-cli/
test/fixtures/generated-rules/
test/fixtures/legacy-plan-basic/
```

The existing `test/fixtures/legacy-plan-basic/` fixture from #35 should be reused or extended instead of duplicated.

Recommended generated OpenSpec change fixture:

```text
openspec/changes/add-oauth/
  proposal.md
  design.md
  tasks.md
  specs/auth/spec.md
openspec/specs/auth/spec.md
```

Recommended invalid change fixture:

```text
openspec/changes/bad-change/
  proposal.md
  tasks.md
```

Recommended OpenSpec-native config fixture:

```yaml
aifhub:
  artifactProtocol: openspec
  openspec:
    root: openspec
    installSkills: false
    validateOnPlan: true
    validateOnVerify: true
    archiveOnDone: true

paths:
  plans: openspec/changes
  specs: openspec/specs
  state: .ai-factory/state
  qa: .ai-factory/qa
  generated_rules: .ai-factory/rules/generated
```

## Integration Points

### Runner

Extend or complement `scripts/openspec-runner.test.mjs` for integration-level assertions:

- valid validate JSON;
- invalid JSON;
- non-zero validate exit;
- missing CLI;
- archive preserving raw stdout/stderr;
- archive not requiring JSON.

Do not depend on real `openspec`.

### Execution And Verification Context

Use the generated OpenSpec change fixture to assert:

- `resolveActiveChange` resolves explicit `add-oauth`;
- `buildImplementationContext` reads proposal/design/tasks/base specs/delta specs;
- `buildVerificationContext` can run with fake compatible CLI and writes QA evidence;
- invalid validation blocks code verification and does not archive.

### Done Finalizer

Use mocked verification evidence and mocked archive runner to assert:

- archive wrapper is called with `archive <change-id> --yes --no-color`;
- final summary is written under `.ai-factory/state/<change-id>/`;
- final QA evidence remains under `.ai-factory/qa/<change-id>/`;
- missing CLI fails archive-required mode with a clear error.

### Rules Compiler

Use base and delta specs to assert generated files:

- `.ai-factory/rules/generated/openspec-base.md`;
- `.ai-factory/rules/generated/openspec-change-add-oauth.md`;
- `.ai-factory/rules/generated/openspec-merged-add-oauth.md`.

Assert source markers, deterministic output across two runs, no timestamps, and no writes into `openspec/specs/**` or `openspec/changes/**`.

### Legacy Migration

Use `test/fixtures/legacy-plan-basic/` and `scripts/legacy-plan-migration.mjs` to assert:

- dry-run writes nothing;
- real migration creates proposal/design/tasks and runtime/QA preservation files;
- `verify.md` and `status.yaml` do not enter canonical OpenSpec change folders;
- legacy source files remain present;
- migrated change can be resolved and loaded by implementation context.

### CI

Update `.github/workflows/validate.yml` from a single Node 20 job to a matrix:

```yaml
strategy:
  fail-fast: false
  matrix:
    node-version: ['18.x', '20.19.x']
```

Run in both matrix entries:

```bash
npm run validate
npm test
```

There is currently no `package-lock.json`, `npm-shrinkwrap.json`, `pnpm-lock.yaml`, or `yarn.lock`. Do not add `npm ci` unless the implementation also creates and commits a valid lockfile intentionally. The current package has no dependencies; `npm test` and `npm run validate` are the source of truth.

## Alternatives Considered

- Install a real OpenSpec CLI in CI: rejected unless proven lightweight and stable. The issue prioritizes dependency-injected fake runner coverage and non-flaky CI.
- Move existing module tests wholesale into integration tests: rejected because focused tests are already useful and fast.
- Update the root `.ai-factory/config.yaml` to OpenSpec-native: rejected for #36 because tests should model both OpenSpec-on and OpenSpec-off states using temp fixtures.

## Risks

- Integration tests may become slow if they repeatedly copy full repo trees. Keep fixtures small and use temp directories.
- Assertions against whole generated files can be brittle. Prefer targeted assertions and deterministic inline snapshots for key generated-rules sections.
- CI on Node 18 may expose tests that accidentally rely on Node 20-only APIs. Keep test helpers compatible with Node 18 syntax and APIs.
