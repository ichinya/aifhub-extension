## AIFHub OpenSpec-native Override

Apply this block before the upstream `aif-explore` body. When any rule below conflicts with the base skill text, this block wins.

Follow `skills/shared/LANGUAGE-POLICY.md` before producing user-facing responses or generated artifacts.

Resolve user-facing prose language in this order: use a usable non-empty `language.ui`; otherwise preserve the current conversation language for this response only; use English only when that language is indeterminate. This rule overrides downstream generic English defaults; do not infer from OS locale or persist the inferred choice. On that hard-English fallback, add exactly one concise setup hint only when the output contract permits human-readable prose, before any required final machine-readable block; never add it inside or after `aif-gate-result`, and never alter exact handoffs, fixed commands, paths, keys/enums, or machine-only output.

### Goal

Keep `/aif-explore` as a research-oriented command while making the extension aware of OpenSpec-native artifact ownership.

### Mode Detection

Before resolving exploration inputs, read `.ai-factory/config.yaml` when it exists.

- If the config contains `aifhub.artifactProtocol: openspec`, use **OpenSpec-native mode**.
- Otherwise, use **Legacy AI Factory-only mode**.
- If the config is missing, continue with Legacy AI Factory-only mode and state that no OpenSpec-native protocol was detected.

### Research profile and AI Factory version gate

Resolve `paths.research` and parse the command-position mode before creating a file or directory. Remove only an explicit leading `ultra` token; preserve every later occurrence of `ultra` in the topic byte-for-byte.

- Regular `/aif-explore <topic>` writes only the resolved `paths.research` file (default `.ai-factory/RESEARCH.md`). It does not create a research bundle or change-scoped runtime note.
- Explicit `/aif-explore ultra <topic>` must call the shared dependency-free `resolveAiFactoryUltraSupport()` contract from `scripts/ai-factory-version-resolver.mjs` before any write. Use injected test toolchain/version first, then project `.ai-factory.json.version`, then CLI evidence only with proven matching project provenance.
- When stable project metadata exists, unverified global/PATH-only CLI evidence is ignored with a bounded `ai-factory-cli-provenance-unverified` warning and does not override the project version.
- Missing, malformed, prerelease, unsupported `<2.18.0`, or provenance-matched CLI/project mismatch is a no-write stop. Recommend regular `/aif-explore <topic>`; do not redirect this failure to `/aif-plan full` and do not silently perform a regular research write.
- The extension baseline version never enables ultra by itself.

For explicit ultra on stable AI Factory `>=2.18.0`, derive exactly one bundle root without adding a config key:

```text
research_bundles_dir = <parent directory of resolved paths.research>/research/
bundle = <research_bundles_dir>/<english-topic-slug>/
```

- Create or update only one valid marked bundle for the run. Do not write the regular `paths.research` file in the same run.
- The minimum bundle is `INDEX.md` plus `RESEARCH.md`. `INDEX.md` must contain exactly one standalone `<!-- aif:research-mode:ultra -->`, identify `Status: active`, and link `RESEARCH.md` from `## Artifact Index` with a safe direct relative link.
- Reuse an exact matching marked slug. If the slug path is an unmarked directory, has a missing/duplicate/code-only marker, contains an unsafe Artifact Index link, or otherwise collides with a different artifact, fail closed without changing either regular research or the directory.
- Create `C4-CONTEXT.md`, `C4-CONTAINER.md`, `C4-COMPONENT-<scope>.md`, `ADR-NNNN-<slug>.md`, or `DEPENDENCY-GRAPH.md` only when its upstream evidence-based inclusion gate is satisfied. Do not create empty placeholders; link every generated optional artifact from `INDEX.md` exactly once.

Bounded diagnostics may contain only `mode`, resolved version and version `source`, safe project-relative bundle path, created artifact names, and a stable invalid-marker/collision `code`. Never include topic/research bodies, provider output, credentials, raw stdout, raw stderr, or private absolute paths.

### Dependency-aware research brief interview

After resolving the artifact mode, research profile, and any ultra version gate, but before the full research run or any write, map the request as a dependency-aware **design tree**.

- Treat explicit decisions already present in the request or conversation as settled roots. Each unresolved user-owned decision is a node whose children are the decisions that depend on it.
- The **frontier** is every unresolved decision whose prerequisites are settled. Ask the whole current frontier in one round, number each question, and include one concise recommended answer with its main rationale or tradeoff. Never ask a downstream question while one of its prerequisites remains open.
- If the runtime imposes a smaller question-count limit, ask the maximum supported independent subset. Keep the remaining nodes on the same frontier; do not treat the partial batch as a completed round.
- After each answer batch, update the design tree, preserve settled answers unless the user reopens them, recompute the frontier, and ask the next round. Do not drip questions one at a time when independent frontier questions can be asked together.
- Repository, configuration, and tool-availability facts are the assistant's responsibility. Resolve obtainable facts with bounded read-only inspection instead of asking the user. While fact-finding is pending, keep only the dependent questions off the frontier and continue with independent questions.
- The user owns product, scope, risk, and tradeoff decisions. If a decision cannot be made without a prototype, measurement, or unavailable evidence, record that dependency as an open blocker and recommend the smallest evidence-producing next action; do not invent an answer.
- Keep the tree scoped to a research brief: the target question, boundaries and non-goals, constraints, evidence standard, and desired deliverable. Do not turn `/aif-explore` into an implementation plan or canonical OpenSpec design session.

The interview ends only when the frontier is empty. Present one normalized research brief and wait for explicit user confirmation before starting the full research run. A request that is already precise may have an empty initial frontier, but the normalized brief still requires confirmation.

Before confirmation, bounded read-only fact-finding is the only permitted work: do not persist research, present a saved result, append the session, mutate a plan, or create canonical OpenSpec artifacts. Do not create a separate interview, design-tree, decision-log, or research-brief file; the confirmed brief remains conversation context for the existing regular or ultra research output. Use the question mechanism and autonomous/subagent fallback defined in `skills/shared/QUESTION-TOOL.md` and the Codex Runtime section below.

### Upstream Research Coherence Gate pass-through

The AIFHub prepend owns only mode, version, path, and write boundaries. Its pass-through runs after every permitted persisted regular or ultra research write or update: continue into the upstream AI Factory 2.18.1 `#### Research Coherence Gate (all persisted modes)` before presenting the saved result or appending the current session. A successful AIFHub write is not a coherence verdict and is not completion of upstream `/aif-explore`.

- Fresh-context `Task` delegation is optional. When that capability is unavailable or fails, use the mandatory direct read-only fallback with the same upstream criteria.
- AIFHub must never skip, delay, replace, or copy the upstream gate implementation. Do not create a second coherence validator or treat this prepend as the gate owner.
- Preserve this exact ordering for regular: persisted write -> upstream Research Coherence Gate -> presentation/session append.
- Preserve this exact ordering for ultra: persisted bundle write -> upstream Research Coherence Gate -> upstream Bundle Integrity Gate -> presentation/session append.
- A non-`PASS` gate outcome stops presentation and session append and remains inside the upstream correction/re-run flow.

Pass-through diagnostics may contain only `asset`, `runtime`, `case`, bounded gate outcome, and whether direct fallback was used. Never log research bodies, quoted mismatch passages, provider output, credentials, raw stdout/stderr, or private absolute paths.

### OpenSpec-native mode

When `.ai-factory/config.yaml` declares `aifhub.artifactProtocol: openspec`, `/aif-explore` is research-oriented and must not create canonical OpenSpec change artifacts.

Use shared vocabulary consistently: `OpenSpec-native mode`, `canonical OpenSpec change`, `active change`, `change-id`, `base specs`, `delta specs`, `generated rules`, `runtime state`, `QA evidence`, and `legacy AI Factory-only mode`.

Allowed read context:

- `.ai-factory/config.yaml`
- `.ai-factory/DESCRIPTION.md`
- `.ai-factory/ARCHITECTURE.md`
- `.ai-factory/RESEARCH.md`
- `openspec/specs/**`
- `openspec/changes/<change-id>/**`
- `.ai-factory/state/<change-id>/`
- optional reviewed Graphify outputs such as `graphify-out/GRAPH_REPORT.md`, `graphify-out/graph.json`, `.ai-factory/references/graphify/GRAPH_REPORT.md`, and `.ai-factory/state/<change-id>/graphify/GRAPH_REPORT.md`
- optional reviewed Context7 notes under `.ai-factory/references/context7/` and `.ai-factory/state/<change-id>/context7/`

Enabled optional tool use:

- Before using any optional provider, call the installed wrapper when available: `ai-factory aifhub-memory-tools select --from-project --command aif-explore --json`.
- The wrapper reads `utilities.context_tools.enabled`, compatibility utility flags, local `recommendation-metadata.yaml`, command-specific `tool_permissions`, and project/task signals.
- Use only entries returned in `selected_tools`. For each selected entry, follow its `tool_id`, `permission`, `execution`, `forbidden_operations`, `protected_artifacts`, read scope, purge path, and privacy caveat.
- Do not use tools that are absent from `selected_tools`, including tools listed in `not_selected_tools`, tools missing from config, tools forbidden for `/aif-explore`, or tools whose execution guidance is unavailable.
- If no optional provider is selected, continue with the rg baseline and source/OpenSpec evidence.
- Optional provider output is supporting context only; conclusions must remain grounded in source files, canonical OpenSpec artifacts, generated rules, runtime state, QA evidence, or other direct repository evidence.

Optional Graphify context:

- This provider-specific boundary applies only when `selected_tools` includes Graphify, or when reading already reviewed Graphify output that exists in an allowed context path.
- Graphify is optional supporting context for large repository architecture/relation discovery.
- `/aif-explore` may recommend that the user run Graphify manually outside AIFHub command ownership only when the selection output allows Graphify, but it must not install `graphifyy`, run `graphify`, add Graphify dependencies, or start/register Graphify MCP automatically.
- Missing Graphify or missing `graphify-out/GRAPH_REPORT.md` is degraded context, not an exploration failure.
- When existing Graphify output is available, treat extracted, inferred, ambiguous, or confidence-labeled relationships as hypotheses for direct repository inspection.
- Research conclusions must remain grounded in source files, canonical OpenSpec artifacts, generated rules, runtime state, QA evidence, or other direct repository evidence.
- Project-wide reviewed Graphify copies belong under `.ai-factory/references/graphify/`; change-scoped reviewed copies belong under `.ai-factory/state/<change-id>/graphify/`.
- Do not store Graphify generated files such as `GRAPH_REPORT.md`, `graph.json`, or `graph.html` under `openspec/changes/<change-id>/`, `openspec/specs/`, `.ai-factory/rules/generated/`, or `.ai-factory/qa/<change-id>/`.
- Do not persist API keys, tokens, raw authorization headers, credential helper output, private backend diagnostics, or unreviewed sensitive output in `.ai-factory/`, `openspec/`, docs, runtime state, QA evidence, generated rules, or Graphify reference copies.

Optional Context7 context:

- This provider-specific boundary applies only when `selected_tools` includes Context7, or when reading already reviewed Context7 notes that exist in an allowed context path.
- Context7 is optional supporting documentation context for current library/API docs.
- `/aif-explore` may recommend that the user run Context7 manually outside AIFHub command ownership only when the selection output allows Context7, with commands such as `npx ctx7 library <name> <query>` and `npx ctx7 docs <libraryId> <query>`, or user-installed equivalents `ctx7 library <name> <query>` and `ctx7 docs <libraryId> <query>`.
- Missing Context7, missing Node.js runtime support, missing provider access, or missing reviewed notes is degraded context, not an exploration failure.
- If the user already configured Context7 MCP, available tools may include `resolve-library-id` plus a docs retrieval tool named `get-library-docs` or `query-docs`; use them only as optional read-only documentation context.
- Do not install `ctx7` or `@upstash/context7-mcp`, run `ctx7`, run `ctx7 setup`, add Context7 dependencies or manifest entries, add Context7 MCP templates to `extension.json`, mutate `.mcp.json`, `.cursor/mcp.json`, `.opencode.json`, agent rules, or agent skills, or start/register Context7 MCP automatically.
- Treat Context7 output as supporting context only; research conclusions must remain source-grounded in source files, canonical OpenSpec artifacts, generated rules, runtime state, QA evidence, or other direct repository evidence.
- Reviewed project-wide Context7 notes belong under `.ai-factory/references/context7/`; reviewed change-scoped Context7 notes belong under `.ai-factory/state/<change-id>/context7/`.
- Do not store raw Context7 output, MCP transcripts, API responses, setup output, or generated provider configuration under `openspec/changes/<change-id>/`, `openspec/specs/`, `.ai-factory/rules/generated/`, or `.ai-factory/qa/<change-id>/`.
- Do not persist `CONTEXT7_API_KEY`, API keys, tokens, raw authorization headers, credential helper output, private provider diagnostics, private backend diagnostics, or unreviewed sensitive output in `.ai-factory/`, `openspec/`, docs, runtime state, QA evidence, generated rules, or Context7 reference copies.

Canonical OpenSpec change files under an active change are only:

- `openspec/changes/<change-id>/proposal.md`
- `openspec/changes/<change-id>/design.md`
- `openspec/changes/<change-id>/tasks.md`
- `openspec/changes/<change-id>/specs/**/spec.md`

Write boundaries:

- In regular mode, write research output only to the resolved `paths.research` file.
- In explicit stable-2.18 ultra mode, write only the one selected sibling research bundle derived from the parent of `paths.research`; do not also write `paths.research`.
- Do not write exploration output under `.ai-factory/state/<change-id>/` or `.ai-factory/qa/<change-id>/`.
- Do not create non-OpenSpec files under `openspec/changes/<change-id>/`.
- Do not write debug files, summaries, research notes, validation evidence, or runtime-only files under an OpenSpec change folder.

Response and next-step guidance:

- Report where research was written in the normal response.
- Distinguish research output from canonical OpenSpec artifacts.
- For ultra, report the safe bundle path and created artifact names without copying research content.
- If generated rules or QA evidence were inspected, name those paths in the normal response.
- Suggest `/aif-plan full "<request>"` for new work that needs canonical change artifacts.
- Suggest `/aif-improve <change-id>` for refining an existing OpenSpec-native change.
- Suggest `/aif-implement <change-id>` only after an OpenSpec-native plan is ready for execution.
- Do not suggest deprecated `*-plus` aliases.
- Do not install OpenSpec skills or slash commands.

### Legacy AI Factory-only mode

When OpenSpec-native mode is not enabled, preserve the extension's companion plan behavior:

- Treat `.ai-factory/plans/<plan-id>.md` and `.ai-factory/plans/<plan-id>/` as one active plan pair.
- If `@path` points to the plan file, the plan folder, or one of its local artifacts (`task.md`, `context.md`, `rules.md`, `verify.md`, `status.yaml`, `explore.md`), resolve the whole pair before continuing.
- Apply the shared regular/ultra research routing above before any plan-pair normalization. Regular mode writes only resolved `paths.research`; explicit stable-2.18 ultra writes only the one marked sibling bundle and never writes plan companions.
- Do not treat `DESCRIPTION.md`, `ARCHITECTURE.md`, `ROADMAP.md`, or `RULES.md` as writable from explore mode in this extension workflow.
- For next steps, prefer:
  - `/aif-plan full "<task>"` for new work
  - `/aif-improve <plan-id>` for plan refinement
  - `/aif-implement <plan-id>` for execution
- If a legacy folder-only plan is detected, present the canonical next step using the normalized plan id and companion plan-file model.

### Codex Runtime

When running in Codex app/CLI:

- The planning stage (`/aif-explore`, `/aif-plan full`, `/aif-improve`) should run in Codex Plan mode when structured clarifying questions are needed.
- This skill may recommend Plan mode, but it does not attempt or promise to switch the Codex session mode. The user controls the mode.
- In Codex Plan mode, use `request_user_input` only for 1-3 short questions.
- In Codex Default mode, if a question is needed, ask it as plain text in the assistant message. Do not use `question(...)`, `questionnaire(...)`, or `request_user_input`.
- If another CLI or IDE runtime exposes a planning mode, use that available planning-mode mechanism for structured planning questions; do not fabricate unavailable tools or client actions.
- In autonomous or subagent mode, do not ask interactive questions. Record assumptions and return blockers/open questions to the parent.
- See `skills/shared/QUESTION-TOOL.md` for the full runtime question format mapping.
