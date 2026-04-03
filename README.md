# AIFHub Extension

Extension for [ai-factory 2.x](https://github.com/lee-to/ai-factory) CLI with a spec-driven workflow for AI agents.

## Quick Start

```bash
ai-factory extension add https://github.com/ichinya/aifhub-extension.git
```

Run:

```bash
/aif-analyze
```

Then continue with the recommended workflow:

```bash
/aif-explore "your feature"   # optional exploration
/aif-new "your feature"
/aif-improve
/aif-apply
```

`/aif-explore` stays upstream AI Factory and is extended by this extension via injection:

- reads context from `.ai-factory/config.yaml`
- understands `.ai-factory/plans/<plan-id>/` and `@path` plan references
- remains thinking-only and writes only `.ai-factory/RESEARCH.md`

`/aif-apply` is the recommended manual orchestration step after planning:

- resolves the active plan folder
- persists the chosen git strategy in `status.yaml` and applies it locally before implementation starts
- runs `/aif-implement` as the single owner of task execution, progress sync, and the verify/fix loop
- routes passing plans to `/aif-done` after re-reading the resulting verification state

Built-in AI Factory commands such as `/aif-verify`, `/aif-fix`, `/aif-roadmap`, and `/aif-evolve` remain
and are extended via injections where needed.

`/aif-implement` is handled as built-in + injection for the plan-folder execution workflow:

- plan-folder execution via `.ai-factory/plans/<plan-id>/`
- status tracking in `status.yaml`
- optional Claude subagent mode (with local fallback)

`/aif-improve` is handled as built-in + injection for the plan-folder refinement workflow:

- plan-folder discovery via `.ai-factory/plans/<plan-id>/`
- artifact refinement across `task.md`, `context.md`, `rules.md`, `verify.md`, and `status.yaml`
- optional Claude `plan-polisher` mode (with local fallback)

`/aif-roadmap` is also extended via injection with the extension's evidence-based maturity audit rules.

`/aif-verify` and `/aif-fix` are now also handled as built-in + injection for the extension's plan-folder workflow.

There are no remaining explicit `*-plus` workflow commands.

## Documentation

Detailed documentation is organized in `docs/`:

- `docs/README.md` - docs index
- `docs/usage.md` - commands, workflow, and examples
- `docs/context-loading-policy.md` - bootstrap vs consumer context-loading contract

## Requirements

- **ai-factory CLI**: `>=2.8.0 <3.0.0` (see `extension.json` → `compat.ai-factory`)

This extension tracks upstream compatibility in `extension.json`:

| Field                | Purpose                                   |
|----------------------|-------------------------------------------|
| `compat.ai-factory`  | Semver range for ai-factory compatibility |
| `sources.ai-factory` | Last reviewed upstream release + notes    |

`sources.ai-factory.version` is the upstream release last reviewed against this extension.
`sources.ai-factory.baselineVersion` keeps the historical migration baseline for internal tracking.

## Update Behavior

AI Factory re-applies injections automatically on update.

- `ai-factory update` refreshes base skills, then re-applies extension injections
- `ai-factory extension update` refreshes the installed extension copy from its source
- This extension now relies on built-in skills + injections instead of `replaces`, so canonical built-in commands should survive updates cleanly

`/aif-analyze` checks compatibility and warns if your ai-factory version is outside the supported range.

## License

MIT
