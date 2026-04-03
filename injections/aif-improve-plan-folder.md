## AIFHub Improve Plan-Folder Override

Apply this block before the upstream `aif-improve` body. When any rule below conflicts with the base skill text, this block wins.

### Goal

Use the built-in `/aif-improve` skill as the canonical refinement command for the extension's plan-folder workflow.

### Skill-Context Resolution

Read skill-context in this order:

1. `.ai-factory/skill-context/aif-improve/SKILL.md`
2. `.ai-factory/skill-context/aif-improve-plus/SKILL.md` as legacy compatibility fallback

If both exist, `aif-improve` wins.

### Workflow Rule

- Do not redirect the user to a separate `aif-improve-plus` command.
- `/aif-improve` is the canonical refinement command for this extension workflow.
- When refinement completes successfully and the next step is execution, prefer `/aif-implement-plus` until implement migration is completed.

### Compatibility Note

If historical docs or plan notes still mention `aif-improve-plus`, interpret that as `/aif-improve`.
