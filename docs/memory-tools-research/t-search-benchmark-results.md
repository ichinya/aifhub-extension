# T-Search Benchmark Results

## Outcome

An authorized controlled local A/B completed all six synthetic AIFHub-like pairs. T-Search recovered every ground-truth chunk, but its aggregate false-positive rate was worse than the bounded `rg` baseline and its runtime/token overhead was large. The strict synthetic pilot result is therefore `pilot_negative`. A later authorized committed-snapshot sample from a real Laravel project completed only one of six candidate rows under the same reduced profile, so that follow-up is `incomplete` and the policy decision remains `reject_defer`.

- Static upstream identity, license, API, model-card, harness, and deployment review: complete.
- Upstream harness quality checks: complete against the pinned source revision.
- Model execution: PASS for the exact Q4_K_M GGUF on pinned `llama.cpp` b10068 in a reduced 8,192-context hybrid CPU/GPU profile.
- Repository retrieval comparison: 6/6 paired synthetic rows completed; aggregate Recall@10 improved from `0.666667` to `1.0`, while false-positive rate worsened from `0.44` to `0.495238`.
- Real Laravel snapshot follow-up: 6/6 direct `rg` rows passed, but only 1/6 T-Search rows finalized; the other rows ended with four bounded LLM errors and one free-text loop.
- Local stateless privacy/source/freshness/purge gates: PASS; no raw transcript or persistent search state was retained.
- Production repository and external index build/refresh/staleness/purge lifecycle: `NOT_RUN`.
- Upstream benchmark results: recorded as author-reported context only and excluded from AIFHub recommendation evidence.

## Evaluation Snapshot

| Field | Value |
|---|---|
| Observed | 2026-09-01; real-project follow-up 2026-09-02 |
| BF16 revision | `bf0b272e0f69921ec39040807336602758448099` |
| FP8 revision | `03ed451626ef84848866f00b6e106c4a2e843fd3` |
| NVFP4 revision | `ad97a604e738aebccb049d57419b59048f802953` |
| GGUF revision | `5e5a39987b20533c6bf09ca10d3c0c6e81eae067` |
| Harness revision | `997a0ba1685d24ad840e3e2542b59952ff3fb362` |
| Harness distribution | One source commit; no GitHub release and no PyPI distribution found |
| Local hardware profile | NVIDIA GeForce RTX 4060 Ti 16 GB, Intel Core i9-11900K, 64 GB system RAM |
| Smallest official weight | Q4_K_M GGUF, 21.71 GB before runtime/KV-cache overhead |
| Executed candidate | `T-Search-Q4_K_M.gguf`, 21,713,463,136 bytes, SHA-256 `f645dce898117a1f9165dfbb014d61e5f09daec06bb64f4b91de7f103b8761bb` |
| Runtime | `llama.cpp` b10068 / `571d0d540df04f25298d0e159e520d9fc62ed121`, loopback alias `t-tech/T-Search-GGUF` |

## Local Paired Runner

The authorized follow-up adds an answer-independent local runner and [scenario catalog](t-search-ab-scenarios.json). Its synthetic corpus contains 23 eligible files and 30 marked chunks across TypeScript, Markdown, Russian/English documentation, and OpenSpec. Three excluded files carry privacy canaries under `.env`, `.ai-factory/qa/**`, and `vendor/**`.

The candidate does not receive a privileged index. Every harness `search_corpus` call executes the same bounded `rg --json` backend over the reviewed corpus, while the baseline receives one such search. This measures whether T-Search's query decomposition and final ranking improve retrieval enough to justify their model, latency, and token overhead. It does not establish production semantic-index performance.

The runner persists no raw query, snippet, reasoning, message, transcript, or round summary. It records project-relative chunk IDs and aggregate scores only. Candidate PASS requires exact harness provenance, loopback model identity, privacy-canary absence, source confinement, an unchanged pre/post corpus snapshot, and zero persistent search state. The output boundary refuses canonical OpenSpec, QA, and generated-rules directories.

### Authorized live result 2026-09-01

The live run used one round, one server slot, an 8,192-token context/budget, at most 2,048 generated tokens per turn, `top_k=10`, `temperature=0.7`, and `top_p=1.0`. `llama-server` used automatic hybrid offload, loaded in about 152 seconds, and reached approximately 15,820 MiB of GPU memory. This is intentionally smaller than the upstream 65,536-context, up-to-five-round profile.

| Aggregate metric | `baseline_rg` | `candidate_t_search` | Interpretation |
|---|---:|---:|---|
| Recall@10 | 0.666667 | 1.000000 | Candidate found all ground-truth chunks. |
| Precision among returned results (max 10) | 0.466667 | 0.504762 | Small aggregate improvement, with large per-scenario variance. |
| False-positive rate | 0.440000 | 0.495238 | Candidate regressed by 0.055238, so the strict pilot cannot be positive. |
| Reciprocal rank | 0.750000 | 1.000000 | Every candidate ranking placed a relevant chunk first. |
| Total measured row time | 0.569 s | 449.815 s | Candidate was about 790.5x slower in this local profile. |
| Model tokens | 0 | 206,212 | 196,436 prompt plus 9,776 completion tokens. |
| Search calls | 6 | 85 | Baseline used one `rg` call per scenario; the agent decomposed and repeated searches. |

| Scenario | Language | Recall@10 (`rg` → T-Search) | Precision (`rg` → T-Search) | FPR (`rg` → T-Search) | Candidate time | Candidate tokens | Search calls |
|---|---|---:|---:|---:|---:|---:|---:|
| `expired-login-boundary` | en | 0.5 → 1.0 | 0.166667 → 0.5 | 0.833333 → 0.5 | 102.986 s | 37,727 | 16 |
| `audit-transient-retry` | ru | 0.5 → 1.0 | 1.0 → 0.4 | 0.0 → 0.6 | 74.389 s | 12,770 | 8 |
| `openspec-task-completion` | en | 1.0 → 1.0 | 0.333333 → 0.5 | 0.666667 → 0.5 | 97.292 s | 47,950 | 18 |
| `retrieval-provider-privacy` | ru | 0.0 → 1.0 | 0.0 → 1.0 | no baseline hits → 0.0 | 100.715 s | 76,327 | 24 |
| `order-status-audit-path` | en | 1.0 → 1.0 | 0.3 → 0.428571 | 0.7 → 0.571429 | 31.585 s | 12,068 | 7 |
| `bilingual-order-status-glossary` | ru | 1.0 → 1.0 | 1.0 → 0.2 | 0.0 → 0.8 | 42.848 s | 19,370 | 12 |

All six candidate rows finalized and passed exact model identity, exact harness provenance, privacy-canary scanning, source confinement, unchanged-corpus freshness, sandbox cleanup, and zero-persistent-state gates. The loopback endpoint had zero provider charge; local electricity was not priced. Index build and refresh cost were zero only because both arms used a stateless bounded `rg` backend, so this run does not validate an external production index lifecycle. The preflight smoke row was excluded from the aggregate.

The pilot decision requires a Recall@10 gain without worse false-positive rate, or an FPR gain without worse recall. The observed recall gain accompanied an aggregate FPR regression, yielding `pilot_negative`; `no_promote: true` would have prevented a policy promotion even under a positive pilot score.

### Authorized real Laravel snapshot follow-up 2026-09-02

The same runner was exercised against an authorized committed snapshot from a real Laravel 13 project. The project identity, revision, source, scenario catalog, queries, paths, corpus fingerprint, and raw model/server output are intentionally not committed. The deterministic temporary corpus sampled 218 safe committed files into 614 marked chunks across PHP, Vue, JavaScript/TypeScript, Markdown, JSON, and configuration sources. Six fixed Russian/English code-navigation scenarios were scored. Uncommitted working-tree files were not read into the corpus, and `.env*`, `storage/**`, `bootstrap/cache/**`, `vendor/**`, `node_modules/**`, QA/state, and generated-rule paths were excluded.

| Aggregate metric | `baseline_rg` | `candidate_t_search` | Interpretation |
|---|---:|---:|---|
| Completed rows | 6/6 | 1/6 | Five candidate rows are incomplete and cannot receive retrieval scores. |
| Recall@10 | 0.250000 across six rows | 1.000000 on the sole completed pair | The candidate improved that pair from 0 to 1, but this is not an aggregate six-pair comparison. |
| Precision among returned results | 0.083333 across six rows | 0.333333 on the sole completed pair | Candidate summary quality metrics cover one pair only. |
| False-positive rate | 0.916667 across six rows | 0.666667 on the sole completed pair | The apparent improvement cannot offset 5/6 missing candidate scores. |
| Reciprocal rank | 0.144444 across six rows | 1.000000 on the sole completed pair | Relevant material ranked first in the one completed row. |
| Total measured row time | 0.663 s | 495.151 s | Candidate attempts were about 746.8x slower overall. |
| Model tokens | 0 | 154,357 | 147,022 prompt plus 7,335 completion tokens. |
| Search calls | 6 | 30 | Candidate cost includes both successful and failed bounded rows. |
| Failure categories | none | 4 `termination_llm_error`; 1 `termination_free_text_loop` | The 8,192-context server logged six context truncations during the run. |

All candidate rows still passed exact model identity, exact harness provenance, privacy-canary scanning, source confinement, unchanged-corpus freshness, purge, and zero-persistent-state gates. Sanitized durable results contained zero canary values. The pinned Q4_K_M server's cold start took about 362 seconds on this follow-up, in addition to measured row time.

This is real-source evidence, but it remains a deterministic sample using the stateless bounded `rg` search adapter rather than a production vector/BM25 index. Because five candidate rows failed to finalize, the runner records `pilot_decision: incomplete`; the permanent decision remains `reject_defer`. Candidate averages from this run must never be presented without the `1/6` completion denominator.

Safe preparation and baseline commands are:

```bash
node scripts/t-search-ab-benchmark.mjs --dry-run --json
node scripts/t-search-ab-benchmark.mjs --baseline-only --json
```

Live candidate execution additionally requires the evaluator's exact pinned harness root, verified external GGUF file, and loopback model endpoint. It is never part of `npm test`, validation, recommendation, availability probing, or normal command selection.

## Harness Audit

The pinned [`t-search-harness`](https://github.com/turbo-llm/t-search-harness) is a typed Python 3.10+ library with an OpenAI-compatible model client and an injected search-client protocol. It is not a server, indexer, CLI application, or MCP provider.

| Check | Result | Interpretation |
|---|---|---|
| `ruff check src tests` | PASS | Static lint clean at the pinned commit. |
| `mypy src` | PASS | Source type check clean. |
| Default Windows-locale `pytest` | 26 PASS, 1 FAIL | A test reads a UTF-8 reference file without an explicit encoding and misdecodes Unicode tool-schema symbols under the host locale. |
| `python -X utf8 -m pytest -q` | 27 PASS | Full upstream suite passes in UTF-8 mode. Core YAML loading already requests UTF-8 explicitly. |
| Release/package lookup | NOT FOUND | Installation remains Git clone plus editable/source install. |
| MCP/ingestion/index/freshness/purge implementation | NOT FOUND | Those lifecycle responsibilities remain external to the harness. |

The locale-sensitive test is a portability defect in upstream test code, not evidence of a core runtime failure. It still matters because this snapshot is not a mature packaged integration surface.

## Runtime Feasibility

| Artifact | Published size | Local assessment |
|---|---:|---|
| BF16 | 71.92 GB repository storage | Not suitable for this host. |
| FP8 | 37.49 GB repository storage | Exceeds local VRAM; exact runtime requirements not tested. |
| NVFP4 | 25.47 GB repository storage | Exceeds local VRAM and requires a compatible quantized runtime; not tested. |
| GGUF Q4_K_M | 21.71 GB file | Executed successfully with automatic hybrid CPU/GPU offload, 8,192 context, and one slot; not representative of the upstream full-context profile. |
| GGUF Q5_K_M / Q6_K / Q8_0 | 25.35 / 29.21 / 37.80 GB | Larger than Q4; not run. |

The Q4 run proves local feasibility on a 16 GB GPU only through hybrid offload. It does not prove the official 65,536-token profile, multi-round behavior, concurrency, production latency, or an indexed corpus lifecycle. The measured reduced-profile overhead is already too high for default AIFHub retrieval.

## Author-Reported Recall@10

These results come from the official [`T-Search-FP8`](https://huggingface.co/t-tech/T-Search-FP8) and [`T-Search-GGUF`](https://huggingface.co/t-tech/T-Search-GGUF) model cards and fixed benchmark indexes. They were not independently reproduced and are not AIFHub-like source retrieval evidence. The related [T-Bank technical report](https://habr.com/ru/companies/tbank/articles/1060262/) is supporting author material, not an independent replication.

| Model / rollout | BrowseComp+ | ru-BrowseComp+ | SealQA | ru-SealQA | SynthComp-En | SynthComp-Ru | TRuST | Average |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| T-Search N=3 | 72.65 | 62.93 | 66.08 | 61.98 | 58.52 | 58.00 | 49.12 | 61.33 |
| T-Search N=1 | 65.35 | 55.95 | 61.16 | 57.72 | 54.52 | 53.13 | 43.92 | 55.96 |
| GLM-5.2 | 63.01 | 52.54 | 55.30 | 54.69 | 52.29 | 49.37 | 37.07 | 52.04 |
| Kimi-K2.6 | 60.71 | 49.76 | 56.86 | 52.46 | 48.25 | 47.06 | 42.39 | 51.07 |
| Qwen3.6-35B-A3B baseline | 43.66 | 38.58 | 46.07 | 43.26 | 41.82 | 43.88 | 33.53 | 41.54 |

N=3 runs three independent T-Search rollouts and combines their rankings with reciprocal-rank fusion. It is a different cost/latency operating point, not a free quality improvement.

### Quantization

The GGUF card reports the same harness, fixed indexes, 65,536-token serving context, and N=1 setup:

| Checkpoint | Average Recall@10 | Delta vs BF16 |
|---|---:|---:|
| BF16 | 55.96 | baseline |
| Q8_0 | 55.40 | -0.56 |
| Q6_K | 54.55 | -1.41 |
| Q5_K_M | 54.69 | -1.27 |
| Q4_K_M | 53.61 | -2.35 |

The smallest Q4 checkpoint retains most of the reported aggregate quality, but this does not establish repository retrieval quality and still does not fit entirely in the evaluation host's VRAM.

### Search-backend sensitivity

The FP8/BF16 model card keeps T-Search fixed while changing the actual retriever:

| Search backend | Average Recall@10 |
|---|---:|
| Qwen3-Embedding-8B + LLM reranking | 62.87 |
| Qwen3-Embedding-8B | 55.96 |
| jina-embeddings-v5-text-small-retrieval | 54.32 |
| BM25 | 51.14 |
| Qwen3-Embedding-0.6B | 49.38 |

This spread reinforces the architectural finding: T-Search does not replace the index/retriever, and its outcome cannot be evaluated independently of that user-owned layer.

## Claim Audit

| Question from issue #147 | Result |
|---|---|
| Exact model URL and license | VERIFIED: four official `t-tech` model repositories, Apache-2.0. |
| Runnable integration path | PARTIAL: source-only Python harness plus OpenAI-compatible model endpoint and caller-provided search contract. |
| vLLM / SGLang / llama.cpp | The pinned Q4 GGUF ran on `llama.cpp` b10068; SGLang remains source-supported and vLLM interface-compatible in principle, but neither was executed. |
| MCP adapter | NOT FOUND. |
| Built-in indexing or corpus ingestion | NOT FOUND. |
| Source exclusions, redaction, freshness, or purge | NOT PROVIDED by the harness. |
| AIFHub-like mixed code/docs/OpenSpec benchmark | 6/6 local synthetic pairs completed with `pilot_negative`; a real Laravel committed-snapshot sample completed only 1/6 candidate rows with `incomplete`. Neither used a production index lifecycle. |
| H100 requirement | UNVERIFIED by the reviewed official sources. |
| 20-50% cost reduction | UNVERIFIED by the reviewed official sources. |
| Hosted Hugging Face inference | NOT FOUND on the observed model pages. |

## Remaining Re-evaluation Evidence

The local runs establish that the bounded runner works and that the exact Q4 model can improve recall on both synthetic data and one completed real-project pair. The 5/6 real-project completion failure means this is not promotion-grade evidence. A future run must use the same complete real repository revision and answer-independent tasks for both variants, while preventing context growth or structured-output failure from invalidating most candidate rows:

| Variant | Required behavior |
|---|---|
| `baseline_rg` | Direct bounded repository search and source-file verification. |
| `candidate_t_search` | Same question and corpus; T-Search may plan searches against the reviewed backend, return bounded pointers, then the answerer verifies direct files. |

The real corpus must include source code, Markdown, Russian/English documentation, and OpenSpec artifacts. It must exercise an actual user-owned index/search lifecycle with exact exclusions, redaction, revision identity, stale-hit behavior, incremental refresh, and complete purge. The evaluator must record correctness, citation validity, Recall@10, false-positive rate, privacy, wall time, model/search calls, total tokens, endpoint cost, index build/refresh cost, output noise, and complete purge. Raw snippets and transcripts must be scanned and deleted rather than promoted into durable evidence.

Until that run improves retrieval without an unacceptable quality or cost tradeoff and the external lifecycle passes, neither this synthetic result nor upstream web benchmark gains can change the `reject_defer` policy.
