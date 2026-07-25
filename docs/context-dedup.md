[Предыдущая страница](memory-tool-recommendations.md) | [К документации](README.md) | [Следующая страница](context-loading-policy.md)

# Session Context Dedup

`scripts/context-dedup.mjs` — optional session-scoped сервис дедупликации чтений. Если один и тот же файл читается в сессии повторно и его содержимое не изменилось, сервис возвращает короткий replay-ответ вместо полного текста. Это убирает повторную оплату одного и того же контекста.

Сервис выключен по умолчанию и включается только явным opt-in, как и остальные optional tools AIFHub.

## Модель Сессии

Единица дедупликации — сессия. `sessionId` берется в порядке: `--session <id>`, затем `AIFHUB_SESSION_ID`, затем current change pointer (`.ai-factory/state/current.yaml`), затем `default`.

Ledger сессии — локальный runtime state, не canonical artifact:

```text
.ai-factory/state/context-dedup/<session-id>/ledger.json
```

Ledger хранит только relative path, sha256 digest, размер, счетчики и timestamps. Содержимое файлов в ledger не пишется. Сеть не используется, телеметрии нет.

## Таблица Решений

| Условие | `decision` | Что возвращается |
|---|---|---|
| `enabled: false` | `disabled` | полное содержимое |
| Path совпал с protected pattern | `protected` | полное содержимое |
| Размер меньше `minBytes` | `below-threshold` | полное содержимое |
| Path впервые в сессии | `full` | полное содержимое |
| Path уже был, digest совпал | `deduplicated` | replay-ответ без содержимого |
| Path уже был, digest изменился | `changed` | полное содержимое |
| Запрошен `--force` | `changed` | полное содержимое |

Replay-ответ содержит path, digest, размер, время первого чтения, номер чтения и команду для принудительного повторного чтения.

## Protected Artifacts

Protected validation artifacts никогда не дедуплицируются, даже при полном совпадении digest:

- `openspec/specs/**`
- `.ai-factory/rules/generated/**`
- `.ai-factory/qa/**`
- `**/aif-gate-result*`
- `**/coverage.json`
- `**/done-readiness.json`

Список можно расширить через `protectedPatterns`, но нельзя сократить. Сервис не переписывает файлы: он влияет только на ответ на чтение, поэтому exact evidence snippets, gate evidence и canonical OpenSpec artifacts остаются нетронутыми на диске. См. [Context Loading Policy](context-loading-policy.md).

## Конфигурация

```yaml
aifhub:
  contextDedup:
    enabled: true
    minBytes: 2048
    maxEntries: 500
    protectedPatterns: [docs/frozen/**]
```

Неизвестные ключи и неверные типы дают `warning` diagnostics и fallback на defaults. Отсутствие `.ai-factory/config.yaml` означает выключенный сервис, а не ошибку.

## Уровень 1: CLI И Shell-хук

```bash
ai-factory aifhub-context-dedup check --file src/auth/session.ts --json
ai-factory aifhub-context-dedup check --file src/auth/session.ts --force
ai-factory aifhub-context-dedup status --json
ai-factory aifhub-context-dedup purge --session <id>
ai-factory aifhub-context-dedup purge --all
```

`check --json` возвращает decision, digest, размер, `savedBytes` и `estimatedSavedTokens` без содержимого файла и предназначен для shell-хука агентного runtime. Хук должен быть fail-open: при ненулевом exit code или отсутствии команды он отдает файл как обычно.

## Уровень 2: MCP

Сервер `aifhub` публикует три инструмента:

| Tool | Назначение |
|---|---|
| `aifhub.read_file_deduplicated` | Прочитать файл один раз за сессию; повтор возвращает replay-ответ. |
| `aifhub.context_dedup_status` | Totals сессии: reads, dedup hits, saved bytes, estimated saved tokens. |
| `aifhub.context_dedup_purge` | Удалить ledger одной сессии или всех сессий. |

См. [AIFHub MCP](aifhub-mcp.md).

## Оценка Экономии

`estimatedSavedTokens` — прозрачная эвристика `ceil(savedBytes / 4)`, а не биллинговый счетчик. `status` показывает реальные `savedBytes` по текущей сессии; для сравнения инструментов используйте paired прогоны из [AI Tester Matrix Для Memory Tools](memory-tools-research/ai-tester-matrix.md).

## Границы

Сервис не должен:

- становиться gate: выключенный или недоступный dedup никогда не блокирует `/aif-verify`, `/aif-done` и другие команды;
- переписывать, сжимать или удалять файлы проекта;
- дедуплицировать protected validation artifacts;
- отправлять данные по сети или собирать телеметрию;
- перехватывать API-трафик через proxy или root CA;
- устанавливаться или включаться автоматически.

Browser extension и IDE extension не входят в состав AIFHub Extension. Ядро сервиса остается пригодным для таких интеграций, но их публикация — user-owned.

## Purge

```bash
ai-factory aifhub-context-dedup purge --all
```

Или удалением каталога `.ai-factory/state/context-dedup/`.

## См. Также

- [Context Providers](context-providers.md)
- [Memory Tool Recommendations](memory-tool-recommendations.md)
- [Context Loading Policy](context-loading-policy.md)
- [AIFHub MCP](aifhub-mcp.md)
