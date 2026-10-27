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
- После успешной classic finalization возвращает compact evolution proposals по существующему evidence как output без intake worker, execution, skill-context/rules writes или patch cursor updates. Optional learning не блокирует verified finalization. `/aif-evolve` никогда не запускается в составе finalization; integrated-finalization request сам по себе не даёт authority. Явно запрошенный или обязательный по project policy evolution возвращается parent как exact owner handoff `/aif-evolve <plan-id>` с точным выбранным scope; parent выполняет отдельный owner workflow с existing approvals и proposal_digest binding. Marked legacy ultra сохраняет только exact receipt-derived handoff без proposals.
- Если workspace dirty не только из текущего плана — останавливается и просит подтверждения.
- Если `gh` недоступен — выводит manual PR instructions вместо падения.

### Dormancy Contract

- Файл существует как future stub prompt asset для отдельного handoff runtime binding.
- Пока такой binding не реализован, ordinary CLI workflow остаётся `core`-only, а этот stub не должен трактоваться как уже активный runtime contract.

### Reference

Полный contract: `skills/aif-done/references/finalization-contract.md`.
