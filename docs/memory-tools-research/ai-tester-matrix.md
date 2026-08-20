# AI Tester Matrix Для Memory Tools

Эта страница описывает воспроизводимый прогон optional memory/context tools через `ai-tester`. Матрица всегда сравнивает инструмент с тем же сценарием через `rg`: сначала `baseline_rg`, затем `tool_run`, затем нормализованное сравнение.

Ключевое правило: benchmark должен быть перекрестным. Решение по инструменту нельзя делать по одному skill или одному project label. Минимальная матрица для recommendation evidence: `tool x representative skills x representative project labels x rg/tool_run`. Только такая таблица отвечает, какой skill с каким инструментом лучше использовать на каком типе проекта.

Связанные артефакты:

- [recommendation-metadata.yaml](recommendation-metadata.yaml) - machine-readable dimensions, suites, decision actions и aggregate evidence id.
- [ai-tester-scenarios.yaml](ai-tester-scenarios.yaml) - authored scenario catalog для repeatable task/skill/tool runs и metadata promotion gates.
- [README.md](README.md) - итоговые таблицы по форматам проектов.

## Запуск

Installed-project сценарии должны использовать wrapper:

```bash
ai-factory aifhub-memory-tools select --from-project --command aif-explore --json
```

Для разработки extension допустим development-only fallback, если установленный wrapper еще не содержит новый script:

```bash
node scripts/memory-tool-recommender.mjs select --from-project --command aif-explore --json
```

Генератор матрицы:

```bash
node scripts/memory-tool-ai-tester-evaluate-tool.mjs --tool codegraph --root <project-dir> --preinitialize --json
node scripts/memory-tool-ai-tester-evaluate-tool.mjs --tool graphify --root <project-dir> --scenario-id architecture-impact-discovery --no-run --json
node scripts/memory-tool-ai-tester-evaluate-tool.mjs --tool graphify --root <project-dir> --scenario-id architecture-impact-discovery --task architecture_or_impact_discovery --profile-id-mode path-hash --scenario-prefix gf-p<hash>-arch --json
node scripts/memory-tool-ai-tester-matrix.mjs --roots <projects-root> --out <temp-run-dir> --max-profiles 5 --json
node scripts/memory-tool-ai-tester-matrix.mjs --roots <projects-root> --out <temp-run-dir> --dry-run --json
node scripts/memory-tool-ai-tester-matrix.mjs --roots <projects-root> --tool codegraph --matrix-size screening --preinitialize-tool codegraph --scenario-prefix screening-codegraph --json
node scripts/memory-tool-ai-tester-matrix.mjs --roots <projects-root> --tool codegraph --matrix-size profile-sweep --json
node scripts/memory-tool-ai-tester-matrix.mjs --roots <projects-root> --tool codegraph --matrix-size skill-sweep --json
node scripts/memory-tool-ai-tester-matrix.mjs --roots <projects-root> --tool codegraph --skill aif-explore --task architecture_or_impact_discovery --json
node scripts/memory-tool-ai-tester-matrix.mjs --roots <projects-root> --tool codegraph --task architecture_or_impact_discovery --json
node scripts/memory-tool-ai-tester-matrix.mjs --roots <projects-root> --tool codegraph --skill aif-explore --task architecture_or_impact_discovery --preinitialize-tool codegraph --json
node scripts/memory-tool-ai-tester-matrix.mjs --roots <projects-root> --tool graphify --skill aif-explore --task explicit_graph_quality_experiment --preinitialize-tool graphify --json
node scripts/memory-tool-ai-tester-matrix.mjs --roots <projects-root> --tool context7 --skill aif-rules-check --task version_sensitive_library_docs --preinitialize-tool context7 --json
```

Catalog-driven matrix:

```bash
node scripts/memory-tool-ai-tester-matrix.mjs --roots <projects-root> --out <run-dir> --scenario-catalog docs/memory-tools-research/ai-tester-scenarios.yaml --run-class accepted_evidence --tool codegraph --tool graphify --scenario-prefix proven-labels-20260611 --json
node scripts/memory-tool-ai-tester-matrix.mjs --roots <projects-root> --out <run-dir> --scenario-catalog docs/memory-tools-research/ai-tester-scenarios.yaml --scenario-id architecture-impact-discovery --label js --label standard --json
```

Reduced cross examples:

```bash
node scripts/memory-tool-ai-tester-matrix.mjs --roots <projects-root> --exclude-root <excluded-root> --out <run-dir> --tool graphify --skill aif-analyze --skill aif-explore --skill aif-plan --skill aif-review --task explicit_graph_quality_experiment --max-profiles 4 --stratified --preinitialize-tool graphify --scenario-prefix cross-graphify --json
node scripts/memory-tool-ai-tester-matrix.mjs --roots <projects-root> --exclude-root <excluded-root> --out <run-dir> --tool context7 --skill aif-plan --skill aif-rules-check --task version_sensitive_library_docs --max-profiles 4 --stratified --preinitialize-tool context7 --scenario-prefix cross-context7 --json
```

`--roots` может указывать на один проект или каталог с проектами. Durable docs не должны содержать этот путь; public output хранит только anonymous profile ids.

Для локальных подтверждающих runs используйте `--profile-id-mode path-hash`. Тогда профиль получает stable public id `project-<12 hex>`, рассчитанный из normalized absolute path, и этот id используется в scenario names, fixture folders, reports и promotion proposal. Durable docs должны ссылаться на `project-<hash>`, labels и relative report path, но не на реальный root.

`memory-tool-ai-tester-evaluate-tool.mjs` является one-shot wrapper для одного tool и одного project root. Он выполняет pipeline: scenario matrix -> missing `ai-tester` runs -> JSON/Markdown report -> metadata promotion proposal. По умолчанию он пишет результаты в `.ai-factory/state/ai-tester-tool-evaluations/<tool>-<timestamp>/` и не меняет `recommendation-metadata.yaml`. Для записи proven labels в metadata нужен явный `--apply`; без него создается только proposal.

Используйте `--scenario-prefix <id>` для каждого нового большого прогона. `ai-tester` хранит traces глобально по scenario id; prefix предотвращает случайное переиспользование старых traces с такими же `matrix-profile-01` ids. Prefix должен быть коротким: длинные scenario ids могут превысить Windows path limits в global `ai-tester/runs` directory. Практичный формат: `<tool>-p<hash8>-<scenario>-<skills>-<hhmm>`.

По умолчанию генератор использует `--matrix-size screening`, а не exhaustive matrix. Цель первого прогона - найти условия, где tool может быть выгоден по tokens/time/result, а не оплатить все комбинации заранее.

| Preset | Profiles | Skills | Task set | Scenarios per tool | Когда запускать |
|---|---:|---:|---|---:|---|
| `screening` | 15 stratified | 10 grouped representatives | `primary` | 300 | Первый проход: найти signal по skill group и project labels. |
| `profile-sweep` | all discovered | 4 high-signal representatives | `primary` | `profiles * 8` | Подтвердить project/profile условия после screening. |
| `skill-sweep` | 8 stratified | 29 AI Factory skills | `primary` | 464 | Проверить все skills на малой выборке проектов. |
| `full` | all discovered | metadata skills by default | `primary` | depends | Audit mode; для 29 skills x 47 profiles используйте `--matrix-size full --skill-set all`, это 2726 scenarios per tool/task. |

Для полного локального набора старый exhaustive вариант был слишком дорогим: 29 skills * 47 profiles * 2 runs = 2726 scenarios для одного tool/task. После исключения ненужных roots число проектов может быть меньше, но правило сохраняется: сначала `screening`, затем targeted confirmation.

Если screening запускается не на grouped representatives, а на ручном наборе, набор должен пересекать минимум два skill groups и минимум два project labels. Одноосевые проверки (`1 skill x many projects` или `many skills x 1 project`) допустимы только как диагностика, но не как recommendation evidence.

Skill groups покрывают все AI Factory skills через representatives:

| Group | Representatives | Members |
|---|---|---|
| `bootstrap_analysis` | `aif-analyze` | `aif`, `aif-init`, `aif-analyze`, `aif-mode` |
| `research_architecture` | `aif-explore` | `aif-explore`, `aif-architecture`, `aif-grounded` |
| `planning_refinement` | `aif-plan` | `aif-plan`, `aif-improve`, `aif-roadmap`, `aif-loop` |
| `implementation_fix` | `aif-implement`, `aif-fix` | `aif-implement`, `aif-fix` |
| `review_quality_gates` | `aif-review`, `aif-rules-check`, `aif-verify` | `aif-review`, `aif-qa`, `aif-rules-check`, `aif-security-checklist`, `aif-verify`, `aif-done` |
| `generation_output` | `aif-docs` | `aif-build-automation`, `aif-ci`, `aif-dockerize`, `aif-docs`, `aif-reference`, `aif-rules`, `aif-skill-generator` |
| `commit_finalization` | `aif-commit` | `aif-commit` |
| `guidance_only` | none by default | `aif-best-practices`, `aif-evolve` |

Windows note: runner должен уметь выполнять `fixtures.setup_commands` через Windows shell. В локальном прогоне `ai-tester 0.5.0` был patched to use `cmd.exe` for setup commands instead of hard-coded `/bin/sh`. Для Codex runtime preflight `ai-tester 0.5.0` вызывает `which codex`; `memory-tool-ai-tester-run-missing.mjs` на Windows добавляет локальный `.runner-bin/which.exe` shim внутри run dir, который не переносится в durable docs.

## Scenario Catalog

`ai-tester-scenarios.yaml` задает stable scenarios отдельно от generator code. Каждый scenario содержит:

- `task_signal`: normalized task label, например `architecture_or_impact_discovery`;
- `run_class`: `accepted_evidence` для metadata-grade runs, `focused`/`screening`/`smoke` для диагностических прогонов;
- `skills` и `tools`: какие AIF skills и candidate tools проверяются против `rg`;
- `fixture_requirements.labels_any`: exact project label sets, на которых scenario допустим;
- `promotion_policy`: можно ли переносить результат в `proven_label_evidence` и какой минимум PASS/PASS пар нужен.

Только `run_class: accepted_evidence` и `promotion_policy.eligible_for_metadata: true` могут попасть в metadata. Focused/smoke runs остаются research context и не меняют selector behavior.

## Контракт Сценария

Каждый optional tool case имеет пару:

| Run | Назначение | Обязательное поведение |
|---|---|---|
| `baseline_rg` | Проверить тот же task через literal/direct repo search. | `rg` вызывается первым, optional tools не вызываются. |
| `tool_run` | Проверить optional tool на том же fixture/task. | Сначала `rg`, затем direct tool invocation; selector behavior проверяется отдельно recommender tests. Для CodeGraph обязательна data-команда `files`, `query` или `context`, простой `--help` не считается полезным использованием. |
| `comparison` | Принять recommendation decision. | Считаются speed, token, noise, accuracy, usefulness, safety и purge deltas. |

Для инструментов с индексом генератор поддерживает warm/preinitialized режим. `--preinitialize-tool codegraph` добавляет в `fixtures.setup_commands` команды `codegraph init .` и `codegraph index --quiet .` до model turn. В самом model turn сценарий запрещает `codegraph init/index`, требует чтение данных из существующего индекса через `codegraph files`, `codegraph query` или `codegraph context`, и требует purge через `codegraph uninit --force .`.

Для инструментов, которых обычно нет в `PATH`, `--preinitialize-tool` может подготовить project-local CLI до model turn:

| Tool | Подготовка | Model turn command |
|---|---|---|
| `graphify` | Python venv под `project/.ai-tester-tools/graphify-venv`, install `graphifyy` | prepend venv `Scripts` to PATH, then call `graphify update/query/benchmark` |
| `context7` | npm prefix под `project/.ai-tester-tools/context7`, install `ctx7` | prepend `.bin` to PATH, then call `ctx7` |

`context-mode` не входит в generic memory-tool matrix и не поддерживает `--preinitialize-tool`: любая explicit `--tool`/`--preinitialize-tool` list с `context-mode`, а также catalog selection с `context-mode` (включая unfiltered catalog run), атомарно отклоняется до создания output directory и возвращает structured JSON с `status: NOT_RUN`, `reason: context_mode_requires_dedicated_harness`, `tool_id: context-mode` и путём dedicated harness. Generic tools из такой mixed selection намеренно не запускаются, чтобы request не превращался в silent partial success. Для issue `#134` используйте только pinned isolated `scripts/context-mode-codex-ai-tester-{matrix,adapter,run,results}.mjs` harness.

Rejected tools (`codex-mem`, `eagle-mem`) не получают positive tool_run setup; для них допустимы только negative/forbidden ai-tester scenarios. Safety/smoke runs не считаются benchmark.

Сценарии используют native `ai-tester` поля: `system_prompt_file`, `copy_trees`, `skill`, `user_prompt` или `user_prompts`, `runner.setting_sources` для CLI-parity suites, и assertions `tool_called`, `tool_call_sequence`, `no_tool_called`, `output_contains`, `turn_count_at_most`, `no_path_escape`.

## Expectations

| Expectation | Значение |
|---|---|
| `baseline_rg` | Baseline на том же profile/task/skill перед optional tool. |
| `positive` | Tool выбран selector-ом, разрешен metadata и должен дать measured value. |
| `negative` | Tool включен в config или matrix, но запрещен для skill/command и не должен вызываться. |
| `overhead` | Tool intentionally запускается, но проигрывает `rg` для mini/exact lookup или шумного нецелевого scenario. |
| `not_applicable` | Tool не относится к task signal, например docs provider для code lookup. |

## Decision Mapping

| Decision | Когда применять | Metadata action |
|---|---|---|
| `recommend` | Tool стабильно лучше `rg` по quality/speed/token/noise и проходит safety/purge. | Рекомендовать только для matching dimensions. |
| `conditional` | Tool полезен только для broad discovery, docs lookup, continuity или compression. | Оставить conditional recommendation с task/profile filter. |
| `avoid` | Tool медленнее, дороже, шумнее или хуже `rg` для profile/task. | Добавить в `avoid_tools` или `do_not_recommend_for`. |
| `forbid` | Tool нарушает safety, scope или purge. | Запретить для соответствующих skills/profiles. |
| `NOT_RUN` | Evidence неполна или execution недоступен. | Не выводить comparison или safety failure и не продвигать metadata. |

## Promotion To Metadata

После прогона `ai-tester` сначала нормализуйте отчет, затем создайте proposal:

```bash
node scripts/memory-tool-ai-tester-results-report.mjs --matrix-dir <run-dir> --runs-dir <ai-tester-runs-dir> --json
node scripts/memory-tool-ai-tester-promote-metadata.mjs --report <run-dir>/ai-tester-token-matrices.json --scenario-catalog docs/memory-tools-research/ai-tester-scenarios.yaml --run-id <evidence-run-id> --json
```

По умолчанию promotion script пишет только proposal в `.ai-factory/state/ai-tester-proven-label-scenarios/`. `recommendation-metadata.yaml` изменяется только с `--apply`. Proposal проходит leak check: absolute paths, raw transcripts, private temp paths и secret-like strings не допускаются.

Promoted entries попадают в `proven_label_evidence`. Selector использует их как exact allow только когда совпали `tool_id`, `skill`, `task_scenario`, `run_class: accepted_evidence`, минимум PASS/PASS пар, useful signal и все required project labels. `known_avoid_cases`, command-specific `forbidden`, protected artifacts и no-auto-install policy остаются сильнее promoted labels.

Provider output остается supporting benchmark evidence only. Raw transcripts, snippets, local paths, temp paths, credentials и private profile names не сохраняются в docs, metadata, OpenSpec specs, generated rules или QA evidence.

Сами строки CodeGraph тестов вынесены в [CodeGraph Benchmark Results](codegraph-benchmark-results.md).
