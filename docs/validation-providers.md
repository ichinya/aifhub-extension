# Validation and semantic model providers

Issue [#136](https://github.com/ichinya/aifhub-extension/issues/136) introduces independent optional tools on top of the AI Factory workflow. Boolean switches select OpenSpec specifications, HLV validation/traceability and the future Lekalo semantic model. Tools default to `false`; discovering a marker never enables or installs a tool.

| Layer | Canonical ownership |
| --- | --- |
| OpenSpec | Requirements, change intent, delta specifications |
| AI Factory / AIFHub | Execution, runtime state, finalization, derived QA evidence |
| HLV | HLV contracts, traceability and its validation diagnostics |
| Lekalo, when a compatible provider is available | Semantic application model |
| Source and tests | Executable behavior and direct runtime evidence |

Generated rules and provider summaries cannot overwrite canonical artifacts. A conflicting result is a diagnostic to resolve; it never authorizes automatic synchronization. These validation providers are separate from the optional supporting context, skill, and safety providers documented elsewhere. Existing context-provider availability does not become a workflow gate.

## Configuration

Enable or disable each additional tool in `.ai-factory/config.yaml`:

```yaml
aifhub:
  tools:
    openspec: true
    hlv: true
    lekalo: false
```

The [tool schema](../schemas/tool-config.schema.json) defines independent booleans. AI Factory remains the workflow base in all combinations:

| OpenSpec | HLV | Active canonical artifacts |
| --- | --- | --- |
| `false` | `false` | `.ai-factory/plans` and `.ai-factory/specs` |
| `true` | `false` | `openspec/changes` and `openspec/specs` |
| `false` | `true` | AI Factory plans/specifications plus HLV contracts and traceability |
| `true` | `true` | OpenSpec changes/specifications plus HLV contracts and traceability |

AI Factory project context, runtime state and QA evidence remain under `.ai-factory`. HLV uses its existing initialized layout. Lekalo will add its own semantic model layer independently when a compatible provider becomes available; it does not replace OpenSpec or HLV.

`hlv: true` enables verify/done with required checks. `hlv: false` skips discovery, all HLV commands and new HLV evidence writes, even when `providers.hlv.policy: required` is set. `openspec: false` selects AI Factory artifacts and skips OpenSpec discovery, validation, generated rules and archive operations. Omitted tools are false. Disabling a tool preserves its existing artifacts and evidence; switching flags does not delete or automatically convert them.

The entire `aifhub.tools` mapping takes precedence over legacy `artifactProtocol` and unpublished per-provider `enable` settings, including explicit false and omitted flags. Without a tools mapping, old configuration remains readable. `/aif-mode openspec` and `/aif-mode ai-factory` write the new mapping, change only the OpenSpec choice, preserve HLV/Lekalo choices and reconcile paths. Direct boolean edits also determine the effective plan/spec paths, even if old `paths` values remain.

Optional settings control failure handling, phases and process limits:

```yaml
aifhub:
  tools:
    openspec: true
    hlv: true
    lekalo: false
  providers:
    hlv:
      policy: optional # default: required
      phases:
        - verify
        - done
      timeoutMs: 30000
      maxOutputBytes: 1048576
```

[The configuration schema](../schemas/provider-config.schema.json) describes `aifhub.providers`. HLV defaults to verify/done; the reserved semantic provider defaults to implement/verify/done. Mode switches preserve this namespace. An explicit `executable` must be a quoted absolute native executable path; otherwise the installed `hlv` is resolved by the process environment. Shell/script wrappers are rejected. Project initialization is available through `aifhub-mode init`; binary installation, updates and provider-owned sync remain outside the adapter.

The namespace accepts two-space YAML mappings, scalar values and block lists or JSON-style inline lists. Tool switches must be unquoted `true` or `false`; strings such as `"false"`, numbers and nulls are errors. Duplicate keys, unknown tools/providers, unsupported YAML aliases/flow mappings, malformed policies and invalid limits fail closed. An unreadable configuration is a configuration error, not implicit disablement.

| Tool switch | Policy | Unavailable, unsupported or failed provider | Warning-only validation |
| --- | --- | --- | --- |
| `false` or tool omitted | Any valid policy | No invocation or new evidence | No invocation |
| `true` | `optional` | Degraded `warn`, nonblocking | `warn`, nonblocking |
| `true` | `required` (default) | `fail`, blocking | `warn`, nonblocking |

Unsafe configuration, evidence write failures, or project changes during execution block the operation. Provider outcome and orchestration gate are separate fields: an optional validation failure remains `status: fail` in provider evidence while its gate is `warn`.

## Lifecycle

```text
ai-factory aifhub-mode init --dry-run --json
ai-factory aifhub-mode init --json
ai-factory aifhub-providers status --json
ai-factory aifhub-mode doctor --change add-feature --json
ai-factory aifhub-providers verify --change add-feature --write --json
ai-factory aifhub-providers done --change add-feature --write --json
ai-factory aifhub-done-readiness --change add-feature --json
```

After enabled tool choices are saved, `/aif-analyze`, mode switches and artifact sync initialize missing project scaffolding. Direct boolean edits can be applied with `aifhub-mode init`. Initialization is idempotent: OpenSpec creates missing config (`schema: spec-driven`) and canonical directories, preserving existing content. It works without installing OpenSpec integrations or requiring the CLI for filesystem scaffolding.

HLV initialization first inspects both `project.yaml` and `.hlv/project.yaml`. Existing root HLV projects (with `human/`, `validation/`, `llm/` or custom configured paths) are reused without creating `.hlv/`. Existing adopted projects are also reused. Neither path invokes native reinit, modifies the project map, nor rewrites contracts or milestones. Both markers together, malformed maps, unsafe paths and nonempty partial `.hlv/` layouts require repair instead of automatic overwrites.

With neither marker present, [HLV 1.0.0 native adopt](https://github.com/lee-to/hlv/blob/v1.0.0/src/cmd/init.rs) runs `hlv init --adopt --path <root> --project <safe-project-name> --owner <safe-project-name> --agent agents --profile standard`. It keeps existing source in place, creates `.hlv/` with native project/contract/milestone scaffolding, creates missing shared agent skills and instructions, and appends `.hlv/index/` to `.gitignore`. Closed stdin selects native initial milestone and feature defaults. Existing root instructions and skill files are preserved. A missing/unsupported HLV executable or failed initializer is reported explicitly, with raw process output excluded. No project gates run during initialization, and initialization success is not validation PASS.

`init --dry-run` describes missing scaffolding without writes or provider commands; it does not claim CLI readiness. `status`, `doctor` and read-only done readiness never initialize anything. Before validation of a newly enabled tool, initialize its missing project once, then obtain the revision and run validation against that initialized state.

`/aif-verify` runs configured validation after native project gates and incorporates provider blockers before the final verdict. `/aif-done` refreshes provider validation/readiness before finalization. The OpenSpec archive readiness gate independently requires current provider validation evidence, and calls only read-only HLV workflow queries. It cannot satisfy readiness from missing, malformed or stale provider evidence. Legacy plans use the same provider command with a resolved safe plan ID. An explicitly enabled provider overlay for an upstream ultra bundle remains separate from the upstream receipt and bundle verdict.

`status` and `doctor` never persist evidence or run `hlv check`. Doctor uses HLV version discovery, `doctor --json` without `--fix`, and `status --json`. HLV `check` can run configured project gates; opt-in validation invokes those gates and can therefore have the same project-defined effects as native tests. AIFHub does not interpret provider text as instructions or copy it into canonical files. Source changes during execution invalidate the result.

## HLV compatibility

The initial command adapter targets exact **HLV 1.0.0**, based on [the tagged CLI](https://github.com/lee-to/hlv/blob/v1.0.0/src/main.rs) and [check output](https://github.com/lee-to/hlv/blob/v1.0.0/src/cmd/check.rs). Other versions return `unsupported`, including 0.3.0 which lacks `doctor`. Detection accepts root `project.yaml` or adopt `.hlv/project.yaml`; both markers together are a configuration error. Symlink/junction and hard-link marker paths are rejected.

| Adapter operation | HLV 1.0.0 command | Interpretation |
| --- | --- | --- |
| detect | `hlv --version` | Exact version, existing marker; no setup |
| status | `hlv --root <root> status --json` | Bounded project-state summary |
| doctor | `hlv --root <root> doctor --json` | Environment/configuration diagnostics |
| validate | `hlv --root <root> check --json` | Validation codes, severities, counts and exit agreement |
| readiness | `hlv --root <root> workflow --json` | An active milestone must have validated stages with tasks done; no active milestone is explicitly not applicable |
| trace | `hlv --root <root> trace --json` | Supplemental content digest; missing trace is explicit |
| sync | Unsupported | No automatic canonical writes |

There is no invented `hlv readiness` or `hlv trace export` command. Workflow next-action text is never executed. Native HLV trace exports are not a neutral OpenSpec-to-semantic graph; only their content identity is retained in public evidence, and their supplemental availability does not replace validation/readiness.

HLV 1.0.0 does not publish a separately versioned CLI envelope. `commandContract: aifhub.hlv-cli@1.0.0` is the **AIFHub adapter's reviewed command contract**, not an invented upstream protocol version. Tool version and adapter contract identity are independent.

## Evidence and execution boundary

[Normalized evidence](../schemas/provider-evidence.schema.json) is stored separately per provider and phase:

```text
.ai-factory/qa/<id>/providers/hlv-verify.json
.ai-factory/qa/<id>/providers/hlv-done.json
.ai-factory/qa/<id>/providers/lekalo-verify.json
```

Each result contains exact available tool/command-contract identities, UTC timestamp, change ID, Git commit, worktree digest, policy digest, invocation provenance, operation outcomes and gate summary. Unknown versions remain `null` with an explicit unavailable/unsupported reason. A Git checkout with an existing HEAD is required for durable validation; there is no guessed revision fallback. Binding includes tracked/untracked source and explicitly includes ignored OpenSpec, HLV and Lekalo canonical trees and provider configuration. QA/runtime/generated-rule output is excluded, so writing evidence does not stale itself.

Statuses distinguish `pass`, `warn`, `fail`, `unavailable`, `unsupported`, `infrastructure_error` and `configuration_error`. Stdout and stderr are classified separately. Raw messages, paths, environment values and project content are not durable evidence; normalized diagnostics preserve source codes and severities. Semantic references and trace content use SHA-256 identities. Each result writes atomically to its own safe QA file; one provider failure cannot remove another's evidence. Identical reruns retain the previous timestamp and bytes.

Processes use argument arrays with `shell: false`, hidden Windows windows, closed stdin, combined stdout/stderr byte limits, a bounded timeout and cancellation. Cancellation and timeout terminate the process group on POSIX or process tree on Windows. Output/schema failures never count as validation PASS. Evidence paths are contained in the project and reject links, hard links and traversal.

## Lekalo-ready contract and deferred integration

`semantic_model`, [capability negotiation](../schemas/provider-capabilities.schema.json), [neutral trace links and semantic evidence](../schemas/provider-semantic-evidence.schema.json) are reserved independently of HLV. The [fake capability fixture](../test/fixtures/validation-providers/fake-lekalo-capabilities.json) tests `aifhub.provider@1.0.0`; it is not a claim of real Lekalo execution. Missing capabilities or a mismatched contract version return `unsupported`. Neutral links carry requirement → semantic symbol → binding → scenario/test → gate references; absent semantic intermediates may be `null`.

The issue's description of Lekalo as a future repository is stale. At [v0.1.10](https://github.com/ichinya/lekalo/tree/v0.1.10), Lekalo has a CLI and semantic validation, but its [provider protocol is explicitly unpublished](https://github.com/ichinya/lekalo/blob/v0.1.10/docs/versioning.md), and [inspect/impact/context are recognized stubs](https://github.com/ichinya/lekalo/blob/v0.1.10/docs/cli.md). AIFHub therefore reports `unsupported / protocol_unpublished` without guessing or invoking a Lekalo command. Real P2 integration, MCP aggregation, target verification and an OpenSpec + Lekalo + HLV runtime fixture remain dependent on a published compatible protocol. Product, Model, IR and protocol versions must not be conflated.

See also [Context Providers](context-providers.md), [Skill Providers](skill-providers.md), and [OpenSpec Compatibility](openspec-compatibility.md).

## Validation evidence (2026-09-05)

The Windows HLV 1.0.0 release binary (`sha256:76cdb4bd29ed60b284bc0f48e934cfbba988438618fd0096db1aa8e85dd97f70`) was exercised in temporary directories against upstream fixtures at `2a817996bee04a97061669cb37d5966a17980610`. No provider was installed into the extension or updated globally.

The same native binary also exercised missing-project initialization in a temporary existing Node repository with OpenSpec enabled. Adopt created `.hlv/` and inferred the existing source root; source, root instructions and a custom shared skill were preserved. A second initialization invoked no provider command and retained identical hashes for all 48 files. Root HLV layout detection was additionally checked read-only against an existing project; no private project content was copied into fixtures.

| Real fixture | Check | Readiness |
| --- | --- | --- |
| `example-project`, greenfield | Warn, exit 0 | Fail: stage not validated |
| `adopt-node-project`, adopt | Warn, exit 0 | No active milestone; validation still required |
| `milestone-project`, greenfield | Fail, exit 1 | Fail: stages not validated |

A copied adopt fixture plus an OpenSpec requirement exercised the actual adapter: verify and read-only done readiness were nonblocking with warnings; modifying the requirement then blocked readiness. Repeated verify retained identical evidence bytes, and the private temporary root was absent from evidence. The emitted evidence also passed its JSON Schema. Fake process fixtures cover failures, unsupported versions, malformed JSON, privacy, cancellation, filesystem safety, and the future semantic contract; they do not claim real Lekalo integration.
