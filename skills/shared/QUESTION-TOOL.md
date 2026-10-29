# Question Tool - User Interaction

> Reference for all project skills. Choose the question format by runtime. Do not assume one format works everywhere.

## Runtime First

Different agents use different interaction tools:

- Codex Default mode: use an actually exposed question capability when available; otherwise ask a short plain-text question. Never call the Plan-only form tool.
- Codex Plan mode: use `request_user_input` only after the user has already switched the session into Plan mode, and keep it to 1-3 short questions.
- Claude Code / Kilo CLI / OpenCode: use `question(questions: [...])`.
- pi: use `question(...)` for one question and `questionnaire(...)` for multiple questions.

For Codex planning and refinement flows, prompts may recommend Plan mode, but they cannot switch the client mode automatically.

If another CLI or IDE runtime exposes a planning mode, use that available planning-mode mechanism for structured planning questions. Do not fabricate unavailable tools or client actions; when a planning mode or question tool is unavailable, ask plain text or record assumptions according to the runtime.

If you are writing or updating a skill, pick the format that matches the runtime instead of copying examples from another agent.


## Required protocol

Before asking, inspect the actual runtime capabilities and current session mode. Prefer a concise question only when missing input materially affects the authorized task; continue independent work while waiting.
Never fabricate a tool or mode change. Use plain text when the runtime has no available question tool. Autonomous/Handoff constraints and existing authorization take precedence; do not add a new approval checkpoint for already authorized work.
In autonomous or subagent mode, do not ask interactive questions: record assumptions and return blockers/open questions to the parent. The interactive parent owns clarification.
Do not turn free-text data capture into a forced menu. Keep headers short and options descriptive; mark the preferred choice with `(Recommended)`.
Canonical planning guidance uses `/aif-plan` or `/aif-plan full`, not `/aif-new`.
Before constructing a runtime-specific structured question or editing question examples in a skill, read `skills/shared/references/question-tool/examples.md` from the AIFHub extension root. Installed root: `.ai-factory/extensions/aifhub-extension/`. Read the selected runtime section; its format constraints are mandatory before the call. Missing reference uses plain text, without invented syntax.

## Codex

Use `request_user_input` only after the user has already switched to Plan mode; prompts cannot switch the client mode. Ask 1-3 short questions, header at most 12 characters, stable snake_case id, 2-3 mutually exclusive options, recommended first with `(Recommended)`; do not add Other. In Default mode use the actually available async question capability if exposed, otherwise plain text. Actual runtime tool restrictions win over historical examples.

## Claude Code / Kilo CLI / OpenCode

Use available `question(questions: [...])`; read the matching examples before constructing its arguments. If unavailable, use plain text.

## pi

Use available `question(...)` for one question or `questionnaire(...)` for several; read matching examples before constructing arguments. Never copy another runtime's format.
