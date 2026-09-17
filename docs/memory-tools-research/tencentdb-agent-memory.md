# TencentDB Agent Memory

Tool ID: `tencentdb-agent-memory`

Репозиторий: [TencentCloud/TencentDB-Agent-Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory)

Пакет: [`@tencentdb-agent-memory/memory-tencentdb`](https://www.npmjs.com/package/@tencentdb-agent-memory/memory-tencentdb) `1.0.2` (npm)

Issue boundary: [ichinya/aifhub-extension#201](https://github.com/ichinya/aifhub-extension/issues/201)

Результаты полевых проверок: screening-бенчмарк выполнен 2026-09-14 в изолированной конфигурации (standalone Gateway + pi/OmniRoute, 6 проектов × 2 skill'а × paired runs): [tencentdb-agent-memory-benchmark-results.md](tencentdb-agent-memory-benchmark-results.md). Кратко: −25.5% tokens на 12 парах целиком за счёт L0-поиска по истории диалогов; L1/L2/L3 для проектного контента не срабатывают; FTS не ищет кириллицу; малые проекты — чистый убыток. Embeddings follow-up (2026-09-15): local-провайдер в v1.0.2 недостижим из конфига; remote bge-m3 возвращает русский векторный recall (4/6 точных попаданий, ранжирование среднее), но L1-экстракция проектного контента не работает и измеримой дополнительной экономии нет — см. «Embeddings follow-up» в benchmark-документе. Runtime в смысле AIFHub-методики остаётся `NOT_RUN` (ai-tester-прогоны не выполнялись), в `recommendation-metadata.yaml` инструмент не продвигался.

## Identity Boundary

Кандидат не смешивать с уже описанными инструментами:

| Tool ID | Repository/package | Роль в AIFHub |
|---|---|---|
| `agent-memory` | `jayzeng/agentmemory`, `myagentmemory 0.4.12` | Только manual durable notes. |
| `codex-agent-mem` | `MarceloCaporale/codex-agent-mem`, Python `codex-agent-mem 1.0.2` | Read-only continuity через explicit SQLite DB. |
| `rohitg00-agentmemory` | `rohitg00/agentmemory`, `@agentmemory/*` | Full-product runtime, `reject_default`. |
| `tencentdb-agent-memory` | `TencentCloud/TencentDB-Agent-Memory`, `@tencentdb-agent-memory/memory-tencentdb` | User-owned research candidate; static review only. |

Issue #201 ссылается на `github.com/Tencent/TencentDB-Agent-Memory`; канонический owner — `TencentCloud`. Заявленные в issue цифры (−61% tokens, PersonaMem 48%→76%) соответствуют self-reported бенчмаркам README, но измерены на интеграции с OpenClaw, а не в AIFHub-методике.

## Static Evidence Snapshot

Static evidence зафиксирован 2026-09-13 без установки или запуска provider.

- release [`v2.0.1`](https://github.com/TencentCloud/TencentDB-Agent-Memory/releases/tag/v2.0.1) от 2026-08-25;
- npm package `@tencentdb-agent-memory/memory-tencentdb@1.0.2`, `engines.node >= 22.16.0`;
- version drift: repo release `v2.0.1` против npm `1.0.2` — схемы версионирования не совпадают, при любом будущем evidence фиксировать обе ссылки;
- лицензия MIT; основной язык TypeScript (монорепо: `MemoryCore`, `MemoryKnowledge`, `MemoryPanel`, `MemoryProxy`, `adapters`, `agents`, `deploy`, `sdk`);
- `sdk/memory-core` содержит `python` и `typescript` SDK, но документации верхнего уровня (SDK README) в репозитории нет.

## Что Это

Team-level memory hub для AI-агентов с двумя архитектурными столпами:

1. **Символьная краткосрочная память (Context Offload + Mermaid canvas).** Полные выводы инструментов выгружаются в `refs/*.md`, промежуточные слои — step-своды в `jsonl`, верхний слой — компактная Mermaid-карта задачи с `node_id`. Агент читает только верхний слой и разворачивает детали по `node_id`. Заявлено −61.38% tokens на WideSearch и −33.09% на SWE-bench (интеграция OpenClaw).
2. **Многослойная долговременная память.** Пирамида L0 Conversation → L1 Atom → L2 Scenario → L3 Persona. Хранение: локальный `SQLite + sqlite-vec`; retrieval: BM25 + vector + RRF (гибрид). Верхние слои — человекочитаемые Markdown-файлы в `~/.openclaw/memory-tdai/`; заявлена трассируемость «символ → индекс → raw text» без необратимого сжатия.

Плюсы, релевантные AIFHub-проблематике (context dedup, fresh-context review):

- white-box слои (Markdown/Mermaid/JSONL) теоретически читаемы как reviewed supporting input;
- lossless drill-down вместо lossy summary — концептуально ближе к AIFHub-требованию evidence, чем flat vector stores;
- опциональный bearer-token и CORS для Gateway — осознанная security-поверхность.

## Наблюдаемая Runtime Surface

Upstream documentation описывает не узкий read-only reader, а полную runtime-систему:

- **Интеграционная поверхность — только OpenClaw plugin и Hermes Gateway.** Standalone CLI для произвольных агентов отсутствует; MCP server в README и INSTALL.md не заявлен; agent tools (`tdai_memory_search`, `tdai_conversation_search`) доступны только внутри OpenClaw/Hermes runtime;
- short-term compression требует OpenClaw `>= 2026.3.13`, слот `plugins.slots.contextEngine` **и рантайм-патч хоста** (`scripts/openclaw-after-tool-call-messages.patch.sh`);
- **npm `postinstall` выполняет bash-скрипт патчинга хоста** (`bash scripts/openclaw-after-tool-call-messages.patch.sh 2>/dev/null || true`) — установка пакета мутирует host-инсталляцию OpenClaw;
- отдельный Gateway-процесс на `127.0.0.1:8420` (HTTP capture/search/recall), при Hermes — авто-discovery и `Popen()` запуск;
- **собственный LLM-контур**: извлечение L1, сценарии, persona и offload-сжатие требуют `TDAI_LLM_API_KEY` (OpenAI-compatible endpoint); Headline-экономия токенов не включает расход на эти вызовы отдельно;
- хранение в user home: `~/.openclaw/memory-tdai/`; capture пишет разговоры, tool calls и derived memory;
- `bm25.language` по умолчанию `zh` (jieba), альтернатива `en`; отдельной локали для русского нет;
- retention: `capture.l0l1RetentionDays` (0 = никогда не чистить), `capture.excludeAgents`; документированной команды полного purge нет;
- Windows: частичная поддержка — только batch-скрипт для native Hermes.

## Почему Не AIFHub Provider

1. **Нет integration path.** AIFHub-команды (`aif-analyze`, `aif-explore`, `aif-review`) требуют CLI/MCP/read-files surface с explicit scope. У кандидата surface — plugin slots чужого хоста (OpenClaw) или HTTP Gateway чужого процесса (Hermes); MCP отсутствует.
2. **Установка мутирует хост.** postinstall-патч хост-рантайма нарушает `never_auto_install` и аналогичен классу рисков, из-за которых `codex-mem`/`eagle-mem` в `forbidden`.
3. **Broad privacy scope.** Capture разговоров и tool calls в user home с собственным LLM-контуром; эквивалент `broad_prompt_tool_and_memory_data`, как у `rohitg00-agentmemory`.
4. **Purge не определён.** Есть retention-настройки, но нет documented complete-purge команды; `purge_status: unverified`.
5. **Environment mismatch.** Node `>= 22.16`, Gateway-процесс, внешний LLM API key; экономия токенов self-reported на OpenClaw harness и не воспроизведена в ai-tester методике (baseline `rg`, paired runs).
6. **Version drift** repo v2.0.1 / npm 1.0.2 требует refresh policy при любом продвижении.

## Политика AIFHub

Решение (обновлено 2026-09-15 после screening-бенчмарка): `conditional_external_runtime_only`, внесён в `recommendation-metadata.yaml`.

Recommendation action: `suggest_when_en_continuity_or_research` (avoid_by_default + exact screening gate).

- **AIFHub не устанавливает и не запускает**: нет CLI/MCP-поверхности, npm postinstall патчит host-рантайм OpenClaw, purge-обязательства производителя нет; всё выполнение — user-owned Gateway, запуск и очистка (остановка процесса + удаление `TDAI_DATA_DIR`) остаются за пользователем;
- появляется в рекомендациях только при exact screening match: skills `aif-analyze`/`aif-explore`/`aif-review` + задачи continuity/research (`resume_previous_work`, `compact_handoff_context`, `architecture_or_impact_discovery`) + объём `standard`/`large` + repo_shape `single_repo`/`monorepo`/`multirepo` + пройденный health-probe пользовательского gateway;
- en/ASCII-кодовая база — обязательное условие в тексте gate (keyword-FTS не ищет кириллицу; ru-запросы требуют remote-embeddings);
- forbidden для aif-architecture, aif-plan, aif-rules-check, aif-implement, aif-fix, aif-verify, aif-done, aif-commit;
- в `proven_label_evidence` не продвигался: benchmark выполнен не в ai-tester методике (screening-level, 1 пара на клетку, высокая дисперсия между прогонами — см. «Ограничения» benchmark-отчёта).
- Для resume/continuity без внешнего runtime остаётся действующая policy `codex-agent-mem` (read-only minimal MCP, explicit SQLite DB); для больших временных выводов — `context-mode`; baseline для точечных lookup — `rg`.

## User-Owned Reviewed Output Boundary

Пользователь может независимо эксплуатировать TencentDB Agent Memory в собственном OpenClaw/Hermes stack. Если пользователь явно передаст уже проверенный экспорт (например, `persona.md`, scenario-блоки или Mermaid canvas), AIFHub может прочитать его как обычный supporting input: сверка с canonical artifacts, без secrets/транскриптов, без статуса canonical spec, gate evidence или обязательного компонента workflow.

## Что Изменит Оценку

Условия future promotion (все обязательны):

1. появление standalone CLI или read-only MCP server с explicit-path scope;
2. отказ от postinstall-патчинга хоста или перенос его в explicit opt-in шаг вне npm lifecycle;
3. documented complete-purge команда и пройденный purge/isolation check;
4. `bm25.language`/prompts, пригодные для не-zh/en проектов, либо подтверждённая работа на русском корпусе;
5. не менее двух comparable PASS/PASS pairs в ai-tester методике против baseline `rg` на exact runtime/platform profile.

## Мета Для Анализа

```yaml
tool_id: tencentdb-agent-memory
decision: conditional_external_runtime_only
recommendation_action: suggest_when_en_continuity_or_research
role: user_owned_continuity_memory_gateway
install_policy: explicit_user_opt_in_only_never_install_host_postinstall_patch
read_scope: user_owned_gateway_recall_of_captured_dialog_history
purge_path: stop_user_gateway_and_delete_TDAI_DATA_DIR_verified
runtime_status: screening_benchmark_done_ai_tester_NOT_RUN
evidence: tencentdb-agent-memory-benchmark-results.md
recommend_when:
  tasks:
    - resume_previous_work
    - compact_handoff_context
  conditional_for:
    project_shapes:
      - large_framework_app
      - multirepo
do_not_recommend_when:
  project_shapes:
    - small_microservice
  tasks:
    - codebase_retrieval
    - project_analysis
    - exact_file_or_symbol_lookup
analysis_hint: "Предлагать только как user-owned external runtime при явном запросе: en/ASCII, standard/large репо, запущенный пользовательский gateway (health-probe). Research-follow-up и impl-continuity на больших репо дают экономию (−20%..−67% research; −53%..−64% impl-continuity); малые проекты, narrow-вопрос после broad-обзора и impl в средних репо — убыток. Архитектурный референс (Mermaid canvas + L0-L3 layering) для context dedup."
```
