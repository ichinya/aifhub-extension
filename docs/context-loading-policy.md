[Previous Page](usage.md) | [Back to Documentation](README.md) | [Next Page](openspec-compatibility.md)

# Context Loading Policy

This policy defines which artifacts AIFHub Extension commands load and which artifacts they may write.

OpenSpec-native v1 has one core rule: canonical requirements and change intent live under `openspec/`; runtime state, QA evidence, and generated rules live under `.ai-factory/`.

## Modes

### OpenSpec-Native Mode

OpenSpec-native mode is selected when `.ai-factory/config.yaml` contains:

```yaml
aifhub:
  artifactProtocol: openspec
```

In this mode, plan-aware commands resolve active work from `openspec/changes/<change-id>/`, not from `.ai-factory/plans/`.

### Legacy AI Factory-Only Mode

Legacy AI Factory-only mode uses the older companion plan model:

```text
.ai-factory/plans/<plan-id>.md
.ai-factory/plans/<plan-id>/
```

These paths remain supported only for legacy compatibility and explicit migration input.

## Base Context

Consumer commands load these project context files when present:

- `.ai-factory/config.yaml`
- `.ai-factory/DESCRIPTION.md`
- `.ai-factory/ARCHITECTURE.md`
- `.ai-factory/RULES.md`
- `.ai-factory/rules/base.md`
- configured area rules from `.ai-factory/config.yaml`

Consumer commands must not use bridge files such as `AGENTS.md`, `CLAUDE.md`, `QWEN.md`, or `AIFACTORY.md` as substitutes for configured context paths.

## OpenSpec-Native Context Set

Plan-aware consumer commands load these canonical artifacts:

- `openspec/changes/<change-id>/proposal.md`
- `openspec/changes/<change-id>/design.md`
- `openspec/changes/<change-id>/tasks.md`
- `openspec/changes/<change-id>/specs/**/spec.md`
- `openspec/specs/**/spec.md`

They may also load derived/runtime artifacts:

- `.ai-factory/rules/generated/openspec-base.md`
- `.ai-factory/rules/generated/openspec-change-<change-id>.md`
- `.ai-factory/rules/generated/openspec-merged-<change-id>.md`
- `.ai-factory/state/<change-id>/**`
- `.ai-factory/qa/<change-id>/**`

Generated rules are derived guidance only. If generated rules conflict with canonical OpenSpec artifacts, canonical OpenSpec artifacts win.

## Command Ownership

| Command | May write canonical OpenSpec artifacts | May write runtime or QA artifacts |
|---|---|---|
| `/aif-analyze` | Optional `openspec/` skeleton only when configured | capability/config setup |
| `/aif-plan full` | `openspec/changes/<change-id>/proposal.md`, `design.md`, `tasks.md`, `specs/**/spec.md` | optional `.ai-factory/state/<change-id>/` |
| `/aif-explore` | no | `.ai-factory/RESEARCH.md`, `.ai-factory/state/<change-id>/` |
| `/aif-improve` | `proposal.md`, `design.md`, `tasks.md`, `specs/**/spec.md` | optional `.ai-factory/state/<change-id>/` |
| `/aif-implement` | no, unless explicitly requested for selected scope | `.ai-factory/state/<change-id>/implementation/` |
| `/aif-fix` | no, unless explicitly requested for selected finding scope | `.ai-factory/state/<change-id>/fixes/` |
| `/aif-verify` | no | `.ai-factory/qa/<change-id>/` |
| `/aif-rules-check` | no | no |
| `/aif-done` | `openspec/specs/**` only through OpenSpec CLI archive | `.ai-factory/qa/<change-id>/`, `.ai-factory/state/<change-id>/final-summary.md` |

## Legacy Artifact Boundaries

These files are legacy AI Factory-only artifacts or migration input only:

- `.ai-factory/plans/<id>.md`
- `.ai-factory/plans/<id>/task.md`
- `.ai-factory/plans/<id>/context.md`
- `.ai-factory/plans/<id>/rules.md`
- `.ai-factory/plans/<id>/verify.md`
- `.ai-factory/plans/<id>/status.yaml`
- `.ai-factory/plans/<id>/explore.md`
- `.ai-factory/plans/<id>/fixes/*.md`

OpenSpec-native commands must not require those files and must not create them as part of normal OpenSpec-native execution.

## Migration Context

Legacy migration is explicit. It reads `.ai-factory/plans` artifacts and writes:

- canonical migrated artifacts under `openspec/changes/<change-id>/`
- preserved runtime notes under `.ai-factory/state/<change-id>/`
- preserved legacy verification evidence under `.ai-factory/qa/<change-id>/`

Migration never silently deletes legacy source artifacts and never writes migrated artifacts under `openspec/specs/`.

See [Legacy Plan Migration](legacy-plan-migration.md).

## Generated Rules

`.ai-factory/rules/generated/` is owned by the OpenSpec generated-rules compiler. Files in that directory are safe to delete and regenerate from:

```text
openspec/specs/**/spec.md
openspec/changes/<change-id>/specs/**/spec.md
```

Read-only gates report missing or stale generated rules as warnings and do not regenerate them automatically.

## Fallback Behavior

If `.ai-factory/config.yaml` is missing or incomplete:

- consumer commands stop when they cannot resolve required paths safely
- they should suggest `/aif-analyze` to initialize or repair config
- they must not fabricate canonical artifacts from chat context alone

## See Also

- [Usage](usage.md)
- [OpenSpec Compatibility](openspec-compatibility.md)
- [Legacy Plan Migration](legacy-plan-migration.md)
- [ADR 0001](adr/0001-openspec-native-artifact-protocol.md)
