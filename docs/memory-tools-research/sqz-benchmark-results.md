# Результаты AI Tester: baseline / AIFHub / sqz

Evidence для issue #133. Описание `sqz` и policy boundary — в [sqz.md](sqz.md), собственный сервис — в [Session Context Dedup](../context-dedup.md).

## Runtime Matrix

- Date: `2026-07-26`
- Runner repository: `C:\projects\ai-tester`
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

- expected: `CROSS_SESSION_SECRET=violet-cedar-927`, `OWNER=agent-session-beta`;
- actual: оба значения `unresolved`, row FAIL;
- причина: Windows CLI использовал persistent user cache и вернул новой model session только `§ref:cabbfc33285196a2§`;
- текущий `r4`: оба точных значения восстановлены, row PASS.

## Offline Harness

Точный generator 12 сценариев и fixture tree хранится рядом с authored smoke-сценариями:

```powershell
node docs/memory-tools-research/context-dedup-ai-tester/generate-matrix.mjs `
  --output .ai-factory/state/context-dedup-issue-133/ai-tester/<new-snapshot> `
  --sqz-exe C:\path\to\verified\sqz.exe
```

Generator проверяет официальный binary SHA-256 и source pins до копирования,
требует новый output directory и сохраняет собственные
generator/summarizer/runtime copies. Затем матрицу можно выполнить из
`C:\projects\ai-tester` через `cargo run -- run --dir <scenarios>`.
Исторический source adapter сохранён в
[`context-dedup-ai-tester/sqz-adapter`](context-dedup-ai-tester/sqz-adapter),
но текущая runtime matrix его не использует.
После запуска `summarize-matrix.mjs` собирает последние 12 traces без сохранения model final output:

```powershell
node docs/memory-tools-research/context-dedup-ai-tester/summarize-matrix.mjs `
  --runs C:\projects\ai-tester\runs `
  --output .ai-factory/state/context-dedup-issue-133/ai-tester/<new-snapshot> `
  --since <run-start-iso>
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

## Вывод

Все arms прошли `4/4`. AIFHub сохранил `13.45%` raw aggregate за счёт exact
same-session replay. SQZ mode сохранил `48.62%`: те же `98.74%` на exact repeat
плюс stateless first-read/changed-content compression, без compression
protected artifacts и без cross-session references. `aifhub` остаётся
dependency-free recommended default opt-in; `sqz` — более агрессивный optional
user-owned mode с отдельной установкой, лицензией и user-state caveat.
