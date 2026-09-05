# RTK evaluation for issue #138

Decision: **`reject_defer`** for automatic integration or recommendation. RTK remains
user-owned optional infrastructure for explicit overview use. This evaluation
addresses [issue #138 and its added acceptance criteria](https://github.com/ichinya/aifhub-extension/issues/138)
with executable observation/privacy probes, source review and a separate
[live ai-tester/Pi A/B](ai-tester-ab.md). The bounded A/B used the requested
Ornith model on three project snapshots: baseline passed 12/12 checks and the
RTK group 9/12, with an unstable 20.2% aggregate token reduction. This does not
establish the proposed full AIFHub agent-chain A/B.

A separate [multirepository A/B](multirepo-ab.md) used three related snapshots
identified only by labels: baseline passed 11/12, RTK 12/12, with 15.8% fewer
aggregate tokens. All candidate attempts exercised RTK. Diagnostics required raw
recovery and cost 10.5% more tokens; removing the largest baseline pair reduced
aggregate savings to 7.9%. The bounded result does not clear the privacy blockers.

## Custody and method

Evaluated on 2026-09-05 against AIFHub base
`a560e3fcf6148d9e1663c51db188f6c1491a6477`, with no runtime integration changes.

| Item | Pin |
|---|---|
| RTK source | [`v0.48.0`, `fde0a8f185945556f51718de0f4c430bb62b3df6`](https://github.com/rtk-ai/rtk/tree/fde0a8f185945556f51718de0f4c430bb62b3df6) |
| License/package | Apache-2.0, Cargo package `0.48.0` |
| Executed release archive | `rtk-x86_64-unknown-linux-musl.tar.gz` |
| Archive SHA-256 | `e4e650fa1677c0de2f6839a6040d7b17f312d32f163c402b75af70e9e5af1a91` |
| Executed binary SHA-256 | `64c01578fec180a1b1f093e882bc8a673f0a3bf7ecf7094950fec6d897872e01` |
| Host | Debian under WSL2, Linux x86_64, Python 3.13.5, Git 2.47.3 |
| Test runner | pytest 8.4.2; complete dependency versions in [results.json](results.json) |
| Harness | [probe.py](probe.py); its SHA-256 is recorded in the result |
| Observation-probe model/runtime | None; the live Pi experiment is reported separately below |

The archive digest matched the release's [`checksums.txt`](https://github.com/rtk-ai/rtk/releases/tag/v0.48.0).
This checks artifact consistency, not an independent signature or a reproducible
source build. The Windows archive was also downloaded and checksum-verified
(`8c9ae56bacde865112777a9fe9791b449186d8b2a081c32c0772ef773f284f93`), but no Windows
runtime compatibility result was claimed by that initial probe. The separate
[Windows Pi experiment](ai-tester-ab.md) subsequently executed this Windows release.

Context7 resolved `/rtk-ai/rtk` and supplied current documentation. Its pages point
to floating `develop`; conclusions below instead use the exact release source and
executed binary. Several older README/adapter descriptions differ from the pinned
implementation, so documentation alone was not treated as runtime evidence.

The probe creates a fresh synthetic Git project and child-only HOME, XDG, Hermes,
Codex and Claude directories. It clears inherited credentials/configuration,
disables telemetry and external pytest plugins, uses a dedicated SQLite database,
executes no sensitive command strings (only rewrite/hook payload decisions), and
deletes the entire disposable tree. Random synthetic markers test storage exposure.
Only counts, booleans, public versions/digests and fixed relative installer filenames
survive. No transcripts, marker values, raw outputs, database contents or private
paths are retained. The harness performs no downloads or installations.

## Results

The machine-readable record is [results.json](results.json). Byte counts describe
this fixture only; they are not tokenizer measurements or total session savings.

| Check | Observed outcome | Implication |
|---|---|---|
| Protected spec/gate/coverage/readiness/trace reads | Default `read` and raw proxy preserved 5/5 exact byte sequences; all five files unchanged | Narrow default-path PASS; line-limited reads still omit evidence |
| Git diff | 4,261 raw bytes versus 1,471 compressed; raw proxy exact | Useful overview, incomplete patch |
| Git show | 7,632 raw bytes versus 6,164 compressed; raw proxy exact | Full historical patch requires raw evidence |
| Git log | Default compact log loses full history; the tested `--stat -n 50` path passes through exactly | Do not generalize one flag combination to all log output |
| Real failing pytest | All arms exit 1; compressed path retains only 10/12 case names and loses exact traceback context | Raw verification/fix input required, including when `--tb=long` is supplied |
| Proxy pytest | Failure section equals the raw runner's failure section | Exact diagnostic bypass works in this fixture; volatile timing summary excluded from equality |
| Proxy streams | Both 1,100,001-byte streams, including non-UTF-8 bytes, and exit 7 preserved | Tracking's 1 MiB capture cap does not truncate delivered streams in this case |
| Complete config exclusions | 8/8 sensitive and 8/8 evidence command probes skip rewriting; git status still rewrites | Exclusions are usable for the tested top-level forms |
| Issue's partial TOML | `rtk config` rejects it; rewrite falls back to defaults and rewrites excluded curl | Must validate full configuration before relying on it |
| Tee `mode = "never"`, enabled | A forced pytest truncation-recovery file is still created | Mode alone is insufficient |
| Tee disabled | `enabled = false` and separate `RTK_TEE=0` probe each produce zero tee files | Tested controls for disabling recovery output |
| Tee failures mode | Sensitive synthetic captured stdout is persisted | Logs require explicit user-owned retention/cleanup |
| Tracking disabled | Proxy arguments and an excluded native Claude-hook command still reach SQLite | Exclusions and `tracking.enabled` do not provide a privacy boundary |
| Gain history | A synthetic command-argument fragment appears in history | Do not publish raw metrics/history output |
| Hermes lifecycle | Install/reinstall/uninstall exit 0; config is idempotent and fixture config restored | File-level lifecycle PASS only |
| Codex lifecycle | Instructions injected; unrelated guidance and config preserved across install/uninstall | File-level coexistence, with instruction precedence risk |
| Protected file integrity / cleanup | All original protected fixture bytes preserved; temporary tree removed | PASS for this bounded probe |
| Live host/subagent inheritance | `NOT_RUN` | No claim about delegated worker/verifier hook coverage |
| Bounded ai-tester/Pi A/B | [Executed: 24 completed observations, four incomplete original attempts retained](ai-tester-ab.md) | 12/12 baseline versus 9/12 RTK; lower aggregate tokens did not preserve quality |
| Full OpenSpec agent-chain A/B | `NOT_RUN(observation_and_privacy_gates_failed)` | No full-chain token, gate-parity or fix-cycle result |

The harness was rerun after finalization to check stable semantic observations.
Pytest timing-byte counts and tee filenames/rotation counts can vary; they are not
the acceptance oracle. Executable smoke success means the probe ran, not that RTK
passed the adoption criteria.

Repository checks: `npm run validate` passed. `npm test` recorded 1,154/1,155
passes, with the unchanged Ponytail partial-output timeout test capturing no output
before its one-second timeout; that file's retry also failed. The individual test then
passed in both a clean base archive and this checkout. This is recorded as a
timing-sensitive suite failure with a successful isolated retry, not a full-suite PASS.

## Source audit and installer mechanics

All links in this table are bound to the evaluated commit.

| Source | Finding |
|---|---|
| [read.rs](https://github.com/rtk-ai/rtk/blob/fde0a8f185945556f51718de0f4c430bb62b3df6/src/cmds/system/read.rs), [main.rs](https://github.com/rtk-ai/rtk/blob/fde0a8f185945556f51718de0f4c430bb62b3df6/src/main.rs) | `read` defaults to filter `none`; filtering/windows are configurable. Proxy streams raw stdout/stderr and subsequently tracks joined arguments. |
| [pytest_cmd.rs](https://github.com/rtk-ai/rtk/blob/fde0a8f185945556f51718de0f4c430bb62b3df6/src/cmds/python/pytest_cmd.rs) | Injects `--tb=short` unless provided, selects at most three relevant lines per failure, truncates lines and caps failure entries. Explicit long traceback does not disable the output filter. |
| [config.rs](https://github.com/rtk-ai/rtk/blob/fde0a8f185945556f51718de0f4c430bb62b3df6/src/core/config.rs) | Present tee/tracking tables require their non-optional fields. Cached rewrite configuration uses defaults on load failure. |
| [tee.rs](https://github.com/rtk-ai/rtk/blob/fde0a8f185945556f51718de0f4c430bb62b3df6/src/core/tee.rs) | Normal failure tee and forced recovery differ: `force_tee_path` checks enabled/env override, not mode. Default rotation is 20 files, 1 MiB each. |
| [tracking.rs](https://github.com/rtk-ai/rtk/blob/fde0a8f185945556f51718de0f4c430bb62b3df6/src/core/tracking.rs), [hook_cmd.rs](https://github.com/rtk-ai/rtk/blob/fde0a8f185945556f51718de0f4c430bb62b3df6/src/hooks/hook_cmd.rs) | Command and hook-decision tables store command text; native Claude Skip and Rewrite paths both log when session/tool-use IDs exist. Optional audit logs are additional persistence. |
| [gain.rs](https://github.com/rtk-ai/rtk/blob/fde0a8f185945556f51718de0f4c430bb62b3df6/src/analytics/gain.rs) | History prints truncated command labels; truncation is not redaction. Some views inspect Claude session history. |
| [telemetry.rs](https://github.com/rtk-ai/rtk/blob/fde0a8f185945556f51718de0f4c430bb62b3df6/src/core/telemetry.rs), [README](https://github.com/rtk-ai/rtk/blob/fde0a8f185945556f51718de0f4c430bb62b3df6/README.md) | Telemetry exists, disabled by default with explicit consent and environment opt-out. The issue's no-telemetry assumption is outdated for this pin. |
| [init.rs](https://github.com/rtk-ai/rtk/blob/fde0a8f185945556f51718de0f4c430bb62b3df6/src/hooks/init.rs) | Hermes writes two plugin files and patches `config.yaml`; Codex writes `RTK.md` and patches `AGENTS.md`; Claude supports hook plus awareness setup. None of these is owned by AIFHub. |
| [Hermes adapter](https://github.com/rtk-ai/rtk/blob/fde0a8f185945556f51718de0f4c430bb62b3df6/hooks/hermes/rtk-rewrite/__init__.py), [Codex awareness](https://github.com/rtk-ai/rtk/blob/fde0a8f185945556f51718de0f4c430bb62b3df6/hooks/codex/rtk-awareness.md) | Hermes delegates terminal mutation to `rtk rewrite`; Codex instructions prefer RTK for shell commands. Adapter installation does not prove host/subagent dispatch. |

The probe exercised these commands only inside disposable runtime homes:

```bash
rtk init -g --agent hermes
rtk init -g --agent hermes --uninstall
rtk init -g --codex
rtk init -g --codex --uninstall
```

Hermes installation produces `config.yaml`, `plugins/rtk-rewrite/__init__.py` and
`plugins/rtk-rewrite/plugin.yaml`. Codex installation produces/patches `AGENTS.md`
and `RTK.md`; a pre-existing fixture `config.toml` remained unchanged. These checks
do not assert that uninstall restores arbitrary prior formatting, deletes user
tracking stores, or preserves a pre-existing user-owned `RTK.md`.

## Reproduce

In a separate Linux environment, manually obtain the exact release asset and check
the archive and extracted binary hashes above. Independently create an isolated
Python environment with `pytest==8.4.2`, `pluggy==1.6.0`, `packaging==26.3`,
`iniconfig==2.3.0` and `pygments==2.21.0`; no extension dependencies are added.
Then run the harness from that environment:

```bash
python docs/token-providers-research/rtk/probe.py --rtk /absolute/path/to/rtk
```

The binary path is supplied explicitly; the harness rejects a different binary
digest or pytest version. It emits aggregate JSON on stdout and a generic error
on failure. A failed/incomplete probe is not evidence of a provider result. The
script is manual research tooling, absent from package scripts, normal commands,
CI and extension installation. Do not execute it against a private project or
replace its generated fixtures with sensitive input.

## Remaining promotion requirements

The full chain experiment remains deferred because observation and privacy
preflight failed. The user's explicitly requested bounded model experiment ran
separately and did not meet its quality criterion. To revisit promotion:

1. Pin a successor RTK release and recheck complete config parsing, effective
   tracking disable/redaction, excluded hook-command persistence, tee disable and
   privacy of every proposed metric. Keep secrets and protected reads out of RTK.
2. Verify actual Hermes/Claude/Codex host dispatch and delegated worker/verifier
   coverage, built-in read bypasses, safety-guard ordering and instruction precedence.
3. Pre-register paired raw and RTK-overview-plus-raw-evidence arms on fresh copies
   of the same real OpenSpec change and project commit. Pin AIFHub/runtime/model,
   reasoning settings, permissions and inputs; use at least four repetitions per
   arm for a normal change and a change with seeded correctness/security defects.
4. Run the same `/aif-plan -> /aif-implement -> /aif-verify -> /aif-fix` lifecycle
   and review checks. Use independent hidden graders for known defects and exact
   evidence anchors. Compare measured total model/context tokens, latency, verify
   pass rate, fix cycles, finding identity/severity, diagnostic completeness and
   source/line/patch/history coverage. Reduced findings alone is not improvement.
5. Require every protected artifact and exact diagnostic to remain available,
   no new missed material finding, no privacy leak, no worse required-gate outcomes,
   and a stable measured reduction including the cost of raw rereads. Persist only
   sanitized aggregates; retain neither agent transcripts nor local RTK stores.

The [provider policy](../../token-providers.md) covers optional ownership, raw
bypasses, sensitive commands, tee controls, retention and metrics. The added issue
criteria are documented and locally probed; live host parity and the real-chain
A/B remain explicitly unrun. Promotion requires new evidence.
