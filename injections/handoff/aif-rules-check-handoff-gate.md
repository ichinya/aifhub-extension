<!--
gate-summary:
  id: aif-rules-check-handoff-gate
  stage: Review
  status: stub
  consumers:
    - aifhub-rules-sidecar
  activation: manual-only
  readonly: true
  auto_bind: false
-->

## Future Stub: gate для `aif-rules-check`

Этот prompt-файл описывает заготовку для будущего handoff runtime binding под rule-compliance checks.
Сейчас он не входит ни в default manifest surface, ни в bundled `agent-files/codex/*.toml`, поэтому не должен трактоваться как уже активный consumer contract.

### Planned Consumer After Runtime Binding

- AIFHub-specific rules-check stage
- `aifhub-rules-sidecar` для read-only проверки `.ai-factory/RULES.md`, `.ai-factory/rules/base.md` и plan-local `rules.md`

### Planned Trigger After Runtime Binding

- explicit handoff request на rules-compliance check
- orchestration step, где нужно подтвердить соблюдение project/base/plan-local rules отдельно от generic review

### Gate Rules

- Проверяй только material rule violations, а не общие stylistic preferences.
- Используй bounded scope: active plan pair или явно переданный changed scope.
- Явно отмечай, что этот gate не применяет fixes и не подменяет `/aif-fix`.
- Ordinary CLI workflow не должен зависеть от этого prompt-файла, пока отдельный runtime binding не активирован явно.

### Dormancy Contract

- `aif-rules-check` здесь трактуется как handoff-stage concept, а не как новая public slash command.
- Пока отдельный runtime binding не реализован, default runtime остаётся `core`-only.
