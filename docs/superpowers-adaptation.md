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
| Качество тестов | Перед добавлением или изменением проверки implement/fix называет обнаруживаемый дефект и получает ожидаемый результат независимо от production-кода. Бессодержательное assertion на собственном helper или наличии mock не считается достаточным доказательством поведения. |
| Ожидание готовности | Вместо увеличения sleep используется наблюдаемое условие с конечным deadline; проверяется также отсутствие готовности. Проверки debounce, throttle и других временных требований сохраняют точные временные границы. |
| Конфликты задач до исполнения | Координатор сопоставляет задачи с общими файлами/интерфейсами и внутреннюю согласованность каждой задачи до edits/dispatch. Совместимые правки можно упорядочить; противоречивый scope возвращается владельцу plan/improve. |
| Небольшие однотипные batches | Явный перечень task IDs, файлов, ожидаемых изменений и проверок разрешает один ограниченный batch независимых задач. Результат принимается по каждому элементу; четыре выполненных из пяти не закрывают пятый. |
| Scoped re-review | Fixer передаёт finding IDs и точные версии до/после исправления. Reviewer проверяет каждый finding и новые регрессии во всём fix diff; неполные данные, новый дефект или лимит раундов не дают автоматический PASS. |

Implementation evidence пишется только в:

```text
.ai-factory/state/<change-id>/implementation/
```

Fix evidence пишется только в:

```text
.ai-factory/state/<change-id>/fixes/
```

Эти traces не становятся canonical OpenSpec content, generated rules, QA verdict или done evidence.

Качество тестов и ожидания определены в [общем файле скиллов TEST-QUALITY.md](../skills/shared/TEST-QUALITY.md). Его загружают implement/fix injections и все четыре Claude/Codex implement/fix agents после разрешения локального выполнения. Правила действуют в OpenSpec-native и classic legacy режимах; marker-first ultra delegation и существующий `fallbackDecision` сохраняются. В установленном проекте файл находится внутри `.ai-factory/extensions/aifhub-extension/`, а не в новом consumer-owned дереве правил.

Для OpenSpec-native named defect и источник ожидаемого результата дополняют существующие `testCheck`/`regressionCheck`; classic legacy использует свои текущие execution/fix evidence. Новая trace schema или отдельный QA gate не создаются. Выполнение mutation check не обязательно: если оно полезно, дефект воспроизводят только в disposable fixture/copy, а рассуждение не выдают за запуск.

## Осознанные границы

[TASK-COORDINATION.md](../skills/shared/TASK-COORDINATION.md) загружается координатором `/aif-implement` после classification и чтения canonical tasks, до implementation edits/dispatch. Исполнители Claude/Codex используют только назначенный scope и возвращают поэлементные результаты. Preflight учитывает интерфейсы между разными файлами и повторяется для затронутых связей при изменении исходного плана или diff. Пересечение одного файла само по себе не блокирует работу. Зависимые задачи не выдаются за независимый batch.

[SCOPED-REVIEW.md](../skills/shared/SCOPED-REVIEW.md) подключён к `/aif-fix`, `/aif-review` и обеим парам agents. Для uncommitted fixes требуются обозначенные снимки до/после и соответствующий patch; пустой HEAD-to-HEAD diff не доказывает отсутствие правок. Review sidecar без shell получает привязанные к версии материалы от родителя и не заявляет запуск Git/тестов. Re-review остаётся read-only, возвращает `ADDRESSED`/`NOT ADDRESSED` с доказательством для каждого исходного ID и один существующий gate result. Неполный набор материалов даёт WARN либо сохраняет FAIL известного blocker. Обычный full review и явно требуемый независимый review сохраняют свой scope.

Оба файла находятся в `skills/shared/` установленного AIFHub extension. Результаты используют существующие execution/fix notes или response, не вводя SessionBrief, receipt schema, новый canonical path или QA gate из области #168.

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

Для coordination и scoped re-review этот contract также проверяет доступность shared source assets по установленным путям всех девяти consumers и парность трёх новых блоков agents. Он не исполняет реального агента и не доказывает обнаружение произвольного конфликта или корректность review-решений модели.

Поведение рендерера отдельно покрывает `scripts/openspec-execution-context.test.mjs`: полный development cycle, компактный fallback-only trace, fix evidence и type-scoping между Implementation/Fix. Authoritative валидация результата по-прежнему принадлежит `/aif-verify`.

`scripts/superpowers-test-quality-examples.test.mjs` исполняет точные JavaScript-примеры из [shared reference](../skills/shared/references/test-quality-examples.md): правильную реализацию и два дефекта округления, немедленную/задержанную/отсутствующую готовность, границу deadline и его превышение, ошибки predicate и неподходящий async predicate. Управляемое время исключает зависимость от скорости машины. Эти проверки доказывают поведение примеров; они не являются оценкой соблюдения инструкций произвольной моделью. Contract-тест отдельно проверяет подключение shared policy во всех шести consumers и парность agents.

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

- [Повторная проверка Superpowers и адаптация пяти предложений](superpowers-follow-up-research.md) — состояние upstream на 2026-09-05, исходные пробелы, реализованные инструкции и границы проверки.
- [Usage](usage.md)
- [Context Loading Policy](context-loading-policy.md)
- [Codex Agents](codex-agents.md)
- [Claude Agents](claude-agents.md)
