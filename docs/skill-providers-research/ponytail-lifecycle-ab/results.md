# Ponytail Lifecycle Pi A/B Results

Execution status: `EXECUTED(la_only_non_promotable)`. One complete 32-case run exists for
`omniroute/la/ornith-1.5-35b-a3b`; no other model has been run on this envelope. The runs are
lifecycle-command proxies bounded by explicit source snapshots and stay under
`manual_experiment_only` policy.

Row-level data is in [aggregate-la.json](aggregate-la.json). Raw Pi JSONL, model prose, prompts, case
copies, and private paths remain outside the repository.

## Envelope

| Run | Model | Rows | Complete pairs | Baseline PASS | Ponytail PASS |
|---|---|---:|---:|---:|---:|
| `ponytail-la-lifecycle-low-20260903` | `omniroute` / `la/ornith-1.5-35b-a3b` | 32/32 | 16/16 | 8/16 | 8/16 |

All cases use Pi `0.84.4`, `thinking=low`, 900-second timeout, the implementation benchmark's tool
allowlist, exact-commit disposable copies, the verbatim AIFHub command skill in both arms, and
Ponytail `v4.9.0` as an additional explicit skill in the candidate arm.

## Correctness By Scenario

| Scenario | Command | Baseline PASS | Ponytail PASS | Outcome |
|---|---|---:|---:|---|
| `review-price-float-precision` | `/aif-review` | 4/4 | 4/4 | 8 both-pass |
| `security-decrypt-auth-skip` | `/aif-security-checklist` | 4/4 | 4/4 | 8 both-pass |
| `verify-price-float-precision` | `/aif-verify` | 0/4 | 0/4 | 8 both-fail |
| `fix-decrypt-auth-restore` | `/aif-fix` | 0/4 | 0/4 | 8 both-fail |

## Failure Modes (both arms)

- `/aif-verify` (8/8 failed): the model edited `src/Support/ValueObjects/Price.php` while verifying in
  6 cases, violating the sidecar contract "Never edit implementation files"; one case wrote the gate
  evidence to `ai-factory/` (missing dot) and one created a stray scratch file. No case produced a
  contract-valid persisted `verify.md`.
- `/aif-fix` (8/8 failed): every run restored the swallowed `gcm.Open` authentication error but none
  reached the uniform `invalid ciphertext` rejection required by the prepared QA evidence (the
  `malformed encoding` case kept leaking the base64 error). One baseline case also edited
  `go/encrypt_test.go` outside the seeded changed scope; several runs skipped the fix trace.

## Efficiency (per-case means)

| Scenario | Duration baseline -> ponytail | Tokens baseline -> ponytail |
|---|---:|---:|
| review | 24 s -> 74 s | 30 655 -> 77 164 |
| security | 19 s -> 23 s | 29 624 -> 40 037 |
| verify | 70 s -> 61 s | 56 931 -> 53 699 |
| fix | 67 s -> 113 s | 45 585 -> 66 567 |

## Interpretation

- On the grader-defined correctness axis, Ponytail changed nothing for this model: identical pass
  counts in every command (8/16 vs 8/16), zero pair-level win/loss flips. The follow-up DeepSeek run
  gated on a strong win/loss difference was therefore not executed.
- The read-only gates are ceiling-limited for this model (8/8 both arms) and the write gates are
  floor-limited (0/8 both arms); the envelope cannot separate conditions on them until a model lands
  inside the range. The dominant `la/ornith` failure modes are contract-discipline failures (editing
  implementation files during verify, skipping the fix trace, partial uniform-rejection fixes), not
  missed seeded defects — both seeded defects were found in effectively every read-only run.
- Ponytail adds token overhead on this envelope without a correctness effect (+152% tokens on review,
  +46% on fix); this is a cost signal only, not a promotion signal.
- This remains a lifecycle-command proxy: it does not execute the AIFHub extension inside an
  AI Factory/Codex/Claude host and does not by itself support promotion out of
  `manual_experiment_only`.
