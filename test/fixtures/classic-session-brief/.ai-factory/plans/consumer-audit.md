# Consumer audit

## Original Request

Audit consumer behavior; preserve  two spaces.

## Requirements Reconciliation

| Source | Decision |
|---|---|
| request | preserve scope |

## Summary

Consumers need a stable response contract.

## Scope

- src/consumer/**

## Requirements

- The consumer MUST preserve the payload for valid input.
- The consumer MUST reject unsupported versions.

## Acceptance Examples

```json
{"version":2,"payload":"preserved"}
```

## Non-goals

- No storage migration.

## Forbidden Change Surface

- storage/**

## SDD Profile Inputs

```json
{
  "planning_mode": "full",
  "behavior_change": true,
  "modules": 1,
  "repositories": 1,
  "public_api": false,
  "data_migration": false,
  "reversible": true,
  "security_sensitive": false,
  "architecture_novelty": false,
  "requirements_clear": true,
  "expected_files": 2
}
```

## Tasks

- [ ] Task 1: Preserve the consumer payload.
- [ ] Task 2: Verify unsupported versions.
