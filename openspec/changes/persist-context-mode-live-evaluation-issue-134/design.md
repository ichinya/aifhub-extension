# Design: Bounded live evidence для context-mode Codex

## Context

Первичный change разделил static audit, direct MCP/hooks contracts и actual Codex plugin evidence. После archive пользователь отдельно разрешил isolated dependency/auth lifecycle и live-run показал:

- actual marketplace/plugin lifecycle и purge могут пройти в disposable environment;
- MCP-only помогает correctness при stdout truncation, но увеличивает billed model tokens;
- actual plugin не перехватывает текущий nested `functions.exec` shell path и проигрывает baseline по tokens/duration;
- `ai-tester` верхнего уровня не отражает nested Codex MCP calls, а resume не сохраняет execution parity.

Нужно сохранить эти результаты без превращения одноразового разрешения в default behavior.

## Goals / Non-Goals

Goals:

- сделать explicit live authorization воспроизводимым и fail-closed;
- исправить известные false negatives/invalid fixtures;
- связать correctness/cost trace с отдельным raw provider-tool audit;
- сохранить только sanitized aggregate;
- вывести точную policy: MCP conditional for large truncating output, plugin avoid for current nested shell path, continuity not proven.

Non-goals:

- auto-install provider, trust hooks или copy auth;
- хранить raw run data;
- чинить upstream `ai-tester` resume implementation в другом repository;
- рекомендовать provider для обычных source lookups или small output.

## Decisions

### 1. Authorization is data, not a global switch

Matrix builder принимает optional authorization envelope:

```json
{
  "scope": "isolated_evaluation",
  "provider_snapshot": "prepared_pinned_snapshot",
  "runtime_dependency_bootstrap": "approved",
  "auth_mode": "scoped_ephemeral",
  "native_codex": true
}
```

Envelope не содержит user identity, paths или credentials. Отсутствующий/неполный envelope сохраняет прежние gates. MCP-only получает `PASS(explicit_isolated_authorization)` только при approved pinned runtime; plugin дополнительно требует scoped auth и native Codex. Static identity, sandbox, purge и host-manifest checks остаются обязательными.

### 2. Native executable is resolved before lifecycle

`buildActualPluginPlan` не запускает Windows `.cmd`/`.bat` через `shell: false`. Caller обязан передать absolute native executable (`.exe` на Windows). Reasoning wrapper также принимает explicit `realCodex`; PATH fallback сохраняется только как backward-compatible test path и не может давать live provenance PASS.

### 3. Large fixture is generated deterministically

Catalog хранит только profile metadata: minimum bytes, line count и tail-fact placement. Renderer создаёт fixture script/output deterministically во временном scenario YAML. Matrix JSON хранит только profile и fingerprint, а не megabyte content.

Для `large_generated_output_retrieval` все variants выполняют один synthetic command. Baseline получает truncated stdout; MCP-only может использовать evaluation-only bounded `ctx_batch_execute` plus `ctx_search`/`ctx_purge`; plugin использует actual hooks. `ctx_batch_execute` не добавляется в normal AIFHub allowlist.

### 4. ai-tester and raw Codex evidence are joined

`ai-tester` trace остаётся authoritative для model identity, final answer, assertions, tokens and duration. Runner параллельно snapshots isolated `CODEX_HOME` rollout files до/после row и parses only new JSONL records.

Raw audit нормализует только:

- tool names and ordered counts;
- whether required/forbidden tools occurred;
- whether tool path arguments remained under sandbox;
- whether parse/identity evidence was complete.

Raw arguments, outputs, paths and content are never returned or persisted. Provider row cannot PASS when its raw audit is missing. A provider `tool_called` assertion is removed from YAML because it is known to be invisible at the outer trace layer.

### 5. Resume remains fail-closed

Until `ai-tester` preserves cwd, repo-check and permission settings for `codex exec resume`, multi-turn continuity is marked `NOT_RUN(resume_driver_parity_unavailable)`. The harness records this limitation instead of accepting a hallucinated answer or relabeling direct-hook evidence.

### 6. Durable evidence is append-only and sanitized

New state uses schema `aifhub.context_mode_codex.live_evaluation.v1`. It records versions, authorization class, scenario aggregates, token/duration deltas, correctness, lifecycle, cleanup and limitations. It excludes raw transcripts, commands, content, paths, environment values and auth fingerprints. Existing archived evidence is linked by change ID and not modified.

## Data Flow

1. Caller provides exact provenance and optional authorization envelope.
2. Matrix validates catalog and computes gates/fingerprints.
3. Runner verifies `ai-tester`, native Codex and reasoning proof.
4. Each row snapshots ai-tester traces and isolated Codex rollouts.
5. After execution, correctness/cost normalization and raw tool/path audit are joined.
6. Safety, purge, cleanup and correctness veto candidate decisions.
7. A separate sanitizer writes bounded aggregate state; disposable raw files are deleted.

## Error Semantics

- `BLOCKED(runtime_dependency_self_install)`: no explicit pinned-runtime authorization.
- `NOT_RUN(auth_isolation_unavailable)`: no scoped auth for actual plugin.
- `NOT_RUN(native_codex_executable_required)`: executable is a shim or not absolute.
- `NOT_RUN(raw_provider_audit_missing)`: outer trace exists but nested provider evidence is absent.
- `FAIL(raw_provider_path_escape)`: nested tool path escapes sandbox.
- `NOT_RUN(resume_driver_parity_unavailable)`: continuation cannot preserve runner settings.

## Logging and Privacy

Logs use `[FIX:134] <event> <bounded-json>`. Allowed fields are row ID, variant, status, reason, tool-name counts and boolean checks. No raw arguments, output, environment, cwd, auth material or filesystem paths are logged.

## Risks / Trade-offs

- Codex rollout schema may change. Unknown records fail closed and do not become provider PASS.
- Generating >1 MiB scenarios increases temporary disk/time cost; fixture is synthetic and deleted with sandbox.
- Explicit authorization could be misused as a shortcut. Exact enum values plus static/sandbox gates keep it narrow, but it remains test-only.
- Current live results are single-run evidence. Recommendation remains bounded and does not claim general token savings.

## Verification

- Unit contracts for every new gate and error code.
- Focused context-mode suite plus docs contract.
- Full validation/test suite, diff check, credential/path scan and strict OpenSpec validation.
- AIF verify against the new change ID before commit.
