---
name: aif-improve-plus
description: Refine plan-folder artifacts with deeper codebase analysis, status sync, and optional Claude plan-polisher delegation. Replaces /aif-improve.
argument-hint: "[plan-id|@path|--list] [improvement prompt] [--local|--subagent]"
allowed-tools: Read Glob Grep Write Edit Bash(git *) question questionnaire
version: 0.7.0
---

> **Reference:** [Question Tool](../shared/QUESTION-TOOL.md) — question/questionnaire formats for different agents

# AIF Improve+ — Refine Plan Folder

Refine an existing plan folder by re-analyzing it against the codebase. Find missing tasks, weak scope definitions, wrong assumptions, stale context, and status schema drift before implementation starts.

This skill replaces core `/aif-improve` in this extension. It is optimized for:

- plan folders: `.ai-factory/plans/<plan-id>/`
- plan artifacts: `task.md`, `context.md`, `rules.md`, `verify.md`
- workflow metadata: `status.yaml`
- optional Claude `plan-polisher` delegation with strict local fallback

---

## Artifact Ownership

- **Primary ownership:** `plans/<plan-id>/task.md`, `context.md`, `rules.md`, `verify.md`, `status.yaml`.
- **Read-only:** source code, `.ai-factory/RESEARCH.md`, `.ai-factory/DESCRIPTION.md`, `.ai-factory/ARCHITECTURE.md`, `.ai-factory/RULES.md`, `.ai-factory/ROADMAP.md`.
- **No writes to:** project source code, `specs/`, other plans, bridge files.

---

## Workflow

### Step 0: Parse Arguments and Discover Plans

Parse `$ARGUMENTS` first:

- `--list` -> list available plan folders only, STOP
- `@<path>` -> explicit plan path override (highest priority)
- `<plan-id>` -> explicit plan id
- remaining argument text -> optional refinement prompt
- `--local` -> force local refinement mode
- `--subagent` -> prefer Claude `plan-polisher` mode with local fallback

### Step 0.list: List Available Plans (`--list`)

If `$ARGUMENTS` contains `--list`:

1. List folders under `.ai-factory/plans/`
2. Keep folders that contain `status.yaml`
3. Read for each plan:
   - `plan_id`, `title`, `status`
   - `progress.scope_total`, `progress.scope_completed`
   - `updated`
4. Print availability summary and usage hints
5. STOP

In `--list` mode:
- do not refine plans
- do not modify files
- do not update statuses

Reference: `references/REFINEMENT-GUIDE.md`

### Step 0.1: Load Project Context

Read if present:

- `.ai-factory/config.yaml`
- `.ai-factory/DESCRIPTION.md`
- `.ai-factory/ARCHITECTURE.md`
- `.ai-factory/RULES.md`
- `.ai-factory/rules/base.md`
- `.ai-factory/RESEARCH.md`

Read skill-context in this order:

1. `.ai-factory/skill-context/aif-improve-plus/SKILL.md`
2. `.ai-factory/skill-context/aif-improve/SKILL.md` (compatibility fallback)

If a skill-context file exists:
- treat it as a project-level override
- plus-path wins over legacy-path when both exist
- enforce it across all artifact updates

Patch fallback (only when no skill-context exists):
- read up to 10 latest `.ai-factory/patches/*.md`
- prioritize Root Cause / Prevention sections

### Step 0.2: Resolve Active Plan Folder

Plan resolution priority:

1. `@<path>` argument
2. explicit `<plan-id>` argument
3. current branch slug match (`feature/x` -> `feature-x`) against plan folder name
4. single active plan (`status != done`)
5. ask user to choose from active plans

Path override behavior:

- if path is a plan folder, use it
- if path is `task.md`, `context.md`, `rules.md`, `verify.md`, or `status.yaml`, use its parent folder
- if path points to a legacy plan file (`PLAN.md`, `FIX_PLAN.md`, `plans/<branch>.md`):
  - warn that this extension uses plan folders, not legacy plan files
  - suggest migrating the plan into `.ai-factory/plans/<plan-id>/`
  - STOP

If no plan folder is found:

```
No active plan folder found in .ai-factory/plans.

Options:
1. Create a new plan (/aif-new "<task>") (recommended)
2. Show available plans (--list)
3. Cancel
```

If the selected plan has `status: done`, stop and suggest using the archived spec or creating a new plan.

### Step 0.3: Resolve Refinement Mode (Local vs Subagent)

Subagent mode is optional and Claude-only.

Detect availability:
- `.claude/agents/plan-polisher.md`

Mode rules:
- `--local` -> force local mode
- `--subagent` -> prefer subagent mode (fallback to local if unavailable)
- no explicit flag -> auto:
  - if `plan-polisher` exists: ask user once
  - else local mode

When `plan-polisher` is available and mode is not forced, ask:

```
question(questions: [{
  header: "Mode",
  question: "Claude plan-polisher detected. How should I refine this plan?",
  options: [
    { label: "Subagent mode (Recommended)", description: "Delegate to plan-polisher" },
    { label: "Local mode", description: "Execute in current context" }
  ]
}])
```

### Step 1: Load Plan Artifacts

Read all present artifacts from the plan folder:

- `task.md`
- `context.md`
- `rules.md`
- `verify.md`
- `status.yaml`
- `explore.md`
- `constraints-*.md`

For markdown plan artifacts:
- inspect YAML frontmatter first for artifact identity/freshness checks
- if frontmatter is missing, treat the file as a legacy artifact and fall back to the existing full-body read path

Understand:
- plan goal and motivation
- In Scope / Out of Scope items
- acceptance criteria
- key files and constraints
- implementation / testing / documentation rules
- current progress and completed checkboxes

Preserve completed work:
- never remove `- [x]` items without explicit user approval
- never reduce `progress.scope_completed` below the number of checked In Scope items

### Step 2: Deep Plan Analysis

Re-analyze the codebase more deeply than `aif-new` did.

#### 2.1 Codebase Trace

Use `Glob`, `Grep`, and `Read` to inspect:

- files listed in `context.md`
- files and modules implied by `task.md`
- nearby integration points, configs, docs, and shared utilities

Look for:
- existing patterns the plan should follow
- hidden dependencies or prerequisites
- missing integration points
- tasks that are already partially implemented
- reusable services/utilities the plan should reference

#### 2.2 Artifact Quality Review

Check for issues in the plan artifacts themselves:

- vague or duplicated In Scope items
- missing acceptance criteria
- weak or missing context/rules
- verify checklist not aligned with scope/rules
- missing testing/docs requirements
- stale `status.yaml` schema or counters

#### 2.3 Prompt-Driven Refinement

If the user included a refinement prompt in `$ARGUMENTS`, incorporate it into the analysis and recommendations.

### Step 3: Build a Refinement Report

Categorize findings into:

- missing scope items
- task wording improvements
- context gaps
- rules/testing/docs gaps
- verify checklist gaps
- status schema / metadata drift
- removals or merges (only when clearly justified)

Show a concise report:

```
## Plan Refinement Report

Plan: <plan-id>
Mode: local|subagent

Missing scope items: N
Artifact improvements: N
Verify/rules sync fixes: N
Metadata/schema fixes: N

Apply the recommended refinements?

Options:
1. Apply all recommended changes (recommended)
2. Keep the plan as is
3. Cancel
```

If no material improvements are found:

```
## Plan Review Complete

The plan already looks consistent for the current workflow.

Next step:
/aif-implement
```

### Step 4: Apply Approved Refinements

Apply improvements surgically.

#### 4.1 Update `task.md`

- add missing In Scope items and acceptance criteria
- tighten vague wording with specific outcomes and file references when known
- preserve and refresh YAML frontmatter (`updated_at`, traceability fields when needed)
- preserve completed checkboxes
- avoid rewriting the entire file unless the structure is badly degraded

#### 4.2 Update `context.md`

- add relevant files, patterns, constraints, and integration points discovered during analysis
- preserve and refresh YAML frontmatter
- keep content evidence-based, not speculative

#### 4.3 Update `rules.md`

- add or tighten implementation rules, testing expectations, and documentation requirements
- preserve and refresh YAML frontmatter
- keep inherited project rules intact

#### 4.4 Update `verify.md`

- align checklist entries with updated scope, rules, and acceptance criteria
- preserve and refresh YAML frontmatter
- keep Findings/Verdict sections intact

#### 4.5 Sync `status.yaml`

- refresh `updated`
- ensure current schema keys exist (`execution.*`, `fixes.files`, `completed_at`, `archived_to`)
- recalculate `progress.scope_total` from In Scope items
- preserve `progress.scope_completed` based on checked items
- append a history entry

Example:

```yaml
updated: <current ISO timestamp>

history:
  - timestamp: <current ISO timestamp>
    event: improved
    details:
      mode: local|subagent
      summary: "Aligned task/context/rules/verify artifacts with codebase findings"
```

Do not regress `status` unless the user explicitly asks.

#### 4.6 Optional Subagent Delegation

If in subagent mode:

- delegate plan review to `plan-polisher`
- require a response contract with:
  - recommended edits by artifact
  - rationale for each change
  - any blockers or unresolved questions
- verify and apply the suggested changes locally before writing artifacts

If delegation fails:
- record a warning in the plan history when possible
- continue in local mode

### Step 5: Completion Output

After applying refinements:

```
## Plan Refined

Plan: <plan-id>
Mode: local|subagent

Updated artifacts:
- task.md
- context.md
- rules.md
- verify.md
- status.yaml

Next step:
1. /aif-implement (recommended)
2. /aif-explore <plan-id> (if more discovery is needed)
```

### Context Cleanup

```
question(questions: [{
  header: "Context",
  question: "Free up context before continuing?",
  options: [
    { label: "/clear — Full reset (Recommended)", description: "Clear entire context" },
    { label: "/compact — Compress history", description: "Compact mode" },
    { label: "Continue as is", description: "No changes" }
  ]
}])
```

---

## Rules

1. **Refine plan folders only** — do not fall back to legacy plan files
2. **Do not modify source code** — this skill only improves plan artifacts
3. **Preserve completed work** — never delete completed checkboxes silently
4. **Use evidence-based refinements** — every change must be justified by codebase analysis or user input
5. **Keep artifacts synchronized** — `task.md`, `context.md`, `rules.md`, `verify.md`, and `status.yaml` must agree after refinement
6. **Preserve markdown metadata blocks** — when frontmatter exists, keep it valid and refresh `updated_at` instead of stripping it
7. **Do not gold-plate** — suggest only changes that matter to the plan quality or workflow consistency
8. **No hard dependency on subagents** — local refinement must always work

## Anti-patterns

- ❌ Sending users to `PLAN.md` or branch-named plan files in the extension workflow
- ❌ Rewriting the plan from scratch without need
- ❌ Removing completed items because they are inconvenient to sync
- ❌ Updating `status.yaml` counters without syncing checkbox reality
- ❌ Modifying application code during refinement
- ❌ Making subagent mode mandatory
