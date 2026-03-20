---
name: aif-explore
description: Enter explore mode with config-first, plan-folder-aware context loading and RESEARCH-only persistence. Use when the user wants to investigate, compare options, or think through a change before planning or while a plan is active.
argument-hint: "[topic|plan-id|@path]"
version: 0.7.0
---

# AIF Explore

Enter explore mode for this extension's workflow. Investigate the codebase, compare approaches, challenge assumptions, and clarify scope without implementing changes.

**This skill is thinking-only.** You may read repository files and reason about active plans, but you must not implement features or edit project files other than the configured research artifact.

When the user is ready to leave exploration:

- New work with no plan yet -> `/aif-new "<task>"`
- Existing plan that needs refinement -> `/aif-improve <plan-id>`
- Ready-to-run plan that should go through orchestration -> optional `/aif-apply <plan-id>`
- Ready-to-run plan without orchestration -> `/aif-implement <plan-id>`

---

## Artifact Ownership

| Artifact | Role |
|----------|------|
| `config.paths.research` (normally `.ai-factory/RESEARCH.md`) | **Only writable artifact in this skill** |
| `config.yaml`, `DESCRIPTION.md`, `ARCHITECTURE.md`, `ROADMAP.md`, `RULES.md`, `rules/base.md` | Read-only project context |
| `plans/<plan-id>/{task,context,rules,verify,status,explore}.md` | Read-only plan context |
| Source files | Read-only |

If a discovery should affect another artifact, capture it in `RESEARCH.md` and route follow-up to the owner command later.

---

## Workflow

### Step 0: Load Skill-Context Overrides

Read `.ai-factory/skill-context/aif-explore/SKILL.md` if it exists.

Treat skill-context rules as project-level overrides:

- if a skill-context rule conflicts with this file, the skill-context rule wins
- if there is no conflict, apply both
- enforce skill-context rules for conversation output and any `RESEARCH.md` updates

### Step 1: Load Config-First Project Context

Read `.ai-factory/config.yaml` first.

Use it as the source of truth for:

- communication and artifact localization
- paths to `DESCRIPTION.md`, `ARCHITECTURE.md`, `ROADMAP.md`, `RESEARCH.md`, plan folders, and rules
- workflow settings relevant to plan discovery

Then read, if present:

- `config.paths.description`
- `config.paths.architecture`
- `.ai-factory/RULES.md`
- `config.rules.base`
- `config.paths.roadmap`
- `config.paths.research`

Rules:

- do not use bridge files as runtime fallback
- if `config.yaml` is missing or incomplete, state the missing prerequisite explicitly
- you may still discuss the problem at a high level, but plan-aware context loading and persisted research updates require `/aif-analyze`
- use `config.language.ui` for communication
- use `config.language.artifacts` for any persisted research content
- keep file names, command ids, YAML keys, section markers, and research field labels in English

### Step 2: Resolve Optional Plan Context

The argument after `/aif-explore` can be:

- a topic or vague idea
- an explicit plan id
- `@<path>` to a plan folder or a plan artifact

Plan resolution priority:

1. `@<path>`
2. explicit `<plan-id>`
3. current branch slug match against `config.paths.plans/<plan-id>/`
4. single active plan (`status != done`)
5. no active plan context

Path handling:

- if `@<path>` points to a plan folder, use it
- if it points to `task.md`, `context.md`, `rules.md`, `verify.md`, `status.yaml`, or `explore.md`, use the parent folder
- if it points to legacy `PLAN.md` or branch-named `plans/<branch>.md`, explain that this extension's canonical workflow uses plan folders and suggest a real plan folder or `/aif-new`

If a plan folder is resolved, read these artifacts when present:

- `task.md`
- `context.md`
- `rules.md`
- `verify.md`
- `status.yaml`
- `explore.md`

For markdown plan artifacts:

1. inspect YAML frontmatter first for identity and freshness
2. read body sections only when needed for the current discussion
3. treat missing frontmatter as legacy input and fall back to body-first reading

### Step 3: Explore, Don't Implement

Your job here is to help the user think, not to execute.

Good exploration moves include:

- clarifying the real goal and constraints
- tracing relevant code paths or workflow artifacts
- comparing options and tradeoffs
- drawing simple diagrams or tables when they help
- surfacing risks, unknowns, and prerequisite decisions

Bad moves include:

- editing source code
- editing plan artifacts
- silently turning exploration into planning or implementation

### Step 4: Use Plan Context Naturally

When a plan is active, discuss it in plan-folder terms:

- scope in `task.md`
- local evidence in `context.md`
- constraints in `rules.md`
- verification expectations in `verify.md`
- current state in `status.yaml`
- prior imported research in `explore.md`

Examples:

- "The current plan scope covers X, but this dependency in `context.md` suggests Y."
- "This belongs in follow-up planning. Save it to RESEARCH now, then run `/aif-improve <plan-id>`."
- "The implementation path looks ready. If you want to execute through the workflow, use `/aif-apply <plan-id>`."

### Step 5: Offer Persistence, Never Auto-Capture

If the user wants to preserve exploration context, offer to save it to `config.paths.research`.

Use wording aligned with the extension workflow:

```text
Save these exploration results to .ai-factory/RESEARCH.md so /clear and /aif-new can reuse them?

Options:
1. Yes — update Active Summary + append a new Session (recommended)
2. Yes — update Active Summary only
3. No
```

Hard rules:

- write or edit only `config.paths.research`
- do not modify source files, plan artifacts, specs, or project docs from this skill
- preserve prior sessions verbatim
- keep the `Active Summary` markers intact

If the research file does not exist, create it with this structure:

```markdown
# Research

Updated: YYYY-MM-DD HH:MM
Status: active

## Active Summary (input for /aif-new)

<!-- aif:active-summary:start -->
**Topic:**

**Goal:**

**Constraints:**

**Decisions:**

**Open Questions:**

**Success Signals:**

**Next Step:**
<!-- aif:active-summary:end -->

## Sessions

<!-- aif:sessions:start -->
<!-- aif:sessions:end -->

## Archived Summaries
```

When saving:

- update the `Updated:` timestamp
- replace only the content inside `aif:active-summary:start/end`
- if the user chose the session option, append a session immediately before `<!-- aif:sessions:end -->`
- keep the field labels and section markers exactly intact so `aif-new` can import the Active Summary and normalize plan-local `explore.md`

Session entry format:

```markdown
### YYYY-MM-DD HH:MM — <short title>

**What changed:**

**Key notes:**

**Links:**
- `path/to/file`

---
```

### Step 6: Route the Next Step Explicitly

When insights crystallize, recommend the correct handoff:

- need a new plan -> `/aif-new "<task>"`
- have an existing plan but the new insight changes scope/rules/verify -> `/aif-improve <plan-id>`
- plan is ready to run with orchestration -> `/aif-apply <plan-id>`
- plan is ready to run directly -> `/aif-implement <plan-id>`

Do not send the user back to legacy `/aif-plan`.

---

## Exploration Patterns

### No active plan

- explore the problem space freely
- ground the discussion in codebase evidence when relevant
- when the shape of the work becomes concrete, offer `/aif-new`

### Active plan

- read the current plan artifacts before recommending scope changes
- use `status.yaml` to understand whether the plan is still draft, implementing, verifying, or fixing
- if a new insight should change the plan, capture it in `RESEARCH.md` now and route to `/aif-improve <plan-id>`

### Mid-implementation uncertainty

- inspect the existing plan and related source files
- explain the hidden complexity clearly
- keep the decision record in `RESEARCH.md`
- route back to `/aif-improve <plan-id>` if scope changed, or `/aif-apply <plan-id>` if execution should continue through orchestration

---

## What You Don't Have To Do

- follow a rigid interview script
- reach a conclusion in one pass
- save anything unless the user wants persistence
- be brief when a diagram or deeper trace is more useful

---

## Guardrails

- do not implement
- do not write project files other than `config.paths.research`
- do not mutate plan artifacts from explore mode
- do not reintroduce `PLAN.md` or branch-named plan files as canonical workflow
- do not auto-capture without user consent
- do keep the discussion grounded in repository evidence
- do preserve compatibility with `aif-new` by keeping `RESEARCH.md` markers and field labels stable

## Anti-patterns

- ❌ Telling the user to start with `/aif-plan`
- ❌ Reading bridge files as the main source of runtime context
- ❌ Treating `RESEARCH.md` as disposable notes and rewriting history
- ❌ Editing `task.md`, `rules.md`, `verify.md`, or source files from explore mode
- ❌ Ignoring active plan state when the user passed a plan id or `@path`
