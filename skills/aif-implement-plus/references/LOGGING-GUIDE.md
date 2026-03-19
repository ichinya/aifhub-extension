# Logging Guide (AIF Implement+)

Use verbose, structured, configurable logs during implementation.

## Required Events

- function entry/exit
- task state transitions (`pending -> in_progress -> completed`)
- external command starts/finishes
- verify/fix loop iteration boundaries
- fallback transitions (`subagent -> local`)

## Minimum Fields

- `level`
- `timestamp`
- `component`
- `message`
- `context` (object)

## Levels

- `DEBUG`: detailed execution flow
- `INFO`: state transitions and milestones
- `WARN`: recoverable issues, fallbacks
- `ERROR`: failures requiring operator attention

## Config

Prefer environment-driven level selection (for example `LOG_LEVEL`).
