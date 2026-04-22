<!--
gate-summary:
  id: aif-security-checklist-handoff-gate
  stage: Review
  status: stub
  consumers:
    - aif-security-checklist
    - aifhub-security-sidecar
  activation: manual-only
  readonly: true
  auto_bind: false
-->

## Future Stub: gate для `aif-security-checklist`

Этот prompt-файл хранит заготовку для будущего handoff runtime binding и не является уже подключённым profile.
Сейчас его не использует ни `extension.json`, ни `agent-files/codex/*.toml`; default manifest остаётся `core`-only, а текущий security consumer живёт на inline `developer_instructions`.

### Planned Consumer After Runtime Binding

- built-in `aif-security-checklist`
- `aifhub-security-sidecar` для read-only security review текущего changed scope

### Planned Trigger After Runtime Binding

- explicit handoff security stage
- request на дополнительный security gate перед acceptance/finalization
- AIFHub-specific review flow, где нужен отдельный security verdict вне canonical CLI path

### Gate Rules

- Фокусируйся на changed paths, exposed interfaces, secrets, validation, shell/filesystem safety и injection risks.
- Возвращай только actionable security findings; отсутствие material issues формулируй явно.
- Не превращай security gate в general code review и не запускай auto-fix semantics.
- Не документируй этот слой как обязательную часть ordinary `/aif-plan -> /aif-verify` workflow.

### Dormancy Contract

- Этот gate живёт отдельно от `core plan-folder overlay` как future stub.
- Пока отдельный runtime binding не реализован, он не должен менять поведение обычного CLI workflow.
