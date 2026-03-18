# Context + Rules + Templates Model

This document defines the artifact model for spec-driven workflow.

## Core Concepts

| Concept | Definition | Example |
|---------|------------|---------|
| **Context** | Facts about the project/plan | "Uses TypeScript", "Auth module in src/auth/" |
| **Rules** | Constraints and required behavior | "Must use async/await", "No direct DB calls in handlers" |
| **Templates** | Expected artifact shapes | SKILL.md structure, config.yaml schema |

## Two Levels

### Project Level (Persistent)

| Artifact | Type | Purpose |
|----------|------|---------|
| `.ai-factory/config.yaml` | Context + Rules | Localization, workflow settings, paths, rules refs |
| `.ai-factory/RESEARCH.md` | Context | Persisted exploration context and active summary |
| `.ai-factory/DESCRIPTION.md` | Context | Tech stack, modules, integrations (owned by core /aif) |
| `.ai-factory/ARCHITECTURE.md` | Context + Rules | Architecture decisions, patterns (owned by core /aif-architecture) |
| `.ai-factory/RULES.md` | Rules | Project conventions (optional) |
| `.ai-factory/rules/base.md` | Rules | Project-wide conventions (required) |
| `.ai-factory/rules/*.md` | Rules | Area-specific rules (optional, plan-driven) |
| `.ai-factory/ROADMAP.md` | Context | Strategic milestones (owned by core /aif-roadmap) |

### Plan Level (Ephemeral)

| Artifact | Type | Purpose |
|----------|------|---------|
| `plans/<id>/task.md` | Context | What and why |
| `plans/<id>/context.md` | Context | Local codebase context |
| `plans/<id>/rules.md` | Rules | Plan-specific constraints |
| `plans/<id>/constraints-*.md` | Rules | Additional constraint files |
| `plans/<id>/verify.md` | Rules + Template | Verification checklist |
| `plans/<id>/status.yaml` | Context | Workflow state |
| `plans/<id>/explore.md` | Context | Exploration notes (optional) |

## Inheritance Model

```
Project Level (Base)
    │
    ├── Context: Tech stack, modules, integrations
    ├── Rules: Project conventions, patterns
    └── Templates: Standard artifact shapes
        │
        ▼
Plan Level (Derived)
    │
    ├── Context: task.md + context.md + explore.md
    ├── Rules: rules.md + constraints + verify.md
    └── Templates: Templates for this plan's outputs
```

**Inheritance Rules:**

1. Plan inherits all project-level context
2. Plan rules can add to (not replace) project rules
3. Plan-specific rules take precedence when conflicts occur
4. Templates are shared across project and plans

## How Skills Use This Model

| Skill | Reads | Writes |
|-------|-------|--------|
| `aif-analyze` | Project files | config.yaml, rules/base.md |
| `aif-explore` | Project + plan context | RESEARCH.md, explore.md |
| `aif-new` | Project context + exploration + rules | Plan folder artifacts, area rules (optional) |
| `aif-implement` | Plan context + all rules (base + area) | Code files |
| `aif-verify` | Plan rules + verify.md + all rules | Verification results |
| `aif-done` | Plan artifacts | specs/ folder |

## Rules Architecture (Config)

```
.ai-factory/rules/
├── base.md           ← Required. Created by aif-analyze.
├── api.md            ← Optional. Created by aif-new when plan needs it.
├── frontend.md       ← Optional. Created by aif-new when plan needs it.
├── backend.md        ← Optional. Created by aif-new when plan needs it.
├── database.md       ← Optional. Created by aif-new when plan needs it.
├── logging.md        ← Optional. Created by aif-new when plan needs it.
└── testing.md        ← Optional. Created by aif-new when plan needs it.
```

**config.yaml references:**
```yaml
rules:
  base: .ai-factory/rules/base.md
  api: .ai-factory/rules/api.md       # Only if exists
  frontend: .ai-factory/rules/frontend.md  # Only if exists
```

**Ownership:**
- `aif-analyze` creates `base.md` (required)
- `aif-new` creates area rules (optional, plan-driven)
- `aif-implement` and `aif-verify` read only

## Legacy Rules Compatibility

- If `.ai-factory/RULES.md` exists, use it as additional project rules.
- Prefer `config.rules.*` for modular rules, but do not ignore existing `RULES.md`.

## Template Resolution

When a skill needs a template:

1. Check plan folder first (`plans/<id>/templates/`)
2. Fall back to project templates (`.ai-factory/templates/`)
3. Fall back to skill defaults (`skills/<name>/references/`)

```
plans/<id>/templates/     ← Plan-specific (highest priority)
    │
    ▼
.ai-factory/templates/    ← Project-specific
    │
    ▼
skills/<name>/references/ ← Skill defaults (fallback)
```

## Example: Creating a Plan

```yaml
# User runs: /aif-new "add dark mode"

# Skill reads project context:
project_context:
  - .ai-factory/config.yaml     # language.ui: russian
  - .ai-factory/DESCRIPTION.md  # React + TypeScript
  - .ai-factory/RESEARCH.md     # Active summary / exploration context

# Skill reads exploration (if exists):
exploration_context:
  - .ai-factory/RESEARCH.md     # Prior exploration
  - OR asks user for details

# Skill creates plan artifacts:
plan_folder: .ai-factory/plans/add-dark-mode/
  task.md:      # What: Add dark mode toggle
  context.md:   # Context: UI components, theme system
  rules.md:     # Rules: Use CSS variables, persist preference
  verify.md:    # Verify: Toggle works, colors correct
  status.yaml:  # Status: draft
```

## Constraints Files

Additional constraint files can be added for specific concerns:

| File | When to Use |
|------|-------------|
| `constraints-api.md` | API compatibility requirements |
| `constraints-security.md` | Security requirements |
| `constraints-performance.md` | Performance requirements |
| `constraints-accessibility.md` | A11y requirements |

## Updating This Model

When adding new artifacts:

1. Classify as Context, Rules, or Template
2. Assign to Project or Plan level
3. Define which skills read/write it
4. Update this document
