## AIFHub Plan Companion-Artifact Override

Apply this block before the upstream `aif-plan` body. When any rule below conflicts with the base skill text, this block wins.

### Goal

Use the built-in `/aif-plan` skill as the canonical planning entrypoint for this extension workflow.

### Canonical Workflow

- Do not redirect users to deprecated planning aliases.
- The canonical public flow is `/aif-analyze -> /aif-explore -> /aif-plan -> /aif-improve -> /aif-implement -> /aif-verify`.
- Legacy planning references should be interpreted as `/aif-plan full`.

### Full-Mode Artifact Contract

When `/aif-plan full` creates `.ai-factory/plans/<plan-id>.md`, it must also create and keep synchronized the companion folder:

- `.ai-factory/plans/<plan-id>/task.md`
- `.ai-factory/plans/<plan-id>/context.md`
- `.ai-factory/plans/<plan-id>/rules.md`
- `.ai-factory/plans/<plan-id>/verify.md`
- `.ai-factory/plans/<plan-id>/status.yaml`
- `.ai-factory/plans/<plan-id>/explore.md` when active research exists

Treat the plan file as the parent-compatible summary artifact and the folder as the structured execution/state artifact set.
The companion plan file may remain plain upstream markdown; the shared YAML frontmatter contract applies to the plan-folder markdown artifacts, not to the parent-compatible plan file.

### Research Normalization

- If `.ai-factory/RESEARCH.md` exists, normalize the active summary into plan-local `explore.md`.
- Keep `.ai-factory/RESEARCH.md` read-only.
- Record the imported source and timestamp in `status.yaml.history`.

### Plan Resolution and Migration

- When the active branch slug matches an existing plan folder without a companion `.md` plan file, generate the missing plan file before continuing.
- Record legacy upgrades in `status.yaml.history` with the source folder path and the generated companion plan file path.
- User-facing guidance must present the normalized canonical pair, not the legacy folder-only shape.

### Handoff Rules

- After planning, route the next step to `/aif-improve`.
- Do not mention deprecated orchestration or finalize aliases as active workflow steps.

### Codex Runtime

When running in Codex app/CLI:

- The planning stage (`/aif-plan full`, `/aif-improve`) is best used in Codex Plan mode, where `request_user_input` is available for short clarifying questions.
- This skill does not attempt to switch the Codex session mode. The user controls the mode.
- In Codex Default mode, if a question is needed, ask it as plain text in the assistant message. Do not use `question(...)` or `questionnaire(...)`.
- In autonomous or subagent mode, do not ask interactive questions. Record assumptions and return blockers/open questions to the parent.
- See `skills/shared/QUESTION-TOOL.md` for the full runtime question format mapping.
