# Decision Corrections Policy

Owner-confirmed corrections of AI assessments stored as immutable
decision-correction fixtures (issue #285). A correction case is a
project-scoped diagnostic artifact: `diagnostic_only: true` and
`authorizes: []` — it never verifies facts, never creates an
`aif-gate-result`, never writes QA evidence, and never grants workflow
authority.

## Command

```text
ai-factory aifhub-decision-corrections <action> [--enabled true|false] [--scope <id>] [--case <id>] [--write] [--json]
```

Actions: `preview | save | confirm | reject | supersede | list | show | run |
delete`. The request body travels as bounded JSON on stdin (1 MiB limit);
flags never carry payloads. Exit codes: `0` ok, `1` blocked refusal,
`2` invalid usage or input. `list` and `show` are read-only and never take
the scope write lock; a busy lock refuses with the typed `state-locked` code
instead of queueing.

It is opt-in: `--enabled true|false` overrides the
`aifhub.decisionCorrections.enabled` config key (default `false`, never
enabled automatically). A malformed namespace (unknown, duplicate, or
non-boolean keys) keeps the mechanism off with bounded
`decision-corrections:<code>` diagnostics even against a CLI override. The
writer refuses a custom `paths.state` with `state-root-mismatch`: the QA
snapshot projection covers only the default state root, so store writes may
not live anywhere else.

## Input envelope

A case request carries: `case_id`, `scope`, `partition`
(`development | calibration | held_out`), `ambiguity`
(`clear | ambiguous`), `identity` (identity source observation,
`subject_revision`, `input_paths`, `question{id,version}`,
`rubric{id,version}`), `fixture` (`kind: redacted|synthetic`, exact file
bytes with per-file sha256, 8 files / 128 KiB per file / 512 KiB total),
`original_assessment` (consumer + verdict), `expected_label`, optional
`rationale`/`feedback` (2000 chars), optional `replay.args`, and an optional
`evolution` link. The identity source observation is projected through a
fixed allowlist (`schema`, `change_id`, `language`, `structural`,
`semantic`, `inputs`, `rubric`) before it ever reaches the strict binding
canonical form: volatile fields (`generated_at`, `elapsed_ms`, run fields,
release-pinned helper SHAs) never enter the identity, and a nested volatile
key that survives projection refuses with `identity-source-incompatible`
instead of silently changing the digest.

## Store and lifecycle

Cases live at `.ai-factory/state/decision-corrections/<scope-id>/cases/<case_id>.json`;
run records at `<scope-id>/runs/<run_id>.json`. The namespace is constant —
it is shared by the whole command, never derived from a target id, and cases
in different scopes never merge. Statuses are
`draft | confirmed | rejected | superseded` with a separate `ambiguity`
marker: ambiguity is a property of the expected label, not a life phase, so
`confirm`/`reject`/`supersede` are defined on every status. Confirming
requires the expected label and the current `payload_digest`; `rejected` and
`superseded` accept a bounded reason.

## Identity and dedup

`logical_identity` is a sha256 over the strict typed-assessment canonical
form of `{scope, partition, projected observation, subject_revision,
input_revisions, question, rubric}` — timestamps, rationale, and the
expected label are not identity inputs, so relabeling never creates a new
logical case, while a partition relabel does. Dedup-check and write are
serialized under the scope `write.lock`: same identity + same payload is
idempotent (a confirmed case stays confirmed); same identity + changed
payload under the same `case_id` is an explicit new fixture revision; the
same identity under a different `case_id` refuses `revision-conflict`; the
same `case_id` with a different identity refuses `case-identity-collision`;
Windows case-only name collisions refuse deterministically.

## Digest-bound application

`preview` prints the full projected payload plus
`payload_digest = sha256(canonical(payload))` and persists nothing. `save`
requires the digest echo; a mismatch refuses `payload-mismatch` and leaves
no draft, lock, or sidecar artifacts. The confirmation is bound to the exact
fixture bytes: saving the same logical case with changed fixture bytes
creates fixture version `n+1`, resets `expected_label_confirmed`, demotes
the status to `draft`, and returning to `confirmed` requires the expected
label again plus the fresh digest — so a redaction can never silently swap
what a confirmed case tests.

## Privacy

A typed leak predicate (a leak-class superset of the promote-metadata
detector on the JSON-serialized form — JSON escape pairs such as `\n` inside
stored fixture bytes are content encoding, not leak material, while any real
backslash shape in a value refuses — extended with URL schemes) scans the
serialized case, the preview output, the run
record, diagnostics, and the CLI envelope before any persistence or print;
a detected leak refuses `privacy-leak` (blocked) and nothing is echoed.
Rationale, feedback, labels, and reasons carry field-specific bounded
typed codes for NUL and oversize bodies. Free-form bodies are data, never
instructions: stdin JSON is parsed without shell interpolation and no field
determines paths, commands, scopes, or provider setup.

## Evolution link

A case may carry `evolution {transaction_id, proposal_digest} | null` and is
valid without it. Links are checked in-process through the transaction
store's show semantics: a missing or invalid record refuses
`missing-or-invalid-transaction`, a digest mismatch refuses
`proposal-mismatch`, and only `status === 'applied'` counts as an active
application. `show` reports a historical receipt separately from the active
application (`rolled_back` keeps the receipt visible while invalidating the
active binding) and never inspects evidence freshness or the current target.
The evolution contract and its targets are not extended, and no
transaction-to-case backlink exists.

## Replay runner and honesty

`run` performs a local structural replay: the exported advisory run commands
(`requirement-lint`, `claim-evidence-check`, `trace-link-suggestions`)
execute the stored fixture bundle inside an isolated temp root, never with
`--write`, never against the real project tree. Outcomes are compared per
case as exact-normalized labels: matching the expected label is `holds`,
matching the original verdict is `false_regression`, anything else is
`label_change` — computed only over complete observations. A not-performed
advisory scan (no enabling config, no assessor) is an honest `not_run`, a
drifted provenance input or corrupted fixture is `stale` (checked before any
engine call), ambiguous cases are counted but never scored, drafts are
skipped, and a stored record whose integrity cannot be proven is reported as
`invalid_record` instead of silently disappearing from the report. The
replay signature format is versioned: each record carries
`signature_format_version` at the top level (outside `payload` and its
digest, so idempotent re-save and lifecycle transitions keep it); отсутствие
поля читается как версия 1 без мутации загруженной записи, а несовпадение
версии ожидаемой даёт исход `stale` с сигнатурой `signature-format-version`,
а не `label_change` — изменение формата сигнатуры никогда не маскируется под
смену оценки. Fixture
files carry an input role: role-input files are presented to the replayed
consumer with its own input flag (a claim-evidence pairs envelope, a
trace-link test file matching the frozen test path form, a requirement-lint
file), role-support files are materialized into the replay root only
(sources, the trace custody manifest, replay configuration); bundles that
could not produce a well-formed replay argv refuse at save time. Run records (`aifhub.decision_correction_run.v1`) preview by
default and persist only with `--write`, carrying the verbatim honesty note quoted from the change spec (the Russian literal is
normative; its English gloss follows):

> «run проверяет текущую реализацию на fixture, а не provider-качество»
>
> Run verifies the current implementation against stored fixtures; it does
> not measure provider quality.

An external candidate/provider evaluation belongs to a separate system;
its adapter contract is a design sketch only and is not implemented here.

## Partitions and held-out immunity

`development | calibration | held_out` is a closed enum, an identity input,
and immutable after confirmation. Held-out is strictly report-only:
`confirm`, `reject`, `supersede` on a held-out case and a fixture revision of
an existing held-out case refuse `held-out-tuning` at the request-formation
boundary before any engine runs (creating a held-out case is allowed — the
partition is chosen at save time; confirming one is not possible), and the
replay never measures a held-out case: it reports `report_only` without an
engine call or a signature, so nothing about the held-out partition can feed
tuning. The fixture corpus is declared-only: it proves store transport,
guards, and lifecycle — labels say nothing about provider accuracy.

## Retention and delete

`delete` removes a case and its owned transient surfaces (temp siblings)
under the scope lock, keeps the namespace `.gitignore`, and reports a
repeated delete honestly as `deleted: false`.

## State and isolation

All writes run the full guard set before the first byte lands: file-shadow
checks, leaf ownership (only a schema-valid case of the same `case_id` may
be replaced), and `verifyObservationIgnored` over every owned surface —
case files, run records, the namespace `.gitignore`, and the write lock —
with tracked paths refusing `observation-path-tracked`, non-ignored paths
refusing `observation-path-not-ignored`, and git failures failing closed.
The `decision-corrections` namespace is a closed runtime namespace in the QA
snapshot projection: writing, overwriting, or deleting cases cannot shift
the required QA fingerprint, and a declared root inside the namespace fails
closed with `self-referential-input`.

## See Also

- [Claim Evidence Policy](claim-evidence-policy.md) — the advisory
  observation producer whose verdicts corrections annotate.
- [Evolution transactions](usage.md#opt-in-skill-context-evolution) —
  versioned skill-context changes a case may reference.
- [Decision corrections fixture corpus](../test/fixtures/decision-corrections/README.md)
  — the offline acceptance corpus and its labels discipline.
