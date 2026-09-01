## AIFHub Architecture Context Boundary

Apply this block before the upstream `aif-architecture` body. When any rule below conflicts with the upstream body, this block wins.

Follow `skills/shared/LANGUAGE-POLICY.md` before producing user-facing responses or generated artifacts.

Resolve user-facing prose language in this order: use a usable non-empty `language.ui`; otherwise preserve the current conversation language for this response only; use English only when that language is indeterminate. This rule overrides downstream generic English defaults; do not infer from OS locale or persist the inferred choice. On that hard-English fallback, add exactly one concise setup hint only when the output contract permits human-readable prose, before any required final machine-readable block; never add it inside or after `aif-gate-result`, and never alter exact handoffs, fixed commands, paths, keys/enums, or machine-only output.

### Goal

Keep upstream `/aif-architecture` as the command owner while adding AIFHub/OpenSpec artifact-boundary guidance.

Do not create or use an extension-owned `skills/aif-architecture/` directory. The upstream skill remains responsible for architecture analysis, recommendation, artifact generation, and project-specific `.ai-factory/skill-context/aif-architecture/SKILL.md` loading.

### Mode Detection

Before resolving architecture scope, read `.ai-factory/config.yaml` when it exists.

- If the config contains `aifhub.artifactProtocol: openspec`, use **OpenSpec-native mode**.
- Otherwise, use **Legacy AI Factory-only mode**.
- If the config is missing, continue with upstream defaults and state that no AIFHub artifact protocol was detected.

Always respect upstream config resolution for:

- `paths.description`
- `paths.architecture`
- `language.ui`
- `language.artifacts`
- `language.technical_terms`

### OpenSpec-native mode

When `.ai-factory/config.yaml` declares `aifhub.artifactProtocol: openspec`, `/aif-architecture` still writes project-level AI Factory architecture context, not canonical OpenSpec lifecycle artifacts.

Allowed writes are limited to:

- the resolved `paths.architecture` artifact;
- an architecture pointer in the resolved `paths.description` artifact;
- an architecture row in the root `AGENTS.md` context table.

Read-only context may include:

- `openspec/specs/**`;
- `openspec/changes/<change-id>/proposal.md`;
- `openspec/changes/<change-id>/design.md`;
- `openspec/changes/<change-id>/tasks.md`;
- `openspec/changes/<change-id>/specs/**/spec.md`;
- `.ai-factory/rules/generated/openspec-merged-<change-id>.md`;
- `.ai-factory/rules/generated/openspec-change-<change-id>.md`;
- `.ai-factory/rules/generated/openspec-base.md`;
- `.ai-factory/state/<change-id>/`;
- `.ai-factory/qa/<change-id>/`;
- the resolved roadmap, rules, research, and description artifacts.

Do not write:

- `openspec/changes/**`;
- `openspec/specs/**`;
- `.ai-factory/state/**`;
- `.ai-factory/qa/**`;
- `.ai-factory/rules/generated/**`;
- provider notes, MCP config, provider config, or provider setup files.

If an architecture decision would change product or workflow behavior, route that work through `/aif-plan full <request>` instead of writing OpenSpec delta specs directly from `/aif-architecture`.

### Optional Context Providers

Before using optional context providers, call the installed selector when it is available:

```bash
ai-factory aifhub-memory-tools select --from-project --command aif-architecture --json
```

Use only tools returned in `selected_tools`. If the selector is unavailable, fails, or returns no selected tools, continue with the `rg` baseline and direct repository evidence.

For `/aif-architecture`, optional providers are supporting context only:

- `rg` may be used as a safe availability probe and direct repository search baseline.
- Graphify may be read only from existing reviewed outputs in allowed project or change context paths.
- Context7 may be read only from existing reviewed notes in allowed project or change context paths.
- `codex-agent-mem`, `context-mode`, `codex-mem`, `eagle-mem`, and CodeGraph are forbidden for this command.

Do not install providers, run provider setup, index source, sync memory, register MCP servers, start background services, or execute CodeGraph from `/aif-architecture`.

Treat optional provider output as hypotheses or supporting notes. Final architecture guidance must remain grounded in direct repository evidence, resolved AI Factory config, existing canonical OpenSpec artifacts, generated rules, runtime state, QA evidence, or reviewed provider notes from allowed paths.

### Legacy AI Factory-only mode

When OpenSpec-native mode is not enabled, preserve upstream `/aif-architecture` behavior and keep the same project-level write boundaries:

- resolved `paths.architecture`;
- architecture pointer in resolved `paths.description`;
- architecture row in root `AGENTS.md`.

Do not write OpenSpec artifacts, runtime state, QA evidence, generated rules, provider notes, MCP config, provider config, or provider setup files.
