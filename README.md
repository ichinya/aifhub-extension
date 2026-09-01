# AIFHub Extension

AIFHub Extension adds an OpenSpec-native artifact protocol to the AI Factory CLI user experience.

The v1 workflow keeps AI Factory commands as the user-facing path and uses OpenSpec artifacts as the canonical source of truth for specs and changes:

```text
AI Factory UX + OpenSpec artifact protocol
```

## What This Extension Does

- Keeps `/aif-analyze`, `/aif-plan`, `/aif-explore`, `/aif-improve`, `/aif-implement`, `/aif-rules-check`, `/aif-review`, `/aif-security-checklist`, `/aif-verify`, `/aif-fix`, `/aif-done`, `/aif-commit`, `/aif-evolve`, and `/aif-mode` as the public command vocabulary.
- Sharpens `/aif-explore` requests through dependency-aware decision rounds: project facts stay assistant-owned and read-only, user-owned decisions are asked by prerequisite frontier with recommendations, and research waits for confirmation of the normalized brief.
- In OpenSpec-native mode, writes canonical change artifacts under `openspec/changes/<change-id>/` and accepted specs under `openspec/specs/`.
- Keeps AI Factory runtime state, verification evidence, finalization evidence, and generated rules outside canonical OpenSpec changes.
- Requests OpenSpec validation, status, instructions, and archive through the AIFHub wrapper and `scripts/openspec-runner.mjs` when a compatible CLI is available.
- Preserves legacy AI Factory-only plan folders as compatibility and migration input only.
- Publishes namespaced Codex CLI and Claude agent files through the extension manifest for explicit user or orchestrator invocation.
- Publishes an optional `aifhub` MCP server whose settings are rendered by AI Factory per runtime.
- Ships an optional, opt-in context optimization service (`ai-factory aifhub-context-dedup` and MCP dedup tools) with `off | aifhub | sqz` modes. AIFHub serves unchanged same-session reads as a short replay, always returns protected validation artifacts in full, and invokes `sqz` only when the user explicitly supplies that third-party utility.
- Documents upstream project-context utilities such as `/aif-architecture`, `/aif-roadmap`, `/aif-docs`, `/aif-qa`, `/aif-archive`, and `/aif-distillation` with AIFHub write-boundary guardrails.
- Supports an optional protocol-neutral project glossary at `paths.context` (`CONTEXT.md` by default) for consistent prose terminology.
- Resolves human-readable response language as `language.ui` → current conversation → English only when indeterminate, without using OS locale or changing exact machine-output contracts. See [Usage](docs/usage.md#prompt-language-resolution).
- Does not install OpenSpec skills or slash commands.

## Quick Start

Install the extension:

```bash
ai-factory extension add https://github.com/ichinya/aifhub-extension.git
ai-factory update --force
ai-factory extension update aifhub-extension --force
```

Bootstrap project context:

```text
/aif-analyze
```

Inspect or switch artifact mode:

```text
/aif-mode status
/aif-mode openspec
/aif-mode sync
```

Confirm or request OpenSpec-native mode when bootstrapping a v1 OpenSpec workflow. The expected config marker is:

```yaml
aifhub:
  artifactProtocol: openspec
```

On first bootstrap, when `.ai-factory/config.yaml` is missing and you did not explicitly ask for OpenSpec-native mode, `/aif-analyze` asks which artifact protocol to use: `legacy AI Factory-only` or `OpenSpec-native`. Existing configs are preserved without that question. If the run is autonomous and cannot ask, it defaults to legacy AI Factory-only and reports OpenSpec-native mode as an open question.

Create and refine a change:

```text
/aif-plan full "add OAuth login"
/aif-improve add-oauth-login
/aif-mode sync --change add-oauth-login
```

Implement, check optional gates, verify, fix if needed, finalize, sync, commit, and optionally evolve:

```text
/aif-implement add-oauth-login
/aif-mode sync --change add-oauth-login
/aif-rules-check
/aif-review
/aif-security-checklist
/aif-verify add-oauth-login
/aif-fix add-oauth-login
/aif-verify add-oauth-login
/aif-mode doctor --change add-oauth-login
/aif-done add-oauth-login
/aif-mode sync
/aif-commit
/aif-evolve
```

Core AI Factory workflow:

```text
/aif-explore
/aif-plan full "..."
/aif-improve <change-id>
/aif-implement <change-id>
/aif-verify <change-id>
/aif-commit
/aif-evolve
```

OpenSpec validation overlay:

```text
/aif-mode sync --change <change-id>
/aif-rules-check
/aif-review
/aif-security-checklist
/aif-mode doctor --change <change-id>
/aif-done <change-id>
```

`/aif-done` finalizes the OpenSpec lifecycle. It archives the accepted OpenSpec change through the OpenSpec CLI when archive is required and writes final evidence under `.ai-factory/qa/<change-id>/` plus final summaries under `.ai-factory/state/<change-id>/`.

Installed projects can run the same bounded finalizer directly through the stable extension command:

```bash
ai-factory aifhub-done-finalizer --change <change-id> --json
```

Omitting `--change` delegates to the active-change resolver: exactly one resolvable active change may be selected, while missing or ambiguous scope exits with code `2` before finalization. Automation should always pass an explicit `--change <change-id>`.

Add `--skip-specs` only for docs/tooling-only work. The wrapper returns exit `0` after successful or policy-accepted warning finalization, `1` for a resolved readiness/archive blocker, and `2` for invalid arguments, unresolved or ambiguous scope, or an unexpected command failure. Do not run extension-internal `scripts/openspec-done-finalizer.mjs` from the project root or through an installed-extension path.

A dirty workspace is blocking by default before `/aif-done`. Inspect with `git status --short`; commit or stash unrelated changes, or rerun `ai-factory aifhub-done-finalizer --change <change-id> --record-dirty-state --json` when the current dirty state should be recorded in final QA evidence before archive.

It does not replace `/aif-commit`. After `/aif-done`, run `/aif-commit` or your normal git workflow to commit implementation changes, OpenSpec archive/spec changes, QA evidence, and final summaries.

### Optional Project Glossary

`/aif-analyze` can create or patch an optional `paths.context` glossary after explicit opt-in. Other commands consume it read-only for prose terminology; source/tests, OpenSpec requirements, rules, architecture decisions, identifiers, and QA facts remain authoritative. Missing `CONTEXT.md` never blocks a workflow. See [Context Loading Policy](docs/context-loading-policy.md) and [ADR 0002](docs/adr/0002-optional-project-context-glossary.md).

The config also records the aif-analyze skill version under `analyze.skill_version`. Before patching an existing config, `/aif-analyze` runs the read-only deterministic diff `ai-factory aifhub-analyze-config-diff --json`, which compares the config against the extension's required-keys manifest, reports what would be added and why, and takes a fast path when the config is already up to date.

### AI Factory 2.19 Reviewed Source Snapshot

AIFHub is source-reviewed against the AI Factory `2.x` snapshot at commit [`3c1ddd4740d7b1c30d8ecb3dc80fa5e7b8d7ef5a`](https://github.com/lee-to/ai-factory/commit/3c1ddd4740d7b1c30d8ecb3dc80fa5e7b8d7ef5a), whose package declares `2.19.0`, while retaining the compatibility range `>=2.11.0 <3.0.0`. At review time there was no `2.19.0` Git tag, GitHub release, or npm package, so this is a pinned source-compatibility result; `2.18.1` remains the last exact published-executable consumer-smoke baseline.

The seven-commit `2.18.1...3c1ddd4740d7` delta changes 16 files and is additive for AIFHub:

- `/aif-warmup` remains an upstream-owned, read-only session handoff. AIFHub ships no duplicate skill, command, or injection. Fresh AIFHub-created configs include `warmup.paths: []`; existing user-owned lists are preserved through mode switches and are never backfilled when absent.
- The upstream root `apm.yml` is a skills distribution surface. It does not replace the npm-installed AI Factory CLI or `ai-factory extension add/update` path required for AIFHub injections, wrapper commands, MCP templates, and managed agent files; AIFHub therefore adds no speculative APM package.
- The extension schema/loader, injection and MCP contracts, Node `>=18`, bin entrypoint, and dependency sets are unchanged, so no runtime adapter or compatibility-range increase is required.

The cumulative `2.16`/`2.17` behavior and `2.18.1` executable baseline remain supported, while the `2.18` line retains only bounded artifact/profile adapters:

- Planning preserves explicit input as immutable `## Original Request`; research-backed plans use a revision-bound `## Research Context` and report `WARN [research-drift]` instead of silently rebasing scope. See [Usage](docs/usage.md) and [Context Loading Policy](docs/context-loading-policy.md).
- Post-verify fixes use the same targeted regression check before and after the edit and keep the result as supporting runtime evidence; `/aif-verify` remains authoritative. See [Usage](docs/usage.md).
- `/aif-qa-check` consumes branch-scoped `test-cases.md` and writes branch-scoped `qa-check.md`; it does not satisfy AIFHub verify, coverage, done, or archive gates. See [OpenSpec Compatibility](docs/openspec-compatibility.md).
- AI Factory `2.16+` Universal / Other MCP rendering uses `.mcp.json` with `mcpServers`; older compatible runtimes are not promised this rendering. See [AIFHub MCP](docs/aifhub-mcp.md).
- `aif-analyze` may add a project-specific `Control Flow` base rule only when repository evidence supports it. Generated OpenSpec rules remain a separate derived layer.
- OpenSpec-native `ultra` planning is available only with a resolved AI Factory version `>=2.18.0`; it increases detail inside canonical `proposal.md`, `design.md`, `tasks.md`, and delta specs without creating `index.md`, `phase-*`, or `<!-- aif:plan-mode:ultra -->` under `openspec/changes/**`.
- Legacy classic pairs keep their companion workflow. A valid marked legacy ultra bundle is classified marker-first and handed to the matching upstream `/aif-improve`, `/aif-implement`, `/aif-verify`, `/aif-fix`, or `/aif-archive` owner without AIFHub companion writes.
- Regular research remains the single resolved `paths.research` file. Explicit AI Factory 2.18 ultra research is supporting context under `<parent(paths.research)>/research/<slug>/`, with marked `INDEX.md`, `RESEARCH.md`, and evidence-gated C4/ADR/graph files; it is never canonical OpenSpec content.
- AI Factory `2.18.1` keeps the new upstream-owned Research Coherence Gate inside `/aif-explore`. After a permitted persisted regular or ultra write, the AIFHub prepend passes through to that gate before presentation/session append; optional fresh-context `Task` delegation may fall back to the same direct read-only checks, and ultra coherence runs before the Bundle Integrity Gate.
- After upstream verification of a marked legacy ultra bundle, only `/aif-verify` may record a revision-bound receipt under `.ai-factory/state/legacy-ultra-verification/`. `/aif-done` and packaged agents re-evaluate its bundle, revision, worktree, entrypoint, and exact `pass` gate before returning `/aif-archive <entrypoint>`; every missing, stale, wrong, or non-pass receipt returns `/aif-verify <entrypoint>`.
- The OpenSpec-native `/aif-archive` guard routes plan-mutating targets to `/aif-done <change-id>` before plan discovery while retaining upstream read-only `list` and bounded roadmap-only behavior. Legacy classic and marked ultra archive behavior stays upstream-owned.
- The reviewed `2.17.0...2.18.0` runtime surface keeps the extension schema/loader, injection/MCP APIs, Node `>=18`, bin, and dependencies unchanged. The cumulative `2.18.0...2.18.1` patch is prompt/docs-only apart from package/test metadata and does not change that runtime/API conclusion. Completed-phase `/aif-loop`, privacy-gated `/aif-transfer`, and skills.sh documentation are explicit reviewed no-ops; AIFHub ships no duplicate loop/transfer skill or injection.

The full tag audit, ownership ledger, and reviewed no-ops are recorded in [OpenSpec Compatibility](docs/openspec-compatibility.md): upstream architecture refinements remain upstream-owned, generated-rules compilation is not duplicated, community-extension docs are not copied, and legacy custom fix-plan cleanup remains upstream-owned.

AI Factory 2.13+ owns generic active plan `## Commit Plan` grouping in `/aif-commit`. AIFHub must not duplicate that grouping logic, and `/aif-commit` remains the only commit owner; `/aif-done` finalizes OpenSpec lifecycle evidence but does not create git commits.

The AIFHub `aif-commit` injection is only a read-only roadmap/GitHub freshness overlay. In OpenSpec-native mode, if an active OpenSpec change is available, commit planning should use `openspec/changes/<change-id>/tasks.md` as the source that may contain `## Commit Plan`. If no active change/plan resolves, keep upstream staged-diff behavior.

AI Factory 2.13+ includes `/aif-distillation`. It is an upstream utility skill for turning books, docs, folders, or URLs into reusable Agent Skills. It is not an AIFHub lifecycle stage, does not create OpenSpec changes, and must not write `openspec/changes/**`, `openspec/specs/**`, `.ai-factory/qa/**`, or `.ai-factory/rules/generated/**`. It writes generated skill packages to the current agent skills directory.

Upstream project-context utilities remain available with AIFHub guardrails. `/aif-architecture` writes project-level architecture context at `paths.architecture` plus limited pointers in `paths.description` and root `AGENTS.md`. `/aif-docs` writes the root `README.md`, the configured `paths.docs` directory, and documentation entries in `AGENTS.md`. `/aif-qa` writes upstream manual QA artifacts under `paths.qa/<branch-slug>/`, distinct from AIFHub verification/finalization evidence under `.ai-factory/qa/<change-id>/`. These commands are not required per-change OpenSpec lifecycle gates and must not create canonical OpenSpec changes/specs, generated rules, or AIFHub runtime evidence.

AI Factory 2.14+ includes upstream `/aif-archive` and `paths.archive`, with default archive root `.ai-factory/archive/`. In legacy mode it owns classic plan cleanup and, in 2.18, marked ultra bundle archive. In OpenSpec-native mode the AIFHub prepend guard stops every plan-mutating target before plan discovery and returns `/aif-done <change-id>`; read-only `list` and bounded roadmap-only snapshots remain upstream submodes. `/aif-archive` never becomes an alias for `openspec archive` and must not write OpenSpec canonical, QA, state, or generated-rule artifacts.

AI Factory 2.15+ preserves managed agent config files during update/init workflows and can offer newly available built-in skills interactively during update. AIFHub documents this as upstream installer/update behavior only; it does not make AIFHub the owner of OpenSpec canonical artifacts, generated rules, or project-specific agent config files.

Useful AIFHub source examples:

```text
/aif-distillation docs/memory-tools-research --name aifhub-memory-tool-selection
/aif-distillation docs/context-providers.md --name aifhub-context-providers
```

Validation gates:

- Optional before verify in relaxed/manual workflow.
- Required before `/aif-done` when done policy requires durable gate evidence.

- `/aif-rules-check` - read-only rules compliance.
- `/aif-review` - read-only code review.
- `/aif-security-checklist` - read-only security gate.
- `/aif-mode doctor` - mode/config/artifact readiness.
- `/aif-mode sync` - derived artifact refresh and OpenSpec validation/status when available.

## Bug Fix Workflows

OpenSpec-native mode has two distinct bug-fix workflows.

### Workflow A: New Bug Report

A new bug report starts as planned OpenSpec work:

```text
/aif-plan full "fix <bug description>"
/aif-improve <change-id>
/aif-mode sync --change <change-id>
/aif-implement <change-id>
/aif-rules-check                  # optional
/aif-verify <change-id>
/aif-done <change-id>
/aif-mode sync
/aif-commit
```

- A bug fix is still an OpenSpec change when it changes product or workflow behavior.
- Create delta specs when behavior changes.
- Docs/tooling-only bug fixes may omit delta specs only when the proposal explains why no product or workflow behavior changes.
- Missing OpenSpec CLI means degraded validation, not planning failure.
- No OpenSpec-native bug-fix path creates `.ai-factory/plans/<id>/`.

### Workflow B: Fix After Failed Verification

`/aif-fix` is for findings inside an existing active OpenSpec change:

```text
/aif-verify <change-id> -> fail
/aif-fix <change-id>
/aif-mode sync --change <change-id>     # optional if canonical artifacts changed
/aif-rules-check                        # optional
/aif-verify <change-id>
```

- `/aif-fix` requires existing QA evidence or selected findings.
- `/aif-fix` does not create a new OpenSpec change.
- `/aif-fix` writes fix traces under `.ai-factory/state/<change-id>/fixes/`.
- `/aif-fix` does not write QA verdicts.
- `/aif-fix` does not archive.
- `/aif-fix` routes back to `/aif-verify <change-id>`.
- No OpenSpec-native bug-fix path creates `.ai-factory/plans/<id>/`.

## Artifact Layout

OpenSpec-native v1 uses this ownership model in user projects:

```text
openspec/
  specs/
    <capability>/spec.md
  changes/
    <change-id>/
      proposal.md
      design.md
      tasks.md
      specs/
        <capability>/spec.md

.ai-factory/
  state/
    <change-id>/
      implementation/
      fixes/
      final-summary.md
      migration-report.md
  qa/
    <change-id>/
      verify.md
      coverage.json
      openspec-validation.json
      openspec-status.json
      openspec-archive.json
      done.md
      raw/
  rules/
    generated/
      openspec-base.md
      openspec-change-<change-id>.md
      openspec-merged-<change-id>.md
      openspec-rules-trace-<change-id>.json
      index.json
```

| Path | Ownership |
|---|---|
| `openspec/specs` | Canonical current behavior |
| `openspec/changes` | Canonical proposed changes |
| `.ai-factory/state` | Runtime execution traces and summaries |
| `.ai-factory/qa` | Verification and finalization evidence |
| `.ai-factory/rules/generated` | Derived rules, safe to regenerate |
| `.ai-factory/plans` | Legacy compatibility and migration input only |

The `aifhub-extension` package repository stays artifact-light. Root `openspec/`, `.ai-factory/state/`, `.ai-factory/qa/`, `.ai-factory/plans/`, and `.ai-factory/rules/generated/` are created in user projects and are not shipped as extension package content. Root `.ai-factory/rules/generated/` is derived and safe to regenerate. OpenSpec examples in this repo belong only under fixture paths such as `test/fixtures/` or `scripts/fixtures/`; extension behavior requirements are validated by prompt contracts and tests, not by committed root OpenSpec specs.

## Manifest And Metadata

`extension.json` is the strict upstream AI Factory extension manifest. It declares:

```json
"$schema": "https://raw.githubusercontent.com/lee-to/ai-factory/2.x/schemas/extension.schema.json"
```

AIFHub-owned metadata lives in `aifhub-extension.json` and is validated by `schemas/aifhub-extension.schema.json`. This keeps private fields such as `compat` and `sources` out of the upstream manifest while preserving local compatibility and provenance checks.

## OpenSpec Compatibility

OpenSpec is optional for extension install and AI Factory-only workflows.

| Capability | Requirement |
|---|---|
| AI Factory extension install/use | `ai-factory >=2.11.0 <3.0.0` from `aifhub-extension.json -> compat.ai-factory` |
| OpenSpec-native validation/archive | OpenSpec CLI `>=1.3.1 <2.0.0` |
| OpenSpec CLI runtime | Node `>=20.19.0` |
| OpenSpec skills/commands | Not installed by this extension |

The reviewed OpenSpec baseline is OpenSpec `1.10.0`, replayed sequentially from baseline `1.3.1` and including prerelease `1.6.0-beta.1`, while the compatible stable CLI range remains `>=1.3.1 <2.0.0`. The `1.10.0` checkpoint is bound independently to official Git tag `v1.10.0` at commit `1ebddd17f40dde15dfd28289e4493c3cf05ee9df` and to checksum-verified npm package `@fission-ai/openspec@1.10.0`; this is local exact-package evidence, not CI or production evidence. See [OpenSpec Compatibility](docs/openspec-compatibility.md) for the reviewed-release ledger, exact CLI matrix, and adapter-only ownership notes.

OpenSpec `validate --archived` is advisory-only. It is not part of package validation scripts, tracked CI, the shared runner's current-change validation argv, `/aif-verify`, `/aif-done`, or the release acceptance PASS boolean. OpenSpec `1.11.0` is outside this reviewed checkpoint and receives no compatibility claim here.

When the OpenSpec CLI is missing or unsupported, OpenSpec-aware commands report degraded validate/archive capabilities. Planning and filesystem-based context loading can continue, but archive-required `/aif-done` fails until a compatible CLI is available.

For each OpenSpec operation, the shared resolver selects exactly one CLI source in this order: an explicit non-empty extension API `options.command`, project-local `node_modules/.bin/openspec` (`openspec.cmd` on Windows), then `openspec` from `PATH`. An explicit or project-local selection is authoritative: a failure never silently falls through to another installation. AIFHub does not use `npx`, search parent projects, download, or auto-install OpenSpec. Diagnostics expose only the bounded command plus `explicit`, `project-local`, or `path` source.

If the OpenSpec CLI is present but outside `>=1.3.1 <2.0.0`, update or reinstall the CLI before relying on validation/archive. The bootstrap still reports this as degraded capability rather than an install failure.

OpenSpec CLI integration is adapter-only: users keep calling `/aif-plan`, `/aif-improve`, `/aif-implement`, `/aif-verify`, `/aif-done`, and `/aif-mode`; the extension never installs OpenSpec command skills.

OpenSpec can be initialized without tool integrations:

```bash
openspec init --tools none
```

That command is optional and is not run by the extension installer.

See [OpenSpec Compatibility](docs/openspec-compatibility.md) for supported versions, capability flags, and degraded-mode behavior.

## Legacy Migration

Existing `.ai-factory/plans` artifacts are legacy AI Factory-only records. Migrate them explicitly before using the OpenSpec-native flow for that work:

```bash
ai-factory aifhub-migrate-legacy-plans --list
ai-factory aifhub-migrate-legacy-plans <change-id> --dry-run
ai-factory aifhub-migrate-legacy-plans <change-id>
```

Migration applies only to classic plan shapes. Valid `<!-- aif:plan-mode:ultra -->` bundles remain upstream-owned and are reported as skipped; malformed ultra-like shapes and classic/ultra collisions fail closed. When mode switching leaves unresolved legacy work, AIFHub records the safe project-relative source root in `.ai-factory/state/legacy-plan-source.json`; later discovery uses that captured root (or explicit `--legacy-source <dir>`) and rejects roots that overlap canonical `openspec/changes`.

The migration writes canonical artifacts under `openspec/changes/<change-id>/`, preserves runtime material under `.ai-factory/state/<change-id>/`, preserves QA material under `.ai-factory/qa/<change-id>/`, and never silently deletes legacy source files.

See [Legacy Plan Migration](docs/legacy-plan-migration.md) for collision modes, validation behavior, and the full artifact map.

## Mode Switching

`/aif-mode` is the extension-owned mode controller:

```text
/aif-mode status
/aif-mode openspec
/aif-mode ai-factory
/aif-mode sync
/aif-mode doctor
```

Switching to OpenSpec-native mode updates `.ai-factory/config.yaml`, ensures `openspec/config.yaml`, `openspec/specs/`, `openspec/changes/`, `.ai-factory/state/`, `.ai-factory/qa/`, and `.ai-factory/rules/generated/`, detects legacy plans, compiles generated rules, validates changes when a compatible CLI is available, and writes a report under `.ai-factory/state/mode-switches/`.

Generated-rule sync reconciles the complete active OpenSpec inventory separately from the selected compilation scope. It prepares the whole batch before mutation, prunes only exact compiler-owned direct-child overlays for archived changes, preserves unknown files, and reports bounded project-relative `remove`/`would-remove` operations. `status` and `doctor` stay non-green for orphan membership, missing active entries, malformed index data, or managed-name collisions until sync succeeds.

Switching to AI Factory-only mode updates the legacy path profile and preserves `openspec/`. Use `--export-openspec` only when compatibility legacy artifacts are needed from OpenSpec changes.

## Troubleshooting

| Symptom | Action |
|---|---|
| OpenSpec CLI missing | Continue in degraded mode for planning or install a compatible `openspec` CLI before validation/archive-required finalization. |
| Node too old | Use Node `>=20.19.0` for OpenSpec validation/archive. |
| Invalid delta spec | Fix `openspec/changes/<change-id>/specs/**/spec.md`, then rerun `/aif-verify <change-id>`. |
| Ambiguous active change | Pass an explicit `<change-id>` or update `.ai-factory/state/current.yaml`. |
| Missing or stale generated rules | Regenerate derived rules from OpenSpec specs before relying on rules guidance. |
| Orphaned generated rules after archive | Run `/aif-mode sync` (or `--all` for a full active sweep); inspect `generated-rules-invalid` before retrying if unsafe metadata or a managed-name collision blocks cleanup. |
| Missing or stale coverage | Rerun `/aif-verify <change-id>` to refresh `.ai-factory/qa/<change-id>/coverage.json` before `/aif-done`. |
| Dirty working tree before `/aif-done` | Inspect with `git status --short`; commit or stash unrelated changes, or rerun `ai-factory aifhub-done-finalizer --change <change-id> --record-dirty-state --json` to record the dirty workspace in final QA evidence before archive. |

## Documentation

| Guide | Description |
|---|---|
| [Documentation Index](docs/README.md) | Reading order and docs map |
| [Usage](docs/usage.md) | Full command flow, AI Factory 2.19 session warmup, read/write boundaries, upstream project-context utilities, examples, and troubleshooting |
| [Context Providers](docs/context-providers.md) | Optional Graphify and Context7 provider guidance, reviewed-note paths, degraded behavior, and user-owned setup boundaries |
| [Memory Tool Recommendations](docs/memory-tool-recommendations.md) | Local metadata-driven optional memory/context tool recommendations and installed wrapper commands |
| [Context Loading Policy](docs/context-loading-policy.md) | Consumer context, AI Factory 2.19 upstream warmup, Optional Project Glossary, optional provider context, GitHub-aware roadmap evidence, command ownership, upstream utility boundaries, and legacy boundaries |
| [OpenSpec Compatibility](docs/openspec-compatibility.md) | Optional CLI adapter policy, exact-tagged OpenSpec `1.10.0` reviewed baseline from `1.3.1`, pinned AI Factory 2.19 source snapshot, AI Factory 2.18 classic/ultra planning, research, verification, archive and ownership matrix, reviewed no-ops, and capability flags |
| [OpenSpec Artifact Validation](docs/openspec-validation.md) | Read-only AIFHub contract validator for OpenSpec-native artifacts |
| [OpenSpec Coverage Matrix](docs/spec-coverage.md) | Requirement-to-code coverage artifact and verify/done policy |
| [Legacy Plan Migration](docs/legacy-plan-migration.md) | Explicit migration from legacy plans to OpenSpec-native changes |
| [Active Change Resolver](docs/active-change-resolver.md) | Active change selection and runtime paths |
| [ADR 0001](docs/adr/0001-openspec-native-artifact-protocol.md) | v1 artifact ownership decision |
| [ADR 0002: Optional Project Glossary](docs/adr/0002-optional-project-context-glossary.md) | Configurable `CONTEXT.md`, lexical authority, and deferred OKF |
| [AIFHub MCP](docs/aifhub-mcp.md) | Optional MCP server tools, runtime-specific settings shapes, and AI Factory 2.16+ Universal / Other rendering |
| [Codex Agents](docs/codex-agents.md) | Namespaced Codex CLI agent files |
| [Claude Agents](docs/claude-agents.md) | Namespaced Claude agent files |

## Validation

Run the local checks:

```bash
npm run validate
npm test
```

`npm run validate` checks the upstream `extension.json` manifest, AIFHub metadata in `aifhub-extension.json`, Codex/Claude agent schemas, and markdown links under `docs/`, `injections/`, and `skills/`. Root `README.md` links should be checked manually when edited.

## Update Behavior

- The reviewed AI Factory source declaring `2.19.0` is not a published update target at this checkpoint; no `2.19.0` tag/npm artifact or executable update PASS is claimed.
- `ai-factory update --force` is the global exact `2.17.0`-to-`2.18.1` project refresh used by the consumer contract: it refreshes selected built-in skills and managed extensions, then reapplies injections. Stable `2.18.0` remains the ultra/transfer feature boundary.
- `ai-factory extension update aifhub-extension --force` is the exact targeted refresh and must not be treated as evidence that unrelated extensions were updated.
- `ai-factory upgrade` is the v1-to-v2 skill-name migration command; it is not the 2.17.0-to-2.18.1 update path.
- `npm test` includes an offline deterministic consumer harness with injected exact `2.17.0`/`2.18.1` executors while retaining the public 2.18 smoke command and flag names. `npm run smoke:ai-factory-2-18 -- <explicit local toolchain arguments>` is a separate opt-in live driver: missing prerequisites are `NOT_RUN`, it never downloads a toolchain, and local success is not release, deployment, registry, or end-user migration proof.
- `ai-factory extension remove aifhub-extension` returns the workflow to upstream AI Factory behavior.

## License

MIT
