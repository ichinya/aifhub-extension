[К документации](../README.md)

# Исследование совместимости с Agent Plugins 1.0 — issue #200

Решение: **export subset через опциональный производный read-only экспортер**. Agent Plugins 1.0.0 способен представить только минимальное подмножество AIFHub (3 skills + 1 stdio MCP-сервер); все поверхности, несущие workflow (22 extension-команды, 13 манифестных injections, 18 managed agent files, config defaults, validation providers), требуют extension-загрузчик AI Factory и остаются за пределами переносимого формата. Выход P0 — настоящее исследование совместимости плюс план fixtures для локального генератора/валидатора, а не ещё один installer. Host adapter для v1 **не нужен**; триггеры пересмотра зафиксированы ниже. Исследование не добавляет runtime-поведения, пути установки, MCP-регистрации или изменений жизненного цикла AIFHub.

Orkora [#312](https://github.com/ichinya/orkora/issues/312) владеет orchestration-side композицией пакетов, релизами и grants. Этот документ владеет только границей совместимости/дистрибуции AIFHub; стороны обмениваются версионированными манифестами и evidence и никогда не дублируют release engine.

## Источники и зафиксированные ревизии

Проверено 2026-09-12 (issue) и перепроверено 2026-09-13 (настоящее исследование):

| Поверхность | Зафиксированная идентичность |
|---|---|
| Спецификация Agent Plugins | [1.0.0](https://agent-plugins.org/specification), статус: Published; канонические схемы `https://agent-plugins.org/schemas/1.0.0/plugin.schema.json` и `https://agent-plugins.org/schemas/1.0.0/mcp.schema.json` |
| Спецификация Agent Skills | [agentskills.io/specification](https://agentskills.io/specification); поля frontmatter `name`/`description` (обязательные), `license`/`compatibility`/`metadata`/`allowed-tools` (опциональные); референсный валидатор `skills-ref validate`; числовая ревизия на странице не опубликована — при экспорте фиксируются дата выборки и вывод валидатора (открытый вопрос A) |
| Опубликованные совместимые клиенты | [agent-plugins.org/compatible-clients](https://agent-plugins.org/compatible-clients) на 2026-09-13: VS Code, Cursor, GitHub Copilot, ChatGPT & Codex, Kiro, Hermes Agent, OpenClaw, Grok Bot, NanoClaw |
| Проверенный baseline AI Factory | `2.19.0` — тег `v2.19.0`, коммит `e144f95c89de0d0cb6c9b38dbe8c2907b00dc5ce`, npm `ai-factory@2.19.0` (опубликован 2026-09-10); поддерживаемый диапазон `>=2.11.0 <3.0.0`; Node `>=18` |
| Baseline исследования AIFHub | worktree `research-agent-plugins-1.0-compatibility-export` на `b640911` (`chore(release): prepare v1.7.0`) |
| Практический референс упаковки | анонс Google Cloud Developer Plugin (2026-09-10) и [google/skills](https://github.com/google/skills); репозиторий — маркетплейс плагинов в стиле Claude Code (`marketplace.json`, `plugins/cloud/`), то есть клиент-специфичная дистрибуция, тогда как agent-plugins.org — vendor-neutral формат. Учитывается как prior art; нормативная цель экспорта — Agent Plugins 1.0.0 |

Спецификация Agent Plugins — независимый формат. Она не стандартизует extension/injection/runtime-семантику AI Factory и сознательно исключает из v1 команды, hooks, агентов, rules и LSP-серверы («слишком клиент-специфичные для стабильного переносимого контракта»).

## Что нормативно даёт Agent Plugins 1.0

Приведённые ниже ограничения определяют mapping и план fixtures:

- Плагин — это каталог с закрытым манифестом `plugin.json` в корне. Разрешённые поля верхнего уровня: `$schema`, `name`, `version`, `description`, `author`, `homepage`, `repository`, `license`, `keywords`, `extensions`. Неизвестные поля верхнего уровня сообщаются и игнорируются; любое другое нарушение схемы фатально для плагина.
- `name` должен удовлетворять ограничениям: `1-64` символа, `a-z0-9-.`, начало/конец алфанумерические, без `--`/`..`. `aifhub-extension` — валидное имя плагина.
- Ровно два типа компонентов: skills, обнаруживаемые в фиксированном месте `skills/<dir>/SKILL.md` (без рекурсивного поиска; каталоги без `SKILL.md` навыками не являются), и MCP-серверы из `mcp.json` в корне плагина. Оба фиксированных места могут отсутствовать без ошибки; присутствующее место неверного типа помечает этот тип компонентов недействительным, загрузка продолжается.
- Skills обязаны соответствовать спецификации Agent Skills; несоответствующий навык пропускается с сообщением и не фатален для плагина.
- `mcp.json` поддерживает закрытое объединение вариантов `stdio`, `streamable-http` и legacy `sse`. `command` — один исполняемый токен (bare-имя или plugin-relative `./`-путь); без placeholder-подстановки в `command`, `url` и заголовках; `${PLUGIN_ROOT}`/`${PLUGIN_DATA}` подставляются только в `args`, `env` и `cwd`. Клиент внедряет обе переменные в окружение subprocess; сконфигурированные записи `env` не вправе их переопределять. Заголовки и значения env — видимые данные пакета, а не переносимый механизм секретов; v1 не определяет OAuth и полей ссылок на учётные данные.
- Версия `$schema` в `mcp.json` обязана совпадать с `plugin.json`; несовпадение отключает MCP для плагина, остальные компоненты продолжают загружаться.
- Path containment (§4.1 спецификации): любой путь, поставляемый плагином, обязан разрешаться внутри filesystem-resolved корня плагина; symlink/junction могут разрешаться внутри корня, выходящие пути отклоняются на самом узком применимом уровне.
- Клиент-специфичные данные живут под reverse-domain namespace (`extensions` в манифесте и/или namespace-каталоги верхнего уровня). Клиенты игнорируют чужие namespace, не валидируя их содержимое.
- Инкрементальное принятие и нефатальные отказы компонентов: клиенты обязаны игнорировать неподдерживаемые типы компонентов, продолжать после отдельных отказов серверов/соединений и должны сообщать о каждом пропуске.

## Mapping поверхностей дистрибуции AIFHub

Количества — из `extension.json` на baseline исследования:

| Поверхность | Кол-во | Решение | Основание |
|---|---|---|---|
| `skills` (`aif-analyze`, `aif-done`, `aif-mode`) | 3 | **portable** (уровень формата) / **requires AI Factory** (уровень семантики) | Фиксированное место `skills/*/SKILL.md` совпадает с discovery; имена валидны. Frontmatter несёт поля вне списка Agent Skills (см. ниже), а тела навыков управляют `ai-factory` CLI и командами `/aif-*`, поэтому семантика workflow переносимой не становится |
| `skills/shared/` (TOOLS.md и 13 общих references) | 14 файлов | **portable** только как данные пакета | Каталог без `SKILL.md` внутри `skills/` навыком не является; клиенты его игнорируют, а тела навыков продолжают читать `../shared/...` внутри корня плагина |
| `mcpServers` (шаблон `aifhub`) | 1 | **portable** (stdio) с жёстким CLI-пререквизитом | Шаблон `{command: "ai-factory", args: ["aifhub-mcp"]}` отображается 1:1 в stdio-запись: bare-токен + args, без env/cwd, без секретов. Отсутствие `ai-factory` в PATH — сообщаемый отказ соединения по §7.2.2 — ровно та граница «понятной ошибки пререквизита без скрытого auto-install», которую требует issue |
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

`allowed-tools` определён спецификацией (experimental); имена инструментов остаются клиент-специфичными, а записи `Bash(ai-factory ...)` бессмысленны без CLI. `metadata` принимает произвольные map string→string, поэтому консервативный экспорт может нормализовать `version`/`author`/`argument-hint`/`disable-model-invocation` в `metadata` (или под namespace-префиксом) вместо опоры на терпимость к неизвестным полям. Пропускаются ли неизвестные поля frontmatter или фатальны в валидации `skills-ref` — открытый вопрос (A); экспортер не должен угадывать — он валидирует и сообщает.

## Уровни совместимости

Три различных уровня в соответствии с пунктом 6 issue; экспорт может претендовать только на первые два:

1. `format_valid` — `plugin.json` и `mcp.json` проходят зафиксированные схемы 1.0.0; skills проходят валидацию Agent Skills; path containment выполняется.
2. `loads` — зафиксированный конформный клиент обнаруживает skills и пытается MCP-соединение. MCP-сервер не может подключиться при отсутствии `ai-factory` — ожидаемое, сообщаемое, нефатальное деградировавшее состояние.
3. `workflow_semantics_verified` — полный workflow AIFHub (injections, extension-команды, managed files, validation gates). **Недостижим без AI Factory.** Любой экспорт или consumer, претендующий на этот уровень для переносимого подмножества, неверен по определению, и compatibility-отчёт обязан говорить это явно.

## План минимального экспорта

Опциональный производный экспортер (новая extension-команда или генератор в `scripts/`, решается на этапе реализации) пишет только в выбранный пользователем output directory:

- `plugin.json` — `$schema` зафиксирован на каноническом идентификаторе 1.0.0; `name: "aifhub-extension"`; `version` зеркалируется из `extension.json` (1.7.0 на baseline); короткое описание (текущее описание upstream-манифеста слишком длинно для назначения поля); `repository`; `license: "MIT"`; ограниченные `keywords`.
- `skills/aif-analyze/`, `skills/aif-done/`, `skills/aif-mode/` — копируются с нормализованным frontmatter и своими `references/`; `skills/shared/` копируется как данные пакета, чтобы чтения `../shared/...` продолжали работать.
- `mcp.json` — `$schema` 1.0.0 + stdio-запись `mcpServers.aifhub` (`command: "ai-factory"`, `args: ["aifhub-mcp"]`); без env, без cwd, без секретов.
- `aifhub.agent_plugins_compatibility_report.v1` (JSON) + человекочитаемый компаньон: решение по каждой неэкспортированной поверхности с причиной, достигнутый уровень совместимости и явные пререквизиты (`ai-factory >=2.11.0 <3.0.0` в PATH, Node `>=18`; OpenSpec CLI опционален, как upstream).
- Привязка к ревизии: исходный коммит AIFHub, digests исходного содержимого и проверенная версия AI Factory. Prior art — паттерн workflow-exchange: привязка `source_revision` + digest с деградацией через `exchange_notes` вместо молчаливой потери (`docs/workflow-exchange.md`).

Non-goals: ни команды import/install, ни неограниченного пути в `/aif-analyze`, ни второго release engine, ни записей в managed sources, `.claude`, `.codex`, `.mcp.json`, канонические specs или QA evidence.

## План инспектора и fixtures

Read-only инспектор внешних bundle выдаёт нормализованный манифест плюс предупреждения без запуска MCP-серверов, scripts или hooks, без установки зависимостей и без изменения пользовательской конфигурации. Проверки выполняются до любого чтения, способного выйти за пределы корня пакета: path containment, разрешение symlink/junction и сканирование по паттернам учётных данных (та же дисциплина, что и secret scan в evaluation export).

Матрица fixtures (позитивные и негативные), повторяющая собственные границы отказа спецификации:

| Fixture | Ожидаемый результат инспектора |
|---|---|
| Валидный минимальный экспорт (happy path) | `format_valid`; нормализованный манифест; ноль фатальных предупреждений |
| `plugin.json` с неизвестным полем верхнего уровня | сообщено + проигнорировано; плагин остаётся валидным |
| `plugin.json` с нарушением схемы (плохой `name`, например `--leading` или верхний регистр) | фатально: плагин отклонён |
| `SKILL.md` с неизвестным полем frontmatter | вердикт по валидированному поведению `skills-ref` (вопрос A), никогда не молчаливая догадка |
| Symlink/`../`-путь, разрешающийся вне корня плагина | отклонён на самом узком уровне (плагин / тип компонента / skill / server entry) |
| Несовпадение версии `$schema` в `mcp.json` с `plugin.json` | MCP отключён с сообщением; skills продолжают загружаться |
| Server entry с определённым `env.PLUGIN_ROOT` или секретоподобным значением `env`/`headers` | невалидная запись / предупреждение о секрете |
| Неразрешимый bare `command` (отсутствует `ai-factory`) | загружаемый плагин; явная пометка о пререквизите; без предложений auto-install |
| Каталог `skills/shared/` без `SKILL.md` | не навык; файлы присутствуют как данные пакета |
| Уходящая наружу цель skill-ссылки | нарушение containment с точным путём к файлу |

Все fixtures — статические данные в `test/fixtures/`; инспектор детерминирован и работает офлайн.

## План клиентского smoke (один клиент, точные версии)

Выбирается **GitHub Copilot** (или VS Code как эквивалентный fallback) — оба являются опубликованными клиентами с поддержкой Agent Skills + MCP со stdio. Smoke прогоняет минимальный экспорт на одном зафиксированном билде клиента, записывает точные версии и проверяет только:

1. `format_valid` офлайн (схемы + записанный вывод `skills-ref validate`);
2. `loads`: оба навыка обнаружены, MCP-запись опробована, отказ соединения сообщается (не молча) при отсутствии `ai-factory` и отсутствует при его наличии;
3. `workflow_semantics_verified` явно зафиксирован как **не заявленный**.

Дисциплина live-драйвера совпадает с существующим smoke 2.18/2.19: отсутствующие пререквизиты — `NOT_RUN`, ничего не скачивается, локальный успех не является release-, deployment-, registry- или end-user-доказательством.

## Соответствие инвариантам

- Нет второго канонического хранилища: экспорт — производные, привязанные к ревизии метаданные + копия skills; `/aif-verify` и `/aif-done` остаются единственными gate; артефакты OpenSpec остаются каноническими.
- Упаковка ничего не активирует: переключатели OpenSpec/HLV/Lekalo не затрагиваются; зависимости от Orkora нет; validation providers остаются validation providers.
- Нет auto-register MCP, daemon, глобальной установки или перезаписи host-config: клиент рендерит `mcp.json` по собственным правилам; отсутствие CLI даёт явную ошибку.
- Недоверенный контент: проверки containment/symlink/секретов предшествуют любому чтению или генерации вне корня пакета.
- Неподдерживаемые компоненты перечислены в compatibility-отчёте; ничего обязательного для workflow не теряется молча.

## Запись решения и триггеры пересмотра

Решение по четырём опциям из пункта 7 issue: **export subset** (рекомендуется), host adapter для v1 **не нужен**, с этими триггерами пересмотра:

- Agent Plugins добавляет тип компонентов commands, injections, agents или rules со стабильным кросс-клиентским контрактом → пересмотреть mapping (сегодня они «явно вне формата v1»).
- Сам AI Factory публикует конформный клиент Agent Plugins или принимает плагины как источник расширений → требуется ADR до любого изменения installer; upstream `extension add/update` остаётся каноническим путём установки до тех пор.
- Orkora #312 нужны дополнительные поля метаданных со стороны AIFHub → расширять схему compatibility-отчёта (`v1` → `v2`), а не release engine.

Открытые вопросы:

- **A.** Терпимость к неизвестным полям frontmatter в `skills-ref validate` и в выпущенных клиентах — проверить эмпирически до выбора между нормализацией и passthrough.
- **B.** Спецификация Agent Skills не публикует числовую ревизию на странице; в дескриптор экспорта фиксируются дата выборки + версия валидатора.
- **C.** Где живёт экспортер: `ai-factory aifhub-agent-plugins-export` (extension-команда, версионируемая как её соседи) или repo-локальный генератор в `scripts/` — extension-команда доступна установленным проектам; скрипт не трогает поверхность дистрибуции. Решить в issue реализации после ADR-уровневого ревью этого документа.
