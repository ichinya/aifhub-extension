## AIFHub Fix OpenSpec-native Override

Read [tool selection and artifact ownership](../../skills/shared/TOOLS.md) before choosing artifact paths or lifecycle instructions.

Apply this block before the upstream `aif-fix` body. When any rule below conflicts with the base skill text, this block wins.

Follow `skills/shared/LANGUAGE-POLICY.md` before producing user-facing responses or generated artifacts.

Once artifact classification permits local execution, follow [test quality and readiness waits](../../skills/shared/TEST-QUALITY.md) before selecting or changing an automated check or a readiness wait. This applies to OpenSpec-native and classic legacy execution; preserve marker-first delegation and no-test fallbacks.

Resolve the policy from the AIFHub extension root; in an installed project it is `.ai-factory/extensions/aifhub-extension/skills/shared/TEST-QUALITY.md`. Do not create a replacement policy in the consumer project.

Resolve user-facing prose language in this order: use a usable non-empty `language.ui`; otherwise preserve the current conversation language for this response only; use English only when that language is indeterminate. This rule overrides downstream generic English defaults; do not infer from OS locale or persist the inferred choice. On that hard-English fallback, add exactly one concise setup hint only when the output contract permits human-readable prose, before any required final machine-readable block; never add it inside or after `aif-gate-result`, and never alter exact handoffs, fixed commands, paths, keys/enums, or machine-only output.

### Goal

Use the built-in `/aif-fix` skill as the canonical fix command for OpenSpec-native changes and the extension's legacy companion plan workflow.

### Skill-Context Resolution

Read skill-context in this order:

1. `.ai-factory/skill-context/aif-fix/SKILL.md`
2. `.ai-factory/skill-context/aif-fix-plus/SKILL.md` as legacy compatibility fallback

If both exist, `aif-fix` wins.

### Mode Detection

Before resolving fix findings, read `.ai-factory/config.yaml` when it exists.

- If the config contains `aifhub.tools.openspec: true`, use **OpenSpec-native mode**.
- Otherwise, use **Legacy AI Factory-only mode**.
- If the config is missing, continue with Legacy AI Factory-only mode and state that no OpenSpec-native protocol was detected.

### Legacy ultra marker-first boundary

In Legacy AI Factory-only mode, classify the normalized project-relative plan entrypoint with `classifyLegacyPlanShape()` from `scripts/legacy-plan-migration.mjs` before companion discovery, verification-source selection, fix-plan creation, or any `status.yaml`/`fixes/*.md` write. Marker validation is first; known companion filenames are considered only after the classifier returns a classic shape.

- For `ultra-valid`, stop all AIFHub companion logic and return the exact upstream handoff `/aif-fix <entrypoint>`. Do not create or synchronize a sibling `<plan-id>.md`, `task.md`, `context.md`, `rules.md`, `verify.md`, `status.yaml`, `explore.md`, or AIFHub fix artifact; upstream owns the complete marked bundle atomically.
- For `ultra-invalid` or `collision`, fail closed before any write and report only bounded `shape`, safe `entrypoint`, and classifier `code` values.
- For `classic-pair` or `classic-folder-only`, continue with the classic companion rules below. An unrelated directory is not a plan.
- Diagnostics may include only `shape`, safe project-relative `entrypoint`, and `handoff`; never include marker bodies, phase contents, request/research bodies, credentials, raw stdout, or raw stderr.

### Fix re-review handoff

After classification permits a selected fix, follow the fixer handoff in `skills/shared/SCOPED-REVIEW.md` before editing and when reporting results. Preserve the original finding IDs and exact pre-fix/post-fix targets, including uncommitted changes, so a later re-review can verify the actual fix. Apply this in OpenSpec-native and classic legacy execution; marker-first delegation takes precedence.

Resolve the policy from the AIFHub extension root; in an installed project it is `.ai-factory/extensions/aifhub-extension/skills/shared/SCOPED-REVIEW.md`. Keep evidence in the existing fix report/response and do not create a replacement policy in the consumer project.

### OpenSpec-native mode

When `.ai-factory/config.yaml` declares `aifhub.tools.openspec: true`, `/aif-fix` applies selected QA findings for the active OpenSpec change.

For plan content, read only the canonical OpenSpec artifacts listed below. Do not inspect or mutate `.ai-factory/plans/**` after an OpenSpec change resolves.

Use `buildFixContext(options)` from `scripts/openspec-execution-context.mjs` when available before editing implementation files. Treat the returned resolver diagnostics, canonical artifacts, QA evidence, generated rules, OpenSpec apply instructions, runtime paths, warnings, and errors as the machine-readable fix context. If the helper is unavailable, fall back to the explicit filesystem reads and runtime boundaries in this section.

Use shared vocabulary consistently: `OpenSpec-native mode`, `canonical OpenSpec change`, `active change`, `change-id`, `base specs`, `delta specs`, `generated rules`, `runtime state`, `QA evidence`, and `legacy AI Factory-only mode`.

Bug-fix routing:

- A new bug report is not a post-verify fix.
- If `/aif-fix` is invoked with a bug description but no active OpenSpec change and no QA evidence, stop and say:

```text
No active OpenSpec change or QA evidence was found for this bug fix.

For a new bug report, create an OpenSpec change first:

/aif-plan full "fix <bug description>"
```

- `/aif-fix` requires existing QA evidence or selected findings.
- `/aif-fix` does not create a new OpenSpec change.
- `/aif-fix` writes fix traces under `.ai-factory/state/<change-id>/fixes/`.
- `/aif-fix` does not write QA verdicts.
- `/aif-fix` does not archive.
- `/aif-fix` routes back to `/aif-verify <change-id>`.
- In OpenSpec-native mode, `/aif-fix` must not create `.ai-factory/plans/<id>/` or invent legacy fix artifacts.

Resolve the active change using `scripts/active-change-resolver.mjs` when available:

- Prefer an explicit `<change-id>` or `@openspec/changes/<change-id>` input when provided.
- Otherwise use `resolveActiveChange` behavior: current working directory, current branch mapping, current pointer, then single active change.
- Treat selected source, candidate list, warnings, and errors as user-visible fix context.

Read QA findings and canonical context before editing implementation files:

- `.ai-factory/qa/<change-id>/`
- `openspec/specs/**`
- `openspec/changes/<change-id>/proposal.md`
- `openspec/changes/<change-id>/design.md`
- `openspec/changes/<change-id>/tasks.md`
- `openspec/changes/<change-id>/specs/**/spec.md`

Treat planning source sections as read-only fix context:

- Use `## Original Request` as the raw intent anchor for the selected QA finding; do not rewrite it or treat it as permission to widen the fix.
- When `proposal.md` contains `## Research Context`, use the embedded snapshot and source revision as authoritative committed scope.
- For an embedded ultra source, pass its exact project-relative `RESEARCH.md` path to `resolveUltraResearchSource()` from `scripts/ultra-research-resolver.mjs` and consume only its structured `source`, `revision`, and `diagnostic`. This centrally revalidates the sibling marker/index/status/link and normalized Active Summary digest; do not implement local selection or hashing heuristics.
- Compare the exact regular or ultra source only for drift and rationale. Missing/invalid source, changed `Updated`, or changed normalized `SHA256` emits `WARN [research-drift] change-id=<change-id> source=<path> expected=<embedded revision> current=<live revision>` and keeps the fix bounded to existing QA evidence and committed scope. Recency never selects a replacement source.
- Do not mutate or silently rebase either source section. Keep credentials, raw provider output, and full request/research bodies out of fix messages and traces.

Read generated rules as derived fix guidance when present:

- `.ai-factory/rules/generated/openspec-merged-<change-id>.md`
- `.ai-factory/rules/generated/openspec-change-<change-id>.md`
- `.ai-factory/rules/generated/openspec-base.md`

Systematic root-cause discipline before editing:

1. Record direct `rootCauseEvidence` from the selected finding and relevant component boundaries. Trace the bad value or control flow backward far enough to identify where it first becomes wrong; do not stop at the final symptom.
2. State one falsifiable `hypothesis` that explains both the observed failure and the direct evidence.
3. Define the smallest `experiment` that can disprove or support that hypothesis without applying the full fix.
4. Test one hypothesis at a time. After three failed hypotheses or experiments, stop, re-check the selected finding and architecture assumptions, and do not stack another speculative edit.
5. Continue to `regressionCheck` and implementation only when the evidence supports a safely bounded root cause. Otherwise record the blocker and stop without implementation edits.

Persist evidence in this order through `writeFixTrace()`: `rootCauseEvidence`, `hypothesis`, `experiment`, `regressionCheck`, `preFixResult`, `postFixResult`, and `fallbackDecision`. Keep the evidence bounded and credential-safe.

Regression-first execution order:

1. Select the narrowest current failing command or reproducible scenario from the chosen QA finding. Record its QA evidence path, command/check, non-sensitive inputs, and relevant environment assumptions before editing.
2. Run or reproduce that exact check before editing and record `preFixResult` with exit code or observed status. Do not claim reproduction when the check passes unexpectedly or cannot run.
3. When the failure is reproduced, apply the smallest root-cause fix within the selected finding's scope.
4. Rerun the identical command/check after editing and record `postFixResult` with exit code or observed status.
5. Persist `qaEvidenceRead`, `rootCauseEvidence`, `hypothesis`, `experiment`, `regressionCheck`, `preFixResult`, `postFixResult`, and `fallbackDecision` through `writeFixTrace()` under `.ai-factory/state/<change-id>/fixes/`. Redact credentials, tokens, authorization values, cookies, sensitive URL parameters, and raw provider output.
6. If the pre-fix check passes unexpectedly or no useful check exists in an interactive session, record the fallback reason and ask whether to investigate further, adjust reproduction, or proceed with a bounded likely fix. Do not edit until the user chooses.
7. In autonomous, Handoff, or bounded fixer-agent mode, investigate only within the selected finding. If no plausible safely bounded root cause is established, record a blocked or unreproducible `fallbackDecision` and stop without implementation edits.

A passing post-fix check is supporting runtime evidence only. `/aif-fix` must not write or replace `verify.md`, `coverage.json`, rules evidence, done evidence, or archive evidence; `/aif-verify <change-id>` remains authoritative.

Write fix traces only to runtime state:

- Prefer `writeFixTrace(changeId, trace, options)` from `scripts/openspec-execution-context.mjs` for fix traces.
- `.ai-factory/state/<change-id>/`
- `.ai-factory/state/<change-id>/fixes/`

Do not write fix traces, runtime-only files, or QA evidence into `openspec/changes/<change-id>/`. Do not archive. Do not create legacy plan-folder fix artifacts in OpenSpec-native mode.

Normal fix responses should report:

- selected `change-id` and resolver source;
- selected QA findings;
- canonical artifacts inspected;
- generated rules freshness or missing/stale `WARN`;
- regression check, pre-fix result, post-fix result, and fallback decision;
- fix trace paths under `.ai-factory/state/<change-id>/`;
- re-verification guidance: `/aif-verify <change-id>`.

Do not install OpenSpec skills or slash commands.
Do not redirect the user to a separate `aif-fix-plus` command.

### Legacy AI Factory-only mode

When OpenSpec-native mode is not enabled, preserve the existing plan-folder behavior.

Verification source:

- In this extension workflow, `/aif-fix` consumes findings from built-in `/aif-verify`.
- If `status.yaml -> verification` exists for the resolved plan, treat it as the runtime source of truth.
- If no verification results are present, instruct the user to run `/aif-verify`.

Plan-folder contract:

- update `.ai-factory/plans/<plan-id>/status.yaml`
- create `.ai-factory/plans/<plan-id>/fixes/*.md`
- keep plan artifacts read-only except for the fixes/status data they already own
- if only the folder exists, preserve it and normalize the canonical plan id in user-facing guidance

Legacy fix-plan cleanup remains owned by the upstream `/aif-fix` resolved-path workflow. This injection must not implement file deletion: upstream may remove only the default `.ai-factory/FIX_PLAN.md` after successful execution, while custom `paths.fix_plan` values and explicitly supplied non-default fix-plan files remain in place.

After fixes are applied, suggest `/aif-verify`.

Do not redirect the user to a separate `aif-fix-plus` command. `/aif-fix` is the canonical command.
