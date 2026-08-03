# Результаты Тестов context-mode

Этот файл содержит evidence по `context-mode`. Описание инструмента и политика использования находятся в [context-mode.md](context-mode.md).

Важно: recommendation benchmark считается только по paired `ai-tester` runs `rg baseline` vs `context-mode tool_run`. Field runs ниже являются safety/availability evidence и не заменяют ai-tester.

## Методика

`context-mode` проверялся как temporary output index. Source files не индексировались. Для каждого profile использовался отдельный `CONTEXT_MODE_DIR`, затем выполнялся purge.

Сравнение с `rg` как source retrieval неприменимо: `context-mode` полезен только если уже есть большой generated output, который нужно временно индексировать.

## AI Tester Pilot 2026-05-28

Raw artifact: `.ai-factory/state/ai-tester-matrix-for-memory-tool-metadata/screening-context-mode-ai-tester-pilot-v2/ai-tester-token-matrices.json`.

Пилотный paired run: `screening-context-mode-ai-tester-pilot-v2`, `aif-explore`, task `large_command_output_compression`, profile labels `no-primary-language ; mini ; mini ; single_repo ; none ; small_microservice`. `context-mode` был подготовлен через `fixtures.setup_commands` как project-local npm package.

| run | status | duration | tool calls | total tokens | input tokens | output tokens | input+output tokens |
|---|---|---:|---:|---:|---:|---:|---:|
| `rg baseline` | PASS | 112.9s | 1 | 197,700 | 98,703 | 949 | 99,652 |
| `context-mode tool_run` | FAIL | 864.8s | 55 | 13,649,162 | 6,895,854 | 41,884 | 6,937,738 |

Дельта `context-mode` против `rg` для этого failed tool_run:

| metric | delta |
|---|---:|
| duration | +666.0% |
| tool calls | +5400.0% |
| total tokens | +6804.0% |
| input tokens | +6886.5% |
| output tokens | +4312.4% |
| input+output tokens | +6862.0% |

Причина `FAIL`: model смог использовать package и MCP-style path через generated Node script, но не выполнил ожидаемый direct `context-mode doctor/ctx_index/ctx_search` command pattern. Даже без учета assertion fail, overhead экстремальный. Этот row не считается useful evidence; он подтверждает, что сценарий нужно сузить до уже существующего большого generated output, а не mini fixture.

## AI Tester Cross Screening 2026-05-28

Raw artifact: `.ai-factory/state/ai-tester-matrix-for-memory-tool-metadata/cross-context-mode-ai-tester/ai-tester-token-matrices.json`.

Reduced cross run был запущен для `aif-analyze` на `large_framework_app` и `multirepo` labels. Прогон остановлен как partial после зависшего context-mode tool_run; зависшие child processes были завершены вручную. Это не positive evidence, а negative/partial cross evidence.

| project | labels | skill | run | status | duration | tool calls | total tokens | input tokens | output tokens | input+output tokens |
|---|---|---|---|---|---:|---:|---:|---:|---:|---:|
| matrix-profile-04 | `js+go ; standard ; framework ; single_repo ; legacy_ai_factory_only ; large_framework_app` | `aif-analyze` | `rg baseline` | PASS | 135.6s | 4 | 381,471 | 219,175 | 1,528 | 220,703 |
| matrix-profile-04 | same | `aif-analyze` | `context-mode tool_run` | TIMEOUT | 1200.0s | n/a | n/a | n/a | n/a | n/a |
| matrix-profile-05 | `js ; standard ; framework ; monorepo ; legacy_ai_factory_only ; multirepo` | `aif-analyze` | `rg baseline` | PASS | 163.2s | 12 | 1,327,682 | 664,218 | 3,624 | 667,842 |
| matrix-profile-05 | same | `aif-analyze` | `context-mode tool_run` | FAIL | 607.4s | 60 | 9,981,024 | 5,081,469 | 39,139 | 5,120,608 |

Дельта для завершенного FAIL row против `rg`: duration +272.2%, tool calls +400.0%, total tokens +651.8%, input+output tokens +666.7%.

Cross вывод: context-mode не показывать как project/source analysis helper даже на non-mini labels. Его допустимая область остается уже созданный большой generated output, где пользователь явно хочет temporary index и принимает purge/overhead.

## AI Tester Python OpenSpec Cross 2026-05-28

Raw artifact: `.ai-factory/state/ai-tester-matrix-for-memory-tool-metadata/model-gen-all-tools-grouped-clean-20260528-212755/ai-tester-token-matrices.json`.

Полный отчет: [AI Tester Token Matrices: Python OpenSpec All Tools](ai-tester-token-matrices-python-openspec-all-tools.md).

Labels: `python`, `standard`, `framework`, `single_repo`, `openspec_native`, `large_framework_app`. Task: `architecture_or_impact_discovery`.

| Metric | Value |
|---|---:|
| Rows | 20 |
| `rg baseline` rows | 10 |
| context-mode positive usage rows | 0 |
| context-mode negative policy rows | 8 |
| context-mode not-applicable rows | 2 |
| PASS rows | 20 |

Вывод: context-mode не был выбран для source/project discovery. Некоторые `tool_run` rows в raw matrix выглядят дешевле `rg`, но это negative/not-applicable сценарии, где ai-tester проверял запрет запуска `context-mode`; такие rows нельзя считать полезностью инструмента.

## Safety Probe: Controlled MCP Test

| Проверка | Результат |
|---|---:|
| Indexed explicit text source | PASS |
| `ctx_search` found canary | PASS |
| `ctx_purge({ confirm: true, scope: "project" })` | PASS |
| Knowledge base empty after purge | PASS |
| Total live test time | 1,922 ms |
| `ctx_stats` entered context | 582 B |

## Safety Field Evidence: Anonymous Profiles 2026-05-22

Проверка индексировала только anonymous profile summary + canary.

| Shape | Profiles | Indexed Tokens | Index Time | Search Time | Found | Очистка | Решение |
|---|---:|---:|---:|---:|---|---|---|
| `go_service` | 1 | ~43 | 59 ms | 8 ms | yes | PASS | Manual helper для generated output. |
| `large_framework_app` | 4 | ~46-50 | 41-49 ms | 6-8 ms | yes | PASS | Manual helper для generated output. |
| `large_legacy` | 1 | ~43 | 38 ms | 7 ms | yes | PASS | Manual helper для generated output. |
| `small_microservice` | 4 | ~42-54 | 35-40 ms | 6-7 ms | yes | PASS | Обычно overhead не нужен. |
| `multirepo` | 3 | ~37-50 | 38-46 ms | 6-8 ms | yes | PASS | Manual helper для selected output. |

## Safety Field Evidence: Real Project Roots 2026-05-23

Индексировались только generated profile summaries из `rg` baseline, без snippets, local paths и secrets.

| Profile | Shape | MCP Connect | `ctx_index` | `ctx_search` | `ctx_purge` | Результат | Решение |
|---|---|---:|---:|---:|---:|---|---|
| real-profile-01 | `large_legacy_web_app` | 3.36 s | 83 ms | 8 ms | 121 ms | PASS | Manual helper только для generated output. |
| real-profile-02 | `go_service` | 1.55 s | 36 ms | 7 ms | 9 ms | PASS | Manual helper только для generated output. |
| real-profile-03 | `large_framework_app` | 1.69 s | 39 ms | 7 ms | 8 ms | PASS | Manual helper только для generated output. |
| real-profile-04 | `multi_app_workspace` | 2.29 s | 40 ms | 7 ms | 8 ms | PASS | Manual helper только для generated output. |
| real-profile-05 | `small_microservice` | 1.73 s | 46 ms | 8 ms | 10 ms | PASS | Обычно не нужен для малых проектов. |

## Safety Field Run 2026-05-24

Прогон через `scripts/memory-tool-field-run.mjs` на 55 sanitized temp profiles.

| Проверка | Результат |
|---|---:|
| Версия | `context-mode 1.0.151` |
| `context-mode doctor` | PASS |
| MCP initialize | PASS |
| `ctx_index` generated rg summary | PASS |
| Indexed input size | 11,417 chars |
| `ctx_search` | PASS |
| `ctx_purge scope=project` | PASS |
| Source indexing | no |
| Hooks/setup/MCP registration | no |

## AI Tester Path-Hash Generated Output 2026-06-11

Raw artifact: `.ai-factory/state/ai-tester-tool-evaluations/cm-p8d97432e-out-ae-1851/ai-tester-token-matrices.json`.

Project id: `project-8d97432e6d7a`. Labels: `framework`, `js`, `large_framework_app`, `legacy_ai_factory_only`, `php`, `single_repo`, `standard`. Task: `large_command_output_compression`. Skills: `aif-analyze`, `aif-explore`.

| rows | pass/pass pairs | total tokens | input+output tokens | duration | decision |
|---:|---:|---:|---:|---:|---|
| 4 executed, 2 FAIL | 0/2 | +487.6% | +449.6% | +206.0% | no promotion |

Tool-run rows did not produce a valid useful `context-mode` data call: one run stopped at `context-mode --help`, the other did not call `context-mode`. This focused scenario remains manual-helper evidence only and is not eligible for `proven_label_evidence`.

## Codex Plugin Re-evaluation v1.0.169 — 2026-07-28

Run id: `context-mode-134-luna-low-20260728`. Exact identity: tag `v1.0.169`, commit `589d8214d56740a28b5f7bf63167743d586b0b40`, npm shasum `d5aa9acc648ed420c5dd32ee5f15aa5608f09fea`, package integrity `sha512-94JIaFuLjF9SO2BsGTrbGtyT44K95+9OC8BdbaL/UT76xOkanJLfUR5CzmNw+GELXZQqH4nBrKg9wjBnSFkVnQ==`.

| Evidence class | Rows / probes | Status | Reason |
|---|---:|---|---|
| `plugin_snapshot_isolated` | 1 | PASS | Exact tag/commit/package/manifests/license/Node floor and tarball shasum matched. |
| install lifecycle | 0 | `NOT_RUN(postinstall_forbidden)` | Upstream package declares mutating `postinstall`; lifecycle scripts were never executed. |
| `ai-tester` dry-run | 18/18 | PASS | Three scenarios × baseline/MCP-only/plugin × two repetitions; `codex`, `gpt-5.6-luna`, `low`. |
| baseline model rows | 0/6 | `NOT_RUN(isolated_codex_execution_unavailable)` | Isolated `CODEX_HOME` probe failed before a trace; no real auth/config was copied. |
| MCP-only rows | 0/6 | `BLOCKED(runtime_dependency_self_install)` | Hook/server bootstrap can run `npm install` and shell at runtime. |
| Codex plugin rows | 0/6 | `NOT_RUN(auth_isolation_unavailable)` | No credential-safe isolated auth mechanism was available. |
| direct hook runtime | 0 | `BLOCKED(runtime_dependency_self_install)` | Static safety veto ran before provider code. |
| `direct_hook_contract` | focused adapter tests | PASS | Test-only event/redaction/isolation contract; not actual Codex event delivery. |
| host manifests / sandbox cleanup | 1 | PASS | Project Git, Codex plugin/cache and provider-home fingerprints were unchanged; disposable package/runtime roots were removed. |

Token, duration and quality deltas are not reported: there are no complete executed triads. Resource savings cannot be inferred from dry-run or direct adapter tests. Actual compaction remains `NOT_RUN(compaction_control_unavailable)`.

Current decision is split:

- historical MCP-only `1.0.151` manual-helper evidence is preserved without rewriting;
- current `v1.0.169` MCP/runtime path is blocked pending removal or containment of runtime self-install;
- Codex plugin is deferred and remains user-owned; no auto-install, registration, hook trust or normal-command selection is authorized.

## Authorized Live Follow-up v1.0.169 — 2026-08-03

Этот append-only follow-up не меняет исторические статусы выше. Он использовал отдельную test-only authorization class `explicit_isolated_full`, disposable homes, scoped ephemeral auth copy и native Codex executable. Host auth/manifests остались неизменными, auth copies были удалены; package install lifecycle не исполнялся и остаётся `NOT_RUN(postinstall_forbidden)`.

Exact runtime identity: `context-mode 1.0.169` / commit `589d8214d56740a28b5f7bf63167743d586b0b40`, Codex `0.144.6`, `ai-tester 1.1.0` / commit `98dd5afb3fe9b9b7593d21dc93bcbc6d98c2cca9`, model `gpt-5.6-luna`, reasoning `low`. Санитизированный artifact: [live-authorized-evidence.json](../../.ai-factory/state/persist-context-mode-live-evaluation-issue-134/evaluation/live-authorized-evidence.json).

Lifecycle/provenance gates:

| Gate | Status |
|---|---|
| exact package/binary identity | PASS |
| marketplace prepare/add, plugin add, Codex exec | PASS |
| provider purge and sandbox cleanup | PASS |
| host manifests/auth unchanged, auth copies remaining | PASS / `0` |
| package install lifecycle | `NOT_RUN(postinstall_forbidden)` |
| generated `ai-tester` matrix dry-run | 18/18 parsed, 0 invalid |

Small fixture (`north=17`, `east=29`, checksum `46`):

| Variant | Correctness | Input | Output | Total | Duration | Delta vs baseline |
|---|---|---:|---:|---:|---:|---|
| baseline | PASS | 89,462 | 347 | 89,809 | 28,240 ms | — |
| MCP-only | PASS | 427,326 | 895 | 428,221 | 42,592 ms | `+376.8%` tokens, `+50.8%` duration |
| plugin | excluded | — | — | — | — | probe output crossed the privacy boundary; not accepted evidence |

Large deterministic stdout fixture contained `12,009` lines and exceeded `1 MiB`; required facts were at the tail (`north=731`, `east=409`, checksum `1140`):

| Variant | Correctness | Input | Output | Total | Duration | Delta vs failed baseline |
|---|---|---:|---:|---:|---:|---|
| baseline | FAIL | 31,371 | 677 | 32,048 | 26,233 ms | tool result stopped at 1,048,576 bytes; tail facts absent |
| MCP-only | PASS | 69,924 | 655 | 70,579 | 22,775 ms | `+120.2%` tokens, `-13.2%` duration |
| Codex plugin | FAIL | 93,875 | 582 | 94,457 | 39,833 ms | `+194.7%` tokens, `+51.8%` duration |

Raw rollout audit verified real nested MCP calls and confined path arguments: the useful large MCP row called `ctx_batch_execute` plus `ctx_purge`; the plugin probe called `ctx_search`, but its knowledge base was empty and the nested shell output remained truncated. Provider rows cannot PASS without both outer correctness evidence and sanitized raw rollout call/path evidence.

Session continuity is not promoted. The first MCP turn recovered the facts, but the resume answer was incorrect; the reproducible matrix therefore records `NOT_RUN(resume_driver_parity_unavailable)` until its resume driver has execution parity.

Live conclusion:

- MCP-only improves correctness only in the tested large-output truncation case; it does **not** demonstrate billed-token savings.
- On the small fixture it was both slower and `+376.8%` more token-expensive.
- The Codex plugin should be avoided for the tested nested shell stack because hooks did not intercept that output path.
- This remains `manual_helper_only`, explicit user opt-in, temporary scope plus mandatory purge. Normal AIFHub commands keep no-auto-install/no-registration/no-hook-trust behavior.

## Когда Использовать

Лучшие signals:

- output одной или нескольких команд слишком большой;
- нужно временно задавать вопросы по generated summary;
- задача exploratory, а не validation/implementation.

Сильные стороны:

- быстрый index/search/purge для explicit text;
- purge validated;
- работает независимо от языка проекта.

## Когда Не Использовать

Плохие labels/signals:

- `mini`, `small_microservice`;
- exact source lookup;
- source-code indexing;
- protected validation artifacts;
- tasks: implement/fix/verify/done/commit.

Слабые стороны:

- широкий MCP surface включает command execution;
- все explicit indexed content становится retrievable;
- польза не доказана для project source retrieval;
- для малых проектов overhead не нужен.

## Итог

`context-mode` может быть полезен только как manual temporary index для уже большого generated output. Live follow-up подтвердил один correctness benefit при >1 MiB truncation, но не token savings; small fixture показал большой overhead, а tested Codex plugin path не сработал.
