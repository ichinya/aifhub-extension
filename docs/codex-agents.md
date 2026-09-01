[← Previous Page](usage.md) · [Back to README](../README.md) · [Next Page →](context-loading-policy.md)

# Codex Agents

## Codex Runtime Matrix

| Runtime | Skills path | Agent files | MCP/config path | AI Factory invocation |
|---|---|---|---|---|
| Codex CLI (`codex`) | `.codex/skills` | `.codex/agents` installed from extension `agentFiles` entries with `runtime: "codex"` | `.codex/config.toml` | `$aif-*` |
| Codex app (`codex-app`) | `.agents/skills` | no extension `agentFiles` target yet | `.codex/config.toml` | `$aif-*` |

The extension `agentFiles` cannot target `codex-app` yet. Codex app receives skills under `.agents/skills` and MCP config through `.codex/config.toml`; it does not receive AIFHub Codex CLI agent TOML files through the extension manifest.

The `aifhub-*` Codex agents are extension helpers for bounded planning, implementation, review, verification, fixes, and finalization. They are not replacements for upstream bundled Codex CLI agents such as `plan-coordinator`, `implement-coordinator`, and `review-sidecar`.

Эта страница описывает bundled Codex agents, которые extension публикует через `extension.json -> agentFiles`.

## Что именно ставится

| `name` | Назначение | `sandbox_mode` | Write boundary |
|-------|------------|----------------|----------------|
| `aifhub-plan-polisher` | Bounded worker для полировки одного активного плана или OpenSpec change artifacts | `workspace-write` | OpenSpec canonical files or classic legacy pair only; marked ultra is read-only routing to exact `/aif-improve <entrypoint>` |
| `aifhub-implement-worker` | Bounded worker для выполнения одной plan task или тесно связанной группы задач; mirrors OpenSpec `tasks.md` into runtime todo state when available | `workspace-write` | Selected OpenSpec/classic execution scope only; marked ultra routes to exact `/aif-implement <entrypoint>`; без commit/push |
| `aifhub-review-sidecar` | Read-only sidecar для review changed scope с findings-first выводом | `read-only` | Не пишет файлы |
| `aifhub-security-sidecar` | Read-only sidecar для security-аудита changed scope | `read-only` | Не пишет файлы |
| `aifhub-verifier` | Low-write verifier для OpenSpec change or legacy plan pair и changed scope с gate result | `workspace-write` | OpenSpec QA or classic `status.yaml`/`verify.md`; marked ultra delegates exact `/aif-verify <entrypoint>`, and only the command boundary may write its receipt |
| `aifhub-fixer` | Targeted fixer по выбранным verification/review findings | `workspace-write` | Selected OpenSpec/classic finding scope; marked ultra routes to exact `/aif-fix <entrypoint>`; allowlist only narrows scope |
| `aifhub-rules-sidecar` | Read-only sidecar для проверки generated OpenSpec rules or legacy rules/receipt state | `read-only` | Не пишет файлы; marked ultra returns exact verify/archive handoff from current receipt evaluation |
| `aifhub-done-finalizer` | Finalization helper для OpenSpec CLI archive/final summary или classic legacy archive/spec summary | `workspace-write` | OpenSpec final evidence/managed roadmap row or classic legacy finalization; marked ultra is read-only receipt evaluation and writes nothing; `--force` запрещён |

`name` является authoritative spawn-name. Filename нужен только как удобная convention в репозитории и в manifest.

## Ролевые семейства

- `read-only sidecar`: `aifhub-review-sidecar`, `aifhub-security-sidecar`, `aifhub-rules-sidecar`. Эти агенты только читают scope, возвращают findings-first output без auto-fix, and end with one final machine-readable `aif-gate-result` block.
- `aifhub-review-sidecar`, `aifhub-security-sidecar`, and `aifhub-rules-sidecar` use gate values `"review"`, `"security"`, and `"rules"` respectively, with lowercase `status` values `pass`, `warn`, or `fail`.
- `aifhub-rules-sidecar` keeps the upstream `rules-sidecar` contract instead of replacing it: it is namespaced for AIFHub and reads generated markdown plus trace metadata under `.ai-factory/rules/generated/*` in OpenSpec-native mode.
- `low-write verifier`: `aifhub-verifier`. Агент может обновлять только verification artifacts, но не implementation files.
- `bounded worker`: `aifhub-plan-polisher`, `aifhub-implement-worker`, `aifhub-fixer`. Они write-capable, но у каждого есть жёстко ограниченный рабочий scope.
- `aifhub-implement-worker` records a bounded RED -> GREEN -> REFACTOR cycle for testable behavior changes, or an explicit no-test fallback, under runtime state only.
- `aifhub-fixer` records direct root-cause evidence, one falsifiable hypothesis and a minimal experiment before its regression-first edit.
- `aifhub-review-sidecar` runs plan/spec compliance before code quality and returns one combined read-only gate.
- `finalization helper`: `aifhub-done-finalizer`. Для OpenSpec-native installed project он запускает `ai-factory aifhub-done-finalizer --change <change-id> --json`; extension-local implementation выполняет readiness и `openspec archive <change-id> --yes`. Поддерживаются `--skip-specs` и `--record-dirty-state`. Агент co-owns только одну linked row внутри marker-bounded lifecycle block; arbitrary `.ai-factory/ROADMAP.md` content и owner boundaries для `.ai-factory/RULES.md` и `.ai-factory/ARCHITECTURE.md` не обходятся.

## Как это работает

- Extension устанавливает эти TOML-файлы как runtime-managed assets для Codex.
- Сам факт установки не означает, что Codex начнёт вызывать их автоматически.
- Если нужен subagent, его надо попросить явно: либо прямым пользовательским запросом, либо через orchestrator logic в уже выбранном workflow.
- Поэтому bundled agents расширяют доступный toolbox, но не добавляют "магический" auto-spawn behavior.

## AI Factory 2.18 Exact Handoff Matrix

Marker classification runs before classic companion discovery. For a valid legacy `<!-- aif:plan-mode:ultra -->` bundle, agents must return these exact upstream commands and must not edit `index.md`, phase files, or classic companions:

| Agent | Exact handoff |
|---|---|
| `aifhub-plan-polisher` | `/aif-improve <entrypoint>` |
| `aifhub-implement-worker` | `/aif-implement <entrypoint>` |
| `aifhub-verifier` | `/aif-verify <entrypoint>`; after the one final upstream gate, the command boundary may write the revision-bound receipt |
| `aifhub-fixer` | `/aif-fix <entrypoint>` |
| `aifhub-rules-sidecar` | `/aif-archive <entrypoint>` only for current exact `pass`; otherwise `/aif-verify <entrypoint>` |
| `aifhub-done-finalizer` | `/aif-archive <entrypoint>` only for current exact `pass`; otherwise `/aif-verify <entrypoint>` |

The receipt lives at `.ai-factory/state/legacy-ultra-verification/<entrypoint-digest>.json` and binds the bundle, exact entrypoint, source revision, deterministic worktree, and gate outcome. Rules/done agents are read-only evaluators: they never create or repair it and never execute the returned handoff. OpenSpec-native explicit `ultra` remains the same canonical change with deeper `design.md`/`tasks.md`; this matrix applies only to legacy marked bundles.

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

Run after code changes and before verification starts:

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
- installed command: `ai-factory aifhub-done-finalizer --change <change-id> --json`
- requires passing verify gate
- archives only through OpenSpec CLI
- returns bounded output and exit `0` for success/accepted warning, `1` for a resolved blocker, or `2` for invalid/unresolved/unexpected command failure
- rejects unknown options and `--force`, `--no-validate`, `--skip-archive`, `--dry-run`, and `--summary-only`
- never runs extension-local `scripts/openspec-*.mjs` modules through a consumer-root or installed-internal path
- writes final evidence/summaries
- reads canonical `## Roadmap Linkage` before archive
- after successful OpenSpec archive, updates only the linked row in the marker-bounded `OpenSpec Change Lifecycle` block to `finalized`
- a pre-archive failure leaves the roadmap unchanged
- a post-archive roadmap update failure preserves truthful archive evidence, does not roll back archive, and returns `/aif-roadmap check`
- GitHub open/closed/merged state remains separate and is reconciled later by `/aif-roadmap check`
- recommends `/aif-mode sync`
- recommends `/aif-commit`
- does not create commits or PRs automatically
- for marked legacy ultra, writes no final evidence or archive state and returns only the current receipt-derived `/aif-verify <entrypoint>` or `/aif-archive <entrypoint>` handoff

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
- Попросить done finalizer: `Запусти ai-factory aifhub-done-finalizer --change <change-id> --json для passing OpenSpec change. Используй --skip-specs только для docs/tooling-only work, верни bounded status, safe paths, OpenSpec command/source и suggested next; не запускай scripts/openspec-*.mjs из consumer root или installed-internal path. Для legacy scope следуй agent contract. Подготовь commit/PR summary draft.`

Во всех случаях полезно явно задавать scope: какой plan, какие файлы или какой changed range должен анализироваться.

## Что важно помнить

- `aifhub-review-sidecar`, `aifhub-security-sidecar` и `aifhub-rules-sidecar` намеренно read-only; они не должны выполнять edits.
- `aifhub-verifier` не должен писать code; даже при `sandbox_mode = "workspace-write"` его write scope ограничен QA/verification artifacts.
- `aifhub-fixer` не должен делать unrelated refactor и не должен переписывать canonical OpenSpec artifacts or legacy plan artifacts вне выбранного finding scope.
- `aifhub-done-finalizer` не должен custom-mutating `openspec/specs`, manually moving OpenSpec change folders, archiving unverified changes, or using legacy `.ai-factory/specs` archive in OpenSpec-native mode; в roadmap он может менять только одну linked row внутри managed markers после archive и не должен обходить ownership остального `.ai-factory/ROADMAP.md`, `.ai-factory/RULES.md` или `.ai-factory/ARCHITECTURE.md`.
- `aifhub-plan-polisher` и `aifhub-implement-worker` write-capable, но их write scope всё равно ограничен инструкциями конкретного агента.
- Эта страница не вводит новый runtime behavior; она документирует уже опубликованные `agentFiles`, naming contract и expected sandbox policy.

## See Also

- [Documentation Index](README.md) - docs overview and reading order
- [Usage](usage.md) - canonical workflow and install/update smoke checks
- [Context Loading Policy](context-loading-policy.md) - runtime context and ownership contract
