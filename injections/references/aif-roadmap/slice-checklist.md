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
