## AIFHub Fix OpenSpec-native Override

Apply this block before the upstream `aif-fix` body. When any rule below conflicts with the base skill text, this block wins.

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

Use shared vocabulary consistently: `OpenSpec-native mode`, `canonical OpenSpec change`, `active change`, `change-id`, `base specs`, `delta specs`, `generated rules`, `runtime state`, `QA evidence`, and `legacy AI Factory-only mode`.

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

Read generated rules as derived fix guidance when present:

- `.ai-factory/rules/generated/openspec-merged-<change-id>.md`
- `.ai-factory/rules/generated/openspec-change-<change-id>.md`
- `.ai-factory/rules/generated/openspec-base.md`

Write fix traces only to runtime state:

- `.ai-factory/state/<change-id>/`
- `.ai-factory/state/<change-id>/fixes/`

Do not write fix traces, runtime-only files, or QA evidence into `openspec/changes/<change-id>/`. Do not archive. Do not create legacy plan-folder fix artifacts in OpenSpec-native mode.

Normal fix responses should report:

- selected `change-id` and resolver source;
- selected QA findings;
- canonical artifacts inspected;
- generated rules freshness or missing/stale `WARN`;
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

After fixes are applied, suggest `/aif-verify`.

Do not redirect the user to a separate `aif-fix-plus` command. `/aif-fix` is the canonical command.
