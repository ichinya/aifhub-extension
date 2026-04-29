# Safety Contract

`aif-mode` coordinates mode switching and artifact sync. It is intentionally conservative.

## Forbidden Actions

Never:

- delete `openspec/`
- delete `.ai-factory/plans/`
- archive OpenSpec changes
- run `/aif-done`
- mutate `openspec/specs/**` manually
- install OpenSpec skills or slash commands
- call OpenSpec slash commands such as `/opsx:propose`, `/opsx:apply`, or `/opsx:archive`
- overwrite legacy or OpenSpec artifacts without an explicit option
- create runtime-only files inside `openspec/changes/<id>/`

## Allowed Actions

The command may:

- update `.ai-factory/config.yaml`
- create skeleton directories
- create `openspec/config.yaml` when missing
- run legacy migration through `scripts/migrate-legacy-plans.mjs`
- export compatibility legacy artifacts when explicitly requested
- compile generated rules through `scripts/openspec-rules-compiler.mjs`
- run OpenSpec validate/status through `scripts/openspec-runner.mjs`
- let other AIFHub skills request OpenSpec instructions/archive through `scripts/openspec-runner.mjs`
- write reports under `.ai-factory/state/mode-switches/`
- update `.ai-factory/state/current.yaml` only when explicitly requested

## Dry Run

`--dry-run` must not write files. It may inspect existing artifacts, resolve changes, detect collisions, and report planned operations.

## Collision Handling

Legacy migration uses the migration script's collision policy. Compatibility export defaults to fail-on-collision and only overwrites when `--yes` is passed.

## OpenSpec CLI

Treat missing or unsupported OpenSpec CLI as degraded capability for status, switching, planning, and sync. Treat archive-required `/aif-done` readiness as failed when compatible archive capability is unavailable.
