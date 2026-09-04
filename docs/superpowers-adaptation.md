[Back to Documentation Index](README.md)

# Адаптация идей Superpowers

Этот документ фиксирует bounded adaptation идей из [obra/superpowers](https://github.com/obra/superpowers) для существующего AI Factory/OpenSpec lifecycle и [issue #141](https://github.com/ichinya/aifhub-extension/issues/141). Источник рассмотрен 2026-09-01 на release tag [`v6.3.0`](https://github.com/obra/superpowers/releases/tag/v6.3.0), который указывает на commit [`b36e0829c6d0140e93cfef2ca599b1b07d4a7797`](https://github.com/obra/superpowers/commit/b36e0829c6d0140e93cfef2ca599b1b07d4a7797) от 2026-08-12. AIFHub не устанавливает Superpowers, не копирует его bootstrap/hooks и не добавляет второй набор публичных workflow skills.

## Принятые идеи

| Идея | AIFHub contract |
|---|---|
| RED -> GREEN -> REFACTOR | Для testable behavior change implementer сначала наблюдает ожидаемое падение узкого automated check, затем делает минимальный production edit, повторяет тот же check и только после этого выполняет bounded cleanup. `testCheck`, `redResult`, `greenResult`, `refactorResult` и `fallbackDecision` сохраняются в implementation trace. |
| Systematic debugging | Fixer сначала записывает direct `rootCauseEvidence`, формулирует one falsifiable hypothesis и запускает минимальный experiment. Проверяется one hypothesis at a time; после трёх неудачных гипотез speculative edits прекращаются. |
| Двухэтапное review | `/aif-review` и namespaced review sidecar сначала выполняют plan/spec compliance pass, затем code-quality pass. Результат остаётся одним read-only review gate. |
| Evidence before completion | Development/fix traces являются supporting runtime evidence. Только `/aif-verify` создаёт authoritative QA verdict, coverage и final verify gate. |

Implementation evidence пишется только в:

```text
.ai-factory/state/<change-id>/implementation/
```

Fix evidence пишется только в:

```text
.ai-factory/state/<change-id>/fixes/
```

Эти traces не становятся canonical OpenSpec content, generated rules, QA verdict или done evidence.

## Осознанные границы

- AI Factory already owns `/aif-explore`, `/aif-plan`, optional branch/worktree setup, `/aif-implement`, `/aif-fix`, `/aif-review` и `/aif-verify`; AIFHub расширяет их injections и managed agent files вместо создания `brainstorming`, `writing-plans`, `test-driven-development` или `systematic-debugging` command copies.
- Test-first cycle применяется только когда plan, project policy или существующая test convention требует полезный automated check. Для docs-only work, generated artifacts, явно разрешённого no-test scope или отсутствующего полезного check записывается `fallbackDecision`; failing test не выдумывается.
- RED evidence действительно только для ожидаемого behavioral failure. Syntax, fixture, dependency и environment failures не считаются доказательством RED.
- Passing focused check не означает, что change корректен целиком. Full repository checks, requirement coverage и final verdict остаются у `/aif-verify`.
- Review остаётся read-only. Code-quality pass не может стереть или понизить plan/spec compliance finding.
- Никаких automatic plugin installs, session-start hooks, background services, MCP registration, commits или новых permission surfaces эта адаптация не добавляет.

## Что не дублируется

Superpowers предлагает полный mandatory workflow с design approval, worktrees, granular plans, fresh subagents и per-task review. В этом репозитории соответствующие ownership boundaries уже распределены между AI Factory и AIFHub:

- planning modes и canonical artifacts принадлежат `/aif-plan` и `/aif-improve`;
- worktree strategy принадлежит upstream AI Factory planning/implementation flow;
- namespaced workers остаются optional и запускаются только через выбранный orchestration flow;
- final verification, coverage и gate routing принадлежат `/aif-verify`;
- archive/finalization принадлежит `/aif-done`.

Более крупные SDD additions - right-sized profiles, SessionBrief, plan-compliance receipt и fresh-context review - отслеживаются отдельно в [issue #168](https://github.com/ichinya/aifhub-extension/issues/168). Эта адаптация не предрешает их schemas, paths или policy.

## Проверочное покрытие

`scripts/superpowers-discipline-contract.test.mjs` является prompt/documentation contract: он проверяет стабильные evidence-поля, их порядок, ссылки и нормализованную семантическую парность Claude/Codex-блоков. Он не заявляется как validator произвольного trace-файла.

Поведение рендерера отдельно покрывает `scripts/openspec-execution-context.test.mjs`: полный development cycle, компактный fallback-only trace, fix evidence и type-scoping между Implementation/Fix. Authoritative валидация результата по-прежнему принадлежит `/aif-verify`.

## Проверяемый порядок

Для behavior-changing implementation:

```text
testCheck
  -> RED observed for the intended reason
  -> minimal implementation
  -> GREEN on the same check
  -> bounded REFACTOR while the same check stays green
  -> supporting trace
  -> /aif-verify <change-id>
```

Для выбранного fix finding:

```text
rootCauseEvidence
  -> one falsifiable hypothesis
  -> smallest experiment
  -> exact regressionCheck before edit
  -> smallest root-cause fix
  -> identical regressionCheck after edit
  -> supporting trace
  -> /aif-verify <change-id>
```

## См. также

- [Usage](usage.md)
- [Context Loading Policy](context-loading-policy.md)
- [Codex Agents](codex-agents.md)
- [Claude Agents](claude-agents.md)
