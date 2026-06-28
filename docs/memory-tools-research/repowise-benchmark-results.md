# Repowise Benchmark Results

Репозиторий: [repowise-dev/repowise](https://github.com/repowise-dev/repowise)

Проверенная версия: `repowise 0.25.0`.

## Статус

**Pending.** Полный ai-tester matrix smoke-прогон (задача 7.4) ещё не выполнен. Документ будет заполнен метриками после прогона на нескольких контрастных проектах (orkora-php-large, idshka-php-medium, ai-workspace-rust, yougile-ts).

До завершения матрицы `tools.repowise.screening_policy` содержит `default_decision: avoid_by_default` с пустыми `conditional_cases`/`known_avoid_cases`.

## Spike 2026-06-28 (qualitative, не metadata-eligible)

Качественный спайк на копии проекта orkora (1045 PHP-файлов, 480 коммитов, `--index-only` tier, zero LLM):

- **Graph**: 7522 nodes, 22684 edges (после git history).
- **Git**: 180 hotspots, 1215 files in history, bus factor 1.1 (критический).
- **Code Health**: `7/20 lowest-health → bug fix за 6 мес, 3.85x baseline` — self-validated hit-rate против git history проекта. Находки: скрытое co-change coupling (`CreateExpertProfile ⇄ UpdateExpertProfile`, 80% shared commits, no static dependency, impact -1.51), shotgun surgery (`QueueStartAgentRun` co-changes с 18 файлами), churn (`RecordAgentRunEvent` 363% line rewrite за 90 дней), untested hotspots (`TransitionAgentRunStatus` — 9 dependents, no test, betweenness 94-й перцентиль).
- **dead-code**: 764 findings с tiers (unreachable, unused exports), confidence, "ready to delete".
- **risk HEAD**: JIT change risk score 9.6/10, percentile 89.5, с декомпозицией факторов (la=891, entropy, exp).
- **get_context** на critical hotspot: 6 callers (blast radius) + graph metrics (betweenness 94, PageRank 85) + smart skeleton (1348 токенов из 1378, 97.8%) + `hotspot: true` за один MCP round-trip.

Эти результаты — качественные впечатления, не парные `proven_label_evidence`. Они мотивируют `repo_intelligence_provider` роль, но не заменяют ai-tester матрицу.

## Границы `--index-only`

Работает без LLM (zero API, zero cost): `get_overview`, `get_context`, `get_health`, `get_risk`, `get_dead_code`, `search symbol`, `risk`/`health`/`dead-code` CLI.

НЕ работает без LLM-docs (требует Tier 1 wiki): `get_answer`, `search semantic`, `search fulltext`, `query`.

## Purge контракт

Двухступенчатый: `repowise delete -p . --force` (registry; `--force` НЕ подавляет интерактивный prompt, нужен piped `1\n`) + `rm -rf .repowise .mcp.json` (filesystem, до 46M). В отличие от `codegraph uninit --force` (единая команда), контракт тяжелее.

## Глобальная мутация при init

Несмотря на constrained-флаги (`--index-only`, `--no-claude-md`, `--no-agents`, `--no-codex`, `--no-distill-hook`), `init` глобально регистрирует MCP server и PostToolUse hook в `~/.claude/settings.json` и создаёт центральный `~/.repowise/platform.json`. Это нормальное поведение MCP-провайдера; AIFHub не должен запускать `init` из command ownership.
