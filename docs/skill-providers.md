[Предыдущая страница](context-providers.md) | [К документации](README.md) | [Следующая страница](memory-tool-recommendations.md)

# Провайдеры Навыков

Skill provider меняет способ, которым агент выбирает и реализует решение. Это более сильное влияние, чем optional context provider: даже instruction-only skill может менять scope decisions, количество тестов, форму отчёта и выбор между уже принятым требованием и более короткой альтернативой.

AIFHub рассматривает внешние skills и plugins только как user-owned optional behavior. Их отсутствие всегда является normal degraded behavior и не должно блокировать `/aif-explore`, `/aif-plan`, `/aif-improve`, `/aif-implement`, `/aif-review`, `/aif-security-checklist`, `/aif-verify`, `/aif-fix`, `/aif-done`, `/aif-commit` или любую другую AIFHub command.

## Текущая Policy

| Candidate | Reviewed source | Policy | Разрешённая роль |
|---|---|---|---|
| [DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail) | [`v4.9.0`](https://github.com/DietrichGebert/ponytail/tree/v4.9.0), commit [`0a4dd63ad4541f4f655c4108a295916f3c1d8fda`](https://github.com/DietrichGebert/ponytail/commit/0a4dd63ad4541f4f655c4108a295916f3c1d8fda) | `manual_experiment_only` | Явно выбранный implementation-only experiment в отдельной сессии; не default recommendation и не AIFHub gate |

Текущий status не добавляет Ponytail в `extension.json`, extension dependencies, recommendation metadata, `/aif-analyze` output или `/aif-implement` instructions. Promotion требует собственного paired AIFHub benchmark; upstream numbers сами по себе для этого недостаточны.

## Что Было Проверено

Reviewed Ponytail `v4.9.0` является MIT-licensed multi-host package. Его Codex/Claude plugin manifest публикует шесть skills и lifecycle hooks для `SessionStart`, `SubagentStart` и `UserPromptSubmit`.

Основной `ponytail` skill:

- объявляет применение к любым coding tasks, включая implementation, fix, review и design;
- включает `full` mode по умолчанию и требует сохранять режим между responses;
- предпочитает YAGNI, существующий project code, standard library, native platform features и минимальный working diff;
- отдельно запрещает сокращать trust-boundary validation, data-loss error handling, security, accessibility и явно запрошенное поведение;
- ограничивает обычное объяснение тремя короткими строками и предлагает один runnable check для non-trivial logic.

Plugin hooks делают это поведение session-wide, а не только skill-on-demand. `PONYTAIL_SUBAGENT_MATCHER` может сузить injection по `agent_type`, но matcher intentionally fails open: missing/unparseable agent type, invalid regex или timeout приводят к injection. Это useful convenience, но не isolation boundary.

Official Codex documentation подтверждает, что [skills могут выбираться явно или автоматически по description](https://learn.chatgpt.com/docs/build-skills), а local skills из разных scopes могут сосуществовать без merge. [Plugin hooks требуют отдельного review и trust](https://learn.chatgpt.com/docs/plugins). Поэтому distinct Ponytail и `aif-*` skill names технически могут сосуществовать, но это не устраняет semantic conflict между always-on minimalism и AIFHub lifecycle contracts.

## Evaluation Evidence

Локальная evaluation от `2026-09-01` использовала exact tag `v4.9.0`, а не floating `main`.

| Check | Result | Evidence boundary |
|---|---|---|
| Git/package custody | `PASS` | Tag, exact commit, package version `4.9.0` и MIT license совпадают |
| Static skill/plugin review | `PASS` | Проверены canonical `SKILL.md`, plugin manifest, mode resolution и session/subagent hook paths |
| Non-Python package/hook subset | `PASS` | 35/35 selected Node tests: behavior, commands, hooks, Windows hooks, OpenCode, package, package scripts и Qoder |
| Full upstream `npm test` | `PARTIAL` | 72/82 root tests passed; 10 Python-backed correctness/Hermes tests не смогли запуститься, потому что evaluation host не имел `python`. Subproject test tail поэтому не стартовал; full-package PASS не заявляется |
| Upstream benchmark self-test | `NOT_RUN(local_python_unavailable)` | Published benchmark method и scorers были source-reviewed, но не reproduced |
| Paired Pi implementation proxy | `EXECUTED(mixed_non_promotable)` | [Six complete 24-case runs](skill-providers-research/ponytail-pi-ab/results.md) pin `pi 0.84.4`, `omniroute/lq/qwen3.8-27b`, `omniroute/la/ornith-1.5-35b-a3b`, `omniroute/bai/mimo-v2.5`, `omniroute/bai/glm-5.3-flash`, `omniroute/bai/deepseek-v4-flash`, and `omniroute/bai/qwen3.8-flash`, three real-project commits, four repetitions per arm and hidden graders. Qwen moved from 6/12 baseline PASS to 8/12 with Ponytail; LA moved from 11/12 to 9/12 raw with one LA provider-error pair excluded; GLM moved 11/12→10/12; DeepSeek was all-fail; BAI Qwen3.8 was 7/12→8/12. Go improved, Laravel regressed overall, and the proxy does not support promotion |
| Paired AIFHub OpenSpec implementation | `NOT_RUN(dedicated_isolated_runner_required)` | Нет baseline/candidate runs на одном canonical change, поэтому AIFHub LOC/token/time benefit не заявляется |
| AIFHub review/security/verify parity | `NOT_RUN` | Нет evidence, что findings, gate status или fix-cycle count сохраняются |

Selected hook tests подтверждают packaging mechanics, но не качество model output. Upstream benchmark подтверждает только собственный tested envelope; local evaluation не повторяла его model calls и не переносит результат автоматически на AIFHub.

## Почему `100% safe` Не Равен AIFHub Security PASS

[Upstream agentic report](https://github.com/DietrichGebert/ponytail/blob/v4.9.0/benchmarks/results/2026-06-18-agentic.md) сообщает 20/20 successful adversarial checks для Ponytail: пять security tasks по четыре runs. Scorers проверяли конкретные behaviors вроде path traversal, parameterized SQL, forged HMAC token, malformed CSV и per-client rate limiting. Сам report называет этот набор floor, а не proof of security.

Это полезный signal против naive code golf, но не эквивалент AIFHub `/aif-security-checklist`: upstream scorers не выполняют semantic review всего changed scope и не покрывают полный набор project-specific auth, authorization, secrets, permissions, injection, dependency и data-flow risks. Поэтому:

- Ponytail benchmark result не может создавать или заменять `aif-gate-result`;
- `/aif-review`, `/aif-security-checklist` и `/aif-verify` выполняются независимо;
- отсутствие findings в Ponytail review не является AIFHub evidence;
- provider availability или mode никогда не входят в done/readiness policy.

## OpenSpec И Instruction Boundary

Ponytail можно применять только после того, как AIFHub уже разрешил active change и прочитал canonical artifacts. Внутри такого experiment authority остаётся следующей:

1. explicit user request, canonical OpenSpec requirements, accepted design и selected `tasks.md` task;
2. source/tests, project rules, accepted architecture и generated implementation guidance;
3. AIFHub artifact ownership, required checks, required reports и handoff contracts;
4. Ponytail preference между несколькими решениями, которые одинаково удовлетворяют всем более высоким constraints.

Ponytail не может решать, что canonical task «не нужен», заменять explicitly requested behavior более узкой версией, under-specify delta specs, переписывать `proposal.md`/`design.md`/`tasks.md`, сокращать required test matrix до одного check или опускать обязательные AIFHub report fields. Если host не может сохранить этот boundary, Ponytail следует выключить.

`/aif-implement` продолжает выполнять ровно один task или tightly coupled task group. Shortest diff выбирается только внутри этого resolved scope. `ultra` mode не рекомендуется для AIFHub experiments: его aggressive YAGNI behavior создаёт лишний риск scope reduction.

## Разрешённый Manual Experiment

Самый безопасный current pattern:

1. Пользователь независимо pins, reviews и устанавливает provider по upstream instructions. AIFHub command ничего не устанавливает и не trusts hooks.
2. `/aif-plan` и `/aif-improve` завершают canonical artifacts без Ponytail influence.
3. Пользователь создаёт отдельную implementation-only session или disposable worktree, оставляет default mode `off` и явно включает Ponytail только после resolution одного `/aif-implement <change-id>` task.
4. После implementation provider выключается или session завершается до `/aif-rules-check`, `/aif-review`, `/aif-security-checklist`, `/aif-verify`, `/aif-fix`, `/aif-done` и `/aif-commit`.
5. Полный diff и все normal AIFHub gates проверяются так же, как без provider.

Если host использует `PONYTAIL_SUBAGENT_MATCHER` для `aifhub-implement-worker`, это только best-effort scope hint. Сначала нужно подтвердить фактический host `agent_type`; fail-open matcher нельзя использовать как доказательство того, что explore/review/security sidecars не получили instructions.

Standalone explicit skill без lifecycle hooks предпочтительнее always-on plugin, когда host позволяет отключить implicit invocation. Codex поддерживает user-owned skill disable/explicit-invocation policy, но AIFHub не создаёт и не меняет эту config за пользователя.

`ponytail-review` может дать дополнительный delete-list после implementation, но остаётся supporting opinion. Он не заменяет `/aif-review`, не закрывает findings и не авторизует code deletion вне selected task.

## Promotion Benchmark

Перед status `recommended_optional` нужен reproducible paired test:

- exact pinned Ponytail source, agent runtime, model, reasoning settings и AIFHub version;
- baseline и candidate на fresh isolated copies без global plugin contamination;
- одинаковые canonical OpenSpec artifacts, task input, repository revision и tool permissions;
- минимум четыре runs на arm для over-build-shaped change и отдельного security- или correctness-sensitive change;
- source LOC/files, new dependencies, tokens, cost и duration;
- requirement/task completeness, canonical artifact diff, required report completeness и tests;
- `/aif-review` findings, `/aif-security-checklist` findings, `/aif-verify` result и `/aif-fix` cycle count.

Promotion возможен только если candidate даёт stable reduction без ухудшения completeness, tests, findings или gate status, без canonical mutations и без пропуска required output. Contaminated, single-run, provider-authored-only или unpinned evidence не меняет policy.

[Ponytail Pi A/B Scenarios](skill-providers-research/ponytail-pi-ab/README.md) реализуют implementation-only proxy этого контракта: три exact-commit копии реальных TypeScript, Go и Laravel/PHP проектов, расширенный model-envelope (Qwen/LA/MIMO/GLM/DeepSeek/Qwen3.8) и независимые hidden graders. [Выполненные 144 строки](skill-providers-research/ponytail-pi-ab/results.md) показали model- и stack-dependent результат: на 71 сопоставимой паре baseline прошёл 34, Ponytail — 36, Go улучшился с 4/8 до 8/8, Laravel ухудшился с 4/11 до 2/11. Один LA provider-error случай исключён, а efficiency считается только по both-pass парам. Набор намеренно не запускает AIFHub lifecycle sidecars, поэтому policy остаётся `manual_experiment_only`.

## Границы AIFHub

AIFHub Extension не должен:

- install, update, clone или bundle Ponytail files;
- добавлять Ponytail в extension/plugin/package dependencies или recommendation metadata;
- запускать provider setup, install, uninstall, mode или audit commands;
- регистрировать, enable, trust или менять lifecycle hooks;
- менять user/global `AGENTS.md`, agent rules, skills, plugin settings или runtime config для provider;
- auto-inject Ponytail в `/aif-implement`, worker, fixer или любой другой command;
- считать provider availability, mode, output или upstream benchmark validation/review/security/verify/done evidence;
- сохранять raw hook output, prompts, transcripts или provider state в canonical OpenSpec, generated rules, runtime QA или validation artifacts.

## См. Также

- [Usage](usage.md)
- [Context Providers](context-providers.md)
- [Context Loading Policy](context-loading-policy.md)
- [Codex Agents](codex-agents.md)
- [Claude Agents](claude-agents.md)
