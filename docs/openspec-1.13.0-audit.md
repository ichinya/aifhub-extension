# OpenSpec 1.13.0 compatibility audit

Reviewed on 2026-09-13 for [issue #198](https://github.com/ichinya/aifhub-extension/issues/198), starting from AIFHub main `6dfe38070be987a101c7d252618ebb596acccef1`. This extends the [1.12.0 audit](openspec-1.12.0-audit.md). Supported stable CLI versions remain `>=1.3.1 <2.0.0`, Node remains `>=20.19.0`, and prereleases remain unavailable for production capabilities. The `/aif-analyze` freshness example advances with its version from `0.15.0` to `0.16.0`.

## Source and executable custody

| Chain | Pin |
|---|---|
| Official release | [v1.13.0](https://github.com/Fission-AI/OpenSpec/releases/tag/v1.13.0), published `2026-09-09T21:10:23Z` |
| Git source | Tag resolves directly to `9d4e5974e5c0d9a09b9c6c1e1eb0975e80ec4461`; [v1.12.0...v1.13.0](https://github.com/Fission-AI/OpenSpec/compare/v1.12.0...v1.13.0), 15 commits and 45 changed files |
| npm executable | `@fission-ai/openspec@1.13.0`, published `2026-09-09T21:08:28.059Z` |
| npm integrity | `sha512-1b1VbjELIUHPz8BLnkVxqPu4pAYS6BhfrLcmUIM7Bd0iJXQDvE+e/LBofE1kydegfxmG7R1xCMRXsl5VtZD+0w==` |
| npm SHA-1 | `5b124e7aafb6b539701a671e1fd015dac6b8bbf0` |
| Package contract | 389 files, Node engine `>=20.19.0`, entrypoint `bin/openspec.js`, no preinstall/install/postinstall hook |

The package was installed outside the checkout with lifecycle scripts disabled. Before executing the audited matrix, the driver verified the downloaded tarball against both published hashes, then compared every installed package file by SHA-256 with the verified archive. Source and npm custody are independent. Runtime dependency ranges in upstream package.json are unchanged; pnpm override relocation, lockfiles, CI/Nix and website updates do not introduce AIFHub runtime dependencies.

Context7 `/fission-ai/openspec` was queried during investigation; its current-main documentation was supporting context, not version-pinned evidence. Exact release/tag sources and the published executable establish the 1.13 behavior.

## Executed matrix

The [checksum-bound driver](../scripts/openspec-compatibility-live-smoke.mjs) passed locally on Windows with physical Node `24.13.0`: 88 recorded rows including package custody. It replays the existing common and 1.12 cases, plus [1.13 cases](../scripts/openspec-1-13-live-cases.mjs). Each JSON command must emit a complete parseable document; stderr and exit codes are asserted. Telemetry and fixture config/data/cache are isolated process-locally.

| Surface | Observed contract | AIFHub result |
|---|---|---|
| Detection, strict validation, status, show, apply/archive instructions | Existing runner argv works; full JSON envelopes remain available | Supported stable range unchanged; reviewed baseline advances |
| Apply without specs | Both `ready` and `all_done` include one warning and `missingPrerequisites: ["specs"]` | Preserve full JSON; expose string warnings as `openspec-apply-warning` without inventing a new blocking state |
| Native `skip_specs: true` | No missing-spec warning or prerequisite | Preserve native no-spec semantics |
| Blocked apply without tasks/specs | `blocked`, ordered prerequisites `["specs", "tasks"]`, no advisory warning, remedy names CLI instructions | Additive prerequisites remain intact; no dependency on an uninstalled continue skill |
| Repeated ADDED sections with a fenced example | Strict validation succeeds; archive writes both real requirements and preserves the fenced example including consecutive blank lines | Coverage counts both real requirements and excludes the example heading |
| `show --deltas-only --json` on that same fixture | Only one delta is returned, while archive applies two | Document upstream limitation; do not use show JSON as an exhaustive delta inventory |
| REMOVED/RENAMED bullets `-`, `*`, `+` | Strict validation succeeds; archive removes First, renames Second, and preserves Keep | Upstream merge remains authoritative |
| Wrapped scenario bullets using `+` | Explicit `retire_capabilities: true` retires the capability | No local retirement implementation |
| Wrapped retirement with an independent operational section | Archive fails and the complete pre/post inventory with SHA-256 hashes is identical | Preserve failure and no-mutation contract |
| Inherited 1.12 cases | Full/findings reports, advisory INFO, archive refusal, I/O fault, .gitkeep and tool-ownership fixtures pass | Retain existing validation/archive boundaries |

The first attempt encountered a Node 18 child while the shared nvm link changed. The successful run selected the physical Node 24.13.0 executable and prepended its directory to the child PATH. This was an environment failure, not a weakened assertion or increased timeout. No physical Node 20.19 CLI execution is claimed; the floor is checked through package metadata and detector tests.

Local extension validators passed on Node 24.13.0 and Node 18.20.8. The focused Node 18.20.8 run passed 219 tests across 20 suites with no skips, covering the changed Markdown, coverage, execution context, runner, version, bootstrap, metadata and documentation contracts. This tests the extension's Node 18 compatibility, not execution of the OpenSpec CLI on Node 18.

The complete extension test suite on Node 24.13.0 passed **1482 tests across 175 suites**, with zero failures, cancellations or skips. Hosted Ubuntu CI on Node 18.x/20.19.x was not run in this local adaptation; no commit, push or release is part of this evidence.

## Adaptation and ownership

The commit/file inventory and relevant parser, apply, archive, schema and generated-guidance patches were reviewed against the adapter boundary.

- **Adapter changes:** propagate advisory apply warnings to the execution-context diagnostics; ignore fenced headings in coverage using the shared Markdown mask; keep repeated real sections. Regression tests failed on both original implementations before the fixes. A line with fence characters followed by non-whitespace is not treated as a closing fence.
- **Planning guidance:** explore/plan/improve explicitly distinguish accepted-spec inventory from active changes, preserve existing nested capability paths, and read relevant specs including scenarios. The optional `list --specs` command illustrates the distinction; filesystem discovery remains supported without a CLI.
- **Upstream-owned:** project/store context resolution in generated propose, rootless initialization decisions, profile workflow notices, command drift repair in update, generated tool assets, schemas, Stores and package management. AIFHub retains its own filesystem artifact/bootstrap protocol and configured context boundaries; it does not transplant the generated `/opsx:propose` workflow or add automatic initialization.
- **Compatibility residual:** upstream show JSON is incomplete for repeated sections. The real archive and AIFHub canonical-file coverage are verified independently. The exact-version regression deliberately records this limitation rather than silently accepting any delta count.

PR #205 follow-up: shared fence delimiters accept only zero to three leading spaces. Four-space-indented or tab-indented markers neither open a fence nor close an existing example. Helper and coverage regressions cover both backticks and tildes, preserving real requirements after examples and excluding headings inside them. This tightens AIFHub's Markdown handling independently of the upstream CLI parser.

Follow-up validation: both new regressions failed before the fix. Afterward, 162 consumer tests across 29 suites passed on Node 24.13.0, including plan resolution, migration, artifact validation and workflow consumers; all 14 helper/coverage tests also passed on Node 18.20.8. Extension validators and `git diff --check` passed.

There is no tracked root accepted-spec corpus in this extension. Disposable synthetic fixtures are not accepted project requirements; no archived project evidence was rewritten.

## Reproduction and evidence limits

Provision the exact npm package and tarball outside the checkout, with install lifecycle scripts disabled. Use an explicit physical Node executable and a matching child PATH when a version-manager link can change. Run:

```text
node scripts/openspec-compatibility-live-smoke.mjs <installed-package-root> <openspec-1.13.0.tgz>
npm run validate
npm test
```

The driver never installs packages, verifies the pinned archive and installed bytes itself, and removes only its own disposable fixture tree. Exact CLI smoke, local extension validation/tests, hosted CI and publication are separate evidence scopes. The CLI results above establish local compatibility, not hosted CI, deployment or production acceptance.
