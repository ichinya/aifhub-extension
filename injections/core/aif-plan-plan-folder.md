## AIFHub OpenSpec-Native Planning Override

Apply this block before the upstream `aif-plan` body. When any rule below conflicts with the base skill text, this block wins.

### Goal

Use the built-in `/aif-plan` skill as the canonical planning entrypoint for this extension workflow.

### Canonical Workflow

- Do not redirect users to deprecated planning aliases.
- The canonical public flow is `/aif-analyze -> /aif-explore -> /aif-plan -> /aif-improve -> /aif-implement -> /aif-verify`.
- Legacy planning references should be interpreted as `/aif-plan full`.

### OpenSpec-native mode

When `.ai-factory/config.yaml` has `aifhub.artifactProtocol: openspec`, this block overrides legacy plan-folder behavior.

Use canonical OpenSpec artifacts under `openspec/changes/<change-id>/`:

- `openspec/changes/<change-id>/proposal.md`
- `openspec/changes/<change-id>/design.md`
- `openspec/changes/<change-id>/tasks.md`
- `openspec/changes/<change-id>/specs/<capability>/spec.md` when the change affects product or workflow behavior

Do not create legacy `.ai-factory/plans` plan files or companion folders in this mode. Do not write runtime-only files into `openspec/changes/<change-id>/`.

If the task is docs/tooling-only and does not change product or workflow behavior, a delta spec may be omitted only when the plan explicitly explains why no delta spec is needed.

#### Change ID policy

- Derive a safe `<change-id>` slug from the request for new plans.
- Prefer lowercase kebab-case.
- Allow only safe relative IDs.
- Reject IDs containing `/`, `\`, `..`, absolute paths, path traversal, or unsafe characters.
- Use or reference `normalizeChangeId()` from `scripts/active-change-resolver.mjs` when useful.
- If `openspec/changes/<change-id>` already exists, do not overwrite silently. Ask for a new ID, or create a deterministic suffix only in autonomous mode when asking is unavailable.

#### Required artifact shape

`proposal.md` should use:

```markdown
# Proposal: <Title>

## Intent

Why this change is needed.

## Scope

- In scope
- Out of scope

## Approach

High-level implementation approach.

## Risks / Open Questions

Known risks, assumptions, and unresolved questions.
```

`design.md` should use:

```markdown
# Design: <Title>

## Technical Approach

## Data / Artifact Model

## Integration Points

## Alternatives Considered

## Risks
```

`tasks.md` must be a checkbox checklist:

```markdown
# Tasks

## 1. Planning and artifacts

- [ ] 1.1 Create/update OpenSpec delta specs
- [ ] 1.2 Confirm generated artifacts validate

## 2. Implementation

- [ ] 2.1 ...
```

Delta specs must use OpenSpec requirement sections:

```markdown
# Delta for <Capability>

## ADDED Requirements

### Requirement: <Requirement name>

The system MUST/SHALL ...

#### Scenario: <Scenario name>

- GIVEN ...
- WHEN ...
- THEN ...

## MODIFIED Requirements

### Requirement: <Existing requirement name>

...

## REMOVED Requirements

### Requirement: <Removed requirement name>
```

Every requirement should include at least one scenario when applicable.

#### Runtime state

Planning may create or update runtime state only under `.ai-factory/state/<change-id>/`.

Use or reference `ensureRuntimeLayout(changeId)` from `scripts/active-change-resolver.mjs` when runtime directories are needed.

Allowed runtime examples:

- `.ai-factory/state/<change-id>/plan-summary.md`
- `.ai-factory/state/<change-id>/validation.json`

Runtime QA output belongs under `.ai-factory/qa/<change-id>/`.

#### OpenSpec validation

When a compatible OpenSpec CLI is available, validate through `scripts/openspec-runner.mjs` using `validateOpenSpecChange(changeId)` or equivalent runner behavior.

The runner command corresponds to:

```bash
openspec validate <change-id> --type change --strict --json --no-interactive --no-color
```

- If validation passes, report success.
- If validation fails, repair generated artifacts when possible or clearly report the failing file, requirement, or section.
- Missing or unsupported OpenSpec CLI is degraded validation, not planning failure.
- Do not install OpenSpec skills or slash commands.

Report generated OpenSpec artifact paths and validation status in the normal planning response. Persist validation evidence only under `.ai-factory/state/<change-id>/` when a runtime file is needed.

### Legacy AI Factory mode

When OpenSpec-native mode is not enabled, preserve the existing legacy companion plan-folder contract.

This mode is legacy AI Factory-only mode. When `/aif-plan full` creates `.ai-factory/plans/<plan-id>.md`, it must also create and keep synchronized the companion folder:

- `.ai-factory/plans/<plan-id>/task.md`
- `.ai-factory/plans/<plan-id>/context.md`
- `.ai-factory/plans/<plan-id>/rules.md`
- `.ai-factory/plans/<plan-id>/verify.md`
- `.ai-factory/plans/<plan-id>/status.yaml`
- `.ai-factory/plans/<plan-id>/explore.md` when active research exists

Treat the plan file as the parent-compatible summary artifact and the folder as the structured execution/state artifact set.
The companion plan file may remain plain upstream markdown; the shared YAML frontmatter contract applies to the plan-folder markdown artifacts, not to the parent-compatible plan file.

### Research Normalization

- In OpenSpec-native mode, do not import research into `openspec/changes/<change-id>/` as runtime-only notes.
- In legacy AI Factory mode, if `.ai-factory/RESEARCH.md` exists, normalize the active summary into plan-local `explore.md`.
- Keep `.ai-factory/RESEARCH.md` read-only.
- In legacy AI Factory mode, record the imported source and timestamp in `status.yaml.history`.

### Plan Resolution and Migration

- In OpenSpec-native mode, use OpenSpec change IDs and the shared active-change vocabulary.
- In legacy AI Factory mode, when the active branch slug matches an existing plan folder without a companion `.md` plan file, generate the missing plan file before continuing.
- In legacy AI Factory mode, record legacy upgrades in `status.yaml.history` with the source folder path and the generated companion plan file path.
- User-facing guidance must present the mode-appropriate canonical artifacts, not a mixed OpenSpec/legacy shape.

### Handoff Rules

- After planning, route the next step to `/aif-improve`.
- Do not mention deprecated orchestration or finalize aliases as active workflow steps.

### Codex Runtime

When running in Codex app/CLI:

- The planning stage (`/aif-plan full`, `/aif-improve`) should run in Codex Plan mode when structured clarifying questions are needed.
- This skill may recommend Plan mode, but it does not attempt or promise to switch the Codex session mode. The user controls the mode.
- In Codex Plan mode, use `request_user_input` only for 1-3 short questions.
- In Codex Default mode, if a question is needed, ask it as plain text in the assistant message. Do not use `question(...)`, `questionnaire(...)`, or `request_user_input`.
- In autonomous or subagent mode, do not ask interactive questions. Record assumptions and return blockers/open questions to the parent.
- See `skills/shared/QUESTION-TOOL.md` for the full runtime question format mapping.
