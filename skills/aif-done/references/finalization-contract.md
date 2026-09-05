# Finalization Contract

Read [tool selection and artifact ownership](../../shared/TOOLS.md) before choosing artifact paths or lifecycle instructions.

Reference for the `aif-done` skill and `aifhub-done-finalizer` agents.

## OpenSpec-native mode

### Entry Conditions

- `.ai-factory/config.yaml` has `aifhub.tools.openspec: true`.
- Exactly one active change or explicit `<change-id>` is selected.
- Effective OpenSpec policy is resolved through `scripts/openspec-policy.mjs`.
- QA evidence exists under `.ai-factory/qa/<change-id>/`.
- Verification evidence clearly records final PASS or PASS-with-notes for this change.
- The latest final fenced `aif-gate-result` block in `verify.md` is valid JSON with `"gate": "verify"` and `status` of `pass` or `warn`.
- `.ai-factory/qa/<change-id>/coverage.json` exists, is current, and has coverage status `pass` or policy-accepted `warn`.
- Generated OpenSpec rules satisfy `requireGeneratedRulesForDone`.
- Durable rules gate evidence, normally `.ai-factory/qa/<change-id>/rules.md`, satisfies `requireRulesPassForDone`.
- Warning-only rules, coverage, and OpenSpec status evidence is accepted only when the matching `allowWarnOnDone` flag is true.
- OpenSpec-native `/aif-done` refuses unverified changes.
- Missing, invalid, or failed verify gate results refuse finalization and require `/aif-verify` or `/aif-fix`.
- Missing, invalid, stale, or failed coverage refuses finalization and requires `/aif-verify`.
- Missing, invalid, stale, failed, or disallowed warning rules gate evidence refuses finalization when policy requires rules pass.
- `Code verification: PENDING` is ambiguous and must refuse finalization.
- Dirty workspace state is empty, or explicit dirty-state recording is enabled through `ai-factory aifhub-done-finalizer --change <change-id> --record-dirty-state --json`.

### Canonical Context

Read:

```text
openspec/specs/**
openspec/changes/<change-id>/proposal.md
openspec/changes/<change-id>/design.md
openspec/changes/<change-id>/tasks.md
openspec/changes/<change-id>/specs/**/spec.md
.ai-factory/rules/generated/openspec-merged-<change-id>.md
.ai-factory/rules/generated/openspec-change-<change-id>.md
.ai-factory/rules/generated/openspec-base.md
.ai-factory/state/<change-id>/
.ai-factory/qa/<change-id>/
.ai-factory/qa/<change-id>/coverage.json
.ai-factory/qa/<change-id>/rules.md
```

### Archive Policy

The installed executable route is `ai-factory aifhub-done-finalizer --change <change-id> --json`. It resolves the extension-local `scripts/openspec-done-finalizer.mjs` implementation module and must not require a consumer-root copy or an internal installed-path command. Archive lifecycle mutation inside the extension must happen through `archiveOpenSpecChange(changeId, options)` from `scripts/openspec-runner.mjs` and never through custom folder movement or direct `openspec/specs` edits.

Omitting `--change` delegates to the active-change resolver: exactly one resolvable active change may be selected, while missing or ambiguous scope exits with code `2` before finalization. Automation must always pass an explicit `--change <change-id>`.

Normal installed finalization:

```bash
ai-factory aifhub-done-finalizer --change <change-id> --json
```

Docs/tooling-only archival uses `--skip-specs`:

```bash
ai-factory aifhub-done-finalizer --change <change-id> --skip-specs --json
```

The extension-local implementation maps those commands to `openspec archive <change-id> --yes` or `openspec archive <change-id> --yes --skip-specs --no-color`. `--skip-specs` still writes final QA evidence and final summaries. Missing or unsupported OpenSpec CLI fails when archive is required. `/aif-verify` does not archive. Public finalization rejects `--force`, `--no-validate`, `--skip-archive`, `--dry-run`, `--summary-only`, and unknown options before calling the finalizer API.

Dirty workspace state is blocking by default. Inspect with `git status --short`; commit or stash unrelated changes, or rerun `ai-factory aifhub-done-finalizer --change <change-id> --record-dirty-state --json` to record dirty state in final QA evidence before archive. For docs/tooling-only changes, combine the public flags as `ai-factory aifhub-done-finalizer --change <change-id> --skip-specs --record-dirty-state --json`.

OpenSpec-native mode does not use legacy `.ai-factory/specs` archive.

### Roadmap Lifecycle Co-Ownership

- After successful OpenSpec archive, `/aif-done` co-owns only the marker-delimited `OpenSpec Change Lifecycle` block in the configured project-relative roadmap; `/aif-roadmap` remains the owner of the full roadmap audit and reconciliation.
- The finalizer uses the canonical pre-archive `## Roadmap Linkage` fields and a project-relative final evidence path to insert or update one local `finalized` row. Explicit `none` linkage produces the local outcome `skipped` without changing the roadmap.
- A readiness, verification, artifact-contract, dirty-tree, or archive failure must not update the roadmap or create a `finalized` row.
- Normal output reports the local roadmap lifecycle outcome `updated`, `skipped`, or `handoff` separately from external GitHub issue, pull request, and milestone state.
- Local finalization must not claim that a GitHub issue is closed or a pull request is merged.
- If a post-archive roadmap update cannot be completed safely, preserve the successful archive and final evidence, return `handoff` with the exact `/aif-roadmap check` guidance, and must not roll back the successful archive or fabricate a `finalized` row.

### Final Evidence

Write:

```text
.ai-factory/qa/<change-id>/done.md
.ai-factory/qa/<change-id>/openspec-archive.json
.ai-factory/qa/<change-id>/raw/openspec-archive.stdout
.ai-factory/qa/<change-id>/raw/openspec-archive.stderr
.ai-factory/state/<change-id>/final-summary.md
```

Do not write runtime-only files into `openspec/changes/<change-id>/`.

### Output

Report selected `change-id`, effective policy summary, verification status, coverage matrix status, rules gate status, dirty working tree state, QA evidence path, `.ai-factory/qa/<change-id>/` final evidence path, `.ai-factory/state/<change-id>/` final summary path, canonical artifacts inspected, generated rules state, archive result, bounded OpenSpec command/source, `--skip-specs` state, commit draft, PR draft, and next steps: `/aif-mode sync`, `/aif-commit`, and optional `/aif-evolve`.

Command exit codes are `0` for successful or policy-accepted warning finalization, `1` for a resolved blocking failure, and `2` for invalid arguments, unresolved or ambiguous scope, or an unexpected command failure.

After successful finalization:

1. Recommend `/aif-mode sync` to refresh derived artifacts after archive.
2. Recommend `/aif-commit` as the next AI Factory command.
3. Optionally recommend `/aif-evolve` when durable learning evidence exists.
4. Do not create commits automatically.
5. Do not create PRs automatically.
6. `/aif-done` does not replace `/aif-commit`.

## Legacy AI Factory-only mode

### Marker-first legacy ultra contract

Legacy mode must classify the normalized project-relative entrypoint before classic companion discovery or any write. A valid marker-bearing AI Factory 2.18 ultra plan is one atomic upstream bundle rooted at `<entrypoint>/index.md`; it is not a folder-only classic plan and must not be migrated or paired with `<plan-id>.md`.

For `ultra-valid`, `/aif-verify <entrypoint>` is the only receipt writer. After upstream verification produces exactly one final valid `aif-gate-result`, it writes:

```text
.ai-factory/state/legacy-ultra-verification/<entrypoint-digest>.json
```

The receipt schema is:

```json
{
  "schemaVersion": 1,
  "entrypoint": ".ai-factory/plans/<plan-id>/index.md",
  "entrypointDigest": "<lowercase SHA256>",
  "bundleDigest": "<lowercase SHA256>",
  "sourceRevision": { "kind": "git-head", "value": "<HEAD>" },
  "worktreeDigest": "<lowercase SHA256>",
  "verifiedAt": "<ISO-8601 timestamp>",
  "sourceCommand": "/aif-verify .ai-factory/plans/<plan-id>/index.md",
  "gateOutcome": { "gate": "verify", "status": "pass", "blockers": [], "affected_files": [], "suggested_next": null }
}
```

`sourceRevision.kind` is `git-head` in a Git workspace and `manual-build-id` only for a non-Git workspace with an explicit bounded build id. The stored `gateOutcome` is the exact structured final upstream gate and may record `pass`, `warn`, or `fail`; only exact `pass` is finalization-ready.

#### Binding algorithm

- Normalize a directory or `index.md` input to one safe project-relative `<bundle>/index.md`. `entrypointDigest` is SHA256 of that normalized UTF-8 string without an added newline.
- Build the bundle manifest from `index.md` plus its direct validated `phase-*.md` files, sorted by normalized project-relative path. Each JSONL row is `[path,type,sha]`; files hash current bytes, symlinks hash their link target, and the manifest ends with one newline. `bundleDigest` is SHA256 of the full manifest bytes.
- In Git, obtain candidates only with `git ls-files --cached --others --exclude-standard -z`, resolve the revision with `git rev-parse --verify HEAD`, normalize and sort paths, and hash the same JSONL row format. A deleted tracked path remains a row `[path,"missing",null]`.
- Exclude `.git/**`, `.ai-factory/state/**`, `.ai-factory/qa/**`, `.ai-factory/rules/generated/**`, and the ultra bundle itself from the worktree manifest. This prevents the receipt and derived evidence from invalidating themselves while binding all tracked and non-ignored untracked code/content outside the bundle.
- In a non-Git workspace, deterministically enumerate non-excluded files and bind them to the caller-supplied `manual-build-id`.
- `worktreeDigest` is SHA256 of the sorted worktree JSONL manifest bytes. Do not use mtimes, directory iteration order, conversational state, or recency.

#### `/aif-done` decision

`/aif-done` calls `evaluateLegacyUltraVerificationReceipt()` and recomputes every binding. A missing/invalid receipt, wrong entrypoint, stale bundle, wrong `HEAD` or manual build id, stale worktree, non-`pass` gate, or any binding failure returns exactly `/aif-verify <entrypoint>`. A current exact PASS receipt returns exactly `/aif-archive <entrypoint>`.

This branch is read-only: `/aif-done` returns the handoff but does not execute it and does not write the bundle, a classic companion, OpenSpec artifacts, `status.yaml`, QA evidence, final summaries, specs archives/indexes, or receipts. `ultra-invalid` and `collision` fail closed without classic fallback.

### Classic entry conditions

- `status.yaml` exists in the active plan folder.
- `verification.verdict` is `pass` or `pass-with-notes`.
- No uncommitted changes outside plan scope (user must confirm if present).

### Classic archival structure

```text
.ai-factory/specs/<plan-id>/
  |- plan.md          # companion plan file archived from .ai-factory/plans/<plan-id>.md
  |- spec.md          # implementation summary (if applicable)
  |- task.md          # completed task checklist
  |- verify.md        # verification findings
  `- ...              # other plan-folder artifacts (excluding status.yaml execution metadata)
```

If the archive directory already exists from an earlier `/aif-done` run or legacy `/aif-verify` auto-archive behavior, treat finalization as a refresh pass and update the archived artifacts instead of failing.

## Specs Index Format

`.ai-factory/specs/index.yaml`:

```yaml
specs:
  - id: <plan-id>
    title: "<plan title>"
    archived_at: <ISO timestamp>
    verification: pass|pass-with-notes
    source_branch: <branch name or null>
```

## Commit Message Format

Conventional commit based on plan scope:

```text
<type>(<scope>): <summary>

<body — what was implemented, referencing plan artifacts>
```

- `type` inferred from plan title/context (feat, fix, refactor, docs, chore).
- `scope` from plan-id or plan title.
- `body` summarizes key implementation points from the plan.

## PR Summary Format

```markdown
## Summary
- <bullet points from plan scope>

## Plan Reference
- Plan: `<plan-id>`
- Verification: <verdict>

## Test Plan
- [ ] <suggested verification steps based on plan scope>
```

## Governance and Evolution Follow-ups

Apply only when the verified plan contains evidence:

| Evidence | Finalization Action |
|----------|--------------------|
| Roadmap milestone referenced and completed | Update roadmap through the roadmap owner or return an exact `/aif-roadmap` handoff |
| New architecture pattern or module introduced | Update architecture through the architecture owner or return an exact `/aif-architecture` handoff |
| New coding rules or conventions established | Update the project rules owner path or return an exact rules handoff |
| Evolution candidates identified | Run `/aif-evolve` when explicitly requested and supported, otherwise recommend it |

Never invent governance changes without plan evidence. If the current runtime cannot safely perform the owning update, return the exact next command/instruction instead of silently skipping it.

OpenSpec-native `/aif-done` prepares commit and PR drafts only. It does not create commits, does not create PRs, and does not replace `/aif-commit`.

## Status Update on Finalization

```yaml
status: done
verification:
  verdict: <preserved from verify>
finalization:
  archived_at: <ISO timestamp>
  archive_path: .ai-factory/specs/<plan-id>/
  commit_message_draft: |
    <draft>
  pr_summary_draft: |
    <draft>
  governance_updates:
    roadmap: <updated|handoff|skip>
    rules: <updated|handoff|skip>
    architecture: <updated|handoff|skip>
  evolve_action: <ran|suggested|skip>
```

## Error Handling

| Condition | Behavior |
|-----------|----------|
| No active plan found | Stop with guidance to select a plan |
| Verification not run / verdict missing | Stop, suggest `/aif-verify` |
| Verification failed (`fail`) | Stop, suggest `/aif-fix` then `/aif-verify` |
| Coverage missing, stale, invalid, or failed | Stop, suggest `/aif-verify` |
| Generated rules missing or stale when required | Stop, suggest `/aif-mode sync --change <change-id>` |
| Rules gate missing, invalid, failed, or disallowed warning when required | Stop, suggest `/aif-rules-check` and persist the final rules gate result under QA evidence |
| Workspace dirty outside plan scope | Stop, ask user to confirm |
| Archive already exists | Refresh archive/spec/index outputs; do not fail |
| `gh` not available | Output manual PR instructions instead of failing |
| Specs directory missing | Create `.ai-factory/specs/` and `index.yaml` |
