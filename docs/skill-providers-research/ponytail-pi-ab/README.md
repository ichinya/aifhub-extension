# Ponytail Pi A/B Scenarios

This directory defines an implementation-only paired experiment for the Ponytail skill. It is a proxy benchmark for the implementation phase, not evidence that the complete AIFHub OpenSpec lifecycle, review, security checklist, verification, or finalization gates passed.

## Fixed Envelope

- Runtime: `pi 0.84.4`
- Provider/model: `omniroute` / `lq/qwen3.8-27b`
- Thinking: `low`
- Repetitions: four per arm and scenario
- Baseline: all discovered skills, extensions, prompt templates, themes, and project context files disabled
- Candidate: the same isolation flags plus only the exact Ponytail `v4.9.0` `skills/ponytail/SKILL.md`, explicitly activated in `full` mode
- Tools: the same bounded built-in tool allowlist in both arms
- Order: baseline first on odd repetitions and candidate first on even repetitions

The two tasks deliberately test different failure modes:

1. `typescript-url-join` is an over-build-shaped fix in a small TypeScript MCP server. A hidden grader checks four slash-boundary combinations and query preservation.
2. `go-safe-decrypt-errors` is a security/correctness-sensitive fix in a small Go CLI. A hidden Go test checks malformed, truncated, unauthenticated, wrong-key, and tampered ciphertext while preserving a valid round trip.

The Go public command is `go test -skip OpenSSL ./...`: all native project tests and the injected hidden test run, while three pre-existing external interoperability cases are excluded because the pinned Windows benchmark host has no `openssl` executable on `PATH`. This environmental exclusion is fixed for both arms and is not reported as full upstream test coverage.

The catalog records only repository names and exact commits. It does not contain source code, private paths, credentials, raw model output, or a copy of Ponytail.

## Source Safety

Never point `pi` at the original projects. First make clean committed-snapshot copies outside `D:\projects`; the matrix generator verifies the exact commit and a clean Git state, then creates another disposable clone for every arm and repetition. It refuses an output directory inside either the reference-copy root or the Ponytail source root.

Example preparation in PowerShell:

```powershell
$referenceRoot = Join-Path ([System.IO.Path]::GetTempPath()) "aifhub-ponytail-references"
git clone --local --no-hardlinks --no-checkout D:\projects\passkey (Join-Path $referenceRoot "passkey")
git -C (Join-Path $referenceRoot "passkey") checkout --detach 24a55ce21aa6a525dd3bd215b13b2af8ef2e14a8
git clone --local --no-hardlinks --no-checkout D:\projects\yougile-mcp (Join-Path $referenceRoot "yougile-mcp")
git -C (Join-Path $referenceRoot "yougile-mcp") checkout --detach d643d48ff84c098079f02576a115da3e61135579
```

Keep a separate clean checkout of Ponytail `v4.9.0` at commit `0a4dd63ad4541f4f655c4108a295916f3c1d8fda`. AIFHub does not install, clone, or trust it during normal commands; this checkout is an explicit benchmark input only.

## Validate and Prepare

Catalog-only dry run, with no writes and no model call:

```bash
node scripts/ponytail-pi-ab.mjs --run-id ponytail-lq-low-01 --dry-run --json
```

Prepare 16 disposable cases and their exact Pi invocations:

```bash
node scripts/ponytail-pi-ab.mjs \
  --run-id ponytail-lq-low-01 \
  --references-root <copied-reference-root> \
  --ponytail-root <clean-ponytail-v4.9.0-root> \
  --out <new-child-of-existing-temp-directory> \
  --json
```

The output path itself must not exist, while its parent must already exist so the runner can resolve junction/symlink aliases before writing. Add `--execute` to run the prepared cases sequentially. The runner stores raw Pi JSONL and command logs only below the explicitly supplied temporary output directory. It applies public validation and then injects the hidden grader after the model exits. It never commits benchmark output to this repository.

Before execution, confirm the exact runtime, model, and credential readiness without making an inference call:

```bash
node scripts/ponytail-pi-ab.mjs --run-id runtime-check --check-runtime --json
```

## Interpretation

Compare only complete pairs. A candidate run is not a win if its hidden grader, public validation, dependency boundary, or source-containment check fails. For passing pairs, compare changed source LOC, changed files, input/output/cache tokens, cost, and duration. Four repetitions are a minimum signal, not statistical proof.

Do not promote Ponytail from `manual_experiment_only` based on this proxy alone. Promotion still requires the full AIFHub implementation and independent `/aif-review`, `/aif-security-checklist`, `/aif-verify`, and `/aif-fix` evidence described in [Skill Providers](../../skill-providers.md).
