## AIFHub Extension Override

When working in a repository that uses this extension:

- Treat `.ai-factory/plans/<plan-id>.md` and `.ai-factory/plans/<plan-id>/` as one active plan pair.
- If `@path` points to the plan file, the plan folder, or one of its local artifacts (`task.md`, `context.md`, `rules.md`, `verify.md`, `status.yaml`, `explore.md`), resolve the whole pair before continuing.
- Persist exploration only to `config.paths.research` / `.ai-factory/RESEARCH.md`.
- Do not treat `DESCRIPTION.md`, `ARCHITECTURE.md`, `ROADMAP.md`, or `RULES.md` as writable from explore mode in this extension workflow.
- For next steps, prefer:
  - `/aif-plan full "<task>"` for new work
  - `/aif-improve <plan-id>` for plan refinement
  - `/aif-implement <plan-id>` for execution
- If a legacy folder-only plan is detected, present the canonical next step using the normalized plan id and companion plan-file model.

If this override conflicts with the base `aif-explore` wording, follow the extension workflow rules above.

### Codex Runtime

When running in Codex app/CLI:

- The planning stage (`/aif-explore`, `/aif-plan full`, `/aif-improve`) is best used in Codex Plan mode, where `request_user_input` is available.
- This skill does not attempt to switch the Codex session mode. The user controls the mode.
- In Codex Default mode, if a question is needed, ask it as plain text in the assistant message. Do not use `question(...)` or `questionnaire(...)`.
- In autonomous or subagent mode, do not ask interactive questions. Record assumptions and return blockers/open questions to the parent.
- See `skills/shared/QUESTION-TOOL.md` for the full runtime question format mapping.
