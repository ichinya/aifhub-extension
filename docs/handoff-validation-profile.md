[← Handoff Naming](handoff.md) · [Back to Documentation](README.md)

# Handoff Validation Profile

## Purpose

The Handoff validation profile is a read-only orchestration contract for OpenSpec-native AIFHub changes.

It lets a Handoff orchestrator read one JSON summary instead of parsing every gate Markdown file, coverage artifact, and generated-rules trace directly. It is not a separate runtime, not a public slash command, and not a replacement for `/aif-verify` or `/aif-done`.

The profile is produced by:

```bash
ai-factory aifhub-handoff-gate-summary --change <change-id> --stage review --json
```

## JSON Contract

```json
{
  "schema_version": 1,
  "change_id": "add-oauth-login",
  "stage": "review",
  "gates": {
    "rules": "pass",
    "review": "warn",
    "security": "pass",
    "verify": "pass",
    "coverage": "warn"
  },
  "generatedRules": "pass",
  "blocking": false,
  "next_stage": "done",
  "suggested_next": "/aif-done add-oauth-login",
  "diagnostics": [],
  "evidence": {
    "rules": ".ai-factory/qa/add-oauth-login/rules.md",
    "review": ".ai-factory/qa/add-oauth-login/aif-review.md",
    "security": ".ai-factory/qa/add-oauth-login/aif-security-checklist.md",
    "verify": ".ai-factory/qa/add-oauth-login/verify.md",
    "coverage": ".ai-factory/qa/add-oauth-login/coverage.json",
    "generatedRules": ".ai-factory/rules/generated"
  }
}
```

Handoff should treat these fields as the minimal stable contract:

| Field | Meaning |
|---|---|
| `schema_version` | Contract version. Current value is `1`. |
| `change_id` | Resolved OpenSpec change id. |
| `stage` | Input stage: `planning`, `implementing`, `review`, or `done`. |
| `gates` | Aggregated gate statuses for rules, review, security, verify, and coverage. |
| `generatedRules` | Derived generated-rules freshness: `pass`, `warn`, or `stale`. |
| `blocking` | Whether Handoff should stop progression. |
| `next_stage` | Stage Handoff should move to after this summary. |
| `suggested_next` | Exact public command to run next. |

`diagnostics` and `evidence` are included for debugging and auditability.

This string `suggested_next` is a separate stage-routing contract, distinct from the object-typed `suggested_next` inside `aif-gate-result` blocks: gate results keep `suggested_next` `null` when `status` is `pass` (terminal routing stays prose-only), while the Handoff summary always names the exact next command and expresses the terminal state as `/aif-done <change-id>`.

## Evidence Inputs

The summary reads existing files only. It does not create runtime directories and does not write QA evidence.

| Signal | Candidate evidence |
|---|---|
| `rules` | `.ai-factory/qa/<change-id>/rules.md`, `aif-rules-check.md`, `rules-check.md`, `gates/rules.md` |
| `review` | `.ai-factory/qa/<change-id>/review.md`, `aif-review.md`, `gates/review.md` |
| `security` | `.ai-factory/qa/<change-id>/security.md`, `aif-security-checklist.md`, `gates/security.md` |
| `verify` | `.ai-factory/qa/<change-id>/verify.md` |
| `coverage` | `.ai-factory/qa/<change-id>/coverage.json` |
| `generatedRules` | `.ai-factory/rules/generated/openspec-*.md` plus `openspec-rules-trace-<change-id>.json` |

Gate Markdown files are parsed through the existing `aif-gate-result` contract. If the latest matching `aif-gate-result` block is invalid, the profile reports that gate as `warn` and does not fall back to an older valid block.

## Status Semantics

| Status | Meaning |
|---|---|
| `pass` | The signal is present and acceptable. |
| `warn` | A completed gate or evidence source reported warnings, or non-required evidence is missing/invalid/stale. |
| `fail` | A gate reports a blocking failure. |
| `stale` | Generated rules are missing, stale, or have missing/invalid trace metadata. |

Gate `fail` values set `blocking: true`.

`generatedRules: "stale"` also sets `blocking: true` and has routing priority over gate failures. Handoff should run `/aif-mode sync --change <change-id>`, rebuild the summary, and then act on any remaining gate failures.

Warnings are not treated equally for routing. A parsed gate result with `status: "warn"` is completed evidence and does not block by itself. Missing, unreadable, invalid, or stale evidence blocks only when that signal is required for the current stage.

## Required Evidence By Stage

| Stage | Required evidence |
|---|---|
| `planning` | none |
| `implementing` | `verify` |
| `review` | `review`, `security`, `rules`, `coverage` |
| `done` | `verify`, `rules`, `coverage` |

When required evidence is missing, unreadable, invalid, or stale, the summary keeps `next_stage` at the current stage and returns the owning command as `suggested_next`.

## Routing

| Condition | `next_stage` | `suggested_next` |
|---|---|---|
| `generatedRules` is `stale` | current stage | `/aif-mode sync --change <change-id>` |
| required review evidence is missing/invalid at review stage | `review` | `/aif-review <change-id>` |
| required security evidence is missing/invalid at review stage | `review` | `/aif-security-checklist <change-id>` |
| required rules evidence is missing/invalid | current stage | `/aif-rules-check` |
| required verify or coverage evidence is missing/invalid/stale | current stage | `/aif-verify <change-id>` |
| any gate is `fail` and generated rules are current | `implementing` | `/aif-fix <change-id>` |
| review stage has no blockers | `done` | `/aif-done <change-id>` |
| planning stage has no blockers | `implementing` | `/aif-implement <change-id>` |
| implementing stage has no blockers | `review` | `/aif-verify <change-id>` |
| done stage has no blockers | `done` | `/aif-done <change-id>` |

Completed warnings do not block by themselves. Handoff can still display them or require a stricter policy outside this profile.

## CLI Exit Codes

| Exit code | Meaning |
|---|---|
| `0` | Summary was produced and `blocking` is `false`. |
| `1` | Summary was produced and `blocking` is `true`. |
| `2` | Arguments are invalid, the change cannot be resolved, or the summary cannot be produced. |

When `--json` is used, stdout contains JSON only.

## Boundary

This profile does not run fixes, regenerate generated rules, write QA evidence, archive an OpenSpec change, mutate Handoff DB state, or activate `injections/handoff/*` prompt assets.

The owning commands remain:

- `/aif-mode sync --change <change-id>` for generated rules.
- `/aif-fix <change-id>` for selected blocking findings.
- `/aif-verify <change-id>` for authoritative verification.
- `/aif-done <change-id>` for final readiness and archive/finalization.
