# Slice Checklist

Assess every slice independently. Use `done`, `partial`, or `missing`.

Mark a slice `done` only when the repository shows comprehensive evidence. When the evidence is mixed or incomplete, prefer `partial`.

## Required Slices

1. Launch / Runtime
   - Entry points and bootstrap
   - Environment configuration
   - Runtime dependencies
   - Process management

2. Architecture / Structure
   - Module organization
   - Dependency graph
   - Layer separation
   - Design patterns

3. Core Business Logic
   - Domain models
   - Business rules
   - Application services
   - Workflow implementations

4. API / Contracts
   - API endpoints
   - Request and response schemas
   - API versioning
   - Contract documentation

5. Data / Database / Migrations
   - Schema definitions
   - Migration files
   - ORM or query patterns
   - Data validation

6. Security / Auth / Secrets
   - Authentication
   - Authorization
   - Secrets handling
   - Security hardening

7. Integrations / External Services
   - Third-party API clients
   - Webhook handlers
   - Adapters
   - Integration tests

8. Quality / Tests / Validation
   - Unit tests
   - Integration tests
   - End-to-end tests
   - Quality tooling

9. CI/CD / Delivery
   - Pipeline definitions
   - Build automation
   - Deployment scripts
   - Release process

10. Observability / Logs / Metrics
   - Logging
   - Metrics
   - Tracing
   - Alerting or health checks

11. Documentation / DX
   - README quality
   - API documentation
   - Architecture docs
   - Onboarding guidance

## Evidence Notes

- Use git history only as supporting context.
- Use GitHub evidence only as supporting context. GitHub evidence may include milestones, issues, PRs, labels, linked branches, and current git tree state when available.
- GitHub links are optional; do not require them for every slice or roadmap entry.
- Prefer direct file paths, configs, tests, and automation definitions as evidence.
- local artifact evidence remains required before marking a slice or roadmap item `done`.
- If GitHub says work is complete but local evidence is missing, report drift instead of marking `done`.
- If local implementation exists but GitHub or roadmap linkage is stale, report drift instead of discarding local evidence.
- Do not include tokens, authorization headers, raw credential helper output, or private authentication diagnostics.
- If a slice is unclear, explain what is missing instead of guessing.

## OpenSpec Lifecycle Reconciliation

- During `/aif-roadmap check`, each active canonical OpenSpec proposal with `## Roadmap Linkage` and valid non-`none` roadmap linkage must register one local `planned` row, which must not claim implementation, verification, finalization, merge, or issue closure.
- For an archived change with durable local done/archive evidence, register a missing `finalized` row or preserve its evidence-backed `finalized` row and project-relative finalization evidence. Reconciliation must never downgrade `finalized` to `planned`.
- For an explicitly unlinked change where all linkage values are `none`, `/aif-roadmap check` must not create a managed lifecycle row and must not infer linkage from branch names, GitHub state, labels, or roadmap text.
- If GitHub evidence is unavailable, unauthenticated, rate-limited, offline, or partial, local lifecycle reconciliation continues. The GitHub limitation is non-blocking; preserve evidence-backed local lifecycle state and do not guess external status.
- During post-merge reconciliation, refresh the current issue, PR, and milestone state while the managed local lifecycle row remains `finalized`. A remote closure or merge MUST NOT be rewritten as local finalization evidence and must not promote `planned` to `finalized`.
- In output, report lifecycle and GitHub evidence sources separately. Use `Lifecycle evidence:` for bounded project-relative local sources and `GitHub evidence:` for `used`, `unavailable`, or `partial` plus public identifiers.
- Keep source summaries free of proposal bodies, raw provider output, credentials, authorization headers, credential-helper output, and private authentication diagnostics.

## Milestone Phase Notes

- Treat GitHub milestones as roadmap phases when milestone evidence is available.
- Read open and closed milestones when possible, then state whether milestone evidence was used, unavailable, or partial.
- Closed milestones produce a phase audit with milestone title, number when available, closed date when available, linked issues/PRs, and local artifact evidence status.
- Open milestones with `open_issues = 0` produce `phase-completion drift`; do not treat them as closed milestones.
- Milestone-bound issues and PRs attach to their phase.
- Unmilestoned issues and PRs remain in an explicit `unphased backlog/drift` section.
- For issue #88, keep it in `unphased backlog/drift` unless GitHub assigns it a milestone.
- local artifact evidence remains required before marking a phase, slice, or roadmap item `done`.
