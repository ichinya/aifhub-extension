## AIFHub Fix OpenSpec-native Override

Apply this block before the upstream `aif-fix` body. When any rule below conflicts with the base skill text, this block wins.

Follow `skills/shared/LANGUAGE-POLICY.md` before producing user-facing responses or generated artifacts.

### Goal

Use the built-in `/aif-fix` skill as the canonical fix command for OpenSpec-native changes and the extension's legacy companion plan workflow.

### Skill-Context Resolution

Read skill-context in this order:

1. `.ai-factory/skill-context/aif-fix/SKILL.md`
2. `.ai-factory/skill-context/aif-fix-plus/SKILL.md` as legacy compatibility fallback

If both exist, `aif-fix` wins.

### Mode Detection

Before resolving fix findings, read `.ai-factory/config.yaml` when it exists.

- If the config contains `aifhub.artifactProtocol: openspec`, use **OpenSpec-native mode**.
- Otherwise, use **Legacy AI Factory-only mode**.
- If the config is missing, continue with Legacy AI Factory-only mode and state that no OpenSpec-native protocol was detected.

### OpenSpec-native mode

When `.ai-factory/config.yaml` declares `aifhub.artifactProtocol: openspec`, `/aif-fix` applies selected QA findings for the active OpenSpec change.

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
- Compare live `paths.research` only for drift and rationale. If `Updated` or normalized `SHA256` differs, or legacy metadata is incomplete, emit `WARN [research-drift] change-id=<change-id> source=<path> expected=<embedded revision> current=<live revision>` and keep the fix bounded to existing QA evidence and committed scope.
- Do not mutate or silently rebase either source section. Keep credentials, raw provider output, and full request/research bodies out of fix messages and traces.

Read generated rules as derived fix guidance when present:

- `.ai-factory/rules/generated/openspec-merged-<change-id>.md`
- `.ai-factory/rules/generated/openspec-change-<change-id>.md`
- `.ai-factory/rules/generated/openspec-base.md`

Regression-first execution order:

1. Select the narrowest current failing command or reproducible scenario from the chosen QA finding. Record its QA evidence path, command/check, non-sensitive inputs, and relevant environment assumptions before editing.
2. Run or reproduce that exact check before editing and record `preFixResult` with exit code or observed status. Do not claim reproduction when the check passes unexpectedly or cannot run.
3. When the failure is reproduced, apply the smallest root-cause fix within the selected finding's scope.
4. Rerun the identical command/check after editing and record `postFixResult` with exit code or observed status.
5. Persist `qaEvidenceRead`, `regressionCheck`, `preFixResult`, `postFixResult`, and `fallbackDecision` through `writeFixTrace()` under `.ai-factory/state/<change-id>/fixes/`. Redact credentials, tokens, authorization values, cookies, sensitive URL parameters, and raw provider output.
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
