# OpenSpec 1.12.0 compatibility audit

Reviewed on 2026-09-05 against AIFHub main `a560e3fcf6148d9e1663c51db188f6c1491a6477`. The user explicitly extended [issue #171](https://github.com/ichinya/aifhub-extension/issues/171) through 1.12.0 after the [1.11.0 checkpoint](openspec-1.11.0-audit.md). Both adaptations share one `/aif-analyze` version bump from 0.13.0 to **0.14.0**. The stable supported range remains `>=1.3.1 <2.0.0`, with Node `>=20.19.0`; prereleases remain unsupported for production capabilities.

Canonical local change: `openspec/changes/171-adapt-openspec-1-12-0/`. Root OpenSpec artifacts remain ignored and excluded from this extension's distribution under its existing artifact-boundary policy. This tracked report and the [opt-in smoke driver](../scripts/openspec-compatibility-live-smoke.mjs) preserve the evidence and reproduction procedure.

## Exact source and executable custody

| Chain | Pin |
|---|---|
| Official release | [v1.12.0](https://github.com/Fission-AI/OpenSpec/releases/tag/v1.12.0), published `2026-09-03T00:09:15Z` |
| Git source | Tag resolves directly to commit `e062b9572be933564ba3899d059377dfa1393e32`; [v1.11.0...v1.12.0](https://github.com/Fission-AI/OpenSpec/compare/v1.11.0...v1.12.0), 20 commits and 70 changed files |
| npm executable | `@fission-ai/openspec@1.12.0`, published `2026-09-03T00:09:12.604Z` |
| npm integrity | `sha512-oFE2Lj7WVSc87nSibk6qe9HjHIOlxhcPAXbPey44DlLvJzBl5+9BZVrNiozOwv++CQhW+MG0kuP1XLZ/uQrrWw==` |
| npm SHA-1 | `c844543999f673cdd72445879b86a4abea4c07ef` |
| Package contract | 389 published files; Node engine `>=20.19.0`; bin `openspec: bin/openspec.js`; runtime dependency names/ranges unchanged from 1.11.0 |

The tarball was hash-verified before installation outside the checkout with lifecycle scripts disabled. All 389 installed package files were compared by SHA-256 with the verified tarball. Adapter probes select its explicit shim; other probes use its exact entrypoint with the current Node executable. Context7 `/fission-ai/openspec` was queried, but its current-main index did not provide version-pinned 1.12 details; tagged source, release and npm metadata supply that authority.

The source package changes `prepare` from `pnpm run build` to `node build.js`, and `packageManager` from pnpm 9.15.9 to 10.34.5. These concern upstream Git-source development/install workflows. The published npm package has no `prepare`, `prepublishOnly`, `preinstall`, `install`, or `postinstall` hook and ships built assets. AIFHub adds no package-manager behavior. Runtime dependency ranges, including `chalk: ^5.6.2`, remain unchanged; upstream lockfile and CI maintenance are not a new adapter dependency contract.

Evidence below is local Windows execution on Node `24.13.0`. The declared Node floor is checked through package metadata and adapter boundary tests, without claiming an additional physical Node 20.19 run. Local gates do not establish CI acceptance, publication, deployment, or execution in other consumer projects.

## Exact CLI matrix

The common 1.11 matrix runs against 1.12 as well, retaining exact adapter validate/status/show/instructions/archive checks, diff/batch behavior, strict Purpose remediation, rename ordering, schema default rollback, and Antigravity shared-root preservation. The [additional cases](../scripts/openspec-1-12-live-cases.mjs) assert the following 1.12 semantics.

| Surface | Observed result and assertion | AIFHub decision |
|---|---|---|
| Default and explicit `--report full` | Same `items`, `summary`, `version`, `root` envelope and content, excluding independently measured durations | Keep existing per-change argv and full reports |
| `--report findings` | Distinct `report`, `itemFindings`, `summary`, `root` envelope; mixed five-item corpus returns three items containing INFO, WARNING and ERROR; totals remain 4 passed/1 failed, exit 1 | Optional upstream-owned projection; do not replace per-change full reports |
| Strict findings | Same corpus totals become 3 passed/2 failed because strict WARNING blocks; INFO-only item remains valid | Preserve upstream severity/verdict and full-scope exit semantics |
| Scope and empty findings | `--changes --specs` normalizes to `all`; clean all/changes/specs scopes return no findings with nonzero totals; empty corpus reports zero totals | Empty findings do not imply no validation |
| Invalid report requests | Missing bulk scope, unknown report, item-name combinations, and mixed archived/active scope all exit 1 with `invalid_validation_report_request` | Preserve failure evidence; archived-wide validation remains advisory-only |
| Text reporting | Scope/totals on stdout, issue text on stderr, no ANSI escapes under `--no-color`; ordinary successful validation also prints INFO | Preserve diagnostics instead of dropping valid-item findings |
| Missing requirement and missing nested base | Strict validation exit 0/valid true with INFO and capability path; real adapter retains full JSON; actual archive exits 1 with complete file inventory/hashes unchanged | Validation success is not archive eligibility |
| Structural and scenario-loss errors | Exit 1 with original ERROR, no duplicate archive-preflight INFO for that capability | Existing blocking behavior remains intact |
| Already-synced addition | Identical accepted ADDED requirement passes strict without a false merge-conflict finding | Reuse upstream semantics; no local merge checker |
| Accepted-spec EIO | Child-process read fault does not become a fabricated missing-target INFO; archive exits 1 naming the I/O failure with unchanged corpus | Advisory checking is incomplete under I/O faults; actual archive remains authoritative |
| `.gitkeep` | Fresh init anchors empty specs/archive directories; extend init restores a missing empty-directory marker, preserves existing marker bytes, and does not anchor populated directories | Upstream-owned init; markers do not become specs or active changes |
| SourceCraft Code Assistant | Init/update generate `.codeassistant` skills/commands; AIFHub sentinel and user marker survive; status and strict bulk validation see zero items | Upstream-owned tool generation/update; no AIFHub installer |

All JSON output is parsed as one complete document, with stderr empty except the explicitly asserted schema experimental notice. Fixture config/data/cache are isolated with XDG directories and telemetry disabled process-locally. Preflight read-only checks compare complete file inventories and SHA-256 hashes. The EIO hook patches `node:fs/promises` only inside a disposable child; installed package bytes are not edited.

## Source classification and boundaries

All 20 commit subjects and the 70-file inventory were inspected, with relevant runtime, validation, merge-builder, init/tool, workflow, package patches and upstream regression contracts reviewed.

| Classification | Upstream changes | AIFHub action |
|---|---|---|
| `adapter-change-required` | Reviewed version and propose/ff repository grounding | Advance cumulative ledger through 1.12; require proportional read-only inspection of implementation/tests/config/docs before drafting or refining dependent artifacts |
| `regression-or-no-op` | Findings projection, advisory archive preflight, non-missing I/O propagation | Exact CLI fixtures plus runner and downstream verification/sync contracts; retain full reports, diagnostic payloads and fail-closed archive |
| `upstream-owned` | SourceCraft, shared IDE restart hint, init anchors | Disposable init/update fixtures; no duplicated tool, asset, Store, schema or package manager ownership |
| `upstream-owned` | Explore dependency-focused questions | Existing AIFHub dependency frontier, bounded fact-finding and explicit brief-confirmation contract already applies; no new interview engine or skill bump |
| `upstream-owned` | Git prepare, pnpm/lock updates, Node 20/chalk maintenance, CI changesets, website/dev dependency updates, PowerShell completion and store/community docs | Source-reviewed; no adapter API change, package installation, website fork or completion runtime claim |

Repository grounding distinguishes observed behavior, assumptions and proposals, identifies a target repository separate from `planningHome.root`, and surfaces spec/code conflicts before dependent design decisions. Greenfield work uses existing structure and setup docs; unavailable source is disclosed. Discovery remains read-only and proportional rather than being deferred into generic implementation tasks.

Archive preflight reuses `findSpecUpdates` and `buildUpdatedSpec(..., {silent: true})` but does not perform final merged-spec validation or retirement checks. Tagged source also preserves partial validation diagnostics if advisory discovery fails and suppresses errno-based false conflict findings. Those broader source paths, exclusive-create race handling, and other already-synced rename/removal cases are source-reviewed; the table states the directly executed cases without claiming exhaustive upstream coverage.

## Corpus and reproduction

Starting inventory at the 1.11 checkpoint: **0 accepted specs**, **0 active changes**, **0 archived changes**. This extension tracks no root corpus. The same local active change was expanded through 1.12, preserving its 1.11 evidence; the final root has one active change with a meaningful delta Purpose and no accepted specs. Synthetic test fixtures are not accepted project requirements. There was no accepted placeholder debt to remediate and no archived evidence was rewritten.

Provision the exact tarball outside the checkout, verify the pins above and install it there with scripts disabled. The driver independently re-verifies both hashes and every installed package file, runs assertions, and removes only its own temporary fixtures. It never installs or upgrades packages.

```text
node scripts/openspec-compatibility-live-smoke.mjs <installed-@fission-ai/openspec-directory> <openspec-1.12.0.tgz>
node --test scripts/openspec-1-11-compatibility.test.mjs scripts/openspec-1-12-compatibility.test.mjs scripts/openspec-runner.test.mjs scripts/openspec-policy.test.mjs scripts/aif-analyze-openspec-bootstrap.test.mjs scripts/aif-artifact-sync.test.mjs scripts/openspec-verification-context.test.mjs scripts/validate-extension.test.mjs scripts/docs-workflow-contract.test.mjs
npm run validate
npm test
<exact-1.12.0-cli> validate --all --strict --json --no-interactive --no-color
git diff --check
```

The live smoke is opt-in; ordinary tests require neither network nor an installed OpenSpec. Aggregate root validation requires the ignored local canonical change; an empty checkout is not equivalent evidence. Archived-wide validation is advisory-only and outside mandatory gates.

## Observed local gates

| Gate | Result |
|---|---|
| Exact 1.12.0 CLI matrix | PASS, 73 assertion-backed records; all 389 installed package files verified |
| Exact 1.11.0 replay with the shared driver | PASS, 43 records; all 385 installed package files verified |
| Focused compatibility and downstream contracts | PASS, 197 tests, including INFO preservation in verify and sync |
| `npm run validate` | PASS |
| Ordinary `npm test` | PASS, 1165 tests / 161 suites, zero failures and zero skips |
| Exact strict aggregate root validation | PASS, one active canonical change, zero issues and 0 accepted specs |
| `git diff --check` | PASS |

The production runner change is limited to the reviewed-version constant. New flags and merge logic remain upstream-owned. The 1.11 checkpoint's analyze fixture corrections and Ponytail timeout-fixture startup allowance remain part of this combined change; no additional skill-version bump or Ponytail production edit was introduced for 1.12. These are local validation results; publication status is tracked separately in Git and the pull request.
