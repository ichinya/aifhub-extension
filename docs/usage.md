[← Previous Page](README.md) · [Back to README](../README.md) · [Next Page →](context-loading-policy.md)

# Usage

## Skills

| Skill | Type | Purpose |
|-------|------|---------|
| `/aif-analyze` | Extension skill | Bootstrap `.ai-factory/config.yaml` and `rules/base.md` |
| `/aif-explore` | Built-in + injection | Explore ideas and persist only `.ai-factory/RESEARCH.md` |
| `/aif-plan` | Built-in + injection | Create the companion plan file + plan folder pair |
| `/aif-improve` | Built-in + injection | Refine both plan layers together before execution |
| `/aif-implement` | Built-in + injection | Execute tasks and own git plus execution metadata |
| `/aif-verify` | Built-in + injection | Verify findings and finalize/archive passing plans unless `--check-only` is used |
| `/aif-fix` | Built-in + injection | Apply fixes for verification findings |
| `/aif-roadmap` | Built-in + injection | Evidence-based maturity audit roadmap |
| `/aif-evolve` | Built-in + injection | Plan-evidence-driven evolution workflow |

## Workflow

```text
aif-analyze -> aif-explore -> aif-plan -> aif-improve -> aif-implement -> aif-verify
                                                                      \-> aif-fix -> aif-verify
```

The public workflow no longer includes `aif-new`, `aif-apply`, or `aif-done`.

## Совместимость

- Это руководство рассчитано на `ai-factory >=2.10.0 <3.0.0`.
- Extension хранит `sources.ai-factory.baselineVersion = 2.0.0` только как исторический контекст.
- Runtime-aware Codex `agentFiles` входят в поддерживаемый контракт, начиная с проверенного upstream `2.10.0`.

## Bundled Codex Agents

- Extension публикует bundled Codex agents через top-level поле `agentFiles` в `extension.json`.
- Codex не спаунит эти агенты автоматически только из-за факта установки extension; для запуска нужен явный запрос пользователя или orchestrator logic в уже идущем subagent workflow.
- Subagent workflows в Codex доступны по умолчанию, но стартуют только когда их явно попросили использовать.
- Подробности по именам `aifhub-*`, expected `sandbox_mode` и примерам вызова собраны в [Codex Agents](codex-agents.md).

## Installation

```bash
ai-factory extension add https://github.com/ichinya/aifhub-extension.git
```

Notes:
- `ai-factory extension list` prints `name/version/source` from `.ai-factory.json`
- update through `ai-factory extension update` against the Git source configured in `.ai-factory.json`

## Typical Flow

### 1. Analyze project

```bash
/aif-analyze
```

Creates or updates:
- `.ai-factory/config.yaml`
- `.ai-factory/rules/base.md`

### 2. Explore (optional)

```bash
/aif-explore "add OAuth authentication"
/aif-explore <plan-id>
/aif-explore @.ai-factory/plans/<plan-id>.md
```

Explore behavior:
- reads `.ai-factory/config.yaml` first
- resolves either the companion plan file or the plan folder to one active pair
- writes only `.ai-factory/RESEARCH.md`
- routes new work to `/aif-plan full`

### 3. Create a full plan

```bash
/aif-plan full "add OAuth authentication"
```

Full-mode planning creates both:
- `.ai-factory/plans/<plan-id>.md`
- `.ai-factory/plans/<plan-id>/`

If active research exists, `/aif-plan` normalizes it into plan-local `explore.md`.

### 4. Improve the plan

```bash
/aif-improve
/aif-improve @.ai-factory/plans/<plan-id>/
/aif-improve @.ai-factory/plans/<plan-id>.md
```

Improve behavior:
- resolves the plan file, the plan folder, or any plan-local artifact path
- updates the plan summary plus plan-folder artifacts together
- auto-generates a missing companion plan file for legacy folder-only plans

### 5. Implement

```bash
/aif-implement
/aif-implement @.ai-factory/plans/<plan-id>/status.yaml
```

Implement behavior:
- owns `status.yaml` execution metadata and git-strategy persistence
- supports `--from <n>` resume and optional Claude worker mode
- routes completion to `/aif-verify`

### 6. Verify and finalize

```bash
/aif-verify
/aif-verify --check-only
/aif-verify --strict
```

Verify behavior:
- reads the plan pair and plan-folder artifacts
- records findings in `verify.md` and `status.yaml`
- archives passing plans into `.ai-factory/specs/<plan-id>/` unless `--check-only` is used

### 7. Fix findings

```bash
/aif-fix
/aif-fix B001 I001
/aif-fix --all
```

After fixes, run:

```bash
/aif-verify
```

## Release Smoke Checks

Use this checklist when validating an install or update of the extension:

1. Проверить версию CLI:

```bash
ai-factory --version
```

Ожидается версия внутри `>=2.10.0 <3.0.0`.

2. Установка:

```bash
ai-factory extension add https://github.com/ichinya/aifhub-extension.git
```

Ожидается, что `extension.json` будет публиковать только `skills/aif-analyze`, injected built-in workflow и Codex `agentFiles`.

3. Обновление:

```bash
ai-factory update
ai-factory extension update
```

Ожидается, что built-in skills останутся canonical, injections переустановятся чисто, а поддерживаемые runtime-managed assets останутся синхронизированы с manifest.

4. Удаление:

```bash
ai-factory extension remove aifhub-extension
```

Ожидается, что canonical upstream commands останутся доступными без extension-owned override для `aif-plan`.

5. Сквозной workflow:

```bash
/aif-analyze
/aif-plan full "smoke-check feature"
/aif-improve
/aif-implement
/aif-verify --check-only
```

Ожидаются companion artifacts в `.ai-factory/plans/`, синхронизированный `status.yaml` и документация, которая указывает только на текущий workflow.

## Project Layout

```text
aifhub-extension/
|- extension.json
|- agent-files/
|  `- codex/
|- injections/
|- docs/
|  |- README.md
|  |- codex-agents.md
|  |- usage.md
|  `- context-loading-policy.md
`- skills/
   |- aif-analyze/
   `- shared/
```

## See Also

- [Documentation Index](README.md) - docs overview and reading order
- [Codex Agents](codex-agents.md) - bundled `aifhub-*` agents, explicit invocation, and sandbox contract
- [Context Loading Policy](context-loading-policy.md) - runtime context and ownership contract
- [Project README](../README.md) - quick start and high-level workflow summary
