<!--
gate-summary:
  id: aif-done-handoff-finalizer
  stage: Done
  status: stub
  consumers:
    - aifhub-done-finalizer
  activation: manual-only
  readonly: false
  auto_bind: false
-->

## Future Stub: finalizer для `aif-done`

Этот prompt-файл фиксирует заготовку для будущего handoff runtime binding вокруг `aif-done` semantics.
Сейчас он не возвращает `aif-done` в canonical public workflow и не подключён ни через `extension.json`, ни через `agent-files/codex/*.toml`; текущий finalizer использует inline `developer_instructions`.

### Planned Consumer After Runtime Binding

- `aifhub-done-finalizer`
- internal handoff orchestration, где нужен отдельный finalizer stage после passing verification

### Planned Trigger After Runtime Binding

- explicit handoff finalization request
- verified plan, который уже получил `PASS` или `PASS with notes`
- AIFHub-specific archive/summary flow, работающий поверх bounded finalizer semantics

### Finalizer Rules

- Считай `/aif-verify` canonical public path, а `aif-done` — только отдельной handoff-finalizer semantics.
- Разрешай finalization только после успешной verification state.
- Сохраняй bounded archival scope: `status.yaml`, `.ai-factory/specs/<plan-id>/`, `.ai-factory/specs/index.yaml`, summary outputs.
- Для `.ai-factory/ROADMAP.md`, `.ai-factory/RULES.md` и `.ai-factory/ARCHITECTURE.md` допускай только suggestion-only follow-ups.

### Dormancy Contract

- Этот finalizer нужен для будущего handoff runtime binding, а не для ordinary CLI workflow.
- Пока отдельный runtime binding не реализован, default runtime не должен зависеть от `aif-done` semantics.
