# Служебный lifecycle (#231)

`ai-factory aifhub-execution lifecycle-<action> --json` принимает один JSON на stdin и возвращает один bounded шаг. Host adapter необязателен: библиотечный `executionCommand(action,input,{HostClient})`. CLI не принимает executable/module path из JSON. Production command-backed adapter отложен. Все ответы содержат `authorizes:[]`, `capability_limitations`, `manual_path:{wait,release}` и отдельный `service_calls`. CLI различает исходы по опубликованному контракту 0/1/2: отказ lifecycle (blocked/conflict) — exit 1, невалидный вызов — exit 2, успех — 0; результат отказа несёт флаг `blocked`. Заблокированный ответ несёт консервативный `reservation_retained:true`, даже если scans не успели подтвердить отсутствие резерваций. Счётчики не расширяют закрытый `runner_metrics`; агрегатор относится к #230.

## Действия

| Action | Вход сверх change_id | Результат |
|---|---|---|
| lifecycle-collect | members:[{run_id} или {request_uuid}] либо include_all:true; optional read_host:true | Compact local run/delivery state, pending transactions, typed next_action |
| lifecycle-settle | run_id, actor, decision:{actor,outcome,decided_at}; optional deliveries:{task_id:request_uuid} | Отдельный checksummed settlement с exact manifest/seal/closure/source/context/worktree/results/evidence/accepted binding |
| lifecycle-release | run_id, actor, request_uuid | Durable release intent и optional request.release после fresh host verification |
| lifecycle-progress | run_id, actor | Canonical progress строго по accepted set закрытого run |
| lifecycle-finalize | actor, spec (готовый текст spec.md) | Journaled classic archive, index, status done; OpenSpec delegated handoff |

Пример локального шага:

```json
{"change_id":"example","members":[{"run_id":"run-1"}],"read_host":false}
```

## Фазы и waits

Observe/Collect читают состояния. Produce остаётся у existing result/batch-result transitions. Parent явно Record/Settle решение `settled|partial|rejected`; helper его не выводит из тестов. ACK/release и Progress/finalize имеют отдельные recovery boundaries.

Collect ограничен одним change и 24 members, одним pendingTransactions и history scan, максимум одним readRequest на unverified delivery member (код читает любой не-verified phase, не только pending). Каждый closed member проходит полную freshness (git/worktree) — до 24 глубоких сканов внутри read-only вызова; стоимость в отдельных counters не выделяется. Host read выполняется только при read_host:true. Completed observation предлагает delivery-recover/fetch-response: collect не делает fetch, verification или create. Worker done не доказывает stop. Batch transitions и reservations читаются локально. Typed waits сохраняют RECOVERY_ACTION_TYPES, включая wait-request, read-request, fetch-response и reconcile-host-state. `include_all` без явного `members` возвращает `lifecycle-group-limit`, когда суммарно runs+requests больше 24; пагинации нет — workaround: перечислить members явно. Не-UUID имена в реестре запросов деградируют поэлементно: вызов помечается uncertain, валидные members остаются в ответе.

next_action.type — closed enum: lifecycle-collect, batch-accept, batch-close, delivery-recover, lifecycle-settle, lifecycle-release, lifecycle-progress, lifecycle-finalize, interrupt, stop-confirm, manual. Это suggestion, никогда не исполняется неявно.

`driveLifecycle(input,{maxSteps,wait,HostClient})` — opt-in driver вне model loop: максимум 24 collect шага, callback cadence/event между шагами вне execution lock. Он возвращается на blocker/uncertain, budget либо необходимости другого действия. При completed delivery возвращается к delivery owner, при parent decision — к parent. Long polling/subscriptions и sleep под execution lock отсутствуют.

## Custody и восстановление

Settlement/progress требуют owner закрытого non-legacy v2 run; freshness повторяет resume: current source/context/revision/scope/preflight, exact checkpoint, freshSeal/freshResult и evidence. Settlement в execution/settlements/<run_id>.json не меняет run/receipts. Referenced requests должны быть verified с exact slot/result/evidence binding. Другой decision блокируется conflicting-settlement, exact replay historical.

Settlement хранит решение по конкретному run. Release хранит наблюдённый результат по исходному request UUID. Их исторические повторы сохраняют свои проверки и не препятствуют допуску нового запуска.

### Допуск и повтор `progress` и `finalize`

Под `execution-write.lock` действия `start`, `batch-start` и локальный `isolation-start` сравнивают оставшиеся записи prepared `progress` и classic `finalize` с источниками, контекстом и Git-снимком нового запуска. Значимы общие `paths.specs`, видимые Git-файлы за пределами scope и явные `context_paths`. Обновление непинованных полей projected `status.yaml` пропускается. Свежая lifecycle-публикация под тем же lock сверяет входы и целевые пути с уже подготовленными журналами.

| Сценарий AC5 | Результат |
| --- | --- |
| Оставшаяся запись затрагивает вход нового запуска или общей публикации | `pending-lifecycle-publication` до сохранения нового run, reservation или journal |
| Точный повтор уже подготовленной execution-транзакции | Применяется ранее сохранённое решение допуска. Lifecycle-повтор затем сверяет возникший reservation |
| Активный run того же change, pending execution либо пересекающийся run или integration group | `lifecycle-not-quiescent`. Остаток публикации и journal сохраняются |
| Частичная запись и совпадение исходных входов | В проверке уже записанные `after` заменяются своими `before`. Helper записывает только оставшиеся файлы и сохраняет `applied` |
| Независимый дрейф source, context, worktree, evidence либо недоказуемая привязка | `lifecycle-source-conflict`. Helper сохраняет journal и целевые файлы |
| Третья image для целевого файла | `lifecycle-file-conflict` до оставшихся записей |
| Все целевые bytes уже равны `after` | После точной привязки, guards и действующих проверок quiescence helper сохраняет только `applied` |

При подготовке журнал сохраняет digests исходных inputs и ревизии локальных runs. Сверка позднего завершённого run учитывает его source, context, worktree и evidence. Неизменившаяся история до подготовки журнала не требует повторной проверки. Время создания и mtime не определяют порядок операций.

При отказе владелец сохраняет journal и сверяет исходный запрос и конфликтующий вход. После закрытия пересекающегося запуска либо подтверждённого устранения конфликта владелец повторяет точный исходный запрос. Если совместимость старой частичной записи доказать нельзя, восстановление остаётся у владельца. Старые progress-журналы могут опираться на исходный closed run, если его привязку удаётся подтвердить. Старый finalize без привязки исходного снимка допускает точное завершение, когда все `after` уже на месте и guards проходят.

Совместимый helper читает v1-журналы с блоком `recovery` и без него. Предыдущий валидатор с закрытой схемой может отвергнуть `recovery` даже в журнале `applied`. Для чтения такой истории после отката нужен совместимый helper. Храните исходные журналы при смене версии. Все helpers, которые записывают в один checkout, должны поддерживать новый контракт.

Progress не принимает caller task set. run.closure.accepted либо accepted single — единственный set. Canonical parser исключает examples/frontmatter/fences/comments. Меняются только unchecked строки; classic parent/task.md остаются равными по canonical tasks. Это первая checklist-запись helper вне state. После progress исходный run намеренно stale: повторный collect по этому change вернёт blocked со stale-кодом вместо готовности — ожидаемое поведение, а не дефект. Порядок службы: collect → settle → progress; после применённого progress статус уточняется exact replay progress (historical), а не повторным collect.

Release требует phase verified, fresh completed host read с identity/binding/target/namespace/continuity/host IDs и release_after_verify:true + releaseRequest({request_uuid,namespace_digest}). Adapter обязан идемпотентно deduplicate release по исходному UUID. Intent persist-before-host; потерянный response повторяется с тем же UUID, host read и dedupe. Уже записанное request.release даёт replay без host calls. ack по-прежнему означает verified delivery. Release не трогает reservation, не выполняет stop и не доказывает PASS. Unknown/regression блокирует release. Реестр обязан иметь history headroom до host mutation — полный реестр даёт `delivery-history-full` до эффекта. Отсутствующий или shape-невалидный host observation классифицируется `delivery-observation-unavailable` (recovery read-request), а не identity-conflict. Под lock выполняется до трёх bounded host-вызовов (capabilities, readRequest, releaseRequest): worst-case ~3×`hostTimeoutMs` — по умолчанию 5000 мс, то есть до ~15 с на цепочку; максимум 300000 мс. Параллельная сессия получает немедленный fail-fast `state-locked`; orphan lock автоматически не отбирается. Контракт для будущего production-адаптера (#266): observation запроса обязана оставаться durable после host-эффекта — tombstone либо read-after-release; иначе recovery release при удалённом из read-индекса request вернёт `not_found` при уже произошедшем host-эффекте.

Без adapter collect работает локально, settle — по уже verified custody, progress/finalize — локально. Host-dependent read/release возвращает lifecycle-capabilities-required с manual_path без host mutation. Manual wait: delivery-inspect per member / host UI; manual release: host-native release/stop controls.

Settlement/progress/finalization journals содержат checksums, input CAS и exact before/after sha256/images. Journal сохраняется до mutation. Sequential per-file apply принимает только before или after; третья image блокирует вызов до дальнейших записей. Exact retry до-применяет interrupted publication и возвращает historical. Это несколько bounded publications, а не одна filesystem transaction. Lock порядок: execution-write.lock → change/write.lock; orphan автоматически не отбирается. Повреждённый journal (invalid envelope либо checksum) fail-closed с `invalid-state` без инструкций; publication ограничивает пик построения images числом файлов и байтовым бюджетом заранее. Отсутствующий journal — отдельный случай: settle и progress защищены conflicting-settlement и stale-freshness, но потеря applied finalization-journal возвращает finalizer на fresh-путь — повторная публикация archive другим spec остаётся возможной и гейтится только owner-гейтом `/aif-done` (известное ограничение); recovery после потери journal требует ручного вмешательства владельца.

Classic finalizer остаётся механическим publisher'ом поверх verdict-гейта: он читает только `verification.verdict` ∈ {pass, pass-with-notes} из status.yaml. Required verify/review/rules/security, независимые роли, provider readiness и dirty-state admission проверяет owner (`/aif-done`) — helper их не дублирует; `authority:'/aif-done'` в ответе сам по себе эту границу не переносит. Требует quiescence и все tasks checked. Копирует plan folder без status.yaml и companion как plan.md, пишет caller spec.md/index и status done/finalized_at с сохранением plan_id/source binding. Destination-guards: пересечение specs с plan-папкой сравнивается case-insensitively (существенно на Windows, детерминированно на ubuntu), а destination не может совпадать или вложаться в canonical и evidence roots — configured overrides `paths.qa`/`paths.rules`/`paths.generated_rules`, их дефолты (`.ai-factory/qa`, `.ai-factory/rules`, `.ai-factory/rules/generated`), configured authoritative inputs `paths.description`/`paths.architecture`/`paths.rules_file` и `.ai-factory/evidence`; безопасный кастомный путь продолжает работать. Index-грамматика валидируется структурно до записей: quoted/непризнанные top-level ключи, записи без `- id:` первым ключом, вложенные continuation внутри specs-списка и flow/nested verification дают `unsupported-spec-index`; план-папка с `plan.md`/`spec.md` даёт `conflicting-archive-entry`. Уважает configured plans/specs. Recovery проверяет состав plan folder и сохранённый контекст перед оставшимися записями. Добавление файла после подготовки означает дрейф входов. Журнал финализации неизменяем с постоянным ID `finalize`: refresh существующего archive остаётся за owner (`/aif-done`); helper второго поколения не создаёт. OpenSpec получает delegated handoff. `/aif-done` остаётся authority; verify/review/rules/security и governance follow-ups сохраняются. Commit/push/deploy, semantic summaries и verdict generation отсутствуют.

## Pilot и provenance

Канонические пары: single wait+settle; batch 2–5 seal/results/accept/close/progress/finalize; k pending deliveries × m rounds; interrupt/stop-confirm/re-dispatch. Начальные inputs и fake-host сценарии одинаковы, common producer/parent transitions не считаются экономией. Публикуются два baseline: per-item (inspect/delivery-inspect и resume на каждый item) и group-boundary (одно наблюдение на batch); требование ≥2x относится к per-item baseline, group-boundary ratio публикуется как честная нижняя граница. Candidate выполняет grouped шаги. Единица — выполненный helper call как offline proxy model-issued service call. Host read trace сравнивается отдельно: grouping сокращает вызовы координатора, а не необходимые host reads.

Offline-тест `scripts/host-lifecycle.test.mjs` выводит счётчики в диагностике. Цель ≥2× относится к его поэлементному baseline. Для пилота #266 служебные вызовы измерены отдельно по трассам координатора и хоста.

### Изолированный пилот #266

22 ноября 2026 года координатор BB Codex повторно провёл шесть пар на Windows с Node 24.13.0 и `startIsolatedDeliveryHost()`. Внутри каждой пары исходная ревизия тестового проекта, входы и критерии приёмки совпадали. Для каждой ветки использовали отдельный checkout и отдельное пространство имён хоста. Пилот измерял служебные вызовы и IPC хоста в заранее зафиксированных интервалах.

| Сценарий | `service_calls` baseline / candidate | `host_reads` baseline / candidate | `host_releases` baseline / candidate | Отношение вызовов |
| --- | ---: | ---: | ---: | ---: |
| Single wait + settle | 6 / 6 | 3 / 3 | 0 / 0 | 1,00× |
| Batch 2, seal → finalize | 17 / 14 | 0 / 0 | 0 / 0 | 1,21× |
| Batch 5, seal → finalize | 29 / 20 | 0 / 0 | 0 / 0 | 1,45× |
| 2 pending × 3 раунда | 12 / 3 | 6 / 6 | 0 / 0 | 4,00× |
| 5 pending × 3 раунда | 30 / 3 | 15 / 15 | 0 / 0 | 10,00× |
| Interrupt → stop-confirm → re-dispatch | 5 / 4 | 1 / 1 | 0 / 0 | 1,25× |

- В single обе ветки сохранили исходные байты после явного recovery и зафиксировали одинаковое решение владельца. При опросе число чтений хоста сохранилось.
- В batch baseline наблюдал каждого участника отдельными `inspect` и `resume`. После закрытия пакета обе ветки сверили принятые задачи, обновили чекбоксы и прошли `verify`, `review`, `rules` и `security` на одном снимке в пределах ветки. Артефакты каждого gate привязаны к `run_id` и хешу снимка до публикации. Принятые задачи, чекбоксы и файлы classic-архивов совпали.
- В interrupt дочерний процесс выполнил назначение и передал результат, который координатор сверил с сохранённым `result_digest`. Координатор наблюдал выход того же `ChildProcess` и связал PID, назначение и `run_id` в свидетельстве для `stop-confirm`. Обе ветки удерживали резерв до подтверждения и затем допустили новый run. Полные IPC-трассы зафиксировали ноль попыток release во всех окнах измерения.
- 24 снимка #230 сохранены до очистки стендов в `.ai-factory/state/266-live-host-lifecycle-pilot/pilot/pilot-fix-266-mwrireai/corrected/`. Снимки содержат `run_id`, `outcome` и `notes` в соответствующих записях и квитанциях коллектора. Независимый пересчёт воспроизвёл таблицу. Закрытая схема `aifhub.runner_metrics.v1` сохранилась вместе с метками неизвестных значений, в том числе токенов и стоимости. Коллектор в изолированном checkout сообщил версию `unknown`. Исходник коллектора сверяли по SHA-256.

Scripts/host-lifecycle.mjs и scripts/host-lifecycle-store.mjs включены в HELPER_MODULES и provenance-манифест с release 1.8.2 (закрытие отложенного включения #231 — решение «при следующем release»; пин-тест AC6 перевёрнут на присутствие). RUN_SCHEMA, receipt enum, batchReceipts, validateTransaction whitelist и contracts не расширяются.
