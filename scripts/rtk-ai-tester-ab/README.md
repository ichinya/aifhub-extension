# RTK / ai-tester experiment

Manual Windows research harness for issue #138. It uses ai-tester's ACP runtime,
pi-acp, Pi and the unmodified RTK Pi extension. It is not installed by AIFHub.

The fixed matrix is four scenarios × two arms × three repetitions (24 runs).
Baseline and candidate have identical prompts, source snapshots, tool schemas,
model and reasoning settings. Order alternates by scenario and repetition. Each
run uses a fresh ai-tester sandbox. Smoke and pilot runs are excluded from the matrix.

Reference names use `single-01`, `single-02`, `single-03`. These labels replaced
original names before publication, after inference. Prompts and command arguments
are unchanged. Aggregate `provenance` retains executed harness hashes; `publication`
records the current scenario file hash. Supply the labelled config keys below.

Semantic grading extracts one unambiguous JSON object even if the model adds
prose or fences. Strict JSON-only formatting is recorded separately as `jsonOnly`;
it is not treated as a missed security finding. Multiple or malformed objects fail.

| Scenario | Reference | Independent acceptance |
| --- | --- | --- |
| Security diff | single-01 | Finds the seeded ignored GCM authentication error and both consequences; starts with the complete diff request |
| Git history | single-02 | Recovers all five complete subjects, authors, emails, dates and Gate trailers from controlled fixture commits |
| Failure diagnostics | single-01 | Runs real Go tests and reports all 12 failure names and exact runtime operands |
| Price fix | single-03 | Changes only Price.php; runs before/after checks; passes a hidden PHP grader including integer precision, boundary values and invalid precision |

The history is synthetic history on the pinned project copy, not the original
project's history. The diagnostic test is an injected fixture; its operands come
from the command environment, so source inspection cannot reveal the answers.
Source snapshots are exported from exact clean Git commits; original worktrees
are only inspected. The model is allowed to see source from these copies.

The shared adapter exposes only the listed commands and source files. It executes
fixed argument vectors without a shell. In the candidate, RTK's native Pi hook
rewrites `bash` calls. A `raw ` prefix is an experiment adapter escape that runs
the original command directly in either arm; it is **not RTK CLI syntax**. Reads
are complete and bypass RTK. This bounds the experiment and does not establish
compatibility with a general Bash tool or delegated agents.

This is a tool allowlist, not an OS security sandbox. The hidden grader is not
included in prompts or tool-visible paths; generated PHP still executes as local
code. Review generated changes before retention and do not interpret these runs
as evidence of containment against malicious generated code.

Model credentials are loaded into the Pi process environment, never into command
arguments or published results. Command processes receive a separate environment
without model credentials. Windows RTK experiments refuse existing global RTK
state; DB paths are local to each run, tee and telemetry are disabled, and an
absent Claude config directory prevents hook-warning state. Do not use private
repositories without authorization to send their content to the selected model.

Before inference, the quality requirement is all hidden checks passing, no newly
missed security/history/diagnostic fact, and no runtime failures. The benefit
criterion is at least 15% fewer total reported model tokens across the paired
matrix, including rereads, with no more than 10% additional elapsed time. A small
pilot cannot establish general safety; earlier v0.48.0 privacy failures remain
separate adoption blockers even if this matrix meets its criteria.

`message_end` meters sum usage across **all** assistant requests: input, output,
cache reads/writes and total tokens. UTF-8 output bytes are a separate measurement,
not a token estimate. Provider-reported model identity and usage do not attest
which weights an external routing endpoint used. Reported zero cost is not proof
of free inference. Local command time and full run elapsed time include process
and ACP overhead. This experiment is not the full OpenSpec/AIFHub lifecycle.

Create an external JSON config with absolute paths:

```json
{
  "root": "D:/tmp/rtk-ab-new-run",
  "rtk": ".../rtk.exe",
  "rtkExtension": ".../rtk-v0.48.0/hooks/pi/rtk.ts",
  "aiTester": ".../ai-tester.exe",
  "piPackage": ".../node_modules/@earendil-works/pi-coding-agent",
  "piConfig": ".../.pi/agent",
  "piAcp": ".../node_modules/pi-acp/dist/index.js",
  "git": ".../git.exe",
  "go": ".../go1.24.0/bin/go.exe",
  "php": ".../php.exe",
  "projects": {
    "single-01": {"path": ".../single-01", "commit": "24a55ce21aa6a525dd3bd215b13b2af8ef2e14a8"},
    "single-03": {"path": ".../single-03", "commit": "1dc513dd7821c30cab2a8738b399768da58b049d"},
    "single-02": {"path": ".../single-02", "commit": "d643d48ff84c098079f02576a115da3e61135579"}
  }
}
```

The default provider/model is `omniroute/la/ornith-1.5-35b-a3b`, the installed
route matching the requested `omni/la/ornith-1.5-35b-a3b`. Both arms use thinking
`low`, no ambient extensions, context files, skills or prompt templates, and no
Pi session persistence. Pin ai-tester 1.2.0, pi-acp 0.0.33, Pi 0.84.4 and RTK
0.48.0; the resulting aggregate records hashes. `goModuleProxy` may point to a
local read-only module download cache; project go.sum still verifies its bytes.

```powershell
node --test scripts/rtk-ai-tester-ab/guard.test.mjs
node scripts/rtk-ai-tester-ab/run.mjs --config D:/tmp/inputs.json --smoke
node scripts/rtk-ai-tester-ab/run.mjs --config D:/tmp/inputs.json --pilot
node scripts/rtk-ai-tester-ab/run.mjs --config D:/tmp/inputs.json --repeats 3
```

If a pair has incomplete responses or startup failures, restore availability and
repeat **both** arms with `--retry-pairs failure-diagnostics,price-fix --attempt 3`
(select the actual affected scenarios/repetition). Originals remain intact.
`summarize.mjs <aggregate.json> <published.json> <retry-aggregate.json>` preserves
the excluded attempts and initial matrix totals alongside the completed pairs.
It refuses to replace a completed structured answer or a semantic failure.

Actual ai-tester YAML scenarios and config files are generated beneath
`<root>/jobs/<run>/`; JSON serialization is valid YAML. Each invocation uses
`ai-tester run --file ... --format json --keep-sandbox --quiet`.

Only aggregate.json is eligible for publication after inspection. The temporary
root contains raw ai-tester traces, model text, project copies and RTK SQLite
stores. Remove those after grading with verified, native filesystem operations;
report cleanup failures rather than claiming deletion. Do not publish the root.

## Evidence and privacy matrix (`scenarios-evidence.mjs`)

Issue #138 added acceptance criteria the four scenarios above do not cover. A
second, read-only matrix addresses them; arms, prompts and fixture protocol are
identical across scenarios (repetition count is chosen by the runner).

| Scenario | Acceptance criterion from issue #138 | Pass requires |
| --- | --- | --- |
| `code-explore-fidelity` (phase: explore ≈ aif-explore) | Research-phase fidelity over `rg` output | Exact total match count of a computed common term, top-3 files with exact per-file counts, every match (file:line) of a computed rare term; terms and ground truth are computed from the pinned snapshot per project and stored outside the sandbox |
| `gate-artifact-fidelity` | Protected validation artifacts (`aif-gate-result`, `coverage.json`, `done-readiness.json`, `openspec/**`) must never depend only on compressed output | Byte-exact verdict, gate, failing-test name, two-decimal coverage, blocker list and `#### Scenario:` heading; `complete` asserted true |
| `pytest-traceback-fidelity` | Failing-test tracebacks and exact assertion context survive the compressed path, or verification automatically uses raw output | All 12 failing subtests with exact runtime operands, exact first assertion message, failure/passed counts, nonzero exit; whether the compressed path alone sufficed is recorded as an observation, not a gate |
| `raw-escape-archaeology` | A documented raw bypass exists for full diffs, logs, history | Exact deleted source line, per-file insertion/deletion counts of the full working-tree diff, oldest of the last three subjects, exact HEAD `Gate:` trailer |
| `sensitive-command-bypass` | Sensitive commands are excluded from rewriting; tee disabled; `rtk gain` without arguments/secrets | Status JSON with exact token echo, exact failing exit code, honest gain-visibility report **and** a clean deterministic `privacyPostCheck` (no synthetic marker in the SQLite store including `-wal`/`-shm`, the tee tree, or the captured gain output); a rewritten sensitive top-level command fails by itself |

Fixtures are deterministic and synthetic. The pytest operands and the
`AB-SYNTH-*` token come from the run environment / constants, so source
inspection cannot reveal answers, and no real credential exists in the matrix.

Runner glue differs from the original matrix in documented points (module
docblock of `scenarios-evidence.mjs`): `commandEnv.RTK_AB_PYTEST`, additional
`cat`, `pytest` and `rg` executables in the config, a per-run `privacyPostCheck`,
computed explore ground truth stored outside the sandbox, and the pytest pattern
added to the extension's test-command regex. Grade with
`gradeEvidence(case, stats, { answer, privacy, expected })`; unit tests cover
every scenario and the privacy post-check:

```powershell
node --test scripts/rtk-ai-tester-ab/scenarios-evidence.test.mjs
```

### Cross-project matrix runner (`run-evidence.mjs`)

Executes the evidence scenarios in every labelled project of the private config
(one repetition per pair by default), both arms, through the same ai-tester +
ACP + Pi runtime. Labels and their role/commit metadata are published; the
label-to-path map stays in the private inputs JSON. Tracked credential-named
files are excluded from every copy; dirty source trees are allowed and recorded,
never modified; HEAD must match the pinned commit before and after.

```powershell
node --test scripts/rtk-ai-tester-ab/scenarios-evidence.test.mjs
node scripts/rtk-ai-tester-ab/run-evidence.mjs --config <private-inputs.json> --prepare-only
node scripts/rtk-ai-tester-ab/run-evidence.mjs --config <private-inputs.json> --stage smoke
node scripts/rtk-ai-tester-ab/run-evidence.mjs --config <private-inputs.json> --stage pilot
node scripts/rtk-ai-tester-ab/run-evidence.mjs --config <private-inputs.json> --stage matrix [--repeats 1] [--projects <label,...>] [--scenarios <id,...>]
```

Config needs the tool fields above plus `cat`, `pytest` (standalone executable),
`rg` (ripgrep), `provider`, `model` and `projects: { label: { path, commit, role? } }`.
`--turn-timeout <seconds>` (default 300) overrides the ACP turn limit for heavy
scenarios. Existing runs are never overwritten; repeated invocations skip them.
Scenario grading uses `gradeEvidence` plus a deterministic `privacyPostCheck`
(SQLite store including `-wal`/`-shm`, tee tree, captured `rtk gain` output).
Executed evidence: [cross-project report](../../docs/token-providers-research/rtk/cross-project-ab.md).
