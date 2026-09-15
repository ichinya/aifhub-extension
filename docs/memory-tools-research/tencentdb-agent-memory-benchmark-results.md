# Результаты Оценки TencentDB Agent Memory

> **Paired screening status: `PASS` (24/24 пар без потери качества)**
>
> **Promotable evidence status: `NOT_RUN` (прогон вне AIFHub ai-tester harness)**

Описание candidate и policy boundary: [tencentdb-agent-memory.md](tencentdb-agent-memory.md).

## Итог

| Поле | Значение |
|---|---|
| Tool ID | `tencentdb-agent-memory` |
| Tested surface | `@tencentdb-agent-memory/memory-tencentdb` `1.0.2` через локальный `tdai-gateway` (`127.0.0.1:8431`) |
| Runner | `pi 0.85.1` headless `--mode json`, provider `omniroute`, модель `la/ornith-1.5-35b-a3b`, thinking `medium` |
| Дата | 2026-09-15 |
| Дизайн | Фаза A — seed-сессии с capture; фаза B — парные `tool` vs `baseline` прогоны в throwaway git worktree |
| Скиллы | `research` (read-only), `implement` (точечная правка) |
| Режимы поиска | FTS-only и Embeddings (`bge-m3:latest` через Ollama) |
| Rows / pairs | 48 rows (24 пары: 12 FTS + 12 EMB); 0 таймаутов, 0 ошибок выхода |
| Качество | 24/24 пар: research score `1.00`, implement `pass` — без единого ухудшения |
| Policy decision | `reject_default` |
| Metadata promotion | Не выполнялась; evidence не из repo-харнесса, `useful_pairs: 0` в promotable смысле |

## Метки проектов (локальный bench, не repo profiles)

| Проект | language | framework | shape | volume |
|---|---|---|---|---|
| icde | typescript | react+vite | small_microservice | tiny_19_files |
| idshka | php | laravel | large_framework_app | large_935_files |
| flutter_plane | dart | flutter | large_framework_app | medium_229_files |
| anthill | csharp | unity | large_framework_app | large_236_files |
| lorawrite | python+typescript | fastapi+react | monorepo | medium_162_files |
| secret-santa | python+typescript | fastapi+react+zustand | polyglot_fullstack | small_85_files |

## Paired Results: FTS-only

Δ = tool относительно baseline (отрицательный = память экономит).

| Проект | Skill | tool | baseline | Δ токенов | Tools T/B | Wall T/B | Грейд T/B |
|---|---|---:|---:|---:|---|---|---|
| icde | research | 11 528 | 15 138 | −23,8% | 2/3 | 18с/22с | 1.00/1.00 |
| icde | implement | 12 155 | 11 554 | +5,2% | 2/3 | 17с/21с | pass/pass |
| idshka | research | 7 915 | 5 372 | +47,3% | 2/2 | 20с/22с | 1.00/1.00 |
| idshka | implement | 13 564 | 37 982 | −64,3% | 2/8 | 23с/45с | pass/pass |
| flutter_plane | research | 5 609 | 23 296 | −75,9% | 1/7 | 14с/38с | 1.00/1.00 |
| flutter_plane | implement | 12 433 | 10 558 | +17,8% | 3/4 | 18с/19с | pass/pass |
| anthill | research | 23 694 | 26 394 | −10,2% | 7/7 | 41с/48с | 1.00/1.00 |
| anthill | implement | 5 439 | 5 778 | −5,9% | 1/2 | 9с/15с | pass/pass |
| lorawrite | research | 25 020 | 31 452 | −20,5% | 7/9 | 40с/54с | 1.00/1.00 |
| lorawrite | implement | 9 973 | 8 182 | +21,9% | 2/3 | 11с/16с | pass/pass |
| secret-santa | research | 4 791 | 4 348 | +10,2% | 1/2 | 10с/15с | 1.00/1.00 |
| secret-santa | implement | 4 536 | 3 480 | +30,3% | 1/1 | 7с/6с | pass/pass |

Агрегаты FTS: research **−25,9%** (78 557 vs 106 000), implement **−25,1%**
(58 100 vs 77 534; без laravel-исключения **+12,6%**), все 12 пар **−25,5%**;
tool calls 2,6 vs 4,3 (−40%); wall 19с vs 27с (−30%).

## Paired Results: Embeddings (bge-m3)

| Проект | Skill | tool | baseline | Δ токенов | Грейд T/B |
|---|---|---:|---:|---:|---|
| icde | research | 7 100 | 21 620 | −67,2% | 1.00/1.00 |
| icde | implement | 11 608 | 9 603 | +20,9% | pass/pass |
| idshka | research | 14 382 | 6 348 | +126,6% | 1.00/1.00 |
| idshka | implement | 11 744 | 25 205 | −53,4% | pass/pass |
| flutter_plane | research | 10 282 | 23 005 | −55,3% | 1.00/1.00 |
| flutter_plane | implement | 17 489 | 5 781 | +202,5% | pass/pass |
| anthill | research | 17 659 | 19 101 | −7,5% | 1.00/1.00 |
| anthill | implement | 15 438 | 3 569 | +332,6% | pass/pass |
| lorawrite | research | 5 679 | 16 666 | −65,9% | 1.00/1.00 |
| lorawrite | implement | 7 799 | 5 328 | +46,4% | pass/pass |
| secret-santa | research | 5 230 | 4 329 | +20,8% | 1.00/1.00 |
| secret-santa | implement | 4 544 | 3 525 | +28,9% | pass/pass |

Агрегаты EMB: research **−33,8%** (60 332 vs 91 069), implement **+29,4%**
(68 622 vs 53 011), все 12 пар **−10,5%**.

## Выводы: когда инструмент помогает, а когда нет

| Профиль | Вывод |
|---|---|
| Research, volume medium/large | ✅ Основная зона пользы: −10…−76% токенов, −40% tool calls. Предиктор — «цена холодного исследования» у baseline (7–9 вызовов → максимальная экономия). |
| Implement, большой запутанный проект | ⚠️ Единственный implement-выигрыш: laravel −64% (baseline 8 вызовов / 38k токенов против 2 вызовов у tool-руки). |
| Implement, точечные правки | ❌ FTS +5…+30% на 4/6; EMB до +333% — нерелевантный контекст сбивает модель с прямого пути. |
| Tiny/small проекты | ❌ secret-santa (85 файлов): research +10%, implement +30%. Контекста и так мало. |
| Узкий вопрос мимо прошлых сессий | ❌ laravel research +47% FTS / +127% EMB — память подмешивает нерелевантное. |
| FTS vs EMB | FTS — стабильный дефолт (−26% research, +13% implement без laravel). EMB — сильнее в research (−34%), разрушительнее в implement (+29% суммарно). |

Механика: во всех tool-руках L1 (извлечённые факты) = 0, работали только
L0-фрагменты диалогов (по 3 на запрос). Весь выигрыш обеспечен переносом «карты
проекта» между сессиями.

## Ограничения

- n=1 на ячейку, без повторностей; выбросы (laravel research, unity/flutter
  implement на EMB) не усреднены.
- Грейдер research — регексп-факты: измеряет полноту фактов, не стилистику.
- Прогон выполнен вне AIFHub `ai-tester` harness на user-owned bench; метки
  проектов не совпадают с `project_dimensions` metadata, поэтому ни одна пара
  не является promotable `proven_label_evidence`.
- Delete/purge lifecycle, cross-project store isolation и MCP-поверхность не
  тестировались.
- Прогоны изолированы в throwaway worktree; деревья проектов не модифицированы.
