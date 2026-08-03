# context-mode

Репозиторий: [mksglu/context-mode](https://github.com/mksglu/context-mode)

Исторически проверенный runtime package: `context-mode 1.0.151`.

Архивированный этап issue `#134` проверил Codex surface статически на exact release `v1.0.169`, commit `589d8214d56740a28b5f7bf63167743d586b0b40`, npm shasum `d5aa9acc648ed420c5dd32ee5f15aa5608f09fea`. Последующий test-only live follow-up от `2026-08-03` исполнил изолированные MCP/plugin probes по отдельной authorization envelope; это не runtime promotion и не разрешение normal AIFHub commands.

Результаты тестов и выводы по labels: [context-mode-benchmark-results.md](context-mode-benchmark-results.md).

## Что Это

`context-mode` - temporary context-window optimization и retrieval tool. Он может индексировать explicit content, искать по нему и purge knowledge base.

Для AIFHub это не persistent memory provider. Его полезная роль - временно сжать и переиспользовать большой generated output, например summary нескольких команд.

Полезен для:

- `large_command_output_compression`;
- temporary one-session retrieval;
- поиска по explicit indexed generated output.

Не подходит для:

- source-code indexing;
- persistent project memory;
- small project lookup;
- protected validation artifacts;
- implementation/verify gates.

## Политика AIFHub

`context-mode` остается `manual_helper_only`.

Рекомендовать только если анализ упирается в большой generated output. Project labels важны косвенно: на large/legacy/multirepo проектах output может быть больше, но сам tool полезен только при task signal.

Не рекомендовать для `small_microservice`, exact lookup и любых задач, где `rg` напрямую дает нужные файлы.

`rg` остаётся baseline. Установка и любое доверие hooks требуют явного user opt-in; normal `/aif-plan`, `/aif-implement`, `/aif-verify` и `/aif-done` не выбирают provider.

## Архивированный Codex Surface v1.0.169

Выводы разделены:

- MCP-only: historical `1.0.151` evidence сохраняет manual helper для уже созданного generated output. Текущий `v1.0.169` runtime получил `BLOCKED(runtime_dependency_self_install)`: `hooks/ensure-deps.mjs` может самостоятельно запускать `npm install` и shell.
- Codex plugin/hooks: `NOT_RUN(auth_isolation_unavailable)`. Изолированный `CODEX_HOME` не дал безопасного model run, а реальные `auth.json`, API keys и долгоживущие credentials не копировались.
- Direct hook entrypoints также не запускались после static veto. Unit-level `direct_hook_contract` проверяет adapter contract, но не считается actual Codex delivery.
- `plugin_snapshot_isolated` подтверждает только package/manifests snapshot. Install lifecycle остаётся `NOT_RUN(postinstall_forbidden)`.

Dedicated matrix содержит 18 строк: три synthetic scenarios, baseline/MCP-only/plugin, две repetitions, `codex`, `gpt-5.6-luna`, `reasoning: low`. Все 18 прошли реальный `ai-tester --dry-run`; model rows не исполнялись после lifecycle/auth gates. Это `NOT_RUN`, а не отрицательное сравнение качества или tokens.

AIFHub не auto-install, не register MCP, не доверяет hooks и не выбирает Codex plugin в normal commands. Generic historical routes возвращают `dedicated_harness_required`.

## Authorized Live Follow-up 2026-08-03

Follow-up использовал authorization class `explicit_isolated_full`: test-only scope, disposable runtime/provider homes, scoped ephemeral auth copy и native Codex executable. Host auth/manifests остались неизменными, временные auth copies удалены. Package `postinstall` по-прежнему не запускался: install lifecycle остаётся `NOT_RUN(postinstall_forbidden)`.

Проверенные версии: `context-mode 1.0.169`, Codex `0.144.6`, `ai-tester 1.1.0`, model `gpt-5.6-luna`, reasoning `low`. Санитизированный evidence: [live-authorized-evidence.json](../../.ai-factory/state/persist-context-mode-live-evaluation-issue-134/evaluation/live-authorized-evidence.json).

| Scenario | Baseline | MCP-only | Codex plugin | Вывод |
|---|---|---|---|---|
| small fixture | PASS, 89,809 tokens | PASS, 428,221 tokens (`+376.8%`) | excluded by privacy boundary | MCP корректен, но намного дороже и медленнее baseline. |
| >1 MiB stdout | FAIL: required tail facts truncated | PASS, 70,579 tokens | FAIL: nested shell output не intercepted | MCP восстановил correctness, но использовал `+120.2%` tokens против уже failed baseline; token savings нет. |
| session continuity | n/a | first turn PASS | resume FAIL | `NOT_RUN(resume_driver_parity_unavailable)`; continuity не доказана. |

Raw Codex rollout audit подтвердил реальные nested MCP calls и sandbox-confined paths. Для large fixture MCP вызвал `ctx_batch_execute` и `ctx_purge`; plugin вызвал `ctx_search`, но его knowledge base осталась пустой, поэтому факты не были восстановлены. Outer `ai-tester` trace используется для correctness/cost, raw rollout — только для provider call/path proof.

Текущий bounded decision:

- MCP-only можно предложить только для explicit user-owned temporary indexing большого output, когда direct output реально обрезается и correctness важнее token cost; обязательны isolated scope и purge;
- Codex plugin следует избегать для проверенного nested `functions.exec`/shell stack: hooks не перехватили output;
- общей экономии billed model tokens не обнаружено;
- `rg` и direct shell остаются baseline;
- normal AIFHub commands по-прежнему не auto-install package, не register MCP и не доверяют hooks.

## CLI И MCP

Исторически проверенный на `1.0.151` flow:

```text
context-mode doctor
ctx_index <explicit-generated-text>
ctx_search <query>
ctx_purge scope=project
```

MCP exposes широкий surface: `ctx_execute`, `ctx_index`, `ctx_search`, `ctx_fetch_and_index`, `ctx_batch_execute`, `ctx_stats`, `ctx_doctor`, `ctx_upgrade`, `ctx_purge`, `ctx_insight`.

Из AIFHub не использовать command execution tools как default provider. Индексировать только explicit generated content, не source tree.

## Границы И Privacy

Все, что explicit indexed, становится retrievable. Поэтому нельзя индексировать raw secrets, private snippets, local paths или protected validation artifacts.

Не устанавливать hooks и не register MCP automatically.

Test-only live probe не превращает normal lifecycle в PASS: self-install bootstrap и package `postinstall` остаются запрещены за пределами отдельной authorization envelope.

## Очистка

Использовать `ctx_purge`:

- `scope: "session"` с session id;
- `scope: "project"` для whole project knowledge base.

## Мета Для Анализа

```yaml
tool_id: context-mode
decision: manual_helper_only
recommendation_action: suggest_only_for_large_temporary_outputs
role: temporary_output_index
install_policy: explicit_user_opt_in_only
read_scope: explicit_indexed_content
purge_path: ctx_purge_session_or_project
recommend_when:
  tasks:
    - large_command_output_compression
    - temporary_one_session_retrieval
do_not_recommend_when:
  project_shapes:
    - small_microservice
  tasks:
    - persistent_project_memory
    - source_code_indexing
analysis_hint: "Предлагать только для большого generated output; не использовать как source-code memory."
```
