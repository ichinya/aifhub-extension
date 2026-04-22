<!--
gate-summary:
  id: aif-review-handoff-gate
  stage: Review
  status: stub
  consumers:
    - aif-review
    - aifhub-review-sidecar
  activation: manual-only
  readonly: true
  auto_bind: false
-->

## Future Stub: gate для `aif-review`

Этот prompt-файл хранит заготовку для будущего handoff runtime binding, а не действующий runtime contract.
Сейчас он не подключён ни через `extension.json`, ни через `agent-files/codex/*.toml`: ordinary workflow остаётся `core`-only, а текущие review consumers используют inline `developer_instructions`.

### Planned Consumer After Runtime Binding

- built-in `aif-review`
- `aifhub-review-sidecar`, если нужен read-only handoff review без правок

### Planned Trigger After Runtime Binding

- explicit handoff activation для review stage
- request на дополнительный review gate после implementation/verification
- AIFHub-specific orchestration, где нужен findings-first review поверх changed scope

### Gate Rules

- Проверяй только changed scope или явно переданный execution slice.
- Возвращай findings first; если material issues нет, скажи это явно.
- Не предлагай auto-activation через public manifest и не подменяй canonical `/aif-implement -> /aif-verify` flow.
- Если consumer read-only, сохраняй read-only semantics и не переходи к fix behavior.

### Dormancy Contract

- Файл существует как future stub prompt asset для Handoff/AIFHub semantics.
- Пока отдельный runtime binding не реализован, этот gate не должен влиять на обычный CLI workflow.
