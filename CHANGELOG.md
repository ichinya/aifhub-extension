# История изменений

Все заметные изменения этого проекта фиксируются в этом файле.

Формат основан на [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [В разработке]

### Изменено
- `extension.json` теперь указывает на upstream JSON Schema `https://raw.githubusercontent.com/lee-to/ai-factory/2.x/schemas/extension.schema.json` и больше не содержит private AIFHub поля.
- AIFHub metadata `compat` и `sources` вынесены в `aifhub-extension.json` с локальной схемой `schemas/aifhub-extension.schema.json`.
- `npm run validate` теперь проверяет split contract: upstream manifest, AIFHub metadata, bundled agent files и docs links.
- `skills/aif-rules-check` remains a compatibility fallback while `compat.ai-factory` includes `2.10.0`; AIFHub also adds `injections/core/aif-rules-check-openspec-generated-rules.md` for upstream/fallback command augmentation after upstream AI Factory PR #90.

## [0.10.0] - 2026-04-20

### Изменено
- Manifest extension перепроверен против upstream `ai-factory 2.10.0`, а `compat.ai-factory` поднят до `>=2.10.0 <3.0.0`
- Обновлены метаданные `sources.ai-factory`, чтобы явно различать проверенный upstream `2.10.0` и исторический `baselineVersion`
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
