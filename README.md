# AIFHub Extension

> Extension for [ai-factory 2.x](https://github.com/lee-to/ai-factory) CLI providing spec-driven workflow for AI agents.

## What This Extension Does

Full spec-driven development workflow:

| Skill | Replaces | Purpose |
|-------|----------|---------|
| `/aif-analyze` | — | Analyze project, create config.yaml + DESCRIPTION.md |
| `/aif-new` | — | Create plan folder with structured artifacts |
| `/aif-verify+` | `/aif-verify` | Enhanced verification with structured findings |
| `/aif-fix` | — | Fix issues found by verify+ |
| `/aif-done` | — | Finalize plan, archive to specs/ |
| `/aif-roadmap` | `/aif-roadmap` | Enhanced roadmap with maturity assessment |

## Workflow

```
aif-analyze → aif-explore → aif-new → aif-implement → aif-verify+ → aif-fix → aif-done
                                                            ↑______________|
```

## Installation

### From Git Repository

```bash
ai-factory extension add https://github.com/ichinya/aifhub-extension.git
```

### Local Installation

```bash
git clone https://github.com/ichinya/aifhub-extension.git
cd aifhub-extension
ai-factory extension add .
```

## Usage

### 1. Analyze Project

```bash
/aif-analyze
```

Scans your project and creates:
- `.ai-factory/config.yaml` — localization and workflow settings
- `.ai-factory/DESCRIPTION.md` — project specification

On first use asks for language preference and translation scope.

### 2. Create Plan

```bash
/aif-new "add OAuth authentication"
```

Creates a plan folder with structured artifacts:

```
.ai-factory/plans/add-oauth/
├── task.md        # What is being done
├── context.md     # Local codebase context
├── rules.md       # Implementation constraints
├── verify.md      # Verification checklist
├── status.yaml    # Workflow status tracking
└── explore.md     # Exploration notes (optional)
```

If `.ai-factory/RESEARCH.md` exists (from `/aif-explore`), it imports findings into the plan.

### 3. Implement

```bash
/aif-implement
```

Implement the plan using built-in `/aif-implement` skill.

### 4. Verify

```bash
/aif-verify+
```

Enhanced verification against task, rules, and constraints:
- Produces structured findings (blocking / important / optional)
- Routes to `/aif-fix` on fail or `/aif-done` on pass

Strict mode for pre-merge checks:

```bash
/aif-verify+ --strict
```

### 5. Fix Issues

```bash
/aif-fix              # Fix blocking + important
/aif-fix B001 I001    # Fix specific findings
/aif-fix --all        # Fix everything including optional
```

### 6. Finalize

```bash
/aif-done
```

Archives plan artifacts to `.ai-factory/specs/<plan-id>/` with summary.

### 7. Generate Roadmap

```bash
/aif-roadmap
```

Creates `.ai-factory/ROADMAP.md` with maturity assessment across 11 slices.

## Project Structure

```
aifhub-extension/
├── extension.json                # Extension manifest (v0.4.0)
├── README.md                     # This file
└── skills/
    ├── aif-analyze/              # Project analysis
    │   ├── SKILL.md
    │   └── references/
    ├── aif-new/                  # Plan creation
    │   ├── SKILL.md
    │   └── references/
    ├── aif-verify-plus/          # Enhanced verification
    │   ├── SKILL.md
    │   └── references/
    ├── aif-fix/                  # Fix verification issues
    │   └── SKILL.md
    ├── aif-done/                 # Plan finalization
    │   ├── SKILL.md
    │   └── references/
    └── aif-roadmap-plus/         # Enhanced roadmap
        ├── SKILL.md
        └── references/
```

## Requirements

- ai-factory 2.x CLI

## License

MIT
