[Предыдущая страница](context-providers.md) | [К документации](README.md) | [Следующая страница](context-dedup.md)

# Рекомендации По Memory Tools

AIFHub использует локальную metadata рекомендаций, чтобы во время анализа предлагать optional memory и context tools. Metadata живет в установленном extension, а не на GitHub:

```text
.ai-factory/extensions/aifhub-extension/docs/memory-tools-research/recommendation-metadata.yaml
```

При разработке самого extension можно использовать source-tree копию:

```text
docs/memory-tools-research/recommendation-metadata.yaml
```

## Команды

Установленные проекты должны использовать wrapper command:

```bash
ai-factory aifhub-memory-tools labels --from-project --json
ai-factory aifhub-memory-tools recommend --from-project --json
ai-factory aifhub-memory-tools recommend --command aif-analyze --shape large_framework_app --language js --volume standard --complexity framework --repo-shape single_repo --artifact-mode openspec_native --task architecture_or_impact_discovery --json
ai-factory aifhub-memory-tools recommend --shape large_framework_app --task architecture_or_impact_discovery --json
ai-factory aifhub-memory-tools select --from-project --command aif-explore --json
ai-factory aifhub-memory-tools select --from-project --command aif-plan --json
ai-factory aifhub-memory-tools status --json
ai-factory aifhub-memory-tools metadata --json
```

Wrapper находит scripts из установленного extension и оставляет рабочей директорией пользовательский проект.

Для разработки extension matrix scenarios могут использовать source-tree development-only fallback, описанный в research note, но installed-project документация и `ai-tester` scenarios должны предпочитать wrapper `ai-factory aifhub-memory-tools ...`.

## Правила

Recommender только советует:

- `rg` остается baseline для точного поиска файлов и symbols.
- Инструменты включаются только через explicit opt-in.
- Отсутствующие tools означают degraded context, а не failure команды.
- Provider output является только supporting context, никогда canonical OpenSpec evidence.
- AIFHub не должен auto-install tools, запускать setup, индексировать source, sync memory, register MCP servers, install hooks, start daemons или записывать provider output.
- Если metadata содержит поля, рекомендации включают allowed command scopes, forbidden command scopes, command-specific permission, privacy caveat, read scope, purge path, availability и explicit opt-in install policy.
- Context/compression tools не должны rewrite validation artifacts и не должны compress protected artifacts in place.
- `/aif-analyze` записывает только user-accepted tool ids в `utilities.context_tools.enabled`.
- Рекомендация с `normal_command_selection: forbidden` является recommendation-only manual guidance: ее нельзя предлагать для enablement или записывать в `utilities.context_tools.enabled`.
- Follow-on skills вызывают `select` для своей команды и используют только `selected_tools`; изменение списка tools должно требовать metadata/config changes, а не prompt rewrites.
- Recommender учитывает language, volume, complexity, repo shape, artifact mode и legacy `project_shape`. Если rich dimensions недоступны, сохраняется fallback на `project_shape`.
- Любой optional tool сравнивается с `rg`: сначала baseline search на том же task/profile, затем tool run только если selector и permissions разрешают его.
- `proven_label_evidence` может включить optional tool только при exact match по tool, skill, task, accepted run class и всем project labels; `known_avoid_cases` и command-specific forbidden scopes остаются сильнее.
- `rohitg00-agentmemory` остаётся source-denied `reject_default`: config enablement, continuity/manual-notes task labels и future positive labels не могут сделать его recommendation или `selected_tool`.

Protected validation artifacts:

- `aif-gate-result`
- `coverage.json`
- `done-readiness.json`
- `openspec/specs/**`
- generated-rules traces
- exact evidence snippets

## Решения По Tools

Три похожих имени обозначают разные providers и не взаимозаменяемы:

| Tool ID | Exact identity | Policy |
|---|---|---|
| `agent-memory` | [`jayzeng/agentmemory`](https://github.com/jayzeng/agentmemory), `myagentmemory 0.4.12` | Manual notes только по явному запросу. |
| `codex-agent-mem` | [`MarceloCaporale/codex-agent-mem`](https://github.com/MarceloCaporale/codex-agent-mem), Python package `1.0.2` | Optional read-only continuity с explicit SQLite DB. |
| `rohitg00-agentmemory` | [`rohitg00/agentmemory`](https://github.com/rohitg00/agentmemory), `@agentmemory/agentmemory`, `@agentmemory/mcp` | [`reject_default`](memory-tools-research/agentmemory-rohitg00.md); isolated safety [`PASS`](memory-tools-research/agentmemory-rohitg00-benchmark-results.md), full-product runtime `NOT_RUN`, runtime decision `avoid`. |

Разрешенные рекомендации:

- `rg`: baseline search.
- Graphify: optional repo graph для large framework, legacy и multirepo impact discovery после baseline `rg`.
- `codex-agent-mem`: optional read-only continuity memory с explicit SQLite DB path; это Python source package из GitHub repo, не npm package.
- `context-mode`: manual temporary index для explicit generated output или large command output.
- Context7: optional docs provider для version-sensitive library/API questions.
- `agent-memory`: manual notes только когда пользователь явно просит durable notes.
- CodeGraph: `manual_cli_only` + `avoid_by_default`; CLI scoped read и purge прошли explicit real-root testing. Selector может рекомендовать его только при exact `screening_policy` или `proven_label_evidence` match по skill + task + project labels; broad repo graph question, language или multirepo label сами по себе недостаточны. Уже готовый индекс можно переиспользовать только после `rg` и только если `files/query/context` дает полезную непустую выборку.

Не рекомендовать по умолчанию:

- `codex-mem`: default scope может ingest broad Codex history.
- `eagle-mem`: scoped read и purge behavior не доказаны.
- `rohitg00-agentmemory`: normal tasks, explicit config enablement и continuity/manual-notes signals не переопределяют `reject_default`; 2/2 isolated safety pairs прошли, но обе дали `avoid`, а full-product lifecycle не проверен. Допустим только явно переданный и проверенный user-owned output как supporting context.

AIFHub по-прежнему не принимает CodeGraph `install`, MCP serving, hooks/background services или agent configuration mutation.

## Dimension-Aware Selection

Metadata хранит project dimensions:

```yaml
project_dimensions:
  languages: [php, go, js, python, rust, multi]
  volume: [mini, standard, large]
  complexity: [mini, framework, legacy, integration_heavy]
  repo_shape: [single_repo, monorepo, multirepo]
  artifact_mode: [openspec_native, legacy_ai_factory_only, none]
```

Практический смысл:

- mini или exact lookup: оставить `rg`, избегать on-demand CodeGraph/Graphify/context-mode setup; уже готовый CodeGraph index не является default-рекомендацией.
- large framework или multirepo broad discovery: предлагать Graphify условно после `rg`; CodeGraph только при exact skill+task+labels screening/proven match.
- legacy integration-heavy: рекомендовать только conditional tools с явным объяснением noise/time tradeoff.
- Go service: Go label не дает CodeGraph recommendation; для repo graph оставлять Graphify/`rg`, пока нет exact screening match.
- docs/version tasks: Context7 только для version-sensitive library/API вопросов.
- continuity tasks: `codex-agent-mem` только для resume/open-work с explicit DB path.
- `rohitg00-agentmemory` не выбирается ни по project dimensions, ни по continuity/manual-notes task signals; `rg` остаётся baseline для source lookup.

Для `context-mode` Codex surface `v1.0.169` исторический static audit остаётся неизменным. Authorized live follow-up с `explicit_isolated_full` показал: MCP-only восстанавливает correctness при >1 MiB stdout truncation, но не экономит billed tokens (`+120.2%` против уже failed baseline); на small fixture overhead составил `+376.8%` tokens. Codex plugin не перехватил tested nested shell path, continuity остаётся `NOT_RUN(resume_driver_parity_unavailable)`. Test-only hook trust bypass был явно разрешён только для audited pinned snapshot в disposable sandbox. Повторный harness принимает его только как exact authorization field `hook_trust_mode: test_only_pinned_snapshot_bypass`; отдельный boolean или default generated step не даёт разрешения. Поэтому MCP можно только предложить как manual temporary helper для реально большого truncating output с purge, plugin для этого stack следует избегать. Любое использование остаётся явным user opt-in; normal AIFHub commands не устанавливают package, не register MCP, не доверяют hooks и не выбирают plugin. `rg` остаётся baseline.

Decision mapping из matrix:

| Decision | Что значит для рекомендации |
|---|---|
| `recommend` | Tool измеримо лучше `rg` для matching dimensions и проходит safety/purge. |
| `conditional` | Tool полезен только для конкретного task/profile, например multirepo mapping или docs lookup. |
| `avoid` | Tool не дает пользы относительно `rg` или добавляет overhead на этом profile. |
| `forbid` | Tool провалил safety, scope или purge и не должен использоваться. |
| `NOT_RUN` | Evidence неполна или недоступна; comparison и safety failure не выводятся из отсутствующих данных. |

## Безопасные Status Probes

`ai-factory aifhub-memory-tools status --json` может запускать только локальные non-mutating probes:

- `rg --version`
- `uv --version`
- `graphify --version` или `graphify --help`
- `codex-agent-mem-policy --help` или `codex-agent-mem-smoke --help`
- `ctx7 --version` или `npx --no-install ctx7 --help` только когда передан `--check-docs-provider`
- `codegraph --version`, `codegraph --help` или `codegraph status` только как availability probes

Для `context-mode` active executable probe отсутствует; metadata/runtime возвращают `dedicated_harness_required`, а проверка разрешена только pinned isolated harness для issue `#134`.

Для `rohitg00-agentmemory` executable status probe отсутствует; `status --json` возвращает `availability: unknown` и `command: null`.

Каждый `probes.<tool>` object содержит обязательные поля `availability` и `command`. Поля `reason` и `note` являются optional diagnostics для намеренно skipped или disabled probes.

Эти probes не должны install packages, run setup, register MCP servers, write hooks или start background processes. `codegraph init/index/query/uninit` разрешен только когда `select --command aif-explore --json` возвращает CodeGraph в `selected_tools` из-за exact screening/proven match, с `manual_purged_cli_execution`, explicit project path и purge через `codegraph uninit --force <project>`.

## Выбор Через Config

`/aif-analyze` должен сначала получить labels текущего проекта:

```bash
ai-factory aifhub-memory-tools labels --from-project --json
```

`labels` возвращает `available_labels`, `project_profile`, `selected_labels`, `matched_dimension_signals` и краткий `evidence` по выбранным labels. После этого `/aif-analyze` выбирает task signals из запроса и запускает `recommend` с явными labels из `project_profile`; `recommend --from-project` остается shortcut для диагностики и совместимости, но не основной flow анализа.

`recommendations` содержит только tools, которые можно предложить пользователю для enablement. Отдельный `manual_guidance` содержит non-configurable guidance: записи с `normal_command_selection: forbidden` и `configuration_policy: do_not_enable` не probe-ятся, не предлагаются для enablement и никогда не записываются в `utilities.context_tools.enabled`. Если legacy config всё ещё содержит такой tool, `select` оставляет его в `not_selected_tools` и возвращает warning `configured-tool-manual-guidance-only` с инструкцией удалить запись; config автоматически не переписывается.

Затем `/aif-analyze` спрашивает пользователя, какие рекомендации включить, и сохраняет accepted tool ids в config:

```yaml
utilities:
  context_tools:
    enabled:
      - codegraph
      - graphify
```

Compatibility flags вроде `utilities.graphify.enabled: true` и `utilities.codegraph.enabled: true` все еще читаются командой `select`, но стабильный provider list - это `utilities.context_tools.enabled`.

Во время выполнения skill используйте command-specific selection:

```bash
ai-factory aifhub-memory-tools select --from-project --command aif-explore --json
ai-factory aifhub-memory-tools select --from-project --command aif-plan --json
```

Selection output включает `selected_tools`, `not_selected_tools`, `permission`, `execution`, `forbidden_operations` и `protected_artifacts`. Metadata output включает такое же per-tool execution guidance, чтобы `/aif-analyze` мог показать доступные параметры без hard-code конкретного provider. Skill не должен использовать configured tools, которых нет в `selected_tools`.

## Evidence На Реальных Проектах

Follow-up smoke от 2026-05-23 использовал пять real local project roots, записанных только как anonymous profiles. `rg` был единственным default tool, который напрямую читал source. Graphify запускался AST-only на temporary copies; memory/context tools использовали isolated temp DB/data dirs и anonymous marker notes.

Позже CodeGraph был установлен по явному запросу пользователя и проверен на 29 real local project roots через `init`, `index --quiet`, `status`, JSON `query` и `uninit --force`. Lifecycle прошел на всех 29 roots без protected agent/config mutations и без оставшихся `.codegraph/` directories.

Повторный forced benchmark от 2026-05-26 прошел 47 sanitized anonymous profiles. Lifecycle/purge снова прошел 47/47, но useful generic `architecture_or_impact_discovery` context был ограничен: 23 mini profiles ушли в overhead, 18 profiles вернули header-only/no useful context, и только 6 profiles остались conditional useful. Финальная reduced `ai-tester` screening matrix от 2026-05-27 покрыла 300/300 rows и показала, что CodeGraph в среднем хуже `rg`: +21.0% duration, +29.6% tool calls, +55.7% total tokens, +54.3% input+output tokens. При этом среди 132 PASS/PASS пар есть 46 token-saving rows (34.8%), поэтому вывод не "всегда запрещён", а `avoid_by_default` с exact conditional cases. Самые сильные win-cases: `js+php standard framework multirepo openspec_native` для `aif-docs` (-82.7% total), `js standard framework monorepo legacy_ai_factory_only multirepo` для `aif-implement`/`aif-explore`, `js mini framework single_repo none` для commit/review/verify/implement/fix/rules/explore, `no-primary-language mini` для rules/review/docs/commit/fix, плюс отдельные weak cases для `php+js`, `js+go`, `rust` и `php`. Эти cases считаются кандидатами только для warm/existing index или explicit user-owned setup, потому что savings не включают стоимость `init/index`, и только если совпали skill + project labels. Видимые строки тестов находятся в [CodeGraph Benchmark Results](memory-tools-research/codegraph-benchmark-results.md); итоговая screening table - в [AI Tester Token Matrices: Screening CodeGraph](memory-tools-research/ai-tester-token-matrices-screening-codegraph.md). Принятая рекомендация - manual CLI-only + avoid_by_default; `install`/MCP/agent-config behavior все еще не принят для AIFHub automation.

Cross matrix от 2026-05-28 на sanitized Python/OpenSpec profile (`python`, `standard`, `framework`, `single_repo`, `openspec_native`, `large_framework_app`) прошла 100/100 rows по 10 representative skills и пяти optional tools. Единственные positive usage rows были у CodeGraph для `aif-analyze` и `aif-explore`, и оба проиграли `rg`: `aif-analyze` +108.2% total tokens и +137.4% duration, `aif-explore` +142.0% total tokens и +76.1% duration. Graphify, Context7, context-mode и codex-agent-mem получили 0 positive usage rows; их строки были negative/not-applicable policy checks. Итог для такого профиля: `rg` baseline only для `architecture_or_impact_discovery`; optional tools включать только по явным task signals. Полный отчет: [AI Tester Token Matrices: Python OpenSpec All Tools](memory-tools-research/ai-tester-token-matrices-python-openspec-all-tools.md).

Повторный safe field run от 2026-05-24 использовал 55 anonymous profiles из local projects root, но запускал инструменты только на sanitized temp copies или temp isolated dirs. Итог: `rg`, read-only `git/gh`, CodeGraph, Context7 и `context-mode` прошли; Graphify AST-only прошел на 54/55 профилей с одним timeout; `codex-agent-mem` подтвержден как GitHub/Python source package без source indexing. Context7 теперь имеет отдельный research note: [memory-tools-research/context7.md](memory-tools-research/context7.md).

Изолированный source-install test от 2026-05-25 подтвердил, что `MarceloCaporale/codex-agent-mem` работает как Python/MCP package: editable install прошел, upstream `pytest` дал 121 passed, `ruff` прошел, CLI smoke с explicit SQLite DB прошел, а `--read-only --profile minimal` MCP exposed только 7 non-mutating tools. Caveat: `--profile full --read-only` still lists mutating tool names, though mutating calls return `isError` and do not write; поэтому default recommendation остается `minimal + read-only`.

## Вывод Анализа

`/aif-analyze` должен кратко суммировать рекомендации так:

```text
Optional local tools:

Project labels:
- languages: js
- volume: standard
- complexity: framework
- repo shape: single_repo
- artifact mode: openspec_native
- task signals: architecture_or_impact_discovery

Baseline:
- rg: use for exact file/symbol lookup.

Recommended:
- none for architecture_or_impact_discovery unless exact metadata match exists.

Not recommended:
- CodeGraph: no exact skill+labels match, or latest matching benchmark was worse than rg.
- Graphify: no explicit graph-quality experiment requested.
- rohitg00-agentmemory: reject_default; isolated ai-tester safety PASS, full-product runtime NOT_RUN, both pairs avoid.
- codex-mem: broad Codex history scope can cross project boundaries.
- eagle-mem: scoped read and purge not proven.
```

Если metadata недоступна, `/aif-analyze` должен сообщить degraded note и продолжить с `rg` как baseline.
