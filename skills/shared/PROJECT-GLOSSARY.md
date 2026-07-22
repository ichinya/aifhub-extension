# Shared Project Glossary Policy

Apply this policy after `.ai-factory/config.yaml` and `skills/shared/LANGUAGE-POLICY.md` have been resolved. The project glossary is optional terminology context, not a canonical project artifact or completion prerequisite.

## Resolution And Loading

1. Read the non-empty `paths.context` value from `.ai-factory/config.yaml`; if the key is absent or empty, use `CONTEXT.md`.
2. Accept only a normalized project-relative file path that remains inside the project root. Treat absolute paths, URI-like values, escaping paths, and directory targets as `unsafe`; never read them.
3. Classify the result without exposing file contents:
   - `present`: the file is readable and non-empty; load it best-effort.
   - `missing`: the file does not exist; continue normally without a diagnostic.
   - `empty`: the file has no substantive content; continue normally without glossary context.
   - `unreadable`: the safe file cannot be read; continue and emit one bounded diagnostic with the project-relative path and reason.
   - `unsafe`: path validation failed; continue and emit one bounded diagnostic with the reason, without printing an external absolute path.
4. Never copy the glossary body into logs, runtime traces, QA evidence, reports, or diagnostics.

## Ownership

- `/aif-analyze` is the only AIFHub command allowed to create or update the glossary, and only under its explicit opt-in lifecycle contract.
- All other AIFHub skills, injections, and packaged agents are read-only consumers. They must not create, patch, format, move, or delete the glossary.
- A consumer may report a candidate term in an artifact it already owns and recommend `/aif-analyze` for a durable glossary update.

## Lexical Scope

- Apply preferred glossary terms only to human-readable prose: explanations, summaries, headings, labels, and generated documentation.
- Preserve code and API identifiers exactly, including commands, filenames, paths, JSON/YAML keys, schema fields, package names, exported symbols, and public wire values.
- Do not use the glossary to infer behavior, requirements, permissions, architecture, task status, or acceptance criteria.

## Authority And Precedence

Resolve material conflicts in this order:

1. source code, public APIs, schemas, and executable tests, together with verifiable QA facts;
2. canonical OpenSpec specs and active change requirements;
3. project rules and accepted architecture decisions;
4. `DESCRIPTION.md` and `ARCHITECTURE.md` as descriptive context;
5. the glossary as preferred lexical context.

When glossary terminology disagrees with a higher-authority source, follow that source, preserve its identifiers, and emit at most one concise terminology-drift warning. Do not automatically edit either side of the conflict.

## Protected Artifact Boundary

- Do not add glossary contents to canonical OpenSpec artifacts unless the user explicitly authors the term as part of the requirement being changed.
- Do not use the glossary in generated-rule inputs, source fingerprints, QA schemas or evidence, runtime traces, provider stores, status checks, doctor checks, verification gates, or done-readiness decisions.
- Do not recursively load files referenced by the glossary and do not import source, OpenSpec, provider output, or runtime state into it.

## Deferred Knowledge Formats

OKF is deferred. Introducing Open Knowledge Format parsing, schemas, conformance, or knowledge-store infrastructure requires a separate evidence-backed OpenSpec change and architecture decision.
