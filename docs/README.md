[К README](../README.md) | [Следующая страница](usage.md)

# Документация

Эта документация описывает workflow AIFHub Extension v1:

```text
AI Factory UX + OpenSpec artifact protocol
```

OpenSpec-native artifacts в `openspec/` являются canonical. AI Factory artifacts в `.ai-factory/` хранят runtime state, QA evidence, generated rules и legacy migration input.

OpenSpec CLI features вызываются через AIFHub wrappers и `scripts/openspec-runner.mjs`; OpenSpec skills или slash commands extension не устанавливает.

## Порядок Чтения

1. [Project README](../README.md) - landing page, quick start, artifact layout, compatibility summary, migration summary и troubleshooting summary.
2. [Usage](usage.md) - полный command flow, AI Factory 2.19 session warmup, `/aif-mode` switching and sync, AI Factory 2.18 mode matrix, regular/ultra research, classic/marked-ultra verification and archive boundaries, upstream project utilities, rules/review/security gates, finalization tail, update-not-upgrade guidance, deterministic/live consumer smoke, troubleshooting и examples.
3. [Context Providers](context-providers.md) - optional Graphify context, CodeGraph manual CLI context, Context7 documentation provider guidance, reviewed-note paths, degraded behavior и user-owned setup boundaries.
4. [Safety Providers](safety-providers.md) - optional dcg pre-execution guard, manual install references, allowed probes, degraded behavior и strict user-owned setup/hook boundaries.
5. [Memory Tool Recommendations](memory-tool-recommendations.md) - local metadata-driven optional tool recommendations и installed wrapper commands.
6. [Session Context Dedup](context-dedup.md) - optional `off | aifhub | sqz` context optimization, protected artifacts, ledger paths, external-tool consent, CLI и MCP surface.
7. [Context Loading Policy](context-loading-policy.md) - Base Context, AI Factory 2.19 upstream warmup boundary, optional project glossary, review policy, optional Graphify/CodeGraph/Context7 guidance, GitHub-aware roadmap evidence, ownership boundaries, generated rules, quality gates, parent-owned commit grouping, upstream architecture/docs/QA/archive/distillation utilities, commit handoff и legacy path rules.
8. [Project Review Policy](review-policy.md) - configurable root-default `REVIEW.md`, scaffold ownership, review-only consumers, precedence, path safety и policy/session-state boundary.
9. [OpenSpec Compatibility](openspec-compatibility.md) - optional CLI adapter support, exact-tagged OpenSpec 1.10.0 reviewed baseline from 1.3.1, tracked Git/npm custody and CLI matrix, pinned AI Factory 2.19 source snapshot plus the 2.18.1 published-executable baseline, cumulative 2.18 classic/ultra plan and research contracts, upstream coherence ownership, revision-bound receipt, archive guard, ownership/no-op ledger, artifact sync points, rules gate, Node requirements, validation policy flags и degraded mode.
10. [OpenSpec Artifact Validation](openspec-validation.md) - AIFHub contract validator поверх OpenSpec CLI validation.
11. [OpenSpec Coverage Matrix](spec-coverage.md) - requirement-to-task-to-code coverage evidence и verify/done policy.
12. [Legacy Plan Migration](legacy-plan-migration.md) - если существующие `.ai-factory/plans` artifacts нужно перенести в OpenSpec-native changes.
13. [Active Change Resolver](active-change-resolver.md) - active change selection, runtime paths, current pointer behavior и ambiguity diagnostics.
14. [Handoff Validation Profile](handoff-validation-profile.md) - read-only orchestration summary contract.
15. [ADR 0001](adr/0001-openspec-native-artifact-protocol.md) - v1 artifact ownership decision.
16. [ADR 0002: Optional Project Glossary](adr/0002-optional-project-context-glossary.md) - protocol-neutral glossary ownership, lexical authority and deferred OKF decision.
17. [ADR 0003: Durable Project Review Policy](adr/0003-durable-project-review-policy.md) - review-policy namespace, ownership, authority and session-state separation.

Остальные runtime-specific guides являются supporting references:

- [AIFHub MCP](aifhub-mcp.md)
- [Codex Agents](codex-agents.md)
- [Claude Agents](claude-agents.md)
- [Research по Memory Tools](memory-tools-research/README.md)
- [Codex Plan Mode](codex-plan-mode.md)
- [Handoff Naming](handoff.md)
- [Handoff Validation Profile](handoff-validation-profile.md)

## Guides

| Guide | Назначение |
|---|---|
| [Usage](usage.md) | Полный OpenSpec-native command flow, AI Factory 2.19 session warmup, AI Factory 2.18 mode/profile matrix, regular/ultra research, revision-bound legacy-ultra receipt, archive/update boundaries, optional providers, gates, finalization tail и examples |
| [Context Providers](context-providers.md) | Optional Graphify context, CodeGraph manual CLI context и Context7 provider guidance, reviewed-note paths, degraded behavior, credential safety и user-owned setup boundaries |
| [Safety Providers](safety-providers.md) | Optional dcg pre-execution guard, manual user-owned setup, allowed probes, degraded behavior, hook/config boundaries и artifact safety |
| [Memory Tool Recommendations](memory-tool-recommendations.md) | Local metadata-driven optional memory/context tool recommendations и installed wrapper commands |
| [Session Context Dedup](context-dedup.md) | Optional `off | aifhub | sqz` context optimization: decision table, protected artifacts, ledger/purge paths, external-tool consent, CLI и MCP surface |
| [Context Loading Policy](context-loading-policy.md) | Runtime context, AI Factory 2.19 upstream warmup, Optional Project Glossary, optional Graphify/CodeGraph/Context7 context, GitHub-aware roadmap evidence, ownership, gates, commit handoff, upstream `/aif-architecture`, `/aif-docs`, `/aif-qa`, `/aif-archive` and `/aif-distillation` boundaries и legacy boundaries |
| [Project Review Policy](review-policy.md) | Configurable `reviews.policy_file`, root `REVIEW.md` default, scaffold lifecycle, safe read-only review consumption и policy/session-state boundary |
| [OpenSpec Compatibility](openspec-compatibility.md) | CLI adapter policy, exact-tagged OpenSpec 1.10.0 reviewed baseline from 1.3.1, tracked Git/npm custody and CLI matrix, AI Factory 2.19 pinned source snapshot and 2.18.1 executable baseline, cumulative 2.18 plan/research/archive adapters, upstream coherence ownership, exact consumer ownership/no-ops, validation policy flags, sync points, rules gate, version support и degraded mode |
| [OpenSpec Artifact Validation](openspec-validation.md) | Read-only AIFHub contract validator для canonical artifacts, runtime evidence, QA и generated rules |
| [OpenSpec Coverage Matrix](spec-coverage.md) | Requirement-to-task-to-code coverage evidence, policy, staleness и integration points |
| [Legacy Plan Migration](legacy-plan-migration.md) | Explicit migration commands и artifact mapping |
| [Active Change Resolver](active-change-resolver.md) | Active change selection и runtime paths |
| [Handoff Validation Profile](handoff-validation-profile.md) | Read-only validation summary contract для Handoff orchestration |
| [ADR 0001](adr/0001-openspec-native-artifact-protocol.md) | Canonical OpenSpec и AI Factory runtime state contract |
| [ADR 0002: Optional Project Glossary](adr/0002-optional-project-context-glossary.md) | Configurable `CONTEXT.md`, `/aif-analyze` ownership, read-only consumers и deferred OKF |
| [ADR 0003: Durable Project Review Policy](adr/0003-durable-project-review-policy.md) | Configurable `REVIEW.md`, review-only authority, path safety и durable-policy boundary |
| [AIFHub MCP](aifhub-mcp.md) | Optional MCP server tools, runtime-specific config shapes и AI Factory 2.16+ Universal / Other `.mcp.json` rendering |
| [Codex Agents](codex-agents.md) | Namespaced Codex subagents и invocation contract |
| [Claude Agents](claude-agents.md) | Namespaced Claude subagents и install target |
| [Research по Memory Tools](memory-tools-research/README.md) | Результаты проверки local memory/retrieval кандидатов для optional context providers |
| [AI Tester Matrix Для Memory Tools](memory-tools-research/ai-tester-matrix.md) | Paired `rg` baseline и optional-tool matrix для dimension-aware recommendation metadata |
| [CodeGraph Benchmark Results](memory-tools-research/codegraph-benchmark-results.md) | Видимые paired `rg`/CodeGraph test rows, token traces и 47-profile matrix summary |
| [AI Tester Token Matrices](memory-tools-research/ai-tester-token-matrices.md) | Таблицы по skill с реальными `ai-tester` input/output/cache token traces и `NOT_RUN` строками |
| [Codex Plan Mode](codex-plan-mode.md) | Codex mode и question-format guidance |
| [Handoff Naming](handoff.md) | Stage vocabulary versus public CLI commands |

## Границы

Этот набор docs покрывает:

- OpenSpec-native v1 workflow
- artifact mode switching и sync через `/aif-mode`
- command reads, writes и forbidden writes
- optional Graphify context provider guidance
- optional CodeGraph manual CLI context provider guidance
- optional Context7 documentation provider guidance
- optional dcg safety provider guidance with user-owned install and hook boundaries
- optional local memory/retrieval candidate research
- optional session-scoped read deduplication
- configurable durable `REVIEW.md` policy and its review-session state boundary
- optional rules, review и security gates
- verification, fix, done, post-archive sync, commit и evolve handoff
- pinned AI Factory 2.19 source snapshot with upstream-owned `/aif-warmup`, user-owned `warmup.paths`, Microsoft APM skills-only distribution boundary, unchanged extension/runtime contracts, and an explicit no-release/no-published-executable claim
- AI Factory 2.18.1 published-executable baseline, including the upstream-owned Research Coherence Gate, immutable Original Request, canonical ultra depth in OpenSpec-native mode, marker-first legacy classic/ultra routing, regular/ultra research, revision-bound legacy-ultra verification receipt, OpenSpec-native archive guard, update-not-upgrade semantics, exact namespaced-agent handoffs, and explicit `/aif-loop`/`/aif-transfer` no-ops
- upstream `/aif-architecture`, `/aif-docs`, and `/aif-qa` project-context utility boundaries; they are not required per-change OpenSpec lifecycle gates
- AI Factory 2.13+ parent-owned `/aif-commit` `## Commit Plan` grouping
- upstream `/aif-distillation` utility skill boundaries; it is not an AIFHub lifecycle stage and writes generated skill packages to the current agent skills directory
- OpenSpec 1.10.0 reviewed baseline from 1.3.1, including `1.6.0-beta.1`, exact Git/npm custody and CLI matrix, inline task verification, Store-root specs instructions, no-spec schema scaffolding, stderr output hygiene, blocked-retirement diagnostics, prior strict/non-strict task-numbering and scenario-loss semantics, advisory-only archived validation, native `skip_specs`, and adapter-only ownership boundaries for Zed, `init --language`, profiles, schemas, OpenSpec skills, `/opsx:*`, agent targets, tool integrations, Stores, workspace beta state, package management, and `openspec update`; OpenSpec 1.11 remains outside scope
- OpenSpec requirement coverage evidence и policy
- canonical OpenSpec artifact ownership
- AI Factory runtime state, QA evidence и generated rules
- legacy AI Factory-only compatibility и migration
- runtime-managed Codex и Claude agent files
- optional AIFHub MCP server registration и runtime-specific settings shapes

Она не описывает `.ai-factory/plans` как normal v1 artifact model. Эти paths являются только legacy compatibility и migration input.

## Локальные Проверки

Запуск:

```bash
npm run validate
npm test
```

`npm run validate` проверяет markdown links в `docs/`, `injections/` и `skills/`. Links в root `README.md` требуют manual check при изменениях.

## См. Также

- [Project README](../README.md)
- [Usage](usage.md)
- [Context Providers](context-providers.md)
- [Safety Providers](safety-providers.md)
- [Memory Tool Recommendations](memory-tool-recommendations.md)
- [Session Context Dedup](context-dedup.md)
- [Context Loading Policy](context-loading-policy.md)
- [Project Review Policy](review-policy.md)
- [OpenSpec Compatibility](openspec-compatibility.md)
- [OpenSpec Artifact Validation](openspec-validation.md)
- [OpenSpec Coverage Matrix](spec-coverage.md)
- [Legacy Plan Migration](legacy-plan-migration.md)
- [Active Change Resolver](active-change-resolver.md)
- [Handoff Validation Profile](handoff-validation-profile.md)
- [ADR 0001](adr/0001-openspec-native-artifact-protocol.md)
- [ADR 0002: Optional Project Glossary](adr/0002-optional-project-context-glossary.md)
- [ADR 0003: Durable Project Review Policy](adr/0003-durable-project-review-policy.md)
- [AIFHub MCP](aifhub-mcp.md)
- [Research по Memory Tools](memory-tools-research/README.md)
- [AI Tester Matrix Для Memory Tools](memory-tools-research/ai-tester-matrix.md)
- [CodeGraph Benchmark Results](memory-tools-research/codegraph-benchmark-results.md)
- [AI Tester Token Matrices](memory-tools-research/ai-tester-token-matrices.md)
