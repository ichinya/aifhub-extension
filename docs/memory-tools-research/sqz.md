# sqz

Репозиторий: [ojuschugh1/sqz](https://github.com/ojuschugh1/sqz)

Проверенная версия: `1.3.0`, tag commit `d024b6b6bec152dfa7a63e2316054b1bb33a8110`, Elastic License 2.0.

Результаты замеров: [sqz-benchmark-results.md](sqz-benchmark-results.md).

Этот документ описывает variant B для issue #133: baseline без dedup, собственный [Session Context Dedup](../context-dedup.md) и optional user-owned `sqz`.

## Проверенный Контракт

`sqz compress` принимает исходный текст через stdin и возвращает model-visible текст через stdout. Публичный `sqz-engine` API `SqzEngine::with_preset_and_store(...).compress_with_cache(...)` использует тот же cache contract:

- первый read обычно возвращает compressed text;
- точный повтор может вернуть `§ref:<hash>§`;
- близкое изменённое содержимое через проверенный engine adapter может вернуть `§delta:<hash>§` и delta payload;
- `sqz expand` восстанавливает content, если соответствующий cache доступен;
- `--no-cache` или `SQZ_NO_DEDUP=1` отключают cache dedup;
- `sqz reset --cache-only --yes` очищает cache.

Это не PostToolUse JSON contract. Benchmark adapter передаёт raw text и отдельно считает compression, delta и reference; только `§ref` считается dedup hit.

## Проверенная Поставка

- Windows release archive SHA-256: `8243989670198FC0251404A330D843224D896FC6AAB1DE8233D73A0C1AA04158`
- Официальный `sqz.exe` SHA-256: `0C21ADFA0C67B6EB61EDD2B8B87C836AC2757A58D0D68D93376606E6CC75E76B`
- Проверенный `sqz-isolated-adapter.exe` SHA-256: `36318B6299026A3CFCF8D0E2D76EFF9FE7060889C72E0FA9B735F7C2918E0607`
- Source/tag checkout: `d024b6b6bec152dfa7a63e2316054b1bb33a8110`

Текущая runtime matrix не скачивала binary во время model turn и не запускала
`sqz init`: она использовала pre-staged официальный `sqz.exe` через реальный
`aifhub.contextDedup.mode: sqz`. Adapter относится только к историческому
authored/engine benchmark и использовал fixture-local SQLite store. Сетевой
download и install из сценариев запрещены.

Обычный CLI smoke проверил `sqz compress`, exact-reference и `sqz expand`. Delta classification в matrix наблюдалась через adapter на публичном `sqz-engine` API; это не утверждение, что каждый обычный CLI-вызов обязательно возвращает delta.

## State И Session Risk

По умолчанию cache хранится в user-owned `~/.sqz/sessions.db` и сохраняется
между процессами и model sessions. Поэтому свежая model session может получить
`§ref`, не имея исходного текста в своём context. Исторический runtime `r3`
пытался перенаправить home/cache только через environment, но Windows build
v1.3.0 вычисляет home через platform API: `fresh-session-preseeded-cache`
получил dangling reference и упал.

`sqz init` меняет project/agent integration, а `--global` расширяет scope до user-level. AIFHub не должен автоматически запускать `init`, регистрировать hooks/MCP, писать agent config, скачивать binary или очищать user-owned cache.

## Protected Artifacts

У `sqz` нет AIFHub policy для `openspec/specs/**`, `openspec/changes/**`, QA и generated-rules artifacts. Он может compressed/deduplicated-выдать их так же, как обычный текст. Это увеличивает savings, но не соответствует AIFHub boundary: canonical и gate-bearing artifacts всегда должны отдаваться полностью собственным сервисом.

## Решение

`sqz` остаётся optional user-owned provider, а не bundled dependency или default. AIFHub config может выбрать его через `aifhub.contextDedup.mode: sqz`, но binary устанавливает или предоставляет пользователь после явного предупреждения. Применение допустимо только с:

- explicit user opt-in;
- isolated/project-owned store или явно управляемым user-owned store;
- защитой от cross-session dangling references;
- отдельным full-read path для canonical/protected artifacts;
- понятным reset/purge lifecycle.

Runtime integration не запускает `sqz init`. Она вызывает fixed
`sqz compress --no-cache` без shell, поэтому SQZ не может вернуть cache
reference; exact same-session repeat обслуживает AIFHub ledger. Неожиданный
`§ref`/`§delta`, отсутствующий executable, non-zero exit, timeout/output limit
или отсутствие положительной model-visible экономии приводят к fail-open с
исходным content. Сторонний CLI всё ещё может вести user-owned statistics под
`~/.sqz`; AIFHub не заявляет ownership и не очищает их.

Текущий безопасный результат matrix — `4/4`; исторический `r3` с provider
cache сохранён как `3/4` regression evidence.
