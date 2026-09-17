# TencentDB Agent Memory — Screening Benchmark Results

Tool ID: `tencentdb-agent-memory`
Issue: [ichinya/aifhub-extension#201](https://github.com/ichinya/aifhub-extension/issues/201)
Дата: 2026-09-14. Методика: paired screening (baseline `rg`-агент против агента с memory-инъекцией), раннер `pi` (@earendil-works/pi-coding-agent 0.85.1), модель `la/ornith-1.5-35b-a3b` через OmniRoute, `--thinking medium`, `--no-session --no-context-files --no-skills --no-prompt-templates --no-extensions`.

Испытуемая поверхность: `@tencentdb-agent-memory/memory-tencentdb@1.0.2` (repo release v2.0.1), standalone Gateway HTTP (`/capture`, `/recall`, `/search/memories`, `/search/conversations`, `/session/end`) на `127.0.0.1:8431`, `TDAI_DATA_DIR` в изолированном каталоге, LLM-контур экстракции — та же модель через OmniRoute. Краткосрочное сжатие (Context Offload, headline −61%) **не тестировалось**: требует OpenClaw-хост и патч `afterToolCall` — поверхности в pi нет.

## Протокол

На каждый проект (6 проектов × 2 skill'а × 2 руки = 24 тестовых прогона + 12 seed):

1. **Seed-сессии (только tool-рука):** `A_research` — обзорная карта проекта (tools: read,bash); `A_impl` — реализация мелкой задачи (all tools). Обе захватываются в память через `/capture` + `/session/end`.
2. **Тестовые пары (B):** связанный research-вопрос (read-only tools) и связанная impl-задача (all tools). Tool-рука получает инъекцию из `/search/memories` + `/search/conversations` (+ `/recall` persona, если есть); baseline-рука стартует холодной. Промпт, модель, thinking — идентичны.
3. Все прогоны выполняются в throwaway `git worktree` от HEAD; пользовательские деревья не затрагиваются.
4. Градация: research — доля проверяемых фактов (path/identifier regex), impl — объективный grep-чек изменения; замеры — usage из JSON-событий pi, tool calls, wall time.

Безопасность: после инцидента с auto-repair (см. «Инцидент» ниже) все прогоны изолированы в worktrees; локальные копии проектов сверены с их локальными оригиналами по `git status`.

## Матрица проектов

| Проект | Стек | Метки | Объём |
|---|---|---|---|
| profile-ts-micro | TypeScript, React+Vite | small_microservice | 19 files |
| profile-php-laravel | PHP, Laravel | large_framework_app | 935 files |
| profile-dart-flutter | Dart, Flutter+Riverpod | large_framework_app | 229 files |
| profile-cs-unity | C#, Unity | large_framework_app | 236 files |
| profile-pyts-monorepo | Python+TS, FastAPI+React монорепо | monorepo | 162 files |
| profile-pyts-fullstack | Python+TS, FastAPI+React+Zustand | polyglot_fullstack | 85 files |

## Результаты (тестовые пары B)

Матрица прогнана дважды: **конфигурация A** — FTS-only (embeddings off, дефолт), **конфигурация B** — embeddings on (bge-m3 через Ollama, 1024 dims, hybrid). Качество во всех 48 прогонах: 1.00 / PASS.

### Конфигурация A: FTS-only (embeddings off)

#### Research skill (связанный вопрос после seed-обзора)

| Проект | Tool tokens | Base tokens | Δ tokens | Tool tools | Base tools | Tool wall | Base wall | Качество |
|---|---|---|---|---|---|---|---|---|
| profile-ts-micro | 11 528 | 15 138 | **−24%** | 2 | 3 | 18s | 22s | 1.00 / 1.00 |
| profile-php-laravel | 7 915 | 5 372 | **+47%** ⚠ | 2 | 2 | 20s | 22s | 1.00 / 1.00 |
| profile-dart-flutter | 5 609 | 23 296 | **−76%** | 1 | 7 | 14s | 38s | 1.00 / 1.00 |
| profile-cs-unity | 23 694 | 26 394 | **−10%** | 7 | 7 | 41s | 48s | 1.00 / 1.00 |
| profile-pyts-monorepo | 25 020 | 31 452 | **−20%** | 7 | 9 | 40s | 54s | 1.00 / 1.00 |
| profile-pyts-fullstack | 4 791 | 4 348 | **+10%** ⚠ | 1 | 2 | 10s | 15s | 1.00 / 1.00 |

### Implement skill (связанная задача после seed-реализации)

| Проект | Tool tokens | Base tokens | Δ tokens | Tool tools | Base tools | Tool wall | Base wall | Результат |
|---|---|---|---|---|---|---|---|---|
| profile-ts-micro | 12 155 | 11 554 | **+5%** | 2 | 3 | 17s | 21s | PASS / PASS |
| profile-php-laravel | 13 564 | 37 982 | **−64%** | 2 | 8 | 23s | 45s | PASS / PASS |
| profile-dart-flutter | 12 433 | 10 558 | **+18%** ⚠ | 3 | 4 | 18s | 19s | PASS / PASS |
| profile-cs-unity | 5 439 | 5 778 | **−6%** | 1 | 2 | 9s | 15s | PASS / PASS |
| profile-pyts-monorepo | 9 973 | 8 182 | **+22%** ⚠ | 2 | 3 | 11s | 16s | PASS / PASS |
| profile-pyts-fullstack | 4 536 | 3 480 | **+30%** ⚠ | 1 | 1 | 7s | 6s | PASS / PASS |

### Конфигурация B: Embeddings on (bge-m3) и сравнение с A

| Проект | Skill | B: tool/base (Δ) | Tool-рука A→B | Базовая рука A→B |
|---|---|---|---|---|
| profile-ts-micro | research | 7,1k / 21,6k (**−67%**) | −38% | +43% |
| profile-ts-micro | implement | 11,6k / 9,6k (+21%) | −5% | −17% |
| profile-php-laravel | research | 14,4k / 6,3k (+127%) | +82% | +18% |
| profile-php-laravel | implement | 11,7k / 25,2k (−53%) | −13% | −34% |
| profile-dart-flutter | research | 10,3k / 23,0k (−55%) | +83% | −1% |
| profile-dart-flutter | implement | 17,5k / 5,8k (+203%) | +41% | −45% |
| profile-cs-unity | research | 17,7k / 19,1k (−8%) | −25% | −28% |
| profile-cs-unity | implement | 15,4k / 3,6k (+333%) | +184% | −38% |
| profile-pyts-monorepo | research | 5,7k / 16,7k (−66%) | −77% | −47% |
| profile-pyts-monorepo | implement | 7,8k / 5,3k (+46%) | −22% | −35% |
| profile-pyts-fullstack | research | 5,2k / 4,3k (+21%) | +9% | −0% |
| profile-pyts-fullstack | implement | 4,5k / 3,5k (+29%) | +0% | +1% |

### Агрегаты по 12 парам

| Конфигурация | Tool-рука (сумма) | Baseline (сумма) | Δ | Tool calls avg | Wall avg |
|---|---|---|---|---|---|
| A: FTS-only | 136 657 | 183 534 | **−26%** | 2,6 vs 4,3 | 19s vs 27s |
| B: Embeddings | 128 954 | 144 080 | **−10%** | 2,6 vs 3,5 | 19s vs 22s |

**Чтение агрегатов:** прямое сравнение tool-руки A vs B (та же задача, обе с памятью): 136 657 → 128 954 (−5,6%), при этом 6/12 клеток дешевле с B и 6/12 дороже — **систематического эффекта embeddings на стоимость нет**. Разница агрегатных Δ (−26% vs −10%) объясняется не embeddings, а дисперсией baseline-руки между запусками (холодные прогоны в B случайно вышли дешевле: 144k против 183k).

### Амортизация seed-сессий

Seed-сессии стоят ~11–21k tokens на проект (2 захваченных диалога). Окупаемость:

| Проект | Экономия за пару B (2 задачи) | Окупаемость seed (~17k) |
|---|---|---|
| profile-php-laravel | −21 875 | сразу (1 пара) |
| profile-dart-flutter | −15 812 | сразу (1 пара) |
| profile-pyts-monorepo | −4 641 | ~4 пары |
| profile-cs-unity | −3 039 | ~6 пар |
| profile-ts-micro | −3 009 | ~6 пар |
| profile-pyts-fullstack | +1 499 (убыток) | никогда |

## Когда инструмент полезен, а когда нет

Паттерны проверены в обеих конфигурациях — значимы только те, что воспроизвелись дважды.

**Помогает (устойчиво, в обеих конфигурациях):**

1. **Research на средних/больших репо после уже покрытой темы** — 4/6 проектов дали экономию в обеих конфигурациях: profile-ts-micro (−24%/−67%), profile-dart-flutter (−76%/−55%), profile-cs-unity (−10%/−8%), profile-pyts-monorepo (−20%/−66%). Агент начинает с готовых фрагментов диалога и пропускает разведку.
2. **Implementation-continuity в самых больших кодовых базах** — profile-php-laravel B_impl: −64% (A) и −53% (B): холодный baseline стабильно «блуждает» (8 tool calls, 25–38k tokens), memory-рука идёт по следам seed-сессии (2 calls, 11–13k).

**Не помогает / вредит (устойчиво):**

1. **Малые проекты (<100 файлов)** — profile-ts-micro impl и profile-pyts-fullstack обе skill'а: инъекция добавляет input tokens поверх дешёвой разведки; убыток или шум в обеих конфигурациях.
2. **Narrow-вопрос после broad-seed** — profile-php-laravel B_research: +47% (A) и +127% (B). L0-фрагменты обзора не покрывают узкую тему; агент платит за память и всё равно исследует заново. Воспроизвелось дважды — это не выброс.
3. **Impl-экономия в средних репо ненадёжна** — profile-dart-flutter (+18%/+203%), profile-pyts-monorepo (+22%/+46%): в обеих конфигурациях убыток; единственная impl-экономия вне laravel-профиля — profile-cs-unity −6% (A), обернувшаяся +333% (B).

**Механистическое объяснение:** вся измеренная ценность пришла из **L0 raw conversation search** (всегда ровно 3 фрагмента; в конфигурации B — семантическое ранжирование). **L1/L2/L3 pipeline для проектного контента не сработал ни разу в 24 парах**: L1-экстракция вернула 0 записей на все проектные сессии (критерии заточены под user-facts/preferences), L2 скипается («No new L1 records»), persona не создаётся, `/recall` всегда отдавал пустой context. Экономия получена «сырым» поиском по истории диалогов — ценный, но значительно более простой механизм, чем заявленная многослойная память. Суммарно: A −26%, B −10% против своих базлайнов (разница агрегатов — шум baseline-руки, а не эффект embeddings).

## Находки о качестве инструмента

1. **FTS-поиск не работает с кириллицей**: `buildFtsQuery` выбрасывает не-ASCII токены из запроса (для «пользователь проект» → `No usable FTS tokens`); L1-записи на русском принципиально не находятся русскими запросами. Работают только ASCII-идентификаторы (имена библиотек/пакетов из зависимостей проекта). Для ru-язычного использования — блокер keyword-стратегии.
2. **EmbeddingService по умолчанию выключен** (`provider: "none"`) — `recall.strategy=hybrid` молча деградирует в keyword. Follow-up с включёнными embeddings (bge-m3) — см. раздел выше: кириллический recall появляется, но без измеримой экономии.
3. **Gateway v1 `/recall` возвращает только `appendSystemContext`** (persona/scene-nav) — L1 `prependContext` в ответе теряется; клиенту нужен отдельный `/search/memories`.
4. **README-цифры (−61% tokens) не воспроизводимы в данной конфигурации**: они относятся к Context Offload в OpenClaw, не к memory recall.
5. **`bm25.language` по умолчанию `zh`** — jieba-токенизация, для en/ru проектов требуется конфигурация (en покрывает ASCII-кейс).
6. Encoding: L0 хранит кириллицу корректно при UTF-8-клиенте (мохеринг в первых смоук-тестах был артефактом curl/Windows-console, не инструмента).

## Embeddings follow-up (2026-09-15)

Проверка векторного пути (в основном прогоне embeddings были выключены — дефолт `provider: "none"`):

1. **Локальный провайдер официально недоступен.** В v1.0.2 `provider: "local"` на входе нормализации маппится в `none` + configError («Local embedding provider is not available in user config»); код `LocalEmbeddingService` (node-llama-cpp + embeddinggemma-300m) сохранён как dead code. Единственный рабочий путь — **remote OpenAI-compatible** (`baseUrl/apiKey/model/dimensions`, `sendDimensions: false` для BGE-M3).
2. **Рабочая конфигурация проверена**: Ollama `bge-m3` (1024 dims) → `embeddingService: true`, `strategy: hybrid`, векторные таблицы `l1_vec`/`l0_vec` создаются. Нюанс отладки: embedding-конфиг читается только из секции `memory:` gateway-yaml — топ-левел ключ молча игнорируется.
3. **Кириллический recall починен частично**: чисто русские запросы (раньше «No usable FTS tokens») теперь возвращают результаты, `l0_vec` даёт семантический поиск по сообщениям. Но точность на уровне сообщений средняя: 4/6 строгих попаданий (top-1 не всегда сообщение с фактом, ранжирование шумное).
4. **L1-экстракция не изменилась**: для проектных сессий по-прежнему 0 атомов — векторы используются только для dedup при capture; проектное знание по-прежнему не атомизируется.
5. **Бенчмарк-клетка (большой framework, paired re-run) значимого улучшения не показала**: research-пара tool 14 382 vs base 6 348 (было +47% → стало +127%), impl-пара −53% (было −64%); инъекция по-прежнему 3 L0-фрагмента, L1=0. Дельты внутри шума одной пары — точность recall не транслировалась в экономию.
6. **Privacy**: remote-embeddings отправляют контент диалогов во внешний сервис; локальный inference (Ollama) приватен.

Итог: embeddings — необходимая, но не достаточная опция для ru-язычных проектов: они устраняют пустой recall, но не решают главную проблему (проектное знание не попадает в L1/L2), а измеримой дополнительной экономии не дали.

## Инцидент и безопасность

Первая версия оркестратора делала auto-repair dirty-деревьев (`git checkout -- .` + удаление untracked) и уничтожила незакоммиченную работу в четырёх локальных копиях проектов. Полностью восстановлено из локальных оригиналов (15+43+24 файла; profile-php-laravel — 3 строки `.gitignore`; сверка `git status` попарно). После инцидента: (а) все прогоны — только в throwaway worktrees; (б) запрещён любой git-мутирующий шаг в пользовательских деревьях; (в) research-агенты получают `--tools read,bash` — при этом замечено, что bash всё же позволяет писать файлы (один research-агент поправил нецелевой файл; откатлено) — для строгой read-only нужен `--tools read`.

## Ограничения

- 1 пара на клетку × 2 конфигурации — screening-уровень, доминирующая дисперсия между прогонами: baseline-рука одних и тех же холодных задач расходовала 38,0k → 25,2k (profile-php-laravel implement) и 10,6k → 5,8k (profile-dart-flutter implement) между конфигурациями; tool-рука тоже гуляла (5,4k → 15,4k, profile-cs-unity implement). Выводы по отдельным клеткам не устойчивы; устойчивы только кросс-конфигурационные паттерны: research помогает на средних/больших репо в обеих конфигурациях, implement-экономия ненадёжна, малые проекты — убыток в обеих.
- Экстракция и recall — на той же 35B-модели через OmniRoute; продукт проектировался под gpt-4o-класс экстракцию.
- Seed-промпты писались под покрытие тем B-задач — это честная модель continuity-сценария «сессия 1 → сессия 2», но не случайный поток работы.
- Качество ответов не дифференцировалось (факты слишком легко проверялись) — вывод только по стоимости, не по качеству на сложных задачах.

## Вывод для AIFHub

По итогам бенчмарка (2026-09-15) инструмент внесён в `recommendation-metadata.yaml` как `conditional_external_runtime_only` (`suggest_when_en_continuity_or_research`, avoid_by_default + exact screening gate) — см. «Политика AIFHub» в [research-документе](tencentdb-agent-memory.md).

Что из этого следует:

- как **автоматически устанавливаемый AIFHub-provider** инструмент по-прежнему непригоден: нет CLI/MCP, npm postinstall патчит host-рантайм, complete-purge не гарантируется производителем — инсталляция/запуск/очистка остаются user-owned;
- **в рекомендациях** он появляется только при exact screening match (en/ASCII, standard/large репо, continuity/research задачи, живой пользовательский gateway) — ровно те клетки, где бенчмарк показал устойчивую экономию (research-follow-up −20%..−67% в обеих конфигурациях; impl-continuity на самом большом репо −53%..−64%);
- эффект получен поиском по L0-диалогам и воспроизводим более простыми средствами (локальный лог диалогов + FTS/rg) — это надо учитывать при будущем сравнении с нативным continuity-механизмом AIFHub;
- для перехода в `proven_label_evidence` (recommend/conditional поверх screening) потребуются ai-tester прогоны: ≥2 PASS/PASS пары на exact runtime/platform profile, isolation/purge-чеки, и отказ upstream от postinstall-патчинга хоста.
