## AIFHub Roadmap Audit Override

Apply this extension guidance before the base `aif-roadmap` instructions. When any rule below conflicts with the upstream body, this block wins.

Follow `skills/shared/LANGUAGE-POLICY.md` before producing user-facing responses or generated artifacts.

Resolve user-facing prose language in this order: use a usable non-empty `language.ui`; otherwise preserve the current conversation language for this response only; use English only when that language is indeterminate. This rule overrides downstream generic English defaults; do not infer from OS locale or persist the inferred choice. On that hard-English fallback, add exactly one concise setup hint only when the output contract permits human-readable prose, before any required final machine-readable block; never add it inside or after `aif-gate-result`, and never alter exact handoffs, fixed commands, paths, keys/enums, or machine-only output.

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
- `openspec/changes/archive/**`
- `.ai-factory/rules/generated/openspec-merged-<change-id>.md`
- `.ai-factory/rules/generated/openspec-change-<change-id>.md`
- `.ai-factory/rules/generated/openspec-base.md`
- `.ai-factory/state/<change-id>/`
- `.ai-factory/qa/<change-id>/`

Use these as evidence only. `/aif-roadmap` must not write runtime state, QA evidence, generated rules, or canonical OpenSpec change artifacts.

When OpenSpec-native evidence is used, summarize the artifact source set in the normal response.

### Managed local lifecycle reconciliation

In check mode, `/aif-roadmap check` owns reconciliation of the configured roadmap's marker-bounded `OpenSpec Change Lifecycle` block. Treat local lifecycle evidence and external GitHub evidence as independent clocks. For local lifecycle reconciliation, mutate only the managed block; the normal roadmap owner may still refresh phase and slice audit content under the existing rules. Preserve evidence-backed state, and do not rewrite canonical OpenSpec, runtime, QA, generated-rules, implementation, or GitHub artifacts.

Apply these local lifecycle rules:

- When an active canonical OpenSpec proposal contains `## Roadmap Linkage` with valid non-`none` roadmap linkage, register one local `planned` row for that change. The row must not claim implementation, verification, finalization, merge, or issue closure.
- For an archived change with durable local done/archive evidence, register a missing `finalized` row or preserve its evidence-backed `finalized` row and its project-relative finalization evidence. Reconciliation must never downgrade `finalized` to `planned`, even if the same linkage is also visible in an active or historical source.
- If an archived change has no durable local done/archive evidence and no current evidence-backed `finalized` row, report bounded local drift instead of fabricating finalization.
- An explicitly unlinked change is one whose standardized section exists and all linkage values are `none`. `/aif-roadmap check` must not create a managed lifecycle row for it and must not infer linkage from branch names, GitHub state, labels, or roadmap text.
- If an existing managed row conflicts with canonical linkage or durable local evidence, report the contradiction and preserve the higher evidence-backed local state rather than guessing or deleting history.
- Reject duplicate, reversed, nested, incomplete, or otherwise malformed lifecycle markers without rewriting unrelated roadmap bytes.

### Independent external reconciliation

Use current GitHub evidence for phase audit and post-merge reconciliation only. When a locally finalized change's GitHub state changes after the final local commit, refresh the current issue, PR, and milestone state in the phase or unphased audit while the managed local lifecycle row remains `finalized`. A remote closure or merge MUST NOT be rewritten as local finalization evidence, must not replace the row's project-relative evidence path, and must not promote `planned` to `finalized`.

When GitHub evidence is unavailable, unauthenticated, rate-limited, offline, or partial, local lifecycle reconciliation continues from canonical and durable local evidence. The GitHub limitation is non-blocking by itself; preserve existing evidence-backed `planned` or `finalized` state and do not invent external status.

In normal output and roadmap audit prose, report lifecycle and GitHub evidence sources separately using bounded summaries:

- `Lifecycle evidence:` project-relative canonical proposal, archive, done, final-summary, or managed-row sources used for `planned`/`finalized` decisions.
- `GitHub evidence:` `used`, `unavailable`, or `partial`, plus public issue/PR/milestone identifiers when available.

Never copy proposal bodies, finalization contents, raw provider output, credentials, or private authentication diagnostics into either source summary.

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

Treat GitHub milestones as roadmap phases when milestone evidence is available. Read both open and closed milestones when possible, and state in normal roadmap output whether GitHub milestone evidence was used, unavailable, or partial.

Milestone phase audit rules:

- Closed milestones must produce a phase audit section instead of only disconnected checklist points. Include the milestone title, milestone number when available, closed date when available, linked issues/PRs, and local evidence status.
- Open milestones with `open_issues = 0` are not closed phases. Report `phase-completion drift` with the milestone title, number when available, open/closed issue counts, and the exact reason the phase still needs closure or local evidence.
- Issues and PRs assigned to a milestone attach to that roadmap phase.
- Issues and PRs without a milestone remain in an explicit `unphased backlog/drift` section. For issue #88, keep it unphased unless GitHub assigns it a milestone.
- local artifact evidence remains required before marking a phase, slice, or roadmap item `done`.
- Closed milestone phase audits still require local artifact evidence before any phase or linked roadmap item is marked `done`.

Detect and report drift when material:

- GitHub says done, but local evidence is missing
- local implementation exists, but GitHub is stale
- OpenSpec change exists, but no linked roadmap/milestone/issue is visible
- closed milestone is missing a phase audit
- open milestone has `open_issues = 0`, but the roadmap does not report `phase-completion drift`
- issue or PR milestone linkage is missing from the corresponding phase
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
- When GitHub milestones are present, include milestone phase audit output before or alongside slice status output.
- Keep unmilestoned GitHub issues and PRs visible in `unphased backlog/drift` instead of silently folding them into a phase.
- Summarize strongest areas, critical gaps, and any status changes.

### Reference Assets

When available, follow these extension-owned reference files:

- `.ai-factory/extensions/aifhub-extension/injections/references/aif-roadmap/slice-checklist.md`
- `.ai-factory/extensions/aifhub-extension/injections/references/aif-roadmap/roadmap-template.md`

If the extension copy is not installed yet, continue with the rules in this injected block.
