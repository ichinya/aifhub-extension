---
name: aif-apply
description: Manual orchestration entrypoint for plan execution, git strategy selection, and final handoff after local plan execution.
argument-hint: "[plan-id|@path|status|--list] [--local] [--git-new|--git-current|--git-default]"
version: 0.7.1
author: AIFHub Extension
---

# AIF Apply - Manual Workflow Orchestrator

Run the full spec-driven execution cycle from an active plan folder. `aif-apply` is the manual control point between planning and finalization: it selects the active plan, resolves the git strategy, applies that strategy locally, runs implementation through `/aif-implement`, and hands off completed plans to `aif-done`.

This skill is orchestration-first:

- manual trigger only - never auto-runs on plan creation
- plan-folder aware - works from `config.paths.plans/<plan-id>/` (normally `.ai-factory/plans/<plan-id>/`)
- local-first - does not require Claude-only workers
- thin wrapper - delegates task execution, progress tracking, and verify/fix loops to `/aif-implement`

---

## Artifact Ownership

- **Primary ownership:** `plans/<plan-id>/status.yaml` for orchestration state and runtime settings.
- **Delegates writes to:** source files and plan progress via `aif-implement`, verification metadata via `aif-verify`, fix artifacts via `aif-fix`, archive artifacts via `aif-done`.
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
- `--local` -> explicit compatibility flag for local orchestration

### Step 0.1: Load Project Context

Read if present:

- `.ai-factory/config.yaml`
- `.ai-factory/DESCRIPTION.md`
- `.ai-factory/ARCHITECTURE.md`
- `.ai-factory/RULES.md`
- `.ai-factory/rules/base.md`

Use `config.paths.plans` as the source of truth for plan discovery and list mode. If `config.yaml` is missing or does not define `paths.plans`, fall back to `.ai-factory/plans/` as the default extension path and note that `/aif-analyze` should repair the config.

Read skill-context in this order:

1. `.ai-factory/skill-context/aif-apply/SKILL.md`
2. `.ai-factory/skill-context/aif-implement/SKILL.md` as compatibility guidance when apply-specific context does not exist

If a skill-context file exists, treat it as a project-level override and enforce it across all orchestration decisions.

### Step 0.2: Resolve Active Plan Folder

Plan resolution priority:

1. `@<path>` argument
2. explicit `<plan-id>` argument
3. current branch slug match against `config.paths.plans/<slug>/`
4. single active plan folder under `config.paths.plans/` where `status != done`
5. list active plans and ask the user to choose when more than one unfinished plan remains

If no active plan exists, clearly report that there is nothing to execute and suggest `/aif-new`.

Once the plan is resolved, keep the exact plan folder path fixed for the rest of the run. All downstream skill handoffs must pass `@<resolved-plan-path>` explicitly instead of relying on branch-based rediscovery after git strategy changes.

### Step 0.3: Resolve Git Strategy

Resolve git context before the first implementation pass.

Decision priority:

- `--git-new` -> use a new work branch for this plan
- `--git-current` -> continue on the current branch
- `--git-default` -> use the default branch only when explicitly requested
- existing `status.yaml -> execution.git.strategy` -> reuse the saved plan choice when resuming
- otherwise ask the user once before execution starts

Do not stop after persisting the choice. Apply the chosen strategy locally before `/aif-implement` starts, then update only `status.yaml -> execution.git`:

```yaml
execution:
  git:
    strategy: new|current|default|null
    work_branch: <branch name|null>
    base_branch: <branch name|null>
    resolved_at: <ISO timestamp|null>
```

Preserve any existing sibling fields under `execution` such as `mode`, `subagent`, `current_task`, `max_fix_loops`, and `quality_checks`.

Apply the strategy deterministically:

1. inspect the local git state and current branch
2. resolve the repository default branch name when needed
3. execute the chosen strategy before implementation:
   - `new` -> create or switch to a local work branch for the plan; reuse `execution.git.work_branch` when resuming
   - `current` -> stay on the current branch and record it as `work_branch`
   - `default` -> switch to the local default branch only when explicitly selected
4. record the actual `work_branch`, `base_branch`, and `resolved_at` values after the branch step succeeds

Do not start `/aif-implement` while the local branch state and `execution.git` disagree.

Safety rules:

- never select the default branch implicitly
- never push, pull, or rewrite remote state automatically
- if branch creation or switching fails, stop and report the local git error instead of continuing with a stale branch context

### Step 0.4: Resolve Orchestration Mode

`aif-apply` currently orchestrates only the local path.

Mode rules:

- `--local` -> explicit compatibility flag; keep mode `local`
- no explicit flag -> default to local

Save the decision by updating only `status.yaml -> execution.mode`, `execution.subagent`, and `execution.mode_resolved_at`:

```yaml
execution:
  mode: local
  subagent: null
  mode_resolved_at: <ISO timestamp>
```

Do not replace the whole `execution` object here. Preserve `execution.git`, `execution.current_task`, `execution.max_fix_loops`, and `execution.quality_checks`.

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
2. if the plan is not execution-ready or the scope metadata is incomplete, route to `/aif-improve @<resolved-plan-path>`
3. if `status.yaml -> verification.verdict` is `fail`, route to `/aif-fix @<resolved-plan-path>` so the existing repair path can resume from the selected plan
4. only continue to implementation when the plan is execution-ready and not already in a failed verification state

#### 2.2 Implementation Pass

Run the pending scope through `/aif-implement @<resolved-plan-path>`.

`/aif-implement` owns:

- task handoff and `execution.current_task`
- `task.md` checkbox updates
- `progress.scope_completed` synchronization
- quality checks from `status.yaml -> execution.quality_checks`
- the verify -> fix -> re-verify loop up to `execution.max_fix_loops`

`aif-apply` must not duplicate that loop after `/aif-implement` returns.

#### 2.3 Final Handoff

After `/aif-implement` finishes:

1. re-read `status.yaml`
2. inspect `verification.verdict`
3. when the verdict is `pass` or `pass-with-notes`, route to `/aif-done @<resolved-plan-path>`
4. when the verdict is `fail`, route to `/aif-fix @<resolved-plan-path>` without starting a second verify/fix cycle in `aif-apply`
5. otherwise stop and report the unexpected verification state clearly

Preserve the saved git strategy and execution history for downstream archive/evolve steps.

### Step 3: Safety Rules

- Never mutate remote git state automatically.
- Keep `aif-implement -> aif-verify -> aif-fix -> aif-done` usable as direct commands even when `aif-apply` is the recommended orchestrator.
- Do not add a second verification loop around `/aif-implement`; that skill already owns the execution and repair cycle.

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

1. list plan folders under `config.paths.plans/`
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
- Execute the chosen git strategy before `/aif-implement`, not just in chat or metadata.
- All runtime execution decisions must be persisted in `status.yaml`.
- Let `/aif-implement` remain the single owner of task progress updates and the verify/fix loop.
- Pass the resolved plan explicitly to downstream skills once Step 0.2 selects it.

## Anti-patterns

- ❌ Making `aif-apply` mandatory for all workflows
- ❌ Skipping the git decision point or keeping it only in chat instead of `status.yaml`
- ❌ Persisting a git strategy without actually switching or creating the local branch it describes
- ❌ Writing source changes directly from orchestration when a delegated skill owns them
- ❌ Updating plan state only in chat and not in `status.yaml`
- ❌ Re-running verify/fix in `aif-apply` after `/aif-implement` already completed that loop
