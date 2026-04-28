# AIFHub Extension

Extension for [ai-factory 2.x](https://github.com/lee-to/ai-factory) CLI that keeps a structured plan-folder workflow while returning the public workflow to upstream commands.

## Сводка совместимости

| Поле | Значение |
|-------|----------|
| Проверенный upstream | `ai-factory 2.10.0` |
| Поддерживаемый `compat.ai-factory` | `>=2.10.0 <3.0.0` |
| Исторический `baselineVersion` | `2.0.0` |

`baselineVersion` фиксирует историческую upstream-базу этой модели extension. Актуальные ожидания по поддержке и установке всегда определяются `compat.ai-factory`.

### OpenSpec compatibility

OpenSpec is an optional CLI adapter for the v1 OpenSpec-native artifact protocol.

| Capability | Requirement |
|---|---|
| AI Factory-only extension install/use | `ai-factory >=2.10.0 <3.0.0` |
| OpenSpec-native validation/archive | OpenSpec CLI `>=1.3.1 <2.0.0` |
| OpenSpec CLI runtime | Node `>=20.19.0` |
| OpenSpec skills/commands | Not installed by this extension |

When the OpenSpec CLI is unavailable, the extension remains usable. OpenSpec validation/archive capabilities are disabled until a compatible `openspec` CLI is available, but OpenSpec-native planning can still generate structurally correct artifacts with degraded validation. `/aif-done` fails archive-required OpenSpec-native finalization when the CLI is missing.

AI Factory-only mode follows the Node/runtime support of AI Factory and upstream. OpenSpec-native validation/archive requires Node `>=20.19.0` because that is the OpenSpec CLI runtime requirement.

OpenSpec can be initialized without tool integrations using `openspec init --tools none`, but this extension does not require running that during install.

`/aif-analyze` supports an explicit OpenSpec-native bootstrap mode. Use it only when a project requests OpenSpec-native artifacts or already has `aifhub.artifactProtocol: openspec`; otherwise the legacy AI Factory-only config remains the default. In OpenSpec-native mode, canonical plan/change artifacts map to `openspec/changes`, specs map to `openspec/specs`, and runtime AI Factory output stays under `.ai-factory/state`, `.ai-factory/qa`, and `.ai-factory/rules/generated`.

`/aif-plan full` remains the public planning entrypoint. In OpenSpec-native mode it creates `openspec/changes/<change-id>/proposal.md`, `design.md`, `tasks.md`, and behavior delta specs under `specs/**/spec.md`; legacy `.ai-factory/plans` output is AI Factory-only mode.

`/aif-explore` remains research-oriented in OpenSpec-native mode. It may read OpenSpec specs and changes, but writes research/runtime notes only to `.ai-factory/RESEARCH.md` or `.ai-factory/state/<change-id>/` and does not create non-OpenSpec files inside `openspec/changes/<change-id>/`.

`/aif-improve` refines existing OpenSpec-native artifacts in place: `proposal.md`, `design.md`, `tasks.md`, and `specs/**/spec.md`. It preserves user edits with patch-style changes, returns changed/preserved summary sections, warns or refuses archived changes, and keeps legacy plan-folder refinement as AI Factory-only behavior.

Prompt assets for `/aif-implement`, `/aif-fix`, `/aif-verify`, `/aif-done`, `/aif-rules-check`, and bundled runtime agents are mode-gated. In OpenSpec-native mode they read canonical OpenSpec artifacts and write runtime/QA/finalizer state outside `openspec/changes`; in legacy AI Factory-only mode they keep using `.ai-factory/plans` plan-folder artifacts. `/aif-done` is the OpenSpec-native finalizer: it requires passing `/aif-verify` evidence, archives through `openspec archive <change-id> --yes` via the shared OpenSpec runner, supports `--skip-specs`, writes final evidence under `.ai-factory/qa/<change-id>/`, and writes final summaries under `.ai-factory/state/<change-id>/`.

See [OpenSpec Compatibility](docs/openspec-compatibility.md) for install/upgrade notes and the capability flags planned for runtime detection.

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

Optional explicit AIFHub finalizer after passing verification:

```bash
/aif-done                     # OpenSpec CLI archive, commit/PR drafts, evidence-driven follow-ups
```

`/aif-analyze` здесь выступает отдельным bootstrap/setup step. Canonical public workflow начинается после него.

## What This Extension Adds

- `aif-analyze` remains extension-owned and bootstraps `.ai-factory/config.yaml` plus `rules/base.md`; it can also prepare explicit OpenSpec-native config without installing OpenSpec skills.
- `aif-done` is an explicit extension-owned AIFHub/Handoff finalizer that archives verified OpenSpec-native changes through OpenSpec CLI or archives verified legacy plans in AI Factory-only mode, drafts commit/PR summaries, and drives evidence-backed governance and evolution follow-ups.
- `aif-plan`, `aif-explore`, `aif-improve`, `aif-implement`, `aif-verify`, `aif-fix`, `aif-roadmap`, and `aif-evolve` remain upstream skills with extension injections.
- Full-mode planning is mode-gated:
  - OpenSpec-native mode creates `openspec/changes/<change-id>/proposal.md`, `design.md`, `tasks.md`, and behavior delta specs.
  - AI Factory-only legacy mode creates `.ai-factory/plans/<plan-id>.md` plus `.ai-factory/plans/<plan-id>/`.
- OpenSpec-native prompt assets are mode-gated: explore writes only research/runtime notes outside change folders, improve edits only canonical OpenSpec change artifacts, and implement/fix/verify/done/rules-check/runtime agents keep OpenSpec changes canonical while writing runtime output under `.ai-factory/state`, `.ai-factory/qa`, or finalizer state.
- Legacy folder-only plans are soft-migrated by generating the missing companion plan file on first improve, implement, or verify entry.
- На `ai-factory 2.10.0+` extension публикует namespaced runtime-aware `agentFiles` для Codex и Claude; подробности и ограничения собраны в [Codex Agents](docs/codex-agents.md) и [Claude Agents](docs/claude-agents.md).

## Слои Prompt Assets

- `injections/core/` содержит active `core plan-folder overlay`, который единственный подключается через `extension.json` и обслуживает обычный CLI workflow.
- `injections/handoff/` содержит four-file dormant handoff profile: future stub prompt assets для review/security/rules/done semantics. Пока отдельный runtime binding не реализован, verifier/fixer остаются частью `core` workflow и используют inline `developer_instructions` из `agent-files/codex/*.toml`. Каждый stub включает machine-consumable `<!-- gate-summary -->` блок для будущего Handoff parser.
- `injections/references/` остаётся shared root-level bucket для reference assets, которыми могут пользоваться оба слоя без дублирования.

## Канонический Public Workflow

```text
aif-explore -> aif-plan -> aif-improve -> aif-implement -> aif-verify
                                                            \-> aif-fix -> aif-verify
```

`/aif-analyze` подготавливает bootstrap context, но не входит в canonical public command path.

- Для новой работы используйте `/aif-plan full`. `/aif-new` — только historical alias; stage name `New` в handoff vocabulary не является slash command и не заменяет canonical entrypoint.
- `Explore / New / Apply / Done` могут использоваться как handoff stage names, но это naming layer, а не public CLI command list.
- `aif-apply` как delegated wrapper отложен до закрытия ownership/status contract из [issue #20](https://github.com/ichinya/aifhub-extension/issues/20). Issue #20 остаётся открытым для реальной subagent orchestration, а current public execution entrypoint — `/aif-implement`.
- `/aif-done` — explicit AIFHub/Handoff finalizer после `/aif-verify`, а не восстановленный legacy alias и не часть canonical public CLI workflow.

## Documentation

| Guide | Description |
|-------|-------------|
| [Documentation Index](docs/README.md) | Overview and recommended reading order |
| [Usage](docs/usage.md) | Current command flow, examples, and smoke checks |
| [Codex Agents](docs/codex-agents.md) | Namespaced Codex subagents, sandbox contract, and explicit invocation examples |
| [Claude Agents](docs/claude-agents.md) | Namespaced Claude subagents, `.claude/agents/` install target, and handoff limitations |
| [Handoff Naming](docs/handoff.md) | Терминология `Explore / New / Apply / Done` без возврата legacy commands в public path |
| [Context Loading Policy](docs/context-loading-policy.md) | Runtime context contract and ownership rules |
| [OpenSpec Compatibility](docs/openspec-compatibility.md) | Optional OpenSpec CLI adapter policy, OpenSpec-native planning, degraded mode, and capability flags |

## Validation

CI автоматически проверяет manifest paths, Codex/Claude agent schema и doc links на каждом PR.

Локальный запуск:

```bash
npm run validate   # все валидаторы
npm test           # все тесты
```

## Requirements

- `ai-factory CLI >=2.10.0 <3.0.0`
- Optional OpenSpec-native validation/archive: `openspec CLI >=1.3.1 <2.0.0` on Node `>=20.19.0`
- OpenSpec skills/commands are not installed by this extension.
- Missing OpenSpec CLI is degraded AI Factory-only mode, not an extension install failure.

Отслеживание совместимости ведётся в `extension.json`:

- `compat.ai-factory`: поддерживаемый диапазон `ai-factory`
- `sources.ai-factory.version`: последняя проверенная upstream-версия
- `sources.ai-factory.baselineVersion`: исторический baseline исходной модели extension
- `sources.ai-factory.notes`: причина текущей минимально поддерживаемой версии
- `sources.openspec`: optional OpenSpec CLI adapter baseline, supported range, Node requirement, and degraded-mode policy

## Update Behavior

- `ai-factory update` refreshes built-in skills and reapplies extension injections.
- На поддерживаемых релизах `ai-factory` объявленные в manifest `agentFiles` продолжают управляться через extension contract.
- `ai-factory extension update` refreshes the installed extension copy from its Git source.
- Passing `/aif-verify` now leaves the plan in a verified state; optional archival, summaries, and final follow-up orchestration live in `/aif-done`.

## License

MIT
