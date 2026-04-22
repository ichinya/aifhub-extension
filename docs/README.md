[Back to README](../README.md) · [Next Page →](usage.md)

# Documentation

Detailed documentation for the AIFHub extension.

## Сводка совместимости

| Поле | Значение |
|-------|----------|
| Проверенный upstream | `ai-factory 2.10.0` |
| Поддерживаемый диапазон | `>=2.10.0 <3.0.0` |
| Исторический `baselineVersion` | `2.0.0` |

Для решений о поддержке ориентируйтесь на `compat.ai-factory`. `baselineVersion` нужен только как исторический контекст.

## Guides

| Guide | Description |
|-------|-------------|
| [Usage](usage.md) | Canonical workflow, command behavior, and smoke checks |
| [Context Loading Policy](context-loading-policy.md) | Runtime context contract, ownership boundaries, and artifact rules |

## Recommended Reading Order

1. Read [Usage](usage.md) for the command path and operational flow.
2. Read [Context Loading Policy](context-loading-policy.md) for ownership and runtime path rules.

## Scope

This docs set covers:

- public workflow for the extension
- companion plan-file plus plan-folder model
- runtime-контекст, границы владения и проверенный контракт совместимости

Project-level AI Factory planning and archived specs remain under `.ai-factory/` and are not duplicated here.

## See Also

- [Usage](usage.md) - workflow, examples, and smoke-check steps
- [Context Loading Policy](context-loading-policy.md) - context-loading and ownership rules
- [Project README](../README.md) - landing page and quick start
