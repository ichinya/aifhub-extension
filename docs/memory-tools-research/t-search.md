# T-Search: Optional Agentic Retrieval Evaluation

## Decision

`t-search` is `reject_defer`. AIFHub must not recommend, install, download, probe, configure, index for, or execute T-Search in normal workflows. The candidate is not a drop-in retrieval provider: it is an agentic query planner and ranker that requires both a separately served model and a user-owned search backend over a user-owned corpus.

The upstream results are promising on fixed web-search benchmarks. An authorized reduced-profile local pilot improved Recall@10 on a synthetic AIFHub-like mixed corpus, but it regressed aggregate false-positive rate and added substantial latency/token overhead. A later context sweep on an authorized real Laravel committed-snapshot sample completed only 1/6 candidate rows at 8K context, then 6/6 at 16K with higher aggregate recall and lower false-positive rate. The 16K gain was not uniform, the ready-server candidate remained about 970.5x slower than direct `rg`, model startup took roughly two to six minutes across observed launches, and no external index lifecycle was exercised. The official [T-Bank technical report](https://habr.com/ru/companies/tbank/articles/1060262/) likewise recommends validation on the consumer's own index. No `docs/retrieval-providers.md` integration guide is added because the overall integration gate was not met.

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
| llama.cpp | The GGUF card publishes an OpenAI-compatible `llama-server` setup and pins build `b10068` / commit [`571d0d540df04f25298d0e159e520d9fc62ed121`](https://github.com/ggml-org/llama.cpp/commit/571d0d540df04f25298d0e159e520d9fc62ed121). | Exact pinned build executed with Q4_K_M, 8,192 and 16,384 context, one slot, MTP speculative decoding, and automatic hybrid CPU/GPU offload. |
| vLLM | The harness example points at a vLLM-style `/v1` endpoint, and current [vLLM documentation](https://docs.vllm.ai/en/stable/serving/openai_compatible_server.html) supports OpenAI-compatible chat completions, reasoning parsing, and tool calling. The exact T-Search checkpoint/runtime combination is not validated by this evaluation. | Interface-compatible in principle; `NOT_RUN`. |
| Hosted Hugging Face inference | None of the four observed model pages listed a deployed Hugging Face Inference Provider. | Not available at observation time. |

The smallest official checkpoint is the 21.71 GB Q4_K_M GGUF. Its exact 21,713,463,136-byte file (SHA-256 `f645dce898117a1f9165dfbb014d61e5f09daec06bb64f4b91de7f103b8761bb`) exceeded the local RTX 4060 Ti's VRAM, but `llama.cpp --fit` successfully used hybrid offload with 64 GB system RAM. Observed process-to-readiness times were about 117 seconds with a warm OS file cache, 152 seconds in the first live run, and 362 seconds on a later cold-ish launch; GPU memory reached approximately 15,820 MiB. This proves reduced-profile feasibility, not a practical default deployment.

## Runtime and Cost Surface

The harness defaults are a ceiling of five rounds, 32K tokens per round, 16,384 generated tokens per assistant turn, 60 turns per round, five searches before a round may be saved, and a 600-second model request timeout. Actual sessions can finish earlier, but this is a materially larger and more variable runtime surface than direct `rg` retrieval. Startup must be measured separately from ready-server retrieval: the 16K real-project pass took 498.844 seconds of candidate row time, 532.792 seconds for the whole benchmark command, and 649.661 seconds end to end when combined with its 116.869-second warm-cache server start.

Issue #147 references H100-class deployment and a 20-50% cost reduction claim from a Telegram post. The pinned model cards, harness, and T-Bank technical report reviewed here do not substantiate those two claims, so they are treated as unverified and are not used in the decision.

## Authorized Local Pilot Contract

The follow-up evaluation authorized on 2026-09-01 uses an explicit, non-promotable runner rather than changing the normal AIFHub boundary. [`t-search-ab-scenarios.json`](t-search-ab-scenarios.json) pins the Q4_K_M file identity, official harness revision, `llama.cpp` build, six answer-independent Russian/English questions, and the `local_gguf_q4_reduced_context` profile. The synthetic fixture contains mixed TypeScript, Markdown, and OpenSpec content with 23 eligible files and 30 deterministic marked chunks.

The two variants receive the same question and corpus:

- `baseline_rg` performs one bounded `rg --json` lookup;
- `candidate_t_search` runs the exact pinned harness against a loopback-only OpenAI-compatible endpoint and injects the same bounded `rg` corpus search as its search tool.

This isolates the value of agentic query planning and ranking. It does not claim that `rg` is a semantic index, and it does not test a production vector/BM25 lifecycle. The reduced profile uses one round, an 8,192-token server context and per-round budget, 2,048 maximum generated tokens per turn, 20 turns, `top_k=10`, and the model card's `temperature=0.7` / `top_p=1.0`. It is intentionally different from the upstream 65,536-context, up-to-five-round profile.

The runner is explicit opt-in only. It does not download weights, install the harness, or start a model server. An authorized evaluator supplies the pinned harness root and loopback `/v1` endpoint:

```bash
node scripts/t-search-ab-benchmark.mjs --dry-run --json
node scripts/t-search-ab-benchmark.mjs --baseline-only --json
node scripts/t-search-ab-benchmark.mjs \
  --harness-root /user-owned/pinned/t-search-harness \
  --model-file /user-owned/T-Search-Q4_K_M.gguf \
  --endpoint http://127.0.0.1:18000/v1 \
  --server-startup-ms "$MODEL_STARTUP_MS" \
  --out /os-temp/t-search-ab-result \
  --json
```

`--server-startup-ms` is an optional evaluator-measured process-start-to-readiness duration. The sanitized summary keeps it separate as `server_startup_ms`, records the whole command as `benchmark_elapsed_ms`, and reports their sum as `end_to_end_elapsed_ms`; `candidate_total_elapsed_ms` remains ready-server row time.

Safety is part of the result, not a post-hoc note. The runner rejects a GGUF filename/size/SHA mismatch, repository-local weights, non-loopback endpoints, harness digest drift, model-alias mismatch, corpus symlinks/path escapes, excluded secret/QA/state/vendor/build paths, unknown chunk IDs, raw snippets/messages/transcripts, absolute paths, protected output directories, corpus changes during a row, or any persistent search state. Raw in-memory harness state is scanned for synthetic privacy canaries and discarded; durable output contains only aggregate metrics and project-relative chunk IDs. A privacy, source-boundary, freshness, or purge failure vetoes retrieval quality. The overall policy remains `reject_defer` regardless of the pilot score.

### Pilot result

The 2026-09-01 run completed all six pairs and all safety/provenance gates. Aggregate Recall@10 improved from `0.666667` to `1.0`, precision among returned results improved from `0.466667` to `0.504762`, and reciprocal rank improved from `0.75` to `1.0`. However, false-positive rate worsened from `0.44` to `0.495238`. T-Search used 85 search calls, 206,212 model tokens, and 449.815 seconds of measured row time; the six direct `rg` rows took 0.569 seconds. The strict quality rule therefore records `pilot_negative`, while the permanent policy remains `reject_defer`.

The local endpoint had no provider charge; electricity was not priced. The stateless `rg` search backend had no index build or refresh cost, so the passed freshness/purge checks cover only the bounded pilot adapter and temporary sandboxes. They do not prove a production vector/BM25 index lifecycle. Full per-scenario metrics are in [T-Search Benchmark Results](t-search-benchmark-results.md#authorized-live-result-2026-09-01).

### Real Laravel snapshot context sweep

On 2026-09-02, the runner used a deterministic 218-file, 614-chunk sample from an authorized committed Laravel 13 snapshot, with six fixed English/Russian tasks. PHP and Vue are now explicit corpus formats; Laravel runtime/generated locations such as `storage/**` and `bootstrap/cache/**` remain excluded alongside secrets, dependencies, QA/state, and generated rules. Project identity, revision, source, scenario details, queries, paths, fingerprint, and raw output are not committed.

All six `rg` rows completed with average Recall@10 `0.25`. At 8,192 server context, T-Search completed only one row; the others ended with four `termination_llm_error` results and one `termination_free_text_loop`, while the server logged six context truncations. Candidate attempts consumed 154,357 tokens, 30 searches, and 495.151 seconds versus 0.663 seconds for all baseline rows. This pass is `incomplete`.

Increasing only the server context to 16,384 tokens, while retaining one slot and the 8,192-token harness budget, eliminated truncations and server parse errors. All 6/6 rows completed. Aggregate Recall@10 improved from `0.25` to `0.541667`, precision from `0.083333` to `0.183333`, false-positive rate from `0.916667` to `0.816667`, and reciprocal rank from `0.144444` to `0.833333`. One scenario regressed in recall and another had no gain, so improvement was not uniform. The largest actual slot usage was 10,892 tokens, leaving about 5.5K tokens of headroom; this workload does not justify 32K context.

The 16K pass consumed 153,472 tokens, 26 searches, and 498.844 seconds of candidate row time versus 0.514 seconds for baseline, about 970.5x slower with an already-ready server. The model took 116.869 seconds to become ready with a warm OS file cache; the complete command took 532.792 seconds, making the observed one-shot total 649.661 seconds. Combining the command with the earlier 361.8-second cold-ish launch gives a non-contiguous estimate of 894.592 seconds. Privacy, source boundary, freshness, purge, harness provenance, model identity, unchanged-corpus, and zero-persistent-state gates passed in both passes. The 16K aggregate is `pilot_positive`, but `no_promote: true`, the latency, scenario variance, and missing external-index lifecycle keep the permanent decision `reject_defer`. Aggregate-only evidence is in [T-Search Benchmark Results](t-search-benchmark-results.md#authorized-real-laravel-snapshot-context-sweep-2026-09-02).

## Privacy, Freshness, and Storage

The model endpoint receives the user question and every snippet returned by the search backend. The harness stores snippets in tool messages and exposes `messages` plus `all_round_messages`; `RetrievalResult.to_dict()` serializes the transcript. Therefore:

- raw harness results, snippets, messages, tool calls, round summaries, and transcripts must not be persisted in OpenSpec, `.ai-factory/`, generated rules, QA evidence, docs, recommender metadata, or logs;
- model endpoints and search services must remain user-owned and explicitly approved for the source classification involved;
- a future adapter may retain only bounded, reviewed, project-relative chunk/file pointers with provenance, never raw excerpts or hidden reasoning;
- direct source files remain authoritative, and stale or missing pointers must degrade to normal `rg` inspection;
- AIFHub cannot claim freshness or deletion until the external index defines exact roots, exclusions, incremental refresh behavior, revision identity, and a verified purge procedure.

## AIFHub Boundary

Outside a separate explicit evaluation such as the pilot above, AIFHub must not:

- clone or install the source-only harness;
- download any T-Search weights or start vLLM, SGLang, llama.cpp, containers, endpoints, or background processes;
- create or mutate a corpus, embedding model, index, vector store, BM25 service, search API, MCP configuration, credentials, or provider settings;
- probe T-Search availability, select it from project configuration, or make it a command prerequisite;
- send repository content to a model endpoint or persist raw provider output/transcripts.

The recommender enforces this with explicit command-level `forbidden` entries, `tool_permissions.t-search.default: forbidden`, no availability probe, and a source denylist that cannot be relaxed by mutable metadata alone.

## Re-evaluation Gate

The synthetic pilot satisfied the bounded mixed-language runner and local stateless safety gates, but did not satisfy promotion. The real Laravel context sweep showed that 16K is sufficient for these six scenarios and produced a positive aggregate, but it also exposed large startup/row latency, a per-scenario regression, and the same stateless search adapter rather than an external index lifecycle. Promotion still requires all of the following in a separate, explicitly authorized evaluation:

1. A bounded real user-owned repository corpus and production-representative search backend with project-root confinement, symlink/path-escape protection, explicit secret/vendor/build exclusions, redaction, and deterministic chunk IDs.
2. Verified index build, revision identity, incremental refresh, stale-entry behavior, and complete purge.
3. A same-run paired benchmark against `rg` on mixed Russian/English real-repository source, Markdown, and OpenSpec tasks, with fixed answers and source citations.
4. Correctness, Recall@10, false-positive-rate, privacy-canary, startup, ready-server row, whole-command and end-to-end wall-time, total-token, endpoint-cost, index-build, refresh, and output-noise measurements that improve the observed quality/cost tradeoff.
5. A stable packaged harness or reviewed MCP/service contract whose transcript and failure behavior can be bounded without patching upstream.
6. Direct-source verification of every selected pointer and zero persistence of raw snippets or transcripts.

Static, author-reported, and authorized local pilot evidence is recorded in [T-Search Benchmark Results](t-search-benchmark-results.md).

## Meta for Analysis

```yaml
tool: t-search
decision: reject_defer
recommendation_action: do_not_suggest_install
integration_role: user_owned_agentic_retriever_candidate
normal_command_selection: forbidden
source_denylist: true
paired_aifhub_benchmark: LOCAL_SYNTHETIC_PILOT_NEGATIVE_AND_REAL_LARAVEL_16K_PILOT_POSITIVE_NO_PROMOTE
live_model_run: PASS_REDUCED_16384_CONTEXT
external_index_lifecycle: NOT_RUN
```
