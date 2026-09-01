# T-Search: Optional Agentic Retrieval Evaluation

## Decision

`t-search` is `reject_defer`. AIFHub must not recommend, install, download, probe, configure, index for, or execute T-Search in normal workflows. The candidate is not a drop-in retrieval provider: it is an agentic query planner and ranker that requires both a separately served model and a user-owned search backend over a user-owned corpus.

The upstream results are promising on fixed web-search benchmarks, but they do not establish correctness, privacy, latency, or cost on an AIFHub-like repository containing mixed source code, Markdown, Russian/English documentation, and OpenSpec artifacts. The official [T-Bank technical report](https://habr.com/ru/companies/tbank/articles/1060262/) likewise recommends validation on the consumer's own index. No `docs/retrieval-providers.md` integration guide is added because the issue's positive-evaluation gate was not met.

## Exact Identity

Observed 2026-09-01:

| Artifact | Pinned revision | License | Published size |
|---|---|---|---:|
| [`t-tech/T-Search`](https://huggingface.co/t-tech/T-Search) | [`bf0b272e0f69921ec39040807336602758448099`](https://huggingface.co/t-tech/T-Search/commit/bf0b272e0f69921ec39040807336602758448099) | Apache-2.0 | 71.92 GB repository storage |
| [`t-tech/T-Search-FP8`](https://huggingface.co/t-tech/T-Search-FP8) | [`03ed451626ef84848866f00b6e106c4a2e843fd3`](https://huggingface.co/t-tech/T-Search-FP8/commit/03ed451626ef84848866f00b6e106c4a2e843fd3) | Apache-2.0 | 37.49 GB repository storage |
| [`t-tech/T-Search-NVFP4`](https://huggingface.co/t-tech/T-Search-NVFP4) | [`ad97a604e738aebccb049d57419b59048f802953`](https://huggingface.co/t-tech/T-Search-NVFP4/commit/ad97a604e738aebccb049d57419b59048f802953) | Apache-2.0 | 25.47 GB repository storage |
| [`t-tech/T-Search-GGUF`](https://huggingface.co/t-tech/T-Search-GGUF) | [`5e5a39987b20533c6bf09ca10d3c0c6e81eae067`](https://huggingface.co/t-tech/T-Search-GGUF/commit/5e5a39987b20533c6bf09ca10d3c0c6e81eae067) | Apache-2.0 | 21.71-37.80 GB per quantization |
| [`turbo-llm/t-search-harness`](https://github.com/turbo-llm/t-search-harness) | [`997a0ba1685d24ad840e3e2542b59952ff3fb362`](https://github.com/turbo-llm/t-search-harness/commit/997a0ba1685d24ad840e3e2542b59952ff3fb362) | Apache-2.0 | Source only; no release or PyPI package found |
| [`t-tech/TRuST`](https://huggingface.co/datasets/t-tech/TRuST) and [`t-tech/SynthComp`](https://huggingface.co/datasets/t-tech/SynthComp) | Hub revisions observed with the model evaluation | ODC-BY-1.0 | Fixed evaluation indexes are separate downloads |

The model card describes T-Search as trained from `Qwen3.6-35B-A3B`; the pinned Transformers config uses the `Qwen3_5MoeForConditionalGeneration` architecture identifier. It declares 262,144 maximum positions, while the official T-Search serving examples use a 65,536-token context.

## What It Actually Provides

The official harness makes the dependency split explicit:

```text
AIFHub question
  -> user-owned T-Search harness
       -> user-owned OpenAI-compatible T-Search model endpoint
       -> user-owned search backend and corpus index
  -> ranked chunk IDs plus the snippets seen by the model
  -> direct repository-file verification
```

The harness provides the search loop, tool schemas, round state, and final ranking. It does not provide corpus ingestion, chunking, embeddings, a vector database, BM25 indexing, source exclusions, redaction, freshness, deletion, or an MCP server. The caller must inject either:

- `search(query: str, top_k: int) -> str`, returning a JSON string containing `{docid, snippet, score}` objects; or
- an HTTP backend implementing `POST /search` and returning the harness's documented result shape.

`agent.retrieve(query)` returns ranked chunk identifiers and snippets, not fetched full documents. AIFHub would still have to resolve every pointer and verify every claim against the current repository.

## Deployment Findings

| Runtime | Evidence | Evaluation status |
|---|---|---|
| SGLang | The FP8 model card publishes a 65,536-context reference using `qwen3` reasoning parsing and `qwen3_coder` tool parsing, adapted from the official [Qwen3.6 SGLang cookbook](https://lmsysorg.mintlify.app/cookbook/autoregressive/Qwen/Qwen3.6#qwen3-6). | Source-supported; not executed locally. |
| llama.cpp | The GGUF card publishes an OpenAI-compatible `llama-server` setup and pins build `b10068` / commit [`571d0d540df04f25298d0e159e520d9fc62ed121`](https://github.com/ggml-org/llama.cpp/commit/571d0d540df04f25298d0e159e520d9fc62ed121). | Source-supported; not executed locally. |
| vLLM | The harness example points at a vLLM-style `/v1` endpoint, and current [vLLM documentation](https://docs.vllm.ai/en/stable/serving/openai_compatible_server.html) supports OpenAI-compatible chat completions, reasoning parsing, and tool calling. The exact T-Search checkpoint/runtime combination is not validated by this evaluation. | Interface-compatible in principle; `NOT_RUN`. |
| Hosted Hugging Face inference | None of the four observed model pages listed a deployed Hugging Face Inference Provider. | Not available at observation time. |

The smallest official checkpoint is the 21.71 GB Q4_K_M GGUF. That already exceeds the anonymous evaluation host's 16 GB VRAM before runtime and KV-cache overhead. A CPU/GPU hybrid may fit in roughly 64 GB system RAM, but it would be slow and would not answer the missing corpus, privacy, or integration questions. No weights were downloaded.

## Runtime and Cost Surface

The harness defaults are a ceiling of five rounds, 32K tokens per round, 16,384 generated tokens per assistant turn, 60 turns per round, five searches before a round may be saved, and a 600-second model request timeout. Actual sessions can finish earlier, but this is a materially larger and more variable runtime surface than direct `rg` retrieval.

Issue #147 references H100-class deployment and a 20-50% cost reduction claim from a Telegram post. The pinned model cards, harness, and T-Bank technical report reviewed here do not substantiate those two claims, so they are treated as unverified and are not used in the decision.

## Privacy, Freshness, and Storage

The model endpoint receives the user question and every snippet returned by the search backend. The harness stores snippets in tool messages and exposes `messages` plus `all_round_messages`; `RetrievalResult.to_dict()` serializes the transcript. Therefore:

- raw harness results, snippets, messages, tool calls, round summaries, and transcripts must not be persisted in OpenSpec, `.ai-factory/`, generated rules, QA evidence, docs, recommender metadata, or logs;
- model endpoints and search services must remain user-owned and explicitly approved for the source classification involved;
- a future adapter may retain only bounded, reviewed, project-relative chunk/file pointers with provenance, never raw excerpts or hidden reasoning;
- direct source files remain authoritative, and stale or missing pointers must degrade to normal `rg` inspection;
- AIFHub cannot claim freshness or deletion until the external index defines exact roots, exclusions, incremental refresh behavior, revision identity, and a verified purge procedure.

## AIFHub Boundary

AIFHub must not:

- clone or install the source-only harness;
- download any T-Search weights or start vLLM, SGLang, llama.cpp, containers, endpoints, or background processes;
- create or mutate a corpus, embedding model, index, vector store, BM25 service, search API, MCP configuration, credentials, or provider settings;
- probe T-Search availability, select it from project configuration, or make it a command prerequisite;
- send repository content to a model endpoint or persist raw provider output/transcripts.

The recommender enforces this with explicit command-level `forbidden` entries, `tool_permissions.t-search.default: forbidden`, no availability probe, and a source denylist that cannot be relaxed by mutable metadata alone.

## Re-evaluation Gate

Promotion requires all of the following in a separate, explicitly authorized evaluation:

1. A bounded user-owned repository corpus and search backend with project-root confinement, symlink/path-escape protection, explicit secret/vendor/build exclusions, and deterministic chunk IDs.
2. Verified index build, revision identity, incremental refresh, stale-entry behavior, and complete purge.
3. A same-run paired benchmark against `rg` on mixed Russian/English source, Markdown, and OpenSpec tasks, with fixed answers and source citations.
4. Correctness, Recall@10, privacy-canary, wall-time, total-token, endpoint-cost, index-build, refresh, and output-noise measurements.
5. A stable packaged harness or reviewed MCP/service contract whose transcript and failure behavior can be bounded without patching upstream.
6. Direct-source verification of every selected pointer and zero persistence of raw snippets or transcripts.

Static and author-reported evidence is recorded in [T-Search Benchmark Results](t-search-benchmark-results.md).

## Meta for Analysis

```yaml
tool: t-search
decision: reject_defer
recommendation_action: do_not_suggest_install
integration_role: user_owned_agentic_retriever_candidate
normal_command_selection: forbidden
source_denylist: true
paired_aifhub_benchmark: NOT_RUN
```
