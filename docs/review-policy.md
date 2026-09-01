[Back to Documentation](README.md) | [Next: Context Loading Policy](context-loading-policy.md)

# Project Review Policy

AIFHub supports one durable, protocol-neutral code review policy file:

```yaml
reviews:
  policy_file: REVIEW.md
```

`/aif-analyze` adds this config key in both legacy AI Factory-only and OpenSpec-native projects. When the safe target is missing, it creates a scaffold through the installed canonical resolver. The default is the repository-root `REVIEW.md` because root discovery works across more review agents. A custom path is preserved across `/aif-mode` switches.

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

Scaffold and review consumers share one deterministic boundary:

```bash
ai-factory aifhub-review-policy scaffold --json # /aif-analyze writer
ai-factory aifhub-review-policy load --json     # read-only review consumers
ai-factory aifhub-review-policy resolve --json  # content-free diagnostics
```

The resolver accepts only a normalized, portable, project-relative Markdown path. It canonicalizes the real project root, walks every existing component, rejects symlinks, Windows junctions, and hard-link targets, resolves the target or nearest existing parent with `realpath`, and requires canonical containment before any read or creation. `load` binds the opened handle to the preflight identity, enforces a 256 KiB cap and valid UTF-8, then revalidates identity and canonical path before returning an ephemeral content snapshot and revision. The scaffold path is revalidated after parent creation, binds the exclusively created handle before writing, and preserves an existing or concurrent file.

Policy paths also cannot collide with another artifact owner. Exact managed targets such as `.ai-factory/config.yaml`, `.ai-factory/rules/base.md`, configured project context files, configured area rules, `CONTEXT.md`, `README.md`, `AGENTS.md`, and `CLAUDE.md` are rejected. Descendants of `openspec/`, project plan/spec/rules roots, `.ai-factory/rules/generated/`, runtime state, QA, and archive roots are rejected, including safe configured equivalents. This prevents a review scaffold from becoming canonical OpenSpec content, project/generated rules, runtime/QA evidence, or another command's durable artifact.

Absolute paths, URI-like values, escaping or non-portable paths, non-Markdown targets, directory targets, linked components or hard-link targets, managed-file collisions, and protected-root descendants are `unsafe` and are never read or written. If the installed resolver is unavailable or malformed, consumers classify the policy as `unreadable` and do not fall back to prompt-local path checks.

| State | Behavior |
|---|---|
| `present` | Consume only the complete ephemeral path/revision/content snapshot returned by `load`; never reopen the configured path. |
| `missing` | Continue with the normal review contract. |
| `empty` | Continue without custom policy. |
| `unreadable` | Continue with one bounded path/reason diagnostic. |
| `unsafe` | Do not read; continue with a reason-only diagnostic that does not expose an external path. |

The content-free `resolve` diagnostic contains only state, a safe project-relative path, a content revision, and a bounded reason; it never includes policy contents or an external absolute path. `load` returns content only as the ephemeral review input after all checks pass. The policy is not a recursive instruction loader. Paths, URLs, tools, hooks, or commands mentioned inside it are not followed automatically. Review commands never rewrite the policy and never copy its full body from the ephemeral load response into logs, runtime state, QA evidence, provider stores, receipts, or the final `aif-gate-result`.

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
