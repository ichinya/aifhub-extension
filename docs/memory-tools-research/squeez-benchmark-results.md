# Результаты Тестов squeez И Трёхстороннее Сравнение Dedup

Этот файл содержит evidence по issue #133. Описание инструмента и политика использования — в [squeez.md](squeez.md), описание собственного сервиса — в [Session Context Dedup](../context-dedup.md).

Важно: paired `ai-tester` runs по dedup-вариантам пока `NOT_RUN` (см. раздел ниже). Ниже приведён детерминированный offline replay, а не модельный прогон.

## Методика

Харнесс: `scripts/context-dedup-benchmark.mjs`. Он воспроизводит одну и ту же последовательность чтений в трёх режимах и считает реально выданные байты.

```bash
node scripts/context-dedup-benchmark.mjs --mode baseline --mode variant-a
HOME=<isolated-home> node scripts/context-dedup-benchmark.mjs \
  --mode baseline --mode variant-a --mode external \
  --external-command "<path>/squeez compress-output"
```

Trace `aifhub-session-replay` (built-in, детерминированный): 12 чтений, 5 файлов, 6 повторных чтений, включая:

- обычный source-файл с двумя ревизиями (проверка changed-content);
- второй source-файл с повторным чтением;
- `openspec/specs/auth/spec.md` — protected artifact, читается дважды;
- `.ai-factory/qa/add-oauth/coverage.json` — protected artifact, читается дважды;
- файл меньше `minBytes`, читается дважды.

Режимы:

| Режим | Что делает |
|---|---|
| `baseline` | Выдаёт полное содержимое на каждое чтение. |
| `variant-a` | Вызывает `recordRead()` из `scripts/context-dedup.mjs` (`aifhub.contextDedup.enabled: true`). |
| `external` | Передаёт PostToolUse payload во внешнюю команду и применяет `updatedToolOutput`. Проверен с `squeez 1.43.0 compress-output`. |

Изоляция variant B: отдельный `HOME`, `squeez setup` не запускался, hooks в user-level конфиг не писались.

## Результат 3-way (2026-07-25)

| mode | reads | emitted bytes | saved bytes | saved % | est. saved tokens | changed served | protected served |
|---|---|---:|---:|---:|---:|---|---|
| baseline | 12 | 59 830 | 0 | 0 | 0 | yes | yes |
| variant-a | 12 | 41 578 | 18 252 | 30.51 | 4 563 | yes | yes |
| external (`squeez`) | 12 | 30 200 | 29 630 | 49.52 | 7 408 | yes | **NO** |

Оценка токенов — эвристика `ceil(savedBytes / 4)`, не биллинговый счётчик.

## Разбор Dedup-хитов

| mode | hits | что дедуплицировано |
|---|---:|---|
| variant-a | 3 | `src/auth/session.ts` (6 137 B), `src/auth/tokens.ts` (5 978 B), `src/auth/session.ts` (6 137 B) |
| external (`squeez`) | 5 | те же три чтения (6 462 + 6 301 + 6 462 B) **плюс** `openspec/specs/auth/spec.md` (3 580 B) и `.ai-factory/qa/add-oauth/coverage.json` (6 825 B) |

Вся разница в экономии между вариантами объясняется двумя protected artifacts: 3 580 + 6 825 = 10 405 B из 11 378 B дельты, остальное — более короткий replay-маркер `squeez` против многострочного replay-сообщения варианта A.

На policy-совместимом подмножестве чтений экономия вариантов сопоставима: variant A 18 252 B против 19 225 B у `squeez`.

## Корректность

| Проверка | baseline | variant-a | external (`squeez`) |
|---|---|---|---|
| Изменённое содержимое отдаётся полностью | pass | pass | pass |
| Protected validation artifacts отдаются полностью | pass | pass | **fail** (2 из 4 protected чтений дедуплицированы) |
| Файл меньше порога не дедуплицируется | n/a | pass | pass (net-win gate) |
| Fail-open при недоступном инструменте | n/a | pass (dedup выключен -> полный контент) | pass (пустой stdout -> полный контент; проверено отдельным тестом с несуществующим бинарём) |
| Файлы проекта не переписываются | pass | pass | pass |

## Ограничения Замера

- Это offline replay tool-output, а не реальный модельный прогон: он показывает сэкономленные байты контекста, но не изменение поведения модели и не итоговый биллинг.
- Trace синтетический и намеренно содержит protected artifacts; на трассах без них разрыв между вариантами исчезает.
- `squeez` умеет больше, чем dedup (bash-фильтры, summarize, TOON). Здесь измерен только dedup повторных чтений — то, о чём issue #133.
- Проверялся Linux x86_64 binary `1.43.0`; поведение hooks в конкретных host CLI не проверялось.

## AI Tester: NOT_RUN

Paired `ai-tester` прогоны baseline / variant A / variant B по [AI Tester Matrix Для Memory Tools](ai-tester-matrix.md) не выполнялись.

Причина: `ai-tester` запускает реальные agent runtimes и требует залогиненный `claude` или `codex` CLI либо настроенный ACP runtime. В окружении проверки таких runtimes и credentials нет.

Три native-сценария подготовлены в [context-dedup-ai-tester/](context-dedup-ai-tester/):

| Файл | Arm |
|---|---|
| [baseline-no-dedup.yaml](context-dedup-ai-tester/baseline-no-dedup.yaml) | baseline без dedup |
| [variant-a-aifhub-context-dedup.yaml](context-dedup-ai-tester/variant-a-aifhub-context-dedup.yaml) | variant A, `scripts/context-dedup.mjs` |
| [variant-b-squeez.yaml](context-dedup-ai-tester/variant-b-squeez.yaml) | variant B, `squeez compress-output` в изолированном `HOME` |

`ai-tester 1.2.0` был собран из исходников и все три сценария прошли структурную валидацию; прогон останавливается только на `codex CLI not found on PATH`. Запуск из корня репозитория:

```bash
ai-tester run --file docs/memory-tools-research/context-dedup-ai-tester/baseline-no-dedup.yaml
```

До реального прогона статус evidence — `NOT_RUN`, и `recommendation-metadata.yaml` по dedup-вариантам не меняется.

## Вывод

- Baseline остаётся корректным, но платит за каждое повторное чтение.
- Variant A даёт policy-совместимую экономию: protected validation artifacts всегда полные, ledger session-scoped и project-local, включение — explicit opt-in, зависимостей нет.
- Variant B (`squeez`) экономит больше только за счёт дедупликации protected validation artifacts, что прямо противоречит [Context Loading Policy](../context-loading-policy.md); плюс user-level hooks и prebuilt binary.

Рекомендация: использовать variant A внутри extension, а `squeez` документировать как user-owned optional tool с предупреждением про protected artifacts. Решение остаётся `conditional` до появления paired `ai-tester` evidence.
