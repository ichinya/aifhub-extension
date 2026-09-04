<!-- chunk: c010 -->
# Provider transcript boundary

Raw retrieval snippets, model messages, hidden reasoning, tool transcripts and round summaries must never be persisted in OpenSpec, QA evidence, generated rules, logs or recommendation metadata.

<!-- chunk: c011 -->
## Durable pointer allowance

Only bounded reviewed project-relative chunk or file pointers with source revision provenance may survive the run. Every claim must be checked against the direct current source file.
