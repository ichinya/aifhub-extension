[Back to Documentation](README.md)

# OpenSpec Compatibility

OpenSpec is an optional CLI adapter for the v1 OpenSpec-native artifact protocol. This page records the supported baseline, runtime detection surface, and expected degraded behavior; it does not implement OpenSpec-native artifacts or OpenSpec skill/command installation.

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

## Install And Upgrade Notes

This change only updates extension policy, metadata, and documentation. OpenSpec remains an optional external CLI adapter and is not added to `dependencies` or `devDependencies`.

When a compatible OpenSpec CLI is missing:

- extension install remains valid
- AI Factory bootstrap/config workflows may still run in AI Factory-only mode
- OpenSpec-native validation is unavailable
- OpenSpec-native archive is unavailable
- future OpenSpec-aware commands should report capability flags instead of failing extension install

OpenSpec skills and slash commands are not installed by this extension in v1.

## Runtime Capability Flags

Issue #38 adds the shared runner in `scripts/openspec-runner.mjs` for OpenSpec CLI detection and normalized command execution. Future OpenSpec-aware commands should consume capability metadata equivalent to:

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

The runner reports missing or incompatible OpenSpec environments as structured degraded-mode data. OpenSpec-native bootstrap, planning, verification, archive integration, migration, generated rules, and prompt rewrites remain separate follow-up work.
