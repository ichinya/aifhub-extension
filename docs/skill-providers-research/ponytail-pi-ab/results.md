# Ponytail Pi A/B Results

Execution status: `EXECUTED(mixed_non_promotable)`. The runs are implementation-only, bounded by explicit source snapshots, and run under `manual_experiment_only` policy.

Detailed row output is in [results.json](results.json). Bounded row-level snapshots live in [Qwen aggregate](aggregate-qwen.json), [LA aggregate](aggregate-la.json), [BAI MIMO aggregate](aggregate-bai-mimo-v2-5.json), [BAI GLM aggregate](aggregate-bai-glm-5-3-flash.json), [BAI DeepSeek aggregate](aggregate-bai-deepseek-v4-flash.json), and [BAI Qwen3.8 aggregate](aggregate-bai-qwen3.8-flash.json). Each aggregate is sanitized and excludes private paths; raw prompts and stdout logs are not committed.

## Envelope

| Run | Model | Rows | Complete pairs | Baseline PASS | Ponytail PASS |
|---|---|---:|---:|---:|---:|
| `ponytail-qwen-low-20260902-r4` | `omniroute` / `lq/qwen3.8-27b` | 24/24 | 12/12 | 6/12 | 8/12 |
| `ponytail-la-ornith-low-20260902-r2` | `omniroute` / `la/ornith-1.5-35b-a3b` | 24/24 | 12/12 | 11/12 | 9/12 |
| `ponytail-bai-mimo-v2-5-low-20260903-r4` | `omniroute` / `bai/mimo-v2.5` | 24/24 | 12/12 | 0/12 | 1/12 |
| `ponytail-bai-glm-5-3-flash-low-20260903-r1` | `omniroute` / `bai/glm-5.3-flash` | 24/24 | 12/12 | 11/12 | 10/12 |
| `ponytail-bai-deepseek-v4-flash-low-20260903-r4` | `omniroute` / `bai/deepseek-v4-flash` | 24/24 | 12/12 | 0/12 | 0/12 |
| `ponytail-bai-qwen3-8-flash-low-20260903-r1` | `omniroute` / `bai/qwen3.8-flash` | 24/24 | 12/12 | 7/12 | 8/12 |

All runs use Pi `0.84.4`, `thinking=low`, 900-second timeout, identical tool allowlist, exact-commit disposable copies, and Ponytail `v4.9.0` as explicit `SKILL.md` with `full` mode.

## Correctness By Scenario

| Model | Scenario | Baseline PASS | Ponytail PASS | Pair outcome |
|---|---|---:|---:|---|
| Qwen | TypeScript URL join | 4/4 | 4/4 | 4 both-pass |
| Qwen | Go safe decrypt | 1/4 | 3/4 | 2 Ponytail-only, 1 both-pass, 1 baseline-only |
| Qwen | Laravel exact price | 1/4 | 1/4 | 1 Ponytail-only, 1 baseline-only, 2 both-fail |
| LA | TypeScript URL join | 4/4 | 4/4 | 4 both-pass |
| LA | Go safe decrypt | 3/4 | 4/4 | 1 Ponytail-only, 3 both-pass |
| LA | Laravel exact price | 4/4 | 1/4 | 1 both-pass, 2 baseline-only, 1 Ponytail-only, 1 not comparable (provider error) |
| MIMO | TypeScript URL join | 0/4 | 1/4 | 1 Ponytail-only, 3 both-fail |
| MIMO | Go safe decrypt | 0/4 | 0/4 | 4 both-fail |
| MIMO | Laravel exact price | 0/4 | 0/4 | 4 both-fail |
| BAI GLM | TypeScript URL join | 4/4 | 4/4 | 4 both-pass |
| BAI GLM | Go safe decrypt | 4/4 | 4/4 | 4 both-pass |
| BAI GLM | Laravel exact price | 3/4 | 2/4 | 1 both-pass, 1 Ponytail-only, 2 baseline-only |
| BAI DeepSeek | TypeScript URL join | 0/4 | 0/4 | 4 both-fail |
| BAI DeepSeek | Go safe decrypt | 0/4 | 0/4 | 4 both-fail |
| BAI DeepSeek | Laravel exact price | 0/4 | 0/4 | 4 both-fail |
| BAI Qwen3.8 | TypeScript URL join | 0/4 | 0/4 | 4 both-fail |
| BAI Qwen3.8 | Go safe decrypt | 4/4 | 4/4 | 4 both-pass |
| BAI Qwen3.8 | Laravel exact price | 3/4 | 4/4 | 3 both-pass, 1 Ponytail-only |

## Cross-Run Aggregate (144 rows, 72 pairs)

- Raw rows: `144`; raw pairs: `72`; excluded pairs: `1` (`NOT_COMPARABLE(provider_error)` from the LA run); comparable pairs: `71`.
- Comparable PASS counts by condition: baseline `34/71`, Ponytail `36/71`.
- Comparable pair outcomes: 29 both-pass, 7 Ponytail-only, 5 baseline-only, 30 both-fail.
- Comparable passes by scenario:
  - `typescript-url-join`: 24 pairs total (baseline pass 12, Ponytail pass 13)
  - `go-safe-decrypt-errors`: 24 pairs total (baseline pass 12, Ponytail pass 15)
  - `laravel-exact-price-formatting`: 23 pairs total (baseline pass 10, Ponytail pass 8, 1 excluded pair)

## Efficiency

| Model | Both-pass pairs | Duration baseline -> ponytail | Source churn baseline -> ponytail | Reported tokens baseline -> ponytail |
|---|---:|---:|---:|---:|
| Qwen | 5 | 1448.996 -> 1649.658 s (**+13.85%**) | 113 -> 108 (**-4.42%**) | 36133 -> 46454 (**+28.56%**) |
| LA | 8 | 580.907 -> 474.931 s (**-18.24%**) | 576 -> 391 (**-32.12%**) | 97571 -> 81611 (**-16.36%**) |
| MIMO | 0 | insufficient comparable both-pass pairs | insufficient comparable both-pass pairs | insufficient comparable both-pass pairs |
| BAI GLM | 9 | 1831.610 -> 1503.750 s (**-17.90%**) | 816 -> 396 (**-51.47%**) | 56105 -> 73319 (**+30.68%**) |
| BAI DeepSeek | 0 | insufficient comparable both-pass pairs | insufficient comparable both-pass pairs | insufficient comparable both-pass pairs |
| BAI Qwen3.8 | 7 | 1415.490 -> 1430.550 s (**+1.06%**) | 935 -> 520 (**-44.39%**) | 71124 -> 85529 (**+20.25%**) |

## Interpretation

- Baseline is not consistently better; model-family outcomes vary by scenario. Baseline is ahead in Laravel exact price formatting, while Ponytail is ahead on Go safe decrypt and mostly tied on TypeScript URL join.
- The MIMO and DeepSeek runs remain very weak on this envelope and are included here as explicit non-promotable reference points.
- The benchmark remains implementation-only: it intentionally excludes full `/aif-review`, `/aif-security-checklist`, `/aif-verify`, and `/aif-fix` lifecycle evidence.
