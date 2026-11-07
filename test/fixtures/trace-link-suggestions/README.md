# Trace Link Suggestions Fixtures

Offline corpus for `scripts/trace-link-suggestions.test.mjs` (issue #283). Every
case cites only files shipped in this directory (declared-only provenance); the
corpus test copies them into a disposable temp project and presents test files
exclusively through repeatable `--test` inputs. Nothing is fetched, synthesized,
or read from outside the materialized fixture copy at run time. No network
access and no paid calls happen in any test that consumes these files.

## Layout

- `specs/` — delta spec sources copied to `openspec/changes/<case-id>/specs/`.
  `spec-en.md`/`spec-ru.md` carry EN and RU prose (RU with cyrillic headings and
  multibyte byte offsets), `spec-amb.md` holds duplicate scenario headings,
  `spec-twin.md` holds duplicate requirement titles, `spec-adv.md` carries
  adversarial text (URLs, paths, commands, fake approval/gate fields) that the
  engine must treat as data, and `spec-crlf.md` uses CRLF line endings pinned
  byte-exact via `-text` in the repository root `.gitattributes`.
- `traces/` — fake `lekalo/trace-manifest/v0.2.16` envelopes
  (`{trace, manifestDigest}`). The node/relation/gap format is the engine-owned
  structural schema of `scripts/trace-link-suggestions.mjs`: in P0 no golden
  file of a live Lekalo export exists, so these fixtures define the format the
  engine accepts; when a live Lekalo appears the format contract must be
  re-verified against a real export. `foreign-trace.json` is placed under a
  different change's custody directory by the test and must never be read.
- `tests/` — presented test inputs (`--test <path>`): JS test files exercise
  comment/string-literal masking for behavioral anchors (including nested
  template interpolations), `.md` test documents carry exact scenario
  headings (EN and cyrillic) as anchor needles. Masking is per language
  family (JS, hash-comment, none for prose/unknown extensions — documented
  P0 limitation); trace refs after the kind prefix follow the Lekalo symbol
  form, so requirement/scenario titles with spaces or non-ASCII participate
  through parsed scenarios and test anchors rather than trace refs.
- `labels.json` — per-case structural expectations (exact edge sets, outcomes,
  coverage, refusals) plus fake-assessor semantic labels.

## Labels

`labels.json` records, per case: `expected_structural` (section outcome,
coverage state, and the exact edge set with per-edge outcome and anchor count —
exact match required), `expected_semantic` (verdict distribution consumed by
the injected fake assessor), and `refusals` (bounded not_run/typed-refusal
codes with exit codes). `thresholds.negative_false_accusations` is 0: a case
whose labels require no `candidate` outcome must never produce one. The
structural labels prove pipeline and guard behavior only — with no live
provider they say nothing about semantic accuracy of a future model, and no
live-eval thresholds are derivable from this fake suite.
