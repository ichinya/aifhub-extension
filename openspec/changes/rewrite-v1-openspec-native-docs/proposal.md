# Proposal: Rewrite v1 OpenSpec-native workflow docs

## Intent

Issue #37 is the final v1 public documentation pass. The docs need to present one canonical artifact protocol: AI Factory remains the user-facing workflow, while OpenSpec owns canonical specs and changes in OpenSpec-native mode.

The current docs already mention OpenSpec-native behavior, but the landing page and usage guide still mix older plan-folder language into the normal workflow. That makes it too easy for users to treat `.ai-factory/plans` as the current canonical artifact model.

## Scope

In scope:

- Rewrite `README.md` around the v1 OpenSpec-native user story.
- Rewrite `docs/usage.md` to document the complete command flow and each command's reads, writes, and forbidden writes.
- Rewrite `docs/context-loading-policy.md` so OpenSpec-native context is canonical and legacy plan files are explicitly legacy-only or migration input.
- Tighten `docs/openspec-compatibility.md` around optional CLI behavior, supported versions, Node requirement, capability flags, and the no-OpenSpec-skills policy.
- Expand `docs/legacy-plan-migration.md` with the real migration commands, artifact mapping, dry-run behavior, collision behavior, validation behavior, and post-migration `/aif-improve <change-id>` guidance.
- Update `docs/active-change-resolver.md`, `docs/adr/0001-openspec-native-artifact-protocol.md`, and `docs/README.md` only for small consistency or cross-link fixes.
- Add troubleshooting coverage for missing CLI, old Node, invalid delta specs, ambiguous active changes, stale generated rules, and dirty working tree before `/aif-done`.
- Keep all public examples aligned with the current generated OpenSpec layout and runtime/QA paths.

Out of scope:

- New runtime behavior.
- New OpenSpec runner behavior.
- Installing OpenSpec skills or slash commands.
- Custom OpenSpec schema work.
- TOON, context, KB, or AIFHub registry work.
- Git commit or PR creation.
- Generated-rules behavior changes.
- Migration behavior changes except tiny docs/test fixes required by validation.

## Approach

Treat the docs as a single product surface instead of patching isolated sections. Start from `README.md`, then make `docs/usage.md` the detailed workflow guide. Use the same canonical artifact layout and ownership wording everywhere.

Keep legacy `.ai-factory/plans` documentation, but move it behind "Legacy AI Factory-only mode" and migration language. Do not describe legacy plan-folder artifacts as the normal v1 path.

Use the actual repository commands for migration:

- `node scripts/migrate-legacy-plans.mjs --list`
- `node scripts/migrate-legacy-plans.mjs <change-id> --dry-run`
- `node scripts/migrate-legacy-plans.mjs <change-id>`
- `node scripts/migrate-legacy-plans.mjs --all --dry-run`
- `node scripts/migrate-legacy-plans.mjs --all`
- optional package wrapper `npm run migrate:legacy-plans -- <args>`

Run `npm run validate` and `npm test` after the docs rewrite. If validation fails because legitimate migration sections mention legacy paths, tighten the surrounding wording instead of deleting migration documentation.

## Risks / Open Questions

- The repository still has older `.ai-factory` project context files that describe the pre-OpenSpec plan-folder model. Do not use those as the source of truth for this docs pass; the issue text and current OpenSpec/runtime scripts are authoritative.
- Doc-link validation scans `docs/`, `injections/`, and `skills/`, but not the root README. Still check root README links manually while editing.
- Prompt contract tests may assert exact OpenSpec and legacy wording in injections. This issue is docs-only, so avoid prompt asset changes unless a test proves a tiny link or wording fix is required.
