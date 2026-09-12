# Executable task design

Use from `/aif-plan` or `/aif-improve` after the selected mode and target permit local planning/refinement. The `/aif-implement` coordinator may use it read-only during task preflight. Preserve the caller's artifact ownership, research handoff, original request, committed research, task identity and progress rules. Small changes need only their concrete action and completion check.

## Establish what is ready

For a supplied issue, request or plan, separate the reported problem from the proposed solution. Inspect the relevant existing behavior and callers by domain concept, not just a matching symbol or issue title. Distinguish already covered, partly covered, contradicted and not yet verified behavior, with direct source evidence. Finding an implementation does not establish that it works for the reported case. Read-only planning may inspect existing check evidence; it does not gain permission to run a reproduction that needs writes, services or external access.

Reuse settled answers. Name any remaining prerequisite as a missing fact, conflicting requirement, experiment, unavailable access or user-owned decision, together with its smallest next action and owner. A clear description or a worker's availability does not make blocked work ready. Continue independent work while holding only dependent tasks; retain the command's existing research routing when required. Do not change tracker labels, publish tickets, close an issue, create a rejection store or add a new readiness state machine through this reference.

## Plan independently verifiable increments

For new behavioral work, prefer a narrow complete scenario over tasks grouped only by technical layer. Include the layers actually needed by that scenario, its observable result, concrete affected paths/interfaces, prerequisites and inline completion verification. A CLI-only feature does not need an invented UI or database. Size the task around what one bounded assignment can inspect and verify; a file count or an arbitrary context budget does not prove completeness.

For example, importing one valid record through the existing command and reporting its result can be an increment; adding all storage first and leaving every usable import path for later usually is not. Shared foundations can still be explicit prerequisite tasks when a complete scenario cannot reasonably own them. Tie any preparatory refactor to an evidenced obstacle and a behavior-preservation check; do not schedule speculative cleanup.

Record dependencies by the actual output a consumer requires, including interface dependencies across different files. A producer is not complete merely because its worker returned success. Existing coordinator acceptance and progress synchronization remain authoritative; this guidance does not run the `tracer` profile (`ai-factory aifhub-tracer`) or change an explicit fast/full/ultra mode.

## Wide migrations

When one mechanical change fans out across many callers, use expand–migrate–contract if the actual compatibility constraints support it:

1. Add the new representation beside the old, with explicit compatibility behavior and a check for both forms.
2. Migrate bounded caller groups, each depending on the expansion and preserving the compatibility checks. Name any real ordering between groups.
3. Remove the old form only after every required caller is migrated and source inspection plus checks establish that remaining supported consumers do not need it. Include rollback and externally deployed/versioned consumers when relevant.

If intermediate steps cannot remain valid, record the coupled scope and the final integration/verification dependency instead of promising independent green tasks. Use only an already supported and authorized execution arrangement; separate integration branches, parallel writers and automatic merges are not provided by this policy. Do not add permanent compatibility wrappers when a smaller bounded migration meets the requirement.

## Refinement boundaries

Apply this guidance to new tasks or an explicitly requested restructuring of the affected plan. A quality pass does not authorize splitting, merging, reordering, renumbering, reopening or completing existing tasks. In particular, the existing inline-verification migration only appends missing verification and preserves task identity, order, action and checked state. Report a structural improvement as a proposal when it exceeds the caller's permitted refinement; implementation workers return it to the planning owner. Store the result in existing plan/design or execution evidence locations, without creating a second task list or completion authority.
