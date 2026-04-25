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
| [Codex Agents](codex-agents.md) | Namespaced Codex subagents, sandbox contract, and explicit invocation examples |
| [Claude Agents](claude-agents.md) | Namespaced Claude subagents, `.claude/agents/` install target, and handoff limitations |
| [Handoff Naming](handoff.md) | Stage vocabulary versus current public commands and future mapping constraints |
| [Context Loading Policy](context-loading-policy.md) | Runtime context contract, ownership boundaries, and artifact rules |

## Recommended Reading Order

1. Read [Usage](usage.md) for the command path, runtime notes, and smoke checks.
2. Read [Codex Agents](codex-agents.md) or [Claude Agents](claude-agents.md) for the runtime-specific subagent contract you need.
3. Read [Handoff Naming](handoff.md) for current manual stages versus future mapping.
4. Read [Context Loading Policy](context-loading-policy.md) for ownership and runtime path rules.

## Scope

This docs set covers:

- public workflow for the extension
- companion plan-file plus plan-folder model
- runtime-контекст, границы владения и проверенный контракт совместимости

Project-level AI Factory planning and archived specs remain under `.ai-factory/` and are not duplicated here.

## See Also

- [Usage](usage.md) - workflow, examples, and smoke-check steps
- [Codex Agents](codex-agents.md) - runtime-managed Codex agent files and invocation contract
- [Claude Agents](claude-agents.md) - runtime-managed Claude agent files and `.claude/agents/` behavior
- [Handoff Naming](handoff.md) - current manual stages and future stage-agent mapping constraints
- [Context Loading Policy](context-loading-policy.md) - context-loading and ownership rules
- [Project README](../README.md) - landing page and quick start
