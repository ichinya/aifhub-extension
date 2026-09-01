# T-Search Benchmark Results

## Outcome

No controlled AIFHub-like A/B benchmark was run, so T-Search is not eligible for recommendation. The decision is `reject_defer`.

- Static upstream identity, license, API, model-card, harness, and deployment review: complete.
- Upstream harness quality checks: complete against the pinned source revision.
- Model execution: `NOT_RUN(resource_profile)`; no weights were downloaded.
- Repository retrieval comparison: `NOT_RUN(no_bounded_corpus_or_search_backend)`.
- Privacy/freshness/purge lifecycle: `NOT_RUN(no_user_owned_index_lifecycle)`.
- Upstream benchmark results: recorded as author-reported context only and excluded from AIFHub recommendation evidence.

## Evaluation Snapshot

| Field | Value |
|---|---|
| Observed | 2026-09-01 |
| BF16 revision | `bf0b272e0f69921ec39040807336602758448099` |
| FP8 revision | `03ed451626ef84848866f00b6e106c4a2e843fd3` |
| NVFP4 revision | `ad97a604e738aebccb049d57419b59048f802953` |
| GGUF revision | `5e5a39987b20533c6bf09ca10d3c0c6e81eae067` |
| Harness revision | `997a0ba1685d24ad840e3e2542b59952ff3fb362` |
| Harness distribution | One source commit; no GitHub release and no PyPI distribution found |
| Local hardware profile | Anonymous NVIDIA 16 GB VRAM class, about 64 GB system RAM |
| Smallest official weight | Q4_K_M GGUF, 21.71 GB before runtime/KV-cache overhead |

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
| GGUF Q4_K_M | 21.71 GB file | Exceeds local VRAM before cache/overhead; hybrid offload was not run. |
| GGUF Q5_K_M / Q6_K / Q8_0 | 25.35 / 29.21 / 37.80 GB | Larger than Q4; not run. |

Downloading a large checkpoint would not produce a valid A/B result without a bounded repository corpus, search backend, ground-truth questions, and privacy/purge contract. A slow CPU-hybrid smoke would test process startup, not retrieval quality or adoption fitness, so it was intentionally omitted.

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
| vLLM / SGLang / llama.cpp | SGLang and llama.cpp have upstream reference recipes; vLLM matches the interface but the exact checkpoint path was not run. |
| MCP adapter | NOT FOUND. |
| Built-in indexing or corpus ingestion | NOT FOUND. |
| Source exclusions, redaction, freshness, or purge | NOT PROVIDED by the harness. |
| AIFHub-like mixed code/docs/OpenSpec benchmark | NOT RUN and not present upstream. |
| H100 requirement | UNVERIFIED by the reviewed official sources. |
| 20-50% cost reduction | UNVERIFIED by the reviewed official sources. |
| Hosted Hugging Face inference | NOT FOUND on the observed model pages. |

## Required Paired Benchmark

A future authorized run must use the same repository revision and answer-independent tasks for both variants:

| Variant | Required behavior |
|---|---|
| `baseline_rg` | Direct bounded repository search and source-file verification. |
| `candidate_t_search` | Same question and corpus; T-Search may plan searches against the reviewed backend, return bounded pointers, then the answerer verifies direct files. |

The corpus must include source code, Markdown, Russian/English documentation, and OpenSpec artifacts. It must include exact exclusions and privacy canaries. The evaluator must record correctness, citation validity, Recall@10, stale-hit behavior, privacy, wall time, model/search calls, total tokens, endpoint cost, index build/refresh cost, output noise, and complete purge. Raw snippets and transcripts must be scanned and deleted rather than promoted into durable evidence.

Until that run and lifecycle both pass, upstream web benchmark gains cannot change the `reject_defer` policy.
