<!--
gate-summary:
  id: aif-fix-handoff-comment
  stage: Implementing
  status: stub
  consumers:
    - aifhub-fixer
  activation: manual-only
  readonly: false
  auto_bind: false
-->

## Future Stub: comment для `aif-fix`

Этот prompt-файл описывает заготовку для будущего handoff runtime binding вокруг fix semantics в контексте возврата из review stage.
Сейчас он не подключён ни через `extension.json`, ни через `agent-files/codex/*.toml`: ordinary fix loop остаётся `core`-only, а текущий fix consumer использует inline `developer_instructions`.

### Planned Consumer After Runtime Binding

- built-in `aif-fix`
- `aifhub-fixer` для structured fix pass в handoff context

### Planned Trigger After Runtime Binding

- explicit handoff fix request после failed gate
- возврат из Review stage в Implementing с aggregated comment от failed gates
- AIFHub-specific fix loop с bounded scope по findings

### Comment Rules

- Принимай aggregated findings от review gates как input; не пересканируй всё с нуля.
- Фокусируйся только на material findings; не превращай fix в refactoring pass.
- Сохраняй bounded scope: только changed files и plan pair artifacts.
- После fix не переходи к re-verify автоматически — это решение upstream orchestrator.

### Dormancy Contract

- Файл существует как future stub prompt asset для Handoff/AIFHub semantics.
- Пока отдельный runtime binding не реализован, этот gate не должен влиять на обычный CLI workflow.
