[← Previous Page](usage.md) · [Back to README](../README.md) · [Next Page →](context-loading-policy.md)

# Codex Agents

Эта страница описывает bundled Codex agents, которые extension публикует через `extension.json -> agentFiles`.

## Что именно ставится

| `name` | Назначение | `sandbox_mode` | Write boundary |
|-------|------------|----------------|----------------|
| `aifhub-plan-polisher` | Bounded worker для полировки одного активного плана и companion artifacts | `workspace-write` | Только active plan pair; без правок source code |
| `aifhub-implement-worker` | Bounded worker для выполнения одной plan task или тесно связанной группы задач | `workspace-write` | Только execution scope выбранной задачи; без commit/push |
| `aifhub-review-sidecar` | Read-only sidecar для review changed scope с findings-first выводом | `read-only` | Не пишет файлы |
| `aifhub-security-sidecar` | Read-only sidecar для security-аудита changed scope | `read-only` | Не пишет файлы |
| `aifhub-verifier` | Low-write verifier для plan pair и changed scope с gate result | `workspace-write` | Только `.ai-factory/plans/<plan-id>/status.yaml` и `verify.md`; без code edits |
| `aifhub-fixer` | Targeted fixer по выбранным verification/review findings | `workspace-write` | Только файлы, нужные для выбранных findings, плюс `status.yaml` и `fixes/*.md` |
| `aifhub-rules-sidecar` | Read-only sidecar для проверки `.ai-factory/RULES.md`, `rules/base.md` и plan-local `rules.md` | `read-only` | Не пишет файлы |
| `aifhub-done-finalizer` | Finalization helper для archive/spec summary после passing verification | `workspace-write` | Только `status.yaml`, `.ai-factory/specs/<plan-id>/` и `.ai-factory/specs/index.yaml` |

`name` является authoritative spawn-name. Filename нужен только как удобная convention в репозитории и в manifest.

## Ролевые семейства

- `read-only sidecar`: `aifhub-review-sidecar`, `aifhub-security-sidecar`, `aifhub-rules-sidecar`. Эти агенты только читают scope и возвращают findings-first output без auto-fix.
- `low-write verifier`: `aifhub-verifier`. Агент может обновлять только verification artifacts, но не implementation files.
- `bounded worker`: `aifhub-plan-polisher`, `aifhub-implement-worker`, `aifhub-fixer`. Они write-capable, но у каждого есть жёстко ограниченный рабочий scope.
- `finalization helper`: `aifhub-done-finalizer`. Он завершает verification-passing plan и готовит summary/archive work, не обходя owner boundaries для `.ai-factory/ROADMAP.md`, `.ai-factory/RULES.md` и `.ai-factory/ARCHITECTURE.md`.

## Как это работает

- Extension устанавливает эти TOML-файлы как runtime-managed assets для Codex.
- Сам факт установки не означает, что Codex начнёт вызывать их автоматически.
- Если нужен subagent, его надо попросить явно: либо прямым пользовательским запросом, либо через orchestrator logic в уже выбранном workflow.
- Поэтому bundled agents расширяют доступный toolbox, но не добавляют "магический" auto-spawn behavior.

## Почему имена namespaced как `aifhub-*`

- Namespace снижает риск collision с user-defined agents и сторонними runtime assets.
- Имена остаются стабильными между manifest, файлами в `agent-files/codex/` и явным spawn-запросом.
- Prefix сразу показывает, что агент относится к extension contract AIFHub, а не к встроенному generic поведению Codex.

## Примеры явного вызова

Используйте те же имена, что записаны в поле `name`:

- Попросить review sidecar: `Используй агент aifhub-review-sidecar и проверь текущий changed scope. Верни findings first.`
- Попросить security sidecar: `Запусти aifhub-security-sidecar для security review изменённых файлов без правок.`
- Попросить rules sidecar: `Используй aifhub-rules-sidecar и проверь текущий scope на соответствие файлам .ai-factory/RULES.md, rules/base.md и plan-local rules.`
- Попросить implement worker: `Запусти aifhub-implement-worker для выполнения одной задачи из активного плана и верни changed files, verification evidence и blockers.`
- Попросить plan polisher: `Используй aifhub-plan-polisher для точечной полировки текущего плана без редактирования source code.`
- Попросить verifier: `Запусти aifhub-verifier для active plan pair и changed files. Обнови только verification artifacts и верни verdict с counts по findings.`
- Попросить fixer: `Используй aifhub-fixer и исправь только findings B001 и I002, затем верни files modified и re-verify recommendation.`
- Попросить done finalizer: `Запусти aifhub-done-finalizer для passing plan, архивируй artifacts в specs и подготовь commit/PR summary draft.`

Во всех случаях полезно явно задавать scope: какой plan, какие файлы или какой changed range должен анализироваться.

## Что важно помнить

- `aifhub-review-sidecar`, `aifhub-security-sidecar` и `aifhub-rules-sidecar` намеренно read-only; они не должны выполнять edits.
- `aifhub-verifier` не должен писать code; даже при `sandbox_mode = "workspace-write"` его write scope ограничен verification artifacts.
- `aifhub-fixer` не должен делать unrelated refactor и не должен переписывать plan artifacts вне `status.yaml` и `fixes/*.md`, если finding не указывает иначе.
- `aifhub-done-finalizer` не должен напрямую редактировать `.ai-factory/ROADMAP.md`, `.ai-factory/RULES.md` и `.ai-factory/ARCHITECTURE.md`; для этих файлов допустим только suggestion-only follow-up.
- `aifhub-plan-polisher` и `aifhub-implement-worker` write-capable, но их write scope всё равно ограничен инструкциями конкретного агента.
- Эта страница не вводит новый runtime behavior; она документирует уже опубликованные `agentFiles`, naming contract и expected sandbox policy.

## See Also

- [Documentation Index](README.md) - docs overview and reading order
- [Usage](usage.md) - canonical workflow and install/update smoke checks
- [Context Loading Policy](context-loading-policy.md) - runtime context and ownership contract
