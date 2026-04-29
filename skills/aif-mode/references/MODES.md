# AIFHub Artifact Modes

## OpenSpec-Native Mode

OpenSpec-native mode is selected by:

```yaml
aifhub:
  artifactProtocol: openspec
  openspec:
    root: openspec
    installSkills: false
    validateOnPlan: true
    validateOnImprove: true
    validateOnVerify: true
    statusOnVerify: true
    archiveOnDone: true
    useInstructionsApply: true
    compileRulesOnSync: true
    validateOnSync: true
    requireCliForVerify: false
    requireCliForDone: true

paths:
  plans: openspec/changes
  specs: openspec/specs
  state: .ai-factory/state
  qa: .ai-factory/qa
  generated_rules: .ai-factory/rules/generated
```

Canonical requirements and change intent live under `openspec/`. Runtime state, QA evidence, migration reports, and generated rules live under `.ai-factory/`.

Ensure these paths:

```text
openspec/config.yaml
openspec/specs/
openspec/changes/
.ai-factory/state/
.ai-factory/qa/
.ai-factory/rules/generated/
```

OpenSpec CLI is optional for filesystem artifacts. AIFHub skills request validation, status, instructions, and archive through `scripts/openspec-runner.mjs`, not through installed OpenSpec skills or slash commands. Validation and archive readiness require a compatible CLI.

## Legacy AI Factory-Only Mode

Legacy mode is selected by:

```yaml
aifhub:
  artifactProtocol: ai-factory

paths:
  plans: .ai-factory/plans
  specs: .ai-factory/specs
  rules: .ai-factory/rules
```

Legacy mode uses the companion plan model:

```text
.ai-factory/plans/<id>.md
.ai-factory/plans/<id>/
```

Do not delete `openspec/` when switching to legacy mode. Treat existing OpenSpec artifacts as preserved history or a previous canonical source.

## Status Fields

`/aif-mode status` reports:

```text
Current mode: openspec | ai-factory | unknown
Config marker: aifhub.artifactProtocol
OpenSpec CLI: available/degraded
OpenSpec changes: N
Legacy plans: N
Generated rules: ok/missing/stale
Active change: <change-id> | ambiguous | none
```
