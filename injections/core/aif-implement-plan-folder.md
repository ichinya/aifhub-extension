## AIFHub Implement OpenSpec-native Override

Read `skills/shared/TOOLS.md` from the AIFHub extension root before choosing artifact paths or lifecycle instructions.

Apply this block before the upstream `aif-implement` body. When any rule below conflicts with the base skill text, this block wins.

Follow `skills/shared/LANGUAGE-POLICY.md` before producing user-facing responses or generated artifacts.

Once artifact classification permits local execution, follow `skills/shared/TEST-QUALITY.md` before selecting or changing an automated check or a readiness wait. This applies to OpenSpec-native and classic legacy execution; preserve marker-first delegation and no-test fallbacks.

Resolve the policy from the AIFHub extension root; in an installed project it is `.ai-factory/extensions/aifhub-extension/skills/shared/TEST-QUALITY.md`. Do not create a replacement policy in the consumer project.

Resolve user-facing prose language in this order: use a usable non-empty `language.ui`; otherwise preserve the current conversation language for this response only; use English only when that language is indeterminate. This rule overrides downstream generic English defaults; do not infer from OS locale or persist the inferred choice. On that hard-English fallback, add exactly one concise setup hint only when the output contract permits human-readable prose, before any required final machine-readable block; never add it inside or after `aif-gate-result`, and never alter exact handoffs, fixed commands, paths, keys/enums, or machine-only output.

### Goal and skill context

Use upstream `/aif-implement` as the canonical execution command. Read `.ai-factory/skill-context/aif-implement/SKILL.md` first, or legacy `.ai-factory/skill-context/aif-implement-plus/SKILL.md` only when absent.

### Mode Detection

Read `.ai-factory/config.yaml` before target resolution. Follow `skills/shared/TOOLS.md`: an explicit `aifhub.tools` mapping wins; only `aifhub.tools.openspec: true` enables OpenSpec-native mode. False, `{}`, or an omitted switch in an existing mapping selects classic. Only when the entire tools mapping is absent, use legacy `artifactProtocol` fallback. Missing config selects classic; malformed config fails closed. Existing OpenSpec files never select a mode.

### Legacy ultra marker-first boundary

For legacy plan migration in an installed project, use the wrapper command `ai-factory aifhub-migrate-legacy-plans <change-id> --dry-run` before any admission write; never invoke a repository-root script path.

In Legacy AI Factory-only mode, classify the normalized project-relative plan entrypoint with `classifyLegacyPlanShape()` from `scripts/legacy-plan-migration.mjs` before folder-only detection, companion discovery, companion plan-file creation, execution metadata hydration, or any `status.yaml` write. Marker validation is first; known companion filenames are considered only after the classifier returns a classic shape.

- For `ultra-valid`, stop all AIFHub companion logic and return the exact upstream handoff `/aif-implement <entrypoint>`. Do not create or synchronize a sibling `<plan-id>.md`, `task.md`, `context.md`, `rules.md`, `verify.md`, `status.yaml`, `explore.md`, or AIFHub task state; upstream owns the complete marked bundle atomically.
- For `ultra-invalid` or `collision`, fail closed before any write and report only bounded `shape`, safe `entrypoint`, and classifier `code` values.
- For `classic-pair` or `classic-folder-only`, continue with the classic companion rules below. An unrelated directory is not a plan.
- Diagnostics may include only `shape`, safe project-relative `entrypoint`, and `handoff`; never include marker bodies, phase contents, request/research bodies, credentials, raw stdout, or raw stderr.

### OpenSpec-native mode

For plan content, read only the canonical OpenSpec artifacts listed below. Do not inspect or mutate `.ai-factory/plans/**` after an OpenSpec change resolves.
Before resolving a change, reading canonical tasks, reconciling requirements, selecting execution form, dispatching, editing, updating progress, or writing traces, **read** `injections/references/aif-implement/openspec-native.md` from the extension root. Every rule there is mandatory for the applicable action, including migration detection, source authority, execution admission, development cycle, generated rules, roadmap deferral, and output.

### Legacy AI Factory-only mode

After marker-first classification, fast plans return the exact upstream handoff `/aif-implement <entrypoint>` without companion reads or local state. Only `classic-pair` or `classic-folder-only` enters the classic workflow.
Before companion discovery/creation, task/status reads, git strategy, execution hydration, edits, dispatch, progress or history writes, **read** `injections/references/aif-implement/classic-sdd.md` from the extension root. Apply all its rules, including missing-plan, compatibility, persistent execution and verification handoffs.

### Shared execution kernel

For SDD-managed OpenSpec or classic work, require a valid current SessionBrief before edits; resolve its exact canonical/task/spec/rules references at full fidelity. Missing, stale, research or invalid context returns the planning owner; unopted changes retain canonical fallback. A brief never authorizes edits or replaces QA.
Implementation and fix runtime context resolves through `buildImplementationContext` / `buildFixContext` in `scripts/openspec-execution-context.mjs`; Supply the exact consumed digest as `trace.sessionBriefDigest` to `writeExecutionTrace()` before canonical checkbox edits; recompile after progress/sync changes. Material changes require the planning owner. Quick profiles never weaken required checks, approval, migration/rollback, verify or done gates.

For enabled Lekalo in SDD-managed OpenSpec or classic work, initialize missing scaffolding through `ai-factory aifhub-mode init --json` before revision binding, then run `ai-factory aifhub-providers implement --change <change-or-plan-id> --write --json`. The exact CLI 1.1.0 / workflow-provider@0.8.0 adapter obtains read-only impact/context with a 5000-token budget. Apply normalized provider blocking and preserve incomplete/fits:false metadata; sha256 references do not expose or reconstruct the private capsule. Do not call generate, drift, sync, install prompt, trace collect or native gates through this adapter. This overlay remains separate from upstream ultra bundle ownership.
A `replan_required` or `blocked` compliance receipt stops remaining work for the planning owner; workers never write `plan-compliance.json`. Tracer needs owner promote plus canonical updates and a fresh brief.

Once artifact classification permits local execution and canonical tasks have been read, follow `skills/shared/TASK-COORDINATION.md` before edits or first dispatch for OpenSpec-native and classic legacy work. The coordinator owns preflight, exact manifest and per-item reconciliation; workers consume only assigned scope. Its installed path is `.ai-factory/extensions/aifhub-extension/skills/shared/TASK-COORDINATION.md`.
Perform service mechanics without a separate AI worker; include the selected execution form and its short reason before admission. Coordination keeps exact digests, freshness checks and parent decision in the coordinator. Keep helper payloads unchanged. Before selecting the next group, reconcile completed items against the manifest. Use the persistent execution rules in the selected reference before local execution or delegation; a present helper rejection must not be bypassed. No task completion without fresh parent acceptance and evidence.

In OpenSpec-native mode, runtime state belongs only under `.ai-factory/state/<change-id>/`; QA is owned by `/aif-verify` under `.ai-factory/qa/<change-id>/`. Do not edit the roadmap or create legacy artifacts. Authoritative next step: `/aif-verify <change-id>`.

### Reference resolution

All paths in this block and its references resolve from the AIFHub extension root, installed as `.ai-factory/extensions/aifhub-extension/`, never relative to the merged upstream SKILL.md. Read only the selected mode reference, and read any further policy before the action it governs. Missing required reference stops that action; do not invent a replacement. Do not install OpenSpec skills/slash commands or route users to deprecated aliases.

### Ownership and source admission

- Reconcile the selected task with canonical requirements before `in_progress` or dispatch.
- A clear unresolved conflict emits `ERROR [requirement-conflict]` and stops without edits or completion signals.
- Unclear authority emits `WARN [requirement-ambiguity]` and stops for clarification.
- Keep `## Original Request`, `## Research Context`, and `## Requirements Reconciliation` read-only.
- Embedded research is the committed scope; compare the exact live source only for drift, never replacement selection.
- Use `resolveUltraResearchSource()` for embedded ultra research, without local selection or hashing heuristics.
- Hydrate available runtime todo state from canonical tasks before edits; otherwise report a concise task snapshot.
- Generated rules guide execution but never replace canonical artifacts or passing gate evidence.
- Preserve sibling execution metadata keys and all unrelated workspace changes.
- A worker result marked completed is unaccepted until its parent checks the actual diff and exact evidence.
- Preserve marker-first order even when no helper, optional tool, or reference is available.
