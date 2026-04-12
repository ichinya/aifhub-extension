## AIFHub Implement Companion-Artifact Override

Apply this block before the upstream `aif-implement` body. When any rule below conflicts with the base skill text, this block wins.

### Goal

Use the built-in `/aif-implement` skill as the canonical execution command and orchestration owner for the extension workflow.

### Skill-Context Resolution

Read skill-context in this order:

1. `.ai-factory/skill-context/aif-implement/SKILL.md`
2. `.ai-factory/skill-context/aif-implement-plus/SKILL.md` as legacy compatibility fallback

If both exist, `aif-implement` wins.

### Plan Resolution

Resolve all of these inputs to one active plan pair before execution starts:

- `.ai-factory/plans/<plan-id>.md`
- `.ai-factory/plans/<plan-id>/`
- `task.md`, `context.md`, `rules.md`, `verify.md`, `status.yaml`, or `explore.md` inside a plan folder

If only the folder exists, create the missing companion plan file first and record the migration event in `status.yaml.history`.

### Workflow Rules

- `/aif-implement` is the canonical execution command for this extension workflow.
- When no plan exists yet, route the user through `/aif-plan full "<task>" -> /aif-improve`.
- `/aif-implement` owns git strategy resolution and must persist `execution.git.*` in `status.yaml`.
- `/aif-implement` also owns `execution.mode`, `execution.runtime`, and `execution.subagent` updates.
- After tasks complete, route to `/aif-verify`; passing verification finalizes there unless `--check-only` is used.
- Do not route users to deprecated workflow aliases or legacy `*-plus` command names.

### Subagent Compatibility

When checking optional Claude worker availability, support both current and legacy filenames:

- prefer `.claude/agents/implement-coordinator.md`
- support `.claude/agents/implement-worker.md`
- support legacy `.claude/agents/implementer.md`
- support legacy `.claude/agents/implementer-isolation.md`

When persisting `execution.subagent`, allow:

- `implement-coordinator`
- `implementer`
- `implementer-isolation`
- `null`

Prefer `implement-coordinator` when available.

### Execution Metadata

- Preserve sibling keys when updating `execution.*`.
- Record git-strategy decisions, runtime changes, legacy upgrades, and mode switches in `status.yaml.history`.
- When the implementation flow needs a manual checkpoint, the next command is `/aif-verify`, not a deprecated finalize alias.

### Compatibility Note

If historical docs or plan notes still mention `aif-implement-plus`, interpret that as `/aif-implement`.
