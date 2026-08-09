[К документации](README.md) | [К README](../README.md) | [Следующая страница](context-providers.md)

# Usage

This guide documents the v1 OpenSpec-native workflow for AIFHub Extension.

```text
setup and mode:
  /aif-mode status                                  # recommended
  /aif-analyze                                      # required once per project
  /aif-mode openspec                                # required when switching modes
  /aif-mode doctor                                  # optional readiness check

optional discovery:
  /aif-explore "<topic>"                            # optional
  /aif-grounded "<question>"                        # optional upstream certainty gate

planning:
  /aif-plan full "<request>"                        # required
  /aif-improve <change-id>                          # optional, repeatable
  /aif-mode sync --change <change-id>               # recommended

implementation:
  /aif-implement <change-id>                        # required

validation gates:
  /aif-mode sync --change <change-id>               # optional if specs/rules changed
  /aif-rules-check                                  # optional/recommended rules gate
  /aif-review                                       # optional read-only review gate
  /aif-security-checklist                           # optional for security-sensitive changes

verification:
  /aif-verify <change-id>                           # required
    fail -> /aif-fix <change-id>                    # required only after failed verify
         -> optional /aif-rules-check
         -> /aif-verify <change-id>

finalization:
  /aif-mode doctor --change <change-id>             # recommended before archive
  /aif-done <change-id>                             # required after passing verify
  /aif-mode sync                                    # recommended after archive
  /aif-commit                                       # recommended AI Factory commit gate
  /aif-evolve                                       # optional learning step
```

OpenSpec-native mode uses OpenSpec artifacts as canonical planning/spec artifacts and AI Factory paths for runtime state, QA evidence, and generated rules in user projects.

Upstream project-context utilities such as `/aif-architecture`, `/aif-roadmap`, `/aif-docs`, `/aif-qa`, `/aif-archive`, and `/aif-distillation` remain available with AIFHub guardrails. They are not required per-change OpenSpec lifecycle gates.

The `aifhub-extension` package repository stays artifact-light: root `openspec/`, `.ai-factory/state/`, `.ai-factory/qa/`, `.ai-factory/plans/`, and `.ai-factory/rules/generated/` are not extension package source. Root `.ai-factory/rules/generated/` is derived in user projects and safe to regenerate. OpenSpec examples may be committed only under fixture paths such as `test/fixtures/` or `scripts/fixtures/`.

AIFHub commands request OpenSpec validation, status, instructions, and archive through the extension-local `scripts/openspec-runner.mjs` implementation module when the CLI is available. Installed projects must not execute that module from the consumer root or an internal installed path. Slash-command runtimes should keep using `/aif-*` commands. Codex app uses `$aif-*` skill invocations, as shown in the Recommended Codex App Flow. This extension does not install or rely on OpenSpec slash commands.

The shared resolver selects one CLI source per operation in deterministic order: explicit non-empty extension API `options.command`, project-local `node_modules/.bin/openspec` (`openspec.cmd` on Windows), then `openspec` from `PATH`. An explicit or project-local selection is authoritative and never silently falls through after failure. AIFHub does not run `npx`, search parent projects, download, or auto-install OpenSpec. Missing or unsupported CLI remains degraded for filesystem-based planning/context loading; archive-required finalization still refuses until a compatible CLI is available. Human and JSON diagnostics expose only a safe project-relative/bounded command and `explicit`, `project-local`, or `path` source.

## Optional Project Glossary

Projects may configure a protocol-neutral glossary for preferred human-readable terminology:

```yaml
paths:
  context: CONTEXT.md
```

The key is valid in OpenSpec-native and legacy AI Factory-only profiles, and a custom project-relative value is preserved during mode switches. The file itself is optional: missing or empty content does not block any command and `/aif-mode` never creates or validates it.

`/aif-analyze` is the only AIFHub writer. Creation requires explicit opt-in plus concrete source-grounded terms; updates require an explicit request or accepted proposal and preserve manual/unknown sections. All other commands are read-only consumers. The glossary affects prose only and cannot override source/tests, canonical OpenSpec requirements, project rules, accepted architecture decisions, or verifiable QA facts. See [Context Loading Policy](context-loading-policy.md) and [ADR 0002](adr/0002-optional-project-context-glossary.md).

## Опциональные Context Providers

Context providers - ручные, user-owned research aids. AIFHub может читать reviewed provider notes как optional supporting context, но provider availability всегда degraded behavior и никогда не является validation, verification, review, rules, security, done или commit gate.

Центральная policy описана в [Context Providers](context-providers.md), local metadata-driven recommendation diagnostics - в [Memory Tool Recommendations](memory-tool-recommendations.md).

Installed projects могут проверить optional recommendations так:

```bash
ai-factory aifhub-memory-tools recommend --from-project --json
ai-factory aifhub-memory-tools select --from-project --command aif-explore --json
ai-factory aifhub-memory-tools select --from-project --command aif-plan --json
ai-factory aifhub-memory-tools status --json
ai-factory aifhub-memory-tools metadata --json
```

`/aif-analyze` записывает user-accepted provider ids в `utilities.context_tools.enabled`. Последующие skills вызывают `select` и используют только `selected_tools` для своей команды:

```yaml
utilities:
  context_tools:
    enabled: []
```

### Graphify

Graphify можно использовать как manual, user-owned repository research aid до или во время AIFHub work. AIFHub Extension не требует Graphify, не устанавливает `graphifyy`, не запускает `graphify`, не добавляет Graphify в extension dependencies и не запускает или регистрирует Graphify MCP automatically.

`/aif-analyze` хранит shared utility config Graphify только как backward-compatible preference. Новые optional tool recommendations приходят из local `recommendation-metadata.yaml` через installed wrapper command, а не из provider config abstraction. Compatibility config shape:

```yaml
utilities:
  context_tools:
    enabled: []
  graphify:
    enabled: false
    uv_check: uv --version
    install: uv tool install graphifyy
    activate: graphify install
    report_command: graphify .
```

Устанавливайте `utilities.graphify.enabled: true` только после того, как project выбрал использование manually generated Graphify reports. Эта настройка не устанавливает Graphify и не заменяет metadata-driven recommendations.

Manual usage вне AIFHub command ownership:

```powershell
uv --version
uv tool install graphifyy
graphify install
graphify .
```

В PowerShell используйте `graphify .`; не добавляйте prefix `/graphify .`.

Graphify пишет local outputs в `graphify-out/`, включая:

- `graphify-out/GRAPH_REPORT.md`
- `graphify-out/graph.json`
- `graphify-out/graph.html`

CLI также может expose research commands вроде `graphify query`, `graphify path` и `graphify explain`.

Когда `graphify-out/GRAPH_REPORT.md` уже существует, AIFHub commands могут читать его как optional supporting context. Для дальнейшей context loading храните reviewed output только здесь:

- `.ai-factory/references/graphify/` для project-wide reference context.
- `.ai-factory/state/<change-id>/graphify/` для change-scoped runtime context.

Не храните Graphify generated files в `openspec/changes/<change-id>/`, `openspec/specs/`, `.ai-factory/rules/generated/` или `.ai-factory/qa/<change-id>/`.

Считайте Graphify findings только supporting evidence. Reports могут включать extracted, inferred, ambiguous или confidence-labeled relationships, поэтому final plans, review findings, verification status, generated rules и roadmap completion все равно требуют direct repository evidence из canonical OpenSpec artifacts, source files, tests, runtime state или QA evidence.

Перед копированием report в `.ai-factory/` проверьте его на sensitive information. Не persist API keys, tokens, raw authorization headers, credential helper output, private backend diagnostics или unreviewed sensitive output в AIFHub artifacts.

### CodeGraph

CodeGraph - manual CLI-only repo graph support для broad architecture, impact или multirepo mapping. `/aif-analyze` может рекомендовать его из local metadata; `/aif-explore` может запускать его только когда `select --command aif-explore --json` возвращает его в `selected_tools` с `manual_purged_cli_execution`.

Protocol-neutral preference shape:

```yaml
utilities:
  codegraph:
    enabled: false
    command: codegraph
    status: codegraph status
    init: codegraph init .
    index: codegraph index --quiet .
    query: codegraph query --path . --limit 10 --json
    purge: codegraph uninit --force .
```

Разрешенный `/aif-explore` lifecycle:

```bash
codegraph init <project>
codegraph index --quiet <project>
codegraph query --path <project> --limit 10 --json "<query>"
codegraph uninit --force <project>
```

Не запускайте `codegraph install`, `codegraph sync`, `codegraph serve`, `codegraph serve --mcp`, hooks, background services или agent configuration mutation. Если pre-existing `.codegraph/` уже существует, считайте его user-owned state и не удаляйте/не reinitialize silently.

### Context7

Context7 можно использовать как manual, user-owned documentation research aid для current library/API docs. AIFHub Extension не требует Context7, не устанавливает `ctx7` или `@upstash/context7-mcp`, не запускает `ctx7`, не запускает `ctx7 setup`, не добавляет Context7 в extension dependencies, не добавляет Context7 MCP templates в `extension.json` и не запускает или регистрирует Context7 MCP automatically.

Используйте Context7, когда version-sensitive API documentation materially снижает неопределенность во время `/aif-explore`, `/aif-plan full` или `/aif-review`. Примеры: framework migrations, deprecations, third-party client behavior, package-specific configuration или review findings, зависящие от current upstream docs.

Manual CLI usage вне AIFHub command ownership:

```bash
npx ctx7 library <name> <query>
npx ctx7 docs <libraryId> <query>
```

Если пользователь уже установил Context7, equivalent local commands:

```bash
ctx7 library <name> <query>
ctx7 docs <libraryId> <query>
```

Context7 CLI usage требует подходящий local Node.js runtime. Если `npx ctx7` или user-installed `ctx7` недоступен, слишком старый, unauthenticated, rate-limited или без provider access, продолжайте с degraded documentation context и используйте repository evidence плюс local package docs.

Context7 library IDs являются provider output и могут иметь формы `/org/project`, `/org/project/version`, `/org/project@version`, `/packages/<name>` или `/websites/<name>`. Treat exact IDs as unstable external references, а не AIFHub schema.

Если пользователь уже настроил Context7 MCP, agents могут использовать его как optional read-only documentation context. Обычный MCP flow: `resolve-library-id`, затем docs retrieval tool; в зависимости от client/server version tool может называться `get-library-docs` или `query-docs`.

Не запускайте `ctx7 setup` из AIFHub commands или sidecars. Он может mutate `.mcp.json`, `.cursor/mcp.json`, `.opencode.json`, agent rules или agent skills. AIFHub guidance может упоминать его только как user-owned setup.

Для будущего context loading пишите concise summaries reviewed Context7 notes только сюда:

- `.ai-factory/references/context7/` для project-wide documentation context.
- `.ai-factory/state/<change-id>/context7/` для change-scoped runtime context.

Не храните raw Context7 output, MCP transcripts, API responses, setup output или generated provider configuration в `openspec/changes/<change-id>/`, `openspec/specs/`, `.ai-factory/rules/generated/` или `.ai-factory/qa/<change-id>/`.

Считайте Context7 output только supporting evidence. Plans, review findings, verification status, generated rules и completion decisions должны оставаться source-grounded в direct repository evidence из canonical OpenSpec artifacts, source files, tests, runtime state, QA evidence, generated rules или package files в repository.

Не persist `CONTEXT7_API_KEY`, API keys, tokens, raw authorization headers, credential helper output, private provider diagnostics, private backend diagnostics или unreviewed sensitive output в AIFHub artifacts.

## Bug Fix Workflows

OpenSpec-native mode separates new bug reports from fixes for failed verification findings.

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

`/aif-fix` handles selected findings inside an existing active OpenSpec change:

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

## Artifact Ownership

| Path | Role |
|---|---|
| `openspec/specs/**/spec.md` | Canonical current behavior |
| `openspec/changes/<change-id>/proposal.md` | Canonical change intent |
| `openspec/changes/<change-id>/design.md` | Canonical design notes |
| `openspec/changes/<change-id>/tasks.md` | Canonical implementation checklist |
| `openspec/changes/<change-id>/specs/**/spec.md` | Canonical proposed behavior deltas |
| `.ai-factory/state/<change-id>/` | Runtime execution state and summaries |
| `.ai-factory/qa/<change-id>/` | Verification and finalization evidence |
| `.ai-factory/rules/generated/` | Derived rules, safe to regenerate |
| `.ai-factory/plans/` | Legacy AI Factory-only compatibility and migration input |

Extension behavior requirements are validated by prompt contracts and tests, not by root project OpenSpec specs committed into this repository.

## Manifest Metadata

`extension.json` follows the upstream AI Factory extension manifest schema and should not contain AIFHub-private fields. Its `$schema` value points at:

```text
https://raw.githubusercontent.com/lee-to/ai-factory/2.x/schemas/extension.schema.json
```

The private AIFHub metadata contract lives in `aifhub-extension.json` and is described by `schemas/aifhub-extension.schema.json`. `compat.ai-factory` and `sources.*` belong there, not in `extension.json`.

## Command Boundaries

### `/aif-mode`

Reads:

- `.ai-factory/config.yaml`
- `openspec/changes/**`
- `openspec/specs/**`
- `.ai-factory/plans/**`
- `.ai-factory/rules/generated/**`

Writes by subcommand:

- `openspec`: `.ai-factory/config.yaml`, OpenSpec skeleton paths, runtime directories, generated rules, optional legacy migration outputs when `--yes` is passed, and `.ai-factory/state/mode-switches/*.md`
- `ai-factory`: `.ai-factory/config.yaml`, legacy skeleton paths, optional compatibility export outputs when `--export-openspec` is passed, and `.ai-factory/state/mode-switches/*.md`
- `sync`: derived generated rules or compatibility export outputs for the current mode, plus a sync report
- `status` and `doctor`: no writes

Does not write:

- OpenSpec skills or slash commands
- manual changes to `openspec/specs/**`
- archive output or `/aif-done` finalization
- runtime files under `openspec/changes/<change-id>/`

Use `--dry-run` for planned switching or sync writes. Use `--all` or `--change <id>` to control change selection. Use `--export-openspec` only for compatibility legacy exports from OpenSpec changes. In OpenSpec mode, sync respects `aifhub.openspec.compileRulesOnSync` and `aifhub.openspec.validateOnSync`.

`/aif-mode sync --change <change-id>` is recommended after `/aif-plan full` or `/aif-improve` and whenever canonical specs or tasks changed during implementation or fixes. It ensures OpenSpec skeleton paths, compiles `.ai-factory/rules/generated/openspec-base.md`, `.ai-factory/rules/generated/openspec-change-<change-id>.md`, `.ai-factory/rules/generated/openspec-merged-<change-id>.md`, `.ai-factory/rules/generated/openspec-rules-trace-<change-id>.json`, and `.ai-factory/rules/generated/index.json`, requests OpenSpec validation/status when the CLI is available and `validateOnSync` is enabled, detects legacy plans in OpenSpec mode, and writes a sync report under `.ai-factory/state/mode-switches/`.

`/aif-mode sync` without `--change` is recommended after `/aif-done`. After archive, there may be no active change. Sync still refreshes `.ai-factory/rules/generated/openspec-base.md` and `.ai-factory/rules/generated/index.json` from `openspec/specs/**`, skips change-specific generated rules and change validation when no active changes exist, and writes a sync report. OpenSpec skills are not installed.

`/aif-mode sync --all` is a maintenance sweep. It refreshes generated rules for active changes and validates selected changes that contain `openspec/changes/<change-id>/specs/**/spec.md` delta specs or declare native `skip_specs: true` in `openspec/changes/<change-id>/.openspec.yaml`. It reports older unmarked no-delta changes as `no-delta-specs` warnings. Invalid native markers are validated fail-closed instead of being silently skipped. `/aif-verify <change-id>` remains the stricter verification gate for a specific change.

`/aif-mode doctor --change <change-id>` includes the read-only AIFHub OpenSpec artifact contract check and the latest coverage matrix diagnostic. It reports the full JSON result as `artifactContract`, reports coverage as `coverage`, and treats missing verification evidence as a pre-archive readiness failure. See [OpenSpec Artifact Validation](openspec-validation.md) and [OpenSpec Coverage Matrix](spec-coverage.md).

For CLI or IDE runtimes, planning commands may recommend an available planning mode for structured questions, but they must not fabricate unavailable tools or client actions. Codex mode switching remains a user action; see [Codex Plan Mode](codex-plan-mode.md).

### `/aif-archive`

`/aif-archive` is an upstream AI Factory 2.14+ legacy plan cleanup command. It is not the OpenSpec-native finalization command.

Reads:

- completed legacy plan files under `paths.plans/*.md`
- optional roadmap context when `/aif-archive --roadmap` is used

Writes:

- `paths.archive/plans/*.md`
- `paths.archive/roadmap/*.md` when roadmap snapshotting is requested

`paths.archive` defaults to `.ai-factory/archive/`. In legacy AI Factory-only mode, archived plans under `paths.archive/plans/` are excluded from active plan discovery and from `workflow.plan_id_format: sequential` numbering.

Does not write:

- `openspec/changes/**`
- `openspec/specs/**`
- `.ai-factory/qa/**`
- `.ai-factory/state/**`
- `.ai-factory/rules/generated/**`

`/aif-archive` must not run `openspec archive <change-id> --yes`. In OpenSpec-native mode, finalize a verified change with `/aif-done <change-id>` after `/aif-verify <change-id>`.

### `/aif-analyze`

Reads:

- project files and repository metadata
- existing `.ai-factory/config.yaml` when present
- existing rules/context artifacts when present

Writes:

- `.ai-factory/config.yaml`
- `.ai-factory/rules/base.md`
- configured `paths.context` project glossary only after explicit user opt-in
- optional OpenSpec-native skeleton paths such as `openspec/specs/`, `openspec/changes/`, `.ai-factory/state/`, `.ai-factory/qa/`, and `.ai-factory/rules/generated/`

Does not write:

- OpenSpec skills or slash commands
- canonical change artifacts for a feature request
- `.ai-factory/plans` in OpenSpec-native mode
- an empty or unapproved glossary placeholder

Select OpenSpec-native mode explicitly by asking for it or by starting from config with:

```yaml
aifhub:
  artifactProtocol: openspec
```

When `.ai-factory/config.yaml` is missing and the user did not explicitly ask for a protocol, `/aif-analyze` asks one artifact protocol question before writing config or creating mode-specific directories:

- `legacy AI Factory-only`
- `OpenSpec-native`

Existing configs are not prompted again. Codex Default mode asks this as plain text; Codex Plan mode may use `request_user_input`; autonomous/subagent runs default to legacy AI Factory-only and report OpenSpec-native mode as an open question.

If localization questions run first, `/aif-analyze` carries those answers forward and writes them only after the artifact protocol is selected, so language persistence does not accidentally lock in the legacy default.

The selected artifact protocol owns its config profile. Legacy `artifactProtocol: ai-factory` configs do not include `aifhub.openspec` settings or OpenSpec runtime path defaults; OpenSpec-native `artifactProtocol: openspec` configs include those settings and paths explicitly.

Shared protocol-neutral settings such as `utilities.context_tools.enabled`, `utilities.graphify.enabled`, and `utilities.codegraph.enabled` may appear in either profile. They record optional tooling preferences and do not make that tool an AIFHub dependency. Optional memory/context tool recommendations are resolved from local installed metadata with `ai-factory aifhub-memory-tools recommend --from-project --json`; runtime tool selection uses `ai-factory aifhub-memory-tools select --from-project --command <skill> --json`. Missing metadata is degraded context and leaves `rg` as the baseline.

### `/aif-architecture`

`/aif-architecture` is an upstream project-level architecture context utility. It is not an OpenSpec canonical change/spec generation command.

Reads:

- `.ai-factory/config.yaml`
- resolved `paths.description`
- project files and source structure
- `.ai-factory/skill-context/aif-architecture/SKILL.md` when present
- optional OpenSpec context, generated rules, runtime state, and QA evidence as read-only supporting evidence
- selected optional provider context only when command-specific metadata allows it

Writes:

- resolved `paths.architecture`, `.ai-factory/ARCHITECTURE.md` by default
- an architecture pointer in resolved `paths.description`
- an architecture row in root `AGENTS.md`

Does not write:

- `openspec/changes/**`
- `openspec/specs/**`
- `.ai-factory/state/**`
- `.ai-factory/qa/**`
- `.ai-factory/rules/generated/**`
- provider notes, MCP config, provider config, or provider setup files

When architecture work would change product or workflow behavior, capture it through `/aif-plan full <request>` instead of writing OpenSpec deltas from `/aif-architecture`.

### `/aif-docs`

`/aif-docs` is an upstream documentation utility. It is not an OpenSpec lifecycle gate.

Reads:

- `.ai-factory/config.yaml`
- resolved `paths.description`
- resolved `paths.architecture`
- current README, docs, source files, comments, routes, and APIs
- `.ai-factory/skill-context/aif-docs/SKILL.md` when present

Writes:

- root `README.md`
- the resolved `paths.docs` directory, `docs/` by default
- optional `docs-html/` when the user explicitly requests web docs
- the Documentation section in `AGENTS.md`

Does not write:

- `openspec/changes/**`
- `openspec/specs/**`
- `.ai-factory/state/**`
- `.ai-factory/qa/**`
- `.ai-factory/rules/generated/**`

### `/aif-qa`

`/aif-qa` is an upstream manual QA artifact utility. It is distinct from AIFHub `/aif-verify` and `/aif-done` evidence.

Reads:

- git diff and changed files
- resolved `paths.description`
- resolved `paths.architecture`
- source files, docs, and existing QA context
- `.ai-factory/skill-context/aif-qa/SKILL.md` when present

Writes:

- upstream manual QA artifacts under `paths.qa/<branch-slug>/`, where `<branch-slug>` is a collision-resistant `<safe-prefix>-<hash8>` derived from the original branch name
- `change-summary.md`
- `test-plan.md`
- `test-cases.md`

`/aif-qa-check` is the matching upstream branch-scoped execution utility. It consumes `paths.qa/<branch-slug>/test-cases.md` and writes `paths.qa/<branch-slug>/qa-check.md`; both commands must derive the same branch slug. In agent mode, use evidence appropriate to the case surface: backend tests, CLI output, API results, file/docs inspection, or database reads do not require browser automation when concrete non-browser evidence exists.

Current results in `qa-check.md` must bind to `tested_revision` and `worktree_digest` for a git worktree, or `manual_build_id` outside git, plus `source_digest` for `test-cases.md` and per-case `case_digests`. When a binding changes, affected results become unchecked `Stale`; previous comments and evidence remain history and do not count as current pass, fail, or blocked status.

Reusable setup facts and cross-run lessons may be kept in `paths.qa/agent-context.md` and `paths.qa/agent-history.md` only when non-sensitive. Keep run-specific decisions and full transcripts out. Production, unknown targets, destructive actions, and external-side-effect cases require explicit authorization for the current target and action immediately before execution. Before writing any QA artifact, replace credentials, cookies, authorization values, tokens, one-time codes, private data, and sensitive URL parameters with `[REDACTED]`.

Does not write:

- `openspec/changes/**`
- `openspec/specs/**`
- `.ai-factory/state/**`
- `.ai-factory/rules/generated/**`
- AIFHub verification or finalization evidence under `.ai-factory/qa/<change-id>/`

In OpenSpec-native mode, use `/aif-verify <change-id>` for authoritative verification evidence and `/aif-done <change-id>` for finalization evidence.
Branch-scoped `qa-check.md` alone never satisfies AIFHub `verify.md`, `coverage.json`, rules evidence, `done-readiness.json`, `done.md`, or `openspec-archive.json`; no implicit bridge exists.

### `/aif-plan full`

Reads:

- `.ai-factory/config.yaml`
- project context and rules
- `openspec/specs/**/spec.md`
- optional `.ai-factory/RESEARCH.md`

Writes in OpenSpec-native mode:

- `openspec/changes/<change-id>/proposal.md`
- `openspec/changes/<change-id>/design.md`
- `openspec/changes/<change-id>/tasks.md`
- `openspec/changes/<change-id>/specs/**/spec.md` when behavior changes
- optional runtime notes under `.ai-factory/state/<change-id>/`

Does not write in OpenSpec-native mode:

- `.ai-factory/plans/<id>.md`
- `.ai-factory/plans/<id>/task.md`
- non-OpenSpec helper files under `openspec/changes/<change-id>/`

OpenSpec-native planning includes task intake normalization inside `/aif-plan full`; it is not a separate command or artifact flow. The normalized task maps into canonical OpenSpec artifacts:

- `proposal.md`: intent, scope, non-goals, approach, assumptions, risks, and open questions
- `design.md`: technical approach, C4 impact, ADR candidates, dependency graph, integration points, alternatives, and risks
- `tasks.md`: executable implementation checklist
- `specs/**/spec.md`: behavior-changing requirements and scenarios

`/aif-plan full` does not create `/aif-task-prepare`, does not create `.ai-factory/specs/<task-id>.md`, and does not create `task-prepare.md`. Raw input trace, normalization confidence, and temporary notes belong only under `.ai-factory/state/<change-id>/` when they are persisted.

Docs/tooling-only changes may omit delta specs only when the proposal explains why no product or workflow behavior changes.

When `aifhub.openspec.validateOnPlan` is enabled, planning requests `openspec validate` through the AIFHub OpenSpec runner if a compatible CLI is available. Missing CLI is a degraded warning unless `aifhub.openspec.requireCliForPlan` is true.

### `/aif-explore`

Reads:

- `.ai-factory/config.yaml`
- project context and rules
- `openspec/specs/**/spec.md`
- `openspec/changes/<change-id>/**` when exploring an existing change

Writes:

- `.ai-factory/RESEARCH.md`
- `.ai-factory/state/<change-id>/explore.md` or equivalent runtime notes

Does not write:

- `openspec/changes/<change-id>/proposal.md`
- `openspec/changes/<change-id>/design.md`
- `openspec/changes/<change-id>/tasks.md`
- `openspec/changes/<change-id>/specs/**/spec.md`
- legacy `.ai-factory/plans` artifacts in OpenSpec-native mode

Exploration is research-only until promoted into canonical OpenSpec artifacts by planning or refinement.

### `/aif-roadmap`

Reads:

- `.ai-factory/config.yaml`
- project context and rules
- current `.ai-factory/ROADMAP.md`
- OpenSpec-native evidence under `openspec/specs/**` and `openspec/changes/**`
- local source, tests, CI, runtime state, QA evidence, and generated rules when relevant
- optional GitHub milestones, issues, PRs, labels, and linked branches when available
- current git tree, changed files, tags, and recent commits when available

Writes:

- configured roadmap artifact, `.ai-factory/ROADMAP.md` by default

Does not write:

- GitHub issues, milestones, PRs, labels, or linked branches
- `openspec/changes/**`
- `openspec/specs/**`
- `.ai-factory/state/<change-id>/`
- `.ai-factory/qa/<change-id>/`
- `.ai-factory/rules/generated/**`
- implementation source files

GitHub state is supporting evidence only. Closed issues, completed milestones, and merged PRs are useful signals, but local artifact evidence remains required before marking roadmap items `done`. If GitHub evidence is unavailable, unauthenticated, rate-limited, offline, or partial, `/aif-roadmap` continues from local evidence and summarizes the limitation without writing credentials or private authentication diagnostics.

When GitHub milestones are available, `/aif-roadmap` treats milestones as roadmap phases. Closed milestones produce phase audit sections with linked issues/PRs and local evidence status. Open milestones with `open_issues = 0` produce `phase-completion drift` instead of being treated as closed. Milestone-bound issues/PRs attach to their phase, while unmilestoned issues/PRs remain in `unphased backlog/drift`.

### `/aif-improve`

Reads:

- `openspec/changes/<change-id>/proposal.md`
- `openspec/changes/<change-id>/design.md`
- `openspec/changes/<change-id>/tasks.md`
- `openspec/changes/<change-id>/specs/**/spec.md`
- `openspec/specs/**/spec.md`
- project context and generated rules when relevant

Writes:

- patch-style edits to `proposal.md`, `design.md`, `tasks.md`, and `specs/**/spec.md`
- optional runtime evidence under `.ai-factory/state/<change-id>/`

Does not write:

- `task.md`, `context.md`, `rules.md`, `verify.md`, or `status.yaml` under OpenSpec changes
- legacy `.ai-factory/plans` artifacts in OpenSpec-native mode
- archived changes under `openspec/changes/archive/**` unless the user explicitly chooses a supported recovery path

The task quality refinement step is optional and repeatable. It keeps patch-style edits to existing canonical artifacts and audits intent, scope, non-goals, C4 impact, ADR candidates, dependency notes, executable checklist quality, behavior deltas, and open questions. Open questions may be classified as blocker, warn, or info when useful without requiring that structure for trivial changes.

When `aifhub.openspec.validateOnImprove` is enabled, refinement requests OpenSpec validation through the runner after canonical artifact edits. Missing CLI is a degraded warning unless `aifhub.openspec.requireCliForImprove` is true.

### `/aif-implement`

Reads:

- `openspec/changes/<change-id>/proposal.md`
- `openspec/changes/<change-id>/design.md`
- `openspec/changes/<change-id>/tasks.md`
- `openspec/changes/<change-id>/specs/**/spec.md`
- `openspec/specs/**/spec.md`
- `.ai-factory/rules/generated/*.md` when present
- optional OpenSpec `instructions apply` output when `aifhub.openspec.useInstructionsApply` is enabled and a compatible CLI is available

Runtime todo behavior:

- `openspec/changes/<change-id>/tasks.md` is the canonical implementation checklist.
- When the runtime exposes a todo or plan tool, `/aif-implement` mirrors checkbox tasks into runtime todo state before editing.
- In Codex this uses `update_plan` when available.
- If no todo tool is available, `/aif-implement` reports a task snapshot as a capability fallback and continues from `tasks.md`.
- Runtime todo hydration does not authorize broad task expansion; execution remains one task or one tightly coupled task group.

Writes:

- implementation source files in the selected task scope
- `.ai-factory/state/<change-id>/implementation/`
- task progress in `openspec/changes/<change-id>/tasks.md`

Does not write:

- runtime traces under `openspec/changes/<change-id>/`
- legacy `.ai-factory/plans/<id>/task.md`
- canonical OpenSpec artifacts outside the selected implementation scope unless the user explicitly expands scope

After implementation, optional read-only gates are available before final verification:

```text
/aif-rules-check
/aif-review
/aif-security-checklist
```

The authoritative final verification remains `/aif-verify <change-id>`.

### `/aif-rules-check`

Reads:

- `.ai-factory/rules/generated/openspec-merged-<change-id>.md`
- `.ai-factory/rules/generated/openspec-change-<change-id>.md`
- `.ai-factory/rules/generated/openspec-base.md`
- `.ai-factory/rules/generated/openspec-rules-trace-<change-id>.json`
- `.ai-factory/rules/generated/index.json`
- `.ai-factory/RULES.md`
- `.ai-factory/rules/base.md`
- optional canonical OpenSpec context under `openspec/specs/**` and `openspec/changes/<change-id>/**`

Writes:

- none

`/aif-rules-check` is optional after implementation or fixes and useful for strict/high-risk changes. In OpenSpec-native mode it uses generated rules first, loads trace JSON when present, returns a final `aif-gate-result` with `gate: "rules"`, and does not regenerate generated rules.

When `requireRulesPassForDone` is true, save the final `/aif-rules-check` output, or at least its final `aif-gate-result` block, to `.ai-factory/qa/<change-id>/rules.md`. Generated rules freshness and rules gate pass are separate signals.

```bash
ai-factory aifhub-write-gate-evidence \
  --change add-oauth-login \
  --gate rules \
  --from /tmp/aif-rules-check-output.md
```

```bash
ai-factory aifhub-write-gate-evidence --change add-oauth-login --gate rules
```

In the stdin form, paste or pipe the Markdown gate output into the command.

Generated-rule `FAIL` findings must cite trace-backed `source.path` and `source.requirement`. The generated trace includes output hashes for generated markdown, so status/doctor can warn when generated rule text is manually edited without source-spec changes. If the generated trace is missing or invalid, generated-rule findings are capped at `WARN`; rerun sync to regenerate trace metadata.

If generated rules or generated trace metadata are missing or stale:

```text
/aif-rules-check
/aif-mode sync --change <change-id>
/aif-rules-check
```

### `/aif-review`

Reads:

- changed files
- OpenSpec context and generated rules when available
- optional reviewed Context7 notes under `.ai-factory/references/context7/` or `.ai-factory/state/<change-id>/context7/` for version-sensitive API review

Writes:

- none

`/aif-review` is an optional read-only code review gate. It returns a final `aif-gate-result` with `gate: "review"`, is useful before `/aif-verify` or for high-risk changes, and does not write OpenSpec, runtime, or QA artifacts.

Review findings may use Context7 as supporting documentation context only. Findings still need changed-file evidence, canonical OpenSpec context, generated rules, runtime state, QA evidence, or other direct repository evidence; missing Context7 is degraded context, not a review failure.

### `/aif-security-checklist`

Reads:

- changed files
- OpenSpec context and generated rules when available

Writes:

- none

`/aif-security-checklist` is an optional security gate. It is recommended for auth, secrets, permissions, filesystem, shell, external service, API boundary, or data-handling changes. It returns a final `aif-gate-result` with `gate: "security"` and does not write artifacts.

### `/aif-verify`

Reads:

- canonical OpenSpec specs and change artifacts
- generated rules when present
- runtime state under `.ai-factory/state/<change-id>/`
- changed files and verification commands for the repository

Writes:

- `.ai-factory/qa/<change-id>/verify.md`
- `.ai-factory/qa/<change-id>/coverage.json`
- `.ai-factory/qa/<change-id>/openspec-validation.json`
- `.ai-factory/qa/<change-id>/openspec-status.json`
- `.ai-factory/qa/<change-id>/raw/`

`coverage.json` records OpenSpec requirement coverage as `requirement -> task -> implementation evidence -> tests -> rules gate`. `verify.md` includes the coverage summary and ends with a final fenced `aif-gate-result` JSON block using `"gate": "verify"` and `status` of `pass`, `warn`, or `fail`.

Does not write:

- `openspec/specs/**`
- `openspec/changes/archive/**`
- final archive output
- legacy `.ai-factory/specs` archives in OpenSpec-native mode

Invalid OpenSpec validation is a hard stop before code checks. Missing or unsupported CLI, generated rules, rules gate evidence, or coverage evidence is degraded mode unless the matching verify policy flag is true. `openspec-status.json` is written when `aifhub.openspec.statusOnVerify` is enabled. Missing requirement coverage makes verify `fail` in strict mode and `warn` in normal mode.

### `/aif-fix`

Reads:

- the same canonical OpenSpec artifacts as `/aif-implement`
- QA evidence under `.ai-factory/qa/<change-id>/`
- generated rules when present

Writes:

- implementation fixes in the selected finding scope
- `.ai-factory/state/<change-id>/fixes/`

Does not write:

- runtime traces under `openspec/changes/<change-id>/`
- legacy `.ai-factory/plans/<id>/task.md`
- canonical specs unless the user explicitly asks to fix the spec itself

After fixes, rerun:

```text
/aif-verify <change-id>
```

### `/aif-done`

Reads:

- `openspec/changes/<change-id>/**`
- passing verification evidence from `.ai-factory/qa/<change-id>/`
- the latest valid verify `aif-gate-result` block from `.ai-factory/qa/<change-id>/verify.md`
- current coverage evidence from `.ai-factory/qa/<change-id>/coverage.json`
- durable rules gate evidence from `.ai-factory/qa/<change-id>/rules.md` when policy requires it
- the read-only AIFHub OpenSpec artifact contract result
- the pre-archive readiness result produced by the extension-local `scripts/openspec-done-readiness.mjs` implementation module
- git working tree state

Writes:

- `.ai-factory/qa/<change-id>/done-readiness.json`
- `.ai-factory/qa/<change-id>/done.md`
- `.ai-factory/qa/<change-id>/openspec-archive.json`
- `.ai-factory/qa/<change-id>/raw/`
- `.ai-factory/state/<change-id>/final-summary.md`
- `openspec/specs/**` only through `openspec archive <change-id> --yes`

Does not write:

- custom manual mutations to `openspec/specs/**`
- manual file moves from `openspec/changes` to archives
- legacy `.ai-factory/specs` archives in OpenSpec-native mode

For newly authored docs/tooling-only changes on OpenSpec `>=1.7.0`, prefer native `.openspec.yaml` metadata with `skip_specs: true`; preserve the schema selected for the change. With an older supported CLI, keep the explicit proposal reason and compatibility finalizer path. The public `--skip-specs` finalizer flag remains supported for explicit compatibility finalization. Archive-required finalization needs a compatible OpenSpec CLI when `aifhub.openspec.requireCliForDone` is true. `/aif-done` runs a pre-archive readiness gate and refuses archive on blocking OpenSpec validate, artifact contract, generated rules, rules gate, coverage, verify gate, or dirty workspace failures. The readiness output includes the exact next command to run.

The stable installed-project executable route is:

```bash
ai-factory aifhub-done-finalizer --change <change-id> --json
```

For docs/tooling-only finalization, use `ai-factory aifhub-done-finalizer --change <change-id> --skip-specs --json`. Do not execute `scripts/openspec-done-finalizer.mjs`, `scripts/openspec-done-readiness.mjs`, or `scripts/openspec-runner.mjs` as consumer-project commands. The wrapper rejects unknown options and bypass flags such as `--force`, `--no-validate`, `--skip-archive`, `--dry-run`, and `--summary-only`. Its bounded output omits raw stdout/stderr, environment data, full runtime context, and private absolute paths.

Exit codes are `0` for successful or policy-accepted warning finalization, `1` for a resolved readiness/archive blocker, and `2` for invalid arguments, unresolved or ambiguous scope, or an unexpected command failure.

A dirty workspace is blocking by default before archive. Inspect with `git status --short`; commit or stash unrelated changes, or rerun `ai-factory aifhub-done-finalizer --change <change-id> --record-dirty-state --json` when the current dirty state should be recorded in final QA evidence before archive. For docs/tooling-only finalization, preserve both public flags with `ai-factory aifhub-done-finalizer --change <change-id> --skip-specs --record-dirty-state --json`.

If `requireRulesPassForDone` is true and readiness reports missing rules gate evidence, `suggested_next.command` points to `ai-factory aifhub-write-gate-evidence --change add-oauth-login --gate rules --from <rules-output.md>`. The accompanying reason tells you to rerun `/aif-rules-check` first and persist its final output, or at least the final `aif-gate-result` block, to `.ai-factory/qa/<change-id>/rules.md`.

Next steps after `/aif-done`:

1. Run `/aif-mode sync` to refresh derived artifacts after OpenSpec archive.
2. Run `/aif-commit` to commit implementation, OpenSpec archive/spec changes, QA evidence, and final summaries.
3. Optionally run `/aif-evolve` when the change produced durable workflow or skill learnings.

`/aif-done` finalizes the OpenSpec lifecycle. It does not replace `/aif-commit`.

### `/aif-commit`

Reads:

- staged changes and current diff
- `.ai-factory/qa/<change-id>/done.md` when present
- `.ai-factory/qa/<change-id>/openspec-archive.json` when present
- `.ai-factory/state/<change-id>/final-summary.md` when present
- OpenSpec archive/spec changes produced by `/aif-done`
- configured roadmap artifact, `.ai-factory/ROADMAP.md` by default
- optional GitHub issue, PR, milestone, label, and linked branch freshness context when available

Writes:

- git commit through the upstream AI Factory commit workflow

Does not write:

- `.ai-factory/ROADMAP.md`
- GitHub issues, milestones, PRs, labels, or linked branches
- OpenSpec lifecycle artifacts manually
- `.ai-factory/qa/<change-id>/`
- `.ai-factory/state/<change-id>/`
- `.ai-factory/rules/generated/**`

In OpenSpec-native mode, `/aif-commit` normally runs after `/aif-done`. It performs a read-only roadmap/GitHub freshness gate before the upstream commit prompt. Stale roadmap findings are warning-first unless strict checking was explicitly requested, and each stale finding should hand off to `/aif-roadmap`. The command still writes only the git commit after user confirmation.

Generic `## Commit Plan` grouping is parent-owned in AI Factory 2.13+. AIFHub must not duplicate this grouping logic, and `/aif-commit` remains the only commit owner. The AIFHub `aif-commit` injection is only a read-only roadmap/GitHub freshness overlay.

In OpenSpec-native mode, if an active OpenSpec change is available, commit planning should use `openspec/changes/<change-id>/tasks.md` as the source that may contain `## Commit Plan`. When upstream `/aif-commit` detects that plan section, preserve its grouping prompt and add only roadmap/GitHub freshness findings before the commit proposal. Do not remove or contradict upstream options: `Follow Commit Plan`, `Commit everything together`, or `Adjust grouping`.

If no active change/plan resolves, keep upstream staged-diff behavior.

### `/aif-distillation`

AI Factory 2.13+ includes `/aif-distillation`. It is an upstream utility skill for turning books, docs, folders, or URLs into reusable Agent Skills.

AIFHub boundaries:

- `/aif-distillation` is not an AIFHub lifecycle stage.
- It does not create OpenSpec changes.
- It must not write `openspec/changes/**`, `openspec/specs/**`, `.ai-factory/qa/**`, or `.ai-factory/rules/generated/**`.
- It writes generated skill packages to the current agent skills directory.

Useful AIFHub inputs include `docs/memory-tools-research/`, `docs/context-providers.md`, and internal docs or external guides that should become reusable skills:

```text
/aif-distillation docs/memory-tools-research --name aifhub-memory-tool-selection
/aif-distillation docs/context-providers.md --name aifhub-context-providers
```

### `/aif-evolve`

`/aif-evolve` is optional after commit/finalization. Use it when the implementation, fix, or finalization evidence contains durable lessons that should improve future skills or skill-context. It should not mutate OpenSpec canonical artifacts.

## OAuth Example

Create the change:

```text
/aif-plan full "add OAuth login"
```

Expected canonical artifacts:

```text
openspec/changes/add-oauth-login/
  proposal.md
  design.md
  tasks.md
  specs/
    auth/
      spec.md
```

Refine, sync, implement, gate, verify, finalize, sync, commit, and optionally evolve:

```text
/aif-improve add-oauth-login
/aif-mode sync --change add-oauth-login
/aif-implement add-oauth-login
/aif-rules-check
/aif-verify add-oauth-login
/aif-mode doctor --change add-oauth-login
/aif-done add-oauth-login
/aif-mode sync
/aif-commit
/aif-evolve
```

Expected runtime and QA output:

```text
.ai-factory/state/add-oauth-login/
.ai-factory/qa/add-oauth-login/
```

Implementation and verification traces stay out of `openspec/changes/add-oauth-login/`.

## Legacy AI Factory-Only Mode

Legacy AI Factory-only mode is still supported for compatibility. It is not the normal OpenSpec-native v1 creation path.

Legacy AI Factory-only mode is not the default OpenSpec-native workflow. Its task intake normalization uses the companion plan folder instead of canonical OpenSpec change artifacts:

- `.ai-factory/plans/<plan-id>/task.md`
- `.ai-factory/plans/<plan-id>/context.md`
- `.ai-factory/plans/<plan-id>/rules.md`
- `.ai-factory/plans/<plan-id>/verify.md`
- `.ai-factory/plans/<plan-id>/status.yaml`
- `.ai-factory/plans/<plan-id>/explore.md`

No `task-prepare.md` artifact is required for the MVP, and `/aif-task-prepare` is not an active AIFHub path.

Legacy planning writes:

```text
.ai-factory/plans/<plan-id>.md
.ai-factory/plans/<plan-id>/
  task.md
  context.md
  rules.md
  verify.md
  status.yaml
  explore.md
```

Upstream `/aif-archive` may later move completed legacy plan files from `paths.plans/*.md` to `paths.archive/plans/*.md`. The default `paths.archive` root is `.ai-factory/archive/`. Archived legacy plans are excluded from active sequential plan numbering and discovery; this does not affect OpenSpec-native `openspec/changes/<change-id>/` directories.

Use the explicit migration command when existing legacy artifacts need to enter the OpenSpec-native workflow:

```bash
ai-factory aifhub-migrate-legacy-plans <change-id> --dry-run
ai-factory aifhub-migrate-legacy-plans <change-id>
```

After migration, run:

```text
/aif-improve <change-id>
```

See [Legacy Plan Migration](legacy-plan-migration.md).

## Mode Switching and Sync

Use `/aif-mode status` before changing modes:

```text
/aif-mode status
```

For installed-project automation, call the stable extension wrappers:

```bash
ai-factory aifhub-mode sync --change <change-id> --json
ai-factory aifhub-mode doctor --change <change-id> --json
```

Switch to OpenSpec-native mode:

```text
/aif-mode openspec --dry-run
/aif-mode openspec
```

If legacy plans exist, review migration first:

```bash
ai-factory aifhub-migrate-legacy-plans --all --dry-run
ai-factory aifhub-migrate-legacy-plans --all
```

Switch to legacy AI Factory-only mode without deleting OpenSpec artifacts:

```text
/aif-mode ai-factory
```

Export compatibility legacy files only when requested:

```text
/aif-mode ai-factory --export-openspec --change <change-id> --yes
```

Refresh derived artifacts without changing mode:

```text
/aif-mode sync --change <change-id>
/aif-mode sync
/aif-mode doctor
```

Use `/aif-mode sync --change <change-id>` before implementation and after refinement. Use `/aif-mode sync` after `/aif-done` to refresh base generated rules from accepted specs after archive.

## Recommended Codex App Flow

Codex cannot switch modes from extension prompts. The user controls the mode manually.

```text
# Plan mode, user action
$aif-explore "task description"
$aif-plan full "task description"
$aif-improve <change-id>
$aif-mode sync --change <change-id>

# Default mode, user action
$aif-implement <change-id>
$aif-rules-check
$aif-verify <change-id>
$aif-done <change-id>
$aif-mode sync
$aif-commit
```

Slash-command runtimes use the same workflow with `/aif-*` commands.

In Codex Default mode, prompts must ask plain-text questions rather than using `request_user_input`.

When implementation starts, Codex should hydrate runtime todo state from the selected OpenSpec `tasks.md` checklist with `update_plan` when available. If no todo tool is available, it should show a task snapshot and continue from canonical `tasks.md`.

See [Codex Plan Mode](codex-plan-mode.md) for question-format guidance.

## Troubleshooting

| Problem | Meaning | Action |
|---|---|---|
| OpenSpec CLI missing | `openspec` is not available on `PATH`. | Continue degraded planning or install a compatible CLI before validation/archive-required finalization. |
| Node too old | OpenSpec validate/archive requires Node `>=20.19.0`. | Use Node `>=20.19.0` for OpenSpec commands. |
| Invalid delta spec | OpenSpec validation failed for `specs/**/spec.md`. | Fix the delta spec and rerun `/aif-verify <change-id>`. |
| Ambiguous active change | More than one active change can be selected. | Pass `<change-id>` explicitly or update `.ai-factory/state/current.yaml`. |
| Missing generated rules | Derived rules are absent. | Regenerate `.ai-factory/rules/generated/*.md` from OpenSpec specs before relying on rules guidance. |
| Stale generated rules | Generated rules do not match canonical OpenSpec artifacts. | Regenerate them; do not edit generated rules as source of truth. |
| Missing or stale coverage | `.ai-factory/qa/<change-id>/coverage.json` is absent or fingerprints no longer match source artifacts. | Rerun `/aif-verify <change-id>` to regenerate coverage before `/aif-done`. |
| Artifact contract failure | Canonical OpenSpec artifacts, runtime state, QA evidence, or generated rules violate the AIFHub contract. | Fix the reported path or run the suggested command from `artifactContract.suggested_next`. |
| Dirty working tree before `/aif-done` | Finalization cannot prove archive/summary scope safely. | Inspect with `git status --short`; commit or stash unrelated changes, or rerun `ai-factory aifhub-done-finalizer --change <change-id> --record-dirty-state --json` to record the dirty workspace in final QA evidence before archive. |

## Release Smoke Checks

1. Check the AI Factory version:

```bash
ai-factory --version
```

Expected range:

```text
>=2.11.0 <3.0.0
```

The supported range is tracked in `aifhub-extension.json -> compat.ai-factory`.

2. Install the extension:

```bash
ai-factory extension add https://github.com/ichinya/aifhub-extension.git
```

3. Run an OpenSpec-native smoke:

```text
/aif-analyze
/aif-plan full "smoke check feature"
/aif-improve <change-id>
/aif-implement <change-id>
/aif-verify <change-id>
```

Expected OpenSpec-native artifacts:

```text
openspec/changes/<change-id>/
.ai-factory/state/<change-id>/
.ai-factory/qa/<change-id>/
.ai-factory/qa/<change-id>/coverage.json
```

Legacy `.ai-factory/plans/` artifacts are expected only when the project is intentionally in legacy AI Factory-only mode.

4. Run local repository checks:

```bash
npm run validate
npm test
```

`npm run validate` checks the split manifest contract: upstream `extension.json`, private `aifhub-extension.json`, bundled agent files, and docs links.

## See Also

- [Documentation Index](README.md)
- [Memory Tool Recommendations](memory-tool-recommendations.md)
- [Context Loading Policy](context-loading-policy.md)
- [OpenSpec Compatibility](openspec-compatibility.md)
- [OpenSpec Coverage Matrix](spec-coverage.md)
- [Legacy Plan Migration](legacy-plan-migration.md)
- [Active Change Resolver](active-change-resolver.md)
- [ADR 0001](adr/0001-openspec-native-artifact-protocol.md)
- [ADR 0002: Optional Project Glossary](adr/0002-optional-project-context-glossary.md)
