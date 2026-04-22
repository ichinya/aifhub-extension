[← Previous Page](codex-agents.md) · [Back to README](../README.md) · [Next Page →](context-loading-policy.md)

# Claude Agents

Эта страница описывает bundled Claude agents, которые extension публикует через `extension.json -> agentFiles` с `runtime: "claude"`.

## Что именно ставится

| `name` | Назначение | `tools` | `permissionMode` | Write boundary |
|-------|------------|---------|-------------------|----------------|
| `aifhub-plan-polisher` | Bounded worker для полировки одного активного плана и companion artifacts | Read, Write, Edit, Glob, Grep, Bash | `acceptEdits` | Только active plan pair; без правок source code |
| `aifhub-implement-worker` | Bounded worker для выполнения одной plan task или тесно связанной группы задач | Read, Write, Edit, Glob, Grep, Bash | `acceptEdits` | Только execution scope выбранной задачи; без commit/push |
| `aifhub-review-sidecar` | Read-only sidecar для review changed scope с findings-first выводом | Read, Glob, Grep | `dontAsk` | Не пишет файлы |
| `aifhub-security-sidecar` | Read-only sidecar для security-аудита changed scope | Read, Glob, Grep | `dontAsk` | Не пишет файлы |
| `aifhub-verifier` | Low-write verifier для plan pair и changed scope с gate result | Read, Write, Edit, Glob, Grep, Bash | `acceptEdits` | Только `status.yaml` и `verify.md` для validated active plan pair |
| `aifhub-fixer` | Targeted fixer по выбранным verification/review findings | Read, Write, Edit, Glob, Grep, Bash | `acceptEdits` | Только validated changed scope выбранных findings плюс `status.yaml` и `fixes/*.md` |
| `aifhub-rules-sidecar` | Read-only sidecar для проверки `.ai-factory/RULES.md`, `.ai-factory/rules/base.md` и plan-local `rules.md` | Read, Glob, Grep | `dontAsk` | Не пишет файлы |
| `aifhub-done-finalizer` | Finalization helper для archive/spec summary после passing verification | Read, Write, Edit, Glob, Grep, Bash | `acceptEdits` | Только `status.yaml` verified plan, его archive dir в `.ai-factory/specs/` и `.ai-factory/specs/index.yaml`; `--force` запрещён |

`name` является authoritative spawn-name. Filename нужен только как удобная convention в репозитории и в manifest.

## Ролевые семейства

- `read-only sidecar`: `aifhub-review-sidecar`, `aifhub-security-sidecar`, `aifhub-rules-sidecar`. Эти агенты только читают scope и возвращают findings-first output без auto-fix. Запускаются в фоне (`background: true`).
- `low-write verifier`: `aifhub-verifier`. Агент может обновлять только verification artifacts, но не implementation files.
- `bounded worker`: `aifhub-plan-polisher`, `aifhub-implement-worker`, `aifhub-fixer`. Они write-capable, но у каждого есть жёстко ограниченный рабочий scope.
- `finalization helper`: `aifhub-done-finalizer`. Он завершает verification-passing plan и готовит summary/archive work.

## Как это работает

- Extension устанавливает эти markdown-файлы как runtime-managed assets для Claude Code.
- Claude Code размещает их в `.claude/agents/` при установке extension.
- Сам факт установки не означает, что Claude Code начнёт вызывать их автоматически.
- Если нужен subagent, его надо попросить явно: либо прямым пользовательским запросом, либо через orchestrator logic.
- Bundled agents расширяют доступный toolbox, но не добавляют "магический" auto-spawn behavior.

## Handoff integration

> **Важно:** `aif-handoff` пока не использует эти agents автоматически. Для автоматического stage-agent mapping нужна configurable mapping на стороне `aif-handoff`. Сейчас agents доступны для ручного использования в Claude Code или через будущий mapping.

## Почему имена namespaced как `aifhub-*`

- Namespace предотвращает collision с bundled Claude agents из parent `ai-factory` (такие как `plan-coordinator`, `implement-coordinator`, `review-sidecar`, `security-sidecar`).
- Имена `plan-coordinator`, `implement-coordinator`, `review-sidecar`, `security-sidecar` зарезервированы для bundled agents и не должны использоваться extension agent files без namespace.
- Prefix `aifhub-` сразу показывает, что агент относится к extension contract AIFHub.

## Примеры явного вызова

Используйте те же имена, что записаны в поле `name` frontmatter:

- Попросить review sidecar: `Используй агент aifhub-review-sidecar и проверь текущий changed scope. Верни findings first.`
- Попросить security sidecar: `Запусти aifhub-security-sidecar для security review изменённых файлов без правок.`
- Попросить rules sidecar: `Используй aifhub-rules-sidecar и проверь текущий scope на соответствие файлам .ai-factory/RULES.md, .ai-factory/rules/base.md и plan-local rules.`
- Попросить implement worker: `Запусти aifhub-implement-worker для выполнения одной задачи из активного плана и верни changed files, verification evidence и blockers.`
- Попросить plan polisher: `Используй aifhub-plan-polisher для точечной полировки текущего плана без редактирования source code.`
- Попросить verifier: `Запусти aifhub-verifier для active plan pair и changed files. Обнови только verification artifacts и верни verdict с counts по findings.`
- Попросить fixer: `Используй aifhub-fixer и исправь только findings B001 и I002, затем верни files modified и re-verify recommendation.`
- Попросить done finalizer: `Запусти aifhub-done-finalizer для passing plan, архивируй artifacts в specs и подготовь commit/PR summary draft.`

Во всех случаях полезно явно задавать scope: какой plan, какие файлы или какой changed range должен анализироваться.

## Связь с Codex agents

Каждый Claude agent имеет Codex-аналог с тем же `name` и семантически эквивалентным prompt. Различия:

| Аспект | Codex agent | Claude agent |
|--------|-------------|--------------|
| Формат | TOML | Markdown с YAML frontmatter |
| `sandbox_mode` | `workspace-write` / `read-only` | `permissionMode: acceptEdits` / `dontAsk` |
| Background | Не поддерживается | `background: true` для sidecar'ов |
| Tools | N/A (Codex runtime) | Явный `tools` список в frontmatter |
| Skills | N/A | N/A (skills подключаются отдельно) |

## Что важно помнить

- `aifhub-review-sidecar`, `aifhub-security-sidecar` и `aifhub-rules-sidecar` намеренно read-only; они не должны выполнять edits.
- `aifhub-verifier` не должен писать code; его write scope ограничен verification artifacts.
- `aifhub-fixer` не должен делать unrelated refactor и не должен переписывать plan artifacts вне `status.yaml` и `fixes/*.md`.
- `aifhub-done-finalizer` не должен напрямую редактировать `.ai-factory/ROADMAP.md`, `.ai-factory/RULES.md` и `.ai-factory/ARCHITECTURE.md`; для этих файлов допустим только suggestion-only follow-up.
- Эта страница не вводит новый runtime behavior; она документирует опубликованные `agentFiles` и naming contract.

## See Also

- [Codex Agents](codex-agents.md) — Codex runtime аналоги этих agents
- [Documentation Index](README.md) — docs overview and reading order
- [Usage](usage.md) — canonical workflow and install/update smoke checks
- [Context Loading Policy](context-loading-policy.md) — runtime context and ownership contract
