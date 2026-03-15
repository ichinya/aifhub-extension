# Project Scan Checklist

Use this order to keep the analysis evidence-based and repeatable.

## Root Structure

Check the repository root for technology markers:

- `package.json` -> Node.js or JavaScript ecosystem
- `composer.json` -> PHP ecosystem
- `requirements.txt` or `pyproject.toml` -> Python ecosystem
- `go.mod` -> Go
- `Cargo.toml` -> Rust
- `pom.xml` or `build.gradle` -> Java
- `Dockerfile`, `compose.yml`, `docker-compose.yml` -> containerization
- `.github/workflows/`, `.gitlab-ci.yml`, `Jenkinsfile` -> CI/CD

## Application Directories

Look for the main working areas:

- `src/`, `app/`, `lib/`, `api/`
- `tests/`, `spec/`, `__tests__/`
- `docs/`, `config/`
- `migrations/`, `prisma/`, `db/`

## Source Control

Use git only to confirm repository state and remotes:

- `git rev-parse --is-inside-work-tree`
- `git remote -v`

Do not infer maturity from commit history alone.

## Existing AI Context

Read these files first when they exist:

- `.ai-factory/DESCRIPTION.md`
- `.ai-factory/ARCHITECTURE.md`
- `.ai-factory/ROADMAP.md`
- `.ai-factory/RULES.md`
- `AGENTS.md`
- `CLAUDE.md`

## Evidence Rules

- Prefer manifests, source files, configs, and generated outputs over README claims.
- Call out unclear areas explicitly instead of filling gaps with assumptions.
- Mention only integrations, security-sensitive areas, and modules that the repository actually shows.
