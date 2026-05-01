## AIFHub Rules Check OpenSpec-native Override

Apply this block before the upstream `aif-rules-check` body. When this guidance conflicts with the base skill text, this block wins.

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

If generated rules are missing or stale, return `WARN`, report which generated rules are present, missing, or stale, and ask the caller to regenerate rules through the compiler-owning workflow such as `/aif-mode sync`. This gate must not regenerate or edit generated rules.

Runtime state and QA evidence are external context only:

- Name `.ai-factory/state/<change-id>/` as the runtime state path when useful.
- Name `.ai-factory/qa/<change-id>/` as the QA evidence path when useful.
- Do not write runtime state, QA evidence, generated rules, rule artifacts, source files, or canonical OpenSpec artifacts.

The final response must still follow the upstream rules-check output contract and end with exactly one final machine-readable `aif-gate-result` fenced JSON block. Use `"gate": "rules"` and lowercase JSON `status`: `pass`, `warn`, or `fail`.

### Legacy AI Factory-only mode

When OpenSpec-native mode is not active, do not add OpenSpec generated-rule requirements. Follow the upstream `/aif-rules-check` behavior for `.ai-factory/RULES.md`, `rules.base`, named `rules.<area>`, optional plan context, changed files, and the final `aif-gate-result` block.
