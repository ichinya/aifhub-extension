---
name: aif-rules-check
description: Compatibility fallback for the upstream read-only rules compliance gate. Use when ai-factory 2.10.0 installs do not yet include bundled aif-rules-check.
argument-hint: "[git ref | empty]"
allowed-tools: Read Glob Grep Bash(git *) AskUserQuestion
disable-model-invocation: false
metadata:
  author: AIFHub Extension
  version: "1.3"
  category: quality
---

# Rules Compliance Gate Compatibility Fallback

Run a standalone read-only rules gate for project rules. This fallback exists only while `aifhub-extension.json -> compat.ai-factory` includes `2.10.0` installs that may predate upstream AI Factory PR #90. When the compatibility minimum moves to an upstream semver release that bundles `/aif-rules-check`, remove this fallback and keep only the AIFHub injection.

This command checks rule compliance only; it does not replace `/aif-review` or `/aif-verify`.

## Step 0: Load Contract

- Read `references/RULES-CHECK-CONTRACT.md` first.
- Treat it as the canonical source for verdict semantics and report structure.
- If examples in this file drift from the reference, follow the reference.

## Step 1: Load Config

Read `.ai-factory/config.yaml` if it exists to resolve:

- `paths.rules_file`
- `paths.rules`
- `paths.plan`
- `paths.plans`
- `language.ui`
- `git.enabled`
- `git.base_branch`
- `rules.base`
- named `rules.<area>` entries

If config is missing or partial, use defaults:

- `paths.rules_file`: `.ai-factory/RULES.md`
- `paths.rules`: `.ai-factory/rules/`
- `paths.plan`: `.ai-factory/PLAN.md`
- `paths.plans`: `.ai-factory/plans/`
- `git.enabled`: `true`
- `git.base_branch`: detect the repo default branch from git metadata; fall back to `main` only when detection is unavailable
- `rules.base`: `.ai-factory/rules/base.md`

If `paths.rules_file` is missing from config, default to `.ai-factory/RULES.md`. If `git.base_branch` is missing, resolve the repository default branch from git metadata when possible and use `main` only as the final fallback.

## OpenSpec-native mode

When `.ai-factory/config.yaml` contains `aifhub.artifactProtocol: openspec` or the explicit scope is under `openspec/changes/<change-id>/`, use OpenSpec-native mode.

Read canonical OpenSpec artifacts only as context:

- `openspec/specs/**`
- `openspec/changes/<change-id>/proposal.md`
- `openspec/changes/<change-id>/design.md`
- `openspec/changes/<change-id>/tasks.md`
- `openspec/changes/<change-id>/specs/**/spec.md`

Load rules in this priority order:

1. `.ai-factory/rules/generated/openspec-merged-<change-id>.md`
2. `.ai-factory/rules/generated/openspec-change-<change-id>.md`
3. `.ai-factory/rules/generated/openspec-base.md`
4. The resolved `paths.rules_file`, default `.ai-factory/RULES.md`
5. The resolved `rules.base`, default `.ai-factory/rules/base.md`
6. Relevant named `rules.<area>` files from config, only when they clearly match the checked scope

OpenSpec-native mode does not require plan-local `rules.md`. Ignore plan-local `rules.md` unless the run is explicitly in Legacy AI Factory-only mode.

If generated rules are missing or stale, return `WARN`, report which generated rules are present, missing, or stale, and ask the caller to regenerate rules through the compiler-owning workflow such as `/aif-mode sync`. This gate must not regenerate or edit generated rules.

Do not write runtime state, QA evidence, generated rules, rule artifacts, source files, or canonical OpenSpec artifacts. Runtime state `.ai-factory/state/<change-id>/` and QA evidence `.ai-factory/qa/<change-id>/` are external context only.

## Legacy AI Factory-only mode

When OpenSpec-native mode is not active, load rule sources in this order:

1. The resolved `paths.rules_file` artifact
2. The resolved `rules.base` file
3. Any named `rules.<area>` files from config that clearly match the changed scope

Area rules are optional and scoped. Use changed file paths, folder names, and optional plan context to judge relevance. If relevance is ambiguous, mention the rule source as uncertain and keep the outcome at `WARN`, not `FAIL`.

Optional plan context may be used only when it helps interpret scope or area relevance. Absence of a plan is never a failure.

## Changed Scope

If the user provided a git ref:

1. Validate it with `git rev-parse --verify <argument>`.
2. If valid, inspect `git diff --name-only <argument>...HEAD` and `git diff <argument>...HEAD`.
3. If invalid, ask whether to check staged or working-tree changes instead.

Without arguments:

1. Prefer staged work with `git diff --cached --name-only` and `git diff --cached`.
2. If nothing is staged, fall back to `git diff --name-only` and `git diff`.
3. If there is still no local diff and `git.enabled = true`, fall back to `<resolved-base-branch>...HEAD`.

If there are still no changed files, return `WARN` rather than a hard failure.

## Evaluate Rules

- `PASS`: at least one applicable rule was checked and no clear violations were found.
- `WARN`: no applicable rules were resolved, evidence is ambiguous, generated rules are missing or stale, or there are no changed files to evaluate.
- `FAIL`: an explicit hard rule is clearly violated by the inspected diff or changed files.

Tie every blocking violation to specific rule text and at least one concrete file/path or diff hunk. If a rule is vague or cannot be verified confidently from the diff, do not escalate it past `WARN`.

## Read-Only Boundary

Never edit rule artifacts, generated rules, plan files, source files, runtime state, or QA evidence. If rules are missing, stale, or need refinement, suggest `/aif-rules`; if OpenSpec generated rules are missing or stale, suggest `/aif-mode sync`.

## Output

Use the exact verdict semantics and section order from `references/RULES-CHECK-CONTRACT.md`.

Required content:

- overall verdict
- files checked
- gate results
- blocking violations
- suggested fixes
- suggested rule updates
- final machine-readable `aif-gate-result` fenced JSON block

Machine-readable gate result:

- Append one final fenced `aif-gate-result` JSON block after the human-readable rules report.
- Use `"gate": "rules"`.
- Use lowercase JSON `status`: `pass`, `warn`, or `fail`.
- Map the human rules verdict exactly: `PASS` -> `pass`, `WARN` -> `warn`, and `FAIL` -> `fail`.
- Use `"blocking": true|false`; set it to `true` only for explicit hard-rule violations that produce a human `FAIL`.
- Include only hard-rule violations in `"blockers": []`.
- Include changed or inspected paths in `"affected_files": []`.
- Set `"suggested_next"` to `/aif-rules` when rules should be added or clarified, `/aif-fix` when code must change, or `null` when no allowed next command fits.

```aif-gate-result
{
  "schema_version": 1,
  "gate": "rules",
  "status": "warn",
  "blocking": false,
  "blockers": [],
  "affected_files": [],
  "suggested_next": {
    "command": "/aif-rules",
    "reason": "Rules are missing or ambiguous for the changed scope."
  }
}
```
