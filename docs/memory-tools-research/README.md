# Research По Memory Tools

Этот каталог фиксирует выводы по инструментам локальной памяти и retrieval для issue #85 и отдельную policy evaluation candidate из issue #114. Документы описывают результаты установки, static review и полевых проверок без названий приватных проектов.

Отдельный трек — dedup повторных чтений из issue #133. Текущий кандидат
[ojuschugh1/sqz](sqz.md) проверяется в [AI Tester сравнении](sqz-benchmark-results.md)
baseline / собственный [Session Context Dedup](../context-dedup.md) / `sqz`. Историческое
исследование другого инструмента, [claudioemmanuel/squeez](squeez.md), и его
[offline benchmark](squeez-benchmark-results.md) сохранены отдельно; `sqz` не заменяет
и не перезаписывает эти evidence.

## Метаинформация Для Анализа

Файл [recommendation-metadata.yaml](recommendation-metadata.yaml) содержит machine-readable правила для analysis-этапа. Его можно читать при анализе проекта и превращать project signals в предложение пользователю:

- `Graphify` не предлагать автоматически по `multirepo` или large framework labels; он остается только для явного graph-shaped quality experiment после `rg`, если пользователь принимает overhead;
- `CodeGraph` предлагать только при exact `screening_policy` match по skill + project labels;
- если задача про resume/open work между сессиями, предложить `codex-agent-mem` в read-only MCP mode с explicit DB path;
- если задача про большой command output, предложить `context-mode` как temporary manual helper с обязательным purge;
- если проект маленький или нужен точный file/symbol lookup, оставить baseline `rg`;
- `codex-mem` и `eagle-mem` не предлагать по умолчанию из-за scope/privacy risks.
- `rohitg00-agentmemory` не предлагать для normal tasks: isolated `ai-tester` safety profile прошёл, но full-product runtime остаётся `NOT_RUN`, обе пары дали `avoid`, а policy — `reject_default`; это не alias для `agent-memory` или `codex-agent-mem`;
- `CodeGraph` можно предлагать только как `manual_cli_only` и `avoid_by_default`; `/aif-explore` получает его в `selected_tools` только при exact screening match и purge-команде; `install`/MCP/agent-config surface не принят.
- `Context7` можно предлагать как optional docs provider для version-sensitive library/API вопросов; `ctx7 setup` и MCP registration остаются user-owned.

Эта meta не разрешает auto-install. Любой инструмент из списка должен предлагаться пользователю только как explicit opt-in с объяснением read scope, purge path и privacy tradeoff.

Новая матрица описана в [AI Tester Matrix Для Memory Tools](ai-tester-matrix.md). Она делает paired прогон: `baseline_rg` на том же profile/task/skill, затем optional `tool_run`, затем decision `recommend`, `conditional`, `avoid` или `forbid`. Для индексируемых инструментов есть warm mode: `setup_commands` инициализируют индекс до model turn, а сам тест проверяет пользу уже готового индекса. Чтобы не запускать 2726 сценариев на первом проходе, генератор по умолчанию использует `--matrix-size screening`: 15 stratified profiles, representative skill groups и primary task. Authored сценарии живут в [ai-tester-scenarios.yaml](ai-tester-scenarios.yaml): только `run_class: accepted_evidence` плюс `promotion_policy.eligible_for_metadata` могут попасть в `proven_label_evidence`. Финальный CodeGraph screening report находится в [AI Tester Token Matrices: Screening CodeGraph](ai-tester-token-matrices-screening-codegraph.md): 300/300 rows, +55.7% total tokens против `rg`, но 46/132 PASS/PASS token-saving rows. В metadata теперь используются dimensions: language, volume, complexity, repo shape, artifact mode и старый `project_shape` как compatibility fallback; CodeGraph selector требует exact `skill + task + labels` match.

Promotion в metadata делается proposal-first:

```bash
node scripts/memory-tool-ai-tester-evaluate-tool.mjs --tool codegraph --root <project-dir> --preinitialize --json
node scripts/memory-tool-ai-tester-promote-metadata.mjs --report <run-dir>/ai-tester-token-matrices.json --scenario-catalog docs/memory-tools-research/ai-tester-scenarios.yaml --run-id <evidence-run-id> --json
```

One-shot `evaluate-tool` принимает tool и project root, пишет `matrix-summary.json`, `ai-tester-token-matrices.json`, `ai-tester-token-matrices.md` и promotion proposal в runtime state. Без `--apply` metadata не меняется. Отдельный `promote-metadata` нужен, если report уже был получен ранее. Selector читает `proven_label_evidence` как exact allow и не обходит `known_avoid_cases`, command-specific forbidden scopes, no-auto-install policy или protected artifacts.

CLI entrypoints не дублируют один и тот же шаг:

| Script | Role |
| --- | --- |
| `memory-tool-ai-tester-evaluate-tool.mjs` | Рекомендуемый one-shot wrapper для одного tool/project root. |
| `memory-tool-ai-tester-matrix.mjs` | Только генерация matrix, sanitized fixtures и scenario YAML. |
| `memory-tool-ai-tester-run-missing.mjs` | Только resumable запуск недостающих `ai-tester` rows. |
| `memory-tool-ai-tester-results-report.mjs` | Только JSON/Markdown report из matrix + traces. |
| `memory-tool-ai-tester-promote-metadata.mjs` | Только proposal/apply для `proven_label_evidence` из готового report. |

Дополнительный cross run на Python/OpenSpec profile находится в [AI Tester Token Matrices: Python OpenSpec All Tools](ai-tester-token-matrices-python-openspec-all-tools.md): 100/100 rows, 10 representative skills x 5 optional tools x `rg/tool_run`. Для labels `python`, `standard`, `framework`, `single_repo`, `openspec_native`, `large_framework_app` ни один optional tool не стал recommendation для `architecture_or_impact_discovery`; CodeGraph positive rows проиграли `rg`, остальные инструменты прошли только negative/not-applicable policy checks.

## Алгоритм Тестирования

Этот алгоритм нужен для добавления нового инструмента или повторного прогона существующего. README хранит методику и итоговую рекомендацию; все датированные результаты пишутся только в файл конкретного инструмента.

1. Создать или обновить файл инструмента в этом каталоге.
   - Указать repository URL, tested package/version, назначение, CLI/MCP status, read scope, purge path и privacy вывод.
   - Добавить блок `Мета Для Анализа` с `tool_id`, `decision`, `recommendation_action`, `role`, `install_policy`, `read_scope`, `purge_path`, `recommend_when` и `do_not_recommend_when`.

2. Выбрать project profiles.
   - В первую очередь читать `.ai-factory/ARCHITECTURE.md`, если он есть.
   - Классифицировать проект как `large_legacy`, `multirepo`, `large_framework_app`, `go_service`, `small_microservice` или другой (если предложенные не подходят)
   - В docs использовать только anonymous profile ids. Реальные названия проектов и локальные пути не писать.

3. Подготовить sanitized fixtures.
   - Копировать каждый проект в temp directory.
   - Исключить `.git`, `.env*`, `node_modules`, `vendor`, lock-файлы, логи, cache/build artifacts, binary/media/data artifacts.
   - Все индексы, DB, output и tool installs держать внутри temp workspace.

4. Собрать baseline через `rg`.
   - Зафиксировать file count, fixture size, query latency, hit count и token estimate.
   - Token estimate считать как `ceil(chars / 4)`, если инструмент не отдаёт собственную метрику.
   - `rg` остаётся baseline для exact file/symbol lookup и small projects.

5. Проверить инструмент по safety gate.
   - Stable CLI: `--help`, `--version` или ближайшая безопасная команда.
   - MCP: `tools/list` и минимальные read-only calls, если MCP заявлен.
   - Read scope: только explicit temp path, explicit DB или explicit indexed content.
   - Очистка: удалить index/DB/sidecar files или вызвать documented purge command.
   - Privacy: не читать global history, user home, hooks или real source root без явного opt-in.

6. Проверить функциональные сценарии.
   - Code retrieval/repo graph tools сравнивать с `rg`: latency, token reduction, quality.
   - Continuity memory tools проверять на temp DB/manual notes, не на source indexing.
   - Temporary context tools проверять на explicit generated text или command output.
   - Tools с global hooks/background automation не устанавливать полностью, пока scoped read и purge не доказаны.

7. Оценить качество.
   - `good`: инструмент находит реальные слои/модули/impact areas и снижает шум относительно `rg`.
   - `partial`: есть полезные элементы, но нужна ручная validation или `rg`.
   - `poor`: generic/noisy/wrong, слишком медленно или хуже baseline.
   - `not_applicable`: инструмент не является code retrieval tool.

8. Записать результаты.
   - В файл инструмента добавить новую секцию `Локальный Прогон На Anonymous Profiles (<date>)`.
   - Не перетирать старые таблицы: будущие прогоны добавлять новой датированной секцией.
   - В `recommendation-metadata.yaml` добавить или обновить `evidence_runs`, если новый прогон меняет recommendation logic.
   - Если прогон был catalog-driven accepted evidence, сначала создать promotion proposal и только потом переносить entries в `proven_label_evidence`.

9. Проверить и очистить.
   - Выполнить `npm run validate`.
   - Проверить YAML: `bunx js-yaml docs/memory-tools-research/recommendation-metadata.yaml`.
   - Просканировать docs на реальные project names, local paths и temp paths.
   - Удалить temp fixtures, DB, indexes, sidecars и isolated tool installs.

## Сводка

README содержит только общую сводку и итоговую рекомендацию. У каждого инструмента есть два файла: описание инструмента и отдельный файл с результатами тестов, labels и выводами по применимости.

Правило benchmark: выводы о выгоде инструмента строятся только по paired `ai-tester` runs `rg baseline` vs `<tool> tool_run`. Field/smoke/focused runs в result-файлах считаются только safety/availability/research evidence и не должны попадать в `proven_label_evidence`.

## AI Tester Evidence

Raw `ai-tester` artifacts лежат локально в `.ai-factory/state/ai-tester-matrix-for-memory-tool-metadata/<run>/ai-tester-token-matrices.json` и `.ai-factory/state/ai-tester-tool-evaluations/<run>/ai-tester-token-matrices.json`. В docs ниже перенесены только anonymous labels и агрегированные метрики.

| Tool | ai-tester run | Rows | Где смотреть | Вывод |
|---|---|---:|---|---|
| All optional tools | `model-gen-all-tools-grouped-clean-20260528-212755` | 100 executed | [ai-tester-token-matrices-python-openspec-all-tools.md](ai-tester-token-matrices-python-openspec-all-tools.md), `.ai-factory/state/ai-tester-matrix-for-memory-tool-metadata/model-gen-all-tools-grouped-clean-20260528-212755/ai-tester-token-matrices.json` | Python/OpenSpec large framework labels: `rg` only; CodeGraph positive rows worse, other tools not selected. |
| CodeGraph | `screening-codegraph-preinit-nosipout-gpt54mini` | 300 executed, 150 pairs | [ai-tester-token-matrices-screening-codegraph.md](ai-tester-token-matrices-screening-codegraph.md), `.ai-factory/state/ai-tester-matrix-for-memory-tool-metadata/screening-codegraph-preinit-nosipout-gpt54mini/ai-tester-token-matrices.json` | +55.7% total tokens, +21.0% time; useful only in exact skill+label cases. |
| CodeGraph | `anonymous-codegraph-openspec-single-20260611` | 6 executed, 3 pairs | `.ai-factory/state/ai-tester-tool-evaluations/anonymous-codegraph-openspec-single-20260611/ai-tester-token-matrices.json` | OpenSpec single-repo framework labels: `avoid`, useful=0; average pair delta +78.1% total tokens. |
| CodeGraph | `anonymous-codegraph-openspec-multirepo-20260611` | 6 executed, 3 pairs | `.ai-factory/state/ai-tester-tool-evaluations/anonymous-codegraph-openspec-multirepo-20260611/ai-tester-token-matrices.json` | OpenSpec multirepo framework labels: `avoid`, useful=0; average pair delta +309.3% total tokens. |
| CodeGraph | `anonymous-codegraph-none-single-20260611` | 6 executed, 3 pairs | `.ai-factory/state/ai-tester-tool-evaluations/anonymous-codegraph-none-single-20260611/ai-tester-token-matrices.json` | No-artifact single-repo framework labels: `avoid`, useful=0; average pair delta +500.4% total tokens. |
| CodeGraph | `codegraph-project-906f08554613-multirepo-analyze-review-20260611t1811z` | 4 executed, 2 pairs | `.ai-factory/state/ai-tester-tool-evaluations/codegraph-project-906f08554613-multirepo-analyze-review-20260611t1811z/ai-tester-token-matrices.json` | `project-906f08554613`, OpenSpec multirepo framework labels, `aif-analyze/aif-review`: `avoid`, useful=0; average pair delta +323.1% total tokens. |
| AgentMemory (rohitg00) | `agentmemory-isolated-0-9-28-20260720-r4` | 4 executed, 2 PASS/PASS pairs | [agentmemory-rohitg00-benchmark-results.md](agentmemory-rohitg00-benchmark-results.md), `.ai-factory/state/evaluate-rohitg00-agentmemory-continuity-provider/ai-tester/agentmemory-isolated-0-9-28-20260720-r4/ai-tester-token-matrices.json` | Isolated safety PASS, no promotion; `avoid`, +231.1% duration и +51.4% total tokens против `rg`. |
| AgentMemory object samples | `agentmemory-object-python-mcp-gate-20260720-r1`, `agentmemory-object-php-uptime-20260720-r1` | 4 executed, 2 PASS/PASS pairs | [agentmemory-rohitg00-benchmark-results.md](agentmemory-rohitg00-benchmark-results.md) | External sanitized fixtures, no promotion; обе пары `avoid` (+155.2%/+58.7% duration, +49.3%/+98.8% total tokens). |
| Graphify | `screening-graphify-ai-tester-pilot` | 2 executed, 1 pair | [graphify-benchmark-results.md](graphify-benchmark-results.md#ai-tester-pilot-2026-05-28), `.ai-factory/state/ai-tester-matrix-for-memory-tool-metadata/screening-graphify-ai-tester-pilot/ai-tester-token-matrices.json` | mini/small profile: +397.9% total tokens. |
| Graphify | `targeted-graphify-ai-tester` | 4 executed, 2 pairs | [graphify-benchmark-results.md](graphify-benchmark-results.md#ai-tester-targeted-run-2026-05-28), `.ai-factory/state/ai-tester-matrix-for-memory-tool-metadata/targeted-graphify-ai-tester/ai-tester-token-matrices.json` | large framework +82.9%, multirepo +127.8% total tokens. |
| Graphify | `cross-graphify-ai-tester` | 8 executed, 4 pairs | [graphify-benchmark-results.md](graphify-benchmark-results.md#ai-tester-cross-screening-2026-05-28), `.ai-factory/state/ai-tester-matrix-for-memory-tool-metadata/cross-graphify-ai-tester/ai-tester-token-matrices.json` | `aif-analyze/aif-explore` x large framework/multirepo: +315.5% to +1668.8% total tokens. |
| Graphify | `anonymous-graphify-none-single-20260611` | 6 executed, 3 pairs | `.ai-factory/state/ai-tester-tool-evaluations/anonymous-graphify-none-single-20260611/ai-tester-token-matrices.json` | No-artifact single-repo framework labels: `avoid`, useful=0; average pair delta -11.5% total tokens, but candidate rows were negative policy checks and Graphify was not called. |
| Graphify | `graphify-project-8d97432e6d7a-architecture-explore-plan-20260611t1821z` | 4 executed, 2 pairs | `.ai-factory/state/ai-tester-tool-evaluations/graphify-project-8d97432e6d7a-architecture-explore-plan-20260611t1821z/ai-tester-token-matrices.json` | `project-8d97432e6d7a`, legacy-AI-Factory single-repo framework labels, `aif-explore/aif-plan`: `avoid`, useful=0; average pair delta +94.7% total tokens. |
| Context7 | `screening-context7-ai-tester-pilot-v2` | 2 executed, 1 pair | [context7-benchmark-results.md](context7-benchmark-results.md#ai-tester-pilot-2026-05-28), `.ai-factory/state/ai-tester-matrix-for-memory-tool-metadata/screening-context7-ai-tester-pilot-v2/ai-tester-token-matrices.json` | mini/no dependency signal: +1903.9% total tokens. |
| Context7 | `targeted-context7-ai-tester` | 4 executed, 2 pairs | [context7-benchmark-results.md](context7-benchmark-results.md#ai-tester-targeted-run-2026-05-28), `.ai-factory/state/ai-tester-matrix-for-memory-tool-metadata/targeted-context7-ai-tester/ai-tester-token-matrices.json` | language/framework labels alone: +761.9% to +1019.5% total tokens. |
| Context7 | `cross-context7-ai-tester` | 8 executed, 4 pairs | [context7-benchmark-results.md](context7-benchmark-results.md#ai-tester-cross-screening-2026-05-28), `.ai-factory/state/ai-tester-matrix-for-memory-tool-metadata/cross-context7-ai-tester/ai-tester-token-matrices.json` | `aif-plan/aif-rules-check` x large framework/multirepo: +403.2% to +1850.8% total tokens. |
| Context7 | `anonymous-context7-none-single-nopreinit-20260611` | 2 executed, 1 pair | `.ai-factory/state/ai-tester-tool-evaluations/anonymous-context7-none-single-nopreinit-20260611/ai-tester-token-matrices.json` | No-preinit positive pair failed because `ctx7` was not called; +106.1% total tokens; no promotion. |
| Context7 | `context7-project-9f839f3c998a-version-docs-plan-review-20260611t1830z` | 4 executed, 2 failed pairs | `.ai-factory/state/ai-tester-tool-evaluations/context7-project-9f839f3c998a-version-docs-plan-review-20260611t1830z/ai-tester-token-matrices.json` | `project-9f839f3c998a`, OpenSpec single-repo framework labels, `aif-plan/aif-review`: tool_run did not call `ctx7`; +511.2% total tokens; no promotion. |
| context-mode | `screening-context-mode-ai-tester-pilot-v2` | 2 executed, 1 pair | [context-mode-benchmark-results.md](context-mode-benchmark-results.md#ai-tester-pilot-2026-05-28), `.ai-factory/state/ai-tester-matrix-for-memory-tool-metadata/screening-context-mode-ai-tester-pilot-v2/ai-tester-token-matrices.json` | tool_run failed useful assertion and spent +6804.0% total tokens. |
| context-mode | `cross-context-mode-ai-tester` | 3 executed, 1 completed pair + 1 timeout | [context-mode-benchmark-results.md](context-mode-benchmark-results.md#ai-tester-cross-screening-2026-05-28), `.ai-factory/state/ai-tester-matrix-for-memory-tool-metadata/cross-context-mode-ai-tester/ai-tester-token-matrices.json` | `aif-analyze` x multirepo failed with +651.8% total tokens; large framework tool_run timed out. |
| context-mode | `cm-p8d97432e-out-ae-1851` | 4 executed, 2 failed pairs | `.ai-factory/state/ai-tester-tool-evaluations/cm-p8d97432e-out-ae-1851/ai-tester-token-matrices.json` | `project-8d97432e6d7a`, generated-output compression, `aif-analyze/aif-explore`: tool_run failed useful assertions; +487.6% total tokens; no promotion. |

No paired positive source-retrieval `ai-tester` benchmark is recorded yet for `codex-agent-mem` and `agent-memory`, because they are not source retrieval tools. The Python/OpenSpec matrix includes negative/not-applicable selector rows for `codex-agent-mem`, but these validate policy only. `rohitg00-agentmemory` имеет authored non-promotable safety scenario: isolated standalone profile прошёл 4/4 rows и 2/2 pairs, но обе пары дали `avoid`; full-product runtime остаётся `NOT_RUN`, а decision — `reject_default`. Это не positive source-retrieval evidence и не разрешение normal tool runs. `codex-mem` и `eagle-mem` также отклонены до positive benchmark из-за неприемлемой scoped read/purge/default privacy safety.

| Tool | Tests | Repository | Проверенная версия | Где подходит | Решение |
|---|---|---|---:|---|---|
| [Graphify](graphify.md) | [results](graphify-benchmark-results.md) | [safishamsi/graphify](https://github.com/safishamsi/graphify) | `graphifyy 0.8.17` | Repo graph / architecture / impact discovery. Не memory. | ai-tester: проиграл `rg` на mini, large framework и multirepo; только explicit quality experiment, не token/time saver. |
| [Context7](context7.md) | [results](context7-benchmark-results.md) | [upstash/context7](https://github.com/upstash/context7) | `ctx7 0.4.4` | Version-sensitive library/API docs. | ai-tester: overhead без explicit library/API/version; выбирать только по конкретному docs question. |
| [codex-agent-mem](codex-agent-mem.md) | [results](codex-agent-mem-benchmark-results.md) | [MarceloCaporale/codex-agent-mem](https://github.com/MarceloCaporale/codex-agent-mem) | Python source package `1.0.2` | Cross-session continuity, open work, closure checks, compact context packs. | Optional read-only continuity provider; полезен по task label, не по языку/объему проекта. |
| [agent-memory](agent-memory.md) | [results](agent-memory-benchmark-results.md) | [jayzeng/agentmemory](https://github.com/jayzeng/agentmemory) | `myagentmemory 0.4.12` | Manual markdown memory. | Docs-only/manual notes; не project retrieval provider. |
| [agentmemory (rohitg00)](agentmemory-rohitg00.md) | [results](agentmemory-rohitg00-benchmark-results.md) | [rohitg00/agentmemory](https://github.com/rohitg00/agentmemory) | static `v0.9.28`; isolated standalone `ai-tester PASS`; full product `NOT_RUN` | Только user-owned reviewed output как supporting context; test-only synthetic safety scenario. | `reject_default`; обе runtime pairs — `avoid`, без metadata promotion. |
| [context-mode](context-mode.md) | [results](context-mode-benchmark-results.md) | [mksglu/context-mode](https://github.com/mksglu/context-mode) | `1.0.151` | Temporary output/context indexing and compression. | ai-tester pilot на mini fixture failed useful assertion и дал экстремальный overhead; только для уже большого generated output. |
| [codex-mem](codex-mem.md) | [results](codex-mem-benchmark-results.md) | package не содержит repository metadata; ближайший проверенный публичный repo: [Just-Boring-Cat/codex-mem](https://github.com/Just-Boring-Cat/codex-mem) | `0.1.1` | Codex session/history memory. | Reject as default; privacy risk без строгой изоляции. |
| [eagle-mem](eagle-mem.md) | [results](eagle-mem-benchmark-results.md) | [eagleisbatman/eagle-mem](https://github.com/eagleisbatman/eagle-mem) | `4.9.10` | Shared memory + hooks + guardrails + lanes. | Reject/defer; scoped read/purge и MCP не доказаны. |
| [CodeGraph](codegraph.md) | [results](codegraph-benchmark-results.md) | [colbymchenry/codegraph](https://github.com/colbymchenry/codegraph) | installed `0.9.3`, npm `0.9.4` | Manual CLI-only repo graph для exact screening cases. | `manual_cli_only`, `avoid_by_default`; final screening: +55.7% total tokens vs `rg`, useful only for exact skill+label cases. |
| [Repowise](repowise.md) | [results](repowise-benchmark-results.md) | [repowise-dev/repowise](https://github.com/repowise-dev/repowise) | `repowise 0.25.0` | Repo-intelligence: Graph + Git + Health + dead-code + risk. | `manual_cli_only`, `avoid_by_default`; tiered (`--index-only` default, wiki при `doctor` OK); screening_policy пуст до ai-tester матрицы. |

## Итоговые Таблицы По Форматам Проектов

### Мини Проект

| Tool | aif-analyze | aif-explore | aif-plan | Вывод |
|---|---|---|---|---|
| `rg` | useful baseline | useful baseline | useful baseline | Точный поиск быстрее любых индексов. |
| CodeGraph | avoided by default | exact screening only | forbidden | Mini/exact lookup остается на `rg`; исключения возможны только для записанных skill+label cases. |
| Graphify | avoided | avoided | avoided | Перерасход token/time на mini profile. |
| context-mode | avoided | avoided | forbidden | Нет пользы без large generated output. |

### Laravel/Framework

| Tool | aif-analyze | aif-explore | aif-plan | Вывод |
|---|---|---|---|---|
| `rg` | required baseline | required baseline | required baseline | Всегда первый проход и fallback. |
| CodeGraph | avoided by default | exact screening only | forbidden | Framework label сам по себе недостаточен; нужен совпавший skill+labels case и непустой useful output. |
| Graphify | avoided by default | explicit quality experiment only | explicit reviewed output only | ai-tester не подтвердил token/time выгоду на framework labels. |
| Context7 | conditional docs | conditional docs | conditional docs | Только version-sensitive library/API docs. |

### Multirepo

| Tool | aif-analyze | aif-explore | aif-plan | Вывод |
|---|---|---|---|---|
| `rg` | required baseline | required baseline | required baseline | Нужен для точной проверки найденных областей. |
| CodeGraph | avoided by default | exact screening only | forbidden | Multirepo label сам по себе недостаточен; использовать только записанные conditional cases. |
| Graphify | avoided by default | explicit quality experiment only | explicit reviewed output only | Multirepo label сам по себе не дает выгоды; использовать только если нужен graph-shaped quality check. |
| codex-agent-mem | conditional continuity | conditional continuity | forbidden | Только resume/open-work, не repo indexing. |

### Legacy Integration-Heavy

| Tool | aif-analyze | aif-explore | aif-plan | Вывод |
|---|---|---|---|---|
| `rg` | required baseline | required baseline | required baseline | Нужен для source-grounded validation. |
| CodeGraph | avoided by default | exact screening only | forbidden | Integration-heavy не является отдельным positive signal; нужен exact screening match. |
| Graphify | avoided by default | explicit quality experiment only | explicit reviewed output only | Field runs были quality-only, ai-tester не подтвердил экономию; timeout risk остается. |
| context-mode | conditional compression | conditional generated output | forbidden | Только для большого command output, не для source retrieval. |

### Go Service

| Tool | aif-analyze | aif-explore | aif-plan | Вывод |
|---|---|---|---|---|
| `rg` | required baseline | required baseline | required baseline | Для mini/standard Go сервисов обычно достаточно. |
| CodeGraph | avoided | exact screening only | forbidden | Go label не дает recommendation; weak/sample-more cases не перекрывают общий +19.3% total-token overhead по Go. |
| Graphify | avoided on mini, explicit quality only on standard | explicit reviewed output only | explicit reviewed output only | Не выбирать по Go label; нужен явный graph-quality запрос. |
| codex-agent-mem | conditional continuity | conditional continuity | forbidden | Project shape не важен; важен task signal resume/open-work. |

## Итоговая Рекомендация

Не делать generic memory-provider abstraction сейчас.

Использовать узкую opt-in модель:

- `rg` остаётся baseline для literal search, точного поиска файлов и маленьких проектов.
- `codex-agent-mem` можно документировать как optional read-only MCP continuity provider.
- `Graphify` можно документировать как optional repo-graph provider только для явного quality experiment; не выбирать автоматически по размеру, framework или multirepo labels.
- `Context7` можно документировать как optional docs provider для актуальных library/API вопросов.
- `context-mode` может остаться manual helper для temporary indexing больших command outputs.
- `codex-mem`, `agent-memory`, `eagle-mem` и `rohitg00-agentmemory` не должны становиться default AIFHub integrations; последний остаётся отдельным `reject_default` candidate, а не заменой manual-notes или read-only continuity policies.
- `CodeGraph` остается manual CLI-only и `avoid_by_default`; selector может вернуть его только при exact `screening_policy` match по skill + project labels, после `rg`, с непустым useful output и обязательным purge; `install`/MCP/agent-config surface не принят.

Любая будущая реализация должна требовать explicit opt-in, explicit local paths, отсутствие global hooks по умолчанию, отсутствие canonical OpenSpec writes, отсутствие зависимости от install path и документированный purge/delete-index path.

Compression/context helpers не должны rewrite validation artifacts. Protected validation artifacts включают `aif-gate-result`, `coverage.json`, `done-readiness.json`, OpenSpec specs under `openspec/specs/**`, generated-rules traces и exact evidence snippets. Optional tools не должны compress protected artifacts in place.
