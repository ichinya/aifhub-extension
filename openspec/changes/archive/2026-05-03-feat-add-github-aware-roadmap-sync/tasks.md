# Tasks

## 1. Planning and specs

- [x] 1.1 Review issue #13 and current `/aif-roadmap` prompt assets.
  Files: `injections/core/aif-roadmap-maturity-audit.md`, `injections/references/aif-roadmap/roadmap-template.md`, `injections/references/aif-roadmap/slice-checklist.md`
  Logging: no runtime logging; document source issue and assumptions in implementation notes.

- [x] 1.2 Refine this delta spec if `/aif-improve` finds missing scenarios.
  Files: `openspec/changes/feat-add-github-aware-roadmap-sync/specs/roadmap-github-sync/spec.md`
  Logging: no runtime logging; report touched canonical OpenSpec artifact paths.

## 2. Contract tests

- [x] 2.1 Add targeted prompt contract tests for GitHub-aware roadmap rules.
  Files: `scripts/openspec-prompt-assets.test.mjs`
  Deliverable: assertions cover GitHub evidence availability, partial/unavailable GitHub handling, supporting-evidence status, local proof requirement, write boundaries, drift detection, credential-safe output, and optional link behavior.
  Logging: assertion messages must name the prompt or reference asset and missing contract phrase.
  Dependency notes: tests should not call GitHub or require network.

- [x] 2.2 Ensure roadmap reference assets are included in the targeted contract surface.
  Files: `scripts/openspec-prompt-assets.test.mjs`, `injections/references/aif-roadmap/roadmap-template.md`, `injections/references/aif-roadmap/slice-checklist.md`
  Deliverable: tests verify the roadmap template/checklist can preserve local evidence paths plus optional GitHub milestone/issue/PR links without requiring GitHub links for every item.
  Logging: assertion messages should stay file-specific.
  Dependency notes: depends on Task 2.1.

## 3. Prompt asset behavior

- [x] 3.1 Add GitHub-aware evidence guidance to the roadmap injection.
  Files: `injections/core/aif-roadmap-maturity-audit.md`
  Deliverable: `/aif-roadmap` may read GitHub milestones, issues, PRs, labels, linked branches, and local git tree state when available; GitHub remains supporting evidence and collection is non-blocking when unavailable or partial.
  Logging: roadmap responses should summarize whether GitHub evidence was used, unavailable, or partially available.
  Dependency notes: depends on Tasks 2.1-2.2.

- [x] 3.2 Add explicit completion and drift rules.
  Files: `injections/core/aif-roadmap-maturity-audit.md`
  Deliverable: closed issues and merged PRs never mark roadmap entries `done` without local OpenSpec/source/test/QA evidence; roadmap audit reports drift between GitHub and local repository state.
  Logging: roadmap responses should name drift categories and evidence paths or GitHub links.
  Dependency notes: can be implemented with Task 3.1.

- [x] 3.3 Add credential-safe output and read-only GitHub boundaries.
  Files: `injections/core/aif-roadmap-maturity-audit.md`
  Deliverable: prompt says not to mutate GitHub issues, milestones, PRs, or labels; roadmap output must not include tokens, authorization headers, raw credential helper output, or private authentication diagnostics.
  Logging: roadmap responses may summarize GitHub access failures in sanitized form.
  Dependency notes: can be implemented with Task 3.1.

- [x] 3.4 Update roadmap reference assets for GitHub-linked evidence.
  Files: `injections/references/aif-roadmap/roadmap-template.md`, `injections/references/aif-roadmap/slice-checklist.md`
  Deliverable: template/checklist allow local artifact links plus optional GitHub milestone/issue/PR links without making links mandatory for every entry.
  Logging: no runtime logging; keep template concise.
  Dependency notes: depends on Task 3.1 wording.

## 4. Documentation

- [x] 4.1 Update docs only where `/aif-roadmap` evidence sources or GitHub context policy are described.
  Files: `docs/usage.md`, `docs/context-loading-policy.md`, `docs/README.md`, `README.md` if affected
  Deliverable: docs explain GitHub-aware roadmap sync as supporting evidence and preserve OpenSpec-native canonical priority.
  Logging: docs-only; no runtime logging.
  Dependency notes: avoid broad docs rewrite.

## 5. Verification

- [x] 5.1 Run targeted tests.
  Files: `scripts/openspec-prompt-assets.test.mjs`
  Commands: `openspec validate feat-add-github-aware-roadmap-sync --type change --strict --json --no-interactive --no-color`, `node --test scripts/openspec-prompt-assets.test.mjs`
  Logging: report command result in normal response and later QA evidence.

- [x] 5.2 Run repository validation and tests.
  Files: changed prompt assets, docs, and tests
  Commands: `npm run validate`, `npm test`, `git diff --check`
  Logging: report command results in normal response and later QA evidence.

## Commit Plan

- [ ] `test: cover github-aware roadmap evidence contracts`
  Scope: Tasks 2.1-2.2
- [ ] `feat: add github-aware roadmap guidance`
  Scope: Tasks 3.1-3.4
- [ ] `docs: document github-aware roadmap evidence`
  Scope: Tasks 4.1-5.2
