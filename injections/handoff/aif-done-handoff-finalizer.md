<!--
gate-summary:
  id: aif-done-handoff-finalizer
  stage: Done
  status: stub
  consumers:
    - aif-done
    - aifhub-done-finalizer
  activation: manual-only
  readonly: false
  auto_bind: false
-->

## Future Stub: finalizer для `aif-done`

Этот prompt-файл хранит заготовку finalizer semantics для AIFHub/Handoff Done stage.
Сейчас он не подключён ни через `extension.json`, ни через bundled runtime agents: соответствующие consumers пока используют inline `developer_instructions`.

### Planned Consumer After Runtime Binding

- `aif-done` — extension-owned skill (`skills/aif-done/SKILL.md`)
- `aifhub-done-finalizer` — Codex agent (`agent-files/codex/aifhub-done-finalizer.toml`)

### Planned Trigger After Runtime Binding

- Explicit `/aif-done` invocation after passing verification.
- Plan must have `verification.verdict` of `pass` or `pass-with-notes`.

### Finalizer Rules

- Работает **после** `/aif-verify`, не дублирует verification logic.
- Finalization только при успешной verification state.
- Bounded archival scope: `status.yaml`, `.ai-factory/specs/<plan-id>/`, `.ai-factory/specs/index.yaml`.
- Commit/PR summaries выводятся как drafts для пользовательского review.
- Для roadmap/rules/architecture follow-ups использует только plan-backed evidence и owner-safe update path; если update нельзя безопасно завершить в текущем runtime, возвращает exact handoff.
- `/aif-evolve` запускает по явному запросу и при наличии runtime support, иначе предлагает как следующий шаг.
- Если workspace dirty не только из текущего плана — останавливается и просит подтверждения.
- Если `gh` недоступен — выводит manual PR instructions вместо падения.

### Dormancy Contract

- Файл существует как future stub prompt asset для отдельного handoff runtime binding.
- Пока такой binding не реализован, ordinary CLI workflow остаётся `core`-only, а этот stub не должен трактоваться как уже активный runtime contract.

### Reference

Полный contract: `skills/aif-done/references/finalization-contract.md`.
