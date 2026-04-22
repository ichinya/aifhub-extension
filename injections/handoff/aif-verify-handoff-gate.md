<!--
gate-summary:
  id: aif-verify-handoff-gate
  stage: Implementing
  status: stub
  consumers:
    - aifhub-verifier
  activation: manual-only
  readonly: true
  auto_bind: false
-->

## Future Stub: gate для `aif-verify`

Этот prompt-файл хранит заготовку для будущего handoff runtime binding вокруг verification gate semantics.
Сейчас он не подключён ни через `extension.json`, ни через `agent-files/codex/*.toml`: ordinary workflow остаётся `core`-only, а текущий verification consumer использует inline `developer_instructions`.

### Planned Consumer After Runtime Binding

- built-in `aif-verify`
- `aifhub-verifier` для structured verification pass в handoff context

### Planned Trigger After Runtime Binding

- explicit handoff verification request
- transition от Implementing к Review в handoff orchestration
- AIFHub-specific check-only verification перед review gates

### Gate Rules

- Проверяй только execution scope текущего plan pair.
- Возвращай structured verdict (PASS/FAIL) с findings list; отсутствие findings формулируй явно.
- При `--check-only` не выполняй finalization и не архивируй plan.
- Не подменяй canonical `/aif-implement -> /aif-verify` flow и не предлагай auto-activation через public manifest.

### Dormancy Contract

- Файл существует как future stub prompt asset для Handoff/AIFHub semantics.
- Пока отдельный runtime binding не реализован, этот gate не должен влиять на обычный CLI workflow.
