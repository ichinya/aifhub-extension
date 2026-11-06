# requirement-lint fixtures corpus

Curated corpus for the advisory requirement lint (issue #281). Files are
content templates only: tests copy them into disposable temp projects and
never write into this checkout. `labels.json` carries the machine-readable
expected `by_type` counts per file; `scripts/requirement-lint.test.mjs`
asserts them exactly.

## Discipline

- `dev/`-prefixed files informed the deterministic detector markers while they
  were written; `heldout/`-prefixed files were labeled with the same discipline
  and are asserted by the same corpus test without further marker tuning.
- Expected values are exact `by_type` counts, so a negative counterpart with a
  single false finding fails the corpus test (`thresholds.negative_false_
  findings: 0`).
- Machine tokens (finding types, codes, schema names) stay English in every
  language; `proposed_question` prose follows the resolved language and keeps
  raw quotes untranslated.
- Sanitized historical material (`heldout-sanitized-archive-excerpt.md`) is
  generalized, secret-free evidence from archived changes. It is material, not
  an oracle: labels record what the advisory lint should surface, not ground
  truth about historical requirement quality.
- `dev-hostile-injection.md` contains prompt-injection attempts (URLs, paths,
  rule-override and file-read instructions, config-forgery comments). The lint
  must treat that text as inert data: findings may only reference the
  presented input itself, and no diagnostic may echo the hostile payload.
