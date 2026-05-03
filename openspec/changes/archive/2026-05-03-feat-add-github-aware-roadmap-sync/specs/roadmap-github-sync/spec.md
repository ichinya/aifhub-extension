# Delta for Roadmap GitHub Sync

## ADDED Requirements

### Requirement: Roadmap audit uses GitHub as supporting evidence when available

`/aif-roadmap` MUST be able to include GitHub milestones, issues, PRs, labels, linked branches, and local git tree state in the roadmap audit evidence set when that context is available.

#### Scenario: GitHub evidence is available

- GIVEN the repository has GitHub context from `gh`, a connector, explicit issue/PR URLs, or caller-provided metadata
- WHEN `/aif-roadmap` creates or refreshes `.ai-factory/ROADMAP.md`
- THEN the audit may reference relevant GitHub milestones, issues, PRs, labels, and linked branches
- AND the normal response summarizes that GitHub evidence was used.

#### Scenario: GitHub evidence is unavailable

- GIVEN GitHub context is not available in the current runtime
- WHEN `/aif-roadmap` creates or refreshes `.ai-factory/ROADMAP.md`
- THEN roadmap generation continues from local repository evidence
- AND the normal response states that GitHub evidence was unavailable or skipped.

#### Scenario: GitHub evidence is partially available

- GIVEN some GitHub context is available
- AND other requested GitHub data is missing, rate-limited, unauthenticated, or otherwise unavailable
- WHEN `/aif-roadmap` creates or refreshes `.ai-factory/ROADMAP.md`
- THEN roadmap generation continues with the available GitHub and local evidence
- AND the normal response summarizes the missing or partial GitHub evidence without treating it as a roadmap failure.

### Requirement: Roadmap audit handles GitHub credentials safely

`/aif-roadmap` MUST keep GitHub evidence collection non-blocking and MUST NOT write tokens, authorization headers, raw credential helper output, or private authentication diagnostics into `.ai-factory/ROADMAP.md`.

#### Scenario: GitHub command reports authentication details

- GIVEN a GitHub tool or connector returns authentication, authorization, token, or credential-related diagnostics
- WHEN `/aif-roadmap` creates or refreshes `.ai-factory/ROADMAP.md`
- THEN the roadmap may state that GitHub evidence was unavailable or partial
- AND it does not include tokens, authorization headers, raw credential helper output, or private authentication diagnostics.

#### Scenario: GitHub read access is unavailable

- GIVEN GitHub read access fails because the runtime is unauthenticated, offline, rate-limited, or missing `gh`
- WHEN `/aif-roadmap` creates or refreshes `.ai-factory/ROADMAP.md`
- THEN roadmap generation continues from local repository evidence
- AND it does not ask the user to mutate GitHub state as part of roadmap generation.

### Requirement: GitHub state does not replace local proof

`/aif-roadmap` MUST treat GitHub issue and PR state as supporting evidence only. A closed issue, completed milestone, or merged PR MUST NOT be the sole reason to mark a roadmap slice or roadmap item `done`.

#### Scenario: Closed issue without local evidence

- GIVEN a GitHub issue is closed
- AND local OpenSpec artifacts, source changes, tests, CI evidence, runtime state, or QA evidence do not support the completed behavior
- WHEN `/aif-roadmap` evaluates the related roadmap item
- THEN it does not mark the item `done` only because the issue is closed
- AND it reports a drift or evidence gap.

#### Scenario: Merged PR with matching local evidence

- GIVEN a GitHub PR is merged
- AND the current git tree, source files, tests, OpenSpec artifacts, or QA evidence confirm the merged behavior
- WHEN `/aif-roadmap` evaluates the related roadmap item
- THEN it may use the PR as supporting evidence for progress
- AND it links or names the PR where useful.

### Requirement: Roadmap audit detects GitHub/local drift

`/aif-roadmap` MUST call out material drift between GitHub tracker state and local canonical evidence.

#### Scenario: GitHub says done but local evidence is missing

- GIVEN GitHub issue, milestone, or PR state implies work is complete
- AND local OpenSpec artifacts, source tree, tests, CI, runtime state, or QA evidence are missing or contradictory
- WHEN `/aif-roadmap` refreshes the roadmap
- THEN it reports the mismatch as drift or an evidence gap.

#### Scenario: Local implementation exists but GitHub is stale

- GIVEN local source, tests, OpenSpec artifacts, runtime state, or QA evidence show implemented work
- AND the related GitHub issue, milestone, or roadmap link appears stale or absent
- WHEN `/aif-roadmap` refreshes the roadmap
- THEN it reports the stale GitHub linkage as drift instead of discarding local evidence.

#### Scenario: OpenSpec change lacks tracker linkage

- GIVEN an active or archived OpenSpec change exists
- AND no related roadmap, GitHub issue, milestone, or PR link is visible
- WHEN `/aif-roadmap` evaluates planning traceability
- THEN it may report missing linkage as a traceability gap
- AND it does not treat the missing GitHub link alone as implementation failure.

### Requirement: Roadmap writes remain owner-bounded

`/aif-roadmap` MUST keep write ownership limited to the configured roadmap artifact and MUST NOT mutate GitHub, canonical OpenSpec artifacts, runtime state, QA evidence, generated rules, or implementation files.

#### Scenario: Roadmap refresh with GitHub context

- GIVEN GitHub context is available
- WHEN `/aif-roadmap` refreshes the roadmap
- THEN it may update `.ai-factory/ROADMAP.md`
- AND it does not edit GitHub issues, GitHub milestones, PRs, `openspec/changes/**`, `openspec/specs/**`, `.ai-factory/state/**`, `.ai-factory/qa/**`, or `.ai-factory/rules/generated/**`.

### Requirement: Roadmap entries must preserve useful local and GitHub evidence links

Roadmap entries MUST include GitHub milestone, issue, or PR links where useful, alongside local artifact paths that justify the roadmap assessment.

#### Scenario: Item has both local and GitHub evidence

- GIVEN a roadmap item maps to local OpenSpec artifacts and GitHub tracker items
- WHEN `/aif-roadmap` writes the item
- THEN it includes enough local evidence paths to justify the status
- AND it includes GitHub links or identifiers where useful.

#### Scenario: Manual roadmap notes still match evidence

- GIVEN existing manual roadmap notes are still consistent with local and GitHub evidence
- WHEN `/aif-roadmap` updates `.ai-factory/ROADMAP.md`
- THEN it preserves those notes unless contradicted by repository evidence.
