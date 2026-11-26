[Контракт SQZ](sqz.md) · [Исследования инструментов](README.md) · [Далее: полные задачи Pi](sqz-pi-live-matrix.md)

# Результаты AI Tester: baseline / AIFHub / sqz

AI Tester проверяет небольшие задачи с заранее известными ответами. Сначала приведён снимок #186, затем исходные результаты #133. Расход на исследование и редактирование проектов измерен отдельно в Pi. [Полные задачи Pi](sqz-pi-live-matrix.md) · [Контракт SQZ](sqz.md)

## Контрольные задачи #186

Windows, нативный Codex CLI 0.172.0, `gpt-6.1-terra / low`, full access, SQZ 1.3.0. На каждый из пяти сценариев запланированы три независимых повтора в режимах baseline (`off`), AIFHub и SQZ. Выполнены все 45 запусков. Проверку ответа прошли 44. В таблице тройка означает один повтор со всеми тремя режимами.

| Сценарий | Все три ответа верны / план | Тройки с подтверждённой последовательностью команд / план |
| --- | ---: | ---: |
| Повторное чтение | 3/3 | 3/3 |
| Изменение файла | 2/3 | 1/3 |
| Защищённая спецификация | 3/3 | 3/3 |
| Новая сессия с подготовленным локальным кэшем | 3/3 | 3/3 |
| Короткая конфигурация | 3/3 | 3/3 |
| **Всего** | **14/15** | **13/15** |

Во втором повторе после изменения файла baseline пропустил новые значения. В первом повторе AIFHub дал правильный ответ с неполной последовательностью команд. При подготовке новой сессии одна попытка остановилась до обращения к модели. Повтор с коротким временным путём прошёл. Для этого сценария заполнение внешнего кэша провайдера не подтверждено. [Наблюдения по режимам и повторам](context-dedup-ai-tester/issue-186/snapshots/2026-11-25-windows-sqz-1.3.0/observations.json)

Для трёх повторных чтений в режиме SQZ суммарный объём выдачи составил 43 026 из 43 026 исходных байт. Для трёх чтений в новой сессии тот же режим выдал 24 785 из 42 156 байт. Эти величины описывают текст чтений. Расход всей задачи учитывается отдельно по данным модели. [Агрегат по классам чтений](context-dedup-ai-tester/issue-186/snapshots/2026-11-25-windows-sqz-1.3.0/aggregate.json)

### Как воспроизвести снимок #186

Из корня репозитория выполните команду с Node.js 22 или новее. Выберите свободное имя выходного файла. Для пересчёта используются опубликованные числовые наблюдения, доступ к модели и установка SQZ не требуются.

```sh
node docs/memory-tools-research/context-dedup-ai-tester/issue-186/rebuild-snapshot.mjs docs/memory-tools-research/context-dedup-ai-tester/issue-186/snapshots/2026-11-25-windows-sqz-1.3.0/observations.json aggregate-rebuilt.json
```

Сравните результат побайтово с `aggregate.json` этого снимка. В `observations.json` раздел `pins` фиксирует ревизии, SHA-256 бинарников, manifest, исходных файлов и фикстур. В агрегате `successful` перечисляет повторы с тремя верными ответами, `comparable` — повторы, вошедшие в сравнение. Для каждой метрики `n` показывает число пар с доступными значениями. [Описание измерений и ограничений](context-dedup-ai-tester/issue-186/coverage.md)

## Историческая матрица #133 (r4)

- Date: `2026-07-26`
- Runner repository: `lee-to/ai-tester`
- Runner commit: `98dd5afb3fe9b9b7593d21dc93bcbc6d98c2cca9`
- Model: `gpt-5.6-luna`
- Reasoning: `low`
- Repetitions: `1`
- Cases: `repeat-source`, `changed-source`, `protected-openspec`, `fresh-session-preseeded-cache`
- Arms per case: baseline, AIFHub, `ojuschugh1/sqz`
- Total rows: `12`

`sqz` pin:

- version `1.3.0`;
- source commit `d024b6b6bec152dfa7a63e2316054b1bb33a8110`;
- release archive SHA-256 `8243989670198FC0251404A330D843224D896FC6AAB1DE8233D73A0C1AA04158`;
- official `sqz.exe` SHA-256 `0C21ADFA0C67B6EB61EDD2B8B87C836AC2757A58D0D68D93376606E6CC75E76B`;
- runtime: официальный CLI через `aifhub.contextDedup.mode: sqz`;
- args: fixed `compress --no-cache`; exact repeats обслуживает AIFHub session ledger.

## Raw Mixed Aggregate

| arm | passed | input bytes | output bytes | saved bytes | saved % |
|---|---:|---:|---:|---:|---:|
| baseline | 4/4 | 105 260 | 105 260 | 0 | 0 |
| AIFHub | 4/4 | 105 260 | 91 099 | 14 161 | 13.45 |
| sqz | 4/4 | 105 260 | 54 081 | 51 179 | 48.62 |

Это mixed/unadjusted view, не рейтинг алгоритмов dedup. Savings — model-visible payload delta, а не billing token count. `sqz` savings смешивают stateless first-read/changed-content compression и exact-repeat AIFHub replay; protected artifacts остаются полными.

## Payload Classes

Для каждого режима r4 в классе первого чтения и в классе protected измерено по два чтения. В остальных трёх классах измерено по одному чтению на режим.

| class | input bytes | AIFHub saved | AIFHub % | sqz saved | sqz % | сравнимость |
|---|---:|---:|---:|---:|---:|---|
| first read | 31 015 | 0 | 0 | 22 296 | 71.89 | stateless compression, не dedup |
| exact repeat | 14 342 | 14 161 | **98.74** | 14 161 | **98.74** | один AIFHub session replay contract |
| changed content | 16 673 | 0 | 0 | 8 537 | 51.20 | stateless compression, не exact-repeat |
| protected OpenSpec | 29 178 | 0 | 0 | 0 | 0 | оба enabled mode возвращают full content |
| fresh session | 14 052 | 0 | 0 | 6 185 | 44.02 | stateless compression, correctness PASS |

На сопоставимом exact-repeat payload разницы между AIFHub и SQZ нет: оба
возвращают replay `181 B`. Разница raw aggregate возникает из-за дополнительной
stateless compression SQZ на первом и изменённом чтении.

## Adjusted And Fair Views

| view | baseline saved | AIFHub saved | sqz saved | смысл |
|---|---:|---:|---:|---|
| exact repeat only | 0% | **98.74%** | **98.74%** | только второй неизменённый read |
| fair two-read exact-repeat | 0% | **49.37%** | **49.37%** | первый read принудительно полный у всех arms |
| correctness-adjusted aggregate | 0% | **13.45%** | **48.62%** | все текущие rows прошли |
| policy + correctness adjusted | 0% | **13.45%** | **48.62%** | protected rows уже полные |

Даже adjusted aggregate сохраняет у SQZ first-read/changed-content compression,
поэтому для качества именно dedup authoritative view — exact repeat only.
Delta/reference provider output в текущем runtime запрещён `--no-cache` и
дополнительно отклоняется fail-open.

## Case Result

| case | baseline | AIFHub | sqz | ключевой outcome |
|---|---|---|---|---|
| `repeat-source` | PASS, full/full | PASS, full/deduplicated | PASS, compressed/reference | оба инструмента сохранили exact answer |
| `changed-source` | PASS, full/full | PASS, full/changed | PASS, compressed/compressed | changed content сохранил точные значения |
| `protected-openspec` | PASS, full/full | PASS, protected/protected | PASS, protected/protected | SQZ process не запускался |
| `fresh-session-preseeded-cache` | PASS, full | PASS, full | PASS, compressed | новая model session получила самодостаточный текст |

Исторический `r3` до `--no-cache` оставлен отдельным regression snapshot:

- В профиле Windows `gpt-5.6-luna / low` одна новая сессия должна была извлечь два точных значения из фикстуры.
- В r3 модель получила только ссылку из постоянного кэша Windows CLI и не восстановила ни одного значения. В r4 тот же сценарий вернул оба значения.

## Воспроизведение исторической матрицы

Для r4 использовались 12 сценариев. Генератор без `--manifest` ожидает исходники, совпадающие по SHA-256 с историческим каталогом. Команды ниже описывают этот стенд. Для снимка #186 используйте команду пересчёта выше. [Каталог r4](context-dedup-ai-tester/matrix-catalog.json)

```powershell
node docs/memory-tools-research/context-dedup-ai-tester/generate-matrix.mjs `
  --output $newSnapshotDir `
  --sqz-exe $verifiedSqzExe
```

Generator проверяет официальный binary SHA-256 и source pins до копирования,
требует новый output directory и сохраняет собственные
generator/summarizer/runtime copies. Для PowerShell задайте `$newSnapshotDir` как путь нового каталога и `$verifiedSqzExe` как путь к проверенному бинарнику. Для запуска требуется AI Tester указанной выше ревизии и сгенерированный каталог сценариев.
Исторический source adapter сохранён в
[`context-dedup-ai-tester/sqz-adapter`](context-dedup-ai-tester/sqz-adapter),
но текущая runtime matrix его не использует.
Для исторического пересчёта задайте `$runsDir` как каталог исходных трасс и `$startIso` как время начала прогона в ISO 8601. В `$newSummaryDir` ещё не должно быть файла `matrix-summary.json`.

```powershell
node docs/memory-tools-research/context-dedup-ai-tester/summarize-matrix.mjs `
  --runs $runsDir `
  --output $newSummaryDir `
  --since $startIso
```

Summarizer требует ровно 12 traces, не сохраняет model final output, строит disjoint payload classes/adjusted views и отказывается перезаписывать существующий `matrix-summary.json`.

Опубликованный immutable snapshot:
`.ai-factory/state/context-dedup-issue-133/ai-tester/sqz-luna-low-20260726-r4/matrix-summary.json`,
`--since 2026-07-26T18:05:54.5038488Z`. Исторические `r1`–`r3` не
перезаписывались; `r3` хранит воспроизводимый dangling-reference regression.

`scripts/context-dedup-benchmark.mjs` остаётся deterministic regression harness:

```bash
node scripts/context-dedup-benchmark.mjs --mode baseline --mode variant-a
node scripts/context-dedup-benchmark.mjs \
  --mode external \
  --external-command "<verified-sqz-adapter>" \
  --external-arg "--store" \
  --external-arg ".external-home/sessions.db" \
  --external-protocol sqz-text \
  --json
```

Harness:

- создаёт owned temporary workspace даже при supplied parent;
- отклоняет absolute/traversal/reserved trace paths;
- передаёт external candidate raw stdin;
- различает `compressed`, `delta`, `reference` и `full`;
- считает dedup hit только для reference;
- ограничивает external process timeout и output;
- использует isolated HOME/XDG/SQZ paths и не наследует credential env по умолчанию;
- fail-open возвращает полный content при error, timeout или output limit.

## Вывод для r4

На Windows в профиле r4 `gpt-5.6-luna / low` каждый режим прошёл четыре из четырёх сценариев. В сумме AIFHub сократил объём выдачи на 13,45%, SQZ — на 48,62%. В SQZ в результат вошли сжатие первого и изменённого чтений и выдача маркера при точном повторе. Защищённые артефакты в этом прогоне выдавались полностью.

## См. также

- [Настройка режимов и границы повторного чтения](../context-dedup.md)
- [Инвентарь проверок и результаты #186](context-dedup-ai-tester/issue-186/coverage.md)
