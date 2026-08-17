## AIFHub Rules Check OpenSpec-native Override

Apply this block before the upstream `aif-rules-check` body. When this guidance conflicts with the base skill text, this block wins.

Follow `skills/shared/LANGUAGE-POLICY.md` before producing user-facing responses or generated artifacts.

### Goal

Use the upstream `/aif-rules-check` read-only gate as the command owner, while adding AIFHub OpenSpec-native generated rules and artifact ownership rules.

### Mode Detection

Before resolving rule sources, read `.ai-factory/config.yaml` when it exists.

- If the config contains `aifhub.artifactProtocol: openspec`, use **OpenSpec-native mode**.
- If the explicit scope is under `openspec/changes/<change-id>/`, use **OpenSpec-native mode**.
- Otherwise use **Legacy AI Factory-only mode** and follow the upstream rules hierarchy.

### OpenSpec-native mode

When OpenSpec-native mode is active, `/aif-rules-check` is read-only and checks changed files against canonical OpenSpec context plus generated rules.

Use shared vocabulary consistently: `OpenSpec-native mode`, `canonical OpenSpec change`, `active change`, `change-id`, `base specs`, `delta specs`, `generated rules`, `runtime state`, `QA evidence`, and `legacy AI Factory-only mode`.

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

Load generated trace metadata when present:

- `.ai-factory/rules/generated/openspec-rules-trace-<change-id>.json`
- `.ai-factory/rules/generated/index.json`

Use trace metadata only as provenance for generated rules. Generated markdown remains the readable rule guidance; canonical OpenSpec artifacts remain the source of truth.

Generated-rule `FAIL` findings require trace-backed source evidence:

- cite `source.path`
- cite `source.requirement`
- keep the cited source aligned with `.ai-factory/rules/generated/openspec-rules-trace-<change-id>.json`

If generated rules or generated trace metadata are missing, stale, or invalid, return `WARN`, report which generated rules and trace files are present, missing, stale, or invalid, and ask the caller to regenerate rules through the compiler-owning workflow: `/aif-mode sync --change <change-id>`, then rerun `/aif-rules-check`. This gate must not regenerate or edit generated rules.

When generated trace metadata is missing or invalid, possible generated-rule findings are capped at `WARN`. Do not return final `status: "fail"` solely for a generated-rule finding unless that finding includes trace-backed `source.path` and `source.requirement`.

Runtime state and QA evidence are external context only:

- Name `.ai-factory/state/<change-id>/` as the runtime state path when useful.
- Name `.ai-factory/qa/<change-id>/` as the QA evidence path when useful.
- When strict done policy needs durable rules evidence, name `.ai-factory/qa/<change-id>/rules.md` as the expected storage location for the final rules `aif-gate-result`, but keep this gate read-only.
- Do not write runtime state, QA evidence, generated rules, rule artifacts, source files, or canonical OpenSpec artifacts.

The final response must still follow the upstream rules-check output contract and end with exactly one final machine-readable `aif-gate-result` fenced JSON block. Use `"gate": "rules"` and lowercase JSON `status`: `pass`, `warn`, or `fail`.

Next-step routing is one-way with terminal states and wins over any upstream next-step suggestion that would loop this gate with `/aif-verify`:

- When this gate passes and `/aif-verify <change-id>` has not already passed for the current change state, the suggested next step is `/aif-verify <change-id>`.
- When this gate passes and `/aif-verify <change-id>` has already passed for the current change state, the suggested next step is `/aif-done <change-id>`; do not suggest another `/aif-verify` run.
- When this gate fails or generated rules are missing, stale, or invalid, follow the regeneration route above (`/aif-mode sync --change <change-id>`, then rerun `/aif-rules-check`); do not suggest `/aif-verify` as remediation for a failing rules gate.
- Do not suggest rerunning this gate after it has already passed for the current change state.

### Legacy AI Factory-only mode

When OpenSpec-native mode is not active, do not add OpenSpec generated-rule requirements. Follow the upstream `/aif-rules-check` behavior for `.ai-factory/RULES.md`, `rules.base`, named `rules.<area>`, optional plan context, changed files, and the final `aif-gate-result` block.
