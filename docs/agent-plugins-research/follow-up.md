[К исследованию](README.md)

# Проверка жизнеспособности экспорта: пять вопросов

Проверено 2026-09-15 на AIFHub `02d3f68538abc9ac1712e3396eb69eca74f9e830`.
Исходники взяты через `git archive` этого commit, поэтому локальные дополнения исследования не расширяют dependency graph.
Версии, digests исходников валидатора и установленного desktop bundle: [research-provenance.json](research-provenance.json).

**Решение: reference-only для текущего содержимого AIFHub; выпуск export subset отложен.** Простая нормализация проходит выбранный validator, но теряет ограничение invocation. Замыкание всех справочных ссылок переносит значительную часть репозитория, включая runtime-файлы. Для жизнеспособного пакета нужны отдельные portable skills с ограниченными справочниками либо доказанный клиентский adapter; это уже изменение продукта, выходящее за рамки данного исследования.

## 1. Frontmatter: открытый вопрос A закрыт для точного валидатора

Использован официальный [skills-ref](https://github.com/agentskills/agentskills/tree/69ef37e9424c0a7ea9dd2293b559e43ec8176379/skills-ref) `0.1.0`, commit `69ef37e9424c0a7ea9dd2293b559e43ec8176379`, Python `3.12.11`, StrictYAML `1.7.3`. Среда создана во временном каталоге через `uv sync --frozen --no-dev`; исходный `uv.lock` не изменялся.

| Навык | Исходный frontmatter | Нормализованный frontmatter | Что теряется |
|---|---|---|---|
| `aif-analyze` | exit 1: `author`, `version` | exit 0 | Информационные поля перенесены в metadata |
| `aif-done` | exit 1: `argument-hint`, `author`, `version` | exit 0 | `argument-hint` больше не UI-поле |
| `aif-mode` | exit 1: `argument-hint`, `disable-model-invocation` | exit 0 | Пропадает машинный запрет автоматического invocation |
| `aif-mode`, нормализация с сохранённым top-level `disable-model-invocation` | exit 1: `disable-model-invocation` | Не проходит выбранный strict gate | Клиентский parser сохраняет запрет — см. раздел 4 |

Нормализация выполнена **только в scratch-копиях**: поля вне allowlist перенесены в строковые `metadata.aifhub.source.*`, существующие metadata сохранены, коллизии запрещены. Тело инструкции сохранено. Запущены и CLI `validate`, и Python API `validate`; результаты согласованы: [frontmatter-results.json](frontmatter-results.json). Digest каждого варианта включён в evidence.

Нельзя обобщать эти результаты до всех клиентов или до полной conformance Agent Skills. Upstream README обозначает `skills-ref` как демонстрационную библиотеку. Проверенный validator не является проверкой целостности справочников, исполнения тела или сохранения invocation policy. Его PASS — один отдельный gate.

## 2. Состав пакета: полный граф статических Markdown-ссылок

Исходный allowlist: три manifest skills целиком и `skills/shared/`, включая templates, JSON/YAML references. Всего **29 файлов**.

Разобраны CommonMark inline/reference links и изображения библиотекой `markdown-it-py 4.0.0`; цели разрешены относительно исходного файла. Файловые ссылки обходились транзитивно до неподвижной точки. Полный inventory, размеры, SHA-256, рёбра и дополнительные path tokens: [dependency-inventory.json](dependency-inventory.json).

| Категория | Файлов в замыкании |
|---|---:|
| `skills` | 29 |
| `docs` | 112 |
| `schemas` | 15 |
| `scripts` | 13 |
| `injections` | 7 |
| `agent-files` | 6 |
| `test` | 4 |
| `commands` | 1 |
| Корневой README | 1 |
| **Всего** | **188 / 4 516 056 bytes** |

Потерянных файловых целей в исходном snapshot не обнаружено. Рост происходит через общие руководства и навигационные ссылки на docs index и корневой README. Поэтому включение трёх ранее найденных документов не замыкает пакет: автоматическое копирование по ссылкам захватывает справочные исследования и поверхности, которые план экспорта исключает.

Дополнительно в prose/code обнаружены **67 существующих repository files вне этого замыкания**. Среди них `scripts/active-change-resolver.mjs`, `scripts/ai-factory-version-resolver.mjs`, тесты и дормантные handoff-файлы. Это кандидаты зависимостей, а не требование копировать каждый упомянутый файл. `path_tokens` сохраняет исходный документ и классификацию каждого совпадения, включая unresolved/example paths.

### Практический вывод

- **Автоматический copy closure непригоден как минимальный экспорт.** Вместе со справочниками он начинает переносить code/agents/injections, не становясь полноценным runtime-дистрибутивом.
- Для будущего кандидата нужен явный редакционный allowlist portable references. Навигационные ссылки следует преобразовывать в привязанные к commit upstream URLs; реально исполняемые инструкции должны иметь включённую зависимость или явный prerequisite установленного расширения.
- Отдельно разобрать динамические project/host paths, команды и импорты исполняемых модулей. Простая строка `scripts/x.mjs` не доказывает, что файл должен жить в plugin root.
- Не включать `aif-rules-check` лишь потому, что он обнаружен в исходном репозитории: manifest allowlist содержит три других skill.

Это **полное замыкание поддерживаемых статических Markdown-ссылок**, а не обещание полного runtime dependency graph. Anchors не проверялись; directory links не разворачиваются рекурсивно; prose paths классифицируются эвристически; динамические пути и code imports остаются за границей. Эти ограничения отражены в JSON.

## 3. Зафиксированные схемы Agent Plugins 1.0.0

Сохранены точные HTTP response bytes официальных схем; время получения и источники: [snapshots/sources.json](snapshots/sources.json).

| Схема | Размер | SHA-256 |
|---|---:|---|
| [plugin.schema.json](snapshots/plugin.schema.json) | 1805 | `0a4aad95ce337878ad38802ebf0daa3fde76abe3f65400c86bcbb1ec0b3ab883` |
| [mcp.schema.json](snapshots/mcp.schema.json) | 3408 | `6539175bfcdf43085855183e86da40ea94b166547a72b47ae9a0a390516d3acb` |

Официальные идентификаторы: `https://agent-plugins.org/schemas/1.0.0/plugin.schema.json` и `https://agent-plugins.org/schemas/1.0.0/mcp.schema.json`. JSON синтаксически разобран при сохранении; хеши перепроверены по локальным файлам. Сами схемы не изменены.

Schema snapshots не заменяют нормативную семантику загрузки. Например, `extensions: null` и неизвестные top-level поля нарушают strict schema, но по §5.2/§8.1 клиент должен продолжить загрузку после игнорирования этих данных. Будущий инспектор обязан хранить оба результата отдельно.

## 4. Конкретный клиент: установленная версия и parser kernel

Установлен **VS Code 1.137.0**, commit `645f29cc3176500b4b5762ba887cf2a7f0ffdf2c`; встроенный **GitHub Copilot 0.65.0**. Commit из metadata встроенного Copilot — `94c8e2adc50e26ef70af85a0de3a9efed757acaa`, он не подменяет commit VS Code core. SHA-256 desktop bundle и признаки наличия строк schema/invocation записаны в provenance; одни эти строки не доказывают поведение.

Из [точных исходников VS Code](https://github.com/microsoft/vscode/tree/645f29cc3176500b4b5762ba887cf2a7f0ffdf2c) проверены:

- `src/vs/platform/agentPlugins/common/agentPluginParser.ts`: чтение root manifest;
- `src/vs/platform/agentPlugins/common/pluginParsers.ts`: выбор Agent Plugin format, fixed skills directory, read-only discovery и invocation flags;
- `src/vs/base/common/yaml.ts`: фактический frontend parser;
- `src/vs/workbench/contrib/chat/common/plugins/agentPluginServiceImpl.ts`: вызов общих parser/discovery helpers в клиентском сервисе.

Выполнена **проба выбранных source kernels** на Node 24.13.0. Функции парсинга и discovery не переписаны: они извлечены из pinned source и преобразованы через `stripTypeScriptTypes`. Filesystem adapter использует реальные scratch-файлы; URI/path операции заменены локальными path helpers, локализация ошибок — identity formatter. Для валидных JSON fixtures JSONC parser заменён `JSON.parse`. Поэтому результаты ограничены этими inputs; это не запуск всего VS Code.

| Input | Root manifest | Discovery | `aif-mode.disableModelInvocation` |
|---|---|---|---|
| Исходные 3 skills + shared | Распознан | Ровно 3 skills; shared пропущен | `true` |
| Нормализованные 3 skills + shared | Распознан | Ровно 3 skills; shared пропущен | Отсутствует |
| Нормализованный `aif-mode` с возвращённым top-level полем | Отдельная parser-проба | `aif-mode` | `true` |

Доказательство: [client-kernel-results.json](client-kernel-results.json). Parser читает `disable-model-invocation` из frontmatter верхнего уровня; одноимённая строка внутри metadata не становится invocation flag. Это закрывает вопрос D **на уровне точного parser kernel** и доказывает потерю поведения выбранной нормализации. Политика агента во время реального модельного запроса отдельно не проверялась.

**Full client `loads`: NOT_RUN.** Кандидат не допущен к runtime smoke: исходный вариант не проходит выбранный strict validator, нормализованный теряет ограничение invocation. Пользовательский профиль, auth, workspace settings и plugin registrations не изменялись; модельные запросы не отправлялись. Проба не утверждает, что установленный клиент не поддерживает Agent Plugins: source path поддержки найден, но безопасный кандидат для end-to-end smoke ещё не получен. Текущая [официальная документация VS Code](https://code.visualstudio.com/docs/agent-customization/agent-plugins) использована как навигация; выводы о конкретной версии основаны на pinned source и результатах пробы.

## 5. Варианты MCP project binding

Два независимых требования AIFHub: AI Factory должен обнаружить зарегистрированную extension-команду **до** её вызова; сервер должен использовать выбранный project root во всех tools. [Исходная негативная проба](evidence.md) показывает, что один CLI в PATH не решает discovery. По [Agent Plugins §7.2.1](https://agent-plugins.org/specification#stdio) default cwd — plugin root, переносимого workspace placeholder нет.

| Вариант | Что решает | Изменения и ограничения | Решение |
|---|---|---|---|
| Канонический AI Factory install + native host MCP config, запускающий CLI из project root | Discovery и root при корректной host-настройке | Host-specific конфигурация; не выдавать за portable `mcp.json` | Сохранять существующий путь; отдельный формат экспорта не нужен для этого сценария |
| Только `env.AIFHUB_PROJECT_ROOT` | Root сервера, если команда уже доступна | Loader по-прежнему использует startup cwd; наследование ambient env не гарантировано | Недостаточно |
| `cwd: ${PLUGIN_DATA}` или `${PLUGIN_ROOT}` | Соответствует допустимым корням формата | Эти каталоги не являются пользовательским проектом и не содержат его extension registration | Не решает binding |
| Package-local shim: получает явный project path, проверяет регистрацию и запускает CLI с нужным cwd | Может решить оба требования | Нужны host/user-owned способ выбора проекта, fail-closed preflight и изолированный runtime smoke; это новый исполняемый adapter | Только отдельная задача после решения о контракте; сейчас не реализовывать |
| Прямой запуск bundled `aifhub-mcp-server.mjs` | Обходит discovery extension-команды | Требует поставки серверного кода и всех импортов, явного project root, version/update и provider prerequisites; значительно расширяет пакет | Отдельный runtime distribution design, не минимальный skills export |
| Remote MCP endpoint | Убирает локальный CLI discovery у клиента | Новые authentication, deployment, project access и lifecycle обязательства | Вне текущего scope; daemon/service не добавляется |

Абсолютный workspace `cwd` в native host settings и в portable `mcp.json` — разные контракты. Нельзя использовать допустимость первого как обоснование conformance второго. Не предлагать symlink из plugin root наружу как обход containment. Для multi-root workspace любой будущий adapter должен явно выбрать один root и исключить переключение проекта через tool arguments без отдельной авторизации.

## Воспроизведение и проверки

Все три диагностических скрипта находятся в [probes/frontmatter.py](probes/frontmatter.py), [probes/dependencies.py](probes/dependencies.py), [probes/client-kernel.mjs](probes/client-kernel.mjs). Это исследовательские probes для доверенных исходников, **не публичный exporter/inspector**.

1. Создать временный рабочий каталог. Получить `git archive 02d3f68538abc9ac1712e3396eb69eca74f9e830`, распаковать в `baseline` вне репозитория.
2. Получить `agentskills/agentskills` на commit `69ef37e9424c0a7ea9dd2293b559e43ec8176379`. В его `skills-ref` выполнить `uv sync --frozen --no-dev --python 3.12`; Python этого venv используется далее. Для dependency probe установить в этот же временный venv `markdown-it-py==4.0.0` (транзитивно `mdurl==0.1.2`). Версии и хеш исходного lock сохранены в provenance.
3. Запустить `python -X utf8 frontmatter.py BASELINE NEW_CANDIDATES_DIR`; сохранить stdout. Затем `python -X utf8 dependencies.py BASELINE`. Скрипты выполняются из произвольного cwd, paths задаются явно.
4. Скачать из raw GitHub по точному VS Code commit три файла `yaml.ts`, `agentPluginParser.ts`, `pluginParsers.ts` по путям из раздела 4 в отдельный source directory. **До выполнения** сравнить SHA-256 с `client-kernel-results.json`.
5. Запустить `node client-kernel.mjs PINNED_SOURCE_DIR CANDIDATES_DIR BASELINE NEW_CLIENT_SCRATCH`. Сопоставить rows и source hashes с evidence. Ожидаемый experimental warning Node относится к TypeScript transform, не к результату discovery.
6. Получить две schema URL как bytes и сравнить SHA-256 с snapshot; изменение bytes под тем же canonical identifier требует остановки повторной проверки и выяснения причины.

Ни один probe не устанавливает расширение AIFHub, не меняет host profile, не создаёт canonical OpenSpec/QA artifacts и не запускает MCP service. Единственный CLI-запуск MCP из предыдущего evidence заканчивается ошибкой discovery до старта сервера. Негативные результаты сохраняются как негативные; PASS validator/kernel не превращается в подтверждённый `loads` или `workflow_semantics_verified`.
