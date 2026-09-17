[К документации](../README.md)

# Исследование совместимости с Agent Plugins 1.0 — issue #200

Решение: **reference-only для текущего AIFHub; выпуск export subset отложен**. [Проверка пяти вопросов](follow-up.md) установила: все 3 исходных skills отклоняются `skills-ref 0.1.0`; нормализация проходит, но теряет флаг ручного запуска `aif-mode` в parser kernel VS Code 1.137.0. Замыкание справочных ссылок расширяет 29 исходных файлов до 188, включая runtime-код и agents. MCP нельзя переносить 1:1 без отдельного project binding. Поэтому текущие файлы не выпускаются как подтверждённый portable package. Ветка содержит исследование, schema snapshots и воспроизводимые probes; публичного генератора/инспектора и full client smoke нет. Статусы критериев issue приведены в конце.

Orkora [#312](https://github.com/ichinya/orkora/issues/312) владеет orchestration-side композицией пакетов, релизами и grants. Этот документ владеет только границей совместимости/дистрибуции AIFHub; стороны обмениваются версионированными манифестами и evidence и никогда не дублируют release engine.

## Источники и зафиксированные ревизии

Первичное исследование: 2026-09-12–13. Коррекция и локальная проверка границ экспорта: 2026-09-15. Текст Agent Plugins 1.0.0 повторно сверен с официальной страницей.

| Поверхность | Зафиксированная идентичность |
|---|---|
| Спецификация Agent Plugins | [1.0.0](https://agent-plugins.org/specification), статус: Published; канонические схемы `https://agent-plugins.org/schemas/1.0.0/plugin.schema.json` и `https://agent-plugins.org/schemas/1.0.0/mcp.schema.json` |
| Спецификация Agent Skills / validator | [agentskills.io/specification](https://agentskills.io/specification); референсный `skills-ref 0.1.0`, commit `69ef37e9424c0a7ea9dd2293b559e43ec8176379`; результаты исходных и нормализованных навыков в [frontmatter-results.json](frontmatter-results.json). Версия validator не заменяет ревизию спецификации |
| Опубликованные совместимые клиенты | [agent-plugins.org/compatible-clients](https://agent-plugins.org/compatible-clients) на 2026-09-13: VS Code, Cursor, GitHub Copilot, ChatGPT & Codex, Kiro, Hermes Agent, OpenClaw, Grok Bot, NanoClaw |
| Проверенный baseline AI Factory | `2.19.0` — тег `v2.19.0`, коммит `e144f95c89de0d0cb6c9b38dbe8c2907b00dc5ce`, npm `ai-factory@2.19.0` (опубликован 2026-09-10); поддерживаемый диапазон `>=2.11.0 <3.0.0`; Node `>=18` |
| Baseline исследования AIFHub | worktree `research-agent-plugins-1.0-compatibility-export` на `b640911` (`chore(release): prepare v1.7.0`) |
| Проверенная ревизия AIFHub | `02d3f68538abc9ac1712e3396eb69eca74f9e830`; локальный Node `v24.13.0`, установленный AI Factory `2.19.0`; это версии локальной пробы, не client smoke |
| Конкретный клиент | Установленный VS Code `1.137.0`, commit `645f29cc3176500b4b5762ba887cf2a7f0ffdf2c`, встроенный Copilot `0.65.0`; выполнен exact-source parser/discovery kernel probe, full UI smoke NOT_RUN. [Provenance](research-provenance.json) |
| Schema snapshots | Сохранены точные схемы 1.0.0 с URL, датой и SHA-256: [sources.json](snapshots/sources.json) |
| Практический референс упаковки | анонс Google Cloud Developer Plugin (2026-09-10) и [google/skills](https://github.com/google/skills); репозиторий — маркетплейс плагинов в стиле Claude Code (`marketplace.json`, `plugins/cloud/`), то есть клиент-специфичная дистрибуция, тогда как agent-plugins.org — vendor-neutral формат. Учитывается как prior art; нормативная цель экспорта — Agent Plugins 1.0.0 |

Спецификация Agent Plugins — независимый формат. Она не стандартизует extension/injection/runtime-семантику AI Factory и сознательно исключает из v1 команды, hooks, агентов, rules и LSP-серверы («слишком клиент-специфичные для стабильного переносимого контракта»).

## Что нормативно даёт Agent Plugins 1.0

Приведённые ниже ограничения определяют mapping и план fixtures:

- Плагин — каталог с закрытым `plugin.json` в корне. Разрешённые поля: `$schema`, `name`, `version`, `description`, `author`, `homepage`, `repository`, `license`, `keywords`, `extensions`. По §5.2 и §8.1 неизвестные поля верхнего уровня **и `extensions` неверного типа** сообщаются и игнорируются; остальные нарушения фатальны. Клиент не валидирует содержимое неизвестных namespace. Поэтому проверка JSON Schema исходного документа и решение клиента о продолжении загрузки — разные результаты.
- `name` должен удовлетворять ограничениям: `1-64` символа, `a-z0-9-.`, начало/конец алфанумерические, без `--`/`..`. `aifhub-extension` — валидное имя плагина.
- Ровно два типа компонентов: skills, обнаруживаемые в фиксированном месте `skills/<dir>/SKILL.md` (без рекурсивного поиска; каталоги без `SKILL.md` навыками не являются), и MCP-серверы из `mcp.json` в корне плагина. Оба фиксированных места могут отсутствовать без ошибки; присутствующее место неверного типа помечает этот тип компонентов недействительным, загрузка продолжается.
- Skills обязаны соответствовать спецификации Agent Skills; несоответствующий навык пропускается с сообщением и не фатален для плагина.
- `mcp.json` поддерживает закрытое объединение вариантов `stdio`, `streamable-http` и legacy `sse`. `command` — один исполняемый токен (bare-имя или plugin-relative `./`-путь); без placeholder-подстановки в `command`, `url` и заголовках; `${PLUGIN_ROOT}`/`${PLUGIN_DATA}` подставляются только в `args`, `env` и `cwd`. Клиент внедряет обе переменные в окружение subprocess; сконфигурированные записи `env` не вправе их переопределять. Заголовки и значения env — видимые данные пакета, а не переносимый механизм секретов; v1 не определяет OAuth и полей ссылок на учётные данные.
- По §7.2.1 отсутствие `cwd` означает **корень плагина**, а не открытый проект. Допустимый `cwd` ограничен plugin-relative путём, `${PLUGIN_ROOT}` или `${PLUGIN_DATA}` и их потомками. Переносимого placeholder для workspace нет; ambient environment может быть очищено клиентом (§9.1). Один `AIFHUB_PROJECT_ROOT` также не исправляет discovery extension-команд AI Factory, которое использует `process.cwd()`.
- Версия `$schema` в `mcp.json` обязана совпадать с `plugin.json`; несовпадение отключает MCP для плагина, остальные компоненты продолжают загружаться.
- Path containment (§4.1): доступ к файлам пакета остаётся внутри filesystem-resolved корня; symlink/junction могут разрешаться внутри него, выходящие пути отклоняются на самом узком применимом уровне. `args`/`env` — непрозрачные строки, их нельзя автоматически трактовать как package paths. Правило не является sandbox subprocess; `${PLUGIN_DATA}` имеет отдельную границу containment для `cwd`.
- Клиент-специфичные данные живут под reverse-domain namespace (`extensions` в манифесте и/или namespace-каталоги верхнего уровня). Клиенты игнорируют чужие namespace, не валидируя их содержимое.
- Клиенты обязаны продолжать после изолированных отказов компонентов. Сообщение об invalid configuration/connection failure рекомендовано (`SHOULD`); неподдерживаемый компонент сам по себе не ошибка. Smoke AIFHub отдельно требует наблюдаемой диагностики prerequisites, поэтому одной декларации conformance клиента недостаточно.

## Mapping поверхностей дистрибуции AIFHub

Количества — из `extension.json` на baseline исследования:

| Поверхность | Кол-во | Решение | Основание |
|---|---|---|---|
| `skills` (`aif-analyze`, `aif-done`, `aif-mode`) | 3 | **portable** (уровень формата) / **requires AI Factory** (уровень семантики) | Фиксированное место `skills/*/SKILL.md` совпадает с discovery; имена валидны. Frontmatter несёт поля вне списка Agent Skills (см. ниже), а тела навыков управляют `ai-factory` CLI и командами `/aif-*`, поэтому семантика workflow переносимой не становится |
| `skills/shared/` (TOOLS.md и 13 общих references) | 14 файлов | **portable** только как данные пакета | Каталог без `SKILL.md` внутри `skills/` навыком не является; клиенты его игнорируют, а тела навыков продолжают читать `../shared/...` внутри корня плагина |
| `mcpServers` (шаблон `aifhub`) | 1 | **requires AI Factory** + project binding; **исключён** из минимального кандидата | Синтаксис stdio представим, но `aifhub-mcp` — зарегистрированная extension-команда, а не встроенная команда CLI. Нужны extension discovery и правильный корень проекта. Запуск из отдельного plugin root на AI Factory 2.19.0 возвращает `unknown command`; host binding ещё не определён |
| `commands` (`commands/*.mjs`) | 22 | **requires AI Factory** / unsupported в v1 | Загружаются и вызываются через extension-загрузчик/bin `ai-factory`; в Agent Plugins v1 нет типа компонентов «команды» |
| `injections` (манифест, `injections/core/*`) | 13 | **requires AI Factory** / unsupported в v1 | Инъекция в промпты upstream `/aif-*` — семантика upstream-загрузчика; вне формата v1 явно |
| Дормантные handoff-заглушки (`injections/handoff/*`) | 4 | **requires AI Factory** / не экспортируются | Активный discovery уже исключает дормантные handoff-заглушки; дистрибутивным контентом они не являются |
| `agentFiles` (Codex `.toml` / Claude `.md`) | 9 + 9 | **client extension** (инертные данные) либо **исключение с записью в отчёт** | В v1 нет типа компонентов «агенты». Экспорт может либо поставить их read-only под reverse-domain namespace-каталог (для всех текущих клиентов инертно), либо исключить и зафиксировать потерю в compatibility-отчёте; молчаливое исключение запрещено инвариантами issue |
| Managed files / config defaults, записываемые `/aif-analyze` | runtime-поведение | **requires AI Factory** | Runtime-записи (`config.yaml`, `rules/base.md`, `REVIEW.md`, scaffolding `.gitignore`) — не содержимое пакета |
| Validation providers (независимые `tools.openspec`/`tools.hlv`/зарезервированный `tools.lekalo`) | config + runtime | **requires AI Factory** | Проверки HLV/Lekalo остаются validation providers; упаковка не активирует их и не выдаёт за plugin runtime |
| Протокол артефактов OpenSpec, QA/state evidence | артефакты проектов | **не поверхность упаковки** | Каноническое владение остаётся за пользовательскими проектами; репозиторий плагина остаётся artifact-light |

Mapping подтверждает предпосылку issue: копирование skills в каталог плагина не заменяет `ai-factory extension add/update` и не делает полный workflow AIFHub переносимым. Граница, уже проведённая в README для upstream-дистрибуции skills через APM, применяется здесь без изменений.

## Выводы по соответствию frontmatter навыков

Статус frontmatter каждого навыка против спецификации Agent Skills:

| Навык | Поля из спецификации | Поля вне списка спецификации |
|---|---|---|
| `aif-analyze` | `name`, `description`, `allowed-tools` | `version`, `author` |
| `aif-done` | `name`, `description`, `allowed-tools` | `version`, `author`, `argument-hint` |
| `aif-mode` | `name`, `description`, `allowed-tools`, `metadata` (map string→string) | `argument-hint`, `disable-model-invocation` |

`allowed-tools` определён спецификацией (experimental); имена инструментов остаются клиент-специфичными. Неизвестные top-level поля **отклоняются проверенным `skills-ref 0.1.0`**. Перенос их в строковые `metadata.aifhub.source.*` даёт exit 0 для всех трёх skills, но убирает флаг `disableModelInvocation` у `aif-mode` в точном VS Code parser kernel. Возврат top-level `disable-model-invocation: true` сохраняет флаг, но даёт exit 1 validator. `argument-hint` тоже теряет UI-семантику. Подробные inputs, hashes и результаты — в [follow-up](follow-up.md). Это конфликт выбранной нормализации и strict gate, а не доказательство невозможности любого будущего client adapter.

## Уровни совместимости

Три различных уровня в соответствии с пунктом 6 issue. Для полного пакета все три остаются **NOT_RUN / не подтверждено**. Выполненные validator и source-kernel probes фиксируются отдельно: они выявили blockers до допуска кандидата к полному client smoke.

1. `format_valid` — `plugin.json` и, если он присутствует, `mcp.json` проходят зафиксированные схемы 1.0.0; skills проходят валидацию Agent Skills; path containment выполняется. Допустимое отсутствие `mcp.json` не является ошибкой. Нефатальное восстановление клиента после schema violation не означает `format_valid` исходного пакета.
2. `loads` — конкретный клиент обнаруживает все ожидаемые skills. Для skills-only пакета MCP имеет статус `excluded`, а не «успешно подключён». Для будущего MCP-варианта отдельно фиксируются handshake, диагностика каждого отсутствующего prerequisite и привязка read-only запроса к выбранному проекту; попытки соединения недостаточно для статуса connected.
3. `workflow_semantics_verified` — полный workflow AIFHub (injections, extension-команды, managed files, validation gates). **Недостижим без AI Factory.** Любой экспорт или consumer, претендующий на этот уровень для переносимого подмножества, неверен по определению, и compatibility-отчёт обязан говорить это явно.

## План минимального экспорта

Опциональный производный экспортер (новая extension-команда или генератор в `scripts/`, решается на этапе реализации) пишет только в выбранный пользователем output directory:

- `plugin.json` — `$schema` зафиксирован на каноническом идентификаторе 1.0.0; `name: "aifhub-extension"`; `version` зеркалируется из `extension.json` (1.7.0 на baseline); короткое описание; `repository`; `license: "MIT"` согласно README проекта; ограниченные `keywords`. Сокращение description — редакционный выбор, не ограничение схемы.
- `skills/aif-analyze/`, `skills/aif-done/`, `skills/aif-mode/` — копируются целиком, включая `references/` и `aif-mode/templates/`; нормализация frontmatter допускается только после проверки ограничений invocation. `skills/shared/` копируется целиком как данные. Источник выбора — manifest allowlist: находящийся в репозитории, но не объявленный `skills/aif-rules-check/` автоматически не включается.
- Справочные зависимости: одного `shared/` недостаточно. Прямые внешние ссылки ведут в `docs/validation-providers.md`, `docs/isolated-execution.md`, `docs/workflow-mechanics.md`. Экспортер должен построить **транзитивное замыкание** локальных ссылок, сохранить относительные пути и записать inventory/digests всех добавленных файлов. Проверка ссылок проводится по готовому output. Неразрешённая ссылка, неподдерживаемый синтаксис или неразобранная инструкция загрузки блокируют готовность; ограничения Markdown-сканера явно перечисляются. Нельзя бесконтрольно копировать весь репозиторий вслед за ссылками.
- `mcp.json` в skills-only кандидате **отсутствует**. Исключение `aifhub` записывается с причиной `requires-project-bound-extension-command`. Нельзя автоматически генерировать host config, absolute workspace `cwd` или надеяться на наследование `AIFHUB_PROJECT_ROOT`. Возврат MCP требует отдельного адаптера/host-контракта и read-only smoke из plugin root, отличного от project root.
- `aifhub.agent_plugins_compatibility_report.v1` (JSON) + человекочитаемый компаньон: решение по каждой неэкспортированной поверхности; отдельные `schema_valid`, `loadable_with_warnings`, `skills_valid`, `references_complete`, `loads`, `workflow_semantics_verified`; `NOT_RUN` не превращается в PASS. Для выполнения workflow указаны AI Factory `>=2.11.0 <3.0.0` в PATH, Node `>=18`, установленное и зарегистрированное расширение AIFHub в выбранном проекте и корректная project binding. Точная испытанная пара 2.19.0/1.7.0 не доказывает весь диапазон. OpenSpec CLI опционален по переключателю инструмента.
- Привязка к ревизии: исходный коммит AIFHub, digests исходного содержимого и проверенная версия AI Factory. Prior art — паттерн workflow-exchange: привязка `source_revision` + digest с деградацией через `exchange_notes` вместо молчаливой потери (`docs/workflow-exchange.md`).

Non-goals: ни команды import/install, ни неограниченного пути в `/aif-analyze`, ни второго release engine, ни записей в managed sources, `.claude`, `.codex`, `.mcp.json`, канонические specs или QA evidence.

## План инспектора и fixtures

Read-only инспектор внешних bundle выдаёт нормализованный манифест плюс предупреждения без запуска MCP-серверов, scripts или hooks, без установки зависимостей и без изменения пользовательской конфигурации. Проверки выполняются до любого чтения, способного выйти за пределы корня пакета: path containment, разрешение symlink/junction и сканирование по паттернам учётных данных (та же дисциплина, что и secret scan в evaluation export).

План матрицы: статические fixtures инспектора и отдельно помеченные live smoke-сценарии. Inspector verdict должен сохранять границы отказа спецификации:

| Fixture | Ожидаемый результат инспектора |
|---|---|
| Валидный минимальный экспорт (happy path) | `format_valid`; нормализованный манифест; ноль фатальных предупреждений |
| `plugin.json` с неизвестным полем верхнего уровня | `schema_valid: false`; поле сообщено + проигнорировано, загрузка остальных валидных данных продолжается |
| `extensions: null`, массив, число или строка | `schema_valid: false`; поле сообщено + проигнорировано, остальные компоненты доступны |
| Неизвестный namespace с произвольным содержимым | содержимое не валидируется клиентом; ошибка strict schema не должна автоматически становиться отказом загрузки |
| `plugin.json` с нарушением схемы (плохой `name`, например `--leading` или верхний регистр) | фатально: плагин отклонён |
| `SKILL.md` с неизвестным полем frontmatter | `skills-ref 0.1.0` отклоняет; допускающий его client parser не отменяет результат strict gate |
| Symlink/`../`-путь, разрешающийся вне корня плагина | отклонён на самом узком уровне (плагин / тип компонента / skill / server entry) |
| Несовпадение версии `$schema` в `mcp.json` с `plugin.json` | MCP отключён с сообщением; skills продолжают загружаться |
| Server entry с определённым `env.PLUGIN_ROOT` или секретоподобным значением `env`/`headers` | невалидная запись / предупреждение о секрете |
| Smoke: неразрешимый bare `command` (отсутствует `ai-factory`) | загружаемый плагин; явная пометка о пререквизите; без предложений auto-install |
| Smoke: CLI есть, AIFHub не зарегистрирован относительно plugin root | `requires-project-bound-extension-command`; наличие CLI не означает успешный MCP handshake |
| Smoke: сервер доступен, но project root не подтверждён | `project-binding-unverified`; никаких write-инструментов и никакого PASS для project-bound MCP |
| Каталог `skills/shared/` без `SKILL.md` | не навык; файлы присутствуют как данные пакета |
| Потерянные `templates/`, прямые или транзитивные справочные файлы | `references_complete: false`; кандидат не готов к экспорту |
| Smoke: кандидат содержит все 3 skills, включая user-invoked-only `aif-mode` | discovery проверяет точный набор; возможность автоматического вызова `aif-mode` блокирует runtime readiness |
| Уходящая наружу цель skill-ссылки | нарушение containment с точным путём к файлу |

Будущие fixtures — статические данные в `test/fixtures/`; инспектор детерминирован и работает офлайн. Привязка к проекту и реальный MCP handshake проверяются **отдельным opt-in smoke**, а не статическим инспектором. До чтения файла инспектор проверяет resolved containment; secret scan выполняется после разрешённого чтения и выводит код/местоположение без исходного секретоподобного значения. Сам отчёт также проходит проверку перед публикацией.

## План клиентского smoke (один клиент, точные версии)

Кандидат — **GitHub Copilot в VS Code**. Публикация в списке клиентов не доказывает поддержку требуемого формата конкретным билдом. До прогона фиксируются версия VS Code, версия Copilot, ОС, способ загрузки root `plugin.json`, версия `skills-ref`, digest пакета и schema snapshots. Если этот билд не поддерживает пакет напрямую, результат `NOT_RUN` с причиной; ручной перевод в native config не считается portable smoke.

1. `format_valid` офлайн (схемы + записанный вывод `skills-ref validate`);
2. `loads`: обнаружены **все три** ожидаемых навыка, shared не обнаружен как четвёртый skill; проверены чтения reference/template и ограничение invocation `aif-mode`. Для skills-only пакета MCP явно `excluded`;
3. `workflow_semantics_verified` явно зафиксирован как **не заявленный**.

После отдельного решения о MCP binding дополнительный smoke покрывает: отсутствующий CLI; установленный CLI без зарегистрированного AIFHub; зарегистрированный AIFHub с неверным root; корректно связанный проект. Последний сценарий требует handshake и read-only запроса к известному файлу fixture-проекта. Одного handshake недостаточно: сервер может подключиться к неправильному корню. Smoke не вызывает `install_skill`, `run_skill_tests` и другие операции с пользовательскими данными. Любые записи служебного ledger допускаются только внутри изолированного fixture-проекта.

Дисциплина live-драйвера совпадает с существующим smoke 2.18/2.19: отсутствующие пререквизиты — `NOT_RUN`, ничего не скачивается, локальный успех не является release-, deployment-, registry- или end-user-доказательством.

## Соответствие инвариантам

- Нет второго канонического хранилища: экспорт — производные, привязанные к ревизии метаданные + копия skills; `/aif-verify` и `/aif-done` остаются единственными gate; артефакты OpenSpec остаются каноническими.
- Упаковка ничего не активирует: переключатели OpenSpec/HLV/Lekalo не затрагиваются; зависимости от Orkora нет; validation providers остаются validation providers.
- Нет auto-register MCP, daemon, глобальной установки или перезаписи host-config: клиент рендерит `mcp.json` по собственным правилам; отсутствие CLI даёт явную ошибку.
- Недоверенный контент: проверки containment/symlink/секретов предшествуют любому чтению или генерации вне корня пакета.
- Неподдерживаемые компоненты перечислены в compatibility-отчёте; ничего обязательного для workflow не теряется молча.

## Запись решения и триггеры пересмотра

Текущее решение по пункту 7 issue — **reference-only**, выпуск отложен. Для skills-only нужны ограниченные portable references и решение конфликта нормализации с invocation control. Прямой MCP-export требует явной project binding; шесть вариантов и их trade-offs разобраны в [follow-up](follow-up.md). Существующий native host MCP config остаётся рабочим направлением, но не переименовывается в portable `mcp.json`. Исследование не обосновывает новый installer или runtime adapter без отдельного дизайна.

- Agent Plugins добавляет тип компонентов commands, injections, agents или rules со стабильным кросс-клиентским контрактом → пересмотреть mapping (сегодня они «явно вне формата v1»).
- Сам AI Factory публикует конформный клиент Agent Plugins или принимает плагины как источник расширений → требуется ADR до любого изменения installer; upstream `extension add/update` остаётся каноническим путём установки до тех пор.
- Orkora #312 нужны дополнительные поля метаданных со стороны AIFHub → расширять схему compatibility-отчёта (`v1` → `v2`), а не release engine.
- Host предоставляет проверяемый project binding, который одновременно сохраняет discovery AIFHub и root каждого MCP tool → рассмотреть отдельный MCP adapter и повторить все негативные сценарии; один ambient env override недостаточен.

Открытые вопросы:

- **A — закрыт для pinned validator.** `skills-ref 0.1.0` отклоняет неизвестные поля. Исходные 3 skills: exit 1; нормализованные: exit 0. Клиентская терпимость не означает переносимость.
- **B.** Спецификация Agent Skills не публикует числовую ревизию на странице; в дескриптор экспорта фиксируются дата выборки + версия валидатора.
- **C.** Где живёт экспортер: `ai-factory aifhub-agent-plugins-export` (extension-команда, версионируемая как её соседи) или repo-локальный генератор в `scripts/` — extension-команда доступна установленным проектам; скрипт не трогает поверхность дистрибуции. Решить в issue реализации после ADR-уровневого ревью этого документа.
- **D — закрыт на уровне pinned parser kernel.** VS Code 1.137.0 читает top-level запрет; при переносе в metadata флаг исчезает. End-to-end применение policy моделью и альтернативный client adapter остаются непроверенными.

## Воспроизводимое evidence и статус issue #200

[Локальная проверка границ экспорта](evidence.md) содержит версии, команды, результат запуска из plugin root, список потерянных ссылок и ограничения проверки. Пробы выполнялись вне репозитория; package/host configuration не изменялись. JSON evidence хранится рядом в [local-probe.json](local-probe.json), без абсолютных пользовательских путей.

[Дополнительное исследование](follow-up.md) закрывает пять согласованных направлений: validator, dependency inventory, schema snapshots, точный клиентский parser kernel и MCP alternatives. Диагностические скрипты работают с доверенными snapshot и scratch-копиями; они не являются готовым exporter/inspector.

| Критерий issue | Статус этой ветки | Что остаётся |
|---|---|---|
| Mapping distribution surfaces | Выполнен на baseline `02d3f68` | Повторять при изменении манифеста |
| Exact spec/schema и tested client versions | Schema bytes/digests, validator SHA, установленный client build и source-kernel probe зафиксированы | Полный client smoke после получения безопасного кандидата |
| Read-only inspection/export fixture | Не реализован | Отдельный локальный генератор/инспектор с output boundary и отрицательными сценариями |
| Positive/negative fixtures | Выполнены локальная MCP-проба, 7 validator-вариантов и client parser probes; матрица внешнего инспектора спроектирована | Реализовать отдельный fixture suite для публичного инспектора, если направление возобновится |
| Minimal subset smoke или обоснование нецелесообразности | Обоснование reference-only подкреплено нормализацией, inventory и kernel evidence | Runtime smoke текущего небезопасного кандидата не проводится; полный `loads` NOT_RUN |
| Сохранение canonical artifacts и install/update flow | Сохранено: в ветке нет runtime/installer изменений | Сохранить этот инвариант в реализации |

Issue #200 **не закрывается** этим исследованием. Полный набор тестов baseline прошёл (1507 tests / 180 suites, Node 24.13.0), но он не содержит ещё не реализованный plugin exporter и не доказывает его conformance.
