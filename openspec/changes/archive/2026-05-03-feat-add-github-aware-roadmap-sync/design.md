# Design: feat: add GitHub-aware roadmap sync

## Technical Approach

This is a prompt-asset and contract-test change. `/aif-roadmap` remains an upstream AI Factory command augmented by `injections/core/aif-roadmap-maturity-audit.md`; the extension should not add a new orchestration skill for roadmap sync.

The implementation should update the roadmap injection so it has three evidence layers:

1. Canonical local evidence:
   - `openspec/specs/**`
   - `openspec/changes/<change-id>/proposal.md`
   - `openspec/changes/<change-id>/design.md`
   - `openspec/changes/<change-id>/tasks.md`
   - `openspec/changes/<change-id>/specs/**/spec.md`
   - `.ai-factory/rules/generated/**`
   - `.ai-factory/state/<change-id>/`
   - `.ai-factory/qa/<change-id>/`
   - source tree, tests, and CI definitions
2. Git and checkout evidence:
   - current branch and remote;
   - dirty working tree;
   - recent commits, tags, and merge commits;
   - current tree and changed files.
3. GitHub supporting evidence when available:
   - milestones;
   - issues with state, labels, assignees, and milestone;
   - PRs with state, merge status, base/head refs, and linked issues;
   - linked branches.

The roadmap audit should use GitHub items as links and planning signals, not as automatic completion proof.

GitHub evidence acquisition should be adapter-agnostic. The prompt can ask the agent to use whatever GitHub context is already available in the runtime, including `gh`, connector results, explicit issue/PR URLs, or caller-provided metadata. It should not require a new helper module for this change, and it should not fail roadmap generation when GitHub access is missing, unauthenticated, rate-limited, or partial.

Credential safety belongs in the prompt contract: roadmap output may include stable public identifiers such as issue numbers, PR numbers, milestone names, titles, states, and URLs, but must not include tokens, authorization headers, raw credential helper output, or private authentication diagnostics.

## Data / Artifact Model

No new runtime data model is required.

Relevant write targets:

- `.ai-factory/ROADMAP.md` remains owned by `/aif-roadmap`.

Relevant read targets:

- Existing OpenSpec-native evidence from `injections/core/aif-roadmap-maturity-audit.md`.
- GitHub evidence provided by the caller/runtime, `gh` output, connector output, or explicit URLs.
- Git state available through local git commands.

Prompt contract tests should model the behavior as text contracts in `scripts/openspec-prompt-assets.test.mjs` or a focused companion test. They should not require network access.

Test-first implementation is preferred:

1. Add failing contract assertions for the roadmap injection and reference assets.
2. Update prompt/reference assets until the targeted tests pass.
3. Update documentation only where evidence loading behavior is described.
4. Run full validation.

## Integration Points

- `extension.json` already injects `./injections/core/aif-roadmap-maturity-audit.md` into upstream `aif-roadmap`.
- `injections/references/aif-roadmap/roadmap-template.md` controls the expected roadmap layout.
- `injections/references/aif-roadmap/slice-checklist.md` defines evidence slices and evidence notes.
- `scripts/openspec-prompt-assets.test.mjs` already owns instruction-level prompt contracts and should be extended before broad prompt edits.
- `.ai-factory/ROADMAP.md` is the output artifact updated by `/aif-roadmap`, but this plan must not update it directly.
- GitHub issue #13 is the source issue and should be referenced in implementation notes or docs where useful.

## Alternatives Considered

- Add a deterministic Node helper that calls GitHub APIs. Rejected for this change because issue #13 is about `/aif-roadmap` behavior and evidence guidance; introducing runtime API code would expand scope into authentication, rate limits, offline behavior, and connector differences.
- Treat GitHub as primary roadmap source. Rejected because the project architecture says OpenSpec is canonical and AI Factory is runtime; GitHub issue state must not override missing local artifacts or QA evidence.
- Update `.ai-factory/ROADMAP.md` immediately during planning. Rejected because `/aif-plan` owns canonical OpenSpec planning artifacts, while `/aif-roadmap` owns roadmap updates.

## Risks

- Overly rigid prompt tests could fail harmless wording changes. Prefer assertions for core concepts: GitHub supporting evidence, local proof requirement, drift detection, and write boundaries.
- The roadmap template can become noisy if every entry requires multiple GitHub links. The prompt should say "where useful" and preserve manual notes.
- If `gh` is unavailable, the roadmap command must continue with local evidence and report that GitHub evidence was unavailable.
- If `gh` returns authentication or rate-limit errors, the prompt must not copy raw credential diagnostics into the roadmap.
- Merged PRs may not map one-to-one to OpenSpec changes. The audit should link them as supporting evidence and call out unmatched items as drift only when local evidence is actually missing or contradictory.
