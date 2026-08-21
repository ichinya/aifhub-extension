# Understand Anything: Optional User-Owned Repo Graph Evaluation

## Decision

`understand-anything` remains `reject_defer`. AIFHub does not install, clone, update, index, probe, register, link, configure or execute this provider in normal workflows. The only evaluated consumption boundary is an explicitly supplied, user-owned and reviewed graph output used as noncanonical supporting context.

## Exact Identity

| Field | Value |
|---|---|
| Repository | [`Egonex-AI/Understand-Anything`](https://github.com/Egonex-AI/Understand-Anything) |
| Release | [`v2.9.0`](https://github.com/Egonex-AI/Understand-Anything/releases/tag/v2.9.0), published 2026-07-10 |
| Tag commit | [`f08763d11d0202a8a8f52b5dedda6d1b2e2ebac8`](https://github.com/Egonex-AI/Understand-Anything/commit/f08763d11d0202a8a8f52b5dedda6d1b2e2ebac8) |
| License | MIT at the pinned commit |
| Observed | 2026-07-22 |
| Upstream main at observation | [`6ae71878beb50226a1e4b7e2f52ac6468c86f74b`](https://github.com/Egonex-AI/Understand-Anything/commit/6ae71878beb50226a1e4b7e2f52ac6468c86f74b) |

The tag resolves directly to the recorded commit. Floating `main` is drift evidence only: it differs from the reviewed release, and the matching [main CI run](https://github.com/Egonex-AI/Understand-Anything/actions/runs/29810594996) completed with `failure`.

## Static Audit

The pinned root [`package.json`](https://github.com/Egonex-AI/Understand-Anything/blob/f08763d11d0202a8a8f52b5dedda6d1b2e2ebac8/package.json) is a private pnpm workspace and its `prepare` script builds `@understand-anything/core`. The provider's primary lifecycle is the interactive [`understand` skill](https://github.com/Egonex-AI/Understand-Anything/blob/f08763d11d0202a8a8f52b5dedda6d1b2e2ebac8/understand-anything-plugin/skills/understand/SKILL.md), not a stable non-global CLI. That skill may:

- resolve plugin code through user-home/global skill paths and run `pnpm install` plus a core build;
- create or reuse `.ua/` (legacy `.understand-anything/`), prepare `.understandignore`, and wait for confirmation;
- dispatch a scanner and up to five file-analysis subagents, followed by assembly/architecture/tour reviewers;
- write `knowledge-graph.json`, metadata, fingerprints and intermediate files;
- start the dashboard after a successful graph validation.

The exact [`schema.ts`](https://github.com/Egonex-AI/Understand-Anything/blob/f08763d11d0202a8a8f52b5dedda6d1b2e2ebac8/understand-anything-plugin/packages/core/src/schema.ts) validates a versioned project graph with nodes and edges, but also contains sanitizing/defaulting behavior. AIFHub therefore does not trust raw output: its test-only adapter requires a narrower exact schema, project identity, path confinement, size limits and typed structural fields only.

The upstream installers clone into user-home storage and create platform skill links or junctions; see [`install.ps1`](https://github.com/Egonex-AI/Understand-Anything/blob/f08763d11d0202a8a8f52b5dedda6d1b2e2ebac8/install.ps1) and [`install.sh`](https://github.com/Egonex-AI/Understand-Anything/blob/f08763d11d0202a8a8f52b5dedda6d1b2e2ebac8/install.sh). Those operations are outside AIFHub ownership. The pinned [`hooks.json`](https://github.com/Egonex-AI/Understand-Anything/blob/f08763d11d0202a8a8f52b5dedda6d1b2e2ebac8/understand-anything-plugin/hooks/hooks.json) can trigger auto-update instructions after Git activity. The [`understand-dashboard` skill](https://github.com/Egonex-AI/Understand-Anything/blob/f08763d11d0202a8a8f52b5dedda6d1b2e2ebac8/understand-anything-plugin/skills/understand-dashboard/SKILL.md) installs/builds dependencies and starts a token-gated Vite server on `127.0.0.1`, with browser opening described by the skill. Evaluation explicitly disables hooks, auto-update, dashboard/viewer, browser launch and background processes.

## Eligibility Result

The provider-provenance lifecycle is `NOT_RUN(lifecycle_unavailable)`. The unmodified interactive skill cannot currently be proven to satisfy all required confinement gates through the available `ai-tester` profile: local dependency preparation, user confirmations, bounded nested subagents, plugin-root resolution, credential/config isolation, output/process budgets and complete descendant-only purge must all be controllable before execution. Unknown required gates are `BLOCKED`, never inferred as PASS, and no private CLI or patched source is substituted.

This result blocks actual provider generation and positive provider policy only. It does not block the mandatory `synthetic_schema_fixture` reviewed-output contract matrix.

## Upstream Issue Matrix

| Claim | Upstream state on 2026-07-22 | Pinned-tag reproduction | Evaluation treatment |
|---|---|---|---|
| [#589 workspace-package imports](https://github.com/Egonex-AI/Understand-Anything/issues/589) | open | `NOT_RUN` | Deterministic sanitized fixture requires package/file edges. |
| [#590 stale incremental import map](https://github.com/Egonex-AI/Understand-Anything/issues/590) | open | `NOT_RUN` | Two-revision fixture rejects a missing new edge or stale reuse. |
| [#594 PostToolUse input mismatch](https://github.com/Egonex-AI/Understand-Anything/issues/594) | open | `NOT_RUN` | Hooks are disabled and cannot satisfy evaluation evidence. |
| [#481 security findings](https://github.com/Egonex-AI/Understand-Anything/issues/481) | open | `NOT_RUN` | Issue text is risk context only; exact-source/path/prompt boundaries fail closed independently. |

An open issue is not proof that the pinned tag reproduces a defect. No row above is reported as reproduced without an exact-revision lifecycle run.

## Historical Comparator Caveat

Earlier Graphify, CodeGraph and Repowise reports use different fixtures, prompts, runtimes, models, reasoning profiles or repetition counts. They explain why repository-graph candidates are investigated, but they are `historical_context`, not a same-run ranking against Understand Anything. No comparative superiority claim is made without an identical matrix revision.

## Ownership and Canonicality

Raw graph JSON, source snippets and agent transcripts are not stored in docs, OpenSpec, generated rules, QA, verify/done evidence or recommendation metadata. The corrected synthetic r3 run scanned the complete traces, recorded a privacy failure and purged the unsafe `runs/` payloads after producing a bounded aggregate. Any future retained synthetic traces must pass the same full-trace scan. User-supplied graph data remains supporting context and every claim must be checked against direct repository evidence.

Positive lifecycle ownership, automatic indexing, hooks, viewer/server, MCP or production graph consumption require a separate OpenSpec change and ADR.

## Benchmark

Mandatory contract evidence and the conditional provider-provenance result are recorded in [Understand Anything Benchmark Results](understand-anything-benchmark-results.md). Synthetic evidence is explicitly non-promotable, so it cannot change `reject_defer` by itself.
