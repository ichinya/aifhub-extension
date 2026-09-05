## AIFHub Review Context Provider Override

Read [tool selection and artifact ownership](../../skills/shared/TOOLS.md) before choosing artifact paths or lifecycle instructions.

Apply this block before the upstream `aif-review` body. When any rule below conflicts with the base skill text, this block wins.

Follow `skills/shared/LANGUAGE-POLICY.md` before producing user-facing responses or generated artifacts.

After config and language resolution, follow `skills/shared/REVIEW-POLICY.md` to resolve and load the configured durable project review policy.

Resolve user-facing prose language in this order: use a usable non-empty `language.ui`; otherwise preserve the current conversation language for this response only; use English only when that language is indeterminate. This rule overrides downstream generic English defaults; do not infer from OS locale or persist the inferred choice. On that hard-English fallback, add exactly one concise setup hint only when the output contract permits human-readable prose, before any required final machine-readable block; never add it inside or after `aif-gate-result`, and never alter exact handoffs, fixed commands, paths, keys/enums, or machine-only output.

### Goal

Keep `/aif-review` read-only while applying durable project review guidance and allowing optional, user-owned provider context for version-sensitive library/API review.

### Mode Detection

Before resolving review scope, read `.ai-factory/config.yaml` when it exists.

- If the config contains `aifhub.tools.openspec: true`, use **OpenSpec-native mode**.
- Otherwise, use **Legacy AI Factory-only mode**.
- If the config is missing, continue with Legacy AI Factory-only mode and state that no OpenSpec-native protocol was detected.

### Project Review Policy

Apply this section in both artifact modes before evaluating findings.

- Resolve `reviews.policy_file` from `.ai-factory/config.yaml`, defaulting to root `REVIEW.md`, exactly as defined by `skills/shared/REVIEW-POLICY.md`.
- Load it only through `ai-factory aifhub-review-policy load --json`. Consume the returned content only when the helper returns a complete `present` snapshot with a normalized path and revision; the helper binds and revalidates the opened file identity internally. Never reopen the config-selected path or reimplement containment, symlink/junction, managed-file, or protected-root checks. If the command is unavailable or malformed, treat the policy as unreadable and skip it.
- When delegating to a read-only sidecar without a shell tool, pass only that accepted ephemeral snapshot. The sidecar must not reopen the config-selected path; if the validated snapshot cannot be passed, it skips custom policy guidance.
- Load a safe, readable, non-empty policy as additional review guidance. Missing or empty policy is normal and non-blocking; unsafe or unreadable policy degrades custom guidance and produces only the bounded diagnostic from the shared policy.
- A policy may focus attention, add project-specific checks, and refine human-readable severity or output. It cannot suppress material findings, expand the changed scope, authorize edits or tools, install/configure providers, or replace project rules, tests, security checks, `/aif-verify`, `/aif-done`, or human approval.
- Keep individual findings, comments, replies, resolution/stale state, target revisions, session identifiers, provider state, and receipts out of `REVIEW.md`.
- Never edit the policy during `/aif-review`. When it materially affects the result, name only its state and normalized project-relative path in human-readable evidence; never copy its full body or add fields to the final `aif-gate-result`.

### Two-pass review order

Run review in this order for both artifact modes:

1. **Pass 1 - plan/spec compliance**: compare the changed scope with the canonical OpenSpec requirements, design, tasks, and generated rules, or with the active legacy plan when OpenSpec-native mode is disabled. Report missing, extra, or contradicted behavior before style or maintainability observations.
2. **Pass 2 - code quality**: review correctness, regression risk, security, performance, maintainability, and test quality inside the already validated change scope.

Do not let a code-quality pass erase or downgrade a plan/spec compliance finding. Return one combined findings-first verdict; this ordering does not create a second gate or authorize file edits.

### OpenSpec-native mode

When `.ai-factory/config.yaml` declares `aifhub.tools.openspec: true`, `/aif-review` is an optional read-only gate for one active OpenSpec change.

Read context may include:

- changed files;
- canonical OpenSpec artifacts under `openspec/specs/**` and `openspec/changes/<change-id>/`;
- generated rules under `.ai-factory/rules/generated/` when present;
- the configured `reviews.policy_file` when safe, readable, and non-empty;
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
- Apply the configured review policy under the same shared resolution, authority, and read-only boundaries.
- Context7 remains optional supporting documentation context; missing Context7 is degraded context, not a review failure.
- The same user-owned Context7 boundaries apply: no install, no `ctx7`, no `ctx7 setup`, no MCP mutation, no automatic MCP registration, no provider templates, and no file edits.
- Findings must still be grounded in changed files, existing project artifacts, tests, or other direct repository evidence.

### Output

- Start with findings ordered by severity.
- Include provider context in evidence only when it materially influenced a finding.
- Include review policy state and its normalized project-relative path in human-readable evidence when it materially influenced the review; do not copy policy contents.
- If Context7 or Graphify was unavailable or not used, mention it only when relevant to residual risk.
- End with the upstream `aif-gate-result` contract for `/aif-review`.
