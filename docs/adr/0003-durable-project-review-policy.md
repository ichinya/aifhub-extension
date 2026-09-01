[Previous: ADR 0002](0002-optional-project-context-glossary.md) | [Back to Documentation](../README.md)

# ADR 0003: Durable project review policy

## Status

Accepted

## Context

Issue #144 requests a configurable `REVIEW.md` with project review rules and a repository-root default for agents that discover instruction files there. Devin Review provides the useful source convention: a Markdown file can describe critical areas, conventions, ignored files, security, and performance guidance. AIFHub also needs explicit ownership and safety boundaries because its review gates, generated rules, OpenSpec artifacts, verification evidence, and future human-review providers have distinct lifecycles.

## Decision

- Add protocol-neutral `reviews.policy_file`, defaulting to root `REVIEW.md`.
- Make `/aif-analyze` create a missing safe scaffold and preserve an existing policy during ordinary bootstrap.
- Make `/aif-mode` preserve/configure the setting without creating or inspecting the file.
- Limit read-only consumers to `/aif-review` and the AIFHub review sidecars through `skills/shared/REVIEW-POLICY.md`.
- Treat review policy as additive guidance below source/tests, canonical requirements, project/generated rules, and accepted architecture decisions.
- Reject absolute, URI-like, escaping, non-Markdown, and directory targets. Missing or empty policy is non-blocking; unsafe or unreadable policy only degrades custom guidance.
- Keep individual findings, comments, replies, resolution state, target revisions, provider state, and receipts out of the durable policy.

## Consequences

Benefits:

- Project review expectations are discoverable across runtimes without turning each review result into permanent policy.
- A configurable path supports repositories that do not want a root policy while retaining the compatible default.
- Review-specific guidance stays separate from implementation/verification rules and from provider-owned session state.

Tradeoffs:

- Markdown policy is intentionally guidance rather than a machine-validated rule schema.
- Review consumers must resolve and validate one additional repository-authored file.
- Projects that need enforceable implementation or completion gates must still encode those requirements in the owning rules, tests, OpenSpec, or workflow policy rather than relying on `REVIEW.md` alone.

## See Also

- [Project Review Policy](../review-policy.md)
- [Context Loading Policy](../context-loading-policy.md)
- [ADR 0002](0002-optional-project-context-glossary.md)
- [Devin Review documentation](https://docs.devin.ai/work-with-devin/devin-review)
