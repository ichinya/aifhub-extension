[Documentation](README.md) | [Evaluation evidence](token-providers-research/rtk/README.md)

# Token Providers

Token providers reduce command output before it reaches an agent. They are optional,
user-installed infrastructure. A smaller observation is not necessarily complete
evidence: deterministic filters can remove assertions, patches and historical facts.

## RTK decision

[`rtk-ai/rtk`](https://github.com/rtk-ai/rtk) **v0.48.0** is `reject_defer` for an
AIFHub recommendation or automatic integration. Explicit, user-owned overview use
remains possible. This is not a claim of universal safety or a security PASS.

The [pinned evaluation](token-providers-research/rtk/README.md) found useful output
reduction, but failed exact diagnostic and local persistence checks. In particular,
excluded commands can still be logged by the Claude hook, and the documented
tracking-disable setting did not prevent command storage in this release. The
proposed short configuration in issue #138 also fails to parse on this version.
No AIFHub lifecycle token benefit, review parity or subagent compatibility is claimed.

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

> Use RTK to answer “what is happening?”; use raw commands to answer “show all evidence without loss.”

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
Always-on RTK use in sensitive sessions is not recommended for v0.48.0, even with
the exclusions below. Use a separate session without the RTK hook for those commands.

For a non-sensitive experiment, this is a **complete, tested shape** for the relevant
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
arguments with a valid `[tracking] enabled = false` configuration. Treat that
setting as ineffective for these tested paths in v0.48.0. A raw-output bypass is
not a privacy bypass.

Failure tee normally keeps up to 20 files of up to 1 MiB each; these are rotation
limits, not a time-based deletion guarantee. The tested default data location on
Linux is `~/.local/share/rtk/`, with `history.db` and `tee/`; `RTK_DB_PATH`,
`RTK_TEE_DIR`, XDG variables and configuration can change it. Optional hook audit
logs are another store. Hook uninstall removes integration files, not necessarily
these stores. Users own retention and cleanup: stop RTK activity, identify the
actual configured database/log locations, remove their RTK database and any SQLite
sidecars, tee files and audit logs, and check backups/sync copies. Rotation or
uninstall is not proof that a previously exposed credential has disappeared.

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

The evaluated Hermes installer writes `plugins/rtk-rewrite/__init__.py`,
`plugin.yaml` and `config.yaml` under `HERMES_HOME` (default `~/.hermes`), enabling
`rtk-rewrite` in `plugins.enabled`. Its adapter mutates `terminal` tool commands
through `rtk rewrite`. Fixture install/reinstall/uninstall preserved the unrelated
Hermes plugin and model setting.

Codex `rtk init -g --codex` writes `RTK.md` and edits `AGENTS.md` under `CODEX_HOME`
(default `~/.codex`); project mode writes them in the project. This is instruction
injection, not a programmatic Bash hook. The fixture's Codex `config.toml` was
unchanged. Claude's native installer uses a Bash `PreToolUse` hook and can also
write awareness instructions. These are user-owned surfaces even when their names
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
