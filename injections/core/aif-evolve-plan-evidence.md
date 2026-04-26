## AIFHub Plan-Aware Evolution Override

Apply this block before the upstream `aif-evolve` body. When this injected guidance conflicts with older patch-only assumptions in the base skill, this block wins.

### Goal

`/aif-evolve` remains the built-in upstream skill, but in this extension it must support **plan-aware evolution** in addition to patch analysis.

### Mode Detection

Before resolving evidence selectors, read `.ai-factory/config.yaml` when it exists.

- If the config contains `aifhub.artifactProtocol: openspec`, use **OpenSpec-native mode**.
- Otherwise, use **Legacy AI Factory-only mode**.
- If the config is missing, continue with Legacy AI Factory-only mode and state that no OpenSpec-native protocol was detected.

### OpenSpec-native evidence

When `.ai-factory/config.yaml` declares `aifhub.artifactProtocol: openspec`, `/aif-evolve` may use the active OpenSpec change and derived/runtime evidence as input.

Accepted OpenSpec-native selectors:

- `/aif-evolve <change-id>`
- `/aif-evolve all <change-id>`
- `/aif-evolve implement <change-id>`
- `/aif-evolve @openspec/changes/<change-id>`
- `/aif-evolve @.ai-factory/state/<change-id>`
- `/aif-evolve @.ai-factory/qa/<change-id>`

Evidence root priority:

1. `openspec/changes/<change-id>/`
2. `.ai-factory/qa/<change-id>/`
3. `.ai-factory/state/<change-id>/`

Read canonical OpenSpec artifacts when present:

- `openspec/specs/**`
- `openspec/changes/<change-id>/proposal.md`
- `openspec/changes/<change-id>/design.md`
- `openspec/changes/<change-id>/tasks.md`
- `openspec/changes/<change-id>/specs/**/spec.md`

Read generated rules and runtime/QA evidence when present:

- `.ai-factory/rules/generated/openspec-merged-<change-id>.md`
- `.ai-factory/rules/generated/openspec-change-<change-id>.md`
- `.ai-factory/rules/generated/openspec-base.md`
- `.ai-factory/qa/<change-id>/`
- `.ai-factory/state/<change-id>/`

Use source labels that preserve OpenSpec provenance, for example:

- `openspec:<change-id>/proposal.md`
- `openspec:<change-id>/tasks.md`
- `qa:<change-id>/<file>`
- `state:<change-id>/<file>`

OpenSpec-native evolution must not create or require legacy plan-folder evidence. It must not advance, reset, or rewrite the patch cursor based only on OpenSpec-native evidence.

When OpenSpec-native evidence was used, the evolution report must name the artifact source set and say whether QA findings, runtime state, generated rules, or canonical OpenSpec artifacts changed the proposed prevention rules.

### Legacy AI Factory-only evidence

When OpenSpec-native mode is not enabled, preserve the existing plan-aware evolution behavior.

### Argument Resolution

Treat `$ARGUMENTS` or `/aif-evolve` arguments as two optional selectors:

- **Skill selector**: a specific skill name or `all`
- **Plan selector**: `<plan-id>` or `@<plan-path>`

Accepted forms:

- `/aif-evolve`
- `/aif-evolve all`
- `/aif-evolve implement`
- `/aif-evolve <plan-id>`
- `/aif-evolve implement <plan-id>`
- `/aif-evolve @.ai-factory/plans/<plan-id>`

Resolution order:

1. If a token starts with `@`, treat it as an explicit plan path.
2. Otherwise, if a token matches an existing plan folder under `.ai-factory/plans/` or an archived spec folder under `.ai-factory/specs/`, treat it as a plan selector.
3. Remaining non-plan token is the skill selector.
4. If no skill selector remains, default to `all`.

When a legacy plan selector is present without a skill selector, evolve `all` skills using that plan as additional evidence.

### Legacy Plan Evidence

When a legacy plan selector is present, load plan evidence before gap analysis.

Evidence root priority:

1. `.ai-factory/plans/<plan-id>/`
2. `.ai-factory/specs/<plan-id>/` if the plan was already archived
3. Explicit `@<plan-path>` wins over inferred locations

If the explicit path points at `status.yaml`, `task.md`, `context.md`, `verify.md`, or a fix artifact, use the parent plan/spec folder.

Read these files when present:

- `task.md`
- `context.md`
- `rules.md`
- `verify.md`
- `status.yaml`
- `explore.md`
- `fixes/*.md`

Evidence priority inside the selected plan:

- Highest signal: `fixes/*.md`, `verify.md`, `status.yaml`
- Supporting signal: `context.md`, `rules.md`, `task.md`, `explore.md`

### Registry Merge

Extract prevention points from plan evidence into the SAME prevention-point registry used for patch analysis.

Use source labels that preserve plan provenance, for example:

- `plan:<plan-id>/fixes/<file>.md`
- `plan:<plan-id>/verify.md`
- `plan:<plan-id>/context.md`

Treat `fixes/*.md` as the strongest plan-local source for root causes and prevention rules.

### Cursor Rule

Patch cursor logic stays patch-only.

- Plan evidence is ad hoc input for the current run.
- Do not advance, reset, or rewrite `.ai-factory/evolutions/patch-cursor.json` based only on plan evidence.

### Reporting Rule

When plan evidence was used, the evolution report must say so explicitly.

Minimum summary:

- number of patches analyzed
- number of plan artifacts analyzed
- whether fixes/findings/context changed the proposed rules

### Workflow Integration

When `/aif-verify` completes finalization for a plan, prefer:

- `/aif-evolve <plan-id>`

instead of running patch-only evolution with no plan context.
