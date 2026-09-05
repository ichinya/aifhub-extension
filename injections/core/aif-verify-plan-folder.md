## AIFHub Verify OpenSpec-native Override

Read [tool selection and artifact ownership](../../skills/shared/TOOLS.md) before choosing artifact paths or lifecycle instructions.

Apply this block before the upstream `aif-verify` body. When this guidance conflicts with the base skill text, this block wins.

Follow `skills/shared/LANGUAGE-POLICY.md` before producing user-facing responses or generated artifacts.

Resolve user-facing prose language in this order: use a usable non-empty `language.ui`; otherwise preserve the current conversation language for this response only; use English only when that language is indeterminate. This rule overrides downstream generic English defaults; do not infer from OS locale or persist the inferred choice. On that hard-English fallback, add exactly one concise setup hint only when the output contract permits human-readable prose, before any required final machine-readable block; never add it inside or after `aif-gate-result`, and never alter exact handoffs, fixed commands, paths, keys/enums, or machine-only output.

### Goal

Use the built-in `/aif-verify` skill as the canonical verification command for OpenSpec-native changes and the extension's legacy companion plan workflow.

### Configured Validation Providers

`aifhub.providers` is independent of `aifhub.tools.openspec`: OpenSpec and HLV may be enabled together. Each provider is opted in by its boolean under `aifhub.tools` (`hlv: true` or `lekalo: true`); false or an omitted tool disables invocation and new evidence writes. Enabled providers default to `policy: required`; `policy: optional` changes failures to nonblocking warnings. After native project gates, before emitting the final verify verdict, run `ai-factory aifhub-providers verify --change <change-or-plan-id> --write --json`. Resolve one safe change/plan ID first. The wrapper is a no-op when no provider is enabled for verify. Apply its normalized `blocking` and provider gate statuses to final verification: required unavailable/unsupported/failed providers block PASS; optional failures produce degraded notes. Provider failures remain separate from implementation/test failures. Retain original diagnostic codes from normalized operations; never copy raw streams into `verify.md`.

Provider QA files are derived evidence under `.ai-factory/qa/<id>/providers/`; no provider output may rewrite OpenSpec, HLV, or Lekalo canonical artifacts. Missing enabled-tool scaffolding is initialized through `ai-factory aifhub-mode init --json` before validation and revision binding, following the shared tool contract. Reuse existing HLV projects without reinit. Never install or update provider binaries or run provider-owned sync automatically. `hlv check` can execute project-configured gates, so it runs only in an explicitly enabled validation phase, never as detection or doctor. Lekalo remains `unsupported` until its versioned provider protocol is published.

For upstream ultra bundles, preserve the bundle and upstream verification ownership. Explicitly configured provider evidence is a separate post-verification overlay: record the upstream receipt first and report a provider blocker separately without rewriting the upstream bundle or its verdict.

### Skill-Context Resolution

Read skill-context in this order:

1. `.ai-factory/skill-context/aif-verify/SKILL.md`
2. `.ai-factory/skill-context/aif-verify-plus/SKILL.md` as legacy compatibility fallback

If both exist, `aif-verify` wins.

### Mode Detection

Before resolving verification scope, read `.ai-factory/config.yaml` when it exists.

- If the config contains `aifhub.tools.openspec: true`, use **OpenSpec-native mode**.
- Otherwise, use **Legacy AI Factory-only mode**.
- If the config is missing, continue with Legacy AI Factory-only mode and state that no OpenSpec-native protocol was detected.

### Legacy ultra marker-first boundary

In Legacy AI Factory-only mode, classify the normalized project-relative plan entrypoint with `classifyLegacyPlanShape()` from `scripts/legacy-plan-migration.mjs` before folder-only detection, companion discovery, companion plan-file creation, verification-file selection, or any `status.yaml`/`verify.md` write. Marker validation is first; known companion filenames are considered only after the classifier returns a classic shape.

- For `ultra-valid`, stop all AIFHub companion logic and return the exact upstream handoff `/aif-verify <entrypoint>`. Upstream owns bundle verification atomically. After upstream verification emits its one final validated `aif-gate-result`, pass that exact structured gate outcome and the normalized entrypoint to `writeLegacyUltraVerificationReceipt()` from `scripts/legacy-ultra-verification-receipt.mjs`. Record both `pass` and non-pass outcomes; the helper binds the receipt to the current bundle, source revision, and deterministic worktree and writes only `.ai-factory/state/legacy-ultra-verification/<entrypoint-digest>.json`. A missing or invalid final gate must not create a receipt.
- The receipt and explicitly configured provider overlay are the only AIFHub writes permitted for `ultra-valid`. Do not create or synchronize a sibling `<plan-id>.md`, `task.md`, `context.md`, `rules.md`, `verify.md`, `status.yaml`, `explore.md`, any OpenSpec artifact, unrelated QA evidence, or finalization artifact. Never edit the ultra bundle while recording the receipt.
- For `ultra-invalid` or `collision`, fail closed before any write and report only bounded `shape`, safe `entrypoint`, and classifier `code` values.
- For `classic-pair` or `classic-folder-only`, continue with the classic companion rules below. An unrelated directory is not a plan.
- Diagnostics may include only `shape`, safe project-relative `entrypoint`, and `handoff`; never include marker bodies, phase contents, request/research bodies, credentials, raw stdout, or raw stderr.

### OpenSpec-native mode

When `.ai-factory/config.yaml` declares `aifhub.tools.openspec: true`, `/aif-verify` verifies implementation against the active OpenSpec change.

For plan content, read only the canonical OpenSpec artifacts listed below. Do not inspect or mutate `.ai-factory/plans/**` after an OpenSpec change resolves.

Before running lint, tests, code review, security review, or rules review, resolve the active change, ensure runtime layout, and use `scripts/openspec-verification-context.mjs` with `scripts/openspec-runner.mjs` when available. Request validation through `validateOpenSpecChange(changeId)` and status through `getOpenSpecStatus(changeId)` from the shared runner. Resolve effective policy through `scripts/openspec-policy.mjs`. Fail invalid OpenSpec artifacts before code checks. Treat missing CLI, generated rules, rules gate evidence, and coverage evidence as degraded warnings unless strict config such as `aifhub.openspec.requireCliForVerify` or the matching verify policy flag requires failure. Use `shouldRunCodeVerification` as the handoff signal: `false` blocks code checks and routes to `/aif-fix <change-id>`; `true` allows normal code verification to continue.

Use shared vocabulary consistently: `OpenSpec-native mode`, `canonical OpenSpec change`, `active change`, `change-id`, `base specs`, `delta specs`, `generated rules`, `runtime state`, `QA evidence`, and `legacy AI Factory-only mode`.

Resolve the active change using `scripts/active-change-resolver.mjs` when available:

- Prefer an explicit `<change-id>` or `@openspec/changes/<change-id>` input when provided.
- Otherwise use `resolveActiveChange` behavior: current working directory, current branch mapping, current pointer, then single active change.
- Treat selected source, candidate list, warnings, and errors as user-visible verification context.
- If an explicit or inferred `<change-id>` cannot be resolved as an OpenSpec change, check for matching legacy AI Factory plan artifacts through `detectMigrationNeed(options)` from `scripts/legacy-plan-migration.mjs` or equivalent read-only detection. If migration is suggested, do not auto-migrate. Show exactly:

```text
Found legacy AI Factory plan artifacts for `<change-id>` but no OpenSpec change at `openspec/changes/<change-id>`.
Run the legacy migration script with:

ai-factory aifhub-migrate-legacy-plans <change-id> --dry-run
ai-factory aifhub-migrate-legacy-plans <change-id>
```

Validate and review against canonical OpenSpec artifacts:

- `openspec/specs/**`
- `openspec/changes/<change-id>/proposal.md`
- `openspec/changes/<change-id>/design.md`
- `openspec/changes/<change-id>/tasks.md`
- `openspec/changes/<change-id>/specs/**/spec.md`

Treat planning source sections as read-only verification context:

- Use `## Original Request` as the raw intent anchor, while canonical specs, design, tasks, and implemented behavior remain the verification contract.
- When `proposal.md` contains `## Research Context`, use the embedded snapshot and source revision as authoritative committed scope.
- For an embedded ultra source, pass its exact project-relative `RESEARCH.md` path to `resolveUltraResearchSource()` from `scripts/ultra-research-resolver.mjs` and consume only its structured `source`, `revision`, and `diagnostic`. This centrally revalidates the sibling marker/index/status/link and normalized Active Summary digest; do not implement local selection or hashing heuristics.
- Compare the exact regular or ultra source only for drift and rationale. Missing/invalid source, changed `Updated`, or changed normalized `SHA256` emits `WARN [research-drift] change-id=<change-id> source=<path> expected=<embedded revision> current=<live revision>` without expanding verification scope. Recency never selects a replacement source.
- Do not mutate or silently rebase either source section. Keep credentials, raw provider output, and full request/research bodies out of QA diagnostics.

#### Roadmap linkage validation

Roadmap linkage validation is read-only in OpenSpec-native mode.

- Read the canonical proposal's standardized `## Roadmap Linkage` fields and, when present, compare them with bounded managed lifecycle evidence from the configured roadmap.
- `/aif-verify` must not edit the configured roadmap, create a managed lifecycle row, or change milestone, phase, or slice state.
- For malformed linkage or lifecycle markers, emit a bounded `WARN [roadmap]` when the condition is non-blocking. Use `ERROR [roadmap]` only when contradictory local evidence or an explicit canonical requirement blocks verification. Include the `change-id`, a bounded reason, and the exact handoff `/aif-roadmap check`.
- Diagnostics must not copy the managed lifecycle block, full proposal body, unrelated roadmap content, credentials, or private provider output.
- Missing linkage alone remains a warning unless a canonical requirement makes linkage mandatory; do not invent issue, milestone, or roadmap assignments to remove the warning.

Read generated rules as derived verification guidance when present:

- `.ai-factory/rules/generated/openspec-merged-<change-id>.md`
- `.ai-factory/rules/generated/openspec-change-<change-id>.md`
- `.ai-factory/rules/generated/openspec-base.md`

Runtime state and QA evidence boundaries:

- Read implementation runtime state from `.ai-factory/state/<change-id>/` when present.
- Write verification findings, verdicts, command results, and review evidence only under `.ai-factory/qa/<change-id>/`.
- Record OpenSpec validation/status evidence under `.ai-factory/qa/<change-id>/` before code verification.
- Build and write the OpenSpec coverage matrix at `.ai-factory/qa/<change-id>/coverage.json` using `scripts/openspec-coverage-matrix.mjs` when available.
- Treat missing requirement coverage as `fail` in strict mode and `warn` in normal mode.
- Read durable rules gate evidence from `.ai-factory/qa/<change-id>/rules.md` when present; generated rules readiness does not satisfy `requireRulesPassForVerify`.
- Do not write QA evidence or runtime-only files into `openspec/changes/<change-id>/`.
- Do not archive. `/aif-verify` records verification evidence only; `/aif-done <change-id>` owns OpenSpec archive/finalization.
- Do not create legacy plan-folder verification artifacts in OpenSpec-native mode.

Normal verification responses should report:

- selected `change-id` and resolver source;
- canonical artifacts inspected;
- generated rules freshness or missing/stale `WARN`;
- effective policy summary and any policy-derived blockers or warnings;
- OpenSpec validation status and `shouldRunCodeVerification`;
- coverage summary and policy result;
- QA evidence path under `.ai-factory/qa/<change-id>/`;
- verdict and finding counts;
- fix guidance `/aif-fix <change-id>` when verification fails;
- optional finalization guidance `/aif-done <change-id>` when verification passes.

Optional read-only gates are available before verification starts: `/aif-rules-check`, `/aif-review`, and `/aif-security-checklist`. The authoritative final verification remains `/aif-verify <change-id>`. This next-step routing is one-way with terminal states: when verification passes, suggest `/aif-done <change-id>` and do not suggest a rerun of `/aif-rules-check` or `/aif-verify`; when verification fails, route to `/aif-fix <change-id>`; the single fail-path exception is a blocking failure caused by missing, stale, or invalid durable rules gate evidence, where the recovery step is rerunning `/aif-rules-check <change-id>` and persisting its final gate block through `ai-factory aifhub-write-gate-evidence` — this exception is prose guidance and is never encoded into the machine-readable `suggested_next` field; do not suggest `/aif-rules-check` as remediation for implementation findings after verification has already run. The final `aif-gate-result` block keeps `suggested_next` `null` when `status` is `pass`; the `/aif-done <change-id>` suggestion stays in prose, never inside the gate result block.

End verification output and `.ai-factory/qa/<change-id>/verify.md` with exactly one final fenced `aif-gate-result` JSON block using `"gate": "verify"` and lowercase JSON `status`: `pass`, `warn`, or `fail`. Use `fail` for blocking OpenSpec validation, coverage, generated-rules, test, lint, build, review, security, or rules failures; use `warn` only for non-blocking notes after verification completes.

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
