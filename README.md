# AIFHub Extension

Extension for [ai-factory 2.x](https://github.com/lee-to/ai-factory) CLI that keeps a structured plan-folder workflow while returning the public workflow to upstream commands.

## Quick Start

```bash
ai-factory extension add https://github.com/ichinya/aifhub-extension.git
```

Run:

```bash
/aif-analyze
```

Then use:

```bash
/aif-explore "your feature"   # optional
/aif-plan full "your feature"
/aif-improve
/aif-implement
/aif-verify
```

If verification finds issues:

```bash
/aif-fix
/aif-verify
```

## What This Extension Adds

- `aif-analyze` remains extension-owned and bootstraps `.ai-factory/config.yaml` plus `rules/base.md`.
- `aif-plan`, `aif-explore`, `aif-improve`, `aif-implement`, `aif-verify`, `aif-fix`, `aif-roadmap`, and `aif-evolve` remain upstream skills with extension injections.
- Full-mode plans use a dual artifact model:
  - `.ai-factory/plans/<plan-id>.md`
  - `.ai-factory/plans/<plan-id>/`
- Legacy folder-only plans are soft-migrated by generating the missing companion plan file on first improve, implement, or verify entry.
- Codex installs receive bounded worker agents through `agentFiles`.

## Command Mapping

- `/aif-new` -> `/aif-plan full`
- `/aif-apply` -> `/aif-implement`
- `/aif-done` -> `/aif-verify`

These old commands are migration references only, not the recommended path.

## Documentation

- [docs/README.md](/C:/projects/aifhub/aifhub-extension/docs/README.md)
- [docs/usage.md](/C:/projects/aifhub/aifhub-extension/docs/usage.md)
- [docs/context-loading-policy.md](/C:/projects/aifhub/aifhub-extension/docs/context-loading-policy.md)

## Requirements

- `ai-factory CLI >=2.8.0 <3.0.0`

Compatibility tracking lives in `extension.json`:

- `compat.ai-factory`: supported ai-factory range
- `sources.ai-factory`: last reviewed upstream release and migration notes

## Update Behavior

- `ai-factory update` refreshes built-in skills and reapplies extension injections.
- `ai-factory extension update` refreshes the installed extension copy from its Git source.
- Passing `/aif-verify` now performs final archival automatically unless `--check-only` is used.

## License

MIT
