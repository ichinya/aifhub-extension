[← Previous Page](README.md) · [Back to README](../README.md) · [Next Page →](context-loading-policy.md)

# Usage

## Skills

| Skill | Type | Purpose |
|-------|------|---------|
| `/aif-analyze` | Extension skill | Bootstrap `.ai-factory/config.yaml` and `rules/base.md`; explicit OpenSpec-native config is supported |
| `/aif-rules-check` | Extension skill (temporary gate) | Read-only rule compliance check against rules hierarchy |
| `/aif-explore` | Built-in + injection | Explore ideas; in OpenSpec-native mode, keep research/runtime notes outside canonical change folders |
| `/aif-plan` | Built-in + injection | Create mode-gated full plans: OpenSpec changes in OpenSpec-native mode, companion plan folders in legacy AI Factory mode |
| `/aif-improve` | Built-in + injection | Refine OpenSpec-native artifacts with preservation, or both legacy plan layers together before execution |
| `/aif-implement` | Built-in + injection | Execute tasks with mode-gated OpenSpec runtime state or legacy plan-folder metadata |
| `/aif-verify` | Built-in + injection | Verify changed scope with mode-gated QA output; optional archival/finalizer work lives in `/aif-done` |
| `/aif-fix` | Built-in + injection | Apply fixes for verification findings without rewriting canonical artifacts unless requested |
| `/aif-roadmap` | Built-in + injection | Evidence-based maturity audit roadmap |
| `/aif-evolve` | Built-in + injection | Plan-evidence-driven evolution workflow |
| `/aif-done` | Extension skill | Finalize verified work with OpenSpec-native archive policy or legacy plan archive, commit/PR drafts, and evidence-backed follow-ups |

## Канонический Public Workflow

```text
aif-explore -> aif-plan -> aif-improve -> aif-implement -> aif-verify
                                                            \-> aif-fix -> aif-verify
```

`/aif-analyze` — это bootstrap/setup step перед этим flow. Он подготавливает `.ai-factory/config.yaml` и `rules/base.md`, но не является первым узлом canonical public command sequence.

- Для новой работы используйте `/aif-plan full`. `/aif-new` — только historical alias; `New` в handoff vocabulary — stage name, а не slash command.
- `Explore / New / Apply / Done` — это handoff stage names. Это naming layer, не public CLI command list. Подробности собраны в [Handoff Naming](handoff.md).
- `aif-apply` как delegated wrapper пока отложен по ownership/status contract из [issue #20](https://github.com/ichinya/aifhub-extension/issues/20); issue остаётся открытым для реальной subagent orchestration, а current public path использует `/aif-implement`.
- `/aif-done` — explicit AIFHub/Handoff finalizer после passing verification. Он не дублирует `/aif-verify`, не является legacy alias и не входит в canonical public CLI path.

## Recommended Codex App Flow

Codex не имеет автоматического переключения режимов из extension prompts. Пользователь управляет режимом вручную, а prompts могут только рекомендовать нужный режим для текущей стадии.

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

# 5. Optional explicit finalizer
/aif-done
```

Этот flow документирует безопасный runtime contract для Codex. Он не обещает client automation и не подразумевает auto-switch Plan mode из skill/injection prompts.

### Runtime Notes

- **Plan mode**: `request_user_input` доступен только после ручного входа в Plan mode и только для 1-3 коротких вопросов. Используйте его в planning/refinement стадиях.
- **Default mode**: формы недоступны. Задавайте вопросы как plain text в assistant message. Не используйте `question(...)`, `questionnaire(...)` или `request_user_input`.
- **Subagent mode**: не задавайте интерактивные вопросы. Фиксируйте assumptions и возвращайте blockers/open questions родителю.
- Подробности по форматам вопросов: [Codex Plan Mode](codex-plan-mode.md).
- Справочник по форматам вопросов для всех runtime: `skills/shared/QUESTION-TOOL.md`.

## Совместимость

- Это руководство рассчитано на `ai-factory >=2.10.0 <3.0.0`.
- Extension хранит `sources.ai-factory.baselineVersion = 2.0.0` только как исторический контекст.
- Runtime-aware Codex и Claude `agentFiles` входят в поддерживаемый контракт, начиная с проверенного upstream `2.10.0`.

## Слои Prompt-Инъекций

- `injections/core/` — active mode-gated workflow prompt assets; только этот слой подключается через `extension.json` и поддерживает canonical public workflow. OpenSpec-native sections keep canonical artifacts under `openspec/`, while legacy AI Factory-only sections keep the plan-folder overlay.
- `injections/handoff/` — future stub prompt assets; здесь лежат только `aif-review-handoff-gate.md`, `aif-security-checklist-handoff-gate.md`, `aif-rules-check-handoff-gate.md` и `aif-done-handoff-finalizer.md` как dormant profile для отдельного runtime binding, но не как уже подключённый profile. `aif-verify` и `aif-fix` остаются частью `core` workflow, а соответствующие runtime consumers по-прежнему используют inline `developer_instructions`. Каждый stub содержит machine-consumable `<!-- gate-summary -->` блок для будущего Handoff parser.
- `injections/references/` — shared root-level references для verify/roadmap и будущих handoff consumers без копирования файлов по слоям.

Пока отдельный handoff runtime binding не реализован, ordinary CLI workflow зависит только от `core` overlays, а `injections/handoff/*` остаются future stubs и не должны трактоваться как текущий runtime contract.

## Bundled Runtime Agents

- Extension публикует namespaced runtime-managed agents через top-level поле `agentFiles` в `extension.json` для Codex и Claude.
- Codex и Claude не начинают использовать эти subagents автоматически только из-за факта установки extension; для запуска нужен явный пользовательский запрос или future orchestrator mapping.
- Для Codex подробности по именам `aifhub-*`, `sandbox_mode` и примерам вызова собраны в [Codex Agents](codex-agents.md).
- Для Claude подробности по `.claude/agents/`, `permissionMode`, `background: true` sidecars и ручному использованию собраны в [Claude Agents](claude-agents.md).

## Validation

Extension включает четыре валидатора, которые проверяют целостность manifest, Codex/Claude agent schema и документации.

### Валидаторы

| Скрипт | Что проверяет |
|--------|---------------|
| `scripts/validate-extension.mjs` | `extension.json`: paths из `skills`, `agentFiles.source`, `injections.file` существуют; `agentFiles.target` соответствуют runtime (`.toml` для Codex, `.md` для Claude); `version` — semver; `compat.ai-factory` присутствует |
| `scripts/validate-codex-agents.mjs` | Codex TOML файлы в `agent-files/codex/`: обязательные поля `name`, `description`, `developer_instructions`, `sandbox_mode`; отсутствие legacy полей `prompt` и `reasoning_effort` |
| `scripts/validate-claude-agents.mjs` | Claude markdown-файлы в `agent-files/claude/`: YAML frontmatter, обязательные поля `name` и `description`, namespaced `aifhub-*` naming contract |
| `scripts/validate-doc-links.mjs` | Markdown ссылки в `docs/`, `injections/`, `skills/`: целевые файлы существуют; нет пустых plan placeholders с пропущенным `<plan-id>`; внешние ссылки и anchor-only игнорируются |

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

For OpenSpec-native bootstrap, explicitly request `openspec-native` or start from a config that already contains `aifhub.artifactProtocol: openspec`. The skill then completes the OpenSpec-native config shape, maps canonical changes to `openspec/changes`, maps specs to `openspec/specs`, prepares `.ai-factory/state`, `.ai-factory/qa`, and `.ai-factory/rules/generated`, and reports OpenSpec CLI capabilities through `scripts/openspec-runner.mjs` when available. Missing OpenSpec CLI remains degraded mode, not bootstrap failure.

Compatible OpenSpec CLI environments may use or receive this recommendation:

```bash
openspec init --tools none
```

The extension does not install OpenSpec skills or slash commands.

`/aif-analyze` завершает bootstrap. После него canonical public workflow начинается с `/aif-explore` или сразу с `/aif-plan full`.

### 2. Explore (optional)

```bash
/aif-explore "add OAuth authentication"
/aif-explore <change-id>
/aif-explore <plan-id>
/aif-explore @.ai-factory/plans/<plan-id>.md
```

Explore behavior:
- reads `.ai-factory/config.yaml` first
- in OpenSpec-native mode, stays research-oriented and may read `openspec/specs/**` plus `openspec/changes/<change-id>/**`
- in OpenSpec-native mode, writes research/runtime output only to `.ai-factory/RESEARCH.md` or `.ai-factory/state/<change-id>/`
- does not create non-OpenSpec files inside `openspec/changes/<change-id>/`
- in legacy AI Factory-only mode, resolves either the companion plan file or the plan folder to one active pair and writes only `.ai-factory/RESEARCH.md`
- routes new work to `/aif-plan full`; route existing OpenSpec-native changes to `/aif-improve <change-id>`

### 3. Create a full plan

```bash
/aif-plan full "add OAuth authentication"
```

Full-mode planning is mode-gated.

In OpenSpec-native mode (`aifhub.artifactProtocol: openspec`), `/aif-plan full` creates canonical OpenSpec change artifacts:

- `openspec/changes/<change-id>/proposal.md`
- `openspec/changes/<change-id>/design.md`
- `openspec/changes/<change-id>/tasks.md`
- `openspec/changes/<change-id>/specs/**/spec.md` when behavior changes

OpenSpec validation runs through `scripts/openspec-runner.mjs` when a compatible CLI is available. Missing or unsupported OpenSpec CLI is degraded validation, not planning failure.

In legacy AI Factory-only mode, full-mode planning creates both:

- `.ai-factory/plans/<plan-id>.md`
- `.ai-factory/plans/<plan-id>/`

If active research exists, `/aif-plan` normalizes it into plan-local `explore.md` only in legacy AI Factory mode. OpenSpec-native runtime notes belong under `.ai-factory/state/<change-id>/`, not inside `openspec/changes/<change-id>/`.

Для открытия новой full plan pair используйте `/aif-plan full`. Historical `/aif-new` больше не является current public command.

### 4. Improve the plan

```bash
/aif-improve
/aif-improve <change-id>
/aif-improve @openspec/changes/<change-id>/
/aif-improve @.ai-factory/plans/<plan-id>/
/aif-improve @.ai-factory/plans/<plan-id>.md
```

Improve behavior:
- in OpenSpec-native mode, resolves the active change with `scripts/active-change-resolver.mjs`
- refines only `proposal.md`, `design.md`, `tasks.md`, and `specs/**/spec.md`
- preserves user edits, prefers patch-style changes, and returns `Changed:` / `Preserved:` summary sections
- warns or refuses archived targets under `openspec/changes/archive/**` because archived changes are immutable by default
- validates through `scripts/openspec-runner.mjs` when a compatible CLI is available; missing or unsupported CLI is degraded validation
- in legacy AI Factory-only mode, resolves the plan file, the plan folder, or any plan-local artifact path
- updates the legacy plan summary plus plan-folder artifacts together and auto-generates a missing companion plan file for legacy folder-only plans

### 5. Implement

```bash
/aif-implement
/aif-implement <change-id>
/aif-implement @openspec/changes/<change-id>/
/aif-implement @.ai-factory/plans/<plan-id>/status.yaml
```

Implement behavior:
- in OpenSpec-native mode, reads `proposal.md`, `design.md`, `tasks.md`, `specs/**/spec.md`, accepted specs, and generated rules
- in OpenSpec-native mode, uses `scripts/openspec-execution-context.mjs` when available to prepare implementation context and optional OpenSpec `instructions apply` guidance
- in OpenSpec-native mode, writes implementation traces only under `.ai-factory/state/<change-id>/implementation/`; it does not write canonical OpenSpec artifacts unless the user explicitly expands scope
- in OpenSpec-native mode, does not require legacy `.ai-factory/plans/<id>/task.md`
- generated rules are derived guidance; missing or stale generated rules warn without replacing canonical OpenSpec artifacts
- in legacy AI Factory-only mode, owns `status.yaml` execution metadata and git-strategy persistence
- supports `--from <n>` resume and optional Claude worker mode
- routes completion to `/aif-verify`

`Apply` в handoff wording может ссылаться на этот этап, но current public command здесь — `/aif-implement`, не `/aif-apply`.

### 6. Verify

```bash
/aif-verify
/aif-verify --check-only
/aif-verify --strict
```

Verify behavior:
- in OpenSpec-native mode, reads canonical OpenSpec artifacts, generated rules, runtime state, and changed files
- in OpenSpec-native mode, validates the active OpenSpec change before lint/tests/review checks when validation is enabled
- in OpenSpec-native mode, records OpenSpec validation/status evidence, QA evidence, and findings under `.ai-factory/qa/<change-id>/` and does not archive
- in OpenSpec-native mode, treats missing OpenSpec CLI as degraded mode unless strict config requires CLI
- in OpenSpec-native mode, hard-fails invalid OpenSpec artifacts before code checks
- in legacy AI Factory-only mode, reads the plan pair and plan-folder artifacts and records findings in `verify.md` and `status.yaml`
- returns the pass/fail state that gates `/aif-fix` or the optional `/aif-done` finalizer

### 7. Done (explicit AIFHub/Handoff finalizer)

```bash
/aif-done
```

`/aif-done` owns post-verify finalization, commit/PR drafting, and evidence-backed governance/evolution follow-ups. In OpenSpec-native mode it follows OpenSpec archive policy and writes finalizer state outside canonical change artifacts; concrete archive integration remains tracked by #33. In legacy AI Factory-only mode it archives the verified plan pair to `.ai-factory/specs/<plan-id>/`. `/aif-verify` remains verification-only, including `--check-only` runs.

### Review Gates (optional)

Three independent read-only gates can be run after implementation and before final verification:

```text
/aif-review             — code review gate
/aif-security-checklist — security gate
/aif-rules-check        — rules compliance gate (extension-owned, temporary)
```

All three gates are independent and can run in any order. If any gate returns `FAIL`, return to the implementing stage. `/aif-rules-check` is an extension-owned temporary gate — when upstream `ai-factory` adds a native version, this skill should be deprecated.

`/aif-done` — extension-owned explicit finalizer, работающий **после** passing verification:

- Проверяет, что active work прошёл verify (verdict `pass` или `pass-with-notes`).
- В OpenSpec-native mode follows OpenSpec archive policy and writes only finalizer/runtime state until #33 completes concrete archive integration.
- В legacy AI Factory-only mode архивирует plan folder и companion plan file в `.ai-factory/specs/<plan-id>/`.
- Готовит commit message draft.
- Если есть feature branch и `gh` доступен — готовит PR summary draft. Без `gh` — выводит manual PR instructions.
- Применяет evidence-driven follow-ups для roadmap/architecture/rules через owning path или возвращает exact handoff, если текущий runtime не может безопасно завершить update.
- Если workspace dirty не только из текущего плана — останавливается и просит подтверждения.

`/aif-done` не дублирует `/aif-verify` — это отдельный AIFHub/Handoff finalizer для archive/summary/follow-up задачи, а не legacy alias старого public workflow.

Governance note: roadmap/architecture/rules follow-ups must be backed by verified plan evidence. If the owning update cannot run safely in the current runtime, `/aif-done` should return an exact handoff instead of silently skipping it.

### 8. Fix findings

```bash
/aif-fix
/aif-fix B001 I001
/aif-fix --all
```

Fix behavior:
- in OpenSpec-native mode, reads the same canonical OpenSpec artifacts as `/aif-implement`
- in OpenSpec-native mode, reads QA evidence from `.ai-factory/qa/<change-id>/`
- in OpenSpec-native mode, uses `scripts/openspec-execution-context.mjs` when available to prepare fix context and optional OpenSpec `instructions apply` guidance
- in OpenSpec-native mode, writes fix traces only under `.ai-factory/state/<change-id>/fixes/`
- in OpenSpec-native mode, does not write runtime traces into `openspec/changes/<change-id>/`
- in OpenSpec-native mode, does not require legacy `.ai-factory/plans/<id>/task.md`
- generated rules are derived guidance; missing or stale generated rules warn without replacing canonical OpenSpec artifacts

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

Ожидается, что `extension.json` будет публиковать только `skills/aif-analyze`, injected built-in workflow и namespaced runtime-managed `agentFiles` для Codex и Claude.

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

Ожидаются companion artifacts в `.ai-factory/plans/`, синхронизированный `status.yaml` и документация, которая указывает только на текущий workflow. For an explicit OpenSpec-native smoke, expect `openspec/changes/<change-id>/` plus runtime/QA output under `.ai-factory/state/<change-id>/` and `.ai-factory/qa/<change-id>/`.

## Project Layout

```text
aifhub-extension/
|- extension.json
|- agent-files/
|  |- claude/
|  `- codex/
|- injections/
|  |- core/
|  |- handoff/
|  `- references/
|- docs/
|  |- README.md
|  |- claude-agents.md
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
- [Claude Agents](claude-agents.md) - bundled `aifhub-*` Claude agents, `.claude/agents/` install behavior, and manual invocation contract
- [Codex Agents](codex-agents.md) - bundled `aifhub-*` agents, explicit invocation, and sandbox contract
- [Context Loading Policy](context-loading-policy.md) - runtime context and ownership contract
- [Codex Plan Mode](codex-plan-mode.md) - Codex app/CLI recommended flow and question format guidance
- [Project README](../README.md) - quick start and high-level workflow summary
