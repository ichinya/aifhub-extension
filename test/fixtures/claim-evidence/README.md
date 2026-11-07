# Claim Evidence Fixtures

Offline corpus for `scripts/claim-evidence-check.test.mjs` (issue #282). Every
envelope cites only files shipped in this directory (declared-only
provenance); nothing is fetched, synthesized, or read from outside the
materialized fixture copy at run time. No network access and no paid calls
happen in any test that consumes these files.

## Layout

- `sources/` — presented source documents. `spec-ru-crlf.md` uses CRLF line
  endings, `spec-ru.md`/`spec-ru-crlf.md` carry multibyte (RU) text,
  `binary-spec.md` is invalid UTF-8 (unreadable source outcome),
  `secret-source.md` deliberately contains text that the injection envelope
  quotes **without presenting it as a source** — the engine must stay inside
  the presented allowlist and report `not_found`.
- `research/` — claim carrier documents.
- `dev-*.json` — pairs envelopes used to tune the structural matrix labels.
- `heldout-*.json` — envelopes labeled under the same discipline but never
  used to tune detectors; the corpus test asserts them with the same
  exact-match rule.
- `limit-*.json` — boundary cases (`limit-empty-scope.json` must be refused
  with `invalid-envelope`; the oversized-quote boundary is generated in the
  test itself to keep a 64 KiB string out of the repository).

## Labels

`labels.json` records, per envelope: `negative` (a false accusation is an
`exact_found` on a labeled non-exact case; threshold 0),
`expected_pairs` (structural outcomes per claim: `quote_check` ×
`known_revision`, exact match required), and `expected_semantic` (verdicts
consumed by the DI fake assessor). The semantic labels prove pipeline
transport and compound roll-up only — with no live provider they say nothing
about semantic accuracy, and no live-eval thresholds are derivable from this
fake suite. Measured metrics (precision, recall, false-accusation rate, wall
clock) are computed in the test, kept outside any binding, and cost/latency
stay separate from quality.
