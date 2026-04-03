## AIFHub Extension Override

When working in a repository that uses this extension:

- Treat `.ai-factory/plans/<plan-id>/` as the canonical active plan context.
- If `@path` points to a plan folder or one of its artifacts (`task.md`, `context.md`, `rules.md`, `verify.md`, `status.yaml`, `explore.md`), prefer that plan-folder context over legacy branch-plan files.
- Persist exploration only to `config.paths.research` / `.ai-factory/RESEARCH.md`.
- Do not treat `DESCRIPTION.md`, `ARCHITECTURE.md`, `ROADMAP.md`, or `RULES.md` as writable from explore mode in this extension workflow.
- For next steps, prefer:
  - `/aif-new "<task>"` for new work
  - `/aif-improve-plus <plan-id>` for plan-folder refinement
  - `/aif-apply <plan-id>` for orchestrated execution
  - `/aif-implement-plus <plan-id>` for direct plan-folder execution

If this override conflicts with the base `aif-explore` wording, follow the extension workflow rules above.
