[Back to Documentation](README.md)

# OpenSpec Compatibility

OpenSpec is an optional CLI adapter for the v1 OpenSpec-native artifact protocol. This page records the supported baseline, bootstrap/config behavior, mode-gated prompt assets, `/aif-plan full` OpenSpec-native planning behavior, runtime detection surface, and expected degraded behavior.

## Supported Versions

| Capability | Requirement |
|---|---|
| AI Factory-only extension install/use | `ai-factory >=2.10.0 <3.0.0` |
| OpenSpec-native validation/archive | OpenSpec CLI `>=1.3.1 <2.0.0` |
| OpenSpec CLI runtime | Node `>=20.19.0` |
| OpenSpec skills/commands | Not installed by this extension |

AI Factory-only mode follows the Node/runtime support of AI Factory and upstream. OpenSpec-native validation and archive require Node `>=20.19.0`, matching the OpenSpec CLI runtime requirement.

OpenSpec can be initialized without tool integrations using:

```bash
openspec init --tools none
```

The AIFHub extension does not require this command during install.

## OpenSpec-Native Bootstrap Mode

`/aif-analyze` supports an explicit OpenSpec-native bootstrap/config mode. The mode is selected only when the user asks for `openspec-native` or when existing config already has:

```yaml
aifhub:
  artifactProtocol: openspec
```

In that mode, `.ai-factory/config.yaml` can include:

```yaml
aifhub:
  artifactProtocol: openspec
  openspec:
    root: openspec
    installSkills: false
    validateOnPlan: true
    validateOnVerify: true
    archiveOnDone: true

paths:
  plans: openspec/changes
  specs: openspec/specs
  state: .ai-factory/state
  qa: .ai-factory/qa
  generated_rules: .ai-factory/rules/generated
```

OpenSpec-native bootstrap verifies or creates `openspec/config.yaml`, `openspec/specs/`, `openspec/changes/`, `.ai-factory/state/`, `.ai-factory/qa/`, and `.ai-factory/rules/generated/`. If a compatible OpenSpec CLI is present, the skill may use or recommend `openspec init --tools none`; if the CLI is missing or unsupported, bootstrap continues with manual skeleton behavior and degraded capability flags.

OpenSpec skills and slash commands are not installed by this extension.

## OpenSpec-Native Planning

`/aif-plan full` remains the public planning entrypoint. When `.ai-factory/config.yaml` has `aifhub.artifactProtocol: openspec`, planning creates canonical OpenSpec change artifacts instead of legacy AI Factory plan folders:

```text
openspec/changes/<change-id>/
  proposal.md
  design.md
  tasks.md
  specs/<capability>/spec.md
```

Behavior-changing plans should include at least one delta spec under `specs/**/spec.md`. Docs/tooling-only plans may omit a delta spec only when they explicitly explain why no product or workflow behavior changes.

Planning validates through `scripts/openspec-runner.mjs` with `validateOpenSpecChange(changeId)` when a compatible OpenSpec CLI is available. Missing or unsupported OpenSpec CLI is degraded validation, not planning failure.

Legacy `.ai-factory/plans/<plan-id>.md` plus `.ai-factory/plans/<plan-id>/` output remains available only in AI Factory-only mode.

## Install And Upgrade Notes

This change only updates extension policy, metadata, and documentation. OpenSpec remains an optional external CLI adapter and is not added to `dependencies` or `devDependencies`.

When a compatible OpenSpec CLI is missing:

- extension install remains valid
- AI Factory bootstrap/config workflows may still run in AI Factory-only mode
- OpenSpec-native validation is unavailable and `/aif-verify` continues in degraded mode unless `aifhub.openspec.requireCliForVerify: true`
- OpenSpec-native archive is unavailable
- OpenSpec-aware commands should report capability flags instead of failing extension install

OpenSpec skills and slash commands are not installed by this extension in v1.

## Runtime Capability Flags

Issue #38 adds the shared runner in `scripts/openspec-runner.mjs` for OpenSpec CLI detection and normalized command execution. OpenSpec-aware commands consume capability metadata equivalent to:

```yaml
openspec:
  available: boolean
  canValidate: boolean
  canArchive: boolean
  version: string | null
  supportedRange: ">=1.3.1 <2.0.0"
  requiresNode: ">=20.19.0"
  nodeSupported: boolean
  versionSupported: boolean
```

`/aif-verify` uses `scripts/openspec-verification-context.mjs` with `scripts/openspec-runner.mjs` to validate the active OpenSpec change before normal code checks. Invalid OpenSpec artifacts hard-fail before lint, tests, or review. Validation/status evidence is written under `.ai-factory/qa/<change-id>/`; `/aif-verify` does not archive.

The runner reports missing or incompatible OpenSpec environments as structured degraded-mode data. OpenSpec-native bootstrap, planning, generated-rules guidance, and prompt assets for implement, fix, verify, done, rules-check, and runtime agents consume this capability shape. Runtime integrations remain scoped: #31 covers implementation/fix runtime state alignment, #32 covers verify validate/status runtime behavior, and #33 covers archive/finalizer integration.
