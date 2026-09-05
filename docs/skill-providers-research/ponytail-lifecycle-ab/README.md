# Ponytail Lifecycle Pi A/B Scenarios

This directory defines a lifecycle-parity paired experiment for the Ponytail skill: it runs the four
AIFHub lifecycle review commands (`/aif-review`, `/aif-security-checklist`, `/aif-verify`, `/aif-fix`)
with and without Ponytail `v4.9.0` loaded, on seeded real-project states, and grades the outcomes with
deterministic hidden graders. Like the implementation-only [Pi A/B](../ponytail-pi-ab/README.md), it is
a proxy: it does not execute the AIFHub extension inside an AI Factory/Codex/Claude host, and it does not
by itself support promotion out of `manual_experiment_only`.

## Fixed Envelope

- Runtime: `pi 0.84.4` (the PATH shim is broken under the active Node 18; the runner is started with
  Node 22.22.2 so Pi runs under the runner's own `process.execPath`)
- Provider: `omniroute`, catalog-default model: `la/ornith-1.5-35b-a3b`
- Thinking: `low`, repetitions: four per arm and scenario, timeout: 900 s per case
- Tools: the same bounded allowlist as the implementation benchmark in both arms
  (`read, grep, find, ls, powershell, edit, write`; `ask_question` excluded)
- Baseline arm: only the pinned AIFHub command skill (verbatim agent-file text with host-specific
  frontmatter keys rewritten to Pi-safe `name`/`description`; body untouched)
- Candidate arm: the same command skill plus the exact Ponytail `v4.9.0` `SKILL.md` in `full` mode
- Isolation: identical flags to the implementation benchmark (`--no-extensions`, `--no-skills`, etc.),
  exact-commit disposable Git copies, condition order alternates by repetition

## Seeded Lifecycle States

Two fixture projects (same pinned commits as the implementation benchmark) host four scenarios; each
case clones the snapshot, copies deterministic canonical artifacts, and applies a seeded defect patch as
an uncommitted working-tree change:

1. `review-price-float-precision` (cutcode-shop, `/aif-review`): the change renders `Price` through
   float division and loses the last digit beyond IEEE-754 precision (2 mismatches against the spec,
   verified deterministically). The grader requires a non-pass review verdict that names the defect and
   a contract-clean `aif-gate-result` (`gate: "review"`, `blocking` only on `fail`, `suggested_next`
   `null` on `pass`), with the worktree untouched.
2. `security-decrypt-auth-skip` (passkey, `/aif-security-checklist`): `Decrypt(..., "safe")` discards
   the AES-GCM authentication error, so tampered and wrong-key ciphertexts are accepted. The grader
   requires a non-pass security verdict naming the flaw, the same gate contract, and a read-only
   worktree.
3. `verify-price-float-precision` (cutcode-shop, `/aif-verify`): the verifier must fail the change,
   route to `/aif-fix` in the persisted `.ai-factory/qa/<change-id>/verify.md`, name the float-precision
   defect, keep the stdout block identical to the persisted block, and write only under
   `.ai-factory/qa/<change-id>/`.
4. `fix-decrypt-auth-restore` (passkey, `/aif-fix`): prepared QA evidence names the swallowed
   authentication error and the required uniform `invalid ciphertext` rejection. The grader reuses the
   implementation benchmark's injected hidden Go test (`go test -skip OpenSSL ./...`), requires a fix
   trace under `.ai-factory/state/<change-id>/fixes/`, byte-identical QA evidence, unchanged HEAD and
   dependency files, and edits confined to the seeded changed scope.

Canonical OpenSpec artifacts (proposal/design/tasks/spec deltas plus `.ai-factory/config.yaml` with
`aifhub.artifactProtocol: openspec`) are validated with `openspec validate` for both seeded changes at
authoring time. Seeded patches, canonical artifacts, QA evidence, and graders live in
`scripts/fixtures/ponytail-lifecycle-ab/`.

## Run

```bash
"$NODE_22" scripts/ponytail-lifecycle-ab.mjs --run-id ponytail-la-lifecycle-low-20260903 \
  --references-root <clean-reference-root> \
  --ponytail-root <clean-ponytail-v4.9.0-root> \
  --out <new-temp-directory> --execute --json
```

`--dry-run` builds the 32-case matrix without writes; grader behavior against prepared cases is covered
by `scripts/ponytail-lifecycle-ab.test.mjs` plus a manual grader self-test. Graders never read model
prose outside the case directory and never commit benchmark output to this repository.

## Interpretation

Compare complete pairs only. Per arm, compare the grader-defined correctness pass rate against the
other condition; efficiency (duration, tokens, LOC churn on the fix scenario) is reported for context.
A candidate run is not a win if the hidden grader, integrity checks, or containment rules fail.
Four repetitions are a minimum signal, not statistical proof. Promotion still requires the full AIFHub
implementation and independent `/aif-review`, `/aif-security-checklist`, `/aif-verify`, and `/aif-fix`
evidence described in [Skill Providers](../../skill-providers.md).
