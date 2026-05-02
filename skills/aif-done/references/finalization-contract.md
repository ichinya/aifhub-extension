# Finalization Contract

Reference for the `aif-done` skill and `aifhub-done-finalizer` agents.

## OpenSpec-native mode

### Entry Conditions

- `.ai-factory/config.yaml` has `aifhub.artifactProtocol: openspec`.
- Exactly one active change or explicit `<change-id>` is selected.
- QA evidence exists under `.ai-factory/qa/<change-id>/`.
- Verification evidence clearly records final PASS or PASS-with-notes for this change.
- The latest final fenced `aif-gate-result` block in `verify.md` is valid JSON with `"gate": "verify"` and `status` of `pass` or `warn`.
- OpenSpec-native `/aif-done` refuses unverified changes.
- Missing, invalid, or failed verify gate results refuse finalization and require `/aif-verify` or `/aif-fix`.
- `Code verification: PENDING` is ambiguous and must refuse finalization.
- Dirty working tree state is empty, or explicit dirty-state recording is enabled.

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
```

### Archive Policy

OpenSpec-native `/aif-done` uses `scripts/openspec-done-finalizer.mjs`. Archive lifecycle mutation must happen through `archiveOpenSpecChange(changeId, options)` and never through custom folder movement or direct `openspec/specs` edits. Normal archive is `openspec archive <change-id> --yes`.

Normal archival corresponds to:

```bash
openspec archive <change-id> --yes
```

Docs/tooling-only archival uses `--skip-specs`:

```bash
openspec archive <change-id> --yes --skip-specs --no-color
```

`--skip-specs` still writes final QA evidence and final summaries. Missing or unsupported OpenSpec CLI fails when archive is required. `/aif-verify` does not archive.

OpenSpec-native mode does not use legacy `.ai-factory/specs` archive.

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

Report selected `change-id`, verification status, dirty working tree state, QA evidence path, `.ai-factory/qa/<change-id>/` final evidence path, `.ai-factory/state/<change-id>/` final summary path, canonical artifacts inspected, generated rules state, archive result, `--skip-specs` state, commit draft, PR draft, and next steps: `/aif-mode sync`, `/aif-commit`, and optional `/aif-evolve`.

After successful finalization:

1. Recommend `/aif-mode sync` to refresh derived artifacts after archive.
2. Recommend `/aif-commit` as the next AI Factory command.
3. Optionally recommend `/aif-evolve` when durable learning evidence exists.
4. Do not create commits automatically.
5. Do not create PRs automatically.
6. `/aif-done` does not replace `/aif-commit`.

## Legacy AI Factory-only mode

## Entry Conditions

- `status.yaml` exists in the active plan folder.
- `verification.verdict` is `pass` or `pass-with-notes`.
- No uncommitted changes outside plan scope (user must confirm if present).

## Archival Structure

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
| Workspace dirty outside plan scope | Stop, ask user to confirm |
| Archive already exists | Refresh archive/spec/index outputs; do not fail |
| `gh` not available | Output manual PR instructions instead of failing |
| Specs directory missing | Create `.ai-factory/specs/` and `index.yaml` |
