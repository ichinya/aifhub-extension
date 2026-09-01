[Previous Page](openspec-compatibility.md) | [Back to Documentation](README.md) | [Next Page](spec-coverage.md)

# OpenSpec Artifact Validation

`scripts/openspec-artifact-validator.mjs` is the read-only AIFHub contract validator for OpenSpec-native artifacts.

It does not replace the OpenSpec CLI. The OpenSpec CLI validates OpenSpec syntax and archive behavior. This validator checks AIFHub workflow ownership: canonical change artifacts stay under `openspec/changes/<change-id>/`, runtime state stays under `.ai-factory/state/<change-id>/`, QA evidence stays under `.ai-factory/qa/<change-id>/`, and generated rules stay under `.ai-factory/rules/generated/`.

## Usage

Run the validator from an installed project:

```bash
ai-factory aifhub-validate-artifacts --change <change-id> --json
```

Require verification evidence for finalization readiness:

```bash
ai-factory aifhub-validate-artifacts --change <change-id> --require-verification-evidence --json
```

Exit codes:

| Code | Meaning |
|---|---|
| `0` | Contract status is `pass` or `warn` |
| `1` | Contract status is `fail` |
| `2` | Invalid arguments or unresolved change |

## JSON Contract

The output shape is stable:

```json
{
  "schema_version": 1,
  "validator": "aifhub-openspec-artifact-contract",
  "change_id": "add-oauth-login",
  "status": "pass",
  "blocking": false,
  "checks": [
    {
      "id": "delta-specs-present",
      "status": "pass",
      "path": "openspec/changes/add-oauth-login/specs/auth/spec.md",
      "message": "Found 1 OpenSpec delta spec file(s)."
    }
  ],
  "suggested_next": null
}
```

`status` is `pass`, `warn`, or `fail`. `blocking` is true only for `fail`. Passing results keep `suggested_next` `null`; the same convention applies to `aif-gate-result` blocks, where terminal and forward routing (for example `/aif-done <change-id>` or `/aif-verify <change-id>`) stays prose-only and a non-null `suggested_next` is valid only with an owned remediation command for `warn` or `fail`.

Gate receipts written before the null-on-pass contract may record a passing block with a non-null `suggested_next`. Such legacy receipts fail gate-result validation after upgrading, and done readiness reports them with targeted codes instead of a generic invalid-evidence outcome: `verification-gate-legacy-suggested-next` for verify receipts (remediation: rerun `/aif-verify <change-id>` once) and `rules-gate-legacy-suggested-next` for rules receipts (remediation: rerun `/aif-rules-check` and persist the receipt through `ai-factory aifhub-write-gate-evidence`). Receipts that are invalid for any other reason keep the existing generic codes.

## Checks

The validator checks:

| Check | Result |
|---|---|
| `proposal.md` and `tasks.md` exist | `fail` when missing |
| declared `## AIFHub Source Binding` | `fail` when duplicate, malformed, unsafe, or when the change ID does not begin with the normalized `External ID` plus a non-empty request slug; absence is valid for ordinary non-MCP plans, and failure suggests `/aif-fix <change-id>` |
| `design.md` exists | `warn` when missing, or `fail` when `aifhub.openspec.requireDesign: true` |
| `specs/**/spec.md` delta exists | `fail` unless `.openspec.yaml` declares native `skip_specs: true`; an explicit legacy proposal reason remains accepted for compatibility |
| runtime or evidence files inside `openspec/changes/<change-id>/` | `fail` |
| `.ai-factory/qa/<change-id>/openspec-validation.json` and `verify.md` | required only with `--require-verification-evidence` |
| final verify `aif-gate-result` block | `fail` when verification evidence is required and the block is missing, invalid, or failing |
| generated rules under `.ai-factory/rules/generated/` | `warn` when missing or stale |
| supplied changed paths under `openspec/specs/**` | `fail` unless direct base spec mutation is explicitly allowed |

OpenSpec `1.9.0` strict validation treats task-numbering warnings as blocking: the same warnings are a valid exit-`0` observation in non-strict upstream validation, while strict validation returns exit `1` and AIFHub stops code verification. Scenario loss for an arbitrary real nested `####` child also fails strict validation; AIFHub preserves the upstream `widgets/spec.md` path and omission message in validation QA evidence, so neither verify nor archive readiness can report a false PASS. Capability retirement remains an OpenSpec-owned archive operation and requires explicit `retire_capabilities: true` metadata on OpenSpec `>=1.8.0`; AIFHub planning must not infer the marker.

OpenSpec `1.10.0` strengthens task authoring guidance: every task must name its completion check inline as a test, command, observable behavior, or delivered artifact. AIFHub applies the same rule when `/aif-plan` authors a checklist and when `/aif-improve` refines one; a separate verification task is reserved for broader integration or system behavior spanning multiple implementation tasks.

For a pre-existing checklist whose tasks lack that clause, `/aif-improve` performs a bounded checklist migration across every affected checkbox. It appends only the missing verification while preserving the task number, checked/unchecked state, order, original action and intent; it does not split, merge, renumber, reopen, complete, or broaden tasks solely for migration. Already compliant unrelated checkboxes remain unchanged.

`openspec validate --archived` is advisory-only. It is not invoked by the shared current-change runner, `/aif-verify`, `/aif-done`, package validation scripts, tracked CI, or the release acceptance PASS boolean. If run for an informational historical snapshot, execute it separately and report its exit/count without chaining it into mandatory gates or rewriting historical archives.

Generated-rule warnings suggest:

```text
/aif-mode sync --change <change-id>
```

Missing verification evidence suggests:

```text
/aif-verify <change-id>
```

## Integrations

`/aif-mode doctor --change <change-id>` includes the full validator result in JSON as `artifactContract` and adds a human diagnostic line. Doctor requires verification evidence because it is a pre-archive readiness check.

Doctor also reports `effectivePolicy` from `scripts/openspec-policy.mjs`, including CLI, generated-rules, rules-gate, spec-coverage, and `allowWarnOnDone` settings. Human diagnostics show whether missing or warning evidence is only degraded or blocking under the current policy.

`/aif-done` runs its extension-local `scripts/openspec-done-readiness.mjs` implementation module before archive and writes `.ai-factory/qa/<change-id>/done-readiness.json`. Installed projects do not execute that internal module directly. The readiness gate checks OpenSpec validate, OpenSpec status, artifact contract, generated rules freshness, rules gate evidence, coverage, verify gate evidence, and dirty workspace state. Blocking failures refuse archive and include an exact suggested next command, such as `/aif-mode sync --change <change-id>`, `ai-factory aifhub-write-gate-evidence --change <change-id> --gate rules --from <rules-output.md>`, `/aif-verify <change-id>`, or `ai-factory aifhub-done-finalizer --change <change-id> --record-dirty-state --json`.

When `requireRulesPassForDone` is true, save the final `/aif-rules-check` output, or at least its final `aif-gate-result` block, to `.ai-factory/qa/<change-id>/rules.md` before `/aif-done`:

```bash
ai-factory aifhub-write-gate-evidence \
  --change add-oauth-login \
  --gate rules \
  --from /tmp/aif-rules-check-output.md
```

```bash
ai-factory aifhub-write-gate-evidence --change add-oauth-login --gate rules
```

The second form reads Markdown from stdin.

The readiness gate runs the artifact validator with verification evidence required and refuses to archive when the validator returns `fail` or blocking `warn`.

`/aif-verify` still writes validation/status/verify evidence under `.ai-factory/qa/<change-id>/` and does not archive. It also writes the separate OpenSpec coverage matrix described in [OpenSpec Coverage Matrix](spec-coverage.md).

## Done Finalization

Run finalization from an installed project through the stable wrapper:

```bash
ai-factory aifhub-done-finalizer --change <change-id> --json
```

Omitting `--change` delegates to the active-change resolver: exactly one resolvable active change may be selected, while missing or ambiguous scope exits with code `2` before finalization. Automation should always pass an explicit `--change <change-id>`.

New docs/tooling-only changes on OpenSpec `>=1.7.0` should declare `skip_specs: true` in `.openspec.yaml`; older supported CLIs keep the explicit proposal reason. Explicit capability retirement on OpenSpec `>=1.8.0` uses native `retire_capabilities: true` and is never inferred from an empty delta. The compatibility finalizer can still use `--skip-specs`, and explicit dirty-state evidence can use `--record-dirty-state`:

```bash
ai-factory aifhub-done-finalizer --change <change-id> --skip-specs --record-dirty-state --json
```

Do not run `scripts/openspec-done-finalizer.mjs`, `scripts/openspec-done-readiness.mjs`, or `scripts/openspec-runner.mjs` from the consumer root or an internal installed-extension path. They are extension-local implementation modules. The public parser rejects unknown options and bypass flags including `--force`, `--no-validate`, `--skip-archive`, `--dry-run`, and `--summary-only` before finalization starts.

| Code | Meaning |
|---|---|
| `0` | Finalization succeeded or completed with a policy-accepted warning |
| `1` | A resolved readiness/archive blocker refused finalization |
| `2` | Invalid arguments, unresolved or ambiguous scope, or unexpected command failure |

Human and JSON output is whitelist-based and bounded. It can include status, selected change, safe project-relative evidence paths, suggested next action, and the selected OpenSpec command/source. It does not include raw stdout/stderr, environment data, full runtime context, artifact contents, or private absolute paths.

## Done Readiness

Run the pre-archive gate directly when diagnosing `/aif-done` refusal:

```bash
ai-factory aifhub-done-readiness --change <change-id> --json
```

It writes `.ai-factory/qa/<change-id>/done-readiness.json` unless `--no-write` is passed. Exit codes are `0` for `pass` or policy-accepted `warn`, `1` for blocking readiness failure, and `2` for invalid arguments or unresolved changes.

A dirty workspace is blocking by default. Inspect with `git status --short`; commit or stash unrelated changes, or rerun `ai-factory aifhub-done-finalizer --change <change-id> --record-dirty-state --json` when the current dirty state should be recorded in final QA evidence before archive.

Stable JSON fields:

```json
{
  "schema_version": 1,
  "gate": "done-readiness",
  "change_id": "add-oauth-login",
  "status": "pass",
  "blocking": false,
  "checks": {
    "openspec_validate": "pass",
    "openspec_status": "pass",
    "artifact_contract": "pass",
    "generated_rules": "pass",
    "rules_gate": "pass",
    "coverage": "pass",
    "verify_gate": "pass",
    "dirty_workspace": "pass"
  },
  "diagnostics": [],
  "suggested_next": null
}
```

Each diagnostic includes `check`, `level`, `blocking`, `code`, `message`, optional `path`, and optional `suggested_next`.

Readiness checks:

| Check | Blocking behavior |
|---|---|
| `openspec_validate` | blocks when required OpenSpec validation fails or done policy requires an unavailable CLI |
| `openspec_status` | blocks only when status is unavailable or warning and `allowWarnOnDone.openspecStatus` is false |
| `artifact_contract` | requires aggregate artifact contract `pass` before archive |
| `generated_rules` | blocks stale or missing generated rules when `requireGeneratedRulesForDone` is true |
| `rules_gate` | blocks missing, failed, or disallowed warning rules evidence when `requireRulesPassForDone` is true |
| `coverage` | blocks missing, stale, failed, or disallowed warning coverage when `requireSpecCoverageForDone` is true |
| `verify_gate` | blocks missing, invalid, failed, or ambiguous final verify gate evidence |
| `dirty_workspace` | blocks uncommitted changes unless explicit dirty-state recording is enabled with `ai-factory aifhub-done-finalizer --change <change-id> --record-dirty-state --json`; inspect first with `git status --short` |

Policy is intentionally stricter for done than verify. Verify can run degraded when CLI, generated rules, rules gate, or coverage evidence is unavailable unless the matching verify flag is true. Done requires archive readiness and applies `allowWarnOnDone` before accepting warning-only rules, coverage, or OpenSpec status.

## Read-Only Boundary

The validator never:

- runs the OpenSpec CLI
- archives a change
- writes canonical specs
- writes generated rules
- writes QA evidence
- moves files between `openspec/changes` and archives

Use `/aif-mode sync --change <change-id>` to regenerate derived rules and `ai-factory aifhub-done-finalizer --change <change-id> --json` to archive after passing verification.

## See Also

- [OpenSpec Compatibility](openspec-compatibility.md)
- [OpenSpec Coverage Matrix](spec-coverage.md)
- [Usage](usage.md)
- [Active Change Resolver](active-change-resolver.md)
