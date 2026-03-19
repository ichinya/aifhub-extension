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

Then continue with:

```bash
/aif-new "your feature"
/aif-improve
/aif-implement
/aif-verify
/aif-done
```

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
