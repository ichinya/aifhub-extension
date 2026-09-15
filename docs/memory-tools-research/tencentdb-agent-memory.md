# TencentDB Agent Memory (tdai-gateway)

Tool ID: `tencentdb-agent-memory`

Пакет: [`@tencentdb-agent-memory/memory-tencentdb`](https://www.npmjs.com/package/@tencentdb-agent-memory/memory-tencentdb) (`1.0.2`; upstream описывает four-layer local memory system: auto-capture, структурирование и профилирование разговорных знаний через local LLM + SQLite vector search, конвейер L0→L1→L2→L3)

Результаты paired screening: [tencentdb-agent-memory-benchmark-results.md](tencentdb-agent-memory-benchmark-results.md).

## Identity Boundary

Этот кандидат не совпадает ни с одним из уже описанных memory-инструментов:

| Tool ID | Поверхность | Роль в AIFHub |
|---|---|---|
| `agent-memory` | `jayzeng/agentmemory`, `myagentmemory` | Только manual durable notes по явному запросу. |
| `codex-agent-mem` | `MarceloCaporale/codex-agent-mem`, Python `codex-agent-mem` | Optional read-only continuity через явно указанный SQLite DB. |
| `rohitg00-agentmemory` | `rohitg00/agentmemory`, npm `@agentmemory/*` | `reject_default`; isolated safety PASS, обе пары `avoid`. |
| `tencentdb-agent-memory` | `@tencentdb-agent-memory/memory-tencentdb` + локальный HTTP-gateway `tdai-gateway` | User-owned screening candidate; `reject_default`. |

Совпадения слова `memory` в названиях не означают общий package, runtime или policy.

## Наблюдаемая Runtime Surface

Прогон выполнялся против user-owned развёртывания: локальный `tdai-gateway` на
`127.0.0.1:8431` с endpoint'ами `/capture`, `/search/memories`,
`/search/conversations`, `/recall`, `/session/end`; режим embeddings —
`bge-m3:latest` через локальный Ollama (`11434`). Gateway — постоянный фоновый
процесс, владеющий долгоживущим store'ом переписки (user/assistant content).

Границы, которые этот screening **не** проверял:

- delete/purge lifecycle и residual-state cleanup;
- cross-project store isolation на реальном многопроектном использовании;
- поведение full-product развёртывания за пределами локального gateway;
- MCP-поверхность (не оценивалась).

## Paired Screening Evidence

2026-09-15 выполнен user-owned paired screening вне AIFHub `ai-tester` harness:

- runner: `pi 0.85.1` headless (`--mode json`), provider `omniroute`, модель
  `la/ornith-1.5-35b-a3b`, thinking `medium`;
- дизайн: фаза A — seed-сессии (research + implement) с capture ответов в
  память; фаза B — парные прогоны `tool` (memory preamble) vs `baseline`
  (идентичный промпт без памяти) в throwaway git worktree (HEAD-снапшот);
- скиллы: `research` (только read) и `implement` (точечная правка);
- 6 локальных проектов с метками language/framework/shape/volume, 12 пар на
  каждый режим поиска (FTS-only и embeddings), всего 48 rows;
- качество: 24/24 пар без единого ухудшения грейда.

Ключевые агрегаты: research **−25,9%** total tokens (FTS) / **−33,8%** (EMB);
implement **−25,1%** (FTS, но **+12,6%** без laravel-исключения) / **+29,4%**
(EMB). Полные таблицы — в [benchmark results](tencentdb-agent-memory-benchmark-results.md).

## Политика AIFHub

Решение: `reject_default`.

Recommendation action: `do_not_suggest_as_aifhub_provider`.

`tencentdb-agent-memory`:

- не появляется в normal recommendations и `selected_tools`;
- запрещён для всех AIF commands в `skill_usage_matrix`;
- не имеет executable availability probe;
- не добавляет записей в `proven_label_evidence` — screening выполнялся не через
  repo-харнесс, поэтому ни одна пара не является promotable evidence;
- не создаёт зависимостей для analyze, plan, implement, verify или done.

Положительные research-сигналы (экономия на medium/large проектах, laravel
implement −64%) зафиксированы в metadata как `candidate_cases_needing_harness_confirmation` —
это темы для повторного прогона через `memory-tool-ai-tester-evaluate-tool.mjs`,
а не готовые рекомендации. До отдельной верификации purge, store isolation и
daemon ownership инструмент остаётся user-owned experiment.

Для baseline lookup остаётся `rg`; для continuity-сценариев сохраняется
независимая policy `codex-agent-mem`.

## Мета Для Анализа

- `tool_id`: `tencentdb-agent-memory`
- `decision`: `reject_default`
- `recommendation_action`: `do_not_suggest_as_aifhub_provider`
- `role`: user-owned local gateway continuity candidate
- `install_policy`: user-owned outside AIFHub only
- `read_scope`: captured user/assistant session content (локальный HTTP-gateway)
- `purge_path`: unverified (delete lifecycle не тестировался)
- `recommend_when`: нет условий; candidate cases требуют repo-harness прогона
- `do_not_recommend_when`: всегда по умолчанию; narrow-вопросы мимо прошлых
  сессий (+47…+127%), точечные implement-правки (до +333% на EMB), tiny-проекты
