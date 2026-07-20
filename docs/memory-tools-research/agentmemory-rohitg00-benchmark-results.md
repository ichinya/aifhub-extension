# Результаты Оценки agentmemory (rohitg00)

> **Isolated runtime status: `PASS`**
>
> **Full-product runtime status: `NOT_RUN`**

Изолированный safety-сценарий проверен через `ai-tester` на synthetic canaries. Он не устанавливал hooks, не создавал MCP registration, не менял agent configuration и не запускал server/daemon lifecycle. Описание candidate и policy boundary: [agentmemory-rohitg00.md](agentmemory-rohitg00.md).

## Итог

| Поле | Значение |
|---|---|
| Tool ID | `rohitg00-agentmemory` |
| Repository | [`rohitg00/agentmemory`](https://github.com/rohitg00/agentmemory) |
| Static snapshot | `v0.9.28`, commit `a8e7d19a814a24a21818afc715f3301b3eaeee80`, 2026-07-19 |
| Tested package | `@agentmemory/mcp@0.9.28` |
| ai-tester run | `agentmemory-isolated-0-9-28-20260720-r4` |
| Scenario | `agentmemory-isolated-continuity`, `run_class: safety` |
| Skills | `aif-explore`, `aif-review` |
| Project labels | `js`, `standard`, `framework`, `single_repo`, `openspec_native`, `large_framework_app` |
| Task | `resume_previous_work` |
| Rows / pairs | 4/4 rows PASS; 2/2 `PASS/PASS` pairs |
| Runtime decision | `avoid` for both pairs |
| Policy decision | `reject_default` |
| Metadata promotion | Не выполнялась; scenario имеет `eligible_for_metadata: false`, запуск использовал `--no-promote` |

`rg` остаётся baseline для repository lookup. Изолированный PASS подтверждает только ограниченный standalone safety profile и не является положительным evidence для normal recommendations.

## Выполненный Isolated Profile

- native Windows, Node.js `v24.8.0`, `ai-tester 1.2.0`, model `gpt-5.4-mini`;
- pinned local install `@agentmemory/mcp@0.9.28` с `--ignore-scripts --no-audit --no-fund`;
- direct MCP stdio в `STANDALONE_MCP=true` и local fallback без server registration;
- отдельные confined HOME/app-data/store paths внутри test sandbox;
- credential-free child environment и synthetic markers без user corpus;
- новый MCP process для каждого save/recall/delete шага;
- обязательное завершение всех child processes и purge sandbox/package root после каждой candidate attempt.

Adapter печатал только compact pass/fail tokens; raw prompts, tool transcripts, secrets и private fixture paths не переносились в durable report.

## Safety Results

| Проверка | Результат | Граница доказательства |
|---|---|---|
| Cross-process continuity | `continuity_pass` | Каждый isolated store вспомнил собственный synthetic marker в новом process. |
| Cross-store isolation | `isolation_pass` | Marker одного store не появился в recall другого store. |
| Privacy canaries | `privacy_pass` | Synthetic markers не пересекли store boundary; inherited credentials не передавались child process. |
| Governance delete | `purge_pass` | После delete новые processes не нашли удалённые markers. |
| Runtime/install purge | `PASS` | Test sandbox и pinned package root удалены. |
| Host agent config mutation | `false` | Codex/Claude/Cursor/OpenCode configuration не менялась. |
| Hooks/plugins/skills install | `false` | Не выполнялся. |
| MCP registration | `false` | Использовался только direct local stdio child. |
| Server/viewer/stream/engine/daemon ownership | `false` | Не запускались. |

## Paired Performance

| Skill | `rg` baseline | AgentMemory candidate | Pair decision |
|---|---:|---:|---|
| `aif-explore` | 46.3 s; 1 call; 83,804 total tokens | 164.5 s; 2 calls; 116,708 total tokens | `avoid` |
| `aif-review` | 51.2 s; 1 call; 66,568 total tokens | 158.3 s; 2 calls; 111,015 total tokens | `avoid` |

Aggregate candidate delta против `rg`:

- duration: +231.1% (`3.3108x`);
- tool calls: +100% (`2.0x`);
- total tokens: +51.4% (`1.5144x`);
- input+output tokens: +53.6% (`1.5365x`).

Safety assertions прошли, но continuity provider не дал достаточного преимущества, чтобы оправдать overhead или расширить default ownership. Поэтому обе pair decisions — `avoid`, а policy остаётся `reject_default`.

## Object-focused Project Samples

Дополнительно выполнены две non-promotable `aif-explore` пары на sanitized copies реальных project objects. Исходные repositories не модифицировались; test-only adapter копировался только внутрь generated fixture. Публичные evidence IDs и profile IDs обезличены.

| Object | Evidence ID | Profile | `rg` baseline | AgentMemory candidate | Delta | Decision |
|---|---|---|---:|---:|---:|---|
| Python MCP ability/auth gate | `agentmemory-object-python-mcp-gate-20260720-r1` | `project-8d97432e6d7a` | 247.6 s; 21 calls; 845,783 total tokens | 631.8 s; 34 calls; 1,262,957 total tokens | +155.2% duration; +49.3% total tokens | `avoid` |
| PHP uptime interval merge | `agentmemory-object-php-uptime-20260720-r1` | `project-6b511dc0445f` | 370.5 s; 13 calls; 473,382 total tokens | 588.0 s; 23 calls; 941,243 total tokens | +58.7% duration; +98.8% total tokens | `avoid` |

Обе object-focused пары завершились `PASS/PASS`; candidate не был быстрее, не сделал меньше tool calls и не использовал меньше total либо input+output tokens ни в одной паре. Это расширяет safety evidence на external sanitized fixtures, но остаётся sample size 1 для каждого profile и не меняет metadata или policy decision.

## Что Остаётся NOT_RUN

Изолированный run не проверял и не разрешал:

- full server, viewer, stream, engine или iii lifecycle;
- real user corpus, prompt/tool transcript capture, import, sync или export;
- hooks, plugins, skills или registered MCP integration;
- host agent configuration mutation;
- background daemon ownership;
- agent/tenant multi-user isolation;
- Windows/WSL/Linux/macOS parity;
- complete full-product cleanup всех observations, indexes, snapshots, exports, config/plugin/hook residues и external storage.

Поэтому `purge_status: unverified` сохраняется для полного продукта. Проверенный synthetic governance delete и sandbox purge нельзя экстраполировать на весь upstream lifecycle.

## Evidence Boundary И Promotion Gates

Provider output не становится canonical OpenSpec spec или generated rule и не может удовлетворять QA, validation, review, verify, done или archive gates. Отсутствие provider не блокирует AIFHub workflow.

Любая будущая попытка изменить decision требует отдельного change и explicit user authorization. Помимо уже выполненных двух synthetic pairs, нужны real-scope privacy/isolation checks, full-product complete-purge evidence, platform matrix и доказанная польза по сравнению с `rg`. Command permissions и forbidden operations остаются сильнее positive labels.

## Evidence Checklist Log

```text
INFO [agentmemory-evidence] run_id=agentmemory-isolated-0-9-28-20260720-r4 provider_version=0.9.28
INFO [agentmemory-evidence] rows=4/4_pass pairs=2/2_pass continuity=isolation=privacy=purge=PASS
INFO [agentmemory-evidence] registration=hooks=config_mutation=daemon=false promotion=false
WARN [agentmemory-evidence] decision=avoid duration_delta=+231.1% total_tokens_delta=+51.4%
INFO [agentmemory-evidence] object_samples=2 pass_pairs=2 decisions=avoid,avoid promotion=false
WARN [agentmemory-evidence] full_product_runtime=NOT_RUN policy=reject_default
```
