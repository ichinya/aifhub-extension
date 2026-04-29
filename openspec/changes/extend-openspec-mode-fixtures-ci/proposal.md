# Proposal: Extend OpenSpec Mode Fixtures and CI Coverage

## Intent

Issue #36 is the consolidation step after the OpenSpec-native artifact protocol work and the legacy migration flow. The repo already has focused module tests for the OpenSpec runner, active-change resolver, execution context, verification context, rules compiler, done finalizer, prompt contracts, and legacy migration. The remaining risk is integration coverage: the v1 protocol should be exercised as a connected workflow across OpenSpec-on, OpenSpec-off, missing CLI, legacy migration, generated rules, validate/archive parsing, and Node compatibility paths.

This change should make the OpenSpec-native integration safer without adding product behavior. Tests should model both degraded and compatible CLI environments through dependency injection, and CI should run the same validation/test suite on Node 18 and Node 20.19+.

## Scope

In scope:

- Add reusable OpenSpec fixture helpers and/or fixture directories for OpenSpec-native, missing-CLI, generated-rules, and legacy migration scenarios.
- Add integration-style tests that exercise existing modules together instead of duplicating only isolated unit coverage.
- Cover OpenSpec-native bootstrap/config shape and OpenSpec-off or missing-CLI behavior.
- Cover generated OpenSpec change fixtures through active-change resolution, implementation context, verification context, and done finalizer.
- Cover invalid OpenSpec changes failing verification before code checks and writing evidence only under QA runtime paths.
- Reuse the legacy dual-plan migration fixture from #35 and verify migrated changes can be consumed by OpenSpec-native modules.
- Add deterministic generated-rules output checks, including source markers, no timestamps, and no canonical artifact mutation.
- Add validate/archive runner parsing coverage where the current runner tests do not already cover integration expectations.
- Add full v1 happy-path and degraded-path integration tests with mocked CLI behavior.
- Update GitHub Actions to run `npm run validate` and `npm test` on Node 18.x and Node 20.19.x.
- Decide the CI install step based on the repository's current package state. There is currently no lockfile, so adding `npm ci` without also adding a valid lockfile would break CI.
- Keep all tests network-free and independent of a real OpenSpec CLI.

Out of scope:

- Full docs rewrite for #37.
- New OpenSpec product behavior, custom schemas, OpenSpec skill installation, or network-dependent OpenSpec tests.
- Changes that require the real local git repository during tests.
- Actual commit, PR, or release automation.

## Approach

Create a small test fixture layer under `test/fixtures/` and one or two integration test files under `scripts/`:

- `scripts/openspec-mode-fixtures.test.mjs` for fixture shape, OpenSpec-on/off config, Node compatibility detection, and prompt/docs contract checks that belong to #36.
- `scripts/openspec-v1-integration.test.mjs` for end-to-end mocked workflows that compose existing modules.

Use temp directories for every test. Fixture helpers should copy or create repo-like structures with:

- `.ai-factory/config.yaml`
- `openspec/config.yaml`
- `openspec/specs/**/spec.md`
- `openspec/changes/<change-id>/proposal.md`
- `openspec/changes/<change-id>/design.md`
- `openspec/changes/<change-id>/tasks.md`
- `openspec/changes/<change-id>/specs/**/spec.md`
- `.ai-factory/state/<change-id>/`
- `.ai-factory/qa/<change-id>/`
- `.ai-factory/rules/generated/`

Prefer shared helper functions in the new test files over introducing dependencies. Use fake executors and injected module hooks for CLI behavior, current branch, git state, validation/status responses, and archive responses. Keep outputs deterministic and assert that runtime evidence stays out of canonical OpenSpec folders.

Update `.github/workflows/validate.yml` to use a Node matrix:

- Node 18.x validates degraded/no-CLI behavior and ensures no hard dependency on OpenSpec CLI.
- Node 20.19.x validates OpenSpec-compatible runtime assumptions while still relying on mocked CLI tests.

## Risks / Open Questions

- Some coverage already exists in focused module tests. The new tests should close integration gaps without turning into brittle duplicates.
- Node 18 cannot run the real OpenSpec CLI, so coverage must represent degraded behavior through runner detection and injected node versions.
- Full happy-path integration can be too broad if it asserts implementation details from every module. Keep assertions on protocol boundaries, outputs, paths, and command calls.
- The repo's root `.ai-factory/config.yaml` is still legacy-oriented; tests should create explicit temp configs rather than depending on repository-global config state.
- New test files must stay directly under `scripts/` and end with `.test.mjs` so the existing `npm test` glob includes them without changing package scripts.
