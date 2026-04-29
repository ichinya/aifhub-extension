[Previous Page](context-loading-policy.md) | [Back to Documentation](README.md) | [Next Page](legacy-plan-migration.md)

# OpenSpec Compatibility

OpenSpec is an optional CLI adapter for the v1 OpenSpec-native artifact protocol.

AIFHub Extension can create and consume OpenSpec-native filesystem artifacts without a local OpenSpec CLI. Validation and archive operations require a compatible CLI.

## Supported Versions

| Capability | Requirement |
|---|---|
| AI Factory extension install/use | `ai-factory >=2.10.0 <3.0.0` |
| OpenSpec-native validation/archive | OpenSpec CLI `>=1.3.1 <2.0.0` |
| OpenSpec CLI runtime | Node `>=20.19.0` |
| OpenSpec skills/commands | Not installed by this extension |

AI Factory-only workflows follow AI Factory's runtime support. OpenSpec validation/archive follows the OpenSpec CLI runtime requirement.

## Optional Initialization

Projects may initialize OpenSpec without tool integrations:

```bash
openspec init --tools none
```

This is optional. The extension installer does not run it.

OpenSpec skills and slash commands are not installed by this extension.

## OpenSpec-Native Config

OpenSpec-native mode is selected through `.ai-factory/config.yaml`:

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

`installSkills: false` is intentional. AIFHub Extension uses OpenSpec artifacts and the optional CLI adapter, not OpenSpec-installed skills.

## OpenSpec-Native Planning

`/aif-plan full` remains the public planning entrypoint. In OpenSpec-native mode it creates:

```text
openspec/changes/<change-id>/
  proposal.md
  design.md
  tasks.md
  specs/<capability>/spec.md
```

It does not create `.ai-factory/plans/<id>.md` or `.ai-factory/plans/<id>/task.md` in OpenSpec-native mode. Missing or unsupported OpenSpec CLI is degraded validation, not planning failure.

## Capability Shape

`scripts/openspec-runner.mjs` exposes capability detection with this stable minimum:

```yaml
openspec:
  available: boolean
  canValidate: boolean
  canArchive: boolean
  version: string | null
  supportedRange: ">=1.3.1 <2.0.0"
  requiresNode: ">=20.19.0"
```

The current runner also reports operational detail fields:

```yaml
openspec:
  nodeVersion: string
  nodeSupported: boolean
  versionSupported: boolean
  command: string
  reason: string | null
  errors:
    - code: string
      message: string
```

Commands should treat the stable minimum as the contract and the operational detail fields as diagnostics.

## Degraded Mode

When the OpenSpec CLI is missing or unsupported:

- extension install remains valid
- OpenSpec-native planning can still write `openspec/changes/<change-id>/`
- generated-rules and execution context may continue from filesystem artifacts
- `/aif-verify` records degraded validation unless strict config requires CLI availability
- `/aif-done` fails archive-required finalization because archive requires a compatible CLI

When Node is below `>=20.19.0`, the CLI is treated as unavailable for validate/archive capabilities even if an `openspec` command exists.

## Prompt Assets and Runtime Integration

OpenSpec-native prompt assets are mode-gated. They keep canonical changes under `openspec/changes/<change-id>/`, read generated rules as derived guidance, and write runtime state or QA evidence under `.ai-factory/state/<change-id>/` and `.ai-factory/qa/<change-id>/`.

Scoped runtime integrations are already documented in the active prompt assets: #31 covers implementation/fix runtime state alignment, #32 covers verify validate/status runtime behavior, and done finalization covers archive/finalizer integration.

## Validation and Archive

Validation uses:

```bash
openspec validate <change-id> --type change --strict --json --no-interactive --no-color
```

Status evidence uses:

```bash
openspec status --change <change-id> --json --no-color
```

Archive-required finalization uses:

```bash
openspec archive <change-id> --yes --no-color
```

`/aif-done --skip-specs` may add `--skip-specs` for docs/tooling-only changes.

## See Also

- [Usage](usage.md)
- [Context Loading Policy](context-loading-policy.md)
- [Active Change Resolver](active-change-resolver.md)
- [ADR 0001](adr/0001-openspec-native-artifact-protocol.md)
