[К документации](README.md) | [К README](../README.md) | [Следующая страница](context-providers.md)

# Usage

This guide documents the v1 OpenSpec-native workflow for AIFHub Extension.

```text
setup and mode:
  /aif-mode status                                  # recommended
  /aif-analyze                                      # required once per project
  /aif-mode openspec                                # required when switching modes
  /aif-mode doctor                                  # optional readiness check

session startup (AI Factory 2.19 source snapshot):
  /aif-warmup                                       # optional read-only handoff

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

Upstream project-context utilities such as `/aif-warmup`, `/aif-architecture`, `/aif-roadmap`, `/aif-docs`, `/aif-qa`, `/aif-archive`, and `/aif-distillation` remain available with AIFHub guardrails. They are not required per-change OpenSpec lifecycle gates.

The `aifhub-extension` package repository stays artifact-light: root `openspec/`, `.ai-factory/state/`, `.ai-factory/qa/`, `.ai-factory/plans/`, and `.ai-factory/rules/generated/` are not extension package source. Root `.ai-factory/rules/generated/` is derived in user projects and safe to regenerate. OpenSpec examples may be committed only under fixture paths such as `test/fixtures/` or `scripts/fixtures/`.

AIFHub commands request OpenSpec validation, status, instructions, and archive through the extension-local `scripts/openspec-runner.mjs` implementation module when the CLI is available. Installed projects must not execute that module from the consumer root or an internal installed path. Slash-command runtimes should keep using `/aif-*` commands. Codex app uses `$aif-*` skill invocations, as shown in the Recommended Codex App Flow. This extension does not install or rely on OpenSpec slash commands.

The shared resolver selects one CLI source per operation in deterministic order: explicit non-empty extension API `options.command`, project-local `node_modules/.bin/openspec` (`openspec.cmd` on Windows), then `openspec` from `PATH`. An explicit or project-local selection is authoritative and never silently falls through after failure. AIFHub does not run `npx`, search parent projects, download, or auto-install OpenSpec. Missing or unsupported CLI remains degraded for filesystem-based planning/context loading; archive-required finalization still refuses until a compatible CLI is available. Human and JSON diagnostics expose only a safe project-relative/bounded command and `explicit`, `project-local`, or `path` source.

## Session Warmup (AI Factory 2.19 Source Snapshot)

The reviewed AI Factory `2.x` source snapshot declaring `2.19.0` adds upstream `/aif-warmup`. It reads configured DESCRIPTION, ARCHITECTURE, ROADMAP, RESEARCH, the scoped rules hierarchy, applicable `AGENTS.md`, and optional extra context, then stops with a compact read-only handoff. It does not plan or implement in the same invocation.

Fresh configs created through AIFHub mode/bootstrap tooling include the upstream empty default:

```yaml
warmup:
  paths: []
```

`warmup.paths` is user-owned. Entries are ordered, literal, project-relative files or directories; upstream warmup rejects absolute paths and `..` escapes, does not follow symlinks, skips likely secrets and binary content, and reports missing or oversized input instead of silently truncating it. AIFHub mode switches preserve existing path entries and comments without interpreting them, but may normalize EOLs or move the top-level block relative to managed sections. An existing config with no `warmup` section is not backfilled because absence is equivalent to an empty list.

AIFHub adds no `/aif-warmup` skill or injection. The optional `paths.context` glossary, reviewed provider notes, canonical OpenSpec changes, QA evidence, and generated rules are not implicitly added to startup context. A user may explicitly add a safe reviewed file or directory to `warmup.paths`; raw provider output, credentials, and validation evidence remain subject to the existing context and artifact boundaries.

The same upstream snapshot adds a root `apm.yml` with `type: skill` and `includes: auto`. That manifest distributes upstream AI Factory skills only; it is not evidence that the npm CLI or AIFHub extension assets were installed. Continue to use `ai-factory extension add` and `ai-factory extension update` for AIFHub wrapper commands, injections, MCP templates, and managed agent files.

## Prompt Language Resolution

AIFHub resolves human-readable response prose in this order:

1. Use a usable non-empty `language.ui`, even when the current conversation uses another language.
2. If `language.ui` is missing, blank, or unusable, preserve the current conversation language for the current response only.
3. Use English only when the conversation language is indeterminate.

OS locale and repository programming language are not inputs. The fallback is ephemeral and does not persist the inferred choice to config, rules, memory, generated artifacts, runtime state, or QA evidence. Configured and identifiable-conversation paths do not add a setup hint.

On the hard fallback to English, include exactly one concise setup hint to configure `language.ui` or run `/aif-analyze` only when the active output contract permits human-readable prose. Place it before any required final `aif-gate-result` block, never inside or after that block. An exact-output-only branch wins: no additional hint or prose is appended, and exact handoffs, fixed commands, paths, keys/enums, and machine-only output remain unchanged.

This resolver affects UI prose only. `language.artifacts` remains separate for durable artifact prose, while commands, filenames, identifiers, JSON/YAML keys, package names, and CLI flags remain in English according to the shared policy.

## Optional Project Glossary

Projects may configure a protocol-neutral glossary for preferred human-readable terminology:

```yaml
paths:
  context: CONTEXT.md
```

The key is valid in OpenSpec-native and legacy AI Factory-only profiles, and a custom project-relative value is preserved during mode switches. The file itself is optional: missing or empty content does not block any command and `/aif-mode` never creates or validates it.

`/aif-analyze` is the only AIFHub writer. Creation requires explicit opt-in plus concrete source-grounded terms; updates require an explicit request or accepted proposal and preserve manual/unknown sections. All other commands are read-only consumers. The glossary affects prose only and cannot override source/tests, canonical OpenSpec requirements, project rules, accepted architecture decisions, or verifiable QA facts. See [Context Loading Policy](context-loading-policy.md) and [ADR 0002](adr/0002-optional-project-context-glossary.md).

## Project Review Policy

Projects configure durable code review guidance independently of artifact mode:

```yaml
reviews:
  policy_file: REVIEW.md
```

`/aif-analyze` creates a missing safe scaffold at the configured project-relative Markdown path through `ai-factory aifhub-review-policy scaffold --json`; the default is repository-root `REVIEW.md` for cross-agent discovery. Existing policy is preserved during ordinary bootstrap, and `/aif-mode` preserves the setting without creating or inspecting the file.

`/aif-review` and the AIFHub review sidecars use `ai-factory aifhub-review-policy load --json` and consume only a complete `present` path/revision/content snapshot. The resolver binds and revalidates the opened file identity, rejects symlink/Windows junction components, canonical escapes, managed-file collisions, and canonical/generated/runtime/QA protected roots. It may focus review or add checks, but cannot suppress material findings, expand scope, authorize edits/tools, or replace project rules, tests, security checks, `/aif-verify`, `/aif-done`, or human approval. Per-review findings, comments, replies, resolution/stale state, revisions, provider state, and receipts do not belong in the durable policy. See [Project Review Policy](review-policy.md) and [ADR 0003](adr/0003-durable-project-review-policy.md).

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

## Опциональные Skill Providers

External skill providers меняют decision policy агента, поэтому для них действует более строгий boundary, чем для context providers. Центральная policy и exact evaluation evidence находятся в [Skill Providers](skill-providers.md).

Ponytail `v4.9.0` имеет status `manual_experiment_only`: user может отдельно проверить его на одном bounded `/aif-implement <change-id>` task в isolated implementation-only session. AIFHub не устанавливает и не bundles provider, не trusts его lifecycle hooks, не injects его instructions, не предлагает его автоматически и не считает availability или output gate evidence.

Always-on `full`/`ultra` plugin mode не должен охватывать `/aif-explore`, `/aif-plan`, `/aif-improve`, `/aif-rules-check`, `/aif-review`, `/aif-security-checklist`, `/aif-verify`, `/aif-fix`, `/aif-done` или `/aif-commit`. Canonical OpenSpec requirements, selected tasks, project rules, required tests, artifact ownership и AIFHub output contracts всегда ограничивают minimal-solution preference. Upstream `100% safe` означает pass конкретных deterministic adversarial scorers и не заменяет AIFHub semantic security gate.

## Опциональные Token Providers

RTK `v0.48.0` оценён как user-owned overview tool со статусом `reject_defer` для рекомендации или automatic integration. AIFHub не устанавливает binary/hooks, не меняет agent instructions и не добавляет `rtk gain` в `/aif-analyze`. Отсутствие RTK не блокирует workflow.

Для review, verification и fix нужны полные raw diffs, history, protected artifacts и test diagnostics. `rtk proxy` сохраняет raw output, но продолжает tracking аргументов; исключение команды из rewrite тоже не гарантирует отсутствия локального хранения. Полная policy, проверенная форма config, ограничения `tee`/tracking и результаты probes находятся в [Token Providers](token-providers.md).

Выполнен [A/B через ai-tester и Pi](token-providers-research/rtk/ai-tester-ab.md) на трёх проектах с Ornith: baseline 12/12, RTK 9/12; суммарно −20,2% токенов при нестабильной экономии и трёх ошибках результата. Сценарии и агрегаты доступны в отчёте.

Отдельный [мультирепозиторный A/B](token-providers-research/rtk/multirepo-ab.md) на трёх связанных копиях с метками дал baseline 11/12, RTK 12/12 и −15,8% токенов в 24 запусках. Восстановление полной диагностики увеличило расход этого сценария на 10,5%; ограничения хранения данных сохраняют статус `reject_defer`.

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

## AI Factory 2.18 Artifact Profiles

The resolved artifact mode and the explicit command-position profile token determine ownership. AIFHub never enables `ultra` from extension metadata alone.

| Artifact mode | Planning profile | Authoritative shape | AIFHub behavior |
|---|---|---|---|
| OpenSpec-native | regular/full | `proposal.md`, `design.md`, `tasks.md`, applicable delta specs | canonical OpenSpec workflow |
| OpenSpec-native | explicit `ultra`, stable AI Factory `>=2.18.0` | the same canonical files with a stricter Ultra Detail Gate | no `index.md`, `phase-*`, companion files, or active ultra marker |
| Legacy AI Factory-only | classic | `<id>.md` plus classic companion directory | existing AIFHub classic compatibility workflow |
| Legacy AI Factory-only | explicit `ultra`, stable AI Factory `>=2.18.0` | `<id>/index.md` plus direct `phase-NN-<slug>.md`, exactly one `<!-- aif:plan-mode:ultra -->`; `index.md` is the only checkbox/progress ledger | marker-first exact upstream handoff; no sibling classic plan or companion synchronization |

An explicit `ultra` request with missing, malformed, prerelease, unsupported `<2.18.0`, or provenance-matched CLI/project version evidence stops before writes and suggests the regular profile. When stable project metadata exists, different unverified global/PATH-only CLI evidence is ignored with a bounded warning and does not override the project version. A valid legacy ultra bundle is handled atomically; invalid marker/phase shapes and classic/ultra collisions fail closed.

Research is supporting context in both artifact modes. Regular `/aif-explore <topic>` writes only the resolved `paths.research` file. Explicit `/aif-explore ultra <topic>` on stable 2.18 derives `<parent(paths.research)>/research/<english-topic-slug>/` without adding a config key. The minimum bundle is marked `INDEX.md` plus `RESEARCH.md`; C4, ADR, and dependency-graph files are created only when their evidence gates apply. Neither research profile becomes canonical OpenSpec content.

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
- `.ai-factory/state/legacy-plan-source.json` when unresolved legacy work was captured during mode switching
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

When switching away from a custom legacy `paths.plans` root with unresolved work, `/aif-mode` records that safe project-relative root in `.ai-factory/state/legacy-plan-source.json`. Later OpenSpec-mode status, sync, and migration reuse the captured root instead of scanning `openspec/changes`. `--legacy-source <dir>` is an explicit one-run override. A root that lexically or physically overlaps canonical changes is rejected before writes.

`/aif-mode sync --change <change-id>` is recommended after `/aif-plan full` or `/aif-improve` and whenever canonical specs or tasks changed during implementation or fixes. It ensures OpenSpec skeleton paths, compiles `.ai-factory/rules/generated/openspec-base.md`, `.ai-factory/rules/generated/openspec-change-<change-id>.md`, `.ai-factory/rules/generated/openspec-merged-<change-id>.md`, `.ai-factory/rules/generated/openspec-rules-trace-<change-id>.json`, and `.ai-factory/rules/generated/index.json`, requests OpenSpec validation/status when the CLI is available and `validateOnSync` is enabled, detects legacy plans in OpenSpec mode, and writes a sync report under `.ai-factory/state/mode-switches/`.

`/aif-mode sync` without `--change` is recommended after `/aif-done`. After archive, there may be no active change. Sync still refreshes `.ai-factory/rules/generated/openspec-base.md` and `.ai-factory/rules/generated/index.json` from `openspec/specs/**`, skips change-specific generated rules and change validation when no active changes exist, and writes a sync report. OpenSpec skills are not installed.

`/aif-mode sync --all` is a maintenance sweep. It refreshes generated rules for active changes and validates selected changes that contain `openspec/changes/<change-id>/specs/**/spec.md` delta specs or declare native `skip_specs: true` in `openspec/changes/<change-id>/.openspec.yaml`. It reports older unmarked no-delta changes as `no-delta-specs` warnings. Invalid native markers are validated fail-closed instead of being silently skipped. `/aif-verify <change-id>` remains the stricter verification gate for a specific change.

Generated-rule reconciliation uses the full authoritative active-change inventory independently from the selected compilation scope. Base sources are collected once, every selected overlay and exact target is prepared before the first mutation, and `index.json` is finalized once. `--all` rebuilds exact active membership; targeted/resolved sync preserves active sibling entries while pruning archived state; ambiguous base-only sync prunes without compiling overlays; no-active sync leaves an empty `changes` set.

Cleanup is limited to direct regular files under the canonical `.ai-factory/rules/generated/` root with exact names `openspec-change-<safe-id>.md`, `openspec-merged-<safe-id>.md`, or `openspec-rules-trace-<safe-id>.json`. The command preserves unknown files, directories, symlinks/reparse points, raw index paths, canonical artifacts, QA/state evidence, and external paths; none are cleanup targets. Inventory failures, noncanonical config, unsafe metadata, and incomplete malformed-index rebuilds fail closed before mutation; malformed index rebuild is allowed only with complete active coverage or no active changes.

Use `--dry-run --json` to review sorted project-relative `would-write`/`would-remove` operations. Public output and reports include `operation_count`, `operations_truncated`, and at most 200 details without limiting the internal validated plan. A byte-identical second sync produces no generated operations even with a later clock. A failure after commit begins reports `partial`; the normal bounded sync report is still written so `status`/`doctor` can diagnose remaining drift.

`/aif-mode doctor --change <change-id>` includes the read-only AIFHub OpenSpec artifact contract check and the latest coverage matrix diagnostic. It reports the full JSON result as `artifactContract`, reports coverage as `coverage`, and treats missing verification evidence as a pre-archive readiness failure. See [OpenSpec Artifact Validation](openspec-validation.md) and [OpenSpec Coverage Matrix](spec-coverage.md).

Generated-rule membership audit always covers every active change; only expensive trace/hash reads retain the 50-change cap. Orphan index entries/files, missing active index or managed files, malformed index data, and managed-name collisions are non-green. Benign unknown children do not affect status.

For CLI or IDE runtimes, planning commands may recommend an available planning mode for structured questions, but they must not fabricate unavailable tools or client actions. Codex mode switching remains a user action; see [Codex Plan Mode](codex-plan-mode.md).

### `/aif-archive`

`/aif-archive` is an upstream AI Factory 2.14+ legacy plan cleanup command, extended upstream in 2.18 for marked ultra directories. It is not the OpenSpec-native finalization command.

Reads in legacy AI Factory-only mode:

- completed legacy plan files under `paths.plans/*.md`
- marked ultra bundle directories under `paths.plans/<id>/` in AI Factory 2.18
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

In OpenSpec-native mode, AIFHub classifies raw arguments before resolving `paths.plans`. Plan-mutating no-argument, `--all`, and explicit targets stop before plan discovery or archive writes and return the exact owner handoff `/aif-done <change-id>`. Read-only `list` may inspect only archived inventories; roadmap-only `--roadmap` retains its upstream confirmation and bounded roadmap snapshot ownership. Invalid/conflicting arguments stop without discovery.

`/aif-archive` must not run `openspec archive <change-id> --yes`. Finalize a verified OpenSpec change with `/aif-done <change-id>` after `/aif-verify <change-id>`.

### `/aif-analyze`

Reads:

- project files and repository metadata
- existing `.ai-factory/config.yaml` when present
- existing rules/context artifacts when present
- existing configured review policy when present

Writes:

- `.ai-factory/config.yaml`
- `.ai-factory/rules/base.md`
- missing safe `reviews.policy_file` scaffold (`REVIEW.md` by default)
- configured `paths.context` project glossary only after explicit user opt-in
- optional OpenSpec-native skeleton paths such as `openspec/specs/`, `openspec/changes/`, `.ai-factory/state/`, `.ai-factory/qa/`, and `.ai-factory/rules/generated/`

Does not write:

- OpenSpec skills or slash commands
- canonical change artifacts for a feature request
- `.ai-factory/plans` in OpenSpec-native mode
- an empty or unapproved glossary placeholder
- an existing review policy during ordinary bootstrap

Select OpenSpec-native mode explicitly by asking for it or by starting from config with:

```yaml
aifhub:
  tools:
    openspec: true
    hlv: false
    lekalo: false
```

When `.ai-factory/config.yaml` is missing and the user did not explicitly ask for a protocol, `/aif-analyze` asks one artifact protocol question before writing config or creating mode-specific directories:

- `legacy AI Factory-only`
- `OpenSpec-native`

Existing configs are not prompted again. Codex Default mode asks this as plain text; Codex Plan mode may use `request_user_input`; autonomous/subagent runs default to legacy AI Factory-only and report OpenSpec-native mode as an open question.

If localization questions run first, `/aif-analyze` carries those answers forward and writes them only after the artifact protocol is selected, so language persistence does not accidentally lock in the legacy default.

The OpenSpec boolean selects the artifact profile; HLV and Lekalo are independent additional tools. Legacy `tools.openspec: false` configs do not include `aifhub.openspec` settings or OpenSpec runtime path defaults; OpenSpec-native `tools.openspec: true` configs include those settings and paths explicitly.

After saving tool choices, `/aif-analyze` runs `ai-factory aifhub-mode init --json`; mode switching and sync perform the same initialization. Run that command after direct flag edits, or add `--dry-run` for a preview. Enabled OpenSpec gets missing directories/config; enabled HLV reuses root `project.yaml` or `.hlv/project.yaml` without changing paths, contracts or milestones. If neither exists, installed HLV 1.0.0 initializes the existing repository with `--adopt`, keeping source in place. Existing root HLV projects do not need a `.hlv/` directory. See [provider lifecycle](validation-providers.md#lifecycle) for native scaffold effects and explicit setup failures.

Config creation and mode changes structurally patch only explicit AIFHub-owned keys. They preserve upstream/core fields, unknown top-level fields, unknown nested `aifhub` fields, custom paths, and unknown user-authored fields inside a dormant profile. Known AIFHub-owned `aifhub.openspec` settings are omitted from the legacy profile, including known `allowWarnOnDone` children; the dormant block remains only when unknown fields must survive a later switch back. Diagnostics report bounded changed/preserved key paths and counts only; they do not log values, environment data, provider configuration, or credentials. Ultra research derives its root from `paths.research`; `research_bundles_dir` is not a config key.

The config records the aif-analyze skill version that last bootstrapped or updated it under `analyze.skill_version`; the structural patcher preserves an existing value. Before patching an existing config, `/aif-analyze` runs the deterministic required-keys diff instead of LLM-based key comparison:

```bash
ai-factory aifhub-analyze-config-diff --json
```

The command is read-only, compares `.ai-factory/config.yaml` against the extension-local `skills/aif-analyze/references/config-keys.json` manifest and the installed skill's frontmatter version, and reports `missing` keys with their purpose text, deprecated keys still present (`obsolete`), `version_drift`, and `up_to_date`. Manifest entries with `modes` apply only to the effective artifact mode derived from `aifhub.tools.openspec`, so OpenSpec-only paths do not create false drift in legacy `ai-factory` mode. Unknown user-owned keys are never reported. A config that is up to date takes the fast path and skips re-analysis; missing keys are presented to the user with their purposes before being written.

In OpenSpec-native mode, `/aif-analyze` also compares the selected compatible CLI with AIFHub's latest reviewed stable version. An older supported CLI remains usable for validation/archive capabilities, but the handoff recommends a user-owned update and identifies whether the selected source is `project-local`, `path`, or `explicit`. The skill never guesses a package manager, installs or updates OpenSpec, or recommends downgrading a supported version that is already equal to or newer than the reviewed baseline.

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
- regular resolved `paths.research` or one exact revision-bound ultra `RESEARCH.md` selected by the shared resolver

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
- `tasks.md`: executable implementation checklist; every task states its completion verification inline as a test, command, observable behavior, or delivered artifact, with separate verification tasks reserved for broader cross-task integration or system behavior
- `specs/**/spec.md`: behavior-changing requirements and scenarios

When `/aif-improve` encounters a legacy `tasks.md` without inline verification, it applies a bounded checklist migration to each affected checkbox. Only the missing verification clause is appended; task numbers, checked/unchecked states, order, original actions and intent are preserved, and already compliant unrelated checkboxes remain unchanged.

When the request explicitly links an issue, milestone, or roadmap item, `proposal.md` also records the standardized `## Roadmap Linkage` section:

- `Issues`: canonical HTTPS work-item URL or stable MCP resource URI, optionally comma-separated
- `Milestone`: exact GitHub milestone title or explicit `none`
- `Roadmap item/slice`: exact local roadmap item or explicit `none`
- `Rationale`: one bounded explanation of the linkage

Planning preserves explicit `none` values and does not infer linkage from a branch name, issue title, label, or unrelated roadmap text. If any linkage field is non-`none`, the planning response returns `/aif-roadmap check`; the roadmap owner may then register the active change as local `planned`. Planning does not claim implementation, verification, finalization, merge, or issue closure.

When planning input or a selected structured MCP record contains exactly one explicit primary work item, AIFHub uses its readable external ID as the plan prefix. GitHub `156`, Linear `ENG-431`, Jira `PROJ-77`, and an opaque YouGile fallback such as `yougile-a1b2c3d4` produce IDs such as `156-fix-login-timeout`, `eng-431-fix-login-timeout`, `proj-77-refresh-token`, and `yougile-a1b2c3d4-refresh-token`. The request slug keeps repeated external IDs readable while the full source binding below keeps them distinct across providers, tenants, and repositories.

A source-bound OpenSpec proposal persists identity separately from the many-valued roadmap fields:

```markdown
## AIFHub Source Binding

- Provider: linear
- Primary source: mcp://linear/issue/6a1f24c8
- External ID: ENG-431
- Branch: feature/some-request-slug
```

`Primary source` is the only collision identity. `Provider` and `External ID` make the binding readable but cannot authorize reuse alone. A secondary reference in `Roadmap Linkage.Issues`, including the same external ID from another provider or repository, cannot replace the primary binding. Ordinary plans omit the complete reserved section. The exact attached creation branch maps the prefixed change back to downstream `/aif-improve`, `/aif-implement`, and `/aif-verify`; one exact binding is checked before ordinary slug branch variants. After successful source-bound creation or refinement, planning also writes the complete resolved change ID to the current-change pointer. If several active plans intentionally share the creation branch, that pointer selects one of the exact candidates; otherwise resolution reports `ambiguous-branch-binding`. Malformed or prefix-mismatched metadata declaring the current branch fails closed, while an unrelated invalid binding becomes a warning and is excluded from slug matching.

Legacy classic plans persist the same Markdown section in the parent plan and synchronized double-quoted `source_binding.provider`, `source_binding.primary_source`, `source_binding.external_id`, and `source_binding.branch` values in companion `status.yaml`. Creation and explicit branch rebind validate both surfaces together; the tolerant reader also accepts consistently deeper indentation and single-quoted YAML scalars. Marked ultra keeps the Markdown binding in its upstream-owned `index.md` and does not gain a companion status file. Legacy `slug` identifiers use the same `<external-id>-<slug>` form. Sequential mode preserves its required four-digit prefix: numeric IDs in `1..9999` can occupy it (`0156_fix-login-timeout`), while alphanumeric IDs begin the semantic stem after an upstream ordinal (`0042_PROJ-77-refresh-token`).

A bare number, PR URL, branch name, title, label, milestone, or discovered search result does not establish this binding. The planner reads structured MCP `identifier`, `key`, `number`, or display-ID fields; when only an opaque stable ID exists, it creates a provider-prefixed short key and preserves the full value in a stable `mcp://` primary source. Multiple linked items retain ordinary mode-specific IDs unless one is explicitly primary. Existing artifacts are reused only when their exact `Primary source` matches; roadmap-list membership and external-ID equality are insufficient. Otherwise planning stops with `source-plan-id-collision` and never overwrites or drops the external-ID prefix.

`/aif-plan full` does not create `/aif-task-prepare`, does not create `.ai-factory/specs/<task-id>.md`, and does not create `task-prepare.md`. Raw input trace, normalization confidence, and temporary notes belong only under `.ai-factory/state/<change-id>/` when they are persisted.

Docs/tooling-only changes may omit delta specs only when the proposal explains why no product or workflow behavior changes.

When an explicitly requested behavior change removes the final requirement of a capability, OpenSpec `>=1.8.0` planning may add `retire_capabilities: true` to `.openspec.yaml`. This destructive intent must come from the user; planning must not infer capability retirement merely because a `REMOVED` delta leaves no requirements. Older supported CLIs require an upgrade before that change can be archived.

When `aifhub.openspec.validateOnPlan` is enabled, planning requests `openspec validate` through the AIFHub OpenSpec runner if a compatible CLI is available. Missing CLI is a degraded warning unless `aifhub.openspec.requireCliForPlan` is true.

Explicit `/aif-plan ultra <request>` first resolves exact AI Factory support. In OpenSpec-native mode on stable `>=2.18.0`, the upstream Ultra Detail Gate enriches exact files/symbols, ordered edits, contracts/data flow, failure handling, bounded logging, tests, rollback, and verification detail inside canonical `design.md` and `tasks.md`. It must not write `index.md`, `phase-NN-*.md`, companion files, or `<!-- aif:plan-mode:ultra -->` under the canonical change. In legacy mode the same token hands creation to upstream before AIFHub classic normalization.

### `/aif-explore`

Reads:

- `.ai-factory/config.yaml`
- project context and rules
- directly relevant in-repository source, tests, docs, package/manifest files, and bounded local Git branch/revision metadata
- `openspec/specs/**/spec.md`
- `openspec/changes/<change-id>/**` when exploring an existing change
- the exact referenced legacy plan pair in Legacy AI Factory-only mode

Writes, exactly one profile per run:

- regular: the resolved `paths.research` file, `.ai-factory/RESEARCH.md` by default
- explicit stable-2.18 ultra: `<parent(paths.research)>/research/<english-topic-slug>/INDEX.md`, `RESEARCH.md`, and only evidence-gated C4/ADR/dependency artifacts

Does not write:

- `openspec/changes/<change-id>/proposal.md`
- `openspec/changes/<change-id>/design.md`
- `openspec/changes/<change-id>/tasks.md`
- `openspec/changes/<change-id>/specs/**/spec.md`
- legacy `.ai-factory/plans` artifacts in OpenSpec-native mode
- `.ai-factory/state/<change-id>/explore.md` and `.ai-factory/qa/<change-id>/`

Exploration is research-only until promoted into canonical OpenSpec artifacts by planning or refinement.

Before the full research run or any write, `/aif-explore` turns the request into a dependency-aware research brief. It resolves repository and configuration facts through bounded read-only inspection, asks only user-owned decisions whose prerequisites are settled, groups independent questions into rounds with a recommendation for each, and recomputes the decision frontier after every answer batch. Confirmation becomes available only after every user-owned brief decision is settled and no prerequisite fact-finding remains pending. An empty frontier with unresolved decisions behind blocked or cyclic prerequisites is blocked, not complete: the agent reports the blocker and smallest evidence-producing or dependency-breaking next action without presenting the brief for confirmation or starting full research.

Pre-confirmation inspection creates no new read permission. In OpenSpec-native mode, it is restricted to the injection's `Allowed read context` and `Enabled optional tool use` boundaries. In Legacy AI Factory-only mode, it is restricted to `.ai-factory/config.yaml`, safe resolved configured project context and rules, the exact referenced legacy plan pair, directly relevant in-repository source/tests/docs/package manifests, and bounded local Git branch/revision metadata. Neither mode may use the interview to read outside the project root, inspect environment or credential stores, consume raw optional-provider stores/output, scan unrelated repositories, or enable an optional provider solely for the interview.

Once the interview is complete, research starts only after the user confirms the normalized brief; this confirmation is required even for an already precise request. In autonomous or subagent mode, assumptions satisfy neither unresolved brief decisions nor confirmation. The agent first returns unresolved decisions, assumptions, blockers, and open questions to the interactive parent. Only after every brief decision is settled does it return the normalized brief with a `research-brief-confirmation-required` blocker. The only autonomous or subagent re-entry condition is that the interactive parent passes back both the exact normalized brief previously returned and an explicit statement that the user confirmed that exact brief without changes. That forwarded confirmation satisfies the confirmation gate for the resumed run and must not trigger another confirmation request; changed brief content or confirmation not explicitly bound to that brief returns to the unresolved-decision or confirmation-blocker flow. Do not create a separate interview, design-tree, decision-log, or research-brief file; the confirmed brief remains conversation context for the existing regular or ultra research output.

Regular and ultra research are mutually exclusive writes for one run. A valid ultra `INDEX.md` contains exactly one standalone `<!-- aif:research-mode:ultra -->`, one supported status, and a safe direct `RESEARCH.md` link in `## Artifact Index`. Selection precedence is an explicit safe `RESEARCH.md` path, an exact slug, then exactly one reviewed materially relevant active bundle. Ambiguity stops with `ultra-research-ambiguous`; recency and fuzzy matching never break the tie. Planning/implementation consumers bind to the selected source path, active summary, revision, and digest; sibling C4/ADR/graph rationale cannot expand scope unless reflected in the active summary.

On AI Factory `2.18.1`, every permitted persisted regular or ultra write continues into the upstream-owned `Research Coherence Gate` before presentation/session append. AIFHub does not copy the gate: optional fresh-context `Task` delegation has the same direct read-only fallback, and ultra coherence must PASS before the Bundle Integrity Gate.

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

`/aif-roadmap check` independently reconciles canonical local lifecycle and current GitHub state. Active proposals with valid non-`none` `## Roadmap Linkage` become `planned`; archived changes with durable done/archive evidence become or remain `finalized`. Local lifecycle uses only `planned` and `finalized`; GitHub open/closed/merged state stays in the phase audit and never substitutes for local finalization evidence. A post-merge refresh updates issue, PR, and milestone observations while preserving the evidence-backed local row.

The local rows live only inside one managed block:

```markdown
<!-- aifhub:roadmap-change-lifecycle:start -->
## OpenSpec Change Lifecycle
...
<!-- aifhub:roadmap-change-lifecycle:end -->
```

`/aif-roadmap` owns the full roadmap and may create or reconcile this block. `/aif-done` co-owns only the marker-bounded transition for one linked change after successful archive. Content outside the markers remains under `/aif-roadmap` ownership and must be preserved. Missing or partial GitHub evidence does not block local reconciliation; output reports lifecycle and GitHub evidence sources separately without credentials or private diagnostics.

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
- Runtime todo hydration does not authorize broad task expansion; execution covers one task, one tightly coupled task group, or one explicit small same-shape batch validated by the coordinator. Before edits/dispatch, scan task conflicts; for a batch, enumerate every task/file/change/check and reconcile completion per item. See [task coordination](../skills/shared/TASK-COORDINATION.md).

Development cycle for a testable behavior change:

- **RED**: choose or add the narrowest useful automated check and observe the intended behavioral failure before editing production code.
- **GREEN**: make the smallest in-scope production change and rerun the same check.
- **REFACTOR**: perform only bounded cleanup and keep the same check green.
- Persist `testCheck`, `redResult`, `greenResult`, `refactorResult`, and `fallbackDecision` in the implementation trace under `.ai-factory/state/<change-id>/implementation/`.
- For docs-only work, generated artifacts, explicitly authorized no-test scope, or no useful automated check, record the fallback and run the narrowest applicable non-test verification instead of fabricating RED evidence.

This is supporting runtime evidence, not an authoritative QA verdict. See [Адаптация идей Superpowers](superpowers-adaptation.md).

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

Next-step routing between the gates and verification is one-way with terminal states: when `/aif-verify <change-id>` passes, the suggested next step is `/aif-done <change-id>` — a rerun of `/aif-rules-check` or `/aif-verify` is not suggested after a passing verification; when verification fails, the route is `/aif-fix <change-id>` — except when the blocking failure is missing, stale, or invalid durable rules gate evidence, where the recovery step is rerunning `/aif-rules-check <change-id>` and persisting its final gate block through `ai-factory aifhub-write-gate-evidence`. A passing `/aif-rules-check` suggests `/aif-verify <change-id>` only when verification has not already passed for the current change state; a failing `/aif-rules-check` routes to `/aif-mode sync --change <change-id>` and a rerun, never to `/aif-verify`. A passing gate keeps `suggested_next` `null` when `status` is `pass` in its `aif-gate-result` block; terminal and forward routing is prose guidance only, never encoded in the machine-readable field.

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
- configured `reviews.policy_file` (`REVIEW.md` by default) when safe, readable, and non-empty
- optional reviewed Context7 notes under `.ai-factory/references/context7/` or `.ai-factory/state/<change-id>/context7/` for version-sensitive API review

Writes:

- none

`/aif-review` is an optional read-only code review gate. It returns a final `aif-gate-result` with `gate: "review"`, is useful before `/aif-verify` or for high-risk changes, and does not write OpenSpec, runtime, or QA artifacts.

The configured review policy is additional guidance, not standalone evidence that a defect exists. Missing or empty policy is non-blocking; unsafe or unreadable policy degrades custom guidance. When policy materially affects a result, the review may name only its state and normalized project-relative path in human-readable evidence and never copies the full policy into `aif-gate-result`.

Review runs in two ordered passes: **plan/spec compliance** first, then **code quality** inside the validated scope. A code-quality pass cannot erase or downgrade a compliance finding; both passes contribute to one findings-first verdict and one final review gate.

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

`coverage.json` records OpenSpec requirement coverage as `requirement -> task -> implementation evidence -> tests -> rules gate`. `verify.md` includes the coverage summary and ends with a final fenced `aif-gate-result` JSON block using `"gate": "verify"` and `status` of `pass`, `warn`, or `fail`. A passing block keeps `suggested_next` `null`.

Does not write:

- `openspec/specs/**`
- `openspec/changes/archive/**`
- final archive output
- legacy `.ai-factory/specs` archives in OpenSpec-native mode

Invalid OpenSpec validation is a hard stop before code checks. Missing or unsupported CLI, generated rules, rules gate evidence, or coverage evidence is degraded mode unless the matching verify policy flag is true. `openspec-status.json` is written when `aifhub.openspec.statusOnVerify` is enabled. Missing requirement coverage makes verify `fail` in strict mode and `warn` in normal mode.

In legacy mode, marker-first classification happens before classic companion discovery. For a valid marked ultra bundle, AIFHub returns exact `/aif-verify <entrypoint>` and upstream verifies the bundle atomically. Only after one final validated upstream `aif-gate-result` may the verify command boundary write `.ai-factory/state/legacy-ultra-verification/<entrypoint-digest>.json`. The receipt contains bounded schema/entrypoint, bundle digest, Git `HEAD` or explicit manual build id, deterministic worktree digest, timestamp, source command, and structured gate outcome; it never stores phase bodies, raw stdout/stderr, or credentials. No classic companion, QA, OpenSpec, or finalization file is written for this branch.

### `/aif-fix`

Reads:

- the same canonical OpenSpec artifacts as `/aif-implement`
- QA evidence under `.ai-factory/qa/<change-id>/`
- generated rules when present

Writes:

- implementation fixes in the selected finding scope
- `.ai-factory/state/<change-id>/fixes/`

Before editing, the fixer records `rootCauseEvidence`, one falsifiable `hypothesis`, and the smallest discriminating `experiment`. It tests one hypothesis at a time, then runs the exact `regressionCheck` before and after the smallest supported root-cause fix. Three failed hypotheses trigger reassessment and a no-edit stop rather than stacked speculative changes.

The fix trace records `rootCauseEvidence`, `hypothesis`, `experiment`, `regressionCheck`, `preFixResult`, `postFixResult`, and `fallbackDecision`. This remains supporting runtime evidence; `/aif-verify <change-id>` is authoritative.

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
- the linked change row inside the configured roadmap's marker-bounded `OpenSpec Change Lifecycle` block, only after successful OpenSpec archive

Does not write:

- custom manual mutations to `openspec/specs/**`
- manual file moves from `openspec/changes` to archives
- legacy `.ai-factory/specs` archives in OpenSpec-native mode
- arbitrary roadmap content outside the managed lifecycle markers

For newly authored docs/tooling-only changes on OpenSpec `>=1.7.0`, prefer native `.openspec.yaml` metadata with `skip_specs: true`; preserve the schema selected for the change. With an older supported CLI, keep the explicit proposal reason and compatibility finalizer path. For explicitly authorized capability retirement on OpenSpec `>=1.8.0`, preserve `retire_capabilities: true`; never infer this destructive marker. The public `--skip-specs` finalizer flag remains supported for explicit compatibility finalization. Archive-required finalization needs a compatible OpenSpec CLI when `aifhub.openspec.requireCliForDone` is true. `/aif-done` runs a pre-archive readiness gate and refuses archive on blocking OpenSpec validate, artifact contract, generated rules, rules gate, coverage, verify gate, or dirty workspace failures. The readiness output includes the exact next command to run.

The stable installed-project executable route is:

```bash
ai-factory aifhub-done-finalizer --change <change-id> --json
```

Omitting `--change` delegates to the active-change resolver: exactly one resolvable active change may be selected, while missing or ambiguous scope exits with code `2` before finalization. Automation should always pass an explicit `--change <change-id>`.

For docs/tooling-only finalization, use `ai-factory aifhub-done-finalizer --change <change-id> --skip-specs --json`. Do not execute `scripts/openspec-done-finalizer.mjs`, `scripts/openspec-done-readiness.mjs`, or `scripts/openspec-runner.mjs` as consumer-project commands. The wrapper rejects unknown options and bypass flags such as `--force`, `--no-validate`, `--skip-archive`, `--dry-run`, and `--summary-only`. Its bounded output omits raw stdout/stderr, environment data, full runtime context, and private absolute paths.

Exit codes are `0` for successful or policy-accepted warning finalization, `1` for a resolved readiness/archive blocker, and `2` for invalid arguments, unresolved or ambiguous scope, or an unexpected command failure.

A dirty workspace is blocking by default before archive. Inspect with `git status --short`; commit or stash unrelated changes, or rerun `ai-factory aifhub-done-finalizer --change <change-id> --record-dirty-state --json` when the current dirty state should be recorded in final QA evidence before archive. For docs/tooling-only finalization, preserve both public flags with `ai-factory aifhub-done-finalizer --change <change-id> --skip-specs --record-dirty-state --json`.

If `requireRulesPassForDone` is true and readiness reports missing rules gate evidence, `suggested_next.command` points to `ai-factory aifhub-write-gate-evidence --change add-oauth-login --gate rules --from <rules-output.md>`. The accompanying reason tells you to rerun `/aif-rules-check` first and persist its final output, or at least the final `aif-gate-result` block, to `.ai-factory/qa/<change-id>/rules.md`.

For a linked change, `/aif-done` reads the pre-archive canonical `## Roadmap Linkage` and changes only its managed local row to `finalized` after successful OpenSpec archive. A pre-archive failure leaves the managed lifecycle unchanged. A post-archive roadmap update failure preserves truthful archive and final evidence, returns a bounded `handoff` with `/aif-roadmap check`, and does not roll back archive or fabricate the row. Local finalization does not claim that a GitHub issue is closed or a pull request is merged; GitHub state is reconciled later by `/aif-roadmap check`.

Next steps after `/aif-done`:

1. Run `/aif-mode sync` to refresh derived artifacts after OpenSpec archive.
2. Run `/aif-commit` to commit implementation, OpenSpec archive/spec changes, QA evidence, and final summaries.
3. Optionally run `/aif-evolve` when the change produced durable workflow or skill learnings.

`/aif-done` finalizes the OpenSpec lifecycle. It does not replace `/aif-commit`.

For a marked legacy ultra entrypoint, `/aif-done` is a read-only receipt evaluator, not a finalizer writer. It recomputes the bundle, exact entrypoint, source revision, and deterministic worktree bindings on every run. Only a current exact `pass` receipt returns `/aif-archive <entrypoint>`; missing, malformed, stale, wrong-entrypoint, wrong-revision/worktree, `warn`, `pass-with-notes`, or `fail` returns `/aif-verify <entrypoint>`. `/aif-done` executes neither handoff and writes no ultra, companion, OpenSpec, QA, spec-index, or receipt artifact.

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

In OpenSpec-native mode, `/aif-commit` normally runs after `/aif-done`. It performs a read-only roadmap/GitHub freshness gate before the upstream commit prompt. Deterministic local lifecycle drift is an unskippable `ERROR [roadmap-local]` when durable evidence proves successful local finalization, the proposal has non-`none` `## Roadmap Linkage`, and the managed `OpenSpec Change Lifecycle` row is missing or not exactly `finalized`. The command hands off to `/aif-roadmap check`, stops before the commit proposal, and does not create a git commit; user confirmation cannot bypass this error.

Unavailable, partial, or later-changing GitHub evidence is volatile external drift reported as `WARN [roadmap-external]` and remains warning-only by default. In that warning-only case, `/aif-commit` may continue to the upstream confirmation flow and still writes only the git commit after user confirmation. The freshness gate remains read-only: it never updates the configured roadmap artifact, OpenSpec artifacts, QA/runtime evidence, generated rules, or GitHub objects.

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

AI Factory 2.18 marked ultra planning is a separate atomic shape:

```text
.ai-factory/plans/<plan-id>/
  index.md              # exactly one <!-- aif:plan-mode:ultra --> and the sole progress ledger
  phase-01-<slug>.md
  phase-02-<slug>.md
```

Do not create a sibling `<plan-id>.md` or classic `task.md`, `context.md`, `rules.md`, `verify.md`, `status.yaml`, or `explore.md` for a valid marked ultra bundle. `/aif-improve`, `/aif-implement`, `/aif-verify`, and `/aif-fix` return the matching exact upstream command. After upstream verification, the bounded receipt described above is the only AIFHub write; `/aif-done` routes to upstream archive only for a current exact pass.

Upstream `/aif-archive` may later move completed legacy plan files from `paths.plans/*.md` to `paths.archive/plans/*.md`. The default `paths.archive` root is `.ai-factory/archive/`. Archived legacy plans are excluded from active sequential plan numbering and discovery; this does not affect OpenSpec-native `openspec/changes/<change-id>/` directories.

Use the explicit migration command when existing legacy artifacts need to enter the OpenSpec-native workflow:

```bash
ai-factory aifhub-migrate-legacy-plans <change-id> --dry-run
ai-factory aifhub-migrate-legacy-plans <change-id>
```

Migration is classic-only. It reports valid marked ultra as skipped and blocks malformed ultra-like shapes or classic/ultra collisions. If `/aif-mode` captured a former custom plan root, use the recorded `.ai-factory/state/legacy-plan-source.json` binding or pass `--legacy-source <project-relative-plans-root>` explicitly; canonical `openspec/changes` is never scanned as legacy input.

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

For a custom pre-switch plan root, keep the source explicit in the review command when needed:

```bash
ai-factory aifhub-migrate-legacy-plans --all --legacy-source <project-relative-plans-root> --dry-run
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
| OpenSpec CLI supported but outdated | `/aif-analyze` reports `versionOutdated: true` against `latestReviewedVersion`. | Keep working if needed, then update the user-owned project-local, PATH/global, or explicit installation with its existing package manager and rerun `ai-factory aifhub-mode status --json`. |
| Node too old | OpenSpec validate/archive requires Node `>=20.19.0`. | Use Node `>=20.19.0` for OpenSpec commands. |
| Invalid delta spec | OpenSpec validation failed for `specs/**/spec.md`. | Fix the delta spec and rerun `/aif-verify <change-id>`. |
| Ambiguous active change | More than one active change can be selected. | Pass `<change-id>` explicitly or update `.ai-factory/state/current.yaml`. |
| Missing generated rules | Derived rules are absent. | Regenerate `.ai-factory/rules/generated/*.md` from OpenSpec specs before relying on rules guidance. |
| Stale generated rules | Generated rules do not match canonical OpenSpec artifacts. | Regenerate them; do not edit generated rules as source of truth. |
| Missing `REVIEW.md` | No custom durable review guidance is available. | Continue with the standard review contract, or run `/aif-analyze` to create the configured scaffold. |
| Unsafe review policy path | `reviews.policy_file` is absolute, URI-like, escaping, non-portable, non-Markdown, a directory, linked through a symlink/junction/hard link, collides with a managed file, or falls under a canonical/generated/runtime/QA protected root. | Configure a regular unowned project-relative Markdown path; review continues without custom policy. |
| Missing or stale coverage | `.ai-factory/qa/<change-id>/coverage.json` is absent or fingerprints no longer match source artifacts. | Rerun `/aif-verify <change-id>` to regenerate coverage before `/aif-done`. |
| Artifact contract failure | Canonical OpenSpec artifacts, runtime state, QA evidence, or generated rules violate the AIFHub contract. | Fix the reported path or run the suggested command from `artifactContract.suggested_next`. |
| Dirty working tree before `/aif-done` | Finalization cannot prove archive/summary scope safely. | Inspect with `git status --short`; commit or stash unrelated changes, or rerun `ai-factory aifhub-done-finalizer --change <change-id> --record-dirty-state --json` to record the dirty workspace in final QA evidence before archive. |
| Explicit ultra rejected | AI Factory version evidence is missing, prerelease, `<2.18.0`, malformed, or conflicts with provenance-matched CLI evidence. | Use the regular plan/research profile or provide a matching stable local 2.18+ project toolchain; no ultra artifact was written. |
| Unverified AI Factory CLI warning | Stable project metadata exists, but global/PATH-only CLI evidence reports a different version without proven matching project provenance. | Keep the project metadata as authoritative; the unverified CLI evidence is ignored and does not reject ultra by itself. |
| Legacy ultra asks to verify again | The receipt is missing, non-pass, or stale against bundle/revision/worktree. | Run the exact `/aif-verify <entrypoint>` handoff; do not edit the receipt or create classic companions. |
| Plan-mutating `/aif-archive` in OpenSpec-native mode | `/aif-done` owns OpenSpec finalization. | Run `/aif-verify <change-id>`, then `/aif-done <change-id>`; archive `list` and roadmap-only modes remain separate upstream submodes. |

## Local Consumer Smoke Checks

The checked-in deterministic harness always runs offline through the default test glob:

```bash
npm test
```

It injects fake exact `2.17.0`/`2.18.1` executors into the production orchestration layer and covers version/provenance preflight, clean install, global update, dummy-extension isolation, stale managed-agent replacement, injection cardinality, artifact/config/unmanaged preservation, and exact transfer inventory. `2.18.0` remains a separate stable feature boundary for ultra and upstream transfer inventory (`>=2.18.0`).

The live driver is opt-in and non-globbed. It accepts only caller-supplied local command-plus-argv toolchains and package roots:

```bash
npm run smoke:ai-factory-2-18 -- --v217-command <absolute-executable> --v217-arg <absolute-2.17.0-bin-entrypoint> --v217-root <absolute-2.17.0-package-root> --v218-command <absolute-executable> --v218-arg <absolute-2.18.1-bin-entrypoint> --v218-root <absolute-2.18.1-package-root> --extension-root <absolute-local-extension-root>
```

Exact `package.json` provenance and reported `2.17.0`/`2.18.1` are checked before a temporary consumer project is created. The existing `--v217-*` and `--v218-*` flag names are retained. The process boundary uses bounded `execFile` with `shell: false`; Windows `.cmd` uses an explicit existing ComSpec adapter. No toolchain is downloaded or resolved through `npx`. Missing command/package/extension prerequisites are `NOT_RUN`, not PASS. Add `--allow-network` only when the caller intentionally accepts a network-backed upstream update check; transport failure is reported separately from extension contract failure.

The live flow runs three separately attributed checks:

1. Clean 2.18.1 all-skills init plus local extension add and OpenSpec mode assertion; exactly one upstream `aif-transfer`, with no AIFHub copy. The installed skill retains exact upstream `aif-explore` bytes, its Research Coherence Gate/`Task` capability, and one AIFHub injection marker.
2. A 2.17.0 selective project updated by exact `ai-factory update --force`; the current 2.18.1 base is refreshed before injections are reapplied. The flow preserves unknown config, unmanaged agent, classic/OpenSpec/marked-ultra artifact path sets and digests, upstream `aif-explore` bytes, and one-copy injections. Newly available `aif-transfer` is reported from observed inventory rather than claimed automatically.
3. Only after global result recording, a dummy extension is installed/snapshotted and one managed AIFHub agent is made stale; exact `ai-factory extension update aifhub-extension --force` must restore the source hash while dummy ledger/files remain byte-identical and upstream `aif-explore` bytes remain unchanged.

`ai-factory upgrade` is intentionally absent: it migrates v1 skill names to v2 and is not the 2.17.0-to-2.18.1 update command.

Local deterministic or live PASS proves only the isolated consumer contract. It does not prove package publication, registry availability, deployment, release readiness, or successful end-user migration.

The AI Factory 2.19 review is intentionally recorded as source-snapshot evidence. Because `2.19.0` had no Git tag, GitHub release, or npm package at the review boundary, the `smoke:ai-factory-2-18` driver remains the last published-executable compatibility smoke and must not be presented as a 2.19 PASS. Default tests separately lock fresh `warmup.paths: []`, no-backfill behavior, user-owned path and comment preservation, and upstream ownership.

Run repository validation separately:

```bash
npm run validate
npm test
```

`npm run validate` checks the split manifest contract: upstream `extension.json`, private `aifhub-extension.json`, bundled agent files, and docs links.

## See Also

- [Documentation Index](README.md)
- [Context Providers](context-providers.md)
- [Skill Providers](skill-providers.md)
- [Memory Tool Recommendations](memory-tool-recommendations.md)
- [Context Loading Policy](context-loading-policy.md)
- [OpenSpec Compatibility](openspec-compatibility.md)
- [OpenSpec Coverage Matrix](spec-coverage.md)
- [Legacy Plan Migration](legacy-plan-migration.md)
- [Active Change Resolver](active-change-resolver.md)
- [ADR 0001](adr/0001-openspec-native-artifact-protocol.md)
- [ADR 0002: Optional Project Glossary](adr/0002-optional-project-context-glossary.md)
- [Project Review Policy](review-policy.md)
- [ADR 0003: Durable Project Review Policy](adr/0003-durable-project-review-policy.md)
