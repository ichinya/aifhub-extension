[← Previous Page](codex-agents.md) · [Back to README](../README.md) · [Next Page →](context-loading-policy.md)

# Claude Agents

Эта страница описывает bundled Claude agents, которые extension публикует через `extension.json -> agentFiles` с `runtime: "claude"`.

## Что именно ставится

| `name` | Назначение | `tools` | `permissionMode` | Write boundary |
|-------|------------|---------|-------------------|----------------|
| `aifhub-plan-polisher` | Bounded worker для полировки одного активного плана или OpenSpec change artifacts | Read, Write, Edit, Glob, Grep, Bash | `acceptEdits` | Только active OpenSpec change artifacts in OpenSpec-native mode or active plan pair in legacy mode; без правок source code |
| `aifhub-implement-worker` | Bounded worker для выполнения одной plan task или тесно связанной группы задач | Read, Write, Edit, Glob, Grep, Bash | `acceptEdits` | Только execution scope выбранной задачи and OpenSpec runtime state or legacy task metadata; без commit/push |
| `aifhub-review-sidecar` | Read-only sidecar для review changed scope с findings-first выводом | Read, Glob, Grep | `dontAsk` | Не пишет файлы |
| `aifhub-security-sidecar` | Read-only sidecar для security-аудита changed scope | Read, Glob, Grep | `dontAsk` | Не пишет файлы |
| `aifhub-verifier` | Low-write verifier для OpenSpec change or legacy plan pair и changed scope с gate result | Read, Write, Edit, Glob, Grep, Bash | `acceptEdits` | Только `.ai-factory/qa/<change-id>/` in OpenSpec-native mode or `status.yaml`/`verify.md` for validated legacy plan pair |
| `aifhub-fixer` | Targeted fixer по выбранным verification/review findings | Read, Write, Edit, Glob, Grep, Bash | `acceptEdits` | Только validated changed scope выбранных findings plus `.ai-factory/state/<change-id>/` in OpenSpec-native mode or `status.yaml`/`fixes/*.md` |
| `aifhub-rules-sidecar` | Read-only sidecar для проверки generated OpenSpec rules or `.ai-factory/RULES.md`, `.ai-factory/rules/base.md` и plan-local `rules.md` | Read, Glob, Grep | `dontAsk` | Не пишет файлы |
| `aifhub-done-finalizer` | Finalization helper для OpenSpec CLI archive/final summary или legacy archive/spec summary после passing verification | Read, Write, Edit, Glob, Grep, Bash | `acceptEdits` | OpenSpec-native `.ai-factory/qa/<change-id>/` final evidence and `.ai-factory/state/<change-id>/` summary, with archive only through OpenSpec CLI; legacy `status.yaml`, archive dir в `.ai-factory/specs/` и `.ai-factory/specs/index.yaml`; `--force` запрещён |

`name` является authoritative spawn-name. Filename нужен только как удобная convention в репозитории и в manifest.

## Ролевые семейства

- `read-only sidecar`: `aifhub-review-sidecar`, `aifhub-security-sidecar`, `aifhub-rules-sidecar`. Эти агенты только читают scope, возвращают findings-first output без auto-fix, and end with one final machine-readable `aif-gate-result` block. Запускаются в фоне (`background: true`).
- `aifhub-review-sidecar`, `aifhub-security-sidecar`, and `aifhub-rules-sidecar` use gate values `"review"`, `"security"`, and `"rules"` respectively, with lowercase `status` values `pass`, `warn`, or `fail`.
- `aifhub-rules-sidecar` keeps the upstream `rules-sidecar` contract instead of replacing it: it uses `aif-rules-check` and reads `.ai-factory/rules/generated/*` in OpenSpec-native mode.
- `low-write verifier`: `aifhub-verifier`. Агент может обновлять только verification artifacts, но не implementation files.
- `bounded worker`: `aifhub-plan-polisher`, `aifhub-implement-worker`, `aifhub-fixer`. Они write-capable, но у каждого есть жёстко ограниченный рабочий scope.
- `finalization helper`: `aifhub-done-finalizer`. Он завершает verification-passing OpenSpec change through `openspec archive <change-id> --yes` or legacy plan archive work, supports `--skip-specs`, and prepares summary/archive evidence.

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
- Имена `plan-coordinator`, `implement-coordinator`, `review-sidecar`, `security-sidecar`, `rules-sidecar` зарезервированы для bundled agents и не должны использоваться extension agent files без namespace.
- Prefix `aifhub-` сразу показывает, что агент относится к extension contract AIFHub.

## Agent-assisted OpenSpec workflow

Manual commands remain the source of truth. Agents are bounded helpers.

### Planning

- `/aif-plan full <request>`
- optional `aifhub-plan-polisher`
- optional `/aif-improve <change-id>`
- recommended `/aif-mode sync --change <change-id>`

`aifhub-plan-polisher` may edit canonical OpenSpec change artifacts and must validate touched artifacts through the OpenSpec runner when available.

### Implementation

- `aifhub-implement-worker`
- writes implementation traces only under `.ai-factory/state/<change-id>/implementation/`

After implementation, optional read-only gates are `/aif-rules-check`, `/aif-review`, and `/aif-security-checklist`. The authoritative final verification remains `/aif-verify <change-id>`.

### Read-only sidecars

Run after code changes and before or during verification:

- `aifhub-rules-sidecar` -> `gate: "rules"`
- `aifhub-review-sidecar` -> `gate: "review"`
- `aifhub-security-sidecar` -> `gate: "security"`

All sidecars are read-only and end with final `aif-gate-result`.

### Verification and fix loop

- `aifhub-verifier`
- if fail: `aifhub-fixer`
- rerun `aifhub-verifier`

Verifier writes QA evidence under `.ai-factory/qa/<change-id>/`.

### Finalization

- `aifhub-done-finalizer`
- requires passing verify gate
- archives only through OpenSpec CLI
- writes final evidence/summaries
- recommends `/aif-mode sync`
- recommends `/aif-commit`
- does not create commits or PRs automatically

### Optional learning

- `/aif-evolve` after commit/finalization when durable learnings exist.

## Примеры явного вызова

Используйте те же имена, что записаны в поле `name` frontmatter:

- Попросить review sidecar: `Используй агент aifhub-review-sidecar и проверь текущий changed scope. Верни findings first.`
- Попросить security sidecar: `Запусти aifhub-security-sidecar для security review изменённых файлов без правок.`
- Попросить rules sidecar: `Используй aifhub-rules-sidecar и проверь текущий scope на соответствие generated OpenSpec rules или файлам .ai-factory/RULES.md, .ai-factory/rules/base.md и plan-local rules.`
- Попросить implement worker: `Запусти aifhub-implement-worker для выполнения одной задачи из активного OpenSpec change или legacy плана и верни changed files, verification evidence и blockers.`
- Попросить plan polisher: `Используй aifhub-plan-polisher для точечной полировки текущего OpenSpec change или legacy плана без редактирования source code.`
- Попросить verifier: `Запусти aifhub-verifier для active OpenSpec change or legacy plan pair и changed files. Обнови только verification artifacts и верни verdict с counts по findings.`
- Попросить fixer: `Используй aifhub-fixer и исправь только findings B001 и I002, затем верни files modified и re-verify recommendation.`
- Попросить done finalizer: `Запусти aifhub-done-finalizer для passing OpenSpec change или legacy plan. Для OpenSpec-native scope проверь /aif-verify evidence, archive through openspec archive <change-id> --yes, use --skip-specs for docs/tooling-only work, and report .ai-factory/qa/<change-id>/ plus .ai-factory/state/<change-id>/ outputs. Для legacy scope используй `.ai-factory/specs/<plan-id>/` archive path. Подготовь commit/PR summary draft.`

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
- `aifhub-verifier` не должен писать code; его write scope ограничен QA/verification artifacts.
- `aifhub-fixer` не должен делать unrelated refactor и не должен переписывать canonical OpenSpec artifacts or legacy plan artifacts вне выбранного finding scope.
- `aifhub-done-finalizer` не должен custom-mutating `openspec/specs`, manually moving OpenSpec change folders, archiving unverified changes, or using legacy `.ai-factory/specs` archive in OpenSpec-native mode; он также не должен напрямую обходить owner boundaries для `.ai-factory/ROADMAP.md`, `.ai-factory/RULES.md` и `.ai-factory/ARCHITECTURE.md`.
- Эта страница не вводит новый runtime behavior; она документирует опубликованные `agentFiles` и naming contract.

## See Also

- [Codex Agents](codex-agents.md) — Codex runtime аналоги этих agents
- [Documentation Index](README.md) — docs overview and reading order
- [Usage](usage.md) — canonical workflow and install/update smoke checks
- [Context Loading Policy](context-loading-policy.md) — runtime context and ownership contract
