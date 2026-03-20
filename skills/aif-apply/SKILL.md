---
name: aif-apply
description: Manual orchestration entrypoint for plan execution, git strategy selection, verify/fix loops, and final handoff with optional Claude subagent acceleration.
argument-hint: "[plan-id|@path|status|--list] [--local|--subagent] [--git-new|--git-current|--git-default]"
version: 0.7.0
author: AIFHub Extension
---

# AIF Apply - Manual Workflow Orchestrator

Run the full spec-driven execution cycle from an active plan folder. `aif-apply` is the manual control point between planning and finalization: it selects the active plan, resolves execution mode, runs implementation, then drives verify/fix until the plan is ready for `aif-done`.

This skill is orchestration-first:

- manual trigger only - never auto-runs on plan creation
- plan-folder aware - works from `.ai-factory/plans/<plan-id>/`
- Claude-aware - can delegate to Claude subagents when available
- fallback-safe - preserves the same external workflow in local mode

---

## Artifact Ownership

- **Primary ownership:** `plans/<plan-id>/status.yaml` for orchestration state and runtime settings.
- **Delegates writes to:** source files via `aif-implement`, verification metadata via `aif-verify`, fix artifacts via `aif-fix`, archive artifacts via `aif-done`.
- **Read-only:** `task.md`, `context.md`, `rules.md`, `verify.md`, project context files, and source code except through delegated implementation/fix steps.
- **No writes to:** `specs/` directly, other plans, bridge files.

---

## Workflow

### Step 0: Parse Arguments and Discover Plans

Parse `$ARGUMENTS` first:

- `--list` -> list active plan folders only, then STOP
- `@<path>` -> explicit plan path override
- `<plan-id>` -> explicit plan id override
- `status` -> show orchestration status only
- `--local` -> force local orchestration mode
- `--subagent` -> prefer Claude subagent mode with local fallback

### Step 0.1: Load Project Context

Read if present:

- `.ai-factory/config.yaml`
- `.ai-factory/DESCRIPTION.md`
- `.ai-factory/ARCHITECTURE.md`
- `.ai-factory/RULES.md`
- `.ai-factory/rules/base.md`

Read skill-context in this order:

1. `.ai-factory/skill-context/aif-apply/SKILL.md`
2. `.ai-factory/skill-context/aif-implement-plus/SKILL.md` as compatibility guidance when apply-specific context does not exist

If a skill-context file exists, treat it as a project-level override and enforce it across all orchestration decisions.

### Step 0.2: Resolve Active Plan Folder

Plan resolution priority:

1. `@<path>` argument
2. explicit `<plan-id>` argument
3. current branch slug match against `.ai-factory/plans/<slug>/`
4. single active plan folder where `status != done`
5. list active plans and ask the user to choose when more than one unfinished plan remains

If no active plan exists, clearly report that there is nothing to execute and suggest `/aif-new`.

### Step 0.3: Resolve Git Strategy

Resolve git context before the first implementation pass.

Decision priority:

- `--git-new` -> use a new work branch for this plan
- `--git-current` -> continue on the current branch
- `--git-default` -> use the default branch only when explicitly requested
- existing `status.yaml -> execution.git.strategy` -> reuse the saved plan choice when resuming
- otherwise ask the user once before execution starts

Save the decision to `status.yaml -> execution`:

```yaml
execution:
  git:
    strategy: new|current|default|null
    work_branch: <branch name|null>
    base_branch: <branch name|null>
    resolved_at: <ISO timestamp|null>
```

Safety rules:

- never select the default branch implicitly
- never push, pull, or rewrite remote state automatically
- if branch creation or switching is unavailable, keep the chosen strategy recorded and continue only after confirming the local fallback path with the user

### Step 0.4: Resolve Orchestration Mode

Subagent mode is optional and Claude-only.

Detect availability:

- `.claude/agents/plan-polisher.md`
- `.claude/agents/implementer.md`
- `.claude/agents/implementer-isolation.md`

Mode rules:

- `--local` -> force local mode
- `--subagent` -> prefer delegated mode with local fallback
- no explicit flag -> default to local unless Claude-only workers are available and the user chooses delegation

Save the decision to `status.yaml -> execution`:

```yaml
execution:
  mode: local|subagent
  subagent: plan-polisher|implementer|implementer-isolation|null
  mode_resolved_at: <ISO timestamp>
```

When both delegated phases are used, record `plan-polisher` during readiness work and then update `execution.subagent` to the selected `implementer*` worker for task execution.

### Step 1: Load Plan State

Read plan artifacts:

- `task.md`
- `context.md`
- `rules.md`
- `verify.md`
- `status.yaml`
- `explore.md` and `constraints-*.md` when present

Use `status.yaml` as the runtime source of truth for:

- git strategy and branch context
- current execution mode
- quality check settings
- verify/fix loop counters
- current task handoff state

### Step 2: Run the Apply Cycle

#### 2.1 Readiness Gate

Before implementation starts:

1. inspect `task.md`, `rules.md`, and `status.yaml`
2. if the plan is not execution-ready, route to `/aif-improve`
3. when subagent mode is active and `.claude/agents/plan-polisher.md` is available, delegate the plan review to `plan-polisher`
4. require response contract from `plan-polisher`:
   - recommended artifact edits
   - rationale for each recommendation
   - blockers or unanswered questions
5. apply accepted artifact edits locally and record the delegation result in plan history

If `plan-polisher` is unavailable or delegation fails, continue with the same refine gate locally.

#### 2.2 Implementation Pass

Choose the implementation worker:

- local mode -> run the pending scope through `/aif-implement`
- subagent mode -> use `implementer-isolation` when plan constraints require isolation; otherwise use `implementer`

During execution:

1. set `status.yaml -> execution.current_task` before each task handoff
2. if in subagent mode, delegate the current task to `implementer` or `implementer-isolation`
3. require response contract from the worker:
   - changed files
   - completed task reference
   - blockers or follow-up actions
4. verify delegated changes locally before marking the task complete or advancing the plan state

If delegated execution fails or returns incomplete evidence:

- append a warning to `status.yaml -> history`
- switch `execution.mode` to `local` while preserving `execution.git`
- resume from the same task locally

#### 2.3 Deterministic Quality Gate

After each implementation pass, always run this exact order:

1. quality checks from `status.yaml -> execution.quality_checks`
2. `/aif-verify`
3. if verification fails, `/aif-fix`
4. re-run `/aif-verify`
5. repeat fix -> verify until `pass` / `pass-with-notes` or `execution.max_fix_loops` is reached

Rules for the loop:

- never skip re-verification after `/aif-fix`, even for small changes
- keep `plans/<id>/fixes/` and `status.yaml -> fixes` synchronized on every fix iteration
- stop and report unresolved findings when the loop limit is reached; do not force completion

#### 2.4 Final Handoff

- when verification passes, route to `/aif-done`
- preserve the saved git strategy and execution history for downstream archive/evolve steps

### Step 3: Fallback and Safety Rules

- If delegated subagent execution fails at any stage, log the reason in `status.yaml` history and continue in local mode.
- Never require Claude-only capabilities for the workflow to succeed.
- Never mutate remote git state automatically.
- Keep `aif-implement -> aif-verify -> aif-fix -> aif-done` usable as direct commands even when `aif-apply` is the recommended orchestrator.

### Step 4: Status-Only Mode

When invoked with `status`, show:

- resolved plan id
- current `status.yaml.status`
- completed vs total scope items
- current execution mode
- last verification verdict
- fix loop iteration count
- recommended next command

### Step 5: List Mode

When invoked with `--list`:

1. list plan folders under `.ai-factory/plans/`
2. keep folders containing `status.yaml`
3. read `plan_id`, `title`, `status`, and progress counters
4. print concise usage hints
5. STOP without modifying files

---

## Rules

- `aif-apply` is a manual orchestration entrypoint, not an auto-run hook.
- Use plan folders and `status.yaml`; do not fall back to legacy `PLAN.md` workflow as the canonical path.
- Preserve compatibility with direct `/aif-implement`, `/aif-verify`, `/aif-fix`, and `/aif-done` usage.
- Persist git strategy and mode decisions together in `status.yaml -> execution`.
- Use `plan-polisher` only for delegated plan refinement and `implementer*` only for delegated task execution.
- Claude subagents are optional acceleration only.
- All runtime execution decisions must be persisted in `status.yaml`.
- Prefer deterministic sequencing: implement -> quality checks -> verify -> fix -> re-verify.

## Anti-patterns

- ❌ Making `aif-apply` mandatory for all workflows
- ❌ Hard-coupling the extension to Claude-only APIs
- ❌ Skipping the git decision point or keeping it only in chat instead of `status.yaml`
- ❌ Writing source changes directly from orchestration when a delegated skill owns them
- ❌ Updating plan state only in chat and not in `status.yaml`
