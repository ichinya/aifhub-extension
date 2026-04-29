# Tasks

## 1. README rewrite

- [x] 1.1 Rewrite `README.md` so the opening user story is `AI Factory UX + OpenSpec artifact protocol`.
- [x] 1.2 Add `## What this extension does` with OpenSpec-native mode as the v1 default story and legacy mode as compatibility only.
- [x] 1.3 Add `## Quick start` with `/aif-analyze`, OpenSpec-native confirmation, `/aif-plan full "<request>"`, optional `/aif-improve <change-id>`, `/aif-implement <change-id>`, `/aif-verify <change-id>`, `/aif-fix <change-id>` on failure, and `/aif-done <change-id>` after passing verification.
- [x] 1.4 Add `## Artifact layout` using the exact canonical/runtime/derived layout and ownership table from `design.md`.
- [x] 1.5 Add concise `## OpenSpec compatibility`, `## Legacy migration`, and `## Troubleshooting` sections that link to the detailed docs.
- [x] 1.6 Remove or relocate README wording that presents `.ai-factory/plans` as the normal OpenSpec-native workflow.
- [x] 1.7 Normalize touched README prose to clean English and remove mojibake or stale legacy-default wording from the first-viewport story.

## 2. Usage guide rewrite

- [x] 2.1 Rewrite `docs/usage.md` around the full v1 flow: `/aif-analyze`, `/aif-plan full "<request>"`, optional `/aif-explore "<topic>"`, optional `/aif-improve <change-id>`, `/aif-implement <change-id>`, `/aif-verify <change-id>`, `/aif-fix <change-id>` if verification fails, and `/aif-done <change-id>` after verification passes.
- [x] 2.2 For `/aif-analyze`, document what it reads, what it writes, and that it never installs OpenSpec skills or commands.
- [x] 2.3 For `/aif-plan full`, document reads from project context and `openspec/specs/**`, writes to `openspec/changes/<change-id>/proposal.md`, `design.md`, `tasks.md`, and `specs/**/spec.md`, and does not write `.ai-factory/plans/<id>.md` or `.ai-factory/plans/<id>/task.md` in OpenSpec-native mode.
- [x] 2.4 For `/aif-explore`, `/aif-improve`, `/aif-implement`, `/aif-verify`, `/aif-fix`, and `/aif-done`, add the same reads/writes/does-not-write shape with exact paths.
- [x] 2.5 Add the concrete OAuth example: `/aif-plan full "add OAuth login"` creates `openspec/changes/add-oauth-login/proposal.md`, `design.md`, `tasks.md`, and `specs/auth/spec.md`; implementation/verification/done writes `.ai-factory/state/add-oauth-login/` and `.ai-factory/qa/add-oauth-login/`.
- [x] 2.6 Add troubleshooting entries for OpenSpec CLI missing, Node too old, invalid delta spec, ambiguous active change, missing or stale generated rules, and dirty working tree before `/aif-done`.
- [x] 2.7 Keep legacy AI Factory-only mode as a compatibility section, not a normal creation path.
- [x] 2.8 Rewrite the release smoke check so the default smoke result is `openspec/changes/<change-id>/` plus `.ai-factory/state/<change-id>/` and `.ai-factory/qa/<change-id>/`; legacy `.ai-factory/plans/` expectations must appear only under legacy AI Factory-only mode.
- [x] 2.9 Normalize touched `docs/usage.md` prose to clean English and remove mojibake from command explanations and validation sections.

## 3. Context-loading and compatibility policy

- [x] 3.1 Rewrite `docs/context-loading-policy.md` so OpenSpec-native consumer skills load `openspec/changes/<change-id>/proposal.md`, `design.md`, `tasks.md`, `specs/**/spec.md`, `openspec/specs/**/spec.md`, `.ai-factory/rules/generated/*.md`, `.ai-factory/state/<change-id>/**`, and `.ai-factory/qa/<change-id>/**`.
- [x] 3.2 Document `.ai-factory/plans/<id>/task.md`, `context.md`, `rules.md`, `verify.md`, `status.yaml`, and related legacy files as legacy AI Factory-only mode or migration input only.
- [x] 3.3 Update `docs/openspec-compatibility.md` to clearly state OpenSpec is optional, supported CLI range is `>=1.3.1 <2.0.0`, Node requirement is `>=20.19.0`, missing CLI degrades gracefully, AIFHub does not install OpenSpec skills/commands, and `openspec init --tools none` is optional.
- [x] 3.4 Include the current `scripts/openspec-runner.mjs` capability shape with `available`, `canValidate`, `canArchive`, `version`, `supportedRange`, `requiresNode`, `nodeVersion`, `nodeSupported`, `versionSupported`, `reason`, and `errors`, while keeping `available`, `canValidate`, `canArchive`, `version`, `supportedRange`, and `requiresNode` as the documented stable minimum.

## 4. Migration guide and cross-links

- [x] 4.1 Update `docs/legacy-plan-migration.md` with real commands from `scripts/migrate-legacy-plans.mjs`: `--list`, single-plan `--dry-run`, single-plan migrate, `--all --dry-run`, `--all`, `--on-collision fail|merge-safe|suffix|overwrite`, and `--json`.
- [x] 4.2 Document the exact legacy-to-OpenSpec/runtime/QA mapping from `design.md`.
- [x] 4.3 Document collision behavior, validation after migration when the CLI is available, missing-CLI degraded behavior, no silent deletion of legacy files, and the post-migration `/aif-improve <change-id>` step.
- [x] 4.4 Update `docs/README.md` reading order, links, and scope text so README, usage, context-loading policy, compatibility, migration, active-change resolver, and ADR 0001 form a clear loop and no longer describe the companion plan-file plus plan-folder model as the normal v1 documentation scope.
- [x] 4.5 Update `docs/active-change-resolver.md` only if needed for ambiguous active-change troubleshooting or cross-links.
- [x] 4.6 Update `docs/adr/0001-openspec-native-artifact-protocol.md` only for small consistency corrections; keep it as an ADR.

## 5. Validation

- [x] 5.1 Run `npm run validate`.
- [x] 5.2 Fix any doc-link failures or empty plan placeholder failures.
- [x] 5.3 Run `npm test`.
- [x] 5.4 If tests fail because docs contain legacy paths, ensure those paths are clearly gated under legacy AI Factory-only mode or migration sections rather than deleting legitimate migration documentation.
- [x] 5.5 Confirm the final diff is docs-only except for tiny doc-link/test fixes if validation requires them.
- [x] 5.6 Manually check root `README.md` links and anchors because `scripts/validate-doc-links.mjs` scans `docs/`, `injections/`, and `skills/`, but not the repository root README.
- [x] 5.7 Attempt OpenSpec validation for `rewrite-v1-openspec-native-docs`; if the OpenSpec CLI is missing or unsupported, record degraded validation evidence instead of treating missing CLI as an implementation failure.
  Evidence: `openspec validate rewrite-v1-openspec-native-docs --type change --strict --json --no-interactive --no-color` returned `CommandNotFoundException`; this is degraded missing-CLI evidence, not an implementation failure.

## Suggested Commit Plan

Not executed as part of this issue because the scope excludes git commit creation.

- Commit 1: `docs: rewrite v1 OpenSpec-native workflow docs`
- Commit 2: `docs: clarify legacy migration and compatibility policy`
- Commit 3: `test: align documentation link checks if needed`
