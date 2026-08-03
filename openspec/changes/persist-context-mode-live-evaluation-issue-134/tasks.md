# Tasks

## 1. Canonical follow-up and failing contracts

- [x] 1.1 Add and strictly validate this follow-up proposal, design, tasks and `context-providers` delta without editing the archived issue `#134` change.
- [x] 1.2 Add failing tests for default/authorized execution gates, quoted PowerShell baseline matching, >1 MiB fixture generation, current MCP `queries` payload and native Codex executable enforcement.
- [x] 1.3 Add failing tests for raw nested tool/path audit, missing raw provider evidence and resume parity fail-closed behavior.

## 2. Harness corrections

- [x] 2.1 Implement bounded authorization normalization; preserve old `BLOCKED`/`NOT_RUN` defaults and record no identity, credential or path data.
- [x] 2.2 Fix MCP payload and native executable/wrapper selection; keep provider process environment allowlisted.
- [x] 2.3 Generate deterministic large-output fixture metadata/content and robust baseline command matching without persisting large content in `matrix.json`.
- [x] 2.4 Join `ai-tester` correctness/cost trace with sanitized raw Codex rollout tool/path audit; remove outer-trace provider `tool_called` false assertion and keep resume `NOT_RUN` until parity exists.

## 3. Durable evidence and policy

- [x] 3.1 Write sanitized append-only live evidence under `.ai-factory/state/persist-context-mode-live-evaluation-issue-134/evaluation/`; exclude raw traces, content, commands, absolute paths, environment and auth fingerprints.
- [x] 3.2 Append live results to context-mode benchmark/research and public provider guidance: MCP is conditional only for large truncating output, plugin is avoid for current nested shell path, continuity is not proven, and normal AIFHub behavior stays no-auto-install/no-hooks.

## 4. Verification and delivery

- [x] 4.1 Run focused context-mode tests, docs contracts, strict OpenSpec validation, `npm run validate`, `npm test`, `git diff --check` and targeted privacy/path scans.
- [x] 4.2 Run `/aif-verify persist-context-mode-live-evaluation-issue-134`, record implementation/verification state, then create one scoped commit without push.

## Commit Plan

- After tasks 1.1-4.2: `fix(context): persist authorized context-mode evaluation`.

Suggested next command: `/aif-implement persist-context-mode-live-evaluation-issue-134`.
