[Предыдущая страница](context-loading-policy.md) | [К документации](README.md) | [Следующая страница](openspec-validation.md)

# OpenSpec Compatibility

OpenSpec is an optional CLI adapter for the v1 OpenSpec-native artifact protocol.

AIFHub Extension can create and consume OpenSpec-native filesystem artifacts without a local OpenSpec CLI. Validation and archive operations require a compatible CLI.

OpenSpec-native mode uses this layering:

```text
OpenSpec artifacts = canonical truth
OpenSpec CLI = validator / status / instructions / archive adapter
AIFHub skills = UX and orchestration
AI Factory = execution runtime
```

## Supported Versions

| Capability | Requirement |
|---|---|
| AI Factory extension install/use | `ai-factory >=2.11.0 <3.0.0` |
| OpenSpec-native validation/archive | OpenSpec CLI `>=1.3.1 <2.0.0` |
| OpenSpec CLI runtime | Node `>=20.19.0` |
| OpenSpec skills/commands | Not installed by this extension |

AI Factory-only workflows follow AI Factory's runtime support. OpenSpec validation/archive follows the OpenSpec CLI runtime requirement.

## OpenSpec 1.8.0 Reviewed Baseline

AIFHub metadata records OpenSpec `1.8.0` as the latest reviewed upstream baseline while keeping the supported stable CLI range `>=1.3.1 <2.0.0`.

- Baseline `1.3.1` is the first supported and reviewed release.
- Reviewed stable releases: `1.3.1`, `1.4.0`, `1.4.1`, `1.5.0`, `1.6.0`, `1.7.0`, `1.8.0`.
- Reviewed prereleases: `1.6.0-beta.1`. A prerelease review does not imply production support; prerelease detection remains unavailable for production capabilities.

| Release | Channel | Adapter result | Checked AIFHub surfaces | Required adaptation |
|---|---|---|---|---|
| `1.3.1` | stable | supported baseline | version detection and existing validate/archive adapter contract | baseline |
| `1.4.0` | stable | supported | `--version`, validate JSON, status JSON, spec show JSON, apply instructions JSON, archive flags | reviewed-release metadata and no-op ownership documentation |
| `1.4.1` | stable | supported | `--version`, validate JSON, status JSON, spec show JSON, apply instructions JSON, archive flags | `openspec update` remains upstream-owned |
| `1.5.0` | stable | supported | `--version`, validate/status/show/instructions JSON including additive `root`, archive flags, store help | forward-compatible JSON regression and Stores ownership boundary |
| `1.6.0-beta.1` | prerelease | reviewed but unsupported | exact CLI validate/status/show/instructions smoke, archive flags, invalid-change archive exit | preserve stable-only production gate; no prerelease support claim |
| `1.6.0` | stable | supported | exact CLI validate/status/show/instructions JSON, archive flags, invalid-change archive exit | stable ledger advancement; beta-to-stable code diff only changes version/changelog |
| `1.7.0` | stable | supported | exact CLI native `skip_specs: true`, `openspec instructions archive --change <id> --json`, leading-digit IDs, nested spec folders, standard command smoke | native metadata reader for artifact/sync gates plus focused no-op regressions for already-compatible surfaces |
| `1.8.0` | stable | supported | exact CLI capability retirement, scenario-loss validation, nested task progress, non-TTY archive guidance, and standard command smoke | version-gated retirement planning plus fail-closed and nested-task regressions; agent targets remain upstream-owned |

Reviewed upstream behavior:

- OpenSpec `1.8.0` allows explicitly destructive capability retirement through `retire_capabilities: true`. AIFHub planning writes this native marker only when the selected CLI is `>=1.8.0` and the user explicitly authorizes retirement; it must not infer retirement merely from an empty resulting capability.
- OpenSpec `1.8.0` moves scenario loss detection into validation and names omitted scenarios. AIFHub already fails closed on non-zero validation and now has a regression that preserves the upstream path and diagnostic in QA evidence.
- OpenSpec `1.8.0` counts nested task progress. AIFHub's recursive task-line parser already counts indented checkboxes, with a focused regression covering that no-op compatibility result.
- The vendor-neutral agents target (`agents`), MiniMax Code, Rovo Dev CLI, opt-in Copilot cloud-agent files, and generated agent assets remain OpenSpec-owned. AIFHub does not generate or manage those targets.
- OpenSpec `1.7.0` makes `.openspec.yaml` with `skip_specs: true` the native declaration for changes without spec deltas. AIFHub honors it in the artifact contract and in `/aif-mode sync --all`; an invalid marker is sent through validation instead of being silently skipped. The older proposal reason remains the compatibility path for pre-1.7 CLIs and already-authored plans.
- OpenSpec `1.7.0` adds project context to `instructions apply|archive`; the shared runner now has an explicit regression for `openspec instructions archive --change <id> --json` while final archive mutation remains owned by the installed AIFHub finalizer wrapper.
- Change IDs with leading digits, nested spec folders, and UTF-8 BOM input are supported upstream. AIFHub's resolver already accepts numeric-leading IDs, recursive spec discovery already handles nested folders, and the pre-1.7 status rejection remains a bounded compatibility fallback only when status actually fails.
- OpenSpec `1.6.0` promotes the reviewed beta behavior to stable, including consistent resolution and task progress for nested specs and task files. The beta-to-stable source diff contains only release metadata and changelog updates, so no additional AIFHub command rewrite is required.
- OpenSpec `1.6.0-beta.1` converges validate, view, and archive resolution, and archive validation failures return a non-zero exit code. AIFHub's existing non-zero fail-closed handling remains compatible.
- The prerelease adds `/opsx:update`, Oh My Pi and Trae adapters, automatic OpenSpec CLI permission in generated skills, unified requirement parsing, archive scenario-drift fixes, and empty Store registration. Those integrations and generated skills remain upstream-owned.
- OpenSpec `1.5.0` introduces Stores in very early beta, fixes config parsing for values wrapped in JSON containers, and escapes carriage returns in generated YAML frontmatter for CRLF-authored values.
- OpenSpec `1.5.0` adds an additive `root` field to JSON command results. AIFHub parses additive fields without requiring a closed response schema, so no command or prompt rewrite is required.
- OpenSpec `1.4.1` fixes `openspec update` for projects that already have their own `workspace.yaml`.
- OpenSpec `1.4.0` includes Kimi CLI support, Mistral Vibe support, sync skills by default through `/opsx:sync`, case-insensitive requirement headers, and clearer validation hints.
- OpenSpec workspace beta view state is OpenSpec-owned and lives under `.openspec-workspace/view.yaml`.

AIFHub remains adapter-only: it does not install or manage OpenSpec skills, `/opsx:*` commands, tool integrations, agent targets, Stores, OpenSpec workspace beta state, or `openspec update`. In particular, it does not install or manage Kimi CLI or Mistral Vibe integrations. It also does not install or manage MiniMax Code or Rovo Dev CLI integrations. The default Store, self-upgrade flow, tool command names, config parsing, and generated command/frontmatter content remain upstream-owned. AIFHub does not own OpenSpec workspace beta state and does not run or manage `openspec update`.

`openspec update` is upstream OpenSpec behavior. `/aif-mode sync` compiles AIFHub generated rules and requests OpenSpec validate/status through the adapter when configured and available.

## Опциональная Инициализация

Projects may initialize OpenSpec without tool integrations:

```bash
openspec init --tools none
```

This is optional. The extension installer does not run it.

OpenSpec skills and slash commands are not installed by this extension.

This initialization is for user projects. The `aifhub-extension` package repository does not ship root `openspec/` or root `.ai-factory/rules/generated/` content; generated rules are derived in user projects and safe to regenerate. OpenSpec examples in this repo belong only under fixture paths, and extension behavior requirements are validated by prompt contracts and tests instead of committed root OpenSpec specs.

## Artifact Protocol Profiles

The selected `aifhub.artifactProtocol` owns its active config profile. Legacy AI Factory-only mode does not add OpenSpec settings or OpenSpec runtime paths:

```yaml
aifhub:
  artifactProtocol: ai-factory

paths:
  context: CONTEXT.md
  plans: .ai-factory/plans
  specs: .ai-factory/specs
  rules: .ai-factory/rules

utilities:
  context_tools:
    enabled: []
  graphify:
    enabled: false
    uv_check: uv --version
    install: uv tool install graphifyy
    activate: graphify install
    report_command: graphify .
  codegraph:
    enabled: false
    command: codegraph
    status: codegraph status
    init: codegraph init .
    index: codegraph index --quiet .
    query: codegraph query --path . --limit 10 --json
    purge: codegraph uninit --force .
```

OpenSpec-native mode adds the OpenSpec settings and runtime path profile shown below.

## OpenSpec-Native Config

OpenSpec-native mode is selected through `.ai-factory/config.yaml`:

```yaml
aifhub:
  artifactProtocol: openspec
  openspec:
    root: openspec
    installSkills: false
    validateOnPlan: true
    validateOnImprove: true
    validateOnVerify: true
    statusOnVerify: true
    archiveOnDone: true
    useInstructionsApply: true
    compileRulesOnSync: true
    validateOnSync: true
    requireCliForPlan: false
    requireCliForImprove: false
    requireCliForVerify: false
    requireCliForDone: true
    requireGeneratedRulesForVerify: false
    requireGeneratedRulesForDone: true
    requireRulesPassForVerify: false
    requireRulesPassForDone: true
    requireSpecCoverageForVerify: false
    requireSpecCoverageForDone: true
    allowWarnOnDone:
      rules: false
      coverage: false
      openspecStatus: true

paths:
  context: CONTEXT.md
  plans: openspec/changes
  specs: openspec/specs
  state: .ai-factory/state
  qa: .ai-factory/qa
  generated_rules: .ai-factory/rules/generated

utilities:
  graphify:
    enabled: false
    uv_check: uv --version
    install: uv tool install graphifyy
    activate: graphify install
    report_command: graphify .
```

`paths.context` is protocol-neutral and defaults to `CONTEXT.md`. Both profiles render the default or preserve a custom project-relative value; neither profile requires, creates, validates, or imports the optional glossary file. `/aif-analyze` owns opt-in creation and patch updates, while all other commands are read-only consumers.

`installSkills: false` задан намеренно. AIFHub Extension использует OpenSpec artifacts и `scripts/openspec-runner.mjs` как optional CLI adapter, а не OpenSpec-installed skills или slash commands.

Секция `utilities` protocol-neutral. Она хранит только optional tool preferences. `utilities.context_tools.enabled` хранит user-accepted provider ids из `/aif-analyze`; follow-on skills вызывают `ai-factory aifhub-memory-tools select --from-project --command <skill> --json` и используют только `selected_tools`. Graphify остается manually installed/activated/run пользователем. CodeGraph остается manual CLI-only и может использоваться `/aif-explore` только когда выбран CLI, с purge перед завершением.

`paths.archive` is an upstream AI Factory legacy plan archive path. AIFHub documents the upstream default `.ai-factory/archive/`, but OpenSpec-native canonical archive/finalization does not use `paths.archive`; it remains under OpenSpec CLI archive behavior, accepted specs in `openspec/specs/**`, and AIFHub evidence under `.ai-factory/qa/<change-id>/` plus `.ai-factory/state/<change-id>/`.

On first bootstrap, `/aif-analyze` may create the OpenSpec marker after asking for the artifact protocol. If `.ai-factory/config.yaml` is missing and the user did not explicitly request OpenSpec-native mode, interactive runtimes ask the user to choose `legacy AI Factory-only` or `OpenSpec-native` before writing the config. Existing configs are preserved without prompting. Autonomous/subagent runs do not ask; they default to legacy AI Factory-only and report OpenSpec-native mode as an open question.

Localization preferences collected before this choice are carried as pending config values and written only after the artifact protocol is resolved.

Action toggles such as `validateOnPlan`, `validateOnImprove`, `validateOnVerify`, `statusOnVerify`, `archiveOnDone`, `compileRulesOnSync`, and `validateOnSync` decide which operations are attempted. Policy flags such as `require*` and `allowWarnOnDone` decide whether missing, stale, failed, or warning-only evidence blocks a command.

The defaults keep planning and verification degraded-friendly while making `/aif-done` strict: verify can warn on missing CLI, generated rules, rules gate evidence, or coverage evidence; done requires current generated rules, a passing durable rules gate, current passing coverage, and archive-capable CLI unless config relaxes those requirements.

## Workflow Plan ID Policy

OpenSpec-native mode uses OpenSpec `change-id` values and ignores AI Factory `workflow.plan_id_format` for canonical artifact names. The active change directory stays `openspec/changes/<change-id>/` whether upstream AI Factory is configured for `slug` or `sequential` legacy plan IDs.

Legacy AI Factory-only mode follows upstream `workflow.plan_id_format`. Use `slug` for slug-named plan files, or `sequential` for upstream sequential filenames under `paths.plans`.

When legacy AI Factory-only mode uses `sequential`, upstream `/aif-archive` excludes archived files under `paths.archive/plans/` from active plan discovery and from the next sequential number calculation. OpenSpec-native `change-id` directories remain non-sequential and are not renamed to `NNNN_` plan files.

In short: archived legacy plans are excluded from active plan discovery, while OpenSpec-native active changes remain `openspec/changes/<change-id>/` directories.

## AIFHub Wrapper Behavior

| AIFHub command | OpenSpec CLI feature |
|---|---|
| `/aif-analyze` | optional `openspec init --tools none` guidance or filesystem skeleton |
| `/aif-plan full` | `openspec validate <change>` when `validateOnPlan` is enabled; CLI absence blocks only when `requireCliForPlan` is true |
| `/aif-improve` | `openspec validate <change>` when `validateOnImprove` is enabled; CLI absence blocks only when `requireCliForImprove` is true |
| `/aif-implement` | `openspec instructions apply --change <id>` when `useInstructionsApply` is enabled and CLI is available |
| `/aif-verify` | `openspec validate`, optional `openspec status` evidence, policy-derived diagnostics, coverage, and final `aif-gate-result` with `"gate": "verify"` |
| `/aif-rules-check` | Upstream rules gate plus AIFHub generated-rules overlay for OpenSpec specs/deltas |
| `/aif-roadmap check` | Local lifecycle reconciliation plus optional current GitHub phase evidence; no OpenSpec CLI mutation |
| `/aif-done` | AIFHub artifact contract check, then `openspec archive <change> --yes` when archive is required, then one bounded linked-roadmap transition |
| `/aif-commit` | Read-only local lifecycle and optional GitHub freshness gate before the upstream git commit flow |
| `/aif-mode sync` | generated-rule compile plus validate/status according to sync flags; generated-rule compilation may call `openspec show <item> --json` through `scripts/openspec-rules-compiler.mjs` and `showOpenSpecItem()` |
| `/aif-mode doctor` | CLI, Node, active change, effective policy, generated rules, latest verify gate, rules gate, coverage, AIFHub artifact contract, and archive readiness diagnostics |

Do not route users to OpenSpec slash commands such as `/opsx:propose`, `/opsx:apply`, or `/opsx:archive`.

## Roadmap Linkage and Lifecycle Compatibility

OpenSpec-native proposals use one standardized `## Roadmap Linkage` section with `Issues`, `Milestone`, `Roadmap item/slice`, and `Rationale`. Values come from explicit user or canonical planning input; unavailable assignments remain explicit `none` and are not inferred from GitHub titles, labels, branches, or unrelated roadmap text. A linked active change is registered as local `planned` by `/aif-roadmap check`.

The configured roadmap may contain one marker-bounded local table:

```markdown
<!-- aifhub:roadmap-change-lifecycle:start -->
## OpenSpec Change Lifecycle
...
<!-- aifhub:roadmap-change-lifecycle:end -->
```

The table stores only local `planned` and `finalized` states. `/aif-roadmap` owns the complete roadmap and managed-block reconciliation. `/aif-done` co-owns only one linked transition to `finalized`, and only after successful OpenSpec archive; failed readiness, verification, artifact-contract, dirty-tree, or archive paths do not write the roadmap. If archive succeeds but the marker-bounded update fails, finalization reports archive success plus a roadmap `handoff`, does not roll back archive, and returns `/aif-roadmap check`.

`/aif-commit` reads this local lifecycle state but never writes it. Durable successful finalization with a missing or non-`finalized` linked row is deterministic local drift and blocks commit before the upstream proposal; user confirmation cannot bypass it. Missing, partial, or later-changing GitHub evidence is external drift and remains warning-only by default.

GitHub open/closed/merged state stays outside the managed block. A post-merge `/aif-roadmap check` refreshes current issue, PR, and milestone evidence while retaining the evidence-backed local `finalized` row. Remote merge or closure never becomes local finalization proof, and credentials or private authentication diagnostics are never persisted in roadmap output.

## AI Factory 2.12 Optional Artifact Audit Bridge

AI Factory 2.12+ provides an optional read-only artifact audit command that can inspect OpenSpec and AIFHub runtime evidence together:

```bash
ai-factory audit-artifacts openspec .ai-factory/qa .ai-factory/state --json
```

This audit bridge is diagnostic-only for AIFHub Extension. It may supplement `/aif-mode doctor` output when available, but it is not mandatory, not archive-blocking, and not a replacement for AIFHub generated rules, coverage, rules gate, verify gate, or OpenSpec archive readiness checks.

## AI Factory 2.13 Commit Plan and Distillation

AI Factory 2.13+ owns generic active plan `## Commit Plan` grouping in `/aif-commit`. AIFHub must not duplicate parent grouping logic. The AIFHub `aif-commit` injection remains a read-only roadmap/GitHub freshness overlay, and `/aif-commit` remains the only commit owner.

In OpenSpec-native mode, an active `openspec/changes/<change-id>/tasks.md` file may be the plan source that contains `## Commit Plan`. If no active change/plan resolves, AIFHub keeps upstream staged-diff behavior. When upstream detects the plan, AIFHub must preserve the upstream grouping prompt and options such as `Follow Commit Plan`, `Commit everything together`, and `Adjust grouping`.

AI Factory 2.13+ includes `/aif-distillation`. It is an upstream utility skill for turning books, docs, folders, or URLs into reusable Agent Skills. It is not an AIFHub lifecycle stage, does not create OpenSpec changes, and must not write `openspec/changes/**`, `openspec/specs/**`, `.ai-factory/qa/**`, or `.ai-factory/rules/generated/**`. It writes generated skill packages to the current agent skills directory.

Examples:

```text
/aif-distillation docs/memory-tools-research --name aifhub-memory-tool-selection
/aif-distillation docs/context-providers.md --name aifhub-context-providers
```

## Upstream Project-Context Utilities

Upstream `/aif-architecture`, `/aif-docs`, `/aif-qa`, and `/aif-roadmap` remain project-context utilities with AIFHub guardrails. They are not required per-change OpenSpec lifecycle gates.

- `/aif-architecture` owns project-level architecture context generation at `paths.architecture`, plus the architecture pointer in resolved `paths.description` and the architecture row in root `AGENTS.md`.
- `/aif-docs` owns the root `README.md`, the resolved `paths.docs` directory, generated docs site output when explicitly requested, and the Documentation section in `AGENTS.md`.
- `/aif-qa` owns upstream manual QA artifacts under `paths.qa/<branch-slug>/`, including `change-summary.md`, `test-plan.md`, and `test-cases.md`.
- `/aif-roadmap` owns only the configured roadmap artifact, `.ai-factory/ROADMAP.md` by default.

These utilities must not create or mutate `openspec/changes/**`, `openspec/specs/**`, `.ai-factory/state/**`, `.ai-factory/rules/generated/**`, or AIFHub verification/finalization evidence under `.ai-factory/qa/<change-id>/`. `/aif-qa` may use the same configured `paths.qa` root as AIFHub, but upstream manual QA artifacts use branch slugs while `/aif-verify` and `/aif-done` evidence use OpenSpec `change-id` directories.

### Branch-scoped QA design and execution

Upstream `/aif-qa` writes `change-summary.md`, `test-plan.md`, and `test-cases.md` under `paths.qa/<branch-slug>/`; `/aif-qa-check` executes those cases and writes `qa-check.md` in the same directory. Both derive a collision-resistant `<safe-prefix>-<hash8>` from the original branch name.

Current QA-check results bind to `tested_revision` plus `worktree_digest` for git or `manual_build_id` outside git, and to `source_digest` plus per-case `case_digests`. Changed bindings mark affected outcomes unchecked `Stale` while preserving prior comments and evidence as history. Evidence should match the execution surface: backend tests, CLI, API, file/docs, and database-read cases are not blocked solely by missing browser automation.

`agent-context.md` and `agent-history.md` may preserve only reusable non-sensitive setup facts or cross-run lessons. Production, unknown targets, destructive actions, and external side effects require explicit authorization for the current target/action. Persisted evidence replaces credentials, cookies, authorization values, tokens, one-time codes, private data, and sensitive URL parameters with `[REDACTED]`.

Branch-scoped `qa-check.md` is not change-scoped AIFHub evidence. It cannot by itself satisfy `/aif-verify`, `/aif-done`, `coverage.json`, rules evidence, `done-readiness.json`, `done.md`, or `openspec-archive.json`; no implicit bridge is registered.

## AI Factory 2.18 Reviewed Baseline

The reviewed AI Factory `2.18.1` baseline is cumulative: it retains the existing AI Factory `2.13`-`2.17` compatibility facts, including config-aware project-context utilities, the full `2.17.0...2.18.0` audit (21 commits, 63 changed files), and the bounded `2.18.0...2.18.1` patch audit (2 commits, 8 changed files). AIFHub adapts only behavior that crosses its OpenSpec-native or legacy compatibility ownership boundaries; upstream-owned behavior remains upstream-owned.

### AI Factory 2.16 and 2.17 cumulative audit

| Upstream change | AIFHub outcome |
|---|---|
| Revision-bound research context | Adapt through planning/improve prompts: a committed `## Research Context` snapshot remains authoritative until an explicit rebase, while live research is used only for drift detection and rationale. |
| Branch-scoped `/aif-qa-check` | Document as an upstream QA execution utility over `paths.qa/<branch-slug>/test-cases.md`; its `qa-check.md` is not AIFHub change-scoped verify, coverage, rules, done, or archive evidence. |
| Regression-first `/aif-fix` | Adapt the OpenSpec-native fix loop to record the narrow pre-fix check, identical post-fix check, QA provenance, and fallback decision under `.ai-factory/state/<change-id>/fixes/`; `/aif-verify` remains authoritative. |
| Verbatim `## Original Request` | Adapt planning and refinement prompts so recognized control tokens are removed only from command positions and the preserved request section is not translated or regenerated. |
| QA execution-surface follow-ups | Document that browser automation is not required for backend, CLI, API, file/docs, or database-read cases when another concrete evidence surface is appropriate. |
| Collision-resistant QA branch identity | Document the shared filesystem-safe prefix plus digest contract used by `/aif-qa` and `/aif-qa-check`. |
| QA freshness and reusable memory | Document `tested_revision`, `worktree_digest` or `manual_build_id`, `source_digest`, per-case digests, stale-result invalidation, and non-sensitive `agent-context.md` / `agent-history.md`. |
| QA safety and redaction | Require explicit authorization for production, unknown-target, destructive, or external-side-effect execution and redact credentials, cookies, authorization values, tokens, one-time codes, private data, and sensitive URL parameters before persistence. |
| Custom fix-plan preservation | Reviewed upstream ownership: AIFHub adds no delete implementation; upstream resolved-path behavior preserves custom or explicitly supplied non-default `paths.fix_plan` files. |
| Plan/improve Original Request follow-ups | Fold into the same immutable-source contract across plan creation, improve, plan-polisher, implement, verify, and fix consumers. |
| Universal / Other MCP | Adapt instruction and docs only. Upstream AI Factory `2.16+` renders standard `mcpServers` settings to `.mcp.json`; the AIFHub canonical server template stays runtime-neutral. This auto-configuration is version-gated and is not promised for supported AI Factory `2.11`-`2.15` runtimes. |
| Project-evidence-backed control flow | Adapt through `aif-analyze` and its base-rules template only: emit project-specific guard-clause, early-return/continue, helper, or intentional nesting guidance only when repository evidence supports it. |
| Refined `/aif-architecture` structure | Reviewed no-op: upstream `/aif-architecture` remains the command owner and `injections/core/aif-architecture-context-boundary.md` remains boundary-only. |
| Generated-rules changes | Reviewed no-op: project-specific Control Flow detection belongs to `aif-analyze`; AIFHub does not duplicate it in the generated-rules compiler. |
| Community-extension documentation | Reviewed no-op: no AIFHub contract changes, so complete upstream community documentation bodies are not copied. |

### AI Factory 2.18 audit

| Upstream surface | Evidence and AIFHub decision |
|---|---|
| Extension schema and loader | Reviewed no-op: the tagged schema, extension loader and extension command blobs are unchanged, so AIFHub adds no manifest or loader adapter. |
| Injection and MCP runtime | Reviewed no-op: injection loading, MCP core/template behavior and public command wiring are unchanged. |
| Node, bin and dependencies | Reviewed no-op: Node remains `>=18.0.0`; package bin and runtime dependencies are unchanged. |
| Ultra planning | Adapter by artifact mode: OpenSpec-native `ultra` raises canonical `design.md`/`tasks.md` detail without `index.md`, phase files or an active marker; legacy marked bundles remain upstream-owned. |
| Ultra research | Adapter as supporting context: bundles live under the directory derived from `paths.research`; only a revision-bound selected Active Summary may influence a canonical proposal. |
| Directory archive support | Bounded adapter: OpenSpec-native plan-mutating `/aif-archive` modes stop before plan discovery and route to `/aif-done`; legacy marked ultra archive remains upstream-owned. |
| Completed-phase `/aif-loop` budget | Reviewed no-op: the upstream loop owns budget accounting, state and stop conditions; AIFHub adds no loop skill, injection or schema. |
| Privacy-gated `/aif-transfer` | Reviewed no-op: transfer keeps its sanitized in-memory registry, current-project evidence requirement, privacy checks and explicit approval; accepted evolution delegates to upstream `/aif-evolve`. AIFHub adds no transfer skill or injection. |
| skills.sh installation documentation | Docs-only reviewed no-op: skills-only installation is not documented as providing the CLI, extension loader, MCP auto-configuration, agent files or command wrappers. |

### AI Factory 2.18.1 patch audit

| Upstream surface | Evidence and AIFHub decision |
|---|---|
| Package and documentation patch | The reviewed `2.18.0...2.18.1` range contains 2 commits across 8 files. It is prompt/docs-only apart from the package version and ultra-contract test metadata. |
| Runtime/API/schema/dependencies | Reviewed no-op: extension schema/loader, injection/MCP runtime, Node `>=18`, bin and dependencies are unchanged from the cumulative 2.18.0 audit. |
| `/aif-explore` Research Coherence Gate | Upstream-owned. AIFHub does not copy or replace its algorithm; the prepend only guarantees a non-bypass pass-through after permitted persisted regular/ultra writes, preserves optional fresh-context `Task` with mandatory direct fallback, and keeps coherence before the ultra Bundle Integrity Gate. |
| Consumer compatibility evidence | Deterministic and opt-in live orchestration bind exact `2.17.0` and `2.18.1` package/reported versions while retaining `2.18.0` as a separate stable feature boundary and preserving the public `smoke:ai-factory-2-18` command plus existing flags. |

### AI Factory 2.18 consumer ledger

| Consumer | Decision |
|---|---|
| `/aif-plan` | `adapter`: version-gated canonical ultra detail in OpenSpec-native mode; marker-first upstream handoff in legacy mode. |
| `/aif-explore` | `adapter`: regular research remains one resolved file; explicit stable-2.18 ultra research is one marked sibling bundle; on 2.18.1 every permitted persisted write continues into the upstream Research Coherence Gate before presentation/session append. |
| `/aif-improve`, `/aif-implement`, `/aif-verify`, `/aif-fix` | `adapter`: canonical OpenSpec consumption is unchanged; legacy marked ultra is classified before companion writes and handed to the matching upstream owner. |
| `/aif-archive` | `adapter`: OpenSpec-native mutation guard; read-only `list`, roadmap-only `--roadmap` and legacy archive retain upstream ownership. |
| `/aif-rules-check`, `/aif-commit`, `/aif-roadmap` | `retain`: existing AIFHub boundaries remain; no multi-file orchestration is copied. |
| `aif-analyze` | `retain`: owns AIFHub config/bootstrap only and preserves upstream and unknown user fields. |
| `aif-mode` | `adapter`: keeps OpenSpec sync ownership and preserves an explicitly captured legacy source root instead of scanning canonical changes. |
| `aif-done` | `retain`: remains the OpenSpec finalizer; a verified legacy ultra bundle receives only an upstream `/aif-archive <entrypoint>` handoff. |
| `aif-evolve` | `retain`: remains the downstream owner selected by upstream privacy-gated transfer; no transfer registry is copied. |
| `/aif-loop`, `/aif-transfer` and packaged upstream coordinators | `no-op`: remain upstream-owned; AIFHub does not export duplicate skills, injections or orchestration. |
| AIFHub namespaced agents | `adapter`: keep bounded OpenSpec roles and return exact upstream handoffs for legacy marked ultra instead of editing phase bundles. |

The metadata compatibility range remains `>=2.11.0 <3.0.0`. Behaviors introduced by newer upstream runtimes are labeled by version instead of raising the minimum without a proven hard dependency.

### Preserved earlier baseline behavior

AI Factory 2.14+ includes upstream `/aif-archive` and `paths.archive`. AIFHub treats `/aif-archive` as legacy AI Factory-only cleanup, not as OpenSpec-native finalization:

- completed legacy `paths.plans/*.md` files move to `paths.archive/plans/*.md`;
- `paths.archive` defaults to `.ai-factory/archive/`;
- `/aif-archive --roadmap` may snapshot closed roadmap milestones under `paths.archive/roadmap/`;
- archived legacy plans are excluded from active sequential plan discovery and numbering;
- `/aif-archive` must not modify `openspec/changes/**`, `openspec/specs/**`, `.ai-factory/qa/**`, `.ai-factory/state/**`, or `.ai-factory/rules/generated/**`;
- `/aif-archive` must not run `openspec archive <change-id> --yes`.

OpenSpec-native finalization remains `/aif-verify <change-id>` followed by `/aif-done <change-id>`. `/aif-done` owns OpenSpec archive/finalization evidence; `/aif-archive` owns only upstream legacy plan cleanup.

For machine-checkable ownership: `/aif-archive` must not write `openspec/changes/**`, must not write `openspec/specs/**`, must not write `.ai-factory/qa/**`, must not write `.ai-factory/state/**`, and must not write `.ai-factory/rules/generated/**`.

AI Factory 2.15+ preserves managed agent config files during update/init workflows and can offer newly available built-in skills interactively during update. This is upstream installer/update behavior only. It does not make AIFHub the owner of OpenSpec canonical artifacts, generated rules, or project-specific agent config files.

## Artifact Sync Points

Recommended sync points:

- after `/aif-plan full` or `/aif-improve`: `/aif-mode sync --change <change-id>`
- after spec/task edits during implementation or fix: `/aif-mode sync --change <change-id>`
- after `/aif-done` archive: `/aif-mode sync`

`/aif-mode sync` compiles generated rules and requests OpenSpec validation/status when configured and available. Missing OpenSpec CLI is degraded mode for sync validation, not an install failure.

When no active changes exist after archive, `/aif-mode sync` still refreshes `.ai-factory/rules/generated/openspec-base.md` and `.ai-factory/rules/generated/index.json` from `openspec/specs/**`, skips change-specific generated rules, skips change validation, writes a sync report, and returns OK.

For `/aif-mode sync --all`, selected active changes without `openspec/changes/<change-id>/specs/**/spec.md` delta specs are reported as `no-delta-specs` warnings and skipped for sync validation. Changes with delta specs are still validated/statused when the CLI is available.

## Гейт Rules

`/aif-rules-check` is read-only. It uses AIFHub generated rules in OpenSpec-native mode and returns a machine-readable `aif-gate-result` with `gate: "rules"`.

When done policy requires a rules gate pass, save durable rules evidence under `.ai-factory/qa/<change-id>/rules.md` with the final fenced `aif-gate-result` block. Generated rules being present and current is a separate readiness signal; it does not satisfy `requireRulesPassForVerify` or `requireRulesPassForDone`.

Generated rules are compiled as markdown plus provenance JSON:

```text
.ai-factory/rules/generated/openspec-base.md
.ai-factory/rules/generated/openspec-change-<change-id>.md
.ai-factory/rules/generated/openspec-merged-<change-id>.md
.ai-factory/rules/generated/openspec-rules-trace-<change-id>.json
.ai-factory/rules/generated/index.json
```

Generated-rule failures must cite trace-backed `source.path` and `source.requirement`. The trace also records output hashes for generated markdown so status/doctor can detect manual edits to generated rule text. Missing or invalid trace metadata is warning-only and should be fixed with sync; it is not enough on its own for a generated-rule `FAIL`.

If generated rules are missing or stale, run:

```text
/aif-mode sync --change <change-id>
/aif-rules-check
```

## Mode Controller

`/aif-mode` is the extension-owned controller for artifact protocol changes:

```text
/aif-mode status
/aif-mode openspec
/aif-mode ai-factory
/aif-mode sync
/aif-mode doctor
```

`/aif-mode openspec` ensures:

```text
openspec/config.yaml
openspec/specs/
openspec/changes/
.ai-factory/state/
.ai-factory/qa/
.ai-factory/rules/generated/
```

It does not install OpenSpec skills or commands. If legacy plans exist, it reports migration commands and only runs migration when explicitly approved.

`/aif-mode ai-factory` switches the config marker and legacy paths back to `.ai-factory/plans`, `.ai-factory/specs`, and `.ai-factory/rules`. It does not delete `openspec/`.

## OpenSpec-Native Planning

`/aif-plan full` remains the public planning entrypoint. In OpenSpec-native mode it creates:

```text
openspec/changes/<change-id>/
  proposal.md
  design.md
  tasks.md
  specs/<capability>/spec.md
```

It does not create `.ai-factory/plans/<id>.md` or `.ai-factory/plans/<id>/task.md` in OpenSpec-native mode. Missing or unsupported OpenSpec CLI is degraded validation, not planning failure.

## CLI Resolution

Every shared-runner operation resolves one OpenSpec executable with this precedence:

1. Explicit non-empty extension API `options.command`.
2. Project-local `node_modules/.bin/openspec` (`node_modules/.bin/openspec.cmd` on Windows).
3. Global `openspec` from `PATH`.

The resolver does not search parent projects, invoke `npx`, download packages, or auto-install OpenSpec. Once an explicit or project-local candidate is selected it is authoritative; unsupported versions and execution failures do not silently fall through to another installation. Windows `.cmd`/`.bat` candidates use the bounded `ComSpec` route, while native POSIX executables use direct execution.

Diagnostics separate the internal executable from a safe display value. Project-local and in-project explicit paths are project-relative; external explicit paths are reduced to a bounded identifier. Neither human nor JSON output exposes `PATH`, environment values, or private absolute project paths.

## Capability Shape

`scripts/openspec-runner.mjs` exposes capability detection with this stable minimum:

```yaml
openspec:
  available: boolean
  canValidate: boolean
  canArchive: boolean
  version: string | null
  supportedRange: ">=1.3.1 <2.0.0"
  latestReviewedVersion: "1.8.0"
  versionOutdated: boolean | null
  requiresNode: ">=20.19.0"
```

The current runner also reports operational detail fields:

```yaml
openspec:
  nodeVersion: string
  nodeSupported: boolean
  versionSupported: boolean
  command: string
  commandSource: "explicit" | "project-local" | "path"
  reason: string | null
  errors:
    - code: string
      message: string
```

Commands should treat the stable minimum as the contract and the operational detail fields as diagnostics.

## Version Freshness in `/aif-analyze`

`/aif-analyze` reads the installed-project `openspecCli` result from `ai-factory aifhub-mode status --json`. When a selected CLI is compatible but older than the latest reviewed stable version, bootstrap remains available and the skill emits a non-blocking update recommendation. `versionOutdated` is `null` when the CLI version is missing or unsupported, so freshness never replaces the existing degraded reason.

The recommendation follows the selected user-owned source: update the project dependency for `project-local`, the existing PATH/global installation for `path`, or the caller-owned executable for `explicit`. Do not guess a package manager, and do not install, update, replace, or re-resolve OpenSpec automatically. A supported version equal to or newer than `latestReviewedVersion` does not receive an update or downgrade recommendation.

## Degraded Mode

When the OpenSpec CLI is missing or unsupported:

- extension install remains valid
- OpenSpec-native planning can still write `openspec/changes/<change-id>/`
- generated-rules and execution context may continue from filesystem artifacts
- `/aif-verify` records degraded validation unless strict config requires CLI availability
- `/aif-done` fails archive-required finalization because archive requires a compatible CLI

Filesystem-based artifact discovery, planning, and context loading continue without installing anything. Degraded mode never simulates CLI validation or archive success.

When Node is below `>=20.19.0`, the CLI is treated as unavailable for validate/archive capabilities even if an `openspec` command exists.

When `detectOpenSpec()` reports `reason: unsupported-version`, update or reinstall OpenSpec CLI to `>=1.3.1 <2.0.0`. This remains degraded capability for bootstrap and planning unless a command-specific policy requires CLI availability.

## Prompt Assets and Runtime Integration

OpenSpec-native prompt assets are mode-gated. They keep canonical changes under `openspec/changes/<change-id>/`, read generated rules as derived guidance, and write runtime state or QA evidence under `.ai-factory/state/<change-id>/` and `.ai-factory/qa/<change-id>/`.

Scoped runtime integrations are already documented in the active prompt assets: #31 covers implementation/fix runtime state alignment, #32 covers verify validate/status runtime behavior, and done finalization covers archive/finalizer integration.

## Validation and Archive

Inside the extension, the shared runner performs validation with:

```bash
openspec validate <change-id> --type change --strict --json --no-interactive --no-color
```

Inside the extension, status evidence uses:

```bash
openspec status --change <change-id> --json --no-color
```

Installed projects invoke archive-required finalization through:

```bash
ai-factory aifhub-done-finalizer --change <change-id> --json
```

Omitting `--change` delegates to the active-change resolver: exactly one resolvable active change may be selected, while missing or ambiguous scope exits with code `2` before finalization. Automation should always pass an explicit `--change <change-id>`.

The wrapper returns exit `0` for success or policy-accepted warning, `1` for a resolved blocker, and `2` for invalid arguments, unresolved/ambiguous scope, or unexpected command failure. It rejects bypass flags and emits only bounded human/JSON fields. The extension-local runner then uses:

```bash
openspec archive <change-id> --yes --no-color
```

`ai-factory aifhub-done-finalizer --change <change-id> --skip-specs --json` adds `--skip-specs` for docs/tooling-only changes. Do not execute `scripts/openspec-done-finalizer.mjs` or other `scripts/openspec-*.mjs` modules from a consumer root or internal installed-extension path; they are extension-local implementation modules.

AIFHub artifact contract validation is a separate read-only layer over the CLI adapter. It checks workflow ownership, runtime evidence placement, generated-rule freshness, and pre-archive verification evidence. See [OpenSpec Artifact Validation](openspec-validation.md).

## See Also

- [Usage](usage.md)
- [Context Loading Policy](context-loading-policy.md)
- [OpenSpec Artifact Validation](openspec-validation.md)
- [Active Change Resolver](active-change-resolver.md)
- [ADR 0001](adr/0001-openspec-native-artifact-protocol.md)
- [ADR 0002: Optional Project Glossary](adr/0002-optional-project-context-glossary.md)
