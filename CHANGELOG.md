# История изменений

Все заметные изменения этого проекта фиксируются в этом файле.

Формат основан на [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [В разработке]

### Добавлено
- Установленная команда `ai-factory aifhub-done-finalizer --change <change-id> --json` для bounded OpenSpec finalization без project-root helper scripts; публичный parser поддерживает только `--change`, `--skip-specs`, `--record-dirty-state` и `--json`, а коды выхода `0`/`1`/`2` разделяют success/warn, policy blocker и invalid/unresolved/unexpected command failure.
- Optional session context optimization service: `scripts/context-dedup.mjs`, wrapper command `ai-factory aifhub-context-dedup` и MCP tools `read_file_deduplicated`, `context_dedup_status`, `context_dedup_purge`. `aifhub.contextDedup.mode` выбирает `off | aifhub | sqz`; legacy `enabled` остаётся read-compatible. `sqz` запускается только как явно установленный user-owned executable через bounded `compress --no-cache`, exact repeats обслуживает AIFHub session ledger, state-dependent provider output fail-open отклоняется, а protected validation artifacts всегда отдаются полностью.
- Детерминированный offline replay-харнесс `scripts/context-dedup-benchmark.mjs` для сравнения трёх режимов: baseline без dedup, собственный сервис и bounded raw-stdin external adapter с отдельными compression/delta/reference метриками.
- Research по external candidate: `docs/memory-tools-research/sqz.md`, трёхстороннее сравнение в `docs/memory-tools-research/sqz-benchmark-results.md` и `ai-tester` matrix на `gpt-5.6-luna` с reasoning `low` (12 rows: baseline `4/4`, AIFHub `4/4`, безопасный `sqz --no-cache` runtime `4/4`; исторический stateful SQZ regression сохранён отдельно как `3/4`).
- Изолированный fail-closed `ai-tester` harness для issue `#134`: 18-row matrix для `baseline`, MCP-only и Codex plugin на `context-mode 1.0.169` с provenance, authorization, privacy, lifecycle, purge, cleanup и session-continuity gates, а также sanitized append-only evidence.

### Изменено
- OpenSpec CLI теперь детерминированно выбирается как explicit non-empty `options.command` -> project-local `node_modules/.bin/openspec(.cmd)` -> `PATH`; selected explicit/local candidate не получает silent fallback, а diagnostics публикуют только safe command/source без auto-install, `npx`, parent-project search или private absolute paths.
- `/aif-analyze` теперь сравнивает supported selected OpenSpec CLI с последней reviewed stable версией `1.8.0`: устаревшая CLI сохраняет capabilities, но получает неблокирующую рекомендацию обновить user-owned project-local/PATH/explicit installation без automatic install/update или package-manager guessing.
- Recommendation для `context-mode` уточнена по authorized live evaluation: MCP-only остаётся `manual_helper_only` только для >1 MiB truncating output с mandatory purge и без доказанной экономии tokens; tested Codex plugin nested-shell path получает `avoid`, session continuity — `NOT_RUN(resume_driver_parity_unavailable)`, а normal AIFHub commands по-прежнему не выполняют auto-install, MCP registration или hook trust.
- Reviewed AI Factory baseline обновлён до `2.17.0` при сохранении compatibility range `>=2.11.0 <3.0.0`; полный `2.15.0 -> 2.16.0 -> 2.17.0` audit включает planning, fix, QA, MCP, Control Flow и reviewed no-op adaptations.
- OpenSpec-native planning сохраняет immutable `## Original Request`, а revision-bound `## Research Context` предупреждает `WARN [research-drift]` без silent scope rebase.
- `/aif-fix` использует regression-first pre/post check как supporting runtime evidence, не заменяя authoritative `/aif-verify` evidence.
- `/aif-qa-check` документирован как branch-scoped QA execution с source/worktree bindings, stale invalidation, authorization и redaction; `qa-check.md` не является verify/done/archive evidence.
- AI Factory `2.16+` Universal / Other MCP rendering описан через `.mcp.json` и `mcpServers`; `aif-analyze` генерирует `Control Flow` base rule только по repository evidence.
- Документация OpenSpec-native workflow теперь описывает полный tail: sync/rules/review/security gates, verify/fix loop, doctor, done, post-archive sync, commit и optional evolve.
- Prompt assets для done/implement/verifier теперь явно передают финализацию в `/aif-mode sync`, `/aif-commit` и optional `/aif-evolve`, не представляя `/aif-done` заменой commit gate.
- `extension.json` теперь указывает на upstream JSON Schema `https://raw.githubusercontent.com/lee-to/ai-factory/2.x/schemas/extension.schema.json` и больше не содержит private AIFHub поля.
- AIFHub metadata `compat` и `sources` вынесены в `aifhub-extension.json` с локальной схемой `schemas/aifhub-extension.schema.json`.
- `npm run validate` теперь проверяет split contract: upstream manifest, AIFHub metadata, bundled agent files и docs links.
- `compat.ai-factory` now requires `>=2.11.0 <3.0.0`; AI Factory 2.11.0 provides native `aif-rules-check`, so AIFHub keeps only `injections/core/aif-rules-check-openspec-generated-rules.md` for OpenSpec generated-rules augmentation.
- `scripts/validate-extension.mjs` validates `extension.json` against the local synced copy of the upstream AI Factory extension schema.

### Исправлено
- OpenSpec-native finalization установленного проекта больше не зависит от отсутствующего root `scripts/openspec-done-finalizer.mjs`: manifest wrapper запускает extension-local module, сохраняет fail-closed readiness/archive policy и возвращает whitelist-based human/JSON output.
- `/aif-mode sync` в OpenSpec-native mode теперь обновляет `.ai-factory/rules/generated/openspec-base.md` даже после archive, когда активных changes больше нет, и пропускает change-specific rules/validation без ошибки.
- `/aif-mode sync --all` больше не падает только из-за активных migrated/docs-only changes без delta specs; такие changes помечаются `no-delta-specs`, а changes с delta specs продолжают проходить sync validation.
- Session context dedup считает net savings после стоимости replay, не заменяет короткий content более длинным replay и публикует `observedBytes`/`servedBytes`. SQZ benchmark adapter больше не помечает unchanged `Fresh` output как compression; отчёт разделяет exact-repeat, first-read, delta, protected-policy и failed-session savings.

## [0.10.0] - 2026-04-20

### Изменено
- Manifest extension перепроверен против upstream `ai-factory 2.11.0`, а `compat.ai-factory` поднят до `>=2.11.0 <3.0.0`
- Обновлены метаданные `sources.ai-factory`, чтобы явно зафиксировать проверенный upstream `2.11.0`
- `README.md`, `docs/README.md` и `docs/usage.md` сведены к одной сводке совместимости без смешения поддержки и baseline-семантики

### Исправлено
- Убраны bootstrap-формулировки, из которых следовало, что extension создаёт bridge files вроде `AGENTS.md` или `CLAUDE.md`
- Операционные примеры путей к plan сохранены на canonical placeholders: `.ai-factory/plans/<plan-id>.md` и `.ai-factory/plans/<plan-id>/`
- Smoke-check guidance приведён в соответствие с manifest contract и поддерживаемым runtime floor для `agentFiles`

## [0.9.1] - 2026-04-19

### Добавлено
- Поле `compat.ai-factory` в `extension.json` для semver-диапазона совместимости
- Поле `sources.ai-factory` в `extension.json` для отслеживания upstream-версии
- Проверка совместимости в `/aif-analyze`, которая предупреждает, когда активная версия `ai-factory` выходит за поддерживаемый диапазон

### Изменено
- Версия manifest extension поднята до `0.9.1`
- Записи Codex `agentFiles` нормализованы под актуальную схему `runtime` / `source` / `target`, которую ожидает `ai-factory`

### Исправлено
- Восстановлена install-совместимость для `ai-factory extension add` с опубликованным manifest extension

## [0.7.2] - 2026-03-21

### Добавлено
- `skills/shared/QUESTION-TOOL.md` - справочная документация по форматам `question` и `questionnaire` для разных agents (`pi`, `Claude Code`, `Kilo CLI`, `OpenCode`)

### Изменено
- Выполнена миграция с псевдосинтаксиса `AskUserQuestion:` на документированные вызовы `question` / `questionnaire` во всех workflow skills
- Во все затронутые skills добавлен `allowed-tools: question questionnaire`
- Унифицирован формат reference-ссылок во всех skill files
- Всё содержимое skills переведено на английский для единообразия

### Исправлено
- Некорректный JSON-синтаксис (comments в JSON arrays) в `aif-verify-plus`

## [0.7.1] - 2026-03-19

### Добавлено
- Skill `aif-explore` для thinking-only research mode с владением `RESEARCH`
- Orchestration skill `aif-apply` для workflow выполнения plan
- Документация по context loading policy

### Изменено
- Архитектура обновлена так, чтобы отражать срезы exploration и orchestration
- Manifest синхронизирован с актуальным набором skills

## [0.7.0] - 2026-03-15

### Добавлено
- Первый релиз `aifhub-extension`
- Базовые workflow skills: `aif-analyze`, `aif-new`, `aif-improve-plus`, `aif-implement-plus`, `aif-verify-plus`, `aif-fix`, `aif-done`
- Plan-folder workflow с отслеживанием статуса
- Поддержка skill-context override
