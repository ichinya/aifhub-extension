# История изменений

Все заметные изменения этого проекта фиксируются в этом файле.

Формат основан на [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [В разработке]

### Изменено
- `/aif-explore` теперь уточняет research brief через dependency-aware design tree: самостоятельно собирает доступные repository/config facts в read-only режиме, задаёт пользовательские решения раундами по frontier зависимостей с рекомендациями и начинает полный research только после подтверждения нормализованного brief без создания отдельного interview artifact; autonomous/subagent запуск возвращает неподтверждённый brief родителю с blocker `research-brief-confirmation-required`, а не принимает assumptions за согласие.

## [1.5.0] - 2026-09-01

### Добавлено
- Pinned source-compatibility evidence для AI Factory `2.19.0` на commit `3c1ddd4740d7b1c30d8ecb3dc80fa5e7b8d7ef5a`: exact `2.18.1...3c1ddd4740d7` audit включает 7 commits и 16 changed files, upstream-owned `/aif-warmup`, `warmup.paths` и Microsoft APM manifest. Отсутствие `2.19.0` tag, GitHub release и npm package зафиксировано отдельно от последнего published-executable smoke `2.18.1`.
- Regression coverage для fresh `warmup.paths: []`, сохранения user-owned warmup list через оба mode profile и запрета backfill в существующий config без секции.
- Exact-tagged OpenSpec `1.10.0` compatibility evidence с независимыми Git source custody (`v1.10.0`, commit `1ebddd17f40dde15dfd28289e4493c3cf05ee9df`, compare `v1.9.0...v1.10.0`) и checksum-verified npm executable custody (`@fission-ai/openspec@1.10.0`, integrity, shasum, bin, lifecycle scripts, dependencies и Node engine `>=20.19.0`). Локальный exact-package smoke не заявляется как CI, deployment или production evidence.
- Bounded OpenSpec `1.10.0` CLI matrix для version detection, strict validate, status, show, apply/archive/specs instructions, open JSON envelopes, Store-root resolution, no-spec schema `skip_specs`, stderr-only telemetry notice и blocked-retirement archive no-mutation.
- Exact-tagged OpenSpec `1.9.0` compatibility evidence с независимыми Git source custody (`v1.9.0`, commit `2826b8889e5223a9a8095d4428b60b56597e1020`, compare `v1.8.0...v1.9.0`) и npm executable custody (`@fission-ai/openspec@1.9.0`, integrity, shasum, bin и Node engine `>=20.19.0`). Локальный extracted-package smoke не заявляется как CI, deployment или production evidence.
- Deterministic regressions для strict/non-strict task numbering, arbitrary nested scenario loss, rootless list/bulk/schemas behavior, invalid archive no-mutation и archive serialization с preserved blank lines и ровно одним final newline.
- Negative repository contract, удерживающий `openspec validate --archived` вне package scripts, tracked CI, shared runner argv, `/aif-verify`, `/aif-done` и release acceptance PASS boolean.
- Read-only детерминированный diff конфига `ai-factory aifhub-analyze-config-diff [--json]` (issue #143): AIFHub-owned ключи описаны манифестом `skills/aif-analyze/references/config-keys.json` (`{key, required, since, purpose}` и поле `deprecated`), отчёт классифицирует `missing` (с назначением) / `obsolete` / `version_drift` / `up_to_date`; команда fail-closed при отсутствующем конфиге или битом манифесте, манифест и версия скилла разрешаются extension-локально, а конфиг читается из корня consumer-проекта — сверка выполняется до патчинга без траты LLM-токенов. Конфиг запоминает версию скилла в блоке `analyze.skill_version` (существующее значение не перезаписывается), `aif-analyze` обновлён с 0.10.0 до 0.11.0 с diff перед патчем, презентацией добавлений с назначением и fast-path при `up_to_date`.
- Завершённая evidence-backed оценка repo graph provider Understand Anything (issue #129): fail-closed eligibility, static-audit, sandbox и path/privacy contracts на pinned revision, deterministic reviewed-output adapter с sanitized fixtures и отдельная `ai-tester` matrix/reporting; full-trace privacy evaluation провален, unsafe raw traces очищены после bounded aggregation, а провайдер остаётся denylisted для probes, рекомендаций и normal execution — итоговое решение `reject_defer` без production-интеграции, installer, indexer, hook, viewer, daemon или automatic selection path.

### Изменено
- Reviewed AI Factory source baseline обновлён до snapshot, declaring `2.19.0`, при неизменном compatibility range `>=2.11.0 <3.0.0`; `/aif-warmup` и APM distribution остаются upstream-owned, а schema/loader, injection/MCP, Node, bin и dependency contracts не меняются.
- Fresh AIFHub config теперь включает upstream default `warmup.paths: []`; существующая секция остаётся user-owned и сохраняется, а её отсутствие в existing config эквивалентно пустому списку и не вызывает backfill.
- Reviewed OpenSpec baseline последовательно обновлён с `1.8.0` через `1.9.0` до `1.10.0` при неизменных baseline `1.3.1`, stable range `>=1.3.1 <2.0.0`, prerelease ledger `1.6.0-beta.1` и Node requirement `>=20.19.0`; `/aif-analyze` продолжает только source-aware non-blocking update guidance без automatic install/update/downgrade.
- OpenSpec-native `/aif-plan` и `/aif-improve` теперь требуют inline completion verification в каждом task checkbox; отдельная verification task допустима только для broader integration/system checks, охватывающих несколько implementation tasks. Для legacy checklist `/aif-improve` выполняет bounded migration недостающих verification clauses, сохраняя номера, checkbox states, порядок и исходный intent задач.
- Zed, `init --language`, Store selection, profiles, schema generation, OpenCode assets, completion/update behavior и package management остаются upstream-owned. OpenSpec `1.11.0` не входит в review или compatibility claims этого checkpoint.
- Archived-wide validation документирована как отдельное advisory observation: historical incomplete archives не исправляются, а advisory exit не влияет на обязательный PASS.

### Исправлено
- Исправлен fallback языка prompt для issue #166: user-facing prose теперь детерминированно следует `language.ui` → current conversation → English-last без OS locale или persistence. Setup hint появляется только при hard English fallback с доступным prose slot, сохраняет exact-output-only branches и располагается до обязательного `aif-gate-result`; все 13 active injections и clean/global/targeted consumer smoke защищены matched start/end marker pairs и byte-identical upstream suffix checks.
- Реконсиляция generated rules в `/aif-mode` переведена на authoritative active-change inventory с prepare-before-mutate batch (issue #163): status, doctor и sync получают bounded reconciliation operations в JSON, human output и отчётах; prune удаляет только точные compiler-owned archived outputs с сохранением unknown files, а canonical source snapshots и atomic publication защищены от linked roots, source drift и подмены generated root. Base index metadata и canonical paths валидируются до реконсиляции, чтение generated content и trace пропускается до установления active membership и root trust; добавлены regressions на traversal, Windows-absolute пути, malformed index и внешние junction/symlink.
- Screening-матчеры Repowise больше не относят smoke evidence к generic proven labels; conditional и avoid cases выровнены с matcher-supported project dimensions.
- Understand Anything privacy checks обнаруживают credential-like JSON поля в compact contexts и полных traces, а fixture filesystem failures нормализуются без exposure путей; pinned matrix и fail-closed pair semantics уточнены.
- `context_dedup` purge на Windows повторяет transient коды `EBUSY`/`EMFILE`/`ENFILE`/`ENOTEMPTY`/`EPERM` (bounded retries), поэтому файлы, временно занятые параллельными handlers или индексаторами, больше не ломают `purge --all` и session purge.

## [1.4.0] - 2026-08-19

### Добавлено
- Marker-first AI Factory 2.18 classic/ultra classifiers, version и ultra-research resolvers, revision-bound legacy-ultra verification receipts и OpenSpec-native `/aif-archive` boundary без второго canonical source of truth.
- Offline deterministic consumer smoke в default `npm test` и отдельный non-globbed `npm run smoke:ai-factory-2-18` driver для явно переданных local `2.17.0`/`2.18.1` command-plus-argv toolchains при сохранённых `--v217-*`/`--v218-*` flags. Driver проверяет exact version/provenance до project mutation, использует bounded `execFile`/`shell: false` boundary с Windows ConSpec adapter, возвращает `NOT_RUN` для missing prerequisites и не скачивает packages; stable `2.18.0` остаётся отдельной feature boundary.

### Изменено
- Reviewed AI Factory baseline обновлён до `2.18.1` при неизменном compatibility range `>=2.11.0 <3.0.0`: cumulative `2.18.0` ledger сохранён, OpenSpec-native `ultra` остаётся canonical-depth profile, legacy marked ultra остаётся atomic upstream bundle, а regular/ultra research остаётся supporting runtime context.
- Машинный контракт `aif-gate-result` ужесточён: `suggested_next` обязан быть `null` при `status: "pass"` (диагностика `invalid-suggested-next-on-pass`), а терминальная и прямая next-step маршрутизация (`/aif-done <change-id>` после пройденного verify, `/aif-verify <change-id>` после пройденного rules gate) остаётся prose-only и никогда не кодируется в машинном блоке.
- Новый upstream-owned `/aif-explore` Research Coherence Gate получает только non-bypass pass-through после разрешённой persisted записи: optional fresh-context `Task` имеет mandatory direct fallback, а в ultra coherence выполняется до Bundle Integrity Gate.
- `/aif-analyze` и mode sync структурно patch-ят только AIFHub-owned config keys, сохраняют unknown/core nested fields и выводят diagnostics только по key paths/counts без values, environment или credentials.
- Namespaced Codex/Claude agents используют общий parity contract: для marked legacy ultra возвращают exact upstream command handoff; verifier receipt пишет только command boundary, done/rules evaluators остаются read-only.
- Для exact `2.17.0`→`2.18.1` документирован `ai-factory update --force`; `upgrade` остаётся только v1-to-v2 migration command. Targeted extension refresh документирован отдельно как `ai-factory extension update aifhub-extension --force`.

### Исправлено
- Устранён цикл next-step рекомендаций между `/aif-rules-check` и `/aif-verify` (issue #155): маршрутизация стала однонаправленной с терминальными состояниями — verify PASS → `/aif-done`, verify FAIL → `/aif-fix`, rules-check PASS → `/aif-verify` (или `/aif-done`, если verify уже пройден по актуальному реквизиту), rules-check FAIL/missing/stale → `/aif-mode sync --change` + rerun; зеркала claude/codex, injections и docs синхронизированы, контракт закреплён phrase-тестами prompt-ассетов.
- Квитанции, написанные до null-on-pass контракта, получают адресные коды диагностики вместо безликих invalid-evidence исходов: `verification-gate-legacy-suggested-next` (remediation — один повторный `/aif-verify`) и `rules-gate-legacy-suggested-next` (перезапуск `/aif-rules-check` и персист через `ai-factory aifhub-write-gate-evidence`) в done readiness и параллельных проверках done finalizer; severity, blocking и recovery-команды не изменены.
- Valid marked ultra bundles больше не определяются как folder-only classic plans и не мигрируются автоматически; malformed marker/phase shapes и classic/ultra collisions блокируются до записей.
- Canonical OpenSpec changes fail-closed при попадании active ultra marker, `index.md`, direct/nested `phase-*` или runtime companion artifacts независимо от optional CLI policy.
- Clean/global/targeted update evidence теперь доказывает сохранность exact upstream `aif-explore` bytes с Research Coherence Gate и one-copy AIFHub marker; targeted flow дополнительно доказывает замену stale managed AIFHub agent до extension-source hash, byte-identical dummy extension ledger/files, сохранность unknown config/unmanaged agents, injection cardinality и artifact digests.

## [1.3.1] - 2026-08-13

### Добавлено
- Установленная команда `ai-factory aifhub-done-finalizer --change <change-id> --json` для bounded OpenSpec finalization без project-root helper scripts; публичный parser поддерживает только `--change`, `--skip-specs`, `--record-dirty-state` и `--json`, а коды выхода `0`/`1`/`2` разделяют success/warn, policy blocker и invalid/unresolved/unexpected command failure.
- Изолированный fail-closed `ai-tester` harness для issue `#134`: 18-row matrix для `baseline`, MCP-only и Codex plugin на `context-mode 1.0.169` с provenance, authorization, privacy, lifecycle, purge, cleanup и session-continuity gates, а также sanitized append-only evidence.
- Стандартизированный `## Roadmap Linkage` в OpenSpec proposals и marker-bounded `OpenSpec Change Lifecycle` с независимыми локальными состояниями `planned`/`finalized` и GitHub milestone phase audit.
- Bounded roadmap lifecycle integration: `/aif-done` переводит только связанную строку в `finalized` после успешного archive, `/aif-commit` блокирует доказанный local lifecycle drift, а `/aif-roadmap check` отдельно reconciles текущий GitHub state.
- Reproducible `gpt-5.6-luna`/`low` AI Tester matrix для пяти roadmap lifecycle сценариев с sanitized aggregate evidence без raw transcripts, credentials или sandbox paths.

### Изменено
- OpenSpec CLI теперь детерминированно выбирается как explicit non-empty `options.command` -> project-local `node_modules/.bin/openspec(.cmd)` -> `PATH`; selected explicit/local candidate не получает silent fallback, а diagnostics публикуют только safe command/source без auto-install, `npx`, parent-project search или private absolute paths.
- OpenSpec compatibility ledger последовательно проверяет stable releases `1.4.0`–`1.8.0` и prerelease `1.6.0-beta.1`; adapter поддерживает native `skip_specs`, lifecycle metadata, nested tasks/specs и version-gated `retire_capabilities` без установки OpenSpec skills или запуска self-update.
- `/aif-analyze` теперь сравнивает supported selected OpenSpec CLI с последней reviewed stable версией `1.8.0`: устаревшая CLI сохраняет capabilities, но получает неблокирующую рекомендацию обновить user-owned project-local/PATH/explicit installation без automatic install/update или package-manager guessing.
- Recommendation для `context-mode` уточнена по authorized live evaluation: MCP-only остаётся `manual_helper_only` только для >1 MiB truncating output с mandatory purge и без доказанной экономии tokens; tested Codex plugin nested-shell path получает `avoid`, session continuity — `NOT_RUN(resume_driver_parity_unavailable)`, а normal AIFHub commands по-прежнему не выполняют auto-install, MCP registration или hook trust.

### Исправлено
- OpenSpec-native finalization установленного проекта больше не зависит от отсутствующего root `scripts/openspec-done-finalizer.mjs`: manifest wrapper запускает extension-local module, сохраняет fail-closed readiness/archive policy и возвращает whitelist-based human/JSON output.
- Windows `.cmd` shim execution сохраняет literal argv, включая `%...%`, `!...!`, quotes и metacharacters, с explicit delayed-expansion disable; verification/finalization evidence сохраняет bounded `commandSource` без private absolute executable paths.
- Same-process context-dedup ledger transactions сериализованы, поэтому concurrent reads больше не теряют один update во время полного test run.

## [1.3.0] - 2026-07-28

### Добавлено
- Optional session context optimization service: `scripts/context-dedup.mjs`, wrapper command `ai-factory aifhub-context-dedup` и MCP tools `read_file_deduplicated`, `context_dedup_status`, `context_dedup_purge`. `aifhub.contextDedup.mode` выбирает `off | aifhub | sqz`; legacy `enabled` остаётся read-compatible. `sqz` запускается только как явно установленный user-owned executable через bounded `compress --no-cache`, exact repeats обслуживает AIFHub session ledger, state-dependent provider output fail-open отклоняется, а protected validation artifacts всегда отдаются полностью.
- Детерминированный offline replay-харнесс `scripts/context-dedup-benchmark.mjs` для сравнения трёх режимов: baseline без dedup, собственный сервис и bounded raw-stdin external adapter с отдельными compression/delta/reference метриками.
- Research по external candidate: `docs/memory-tools-research/sqz.md`, трёхстороннее сравнение в `docs/memory-tools-research/sqz-benchmark-results.md` и `ai-tester` matrix на `gpt-5.6-luna` с reasoning `low` (12 rows: baseline `4/4`, AIFHub `4/4`, безопасный `sqz --no-cache` runtime `4/4`; исторический stateful SQZ regression сохранён отдельно как `3/4`).

### Изменено
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
