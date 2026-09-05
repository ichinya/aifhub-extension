# Optional tools and artifact ownership

AI Factory remains the workflow base. Resolve `.ai-factory/config.yaml` before choosing artifact paths:

```yaml
aifhub:
  tools:
    openspec: false
    hlv: false
    lekalo: false
```

Each switch is an independent, unquoted boolean. Omitted tools default to false. Use `ai-factory aifhub-mode status --json` for the resolved tools and artifact paths. Malformed switches block the workflow; installed binaries or existing directories never enable a tool.

| OpenSpec | HLV | Active artifacts |
| --- | --- | --- |
| false | false | AI Factory plans and specifications under `.ai-factory/plans` and `.ai-factory/specs` |
| true | false | OpenSpec changes and specifications under `openspec/changes` and `openspec/specs` |
| false | true | AI Factory plans/specifications plus HLV contracts and traceability |
| true | true | OpenSpec changes/specifications plus HLV contracts and traceability |

AI Factory project context, execution state and QA evidence remain under `.ai-factory` in every combination. HLV keeps its own initialized project layout (`project.yaml` or adopt `.hlv/project.yaml`); provider checks write only derived evidence under `.ai-factory/qa/<id>/providers/`. Enabling HLV requires a compatible user-installed and initialized tool, and does not run init/update/sync automatically. HLV contracts supplement the selected requirements and execution artifacts; they do not replace OpenSpec specifications or AI Factory plans.

`lekalo: true` reserves an independent semantic model layer alongside either combination. Until its published provider protocol is supported, it returns `unsupported` and cannot supply validation PASS or invented model artifacts. Keep it false for ordinary work.

With `openspec: false`, do not create, select, validate, compile, or archive OpenSpec artifacts. With `hlv: false` or `lekalo: false`, do not invoke that provider or create new provider evidence. Disabling a tool preserves existing canonical files and evidence. Never remove or convert files merely because a boolean changed. Explicit migration/export remains a separate operation.

The `aifhub.tools` mapping takes precedence over the legacy `aifhub.artifactProtocol` and unpublished per-provider `enable` flags. If the entire tools mapping is absent, read the legacy settings for compatibility. New and updated configurations use the boolean mapping. `/aif-mode openspec` and `/aif-mode ai-factory` set only `tools.openspec` to true or false, preserve HLV/Lekalo choices, and reconcile the selected paths. Advanced OpenSpec settings remain under `aifhub.openspec`; provider limits and required/optional policy remain under `aifhub.providers`.
