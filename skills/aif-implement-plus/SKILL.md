---
name: aif-implement-plus
description: Execute plan-folder tasks with progress persistence, verify/fix loop, and optional Claude subagent delegation. Replaces /aif-implement.
argument-hint: "[plan-id|@path|status|--list] [--from <n>] [--local|--subagent]"
allowed-tools: Read Write Edit Glob Grep Bash(git *) Bash(mkdir *) Bash(cp *) Bash(basename *) question questionnaire Task
version: 0.7.0
---

> **См. [Question Tool Reference](../shared/QUESTION-TOOL.md)** — форматы question/questionnaire для разных агентов.

# AIF Implement+ — Execute Task Plan

Execute tasks from plan folders, track progress in `status.yaml`, and support session continuation.

This skill replaces core `/aif-implement` in this extension. It is optimized for:

- plan folders: `.ai-factory/plans/<plan-id>/`
- task checkboxes in `task.md`
- workflow state in `status.yaml`
- optional Claude subagent acceleration with strict local fallback

---

## Artifact Ownership

- **Primary ownership:** `plans/<plan-id>/status.yaml` and task checkboxes in `plans/<plan-id>/task.md`.
- **May modify:** source code files required by the current task.
- **Allowed context updates (evidence-based only):** `.ai-factory/DESCRIPTION.md`, `.ai-factory/ARCHITECTURE.md`, milestone completion in `.ai-factory/ROADMAP.md`.
- **Read-only by default:** `.ai-factory/RULES.md`, `.ai-factory/RESEARCH.md`, all other plan/spec artifacts.
- **No writes to:** `specs/` (owned by `aif-done`), other plans.

---

## Workflow

### Step 0: Check Current State

Always start with:

1. Parse arguments:
   - `--list` → list plans only, STOP
   - `@<path>` → explicit plan path override
   - `status` → status-only mode
   - `<number>` or `--from <number>` → start from specific task index
   - `<plan-id>` → explicit plan id
2. Check uncommitted changes (`git status`)
3. Check current branch (`git branch --show-current`)

### Step 0.list: List Available Plans (`--list`)

If `$ARGUMENTS` contains `--list`:

1. List folders under `.ai-factory/plans/`
2. Keep folders with `status.yaml`
3. For each plan, read:
   - `plan_id`, `title`, `status`
   - `progress.scope_total`, `progress.scope_completed`
   - `updated`
4. Print summary and usage hints
5. STOP

In `--list` mode:
- do not execute tasks
- do not modify files
- do not update statuses

Reference: `references/IMPLEMENTATION-GUIDE.md`

### Step 0.0: Resume / Recovery

If session context may be stale (next day, abandoned session, after `/clear`):

1. `git status`
2. `git branch --show-current`
3. `git log --oneline --decorate -20`
4. optional `git diff --stat`
5. optional `git stash list`

Then reconcile:
- `task.md` checkboxes vs `status.yaml.progress`
- `status.yaml.execution.current_task` vs actual file state

If uncommitted changes exist, ask user:

```
You have uncommitted changes. Continue?

Options:
1. Continue with current changes (recommended)
2. Commit first (/aif-commit)
3. Cancel
```

### Step 0.1: Load Project Context

Read if present:

- `.ai-factory/DESCRIPTION.md`
- `.ai-factory/ARCHITECTURE.md`
- `.ai-factory/RULES.md`
- `.ai-factory/config.yaml`
- `.ai-factory/rules/base.md`

Read skill-context in this order:

1. `.ai-factory/skill-context/aif-implement-plus/SKILL.md`
2. `.ai-factory/skill-context/aif-implement/SKILL.md` (compatibility fallback)

Skill-context rules are project overrides:
- if conflict with this file -> skill-context wins
- apply both when no conflict
- enforce before finalizing task state updates
- when both plus and legacy skill-context files exist, the plus-path wins

Patch fallback (only when skill-context missing):
- read up to 10 latest `.ai-factory/patches/*.md`
- prioritize Root Cause / Prevention sections

### Step 0.2: Resolve Active Plan Folder

Plan resolution priority:

1. `@<path>` argument (highest)
2. explicit `<plan-id>` argument
3. current branch slug match (`feature/x` -> `feature-x`) against plan folder name
4. single active plan (`status != done`)
5. ask user to choose from active plans

Path override behavior:

- if path is a plan folder, use it
- if path is `status.yaml` or `task.md`, use its parent folder
- if path is `.ai-factory/FIX_PLAN.md`, treat it as legacy input:
  - warn that this extension uses plan folders, not FIX_PLAN.md
  - suggest selecting a plan folder or migrating the fix work into `.ai-factory/plans/<plan-id>/`
  - STOP

If no plan found:

```
No active plan found in .ai-factory/plans.

Options:
1. Create a new plan (/aif-new "<task>" -> /aif-improve) (recommended)
2. Show available plans (--list)
3. Cancel
```

### Step 0.3: Resolve Execution Mode (Local vs Subagent)

Subagent mode is optional and Claude-only.

Detect availability:
- `.claude/agents/implementer.md`
- `.claude/agents/implementer-isolation.md`

Mode rules:
- `--local` -> force local mode
- `--subagent` -> prefer subagent mode (fallback to local if unavailable)
- no explicit flag -> auto:
  - if subagents available: ask user once
  - else local mode

When subagents are available and mode is not forced, ask:

```
question(questions: [{
  header: "Режим",
  question: "Обнаружены Claude subagents. Как should I execute this plan?",
  options: [
    { label: "Subagent mode (Рекомендуется)", description: "Делегировать выполнение subagent" },
    { label: "Local mode", description: "Выполнять в текущем контексте" }
  ]
}])
```

Save mode to `status.yaml`:

```yaml
execution:
  mode: local|subagent
  subagent: implementer|implementer-isolation|null
  mode_resolved_at: <ISO timestamp>
```

Preserve any existing `execution.git.*` fields when updating mode metadata. `aif-implement-plus` must not drop the git strategy already chosen by `/aif-apply`.

Fallback rule:
- if subagent invocation fails, log warning and continue in local mode

### Step 1: Load Task State

Task source of truth:
- `task.md -> Scope -> In Scope` checkbox list in the markdown body

For `task.md`:
- read YAML frontmatter first when present to validate artifact identity
- then parse/update the checkbox list from the body below the frontmatter
- if frontmatter is missing, fall back to the legacy body-only parsing path

Status source of truth:
- `status.yaml -> progress` and `status.yaml -> execution`

If `--from N` or numeric argument is provided:
- set next task index to `N`
- mark previous task (if any) as paused in history

If an `in_progress` task exists in status metadata, resume it first.

Before starting the first task, set:

```yaml
status: implementing
```

### Step 2: Display Progress

Print concise progress view:

```
## Implementation Progress

Completed: 3/8
In Progress: #4
Pending: 4
Mode: local|subagent
Plan: <plan-id>
```

### Step 3: Execute Current Task (One-by-One)

For each pending task:

1. mark task as `in_progress` in `status.yaml`
   - set `execution.current_task` to the active task index/title
2. implement task
3. quick verification (buildability/functionality relevant to task)
4. mark task complete in `status.yaml`
   - clear or advance `execution.current_task`
5. update `task.md` checkbox immediately (`- [ ]` -> `- [x]`)
   - preserve any existing YAML frontmatter and do not rewrite metadata keys unintentionally
6. sync `progress.scope_completed`
7. refresh `updated` timestamp
8. append history entry

#### 3.1 Local Implementation

- read relevant files
- apply minimal necessary changes
- follow existing patterns
- do not add tests unless plan explicitly includes test tasks
- do not produce summary/report documents

#### 3.2 Subagent Implementation (Optional)

If in subagent mode:

- delegate current task to selected Claude agent (`implementer` or `implementer-isolation`)
- require response contract:
  - changed files
  - completion evidence
  - blockers (if any)
- verify changes locally before marking task complete

If delegation fails:
- record warning in status history
- continue in local mode

#### 3.3 Context Maintenance During Execution

Update only when evidence is concrete:

- `DESCRIPTION.md`: new dependency/integration/stack delta
- `ARCHITECTURE.md` + `AGENTS.md`: new module/folder/entrypoint
- `ROADMAP.md`: mark milestone complete only when mapping is clear

Never edit `.ai-factory/RULES.md` from this command.

### Step 4: Post-Task Quality and Verify/Fix Loop

When all In Scope tasks are checked:

1. run quality checks declared in plan rules (or project defaults)
2. invoke `/aif-verify`
3. if verdict is FAIL -> invoke `/aif-fix` and re-run `/aif-verify`
4. repeat until PASS or loop limit reached

Status ownership during the loop:
- `aif-implement` sets `status: implementing` while tasks are being executed
- `aif-verify` sets `status: verifying`
- `aif-fix` sets `status: fixing`
- `aif-done` sets `status: done`
- do not introduce a separate terminal pre-done status unless the schema is updated everywhere

Loop limit:
- default `3`
- configurable via `status.yaml`:

```yaml
execution:
  max_fix_loops: 3
```

Update only `execution.max_fix_loops`; do not replace the whole `execution` object or remove sibling fields such as `execution.git`.

On loop limit reached, ask user whether to continue or stop.

### Step 5: Completion Handoff

When verification passes:

1. preserve the verification state written by `/aif-verify`
2. append a history note that implementation is complete and ready for finalization
3. show completion summary (no long report files)
4. suggest next command:
   - `/aif-done` (recommended)
   - `/aif-commit` (optional checkpoint)

Documentation policy is handled in `aif-done`.

---

## Commands

### Start / Resume

```bash
/aif-implement
```

### List plans

```bash
/aif-implement --list
```

### Explicit plan path

```bash
/aif-implement @.ai-factory/plans/my-plan
/aif-implement @.ai-factory/plans/my-plan/status.yaml status
```

### Start from task index

```bash
/aif-implement --from 3
/aif-implement 3
```

### Status only

```bash
/aif-implement status
```

### Force mode

```bash
/aif-implement --local
/aif-implement --subagent
```

---

## Execution Rules

### DO

- execute one task at a time
- mark in-progress before implementation
- mark completed only after local verification
- update `task.md` checkbox immediately after completion
- preserve YAML frontmatter when `task.md` uses the metadata contract
- keep `status.yaml` synchronized with actual state
- follow architecture and project rules
- preserve session continuity

### DON'T

- do not write tests unless explicitly in task list
- do not create report/summary documents
- do not add out-of-scope tasks
- do not skip tasks silently
- do not mark incomplete task as completed
- do not violate module boundaries in `ARCHITECTURE.md`

---

## Critical Rules

1. **ALWAYS sync checkbox + status together**
2. **ONE task at a time**
3. **NO silent fallback** — mode switches must be logged
4. **NO hard dependency on subagents** — local fallback must always work
5. **NO tests creation unless explicitly planned**
6. **NO summary docs generation in implement phase**
7. **ALWAYS run verify before done**

---

## Logging Requirements

Verbose, configurable logging is required during implementation.

- log function entry/exit
- log state changes and important branches
- log external calls and responses
- include rich error context
- support log levels via env/config (for example `LOG_LEVEL`)

Reference: `references/LOGGING-GUIDE.md`
