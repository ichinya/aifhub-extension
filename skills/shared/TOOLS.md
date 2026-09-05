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

AI Factory project context, execution state and QA evidence remain under `.ai-factory` in every combination. HLV keeps its project layout (`project.yaml` or adopt `.hlv/project.yaml`); provider checks write only derived evidence under `.ai-factory/qa/<id>/providers/`. HLV contracts supplement the selected requirements and execution artifacts; they do not replace OpenSpec specifications or AI Factory plans.

After persisting enabled tool choices, run `ai-factory aifhub-mode init --json` during bootstrap, or before the first artifact-writing workflow when a selected tool has not been initialized. Enabling a tool authorizes creation of its missing project scaffolding. `init --dry-run --json` previews those writes. Mode switches and artifact sync also perform this idempotent initialization. Status, doctor and validation evidence reads never initialize projects.

With OpenSpec enabled, create missing `openspec/config.yaml` (default `schema: spec-driven`), `openspec/specs/` and `openspec/changes/`, preserving existing config and artifacts. With HLV enabled, inspect both root `project.yaml` and `.hlv/project.yaml` first. An existing root HLV project is valid without `.hlv/`: reuse its configured paths, contracts and milestones unchanged. Reuse an existing adopted layout the same way. Never run `hlv init` again on either existing layout, because native reinit updates managed files. If both markers exist or a partial/unsafe layout is found, report a configuration error instead of guessing.

When neither HLV marker exists, initialization invokes the installed HLV 1.0.0 `init --adopt` in the existing repository. Native adopt keeps source in place, creates `.hlv/`, creates missing `HLV.md`, `AGENTS.md` and shared `.agents/skills/` entries, and appends `.hlv/index/` to `.gitignore` if absent. It uses the standard gate profile and native initial milestone/feature defaults. Missing or unsupported HLV is an explicit setup failure; do not install or upgrade binaries automatically. Initialization is scaffolding, not validation PASS. Keep real Lekalo initialization deferred until its compatible protocol is published.

`lekalo: true` reserves an independent semantic model layer alongside either combination. Until its published provider protocol is supported, it returns `unsupported` and cannot supply validation PASS or invented model artifacts. Keep it false for ordinary work.

With `openspec: false`, do not create, select, validate, compile, or archive OpenSpec artifacts. With `hlv: false` or `lekalo: false`, do not invoke that provider or create new provider evidence. Disabling a tool preserves existing canonical files and evidence. Never remove or convert files merely because a boolean changed. Explicit migration/export remains a separate operation.

The `aifhub.tools` mapping takes precedence over the legacy `aifhub.artifactProtocol` and unpublished per-provider `enable` flags. If the entire tools mapping is absent, read the legacy settings for compatibility. New and updated configurations use the boolean mapping. `/aif-mode openspec` and `/aif-mode ai-factory` set only `tools.openspec` to true or false, preserve HLV/Lekalo choices, and reconcile the selected paths. Advanced OpenSpec settings remain under `aifhub.openspec`; provider limits and required/optional policy remain under `aifhub.providers`.
