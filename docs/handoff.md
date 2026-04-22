[← Previous Page](usage.md) · [Back to README](../README.md)

# Термины Handoff

## Цель

Этот документ разводит два слоя, которые легко смешать в обсуждении handoff:

- канонический public CLI workflow
- handoff stage vocabulary `Explore / New / Apply / Done`

Названия стадий можно использовать как краткие названия этапов, но они не обязаны совпадать со slash commands.

## Future Handoff Prompt Stubs

Кроме stage vocabulary, в `injections/handoff/` лежат future stub prompt assets.
Сейчас они не подключены ни через `extension.json`, ни через bundled `agent-files/codex/*.toml`: соответствующие runtime consumers пока используют inline `developer_instructions`, поэтому эти файлы нельзя считать уже действующим `handoff profile`.

Каждый stub-файл содержит HTML-комментарий `<!-- gate-summary: ... -->` в начале файла — machine-consumable блок для будущего Handoff parser. Этот блок включает `id`, `stage`, `status`, `consumers`, `activation` и `auto_bind` поля. Пока runtime binding не реализован, парсер не запускается и блок носит декларативный характер.

| Файл | Stage | Planned consumer после отдельного runtime binding | Зачем хранится сейчас |
|-------|-------|-----------------------------------------------|------------------------|
| `injections/handoff/aif-review-handoff-gate.md` | Review | `aif-review`, `aifhub-review-sidecar` | Как заготовка для отдельного review gate по changed scope |
| `injections/handoff/aif-security-checklist-handoff-gate.md` | Review | `aif-security-checklist`, `aifhub-security-sidecar` | Как заготовка для отдельного security gate |
| `injections/handoff/aif-rules-check-handoff-gate.md` | Review | `aifhub-rules-sidecar` | Как заготовка для отдельной проверки rule compliance |
| `injections/handoff/aif-verify-handoff-gate.md` | Implementing | `aifhub-verifier` | Как заготовка для verification gate в handoff context |
| `injections/handoff/aif-fix-handoff-comment.md` | Implementing | `aifhub-fixer` | Как заготовка для fix loop с aggregated findings от review gates |
| `injections/handoff/aif-done-handoff-finalizer.md` | Done | `aifhub-done-finalizer` | Как заготовка для finalizer semantics после passing verification |

До появления отдельного runtime binding `injections/core/` остаётся единственным active overlay-layer для canonical public workflow, а `injections/references/` — shared reference bucket для core overlays и будущих handoff stubs.

## Канонический Public Workflow

```text
aif-explore -> aif-plan -> aif-improve -> aif-implement -> aif-verify
                                                            \-> aif-fix -> aif-verify
```

`/aif-analyze` остаётся bootstrap/setup step перед этим flow. Он готовит context и rules, но не является первым узлом canonical public command sequence.

## Названия стадий

| Стадия | Что означает | На какой current command ориентироваться | Что не нужно предполагать |
|-------|--------------|------------------------------------------|---------------------------|
| `Explore` | Исследование и уточнение задачи перед планированием | `/aif-explore` при необходимости | Что stage name автоматически означает обязательную команду |
| `New` | Создание новой full plan pair и старт нового scope | `/aif-plan full` | Что нужно вызывать `/aif-new` |
| `Apply` | Применение утверждённого plan к execution workflow | `/aif-implement` | Что существует активный public wrapper `/aif-apply` |
| `Done` | Verified/finalized end state после execution и проверки | `/aif-verify`, а при findings — `/aif-fix` -> `/aif-verify` | Что пользователь обязан вызывать `/aif-done` |

## `aif-apply`

`aif-apply` можно упоминать только как handoff stage concept или deferred wrapper idea. Это не часть текущего public workflow.

[Issue #20](https://github.com/ichinya/aifhub-extension/issues/20) остаётся открытым именно для реальной subagent orchestration задачи. Документировать `aif-apply` как активный public command нельзя, пока не закрыт ownership/status contract:

- кто обновляет `task.md` checkbox state
- кто владеет `progress.scope_completed`
- кто ведёт `execution.current_task`
- как выбранная git strategy реально применяется до execution
- как сохраняется local mode как canonical fallback

## `aif-done`

В handoff vocabulary `aif-done` трактуется как explicit AIFHub finalizer semantics. Это допустимое внутреннее или историческое имя стадии, но не current public alias.

Для пользователя путь завершения остаётся таким:

```text
/aif-implement -> /aif-verify
fail -> /aif-fix -> /aif-verify
```

## Правила интерпретации

- Если handoff говорит `New`, для новой работы используйте `/aif-plan full`.
- Если handoff говорит `Apply`, ориентируйтесь на `/aif-implement`.
- Если handoff говорит `Done`, доведите plan до verified/finalized state через `/aif-verify`, а не через legacy alias.
- Если handoff говорит `Explore / New / Apply / Done`, считайте это naming layer, а не списком обязательных slash commands.

## Stage Mapping (Future Handoff Orchestration)

Следующая таблица показывает, как handoff stages маппятся на текущие slash commands и какие stub assets существуют для каждой стадии. Это планировочный reference — пока upstream `aif-handoff` не реализует configurable stage mapping, эти bindings не активны автоматически.

| Handoff Stage | Current Manual Commands | Handoff Stub Assets | Upstream Requirement |
|---------------|------------------------|---------------------|----------------------|
| **Planning** | `/aif-plan full`, `/aif-improve`; optional: `aifhub-plan-polisher` | — | Configurable stage mapping в Handoff orchestrator |
| **Plan Ready** | no worker; gate/status only | — | Stage status tracking API |
| **Implementing** | `/aif-implement`, `/aif-verify --check-only`; if fail: `/aif-fix` -> `/aif-verify --check-only` | `aif-verify-handoff-gate.md`, `aif-fix-handoff-comment.md` | Auto-transition на verification pass/fail |
| **Review** | `/aif-review`, `/aif-security-checklist`, `/aif-rules-check`; if any gate fails: return to Implementing | `aif-review-handoff-gate.md`, `aif-security-checklist-handoff-gate.md`, `aif-rules-check-handoff-gate.md` | Multi-gate aggregation и conditional return |
| **Done** | `/aif-verify` (finalization), optional `/aif-done` semantics | `aif-done-handoff-finalizer.md` | Explicit finalizer stage binding |

### Что работает сейчас вручную

```text
/aif-plan full -> /aif-improve -> /aif-implement -> /aif-verify --check-only
                                                         fail -> /aif-fix -> /aif-verify --check-only
                                      /aif-review + /aif-security-checklist (по желанию)
/aif-verify (finalization без --check-only)
```

Все перечисленные команды работают в текущем CLI workflow через `injections/core/` overlays.

### Что требует upstream Handoff

- **Configurable stage mapping**: Handoff orchestrator должен уметь привязывать handoff stages к конкретным commands/agents через конфигурацию.
- **Auto-transition**: переход между stages по verdict (pass/fail) должен управляться orchestrator, а не вручную.
- **Multi-gate aggregation**: параллельный запуск review/security/rules gates и агрегация findings.
- **Runtime binding stubs**: активация `injections/handoff/*.md` через Handoff runtime, а не через `extension.json`.

Handoff не auto-использует `aifhub-*` agents — для этого требуется upstream support configurable stage mapping.
