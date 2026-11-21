# Квалификация изолированного HostClient

Проверка выполняет одну пару доставки `completion`. Координатор проходит через существующий `executionCommand(..., { HostClient })`, а отдельные Node-процессы хранят запросы и пишут собственные трассы. Для запуска нужны Node.js и Git.

## Запуск

Из корня репозитория:

```powershell
node scripts/isolated-delivery-pilot.mjs
node --test --test-reporter=tap scripts/isolated-delivery-pilot.test.mjs
node --test --test-reporter=tap scripts/host-lifecycle.test.mjs
node --test --test-reporter=tap scripts/host-delivery-native.test.mjs
```

Первая команда сохраняет JSON в `.ai-factory/state/add-isolated-host-client/pilot/` и выводит его путь вместе с исходом. `QUALIFIED` означает, что обе ветки дошли до сохранённой фазы `verified`, а независимые трассы можно сопоставить. При `INCOMPLETE` команда возвращает exit 1 и указывает причину. `LOG_LEVEL=debug` включает структурированные сообщения операций в stderr. Трассы содержат только идентификаторы, исходы, хеши и порядковые номера.

## Сверка пары

1. Сверить раздельные `run_id`, `request_uuid`, `namespace_digest` и `completion_id` у `baseline` и `candidate`, единый `body_sha256` у обеих веток и равный ему `delivered_body_sha256` после recovery.
2. Проверить `phase_before_recovery=pending`, `phase_after_recovery=verified` и `host_exit.code=0`. В `services` у candidate первое наблюдение возвращает `wait-request`, второе — `delivery-recover` с `fetch-response`.
3. В каждой ветке посчитать внешние вызовы из `services`. Окно начинается после подготовительного `delivery-send` с `pending` и заканчивается после записи `verified`. Строки `clientCalls` и `hostTrace` внутри окна сверяются по `call_id`, операции и UUID. Подсчитать `readRequest` и `fetchResponse` отдельно. Для нулевого `host_releases` требуется полное наблюдение активности в окне.
4. Сверить `proof` сохранённой исходной записи и `verified_proof` после recovery. Хеши `identity_sha256`, `binding_sha256`, `target_sha256` и `continuity_sha256` должны совпадать с наблюдениями хоста и IPC-ответами на чтение и завершение. Начать сверку с чтения `pending` на границе окна. Для fetch хост фиксирует привязку, а клиент хеширует фактически полученные байты. Исходные поля привязки, токен continuity и тело в трассы не записываются.
5. При пропуске трассы или несовпадении хеша результат будет `INCOMPLETE`, а недоступные счётчики получат `UNKNOWN`. Для воспроизводимости использовать версию Node и `sourceHashes` из JSON.

Точка подключения — `startIsolatedDeliveryHost()` в `scripts/fixtures/isolated-delivery-host-client.mjs`. Каждый вызов создаёт собственный экземпляр процесса и временный каталог. Доступны `capabilities`, `createRequest`, `readRequest` и `fetchResponse` для `completion`. Освобождение ресурсов происходит после наблюдаемого выхода дочернего процесса. Если подготовка Git-проекта не дошла до запуска хоста, драйвер сразу удаляет созданный каталог.

Для #266 владелец использует JSON пары и эту точку подключения при выборе стенда. Ручной путь публикации batch 2 и 5 и матрица шести пар проверяются в отдельном change `266-live-host-lifecycle-pilot`.
