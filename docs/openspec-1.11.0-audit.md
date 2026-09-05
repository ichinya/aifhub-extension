# OpenSpec 1.11.0 compatibility audit

Issue [#171](https://github.com/ichinya/aifhub-extension/issues/171), reviewed on 2026-09-05 against AIFHub main `a560e3fcf6148d9e1663c51db188f6c1491a6477`. Prerequisites [#153](https://github.com/ichinya/aifhub-extension/issues/153) and [#170](https://github.com/ichinya/aifhub-extension/issues/170) were closed; the 1.10.0 audit merged in [PR #174](https://github.com/ichinya/aifhub-extension/pull/174) at `4735c71fa70a39c940f2411b623656b5d3239a45`.

Canonical local change: `openspec/changes/171-adapt-openspec-1-12-0/` (proposal, design, tasks, delta spec, native metadata). Root OpenSpec artifacts are ignored and excluded from this extension's distribution by its existing artifact-boundary policy. This tracked audit and the [opt-in smoke driver](../scripts/openspec-compatibility-live-smoke.mjs) preserve review evidence across checkouts; the local change is not a shipped product spec.

## Exact 1.11.0 Custody and Evidence Boundary

| Chain | Pin |
|---|---|
| Official release | [v1.11.0](https://github.com/Fission-AI/OpenSpec/releases/tag/v1.11.0), published `2026-08-26T21:40:26Z` |
| Git source | Tag resolves directly to commit `a0ddb60d040c61f4907436a9d91310934b1dda63`; [v1.10.0...v1.11.0](https://github.com/Fission-AI/OpenSpec/compare/v1.10.0...v1.11.0), 13 commits and 134 changed files |
| npm executable | `@fission-ai/openspec@1.11.0`, published `2026-08-26T21:28:46.504Z` |
| npm integrity | `sha512-P9h8H4Snit8I7tHmCopjg3QDwBllIlObxb+/DebvBwhWTj6YEPPYRYkC4n5GqG4PdQnKMA6E1AlEOI9FT4G7FA==` |
| npm SHA-1 | `0637db769ac89a2120f98f5ce23f05f29e50c193` |
| Runtime | Node engine `>=20.19.0`, bin `openspec: bin/openspec.js`; new runtime dependency `diff: ^9.0.0`, other runtime dependency names/ranges unchanged; no install lifecycle scripts |

The local tarball was hash-verified and installed outside the repository with lifecycle scripts disabled. All 385 published files were byte-verified against the installed package. Adapter probes use that installation's explicit shim; optional upstream probes invoke its `bin/openspec.js` directly through the selected Node executable. Neither a PATH OpenSpec nor an unrelated npm version string supplies executable custody. Context7 `/fission-ai/openspec` supplied supporting current-main documentation, not version-pinned authority.

Evidence is local Windows execution on Node `24.13.0`. The Node floor is verified from the pinned package and adapter boundary tests; this is not a claim of an additional physical Node 20.19 runtime run, CI acceptance, publication, or production execution. This document preserves the 1.11.0 checkpoint. The user subsequently extended the same local change through [1.12.0](openspec-1.12.0-audit.md), retaining one aif-analyze bump to 0.14.0; later evidence is recorded separately.

## Exact 1.11.0 CLI matrix

The driver asserts outputs and cleans up its own disposable fixtures. JSON stdout must parse as one whole document. Telemetry is disabled process-locally and OpenSpec global config/data are isolated through XDG directories.

| Surface | Observed result and assertion | Decision |
|---|---|---|
| Version and adapter detection | Exact `1.11.0`; validate/archive capabilities available | Advance reviewed baseline; retain stable range `>=1.3.1 <2.0.0` and Node `>=20.19.0` |
| Strict change validation | Valid change exit `0`; duplicate task ID exit `1` with `tasks.md` diagnostics retained in raw JSON | Existing fail-closed wrapper remains compatible |
| Per-change status, spec/delta show, apply/archive instructions | All exit `0` with parseable open JSON envelopes and additive context/root | Existing wrapper argv and ownership preserved |
| Invalid archive | Exit `1`; complete file inventory and SHA-256 values unchanged | Existing archive wrapper remains fail-closed |
| `show --diff --json` | Same top-level `id`, `title`, `deltaCount`, `deltas`, `root`; MODIFIED entries gain `diff`, ADDED entries do not; text mode renders requirement changes | `upstream-owned` optional read; no public wrapper option |
| Missing main spec in diff | Exit `0` with MODIFIED `warning` and no fabricated `diff`; strict authored-delta validation also exits `0`, while archive exits `1` without changing any file | Neither display nor strict authored-delta success proves merge eligibility; preserve archive failure |
| `status --all --json` | Stable repeated output sorted by `localeCompare`, including mixed-case names; healthy entries match per-change status with root hoisted to envelope | `upstream-owned` optional bulk read; AIFHub keeps per-change orchestration |
| Partial batch failure | JSON and text exit `1`; broken entry has `change_error` diagnostic and healthy siblings remain; per-change failure also stays non-zero | Preserve diagnostics; do not infer success from a partially populated envelope |
| Batch invalid selection | `--all` with `--change`, unknown schema, or unknown Store exits `1`; JSON includes `changes: []`, `root: null`, error status | No resolver or flag expansion |
| Empty batch | Exit `0`, empty changes; unknown schema still exits `1` | Empty workspace differs from invalid selection |
| Purpose warning and remediation | Generated placeholder and opening TODO pass non-strict with WARNING, fail strict with `overview` line; existing Purpose survives archive despite authored delta Purpose; direct correction passes while archive hashes stay unchanged | Document direct accepted-spec remediation and meaningful new-capability Purpose |
| Purpose non-findings | Embedded unresolved TBD and fenced placeholder example pass strict | Do not implement a second broad substring checker |
| Archive rename | Middle requirement stays between First and Last under its new name; scenario retained; aggregate strict validation passes | Upstream fix, no local archive implementation |
| `schema init --default` | Writes loader-owned `schema` in existing `config.yml`, removes stale `defaultSchema`, preserves context/comment; new change uses selected schema | `upstream-owned` schema management |
| Schema rejection and rollback | Malformed YAML plus `--force` leaves config/schema hashes unchanged; exported upstream seam injects failure at staged config installation after schema installation, exit `1`, old config/schema restored with no residual staging/backup files | Rollback verified in exact package; no AIFHub schema mutation |
| Antigravity/Codex shared root | Init and update preserve AIFHub sentinel, customized legacy `.agent` skill/workflow, and the selected shared `.agents/skills` content; current `.agents/workflows` generated | `upstream-owned` migration; no AIFHub tool installer |

Schema commands emit their experimental notice on stderr, including under `--json`; the driver asserts that exact notice. Other JSON probes assert empty stderr. Rollback fault injection uses the exact package's exported `schemaInitFileOperations` seam in a child process, not a modified installed package.

## Source classification

The release notes, all 13 commit subjects and 134-file inventory, and relevant adapter/runtime source patches and upstream regression contracts were inspected.

| Classification | Changes | AIFHub action |
|---|---|---|
| `adapter-change-required` | Reviewed metadata and stricter accepted-spec Purpose checks | Advance ledger; add Purpose authoring and bounded direct-remediation guidance in plan/improve/docs |
| `regression-or-no-op` | Existing JSON/exit contracts, diff warnings, sorted batch diagnostics, archive rename order | Add focused offline contracts and exact CLI fixtures; leave production command construction intact |
| `upstream-owned` | Schema transaction/default migration and discovery filters; Antigravity path migration and shared writer selection | Exercise disposable fixtures; do not add production wrappers |
| `upstream-owned` | Explore write-confirmation and ASCII examples, Fish completions, generated tool workflows | Source-reviewed no-op; existing AIFHub Explore confirmation contract stays in place; no Fish runtime claim |
| `upstream-owned` | Documentation-site rebuild, website/dev dependencies, Nix lock metadata, internal authoring skills, release files | No adapter consumer; no copied site, package-manager or generated-assets behavior |

The final tagged batch implementation sets exit `1` for incomplete JSON reports. Earlier intermediate commit prose claimed exit `0`; the tagged source and executed fixture take precedence.

## Canonical corpus and remediation

Starting root inventory: **0 accepted specs**, **0 active changes**, **0 archived changes**. There was no existing root `openspec/` directory in this worktree, and Git tracks no root corpus. Specs under `test/fixtures/` and `scripts/fixtures/` are synthetic inputs, not accepted project requirements, and intentional invalid fixtures are not rewritten.

The audit adds one local active change with one delta spec and a meaningful Purpose. Aggregate strict validation therefore checks that non-empty active corpus; the separate disposable rename and Purpose fixtures validate actual accepted specs. No claim is made about unprovided consumer projects or other worktrees. No accepted placeholder required remediation in this checkout, and no archived evidence was edited.

For a consumer with placeholder debt, follow [Purpose remediation](openspec-validation.md#purpose-placeholders-in-openspec-1110): inventory accepted specs, record affected paths, edit each accepted Purpose directly within the authorized scope, retain the default base-spec guard except for explicit bounded remediation, and re-run aggregate strict validation. A delta Purpose is only useful when the capability is first created.

## Reproduction and repository gates

Provision the exact npm tarball into an isolated directory outside the checkout and install it there with scripts disabled. The driver takes the installed package directory and the original tarball, verifies both hashes, extracts a snapshot using the system `tar`, compares every installed package file, and performs assertions. It never installs or updates anything.

```text
node scripts/openspec-compatibility-live-smoke.mjs <installed-@fission-ai/openspec-directory> <openspec-1.11.0.tgz>
node --test scripts/openspec-1-11-compatibility.test.mjs scripts/openspec-runner.test.mjs scripts/openspec-policy.test.mjs scripts/aif-analyze-openspec-bootstrap.test.mjs scripts/aif-artifact-sync.test.mjs scripts/validate-extension.test.mjs scripts/docs-workflow-contract.test.mjs
npm run validate
npm test
<exact-1.11.0-cli> validate --all --strict --json --no-interactive --no-color
git diff --check
```

The live smoke is deliberately opt-in and outside the ordinary `*.test.mjs` suite: ordinary tests require neither network access nor an installed OpenSpec. Aggregate root validation requires the local canonical artifacts described above; it cannot be reproduced by treating an empty clean checkout as the audited corpus. Historical `validate --archived` stays advisory-only and outside mandatory gates.

## Observed repository gates

| Gate | Local result |
|---|---|
| Checksum-bound exact CLI smoke | PASS, 43 assertion-backed matrix records, all 385 installed package files verified |
| Focused compatibility contracts | PASS, 169 tests; subsequent analyze/review-policy fixture corrections covered by focused reruns and the full suite |
| `npm run validate` | PASS |
| `npm test` | PASS, 1159 tests / 160 suites, zero failures and zero skips |
| Exact `validate --all --strict --json --no-interactive --no-color` | PASS, one active canonical change, zero issues; no accepted root specs |
| `git diff --check` | PASS |

Full-suite verification exposed two stale analyze-version expectations, which now follow the 0.14.0 skill, and a pre-existing Ponytail timeout fixture that could kill Node before it printed its test output. That fixture's startup allowance increased from one to five seconds while its child still deliberately runs for ten seconds; timeout and partial stdout/stderr assertions remain intact. No Ponytail production code changed. The final full-suite result above used the ordinary `npm test` script without concurrency overrides.
