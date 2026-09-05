[Предыдущая страница](context-dedup.md) | [К документации](README.md) | [Следующая страница](openspec-compatibility.md)

# Context Loading Policy

This policy defines which artifacts AIFHub Extension commands load and which artifacts they may write.

OpenSpec-native v1 has one core rule in user projects: canonical requirements and change intent live under `openspec/`; runtime state, QA evidence, and generated rules live under `.ai-factory/`.

The extension package repository is intentionally artifact-light. Root `openspec/`, `.ai-factory/state/`, `.ai-factory/qa/`, `.ai-factory/plans/`, and `.ai-factory/rules/generated/` are user-project/runtime artifacts, not extension package content. Root `.ai-factory/rules/generated/` is derived and safe to regenerate. This repo may include OpenSpec examples only under fixture paths such as `test/fixtures/` or `scripts/fixtures/`, and extension behavior requirements are validated by prompt contracts and tests rather than committed root OpenSpec specs.

OpenSpec CLI integration is a runner-backed adapter. Commands may request validation, status, instructions, and archive through `scripts/openspec-runner.mjs`, but they must not install or invoke OpenSpec slash-command skills.

## Modes

### OpenSpec-Native Mode

OpenSpec-native mode is selected when `.ai-factory/config.yaml` contains:

```yaml
aifhub:
  artifactProtocol: openspec
```

In this mode, plan-aware commands resolve active work from `openspec/changes/<change-id>/`, not from `.ai-factory/plans/`.

On stable AI Factory `>=2.18.0`, explicit `ultra` is a canonical detail profile in this mode. It may deepen `design.md`, `tasks.md`, and applicable delta specs, but it does not change artifact ownership and must not create `index.md`, `phase-*`, companion files, or an active `<!-- aif:plan-mode:ultra -->` under a canonical change.

`/aif-mode openspec` is the mode-switching entrypoint. It may update config and ensure skeleton directories, but it does not create feature-specific canonical change content by itself.

### Legacy AI Factory-Only Mode

Legacy AI Factory-only mode uses the older companion plan model:

```text
.ai-factory/plans/<plan-id>.md
.ai-factory/plans/<plan-id>/
```

AI Factory 2.18 also supports an atomic marked ultra shape:

```text
.ai-factory/plans/<plan-id>/index.md
.ai-factory/plans/<plan-id>/phase-NN-<slug>.md
```

`index.md` contains exactly one standalone `<!-- aif:plan-mode:ultra -->` and is the sole progress ledger. AIFHub classifies this marker before classic folder-only discovery, never creates a sibling classic plan/companions, and returns exact upstream command handoffs.

These paths remain supported only for legacy compatibility and explicit migration input.

`/aif-mode ai-factory` switches the config path profile back to this model. It preserves `openspec/` and treats OpenSpec-to-legacy output as compatibility export only.

## Base Context

Consumer commands load these project context files when present:

- `.ai-factory/config.yaml`
- `.ai-factory/DESCRIPTION.md`
- `.ai-factory/ARCHITECTURE.md`
- `.ai-factory/RULES.md`
- `.ai-factory/rules/base.md`
- configured `paths.context` project glossary (`CONTEXT.md` by default), when present
- configured area rules from `.ai-factory/config.yaml`

Consumer commands must not use bridge files such as `AGENTS.md`, `CLAUDE.md`, `QWEN.md`, or `AIFACTORY.md` as substitutes for configured context paths.

## AI Factory 2.19 Session Warmup

The reviewed AI Factory source snapshot declaring `2.19.0` adds upstream `/aif-warmup` as a read-only session-start handoff. AIFHub does not copy, replace, or inject that skill.

- Upstream warmup reads the configured DESCRIPTION, ARCHITECTURE, ROADMAP, RESEARCH, top-level and area rules, applicable `AGENTS.md` instructions, selected language/git/workflow preferences, and explicit `warmup.paths` entries.
- Applicable `AGENTS.md` files are instruction context for the handoff; they do not replace missing configured project artifacts or become canonical OpenSpec requirements.
- `warmup.paths` is an ordered user-owned list. Fresh AIFHub-created configs include `[]`; existing lists are preserved, and existing configs without the section are not backfilled.
- Optional glossary or reviewed provider notes enter warmup only when the user explicitly lists a safe project-relative file or directory. Warmup does not auto-run providers, MCP setup, context dedup, OpenSpec CLI operations, validation, or generated-rules compilation.
- Canonical changes, plans, QA evidence, generated rules, raw provider output, credentials, and unrelated application code are not implicit startup inputs. Their normal command-specific ownership and safety rules remain unchanged.

Warmup may summarize context for a later command or fork, but it stops before planning or implementation and writes no repository or AI Factory artifact.

## OpenSpec-Native Context Set

Plan-aware consumer commands load these canonical artifacts:

- `openspec/changes/<change-id>/proposal.md`
- `openspec/changes/<change-id>/design.md`
- `openspec/changes/<change-id>/tasks.md`
- `openspec/changes/<change-id>/specs/**/spec.md`
- `openspec/specs/**/spec.md`

They may also load derived/runtime artifacts:

- `.ai-factory/rules/generated/openspec-base.md`
- `.ai-factory/rules/generated/openspec-change-<change-id>.md`
- `.ai-factory/rules/generated/openspec-merged-<change-id>.md`
- `.ai-factory/rules/generated/openspec-rules-trace-<change-id>.json`
- `.ai-factory/rules/generated/index.json`
- `.ai-factory/state/<change-id>/**`
- `.ai-factory/qa/<change-id>/**`

Generated rules and generated trace metadata are derived guidance only. If generated rules conflict with canonical OpenSpec artifacts, canonical OpenSpec artifacts win.

Runner output from OpenSpec CLI commands is runtime guidance or evidence. It does not replace the canonical filesystem artifacts under `openspec/`.

## AI Factory 2.18 Research Context

Research is non-canonical supporting context in either artifact mode:

- Regular `/aif-explore <topic>` writes only the resolved `paths.research` file, `.ai-factory/RESEARCH.md` by default.
- Explicit `/aif-explore ultra <topic>` requires stable matching AI Factory `>=2.18.0` evidence and writes one sibling `<parent(paths.research)>/research/<slug>/` bundle. It does not write the regular file in the same run.
- The minimum ultra bundle is `INDEX.md` plus `RESEARCH.md`. `INDEX.md` has exactly one standalone `<!-- aif:research-mode:ultra -->`, one supported status, and one safe direct `RESEARCH.md` link. C4, ADR, and dependency artifacts exist only when evidence gates require them.
- Consumers select an explicit safe `RESEARCH.md`, exact slug, or exactly one reviewed materially relevant active bundle. Ambiguity is a no-write/no-selection stop; timestamps and fuzzy matching do not decide.
- Downstream scope comes only from the selected Active Summary with its source/revision/digest binding. Sibling rationale cannot silently expand scope.
- Research bundles, raw provider output, and research marker/index files are forbidden under `openspec/changes/**`, `openspec/specs/**`, `.ai-factory/qa/**`, and `.ai-factory/rules/generated/**`.

AI Factory `2.18.1` owns the upstream-owned `Research Coherence Gate` for every persisted regular or ultra research update. The AIFHub prepend controls only mode/version/path/write boundaries and then passes through to that gate before presentation or session append; it does not copy, replace, skip, or delay the upstream algorithm. Fresh-context `Task` delegation is optional, while the same direct read-only checks are the mandatory fallback. In ultra mode coherence completes before the Bundle Integrity Gate; any non-PASS outcome stops presentation/session completion.

## Optional Project Glossary

The project glossary is protocol-neutral Base Context for preferred terminology. `paths.context` configures a project-relative Markdown file and defaults to `CONTEXT.md`; mode switching preserves a custom value but never creates the file.

- `/aif-analyze` is the only writer. It creates or patch-updates the glossary only after explicit opt-in, only with source-grounded terms, and preserves manual or unknown sections.
- All other AIFHub skills, injections, and packaged agents are read-only consumers through `skills/shared/LANGUAGE-POLICY.md` and `skills/shared/PROJECT-GLOSSARY.md`.
- A missing or empty glossary is a normal non-fatal state. An unsafe or unreadable path is skipped with one bounded diagnostic that does not expose external paths or glossary contents.
- Glossary terms apply only to human-readable prose; code and API identifiers, commands, filenames, paths, schema fields, and public wire values stay unchanged.
- Conflict precedence is: source/tests and verifiable QA facts; canonical OpenSpec requirements; project rules and accepted architecture decisions; project description/architecture context; glossary terminology.
- Glossary contents are excluded from canonical OpenSpec authority, generated-rule inputs, QA evidence, runtime traces, provider stores, status/doctor checks, verification gates, and done readiness.
- OKF remains deferred until a concrete producer/consumer use case justifies a separate OpenSpec change and ADR.

## Project Review Policy

`reviews.policy_file` configures durable, protocol-neutral code review guidance and defaults to repository-root `REVIEW.md`. Unlike Base Context, the review policy is loaded only by `/aif-review` and AIFHub review sidecars through `skills/shared/REVIEW-POLICY.md`.

- `/aif-analyze` creates a missing safe scaffold through `ai-factory aifhub-review-policy scaffold --json` and preserves an existing policy during ordinary bootstrap. `/aif-mode` preserves/configures the setting but never creates or inspects the file.
- Review consumers use `ai-factory aifhub-review-policy load --json` and never reopen the configured path. The shared resolver canonicalizes the project root and nearest existing parent, binds and revalidates the opened file identity, rejects symlink/Windows junction components and canonical escapes, and blocks managed-file collisions plus canonical OpenSpec, project/generated-rules, plan/spec, archive, runtime-state, and QA roots. Missing or empty policy is non-blocking; unsafe or unreadable policy degrades custom guidance with one bounded diagnostic.
- Policy can add focus areas, conventions, forbidden patterns, testing/security/performance expectations, ignore/deprioritization guidance, severity/output preferences, and optional human-review stages.
- Policy is additive guidance below source/tests, canonical OpenSpec requirements, project/generated rules, and accepted architecture decisions. It cannot suppress material findings, authorize edits or tools, expand scope, install/configure providers, or replace verification/finalization/human approval.
- Individual findings, comments, replies, resolution/stale state, reviewed revisions, session ids, provider state, and receipts never belong in `REVIEW.md`.
- Policy contents stay out of canonical OpenSpec artifacts, generated rules, runtime/QA evidence, provider stores, receipts, diagnostics, and the final `aif-gate-result`.

See [Project Review Policy](review-policy.md) and [ADR 0003](adr/0003-durable-project-review-policy.md).

## Опциональные Context Providers

Optional providers - это read-only supporting context. Они не являются command prerequisites, dependency requirements, generated rules input, QA evidence, verification gates, done gates или canonical OpenSpec sources.

Provider output можно копировать в `.ai-factory/` только после user review и только как concise notes или reviewed summaries. Raw provider output, MCP transcripts, setup output, generated provider configuration и unreviewed sensitive output должны оставаться вне canonical OpenSpec, generated rules, runtime QA и validation artifacts.

Central provider guide находится в [Context Providers](context-providers.md), local metadata-driven recommendation diagnostics - в [Memory Tool Recommendations](memory-tool-recommendations.md).

Context/compression providers не должны rewrite validation artifacts и не должны compress protected artifacts in place. Protected validation artifacts включают `aif-gate-result`, `coverage.json`, `done-readiness.json`, `openspec/specs/**`, generated-rules traces и exact evidence snippets.

Command-output compression также не заменяет exact evidence: RTK допускается только для explicitly chosen overview, с полным raw чтением protected artifacts, patches/history и failing-test diagnostics до review/verify/fix conclusions. [Token Providers](token-providers.md) фиксирует `reject_defer` для RTK `v0.48.0`, raw bypasses и local-storage risks; rewrite exclusions не являются privacy boundary, а provider metrics не попадают в gates или `/aif-analyze` автоматически.

Optional session dedup (см. [Session Context Dedup](context-dedup.md)) подчиняется тому же правилу. Он влияет только на ответ на повторное чтение неизменившегося файла, никогда не переписывает файлы и никогда не дедуплицирует protected validation artifacts.

## Опциональный Graphify Context

Graphify - optional context/research provider. AIFHub commands могут использовать existing Graphify output как supporting context, но не должны делать Graphify required extension dependency, устанавливать `graphifyy`, запускать `graphify`, добавлять Graphify manifest dependencies, запускать или регистрировать Graphify MCP automatically, или превращать Graphify availability в verification gate.

Project preference записывается в `.ai-factory/config.yaml` как `utilities.context_tools.enabled`; `utilities.graphify.enabled` остается backward-compatible. Новые `/aif-analyze` recommendations должны приходить из local installed recommendation metadata через `ai-factory aifhub-memory-tools recommend --from-project --json`. Follow-on skills должны использовать `ai-factory aifhub-memory-tools select --from-project --command <skill> --json` и только returned `selected_tools`. Если Graphify рекомендован, рекомендация остается advisory only и не должна запускать installation, execution, dependency changes, indexing или MCP registration.

Allowed Graphify inputs - existing local или copied outputs:

- `graphify-out/GRAPH_REPORT.md`
- `graphify-out/graph.json`
- `.ai-factory/references/graphify/GRAPH_REPORT.md`
- `.ai-factory/references/graphify/graph.json`
- `.ai-factory/state/<change-id>/graphify/GRAPH_REPORT.md`
- `.ai-factory/state/<change-id>/graphify/graph.json`

Если Graphify недоступен или нет `graphify-out/GRAPH_REPORT.md`/copied report, команды продолжают нормально и сообщают Graphify context как unavailable/degraded, а не fail.

Graphify output остается только supporting evidence. `GRAPH_REPORT.md` может включать extracted, inferred, ambiguous или confidence-labeled relationships; команды должны treat graph-derived claims как hypotheses for further inspection. Final requirements, plans, findings, completion status, roadmap status, generated rules и QA verdicts должны быть grounded in canonical OpenSpec artifacts, source files, tests, runtime state, QA evidence или другом direct repository evidence.

Allowed durable storage для reviewed Graphify context:

- `.ai-factory/references/graphify/` для project-wide reference copies.
- `.ai-factory/state/<change-id>/graphify/` для change-scoped runtime copies.

Forbidden storage для Graphify generated files вроде `GRAPH_REPORT.md`, `graph.json` или `graph.html`:

- `openspec/changes/<change-id>/`
- `openspec/specs/`
- `.ai-factory/rules/generated/`
- `.ai-factory/qa/<change-id>/`

Перед копированием Graphify output в `.ai-factory/` проверьте его на sensitive information. AIFHub guidance не должен persist API keys, tokens, raw authorization headers, credential helper output, private backend diagnostics или unreviewed sensitive output в `.ai-factory/`, `openspec/`, docs, runtime state, QA evidence, generated rules или Graphify reference copies.

## Опциональный CodeGraph Context

CodeGraph - manual CLI-only optional provider для broad repo graph questions. Metadata хранит его как `manual_cli_only` с `suggest_manual_cli_for_repo_graph_when_enabled_or_explicit`. Explicit CLI scoped read и purge verified, но `install`/MCP/agent configuration mutation behavior не принят для AIFHub automation.

Safe probes ограничены `codegraph --version`, `codegraph --help` и `codegraph status`.

`/aif-analyze` может рекомендовать CodeGraph только из local metadata. `/aif-explore` может run CodeGraph только когда `ai-factory aifhub-memory-tools select --from-project --command aif-explore --json` возвращает его в `selected_tools` с `manual_purged_cli_execution`. Command lifecycle приходит из field `execution` в этом CLI output. Если pre-existing `.codegraph/` уже есть, считайте его user-owned state и не delete/reinitialize silently.

AIFHub commands не должны запускать CodeGraph installer, sync, MCP server, hooks или agent configuration mutation commands. CodeGraph output не должен заменять `rg`, canonical OpenSpec artifacts, generated rules, QA evidence или verification/done gates.

## T-Search Candidate

T-Search имеет policy `reject_defer` и не является optional provider для normal command selection. Это agentic query planner/ranker поверх отдельно served model endpoint и user-owned search backend/index; официальный harness не предоставляет ingestion, redaction, freshness, purge или MCP lifecycle.

AIFHub commands не должны рекомендовать, probe/select, устанавливать или запускать T-Search, скачивать weights, стартовать model/search endpoints, индексировать repository, менять provider config или сохранять raw provider output. Search snippets попадают в model messages и serialized transcripts, поэтому `result.documents`, `messages`, `all_round_messages`, round summaries и tool traces не являются допустимым durable context.

Будущий явно авторизованный experiment может использовать только bounded user-owned index и вернуть reviewed project-relative pointers; каждое утверждение нужно проверить по direct source files. Promotion требует redaction/exclusions, revision freshness, verified purge и same-run mixed Russian/English code/Markdown/OpenSpec benchmark против `rg`. См. [T-Search research](memory-tools-research/t-search.md) и [benchmark results](memory-tools-research/t-search-benchmark-results.md).

## Опциональный Context7 Documentation Context

Context7 - optional documentation provider для current library/API docs. AIFHub commands и sidecars могут использовать existing user-provided или reviewed Context7 notes как supporting context, но не должны делать Context7 required extension dependency, устанавливать `ctx7` или `@upstash/context7-mcp`, запускать `ctx7`, запускать `ctx7 setup`, добавлять Context7 manifest dependencies, добавлять Context7 MCP templates в `extension.json`, start/register Context7 MCP automatically, mutate `.mcp.json`, `.cursor/mcp.json`, `.opencode.json`, agent rules или agent skills, или превращать Context7 availability в verification gate.

Manual CLI examples вроде `npx ctx7 library <name> <query>` и `npx ctx7 docs <libraryId> <query>` находятся вне AIFHub command ownership. Если user-installed `ctx7` CLI уже доступен, equivalent commands `ctx7 library <name> <query>` и `ctx7 docs <libraryId> <query>` тоже user-owned. Если Context7 unavailable, unauthenticated, rate-limited, missing provider access или blocked by local Node.js runtime constraints, команды продолжают нормально и report Context7 context как unavailable/degraded, а не fail.

Если пользователь уже configured Context7 MCP, agents могут использовать его как optional read-only documentation context. Common flow: `resolve-library-id`, затем docs retrieval tool. Retrieval tool может называться `get-library-docs` или `query-docs` в зависимости от Context7 client/server version.

Context7 output остается только supporting evidence. Library IDs вроде `/org/project`, `/org/project/version`, `/org/project@version`, `/packages/<name>` и `/websites/<name>` являются provider output, а не stable AIFHub schema. Final requirements, plans, review findings, completion status, roadmap status, generated rules и QA verdicts должны быть source-grounded in canonical OpenSpec artifacts, source files, tests, runtime state, QA evidence, generated rules trace metadata или другом direct repository evidence.

Allowed durable storage для reviewed Context7 notes:

- `.ai-factory/references/context7/` для project-wide documentation notes.
- `.ai-factory/state/<change-id>/context7/` для change-scoped runtime notes.

Forbidden storage для raw Context7 output, MCP transcripts, API responses, setup output или generated provider configuration:

- `openspec/changes/<change-id>/`
- `openspec/specs/`
- `.ai-factory/rules/generated/`
- `.ai-factory/qa/<change-id>/`

Перед копированием Context7 notes в `.ai-factory/` проверьте их на sensitive information. AIFHub guidance не должен persist `CONTEXT7_API_KEY`, API keys, tokens, raw authorization headers, credential helper output, private provider diagnostics, private backend diagnostics или unreviewed sensitive output в `.ai-factory/`, `openspec/`, docs, runtime state, QA evidence, generated rules или Context7 reference copies.

## Bug Fix Context

OpenSpec-native bug fixes have two context shapes:

- New bug reports are planning input.
- Fresh bug reports must start with `/aif-plan full "fix <bug description>"`.
- A planned bug fix reads base specs and writes a canonical OpenSpec change under `openspec/changes/<change-id>/`.
- Bug fixes that change product or workflow behavior need delta specs.
- Docs/tooling-only bug fixes may omit delta specs only when the proposal explains why no product or workflow behavior changes.
- Missing OpenSpec CLI means degraded validation, not planning failure.
- Post-verify fixes are execution input.
- `/aif-fix` reads an existing active OpenSpec change and QA evidence or selected findings from `.ai-factory/qa/<change-id>/`.
- `/aif-fix` writes fix traces under `.ai-factory/state/<change-id>/fixes/`.
- `/aif-fix` must not create a canonical OpenSpec change, write QA verdicts, or archive.
- `/aif-fix` must not create `.ai-factory/plans/<id>/`.
- `/aif-fix` routes back to `/aif-verify <change-id>`.

## GitHub-Aware Roadmap Context

`/aif-roadmap` may additionally read GitHub and git-tracker context when available:

- GitHub milestones, issues, PRs, labels, and linked branches
- current git tree, changed files, tags, and recent commits

This context is supporting evidence only. Closed GitHub issues, completed milestones, and merged PRs do not by themselves make roadmap items `done`; local evidence from OpenSpec artifacts, source files, tests, CI, runtime state, QA evidence, or generated rules remains required.

When GitHub milestones are available, `/aif-roadmap` treats milestones as roadmap phases. Closed milestones produce phase audit sections with linked issues/PRs and local evidence status. Open milestones with `open_issues = 0` produce `phase-completion drift` instead of being treated as closed. Milestone-bound issues/PRs attach to their phase, while unmilestoned issues/PRs remain in `unphased backlog/drift`.

Canonical local lifecycle linkage comes from the proposal's standardized `## Roadmap Linkage` fields: `Issues`, `Milestone`, `Roadmap item/slice`, and `Rationale`. MCP work-item plan identity is separate: a source-bound proposal's `## AIFHub Source Binding` stores exactly one `Provider`, `Primary source`, `External ID`, and exact creation `Branch`, while ordinary proposals omit that section; secondary roadmap references and equal external IDs never substitute for the full primary binding. The active-change resolver checks one exact source binding before slug branch variants, lets the current pointer disambiguate several exact candidates on one branch, and contains unrelated malformed bindings to warnings. Explicit `none` values are preserved and no command may infer missing linkage from remote metadata. `/aif-roadmap check` registers a linked active change as local `planned` and preserves or registers `finalized` only when durable done/archive evidence supports that state.

Local state is stored in the marker-bounded `OpenSpec Change Lifecycle` block inside the configured roadmap. `/aif-roadmap` owns the complete artifact and the block's `planned` reconciliation. `/aif-done` is a bounded co-owner of one `finalized` row only after successful OpenSpec archive; it must preserve every byte outside the markers. `/aif-commit` is read-only for both the roadmap and lifecycle block.

Local `planned`/`finalized` state and GitHub open/closed/merged state are independent evidence clocks. During post-merge reconciliation, `/aif-roadmap check` may refresh current issue, PR, and milestone observations without promoting, downgrading, or replacing local finalization evidence. Remote closure or merge is never proof that `/aif-done` completed.

GitHub access is non-blocking. If `gh`, connector data, network access, authentication, or rate limits prevent complete GitHub evidence loading, `/aif-roadmap` should continue from local evidence and summarize whether GitHub evidence was unavailable or partial.

`/aif-roadmap` may update only the configured roadmap artifact. It must not mutate GitHub issues, milestones, PRs, labels, linked branches, canonical OpenSpec artifacts, runtime state, QA evidence, generated rules, or implementation files. It must not write tokens, authorization headers, raw credential helper output, or private authentication diagnostics into roadmap output.

## Command Ownership

| Command | May write canonical OpenSpec artifacts | May write runtime or QA artifacts |
|---|---|---|
| `/aif-mode` | skeleton only; never manual `openspec/specs/**` mutations | mode reports, generated rules, optional migration/export outputs |
| `/aif-analyze` | Optional `openspec/` skeleton only when configured | capability/config setup; missing review-policy scaffold; optional glossary creation or patch-update only with explicit opt-in |
| `/aif-architecture` | no | no |
| `/aif-roadmap` | no | configured roadmap artifact, including managed local lifecycle reconciliation |
| `/aif-docs` | no | no |
| `/aif-qa` | no | upstream manual QA artifacts under `paths.qa/<branch-slug>/`; not AIFHub `.ai-factory/qa/<change-id>/` evidence |
| `/aif-qa-check` | no | branch-scoped `paths.qa/<branch-slug>/qa-check.md`; not AIFHub verify/done evidence |
| `/aif-plan full` | `openspec/changes/<change-id>/proposal.md`, `design.md`, `tasks.md`, `specs/**/spec.md` | optional `.ai-factory/state/<change-id>/` |
| `/aif-explore` | no | exactly one profile: resolved `paths.research` or a sibling marked ultra research bundle; never QA/change runtime notes |
| `/aif-improve` | `proposal.md`, `design.md`, `tasks.md`, `specs/**/spec.md` | optional `.ai-factory/state/<change-id>/` |
| `/aif-implement` | no, unless explicitly requested for selected scope | `.ai-factory/state/<change-id>/implementation/` |
| `/aif-fix` | no, unless explicitly requested for selected finding scope | `.ai-factory/state/<change-id>/fixes/` |
| `/aif-verify` | no | OpenSpec `.ai-factory/qa/<change-id>/`; for marked legacy ultra only one revision-bound receipt under `.ai-factory/state/legacy-ultra-verification/` after the final upstream gate |
| `/aif-rules-check` | no | no |
| `/aif-review` | no | no |
| `/aif-security-checklist` | no | no |
| `/aif-done` | `openspec/specs/**` only through OpenSpec CLI archive | OpenSpec final QA/state plus one marker-bounded roadmap transition; marked legacy ultra evaluation is read-only and returns exact verify/archive handoff |
| `/aif-archive` | no | legacy classic/marked-ultra archive plus `paths.archive/roadmap/*.md`; OpenSpec-native plan-mutating targets stop before discovery |
| `/aif-commit` | no | git commit only |
| `/aif-distillation` | no | no |
| `/aif-evolve` | no | skill-context or evolution artifacts only |

`/aif-architecture` writes only project-level architecture context: resolved `paths.architecture`, an architecture pointer in resolved `paths.description`, and an architecture row in root `AGENTS.md`.

`/aif-roadmap` writes only the configured roadmap artifact, `.ai-factory/ROADMAP.md` by default. It owns arbitrary roadmap content and reconciliation of the managed lifecycle block. `/aif-done` may change only one linked row inside that block after archive and cannot rewrite content outside the markers.

`/aif-docs` writes documentation output only: root `README.md`, the resolved `paths.docs` directory, optional `docs-html/` output when explicitly requested, and the Documentation section in `AGENTS.md`.

`/aif-qa` writes upstream manual QA artifacts under `paths.qa/<branch-slug>/`, such as `change-summary.md`, `test-plan.md`, and `test-cases.md`. `/aif-qa-check` consumes `test-cases.md` and writes branch-scoped `qa-check.md`. Both derive the same collision-resistant `<safe-prefix>-<hash8>` branch slug from the original branch name.

`qa-check.md` current results bind to `tested_revision`, `worktree_digest` or `manual_build_id`, `source_digest`, and per-case `case_digests`. Binding changes mark affected results unchecked `Stale` while retaining old comments/evidence as history. Agent execution uses the least-invasive appropriate surface, so backend, CLI, API, file/docs, and database-read cases do not depend on browser automation alone.

Reusable `agent-context.md` and `agent-history.md` contain only non-sensitive setup facts and cross-run lessons. Production, unknown-target, destructive, or external-side-effect execution requires explicit authorization for the current action. Persisted evidence must replace credentials, cookies, authorization values, tokens, one-time codes, private data, and sensitive URL parameters with `[REDACTED]`.

These branch-scoped artifacts are distinct from AIFHub verification and finalization evidence under `.ai-factory/qa/<change-id>/`, which remains owned by `/aif-verify` and `/aif-done`. `qa-check.md` alone cannot satisfy verify, coverage, rules, done-readiness, done, or archive evidence, and no implicit bridge exists.

## Quality Gates and Finalization Tail

OpenSpec-native quality gates:

| Command | Reads | Writes |
|---|---|---|
| `/aif-rules-check` | generated rules, project rules, changed files, optional OpenSpec context | none |
| `/aif-review` | changed files, OpenSpec context, generated rules, configured review policy | none |
| `/aif-security-checklist` | changed files, OpenSpec context, generated rules | none |
| `/aif-verify` | canonical OpenSpec artifacts, generated rules, runtime state, gate outputs when available | `.ai-factory/qa/<change-id>/` |
| `/aif-done` | passing verify evidence, verify gate result, OpenSpec change | final QA/state evidence, OpenSpec archive via CLI, then one managed `finalized` roadmap row when linked |
| `/aif-commit` | staged changes, done evidence, final summary, OpenSpec archive/spec changes | git commit |
| `/aif-distillation` | books, docs, folders, or URLs | generated skill packages in the current agent skills directory |
| `/aif-evolve` | patches, evidence, skill-context inputs | skill-context/evolution artifacts |

`/aif-done` owns OpenSpec lifecycle finalization. It updates a linked managed row only after successful archive; every pre-archive failure leaves the roadmap unchanged. If archive succeeds but the roadmap transition fails, archive remains successful, no rollback is attempted, and the exact handoff is `/aif-roadmap check`. The result does not claim GitHub open/closed/merged state. `/aif-commit` owns git commit creation. `/aif-evolve` owns learning/evolution. `/aif-architecture`, `/aif-docs`, and `/aif-qa` are upstream project-context utilities, not OpenSpec-native quality/finalization gates.

For marked legacy ultra, `/aif-verify <entrypoint>` delegates atomic verification upstream and only its command boundary may record the bounded receipt. `/aif-done` and namespaced done/rules evaluators recompute entrypoint, bundle digest, Git `HEAD` or manual build id, worktree digest, and final gate status. Only current exact `pass` returns `/aif-archive <entrypoint>`; every missing, stale, wrong, malformed, `warn`, `pass-with-notes`, or `fail` result returns `/aif-verify <entrypoint>`. Evaluators execute neither command and write nothing.

Adjacent upstream project-context utilities:

| Command | Reads | Writes |
|---|---|---|
| `/aif-architecture` | project description, source structure, optional OpenSpec context | project architecture context only |
| `/aif-docs` | project description, architecture, source/docs | README and docs directory |
| `/aif-qa` | git diff, description, architecture, source/docs | upstream manual QA artifacts under `paths.qa/<branch-slug>/` |
| `/aif-qa-check` | branch-scoped `test-cases.md`, target-specific execution context | branch-scoped `qa-check.md` plus redacted reusable agent context/history |

Upstream `/aif-archive` is not part of the OpenSpec-native quality/finalization tail. It owns legacy AI Factory-only classic cleanup and AI Factory 2.18 marked-ultra archive, plus optional roadmap snapshots under `paths.archive/roadmap/*.md`. In OpenSpec-native mode the AIFHub guard classifies arguments first: plan-mutating targets return `/aif-done <change-id>` before resolving `paths.plans`; `list` reads only archive inventories; `--roadmap` retains bounded upstream roadmap ownership. It must not write OpenSpec canonical, QA, state, or generated-rule artifacts, and it must not run `openspec archive <change-id> --yes`.

After `/aif-done`, `/aif-commit` may read finalization evidence, OpenSpec archive/spec mutations, the configured roadmap artifact, and optional GitHub issue/PR/milestone freshness context. It must not mutate OpenSpec lifecycle artifacts, `.ai-factory/ROADMAP.md`, runtime state, QA evidence, generated rules, or GitHub objects manually. Deterministic local lifecycle drift is an unskippable `ERROR [roadmap-local]` when durable evidence proves successful local finalization, the proposal has non-`none` `## Roadmap Linkage`, and the managed `OpenSpec Change Lifecycle` row is missing or not exactly `finalized`. The exact handoff is `/aif-roadmap check`; `/aif-commit` stops before its proposal and does not create a git commit, and user confirmation cannot bypass the error.

Unavailable, partial, or later-changing GitHub evidence is volatile external drift reported as `WARN [roadmap-external]` and remains warning-only by default. In that warning-only case, `/aif-commit` may continue and still writes only the git commit after user confirmation. External strict checking may promote external drift, but it cannot suppress the deterministic local gate.

Generic `## Commit Plan` grouping is parent-owned in AI Factory 2.13+. In OpenSpec-native mode, an active `openspec/changes/<change-id>/tasks.md` may provide that `## Commit Plan` source. AIFHub adds only roadmap/GitHub freshness findings before the commit proposal. If no active change/plan resolves, `/aif-commit` keeps upstream staged-diff behavior and preserves upstream grouping options such as `Follow Commit Plan`, `Commit everything together`, and `Adjust grouping`.

## Upstream Distillation Utility

AI Factory 2.13+ includes `/aif-distillation`. It is an upstream utility skill for turning books, docs, folders, or URLs into reusable Agent Skills.

`/aif-distillation` is not an AIFHub lifecycle stage. It does not create OpenSpec changes, and it must not write `openspec/changes/**`, `openspec/specs/**`, `.ai-factory/qa/**`, or `.ai-factory/rules/generated/**`.

It writes generated skill packages to the current agent skills directory. Useful AIFHub inputs include:

```text
/aif-distillation docs/memory-tools-research --name aifhub-memory-tool-selection
/aif-distillation docs/context-providers.md --name aifhub-context-providers
```

## Upstream Archive Utility

AI Factory 2.14+ includes `/aif-archive` and `paths.archive`. AIFHub treats this as an upstream legacy plan cleanup utility:

- source: completed legacy files under `paths.plans/*.md`
- destination: `paths.archive/plans/*.md`
- default archive root: `.ai-factory/archive/`
- optional roadmap snapshots: `paths.archive/roadmap/*.md`
- AI Factory 2.18 marked ultra bundle directories: atomic upstream archive in legacy mode

Archived legacy plans are excluded from active plan discovery and from `workflow.plan_id_format: sequential` numbering. OpenSpec-native canonical changes still use `openspec/changes/<change-id>/` and ignore sequential legacy plan filenames.

`paths.archive` is not an alias for OpenSpec CLI archive/finalization. OpenSpec archive is owned by `/aif-done` through `openspec archive <change-id> --yes`, with evidence under `.ai-factory/qa/<change-id>/` and `.ai-factory/state/<change-id>/`.

## Legacy Artifact Boundaries

These files are legacy AI Factory-only artifacts or migration input only:

- `.ai-factory/plans/<id>.md`
- `.ai-factory/plans/<id>/task.md`
- `.ai-factory/plans/<id>/context.md`
- `.ai-factory/plans/<id>/rules.md`
- `.ai-factory/plans/<id>/verify.md`
- `.ai-factory/plans/<id>/status.yaml`
- `.ai-factory/plans/<id>/explore.md`
- `.ai-factory/plans/<id>/fixes/*.md`
- `.ai-factory/plans/<id>/index.md` and direct `phase-NN-*.md` for a marked upstream ultra bundle
- `.ai-factory/state/legacy-ultra-verification/<entrypoint-digest>.json` as bounded AIFHub receipt state, never canonical or a migration source
- `paths.archive/plans/*.md`
- `paths.archive/roadmap/*.md`

OpenSpec-native commands must not require those files and must not create them as part of normal OpenSpec-native execution.

Classic and marked-ultra shapes are mutually exclusive for one plan id. A valid marked ultra bundle remains upstream-owned and is skipped by classic migration. Invalid marker/index/phase integrity and classic/ultra collisions fail closed before companion discovery or writes.

## Migration Context

Legacy migration is explicit. It reads `.ai-factory/plans` artifacts and writes:

- canonical migrated artifacts under `openspec/changes/<change-id>/`
- preserved runtime notes under `.ai-factory/state/<change-id>/`
- preserved legacy verification evidence under `.ai-factory/qa/<change-id>/`

Migration never silently deletes legacy source artifacts and never writes migrated artifacts under `openspec/specs/`.

Migration accepts only classic shapes. If an OpenSpec mode switch leaves unresolved work, the safe project-relative legacy `paths.plans` root is captured in `.ai-factory/state/legacy-plan-source.json`; later discovery uses that binding or explicit `--legacy-source <dir>`. Lexical or resolved overlap with canonical `openspec/changes` is rejected, so canonical changes are never rediscovered as legacy plans.

See [Legacy Plan Migration](legacy-plan-migration.md).

## Compatibility Export

OpenSpec-to-legacy compatibility export is optional and lossy. It may write:

- `.ai-factory/plans/<id>.md`
- `.ai-factory/plans/<id>/task.md`
- `.ai-factory/plans/<id>/context.md`
- `.ai-factory/plans/<id>/rules.md`

The export does not make OpenSpec artifacts obsolete and does not delete or archive them. Existing legacy files are not overwritten unless the caller explicitly approves overwrite behavior.

## Generated Rules

`.ai-factory/rules/generated/` contains compiler-owned outputs alongside potentially unknown user-owned children. Only `openspec-base.md`, `index.json`, and exact direct regular files named `openspec-change-<safe-id>.md`, `openspec-merged-<safe-id>.md`, or `openspec-rules-trace-<safe-id>.json` are compiler-managed. Do not treat the directory itself, unknown files, directories, symlinks/reparse points, or raw paths found in `index.json` as general deletion authority. Managed outputs are derived from:

```text
openspec/specs/**/spec.md
openspec/changes/<change-id>/specs/**/spec.md
```

Read-only gates do not regenerate generated rules automatically. `status` and `doctor` audit full active membership and remain non-green for orphan index entries/files, missing active membership/files, malformed index data, or managed-name collisions; the 50-change cap applies only to expensive trace/hash reads. Benign unknown children do not affect state.

`/aif-mode sync` owns regeneration and bounded post-archive reconciliation. It prepares the selected batch before mutation, fails closed on inventory/unsafe metadata errors, removes only exact absent-change managed files, preserves unknown/external/canonical/runtime/QA artifacts, and reports project-relative `remove`/`would-remove` operations with total/truncation metadata. Consumer commands should still treat generated rules as derived guidance rather than source of truth.

## Fallback Behavior

If `.ai-factory/config.yaml` is missing or incomplete:

- consumer commands stop when they cannot resolve required paths safely
- they should suggest `/aif-analyze` to initialize or repair config
- they must not fabricate canonical artifacts from chat context alone

## See Also

- [Usage](usage.md)
- [Context Providers](context-providers.md)
- [Skill Providers](skill-providers.md)
- [Safety Providers](safety-providers.md)
- [Memory Tool Recommendations](memory-tool-recommendations.md)
- [Session Context Dedup](context-dedup.md)
- [OpenSpec Compatibility](openspec-compatibility.md)
- [Legacy Plan Migration](legacy-plan-migration.md)
- [ADR 0001](adr/0001-openspec-native-artifact-protocol.md)
- [ADR 0002: Optional Project Glossary](adr/0002-optional-project-context-glossary.md)
- [Project Review Policy](review-policy.md)
- [ADR 0003: Durable Project Review Policy](adr/0003-durable-project-review-policy.md)
