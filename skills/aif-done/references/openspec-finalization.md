# OpenSpec finalization

## OpenSpec-native mode

OpenSpec-native mode runs verified installed-project finalization through `ai-factory aifhub-done-finalizer --change <change-id> --json`. The wrapper resolves the extension-local `scripts/openspec-done-finalizer.mjs` implementation module; never execute that module from the consumer project root or an internal installed path. This remains the only OpenSpec-native archive/finalization step after `/aif-verify` passes.

### Preconditions

- Resolve exactly one active change or explicit `<change-id>`.
- Resolve effective policy through `scripts/openspec-policy.mjs`; `/aif-verify`, `/aif-mode doctor`, and `/aif-done` must use the same policy semantics.
- Read QA evidence from `.ai-factory/qa/<change-id>/`.
- Treat verification as passing only when QA evidence clearly records a final PASS or PASS-with-notes for this change.
- Require the latest final fenced `aif-gate-result` block in `verify.md` to be valid JSON with `"gate": "verify"` and `status` of `pass` or `warn`.
- Require `.ai-factory/qa/<change-id>/coverage.json` to exist, be current, and have coverage status `pass` or policy-accepted `warn`.
- Require generated rules and durable rules gate evidence according to `requireGeneratedRulesForDone` and `requireRulesPassForDone`; generated rules readiness does not satisfy rules gate pass.
- Apply `allowWarnOnDone.rules`, `allowWarnOnDone.coverage`, and `allowWarnOnDone.openspecStatus` before accepting warning-only finalization evidence.
- The installed finalizer must always run its extension-local `scripts/openspec-done-readiness.mjs` implementation module before archive and persist `.ai-factory/qa/<change-id>/done-readiness.json`; do not invoke that module as an installed-project command.
- If verification has not run or verdict is `fail`, stop and suggest `/aif-verify` or `/aif-fix`.
- If the verify gate result is missing, invalid, or `fail`, stop and suggest rerunning `/aif-verify <change-id>` or `/aif-fix <change-id>`.
- If coverage, generated rules, or rules gate evidence is missing, invalid, stale, failed, or warning-only when policy does not allow the warning, stop on the readiness result and show its `suggested_next.command` and `suggested_next.reason` exactly. For rules gate blockers, the command may be the installed durable evidence writer, not `/aif-rules-check` alone.
- If readiness reports a blocking failure, refuse archive and show `suggested_next.command` and `suggested_next.reason` exactly.
- Refuse unverified changes; do not accept `Code verification: PENDING` as final verification.
- Dirty workspace state is blocking by default before archive. Inspect with `git status --short`; commit or stash unrelated changes, or rerun `ai-factory aifhub-done-finalizer --change <change-id> --record-dirty-state --json` to record dirty state in final QA evidence before archive.
- For docs/tooling-only changes that also need explicit dirty-state recording, preserve both flags with `ai-factory aifhub-done-finalizer --change <change-id> --skip-specs --record-dirty-state --json`.

### Canonical Context

Read canonical OpenSpec artifacts:

- `openspec/specs/**`
- `openspec/changes/<change-id>/proposal.md`
- `openspec/changes/<change-id>/design.md`
- `openspec/changes/<change-id>/tasks.md`
- `openspec/changes/<change-id>/specs/**/spec.md`

Read generated rules as derived guidance when present:

- `.ai-factory/rules/generated/openspec-merged-<change-id>.md`
- `.ai-factory/rules/generated/openspec-change-<change-id>.md`
- `.ai-factory/rules/generated/openspec-base.md`

Runtime state and QA evidence live outside canonical changes:

- `.ai-factory/state/<change-id>/`
- `.ai-factory/qa/<change-id>/`, including `verify.md`, `coverage.json`, and `done-readiness.json`
- `.ai-factory/qa/<change-id>/rules.md` when a durable rules gate is required or available

### Archive Policy

- Use `ai-factory aifhub-done-finalizer --change <change-id> --json` as the installed executable route. Add `--skip-specs` only for docs/tooling-only finalization and never add `--force`, `--no-validate`, `--skip-archive`, `--dry-run`, or `--summary-only`.
- Inside the extension implementation only, archive through `archiveOpenSpecChange(changeId, options)` from `scripts/openspec-runner.mjs`; this corresponds to `openspec archive <change-id> --yes`.
- The extension-local implementation uses `archiveOpenSpecChange(changeId)` for normal finalization and `archiveOpenSpecChange(changeId, { skipSpecs: true })` for docs/tooling-only finalization; the latter corresponds to `openspec archive <change-id> --yes --skip-specs --no-color`.
- Support the user-facing `--skip-specs` path while still writing final QA evidence and final summaries.
- If OpenSpec CLI is missing or unsupported and archive is required, fail with an explicit OpenSpec CLI requirement.
- Do not archive in `/aif-verify`; `/aif-verify` does not archive and only records verification evidence.
- Do not use legacy `.ai-factory/specs` archive in OpenSpec-native mode.
- OpenSpec-native mode does not use legacy `.ai-factory/specs` archive.
- Do not silently archive OpenSpec changes through legacy `.ai-factory/specs`.
- Do not write runtime-only output into `openspec/changes/<change-id>/`.
- Do not directly mutate `openspec/specs/**` or manually move OpenSpec change folders.

### OpenSpec-Native Output

Normal output must report:

- selected `change-id`;
- readiness status, blocking checks, and exact suggested next command when blocked;
- verification status and refusal reason when unverified;
- dirty working tree state;
- archive result;
- bounded selected OpenSpec command/source from archive or pre-archive context;
- canonical artifacts inspected;
- generated rules state when relevant;
- effective policy summary and policy-derived finalization blockers;
- runtime state and QA evidence paths;
- final evidence under `.ai-factory/qa/<change-id>/`;
- final summaries under `.ai-factory/state/<change-id>/`;
- commit/PR summary draft;
- compact evolution proposals and next steps: `/aif-mode sync`, `/aif-commit`, and an exact `/aif-evolve` owner handoff for separately requested or policy-required evolution.

### Roadmap Lifecycle Co-Ownership

- After successful OpenSpec archive, `/aif-done` co-owns only the marker-delimited `OpenSpec Change Lifecycle` block in the configured project-relative roadmap; `/aif-roadmap` remains the owner of the full roadmap audit and reconciliation.
- The finalizer uses the canonical pre-archive `## Roadmap Linkage` fields and a project-relative final evidence path to insert or update one local `finalized` row. Explicit `none` linkage produces the local outcome `skipped` without changing the roadmap.
- A readiness, verification, artifact-contract, dirty-tree, or archive failure must not update the roadmap or create a `finalized` row.
- Normal output reports the local roadmap lifecycle outcome `updated`, `skipped`, or `handoff` separately from external GitHub issue, pull request, and milestone state.
- Local finalization must not claim that a GitHub issue is closed or a pull request is merged.
- If a post-archive roadmap update cannot be completed safely, preserve the successful archive and final evidence, return `handoff` with the exact `/aif-roadmap check` guidance, and must not roll back the successful archive or fabricate a `finalized` row.

### Post-Finalization Handoff

After successful finalization:

1. Recommend `/aif-mode sync` to refresh derived artifacts after archive.
2. Recommend `/aif-commit` as the next AI Factory command.
3. Present compact evolution proposals when durable learning evidence exists; optional learning does not start inside finalization. Separately requested or policy-required evolution follows the owner boundary below.
4. Do not create commits automatically.
5. Do not create PRs automatically.
6. `/aif-done` does not replace `/aif-commit`.

