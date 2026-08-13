# Roadmap Lifecycle ai-tester Results

- Run: `issue-88-luna-low-20260812-r3`
- Runtime/model/reasoning: `codex` / `gpt-5.6-luna` / `low`
- Reasoning enforcement: `PASS` (`model_reasoning_effort="low"` через изолированный Codex wrapper)
- ai-tester: `ai-tester 1.1.0`, source `98dd5afb3fe9`, binary `5e99619cc5fc`
- Codex: `codex-cli 0.144.6`
- Baseline: 0 PASS, 5 FAIL, 0 NOT_RUN; tokens 110282 (input 103631, output 763, cache-read 5888).
- Refined: 3 PASS, 2 FAIL, 0 NOT_RUN; tokens 123495 (input 103789, output 506, cache-read 19200).
- Pair delta: 3 improved, 0 regressed, 2 unchanged.
- Сырые trace, model output, sandbox paths, session IDs и credentials не сохранены в репозитории.

## Reproduction

Используйте clean checkout и executable с указанными выше commit/SHA-256. `<os-temp-child>` должен быть новым дочерним каталогом системного temp:

`node scripts/roadmap-lifecycle-ai-tester.mjs --execute --out <os-temp-child> --run-id <run-id> --ai-tester-root <ai-tester-checkout> --ai-tester <ai-tester-executable> --codex <native-codex-executable> --cleanup --json`

| Scenario | Baseline | Refined | Scenario fingerprints | Tokens baseline/refined | Failed assertions baseline/refined |
| --- | --- | --- | --- | ---: | --- |
| `issue-linked-planning` | FAIL (5/9) | FAIL (8/9) | `65a8600c9cb5` / `2963ad1fe6ef` | 26769 / 20860 | `explicit-none-values`, `issue-link`, `roadmap-owner-handoff`, `standard-linkage` / `standard-linkage` |
| `successful-done` | FAIL (5/9) | PASS (9/9) | `c93f6c7139a8` / `f5cb9d71ecbf` | 20912 / 20857 | `finalized-state`, `managed-block-boundary`, `no-github-claim`, `updated-outcome` / none |
| `failed-done-no-roadmap-write` | FAIL (7/8) | PASS (8/8) | `079e3901324f` / `f9d11bab97f0` | 20826 / 20850 | `lifecycle-unchanged` / none |
| `finalized-state-commit-blocking` | FAIL (6/10) | PASS (10/10) | `d6085e27a2df` / `aac373315b87` | 20884 / 40032 | `check-handoff`, `commit-blocked`, `external-warning`, `local-error` / none |
| `post-merge-github-reconciliation` | FAIL (5/10) | FAIL (8/10) | `0646f4714840` / `3e75d39670a4` | 20891 / 20896 | `check-reconciliation`, `local-finalized-preserved`, `remote-not-local-proof`, `remote-state-refreshed`, `separate-evidence-sources` / `local-finalized-preserved`, `remote-state-refreshed` |

Статус строки — результат полного набора декларативных assertions для соответствующего arm. `FAIL` у baseline означает отсутствие нового workflow contract, а не ошибку runner.
`FAIL` у refined фиксирует недоказанный strict output contract в этом model run; deterministic prompt/runtime tests проверяются отдельно и не заменяются AI-оценкой.
