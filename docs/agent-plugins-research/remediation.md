[К исследованию](README.md)

# Исправленный профиль: два навыка и отдельный host-bound MCP

Проверено 2026-09-18. Это исправление дизайна с исполняемым исследовательским прототипом. Production exporter, installer и настройки пользовательского host не изменены.

Исходная попытка экспортировать три навыка и MCP одной переносимой записью заменена двумя явно разделёнными контрактами:

1. **Строгий subset**: `aif-analyze`, `aif-done`, их references и shared. Поля `author`/`version`/`argument-hint` преобразуются в строковые metadata; потеря UI hint указана явно.
2. **Установленный AIFHub**: `aif-mode` сохраняет исходное `disable-model-invocation: true` и ручной запуск. MCP запускается native host-конфигурацией из выбранного проекта с согласованным root override. Эти поверхности не заявлены как переносимые компоненты пакета.

Это ограниченное исправление предлагаемого экспорта: исключённые функции продолжают принадлежать канонической установке. Полный трёхкомпонентный skills-пакет со всеми прежними гарантиями не объявляется реализованным.

## 1. Ограничение invocation сохранено

`aif-mode` **не создаётся** в `skills/` нового subset. Его исходный файл и флаг не редактируются. Поэтому исправление не превращает ручной навык в автоматически загружаемый и не выдаёт строку metadata за работающий контроль.

Оба включённых навыка прошли `skills-ref 0.1.0` на прежнем pinned commit, Python 3.12.11. В тело каждого добавлен обязательный preflight: выбранный project root, зарегистрированный AIFHub 1.7.0, разрешение runtime helpers относительно установленного расширения; при отсутствии prerequisites — остановка без auto-install. Прежнее тело навыка сохранено после preflight.

Exclusion `aif-mode` и его причина записаны в generated `compatibility-report.json`, а не скрыты за общей формулировкой «все навыки совместимы». Это профиль для уже установленного AIFHub, а не самостоятельная замена workflow.

## 2. Справочники больше не затягивают репозиторий

В пакет входят только allowlist-каталоги двух навыков и shared. Две ссылки из shared на общие руководства заменены на URL с точным source commit `02d3f68538abc9ac1712e3396eb69eca74f9e830`:

| Источник | Руководство |
|---|---|
| `skills/shared/ISOLATED-EXECUTION.md` | `docs/isolated-execution.md` |
| `skills/shared/TASK-COORDINATION.md` | `docs/workflow-mechanics.md` |

Для offline-работы тот же документ читается из `.ai-factory/extensions/aifhub-extension/` выбранного проекта. Пакет требует matching installation; если ни установленный справочник, ни pinned источник недоступны, workflow должен остановиться. Внешние ссылки не считаются локально включёнными зависимостями.

CommonMark-проверка нового output: **24 исходных data/skill файла → 24 файла замыкания, 0 потерянных локальных целей**. Полный prototype bundle вместе с manifest, README и compatibility report: **27 файлов / 185 344 bytes**. Для сравнения, прежняя слепая обработка трёх навыков включала 188 файлов / 4 516 056 bytes по цепочкам ссылок.

Пути в prose и runtime-команды остаются dependencies установленного расширения. Их не объявляем включёнными в bundle. Полный offline workflow без канонической установки не поддерживается этим профилем.

## 3. MCP: согласовать discovery и root

Используется native host configuration, отдельно от portable `mcp.json`. Она должна задавать:

- `command: ai-factory`, `args: [aifhub-mcp]`;
- `cwd`: явно выбранный проект с зарегистрированным AIFHub;
- `env.AIFHUB_PROJECT_ROOT`: тот же абсолютный project root, чтобы старый ambient override не направил tools в другой проект.

Пример **native VS Code config**, который пользователь адаптирует к своему выбранному проекту; исследование этот файл не устанавливает:

```json
{
  "servers": {
    "aifhub": {
      "type": "stdio",
      "command": "ai-factory",
      "args": ["aifhub-mcp"],
      "cwd": "C:/projects/selected-project",
      "env": { "AIFHUB_PROJECT_ROOT": "C:/projects/selected-project" }
    }
  }
}
```

Это host-specific `servers` configuration по [документации VS Code](https://code.visualstudio.com/docs/agents/reference/mcp-configuration), не portable `mcpServers` declaration. Absolute project `cwd` не записывается в переносимый manifest. Изменения upstream loader или новый shim не нужны для **этого host-bound сценария**.

### Проверенные сценарии

Созданы два отдельных scratch-проекта с канонической layout расширения и минимальной registration config; использован установленный AI Factory 2.19.0 и AIFHub snapshot 1.7.0. В обоих проектах есть `binding-probe.txt` с разным содержимым. Проверялись реальный MCP handshake и чтение этого файла; subprocess запускался напрямую, не через UI VS Code.

| Запуск | Результат |
|---|---|
| Из plugin root, без binding | exit 1, команда не найдена |
| Из plugin root, только env указывает на проект | exit 1, команда не найдена |
| Из выбранного проекта, env override отсутствует | handshake, прочитан `selected-project` |
| Из выбранного проекта, stale env указывает на другой | handshake, прочитан `other-project`: негативный контроль, доказывающий недостаточность одного handshake |
| Явные `cwd` и `env` указывают на выбранный проект | handshake, прочитан `selected-project` |

Fixture setup копирует extension в scratch; он не проверяет production installer и не изменяет пользовательские проекты. Read-tool может иметь служебное состояние, но только внутри fixture project. Негативный сценарий с другим root не считается корректной конфигурацией; он обосновывает явное согласование обоих значений.

## Evidence и воспроизведение

- [remediation-results.json](remediation-results.json): validator exits, normalizations, exclusions, link rewrites, пять MCP scenarios и inventory с SHA-256.
- [remediation-dependencies.json](remediation-dependencies.json): повторная CommonMark-проверка готового output, включая ограничения path scanner.
- [remediation-verification.json](remediation-verification.json): проверка `plugin.json` сохранённой официальной schema и хешей всех 27 файлов. Использован `jsonschema 4.25.1`; дополнительные Python packages установлены только в временный venv.
- [probes/remediation.mjs](probes/remediation.mjs): воспроизводимая диагностическая сборка и runtime-пробы. Весь output создаётся в новом OS temp directory; путь печатается в stderr, JSON — в stdout.
- [probes/verify-remediation.py](probes/verify-remediation.py): повторная read-only проверка схемы, точного состава, размеров и SHA-256 файлов относительно результата сборки. Лишний файл также считается ошибкой.
- [probes/verify-remediation.test.py](probes/verify-remediation.test.py): положительная проверка и три негативных контроля в новых временных копиях: изменение байта без изменения размера, лишний и отсутствующий файл.

Подготовка baseline и pinned Python описана в [предыдущем исследовании](follow-up.md). Воспроизведение:

```text
node docs/agent-plugins-research/probes/remediation.mjs BASELINE AI_FACTORY_ENTRY PINNED_PYTHON > RESULTS_JSON
PINNED_PYTHON -X utf8 docs/agent-plugins-research/probes/dependencies.py SCRATCH/portable-subset
PINNED_PYTHON -X utf8 docs/agent-plugins-research/probes/verify-remediation.py SCRATCH/portable-subset RESULTS_JSON
PINNED_PYTHON -X utf8 docs/agent-plugins-research/probes/verify-remediation.test.py SCRATCH/portable-subset RESULTS_JSON
```

`BASELINE` — доверенный archive commit `02d3f68538abc9ac1712e3396eb69eca74f9e830`; `AI_FACTORY_ENTRY` — установленный `ai-factory@2.19.0/bin/ai-factory.js`; `PINNED_PYTHON` — Python venv с проверенным `skills-ref`. Скрипт не скачивает инструменты, не регистрирует host MCP и не является безопасным инспектором произвольного внешнего bundle.

Команды приведены от корня репозитория; placeholders заменяются локальными путями. Для verifier в том же временном venv требуется `jsonschema==4.25.1`. `RESULTS_JSON` — stdout именно текущей сборки, `SCRATCH` — каталог из её stderr. В Windows PowerShell 5.1 сохраняйте stdout как UTF-8, поскольку обычное `>` использует UTF-16. Проверка хешей устанавливает соответствие bundle этому JSON, но не подтверждает происхождение baseline: доверенный archive подготавливается отдельно.

MCP-проба требует exit 1 и диагностику unknown command для обоих незарегистрированных запусков; для всех трёх зарегистрированных запусков — exit 0, handshake без JSON-RPC/tool errors и ожидаемое содержимое файла. Между initialize и tools/call передаётся `notifications/initialized`. Это subprocess-проба текущего сервера, а не универсальный MCP client.

## Статус после исправления

| Граница | Результат |
|---|---|
| Strict validator для двух включённых skills | PASS |
| `plugin.json` по snapshot schema 1.0.0 | PASS |
| Все локальные Markdown file links subset | PASS в пределах CommonMark-сканера |
| Сохранение manual-only `aif-mode` | Исходный skill не изменён; исключён из portable discovery |
| Host-bound MCP startup и выбранный project root | PASS на реальном CLI в scratch fixtures |
| Full client `loads` / модельное применение инструкций | NOT_RUN |
| Полный workflow, готовый публичный exporter/inspector | Не реализованы этим исследованием |

Исходные ограничения прямого экспорта остаются исторически верными; теперь есть положительно проверенный **ограниченный профиль**, с явными prerequisites и exclusions. Для публикации продукта всё ещё нужны полноценная реализация output safety/inspector и client smoke. Issue #200 автоматически не закрывается.
