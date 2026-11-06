[Back to Documentation](README.md)

# Requirement Lint Policy

Opt-in, advisory semantic lint for ambiguous requirements presented to OpenSpec-native `/aif-plan` and `/aif-improve` (issue #281). The lint is a manual neighbor of the requirements reconciliation gates: it never changes evidence, never authorizes progression, and never answers the clarifying question it proposes.

## Command

```text
ai-factory aifhub-requirement-lint --change <id> [--enabled true|false] --file <path> [--file <path> ...] [--language ru|en] [--json] [--write]
```

- Opt-in: the lint is off by default. Enable per run with `--enabled true|false`, or persist `aifhub.requirementLint.enabled: true` under `aifhub:` in `.ai-factory/config.yaml`. Precedence: CLI override > config key > `false`. A run without opt-in reports the `not_run` envelope ("advisory scan was not performed", exit 0) and performs no project reads or writes beyond the bounded config read that evaluates the switch itself; it never becomes a required-gate failure.
- Malformed lint namespace forms the lint parser detects explicitly (duplicate keys, `<<` merge keys, `&` anchors, `*` aliases, flow mappings, quoted booleans, unknown nested keys) keep the lint off with bounded `requirement-lint:<code>` diagnostics. Pre-existing hub-level config failures keep their existing behavior.
- Preview by default: the result is rendered (human text or `--json`) without writing anything. The observation is written only by explicit `--write`. Exit 0 means an honest outcome was formed (including findings and explicit degradations); exit 2 is an invalid invocation; exit 1 is an operational failure. No exit code participates in verify/done/archive chains.

## Findings

- Exactly four closed finding types: `undefined_observable_outcome`, `missing_error_case`, `owner_decision_assumed`, `suspected_requirement_revision_conflict`. Detection markers are advisory heuristics pinned by the offline profile (`scripts/requirement-lint.profile.json`, `heuristic: true`).
- Every finding carries an exact source ref: a presented catalog ID, or a deterministic UTF-8 byte span `[start, end)` over the raw document revision plus the sha256 of the raw bytes and of the span bytes. Raw quotes inside `proposed_question` stay untranslated.
- `suspected_requirement_revision_conflict` is intra-requirement only: exactly two refs, one per revision side (`ref_relation: conflicting_revision_pair`). Claim↔source contradictions belong to the separate ClaimEvidenceCheck follow-up (#282); cross-source plan-level conflicts stay with the upstream reconciliation gate.
- `proposed_question` is a clarifying question for the owner, never an answer: the lint never inserts a numeric SLA, never rewrites requirement text, never emits a ready or verified verdict, and never sends questions automatically.
- Findings carry a stable `dedup_key` (`finding_type + exact refs`). Consumers skip findings whose exact refs an upstream reconciliation gate or `## Requirements Reconciliation` already surfaced instead of presenting them twice. A skipped scan after a gate stop is not a "no problems" signal.

## Honesty

- The observation schema `aifhub.requirement_lint_observation.v1` separates `run_status` (`complete | failed | not_run`), `freshness` (`current | stale`), `coverage` (`full | partial | none` with declared/scanned/missing sources), and `findings_summary`. A `none` result means nothing was found in the presented scope only — it is never a readiness, verification, or approval signal, and there is no numeric score to hide behind.
- Missing sources, malformed inputs, and deadline cutoffs are coverage/diagnostic outcomes, never a fifth finding type and never a silent `none`. Assessor abstention and failures stay finding-free.
- Editing a requirement, the pinned profile, or the schema contract invalidates a persisted observation: read-time revalidation (`validateObservationBinding`) recomputes the composite binding (worktree identity, input digests, profile, engine, helper, contract, language, exclusion policy) and names the drifted fields; a change during the scan marks the outcome `stale` before it is presented.

## State and isolation

- The observation is written only under `.ai-factory/state/<change-id>/requirement-lint/observation.json` through guarded state-only writes: QA namespace conflicts, file-shadow ancestors, and foreign leaves are refused, and only a previous schema-valid observation of the same change may be replaced. A custom `paths.state` is refused by the lint (`state-root-mismatch`) because the QA projection covers only the default state root; use the default root. Custom-root support is a follow-up candidate, not part of this change.
- The `requirement-lint` namespace is a closed runtime namespace in the QA snapshot projection (all projection points), so writing, overwriting, or deleting an observation between enrollment and binding checks cannot shift the required QA fingerprint or binding. The namespace gitignore lives inside the namespace itself.
- Untrusted requirement text is data, never commands: the offline rules path contains no process/network API, opens no URLs, reads no paths out of the text, and invents no identifiers. Findings reference only the presented inputs.
- Advisory only: no `aif-gate-result`, no QA writes, no entry into done-readiness, provider policy, or runner metrics. OpenSpec-native only — legacy classic mode never runs this scan. The live model provider is a separate opt-in step (secret exclusion and egress checks before any model call, pinned profile/model/prompt, bounded cost/time/output); until then the deterministic rules assessor is the only assessor.

## See Also

- [Documentation Index](README.md)
- [Docs Readability Policy](readability-policy.md)
- [Project Review Policy](review-policy.md)
