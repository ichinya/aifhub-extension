[← Previous Page](README.md) · [Back to README](../README.md) · [Next Page →](context-loading-policy.md)

# Usage

## Skills

| Skill | Type | Purpose |
|-------|------|---------|
| `/aif-analyze` | Extension skill | Bootstrap `.ai-factory/config.yaml` and `rules/base.md` |
| `/aif-rules-check` | Extension skill (temporary gate) | Read-only rule compliance check against rules hierarchy |
| `/aif-explore` | Built-in + injection | Explore ideas and persist only `.ai-factory/RESEARCH.md` |
| `/aif-plan` | Built-in + injection | Create the companion plan file + plan folder pair |
| `/aif-improve` | Built-in + injection | Refine both plan layers together before execution |
| `/aif-implement` | Built-in + injection | Execute tasks and own git plus execution metadata |
| `/aif-verify` | Built-in + injection | Verify findings and finalize/archive passing plans unless `--check-only` is used |
| `/aif-fix` | Built-in + injection | Apply fixes for verification findings |
| `/aif-roadmap` | Built-in + injection | Evidence-based maturity audit roadmap |
| `/aif-evolve` | Built-in + injection | Plan-evidence-driven evolution workflow |
| `/aif-done` | Extension skill | Archive verified plan to specs/, draft commit/PR summaries, suggest follow-ups |

## Канонический Public Workflow

```text
aif-explore -> aif-plan -> aif-improve -> aif-implement -> aif-verify -> aif-done [optional]
                                                            \-> aif-fix -> aif-verify -> aif-done [optional]
```

`/aif-analyze` — это bootstrap/setup step перед этим flow. Он подготавливает `.ai-factory/config.yaml` и `rules/base.md`, но не является первым узлом canonical public command sequence.

- Для новой работы используйте `/aif-plan full`. `/aif-new` упоминается только как historical alias; в handoff vocabulary используется отдельное stage name `New`, а не slash command.
- `Explore / New / Apply / Done` — это handoff stage names. Подробности собраны в [Handoff Naming](handoff.md).
- `aif-apply` как delegated wrapper пока отложен по ownership/status contract из [issue #20](https://github.com/ichinya/aifhub-extension/issues/20); current public path использует `/aif-implement`.
- `/aif-done` — AIFHub/Handoff finalizer, работающий после passing verification. Архивирует план, готовит commit/PR drafts и предлагает follow-ups. Не дублирует `/aif-verify`.

## Codex App / CLI Flow

Codex не имеет автоматического переключения режимов из extension prompts. Пользователь управляет режимом вручную.

### Recommended Flow

```text
# 1. Switch to Plan mode (user action)
/plan-mode

# 2. Explore and plan (Plan mode — request_user_input available)
/aif-explore "task description"
/aif-plan full "task description"
/aif-improve

# 3. Exit Plan mode (user action)
exit plan mode

# 4. Implement and verify (Default mode — plain-text questions only)
/aif-implement
/aif-verify
```

### Runtime Notes

- **Plan mode**: `request_user_input` доступен для 1-3 коротких вопросов. Используйте его в planning/refinement стадиях.
- **Default mode**: формы недоступны. Задавайте вопросы как plain text в assistant message. Не используйте `question(...)` или `questionnaire(...)`.
- **Subagent mode**: не задавайте интерактивные вопросы. Фиксируйте assumptions и возвращайте blockers/open questions родителю.
- Подробности по форматам вопросов: [Codex Plan Mode](codex-plan-mode.md).
- Справочник по форматам вопросов для всех runtime: `skills/shared/QUESTION-TOOL.md`.

## Совместимость

- Это руководство рассчитано на `ai-factory >=2.10.0 <3.0.0`.
- Extension хранит `sources.ai-factory.baselineVersion = 2.0.0` только как исторический контекст.
- Runtime-aware Codex `agentFiles` входят в поддерживаемый контракт, начиная с проверенного upstream `2.10.0`.

## Слои Prompt-Инъекций

- `injections/core/` — active `core plan-folder overlay`; только этот слой подключается через `extension.json` и поддерживает canonical public workflow.
- `injections/handoff/` — future stub prompt assets; здесь лежат `aif-review-handoff-gate.md`, `aif-security-checklist-handoff-gate.md`, `aif-rules-check-handoff-gate.md`, `aif-verify-handoff-gate.md`, `aif-fix-handoff-comment.md` и `aif-done-handoff-finalizer.md` как заготовки для отдельного runtime binding, но не как уже подключённый profile. Каждый stub содержит machine-consumable `<!-- gate-summary -->` блок для будущего Handoff parser.
- `injections/references/` — shared root-level references для verify/roadmap и будущих handoff consumers без копирования файлов по слоям.

Пока отдельный handoff runtime binding не реализован, ordinary CLI workflow зависит только от `core` overlays, а `injections/handoff/*` остаются future stubs и не должны трактоваться как текущий runtime contract.

## Bundled Codex Agents

- Extension публикует bundled Codex agents через top-level поле `agentFiles` в `extension.json`.
- Codex не спаунит эти агенты автоматически только из-за факта установки extension; для запуска нужен явный запрос пользователя или orchestrator logic в уже идущем subagent workflow.
- Subagent workflows в Codex доступны по умолчанию, но стартуют только когда их явно попросили использовать.
- Подробности по именам `aifhub-*`, expected `sandbox_mode` и примерам вызова собраны в [Codex Agents](codex-agents.md).

## Validation

Extension включает три валидатора, которые проверяют целостность manifest, agent schema и документации.

### Валидаторы

| Скрипт | Что проверяет |
|--------|---------------|
| `scripts/validate-extension.mjs` | `extension.json`: paths из `skills`, `agentFiles.source`, `injections.file` существуют; `agentFiles.target` имеют расширение `.toml`; `version` — semver; `compat.ai-factory` присутствует |
| `scripts/validate-codex-agents.mjs` | Codex TOML файлы в `agent-files/codex/`: обязательные поля `name`, `description`, `developer_instructions`, `sandbox_mode`; отсутствие legacy полей `prompt` и `reasoning_effort` |
| `scripts/validate-doc-links.mjs` | Markdown ссылки в `docs/`, `injections/`, `skills/`: целевые файлы существуют; нет пустых plan placeholders (`.ai-factory/plans/.md`); внешние ссылки и anchor-only игнорируются |

### Запуск

```bash
# Запустить все валидаторы
npm run validate

# Запустить все тесты
npm test
```

CI автоматически запускает валидаторы на каждом PR (`.github/workflows/validate.yml`).

## Installation

```bash
ai-factory extension add https://github.com/ichinya/aifhub-extension.git
```

Notes:
- `ai-factory extension list` prints `name/version/source` from `.ai-factory.json`
- update through `ai-factory extension update` against the Git source configured in `.ai-factory.json`

## Typical Flow

### 1. Analyze project

```bash
/aif-analyze
```

Creates or updates:
- `.ai-factory/config.yaml`
- `.ai-factory/rules/base.md`

`/aif-analyze` завершает bootstrap. После него canonical public workflow начинается с `/aif-explore` или сразу с `/aif-plan full`.

### 2. Explore (optional)

```bash
/aif-explore "add OAuth authentication"
/aif-explore <plan-id>
/aif-explore @.ai-factory/plans/<plan-id>.md
```

Explore behavior:
- reads `.ai-factory/config.yaml` first
- resolves either the companion plan file or the plan folder to one active pair
- writes only `.ai-factory/RESEARCH.md`
- routes new work to `/aif-plan full`

### 3. Create a full plan

```bash
/aif-plan full "add OAuth authentication"
```

Full-mode planning creates both:
- `.ai-factory/plans/<plan-id>.md`
- `.ai-factory/plans/<plan-id>/`

If active research exists, `/aif-plan` normalizes it into plan-local `explore.md`.

`/aif-plan full` — current replacement для historical `/aif-new`, когда нужно открыть новую full plan pair.

### 4. Improve the plan

```bash
/aif-improve
/aif-improve @.ai-factory/plans/<plan-id>/
/aif-improve @.ai-factory/plans/<plan-id>.md
```

Improve behavior:
- resolves the plan file, the plan folder, or any plan-local artifact path
- updates the plan summary plus plan-folder artifacts together
- auto-generates a missing companion plan file for legacy folder-only plans

### 5. Implement

```bash
/aif-implement
/aif-implement @.ai-factory/plans/<plan-id>/status.yaml
```

Implement behavior:
- owns `status.yaml` execution metadata and git-strategy persistence
- supports `--from <n>` resume and optional Claude worker mode
- routes completion to `/aif-verify`

`Apply` в handoff wording может ссылаться на этот этап, но current public command здесь — `/aif-implement`, не `/aif-apply`.

### 6. Verify and finalize

```bash
/aif-verify
/aif-verify --check-only
/aif-verify --strict
```

Verify behavior:
- reads the plan pair and plan-folder artifacts
- records findings in `verify.md` and `status.yaml`
- archives passing plans into `.ai-factory/specs/<plan-id>/` unless `--check-only` is used

### 7. Done (AIFHub/Handoff finalizer)

```bash
/aif-done
```

### Review Gates (optional)

Three independent read-only gates can be run after implementation and before final verification:

```text
/aif-review             — code review gate
/aif-security-checklist — security gate
/aif-rules-check        — rules compliance gate (extension-owned, temporary)
```

All three gates are independent and can run in any order. If any gate returns `FAIL`, return to the implementing stage. `/aif-rules-check` is an extension-owned temporary gate — when upstream `ai-factory` adds a native version, this skill should be deprecated.

`/aif-done` — extension-owned skill, работающий **после** passing verification:

- Проверяет, что active plan прошёл verify (verdict `pass` или `pass-with-notes`).
- Архивирует plan folder и companion plan file в `.ai-factory/specs/<plan-id>/`.
- Готовит commit message draft.
- Если есть feature branch и `gh` доступен — готовит PR summary draft. Без `gh` — выводит manual PR instructions.
- Предлагает follow-ups (roadmap, architecture, rules, `/aif-evolve`) — только как suggestions, без auto-edit.
- Если workspace dirty не только из текущего плана — останавливается и просит подтверждения.

`/aif-done` не дублирует `/aif-verify` — это отдельный AIFHub/Handoff finalizer для archive/summary/follow-up задачи.

### 8. Fix findings

```bash
/aif-fix
/aif-fix B001 I001
/aif-fix --all
```

After fixes, run:

```bash
/aif-verify
```

## Release Smoke Checks

Use this checklist when validating an install or update of the extension:

1. Проверить версию CLI:

```bash
ai-factory --version
```

Ожидается версия внутри `>=2.10.0 <3.0.0`.

2. Установка:

```bash
ai-factory extension add https://github.com/ichinya/aifhub-extension.git
```

Ожидается, что `extension.json` будет публиковать только `skills/aif-analyze`, injected built-in workflow и Codex `agentFiles`.

3. Обновление:

```bash
ai-factory update
ai-factory extension update
```

Ожидается, что built-in skills останутся canonical, injections переустановятся чисто, а поддерживаемые runtime-managed assets останутся синхронизированы с manifest.

4. Удаление:

```bash
ai-factory extension remove aifhub-extension
```

Ожидается, что canonical upstream commands останутся доступными без extension-owned override для `aif-plan`.

5. Сквозной workflow:

```bash
/aif-analyze
/aif-plan full "smoke-check feature"
/aif-improve
/aif-implement
/aif-verify --check-only
```

Ожидаются companion artifacts в `.ai-factory/plans/`, синхронизированный `status.yaml` и документация, которая указывает только на текущий workflow.

## Project Layout

```text
aifhub-extension/
|- extension.json
|- agent-files/
|  `- codex/
|- injections/
|  |- core/
|  |- handoff/
|  `- references/
|- docs/
|  |- README.md
|  |- codex-agents.md
|  |- usage.md
|  |- handoff.md
|  `- context-loading-policy.md
`- skills/
   |- aif-analyze/
   |- aif-done/
   |- aif-rules-check/
   `- shared/
```

## See Also

- [Documentation Index](README.md) - docs overview and reading order
- [Handoff Naming](handoff.md) - терминология стадий versus current public commands
- [Codex Agents](codex-agents.md) - bundled `aifhub-*` agents, explicit invocation, and sandbox contract
- [Context Loading Policy](context-loading-policy.md) - runtime context and ownership contract
- [Codex Plan Mode](codex-plan-mode.md) - Codex app/CLI recommended flow and question format guidance
- [Project README](../README.md) - quick start and high-level workflow summary
