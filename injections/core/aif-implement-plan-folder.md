## AIFHub Implement OpenSpec-native Override

Read [tool selection and artifact ownership](../../skills/shared/TOOLS.md) before choosing artifact paths or lifecycle instructions.

Apply this block before the upstream `aif-implement` body. When any rule below conflicts with the base skill text, this block wins.

Follow `skills/shared/LANGUAGE-POLICY.md` before producing user-facing responses or generated artifacts.

Resolve user-facing prose language in this order: use a usable non-empty `language.ui`; otherwise preserve the current conversation language for this response only; use English only when that language is indeterminate. This rule overrides downstream generic English defaults; do not infer from OS locale or persist the inferred choice. On that hard-English fallback, add exactly one concise setup hint only when the output contract permits human-readable prose, before any required final machine-readable block; never add it inside or after `aif-gate-result`, and never alter exact handoffs, fixed commands, paths, keys/enums, or machine-only output.

### Goal

Use the built-in `/aif-implement` skill as the canonical execution command for both OpenSpec-native changes and the extension's legacy companion plan workflow.

### Skill-Context Resolution

Read skill-context in this order:

1. `.ai-factory/skill-context/aif-implement/SKILL.md`
2. `.ai-factory/skill-context/aif-implement-plus/SKILL.md` as legacy compatibility fallback

If both exist, `aif-implement` wins.

### Mode Detection

Before resolving an implementation target, read `.ai-factory/config.yaml` when it exists.

- If the config contains `aifhub.tools.openspec: true`, use **OpenSpec-native mode**.
- Otherwise, use **Legacy AI Factory-only mode**.
- If the config is missing, continue with Legacy AI Factory-only mode and state that no OpenSpec-native protocol was detected.

### Legacy ultra marker-first boundary

In Legacy AI Factory-only mode, classify the normalized project-relative plan entrypoint with `classifyLegacyPlanShape()` from `scripts/legacy-plan-migration.mjs` before folder-only detection, companion discovery, companion plan-file creation, execution metadata hydration, or any `status.yaml` write. Marker validation is first; known companion filenames are considered only after the classifier returns a classic shape.

- For `ultra-valid`, stop all AIFHub companion logic and return the exact upstream handoff `/aif-implement <entrypoint>`. Do not create or synchronize a sibling `<plan-id>.md`, `task.md`, `context.md`, `rules.md`, `verify.md`, `status.yaml`, `explore.md`, or AIFHub task state; upstream owns the complete marked bundle atomically.
- For `ultra-invalid` or `collision`, fail closed before any write and report only bounded `shape`, safe `entrypoint`, and classifier `code` values.
- For `classic-pair` or `classic-folder-only`, continue with the classic companion rules below. An unrelated directory is not a plan.
- Diagnostics may include only `shape`, safe project-relative `entrypoint`, and `handoff`; never include marker bodies, phase contents, request/research bodies, credentials, raw stdout, or raw stderr.

### OpenSpec-native mode

When `.ai-factory/config.yaml` declares `aifhub.tools.openspec: true`, `/aif-implement` executes implementation tasks for the active OpenSpec change.

For plan content, read only the canonical OpenSpec artifacts listed below. Do not inspect or mutate `.ai-factory/plans/**` after an OpenSpec change resolves.

Use `buildImplementationContext(options)` from `scripts/openspec-execution-context.mjs` when available before editing implementation files. Treat the returned resolver diagnostics, canonical artifacts, generated rules, OpenSpec apply instructions, runtime paths, warnings, and errors as the machine-readable implementation context. If the helper is unavailable, fall back to the explicit filesystem reads and runtime boundaries in this section.

Use shared vocabulary consistently: `OpenSpec-native mode`, `canonical OpenSpec change`, `active change`, `change-id`, `base specs`, `delta specs`, `generated rules`, `runtime state`, `QA evidence`, and `legacy AI Factory-only mode`.

Resolve the active change using `scripts/active-change-resolver.mjs` when available:

- Prefer an explicit `<change-id>` or `@openspec/changes/<change-id>` input when provided.
- Otherwise use `resolveActiveChange` behavior: current working directory, current branch mapping, current pointer, then single active change.
- Treat selected source, candidate list, warnings, and errors as user-visible implementation context.
- If an explicit or inferred `<change-id>` cannot be resolved as an OpenSpec change, check for matching legacy AI Factory plan artifacts through `detectMigrationNeed(options)` from `scripts/legacy-plan-migration.mjs` or equivalent read-only detection. If migration is suggested, do not auto-migrate. Show exactly:

```text
Found legacy AI Factory plan artifacts for `<change-id>` but no OpenSpec change at `openspec/changes/<change-id>`.
Run the legacy migration script with:

ai-factory aifhub-migrate-legacy-plans <change-id> --dry-run
ai-factory aifhub-migrate-legacy-plans <change-id>
```

Read canonical OpenSpec artifacts before editing implementation files:

- `openspec/specs/**`
- `openspec/changes/<change-id>/proposal.md`
- `openspec/changes/<change-id>/design.md`
- `openspec/changes/<change-id>/tasks.md`
- `openspec/changes/<change-id>/specs/**/spec.md`

Treat planning source sections as read-only implementation context:

- Use `## Original Request` as the raw intent anchor that explains why the change exists. Do not translate, normalize, rewrite, or use it instead of the executable `tasks.md`, design decisions, or requirements.
- When `proposal.md` contains `## Research Context`, use its embedded Active Summary and source revision as the authoritative committed scope.
- For an embedded ultra source, pass its exact project-relative `RESEARCH.md` path to `resolveUltraResearchSource()` from `scripts/ultra-research-resolver.mjs` and consume only its structured `source`, `revision`, and `diagnostic`. This centrally revalidates the sibling marker/index/status/link and normalized Active Summary digest; do not implement local selection or hashing heuristics.
- Compare the exact regular or ultra source only for revision drift and optional rationale. Missing/invalid source, changed `Updated`, or changed normalized `SHA256` emits `WARN [research-drift] change-id=<change-id> source=<path> expected=<embedded revision> current=<live revision>` and continues from the embedded snapshot. Recency never selects a replacement source.
- Do not silently apply requirements from newer research, expand task scope, or mutate `## Original Request` or `## Research Context` during implementation.
- Keep credentials, raw provider output, and the full request/research bodies out of drift diagnostics and execution traces.

Hydrate runtime todo state from canonical OpenSpec tasks before editing implementation files:

- Treat `openspec/changes/<change-id>/tasks.md` as the source checklist.
- If the current runtime exposes a todo or plan tool, use it before editing. In Codex, use `update_plan` when available.
- Map checked tasks to `completed`, mark the selected unfinished task or tightly coupled task group as `in_progress`, and leave other unfinished tasks as `pending`.
- If no todo or plan tool is available, report a concise task snapshot in the normal response and continue from canonical `tasks.md`.
- Report missing todo-tool support as a capability fallback, not as an implementation failure.
- Hydrating runtime todo state does not authorize broad task expansion; `/aif-implement` still executes one task or one tightly coupled task group.

#### Roadmap lifecycle deferral

In OpenSpec-native mode, this section overrides the upstream roadmap completion step.

- `/aif-implement` must not edit the configured roadmap and must not mark a milestone, phase, slice, or managed lifecycle row complete, even when all implementation tasks are checked.
- It may read `## Roadmap Linkage` from the canonical proposal and report only the detected linkage fields plus the fact that lifecycle ownership is deferred.
- Implementation output must not claim roadmap completion or copy unrelated roadmap content.
- Route authoritative validation to `/aif-verify <change-id>`. Only after verification passes may `/aif-done <change-id>` own the successful finalization transition defined by the canonical change.

Read generated rules as derived implementation guidance when present:

- `.ai-factory/rules/generated/openspec-merged-<change-id>.md`
- `.ai-factory/rules/generated/openspec-change-<change-id>.md`
- `.ai-factory/rules/generated/openspec-base.md`

#### Evidence-driven development cycle

For each testable behavior change whose plan, project policy, or existing test conventions call for an automated check, use this bounded cycle before declaring the task complete:

1. **RED** - select or add the narrowest focused automated check, record it as `testCheck`, and run it before the production edit. Record `redResult` only after observing the expected behavioral failure; a syntax, fixture, dependency, or environment failure is not valid RED evidence.
2. **GREEN** - make the smallest in-scope production change that satisfies the focused check, rerun the same check, and record `greenResult`. Do not broaden implementation merely to make unrelated checks green.
3. **REFACTOR** - perform only safe cleanup justified by the task, rerun the same focused check, and record `refactorResult`. Skip cleanup when it would expand scope.

Persist `testCheck`, `redResult`, `greenResult`, `refactorResult`, and `fallbackDecision` through `writeExecutionTrace()` under `.ai-factory/state/<change-id>/implementation/`. For documentation-only work, generated artifacts, user-authorized no-test work, or a task with no useful automated check, do not fabricate RED evidence: record a bounded `fallbackDecision` and run the narrowest applicable non-test verification instead.

This cycle is supporting runtime evidence only. It does not write QA evidence, weaken project-specific test policy, or replace the authoritative `/aif-verify <change-id>` gate.

Execution trace and runtime state boundaries:

- Prefer `writeExecutionTrace(changeId, trace, options)` from `scripts/openspec-execution-context.mjs` for implementation traces.
- Write implementation progress, task execution traces, degraded capability notes, and runner metadata only under `.ai-factory/state/<change-id>/`.
- Do not write runtime-only files, summaries, validation output, or execution traces under `openspec/changes/<change-id>/`.
- Do not create legacy plan-folder execution artifacts in OpenSpec-native mode.
- QA evidence belongs under `.ai-factory/qa/<change-id>/` and is owned by `/aif-verify`; implementation may name the path in normal output but should not write verification results there.

Normal implementation responses should report:

- selected `change-id` and resolver source;
- canonical artifacts read;
- generated rules freshness or missing/stale `WARN`;
- runtime state path under `.ai-factory/state/<change-id>/`;
- task progress from the OpenSpec `tasks.md`;
- runtime todo hydration summary or task snapshot capability fallback;
- next step `/aif-verify <change-id>` when implementation is ready.

After implementation, optional read-only gates are:

- `/aif-rules-check`
- `/aif-review`
- `/aif-security-checklist`

The authoritative final verification remains `/aif-verify <change-id>`.

Do not install OpenSpec skills or slash commands.
Do not route users to deprecated workflow aliases or legacy `*-plus` command names.

### Legacy AI Factory-only mode

When OpenSpec-native mode is not enabled, preserve the existing legacy companion plan workflow.

Resolve all of these inputs to one active plan pair before execution starts:

- `.ai-factory/plans/<plan-id>.md`
- `.ai-factory/plans/<plan-id>/`
- `task.md`, `context.md`, `rules.md`, `verify.md`, `status.yaml`, or `explore.md` inside a plan folder

If only the folder exists, create the missing companion plan file first and record the migration event in `status.yaml.history`.

Legacy AI Factory-only workflow rules:

- `/aif-implement` is the canonical execution command for this extension workflow.
- When no plan exists yet, route the user through `/aif-plan full "<task>" -> /aif-improve`.
- `/aif-implement` owns git strategy resolution and must persist `execution.git.*` in `status.yaml`.
- `/aif-implement` also owns `execution.mode`, `execution.runtime`, and `execution.subagent` updates.
- After tasks complete, route to `/aif-verify`; a passing verification leaves the plan ready for optional `/aif-done` finalization.
- Do not route users to deprecated workflow aliases or legacy `*-plus` command names.

### Subagent Compatibility

When checking optional Claude worker availability in Legacy AI Factory-only mode, support both current and legacy filenames:

- prefer `.claude/agents/implement-coordinator.md`
- support `.claude/agents/implement-worker.md`
- support legacy `.claude/agents/implementer.md`
- support legacy `.claude/agents/implementer-isolation.md`

When persisting `execution.subagent`, allow:

- `implement-coordinator`
- `implementer`
- `implementer-isolation`
- `null`

Prefer `implement-coordinator` when available.

### Execution Metadata

- Preserve sibling keys when updating `execution.*`.
- In Legacy AI Factory-only mode, record git-strategy decisions, runtime changes, legacy upgrades, and mode switches in `status.yaml.history`.
- In OpenSpec-native mode, write runtime state only under `.ai-factory/state/<change-id>/`.
- When the implementation flow needs a manual checkpoint, the next command is `/aif-verify`, not a deprecated finalize alias.

### Compatibility Note

If historical docs or plan notes still mention `aif-implement-plus`, interpret that as `/aif-implement`.
