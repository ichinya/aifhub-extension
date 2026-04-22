<!--
gate-summary:
  id: aif-done-handoff-finalizer
  stage: Done
  status: active
  consumers:
    - aif-done
    - aifhub-done-finalizer
  activation: manual-only
  readonly: false
  auto_bind: false
-->

## Handoff Finalizer для `aif-done`

Этот prompt-файл определяет finalizer semantics для AIFHub/Handoff Done stage.

### Consumer

- `aif-done` — extension-owned skill (`skills/aif-done/SKILL.md`)
- `aifhub-done-finalizer` — Codex agent (`agent-files/codex/aifhub-done-finalizer.toml`)

### Trigger

- Explicit `/aif-done` invocation after passing verification.
- Plan must have `verification.verdict` of `pass` or `pass-with-notes`.

### Finalizer Rules

- Работает **после** `/aif-verify`, не дублирует verification logic.
- Finalization только при успешной verification state.
- Bounded archival scope: `status.yaml`, `.ai-factory/specs/<plan-id>/`, `.ai-factory/specs/index.yaml`.
- Commit/PR summaries выводятся как drafts для пользовательского review.
- Для `.ai-factory/ROADMAP.md`, `.ai-factory/RULES.md` и `.ai-factory/ARCHITECTURE.md` — только suggestion-only follow-ups.
- Если workspace dirty не только из текущего плана — останавливается и просит подтверждения.
- Если `gh` недоступен — выводит manual PR instructions вместо падения.

### Reference

Полный contract: `skills/aif-done/references/finalization-contract.md`.
