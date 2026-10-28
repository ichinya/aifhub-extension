[К документации](README.md) | [SDD profiles](sdd-profiles.md)

# Classic AI Factory SDD и SessionBrief

Этапы 1+2 #233 поддерживают classic без миграции в OpenSpec. Effective `parseToolConfig` выбирает methodology **до** target resolution: explicit `aifhub.tools` имеет приоритет; `openspec:true` включает OpenSpec, `false` и `{}` выбирают classic. Legacy `artifactProtocol` применяется только без mapping. Отсутствие конфига означает classic; каталог `openspec/` сам по себе ничего не включает. Malformed consumed config блокирует выбор.

## Native источники

`paths.plans` задаёт full root, `paths.plan` — fast entrypoint. Explicit full ID или путь выбирает именно full parent; существующий fast его не перехватывает. Explicit fast path сохраняет `public_mode:fast` и upstream ownership. Без explicit target допускается ровно одна найденная classic pair: ноль даёт `active_change_unresolved`, несколько — `ambiguous_active_plan`.

Обязательны `<plans>/<id>.md` и `<plans>/<id>/{task.md,context.md,rules.md,verify.md,status.yaml}`. `explore.md` опционален. Parent и `task.md` должны совпадать по ID, порядку, title и checked state общего checklist parser. Отсутствующий parent даёт `missing_plan_file`, каждый отсутствующий companion — отдельный `missing_classic_companion`; resolver вызывает validate до parsing. Он не ремонтирует пару.

Parent использует native формат Summary/Scope/Approach/Requirements. Поддерживается следующий закрытый словарь активных H2; остальные H2 сохраняются в `sections` с path, byte offsets и digest без семантической интерпретации.

| EN | RU aliases | Значение |
|---|---|---|
| Summary | Резюме, Краткое описание | intent |
| Scope | Область изменений, Объём работ | объявленный outcome и allowed surface |
| Requirements | Требования | acceptance criteria |
| Approach | Подход | inventory design guidance, без выдумывания AC |
| Research Context | Контекст исследования | явно объявленные Goal, Constraints, Decisions, Open questions |
| Intent, Why | Цель | explicit intent |
| Target Outcome, What Changes | Ожидаемый результат | explicit outcome |
| Acceptance Criteria | Критерии приёмки | acceptance criteria |
| Acceptance Examples, Scenarios | Примеры приёмки, Сценарии | полные примеры |
| Allowed Change Surface | Разрешённая область изменений | explicit allowed surface |
| Forbidden Change Surface | Запрещённая область изменений | forbidden surface |
| Non-goals | Не входит в объём работ | non-goals |
| Constraints | Ограничения | constraints |
| Assumptions | Допущения | assumptions |
| Open Questions | Открытые вопросы | unresolved questions |
| Verification Plan | План проверки | verification plan |
| Document References | Ссылки на документы | exact project-relative refs |

`Original Request`, `Requirements Reconciliation`, `AIFHub Source Binding` и `SDD Profile Inputs` — фиксированные EN compatibility headings. Первые две секции сохраняются исходными UTF-8 byte spans, включая CRLF, таблицы и code blocks. Fenced headings не являются активными секциями; дубликат singular section блокирует parsing. SDD Profile Inputs использует тот же fenced JSON contract, что OpenSpec.

Приоритет surface: explicit Allowed Change Surface, затем `task.md` H3 In Scope, затем parent Scope. Out of Scope задаёт forbidden surface. `context.md` даёт полный design context, `rules.md` — plan constraints, `verify.md` — план проверок. Titles tasks не становятся requirements или permissions. Пустые intent/outcome, allowed surface, behavioral AC блокируют brief; отсутствующие inputs требуют research. Профили применяют общие gates, classic proposal=parent, tasks=task.md, design=context.md; delta specs не требуются.

## Revision и full fidelity

Canonical inventory содержит parent и пять companions. Policy: config.yaml, sdd-policy.json, .ai-factory.json. Protected refs включают configured rules/rules_file, architecture/context/review, AGENTS.md, CLAUDE.md и policy.context_refs. `Document References` в parent/context принимает точные bullet paths, code spans или Markdown links; содержимое ссылок не запускает рекурсивный поиск. Blanket walk `.ai-factory/specs/**`, OpenSpec schemas/specs/generated channels отсутствуют.

`status.yaml` использует sha256 canonical проекции `{plan_id, source_binding}` и `fidelity:projection`. Progress/current_task/updated_at/history не меняют revision; plan_id и synchronized Markdown/YAML binding остаются authoritative. Для projected source поле bytes и `budget.source_bytes` измеряют bytes проекции; реальные file bytes по-прежнему ограничены до parsing и общим raw budget. Это selected-source размер, не измерение всех повторных reads или agent tokens.

Остальные sources имеют full fidelity. Byte budgets остаются 2 MiB на файл, 32 MiB и 1024 sources; compiler сравнивает два snapshots и пишет только runtime outputs. Errors validation являются resolver errors; недостающие planning facts — blocked_reasons. Status не исправляет sources или старые runtime outputs.

## Ultra и consumers

Сначала выполняется существующий marker-first classifier. Valid ultra возвращает `public_mode:ultra`, `upstream_handoff:{owner:'upstream',entrypoint}` и пустые errors. Local compiler возвращает `blocked_reasons:['ultra_upstream_handoff']` с точной `/aif-implement <entrypoint>` командой; fix/verify используют свои команды. Native companions не открываются и не создаются. Invalid marker или collision сохраняет все sanitized classifier codes.

Execution context возвращает `aifactory-classic`, не собирает generated OpenSpec rules и не вызывает detect/instructions CLI. Implement **и Fix** проверяют exact consumed digest перед trace write. Compliance использует resolved checklist, отсутствие digest не подтверждает binding, explicit отсутствующий runId не заменяется другим trace. Fresh review сохраняет `outcome:prepared`. Tracer хранит methodology, canonical revision и nullable consumed digest; promotion проверяет source binding и для classic не предлагает OpenSpec sync.

## Digest migration и границы

Обязательное `instruction_composition_digest:null` находится внутри digest payload рядом с plan_context. Все ранее сохранённые brief, включая OpenSpec, однократно становятся stale и требуют recompile. Caller-provided hash игнорируется. Null означает «composition не зафиксирована»; обнаружение instruction drift требует отдельного producer manifest, которого этот change не реализует.

Follow-up: versioned instruction-composition manifest с ordered skill/injection/reference hashes и prepared/consumed per-attempt bindings. Отбор context #216, #203 P2, classic QA manifest #234 и reviewed outcome остаются отдельными задачами. Сокращение entrypoints/references — отдельный PR; сокращение upstream skill bodies требует отдельного upstream issue. Измеренного сокращения entrypoints этот change не заявляет.
