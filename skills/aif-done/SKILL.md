---
name: aif-done
description: Finalize a plan, mark it complete, and archive artifacts to specs/. Use after /aif-verify passes or when manually marking work as done.
argument-hint: "[plan-id] [--summary] [--force]"
allowed-tools: Read Write Glob Grep Bash(mkdir *) Bash(cp *) Bash(rm -rf *) question questionnaire
version: 0.7.0
---

# AIF Done — Finalize and Archive Plan

Finalize a plan by marking it complete, archiving artifacts to `.ai-factory/specs/`, and optionally updating project context.

> **See [Question Tool Reference](../shared/QUESTION-TOOL.md)** — question/questionnaire formats for different agents.

**This is a workflow terminus.** After `aif-done`, the plan is archived and the cycle is complete.

---

## Artifact Ownership

- **Primary ownership:** `.ai-factory/specs/<plan-id>/` (created), `plans/<plan-id>/status.yaml` (final update).
- **Creates:** `specs/<plan-id>/spec.md`, updates `specs/index.yaml`.
- **Read-only:** All plan artifacts (copied, not modified), all project context files.
- **Suggest-only:** Updates to DESCRIPTION.md, ARCHITECTURE.md, ROADMAP.md — suggest commands, do not auto-modify.

---

## Step 0: Load Context

### 0.1 Load Skill-Context Overrides

**Read `.ai-factory/skill-context/aif-done/SKILL.md`** — MANDATORY if the file exists.

Treat skill-context rules as project-level overrides:
- When a skill-context rule conflicts with this SKILL.md, **the skill-context rule wins**.
- **CRITICAL:** If a skill-context rule says "finalization MUST include X" — you MUST comply.

### 0.2 Find Plan Folder

```
1. If $ARGUMENTS contains plan-id → use .ai-factory/plans/<plan-id>/
2. Else get current branch → look for matching plan
3. Else list available plans → ask user
```

If no plan found:
```
No plan folder found. Nothing to finalize.
```
→ STOP.

### 0.3 Load Plan Artifacts

Read all artifacts from the plan folder:
- `task.md`, `context.md`, `rules.md`, `verify.md`, `status.yaml`
- `explore.md`, `constraints-*.md` (if present)
- `fixes/*.md` (if present)

For markdown plan artifacts:
- inspect YAML frontmatter first for artifact identity and traceability
- if frontmatter is missing, treat the file as a legacy artifact and continue with the existing body-first read path

### 0.4 Load Project Context

- `.ai-factory/config.yaml` — localization for summary output
- `.ai-factory/DESCRIPTION.md` — to check for needed updates
- `.ai-factory/ARCHITECTURE.md` — to check for architecture changes
- `.ai-factory/ROADMAP.md` — to suggest milestone completion
- `.ai-factory/RULES.md` — additional project conventions (if present)
- `.ai-factory/rules/base.md` — base project rules via `config.rules.base`

---

## Step 1: Verify Completion Eligibility

### Normal Mode

Check `status.yaml`:
- `status` should be `verifying` (verification just passed)
- `verification.verdict` should be `pass` or `pass-with-notes`

Acceptable completion state:
- `status: verifying` with `verification.verdict: pass|pass-with-notes`
- If status is stale but the latest verification verdict is pass/pass-with-notes, prefer the verdict and warn about status drift

If NOT eligible:
```
question(questions: [{
  header: "Status",
  question: "Plan status: \"{{current_status}}\" with verdict \"{{verdict}}\".\n\nPlan has not passed verification yet.",
  options: [
    { label: "Run verification (Recommended)", description: "/aif-verify" },
    { label: "Force finalize (--force)", description: "Without verification" },
    { label: "Cancel", description: "Exit" }
  ]
}])
```

### Force Mode (`--force`)

Skip verification check. Mark as done regardless of status.
Add warning to spec.md: `⚠️ Completed without passing verification.`

---

## Step 2: Gather Completion Evidence

### 2.1 Files Changed

```bash
# Get files changed during this plan
git diff --name-only main...HEAD
# Or use git log if on main
git log --oneline --since="<status.yaml.created>"
```

### 2.2 Verification Results

From `status.yaml → verification`:
- Last run timestamp
- Verdict
- Findings counts and resolutions

### 2.3 Fix History

From `status.yaml → fixes`:
- Total fixes applied
- Fix iterations count
- Individual fix descriptions

If `plans/<plan-id>/fixes/` exists:
- include fix artifact filenames as additional completion evidence
- use them as input for final lessons/evolution prompts

---

## Step 3: Generate Completion Summary

Create `spec.md` using [spec-template.md](references/spec-template.md):

**Fill in from plan artifacts:**
- **Metadata** — write YAML frontmatter using the shared artifact metadata contract for archived specs
- **Summary** — from `task.md → Summary`
- **Scope Delivered** — from `task.md → Scope → In Scope` (mark completed/deferred)
- **Key Changes** — from `CHANGED_FILES` with change descriptions
- **Verification Results** — from `status.yaml → verification`
- **Findings Resolved** — from `status.yaml → fixes.applied`
- **Decisions Made** — from `rules.md` key decisions, `explore.md` decisions
- **References** — plan path, issue/PR numbers from `status.yaml → links`

### With `--summary` Flag

Generate an extended summary including:
- Detailed file change list (created/modified/deleted counts)
- Test statistics
- Time tracking (created → completed duration)
- Lessons learned (ask user):

```
question(questions: [{
  header: "Lessons",
  question: "Are there any lessons learned from this plan?",
  options: [
    { label: "Yes — Add lessons", description: "I have notes to capture" },
    { label: "Skip", description: "No lessons this time" }
  ]
}])
```

---

## Step 4: Archive to Specs

### 4.1 Create Specs Directory

```bash
mkdir -p .ai-factory/specs/<plan-id>
```

### 4.2 Copy Plan Artifacts

Copy all files from `plans/<plan-id>/` to `specs/<plan-id>/`:
- `task.md`
- `context.md`
- `rules.md`
- `verify.md`
- `status.yaml`
- `explore.md` (if exists)
- `constraints-*.md` (if exist)
- `fixes/*.md` (if exist)

### 4.3 Create spec.md

Write the generated spec.md to `specs/<plan-id>/spec.md`.

### 4.4 Update specs/index.yaml

Read existing `specs/index.yaml` (or create from [index-schema.yaml](references/index-schema.yaml) if missing).

Append new entry:
```yaml
specs:
  # ... existing entries ...
  - id: <plan-id>
    title: "<task title from task.md>"
    completed: <today YYYY-MM-DD>
    verdict: <verification verdict>
    files_changed: <count>
    tags: [<derived from task/context>]
    issue: <from status.yaml.links.issue>
    pr: <from status.yaml.links.pr>
```

Update stats:
```yaml
stats:
  total: <incremented>
  by_verdict:
    pass: <updated>
    pass-with-notes: <updated>
```

---

## Step 5: Update Plan Status

Update `plans/<plan-id>/status.yaml`:

```yaml
status: done
updated: <current ISO timestamp>
completed_at: <current ISO timestamp>
archived_to: .ai-factory/specs/<plan-id>/

history:
  # ... existing entries ...
  - timestamp: <current ISO timestamp>
    event: completed
    to: done
```

---

## Step 6: Suggest Context Updates

Check if project context needs updates based on implementation:

### DESCRIPTION.md

If new dependencies, modules, or integrations were added:
```
📝 DESCRIPTION.md may need updates:
- New dependency: <package> (detected in package.json/go.mod/etc.)
- New module: <path> (new directory created)

Suggestion: Run /aif-analyze to refresh project description.
```

### ARCHITECTURE.md

If new patterns or layers were introduced:
```
📐 ARCHITECTURE.md may need updates:
- New module boundary: <path>
- New dependency pattern: <description>

Suggestion: Run /aif-architecture to refresh.
```

### ROADMAP.md

If this plan corresponds to a roadmap milestone:
```
🗺️ ROADMAP.md milestone may be complete:
- Milestone: "<milestone name>"
- Evidence: Plan <plan-id> completed

Suggestion: Run /aif-roadmap check
```

**Do NOT auto-modify these files.** Only suggest the appropriate commands.

---

## Step 7: Optional Docs and Evolution

Before cleanup, handle two optional post-actions while the original plan folder is still available.

### Documentation checkpoint

Ask:

```
question(questions: [{
  header: "Documentation",
  question: "How should we document this feature?",
  options: [
    { label: "Update existing docs (Recommended)", description: "/aif-docs" },
    { label: "Create feature page", description: "/aif-docs docs/<feature>.md" },
    { label: "Skip", description: "No documentation now" }
  ]
}])
```

Record outcome in completion output as one of:
- `Documentation: updated existing docs`
- `Documentation: created docs/<feature-slug>.md`
- `Documentation: skipped by user`
- `Documentation: warn-only (Docs: no/unset)`

### Evolution checkpoint

If plan contains fix artifacts (`plans/<plan-id>/fixes/*.md`) or rich findings history:

```
question(questions: [{
  header: "Evolution",
  question: "Run evolution from this plan context?",
  options: [
    { label: "Yes — /aif-evolve (Recommended)", description: "Use plan/fixes as evidence" },
    { label: "No — Skip", description: "Without evolution" }
  ]
}])
```

When enabled, use the completed plan folder as the evidence base for evolution suggestions.

---

## Step 8: Clean Up Plan Folder

```
question(questions: [{
  header: "Cleanup",
  question: "Plan archived to .ai-factory/specs/<plan-id>/\n\nDelete original plan folder?",
  options: [
    { label: "Delete .ai-factory/plans/<plan-id>/ (Recommended)", description: "Keep archive only" },
    { label: "Keep both copies", description: "Retain plan and archive" }
  ]
}])
```

If remove:
```bash
rm -rf .ai-factory/plans/<plan-id>
```

---

## Step 9: Completion Report

```
## Plan Finalized ✅

### <plan-id>: <task title>

| | |
|---|---|
| **Completed** | <date> |
| **Verdict** | <verdict> |
| **Files Changed** | <count> |
| **Archived to** | `.ai-factory/specs/<plan-id>/` |

### Artifacts Archived
- spec.md — Completion summary
- task.md — Original task definition
- context.md — Implementation context
- rules.md — Rules and constraints
- verify.md — Verification results
- status.yaml — Full workflow history
- fixes/*.md — Fix history artifacts (if any)

### Suggested Updates
- /aif-analyze — Refresh project description (if stack changed)
- /aif-roadmap check — Update milestone progress

---

Ready to start a new plan? Run /aif-new
```

### Context Cleanup

```
question(questions: [{
  header: "Context",
  question: "Free up context before continuing?",
  options: [
    { label: "/clear — Full reset (Recommended)", description: "After plan completion" },
    { label: "/compact — Compress history", description: "Compact mode" },
    { label: "Continue as is", description: "No changes" }
  ]
}])
```

---

## Specs Organization

```
.ai-factory/specs/
├── index.yaml              # Catalog of all completed specs
└── <plan-id>/
    ├── spec.md             # Summary document (generated)
    ├── task.md             # Original task
    ├── context.md          # Context at completion time
    ├── rules.md            # Rules used
    ├── verify.md           # Final verification results
    ├── status.yaml         # Full workflow history
    ├── explore.md          # Exploration notes (if any)
    └── fixes/              # Fix artifacts (if any)
```

**Concept:**
- `.ai-factory/plans/` = active work
- `.ai-factory/specs/` = accepted/finalized knowledge

Specs serve as:
- Historical record of completed work
- Knowledge base for future plans (patterns, decisions)
- Evidence for ROADMAP.md milestone tracking
- Input for `/aif-roadmap` maturity assessment

---

## Rules

- **Only mark done after verification passes** (or with `--force` + user confirmation)
- **Always archive to specs/** before marking done
- **Preserve ALL original artifacts** in archive — don't filter or modify
- **Create spec.md** as the summary/entry point document
- **Update index.yaml** with every new spec
- **Suggest context updates** but never auto-modify DESCRIPTION.md, ARCHITECTURE.md, ROADMAP.md
- **Keep full history trail** in status.yaml
- **Ask about cleanup** — don't auto-delete plan folder
- **Read skill-context overrides** — project-specific finalization rules take priority

## Anti-patterns

- ❌ Marking done without verification (unless --force)
- ❌ Auto-modifying project context files
- ❌ Deleting plan folder without asking
- ❌ Creating spec.md without actual completion evidence
- ❌ Forgetting to update index.yaml
- ❌ Skipping status.yaml history update
