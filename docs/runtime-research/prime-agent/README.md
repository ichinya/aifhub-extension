[Back to Documentation](../../README.md)

# Prime Agent runtime evaluation — issue #148

Decision: **defer supported-runtime adoption**. Prime Agent is a complete agent
runtime, distinct from the optional providers in issues #135, #137, #138 and #147.
Its programmatic kernel and retained children are useful building blocks, but the
reviewed release does not establish the immutable AIFHub role and permission
boundaries required by [issue #148](https://github.com/ichinya/aifhub-extension/issues/148).

This is research with executable source/kernel probes, not a supported-runtime
guide. It adds no `runtime: "prime-agent"`, agent files, dependencies, installer,
hooks, daemon startup, MCP registration or AIFHub lifecycle behavior. The existing
Claude/Codex targets remain the supported managed-agent surfaces.

The subsequent [bounded AIFHub adaptation](../../workflow-mechanics.md) implements
local checkpoints, parent result acceptance, fix attempt bookkeeping, and
skill-context transactions. That separate change does not promote Prime Agent
to a supported runtime or widen the source/kernel evidence below.

## Evidence identity and limits

Evaluated on 2026-09-05:

| Surface | Pinned identity / observation |
|---|---|
| AIFHub local HEAD and live `origin/main` | `a560e3fcf6148d9e1663c51db188f6c1491a6477` |
| Prime Agent latest published stable release | [`v0.9.1`](https://github.com/PrimeIntellect-ai/prime-agent/releases/tag/v0.9.1), published 2026-09-01, tag and release target `81ae3cb34d27d38ee37f9e205a1e73694993b344` |
| Prime Agent live main | `5c2750bdc3c99cc4225c1167a3484371a7a221ab`; no diff from the release for the refinement module, autonomous module, RLM runtime documentation or skills documentation inspected here |
| AI Factory live `2.x` source | [`3c1ddd4740d7b1c30d8ecb3dc80fa5e7b8d7ef5a`](https://github.com/lee-to/ai-factory/commit/3c1ddd4740d7b1c30d8ecb3dc80fa5e7b8d7ef5a), package `2.19.0`; source review, not an installer smoke |
| Execution | Windows Node `24.13.0` for isolated TypeScript functions; Debian WSL, Python `3.13.5`, Linux x86_64 for the actual kernel |
| Model / provider / cost | None: zero inference requests and zero real child agents |
| Issue / related PR | Issue open with zero comments; no matching Prime Agent PR found at evaluation time |

[Observed probe results](results.json) contain source hashes and 27 verified
observations. `observation_verified: true` means the described behavior was
reproduced; **it does not mean the runtime passed adoption criteria**.

The TypeScript probe loads the exact upstream Git blob, removes types and stubs
unused application imports with functions that throw if called. CRUD, persistence,
prompt formatting, conflict checking and rollback planning are upstream code.
It does not run the model-facing `/refine` command or its `AgentSession` orchestration.

The Python probe starts the real `python -m rlm.repl` process from the clean pinned
source. It exercises persistent state, filesystem/subprocess access, harness CRUD
and shutdown. Its one `rlm()` bridge request receives a synthetic host reply:
no TypeScript host, daemon, real child session or model executes. Fixture writes,
including writes outside `cwd`, stay within one disposable temporary directory.
The kernel and temporary fixtures are cleaned up by the probe.

## Corrections to the issue's starting assumptions

1. **Delegation returns admission, not the answer.** In this release,
   `await rlm(...)` returns `RLMSpawnHandle` with `rlm_child_id`, `name`,
   `session_dir` and `model`. Child results arrive later via explicit
   `agent_message` replies or files. The README's broad programmatic-result
   description is insufficient for an adapter contract. See the pinned
   [RLM runtime documentation][rlm-runtime] and [Python bridge][python-api].
2. **Python is optional for skills.** Ordinary Agent Skills `SKILL.md` packages
   are supported. A Python-backed skill additionally needs `pyproject.toml` and
   `src/<import_name>/__init__.py`. A bare `.py` file is not the documented skill
   package or a managed, immutable subagent definition. See [skills][skills].
3. **A harness subagent entry is editable descriptive state.** It does not create
   a separate protected execution policy. Putting a verifier into global harness
   state does not make it an immutable base entry. See [refinement][refinement].
4. **Session-local is durable.** Local refinement persists under the session's
   artifact directory and can survive detach/restart. It is not merely an
   in-memory counterpart to `/aif-evolve`. See [runtime state][rlm-runtime].

The [RLM article](https://www.primeintellect.ai/blog/rlm) explains externalized
context and programmatic delegation; its experimental scaffolds do not specify
the current Prime Agent API. The [Continual Harness paper, v1, sections 2–3](https://arxiv.org/html/2605.09998v1)
describes online edits to prompts, subagents, skills and memories in embodied-agent
experiments. It is motivation, not evidence of coding-runtime permissions or an
AIFHub compatibility result. The implementation below determines those claims.

## Answers to the eight evaluation questions

| # | Question | Evidence and decision |
|---|---|---|
| 1 | Runtime precedence / immutable roles | The refiner rejects the reserved `prompt:base_system_prompt` identity. Arbitrary supplemental `prompt` and `subagent` entries remain editable and deletable in both scopes. The probe demonstrates that invented `immutable` / `readOnly` metadata is not an enforcement mechanism. Defer until a protected role source and prompt precedence are designed and tested. |
| 2 | Worker authoring format | Use a reviewed Markdown role as source material, optionally exposed through a complete Python-backed skill package. Harness subagent entries describe delegation; `rlm()` takes a task prompt plus `name`, `model`, `thinking`, not a `.py` role path or permission policy. An authoring prototype would need role loading, admission/result correlation and artifact validation; renaming the Claude file is insufficient. |
| 3 | Quality gates | Prime autonomous gates execute configured shell commands and consider exit 0 without error/timeout successful. They control continuation. They do not parse AIFHub gate evidence or implement its freshness/ownership rules. AIFHub `/aif-verify` remains authoritative; autonomous success or a spent budget cannot authorize `/aif-done`. |
| 4 | Handoff and messaging | Messages can steer active work. Admission/delivery receipts are not completion or QA evidence. A parent adapter must validate sender/task/change identity and re-read the current Handoff summary after a result. No message may advance lifecycle state or bypass the summary. This adapter does not exist in this change. |
| 5 | Background ownership | Prime's resident worker owns the queue, kernel, schedules and descendants after UI detach. AIFHub still owns change-stage transitions and finalization. Proposed adoption requires one designated parent for a pinned change, explicit run budgets and stop/recovery policy, and current evidence before finalization. Detach must not expand scope or grant commit/push permission. |
| 6 | `/aif-evolve` versus `/refine` | AIFHub evolution writes its own skill-context/evolution artifacts. `/refine` writes Prime harness state. Neither store automatically overwrites the other. Any export must be a separately requested, reviewable operation with source revision, destination scope and rollback history; it must exclude protected AIFHub roles and QA verdicts. No exporter is added. |
| 7 | Subagent trust / dcg | Child creation inherits active and allowed tool names and parent resources, but allowing `ipython` still exposes arbitrary Python and subprocesses with worker OS permissions. `rlm()` has no per-call read-only/sandbox option in this release. The real kernel probe reproduces access outside `cwd`. A guard on shell text alone cannot constrain direct Python file writes. No dcg coverage or Claude/Codex permission parity is claimed. |
| 8 | Distribution / detection | Prime discovers project/global skills in its own and `.agents/skills` locations. That does not consume AIFHub's Claude/Codex managed agent directories. AI Factory supports extension-defined runtimes, but managed agent extensions are restricted to `.md` / `.toml`; AIFHub additionally rejects unknown runtime IDs. A `.py` `agentFiles` entry therefore fails current contracts. Discovery, publishing, update/removal and role loading need a reviewed consumer path. |

### Harness findings and precedence

The [refinement validator and apply function][refinement] protect the one reserved
base-prompt identifier, check edit shape and reject a concurrent edit when the
captured baseline differs. They do not define a third-party immutable-entry flag.
The probe creates synthetic AIFHub-named roles, updates and deletes them, and
round-trips the result through the actual JSON persistence functions. Rollback
restores prior content; it is recovery after a change, not prevention.

When global and local entries share an ID, `mergeHarnessStates()` keeps both,
giving the local map key a scope prefix. The probe confirms that both conflicting
prompt contents reach supplemental prompt text. It does not claim which instruction
a model would follow. Global placement alone is therefore insufficient evidence
for AIFHub policy precedence.

The actual [session apply path][session] re-reads the requested scope, applies the
proposal, saves `harness_state.json`, records global history in `refinements.jsonl`
when applicable, appends a session audit entry and rebuilds the prompt. Local state
is `<session-artifact-dir>/harness/harness_state.json`; global state defaults to
`~/.prime/agent/harness/harness_state.json`.

The [resource loader][loader] also supports `SYSTEM.md`, `APPEND_SYSTEM.md` and
custom prompt overrides. These are potential authoring surfaces outside refinement
CRUD, but mutable files/custom prompts do not prove read-only OS enforcement or
an immutable per-role contract. Adoption would need protected storage, integrity
checks, conflict rejection and enforcement outside model-authored Python.

### Gate and lifecycle mapping required before adoption

[Autonomous gates][autonomous] are command execution, potentially with writes.
Keep their scheduling decision separate from the
[AIFHub Handoff Validation Profile](../../handoff-validation-profile.md):

| Runtime observation | AIFHub interpretation |
|---|---|
| Spawn handle / delivered message / child marked completed | Supporting execution state only; re-read and validate owned artifacts. |
| Autonomous command passed | That command passed; no implicit review, security, coverage or verify verdict. |
| Autonomous retries, turns, tokens or time exhausted | Stop/blocked runtime state; no completion claim. |
| Handoff summary exit 0 | Nonblocking summary for its requested stage; route through its exact public `suggested_next`. |
| Handoff summary exit 1 | Blocking evidence; remain under the owning fix/sync/gate command. |
| Handoff summary exit 2, invalid JSON, missing or mismatched change | Adapter failure; stop progression. |
| Finalization requested | `/aif-done` rechecks its own current readiness and archive contract. |

The string `suggested_next` in the summary is distinct from the object-or-null field
in `aif-gate-result`. Gate statuses are lowercase; passing gate blocks retain
`suggested_next: null`. Existing required-evidence, stale-generated-rules and
invalid-latest-block semantics must be preserved. Do not shell-evaluate child
messages or a purported next-command string as unrestricted automation.

[Background documentation][background] confirms detach leaves the resident worker
running and messaging can steer or queue work. A future adapter needs to correlate
late/duplicate replies, reject results for an old revision, prevent competing
parents from finalizing the same change, and cancel or pause scheduled re-entry
when its authorization ends. `/aif-done` owns finalization, `/aif-commit` owns git
commits, and neither is implied by a Prime goal being marked complete.

### Permission and distribution blockers

The [child runtime options][session] copy `allowedToolNames`; this review does not
claim Prime lacks all tool filtering. However, the default model tool is a Python
execution surface. Prime [extension hooks][extensions] can block a model tool call,
but a successful hook on the whole Python cell does not establish interception of
every filesystem operation, imported function or nested subprocess. The kernel
probe runs without such an extension and establishes the default OS-access
behavior only. A real dcg adapter and its adversarial coverage remain untested.

Compare the actual AIFHub baselines: the
[Codex review sidecar](../../../agent-files/codex/aifhub-review-sidecar.toml)
declares `sandbox_mode = "read-only"`; the
[Claude review sidecar](../../../agent-files/claude/aifhub-review-sidecar.md)
declares a read-only tool set. A Prime role prompt saying “read-only” is not an
equivalent runtime boundary. Required mitigation is an externally enforced
filesystem/process/network policy or a runtime adapter with demonstrated parity,
including protection from direct Python writes. Merely installing dcg is not that
proof. Its [existing AIFHub policy](../../safety-providers.md) remains user-owned.

Prime skill discovery includes `.prime/agent/skills/`, `~/.prime/agent/skills/`,
project ancestor `.agents/skills/`, `~/.agents/skills/`, configured packages and
explicit skill paths. Built-in skills have the lowest precedence. None of these
paths establishes automatic loading of immutable AIFHub worker roles.

AI Factory's [extension schema][aif-schema] and [runtime validation][aif-extensions]
allow extension-defined `agents`, with paired `agentsDir` / `agentFileExtension`
and only `.md` / `.toml` extensions. Its [asset validation][aif-ops] rejects unknown
runtimes and mismatched file extensions. AIFHub's
[own validator](../../../scripts/validate-extension.mjs) accepts only `codex` and
`claude`. Thus a custom Markdown runtime may fit an existing upstream extension
mechanism after design and consumer validation; a Python managed-agent extension
would require upstream format support as well. No speculative `agentsDir`,
automatic runtime detection or private-harness JSON installer is prescribed here.

## Evaluation stop and remaining experiments

The hard requirements on immutable role policy and permission parity are not met
by the proposed supplemental-entry approach. Stop adoption work at this negative
feasibility result. A successful coding demo would not remove those blockers.

| Proposed issue step | Actual status |
|---|---|
| Read RLM / Continual Harness references | Reviewed, with implementation/API distinctions above. |
| Install and run a trivial full session; inspect `/refine` | **NOT_RUN(full_cli_session_and_model_refine)**. Instead ran the actual source kernel and isolated refinement operations. No global install, auth setup or daemon. |
| Author and execute an AIFHub worker package | **NOT_RUN(protected_role_contract_missing)**. Authoring surfaces assessed; no loadable worker shipped. |
| Plan → implement → verify → done; regression-first fix; evolve/refine | **NOT_RUN(runtime_adoption_blocked)**. No AIFHub lifecycle parity or benchmark claim. |
| Test real child permissions and dcg interception | Default kernel access reproduced; **NOT_RUN(real_child_and_dcg_adapter)**. |
| Publish `docs/prime-agent-runtime.md` as a runtime guide | Deferred. This research page records the negative decision instead. |

Reopen adoption after a concrete protected-role and enforced-permission design.
Then pin the runtime, AI Factory, AIFHub, model/provider and a clean disposable
OpenSpec project before executing this matrix:

| Experiment | Required evidence |
|---|---|
| Role integrity | Hash protected role sources before/after local/global `/refine`, direct kernel CRUD, restart and rollback; reject conflicting policy overrides. |
| Read-only child | Deny harmless write markers through Python file APIs, imported helpers, shell and subprocesses outside the assigned write scope; compare equivalent Claude/Codex roles. |
| Worker/result correlation | Execute one bounded task; distinguish admission, completion, error, timeout, duplicate reply and wrong-change reply; no worker-authored verifier verdict. |
| Gate disagreement | Runtime pass with missing/stale/failing AIFHub evidence must not progress; test malformed latest block and stage-specific requirements. |
| Full lifecycle | Real plan/implement/verify/done artifacts and coverage; one seeded defect with regression failure before fix and the identical check after it. |
| Background recovery | Detach, restart, cancel, budget exhaustion and stale late reply; one owner, no surprise archive/commit, and no orphan scheduled work. |
| Evolution/export | `/aif-evolve` changes only AIFHub-owned evolution artifacts; explicit export cannot mutate protected roles or write QA evidence. |
| Installer lifecycle | Exact published consumer add/update/remove preserves user files and publishes only documented formats/paths without installing or starting Prime Agent. |

Keep runtime identities, aggregate outcomes, cost/latency and artifact digests.
Do not commit credentials, transcripts, private paths, raw model output or hostile
fixture contents. Prepared scenarios are not executed results.

## Reproduce the completed probes

Use a disposable checkout of the pinned release. These commands fetch source only:

```sh
git clone --depth 1 --branch v0.9.1 https://github.com/PrimeIntellect-ai/prime-agent.git prime-agent-eval
git -C prime-agent-eval rev-parse HEAD
node docs/runtime-research/prime-agent/refinement-probe.mjs /absolute/path/prime-agent-eval
python3 docs/runtime-research/prime-agent/kernel-probe.py /absolute/path/prime-agent-eval
```

Require Node 24.13+ for the standalone type-stripping research probe and Python
3.11+ on Linux for the kernel probe. The Node requirement is not an AIFHub runtime
requirement and these probes are not part of `npm test`. On Windows, run the
Python command through a Linux/WSL path. No pip/npm dependency install is needed.
Both probes print aggregate JSON; nonzero exit means the observation was not
verified. Both were repeated with identical aggregate results.

Local repository checks also passed on Node `24.13.0`: `npm run validate` and
`npm test` (1,155 tests, 159 suites, zero failures/skips). These are local checks,
not published CI, full Prime Agent tests or an AIFHub lifecycle run on Prime Agent.

## Pinned implementation references

[refinement]: https://github.com/PrimeIntellect-ai/prime-agent/blob/81ae3cb34d27d38ee37f9e205a1e73694993b344/packages/coding-agent/src/core/refinement/refinement.ts
[rlm-runtime]: https://github.com/PrimeIntellect-ai/prime-agent/blob/81ae3cb34d27d38ee37f9e205a1e73694993b344/packages/coding-agent/docs/rlm-runtime.md
[python-api]: https://github.com/PrimeIntellect-ai/prime-agent/blob/81ae3cb34d27d38ee37f9e205a1e73694993b344/prime-agent-runtime/src/rlm/__init__.py
[skills]: https://github.com/PrimeIntellect-ai/prime-agent/blob/81ae3cb34d27d38ee37f9e205a1e73694993b344/packages/coding-agent/docs/skills.md
[session]: https://github.com/PrimeIntellect-ai/prime-agent/blob/81ae3cb34d27d38ee37f9e205a1e73694993b344/packages/coding-agent/src/core/agent-session.ts
[loader]: https://github.com/PrimeIntellect-ai/prime-agent/blob/81ae3cb34d27d38ee37f9e205a1e73694993b344/packages/coding-agent/src/core/resource-loader.ts
[autonomous]: https://github.com/PrimeIntellect-ai/prime-agent/blob/81ae3cb34d27d38ee37f9e205a1e73694993b344/packages/coding-agent/src/core/autonomous.ts
[background]: https://github.com/PrimeIntellect-ai/prime-agent/blob/81ae3cb34d27d38ee37f9e205a1e73694993b344/packages/coding-agent/docs/long-running-agents.md
[extensions]: https://github.com/PrimeIntellect-ai/prime-agent/blob/81ae3cb34d27d38ee37f9e205a1e73694993b344/packages/coding-agent/docs/extensions.md
[aif-schema]: https://github.com/lee-to/ai-factory/blob/3c1ddd4740d7b1c30d8ecb3dc80fa5e7b8d7ef5a/schemas/extension.schema.json
[aif-extensions]: https://github.com/lee-to/ai-factory/blob/3c1ddd4740d7b1c30d8ecb3dc80fa5e7b8d7ef5a/src/core/extensions.ts
[aif-ops]: https://github.com/lee-to/ai-factory/blob/3c1ddd4740d7b1c30d8ecb3dc80fa5e7b8d7ef5a/src/core/extension-ops.ts
