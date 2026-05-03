# Proposal: feat: add GitHub-aware roadmap sync

## Intent

`/aif-roadmap` уже работает как evidence-based maturity audit, но его evidence source set локален: `.ai-factory` context, OpenSpec artifacts, generated rules, runtime state, QA evidence, source tree, tests и CI. Issue #13 требует добавить GitHub-aware evidence layer, чтобы roadmap мог учитывать milestones, issues, PRs, labels, linked branches и git tree state, не превращая GitHub в единственный source of truth.

Цель изменения: расширить roadmap planning/audit guidance так, чтобы GitHub context использовался как supporting evidence, а статусы `done` продолжали требовать локального подтверждения через canonical OpenSpec artifacts, QA evidence, source tree, tests или CI.

## Scope

- In scope:
  - Обновить `injections/core/aif-roadmap-maturity-audit.md` GitHub-aware evidence правилами.
  - Обновить `injections/references/aif-roadmap/roadmap-template.md` и при необходимости `slice-checklist.md`, чтобы roadmap мог ссылаться на GitHub milestones/issues/PRs рядом с локальными evidence paths.
  - Добавить prompt/contract tests, которые фиксируют GitHub как supporting evidence, запрет `done` только по closed issue/merged PR, drift detection, credential-safe output и OpenSpec-native canonical priority.
  - Обновить минимальную пользовательскую документацию, если `/aif-roadmap` behavior или context-loading policy описывают evidence source set.
  - Использовать issue #13 как source issue для формулировок и acceptance criteria.
- Out of scope:
  - Создание GitHub API runtime helper или MCP/connector abstraction.
  - Автоматическое закрытие GitHub issues, изменение milestones или создание PRs.
  - Требование обязательной GitHub authentication, network access или `gh` availability для roadmap generation.
  - Перегенерация `.ai-factory/ROADMAP.md` в рамках этого plan step.
  - Изменение `/aif-done`, `/aif-verify`, OpenSpec archive/finalization behavior.
  - Возврат legacy `.ai-factory/plans` как canonical workflow.

## Approach

1. Treat `/aif-roadmap` as GitHub-aware when GitHub context is available through the runtime environment, `gh`, connector output, or already-provided issue/PR links.
2. Make GitHub evidence additive:
   - milestones;
   - open/closed issues;
   - open/merged/closed PRs;
   - labels;
   - linked branches;
   - current git tree, changed files, tags, and recent commits.
3. Keep GitHub collection non-blocking:
   - if `gh` is missing, unauthenticated, rate-limited, or unavailable, continue from local evidence;
   - summarize unavailable or partial GitHub evidence in the normal response;
   - never write tokens, credentials, or raw authentication diagnostics into `.ai-factory/ROADMAP.md`.
4. Require comparison against local evidence before status changes:
   - `openspec/specs/**`;
   - `openspec/changes/**`;
   - `.ai-factory/state/**`;
   - `.ai-factory/qa/**`;
   - `.ai-factory/rules/generated/**`;
   - source tree;
   - tests and CI.
5. Add drift detection rules:
   - GitHub says done, but local artifacts/tests/QA are missing;
   - local implementation exists, but roadmap or GitHub issue remains stale;
   - OpenSpec change exists, but no linked roadmap/milestone/issue is visible;
   - merged PR exists, but current tree does not contain the expected files or evidence.
6. Keep write ownership unchanged: `/aif-roadmap` may update only `.ai-factory/ROADMAP.md`; it must not mutate GitHub, OpenSpec canonical artifacts, runtime state, QA evidence, generated rules, or implementation files.

## Risks / Open Questions

- GitHub availability can vary by runtime. The prompt must support `gh`, connectors, web-provided issue URLs, or no GitHub access without failing roadmap generation.
- GitHub issue/PR state can be stale relative to the local checkout. The roadmap must report drift instead of blindly trusting remote status.
- The current `.ai-factory/ROADMAP.md` is already stale relative to recent PRs `#57`, `#58`, and `#59`; implementation must avoid rewriting roadmap during planning, but the new behavior should detect this later.
- Existing prompt tests focus on OpenSpec-native prompt assets broadly. This change needs targeted roadmap evidence assertions without over-constraining natural roadmap wording.
- No interactive preferences were requested in this Codex Default-mode plan. Assumptions: tests `yes`, docs `yes`, logging `minimal`, roadmap linkage to issue #13 and current roadmap release-confidence/drift priorities.
