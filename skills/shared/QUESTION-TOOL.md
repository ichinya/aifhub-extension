# Question Tool - User Interaction

> Reference for all project skills. Choose the question format by runtime. Do not assume one format works everywhere.

## Runtime First

Different agents use different interaction tools:

- Codex Default mode: no form tool. Ask a short plain-text question in the assistant message.
- Codex Plan mode: use `request_user_input`.
- Claude Code / Kilo CLI / OpenCode: use `question(questions: [...])`.
- pi: use `question(...)` for one question and `questionnaire(...)` for multiple questions.

If you are writing or updating a skill, pick the format that matches the runtime instead of copying examples from another agent.

---

## Codex

### Default Mode

Codex cannot render a question form in Default mode. Do not fake a `question(...)` block there.

Use a short plain-text question in the assistant message instead.

Example:

```text
Which path should I take: continue with the default fix, or stop and review first?
```

### Plan Mode

Codex form UI is available through `request_user_input`.

```text
request_user_input({
  questions: [{
    header: "Mode",
    id: "mode",
    question: "How should I continue?",
    options: [
      { label: "Continue (Recommended)", description: "Proceed with the default path." },
      { label: "Stop", description: "End here without changes." }
    ]
  }]
})
```

Codex constraints:

- Use `request_user_input` only in Plan mode.
- Ask 1-3 questions total.
- Keep `header` to 12 characters or fewer.
- Use a stable snake_case `id`.
- Provide 2-3 mutually exclusive options.
- Put the recommended option first and suffix its label with `(Recommended)`.
- Do not add an `Other` option yourself. The client adds free-form `Other` automatically.

Tested in this repository's Codex environment:

- `request_user_input` in Default mode returns `unavailable in Default mode`.

---

## Claude Code / Kilo CLI / OpenCode

Use `question(questions: [...])`.

### Single Question

```text
question(questions: [{
  header: "Mode",
  question: "How should I continue?",
  options: [
    { label: "Continue (Recommended)", description: "Proceed with the default path." },
    { label: "Stop", description: "End here without changes." }
  ]
}])
```

### Multiple Questions

```text
question(questions: [
  {
    header: "Area",
    question: "Which area does this affect?",
    options: [
      { label: "Frontend", description: "UI components and styles." },
      { label: "Backend", description: "API, services, and data flow." }
    ]
  },
  {
    header: "Priority",
    question: "What is the priority?",
    options: [
      { label: "High", description: "Urgent or blocking work." },
      { label: "Low", description: "Can wait until later." }
    ]
  }
])
```

### Multiple Selection

```text
question(questions: [{
  header: "Features",
  question: "Which features should be included?",
  options: [
    { label: "Auth", description: "Authentication support." },
    { label: "Cache", description: "Caching and reuse of results." },
    { label: "Logging", description: "Operational visibility." }
  ],
  multiple: true
}])
```

---

## pi

### Single Question

```text
question({
  question: "How should I continue?",
  options: [
    { label: "Continue (Recommended)", description: "Proceed with the default path." },
    { label: "Stop", description: "End here without changes." }
  ]
})
```

### Multiple Questions

```text
questionnaire({
  questions: [
    {
      id: "area",
      label: "Area",
      prompt: "Which area does this affect?",
      options: [
        { value: "frontend", label: "Frontend", description: "UI components and styles." },
        { value: "backend", label: "Backend", description: "API and services." }
      ],
      allowOther: true
    },
    {
      id: "priority",
      label: "Priority",
      prompt: "What is the priority?",
      options: [
        { value: "high", label: "High", description: "Urgent or blocking work." },
        { value: "low", label: "Low", description: "Can wait until later." }
      ]
    }
  ]
})
```

---

## Rules

1. Choose the question format by runtime, not by habit.
2. Do not use `question(...)` or `questionnaire(...)` in Codex Default mode.
3. Use `request_user_input` in Codex only when the session is in Plan mode.
4. For `question(questions: [...])`, keep `header` short and every option descriptive.
5. Mark the preferred option with `(Recommended)`.
6. Do not turn a free-text data capture step into a forced menu if the workflow still needs user text.
7. In this repository, canonical planning guidance should reference `/aif-plan` or `/aif-plan full`, not `/aif-new`.

---

## Debugging

If a question UI does not render:

1. Check the runtime first.
   - Codex Default mode: ask plain text.
   - Codex Plan mode: use `request_user_input`.
   - Claude Code / Kilo CLI / OpenCode: use `question(questions: [...])`.
   - pi: use `question(...)` or `questionnaire(...)`.

2. Check the mode.
   - In Codex, `request_user_input` is unavailable outside Plan mode.

3. Check the syntax for the target runtime.
   - Codex Plan mode expects the `request_user_input` schema.
   - Legacy `question` agents expect `question(questions: [...])`, not `question({ questions: [...] })`.

4. Check skill metadata.
   - Legacy question-tool skills still need the relevant prompt tools in `allowed-tools`.
   - Codex Default mode does not need a form tool for a plain-text question.

5. Check shared references in mirrors.
   - If a mirror skill links to `../shared/QUESTION-TOOL.md`, make sure the mirror contains that file.

---

## Compatibility

| Runtime | Plain text | request_user_input | question | questionnaire |
|---------|------------|--------------------|----------|---------------|
| Codex Default mode | yes | no | no | no |
| Codex Plan mode | yes | yes | no | no |
| Claude Code | yes | no | yes | no |
| Kilo CLI | yes | no | yes | no |
| OpenCode | yes | no | yes | no |
| pi | yes | no | yes | yes |

---

## Related

- `.agents/skills/ASK-QUESTION-GUIDE.md` documents the legacy `question(questions: [...])` pattern.
- `skills/shared/QUESTION-TOOL.md` is the source of truth for runtime-specific guidance in this repository.
