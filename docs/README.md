[Back to README](../README.md) | [Next Page](usage.md)

# Documentation

This documentation explains the AIFHub Extension v1 workflow:

```text
AI Factory UX + OpenSpec artifact protocol
```

OpenSpec-native artifacts under `openspec/` are canonical. AI Factory artifacts under `.ai-factory/` hold runtime state, QA evidence, generated rules, and legacy migration input.

OpenSpec CLI features are reached through AIFHub wrappers and `scripts/openspec-runner.mjs`; OpenSpec skills or slash commands are not installed by the extension.

## Reading Order

1. [Project README](../README.md) for the landing page, quick start, artifact layout, compatibility summary, migration summary, and troubleshooting summary.
2. [Usage](usage.md) for the full command flow, `/aif-mode` switching and sync, rules/review/security gates, verification/fix/finalization tail, commit/evolve handoff, OAuth example, troubleshooting, and smoke checks.
3. [Context Loading Policy](context-loading-policy.md) for consumer context, ownership boundaries, generated rules, quality gates, commit handoff, and legacy path rules.
4. [OpenSpec Compatibility](openspec-compatibility.md) for optional CLI adapter support, artifact sync points, rules gate behavior, Node requirements, capability flags, and degraded mode.
5. [Legacy Plan Migration](legacy-plan-migration.md) if existing `.ai-factory/plans` artifacts need to move into OpenSpec-native changes.
6. [Active Change Resolver](active-change-resolver.md) for active change selection, runtime paths, current pointer behavior, and ambiguity diagnostics.
7. [ADR 0001](adr/0001-openspec-native-artifact-protocol.md) for the v1 artifact ownership decision.

The remaining runtime-specific guides are supporting references:

- [AIFHub MCP](aifhub-mcp.md)
- [Codex Agents](codex-agents.md)
- [Claude Agents](claude-agents.md)
- [Codex Plan Mode](codex-plan-mode.md)
- [Handoff Naming](handoff.md)

## Guides

| Guide | Purpose |
|---|---|
| [Usage](usage.md) | Full OpenSpec-native command flow, gates, finalization tail, commit, and examples |
| [Context Loading Policy](context-loading-policy.md) | Runtime context, ownership, gates, commit handoff, and legacy boundaries |
| [OpenSpec Compatibility](openspec-compatibility.md) | CLI adapter policy, sync points, rules gate, version support, and degraded mode |
| [Legacy Plan Migration](legacy-plan-migration.md) | Explicit migration commands and artifact mapping |
| [Active Change Resolver](active-change-resolver.md) | Active change selection and runtime paths |
| [ADR 0001](adr/0001-openspec-native-artifact-protocol.md) | Canonical OpenSpec and AI Factory runtime state contract |
| [AIFHub MCP](aifhub-mcp.md) | Optional MCP server tools and runtime-specific config shapes |
| [Codex Agents](codex-agents.md) | Namespaced Codex subagents and invocation contract |
| [Claude Agents](claude-agents.md) | Namespaced Claude subagents and install target |
| [Codex Plan Mode](codex-plan-mode.md) | Codex mode and question-format guidance |
| [Handoff Naming](handoff.md) | Stage vocabulary versus public CLI commands |

## Scope

This docs set covers:

- OpenSpec-native v1 workflow
- artifact mode switching and sync through `/aif-mode`
- command reads, writes, and forbidden writes
- optional rules, review, and security gates
- verification, fix, done, post-archive sync, commit, and evolve handoff
- canonical OpenSpec artifact ownership
- AI Factory runtime state, QA evidence, and generated rules
- legacy AI Factory-only compatibility and migration
- runtime-managed Codex and Claude agent files
- optional AIFHub MCP server registration and runtime-specific settings shapes

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
- [AIFHub MCP](aifhub-mcp.md)
