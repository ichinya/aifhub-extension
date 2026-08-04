[Предыдущая страница](usage.md) | [К документации](README.md) | [Следующая страница](memory-tool-recommendations.md)

# Провайдеры Контекста

AIFHub может использовать optional provider output как supporting context, когда пользователь уже создал или проверил этот output. Providers помогают агентам исследовать проект или внешнюю документацию, но не становятся dependencies, gates, canonical evidence, generated rules input или runtime requirements для AIFHub.

Provider availability всегда является degraded behavior: отсутствующие tools, reports, MCP servers, API credentials или неподдерживаемые local runtimes сами по себе не должны ломать `/aif-explore`, `/aif-plan`, `/aif-review`, `/aif-implement`, `/aif-verify`, `/aif-done` или любую другую AIFHub command.

## context-mode Codex

`context-mode` остаётся optional user-owned provider с явным opt-in; `rg` — baseline. Historical MCP-only evidence `1.0.151` разрешает только manual temporary indexing уже созданного generated output с purge.

Re-evaluation exact `v1.0.169` разделяет surfaces:

- package snapshot: PASS как `plugin_snapshot_isolated`, но install lifecycle — `NOT_RUN(postinstall_forbidden)`;
- MCP-only и direct hooks: `BLOCKED(runtime_dependency_self_install)`;
- actual Codex plugin: `NOT_RUN(auth_isolation_unavailable)`;
- test-only `direct_hook_contract` не является actual event/compaction evidence.

Authorized live follow-up от `2026-08-03` с class `explicit_isolated_full` добавляет runtime evidence, не переписывая эти исторические gates:

- единственный полезный MCP-only PASS получен на >1 MiB stdout case, где baseline потерял tail facts из-за truncation; MCP использовал `+120.2%` total tokens против уже failed baseline, поэтому token savings не доказаны;
- на small fixture MCP тоже был корректен, но использовал `+376.8%` tokens и `+50.8%` duration;
- Codex plugin FAIL на tested nested shell path: `ctx_search` был вызван, но hooks не перехватили output;
- session continuity остаётся `NOT_RUN(resume_driver_parity_unavailable)`;
- raw rollout audit подтвердил nested provider calls, confined paths и purge без сохранения raw traces.

Следовательно, MCP-only допустим лишь как conditional manual helper для большого truncating output, когда correctness важнее token cost. Plugin для этого stack следует избегать. Санитизированный evidence хранится в `docs/memory-tools-research/context-mode-codex-ai-tester/live-authorized-evidence.json`.

Обычные `/aif-plan`, `/aif-implement`, `/aif-verify` и `/aif-done` не auto-install provider, не register MCP, не доверяют hooks и не выбирают plugin. Generic floating routes отключены с `dedicated_harness_required`. Пользовательская установка остаётся вне AIFHub ownership; перед ней нужно отдельно принять version-sensitive install/hook risk.

## Роли Providers

Graphify - optional provider для repository architecture и relation discovery. Он может помочь найти dependencies, ownership paths и impact areas перед прямой проверкой репозитория.

Context7 - optional documentation provider для актуальных library/API docs. Он снижает неопределенность вокруг version-sensitive API behavior, framework migration details и third-party usage patterns.

Оба provider являются только supporting context. Final plans, review findings, generated rules, verification status, done status и roadmap completion должны оставаться source-grounded в canonical OpenSpec artifacts, source files, tests, runtime state, QA evidence, generated rules trace metadata или другом direct repository evidence.

## Границы AIFHub

AIFHub Extension не должен:

- устанавливать provider CLIs или packages, включая `ctx7` или `@upstash/context7-mcp`;
- запускать provider setup commands;
- автоматически запускать или регистрировать provider MCP servers;
- добавлять provider package dependencies или manifest dependencies;
- добавлять Context7 MCP templates в `extension.json`;
- менять `.mcp.json`, `.cursor/mcp.json`, `.opencode.json`, agent rules, agent skills или runtime MCP settings для provider;
- превращать provider availability в validation, verification, review, rules, security, done или commit gates.

Будущие runtime features вроде metadata field `context_provider_suggestion` могут рекомендовать manual provider usage, но не должны менять user-owned setup boundary.

Для installed-project diagnostics и metadata-driven recommendations используйте:

```bash
ai-factory aifhub-memory-tools recommend --from-project --json
ai-factory aifhub-memory-tools select --from-project --command aif-explore --json
ai-factory aifhub-memory-tools status --json
ai-factory aifhub-memory-tools metadata --json
```

Recommender читает только local installed metadata и не должен обращаться к GitHub или internet. Follow-on skills должны использовать `select`, а затем только returned `selected_tools`; project config хранит accepted provider ids в `utilities.context_tools.enabled`.

## AgentMemory (rohitg00)

`rohitg00-agentmemory` обозначает [`rohitg00/agentmemory`](https://github.com/rohitg00/agentmemory) и packages `@agentmemory/agentmemory`/`@agentmemory/mcp`. Это отдельный candidate, не alias для `agent-memory` (`jayzeng/agentmemory`, manual notes) или `codex-agent-mem` (`MarceloCaporale/codex-agent-mem`, read-only continuity).

Текущая AIFHub policy — `reject_default`: isolated standalone `ai-tester` safety profile имеет status `PASS`, обе пары дали `avoid`, а full-product runtime status остаётся `NOT_RUN`. Evidence и решение описаны в [research note](memory-tools-research/agentmemory-rohitg00.md) и [benchmark-results artifact](memory-tools-research/agentmemory-rohitg00-benchmark-results.md).

В normal workflows provider lifecycle полностью user-owned и external to AIFHub. AIFHub не должен:

- устанавливать или обновлять AgentMemory packages, plugins или skills;
- запускать setup, provider CLI, server, viewer, stream или engine processes;
- устанавливать или обслуживать hooks;
- создавать, менять или регистрировать MCP server/client configuration;
- менять Codex, Claude, Cursor, OpenCode или другую agent configuration;
- запускать, перезапускать, наблюдать или удалять background daemons;
- выполнять memory capture, sync, import, recall, export или cleanup lifecycle;
- считать provider availability обязательной для любой AIFHub command.

Единственное test-only исключение — явно запущенный authored `ai-tester` safety scenario. Он может установить pinned `@agentmemory/mcp@0.9.28` в local confined fixture с disabled lifecycle scripts, запустить direct standalone MCP stdio на synthetic data и обязан удалить store/package fixture после попытки. Этот сценарий не создаёт hooks, MCP registration, host agent config или daemon ownership и не делает provider доступным normal recommendations.

Explicit project config не переопределяет rejection: candidate не попадает в `selected_tools`, не имеет executable availability probe и отсутствует в safe field-run plan.

Если пользователь независимо управляет provider и явно передаёт reviewed export/note, AIFHub может читать этот файл только как supporting context. Такой input должен быть сверён с direct repository/canonical sources и не может удовлетворять OpenSpec, generated-rules, QA, validation, review, verify, done, archive или roadmap gates. В durable artifacts нельзя переносить secrets, private absolute paths, raw prompts/tool transcripts или cross-project content.

Отсутствие AgentMemory и его output всегда является допустимым состоянием и не блокирует AIFHub workflow.

## Защищенные Validation Artifacts

Context и compression tools не должны rewrite validation artifacts и не должны compress protected artifacts in place. Protected validation artifacts: `aif-gate-result`, `coverage.json`, `done-readiness.json`, `openspec/specs/**`, generated-rules traces и exact evidence snippets.

## Context7

Используйте Context7 только когда актуальная library/API documentation materially снижает неопределенность. Типовые случаи: framework version changes, package migration notes, deprecations, generated client APIs или review finding, который зависит от third-party contract.

Не устанавливайте `ctx7` или `@upstash/context7-mcp`, не запускайте `ctx7`, не запускайте `ctx7 setup`, не добавляйте Context7 dependencies, не добавляйте Context7 MCP templates в `extension.json`, не запускайте и не регистрируйте Context7 MCP automatically из AIFHub commands или sidecars.

Manual CLI usage принадлежит пользователю. Пользователь может запускать Context7 через `npx`:

```bash
npx ctx7 library <name> <query>
npx ctx7 docs <libraryId> <query>
```

Если CLI уже установлен пользователем, equivalent commands:

```bash
ctx7 library <name> <query>
ctx7 docs <libraryId> <query>
```

Context7 CLI требует подходящий local Node.js runtime. Если `npx ctx7` или `ctx7` недоступен, слишком старый, unauthenticated или rate-limited, AIFHub guidance должен продолжить с degraded documentation context.

Safe field run 2026-05-24 установил `ctx7 0.4.4` только во временный npm prefix, проверил `ctx7 --help` и выполнил один explicit docs lookup. `ctx7 setup`, MCP registration, config mutation и raw output persistence не запускались. Детали: [memory-tools-research/context7.md](memory-tools-research/context7.md).

Context7 library IDs могут зависеть от source и version. Примеры:

- `/org/project`
- `/org/project/version`
- `/org/project@version`
- `/packages/<name>`
- `/websites/<name>`

Treat exact IDs as provider output, not stable AIFHub schema.

Context7 MCP setup тоже user-owned. Если пользователь уже настроил Context7 MCP server, agents могут использовать доступные MCP tools как optional read-only documentation context. Обычный lookup flow: `resolve-library-id`, затем docs retrieval tool. Docs retrieval tool может называться `get-library-docs` или `query-docs` в зависимости от версии Context7 client/server, поэтому prompt guidance должен поддерживать оба имени.

Не запускайте `ctx7 setup`. Эта команда может писать `.mcp.json`, `.cursor/mcp.json`, `.opencode.json`, agent rules или agent skills. AIFHub guidance может упоминать это как user-owned setup, но AIFHub commands и sidecars не должны выполнять ее или менять эти files.

Разрешенное durable storage для reviewed Context7 notes:

- `.ai-factory/references/context7/` для project-wide documentation notes.
- `.ai-factory/state/<change-id>/context7/` для change-scoped documentation notes.

Reviewed Context7 note должен быть кратким и включать library name, resolved library ID если известен, package/docs version если известна, query, retrieval date, source URL если доступен, и короткий conclusion, relevant для AIFHub task.

Forbidden storage для raw Context7 output, MCP transcripts, API responses, setup output или generated provider configuration:

- `openspec/changes/<change-id>/`
- `openspec/specs/`
- `.ai-factory/rules/generated/`
- `.ai-factory/qa/<change-id>/`

Не persist `CONTEXT7_API_KEY`, API keys, tokens, raw authorization headers, credential helper output, private provider diagnostics, private backend diagnostics или unreviewed sensitive output в `.ai-factory/`, `openspec/`, docs, runtime state, QA evidence, generated rules или Context7 reference copies.

## Graphify

Graphify остается optional repository research provider. AIFHub Extension не требует Graphify, не устанавливает `graphifyy`, не запускает `graphify`, не добавляет Graphify в extension dependencies и не запускает или регистрирует Graphify MCP automatically.

Manual Graphify usage вне AIFHub command ownership:

```powershell
uv --version
uv tool install graphifyy
graphify install
graphify .
```

В PowerShell используйте `graphify .`; не добавляйте prefix `/graphify .`.

Для private real roots предпочтительно запускать Graphify на sanitized temporary copy, если пользователь явно не принял local `graphify-out/` files в project root. Safety smoke от 2026-05-23 использовал `graphify update <temp-copy> --no-cluster` и не запускал semantic/LLM extraction.

Safe field run 2026-05-24 повторил этот режим на 55 anonymous temp copies с `graphify 0.8.17`: AST update прошел на 54/55, один large profile hit timeout, cleanup `graphify-out/` прошел для всех profiles.

Разрешенное durable storage для reviewed Graphify context:

- `.ai-factory/references/graphify/` для project-wide reference copies.
- `.ai-factory/state/<change-id>/graphify/` для change-scoped runtime copies.

Не храните raw Graphify generated files вроде `GRAPH_REPORT.md`, `graph.json` или `graph.html` в `openspec/changes/<change-id>/`, `openspec/specs/`, `.ai-factory/rules/generated/` или `.ai-factory/qa/<change-id>/`.

См. [Usage](usage.md) и [Context Loading Policy](context-loading-policy.md) для command-specific Graphify guidance.

## CodeGraph

CodeGraph - manual CLI-only repo graph provider для broad analyze/explore questions. Local metadata фиксирует его как `manual_cli_only` с `suggest_manual_cli_for_repo_graph_when_enabled_or_explicit`.

Allowed availability probes для AIFHub automation ограничены:

```bash
codegraph --version
codegraph --help
codegraph status
```

Manual safety testing 2026-05-23 проверил explicit-path CLI `init`, `index --quiet`, `status`, JSON `query` и `uninit --force` на 29 real local project roots без protected agent/config mutations и без leftover `.codegraph/` directories.

Safe field run 2026-05-24 повторил scoped lifecycle на 55 anonymous temp copies. Installed CLI был `0.9.3`, npm latest `0.9.4`; lifecycle и purge прошли на всех profiles. Это подтверждает `manual_cli_only`, но не расширяет разрешения на install/MCP/agent-config mutation.

`/aif-analyze` может рекомендовать CodeGraph, когда metadata показывает, что broad repo graph полезен. `/aif-explore` может использовать scoped CLI lifecycle только когда `select --command aif-explore --json` возвращает CodeGraph в `selected_tools` с `manual_purged_cli_execution`, и только с purge command из returned `execution` field перед завершением.

AIFHub commands не должны auto-install CodeGraph, запускать `codegraph install`, запускать `codegraph sync`, запускать `codegraph serve --mcp`, mutate agent configuration, register MCP automatically или treat CodeGraph output as canonical OpenSpec evidence. Manual `init/index/query/uninit` разрешен только в `/aif-explore` с explicit path, command-specific permission и purge.

## Repowise

Repowise - manual CLI-only repo-intelligence provider для analyze/explore/review. Local metadata фиксирует его как `manual_cli_only` с `suggest_manual_cli_for_repo_intelligence_when_enabled_or_explicit`, `integration_role: repo_intelligence_provider`. В отличие от CodeGraph (graph-only), Repowise даёт пять слоёв: Graph, Git (hotspots/co-change/bus factor), Docs (LLM-wiki), Decisions (ADR mining), Code Health (defect risk).

Allowed availability probes для AIFHub automation ограничены:

```bash
repowise --version
repowise doctor
```

Spike 2026-06-28 на копии проекта (1045 PHP-файлов, 480 коммитов) подтвердил constrained lifecycle `init --index-only --no-claude-md --no-agents --no-codex --no-distill-hook`, `search`, `health`, `risk`, `dead-code` и двухступенчатый purge (`delete -p . --force` требует подачи stdin `1\n`, т.к. `--force` не подавляет интерактивный prompt; затем `rm -rf .repowise .mcp.json`). Installed CLI был `0.25.0`. Это подтверждает `manual_cli_only`, но не расширяет разрешения на install/MCP/agent-config mutation.

`/aif-analyze` может рекомендовать Repowise. `/aif-explore` может использовать scoped CLI lifecycle только когда `select --command aif-explore --json` возвращает Repowise в `selected_tools` с `manual_purged_cli_execution`. `/aif-review` может использовать Code Health/risk findings как supporting context. Purge обязателен перед завершением через returned `execution.purge` field.

Tiered lifecycle управляется опцией `utilities.repowise.wiki` в `.ai-factory/config.yaml`: `off` (всегда детерминированный `--index-only`), `if_configured` (по умолчанию - Tier 0, Tier 1 wiki при `repowise doctor` → `Provider config: OK`), `on` (всегда wiki). LLM API-вызовы wiki tier'а оплачивает пользователь; ключи провайдера живут в user-owned `.repowise/.env` (gitignored).

AIFHub commands не должны auto-install Repowise, запускать `repowise init` без constrained-флагов (полный init глобально мутирует `~/.claude/settings.json` и `~/.repowise/platform.json`), запускать `repowise serve`, `repowise hook install`, `repowise generate-claude-md`, mutate agent configuration из command ownership или treat Repowise output as canonical OpenSpec evidence. Repowise coexists с CodeGraph под разными `integration_role`; proven CodeGraph screening policy не переносится на Repowise без собственной evidence.
