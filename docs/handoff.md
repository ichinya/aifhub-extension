[← Previous Page](usage.md) · [Back to README](../README.md)

# Термины Handoff

## Цель

Этот документ разводит два слоя, которые легко смешать в обсуждении handoff:

- канонический public CLI workflow
- handoff stage vocabulary `Explore / New / Apply / Done`

Названия стадий можно использовать как краткие названия этапов, но они не обязаны совпадать со slash commands.

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
