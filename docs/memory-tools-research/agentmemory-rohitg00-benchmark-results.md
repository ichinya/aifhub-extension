# Результаты Оценки agentmemory (rohitg00)

> **Runtime status: `NOT_RUN`**
>
> AgentMemory не устанавливался и не запускался. AIFHub не создавал MCP registration, hooks, plugin/config entries или daemon processes. В этом документе нет runtime benchmark, provider output или performance metrics.

Описание candidate и policy boundary: [agentmemory-rohitg00.md](agentmemory-rohitg00.md).

## Итог

| Поле | Значение |
|---|---|
| Tool ID | `rohitg00-agentmemory` |
| Repository | [`rohitg00/agentmemory`](https://github.com/rohitg00/agentmemory) |
| Static snapshot | `v0.9.28`, commit `a8e7d19a814a24a21818afc715f3301b3eaeee80`, 2026-07-19 |
| Runtime status | `NOT_RUN` |
| Runtime metrics | Не собирались |
| Policy decision | `reject_default` |
| Metadata promotion | Запрещена по текущему evidence |

Static review достаточен, чтобы подтвердить широкий lifecycle/privacy scope и сохранить консервативное решение. Он недостаточен, чтобы подтвердить полезность continuity, безопасную isolation, privacy или complete purge.

## Выполненные Static Checks

| Проверка | Статус | Evidence |
|---|---|---|
| Exact repository identity | `PASS_STATIC` | `https://github.com/rohitg00/agentmemory` |
| Exact package identity | `PASS_STATIC` | `@agentmemory/agentmemory`, `@agentmemory/mcp` |
| Release snapshot | `PASS_STATIC` | [`v0.9.28`](https://github.com/rohitg00/agentmemory/releases/tag/v0.9.28) |
| Commit snapshot | `PASS_STATIC` | [`a8e7d19a...`](https://github.com/rohitg00/agentmemory/commit/a8e7d19a814a24a21818afc715f3301b3eaeee80) |
| Node requirement | `PASS_STATIC` | Package metadata declares `>=20.0.0` |
| Storage/process surface documented | `PASS_STATIC` | User-home state plus server/viewer/stream/iii lifecycle are described upstream |
| MCP/plugin/hook surface documented | `PASS_STATIC` | Server-backed 53-tool surface, 7-tool fallback and agent plugin/hooks are described upstream |
| Existing similarly named tools separated | `PASS_POLICY` | `agent-memory`, `codex-agent-mem`, `rohitg00-agentmemory` have distinct identity contracts |
| Candidate excluded from normal selection | `PASS_POLICY` | `reject_default`, default forbidden permission and source denylist |
| Candidate excluded from safe field run | `PASS_POLICY` | Absent from `SAFE_TOOL_IDS`; present in rejected full-install policy |
| Executable provider probe absent | `PASS_POLICY` | Status contract remains `availability: unknown`, `command: null` |

`PASS_STATIC` означает только успешную проверку публичного metadata/documentation snapshot. `PASS_POLICY` означает проверку локального AIFHub safety contract. Ни один из этих статусов не является runtime PASS provider’а.

## Runtime Claims: Не Проверены

| Claim | Статус | Почему нельзя считать подтверждённым |
|---|---|---|
| Cross-session continuity quality | `NOT_RUN` | Нет comparable baseline/candidate runs |
| Recall precision и relevance | `NOT_RUN` | Нет controlled queries и scored outputs |
| Token/time improvement | `NOT_RUN` | Метрики не собирались |
| Project isolation | `NOT_RUN` | Не выполнялся cross-project canary |
| Agent/tenant isolation | `NOT_RUN` | Upstream behavior не проверялся в AIFHub profile |
| Prompt/tool-data privacy | `NOT_RUN` | Не выполнялся privacy-canary test |
| Complete purge | `NOT_RUN` | Не проверено удаление observations, indexes, snapshots, exports и config residues |
| Residual process cleanup | `NOT_RUN` | Server, viewer, stream, engine и daemon lifecycle не запускались |
| Windows viability | `NOT_RUN` | Native, WSL2 и Docker paths не проверялись |
| Linux/macOS viability | `NOT_RUN` | Platform runs не выполнялись |
| MCP registration safety | `NOT_RUN` | MCP registration намеренно не выполнялась |
| Hook/plugin safety | `NOT_RUN` | Hooks и plugins намеренно не устанавливались |

## Evidence Boundary

В рамках этого change были разрешены только:

- read-only review публичных repository/release/package facts;
- анализ upstream-documented runtime surface;
- локальные metadata/recommender/field-run policy tests;
- documentation и link validation.

Не выполнялись:

- package install или setup;
- provider CLI или server start;
- MCP client/server registration;
- hooks, plugins или skills installation;
- agent configuration mutation;
- Docker/iii runtime start;
- background daemon ownership;
- импорт, sync, capture, recall или purge user data.

Поэтому никакой provider transcript, runtime output, persisted memory или private path не является evidence этого документа.

## Future Promotion Gates

Любое предложение изменить decision на `conditional` или `recommend` должно выполняться отдельным change после explicit user authorization и включать все условия:

1. Exact package, tag, commit, Node/runtime и platform profile зафиксированы до прогона.
2. Выполнены минимум две comparable PASS/PASS continuity pairs для baseline и candidate.
3. Пройден cross-project isolation test с обнаруживаемым canary.
4. Пройден privacy-canary test для prompts, tool inputs/results и exports.
5. Пройден complete-purge test, включая indexes, snapshots, config/plugin/hook residues и stopped processes.
6. Подтверждена platform viability для заявленного Windows/Linux/macOS profile.
7. Runtime artifacts анонимизированы и не содержат secrets, private paths или raw transcripts.
8. Command permissions и forbidden operations остаются сильнее positive labels и metadata promotion.

До выполнения всех gates решение остаётся `reject_default`, а baseline для repository lookup — `rg`.

## Evidence Checklist Log

```text
INFO [agentmemory-evidence] repository_identity=PASS_STATIC package_identity=PASS_STATIC
INFO [agentmemory-evidence] release=v0.9.28 revision=a8e7d19a814a24a21818afc715f3301b3eaeee80
INFO [agentmemory-evidence] policy_contract=PASS_POLICY runtime=NOT_RUN
WARN [agentmemory-evidence] continuity=isolation=privacy=purge=platform=NOT_RUN
WARN [agentmemory-evidence] promotion=forbidden reason=incomplete_runtime_safety_evidence
```
