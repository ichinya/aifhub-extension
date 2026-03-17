---
name: aif-new
description: Create a new plan folder with structured artifacts (task, context, rules, verify, status). Use when starting a new feature, change, or improvement that requires structured planning.
---

# AIF New

Create a new plan folder under `.ai-factory/plans/<plan-id>/` with all required artifacts.

## Context + Rules + Templates Model

This skill follows the [context-rules-templates-model.md](references/context-rules-templates-model.md):

| Level | Context | Rules | Templates |
|-------|---------|-------|-----------|
| **Project** | config.yaml, DESCRIPTION.md, AGENTS.md | ARCHITECTURE.md, RULES.md | .ai-factory/templates/ |
| **Plan** | task.md, context.md, explore.md | rules.md, verify.md, constraints-*.md | (inherits from project) |

Plan artifacts **inherit** from project level and can add plan-specific rules.

## Workflow

1. **Read project context**
   - `.ai-factory/config.yaml` — localization, workflow settings
   - `.ai-factory/DESCRIPTION.md` — tech stack, modules
   - `AGENTS.md` — project structure map
   - `.ai-factory/ARCHITECTURE.md` — architecture patterns (if exists)

2. **Check for exploration output**
   - Read `.ai-factory/RESEARCH.md` if exists
   - If RESEARCH.md contains relevant exploration:
     - Offer to import it into the plan as `explore.md`
     - Extract key findings into `context.md`
     - Extract decisions into `rules.md`
   - If no exploration exists:
     - Ask if user wants to run `aif-explore` first
     - Or proceed with basic plan creation

3. **Gather plan input**
   - Ask the user for the task description if not provided
   - Clarify scope: what's in and out of this plan
   - Identify key files/modules affected
   - Capture any constraints or requirements

4. **Generate plan id**
   - Format from `config.yaml → workflow.plan_id_format` (default: slug)
   - `slug`: Generate from task title (lowercase, hyphens, max 40 chars)
   - `sequential`: Use next number (001, 002, etc.)
   - `timestamp`: Use ISO date-time format
   - Ensure uniqueness by checking existing plans in `.ai-factory/plans/`

5. **Create plan folder structure**
   ```
   .ai-factory/plans/<plan-id>/
     task.md        # What is being done (required)
     context.md     # Local context for this plan (required)
     rules.md       # Plan-specific rules (required)
     verify.md      # Verification checklist (required)
     status.yaml    # Workflow status tracking (required)
     explore.md     # Exploration notes (optional, from aif-explore)
     constraints-*.md # Additional constraints (optional)
   ```

6. **Populate artifacts from templates**
   - Use templates from `references/*-template.md`
   - Fill in available information from:
     - User input
     - Exploration notes (RESEARCH.md)
     - Project context files
   - Mark placeholders with `{{placeholder}}` for user review
   - Set initial `status: draft` in status.yaml

7. **Report and handoff**
   - Show created plan folder path
   - List created artifacts with brief descriptions
   - Suggest next steps:
     - `aif-explore` — if more research needed
     - `aif-implement` — if plan is ready for implementation
     - Manual review — if placeholders need filling

## Artifact Descriptions

| File | Type | Purpose | Required |
|------|------|---------|----------|
| `task.md` | Context | Clear definition of what and why | Yes |
| `context.md` | Context | Relevant codebase context, key files | Yes |
| `rules.md` | Rules | Implementation constraints, testing requirements | Yes |
| `verify.md` | Rules + Template | Verification checklist for aif-verify+ | Yes |
| `status.yaml` | Context | Workflow state tracking | Yes |
| `explore.md` | Context | Exploration notes from aif-explore | Optional |
| `constraints-*.md` | Rules | Additional constraint files (security, API, etc.) | Optional |

## Templates

All templates are in `references/`:

| Template | Purpose |
|----------|---------|
| [task-template.md](references/task-template.md) | Task definition structure |
| [context-template.md](references/context-template.md) | Context gathering template |
| [rules-template.md](references/rules-template.md) | Rules and constraints template |
| [verify-template.md](references/verify-template.md) | Verification checklist |
| [explore-template.md](references/explore-template.md) | Exploration notes structure |
| [research-template.md](references/research-template.md) | RESEARCH.md format (from aif-explore) |
| [status-schema.yaml](references/status-schema.yaml) | Status tracking schema |

## Importing from aif-explore

When `.ai-factory/RESEARCH.md` exists and contains relevant exploration:

```
┌─────────────────────────────────────────────────────────┐
│  RESEARCH.md                                            │
│  ┌─────────────────────────────────────────────────┐    │
│  │ Active Summary                                   │    │
│  │ - Topic: Add OAuth authentication                │    │
│  │ - Goal: Support Google and GitHub providers      │    │
│  │ - Decisions: Use Passport.js, store in session   │    │
│  │ - Open questions: Token refresh strategy?        │    │
│  └─────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────┘
                         │
                         ▼ aif-new
┌─────────────────────────────────────────────────────────┐
│  plans/oauth-auth/                                      │
│  ├── task.md      ← Topic, Goal                        │
│  ├── context.md   ← Relevant files, patterns           │
│  ├── rules.md     ← Decisions, constraints             │
│  ├── verify.md    ← Success signals                    │
│  ├── explore.md   ← Full RESEARCH.md content           │
│  └── status.yaml  ← draft                              │
└─────────────────────────────────────────────────────────┘
```

## Rules

- Always read `.ai-factory/config.yaml` first for project settings
- Create plan folder only under `.ai-factory/plans/`
- Never overwrite existing plans — generate unique plan id
- Keep all artifact file names in English
- Generate content in the configured `artifact_language`
- Leave placeholders clearly marked for user review
- Import exploration from RESEARCH.md when available
- Do not start implementation — only create the plan structure

## Example Usage

```
User: "Create a plan for adding dark mode to the UI"

Agent:
1. Reads config.yaml (language: russian)
2. Checks RESEARCH.md (not found)
3. Asks clarifying questions about scope
4. Creates .ai-factory/plans/add-dark-mode/
5. Populates all artifacts with gathered info
```

```
User: "Мне нужен план для OAuth" (after running aif-explore)

Agent:
1. Reads config.yaml (artifact_language: russian)
2. Reads RESEARCH.md (contains OAuth exploration)
3. Offers to import exploration → explore.md
4. Creates .ai-factory/plans/oauth-auth/
5. Extracts findings into context.md, decisions into rules.md
```

## Integration with Other Skills

| Skill | Relationship |
|-------|--------------|
| `aif-explore` | Reads RESEARCH.md, creates explore.md in plan |
| `aif-implement` | Reads plan artifacts to guide implementation |
| `aif-verify+` | Uses verify.md as verification checklist |
| `aif-done` | Marks plan complete, archives to specs/ |

## Status Workflow

```
draft → exploring → planning → implementing → verifying → fixing → done
                                    ↑_______________|
```

| Status | Description |
|--------|-------------|
| `draft` | Initial creation, artifacts may have placeholders |
| `exploring` | Running aif-explore for more context |
| `planning` | Refining plan details, all placeholders filled |
| `implementing` | Active implementation via aif-implement |
| `verifying` | Running aif-verify+ |
| `fixing` | Addressing verification findings |
| `done` | Completed and archived to specs/ |
