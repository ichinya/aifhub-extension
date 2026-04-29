[Back to README](../README.md) | [Next Page](usage.md)

# Documentation

This documentation explains the AIFHub Extension v1 workflow:

```text
AI Factory UX + OpenSpec artifact protocol
```

OpenSpec-native artifacts under `openspec/` are canonical. AI Factory artifacts under `.ai-factory/` hold runtime state, QA evidence, generated rules, and legacy migration input.

## Reading Order

1. [Project README](../README.md) for the landing page, quick start, artifact layout, compatibility summary, migration summary, and troubleshooting summary.
2. [Usage](usage.md) for the full command flow, command read/write boundaries, OAuth example, troubleshooting, and smoke checks.
3. [Context Loading Policy](context-loading-policy.md) for consumer context, ownership boundaries, generated rules, and legacy path rules.
4. [OpenSpec Compatibility](openspec-compatibility.md) for optional CLI adapter support, Node requirements, capability flags, and degraded mode.
5. [Legacy Plan Migration](legacy-plan-migration.md) if existing `.ai-factory/plans` artifacts need to move into OpenSpec-native changes.
6. [Active Change Resolver](active-change-resolver.md) for active change selection, runtime paths, current pointer behavior, and ambiguity diagnostics.
7. [ADR 0001](adr/0001-openspec-native-artifact-protocol.md) for the v1 artifact ownership decision.

The remaining runtime-specific guides are supporting references:

- [Codex Agents](codex-agents.md)
- [Claude Agents](claude-agents.md)
- [Codex Plan Mode](codex-plan-mode.md)
- [Handoff Naming](handoff.md)

## Guides

| Guide | Purpose |
|---|---|
| [Usage](usage.md) | Full OpenSpec-native command flow and examples |
| [Context Loading Policy](context-loading-policy.md) | Runtime context, ownership, and legacy boundaries |
| [OpenSpec Compatibility](openspec-compatibility.md) | CLI adapter policy, version support, and degraded mode |
| [Legacy Plan Migration](legacy-plan-migration.md) | Explicit migration commands and artifact mapping |
| [Active Change Resolver](active-change-resolver.md) | Active change selection and runtime paths |
| [ADR 0001](adr/0001-openspec-native-artifact-protocol.md) | Canonical OpenSpec and AI Factory runtime state contract |
| [Codex Agents](codex-agents.md) | Namespaced Codex subagents and invocation contract |
| [Claude Agents](claude-agents.md) | Namespaced Claude subagents and install target |
| [Codex Plan Mode](codex-plan-mode.md) | Codex mode and question-format guidance |
| [Handoff Naming](handoff.md) | Stage vocabulary versus public CLI commands |

## Scope

This docs set covers:

- OpenSpec-native v1 workflow
- command reads, writes, and forbidden writes
- canonical OpenSpec artifact ownership
- AI Factory runtime state, QA evidence, and generated rules
- legacy AI Factory-only compatibility and migration
- runtime-managed Codex and Claude agent files

It does not document `.ai-factory/plans` as the normal v1 artifact model. Those paths are legacy compatibility and migration input only.

## Local Checks

Run:

```bash
npm run validate
npm test
```

`npm run validate` checks markdown links under `docs/`, `injections/`, and `skills/`. Root `README.md` links need a manual check when edited.

## See Also

- [Project README](../README.md)
- [Usage](usage.md)
- [Context Loading Policy](context-loading-policy.md)
- [OpenSpec Compatibility](openspec-compatibility.md)
- [Legacy Plan Migration](legacy-plan-migration.md)
- [Active Change Resolver](active-change-resolver.md)
- [ADR 0001](adr/0001-openspec-native-artifact-protocol.md)
