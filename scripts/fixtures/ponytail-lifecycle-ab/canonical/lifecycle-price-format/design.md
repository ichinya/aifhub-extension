## Context
`Price` stores integer-backed cents-like values with a configurable decimal `precision`. String rendering must never convert the full value to float because values above 2^53 lose the last digits.

## Goals
- Exact rendering at scale implied by precision using integer arithmetic only.
- Uniform thousand separator (space) and decimal comma.

## Non-Goals
- Changing storage format, currency validation, or `value()` semantics.
