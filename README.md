# AIFHub Extension

Extension for [ai-factory 2.x](https://github.com/lee-to/ai-factory) CLI that keeps a structured plan-folder workflow while returning the public workflow to upstream commands.

## Сводка совместимости

| Поле | Значение |
|-------|----------|
| Проверенный upstream | `ai-factory 2.10.0` |
| Поддерживаемый `compat.ai-factory` | `>=2.10.0 <3.0.0` |
| Исторический `baselineVersion` | `2.0.0` |

`baselineVersion` фиксирует историческую upstream-базу этой модели extension. Актуальные ожидания по поддержке и установке всегда определяются `compat.ai-factory`.

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
- В установках Codex ограниченные worker agents подключаются через runtime-aware `agentFiles` на `ai-factory 2.10.0+`.

## Current Workflow

```text
aif-analyze -> aif-explore -> aif-plan -> aif-improve -> aif-implement -> aif-verify
                                                                      \-> aif-fix -> aif-verify
```

The public workflow no longer includes `aif-new`, `aif-apply`, or `aif-done`.

## Documentation

| Guide | Description |
|-------|-------------|
| [Documentation Index](docs/README.md) | Overview and recommended reading order |
| [Usage](docs/usage.md) | Current command flow, examples, and smoke checks |
| [Context Loading Policy](docs/context-loading-policy.md) | Runtime context contract and ownership rules |

## Requirements

- `ai-factory CLI >=2.10.0 <3.0.0`

Отслеживание совместимости ведётся в `extension.json`:

- `compat.ai-factory`: поддерживаемый диапазон `ai-factory`
- `sources.ai-factory.version`: последняя проверенная upstream-версия
- `sources.ai-factory.baselineVersion`: исторический baseline исходной модели extension
- `sources.ai-factory.notes`: причина текущей минимально поддерживаемой версии

## Update Behavior

- `ai-factory update` refreshes built-in skills and reapplies extension injections.
- На поддерживаемых релизах `ai-factory` объявленные в manifest `agentFiles` продолжают управляться через extension contract.
- `ai-factory extension update` refreshes the installed extension copy from its Git source.
- Passing `/aif-verify` now performs final archival automatically unless `--check-only` is used.

## License

MIT
