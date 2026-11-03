[Back to Documentation](README.md) | [Next: OpenSpec Compatibility](openspec-compatibility.md)

# Docs Readability Policy

Opt-in, non-blocking readability diagnostics for technical documents bound to an OpenSpec change (issue #228). The command is a manual neighbor of the existing checks: it never changes evidence and never authorizes progression.

## Command

```text
ai-factory aifhub-docs-readability --change <id> [--enabled true|false] --file <path> [--file <path> ...] [--language ru|en] [--json] [--write]
```

- Opt-in: the function is off by default. Enable per run with `--enabled true|false`, or persist `aifhub.readability.enabled: true` under `aifhub:` in `.ai-factory/config.yaml`. Precedence: CLI override > config key > `false`. A run without any opt-in refuses with exit 2 and performs no project reads or writes beyond the bounded config read that evaluates the switch itself.
- Preview by default: the result is rendered (human text or `--json`) without writing anything. The report is written only by explicit `--write`.
- Document selection v1 is an explicit, repeatable `--file <path>` list of project-relative POSIX paths. An empty list is the typed `empty-input` outcome (exit 2); there is no repository scan. Path forms that fail the bounded reader (`\`, `:`, `.`/`..` segments, control characters, absolute paths) are rejected before any read.
- `--language ru|en` overrides the analysis language. Detection still runs over eligible prose; a confident contradiction reports `wrong-language`, an uncertain detection reports `ambiguous-language`.
- Unknown or repeated options are invalid invocations (exit 2). Exit 0 means an advisory result was formed (including findings and explicit degradations); exit 1 means an operational failure (writer guards, IO, refused custom state root). No exit code participates in verify/done/archive chains.

## Report

- Schema `aifhub.docs_readability.v1` (`schemas/docs-readability.schema.json`, draft 2020-12 subset, `additionalProperties: false`), written only by `--write` to `.ai-factory/state/<change-id>/readability/report.json`.
- Findings are source-bound: canonical spans are UTF-8 byte offsets `[start, end)` from the raw file bytes with derived 1-based line/column, plus the sha256 of the raw bytes. Source documents are never edited.
- State is a closed enum: `complete | partial-coverage | checker-unavailable | empty-input | wrong-language | ambiguous-language | malformed-input | timeout`. A degradation is never rendered as a zero-findings result; `stale-report` is a read-time revalidation outcome, not a stored state.
- The writer is state-only and guarded: containment under `.ai-factory/state`, no control-namespace or QA collisions, no file-shadow ancestors, leaf ownership (only a previous report of the same change may be replaced), gitignored semantics and no tracking, all verified before the first write. A custom `paths.state` that resolves outside `.ai-factory/state` is refused (`state-root-mismatch`, exit 1) because the QA projection covers only the default state root.

## Profile and rules

- One pinned offline profile `scripts/docs-readability.profile.json` (`profile_id`, `profile_version`, per-rule `id`/`version`/`origin`): sentence length with per-section thresholds, closed RU/EN cliche lists (exact matching, findings marked `heuristic: true`), unbalanced `()`/`[]`/`«»` pairs, unsupported quotation marks, and terminology suggestions only from recognized glossary entries. Thresholds and lists are recorded in the change design; they are not a language standard.
- Markdown parsing is position-preserving over raw bytes: fenced code, inline code, link targets, autolinks, HTML tags, front matter, and command/log lines are excluded from eligible prose and never rewritten. Unsupported parsing degrades the outcome to `partial-coverage` with uncovered spans in `diagnostics`.
- Suggestions are conservative: only mechanically derivable facts (unbalanced pairs, glossary preferred forms). No rule proposes a rewrite of modal prose (MUST/SHOULD/MAY), negations, values, or references.

## Language

The document language is resolved independently of the UI language policy: CLI override first, then a deterministic Cyrillic/Latin share estimate over eligible prose. The resolved language is a diagnostic fact about the analyzed document bound to its `source_sha256`; it is never persisted to config, rules, memory, or QA evidence, and `language.ui` resolution is untouched.

## Glossary

The project glossary (`paths.context`, default `CONTEXT.md`) is a read-only, best-effort terminology input. The report records only its path, state (`present | missing | empty | unreadable | unsafe`), and sha256 as advisory invalidation metadata; the glossary body is never copied into reports or diagnostics, and `/aif-analyze` remains the only writer.

## Isolation

- The diagnostics are advisory: they are not part of done-readiness `CHECKS`, `SUPPORTED_GATES`/`SUPPORTED_STATUSES`, provider policy, runner metrics, or the finalizer, and no `aif-gate-result` is produced. Findings do not change correctness verdicts, complete tasks, or assign hypothesis outcomes (including future ClaimEvidenceCheck/hypothesis contracts).
- The report directory is a closed runtime namespace in the QA snapshot projection (both observation points), so writing, overwriting, or deleting a report between enrollment and binding checks cannot drift `ignored_names`/`changed_paths`.
- Untrusted document text is data, never commands: the analysis path contains no process/network API, URLs are not opened, and nothing named in a document is executed. The single sanctioned git touchpoint is the fixed-path writer guard, which only receives validated repository-relative paths.
- Provenance: `scripts/docs-readability.mjs` and the profile are intentionally not part of `HELPER_MODULES` and carry no release attestation; `npm run provenance:check` stays green.

## See Also

- [Documentation Index](README.md)
- [Context Loading Policy](context-loading-policy.md)
- [Project Review Policy](review-policy.md)
