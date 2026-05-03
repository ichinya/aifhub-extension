[← Previous Page](usage.md) · [Back to README](../README.md) · [Next Page →](context-loading-policy.md)

# Codex Agents

Эта страница описывает bundled Codex agents, которые extension публикует через `extension.json -> agentFiles`.

## Что именно ставится

| `name` | Назначение | `sandbox_mode` | Write boundary |
|-------|------------|----------------|----------------|
| `aifhub-plan-polisher` | Bounded worker для полировки одного активного плана или OpenSpec change artifacts | `workspace-write` | Только active OpenSpec change artifacts in OpenSpec-native mode or active plan pair in legacy mode; без правок source code |
| `aifhub-implement-worker` | Bounded worker для выполнения одной plan task или тесно связанной группы задач; mirrors OpenSpec `tasks.md` into runtime todo state when available | `workspace-write` | Только execution scope выбранной задачи and OpenSpec runtime state or legacy task metadata; без commit/push |
| `aifhub-review-sidecar` | Read-only sidecar для review changed scope с findings-first выводом | `read-only` | Не пишет файлы |
| `aifhub-security-sidecar` | Read-only sidecar для security-аудита changed scope | `read-only` | Не пишет файлы |
| `aifhub-verifier` | Low-write verifier для OpenSpec change or legacy plan pair и changed scope с gate result | `workspace-write` | Только `.ai-factory/qa/<change-id>/` in OpenSpec-native mode or `status.yaml`/`verify.md` for validated legacy plan pair |
| `aifhub-fixer` | Targeted fixer по выбранным verification/review findings | `workspace-write` | Только validated changed scope выбранных findings plus `.ai-factory/state/<change-id>/` in OpenSpec-native mode or `status.yaml`/`fixes/*.md` for legacy plan pair; allowlist может только сузить уже подтверждённый scope |
| `aifhub-rules-sidecar` | Read-only sidecar для проверки generated OpenSpec rules or `.ai-factory/RULES.md`, `.ai-factory/rules/base.md` и plan-local `rules.md` | `read-only` | Не пишет файлы |
| `aifhub-done-finalizer` | Finalization helper для OpenSpec CLI archive/final summary или legacy archive/spec summary после passing verification | `workspace-write` | OpenSpec-native `.ai-factory/qa/<change-id>/` final evidence and `.ai-factory/state/<change-id>/` summary, with archive only through OpenSpec CLI; legacy `status.yaml`, archive dir в `.ai-factory/specs/` и `.ai-factory/specs/index.yaml`; `--force` запрещён |

`name` является authoritative spawn-name. Filename нужен только как удобная convention в репозитории и в manifest.

## Ролевые семейства

- `read-only sidecar`: `aifhub-review-sidecar`, `aifhub-security-sidecar`, `aifhub-rules-sidecar`. Эти агенты только читают scope, возвращают findings-first output без auto-fix, and end with one final machine-readable `aif-gate-result` block.
- `aifhub-review-sidecar`, `aifhub-security-sidecar`, and `aifhub-rules-sidecar` use gate values `"review"`, `"security"`, and `"rules"` respectively, with lowercase `status` values `pass`, `warn`, or `fail`.
- `aifhub-rules-sidecar` keeps the upstream `rules-sidecar` contract instead of replacing it: it is namespaced for AIFHub and reads `.ai-factory/rules/generated/*` in OpenSpec-native mode.
- `low-write verifier`: `aifhub-verifier`. Агент может обновлять только verification artifacts, но не implementation files.
- `bounded worker`: `aifhub-plan-polisher`, `aifhub-implement-worker`, `aifhub-fixer`. Они write-capable, но у каждого есть жёстко ограниченный рабочий scope.
- `finalization helper`: `aifhub-done-finalizer`. Он завершает verification-passing OpenSpec change through `openspec archive <change-id> --yes` or legacy plan archive work, supports `--skip-specs`, prepares summary/archive evidence, and does not bypass owner boundaries для `.ai-factory/ROADMAP.md`, `.ai-factory/RULES.md` и `.ai-factory/ARCHITECTURE.md`.

## Как это работает

- Extension устанавливает эти TOML-файлы как runtime-managed assets для Codex.
- Сам факт установки не означает, что Codex начнёт вызывать их автоматически.
- Если нужен subagent, его надо попросить явно: либо прямым пользовательским запросом, либо через orchestrator logic в уже выбранном workflow.
- Поэтому bundled agents расширяют доступный toolbox, но не добавляют "магический" auto-spawn behavior.

## Почему имена namespaced как `aifhub-*`

- Namespace снижает риск collision с user-defined agents и сторонними runtime assets.
- Имена остаются стабильными между manifest, файлами в `agent-files/codex/` и явным spawn-запросом.
- Prefix сразу показывает, что агент относится к extension contract AIFHub, а не к встроенному generic поведению Codex.

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
- reads canonical `tasks.md` and hydrates runtime todo state with `update_plan` when available
- reports a task snapshot as a capability fallback when direct todo access is unavailable
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

Используйте те же имена, что записаны в поле `name`:

- Попросить review sidecar: `Используй агент aifhub-review-sidecar и проверь текущий changed scope. Верни findings first.`
- Попросить security sidecar: `Запусти aifhub-security-sidecar для security review изменённых файлов без правок.`
- Попросить rules sidecar: `Используй aifhub-rules-sidecar и проверь текущий scope на соответствие generated OpenSpec rules или файлам .ai-factory/RULES.md, .ai-factory/rules/base.md и plan-local rules.`
- Попросить implement worker: `Запусти aifhub-implement-worker для выполнения одной задачи из активного OpenSpec change или legacy плана и верни changed files, verification evidence и blockers.`
- Попросить plan polisher: `Используй aifhub-plan-polisher для точечной полировки текущего OpenSpec change или legacy плана без редактирования source code.`
- Попросить verifier: `Запусти aifhub-verifier для active OpenSpec change or legacy plan pair и changed files. Обнови только verification artifacts и верни verdict с counts по findings.`
- Попросить fixer: `Используй aifhub-fixer и исправь только findings B001 и I002, затем верни files modified и re-verify recommendation.`
- Попросить done finalizer: `Запусти aifhub-done-finalizer для passing OpenSpec change или legacy plan. Для OpenSpec-native scope проверь /aif-verify evidence, archive through openspec archive <change-id> --yes, use --skip-specs for docs/tooling-only work, and report .ai-factory/qa/<change-id>/ plus .ai-factory/state/<change-id>/ outputs. Для legacy scope используй `.ai-factory/specs/<plan-id>/` archive path. Подготовь commit/PR summary draft.`

Во всех случаях полезно явно задавать scope: какой plan, какие файлы или какой changed range должен анализироваться.

## Что важно помнить

- `aifhub-review-sidecar`, `aifhub-security-sidecar` и `aifhub-rules-sidecar` намеренно read-only; они не должны выполнять edits.
- `aifhub-verifier` не должен писать code; даже при `sandbox_mode = "workspace-write"` его write scope ограничен QA/verification artifacts.
- `aifhub-fixer` не должен делать unrelated refactor и не должен переписывать canonical OpenSpec artifacts or legacy plan artifacts вне выбранного finding scope.
- `aifhub-done-finalizer` не должен custom-mutating `openspec/specs`, manually moving OpenSpec change folders, archiving unverified changes, or using legacy `.ai-factory/specs` archive in OpenSpec-native mode; он также не должен напрямую обходить owner boundaries для `.ai-factory/ROADMAP.md`, `.ai-factory/RULES.md` и `.ai-factory/ARCHITECTURE.md`.
- `aifhub-plan-polisher` и `aifhub-implement-worker` write-capable, но их write scope всё равно ограничен инструкциями конкретного агента.
- Эта страница не вводит новый runtime behavior; она документирует уже опубликованные `agentFiles`, naming contract и expected sandbox policy.

## See Also

- [Documentation Index](README.md) - docs overview and reading order
- [Usage](usage.md) - canonical workflow and install/update smoke checks
- [Context Loading Policy](context-loading-policy.md) - runtime context and ownership contract
