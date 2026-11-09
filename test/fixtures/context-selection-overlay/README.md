# Context Selection Overlay Fixtures

Offline corpus for `scripts/context-selection-overlay.test.mjs` (issue #284).
Every case cites only files shipped in this directory (declared-only
provenance); the corpus test copies them into a disposable temp project and
presents candidate files exclusively through repeatable `--candidate` inputs.
Nothing is fetched or read from outside the materialized fixture copy at run
time, and no network access or paid calls happen in any test that consumes
these files. The only generated material is explicitly declared: case
`limit-truncated-source` builds its oversize candidate in the temp project
from an inline recipe (`'z'.repeat(...)`, declared in `labels.json`) because
an oversized fixture file cannot ship byte-pinned. `labels.json` pins the
sha256 of every shipped candidate; the corpus test verifies the shipped bytes
against those digests before any run. The `negative_false_accusations: 0`
threshold verifies label-projection fidelity of the fake assessor over this
corpus — it says nothing about semantic accuracy of a future live model.

## Layout

- `candidates/` — presented supporting candidates (`--candidate <path>`).
  `dev-relevant-en.md`/`dev-relevant-ru.md` carry EN and RU prose that
  supports the seeded baseline behavior; `heldout-different-subject.md`
  repeats the acceptance vocabulary over a different subject;
  `heldout-contradiction.md` contradicts the documented acceptance example
  (low-similarity conflict with exact refs); `heldout-false-premise.md`
  re-attributes the intent to a different subsystem;
  `limit-prompt-injection.md` embeds instruction text, repository paths, and
  a fake URL — all of it is data: the embedded paths never extend the
  presented allowlist or trigger an extra candidate read (the corpus runs a
  recording reader that proves every candidate-path read stays inside the
  presented inputs; the named baseline files are legal reads for the
  read-only SessionBrief inspector), the engine never fetches, and the fake
  assessor's verdict comes from the labels, not from the embedded
  instructions; `limit-crlf.md` uses CRLF line endings pinned byte-exact via
  `-text` in the repository root `.gitattributes` (the labels record its
  exact sha256 and byte length).
- `labels.json` — per-case structural expectations: `candidate_digests`
  (byte pins), per-case `labels` consumed by the labels-driven fake assessor,
  and `expected` observation facts (statuses, coverage, presentation
  completeness, conflict state, drift field, refusals).

## Labels

`labels.json` records, per case, the expected statuses and coverage facts
with exact matches required. `thresholds.negative_false_accusations` is 0: a
case whose labels require no `included` status must never produce one. The
labels prove pipeline, transport, guard, and invariant behavior only — with
no live provider they say nothing about semantic accuracy of a future model,
and no live-eval thresholds are derivable from this fake suite.
