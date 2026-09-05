## AIFHub OpenSpec-native Archive Boundary

Read [tool selection and artifact ownership](../../skills/shared/TOOLS.md) before choosing artifact paths or lifecycle instructions.

Apply this block before the upstream `aif-archive` body. When this boundary conflicts with upstream plan discovery or plan mutation, this block wins only in OpenSpec-native mode.

Follow `skills/shared/LANGUAGE-POLICY.md` before producing user-facing responses.

Resolve user-facing prose language in this order: use a usable non-empty `language.ui`; otherwise preserve the current conversation language for this response only; use English only when that language is indeterminate. This rule overrides downstream generic English defaults; do not infer from OS locale or persist the inferred choice. On that hard-English fallback, add exactly one concise setup hint only when the output contract permits human-readable prose, before any required final machine-readable block; never add it inside or after `aif-gate-result`, and never alter exact handoffs, fixed commands, paths, keys/enums, or machine-only output.

### Goal

Keep `/aif-done` as the sole OpenSpec change finalizer while preserving upstream read-only archive listing, roadmap-only snapshots, and all legacy AI Factory archive behavior.

### Mode and target classification before discovery

Read `.ai-factory/config.yaml` and parse the raw `aif-archive` arguments before resolving `paths.plans`, globbing plan candidates, reading plan entrypoints, or creating any archive destination.

Classify exactly one target class without filesystem discovery:

- `list` -> `archive-list`
- `--roadmap` -> `roadmap-only`
- no arguments -> `plan-mutating-interactive`
- `--all` -> `plan-mutating-all`
- one non-control argument -> `plan-mutating-explicit`
- conflicting or extra arguments -> `invalid`

`list` and `--roadmap` remain mutually exclusive with every plan-mutating target. An invalid target stops with a bounded argument error and performs no discovery or write.

### OpenSpec-native mode

Use this mode only when `.ai-factory/config.yaml` declares `aifhub.tools.openspec: true`.

#### Plan-mutating targets

For `plan-mutating-interactive`, `plan-mutating-all`, or `plan-mutating-explicit`, stop before resolving or scanning `paths.plans`. Do not read plan entrypoints, completion checkboxes, `openspec/changes/**`, or `openspec/specs/**`; do not create an archive directory or write any canonical, runtime-state, QA, generated-rule, roadmap, or archive artifact.

Return this exact owner handoff:

```text
/aif-done <change-id>
```

For a safe explicit token, it may be shown as the candidate `<change-id>` without checking the filesystem. No-argument and `--all` modes keep the literal placeholder and require explicit change selection through `/aif-done`.

#### Read-only `list`

For `archive-list`, preserve the upstream `list` behavior. It may read only the resolved `<paths.archive>/plans/` inventory and `<paths.archive>/roadmap/` snapshots, then stop. It must not resolve, glob, or read `paths.plans`; it must not read or write `openspec/changes/**` or `openspec/specs/**`; and it must not create or edit any file.

#### Roadmap-only `--roadmap`

For `roadmap-only`, preserve the upstream `--roadmap` behavior and confirmation gate. It may read the resolved `paths.roadmap`; after explicit confirmation it may write one non-colliding snapshot under `<paths.archive>/roadmap/` and edit only the completed milestone lines owned by upstream in `paths.roadmap`. It must not resolve, glob, or read `paths.plans`; it must not read or write `openspec/changes/**`, `openspec/specs/**`, `.ai-factory/state/**`, `.ai-factory/qa/**`, or `.ai-factory/rules/generated/**`.

#### Bounded output

Report only `mode=OpenSpec-native`, the target class, and either `handoff=/aif-done <change-id>` or the delegated upstream submode. Do not include plan bodies, roadmap bodies, credentials, raw stdout, raw stderr, or private absolute paths.

This prepend boundary performs classification and routing only. It does not perform filesystem mutations or claim archive completion.

### Legacy AI Factory-only mode

When OpenSpec-native mode is not enabled, preserve the complete upstream `/aif-archive` behavior for no-argument interactive mode, `list`, `--roadmap`, `--all`, classic plan files, and marked ultra bundle directories. This boundary adds no discovery, validation, archive metadata, or write step in legacy mode.

When `.ai-factory/config.yaml` is missing, use Legacy AI Factory-only mode and state the bounded mode decision before continuing upstream.
