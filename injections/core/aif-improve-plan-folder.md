## AIFHub Improve OpenSpec-native Override

Apply this block before the upstream `aif-improve` body. When any rule below conflicts with the base skill text, this block wins.

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

### OpenSpec-native mode

When `.ai-factory/config.yaml` declares `aifhub.artifactProtocol: openspec`, `/aif-improve` refines an existing OpenSpec-native change.

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

node scripts/migrate-legacy-plans.mjs <change-id> --dry-run
node scripts/migrate-legacy-plans.mjs <change-id>
```

Refine only these canonical OpenSpec artifacts for the active change:

- `openspec/changes/<change-id>/proposal.md`
- `openspec/changes/<change-id>/design.md`
- `openspec/changes/<change-id>/tasks.md`
- `openspec/changes/<change-id>/specs/**/spec.md`

Legacy companion plan artifacts, including `task.md`, `context.md`, `rules.md`, `verify.md`, and `status.yaml` are not OpenSpec-native refinement targets.

Preservation rules:

- Read current artifact content before editing.
- Preserve user-written sections unless they are explicitly obsolete or contradict the refined requirement.
- Prefer patch-style edits over whole-file regeneration.
- If an artifact is missing, create only missing artifacts needed by the requested refinement.
- When a delta spec exists, update the relevant requirement in an existing delta spec instead of regenerating the whole file.
- Keep unrelated requirements, scenarios, task checkboxes, and design notes intact.

Validation and runtime state:

- Read base specs from `openspec/specs/**` and generated rules from `.ai-factory/rules/generated/` when they are needed to preserve canonical requirement intent.
- Run or recommend OpenSpec validation through `validateOpenSpecChange(changeId)` from `scripts/openspec-runner.mjs`, or equivalent shared-runner behavior.
- Validation should correspond to `openspec validate <change-id> --type change --strict --json --no-interactive --no-color`.
- Missing or unsupported OpenSpec CLI is degraded validation, not a refinement failure.
- Summarize validation success, failure, or degraded status in the normal response.
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
- In autonomous or subagent mode, do not ask interactive questions. Record assumptions and return blockers/open questions to the parent.
- See `skills/shared/QUESTION-TOOL.md` for the full runtime question format mapping.
