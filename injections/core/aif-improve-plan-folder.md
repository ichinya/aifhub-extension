## AIFHub Improve Companion-Artifact Override

Apply this block before the upstream `aif-improve` body. When any rule below conflicts with the base skill text, this block wins.

### Goal

Use the built-in `/aif-improve` skill as the canonical refinement command for the extension's companion plan-file + plan-folder workflow.

### Skill-Context Resolution

Read skill-context in this order:

1. `.ai-factory/skill-context/aif-improve/SKILL.md`
2. `.ai-factory/skill-context/aif-improve-plus/SKILL.md` as legacy compatibility fallback

If both exist, `aif-improve` wins.

### Plan Resolution

Resolve all of these inputs to one active pair:

- `.ai-factory/plans/<plan-id>.md`
- `.ai-factory/plans/<plan-id>/`
- any plan-local artifact path inside `.ai-factory/plans/<plan-id>/`

When a legacy folder-only plan is selected:

- create `.ai-factory/plans/<plan-id>.md` before refinement continues
- preserve the existing folder artifacts
- record the upgrade in `status.yaml.history`

### Workflow Rules

- `/aif-improve` is the canonical refinement command for this extension workflow.
- Update the plan file summary and the plan-folder artifacts together.
- Keep `status.yaml` as the canonical execution state file.
- When refinement completes successfully and the next step is execution, route to `/aif-implement`.
- Do not send the user to deprecated workflow aliases or legacy `*-plus` command names.

### Compatibility Note

If historical docs or plan notes still mention `aif-improve-plus`, interpret that as `/aif-improve`.

### Codex Runtime

When running in Codex app/CLI:

- The refinement stage (`/aif-improve`) is best used in Codex Plan mode, where `request_user_input` is available for short clarifying questions.
- This skill does not attempt to switch the Codex session mode. The user controls the mode.
- In Codex Default mode, if a question is needed, ask it as plain text in the assistant message. Do not use `question(...)` or `questionnaire(...)`.
- In autonomous or subagent mode, do not ask interactive questions. Record assumptions and return blockers/open questions to the parent.
- See `skills/shared/QUESTION-TOOL.md` for the full runtime question format mapping.
