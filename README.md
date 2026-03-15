# AIFHub Extension

> Extension for [ai-factory 2.x](https://github.com/lee-to/ai-factory) CLI providing analyze-first workflow and enhanced roadmap skill.

## What This Extension Does

- **Adds `/aif-analyze`** — Analysis-first workflow skill for primary project analysis
- **Replaces `/aif-roadmap`** — Enhanced roadmap with evidence-based maturity assessment across 11 project slices

## Installation

### From Git Repository

```bash
ai-factory extension add https://github.com/ichinya/aifhub-extension.git
```

### Local Installation

```bash
# Clone repository
git clone https://github.com/ichinya/aifhub-extension.git
cd aifhub-extension

# Add to ai-factory
ai-factory extension add .
```

## Usage

### 1. Analyze Project

```bash
/aif-analyze
```

Scans your project and creates `.ai-factory/DESCRIPTION.md` with:
- Project overview and type
- Detected tech stack
- Main modules and integrations
- Security-sensitive areas
- Current maturity snapshot

On first use in a project, the skill asks one question: what language to use in this project.

It then stores that project preference in the project itself:
- Prefer an existing `AGENTS.md`
- Otherwise prefer an existing `CLAUDE.md`
- Otherwise fall back to `.ai-factory/RULES.md`

That saved project language is reused in later sessions for both replies and generated artifacts by default. If the user explicitly wants different languages for communication and artifacts, the skill may store that split as a project-specific override.

```bash
/aif-analyze russian
```

### 2. Generate Roadmap

```bash
/aif-roadmap
```

Creates `.ai-factory/ROADMAP.md` with maturity assessment across 11 slices:

1. **Launch / Runtime** — Entry points, environment, dependencies
2. **Architecture / Structure** — Module organization, patterns
3. **Core Business Logic** — Domain models, business rules
4. **API / Contracts** — Endpoints, schemas, documentation
5. **Data / Database** — Schema, migrations, queries
6. **Security / Auth** — Authentication, authorization, secrets
7. **Integrations** — External services, webhooks
8. **Quality / Tests** — Unit, integration, E2E tests
9. **CI/CD** — Pipelines, builds, deployment
10. **Observability** — Logs, metrics, tracing
11. **Documentation** — README, API docs, DX

**Check mode** — Verify roadmap against current code:

```bash
/aif-roadmap check
```

The roadmap skill reuses the same saved project language.

## Recommended Workflow

```bash
# Step 1: Analyze project
/aif-analyze

# Step 2: Define architecture
/aif-architecture

# Step 3: Generate roadmap
/aif-roadmap

# Step 4: Plan implementation
/aif-plan "your feature"

# Step 5: Implement
/aif-implement

# Step 6: Verify
/aif-verify
```

## Project Structure

```
aifhub-extension/
├── extension.json           # Extension manifest
├── README.md                # This file
└── skills/
    ├── aif-analyze/
    │   └── SKILL.md         # Analysis workflow skill
    └── aif-roadmap-plus/
        └── SKILL.md         # Enhanced roadmap skill
```

## Extension Manifest

```json
{
  "name": "aifhub-extension",
  "version": "0.1.0",
  "description": "Analyze-first workflow and enhanced roadmap for AI Factory",
  "skills": [
    "skills/aif-analyze",
    "skills/aif-roadmap-plus"
  ],
  "replaces": {
    "skills/aif-roadmap-plus": "aif-roadmap"
  }
}
```

## Requirements

- ai-factory 2.x CLI

## License

MIT
