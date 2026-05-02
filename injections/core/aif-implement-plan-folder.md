## AIFHub Implement OpenSpec-native Override

Apply this block before the upstream `aif-implement` body. When any rule below conflicts with the base skill text, this block wins.

### Goal

Use the built-in `/aif-implement` skill as the canonical execution command for both OpenSpec-native changes and the extension's legacy companion plan workflow.

### Skill-Context Resolution

Read skill-context in this order:

1. `.ai-factory/skill-context/aif-implement/SKILL.md`
2. `.ai-factory/skill-context/aif-implement-plus/SKILL.md` as legacy compatibility fallback

If both exist, `aif-implement` wins.

### Mode Detection

Before resolving an implementation target, read `.ai-factory/config.yaml` when it exists.

- If the config contains `aifhub.artifactProtocol: openspec`, use **OpenSpec-native mode**.
- Otherwise, use **Legacy AI Factory-only mode**.
- If the config is missing, continue with Legacy AI Factory-only mode and state that no OpenSpec-native protocol was detected.

### OpenSpec-native mode

When `.ai-factory/config.yaml` declares `aifhub.artifactProtocol: openspec`, `/aif-implement` executes implementation tasks for the active OpenSpec change.

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

node scripts/migrate-legacy-plans.mjs <change-id> --dry-run
node scripts/migrate-legacy-plans.mjs <change-id>
```

Read canonical OpenSpec artifacts before editing implementation files:

- `openspec/specs/**`
- `openspec/changes/<change-id>/proposal.md`
- `openspec/changes/<change-id>/design.md`
- `openspec/changes/<change-id>/tasks.md`
- `openspec/changes/<change-id>/specs/**/spec.md`

Read generated rules as derived implementation guidance when present:

- `.ai-factory/rules/generated/openspec-merged-<change-id>.md`
- `.ai-factory/rules/generated/openspec-change-<change-id>.md`
- `.ai-factory/rules/generated/openspec-base.md`

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
