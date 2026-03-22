# Question Tool — User Interaction

> Reference for all project skills. Use the formats below for asking questions to users.

## Formats for Different Agents

Different agents use different formats for questions. Choose the appropriate format for your agent.

---

## Single Question

### pi
```
question({
  question: "Question text?",
  options: [
    { label: "Option 1 (Recommended)", description: "Brief description" },
    { label: "Option 2", description: "Brief description" }
  ]
})
```

### Claude Code / Kilo CLI / OpenCode
```
question({
  questions: [{
    header: "Topic",  // max 30 characters
    question: "Question text?",
    options: [
      { label: "Option 1 (Recommended)", description: "Brief description" },
      { label: "Option 2", description: "Brief description" }
    ]
  }]
})
```

---

## Multiple Questions

### pi
```
questionnaire({
  questions: [
    {
      id: "area",
      label: "Area",           // for tab bar
      prompt: "Which area does this affect?",
      options: [
        { value: "frontend", label: "Frontend", description: "UI components" },
        { value: "backend", label: "Backend", description: "API and services" }
      ],
      allowOther: true         // allow "Type something..."
    },
    {
      id: "priority",
      label: "Priority",
      prompt: "What is the priority?",
      options: [
        { value: "high", label: "High", description: "Urgent" },
        { value: "low", label: "Low", description: "Not urgent" }
      ]
    }
  ]
})
```

### Claude Code / Kilo CLI / OpenCode
```
question({
  questions: [
    {
      header: "Area",
      question: "Which area does this affect?",
      options: [
        { label: "Frontend", description: "UI components" },
        { label: "Backend", description: "API and services" }
      ]
    },
    {
      header: "Priority",
      question: "What is the priority?",
      options: [
        { label: "High", description: "Urgent" },
        { label: "Low", description: "Not urgent" }
      ]
    }
  ]
})
```

---

## Parameters

### question (pi)

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `question` | string | ✅ | Question text |
| `options` | array | ✅ | Array of options (2-4 items) |

### questionnaire (pi)

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `questions` | array | ✅ | Array of questions |
| `id` | string | ✅ | Question identifier |
| `label` | string | ✅ | Short label for tab bar |
| `prompt` | string | ✅ | Full question text |
| `options` | array | ✅ | Array of options |
| `allowOther` | boolean | ❌ | Allow custom input |

### question (other agents)

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `questions` | array | ✅ | Array of questions (1-4 items) |
| `header` | string | ❌ | Short header (max 30) |
| `question` | string | ✅ | Question text |
| `options` | array | ✅ | Array of options |
| `multiple` | boolean | ❌ | Multiple selection |

### options (common)

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `label` | string | ✅ | Option name |
| `description` | string | ✅ | Brief description |
| `value` | string | ❌ | Value (questionnaire only) |

---

## Rules

1. **2-4 options** — no more
2. **Description required** — for each option
3. **Recommended option** — mark with `(Recommended)`
4. **Short headers** — `header`/`label` max 30 characters
5. **Single question** → `question`, **multiple** → `questionnaire` (pi) / `question` with array (others)

---

## Examples

### Scope Clarification
```
question({
  question: "Which area does this change affect?",
  options: [
    { label: "Frontend (Recommended)", description: "UI components, styles" },
    { label: "Backend", description: "API, services, database" },
    { label: "Both", description: "Full-stack changes" }
  ]
})
```

### Action Confirmation
```
question({
  question: "Apply changes?",
  options: [
    { label: "Yes, apply (Recommended)", description: "Write changes to files" },
    { label: "No, cancel", description: "Return without changes" }
  ]
})
```

### Next Step Selection
```
question({
  question: "What to do next?",
  options: [
    { label: "/aif-verify (Recommended)", description: "Verify implementation" },
    { label: "/aif-commit", description: "Commit changes" },
    { label: "Continue", description: "Stay in current context" }
  ]
})
```

### Multiple Selection (other agents)
```
question({
  questions: [{
    header: "Features",
    question: "Which features to implement?",
    options: [
      { label: "Auth", description: "Authentication" },
      { label: "Cache", description: "Caching" },
      { label: "Logging", description: "Logging" }
    ],
    multiple: true
  }]
})
```

---

## Debugging

If the tool doesn't work:

1. Check that the extension is installed:
   - pi: `~/.pi/agent/extensions/question.ts`
   - pi: `~/.pi/agent/extensions/questionnaire.ts`

2. Check syntax:
   - All strings in quotes
   - Commas between array elements
   - Brackets closed

3. Check `allowed-tools` in skill:
   ```
   allowed-tools: ... question questionnaire
   ```

---

## Compatibility

| Agent | question (simple) | questionnaire | question (array) | multiple |
|-------|-------------------|---------------|------------------|----------|
| pi | ✅ | ✅ | ❌ | ❌ |
| Claude Code | ❌ | ❌ | ✅ | ✅ |
| Kilo CLI | ❌ | ❌ | ✅ | ✅ |
| OpenCode | ❌ | ❌ | ✅ | ✅ |
