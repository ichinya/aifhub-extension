[← Previous Page](usage.md) · [Back to README](../README.md)

# Термины Handoff

## Цель

Этот документ разводит слои, которые легко смешать в обсуждении handoff:

- upstream/core execution workflow
- AIFHub OpenSpec finalization tail
- handoff stage vocabulary `Explore / New / Apply / Done`

Названия стадий можно использовать как краткие названия этапов, но они не обязаны совпадать со slash commands.
Legacy slash aliases и handoff stage names — разные смысловые слои.

Для machine-readable orchestration summary см. [Handoff Validation Profile](handoff-validation-profile.md). Этот профиль даёт Handoff один JSON summary по validation gates, но не является отдельным runtime.

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

`aifhub-rules-sidecar` remains AIFHub-specific and namespaced. It should not duplicate upstream `rules-sidecar` beyond the OpenSpec-native generated rules layer: it reads `.ai-factory/rules/generated/*`, follows the `aif-rules-check` verdict semantics, and returns a final `aif-gate-result` block with `"gate": "rules"`.

`aif-verify` и `aif-fix` в этом split не оформляются как handoff prompt assets: они остаются частью `core` workflow, а `aifhub-verifier` и `aifhub-fixer` пока используют inline `developer_instructions`. Если позже понадобится отдельный Handoff binding для verify/fix, это должен быть новый scope поверх core workflow, а не неявное подключение существующих core overlays.

До появления отдельного runtime binding `injections/core/` остаётся единственным active overlay-layer для public command workflow, а `injections/references/` — shared reference bucket для core overlays и будущих handoff stubs.

## Канонический Public Workflow

```text
aif-explore -> aif-plan -> aif-improve -> aif-implement -> aif-verify -> aif-done
                                                            \-> aif-fix -> aif-verify -> aif-done
```

`/aif-analyze` остаётся bootstrap/setup step перед этим flow. Он готовит context и rules, но не является первым узлом canonical public command sequence.
`/aif-done` — AIFHub OpenSpec finalization tail после passing verification. Он не заменяет `/aif-verify`, не является upstream legacy alias и не меняет upstream ownership verification loop.

Upstream `/aif-archive` — отдельная AI Factory 2.14+ legacy cleanup команда для classic plans, а в 2.18 также для atomic marked ultra bundles, плюс optional roadmap snapshots under `paths.archive/roadmap/`. В OpenSpec-native mode plan-mutating targets route to `/aif-done <change-id>` before plan discovery. Команда не является Handoff Done stage и не владеет OpenSpec-native archive/finalization.

## Названия стадий

| Стадия | Что означает | На какой current command ориентироваться | Что не нужно предполагать |
|-------|--------------|------------------------------------------|---------------------------|
| `Explore` | Исследование и уточнение задачи перед планированием | `/aif-explore` при необходимости | Что stage name автоматически означает обязательную команду |
| `New` | Создание новой full plan pair и старт нового scope | `/aif-plan full` | Что `New` означает legacy slash command `/aif-new` |
| `Apply` | Применение утверждённого plan к execution workflow | `/aif-implement` | Что существует активный public wrapper `/aif-apply` |
| `Done` | Verified end state плюс archive/summary/follow-up finalizer для AIFHub OpenSpec lifecycle | `/aif-done` после passing `/aif-verify` | Что `/aif-done` подменяет `/aif-verify`, является upstream legacy alias или автоматически запускается Handoff |

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

`/aif-done` — extension-owned explicit AIFHub/Handoff finalizer. Это не upstream legacy alias и не replacement для `/aif-verify`; в AIFHub OpenSpec-native workflow он входит в finalization tail после passing verification:

```text
/aif-implement -> /aif-verify -> /aif-done
fail -> /aif-fix -> /aif-verify -> /aif-done
```

Что делает `/aif-done`:
- Проверяет, что plan прошёл verify (verdict `pass` или `pass-with-notes`).
- В OpenSpec-native mode архивирует verified change только через OpenSpec CLI (`openspec archive <change-id> --yes`) и пишет final evidence under `.ai-factory/qa/<change-id>/` плюс `.ai-factory/state/<change-id>/`.
- В legacy AI Factory-only mode может финализировать только classic plan folder/companion по существующему AIFHub contract. Для marked ultra `/aif-done` ничего не архивирует: он read-only re-evaluates revision-bound receipt и возвращает exact `/aif-archive <entrypoint>` только для current exact `pass`, иначе exact `/aif-verify <entrypoint>`.
- Готовит commit message и PR summary drafts.
- Применяет roadmap/architecture/rules follow-ups только при plan-backed evidence; если owning update нельзя выполнить в текущем runtime, возвращает exact handoff вместо silent skip.
- Запускает или предлагает `/aif-evolve` в зависимости от runtime capability и явного user intent.

Что **не** делает:
- Не дублирует `/aif-verify` verification logic.
- Не auto-создаёт PR — только drafts для review.
- Не выдумывает governance changes без evidence из плана и не обходит owning path для ROADMAP/RULES/ARCHITECTURE.
- Не является upstream replacement для `/aif-verify` и не восстанавливает legacy `/aif-done` alias semantics.
- Не заменяет upstream `/aif-archive`; `/aif-archive` остаётся legacy plan cleanup и не пишет OpenSpec canonical artifacts.
- Не выполняет verify/archive handoff для marked ultra и не пишет receipt, companion, QA, OpenSpec или spec-index artifacts.

## Правила интерпретации

- Если handoff говорит `New`, для новой работы используйте `/aif-plan full`.
- Если handoff говорит `Apply`, ориентируйтесь на `/aif-implement`.
- Если handoff говорит `Done`, доведите plan до verified state через `/aif-verify`, затем запустите `/aif-done` для AIFHub OpenSpec archive/finalization, commit/PR summaries и evidence-driven final follow-ups. Не используйте `/aif-archive` для OpenSpec-native Done.
- Если legacy entrypoint является valid `<!-- aif:plan-mode:ultra -->` bundle, используйте marker-first exact commands: `/aif-verify <entrypoint>`; затем `/aif-done <entrypoint>` только оценивает receipt и возвращает `/aif-archive <entrypoint>` либо повторный `/aif-verify <entrypoint>`. AIFHub не редактирует phase bundle и не исполняет handoff автоматически.
- Если handoff говорит `Explore / New / Apply / Done`, считайте это naming layer, а не списком обязательных slash commands.

## Stage Mapping (Future Handoff Orchestration)

Следующая таблица показывает, как handoff stages маппятся на текущие slash commands и какие stub assets существуют для каждой стадии. Это планировочный reference — пока upstream `aif-handoff` не реализует configurable stage mapping, эти bindings не активны автоматически.

| Handoff Stage | Current Manual Commands | Handoff Stub Assets | Upstream Requirement |
|---------------|------------------------|---------------------|----------------------|
| **Planning** | `/aif-plan full`, `/aif-improve`; optional: `aifhub-plan-polisher` | — | Configurable stage mapping в Handoff orchestrator |
| **Plan Ready** | no worker; gate/status only | — | Stage status tracking API |
| **Implementing** | `/aif-implement`, `/aif-verify --check-only`; if fail: `/aif-fix` -> `/aif-verify --check-only` | — | Если позже понадобится отдельный handoff binding для verify/fix, это должен быть отдельный scope поверх core workflow |
| **Review** | `/aif-review`, `/aif-security-checklist`, `/aif-rules-check`; if any required gate evidence is missing/invalid, stay in Review and run the owning command; if any completed gate fails, return to Implementing | `aif-review-handoff-gate.md`, `aif-security-checklist-handoff-gate.md`, `aif-rules-check-handoff-gate.md` | Multi-gate aggregation и conditional return |
| **Done** | `/aif-done` | `aif-done-handoff-finalizer.md` | Explicit finalizer stage binding |

Для legacy marked ultra эта таблица является routing layer, а не write pipeline: verifier command boundary — единственный writer `.ai-factory/state/legacy-ultra-verification/<entrypoint-digest>.json`; done/rules consumers только re-evaluate bundle/revision/worktree/gate binding и возвращают exact upstream command.

### Что работает сейчас вручную

```text
/aif-plan full -> /aif-improve -> /aif-implement -> /aif-verify --check-only
                                                         fail -> /aif-fix -> /aif-verify --check-only
                                      /aif-review + /aif-security-checklist + /aif-rules-check (optional manual gates)
any failed Review gate -> aggregated comment -> return to Implementing -> /aif-fix -> /aif-verify --check-only
passing full /aif-verify -> /aif-done (archive, commit/PR drafts, governance/evolution follow-ups)
```

Все перечисленные команды работают в текущем CLI workflow через `injections/core/` overlays. `injections/handoff/` в этом scope покрывает только review/security/rules/done stubs и не вмешивается в implementing loop.

### Что требует upstream Handoff

- **Configurable stage mapping**: Handoff orchestrator должен уметь привязывать handoff stages к конкретным commands/agents через конфигурацию.
- **Auto-transition**: переход между stages по verdict (pass/fail) должен управляться orchestrator, а не вручную.
- **Multi-gate aggregation**: параллельный запуск review/security/rules gates и агрегация findings.
- **Runtime binding stubs**: активация `injections/handoff/*.md` через Handoff runtime, а не через `extension.json`.

Текущий read-only bridge для aggregation contract описан в [Handoff Validation Profile](handoff-validation-profile.md): Handoff может читать один summary вместо прямого парсинга всех gate Markdown files.

Handoff не auto-использует `aifhub-*` agents — для этого требуется upstream support configurable stage mapping.
