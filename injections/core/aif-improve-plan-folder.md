## AIFHub Improve OpenSpec-native Override

Apply this block before the upstream `aif-improve` body. When any rule below conflicts with the base skill text, this block wins.

Follow `skills/shared/LANGUAGE-POLICY.md` before producing user-facing responses or generated artifacts.

Resolve user-facing prose language in this order: use a usable non-empty `language.ui`; otherwise preserve the current conversation language for this response only; use English only when that language is indeterminate. This rule overrides downstream generic English defaults; do not infer from OS locale or persist the inferred choice. On that hard-English fallback, add exactly one concise setup hint only when the output contract permits human-readable prose, before any required final machine-readable block; never add it inside or after `aif-gate-result`, and never alter exact handoffs, fixed commands, paths, keys/enums, or machine-only output.

### Goal

Use the built-in `/aif-improve` skill as the canonical refinement command for both OpenSpec-native changes and the extension's legacy companion plan workflow.

### Skill-Context Resolution

Read skill-context in this order:

1. `.ai-factory/skill-context/aif-improve/SKILL.md`
2. `.ai-factory/skill-context/aif-improve-plus/SKILL.md` as legacy compatibility fallback

If both exist, `aif-improve` wins.

### Mode Detection

Before resolving a target, read `.ai-factory/config.yaml` when it exists.

- If the config contains `aifhub.artifactProtocol: openspec`, use **OpenSpec-native mode**.
- Otherwise, use **Legacy AI Factory-only mode**.
- If the config is missing, continue with Legacy AI Factory-only mode and state that no OpenSpec-native protocol was detected.

### Legacy ultra marker-first boundary

In Legacy AI Factory-only mode, classify the normalized project-relative plan entrypoint with `classifyLegacyPlanShape()` from `scripts/legacy-plan-migration.mjs` before folder-only detection, companion discovery, plan-file creation, refinement, or any `status.yaml` write. Marker validation is first; known companion filenames are considered only after the classifier returns a classic shape.

- For `ultra-valid`, stop all AIFHub companion logic and return the exact upstream handoff `/aif-improve <entrypoint>`. Do not create or synchronize a sibling `<plan-id>.md`, `task.md`, `context.md`, `rules.md`, `verify.md`, `status.yaml`, or `explore.md`; upstream owns the complete marked bundle atomically.
- For `ultra-invalid` or `collision`, fail closed before any write and report only bounded `shape`, safe `entrypoint`, and classifier `code` values.
- For `classic-pair` or `classic-folder-only`, continue with the classic companion rules below. An unrelated directory is not a plan.
- Diagnostics may include only `shape`, safe project-relative `entrypoint`, and `handoff`; never include marker bodies, phase contents, request/research bodies, credentials, raw stdout, or raw stderr.

### OpenSpec-native mode

When `.ai-factory/config.yaml` declares `aifhub.artifactProtocol: openspec`, `/aif-improve` refines an existing OpenSpec-native change.

For plan content, read only the canonical OpenSpec artifacts listed below. Do not inspect or mutate `.ai-factory/plans/**` after an OpenSpec change resolves.

Use shared vocabulary consistently: `OpenSpec-native mode`, `canonical OpenSpec change`, `active change`, `change-id`, `base specs`, `delta specs`, `generated rules`, `runtime state`, `QA evidence`, and `legacy AI Factory-only mode`.

Resolve the active change using the shared vocabulary from `scripts/active-change-resolver.mjs`:

- Prefer an explicit `<change-id>` or `@openspec/changes/<change-id>` input when provided.
- Otherwise use `resolveActiveChange` behavior: current working directory, current branch mapping, current pointer, then single active change.
- Treat the selected change ID, selected source, candidate list, warnings, and errors as user-visible refinement context.
- If the resolved path is under `openspec/changes/archive/**`, do not edit silently. Archived changes are immutable by default; report the archived target clearly and suggest creating a new change for further work.
- If an explicit or inferred `<change-id>` cannot be resolved as an OpenSpec change, check for matching legacy AI Factory plan artifacts through `detectMigrationNeed(options)` from `scripts/legacy-plan-migration.mjs` or equivalent read-only detection. If migration is suggested, do not auto-migrate. Show exactly:

```text
Found legacy AI Factory plan artifacts for `<change-id>` but no OpenSpec change at `openspec/changes/<change-id>`.
Run the legacy migration script with:

ai-factory aifhub-migrate-legacy-plans <change-id> --dry-run
ai-factory aifhub-migrate-legacy-plans <change-id>
```

Refine only these canonical OpenSpec artifacts for the active change:

- `openspec/changes/<change-id>/proposal.md`
- `openspec/changes/<change-id>/design.md`
- `openspec/changes/<change-id>/tasks.md`
- `openspec/changes/<change-id>/specs/**/spec.md`

Legacy companion plan artifacts, including `task.md`, `context.md`, `rules.md`, `verify.md`, and `status.yaml` are not OpenSpec-native refinement targets.

#### Task Quality Refinement

When refining an OpenSpec-native change, audit normalized task quality across the canonical artifacts:

- `proposal.md` for intent, scope, non-goals, assumptions, risks, and open questions
- `design.md` for C4 impact, ADR candidates, dependency notes, integration points, alternatives, and risks
- `tasks.md` for an executable checklist whose task descriptions state how completion is verified
- `specs/**/spec.md` for behavior deltas

Classify open questions as `blocker`, `warn`, or `info` when useful, without requiring classification in trivial changes or forcing a specific table format.

Patch only affected sections and avoid whole-file regeneration unless structurally unusable.

Preservation rules:

- Read current artifact content before editing.
- Treat the complete `## Original Request` heading and body as immutable raw source. Preserve its exact bytes, including line endings, whitespace, punctuation, casing, and line breaks; patch other sections around it instead of reconstructing `proposal.md`.
- Treat an existing `## AIFHub Source Binding` as reserved identity metadata. Preserve its complete heading and body byte-for-byte during ordinary refinement; `Provider`, `Primary source`, and `External ID` are immutable, and `Branch` may change only for an explicit branch-rebind request that keeps the same primary source and passes source-binding validation. In a legacy classic plan, update the Markdown entrypoint and `status.yaml.source_binding.branch` as one logical rebind and require `parseSynchronizedWorkItemSourceBinding(markdown, status)` to pass before reporting success.
- Treat an existing `## Research Context` body and `Source` revision metadata as the committed requirements snapshot. Do not translate, normalize, regenerate, or replace it unless the user explicitly requests a research rebase.
- For an embedded ultra source, pass its exact project-relative `RESEARCH.md` path to `resolveUltraResearchSource()` from `scripts/ultra-research-resolver.mjs`. Consume the structured `source`, `revision`, and `diagnostic` so the sibling marked `INDEX.md`, active status, Artifact Index link, path confinement, and normalized Active Summary digest are all revalidated centrally.
- For an explicit research rebase, use resolver precedence: safe explicit `RESEARCH.md` path, exact slug, then exactly one caller-reviewed relevant active candidate. Ambiguity stops; recency never chooses a source.
- When the exact regular or ultra source is missing/invalid, or its `Updated`/normalized `SHA256` differs, emit `WARN [research-drift] change-id=<change-id> source=<path> expected=<embedded revision> current=<live revision>`. Keep the embedded snapshot authoritative and do not log its full body, credentials, raw provider output, or sibling artifact bodies.
- Live research `## Sessions` may be consulted only for rationale. Do not apply requirements from a newer Active Summary without an explicit user rebase request.
- On an explicit research rebase, copy the selected current Active Summary, recompute the stable digest, update the `Source` path plus `Updated` and `SHA256` metadata, and report that committed scope changed.
- Preserve user-written sections unless they are explicitly obsolete or contradict the refined requirement.
- Prefer patch-style edits over whole-file regeneration.
- In `tasks.md`, require every task checkbox to state its completion verification inline through a test, command, observable behavior, or delivered artifact. Keep a separate verification task only when it checks broader integration or system behavior spanning multiple implementation tasks.
- For a `tasks.md` created before this rule, treat every checkbox missing inline completion verification as affected by a bounded checklist migration, even when its implementation action is otherwise unrelated to the requested refinement.
- For each migrated checkbox, preserve its task number, checked/unchecked state, order, and original action and intent. Append only the concrete verification clause needed for compliance; do not split, merge, reorder, renumber, reopen, complete, or broaden the task.
- Leave already compliant unrelated checkboxes unchanged unless the requested refinement affects them.
- If an artifact is missing, create only missing artifacts needed by the requested refinement.
- When a delta spec exists, update the relevant requirement in an existing delta spec instead of regenerating the whole file.
- Keep unrelated requirements, scenarios, already compliant task checkboxes, and design notes intact. A checkbox missing required inline verification is part of the bounded checklist migration rather than unrelated content.

Legacy checklist migration example:

Before:

```markdown
- [x] 1.1 Add parser support
- [ ] 1.2 Update usage docs
```

After:

```markdown
- [x] 1.1 Add parser support; verify focused parser tests pass
- [ ] 1.2 Update usage docs; verify documentation contract tests pass
```

Validation and runtime state:

- Read base specs from `openspec/specs/**` and generated rules from `.ai-factory/rules/generated/` when they are needed to preserve canonical requirement intent.
- Before validation, resolve the effective OpenSpec policy through `ai-factory aifhub-mode status --json`.
- Run or recommend OpenSpec validation through `validateOpenSpecChange(changeId)` from `scripts/openspec-runner.mjs`, or equivalent shared-runner behavior.
- Validation should correspond to `openspec validate <change-id> --type change --strict --json --no-interactive --no-color`.
- Missing or unsupported OpenSpec CLI is degraded validation unless the effective policy has `requireCliForImprove: true`; when required, treat the missing CLI as a refinement blocker and do not report the change as validation-ready.
- Summarize effective policy, validation success, failure, degraded status, or policy-blocked status in the normal response.
- Runtime state notes may be written only under `.ai-factory/state/<change-id>/`.
- QA evidence belongs under `.ai-factory/qa/<change-id>/` and should not be written into canonical OpenSpec change artifacts.
- Prefer `ensureRuntimeLayout(changeId)` when runtime directories are needed.
- Valid persisted runtime evidence includes `.ai-factory/state/<change-id>/improve-summary.md` and `.ai-factory/state/<change-id>/last-validation.json`.
- Do not write runtime-only files or validation evidence under `openspec/changes/<change-id>/`.

Output summary:

```text
Changed:
- proposal.md: ...
- design.md: ...
- tasks.md: ...
- specs/<capability>/spec.md: ...

Preserved:
- ...
```

The response must report the selected change ID, selected source, changed canonical artifact paths, preserved user-written areas, and validation status. Do not install OpenSpec skills or slash commands.
Report `Original Request`, `AIFHub Source Binding`, and `Research Context` as preserved section names when applicable, but do not duplicate their raw bodies in output.

### Legacy AI Factory-only mode

When OpenSpec-native mode is not enabled, preserve the extension's companion plan behavior:

- Resolve all of these inputs to one active pair:
  - `.ai-factory/plans/<plan-id>.md`
  - `.ai-factory/plans/<plan-id>/`
  - any plan-local artifact path inside `.ai-factory/plans/<plan-id>/`
- When a legacy folder-only plan is selected:
  - create `.ai-factory/plans/<plan-id>.md` before refinement continues
  - preserve the existing folder artifacts
  - record the upgrade in `status.yaml.history`
- Update the plan file summary and the plan-folder artifacts together.
- Keep `status.yaml` as the canonical execution state file.
- When refinement completes successfully and the next step is execution, route to `/aif-implement`.
- Do not send the user to deprecated workflow aliases or legacy `*-plus` command names.

### Compatibility Note

If historical docs or plan notes still mention `aif-improve-plus`, interpret that as `/aif-improve`.

### Codex Runtime

When running in Codex app/CLI:

- The refinement stage (`/aif-improve`) should run in Codex Plan mode when structured clarifying questions are needed.
- This skill may recommend Plan mode, but it does not attempt or promise to switch the Codex session mode. The user controls the mode.
- In Codex Plan mode, use `request_user_input` only for 1-3 short questions.
- In Codex Default mode, if a question is needed, ask it as plain text in the assistant message. Do not use `question(...)`, `questionnaire(...)`, or `request_user_input`.
- If another CLI or IDE runtime exposes a planning mode, use that available planning-mode mechanism for structured planning questions; do not fabricate unavailable tools or client actions.
- In autonomous or subagent mode, do not ask interactive questions. Record assumptions and return blockers/open questions to the parent.
- See `skills/shared/QUESTION-TOOL.md` for the full runtime question format mapping.
