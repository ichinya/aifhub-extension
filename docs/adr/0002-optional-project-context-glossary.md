[Previous Page](0001-openspec-native-artifact-protocol.md) | [Back to Documentation](../README.md)

# ADR 0002: Optional project context glossary

## Status

Accepted

## Context

AIFHub project context already separates canonical OpenSpec requirements from AI Factory runtime and QA state, but projects lack a bounded source for preferred domain terminology. Issue #127 compared a simple Markdown glossary, Open Knowledge Format (OKF), and hybrid storage.

The first useful producer/consumer path does not need a schema, parser, registry, or new lifecycle stage. It needs a small optional file whose absence cannot break existing projects.

## Decision

- Add `paths.context` as a protocol-neutral config key with configurable `CONTEXT.md` as its default.
- Make `/aif-analyze` the only writer. Creation and patch updates require explicit opt-in and concrete source-grounded terms; empty placeholders are forbidden.
- Treat all other skills, injections, and packaged agents as read-only consumers through the shared language/glossary policy.
- Grant the glossary lexical authority for human-readable prose only. It cannot rename code/API identifiers or override source/tests, canonical OpenSpec requirements, project rules, accepted architecture decisions, or verifiable QA facts.
- Treat missing and empty files as normal. Reject unsafe paths and skip unreadable files with bounded diagnostics that never disclose external paths or glossary contents.
- Keep glossary contents out of generated rules, QA evidence, runtime traces, provider stores, validation gates, and completion gates.

## Consequences

Benefits:

- Existing projects remain compatible without adding a file.
- Projects can preserve stable terminology across commands without creating another canonical artifact.
- Ownership and conflict precedence are explicit and testable.

Tradeoffs:

- The Markdown structure is guidance rather than a machine-validated schema.
- Terminology drift is reported but never synchronized automatically.
- `/aif-analyze` must preserve user-authored and unknown sections during updates.

## Deferred OKF Criteria

OKF remains deferred. Reconsider it only when a concrete producer/consumer use case needs machine-readable interchange, schema validation, cross-project knowledge relationships, or independent tooling. Any OKF implementation requires a separate OpenSpec change and ADR with explicit migration, security, size, and authority boundaries.

## See Also

- [Context Loading Policy](../context-loading-policy.md)
- [Usage](../usage.md)
- [ADR 0001](0001-openspec-native-artifact-protocol.md)
