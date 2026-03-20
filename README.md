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

`/aif-explore` is replaced by this extension with **config-first, plan-folder-aware** behavior:
- reads context from `.ai-factory/config.yaml`
- understands `.ai-factory/plans/<plan-id>/` and `@path` plan references
- remains thinking-only and writes only `.ai-factory/RESEARCH.md`

`/aif-apply` is the recommended manual orchestration step after planning:
- resolves the active plan folder
- persists the chosen git strategy in `status.yaml`
- runs implement -> quality checks -> verify -> fix -> re-verify -> done
- uses Claude `plan-polisher` / `implementer*` only as an optional mode with local fallback

If you want direct manual control instead, `/aif-implement`, `/aif-verify`, `/aif-fix`, and `/aif-done` remain available.

`/aif-implement` is replaced by this extension with **Implement+** behavior:
- plan-folder execution via `.ai-factory/plans/<plan-id>/`
- status tracking in `status.yaml`
- optional Claude subagent mode (with local fallback)

`/aif-improve` is also replaced by this extension with **Improve+** behavior:
- plan-folder discovery via `.ai-factory/plans/<plan-id>/`
- artifact refinement across `task.md`, `context.md`, `rules.md`, `verify.md`, and `status.yaml`
- optional Claude `plan-polisher` mode (with local fallback)

## Documentation

Detailed documentation is organized in `docs/`:

- `docs/README.md` - docs index
- `docs/usage.md` - commands, workflow, and examples
- `docs/context-loading-policy.md` - bootstrap vs consumer context-loading contract

## Requirements

- ai-factory 2.x CLI

## License

MIT
