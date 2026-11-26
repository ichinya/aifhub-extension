[Предыдущая страница](memory-tool-recommendations.md) | [К документации](README.md) | [Следующая страница](context-loading-policy.md)

# Session Context Dedup

`scripts/context-dedup.mjs` — optional session-scoped сервис оптимизации чтений. `aifhub.contextDedup.mode` явно выбирает отсутствие оптимизации, встроенный AIFHub exact-read dedup или установленный пользователем `sqz`. Сервис выключен по умолчанию и включается только explicit opt-in.

## Модель Сессии

Session id выбирается в порядке:

1. explicit `--session` / internal `sessionId`;
2. `AIFHUB_SESSION_ID`;
3. host session id (`CODEX_THREAD_ID` или `CLAUDE_SESSION_ID`);
4. process-local random nonce.

Current change pointer и persistent `default` не используются: change lifetime не равен model session lifetime. MCP создаёт отдельный random id на каждый stdio server process и не позволяет caller выбирать чужой id.

Ledger — local runtime state:

```text
<paths.state>/context-dedup/session-<sha256(session-id)>/ledger.json
```

Hash storage key не даёт `team/a`, `team-a`, `..` и Unicode ids столкнуться или влиять на filesystem path. Ledger хранит relative canonical path, digest, размер, counters и timestamps, но не file content. Schema v3 считает model-visible net bytes; несовместимый/повреждённый ledger сбрасывается с fail-open warning.

Canonical root и target проверяются через real path. `./`, `docs/../`, case aliases и in-root symlinks сходятся к одному key; symlink/junction escape за project root отклоняется до чтения.

Concurrent процессы используют session-exclusive ledger locks и unique temporary files. Короткий project gate координирует только получение session lock и `purge --all`; он не удерживается во время SQZ subprocess, поэтому разные sessions не сериализуются внешним compressor. Если lock/save не удался, сервис отдаёт полный content с `context-dedup-ledger-unwritable`.

## Решения

| Условие | `decision` | Результат |
|---|---|---|
| `mode: "off"` | `disabled` | полный content |
| `mode: aifhub`, первое чтение или неподтверждённая прежняя выдача | `full` | актуальный исходный текст |
| `mode: sqz`, подходящее чтение, результат сжатия короче | `compressed` | самодостаточный текст из `sqz compress --no-cache` |
| `mode: sqz`, utility отсутствует/ошиблась | `full` | полный content + sanitized warning |
| protected path | `protected` | полный content |
| меньше `minBytes` | `below-threshold` | полный content |
| `maxEntries: 0` | `full` | полный content без ledger entry |
| Тот же получатель ещё видит самодостаточный ответ на полное чтение той же ревизии, маркер короче | `deduplicated` | ссылка на уже показанный текст |
| Ревизия изменилась | `changed` в AIFHub при наличии прежней записи, `full` в SQZ | полный текст новой ревизии |
| Принудительное чтение (`force`) | зависит от режима и предшествующей записи | исходный текст, без запуска SQZ |
| ledger unavailable | `full` | полный content + warning |

Replay содержит path, короткий digest, reuse guidance, structured `forceRead: {path, force: true}` и инструкцию повторить тот же read с `force: true`; executable shell command с repo-controlled path не формируется. Полный SHA-256 остаётся в structured `digest`.

После перезапуска процесса, смены проекта или получателя, а также при потере подтверждения доставки читателю нужен самодостаточный ответ. Совпадения session ID и digest в ledger для ссылки недостаточно. В адаптере Pi чтение с `offset` или `limit` и продолжение усечённого вывода получают обычный запрошенный диапазон. Защищённые данные читаются с обычными границами API. [Адаптер Pi](../benchmarks/pi-sqz-matrix/dedup-read.mjs)

## Protected Artifacts

Non-removable defaults:

- `openspec/specs/**`;
- `openspec/changes/**`;
- `.ai-factory/plans/**`;
- `.ai-factory/rules/generated/**`;
- `.ai-factory/qa/**`;
- `**/aif-gate-result*`;
- `**/coverage.json`;
- `**/done-readiness.json`.

Consumer дополнительно выводит protected roots из `aifhub.openspec.root`, `paths.plans`, `paths.specs`, `paths.qa`, `paths.generated_rules` и `paths.state`; при отсутствии `paths.plans/specs` fallback выбирается по `aifhub.tools.openspec`. `protectedPatterns` только расширяет список.

## Конфигурация

```yaml
aifhub:
  contextDedup:
    mode: "off" # off | aifhub | sqz
    minBytes: 2048
    maxEntries: 500
    protectedPatterns:
      - docs/frozen/**
    sqz:
      command: sqz
```

`mode` type-stable: boolean и string не смешиваются в одном новом selector. Legacy `enabled: false` читается как `off`, legacy `enabled: true` — как `aifhub`; при одновременном конфликтующем `mode` explicit mode имеет приоритет и даёт diagnostic.

`aif-analyze` владеет public config shape: сохраняет существующие значения, добавляет missing `mode: "off"` defaults и никогда не включает dedup автоматически. Parser принимает inline и block YAML lists, игнорирует inline comments и отклоняет partial/fractional integers.

### Выбор `sqz`

`mode: sqz` означает, что AIFHub будет запускать новую стороннюю user-owned утилиту. Проверенный benchmark использовал `ojuschugh1/sqz` v1.3.0 под Elastic License 2.0. Перед выбором пользователь должен увидеть это предупреждение и подтвердить внешний dependency.

Само изменение config **не устанавливает** binary. AIFHub не скачивает `sqz`, не запускает `sqz init`, не ставит hooks, не регистрирует MCP и не меняет agent config. Установите проверенный executable отдельно и укажите его через `sqz.command` либо обеспечьте доступность команды `sqz` в `PATH`.

Runtime запускает фиксированную команду `sqz compress --no-cache` без shell, проверяет лимит входа (1 МиБ в UTF-8) до запуска, ограничивает время и объём вывода. При повреждении ledger читатель получает исходный текст, а следующее чтение использует восстановленную запись. Дочерний процесс получает разрешённые переменные для поиска executable, временных файлов и локали, а также отдельные `HOME`, `USERPROFILE`, `XDG_*` и `SQZ_HOME`. В Windows SQZ v1.3.0 находит `~/.sqz` через platform home API, поэтому одного изменения окружения недостаточно для изоляции кэша. Подтверждённый точный повтор AIFHub может обслужить коротким маркером без второго вызова SQZ. При ошибке запуска, ненулевом коде выхода, таймауте, превышении лимита, некорректном UTF-8 или неожиданном `§ref`/`§delta` читатель получает исходный текст. Диагностика скрывает сырой stderr. Пользовательская статистика SQZ под `~/.sqz` управляется отдельно.

## CLI

```bash
ai-factory aifhub-context-dedup check --file src/auth/session.ts --session <id> --json
ai-factory aifhub-context-dedup check --file src/auth/session.ts --session <id> --force
ai-factory aifhub-context-dedup status --session <id> --json
ai-factory aifhub-context-dedup purge --session <id>
ai-factory aifhub-context-dedup purge --all
```

Для общей статистики CLI и hooks передают стабильный идентификатор через `--session` или `AIFHUB_SESSION_ID`. Новый процесс с тем же идентификатором может открыть ledger, но заново выдаёт самодостаточный текст.

Status использует net model-visible accounting:

- `mode` — effective `off`, `aifhub` или `sqz`;
- `observedBytes` — полный объём всех подходящих чтений до любой оптимизации (включая SQZ compression), то есть no-optimization baseline;
- `servedBytes` — объём текста, который получил читатель (оригинал, сжатый текст или маркер повтора);
- `savedBytes = observedBytes - servedBytes` относительно этого no-optimization baseline;
- `savedPercent = savedBytes / observedBytes`.

Поэтому revisions, eviction и стоимость replay не искажают экономию. Невыгодный replay не считается dedup hit и fail-open отдаёт полный content.

Debug diagnostics opt-in: `AIFHUB_CONTEXT_DEDUP_DEBUG=1` пишет bounded lines с prefix `[FIX:133]`, path/decision/bytes без file content.

## MCP

| Tool | Назначение |
|---|---|
| `aifhub.read_file_deduplicated` | Read текущей MCP session; `path` + optional `force`, максимум 1 MiB. |
| `aifhub.context_dedup_status` | Public totals без internal session id и ledger path. |
| `aifhub.context_dedup_purge` | Dry-run по умолчанию; `confirm: true` удаляет только current MCP session. |

Policy diagnostics и предупреждения идут отдельным текстовым блоком MCP. При защищённом или принудительном чтении первый блок содержит точный исходный текст.

Сервер MCP через stdio не видит, когда клиент сбросил контекст. На этом входе каждый ответ самодостаточен, даже при повторном чтении в одном соединении.

## Benchmark И AI Tester

```bash
node scripts/context-dedup-benchmark.mjs --mode baseline --mode variant-a
node scripts/context-dedup-benchmark.mjs \
  --mode external \
  --external-command "<verified-sqz-adapter>" \
  --external-protocol sqz-text \
  --json
```

Harness всегда создаёт owned temporary workspace, проверяет trace containment, ограничивает external timeout/output и использует isolated HOME/XDG/SQZ paths. Compression, delta и reference считаются отдельно; только reference является dedup hit.

В историческом AI Tester r4 (`gpt-5.6-luna / low`, Windows, по одному запуску четырёх сценариев на режим) AIFHub и SQZ сократили выдачу второго чтения на 98,74% в одном случае точного повтора. В новом профиле #186 (`gpt-6.1-terra / low`, Windows, full access) три повторных чтения в режиме SQZ дали суммарно 43 026 байт до и после обработки. Для выбора режима по расходу токенов используйте парные результаты полных задач Pi. [Контрольные сценарии](memory-tools-research/sqz-benchmark-results.md) · [Снимок и воспроизведение #186](memory-tools-research/context-dedup-ai-tester/issue-186/coverage.md#воспроизведение)

## Границы

Dedup не является gate, не переписывает project files, не отправляет content в сеть, не включает telemetry, не устанавливает tools и не меняет agent config. В `sqz` mode локальный content передаётся только выбранному user-owned executable через stdin.

## Purge

CLI user может удалить explicit session или весь configured AIFHub dedup state. Это удаляет AIFHub ledger и его session directory, но не user-owned SQZ statistics/cache под `~/.sqz`. MCP требует preview/confirm и не имеет all-session surface.

## См. Также

- [AIFHub MCP](aifhub-mcp.md)
- [Context Loading Policy](context-loading-policy.md)
- [sqz](memory-tools-research/sqz.md)
- [AI Tester results](memory-tools-research/sqz-benchmark-results.md)
