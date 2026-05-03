## AIFHub Roadmap Audit Override

Apply this extension guidance before the base `aif-roadmap` instructions. When any rule below conflicts with the upstream body, this block wins.

### Goal

Treat `/aif-roadmap` as an evidence-based maturity audit for this extension workflow, not as a generic milestone brainstorm.

### Required Context

1. Read `.ai-factory/config.yaml` first.
2. Read `.ai-factory/RULES.md` and `.ai-factory/rules/base.md` when present.
3. Read `.ai-factory/DESCRIPTION.md` and `.ai-factory/ARCHITECTURE.md` when present.
4. Read the current `.ai-factory/ROADMAP.md` before editing it.
5. Treat only explicit localization markers from `config.yaml` as saved memory for this skill.
6. If localization markers are missing or incomplete in config, ask before roadmap generation.

### OpenSpec-native evidence

When `.ai-factory/config.yaml` declares `aifhub.artifactProtocol: openspec`, roadmap audit may read OpenSpec-native evidence:

- `openspec/specs/**`
- `openspec/changes/<change-id>/proposal.md`
- `openspec/changes/<change-id>/design.md`
- `openspec/changes/<change-id>/tasks.md`
- `openspec/changes/<change-id>/specs/**/spec.md`
- `.ai-factory/rules/generated/openspec-merged-<change-id>.md`
- `.ai-factory/rules/generated/openspec-change-<change-id>.md`
- `.ai-factory/rules/generated/openspec-base.md`
- `.ai-factory/state/<change-id>/`
- `.ai-factory/qa/<change-id>/`

Use these as evidence only. `/aif-roadmap` must not write runtime state, QA evidence, generated rules, or canonical OpenSpec change artifacts.

When OpenSpec-native evidence is used, summarize the artifact source set in the normal response.

### GitHub-aware evidence

When GitHub context is available, `/aif-roadmap` may read GitHub-aware evidence as supporting evidence only:

- milestones
- open and closed issues
- open, merged, and closed PRs
- labels
- linked branches
- current git tree, changed files, tags, and recent commits

GitHub context may come from `gh`, a GitHub connector, explicit issue/PR URLs, or caller-provided metadata. GitHub access is optional and non-blocking. If GitHub data is missing, unauthenticated, rate-limited, offline, or only partially available, continue from local repository evidence and summarize whether GitHub evidence was used, unavailable, or partially available.

GitHub state must never replace local proof. A closed issue, completed milestone, or merged PR must never be the sole reason to mark a slice or roadmap item `done`; require local evidence from OpenSpec artifacts, source files, tests, CI, runtime state, QA evidence, generated rules, or other repository artifacts.

Detect and report drift when material:

- GitHub says done, but local evidence is missing
- local implementation exists, but GitHub is stale
- OpenSpec change exists, but no linked roadmap/milestone/issue is visible
- merged PR exists, but current git tree does not contain the expected local evidence

GitHub-aware roadmap output must be credential-safe. It may include public or user-provided identifiers such as issue numbers, PR numbers, milestone names, titles, states, and URLs. It must not write tokens, authorization headers, raw credential helper output, or private authentication diagnostics into `.ai-factory/ROADMAP.md` or normal responses.

`/aif-roadmap` is read-only with respect to GitHub: it must not mutate GitHub issues, milestones, PRs, labels, or linked branches. It must also not write runtime state, QA evidence, generated rules, canonical OpenSpec artifacts, or implementation files.

### Legacy AI Factory-only evidence

When OpenSpec-native mode is not enabled, legacy `.ai-factory/plans/<plan-id>/` and `.ai-factory/specs/<plan-id>/` records may be used as historical roadmap evidence.

### Modes

- Default mode: create or refresh the roadmap audit.
- Check mode: when the user asks to verify, re-audit, or compare the roadmap against the current repository.

### Audit Model

Analyze the repository across these slices:

- Launch / Runtime
- Architecture / Structure
- Core Business Logic
- API / Contracts
- Data / Database / Migrations
- Security / Auth / Secrets
- Integrations / External Services
- Quality / Tests / Validation
- CI/CD / Delivery
- Observability / Logs / Metrics
- Documentation / DX

Status definitions are strict:

- `done`: comprehensive evidence exists in the repository for that slice.
- `partial`: meaningful evidence exists, but important pieces are missing or incomplete.
- `missing`: no meaningful implementation evidence exists, or only aspirational notes exist without working artifacts.

Evidence priority is strict:

- Primary evidence: source code, config files, schemas, tests, pipelines, automation definitions.
- Secondary evidence: project documentation only when it matches the repository state.
- Git history and GitHub state are supporting context only and must never be the sole reason to mark a slice `done`.

### Output Rules

- Prefer `partial` over optimistic grading.
- Preserve manual notes that still match the codebase.
- Treat the roadmap as an audit artifact, not as a generic task list.
- In check mode, call out regressions explicitly.
- Link to GitHub milestones, issues, or PRs where useful, but keep local artifact evidence as the basis for status decisions.
- Summarize strongest areas, critical gaps, and any status changes.

### Reference Assets

When available, follow these extension-owned reference files:

- `.ai-factory/extensions/aifhub-extension/injections/references/aif-roadmap/slice-checklist.md`
- `.ai-factory/extensions/aifhub-extension/injections/references/aif-roadmap/roadmap-template.md`

If the extension copy is not installed yet, continue with the rules in this injected block.
