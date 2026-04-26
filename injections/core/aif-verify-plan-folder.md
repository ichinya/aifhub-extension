## AIFHub Verify OpenSpec-native Override

Apply this block before the upstream `aif-verify` body. When this guidance conflicts with the base skill text, this block wins.

### Goal

Use the built-in `/aif-verify` skill as the canonical verification command for OpenSpec-native changes and the extension's legacy companion plan workflow.

### Skill-Context Resolution

Read skill-context in this order:

1. `.ai-factory/skill-context/aif-verify/SKILL.md`
2. `.ai-factory/skill-context/aif-verify-plus/SKILL.md` as legacy compatibility fallback

If both exist, `aif-verify` wins.

### Mode Detection

Before resolving verification scope, read `.ai-factory/config.yaml` when it exists.

- If the config contains `aifhub.artifactProtocol: openspec`, use **OpenSpec-native mode**.
- Otherwise, use **Legacy AI Factory-only mode**.
- If the config is missing, continue with Legacy AI Factory-only mode and state that no OpenSpec-native protocol was detected.

### OpenSpec-native mode

When `.ai-factory/config.yaml` declares `aifhub.artifactProtocol: openspec`, `/aif-verify` verifies implementation against the active OpenSpec change. This prompt guidance does not implement OpenSpec validate/status integration from issue #32.

Use shared vocabulary consistently: `OpenSpec-native mode`, `canonical OpenSpec change`, `active change`, `change-id`, `base specs`, `delta specs`, `generated rules`, `runtime state`, `QA evidence`, and `legacy AI Factory-only mode`.

Resolve the active change using `scripts/active-change-resolver.mjs` when available:

- Prefer an explicit `<change-id>` or `@openspec/changes/<change-id>` input when provided.
- Otherwise use `resolveActiveChange` behavior: current working directory, current branch mapping, current pointer, then single active change.
- Treat selected source, candidate list, warnings, and errors as user-visible verification context.

Validate and review against canonical OpenSpec artifacts:

- `openspec/specs/**`
- `openspec/changes/<change-id>/proposal.md`
- `openspec/changes/<change-id>/design.md`
- `openspec/changes/<change-id>/tasks.md`
- `openspec/changes/<change-id>/specs/**/spec.md`

Read generated rules as derived verification guidance when present:

- `.ai-factory/rules/generated/openspec-merged-<change-id>.md`
- `.ai-factory/rules/generated/openspec-change-<change-id>.md`
- `.ai-factory/rules/generated/openspec-base.md`

Runtime state and QA evidence boundaries:

- Read implementation runtime state from `.ai-factory/state/<change-id>/` when present.
- Write verification findings, verdicts, command results, and review evidence only under `.ai-factory/qa/<change-id>/`.
- Do not write QA evidence or runtime-only files into `openspec/changes/<change-id>/`.
- Do not archive. `/aif-done` remains the post-verify finalizer, with full archive integration deferred to issue #33.
- Do not create legacy plan-folder verification artifacts in OpenSpec-native mode.

Normal verification responses should report:

- selected `change-id` and resolver source;
- canonical artifacts inspected;
- generated rules freshness or missing/stale `WARN`;
- QA evidence path under `.ai-factory/qa/<change-id>/`;
- verdict and finding counts;
- fix guidance `/aif-fix <change-id>` when verification fails;
- optional finalization guidance `/aif-done <change-id>` when verification passes.

Do not install OpenSpec skills or slash commands.
Do not redirect the user to legacy finalize aliases.

### Legacy AI Factory-only mode

When OpenSpec-native mode is not enabled, preserve the current companion plan verification contract.

Resolve the active target as a companion pair:

- `.ai-factory/plans/<plan-id>.md`
- `.ai-factory/plans/<plan-id>/`

If verification enters through a legacy folder-only plan, create the missing companion plan file before verification and record the migration in `status.yaml.history`.

Plan-folder contract:

- read `task.md`, `context.md`, `rules.md`, `verify.md`, `status.yaml`, optional `constraints-*.md`, optional `explore.md`
- update only `status.yaml` and `verify.md`
- keep source code and project context files read-only

Workflow integration:

- In the extension workflow, `/aif-implement` hands off to `/aif-verify`.
- Route failing verification to `/aif-fix`.
- On `PASS` or `PASS with notes`, stop at the verified state and recommend `/aif-done` only when archive/commit/PR/follow-up finalization is needed.
- Never archive into `.ai-factory/specs/`, never create `spec.md`, never update `specs/index.yaml`, and never set `status.yaml.status` to `done`.
- When `--check-only` is present, keep the same no-archive behavior and return a verification-only gate result for downstream review/finalization flows.
- Do not redirect the user to legacy finalize aliases, and do not present `/aif-done` as a replacement for `/aif-verify`; `/aif-done` is an optional post-verify AIFHub finalizer.
