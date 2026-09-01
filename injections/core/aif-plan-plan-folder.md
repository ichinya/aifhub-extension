## AIFHub OpenSpec-Native Planning Override

Apply this block before the upstream `aif-plan` body. When any rule below conflicts with the base skill text, this block wins.

Follow `skills/shared/LANGUAGE-POLICY.md` before producing user-facing responses or generated artifacts.

Resolve user-facing prose language in this order: use a usable non-empty `language.ui`; otherwise preserve the current conversation language for this response only; use English only when that language is indeterminate. This rule overrides downstream generic English defaults; do not infer from OS locale or persist the inferred choice. On that hard-English fallback, add exactly one concise setup hint only when the output contract permits human-readable prose, before any required final machine-readable block; never add it inside or after `aif-gate-result`, and never alter exact handoffs, fixed commands, paths, keys/enums, or machine-only output.

### Goal

Use the built-in `/aif-plan` skill as the canonical planning entrypoint for this extension workflow.

### Canonical Workflow

- Do not redirect users to deprecated planning aliases.
- The canonical public flow is `/aif-analyze -> /aif-explore -> /aif-plan -> /aif-improve -> /aif-implement -> /aif-verify`.
- Legacy planning references should be interpreted as `/aif-plan full`.

### Planning profile and AI Factory version gate

Resolve the artifact profile and parse the leading planning mode before creating a plan directory or writing any planning artifact.

- Recognize only a command-position mode token: `fast`, `full`, or `ultra`. Remove that one leading token from the request body; preserve every later occurrence of those words byte-for-byte, including casing, punctuation, internal whitespace, and line breaks.
- Absence of an explicit `ultra` token keeps the existing default, `fast`, or `full` behavior. Do not enable ultra from extension baseline metadata.
- For explicit `ultra`, use the dependency-free shared resolver in `scripts/ai-factory-version-resolver.mjs` before any write. Resolution precedence is: injected test toolchain/version, then project-managed `.ai-factory.json.version`, then bounded CLI evidence only when the executable provenance is proven to match the same project installation.
- A global or PATH-only `ai-factory --version` is not authoritative. When stable project metadata exists, unverified global/PATH-only CLI evidence is ignored with a bounded `ai-factory-cli-provenance-unverified` warning and does not override the project version.
- Missing, malformed, prerelease, unsupported `<2.18.0`, or provenance-matched CLI/project mismatch results fail closed and create no plan, change, bundle, companion, runtime-state, or research artifact.
- On that failure emit only a bounded diagnostic with `mode`, `profile`, `version`, `source`, and stable `code`, followed by the actionable handoff `/aif-plan full <request>`. Never include the request body, research body, provider output, credentials, raw stdout, or raw stderr in the diagnostic.

For stable AI Factory `>=2.18.0`, route explicit `ultra` by the resolved artifact profile:

- In OpenSpec-native mode, `ultra` is a depth profile over the canonical OpenSpec change. Apply the upstream Ultra Detail Gate to exact files and symbols, ordered edits, contracts and data flow, failure handling, bounded logging, tests, acceptance criteria, rollback, and verification detail in `design.md` and `tasks.md`.
- OpenSpec-native `ultra` still writes only `proposal.md`, `design.md`, `tasks.md`, and applicable delta specs. It MUST NOT create `index.md`, `phase-NN-*.md`, companion files, or an active standalone `<!-- aif:plan-mode:ultra -->` anywhere under the canonical change.
- In legacy AI Factory-only mode, explicit `ultra` remains upstream-owned. Hand control to the upstream `aif-plan` ultra workflow before AIFHub classic companion normalization; do not create or synchronize a sibling classic plan or companion files.

### OpenSpec-native mode

When `.ai-factory/config.yaml` has `aifhub.artifactProtocol: openspec`, OpenSpec-native instructions override legacy plan-folder instructions.

Use shared vocabulary consistently: `OpenSpec-native mode`, `canonical OpenSpec change`, `active change`, `change-id`, `base specs`, `delta specs`, `generated rules`, `runtime state`, `QA evidence`, and `legacy AI Factory-only mode`.

Use canonical OpenSpec artifacts under `openspec/changes/<change-id>/`:

- `openspec/changes/<change-id>/proposal.md`
- `openspec/changes/<change-id>/design.md`
- `openspec/changes/<change-id>/tasks.md`
- `openspec/changes/<change-id>/specs/<capability>/spec.md` when the change affects product or workflow behavior

Do not create legacy `.ai-factory/plans` plan files or companion folders in this mode. Do not write runtime-only files into `openspec/changes/<change-id>/`.

If the task is docs/tooling-only and does not change product or workflow behavior, a delta spec may be omitted only when the plan explicitly explains why no delta spec is needed. When the selected OpenSpec CLI is `>=1.7.0`, also declare native OpenSpec `skip_specs: true` in `openspec/changes/<change-id>/.openspec.yaml`; preserve the selected `schema` and other existing metadata. For an older supported CLI, preserve the explicit proposal reason and compatibility finalizer path instead of writing metadata that the selected CLI does not understand.

When a behavior change removes the final requirement of a capability and the selected OpenSpec CLI is `>=1.8.0`, add native `retire_capabilities: true` to `openspec/changes/<change-id>/.openspec.yaml`, preserving the selected `schema` and other existing metadata. Do this only when the user's request explicitly authorizes capability retirement. Planning must not infer retirement merely because a `REMOVED` delta would leave the base capability empty. For an older supported CLI, record the required OpenSpec upgrade as a blocking archive prerequisite instead of writing unsupported retirement metadata.

#### Task Intake Normalization

Before normalizing task content, preserve the explicit planning request as canonical raw source when one was supplied:

- Remove only recognized invocation tokens that occur in command positions: the leading `/aif-plan` or runtime-equivalent skill token, one leading `fast`, `full`, or `ultra` mode token, and recognized control flags parsed before the request body.
- Do not remove words such as `full`, `fast`, `ultra`, `--list`, or `--parallel` when they occur inside the actual request text.
- Trim only parser-introduced outer whitespace. Preserve the remaining request wording, casing, punctuation, internal whitespace, and line breaks exactly; do not translate, summarize, normalize, or regenerate it.
- Write the fixed `## Original Request` heading and preserved body to `proposal.md` before the source-template `## Why` heading.
- If planning starts only from the resolved research artifact and no explicit request exists, omit `## Original Request`.
- If both an explicit request and relevant research influence the plan, keep both `## Original Request` and `## Research Context`; they have different source and mutability contracts.

After preserving the raw request, normalize the task into these fields:

- task type
- goal
- non-goals
- constraints
- assumptions
- impacted capabilities
- C4 impact
- ADR candidates
- dependency graph
- acceptance criteria
- open questions
- suggested next command

Write the normalized task content into canonical OpenSpec artifacts:

- `proposal.md` for the exact OpenSpec source-template headings `## Why`, `## What Changes`, `## Capabilities`, and `## Impact`, plus the AIFHub raw-source and roadmap sections when applicable
- `design.md` for technical approach, C4 impact, ADR candidates, dependency graph, integration points, alternatives, and risks
- `tasks.md` for an executable implementation checklist
- `specs/**/spec.md` for behavior-changing requirements and scenarios

Do not create a separate task-preparation command or artifact in OpenSpec-native mode. `/aif-task-prepare`, `.ai-factory/specs/<task-id>.md`, `task-prepare.md`, and legacy companion files under `openspec/changes/<change-id>/` must not be created.

Raw input trace, normalization confidence, and temporary notes are runtime state only. They may be persisted only under `.ai-factory/state/<change-id>/` when needed and must never be written under `openspec/changes/<change-id>/`.

#### Revision-bound Research Context

When research Active Summary materially affects scope, tasks, constraints, or tradeoffs, resolve its exact source before writing `proposal.md`:

- Use the shared `resolveUltraResearchSource()` result from `scripts/ultra-research-resolver.mjs` for ultra research candidates. Consume its structured `source`, `revision`, `content`, and `diagnostic`; do not reimplement marker, path, status, Artifact Index, Active Summary, or digest checks in the prompt.
- Selection precedence is a safe explicit project-relative `RESEARCH.md` path, then an exact bundle slug, then exactly one caller-reviewed materially relevant active candidate. More than one relevant candidate stops with `ultra-research-ambiguous`; recency, fuzzy matching, and a newer `Updated` value never break the tie.
- Missing, unmarked, inactive, unsafe, symlinked, or invalid explicit sources stop Research Context creation with the resolver's bounded code. Invalid implicit candidates are ignored with bounded warnings and are never silently imported.
- For regular research, use the resolved `paths.research` Active Summary under the same normalization contract. For ultra research, use only `content.activeSummary` from the selected exact `source.path`; sibling C4, ADR, and dependency artifacts are rationale and cannot expand scope unless their conclusion is reflected in that Active Summary.

Commit only the selected relevant summary to `proposal.md` under `## Research Context`:

```text
Source: <exact selected RESEARCH.md source> (Active Summary, Updated: <timestamp>, SHA256: <digest>)
<copied Active Summary>
```

- Treat the embedded section as the committed requirements snapshot; do not copy the full `## Sessions` history into the proposal.
- Compute `SHA256` from the copied Active Summary after excluding markdown comments and the `Source` line, normalizing line endings to LF, removing trailing spaces from each line, preserving line order, and ending the digest input with exactly one newline.
- Once written, the snapshot and source revision remain immutable unless the user explicitly requests a research rebase through refinement.
- If the live research revision changes while planning is in progress, emit `WARN [research-drift] change-id=<change-id> source=<path> expected=<embedded revision> current=<live revision>` and keep the embedded snapshot authoritative. Do not log or duplicate the full research body, provider output, credentials, or other sensitive content in the warning.
- Live `## Sessions` may be consulted for rationale, but newer requirements must not silently expand committed scope.

#### Roadmap Linkage

Always include `## Roadmap Linkage` in every canonical OpenSpec proposal so downstream lifecycle commands can consume one stable shape. Use exactly these fields and keep them in this order:

```markdown
## Roadmap Linkage

- Issues: <comma-separated canonical URL(s)|none>
- Milestone: <exact title|none>
- Roadmap item/slice: <exact item or slice|none>
- Rationale: <one bounded explanation|none>
```

- Capture only linkage explicitly supplied by the user or already committed in the selected planning source. Normalize an explicit GitHub issue reference to `https://github.com/<owner>/<repo>/issues/<number>` when the repository identity is directly available.
- For every missing value, write `none`. When the user explicitly supplies `none`, preserve an explicit `none` value verbatim. Do not omit a field whose value is `none`.
- Planning MUST NOT infer an issue or milestone from an issue title, branch name, repository labels, unrelated roadmap text, or another uncommitted contextual hint.
- If at least one of `Issues`, `Milestone`, or `Roadmap item/slice` is non-`none` and the configured roadmap should register the new change as `planned`, return the exact owner handoff `/aif-roadmap check`. Planning must not edit the roadmap itself.
- When all four fields are `none`, preserve the standardized section but do not return `/aif-roadmap check` solely for an all-`none` linkage.
- In the normal planning response, report only the captured linkage fields and the exact owner handoff when applicable. Do not print or summarize unrelated roadmap content.

#### Enabled optional tool use

- Before using any optional provider, call the installed wrapper when available: `ai-factory aifhub-memory-tools select --from-project --command aif-plan --json`.
- Use only entries returned in `selected_tools`. For each selected entry, follow its `tool_id`, `permission`, `execution`, `forbidden_operations`, `protected_artifacts`, read scope, purge path, and privacy caveat.
- Do not use tools that are absent from `selected_tools`, including tools listed in `not_selected_tools`, tools missing from config, tools forbidden for `/aif-plan`, or tools whose execution guidance is unavailable.
- If no optional provider is selected, continue with the rg baseline and direct repository/OpenSpec evidence.

#### Optional Graphify context

Graphify is optional supporting context for integration discovery before creating or refining a canonical OpenSpec change.

- This provider-specific boundary applies only when `selected_tools` includes Graphify, or when reading already reviewed Graphify output that exists in an allowed context path.
- `/aif-plan full` may read existing reviewed Graphify outputs such as `graphify-out/GRAPH_REPORT.md`, `graphify-out/graph.json`, `.ai-factory/references/graphify/GRAPH_REPORT.md`, and `.ai-factory/state/<change-id>/graphify/GRAPH_REPORT.md`.
- Missing Graphify or missing reports are degraded context, not planning failure.
- Do not install `graphifyy`, run `graphify`, add Graphify dependencies or manifest entries, or start/register Graphify MCP automatically.
- Treat extracted, inferred, ambiguous, or confidence-labeled Graphify relationships as hypotheses for direct repository inspection.
- Use Graphify output to identify possible integration points or impact areas only; final `proposal.md`, `design.md`, `tasks.md`, and delta specs must cite direct repository evidence and canonical OpenSpec/source context.
- Reviewed project-wide Graphify copies belong under `.ai-factory/references/graphify/`; reviewed change-scoped copies belong under `.ai-factory/state/<change-id>/graphify/`.
- Do not import raw Graphify output or generated files such as `GRAPH_REPORT.md`, `graph.json`, or `graph.html` into `openspec/changes/<change-id>/`, `openspec/specs/`, `.ai-factory/rules/generated/`, or `.ai-factory/qa/<change-id>/`.
- Do not persist API keys, tokens, raw authorization headers, credential helper output, private backend diagnostics, or unreviewed sensitive output in `.ai-factory/`, `openspec/`, docs, runtime state, QA evidence, generated rules, or Graphify reference copies.

#### Optional Context7 documentation context

Context7 is optional supporting documentation context for current library/API docs before creating or refining a canonical OpenSpec change.

- This provider-specific boundary applies only when `selected_tools` includes Context7, or when reading already reviewed Context7 notes that exist in an allowed context path.
- `/aif-plan full` may recommend that the user run Context7 manually outside AIFHub command ownership only when the selection output allows Context7, with commands such as `npx ctx7 library <name> <query>` and `npx ctx7 docs <libraryId> <query>`, or user-installed equivalents `ctx7 library <name> <query>` and `ctx7 docs <libraryId> <query>`.
- `/aif-plan full` may read reviewed Context7 notes under `.ai-factory/references/context7/` and `.ai-factory/state/<change-id>/context7/`.
- Missing Context7, missing Node.js runtime support, missing provider access, or missing reviewed notes is degraded context, not planning failure.
- If the user already configured Context7 MCP, available tools may include `resolve-library-id` plus a docs retrieval tool named `get-library-docs` or `query-docs`; use them only as optional read-only documentation context.
- Do not install `ctx7` or `@upstash/context7-mcp`, run `ctx7`, run `ctx7 setup`, add Context7 dependencies or manifest entries, add Context7 MCP templates to `extension.json`, mutate `.mcp.json`, `.cursor/mcp.json`, `.opencode.json`, agent rules, or agent skills, or start/register Context7 MCP automatically.
- Treat Context7 output as supporting context only; final `proposal.md`, `design.md`, `tasks.md`, and delta specs must remain source-grounded in direct repository evidence and canonical OpenSpec/source context.
- Reviewed project-wide Context7 notes belong under `.ai-factory/references/context7/`; reviewed change-scoped Context7 notes belong under `.ai-factory/state/<change-id>/context7/`.
- Do not import raw Context7 output, MCP transcripts, API responses, setup output, or generated provider configuration into `openspec/changes/<change-id>/`, `openspec/specs/`, `.ai-factory/rules/generated/`, or `.ai-factory/qa/<change-id>/`.
- Do not persist `CONTEXT7_API_KEY`, API keys, tokens, raw authorization headers, credential helper output, private provider diagnostics, private backend diagnostics, or unreviewed sensitive output in `.ai-factory/`, `openspec/`, docs, runtime state, QA evidence, generated rules, or Context7 reference copies.

#### Change ID policy

- Derive a safe `<change-id>` slug from the request for new plans.
- Prefer lowercase kebab-case.
- Allow only safe relative IDs.
- Reject IDs containing `/`, `\`, `..`, absolute paths, path traversal, or unsafe characters.
- Use or reference `normalizeChangeId()` from `scripts/active-change-resolver.mjs` when useful.
- If `openspec/changes/<change-id>` already exists, do not overwrite silently. Ask for a new ID, or create a deterministic suffix only in autonomous mode when asking is unavailable.

#### Required artifact shape

`proposal.md` should use:

```markdown
## Original Request

<verbatim explicit request; omit for research-only planning>

## Roadmap Linkage

- Issues: <comma-separated canonical URL(s)|none>
- Milestone: <exact title|none>
- Roadmap item/slice: <exact item or slice|none>
- Rationale: <one bounded explanation|none>

## Why

Why this change is needed now.

## What Changes

- In-scope behavior or workflow changes
- Explicit non-goals and compatibility boundaries

## Capabilities

### New Capabilities

- `<capability-path>`: <new behavior contract; omit when none>

### Modified Capabilities

- `<existing-capability-path>`: <changed requirement; omit when none>

## Impact

Affected code, APIs, dependencies, systems, assumptions, risks, and open questions.

## Research Context

Source: <exact selected RESEARCH.md source> (Active Summary, Updated: <timestamp>, SHA256: <digest>)

<committed relevant Active Summary; omit when research did not shape the plan>
```

The source-template proposal headings are exact and case-sensitive: `## Why`, `## What Changes`, `## Capabilities`, `### New Capabilities`, `### Modified Capabilities`, and `## Impact`. Do not translate, rename, or replace them with older `Intent`, `Scope`, or `Approach` headings. AIFHub-owned `## Original Request`, `## Roadmap Linkage`, and conditional `## Research Context` are additions; they do not replace the source headings.

`design.md` should use:

```markdown
# Design: <Title>

## Technical Approach

## Data / Artifact Model

## Integration Points

## Alternatives Considered

## Risks
```

`tasks.md` must be a checkbox checklist:

- Every task checkbox MUST state how completion will be verified: a test, command, observable behavior, or delivered artifact.
- Keep that verification in the task description. Use a separate verification task only for broader integration or system behavior that spans multiple implementation tasks.

```markdown
# Tasks

## 1. Planning and artifacts

- [ ] 1.1 Create/update the OpenSpec proposal, design, tasks, and delta specs; verify the configured strict validation command accepts the complete artifact set

## 2. Implementation

- [ ] 2.1 Implement the scoped behavior; verify the focused regression passes
```

Delta specs must use OpenSpec requirement sections:

```markdown
# Delta for <Capability>

## ADDED Requirements

### Requirement: <Requirement name>

The system MUST/SHALL ...

#### Scenario: <Scenario name>

- GIVEN ...
- WHEN ...
- THEN ...

## MODIFIED Requirements

### Requirement: <Existing requirement name>

...

## REMOVED Requirements

### Requirement: <Removed requirement name>
```

Every requirement should include at least one scenario when applicable.

#### Runtime state

Planning may create or update runtime state only under `.ai-factory/state/<change-id>/`.

Use or reference `ensureRuntimeLayout(changeId)` from `scripts/active-change-resolver.mjs` when runtime directories are needed.

Allowed runtime examples:

- `.ai-factory/state/<change-id>/plan-summary.md`
- `.ai-factory/state/<change-id>/validation.json`

Runtime QA output belongs under `.ai-factory/qa/<change-id>/`.

#### OpenSpec validation

Before validation, resolve the effective OpenSpec policy through:

```bash
ai-factory aifhub-mode status --json
```

Read `effectivePolicy` from the JSON output. When a compatible OpenSpec CLI is available, validate through `scripts/openspec-runner.mjs` using `validateOpenSpecChange(changeId)` or equivalent runner behavior.

The runner command corresponds to:

```bash
openspec validate <change-id> --type change --strict --json --no-interactive --no-color
```

- If validation passes, report success.
- If validation fails, repair generated artifacts when possible or clearly report the failing file, requirement, or section.
- Missing or unsupported OpenSpec CLI is degraded validation, not planning failure, unless the effective policy has `requireCliForPlan: true`; when required, treat the missing CLI as a planning blocker and do not claim OpenSpec validation passed.
- Do not install OpenSpec skills or slash commands.

Report generated OpenSpec artifact paths, effective policy summary, and validation status in the normal planning response. Persist validation evidence only under `.ai-factory/state/<change-id>/` when a runtime file is needed.

### Legacy AI Factory-only mode

When OpenSpec-native mode is not enabled, preserve the existing legacy companion plan-folder contract.

This mode is legacy AI Factory-only mode. The companion rules below apply only to classic `/aif-plan full` (and existing non-ultra default behavior). When `/aif-plan full` creates `.ai-factory/plans/<plan-id>.md`, it must also create and keep synchronized the companion folder:

- `.ai-factory/plans/<plan-id>/task.md`
- `.ai-factory/plans/<plan-id>/context.md`
- `.ai-factory/plans/<plan-id>/rules.md`
- `.ai-factory/plans/<plan-id>/verify.md`
- `.ai-factory/plans/<plan-id>/status.yaml`
- `.ai-factory/plans/<plan-id>/explore.md` when active research exists

Treat the plan file as the parent-compatible summary artifact and the folder as the structured execution/state artifact set.
The companion plan file may remain plain upstream markdown; the shared YAML frontmatter contract applies to the plan-folder markdown artifacts, not to the parent-compatible plan file.

For explicit `/aif-plan ultra`, first require the shared stable AI Factory `>=2.18.0` version gate, then leave creation and orchestration to the upstream skill. A valid upstream bundle is `<paths.plans>/<plan-id>/index.md` plus direct `phase-NN-<slug>.md` files with the exact standalone ultra marker, and `index.md` is its sole progress ledger. Do not create a sibling `<plan-id>.md`; do not create or synchronize `task.md`, `context.md`, `rules.md`, `verify.md`, `status.yaml`, or `explore.md`; and do not add AIFHub checkboxes to phase files.

### Research Normalization

- In OpenSpec-native mode, do not import research into `openspec/changes/<change-id>/` as runtime-only notes.
- In legacy AI Factory-only mode, if `.ai-factory/RESEARCH.md` exists, normalize the active summary into plan-local `explore.md`.
- Keep `.ai-factory/RESEARCH.md` read-only.
- In legacy AI Factory-only mode, record the imported source and timestamp in `status.yaml.history`.

### Plan Resolution and Migration

- In OpenSpec-native mode, use OpenSpec change IDs and the shared active-change vocabulary.
- In legacy AI Factory-only mode, when the active branch slug matches an existing plan folder without a companion `.md` plan file, generate the missing plan file before continuing.
- In legacy AI Factory-only mode, record legacy upgrades in `status.yaml.history` with the source folder path and the generated companion plan file path.
- User-facing guidance must present the mode-appropriate canonical artifacts, not a mixed OpenSpec/legacy shape.

### Handoff Rules

- After planning, route the next step to `/aif-improve`.
- Do not mention deprecated orchestration or finalize aliases as active workflow steps.

### Codex Runtime

When running in Codex app/CLI:

- The planning stage (`/aif-plan full`, `/aif-improve`) should run in Codex Plan mode when structured clarifying questions are needed.
- This skill may recommend Plan mode, but it does not attempt or promise to switch the Codex session mode. The user controls the mode.
- In Codex Plan mode, use `request_user_input` only for 1-3 short questions.
- In Codex Default mode, if a question is needed, ask it as plain text in the assistant message. Do not use `question(...)`, `questionnaire(...)`, or `request_user_input`.
- If another CLI or IDE runtime exposes a planning mode, use that available planning-mode mechanism for structured planning questions; do not fabricate unavailable tools or client actions.
- In autonomous or subagent mode, do not ask interactive questions. Record assumptions and return blockers/open questions to the parent.
- See `skills/shared/QUESTION-TOOL.md` for the full runtime question format mapping.
