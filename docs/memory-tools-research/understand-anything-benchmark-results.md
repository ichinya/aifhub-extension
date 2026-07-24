# Understand Anything Benchmark Results

## Outcome

The corrected reviewed-output contract matrix does not support adopting the provider. The policy remains `reject_defer`.

- Mandatory evidence: `synthetic_schema_fixture`; 16/16 runner rows executed and all 8/8 pair identities were present.
- Independent evaluation: 11/16 correctness PASS, 16/16 full-trace privacy FAIL, 0/8 evaluator-complete pairs.
- Context boundary: candidate context use and hidden fingerprint proof PASS 8/8; baseline remained context-free 8/8.
- Pair decisions: 8 `forbid`, 0 `recommend`, 0 `conditional`, 0 `avoid`.
- Provider lifecycle: `NOT_RUN(lifecycle_unavailable)`.
- Provider-generated matrix: `SKIPPED(lifecycle_unavailable)`.
- Promotion: disabled with `--no-promote`; synthetic evidence is non-promotable.

## Pinned Profile

| Field | Value |
|---|---|
| Run | `ua-luna-low-20260722-r3` |
| Runtime | `codex` |
| Model | `gpt-5.6-luna` |
| Reasoning | `low` |
| Repetitions | 2 per variant |
| Variants | `baseline_rg`, `candidate_reviewed_graph` |
| Scenarios | `architecture_onboarding`, `change_impact`, `workspace_imports`, `incremental_new_import` |
| Provenance | `synthetic_schema_fixture` |
| Promotion mode | `no_promote` |

Each repetition has a unique `run_id`, `pair_id` and pair-scoped `settings_fingerprint`; only its baseline/candidate variants share that fingerprint. Both variants receive the same answer-independent task. The baseline inspects direct fixture evidence with `rg`; the candidate starts with `rg` and then reads compact typed context emitted by the reviewed-output adapter. Expected paths, edges and the candidate context fingerprint are hidden from the authored task.

## Gate Results

| Gate | Status | Reason |
|---|---|---|
| Exact tag/commit static audit | PASS | `v2.9.0` at `f08763d11d0202a8a8f52b5dedda6d1b2e2ebac8` |
| Protected write boundaries | PASS | No evaluation path may target canonical/generated/QA/global/current-checkout state. |
| Sanitized fixtures | PASS | Architecture, impact, workspace import, incremental import, hostile prose and path cases covered. |
| Adapter/schema/path | PASS | Unknown, oversized, escaping, instruction-like structural text and wrong-project inputs rejected. |
| Prompt independence | PASS | Authored tasks disclose none of the required file or edge values. |
| Candidate context proof | PASS | 8/8 candidates read the optional context and returned its hidden fingerprint; 8/8 baselines remained context-free. |
| Deterministic fixture correctness | PASS | Required files, components, impacts, workspace edges and new incremental edge validated outside model output. |
| Luna runner | PASS | 16/16 runner rows passed their sandbox and completion assertions. |
| Luna correctness evaluator | FAIL | 5/16 answers missed a required workspace edge token; candidate passed 7/8 rows and baseline passed 4/8. |
| Full-trace privacy evaluator | FAIL | 16/16 traces contained local paths; bounded scans also found retained instruction bodies, raw context payloads or secret-like markers. |
| Synthetic raw-trace purge | PASS | Unsafe raw traces were deleted after aggregate generation. |
| Agent-skill eligibility | BLOCKED | 9 required confinement gates are unverified. |
| Provider lifecycle | NOT_RUN | `lifecycle_unavailable`; executor was not invoked. |
| Provider purge | NOT_RUN | No provider state was created. |
| Provider-generated matrix | SKIPPED | Requires lifecycle PASS. |

`BLOCKED` is fail-closed evidence, not a provider failure reproduction. The unmodified interactive skill was not replaced with a hidden CLI or patched execution path.

## Paired Results

| Scenario | Rep | Baseline correctness | Candidate correctness | Privacy | Decision | Baseline ms/tokens | Candidate ms/tokens |
|---|---:|---|---|---|---|---:|---:|
| `architecture_onboarding` | 1 | PASS | PASS | FAIL | `forbid` | 139250 / 351566 | 121867 / 248170 |
| `architecture_onboarding` | 2 | PASS | PASS | FAIL | `forbid` | 108536 / 252727 | 107792 / 257099 |
| `change_impact` | 1 | PASS | PASS | FAIL | `forbid` | 95376 / 169465 | 144383 / 802131 |
| `change_impact` | 2 | PASS | PASS | FAIL | `forbid` | 140953 / 384181 | 105546 / 257651 |
| `workspace_imports` | 1 | FAIL | PASS | FAIL | `forbid` | 158600 / 341101 | 82423 / 254911 |
| `workspace_imports` | 2 | FAIL | FAIL | FAIL | `forbid` | 135163 / 303851 | 157330 / 292317 |
| `incremental_new_import` | 1 | FAIL | PASS | FAIL | `forbid` | 130825 / 362127 | 146890 / 518482 |
| `incremental_new_import` | 2 | FAIL | PASS | FAIL | `forbid` | 192186 / 518275 | 192999 / 578783 |

The candidate produced three reviewer-visible correctness wins over the baseline, but one candidate workspace answer still missed the required edge. More importantly, no row passed the retained-trace privacy contract. Correctness gains cannot override a privacy failure.

## Aggregate Query Cost

| Metric | Baseline | Candidate | Delta |
|---|---:|---:|---:|
| Rows | 8 | 8 | 0 |
| Total duration | 1100889 ms | 1059230 ms | -3.8% |
| Average duration | 137611.125 ms | 132403.75 ms | -3.8% |
| Total tokens | 2683293 | 3209544 | +19.6% |
| Average tokens | 335411.625 | 401193 | +19.6% |
| Turns | 8 | 8 | 0 |
| Tool calls | 52 | 62 | +10 |
| Output bytes | 5291 | 5490 | +199 |

The candidate was slightly faster in this stochastic run but used materially more tokens. Resource differences cannot promote provider policy and do not repair correctness or privacy failures.

## Generation and Amortization

Cold provider generation time, model tokens, turns, output bytes and process cost are `NOT_RUN` because agent-skill eligibility was BLOCKED. No amortized total is reported and no query-count assumption is fabricated. The table above contains warm answer-query cost for the synthetic reviewed-output contract only.

## Decision Mapping

The pair evaluator emits only `recommend|conditional|avoid|forbid`; this run emitted `forbid` for all eight pairs. The separate provider-policy evaluator returned `reject_defer` with these reason codes:

- `synthetic_evidence_non_promotable`
- `provider_lifecycle_not_pass`
- `provider_purge_not_pass`
- `privacy_not_pass`
- `paired_evidence_incomplete`
- `non_positive_pair_decision`
- `material_benefit_not_proven`

The maximum positive outcome, `manual_quality_experiment_only`, would require valid `provider_generated` provenance, lifecycle and purge PASS, complete privacy/correctness evidence and material benefit in at least two relevant pairs. None is inferred from the synthetic contract run.

## Evidence Storage

Raw synthetic traces were purged from `ai-tester/ua-luna-low-20260722-r3/runs/` after the full-trace privacy scan. The superseded r1/r2 runtime files were also removed. The retained r3 state contains sanitized fixtures, answer-independent scenarios, matrix identity and bounded aggregate JSON/Markdown only; it excludes raw model transcripts and tool results.

Historical Graphify, CodeGraph and Repowise runs used different fixtures/profile revisions and are context only, not a direct ranking.
