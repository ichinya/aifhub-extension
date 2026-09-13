[Back to Documentation](README.md)

# Workflow exchange exports (P2)

Implementation status: implemented for issue #203 P2. The exporter produces
versioned, revision-bound metadata for cross-project consumers — the AIFHub
workflow-profile registry (aifhub#29) and orchestrator import (orkora#229).
Exports are derived metadata only: canonical ownership stays with the AI
Factory plan and the methodology artifacts ([ADR 0005](adr/0005-ai-factory-plan-methodologies.md));
importing a bundle never transfers ownership or establishes a second canonical
store.

## Commands

```bash
ai-factory aifhub-exchange profile [--change <id>] [--json] [--output <path>]
ai-factory aifhub-exchange bundle [--change <id>] [--json] [--output <path>]
ai-factory aifhub-exchange evaluation [--change <id>] --evidence-class <class> [--runner-metrics <path>] [--json] [--output <path>]
```

`--change` binds the export to a specific change; without it the active change
is resolved through the same rules as the other SDD commands. With a
non-OpenSpec `--methodology` (for example `aifactory`), `--change` names the
native plan identity directly and no `openspec/` directory is required.
`--output` writes through the safe provider writer (temp file, `0600`, atomic
rename); paths under `.ai-factory/state/` get the runtime gitignore
automatically. The command never modifies canonical or QA artifacts; the only
runtime write without `--output` is the evaluation fingerprint salt described
below.

Exit codes: `0` exported, `1` degraded (artifact produced with explicit
`exchange_notes`), `2` failed/invalid arguments.

## `aifhub.workflow_profile_export.v1`

Registry-facing metadata for the workflow-profile package kind:

- `profiles` — the seven internal profile IDs with `registry_depth`,
  recommended public planning mode, intended scope, risk classes, and
  required/conditional artifact vocabulary.
- `profile_mapping` — the explicit `expanded → full` rename. ADR 0004 reserves
  `full` for the public planning mode; the registry vocabulary (aifhub#29,
  orkora#229) uses `full` as the deep profile ID. The mapping keeps the two
  namespaces unambiguous.
- `quality_gates` — `required` is the baseline floor
  (`done`, `project_policy`, `tests`, `verify`) every profile keeps;
  `conditional` gates are added by policy or risk signals. Planning depth can
  never weaken this floor.
- `review` — supported context modes (`fresh` default, `same_session`
  fallback) and the human-review boundary: AI review produces `prepared`
  receipts only and never satisfies the `human_review` gate.
- `adapters` — methodology adapters discovered at export time.
- `capabilities` — support levels (`yes`/`no`/`partial`/`unknown`) with
  provenance. Flags that are validated but not executed by any runtime are
  honestly marked (`context_compaction: no`, `session_split: unknown`).
- `artifact_vocabulary` — the provider-neutral lineage kinds
  (`change_spec`, `work_item_spec`, `capability_spec`, `session_brief`,
  `plan_compliance_receipt`, `review_receipt`, `tracer_result`) mapped to
  native paths. `design_context` is marked as an extension kind pending
  registry vocabulary support.
- `resolved_decision` — when `--change` is given, the stored
  `aifhub.sdd_profile_decision.v1` is attached unchanged.

## `aifhub.exchange_bundle.v1`

Per-change bundle for orchestrator import (the Orkora-facing shape):

- `plan` — methodology, adapter version, public mode, selected SDD profile,
  `source_revision`, original request, requirements, tasks, acceptance
  examples, non-goals, and change surface from `aifhub.plan_context.v1`.
- `session_brief` — the compiled `aifhub.session_brief.v1` payload with its
  digest, source/policy revisions, context manifest, and budget. `null` when
  the brief is missing, stale, or blocked; the status and reasons are then
  reported through `exchange_notes` instead of shipping an untrusted brief.
- `artifacts` — hashed inventory of canonical documents classified into the
  lineage vocabulary. `references` carries policy/protected/supporting files
  that are inputs rather than lineage artifacts.
- `lineage` — `derives_from`/`refines`/`implements`/`verifies` edges between
  artifacts and runtime receipts.
- `receipts` — `aifhub.plan_compliance.v1`, every
  `aifhub.ai_cross_context_review.v1` under `reviews/`, and the tracer
  brief/findings/decision triple when present. Each receipt is validated
  against its full v1 contract and `change_id` binding before export;
  unparseable, contract-violating, or foreign-change files are dropped with a
  specific `exchange_notes` entry instead of contaminating the bundle or
  silently disappearing.
- `design_context` — the optional `design.context.json` content (see below).

Soft adapter errors (for example `aifactory-native-plan-parsing-incomplete`)
degrade the bundle instead of failing it: the resolved fields are still
exported and every loss is listed in `exchange_notes`. The snapshot is
revision-consistent: the plan context and the brief must agree on
`source_revision`, otherwise the read is retried once and a continuing
mismatch degrades the export with a `revision_mismatch` note.

## `aifhub.evaluation_export.v1`

Anonymized evaluation record for real-repository evidence. `evidence_class`
is mandatory and uses the aifhub#29 vocabulary: `synthetic_fixture`,
`public_real_repository`, `maintainer_controlled`,
`private_anonymized_aggregate`, `community_submission`.

- `subject` — methodology, adapter version, SDD profile, planning mode,
  `source_revision`, and a `change_fingerprint` — an HMAC keyed by a
  per-project salt persisted at
  `.ai-factory/state/exchange/fingerprint-salt.json` (runtime state,
  gitignored, created on first evaluation export). The fingerprint stays
  stable across exports but the change ID cannot be recovered from it.
- `metrics` — measured values only: brief byte budget, context-manifest and
  source counts, task totals, plus tokens/cost/latency when a runner metrics
  file is supplied. Everything else stays `null`; nothing is estimated.
- `outcomes` — session-brief status, plan-compliance outcome and drift counts,
  review outcome summaries (mode, outcome, finding count, same-session
  fallback), and the tracer decision. No findings text, no diff content.
- `runtime` — run id, model, and harness identity from the runner metrics
  file.
- `privacy` — explicit `false` flags for paths, prompts, source content,
  transcripts, and change ID. `exchange_notes` in this record carry codes
  only — note details may contain project-relative paths and stay internal to
  the bundle. The serialized record is additionally scanned for recognizable
  credential patterns before export.

### `aifhub.runner_metrics.v1`

Optional input file passed via `--runner-metrics`. Strict allow-list:
`run_id`, `tokens` (`input`/`output`/`total`/`cache_read`/`cache_write`),
`cost` (`amount` + ISO currency), `latency_ms`, `retries`, `changed_loc`,
`unrelated_changes`, `human_review_ms`, `verified_success`, `model`
(`provider`/`id`/`version`), `harness` (`id`/`version`). Unknown fields or
non-numeric values reject the export with `invalid_runner_metrics`; the file
must live inside the project root.

## Optional `design.context.json`

`openspec/changes/<id>/design.context.json` is an optional, additive
structured design-context artifact (`aifhub.design_context.v1`): a short
summary plus a bounded list of design surfaces (`markdown`, `html`, `image`,
`figma`, `storybook`, `live_url`, `other`) with refs and optional content
hashes.

- It is inventoried and hashed like other change documents, so it joins
  `source_revision` and SessionBrief staleness detection automatically.
- It never replaces `design.md`, delta specs, or verification evidence, and it
  is not a second canonical specification tree.
- A malformed file does not block the export: it is dropped from the bundle
  with an `invalid_design_context` note.

## Boundaries

- Exports contain metadata, hashes, and receipts — never prompts, transcripts,
  hidden reasoning, or private source content. The bundle includes plan and
  brief text because both are already canonical project artifacts; consumers
  outside the repository should treat the bundle as project-internal and use
  the evaluation export for anything public.
- Import is the consumer's responsibility: the bundle binds every fact to an
  exact `source_revision` and brief digest so a consumer can detect stale,
  mismatched, or unsupported representations and must surface an explicit
  import receipt rather than silently adopting canonical state.
- Quality gates are independent of planning depth; `exchange_notes` must be
  read before trusting a `degraded` export.
