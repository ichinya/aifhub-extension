# Repowise Benchmark Results

Репозиторий: [repowise-dev/repowise](https://github.com/repowise-dev/repowise)

Проверенная версия: `repowise 0.25.0`.

## ai-tester paired A/B 2026-06-29 (claude/glm-5-turbo)

Честный A/B эксперимент: 6 независимых прогонов (3 проекта × 2 инструмента), каждый с одинаковой задачей architecture_or_impact_discovery. Модель: `glm-5-turbo` через z.ai (claude runtime). ai-tester 0.5.0. Это даёт paired smoke metrics для bounded tool-local `screening_policy`, но не generic `proven_label_evidence`: `run_class: accepted_evidence` и полная screening matrix не подтверждены.

Профили обезличены через path-hash (sha256(sourceRoot)[:12]), как делает matrix generator.

### Paired A/B результаты

| Профиль | Инструмент | Turns | Tokens (total) | Input | Output | Cache-read | Cost | Duration |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| **project-6bfa82605c24** (php/large, 1041 files) | rg baseline | 36 | 277,905 | 37,325 | 2,756 | 237,824 (86%) | $0.374 | 69s |
| **project-6bfa82605c24** (php/large, 1041 files) | repowise | 20 | 202,192 | 17,059 | 1,773 | 183,360 (91%) | $0.221 | 191s |
| **project-0958c3a5928c** (js/mini, 27 files) | rg baseline | 19 | 175,620 | 48,832 | 1,540 | 125,248 (72%) | $0.345 | 35s |
| **project-0958c3a5928c** (js/mini, 27 files) | repowise | 15 | 150,213 | 9,383 | 1,310 | 139,520 (94%) | $0.149 | 58s |
| **project-ac1ab2d4c116** (go/large, 652 files) | rg baseline | 41 | 333,728 | 33,990 | 3,034 | 296,704 (90%) | $0.394 | 109s |
| **project-ac1ab2d4c116** (go/large, 652 files) | repowise | 27 | 224,936 | 15,154 | 2,294 | 207,488 (93%) | $0.237 | 302s |

### Сравнение по дельте (repowise vs rg baseline)

| Профиль | Δ Tokens | Δ Cost | Δ Turns | Δ Duration | Winner |
|---|---:|---:|---:|---:|---|
| project-6bfa82605c24 (php/large) | **−27.3%** | **−41.0%** | −44.4% | +176% | repowise (tokens/cost) / rg (speed) |
| project-0958c3a5928c (js/mini) | **−14.5%** | **−56.7%** | −21.1% | +66% | repowise (tokens/cost) / rg (speed) |
| project-ac1ab2d4c116 (go/large) | **−32.6%** | **−39.9%** | −34.1% | +176% | repowise (tokens/cost) / rg (speed) |

**Ключевой результат:** repowise в paired A/B **дешевле по токенам и cost на всех 3 профилях** (−15% до −33% tokens, −40% до −57% cost). Паттерн консистентен на 3 языках (php/js/go) и 2 размерах (large/mini). Объяснение: repowise возвращает structured data за 1 query, тогда как rg требует множества query/turns (php/large rg: 36 turns/32 tools; go/large rg: 41 turns/37 tools; repowise: 20-27 turns/12-19 tools). Cache-read у repowise выше (91-94% vs 72-90%) — модель эффективнее reuses структурированный контекст. Trade-off: repowise медленнее wall-clock (init overhead 191-302s vs 35-109s).

### Вердикты модели (glm-5-turbo)

**project-6bfa82605c24 (php/large) — rg:**
- 33 Eloquent models, 40 controllers across 8 domain groups, route files, app layers
- "rg gave better architecture insight faster and with zero setup"
- Missed: relationship between pieces, no call graph, no dependency ordering

**project-6bfa82605c24 (php/large) — repowise:**
- 9037 nodes, 24188 edges, 462 unreachable files, 326 unused exports, 481 clone pairs
- Health: avg 9.77/10, worst file 5.7/10
- "repowise added unique value in dead-code detection, duplication analysis, and structural health scoring — things rg fundamentally cannot do"
- Caveat: dead-code false positives на framework service container (in_degree=0 на container-discovered services)

**project-0958c3a5928c (js/mini) — rg:**
- 15 files, 6 modules, import graph, 14 classes — "sufficient for basic exploration"

**project-0958c3a5928c (js/mini) — repowise:**
- 415 symbols, 481 nodes, 940 edges, 51 health findings (god class detection 678 lines CCN 26)
- "repowise adds real value — health report, complexity scoring are things rg simply cannot provide"
- On small project: rg faster/sufficient, but 10s repowise investment yields insights worth the cost

**project-ac1ab2d4c116 (go/large) — rg:**
- Go monolith, omnichannel CRM bridge, `cmd/main.go` entry point
- 41 turns / 37 tools — модель делала много итеративных grep queries чтобы собрать architecture picture
- "comprehensive picture" но assembled manually через множественные queries

**project-ac1ab2d4c116 (go/large) — repowise:**
- Structured architecture summary: module structure, integration points, AI workflow components
- 27 turns / 19 tools — меньше итераций, denser structured data per query
- repowise graph дал automatic dependency mapping для Go packages (которые rg требовал manual query-by-query)

---

## ai-tester combined smoke 2026-06-29 (claude/glm-5-turbo)

Предыдущий прогон: combined scenario (rg+repowise в одном run), forced overhead measurement. Метрики — верхняя граница (сумма обоих инструментов), не A/B. Оставлены для reference.

**Profiles** (sanitized copies из `c:/projects/tmp/`):

| Profile ID | Проект | Язык | Размер | Shape |
|---|---|---|---|---|
| `project-6bfa82605c24` | project-6bfa82605c24 | php+js | large | multirepo |
| `project-0958c3a5928c` | project-0958c3a5928c | js | mini | small_microservice |

### Метрики

| Profile | Turns | Tokens (total) | Input | Output | Cache-read | Cost | Duration |
|---|---:|---:|---:|---:|---:|---:|---:|
| project-6bfa82605c24 (php/large) | 58 | 712,202 | 48,800 | 4,842 | 658,560 (93%) | $0.69 | 450s |
| project-0958c3a5928c (js/mini) | 20 | 187,522 | 22,678 | 2,028 | 162,816 (88%) | $0.25 | 96s |

**Runtime:** claude (glm-5-turbo via z.ai), `permission_mode: bypassPermissions`.
**Harness:** ai-tester 0.5.0, self-init repowise (без setup_commands из-за sandbox ограничения), `--index-only --mode fast`.

### Assertion results

| Assertion | project-6bfa82605c24 | project-0958c3a5928c |
|---|---|---|
| stay-in-sandbox | ✗ (Claude читал `~/.claude/projects/` tool-results cache — внутренний кэш Claude Code, не настоящий path escape) | ✗ (та же причина) |
| efficient (turn budget) | ✗ 58/20 | ✗ 20/25 |
| repowise-data-called | ✅ matched (repowise search вызван) | ✅ matched |
| mentions-tool-run | ✅ matched | ✗ (модель написала "tool_run" внутри markdown, но ai-tester regex проверял финальный output) |
| rg-called | ✗ (модель использовала Grep tool вместо Bash `rg`) | n/a |

**Примечание по assertion-провалам:** провалы `stay-in-sandbox` вызваны внутренним кэшем Claude Code (`~/.claude/projects/.../tool-results/`), не настоящим выходом за sandbox. `rg-called` не сматчился, т.к. модель использовала Grep tool (встроенный в Claude Code), а не Bash `rg`. Эти assertion-провалы — артефакты harness/model взаимодействия, не показатели полезности repowise.

### Вердикты модели (glm-5-turbo) — что rg vs repowise реально дали

#### project-6bfa82605c24 (php/large, 1041 PHP files, ~39K lines)

Модель (glm-5-turbo) после прогона обоих инструментов выдала следующий вердикт:

| Критерий | rg | repowise |
|---|---|---|
| Setup effort | Zero | pip install + PYTHONPATH workaround |
| Speed to first insight | ~2s | ~42s (init) |
| Architecture overview | Good — targeted queries | OK — graph stats (9037 nodes, 24188 edges) но нет narrative |
| Entry points | Routes found directly | Missed (symbol search для "main" вернул test methods, не entry points) |
| Dead code | Impossible | 462 unreachable files, 326 unused exports (~39K deletable lines) — но шумно на Laravel (container-discovered services flagged as dead) |
| Duplication | Impossible | Excellent — 481 clone pairs (e.g. `CancelStalledAgentRun` 48% dup с `RetryStalledAgentRun`; `GitHubCheckSyncResult` 100% dup с 4 sibling классами) |
| Health scoring | Impossible | avg 9.77/10, worst file `AcpSubprocessLauncher.ts` 5.7/10 |
| Dependency graph | Manual, query-by-query | Automatic — 24K edges |
| Accuracy on Laravel | High (text search) | Medium (no service-container awareness → dead-code false positives) |

**Вердикт модели:** rg дал лучший architecture insight быстрее и без setup. repowise добавил уникальную ценность в dead-code detection, duplication analysis и structural health scoring — то, что rg фундаментально не может. Для one-shot "что это за проект" — выигрывает rg. Для ongoing codebase hygiene — repowise дополняет rg, но нуждается в framework-aware tuning для Laravel service container чтобы снизить dead-code false positives.

#### project-0958c3a5928c (js/mini, 27 files)

| Критерий | rg | repowise |
|---|---|---|
| Speed | ~0.15s | ~10s (50-70x медленнее) |
| Symbol inventory | Manual (exports grep) | Automated, complete (415 symbols) |
| Dependency graph | Manual (imports grep + mental assembly) | Built-in (940 edges) |
| Complexity/health | Not available | 51 findings with scores |
| God class detection | Not available | `AcpEventParser` flagged (678 lines, CCN 26) |
| Clone detection | Not available | Test duplication mapped (36-66% в test files) |
| Dead code | Not available | 0 (clean codebase) |
| Friction | Zero setup | Requires init + cleanup |

**Вердикт модели:** repowise adds real value over raw rg — health report, complexity scoring и structural metrics (god classes, brain methods, PageRank) — это то, что rg просто не может дать. На маленьком проекте (27 files) rg быстрее и достаточен для basic exploration. Но 10s инвестиция repowise даёт insights (complexity hotspots, duplication, centrality), которые потребовали бы значительной ручной работы с rg. На больших кодовых базах разрыв widen.

### Сводный вывод из smoke-прогона

Оба профиля дают согласованную картину:
1. **rg выигрывает на speed + zero-setup + entry-point discovery** — для one-shot "что это за проект" вопроса.
2. **repowise выигрывает на structural analysis** — dead-code, duplication, health scoring, dependency graph — возможности, которых у rg нет.
3. **repowise имеет framework-awareness gap** — на Laravel (service container) dead-code analysis даёт false positives. Этот сигнал уже зафиксирован как bounded PHP/framework `known_avoid_cases` entry для exact lookup; он не обобщается за пределы evidence-backed match.
4. **Investment ratio:** на large проекте 42s init окупается; на mini — overhead заметен (50-70x), но insight всё равно добавляется.

### Качественные наблюдения из трасс

Оба прогона модель:
- ✅ Успешно инициализировала repowise index (`init --index-only --mode fast`)
- ✅ Вызвала repowise search/health/dead-code
- ✅ Получила непустой полезный output (project-6bfa82605c24: 9037 nodes, 24188 edges, 788 dead-code findings; project-0958c3a5928c: меньше, но non-empty)
- ✅ Завершила purge

Cache-read 88-93% указывает на heavy context reuse — модель многократно обращалась к одним и тем же данным, что ожидаемо для forced overhead measurement.

### Boundary facts (из spike 2026-06-28 + smoke)

- `repowise init --index-only --mode fast` работает без `.git` (graph only, без git hotspots/co-change)
- Без `.git` Git-слой даёт `0 hotspots` — для full Git analysis нужен `.git` в fixture
- `setup_commands` в ai-tester sandbox не работают на sanitized copies (без `.git`) — обход: self-init в prompt
- repowise.exe не на PATH в spawned subprocess — нужен полный путь или PATH augmentation

## Spike 2026-06-28 (qualitative, не metadata-eligible)

Качественный спайк на копии проекта project-6bfa82605c24 (1045 PHP-файлов, 480 коммитов, `--index-only` tier, zero LLM):

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
