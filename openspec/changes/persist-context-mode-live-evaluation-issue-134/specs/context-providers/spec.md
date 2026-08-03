# Delta for Context Providers

## ADDED Requirements

### Requirement: Explicit context-mode live authorization remains test-only and fail-closed

The system MUST require a complete bounded authorization envelope before executing previously unavailable context-mode provider rows and MUST preserve fail-closed defaults outside that isolated evaluation.

#### Scenario: Missing authorization preserves historical gates

- GIVEN a context-mode three-way matrix is generated without live authorization
- WHEN execution gates are assigned
- THEN baseline is `PASS(baseline_ready)`
- AND MCP-only remains `BLOCKED(runtime_dependency_self_install)`
- AND actual plugin remains `NOT_RUN(auth_isolation_unavailable)`
- AND no provider dependency, auth material, plugin or hook is used.

#### Scenario: Complete authorization unlocks only the isolated pinned evaluation

- GIVEN exact `v1.0.169` provenance and an authorization envelope for `isolated_evaluation`
- AND the envelope identifies a `prepared_pinned_snapshot`, approved runtime bootstrap, `scoped_ephemeral` authentication and native Codex
- WHEN gates are assigned
- THEN MCP-only and plugin rows may become `PASS(explicit_isolated_authorization)`
- AND all existing static, sandbox, host-manifest, privacy, purge and cleanup checks remain mandatory
- AND the authorization contains no user identity, credential, auth fingerprint, environment value or path
- AND normal AIFHub commands remain unable to install, register, trust or select context-mode.

#### Scenario: Actual plugin requires a native executable

- GIVEN actual Codex plugin lifecycle uses `shell: false`
- WHEN the selected Codex command is relative or a Windows `.cmd`/`.bat` shim
- THEN lifecycle is `NOT_RUN(native_codex_executable_required)`
- AND no marketplace or plugin state is mutated
- AND only an explicit native executable can count toward live provenance.

### Requirement: Live value evidence joins ai-tester results with raw Codex provider audit

The system MUST combine outer `ai-tester` correctness and cost evidence with a separate sanitized audit of isolated raw Codex rollout records before a provider row can pass.

#### Scenario: Large-output scenario crosses the truncation boundary

- GIVEN `large_generated_output_retrieval` is rendered
- WHEN its synthetic fixture is generated
- THEN command output exceeds 1 MiB and required facts occur after the truncation boundary
- AND all variants use the same deterministic fixture profile and expected facts
- AND large raw content is absent from catalog metadata, matrix JSON and durable evidence
- AND evaluation-only bounded `ctx_batch_execute` use does not authorize that tool for normal AIFHub commands.

#### Scenario: Quoted baseline command remains observable

- GIVEN Codex invokes `rg` through a quoted PowerShell command
- WHEN the baseline assertion evaluates command arguments
- THEN the matcher recognizes the executable token without matching names that merely contain `rg`
- AND the assertion does not depend on one shell's quote prefix.

#### Scenario: Current MCP search payload is used

- GIVEN the exact context-mode MCP contract is exercised
- WHEN `ctx_search` is invoked
- THEN its payload uses a bounded `queries` array
- AND the deprecated singular `query` field is absent
- AND post-purge search uses the same current contract.

#### Scenario: Nested provider calls require raw audit

- GIVEN outer `ai-tester` trace does not expose nested Codex MCP calls
- WHEN a provider row is normalized
- THEN raw rollout records from the isolated `CODEX_HOME` are audited for required and forbidden tool names
- AND path-like tool arguments are verified as sandbox descendants
- AND only tool counts and boolean/status fields leave the raw audit boundary
- AND missing raw evidence is `NOT_RUN(raw_provider_audit_missing)`
- AND an escaped path is `FAIL(raw_provider_path_escape)`.

#### Scenario: Resume driver drift cannot prove continuity

- GIVEN a multi-turn `ai-tester` run resumes Codex without the initial cwd, repo-check or permission parity
- WHEN continuity evidence is normalized
- THEN it is `NOT_RUN(resume_driver_parity_unavailable)`
- AND hallucinated or stale facts cannot satisfy continuity
- AND direct hook PASS is not relabeled as actual Codex session continuity.

### Requirement: Authorized live evidence is durable only as a sanitized append-only aggregate

The system MUST retain the authorized issue `#134` live evaluation as a new change-scoped aggregate without rewriting historical or archived evidence.

#### Scenario: Durable aggregate excludes sensitive run material

- GIVEN lifecycle and scenario runs completed in a disposable sandbox
- WHEN tracked evidence is written
- THEN it records exact public versions, anonymous scenario classes, aggregate tokens/duration, correctness, lifecycle, purge, cleanup, decisions and limitations
- AND it excludes raw traces, rollout records, commands, fixture content, provider databases, credentials, auth hashes, environment values and absolute paths
- AND the archived `reevaluate-context-mode-codex-plugin-issue-134` artifacts remain unchanged.

#### Scenario: Evidence-derived policy stays bounded

- GIVEN the live large-output MCP row passes correctness but uses more billed model tokens than failed baseline
- AND the actual plugin row fails to intercept the current nested shell path
- AND resume continuity is not proven
- WHEN docs and recommendation guidance are updated
- THEN MCP-only is at most conditional for explicit large truncating command output
- AND actual plugin is avoid for the tested nested shell stack
- AND no general token-saving claim is made
- AND `rg` remains the default baseline with no automatic provider lifecycle.
