# Служебный lifecycle (#231)

`ai-factory aifhub-execution lifecycle-<action> --json` принимает один JSON на stdin и возвращает один bounded шаг. Host adapter необязателен: библиотечный `executionCommand(action,input,{HostClient})`. CLI не принимает executable/module path из JSON. Production command-backed adapter отложен. Все ответы содержат `authorizes:[]`, `capability_limitations`, `manual_path:{wait,release}` и отдельный `service_calls`. Счётчики не расширяют закрытый `runner_metrics`; агрегатор относится к #230.

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

Collect ограничен одним change и 24 members, одним pendingTransactions и history scan, максимум одним readRequest на pending member. Host read выполняется только при read_host:true. Completed observation предлагает delivery-recover/fetch-response: collect не делает fetch, verification или create. Worker done не доказывает stop. Batch transitions и reservations читаются локально. Typed waits сохраняют RECOVERY_ACTION_TYPES, включая wait-request, read-request, fetch-response и reconcile-host-state.

next_action.type — closed enum: lifecycle-collect, batch-accept, batch-close, delivery-recover, lifecycle-settle, lifecycle-release, lifecycle-progress, lifecycle-finalize, interrupt, stop-confirm, manual. Это suggestion, никогда не исполняется неявно.

`driveLifecycle(input,{maxSteps,wait,HostClient})` — opt-in driver вне model loop: максимум 24 collect шага, callback cadence/event между шагами вне execution lock. Он возвращается на blocker/uncertain, budget либо необходимости другого действия. При completed delivery возвращается к delivery owner, при parent decision — к parent. Long polling/subscriptions и sleep под execution lock отсутствуют.

## Custody и восстановление

Settlement/progress требуют owner закрытого non-legacy v2 run; freshness повторяет resume: current source/context/revision/scope/preflight, exact checkpoint, freshSeal/freshResult и evidence. Settlement в execution/settlements/<run_id>.json не меняет run/receipts. Referenced requests должны быть verified с exact slot/result/evidence binding. Другой decision блокируется conflicting-settlement, exact replay historical.

Progress не принимает caller task set. run.closure.accepted либо accepted single — единственный set. Canonical parser исключает examples/frontmatter/fences/comments. Меняются только unchecked строки; classic parent/task.md остаются равными по canonical tasks. Это первая checklist-запись helper вне state. После progress исходный run намеренно stale; exact replay читает журнал и не обновляет authority.

Release требует phase verified, fresh completed host read с identity/binding/target/namespace/continuity/host IDs и release_after_verify:true + releaseRequest({request_uuid,namespace_digest}). Adapter обязан идемпотентно deduplicate release по исходному UUID. Intent persist-before-host; потерянный response повторяется с тем же UUID, host read и dedupe. Уже записанное request.release даёт replay без host calls. ack по-прежнему означает verified delivery. Release не трогает reservation, не выполняет stop и не доказывает PASS. Unknown/regression блокирует release.

Без adapter collect работает локально, settle — по уже verified custody, progress/finalize — локально. Host-dependent read/release возвращает lifecycle-capabilities-required с manual_path без host mutation. Manual wait: delivery-inspect per member / host UI; manual release: host-native release/stop controls.

Settlement/progress/finalization journals содержат checksums, input CAS и exact before/after sha256/images. Journal сохраняется до mutation. Sequential per-file apply принимает только before или after; третья image блокирует вызов до дальнейших записей. Exact retry до-применяет interrupted publication и возвращает historical. Это несколько bounded publications, а не одна filesystem transaction. Lock порядок: execution-write.lock → change/write.lock; orphan автоматически не отбирается.

Classic finalizer читает verdict pass/pass-with-notes, требует quiescence и все tasks checked. Копирует plan folder без status.yaml и companion как plan.md, пишет caller spec.md/index и status done/finalized_at с сохранением plan_id/source binding. Уважает configured plans/specs. `/aif-done` остаётся authority; verify/review/rules/security и governance follow-ups сохраняются. Commit/push/deploy, semantic summaries и verdict generation отсутствуют.

## Pilot и provenance

Канонические пары: single wait+settle; batch 2–5 seal/results/accept/close/progress/finalize; k pending deliveries × m rounds; interrupt/stop-confirm/re-dispatch. Начальные inputs и fake-host сценарии одинаковы, common producer/parent transitions не считаются экономией. Baseline реально выполняет per-member inspect/delivery-inspect и manual publication steps; candidate выполняет grouped шаги. Единица — выполненный helper call как offline proxy model-issued service call. Host read trace сравнивается отдельно: grouping сокращает вызовы координатора, а не необходимые host reads.

Тест scripts/host-lifecycle.test.mjs выводит counters в diagnostic output. Цель ≥2x относится к служебным fixtures; live model service calls, inference, payment и production host не запускались: **NOTRUN**. Live-пилот требует отдельной парной трассы реального координатора и агрегатора #230; offline ratio не является live acceptance.

Новые scripts/host-lifecycle.mjs и scripts/host-lifecycle-store.mjs намеренно **не добавлены в HELPER_MODULES** в этом change; provenance inclusion/regeneration отложены до следующего release. RUN_SCHEMA, receipt enum, batchReceipts, validateTransaction whitelist и contracts не расширяются.
