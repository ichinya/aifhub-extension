# agentmemory (rohitg00)

Tool ID: `rohitg00-agentmemory`

Репозиторий: [rohitg00/agentmemory](https://github.com/rohitg00/agentmemory)

Пакеты: [`@agentmemory/agentmemory`](https://www.npmjs.com/package/@agentmemory/agentmemory), [`@agentmemory/mcp`](https://www.npmjs.com/package/@agentmemory/mcp)

Issue boundary: [ichinya/aifhub-extension#114](https://github.com/ichinya/aifhub-extension/issues/114)

Результаты static audit и границы непроведённого runtime benchmark: [agentmemory-rohitg00-benchmark-results.md](agentmemory-rohitg00-benchmark-results.md).

## Identity Boundary

Этот кандидат нельзя смешивать с двумя уже описанными инструментами:

| Tool ID | Repository/package | Роль в AIFHub |
|---|---|---|
| `agent-memory` | `jayzeng/agentmemory`, `myagentmemory 0.4.12` | Только manual durable notes по явному запросу пользователя. |
| `codex-agent-mem` | `MarceloCaporale/codex-agent-mem`, Python package `codex-agent-mem 1.0.2` | Optional read-only continuity через явно указанный SQLite DB. |
| `rohitg00-agentmemory` | `rohitg00/agentmemory`, `@agentmemory/agentmemory`, `@agentmemory/mcp` | User-owned research candidate; `reject_default`. |

Совпадение слова `agentmemory` в названиях не означает общий package, repository, runtime или policy.

## Static Evidence Snapshot

Evidence зафиксирован 2026-07-19 без установки или запуска provider:

- release [`v0.9.28`](https://github.com/rohitg00/agentmemory/releases/tag/v0.9.28);
- commit [`a8e7d19a814a24a21818afc715f3301b3eaeee80`](https://github.com/rohitg00/agentmemory/commit/a8e7d19a814a24a21818afc715f3301b3eaeee80);
- `@agentmemory/agentmemory@0.9.28`;
- `@agentmemory/mcp@0.9.28`;
- Node.js requirement `>=20.0.0`.

Issue evidence отражало packages `0.9.27`, поэтому переход к `0.9.28` считается version drift. Snapshot описывает только указанную revision; более новая версия требует отдельного evidence refresh и не меняет policy автоматически.

```text
INFO [agentmemory-static-audit] issue=https://github.com/ichinya/aifhub-extension/issues/114
INFO [agentmemory-static-audit] release=https://github.com/rohitg00/agentmemory/releases/tag/v0.9.28
INFO [agentmemory-static-audit] revision=a8e7d19a814a24a21818afc715f3301b3eaeee80 runtime=NOT_RUN
WARN [agentmemory-version-drift] issue_snapshot=0.9.27 observed=0.9.28 action=refresh_before_any_promotion
```

## Наблюдаемая Runtime Surface

Upstream documentation описывает не узкий read-only continuity reader, а широкую runtime-систему:

- persistent user-home state под `~/.agentmemory` и user-owned deployment storage;
- основной server, real-time viewer, stream/engine процессы и optional Docker/iii engine lifecycle;
- server-backed MCP surface на 53 tools и local fallback на 7 tools;
- plugins, skills и lifecycle hooks для coding agents;
- agent configuration mutation при подключении MCP/plugins/hooks;
- capture и replay prompts, tool calls, tool results, responses и derived memory;
- optional external/local model providers и связанные runtime credentials/configuration.

Эти возможности могут быть полезны в independently managed installation, но расширяют read, storage, process и privacy scope намного дальше текущих AIFHub defaults. Static documentation не доказывает project isolation, privacy canaries, complete purge или continuity quality.

## Политика AIFHub

Решение: `reject_default`.

Recommendation action: `do_not_suggest_as_aifhub_provider`.

`rohitg00-agentmemory`:

- не появляется в normal recommendations;
- не попадает в `selected_tools`, даже если явно указан в project config;
- отсутствует в `SAFE_TOOL_IDS` и safe field-run plans;
- не имеет executable availability probe;
- запрещён для всех AIF commands в `skill_usage_matrix`;
- не создаёт зависимости для analyze, plan, implement, verify или done.

Для exact file/symbol lookup baseline остаётся `rg`. Для manual notes и read-only continuity сохраняются независимые существующие policies `agent-memory` и `codex-agent-mem`.

## User-Owned Reviewed Output Boundary

Пользователь может независимо установить, настроить и обслуживать provider вне AIFHub. Если пользователь явно передаст уже проверенный export или note, AIFHub может прочитать его как обычный supporting input при следующих условиях:

- input сверяется с прямыми repository и canonical artifacts;
- secrets, credentials, private absolute paths, raw prompt/tool transcripts и cross-project content не переносятся в durable public artifacts;
- provider output не становится canonical OpenSpec spec или generated rule;
- provider output не удовлетворяет QA, validation, verify, done или archive gates;
- отсутствие provider или его output не блокирует AIFHub workflow.

AIFHub не берёт на себя install, setup, memory sync, MCP registration, agent config mutation, hooks, background daemons, provider CLI или cleanup lifecycle.

## Privacy И Purge

Read scope классифицирован как `broad_prompt_tool_and_memory_data`. Storage scope классифицирован как `user_home_agentmemory_and_user_owned_runtime`.

Upstream предоставляет команды удаления и governance operations, но в этом change они не запускались. Не подтверждено, что cleanup удаляет все observations, indexes, snapshots, exports, plugin/config mutations, process state и cross-project residual data. Поэтому:

- `purge_status: unverified`;
- AIFHub не обещает complete cleanup;
- AIFHub не выполняет provider cleanup;
- positive recommendation невозможна без отдельного complete-purge check.

## Условия Future Promotion

Переход к `conditional` или `recommend` требует нового explicit scope и user authorization. Минимальный evidence gate:

- не менее двух comparable PASS/PASS continuity pairs для exact runtime/platform profile;
- пройденный cross-project isolation check;
- пройденный privacy-canary check;
- пройденный complete-purge check;
- подтверждённая platform viability;
- сохранение command permissions и forbidden operations сильнее любых positive labels.

Текущий static audit и policy tests достаточны только для консервативного rejection. Runtime benchmark остаётся `NOT_RUN`.

## Мета Для Анализа

```yaml
tool_id: rohitg00-agentmemory
decision: reject_default
recommendation_action: do_not_suggest_as_aifhub_provider
role: user_owned_continuity_candidate_only
install_policy: user_owned_outside_aifhub_only
read_scope: broad_prompt_tool_and_memory_data
storage_scope: user_home_agentmemory_and_user_owned_runtime
purge_status: unverified
runtime_status: NOT_RUN
analysis_hint: "Не предлагать как AIFHub provider; допускается только явно переданный и проверенный user-owned output как supporting context."
```
