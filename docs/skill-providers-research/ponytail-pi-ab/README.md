# Ponytail Pi A/B Scenarios

This directory defines an implementation-only paired experiment for the Ponytail skill. It is a proxy benchmark for the implementation phase, not evidence that the complete AIFHub OpenSpec lifecycle, review, security checklist, verification, or finalization gates passed.

## Fixed Envelope

- Runtime: `pi 0.84.4`
- Provider: `omniroute`
- Catalog-default model: `lq/qwen3.8-27b`
- Executed model override: `la/ornith-1.5-35b-a3b`
- Thinking: `low`
- Repetitions: four per arm and scenario
- Baseline: all discovered skills, extensions, prompt templates, themes, and project context files disabled
- Candidate: the same isolation flags plus only the exact Ponytail `v4.9.0` `skills/ponytail/SKILL.md`, explicitly activated in `full` mode
- Tools: the same bounded built-in tool allowlist in both arms
- Order: baseline first on odd repetitions and candidate first on even repetitions

The three tasks deliberately test different failure modes and project stacks:

1. `typescript-url-join` is an over-build-shaped fix in a small TypeScript MCP server. A hidden grader checks four slash-boundary combinations and query preservation.
2. `go-safe-decrypt-errors` is a security/correctness-sensitive fix in a small Go CLI. A hidden Go test checks malformed, truncated, unauthenticated, wrong-key, and tampered ciphertext while preserving a valid round trip.
3. `laravel-exact-price-formatting` is a money-correctness fix in the Laravel `cutcode-shop` project. A hidden PHP grader checks exact integer-backed formatting at multiple decimal scales, including values beyond IEEE-754 integer precision, without requiring Composer dependencies, a database, or an application `.env`.

The Go public command is `go test -skip OpenSSL ./...`: all native project tests and the injected hidden test run, while three pre-existing external interoperability cases are excluded because the pinned Windows benchmark host has no `openssl` executable on `PATH`. This environmental exclusion is fixed for both arms and is not reported as full upstream test coverage.

The Laravel public command is `php -l src/Support/ValueObjects/Price.php`. Its hidden grader loads only the value object and its small local trait, so every arm exercises the same production PHP code without coupling the benchmark to MySQL, local secrets, or an uncommitted `.env.testing` file.

The catalog records only repository names and exact commits. It does not contain source code, private paths, credentials, raw model output, or a copy of Ponytail.

## Source Safety

Never point `pi` at the original projects. First make clean committed-snapshot copies outside `D:\projects`; the matrix generator verifies the exact commit and a clean Git state, then creates another disposable clone for every arm and repetition. It refuses an output directory inside either the reference-copy root or the Ponytail source root.

Snapshot Git commands use command-scoped `core.longpaths=true`, which is required by deep Laravel paths inside long case IDs on Windows. The runner does not persist this setting to user or repository Git configuration.

Example preparation in PowerShell:

```powershell
$referenceRoot = Join-Path ([System.IO.Path]::GetTempPath()) "aifhub-ponytail-references"
git clone --local --no-hardlinks --no-checkout D:\projects\passkey (Join-Path $referenceRoot "passkey")
git -C (Join-Path $referenceRoot "passkey") checkout --detach 24a55ce21aa6a525dd3bd215b13b2af8ef2e14a8
git clone --local --no-hardlinks --no-checkout D:\projects\yougile-mcp (Join-Path $referenceRoot "yougile-mcp")
git -C (Join-Path $referenceRoot "yougile-mcp") checkout --detach d643d48ff84c098079f02576a115da3e61135579
git clone --local --no-hardlinks --no-checkout D:\projects\cutcode-shop (Join-Path $referenceRoot "cutcode-shop")
git -C (Join-Path $referenceRoot "cutcode-shop") checkout --detach 1dc513dd7821c30cab2a8738b399768da58b049d
```

Keep a separate clean checkout of Ponytail `v4.9.0` at commit `0a4dd63ad4541f4f655c4108a295916f3c1d8fda`. AIFHub does not install, clone, or trust it during normal commands; this checkout is an explicit benchmark input only.

## Validate and Prepare

Catalog-only dry run, with no writes and no model call:

```bash
node scripts/ponytail-pi-ab.mjs --run-id ponytail-lq-low-01 --dry-run --json
```

Prepare 24 disposable cases and their exact Pi invocations:

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

## Executed Results

Two complete 24-case runs were executed on `2026-09-02`: the catalog-default Qwen model and an otherwise identical LA model override. See the [human-readable analysis](results.md), [sanitized summary](results.json), [Qwen row aggregate](aggregate-qwen.json), and [LA row aggregate](aggregate-la.json).

The committed evidence contains only bounded aggregate metrics and hashes. Raw Pi JSONL, model prose, prompts, case copies, and private paths remain outside the repository. Pre-fix attempts are excluded: the runner originally left child stdin open, so Pi waited for EOF; the valid runs were made only after closing stdin explicitly and adding timeout/EOF regression coverage.

## Interpretation

Compare only complete pairs. A candidate run is not a win if its hidden grader, public validation, dependency boundary, or source-containment check fails. For passing pairs, compare changed source LOC, changed files, input/output/cache tokens, cost, and duration. Four repetitions are a minimum signal, not statistical proof.

Do not promote Ponytail from `manual_experiment_only` based on this proxy alone. Promotion still requires the full AIFHub implementation and independent `/aif-review`, `/aif-security-checklist`, `/aif-verify`, and `/aif-fix` evidence described in [Skill Providers](../../skill-providers.md).
