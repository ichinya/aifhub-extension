# Repowise

Репозиторий: [repowise-dev/repowise](https://github.com/repowise-dev/repowise)

Проверенный package: `repowise 0.25.0` (pip install --user).

## Что Это

Repowise - локальная repo-intelligence платформа. Один раз индексирует explicit project path и строит пять слоёв, доступных через CLI, MCP-сервер (11 tools) и локальный дашборд: Graph (tree-sitter, 15 языков), Git (hotspots, co-change, bus factor), Docs (LLM-wiki), Decisions (ADR mining), Code Health (defect risk, refactoring).

Из них четыре детерминированных слоя работают без LLM через `--index-only`, что даёт безопасную зону для supporting context. AIFHub использует только детерминированный tier по умолчанию; LLM-wiki tier - опциональный усилитель, включаемый при подтверждённом провайдере.

В AIFHub это не canonical evidence source и не обязательная зависимость. Это optional supporting context для случаев, где `rg`-baseline даёт слишком шумную выборку и нужны отношения, risk-scores или blast radius.

## Для Чего

Repowise может быть полезен для:

- architecture/impact discovery с blast radius: `get_context` возвращает callers, graph metrics (betweenness, PageRank), skeleton за один round-trip;
- defect-risk с evidence: Code Health калибруется против git history проекта и сообщает hit-rate (например `3.85x baseline`);
- JIT change risk: `risk <ref>` даёт Kamei-style score с декомпозицией факторов;
- multirepo/monorepo surface mapping через Leiden-сообщества;
- dead-code с confidence tiers и blast radius;
- symbol search по графу (Tier 0) или semantic search (Tier 1 wiki).

Repowise не заменяет `rg`. Baseline всегда остаётся `rg`, а результат нужно проверять по source files.

## Политика AIFHub

Текущее решение: `manual_cli_only` + `avoid_by_default`.

Repowise можно предлагать только при exact match по `skill + project labels` из `tools.repowise.screening_policy.conditional_cases` в [recommendation-metadata.yaml](recommendation-metadata.yaml). На первом этапе `conditional_cases`/`known_avoid_cases` пусты до завершения ai-tester матрицы; заполнение `proven_label_evidence` - отдельная фаза после smoke-прогона.

Минимальный contract:

- сначала выполнить `rg` baseline;
- использовать Repowise только как supporting context;
- запускать только на explicit project path в constrained `--index-only` режиме;
- принимать результат только если `search`/`health`/`get_overview` вернул non-empty useful output;
- завершать временный индекс двухступенчатым purge (registry + filesystem);
- не использовать output как OpenSpec evidence, QA evidence или verify/done gate evidence.

Tiered lifecycle управляется опцией `utilities.repowise.wiki` в `.ai-factory/config.yaml`:

- `off` - всегда Tier 0 (`--index-only`, zero LLM);
- `if_configured` (по умолчанию) - Tier 0 по умолчанию; Tier 1 wiki включается только если `repowise doctor` подтверждает `Provider config: OK`;
- `on` - всегда Tier 1 wiki (требует LLM-провайдера).

Подробные результаты smoke-прогона лежат в [repowise-benchmark-results.md](repowise-benchmark-results.md).

## Безопасный Lifecycle

Разрешённый manual lifecycle для scoped experiment (Tier 0, детерминированный):

```bash
repowise --version
repowise doctor

repowise init <project> --index-only --no-claude-md --no-agents --no-codex --no-distill-hook --yes
repowise search "<query>" --mode symbol --limit 5
repowise health --format md
repowise dead-code --format table
repowise risk HEAD --format md
```

Двухступенчатый purge:

```bash
# Stage 1: registry removal (--force НЕ подавляет интерактивный prompt)
printf '1\n' | repowise delete -p . --force
# Stage 2: filesystem cleanup
rm -rf .repowise .mcp.json
```

Tier 1 (wiki, только при `repowise doctor` → `Provider config: OK`):

```bash
repowise init <project> --no-claude-md --no-agents --no-codex --no-distill-hook --yes
repowise query "<natural language question>"
repowise search "<query>" --mode semantic
```

Если в проекте уже есть user-owned `.repowise/`, нельзя silently удалять, переинициализировать или считать его временным индексом.

## Что Запрещено

AIFHub не должен выполнять из command ownership:

- auto-install Repowise;
- `repowise init` без constrained-флагов (полный init глобально мутирует `~/.claude/settings.json`, `~/.repowise/platform.json`);
- `repowise serve`;
- `repowise hook install`;
- `repowise generate-claude-md`;
- agent configuration mutation commands;
- hooks или background services из команд AIFHub;
- silent writes в `.mcp.json`, `.codex/config.toml`, `.cursor/`, `.opencode.json`, `AGENTS.md`, `CLAUDE.md` или permission files;
- хранение LLM provider API-ключей в `.ai-factory/`, `openspec/`, docs, runtime state, QA evidence или generated rules (ключи живут в user-owned `.repowise/.env`);
- long-term storage сырого Repowise output как проекта или OpenSpec evidence.

## Мета Для Анализа

```yaml
tool_id: repowise
decision: manual_cli_only
default_policy: avoid_by_default
recommendation_action: suggest_manual_cli_for_repo_intelligence_when_enabled_or_explicit
role: repo_intelligence_provider
install_policy: explicit_user_opt_in_only
read_scope: explicit_project_path_constrained_index_only
purge_path: two-stage (repowise delete -p . --force with piped 1, then rm -rf .repowise .mcp.json)
baseline_first: rg
selection_rule: exact skill + project labels from screening_policy
tier_default: index_only_zero_llm
tier_wiki_gate: repowise doctor -> Provider config: OK
do_not_select_by:
  - language_only
  - skill_only
  - broad_shape_only
```
