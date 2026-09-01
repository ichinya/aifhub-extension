## AIFHub Review Context Provider Override

Apply this block before the upstream `aif-review` body. When any rule below conflicts with the base skill text, this block wins.

Follow `skills/shared/LANGUAGE-POLICY.md` before producing user-facing responses or generated artifacts.

Resolve user-facing prose language in this order: use a usable non-empty `language.ui`; otherwise preserve the current conversation language for this response only; use English only when that language is indeterminate. This rule overrides downstream generic English defaults; do not infer from OS locale or persist the inferred choice. On that hard-English fallback, add exactly one concise setup hint only when the output contract permits human-readable prose, before any required final machine-readable block; never add it inside or after `aif-gate-result`, and never alter exact handoffs, fixed commands, paths, keys/enums, or machine-only output.

### Goal

Keep `/aif-review` read-only while allowing optional, user-owned provider context for version-sensitive library/API review.

### Mode Detection

Before resolving review scope, read `.ai-factory/config.yaml` when it exists.

- If the config contains `aifhub.artifactProtocol: openspec`, use **OpenSpec-native mode**.
- Otherwise, use **Legacy AI Factory-only mode**.
- If the config is missing, continue with Legacy AI Factory-only mode and state that no OpenSpec-native protocol was detected.

### OpenSpec-native mode

When `.ai-factory/config.yaml` declares `aifhub.artifactProtocol: openspec`, `/aif-review` is an optional read-only gate for one active OpenSpec change.

Read context may include:

- changed files;
- canonical OpenSpec artifacts under `openspec/specs/**` and `openspec/changes/<change-id>/`;
- generated rules under `.ai-factory/rules/generated/` when present;
- runtime state under `.ai-factory/state/<change-id>/` when relevant;
- QA evidence under `.ai-factory/qa/<change-id>/` when relevant;
- reviewed Context7 notes under `.ai-factory/references/context7/` and `.ai-factory/state/<change-id>/context7/`;
- reviewed Graphify outputs under `.ai-factory/references/graphify/` and `.ai-factory/state/<change-id>/graphify/` when dependency or impact review benefits from them.

Context7 guidance:

- Context7 is optional supporting documentation context for current library/API docs.
- `/aif-review` may recommend that the user run Context7 manually outside AIFHub command ownership with commands such as `npx ctx7 library <name> <query>` and `npx ctx7 docs <libraryId> <query>`, or user-installed equivalents `ctx7 library <name> <query>` and `ctx7 docs <libraryId> <query>`.
- Missing Context7, missing Node.js runtime support, missing provider access, or missing reviewed notes is degraded context, not a review failure.
- If the user already configured Context7 MCP, available tools may include `resolve-library-id` plus a docs retrieval tool named `get-library-docs` or `query-docs`; use them only as optional read-only documentation context.
- Do not install `ctx7` or `@upstash/context7-mcp`, run `ctx7`, run `ctx7 setup`, add Context7 dependencies or manifest entries, add Context7 MCP templates to `extension.json`, mutate `.mcp.json`, `.cursor/mcp.json`, `.opencode.json`, agent rules, or agent skills, or start/register Context7 MCP automatically.
- Treat Context7 output as supporting context only. Findings must be source-grounded in changed files, canonical OpenSpec artifacts, generated rules, runtime state, QA evidence, package files in the repository, or other direct repository evidence.
- Do not store raw Context7 output, MCP transcripts, API responses, setup output, or generated provider configuration under `openspec/changes/<change-id>/`, `openspec/specs/`, `.ai-factory/rules/generated/`, or `.ai-factory/qa/<change-id>/`.
- Do not persist `CONTEXT7_API_KEY`, API keys, tokens, raw authorization headers, credential helper output, private provider diagnostics, private backend diagnostics, or unreviewed sensitive output in `.ai-factory/`, `openspec/`, docs, runtime state, QA evidence, generated rules, or Context7 reference copies.

Write boundaries:

- Do not edit files.
- Do not write OpenSpec artifacts, runtime state, QA evidence, generated rules, provider notes, MCP config, provider config, or provider setup files.
- Return the review result in the response only unless the user explicitly pipes or saves it with another command.

### Legacy AI Factory-only mode

When OpenSpec-native mode is not enabled, preserve upstream review behavior and keep the command read-only.

- Review only the changed scope and legacy plan context that already exists.
- Context7 remains optional supporting documentation context; missing Context7 is degraded context, not a review failure.
- The same user-owned Context7 boundaries apply: no install, no `ctx7`, no `ctx7 setup`, no MCP mutation, no automatic MCP registration, no provider templates, and no file edits.
- Findings must still be grounded in changed files, existing project artifacts, tests, or other direct repository evidence.

### Output

- Start with findings ordered by severity.
- Include provider context in evidence only when it materially influenced a finding.
- If Context7 or Graphify was unavailable or not used, mention it only when relevant to residual risk.
- End with the upstream `aif-gate-result` contract for `/aif-review`.
