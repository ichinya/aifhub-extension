[← Previous Page](usage.md) · [Back to README](../README.md)

# Термины Handoff

## Цель

Этот документ разводит два слоя, которые легко смешать в обсуждении handoff:

- канонический public CLI workflow
- handoff stage vocabulary `Explore / New / Apply / Done`

Названия стадий можно использовать как краткие названия этапов, но они не обязаны совпадать со slash commands.
Legacy slash aliases и handoff stage names — разные смысловые слои.

## Future Handoff Prompt Stubs

Кроме stage vocabulary, в `injections/handoff/` лежат четыре future stub prompt assets для review/security/rules/done layer.
Сейчас они не подключены ни через `extension.json`, ни через bundled `agent-files/codex/*.toml`: соответствующие runtime consumers пока используют inline `developer_instructions`, поэтому эти файлы нельзя считать уже действующим `handoff profile`.

Каждый stub-файл содержит HTML-комментарий `<!-- gate-summary: ... -->` в начале файла — machine-consumable блок для будущего Handoff parser. Этот блок включает `id`, `stage`, `status`, `consumers`, `activation` и `auto_bind` поля. Пока runtime binding не реализован, парсер не запускается и блок носит декларативный характер.

| Файл | Stage | Planned consumer после отдельного runtime binding | Зачем хранится сейчас |
|-------|-------|-----------------------------------------------|------------------------|
| `injections/handoff/aif-review-handoff-gate.md` | Review | `aif-review`, `aifhub-review-sidecar` | Как заготовка для отдельного review gate по changed scope |
| `injections/handoff/aif-security-checklist-handoff-gate.md` | Review | `aif-security-checklist`, `aifhub-security-sidecar` | Как заготовка для отдельного security gate |
| `injections/handoff/aif-rules-check-handoff-gate.md` | Review | `aifhub-rules-sidecar` | Как заготовка для отдельной проверки rule compliance |
| `injections/handoff/aif-done-handoff-finalizer.md` | Done | `aif-done`, `aifhub-done-finalizer` | Как заготовка для отдельного done/finalizer stage после runtime binding |

`aif-verify` и `aif-fix` в этом split не оформляются как handoff prompt assets: они остаются частью `core` workflow, а `aifhub-verifier` и `aifhub-fixer` пока используют inline `developer_instructions`.

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
| `New` | Создание новой full plan pair и старт нового scope | `/aif-plan full` | Что `New` означает legacy slash command `/aif-new` |
| `Apply` | Применение утверждённого plan к execution workflow | `/aif-implement` | Что существует активный public wrapper `/aif-apply` |
| `Done` | Verified end state плюс optional archive/summary/follow-up finalizer | `/aif-done` после passing `/aif-verify` | Что `/aif-done` — обязательный шаг upstream workflow или legacy alias public path |

## `aif-apply`

`aif-apply` можно упоминать только как handoff stage concept или deferred wrapper idea. Это не часть текущего public workflow.

[Issue #20](https://github.com/ichinya/aifhub-extension/issues/20) остаётся открытым именно для реальной subagent orchestration задачи. Документировать `aif-apply` как активный public command нельзя, пока не закрыт ownership/status contract:

- как не дублировать verify -> fix -> re-verify loop, который уже принадлежит `/aif-implement`
- кто обновляет `task.md` checkbox state
- кто владеет `progress.scope_completed`
- кто ведёт `execution.current_task`
- как выбранная git strategy реально применяется до execution
- как сохраняется local mode как canonical fallback
- как сохраняется совместимость с `config.paths.plans` и общим `status.yaml -> execution` контрактом

## `aif-done`

`/aif-done` — extension-owned explicit AIFHub/Handoff finalizer. Это не legacy alias и не часть canonical public CLI workflow. Работает **после** passing verification:

```text
/aif-implement -> /aif-verify -> /aif-done
fail -> /aif-fix -> /aif-verify -> /aif-done
```

Что делает `/aif-done`:
- Проверяет, что plan прошёл verify (verdict `pass` или `pass-with-notes`).
- Архивирует plan folder и companion plan file в `.ai-factory/specs/<plan-id>/`.
- Готовит commit message и PR summary drafts.
- Применяет roadmap/architecture/rules follow-ups только при plan-backed evidence; если owning update нельзя выполнить в текущем runtime, возвращает exact handoff вместо silent skip.
- Запускает или предлагает `/aif-evolve` в зависимости от runtime capability и явного user intent.

Что **не** делает:
- Не дублирует `/aif-verify` verification logic.
- Не auto-создаёт PR — только drafts для review.
- Не выдумывает governance changes без evidence из плана и не обходит owning path для ROADMAP/RULES/ARCHITECTURE.
- Не является обязательным шагом canonical upstream workflow.

## Правила интерпретации

- Если handoff говорит `New`, для новой работы используйте `/aif-plan full`.
- Если handoff говорит `Apply`, ориентируйтесь на `/aif-implement`.
- Если handoff говорит `Done`, доведите plan до verified state через `/aif-verify`, затем при необходимости запустите `/aif-done` для архивации, commit/PR summaries и evidence-driven final follow-ups.
- Если handoff говорит `Explore / New / Apply / Done`, считайте это naming layer, а не списком обязательных slash commands.

## Stage Mapping (Future Handoff Orchestration)

Следующая таблица показывает, как handoff stages маппятся на текущие slash commands и какие stub assets существуют для каждой стадии. Это планировочный reference — пока upstream `aif-handoff` не реализует configurable stage mapping, эти bindings не активны автоматически.

| Handoff Stage | Current Manual Commands | Handoff Stub Assets | Upstream Requirement |
|---------------|------------------------|---------------------|----------------------|
| **Planning** | `/aif-plan full`, `/aif-improve`; optional: `aifhub-plan-polisher` | — | Configurable stage mapping в Handoff orchestrator |
| **Plan Ready** | no worker; gate/status only | — | Stage status tracking API |
| **Implementing** | `/aif-implement`, `/aif-verify --check-only`; if fail: `/aif-fix` -> `/aif-verify --check-only` | — | Если позже понадобится отдельный handoff binding для verify/fix, это должен быть отдельный scope поверх core workflow |
| **Review** | `/aif-review`, `/aif-security-checklist`, `/aif-rules-check`; if any gate fails: return to Implementing | `aif-review-handoff-gate.md`, `aif-security-checklist-handoff-gate.md`, `aif-rules-check-handoff-gate.md` | Multi-gate aggregation и conditional return |
| **Done** | `/aif-done` | `aif-done-handoff-finalizer.md` | Explicit finalizer stage binding |

### Что работает сейчас вручную

```text
/aif-plan full -> /aif-improve -> /aif-implement -> /aif-verify --check-only
                                                         fail -> /aif-fix -> /aif-verify --check-only
                                      /aif-review + /aif-security-checklist + /aif-rules-check (optional manual gates)
any failed Review gate -> aggregated comment -> return to Implementing -> /aif-fix -> /aif-verify --check-only
passing full /aif-verify -> optional /aif-done (archive, commit/PR drafts, governance/evolution follow-ups)
```

Все перечисленные команды работают в текущем CLI workflow через `injections/core/` overlays. `injections/handoff/` в этом scope покрывает только review/security/rules/done stubs и не вмешивается в implementing loop.

### Что требует upstream Handoff

- **Configurable stage mapping**: Handoff orchestrator должен уметь привязывать handoff stages к конкретным commands/agents через конфигурацию.
- **Auto-transition**: переход между stages по verdict (pass/fail) должен управляться orchestrator, а не вручную.
- **Multi-gate aggregation**: параллельный запуск review/security/rules gates и агрегация findings.
- **Runtime binding stubs**: активация `injections/handoff/*.md` через Handoff runtime, а не через `extension.json`.

Handoff не auto-использует `aifhub-*` agents — для этого требуется upstream support configurable stage mapping.
