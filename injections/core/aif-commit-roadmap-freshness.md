## AIFHub Commit Roadmap Freshness Gate

Apply this extension guidance before the base `aif-commit` instructions. When any rule below conflicts with the upstream body, this block only wins for AIFHub roadmap/GitHub freshness boundaries; it does not override upstream commit ownership or `## Commit Plan` grouping.

Follow `skills/shared/LANGUAGE-POLICY.md` before producing user-facing warnings, questions, or commit summaries. Commands, file paths, code identifiers, JSON keys, and YAML keys remain in English.

### Goal

Treat `/aif-commit` as the final read-only freshness check before creating a git commit. It must classify deterministic local lifecycle drift separately from volatile external drift, report labeled `WARN`/`ERROR` findings, and preserve the upstream commit message and confirmation flow when no blocking local contradiction exists.

### Required first read

Read `.ai-factory/config.yaml` first when it exists. Use it to resolve:

- `language.ui`
- `paths.plan`
- `paths.plans`
- `paths.roadmap`
- `workflow.plan_id_format`
- `aifhub.artifactProtocol`
- OpenSpec-native policy flags
- `git.enabled`
- `git.create_branches`
- git preferences consumed by upstream `/aif-commit`

If `.ai-factory/config.yaml` is missing, do not fabricate OpenSpec context. Emit a missing-config `WARN`, preserve upstream `/aif-commit` behavior, and use read-only roadmap warnings only when local files make them obvious.

### Mode Selection

#### OpenSpec-native mode

Use this mode only when `.ai-factory/config.yaml` declares `aifhub.artifactProtocol: openspec`.

Read-only freshness inputs may include:

- staged changes and current diff
- `.ai-factory/ROADMAP.md` or the roadmap path resolved from config
- `.ai-factory/qa/<change-id>/done.md`
- `.ai-factory/qa/<change-id>/openspec-archive.json`
- `.ai-factory/state/<change-id>/final-summary.md`
- `openspec/changes/<change-id>/tasks.md` as active plan context that may contain `## Commit Plan`
- `openspec/specs/**`
- `openspec/changes/archive/**`
- OpenSpec archive/spec changes produced by `/aif-done`
- optional GitHub issue, PR, milestone, label, linked branch, and current git tree state

If no active change/plan resolves, preserve upstream staged-diff behavior.

Do not require live GitHub access. Missing, unauthenticated, rate-limited, offline, or partial GitHub evidence is non-blocking unless the user explicitly requested strict checking.

#### Legacy AI Factory-only mode

Use this mode when `.ai-factory/config.yaml` exists and OpenSpec-native mode is not enabled.

Preserve upstream `/aif-commit` behavior. Read staged changes, current diff, resolved roadmap path, resolved rules/description/architecture context, and legacy `.ai-factory/plans/<plan-id>/` evidence when it is directly relevant. Do not require OpenSpec artifacts in this mode.

#### Missing config mode

When `.ai-factory/config.yaml` is missing, preserve upstream `/aif-commit` behavior and do not fabricate OpenSpec context, change IDs, archive paths, QA paths, or GitHub milestone assignments.

### Upstream Commit Plan Grouping

Generic `## Commit Plan` grouping is parent-owned by upstream AI Factory 2.13+.

When upstream `/aif-commit` detects an active `## Commit Plan`, preserve the upstream grouping prompt and only add roadmap/GitHub freshness findings before the commit proposal.

This overlay must not rewrite active plans, must not create commits itself, must not force a single commit, and must not remove or contradict upstream options:

- `Follow Commit Plan`
- `Commit everything together`
- `Adjust grouping`

### Freshness Findings

Report context gate findings before proposing the commit message:

- `ERROR [roadmap-local]`: deterministic local lifecycle drift proves that successful finalization and the managed roadmap lifecycle state contradict each other.
- `WARN [roadmap-local]`: a local freshness hint is incomplete or stale but does not satisfy the blocking contradiction below.
- `WARN [roadmap-external]`: volatile external drift is unavailable, partial, stale, or may have changed after it was read.
- `ERROR [roadmap-external]`: the user explicitly requested strict external checking and required external evidence cannot be checked or is stale.

#### Blocking deterministic local drift

Emit the unskippable `ERROR [roadmap-local]` only when all of these durable local facts are established for the same change:

1. Local done/archive evidence records successful `/aif-done` or otherwise proves successful local finalization.
2. The canonical or archived proposal contains `## Roadmap Linkage` with a managed linkage value other than `none`.
3. The managed `OpenSpec Change Lifecycle` row is missing, malformed, or not exactly `finalized`.

Do not infer successful local finalization from checked tasks, staged path names, implementation evidence, or GitHub issue/PR closure or merge state alone. The local gate does not depend on explicit strict checking and still applies when GitHub evidence is unavailable.

For `ERROR [roadmap-local]`:

- include the exact `/aif-roadmap check` handoff
- stop before the commit proposal or confirmation flow
- state that user confirmation MUST NOT bypass the error
- the overlay and upstream workflow must not create a git commit

#### Volatile external drift

Unavailable, partial, or later-changing GitHub evidence remains warning-only by default and is reported as `WARN [roadmap-external]`. This includes missing, unauthenticated, rate-limited, or offline access and GitHub state changed after the local snapshot, commit, or merge.

`/aif-commit` has no implicit strict mode for volatile external evidence. Continue to the upstream confirmation flow after `WARN [roadmap-external]` unless the user requested strict external checking or asks to stop. Explicit strict external checking may promote that external finding to `ERROR [roadmap-external]`; it never controls or suppresses `ERROR [roadmap-local]`.

Detect stale roadmap state when material:

- closed GitHub milestone exists but `.ai-factory/ROADMAP.md` has no matching phase audit
- open GitHub milestone has `open_issues = 0` but roadmap lacks `phase-completion drift`
- staged or finalized work links to an issue/PR/milestone that is missing from the roadmap
- issue/PR has no milestone and the roadmap lacks `unphased backlog/drift`
- OpenSpec archive/spec changes or finalization evidence are staged but roadmap freshness does not mention the affected phase, slice, or issue
- local implementation evidence exists but GitHub or roadmap linkage is stale

For every stale roadmap finding, include this exact handoff:

```text
/aif-roadmap check
```

If the finding is specific, include the reason next to the handoff, for example: `Run /aif-roadmap check to refresh the milestone phase audit before committing.`

### Ownership Boundaries

This overlay is read-only except for the git commit created by upstream `/aif-commit` after user confirmation.

It must not edit `.ai-factory/ROADMAP.md`.

It must not write:

- `.ai-factory/state/<change-id>/`
- `.ai-factory/qa/<change-id>/`
- `.ai-factory/rules/generated/**`
- `openspec/changes/**`
- `openspec/specs/**`
- runtime traces
- QA evidence
- generated rules
- canonical OpenSpec artifacts
- GitHub issues, milestones, PRs, labels, or linked branches

It must not write tokens, authorization headers, raw credential helper output, or private authentication diagnostics into user-facing output or commit messages.

### Output Contract

- State selected mode: `OpenSpec-native mode`, `Legacy AI Factory-only mode`, or `Missing config mode`.
- State whether GitHub milestone evidence was used, unavailable, or partial when GitHub context is relevant.
- Keep warnings in `language.ui`; keep command names and paths in English.
- Keep the upstream conventional commit message flow unchanged.
- Do not automatically run `/aif-roadmap check`; only report the exact `/aif-roadmap check` handoff.
- Do not add AI co-author trailers.
