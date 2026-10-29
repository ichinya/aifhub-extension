# Восстановление доставки

Delivery helper (#232) доставляет уже сохранённый execution result. AI-аудит и `evaluateQaBinding` в repair отсутствуют. Доставка FAIL/WARN остаётся фактом транспорта: `delivery_verified:true` не означает PASS, acceptance, ACK release или право завершить run. Все ответы содержат `authorizes:[]`.

Через существующий `aifhub-execution` доступны actions `delivery-reserve`, `delivery-prepare`, `delivery-inspect`, `delivery-send`, `delivery-recover`. JSON передаётся на stdin, report content не передаётся аргументами процесса. Новых slash-команд нет.

## Последовательность

1. Начать execution run и вызвать `delivery-reserve` **до QA snapshot** с `change_id`, `run_id`, `target:{kind:"message"|"completion",locator}`. Для batch нужен `task_id`. Необязательный `request_uuid` позволяет повторить reserve; иначе возвращается новый UUID.
2. Сохранить report как evidence и зарегистрировать execution result обычным owner. Evidence, включённый в execution context, должен существовать до admission соответствующего run: delivery не обходит freshness.
3. Вызвать `delivery-prepare` с change/run/request UUID, `gate` и `body` либо `body_file:{path,sha256,byte_length,encoding:"utf-8"}`. Body обязан совпадать с проверенным persisted result evidence. Binding, gate digest и evidence hashes копируются из проверенного результата, не из caller assertions.
4. Передать trusted `HostClient` через библиотечные options и вызвать `delivery-send`/`delivery-recover`. CLI без подключённого HostClient возвращает `provide-capabilities`, не отправляя запрос.

Стабильные пути:

```text
.ai-factory/state/<id>/execution/requests/<uuid>.json
.ai-factory/state/<id>/execution/request-bodies/<uuid>.utf8
.ai-factory/state/<id>/execution/delivery-journals/<uuid>.json
.ai-factory/state/<id>/delivery/<uuid>.json
```

Registry и journal используют checksummed envelope. Delivery record плоский; только `retry_count`, `ack`, `query_state`, `updated_at` меняются после reserve. Host IDs/body digest живут в registry. Поддельные `received`/`ack` не подтверждают доставку. Новый record после QA snapshot, новая ignored membership, изменение identity или declared input остаются материальными.

## HostClient и recovery

Библиотечный контракт: `capabilities()`, `createRequest({request_uuid,identity,binding,target,body,body_file,transport,serialized_input})`, `readRequest({request_uuid,namespace_digest})`, `fetchResponse({request_uuid,namespace_digest})`. Body — исходный Buffer; `serialized_input` — готовый bounded Buffer для stdin. Production adapter и capability discovery конкретного провайдера в эту поставку не входят.

Минимальные capabilities: `idempotent_create:true`, `read_by_request_id:true`, `fetch_response:true`, `target_kinds`, `transport:{utf8_stdin,utf8_file}`, `idempotency:{scope_digest,continuity_token,retention_until,conflicting_payload:"reject"}`. Retention задаётся будущим timestamp либо `"durable"`. Эти declarations должны подтверждаться adapter semantics. Отсутствие любой гарантии предотвращает create.

Read возвращает `state:not_found|pending|completed|conflict`. Для существующего request обязательны исходные `identity`, `binding`, `target`, namespace/continuity и nullable `message_id`/`completion_id`. Completed содержит ID соответствующего target. `fetchResponse` возвращает `{body:Buffer}` либо unavailable. Not-found содержит namespace/continuity и `deduplication_retained`.

| Наблюдение | Recovery |
|---|---|
| Timeout + not_found | `reconcile-host-state`, delivery не подтверждена |
| Commit с потерянным ответом | Read UUID → fetch существующих bytes → strict gate/digest verification |
| Pending | `wait-request`, один read за вызов, без create/polling loop |
| Completed без body | `fetch-response`, query_state unknown |
| Потеря continuity/retention | `reconcile-host-state`, resend запрещён |
| Payload/target/binding/namespace/mapping conflict | Постоянный blocked, `resolve-identity-conflict` |

При доказанной deduplication uncertain может вернуть `retry_create_allowed:true` и `resend_preconditions`. Следующий recover принимает `recovery_action:{type:"resend-same-request",request_uuid,preconditions:<точные возвращённые значения>}`. Он снова читает host и проверяет предусловия; новый UUID или новые bytes не используются. Read/poll не считается create. Число create calls может расти, число committed objects исходной операции остаётся одним.

Остальные recovery types: `provide-capabilities`, `read-request`. Uncertain содержит code/query_state/host_state/delivery_verified/reservation_retained/retry_create_allowed/recovery_action/authorizes. Reservation сохраняется через отсутствие lifecycle transitions. Interrupted/closed допускают только bounded historical inspect, `historical:true`; send/resend/closure запрещены.

## Транспорт, ограничения и evidence

Общий `no-shell-process.mjs` использует `shell:false` и Buffer stdout/stderr. Только `.cmd/.bat` используют явный ComSpec с `/v:off`; report передаётся через stdin/file, не command line. `deliveryTransportInput` учитывает весь сериализованный input, включая JSON escaping. Максимум stdin — 1 MiB; body safe store — 16 MiB. File descriptor проверяется через safe store, strict UTF-8, byte length и SHA-256. BOM, CRLF, combining characters и trailing newline не нормализуются. Неподдерживаемый Windows control token/path отклоняется до запуска.

Timeout, EPIPE и stdout overflow требуют host reconciliation. Journal сохраняет intent до mutation и позволяет repair после прерывания helper. Порядок locks — project → source; ограничение одного host вызова по умолчанию 5 секунд, максимум 300 секунд. Polling под lock отсутствует. История ограничена 256 revisions, registry — 200 requests на change; переполнение блокирует продолжение без молчаливого pruning. Power-loss durability отдельно не квалифицирована.

Ответ содержит snapshot `aifhub.runner_metrics.v1.transport`: create/read/fetch calls, retry_creates, recovery_attempts, verified_recoveries, uncertain_returns, identity_conflicts, transport_ms, recovery_ms, wait_ms, incomplete_intervals. Это per-request snapshot; повторная публикация не складывает его повторно. `wait_ms` равен нулю: helper сам не ждёт pending requests. Незавершённый interval учитывается без выдуманной duration; local attempts не означают remote committed count. `verified_success`, model/billing данные автоматически не устанавливаются. Несколько UUID агрегирует владелец collector #230 с дедупликацией по UUID/revision.

Offline coverage: fake-host моделирует request index, commits, durable tombstones, response store и epoch отдельно. Проверяются четыре recovery paths, no-duplicate, capability admission, failpoints, byte identity, forged-delivery/QA receipts, freshness и historical lifecycle. Native Git и Windows `.cmd` contracts требуют окружение с доступными child processes. Live-host совместимость и измеренная экономия — NOTRUN; grouped settlement/ACK release принадлежат #231.
