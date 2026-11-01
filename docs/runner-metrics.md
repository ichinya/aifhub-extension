[Back to Documentation](README.md)

# Runner metrics collector (#230, этап 1)

Read-only CLI-агрегатор `scripts/runner-metrics-collector.mjs`: собирает per-request
delivery snapshots (`aifhub.runner_metrics.v1.transport`), execution run-записи и
opt-in QA-результаты в один файл `aifhub.runner_metrics.v1`, который подаётся в
существующий `exchange evaluation --runner-metrics`
([workflow exchange](workflow-exchange.md)). Второго metrics-протокола, нового export
endpoint и нового schema ID нет: команда, аргументы и schema IDs экспорта не меняются.

```bash
node scripts/runner-metrics-collector.mjs --change <id> [--run <run_id>] [--include-qa] [--output <project-relative-path>] [--json]
```

- Exit codes: `0` collected, `1` degraded (файл записан, каждая потеря
  перечислена в `notes`), `2` failed/invalid arguments.
- Envelope: `{ok, outcome: 'collected'|'degraded'|'failed', written, notes:[{code}], errors:[{code}]}`.
- `--change` валидируется как execution id, `--run` как identifier, `--output` как
  portable path (backslash, `:` и абсолютные пути отвергаются). Unknown flags →
  `invalid_arguments`, exit 2, output-файл не создаётся.
- `--run` сужает выборку по `slot.run_id`; авто-выбора «последнего» run нет.
  Несуществующий `--run` даёт пустую collected-выборку с note `run_filter_empty`.
  Без `--run` top-level `run_id` публикуется только при единственном run,
  иначе `null` и `attribution.runs = N`.
- `--include-qa` — opt-in: без него `checks = null` и `unknowns` содержит `checks`
  (не измерялось). Отсутствующий QA-каталог при включённом opt-in даёт
  `checks.results = 0` — измеренный ноль в рамках declared coverage. Отказ чтения
  QA-хранилища (all-or-nothing reader) даёт `checks = null`, note
  `qa_results_unreadable`, outcome `degraded`.
- Дефолтный output: `.ai-factory/state/<change>/runner-metrics.json`. Запись —
  только через safe provider writer (atomic tmp+rename, идемпотентная перезапись
  без timestamps: повторный прогон на неизменных данных не меняет байты файла).

## Граница невмешательства

Collector не меняет execution/QA/delivery state: только read-примитивы
(`loadRequest`, read-методы store, run-записи, `qaStore().results()`); `lock()`,
delivery-команды с host-вызовами, reserve/recover/release и повторный
`evaluateQaBinding` запрещены. Единственная запись — явно назначенный
observational output-файл. Путь `--output` валидируется: проект-относительный,
внутри root, в целиком gitignored-области `.ai-factory/state/**` (внутри
git-репозитория фактический ignored-статус проверяется `git check-ignore`,
не только префиксом), вне control-namespace ЛЮБОГО change — `state/<seg>/execution/**`,
`state/<seg>/delivery/**`, `state/<seg>/status.json` (wildcard, прецедент
`assertAuxiliaryPaths`; file-namespace держат prefix-семантику — вложенность
под `status.json` тоже отвергается), вне `state/exchange/**` (HMAC-salt exchange
fingerprint-ов), вне теней над корневыми файлами state (`execution-write.lock`,
`current.yaml`) и — общий барьер — вне вложенности под ЛЮБОЙ существующий
файл-предок (lstat-проверка: output не может материализовать каталог-тень
поверх контрольного файла), вне configured QA root (default `.ai-factory/qa`;
`paths.qa` из `.ai-factory/config.yaml`, небезопасное значение откатывается к
дефолту) и declared QA input roots, вне tracked-путей — иначе
`runner_metrics_output_rejected` до первой записи. Лист назначения — часть
границы: единственное допустимое уже существующее содержимое — прежний
runner-metrics output (файл с `schema: aifhub.runner_metrics.v1`); review/tracer
receipts, plan-compliance и любые чужие файлы не перезаписываются никогда.
Запись возможна только в каталоге собственного change
(`state/<changeId>/**` минус его control-namespace) — чужие runtime-каталоги
отвергаются целиком, включая создание новых файлов. Guard fail-closed: если безопасность назначения не может быть проверена
(enroll-ленный QA без читаемого manifest-указателя — включая состояние после
сбоя публикации, когда `enrollment.json` уже записан, а `manifest.json` ещё
нет; ошибка git внутри репозитория — EPERM, dubious ownership, повреждённый
`.git`-каталог или gitfile; negated gitignore правило), запись отвергается, а
не разрешается по умолчанию. Git вызывается с очищенным окружением
(`GIT_DIR`/`GIT_WORK_TREE`/`GIT_INDEX_FILE`/`GIT_COMMON_DIR`/
`GIT_CONFIG_PARAMETERS` удаляются — отравленный env не может заставить git
отрицать реальный репозиторий), а вердикт «not a git repository» засчитывается
только при отсутствии `.git`-входа в корне (сообщение locale-зависимо, вход —
нет); `.git` есть, а git его не читает — fail-closed. Только в этом честном
случае tracked/ignore-проверки недостижимы. Ограничение: change с id `exchange`
не может собирать output (его каталог зарезервирован под salt-namespace).
Агрегат проходит финальную self-проверку тем же runtime-контрактом, что и
export-гейт: сумма safe-integer счётчиков, превысившая `MAX_SAFE_INTEGER`,
даёт `runner_metrics_aggregate_unrepresentable` (exit 2) вместо записи
невалидного файла. Метрики никогда не становятся
material input: дефолтный путь не входит ни в declared QA roots, ни в закрытые
metadata-namespace (`<id>/delivery`, `<id>/status.json` любого change), поэтому
существование output-файла не меняет binding fingerprints и snapshot digest-ы,
построенные после его появления (membership в списке gitignored-имён —
единственное наблюдаемое следствие, общее для любого runtime-файла этой области).

## Формулы агрегации

- Top-level `transport` — сумма по каждому ключу `TRANSPORT_KEYS` по включённым
  UUID. При пропущенных членах это lower bounds; маркируется note `member_skipped`.
- `transport.incomplete_intervals` = Σ записанного счётчика + count открытых
  `interval !== null` (прерванный интервал producer ещё не посчитал; state не мутируется).
- `requests.total` — размер union-UUID из `requests/` и `delivery-journals/`
  (валидные и skipped; total не занижен). При `--run` нечитаемые члены остаются
  в выборке как conservative верхняя граница: их slot нечитаем и не может быть
  атрибутирован другому run.
- `requests.incomplete` = count(phase ≠ `verified` ∨ `interval ≠ null`).
- `requests.duplicate_responses` — см. response-дедуп ниже; transport-счётчики
  каждого UUID сохраняются полностью.
- `phases.pending_observed_ms` — dwell фазы `pending` по `history[].at`:
  Σ max(0, at[i+1] − at[i]) по pending-записям + незакрытый хвост
  max(0, updated_at − last.at) (по инварианту producer равен 0). Это наблюдаемое
  ожидание host по уже записанным timestamps — не compute и не человеческий труд.
- `phases.transport_ms` и `phases.recovery_ms` — раздельные **не-аддитивные**
  счётчики: recovery включает transport-вызовы, суммирующего поля и «breakdown»
  нет.

## Две дедупликации

**Snapshot-дедуп.** Один UUID всегда даёт одну resolved-картинку по семантике
`loadRequest`: journal выигрывает при большем revision; равный revision обязан
совпадать содержимо, иначе conflict → member skip (`member_skipped`,
outcome `degraded`). Journal-only члены (crash между journal и registry) входят
в union и валидируются; ничего не материализуется обратно. Несколько revisions
одного UUID никогда не суммируются, независимые максимумы counters не берутся.

**Response-дедуп.** Ключ `(host.namespace_digest, target.kind,
host.message_id|completion_id)`. Один host id у ≥2 UUID даёт
`requests.duplicate_responses += k − 1` (не ошибку) без уменьшения
transport-счётчиков. `verified` считается только по phase `verified`: наличие
host id не доказывает verify (id персистится до fetch). Дедупликация requests
по body digest запрещена: byte identity ≠ уникальность операции.

## Гонка с пишущим helper

Lock не берётся. По scanned member-файлам `requests/` и `delivery-journals/`
выполняется один bounded повторный read digest-ов (inventory всего `execution/`
не читается — он дайджестил бы `request-bodies/`). После content-прохода
directory union пере-листингуется: появившийся в скане request не теряется
(он дочитывается и входит в `requests.total`), исчезнувшая запись листинга и
любое расхождение digest-ов дают note `scan_inconsistent`, outcome `degraded` —
смешанный/неполный срез никогда не молчаливый и не fail. Та же полнота
применяется к `runs/` (run, опубликованный mid-scan, дочитывается и входит в
attribution). Provenance-счётчики `requests_scanned`/`journals_scanned`/
`runs_scanned`/`unreadable`-вклад `members_skipped` отражают финальный
листинг (наблюдаемое конечное состояние реестра), а не сумму двух проходов:
стабильно нечитаемое имя считается один раз, late member входит в scanned
наравне с `requests.total`. Run-записи переписываются на каждом transition,
поэтому каждый отсканированный run-файл получает digest до/после чтения:
обновление записи mid-scan (стабильное имя, новая ревизия) даёт
`scan_inconsistent`, как и изменение листинга; skipped поздней порции входят в
`members_skipped`. Классификация ошибок чтения:
`file-changed`/`unsupported-file`/`delivery-request-missing` →
race-класс (`scan_inconsistent`); `invalid-*`/`delivery-*` (отказ валидации
содержимого) → `member_skipped`.

## Честность unknown и zero

`0` — измеренный ноль в рамках declared `coverage`; `null` + запись в
`unknowns[]` — «нет источника». Подмена одного другим запрещена. В v1
`unknowns` (closed enum) всегда содержит `tokens`, `cost`, `tool_calls`,
`model_requests`, `unlogged_requests`, `coordinator_accounting`, `billing`,
`setup_ms`, `checks_ms`, `snapshot_hash_ms`, `wait_ms`, `run_elapsed`;
`checks` добавляется только когда checks-блок недоступен.

- Delivery registry ≠ все model requests: `coverage` — closed enum
  `delivery_registry | delivery_registry+qa`. `create_calls` не переносится в
  model request counts; transport-счётчики — durable local intent до host-вызова,
  не доказательство remote commit; capabilities/inspect-вызовы в counters не
  входят, поэтому transport — не полный service-call accounting.
- Subset counters `retry_creates ⊂ create_calls` и
  `verified_recoveries ⊂ recovery_attempts` суммируются по UUID независимо;
  `total` из subsets не вычисляется. Из transport не заполняются legacy top-level
  поля `retries`, `latency_ms`, `verified_success`, `cost`, `human_review_ms`.
- Tokens/cost/tool counts публикуются как `null` только при достоверном
  источнике; в v1 источника нет — маркер в `unknowns`.
- `provenance.registry_digest` — digest канонического образа отсортированного
  union `[{request_uuid, record_digest|null}]` (нечитаемые члены дают `null`).
  Никаких заявлений об экономии: сравнение baseline/candidate — поверхность
  benchmarks, не collector.

## Производные durations: record-span, не compute

Измеряемые `setup_ms`, `checks_ms`, `snapshot_hash_ms`, `wait_ms`,
`run_elapsed_ms` публикуются как `null` с маркерами в `unknowns` до этапа 2.
Разрешены только производные с именами, которые нельзя прочитать как измеренные
durations:

- `phases.run_record_span_ms` — max(updated_at) − min(created_at) по run-записям
  выборки. Это span execution-records: `updated_at` двигается при каждом
  advance, это НЕ граница Run и НЕ compute. Имя `run_wall_ms` запрещено.
- `phases.workers_span_sum_ms` — сумма span-ов run-записей; при параллельных
  runs ≠ wall time.
- `phases.pending_observed_ms` — dwell фазы `pending` (см. формулы).

У всех трёх оговорка одна: **record-span, не compute**. Legacy run-записи
(v1-схема или `run.legacy`-маркер) не имеют timestamps: они дают
`attribution.run_kind = null` и исключаются из span-полей. Записи с
перевёрнутыми часами (`updated_at` раньше `created_at`, например перевод часов
назад) тоже исключаются из span-полей: отрицательный span не публикуется.
`attribution.tasks` для batch-записей считается по словарю задач самой
run-записи (`run.items`), а не по delivery-покрытию.

## Checks (opt-in `--include-qa`)

Checks-блок — **change-scoped**: qa-результаты v1 не несут run-привязки,
поэтому `--run` сужает requests/runs/attribution, но не checks; `coverage`
заявляет успешно прочитанный scope — нечитаемый (или выключенный) checks-блок
оставляет `coverage = delivery_registry` и `checks = null`, а не заявку `+qa`.
Ограничение: в classic-проектах (`artifactProtocol: ai-factory`) qa-результаты
живут в каталоге плана, а v1 читает только OpenSpec QA root
(`paths.qa`/`.ai-factory/qa/<id>`) — classic plan-dir QA collection остаётся
вне declared inputs v1 (кандидат в follow-up этапа 2).

- `checks.repeated` — число qa-результатов с `supersedes ≠ null`
  (corrective-цепочки).
- `checks.reasons` — только коды закрытого allow-list: recovery action types
  delivery-членов, ledger `outcome`, run `recovery.reason`, плюс `unknown`.
  Ledger `outcome` входит в словарь кодов, но **не сэмплируется** в v1:
  `fix-attempts.json` не входит в declared inputs (см. design change), поэтому
  fix-attempt исходы появляются в `reasons` только после включения ledger в
  источники (follow-up). `binding_code` — открытое множество: код вне
  allow-list публикуется как
  `unknown`; `binding_code = null` не даёт выборки. Явное наблюдение причины
  повторной проверки в момент решения — этап 2.
- `checks.dependencies` — `[{check_id, manifest_digest, wave_id,
  input_fingerprint}]`, ids и digests без путей; больше 64 уникальных checks →
  deterministic truncate до 64 + note `dependencies_truncated`.
- `checks.*`, `attribution`, `provenance.registry_digest` — project-internal;
  в public evaluation export попадают только counts, enum-коды reasons,
  durations, `unknowns` verbatim и `coverage` (см. mapping в
  [workflow-exchange](workflow-exchange.md)). `checks.dependencies` и
  `provenance.registry_digest` в export не попадают никогда.

## Граница service_calls и этап 2

`service_calls`/`host_reads`/`host_releases` не входят в `runner_metrics` — это
граница coordination-dispatch; их агрегирует отдельный follow-up (#266) поверх
измерителя #230. Этап 2 (явный follow-up issue, создаётся финализатором до
закрытия #230): инструментирование `setup/checks/snapshot-hash/wait` и
producer-side timestamps, доказанные границы run/worker intervals, tokens/tool
counts через HostClient-контракт, явное reason-наблюдение повторных checks и
timestamps в qa-result, блоки `tools`/`dedup` при появлении производителей.
Issue #230 после этапа 1 не считается полностью выполненным — полнота
заявляется только относительно этапа 1.
