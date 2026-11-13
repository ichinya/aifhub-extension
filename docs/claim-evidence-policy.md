[Back to Documentation](README.md)

# Claim Evidence Policy

Opt-in, advisory claim↔source evidence check for pairs presented to OpenSpec-native `/aif-explore` (research) and `/aif-review` (review) (issue #282). The check is a structural diagnostic, never a verifier or a factual guarantee: it never changes evidence, never authorizes progression, never edits review findings, and never answers the question whether a claim is true.

## Command

```text
ai-factory aifhub-claim-evidence-check --change <id> [--enabled true|false] (--pairs <path> | --stdin) [--json] [--write]
```

- Opt-in: the check is off by default. Enable per run with `--enabled true|false`, or persist `aifhub.claimEvidence.enabled: true` under `aifhub:` in `.ai-factory/config.yaml`. Precedence: CLI override > config key > `false`. A run without opt-in reports the `not_run` envelope ("advisory scan was not performed", exit 0) and performs no reads beyond the bounded config read that evaluates the switch itself; it never becomes a required-gate failure.
- Malformed `claimEvidence` namespace forms the config parser detects explicitly (duplicate keys, `<<` merge keys, `&` anchors, `*` aliases, flow mappings, quoted booleans, unknown nested keys, scalarized sections) keep the check off with bounded `claim-evidence:<code>` diagnostics. Pre-existing hub-level config failures keep their existing behavior.
- Custody model: the advisory hooks on research and review invoke the command as a **preview without writing** (no `--write`). Persisting the observation is a separate authorized writer action: an explicit `--write` run. Exit 0 means an honest outcome was formed (including structural findings and explicit degradations); exit 2 is an invalid invocation; exit 1 is an operational failure. No exit code participates in verify/done/archive chains.

## Input envelope

- The input is a closed structured pairs envelope (`aifhub.claim_evidence_pairs.v1`): carrier identity, `claim_id`/`parent_claim_id`, `claim_ref`, `source_ref` (relative path plus optional byte span), relation (`literal_quote | paraphrase | inference`), checked scope, and optional known source-revision metadata. Every violation (unknown keys, oversized quotes, invalid spans, unresolved parents, raw-body fields) is a typed `invalid-envelope` refusal (exit 2), never a silent reinterpretation.
- Transport: a file (`--pairs <path>`) pointing at a pairs file the user already presented, or stdin. The presenting agent never creates a claims sidecar file: research may write only its resolved research path and review is read-only, so the hook transport is stdin or an already-presented file.
- The allowlist is built from the explicitly presented inputs before any read. URLs and paths inside claim text are data: they never extend the allowlist, never trigger a fetch, and never become a fabrication verdict — an unreviewed reference stays "not checked in the presented scope", never "invented". Similar-looking text in a different artifact inherits nothing: only presented pairs are checked.

## Structural stage

- `missing_sources` имеет per-pair семантику: каждая запись фиксирует пару claim↔source, поэтому список может содержать повторяющиеся пути. Счётчики используют ту же размерность: `declared_sources = structural.pairs.length`, `scanned_sources = declared_sources − missing_sources.length`.
- Fully deterministic over the raw bytes of the presented inputs only: source existence, exact quote spans for `literal_quote` pairs (`Buffer.indexOf` over raw bytes; UTF-8 byte offsets `[start, end)` plus the sha256 of the raw document bytes and of the span bytes), and known-revision metadata.
- Closed `quote_check` outcomes: `exact_found`; `literal_match_out_of_context` (defined only when a span anchor was presented — the quote bytes exist in the source but outside the presented anchor); `not_found`; `source_unavailable`; `truncated` (over-limit source); `not_applicable` (`paraphrase`/`inference` skip the quote check explicitly). Input spans with an invalid range are refused, never clamped.
- Known source-revision metadata is a separate dimension (`match | changed | not_declared | unverifiable`) from the semantic stage's freshness probe: a declared revision that no longer matches the current bytes is recorded as `changed` while freshness stays the probe result. `not_declared` is reserved for an omitted revision; a declared revision whose source cannot be read is `unverifiable`, never silently `not_declared`.
- Composite claims are split by the caller into atomic parts (`parent_claim_id`); the engine computes a compound roll-up: a parent inherits `supported` only when every presented part carries a `supports` verdict from a completed, non-abstained semantic stage — an `insufficient`, abstained, or absent part keeps the parent `not_supported`.

## Semantic stage

- Runs through the shared typed-assessment helper with a DI assessor seam. Without a live provider the stage reports an honest `not_run`; fake assessors exist only as test injection. Verdicts are the closed set `supports | contradicts | insufficient`, with abstention through the helper; there is no fifth outcome.
- Assessor errors, abstentions, timeouts, invalid outputs, and assessments naming claims outside the presented envelope degrade the stage explicitly and never become `supports`. The structural section survives every semantic failure untouched: deterministic checks never live in the helper's findings list, so a provider error cannot destroy them.
- No numeric thresholds for a future live semantic evaluation are derivable from the fake suite; the live provider stays a separate opt-in phase with its own evaluation design.

## Honesty

- The observation schema `aifhub.claim_evidence_observation.v1` is closed (`diagnostic_only: true`, `authorizes: []`) and keeps separate sections: structural checks, semantic assessments, the semantic stage's execution outcome (`run_status`/`freshness`/`abstained`/`coverage`), and the compound roll-up. A `none` result or a clean structural run means nothing was found in the presented scope only — never readiness, verification, or approval.
- Editing a carrier, a source, the rubric revision, or the schema contract invalidates a persisted observation: read-time revalidation recomputes the composite binding (worktree identity, carrier digest, exact claim refs and split, source digests, checked scope and truncation marks, transport, rubric/engine/helper/contract revisions, language, exclusion policy), re-derives each recorded quote span from the current source bytes (span bounds, document digest, and the recorded span digest), and names the drifted fields; a change during the run marks the outcome `stale`.

## State and isolation

- With explicit `--write` the observation is saved only under `.ai-factory/state/<change-id>/claim-evidence/observation.json` through guarded state-only writes: QA namespace conflicts, source/carrier/envelope collisions with the destination, file-shadow ancestors, and foreign leaves are refused, and only a previous schema-valid observation of the same change may be replaced. A custom `paths.state` is refused (`state-root-mismatch`) because the QA projection covers only the default state root.
- The pre-write git guard refuses a tracked or not-effectively-ignored output for both the observation and the namespace `.gitignore` (the QA snapshot's `actual_diff` channel is unfiltered). The `claim-evidence` namespace is a closed runtime namespace in the QA snapshot projection (all projection points, injected providers included), so writing, overwriting, or deleting an observation cannot shift the required QA fingerprint.
- Advisory only: no `aif-gate-result`, no QA writes, no entry into done-readiness, provider policy, or runner metrics; review findings and the upstream validator are never replaced, and the research coherence gate order is untouched. Boundary with RequirementsSemanticLint (#281): the lint covers requirement ambiguity on `/aif-plan` and `/aif-improve`; this check covers claim↔source pairs on research and review. A plan-surface hook is an explicit follow-up after both linters have landed.

## See Also

- [Documentation Index](README.md)
- [Requirement Lint Policy](requirement-lint-policy.md)
- [Docs Readability Policy](readability-policy.md)
- [Project Review Policy](review-policy.md)
