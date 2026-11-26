[Documentation](README.md) | [Evaluation evidence](token-providers-research/rtk/README.md)

# Token Providers

Token providers reduce command output before it reaches an agent. They are optional,
user-installed infrastructure. A smaller observation is not necessarily complete
evidence: deterministic filters can remove assertions, patches and historical facts.

## RTK decision

The AIFHub decision for [RTK](https://github.com/rtk-ai/rtk) is **`reject_defer`**
for broad recommendation or automatic integration. The v1.2.1 follow-up confirmed
that an excluded Claude hook command can still reach SQLite with tracking disabled
and that filtered pytest output can omit failing cases. Explicit, user-owned
overview use remains useful where the evidence supports it. See the
[v1.2.1 follow-up](token-providers-research/rtk/README.md#rtk-v121-follow-up).

## When to use RTK

Keep direct commands as the default. Invoke RTK explicitly for an overview when
the command has non-sensitive input and output and produces enough detail to
make filtering useful. Choose the route based on what the task needs to recover.

| Situation | Recommended route | Why |
| --- | --- | --- |
| First look at a large diff | Run `rtk git diff` to locate areas of interest. Use direct `git diff -- <path>` for review findings. | The AIFHub PR output shrank by 95.7%. In a controlled patch, RTK showed 99 of 220 added lines. |
| Quick pass/fail check with a verbose test runner | Use RTK manually when the exit code or a compact summary is sufficient. If the run fails, use the direct runner for diagnosis. | Verbose pytest and Go output shrank by about 99.8% in the successful runs. Exit codes matched in all three projects. |
| Routine status, small diffs and already-quiet tests | Use the tool's native output, such as `git status --short` or `go test` without `-v`. | The short status and the normal-verbosity Go run each saved one byte. AIFHub's selected `npm test` suite saved 4.2%. |
| Full review, `/aif-verify`, `/aif-fix` and exact OpenSpec or gate evidence | Use direct commands from the first read. | Filtered pytest output omitted details for two of the 12 controlled failures. Complete patches, assertions and tracebacks support the final findings. |
| Sensitive command arguments, paths or output | Use a session with RTK hooks disabled and run the tool directly. | The Claude hook stored an excluded command argument in SQLite even with tracking disabled. An explicit `rtk proxy` invocation also stored its argument. |

These numbers are command-output bytes from the pinned v1.2.1 runs. Count any
direct rereads when evaluating a workflow. Full-cycle model token savings
remain unverified for this release. See the
[test matrix and privacy probe](token-providers-research/rtk/README.md#rtk-v121-follow-up).

## Earlier evidence from v0.48.0

The [v0.48.0 evaluation](token-providers-research/rtk/README.md#custody-and-method)
found useful output reduction alongside failures in exact diagnostics and local
persistence. The short configuration originally proposed in issue #138 also
failed to parse on v0.48.0. AIFHub lifecycle token savings, review parity and
subagent compatibility remain unverified.

The subsequent [ai-tester/Pi experiment](token-providers-research/rtk/ai-tester-ab.md)
used the requested Ornith model on three project snapshots. Baseline passed
12/12 checks versus 9/12 in the RTK group. Aggregate tokens fell 20.2%, but the
result was sensitive to one expensive baseline attempt and did not preserve
quality. Four incomplete attempts were retained separately and their pairs
repeated; temporary raw-artifact cleanup was blocked by automatic approval review.

The separate [multirepository experiment](token-providers-research/rtk/multirepo-ab.md)
completed 24 attempts on three related, labelled copies: baseline 11/12, RTK
12/12, and 15.8% fewer aggregate tokens. Diagnostic recovery cost 10.5% more
tokens; savings fell to 7.9% without the largest baseline pair. This is bounded
evidence and does not resolve the persistence failures above.

The [cross-project evidence/privacy matrix](token-providers-research/rtk/cross-project-ab.md)
ran five agent phases once per pair across six different projects (60 primary
runs): baseline passed 23/30 pairs versus 18/30 for RTK with 0.9% MORE tokens.
Protected artifacts survived the compressed read path byte-exact in 12/12 runs,
the synthetic secret never reached the local store, tee or `rtk gain` output,
and the sensitive command was never rewritten. The phase-by-stack split shows
where RTK helped (archaeology and diagnostics on large repositories: −28…−58%
tokens with quality preserved; ops checks: −19%) and where it did not (Flutter
snapshot +102…+173% across phases; small repositories +36…+268%; exact aggregate
counting during research fails in both arms). The RTK group produced malformed
final answers in 6 of its 12 failures. Cleanup of raw attempts remains blocked
by approval review.

Machine-readable decision, benefit and anti-scope metadata lives in
[recommendation-metadata.yaml](token-providers-research/recommendation-metadata.yaml)
(schema `aifhub.token_providers.recommendation.v1`). It is durable research
metadata: the extension runtime does not consume it, and it never gates or
installs anything.

> Use RTK to answer “what is happening?”; use raw commands to answer “show all evidence without loss.”

### Observed benefits and limitations

The v0.48.0 ai-tester series and probe measured benefits in these settings:

- **Overview and search on large repositories.** `rg`, `git log`, `git status`,
  `git diff --stat` in the cross-project matrix saved 24–58% tokens with quality
  preserved on the Unity (−28…−37% in diagnostics/archaeology), Python/TS
  monorepo (−29…−58%) and web-service (−24…−51%) snapshots. The single-project
  series measured −39.0% on a diff review; the multirepository series −24.8% on
  contract review and −41.8% on security review.
- **Ops and status checks.** The sensitive status/gain workflow cost 52% fewer
  tokens on the Laravel snapshot and 24% fewer on the web-service snapshot,
  with the synthetic secret never reaching the SQLite store, tee files or
  `rtk gain` output, and the credential-bearing command never rewritten.
- **Reading protected validation artifacts.** Compressed `rtk read` preserved
  `aif-gate-result`, `coverage.json`, `done-readiness.json` and OpenSpec
  markdown byte-exact in 12/12 matrix runs (and 5/5 probe reads). They remain
  on the direct-read list when used as evidence.
- **History and diff overview.** Use filtered output for the initial pass.
  `rtk proxy git diff` and `rtk proxy git log --stat -n 50` are examples of
  the full-output path for non-sensitive arguments.

Do not enable it for:

- **Small repositories** (+36…+268% tokens: nothing to compress, indirection
  overhead dominates);
- **stacks where compression misleads the model** — the Flutter snapshot cost
  +102…+173% across three phases because raw re-reads followed compressed views;
- **tasks requiring exact aggregate counts over long lists** (sums, per-file
  totals during research) — this failed in both arms and is a model limit, but
  RTK neither helps nor pays for it;
- **verification and fix runners** — use the raw test runner from the start
  (RTK's pytest filter dropped case names and tracebacks in the probe);
- **sensitive sessions** — see the storage blockers below; the matrix privacy
  result does not overturn the probe's findings about excluded-command logging
  and ineffective `[tracking]` settings in v0.48.0 and v1.2.1.

## Evidence must have a raw path

`rtk git status` and `rtk git diff` can provide an initial overview. Review,
verification, fix diagnosis and repository archaeology must use complete source
observations before reaching a conclusion. Missing information in compressed output
must not be interpreted as an absent defect, assertion, change or requirement.

These output bypasses were exercised on the pinned release:

```bash
rtk proxy git diff
rtk proxy git log --stat -n 50
rtk proxy git show <sha>
rtk proxy cat openspec/changes/<change-id>/specs/<capability>/spec.md
rtk proxy cat .ai-factory/qa/<change-id>/coverage.json
rtk proxy pytest --tb=long -q
```

`proxy` bypasses filtering **and still tracks command arguments**. For sensitive
arguments or paths, use a terminal/session without RTK hooks or RTK instructions.
Raw `git show <sha>` there preserves the full commit message, author, date and patch.
Credentials must never be passed to `rtk proxy` as a workaround for compression.

For non-sensitive evidence, `RTK_DISABLED=1 git diff` is a recognized rewrite bypass
in the tested release. It does not disable the hook's observation or logging. This
is shell command syntax for the tested Bash/Linux path; do not assume the same
rewriting contract for a PowerShell tool or another host adapter. Claude's built-in
`Read` bypasses the Bash hook, but the selected read still needs to cover the entire
artifact, without an unnoticed line limit.

Always read the following through a complete raw path:

- `openspec/changes/**` and `openspec/specs/**`, including fenced JSON and exact snippets;
- `.ai-factory/` validation artifacts, `aif-gate-result`, `coverage.json`,
  `done-readiness.json`, generated-rules traces and their referenced evidence;
- full patches and history used to establish scope, authorship, dates or intent;
- failing-test tracebacks, source lines, assertion operands and captured diagnostics.

Default `rtk read`/`cat` preserved the five tested artifacts, and their files were
unchanged. A bounded read omitted evidence; that default observation is not an
allowance to compress protected artifacts. RTK's pytest filter retained only 10 of
12 failing case names and did not preserve the traceback even with `--tb=long`.
Use the raw test runner from the start for `/aif-verify` and `/aif-fix`, including
cargo/go and other runners whose complete diagnostics have not been verified.
The extension does not install a fallback hook: normal AIFHub verification remains
raw, and an independently configured user hook must preserve that behavior.

## User-owned configuration for an experiment

AIFHub never installs RTK or runs its setup commands. Users independently review,
pin, install, update and remove it using [upstream installation
documentation](https://github.com/rtk-ai/rtk/blob/fde0a8f185945556f51718de0f4c430bb62b3df6/docs/guide/getting-started/installation.md).
Use a separate session without the RTK hook for sensitive commands on both tested
versions, including when hook exclusions are configured.

For a non-sensitive v0.48.0 experiment, this is a **complete, tested shape** for the relevant
tables in user-owned RTK `config.toml`. Manually merge the fields with the existing
configuration; do not overwrite unrelated settings. On the tested Linux host the
file is `$XDG_CONFIG_HOME/rtk/config.toml`, defaulting to `~/.config/rtk/config.toml`.
Other platform paths must be checked with `rtk config` locally; its output may
include private paths and must not be attached as evidence.

```toml
[hooks]
exclude_commands = [
  "curl", "mysql", "psql", "docker", "sshpass", "gh", "aws", "gcloud",
  "cat", "head", "tail", "rg", "grep",
  "git diff", "git log", "git show", "git blame",
  "pytest", "cargo", "go", "npm", "pnpm", "yarn", "bun",
  "vitest", "jest", "mocha", "playwright"
]

[tee]
enabled = false
mode = "never"
max_files = 20
max_file_size = 1048576

[telemetry]
enabled = false
```

Validate the merged configuration with `rtk config` before relying on exclusions.
In v0.48.0, a present `[tee]` table containing only `mode = "never"` is invalid;
the rewrite path falls back to defaults and can rewrite an excluded command.
Even a valid `mode = "never"` with `enabled = true` permits forced truncation
recovery files. `enabled = false` is essential. `RTK_TEE=0` is an additional tested
environment override. `RTK_TELEMETRY_DISABLED=1` disables telemetry regardless of
consent; telemetry is otherwise opt-in and disabled by default in this release.

For v1.2.1, the probe used `[retriever]` with `mode = "disabled"` to disable
recovery storage. The legacy `[tee] mode = "never"` form also suppressed
recovery in the tested configuration without a `[retriever]` table. Default
recovery stored pytest output in `recall.db`. These settings control output
recovery. Command tracking is a separate path.

Exclusions apply to rewriting, not to observation, redaction or permission checks.
Do not infer coverage for aliases, absolute executable paths, wrappers, nested
shells, compound commands, or a different host from a simple top-level probe.
Explicit `rtk ...` invocations also bypass the intent of hook exclusions. The Codex
awareness document instructs the agent to prefix shell commands with RTK; user
configuration must not let that instruction override AIFHub evidence requirements.

Never send command-line credentials through automatic RTK processing, including
`mysql -p...`, `curl -u user:password`, credential-bearing database URLs,
`docker login -p ...`, and cloud/repository CLI token arguments. Use the tool's
interactive prompt, stdin, credential helper, `.pgpass`-style file or secret store.
The extension neither generates nor manages these credentials. Secret-bearing
paths and output require the same care as explicit password arguments.

## Local storage and metrics

RTK can persist full `original_cmd`, `rtk_cmd`, project paths and hook command text
in SQLite. Our probe observed both proxy arguments and excluded Claude hook
arguments with a valid `[tracking] enabled = false` configuration in v0.48.0
and v1.2.1. Treat that setting as ineffective for those tested paths. Use a
session without RTK for sensitive arguments or output.

The v0.48.0 failure tee rotates files by count and size. It normally keeps up to
20 files of up to 1 MiB each. These limits give no deletion deadline. The tested
default data location on Linux is `~/.local/share/rtk/`, with `history.db` and
`tee/`. `RTK_DB_PATH`, `RTK_TEE_DIR`, XDG variables and configuration can
change it. Optional hook audit logs are another store. Hook uninstall removes integration files, not necessarily
these stores. Users own retention and cleanup: stop RTK activity, identify the
actual configured database/log locations, remove their RTK tracking and recovery
databases, SQLite sidecars, tee files and audit logs, and check backups/sync
copies. Verify removal of previously exposed data separately from rotation or
uninstall.

`rtk gain --history` exposed a synthetic argument fragment in the probe. Other
history, project, parse-failure or discovery views can include command text and
paths. AIFHub does not invoke, scrape, attach or inject `gain`/`discover` output into
`/aif-analyze`, plans, QA evidence, telemetry or final gate blocks. Only after an
explicit user request may a human-reviewed aggregate note report allowlisted
numbers such as period, command count and estimated input/output/saved tokens.
Omit arguments, paths, command labels, raw failure output and history rows. RTK's
token estimates are not measured model/session token usage.

## Integration and ownership boundaries

AIFHub does not bundle the binary, add a manifest/dependency, auto-configure or
repair hooks, modify runtime/agent/MCP files, prefer RTK in prompts, or add provider
selection/recommendation metadata. RTK availability and savings never satisfy or
block plan, implement, review, verify, security, done, archive or commit gates.
Missing or incompatible RTK is a normal supported state. Protected files and gate
output must never be rewritten or compressed in place.

The v0.48.0 Hermes installer writes `plugins/rtk-rewrite/__init__.py`,
`plugin.yaml` and `config.yaml` under `HERMES_HOME` (default `~/.hermes`), enabling
`rtk-rewrite` in `plugins.enabled`. Its adapter mutates `terminal` tool commands
through `rtk rewrite`. Fixture install/reinstall/uninstall preserved the unrelated
Hermes plugin and model setting.

On v0.48.0, Codex `rtk init -g --codex` writes `RTK.md` and edits `AGENTS.md`
under `CODEX_HOME` (default `~/.codex`). Project mode writes them in the project.
The Codex setup tested here uses those instruction files, and the fixture's
`config.toml` was unchanged. Claude's native installer uses a Bash `PreToolUse`
hook and can also write awareness instructions. These are user-owned surfaces even when their names
do not overlap AIFHub's managed agent files.

Hook inheritance for `aifhub-implement-worker`, `aifhub-verifier` and other delegated
agents is **unverified**. Native Claude hook payload tests do not prove live Claude
dispatch, and Hermes plugin installation does not prove that subagent terminal
payloads use it. Inspect actual host/runtime behavior before making coverage claims.
RTK's supported uninstall form is `rtk init ... --uninstall`, not `--undo`; the
exact Hermes and Codex forms are in the [evaluation](token-providers-research/rtk/README.md).

RTK, dcg and reasoning skills affect different parts of execution, but their hooks
and instructions can interact. Namespaced files do not prove compatibility or hook
ordering. An RTK bypass must never bypass a safety guard's denial or native approval.

See [Context Loading Policy](context-loading-policy.md), [Safety Providers](safety-providers.md)
and [Skill Providers](skill-providers.md). Promotion requires the evidence and privacy
conditions in the [RTK evaluation](token-providers-research/rtk/README.md).
