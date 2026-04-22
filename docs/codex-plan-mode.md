[← Previous Page](usage.md) · [Back to README](README.md)

# Codex Plan Mode

## Overview

Codex operates in two modes that affect how the agent interacts with the user:

- **Default mode**: no form tool. Questions must be plain text.
- **Plan mode**: `request_user_input` is available for structured questions.

The extension does not switch modes automatically. The user controls the mode, and prompts can only recommend the right mode for the current stage.

## Recommended Codex App Flow

```text
# 1. Enter Plan mode (user action)
/plan-mode

# 2. Planning and refinement (Plan mode)
/aif-explore "task description"
/aif-plan full "task description"
/aif-improve

# 3. Exit Plan mode (user action)
exit plan mode

# 4. Execution and verification (Default mode)
/aif-implement
/aif-verify
```

## Question Format by Mode

### Default Mode

No form tool is available. Ask questions as plain text:

```text
Which approach should I use: Option A (faster) or Option B (more robust)?
```

Do not use `question(...)`, `questionnaire(...)`, or `request_user_input` in Default mode.

### Plan Mode

Use `request_user_input` only after the user has already entered Plan mode, and only for 1-3 short questions:

```text
request_user_input({
  questions: [{
    header: "Approach",
    id: "approach",
    question: "Which approach should I use?",
    options: [
      { label: "Option A (Recommended)", description: "Faster implementation." },
      { label: "Option B", description: "More robust, slower." }
    ]
  }]
})
```

Constraints:

- Ask 1-3 questions total.
- Keep `header` to 12 characters or fewer.
- Use a stable snake_case `id`.
- Provide 2-3 mutually exclusive options.
- Put the recommended option first with `(Recommended)` suffix.
- Do not add an `Other` option — the client adds free-form `Other` automatically.

### Subagent / Autonomous Mode

Do not ask interactive questions. Record assumptions and return blockers:

```text
Assumptions:
- Using REST API (no GraphQL preference specified).
- Targeting Node 20 runtime.

Open questions (parent to resolve):
- Should the service use SQLite or PostgreSQL?
```

## Extension Behavior

The extension prompts (`injections/core/aif-*-plan-folder.md`) include Codex runtime guidance that:

- Recommends Plan mode specifically for `/aif-explore`, `/aif-plan full`, and `/aif-improve` when structured planning questions are needed.
- Does not attempt or promise to switch the session mode.
- Falls back to plain-text questions in Default mode and does not require `question(...)` or `questionnaire(...)` in Codex.
- Avoids interactive questions in subagent context.

This means the issue of automatic mode switching is **documented + prompt-safe**, not implemented as client automation.

## See Also

- [Usage](usage.md) — canonical public workflow and Codex flow summary
- `skills/shared/QUESTION-TOOL.md` — full runtime question format reference
