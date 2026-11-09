# Decision Corrections Fixtures

Offline corpus for `scripts/decision-corrections.test.mjs` (issue #285).
Declared-only provenance: every case file cites the shipped `sources/` of
this directory plus deterministic offline setup artifacts that the corpus
test itself creates in its disposable temp project (`docs/extra.md`, the
transaction evidence/context files); nothing is fetched, synthesized, or
read from outside the materialized fixture copy and the test root at run
time. No network access and no paid calls happen in any test that consumes
these files.

## Layout

- `sources/` — presented provenance inputs. `spec.md` is the shared LF source;
  `spec-crlf.md` uses CRLF line endings and is pinned `-text` in
  `.gitattributes` so the exact-bytes fixture guarantee survives checkout.
- `cases/dev-*.json` — case requests used to pin the store matrix labels
  (lifecycle, dedup, digest-bound save, redaction, transaction links, scoped
  separation, CRLF byte exactness).
- `cases/heldout-*.json` — cases labeled under the same discipline but never
  used to tune anything: the store refuses every outcome-affecting mutation
  on held-out partitions (`held-out-tuning`) and replay stays report-only.
- `cases/limit-*.json` — boundary cases that must be refused with a typed
  code (malicious bodies, NUL, oversize text, secret-like tokens, missing or
  digest-mismatched transaction links).
- `labels.json` — per-file expected outcomes (exact match required).

## Labels

`labels.json` records, per case: the expected typed outcome of each step
(`save`, `confirm`, `resave`, `run_outcome`, redaction shape) or the expected
refusal code for `limit-` cases. The corpus proves store transport, guards,
and lifecycle only — with no live provider it says nothing about provider
quality, and no live-eval thresholds are derivable from this fake suite. The
replay runner's honesty note stays a contract term quoted verbatim from the
change spec: «run проверяет текущую реализацию на fixture, а не
provider-качество» (run verifies the current implementation against stored
fixtures; it does not measure provider quality).
`dev-tx-link.json` carries a `SEALED-BY-TEST` proposal digest placeholder:
the corpus test seeds a real evolution transaction and substitutes the
sealed digest before the save, and never reads it from the repo at run time.
