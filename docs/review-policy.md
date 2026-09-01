[Back to Documentation](README.md) | [Next: Context Loading Policy](context-loading-policy.md)

# Project Review Policy

AIFHub supports one durable, protocol-neutral code review policy file:

```yaml
reviews:
  policy_file: REVIEW.md
```

`/aif-analyze` adds this config key in both legacy AI Factory-only and OpenSpec-native projects. When the safe target is missing, it creates a scaffold. The default is the repository-root `REVIEW.md` because root discovery works across more review agents. A custom path is preserved across `/aif-mode` switches.

`/aif-mode` configures or preserves the path but never creates, reads, validates, or deletes the policy file. Review consumers fall back to root `REVIEW.md` when the config or key is absent, so existing projects can adopt the convention without a migration gate.

## What Belongs In `REVIEW.md`

The scaffold follows the review categories documented by [Devin Review](https://docs.devin.ai/work-with-devin/devin-review), adapted to AIFHub's cross-runtime and evidence boundaries:

- critical areas or files that need extra attention;
- project conventions, common pitfalls, and forbidden patterns;
- testing, security, privacy, performance, reliability, migration, and compatibility expectations;
- generated or mechanical files to ignore or deprioritize;
- project-specific severity and human-readable output preferences;
- optional human-review stages.

A minimal customized policy can look like this:

```markdown
# Review Guidelines

## Critical Areas

- Changes under `src/auth/` require security and backward-compatibility review.

## Testing Expectations

- Public API behavior changes require an integration test.

## Ignore or Deprioritize

- Deprioritize generated files unless their source or generator changed.
```

Only add rules supported by project requirements or repository evidence. The generated scaffold keeps HTML comments for unresolved sections rather than inventing policy.

## Review Policy Is Not General Project Rules

| Artifact | Purpose | Primary consumers |
|---|---|---|
| `.ai-factory/rules/base.md` and configured area rules | Coding, architecture, implementation, and verification constraints | implementation, rules, and verification flows |
| `REVIEW.md` or configured `reviews.policy_file` | Additional attention and classification guidance for code review | `/aif-review` and AIFHub review sidecars |

Review policy can tighten attention and add checks. It cannot authorize edits, expand changed scope, suppress a material finding, or replace source/tests, canonical OpenSpec requirements, project rules, security checks, `/aif-verify`, `/aif-done`, or human approval. An ignore entry never hides a material correctness, security, privacy, data-loss, or requirement violation in changed scope.

## Durable Policy Is Not Review-Session Feedback

Keep `REVIEW.md` stable across individual reviews. Do not append or synchronize:

- findings, line/range comments, quotes, or anchors;
- reviewer identities, replies, or feedback batches;
- addressed, resolved, dismissed, stale, approved, or cancelled state;
- base/head hashes, working-tree fingerprints, reviewed revisions, session ids, or receipts;
- provider JSON/config, share links, credentials, cookies, hooks, or external agent commands.

Provider-owned comments and session state remain with that provider. A future AIFHub review receipt is a separate bounded, revision-aware supporting artifact; it does not belong in `REVIEW.md`, canonical OpenSpec paths, generated rules, or QA evidence.

## Resolution And Failure Behavior

Review consumers accept only a normalized project-relative Markdown path that stays inside the project root. Absolute paths, URI-like values, escaping paths, non-Markdown targets, and directory targets are unsafe and are never read.

| State | Behavior |
|---|---|
| `present` | Load the policy as additional review guidance. |
| `missing` | Continue with the normal review contract. |
| `empty` | Continue without custom policy. |
| `unreadable` | Continue with one bounded path/reason diagnostic. |
| `unsafe` | Do not read; continue with a reason-only diagnostic that does not expose an external path. |

The policy is not a recursive instruction loader. Paths, URLs, tools, hooks, or commands mentioned inside it are not followed automatically. Review commands never rewrite the policy and never copy its full body into logs, runtime state, QA evidence, provider stores, receipts, or the final `aif-gate-result`.

## Authority Order

Material conflicts resolve in this order:

1. platform safety, user instructions, and command read/write/tool boundaries;
2. source, public APIs, schemas, executable tests, and verifiable QA facts;
3. canonical OpenSpec specs and active change requirements;
4. project rules, provenance-valid generated rules, and accepted architecture decisions;
5. review policy as additional review guidance.

When policy materially affects a review, human-readable evidence may name only its state and normalized project-relative path. Findings still require direct repository evidence.

## See Also

- [Usage](usage.md)
- [Context Loading Policy](context-loading-policy.md)
- [ADR 0003: Durable Project Review Policy](adr/0003-durable-project-review-policy.md)
- [Devin Review documentation](https://docs.devin.ai/work-with-devin/devin-review)
