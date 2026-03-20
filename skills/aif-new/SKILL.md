---
name: aif-new
description: Create a new plan folder with structured artifacts (task, context, rules, verify, status). Use when starting a new feature, change, or improvement that requires structured planning.
argument-hint: "[task description]"
version: 0.7.0
---

# AIF New — Create Plan Folder

Create a new plan folder under `.ai-factory/plans/<plan-id>/` with all required artifacts for spec-driven workflow.

**This skill creates the plan structure only.** It does NOT implement anything. After plan creation, hand off to `aif-improve` first, then to `aif-implement` (Implement+ replacement in this extension).

---

## Artifact Ownership

- **Primary ownership:** `.ai-factory/plans/<plan-id>/` — all files inside the new plan folder.
- **Conditional ownership:** `.ai-factory/rules/<area>.md` (when user confirms area rules), `.ai-factory/config.yaml` (`rules.*` section only, when adding area rules).
- **Read-only:** `.ai-factory/DESCRIPTION.md`, `.ai-factory/ARCHITECTURE.md`, `.ai-factory/RESEARCH.md`.
- **No writes to:** project source code, other plans, specs/, ROADMAP.md.

---

## Step 0: Load Context

### 0.1 Load Skill-Context Overrides

**Read `.ai-factory/skill-context/aif-new/SKILL.md`** — MANDATORY if the file exists.

This file contains project-specific rules accumulated by `/aif-evolve`. Treat them as project-level overrides:
- When a skill-context rule conflicts with a rule in this SKILL.md, **the skill-context rule wins**.
- When there is no conflict, apply both.
- **CRITICAL:** skill-context rules apply to ALL outputs — including plan artifact content. Generating artifacts that violate skill-context rules is a bug.

**Enforcement:** After generating any plan artifact, verify it against all skill-context rules. Fix violations before presenting to the user.

### 0.2 Load Project Context

Read these files if present (do NOT fail if missing):

- `.ai-factory/config.yaml` — localization, workflow settings, plan_id_format, rules paths
- `.ai-factory/DESCRIPTION.md` — tech stack, modules, integrations
- `.ai-factory/ARCHITECTURE.md` — architecture patterns, dependency rules
- `.ai-factory/RULES.md` — project conventions (use if present)
- `.ai-factory/rules/base.md` — project rules (path from config: `config.rules.base`)
- `.ai-factory/RESEARCH.md` — persisted exploration notes

If `.ai-factory/config.yaml` does not exist:
```
AskUserQuestion: Project config not found. Create it?

Options:
1. Yes — Run /aif-analyze first to initialize config (recommended)
2. Continue without config — Use defaults (english, slug format)
```

### 0.3 Resolve Localization

If config.yaml exists:
- Use `config.language.ui` for communication
- Use `config.language.artifacts` for generated artifacts
- Use `config.language.technical_terms` for tech terms (default: english)

**No config fallback**:
- Ask user before generating artifacts when localization is missing in config
- Suggest running `/aif-analyze` to initialize localization in `config.yaml`

**Always**: Keep file names, identifiers, and YAML keys in English

### 0.4 Load Project Rules

Read rules from config paths:
- `config.rules.base` → `.ai-factory/rules/base.md` (required)
- Any existing area rules referenced in `config.rules.*`
- If `.ai-factory/RULES.md` exists, load it as additional project rules

Rule precedence for plan generation:
1. Plan-specific rules (`plans/<id>/rules.md` when editing existing plan)
2. `.ai-factory/RULES.md` (if present)
3. `config.rules.*` files (`base.md` + area rules)

These rules apply to plan artifacts and will be inherited by the plan's `rules.md`.

Artifact metadata contract:
- markdown plan artifacts use YAML frontmatter first
- required keys: `artifact_type`, `plan_id`, `title`, `artifact_status`, `owner`, `created_at`, `updated_at`
- optional traceability keys may include `source_issue`, `source_plan`, `source_artifact`
- string-valued frontmatter fields such as `plan_id`, `title`, `source_plan`, and `source_artifact` must be YAML-quoted when artifacts are written
- YAML-native artifacts such as `status.yaml` keep their existing format and are not wrapped

---

## Step 1: Gather Plan Input

### 1.1 Parse Arguments

If `$ARGUMENTS` contains a task description → use it as the starting point.

If `$ARGUMENTS` points to an existing local file path:
- Read the file as the task specification source
- Extract goals/scope/constraints from file content
- Use extracted content as primary input for generated artifacts
- Keep file path as reference in `context.md`

If `$ARGUMENTS` is empty:
```
AskUserQuestion: What would you like to plan?

Provide a brief description of the feature, change, or improvement.
Examples:
- "Add OAuth authentication with Google and GitHub"
- "Refactor database layer to support PostgreSQL"
- "Fix performance issues in search endpoint"
```

### 1.2 Check for Exploration Output

Read `.ai-factory/RESEARCH.md` if it exists:

- Parse `<!-- aif:active-summary:start -->` ... `<!-- aif:active-summary:end -->` block
- If topic matches the task description (or is clearly related):
  ```
  AskUserQuestion: Found exploration notes in RESEARCH.md that may be relevant.

  Topic: {{research_topic}}
  Goal: {{research_goal}}

  Import exploration into the plan?

  Options:
  1. Yes — Import findings into plan artifacts (recommended)
  2. No — Start fresh, ignore exploration
  3. View — Show me the summary first
  ```
- If imported, distribute content:
  - Topic + Goal → `task.md`
  - Constraints + Decisions → `rules.md`
  - Open questions → `task.md → Out of Scope` or `context.md → Known Constraints`
  - Success signals → `verify.md`
- Always normalize RESEARCH into a plan-local `explore.md` when RESEARCH exists:
   - Source: `.ai-factory/RESEARCH.md`
   - Destination: `.ai-factory/plans/<plan-id>/explore.md`
   - Preserve the original RESEARCH body below the frontmatter; do not truncate it
   - Add YAML frontmatter for the plan-local artifact
   - Include `source_artifact: ".ai-factory/RESEARCH.md"` only on this imported/normalized path
   - Keep `.ai-factory/RESEARCH.md` in place and unchanged (copy + normalize, not move)

### 1.3 Clarify Scope

If the task description is vague or broad, ask targeted questions:

```
AskUserQuestion: Let me clarify the scope for this plan.

1. What specific outcome do you expect? (not just "add feature X" but "users can do Y")
2. Are there parts we should explicitly NOT touch?
3. Any hard constraints? (deadlines, dependencies, backwards compatibility)
4. Related issue or PR number?
```

Do NOT ask all questions if the task is already clear. Skip what's obvious.

### 1.4 Investigate Codebase (when relevant)

If the task mentions specific modules, files, or features:
- Use `Glob` and `Grep` to find relevant files
- Read key files to understand current implementation
- Map integration points
- This feeds into `context.md`

---

## Step 2: Generate Plan ID

Read format from `config.workflow.plan_id_format` (default: `slug`).

| Format | Logic | Example |
|--------|-------|---------|
| `slug` | Lowercase, hyphens, max 40 chars, from task title | `add-oauth-authentication` |
| `sequential` | Next number: scan existing plans, increment | `003` |
| `timestamp` | ISO date-time compact | `2024-01-15-1030` |

**Uniqueness check:**
```bash
ls .ai-factory/plans/
```
If collision → append `-2`, `-3`, etc.

---

## Step 3: Create Plan Folder

```bash
mkdir -p .ai-factory/plans/<plan-id>
```

Create these files using templates from `references/`:

| File | Template | Required |
|------|----------|----------|
| `task.md` | [task-template.md](references/task-template.md) | Yes |
| `context.md` | [context-template.md](references/context-template.md) | Yes |
| `rules.md` | [rules-template.md](references/rules-template.md) | Yes |
| `verify.md` | [verify-template.md](references/verify-template.md) | Yes |
| `status.yaml` | [status-schema.yaml](references/status-schema.yaml) | Yes |
| `explore.md` | Normalize from `.ai-factory/RESEARCH.md` if exists, otherwise [explore-template.md](references/explore-template.md) | Yes if RESEARCH.md exists |
| `constraints-*.md` | — | Only if specific constraints identified |

### Populating Artifacts

**task.md** — Fill from user input + exploration:
- include YAML frontmatter with the shared artifact metadata keys
- Summary: 1-2 sentence description
- Motivation: why this matters
- Scope In/Out: concrete checklist items
- Acceptance Criteria: testable conditions
- Dependencies and effort estimate

**context.md** — Fill from codebase investigation:
- include YAML frontmatter with the shared artifact metadata keys
- Key files that will be changed (with paths)
- Relevant patterns already in use
- Known constraints from ARCHITECTURE.md
- Integration points

**rules.md** — Fill from exploration decisions + project rules:
- include YAML frontmatter with the shared artifact metadata keys
- Import project-level rules from `config.rules.base` and relevant `config.rules.*` area files
- If `.ai-factory/RULES.md` exists, import relevant project conventions from it
- Cross-check architectural constraints from ARCHITECTURE.md
- Add plan-specific implementation rules
- Testing requirements (what needs tests)
- Documentation requirements

**verify.md** — Generate from task scope + rules:
- include YAML frontmatter with the shared artifact metadata keys
- One checkbox per In Scope item
- One checkbox per acceptance criterion
- Standard checks: build, tests, lint, docs
- Constraints compliance checkboxes

**status.yaml** — Initialize:
```yaml
plan_id: <plan-id>
title: "<task title>"
created: <current ISO timestamp>
updated: <current ISO timestamp>
status: draft
progress:
  scope_total: <count of In Scope items>
  scope_completed: 0
execution:
  mode: local
  subagent: null
  mode_resolved_at: null
  current_task: null
  max_fix_loops: 3
  quality_checks: []
history:
  - timestamp: <current ISO timestamp>
    event: created
    to: draft
links:
  issue: <issue number if provided>
completed_at: null
archived_to: null
```

### Content Rules

- Fill in everything you know — do NOT leave `{{placeholder}}` when real data is available
- Use `{{placeholder}}` ONLY for information you genuinely don't have
- Generate in `artifact_language` from config
- Use evidence from codebase investigation, not assumptions
- Cross-reference with ARCHITECTURE.md for file placement rules
- For markdown plan artifacts, write YAML frontmatter first using the shared metadata contract
- Quote string-valued frontmatter placeholders so sequential ids like `003` and titles containing `:` or `[]` remain valid YAML strings
- `artifact_status` for newly created plan artifacts should start as `draft`
- Keep `status.yaml` YAML-native; do not wrap it or duplicate mutable workflow state into markdown frontmatter
- All initial templates in `references/` are in English; translate generated artifact content to configured language when `artifact_language` is not English

---

## Step 4: Report and Handoff

Show the created plan:

```
## Plan Created ✅

📁 `.ai-factory/plans/<plan-id>/`

| Artifact | Status | Description |
|----------|--------|-------------|
| task.md | ✅ Ready | <brief summary> |
| context.md | ✅ Ready | <N key files mapped> |
| rules.md | ✅ Ready | <N rules defined> |
| verify.md | ✅ Ready | <N checkpoints> |
| status.yaml | ✅ Draft | Plan initialized |
 | explore.md | ✅/— | Copied from RESEARCH.md / Not applicable |

### Next Steps

1. 📝 Review artifacts — Check task.md scope and rules.md constraints
2. 🔍 /aif-explore <plan-id> — If more research needed
3. 🚀 /aif-improve — Refine the plan (auto-recommended)
4. 🚀 /aif-implement — When ready to start coding
```

```
AskUserQuestion: What would you like to do next?

Options:
1. Review plan artifacts — Open task.md for review
2. Start exploring — Run /aif-explore for deeper research
3. Improve plan first — Run /aif-improve (recommended)
4. Start implementing — Run /aif-implement
5. Done for now — I'll review later
```

If user chooses improve (or if project policy enables auto-improve), immediately hand off to `/aif-improve` with the created plan context.

---

## Context + Rules + Templates Model

This skill follows the [context-rules-templates-model.md](references/context-rules-templates-model.md):

| Level | Context | Rules |
|-------|---------|-------|
| **Project** | config.yaml, DESCRIPTION.md, RESEARCH.md | ARCHITECTURE.md, RULES.md, rules/base.md, rules/*.md |
| **Plan** | task.md, context.md, explore.md | rules.md, verify.md, constraints-*.md |

Plan artifacts **inherit** from project level. Plan rules can **add to** but not **replace** project rules.

---

## Rules

- **Read `.ai-factory/config.yaml` first** for project settings
- **Read skill-context overrides** before generating artifacts
- **Create plan folder only under** `.ai-factory/plans/`
- **Never overwrite existing plans** — generate unique plan id
- **Keep file names in English** — always
- **Generate content** in configured `artifact_language`
- **Fill real data** where available, use `{{placeholder}}` only for unknowns
- **Do not start implementation** — only create the plan structure
- **Import exploration** from RESEARCH.md when available and relevant
- **Normalize RESEARCH.md into plan/explore.md** when RESEARCH exists
- **Do not auto-capture** — always ask before importing exploration

## Anti-patterns

- ❌ Creating plan with all `{{placeholder}}` — investigate first, fill what you can
- ❌ Skipping codebase investigation — always check relevant files
- ❌ Auto-importing RESEARCH.md without asking — user must confirm
- ❌ Copying RESEARCH.md verbatim into `explore.md` without adding plan-local metadata
- ❌ Creating constraints-*.md files by default — only when specific constraints identified
- ❌ Starting implementation — this skill only creates plan structure

---

## Step 5: Create Area Rules (If Needed)

When the plan requires area-specific rules that don't exist in the project:

### 5.1 Identify Needed Area Rules

Based on plan scope, determine if area-specific rules would help:

| Plan Touches | Consider Creating | Only If |
|--------------|-------------------|---------|
| API endpoints | `rules/api.md` | Not already exists |
| Frontend components | `rules/frontend.md` | Not already exists |
| Backend services | `rules/backend.md` | Not already exists |
| Database schema/queries | `rules/database.md` | Not already exists |
| Logging/observability | `rules/logging.md` | Not already exists |
| Test suites | `rules/testing.md` | Not already exists |

### 5.2 Ask Before Creating

```
AskUserQuestion: This plan touches {{area}}. Would you like to create area-specific rules?

Creating `.ai-factory/rules/{{area}}.md` would help ensure consistent implementation across similar plans.

Options:
1. Yes — Create rules/{{area}}.md with project-specific conventions
2. No — Use only base rules
```

### 5.3 Create Area Rules File

If user confirms:
1. Create `.ai-factory/rules/{{area}}.md` with area-specific conventions
2. Infer conventions from existing code in that area
3. Update `config.yaml` to reference new rules file:
   ```yaml
   rules:
     base: .ai-factory/rules/base.md
     {{area}}: .ai-factory/rules/{{area}}.md  # ← Add this line
   ```

### 5.4 Reference in Plan Rules

Add reference to the plan's `rules.md`:
```markdown
## Inherited Rules

- [Project Base Rules](../../rules/base.md)
- [{{Area}} Rules](../../rules/{{area}}.md)  # If created
```

**Note:** Only create area rules when genuinely needed. Don't create empty or generic rule files.
