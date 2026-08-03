# Proposal: Сохранить live-оценку context-mode для issue #134

## Original Request

"Да, сделай"

## Plan Metadata

- Change ID: `persist-context-mode-live-evaluation-issue-134`
- Branch: `feature/reevaluate-context-mode-codex-plugin-issue-134`
- Created: 2026-08-03
- Mode: follow-up OpenSpec change после архивированного `reevaluate-context-mode-codex-plugin-issue-134`

## Settings

- Testing: yes; regression-тесты harness и повторяемые sanitized contracts для baseline, MCP-only и Codex plugin
- Logging: standard; только `[FIX:134]` events, anonymous row IDs и bounded status/reason fields
- Docs: yes; append-only live evidence и исправленная рекомендация без raw traces, credentials или absolute paths
- Delivery: один scoped commit; push не входит в этот change без отдельной команды пользователя

## Why

Архивированный change корректно сохранил fail-closed dry-run evidence, но последующая явно разрешённая isolated live-проверка не была записана в repository. Поэтому tracked artifacts всё ещё показывают MCP как `BLOCKED(runtime_dependency_self_install)` и plugin как `NOT_RUN(auth_isolation_unavailable)`, хотя отдельный disposable run подтвердил lifecycle и выявил более точные продуктовые ограничения.

Live-run также обнаружил дефекты harness: baseline matcher не распознаёт quoted PowerShell `rg`, generated fixture слишком мала для проверки truncation, nested MCP calls не видны в верхнеуровневом `ai-tester` trace, `no_path_escape` не проверяет их arguments, `ctx_search` использует устаревший singular payload, wrapper может выбрать Windows Store shim, а resume теряет execution parity. Без исправления этих дефектов повторный запуск либо даёт false negative, либо создаёт неподтверждённые claims.

## What Changes

- Добавить explicit test-only authorization envelope. Без него provider rows остаются `BLOCKED`/`NOT_RUN`; с ним допускается только exact pinned snapshot, disposable sandbox, scoped ephemeral auth и native Codex executable.
- Исправить MCP contract на актуальный `queries` payload и запретить shell shim для actual plugin lifecycle.
- Исправить baseline command matcher и генерировать реальный large-output fixture (>1 MiB), не сохраняя большой content в catalog или tracked matrix metadata.
- Добавить внешний raw Codex rollout audit для nested provider tool calls и path confinement. Верхнеуровневый `ai-tester` trace остаётся источником costs/correctness, но больше не считается достаточным доказательством MCP usage.
- Не выдавать broken `ai-tester` resume за continuity evidence: отсутствие cwd/permission parity получает явный `NOT_RUN(resume_driver_parity_unavailable)` до исправления upstream runner.
- Сохранить sanitized append-only live evidence в `.ai-factory/state/persist-context-mode-live-evaluation-issue-134/evaluation/` и обновить public guidance.

## Capabilities

### Modified Capabilities

- `context-providers`: дополняется bounded authorization, raw rollout audit и durable live-evidence contract для context-mode Codex evaluation.

## Scope

In scope:

- Только test/evaluation harness для `context-mode v1.0.169`, Codex CLI `0.144.6`, `ai-tester 1.1.0`, `gpt-5.6-luna` и `reasoning: low`.
- Regression tests для authorization defaults/override, native executable, MCP payload, quoted baseline command, large fixture, raw nested tool/path audit и resume fail-closed behavior.
- Sanitized aggregate результатов уже выполненного isolated run: lifecycle, small-output comparison, large-output correctness comparison и failed continuity attempt.
- Append-only clarification existing docs; historical `1.0.151` и archived `v1.0.169` evidence не переписываются.

Out of scope:

- Повторная установка provider в user environment, mutation настоящего `CODEX_HOME`, автоматическая установка/регистрация hooks или MCP.
- Commit raw `ai-tester` traces, Codex rollouts, provider databases, fixture bodies, credentials, auth fingerprints или absolute temp/user paths.
- Исправление user-owned `ai-tester` source checkout; локальный resume defect фиксируется как explicit limitation.
- Продвижение context-mode в automatic recommendations или canonical/QA dependency.
- Изменение архивированного OpenSpec change или accepted historical evidence in place.

## Acceptance Criteria

- Новый OpenSpec change проходит strict validation и не изменяет archived change.
- Default matrix сохраняет fail-closed gates; provider rows становятся executable только при полном explicit authorization envelope.
- MCP contract отправляет `ctx_search` как `queries: [...]` и regression test проверяет exact payload.
- Actual plugin lifecycle принимает только native executable; `.cmd`/`.bat` shim получает deterministic `NOT_RUN(native_codex_executable_required)`.
- Baseline matcher распознаёт quoted PowerShell invocation, а large scenario генерирует >1 MiB stdout fixture с facts после truncation boundary.
- Provider PASS требует separate raw Codex rollout audit: expected nested tools присутствуют, forbidden tools отсутствуют, все path arguments confined to sandbox.
- Если resume parity не доказана, continuity остаётся `NOT_RUN`, а не PASS.
- Durable JSON не содержит credentials, raw content, absolute paths или auth hashes и сохраняет exact versions, aggregate metrics, outcomes и limitations.
- Focused tests, docs contracts, `npm run validate`, `npm test`, `git diff --check`, strict OpenSpec validation и AIF verification проходят.

## Impact

- Изменяемые modules: `scripts/context-mode-codex-ai-tester-{adapter,matrix,run,results}.mjs` и их tests.
- Изменяемые artifacts: scenario catalog, context-mode research/benchmark/public guidance и change-scoped sanitized state.
- Runtime AIFHub commands и provider selection не меняются.

## Suggested Next Command

`/aif-implement persist-context-mode-live-evaluation-issue-134`
