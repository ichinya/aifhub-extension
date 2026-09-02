# Результаты Ponytail Pi A/B

Итог: `EXECUTED(mixed_non_promotable)`. Два полных implementation-only прогона не дают устойчивого преимущества Ponytail между моделями и стеками, поэтому policy остаётся `manual_experiment_only`.

Машиночитаемая обезличенная сводка находится в [results.json](results.json), а bounded row-level snapshots — в [Qwen aggregate](aggregate-qwen.json) и [LA aggregate](aggregate-la.json). Они содержат pins, SHA-256 и ограниченные метрики; raw Pi JSONL, ответы модели, prompts и локальные пути в репозиторий не добавлены.

## Envelope

| Run | Model | Rows | Complete pairs | Baseline PASS | Ponytail PASS |
|---|---|---:|---:|---:|---:|
| `ponytail-qwen-low-20260902-r4` | `omniroute` / `lq/qwen3.8-27b` | 24/24 | 12/12 | 6/12 | 8/12 |
| `ponytail-la-ornith-low-20260902-r2` | `omniroute` / `la/ornith-1.5-35b-a3b` | 24/24 | 12/12 | 11/12 | 9/12 |

Оба run используют Pi `0.84.4`, `thinking=low`, четыре повтора на arm и scenario, 900-секундный timeout, одинаковый tool allowlist, exact-commit disposable copies и Ponytail `v4.9.0` только как явно загруженный `SKILL.md` без hooks. Во всех 48 строках исходные snapshots и treatment resource остались неизменными; dependency-файлы не менялись.

## Correctness И Completion

| Model | Scenario | Baseline PASS | Ponytail PASS | Pair outcome |
|---|---|---:|---:|---|
| Qwen | TypeScript URL join | 4/4 | 4/4 | 4 both-pass |
| Qwen | Go safe decrypt | 1/4 | 3/4 | 2 Ponytail-only, 1 both-pass, 1 both-fail |
| Qwen | Laravel exact price | 1/4 | 1/4 | 1 Ponytail-only, 1 baseline-only, 2 both-fail |
| LA | TypeScript URL join | 4/4 | 4/4 | 4 both-pass |
| LA | Go safe decrypt | 3/4 | 4/4 | 1 Ponytail-only, 3 both-pass |
| LA | Laravel exact price | 4/4 | 1/4 raw | 1 both-pass, 2 comparable baseline-only, 1 provider-error pair excluded |

У LA Laravel r2 candidate Pi получил четыре assistant error events семейства HTTP 429/5xx, исчерпал три bounded auto-retries и не сделал ни одного tool call. Эта строка остаётся FAIL в raw runner aggregate, но её пара исключена из capability comparison как `NOT_COMPARABLE(provider_error)`.

После этого исключения остаются 23 сопоставимые пары: baseline прошёл 16, Ponytail — 17. Агрегат скрывает неоднородность: на TypeScript correctness одинаков (`8/8` у обоих arms), на Go Ponytail прошёл `7/8` против `4/8`, а на Laravel — `2/7` против baseline `4/7`.

## Efficiency На Both-Pass Парах

Failure и timeout rows не используются для LOC/token/time efficiency: сравниваются только пары, где оба arms завершились и прошли public validation, hidden grader и containment checks.

| Model | Pairs | Duration baseline → Ponytail | Source churn baseline → Ponytail | Reported tokens baseline → Ponytail |
|---|---:|---:|---:|---:|
| Qwen | 5 | 1448,996 → 1649,658 s (**+13,85%**) | 113 → 108 (**-4,42%**) | 36 133 → 46 454 (**+28,56%**) |
| LA | 8 | 580,907 → 474,931 s (**-18,24%**) | 576 → 391 (**-32,12%**) | 97 571 → 81 611 (**-16,36%**) |

Qwen и LA расходятся по времени и tokens. Даже внутри LA Laravel единственная both-pass пара была медленнее с Ponytail (`72,951 → 117,775 s`), хотя churn уменьшился (`91 → 57`). Provider вернул нулевую cost metadata для всех строк, поэтому денежная экономия имеет status `NOT_COMPARABLE(provider_cost_metadata_zero)` и не заявляется.

## Решение

- На Go есть повторяемый положительный correctness/completion signal, но не стабильное уменьшение LOC в каждом повторе.
- На Laravel Ponytail ухудшил correctness на сопоставимых LA-парах и был смешанным на Qwen.
- На TypeScript обе ветки надёжны, а efficiency зависит от модели: положительна на LA и отрицательна по времени/tokens на Qwen.
- Implementation-only proxy не запускал `/aif-review`, `/aif-security-checklist`, `/aif-verify` или `/aif-fix`, поэтому не закрывает полный promotion contract issue #137.

Ponytail не добавляется в extension, dependencies, recommendation metadata или lifecycle. Разрешённая роль остаётся прежней: отдельный user-selected implementation experiment, после которого все обычные AIFHub gates выполняются независимо.

Первые попытки запуска не являются evidence: runner оставлял stdin дочернего Pi открытым, из-за чего Pi ожидал EOF. В валидные результаты входят только два run выше, выполненные после исправления и regression-теста stdin EOF.
